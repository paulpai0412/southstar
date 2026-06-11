import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import { normalizeRuntimePath } from "../adapters/platform/paths.ts";
import { isPlanningCommand } from "../cli/planning-command.ts";
import { createProductionOrchestratorFromDefaultFactory } from "../orchestrator/production-factory.ts";
import { SqliteControlPlaneStore } from "../runtime/store.ts";
import type { LifecycleState } from "../types/control-plane.ts";
import type {
  NorthstarBoard,
  NorthstarIssueDetail,
  NorthstarProjectSummary,
  NorthstarRunEvent,
  NorthstarWizardState,
  OperatorActionName,
  OperatorActionRequest,
  OperatorActionResponse,
  ResumeTargetLifecycle,
  WizardActionRequest,
  WizardActionResponse,
} from "./models.ts";
import { defaultNorthstarProjectCapabilities } from "./models.ts";
import { buildNorthstarBoard, buildNorthstarIssueDetail, runEventForHistory } from "./read-model.ts";
import { buildInitialWizardState, reduceWizardAction } from "./wizard.ts";

export type NorthstarLocalProjectSummary = NorthstarProjectSummary & {
  id: string;
};

export interface NorthstarLocalApi {
  getProject(): NorthstarLocalProjectSummary;
  getBoard(): NorthstarBoard;
  getIssue(issueId: string): NorthstarIssueDetail;
  listIssueEvents(issueId: string): NorthstarRunEvent[];
  getWizard(): NorthstarWizardState;
  runWizardAction(request: WizardActionRequest): WizardActionResponse;
  runIssueAction(request: OperatorActionRequest): Promise<OperatorActionResponse>;
}

const allowedOperatorActions = new Set<OperatorActionName>([
  "intake",
  "start",
  "reconcile",
  "repair-runtime",
  "release",
  "retry-sync",
  "resume",
  "inspect",
]);

const activeLifecycleStates = new Set<LifecycleState>(["claimed", "running", "verifying", "releasing"]);

export function createNorthstarLocalApi(input: { configPath: string; now?: () => string }): NorthstarLocalApi {
  const now = input.now ?? (() => new Date().toISOString());

  function readConfig(): RuntimeConfig {
    return loadConfig(input.configPath);
  }

  function getProject(): NorthstarLocalProjectSummary {
    return projectSummaryForConfig(readConfig(), input.configPath);
  }

  function getBoard(): NorthstarBoard {
    const config = readConfig();
    return readWithStore(config, (store) => {
      const issues = store.listIssues();
      return buildNorthstarBoard({
        project: projectSummaryForConfig(config, input.configPath),
        issues,
        historiesByIssueId: store.listHistoriesByIssueId(issues.map((issue) => issue.issue_id)),
        now: now(),
      });
    });
  }

  function getIssue(issueId: string): NorthstarIssueDetail {
    const config = readConfig();
    return readWithStore(config, (store) => issueDetailFromStore(config, store, issueId, input.configPath, now()));
  }

  function listIssueEvents(issueId: string): NorthstarRunEvent[] {
    const config = readConfig();
    return readWithStore(config, (store) => store.listHistory(issueId).map(runEventForHistory));
  }

  function getWizard(): NorthstarWizardState {
    const config = readConfig();
    return readWithStore(config, (store) => {
      const issues = store.listIssues();
      const board = buildNorthstarBoard({
        project: projectSummaryForConfig(config, input.configPath),
        issues,
        historiesByIssueId: store.listHistoriesByIssueId(issues.map((issue) => issue.issue_id)),
        now: now(),
      });
      const cards = board.groups.flatMap((group) => group.cards);

      return buildInitialWizardState({
        projectId: board.project.projectId,
        configPath: input.configPath,
        hasConfig: true,
        hostAdapter: config.runtime.hostAdapter,
        issueCount: cards.length,
        activeIssueCount: cards.filter((card) => activeLifecycleStates.has(card.lifecycle)).length,
        hasRetryableFailures: cards.some((card) => card.nextRecommendedAction === "retry-sync" || card.projectionFailure),
        planIssuesCliAvailable: isPlanningCommand("plan-issues"),
      });
    });
  }

  function runWizardAction(request: WizardActionRequest): WizardActionResponse {
    return {
      state: reduceWizardAction(getWizard(), request),
    };
  }

  async function runIssueAction(request: OperatorActionRequest): Promise<OperatorActionResponse> {
    const action = validateOperatorAction(request);
    const config = readConfig();
    const store = openStore(config);

    try {
      const built = await createProductionOrchestratorFromDefaultFactory({
        config,
        store,
        now,
        usage: "cli",
      });
      const result = await runAllowedIssueAction(built.orchestrator, action, request, config.runtime.autoRelease);
      const board = boardFromStore(config, store, input.configPath, now());
      const updatedIssue = issueDetailFromStore(config, store, request.issueId, input.configPath, now());

      return {
        action,
        result,
        updatedIssue,
        nextRecommendedAction: board.groups
          .flatMap((group) => group.cards)
          .find((card) => card.issueId === request.issueId)?.nextRecommendedAction ?? null,
      };
    } finally {
      store.close();
    }
  }

  return {
    getProject,
    getBoard,
    getIssue,
    listIssueEvents,
    getWizard,
    runWizardAction,
    runIssueAction,
  };
}

function validateOperatorAction(request: OperatorActionRequest): Exclude<OperatorActionName, "intake"> {
  const action = request.action as string;
  if (!allowedOperatorActions.has(action as OperatorActionName)) {
    throw new Error(`NORTHSTAR_OPERATOR_ACTION_NOT_ALLOWED: ${action}`);
  }
  if (action === "release" && request.confirmed !== true) {
    throw new Error("NORTHSTAR_OPERATOR_ACTION_REQUIRES_CONFIRMATION: release");
  }
  if (action === "resume" && (!request.reason || request.reason.trim().length === 0)) {
    throw new Error("NORTHSTAR_OPERATOR_ACTION_REQUIRES_REASON: resume");
  }
  if (action === "resume" && request.targetLifecycle !== undefined && !isResumeTargetLifecycle(request.targetLifecycle)) {
    throw new Error("NORTHSTAR_OPERATOR_ACTION_INVALID_TARGET: resume");
  }
  if (action === "intake") {
    throw new Error("NORTHSTAR_OPERATOR_INTAKE_REQUIRES_GITHUB_ISSUE_PAYLOAD");
  }
  return action as Exclude<OperatorActionName, "intake">;
}

async function runAllowedIssueAction(
  orchestrator: {
    startIssue(input: { issueId: string }): Promise<unknown>;
    reconcileIssue(input: { issueId: string }): Promise<unknown>;
    releaseIssue(input: { issueId: string; autoRelease: boolean }): Promise<unknown>;
    repairRuntime(input: { issueId?: string }): Promise<unknown>;
    retrySyncIssue(input: { issueId: string }): Promise<unknown>;
    resumeIssue(input: { issueId: string; reason: string; targetLifecycle: ResumeTargetLifecycle }): Promise<unknown>;
    inspectIssue(input: { issueId: string }): unknown;
  },
  action: Exclude<OperatorActionName, "intake">,
  request: Pick<OperatorActionRequest, "issueId" | "reason" | "targetLifecycle">,
  autoRelease: boolean,
): Promise<unknown> {
  if (action === "start") {
    return await orchestrator.startIssue({ issueId: request.issueId });
  }
  if (action === "reconcile") {
    return await orchestrator.reconcileIssue({ issueId: request.issueId });
  }
  if (action === "release") {
    return await orchestrator.releaseIssue({ issueId: request.issueId, autoRelease });
  }
  if (action === "repair-runtime") {
    return await orchestrator.repairRuntime({ issueId: request.issueId });
  }
  if (action === "retry-sync") {
    return await orchestrator.retrySyncIssue({ issueId: request.issueId });
  }
  if (action === "resume") {
    return await orchestrator.resumeIssue({
      issueId: request.issueId,
      reason: request.reason ?? "operator resume",
      targetLifecycle: request.targetLifecycle ?? "ready",
    });
  }
  return orchestrator.inspectIssue({ issueId: request.issueId });
}

function isResumeTargetLifecycle(value: string): value is ResumeTargetLifecycle {
  return value === "ready" || value === "running";
}

function readWithStore<T>(config: RuntimeConfig, read: (store: SqliteControlPlaneStore) => T): T {
  const store = openStore(config);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

function openStore(config: RuntimeConfig): SqliteControlPlaneStore {
  return SqliteControlPlaneStore.open(normalizeRuntimePath(config.project.root, config.runtime.dbPath));
}

function boardFromStore(
  config: RuntimeConfig,
  store: SqliteControlPlaneStore,
  configPath: string,
  now: string,
): NorthstarBoard {
  const issues = store.listIssues();
  return buildNorthstarBoard({
    project: projectSummaryForConfig(config, configPath),
    issues,
    historiesByIssueId: store.listHistoriesByIssueId(issues.map((issue) => issue.issue_id)),
    now,
  });
}

function issueDetailFromStore(
  config: RuntimeConfig,
  store: SqliteControlPlaneStore,
  issueId: string,
  configPath: string,
  now: string,
): NorthstarIssueDetail {
  return buildNorthstarIssueDetail({
    project: projectSummaryForConfig(config, configPath),
    snapshot: store.getIssue(issueId),
    history: store.listHistory(issueId),
    now,
  });
}

function projectSummaryForConfig(config: RuntimeConfig, configPath: string): NorthstarLocalProjectSummary {
  const projectId = config.github.project?.projectId ?? config.project.name;
  return {
    id: projectId,
    projectId,
    name: config.project.name,
    root: config.project.root,
    repo: config.github.repo,
    hostAdapter: config.runtime.hostAdapter,
    configPath,
    runtimeDbPath: normalizeRuntimePath(config.project.root, config.runtime.dbPath),
    capabilities: defaultNorthstarProjectCapabilities,
  };
}

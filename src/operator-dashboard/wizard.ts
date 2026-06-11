import type { HostAdapterName } from "../config/schema.ts";
import {
  northstarWizardPhases,
  type NorthstarCommandPlan,
  type NorthstarConfirmationGate,
  type NorthstarWizardPhase,
  type NorthstarWizardPhaseState,
  type NorthstarWizardState,
  type WizardActionRequest,
} from "./models.ts";

export interface WizardContext {
  projectId: string;
  configPath: string;
  hasConfig: boolean;
  hostAdapter: HostAdapterName;
  issueCount: number;
  activeIssueCount: number;
  hasRetryableFailures: boolean;
  planIssuesCliAvailable: boolean;
}

export interface GenerateWizardCommandPlanInput {
  phase: NorthstarWizardPhase;
  configPath: string;
  hostAdapter: HostAdapterName;
  issueId?: string;
  options?: Record<string, unknown>;
}

export function buildInitialWizardState(context: WizardContext): NorthstarWizardState {
  return {
    projectId: context.projectId,
    currentPhase: "plan",
    phases: northstarWizardPhases.map((phase) => buildPhaseState(phase, phaseStatusForContext(phase, context))),
    selectedOptions: {
      hostAdapter: context.hostAdapter,
      planIssuesCliAvailable: context.planIssuesCliAvailable,
      configPath: context.configPath,
    },
    commandPlans: [],
    confirmationGates: [],
    evidence: [],
    nextRecommendedAction: nextRecommendation(context),
  };
}

export function generateWizardCommandPlan(input: GenerateWizardCommandPlanInput): NorthstarCommandPlan {
  const mode = stringOption(input.options, "mode") ?? defaultModeForPhase(input.phase);
  const planId = commandPlanIdForInput(input, mode);

  if (input.phase === "setup") {
    return {
      id: planId,
      phase: "setup",
      description: "Run Northstar setup doctor and review config, GitHub label, and Project viewer plans.",
      argv: ["node", "skills/northstar/scripts/doctor.mjs", "--config", input.configPath],
      expectedEffects: [
        "Read local platform, git, GitHub, credential, CLI, and SDK availability.",
        "No config, GitHub label, or GitHub Project mutation occurs without a separate confirmation gate.",
        `Host adapter choices remain codex, opencode, and pi; selected default is ${String(input.options?.selectedHostAdapter ?? input.hostAdapter)}.`,
      ],
      risk: "medium",
      requiresConfirmation: true,
    };
  }

  if (input.phase === "execute") {
    if (mode === "watch") {
      return {
        id: planId,
        phase: "execute",
        description: "Start Northstar watch mode for ready issues.",
        argv: ["node", "--run", "northstar", "--", "watch", "--config", input.configPath, "--max-cycles", "1", "--log-json"],
        expectedEffects: [`Dispatch ready issues through the configured host adapter ${input.hostAdapter}.`],
        risk: "medium",
        requiresConfirmation: true,
      };
    }

    const issueNumber = issueNumberFromIssueId(input.issueId);
    return {
      id: planId,
      phase: "execute",
      description: "Start a Northstar worker for one GitHub issue.",
      argv: ["node", "--run", "northstar", "--", "start", "--config", input.configPath, "--issue", issueNumber],
      expectedEffects: [`Dispatch one Northstar worker through the configured host adapter ${input.hostAdapter}.`],
      risk: "medium",
      requiresConfirmation: true,
    };
  }

  if (input.phase === "monitor" || input.phase === "report") {
    return {
      id: planId,
      phase: input.phase,
      description: input.phase === "monitor" ? "Inspect Northstar runtime summary." : "Generate a Northstar report summary.",
      argv: ["node", "--run", "northstar", "--", "inspect", "--config", input.configPath, "--summary"],
      expectedEffects: ["Read Northstar runtime state without mutating issues, worktrees, or sessions."],
      risk: "low",
      requiresConfirmation: false,
    };
  }

  if (input.phase === "recovery") {
    return {
      id: planId,
      phase: "recovery",
      description: "Repair retryable Northstar runtime failures.",
      argv: ["node", "--run", "northstar", "--", "repair-runtime", "--config", input.configPath],
      expectedEffects: ["Attempt runtime repair for retryable failures and record recovery evidence."],
      risk: "high",
      requiresConfirmation: true,
    };
  }

  return generatePlanPhaseCommandPlan(input, mode, planId);
}

export function reduceWizardAction(state: NorthstarWizardState, request: WizardActionRequest): NorthstarWizardState {
  if (request.action === "select_phase") {
    return {
      ...state,
      currentPhase: request.phase ?? state.currentPhase,
    };
  }

  if (request.action === "approve_gate" || request.action === "reject_gate") {
    const status = request.action === "approve_gate" ? "approved" : "rejected";
    return {
      ...state,
      confirmationGates: state.confirmationGates.map((gate) => {
        if (gate.id !== request.gateId) {
          return gate;
        }
        return { ...gate, status };
      }),
    };
  }

  if (request.action !== "generate_command_plan") {
    return state;
  }

  const phase = request.phase ?? state.currentPhase;
  const mode = stringOption(request.options, "mode") ?? defaultModeForPhase(phase);
  if (phase === "execute" && mode !== "watch" && stringOption({ issueId: request.issueId }, "issueId") === undefined) {
    return {
      ...state,
      currentPhase: phase,
      phases: updatePhaseBlockedWithBlocker(state.phases, phase, "GitHub issue id is required before generating an execute command plan."),
    };
  }

  const plan = generateWizardCommandPlan({
    phase,
    configPath: selectedString(state, "configPath"),
    hostAdapter: selectedHostAdapter(state),
    issueId: request.issueId,
    options: request.options,
  });

  if (phase === "plan" && stringOption(request.options, "mode") === "create_issues" && !selectedBoolean(state, "planIssuesCliAvailable")) {
    const blockedPlan: NorthstarCommandPlan = { ...plan, argv: [] };
    const blockedGate: NorthstarConfirmationGate = {
      id: "plan:create-issues:blocked",
      phase: "plan",
      title: "Plan issue creation blocked",
      reason: "GitHub issue creation requires confirmation, but production northstar plan-issues CLI is not available in this branch.",
      commandPlanIds: [blockedPlan.id],
      status: "open",
    };
    return {
      ...state,
      currentPhase: phase,
      phases: updatePhaseStatus(state.phases, phase, "blocked"),
      commandPlans: upsertById(state.commandPlans, blockedPlan),
      confirmationGates: upsertById(state.confirmationGates, blockedGate),
    };
  }

  const gates = plan.requiresConfirmation ? [confirmationGateForPlan(plan)] : [];
  return {
    ...state,
    currentPhase: phase,
    phases: plan.requiresConfirmation ? updatePhaseStatus(state.phases, phase, "waiting_for_confirmation") : state.phases.map((item) => ({ ...item })),
    commandPlans: upsertById(state.commandPlans, plan),
    confirmationGates: upsertManyById(state.confirmationGates, gates),
  };
}

function generatePlanPhaseCommandPlan(
  input: GenerateWizardCommandPlanInput,
  mode: string,
  planId: string,
): NorthstarCommandPlan {
  if (mode === "create_issues" || mode === "draft_issues") {
    const argv = ["node", "--run", "northstar", "--", "plan-issues", "--config", input.configPath];
    const specPath = stringOption(input.options, "specPath");
    const planPath = stringOption(input.options, "planPath");
    if (specPath !== undefined) {
      argv.push("--spec", specPath);
    }
    if (planPath !== undefined) {
      argv.push("--plan", planPath);
    }
    if (mode === "draft_issues") {
      argv.push("--dry-run");
    } else {
      argv.push("--apply", "--confirmed");
    }

    return {
      id: planId,
      phase: "plan",
      description: mode === "draft_issues" ? "Draft GitHub issue changes from a Northstar plan." : "Create GitHub issues from a Northstar plan.",
      argv,
      expectedEffects: [
        mode === "draft_issues"
          ? "Preview GitHub issue creation from the supplied spec and plan paths."
          : "Create GitHub issues from the supplied spec and plan paths.",
      ],
      risk: mode === "draft_issues" ? "low" : "high",
      requiresConfirmation: mode === "create_issues",
    };
  }

  return {
    id: planId,
    phase: "plan",
    description: "Use the dashboard to draft a Northstar plan interactively.",
    argv: [],
    expectedEffects: ["No command is run until the operator chooses a concrete planning action."],
    risk: "low",
    requiresConfirmation: false,
  };
}

function phaseStatusForContext(
  phase: NorthstarWizardPhase,
  context: Pick<WizardContext, "hasConfig" | "issueCount" | "activeIssueCount" | "hasRetryableFailures">,
): NorthstarWizardPhaseState["status"] {
  if (phase === "plan") {
    return context.issueCount > 0 ? "completed" : "ready";
  }
  if (phase === "setup") {
    return context.hasConfig ? "completed" : "ready";
  }
  if (phase === "execute") {
    return context.issueCount > 0 ? "ready" : "blocked";
  }
  if (phase === "monitor") {
    return context.activeIssueCount > 0 ? "ready" : "not_started";
  }
  if (phase === "recovery") {
    return context.hasRetryableFailures ? "ready" : "not_started";
  }
  return context.issueCount > 0 ? "ready" : "not_started";
}

function buildPhaseState(
  phase: NorthstarWizardPhase,
  status: NorthstarWizardPhaseState["status"],
): NorthstarWizardPhaseState {
  return {
    phase,
    status,
    summary: summaryForPhase(phase),
    requiredInputs: requiredInputsForPhase(phase),
    completedChecks: status === "completed" ? [summaryForPhase(phase)] : [],
    blockers: status === "blocked" ? blockersForPhase(phase) : [],
  };
}

function updatePhaseStatus(
  phases: NorthstarWizardPhaseState[],
  phase: NorthstarWizardPhase,
  status: NorthstarWizardPhaseState["status"],
): NorthstarWizardPhaseState[] {
  return phases.map((item) => {
    if (item.phase !== phase) {
      return { ...item };
    }
    return {
      ...item,
      status,
      blockers: status === "blocked" ? blockersForPhase(phase) : item.blockers,
    };
  });
}

function updatePhaseBlockedWithBlocker(
  phases: NorthstarWizardPhaseState[],
  phase: NorthstarWizardPhase,
  blocker: string,
): NorthstarWizardPhaseState[] {
  return phases.map((item) => {
    if (item.phase !== phase) {
      return { ...item };
    }
    return {
      ...item,
      status: "blocked",
      blockers: item.blockers.includes(blocker) ? item.blockers : [blocker, ...item.blockers],
    };
  });
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  return [next, ...items.filter((item) => item.id !== next.id)];
}

function upsertManyById<T extends { id: string }>(items: T[], nextItems: T[]): T[] {
  return nextItems.reduce((current, item) => upsertById(current, item), items);
}

function confirmationGateForPlan(plan: NorthstarCommandPlan): NorthstarConfirmationGate {
  return {
    id: `${plan.id}:confirmation`,
    phase: plan.phase,
    title: "Confirm Northstar command",
    reason: `${plan.description} requires operator confirmation before execution.`,
    commandPlanIds: [plan.id],
    status: "open",
  };
}

function commandPlanIdForInput(input: GenerateWizardCommandPlanInput, mode: string): string {
  if (input.phase === "setup") {
    return "setup:doctor";
  }
  if (input.phase === "execute" && mode === "watch") {
    return "execute:watch";
  }
  if (input.phase === "execute") {
    return `execute:start:${issueNumberFromIssueId(input.issueId)}`;
  }
  if (input.phase === "plan" && mode === "create_issues") {
    return "plan:create-issues";
  }
  return `${input.phase}:${mode}`;
}

function issueNumberFromIssueId(issueId: string | undefined): string {
  if (issueId === undefined || issueId.length === 0) {
    throw new Error("NORTHSTAR_WIZARD_ISSUE_REQUIRED");
  }
  const match = /^github:(\d+)$/.exec(issueId);
  if (match === null) {
    return issueId;
  }
  return match[1];
}

function nextRecommendation(context: WizardContext): string {
  if (context.issueCount === 0) {
    return "Generate a plan command or move to setup for an existing GitHub issue workflow.";
  }
  if (context.activeIssueCount > 0) {
    return "Monitor active Northstar work or inspect runtime evidence.";
  }
  if (context.hasRetryableFailures) {
    return "Review recovery evidence and generate a repair command plan.";
  }
  return "Execute the next ready issue or generate a report summary.";
}

function defaultModeForPhase(phase: NorthstarWizardPhase): string {
  if (phase === "execute") {
    return "single_issue";
  }
  if (phase === "plan") {
    return "interactive";
  }
  return "default";
}

function selectedString(state: NorthstarWizardState, key: string): string {
  const value = state.selectedOptions[key];
  return typeof value === "string" ? value : "";
}

function selectedBoolean(state: NorthstarWizardState, key: string): boolean {
  return state.selectedOptions[key] === true;
}

function selectedHostAdapter(state: NorthstarWizardState): HostAdapterName {
  const value = state.selectedOptions.hostAdapter;
  if (value === "codex" || value === "opencode" || value === "pi") {
    return value;
  }
  return "codex";
}

function stringOption(options: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function summaryForPhase(phase: NorthstarWizardPhase): string {
  const summaries: Record<NorthstarWizardPhase, string> = {
    plan: "Prepare a Northstar plan and optional GitHub issue creation.",
    setup: "Validate or create the runtime configuration.",
    execute: "Dispatch Northstar workers for planned issues.",
    monitor: "Inspect active Northstar runtime state.",
    recovery: "Repair retryable runtime failures.",
    report: "Summarize project status and evidence.",
  };
  return summaries[phase];
}

function requiredInputsForPhase(phase: NorthstarWizardPhase): string[] {
  if (phase === "execute") {
    return ["issueId"];
  }
  if (phase === "plan") {
    return ["mode"];
  }
  return [];
}

function blockersForPhase(phase: NorthstarWizardPhase): string[] {
  if (phase === "execute") {
    return ["No GitHub issue exists for Northstar execution."];
  }
  if (phase === "plan") {
    return ["Plan issue creation requires the production northstar plan-issues CLI."];
  }
  return [];
}

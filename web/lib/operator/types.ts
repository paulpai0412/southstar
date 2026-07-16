import type { GoalMissionReadModel } from "../workflow/types";
import type { GoalJourneyLink } from "../goal-journey";

export type OperatorRun = {
  runId: string;
  status: string;
  executionStatus?: string;
  outcomeStatus?: GoalMissionReadModel["status"]["outcome"];
  healthStatus?: GoalMissionReadModel["status"]["health"];
  mission?: GoalMissionReadModel | null;
  title: string;
  domain?: string;
  cwd?: string;
  projectRoot?: string;
  updatedAt?: string;
  commands?: OperatorCommand[];
  journey?: GoalJourneyLink;
};

export type OperatorAttentionItem = {
  id: string;
  kind?: string;
  severity: string;
  interventionMode?: string;
  title: string;
  reason?: string;
  runId?: string;
  taskId?: string;
  status?: string;
  source?: { resourceType?: string; resourceKey?: string; ref?: string };
  detail?: Record<string, unknown>;
  commands?: OperatorCommand[];
  suggestedCommandId?: string;
  updatedAt?: string;
};

export type OperatorCommand = {
  id: string;
  label: string;
  consequence?: string;
  endpoint?: string;
  method?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
  inputOptions?: {
    checkpointRefs?: string[];
    workspaceSnapshotRefs?: string[];
  };
};

export type OperatorCommandResult = {
  commandId: string;
  status: string;
  accepted?: boolean;
  message?: string;
  affectedRunId?: string;
  affectedTaskId?: string;
  updatedAt?: string;
};

export type OperatorOverview = {
  runs: OperatorRun[];
  attentionItems: OperatorAttentionItem[];
  commandResults: OperatorCommandResult[];
  runtimeHealth: {
    activeRunCount: number;
    attentionCount: number;
    blockedCount: number;
  };
  defaultSelection: { runId?: string; taskId?: string; attentionItemId?: string } | null;
};

export type OperatorTaskDebug = {
  schemaVersion: "southstar.read_model.operator_task_debug.v1";
  kind: "operator-task-debug";
  data: {
    runId: string;
    task: {
      taskId: string;
      taskKey: string;
      status: string;
      sortOrder: number;
      dependsOn: string[];
      rootSessionId?: string | null;
      executorTaskId?: string | null;
      snapshot?: unknown;
      metrics?: unknown;
      updatedAt?: string;
    };
    history: OperatorHistoryItem[];
    resources: OperatorResourceItem[];
    artifacts: OperatorResourceItem[];
    debug?: OperatorTaskDebugGroups;
    actions: OperatorCommand[];
    recoveryActions?: OperatorCommand[];
  };
};

export type OperatorTaskDebugGroups = {
  session?: {
    rootSessionId?: string | null;
    sessionIds?: string[];
    checkpoints?: OperatorResourceItem[];
    history?: OperatorHistoryItem[];
    rawEventRefs?: unknown[];
  };
  context?: {
    packets?: OperatorResourceItem[];
    latestPacket?: OperatorResourceItem | null;
    assemblyTraces?: OperatorResourceItem[];
  };
  envelope?: {
    envelopes?: OperatorResourceItem[];
    latestEnvelope?: OperatorResourceItem | null;
  };
  memory?: {
    selectedMemories?: unknown[];
    items?: OperatorResourceItem[];
    deltas?: OperatorResourceItem[];
    invalidatedSourceRefs?: unknown[];
  };
  artifacts?: {
    priorArtifacts?: unknown[];
    refs?: OperatorResourceItem[];
  };
  resources?: Record<string, OperatorResourceItem[] | undefined>;
  recovery?: {
    items?: OperatorResourceItem[];
    commands?: OperatorCommand[];
  };
  raw?: { resources?: OperatorResourceItem[] };
};

export type OperatorHistoryItem = {
  sequence: number;
  eventType: string;
  actorType: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  payload: unknown;
  createdAt: string;
};

export type OperatorResourceItem = {
  resourceType: string;
  resourceKey: string;
  status: string;
  title?: string;
  payload: unknown;
  summary: unknown;
  content?: unknown;
  contentError?: string;
  artifactRefId?: string;
  updatedAt: string;
};

export type RuntimeEventItem = {
  id: string;
  sequence?: number;
  eventType: string;
  runId?: string;
  taskId?: string;
  text: string;
  payload?: unknown;
  createdAt?: string;
};

export type OperatorIncidentStatus = "needs_action" | "observing" | "recovering" | "resolved";

export type OperatorIncident = {
  id: string;
  runId: string;
  taskId: string | null;
  severity: "blocked" | "error" | "warning" | "info";
  status: OperatorIncidentStatus;
  title: string;
  cause: string;
  impact: string;
  nextAction: string;
  ageLabel: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  evidenceRefs: string[];
  commandIds: string[];
  sourceAttentionIds: string[];
};

export type OperatorPriorityLanes = {
  needsAction: OperatorIncident[];
  atRisk: OperatorIncident[];
  running: OperatorRun[];
  recentlyResolved: Array<OperatorIncident | OperatorRun>;
};

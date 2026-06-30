export type OperatorRun = {
  runId: string;
  status: string;
  title: string;
  domain?: string;
  cwd?: string;
  projectRoot?: string;
  updatedAt?: string;
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
};

export type OperatorCommand = {
  id: string;
  label: string;
  endpoint?: string;
  method?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
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
    actions: OperatorCommand[];
  };
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

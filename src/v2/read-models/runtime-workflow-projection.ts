export type WorkflowCanvasNode = {
  id: string;
  label: string;
  kind: "task";
  status: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
  sortOrder: number;
  artifactKind?: string;
  badges: Array<{ label: string; tone: "neutral" | "good" | "warn" | "danger" }>;
  attention?: {
    severity: "info" | "warning" | "error" | "blocked";
    reason: string;
  };
};

export type WorkflowCanvasEdge = {
  id: string;
  source: string;
  target: string;
  status: "pending" | "ready" | "active" | "blocked" | "satisfied";
};

export type RuntimeTaskRow = {
  id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
  snapshot_json: unknown;
};

export type RuntimeOverlayRow = {
  resource_type: string;
  resource_key: string;
  task_id: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
};

export type DraftTaskShape = {
  id: string;
  name?: string;
  roleRef?: string;
  agentProfileRef?: string;
  artifactKind?: string;
  artifactContractRef?: string;
  evaluatorPipelineRef?: string;
  contextPolicyRef?: string;
  vaultLeasePolicyRefs: string[];
  dependsOn: string[];
  skillRefs: string[];
  mcpGrantRefs: string[];
  toolGrantRefs: string[];
  profileOverride?: Record<string, unknown>;
};

export function buildRuntimeWorkflowCanvasProjection(input: {
  tasks: RuntimeTaskRow[];
  workflowTasks: DraftTaskShape[];
  overlayRows: RuntimeOverlayRow[];
  acceptedArtifactTaskIds: Set<string>;
}): { nodes: WorkflowCanvasNode[]; edges: WorkflowCanvasEdge[] } {
  const overlaysByTask = runtimeOverlaysByTask(input.overlayRows);
  const nodes: WorkflowCanvasNode[] = input.tasks.map((task) => {
    const workflowTask = input.workflowTasks.find((candidate) => candidate.id === task.id);
    const snapshot = asRecord(task.snapshot_json);
    const roleRef = stringValue(workflowTask?.roleRef) ?? stringValue(snapshot.roleRef);
    const agentProfileRef = stringValue(workflowTask?.agentProfileRef) ?? stringValue(snapshot.agentProfileRef);
    const overlays = overlaysByTask.get(task.id) ?? [];
    const artifactKind = stringValue(workflowTask?.artifactKind) ?? stringValue(snapshot.artifactKind);
    const attention = attentionFromOverlays(overlays);
    return {
      id: task.id,
      label: task.task_key,
      kind: "task",
      status: task.status,
      dependsOn: stringArray(task.depends_on_json),
      sortOrder: task.sort_order,
      ...(roleRef ? { roleRef } : {}),
      ...(agentProfileRef ? { agentProfileRef } : {}),
      ...(artifactKind ? { artifactKind } : {}),
      badges: overlayBadges(overlays),
      ...(attention ? { attention } : {}),
    };
  });

  const dynamicRepairCauseByTask = new Map<string, string>();
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const task of input.tasks) {
    if (!task.id.startsWith("repair-")) continue;
    const dynamicRepair = asRecord(asRecord(task.snapshot_json).dynamicRepair);
    const failedTaskId = stringValue(dynamicRepair.rootFailedTaskId) ?? stringValue(dynamicRepair.failedTaskId);
    if (failedTaskId && nodeIds.has(failedTaskId)) dynamicRepairCauseByTask.set(task.id, failedTaskId);
  }

  const edges: WorkflowCanvasEdge[] = nodes.flatMap((node) => {
    const dynamicRepairCause = dynamicRepairCauseByTask.get(node.id);
    const sources = dynamicRepairCause ? [dynamicRepairCause] : node.dependsOn;
    return sources.map((source) => ({
      id: `${source}->${node.id}`,
      source,
      target: node.id,
      status: dynamicRepairCause
        ? dynamicRepairEdgeStatus(node)
        : runtimeEdgeStatus({
            source,
            target: node,
            nodes,
            acceptedArtifactTaskIds: input.acceptedArtifactTaskIds,
          }),
    }));
  });

  return { nodes, edges };
}

export function workflowTasksFromWorkflowManifest(value: unknown): DraftTaskShape[] {
  const workflow = asRecord(value);
  return workflowTasksFromUnknown(workflow.tasks);
}

export function workflowTasksFromUnknown(value: unknown): DraftTaskShape[] {
  if (!Array.isArray(value)) return [];
  const tasks: DraftTaskShape[] = [];
  for (const candidate of value) {
    const task = asRecord(candidate);
    const id = stringValue(task.id);
    if (!id) continue;
    tasks.push({
      id,
      ...(stringValue(task.name) ? { name: stringValue(task.name) } : {}),
      ...(stringValue(task.roleRef) ? { roleRef: stringValue(task.roleRef) } : {}),
      ...(stringValue(task.agentProfileRef) ? { agentProfileRef: stringValue(task.agentProfileRef) } : {}),
      ...(stringValue(task.artifactKind) ? { artifactKind: stringValue(task.artifactKind) } : {}),
      ...(stringValue(task.artifactContractRef) ? { artifactContractRef: stringValue(task.artifactContractRef) } : {}),
      ...(stringValue(task.evaluatorPipelineRef) ? { evaluatorPipelineRef: stringValue(task.evaluatorPipelineRef) } : {}),
      ...(stringValue(task.contextPolicyRef) ? { contextPolicyRef: stringValue(task.contextPolicyRef) } : {}),
      vaultLeasePolicyRefs: stringArray(task.vaultLeasePolicyRefs),
      dependsOn: stringArray(task.dependsOn),
      skillRefs: stringArray(task.skillRefs),
      mcpGrantRefs: stringArray(task.mcpGrantRefs),
      toolGrantRefs: stringArray(task.toolGrantRefs),
      ...(isRecord(task.profileOverride) ? { profileOverride: asRecord(task.profileOverride) } : {}),
    });
  }
  return tasks;
}

function runtimeOverlaysByTask(rows: RuntimeOverlayRow[]): Map<string, RuntimeOverlayRow[]> {
  const byTask = new Map<string, RuntimeOverlayRow[]>();
  for (const row of rows) {
    if (!row.task_id) continue;
    const current = byTask.get(row.task_id) ?? [];
    current.push(row);
    byTask.set(row.task_id, current);
  }
  return byTask;
}

function overlayBadges(rows: RuntimeOverlayRow[]): WorkflowCanvasNode["badges"] {
  const badges: WorkflowCanvasNode["badges"] = [];
  for (const row of [...rows].sort((a, b) => overlayOrder(a.resource_type) - overlayOrder(b.resource_type))) {
    const label = overlayLabel(row);
    if (!label) continue;
    badges.push({ label, tone: overlayTone(row) });
  }
  return badges;
}

function overlayOrder(resourceType: string): number {
  if (resourceType === "artifact_ref") return 0;
  if (resourceType === "executor_binding" || resourceType === "hand_execution") return 1;
  if (resourceType === "runtime_exception") return 2;
  if (resourceType === "approval") return 3;
  if (resourceType === "recovery_decision") return 4;
  return 9;
}

function overlayLabel(row: RuntimeOverlayRow): string | null {
  if (row.resource_type === "artifact_ref") return `artifact ${row.status}`;
  if (row.resource_type === "executor_binding" || row.resource_type === "hand_execution") return `executor ${row.status}`;
  if (row.resource_type === "runtime_exception") return `exception ${row.status}`;
  if (row.resource_type === "approval") return `approval ${row.status}`;
  if (row.resource_type === "recovery_decision") return `recovery ${row.status}`;
  return null;
}

function overlayTone(row: RuntimeOverlayRow): "neutral" | "good" | "warn" | "danger" {
  if (row.resource_type === "artifact_ref" && ["accepted", "passed", "completed"].includes(row.status)) return "good";
  if (row.resource_type === "runtime_exception") return "danger";
  if (row.resource_type === "approval" || row.resource_type === "recovery_decision") return "warn";
  if (row.status.includes("failed") || row.status.includes("timeout") || row.status.includes("lost")) return "danger";
  return "neutral";
}

function attentionFromOverlays(rows: RuntimeOverlayRow[]): WorkflowCanvasNode["attention"] | null {
  const ranked = rows
    .map((row) => ({ row, attention: attentionForOverlay(row) }))
    .filter((entry): entry is { row: RuntimeOverlayRow; attention: NonNullable<WorkflowCanvasNode["attention"]> } => entry.attention !== null)
    .sort((a, b) => attentionRank(a.attention.severity) - attentionRank(b.attention.severity));
  return ranked[0]?.attention ?? null;
}

function attentionForOverlay(row: RuntimeOverlayRow): WorkflowCanvasNode["attention"] | null {
  if (row.resource_type === "runtime_exception") return { severity: "blocked", reason: overlayReason(row) };
  if (row.status.includes("failed") || row.status.includes("timeout") || row.status.includes("lost")) {
    return { severity: "error", reason: overlayReason(row) };
  }
  if (row.resource_type === "approval" || row.resource_type === "recovery_decision") {
    return { severity: "warning", reason: overlayReason(row) };
  }
  return null;
}

function overlayReason(row: RuntimeOverlayRow): string {
  const payload = asRecord(row.payload_json);
  return row.title
    ?? stringValue(payload.reason)
    ?? stringValue(payload.message)
    ?? stringValue(payload.kind)
    ?? row.status;
}

function attentionRank(severity: NonNullable<WorkflowCanvasNode["attention"]>["severity"]): number {
  if (severity === "blocked") return 0;
  if (severity === "error") return 1;
  if (severity === "warning") return 2;
  return 3;
}

function runtimeEdgeStatus(input: {
  source: string;
  target: WorkflowCanvasNode;
  nodes: WorkflowCanvasNode[];
  acceptedArtifactTaskIds: Set<string>;
}): WorkflowCanvasEdge["status"] {
  const sourceNode = input.nodes.find((node) => node.id === input.source);
  if (isBlockingStatus(input.target.status) || isBlockingStatus(sourceNode?.status)) return "blocked";
  if (!input.acceptedArtifactTaskIds.has(input.source)) return "pending";
  if (isActiveStatus(input.target.status)) return "active";
  if (isReadyStatus(input.target.status)) return "ready";
  return "satisfied";
}

function dynamicRepairEdgeStatus(target: WorkflowCanvasNode): WorkflowCanvasEdge["status"] {
  if (isBlockingStatus(target.status)) return "blocked";
  if (isActiveStatus(target.status)) return "active";
  if (isReadyStatus(target.status)) return "ready";
  return "satisfied";
}

function isBlockingStatus(status: string | null | undefined): boolean {
  return ["blocked", "exception", "failed", "cancelled"].includes((status ?? "").toLowerCase());
}

function isActiveStatus(status: string | null | undefined): boolean {
  return ["running", "scheduling"].includes((status ?? "").toLowerCase());
}

function isReadyStatus(status: string | null | undefined): boolean {
  return ["ready", "queued", "pending"].includes((status ?? "").toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

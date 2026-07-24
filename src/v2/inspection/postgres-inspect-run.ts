import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
import { runtimeAttemptNumber } from "../executor/attempt-identity.ts";
import { allRuntimeGatesPassed, evaluateRuntimeInspectionGates } from "./runtime-gates.ts";
import type { InspectionCause, InspectedTask, RunInspection, RunInspectionCounts } from "./types.ts";

export async function inspectRunPg(db: SouthstarDb, input: { runId: string }): Promise<RunInspection> {
  const run = await db.maybeOne<WorkflowRunRow>("select * from southstar.workflow_runs where id = $1", [input.runId]);
  if (!run) return missingInspection(input.runId);

  const tasks = (await db.query<WorkflowTaskRow>(
    "select * from southstar.workflow_tasks where run_id = $1 order by sort_order",
    [input.runId],
  )).rows;
  const resources = await resourcesForRun(db, input.runId);
  const acceptedArtifactTaskIds = new Set(
    resources.artifactRefs
      .filter((resource) => resource.status === "accepted" && resource.taskId)
      .map((resource) => resource.taskId!),
  );
  const supersededTaskIds = await supersededDynamicRepairTaskIdsPg(db, input.runId, acceptedArtifactTaskIds);
  const inspectedTasks = tasks.map((task) => inspectTask(task, resources, supersededTaskIds));
  const counts = countInspection(tasks, resources, supersededTaskIds);
  const stopConditionStatus = aggregateStopConditionStatus(resources.stopConditions);
  const gates = evaluateRuntimeInspectionGates({ runStatus: run.status, counts, stopConditionStatus });
  const causes = [...inspectedTasks.flatMap((task) => task.causes), ...gateCauses(gates)];
  const primaryCause = causes.find((cause) => cause.severity === "blocking") ?? null;
  return {
    runId: input.runId,
    status: run.status,
    health: healthForRun(run.status, primaryCause, gates),
    generatedFrom: {
      workflowManifestPresent: JSON.stringify(run.workflow_manifest_json ?? {}).length > 0,
      compiledFrom: compiledFrom(run.workflow_manifest_json),
    },
    counts,
    gates,
    primaryCause,
    contributingCauses: primaryCause ? causes.filter((cause) => cause !== primaryCause) : causes,
    designLibrary: { available: false, reason: "lineage_not_found" },
    tasks: inspectedTasks,
  };
}

function aggregateStopConditionStatus(stopConditions: RuntimeResource[]): string | undefined {
  if (stopConditions.length === 0) return undefined;
  if (stopConditions.every((resource) => resource.status === "passed")) return "passed";
  return stopConditions.find((resource) => resource.status !== "passed")?.status ?? "failed";
}

async function resourcesForRun(db: SouthstarDb, runId: string): Promise<RunResources> {
  const rows = (await db.query<ResourceRow>(
    `select * from southstar.runtime_resources
     where run_id = $1 and resource_type = any($2::text[])
     order by created_at, resource_key`,
    [runId, [
      "executor_binding",
      "artifact",
      ARTIFACT_REF_RESOURCE_TYPE,
      "evidence_packet",
      "validator_result",
      "stop_condition_result",
      "hand_execution",
      "task_execution_intent",
      "tool_proxy_policy",
      "tool_proxy_violation",
      "evaluator_result",
    ]],
  )).rows.map(mapResource);
  return {
    executorBindings: rows.filter((row) => row.resourceType === "executor_binding"),
    handExecutions: rows.filter((row) => row.resourceType === "hand_execution"),
    taskExecutionIntents: rows.filter((row) => row.resourceType === "task_execution_intent"),
    artifacts: rows.filter((row) => row.resourceType === "artifact"),
    artifactRefs: rows.filter((row) => row.resourceType === ARTIFACT_REF_RESOURCE_TYPE),
    evidencePackets: rows.filter((row) => row.resourceType === "evidence_packet"),
    validators: rows.filter((row) => row.resourceType === "validator_result"),
    stopConditions: rows.filter((row) => row.resourceType === "stop_condition_result"),
    toolProxyViolations: rows.filter((row) => row.resourceType === "tool_proxy_violation"),
  };
}

function inspectTask(task: WorkflowTaskRow, resources: RunResources, supersededTaskIds: ReadonlySet<string>): InspectedTask {
  const artifacts = latestTaskAttemptResources([...resources.artifacts, ...resources.artifactRefs], task.id);
  const evidencePackets = latestTaskAttemptResources(resources.evidencePackets, task.id);
  const validators = latestTaskAttemptResources(resources.validators, task.id);
  const binding = resources.executorBindings.filter((resource) => resource.taskId === task.id).at(-1);
  const handExecution = resources.handExecutions.filter((resource) => resource.taskId === task.id).at(-1);
  const causes: InspectionCause[] = [];
  const superseded = supersededTaskIds.has(task.id);
  if (task.status === "failed" && !superseded) causes.push({ code: "task_failed", severity: "blocking", taskId: task.id, message: `Task failed: ${task.id}` });
  if (!binding && !handExecution && ["running", "pending", "queued", "claimed"].includes(task.status)) {
    causes.push({ code: "executor_issue", severity: "blocking", taskId: task.id, message: `Task has no executor binding: ${task.id}` });
  }
  for (const artifact of artifacts) {
    if (artifact.status === "rejected" && !superseded) causes.push({ code: "artifact_rejected", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact rejected for task ${task.id}` });
    if (artifact.status === "needs_repair" && !superseded) causes.push({ code: "artifact_needs_repair", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact needs repair for task ${task.id}` });
  }
  for (const evidence of evidencePackets) {
    if (evidence.status === "incomplete") causes.push({ code: "incomplete_evidence", severity: "blocking", taskId: task.id, resourceRef: evidence.id, message: `Evidence packet incomplete for task ${task.id}` });
  }
  for (const validator of validators) {
    if (validator.status === "failed" && asRecord(validator.payload).blocking === true) {
      causes.push({ code: "blocking_validator_failed", severity: "blocking", taskId: task.id, resourceRef: validator.id, message: `Blocking validator failed for task ${task.id}` });
    }
  }
  const bindingPayload = asRecord(binding?.payload);
  const handExecutionPayload = asRecord(handExecution?.payload);
  return {
    taskId: task.id,
    taskKey: task.task_key,
    status: task.status,
    sortOrder: task.sort_order,
    dependsOn: stringArray(task.depends_on_json),
    executor: {
      bindingId: binding?.id,
      status: binding?.status ?? handExecution?.status,
      executorType: stringField(bindingPayload.executorType) ?? stringField(handExecutionPayload.providerId),
      externalJobId: stringField(bindingPayload.externalJobId) ?? stringField(bindingPayload.torkJobId) ?? stringField(handExecutionPayload.externalJobId),
      runnerPhase: stringField(bindingPayload.runnerPhase) ?? stringField(handExecutionPayload.status),
      lastHeartbeatAt: stringField(bindingPayload.lastHeartbeatAt) ?? stringField(handExecutionPayload.lastHeartbeatAt),
      issue: "none",
    },
    artifact: {
      accepted: artifacts.filter((resource) => resource.status === "accepted").length,
      needsRepair: artifacts.filter((resource) => resource.status === "needs_repair").length,
      rejected: artifacts.filter((resource) => resource.status === "rejected").length,
      latestStatus: artifacts.at(-1)?.status,
      resourceRefs: artifacts.map((resource) => resource.id),
    },
    evidence: {
      complete: evidencePackets.filter((resource) => resource.status === "complete").length,
      incomplete: evidencePackets.filter((resource) => resource.status === "incomplete").length,
      latestStatus: evidencePackets.at(-1)?.status,
      resourceRefs: evidencePackets.map((resource) => resource.id),
      missingKinds: [],
    },
    validators: {
      passed: validators.filter((resource) => resource.status === "passed").length,
      failedBlocking: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload).blocking === true).length,
      failedNonBlocking: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload).blocking !== true).length,
      latestFailedBlockingRef: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload).blocking === true).at(-1)?.id,
    },
    causes,
  };
}

function latestTaskAttemptResources(resources: RuntimeResource[], taskId: string): RuntimeResource[] {
  const taskResources = resources.filter((resource) => resource.taskId === taskId);
  if (taskResources.length <= 1) return taskResources;
  const attemptNumbers = taskResources.map(resourceAttemptNumber);
  const latestAttempt = Math.max(...attemptNumbers);
  if (latestAttempt > 0) {
    return taskResources.filter((resource) => resourceAttemptNumber(resource) === latestAttempt);
  }
  return taskResources.slice(-1);
}

function currentTaskAttemptResources(resources: RuntimeResource[], supersededTaskIds: ReadonlySet<string>): RuntimeResource[] {
  const byTask = new Map<string, RuntimeResource[]>();
  const unscoped: RuntimeResource[] = [];
  for (const resource of resources) {
    if (!resource.taskId) {
      unscoped.push(resource);
      continue;
    }
    const taskResources = byTask.get(resource.taskId) ?? [];
    taskResources.push(resource);
    byTask.set(resource.taskId, taskResources);
  }
  return [
    ...unscoped,
    ...[...byTask.entries()]
      .filter(([taskId]) => !supersededTaskIds.has(taskId))
      .flatMap(([taskId, taskResources]) => latestTaskAttemptResources(taskResources, taskId)),
  ];
}

function resourceAttemptNumber(resource: RuntimeResource): number {
  const payload = asRecord(resource.payload);
  const lineage = asRecord(payload.lineage);
  return runtimeAttemptNumber(
    stringField(payload.attemptId)
      ?? stringField(payload.evaluatorAttemptId)
      ?? stringField(lineage.evaluatorAttemptId),
  );
}

async function supersededDynamicRepairTaskIdsPg(
  db: SouthstarDb,
  runId: string,
  acceptedArtifactTaskIds: ReadonlySet<string>,
): Promise<Set<string>> {
  if (acceptedArtifactTaskIds.size === 0) return new Set();
  const rows = (await db.query<{ payload_json: unknown }>(
    `select payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'workflow_dynamic_repair_revision'
        and status = 'applied'
      order by created_at, resource_key`,
    [runId],
  )).rows;
  const superseded = new Set<string>();
  for (const row of rows) {
    const payload = asRecord(row.payload_json);
    const rootFailedTaskId = stringField(payload.rootFailedTaskId) ?? stringField(payload.originalFailedTaskId);
    const newTaskIds = stringArray(payload.newTaskIds);
    const reconnectTargetTaskId = newTaskIds.at(-1);
    if (rootFailedTaskId && reconnectTargetTaskId && acceptedArtifactTaskIds.has(reconnectTargetTaskId)) {
      superseded.add(rootFailedTaskId);
    }
  }
  return superseded;
}

function missingInspection(runId: string): RunInspection {
  const counts = emptyCounts();
  const gates = evaluateRuntimeInspectionGates({ runStatus: "missing", counts });
  return {
    runId,
    status: "missing",
    health: "unknown",
    generatedFrom: { workflowManifestPresent: false },
    counts,
    gates,
    primaryCause: { code: "run_missing", severity: "blocking", message: `Run not found: ${runId}` },
    contributingCauses: [],
    designLibrary: { available: false, reason: "library_tables_missing" },
    tasks: [],
  };
}

function countInspection(
  tasks: WorkflowTaskRow[],
  resources: RunResources,
  supersededTaskIds: ReadonlySet<string> = new Set(),
): RunInspectionCounts {
  const currentEvidencePackets = currentTaskAttemptResources(resources.evidencePackets, supersededTaskIds);
  const currentValidators = currentTaskAttemptResources(resources.validators, supersededTaskIds);
  const acceptedArtifactRefs = resources.artifactRefs.filter((resource) => resource.status === "accepted");
  const evaluatorArtifactRefs = acceptedArtifactRefs.filter((resource) => {
    const payload = asRecord(resource.payload);
    return stringArray(payload.evaluatorResultRefs).length > 0 || stringArray(payload.evidenceRefs).length > 0;
  });
  const evidenceRequiredArtifactRefs = evaluatorArtifactRefs.length > 0
    ? evaluatorArtifactRefs.length
    : acceptedArtifactRefs.length;
  const oversizedPayloadRows = [...resources.artifacts, ...resources.artifactRefs, ...resources.evidencePackets, ...resources.validators]
    .concat(resources.handExecutions, resources.taskExecutionIntents, resources.toolProxyViolations)
    .filter((resource) => JSON.stringify(resource.payload).length > 50_000).length;
  return {
    tasks: {
      total: tasks.length,
      completed: tasks.filter((task) => task.status === "completed").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      running: tasks.filter((task) => task.status === "running").length,
      pending: tasks.filter((task) => task.status === "pending").length,
    },
    resources: {
      acceptedArtifacts: resources.artifacts.filter((resource) => resource.status === "accepted").length,
      acceptedArtifactRefs: acceptedArtifactRefs.length,
      evidenceRequiredArtifactRefs,
      needsRepairArtifacts: resources.artifacts.filter((resource) => resource.status === "needs_repair").length,
      rejectedArtifacts: resources.artifacts.filter((resource) => resource.status === "rejected").length,
      handExecutions: resources.handExecutions.length,
      taskExecutionIntents: resources.taskExecutionIntents.length,
      blockingToolProxyViolations: resources.toolProxyViolations.filter((resource) => resource.status === "blocking").length,
      completeEvidencePackets: currentEvidencePackets.filter((resource) => resource.status === "complete").length,
      incompleteEvidencePackets: currentEvidencePackets.filter((resource) => resource.status === "incomplete").length,
      blockingValidatorFailures: currentValidators.filter((resource) => resource.status === "failed" && asRecord(resource.payload).blocking === true).length,
      oversizedPayloadRows,
    },
  };
}

function gateCauses(gates: ReturnType<typeof evaluateRuntimeInspectionGates>): InspectionCause[] {
  const causes: InspectionCause[] = [];
  if (gates.completedTasks.verdict === "failed") {
    causes.push({
      code: "completed_tasks_gate_failed",
      severity: "blocking",
      message: `Completed tasks gate failed: expected ${gates.completedTasks.expected}; actual ${String(gates.completedTasks.actual)}`,
    });
  }
  if (gates.acceptedArtifactRefsEqualCompletedTasks.verdict === "failed") {
    causes.push({
      code: "artifact_ref_gate_failed",
      severity: "blocking",
      message: `Artifact ref gate failed: expected ${gates.acceptedArtifactRefsEqualCompletedTasks.expected}; actual ${JSON.stringify(gates.acceptedArtifactRefsEqualCompletedTasks.actual)}`,
    });
  }
  if (gates.completeEvidenceEqualAcceptedArtifacts.verdict === "failed") {
    causes.push({
      code: "evidence_gate_failed",
      severity: "blocking",
      message: `Evidence gate failed: expected ${gates.completeEvidenceEqualAcceptedArtifacts.expected}; actual ${JSON.stringify(gates.completeEvidenceEqualAcceptedArtifacts.actual)}`,
    });
  }
  if (gates.blockingToolProxyViolationsZero.verdict === "failed") {
    causes.push({
      code: "tool_proxy_violation",
      severity: "blocking",
      message: `Tool proxy gate failed: expected ${gates.blockingToolProxyViolationsZero.expected}; actual ${String(gates.blockingToolProxyViolationsZero.actual)}`,
    });
  }
  if (gates.payloadSizeWithinLimit.verdict === "failed") {
    causes.push({
      code: "payload_too_large",
      severity: "blocking",
      message: `Payload size gate failed: expected ${gates.payloadSizeWithinLimit.expected}; actual ${String(gates.payloadSizeWithinLimit.actual)}`,
    });
  }
  if (gates.stopConditionPassed.verdict === "failed") {
    causes.push({
      code: gates.stopConditionPassed.actual === "missing" ? "stop_condition_missing" : "stop_condition_failed",
      severity: "blocking",
      message: `Stop condition gate failed: ${String(gates.stopConditionPassed.actual)}`,
    });
  }
  return causes;
}

function healthForRun(status: string, primaryCause: InspectionCause | null, gates: ReturnType<typeof evaluateRuntimeInspectionGates>): RunInspection["health"] {
  if (["passed", "completed"].includes(status) && !primaryCause && allRuntimeGatesPassed(gates)) return "healthy";
  if (["passed", "completed"].includes(status) && !allRuntimeGatesPassed(gates)) return "failed";
  if (primaryCause?.severity === "blocking") return ["passed", "completed"].includes(status) ? "failed" : "blocked";
  if (["running", "pending", "created"].includes(status)) return "running";
  if (["failed", "cancelled"].includes(status)) return "failed";
  return "unknown";
}

function emptyCounts(): RunInspectionCounts {
  return {
    tasks: { total: 0, completed: 0, failed: 0, running: 0, pending: 0 },
    resources: {
      acceptedArtifacts: 0,
      acceptedArtifactRefs: 0,
      evidenceRequiredArtifactRefs: 0,
      needsRepairArtifacts: 0,
      rejectedArtifacts: 0,
      handExecutions: 0,
      taskExecutionIntents: 0,
      blockingToolProxyViolations: 0,
      completeEvidencePackets: 0,
      incompleteEvidencePackets: 0,
      blockingValidatorFailures: 0,
      oversizedPayloadRows: 0,
    },
  };
}

function compiledFrom(workflowManifest: unknown): RunInspection["generatedFrom"]["compiledFrom"] {
  const manifest = asRecord(workflowManifest);
  const source = asRecord(manifest.compiledFrom);
  if (!source) return undefined;
  return {
    objectKey: stringField(source.objectKey) ?? stringField(source.templateObjectKey),
    versionId: stringField(source.versionId) ?? stringField(source.templateVersionId),
    source: stringField(source.source),
  };
}

type WorkflowRunRow = { id: string; status: string; workflow_manifest_json: unknown };
type WorkflowTaskRow = { id: string; task_key: string; status: string; sort_order: number; depends_on_json: unknown };
type RuntimeResource = { id: string; resourceType: string; taskId?: string; status: string; payload: unknown };
type RunResources = {
  executorBindings: RuntimeResource[];
  handExecutions: RuntimeResource[];
  taskExecutionIntents: RuntimeResource[];
  artifacts: RuntimeResource[];
  artifactRefs: RuntimeResource[];
  evidencePackets: RuntimeResource[];
  validators: RuntimeResource[];
  stopConditions: RuntimeResource[];
  toolProxyViolations: RuntimeResource[];
};
type ResourceRow = { id: string; resource_type: string; task_id: string | null; status: string; payload_json: unknown };

function mapResource(row: ResourceRow): RuntimeResource {
  return { id: row.id, resourceType: row.resource_type, taskId: row.task_id ?? undefined, status: row.status, payload: row.payload_json };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

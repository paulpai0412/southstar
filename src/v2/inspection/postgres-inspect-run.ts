import type { SouthstarDb } from "../db/postgres.ts";
import { ARTIFACT_REF_RESOURCE_TYPE } from "../artifacts/types.ts";
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
  const inspectedTasks = tasks.map((task) => inspectTask(task, resources));
  const counts = countInspection(tasks, resources);
  const stopConditionStatus = resources.stopConditions.at(-1)?.status;
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

async function resourcesForRun(db: SouthstarDb, runId: string): Promise<RunResources> {
  const rows = (await db.query<ResourceRow>(
    `select * from southstar.runtime_resources
     where run_id = $1 and resource_type = any($2::text[])
     order by created_at, resource_key`,
    [runId, ["executor_binding", "artifact", ARTIFACT_REF_RESOURCE_TYPE, "evidence_packet", "validator_result", "stop_condition_result"]],
  )).rows.map(mapResource);
  return {
    executorBindings: rows.filter((row) => row.resourceType === "executor_binding"),
    artifacts: rows.filter((row) => row.resourceType === "artifact" || row.resourceType === ARTIFACT_REF_RESOURCE_TYPE),
    evidencePackets: rows.filter((row) => row.resourceType === "evidence_packet"),
    validators: rows.filter((row) => row.resourceType === "validator_result"),
    stopConditions: rows.filter((row) => row.resourceType === "stop_condition_result"),
  };
}

function inspectTask(task: WorkflowTaskRow, resources: RunResources): InspectedTask {
  const artifacts = resources.artifacts.filter((resource) => resource.taskId === task.id);
  const evidencePackets = resources.evidencePackets.filter((resource) => resource.taskId === task.id);
  const validators = resources.validators.filter((resource) => resource.taskId === task.id);
  const binding = resources.executorBindings.filter((resource) => resource.taskId === task.id).at(-1);
  const causes: InspectionCause[] = [];
  if (task.status === "failed") causes.push({ code: "task_failed", severity: "blocking", taskId: task.id, message: `Task failed: ${task.id}` });
  if (!binding && ["running", "pending"].includes(task.status)) {
    causes.push({ code: "executor_issue", severity: "blocking", taskId: task.id, message: `Task has no executor binding: ${task.id}` });
  }
  for (const artifact of artifacts) {
    if (artifact.status === "rejected") causes.push({ code: "artifact_rejected", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact rejected for task ${task.id}` });
    if (artifact.status === "needs_repair") causes.push({ code: "artifact_needs_repair", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact needs repair for task ${task.id}` });
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
  return {
    taskId: task.id,
    taskKey: task.task_key,
    status: task.status,
    sortOrder: task.sort_order,
    dependsOn: stringArray(task.depends_on_json),
    executor: {
      bindingId: binding?.id,
      status: binding?.status,
      executorType: stringField(bindingPayload.executorType),
      externalJobId: stringField(bindingPayload.externalJobId) ?? stringField(bindingPayload.torkJobId),
      runnerPhase: stringField(bindingPayload.runnerPhase),
      lastHeartbeatAt: stringField(bindingPayload.lastHeartbeatAt),
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

function countInspection(tasks: WorkflowTaskRow[], resources: RunResources): RunInspectionCounts {
  const oversizedPayloadRows = [...resources.artifacts, ...resources.evidencePackets, ...resources.validators]
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
      needsRepairArtifacts: resources.artifacts.filter((resource) => resource.status === "needs_repair").length,
      rejectedArtifacts: resources.artifacts.filter((resource) => resource.status === "rejected").length,
      completeEvidencePackets: resources.evidencePackets.filter((resource) => resource.status === "complete").length,
      incompleteEvidencePackets: resources.evidencePackets.filter((resource) => resource.status === "incomplete").length,
      blockingValidatorFailures: resources.validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload).blocking === true).length,
      oversizedPayloadRows,
    },
  };
}

function gateCauses(gates: ReturnType<typeof evaluateRuntimeInspectionGates>): InspectionCause[] {
  const causes: InspectionCause[] = [];
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
  if (primaryCause?.severity === "blocking") return ["passed", "completed"].includes(status) ? "failed" : "blocked";
  if (["running", "pending", "created"].includes(status)) return "running";
  if (["failed", "cancelled"].includes(status)) return "failed";
  return "unknown";
}

function emptyCounts(): RunInspectionCounts {
  return {
    tasks: { total: 0, completed: 0, failed: 0, running: 0, pending: 0 },
    resources: { acceptedArtifacts: 0, needsRepairArtifacts: 0, rejectedArtifacts: 0, completeEvidencePackets: 0, incompleteEvidencePackets: 0, blockingValidatorFailures: 0, oversizedPayloadRows: 0 },
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
type RunResources = { executorBindings: RuntimeResource[]; artifacts: RuntimeResource[]; evidencePackets: RuntimeResource[]; validators: RuntimeResource[]; stopConditions: RuntimeResource[] };
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

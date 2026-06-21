// @legacy-sqlite-quarantine: retained only for compatibility while Postgres v2 APIs replace this surface.
import type { RuntimeResourceRecord } from "../stores/resource-store.ts";
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { readDesignLibraryLineage } from "./design-library-lineage.ts";
import { explainRunFailure } from "./explain-failure.ts";
import { allRuntimeGatesPassed, evaluateRuntimeInspectionGates } from "./runtime-gates.ts";
import type {
  DesignLibraryLineage,
  InspectionCause,
  InspectionHealth,
  InspectedTask,
  RunInspection,
  RunInspectionCounts,
} from "./types.ts";

export function inspectRun(db: SouthstarDb, input: { runId: string }): RunInspection {
  const run = db.prepare("select * from workflow_runs where id = ?").get(input.runId) as WorkflowRunRow | undefined;
  if (!run) {
    const counts = emptyCounts();
    const gates = evaluateRuntimeInspectionGates({ runStatus: "missing", counts });
    const cause: InspectionCause = {
      code: "run_missing",
      severity: "blocking",
      message: `Run not found: ${input.runId}`,
    };
    return {
      runId: input.runId,
      status: "missing",
      health: "unknown",
      generatedFrom: { workflowManifestPresent: false },
      counts,
      gates,
      primaryCause: cause,
      contributingCauses: [],
      designLibrary: { available: false, reason: "library_tables_missing" },
      tasks: [],
    };
  }

  const workflowManifest = parseJson(run.workflow_manifest_json);
  const tasks = listTaskRows(db, input.runId);
  const resources = resourcesForRun(db, input.runId);
  const inspectedTasks = tasks.map((task) => inspectTask(task, resources));
  const counts = countInspection(tasks, resources);
  const stopConditionStatus = latestStopConditionStatus(resources.stopConditions);
  const gates = evaluateRuntimeInspectionGates({ runStatus: run.status, counts, stopConditionStatus });
  const designLibrary = readDesignLibraryLineage(db, { runId: input.runId, workflowManifest });
  const causes = [
    ...inspectedTasks.flatMap((task) => task.causes),
    ...gateCauses(gates),
    ...designLibraryCauses(designLibrary),
  ];
  const explanation = explainRunFailure(causes);
  return {
    runId: input.runId,
    status: run.status,
    health: healthForRun(run.status, explanation.primaryCause, gates),
    generatedFrom: {
      workflowManifestPresent: run.workflow_manifest_json.length > 0,
      compiledFrom: compiledFrom(workflowManifest),
    },
    counts,
    gates,
    primaryCause: explanation.primaryCause,
    contributingCauses: explanation.contributingCauses,
    designLibrary,
    tasks: inspectedTasks,
  };
}

function inspectTask(task: WorkflowTaskRow, resources: RunResources): InspectedTask {
  const artifacts = [...resources.artifacts, ...resources.artifactRefs].filter((resource) => resource.taskId === task.id);
  const evidencePackets = resources.evidencePackets.filter((resource) => resource.taskId === task.id);
  const validators = resources.validators.filter((resource) => resource.taskId === task.id);
  const binding = resources.executorBindings.filter((resource) => resource.taskId === task.id).at(-1);
  const handExecution = resources.handExecutions.filter((resource) => resource.taskId === task.id).at(-1);
  const causes: InspectionCause[] = [];

  if (task.status === "failed") {
    causes.push({ code: "task_failed", severity: "blocking", taskId: task.id, message: `Task failed: ${task.id}` });
  }
  if (!binding && !handExecution && ["running", "pending", "queued", "claimed"].includes(task.status)) {
    causes.push({ code: "executor_issue", severity: "blocking", taskId: task.id, message: `Task has no executor binding: ${task.id}` });
  }

  for (const artifact of artifacts) {
    if (artifact.status === "rejected") {
      causes.push({ code: "artifact_rejected", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact rejected for task ${task.id}` });
    }
    if (artifact.status === "needs_repair") {
      causes.push({ code: "artifact_needs_repair", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact needs repair for task ${task.id}` });
    }
  }

  for (const evidence of evidencePackets) {
    if (evidence.status === "incomplete") {
      causes.push({ code: "incomplete_evidence", severity: "blocking", taskId: task.id, resourceRef: evidence.id, message: `Evidence packet incomplete for task ${task.id}` });
    }
  }

  for (const validator of validators) {
    const payload = asRecord(validator.payload);
    if (validator.status === "failed" && payload?.blocking === true) {
      causes.push({ code: "blocking_validator_failed", severity: "blocking", taskId: task.id, resourceRef: validator.id, message: `Blocking validator failed for task ${task.id}` });
    }
  }

  const executorIssue = executorIssueFor(binding);
  if (executorIssue !== "none") {
    causes.push({ code: "executor_issue", severity: "blocking", taskId: task.id, resourceRef: binding?.id, message: `Executor issue ${executorIssue} for task ${task.id}` });
  }

  const bindingPayload = asRecord(binding?.payload);
  const handExecutionPayload = asRecord(handExecution?.payload);
  return {
    taskId: task.id,
    taskKey: task.task_key,
    status: task.status,
    sortOrder: task.sort_order,
    dependsOn: parseStringArray(task.depends_on_json),
    executor: {
      bindingId: binding?.id,
      status: binding?.status ?? handExecution?.status,
      executorType: stringField(bindingPayload, "executorType") ?? stringField(handExecutionPayload, "providerId"),
      externalJobId: stringField(bindingPayload, "externalJobId") ?? stringField(bindingPayload, "torkJobId") ?? stringField(handExecutionPayload, "externalJobId"),
      runnerPhase: stringField(bindingPayload, "runnerPhase") ?? stringField(handExecutionPayload, "status"),
      lastHeartbeatAt: stringField(bindingPayload, "lastHeartbeatAt") ?? stringField(handExecutionPayload, "lastHeartbeatAt"),
      issue: executorIssue,
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
      missingKinds: unique(evidencePackets.flatMap((resource) => missingKinds(resource.payload))),
    },
    validators: {
      passed: validators.filter((resource) => resource.status === "passed").length,
      failedBlocking: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking === true).length,
      failedNonBlocking: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking !== true).length,
      latestFailedBlockingRef: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking === true).at(-1)?.id,
    },
    causes,
  };
}

function resourcesForRun(db: SouthstarDb, runId: string): RunResources {
  return {
    executorBindings: listResources(db, { resourceType: "executor_binding" }).filter((resource) => resource.runId === runId),
    artifacts: listResources(db, { resourceType: "artifact" }).filter((resource) => resource.runId === runId),
    artifactRefs: listResources(db, { resourceType: "artifact_ref" }).filter((resource) => resource.runId === runId),
    handExecutions: listResources(db, { resourceType: "hand_execution" }).filter((resource) => resource.runId === runId),
    taskExecutionIntents: listResources(db, { resourceType: "task_execution_intent" }).filter((resource) => resource.runId === runId),
    evidencePackets: listResources(db, { resourceType: "evidence_packet" }).filter((resource) => resource.runId === runId),
    validators: listResources(db, { resourceType: "validator_result" }).filter((resource) => resource.runId === runId),
    stopConditions: listResources(db, { resourceType: "stop_condition_result" }).filter((resource) => resource.runId === runId),
    toolProxyViolations: listResources(db, { resourceType: "tool_proxy_violation" }).filter((resource) => resource.runId === runId),
  };
}

function countInspection(tasks: WorkflowTaskRow[], resources: RunResources): RunInspectionCounts {
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
      acceptedArtifactRefs: resources.artifactRefs.filter((resource) => resource.status === "accepted").length,
      needsRepairArtifacts: resources.artifacts.filter((resource) => resource.status === "needs_repair").length,
      rejectedArtifacts: resources.artifacts.filter((resource) => resource.status === "rejected").length,
      handExecutions: resources.handExecutions.length,
      taskExecutionIntents: resources.taskExecutionIntents.length,
      blockingToolProxyViolations: resources.toolProxyViolations.filter((resource) => resource.status === "blocking").length,
      completeEvidencePackets: resources.evidencePackets.filter((resource) => resource.status === "complete").length,
      incompleteEvidencePackets: resources.evidencePackets.filter((resource) => resource.status === "incomplete").length,
      blockingValidatorFailures: resources.validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking === true).length,
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

function designLibraryCauses(lineage: DesignLibraryLineage): InspectionCause[] {
  if (lineage.available) return [];
  return [{
    code: "design_library_lineage_unavailable",
    severity: "warning",
    message: `Design Library lineage unavailable: ${lineage.reason}`,
  }];
}

function healthForRun(status: string, primaryCause: InspectionCause | null, gates: ReturnType<typeof evaluateRuntimeInspectionGates>): InspectionHealth {
  if (status === "missing") return "unknown";
  if (["failed", "cancelled"].includes(status)) return "failed";
  if (["passed", "completed"].includes(status) && !primaryCause && allRuntimeGatesPassed(gates)) return "healthy";
  if (["passed", "completed"].includes(status) && !allRuntimeGatesPassed(gates)) return "failed";
  if (primaryCause?.severity === "blocking") return ["passed", "completed"].includes(status) ? "failed" : "blocked";
  if (["running", "pending", "created"].includes(status)) return "running";
  return "unknown";
}

function latestStopConditionStatus(resources: RuntimeResourceRecord[]): string | undefined {
  return resources.at(-1)?.status;
}

function executorIssueFor(binding: RuntimeResourceRecord | undefined): InspectedTask["executor"]["issue"] {
  if (!binding) return "none";
  const payload = asRecord(binding.payload);
  const status = stringField(payload, "southstarExecutorStatus") ?? binding.status;
  if (status === "timeout") return "timeout";
  if (status === "orphaned") return "orphaned";
  if (status === "callback_missing") return "callback_missing";
  return "none";
}

function compiledFrom(workflowManifest: unknown): RunInspection["generatedFrom"]["compiledFrom"] {
  const manifest = asRecord(workflowManifest);
  const direct = asRecord(manifest?.compiledFrom);
  const metadata = asRecord(manifest?.metadata);
  const nested = asRecord(metadata?.compiledFrom);
  const source = direct ?? nested;
  if (!source) return undefined;
  return {
    objectKey: stringField(source, "objectKey") ?? stringField(source, "templateObjectKey"),
    versionId: stringField(source, "versionId") ?? stringField(source, "templateVersionId"),
    source: stringField(source, "source"),
  };
}

function listTaskRows(db: SouthstarDb, runId: string): WorkflowTaskRow[] {
  return db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId) as WorkflowTaskRow[];
}

function emptyCounts(): RunInspectionCounts {
  return {
    tasks: { total: 0, completed: 0, failed: 0, running: 0, pending: 0 },
    resources: {
      acceptedArtifacts: 0,
      acceptedArtifactRefs: 0,
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

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function parseStringArray(text: string): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function missingKinds(payload: unknown): string[] {
  const record = asRecord(payload);
  const completeness = asRecord(record?.completeness);
  const missing = completeness?.missingKinds;
  return Array.isArray(missing) ? missing.filter((item): item is string => typeof item === "string") : [];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type RunResources = {
  executorBindings: RuntimeResourceRecord[];
  artifacts: RuntimeResourceRecord[];
  artifactRefs: RuntimeResourceRecord[];
  handExecutions: RuntimeResourceRecord[];
  taskExecutionIntents: RuntimeResourceRecord[];
  evidencePackets: RuntimeResourceRecord[];
  validators: RuntimeResourceRecord[];
  stopConditions: RuntimeResourceRecord[];
  toolProxyViolations: RuntimeResourceRecord[];
};

type WorkflowRunRow = {
  id: string;
  status: string;
  workflow_manifest_json: string;
};

type WorkflowTaskRow = {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: string;
};

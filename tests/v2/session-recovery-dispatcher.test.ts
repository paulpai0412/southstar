import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { dispatchRecoveryExecution } from "../../src/v2/session-recovery/dispatcher.ts";
import type { ExecutorProvider, ExecutorSubmitRequest, ExecutorSubmitResult } from "../../src/v2/executor/provider.ts";
import type { SouthstarWorkflowManifest, TaskExecutionSpec } from "../../src/v2/manifests/types.ts";

const execution: TaskExecutionSpec = {
  engine: "tork",
  image: "southstar/pi-agent:local",
  command: ["southstar-agent-runner"],
  env: {},
  mounts: [],
  timeoutSeconds: 900,
  infraRetry: { maxAttempts: 1 },
};

function workflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-recovery-dispatch",
    title: "Recovery dispatch workflow",
    goalPrompt: "recover workflow slice",
    domain: "general",
    roles: [
      { id: "producer", responsibility: "Produce the work artifact.", defaultAgentProfileRef: "agent-producer", allowedAgentProfileRefs: ["agent-producer"], artifactInputs: [], artifactOutputs: ["work"], stopAuthority: "none" },
      { id: "reviewer", responsibility: "Review the produced artifact.", defaultAgentProfileRef: "agent-reviewer", allowedAgentProfileRefs: ["agent-reviewer"], artifactInputs: ["work"], artifactOutputs: ["review"], stopAuthority: "can-reject" },
    ],
    agentProfiles: [
      { id: "agent-producer", name: "Producer", provider: "pi", harnessRef: "pi", agentsMdRefs: [], promptTemplateRef: "producer", skillRefs: [], mcpGrantRefs: [], memoryScopes: ["general"], contextPolicyRef: "ctx", sessionPolicyRef: "session", toolPolicy: { allowedTools: ["read"], deniedTools: [], requiresApprovalFor: [] }, budgetPolicy: { maxInputTokens: 8000, maxOutputTokens: 1000 } },
      { id: "agent-reviewer", name: "Reviewer", provider: "pi", harnessRef: "pi", agentsMdRefs: [], promptTemplateRef: "reviewer", skillRefs: [], mcpGrantRefs: [], memoryScopes: ["general"], contextPolicyRef: "ctx", sessionPolicyRef: "session", toolPolicy: { allowedTools: ["read"], deniedTools: [], requiresApprovalFor: [] }, budgetPolicy: { maxInputTokens: 8000, maxOutputTokens: 1000 } },
    ],
    artifactContracts: [
      { id: "work", artifactType: "work", requiredFields: ["summary"], evidenceFields: ["summary"] },
      { id: "review", artifactType: "review", requiredFields: ["summary"], evidenceFields: ["summary"] },
    ],
    evaluatorPipelines: [
      { id: "work-quality", evaluators: [{ id: "schema", kind: "schema", config: { artifactRef: "work" }, required: true }], onFailure: { defaultStrategy: "retry-same-agent" } },
      { id: "review-quality", evaluators: [{ id: "schema", kind: "schema", config: { artifactRef: "review" }, required: true }], onFailure: { defaultStrategy: "fork-from-checkpoint" } },
    ],
    contextPolicies: [{ id: "ctx", maxInputTokens: 8000, memoryPolicyRef: "mem", includeAgentsMd: false, includeWorkspaceSummary: false }],
    sessionPolicies: [{ id: "session", checkpointOn: ["task-start", "artifact-accepted", "before-recovery"], allowFork: true, allowReset: true, allowRollback: true }],
    memoryPolicies: [{ id: "mem", providerRef: "sqlite", scopes: ["general"], maxInjectedTokens: 1000, maxCandidates: 3, requireWriteApproval: false, allowedKinds: [], ranking: { relevanceWeight: 1, recencyWeight: 0, successWeight: 0, confidenceWeight: 0 }, compression: { strategy: "none", maxTokensPerMemory: 100 } }],
    workspacePolicies: [],
    tasks: [
      { id: "produce", name: "Produce", domain: "general", roleRef: "producer", agentProfileRef: "agent-producer", dependsOn: [], requiredArtifactRefs: ["work"], evaluatorPipelineRef: "work-quality", execution, rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 }, subagents: [{ id: "producer", harnessId: "pi", prompt: "produce", requiredArtifacts: ["work"] }] },
      { id: "review", name: "Review", domain: "general", roleRef: "reviewer", agentProfileRef: "agent-reviewer", dependsOn: ["produce"], requiredArtifactRefs: ["review"], evaluatorPipelineRef: "review-quality", execution, rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 }, subagents: [{ id: "reviewer", harnessId: "pi", prompt: "review", requiredArtifacts: ["review"] }] },
    ],
    harnessDefinitions: [{ id: "pi", kind: "pi-agent", entrypoint: "southstar-agent-runner", image: "southstar/pi-agent:local", capabilities: ["general"], inputProtocol: "task-envelope-v2", eventProtocol: "southstar-events-v1", supportsCheckpoint: true, supportsSteering: true, supportsProgress: true }],
    evaluators: [],
    memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false },
    vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false },
  };
}

test("dispatcher submits recovery slice, materializes envelopes, and creates attempt binding", async () => {
  const db = openSouthstarDb(":memory:");
  const manifest = workflow();
  createWorkflowRun(db, {
    id: "run-dispatch",
    status: "running",
    domain: "general",
    goalPrompt: manifest.goalPrompt,
    workflowManifestJson: JSON.stringify(manifest),
    executionProjectionJson: JSON.stringify(null),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  manifest.tasks.forEach((task, index) => createWorkflowTask(db, {
    id: task.id,
    runId: "run-dispatch",
    taskKey: task.id,
    status: "completed",
    sortOrder: index,
    dependsOn: task.dependsOn,
    rootSessionId: `root-run-dispatch-${task.id}`,
  }));

  const submitted: ExecutorSubmitRequest[] = [];
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    async submit(request): Promise<ExecutorSubmitResult> {
      submitted.push(request);
      return { executorType: "tork", externalJobId: "job-recovery", status: "queued", executionProjection: { job: { tasks: request.workflow.tasks.map((task) => task.id) } } };
    },
  };

  const runRoot = await mkdtemp(join(tmpdir(), "southstar-dispatch-test-"));
  const result = await dispatchRecoveryExecution(db, {
    runId: "run-dispatch",
    failedTaskId: "review",
    plan: {
      strategy: "fork-from-checkpoint",
      failedTaskId: "review",
      baseTaskId: "produce",
      targetTaskIds: ["produce", "review"],
      attemptNumber: 2,
      requiresOperatorApproval: false,
      reason: "rerun producer and reviewer",
      diagnostics: [],
    },
    executorProvider,
    runRoot,
    callbackUrl: "http://127.0.0.1/callback",
    contextRefreshUrl: "http://127.0.0.1/context",
  });

  assert.equal(result.externalJobId, "job-recovery");
  assert.deepEqual(submitted[0]?.workflow.tasks.map((task) => task.id), ["produce", "review"]);
  assert.deepEqual(submitted[0]?.workflow.tasks.find((task) => task.id === "review")?.dependsOn, ["produce"]);
  assert.equal(submitted[0]?.attemptId, "attempt-2");
  assert.equal(submitted[0]?.envelopeBasePath, "/southstar-runs/recovery-attempt-2");

  const envelopes = listResources(db, { resourceType: "task_envelope" }).filter((resource) => resource.runId === "run-dispatch");
  assert.equal(envelopes.some((resource) => resource.taskId === "produce"), true);
  assert.equal(envelopes.some((resource) => resource.taskId === "review"), true);

  const bindings = listResources(db, { resourceType: "executor_binding" }).filter((resource) => resource.runId === "run-dispatch");
  assert.equal(bindings.some((resource) => resource.resourceKey === "executor-run-dispatch-produce-attempt-2"), true);
  assert.equal(bindings.some((resource) => resource.resourceKey === "executor-run-dispatch-review-attempt-2"), true);

  const tasks = db.prepare("select id, status, completed_at from workflow_tasks where run_id = ? order by sort_order").all("run-dispatch") as Array<{ id: string; status: string; completed_at: string | null }>;
  assert.deepEqual(tasks.map((task) => `${task.id}:${task.status}:${task.completed_at === null}`), ["produce:pending:true", "review:pending:true"]);
});

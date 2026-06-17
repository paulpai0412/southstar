import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { appendRuntimeEvent } from "../../src/v2/signals/events.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { createApprovalRequest } from "../../src/v2/approvals/service.ts";
import { createPlannerDraft, createRunFromDraft, getTaskEnvelope } from "../../src/v2/ui-api/local-api.ts";
import { buildPlannerPageModel } from "../../src/v2/ui-api/page-models/planner.ts";
import { buildWorkflowCanvasPageModel } from "../../src/v2/ui-api/page-models/workflow-canvas.ts";
import { buildRuntimeMonitorPageModel } from "../../src/v2/ui-api/page-models/runtime-monitor.ts";
import { buildTaskDetailPageModel } from "../../src/v2/ui-api/page-models/task-detail.ts";
import { buildSessionsMemoryPageModel } from "../../src/v2/ui-api/page-models/sessions-memory.ts";
import { buildWorktreePageModel } from "../../src/v2/ui-api/page-models/worktree.ts";
import { buildExecutorOpsPageModel } from "../../src/v2/ui-api/page-models/executor.ts";
import { buildDomainPacksPageModel } from "../../src/v2/ui-api/page-models/domain-packs.ts";
import { buildGovernancePageModel } from "../../src/v2/ui-api/page-models/governance.ts";
import { pauseRunCommand, resumeRunCommand, cancelRunCommand } from "../../src/v2/ui-api/commands/run-commands.ts";
import { retryTaskCommand, requestTaskSessionForkCommand, requestWorkflowRevisionCommand } from "../../src/v2/ui-api/commands/task-commands.ts";
import { approveMemoryCommand, rejectMemoryCommand, doNotInjectMemoryCommand, forkSessionCommand, resetSessionCommand, rollbackSessionCommand, rewindSessionCommand } from "../../src/v2/ui-api/commands/session-memory-commands.ts";
import { createWorktreeSnapshotCommand, previewWorktreeRollbackCommand, rollbackWorktreeCommand } from "../../src/v2/ui-api/commands/worktree-commands.ts";
import { retryExecutorJobCommand, cancelExecutorJobCommand, reconcileExecutorJobCommand } from "../../src/v2/ui-api/commands/executor-commands.ts";
import { validateDomainPackCommand, previewDomainPackWorkflowCommand, publishDomainPackCommand } from "../../src/v2/ui-api/commands/domain-pack-commands.ts";
import { addMcpConnectionCommand, addVaultSecretGroupCommand, simulateApprovalPolicyCommand, decideApprovalCommand } from "../../src/v2/ui-api/commands/governance-commands.ts";
import { assertUiControlPlaneGates } from "../../src/v2/quality/ui-control-plane-gates.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";

test("runtime server exposes UI page model and command envelopes", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-ui-contract-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({ host: "127.0.0.1", port: 0, db, plannerClient: plannerClient(), executorProvider: executorProvider() });
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const planner = await client.getUiPlanner();
    assert.equal(planner.kind, "ui-planner");
    assert.equal(planner.result.surface, "southstar.ui.planner.v1");
    const command = await client.pauseRun({ runId: "missing-run", commandId: "cmd-test", actor: { type: "user", id: "tester" }, reason: "contract test", payload: {} });
    assert.equal(command.kind, "command-result");
    assert.equal(command.result.commandId, "cmd-test");
    assert.equal(command.result.accepted, false);
    assert.equal(command.result.status, "rejected");
    assert.match(command.result.nextSuggestedActions.join(" "), /select an existing run/i);

    const rewindResponse = await fetch(`${server.url}/api/v2/sessions/${encodeURIComponent("sess-root")}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: "cmd-rewind", actor: { type: "user" }, payload: { checkpointId: "chk-1", reason: "operator rewind" } }),
    });
    const rewindPayload = await rewindResponse.json() as { kind: string; result: { accepted: boolean } };
    assert.equal(rewindPayload.kind, "command-result");
  } finally {
    await server.close();
  }
});

test("planner page model exposes draft readiness, assignment preview, budget, contract, and policy controls", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, { goalPrompt: "新增 calc sum <numbers...>，保留最小改動。", plannerClient: unusedPlanner() });
  const model = buildPlannerPageModel(db, { draftId: draft.draftId });
  assert.equal(model.surface, "southstar.ui.planner.v1");
  assert.equal(model.activeDraft?.draftId, draft.draftId);
  assert.equal(model.activeDraft?.domain, "software");
  assert.equal(model.activeDraft?.intent, "implement_feature");
  assert.equal(model.activeDraft?.taskCount >= 4, true);
  assert.equal(model.readiness.some((row) => row.label === "Domain / Intent" && row.status === "detected"), true);
  assert.equal(model.taskAssignments.length, model.activeDraft?.taskCount);
  assert.equal(model.contextBudget.limitTokens, 128000);
  assert.equal(model.artifactContract.length > 0, true);
  assert.equal(model.stopCondition.length > 0, true);
  assert.equal(model.policyControls.rollbackStrategy, "Git Worktree (per task)");
});

test("workflow canvas model exposes real DAG and recovery command effects", async () => {
  const { db, run } = await plannedRun("新增 calc sum <numbers...>");
  const taskId = firstMakerTaskId(db, run.runId);
  const model = buildWorkflowCanvasPageModel(db, { runId: run.runId, selectedTaskId: taskId });
  assert.equal(model.surface, "southstar.ui.workflow-canvas.v1");
  assert.equal(model.nodes.length >= 4, true);
  assert.equal(model.edges.some((edge) => edge.kind === "dependency"), true);
  assert.equal(model.selectedNode?.taskId, taskId);
  assert.equal(model.selectedNode?.actions.some((action) => action.command === "retry-task"), true);
  assert.equal(retryTaskCommand(db, { runId: run.runId, taskId, commandId: "cmd-retry", actor: { type: "user", id: "tester" }, payload: { reason: "test retry" } }).accepted, true);
  assert.equal(requestTaskSessionForkCommand(db, { runId: run.runId, taskId, commandId: "cmd-fork", actor: { type: "user", id: "tester" }, payload: { reason: "test fork" } }).accepted, true);
  assert.equal(requestWorkflowRevisionCommand(db, { runId: run.runId, taskId, commandId: "cmd-revision", actor: { type: "user", id: "tester" }, payload: { prompt: "split testing" } }).accepted, true);
  const recoveryRows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'recovery_decision'
  `).all(run.runId, taskId) as Array<{ payload_json: string }>;
  assert.equal(recoveryRows.length >= 1, true);
  const parsed = recoveryRows.map((row) => JSON.parse(row.payload_json));
  assert.equal(parsed.some((payload) => payload.schemaVersion === "southstar.recovery-decision.v1"), true);

  const after = buildWorkflowCanvasPageModel(db, { runId: run.runId, selectedTaskId: taskId });
  assert.equal(after.revisionTimeline.length >= 1, true);
  assert.equal(after.rootSessionDecisions.length >= 3, true);
});

test("runtime monitor model and lifecycle commands use durable run state and events", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-ui-monitor", status: "running", domain: "software", goalPrompt: "calc sum", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  appendRuntimeEvent(db, { runId: "run-ui-monitor", eventType: "run.started", actorType: "root-session", payload: { ok: true } });
  upsertRuntimeResource(db, { resourceType: "executor_binding", resourceKey: "exec-run-ui-monitor", runId: "run-ui-monitor", scope: "executor", status: "running", payload: { torkJobId: "job-ui-monitor" } });
  assert.equal(buildRuntimeMonitorPageModel(db, { runId: "run-ui-monitor" }).kpis.activeTasks.value, 0);
  assert.equal(pauseRunCommand(db, { runId: "run-ui-monitor", commandId: "cmd-pause", actor: { type: "user" }, payload: {} }).accepted, true);
  assert.equal(buildRuntimeMonitorPageModel(db, { runId: "run-ui-monitor" }).run.status, "paused");
  assert.equal(resumeRunCommand(db, { runId: "run-ui-monitor", commandId: "cmd-resume", actor: { type: "user" }, payload: {} }).accepted, true);
  assert.equal(cancelRunCommand(db, { runId: "run-ui-monitor", commandId: "cmd-cancel", actor: { type: "user" }, payload: { cancelActiveJobs: true } }).accepted, true);
  const model = buildRuntimeMonitorPageModel(db, { runId: "run-ui-monitor" });
  assert.equal(model.run.status, "cancelled");
  assert.equal(model.stopGate.status, "cancelled");
  assert.equal(model.integrationHealth.some((row) => row.service === "Tork Executor" && row.status === "healthy"), true);
});

test("task detail page model exposes TaskEnvelopeV2, ContextPacket, artifacts, evaluator result, and actions", async () => {
  const { db, run } = await plannedRun("新增 calc sum <numbers...>");
  const taskId = firstMakerTaskId(db, run.runId);
  const envelope = getTaskEnvelope(db, { runId: run.runId, taskId });
  const model = buildTaskDetailPageModel(db, { runId: run.runId, taskId });
  assert.equal(model.surface, "southstar.ui.task-detail.v1");
  assert.equal(model.task.taskId, taskId);
  assert.equal(model.envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(model.contextPacket.id, envelope.contextPacket.id);
  assert.equal(model.memoryTrace.selected.length >= 0, true);
  assert.equal(model.actions.some((action) => action.command === "retry-task"), true);
  assert.equal(model.evaluator.pipelineId.length > 0, true);
  assert.equal(Array.isArray(model.worktree.snapshots), true);
  assert.equal(Array.isArray(model.worktree.rollbackPreviews), true);
  assert.equal(Array.isArray(model.worktree.rollbacks), true);
});

test("sessions memory page supports lineage and memory decisions through durable resources", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-sm", status: "running", domain: "software", goalPrompt: "calc", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  upsertRuntimeResource(db, { resourceType: "session_checkpoint", resourceKey: "chk-1", runId: "run-sm", taskId: "task-1", sessionId: "sess-root", scope: "session", status: "active", title: "Checkpoint", payload: { id: "chk-1", runId: "run-sm", taskId: "task-1", sessionId: "sess-root" } });
  upsertRuntimeResource(db, { resourceType: "memory_item", resourceKey: "mem-1", runId: "run-sm", scope: "software", status: "pending", title: "Memory", payload: { summary: "use minimal patches", tokenEstimate: 120 } });
  assert.equal(forkSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-fork", actor: { type: "user" }, payload: { checkpointId: "chk-1" } }).accepted, true);
  assert.equal(resetSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-reset", actor: { type: "user" }, payload: { checkpointId: "chk-1" } }).accepted, true);
  assert.equal(rollbackSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-rollback", actor: { type: "user" }, payload: { checkpointId: "chk-1" } }).accepted, true);
  const rewindResult = rewindSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-rewind-compatible", actor: { type: "user" }, payload: { checkpointId: "chk-1", reason: "rewind via compatible command path" } });
  assert.equal(rewindResult.accepted, true);
  assert.equal(approveMemoryCommand(db, { memoryId: "mem-1", commandId: "cmd-approve", actor: { type: "user" }, payload: { reason: "relevant" } }).accepted, true);
  assert.equal(rejectMemoryCommand(db, { memoryId: "mem-1", commandId: "cmd-reject", actor: { type: "user" }, payload: { reason: "low value" } }).accepted, true);
  assert.equal(doNotInjectMemoryCommand(db, { memoryId: "mem-1", commandId: "cmd-exclude", actor: { type: "user" }, payload: { reason: "conflict" } }).accepted, true);
  const model = buildSessionsMemoryPageModel(db, { runId: "run-sm", sessionId: "sess-root" });
  assert.equal(model.surface, "southstar.ui.sessions-memory.v1");
  assert.equal(model.lineage.length >= 4, true);
  assert.equal(model.memoryRows.length, 1);
  assert.equal(model.memoryDecisions.length >= 3, true);
  assert.equal(model.tokenEfficiency.totalMemories, 1);
});

test("worktree console creates snapshots, previews rollback, and executes rollback through git state", () => {
  const db = openSouthstarDb(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "southstar-worktree-command-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "changed\n");
  const snapshot = createWorktreeSnapshotCommand(db, { runId: "run-wt", commandId: "cmd-snap", actor: { type: "user" }, payload: { repoRoot: repo, taskId: "task-1" } });
  const preview = previewWorktreeRollbackCommand(db, { runId: "run-wt", commandId: "cmd-preview", actor: { type: "user" }, payload: { repoRoot: repo, snapshotRef: snapshot.resourceRefs[0] } });
  const rollback = rollbackWorktreeCommand(db, { runId: "run-wt", commandId: "cmd-rollback", actor: { type: "user" }, payload: { repoRoot: repo, previewId: preview.resourceRefs[0] } });
  assert.equal(snapshot.accepted, true);
  assert.equal(preview.accepted, true);
  assert.equal(rollback.accepted, true);
  assert.match(String(execFileSync("git", ["diff", "--", "README.md"], { cwd: repo })), /^$/);
  const model = buildWorktreePageModel(db, { runId: "run-wt" });
  assert.equal(model.surface, "southstar.ui.worktree.v1");
  assert.equal(model.snapshots.length >= 1, true);
  assert.equal(model.rollbackPreviews.length >= 1, true);
});

test("executor ops page reconciles job state through Southstar command resources", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-ex", status: "running", domain: "software", goalPrompt: "calc", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  upsertRuntimeResource(db, { resourceType: "executor_binding", resourceKey: "exec-1", runId: "run-ex", taskId: undefined, scope: "executor", status: "failed", title: "Tork job", payload: { torkJobId: "job-1", image: "southstar/pi-agent:local" } });
  assert.equal(retryExecutorJobCommand(db, { jobId: "job-1", commandId: "cmd-retry-job", actor: { type: "user" }, payload: { reason: "test" } }).accepted, true);
  assert.equal(cancelExecutorJobCommand(db, { jobId: "job-1", commandId: "cmd-cancel-job", actor: { type: "user" }, payload: { reason: "test" } }).accepted, true);
  assert.equal(reconcileExecutorJobCommand(db, { jobId: "job-1", commandId: "cmd-reconcile-job", actor: { type: "user" }, payload: {} }).accepted, true);
  const model = buildExecutorOpsPageModel(db, {});
  assert.equal(model.surface, "southstar.ui.executor.v1");
  assert.equal(model.jobs.length, 1);
  assert.equal(model.jobs[0]?.jobId, "job-1");
  assert.equal(model.integrationHealth.some((row) => row.service === "Tork API"), true);
  assert.equal(model.selectedJob?.actions.some((action) => action.command === "retry-job"), true);
});

test("domain packs page exposes DSL, profiles, diagnostics, preview and publish commands", () => {
  const db = openSouthstarDb(":memory:");
  const model = buildDomainPacksPageModel(db, { domainPackId: "software" });
  assert.equal(model.surface, "southstar.ui.domain-packs.v1");
  assert.equal(model.domainPacks.some((pack) => pack.id === "software"), true);
  assert.equal(model.selectedPack?.agentProfiles.length > 0, true);
  assert.equal(model.selectedPack?.artifactContracts.length > 0, true);
  assert.equal(model.selectedPack?.evaluatorPipeline.length > 0, true);
  assert.equal(validateDomainPackCommand(db, { domainPackId: "software", commandId: "cmd-validate", actor: { type: "user" }, payload: {} }).accepted, true);
  assert.equal(previewDomainPackWorkflowCommand(db, { domainPackId: "software", commandId: "cmd-preview", actor: { type: "user" }, payload: { goalPrompt: "新增 calc sum" } }).accepted, true);
  assert.equal(publishDomainPackCommand(db, { domainPackId: "software", commandId: "cmd-publish", actor: { type: "user" }, payload: { version: "1.3.3" } }).accepted, true);
});

test("governance page manages MCP, vault, approval queue, policy simulation, and audit log", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-gov", status: "running", domain: "software", goalPrompt: "calc", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  const approval = createApprovalRequest(db, { runId: "run-gov", actionType: "voiceCommand", riskTags: ["external-write"], title: "Review", payload: { transcript: "send external" } });
  assert.equal(addMcpConnectionCommand(db, { commandId: "cmd-mcp", actor: { type: "user" }, payload: { name: "filesystem", scope: "workspace" } }).accepted, true);
  assert.equal(addVaultSecretGroupCommand(db, { commandId: "cmd-vault", actor: { type: "user" }, payload: { name: "github-token", scopedAccess: "software-change" } }).accepted, true);
  assert.equal(simulateApprovalPolicyCommand(db, { commandId: "cmd-sim", actor: { type: "user" }, payload: { actionType: "voiceCommand", riskTags: ["external-write"] } }).accepted, true);
  assert.equal(decideApprovalCommand(db, { approvalId: approval.id, commandId: "cmd-approve", actor: { type: "user" }, payload: { decision: "approved", reason: "test" } }).accepted, true);
  const model = buildGovernancePageModel(db, {});
  assert.equal(model.surface, "southstar.ui.governance.v1");
  assert.equal(model.mcpConnections.length, 1);
  assert.equal(model.secretGroups.length, 1);
  assert.equal(model.approvalQueue.length >= 1, true);
  assert.equal(model.auditLog.length >= 1, true);
});

test("ui control plane gates enforce stop condition, artifacts, context packets, envelopes, and executor binding", async () => {
  const { db, run } = await plannedRun("新增 calc sum <numbers...>");
  const workflow = JSON.parse(db.prepare("select workflow_manifest_json from workflow_runs where id = ?").get(run.runId).workflow_manifest_json) as { tasks: Array<{ id: string }> };
  for (const task of workflow.tasks) getTaskEnvelope(db, { runId: run.runId, taskId: task.id });
  upsertRuntimeResource(db, { resourceType: "task_envelope", resourceKey: `env-${run.runId}`, runId: run.runId, scope: "task", status: "created", payload: { count: workflow.tasks.length } });
  upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: `artifact-${run.runId}`, runId: run.runId, scope: "task", status: "accepted", payload: { codePatch: "diff", testEvidence: true, readmeEvidence: true, evaluatorReport: true } });
  upsertRuntimeResource(db, { resourceType: "evaluator_result", resourceKey: `eval-${run.runId}`, runId: run.runId, scope: "software", status: "passed", payload: { ok: true } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: `stop-${run.runId}`, runId: run.runId, scope: "run", status: "passed", payload: { ok: true } });
  const gate = assertUiControlPlaneGates(db, { runId: run.runId, visitedPages: ["planner", "workflow", "runtime", "task", "sessions", "worktree", "executor", "domain-packs", "governance"] });
  assert.equal(gate.ok, true, gate.failures.join("\n"));
});

async function plannedRun(goalPrompt: string) {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, { goalPrompt, plannerClient: unusedPlanner() });
  const run = await createRunFromDraft(db, { draftId: draft.draftId, executorProvider: executorProvider() });
  return { db, run };
}

function firstMakerTaskId(db: ReturnType<typeof openSouthstarDb>, runId: string): string {
  const row = db.prepare("select workflow_manifest_json from workflow_runs where id = ?").get(runId) as { workflow_manifest_json: string };
  const workflow = JSON.parse(row.workflow_manifest_json) as { tasks: Array<{ id: string; roleRef?: string }> };
  return workflow.tasks.find((task) => task.roleRef === "maker")?.id ?? workflow.tasks[1]?.id ?? workflow.tasks[0]!.id;
}

function plannerClient(): PiPlannerClient {
  return { generate: async () => "{}" };
}

function unusedPlanner(): PiPlannerClient {
  return { generate: async () => { throw new Error("domain generator should handle software prompt"); } };
}

function executorProvider(): ExecutorProvider {
  return { executorType: "tork", async submit() { return { executorType: "tork", externalJobId: "job-contract", status: "queued", providerPayload: { torkJobId: "job-contract" } }; } };
}

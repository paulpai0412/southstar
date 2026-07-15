import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleSouthstarMcpMessage } from "../../src/v2/mcp/server.ts";
import { createSouthstarMcpToolRegistry } from "../../src/v2/mcp/tool-registry.ts";

const root = join(import.meta.dirname, "../..");

test("createSouthstarMcpToolRegistry exposes workflow and system tools", () => {
  const registry = createSouthstarMcpToolRegistry({ client: fakeClient() });
  assert.deepEqual(registry.listTools().map((tool) => tool.name), [
    "southstar.system.status",
    "southstar.system.loops",
    "southstar.system.tick_loop",
    "southstar.system.wake",
    "southstar.library.get_workspace",
    "southstar.library.get_graph",
    "southstar.library.import_from_source",
    "southstar.library.install_import_candidates",
    "southstar.library.install_import_candidates_stream",
    "southstar.library.get_object",
    "southstar.library.set_object_lifecycle",
    "southstar.library.list_files",
    "southstar.library.get_file",
    "southstar.library.update_file",
    "southstar.library.validate_file",
    "southstar.library.sync_file",
    "southstar.library.compose_profile",
    "southstar.library.validate_profile",
    "southstar.library.save_profile",
    "southstar.workflow.create_draft",
    "southstar.workflow.create_draft_stream",
    "southstar.workflow.run_goal",
    "southstar.workflow.revise_requirement",
    "southstar.workflow.confirm_requirements",
    "southstar.workflow.search_templates",
    "southstar.workflow.get_template",
    "southstar.workflow.instantiate_template",
    "southstar.workflow.revise_draft",
    "southstar.workflow.revise_draft_stream",
    "southstar.workflow.get_draft",
    "southstar.workflow.list_proposals",
    "southstar.workflow.approve_proposal",
    "southstar.workflow.reject_proposal",
    "southstar.workflow.convert_proposal_to_library_draft",
    "southstar.workflow.save_template",
    "southstar.workflow.run_draft",
    "southstar.workflow.inspect_run",
    "southstar.workflow.get_artifact",
    "southstar.runtime.get_read_model",
    "southstar.runtime.get_task_envelope",
    "southstar.runtime.get_run_actions",
    "southstar.runtime.control_run",
    "southstar.runtime.get_task_actions",
    "southstar.runtime.recover_task",
    "southstar.runtime.list_artifacts",
    "southstar.runtime.list_sessions",
    "southstar.runtime.get_session_events",
    "southstar.runtime.get_session_checkpoints",
    "southstar.runtime.search_memory",
    "southstar.runtime.list_memory",
    "southstar.runtime.list_memory_deltas",
    "southstar.runtime.decide_memory_delta",
    "southstar.runtime.list_executions",
    "southstar.runtime.get_execution",
    "southstar.runtime.reconcile_executor_job",
    "southstar.runtime.cancel_executor_job",
    "southstar.runtime.list_logs",
    "southstar.runtime.list_approvals",
    "southstar.runtime.decide_approval",
    "southstar.runtime.approve_recovery_decision",
    "southstar.runtime.apply_recovery_decision",
    "southstar.runtime.steer_run",
    "southstar.runtime.stream_run_events",
  ]);
});

test("MCP registry tools unwrap runtime client envelopes", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  const registry = createSouthstarMcpToolRegistry({ client: fakeClient(calls) });

  const search = await registry.callTool("southstar.workflow.search_templates", {
    prompt: "software workflow",
    domain: "software",
    limit: 2,
  });
  assert.deepEqual(search.structuredContent, { templates: [{ templateRef: "template.software" }] });

  const goal = await registry.callTool("southstar.workflow.run_goal", {
    goalPrompt: "build a vocabulary app",
    cwd: "/workspace/project",
    idempotencyKey: "goal-1",
  });
  assert.equal((goal.structuredContent as { runId?: string }).runId, "run-goal-a");
  assert.equal((goal.structuredContent as { goalRequirements?: { type?: string } }).goalRequirements?.type, "goalRequirements");
  assert.equal((goal.structuredContent as { goalDesign?: { type?: string } }).goalDesign?.type, "goalDesign");

  await registry.callTool("southstar.workflow.revise_requirement", {
    draftId: "draft-goal-a",
    requirementId: "requirement-a",
    expectedDraftHash: "req-hash-a",
    patch: { title: "Updated requirement" },
    actor: "pi-agent",
  });
  await registry.callTool("southstar.workflow.confirm_requirements", {
    draftId: "draft-goal-a",
    expectedDraftHash: "req-hash-a",
    actor: "pi-agent",
  });

  await registry.callTool("southstar.workflow.get_template", { templateRef: "template.software" });
  await registry.callTool("southstar.workflow.instantiate_template", {
    templateRef: "template.software",
    goalPrompt: "build vocabulary app",
    constraints: { mode: "strict" },
  });
  await registry.callTool("southstar.workflow.get_draft", { draftId: "draft-a" });
  await registry.callTool("southstar.workflow.run_draft", { draftId: "draft-a" });
  await registry.callTool("southstar.workflow.inspect_run", { runId: "run-a", taskId: "task-a" });
  await registry.callTool("southstar.workflow.get_artifact", { artifactRef: "artifact-a" });
  await registry.callTool("southstar.system.status", {});
  await registry.callTool("southstar.system.tick_loop", { loopId: "runnable-task-scheduler" });
  await registry.callTool("southstar.system.wake", { runId: "run-a", taskId: "task-a" });
  await registry.callTool("southstar.library.get_graph", { scope: "software", objectKey: "agent.frontend", depth: 1 });
  await registry.callTool("southstar.library.import_from_source", {
    source: { kind: "github", url: "https://github.com/example/skills" },
    scope: "software",
    requestPrompt: "import skills",
  });
  await registry.callTool("southstar.library.install_import_candidates", {
    draftId: "draft-lib",
    selectedCandidateIds: ["candidate-a"],
    actor: "pi-agent",
    reason: "install candidates",
  });
  await registry.callTool("southstar.library.set_object_lifecycle", {
    objectKey: "agent.frontend",
    action: "approve",
    actor: "pi-agent",
    reason: "approve",
  });
  await registry.callTool("southstar.workflow.create_draft", { goalPrompt: "build app", orchestrationMode: "llm-constrained" });
  await registry.callTool("southstar.workflow.revise_draft", { draftId: "draft-a", prompt: "add verifier" });
  await registry.callTool("southstar.workflow.save_template", { draftId: "draft-a", templateId: "template.saved", title: "Saved", scope: "software" });
  await registry.callTool("southstar.runtime.get_read_model", { kind: "run-control", runId: "run-a" });
  await registry.callTool("southstar.runtime.control_run", {
    runId: "run-a",
    action: "pause",
    commandId: "cmd-pause",
    reason: "operator pause",
  });
  await registry.callTool("southstar.runtime.recover_task", {
    runId: "run-a",
    taskId: "task-a",
    action: "retry",
    commandId: "cmd-retry",
    reason: "retry task",
  });
  await registry.callTool("southstar.runtime.decide_memory_delta", {
    action: "approve",
    deltaId: "delta-a",
    actor: "pi-agent",
    reason: "useful memory",
  });
  await registry.callTool("southstar.runtime.cancel_executor_job", {
    runId: "run-a",
    jobId: "job-a",
    commandId: "cmd-cancel-job",
    reason: "cancel stuck job",
  });
  await registry.callTool("southstar.runtime.decide_approval", {
    runId: "run-a",
    approvalId: "approval-a",
    decision: "approved",
    reason: "approved by prompt",
  });
  await registry.callTool("southstar.runtime.steer_run", { runId: "run-a", message: "focus on tests" });

  assert.deepEqual(calls, [
    { method: "searchWorkflowTemplates", body: { prompt: "software workflow", domain: "software", limit: 2 } },
    {
      method: "runGoalStream",
      body: {
        goalPrompt: "build a vocabulary app",
        cwd: "/workspace/project",
        idempotencyKey: "goal-1",
        goalDesignMode: "auto_until_blocked",
        templatePolicy: { mode: "auto" },
      },
    },
    { method: "getPlannerDraftOrchestration", body: "draft-goal-a" },
    { method: "reviseGoalRequirement", body: { draftId: "draft-goal-a", requirementId: "requirement-a", expectedDraftHash: "req-hash-a", patch: { title: "Updated requirement" }, actor: "pi-agent" } },
    { method: "confirmGoalRequirements", body: { draftId: "draft-goal-a", expectedDraftHash: "req-hash-a", actor: "pi-agent" } },
    { method: "getWorkflowTemplate", body: "template.software" },
    { method: "instantiateWorkflowTemplate", body: { templateRef: "template.software", goalPrompt: "build vocabulary app", constraints: { mode: "strict" } } },
    { method: "getPlannerDraftOrchestration", body: "draft-a" },
    { method: "createRunFromPlannerDraft", body: "draft-a" },
    { method: "getTask", body: { runId: "run-a", taskId: "task-a" } },
    { method: "getArtifact", body: { artifactRef: "artifact-a" } },
    { method: "getRuntimeHealth" },
    { method: "tickRuntimeLoop", body: { loopId: "runnable-task-scheduler" } },
    { method: "wakeRuntime", body: { runId: "run-a", taskId: "task-a" } },
    { method: "getLibraryGraph", body: { scope: "software", objectKey: "agent.frontend", depth: 1 } },
    { method: "createLibraryImportDraft", body: { source: { kind: "github", url: "https://github.com/example/skills" }, scope: "software", requestPrompt: "import skills" } },
    { method: "installLibraryImportCandidates", body: { draftId: "draft-lib", selectedCandidateIds: ["candidate-a"], actor: "pi-agent", reason: "install candidates" } },
    { method: "setLibraryObjectLifecycle", body: { objectKey: "agent.frontend", action: "approve", actor: "pi-agent", reason: "approve" } },
    { method: "createPlannerDraft", body: { goalPrompt: "build app", orchestrationMode: "llm-constrained" } },
    { method: "revisePlannerDraft", body: { draftId: "draft-a", prompt: "add verifier" } },
    { method: "saveWorkflowTemplate", body: { draftId: "draft-a", templateId: "template.saved", title: "Saved", scope: "software" } },
    { method: "getReadModel", body: { kind: "run-control", runId: "run-a" } },
    { method: "pauseRun", body: { runId: "run-a", commandId: "cmd-pause", actor: { type: "user", id: "pi-agent" }, reason: "operator pause" } },
    { method: "retryTask", body: { runId: "run-a", taskId: "task-a", commandId: "cmd-retry", actor: { type: "user", id: "pi-agent" }, reason: "retry task" } },
    { method: "approveMemoryDelta", body: { deltaId: "delta-a", approvedBy: "pi-agent", reason: "useful memory" } },
    { method: "cancelExecutorJob", body: { runId: "run-a", jobId: "job-a", commandId: "cmd-cancel-job", actor: { type: "user", id: "pi-agent" }, reason: "cancel stuck job" } },
    { method: "decideApproval", body: { runId: "run-a", approvalId: "approval-a", decision: "approved", reason: "approved by prompt" } },
    { method: "steerRun", body: { runId: "run-a", message: "focus on tests" } },
  ]);
});

test("package exposes southstar-mcp bin entry", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> };
  assert.equal(packageJson.bin?.["southstar-mcp"], "src/v2/mcp/server.ts");
});

test("JSON-RPC tools/list returns expanded Southstar MCP tools", async () => {
  const registry = createSouthstarMcpToolRegistry({ client: fakeClient() });
  const response = await handleSouthstarMcpMessage(registry, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  assert.equal(response?.jsonrpc, "2.0");
  assert.equal(response?.id, 1);
  const result = response?.result as { tools?: Array<{ name: string }> };
  assert.ok(result.tools?.some((tool) => tool.name === "southstar.library.import_from_source"));
  assert.ok(result.tools?.some((tool) => tool.name === "southstar.runtime.recover_task"));
});

test("JSON-RPC tools/call bridges streaming events into MCP progress notifications", async () => {
  const registry = createSouthstarMcpToolRegistry({ client: fakeClient() });
  const notifications: unknown[] = [];
  const response = await handleSouthstarMcpMessage(
    registry,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "southstar.workflow.create_draft_stream",
        arguments: {
          goalPrompt: "build streaming feedback",
          orchestrationMode: "llm-constrained",
        },
        _meta: { progressToken: "progress-1" },
      },
    },
    { onNotification: (notification) => notifications.push(notification) },
  );

  assert.equal(response?.id, 2);
  assert.equal((response?.result as { structuredContent?: { draft?: { draftId?: string } } }).structuredContent?.draft?.draftId, "draft-stream");
  assert.deepEqual(notifications.map((notification) => (notification as { method?: string }).method), [
    "notifications/progress",
    "notifications/progress",
    "notifications/progress",
  ]);
  assert.deepEqual((notifications[0] as { params?: unknown }).params, {
    progressToken: "progress-1",
    progress: 1,
    message: "planner.stage: Requirement analysis completed.",
    data: { event: "planner.stage", data: { stage: "requirement.analyzed", message: "Requirement analysis completed." } },
  });
});

function fakeClient(calls: Array<{ method: string; body?: unknown }> = []) {
  const record = (method: string, result: unknown = {}, body?: unknown) => {
    calls.push(body === undefined ? { method } : { method, body });
    return envelope(method, result);
  };
  return {
    getRuntimeHealth: async () => record("getRuntimeHealth", { ok: true }),
    getRuntimeLoops: async () => record("getRuntimeLoops"),
    tickRuntimeLoop: async (body: unknown) => record("tickRuntimeLoop", {}, body),
    wakeRuntime: async (body: unknown) => record("wakeRuntime", {}, body),
    getLibraryWorkspace: async (body: unknown) => record("getLibraryWorkspace", {}, body),
    getLibraryGraph: async (body: unknown) => record("getLibraryGraph", {}, body),
    createLibraryImportDraft: async (body: unknown) => record("createLibraryImportDraft", {}, body),
    installLibraryImportCandidates: async (body: unknown) => record("installLibraryImportCandidates", {}, body),
    installLibraryImportCandidatesStream: async (body: unknown, onEvent: (event: unknown) => void) => {
      calls.push({ method: "installLibraryImportCandidatesStream", body });
      onEvent({ event: "library.import.install.completed", data: { installed: 1 } });
      return { status: "installed" };
    },
    getLibraryObject: async (body: unknown) => record("getLibraryObject", {}, body),
    setLibraryObjectLifecycle: async (body: unknown) => record("setLibraryObjectLifecycle", {}, body),
    listLibraryFiles: async () => record("listLibraryFiles"),
    getLibraryFile: async (body: unknown) => record("getLibraryFile", {}, body),
    updateLibraryFile: async (body: unknown) => record("updateLibraryFile", {}, body),
    validateLibraryFile: async (body: unknown) => record("validateLibraryFile", {}, body),
    syncLibraryFile: async (body: unknown) => record("syncLibraryFile", {}, body),
    composeLibraryProfile: async (body: unknown) => record("composeLibraryProfile", {}, body),
    validateLibraryProfile: async (body: unknown) => record("validateLibraryProfile", {}, body),
    saveLibraryProfile: async (body: unknown) => record("saveLibraryProfile", {}, body),
    createPlannerDraft: async (body: unknown) => record("createPlannerDraft", {}, body),
    runGoalStream: async (body: unknown, onEvent: (event: unknown) => void) => {
      calls.push({ method: "runGoalStream", body });
      onEvent({ event: "goal_design", data: { draftId: "draft-goal-a", package: { slicePlan: { slices: [{ id: "slice-a" }] } } } });
      onEvent({ event: "goal_requirements", data: { draftId: "draft-goal-a" } });
      return {
        eventCount: 2,
        events: [
          { event: "goal_design", data: { draftId: "draft-goal-a", package: { slicePlan: { slices: [{ id: "slice-a" }] } } } },
          { event: "goal_requirements", data: { draftId: "draft-goal-a" } },
        ],
        result: {
          draftId: "draft-goal-a",
          draftStatus: "validated",
          goalDesignPackageHash: "pkg-a",
          goalRequirementDraftId: "req-a",
          goalRequirementDraftHash: "req-hash-a",
          goalRequirementDraft: {
            draftHash: "req-hash-a",
            requirements: [],
          },
          confirmable: true,
          blockers: [],
          validationIssues: [],
          runId: "run-goal-a",
        },
      };
    },
    createPlannerDraftStream: async (body: unknown, onEvent: (event: unknown) => void) => {
      calls.push({ method: "createPlannerDraftStream", body });
      onEvent({ event: "planner.stage", data: { stage: "requirement.analyzed", message: "Requirement analysis completed." } });
      onEvent({ event: "message.delta", data: { text: "delta" } });
      onEvent({ event: "draft", data: { draft: { draftId: "draft-stream" } } });
      return { draft: { draftId: "draft-stream" } };
    },
    revisePlannerDraft: async (body: unknown) => record("revisePlannerDraft", {}, body),
    reviseGoalRequirement: async (body: unknown) => record("reviseGoalRequirement", {}, body),
    confirmGoalRequirements: async (body: unknown) => record("confirmGoalRequirements", {}, body),
    revisePlannerDraftStream: async (body: unknown, onEvent: (event: unknown) => void) => {
      calls.push({ method: "revisePlannerDraftStream", body });
      onEvent({ event: "done", data: {} });
      return { draft: { draftId: "draft-revised-stream" } };
    },
    searchWorkflowTemplates: async (body: unknown) => record("searchWorkflowTemplates", { templates: [{ templateRef: "template.software" }] }, body),
    getWorkflowTemplate: async (body: unknown) => record("getWorkflowTemplate", { templateRef: body }, body),
    instantiateWorkflowTemplate: async (body: unknown) => record("instantiateWorkflowTemplate", { draftId: "draft-a" }, body),
    getPlannerDraftOrchestration: async (body: unknown) => record("getPlannerDraftOrchestration", { draftId: body }, body),
    listPlannerDraftProposals: async (body: unknown) => record("listPlannerDraftProposals", {}, body),
    approvePlannerDraftProposal: async (body: unknown) => record("approvePlannerDraftProposal", {}, body),
    rejectPlannerDraftProposal: async (body: unknown) => record("rejectPlannerDraftProposal", {}, body),
    convertPlannerDraftProposalToLibraryDraft: async (body: unknown) => record("convertPlannerDraftProposalToLibraryDraft", {}, body),
    saveWorkflowTemplate: async (body: unknown) => record("saveWorkflowTemplate", {}, body),
    createRunFromPlannerDraft: async (body: unknown) => record("createRunFromPlannerDraft", { runId: "run-a" }, body),
    getRun: async (body: unknown) => record("getRun", { runId: body }, body),
    getTask: async (body: unknown) => record("getTask", body, body),
    getReadModel: async (body: unknown) => record("getReadModel", {}, body),
    getTaskEnvelope: async (body: unknown) => record("getTaskEnvelope", {}, body),
    getRunActions: async (body: unknown) => record("getRunActions", {}, body),
    pauseRun: async (body: unknown) => record("pauseRun", {}, body),
    resumeRun: async (body: unknown) => record("resumeRun", {}, body),
    cancelRun: async (body: unknown) => record("cancelRun", {}, body),
    getTaskActions: async (body: unknown) => record("getTaskActions", {}, body),
    retryTask: async (body: unknown) => record("retryTask", {}, body),
    forkTaskSession: async (body: unknown) => record("forkTaskSession", {}, body),
    resetTaskSession: async (body: unknown) => record("resetTaskSession", {}, body),
    rollbackTaskSession: async (body: unknown) => record("rollbackTaskSession", {}, body),
    requestTaskRevision: async (body: unknown) => record("requestTaskRevision", {}, body),
    listArtifacts: async (body: unknown) => record("listArtifacts", {}, body),
    getArtifact: async (body: unknown) => record("getArtifact", { artifactRef: body }, body),
    listSessions: async (body: unknown) => record("listSessions", {}, body),
    getSessionEvents: async (body: unknown) => record("getSessionEvents", {}, body),
    getSessionCheckpoints: async (body: unknown) => record("getSessionCheckpoints", {}, body),
    searchMemory: async (body: unknown) => record("searchMemory", {}, body),
    listMemory: async (body: unknown) => record("listMemory", {}, body),
    listMemoryDeltas: async (body: unknown) => record("listMemoryDeltas", {}, body),
    approveMemoryDelta: async (body: unknown) => record("approveMemoryDelta", {}, body),
    rejectMemoryDelta: async (body: unknown) => record("rejectMemoryDelta", {}, body),
    listExecutions: async (body: unknown) => record("listExecutions", {}, body),
    getExecution: async (body: unknown) => record("getExecution", {}, body),
    reconcileExecutorJob: async (body: unknown) => record("reconcileExecutorJob", {}, body),
    cancelExecutorJob: async (body: unknown) => record("cancelExecutorJob", {}, body),
    listLogs: async (body: unknown) => record("listLogs", {}, body),
    listApprovals: async (body: unknown) => record("listApprovals", {}, body),
    decideApproval: async (body: unknown) => record("decideApproval", {}, body),
    approveRecoveryDecision: async (body: unknown) => record("approveRecoveryDecision", {}, body),
    applyRecoveryDecision: async (body: unknown) => record("applyRecoveryDecision", {}, body),
    steerRun: async (body: unknown) => record("steerRun", {}, body),
    streamRunEvents: async (body: unknown, onEvent: (event: unknown) => void) => {
      calls.push({ method: "streamRunEvents", body });
      onEvent({ event: "workflow_history", data: { eventType: "task.completed" } });
      return { status: "closed" };
    },
  };
}

function envelope(kind: string, result: unknown) {
  return { ok: true as const, kind, result };
}

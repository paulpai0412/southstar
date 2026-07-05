import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";
import type { ReadModelKind } from "../read-models/types.ts";
import type { RuntimeCommandRequest } from "../ui-api/commands/runtime-command.ts";

export type RuntimeServerClient = ReturnType<typeof createRuntimeServerClient>;

type RunGoalResult = {
  draft: { draftId: string; goalPrompt: string; workflowId: string };
  runId: string;
  taskIds: string[];
};

type PlannerRequestBody = {
  goalPrompt: string;
  orchestrationMode?: "llm-constrained";
  composerMode?: "llm";
  scope?: string;
};

type RunRuntimeCommandRequest = RuntimeCommandRequest & { runId: string };
type TaskRuntimeCommandRequest = RuntimeCommandRequest & { runId: string; taskId: string };
type GetSessionEventsRequest = {
  sessionId: string;
  afterSequence?: number;
  beforeSequence?: number;
  limit?: number;
  eventTypes?: string[];
  taskId?: string;
  correlationId?: string;
  artifactRef?: string;
  aroundEventId?: string;
  windowBefore?: number;
  windowAfter?: number;
};
type SearchMemoryRequest = {
  runId: string;
  query: string;
  scopes: string[];
  allowedKinds: string[];
  maxCandidates?: number;
};
type SearchWorkflowTemplatesRequest = {
  prompt: string;
  domain?: string;
  limit?: number;
};
type InstantiateWorkflowTemplateRequest = {
  templateRef: string;
  goalPrompt: string;
  cwd?: string;
  repo?: {
    path?: string;
    url?: string;
    branch?: string;
  };
  constraints?: {
    mode?: "strict" | "adaptive";
    maxNodes?: number;
    requireApproval?: boolean;
  };
};
type RuntimeLoopId =
  | "executor-reconciler"
  | "runnable-task-scheduler"
  | "recovery-controller"
  | "tork-exception-observer"
  | "recovery-decision-applier";

export function createRuntimeServerClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    runGoal(body: PlannerRequestBody) {
      return post<RunGoalResult>(`${baseUrl}/api/v2/run-goal`, body);
    },
    createPlannerDraft(body: PlannerRequestBody) {
      return post(`${baseUrl}/api/v2/planner/drafts`, body);
    },
    createRun(body: { draftId: string }) {
      return post(`${baseUrl}/api/v2/runs`, body);
    },
    getPlannerDraftOrchestration(draftId: string) {
      return get(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/orchestration`);
    },
    createRunFromPlannerDraft(draftId: string) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/runs`, {});
    },
    patchPlannerDraftTaskProfileOverride(draftId: string, taskId: string, profileOverride: unknown) {
      return patch(
        `${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/tasks/${encodeURIComponent(taskId)}/profile-override`,
        profileOverride,
      );
    },
    listPlannerDraftProposals(draftId: string) {
      return get(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/proposals`);
    },
    approvePlannerDraftProposal(body: { draftId: string; proposalId: string; actorId?: string; reason?: string }) {
      return post(
        `${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/proposals/${encodeURIComponent(body.proposalId)}/approve`,
        { ...(body.actorId !== undefined ? { actorId: body.actorId } : {}), ...(body.reason !== undefined ? { reason: body.reason } : {}) },
      );
    },
    rejectPlannerDraftProposal(body: { draftId: string; proposalId: string; actorId?: string; reason?: string }) {
      return post(
        `${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/proposals/${encodeURIComponent(body.proposalId)}/reject`,
        { ...(body.actorId !== undefined ? { actorId: body.actorId } : {}), ...(body.reason !== undefined ? { reason: body.reason } : {}) },
      );
    },
    convertPlannerDraftProposalToLibraryDraft(body: { draftId: string; proposalId: string; actorId?: string; reason?: string }) {
      return post(
        `${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/proposals/${encodeURIComponent(body.proposalId)}/convert-to-library-draft`,
        { ...(body.actorId !== undefined ? { actorId: body.actorId } : {}), ...(body.reason !== undefined ? { reason: body.reason } : {}) },
      );
    },
    searchWorkflowTemplates(body: SearchWorkflowTemplatesRequest) {
      const query = new URLSearchParams();
      query.set("prompt", body.prompt);
      setOptionalQueryString(query, "domain", body.domain);
      setOptionalQueryNumber(query, "limit", body.limit);
      return get(`${baseUrl}/api/v2/workflow/templates/search?${query.toString()}`);
    },
    getWorkflowTemplate(templateRef: string) {
      return get(`${baseUrl}/api/v2/workflow/templates/${encodeURIComponent(templateRef)}`);
    },
    instantiateWorkflowTemplate(body: InstantiateWorkflowTemplateRequest) {
      return post(`${baseUrl}/api/v2/workflow/templates/instantiate`, body);
    },
    getArtifact(body: { artifactRef: string }) {
      return get(`${baseUrl}/api/v2/artifacts/${encodeURIComponent(body.artifactRef)}`);
    },
    getRun(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}`);
    },
    getRunActions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/actions`);
    },
    getRunEvents(body: { runId: string; afterSequence?: number }) {
      const after = body.afterSequence ?? 0;
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/events?after=${encodeURIComponent(String(after))}`);
    },
    listTasks(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/tasks`);
    },
    getTask(body: { runId: string; taskId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}`);
    },
    getTaskActions(body: { runId: string; taskId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/actions`);
    },
    retryTask(body: TaskRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/retry`, runtimeCommandBody(body));
    },
    forkTaskSession(body: TaskRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/fork-session`, runtimeCommandBody(body));
    },
    resetTaskSession(body: TaskRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/reset-session`, runtimeCommandBody(body));
    },
    rollbackTaskSession(body: TaskRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/rollback-session`, runtimeCommandBody(body));
    },
    requestTaskRevision(body: TaskRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/request-revision`, runtimeCommandBody(body));
    },
    listArtifacts(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/artifacts`);
    },
    listSessions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/sessions`);
    },
    getSessionEvents(body: GetSessionEventsRequest) {
      const query = new URLSearchParams();
      setOptionalQueryNumber(query, "afterSequence", body.afterSequence);
      setOptionalQueryNumber(query, "beforeSequence", body.beforeSequence);
      setOptionalQueryNumber(query, "limit", body.limit);
      if (body.eventTypes?.length) query.set("eventTypes", body.eventTypes.join(","));
      setOptionalQueryString(query, "taskId", body.taskId);
      setOptionalQueryString(query, "correlationId", body.correlationId);
      setOptionalQueryString(query, "artifactRef", body.artifactRef);
      setOptionalQueryString(query, "aroundEventId", body.aroundEventId);
      setOptionalQueryNumber(query, "windowBefore", body.windowBefore);
      setOptionalQueryNumber(query, "windowAfter", body.windowAfter);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(body.sessionId)}/events${suffix}`);
    },
    getSessionCheckpoints(sessionId: string) {
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
    },
    getSessionCheckpoint(body: { sessionId: string; checkpointId: string }) {
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(body.sessionId)}/checkpoints/${encodeURIComponent(body.checkpointId)}`);
    },
    getSessionLineage(sessionId: string) {
      return get(`${baseUrl}/api/v2/sessions/${encodeURIComponent(sessionId)}/lineage`);
    },
    listMemory(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/memory`);
    },
    listMemoryDeltas(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/memory-deltas`);
    },
    approveMemoryDelta(body: { deltaId: string; approvedBy: string; reason: string }) {
      return post(`${baseUrl}/api/v2/memory-deltas/${encodeURIComponent(body.deltaId)}/approve`, { approvedBy: body.approvedBy, reason: body.reason });
    },
    rejectMemoryDelta(body: { deltaId: string; rejectedBy: string; reason: string }) {
      return post(`${baseUrl}/api/v2/memory-deltas/${encodeURIComponent(body.deltaId)}/reject`, { rejectedBy: body.rejectedBy, reason: body.reason });
    },
    invalidateRunMemory(body: { runId: string; sourceRefs: string[]; reason: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/memory/invalidate`, { sourceRefs: body.sourceRefs, reason: body.reason });
    },
    searchMemory(body: SearchMemoryRequest) {
      const query = new URLSearchParams();
      query.set("runId", body.runId);
      query.set("query", body.query);
      query.set("scopes", body.scopes.join(","));
      query.set("allowedKinds", body.allowedKinds.join(","));
      setOptionalQueryNumber(query, "maxCandidates", body.maxCandidates);
      return get(`${baseUrl}/api/v2/memory/search?${query.toString()}`);
    },
    listExecutions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/hand-executions`);
    },
    getExecution(body: { runId: string; executionId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/hand-executions/${encodeURIComponent(body.executionId)}`);
    },
    getExecutorJobActions(body: { runId: string; jobId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/executor-jobs/${encodeURIComponent(body.jobId)}/actions`);
    },
    reconcileExecutorJob(body: { runId: string; jobId: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/executor-jobs/${encodeURIComponent(body.jobId)}/reconcile`, {});
    },
    cancelExecutorJob(body: RuntimeCommandRequest & { runId: string; jobId: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/executor-jobs/${encodeURIComponent(body.jobId)}/cancel`, runtimeCommandBody(body));
    },
    listLogs(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/logs`);
    },
    listApprovals(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/approvals`);
    },
    decideApproval(body: { runId: string; approvalId: string; decision: "approved" | "rejected"; reason: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/approvals/${encodeURIComponent(body.approvalId)}/decision`, { decision: body.decision, reason: body.reason });
    },
    approveRecoveryDecision(body: { runId: string; decisionId: string; decision: "approved" | "rejected"; reason: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/recovery-decisions/${encodeURIComponent(body.decisionId)}/approval`, {
        decision: body.decision,
        reason: body.reason,
      });
    },
    applyRecoveryDecision(body: { runId: string; decisionId: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/recovery-decisions/${encodeURIComponent(body.decisionId)}/apply`, {});
    },
    steerRun(body: { runId: string; message: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/steering`, { message: body.message });
    },
    voiceCommand(body: { runId: string; transcript: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/voice-command`, { transcript: body.transcript });
    },
    getReadModel(body: { kind: ReadModelKind; runId: string; taskId?: string }) {
      const suffix = body.kind === "task-detail"
        ? `${encodeURIComponent(body.runId)}/${encodeURIComponent(requiredTaskId(body.taskId))}`
        : encodeURIComponent(body.runId);
      return get(`${baseUrl}/api/v2/read-models/${encodeURIComponent(body.kind)}/${suffix}`);
    },
    getTaskEnvelope(body: { runId: string; taskId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/envelope`);
    },
    getUiPlanner(draftId?: string) {
      const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
      return get(`${baseUrl}/api/v2/ui/planner${query}`);
    },
    getUiWorkflowCanvas(body: { runId: string; taskId?: string }) {
      const task = body.taskId ? `&taskId=${encodeURIComponent(body.taskId)}` : "";
      return get(`${baseUrl}/api/v2/ui/workflow-canvas?runId=${encodeURIComponent(body.runId)}${task}`);
    },
    getUiRuntimeMonitor(runId: string) {
      return get(`${baseUrl}/api/v2/ui/runtime-monitor?runId=${encodeURIComponent(runId)}`);
    },
    pauseRun(body: RunRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/pause`, runtimeCommandBody(body));
    },
    resumeRun(body: RunRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/resume`, runtimeCommandBody(body));
    },
    cancelRun(body: RunRuntimeCommandRequest) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/cancel`, runtimeCommandBody(body));
    },
    getRuntimeHealth() {
      return get(`${baseUrl}/api/v2/runtime/health`);
    },
    getRuntimeLoops() {
      return get(`${baseUrl}/api/v2/runtime/loops`);
    },
    tickRuntimeLoop(body: { loopId: RuntimeLoopId }) {
      return post(`${baseUrl}/api/v2/runtime/loops/${encodeURIComponent(body.loopId)}/tick`, {});
    },
    wakeRuntime(body: { runId?: string; taskId?: string } = {}) {
      return post(`${baseUrl}/api/v2/runtime/wake`, body);
    },
    submitTorkCallback(body: unknown) {
      return post(`${baseUrl}/api/v2/tork/callback`, body);
    },
  };
}

function requiredTaskId(taskId: string | undefined): string {
  if (!taskId) throw new Error("taskId is required for task-detail read model");
  return taskId;
}

function runtimeCommandBody(body: RuntimeCommandRequest): RuntimeCommandRequest {
  return {
    commandId: body.commandId,
    actor: body.actor,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
    ...(body.payload !== undefined ? { payload: body.payload } : {}),
  };
}

function setOptionalQueryNumber(query: URLSearchParams, key: string, value: number | undefined): void {
  if (value !== undefined) query.set(key, String(value));
}

function setOptionalQueryString(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) query.set(key, value);
}

async function post<T = unknown>(url: string, body: unknown): Promise<ApiEnvelope<T>> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return readJson(response);
}

async function patch<T = unknown>(url: string, body: unknown): Promise<ApiEnvelope<T>> {
  const response = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return readJson(response);
}

async function get<T = unknown>(url: string): Promise<ApiEnvelope<T>> {
  return readJson(await fetch(url));
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = await response.json() as ApiEnvelope<T> | ApiErrorEnvelope;
  if (payload.ok === false) throw new Error(payload.error);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return payload;
}

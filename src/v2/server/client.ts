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
type LibraryGraphRequest = {
  scope?: string;
  objectKey?: string;
  depth?: number;
  kind?: string;
  status?: string;
  edgeType?: string;
};
type LibraryImportDraftRequest = {
  source: unknown;
  scope?: string;
  requestPrompt?: string;
};
type LibraryImportInstallRequest = {
  draftId: string;
  selectedCandidateIds: string[];
  selectedEdgeIds?: string[];
  actor?: string;
  reason: string;
};
type LibraryObjectLifecycleRequest = {
  objectKey: string;
  action: "approve" | "deprecate" | "block";
  actor?: string;
  reason: string;
};
type LibraryProfileComposeRequest = {
  scope?: string;
  nodeId: string;
  requirement: string;
  preferredAgentRef: string;
  templateId?: string;
};
type LibraryProfileValidateRequest = {
  profile?: unknown;
  draft?: unknown;
};
type LibraryProfileSaveRequest = {
  draft: unknown;
  templateId: string;
  actor?: string;
  reason: string;
};
type RevisePlannerDraftRequest = {
  draftId: string;
  prompt: string;
  orchestrationMode?: "llm-constrained";
  composerMode?: "llm";
};
type SaveWorkflowTemplateRequest = {
  draftId: string;
  templateId: string;
  title: string;
  scope?: string;
  status?: "draft" | "approved";
};
type RuntimeSseEvent = {
  event: string;
  data: unknown;
  id?: string;
};
type RuntimeSseListener = (event: RuntimeSseEvent) => void;
type StreamRunEventsRequest = {
  runId: string;
  after?: number;
  taskId?: string;
  includeRunEvents?: boolean;
  closeOnTerminal?: boolean;
  pollMs?: number;
  heartbeatMs?: number;
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
    createPlannerDraftStream(body: PlannerRequestBody & { cwd?: string }, onEvent: RuntimeSseListener, signal?: AbortSignal) {
      return postSse(`${baseUrl}/api/v2/planner/drafts/stream`, body, onEvent, signal);
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
    getLibraryWorkspace(body: { scope?: string } = {}) {
      const query = new URLSearchParams();
      setOptionalQueryString(query, "scope", body.scope);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return get(`${baseUrl}/api/v2/library/workspace${suffix}`);
    },
    getLibraryGraph(body: LibraryGraphRequest = {}) {
      const query = new URLSearchParams();
      setOptionalQueryString(query, "scope", body.scope);
      setOptionalQueryString(query, "objectKey", body.objectKey);
      setOptionalQueryNumber(query, "depth", body.depth);
      setOptionalQueryString(query, "kind", body.kind);
      setOptionalQueryString(query, "status", body.status);
      setOptionalQueryString(query, "edgeType", body.edgeType);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return get(`${baseUrl}/api/v2/library/graph${suffix}`);
    },
    createLibraryImportDraft(body: LibraryImportDraftRequest) {
      return post(`${baseUrl}/api/v2/library/import-drafts`, body);
    },
    installLibraryImportCandidates(body: LibraryImportInstallRequest) {
      return post(`${baseUrl}/api/v2/library/import-drafts/${encodeURIComponent(body.draftId)}/install`, {
        selectedCandidateIds: body.selectedCandidateIds,
        ...(body.selectedEdgeIds !== undefined ? { selectedEdgeIds: body.selectedEdgeIds } : {}),
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
        reason: body.reason,
      });
    },
    installLibraryImportCandidatesStream(body: LibraryImportInstallRequest, onEvent: RuntimeSseListener, signal?: AbortSignal) {
      return postSse(`${baseUrl}/api/v2/library/import-drafts/${encodeURIComponent(body.draftId)}/install/stream`, {
        selectedCandidateIds: body.selectedCandidateIds,
        ...(body.selectedEdgeIds !== undefined ? { selectedEdgeIds: body.selectedEdgeIds } : {}),
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
        reason: body.reason,
      }, onEvent, signal);
    },
    getLibraryObject(objectKey: string) {
      return get(`${baseUrl}/api/v2/library/objects/${encodeURIComponent(objectKey)}`);
    },
    setLibraryObjectLifecycle(body: LibraryObjectLifecycleRequest) {
      return post(`${baseUrl}/api/v2/library/objects/${encodeURIComponent(body.objectKey)}/${body.action}`, {
        ...(body.actor !== undefined ? { actor: body.actor } : {}),
        reason: body.reason,
      });
    },
    listLibraryFiles() {
      return get(`${baseUrl}/api/v2/library/files`);
    },
    getLibraryFile(relativePath: string) {
      return get(`${baseUrl}/api/v2/library/files/${encodeURIComponent(relativePath)}`);
    },
    updateLibraryFile(body: { relativePath: string; content: string }) {
      return patch(`${baseUrl}/api/v2/library/files/${encodeURIComponent(body.relativePath)}`, { content: body.content });
    },
    validateLibraryFile(relativePath: string) {
      return post(`${baseUrl}/api/v2/library/files/${encodeURIComponent(relativePath)}/validate`, {});
    },
    syncLibraryFile(relativePath: string) {
      return post(`${baseUrl}/api/v2/library/files/${encodeURIComponent(relativePath)}/sync`, {});
    },
    composeLibraryProfile(body: LibraryProfileComposeRequest) {
      return post(`${baseUrl}/api/v2/library/profile-drafts/compose`, body);
    },
    validateLibraryProfile(body: LibraryProfileValidateRequest) {
      return post(`${baseUrl}/api/v2/library/profile-drafts/validate`, body);
    },
    saveLibraryProfile(body: LibraryProfileSaveRequest) {
      return post(`${baseUrl}/api/v2/library/profile-drafts/save`, body);
    },
    revisePlannerDraft(body: RevisePlannerDraftRequest) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/revise`, {
        prompt: body.prompt,
        ...(body.orchestrationMode !== undefined ? { orchestrationMode: body.orchestrationMode } : {}),
        ...(body.composerMode !== undefined ? { composerMode: body.composerMode } : {}),
      });
    },
    revisePlannerDraftStream(body: RevisePlannerDraftRequest, onEvent: RuntimeSseListener, signal?: AbortSignal) {
      return postSse(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/revise/stream`, {
        prompt: body.prompt,
        ...(body.orchestrationMode !== undefined ? { orchestrationMode: body.orchestrationMode } : {}),
        ...(body.composerMode !== undefined ? { composerMode: body.composerMode } : {}),
      }, onEvent, signal);
    },
    saveWorkflowTemplate(body: SaveWorkflowTemplateRequest) {
      return post(`${baseUrl}/api/v2/workflow/drafts/${encodeURIComponent(body.draftId)}/save-template`, {
        templateId: body.templateId,
        title: body.title,
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
    },
    getRun(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}`);
    },
    getRunActions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/actions`);
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
    streamRunEvents(body: StreamRunEventsRequest, onEvent: RuntimeSseListener, signal?: AbortSignal) {
      const query = new URLSearchParams();
      setOptionalQueryNumber(query, "after", body.after);
      setOptionalQueryString(query, "taskId", body.taskId);
      if (body.includeRunEvents !== undefined) query.set("includeRunEvents", String(body.includeRunEvents));
      if (body.closeOnTerminal !== undefined) query.set("closeOnTerminal", String(body.closeOnTerminal));
      setOptionalQueryNumber(query, "pollMs", body.pollMs);
      setOptionalQueryNumber(query, "heartbeatMs", body.heartbeatMs);
      const suffix = query.toString() ? `?${query.toString()}` : "";
      return getSse(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/events/stream${suffix}`, onEvent, signal);
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

async function postSse(url: string, body: unknown, onEvent: RuntimeSseListener, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  return readSse(response, onEvent);
}

async function getSse(url: string, onEvent: RuntimeSseListener, signal?: AbortSignal): Promise<unknown> {
  return readSse(await fetch(url, { signal }), onEvent);
}

async function readSse(response: Response, onEvent: RuntimeSseListener): Promise<unknown> {
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  if (!response.body) return { events: [] };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: RuntimeSseEvent[] = [];
  let streamError: unknown;
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    buffer = drainSseFrames(buffer, (event) => {
      events.push(event);
      if (event.event === "error") streamError = event.data;
      onEvent(event);
    });
  }
  buffer += decoder.decode();
  drainSseFrames(`${buffer}\n\n`, (event) => {
    events.push(event);
    if (event.event === "error") streamError = event.data;
    onEvent(event);
  });
  if (streamError !== undefined) throw new Error(errorMessageFromSseData(streamError));
  return summarizeSseEvents(events);
}

function drainSseFrames(buffer: string, emit: (event: RuntimeSseEvent) => void): string {
  let remaining = buffer;
  while (true) {
    const index = remaining.indexOf("\n\n");
    if (index < 0) return remaining;
    const frame = remaining.slice(0, index);
    remaining = remaining.slice(index + 2);
    const parsed = parseSseFrame(frame);
    if (parsed) emit(parsed);
  }
}

function parseSseFrame(frame: string): RuntimeSseEvent | null {
  const lines = frame.split(/\r?\n/);
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("id:")) id = line.slice("id:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0 && !id) return null;
  const dataText = dataLines.join("\n");
  let data: unknown = dataText;
  if (dataText.length > 0) {
    try {
      data = JSON.parse(dataText);
    } catch {
      data = dataText;
    }
  }
  return { event, data, ...(id ? { id } : {}) };
}

function summarizeSseEvents(events: RuntimeSseEvent[]): Record<string, unknown> {
  const sampledEvents = summarizeVisibleSseEvents(events);
  const result: Record<string, unknown> = {
    eventCount: events.length,
    events: sampledEvents,
    truncatedEvents: events.length > sampledEvents.length,
  };
  for (const event of events) {
    if (event.event === "draft" && isRecord(event.data) && event.data.draft !== undefined) result.draft = event.data.draft;
    if (event.event === "orchestration" && isRecord(event.data) && event.data.orchestration !== undefined) result.orchestration = event.data.orchestration;
    if (event.event === "error") result.error = event.data;
    if (event.event === "done") result.done = true;
  }
  return result;
}

function summarizeVisibleSseEvents(events: RuntimeSseEvent[]): RuntimeSseEvent[] {
  const nonDeltaEvents = events.filter((event) => event.event !== "message.delta");
  const deltaText = events
    .filter((event) => event.event === "message.delta" && isRecord(event.data) && typeof event.data.text === "string")
    .map((event) => (event.data as { text: string }).text)
    .join("");
  const deltaPreview = deltaText.length > 0
    ? [{
        event: "message.delta.summary",
        data: {
          characterCount: deltaText.length,
          preview: deltaText.slice(0, 2000),
          truncated: deltaText.length > 2000,
        },
      } satisfies RuntimeSseEvent]
    : [];
  const visible = [...nonDeltaEvents, ...deltaPreview];
  if (visible.length <= 200) return visible;
  return [
    ...visible.slice(0, 80),
    {
      event: "stream.events.truncated",
      data: { omitted: visible.length - 120 },
    },
    ...visible.slice(-40),
  ];
}

function errorMessageFromSseData(data: unknown): string {
  if (isRecord(data)) {
    if (typeof data.error === "string" && data.error.trim().length > 0) return data.error;
    if (typeof data.message === "string" && data.message.trim().length > 0) return data.message;
  }
  return typeof data === "string" && data.trim().length > 0 ? data : "Southstar stream failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = await response.json() as ApiEnvelope<T> | ApiErrorEnvelope;
  if (payload.ok === false) throw new Error(payload.error);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return payload;
}

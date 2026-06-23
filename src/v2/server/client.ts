import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";
import type { ReadModelKind } from "../read-models/types.ts";
import type { RuntimeCommandRequest } from "../ui-api/commands/runtime-command.ts";

export type RuntimeServerClient = ReturnType<typeof createRuntimeServerClient>;

type RunGoalResult = {
  draft: { draftId: string; goalPrompt: string; workflowId: string };
  runId: string;
  taskIds: string[];
};

type RunRuntimeCommandRequest = RuntimeCommandRequest & { runId: string };
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

export function createRuntimeServerClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    runGoal(body: { goalPrompt: string }) {
      return post<RunGoalResult>(`${baseUrl}/api/v2/run-goal`, body);
    },
    createPlannerDraft(body: { goalPrompt: string }) {
      return post(`${baseUrl}/api/v2/planner/drafts`, body);
    },
    createRun(body: { draftId: string }) {
      return post(`${baseUrl}/api/v2/runs`, body);
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
    listLogs(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/logs`);
    },
    listApprovals(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/approvals`);
    },
    decideApproval(body: { runId: string; approvalId: string; decision: "approved" | "rejected"; reason: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/approvals/${encodeURIComponent(body.approvalId)}/decision`, { decision: body.decision, reason: body.reason });
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
    submitTorkCallback(body: unknown) {
      return post(`${baseUrl}/api/v2/tork/callback`, body);
    },
  };
}

function requiredTaskId(taskId: string | undefined): string {
  if (!taskId) throw new Error("taskId is required for task-detail read model");
  return taskId;
}

function runtimeCommandBody(body: RunRuntimeCommandRequest): RuntimeCommandRequest {
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

async function get<T = unknown>(url: string): Promise<ApiEnvelope<T>> {
  return readJson(await fetch(url));
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = await response.json() as ApiEnvelope<T> | ApiErrorEnvelope;
  if (payload.ok === false) throw new Error(payload.error);
  if (!response.ok) throw new Error(`request failed: ${response.status}`);
  return payload;
}

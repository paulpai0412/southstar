import type { createPlannerDraft, createRunFromDraft } from "../ui-api/local-api.ts";
import type { ApiEnvelope, ApiErrorEnvelope } from "./types.ts";

export type RuntimeServerClient = ReturnType<typeof createRuntimeServerClient>;
type RunGoalResult = Awaited<ReturnType<typeof createRunFromDraft>> & {
  draft: Awaited<ReturnType<typeof createPlannerDraft>>;
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
      return post(
        `${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/approvals/${encodeURIComponent(body.approvalId)}/decision`,
        { decision: body.decision, reason: body.reason },
      );
    },
    steerRun(body: { runId: string; message: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/steering`, { message: body.message });
    },
    voiceCommand(body: { runId: string; transcript: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/voice-command`, { transcript: body.transcript });
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
    pauseRun(body: { runId: string; commandId: string; actor: { type: "user" | "system" | "root-session"; id?: string }; reason?: string; payload: Record<string, unknown> }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/pause`, { commandId: body.commandId, actor: body.actor, reason: body.reason, payload: body.payload });
    },
    resumeRun(body: { runId: string; commandId: string; actor: { type: "user" | "system" | "root-session"; id?: string }; reason?: string; payload: Record<string, unknown> }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/resume`, { commandId: body.commandId, actor: body.actor, reason: body.reason, payload: body.payload });
    },
    cancelRun(body: { runId: string; commandId: string; actor: { type: "user" | "system" | "root-session"; id?: string }; reason?: string; payload: Record<string, unknown> }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/cancel`, { commandId: body.commandId, actor: body.actor, reason: body.reason, payload: body.payload });
    },
    submitExecutorCallback(body: unknown) {
      return post(`${baseUrl}/api/v2/executor/callback`, body);
    },
    submitTorkCallback(body: unknown) {
      return post(`${baseUrl}/api/v2/executor/callback`, body);
    },
  };
}

async function post<T = unknown>(url: string, body: unknown): Promise<ApiEnvelope<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function get<T = unknown>(url: string): Promise<ApiEnvelope<T>> {
  return readJson(await fetch(url));
}

async function readJson<T>(response: Response): Promise<ApiEnvelope<T>> {
  const payload = await response.json() as ApiEnvelope<T> | ApiErrorEnvelope;
  if (payload.ok === false) {
    throw new Error(payload.error);
  }
  if (!response.ok) {
    throw new Error(`request failed: ${response.status}`);
  }
  return payload;
}

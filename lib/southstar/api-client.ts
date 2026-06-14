import type {
  PlannerDraftView,
  RunCreationView,
  RunStatusView,
  TaskDetailView,
  TaskEnvelopeEvidenceView,
} from "@/components/southstar/types";

export type SouthstarApiClient = ReturnType<typeof createSouthstarApiClient>;

export function createSouthstarApiClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    createDraft(goalPrompt: string): Promise<PlannerDraftView> {
      return post(`${baseUrl}/api/v2/planner/drafts`, { goalPrompt });
    },
    reviseDraft(draftId: string, prompt: string): Promise<PlannerDraftView> {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/revise`, { prompt });
    },
    runDraft(draftId: string): Promise<RunCreationView> {
      return post(`${baseUrl}/api/v2/runs`, { draftId });
    },
    getRun(runId: string): Promise<RunStatusView> {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}`);
    },
    getTask(runId: string, taskId: string): Promise<TaskDetailView> {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}`);
    },
    getTaskEnvelope(runId: string, taskId: string): Promise<TaskEnvelopeEvidenceView> {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/envelope`);
    },
    steer(runId: string, message: string): Promise<unknown> {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/steering`, { message });
    },
    voiceTranscript(runId: string, transcript: string): Promise<unknown> {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/voice-command`, { transcript });
    },
  };
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap<T>(response);
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json() as { ok?: boolean; result?: T; error?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `Southstar API failed with ${response.status}`);
  }
  if (!("result" in body)) throw new Error("Southstar API response missing result");
  return body.result as T;
}

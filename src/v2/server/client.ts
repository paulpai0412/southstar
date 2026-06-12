import type { ApiEnvelope } from "./types.ts";

export type RuntimeServerClient = ReturnType<typeof createRuntimeServerClient>;

export function createRuntimeServerClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
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
    steerRun(body: { runId: string; message: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/steering`, { message: body.message });
    },
    getTaskEnvelope(body: { runId: string; taskId: string }) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/envelope`);
    },
    submitTorkCallback(body: unknown) {
      return post(`${baseUrl}/api/v2/tork/callback`, body);
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
  const payload = await response.json() as ApiEnvelope<T> | { ok: false; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `request failed: ${response.status}`);
  }
  return payload;
}

export type SouthstarApiClient = ReturnType<typeof createSouthstarApiClient>;

export function createSouthstarApiClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    createDraft(goalPrompt: string) {
      return post(`${baseUrl}/api/v2/planner/drafts`, { goalPrompt });
    },
    reviseDraft(draftId: string, prompt: string) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/revise`, { prompt });
    },
    runDraft(draftId: string) {
      return post(`${baseUrl}/api/v2/runs`, { draftId });
    },
    getRun(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}`);
    },
    steer(runId: string, message: string) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/steering`, { message });
    },
    voiceTranscript(runId: string, transcript: string) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/voice-command`, { transcript });
    },
  };
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function get(url: string) {
  const response = await fetch(url);
  return response.json();
}

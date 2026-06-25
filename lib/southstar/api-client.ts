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
    getUiPlanner(draftId?: string): Promise<any> {
      const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
      return get(`${baseUrl}/api/v2/ui/planner${query}`);
    },
    getUiWorkflowTab(params?: { draftId?: string; runId?: string }): Promise<any> {
      const query = new URLSearchParams();
      if (params?.draftId) query.set("draftId", params.draftId);
      if (params?.runId) query.set("runId", params.runId);
      return get(`${baseUrl}/api/v2/ui/workflow-tab${query.size ? `?${query.toString()}` : ""}`);
    },
    getUiWorkflow(params?: { draftId?: string; runId?: string; taskId?: string }): Promise<any> {
      const query = new URLSearchParams();
      if (params?.draftId) query.set("draftId", params.draftId);
      if (params?.runId) query.set("runId", params.runId);
      if (params?.taskId) query.set("taskId", params.taskId);
      return get(`${baseUrl}/api/v2/ui/workflow${query.size ? `?${query.toString()}` : ""}`);
    },
    getUiOperationsTab(params?: { runId?: string }): Promise<any> {
      const query = new URLSearchParams();
      if (params?.runId) query.set("runId", params.runId);
      return get(`${baseUrl}/api/v2/ui/operations-tab${query.size ? `?${query.toString()}` : ""}`);
    },
    getUiLibraryAlternatives(params: { draftId: string; taskId?: string }): Promise<any> {
      const query = new URLSearchParams({ draftId: params.draftId });
      if (params.taskId) query.set("taskId", params.taskId);
      return get(`${baseUrl}/api/v2/ui/library-alternatives?${query.toString()}`);
    },
    getAgentLibrary(params?: { domain?: string }): Promise<any> {
      const query = new URLSearchParams();
      if (params?.domain) query.set("domain", params.domain);
      return get(`${baseUrl}/api/v2/agent-library${query.size ? `?${query.toString()}` : ""}`);
    },
    getAgentLibraryCandidates(params: { draftId: string; taskId?: string }): Promise<any> {
      const query = new URLSearchParams({ draftId: params.draftId });
      if (params.taskId) query.set("taskId", params.taskId);
      return get(`${baseUrl}/api/v2/agent-library/candidates?${query.toString()}`);
    },
    getUiOperatorAttention(): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/operator-attention`);
    },
    getUiOperatorOverview(): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/operator-overview`);
    },
    getUiWorkflowCanvas(runId: string, taskId?: string): Promise<any> {
      const task = taskId ? `&taskId=${encodeURIComponent(taskId)}` : "";
      return get(`${baseUrl}/api/v2/ui/workflow-canvas?runId=${encodeURIComponent(runId)}${task}`);
    },
    getUiRuntimeMonitor(runId: string): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/runtime-monitor?runId=${encodeURIComponent(runId)}`);
    },
    getUiTaskDetail(runId: string, taskId: string): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/task-detail?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(taskId)}`);
    },
    getUiSessionsMemory(runId?: string, sessionId?: string): Promise<any> {
      const query = new URLSearchParams();
      if (runId) query.set("runId", runId);
      if (sessionId) query.set("sessionId", sessionId);
      return get(`${baseUrl}/api/v2/ui/sessions-memory?${query.toString()}`);
    },
    getUiWorktree(runId?: string): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/worktree${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`);
    },
    getUiExecutor(jobId?: string): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/executor${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`);
    },
    getUiDomainPacks(domainPackId?: string): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/domain-packs${domainPackId ? `?domainPackId=${encodeURIComponent(domainPackId)}` : ""}`);
    },
    getUiGovernance(): Promise<any> {
      return get(`${baseUrl}/api/v2/ui/governance`);
    },
    command(path: string, body: unknown): Promise<any> {
      return post(`${baseUrl}${path}`, body);
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

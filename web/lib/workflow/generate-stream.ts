import type {
  GoalDesignMode,
  GoalMissionReadModel,
  WorkflowCommandDescriptor,
  WorkflowDag,
  WorkflowTemplatePolicyV1,
} from "./types";

export type WorkflowGenerateMessageEvent = "message" | "message.delta";

export type WorkflowGenerateStageEvent = {
  stage?: string;
  message?: string;
  attempt?: number;
  ok?: boolean;
  issueCount?: number;
};

export type WorkflowGenerateDraftEvent = {
  draftId?: string;
  status?: string;
  goalDesignPhase?: string;
  goalRequirementDraftHash?: string;
  goalRequirementDraft?: unknown;
  goalDesignPackageHash?: string;
  vocabularyGaps?: Array<{ kind: string; requestedRef: string; allowedRefs: string[] }>;
  libraryImportDraftId?: string;
  validationIssues?: unknown[];
};

export type WorkflowGenerateHeartbeatEvent = Record<string, unknown> & {
  phase?: string;
  elapsedMs?: number;
};

export type GoalValidationProgressEvent = Record<string, unknown> & {
  event: string;
  requirementId?: string;
  requirementNumber?: number;
  requirementCount?: number;
  status?: string;
  gapCount?: number;
};

export type WorkflowGenerateIdentity = {
  draftId: string;
  draftStatus?: string;
  runId?: string;
  runStatus?: string;
};

export type WorkflowGenerateRecoverableEvent = {
  result: WorkflowGenerateIdentity;
  error: string;
};

export type WorkflowGenerateStreamHandlers = {
  onMessage?: (text: string, event: WorkflowGenerateMessageEvent) => void;
  onStage?: (stage: WorkflowGenerateStageEvent) => void;
  onHeartbeat?: (heartbeat: WorkflowGenerateHeartbeatEvent) => void;
  onGoalValidationProgress?: (progress: GoalValidationProgressEvent) => void;
  onDraft?: (draft: WorkflowGenerateDraftEvent) => void;
  onGoalDesign?: (goalDesign: Record<string, unknown>) => void;
  onGoalRequirements?: (goalRequirements: Record<string, unknown>) => void;
  onDag?: (dag: WorkflowDag) => void;
  onGoalContract?: (mission: GoalMissionReadModel) => void;
  onCoverage?: (mission: GoalMissionReadModel) => void;
  onRun?: (run: { runId?: string; runStatus?: string }) => void;
  onExecutionSet?: (executionSet: { executionSetId?: string; sliceRuns?: Array<{ sliceId?: string; runId?: string; runStatus?: string; approvalId?: string }> }) => void;
  onApproval?: (approval: { mission?: GoalMissionReadModel; command?: WorkflowCommandDescriptor }) => void;
  onRecoverable?: (recoverable: WorkflowGenerateRecoverableEvent) => void;
  onError?: (message: string) => void;
  onDone?: (result?: Record<string, unknown>) => void;
};

export class WorkflowGenerateHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly diagnostics: unknown[] = [],
  ) {
    super(message);
    this.name = "WorkflowGenerateHttpError";
  }
}

async function throwWorkflowGenerateError(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  let payload: { error?: unknown; message?: unknown; diagnostics?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") payload = parsed as typeof payload;
  } catch {
    // Keep the plain response text when the upstream did not return JSON.
  }
  const message = typeof payload.message === "string" ? payload.message : "";
  const code = typeof payload.error === "string" ? payload.error : undefined;
  const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
  throw new WorkflowGenerateHttpError(
    message || text || `Workflow generation failed with HTTP ${response.status}`,
    response.status,
    code,
    diagnostics,
  );
}

export async function createPlannerDraftStream(input: {
  request: Record<string, unknown>;
  signal?: AbortSignal;
} & Pick<WorkflowGenerateStreamHandlers, "onStage" | "onDraft" | "onError" | "onDone">): Promise<void> {
  const response = await fetch("/api/workflow/planner-drafts/stream", {
    method: "POST",
    signal: input.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.request),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `planner draft stream failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("planner draft stream response is missing a stream body");
  }

  await readWorkflowEventStream(response.body, input);
}

export async function generateWorkflowDagStream(input: {
  prompt: string;
  draftId?: string | null;
  expectedPackageHash?: string | null;
  expectedDraftHash?: string | null;
  selectedSliceId?: string | null;
  selectedRequirementId?: string | null;
  cwd?: string | null;
  projectRef?: string | null;
  goalDesignMode?: GoalDesignMode;
  templatePolicy?: WorkflowTemplatePolicyV1;
  idempotencyKey?: string;
  signal?: AbortSignal;
} & WorkflowGenerateStreamHandlers): Promise<void> {
  const endpoint = input.draftId
    ? `/api/workflow/planner-drafts/${encodeURIComponent(input.draftId)}/revise/stream`
    : "/api/workflow/generate";
  const response = await fetch(endpoint, {
    method: "POST",
    signal: input.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.projectRef ? { projectRef: input.projectRef } : {}),
      ...(!input.draftId ? { idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() } : {}),
      ...(!input.draftId && input.goalDesignMode ? { goalDesignMode: input.goalDesignMode } : {}),
      ...(!input.draftId && input.templatePolicy ? { templatePolicy: input.templatePolicy } : {}),
      ...(input.draftId && input.expectedPackageHash ? { expectedPackageHash: input.expectedPackageHash } : {}),
      ...(input.draftId && input.expectedDraftHash ? { expectedDraftHash: input.expectedDraftHash } : {}),
      ...(input.draftId && input.selectedSliceId ? { selectedSliceId: input.selectedSliceId } : {}),
      ...(input.draftId && input.selectedRequirementId ? { selectedRequirementId: input.selectedRequirementId } : {}),
    }),
  });

  if (!input.draftId && (response.status === 202 || response.status === 409)) {
    const active = response.status === 202;
    const stage = active ? "submission.active" : "submission.conflict";
    input.onStage?.({ stage, message: active ? "An identical goal submission is still active." : "The goal submission key conflicts with another request." });
    throw new Error(await response.text().catch(() => "") || (active ? "goal submission is active" : "goal submission conflicts with another request"));
  }

  if (!response.ok) {
    await throwWorkflowGenerateError(response);
  }
  if (!response.body) {
    throw new Error("workflow generate response is missing a stream body");
  }

  await readWorkflowEventStream(response.body, input);
}

export async function confirmGoalDesignStream(input: {
  draftId: string;
  expectedPackageHash: string;
  signal?: AbortSignal;
} & WorkflowGenerateStreamHandlers): Promise<void> {
  const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(input.draftId)}/confirm-goal-design/stream`, {
    method: "POST",
    signal: input.signal,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ expectedPackageHash: input.expectedPackageHash }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `goal design confirmation failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("goal design confirmation response is missing a stream body");
  await readWorkflowEventStream(response.body, input);
}

export async function confirmGoalRequirementsStream(input: {
  draftId: string;
  expectedDraftHash: string;
  signal?: AbortSignal;
} & WorkflowGenerateStreamHandlers): Promise<void> {
  const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(input.draftId)}/confirm-requirements/stream`, {
    method: "POST",
    signal: input.signal,
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ expectedDraftHash: input.expectedDraftHash }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Requirement confirmation failed with HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Requirement confirmation response is missing a stream body");
  await readWorkflowEventStream(response.body, input);
}

async function readWorkflowEventStream(
  body: ReadableStream<Uint8Array>,
  handlers: WorkflowGenerateStreamHandlers,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        buffer = dispatchCompleteFrames(buffer, handlers);
      }
      if (done) break;
    }

    buffer += decoder.decode();
    const rest = buffer.trim();
    if (rest) {
      dispatchFrame(rest, handlers);
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatchCompleteFrames(buffer: string, handlers: WorkflowGenerateStreamHandlers): string {
  let remaining = buffer;
  while (true) {
    const normalized = remaining.replace(/\r\n/g, "\n");
    const frameEnd = normalized.indexOf("\n\n");
    if (frameEnd === -1) return remaining;
    const frame = normalized.slice(0, frameEnd);
    dispatchFrame(frame, handlers);
    remaining = normalized.slice(frameEnd + 2);
  }
}

function dispatchFrame(frame: string, handlers: WorkflowGenerateStreamHandlers): void {
  const lines = frame.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  const rawData = dataLines.join("\n");
  const data = rawData ? JSON.parse(rawData) as Record<string, unknown> : {};

  if (event === "message" || event === "message.delta") {
    const text = typeof data.text === "string" ? data.text : "";
    if (text) handlers.onMessage?.(text, event);
    return;
  }
  if (event === "planner.stage") {
    handlers.onStage?.(data as WorkflowGenerateStageEvent);
    return;
  }
  if (event === "heartbeat") {
    handlers.onHeartbeat?.(data as WorkflowGenerateHeartbeatEvent);
    return;
  }
  if (event.startsWith("goal.validation.") || event.startsWith("library.import.")) {
    handlers.onGoalValidationProgress?.({ ...data, event });
    return;
  }
  if (event === "draft") {
    const draft = data.draft && typeof data.draft === "object" ? data.draft : data;
    handlers.onDraft?.(draft as WorkflowGenerateDraftEvent);
    return;
  }
  if (event === "goal_design") {
    handlers.onGoalDesign?.(data);
    return;
  }
  if (event === "goal_requirements") {
    handlers.onGoalRequirements?.(data);
    return;
  }
  if (event === "dag") {
    if (!data.dag || typeof data.dag !== "object") {
      throw new Error("workflow generate dag event is missing dag");
    }
    handlers.onDag?.(data.dag as WorkflowDag);
    return;
  }
  if (event === "goal_contract") {
    if (data.mission && typeof data.mission === "object") handlers.onGoalContract?.(data.mission as GoalMissionReadModel);
    return;
  }
  if (event === "coverage") {
    if (data.mission && typeof data.mission === "object") handlers.onCoverage?.(data.mission as GoalMissionReadModel);
    return;
  }
  if (event === "run") {
    handlers.onRun?.(data as { runId?: string; runStatus?: string });
    return;
  }
  if (event === "execution_set") {
    handlers.onExecutionSet?.(data as { executionSetId?: string; sliceRuns?: Array<{ sliceId?: string; runId?: string; runStatus?: string; approvalId?: string }> });
    return;
  }
  if (event === "approval") {
    handlers.onApproval?.(data as { mission?: GoalMissionReadModel; command?: WorkflowCommandDescriptor });
    return;
  }
  if (event === "recoverable") {
    handlers.onRecoverable?.(data as WorkflowGenerateRecoverableEvent);
    return;
  }
  if (event === "error") {
    const message = typeof data.error === "string" ? data.error : "workflow generate failed";
    handlers.onError?.(message);
    throw new Error(message);
  }
  if (event === "done") {
    handlers.onDone?.(data);
  }
}

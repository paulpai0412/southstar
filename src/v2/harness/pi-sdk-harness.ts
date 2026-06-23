import type { AnyTaskEnvelope } from "../agent-runner/task-envelope.ts";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "./types.ts";

export type PiSdkHarnessSession = {
  prompt(text: string): Promise<void>;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  on?: (listener: (event: unknown) => void) => () => void;
};

export type PiSdkAgentHarnessOptions = {
  createSession?: (input: { cwd: string }) => Promise<PiSdkHarnessSession>;
  timeoutMs?: number;
};

export function createPiSdkAgentHarness(options: PiSdkAgentHarnessOptions = {}): AgentHarness {
  return {
    id: "pi-sdk-harness",
    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      const timeoutMs = options.timeoutMs ?? 180_000;
      const cwd = harnessCwd(input.envelope);
      const session = await createSessionWithTimeout(
        options.createSession ?? createDefaultPiSdkSession,
        { cwd },
        timeoutMs,
      );
      const raw = await runPromptAndCollectAssistantText(session, buildHarnessPrompt(input, cwd), timeoutMs);
      return parseHarnessResult(raw, input.envelope);
    },
  };
}

async function createSessionWithTimeout(
  createSession: (input: { cwd: string }) => Promise<PiSdkHarnessSession>,
  input: { cwd: string },
  timeoutMs: number,
): Promise<PiSdkHarnessSession> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Pi SDK harness timed out while creating session after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([createSession(input), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildHarnessPrompt(input: HarnessRunInput, cwd: string): string {
  if (input.envelope.schemaVersion === "southstar.task-envelope.v2") {
    return [
      input.envelope.agentPrompt,
      ...resolvedSkillInstructions(input.envelope.skills),
      "",
      ...workspaceDirective(cwd),
      `Attempt: ${input.attempt}`,
      input.repairInstruction ? `Repair instruction: ${input.repairInstruction}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "You are a Southstar container agent running inside a Tork task.",
    "Execute the task described by the TaskEnvelope. Use the available Pi Agent tools as needed.",
    "Return exactly one JSON object with keys: artifact, progress, metrics.",
    "artifact must satisfy the required fields from artifactContract.",
    ...workspaceDirective(cwd),
    `Attempt: ${input.attempt}`,
    input.repairInstruction ? `Repair instruction: ${input.repairInstruction}` : "",
    "TaskEnvelope:",
    JSON.stringify(input.envelope),
  ].filter(Boolean).join("\n");
}

function resolvedSkillInstructions(skills: Array<{ skillId: string; version?: string; instructions: string }>): string[] {
  if (skills.length === 0) return [];
  return [
    "",
    "=== SKILL INSTRUCTIONS ===",
    ...skills.map((skill) => [
      `## ${skill.skillId}${skill.version ? `@${skill.version}` : ""}`,
      skill.instructions.trim(),
    ].join("\n\n")),
    "=== END SKILL INSTRUCTIONS ===",
    "",
  ];
}

function harnessCwd(envelope: HarnessRunInput["envelope"]): string {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return process.cwd();

  const workspaceHandle = envelope.workspace?.handle;
  if (workspaceHandle?.worktreePath?.startsWith("/workspace/")) return workspaceHandle.worktreePath;
  if (workspaceHandle?.repoRoot?.startsWith("/workspace/")) return workspaceHandle.repoRoot;

  const requiredMounts = envelope.skills.flatMap((skill) => skill.requiredMounts);
  if (requiredMounts.includes("/workspace/repo")) return "/workspace/repo";
  const mountedWorkspace = requiredMounts.find((mount) => mount.startsWith("/workspace/"));
  if (mountedWorkspace) return mountedWorkspace;

  if (workspaceHandle) return "/workspace/repo";
  return process.cwd();
}

function workspaceDirective(cwd: string): string[] {
  if (!cwd.startsWith("/workspace/")) return [];
  return [
    `Execution workspace: ${cwd}`,
    `Before reading, editing, testing, or reporting files, change directory to ${cwd}.`,
    `Edit and test only the mounted target repository under ${cwd}. Do not modify /app; /app is the Southstar runner image, not the target repository.`,
  ];
}

async function createDefaultPiSdkSession(input: { cwd: string }): Promise<PiSdkHarnessSession> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const result = await pi.createAgentSession({
    cwd: input.cwd,
    sessionStartEvent: {
      mode: "sdk",
      source: "southstar-agent-runner",
      cwd: input.cwd,
    } as never,
  });
  return result.session as unknown as PiSdkHarnessSession;
}

async function runPromptAndCollectAssistantText(
  session: PiSdkHarnessSession,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  let finalText = "";
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<string>((resolve, reject) => {
    const listener = (event: unknown) => {
      const text = assistantTextFromEvent(event);
      if (text) finalText = text;
      if (isRecord(event) && event.type === "agent_end") {
        resolve(finalText);
      }
    };
    unsubscribe = session.subscribe?.(listener) ?? session.on?.(listener);
    if (!unsubscribe) {
      reject(new Error("Pi SDK AgentSession must expose subscribe(listener)"));
    }
  });
  const promptAndDone = (async () => {
    await session.prompt(prompt);
    return done;
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Pi SDK harness timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const text = await Promise.race([promptAndDone, timeout]);
    if (!text.trim()) throw new Error("Pi SDK harness returned empty assistant text");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    promptAndDone.catch(() => undefined);
    unsubscribe?.();
  }
}

function parseHarnessResult(raw: string, envelope: AnyTaskEnvelope): HarnessRunResult {
  const parsed = parseAssistantJson(raw);
  if (!isRecord(parsed)) {
    return {
      artifact: completeArtifactForEnvelope(
        { summary: raw.trim() },
        envelope,
        "assistant text was not a structured JSON artifact",
      ),
      progress: ["pi-agent returned unstructured text"],
    };
  }
  if (isRecord(parsed.artifact)) {
    return {
      artifact: completeArtifactForEnvelope(parsed.artifact, envelope, "assistant artifact JSON omitted required fields"),
      progress: progressArray(parsed.progress),
      metrics: metricsFrom(parsed.metrics),
    };
  }
  if (isRecord(parsed.output) && isRecord(parsed.output.artifact)) {
    return {
      artifact: completeArtifactForEnvelope(parsed.output.artifact, envelope, "assistant output artifact JSON omitted required fields"),
      progress: progressArray(parsed.output.progress),
      metrics: metricsFrom(parsed.output.metrics),
    };
  }
  return {
    artifact: completeArtifactForEnvelope(parsed, envelope, "assistant bare JSON artifact omitted required fields"),
    progress: progressArray(parsed.progress),
    metrics: metricsFrom(parsed.metrics),
  };
}

function parseAssistantJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1]?.trim() ?? (trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : undefined);
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function completeArtifactForEnvelope(
  artifact: Record<string, unknown>,
  envelope: AnyTaskEnvelope,
  reason: string,
): Record<string, unknown> {
  const requiredFields = implementationReportRequiredFields(envelope);
  if (requiredFields.length === 0) return artifact;

  const next = { ...artifact };
  if (!hasValue(next.summary)) next.summary = "Pi SDK returned a structured artifact without a summary.";
  if (requiredFields.includes("filesChanged") && !hasValue(next.filesChanged)) next.filesChanged = [];
  if (requiredFields.includes("commandsRun") && !hasValue(next.commandsRun)) next.commandsRun = [];
  if (requiredFields.includes("testResults") && !hasValue(next.testResults)) {
    next.testResults = [{
      command: "pi-sdk-harness",
      status: "not-run",
      gating: "non-gating",
      summary: "Pi SDK response did not include structured test results.",
    }];
  }
  if (requiredFields.includes("risks") && !hasValue(next.risks)) {
    next.risks = ["Pi SDK returned unstructured text; artifact evidence was synthesized by Southstar."];
  }
  if (requiredFields.includes("artifactEvidence") && !hasValue(next.artifactEvidence)) {
    next.artifactEvidence = {
      source: "pi-sdk-harness",
      status: "synthesized",
      reason,
    };
  }
  return next;
}

function implementationReportRequiredFields(envelope: AnyTaskEnvelope): string[] {
  if (envelope.schemaVersion === "southstar.task-envelope.v1") {
    const artifactTypes = new Set(envelope.artifactContract.artifactTypes);
    if (!artifactTypes.has("implementation_report") && !artifactTypes.has("implementation-report")) return [];
    return envelope.artifactContract.requiredFields;
  }
  const contract = envelope.artifactContracts.find((item) => item.id === "implementation_report");
  return contract?.requiredFields ?? [];
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function progressArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return ["pi-agent returned artifact"];
}

function metricsFrom(value: unknown): HarnessRunResult["metrics"] {
  if (!isRecord(value)) return undefined;
  return {
    durationMs: numberOrUndefined(value.durationMs),
    toolCalls: numberOrUndefined(value.toolCalls),
    retryCount: numberOrUndefined(value.retryCount),
    tokens: numberOrUndefined(value.tokens),
    costMicrosUsd: numberOrUndefined(value.costMicrosUsd),
  };
}

function assistantTextFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (Array.isArray(event.messages)) {
    const assistant = [...event.messages].reverse().find((message) =>
      isRecord(message) && message.role === "assistant"
    );
    return textFromMessage(assistant);
  }
  return textFromMessage(event.message);
}

function textFromMessage(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
    .join("")
    .trim() || undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

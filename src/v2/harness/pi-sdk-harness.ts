import type { AnyTaskEnvelope } from "../agent-runner/task-envelope.ts";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "./types.ts";

export type PiSdkHarnessSession = {
  send?: (event: unknown) => Promise<void>;
  prompt(text: string): Promise<void>;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  on?: (listener: (event: unknown) => void) => () => void;
  abort?: () => void | Promise<void>;
  dispose?: () => void | Promise<void>;
};

type PiSdkHarnessSessionInput = {
  cwd: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
};

export type PiSdkAgentHarnessOptions = {
  createSession?: (input: PiSdkHarnessSessionInput) => Promise<PiSdkHarnessSession>;
  timeoutMs?: number;
};

export function createPiSdkAgentHarness(options: PiSdkAgentHarnessOptions = {}): AgentHarness {
  return {
    id: "pi-sdk-harness",
    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      const timeoutMs = options.timeoutMs ?? 180_000;
      const cwd = harnessCwd(input.envelope);
      const sessionInput = sessionInputFromEnvelope(input.envelope, cwd);
      let session: PiSdkHarnessSession | undefined;
      let completed = false;
      try {
        session = await createSessionWithTimeout(
          options.createSession ?? createDefaultPiSdkSession,
          sessionInput,
          timeoutMs,
        );
        await configurePiSdkSession(session, sessionInput);
        const raw = await runPromptAndCollectAssistantText(session, buildHarnessPrompt(input, cwd), timeoutMs);
        completed = true;
        return parseHarnessResult(raw, input.envelope);
      } finally {
        await cleanupPiSdkSession(session, { abort: !completed });
      }
    },
  };
}

async function cleanupPiSdkSession(session: PiSdkHarnessSession | undefined, options: { abort: boolean }): Promise<void> {
  if (!session) return;
  if (options.abort && session.abort) {
    await bestEffortCleanup(() => session.abort?.());
  }
  if (session.dispose) {
    await bestEffortCleanup(() => session.dispose?.());
  }
}

async function bestEffortCleanup(cleanup: () => void | Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Cleanup must not turn an otherwise valid task result into a failed task.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createSessionWithTimeout(
  createSession: (input: PiSdkHarnessSessionInput) => Promise<PiSdkHarnessSession>,
  input: PiSdkHarnessSessionInput,
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

function sessionInputFromEnvelope(envelope: HarnessRunInput["envelope"], cwd: string): PiSdkHarnessSessionInput {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return { cwd };
  const provider = envelope.agentProfile.provider?.trim();
  const modelId = envelope.agentProfile.model?.trim();
  const thinkingLevel = envelope.agentProfile.thinkingLevel?.trim();
  return {
    cwd,
    ...(provider && modelId ? { model: { provider, modelId } } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

async function configurePiSdkSession(
  session: PiSdkHarnessSession,
  input: PiSdkHarnessSessionInput,
): Promise<void> {
  if (!session.send) return;
  if (input.model) {
    await session.send({ type: "set_model", provider: input.model.provider, modelId: input.model.modelId });
  }
  if (input.thinkingLevel) {
    await session.send({ type: "set_thinking_level", thinkingLevel: input.thinkingLevel });
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

async function createDefaultPiSdkSession(input: PiSdkHarnessSessionInput): Promise<PiSdkHarnessSession> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const result = await pi.createAgentSession({
    cwd: input.cwd,
    sessionStartEvent: {
      mode: "sdk",
      source: "southstar-agent-runner",
      cwd: input.cwd,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
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
  const contract = primaryArtifactContract(envelope);
  const requiredFields = contract?.requiredFields ?? [];
  if (requiredFields.length === 0) return artifact;

  const next = { ...artifact };
  applyContractFallbackFields(next, contract?.id, reason);
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

function primaryArtifactContract(envelope: AnyTaskEnvelope): { id: string; requiredFields: string[] } | undefined {
  if (envelope.schemaVersion === "southstar.task-envelope.v1") {
    const artifactTypes = new Set(envelope.artifactContract.artifactTypes);
    if (artifactTypes.has("verification_report") || artifactTypes.has("verification-report")) {
      return { id: "verification_report", requiredFields: envelope.artifactContract.requiredFields };
    }
    if (artifactTypes.has("completion_report") || artifactTypes.has("completion-report")) {
      return { id: "completion_report", requiredFields: envelope.artifactContract.requiredFields };
    }
    if (artifactTypes.has("implementation_report") || artifactTypes.has("implementation-report")) {
      return { id: "implementation_report", requiredFields: envelope.artifactContract.requiredFields };
    }
    return undefined;
  }
  const contract = envelope.artifactContracts.find((item) =>
    item.id === "verification_report" || item.id === "completion_report" || item.id === "implementation_report"
  );
  return contract ? { id: contract.id, requiredFields: contract.requiredFields } : undefined;
}

function applyContractFallbackFields(next: Record<string, unknown>, contractId: string | undefined, reason: string): void {
  if (contractId === "verification_report") {
    if (!hasValue(next.pass)) next.pass = false;
    if (!hasValue(next.safeToSave)) next.safeToSave = false;
    if (!hasValue(next.commandsRun)) next.commandsRun = [];
    if (!hasValue(next.testResults)) {
      next.testResults = [{
        checkId: "pi-sdk-structured-output",
        command: "pi-sdk-harness",
        status: "not-verified",
        gating: "blocking",
        summary: "Pi SDK response did not include a structured verification report.",
      }];
    }
    if (!hasValue(next.risks)) {
      next.risks = ["Pi SDK returned unstructured verification text; runtime must trigger repair before accepting this work."];
    }
    if (!hasValue(next.artifactEvidence)) {
      next.artifactEvidence = {
        source: "pi-sdk-harness",
        status: "synthesized",
        reason,
      };
    }
    return;
  }
  if (contractId === "completion_report") {
    if (!hasValue(next.acceptedArtifacts)) next.acceptedArtifacts = [];
    if (!hasValue(next.tests)) {
      next.tests = [{
        command: "pi-sdk-harness",
        status: "not-verified",
        gating: "non-gating",
        summary: "Pi SDK response did not include structured completion test evidence.",
      }];
    }
  }
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

import type { AnyTaskEnvelope } from "../agent-runner/task-envelope.ts";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "./types.ts";
import { unsupportedPiRuntimeToolNames } from "./pi-runtime-tools.ts";

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
  tools?: string[];
};

export type PiSdkAgentHarnessOptions = {
  createSession?: (input: PiSdkHarnessSessionInput) => Promise<PiSdkHarnessSession>;
  onDelta?: (text: string) => void | Promise<void>;
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
        const raw = await runPromptAndCollectAssistantText(session, buildHarnessPrompt(input, cwd), timeoutMs, options.onDelta);
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
  const tools = [...new Set(envelope.toolProxyPolicy?.allowedTools ?? [])].sort();
  const unsupportedTools = unsupportedPiRuntimeToolNames(tools);
  if (unsupportedTools.length > 0) {
    throw new Error(`Pi SDK harness does not provide selected runtime tools: ${unsupportedTools.join(", ")}`);
  }
  return {
    cwd,
    tools,
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
      ...runnerOutputContractDirective(input.envelope),
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
    ...runnerOutputContractDirective(input.envelope),
    ...workspaceDirective(cwd),
    `Attempt: ${input.attempt}`,
    input.repairInstruction ? `Repair instruction: ${input.repairInstruction}` : "",
    "TaskEnvelope:",
    JSON.stringify(input.envelope),
  ].filter(Boolean).join("\n");
}

function runnerOutputContractDirective(envelope: HarnessRunInput["envelope"]): string[] {
  const contract = primaryArtifactContract(envelope);
  const contractId = contract?.id;
  if (!contractId) return [];
  // The Library artifact contract is the source of truth.  Do not substitute
  // a legacy field set for a well-known artifact id: imported contracts may
  // intentionally require different top-level fields (for example
  // verdict/checks/evidenceRefs instead of summary/pass).
  const fields = contract?.requiredFields ?? [];
  const fieldSet = new Set(fields);
  const expectedEvidenceKinds = expectedEvidenceKindsFromEnvelope(envelope);
  return [
    "Runner output contract:",
    "Return exactly one JSON object. Do not wrap it in markdown.",
    `Top-level shape: {"artifact": {...}, "progress": string[], "metrics": object}.`,
    `artifact must contain these fields at top level: ${fields.join(", ")}.`,
    ...(fieldSet.has("pass") || fieldSet.has("safeToSave")
      ? ["pass and safeToSave, when required by this contract, must be booleans: true or false."]
      : []),
    ...(fieldSet.has("commandsRun")
      ? [
        "commandsRun entries must be executed command result objects, not bare strings.",
        "commandsRun.status allowed values: passed, failed, blocked.",
        `commandsRun item schema: {"command": "npm test" or ["npm","test"], "status": "passed", "exitCode": 0, "output": "bounded relevant output"}.`,
        "Each commandsRun item must include status or exitCode; command records without an outcome do not satisfy command-output evidence.",
        "exitCode must be an integer; use 0 for success and non-zero for failed command execution.",
      ]
      : []),
    ...(fieldSet.has("testResults")
      ? [
        "testResults.status allowed values: passed, failed, failed_non_gating, blocked, not-verified, not-run, skipped, pass_with_environment_gap.",
        "gating allowed values: blocking, non-gating.",
        `testResults item schema: {"name": "check name", "command": "npm test", "status": "passed", "gating": "blocking", "details": "bounded evidence"}.`,
      ]
      : []),
    ...(fieldSet.has("verifiedArtifactRefs")
      ? ["verifiedArtifactRefs must be an array of exact upstream ArtifactRef values evaluated by this verifier."]
      : []),
    ...(fieldSet.has("remainingFailures")
      ? ["remainingFailures must be an array; use [] only when every blocking check passed."]
      : []),
    ...(expectedEvidenceKinds.has("policy-decision")
      ? [
        `Policy evidence item schema: {"id":"ev-policy-1","evidenceKind":"policy-decision","allowed":true,"decision":"bounded explanation"}.`,
        `policy-decision evidence records must include allowed: true or status: "passed"; a descriptive decision string alone is not valid evidence.`,
      ]
      : []),
    `Do not put the report under artifact.${contractId}.`,
    `Do not return {"${contractId}": ...} as the primary artifact shape.`,
  ];
}

function expectedEvidenceKindsFromEnvelope(envelope: HarnessRunInput["envelope"]): Set<string> {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return new Set();
  return new Set(envelope.evaluatorPipeline.evaluators.flatMap((evaluator) => {
    const config = isRecord(evaluator.config) ? evaluator.config : {};
    return Array.isArray(config.expectedEvidenceKinds)
      ? config.expectedEvidenceKinds.filter((kind): kind is string => typeof kind === "string")
      : [];
  }));
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
    ...(input.tools !== undefined
      ? input.tools.length > 0
        ? { tools: input.tools }
        : { noTools: "all" as const }
      : {}),
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
  onDelta?: (text: string) => void | Promise<void>,
): Promise<string> {
  let finalText = "";
  let lastStreamedText = "";
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<string>((resolve, reject) => {
    const listener = (event: unknown) => {
      const text = assistantTextFromEvent(event);
      if (text) {
        finalText = text;
        const delta = text.startsWith(lastStreamedText) ? text.slice(lastStreamedText.length) : text;
        if (delta) void onDelta?.(delta);
        lastStreamedText = text;
      }
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
      artifact: completeArtifactForEnvelope(
        primaryContractArtifact(parsed.artifact, envelope),
        envelope,
        "assistant artifact JSON omitted required fields",
      ),
      progress: progressArray(parsed.progress),
      metrics: metricsFrom(parsed.metrics),
    };
  }
  if (isRecord(parsed.output) && isRecord(parsed.output.artifact)) {
    return {
      artifact: completeArtifactForEnvelope(
        primaryContractArtifact(parsed.output.artifact, envelope),
        envelope,
        "assistant output artifact JSON omitted required fields",
      ),
      progress: progressArray(parsed.output.progress),
      metrics: metricsFrom(parsed.output.metrics),
    };
  }
  return {
    artifact: completeArtifactForEnvelope(
      primaryContractArtifact(parsed, envelope),
      envelope,
      "assistant bare JSON artifact omitted required fields",
    ),
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
  if (requiredFields.includes("summary") && !hasValue(next.summary)) {
    next.summary = "Pi SDK returned a structured artifact without a summary.";
  }
  if (requiredFields.includes("pass") && !hasValue(next.pass)) next.pass = false;
  if (requiredFields.includes("safeToSave") && !hasValue(next.safeToSave)) next.safeToSave = false;
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
    const id = envelope.artifactContract.artifactTypes[0];
    return id ? { id, requiredFields: envelope.artifactContract.requiredFields } : undefined;
  }
  const preferredRef = envelope.evaluatorPipeline.artifactContractRefs?.[0];
  const contract = (preferredRef
    ? envelope.artifactContracts.find((item) => item.id === preferredRef || item.libraryObjectRef === preferredRef)
    : undefined) ?? envelope.artifactContracts[0];
  return contract ? { id: contract.id, requiredFields: contract.requiredFields } : undefined;
}

function primaryContractArtifact(artifact: Record<string, unknown>, envelope: AnyTaskEnvelope): Record<string, unknown> {
  const contractId = primaryArtifactContract(envelope)?.id;
  if (!contractId) return artifact;
  const nested = artifact[contractId];
  if (!isRecord(nested)) return artifact;
  return {
    ...artifact,
    ...nested,
  };
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

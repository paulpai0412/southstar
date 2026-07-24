import { createHash } from "node:crypto";
import type { AgentProvider } from "../design-library/runtime-types.ts";
import type { PiPlannerClient, PiPlannerStreamHandlers } from "./types.ts";

const SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE = "southstar.session.kind";
type SouthstarSessionKind = "chat" | "workflow" | "library";

export type { PiPlannerClient, PiPlannerStreamHandlers };

export type PiRuntimeProfileBinding = {
  harnessRef: "pi";
  provider: AgentProvider;
  model: string;
};

export function selectPiDefaultRuntimeProfileBinding(input: {
  available: Array<{ id: string; provider: string }>;
  provider?: string;
  modelId?: string;
}): PiRuntimeProfileBinding | undefined {
  const provider = input.provider?.trim();
  const modelId = input.modelId?.trim();
  if (!provider || !modelId) return undefined;
  if (!input.available.some((model) => model.provider === provider && model.id === modelId)) return undefined;
  return { harnessRef: "pi", provider: provider as AgentProvider, model: modelId };
}

export async function resolvePiDefaultRuntimeProfileBinding(
  cwd = process.cwd(),
): Promise<PiRuntimeProfileBinding | undefined> {
  const pi = await import("@earendil-works/pi-coding-agent");
  const services = await pi.createAgentSessionServices({ cwd, agentDir: pi.getAgentDir() });
  const available = services.modelRegistry.getAvailable().map((model) => ({
    id: model.id,
    provider: model.provider,
  }));
  return selectPiDefaultRuntimeProfileBinding({
    available,
    provider: services.settingsManager.getDefaultProvider(),
    modelId: services.settingsManager.getDefaultModel(),
  });
}

export function createHttpPiPlannerClient(options: {
  endpoint: string;
  model?: string;
  sessionKind?: SouthstarSessionKind;
}): PiPlannerClient {
  return {
    async generate(prompt: string): Promise<string> {
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, model: options.model, sessionKind: options.sessionKind ?? "workflow" }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Pi planner request failed: ${response.status} ${text}`);
      }
      const payload = JSON.parse(text) as { text?: string; output?: string; planBundle?: unknown };
      if (typeof payload.text === "string") return payload.text;
      if (typeof payload.output === "string") return payload.output;
      if (payload.planBundle) return JSON.stringify(payload.planBundle);
      throw new Error("Pi planner response missing text, output, or planBundle");
    },
  };
}

export type PiSdkPlannerSession = {
  prompt(text: string): Promise<void>;
  send?: (command: unknown) => Promise<unknown>;
  dispose?: () => void;
  subscribe?: (listener: (event: unknown) => void) => () => void;
  on?: (listener: (event: unknown) => void) => () => void;
  settingsManager?: {
    setHttpIdleTimeoutMs(timeoutMs: number): void;
  };
  sessionManager?: {
    appendCustomEntry(customType: string, data?: unknown): unknown;
  };
};

export type PiSdkPlannerClientOptions = {
  createSession?: (input: { cwd: string; noTools?: "all" | null }) => Promise<PiSdkPlannerSession>;
  cwd?: string;
  model?: { provider: string; modelId: string };
  noTools?: "all" | null;
  sessionKind?: SouthstarSessionKind;
  timeoutMs?: number;
};

export function createPiSdkPlannerClient(options: PiSdkPlannerClientOptions = {}): PiPlannerClient {
  return {
    async generate(prompt: string): Promise<string> {
      const timeoutMs = options.timeoutMs ?? 600_000;
      const deadline = Date.now() + timeoutMs;
      const session = await withPlannerTimeout(
        createPlannerSession(options, timeoutMs),
        timeoutMs,
        "creating session",
      );
      try {
        markPiSdkPlannerSessionKind(session, options.sessionKind ?? "workflow");
        await withPlannerTimeout(
          configurePiSdkPlannerSession(session, options.model ?? plannerModelFromEnv(), timeoutMs),
          remainingPlannerTimeout(deadline),
          "configuring session",
        );
        return await runPromptAndCollectAssistantText(session, prompt, remainingPlannerTimeout(deadline));
      } finally {
        session.dispose?.();
      }
    },
    async generateStream(prompt: string, handlers: PiPlannerStreamHandlers = {}): Promise<string> {
      const timeoutMs = options.timeoutMs ?? 600_000;
      const deadline = Date.now() + timeoutMs;
      const session = await withPlannerTimeout(
        createPlannerSession(options, timeoutMs),
        timeoutMs,
        "creating session",
      );
      try {
        markPiSdkPlannerSessionKind(session, options.sessionKind ?? "workflow");
        await withPlannerTimeout(
          configurePiSdkPlannerSession(session, options.model ?? plannerModelFromEnv(), timeoutMs),
          remainingPlannerTimeout(deadline),
          "configuring session",
        );
        return await runPromptAndCollectAssistantText(session, prompt, remainingPlannerTimeout(deadline), handlers);
      } finally {
        session.dispose?.();
      }
    },
  };
}

async function createPlannerSession(
  options: PiSdkPlannerClientOptions,
  timeoutMs: number,
): Promise<PiSdkPlannerSession> {
  const sessionOptions = plannerSessionOptions(options);
  return options.createSession
    ? options.createSession(sessionOptions)
    : createDefaultPiSdkSession({ ...sessionOptions, timeoutMs });
}

function remainingPlannerTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function withPlannerTimeout<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Pi SDK planner timed out while ${phase} after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    promise.catch(() => undefined);
  }
}

function plannerSessionOptions(options: PiSdkPlannerClientOptions): { cwd: string; noTools?: "all" | null } {
  return {
    cwd: options.cwd ?? process.cwd(),
    noTools: options.noTools === undefined ? "all" : options.noTools,
  };
}

export function plannerPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createDefaultPiSdkSession(input: { cwd: string; noTools?: "all" | null; timeoutMs: number }): Promise<PiSdkPlannerSession> {
  const pi = await import("@earendil-works/pi-coding-agent");
  // Pi's default HTTP idle timeout is 300 seconds, which is shorter than the
  // Southstar planner deadline. Use an in-memory settings manager so the
  // runtime deadline applies to this session without mutating the user's
  // global Pi settings file.
  const fileSettingsManager = pi.SettingsManager.create(input.cwd, pi.getAgentDir());
  const settings = structuredClone(
    (fileSettingsManager as unknown as { settings: Record<string, unknown> }).settings,
  );
  settings.httpIdleTimeoutMs = input.timeoutMs;
  const settingsManager = pi.SettingsManager.inMemory(settings);
  const result = await pi.createAgentSession({
    ...(input.noTools ? { noTools: input.noTools } : {}),
    agentDir: pi.getAgentDir(),
    cwd: input.cwd,
    settingsManager,
    sessionStartEvent: {
      mode: "sdk",
      source: "southstar-pi-planner",
      cwd: input.cwd,
    } as never,
  });
  return result.session as unknown as PiSdkPlannerSession;
}

async function configurePiSdkPlannerSession(
  session: PiSdkPlannerSession,
  model: { provider: string; modelId: string } | undefined,
  timeoutMs: number,
): Promise<void> {
  session.settingsManager?.setHttpIdleTimeoutMs(Math.max(1, timeoutMs));
  if (!model || !session.send) return;
  await session.send({ type: "set_model", provider: model.provider, modelId: model.modelId });
}

function markPiSdkPlannerSessionKind(session: PiSdkPlannerSession, kind: SouthstarSessionKind): void {
  session.sessionManager?.appendCustomEntry(SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE, { kind, visibility: "internal" });
}

function plannerModelFromEnv(): { provider: string; modelId: string } | undefined {
  const provider = process.env.SOUTHSTAR_WORKFLOW_COMPOSER_PROVIDER?.trim();
  const modelId = process.env.SOUTHSTAR_WORKFLOW_COMPOSER_MODEL?.trim();
  if (!provider || !modelId) return undefined;
  return { provider, modelId };
}

async function runPromptAndCollectAssistantText(
  session: PiSdkPlannerSession,
  prompt: string,
  timeoutMs: number,
  handlers: PiPlannerStreamHandlers = {},
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
        const delta = text.startsWith(lastStreamedText)
          ? text.slice(lastStreamedText.length)
          : text;
        if (delta) handlers.onDelta?.(delta);
        lastStreamedText = text;
      }
      const assistantStop = terminalAssistantStopFromEvent(event);
      if (assistantStop === "stop" || assistantStop === "length") {
        resolve(finalText);
        return;
      }
      if (assistantStop === "error" || assistantStop === "aborted") {
        reject(new Error(assistantFailureFromEvent(event) ?? `Pi SDK planner assistant stopped with ${assistantStop}`));
        return;
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
  const promptInvocation = session.prompt(prompt);
  const promptAndDone = Promise.race([
    done,
    promptInvocation.then(() => done),
  ]);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Pi SDK planner timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const text = await Promise.race([promptAndDone, timeout]);
    if (!text.trim()) throw new Error("Pi SDK planner returned empty assistant text");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    promptAndDone.catch(() => undefined);
    promptInvocation.catch(() => undefined);
    unsubscribe?.();
  }
}

function terminalAssistantStopFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return undefined;
  if (event.message.role !== "assistant" || typeof event.message.stopReason !== "string") return undefined;
  return event.message.stopReason === "toolUse" ? undefined : event.message.stopReason;
}

function assistantFailureFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || !isRecord(event.message)) return undefined;
  return typeof event.message.errorMessage === "string" && event.message.errorMessage.trim()
    ? event.message.errorMessage
    : undefined;
}

function assistantTextFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  if (Array.isArray(event.messages)) {
    const assistant = [...event.messages].reverse().find((message) =>
      isRecord(message) && message.role === "assistant"
    );
    return textFromMessage(assistant);
  }
  const message = event.message;
  if (isRecord(message) && "role" in message && message.role !== "assistant") return undefined;
  return textFromMessage(message);
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

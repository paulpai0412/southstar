import type {
  SoftwareDevReleaseInput,
  SoftwareDevVerificationInput,
  SoftwareDevWorker,
  SoftwareDevWorkerInput,
  SoftwareDevWorkerResult,
} from "../../orchestrator/software-dev-driver.ts";
import { buildCapabilityReport, parseHostModelReference, type HostCapabilityName } from "./capabilities.ts";
import { piLoader } from "./sdk-loaders.ts";

export class PiSdkSoftwareDevWorker implements SoftwareDevWorker {
  private readonly loader: () => Promise<unknown>;
  private readonly workingDirectory: string;
  private readonly implementationTimeoutMs: number;
  private readonly verificationTimeoutMs: number;

  constructor(options: {
    loader?: () => Promise<unknown>;
    workingDirectory: string;
    implementationTimeoutMs?: number;
    verificationTimeoutMs?: number;
  }) {
    this.loader = options.loader ?? piLoader;
    this.workingDirectory = options.workingDirectory;
    this.implementationTimeoutMs = options.implementationTimeoutMs ?? 300_000;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 180_000;
  }

  async runImplementation(input: SoftwareDevWorkerInput): Promise<SoftwareDevWorkerResult> {
    return await this.run("implement", input, this.implementationTimeoutMs, workspaceDirectory(input.worktree_path, this.workingDirectory));
  }

  async runVerification(input: SoftwareDevVerificationInput): Promise<SoftwareDevWorkerResult> {
    return await this.run("verify", input, this.verificationTimeoutMs, workspaceDirectory(input.worktree_path, this.workingDirectory));
  }

  async runRelease(input: SoftwareDevReleaseInput): Promise<SoftwareDevWorkerResult> {
    return await this.run("release", input, this.verificationTimeoutMs, workspaceDirectory(input.worktree_path, this.workingDirectory));
  }

  private async run(
    role: "implement" | "verify" | "release",
    input: SoftwareDevWorkerInput | SoftwareDevVerificationInput | SoftwareDevReleaseInput,
    fallbackTimeoutMs: number,
    workingDirectory = this.workingDirectory,
  ): Promise<SoftwareDevWorkerResult> {
    const timeoutMs = input.timeout_ms ?? fallbackTimeoutMs;
    const sdk = adaptPiSdk(await this.loader());
    const modelResolution = resolvePiModel(sdk, input.role?.model);
    const sessionManager = sdk.SessionManager.create(workingDirectory);
    const result = await sdk.createAgentSession({
      cwd: workingDirectory,
      agentDir: sdk.getAgentDir?.(),
      sessionManager,
      ...(modelResolution.model ? { model: modelResolution.model } : {}),
    });
    const session = adaptPiSession(result);
    await input.on_stream_session_started?.({
      stream_adapter: "pi",
      stream_session_id: session.sessionId,
      stream_root_session_id: session.sessionId,
      stream_child_run_id: `${session.sessionId}:${role}`,
    });
    const promptRun = startPromptForFinalAssistantText(session, input.prompt);
    let finalResponse: string;
    try {
      finalResponse = await withTimeout(
        promptRun.promise,
        timeoutMs,
        `PI_CREDENTIAL_MISSING: Pi ${role} worker timed out or could not authenticate`,
        promptRun.cleanup,
      );
    } finally {
      promptRun.cleanup();
    }
    if (!finalResponse) {
      throw new Error("PI_EMPTY_FINAL_RESPONSE: Pi worker did not produce final assistant text");
    }

    return {
      root_session_id: session.sessionId,
      child_run_id: `${session.sessionId}:${role}`,
      session_id: session.sessionId,
      final_response: finalResponse,
      shell_fallbacks: 0,
      capability_report: buildCapabilityReport({
        host: "pi",
        applied: modelResolution.applied,
        defaulted: [
          ...modelResolution.defaulted,
          ...(input.role?.agent ? ["agent" as const] : []),
        ],
        unsupported: [
          ...modelResolution.unsupported,
          ...((input.role?.load_skills.length ?? 0) > 0 ? ["load_skills" as const] : []),
        ],
      }),
    };
  }
}

function workspaceDirectory(worktreePath: string | undefined, fallback: string): string {
  if (!worktreePath || worktreePath.startsWith("agent-owned://")) return fallback;
  return worktreePath;
}

interface PiSdkAdapter {
  SessionManager: {
    create(cwd: string): unknown;
  };
  ModelRegistry?: {
    create(): {
      find(provider: string, modelId: string): unknown;
    };
  };
  getAgentDir?: () => string;
  createAgentSession(options: Record<string, unknown>): Promise<unknown>;
}

interface PiSessionAdapter {
  sessionId: string;
  subscribe(next: (event: unknown) => void): () => void;
  prompt(prompt: string): Promise<void>;
  dispose(): void;
}

function adaptPiSdk(raw: unknown): PiSdkAdapter {
  const sdk = raw as Partial<PiSdkAdapter>;
  if (typeof sdk.SessionManager?.create !== "function" || typeof sdk.createAgentSession !== "function") {
    throw new Error("HOST_SDK_CONFIG_INVALID: Pi SDK missing SessionManager.create or createAgentSession");
  }
  return sdk as PiSdkAdapter;
}

function adaptPiSession(raw: unknown): PiSessionAdapter {
  const session = (raw as { session?: Partial<PiSessionAdapter> }).session;
  if (
    !session
    || typeof session.sessionId !== "string"
    || session.sessionId.length === 0
    || typeof session.subscribe !== "function"
    || typeof session.prompt !== "function"
  ) {
    throw new Error("HOST_SDK_CONFIG_INVALID: Pi SDK agent session response missing session APIs");
  }
  return {
    sessionId: session.sessionId,
    subscribe: session.subscribe.bind(session),
    prompt: session.prompt.bind(session),
    dispose: typeof session.dispose === "function" ? session.dispose.bind(session) : () => {},
  };
}

function resolvePiModel(
  sdk: PiSdkAdapter,
  roleModel: string | undefined,
): { model?: unknown; applied: HostCapabilityName[]; defaulted: HostCapabilityName[]; unsupported: HostCapabilityName[] } {
  const reference = parseHostModelReference(roleModel);
  if (!reference?.provider) {
    return { defaulted: ["model"], applied: [], unsupported: [] };
  }

  if (sdk.ModelRegistry && typeof sdk.ModelRegistry.create !== "function") {
    throw new Error("HOST_SDK_CONFIG_INVALID: Pi SDK ModelRegistry missing create");
  }
  const registry = sdk.ModelRegistry?.create();
  if (registry && typeof registry.find !== "function") {
    throw new Error("HOST_SDK_CONFIG_INVALID: Pi SDK ModelRegistry missing find");
  }
  const model = registry?.find(reference.provider, reference.modelId);
  if (model) {
    return { model, applied: ["model"], defaulted: [], unsupported: [] };
  }
  return { applied: [], defaulted: [], unsupported: ["model"] };
}

function startPromptForFinalAssistantText(session: PiSessionAdapter, prompt: string): {
  promise: Promise<string>;
  cleanup: () => void;
} {
  let unsubscribe: (() => void) | undefined;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe?.();
    session.dispose();
  };
  try {
    let resolveFinalText: (text: string) => void = () => {};
    const finalText = new Promise<string>((resolve) => {
      resolveFinalText = resolve;
    });
    unsubscribe = session.subscribe((event) => {
      const text = extractFinalAssistantText(event);
      if (text !== undefined) resolveFinalText(text);
    });
    const promptSent = Promise.resolve().then(() => session.prompt(prompt));
    return {
      promise: Promise.all([promptSent, finalText]).then(([, text]) => text),
      cleanup,
    };
  } catch (error) {
    return {
      promise: Promise.reject(error),
      cleanup,
    };
  }
}

function extractFinalAssistantText(event: unknown): string | undefined {
  const value = event as { type?: unknown; messages?: unknown; willRetry?: unknown };
  if (value.type !== "agent_end" || !Array.isArray(value.messages)) return undefined;
  if (value.willRetry === true) return undefined;
  const assistantMessages = value.messages
    .filter((message): message is { role?: unknown; content?: unknown } => {
      return (message as { role?: unknown }).role === "assistant";
    });
  const lastAssistant = assistantMessages.at(-1);
  return extractMessageContentText(lastAssistant?.content).trim();
}

function extractMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch {
            // Cleanup must not mask the timeout error that controls retry behavior.
          }
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

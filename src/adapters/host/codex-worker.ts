import type {
  SoftwareDevReleaseInput,
  SoftwareDevVerificationInput,
  SoftwareDevWorker,
  SoftwareDevWorkerInput,
  SoftwareDevWorkerResult,
} from "../../orchestrator/software-dev-driver.ts";
import { buildCapabilityReport } from "./capabilities.ts";
import { codexLoader } from "./sdk-loaders.ts";

export class CodexSdkSoftwareDevWorker implements SoftwareDevWorker {
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
    this.loader = options.loader ?? codexLoader;
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
    const sdk = await this.loader();
    const Codex = (sdk as {
      Codex?: new () => {
        startThread(options: Record<string, unknown>): CodexThread;
      };
    }).Codex;
    if (!Codex) {
      throw new Error("HOST_SDK_CONFIG_INVALID: @openai/codex-sdk does not export Codex");
    }

    const codex = new Codex();
    const root = codex.startThread({
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
      approvalPolicy: "never",
      modelReasoningEffort: "low",
    });
    const turn = await withTimeout(
      runCodexTurn(root, input.prompt, role, input.on_stream_session_started),
      timeoutMs,
      `CODEX_CREDENTIAL_MISSING: Codex ${role} worker timed out or could not authenticate`,
    );
    return {
      root_session_id: turn.threadId,
      child_run_id: `${turn.threadId}:${role}`,
      session_id: turn.threadId,
      final_response: turn.finalResponse,
      shell_fallbacks: 0,
      capability_report: buildCapabilityReport({
        host: "codex",
        unsupported: [
          ...(input.role?.agent ? ["agent" as const] : []),
          ...(input.role?.model ? ["model" as const] : []),
          ...((input.role?.load_skills.length ?? 0) > 0 ? ["load_skills" as const] : []),
        ],
      }),
    };
  }
}

interface CodexThread {
  id: string | null;
  run?: (prompt: string) => Promise<{ finalResponse?: string }>;
  runStreamed?: (prompt: string) => Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
}

interface CodexThreadEvent {
  type?: string;
  thread_id?: unknown;
  item?: {
    type?: unknown;
    text?: unknown;
  };
  error?: {
    message?: unknown;
  };
  message?: unknown;
}

async function runCodexTurn(
  root: CodexThread,
  prompt: string,
  role: "implement" | "verify" | "release",
  onStreamSessionStarted: SoftwareDevWorkerInput["on_stream_session_started"],
): Promise<{ threadId: string; finalResponse: string }> {
  if (root.runStreamed) {
    const streamed = await root.runStreamed(prompt);
    let threadId = nonEmptyString(root.id);
    let streamReported = false;
    let finalResponse = "";
    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        threadId = requireNonEmptyString(event.thread_id, "HOST_SDK_CONFIG_INVALID: Codex SDK thread.started event missing thread_id");
      }
      if (!streamReported && threadId) {
        await reportCodexStreamSession(threadId, role, onStreamSessionStarted);
        streamReported = true;
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        finalResponse = event.item.text;
      } else if (event.type === "turn.failed") {
        throw new Error(String(event.error?.message ?? "Codex turn failed"));
      } else if (event.type === "error") {
        throw new Error(String(event.message ?? "Codex stream failed"));
      }
    }
    if (!threadId) {
      throw new Error("HOST_SDK_CONFIG_INVALID: Codex SDK did not provide thread id");
    }
    if (!streamReported) {
      await reportCodexStreamSession(threadId, role, onStreamSessionStarted);
    }
    return { threadId, finalResponse };
  }

  if (!root.run) {
    throw new Error("HOST_SDK_CONFIG_INVALID: Codex SDK thread missing run APIs");
  }
  const threadId = requireNonEmptyString(root.id, "HOST_SDK_CONFIG_INVALID: Codex SDK thread missing id");
  await reportCodexStreamSession(threadId, role, onStreamSessionStarted);
  const turn = await root.run(prompt);
  return { threadId, finalResponse: turn.finalResponse ?? "" };
}

async function reportCodexStreamSession(
  threadId: string,
  role: "implement" | "verify" | "release",
  onStreamSessionStarted: SoftwareDevWorkerInput["on_stream_session_started"],
): Promise<void> {
  await onStreamSessionStarted?.({
    stream_adapter: "codex",
    stream_session_id: threadId,
    stream_root_session_id: threadId,
    stream_child_run_id: `${threadId}:${role}`,
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNonEmptyString(value: unknown, message: string): string {
  const text = nonEmptyString(value);
  if (!text) throw new Error(message);
  return text;
}

function workspaceDirectory(worktreePath: string | undefined, fallback: string): string {
  if (!worktreePath || worktreePath.startsWith("agent-owned://")) return fallback;
  return worktreePath;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

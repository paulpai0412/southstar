import type {
  SoftwareDevReleaseInput,
  SoftwareDevVerificationInput,
  SoftwareDevWorker,
  SoftwareDevWorkerInput,
  SoftwareDevWorkerResult,
} from "../../orchestrator/software-dev-driver.ts";
import { buildCapabilityReport } from "./capabilities.ts";
import { openCodeLoader } from "./sdk-loaders.ts";

export class OpenCodeSdkSoftwareDevWorker implements SoftwareDevWorker {
  private readonly loader: () => Promise<unknown>;
  private readonly workingDirectory: string;
  private readonly implementationTimeoutMs: number;
  private readonly verificationTimeoutMs: number;
  private closeClient: (() => void) | undefined;

  constructor(options: {
    loader?: () => Promise<unknown>;
    workingDirectory: string;
    implementationTimeoutMs?: number;
    verificationTimeoutMs?: number;
  }) {
    this.loader = options.loader ?? openCodeLoader;
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

  async dispose(): Promise<void> {
    this.closeClient?.();
  }

  private async run(
    role: "implement" | "verify" | "release",
    input: SoftwareDevWorkerInput | SoftwareDevVerificationInput | SoftwareDevReleaseInput,
    fallbackTimeoutMs: number,
    workingDirectory = this.workingDirectory,
  ): Promise<SoftwareDevWorkerResult> {
    const timeoutMs = input.timeout_ms ?? fallbackTimeoutMs;
    const agent = input.role?.agent ?? "build";
    const client = await this.client();
    const root = await withTimeout(client.startRoot(input.prompt, workingDirectory, agent), timeoutMs, `OPENCODE_CREDENTIAL_MISSING: OpenCode ${role} root session timed out or could not authenticate`);
    await input.on_stream_session_started?.({
      stream_adapter: "opencode",
      stream_session_id: root.id,
      stream_root_session_id: root.id,
    });
    const child = await withTimeout(client.startChild(root.id, input.prompt, workingDirectory), timeoutMs, `OPENCODE_CREDENTIAL_MISSING: OpenCode ${role} child run timed out or could not authenticate`);
    return {
      root_session_id: root.id,
      child_run_id: child.id,
      session_id: child.sessionId,
      final_response: child.finalResponse,
      shell_fallbacks: 0,
      capability_report: buildCapabilityReport({
        host: "opencode",
        applied: input.role?.agent ? ["agent"] : [],
        unsupported: [
          ...(input.role?.model ? ["model" as const] : []),
          ...((input.role?.load_skills.length ?? 0) > 0 ? ["load_skills" as const] : []),
        ],
      }),
    };
  }

  private async client(): Promise<OpenCodeClientAdapter> {
    const sdk = await this.loader();
    const value = sdk as {
      createOpencode?: (options?: Record<string, unknown>) => Promise<{ client: unknown; server?: { close(): void } }>;
      OpenCode?: new () => LegacyOpenCodeClient;
      createClient?: () => LegacyOpenCodeClient;
    };
    if (value.createOpencode) {
      const result = await value.createOpencode({
        port: 0,
        timeout: 15_000,
        config: { logLevel: "ERROR" },
      });
      this.closeClient = () => result.server?.close();
      return adaptCurrentOpenCodeClient(result.client);
    }
    const legacy = value.OpenCode ? new value.OpenCode() : value.createClient?.();
    if (legacy) return adaptLegacyOpenCodeClient(legacy);
    throw new Error("HOST_SDK_CONFIG_INVALID: OpenCode SDK missing createOpencode");
  }
}

function workspaceDirectory(worktreePath: string | undefined, fallback: string): string {
  if (!worktreePath || worktreePath.startsWith("agent-owned://")) return fallback;
  return worktreePath;
}

interface OpenCodeClientAdapter {
  startRoot(prompt: string, workingDirectory: string, agent: string): Promise<{ id: string }>;
  startChild(rootSessionId: string, prompt: string, workingDirectory: string): Promise<{ id: string; sessionId: string; finalResponse: string }>;
}

interface LegacyOpenCodeClient {
  startSession?: (options: Record<string, unknown>) => Promise<{ id?: string }>;
  startChild?: (options: Record<string, unknown>) => Promise<{ id?: string; sessionId?: string; finalResponse?: string }>;
}

interface CurrentOpenCodeClient {
  session?: {
    create?: (options: Record<string, unknown>) => Promise<unknown>;
    prompt?: (options: Record<string, unknown>) => Promise<unknown>;
  };
}

function adaptLegacyOpenCodeClient(raw: LegacyOpenCodeClient): OpenCodeClientAdapter {
  if (!raw.startSession || !raw.startChild) {
    throw new Error("HOST_SDK_CONFIG_INVALID: OpenCode SDK missing session APIs");
  }
  return {
    async startRoot(prompt: string, _workingDirectory: string, agent: string) {
      const result = await raw.startSession?.({ prompt, agent });
      if (!result?.id) throw new Error("HOST_SDK_CONFIG_INVALID: OpenCode SDK root session response missing id");
      return { id: result.id };
    },
    async startChild(rootSessionId: string, prompt: string) {
      const result = await raw.startChild?.({ rootSessionId, prompt });
      if (!result?.id) throw new Error("HOST_SDK_CONFIG_INVALID: OpenCode SDK child response missing id");
      return {
        id: result.id,
        sessionId: result.sessionId ?? result.id,
        finalResponse: result.finalResponse ?? "",
      };
    },
  };
}

function adaptCurrentOpenCodeClient(rawClient: unknown): OpenCodeClientAdapter {
  const raw = rawClient as CurrentOpenCodeClient;
  if (!raw.session?.create || !raw.session?.prompt) {
    throw new Error("HOST_SDK_CONFIG_INVALID: OpenCode SDK missing session APIs");
  }
  return {
    async startRoot(prompt: string, workingDirectory: string, agent: string) {
      const result = await raw.session?.create?.({
        body: { title: prompt.slice(0, 80), agent },
        query: { directory: workingDirectory },
      });
      const data = unwrapOpenCodeResponse<{ id?: string }>(result, "OpenCode SDK root session create failed");
      if (!data.id) throw new Error("HOST_SDK_CONFIG_INVALID: OpenCode SDK root session response missing id");
      return { id: data.id };
    },
    async startChild(rootSessionId: string, prompt: string, workingDirectory: string) {
      const result = await raw.session?.prompt?.({
        path: { id: rootSessionId },
        query: { directory: workingDirectory },
        body: { parts: [{ type: "text", text: prompt }] },
      });
      const data = unwrapOpenCodeResponse<{ info?: { id?: string }; parts?: Array<Record<string, unknown>> }>(result, "OpenCode SDK child prompt failed");
      const id = data.info?.id ?? `${rootSessionId}:message`;
      return {
        id,
        sessionId: rootSessionId,
        finalResponse: extractOpenCodeText(data.parts) || JSON.stringify({ status: "ok", message_id: id }),
      };
    },
  };
}

function unwrapOpenCodeResponse<T>(result: unknown, message: string): T {
  const response = result as { data?: T; error?: unknown };
  if (response.error) {
    throw new Error(`${message}: ${formatOpenCodeError(response.error)}`);
  }
  if (response.data === undefined) {
    throw new Error(`${message}: missing response data`);
  }
  return response.data;
}

function extractOpenCodeText(parts: Array<Record<string, unknown>> | undefined): string {
  if (!parts) return "";
  return parts
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function formatOpenCodeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
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

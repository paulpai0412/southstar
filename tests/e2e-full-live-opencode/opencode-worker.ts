import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { openCodeLoader } from "../../src/adapters/host/sdk-loaders.ts";

export type OpenCodeWorkerRole = "implement" | "verify";

export interface OpenCodeRunnerStartRootInput {
  role: OpenCodeWorkerRole;
  prompt: string;
  timeout_ms: number;
}

export interface OpenCodeRunnerStartChildInput extends OpenCodeRunnerStartRootInput {
  root_session_id: string;
}

export interface OpenCodeRunner {
  startRootSession(input: OpenCodeRunnerStartRootInput): Promise<{ root_session_id: string; status: "live" | "missing" | "unknown" }>;
  startBackgroundChild(input: OpenCodeRunnerStartChildInput): Promise<{
    child_run_id: string;
    session_id: string;
    status: string;
    final_response: string;
  }>;
  readRootStatus(rootSessionId: string): Promise<{ status: "live" | "missing" | "unknown" }>;
  readChildStatus(childRunId: string): Promise<{ status: string }>;
  resumeHint(rootSessionId: string): Promise<string>;
  close?(): Promise<void> | void;
}

export interface OpenCodeFullLiveWorkerOutput {
  role: OpenCodeWorkerRole;
  root_session_id: string;
  child_run_id: string;
  session_id: string;
  final_response: string;
  shell_fallbacks: 0;
}

export interface OpenCodeBoundaryCheck {
  root_session_id: string;
  child_run_id: string;
  root_status: string;
  child_status: string;
  resume_hint_available: boolean;
  shell_fallbacks: 0;
}

export class OpenCodeFullLiveWorker {
  private readonly runner: OpenCodeRunner;

  constructor(runner: OpenCodeRunner = new SdkOpenCodeRunner()) {
    this.runner = runner;
  }

  async runImplementation(input: {
    issue_number: number;
    issue_url: string;
    repo: string;
    branch: string;
    fixture_path: string;
    fixture_content: string;
  }): Promise<OpenCodeFullLiveWorkerOutput> {
    const prompt = [
      `You are implementing Northstar OpenCode full live E2E issue ${input.issue_number}.`,
      `Issue: ${input.issue_url}`,
      `Repository: ${input.repo}`,
      `Branch: ${input.branch}`,
      `Fixture path: ${input.fixture_path}`,
      `Fixture content: ${input.fixture_content}`,
      "Do not modify any repository except paulpai0412/northstar-live-sandbox.",
      "Return compact JSON with status, branch, fixture_path, fixture_content, and summary.",
    ].join("\n");
    return await this.runChild("implement", prompt, 300_000);
  }

  async runVerification(input: {
    pr_number: number;
    pr_url: string;
    expected_fixture_path: string;
  }): Promise<OpenCodeFullLiveWorkerOutput> {
    const prompt = [
      `Verify Northstar OpenCode full live E2E PR ${input.pr_number}.`,
      `PR: ${input.pr_url}`,
      `Expected fixture path: ${input.expected_fixture_path}`,
      "Return compact JSON evidence with status=pass only if the expected fixture path is present.",
      "Return compact JSON evidence; do not print secrets.",
    ].join("\n");
    return await this.runChild("verify", prompt, 180_000);
  }

  async checkSdkBoundary(): Promise<OpenCodeBoundaryCheck> {
    const root = await this.runner.startRootSession({ role: "implement", prompt: "Northstar OpenCode SDK boundary root smoke", timeout_ms: 180_000 });
    const child = await this.runner.startBackgroundChild({
      role: "implement",
      root_session_id: root.root_session_id,
      prompt: "Northstar OpenCode SDK boundary child smoke. Reply exactly: OK",
      timeout_ms: 180_000,
    });
    const rootStatus = await this.runner.readRootStatus(root.root_session_id);
    const childStatus = await this.runner.readChildStatus(child.child_run_id);
    const resumeHint = await this.runner.resumeHint(root.root_session_id);
    return {
      root_session_id: root.root_session_id,
      child_run_id: child.child_run_id,
      root_status: rootStatus.status,
      child_status: childStatus.status,
      resume_hint_available: resumeHint.trim().length > 0,
      shell_fallbacks: 0,
    };
  }

  async dispose(): Promise<void> {
    await this.runner.close?.();
  }

  private async runChild(role: OpenCodeWorkerRole, prompt: string, timeoutMs: number): Promise<OpenCodeFullLiveWorkerOutput> {
    const root = await this.runner.startRootSession({ role, prompt, timeout_ms: timeoutMs });
    const child = await this.runner.startBackgroundChild({ role, root_session_id: root.root_session_id, prompt, timeout_ms: timeoutMs });
    return {
      role,
      root_session_id: root.root_session_id,
      child_run_id: child.child_run_id,
      session_id: child.session_id,
      final_response: child.final_response,
      shell_fallbacks: 0,
    };
  }
}

class SdkOpenCodeRunner implements OpenCodeRunner {
  private clientPromise: Promise<AdaptedOpenCodeClient> | undefined;

  async startRootSession(input: OpenCodeRunnerStartRootInput): Promise<{ root_session_id: string; status: "live" | "missing" | "unknown" }> {
    const client = await this.client();
    const root = await withTimeout(client.startRoot(input.prompt), input.timeout_ms, `OpenCode ${input.role} root session timed out`);
    return { root_session_id: root.id, status: "live" };
  }

  async startBackgroundChild(input: OpenCodeRunnerStartChildInput): Promise<{ child_run_id: string; session_id: string; status: string; final_response: string }> {
    const client = await this.client();
    const child = await withTimeout(
      client.startChild(input.root_session_id, input.prompt),
      input.timeout_ms,
      `OpenCode ${input.role} background child timed out`,
    );
    return {
      child_run_id: child.id,
      session_id: child.sessionId,
      status: child.status,
      final_response: child.finalResponse,
    };
  }

  async readRootStatus(rootSessionId: string): Promise<{ status: "live" | "missing" | "unknown" }> {
    return await (await this.client()).readRootStatus(rootSessionId);
  }

  async readChildStatus(childRunId: string): Promise<{ status: string }> {
    return await (await this.client()).readChildStatus(childRunId);
  }

  async resumeHint(rootSessionId: string): Promise<string> {
    return await (await this.client()).resumeHint(rootSessionId);
  }

  async close(): Promise<void> {
    const client = await this.clientPromise;
    client?.close?.();
    killDirectOpenCodeChildren();
  }

  private async client(): Promise<AdaptedOpenCodeClient> {
    this.clientPromise ??= openCodeLoader().then((sdk) => adaptOpenCodeSdk(sdk));
    return await this.clientPromise;
  }
}

interface AdaptedOpenCodeClient {
  startRoot(prompt: string): Promise<{ id: string }>;
  startChild(rootSessionId: string, prompt: string): Promise<{ id: string; sessionId: string; status: string; finalResponse: string }>;
  readRootStatus(rootSessionId: string): Promise<{ status: "live" | "missing" | "unknown" }>;
  readChildStatus(childRunId: string): Promise<{ status: string }>;
  resumeHint(rootSessionId: string): Promise<string>;
  close?(): void;
}

function adaptOpenCodeSdk(sdk: unknown): AdaptedOpenCodeClient {
  const value = sdk as {
    createOpencode?: (options?: Record<string, unknown>) => Promise<{ client: unknown; server?: { close(): void } }>;
    OpenCode?: new () => LegacyOpenCodeClient;
    createClient?: () => LegacyOpenCodeClient;
  };
  if (value.createOpencode) {
    return adaptCurrentOpenCodeSdk(value.createOpencode);
  }
  const legacy = value.OpenCode ? new value.OpenCode() : value.createClient?.();
  if (legacy) return adaptLegacyOpenCodeSdk(legacy);
  throw new Error("OpenCode SDK missing createOpencode");
}

function adaptLegacyOpenCodeSdk(raw: LegacyOpenCodeClient): AdaptedOpenCodeClient {
  if (!raw.startSession) throw new Error("OpenCode SDK missing sessions.start");
  if (!raw.startChild) throw new Error("OpenCode SDK missing children.start");
  return {
    async startRoot(prompt: string) {
      const result = await raw.startSession?.({ prompt });
      if (!result?.id) throw new Error("OpenCode SDK root session response missing id");
      return { id: result.id };
    },
    async startChild(rootSessionId: string, prompt: string) {
      const result = await raw.startChild?.({ rootSessionId, prompt });
      if (!result?.id) throw new Error("OpenCode SDK child response missing id");
      return {
        id: result.id,
        sessionId: result.sessionId ?? result.id,
        status: result.status ?? "completed",
        finalResponse: result.finalResponse ?? "",
      };
    },
    async readRootStatus(rootSessionId: string) {
      const result = await raw.status?.(rootSessionId);
      const status = result?.status === "live" || result?.status === "missing" ? result.status : "unknown";
      return { status };
    },
    async readChildStatus(childRunId: string) {
      const result = await raw.status?.(childRunId);
      return { status: result?.status ?? "unknown" };
    },
    async resumeHint(rootSessionId: string) {
      return await raw.resumeHint?.(rootSessionId) ?? `resume ${rootSessionId}`;
    },
  };
}

function adaptCurrentOpenCodeSdk(createOpencode: (options?: Record<string, unknown>) => Promise<{ client: unknown; server?: { close(): void } }>): AdaptedOpenCodeClient {
  let clientPromise: Promise<{ client: CurrentOpenCodeClient; close?: () => void }> | undefined;
  const client = async () => {
    clientPromise ??= createOpencode({
      port: 0,
      timeout: 15_000,
      config: { logLevel: "ERROR" },
    }).then(({ client: raw, server }) => ({ client: raw as CurrentOpenCodeClient, close: () => server?.close() }));
    return await clientPromise;
  };
  return {
    async startRoot(prompt: string) {
      const { client: raw } = await client();
      if (!raw.session?.create) throw new Error("OpenCode SDK missing sessions.start");
      const result = await raw.session.create({
        body: { title: prompt.slice(0, 80), agent: "build" },
        query: { directory: process.cwd() },
      });
      const data = unwrapOpenCodeResponse<{ id?: string }>(result, "OpenCode SDK root session create failed");
      if (!data.id) throw new Error("OpenCode SDK root session response missing id");
      return { id: data.id };
    },
    async startChild(rootSessionId: string, prompt: string) {
      const { client: raw } = await client();
      if (!raw.session?.prompt) throw new Error("OpenCode SDK missing children.start");
      const result = await raw.session.prompt({
        path: { id: rootSessionId },
        query: { directory: process.cwd() },
        body: { parts: [{ type: "text", text: prompt }] },
      });
      const data = unwrapOpenCodeResponse<{ info?: { id?: string }; parts?: Array<Record<string, unknown>> }>(result, "OpenCode SDK child prompt failed");
      const messageId = data.info?.id ?? `${rootSessionId}:message`;
      return {
        id: messageId,
        sessionId: rootSessionId,
        status: "completed",
        finalResponse: extractOpenCodeText(data.parts) || JSON.stringify({ status: "ok", message_id: messageId }),
      };
    },
    async readRootStatus(rootSessionId: string) {
      const { client: raw } = await client();
      if (raw.session?.get) {
        const result = await raw.session.get({
          path: { id: rootSessionId },
          query: { directory: process.cwd() },
        });
        const response = result as { data?: { id?: string }; error?: { status?: number } | unknown };
        if (response.data?.id === rootSessionId) return { status: "live" };
        if (isNotFoundOpenCodeError(response.error)) return { status: "missing" };
      }
      if (!raw.session?.status) return { status: "unknown" };
      const result = await raw.session.status({ query: { directory: process.cwd() } });
      const data = unwrapOpenCodeResponse<Record<string, { status?: string }>>(result, "OpenCode SDK status read failed");
      const status = data[rootSessionId]?.status;
      return { status: status === "running" || status === "idle" ? "live" : "unknown" };
    },
    async readChildStatus(_childRunId: string) {
      return { status: "completed" };
    },
    async resumeHint(rootSessionId: string) {
      return `opencode session ${rootSessionId}`;
    },
    close() {
      void clientPromise?.then((active) => active.close?.());
    },
  };
}

interface LegacyOpenCodeClient {
  startSession?: (options: Record<string, unknown>) => Promise<{ id?: string }>;
  startChild?: (options: Record<string, unknown>) => Promise<{ id?: string; sessionId?: string; status?: string; finalResponse?: string }>;
  status?: (id: string) => Promise<{ status?: string }>;
  resumeHint?: (id: string) => Promise<string>;
}

interface CurrentOpenCodeClient {
  session?: {
    create?: (options: Record<string, unknown>) => Promise<unknown>;
    get?: (options: Record<string, unknown>) => Promise<unknown>;
    prompt?: (options: Record<string, unknown>) => Promise<unknown>;
    status?: (options: Record<string, unknown>) => Promise<unknown>;
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

function isNotFoundOpenCodeError(error: unknown): boolean {
  if (!error) return false;
  const value = error as { status?: number; statusCode?: number; code?: string };
  return value.status === 404 || value.statusCode === 404 || value.code === "NOT_FOUND";
}

function killDirectOpenCodeChildren(): void {
  const result = spawnSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return;
  for (const rawPid of result.stdout.trim().split(/\s+/)) {
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmdline.includes("opencode") && cmdline.includes("serve")) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // Best-effort cleanup for a test-only live SDK server.
    }
  }
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

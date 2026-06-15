import type { ExecutorBindingStatus } from "../provider.ts";
import type { CubeCommandStatus, CubeSandboxSdkClient, CubeSandboxStatus } from "./types.ts";

export type E2bCompatibleCubeSandboxSdkClientOptions = {
  apiUrl: string;
  apiKey: string;
  sdkCallTimeoutSeconds: number;
};

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function mapCubeCommandStatus(status: CubeCommandStatus): ExecutorBindingStatus {
  const normalized = status.status.toLowerCase();
  if (["running", "started"].includes(normalized)) return "running";
  if (["queued", "pending"].includes(normalized)) return "queued";
  if (["starting", "created"].includes(normalized)) return "starting";
  if (["cancelled", "canceled", "killed"].includes(normalized)) return "cancelled";
  if (["failed", "error", "errored"].includes(normalized)) return "failed";
  if (["finished", "completed", "succeeded", "success"].includes(normalized)) {
    return status.exitCode === 0 ? "completed" : "failed";
  }
  return "unknown";
}

export function createE2bCompatibleCubeSandboxSdkClient(options: E2bCompatibleCubeSandboxSdkClientOptions): CubeSandboxSdkClient {
  const timeoutMs = Math.max(1, options.sdkCallTimeoutSeconds * 1000);
  return new HttpFallbackCubeSandboxSdkClient(options.apiUrl, options.apiKey, timeoutMs);
}

class HttpFallbackCubeSandboxSdkClient implements CubeSandboxSdkClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, apiKey: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async health(): Promise<void> {
    const response = await withTimeout(fetch(`${this.baseUrl}/health`, {
      method: "GET",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox health");
    if (!response.ok) {
      throw new Error(`CubeSandbox health failed: ${response.status} ${await response.text()}`);
    }
  }

  async createSandbox(input: {
    templateId: string;
    metadata: Record<string, string>;
    timeoutSeconds: number;
    hostMounts: Array<{ source: string; target: string; readonly: boolean }>;
  }): Promise<{ sandboxId: string }> {
    const payload = {
      templateID: input.templateId,
      metadata: {
        ...input.metadata,
        hostMounts: JSON.stringify(input.hostMounts),
      },
      timeout: input.timeoutSeconds,
    };
    const response = await withTimeout(fetch(`${this.baseUrl}/sandboxes`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    }), this.timeoutMs, "cubesandbox createSandbox");
    const text = await response.text();
    if (!response.ok) throw new Error(`CubeSandbox createSandbox failed: ${response.status} ${text}`);
    const parsed = JSON.parse(text) as { id?: string; sandboxID?: string };
    const sandboxId = parsed.id ?? parsed.sandboxID;
    if (!sandboxId) throw new Error("CubeSandbox createSandbox response missing sandbox id");
    return { sandboxId };
  }

  async runCommand(input: {
    sandboxId: string;
    command: string[];
    env: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<{ commandId: string }> {
    const commandText = input.command.join(" ");
    const payload = {
      cmd: commandText,
      env: input.env,
      timeout: input.timeoutSeconds,
    };
    const response = await withTimeout(fetch(`${this.baseUrl}/cubeapi/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/commands`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    }), this.timeoutMs, "cubesandbox runCommand");
    const text = await response.text();
    if (!response.ok) throw new Error(`CubeSandbox runCommand failed: ${response.status} ${text}`);
    const parsed = JSON.parse(text) as { id?: string; commandId?: string };
    const commandId = parsed.id ?? parsed.commandId;
    if (!commandId) throw new Error("CubeSandbox runCommand response missing command id");
    return { commandId };
  }

  async getSandbox(input: { sandboxId: string }): Promise<CubeSandboxStatus> {
    const response = await withTimeout(fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(input.sandboxId)}`, {
      method: "GET",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox getSandbox");
    const text = await response.text();
    if (!response.ok) throw new Error(`CubeSandbox getSandbox failed: ${response.status} ${text}`);
    const parsed = JSON.parse(text) as { id?: string; sandboxID?: string; status?: string; metadata?: Record<string, string> };
    return {
      sandboxId: parsed.id ?? parsed.sandboxID ?? input.sandboxId,
      status: parsed.status ?? "unknown",
      metadata: parsed.metadata,
    };
  }

  async getCommand(input: { sandboxId: string; commandId: string }): Promise<CubeCommandStatus> {
    const response = await withTimeout(fetch(`${this.baseUrl}/cubeapi/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/commands/${encodeURIComponent(input.commandId)}`, {
      method: "GET",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox getCommand");
    const text = await response.text();
    if (!response.ok) throw new Error(`CubeSandbox getCommand failed: ${response.status} ${text}`);
    const parsed = JSON.parse(text) as {
      id?: string;
      commandId?: string;
      status?: string;
      exitCode?: number;
      startedAt?: string;
      finishedAt?: string;
    };
    return {
      commandId: parsed.id ?? parsed.commandId ?? input.commandId,
      status: parsed.status ?? "unknown",
      exitCode: parsed.exitCode,
      startedAt: parsed.startedAt,
      finishedAt: parsed.finishedAt,
    };
  }

  async killCommand(input: { sandboxId: string; commandId: string }): Promise<void> {
    const response = await withTimeout(fetch(`${this.baseUrl}/cubeapi/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/commands/${encodeURIComponent(input.commandId)}`, {
      method: "DELETE",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox killCommand");
    if (!response.ok && response.status !== 404) {
      throw new Error(`CubeSandbox killCommand failed: ${response.status} ${await response.text()}`);
    }
  }

  async destroySandbox(input: { sandboxId: string }): Promise<void> {
    const response = await withTimeout(fetch(`${this.baseUrl}/sandboxes/${encodeURIComponent(input.sandboxId)}`, {
      method: "DELETE",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox destroySandbox");
    if (!response.ok && response.status !== 404) {
      throw new Error(`CubeSandbox destroySandbox failed: ${response.status} ${await response.text()}`);
    }
  }

  async listSandboxes(input: { metadata?: Record<string, string> }): Promise<CubeSandboxStatus[]> {
    const response = await withTimeout(fetch(`${this.baseUrl}/sandboxes`, {
      method: "GET",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox listSandboxes");
    const text = await response.text();
    if (!response.ok) throw new Error(`CubeSandbox listSandboxes failed: ${response.status} ${text}`);
    const parsed = JSON.parse(text) as { items?: Array<{ id?: string; sandboxID?: string; status?: string; metadata?: Record<string, string> }> };
    return (parsed.items ?? [])
      .map((item) => ({
        sandboxId: item.id ?? item.sandboxID ?? "",
        status: item.status ?? "unknown",
        metadata: item.metadata,
      }))
      .filter((item) => item.sandboxId.length > 0)
      .filter((item) => {
        if (!input.metadata) return true;
        const metadata = item.metadata ?? {};
        return Object.entries(input.metadata).every(([key, expected]) => metadata[key] === expected);
      });
  }

  async logs(input: { sandboxId: string; commandId?: string; cursor?: string }): Promise<{ text: string; cursor?: string }> {
    const path = input.commandId
      ? `/cubeapi/v1/sandboxes/${encodeURIComponent(input.sandboxId)}/commands/${encodeURIComponent(input.commandId)}/logs`
      : `/sandboxes/${encodeURIComponent(input.sandboxId)}/logs`;
    const query = input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : "";
    const response = await withTimeout(fetch(`${this.baseUrl}${path}${query}`, {
      method: "GET",
      headers: this.headers(),
    }), this.timeoutMs, "cubesandbox logs");
    if (!response.ok) {
      return { text: "" };
    }
    const text = await response.text();
    const nextCursor = response.headers.get("x-next-cursor") ?? undefined;
    return { text, cursor: nextCursor };
  }

  private headers() {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
    };
  }
}

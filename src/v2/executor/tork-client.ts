import type { TorkAdapterCapabilities, TorkJobObservation } from "./provider.ts";
import type { TorkJobProjection } from "./tork-projection.ts";

export type TorkClientOptions = {
  baseUrl: string;
  submitPath?: string;
  requestTimeoutMs?: number;
  retryCount?: number;
  retryBackoffMs?: number;
};

export type TorkSubmitResult = {
  jobId: string;
  status: string;
};

export class TorkClient {
  private readonly baseUrl: string;
  private readonly submitPath: string;
  private readonly requestTimeoutMs: number;
  private readonly retryCount: number;
  private readonly retryBackoffMs: number;

  constructor(options: TorkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.submitPath = options.submitPath ?? "/jobs";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.retryCount = options.retryCount ?? 1;
    this.retryBackoffMs = options.retryBackoffMs ?? 200;
  }

  async submit(projection: TorkJobProjection): Promise<TorkSubmitResult> {
    const response = await this.fetchWithRetry(`${this.baseUrl}${this.submitPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toTorkJobPayload(projection.job)),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Tork submit failed: ${response.status} ${text}`);
    }
    const payload = JSON.parse(text) as { id?: string; job_id?: string; status?: string; state?: string };
    const jobId = payload.id ?? payload.job_id;
    if (!jobId) {
      throw new Error("Tork submit response missing job id");
    }
    return { jobId, status: payload.status ?? payload.state ?? "submitted" };
  }

  capabilities(): TorkAdapterCapabilities {
    return {
      supportsJobInspect: true,
      supportsTaskInspect: false,
      supportsJobCancel: true,
      supportsTaskCancel: false,
      supportsJobLogs: true,
      supportsTaskLogs: false,
      supportsWorkerHealth: false,
    };
  }

  async getJob(jobId: string): Promise<unknown> {
    const response = await this.fetchJobEndpoint(jobId, ["", "/api/v1"]);
    return await response.json() as unknown;
  }

  async getJobObservation(jobId: string): Promise<TorkJobObservation> {
    const payload = await this.getJob(jobId) as {
      id?: string;
      job_id?: string;
      status?: string;
      state?: string;
    };
    return {
      jobId: payload.id ?? payload.job_id ?? jobId,
      status: payload.status ?? payload.state ?? "UNKNOWN",
      raw: payload,
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const response = await this.fetchJobEndpoint(jobId, ["", "/api/v1"], { method: "DELETE" });
    if (!response.ok) throw new Error(`Tork cancel failed: ${response.status} ${await response.text()}`);
  }

  async getJobLogs(jobId: string): Promise<string> {
    const encoded = encodeURIComponent(jobId);
    for (const prefix of ["", "/api/v1"]) {
      const response = await this.fetchWithRetry(`${this.baseUrl}${prefix}/jobs/${encoded}/logs`, undefined, {
        retryOnStatuses: [408, 429, 500, 502, 503, 504],
      });
      if (response.ok) return await response.text();
      if (response.status !== 404) throw new Error(`Tork logs failed: ${response.status} ${await response.text()}`);
    }
    return "";
  }

  private async fetchJobEndpoint(jobId: string, prefixes: string[], init?: RequestInit): Promise<Response> {
    const encoded = encodeURIComponent(jobId);
    let last: Response | undefined;
    for (const prefix of prefixes) {
      const response = await this.fetchWithRetry(`${this.baseUrl}${prefix}/jobs/${encoded}`, init, {
        retryOnStatuses: [408, 429, 500, 502, 503, 504],
      });
      if (response.ok || response.status !== 404) return response;
      last = response;
    }
    throw new Error(`Tork job request failed: ${last?.status ?? 404} ${last ? await last.text() : "not found"}`);
  }

  private async fetchWithRetry(
    url: string,
    init?: RequestInit,
    options?: { retryOnStatuses?: number[] },
  ): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("timeout")), this.requestTimeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const retryOnStatuses = options?.retryOnStatuses ?? [408, 429, 500, 502, 503, 504];
        if (retryOnStatuses.includes(response.status) && attempt < this.retryCount) {
          await sleep(this.retryBackoffMs * (attempt + 1));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= this.retryCount) {
          const message = lastError.name === "AbortError"
            ? `Tork request timeout after ${this.requestTimeoutMs}ms`
            : `Tork request failed: ${lastError.message}`;
          throw new Error(message);
        }
        await sleep(this.retryBackoffMs * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`Tork request failed: ${lastError?.message ?? "unknown error"}`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toTorkJobPayload(job: TorkJobProjection["job"]) {
  return {
    name: job.name,
    tasks: job.tasks.map((task) => ({
      name: task.name,
      image: task.image,
      cmd: task.command,
      env: task.env,
      mounts: task.mounts.map((mount) => ({
        type: "bind",
        source: mount.source,
        target: mount.target,
        ...(mount.readonly ? { opts: { readonly: "true" } } : {}),
      })),
      timeout: `${task.timeoutSeconds}s`,
      retry: { limit: task.retry.maxAttempts },
    })),
  };
}

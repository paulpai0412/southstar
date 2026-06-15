import type { TorkJobProjection } from "./tork-projection.ts";

export type TorkClientOptions = {
  baseUrl: string;
  submitPath?: string;
};

export type TorkSubmitResult = {
  jobId: string;
  status: string;
};

export class TorkClient {
  private readonly baseUrl: string;
  private readonly submitPath: string;

  constructor(options: TorkClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.submitPath = options.submitPath ?? "/jobs";
  }

  async submit(projection: TorkJobProjection): Promise<TorkSubmitResult> {
    const response = await fetch(`${this.baseUrl}${this.submitPath}`, {
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

  async getJob(jobId: string): Promise<unknown> {
    const response = await this.fetchJobEndpoint(jobId, ["", "/api/v1"]);
    return await response.json() as unknown;
  }

  async cancelJob(jobId: string): Promise<void> {
    const response = await this.fetchJobEndpoint(jobId, ["", "/api/v1"], { method: "DELETE" });
    if (!response.ok) throw new Error(`Tork cancel failed: ${response.status} ${await response.text()}`);
  }

  async getJobLogs(jobId: string): Promise<string> {
    const encoded = encodeURIComponent(jobId);
    for (const prefix of ["", "/api/v1"]) {
      const response = await fetch(`${this.baseUrl}${prefix}/jobs/${encoded}/logs`);
      if (response.ok) return await response.text();
      if (response.status !== 404) throw new Error(`Tork logs failed: ${response.status} ${await response.text()}`);
    }
    return "";
  }

  private async fetchJobEndpoint(jobId: string, prefixes: string[], init?: RequestInit): Promise<Response> {
    const encoded = encodeURIComponent(jobId);
    let last: Response | undefined;
    for (const prefix of prefixes) {
      const response = await fetch(`${this.baseUrl}${prefix}/jobs/${encoded}`, init);
      if (response.ok || response.status !== 404) return response;
      last = response;
    }
    throw new Error(`Tork job request failed: ${last?.status ?? 404} ${last ? await last.text() : "not found"}`);
  }
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

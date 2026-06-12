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

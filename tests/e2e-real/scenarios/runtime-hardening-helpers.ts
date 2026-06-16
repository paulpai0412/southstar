import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/stores/sqlite.ts";
import type { TorkClient } from "../../../src/v2/executor/tork-client.ts";

export async function postExecutorHeartbeat(serverUrl: string, input: {
  runId: string;
  taskId: string;
  attemptId: string;
  torkJobId: string;
  rootSessionId: string;
  heartbeatSeq: number;
  observedAt?: string;
}): Promise<void> {
  const response = await fetch(`${serverUrl}/api/v2/executor/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      executorType: "tork",
      torkJobId: input.torkJobId,
      rootSessionId: input.rootSessionId,
      heartbeatSeq: input.heartbeatSeq,
      phase: "subagent-running",
      observedAt: input.observedAt ?? new Date().toISOString(),
    }),
  });
  assert.equal(response.ok, true, await response.text());
}

export async function submitManualTorkJob(baseUrl: string, input: {
  name: string;
  command: string[];
  timeoutSeconds?: number;
}): Promise<string> {
  const payload = {
    name: input.name,
    tasks: [
      {
        name: input.name,
        image: "alpine:3.20",
        cmd: input.command,
        timeout: `${input.timeoutSeconds ?? 180}s`,
        retry: { limit: 1 },
      },
    ],
  };

  for (const path of ["/jobs", "/api/v1/jobs"]) {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 404) continue;
      throw new Error(`manual Tork submit failed: ${response.status} ${text}`);
    }
    const parsed = JSON.parse(text) as { id?: string; job_id?: string };
    const jobId = parsed.id ?? parsed.job_id;
    if (!jobId) throw new Error(`manual Tork submit missing job id: ${text}`);
    return jobId;
  }

  throw new Error("manual Tork submit failed: no supported submit endpoint responded");
}

export async function waitForRunTasks(db: SouthstarDb, runId: string, timeoutMs = 60_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order")
      .all(runId) as Array<{ id: string }>;
    if (rows.length > 0) return rows.map((row) => row.id);
    await sleep(500);
  }
  throw new Error(`workflow tasks not found for run ${runId}`);
}

export async function waitForExecutorCommand(db: SouthstarDb, input: {
  runId: string;
  bindingId: string;
  action: string;
  timeoutMs?: number;
}): Promise<{ createdAt: string; payload: Record<string, unknown> }> {
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const rows = db.prepare(`
      select created_at, payload_json
      from runtime_resources
      where run_id = ?
        and resource_type = 'executor_job_command'
        and status = 'executed'
      order by created_at desc
    `).all(input.runId) as Array<{ created_at: string; payload_json: string }>;
    const match = rows
      .map((row) => ({ createdAt: row.created_at, payload: JSON.parse(row.payload_json) as Record<string, unknown> }))
      .find((row) => row.payload.bindingId === input.bindingId && row.payload.action === input.action);
    if (match) return match;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for executor action ${input.action} on binding ${input.bindingId}`);
}

export async function waitForTorkRunningLike(
  torkClient: Pick<TorkClient, "getJobObservation">,
  jobId: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await torkClient.getJobObservation(jobId);
    const normalized = observation.status.toUpperCase();
    if (["RUNNING", "STARTED", "ACTIVE"].includes(normalized)) return;
    if (["FAILED", "ERROR", "ERRORED", "CANCELLED", "CANCELED"].includes(normalized)) {
      throw new Error(`expected running-like Tork status for ${jobId}, got ${observation.status}`);
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for Tork job ${jobId} to enter running-like state`);
}

export async function waitForTorkTerminal(
  torkClient: Pick<TorkClient, "getJobObservation">,
  jobId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await torkClient.getJobObservation(jobId);
    const normalized = observation.status.toUpperCase();
    if (["COMPLETED", "SUCCEEDED", "SUCCESS", "FAILED", "ERROR", "ERRORED", "CANCELLED", "CANCELED"].includes(normalized)) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for Tork job ${jobId} to become terminal`);
}

export async function countActiveSouthstarJobs(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/jobs`);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  const payload = JSON.parse(text) as { items?: Array<{ name?: string; state?: string }> };
  return (payload.items ?? []).filter((job) => {
    const state = (job.state ?? "").toUpperCase();
    return typeof job.name === "string"
      && job.name.startsWith("run-wf-")
      && ["CREATED", "PENDING", "SCHEDULED", "RUNNING"].includes(state);
  }).length;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

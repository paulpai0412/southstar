import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createExecutorBinding } from "../../../src/v2/executor/bindings.ts";
import { assertExecutorObservabilityGates } from "../../../src/v2/quality/executor-observability-gates.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
} from "./harness.ts";

export async function runExecutorObservabilityRealScenario(env: RealE2EEnv): Promise<{ runId: string }> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "executor-observability-real");
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    callbackUrl: callback.url,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
    torkObservationClient: {
      capabilities: () => context.torkClient.capabilities(),
      getJob: (jobId) => context.torkClient.getJobObservation(jobId),
      getJobLogs: (jobId) => context.torkClient.getJobLogs(jobId),
      cancelJob: (jobId) => context.torkClient.cancelJob(jobId),
    },
  });

  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const runGoal = await client.runGoal({ goalPrompt: executorObservabilityGoalPrompt(repo) });
    const runId = runGoal.result.runId;
    const workflowJobId = runGoal.result.tork.jobId;

    const tasks = await waitForRunTasks(context.db, runId);
    const [heartbeatTaskId, timeoutTaskId, callbackMissingTaskId] = pickThreeTasks(tasks);

    const successJobId = await submitManualTorkJob(env.torkBaseUrl, {
      name: `run-wf-${runId}-heartbeat-success`,
      command: ["sh", "-lc", "sleep 8"],
    });
    const timeoutJobId = await submitManualTorkJob(env.torkBaseUrl, {
      name: `run-wf-${runId}-heartbeat-timeout`,
      command: ["sh", "-lc", "sleep 45"],
    });
    const callbackMissingJobId = await submitManualTorkJob(env.torkBaseUrl, {
      name: `run-wf-${runId}-callback-missing`,
      command: ["sh", "-lc", "echo done && sleep 1"],
    });

    createExecutorBinding(context.db, {
      runId,
      taskId: heartbeatTaskId,
      attemptId: "attempt-manual-heartbeat-success",
      torkJobId: successJobId,
      status: "running",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: 600,
    });
    const timeoutBinding = createExecutorBinding(context.db, {
      runId,
      taskId: timeoutTaskId,
      attemptId: "attempt-manual-heartbeat-timeout",
      torkJobId: timeoutJobId,
      status: "running",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: 600,
    });
    const callbackBinding = createExecutorBinding(context.db, {
      runId,
      taskId: callbackMissingTaskId,
      attemptId: "attempt-manual-callback-missing",
      torkJobId: callbackMissingJobId,
      status: "running",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: 600,
    });

    for (let seq = 1; seq <= 3; seq += 1) {
      await postHeartbeat(server.url, {
        runId,
        taskId: heartbeatTaskId,
        attemptId: "attempt-manual-heartbeat-success",
        torkJobId: successJobId,
        rootSessionId: `root-${runId}-${heartbeatTaskId}`,
        heartbeatSeq: seq,
        observedAt: new Date().toISOString(),
      });
    }

    await waitForTorkRunningLike(context.torkClient, timeoutJobId);
    await postHeartbeat(server.url, {
      runId,
      taskId: timeoutTaskId,
      attemptId: "attempt-manual-heartbeat-timeout",
      torkJobId: timeoutJobId,
      rootSessionId: `root-${runId}-${timeoutTaskId}`,
      heartbeatSeq: 1,
      observedAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const timeoutReconcile = await reconcileUntil(server.url, (findings) => {
      return findings.some((finding) => finding.bindingId === timeoutBinding.id && finding.classification === "heartbeat-lost");
    });
    assert.equal(timeoutReconcile, true, "expected heartbeat-lost classification from real timeout reconcile");

    await waitForTorkTerminal(context.torkClient, callbackMissingJobId);

    const callbackReconcile = await reconcileUntil(server.url, (findings) => {
      return findings.some((finding) => finding.bindingId === callbackBinding.id && finding.classification === "callback-missing");
    });
    assert.equal(callbackReconcile, true, "expected callback-missing classification from real callback-missing reconcile");

    await waitForTorkTerminal(context.torkClient, timeoutJobId);
    await waitForTorkTerminal(context.torkClient, workflowJobId);

    const activeJobs = await countActiveSouthstarJobs(env.torkBaseUrl);
    const gate = assertExecutorObservabilityGates(context.db, {
      runId,
      activeTorkJobCountAfterScenario: activeJobs,
    });
    assert.equal(gate.ok, true, gate.failures.join("\n"));
    console.log("executor observability real scenario passed");
    return { runId };
  } finally {
    await server.close();
    await callback.close();
  }
}

function executorObservabilityGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中執行 Southstar executor observability 驗收任務。",
    "請建立一個 workflow，包含三個 Docker/Tork task：",
    "1. heartbeat-success：啟動 southstar-agent-runner，至少送出 3 次 heartbeat，產出 artifact，callback 成功。",
    "2. heartbeat-timeout：啟動真實 Tork/Docker container，送出 1 次 heartbeat 後 sleep 超過 heartbeat timeout，讓 Southstar reconciler 標記 heartbeat-lost。",
    "3. callback-missing-orphan-check：啟動真實 Tork/Docker container 並讓 Tork job terminal，但不送出成功 callback，讓 Southstar reconciler 標記 callback-missing；最後由 Southstar cancel/reconcile 清理任何 orphaned executor binding。",
    "",
    "驗收要求：",
    "- 不使用 fake Tork。",
    "- 不使用 mocked Docker。",
    "- 不使用 smoke-only shortcut。",
    "- 所有 executor evidence 必須寫入真實 SQLite。",
    "- UI/API read model 必須能看到 executor binding、heartbeat、timeout、reconcile result、logs ref、operator command event。",
    "",
    "Domain hint: software",
    "Intent hint: implement_feature",
    "請在 fixture repo 的 Node.js CLI 專案內完成上述 executor observability 任務並保留 Southstar evaluator/stop-condition 驗收。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

async function waitForRunTasks(db: ReturnType<typeof createScenarioContext>["db"], runId: string): Promise<string[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const rows = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order").all(runId) as Array<{ id: string }>;
    if (rows.length > 0) return rows.map((row) => row.id);
    await sleep(500);
  }
  throw new Error(`workflow tasks not found for run ${runId}`);
}

function pickThreeTasks(taskIds: string[]): [string, string, string] {
  if (taskIds.length >= 3) return [taskIds[0]!, taskIds[1]!, taskIds[2]!];
  if (taskIds.length === 2) return [taskIds[0]!, taskIds[1]!, taskIds[1]!];
  if (taskIds.length === 1) return [taskIds[0]!, taskIds[0]!, taskIds[0]!];
  throw new Error("executor observability scenario requires at least one workflow task");
}

async function submitManualTorkJob(baseUrl: string, input: { name: string; command: string[] }): Promise<string> {
  const payload = {
    name: input.name,
    tasks: [
      {
        name: input.name,
        image: "alpine:3.20",
        cmd: input.command,
        timeout: "120s",
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

async function postHeartbeat(serverUrl: string, input: {
  runId: string;
  taskId: string;
  attemptId: string;
  torkJobId: string;
  rootSessionId: string;
  heartbeatSeq: number;
  observedAt: string;
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
      observedAt: input.observedAt,
    }),
  });
  assert.equal(response.ok, true, await response.text());
}

async function reconcile(serverUrl: string): Promise<Array<{ bindingId: string; classification: string }>> {
  const response = await fetch(`${serverUrl}/api/v2/executor/reconcile`, {
    method: "POST",
  });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  const payload = JSON.parse(text) as {
    ok: boolean;
    result?: { findings?: Array<{ bindingId: string; classification: string }> };
    error?: string;
  };
  assert.equal(payload.ok, true, payload.error ?? text);
  return payload.result?.findings ?? [];
}

async function reconcileUntil(
  serverUrl: string,
  predicate: (findings: Array<{ bindingId: string; classification: string }>) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const findings = await reconcile(serverUrl);
    if (predicate(findings)) return true;
    await sleep(1000);
  }
  return false;
}

async function waitForTorkRunningLike(torkClient: ReturnType<typeof createScenarioContext>["torkClient"], jobId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const observation = await torkClient.getJobObservation(jobId);
    const normalized = observation.status.toUpperCase();
    if (["RUNNING", "STARTED", "ACTIVE"].includes(normalized)) return;
    if (["FAILED", "ERROR", "ERRORED", "CANCELLED", "CANCELED"].includes(normalized)) {
      throw new Error(`expected running-like Tork status for ${jobId}, got ${observation.status}`);
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for Tork job ${jobId} to enter running-like state`);
}

async function waitForTorkTerminal(torkClient: ReturnType<typeof createScenarioContext>["torkClient"], jobId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const observation = await torkClient.getJobObservation(jobId);
    const normalized = observation.status.toUpperCase();
    if (["COMPLETED", "SUCCEEDED", "SUCCESS", "FAILED", "ERROR", "ERRORED", "CANCELLED", "CANCELED"].includes(normalized)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for Tork job ${jobId} to become terminal`);
}

async function countActiveSouthstarJobs(baseUrl: string): Promise<number> {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

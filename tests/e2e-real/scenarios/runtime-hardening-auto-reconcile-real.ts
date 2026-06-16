import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createExecutorBinding } from "../../../src/v2/executor/bindings.ts";
import { assertRuntimeAutoReconcileGates } from "../../../src/v2/quality/runtime-hardening-gates.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  createScenarioContext,
  runtimeHardeningGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
} from "./harness.ts";
import {
  countActiveSouthstarJobs,
  postExecutorHeartbeat,
  submitManualTorkJob,
  waitForExecutorCommand,
  waitForRunTasks,
  waitForTorkRunningLike,
  waitForTorkTerminal,
} from "./runtime-hardening-helpers.ts";

export async function runRuntimeHardeningAutoReconcileRealScenario(env: RealE2EEnv): Promise<{ runId: string; orphanReconcileMs: number }> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "runtime-hardening-auto-reconcile-real");
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    callbackUrl: callback.url,
    reconcileIntervalMs: 2_000,
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
    const runGoal = await client.runGoal({ goalPrompt: runtimeHardeningGoalPrompt(repo) });
    const runId = runGoal.result.runId;
    const workflowJobId = runGoal.result.tork.jobId;
    const tasks = await waitForRunTasks(context.db, runId);
    const orphanTaskId = tasks[0]!;
    context.db.prepare("update workflow_tasks set status = 'completed', completed_at = ? where run_id = ? and id = ?")
      .run(new Date().toISOString(), runId, orphanTaskId);

    const orphanJobId = await submitManualTorkJob(env.torkBaseUrl, {
      name: `run-wf-${runId}-runtime-hardening-orphan`,
      command: ["sh", "-lc", "sleep 90"],
      timeoutSeconds: 120,
    });
    await waitForTorkRunningLike(context.torkClient, orphanJobId, 90_000);

    const binding = createExecutorBinding(context.db, {
      runId,
      taskId: orphanTaskId,
      attemptId: "attempt-runtime-hardening-orphan",
      torkJobId: orphanJobId,
      status: "running",
      queueTimeoutSeconds: 120,
      hardTimeoutSeconds: 600,
    });

    for (let seq = 1; seq <= 3; seq += 1) {
      await postExecutorHeartbeat(server.url, {
        runId,
        taskId: orphanTaskId,
        attemptId: "attempt-runtime-hardening-orphan",
        torkJobId: orphanJobId,
        rootSessionId: `root-${runId}-${orphanTaskId}`,
        heartbeatSeq: seq,
      });
    }

    const startedAt = Date.now();
    await waitForExecutorCommand(context.db, {
      runId,
      bindingId: binding.id,
      action: "alert-operator",
      timeoutMs: 120_000,
    });
    const orphanReconcileMs = Date.now() - startedAt;

    await waitForTorkTerminal(context.torkClient, orphanJobId, 120_000);
    await waitForTorkTerminal(context.torkClient, workflowJobId, 240_000);

    const activeJobs = await countActiveSouthstarJobs(env.torkBaseUrl);
    const gate = assertRuntimeAutoReconcileGates(context.db, {
      runId,
      orphanReconcileMs,
      activeTorkJobCountAfterScenario: activeJobs,
    });
    assert.equal(gate.ok, true, gate.failures.join("\n"));
    console.log("runtime hardening auto reconcile real scenario passed");
    return { runId, orphanReconcileMs };
  } finally {
    await server.close();
    await callback.close();
  }
}

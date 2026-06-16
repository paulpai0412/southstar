import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createExecutorBinding } from "../../../src/v2/executor/bindings.ts";
import { assertRuntimeSoakGates } from "../../../src/v2/quality/runtime-hardening-gates.ts";
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
  sleep,
  submitManualTorkJob,
  waitForExecutorCommand,
  waitForRunTasks,
  waitForTorkRunningLike,
  waitForTorkTerminal,
} from "./runtime-hardening-helpers.ts";

export type RuntimeHardeningSoakOptions = {
  durationMs: number;
  cycleIntervalMs: number;
  minCycles: number;
};

export async function runRuntimeHardeningSoakRealScenario(
  env: RealE2EEnv,
  options: RuntimeHardeningSoakOptions,
): Promise<{ runId: string; durationMs: number; cycles: number; reconcileLatenciesMs: number[] }> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "runtime-hardening-soak-real");
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
    const taskId = (await waitForRunTasks(context.db, runId))[0]!;
    context.db.prepare("update workflow_tasks set status = 'completed', completed_at = ? where run_id = ? and id = ?")
      .run(new Date().toISOString(), runId, taskId);

    const startedAt = Date.now();
    const deadline = startedAt + options.durationMs;
    let cycles = 0;
    const reconcileLatenciesMs: number[] = [];

    while (Date.now() < deadline) {
      cycles += 1;
      const attemptId = `attempt-runtime-hardening-soak-orphan-${cycles}`;
      const orphanJobId = await submitManualTorkJob(env.torkBaseUrl, {
        name: `run-wf-${runId}-runtime-hardening-soak-orphan-${cycles}`,
        command: ["sh", "-lc", "sleep 90"],
        timeoutSeconds: 120,
      });
      await waitForTorkRunningLike(context.torkClient, orphanJobId, 90_000);
      const binding = createExecutorBinding(context.db, {
        runId,
        taskId,
        attemptId,
        torkJobId: orphanJobId,
        status: "running",
        queueTimeoutSeconds: 120,
        hardTimeoutSeconds: 600,
      });

      await postExecutorHeartbeat(server.url, {
        runId,
        taskId,
        attemptId,
        torkJobId: orphanJobId,
        rootSessionId: `root-${runId}-${taskId}`,
        heartbeatSeq: cycles,
      });

      const cycleStartedAt = Date.now();
      await waitForExecutorCommand(context.db, {
        runId,
        bindingId: binding.id,
        action: "alert-operator",
        timeoutMs: 120_000,
      });
      reconcileLatenciesMs.push(Date.now() - cycleStartedAt);
      await waitForTorkTerminal(context.torkClient, orphanJobId, 120_000);

      if (options.cycleIntervalMs > 0) {
        await sleep(options.cycleIntervalMs);
      }
    }

    await waitForTorkTerminal(context.torkClient, workflowJobId, 240_000);

    const durationMs = Date.now() - startedAt;
    const activeJobs = await countActiveSouthstarJobs(env.torkBaseUrl);
    const gate = assertRuntimeSoakGates(context.db, {
      durationMs,
      requiredDurationMs: options.durationMs,
      cycles,
      minCycles: options.minCycles,
      reconcileLatenciesMs,
      activeTorkJobCountAfterScenario: activeJobs,
    });
    assert.equal(gate.ok, true, gate.failures.join("\n"));
    console.log("runtime hardening soak real scenario passed");
    return { runId, durationMs, cycles, reconcileLatenciesMs };
  } finally {
    await server.close();
    await callback.close();
  }
}

import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createExecutorBinding } from "../../../src/v2/executor/bindings.ts";
import { assertRuntimeConcurrencyGates } from "../../../src/v2/quality/runtime-hardening-gates.ts";
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

export type RuntimeHardeningConcurrencyOptions = {
  runCount: number;
  expectedMinTaskCount: number;
};

export async function runRuntimeHardeningConcurrencyRealScenario(
  env: RealE2EEnv,
  options: RuntimeHardeningConcurrencyOptions,
): Promise<{ runIds: string[]; reconcileLatenciesMs: number[] }> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
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
    const runs = await Promise.all(
      Array.from({ length: options.runCount }, async (_, index) => {
        const repo = prepareSoftwareFixtureRepo(env, `runtime-hardening-concurrency-real-${index + 1}`);
        const runGoal = await client.runGoal({ goalPrompt: runtimeHardeningGoalPrompt(repo) });
        const taskId = (await waitForRunTasks(context.db, runGoal.result.runId))[0]!;
        return {
          runId: runGoal.result.runId,
          workflowJobId: runGoal.result.tork.jobId,
          taskId,
        };
      }),
    );

    const bindingsPerRun = Math.max(1, Math.ceil(options.expectedMinTaskCount / Math.max(1, runs.length)));
    const reconcileLatenciesMs: number[] = [];

    for (const run of runs) {
      context.db.prepare("update workflow_tasks set status = 'completed', completed_at = ? where run_id = ? and id = ?")
        .run(new Date().toISOString(), run.runId, run.taskId);

      for (let bindingIndex = 0; bindingIndex < bindingsPerRun; bindingIndex += 1) {
        const attemptId = `attempt-runtime-hardening-concurrency-orphan-${bindingIndex + 1}`;
        const orphanJobId = await submitManualTorkJob(env.torkBaseUrl, {
          name: `run-wf-${run.runId}-runtime-hardening-concurrency-orphan-${bindingIndex + 1}`,
          command: ["sh", "-lc", "sleep 90"],
          timeoutSeconds: 120,
        });
        await waitForTorkRunningLike(context.torkClient, orphanJobId, 90_000);
        const binding = createExecutorBinding(context.db, {
          runId: run.runId,
          taskId: run.taskId,
          attemptId,
          torkJobId: orphanJobId,
          status: "running",
          queueTimeoutSeconds: 120,
          hardTimeoutSeconds: 600,
        });

        const heartbeatCount = bindingIndex === 0 ? 3 : 1;
        for (let heartbeatSeq = 1; heartbeatSeq <= heartbeatCount; heartbeatSeq += 1) {
          await postExecutorHeartbeat(server.url, {
            runId: run.runId,
            taskId: run.taskId,
            attemptId,
            torkJobId: orphanJobId,
            rootSessionId: `root-${run.runId}-${run.taskId}`,
            heartbeatSeq,
          });
        }

        const startedAt = Date.now();
        await waitForExecutorCommand(context.db, {
          runId: run.runId,
          bindingId: binding.id,
          action: "alert-operator",
          timeoutMs: 120_000,
        });
        reconcileLatenciesMs.push(Date.now() - startedAt);
        await waitForTorkTerminal(context.torkClient, orphanJobId, 120_000);
      }
    }

    await Promise.all(runs.map((run) => waitForTorkTerminal(context.torkClient, run.workflowJobId, 240_000)));

    const activeJobs = await countActiveSouthstarJobs(env.torkBaseUrl);
    const runIds = runs.map((run) => run.runId);
    const gate = assertRuntimeConcurrencyGates(context.db, {
      runIds,
      expectedRunCount: options.runCount,
      expectedMinTaskCount: options.expectedMinTaskCount,
      reconcileLatenciesMs,
      activeTorkJobCountAfterScenario: activeJobs,
    });
    assert.equal(gate.ok, true, gate.failures.join("\n"));
    console.log("runtime hardening concurrency real scenario passed");
    return { runIds, reconcileLatenciesMs };
  } finally {
    await server.close();
    await callback.close();
  }
}

import assert from "node:assert/strict";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertFixtureTests,
  assertNoE2eStaticManifestUsage,
  assertPhase15SqliteEvidence,
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export async function runUiApiRunGoalRealScenario(env: RealE2EEnv): Promise<{ runId: string; timings: Record<string, number> }> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "ui-api-run-goal-real");
  const serverStartedAt = Date.now();
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
  });
  const serverStartMs = Date.now() - serverStartedAt;
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const runGoalStartedAt = Date.now();
    const result = await client.runGoal({ goalPrompt: phase15OperationsGoalPrompt(repo) });
    const runGoalSubmitMs = Date.now() - runGoalStartedAt;
    const runId = result.result.runId;
    const externalJobId = result.result.tork.jobId;
    await waitForTorkJob(env.torkBaseUrl, externalJobId);
    await waitForRunStatus(context.db, runId, ["passed", "completed"]);
    assertCalcSum(repo);
    assertFixtureTests(repo);
    assertNoE2eStaticManifestUsage(context.db, runId);
    assertPhase15SqliteEvidence(context.db, runId);
    assert.equal((await client.listArtifacts(runId)).kind, "artifacts");
    assert.equal((await client.listSessions(runId)).kind, "sessions");
    assert.equal((await client.listMemory(runId)).kind, "memory");
    console.log("phase15 api run-goal scenario passed");
    return {
      runId,
      timings: {
        serverStartMs,
        runGoalSubmitMs,
        apiRunGoalCompletionMs: Date.now() - startedAt,
      },
    };
  } finally {
    await server.close();
    await callback.close();
  }
}

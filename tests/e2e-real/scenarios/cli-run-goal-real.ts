import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertFixtureTests,
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export async function runCliRunGoalRealScenario(env: RealE2EEnv): Promise<{ runId: string; timings: { cliRunGoalCompletionMs: number } }> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "cli-run-goal-real");
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
  try {
    const output = execFileSync("npm", ["run", "southstar:v2", "--", "run-goal", "--goal", phase15OperationsGoalPrompt(repo)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SOUTHSTAR_DB: env.southstarDb,
        TORK_BASE_URL: env.torkBaseUrl,
        SOUTHSTAR_SERVER_URL: server.url,
      },
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
    });
    const match = output.match(/"runId":\s*"([^"]+)"/);
    assert.ok(match, `CLI output did not include runId: ${output}`);
    const runId = match[1]!;
    const jobMatch = output.match(/"externalJobId":\s*"([^"]+)"/);
    assert.ok(jobMatch, `CLI output did not include externalJobId: ${output}`);
    await waitForTorkJob(env.torkBaseUrl, jobMatch[1]!);
    await waitForRunStatus(context.db, runId, ["passed", "completed"]);
    assertCalcSum(repo);
    assertFixtureTests(repo);
    console.log("phase15 cli run-goal scenario passed");
    return { runId, timings: { cliRunGoalCompletionMs: Date.now() - startedAt } };
  } finally {
    await server.close();
    await callback.close();
  }
}

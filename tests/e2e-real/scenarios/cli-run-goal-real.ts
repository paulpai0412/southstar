import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertDynamicWorkflowEvidence,
  assertFixtureTests,
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

const execFileAsync = promisify(execFile);

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
    const { stdout: output } = await execFileAsync("npm", ["run", "southstar:v2", "--", "run-goal", "--goal", phase15OperationsGoalPrompt(repo)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SOUTHSTAR_DB: env.southstarDb,
        TORK_BASE_URL: env.torkBaseUrl,
        SOUTHSTAR_SERVER_URL: server.url,
      },
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const payload = parseCliJson(output);
    const runId = payload.result.runId;
    const jobId = payload.result.tork.jobId;
    await waitForTorkJob(env.torkBaseUrl, jobId);
    await waitForRunStatus(context.db, runId, ["passed", "completed"]);
    assertDynamicWorkflowEvidence(context.db, runId);
    assertCalcSum(repo);
    assertFixtureTests(repo);
    console.log("phase15 cli run-goal scenario passed");
    return { runId, timings: { cliRunGoalCompletionMs: Date.now() - startedAt } };
  } finally {
    await server.close();
    await callback.close();
  }
}

function parseCliJson(output: string): { result: { runId: string; tork: { jobId: string } } } {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `CLI output did not include JSON payload: ${output}`);
  const payload = JSON.parse(output.slice(start, end + 1)) as {
    result?: { runId?: unknown; tork?: { jobId?: unknown } };
  };
  const runId = payload.result?.runId;
  const jobId = payload.result?.tork?.jobId;
  if (typeof runId !== "string") throw new Error(`CLI output did not include runId: ${output}`);
  if (typeof jobId !== "string") throw new Error(`CLI output did not include tork.jobId: ${output}`);
  return { result: { runId, tork: { jobId } } };
}

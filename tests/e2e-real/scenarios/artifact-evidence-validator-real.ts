import assert from "node:assert/strict";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  artifactEvidenceValidatorGoalPrompt,
  assertArtifactEvidenceQuantitativeGates,
  assertCalcSum,
  assertFixtureTests,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export type ArtifactEvidenceValidatorRealResult = {
  runId: string;
  repo: string;
  durationMs: number;
};

export async function runArtifactEvidenceValidatorRealScenario(env: RealE2EEnv): Promise<ArtifactEvidenceValidatorRealResult> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "artifact-evidence-validator-real");
  try {
    const draft = await createPlannerDraft(context.db, {
      goalPrompt: artifactEvidenceValidatorGoalPrompt(repo),
      plannerClient: context.plannerClient,
    });

    const run = await createRunFromDraft(context.db, {
      draftId: draft.draftId,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      contextRefreshUrl: callback.contextRefreshUrl,
      harnessEndpoint: env.piHarnessEndpoint,
    });

    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId, 15 * 60 * 1000);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"], 60_000);

    assertArtifactEvidenceQuantitativeGates(context.db, run.runId);
    assertCalcSum(repo);
    assertFixtureTests(repo);

    const durationMs = Date.now() - startedAt;
    assert.equal(durationMs <= 15 * 60 * 1000, true, `scenario took ${durationMs}ms`);
    console.log("artifact evidence validator real scenario passed");
    return { runId: run.runId, repo, durationMs };
  } finally {
    await callback.close();
  }
}

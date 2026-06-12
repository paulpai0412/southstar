import assert from "node:assert/strict";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { validateWorkflowManifest } from "../../../src/v2/manifests/validate.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import type { PlanBundle } from "../../../src/v2/manifests/types.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertFixtureTests,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  softwareGoalPrompt,
  startCallbackServer,
  waitForTorkJob,
  waitForRunStatus,
} from "./harness.ts";

export type MvpSoftwareChangeResult = {
  runId: string;
  repo: string;
  timings: {
    plannerMs: number;
    validationMs: number;
    torkSubmitMs: number;
  };
};

export async function runMvpSoftwareChangeScenario(env: RealE2EEnv): Promise<MvpSoftwareChangeResult> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "mvp-software-change");
  try {
    const plannerStartedAt = Date.now();
    const draft = await createPlannerDraft(context.db, {
      goalPrompt: softwareGoalPrompt(repo),
      plannerClient: context.plannerClient,
    });
    const plannerMs = Date.now() - plannerStartedAt;
    const validationStartedAt = Date.now();
    const validation = validateWorkflowManifest(readDraftBundle(context.db, draft.draftId).workflow);
    const validationMs = Date.now() - validationStartedAt;
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    const torkSubmitStartedAt = Date.now();
    const run = await createRunFromDraft(context.db, {
      draftId: draft.draftId,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      harnessEndpoint: env.piHarnessEndpoint,
    });
    const torkSubmitMs = Date.now() - torkSubmitStartedAt;
    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"]);

    assertCalcSum(repo);
    assertFixtureTests(repo);
    assert.equal(listResources(context.db, { resourceType: "executor_binding" }).some((resource) => resource.runId === run.runId), true);
    assert.equal(listResources(context.db, { resourceType: "artifact" }).some((resource) => resource.runId === run.runId), true);
    console.log("MVP software-change scenario passed");
    return { runId: run.runId, repo, timings: { plannerMs, validationMs, torkSubmitMs } };
  } finally {
    await callback.close();
  }
}

function readDraftBundle(db: ReturnType<typeof createScenarioContext>["db"], draftId: string): PlanBundle {
  const row = db.prepare("select payload_json from runtime_resources where resource_type = ? and resource_key = ?")
    .get("planner_draft", draftId) as { payload_json: string } | undefined;
  if (!row) throw new Error(`planner draft not found: ${draftId}`);
  return JSON.parse(row.payload_json) as PlanBundle;
}

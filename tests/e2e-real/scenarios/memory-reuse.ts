import assert from "node:assert/strict";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { approveMemoryDelta, proposeMemoryDelta, retrieveApprovedMemory } from "../../../src/v2/stores/resource-store.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  softwareGoalPrompt,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export async function runMemoryReuseScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  const delta = proposeMemoryDelta(context.db, runId, {
    preference: "最小改動、不新增 dependency、artifact 必須列出測試指令與結果",
  });
  approveMemoryDelta(context.db, delta.id);
  const snapshot = retrieveApprovedMemory(context.db, "software", 5);
  assert.equal(snapshot.items.length >= 1, true);
  assert.match(JSON.stringify(snapshot.items), /最小改動/);
  const secondRun = await runSecondWorkflowWithApprovedMemory(env);
  const artifacts = context.db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'artifact' and status = 'accepted'
  `).all(secondRun.runId) as Array<{ payload_json: string }>;
  assert.equal(artifacts.length > 0, true);
  assert.match(JSON.stringify(artifacts.map((artifact) => JSON.parse(artifact.payload_json))), /最小改動|不新增 dependency|測試指令/);
  console.log("memory reuse scenario passed");
}

async function runSecondWorkflowWithApprovedMemory(env: RealE2EEnv): Promise<{ runId: string }> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "memory-reuse-second-run");
  try {
    const draft = await createPlannerDraft(context.db, {
      goalPrompt: [
        softwareGoalPrompt(repo),
        "",
        "Memory Reuse Prompt:",
        "沿用上一個成功軟工 run 的偏好：最小改動、不新增 dependency、artifact 必須列出測試指令與結果。",
        "請在 artifact 中明確說明已套用這些 memory preference。",
      ].join("\n"),
      plannerClient: context.plannerClient,
    });
    const run = await createRunFromDraft(context.db, {
      draftId: draft.draftId,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      harnessEndpoint: env.piHarnessEndpoint,
    });
    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"]);
    return { runId: run.runId };
  } finally {
    await callback.close();
  }
}

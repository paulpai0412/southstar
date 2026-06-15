import test from "node:test";
import assert from "node:assert/strict";
import { runPromptToArtifactUiE2E } from "./harness.ts";

test("Southstar UI completes real browser UI → API → runtime → DB loop through 1:1 control plane", async () => {
  const result = await runPromptToArtifactUiE2E();
  assert.equal(result.plannerDraftCount >= 1, true, "planner draft must be persisted by UI-triggered draft API");
  assert.equal(result.runStatus !== "missing", true, "workflow run must be persisted");
  assert.equal(result.taskCount >= 1, true, "workflow tasks must be persisted");
  assert.equal(result.historyCount >= 1, true, "runtime history must be appended");
  assert.equal(result.executorBindingCount >= 1, true, "executor binding evidence required");
  assert.equal(result.taskEnvelopeCount >= 1, true, "task detail page model must materialize TaskEnvelopeV2");
  assert.equal(result.contextPacketCount >= 1, true, "task detail page model must materialize ContextPacket");
  assert.equal(result.pages.planner, true);
  assert.equal(result.pages.workflow, true);
  assert.equal(result.pages.runtime, true);
  assert.equal(result.pages.taskDetail, true);
  assert.equal(result.pages.sessionsMemory, true);
  assert.equal(result.pages.worktree, true);
  assert.equal(result.pages.executor, true);
  assert.equal(result.pages.domainPacks, true);
  assert.equal(result.pages.governance, true);
});

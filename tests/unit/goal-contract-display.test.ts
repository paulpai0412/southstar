import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRiskTag,
  describeSideEffect,
  scopeEffortDescription,
  describeLibraryObject,
  describeContractDeliverable,
} from "../../web/lib/workflow/goal-contract-display.ts";

test("goal contract display turns risk and side effects into operator language", () => {
  assert.match(describeRiskTag("workspace-write"), /write files in the selected workspace/i);
  assert.match(describeSideEffect("external-write"), /external system or service/i);
  assert.doesNotMatch(describeRiskTag("workspace-write"), /^workspace-write$/);
});

test("goal contract display explains scope without inventing an effort estimate", () => {
  const description = scopeEffortDescription({
    requirements: [
      { acceptanceCriteria: ["one", "two"], blocking: true },
      { acceptanceCriteria: ["three"], blocking: false },
    ],
  });
  assert.match(description, /2 requirements/);
  assert.match(description, /3 acceptance criteria/);
  assert.match(description, /estimate is not recorded/i);
});

test("goal contract display uses Library object state for deliverables", () => {
  assert.match(describeLibraryObject({
    object: {
      objectKey: "artifact.article",
      objectKind: "artifact_contract",
      status: "approved",
      state: {
        title: "Offline article",
        description: "A self-contained HTML article",
        mediaTypes: ["text/html"],
      },
    },
  }, "artifact"), /Offline article.*self-contained HTML article.*text\/html/);
});

test("goal contract display resolves generated artifact refs to contract descriptions", () => {
  const ref = "artifact.goal.req-ledger.1";
  assert.match(describeContractDeliverable(ref, {
    requirements: [{
      id: "req-ledger",
      expectedArtifacts: [{ description: "A browser-ready ledger page", mediaType: "text/html", path: "dist/index.html" }],
    }],
  }, {}), /browser-ready ledger page.*text\/html.*dist\/index\.html/);
});

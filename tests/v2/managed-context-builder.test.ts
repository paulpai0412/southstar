import test from "node:test";
import assert from "node:assert/strict";
import { buildManagedContextSourceRefs } from "../../src/v2/context/event-slicing.ts";

test("managed context source refs track raw events, omissions, transforms, and checkpoints", () => {
  const input = {
    rawEventRefs: [{ id: "evt-1", sessionId: "session-1", runId: "run-1", sequence: 1 }],
    omittedEventRanges: [{ fromSequence: 2, toSequence: 10, reason: "tool result too old" }],
    transformRefs: [{ id: "transform-1", kind: "summary" as const, sourceEventIds: ["evt-1"] }],
    checkpointRefs: ["checkpoint-1"],
  };
  const refs = buildManagedContextSourceRefs(input);
  const repeated = buildManagedContextSourceRefs(input);

  assert.equal(refs.rawEventRefs.length, 1);
  assert.equal(refs.omittedEventRanges[0]?.reason, "tool result too old");
  assert.equal(refs.transformRefs[0]?.kind, "summary");
  assert.deepEqual(refs.checkpointRefs, ["checkpoint-1"]);
  assert.equal(refs.cacheKey, "8046d6581acf8d6f");
  assert.equal(refs.cacheKey, repeated.cacheKey);
});

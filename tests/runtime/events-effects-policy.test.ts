import test from "node:test";
import assert from "node:assert/strict";
import { effectResultHistory } from "../../src/runtime/effects.ts";
import { eventsFromHistory } from "../../src/runtime/events.ts";
import { defaultRuntimePolicy } from "../../src/runtime/policy.ts";

test("effect result helper records idempotent compact history", () => {
  assert.deepEqual(effectResultHistory({
    type: "projection_retry",
    idempotency_key: "projection:label:1",
    payload: { projection_target: "label" },
  }, "ok"), {
    event_type: "effect_result",
    payload: {
      idempotency_key: "projection:label:1",
      effect_type: "projection_retry",
      status: "ok",
    },
  });
});

test("runtime events are reconstructed only from runtime_event history rows", () => {
  assert.deepEqual(eventsFromHistory([
    {
      event_type: "runtime_event",
      payload: {
        type: "operator_quarantine",
        reason: "manual stop",
      },
    },
    {
      event_type: "note",
      payload: {
        type: "operator_quarantine",
        reason: "ignored",
      },
    },
  ]), [{
    type: "operator_quarantine",
    reason: "manual stop",
  }]);
});

test("default runtime policy keeps projection failures non-blocking and quarantine operator-gated", () => {
  assert.deepEqual(defaultRuntimePolicy(), {
    githubSyncBlocksLifecycle: false,
    quarantineRequiresOperator: true,
  });
});

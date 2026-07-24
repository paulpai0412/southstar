import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecoveryStrategy,
  recoveryStrategies,
} from "../../src/v2/session-recovery/types.ts";

test("session recovery strategies are explicit and stable", () => {
  assert.deepEqual(recoveryStrategies, [
    "retry-same-agent",
    "fork-from-checkpoint",
    "reset-from-checkpoint",
    "host-native-rewind",
    "rollback-workspace",
    "request-workflow-revision",
    "ask-human",
  ]);
  assert.equal(isRecoveryStrategy("fork-from-checkpoint"), true);
  assert.equal(isRecoveryStrategy("unknown"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBrainProvider } from "../support/fake-brain-provider.ts";

test("BrainProvider wake creates a recoverable binding", async () => {
  const provider = createFakeBrainProvider({ providerId: "fake-brain" });
  const binding = await provider.wake({
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    contextPacketId: "ctx-1",
    effortPolicy: { complexity: "standard", maxToolCallsPerTask: 3 },
  });
  assert.equal(binding.providerId, "fake-brain");
  assert.equal(binding.sessionId, "session-1");
  assert.equal(binding.status, "running");
  assert.ok(provider.capabilities().supportsWakeFromSession);
});

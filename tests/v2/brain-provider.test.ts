import test from "node:test";
import assert from "node:assert/strict";
import { createBrainProviderRegistry } from "../../src/v2/brain/registry.ts";
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

test("BrainProvider registry selects registered provider", () => {
  const registry = createBrainProviderRegistry([createFakeBrainProvider({ providerId: "fake-brain" })]);
  assert.equal(registry.get("fake-brain").providerId, "fake-brain");
  assert.throws(() => registry.get("missing"));
});

test("BrainProvider registry rejects duplicate provider ids", () => {
  assert.throws(
    () =>
      createBrainProviderRegistry([
        createFakeBrainProvider({ providerId: "fake-brain" }),
        createFakeBrainProvider({ providerId: "fake-brain" }),
      ]),
    /duplicate brain provider registered: fake-brain/,
  );
});

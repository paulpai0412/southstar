import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { attemptPiNativeRewind } from "../../src/v2/session-recovery/pi-capabilities.ts";

test("Pi-native rewind unsupported records fallback operation", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-pi"));

  const result = await attemptPiNativeRewind(db, {
    runId: "run-pi",
    taskId: "checker",
    oldSessionId: "pi-session-old",
    baseCheckpointId: "checkpoint-pi",
    anchor: { host: "pi", rootSessionId: "pi-session-old", rewindSupported: false },
    client: { readStatus: async () => "live" },
  });

  assert.equal(result.status, "fallback-required");
  assert.equal(result.reason, "Pi rewind capability unsupported for checkpoint anchor.");
  assert.equal(listResources(db, { resourceType: "session_operation" })[0]?.status, "failed");
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "wf",
      tasks: [],
      harnessDefinitions: [],
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false },
      vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false },
      title: "wf",
      goalPrompt: "todo-web",
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}

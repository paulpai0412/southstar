import test from "node:test";
import assert from "node:assert/strict";
import { mapCubeCommandStatus, withTimeout } from "../../src/v2/executor/cubesandbox/sdk-client.ts";

test("SDK timeout wrapper rejects hanging SDK calls", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 10, "sdk health"),
    /sdk health timed out after 10ms/,
  );
});

test("Cube command status mapping is provider-neutral", () => {
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "running" }), "running");
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "finished", exitCode: 0 }), "completed");
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "finished", exitCode: 2 }), "failed");
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "missing" }), "unknown");
});

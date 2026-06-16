import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeLoopController } from "../../src/v2/server/runtime-loops.ts";

test("runtime loop starts once and stops cleanly", async () => {
  let calls = 0;
  const loop = createRuntimeLoopController({
    intervalMs: 10,
    runOnce: async () => {
      calls += 1;
    },
  });

  loop.start();
  await sleep(35);
  await loop.stop();

  assert.ok(calls >= 1);
});

test("runtime loop is single-flight while previous tick still running", async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const loop = createRuntimeLoopController({
    intervalMs: 5,
    runOnce: async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20);
      inFlight -= 1;
    },
  });

  loop.start();
  await sleep(70);
  await loop.stop();

  assert.ok(calls >= 2);
  assert.equal(maxInFlight, 1);
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

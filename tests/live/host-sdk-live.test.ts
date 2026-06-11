import test from "node:test";
import assert from "node:assert/strict";
import { codexLoader, openCodeLoader } from "../../src/adapters/host/sdk-loaders.ts";

test("live OpenCode SDK package can be loaded", async (t) => {
  if (process.env.NORTHSTAR_LIVE_OPENCODE !== "1") {
    t.skip("Set NORTHSTAR_LIVE_OPENCODE=1 after installing/configuring opencode-ai to run this live SDK smoke.");
    return;
  }

  const sdk = await openCodeLoader();
  assert.equal(typeof sdk, "object");
});

test("live Codex SDK package can be loaded", async (t) => {
  if (process.env.NORTHSTAR_LIVE_CODEX !== "1") {
    t.skip("Set NORTHSTAR_LIVE_CODEX=1 after installing/configuring @openai/codex-sdk to run this live SDK smoke.");
    return;
  }

  const sdk = await codexLoader();
  assert.equal(typeof sdk, "object");
});

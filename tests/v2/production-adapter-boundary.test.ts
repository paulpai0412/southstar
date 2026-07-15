import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("test-only brain and hand adapters are not shipped in production source", () => {
  assert.equal(existsSync(new URL("../../src/v2/brain/fake-brain-provider.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../src/v2/hands/fake-hand-provider.ts", import.meta.url)), false);
});

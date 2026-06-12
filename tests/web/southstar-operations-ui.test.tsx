import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("Southstar built-in web app shell exists and uses operations vocabulary", () => {
  const page = readFileSync(join(root, "app/page.tsx"), "utf8");
  const globals = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(page, /SouthstarOperationsApp/);
  assert.match(globals, /--ss-bg/);
  assert.doesNotMatch(page, /iframe|Tork Web|Northstar/);
});

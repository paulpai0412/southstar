import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

test("session export route leaves runtime-resolved exporter import out of webpack tracing", () => {
  const source = readFileSync(join(root, "web/app/api/sessions/[id]/export/route.ts"), "utf8");

  assert.match(source, /webpackIgnore:\s*true/);
  assert.doesNotMatch(source, /import\(\s*exporterUrl\s*\)/);
});

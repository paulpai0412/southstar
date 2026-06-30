import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("FileExplorer ignores stale directory loads after cwd changes", () => {
  const explorer = source("web/components/FileExplorer.tsx");

  assert.match(explorer, /let cancelled = false/);
  assert.match(explorer, /if \(cancelled\) return/);
  assert.match(explorer, /return \(\) => \{\s*cancelled = true;\s*\}/s);
});

test("FileExplorer only enters loading state when cwd actually changes", () => {
  const explorer = source("web/components/FileExplorer.tsx");

  assert.match(explorer, /if \(cwdChanged\) \{\s*setExpandedPaths\(new Set\(\)\);\s*setLoading\(true\);\s*\}/s);
  assert.doesNotMatch(explorer, /setLoading\(cwdChanged\)/);
});

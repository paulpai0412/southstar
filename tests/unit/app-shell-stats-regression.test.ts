import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("AppShell compares session stats by scalar content instead of object identity", () => {
  const appShell = source("web/components/AppShell.tsx");

  assert.match(appShell, /sameSessionStats/);
  assert.match(appShell, /sameContextUsage/);
  assert.doesNotMatch(appShell, /prev === stats \? prev : stats/);
  assert.doesNotMatch(appShell, /prev === usage \? prev : usage/);
});

test("ChatWindow does not clear AppShell telemetry from an unmount cleanup", () => {
  const chatWindow = source("web/components/ChatWindow.tsx");

  assert.doesNotMatch(
    chatWindow,
    /useEffect\(\(\) => \(\) => \{ onSessionStatsChange\?\.\(null\); \}, \[onSessionStatsChange\]\);/,
    "unmount cleanup can race with ChatWindow remounts and create parent-child update loops",
  );
  assert.doesNotMatch(
    chatWindow,
    /useEffect\(\(\) => \(\) => \{ onContextUsageChange\?\.\(null\); \}, \[onContextUsageChange\]\);/,
    "unmount cleanup can race with ChatWindow remounts and create parent-child update loops",
  );
});

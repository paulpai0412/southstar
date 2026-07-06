import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("chat session sidebar deduplicates cwd change notifications to avoid parent-child update loops", () => {
  const sidebar = source("web/components/SessionSidebar.tsx");

  assert.match(sidebar, /lastNotifiedCwdRef/);
  assert.match(sidebar, /lastNotifiedCwdRef\.current === selectedCwd/);
  assert.match(sidebar, /lastNotifiedCwdRef\.current = selectedCwd/);
});

test("chat session sidebar does not resync an unchanged parent cwd after a local custom path edit", () => {
  const sidebar = source("web/components/SessionSidebar.tsx");

  assert.match(sidebar, /setSelectedCwd\(\(prev\) => \{/);
  assert.match(sidebar, /if \(!selectedCwdProp \|\| prev === selectedCwdProp\) return prev;/);
  assert.match(sidebar, /\}, \[selectedCwdProp\]\);/);
  assert.doesNotMatch(sidebar, /\}, \[selectedCwd,\s*selectedCwdProp\]\);/);
});

test("chat session sidebar reuses cached chat sessions when remounted for the same project", () => {
  const sidebar = source("web/components/SessionSidebar.tsx");

  assert.match(sidebar, /SESSION_CACHE_TTL_MS/);
  assert.match(sidebar, /getCachedSessions/);
  assert.match(sidebar, /setCachedSessions/);
  assert.match(sidebar, /kind=chat/);
});

test("sessions route defaults omitted kind requests to chat sessions", () => {
  const route = source("web/app/api/sessions/route.ts");

  assert.match(route, /function sessionKindFromQuery\(value: string \| null\): SessionKind/);
  assert.match(route, /return value === "workflow" \? "workflow" : "chat";/);
});

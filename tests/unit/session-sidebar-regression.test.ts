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
  assert.match(route, /value === "workflow" \|\| value === "library"/);
  assert.match(route, /return "chat";/);
});

test("workflow generation materializes a workflow-kind session before streaming", () => {
  const hook = source("web/hooks/useAgentSession.ts");

  assert.match(hook, /if \(opts\.workflowMode && !images\?\.length && !isSlashCommandPrompt\) \{[\s\S]*const workflowSessionId = sessionIdRef\.current \?\? await ensureNewSession\(\);[\s\S]*generateWorkflowDagStream/);
  assert.match(hook, /if \(workflowSessionId\) promoteNewSession\(1, trimmedMessage\);/);
});

test("library sidebar sessions stay on the library workspace session model", () => {
  const librarySidebar = source("web/components/library/LibrarySidebar.tsx");

  assert.doesNotMatch(librarySidebar, /api\/sessions/);
  assert.match(librarySidebar, /data-testid="library-session-list"/);
});

test("workflow sidebar lists workflow sessions even before a project is selected", () => {
  const workflowSidebar = source("web/components/WorkflowSidebar.tsx");
  const route = source("web/app/api/sessions/route.ts");

  assert.match(workflowSidebar, /scope=all&kind=workflow&limit=50&compact=1/);
  assert.doesNotMatch(workflowSidebar, /if \(!cwd\) \{\s*setSessions\(\[\]\);/);
  assert.match(route, /compactSession/);
  assert.match(route, /searchParams\.get\("limit"\)/);
  assert.match(route, /listRecentSessionsByKind/);
  assert.doesNotMatch(route, /scope === "all" \? await listAllSessions\(\) : await listSessionsForCwd\(cwd\)/);
});

test("library workspace uses dedicated library chat sessions", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");

  assert.match(workspace, /fetch\("\/api\/library\/chat\/sessions\?limit=50"/);
  assert.match(workspace, /readRuntimeLibrarySessions/);
  assert.match(workspace, /isLibrarySessionSummary/);
  assert.match(workspace, /LibraryChatWindow/);
  assert.match(workspace, /onLibraryChanged=\{context\.refreshWorkspace\}/);
  assert.doesNotMatch(workspace, /\/api\/sessions\?scope=all&kind=library/);
  assert.doesNotMatch(workspace, /sessionKind="library"/);
  assert.doesNotMatch(workspace, /selectedChatSession/);
  assert.doesNotMatch(workspace, /LIBRARY_SESSIONS_STORAGE_KEY/);
});

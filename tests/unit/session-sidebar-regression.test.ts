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

test("chat session sidebar never uses the slow unbounded all-session path", () => {
  const sidebar = source("web/components/SessionSidebar.tsx");

  assert.match(sidebar, /kind=chat&scope=all&limit=50&compact=1/);
  assert.doesNotMatch(sidebar, /kind=chat&scope=all["`]/);
});

test("project scope picker never uses the slow unbounded all-session path", () => {
  const picker = source("web/components/ProjectScopePicker.tsx");

  assert.match(picker, /kind=chat&scope=all&limit=50&compact=1/);
  assert.doesNotMatch(picker, /api\/sessions\?scope=all["`]/);
});

test("AppShell only mounts the active session sidebar surface", () => {
  const appShell = source("web/components/AppShell.tsx");

  assert.match(appShell, /sidebarPanelBodyStyle/);
  assert.match(appShell, /activeSidebarSurface === "workflow" \?/);
  assert.match(appShell, /activeSidebarSurface === "library" \?/);
  assert.doesNotMatch(appShell, /sidebarPanelStyle\(activeSidebarSurface/);
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
  assert.doesNotMatch(workflowSidebar, /kind=workflow&cwd=/);
  assert.doesNotMatch(workflowSidebar, /if \(!cwd\) \{\s*setSessions\(\[\]\);/);
  assert.match(route, /compactSession/);
  assert.match(route, /searchParams\.get\("limit"\)/);
  assert.match(route, /listRecentSessionsByKind/);
  assert.doesNotMatch(route, /scope === "all" \? await listAllSessions\(\) : await listSessionsForCwd\(cwd\)/);
});

test("library import candidate checkboxes update from current selection state", () => {
  const block = source("web/components/library/LibraryCandidateMessageBlock.tsx");

  assert.match(block, /setSelected\(\(current\) => \{/);
  assert.doesNotMatch(block, /const next = new Set\(selected\);/);
});

test("library workspace uses Pi library sessions with dedicated library chat commands", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");
  const hook = source("web/hooks/useAgentSession.ts");

  assert.match(workspace, /fetch\("\/api\/sessions\?scope=all&kind=library&limit=50&compact=1"/);
  assert.match(workspace, /readPiLibrarySessions/);
  assert.match(workspace, /isPiLibrarySession/);
  assert.match(workspace, /ChatWindow/);
  assert.match(workspace, /sessionKind="library"/);
  assert.match(workspace, /libraryScope=\{context\.selectedScope\}/);
  assert.match(hook, /runLibraryChatCommand/);
  assert.match(hook, /sessionKind === "library"/);
  assert.doesNotMatch(workspace, /\/api\/library\/chat\/sessions\?limit=50/);
  assert.doesNotMatch(workspace, /LibraryChatWindow/);
  assert.doesNotMatch(workspace, /selectedChatSession/);
  assert.doesNotMatch(workspace, /LIBRARY_SESSIONS_STORAGE_KEY/);
});

test("library session selections are loaded by the shared chat window", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");

  assert.match(workspace, /selectedLibrarySession/);
  assert.match(workspace, /session=\{context\.selectedLibrarySession\}/);
  assert.match(workspace, /newSessionCwd=\{context\.selectedLibrarySession \? null : context\.selectedCwd\}/);
  assert.match(workspace, /setLibrarySessionKey\(\(value\) => value \+ 1\);/);
  assert.doesNotMatch(workspace, /session=\{null\}/);
});

test("workflow session selections suppress the duplicate cwd remount", () => {
  const appShell = source("web/components/AppShell.tsx");
  const selectWorkflowSession = appShell.match(/const handleSelectWorkflowSession = useCallback\(\(session: SessionInfo\) => \{[\s\S]*?\n  \}, \[router\]\);/);

  assert.ok(selectWorkflowSession);
  assert.match(selectWorkflowSession[0], /suppressCwdBumpRef\.current = true;/);
  assert.match(selectWorkflowSession[0], /setWorkflowSessionKey\(\(k\) => k \+ 1\);/);
});

test("AppShell restores workflow session URLs through the workflow surface", () => {
  const appShell = source("web/components/AppShell.tsx");

  assert.match(appShell, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(initialSessionId\)\}`/);
  assert.match(appShell, /info\.kind === "workflow"/);
  assert.match(appShell, /setAppMode\("workflow"\)/);
  assert.match(appShell, /setWorkflowSelectedSession\(info\)/);
});

test("AppShell restores library session URLs through the library surface", () => {
  const appShell = source("web/components/AppShell.tsx");

  assert.match(appShell, /info\.kind === "library"/);
  assert.match(appShell, /setAppMode\("library"\)/);
  assert.match(appShell, /setRestoredLibrarySession\(info\)/);
  assert.match(appShell, /restoredSession=\{restoredLibrarySession\}/);
});

test("library workspace accepts a restored shared session without refetching every surface", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");

  assert.match(workspace, /restoredSession\?: SessionInfo \| null/);
  assert.match(workspace, /if \(!restoredSession \|\| restoredSession\.kind !== "library"\) return;/);
  assert.match(workspace, /setSelectedSessionId\(restoredSession\.id\)/);
  assert.match(workspace, /mergePiLibrarySessions\(current, \[restoredSession\]\)/);
});

test("single session route does not scan every session to load parent metadata", () => {
  const route = source("web/app/api/sessions/[id]/route.ts");

  assert.doesNotMatch(route, /listAllSessions/);
  assert.match(route, /parentSessionIdFromHeader/);
  assert.match(route, /kind: classifySessionKindForSession/);
});

test("single session route allows the loaded cwd before file explorer reads it", () => {
  const route = source("web/app/api/sessions/[id]/route.ts");

  assert.match(route, /allowFileRoot/);
  assert.match(route, /if \(header\?\.cwd\) allowFileRoot\(header\.cwd\);/);
});

test("recent session list reads bounded session summaries instead of full JSONL files", () => {
  const reader = source("web/lib/session-reader.ts");
  const readCandidate = reader.match(/async function readSessionInfoCandidate[\s\S]*?\n}/)?.[0] ?? "";

  assert.ok(readCandidate);
  assert.match(reader, /SESSION_SUMMARY_BYTES/);
  assert.match(reader, /readSessionSummaryEntries/);
  assert.doesNotMatch(readCandidate, /readFile\(filePath,\s*"utf8"\)/);
  assert.doesNotMatch(readCandidate, /raw\.split\("\\n"\)/);
});

test("file allowed roots do not scan every session before listing files", () => {
  const fileAccess = source("web/lib/file-access.ts");

  assert.doesNotMatch(fileAccess, /from "\.\/session-reader"/);
  assert.doesNotMatch(fileAccess, /listAllSessions\(/);
});

test("library and workflow session row actions are hidden until hover or focus", () => {
  const librarySidebar = source("web/components/library/LibrarySidebar.tsx");
  const workflowSidebar = source("web/components/WorkflowSidebar.tsx");
  const css = source("web/app/globals.css");

  assert.match(librarySidebar, /className="southstar-session-row"/);
  assert.match(librarySidebar, /className="southstar-session-row-actions"/);
  assert.match(workflowSidebar, /className="southstar-session-row"/);
  assert.match(workflowSidebar, /className="southstar-session-row-actions"/);
  assert.match(css, /\.southstar-session-row-actions\s*\{[\s\S]*opacity: 0;/);
  assert.match(css, /\.southstar-session-row:hover \.southstar-session-row-actions/);
  assert.match(css, /\.southstar-session-row:focus-within \.southstar-session-row-actions/);
});

test("session reader repairs legacy library import sessions from cwd metadata", () => {
  const reader = source("web/lib/session-reader.ts");
  const kind = source("web/lib/session-kind.ts");

  assert.match(reader, /SOUTHSTAR_LIBRARY_IMPORT_ROOT/);
  assert.match(reader, /southstar-library-imports/);
  assert.match(reader, /classifySessionKindForSession\(header\.cwd, entries\)/);
  assert.doesNotMatch(kind, /SOUTHSTAR_WORKFLOW_COMPOSER_PROMPT_PREFIX/);
});

test("workflow v2 proxy returns JSON when the runtime API is unavailable", () => {
  const proxy = source("web/lib/workflow/v2-api.ts");

  assert.match(proxy, /catch \(error\)/);
  assert.match(proxy, /status: 502/);
});

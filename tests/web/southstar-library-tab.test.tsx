import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("App mode rail exposes Library mode and AppShell renders persistent library panel", () => {
  const rail = source("web/components/AppModeRail.tsx");
  assert.match(rail, /"library"/);
  assert.match(rail, /Library/);
  assert.ok(
    rail.indexOf('id: "chat"') < rail.indexOf('id: "library"')
      && rail.indexOf('id: "library"') < rail.indexOf('id: "workflow"')
      && rail.indexOf('id: "workflow"') < rail.indexOf('id: "operator"'),
    "App mode rail should order tabs Chat, Library, Workflow, Operator",
  );
  const appShell = source("web/components/AppShell.tsx");
  assert.match(appShell, /LibraryWorkspaceProvider/);
  assert.match(appShell, /data-testid="library-sidebar-panel"/);
  assert.match(appShell, /sidebarPanelStyle\(activeSidebarSurface === "library"\)/);
  assert.match(appShell, /LibrarySidebarPanel/);
  assert.match(appShell, /kind === "libraryFile"/);
  assert.match(appShell, /kind:\s*"libraryFile"/);
  assert.match(appShell, /LibraryFileSidecarPanel/);
  assert.match(appShell, /onOpenFile=\{handleOpenLibraryFile\}/);
  assert.match(appShell, /LibraryWorkspace/);
  assert.match(appShell, /data-testid="library-mode-panel"/);
  assert.match(appShell, /modePanelStyle\(appMode === "library"\)/);
});

test("AppShell places export and branch controls beside theme before mode tabs", () => {
  const appShell = source("web/components/AppShell.tsx");
  assert.match(appShell, /data-testid="chat-topbar-controls"/);
  assert.match(appShell, /aria-label="Export HTML"/);
  assert.match(appShell, /BranchNavigator/);
  assert.ok(
    appShell.indexOf("toggleTheme") < appShell.indexOf('data-testid="chat-topbar-controls"')
      && appShell.indexOf('data-testid="chat-topbar-controls"') < appShell.indexOf("<AppModeRail"),
    "top bar should place theme, then chat controls, then tabs",
  );
});

test("Library workspace follows AppShell sidebar plus center chat and file viewer layout", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");
  assert.match(workspace, /LibraryWorkspaceProvider/);
  assert.match(workspace, /LibrarySidebarPanel/);
  assert.match(workspace, /LibraryFileSidecarPanel/);
  assert.match(workspace, /librarySessionKey/);
  assert.match(workspace, /handleNewSession/);
  assert.match(workspace, /onNewSession=\{context\.handleNewSession\}/);
  assert.match(workspace, /onRefresh=\{context\.refreshWorkspace\}/);
  assert.match(workspace, /const canRenderLibraryChat = Boolean\(context\.selectedCwd\)/);
  assert.match(workspace, /canRenderLibraryChat \? \(/);
  assert.doesNotMatch(workspace, /\/api\/default-cwd/);
  assert.match(workspace, /ChatWindow/);
  assert.match(workspace, /sessionKind="library"/);
  assert.match(workspace, /libraryScope=\{context\.selectedScope\}/);
  assert.match(workspace, /\/api\/library\/chat\/sessions\?limit=50/);
  assert.match(workspace, /data-testid="library-chat-empty-new"/);
  assert.doesNotMatch(workspace, /selectedChatSession/);
  assert.doesNotMatch(workspace, /LibraryChatWindow/);
  assert.doesNotMatch(workspace, /\/api\/sessions\?scope=all&kind=library/);
  assert.match(workspace, /LibraryFileViewer/);
  assert.match(workspace, /gridTemplateColumns:\s*"minmax\(0, 1fr\)"/);
  assert.doesNotMatch(workspace, /gridTemplateColumns:\s*"260px minmax\(0, 1fr\) 360px"/);
  assert.doesNotMatch(workspace, /gridTemplateColumns:\s*"minmax\(0, 1fr\) 360px"/);
  assert.doesNotMatch(workspace, /data-testid="library-file-viewer"/);
  assert.match(workspace, /data-testid="library-file-sidecar"/);
  assert.doesNotMatch(source("web/components/library/LibrarySidebar.tsx"), /library-quick-prompt/);
  assert.doesNotMatch(source("web/components/library/LibrarySidebar.tsx"), /Import or create library item/);
  assert.match(source("web/components/library/LibrarySidebar.tsx"), /ProjectScopePicker/);
  assert.doesNotMatch(source("web/components/library/LibrarySidebar.tsx"), /library-domain-filter/);
  assert.doesNotMatch(source("web/components/library/LibrarySidebar.tsx"), /Filter Library Domain Tree/);
  assert.match(source("web/components/library/LibrarySidebar.tsx"), /New Library session/);
  assert.match(source("web/components/library/LibrarySidebar.tsx"), /title="Refresh"/);
  assert.match(source("web/lib/library/chat-stream.ts"), /\/api\/library\/chat\/messages/);
  assert.match(source("web/lib/library/chat-stream.ts"), /\/api\/library\/chat\/events/);
  assert.match(source("web/hooks/useAgentSession.ts"), /sessionKind === "library"/);
  assert.match(source("web/hooks/useAgentSession.ts"), /runLibraryChatCommand/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /LibraryGraphChart/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /library-graph-domain-filter/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /new URLSearchParams\(\{ scope: selectedScope \}\)/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /\/api\/library\/graph\?\$\{params\.toString\(\)\}/);
  assert.match(source("web/components/library/LibraryGraphChart.tsx"), /<svg/);
  assert.match(source("web/components/library/LibraryFileViewer.tsx"), /textarea/);
});

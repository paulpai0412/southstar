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
  assert.match(appShell, /sidebarPanelStyle\(appMode === "library"\)/);
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
  assert.match(workspace, /onRefresh=\{context\.loadWorkspace\}/);
  assert.match(workspace, /key=\{context\.librarySessionKey\}/);
  assert.match(workspace, /LibraryChatWindow/);
  assert.match(workspace, /LibraryFileViewer/);
  assert.match(workspace, /gridTemplateColumns:\s*"minmax\(0, 1fr\)"/);
  assert.doesNotMatch(workspace, /gridTemplateColumns:\s*"260px minmax\(0, 1fr\) 360px"/);
  assert.doesNotMatch(workspace, /gridTemplateColumns:\s*"minmax\(0, 1fr\) 360px"/);
  assert.doesNotMatch(workspace, /data-testid="library-file-viewer"/);
  assert.match(workspace, /data-testid="library-file-sidecar"/);
  assert.doesNotMatch(source("web/components/library/LibrarySidebar.tsx"), /library-quick-prompt/);
  assert.doesNotMatch(source("web/components/library/LibrarySidebar.tsx"), /Import or create library item/);
  assert.match(source("web/components/library/LibrarySidebar.tsx"), /PiAgentTitle/);
  assert.match(source("web/components/library/LibrarySidebar.tsx"), /New Library session/);
  assert.match(source("web/components/library/LibrarySidebar.tsx"), /title="Refresh"/);
  const libraryChatWindow = source("web/components/library/LibraryChatWindow.tsx");
  assert.match(libraryChatWindow, /ChatInput/);
  assert.match(libraryChatWindow, /CHAT_MINIMAP_WIDTH\s*=\s*36/);
  assert.match(libraryChatWindow, /CHAT_COLUMN_PADDING\s*=\s*16/);
  assert.match(libraryChatWindow, /CHAT_INPUT_RIGHT_PADDING\s*=\s*CHAT_COLUMN_PADDING \+ CHAT_MINIMAP_WIDTH/);
  assert.match(libraryChatWindow, /data-testid="library-chat-minimap-spacer"/);
  assert.match(libraryChatWindow, /const isEmptyNew = frames\.length === 0 && !running/);
  assert.match(libraryChatWindow, /data-testid="library-chat-empty-new"/);
  assert.match(libraryChatWindow, /isEmptyNew \? \(/);
  assert.match(libraryChatWindow, /padding:\s*`0 \$\{CHAT_COLUMN_PADDING\}px`/);
  assert.match(libraryChatWindow, /modelList=\{modelControls\.modelList\}/);
  assert.match(libraryChatWindow, /modelNames=\{modelControls\.modelNames\}/);
  assert.match(libraryChatWindow, /model=\{modelControls\.selectedModel\}/);
  assert.match(libraryChatWindow, /onModelChange=\{handleModelChange\}/);
  assert.match(libraryChatWindow, /onThinkingLevelChange=\{setThinkingLevel\}/);
  assert.match(libraryChatWindow, /onToolPresetChange=\{setToolPreset\}/);
  assert.match(libraryChatWindow, /runLibraryChatCommand/);
  assert.doesNotMatch(libraryChatWindow, /Ask Library to inspect/);
  assert.doesNotMatch(libraryChatWindow, /borderTop:\s*"1px solid var\(--border\)"/);
  assert.doesNotMatch(libraryChatWindow, /data-testid="library-chat-input"/);
  assert.doesNotMatch(libraryChatWindow, /data-testid="library-chat-send"/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /LibraryGraphChart/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /library-graph-domain-filter/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /new URLSearchParams\(\{ scope: selectedScope \}\)/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /\/api\/library\/graph\?\$\{params\.toString\(\)\}/);
  assert.match(source("web/components/library/LibraryGraphChart.tsx"), /<svg/);
  assert.match(source("web/components/library/LibraryFileViewer.tsx"), /textarea/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("App mode rail exposes Library mode and AppShell renders persistent library panel", () => {
  assert.match(source("web/components/AppModeRail.tsx"), /"library"/);
  assert.match(source("web/components/AppModeRail.tsx"), /Library/);
  const appShell = source("web/components/AppShell.tsx");
  assert.match(appShell, /LibraryWorkspace/);
  assert.match(appShell, /data-testid="library-mode-panel"/);
  assert.match(appShell, /modePanelStyle\(appMode === "library"\)/);
});

test("Library workspace has domain sidebar, chat SSE center, and right file viewer", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");
  assert.match(workspace, /LibrarySidebar/);
  assert.match(workspace, /LibraryChatWindow/);
  assert.match(workspace, /LibraryFileViewer/);
  assert.match(source("web/components/library/LibraryChatWindow.tsx"), /runLibraryChatCommand/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /LibraryGraphChart/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /library-graph-domain-filter/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /new URLSearchParams\(\{ scope: selectedScope \}\)/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /\/api\/library\/graph\?\$\{params\.toString\(\)\}/);
  assert.match(source("web/components/library/LibraryGraphChart.tsx"), /<svg/);
  assert.match(source("web/components/library/LibraryFileViewer.tsx"), /textarea/);
});

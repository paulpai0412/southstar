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

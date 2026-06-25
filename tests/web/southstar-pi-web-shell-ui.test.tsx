import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function hasCssSelector(css: string, selector: string): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*\\{`, "m").test(css);
}

test("app root references SouthstarPiWebShell", () => {
  assert.match(source("app/page.tsx"), /SouthstarPiWebShell/);
  assert.match(source("app/page.tsx"), /SouthstarProductShell/);
  assert.doesNotMatch(source("app/page.tsx"), /compatibility token/i);
});

test("SouthstarPiWebShell composes chat workspace components instead of inline placeholders", () => {
  const shell = source("components/southstar/app/SouthstarPiWebShell.tsx");
  assert.match(shell, /SouthstarChatSessionSidebar/);
  assert.match(shell, /SouthstarChatTab/);
  assert.match(shell, /SouthstarChatFileViewerPanel/);
  assert.doesNotMatch(shell, /function SessionSidebar/);
  assert.doesNotMatch(shell, /function ChatWindow/);
  assert.doesNotMatch(shell, /function FileViewer/);
  assert.doesNotMatch(shell, /placeholder/i);
  assert.doesNotMatch(shell, /contractSymbols/);
  assert.match(shell, /if\s*\(\s*nextView\s*===\s*view\s*\)\s*return/);
});

test("chat sidebar loads run and session data from Southstar APIs", () => {
  const sidebar = source("components/southstar/chat/SouthstarChatSessionSidebar.tsx");
  assert.match(sidebar, /getUiOperatorOverview/);
  assert.match(sidebar, /getUiSessionsMemory/);
  assert.match(sidebar, /onSelectRunId/);
  assert.match(sidebar, /onSelectSessionId/);
  assert.doesNotMatch(sidebar, /const runs = \[/);
  assert.doesNotMatch(sidebar, /const sessions = \[/);
});

test("chat transcript panel streams runtime events and sends steering messages", () => {
  const transcript = source("components/southstar/chat/ChatTranscriptPanel.tsx");
  assert.match(transcript, /events\/stream/);
  assert.match(transcript, /EventSource/);
  assert.match(transcript, /api\.steer/);
  assert.match(transcript, /textarea/);
  assert.doesNotMatch(transcript, /Chat transcript and prompt input placeholder/);
});

test("WorkspaceTabs uses Chat Workflow Operator and removes legacy labels", () => {
  const tabs = source("components/southstar/workspace/WorkspaceTabs.tsx");
  assert.match(tabs, /\bChat\b/);
  assert.match(tabs, /\bWorkflow\b/);
  assert.match(tabs, /\bOperator\b/);
  assert.doesNotMatch(tabs, /Operations|Northstar/);
});

test("globals.css contains pi-web tokens and dark mode selector", () => {
  const css = source("app/globals.css");
  assert.match(css, /--bg\b/);
  assert.match(css, /--bg-panel\b/);
  assert.match(css, /--bg-hover\b/);
  assert.match(css, /--bg-selected\b/);
  assert.match(css, /--accent\b/);
  assert.match(css, /html\.dark/);
  for (const selector of [
    ".ss-pi-shell",
    ".ss-pi-sidebar",
    ".ss-pi-main",
    ".ss-pi-topbar",
    ".ss-pi-content",
    ".ss-pi-file-viewer",
    ".ss-workflow-workbench",
    ".ss-operator-board",
  ]) {
    assert.equal(hasCssSelector(css, selector), true, `missing selector: ${selector}`);
  }
});

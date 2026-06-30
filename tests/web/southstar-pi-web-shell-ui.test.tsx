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

test("web app root references AppShell", () => {
  assert.match(source("web/app/page.tsx"), /AppShell/);
  assert.match(source("web/app/page.tsx"), /Suspense/);
  assert.doesNotMatch(source("web/app/page.tsx"), /compatibility token/i);
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

test("chat transcript panel streams runtime events with explicit steering separated from native chat", () => {
  const transcript = source("components/southstar/chat/ChatTranscriptPanel.tsx");
  assert.match(transcript, /events\/stream/);
  assert.match(transcript, /EventSource/);
  assert.match(transcript, /api\.steer/);
  assert.match(transcript, /textarea/);
  assert.match(transcript, /Runtime steering|Steer selected run/);
  assert.doesNotMatch(transcript, /<label htmlFor="southstar-chat-message">Message<\/label>/);
  assert.doesNotMatch(transcript, /Chat transcript and prompt input placeholder/);
});

test("chat tab composes a native pi-web style chat workspace and keeps runtime transcript separate", () => {
  const chatTab = source("components/southstar/chat/SouthstarChatTab.tsx");
  assert.match(chatTab, /SouthstarNativeChatWorkspace/);
  assert.match(chatTab, /ChatTranscriptPanel/);
  assert.match(chatTab, /ss-runtime-transcript-drawer|ss-runtime-transcript-panel/);
  assert.match(chatTab, /runtime transcript/i);
  assert.doesNotMatch(chatTab, /<ChatTranscriptPanel[\s\S]*\/>\s*<\/section>\s*;?\s*}/);
});

test("native chat workspace ports pi-web chat controls without depending on pi-web runtime imports", () => {
  const workspace = source("components/southstar/chat/SouthstarNativeChatWorkspace.tsx");
  assert.match(workspace, /SouthstarChatInput/);
  assert.match(workspace, /SouthstarChatMinimap/);
  assert.match(workspace, /SouthstarBranchNavigator/);
  assert.match(workspace, /getUiChatCapabilities/);
  assert.match(workspace, /getUiChatSession/);
  assert.match(workspace, /sendChatMessage/);
  assert.match(workspace, /onRuntimeStatusChange/);
  assert.match(workspace, /selectedSessionId/);
  assert.doesNotMatch(workspace, /api\.steer/);
  assert.doesNotMatch(workspace, /from ["']\/home\/timmypai\/apps\/pi-web/);
  assert.doesNotMatch(workspace, /from ["']@\/hooks\/useAgentSession/);
  assert.doesNotMatch(workspace, /modelList\s*=\s*\[/);
  assert.doesNotMatch(workspace, /installedSkillCommands\s*=\s*\[/);
});

test("native chat sends selected branch parent and reconciles optimistic local echo", () => {
  const workspace = source("components/southstar/chat/SouthstarNativeChatWorkspace.tsx");
  const client = source("lib/southstar/api-client.ts");

  assert.match(client, /parentMessageId\?: string/);
  assert.match(workspace, /parentMessageId:\s*activeLeafId/);
  assert.match(workspace, /setActiveLeafId\(result\.messageId\)/);
  assert.match(workspace, /reconcileLocalChatMessages/);
  assert.match(workspace, /setLocalMessages\(\(current\) => reconcileLocalChatMessages\(current,\s*result\.messageId\)\)/);
  assert.doesNotMatch(workspace, /const leaf = lastLeaf\(branchTree\[0\]!\)/);
});

test("native chat helper initializes active leaf from server model and clears confirmed local echo", async () => {
  const workspaceModule = await import("../../components/southstar/chat/SouthstarNativeChatWorkspace.tsx");
  assert.equal(typeof (workspaceModule as any).activeLeafIdFromChatSession, "function");
  assert.equal(typeof (workspaceModule as any).reconcileLocalChatMessages, "function");

  assert.equal(
    (workspaceModule as any).activeLeafIdFromChatSession({
      activeLeafId: "msg-server-active",
      branchTree: [{ id: "msg-root", label: "root", role: "user", children: [{ id: "msg-server-active", label: "leaf", role: "assistant", children: [] }] }],
    }),
    "msg-server-active",
  );
  assert.deepEqual(
    (workspaceModule as any).reconcileLocalChatMessages([
      { id: "local-1", role: "user", text: "sent", timestamp: "now" },
      { id: "persisted-1", role: "assistant", text: "older" },
    ], "persisted-user-1"),
    [{ id: "persisted-1", role: "assistant", text: "older" }],
  );
});

test("native chat input includes model skill tool thinking attachments and streaming steer behavior", () => {
  const input = source("components/southstar/chat/SouthstarChatInput.tsx");
  for (const token of [
    "modelList",
    "onModelChange",
    "skillCommands",
    "slashSuggestions",
    "toolPreset",
    "thinkingLevel",
    "AttachedImage",
    "onSteer",
    "onFollowUp",
    "onCompact",
    "onAbort",
    "onPaste",
    "onKeyDown",
  ]) {
    assert.match(input, new RegExp(token));
  }
  assert.match(input, /attachmentsEnabled/);
  assert.match(input, /disabled=\{!props\.attachmentsEnabled \|\| props\.isStreaming\}/);
  assert.doesNotMatch(input, /const SLASH_COMMANDS\s*=\s*\[/);
  assert.doesNotMatch(input, /fetch\(["']\/api\/skills\/installed["']\)/);
  assert.doesNotMatch(input, /props\.onSend\(message,\s*attachedImages/);
});

test("native chat branch navigator and minimap are local Southstar ports", () => {
  const branch = source("components/southstar/chat/SouthstarBranchNavigator.tsx");
  const minimap = source("components/southstar/chat/SouthstarChatMinimap.tsx");
  assert.match(branch, /activeLeafId/);
  assert.match(branch, /onLeafChange/);
  assert.match(branch, /hasBranch/);
  assert.match(minimap, /messageRefs/);
  assert.match(minimap, /scrollContainer/);
  assert.match(minimap, /scrollToMinimapRatio/);
  assert.match(minimap, /ResizeObserver/);
});

test("api client exposes data-driven chat capabilities for model and skill controls", () => {
  const client = source("lib/southstar/api-client.ts");
  assert.match(client, /getUiChatCapabilities/);
  assert.match(client, /\/api\/v2\/ui\/chat-capabilities/);
  assert.match(client, /getUiChatSession/);
  assert.match(client, /\/api\/v2\/ui\/chat-session/);
  assert.match(client, /sendChatMessage/);
  assert.match(client, /\/api\/v2\/chat\/sessions/);
});

test("WorkspaceTabs uses Chat Workflow Operator and removes legacy labels", () => {
  const tabs = source("components/southstar/workspace/WorkspaceTabs.tsx");
  assert.match(tabs, /\bChat\b/);
  assert.match(tabs, /\bWorkflow\b/);
  assert.match(tabs, /\bOperator\b/);
  assert.doesNotMatch(tabs, /Operations|Northstar/);
});

test("globals.css contains pi-web tokens and dark mode selector", () => {
  const css = source("web/app/globals.css");
  assert.match(css, /--bg\b/);
  assert.match(css, /--bg-panel\b/);
  assert.match(css, /--bg-hover\b/);
  assert.match(css, /--bg-selected\b/);
  assert.match(css, /--accent\b/);
  assert.match(css, /html\.dark/);
  for (const selector of [
    ".sidecar-shell",
    ".sidecar-tabs",
    ".ss-workflow-canvas",
    ".operator-workspace",
    ".operator-panel",
    ".operator-state-grid",
    ".project-scope-button",
    ".operator-debug-panel",
  ]) {
    assert.equal(hasCssSelector(css, selector), true, `missing selector: ${selector}`);
  }
});

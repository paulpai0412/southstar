import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visiblePanelsForMode } from "../../components/southstar/view-mode.ts";

const root = join(import.meta.dirname, "../..");

test("Southstar built-in web app shell exists and uses operations vocabulary", () => {
  const page = readFileSync(join(root, "web/app/page.tsx"), "utf8");
  const globals = readFileSync(join(root, "web/app/globals.css"), "utf8");
  assert.match(page, /AppShell/);
  assert.doesNotMatch(page, /redirect\(/);
  assert.match(globals, /--bg\b/);
  assert.match(globals, /--bg-panel\b/);
  assert.doesNotMatch(page, /iframe|Tork Web|Northstar/);
});

test("simple and full mode expose the expected operation panels", () => {
  assert.deepEqual(visiblePanelsForMode("simple"), [
    "planner-chat",
    "workflow-canvas",
    "runtime-monitor",
    "task-detail",
  ]);
  assert.deepEqual(visiblePanelsForMode("full"), [
    "planner-chat",
    "workflow-canvas",
    "runtime-monitor",
    "task-detail",
    "agent-definitions",
    "sessions-memory",
    "vault-mcp",
    "executor-ops",
    "approval-policy",
  ]);
});

test("planner chat keeps voice transcript inside the planner surface", () => {
  const planner = readFileSync(join(root, "components/southstar/PlannerChat.tsx"), "utf8");
  assert.match(planner, /Voice Transcript/);
  assert.match(planner, /Goal Prompt/);
  assert.match(planner, /Steering/);
  assert.doesNotMatch(planner, /VoicePanel|Voice Command Panel/);
});

test("southstar UI controls are wired to runtime state instead of static demo data", () => {
  const appShell = readFileSync(join(root, "components/southstar/AppShell.tsx"), "utf8");
  const planner = readFileSync(join(root, "components/southstar/PlannerChat.tsx"), "utf8");
  const canvas = readFileSync(join(root, "components/southstar/WorkflowCanvas.tsx"), "utf8");
  const runtime = readFileSync(join(root, "components/southstar/RuntimeMonitor.tsx"), "utf8");
  const taskDetail = readFileSync(join(root, "components/southstar/TaskDetail.tsx"), "utf8");

  assert.match(appShell, /createSouthstarApiClient/);
  assert.match(appShell, /api\.getUiPlanner/);
  assert.match(appShell, /selectedRunId/);
  assert.match(appShell, /currentRunId/);
  assert.match(planner, /onCreateDraft/);
  assert.match(planner, /onRunDraft/);
  assert.match(planner, /value=\{goalPrompt\}/);
  assert.doesNotMatch(planner, /<textarea[\s\S]*defaultValue=/);
  assert.doesNotMatch(canvas, /const nodes = \[/);
  assert.doesNotMatch(runtime, /implementer running tests/);
  assert.doesNotMatch(taskDetail, /implementation-report/);
});

test("task detail exposes TaskEnvelopeV2 context evidence for selected runtime tasks", () => {
  const appShell = readFileSync(join(root, "components/southstar/AppShell.tsx"), "utf8");
  const apiClient = readFileSync(join(root, "lib/southstar/api-client.ts"), "utf8");
  const taskDetail = readFileSync(join(root, "components/southstar/TaskDetail.tsx"), "utf8");
  const types = readFileSync(join(root, "components/southstar/types.ts"), "utf8");

  assert.match(apiClient, /getTaskEnvelope/);
  assert.match(apiClient, /getUiTaskDetail/);
  assert.match(appShell, /selectedEnvelope/);
  assert.match(appShell, /api\.getTaskEnvelope/);
  assert.match(appShell, /api\.getUiTaskDetail/);
  assert.match(taskDetail, /TaskEnvelopeV2/);
  assert.match(taskDetail, /ContextPacket/);
  assert.match(taskDetail, /Memory Injection/);
  assert.match(taskDetail, /Evaluator/);
  assert.match(taskDetail, /Workspace/);
  assert.match(types, /TaskEnvelopeEvidenceView/);
  assert.match(types, /UiTaskDetailPageView/);
});

test("task detail operations bind to real session and worktree command APIs", () => {
  const appShell = readFileSync(join(root, "components/southstar/AppShell.tsx"), "utf8");
  const taskDetail = readFileSync(join(root, "components/southstar/TaskDetail.tsx"), "utf8");

  assert.match(appShell, /\/api\/v2\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/\$\{command\}/);
  assert.match(appShell, /\/worktree\/snapshots/);
  assert.match(appShell, /\/worktree\/rollback-preview/);
  assert.match(appShell, /\/worktree\/rollback/);
  assert.match(appShell, /ensureAccepted/);
  assert.match(taskDetail, /onResetSession/);
  assert.match(taskDetail, /onApplyWorktreeRollback/);
  assert.match(taskDetail, /model\?\.worktree\?\.rollbackPreviews/);
});

test("control plane layout mirrors the accepted 1:1 dashboard anatomy", () => {
  const appShell = readFileSync(join(root, "components/southstar/AppShell.tsx"), "utf8");
  const canvas = readFileSync(join(root, "components/southstar/WorkflowCanvas.tsx"), "utf8");
  const taskDetail = readFileSync(join(root, "components/southstar/TaskDetail.tsx"), "utf8");
  const globals = readFileSync(join(root, "web/app/globals.css"), "utf8");

  assert.match(appShell, /ss-control-plane/);
  assert.match(appShell, /ss-left-stack/);
  assert.match(appShell, /ss-center-stack/);
  assert.match(appShell, /ss-right-inspector/);
  assert.match(canvas, /<svg/);
  assert.match(canvas, /<path/);
  assert.match(canvas, /ss-dag-node/);
  assert.match(taskDetail, /Overview/);
  assert.match(taskDetail, /Context & Memory/);
  assert.match(taskDetail, /Evaluator/);
  assert.match(taskDetail, /Artifacts/);
  assert.match(taskDetail, /Logs/);
  assert.match(taskDetail, /Session Graph/);
  assert.match(taskDetail, /Worktree Console/);
  assert.match(taskDetail, /Retry Task/);
  assert.match(taskDetail, /Fork Session/);
  assert.match(globals, /operator-state-grid/);
  assert.match(globals, /sidecar-shell/);
});

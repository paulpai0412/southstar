import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visiblePanelsForMode } from "../../components/southstar/view-mode.ts";

const root = join(import.meta.dirname, "../..");

test("Southstar built-in web app shell exists and uses operations vocabulary", () => {
  const page = readFileSync(join(root, "app/page.tsx"), "utf8");
  const globals = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(page, /SouthstarOperationsApp/);
  assert.match(globals, /--ss-bg/);
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

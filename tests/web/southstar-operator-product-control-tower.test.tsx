import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("operator incident helpers group duplicate attention by run task and cause", async () => {
  const { buildOperatorIncidents } = await import("../../web/lib/operator/incidents.ts");
  const overview = {
    runs: [
      { runId: "run-1", status: "scheduling", title: "Fix empty input", updatedAt: "2026-06-30T12:00:00.000Z" },
    ],
    attentionItems: [
      {
        id: "a",
        severity: "blocked",
        title: "stale_callback runtime exception",
        reason: "stale_callback",
        runId: "run-1",
        taskId: "task.implement",
        updatedAt: "2026-06-30T12:01:00.000Z",
        commands: [{ id: "task.retry", label: "Retry Task", enabled: true, requiresConfirmation: true }],
        detail: { evidenceRefs: ["history:1"] },
      },
      {
        id: "b",
        severity: "blocked",
        title: "stale_callback runtime exception",
        reason: "stale_callback",
        runId: "run-1",
        taskId: "task.implement",
        updatedAt: "2026-06-30T12:02:00.000Z",
        commands: [{ id: "task.retry", label: "Retry Task", enabled: true, requiresConfirmation: true }],
        detail: { evidenceRefs: ["history:2"] },
      },
    ],
    commandResults: [],
    runtimeHealth: { activeRunCount: 1, attentionCount: 2, blockedCount: 2 },
    defaultSelection: { runId: "run-1", taskId: "task.implement", attentionItemId: "a" },
  };

  const incidents = buildOperatorIncidents(overview);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].runId, "run-1");
  assert.equal(incidents[0].taskId, "task.implement");
  assert.equal(incidents[0].severity, "blocked");
  assert.equal(incidents[0].status, "needs_action");
  assert.match(incidents[0].cause, /stale_callback/);
  assert.match(incidents[0].nextAction, /Retry Task/);
  assert.deepEqual(incidents[0].sourceAttentionIds, ["a", "b"]);
});

test("operator priority lanes separate needs action from running", async () => {
  const { buildOperatorIncidents, buildOperatorPriorityLanes } = await import("../../web/lib/operator/incidents.ts");
  const overview = {
    runs: [
      { runId: "run-1", status: "scheduling", title: "Blocked run", updatedAt: "2026-06-30T12:00:00.000Z" },
      { runId: "run-2", status: "running", title: "Healthy run", updatedAt: "2026-06-30T12:00:00.000Z" },
    ],
    attentionItems: [
      { id: "a", severity: "blocked", title: "Blocked", reason: "stale_callback", runId: "run-1", taskId: "task.implement" },
    ],
    commandResults: [],
    runtimeHealth: { activeRunCount: 2, attentionCount: 1, blockedCount: 1 },
    defaultSelection: null,
  };

  const incidents = buildOperatorIncidents(overview);
  const lanes = buildOperatorPriorityLanes(overview.runs, incidents);
  assert.equal(lanes.needsAction.length, 1);
  assert.equal(lanes.running.length, 1);
  assert.equal(lanes.running[0].runId, "run-2");
});

test("Operator sidebar uses grouped incident attention queue", () => {
  const sidebar = source("web/components/operator/OperatorSidebar.tsx");
  const queue = source("web/components/operator/OperatorAttentionQueue.tsx");
  assert.match(sidebar, /OperatorAttentionQueue/);
  assert.match(queue, /sourceAttentionIds/);
  assert.match(queue, /nextAction/);
  assert.match(queue, /aria-pressed/);
});

test("Operator workspace leads with health strip priority lanes and incident summary", () => {
  const workspace = source("web/components/operator/OperatorWorkspace.tsx");
  assert.match(workspace, /OperatorHealthStrip/);
  assert.match(workspace, /OperatorIncidentPanel/);
  assert.match(workspace, /priorityLanes/);
  assert.match(source("web/components/operator/OperatorHealthStrip.tsx"), /blocked incidents/);
  assert.match(source("web/components/operator/OperatorIncidentPanel.tsx"), /Recommended next action/);
});

test("operator actions require reason and show consequence preview", () => {
  const panel = source("web/components/operator/OperatorActionsPanel.tsx");
  assert.match(panel, /Consequence/);
  assert.match(panel, /operator-action-reason/);
  assert.match(panel, /reason\.trim\(\)/);
  assert.match(panel, /Command result/);
});

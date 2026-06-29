import test from "node:test";
import assert from "node:assert/strict";
import { layoutWorkflowDag } from "../../web/lib/workflow/dag-layout";
import type { WorkflowDag } from "../../web/lib/workflow/types";

function node(id: string, level: number) {
  return {
    id,
    label: id,
    role: "maker",
    agentRef: "agent.software-maker",
    profileRef: "software-maker-pi",
    profileResourcePath: "software/agents/software-maker/profile.json",
    provider: "pi",
    model: "pi-agent-default",
    level,
    state: "ready" as const,
  };
}

test("layoutWorkflowDag groups same-level nodes into a parallel column", () => {
  const dag: WorkflowDag = {
    id: "dag-1",
    templateId: "template.software-feature",
    templateTitle: "Software Feature Workflow",
    prompt: "Build API-aligned workflow UI",
    expandedByDefault: true,
    readiness: "ready",
    createdAt: "2026-06-27T00:00:00.000Z",
    nodes: [node("plan", 0), node("implement-a", 1), node("implement-b", 1), node("verify", 2)],
    edges: [
      { from: "plan", to: "implement-a" },
      { from: "plan", to: "implement-b" },
      { from: "implement-a", to: "verify" },
      { from: "implement-b", to: "verify" },
    ],
  };

  const layout = layoutWorkflowDag(dag);
  assert.equal(layout.columns.length, 3);
  assert.deepEqual(layout.columns[1]?.nodes.map((item) => item.node.id), ["implement-a", "implement-b"]);
  assert.equal(layout.arrows.length, 4);
});

test("layoutWorkflowDag builds cubic svg paths for arrows", () => {
  const dag: WorkflowDag = {
    id: "dag-2",
    templateId: "template.software-feature",
    templateTitle: "Software Feature Workflow",
    prompt: "Build API-aligned workflow UI",
    expandedByDefault: true,
    readiness: "ready",
    createdAt: "2026-06-27T00:00:00.000Z",
    nodes: [node("plan", 0), node("verify", 1)],
    edges: [{ from: "plan", to: "verify" }],
  };

  const layout = layoutWorkflowDag(dag);
  assert.equal(layout.arrows.length, 1);
  assert.match(layout.arrows[0]!.path, /^M \d+ \d+ C \d+ \d+, \d+ \d+, \d+ \d+$/);
});

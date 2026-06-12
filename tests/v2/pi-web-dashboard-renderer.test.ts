import test from "node:test";
import assert from "node:assert/strict";
import { renderPiWebOperationsDashboardHtml } from "../../src/v2/pi-web/operations-dashboard-renderer.ts";

test("renders pi-web operations dashboard first screen without iframe", () => {
  const html = renderPiWebOperationsDashboardHtml({
    surface: "pi-web.operations-dashboard.v1",
    selectedRunId: "run-1",
    selectedTaskId: "task-implement",
    panels: [
      { id: "planner-chat", title: "Planner Chat" },
      { id: "workflow-canvas", title: "Workflow Canvas" },
      { id: "runtime-monitor", title: "Runtime Monitor" },
      { id: "task-detail", title: "Task Detail" },
      { id: "agent-definitions", title: "Agent Definitions" },
      { id: "sessions-memory", title: "Sessions/Memory" },
      { id: "vault-mcp", title: "Vault/MCP" },
      { id: "executor-ops", title: "Executor Ops" },
    ],
    plannerChat: { drafts: [{ id: "draft-1", status: "validated", title: "Plan", workflowId: "wf-1", goalPrompt: "calc sum" }] },
    workflowCanvas: { runId: "run-1", status: "running", nodes: [{ id: "task-implement", label: "Implement", status: "running", dependsOn: [] }] },
    runtimeMonitor: { runId: "run-1", status: "running", latestProgress: "running tests", executorJobIds: ["job-1"], runningTaskIds: ["task-implement"] },
    taskDetail: { id: "task-implement", taskKey: "task-implement", status: "running", metrics: { aggregate: { tokens: 10 } } },
    agentDefinitions: { harnesses: [{ id: "pi", kind: "pi-agent", image: "southstar/pi-agent:local", capabilities: ["planning"] }], taskAgents: [] },
    sessionsMemory: { runId: "run-1", sessions: [], memoryItems: [{ id: "mem-1", title: "Minimal changes", payload: { preference: "minimal changes" } }] },
    vaultMcp: { runId: "run-1", vaultLeases: [], mcpGrants: [] },
    executorOps: { runId: "run-1", bindings: [{ id: "executor-1", status: "submitted", torkJobId: "job-1" }] },
  });

  for (const title of ["Planner Chat", "Workflow Canvas", "Runtime Monitor", "Task Detail", "Agent Definitions", "Sessions/Memory", "Vault/MCP", "Executor Ops"]) {
    assert.match(html, new RegExp(title.replace("/", "\\/")));
  }
  assert.match(html, /task-implement/);
  assert.match(html, /job-1/);
  assert.doesNotMatch(html, /<iframe/i);
});

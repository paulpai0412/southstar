import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSouthstarMcpToolRegistry } from "../../src/v2/mcp/tool-registry.ts";

const root = join(import.meta.dirname, "../..");

test("createSouthstarMcpToolRegistry exposes workflow and system tools", () => {
  const registry = createSouthstarMcpToolRegistry({ client: fakeClient() });
  assert.deepEqual(registry.listTools().map((tool) => tool.name), [
    "southstar.system.status",
    "southstar.workflow.search_templates",
    "southstar.workflow.get_template",
    "southstar.workflow.instantiate_template",
    "southstar.workflow.get_draft",
    "southstar.workflow.run_draft",
    "southstar.workflow.inspect_run",
    "southstar.workflow.get_artifact",
  ]);
});

test("MCP registry tools unwrap runtime client envelopes", async () => {
  const calls: Array<{ method: string; body?: unknown }> = [];
  const registry = createSouthstarMcpToolRegistry({ client: fakeClient(calls) });

  const search = await registry.callTool("southstar.workflow.search_templates", {
    prompt: "software workflow",
    domain: "software",
    limit: 2,
  });
  assert.deepEqual(search.structuredContent, { templates: [{ templateRef: "template.software" }] });

  await registry.callTool("southstar.workflow.get_template", { templateRef: "template.software" });
  await registry.callTool("southstar.workflow.instantiate_template", {
    templateRef: "template.software",
    goalPrompt: "build vocabulary app",
    constraints: { mode: "strict" },
  });
  await registry.callTool("southstar.workflow.get_draft", { draftId: "draft-a" });
  await registry.callTool("southstar.workflow.run_draft", { draftId: "draft-a" });
  await registry.callTool("southstar.workflow.inspect_run", { runId: "run-a", taskId: "task-a" });
  await registry.callTool("southstar.workflow.get_artifact", { artifactRef: "artifact-a" });
  await registry.callTool("southstar.system.status", {});

  assert.deepEqual(calls, [
    { method: "searchWorkflowTemplates", body: { prompt: "software workflow", domain: "software", limit: 2 } },
    { method: "getWorkflowTemplate", body: "template.software" },
    { method: "instantiateWorkflowTemplate", body: { templateRef: "template.software", goalPrompt: "build vocabulary app", constraints: { mode: "strict" } } },
    { method: "getPlannerDraftOrchestration", body: "draft-a" },
    { method: "createRunFromPlannerDraft", body: "draft-a" },
    { method: "getTask", body: { runId: "run-a", taskId: "task-a" } },
    { method: "getArtifact", body: { artifactRef: "artifact-a" } },
    { method: "getRuntimeHealth" },
  ]);
});

test("package exposes southstar-mcp bin entry", () => {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> };
  assert.equal(packageJson.bin?.["southstar-mcp"], "src/v2/mcp/server.ts");
});

function fakeClient(calls: Array<{ method: string; body?: unknown }> = []) {
  return {
    getRuntimeHealth: async () => {
      calls.push({ method: "getRuntimeHealth" });
      return envelope("runtime-health", { ok: true });
    },
    searchWorkflowTemplates: async (body: unknown) => {
      calls.push({ method: "searchWorkflowTemplates", body });
      return envelope("workflow-template-search", { templates: [{ templateRef: "template.software" }] });
    },
    getWorkflowTemplate: async (body: unknown) => {
      calls.push({ method: "getWorkflowTemplate", body });
      return envelope("workflow-template-detail", { templateRef: body });
    },
    instantiateWorkflowTemplate: async (body: unknown) => {
      calls.push({ method: "instantiateWorkflowTemplate", body });
      return envelope("workflow-template-instantiate", { draftId: "draft-a" });
    },
    getPlannerDraftOrchestration: async (body: unknown) => {
      calls.push({ method: "getPlannerDraftOrchestration", body });
      return envelope("planner-draft-orchestration", { draftId: body });
    },
    createRunFromPlannerDraft: async (body: unknown) => {
      calls.push({ method: "createRunFromPlannerDraft", body });
      return envelope("planner-draft-run", { runId: "run-a" });
    },
    getRun: async (body: unknown) => {
      calls.push({ method: "getRun", body });
      return envelope("run", { runId: body });
    },
    getTask: async (body: unknown) => {
      calls.push({ method: "getTask", body });
      return envelope("task", body);
    },
    getArtifact: async (body: unknown) => {
      calls.push({ method: "getArtifact", body });
      return envelope("artifact", { artifactRef: body });
    },
  };
}

function envelope(kind: string, result: unknown) {
  return { ok: true as const, kind, result };
}

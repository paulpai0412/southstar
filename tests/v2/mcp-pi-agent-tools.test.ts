import test from "node:test";
import assert from "node:assert/strict";
import {
  createSouthstarPiAgentTools,
  southstarMcpToolNameToPiToolName,
} from "../../src/v2/mcp/pi-agent-tools.ts";
import type { SouthstarMcpToolCallContext, SouthstarMcpToolRegistry } from "../../src/v2/mcp/tool-registry.ts";

test("Southstar MCP tool names are mapped to Pi-safe custom tool names", () => {
  assert.equal(
    southstarMcpToolNameToPiToolName("southstar.workflow.create_draft_stream"),
    "southstar_workflow_create_draft_stream",
  );
});

test("createSouthstarPiAgentTools adapts registry tools into Pi custom tools", async () => {
  const controller = new AbortController();
  const calls: Array<{ name: string; input: unknown; context?: SouthstarMcpToolCallContext }> = [];
  const registry: SouthstarMcpToolRegistry = {
    listTools() {
      return [
        {
          name: "southstar.workflow.create_draft_stream",
          description: "Create a planner draft and stream progress.",
          inputSchema: {
            type: "object",
            properties: {
              goalPrompt: { type: "string" },
            },
            required: ["goalPrompt"],
            additionalProperties: false,
          },
        },
      ];
    },
    async callTool(name, input, context) {
      calls.push({ name, input, context });
      context?.onEvent?.({
        event: "planner.stage",
        data: { stage: "requirement.analyzed", message: "Requirement analysis completed." },
      });
      return {
        content: [{ type: "text", text: "{\"draft\":{\"draftId\":\"draft-stream\"}}" }],
        structuredContent: { draft: { draftId: "draft-stream" } },
      };
    },
  };

  const tools = createSouthstarPiAgentTools({ registry });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "southstar_workflow_create_draft_stream");
  assert.equal(tools[0]?.label, "Southstar: workflow.create_draft_stream");
  assert.equal(tools[0]?.description.includes("MCP tool: southstar.workflow.create_draft_stream"), true);

  const updates: unknown[] = [];
  const result = await tools[0]!.execute(
    "tool-call-1",
    { goalPrompt: "build a todo app" },
    controller.signal,
    (update) => updates.push(update),
    {} as never,
  );

  assert.deepEqual(calls, [
    {
      name: "southstar.workflow.create_draft_stream",
      input: { goalPrompt: "build a todo app" },
      context: calls[0]!.context,
    },
  ]);
  assert.equal(calls[0]!.context?.signal, controller.signal);
  assert.deepEqual(result.content, [{ type: "text", text: "{\"draft\":{\"draftId\":\"draft-stream\"}}" }]);
  assert.deepEqual(result.details, {
    mcpToolName: "southstar.workflow.create_draft_stream",
    piToolName: "southstar_workflow_create_draft_stream",
    structuredContent: { draft: { draftId: "draft-stream" } },
    eventCount: 1,
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    content: [{ type: "text", text: "planner.stage: Requirement analysis completed." }],
    details: {
      mcpToolName: "southstar.workflow.create_draft_stream",
      piToolName: "southstar_workflow_create_draft_stream",
      eventCount: 1,
      latestEvent: {
        event: "planner.stage",
        data: { stage: "requirement.analyzed", message: "Requirement analysis completed." },
      },
    },
  });
});

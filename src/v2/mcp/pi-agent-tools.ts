import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createRuntimeServerClient } from "../server/client.ts";
import {
  createSouthstarMcpToolRegistry,
  type SouthstarMcpStreamEvent,
  type SouthstarMcpTool,
  type SouthstarMcpToolRegistry,
} from "./tool-registry.ts";

export type SouthstarPiAgentToolDetails = {
  mcpToolName: string;
  piToolName: string;
  structuredContent?: unknown;
  eventCount: number;
  latestEvent?: SouthstarMcpStreamEvent;
};

export function createSouthstarPiAgentTools(input: { registry: SouthstarMcpToolRegistry }): ToolDefinition[] {
  const usedNames = new Map<string, string>();
  return input.registry.listTools().map((tool) => toPiTool(input.registry, tool, usedNames));
}

export function createSouthstarPiAgentToolsFromEnv(): ToolDefinition[] {
  const baseUrl = process.env.SOUTHSTAR_MCP_RUNTIME_URL
    ?? process.env.SOUTHSTAR_RUNTIME_URL
    ?? process.env.SOUTHSTAR_SERVER_URL
    ?? "http://127.0.0.1:3100";
  const registry = createSouthstarMcpToolRegistry({ client: createRuntimeServerClient({ baseUrl }) });
  return createSouthstarPiAgentTools({ registry });
}

export function southstarMcpToolNameToPiToolName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  const withValidStart = /^[A-Za-z_]/.test(safe) ? safe : `southstar_${safe}`;
  return withValidStart.slice(0, 64) || "southstar_tool";
}

function toPiTool(
  registry: SouthstarMcpToolRegistry,
  tool: SouthstarMcpTool,
  usedNames: Map<string, string>,
): ToolDefinition {
  const piToolName = uniquePiToolName(tool.name, usedNames);
  return {
    name: piToolName,
    label: `Southstar: ${tool.name.replace(/^southstar\./, "")}`,
    description: `${tool.description}\n\nMCP tool: ${tool.name}`,
    promptSnippet: `${piToolName}: ${tool.description} (backs Southstar MCP tool ${tool.name}).`,
    promptGuidelines: [
      "Use Southstar tools for Southstar workflow, library, runtime, operator, memory, and template actions.",
      "For workflow draft creation, prefer the non-streaming create_draft tool unless the user explicitly asks for backend progress streaming.",
    ],
    parameters: tool.inputSchema as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      if (signal?.aborted) throw new Error(`Southstar MCP tool aborted before start: ${tool.name}`);
      let eventCount = 0;
      let latestEvent: SouthstarMcpStreamEvent | undefined;
      const result = await registry.callTool(tool.name, params, {
        signal,
        onEvent(event) {
          eventCount += 1;
          latestEvent = event;
          onUpdate?.({
            content: [{ type: "text", text: formatStreamEvent(event) }],
            details: { mcpToolName: tool.name, piToolName, eventCount, latestEvent },
          });
        },
      });
      if (signal?.aborted) throw new Error(`Southstar MCP tool aborted: ${tool.name}`);
      return {
        content: result.content,
        details: {
          mcpToolName: tool.name,
          piToolName,
          structuredContent: result.structuredContent,
          eventCount,
        },
      };
    },
  } as ToolDefinition;
}

function uniquePiToolName(mcpToolName: string, usedNames: Map<string, string>): string {
  const base = southstarMcpToolNameToPiToolName(mcpToolName);
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate) && usedNames.get(candidate) !== mcpToolName) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  usedNames.set(candidate, mcpToolName);
  return candidate;
}

function formatStreamEvent(event: SouthstarMcpStreamEvent): string {
  const data = asRecord(event.data);
  const message = typeof data.message === "string"
    ? data.message
    : typeof data.text === "string"
      ? data.text
      : typeof data.error === "string"
        ? data.error
        : "";
  return message ? `${event.event}: ${message}` : event.event;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

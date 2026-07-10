import type { SouthstarDb } from "../../db/postgres.ts";
import { listLibraryObjects } from "../library-graph-store.ts";
import type { LibraryObjectSummary } from "../types.ts";

export type GraphProfileCandidates = {
  agents: string[];
  skills: string[];
  tools: string[];
  mcpGrants: string[];
};

export async function resolveGraphProfileCandidates(
  db: SouthstarDb,
  input: { scope: string },
): Promise<GraphProfileCandidates> {
  const objects = await listLibraryObjects(db, { scope: input.scope, status: "approved" });
  return {
    agents: objects.filter((object) => object.objectKind === "agent_definition").map((object) => object.objectKey),
    skills: objects.filter((object) => object.objectKind === "skill_spec" && isRuntimeProfilePrimitiveCandidate(object)).map((object) => object.objectKey),
    tools: objects.filter((object) => object.objectKind === "tool_definition" && isRuntimeProfilePrimitiveCandidate(object)).map((object) => object.objectKey),
    mcpGrants: objects.filter((object) => object.objectKind === "mcp_tool_grant" && isRuntimeProfilePrimitiveCandidate(object)).map((object) => object.objectKey),
  };
}

export function isRuntimeProfilePrimitiveCandidate(object: LibraryObjectSummary): boolean {
  const state = object.state;
  switch (object.objectKind) {
    case "skill_spec":
    case "skill_definition":
      return stringValue(state.body) !== undefined || stringValue(state.instructions) !== undefined;
    case "tool_definition":
      return stringValue(state.toolName) !== undefined && stringValue(state.proxyToolName) !== undefined;
    case "mcp_tool_grant":
      return stringValue(state.serverId) !== undefined && stringArray(state.allowedTools).length > 0;
    case "instruction_template":
      return stringValue(state.content) !== undefined && Array.isArray(state.variables);
    default:
      return true;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

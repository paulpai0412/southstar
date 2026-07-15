import type { SouthstarDb } from "../../db/postgres.ts";
import { unsupportedPiRuntimeToolNames } from "../../harness/pi-runtime-tools.ts";
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
  void input;
  const objects = await listLibraryObjects(db, { status: "approved" });
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
      if (stringValue(state.purpose) === "goal_design") return false;
      if (stringValue(state.purpose) === "composer_guidance") return false;
      return stringValue(state.body) !== undefined || stringValue(state.instructions) !== undefined;
    case "tool_definition":
      return stringArray(state.runtimeToolNames).length > 0
        && unsupportedPiRuntimeToolNames(stringArray(state.runtimeToolNames)).length === 0;
    case "mcp_tool_grant":
      // The task runner does not currently load MCP runtime configs. Do not
      // advertise grants to the composer until an executable adapter exists.
      return false;
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

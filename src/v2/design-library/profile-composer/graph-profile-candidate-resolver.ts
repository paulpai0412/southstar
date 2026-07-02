import type { SouthstarDb } from "../../db/postgres.ts";
import { listLibraryObjects } from "../library-graph-store.ts";

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
    skills: objects.filter((object) => object.objectKind === "skill_spec").map((object) => object.objectKey),
    tools: objects.filter((object) => object.objectKind === "tool_definition").map((object) => object.objectKey),
    mcpGrants: objects.filter((object) => object.objectKind === "mcp_tool_grant").map((object) => object.objectKey),
  };
}

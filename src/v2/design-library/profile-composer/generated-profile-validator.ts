import type { SouthstarDb } from "../../db/postgres.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryEdgeType, LibraryObjectSummary } from "../types.ts";

export type GeneratedNodeProfileInput = {
  scope: string;
  nodeId: string;
  agentRef: string;
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  instructionRefs: string[];
};

export type GeneratedProfileValidationResult = {
  ok: boolean;
  issues: Array<{ code: string; path: string; message: string }>;
};

export async function validateGeneratedNodeProfile(
  db: SouthstarDb,
  input: GeneratedNodeProfileInput,
): Promise<GeneratedProfileValidationResult> {
  const issues: GeneratedProfileValidationResult["issues"] = [];
  await requireObject(db, input.agentRef, "agentRef", "agent_definition", input.scope, issues);
  const agentSkillRefs = new Set(await approvedLinkedRefsByEdgeTypes(
    db,
    input.agentRef,
    ["uses"],
    "skill_spec",
    input.scope,
  ));

  for (const [index, skillRef] of input.skillRefs.entries()) {
    await requireObject(db, skillRef, `skillRefs.${index}`, "skill_spec", input.scope, issues);
    if (!agentSkillRefs.has(skillRef)) {
      issues.push({
        code: "agent_does_not_use_skill",
        path: `skillRefs.${index}`,
        message: `${input.agentRef} does not use ${skillRef}`,
      });
    }
    const requiredTools = await approvedLinkedRefsByEdgeTypes(
      db,
      skillRef,
      ["requires_tool", "allows_tool", "uses"],
      "tool_definition",
      input.scope,
    );
    for (const toolRef of requiredTools) {
      if (!input.toolGrantRefs.includes(toolRef)) {
        issues.push({
          code: "missing_required_tool",
          path: `skillRefs.${index}`,
          message: `${skillRef} requires ${toolRef}`,
        });
      }
    }
    const requiredMcp = await approvedLinkedRefsByEdgeTypes(
      db,
      skillRef,
      ["allows_mcp_grant", "uses"],
      "mcp_tool_grant",
      input.scope,
    );
    for (const mcpRef of requiredMcp) {
      if (!input.mcpGrantRefs.includes(mcpRef)) {
        issues.push({
          code: "missing_required_mcp",
          path: `skillRefs.${index}`,
          message: `${skillRef} requires ${mcpRef}`,
        });
      }
    }
    const requiredInstructions = await approvedLinkedRefsByEdgeTypes(
      db,
      skillRef,
      ["uses_instruction", "uses"],
      "instruction_template",
      input.scope,
    );
    for (const instructionRef of requiredInstructions) {
      if (!input.instructionRefs.includes(instructionRef)) {
        issues.push({
          code: "missing_required_instruction",
          path: `skillRefs.${index}`,
          message: `${skillRef} requires ${instructionRef}`,
        });
      }
    }
  }

  for (const [index, toolRef] of input.toolGrantRefs.entries()) {
    await requireObject(db, toolRef, `toolGrantRefs.${index}`, "tool_definition", input.scope, issues);
  }
  for (const [index, mcpRef] of input.mcpGrantRefs.entries()) {
    await requireObject(db, mcpRef, `mcpGrantRefs.${index}`, "mcp_tool_grant", input.scope, issues);
  }
  for (const [index, instructionRef] of input.instructionRefs.entries()) {
    await requireObject(db, instructionRef, `instructionRefs.${index}`, "instruction_template", input.scope, issues);
  }

  return { ok: issues.length === 0, issues };
}

async function approvedLinkedRefsByEdgeTypes(
  db: SouthstarDb,
  fromObjectKey: string,
  edgeTypes: readonly LibraryEdgeType[],
  expectedKind: LibraryDefinitionKind,
  scope: string,
): Promise<string[]> {
  const refs = new Set<string>();
  for (const edgeType of edgeTypes) {
    const edges = await findLibraryEdgesFrom(db, fromObjectKey, edgeType, { scope });
    for (const edge of edges) {
      const object = await findLibraryObjectByKey(db, edge.toObjectKey);
      if (!object || object.status !== "approved" || object.objectKind !== expectedKind) continue;
      if (!objectVisibleInScope(object, scope)) continue;
      refs.add(edge.toObjectKey);
    }
  }
  return [...refs].sort();
}

async function requireObject(
  db: SouthstarDb,
  objectKey: string,
  path: string,
  expectedKind: LibraryDefinitionKind,
  scope: string,
  issues: GeneratedProfileValidationResult["issues"],
): Promise<void> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object || object.status !== "approved") {
    issues.push({ code: "unknown_or_unapproved_ref", path, message: `${objectKey} is not approved` });
    return;
  }
  if (object.objectKind !== expectedKind) {
    issues.push({ code: "wrong_kind_ref", path, message: `${objectKey} must be ${expectedKind}` });
  }
  if (!objectVisibleInScope(object, scope)) {
    issues.push({ code: "out_of_scope_ref", path, message: `${objectKey} is not visible in ${scope}` });
  }
}

function objectVisibleInScope(object: LibraryObjectSummary, scope: string): boolean {
  if (scope === "all") return true;
  const objectScope = typeof object.state.scope === "string" && object.state.scope.length > 0
    ? object.state.scope
    : "global";
  if (objectScope === "global" || objectScope === scope) return true;
  const domainRefs = object.state.domainRefs;
  return Array.isArray(domainRefs) && domainRefs.includes(scope);
}

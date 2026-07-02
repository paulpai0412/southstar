import type { SouthstarDb } from "../../db/postgres.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryObjectSummary } from "../types.ts";

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
  const agentSupportedSkillRefs = new Set(
    (await findLibraryEdgesFrom(db, input.agentRef, "supports_skill", { scope: input.scope }))
      .map((edge) => edge.toObjectKey),
  );

  for (const [index, skillRef] of input.skillRefs.entries()) {
    await requireObject(db, skillRef, `skillRefs.${index}`, "skill_spec", input.scope, issues);
    if (!agentSupportedSkillRefs.has(skillRef)) {
      issues.push({
        code: "agent_does_not_support_skill",
        path: `skillRefs.${index}`,
        message: `${input.agentRef} does not support ${skillRef}`,
      });
    }
    const requiredTools = await findLibraryEdgesFrom(db, skillRef, "requires_tool", { scope: input.scope });
    for (const edge of requiredTools) {
      if (!input.toolGrantRefs.includes(edge.toObjectKey)) {
        issues.push({
          code: "missing_required_tool",
          path: `skillRefs.${index}`,
          message: `${skillRef} requires ${edge.toObjectKey}`,
        });
      }
    }
    const requiredMcp = await findLibraryEdgesFrom(db, skillRef, "allows_mcp_grant", { scope: input.scope });
    for (const edge of requiredMcp) {
      if (!input.mcpGrantRefs.includes(edge.toObjectKey)) {
        issues.push({
          code: "missing_required_mcp",
          path: `skillRefs.${index}`,
          message: `${skillRef} requires ${edge.toObjectKey}`,
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
  const objectScope = typeof object.state.scope === "string" && object.state.scope.length > 0
    ? object.state.scope
    : "global";
  if (objectScope === "global" || objectScope === scope) return true;
  const domainRefs = object.state.domainRefs;
  return Array.isArray(domainRefs) && domainRefs.includes(scope);
}

import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryObjectSummary } from "../design-library/types.ts";
import type { McpGrantInput, VaultLeaseInput } from "../agent-runner/task-envelope.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
import type { ToolProxyPolicyPayload } from "../tool-proxy/types.ts";

export type MaterializeTaskLibraryRefsInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  instructionRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
};

export type ResolvedInstructionSnapshot = {
  instructionRef: string;
  content: string;
  variables: string[];
  contentHash: string;
};

export type MaterializeTaskLibraryRefsResult = {
  instructions: ResolvedInstructionSnapshot[];
  skills: ResolvedSkillSnapshot[];
  toolProxyPolicy: ToolProxyPolicyPayload;
  mcpGrants: McpGrantInput[];
  vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">>;
};

const DEFAULT_MAX_VAULT_TTL_SECONDS = 900;
const FORBIDDEN_DIRECT_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "PI_API_KEY",
  "GITHUB_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
];

export async function materializeTaskLibraryRefs(
  db: SouthstarDb,
  input: MaterializeTaskLibraryRefsInput,
): Promise<MaterializeTaskLibraryRefsResult> {
  const instructions: ResolvedInstructionSnapshot[] = [];
  for (const instructionRef of unique(input.instructionRefs)) {
    const object = await approvedObject(db, instructionRef, "instruction_template");
    instructions.push({
      instructionRef,
      content: stringField(object.state, "content"),
      variables: stringArray(object.state, "variables"),
      contentHash: sha256(JSON.stringify({ instructionRef, content: stringField(object.state, "content") })),
    });
  }

  const skills: ResolvedSkillSnapshot[] = [];
  for (const skillRef of unique(input.skillRefs)) {
    const object = await approvedObject(db, skillRef, "skill_definition");
    const instructionsText = stringField(object.state, "instructions");
    skills.push({
      skillId: object.objectKey,
      version: object.headVersionId ?? "runtime",
      instructions: instructionsText,
      allowedTools: stringArray(object.state, "allowedTools"),
      requiredMounts: stringArray(object.state, "requiredMounts"),
      mcpRequirements: stringArray(object.state, "mcpRequirements"),
      artifactContracts: stringArray(object.state, "artifactContracts"),
      contentHash: sha256(JSON.stringify({ skillRef: object.objectKey, instructions: instructionsText })),
      mountPath: `/skills/${object.objectKey}`,
    });
  }

  const toolPolicyArtifacts = [];
  for (const toolRef of unique(input.toolGrantRefs)) {
    const object = await approvedObject(db, toolRef, "tool_definition");
    toolPolicyArtifacts.push({
      toolName: stringField(object.state, "toolName"),
      proxyToolName: stringField(object.state, "proxyToolName"),
    });
  }
  const toolProxyPolicy: ToolProxyPolicyPayload = {
    schemaVersion: "southstar.tool_proxy_policy.v1",
    runId: input.runId,
    sessionId: input.sessionId,
    allowedTools: unique(toolPolicyArtifacts.map((item) => item.toolName)),
    requiredProxyTools: unique(toolPolicyArtifacts.map((item) => item.proxyToolName)),
    forbiddenDirectEnvKeys: [...FORBIDDEN_DIRECT_ENV_KEYS],
    vaultLeaseRefs: unique(input.vaultLeasePolicyRefs),
    maxLeaseTtlSeconds: DEFAULT_MAX_VAULT_TTL_SECONDS,
    redactResultPayloads: true,
    failClosed: true,
  };

  const mcpGrants: McpGrantInput[] = [];
  for (const mcpGrantRef of unique(input.mcpGrantRefs)) {
    const object = await approvedObject(db, mcpGrantRef, "mcp_tool_grant");
    mcpGrants.push({
      serverId: stringField(object.state, "serverId"),
      allowedTools: stringArray(object.state, "allowedTools"),
    });
  }

  const vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">> = [];
  let maxLeaseTtlSeconds = 0;
  for (const vaultRef of unique(input.vaultLeasePolicyRefs)) {
    const object = await approvedObject(db, vaultRef, "vault_lease_policy");
    vaultLeases.push({
      leaseRef: vaultRef,
      mountAs: resolveVaultMountAs(stringField(object.state, "mountMode")),
    });
    maxLeaseTtlSeconds = Math.max(maxLeaseTtlSeconds, numberField(object.state, "leaseTtlSeconds"));
  }
  toolProxyPolicy.maxLeaseTtlSeconds = maxLeaseTtlSeconds || DEFAULT_MAX_VAULT_TTL_SECONDS;

  return {
    instructions,
    skills,
    toolProxyPolicy,
    mcpGrants,
    vaultLeases,
  };
}

async function approvedObject(
  db: SouthstarDb,
  objectKey: string,
  objectKind: LibraryDefinitionKind,
): Promise<LibraryObjectSummary> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object || object.status !== "approved") {
    throw new Error(`missing approved library object: ${objectKey}`);
  }
  if (object.objectKind !== objectKind) {
    throw new Error(`library object kind mismatch for ${objectKey}: expected ${objectKind}, got ${object.objectKind}`);
  }
  return object;
}

function stringField(state: Record<string, unknown>, field: string): string {
  const value = state[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function stringArray(state: Record<string, unknown>, field: string): string[] {
  const value = state[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid ${field}`);
  }
  return [...value];
}

function numberField(state: Record<string, unknown>, field: string): number {
  const value = state[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function resolveVaultMountAs(value: string): VaultLeaseInput["mountAs"] {
  if (value === "env") return "env";
  return "file";
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

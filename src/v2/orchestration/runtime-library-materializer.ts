import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { unsupportedPiRuntimeToolNames } from "../harness/pi-runtime-tools.ts";
import type { McpGrantInput, McpRuntimeConfig, McpRuntimeServerConfig, VaultLeaseInput } from "../agent-runner/task-envelope.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
import type { ToolProxyPolicyPayload } from "../tool-proxy/types.ts";
import {
  loadRunLibrarySnapshotPg,
  requireSnapshotObject,
  type RunLibrarySnapshotObjectV1,
} from "./run-library-snapshot.ts";

export type MaterializeTaskLibraryRefsInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  instructionRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  libraryRoot?: string;
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
  mcpRuntimeConfig: McpRuntimeConfig;
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
  const snapshot = await loadRunLibrarySnapshotPg(db, input.runId);
  const instructions: ResolvedInstructionSnapshot[] = [];
  for (const instructionRef of unique(input.instructionRefs)) {
    const object = requireSnapshotObject(snapshot, instructionRef, "instruction_template");
    instructions.push({
      instructionRef,
      content: stringField(object.state, "content"),
      variables: stringArray(object.state, "variables"),
      contentHash: sha256(JSON.stringify({ instructionRef, content: stringField(object.state, "content") })),
    });
  }

  const skills: ResolvedSkillSnapshot[] = [];
  for (const skillRef of unique(input.skillRefs)) {
    const object = requireSnapshotObject(snapshot, skillRef, ["skill_spec", "skill_definition"]);
    const instructionsText = skillInstructions(object.state);
    const sourcePath = optionalStringField(object.state, "sourcePath");
    const assetBundlePath = optionalStringField(object.state, "assetBundlePath") ?? defaultSkillAssetBundlePath(object.objectKey);
    const bundleFiles = object.bundleFiles ?? [];
    skills.push({
      skillId: object.objectKey,
      version: object.versionRef,
      instructions: instructionsText,
      allowedTools: optionalStringArray(object.state, "allowedTools"),
      requiredMounts: optionalStringArray(object.state, "requiredMounts"),
      mcpRequirements: optionalStringArray(object.state, "mcpRequirements"),
      artifactContracts: optionalStringArray(object.state, "artifactContracts"),
      contentHash: sha256(JSON.stringify({ skillRef: object.objectKey, instructions: instructionsText, bundleFiles })),
      mountPath: `/skills/${object.objectKey}`,
      ...(sourcePath ? { sourcePath } : {}),
      ...(assetBundlePath ? { assetBundlePath } : {}),
      ...(bundleFiles.length > 0 ? { bundleFiles } : {}),
    });
  }

  const toolPolicyArtifacts = [];
  for (const toolRef of unique(input.toolGrantRefs)) {
    const object = requireSnapshotObject(snapshot, toolRef, "tool_definition");
    const runtimeToolNames = optionalStringArray(object.state, "runtimeToolNames");
    if (runtimeToolNames.length === 0) {
      throw new Error(`tool definition ${toolRef} has no runtimeToolNames binding`);
    }
    const unsupportedRuntimeToolNames = unsupportedPiRuntimeToolNames(runtimeToolNames);
    if (unsupportedRuntimeToolNames.length > 0) {
      throw new Error(`tool definition ${toolRef} has unsupported Pi runtimeToolNames: ${unsupportedRuntimeToolNames.join(", ")}`);
    }
    toolPolicyArtifacts.push({
      runtimeToolNames,
      proxyToolNames: optionalStringArray(object.state, "proxyToolNames"),
    });
  }
  const toolProxyPolicy: ToolProxyPolicyPayload = {
    schemaVersion: "southstar.tool_proxy_policy.v1",
    runId: input.runId,
    sessionId: input.sessionId,
    allowedTools: unique(toolPolicyArtifacts.flatMap((item) => item.runtimeToolNames)).sort(),
    requiredProxyTools: unique(toolPolicyArtifacts.flatMap((item) => item.proxyToolNames)).sort(),
    forbiddenDirectEnvKeys: [...FORBIDDEN_DIRECT_ENV_KEYS],
    vaultLeaseRefs: unique(input.vaultLeasePolicyRefs),
    maxLeaseTtlSeconds: DEFAULT_MAX_VAULT_TTL_SECONDS,
    redactResultPayloads: true,
    failClosed: true,
  };

  const mcpGrants: McpGrantInput[] = [];
  const mcpRuntimeServers: McpRuntimeServerConfig[] = [];
  const selectedVaultRefs = new Set(unique(input.vaultLeasePolicyRefs));
  for (const mcpGrantRef of unique(input.mcpGrantRefs)) {
    const object = requireSnapshotObject(snapshot, mcpGrantRef, "mcp_tool_grant");
    const serverId = stringField(object.state, "serverId");
    const allowedTools = stringArray(object.state, "allowedTools");
    mcpGrants.push({
      serverId,
      allowedTools,
    });
    mcpRuntimeServers.push(mcpRuntimeServerConfig(object, { serverId, allowedTools, selectedVaultRefs }));
  }

  const vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">> = [];
  let maxLeaseTtlSeconds = 0;
  for (const vaultRef of unique(input.vaultLeasePolicyRefs)) {
    const object = requireSnapshotObject(snapshot, vaultRef, "vault_lease_policy");
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
    mcpRuntimeConfig: {
      schemaVersion: "southstar.mcp_runtime_config.v1",
      runId: input.runId,
      taskId: input.taskId,
      servers: mcpRuntimeServers,
      policy: {
        failClosed: true,
        secretsMaterializedByVault: true,
        configContainsSecretValues: false,
      },
    },
    vaultLeases,
  };
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

function optionalStringArray(state: Record<string, unknown>, field: string): string[] {
  const value = state[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalStringField(state: Record<string, unknown>, field: string): string | undefined {
  const value = state[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mcpRuntimeServerConfig(
  object: RunLibrarySnapshotObjectV1,
  input: { serverId: string; allowedTools: string[]; selectedVaultRefs: Set<string> },
): McpRuntimeServerConfig {
  const transport = optionalStringField(object.state, "transport") ?? "stdio";
  if (transport !== "stdio") {
    throw new Error(`unsupported MCP transport for ${object.objectKey}: ${transport}`);
  }
  const command = mcpCommand(object.state, input.serverId);
  const envFromVault = mcpEnvFromVault(object.state, object.objectKey);
  for (const envBinding of envFromVault) {
    if (!input.selectedVaultRefs.has(envBinding.leaseRef)) {
      throw new Error(`MCP server ${input.serverId} requires vault lease ${envBinding.leaseRef}`);
    }
  }
  const env = stringRecord(object.state, "env");
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_DIRECT_ENV_KEYS.includes(key)) {
      throw new Error(`MCP server ${input.serverId} cannot directly define secret env ${key}; use envFromVault`);
    }
  }
  const configFiles = mcpConfigFiles(object.state, object.objectKey);
  const config: McpRuntimeServerConfig = {
    serverId: input.serverId,
    transport,
    allowedTools: input.allowedTools,
    command,
    envFromVault,
  };
  if (Object.keys(env).length > 0) config.env = env;
  if (configFiles.length > 0) config.configFiles = configFiles;
  return config;
}

function mcpCommand(state: Record<string, unknown>, serverId: string): McpRuntimeServerConfig["command"] {
  const explicitCommand = optionalStringField(state, "command");
  if (!explicitCommand) throw new Error(`missing MCP command for ${serverId}`);
  const args = optionalStringArray(state, "args");
  const cwd = optionalStringField(state, "cwd");
  const result: McpRuntimeServerConfig["command"] = {
    argv: [explicitCommand, ...args],
  };
  if (cwd) result.cwd = cwd;
  return result;
}

function mcpEnvFromVault(
  state: Record<string, unknown>,
  objectKey: string,
): McpRuntimeServerConfig["envFromVault"] {
  const value = state.envFromVault;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`invalid envFromVault for ${objectKey}`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`invalid envFromVault.${index} for ${objectKey}`);
    }
    const record = item as Record<string, unknown>;
    const name = requiredString(record, "name", `envFromVault.${index}.name`);
    const leaseRef = requiredString(record, "leaseRef", `envFromVault.${index}.leaseRef`);
    const key = optionalStringField(record, "key");
    const binding: McpRuntimeServerConfig["envFromVault"][number] = { name, leaseRef };
    if (key) binding.key = key;
    return binding;
  });
}

function mcpConfigFiles(
  state: Record<string, unknown>,
  objectKey: string,
): NonNullable<McpRuntimeServerConfig["configFiles"]> {
  const value = state.configFiles;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`invalid configFiles for ${objectKey}`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`invalid configFiles.${index} for ${objectKey}`);
    }
    const record = item as Record<string, unknown>;
    const path = requiredString(record, "path", `configFiles.${index}.path`);
    const leaseRef = optionalStringField(record, "leaseRef");
    const readonly = typeof record.readonly === "boolean" ? record.readonly : undefined;
    return {
      path,
      ...(leaseRef ? { leaseRef } : {}),
      ...(readonly !== undefined ? { readonly } : {}),
    };
  });
}

function stringRecord(state: Record<string, unknown>, field: string): Record<string, string> {
  const value = state[field];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${field}`);
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`invalid ${field}.${key}`);
    result[key] = item;
  }
  return result;
}

function requiredString(state: Record<string, unknown>, field: string, label = field): string {
  const value = state[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function skillInstructions(state: Record<string, unknown>): string {
  const direct = optionalStringField(state, "instructions");
  if (direct) return direct;
  const structured = state.instructions;
  if (structured && typeof structured === "object" && typeof (structured as { content?: unknown }).content === "string") {
    return (structured as { content: string }).content;
  }
  const body = optionalStringField(state, "body");
  if (body) return body;
  throw new Error("invalid instructions");
}

function defaultSkillAssetBundlePath(objectKey: string): string | undefined {
  if (!objectKey.startsWith("skill.")) return undefined;
  const slug = objectKey.slice("skill.".length).replaceAll(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  return `library/skills/${slug}`;
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

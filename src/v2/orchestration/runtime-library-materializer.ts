import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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
    const object = await approvedSkillObject(db, skillRef);
    const instructionsText = skillInstructions(object.state);
    const sourcePath = optionalStringField(object.state, "sourcePath");
    const assetBundlePath = optionalStringField(object.state, "assetBundlePath") ?? defaultSkillAssetBundlePath(object.objectKey);
    const bundleFiles = await readSkillBundleFiles(input.libraryRoot, assetBundlePath);
    skills.push({
      skillId: object.objectKey,
      version: object.headVersionId ?? "runtime",
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

async function approvedSkillObject(db: SouthstarDb, objectKey: string): Promise<LibraryObjectSummary> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object || object.status !== "approved") {
    throw new Error(`missing approved library object: ${objectKey}`);
  }
  if (object.objectKind !== "skill_spec" && object.objectKind !== "skill_definition") {
    throw new Error(`library object kind mismatch for ${objectKey}: expected skill_spec, got ${object.objectKind}`);
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

function optionalStringArray(state: Record<string, unknown>, field: string): string[] {
  const value = state[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalStringField(state: Record<string, unknown>, field: string): string | undefined {
  const value = state[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

async function readSkillBundleFiles(
  libraryRoot: string | undefined,
  assetBundlePath: string | undefined,
): Promise<NonNullable<ResolvedSkillSnapshot["bundleFiles"]>> {
  if (!libraryRoot || !assetBundlePath) return [];
  const root = resolve(libraryRoot);
  const relativeBundle = assetBundlePath.replace(/^library\//, "");
  const bundleRoot = resolve(root, relativeBundle);
  if (!isWithinRoot(bundleRoot, root)) {
    throw new Error(`skill asset bundle escapes library root: ${assetBundlePath}`);
  }
  try {
    const stats = await stat(bundleRoot);
    if (!stats.isDirectory()) return [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return await collectSkillBundleFiles(bundleRoot, bundleRoot);
}

async function collectSkillBundleFiles(
  directory: string,
  root: string,
): Promise<NonNullable<ResolvedSkillSnapshot["bundleFiles"]>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: NonNullable<ResolvedSkillSnapshot["bundleFiles"]> = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSkillBundleFiles(absolutePath, root));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolutePath);
    files.push({
      relativePath: relative(root, absolutePath).split(/[\\/]+/g).join("/"),
      contentBase64: content.toString("base64"),
      contentHash: sha256(content),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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

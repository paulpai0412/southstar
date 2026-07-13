import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SouthstarDb } from "../../db/postgres.ts";
import {
  catalogDomainTitle,
  isCatalogCanonicalDomain,
  type CatalogCanonicalDomain,
  CATALOG_CANONICAL_DOMAINS,
} from "../canonical-domains.ts";
import {
  createLibraryObject,
  deactivateLibraryEdgesForSourceExcept,
  findLibraryObjectByKey,
  findLibraryObjectByKeyForUpdate,
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryDefinitionStatus, LibraryEdgeType } from "../types.ts";
import { parseLibraryFileContent } from "./library-file-parser.ts";
import type { LibraryFileGraphProjection, LibraryFileParseResult, LibraryFileRecord } from "./library-file-types.ts";

export type LibraryFileListItem = {
  relativePath: string;
};

const SUPPORTED_LIBRARY_FILE_SUFFIXES = [
  ".agent.md",
  ".skill.md",
  ".tool.yaml",
  ".mcp.yaml",
  ".vault.yaml",
  ".profile.yaml",
  ".workflow.yaml",
  ".capability.yaml",
  ".artifact.yaml",
  ".domain.yaml",
  ".evaluator.yaml",
];

const OBJECT_KIND_BY_FILE_KIND: Record<LibraryFileRecord["kind"], LibraryDefinitionKind> = {
  agent: "agent_definition",
  skill: "skill_spec",
  tool: "tool_definition",
  mcp: "mcp_tool_grant",
  vault: "vault_lease_policy",
  generated_profile: "agent_profile",
  workflow_template: "workflow_template",
  capability: "capability_spec",
  artifact: "artifact_contract",
  domain: "domain_taxonomy",
  evaluator: "evaluator_profile",
};

const EDGE_REF_PROJECTIONS: Array<{ key: string; edgeType: LibraryEdgeType }> = [
  { key: "capabilityRefs", edgeType: "provides_capability" },
  { key: "providesCapabilityRefs", edgeType: "provides_capability" },
  { key: "requiresCapabilityRefs", edgeType: "requires_capability" },
  { key: "requiresToolRefs", edgeType: "requires_tool" },
  { key: "allowedToolRefs", edgeType: "allows_tool" },
  { key: "toolGrantRefs", edgeType: "allows_tool" },
  { key: "requiresMcpRefs", edgeType: "allows_mcp_grant" },
  { key: "mcpGrantRefs", edgeType: "allows_mcp_grant" },
  { key: "skillRefs", edgeType: "uses" },
  { key: "instructionRefs", edgeType: "uses_instruction" },
  { key: "validatesArtifactRefs", edgeType: "validates_artifact" },
];

export async function listLibraryFiles(input: { root: string }): Promise<LibraryFileListItem[]> {
  const files: string[] = [];
  await collectFiles(input.root, "", files);
  return files
    .filter((relativePath) => SUPPORTED_LIBRARY_FILE_SUFFIXES.some((suffix) => relativePath.endsWith(suffix)))
    .sort()
    .map((relativePath) => ({ relativePath }));
}

export async function readLibraryFile(input: {
  root: string;
  relativePath: string;
}): Promise<{ relativePath: string; content: string; parsed: LibraryFileParseResult }> {
  const safePath = await resolveLibraryPath(input);
  const content = await readFile(safePath.absolutePath, "utf8");
  return {
    relativePath: safePath.relativePath,
    content,
    parsed: parseLibraryFileContent({ path: `library/${safePath.relativePath}`, content }),
  };
}

export async function writeLibraryFile(input: {
  root: string;
  relativePath: string;
  content: string;
}): Promise<{ relativePath: string }> {
  const safePath = await resolveLibraryPath(input, { allowMissingRoot: true });
  await mkdir(dirname(safePath.absolutePath), { recursive: true });
  await writeFile(safePath.absolutePath, input.content, "utf8");
  return { relativePath: safePath.relativePath };
}

export async function writeNewLibraryFile(input: {
  root: string;
  relativePath: string;
  content: string;
}): Promise<{ relativePath: string }> {
  const safePath = await resolveLibraryPath(input, { allowMissingRoot: true });
  await mkdir(dirname(safePath.absolutePath), { recursive: true });
  await writeFile(safePath.absolutePath, input.content, { encoding: "utf8", flag: "wx" });
  return { relativePath: safePath.relativePath };
}

export async function removeLibraryFileIfContentMatches(input: {
  root: string;
  relativePath: string;
  content: string;
}): Promise<boolean> {
  const safePath = await resolveLibraryPath(input, { allowMissingRoot: true });
  let existing;
  try {
    existing = await readFile(safePath.absolutePath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (existing !== input.content) return false;
  await rm(safePath.absolutePath, { force: true });
  return true;
}

export async function syncLibraryFileToGraph(db: SouthstarDb, input: { root: string; relativePath: string }) {
  const file = await readLibraryFile(input);
  if (!file.parsed.ok) {
    throw new Error(
      `library file is invalid: ${file.parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  const parsedFile = file.parsed.file;
  return db.tx(async (tx) => syncLibraryFileRecordToGraph(tx, parsedFile));
}

export async function syncLibraryFileRecordToGraph(
  db: SouthstarDb,
  file: LibraryFileRecord,
  options: { rejectExistingObject?: boolean } = {},
) {
  validateLibraryFileGraphReferences(file);
  const projection = projectLibraryFileToGraph(file);

  const existing = await findLibraryObjectByKeyForUpdate(db, projection.object.objectKey);
  if (options.rejectExistingObject && existing) {
    throw new Error(`library import object already exists: ${projection.object.objectKey}`);
  }
  const objectInput = existing?.headVersionId === projection.object.headVersionId
    ? {
        ...projection.object,
        status: existing.status,
        state: { ...projection.object.state, status: existing.status },
      }
    : projection.object;
  const object = await upsertLibraryObject(db, objectInput);
  await deactivateLibraryEdgesForSourceExcept(db, {
    fromObjectKey: projection.object.objectKey,
    sourcePath: file.path,
    keepEdges: projection.edges,
  });
  const edges = [];
  for (const edge of projection.edges) {
    await ensureReferencedObject(db, edge.toObjectKey, edge.scope);
    edges.push(await upsertLibraryEdge(db, { ...edge, status: "active", weight: 1 }));
  }
  return { object, edges };
}

export async function syncNewLibraryFileRecordsToGraph(db: SouthstarDb, files: LibraryFileRecord[]) {
  const projections = files.map((file) => {
    validateLibraryFileGraphReferences(file);
    return { file, projection: projectLibraryFileToGraph(file) };
  });
  const importedKeys = new Set(projections.map(({ projection }) => projection.object.objectKey));
  const objects = [];
  for (const { projection } of projections) {
    objects.push(await createLibraryObject(db, projection.object));
  }

  const results = [];
  for (const { file, projection } of projections) {
    await deactivateLibraryEdgesForSourceExcept(db, {
      fromObjectKey: projection.object.objectKey,
      sourcePath: file.path,
      keepEdges: projection.edges,
    });
    const edges = [];
    for (const edge of projection.edges) {
      if (!importedKeys.has(edge.toObjectKey)) {
        await ensureReferencedObject(db, edge.toObjectKey, edge.scope);
      }
      edges.push(await upsertLibraryEdge(db, { ...edge, status: "active", weight: 1 }));
    }
    const object = objects.find((candidate) => candidate.objectKey === projection.object.objectKey);
    if (!object) throw new Error(`library object sync result missing: ${projection.object.objectKey}`);
    results.push({ object, edges });
  }
  return results;
}

export function projectLibraryFileToGraph(file: LibraryFileRecord): LibraryFileGraphProjection {
  const status: LibraryDefinitionStatus = file.status === "invalid" ? "draft" : file.status;
  const state = {
    ...file.definition,
    body: file.body,
    scope: file.scope,
    title: file.title,
    sourcePath: file.path,
    sourceHash: file.sourceHash,
  };

  return {
    object: {
      objectKey: file.objectKey,
      objectKind: OBJECT_KIND_BY_FILE_KIND[file.kind],
      status,
      headVersionId: `${file.objectKey}@${file.sourceHash.slice(0, 12)}`,
      state,
    },
    edges: edgeProjection(file),
  };
}

export function libraryFileReferences(file: LibraryFileRecord): string[] {
  return [...new Set(projectLibraryFileToGraph(file).edges.map((edge) => edge.toObjectKey))].sort();
}

export function validateLibraryFileGraphReferences(file: LibraryFileRecord): void {
  validateReferencedObjects(projectLibraryFileToGraph(file));
}

function edgeProjection(file: LibraryFileRecord): LibraryFileGraphProjection["edges"] {
  const edges: LibraryFileGraphProjection["edges"] = [];
  if (isCatalogCanonicalDomain(file.scope)) {
    edges.push({
      fromObjectKey: file.objectKey,
      edgeType: "belongs_to_domain",
      toObjectKey: domainObjectKey(file.scope),
      scope: file.scope,
      metadata: {
        sourcePath: file.path,
        sourceHash: file.sourceHash,
        source: "library-file-sync",
        sourceKind: "catalog-domain-scope",
        confidence: 1,
      },
    });
  }
  for (const { key, edgeType } of EDGE_REF_PROJECTIONS) {
    addRefs(edges, file, key, edgeType);
  }

  const agentRef = stringValue(file.frontmatter.agentRef);
  if (agentRef) edges.push(edge(file, "implements", agentRef));

  for (const profileRef of stringArray(file.frontmatter.profileRefs)) {
    edges.push(edge(file, "part_of_template", profileRef));
  }

  return edges;
}

function addRefs(
  edges: LibraryFileGraphProjection["edges"],
  file: LibraryFileRecord,
  key: string,
  edgeType: LibraryEdgeType,
): void {
  for (const ref of stringArray(file.frontmatter[key])) {
    edges.push(edge(file, edgeType, ref));
  }
}

function edge(
  file: LibraryFileRecord,
  edgeType: LibraryEdgeType,
  toObjectKey: string,
): LibraryFileGraphProjection["edges"][number] {
  return {
    fromObjectKey: file.objectKey,
    edgeType,
    toObjectKey,
    scope: file.scope,
    metadata: { sourcePath: file.path, sourceHash: file.sourceHash },
  };
}

async function ensureReferencedObject(db: SouthstarDb, objectKey: string, scope: string): Promise<void> {
  const existing = await findLibraryObjectByKey(db, objectKey);
  if (existing) return;

  try {
    const domain = catalogDomainFromObjectKey(objectKey);
    if (domain) {
      await createLibraryObject(db, {
        objectKey,
        objectKind: "domain_taxonomy",
        status: "approved",
        headVersionId: `${objectKey}@catalog-v1`,
        state: {
          title: domain.title,
          scope: domain.key,
          domainKey: domain.key,
          source: "catalog-canonical-domain",
          sourcePathPrefixes: domain.sourcePathPrefixes,
        },
      });
      return;
    }

    await createLibraryObject(db, {
      objectKey,
      objectKind: inferObjectKind(objectKey),
      status: "draft",
      headVersionId: `${objectKey}@placeholder`,
      state: {
        title: objectKey,
        scope,
        source: "library-file-sync-placeholder",
      },
    });
  } catch (error: unknown) {
    if ((error as Error).message === `library object already exists: ${objectKey}`) return;
    throw error;
  }
}

function inferObjectKind(objectKey: string): LibraryDefinitionKind {
  if (objectKey.startsWith("agent.")) return "agent_definition";
  if (objectKey.startsWith("artifact.")) return "artifact_contract";
  if (objectKey.startsWith("capability.")) return "capability_spec";
  if (objectKey.startsWith("domain.")) return "domain_taxonomy";
  if (objectKey.startsWith("evaluator.")) return "evaluator_profile";
  if (objectKey.startsWith("instruction.")) return "instruction_template";
  if (objectKey.startsWith("mcp.")) return "mcp_tool_grant";
  if (objectKey.startsWith("profile.")) return "agent_profile";
  if (objectKey.startsWith("skill.")) return "skill_spec";
  if (objectKey.startsWith("template.")) return "workflow_template";
  if (objectKey.startsWith("tool.")) return "tool_definition";
  if (objectKey.startsWith("vault.")) return "vault_lease_policy";
  throw new Error(`unsupported referenced object key prefix: ${objectKey}`);
}

function domainObjectKey(scope: string): string {
  return `domain.${scope}`;
}

function catalogDomainFromObjectKey(objectKey: string): CatalogCanonicalDomain | undefined {
  const key = objectKey.startsWith("domain.") ? objectKey.slice("domain.".length) : undefined;
  if (!isCatalogCanonicalDomain(key)) return undefined;
  return CATALOG_CANONICAL_DOMAINS.find((domain) => domain.key === key)
    ?? { key, title: catalogDomainTitle(key) ?? key, sourcePathPrefixes: [] };
}

function validateReferencedObjects(projection: LibraryFileGraphProjection): void {
  for (const edge of projection.edges) {
    inferObjectKind(edge.toObjectKey);
  }
}

async function resolveLibraryPath(input: {
  root: string;
  relativePath: string;
}, options: { allowMissingRoot?: boolean } = {}): Promise<{ absolutePath: string; relativePath: string }> {
  const root = resolve(input.root);
  const absolutePath = isAbsolute(input.relativePath)
    ? resolve(input.relativePath)
    : resolve(root, input.relativePath);
  const normalizedRelativePath = relative(root, absolutePath);
  if (
    normalizedRelativePath === "" ||
    normalizedRelativePath.startsWith("..") ||
    isAbsolute(normalizedRelativePath) ||
    !absolutePath.startsWith(`${root}${sep}`)
  ) {
    throw new Error(`library file path escapes root: ${input.relativePath}`);
  }

  await rejectSymlinkComponents(root, normalizedRelativePath, input.relativePath, options);
  return { absolutePath, relativePath: normalizedRelativePath.split(sep).join("/") };
}

async function rejectSymlinkComponents(
  root: string,
  normalizedRelativePath: string,
  requestedPath: string,
  options: { allowMissingRoot?: boolean } = {},
): Promise<void> {
  const rootExists = await rejectSymlinkIfExists(root, requestedPath);
  if (!rootExists) {
    if (options.allowMissingRoot) return;
    await rejectSymlink(root, requestedPath);
  }

  let currentPath = root;
  for (const component of normalizedRelativePath.split(sep)) {
    currentPath = join(currentPath, component);
    const exists = await rejectSymlinkIfExists(currentPath, requestedPath);
    if (!exists) return;
  }
}

async function rejectSymlink(path: string, requestedPath: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`library file path uses symlink: ${requestedPath}`);
  }
}

async function rejectSymlinkIfExists(path: string, requestedPath: string): Promise<boolean> {
  try {
    await rejectSymlink(path, requestedPath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function collectFiles(root: string, prefix: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await collectFiles(root, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

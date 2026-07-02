import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SouthstarDb } from "../../db/postgres.ts";
import {
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
  ".profile.yaml",
  ".workflow.yaml",
];

const OBJECT_KIND_BY_FILE_KIND: Record<LibraryFileRecord["kind"], LibraryDefinitionKind> = {
  agent: "agent_definition",
  skill: "skill_spec",
  tool: "tool_definition",
  mcp: "mcp_tool_grant",
  generated_profile: "agent_profile",
  workflow_template: "workflow_template",
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
  { key: "skillRefs", edgeType: "supports_skill" },
  { key: "instructionRefs", edgeType: "uses_instruction" },
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

export async function syncLibraryFileToGraph(db: SouthstarDb, input: { root: string; relativePath: string }) {
  const file = await readLibraryFile(input);
  if (!file.parsed.ok) {
    throw new Error(
      `library file is invalid: ${file.parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }

  const projection = projectFileToGraph(file.parsed.file);
  validateReferencedObjects(projection);

  return db.tx(async (tx) => {
    const existing = await findLibraryObjectByKeyForUpdate(tx, projection.object.objectKey);
    const objectInput = existing?.headVersionId === projection.object.headVersionId
      ? {
          ...projection.object,
          status: existing.status,
          state: { ...projection.object.state, status: existing.status },
        }
      : projection.object;
    const object = await upsertLibraryObject(tx, objectInput);
    await deactivateLibraryEdgesForSourceExcept(tx, {
      fromObjectKey: projection.object.objectKey,
      sourcePath: file.parsed.file.path,
      keepEdges: projection.edges,
    });
    const edges = [];
    for (const edge of projection.edges) {
      await ensureReferencedObject(tx, edge.toObjectKey, edge.scope);
      edges.push(await upsertLibraryEdge(tx, { ...edge, status: "active", weight: 1 }));
    }
    return { object, edges };
  });
}

function projectFileToGraph(file: LibraryFileRecord): LibraryFileGraphProjection {
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

function edgeProjection(file: LibraryFileRecord): LibraryFileGraphProjection["edges"] {
  const edges: LibraryFileGraphProjection["edges"] = [];
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

  await upsertLibraryObject(db, {
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
}

function inferObjectKind(objectKey: string): LibraryDefinitionKind {
  if (objectKey.startsWith("agent.")) return "agent_definition";
  if (objectKey.startsWith("capability.")) return "capability_spec";
  if (objectKey.startsWith("instruction.")) return "instruction_template";
  if (objectKey.startsWith("mcp.")) return "mcp_tool_grant";
  if (objectKey.startsWith("profile.")) return "agent_profile";
  if (objectKey.startsWith("skill.")) return "skill_spec";
  if (objectKey.startsWith("template.")) return "workflow_template";
  if (objectKey.startsWith("tool.")) return "tool_definition";
  throw new Error(`unsupported referenced object key prefix: ${objectKey}`);
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

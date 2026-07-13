import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SouthstarDb } from "../../db/postgres.ts";
import { isCatalogCanonicalDomain } from "../canonical-domains.ts";
import {
  createLibraryObject,
  deactivateLibraryEdgesForSourceExcept,
  deactivateValidationEdgesForSource,
  findLibraryObjectByKey,
  findLibraryObjectByKeyForUpdate,
  repinInboundValidationEdgesForArtifact,
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../library-graph-store.ts";
import type {
  LibraryDefinitionKind,
  LibraryDefinitionStatus,
  LibraryEdgeRecord,
  LibraryEdgeType,
  LibraryObjectSummary,
} from "../types.ts";
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

export type LibraryFilePublication = {
  publicationId: string;
  stagingRoot: string;
  manifest: LibraryFilePublicationManifest;
  publish(): Promise<void>;
  rollbackPublished(): Promise<void>;
  rollForwardCommitted(): Promise<void>;
  markCommittedOrRecoverable(): Promise<void>;
  discard(): Promise<void>;
};

export type LibraryFilePublicationIdentity = {
  kind: "candidate_install" | "legacy_approval" | "library_file_patch";
  importDraftId?: string;
  plannerDraftId?: string;
  relativePath?: string;
  originGoalContractHash?: string;
  originGoalRequirementDraftHash?: string;
  originGoalValidationResolutionHash?: string;
  originGoalValidationGapHash?: string;
};

export type LibraryFilePublicationManifest = {
  schemaVersion: "southstar.library_file_publication.v1";
  publicationId: string;
  libraryRoot: string;
  phase: "prepared" | "published" | "committed_or_recoverable";
  identity: LibraryFilePublicationIdentity;
  createdAt: string;
  entries: Array<{
    relativePath: string;
    mode: "create" | "replace";
    expectedOriginalHash?: string;
    originalContentRef?: string;
    backupRef: string;
    newHash: string;
    newContentRef: string;
  }>;
};

export async function prepareLibraryFilePublication(input: {
  root: string;
  identity: LibraryFilePublicationIdentity;
  files: Array<{
    relativePath: string;
    content: string | Buffer;
    mode: "create" | "replace";
    expectedContent?: string | Buffer;
  }>;
}): Promise<LibraryFilePublication> {
  const libraryRoot = resolve(input.root);
  const publicationId = `library-publication-${randomUUID()}`;
  const journalRoot = libraryPublicationJournalRoot(libraryRoot);
  const stagingRoot = join(journalRoot, publicationId);
  const preparingRoot = join(journalRoot, `.${publicationId}.preparing`);
  await mkdir(journalRoot, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(journalRoot));
  await mkdir(preparingRoot, { recursive: false, mode: 0o700 });
  await syncDirectory(journalRoot);
  const manifest: LibraryFilePublicationManifest = {
    schemaVersion: "southstar.library_file_publication.v1",
    publicationId,
    libraryRoot,
    phase: "prepared",
    identity: { ...input.identity },
    createdAt: new Date().toISOString(),
    entries: [],
  };
  try {
    for (const [index, file] of input.files.entries()) {
      const target = await resolveLibraryPath({ root: input.root, relativePath: file.relativePath }, { allowMissingRoot: true });
      const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
      const expectedContent = file.expectedContent === undefined
        ? undefined
        : Buffer.isBuffer(file.expectedContent) ? file.expectedContent : Buffer.from(file.expectedContent, "utf8");
      if (file.mode === "replace" && !expectedContent) {
        throw new Error(`replacement publication requires expectedContent: ${file.relativePath}`);
      }
      const newContentRef = `new/${index}-${basename(file.relativePath)}`;
      const originalContentRef = expectedContent ? `original/${index}-${basename(file.relativePath)}` : undefined;
      const backupRef = `backups/${index}-${basename(file.relativePath)}`;
      await writeDurableFile(join(preparingRoot, newContentRef), content);
      if (expectedContent && originalContentRef) {
        await writeDurableFile(join(preparingRoot, originalContentRef), expectedContent);
      }
      manifest.entries.push({
        relativePath: target.relativePath,
        mode: file.mode,
        ...(expectedContent ? { expectedOriginalHash: sha256(expectedContent), originalContentRef } : {}),
        backupRef,
        newHash: sha256(content),
        newContentRef,
      });
    }
    await persistLibraryPublicationManifest(preparingRoot, manifest);
    await rename(preparingRoot, stagingRoot);
    await syncDirectory(journalRoot);
  } catch (error) {
    await rm(preparingRoot, { recursive: true, force: true });
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return publicationFromManifest(manifest, stagingRoot);
}

export async function listLibraryFilePublications(input: { root: string }): Promise<LibraryFilePublication[]> {
  const libraryRoot = resolve(input.root);
  const journalRoot = libraryPublicationJournalRoot(libraryRoot);
  const entries = await readdir(journalRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const publications: LibraryFilePublication[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const stagingRoot = join(journalRoot, entry.name);
    const manifest = JSON.parse(await readFile(join(stagingRoot, "journal.json"), "utf8")) as LibraryFilePublicationManifest;
    assertLibraryPublicationManifest(manifest, libraryRoot, entry.name);
    publications.push(publicationFromManifest(manifest, stagingRoot));
  }
  return publications;
}

function publicationFromManifest(
  manifest: LibraryFilePublicationManifest,
  stagingRoot: string,
): LibraryFilePublication {
  const livePath = async (relativePath: string): Promise<string> => (
    await resolveLibraryPath({ root: manifest.libraryRoot, relativePath }, { allowMissingRoot: true })
  ).absolutePath;
  const rollbackEntries = async (entries: LibraryFilePublicationManifest["entries"]): Promise<void> => {
    for (const entry of [...entries].reverse()) {
      const targetPath = await livePath(entry.relativePath);
      const live = await optionalFile(targetPath);
      if (entry.mode === "create") {
        if (live && sha256(live) === entry.newHash) {
          await rm(targetPath, { force: true });
          await syncDirectory(dirname(targetPath));
        }
        continue;
      }
      if (live && sha256(live) !== entry.newHash) continue;
      if (!entry.originalContentRef) throw new Error(`publication original content is missing: ${entry.relativePath}`);
      await replaceTargetFromRef(join(stagingRoot, entry.originalContentRef), targetPath, manifest.publicationId);
    }
  };
  const rollbackPublished = async (): Promise<void> => await rollbackEntries(manifest.entries);
  return {
    publicationId: manifest.publicationId,
    stagingRoot,
    manifest,
    async publish() {
      const touchedEntries: LibraryFilePublicationManifest["entries"] = [];
      try {
        for (const entry of manifest.entries) {
          const targetPath = await livePath(entry.relativePath);
          const newContentPath = join(stagingRoot, entry.newContentRef);
          await mkdir(dirname(targetPath), { recursive: true });
          if (entry.mode === "replace") {
            const current = await readFile(targetPath);
            if (sha256(current) !== entry.expectedOriginalHash) {
              throw new Error(`library file changed since publication was prepared: ${targetPath}`);
            }
            touchedEntries.push(entry);
            const backupPath = join(stagingRoot, entry.backupRef);
            await mkdir(dirname(backupPath), { recursive: true });
            await rename(targetPath, backupPath);
            await syncDirectory(dirname(targetPath));
            await syncDirectory(dirname(backupPath));
          }
          if (entry.mode === "replace") {
            await replaceTargetFromRef(newContentPath, targetPath, manifest.publicationId);
          } else {
            await createTargetFromRef(newContentPath, targetPath, manifest.publicationId);
            touchedEntries.push(entry);
          }
        }
        manifest.phase = "published";
        await persistLibraryPublicationManifest(stagingRoot, manifest);
      } catch (error) {
        await rollbackEntries(touchedEntries);
        throw error;
      }
    },
    rollbackPublished,
    async rollForwardCommitted() {
      for (const entry of manifest.entries) {
        const targetPath = await livePath(entry.relativePath);
        const live = await optionalFile(targetPath);
        const liveHash = live ? sha256(live) : undefined;
        if (liveHash === entry.newHash) continue;
        if (liveHash !== undefined && liveHash !== entry.expectedOriginalHash) continue;
        await replaceTargetFromRef(join(stagingRoot, entry.newContentRef), targetPath, manifest.publicationId);
      }
    },
    async markCommittedOrRecoverable() {
      manifest.phase = "committed_or_recoverable";
      await persistLibraryPublicationManifest(stagingRoot, manifest);
    },
    async discard() {
      await rm(stagingRoot, { recursive: true, force: true });
      await syncDirectory(dirname(stagingRoot));
    },
  };
}

function libraryPublicationJournalRoot(libraryRoot: string): string {
  return join(dirname(libraryRoot), `.${basename(libraryRoot)}-southstar-publications`);
}

async function persistLibraryPublicationManifest(
  stagingRoot: string,
  manifest: LibraryFilePublicationManifest,
): Promise<void> {
  const destination = join(stagingRoot, "journal.json");
  const temporary = join(stagingRoot, `.journal-${randomUUID()}.tmp`);
  await writeDurableFile(temporary, Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"));
  await rename(temporary, destination);
  await syncDirectory(stagingRoot);
}

async function writeDurableFile(path: string, content: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function optionalFile(path: string): Promise<Buffer | undefined> {
  return await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function replaceTargetFromRef(ref: string, targetPath: string, publicationId: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = join(dirname(targetPath), `.${basename(targetPath)}.${publicationId}.tmp`);
  await rm(temporary, { force: true });
  await writeDurableFile(temporary, await readFile(ref));
  await rename(temporary, targetPath);
  await syncDirectory(dirname(targetPath));
}

async function createTargetFromRef(ref: string, targetPath: string, publicationId: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporary = join(dirname(targetPath), `.${basename(targetPath)}.${publicationId}.tmp`);
  await rm(temporary, { force: true });
  await writeDurableFile(temporary, await readFile(ref));
  try {
    await link(temporary, targetPath);
    await syncDirectory(dirname(targetPath));
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertLibraryPublicationManifest(
  manifest: LibraryFilePublicationManifest,
  libraryRoot: string,
  directoryName: string,
): void {
  const identity = manifest.identity as LibraryFilePublicationIdentity | undefined;
  const entriesValid = Array.isArray(manifest.entries) && manifest.entries.every((entry) => (
    entry
    && isSafeRelativeReference(entry.relativePath)
    && ["create", "replace"].includes(entry.mode)
    && /^[a-f0-9]{64}$/.test(entry.newHash)
    && isSafeRelativeReference(entry.newContentRef)
    && isSafeRelativeReference(entry.backupRef)
    && (entry.originalContentRef === undefined || isSafeRelativeReference(entry.originalContentRef))
    && (entry.expectedOriginalHash === undefined || /^[a-f0-9]{64}$/.test(entry.expectedOriginalHash))
  ));
  if (manifest.schemaVersion !== "southstar.library_file_publication.v1"
    || manifest.publicationId !== directoryName
    || resolve(manifest.libraryRoot) !== libraryRoot
    || !["prepared", "published", "committed_or_recoverable"].includes(manifest.phase)
    || !identity
    || !["candidate_install", "legacy_approval", "library_file_patch"].includes(identity.kind)
    || !entriesValid) {
    throw new Error(`invalid Library publication journal: ${directoryName}`);
  }
}

function isSafeRelativeReference(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.split(/[\\/]/u).includes("..");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
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
  await assertReferencedLibraryObjectsExist(db, projection);
  const object = await upsertLibraryObject(db, objectInput);
  if (object.objectKind === "artifact_contract") {
    await repinInboundValidationEdgesForArtifact(db, { artifactObjectKey: object.objectKey });
  }
  if (object.objectKind === "evaluator_profile" && object.status !== "approved") {
    await deactivateValidationEdgesForSource(db, { fromObjectKey: object.objectKey });
  }
  const activeEdges = edgesToPersistForFile({
    status: object.status,
    objectKind: object.objectKind,
    edges: projection.edges,
  });
  await deactivateLibraryEdgesForSourceExcept(db, {
    fromObjectKey: projection.object.objectKey,
    sourcePath: file.path,
    keepEdges: activeEdges,
  });
  const edges = [];
  for (const edge of activeEdges) {
    edges.push(await upsertLibraryEdge(db, await versionedEdge(db, edge, object.headVersionId)));
  }
  return { object, edges };
}

export async function syncNewLibraryFileRecordsToGraph(db: SouthstarDb, files: LibraryFileRecord[]) {
  const projections = files.map((file) => {
    validateLibraryFileGraphReferences(file);
    return { file, projection: projectLibraryFileToGraph(file) };
  });
  const importedKeys = new Set(projections.map(({ projection }) => projection.object.objectKey));
  for (const { projection } of projections) {
    await assertReferencedLibraryObjectsExist(db, projection, importedKeys);
  }
  const objects = [];
  for (const { projection } of projections) {
    objects.push(await createLibraryObject(db, projection.object));
  }

  const results = [];
  for (const { file, projection } of projections) {
    const activeEdges = edgesToPersistForFile({
      status: projection.object.status,
      objectKind: projection.object.objectKind,
      edges: projection.edges,
    });
    await deactivateLibraryEdgesForSourceExcept(db, {
      fromObjectKey: projection.object.objectKey,
      sourcePath: file.path,
      keepEdges: activeEdges,
    });
    const edges = [];
    for (const edge of activeEdges) {
      edges.push(await upsertLibraryEdge(db, await versionedEdge(db, edge, projection.object.headVersionId)));
    }
    const object = objects.find((candidate) => candidate.objectKey === projection.object.objectKey);
    if (!object) throw new Error(`library object sync result missing: ${projection.object.objectKey}`);
    results.push({ object, edges });
  }
  return results;
}

export type LibraryGraphSyncInput = {
  executable: LibraryFileRecord[];
  nonExecutable: Array<{ file: LibraryFileRecord; status: "draft" | "deprecated" | "blocked"; reason?: string }>;
};

export type LibraryGraphSyncResult = {
  objects: LibraryObjectSummary[];
  edges: LibraryEdgeRecord[];
  results: Array<{ object: LibraryObjectSummary; edges: LibraryEdgeRecord[] }>;
};

/**
 * Synchronize a complete file catalog in two phases. Every object row is
 * present before edges are written, and only executable (approved, closed)
 * files receive active edges. Missing references therefore remain represented
 * by a blocked object rather than a synthetic placeholder.
 */
export async function syncLibraryFileRecordsToGraphPg(
  db: SouthstarDb,
  input: LibraryGraphSyncInput,
): Promise<LibraryGraphSyncResult> {
  const all = [
    ...input.executable.map((file) => ({ file, forcedStatus: "approved" as const, reason: undefined })),
    ...input.nonExecutable.map(({ file, status, reason }) => ({ file, forcedStatus: status, reason })),
  ];
  const projections = all.map(({ file, forcedStatus, reason }) => {
    if (forcedStatus === "approved") validateLibraryFileGraphReferences(file);
    const projection = projectLibraryFileToGraph(file);
    return {
      file,
      projection: {
        ...projection,
        object: {
          ...projection.object,
          status: forcedStatus,
          state: {
            ...projection.object.state,
            status: forcedStatus,
            declaredStatus: file.status,
            ...(reason ? { reconcileReason: reason } : {}),
          },
        },
      },
    };
  });
  const available = new Set(projections.map(({ projection }) => projection.object.objectKey));
  for (const { projection } of projections) {
    if (projection.object.status !== "approved") continue;
    for (const edge of projection.edges) {
      if (!available.has(edge.toObjectKey)) {
        throw new Error(`unresolved Library reference ${edge.toObjectKey} from ${projection.object.objectKey}`);
      }
    }
  }

  const objects: LibraryObjectSummary[] = [];
  for (const { projection } of projections) {
    objects.push(await upsertLibraryObject(db, projection.object));
  }

  for (const object of objects) {
    if (object.objectKind === "artifact_contract") {
      await repinInboundValidationEdgesForArtifact(db, { artifactObjectKey: object.objectKey });
    }
    if (object.objectKind === "evaluator_profile" && object.status !== "approved") {
      await deactivateValidationEdgesForSource(db, { fromObjectKey: object.objectKey });
    }
  }

  const edges: LibraryEdgeRecord[] = [];
  for (const { file, projection } of projections) {
    const activeEdges = projection.object.status === "approved" ? projection.edges : [];
    await deactivateLibraryEdgesForSourceExcept(db, {
      fromObjectKey: projection.object.objectKey,
      sourcePath: file.path,
      keepEdges: activeEdges,
    });
    for (const edge of activeEdges) {
      const source = objects.find((object) => object.objectKey === projection.object.objectKey);
      if (!source) throw new Error(`library object sync result missing: ${projection.object.objectKey}`);
      edges.push(await upsertLibraryEdge(db, await versionedEdge(db, edge, source.headVersionId)));
    }
  }

  return {
    objects,
    edges,
    results: projections.map(({ projection }) => ({
      object: objects.find((object) => object.objectKey === projection.object.objectKey)!,
      edges: edges.filter((edge) => edge.fromObjectKey === projection.object.objectKey),
    })),
  };
}

async function versionedEdge(
  db: SouthstarDb,
  edge: LibraryFileGraphProjection["edges"][number],
  fromVersionRef: string,
): Promise<Parameters<typeof upsertLibraryEdge>[1]> {
  const target = await findLibraryObjectByKey(db, edge.toObjectKey);
  if (!target || !target.headVersionId) {
    throw new Error(`unresolved Library reference version ${edge.toObjectKey} from ${edge.fromObjectKey}`);
  }
  return {
    ...edge,
    fromVersionRef,
    toVersionRef: target.headVersionId,
    status: "active",
    weight: 1,
  };
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

function edgesToPersistForFile(input: {
  status: LibraryDefinitionStatus;
  objectKind: LibraryDefinitionKind;
  edges: LibraryFileGraphProjection["edges"];
}): LibraryFileGraphProjection["edges"] {
  if (input.status === "approved" || input.objectKind !== "evaluator_profile") return input.edges;
  return input.edges.filter((edge) => edge.edgeType !== "validates_artifact" && edge.edgeType !== "validates");
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

function domainObjectKey(scope: string): string {
  return `domain.${scope}`;
}

function validateReferencedObjects(projection: LibraryFileGraphProjection): void {
  for (const edge of projection.edges) {
    if (!isKnownLibraryObjectKey(edge.toObjectKey)) {
      throw new Error(`unsupported referenced object key prefix: ${edge.toObjectKey}`);
    }
  }
}

async function assertReferencedLibraryObjectsExist(
  db: SouthstarDb,
  projection: LibraryFileGraphProjection,
  availableKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const edge of projection.edges) {
    if (edge.toObjectKey === projection.object.objectKey) continue;
    if (availableKeys.has(edge.toObjectKey)) continue;
    if (await findLibraryObjectByKey(db, edge.toObjectKey)) continue;
    throw new Error(`unresolved Library reference ${edge.toObjectKey} from ${projection.object.objectKey}`);
  }
}

function isKnownLibraryObjectKey(objectKey: string): boolean {
  return /^(agent|artifact|capability|domain|evaluator|instruction|mcp|profile|skill|template|tool|vault)\.[^\s.]+(?:[^\s]*)$/.test(objectKey);
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

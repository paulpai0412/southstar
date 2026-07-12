import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { LibraryDefinitionKind } from "../design-library/types.ts";
import type { LibraryObjectVersionRef } from "../manifests/types.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export const RUN_LIBRARY_SNAPSHOT_MAX_BUNDLE_FILE_BYTES = 256 * 1024;
export const RUN_LIBRARY_SNAPSHOT_MAX_BUNDLE_TOTAL_BYTES = 1024 * 1024;

export type RunLibrarySnapshotV1 = {
  schemaVersion: "southstar.run_library_snapshot.v1";
  runId: string;
  goalContractHash?: string;
  manifestHash: string;
  objects: RunLibrarySnapshotObjectV1[];
  snapshotHash: string;
  createdAt: string;
};

export type RunLibrarySnapshotObjectV1 = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  versionRef: string;
  state: Record<string, unknown>;
  stateHash: string;
  bundleFiles?: Array<{ relativePath: string; contentBase64: string; contentHash: string }>;
};

type CaptureRunLibrarySnapshotInput = {
  runId: string;
  goalContractHash?: string;
  manifestHash: string;
  libraryObjectVersionRefs: LibraryObjectVersionRef[];
  libraryRoot?: string;
};

export async function captureRunLibrarySnapshotPg(
  db: SouthstarDb,
  input: CaptureRunLibrarySnapshotInput,
): Promise<RunLibrarySnapshotV1> {
  return await db.tx((tx) => captureRunLibrarySnapshotInTransaction(tx, input));
}

export async function captureRunLibrarySnapshotInTransaction(
  db: SouthstarDb,
  input: CaptureRunLibrarySnapshotInput,
): Promise<RunLibrarySnapshotV1> {
  await lockNewSnapshotTarget(db, input.runId);
  const expectedVersions = new Map<string, string>();
  for (const pair of input.libraryObjectVersionRefs) {
    if (!pair.objectKey || !pair.versionRef) throw new Error("Library snapshot requires non-empty object-version pairs");
    if (expectedVersions.has(pair.objectKey)) throw new Error(`duplicate selected Library object-version pair: ${pair.objectKey}`);
    expectedVersions.set(pair.objectKey, pair.versionRef);
  }
  const objects: RunLibrarySnapshotObjectV1[] = [];
  for (const objectKey of [...expectedVersions.keys()].sort()) {
    const row = await db.maybeOne<{
      object_key: string;
      object_kind: LibraryDefinitionKind;
      status: string;
      head_version_id: string | null;
      state_json: Record<string, unknown>;
    }>(
      `select object_key, object_kind, status, head_version_id, state_json
         from southstar.library_objects
        where object_key = $1
        for update`,
      [objectKey],
    );
    if (!row) throw new Error(`missing selected Library object: ${objectKey}`);
    if (row.status !== "approved") throw new Error(`selected Library object is not approved: ${objectKey}`);
    if (!row.head_version_id) throw new Error(`missing immutable version for selected Library object: ${objectKey}`);
    const expectedVersion = expectedVersions.get(objectKey);
    if (row.head_version_id !== expectedVersion) {
      throw new Error(`selected Library version mismatch for ${objectKey}: expected ${expectedVersion}, got ${row.head_version_id}`);
    }
    rejectCredentialLookingState(row.state_json, objectKey);
    const bundleFiles = row.object_kind === "skill_spec" || row.object_kind === "skill_definition"
      ? await readSkillBundleFiles(
        input.libraryRoot,
        stringField(row.state_json, "assetBundlePath") ?? defaultSkillAssetBundlePath(objectKey),
      )
      : [];
    objects.push({
      objectKey,
      objectKind: row.object_kind,
      versionRef: row.head_version_id,
      state: row.state_json,
      stateHash: contentHashForPayload(row.state_json),
      ...(bundleFiles.length > 0 ? { bundleFiles } : {}),
    });
  }
  const snapshotWithoutHash = {
    schemaVersion: "southstar.run_library_snapshot.v1" as const,
    runId: input.runId,
    ...(input.goalContractHash ? { goalContractHash: input.goalContractHash } : {}),
    manifestHash: input.manifestHash,
    objects,
    createdAt: new Date().toISOString(),
  };
  const snapshot: RunLibrarySnapshotV1 = {
    ...snapshotWithoutHash,
    snapshotHash: snapshotHashForPayload(snapshotWithoutHash),
  };
  await persistSnapshotResource(db, snapshot);
  return snapshot;
}

export async function cloneRunLibrarySnapshotPg(
  db: SouthstarDb,
  input: { sourceRunId: string; runId: string; manifestHash: string },
): Promise<RunLibrarySnapshotV1> {
  return await db.tx(async (tx) => {
    await lockNewSnapshotTarget(tx, input.runId);
    const source = await loadRunLibrarySnapshotPg(tx, input.sourceRunId);
    const snapshotWithoutHash = {
      schemaVersion: "southstar.run_library_snapshot.v1" as const,
      runId: input.runId,
      ...(source.goalContractHash ? { goalContractHash: source.goalContractHash } : {}),
      manifestHash: input.manifestHash,
      objects: structuredClone(source.objects),
      createdAt: new Date().toISOString(),
    };
    const snapshot: RunLibrarySnapshotV1 = {
      ...snapshotWithoutHash,
      snapshotHash: snapshotHashForPayload(snapshotWithoutHash),
    };
    await persistSnapshotResource(tx, snapshot);
    return snapshot;
  });
}

async function lockNewSnapshotTarget(db: SouthstarDb, runId: string): Promise<void> {
  if (!await db.maybeOne("select id from southstar.workflow_runs where id = $1 for update", [runId])) {
    throw new Error(`workflow run not found for Library snapshot: ${runId}`);
  }
  if (await getResourceByKeyPg(db, "run_library_snapshot", runId)) {
    throw new Error(`run Library snapshot already exists: ${runId}`);
  }
}

async function persistSnapshotResource(db: SouthstarDb, snapshot: RunLibrarySnapshotV1): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: `run-library-snapshot:${snapshot.runId}`,
    resourceType: "run_library_snapshot",
    resourceKey: snapshot.runId,
    runId: snapshot.runId,
    scope: "run",
    status: "frozen",
    title: "Run Library Snapshot",
    payload: snapshot,
    summary: {
      schemaVersion: snapshot.schemaVersion,
      objectCount: snapshot.objects.length,
      snapshotHash: snapshot.snapshotHash,
    },
  });
}

export async function loadRunLibrarySnapshotPg(db: SouthstarDb, runId: string): Promise<RunLibrarySnapshotV1> {
  const resource = await getResourceByKeyPg(db, "run_library_snapshot", runId);
  if (!resource) throw new Error(`run Library snapshot not found: ${runId}`);
  if (resource.status !== "frozen" || resource.runId !== runId) {
    throw new Error(`invalid run-scoped Library snapshot resource: ${runId}`);
  }
  const snapshot = resource.payload as RunLibrarySnapshotV1;
  if (snapshot.schemaVersion !== "southstar.run_library_snapshot.v1" || snapshot.runId !== runId || !Array.isArray(snapshot.objects)) {
    throw new Error(`invalid run Library snapshot: ${runId}`);
  }
  const { snapshotHash, ...snapshotWithoutHash } = snapshot;
  if (snapshotHash !== snapshotHashForPayload(snapshotWithoutHash)) {
    throw new Error(`run Library snapshot hash mismatch: ${runId}`);
  }
  return snapshot;
}

export function requireSnapshotObject(
  snapshot: RunLibrarySnapshotV1,
  objectKey: string,
  objectKind: LibraryDefinitionKind | LibraryDefinitionKind[],
): RunLibrarySnapshotObjectV1 {
  const object = snapshot.objects.find((candidate) => candidate.objectKey === objectKey);
  if (!object) throw new Error(`missing run snapshot Library object: ${objectKey}`);
  const acceptedKinds = Array.isArray(objectKind) ? objectKind : [objectKind];
  if (!acceptedKinds.includes(object.objectKind)) {
    throw new Error(`run snapshot Library object kind mismatch for ${objectKey}: expected ${acceptedKinds.join(" or ")}, got ${object.objectKind}`);
  }
  return object;
}

function rejectCredentialLookingState(state: Record<string, unknown>, objectKey: string): void {
  visitCredentialValues(state, objectKey);
}

function visitCredentialValues(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitCredentialValues(item, `${path}.${index}`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") rejectCredentialLookingText(value, path);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const sensitiveReferenceMetadata = sensitiveReferenceMetadataStatus(key, child);
    if (sensitiveReferenceMetadata === "valid") continue;
    if (sensitiveReferenceMetadata === "invalid") {
      throw new Error(`credential-looking Library reference metadata is forbidden: ${path}.${key}`);
    }
    if (child !== null && child !== undefined && isCredentialValueKey(key)) {
      throw new Error(`credential-looking Library state is forbidden: ${path}.${key}`);
    }
    visitCredentialValues(child, `${path}.${key}`);
  }
}

function isCredentialValueKey(key: string): boolean {
  const normalized = key.replaceAll(/[^A-Za-z0-9]+/g, "").toLowerCase();
  return isNormalizedCredentialValueKey(normalized);
}

function sensitiveReferenceMetadataStatus(key: string, value: unknown): "valid" | "invalid" | undefined {
  const normalized = key.replaceAll(/[^A-Za-z0-9]+/g, "").toLowerCase();
  const suffix = normalized.endsWith("refs") ? "refs" : normalized.endsWith("ref") ? "ref" : undefined;
  if (!suffix) return undefined;
  const baseKey = normalized.slice(0, -suffix.length);
  if (!isNormalizedCredentialValueKey(baseKey)) return undefined;
  if (value === null || value === undefined) return undefined;
  if (suffix === "ref") {
    return typeof value === "string" && isNamespacedLibraryRef(value) ? "valid" : "invalid";
  }
  return Array.isArray(value) && value.every((ref) => typeof ref === "string" && isNamespacedLibraryRef(ref))
    ? "valid"
    : "invalid";
}

function isNamespacedLibraryRef(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*[.:][A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value);
}

function isNormalizedCredentialValueKey(normalized: string): boolean {
  return [
    "secretaccesskey",
    "apikey",
    "clientsecret",
    "refreshtoken",
    "bearertoken",
    "accesstoken",
    "authtoken",
    "password",
    "privatekey",
    "secretvalue",
    "credentials",
    "credential",
    "secret",
    "token",
  ].some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}

function rejectCredentialLookingText(value: string, path: string): void {
  if (
    /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})(?:$|[^A-Za-z0-9])/i.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /:\/\/[^/\s:@]+:[^@\s/]+@/.test(value)
    || /(?:^|\n)[A-Z0-9_]*(?:TOKEN|API_KEY|PASSWORD|SECRET|PRIVATE_KEY)\s*=\s*(?![$<{])\S{8,}/i.test(value)
  ) {
    throw new Error(`credential-looking Library value is forbidden: ${path}`);
  }
}

function stringField(state: Record<string, unknown>, field: string): string | undefined {
  const value = state[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultSkillAssetBundlePath(objectKey: string): string | undefined {
  if (!objectKey.startsWith("skill.")) return undefined;
  const slug = objectKey.slice("skill.".length).replaceAll(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  return `library/skills/${slug}`;
}

async function readSkillBundleFiles(
  libraryRoot: string | undefined,
  assetBundlePath: string | undefined,
): Promise<NonNullable<RunLibrarySnapshotObjectV1["bundleFiles"]>> {
  if (!libraryRoot || !assetBundlePath) return [];
  const root = resolve(libraryRoot);
  const bundleRoot = resolve(root, assetBundlePath.replace(/^library\//, ""));
  if (!isWithinRoot(bundleRoot, root)) {
    throw new Error(`skill asset bundle escapes library root: ${assetBundlePath}`);
  }
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink()) throw new Error(`skill asset library root must not be a symlink: ${libraryRoot}`);
    if (!rootInfo.isDirectory()) return [];
    const bundleInfo = await lstat(bundleRoot);
    if (bundleInfo.isSymbolicLink()) throw new Error(`skill asset bundle root must not be a symlink: ${assetBundlePath}`);
    if (!bundleInfo.isDirectory()) return [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const realLibraryRoot = await realpath(root);
  const realBundleRoot = await realpath(bundleRoot);
  if (!isWithinRoot(realBundleRoot, realLibraryRoot)) {
    throw new Error(`skill asset bundle escapes real library root: ${assetBundlePath}`);
  }
  return await collectSkillBundleFiles(realBundleRoot, realBundleRoot, realLibraryRoot, { totalBytes: 0 });
}

async function collectSkillBundleFiles(
  directory: string,
  root: string,
  libraryRoot: string,
  size: { totalBytes: number },
): Promise<NonNullable<RunLibrarySnapshotObjectV1["bundleFiles"]>> {
  const files: NonNullable<RunLibrarySnapshotObjectV1["bundleFiles"]> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = join(directory, entry.name);
    const entryInfo = await lstat(absolutePath);
    if (entry.isSymbolicLink() || entryInfo.isSymbolicLink()) {
      throw new Error(`skill asset bundle contains symlink: ${relative(root, absolutePath)}`);
    }
    const realEntryPath = await realpath(absolutePath);
    if (!isWithinRoot(realEntryPath, libraryRoot) || !isWithinRoot(realEntryPath, root)) {
      throw new Error(`skill asset bundle entry escapes library root: ${relative(root, absolutePath)}`);
    }
    if (entryInfo.isDirectory()) {
      files.push(...await collectSkillBundleFiles(realEntryPath, root, libraryRoot, size));
      continue;
    }
    if (!entryInfo.isFile()) continue;
    const relativePath = relative(root, realEntryPath).split(/[\\/]+/g).join("/");
    if (entryInfo.size > RUN_LIBRARY_SNAPSHOT_MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`skill bundle file too large: ${relativePath}`);
    }
    size.totalBytes += entryInfo.size;
    if (size.totalBytes > RUN_LIBRARY_SNAPSHOT_MAX_BUNDLE_TOTAL_BYTES) {
      throw new Error(`skill bundle total too large: ${size.totalBytes} bytes`);
    }
    const content = await readFile(realEntryPath);
    rejectCredentialLookingText(content.toString("utf8"), relativePath);
    files.push({
      relativePath,
      contentBase64: content.toString("base64"),
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function snapshotHashForPayload(
  snapshot: Omit<RunLibrarySnapshotV1, "snapshotHash">,
): string {
  const { createdAt: _createdAt, ...semanticSnapshot } = snapshot;
  return contentHashForPayload(semanticSnapshot);
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

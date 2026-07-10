import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SouthstarDb } from "../db/postgres.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { LibraryDefinitionKind } from "../design-library/types.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type RunLibrarySnapshotV1 = {
  schemaVersion: "southstar.run_library_snapshot.v1";
  runId: string;
  goalContractHash: string;
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
  goalContractHash: string;
  manifestHash: string;
  selectedRefs: string[];
  libraryVersionRefs: string[];
  libraryRoot?: string;
};

export async function captureRunLibrarySnapshotPg(
  db: SouthstarDb,
  input: CaptureRunLibrarySnapshotInput,
): Promise<RunLibrarySnapshotV1> {
  return await db.tx((tx) => captureRunLibrarySnapshotInTransaction(tx, input));
}

async function captureRunLibrarySnapshotInTransaction(
  db: SouthstarDb,
  input: CaptureRunLibrarySnapshotInput,
): Promise<RunLibrarySnapshotV1> {
  if (!await db.maybeOne("select id from southstar.workflow_runs where id = $1 for update", [input.runId])) {
    throw new Error(`workflow run not found for Library snapshot: ${input.runId}`);
  }
  if (await getResourceByKeyPg(db, "run_library_snapshot", input.runId)) {
    throw new Error(`run Library snapshot already exists: ${input.runId}`);
  }
  const expectedVersions = new Set(input.libraryVersionRefs);
  const objects: RunLibrarySnapshotObjectV1[] = [];
  for (const objectKey of [...new Set(input.selectedRefs)].sort()) {
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
    if (!expectedVersions.has(row.head_version_id)) {
      throw new Error(`selected Library version mismatch for ${objectKey}: ${row.head_version_id}`);
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
  const capturedVersions = new Set(objects.map((object) => object.versionRef));
  for (const versionRef of expectedVersions) {
    if (!capturedVersions.has(versionRef)) {
      throw new Error(`selected Library version has no captured object: ${versionRef}`);
    }
  }

  const snapshotWithoutHash = {
    schemaVersion: "southstar.run_library_snapshot.v1" as const,
    runId: input.runId,
    goalContractHash: input.goalContractHash,
    manifestHash: input.manifestHash,
    objects,
    createdAt: new Date().toISOString(),
  };
  const snapshot: RunLibrarySnapshotV1 = {
    ...snapshotWithoutHash,
    snapshotHash: contentHashForPayload(snapshotWithoutHash),
  };
  await upsertRuntimeResourcePg(db, {
    id: `run-library-snapshot:${input.runId}`,
    resourceType: "run_library_snapshot",
    resourceKey: input.runId,
    runId: input.runId,
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
  return snapshot;
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
  if (snapshotHash !== contentHashForPayload(snapshotWithoutHash)) {
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
    if (/(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|private[_-]?key|secret|secret[_-]?value|token)$/i.test(key)) {
      throw new Error(`credential-looking Library state is forbidden: ${path}.${key}`);
    }
    visitCredentialValues(child, `${path}.${key}`);
  }
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
    if (!(await stat(bundleRoot)).isDirectory()) return [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return await collectSkillBundleFiles(bundleRoot, bundleRoot);
}

async function collectSkillBundleFiles(
  directory: string,
  root: string,
): Promise<NonNullable<RunLibrarySnapshotObjectV1["bundleFiles"]>> {
  const files: NonNullable<RunLibrarySnapshotObjectV1["bundleFiles"]> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSkillBundleFiles(absolutePath, root));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolutePath);
    const relativePath = relative(root, absolutePath).split(/[\\/]+/g).join("/");
    rejectCredentialLookingText(content.toString("utf8"), relativePath);
    files.push({
      relativePath,
      contentBase64: content.toString("base64"),
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

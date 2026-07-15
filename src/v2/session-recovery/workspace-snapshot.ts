import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { SouthstarDb } from "../db/postgres.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg, type RuntimeResourceRecord } from "../stores/postgres-runtime-store.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = "southstar.workspace_snapshot.v1";

export async function captureWorkspaceSnapshotForTaskPg(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; attemptId: string; projectRoot?: string },
): Promise<{ resourceKey: string; status: string } | null> {
  const row = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [input.runId],
  );
  const runtimeContext = asRecord(row?.runtime_context_json);
  const projectRoot = input.projectRoot ?? stringValue(runtimeContext.projectRoot) ?? stringValue(runtimeContext.cwd);
  if (!projectRoot) return null;

  const resourceKey = `workspace_snapshot:${input.runId}:${input.taskId}:${input.attemptId}`;
  const now = new Date().toISOString();
  try {
    const repoRoot = await git(projectRoot, ["rev-parse", "--show-toplevel"]);
    const commitSha = await git(repoRoot, ["rev-parse", "HEAD"]);
    const statusPorcelain = await git(repoRoot, ["status", "--porcelain"]);
    const cleanAtCapture = statusPorcelain.length === 0;
    const status = cleanAtCapture ? "captured" : "skipped";
    await upsertRuntimeResourcePg(db, {
      resourceType: "workspace_snapshot",
      resourceKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: "workspace",
      status,
      title: cleanAtCapture ? "Git workspace snapshot" : "Git workspace snapshot skipped",
      payload: {
        schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
        provider: "git",
        repoRoot,
        commitSha,
        cleanAtCapture,
        statusPorcelain,
        capturedAt: now,
      },
      summary: cleanAtCapture
        ? { provider: "git", commitSha }
        : { provider: "git", commitSha, reason: "workspace dirty before task start" },
    });
    return { resourceKey, status };
  } catch (caught) {
    try {
      const filesystem = await captureFilesystemFingerprint(projectRoot);
      await upsertRuntimeResourcePg(db, {
        resourceType: "workspace_snapshot",
        resourceKey,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "workspace",
        status: "captured",
        title: "Filesystem workspace snapshot",
        payload: {
          schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
          provider: "filesystem",
          projectRoot,
          rootHash: filesystem.rootHash,
          fileCount: filesystem.fileCount,
          samplePaths: filesystem.samplePaths,
          cleanAtCapture: false,
          evidenceOnly: true,
          gitError: caught instanceof Error ? caught.message : String(caught),
          capturedAt: now,
        },
        summary: {
          provider: "filesystem",
          rootHash: filesystem.rootHash,
          fileCount: filesystem.fileCount,
          reason: "project is not a Git repository; snapshot is evidence-only",
        },
      });
      return { resourceKey, status: "captured" };
    } catch (filesystemError) {
      await upsertRuntimeResourcePg(db, {
        resourceType: "workspace_snapshot",
        resourceKey,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "workspace",
        status: "skipped",
        title: "Workspace snapshot skipped",
        payload: {
          schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
          provider: "none",
          projectRoot,
          error: caught instanceof Error ? caught.message : String(caught),
          filesystemError: filesystemError instanceof Error ? filesystemError.message : String(filesystemError),
          capturedAt: now,
        },
        summary: { provider: "none", reason: "Git and filesystem snapshots unavailable" },
      });
      return { resourceKey, status: "skipped" };
    }
  }
}

export async function restoreWorkspaceSnapshotPg(
  db: SouthstarDb,
  input: { runId: string; taskId: string; workspaceSnapshotRef: string },
): Promise<{ provider: "git" | "none"; action: "restored" | "skipped"; reason?: string }> {
  const resource = await getResourceByKeyPg(db, "workspace_snapshot", input.workspaceSnapshotRef);
  if (!resource || resource.runId !== input.runId || resource.taskId !== input.taskId) {
    throw new Error(`workspace snapshot not found: ${input.workspaceSnapshotRef}`);
  }
  const payload = asRecord(resource.payload);
  if (payload.provider !== "git" || payload.cleanAtCapture !== true) {
    return { provider: "none", action: "skipped", reason: "snapshot is evidence-only or not clean-at-capture" };
  }
  const repoRoot = requireString(payload.repoRoot, "workspace snapshot repoRoot");
  const commitSha = requireString(payload.commitSha, "workspace snapshot commitSha");
  const actualRoot = await git(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (actualRoot !== repoRoot) throw new Error(`workspace snapshot repo root mismatch: ${actualRoot} !== ${repoRoot}`);
  await git(repoRoot, ["reset", "--hard", commitSha]);
  await git(repoRoot, ["clean", "-fd"]);
  return { provider: "git", action: "restored" };
}

export function usableWorkspaceSnapshotRefs(resources: Array<Pick<RuntimeResourceRecord, "resourceType" | "resourceKey" | "status">>): string[] {
  return resources
    .filter((resource) => resource.resourceType === "workspace_snapshot" && ["available", "captured", "created", "succeeded"].includes(resource.status))
    .map((resource) => resource.resourceKey);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

const GENERATED_WORKSPACE_SEGMENTS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".pnpm",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const MAX_FINGERPRINT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FINGERPRINT_FILES = 10_000;

async function captureFilesystemFingerprint(projectRoot: string): Promise<{
  rootHash: string;
  fileCount: number;
  samplePaths: string[];
}> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  await walkFilesystem(projectRoot, projectRoot, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const rootHash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    rootHash,
    fileCount: files.length,
    samplePaths: files.slice(0, 200).map((file) => file.path),
  };
}

async function walkFilesystem(
  projectRoot: string,
  directory: string,
  files: Array<{ path: string; size: number; sha256: string }>,
): Promise<void> {
  if (files.length >= MAX_FINGERPRINT_FILES) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (files.length >= MAX_FINGERPRINT_FILES || GENERATED_WORKSPACE_SEGMENTS.has(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFilesystem(projectRoot, absolutePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await lstat(absolutePath);
    const content = stat.size <= MAX_FINGERPRINT_FILE_BYTES ? await readFile(absolutePath) : undefined;
    const sha256 = createHash("sha256")
      .update(content ?? `${stat.size}:${stat.mtimeMs}`)
      .digest("hex");
    files.push({ path: relative(projectRoot, absolutePath), size: stat.size, sha256 });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`missing ${label}`);
  return result;
}

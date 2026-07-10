import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SouthstarDb } from "../db/postgres.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg, type RuntimeResourceRecord } from "../stores/postgres-runtime-store.ts";

const execFileAsync = promisify(execFile);
const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = "southstar.workspace_snapshot.v1";

export async function captureWorkspaceSnapshotForTaskPg(
  db: SouthstarDb,
  input: { runId: string; taskId: string; sessionId: string; attemptId: string },
): Promise<{ resourceKey: string; status: string } | null> {
  const row = await db.maybeOne<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [input.runId],
  );
  const runtimeContext = asRecord(row?.runtime_context_json);
  const projectRoot = stringValue(runtimeContext.projectRoot) ?? stringValue(runtimeContext.cwd);
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
    await upsertRuntimeResourcePg(db, {
      resourceType: "workspace_snapshot",
      resourceKey,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: "workspace",
      status: "skipped",
      title: "Git workspace snapshot skipped",
      payload: {
        schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
        provider: "git",
        projectRoot,
        error: caught instanceof Error ? caught.message : String(caught),
        capturedAt: now,
      },
      summary: { provider: "git", reason: "git snapshot unavailable" },
    });
    return { resourceKey, status: "skipped" };
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

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { appendHistoryEvent } from "../../stores/history-store.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type WorktreePayload = { repoRoot: string; taskId?: string; snapshotRef?: string; previewId?: string };
type WorktreeCommand = SouthstarCommandRequest<WorktreePayload> & { runId: string };

export function createWorktreeSnapshotCommand(db: SouthstarDb, input: WorktreeCommand): SouthstarCommandResult {
  ensureRunForEvent(db, input.runId);
  const repoRoot = safeRepo(input.payload.repoRoot);
  const commitSha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const diff = git(repoRoot, ["diff", "--binary"]);
  const resource = upsertRuntimeResource(db, {
    id: input.commandId,
    resourceType: "worktree_snapshot",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.payload.taskId,
    scope: "workspace",
    status: "created",
    title: "Worktree snapshot",
    payload: { repoRoot, commitSha, dirtyPatch: diff, reason: input.reason ?? "operator snapshot" },
  });
  const event = appendEvent(db, input.runId, input.payload.taskId, "worktree.snapshot.created", input.commandId);
  return accepted(input.commandId, input.runId, input.payload.taskId, [resource.id], [String(event.sequence)], "Snapshot created.");
}

export function previewWorktreeRollbackCommand(db: SouthstarDb, input: WorktreeCommand): SouthstarCommandResult {
  ensureRunForEvent(db, input.runId);
  const repoRoot = safeRepo(input.payload.repoRoot);
  const snapshot = findResourcePayload(db, input.payload.snapshotRef, "worktree_snapshot") as { commitSha?: string } | undefined;
  if (!snapshot?.commitSha) return rejectedCommand(input.commandId, "Select an existing worktree snapshot before previewing rollback.");
  const diffNameStatus = git(repoRoot, ["diff", "--name-status"]);
  const resource = upsertRuntimeResource(db, {
    id: input.commandId,
    resourceType: "worktree_rollback_preview",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.payload.taskId,
    scope: "workspace",
    status: "previewed",
    title: "Rollback preview",
    payload: { repoRoot, snapshotRef: input.payload.snapshotRef, commitSha: snapshot.commitSha, diffNameStatus, riskChecks: ["preview-id-required", "repo-root-absolute"] },
  });
  const event = appendEvent(db, input.runId, input.payload.taskId, "worktree.rollback.previewed", input.commandId);
  return accepted(input.commandId, input.runId, input.payload.taskId, [resource.id], [String(event.sequence)], "Review preview before rollback.");
}

export function rollbackWorktreeCommand(db: SouthstarDb, input: WorktreeCommand): SouthstarCommandResult {
  ensureRunForEvent(db, input.runId);
  const repoRoot = safeRepo(input.payload.repoRoot);
  const preview = findResourcePayload(db, input.payload.previewId, "worktree_rollback_preview") as { repoRoot?: string; commitSha?: string } | undefined;
  if (!preview?.commitSha) return rejectedCommand(input.commandId, "Rollback requires a Southstar rollback preview id.");
  if (resolve(preview.repoRoot ?? "") !== repoRoot) return rejectedCommand(input.commandId, "Rollback preview repoRoot does not match command repoRoot.");
  git(repoRoot, ["checkout", "--", "."]);
  const resource = upsertRuntimeResource(db, {
    id: input.commandId,
    resourceType: "worktree_rollback",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.payload.taskId,
    scope: "workspace",
    status: "applied",
    title: "Rollback applied",
    payload: { repoRoot, previewId: input.payload.previewId, commitSha: preview.commitSha },
  });
  const event = appendEvent(db, input.runId, input.payload.taskId, "worktree.rollback.applied", input.commandId);
  return accepted(input.commandId, input.runId, input.payload.taskId, [resource.id], [String(event.sequence)], "Rollback applied.");
}

function safeRepo(repoRoot: string): string {
  const resolved = resolve(repoRoot);
  git(resolved, ["rev-parse", "--show-toplevel"]);
  return resolved;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function findResourcePayload(db: SouthstarDb, ref: string | undefined, resourceType: string): unknown {
  if (!ref) return undefined;
  const row = db.prepare("select payload_json from runtime_resources where resource_type = ? and (id = ? or resource_key = ?)").get(resourceType, ref, ref) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) : undefined;
}

function appendEvent(db: SouthstarDb, runId: string, taskId: string | undefined, eventType: string, commandId: string) {
  ensureRunForEvent(db, runId);
  return appendHistoryEvent(db, { runId, taskId, eventType, actorType: "user", payload: { commandId } });
}

function ensureRunForEvent(db: SouthstarDb, runId: string): void {
  const exists = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (exists) return;
  const now = new Date().toISOString();
  db.prepare(`insert into workflow_runs (id,status,domain,goal_prompt,executor_job_id,workflow_manifest_json,execution_projection_json,snapshot_json,runtime_context_json,metrics_json,created_at,updated_at,completed_at) values (?, 'running', 'software', '', null, '{"tasks":[]}', '{}', '{}', '{}', '{}', ?, ?, null)`).run(runId, now, now);
}

function accepted(commandId: string, runId: string, taskId: string | undefined, resourceRefs: string[], eventRefs: string[], next: string): SouthstarCommandResult {
  return { commandId, accepted: true, status: "applied", affectedRunId: runId, affectedTaskId: taskId, resourceRefs, eventRefs, nextSuggestedActions: [next] };
}

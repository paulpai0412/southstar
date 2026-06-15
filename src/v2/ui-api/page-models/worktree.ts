import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listResources } from "../../stores/resource-store.ts";

export function buildWorktreePageModel(db: SouthstarDb, input: { runId?: string } = {}) {
  const byRun = (resource: { runId?: string | null }) => !input.runId || resource.runId === input.runId;
  const snapshots = listResources(db, { resourceType: "worktree_snapshot" }).filter(byRun);
  const rollbackPreviews = listResources(db, { resourceType: "worktree_rollback_preview" }).filter(byRun);
  const rollbacks = listResources(db, { resourceType: "worktree_rollback" }).filter(byRun);
  return {
    surface: "southstar.ui.worktree.v1" as const,
    runId: input.runId ?? null,
    snapshots: snapshots.map((resource) => ({ id: resource.id, status: resource.status, taskId: resource.taskId, payload: resource.payload, createdAt: resource.createdAt })),
    rollbackPreviews: rollbackPreviews.map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload, createdAt: resource.createdAt })),
    rollbacks: rollbacks.map((resource) => ({ id: resource.id, status: resource.status, payload: resource.payload, createdAt: resource.createdAt })),
    safetyChecks: [
      { label: "Preview required", passed: rollbackPreviews.length > 0 },
      { label: "Git workspace snapshots", passed: snapshots.length > 0 },
    ],
    executorMountStatus: "workspace snapshots are Southstar truth; executor mounts are projection only",
    actions: ["create-snapshot", "rollback-preview", "rollback-workspace", "download-patch"],
  };
}

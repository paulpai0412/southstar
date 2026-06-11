import { commandSpec } from "../platform/process.ts";
import { normalizeRuntimePath } from "../platform/paths.ts";

export function planMainSync(input: {
  projectRoot: string;
  syncWorktreeDir: string;
  baseBranch: string;
  syncWorktreeExists?: boolean;
}) {
  const worktreePath = normalizeRuntimePath(input.projectRoot, input.syncWorktreeDir);
  const mode = input.syncWorktreeExists ? "reuse" : "create";
  return {
    mode,
    worktreePath,
    commands: [
      ...(input.syncWorktreeExists
        ? [
            commandSpec("git", ["-C", worktreePath, "status", "--porcelain"]),
            commandSpec("git", ["-C", worktreePath, "fetch", "origin", input.baseBranch]),
            commandSpec("git", ["-C", worktreePath, "merge", "--ff-only", `origin/${input.baseBranch}`]),
          ]
        : [
            commandSpec("git", ["-C", input.projectRoot, "fetch", "origin", input.baseBranch]),
            commandSpec("git", ["-C", input.projectRoot, "worktree", "add", "--detach", worktreePath, `origin/${input.baseBranch}`]),
          ]),
    ],
    failureHistory(last_error: string) {
      return {
        event_type: "effect_failed_retryable",
        payload: {
          effect_type: "local_main_sync",
          status: "failed",
          last_error,
          projection_target: "local_main_sync",
        },
      };
    },
    repairHistory() {
      return {
        event_type: "admin_action",
        payload: {
          action: "repair_sync_worktree",
          worktree_path: worktreePath,
        },
      };
    },
  };
}

export function planWorktreeCleanup(worktreePath: string) {
  return {
    type: "worktree_cleanup",
    command: commandSpec("git", ["worktree", "remove", worktreePath]),
  };
}

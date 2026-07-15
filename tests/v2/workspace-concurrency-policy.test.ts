import test from "node:test";
import assert from "node:assert/strict";
import {
  decideWorkspaceClaim,
  type WorkspaceTaskConcurrencyState,
} from "../../src/v2/workspace/concurrency-policy.ts";

function task(
  id: string,
  workspaceMutation?: WorkspaceTaskConcurrencyState["workspaceMutation"],
): WorkspaceTaskConcurrencyState {
  return { id, status: "running", workspaceMutation };
}

test("read-only tasks can run in parallel with another read-only task", () => {
  const decision = decideWorkspaceClaim(
    task("read-b", { mode: "read_only", resourceKeys: ["catalog"] }),
    [task("read-a", { mode: "read_only", resourceKeys: ["catalog"] })],
  );

  assert.deepEqual(decision, { allowed: true, strategy: "parallel_read" });
});

test("shared writes are serialized when they address the same workspace resource", () => {
  const decision = decideWorkspaceClaim(
    task("write-b", { mode: "shared_write", resourceKeys: ["documents"] }),
    [task("write-a", { mode: "shared_write", resourceKeys: ["documents"] })],
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.strategy, "serialized_write");
  assert.match(decision.reason ?? "", /documents/);
});

test("append-only tasks can run in parallel when their namespaces are disjoint", () => {
  const decision = decideWorkspaceClaim(
    task("append-b", { mode: "append_only", resourceKeys: ["events:b"] }),
    [task("append-a", { mode: "append_only", resourceKeys: ["events:a"] })],
  );

  assert.deepEqual(decision, { allowed: true, strategy: "parallel_append" });
});

test("append-only tasks are serialized when their namespace overlaps a writer", () => {
  const decision = decideWorkspaceClaim(
    task("append-b", { mode: "append_only", resourceKeys: ["events"] }),
    [task("write-a", { mode: "shared_write", resourceKeys: ["events"] })],
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.strategy, "serialized_write");
});

test("Git worktree writers can run in parallel when declared resource boundaries are disjoint", () => {
  const decision = decideWorkspaceClaim(
    task("write-b", { mode: "shared_write", isolation: "git_worktree", resourceKeys: ["src/b"] }),
    [task("write-a", { mode: "shared_write", isolation: "git_worktree", resourceKeys: ["src/a"] })],
  );

  assert.deepEqual(decision, { allowed: true, strategy: "parallel_isolated" });
});

test("Git worktree writers still serialize when their declared boundaries overlap", () => {
  const decision = decideWorkspaceClaim(
    task("write-b", { mode: "shared_write", isolation: "git_worktree", resourceKeys: ["src/shared"] }),
    [task("write-a", { mode: "shared_write", isolation: "git_worktree", resourceKeys: ["src/shared"] })],
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.strategy, "serialized_write");
});

test("legacy tasks without mutation metadata retain existing scheduler behavior", () => {
  const decision = decideWorkspaceClaim(task("legacy"), [task("other", { mode: "shared_write" })]);

  assert.deepEqual(decision, { allowed: true, strategy: "legacy_unclassified" });
});

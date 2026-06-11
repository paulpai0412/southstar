import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine, runEngineCommandCycle } from "../../src/runtime/engine.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { createOwnerLease, newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import type { HistoryEntry, IssueSnapshot } from "../../src/types/control-plane.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml"));
const now = "2026-05-29T03:00:00.000Z";

test("engine cycle loads active issues, commits state, then executes effects", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    store.createIssue(newIssueSnapshot("engine-1", {
      lifecycle_state: "running",
      owner_lease: createOwnerLease({
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "issue_worker",
        now,
        ttl_seconds: 180,
      }),
      stage_cursor: "implementation",
    }));
    const executionOrder: string[] = [];
    const engine = new RuntimeEngine({
      store,
      workflow,
      collectEvents: (_snapshot, recentHistory) => {
        assert.deepEqual(recentHistory, []);
        return [{
        type: "projection_result",
        projection_target: "label",
        status: "failed",
        attempt: 1,
        last_error: "rate limited",
        next_retry_at: "2026-05-29T03:05:00.000Z",
        payload: { labels: ["northstar:running"] },
      }];
      },
      executeEffects: (effects) => {
        executionOrder.push(`effects-after-history-${store.listHistory("engine-1").length}`);
        return effects.map((effect) => ({
          event_type: "effect_result",
          payload: { idempotency_key: effect.idempotency_key, status: "ok" },
        }));
      },
    });

    const result = engine.cycle();

    assert.equal(result.processedIssues, 1);
    assert.deepEqual(executionOrder, ["effects-after-history-1"]);
    assert.equal(store.getIssue("engine-1").lifecycle_state, "running");
    assert.equal(store.listHistory("engine-1").at(-1)?.event_type, "effect_result");
  } finally {
    store.close();
    await cleanup();
  }
});

test("engine cycle passes recent issue history to event collector", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const issue = store.createIssue(newIssueSnapshot("engine-history-1", {
      lifecycle_state: "running",
      owner_lease: createOwnerLease({
        lease_id: "lease-history-1",
        root_session_id: "root-history-1",
        role: "issue_worker",
        now,
        ttl_seconds: 180,
      }),
      stage_cursor: "implementation",
    }));
    store.recordIdempotentHistory(issue.id, {
      event_type: "runtime_event",
      payload: { idempotency_key: "fact-1", fact: "child-running" },
    });
    const observedFacts: unknown[] = [];
    const engine = new RuntimeEngine({
      store,
      workflow,
      collectEvents: (_snapshot, recentHistory) => {
        observedFacts.push(...recentHistory.map((entry) => entry.payload.fact));
        return [];
      },
      executeEffects: () => [],
    });

    engine.cycle();

    assert.deepEqual(observedFacts, ["child-running"]);
  } finally {
    store.close();
    await cleanup();
  }
});

test("engine does not execute effects when DB commit fails", () => {
  let effectExecutions = 0;
  const failingStore = fakeEngineStore({
    appendHistoryBatchAndUpdateSnapshot() {
      throw new Error("commit failed");
    },
  });
  const engine = new RuntimeEngine({
    store: failingStore,
    workflow,
    collectEvents: () => [{
      type: "projection_result",
      projection_target: "label",
      status: "failed",
      last_error: "rate limited",
      next_retry_at: "2026-05-29T03:05:00.000Z",
    }],
    executeEffects: () => {
      effectExecutions += 1;
      return [];
    },
  });

  assert.throws(() => engine.cycle(), /commit failed/);
  assert.equal(effectExecutions, 0);
});

test("engine records retryable history when effect execution throws after commit", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    store.createIssue(newIssueSnapshot("engine-effect-failure-1", {
      lifecycle_state: "running",
      owner_lease: createOwnerLease({
        lease_id: "lease-effect-failure-1",
        root_session_id: "root-effect-failure-1",
        role: "issue_worker",
        now,
        ttl_seconds: 180,
      }),
      stage_cursor: "implementation",
    }));
    const engine = new RuntimeEngine({
      store,
      workflow,
      collectEvents: () => [{
        type: "projection_result",
        projection_target: "label",
        status: "failed",
        last_error: "rate limited",
        next_retry_at: "2026-05-29T03:05:00.000Z",
      }],
      executeEffects: () => {
        throw new Error("effect worker failed");
      },
    });

    engine.cycle();

    assert.equal(store.getIssue("engine-effect-failure-1").lifecycle_state, "running");
    assert.equal(store.listHistory("engine-effect-failure-1").at(-1)?.event_type, "effect_failed_retryable");
    assert.equal(store.listHistory("engine-effect-failure-1").at(-1)?.payload.last_error, "effect worker failed");
  } finally {
    store.close();
    await cleanup();
  }
});

test("engine smoke cycle claims an issue, starts a child, records artifact, and reaches verification", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const host = new FakeHostAdapter();
    store.createIssue(newIssueSnapshot("issue-smoke"));

    const claim = runEngineCommandCycle({
      store,
      workflow,
      host,
      now,
      command: { type: "start", issue_id: "issue-smoke" },
    });

    assert.equal(claim.snapshot.lifecycle_state, "running");
    assert.equal(claim.snapshot.runtime_context_json.child_runs?.length, 1);

    const artifact = runEngineCommandCycle({
      store,
      workflow,
      host,
      now,
      command: {
        type: "child_artifact",
        issue_id: "issue-smoke",
        child_run_id: claim.snapshot.runtime_context_json.child_runs?.[0]?.child_run_id ?? "missing",
        status: "succeeded",
      },
    });

    assert.equal(artifact.snapshot.lifecycle_state, "verifying");
    assert.equal(
      store.listHistory("issue-smoke").some((row) => row.event_type === "child_artifact_received"),
      true,
    );
  } finally {
    store.close();
    await cleanup();
  }
});

function fakeEngineStore(overrides: Partial<SqliteControlPlaneStore>): SqliteControlPlaneStore {
  const snapshot = newIssueSnapshot("engine-fake-1", {
    lifecycle_state: "running",
    owner_lease: createOwnerLease({
      lease_id: "lease-fake-1",
      root_session_id: "root-fake-1",
      role: "issue_worker",
      now,
      ttl_seconds: 180,
    }),
    stage_cursor: "implementation",
  });
  const base = {
    listActiveIssues: () => [snapshot],
    listRecentHistory: (_issueId: string) => [] as HistoryEntry[],
    appendHistoryBatchAndUpdateSnapshot: (_issueId: string, _history: HistoryEntry[], _snapshot: IssueSnapshot) => ({ historyCount: 1 }),
    recordIdempotentHistory: (_issueId: string, _history: HistoryEntry) => ({ historyId: 1, historySequence: 1 }),
  };

  return { ...base, ...overrides } as SqliteControlPlaneStore;
}

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "northstar-engine-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));

  return {
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

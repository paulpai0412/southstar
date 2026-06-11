import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { createOwnerLease, newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("initialization creates exactly issues and issue_history tables", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    assert.deepEqual(store.listRuntimeTables().sort(), ["issue_history", "issues"]);
  } finally {
    store.close();
    await cleanup();
  }
});

test("open creates parent directories for runtime database path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-store-parent-"));
  const dbPath = join(dir, ".northstar", "runtime", "control-plane.sqlite3");
  const store = SqliteControlPlaneStore.open(dbPath);
  try {
    assert.deepEqual(store.listRuntimeTables().sort(), ["issue_history", "issues"]);
    assert.equal((await stat(join(dir, ".northstar", "runtime"))).isDirectory(), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("history is written before snapshot update in one transaction", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const issue = store.createIssue(newIssueSnapshot("store-1"));
    const result = store.appendHistoryAndUpdateSnapshot(issue.id, {
      event_type: "owner_lease_acquired",
      payload: { lease_id: "lease-1" },
    }, newIssueSnapshot("store-1", { lifecycle_state: "claimed" }));

    assert.equal(result.historySequence, 1);
    assert.equal(store.listHistory(issue.id)[0].event_type, "owner_lease_acquired");
    assert.equal(store.getIssue(issue.id).lifecycle_state, "claimed");
  } finally {
    store.close();
    await cleanup();
  }
});

test("snapshot failure rolls back staged history", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const issue = store.createIssue(newIssueSnapshot("store-2"));

    assert.throws(() => store.appendHistoryAndUpdateSnapshot(issue.id, {
      event_type: "owner_lease_acquired",
      payload: { lease_id: "lease-1" },
    }, { ...newIssueSnapshot("store-2"), lifecycle_state: "not-a-state" }));

    assert.equal(store.listHistory(issue.id).length, 0);
    assert.equal(store.getIssue(issue.id).lifecycle_state, "ready");
  } finally {
    store.close();
    await cleanup();
  }
});

test("idempotent command/effect result recording returns existing history row", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const issue = store.createIssue(newIssueSnapshot("store-3"));
    const first = store.recordIdempotentHistory(issue.id, {
      event_type: "effect_result",
      payload: { idempotency_key: "effect-1", status: "failed" },
    });
    const second = store.recordIdempotentHistory(issue.id, {
      event_type: "effect_result",
      payload: { idempotency_key: "effect-1", status: "failed-again" },
    });

    assert.equal(second.historyId, first.historyId);
    assert.equal(store.listHistory(issue.id).length, 1);
  } finally {
    store.close();
    await cleanup();
  }
});

test("upsertIssuePacket does not duplicate unchanged intake history", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const packet = {
      issue_number: "25",
      title: "Browser follow-up",
      source: "github" as const,
      source_url: "https://github.test/owner/repo/issues/25",
      branch: "northstar/25",
      base_branch: "main",
      labels: ["northstar:ready"],
      dependencies: ["24"],
      raw_text: "Enhance browser app",
      ready_for_agent: true,
    };

    store.upsertIssuePacket(packet);
    store.upsertIssuePacket({ ...packet });

    assert.deepEqual(store.listHistory("github:25").map((entry) => entry.event_type), ["intake_packet"]);
  } finally {
    store.close();
    await cleanup();
  }
});

test("upsertIssuePacket records changed intake packet as update", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const packet = {
      issue_number: "26",
      title: "Browser follow-up",
      source: "github" as const,
      source_url: "https://github.test/owner/repo/issues/26",
      branch: "northstar/26",
      base_branch: "main",
      labels: ["northstar:ready"],
      dependencies: [],
      raw_text: "Initial body",
      ready_for_agent: true,
    };

    store.upsertIssuePacket(packet);
    store.upsertIssuePacket({ ...packet, raw_text: "Updated body" });

    assert.deepEqual(store.listHistory("github:26").map((entry) => entry.event_type), ["intake_packet", "intake_packet_updated"]);
    assert.equal(store.getIssue("github:26").runtime_context_json.issue_packet?.raw_text, "Updated body");
  } finally {
    store.close();
    await cleanup();
  }
});

test("failed effect result recording is idempotent by idempotency key", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const issue = store.createIssue(newIssueSnapshot("store-failed-effect"));
    const first = store.recordIdempotentHistory(issue.id, {
      event_type: "effect_failed_retryable",
      payload: {
        idempotency_key: "effect-1:failed",
        effect_id: "effect-1",
        last_error: "network timeout",
      },
    });
    const second = store.recordIdempotentHistory(issue.id, {
      event_type: "effect_failed_retryable",
      payload: {
        idempotency_key: "effect-1:failed",
        effect_id: "effect-1",
        last_error: "network timeout",
      },
    });

    assert.equal(second.historyId, first.historyId);
    assert.equal(store.listHistory(issue.id).length, 1);
  } finally {
    store.close();
    await cleanup();
  }
});

test("issue snapshots persist runtime context and history rows persist compact payload", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const ownerLease = createOwnerLease({
      lease_id: "lease-store-4",
      root_session_id: "root-store-4",
      role: "issue_worker",
      now: "2026-05-29T03:00:00.000Z",
      ttl_seconds: 180,
    });
    const issue = store.createIssue(newIssueSnapshot("store-4", {
      lifecycle_state: "running",
      owner_lease: ownerLease,
      stage_cursor: "implementation",
    }));

    store.recordIdempotentHistory(issue.id, {
      event_type: "effect_result",
      payload: {
        idempotency_key: "effect-store-4",
        effect_type: "projection_retry",
        status: "failed",
      },
    });

    assert.deepEqual(store.getIssue(issue.id).runtime_context_json.owner_lease, ownerLease);
    assert.deepEqual(store.listHistory(issue.id)[0].payload, {
      idempotency_key: "effect-store-4",
      effect_type: "projection_retry",
      status: "failed",
    });
  } finally {
    store.close();
    await cleanup();
  }
});

test("active issue listing only returns active lifecycle states", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    for (const state of ["ready", "claimed", "running", "verifying", "verified", "release_pending", "releasing", "exception", "completed", "cancelled", "failed", "quarantined"]) {
      store.createIssue(newIssueSnapshot(`store-active-${state}`, { lifecycle_state: state }));
    }

    assert.deepEqual(
      store.listActiveIssues().map((issue) => issue.lifecycle_state),
      ["claimed", "running", "verifying", "releasing"],
    );
  } finally {
    store.close();
    await cleanup();
  }
});

test("recent history returns newest relevant facts in chronological order", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const issue = store.createIssue(newIssueSnapshot("store-5"));
    for (const index of [1, 2, 3]) {
      store.recordIdempotentHistory(issue.id, {
        event_type: "runtime_event",
        payload: { idempotency_key: `event-${index}`, index },
      });
    }

    assert.deepEqual(
      store.listRecentHistory(issue.id, 2).map((entry) => entry.payload.index),
      [2, 3],
    );
  } finally {
    store.close();
    await cleanup();
  }
});

test("dashboard issue listing returns every snapshot in stable issue order", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    store.createIssue(newIssueSnapshot("github:2", { lifecycle_state: "running" }));
    store.createIssue(newIssueSnapshot("github:10", { lifecycle_state: "ready" }));
    store.createIssue(newIssueSnapshot("github:abc", { lifecycle_state: "ready" }));
    store.createIssue(newIssueSnapshot("github:1abc", { lifecycle_state: "ready" }));
    store.createIssue(newIssueSnapshot("local:a", { lifecycle_state: "ready" }));

    assert.deepEqual(
      store.listIssues().map((issue) => issue.issue_id),
      ["github:2", "github:10", "github:1abc", "github:abc", "local:a"],
    );
  } finally {
    store.close();
    await cleanup();
  }
});

test("dashboard history map returns issue histories keyed by issue id", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const first = store.createIssue(newIssueSnapshot("github:1"));
    const second = store.createIssue(newIssueSnapshot("github:2"));
    store.recordIdempotentHistory(first.id, {
      event_type: "runtime_event",
      payload: { idempotency_key: "first-event", value: "one" },
    });
    store.recordIdempotentHistory(second.id, {
      event_type: "runtime_event",
      payload: { idempotency_key: "second-event", value: "two" },
    });

    const histories = store.listHistoriesByIssueId(["github:1", "github:2"]);

    assert.equal(histories.get("github:1")?.[0].payload.value, "one");
    assert.equal(histories.get("github:2")?.[0].payload.value, "two");
  } finally {
    store.close();
    await cleanup();
  }
});

async function createTempStore() {
  const dir = await mkdtemp(join(tmpdir(), "northstar-store-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));

  return {
    store,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

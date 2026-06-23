import test from "node:test";
import assert from "node:assert/strict";
import type { QueryResultRow } from "pg";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { recordRuntimeCommandPg } from "../../src/v2/ui-api/commands/runtime-command.ts";
import {
  createWorkflowRunPg,
  getResourceByKeyPg,
  listHistoryForRunPg,
  listResourcesPg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("recordRuntimeCommandPg writes an idempotent command resource and history events", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-command-contract",
      status: "running",
      domain: "software",
      goalPrompt: "runtime command contract",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });

    const input = {
      commandId: "cmd-pause-1",
      runId: "run-command-contract",
      taskId: "task-a",
      sessionId: "session-a",
      action: "run.pause",
      actor: { type: "user", id: "operator-a" },
      reason: "operator pauses scheduling",
      status: "applied",
      resourceRefs: [{ resourceType: "workflow_run", resourceKey: "run-command-contract" }],
      eventType: "run.paused",
      eventPayload: { fromStatus: "running", toStatus: "paused" },
    } as const;

    const first = await recordRuntimeCommandPg(db, input);
    const second = await recordRuntimeCommandPg(db, input);

    assert.equal(first.commandId, "cmd-pause-1");
    assert.equal(first.status, "applied");
    assert.equal(first.accepted, true);
    assert.deepEqual(second, first);

    const commands = await listResourcesPg(db, { resourceType: "runtime_command" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.runId, "run-command-contract");
    assert.equal(commands[0]?.resourceKey, "cmd-pause-1");
    assert.equal(commands[0]?.status, "applied");

    const history = await listHistoryForRunPg(db, "run-command-contract");
    assert.equal(history.filter((event) => event.eventType === "run.command_requested").length, 1);
    assert.equal(history.filter((event) => event.eventType === "run.paused").length, 1);
  } finally {
    await db.close();
  }
});

test("recordRuntimeCommandPg returns the stored result when a racing duplicate uses divergent input", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db, "run-command-race");
    const raceDb = forceTwoInitialRuntimeCommandMisses(db, "cmd-race-1");
    const firstInput = {
      commandId: "cmd-race-1",
      runId: "run-command-race",
      taskId: "task-a",
      sessionId: "session-a",
      action: "run.pause",
      actor: { type: "user", id: "operator-a" },
      reason: "operator pauses scheduling",
      status: "applied",
      resourceRefs: [{ resourceType: "workflow_run", resourceKey: "run-command-race" }],
      eventType: "run.paused",
      eventPayload: { fromStatus: "running", toStatus: "paused" },
    } as const;
    const divergentInput = {
      ...firstInput,
      action: "run.cancel",
      reason: "operator cancels scheduling",
      status: "rejected",
      eventType: "run.cancelled",
      eventPayload: { fromStatus: "running", toStatus: "cancelled" },
    } as const;

    const [first, second] = await Promise.all([
      recordRuntimeCommandPg(raceDb, firstInput),
      recordRuntimeCommandPg(raceDb, divergentInput),
    ]);

    assert.equal(first.status, "applied");
    assert.deepEqual(second, first);

    const command = await getResourceByKeyPg(db, "runtime_command", "cmd-race-1");
    assert.equal(command?.status, "applied");
    assert.deepEqual(command?.payload.result, first);

    const history = await listHistoryForRunPg(db, "run-command-race");
    assert.equal(history.filter((event) => event.eventType === "run.command_requested").length, 1);
    assert.equal(history.filter((event) => event.eventType === "run.paused").length, 1);
    assert.equal(history.filter((event) => event.eventType === "run.cancelled").length, 0);
  } finally {
    await db.close();
  }
});

async function seedRun(db: SouthstarDb, runId: string): Promise<void> {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "runtime command contract",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
}

function forceTwoInitialRuntimeCommandMisses(db: SouthstarDb, commandId: string): SouthstarDb {
  let misses = 0;
  let txCount = 0;
  let firstMiss: (() => void) | undefined;
  const firstMissObserved = new Promise<void>((resolve) => {
    firstMiss = resolve;
  });
  let secondMayContinue: (() => void) | undefined;
  const secondWaitsForFirstCommit = new Promise<void>((resolve) => {
    secondMayContinue = resolve;
  });

  return {
    ...db,
    async tx<T>(fn: (tx: SouthstarDb) => Promise<T>): Promise<T> {
      return await db.tx(async (tx) => {
        const txIndex = txCount;
        txCount += 1;
        const wrappedTx: SouthstarDb = {
          ...tx,
          async maybeOne<TRecord extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
            const row = await tx.maybeOne<TRecord>(sql, params);
            if (isRuntimeCommandLookup(sql, params, commandId) && row === null) {
              misses += 1;
              if (txIndex === 0) {
                firstMiss?.();
              } else if (txIndex === 1) {
                await firstMissObserved;
                await secondWaitsForFirstCommit;
              }
            }
            return row;
          },
        };
        const result = await fn(wrappedTx);
        if (txIndex === 0) secondMayContinue?.();
        return result;
      });
    },
  };
}

function isRuntimeCommandLookup(sql: string, params: unknown[], commandId: string): boolean {
  return sql.includes("southstar.runtime_resources")
    && sql.includes("resource_type = $1")
    && sql.includes("resource_key = $2")
    && params[0] === "runtime_command"
    && params[1] === commandId;
}

import test from "node:test";
import assert from "node:assert/strict";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import type { RuntimeServerContext } from "../../src/v2/server/runtime-context.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime health exposes current Library readiness", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertRuntimeResourcePg(db, {
      resourceType: "library_readiness",
      resourceKey: "library-readiness:current",
      scope: "runtime",
      status: "ready",
      title: "Current Library readiness",
      payload: {
        schemaVersion: "southstar.library_readiness.v1",
        ready: true,
        status: "ready",
        snapshotHash: "abc123",
        sourceRoot: "/workspace/southstar/library",
        reconciledAt: "2026-07-13T00:00:00.000Z",
        trigger: "startup",
        includedCount: 2,
        excludedCount: 1,
        diagnostics: [],
      },
      summary: "ready",
      metrics: { included: 2, excluded: 1 },
    });
    const response = await handleRuntimeRoute(context(db), new Request("http://127.0.0.1/api/v2/runtime/health"));
    assert.equal(response.status, 200);
    const envelope = await response.json() as { result: { library: { ready: boolean; snapshotHash: string; includedCount: number; excludedCount: number } } };
    assert.deepEqual(envelope.result.library, {
      ready: true,
      status: "ready",
      snapshotHash: "abc123",
      includedCount: 2,
      excludedCount: 1,
      diagnostics: [],
    });
  } finally {
    await db.close();
  }
});

function context(db: RuntimeServerContext["db"]): RuntimeServerContext {
  return {
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
  };
}

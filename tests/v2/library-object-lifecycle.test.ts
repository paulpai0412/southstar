import assert from "node:assert/strict";
import test from "node:test";
import { applyLibraryObjectLifecycleAction } from "../../src/v2/design-library/lifecycle/library-object-lifecycle.ts";
import { findLibraryObjectByKey, listLibraryEdges, upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("approves a draft library object and records lifecycle audit resource", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "skill.browser-verification",
      objectKind: "skill_spec",
      status: "draft",
      headVersionId: "skill.browser-verification@abc123",
      state: { title: "Browser Verification", scope: "software" },
    });

    const result = await applyLibraryObjectLifecycleAction(db, {
      objectKey: "skill.browser-verification",
      action: "approve",
      actor: "operator",
      reason: "validated in local workflow",
    });

    assert.equal(result.object.status, "approved");
    assert.equal(result.object.state.status, "approved");
    const persisted = await findLibraryObjectByKey(db, "skill.browser-verification");
    assert.equal(persisted?.status, "approved");
    assert.equal(persisted?.state.status, "approved");

    const audit = await db.one<{
      resource_type: string;
      scope: string;
      status: string;
      payload_json: { action: string; objectKey: string; reason: string };
    }>(
      `select resource_type, scope, status, payload_json
         from southstar.runtime_resources
        where resource_type = 'library_lifecycle_event'
          and resource_key = $1`,
      [result.auditResourceKey],
    );
    assert.equal(audit.resource_type, "library_lifecycle_event");
    assert.equal(audit.scope, "library");
    assert.equal(audit.status, "created");
    assert.equal(audit.payload_json.action, "approve");
    assert.equal(audit.payload_json.objectKey, "skill.browser-verification");
    assert.equal(audit.payload_json.reason, "validated in local workflow");
  } finally {
    await db.close();
  }
});

test("deprecating an evaluator deactivates all validation edges immediately", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "artifact.lifecycle-report",
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.lifecycle-report@v1",
      state: { title: "Lifecycle Report", scope: "general", artifactType: "report" },
    });
    await upsertLibraryObject(db, {
      objectKey: "evaluator.lifecycle-report",
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: "evaluator.lifecycle-report@v1",
      state: { title: "Lifecycle Report Evaluator", scope: "general" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "evaluator.lifecycle-report",
      fromVersionRef: "evaluator.lifecycle-report@v1",
      edgeType: "validates_artifact",
      toObjectKey: "artifact.lifecycle-report",
      toVersionRef: "artifact.lifecycle-report@v1",
      scope: "general",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "evaluator.lifecycle-report",
      fromVersionRef: "evaluator.lifecycle-report@v1",
      edgeType: "validates",
      toObjectKey: "artifact.lifecycle-report",
      toVersionRef: "artifact.lifecycle-report@v1",
      scope: "general",
    });

    await applyLibraryObjectLifecycleAction(db, {
      objectKey: "evaluator.lifecycle-report",
      action: "deprecate",
      actor: "operator",
      reason: "retired evaluator contract",
    });

    const edges = await db.query<{ edge_type: string; status: string }>(
      `select edge_type, status
         from southstar.library_edges
        where from_object_key = $1
        order by edge_type`,
      ["evaluator.lifecycle-report"],
    );
    assert.deepEqual(edges.rows, [
      { edge_type: "validates", status: "inactive" },
      { edge_type: "validates_artifact", status: "inactive" },
    ]);
  } finally {
    await db.close();
  }
});

test("approving a deprecated object fails until it is edited into a new draft version", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "tool.browser",
      objectKind: "tool_definition",
      status: "deprecated",
      headVersionId: "tool.browser@old",
      state: { title: "Browser", scope: "global" },
    });

    await assert.rejects(
      applyLibraryObjectLifecycleAction(db, {
        objectKey: "tool.browser",
        action: "approve",
        actor: "operator",
        reason: "restore old object",
      }),
      /cannot approve deprecated object without a new draft version/,
    );
  } finally {
    await db.close();
  }
});

test("approving uses the current row at transaction time rather than stale pre-read status", async () => {
  const db = await createTestPostgresDb();
  try {
    const objectKey = "skill.concurrent-review";
    await upsertLibraryObject(db, {
      objectKey,
      objectKind: "skill_spec",
      status: "draft",
      headVersionId: "skill.concurrent-review@draft",
      state: { title: "Concurrent Review", scope: "software" },
    });

    const dbWithConcurrentDeprecation = withBeforeTxHook(db, async () => {
      await db.query(
        `update southstar.library_objects
            set status = 'deprecated',
                updated_at = now()
          where object_key = $1`,
        [objectKey],
      );
    });

    await assert.rejects(
      applyLibraryObjectLifecycleAction(dbWithConcurrentDeprecation, {
        objectKey,
        action: "approve",
        actor: "operator",
        reason: "approve after concurrent review",
      }),
      /cannot approve deprecated object without a new draft version/,
    );

    assert.equal((await findLibraryObjectByKey(db, objectKey))?.status, "deprecated");
  } finally {
    await db.close();
  }
});

test("library object lifecycle route invokes service and requires a nonblank reason", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.frontend-developer",
      objectKind: "agent_definition",
      status: "draft",
      headVersionId: "agent.frontend-developer@draft",
      state: { title: "Frontend Developer", scope: "software" },
    });

    const response = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/objects/agent.frontend-developer/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "approved from operator review" }),
      }),
    );

    assert.equal(response.status, 200);
    const approved = await readEnvelope(response);
    assert.equal(approved.kind, "library-object-lifecycle");
    assert.equal(approved.result.object.status, "approved");

    const audit = await db.one<{ payload_json: { actor: string; action: string; reason: string } }>(
      `select payload_json
         from southstar.runtime_resources
        where resource_type = 'library_lifecycle_event'
          and resource_key = $1`,
      [approved.result.auditResourceKey],
    );
    assert.equal(audit.payload_json.actor, "operator");
    assert.equal(audit.payload_json.action, "approve");
    assert.equal(audit.payload_json.reason, "approved from operator review");

    const blankReason = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/objects/agent.frontend-developer/deprecate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "   " }),
      }),
    );

    assert.equal(blankReason.status, 400);
    const error = await readEnvelope(blankReason);
    assert.equal(error.ok, false);
    assert.match(error.error, /reason is required/);
  } finally {
    await db.close();
  }
});

test("library object lifecycle route deprecates and blocks objects", async () => {
  const db = await createTestPostgresDb();
  try {
    const cases = [
      { action: "deprecate", nextStatus: "deprecated" },
      { action: "block", nextStatus: "blocked" },
    ] as const;

    for (const { action, nextStatus } of cases) {
      const objectKey = `skill.route-${action}`;
      await upsertLibraryObject(db, {
        objectKey,
        objectKind: "skill_spec",
        status: "draft",
        headVersionId: `${objectKey}@draft`,
        state: { title: `Route ${action}`, scope: "software" },
      });

      const response = await handleRuntimeRoute(
        { db } as any,
        new Request(`http://local/api/v2/library/objects/${objectKey}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actor: "library-reviewer",
            reason: `${action} from route review`,
          }),
        }),
      );

      assert.equal(response.status, 200);
      const result = await readEnvelope(response);
      assert.equal(result.kind, "library-object-lifecycle");
      assert.equal(result.result.object.objectKey, objectKey);
      assert.equal(result.result.object.status, nextStatus);
      assert.equal(result.result.object.state.status, nextStatus);
      const persisted = await findLibraryObjectByKey(db, objectKey);
      assert.equal(persisted?.status, nextStatus);
      assert.equal(persisted?.state.status, nextStatus);

      const audit = await db.one<{ payload_json: { actor: string; action: string; objectKey: string; reason: string } }>(
        `select payload_json
           from southstar.runtime_resources
          where resource_type = 'library_lifecycle_event'
            and resource_key = $1`,
        [result.result.auditResourceKey],
      );
      assert.equal(audit.payload_json.actor, "library-reviewer");
      assert.equal(audit.payload_json.action, action);
      assert.equal(audit.payload_json.objectKey, objectKey);
      assert.equal(audit.payload_json.reason, `${action} from route review`);
    }
  } finally {
    await db.close();
  }
});

test("library object delete route removes the object and cascades incident edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.frontend-developer",
      objectKind: "agent_definition",
      status: "approved",
      state: { title: "Frontend Developer", scope: "software" },
    });
    await upsertLibraryObject(db, {
      objectKey: "skill.react-ui",
      objectKind: "skill_spec",
      status: "approved",
      state: { title: "React UI", scope: "software" },
    });
    await upsertLibraryObject(db, {
      objectKey: "tool.browser",
      objectKind: "tool_definition",
      status: "approved",
      state: { title: "Browser", scope: "software" },
    });
    await upsertLibraryObject(db, {
      objectKey: "tool.playwright",
      objectKind: "tool_definition",
      status: "approved",
      state: { title: "Playwright", scope: "software" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "requires_skill",
      toObjectKey: "skill.react-ui",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "requires_tool",
      toObjectKey: "tool.browser",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "tool.browser",
      edgeType: "uses",
      toObjectKey: "tool.playwright",
      scope: "software",
    });

    const response = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/objects/skill.react-ui", { method: "DELETE" }),
    );

    assert.equal(response.status, 200);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.kind, "library-object-delete");
    assert.equal(envelope.result.deletedObjectKey, "skill.react-ui");
    assert.equal(envelope.result.deletedObjectCount, 1);
    assert.equal(envelope.result.inboundEdgeCount, 1);
    assert.equal(envelope.result.outboundEdgeCount, 1);
    assert.equal(envelope.result.deletedEdgeCount, 2);
    assert.equal(await findLibraryObjectByKey(db, "skill.react-ui"), null);
    assert.deepEqual(
      (await listLibraryEdges(db)).map((edge) => [edge.fromObjectKey, edge.edgeType, edge.toObjectKey]),
      [["tool.browser", "uses", "tool.playwright"]],
    );

    const missing = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/objects/skill.react-ui", { method: "DELETE" }),
    );
    assert.equal(missing.status, 404);
    const error = await readEnvelope(missing);
    assert.equal(error.ok, false);
    assert.match(error.error, /library object not found: skill\.react-ui/);
  } finally {
    await db.close();
  }
});

async function readEnvelope(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

function withBeforeTxHook(db: SouthstarDb, beforeTx: () => Promise<void>): SouthstarDb {
  return {
    query: db.query.bind(db),
    one: db.one.bind(db),
    maybeOne: db.maybeOne.bind(db),
    async tx<T>(fn: (tx: SouthstarDb) => Promise<T>): Promise<T> {
      await beforeTx();
      return await db.tx(fn);
    },
    close: db.close.bind(db),
  };
}

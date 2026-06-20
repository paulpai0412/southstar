import test from "node:test";
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { intakeWorkItemPg, linkRunAttemptFromWorkItemPg } from "../../src/v2/work-items/intake-service.ts";
import { getWorkItemPg } from "../../src/v2/work-items/postgres-work-items.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("work item intake dedupes external source and preserves metadata", async () => {
  const db = await createTestPostgresDb();
  try {
    const first = await intakeWorkItemPg(db, {
      sourceProvider: "github",
      sourceScope: "owner/repo",
      sourceRef: "owner/repo#123",
      sourceUrl: "https://github.com/owner/repo/issues/123",
      title: "Fix callback completion",
      body: "The run completes too early.",
      domain: "software",
      priority: "high",
      labels: ["runtime"],
      requestedBy: "operator",
      metadata: { externalSeverity: "sev2" },
    });
    const second = await intakeWorkItemPg(db, {
      sourceProvider: "github",
      sourceScope: "owner/repo",
      sourceRef: "owner/repo#123",
      sourceUrl: "https://github.com/owner/repo/issues/123-updated",
      title: "Fix callback completion updated",
      body: "Updated body.",
      domain: "software",
      priority: "urgent",
      labels: ["runtime", "callback"],
      requestedBy: "operator-2",
      metadata: { externalSeverity: "sev1" },
    });

    assert.equal(first.workItemId, second.workItemId);
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);

    const record = await getWorkItemPg(db, first.workItemId);
    assert.equal(record?.title, "Fix callback completion updated");
    assert.equal(record?.status, "active");
    assert.equal(record?.sourceUrl, "https://github.com/owner/repo/issues/123-updated");
    assert.equal(record?.metadata.body, "Updated body.");
    assert.equal(record?.metadata.sourceScope, "owner/repo");
    assert.equal(record?.metadata.sourceUrl, "https://github.com/owner/repo/issues/123-updated");
    assert.equal(record?.metadata.priority, "urgent");
    assert.deepEqual(record?.metadata.labels, ["runtime", "callback"]);
    assert.equal(record?.metadata.requestedBy, "operator-2");
    assert.equal(record?.metadata.externalSeverity, "sev1");
    assert.equal(record?.metadata.triageState, "ready");
  } finally {
    await db.close();
  }
});

test("work item intake defaults optional metadata and marks blank bodies for triage", async () => {
  const db = await createTestPostgresDb();
  try {
    const intake = await intakeWorkItemPg(db, {
      sourceProvider: "api",
      title: "Needs detail",
      body: "  ",
      domain: "software",
    });

    assert.equal(intake.deduped, false);
    assert.equal(intake.status, "waiting");
    const record = await getWorkItemPg(db, intake.workItemId);
    assert.equal(record?.metadata.body, "  ");
    assert.equal(record?.metadata.priority, "normal");
    assert.deepEqual(record?.metadata.labels, []);
    assert.equal(record?.metadata.triageState, "needs_triage");
  } finally {
    await db.close();
  }
});

test("work item run attempt linkage writes richer run refs and runtime context", async () => {
  const db = await createTestPostgresDb();
  try {
    const intake = await intakeWorkItemPg(db, {
      sourceProvider: "api",
      sourceRef: "request-123",
      title: "Build feature",
      body: "Build the runtime feature.",
      domain: "software",
    });
    await createWorkflowRunPg(db, {
      id: "run-linked",
      status: "created",
      domain: "software",
      goalPrompt: "Build feature",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowRunPg(db, {
      id: "run-linked-retry",
      status: "created",
      domain: "software",
      goalPrompt: "Build feature retry",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({ existing: true }),
      metricsJson: "{}",
    });

    const firstRef = await linkRunAttemptFromWorkItemPg(db, {
      workItemId: intake.workItemId,
      runId: "run-linked",
      statusAtLink: "created",
      reason: "initial",
    });
    const secondRef = await linkRunAttemptFromWorkItemPg(db, {
      workItemId: intake.workItemId,
      runId: "run-linked-retry",
      statusAtLink: "created",
      reason: "retry",
    });

    assert.equal(firstRef.runAttempt, 1);
    assert.equal(secondRef.runAttempt, 2);
    assert.match(firstRef.createdAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const record = await getWorkItemPg(db, intake.workItemId);
    assert.equal(record?.runRefs.length, 2);
    assert.deepEqual(record?.runRefs.map((ref) => ({
      runId: ref.runId,
      runAttempt: ref.runAttempt,
      statusAtLink: ref.statusAtLink,
      reason: ref.reason,
    })), [
      { runId: "run-linked", runAttempt: 1, statusAtLink: "created", reason: "initial" },
      { runId: "run-linked-retry", runAttempt: 2, statusAtLink: "created", reason: "retry" },
    ]);

    const run = await db.one<{ runtime_context_json: Record<string, unknown> }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      ["run-linked-retry"],
    );
    assert.deepEqual(run.runtime_context_json, {
      existing: true,
      workItemRef: {
        workItemId: intake.workItemId,
        sourceProvider: "api",
        sourceRef: "request-123",
        runAttempt: 2,
        intakeVersion: "southstar.work_item_intake.v1",
      },
    });
  } finally {
    await db.close();
  }
});

test("work item run attempt linkage rejects missing work items and workflow runs", async () => {
  const db = await createTestPostgresDb();
  try {
    const intake = await intakeWorkItemPg(db, {
      sourceProvider: "api",
      title: "Build feature",
      body: "Build the runtime feature.",
      domain: "software",
    });

    await assert.rejects(
      () => linkRunAttemptFromWorkItemPg(db, {
        workItemId: "missing-work-item",
        runId: "missing-run",
        statusAtLink: "created",
        reason: "initial",
      }),
      /work item not found: missing-work-item/,
    );
    await assert.rejects(
      () => linkRunAttemptFromWorkItemPg(db, {
        workItemId: intake.workItemId,
        runId: "missing-run",
        statusAtLink: "created",
        reason: "initial",
      }),
      /workflow run not found: missing-run/,
    );
  } finally {
    await db.close();
  }
});

test("work item intake route validates required fields and defaults body", async () => {
  const db = await createTestPostgresDb();
  const server = await createSouthstarRuntimeServer({
    db,
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
  try {
    const missing = await fetch(`${server.url}/api/v2/work-items/intake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceProvider: "api", domain: "software" }),
    });
    assert.equal(missing.status, 400);
    const missingEnvelope = await missing.json() as { ok: false; error: string };
    assert.equal(missingEnvelope.error, "title is required");

    const result = await post<{ workItemId: string; status: string; deduped: boolean }>(
      server.url,
      "/api/v2/work-items/intake",
      {
        sourceProvider: "api",
        sourceRef: "route-request-1",
        title: "Route request",
        domain: "software",
        labels: ["route"],
      },
    );
    assert.equal(result.deduped, false);
    assert.equal(result.status, "waiting");
    const record = await getWorkItemPg(db, result.workItemId);
    assert.equal(record?.metadata.body, "");
    assert.deepEqual(record?.metadata.labels, ["route"]);
    assert.equal(record?.metadata.triageState, "needs_triage");
  } finally {
    await server.close();
    await db.close();
  }
});

async function post<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

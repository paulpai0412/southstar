import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E, createRealRuntimeServer, probeRealPostgresTorkPi, requireRealPostgresInfra } from "./postgres-real-harness.ts";

test("real Postgres/Tork/Pi matrix creates a run through canonical async APIs", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string; workflowId: string }>(server.url, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "real Postgres matrix: implement a bounded CLI feature with evidence" }),
    });
    assert.match(draft.draftId, /^draft-/);

    const run = await api<{ runId: string; taskIds: string[] }>(server.url, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    assert.equal(run.taskIds.includes("implement-feature"), true);

    const inspect = await api<{ data: { runId: string; status: string; tasks: unknown[]; resources: unknown[] } }>(
      server.url,
      `/api/v2/read-models/run-inspection/${encodeURIComponent(run.runId)}`,
    );
    assert.equal(inspect.data.runId, run.runId);
    assert.equal(inspect.data.tasks.length > 0, true);
    assert.equal(inspect.data.resources.length > 0, true);

    const envelope = await api<{ schemaVersion: string; contextPacket: { selectedKnowledgeCards: unknown[] } }>(
      server.url,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/tasks/implement-feature/envelope`,
    );
    assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
    assert.equal(Array.isArray(envelope.contextPacket.selectedKnowledgeCards), true);

    const runRow = await env.db.one<{ runtime_context_json: { draftId?: string }; workflow_manifest_json: { tasks?: unknown[] } }>(
      "select runtime_context_json, workflow_manifest_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runRow.runtime_context_json.draftId, draft.draftId);
    assert.equal(Array.isArray(runRow.workflow_manifest_json.tasks), true);
  } finally {
    await server.close();
    await env.close();
  }
});

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

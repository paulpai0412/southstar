import test from "node:test";
import assert from "node:assert/strict";
import { listHistoryForRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForPostgresRunStatus,
  waitForTorkJob,
} from "../postgres-real-harness.ts";
import { createRealRecoveryScheduler, latestHandExecutionForTask, waitForHandExecutionStatus } from "../recovery-scheduler-helpers.ts";

type TaskEnvelopeResourcePayload = {
  envelope?: {
    schemaVersion?: string;
    skills?: unknown[];
    toolProxyPolicy?: {
      allowedTools?: unknown[];
    };
    materializedLibraryRefs?: {
      instructionRefs?: unknown[];
      skillRefs?: unknown[];
      toolGrantRefs?: unknown[];
      mcpGrantRefs?: unknown[];
      vaultLeasePolicyRefs?: unknown[];
    };
  };
};

test("29 llm dynamic workflow materialization: task envelopes include materialized refs before callback completion", async () => {
  const checkpoint = (id: `CP${number}`, message: string) => {
    console.info(`[case29][${id}] ${message}`);
  };

  const infra = requireRealPostgresInfra();
  checkpoint("CP0", "infra env loaded");
  await probeRealPostgresTorkPi(infra);
  checkpoint("CP0", "infra probe passed");

  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({
        goalPrompt: "llm dynamic workflow materialization real E2E with task envelope library refs",
        orchestrationMode: "llm-constrained",
      }),
    });
    assert.match(draft.draftId, /^draft-wf-composed-/);
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    assert.equal(run.taskIds.length >= 4, true);
    checkpoint("CP1", `draft + run created: ${draft.draftId} -> ${run.runId}`);

    const draftResource = await env.db.one<{
      payload_json: {
        plannerTrace?: {
          composerMode?: string;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.payload_json.plannerTrace?.composerMode, "llm");
    checkpoint("CP2", "planner trace confirms llm composer mode");

    const taskProfiles = await env.db.query<{ id: string; snapshot_json: { agentProfileRef?: string } }>(
      "select id, snapshot_json from southstar.workflow_tasks where run_id = $1 order by sort_order",
      [run.runId],
    );
    const profileRefs = taskProfiles.rows.map((row) => row.snapshot_json.agentProfileRef).filter((value): value is string => typeof value === "string");
    assert.equal(profileRefs.includes("software-spec-reviewer-codex"), true);
    assert.equal(profileRefs.includes("software-code-quality-reviewer-codex"), true);
    const expectedTaskIds = taskProfiles.rows.map((row) => row.id);

    const execute = await api<{ runId: string; status: string; schedulerWakeRequested: true }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`,
      { method: "POST", body: "{}" },
    );
    assert.deepEqual(execute, { runId: run.runId, status: "scheduling", schedulerWakeRequested: true });
    checkpoint("CP3", "run moved to scheduling");

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
    });

    for (const taskId of expectedTaskIds) {
      const dispatch = await scheduler.runOnce({ runId: run.runId });
      assert.deepEqual(dispatch.dispatchedTaskIds, [taskId]);
      checkpoint("CP4", `task dispatched: ${taskId}`);

      const envelope = await latestTaskEnvelope(env.db, { runId: run.runId, taskId });
      assert.equal(envelope.envelope?.schemaVersion, "southstar.task-envelope.v2");
      assert.equal(Array.isArray(envelope.envelope?.skills), true);
      assert.equal(Array.isArray(envelope.envelope?.toolProxyPolicy?.allowedTools), true);
      assert.equal(Boolean(envelope.envelope?.materializedLibraryRefs), true);
      assert.equal(Array.isArray(envelope.envelope?.materializedLibraryRefs?.instructionRefs), true);
      assert.equal(Array.isArray(envelope.envelope?.materializedLibraryRefs?.skillRefs), true);
      assert.equal(Array.isArray(envelope.envelope?.materializedLibraryRefs?.toolGrantRefs), true);
      assert.equal(Array.isArray(envelope.envelope?.materializedLibraryRefs?.mcpGrantRefs), true);
      assert.equal(Array.isArray(envelope.envelope?.materializedLibraryRefs?.vaultLeasePolicyRefs), true);
      checkpoint("CP5", `materialized refs + policy present before callback: ${taskId}`);

      const hand = await latestHandExecutionForTask(env.db, { runId: run.runId, taskId });
      await waitForTorkJob(infra.torkBaseUrl, hand.externalJobId);
      const handStatus = await waitForHandExecutionStatus(env.db, hand.resourceKey, ["completed", "failed"]);
      assert.equal(handStatus, "completed");
      checkpoint("CP6", `task callback completed: ${taskId}`);
    }

    const runStatus = await waitForPostgresRunStatus(env.db, run.runId, ["passed", "failed"]);
    assert.equal(runStatus, "passed");
    const persisted = await persistedRunSurface(env.db, run.runId);
    assert.doesNotMatch(persisted, /plaintextSecret/i);
    checkpoint("CP7", "run passed and persisted surfaces contain no plaintextSecret");

    const history = await listHistoryForRunPg(env.db, run.runId);
    assert.equal(history.some((event) => event.eventType === "run.completed"), true);
  } finally {
    await server.close();
    await env.close();
  }
});

async function latestTaskEnvelope(
  db: Parameters<typeof createRealRecoveryScheduler>[0],
  input: { runId: string; taskId: string },
): Promise<TaskEnvelopeResourcePayload> {
  const row = await db.maybeOne<{ payload_json: TaskEnvelopeResourcePayload }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'task_envelope'
        and run_id = $1
        and task_id = $2
      order by created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId],
  );
  if (!row) {
    throw new Error(`task envelope missing for ${input.runId}/${input.taskId}`);
  }
  return row.payload_json;
}

async function persistedRunSurface(
  db: Parameters<typeof createRealRecoveryScheduler>[0],
  runId: string,
): Promise<string> {
  const resourceRows = await db.query<{ resource_type: string; payload_json: unknown; summary_json: unknown }>(
    `select resource_type, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1
      order by resource_type, resource_key`,
    [runId],
  );
  const historyRows = await db.query<{ event_type: string; payload_json: unknown }>(
    `select event_type, payload_json
       from southstar.workflow_history
      where run_id = $1
      order by sequence`,
    [runId],
  );
  return JSON.stringify({
    resources: resourceRows.rows,
    history: historyRows.rows,
  });
}

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

import test from "node:test";
import assert from "node:assert/strict";
import { listHistoryForRunPg, listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
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

test("28 llm-constrained workflow: planner draft composes reviewer tasks and run completes through real Tork/Pi callbacks", async () => {
  const checkpoint = (id: string, message: string) => {
    console.info(`[case28][${id}] ${message}`);
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
        goalPrompt: "llm constrained real E2E: generate software workflow with review checkpoints and complete end to end",
        orchestrationMode: "llm-constrained",
      }),
    });
    assert.match(draft.draftId, /^draft-wf-composed-/);
    checkpoint("CP1", `draft created: ${draft.draftId}`);

    const draftResource = await env.db.one<{
      summary_json: { planner?: string };
      payload_json: {
        orchestrationSnapshot?: {
          validation?: { ok?: boolean };
          candidateSummary?: { agentProfileRefs?: string[] };
        };
      };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "library-constrained-llm");
    assert.equal(draftResource.payload_json.orchestrationSnapshot?.validation?.ok, true);
    const profileRefs = draftResource.payload_json.orchestrationSnapshot?.candidateSummary?.agentProfileRefs ?? [];
    assert.equal(profileRefs.includes("profile.software-spec-reviewer-codex"), true);
    assert.equal(profileRefs.includes("profile.software-code-quality-reviewer-codex"), true);
    checkpoint("CP2", "draft snapshot validated with reviewer candidates");

    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    assert.equal(run.taskIds.length >= 4, true);
    checkpoint("CP3", `run created: ${run.runId}`);

    const taskProfiles = await env.db.query<{ id: string; snapshot_json: { agentProfileRef?: string } }>(
      "select id, snapshot_json from southstar.workflow_tasks where run_id = $1 order by sort_order",
      [run.runId],
    );
    const runProfileRefs = taskProfiles.rows.map((row) => row.snapshot_json.agentProfileRef).filter((value): value is string => typeof value === "string");
    assert.equal(runProfileRefs.includes("software-spec-reviewer-codex"), true);
    assert.equal(runProfileRefs.includes("software-code-quality-reviewer-codex"), true);
    const expectedTaskIds = taskProfiles.rows.map((row) => row.id);

    const runRow = await env.db.one<{ status: string }>(
      "select status from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runRow.status, "created");
    const contextCount = await env.db.one<{ count: number }>(
      "select count(*)::int as count from southstar.runtime_resources where run_id = $1 and resource_type = 'context_packet'",
      [run.runId],
    );
    assert.equal(contextCount.count, expectedTaskIds.length);
    checkpoint("CP4", "run/task/context initialization verified");

    const execute = await api<{ runId: string; status: string; schedulerWakeRequested: true }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`,
      { method: "POST", body: "{}" },
    );
    assert.deepEqual(execute, { runId: run.runId, status: "scheduling", schedulerWakeRequested: true });
    checkpoint("CP5", "run moved to scheduling");

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
    });
    for (let index = 0; index < expectedTaskIds.length; index += 1) {
      const taskId = expectedTaskIds[index]!;
      const dispatch = await scheduler.runOnce({ runId: run.runId });
      assert.deepEqual(dispatch.dispatchedTaskIds, [taskId]);
      checkpoint("CP6", `task dispatched: ${taskId}`);

      const hand = await latestHandExecutionForTask(env.db, { runId: run.runId, taskId });
      await waitForTorkJob(infra.torkBaseUrl, hand.externalJobId);
      const handStatus = await waitForHandExecutionStatus(env.db, hand.resourceKey, ["completed", "failed"]);
      assert.equal(handStatus, "completed");
      checkpoint("CP7", `task callback completed: ${taskId}`);
    }

    const tasks = await env.db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      [run.runId],
    );
    assert.deepEqual(tasks.rows.map((row) => row.id), expectedTaskIds);
    assert.equal(tasks.rows.every((row) => row.status === "completed"), true);
    checkpoint("CP8", "all workflow tasks completed");

    const runStatus = await waitForPostgresRunStatus(env.db, run.runId, ["passed", "failed"]);
    assert.equal(runStatus, "passed");
    checkpoint("CP9", "run reached passed terminal status");

    const history = await listHistoryForRunPg(env.db, run.runId);
    const callbackTaskIds = [...new Set(
      history
        .filter((event) => event.eventType === "executor.callback_received" && typeof event.taskId === "string")
        .map((event) => event.taskId as string),
    )].sort();
    assert.deepEqual(callbackTaskIds, [...expectedTaskIds].sort());
    assert.equal(history.some((event) => event.eventType === "run.completed"), true);
    const handExecutions = (await listResourcesPg(env.db, { resourceType: "hand_execution" }))
      .filter((resource) => resource.runId === run.runId);
    const inflight = handExecutions.filter((resource) => ["created", "queued", "running", "pending"].includes(resource.status));
    assert.equal(inflight.length, 0);
    checkpoint("CP10", "history + hand execution terminal integrity verified");
  } finally {
    await server.close();
    await env.close();
  }
});

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

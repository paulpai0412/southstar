import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForTorkJob,
} from "../postgres-real-harness.ts";

test("08 evolution sandbox: baseline and candidate execute through Postgres, Tork, and Pi", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "real sandbox replay: produce implementation evidence for a bounded software task" }),
    });
    const replayRun = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });

    const baselineAsset = await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed sandbox baseline prompt",
        assetKind: "prompt_template",
        assetRef: "sandbox.prompt",
        version: "v1",
        status: "active",
        payload: { prompt: "baseline" },
      }),
    });
    const candidateAsset = await api<{ assetId: string }>(server.port, "/api/v2/evolution/assets/register", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed sandbox candidate prompt",
        assetKind: "prompt_template",
        assetRef: "sandbox.prompt",
        version: "v2",
        parentVersion: "v1",
        status: "candidate",
        payload: { prompt: "candidate" },
      }),
    });

    const signalResult = await api<{ nodeIds: string[] }>(server.port, "/api/v2/evolution/signals", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "seed learning signals for sandbox delta",
        signals: [
          {
            signalKind: "artifact_repair",
            runId: replayRun.runId,
            taskId: replayRun.taskIds[0],
            scope: "software",
            intent: "implement_feature",
            roleRef: "software-maker",
            agentProfileRef: "software-maker-v1",
            artifactType: "implementation_result",
            failureKind: "missing_fields",
            missingFields: ["commandsRun", "testResults"],
            promptTemplateRef: "prompt-software-maker",
            sourceRefs: [replayRun.taskIds[0]],
            confidence: 0.9,
            successScore: 1,
          },
          {
            signalKind: "artifact_repair",
            runId: replayRun.runId,
            taskId: replayRun.taskIds[0],
            scope: "software",
            intent: "implement_feature",
            roleRef: "software-maker",
            agentProfileRef: "software-maker-v1",
            artifactType: "implementation_result",
            failureKind: "missing_fields",
            missingFields: ["commandsRun", "testResults"],
            promptTemplateRef: "prompt-software-maker",
            sourceRefs: [replayRun.taskIds[0]],
            confidence: 0.9,
            successScore: 1,
          },
        ],
      }),
    });
    assert.equal(signalResult.nodeIds.length, 2);

    const cards = await api<{ cardIds: string[] }>(server.port, "/api/v2/evolution/cards/synthesize", {
      method: "POST",
      body: JSON.stringify({ actor: "operator", reason: "synthesize card for sandbox delta", runId: replayRun.runId }),
    });
    assert.equal(cards.cardIds.length >= 1, true);

    const deltas = await api<{ deltaIds: string[] }>(server.port, "/api/v2/evolution/deltas/synthesize", {
      method: "POST",
      body: JSON.stringify({
        actor: "operator",
        reason: "create sandbox candidate delta",
        sourceCardRefs: [cards.cardIds[0]],
        targetRef: "sandbox.prompt",
        targetVersion: "v1",
      }),
    });
    assert.equal(deltas.deltaIds.length, 1);
    const deltaId = deltas.deltaIds[0]!;

    await api<{ deltaId: string; status: string }>(server.port, `/api/v2/evolution/deltas/${encodeURIComponent(deltaId)}/approve`, {
      method: "POST",
      body: JSON.stringify({ actor: "operator", reason: "sandbox-ready delta" }),
    });

    const experiment = await api<{ experimentId: string; decision: string; reasons: string[] }>(
      server.port,
      `/api/v2/evolution/deltas/${encodeURIComponent(deltaId)}/run-sandbox`,
      {
        method: "POST",
        body: JSON.stringify({
          actor: "operator",
          reason: "prepare real sandbox experiment",
          baselineAssetRefs: [baselineAsset.assetId],
          candidateAssetRefs: [candidateAsset.assetId],
          regressionSuiteRefs: ["software-core-regression"],
          replayRunRefs: [replayRun.runId],
          maxCostRegressionPercent: 25,
          maxDurationRegressionPercent: 30,
        }),
      },
    );
    assert.equal(experiment.decision, "queued");

    const callbackBase = dockerReachableUrl(server, infra);
    const started = await api<{
      experimentId: string;
      runs: {
        baseline: { runId: string; externalJobId: string; workspacePath: string };
        candidate: { runId: string; externalJobId: string; workspacePath: string };
      };
    }>(
      server.port,
      `/api/v2/evolution/experiments/${encodeURIComponent(experiment.experimentId)}/start`,
      {
        method: "POST",
        body: JSON.stringify({
          actor: "operator",
          reason: "execute sandbox baseline/candidate through real Tork and Pi",
          callbackUrl: `${callbackBase}/api/v2/tork/callback`,
          heartbeatUrl: `${callbackBase}/api/v2/executor/heartbeat`,
          runRoot: "/tmp/southstar-runs",
          harnessEndpoint: infra.piHarnessEndpoint,
        }),
      },
    );

    await waitForTorkJob(infra.torkBaseUrl, started.runs.baseline.externalJobId);
    await waitForTorkJob(infra.torkBaseUrl, started.runs.candidate.externalJobId);

    const callbackEvents = await env.db.query<{ run_id: string }>(
      "select run_id from southstar.workflow_history where event_type = 'executor.callback_received' and run_id = any($1::text[])",
      [[started.runs.baseline.runId, started.runs.candidate.runId]],
    );
    assert.equal(new Set(callbackEvents.rows.map((row) => row.run_id)).size, 2);

    await api<unknown>(
      server.port,
      `/api/v2/evolution/experiments/${encodeURIComponent(experiment.experimentId)}/evaluator-output`,
      {
        method: "POST",
        body: JSON.stringify({
          actor: "operator",
          reason: "record baseline sandbox evaluator output",
          variant: "baseline",
          caseRef: replayRun.runId,
          evaluatorResult: {
            ok: true,
            targetedReplayFixed: true,
            metrics: { durationMs: 1, tokens: 1, costMicrosUsd: 1, repairCount: 0, toolCalls: 1 },
          },
        }),
      },
    );

    const decision = await api<{ experimentId: string; decision: "passed" | "failed"; reasons: string[] } | null>(
      server.port,
      `/api/v2/evolution/experiments/${encodeURIComponent(experiment.experimentId)}/evaluator-output`,
      {
        method: "POST",
        body: JSON.stringify({
          actor: "operator",
          reason: "record candidate sandbox evaluator output",
          variant: "candidate",
          caseRef: replayRun.runId,
          evaluatorResult: {
            ok: true,
            targetedReplayFixed: true,
            metrics: { durationMs: 1, tokens: 1, costMicrosUsd: 1, repairCount: 0, toolCalls: 1 },
          },
        }),
      },
    );
    assert.equal(decision?.decision, "passed");

    const runs = await env.db.query<{ runtime_context_json: { runMode?: string; sandboxExperimentId?: string; sandboxVariant?: string } }>(
      "select runtime_context_json from southstar.workflow_runs where id = any($1::text[])",
      [[started.runs.baseline.runId, started.runs.candidate.runId]],
    );
    assert.equal(runs.rows.every((row) => row.runtime_context_json.runMode === "sandbox" && row.runtime_context_json.sandboxExperimentId === experiment.experimentId), true);
    assert.equal(new Set(runs.rows.map((row) => row.runtime_context_json.sandboxVariant)).size, 2);

    const experimentRow = await env.db.one<{ status: string }>(
      "select status from southstar.runtime_resources where resource_type = 'sandbox_experiment' and resource_key = $1",
      [experiment.experimentId],
    );
    assert.equal(experimentRow.status, "passed");
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

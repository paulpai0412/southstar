import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E, createRealRuntimeServer, dockerReachableUrl, probeRealPostgresTorkPi, requireRealPostgresInfra, waitForTorkJob } from "./postgres-real-harness.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { createAssetVersion } from "../../src/v2/evolution/assets.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSandboxExperiment, evaluateSandboxExperiment, recordSandboxTrial, startSandboxExecutionPg } from "../../src/v2/evolution/sandbox.ts";
import { TorkClient } from "../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";

test("real sandbox baseline and candidate execute through Postgres, Tork, and Pi", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const baselineAsset = await createAssetVersion(env.db, { assetKind: "prompt_template", assetRef: "sandbox.prompt", version: "v1", status: "active", payload: { prompt: "baseline" } });
    const candidateAsset = await createAssetVersion(env.db, { assetKind: "prompt_template", assetRef: "sandbox.prompt", version: "v2", parentVersion: "v1", status: "candidate", payload: { prompt: "candidate" } });
    const deltaId = "delta-real-sandbox-candidate";
    await createLearningNode(env.db, {
      id: deltaId,
      nodeType: "delta_proposal",
      scope: "evolution",
      status: "validated",
      payload: { id: deltaId, deltaKind: "prompt_delta", status: "validated", targetRef: "sandbox.prompt", targetVersion: "v1" },
      summaryText: "Real sandbox candidate delta",
    });

    const draft = await createPostgresPlannerDraft(env.db, { goalPrompt: "real sandbox replay: produce implementation evidence for a bounded software task" });
    const replayRun = await createPostgresRunFromDraft(env.db, { draftId: draft.draftId });
    const experiment = await createSandboxExperiment(env.db, {
      deltaProposalId: deltaId,
      baselineAssetRefs: [baselineAsset.id],
      candidateAssetRefs: [candidateAsset.id],
      regressionSuiteRefs: ["software-core-regression"],
      replayRunRefs: [replayRun.runId],
      maxCostRegressionPercent: 25,
      maxDurationRegressionPercent: 30,
    });

    const torkClient = new TorkClient({ baseUrl: infra.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
    const callbackBase = dockerReachableUrl(server, infra);
    const started = await startSandboxExecutionPg(env.db, {
      experimentId: experiment.experimentId,
      executorProvider: new TorkExecutorProvider({ torkClient }),
      callbackUrl: `${callbackBase}/api/v2/tork/callback`,
      heartbeatUrl: `${callbackBase}/api/v2/executor/heartbeat`,
      harnessEndpoint: infra.piHarnessEndpoint,
    });

    await waitForTorkJob(infra.torkBaseUrl, started.runs.baseline.externalJobId);
    await waitForTorkJob(infra.torkBaseUrl, started.runs.candidate.externalJobId);

    const callbackEvents = await env.db.query<{ run_id: string }>(
      "select run_id from southstar.workflow_history where event_type = 'executor.callback_received' and run_id = any($1::text[])",
      [[started.runs.baseline.runId, started.runs.candidate.runId]],
    );
    assert.equal(new Set(callbackEvents.rows.map((row) => row.run_id)).size, 2);

    await recordSandboxTrial(env.db, {
      experimentId: experiment.experimentId,
      variant: "baseline",
      caseRef: replayRun.runId,
      status: "passed",
      targetedReplayFixed: true,
      metrics: { durationMs: 1, tokens: 1, costMicrosUsd: 1, repairCount: 0, toolCalls: 1 },
    });
    await recordSandboxTrial(env.db, {
      experimentId: experiment.experimentId,
      variant: "candidate",
      caseRef: replayRun.runId,
      status: "passed",
      targetedReplayFixed: true,
      metrics: { durationMs: 1, tokens: 1, costMicrosUsd: 1, repairCount: 0, toolCalls: 1 },
    });
    const decision = await evaluateSandboxExperiment(env.db, experiment.experimentId);
    assert.equal(decision.decision, "passed");

    const runs = await env.db.query<{ runtime_context_json: { runMode?: string; sandboxExperimentId?: string; sandboxVariant?: string } }>(
      "select runtime_context_json from southstar.workflow_runs where id = any($1::text[])",
      [[started.runs.baseline.runId, started.runs.candidate.runId]],
    );
    assert.equal(runs.rows.every((row) => row.runtime_context_json.runMode === "sandbox" && row.runtime_context_json.sandboxExperimentId === experiment.experimentId), true);
    assert.equal(new Set(runs.rows.map((row) => row.runtime_context_json.sandboxVariant)).size, 2);
  } finally {
    await server.close();
    await env.close();
  }
});

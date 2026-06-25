import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SouthstarDb } from "../db/postgres.ts";
import { materializeTaskEnvelope } from "../agent-runner/materializer.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import type { ExecutorProvider } from "../executor/provider.ts";
import { withMaterializationMount } from "../executor/materialization-mount.ts";
import { piAgentConfigMount, piAgentRuntimeEnv } from "../executor/pi-agent-runtime.ts";
import { createExecutorBindingPg } from "../executor/postgres-bindings.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { appendHistoryEventPg, createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { buildContextPacketWithKnowledgeCards } from "../context/postgres-builder.ts";
import { getPostgresTaskEnvelope } from "../ui-api/postgres-task-envelope.ts";
import { createLearningEdge, createLearningNode } from "./learning-graph.ts";

export type SandboxExperimentInput = {
  deltaProposalId: string;
  baselineAssetRefs: string[];
  candidateAssetRefs: string[];
  regressionSuiteRefs: string[];
  replayRunRefs: string[];
  maxCostRegressionPercent: number;
  maxDurationRegressionPercent: number;
};

export type SandboxTrialInput = {
  experimentId: string;
  variant: "baseline" | "candidate";
  caseRef: string;
  status: "passed" | "failed" | "cancelled";
  targetedReplayFixed: boolean;
  metrics: {
    durationMs: number;
    tokens: number;
    costMicrosUsd: number;
    repairCount: number;
    toolCalls: number;
  };
};

export type SandboxDecision = {
  experimentId: string;
  decision: "passed" | "failed";
  reasons: string[];
};

export async function createSandboxExperiment(db: SouthstarDb, input: SandboxExperimentInput): Promise<{ experimentId: string }> {
  const delta = await db.maybeOne("select 1 from southstar.learning_nodes where id = $1 and node_type = 'delta_proposal'", [input.deltaProposalId]);
  if (!delta) throw new Error(`delta proposal not found: ${input.deltaProposalId}`);
  const experimentId = `exp-${hash(`${input.deltaProposalId}:${Date.now()}:${randomUUID()}`)}`;
  const payload = {
    id: experimentId,
    deltaProposalId: input.deltaProposalId,
    status: "queued",
    baselineAssetRefs: input.baselineAssetRefs,
    candidateAssetRefs: input.candidateAssetRefs,
    regressionSuiteRefs: input.regressionSuiteRefs,
    replayRunRefs: input.replayRunRefs,
    maxCostRegressionPercent: input.maxCostRegressionPercent,
    maxDurationRegressionPercent: input.maxDurationRegressionPercent,
    trials: [] as SandboxTrialInput[],
  };
  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
    ) values ($1, 'sandbox_experiment', $1, 'evolution', 'queued', $2, $3::jsonb, $4::jsonb, '{}'::jsonb, now(), now())`,
    [experimentId, `Sandbox experiment ${experimentId}`, JSON.stringify(payload), JSON.stringify({ deltaProposalId: input.deltaProposalId })],
  );
  await createLearningNode(db, {
    id: experimentId,
    nodeType: "sandbox_experiment",
    scope: "evolution",
    status: "queued",
    resourceRef: experimentId,
    payload,
    summaryText: `Sandbox experiment for ${input.deltaProposalId}`,
  });
  await createLearningEdge(db, {
    fromNodeId: input.deltaProposalId,
    edgeType: "TESTED",
    toNodeId: experimentId,
    evidence: { reason: "Sandbox experiment validates this delta proposal" },
  });
  return { experimentId };
}

export async function startSandboxExecutionPg(db: SouthstarDb, input: {
  experimentId: string;
  executorProvider: ExecutorProvider;
  callbackUrl: string;
  heartbeatUrl?: string;
  runRoot?: string;
  envelopeBasePath?: string;
  harnessEndpoint?: string;
}): Promise<{ experimentId: string; runs: Record<"baseline" | "candidate", { runId: string; externalJobId: string; workspacePath: string }> }> {
  const experiment = await loadExperiment(db, input.experimentId);
  const sourceRunId = experiment.replayRunRefs[0];
  if (!sourceRunId) throw new Error("sandbox execution requires at least one replayRunRef");
  const sourceRun = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest; goal_prompt: string; domain: string }>(
    "select workflow_manifest_json, goal_prompt, domain from southstar.workflow_runs where id = $1",
    [sourceRunId],
  );
  if (!sourceRun) throw new Error(`replay workflow run not found: ${sourceRunId}`);

  const runs = {} as Record<"baseline" | "candidate", { runId: string; externalJobId: string; workspacePath: string }>;
  for (const variant of ["baseline", "candidate"] as const) {
    const assetRefs = variant === "baseline" ? experiment.baselineAssetRefs : experiment.candidateAssetRefs;
    const sandboxRunId = `sandbox-${input.experimentId}-${variant}`;
    const requestedRunRoot = input.runRoot ?? "/tmp/southstar-runs";
    const workspacePath = join(requestedRunRoot, "sandbox-workspaces", `${input.experimentId}-${variant}`);
    await mkdir(workspacePath, { recursive: true });
    const configuredWorkflow = sandboxWorkflow(sourceRun.workflow_manifest_json, {
      experimentId: input.experimentId,
      variant,
      workspacePath,
      assetRefs,
      runRoot: requestedRunRoot,
      harnessEndpoint: input.harnessEndpoint,
    });
    const { workflow, runRoot, envelopeBasePath } = withMaterializationMount(configuredWorkflow, {
      runRoot: input.runRoot,
      envelopeBasePath: input.envelopeBasePath,
    });

    await createWorkflowRunPg(db, {
      id: sandboxRunId,
      status: "running",
      domain: sourceRun.domain,
      goalPrompt: `[sandbox:${variant}] ${sourceRun.goal_prompt}`,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({ executor: "tork", sandbox: true, variant }),
      snapshotJson: JSON.stringify({ activeTaskIds: workflow.tasks.map((task) => task.id) }),
      runtimeContextJson: JSON.stringify({ runMode: "sandbox", sandboxExperimentId: input.experimentId, sandboxVariant: variant, sourceRunId, assetRefs }),
      metricsJson: JSON.stringify({}),
    });
    await appendHistoryEventPg(db, {
      runId: sandboxRunId,
      eventType: "sandbox.run_materialized",
      actorType: "southstar-evolution",
      payload: { experimentId: input.experimentId, variant, sourceRunId, assetRefs, workspacePath },
    });

    for (const [index, task] of workflow.tasks.entries()) {
      const sessionId = `root-${sandboxRunId}-${task.id}`;
      await createWorkflowTaskPg(db, {
        id: task.id,
        runId: sandboxRunId,
        taskKey: task.name ?? task.id,
        status: "pending",
        sortOrder: index,
        dependsOn: task.dependsOn,
        rootSessionId: sessionId,
        snapshot: { roleRef: task.roleRef, agentProfileRef: task.agentProfileRef },
      });
      await buildContextPacketWithKnowledgeCards(db, {
        runId: sandboxRunId,
        taskId: task.id,
        rootSessionId: sessionId,
        goalPrompt: workflow.goalPrompt,
        domainPack: domainPackForWorkflowManifest(workflow),
        roleRef: task.roleRef,
        agentProfileRef: task.agentProfileRef,
        artifactContractRefs: task.requiredArtifactRefs,
        priorArtifactRefs: [],
        intent: workflow.intent,
        flowTemplateRef: "software.workflow.feature-implementation",
        promptTemplateRef: task.promptTemplateRef,
        skillRefs: task.skillRefs,
      });
      const envelope = await getPostgresTaskEnvelope(db, { runId: sandboxRunId, taskId: task.id });
      await materializeTaskEnvelope(envelope, { runRoot });
    }

    await upsertRuntimeResourcePg(db, {
      resourceType: "sandbox_workspace",
      resourceKey: `sandbox-workspace-${input.experimentId}-${variant}`,
      runId: sandboxRunId,
      scope: "sandbox",
      status: "created",
      title: `Sandbox workspace ${variant}`,
      payload: { experimentId: input.experimentId, variant, path: workspacePath, isolation: "temp-fixture-copy" },
      summary: { variant, path: workspacePath },
    });

    const submission = await input.executorProvider.submit({
      runId: sandboxRunId,
      workflow,
      callbackUrl: input.callbackUrl,
      heartbeatUrl: input.heartbeatUrl,
      envelopeBasePath,
      attemptId: `sandbox-${variant}-1`,
    });

    for (const task of workflow.tasks) {
      await createExecutorBindingPg(db, {
        runId: sandboxRunId,
        taskId: task.id,
        attemptId: `sandbox-${variant}-1`,
        torkJobId: submission.externalJobId,
        status: submission.status === "queued" ? "queued" : "submitted",
        queueTimeoutSeconds: 120,
        hardTimeoutSeconds: task.execution.timeoutSeconds,
      });
    }

    await upsertRuntimeResourcePg(db, {
      resourceType: "sandbox_trial_execution",
      resourceKey: `sandbox-trial-execution-${input.experimentId}-${variant}`,
      runId: sandboxRunId,
      scope: "sandbox",
      status: "submitted",
      title: `Sandbox ${variant} execution`,
      payload: { experimentId: input.experimentId, variant, runId: sandboxRunId, externalJobId: submission.externalJobId, executionProjection: submission.executionProjection },
      summary: { variant, externalJobId: submission.externalJobId },
    });

    runs[variant] = { runId: sandboxRunId, externalJobId: submission.externalJobId, workspacePath };
  }

  await saveExperiment(db, input.experimentId, "running", { ...experiment, status: "running", sandboxRunIds: { baseline: runs.baseline.runId, candidate: runs.candidate.runId } } as SandboxExperimentPayload);
  return { experimentId: input.experimentId, runs };
}

export async function recordSandboxEvaluatorOutputPg(db: SouthstarDb, input: {
  experimentId: string;
  variant: "baseline" | "candidate";
  caseRef: string;
  evaluatorResult: { ok: boolean; targetedReplayFixed?: boolean; metrics?: Partial<SandboxTrialInput["metrics"]> };
}): Promise<SandboxDecision | undefined> {
  const metrics = input.evaluatorResult.metrics ?? {};
  await upsertRuntimeResourcePg(db, {
    resourceType: "evaluator_result",
    resourceKey: `sandbox-evaluator-${input.experimentId}-${input.variant}-${input.caseRef}`,
    scope: "sandbox",
    status: input.evaluatorResult.ok ? "passed" : "failed",
    title: `Sandbox evaluator ${input.variant}`,
    payload: input,
    summary: { experimentId: input.experimentId, variant: input.variant, caseRef: input.caseRef },
  });
  await recordSandboxTrial(db, {
    experimentId: input.experimentId,
    variant: input.variant,
    caseRef: input.caseRef,
    status: input.evaluatorResult.ok ? "passed" : "failed",
    targetedReplayFixed: input.evaluatorResult.targetedReplayFixed ?? input.evaluatorResult.ok,
    metrics: {
      durationMs: numberMetric(metrics.durationMs),
      tokens: numberMetric(metrics.tokens),
      costMicrosUsd: numberMetric(metrics.costMicrosUsd),
      repairCount: numberMetric(metrics.repairCount),
      toolCalls: numberMetric(metrics.toolCalls),
    },
  });
  const experiment = await loadExperiment(db, input.experimentId);
  const hasBaseline = experiment.trials.some((trial) => trial.variant === "baseline");
  const hasCandidate = experiment.trials.some((trial) => trial.variant === "candidate");
  return hasBaseline && hasCandidate ? await evaluateSandboxExperiment(db, input.experimentId) : undefined;
}

export async function recordSandboxTrial(db: SouthstarDb, input: SandboxTrialInput): Promise<void> {
  const experiment = await loadExperiment(db, input.experimentId);
  const trial = { ...input, trialId: `trial-${randomUUID()}` };
  const payload = { ...experiment, status: "running", trials: [...experiment.trials, trial] };
  await saveExperiment(db, input.experimentId, "running", payload);
}

export async function evaluateSandboxExperiment(db: SouthstarDb, experimentId: string): Promise<SandboxDecision> {
  const experiment = await loadExperiment(db, experimentId);
  const baseline = experiment.trials.filter((trial) => trial.variant === "baseline");
  const candidate = experiment.trials.filter((trial) => trial.variant === "candidate");
  if (baseline.length === 0 || candidate.length === 0) throw new Error("sandbox evaluation requires baseline and candidate trials");

  const reasons: string[] = [];
  const baselinePassRate = passRate(baseline);
  const candidatePassRate = passRate(candidate);
  if (candidatePassRate >= baselinePassRate) reasons.push("candidate pass rate is at least baseline");
  else reasons.push(`candidate pass rate ${candidatePassRate} is below baseline ${baselinePassRate}`);

  const targetedReplayFixed = experiment.replayRunRefs.length === 0
    || candidate.filter((trial) => experiment.replayRunRefs.includes(trial.caseRef)).every((trial) => trial.targetedReplayFixed);
  if (targetedReplayFixed) reasons.push("targeted replay failure fixed");
  else reasons.push("targeted replay failure was not fixed");

  const costRegression = percentRegression(avg(candidate, "costMicrosUsd"), avg(baseline, "costMicrosUsd"));
  if (costRegression <= experiment.maxCostRegressionPercent) reasons.push("cost within threshold");
  else reasons.push(`cost regression ${costRegression.toFixed(2)}% exceeds threshold ${experiment.maxCostRegressionPercent}%`);

  const durationRegression = percentRegression(avg(candidate, "durationMs"), avg(baseline, "durationMs"));
  if (durationRegression <= experiment.maxDurationRegressionPercent) reasons.push("duration within threshold");
  else reasons.push(`duration regression ${durationRegression.toFixed(2)}% exceeds threshold ${experiment.maxDurationRegressionPercent}%`);

  const decision = candidatePassRate >= baselinePassRate
      && targetedReplayFixed
      && costRegression <= experiment.maxCostRegressionPercent
      && durationRegression <= experiment.maxDurationRegressionPercent
    ? "passed"
    : "failed";
  await saveExperiment(db, experimentId, decision, { ...experiment, status: decision, decision, decisionReasons: reasons });
  return { experimentId, decision, reasons };
}

type SandboxExperimentPayload = SandboxExperimentInput & {
  id: string;
  status: string;
  decision?: string;
  decisionReasons?: string[];
  sandboxRunIds?: { baseline?: string; candidate?: string };
  trials: Array<SandboxTrialInput & { trialId?: string }>;
};

async function loadExperiment(db: SouthstarDb, experimentId: string): Promise<SandboxExperimentPayload> {
  const row = await db.maybeOne<{ payload_json: SandboxExperimentPayload }>(
    "select payload_json from southstar.runtime_resources where resource_type = 'sandbox_experiment' and resource_key = $1",
    [experimentId],
  );
  if (!row) throw new Error(`sandbox experiment not found: ${experimentId}`);
  return row.payload_json;
}

async function saveExperiment(db: SouthstarDb, experimentId: string, status: string, payload: SandboxExperimentPayload): Promise<void> {
  await db.query(
    `update southstar.runtime_resources
     set status = $2, payload_json = $3::jsonb, updated_at = now()
     where resource_type = 'sandbox_experiment' and resource_key = $1`,
    [experimentId, status, JSON.stringify(payload)],
  );
  await db.query(
    `update southstar.learning_nodes
     set status = $2, payload_jsonb = $3::jsonb, updated_at = now()
     where id = $1`,
    [experimentId, status, JSON.stringify(payload)],
  );
}

function sandboxWorkflow(workflow: SouthstarWorkflowManifest, input: { experimentId: string; variant: "baseline" | "candidate"; workspacePath: string; assetRefs: string[]; runRoot: string; harnessEndpoint?: string }): SouthstarWorkflowManifest {
  const piEnv = piAgentRuntimeEnv();
  const piMount = piAgentConfigMount();
  const containerWorkspaceRoot = `/workspace/sandbox/sandbox-workspaces/${input.experimentId}-${input.variant}`;
  return {
    ...workflow,
    workflowId: `${workflow.workflowId}-sandbox-${input.variant}`,
    title: `${workflow.title} sandbox ${input.variant}`,
    tasks: workflow.tasks.map((task) => ({
      ...task,
      execution: {
        ...task.execution,
        env: {
          ...task.execution.env,
          ...piEnv,
          SOUTHSTAR_RUN_MODE: "sandbox",
          SOUTHSTAR_SANDBOX_EXPERIMENT_ID: input.experimentId,
          SOUTHSTAR_SANDBOX_VARIANT: input.variant,
          SOUTHSTAR_SANDBOX_ASSET_REFS: input.assetRefs.join(","),
          SOUTHSTAR_SANDBOX_WORKSPACE_ROOT: containerWorkspaceRoot,
          SOUTHSTAR_MATERIALIZATION_ROOT: input.runRoot,
          ...(input.harnessEndpoint ? { PI_HARNESS_ENDPOINT: input.harnessEndpoint, SOUTHSTAR_HARNESS_ENDPOINT: input.harnessEndpoint } : {}),
        },
        mounts: ensureMount(
          ensureMount(task.execution.mounts, { source: input.runRoot, target: "/workspace/sandbox", readonly: false }),
          piMount,
        ),
      },
    })),
  };
}

function ensureMount(
  mounts: Array<{ source: string; target: string; readonly: boolean }>,
  mount: { source: string; target: string; readonly: boolean } | undefined,
): Array<{ source: string; target: string; readonly: boolean }> {
  if (!mount) return mounts;
  if (mounts.some((entry) => entry.source === mount.source && entry.target === mount.target)) return mounts;
  return [...mounts, mount];
}

function numberMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function domainPackForWorkflowManifest(workflow: SouthstarWorkflowManifest): DomainPack {
  return {
    id: workflow.domainPackRef?.id ?? workflow.domain ?? "embedded-domain-pack",
    version: workflow.domainPackRef?.version ?? "manifest-embedded",
    displayName: workflow.domainPackRef?.id ?? workflow.domain ?? "manifest-embedded",
    intents: [],
    workflowTemplates: [],
    workflowGeneratorPolicies: [],
    roles: workflow.roles ?? [],
    agentProfiles: workflow.agentProfiles ?? [],
    artifactContracts: workflow.artifactContracts ?? [],
    evaluatorPipelines: workflow.evaluatorPipelines ?? [],
    contextPolicies: workflow.contextPolicies ?? [],
    sessionPolicies: workflow.sessionPolicies ?? [],
    memoryPolicies: workflow.memoryPolicies ?? [],
    workspacePolicies: workflow.workspacePolicies ?? [],
    stopConditions: workflow.stopConditions ?? [],
  };
}

function passRate(trials: Array<SandboxTrialInput & { trialId?: string }>): number {
  return trials.filter((trial) => trial.status === "passed").length / trials.length;
}

function avg(trials: Array<SandboxTrialInput & { trialId?: string }>, metric: "durationMs" | "costMicrosUsd"): number {
  return trials.reduce((sum, trial) => sum + trial.metrics[metric], 0) / trials.length;
}

function percentRegression(candidate: number, baseline: number): number {
  if (baseline <= 0) return candidate <= 0 ? 0 : 100;
  return ((candidate - baseline) / baseline) * 100;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

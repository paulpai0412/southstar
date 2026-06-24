import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { seedSoftwareLibraryGraph } from "../design-library/software-library-seed.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import { generateConstrainedWorkflowPlan } from "../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../workflow-generator/materialize.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../manifests/types.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../orchestration/composition-compiler.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { createWorkflowComposerRegistry, type WorkflowComposerMode } from "../orchestration/composer-registry.ts";
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
import { analyzeRequirementDeterministically } from "../orchestration/requirement-analyzer.ts";
import {
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
} from "../stores/postgres-runtime-store.ts";
import { buildContextPacketWithKnowledgeCards } from "../context/postgres-builder.ts";

export type PostgresPlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
};

export type PostgresRunResult = {
  runId: string;
  taskIds: string[];
};

export type CreatePostgresPlannerDraftInput = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  composer?: WorkflowComposer;
};

export async function createPostgresPlannerDraft(db: SouthstarDb, input: CreatePostgresPlannerDraftInput): Promise<PostgresPlannerDraftResult> {
  if (input.orchestrationMode === "llm-constrained") {
    return createLibraryConstrainedPlannerDraft(db, input);
  }
  return createDeterministicPlannerDraft(db, input);
}

async function createDeterministicPlannerDraft(
  db: SouthstarDb,
  input: { goalPrompt: string },
): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-software-${hash(input.goalPrompt).slice(0, 12)}`;
  const plan = generateConstrainedWorkflowPlan({
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    domainPack: softwareDomainPack,
    intentId: inferIntent(input.goalPrompt),
  });
  const workflow = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt: input.goalPrompt });
  const bundle: PlanBundle & { generationPlan: typeof plan } = {
    workflow,
    plannerTrace: { model: "southstar-postgres-constrained-planner", promptHash: hash(input.goalPrompt), generatedAt: new Date().toISOString() },
    generationPlan: plan,
  };
  const draftId = `draft-${workflow.workflowId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: workflow.title,
    payload: bundle,
    summary: { goalPrompt: input.goalPrompt, workflowId: workflow.workflowId, planner: "postgres-constrained" },
  });
  return { draftId, goalPrompt: input.goalPrompt, workflowId: workflow.workflowId };
}

async function createLibraryConstrainedPlannerDraft(
  db: SouthstarDb,
  input: { goalPrompt: string; composerMode?: WorkflowComposerMode; composer?: WorkflowComposer },
): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-library-${hash(input.goalPrompt).slice(0, 12)}`;
  await seedSoftwareLibraryGraph(db);
  const requirementSpec = analyzeRequirementDeterministically(input.goalPrompt);
  const candidatePacket = await resolveWorkflowCandidates(db, {
    requirementSpec,
    scope: "software",
  });
  const workflowId = `wf-composed-${hash(draftRunId).slice(0, 12)}`;
  const draftId = `draft-${workflowId}`;

  if (candidatePacket.unavailableRequirements.length > 0) {
    await upsertRuntimeResourcePg(db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "invalid",
      title: "Invalid Library-Constrained Planner Draft",
      payload: {
        requirementSpec,
        candidatePacket,
        unavailableRequirements: candidatePacket.unavailableRequirements,
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status: "invalid",
      },
    });
    return { draftId, goalPrompt: input.goalPrompt, workflowId };
  }

  const registry = createWorkflowComposerRegistry({ llmComposer: input.composer });
  const composerMode = input.composerMode ?? "fixture";
  const composer = registry.resolve({ composerMode });
  const fallbackImplicitlySelected = composerMode === "llm-with-fixture-fallback" && !input.composer;
  const repairResult = await runCompositionRepairLoop({
    db,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    composer,
    scope: "software",
    maxRepairAttempts: 2,
  });
  if (!repairResult.validation.ok) {
    await upsertRuntimeResourcePg(db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "invalid",
      title: "Invalid Library-Constrained Planner Draft",
      payload: {
        requirementSpec,
        candidatePacket,
        repairAttempts: repairResult.attempts,
      },
      summary: {
        goalPrompt: input.goalPrompt,
        workflowId,
        planner: "library-constrained-llm",
        status: "invalid",
      },
    });
    return { draftId, goalPrompt: input.goalPrompt, workflowId };
  }
  const composition = repairResult.composition;
  const compiled = await compileWorkflowComposition(db, {
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    composition,
  });
  const bundle: PlanBundle & {
    orchestrationSnapshot: ReturnType<typeof compileWorkflowComposition> extends Promise<infer T> ? T["orchestrationSnapshot"] : never;
    repairAttempts: typeof repairResult.attempts;
  } = {
    workflow: compiled.workflow,
    plannerTrace: {
      model: `southstar-library-constrained-${composerMode}-composer`,
      promptHash: hash(input.goalPrompt),
      generatedAt: new Date().toISOString(),
      analyzerType: "deterministic",
      composerMode,
      composerFallbackUsed: fallbackImplicitlySelected || didComposerUseFallback(composer),
      validatorAttempts: repairResult.attempts.length,
      repairAttempts: Math.max(0, repairResult.attempts.length - 1),
      finalValidationOk: repairResult.validation.ok,
      candidatePacketHash: hash(JSON.stringify(candidatePacket)),
      compositionHash: hash(JSON.stringify(composition)),
    },
    orchestrationSnapshot: compiled.orchestrationSnapshot,
    repairAttempts: repairResult.attempts,
  };

  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: compiled.workflow.title,
    payload: bundle,
    summary: {
      goalPrompt: input.goalPrompt,
      workflowId: compiled.workflow.workflowId,
      planner: "library-constrained-llm",
    },
  });
  return { draftId, goalPrompt: input.goalPrompt, workflowId: compiled.workflow.workflowId };
}

export async function createPostgresRunFromDraft(db: SouthstarDb, input: { draftId: string }): Promise<PostgresRunResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  if (draft.status !== "validated") throw new Error(`planner draft is not validated: ${input.draftId}`);
  const bundle = draft.payload as PlanBundle & { generationPlan?: { templateRef?: string } };
  const workflow = bundle.workflow;
  const runId = await allocateRunId(db, workflow.workflowId);

  await createWorkflowRunPg(db, {
    id: runId,
    status: "created",
    domain: workflow.domain,
    goalPrompt: workflow.goalPrompt,
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: JSON.stringify({ executor: "pending" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ draftId: input.draftId, scope: workflow.domain }),
    metricsJson: JSON.stringify({}),
  });
  await appendHistoryEventPg(db, {
    runId,
    eventType: "run.created",
    actorType: "orchestrator",
    payload: { draftId: input.draftId, workflowId: workflow.workflowId },
  });

  const taskIds: string[] = [];
  for (const [index, task] of workflow.tasks.entries()) {
    await createWorkflowTaskPg(db, {
      id: task.id,
      runId,
      taskKey: task.name ?? task.id,
      status: "pending",
      sortOrder: index,
      dependsOn: task.dependsOn,
      snapshot: { roleRef: task.roleRef, agentProfileRef: task.agentProfileRef },
      metrics: {},
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId: task.id,
      eventType: "task.created",
      actorType: "orchestrator",
      payload: { taskKey: task.name ?? task.id, dependsOn: task.dependsOn },
    });
    await buildContextForTask(db, workflow, task.id, runId, bundle.generationPlan?.templateRef ?? "software.workflow.feature-implementation");
    taskIds.push(task.id);
  }

  return { runId, taskIds };
}

async function buildContextForTask(
  db: SouthstarDb,
  workflow: SouthstarWorkflowManifest,
  taskId: string,
  runId: string,
  flowTemplateRef: string,
): Promise<void> {
  const task = workflow.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const domainPack = domainPackForWorkflow(workflow);
  await buildContextPacketWithKnowledgeCards(db, {
    runId,
    taskId: task.id,
    rootSessionId: `root-${runId}-${task.id}`,
    goalPrompt: workflow.goalPrompt,
    domainPack,
    roleRef: task.roleRef,
    agentProfileRef: task.agentProfileRef,
    artifactContractRefs: task.requiredArtifactRefs,
    priorArtifactRefs: [],
    intent: workflow.intent,
    flowTemplateRef,
    promptTemplateRef: task.promptTemplateRef,
    skillRefs: task.skillRefs,
  });
}

async function allocateRunId(db: SouthstarDb, workflowId: string): Promise<string> {
  const base = `run-${workflowId}`;
  if (!await runExists(db, base)) return base;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = `${base}-${Date.now().toString(36)}-${attempt}`;
    if (!await runExists(db, candidate)) return candidate;
  }
  throw new Error(`unable to allocate run id for workflow ${workflowId}`);
}

async function runExists(db: SouthstarDb, runId: string): Promise<boolean> {
  return Boolean(await db.maybeOne("select 1 from southstar.workflow_runs where id = $1", [runId]));
}

function inferIntent(goalPrompt: string): "implement_feature" | "fix_bug" {
  return /fix|bug|failing|修正|錯誤/i.test(goalPrompt) ? "fix_bug" : "implement_feature";
}

function domainPackForWorkflow(workflow: SouthstarWorkflowManifest): DomainPack {
  return {
    ...softwareDomainPack,
    id: workflow.domain ?? softwareDomainPack.id,
    roles: workflow.roles ?? softwareDomainPack.roles,
    agentProfiles: workflow.agentProfiles ?? softwareDomainPack.agentProfiles,
    artifactContracts: workflow.artifactContracts ?? softwareDomainPack.artifactContracts,
    evaluatorPipelines: workflow.evaluatorPipelines ?? softwareDomainPack.evaluatorPipelines,
    contextPolicies: workflow.contextPolicies ?? softwareDomainPack.contextPolicies,
    sessionPolicies: workflow.sessionPolicies ?? softwareDomainPack.sessionPolicies,
    memoryPolicies: workflow.memoryPolicies ?? softwareDomainPack.memoryPolicies,
    workspacePolicies: workflow.workspacePolicies ?? softwareDomainPack.workspacePolicies,
    stopConditions: workflow.stopConditions ?? softwareDomainPack.stopConditions,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function didComposerUseFallback(composer: WorkflowComposer): boolean {
  const maybeFallbackAwareComposer = composer as WorkflowComposer & { wasFallbackUsed?: () => boolean };
  return maybeFallbackAwareComposer.wasFallbackUsed?.() === true;
}

import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import { generateConstrainedWorkflowPlan } from "../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../workflow-generator/materialize.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../manifests/types.ts";
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

export async function createPostgresPlannerDraft(db: SouthstarDb, input: { goalPrompt: string }): Promise<PostgresPlannerDraftResult> {
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

export async function createPostgresRunFromDraft(db: SouthstarDb, input: { draftId: string }): Promise<PostgresRunResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
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
  await buildContextPacketWithKnowledgeCards(db, {
    runId,
    taskId: task.id,
    rootSessionId: `root-${runId}-${task.id}`,
    goalPrompt: workflow.goalPrompt,
    domainPack: softwareDomainPack,
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

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

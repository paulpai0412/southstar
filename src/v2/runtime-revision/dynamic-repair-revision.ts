import type { SouthstarDb } from "../db/postgres.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../orchestration/composition-compiler.ts";
import { applyWorkflowRevision } from "../manifests/workflow-revision.ts";
import type { AgentProfile, RoleDefinition } from "../design-library/runtime-types.ts";
import type { HarnessDefinition, SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import {
  appendHistoryEventPg,
  createWorkflowTaskPg,
  getResourceByKeyPg,
  upsertRuntimeResourcePg,
  updateWorkflowManifestPg,
} from "../stores/postgres-runtime-store.ts";

export type DynamicRepairRevisionInput = {
  runId: string;
  failedTaskId: string;
  failedArtifactRefId?: string;
  failedArtifact?: unknown;
  workflowComposer?: WorkflowComposer;
  maxDynamicRepairRounds?: number;
};

export type DynamicRepairRevisionResult =
  | { status: "applied"; revisionId: string; newTaskIds: string[] }
  | { status: "skipped"; reason: string };

type TaskRow = {
  id: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
  snapshot_json: unknown;
};

type RunRow = {
  status: string;
  domain: string;
  goal_prompt: string;
  workflow_manifest_json: SouthstarWorkflowManifest;
};

export async function maybeApplyDynamicRepairRevisionPg(
  db: SouthstarDb,
  input: DynamicRepairRevisionInput,
): Promise<DynamicRepairRevisionResult> {
  if (!input.workflowComposer) return { status: "skipped", reason: "workflow-composer-unavailable" };
  const maxRounds = input.maxDynamicRepairRounds ?? 2;
  if (maxRounds < 1) return { status: "skipped", reason: "dynamic-repair-disabled" };

  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<RunRow>(
      `select status, domain, goal_prompt, workflow_manifest_json
         from southstar.workflow_runs
        where id = $1
        for update`,
      [input.runId],
    );
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (!["running", "scheduling"].includes(run.status)) {
      return { status: "skipped", reason: `run-status:${run.status}` };
    }

    const taskRows = await tx.query<TaskRow>(
      `select id, status, sort_order, depends_on_json, snapshot_json
         from southstar.workflow_tasks
        where run_id = $1
        order by sort_order, id
        for update`,
      [input.runId],
    );
    const failedTaskRow = taskRows.rows.find((task) => task.id === input.failedTaskId);
    if (!failedTaskRow) throw new Error(`failed task not found: ${input.runId}/${input.failedTaskId}`);
    const failedTask = run.workflow_manifest_json.tasks.find((task) => task.id === input.failedTaskId);
    if (!failedTask) throw new Error(`failed task missing from manifest: ${input.failedTaskId}`);
    const failedProfile = run.workflow_manifest_json.agentProfiles?.find((profile) => profile.id === failedTask.agentProfileRef);
    if (failedProfile?.workerKind !== "validation_worker") {
      return { status: "skipped", reason: "failed-task-is-not-validation-worker" };
    }

    const round = await nextRepairRound(tx, input.runId, input.failedTaskId);
    if (round > maxRounds) return { status: "skipped", reason: "dynamic-repair-round-limit" };

    const resourceKey = dynamicRevisionResourceKey(input.runId, input.failedTaskId, round);
    if (await getResourceByKeyPg(tx, "workflow_dynamic_repair_revision", resourceKey)) {
      return { status: "skipped", reason: "dynamic-repair-revision-already-recorded" };
    }

    const scope = run.domain || run.workflow_manifest_json.domain || "software";
    const candidatePacket = await resolveWorkflowCandidates(tx, {
      requirementSpec: {
        summary: `Repair failed validation task ${input.failedTaskId}`,
        workType: "bugfix",
        requiredCapabilities: [],
        expectedArtifacts: failedTask.requiredArtifactRefs ?? [],
        acceptanceCriteria: ["Repair the implementation using the failed verifier report.", "Reverify the repaired implementation."],
        nonGoals: ["Do not create cyclic workflow dependencies."],
        riskNotes: ["Dynamic repair revision generated after verifier failure."],
        workspaceAssumptions: [],
        missingInputs: [],
      },
      scope,
    });
    const composition = await input.workflowComposer.compose({
      goalPrompt: dynamicRepairGoalPrompt({
        goalPrompt: run.goal_prompt,
        failedTask,
        failedArtifactRefId: input.failedArtifactRefId,
        failedArtifact: input.failedArtifact,
        round,
        maxRounds,
      }),
      candidatePacket,
    });
    const compositionForCompile = prepareDynamicRepairCompositionForCompile(composition);
    const compiled = await compileWorkflowComposition(tx, {
      runId: `${input.runId}-dynamic-repair-${round}`,
      goalPrompt: run.goal_prompt,
      candidatePacket,
      composition: compositionForCompile,
      scope,
      manifestDomain: run.workflow_manifest_json.domain ?? scope,
    });
    const newTasks = rewriteDynamicRepairTasks(compiled.workflow.tasks, {
      failedTaskId: input.failedTaskId,
      failedTaskDependsOn: dependencyList(failedTaskRow.depends_on_json),
      failedArtifactRefId: input.failedArtifactRefId,
      round,
    });
    const reconnectTargetTaskId = dynamicRepairReconnectTargetTaskId(newTasks, compiled.workflow.agentProfiles);
    const downstreamDependencyChanges = reconnectTargetTaskId
      ? downstreamDependencyChangesFor({
          workflowTasks: run.workflow_manifest_json.tasks,
          taskRows: taskRows.rows,
          failedTaskId: input.failedTaskId,
          reconnectTargetTaskId,
        })
      : [];
    const revisionId = `dynamic-repair-${input.failedTaskId}-attempt-${round}`;
    const taskStates = Object.fromEntries(taskRows.rows.map((task) => [task.id, normalizeTaskStatus(task.status)]));
    const revision = applyWorkflowRevision(run.workflow_manifest_json, {
      revisionId,
      baseRevisionId: run.workflow_manifest_json.workflowGeneration?.planId ?? "current",
      runId: input.runId,
      actorType: "orchestrator",
      reason: `Dynamic repair for failed validation task ${input.failedTaskId}`,
      addTasks: newTasks,
      removeTaskIds: [],
      dependencyChanges: downstreamDependencyChanges,
      idempotencyKey: resourceKey,
    }, taskStates);
    const mergedWorkflow = mergeRuntimeDefinitions(revision.workflow, compiled.workflow);
    await updateWorkflowManifestPg(tx, input.runId, JSON.stringify(mergedWorkflow));
    for (const change of downstreamDependencyChanges) {
      await tx.query(
        `update southstar.workflow_tasks
            set depends_on_json = $3::jsonb,
                updated_at = now()
          where run_id = $1 and id = $2`,
        [input.runId, change.taskId, JSON.stringify(change.dependsOn)],
      );
    }
    const maxSortOrder = Math.max(-1, ...taskRows.rows.map((task) => task.sort_order));
    for (const [index, task] of newTasks.entries()) {
      await createWorkflowTaskPg(tx, {
        id: task.id,
        runId: input.runId,
        taskKey: task.name ?? task.id,
        status: "pending",
        sortOrder: maxSortOrder + index + 1,
        dependsOn: task.dependsOn,
        snapshot: {
          roleRef: task.roleRef,
          agentProfileRef: task.agentProfileRef,
          dynamicRepair: {
            originalFailedTaskId: input.failedTaskId,
            failedTaskId: input.failedTaskId,
            failedArtifactRefId: input.failedArtifactRefId,
            round,
          },
        },
      });
    }
    await upsertRuntimeResourcePg(tx, {
      id: `workflow-dynamic-repair-${input.runId}-${input.failedTaskId}-${round}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
      resourceType: "workflow_dynamic_repair_revision",
      resourceKey,
      runId: input.runId,
      taskId: input.failedTaskId,
      scope: "workflow",
      status: "applied",
      title: "Dynamic repair workflow revision",
      payload: {
        revisionId,
        originalFailedTaskId: input.failedTaskId,
        failedArtifactRefId: input.failedArtifactRefId,
        round,
        maxRounds,
        newTaskIds: revision.newTaskIds,
        downstreamDependencyChanges,
        composition,
        compiledComposition: compositionForCompile,
      },
      summary: { revisionId, newTaskIds: revision.newTaskIds, downstreamDependencyChanges, round },
    });
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      taskId: input.failedTaskId,
      eventType: "workflow.dynamic_repair_revision_applied",
      actorType: "orchestrator",
      idempotencyKey: `${resourceKey}:history`,
      payload: {
        revisionId,
        failedArtifactRefId: input.failedArtifactRefId,
        round,
        newTaskIds: revision.newTaskIds,
        downstreamDependencyChanges,
        manifestFingerprint: revision.manifestFingerprint,
      },
    });
    return { status: "applied", revisionId, newTaskIds: revision.newTaskIds };
  });
}

function rewriteDynamicRepairTasks(
  tasks: WorkflowTaskDefinition[],
  input: {
    failedTaskId: string;
    failedTaskDependsOn: string[];
    failedArtifactRefId?: string;
    round: number;
  },
): WorkflowTaskDefinition[] {
  const idMap = new Map<string, string>();
  for (const task of tasks) {
    const prefix = task.id.toLowerCase().includes("verify") ? "reverify" : task.id.toLowerCase().includes("repair") ? "repair" : task.id;
    idMap.set(task.id, `${prefix}-${input.failedTaskId}-attempt-${input.round}`);
  }
  return tasks.map((task) => {
    const nextId = required(idMap.get(task.id), `missing dynamic id for ${task.id}`);
    const internalDependsOn = task.dependsOn
      .map((dependency) => idMap.get(dependency))
      .filter((dependency): dependency is string => Boolean(dependency));
    const dependsOn = internalDependsOn.length > 0 ? internalDependsOn : input.failedTaskDependsOn;
    return {
      ...task,
      id: nextId,
      dependsOn,
      promptInputs: {
        ...(task.promptInputs ?? {}),
        dynamicRepair: {
          originalFailedTaskId: input.failedTaskId,
          failedTaskId: input.failedTaskId,
          failedArtifactRefId: input.failedArtifactRefId,
          round: input.round,
        },
      },
      subagents: task.subagents.map((subagent) => ({
        ...subagent,
        id: `${subagent.id}-${nextId}`,
      })),
    };
  });
}

function prepareDynamicRepairCompositionForCompile(composition: WorkflowCompositionPlan): WorkflowCompositionPlan {
  const taskIds = new Set(composition.tasks.map((task) => task.id));
  let previousTaskId: string | undefined;
  const tasksWithInternalDependencies = composition.tasks.map((task) => {
    const internalDependsOn = unique(task.dependsOn.filter((dependency) => taskIds.has(dependency)));
    const dependsOn = internalDependsOn.length > 0
      ? internalDependsOn
      : previousTaskId
        ? [previousTaskId]
        : [];
    previousTaskId = task.id;
    return { ...task, dependsOn };
  });
  return {
    ...composition,
    tasks: tasksWithInternalDependencies.map((task) => ({
      ...task,
      inputArtifactRefs: task.inputArtifactRefs.filter((artifactRef) =>
        upstreamOutputArtifactRefs(tasksWithInternalDependencies, task.id).has(artifactRef)
      ),
    })),
  };
}

function upstreamOutputArtifactRefs(tasks: WorkflowCompositionPlan["tasks"], taskId: string): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const artifacts = new Set<string>();
  const visit = (dependencyId: string) => {
    if (seen.has(dependencyId)) return;
    seen.add(dependencyId);
    const dependency = byId.get(dependencyId);
    if (!dependency) return;
    for (const artifactRef of dependency.outputArtifactRefs) artifacts.add(artifactRef);
    for (const nextDependencyId of dependency.dependsOn) visit(nextDependencyId);
  };
  for (const dependencyId of byId.get(taskId)?.dependsOn ?? []) visit(dependencyId);
  return artifacts;
}

function dynamicRepairReconnectTargetTaskId(
  newTasks: WorkflowTaskDefinition[],
  generatedProfiles: AgentProfile[] | undefined,
): string | undefined {
  const profileById = new Map((generatedProfiles ?? []).map((profile) => [profile.id, profile]));
  const validationTask = [...newTasks]
    .reverse()
    .find((task) => profileById.get(task.agentProfileRef)?.workerKind === "validation_worker");
  return validationTask?.id ?? newTasks.at(-1)?.id;
}

function downstreamDependencyChangesFor(input: {
  workflowTasks: WorkflowTaskDefinition[];
  taskRows: TaskRow[];
  failedTaskId: string;
  reconnectTargetTaskId: string;
}): Array<{ taskId: string; dependsOn: string[] }> {
  const rowsById = new Map(input.taskRows.map((row) => [row.id, row]));
  const changes: Array<{ taskId: string; dependsOn: string[] }> = [];
  for (const task of input.workflowTasks) {
    if (task.id === input.failedTaskId || !task.dependsOn.includes(input.failedTaskId)) continue;
    const row = rowsById.get(task.id);
    if (!row) continue;
    const status = normalizeTaskStatus(row.status);
    if (status === "completed" || status === "running") continue;
    const dependsOn = unique(task.dependsOn.map((dependency) =>
      dependency === input.failedTaskId ? input.reconnectTargetTaskId : dependency
    ));
    if (sameStringArray(dependsOn, task.dependsOn)) continue;
    changes.push({ taskId: task.id, dependsOn });
  }
  return changes;
}

function mergeRuntimeDefinitions(
  base: SouthstarWorkflowManifest,
  generated: SouthstarWorkflowManifest,
): SouthstarWorkflowManifest {
  return {
    ...base,
    roles: mergeById(base.roles ?? [], generated.roles ?? []),
    agentProfiles: mergeById(base.agentProfiles ?? [], generated.agentProfiles ?? []),
    harnessDefinitions: mergeById(base.harnessDefinitions, generated.harnessDefinitions),
    evaluators: mergeById(base.evaluators, generated.evaluators),
  };
}

function dynamicRepairGoalPrompt(input: {
  goalPrompt: string;
  failedTask: WorkflowTaskDefinition;
  failedArtifactRefId?: string;
  failedArtifact?: unknown;
  round: number;
  maxRounds: number;
}): string {
  return [
    input.goalPrompt,
    "",
    "Runtime dynamic repair request:",
    `Failed validation task: ${input.failedTask.id}`,
    `Repair round: ${input.round} of ${input.maxRounds}`,
    input.failedArtifactRefId ? `Failed artifact ref: ${input.failedArtifactRefId}` : "",
    "Generate only the additional bounded repair and reverify tasks needed to continue the existing run.",
    "Do not generate cyclic dependencies and do not repeat already completed implementation work unless needed for repair.",
    `Failed artifact: ${JSON.stringify(input.failedArtifact ?? {})}`,
  ].filter(Boolean).join("\n");
}

async function nextRepairRound(db: SouthstarDb, runId: string, failedTaskId: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    `select count(*)::text as count
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'workflow_dynamic_repair_revision'
        and payload_json->>'originalFailedTaskId' = $2
        and status = 'applied'`,
    [runId, failedTaskId],
  );
  return Number.parseInt(row.count, 10) + 1;
}

function dynamicRevisionResourceKey(runId: string, failedTaskId: string, round: number): string {
  return `workflow-dynamic-repair:${runId}:${failedTaskId}:attempt-${round}`;
}

function dependencyList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeTaskStatus(status: string) {
  return ["pending", "running", "completed", "failed", "cancelled"].includes(status)
    ? status as "pending" | "running" | "completed" | "failed" | "cancelled"
    : "pending";
}

function mergeById<T extends { id: string }>(base: T[], generated: T[]): T[] {
  const values = new Map<string, T>();
  for (const item of base) values.set(item.id, item);
  for (const item of generated) {
    if (!values.has(item.id)) values.set(item.id, item);
  }
  return [...values.values()];
}

function required<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new Error(message);
  return value;
}

import type { SouthstarDb } from "../db/postgres.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../orchestration/composition-compiler.ts";
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
import { finalizeGoalContract } from "../orchestration/goal-contract.ts";
import type { WorkflowCompositionPlan } from "../design-library/types.ts";
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
    const rootFailedTaskId = dynamicRepairRootFailedTaskId(failedTask, failedTaskRow) ?? input.failedTaskId;
    const repairSeedTask = findRepairSeedTask(run.workflow_manifest_json, failedTask);
    const profileHints = dynamicRepairProfileHints({
      workflow: run.workflow_manifest_json,
      failedTask,
      failedProfile,
      repairSeedTask,
    });

    const round = await nextRepairRound(tx, {
      runId: input.runId,
      rootFailedTaskId,
      workflow: run.workflow_manifest_json,
      taskRows: taskRows.rows,
    });
    if (round > maxRounds) return { status: "skipped", reason: "dynamic-repair-round-limit" };

    const resourceKey = dynamicRevisionResourceKey(input.runId, rootFailedTaskId, round);
    if (await getResourceByKeyPg(tx, "workflow_dynamic_repair_revision", resourceKey)) {
      return { status: "skipped", reason: "dynamic-repair-revision-already-recorded" };
    }

    const scope = run.domain || run.workflow_manifest_json.domain || "software";
    const candidateScope = "all";
    const repairGoalPrompt = dynamicRepairGoalPrompt({
      goalPrompt: run.goal_prompt,
      failedTask,
      rootFailedTaskId,
      failedArtifactRefId: input.failedArtifactRefId,
      failedArtifact: input.failedArtifact,
      profileHints,
      round,
      maxRounds,
    });
    const repairGoalContract = finalizeGoalContract({
      goalPrompt: repairGoalPrompt,
      cwd: process.cwd(),
      interpretation: {
        domain: scope,
        intent: "repair",
        summary: `Repair and independently reverify failed task ${input.failedTaskId}`,
        requirements: [{
          statement: `Repair and independently reverify failed task ${input.failedTaskId}`,
          acceptanceCriteria: [
            "The reported blocking failures are repaired without regressing preserved behavior.",
            "An independent verifier reruns the failed and relevant regression checks.",
          ],
          blocking: true,
          source: "inferred",
        }],
        expectedArtifactRefs: [...new Set([
          ...(failedTask.requiredArtifactRefs ?? []),
          "artifact.verification_report",
        ])],
        requiredCapabilities: [],
        nonGoals: ["Do not replace or rerun the completed initial workflow."],
        assumptions: [],
        blockingInputs: [],
        riskTags: ["runtime-repair"],
        requestedSideEffects: ["workspace-write"],
      },
    });
    const candidatePacket = await resolveWorkflowCandidates(tx, {
      requirementSpec: {
        summary: `Repair failed validation task ${input.failedTaskId}`,
        workType: "bugfix",
        requiredCapabilities: [],
        expectedArtifacts: failedTask.requiredArtifactRefs ?? [],
        acceptanceCriteria: [
          "Repair the implementation using the failed verifier report.",
          "Reverify the repaired implementation.",
        ],
        nonGoals: ["Do not create cyclic workflow dependencies."],
        riskNotes: ["Dynamic repair revision generated after verifier failure."],
        workspaceAssumptions: [],
        missingInputs: [],
      },
      scope: candidateScope,
    });
    const repairLoopComposer: WorkflowComposer = {
      async compose(composeInput) {
        return prepareDynamicRepairCompositionForCompile(await input.workflowComposer!.compose(composeInput));
      },
    };
    const repairLoop = await runCompositionRepairLoop({
      db: tx,
      goalPrompt: repairGoalPrompt,
      goalContract: repairGoalContract,
      candidatePacket,
      composer: repairLoopComposer,
      scope: candidateScope,
      maxRepairAttempts: 2,
    });
    if (!repairLoop.validation.ok || !repairLoop.composition) {
      const firstIssue = repairLoop.validation.issues[0];
      return {
        status: "skipped",
        reason: `dynamic-repair-composition-invalid:${firstIssue?.code ?? "unknown"}:${firstIssue?.message ?? "unknown"}`,
      };
    }
    const composition = repairLoop.composition;
    const compositionForCompile = composition;
    const compiled = await compileWorkflowComposition(tx, {
      runId: `${input.runId}-dynamic-repair-${round}`,
      goalPrompt: run.goal_prompt,
      goalContract: repairGoalContract,
      candidatePacket,
      composition: compositionForCompile,
      scope: candidateScope,
      manifestDomain: run.workflow_manifest_json.domain ?? scope,
    });
    const newTasks = rewriteDynamicRepairTasks(compiled.workflow.tasks, {
      failedTaskId: input.failedTaskId,
      rootFailedTaskId,
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
            originalFailedTaskId: rootFailedTaskId,
            rootFailedTaskId,
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
        originalFailedTaskId: rootFailedTaskId,
        rootFailedTaskId,
        failedTaskId: input.failedTaskId,
        failedArtifactRefId: input.failedArtifactRefId,
        round,
        maxRounds,
        newTaskIds: revision.newTaskIds,
        downstreamDependencyChanges,
        composition,
        compiledComposition: compositionForCompile,
        repairLoopAttempts: repairLoop.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          ok: attempt.validation.ok,
          issueCount: attempt.validation.issues.length,
          issues: attempt.validation.issues,
        })),
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
        rootFailedTaskId,
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
    rootFailedTaskId: string;
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
          originalFailedTaskId: input.rootFailedTaskId,
          rootFailedTaskId: input.rootFailedTaskId,
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
  rootFailedTaskId: string;
  failedArtifactRefId?: string;
  failedArtifact?: unknown;
  profileHints: DynamicRepairProfileHints;
  round: number;
  maxRounds: number;
}): string {
  return [
    input.goalPrompt,
    "",
    "Runtime dynamic repair request:",
    `Failed validation task: ${input.failedTask.id}`,
    `Root failed validation task: ${input.rootFailedTaskId}`,
    `Repair round: ${input.round} of ${input.maxRounds}`,
    input.failedArtifactRefId ? `Failed artifact ref: ${input.failedArtifactRefId}` : "",
    "Generate only appended runtime repair nodes, not a replacement initial workflow.",
    "Generate one bounded repair task followed by one reverify task unless the failure evidence clearly requires a smaller or larger bounded set.",
    "The repair task must use workerKind=repair_worker, consume the failed verification report and prior implementation artifacts, preserve existing behavior, fix only reported blocking failures, and output a repaired implementation artifact.",
    "The reverify task must use workerKind=validation_worker, depend on the repair task, rerun the failed checks plus relevant regression checks, and output artifact.verification_report with pass, safeToSave, blockingTests/testResults, evidence, and remaining failures.",
    "For the repair nodePromptSpec include repairInputs, mustPreserve, implementationScope, testCases, expectedOutputs, acceptanceCriteria, and failureReportContract.",
    "For the reverify nodePromptSpec include verificationChecks, testCases, failureArtifactContract, expectedOutputs, acceptanceCriteria, and an explicit rule to set pass=false and safeToSave=false for any blocking failure.",
    "Profile reuse hints:",
    JSON.stringify(input.profileHints, null, 2),
    "Use repairProfileSeed as the preferred source for the repair generated agent profile: preserve its agentRef, provider/model/thinkingLevel/harnessRef, skills, tools, MCP grants, vault grants, context/session policy, budget, and execution image/command/mount shape unless the repair evidence requires a narrower safe change.",
    "Use reverifyProfileSeed as the preferred source for the reverify generated agent profile: preserve its verifier agentRef, provider/model/thinkingLevel/harnessRef, skills, tools, MCP grants, vault grants, context/session policy, budget, evaluator intent, and execution image/command/mount shape unless validation requires a narrower safe change.",
    "Do not reuse the original profile ids directly. Generate new agentProfileRef ids for appended dynamic profiles. The repair generated profile must use workerKind=repair_worker; the reverify generated profile must use workerKind=validation_worker.",
    "Select agentDefinitionRef, skillRefs, toolGrantRefs, mcpGrantRefs, instructionRefs, evaluatorProfileRef, inputArtifactRefs, and outputArtifactRefs only from GraphMetadataCandidates.nodes. Do not use capability refs as agentDefinitionRef.",
    "Do not generate cyclic dependencies, back edges, or repeat already completed implementation work unless needed for the bounded repair.",
    `Failed artifact: ${JSON.stringify(input.failedArtifact ?? {})}`,
  ].filter(Boolean).join("\n");
}

type DynamicRepairProfileHints = {
  repairProfileSeed: DynamicRepairProfileSeed | null;
  reverifyProfileSeed: DynamicRepairProfileSeed;
};

type DynamicRepairProfileSeed = {
  seedTaskId: string;
  seedTaskName: string;
  seedAgentProfileId?: string;
  seedPurpose: "repair_from_implementation" | "reverify_from_failed_validation";
  agentProfile?: Partial<AgentProfile>;
  taskRefs: {
    roleRef?: string;
    agentProfileRef?: string;
    skillRefs: string[];
    instructionRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
    requiredArtifactRefs: string[];
    evaluatorPipelineRef?: string;
    contextPolicyRef?: string;
    sessionPolicyRef?: string;
    workspacePolicyRef?: string;
  };
  taskPromptSpec?: unknown;
  execution?: WorkflowTaskDefinition["execution"];
};

function dynamicRepairProfileHints(input: {
  workflow: SouthstarWorkflowManifest;
  failedTask: WorkflowTaskDefinition;
  failedProfile: AgentProfile;
  repairSeedTask?: WorkflowTaskDefinition;
}): DynamicRepairProfileHints {
  return {
    repairProfileSeed: input.repairSeedTask
      ? profileSeedForTask(input.workflow, input.repairSeedTask, "repair_from_implementation")
      : null,
    reverifyProfileSeed: profileSeedForTask(input.workflow, input.failedTask, "reverify_from_failed_validation", input.failedProfile),
  };
}

function findRepairSeedTask(
  workflow: SouthstarWorkflowManifest,
  failedTask: WorkflowTaskDefinition,
): WorkflowTaskDefinition | undefined {
  const taskById = new Map(workflow.tasks.map((task) => [task.id, task]));
  const profileById = new Map((workflow.agentProfiles ?? []).map((profile) => [profile.id, profile]));
  const dependencies = failedTask.dependsOn
    .map((dependencyId) => taskById.get(dependencyId))
    .filter((task): task is WorkflowTaskDefinition => Boolean(task));
  return dependencies.find((task) => profileById.get(task.agentProfileRef ?? "")?.workerKind === "repair_worker")
    ?? dependencies.find((task) => profileById.get(task.agentProfileRef ?? "")?.workerKind === "execution_worker")
    ?? dependencies.find((task) => nodePromptType(task) === "implement")
    ?? dependencies.find((task) => nodePromptType(task) === "repair")
    ?? dependencies.at(0);
}

function profileSeedForTask(
  workflow: SouthstarWorkflowManifest,
  task: WorkflowTaskDefinition,
  seedPurpose: DynamicRepairProfileSeed["seedPurpose"],
  knownProfile?: AgentProfile,
): DynamicRepairProfileSeed {
  const profile = knownProfile ?? workflow.agentProfiles?.find((candidate) => candidate.id === task.agentProfileRef);
  return {
    seedTaskId: task.id,
    seedTaskName: task.name,
    seedAgentProfileId: profile?.id ?? task.agentProfileRef,
    seedPurpose,
    ...(profile ? { agentProfile: profileSeedProfile(profile) } : {}),
    taskRefs: {
      ...(task.roleRef ? { roleRef: task.roleRef } : {}),
      ...(task.agentProfileRef ? { agentProfileRef: task.agentProfileRef } : {}),
      skillRefs: task.skillRefs ?? [],
      instructionRefs: task.instructionRefs ?? [],
      toolGrantRefs: task.toolGrantRefs ?? [],
      mcpGrantRefs: task.mcpGrantRefs ?? [],
      vaultLeasePolicyRefs: task.vaultLeasePolicyRefs ?? [],
      requiredArtifactRefs: task.requiredArtifactRefs ?? [],
      ...(task.evaluatorPipelineRef ? { evaluatorPipelineRef: task.evaluatorPipelineRef } : {}),
      ...(task.contextPolicyRef ? { contextPolicyRef: task.contextPolicyRef } : {}),
      ...(task.sessionPolicyRef ? { sessionPolicyRef: task.sessionPolicyRef } : {}),
      ...(task.workspacePolicyRef ? { workspacePolicyRef: task.workspacePolicyRef } : {}),
    },
    ...(task.promptInputs?.nodePromptSpec ? { taskPromptSpec: task.promptInputs.nodePromptSpec } : {}),
    execution: task.execution,
  };
}

function profileSeedProfile(profile: AgentProfile): Partial<AgentProfile> {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.agentRef ? { agentRef: profile.agentRef } : {}),
    ...(profile.workerKind ? { workerKind: profile.workerKind } : {}),
    provider: profile.provider,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinkingLevel ? { thinkingLevel: profile.thinkingLevel } : {}),
    ...(profile.harnessRef ? { harnessRef: profile.harnessRef } : {}),
    ...(profile.promptTemplateRef ? { promptTemplateRef: profile.promptTemplateRef } : {}),
    skillRefs: profile.skillRefs,
    mcpGrantRefs: profile.mcpGrantRefs,
    vaultLeasePolicyRefs: profile.vaultLeasePolicyRefs ?? [],
    memoryScopes: profile.memoryScopes,
    contextPolicyRef: profile.contextPolicyRef,
    sessionPolicyRef: profile.sessionPolicyRef,
    toolPolicy: profile.toolPolicy,
    budgetPolicy: profile.budgetPolicy,
    agentsMdRefs: profile.agentsMdRefs,
  };
}

function nodePromptType(task: WorkflowTaskDefinition): string | undefined {
  const nodePromptSpec = task.promptInputs?.nodePromptSpec;
  return nodePromptSpec && typeof nodePromptSpec === "object" && "nodeType" in nodePromptSpec
    ? String(nodePromptSpec.nodeType)
    : undefined;
}

function dynamicRepairRootFailedTaskId(task: WorkflowTaskDefinition, taskRow?: TaskRow): string | undefined {
  const dynamicRepair = task.promptInputs?.dynamicRepair ?? snapshotDynamicRepair(taskRow?.snapshot_json);
  if (!dynamicRepair || typeof dynamicRepair !== "object") return undefined;
  if ("rootFailedTaskId" in dynamicRepair && typeof dynamicRepair.rootFailedTaskId === "string") {
    return dynamicRepair.rootFailedTaskId;
  }
  if ("originalFailedTaskId" in dynamicRepair && typeof dynamicRepair.originalFailedTaskId === "string") {
    return dynamicRepair.originalFailedTaskId;
  }
  return undefined;
}

function snapshotDynamicRepair(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object" || !("dynamicRepair" in snapshot)) return undefined;
  return (snapshot as { dynamicRepair?: unknown }).dynamicRepair;
}

async function nextRepairRound(
  db: SouthstarDb,
  input: {
    runId: string;
    rootFailedTaskId: string;
    workflow: SouthstarWorkflowManifest;
    taskRows: TaskRow[];
  },
): Promise<number> {
  const row = await db.one<{ max_round: string }>(
    `select coalesce(max(
        case
          when jsonb_typeof(payload_json->'round') = 'number'
          then (payload_json->>'round')::int
          else null
        end
      ), count(*)::int, 0)::text as max_round
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'workflow_dynamic_repair_revision'
        and coalesce(payload_json->>'rootFailedTaskId', payload_json->>'originalFailedTaskId') = $2
        and status = 'applied'`,
    [input.runId, input.rootFailedTaskId],
  );
  const rounds = [
    Number.parseInt(row.max_round, 10) || 0,
    ...existingDynamicRepairRounds(input.workflow, input.taskRows, input.rootFailedTaskId),
  ];
  return Math.max(0, ...rounds) + 1;
}

function existingDynamicRepairRounds(
  workflow: SouthstarWorkflowManifest,
  taskRows: TaskRow[],
  rootFailedTaskId: string,
): number[] {
  const rounds: number[] = [];
  for (const task of workflow.tasks) {
    const round = dynamicRepairRound(task.promptInputs?.dynamicRepair)
      ?? dynamicRepairTaskIdRound(task.id, rootFailedTaskId);
    if (round) rounds.push(round);
  }
  for (const row of taskRows) {
    const round = dynamicRepairRound(snapshotDynamicRepair(row.snapshot_json))
      ?? dynamicRepairTaskIdRound(row.id, rootFailedTaskId);
    if (round) rounds.push(round);
  }
  return rounds;
}

function dynamicRepairRound(dynamicRepair: unknown): number | undefined {
  if (!dynamicRepair || typeof dynamicRepair !== "object" || !("round" in dynamicRepair)) return undefined;
  const round = (dynamicRepair as { round?: unknown }).round;
  const value = typeof round === "number" ? round : typeof round === "string" ? Number.parseInt(round, 10) : NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function dynamicRepairTaskIdRound(taskId: string, rootFailedTaskId: string): number | undefined {
  if (!/^(repair|reverify)-/.test(taskId) || !taskId.includes(rootFailedTaskId)) return undefined;
  const match = /-attempt-(\d+)$/.exec(taskId);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
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

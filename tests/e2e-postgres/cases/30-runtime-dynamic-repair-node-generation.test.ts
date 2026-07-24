import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../../../src/v2/design-library/library-graph-store.ts";
import type { SouthstarWorkflowManifest } from "../../../src/v2/manifests/types.ts";
import {
  createWorkflowRunPg,
  createWorkflowTaskPg,
  listHistoryForRunPg,
  listResourcesPg,
  updateWorkflowManifestPg,
} from "../../../src/v2/stores/postgres-runtime-store.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  dockerReachableUrl,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForTorkJob,
} from "../postgres-real-harness.ts";
import {
  createRealRecoveryScheduler,
  firstAttemptId,
  latestHandExecutionForTask,
  waitForHandExecutionStatus,
} from "../recovery-scheduler-helpers.ts";
import {
  contextPolicy,
  memoryPolicy,
  sessionPolicy,
  workspacePolicy,
} from "../../v2/fixtures/runtime-manifest-primitives.ts";

test("30 runtime dynamic repair node generation: failed validation callback appends repair tasks and reconnects downstream", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const runId = "real-runtime-dynamic-repair-node-generation";
    const implementTaskId = "implement-feature";
    const verifyTaskId = "verify-feature";
    const downstreamTaskId = "summarize-feature";
    await seedRepairPrimitives(env.db);
    await seedRun(env.db, { runId, implementTaskId, verifyTaskId, downstreamTaskId });

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
    });

    const implementDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(implementDispatch.dispatchedTaskIds, [implementTaskId]);
    const implementHand = await latestHandExecutionForTask(env.db, { runId, taskId: implementTaskId });
    await waitForTorkJob(infra.torkBaseUrl, implementHand.externalJobId);
    assert.equal(await waitForHandExecutionStatus(env.db, implementHand.resourceKey, ["completed", "failed"]), "completed");

    const acceptedArtifact = await latestArtifactRef(env.db, { runId, taskId: implementTaskId, status: "accepted" });
    await updateWorkflowManifestPg(env.db, runId, JSON.stringify(workflowManifest({
      implementTaskId,
      verifyTaskId,
      downstreamTaskId,
      verificationFault: { failedArtifactRef: acceptedArtifact.resourceKey },
    })));

    const verifyDispatch = await scheduler.runOnce({ runId });
    assert.deepEqual(verifyDispatch.dispatchedTaskIds, [verifyTaskId]);
    const verifyHand = await latestHandExecutionForTask(env.db, { runId, taskId: verifyTaskId });
    assert.equal(verifyHand.attemptId, firstAttemptId(verifyTaskId));
    await waitForTorkJob(infra.torkBaseUrl, verifyHand.externalJobId);
    assert.equal(await waitForHandExecutionStatus(env.db, verifyHand.resourceKey, ["completed", "failed"]), "failed");

    const tasks = await env.db.query<{ id: string; status: string; depends_on_json: unknown; snapshot_json: Record<string, unknown> }>(
      "select id, status, depends_on_json, snapshot_json from southstar.workflow_tasks where run_id = $1 order by sort_order",
      [runId],
    );
    assert.deepEqual(tasks.rows.slice(0, 2).map((task) => `${task.id}:${task.status}`), [
      "implement-feature:completed",
      "verify-feature:failed",
    ]);
    const downstreamTask = tasks.rows.find((task) => task.id === downstreamTaskId);
    assert.ok(downstreamTask);
    assert.equal(downstreamTask.status, "pending");
    const appendedTasks = tasks.rows.filter((task) => {
      const dynamicRepair = task.snapshot_json.dynamicRepair as { rootFailedTaskId?: unknown; failedTaskId?: unknown } | undefined;
      return dynamicRepair?.rootFailedTaskId === verifyTaskId && dynamicRepair.failedTaskId === verifyTaskId;
    });
    assert.equal(appendedTasks.length >= 2, true);
    assert.equal(appendedTasks.every((task) => task.status === "pending"), true);
    assert.deepEqual(appendedTasks[0]?.depends_on_json, ["implement-feature"]);
    assert.deepEqual(appendedTasks.at(-1)?.depends_on_json, [appendedTasks.at(-2)?.id]);
    assert.deepEqual(downstreamTask.depends_on_json, [appendedTasks.at(-1)?.id]);

    const run = await env.db.one<{ status: string; workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select status, workflow_manifest_json from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.equal(run.status, "running");
    for (const task of appendedTasks) {
      assert.equal(run.workflow_manifest_json.tasks.some((manifestTask) => manifestTask.id === task.id), true);
    }
    assert.deepEqual(
      run.workflow_manifest_json.tasks.find((task) => task.id === downstreamTaskId)?.dependsOn,
      [appendedTasks.at(-1)?.id],
    );

    const revisions = (await listResourcesPg(env.db, { resourceType: "workflow_dynamic_repair_revision" }))
      .filter((resource) => resource.runId === runId);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.status, "applied");
    const revisionSummary = revisions[0]?.summary as {
      newTaskIds?: string[];
      downstreamDependencyChanges?: Array<{ taskId: string; dependsOn: string[] }>;
    };
    const newTaskIds = appendedTasks.map((task) => task.id);
    assert.deepEqual(revisionSummary.newTaskIds, newTaskIds);
    assert.deepEqual(revisionSummary.downstreamDependencyChanges, [{
      taskId: downstreamTaskId,
      dependsOn: [appendedTasks.at(-1)?.id],
    }]);
    assertLlmGeneratedProfilesApplied({
      manifest: run.workflow_manifest_json,
      revisionPayload: revisions[0]?.payload,
      newTaskIds,
    });

    const history = await listHistoryForRunPg(env.db, runId);
    assert.equal(history.some((event) => event.eventType === "workflow.dynamic_repair_revision_applied"), true);
  } finally {
    await server.close();
    await env.close();
    await closeFetchKeepAliveHandles();
    closeExternalHttpsHandles();
  }
});

async function seedRun(
  db: SouthstarDb,
  input: { runId: string; implementTaskId: string; verifyTaskId: string; downstreamTaskId: string },
): Promise<void> {
  const workflow = workflowManifest(input);
  await createWorkflowRunPg(db, {
    id: input.runId,
    status: "scheduling",
    domain: "software",
    goalPrompt: workflow.goalPrompt,
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: input.implementTaskId,
    runId: input.runId,
    taskKey: "Implement Feature",
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
    snapshot: { agentProfileRef: "profile.impl" },
  });
  await createWorkflowTaskPg(db, {
    id: input.verifyTaskId,
    runId: input.runId,
    taskKey: "Verify Feature",
    status: "pending",
    sortOrder: 1,
    dependsOn: [input.implementTaskId],
    snapshot: { agentProfileRef: "profile.verify" },
  });
  await createWorkflowTaskPg(db, {
    id: input.downstreamTaskId,
    runId: input.runId,
    taskKey: "Summarize Feature",
    status: "pending",
    sortOrder: 2,
    dependsOn: [input.verifyTaskId],
    snapshot: { agentProfileRef: "profile.impl" },
  });
}

function workflowManifest(input: {
  implementTaskId: string;
  verifyTaskId: string;
  downstreamTaskId: string;
  verificationFault?: { failedArtifactRef: string };
}): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-runtime-dynamic-repair-node-generation",
    title: "Runtime dynamic repair node generation",
    goalPrompt: "Build and verify a todo feature, then create dynamic repair nodes if verification fails.",
    domain: "software",
    roles: [
      {
        id: "implementer",
        responsibility: "Implement the feature",
        defaultAgentProfileRef: "profile.impl",
        allowedAgentProfileRefs: ["profile.impl"],
        artifactInputs: [],
        artifactOutputs: ["todo_app"],
        stopAuthority: "can-suggest",
      },
      {
        id: "verifier",
        responsibility: "Verify the feature",
        defaultAgentProfileRef: "profile.verify",
        allowedAgentProfileRefs: ["profile.verify"],
        artifactInputs: ["todo_app"],
        artifactOutputs: ["verification_report"],
        stopAuthority: "can-suggest",
      },
    ],
    agentProfiles: [
      agentProfile("profile.impl", "Implementer", "execution_worker"),
      agentProfile("profile.verify", "Verifier", "validation_worker"),
    ],
    tasks: [
      workflowTask(input.implementTaskId, "Implement Feature", "implementer", "profile.impl", [], undefined),
      workflowTask(input.verifyTaskId, "Verify Feature", "verifier", "profile.verify", [input.implementTaskId], input.verificationFault),
      workflowTask(input.downstreamTaskId, "Summarize Feature", "implementer", "profile.impl", [input.verifyTaskId], undefined),
    ],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    artifactContracts: [
      { id: "todo_app", artifactType: "todo_app", requiredFields: ["summary"], evidenceFields: ["summary"] },
      { id: "verification_report", artifactType: "verification_report", requiredFields: ["summary"], evidenceFields: ["summary"] },
    ],
    evaluatorPipelines: [{
      id: "schema-evaluator-v1",
      evaluators: [],
      onFailure: { defaultStrategy: "request-workflow-revision" },
    }],
    contextPolicies: [contextPolicy()],
    sessionPolicies: [sessionPolicy()],
    memoryPolicies: [memoryPolicy()],
    workspacePolicies: [workspacePolicy()],
    stopConditions: [],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["todo_app", "verification_report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

function agentProfile(
  id: string,
  name: string,
  workerKind: "execution_worker" | "validation_worker",
): SouthstarWorkflowManifest["agentProfiles"][number] {
  return {
    id,
    name,
    agentRef: "agent.frontend-developer",
    provider: "pi",
    model: "pi-agent-default",
    workerKind,
    harnessRef: "pi",
    promptTemplateRef: id,
    contextPolicyRef: "context.generated",
    sessionPolicyRef: "session.generated",
    skillRefs: [],
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    memoryScopes: [],
    agentsMdRefs: [],
    toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 1000, maxOutputTokens: 1000, maxWallTimeSeconds: 60 },
  };
}

function workflowTask(
  id: string,
  name: string,
  roleRef: string,
  agentProfileRef: string,
  dependsOn: string[],
  fault?: { failedArtifactRef: string },
): SouthstarWorkflowManifest["tasks"][number] {
  return {
    id,
    name,
    domain: "software",
    roleRef,
    agentProfileRef,
    dependsOn,
    requiredArtifactRefs: id.startsWith("verify") ? ["verification_report"] : ["todo_app"],
    evaluatorPipelineRef: "schema-evaluator-v1",
    recoveryStrategyRefs: ["request-workflow-revision"],
    execution: {
      engine: "tork",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      env: fault ? {
        SOUTHSTAR_AGENT_RUNNER_FAULT: JSON.stringify({
          kind: "validation_missing_fields",
          fields: ["summary"],
          attemptIds: [firstAttemptId(id)],
          failedArtifactRefs: [fault.failedArtifactRef],
          reason: "real E2E verifier failure before dynamic repair node generation",
        }),
      } : {},
      mounts: [],
      timeoutSeconds: 600,
      infraRetry: { maxAttempts: 1 },
    },
    rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
    skillRefs: [],
    instructionRefs: [],
    toolGrantRefs: [],
    vaultLeasePolicyRefs: [],
    memoryScopeRefs: [],
    mcpGrantRefs: [],
    subagents: [{ id: `${id}-hand`, harnessId: "pi", prompt: name, requiredArtifacts: [] }],
  };
}

async function seedRepairPrimitives(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, { objectKey: "capability.frontend-ui", objectKind: "capability_spec", status: "approved", headVersionId: "capability.frontend-ui@1", state: { scope: "software", title: "Frontend UI" } });
  await upsertLibraryObject(db, { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", headVersionId: "agent.frontend-developer@1", state: { scope: "software", title: "Frontend Developer" } });
  await upsertLibraryObject(db, { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", headVersionId: "skill.react-ui@1", state: { scope: "software", title: "React UI" } });
  await upsertLibraryObject(db, { objectKey: "tool.workspace-write", objectKind: "tool_definition", status: "approved", headVersionId: "tool.workspace-write@1", state: { scope: "global", title: "Workspace Write", runtimeToolNames: ["edit", "write"] } });
  await upsertLibraryObject(db, { objectKey: "mcp.filesystem-workspace", objectKind: "mcp_tool_grant", status: "approved", headVersionId: "mcp.filesystem-workspace@1", state: { scope: "global", title: "Filesystem Workspace" } });
  await upsertLibraryObject(db, { objectKey: "instruction.react-review", objectKind: "instruction_template", status: "approved", headVersionId: "instruction.react-review@1", state: { scope: "software", title: "React Review" } });
  await upsertLibraryObject(db, { objectKey: "artifact.todo_app", objectKind: "artifact_contract", status: "approved", headVersionId: "artifact.todo_app@1", state: { scope: "software", title: "Todo app artifact" } });
  await upsertLibraryObject(db, { objectKey: "evaluator.todo-quality", objectKind: "evaluator_profile", status: "approved", headVersionId: "evaluator.todo-quality@1", state: { scope: "software", title: "Todo quality evaluator" } });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "provides_capability", toObjectKey: "capability.frontend-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "uses", toObjectKey: "skill.react-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "produces_artifact", toObjectKey: "artifact.todo_app", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "uses_instruction", toObjectKey: "instruction.react-review", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "evaluator.todo-quality", edgeType: "validates_artifact", toObjectKey: "artifact.todo_app", scope: "software" });
}

async function latestArtifactRef(
  db: SouthstarDb,
  input: { runId: string; taskId: string; status: "accepted" | "rejected" },
) {
  const resources = (await listResourcesPg(db, { resourceType: "artifact_ref" }))
    .filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId && resource.status === input.status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const resource = resources[0];
  if (!resource) throw new Error(`artifact_ref not found for ${input.runId}/${input.taskId}/${input.status}`);
  return resource;
}

async function closeFetchKeepAliveHandles(): Promise<void> {
  const undici = await import("undici") as unknown as {
    getGlobalDispatcher?: () => { close?: () => Promise<void> | void };
  };
  await undici.getGlobalDispatcher?.().close?.();
}

function closeExternalHttpsHandles(): void {
  const activeHandles = (process as unknown as {
    _getActiveHandles?: () => Array<{ destroy?: () => void; remotePort?: number; remoteAddress?: string }>;
  })._getActiveHandles?.() ?? [];
  for (const handle of activeHandles) {
    if (handle.remotePort === 443 && handle.remoteAddress && !isLocalAddress(handle.remoteAddress)) {
      handle.destroy?.();
    }
  }
}

function isLocalAddress(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "0.0.0.0" || value.startsWith("172.17.");
}

function assertLlmGeneratedProfilesApplied(input: {
  manifest: SouthstarWorkflowManifest;
  revisionPayload: unknown;
  newTaskIds: string[];
}): void {
  const payload = input.revisionPayload as {
    composition?: {
      tasks?: Array<{ id?: string; agentProfileRef?: string }>;
      generatedComponentProposals?: Array<{
        id?: string;
        kind?: string;
        validationStatus?: string;
        agentProfile?: {
          workerKind?: string;
          provider?: string;
          model?: string;
          harnessRef?: string;
          instruction?: string;
          toolPolicy?: { allowedTools?: string[] };
          execution?: {
            engine?: string;
            image?: string;
            command?: string[];
          };
        };
      }>;
    };
  };
  const composition = payload.composition;
  assert.equal(composition?.tasks?.length >= 2, true);
  assert.equal(composition?.generatedComponentProposals?.length >= 2, true);

  const generatedProfiles = new Map(
    (composition?.generatedComponentProposals ?? [])
      .filter((proposal) => proposal.kind === "agent_profile" && proposal.validationStatus === "validated" && proposal.id)
      .map((proposal) => [proposal.id as string, proposal]),
  );
  const appendedManifestTasks = input.newTaskIds.map((taskId) => {
    const task = input.manifest.tasks.find((candidate) => candidate.id === taskId);
    assert.ok(task, `manifest task not found: ${taskId}`);
    return task;
  });
  const profileRefs = appendedManifestTasks.map((task) => task.agentProfileRef);
  assert.equal(profileRefs.every((profileRef) => generatedProfiles.has(profileRef)), true);

  const manifestProfiles = new Map((input.manifest.agentProfiles ?? []).map((profile) => [profile.id, profile]));
  const workerKinds = new Set<string>();
  for (const profileRef of profileRefs) {
    const generated = generatedProfiles.get(profileRef)?.agentProfile;
    const manifestProfile = manifestProfiles.get(profileRef);
    assert.ok(generated, `generated profile not found in composition: ${profileRef}`);
    assert.ok(manifestProfile, `generated profile not merged into manifest: ${profileRef}`);
    assert.equal(manifestProfile.provider, "pi");
    assert.equal(manifestProfile.model, "pi-agent-default");
    assert.equal(manifestProfile.harnessRef, "pi");
    assert.equal(generated.provider, "pi");
    assert.equal(generated.model, "pi-agent-default");
    assert.equal(generated.harnessRef, "pi");
    assert.equal(typeof generated.instruction === "string" && generated.instruction.length > 20, true);
    assert.equal(generated.execution?.engine, "tork");
    assert.equal(generated.execution?.image, "southstar/pi-agent:local");
    assert.deepEqual(generated.execution?.command, ["southstar-agent-runner"]);
    assert.equal(generated.toolPolicy?.allowedTools?.includes("tool.workspace-write"), true);
    if (generated.workerKind) workerKinds.add(generated.workerKind);
  }
  assert.equal(workerKinds.has("repair_worker"), true);
  assert.equal(workerKinds.has("validation_worker"), true);
}

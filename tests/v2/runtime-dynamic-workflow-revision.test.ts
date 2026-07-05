import assert from "node:assert/strict";
import test from "node:test";
import {
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { createExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import { maybeApplyDynamicRepairRevisionPg } from "../../src/v2/runtime-revision/dynamic-repair-revision.ts";
import { ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("dynamic repair revision appends repair and reverify tasks for failed validation worker", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-verify-failed",
      runId: "run-dynamic-repair",
      taskId: "verify-feature",
      sessionId: "session-verify",
      scope: "artifact",
      status: "rejected",
      title: "Rejected verification report",
      payload: {
        artifactType: "verification_report",
        summary: "npm test failed in todo component",
        findings: ["button handler missing"],
      },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair",
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "npm test failed in todo component", findings: ["button handler missing"] },
      workflowComposer: new ScriptedWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "applied");
    assert.deepEqual(result.newTaskIds, ["repair-verify-feature-attempt-1", "reverify-verify-feature-attempt-1"]);

    const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      ["run-dynamic-repair"],
    );
    const repairTask = run.workflow_manifest_json.tasks.find((task) => task.id === "repair-verify-feature-attempt-1");
    const reverifyTask = run.workflow_manifest_json.tasks.find((task) => task.id === "reverify-verify-feature-attempt-1");
    assert.ok(repairTask);
    assert.ok(reverifyTask);
    assert.deepEqual(repairTask.dependsOn, ["implement-feature"]);
    assert.deepEqual(reverifyTask.dependsOn, ["repair-verify-feature-attempt-1"]);
    assert.equal(
      run.workflow_manifest_json.agentProfiles?.some((profile) => profile.id === "profile.generated.dynamic-repair.repair"),
      true,
    );

    const rows = await db.query<{ id: string; status: string; sort_order: number; depends_on_json: string[]; snapshot_json: Record<string, unknown> }>(
      "select id, status, sort_order, depends_on_json, snapshot_json from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-dynamic-repair"],
    );
    assert.deepEqual(rows.rows.map((row) => row.id), [
      "implement-feature",
      "verify-feature",
      "repair-verify-feature-attempt-1",
      "reverify-verify-feature-attempt-1",
    ]);
    assert.equal(rows.rows[2]?.status, "pending");
    assert.deepEqual(rows.rows[2]?.depends_on_json, ["implement-feature"]);
    const dynamicRepair = rows.rows[2]?.snapshot_json.dynamicRepair as {
      failedTaskId?: string;
      failedArtifactRefId?: string;
      round?: number;
    };
    assert.equal(dynamicRepair.failedTaskId, "verify-feature");
    assert.equal(dynamicRepair.failedArtifactRefId, "artifact-ref-verify-failed");
    assert.equal(dynamicRepair.round, 1);

    const resources = await listResourcesPg(db, { resourceType: "workflow_dynamic_repair_revision" });
    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.status, "applied");
    const history = await listHistoryForRunPg(db, "run-dynamic-repair");
    assert.equal(history.some((event) => event.eventType === "workflow.dynamic_repair_revision_applied"), true);
  } finally {
    await db.close();
  }
});

test("failed validation callback applies dynamic repair revision before completion gate", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    await createWorkflowRunPg(db, {
      id: "run-callback-dynamic-repair",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify({}),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-callback-dynamic-repair",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-callback-dynamic-repair",
      taskKey: "Verify Feature",
      status: "running",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      rootSessionId: "session-verify",
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createExecutorBindingPg(db, {
      runId: "run-callback-dynamic-repair",
      taskId: "verify-feature",
      attemptId: "attempt-1",
      torkJobId: "job-verify",
      status: "running",
      now: "2026-07-05T10:00:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });

    const result = await ingestTaskRunResultPg(db, {
      runId: "run-callback-dynamic-repair",
      taskId: "verify-feature",
      rootSessionId: "session-verify",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "verification_report", summary: "npm test failed", findings: ["missing handler"] },
      metrics: { tokens: 20 },
      receivedAt: "2026-07-05T10:05:00.000Z",
      events: [],
    }, {
      workflowComposer: new ScriptedWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.accepted, false);
    assert.equal(result.dynamicRepairRevision?.status, "applied");
    const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", ["run-callback-dynamic-repair"]);
    assert.equal(run.status, "running");
    const tasks = await db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-callback-dynamic-repair"],
    );
    assert.deepEqual(tasks.rows.map((task) => `${task.id}:${task.status}`), [
      "implement-feature:completed",
      "verify-feature:failed",
      "repair-verify-feature-attempt-1:pending",
      "reverify-verify-feature-attempt-1:pending",
    ]);
  } finally {
    await db.close();
  }
});

function baseWorkflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-dynamic-repair",
    title: "Dynamic Repair Workflow",
    goalPrompt: "Build a todo feature",
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
      {
        id: "profile.impl",
        name: "Implementer",
        agentRef: "agent.frontend-developer",
        provider: "pi",
        model: "pi-agent-default",
        workerKind: "execution_worker",
        harnessRef: "pi",
        promptTemplateRef: "implement",
        contextPolicyRef: "context.generated",
        sessionPolicyRef: "session.generated",
        skillRefs: [],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
        memoryScopes: [],
        agentsMdRefs: [],
        toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
        budgetPolicy: { maxInputTokens: 1000, maxOutputTokens: 1000, maxWallTimeSeconds: 60 },
      },
      {
        id: "profile.verify",
        name: "Verifier",
        agentRef: "agent.frontend-developer",
        provider: "pi",
        model: "pi-agent-default",
        workerKind: "validation_worker",
        harnessRef: "pi",
        promptTemplateRef: "verify",
        contextPolicyRef: "context.generated",
        sessionPolicyRef: "session.generated",
        skillRefs: [],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
        memoryScopes: [],
        agentsMdRefs: [],
        toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
        budgetPolicy: { maxInputTokens: 1000, maxOutputTokens: 1000, maxWallTimeSeconds: 60 },
      },
    ],
    tasks: [
      workflowTask("implement-feature", "Implement Feature", "implementer", "profile.impl", []),
      workflowTask("verify-feature", "Verify Feature", "verifier", "profile.verify", ["implement-feature"]),
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

function workflowTask(id: string, name: string, roleRef: string, agentProfileRef: string, dependsOn: string[]) {
  return {
    id,
    name,
    domain: "software" as const,
    roleRef,
    agentProfileRef,
    dependsOn,
    requiredArtifactRefs: id.startsWith("verify") ? ["verification_report"] : ["todo_app"],
    evaluatorPipelineRef: "schema-evaluator-v1",
    recoveryStrategyRefs: ["request-workflow-revision"],
    execution: {
      engine: "tork" as const,
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      env: {},
      mounts: [],
      timeoutSeconds: 900,
      infraRetry: { maxAttempts: 1 },
    },
    rootSession: { validator: "schema-evaluator-v1" as const, maxRepairAttempts: 2 },
    skillRefs: [],
    instructionRefs: [],
    toolGrantRefs: [],
    vaultLeasePolicyRefs: [],
    memoryScopeRefs: [],
    mcpGrantRefs: [],
    subagents: [{ id: `${roleRef}-${id}`, harnessId: "pi", prompt: name, requiredArtifacts: [] }],
  };
}

function repairCompositionPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Dynamic verifier repair",
    selectedWorkflowTemplateRef: "template.graph-dynamic-workflow",
    rationale: "Repair and reverify the failed verifier report.",
    tasks: [
      {
        id: "repair",
        name: "Repair failed verification",
        responsibility: "Use the failed verification report to repair the implementation.",
        dependsOn: [],
        templateSlotRef: "repair",
        agentDefinitionRef: "agent.frontend-developer",
        agentProfileRef: "profile.generated.dynamic-repair.repair",
        instructionRefs: ["instruction.react-review"],
        skillRefs: ["skill.react-ui"],
        toolGrantRefs: ["tool.workspace-write"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        vaultLeasePolicyRefs: [],
        inputArtifactRefs: ["artifact.todo_app"],
        outputArtifactRefs: ["artifact.todo_app"],
        evaluatorProfileRef: "evaluator.todo-quality",
        recoveryStrategyRefs: ["request-workflow-revision"],
        rationale: "Repair worker uses approved primitives.",
      },
      {
        id: "reverify",
        name: "Reverify repaired implementation",
        responsibility: "Verify the repaired implementation and produce a verification report.",
        dependsOn: ["repair"],
        templateSlotRef: "reverify",
        agentDefinitionRef: "agent.frontend-developer",
        agentProfileRef: "profile.generated.dynamic-repair.reverify",
        instructionRefs: ["instruction.react-review"],
        skillRefs: ["skill.react-ui"],
        toolGrantRefs: ["tool.workspace-write"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        vaultLeasePolicyRefs: [],
        inputArtifactRefs: ["artifact.todo_app"],
        outputArtifactRefs: ["artifact.todo_app"],
        evaluatorProfileRef: "evaluator.todo-quality",
        recoveryStrategyRefs: ["request-workflow-revision"],
        rationale: "Reverification worker uses approved primitives.",
      },
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [
      generatedProfile("profile.generated.dynamic-repair.repair", "repair_worker"),
      generatedProfile("profile.generated.dynamic-repair.reverify", "validation_worker"),
    ],
  };
}

function generatedProfile(id: string, workerKind: "repair_worker" | "validation_worker") {
  return {
    id,
    kind: "agent_profile" as const,
    risk: "medium" as const,
    reason: "Generated from approved graph primitives.",
    validationStatus: "validated" as const,
    agentProfile: {
      workerKind,
      provider: "pi" as const,
      model: "pi-agent-default",
      thinkingLevel: "high",
      harnessRef: "pi" as const,
      instruction: workerKind === "repair_worker"
        ? "Repair the implementation using the failed verifier report in context."
        : "Reverify the repaired implementation and produce a verification report.",
      promptTemplateRef: "react-review",
      contextPolicyRef: "context.generated",
      sessionPolicyRef: "session.generated",
      memoryScopes: [],
      agentsMdRefs: [],
      vaultLeasePolicyRefs: [],
      toolPolicy: { allowedTools: ["tool.workspace-write"], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 120000, maxOutputTokens: 8192, maxWallTimeSeconds: 900 },
      execution: {
        engine: "tork" as const,
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
    },
  };
}

async function seedDynamicRepairPrimitives(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, { objectKey: "capability.frontend-ui", objectKind: "capability_spec", status: "approved", headVersionId: "capability.frontend-ui@1", state: { scope: "software", title: "Frontend UI" } });
  await upsertLibraryObject(db, { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", headVersionId: "agent.frontend-developer@1", state: { scope: "software", title: "Frontend Developer" } });
  await upsertLibraryObject(db, { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", headVersionId: "skill.react-ui@1", state: { scope: "software", title: "React UI" } });
  await upsertLibraryObject(db, { objectKey: "tool.workspace-write", objectKind: "tool_definition", status: "approved", headVersionId: "tool.workspace-write@1", state: { scope: "global", title: "Workspace Write" } });
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

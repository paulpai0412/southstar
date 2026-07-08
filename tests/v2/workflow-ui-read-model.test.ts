import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowUiReadModelPg } from "../../src/v2/read-models/workflow-ui.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("workflow ui read model exposes runtime DAG and selected definition", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "build workflow canvas",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-ui",
        tasks: [
          { id: "task-plan", name: "Plan", dependsOn: [], roleRef: "planner", agentProfileRef: "planner-codex" },
          { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder", agentProfileRef: "builder-codex" },
          { id: "task-review", name: "Review", dependsOn: ["task-plan"], roleRef: "reviewer", agentProfileRef: "reviewer-codex" },
          { id: "task-release", name: "Release", dependsOn: ["task-build"], roleRef: "releaser", agentProfileRef: "releaser-codex" },
          { id: "task-done", name: "Done", dependsOn: ["task-plan"], roleRef: "closer", agentProfileRef: "closer-codex" },
        ],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-plan", runId, taskKey: "Plan", status: "completed", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 1, dependsOn: ["task-plan"] });
    await createWorkflowTaskPg(db, { id: "task-review", runId, taskKey: "Review", status: "ready", sortOrder: 2, dependsOn: ["task-plan"] });
    await createWorkflowTaskPg(db, { id: "task-release", runId, taskKey: "Release", status: "blocked", sortOrder: 3, dependsOn: ["task-build"] });
    await createWorkflowTaskPg(db, { id: "task-done", runId, taskKey: "Done", status: "completed", sortOrder: 4, dependsOn: ["task-plan"] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-ref-task-plan",
      runId,
      taskId: "task-plan",
      scope: "artifact",
      status: "accepted",
      payload: { artifactRefId: "artifact-ref-task-plan" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "executor_binding",
      resourceKey: "executor-binding-task-build",
      runId,
      taskId: "task-build",
      scope: "executor",
      status: "running",
      title: "Tork job running",
      payload: { executorType: "tork", jobId: "job-build" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "runtime_exception",
      resourceKey: "runtime-exception-task-build",
      runId,
      taskId: "task-build",
      scope: "runtime",
      status: "observed",
      title: "Callback missing",
      payload: { kind: "callback_missing", severity: "blocking" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "approval",
      resourceKey: "approval-task-build",
      runId,
      taskId: "task-build",
      scope: "approval",
      status: "pending",
      title: "Approve recovery",
      payload: { actionType: "recovery" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "recovery_decision",
      resourceKey: "recovery-task-build",
      runId,
      taskId: "task-build",
      scope: "recovery",
      status: "proposed",
      title: "Requeue task",
      payload: { strategy: "requeue_task" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-build",
      runId,
      taskId: "task-build",
      scope: "task",
      status: "created",
      payload: {
        envelope: {
          role: { id: "builder" },
          agentProfile: { id: "builder-codex" },
          artifactContract: { kind: "implementation_result" },
          skills: [{ id: "southstar" }],
          materializedLibraryRefs: {
            skillRefs: ["southstar"],
            mcpGrantRefs: ["github-read"],
            toolGrantRefs: ["shell"],
          },
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId, taskId: "task-build" });
    assert.equal(model.canvasModel.graphId, runId);
    assert.equal(model.canvasModel.mode, "runtime");
    assert.deepEqual(model.canvasModel.edges.map((edge) => [edge.source, edge.target, edge.status]), [
      ["task-plan", "task-build", "active"],
      ["task-plan", "task-review", "ready"],
      ["task-build", "task-release", "blocked"],
      ["task-plan", "task-done", "satisfied"],
    ]);
    const buildNode = model.canvasModel.nodes.find((node: { id: string }) => node.id === "task-build");
    assert.equal(buildNode?.kind, "task");
    assert.equal(buildNode?.agentProfileRef, "builder-codex");
    assert.deepEqual(buildNode?.badges.map((badge) => badge.label), [
      "executor running",
      "exception observed",
      "approval pending",
      "recovery proposed",
    ]);
    assert.deepEqual(buildNode?.attention, { severity: "blocked", reason: "Callback missing" });
    assert.equal(model.selectedDefinition?.taskId, "task-build");
    assert.equal((model.selectedDefinition?.artifactContract as { kind?: string } | undefined)?.kind, "implementation_result");
    assert.deepEqual((model.selectedDefinition?.materializedLibraryRefs as { skillRefs?: string[] } | undefined)?.skillRefs, ["southstar"]);
    assert.equal(model.activeDraft, null);
    assert.equal(model.agentLibrarySummary.domain, "software");
    assert.equal(model.agentLibrarySummary.roleCount, 0);
    assert.equal(model.validationIssues.length, 0);
    assert.equal(model.repairAttempts, 0);
    assert.ok(model.commands.some((command: { id: string; enabled: boolean }) => command.id === "open-agent-library" && command.enabled));
  } finally {
    await db.close();
  }
});

test("workflow ui renders dynamic repair as caused by failed verifier without changing runtime dependencies", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui-dynamic-repair";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "repair failed verification",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-dynamic-repair-ui",
        tasks: [
          { id: "task-plan", name: "Plan", dependsOn: [] },
          { id: "task-implement", name: "Implement", dependsOn: ["task-plan"] },
          { id: "task-verify", name: "Verify", dependsOn: ["task-implement"] },
          { id: "task-review", name: "Review", dependsOn: ["reverify-task-verify-attempt-1"] },
          { id: "repair-task-verify-attempt-1", name: "Repair", dependsOn: ["task-implement"] },
          { id: "reverify-task-verify-attempt-1", name: "Reverify", dependsOn: ["repair-task-verify-attempt-1"] },
        ],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-plan", runId, taskKey: "Plan", status: "completed", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "task-implement", runId, taskKey: "Implement", status: "completed", sortOrder: 1, dependsOn: ["task-plan"] });
    await createWorkflowTaskPg(db, { id: "task-verify", runId, taskKey: "Verify", status: "failed", sortOrder: 2, dependsOn: ["task-implement"] });
    await createWorkflowTaskPg(db, { id: "task-review", runId, taskKey: "Review", status: "completed", sortOrder: 3, dependsOn: ["reverify-task-verify-attempt-1"] });
    await createWorkflowTaskPg(db, {
      id: "repair-task-verify-attempt-1",
      runId,
      taskKey: "Repair",
      status: "completed",
      sortOrder: 4,
      dependsOn: ["task-implement"],
      snapshot: { dynamicRepair: { failedTaskId: "task-verify", rootFailedTaskId: "task-verify", round: 1 } },
    });
    await createWorkflowTaskPg(db, {
      id: "reverify-task-verify-attempt-1",
      runId,
      taskKey: "Reverify",
      status: "completed",
      sortOrder: 5,
      dependsOn: ["repair-task-verify-attempt-1"],
      snapshot: { dynamicRepair: { failedTaskId: "task-verify", rootFailedTaskId: "task-verify", round: 1 } },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId });
    const repairNode = model.canvasModel.nodes.find((node: { id: string }) => node.id === "repair-task-verify-attempt-1");
    assert.deepEqual(repairNode?.dependsOn, ["task-implement"]);
    assert.ok(model.canvasModel.edges.some((edge) => edge.source === "task-verify" && edge.target === "repair-task-verify-attempt-1"));
    assert.ok(!model.canvasModel.edges.some((edge) => edge.source === "task-implement" && edge.target === "repair-task-verify-attempt-1"));
  } finally {
    await db.close();
  }
});

test("workflow ui runtime selected definition prefers materialized task envelope details over software library fallback", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-workflow-ui-envelope-definition";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "inspect runtime envelope",
      workflowManifestJson: JSON.stringify({
        workflowId: "wf-envelope-definition",
        tasks: [{
          id: "task-build",
          name: "Build",
          dependsOn: [],
          roleRef: "builder",
          agentProfileRef: "builder-codex",
          skillRefs: ["manifest-skill"],
          mcpGrantRefs: ["manifest-mcp"],
          toolGrantRefs: ["manifest-tool"],
        }],
      }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "task-build", runId, taskKey: "Build", status: "running", sortOrder: 0, dependsOn: [] });
    await upsertRuntimeResourcePg(db, {
      resourceType: "task_envelope",
      resourceKey: "task-envelope-build",
      runId,
      taskId: "task-build",
      scope: "task",
      status: "created",
      payload: {
        envelope: {
          role: { id: "builder", source: "runtime-envelope-role" },
          agentProfile: { id: "builder-codex", source: "runtime-envelope-profile" },
          evaluatorPipeline: { id: "runtime-evaluator", source: "runtime-envelope-evaluator" },
          contextPolicy: { id: "runtime-context", source: "runtime-envelope-context" },
          vaultPolicy: { id: "runtime-vault-primary", source: "runtime-envelope-vault" },
          vaultPolicies: [{ id: "runtime-vault-primary" }, { id: "runtime-vault-secondary" }],
          artifactContract: { id: "runtime-artifact", source: "runtime-envelope-artifact" },
          materializedLibraryRefs: {
            skillRefs: ["runtime-skill"],
            mcpGrantRefs: ["runtime-mcp"],
            toolGrantRefs: ["runtime-tool"],
            vaultLeasePolicyRefs: ["runtime-vault-primary"],
            evaluatorPipelineRef: "runtime-evaluator",
            contextPolicyRef: "runtime-context",
            artifactContractRef: "runtime-artifact",
          },
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { runId, taskId: "task-build" });
    assert.equal((model.selectedDefinition as any).roleDefinition.source, "runtime-envelope-role");
    assert.equal((model.selectedDefinition as any).agentProfile.source, "runtime-envelope-profile");
    assert.equal((model.selectedDefinition as any).evaluatorPipeline.source, "runtime-envelope-evaluator");
    assert.equal((model.selectedDefinition as any).contextPolicy.source, "runtime-envelope-context");
    assert.equal((model.selectedDefinition as any).vaultPolicy.source, "runtime-envelope-vault");
    assert.deepEqual((model.selectedDefinition as any).vaultPolicies.map((policy: { id: string }) => policy.id), [
      "runtime-vault-primary",
      "runtime-vault-secondary",
    ]);
    assert.equal((model.selectedDefinition as any).artifactContract.source, "runtime-envelope-artifact");
    assert.deepEqual(model.selectedDefinition?.skillRefs, ["runtime-skill"]);
    assert.deepEqual(model.selectedDefinition?.mcpGrantRefs, ["runtime-mcp"]);
    assert.deepEqual(model.selectedDefinition?.toolGrantRefs, ["runtime-tool"]);
    assert.deepEqual((model.selectedDefinition?.materializedLibraryRefs as { skillRefs?: string[] } | undefined)?.skillRefs, ["runtime-skill"]);
  } finally {
    await db.close();
  }
});

test("ui route exposes draft workflow canvas via /api/v2/ui/workflow", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-ui";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-draft-ui",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [] },
            { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder", agentProfileRef: "builder-codex" },
          ],
        },
      },
      summary: {
        goalPrompt: "draft workflow ui",
        validationIssues: [{ path: "workflow.tasks", message: "none" }],
      },
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const response = await fetch(`${server.url}/api/v2/ui/workflow?draftId=${encodeURIComponent(draftId)}&taskId=task-build`);
      assert.equal(response.status, 200);
      const envelope = await response.json() as { ok: true; kind: string; result: Awaited<ReturnType<typeof buildWorkflowUiReadModelPg>> };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.kind, "ui-workflow");
      assert.equal(envelope.result.canvasModel.graphId, draftId);
      assert.equal(envelope.result.canvasModel.mode, "draft");
      assert.equal(envelope.result.canvasModel.selectedNodeId, "task-build");
      assert.equal(envelope.result.canvasModel.nodes[0]?.kind, "task");
      assert.deepEqual(envelope.result.canvasModel.edges, [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "pending" }]);
      assert.equal(envelope.result.selectedDefinition?.taskId, "task-build");
      assert.equal(envelope.result.activeDraft?.draftId, draftId);
      assert.equal(envelope.result.activeDraft?.goalPrompt, "draft workflow ui");
      assert.equal(envelope.result.validationIssues.length, 1);
      assert.equal(envelope.result.validationIssues[0]?.path, "workflow.tasks");
      assert.equal(envelope.result.repairAttempts, 0);
      assert.ok(envelope.result.commands.some((command: { id: string; enabled: boolean }) => command.id === "run-draft" && command.enabled));
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

test("workflow ui draft validation issues target explicit task indexes without badging unaffected nodes", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-indexed-validation";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-indexed-validation",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [], roleRef: "missing-role" },
            { id: "task-build", name: "Build", dependsOn: ["task-plan"], roleRef: "builder" },
          ],
        },
      },
      summary: {
        goalPrompt: "indexed validation targeting",
        validationIssues: [{ path: "workflow.tasks[0].roleRef", message: "roleRef is unknown" }],
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId });
    const planNode = model.canvasModel.nodes.find((node) => node.id === "task-plan");
    const buildNode = model.canvasModel.nodes.find((node) => node.id === "task-build");
    assert.equal(planNode?.status, "blocked");
    assert.deepEqual(planNode?.badges.filter((badge) => badge.label.startsWith("validation issues")).map((badge) => badge.label), [
      "validation issues 1",
    ]);
    assert.equal(buildNode?.status, "ready");
    assert.deepEqual(buildNode?.badges.filter((badge) => badge.label.startsWith("validation")).map((badge) => badge.label), [
      "validation passed",
    ]);
  } finally {
    await db.close();
  }
});

test("workflow ui draft read model exposes selected definition depth planner trace repair details and draft badges", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-definition-depth";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-definition-depth",
          domain: "software",
          goalPrompt: "implement calc sum",
          tasks: [{
            id: "implement",
            name: "Implement",
            dependsOn: ["understand"],
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            artifactContractRef: "implementation_report",
            evaluatorPipelineRef: "software-feature-quality",
            vaultLeasePolicyRefs: ["vault.github-write-token"],
            skillRefs: ["software.calc-cli"],
            mcpGrantRefs: ["filesystem-workspace"],
            toolGrantRefs: ["read", "search", "edit", "shell"],
          }],
        },
        plannerTrace: {
          manifestRef: "planner.manifest_generated:123",
          validationRef: "manifest.validated:123",
        },
        repairAttempts: [{
          attempt: 1,
          reason: "missing evaluator pipeline",
          status: "repaired",
          traceRef: "planner.repair:1",
        }],
      },
      summary: {
        goalPrompt: "implement calc sum",
        validationIssues: [],
        plannerTrace: {
          summaryRef: "summary.trace:1",
        },
      },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId, taskId: "implement" });
    const implementNode = model.canvasModel.nodes.find((node) => node.id === "implement");
    assert.equal(implementNode?.status, "ready");
    assert.deepEqual(implementNode?.badges.map((badge) => badge.label), [
      "role maker",
      "profile software-maker-pi",
      "skills 1",
      "mcp 1",
      "tools 4",
      "validation passed",
      "repair repaired",
    ]);
    assert.equal(model.selectedDefinition?.taskId, "implement");
    assert.equal((model.selectedDefinition as any).roleDefinition, undefined);
    assert.equal((model.selectedDefinition as any).agentProfile, undefined);
    assert.equal((model.selectedDefinition as any).vaultPolicy.id, "vault.github-write-token");
    assert.equal((model.selectedDefinition as any).artifactContract, undefined);
    assert.equal((model.selectedDefinition as any).evaluatorPipeline, undefined);
    assert.equal((model.selectedDefinition as any).contextPolicy, undefined);
    assert.equal((model.plannerTrace as any).manifestRef, "planner.manifest_generated:123");
    assert.equal((model.plannerTrace as any).summaryRef, "summary.trace:1");
    assert.deepEqual(model.repairAttemptDetails, [{
      attempt: 1,
      reason: "missing evaluator pipeline",
      status: "repaired",
      traceRef: "planner.repair:1",
    }]);
  } finally {
    await db.close();
  }
});

test("workflow ui draft selected definition exposes editable profile override and effective profile", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-profile-override";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-profile-override",
          domain: "software",
          tasks: [{
            id: "task-build",
            name: "Build",
            dependsOn: [],
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            skillRefs: ["software.calc-cli"],
            mcpGrantRefs: [],
            profileOverride: {
              provider: "codex",
              model: "gpt-5-codex",
              thinkingLevel: "high",
              instruction: "Use small patches.",
              skillRefs: ["software.calc-cli", "software.test-evidence"],
              mcpGrantRefs: ["filesystem-workspace"],
            },
          }],
        },
      },
      summary: { goalPrompt: "profile override read model", workflowId: "wf-profile-override" },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId, taskId: "task-build" });

    assert.equal(model.selectedDefinition?.editable, true);
    assert.equal((model.selectedDefinition as any).profileOverride.model, "gpt-5-codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.model, "gpt-5-codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.provider, "codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.thinkingLevel, "high");
    assert.equal((model.selectedDefinition as any).effectiveProfile.instruction, "Use small patches.");
    assert.deepEqual((model.selectedDefinition as any).effectiveProfile.skillRefs, ["software.calc-cli", "software.test-evidence"]);
    assert.deepEqual((model.selectedDefinition as any).effectiveProfile.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(model.selectedDefinition?.skillRefs, ["software.calc-cli", "software.test-evidence"]);
  } finally {
    await db.close();
  }
});

test("ui compatibility routes mirror workflow and operator overview payloads", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-compat";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-draft-compat",
          tasks: [
            { id: "task-plan", name: "Plan", dependsOn: [] },
            { id: "task-build", name: "Build", dependsOn: ["task-plan"] },
          ],
        },
      },
      summary: {
        goalPrompt: "draft workflow compatibility",
        validationIssues: [],
      },
    });
    await createWorkflowRunPg(db, {
      id: "run-workflow-compat",
      status: "running",
      domain: "software",
      goalPrompt: "operator overview compatibility",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: { generate: async () => { throw new Error("planner not used"); } },
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const workflow = await fetch(`${server.url}/api/v2/ui/workflow?draftId=${encodeURIComponent(draftId)}`);
      const workflowTab = await fetch(`${server.url}/api/v2/ui/workflow-tab?draftId=${encodeURIComponent(draftId)}`);
      assert.equal(workflow.status, 200);
      assert.equal(workflowTab.status, 200);
      const workflowEnvelope = await workflow.json() as { ok: true; kind: string; result: unknown };
      const workflowTabEnvelope = await workflowTab.json() as { ok: true; kind: string; result: unknown };
      assert.equal(workflowEnvelope.kind, "ui-workflow");
      assert.equal(workflowTabEnvelope.kind, "ui-workflow");
      assert.deepEqual(workflowTabEnvelope.result, workflowEnvelope.result);

      const operator = await fetch(`${server.url}/api/v2/ui/operator-overview`);
      const operationsTab = await fetch(`${server.url}/api/v2/ui/operations-tab`);
      const operatorAttention = await fetch(`${server.url}/api/v2/ui/operator-attention`);
      assert.equal(operator.status, 200);
      assert.equal(operationsTab.status, 200);
      assert.equal(operatorAttention.status, 200);
      const operatorEnvelope = await operator.json() as { ok: true; kind: string; result: unknown };
      const operationsEnvelope = await operationsTab.json() as { ok: true; kind: string; result: unknown };
      const attentionEnvelope = await operatorAttention.json() as { ok: true; kind: string; result: unknown };
      assert.equal(operatorEnvelope.kind, "ui-operator-overview");
      assert.equal(operationsEnvelope.kind, "ui-operator-overview");
      assert.equal(attentionEnvelope.kind, "ui-operator-overview");
      assert.deepEqual(operationsEnvelope.result, operatorEnvelope.result);
      assert.deepEqual(attentionEnvelope.result, operatorEnvelope.result);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

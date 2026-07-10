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
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { softwareGoalContract, subscriptionGoalContract } from "./fixtures/goal-contract.ts";

test("dynamic repair revision appends repair and reverify tasks for failed validation worker", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
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
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "applied", JSON.stringify(result));
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
    const revisionPayload = resources[0]?.payload as {
      goalContractHash?: string;
      goalRequirementCoverage?: { goalContractHash?: string };
      orchestrationSnapshot?: { goalContractHash?: string };
    };
    assert.equal(revisionPayload.goalContractHash, lineage.goalContractHash);
    assert.equal(revisionPayload.goalRequirementCoverage?.goalContractHash, lineage.goalContractHash);
    assert.equal(revisionPayload.orchestrationSnapshot?.goalContractHash, lineage.goalContractHash);
    const history = await listHistoryForRunPg(db, "run-dynamic-repair");
    assert.equal(history.some((event) => event.eventType === "workflow.dynamic_repair_revision_applied"), true);
  } finally {
    await db.close();
  }
});

test("dynamic repair scopes compound Goal Contract coverage to the failed task requirement ids", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const goalContract = subscriptionGoalContract();
    const billingRequirement = goalContract.requirements[1]!;
    const workflow = baseWorkflow();
    const failedTask = workflow.tasks.find((task) => task.id === "verify-feature")!;
    failedTask.promptInputs = { requirementIds: [billingRequirement.id] };
    const lineage = await seedPlannerDraftLineage(
      db,
      "run-dynamic-repair-compound-billing",
      workflow.goalPrompt,
      goalContract,
    );
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-compound-billing",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-compound-billing",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-compound-billing",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-compound-billing",
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer(
        [repairCompositionPlan()],
        [billingRequirement.id],
      ),
    });

    assert.equal(result.status, "applied", JSON.stringify(result));
    const resources = await listResourcesPg(db, { resourceType: "workflow_dynamic_repair_revision" });
    const payload = resources.find((resource) => resource.runId === "run-dynamic-repair-compound-billing")?.payload as {
      goalContractHash?: string;
      goalRequirementCoverage?: {
        goalContractHash?: string;
        entries?: Array<{ requirementId?: string }>;
      };
    };
    assert.equal(payload.goalContractHash, goalContractHash(goalContract));
    assert.equal(payload.goalRequirementCoverage?.goalContractHash, goalContractHash(goalContract));
    assert.deepEqual(
      payload.goalRequirementCoverage?.entries?.map((entry) => entry.requirementId),
      [billingRequirement.id],
    );
    const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      ["run-dynamic-repair-compound-billing"],
    );
    const appendedTasks = run.workflow_manifest_json.tasks.filter((task) =>
      task.id.includes("verify-feature-attempt-1")
    );
    assert.equal(appendedTasks.length, 2);
    assert.equal(appendedTasks.every((task) =>
      JSON.stringify(task.promptInputs?.requirementIds) === JSON.stringify([billingRequirement.id])
    ), true);
  } finally {
    await db.close();
  }
});

test("dynamic repair fails closed when the run has no planner draft Goal Contract lineage", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-missing-lineage",
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
      runId: "run-dynamic-repair-missing-lineage",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-missing-lineage",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-missing-lineage",
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.deepEqual(result, { status: "skipped", reason: "goal-contract-lineage-missing:draftId" });
  } finally {
    await db.close();
  }
});

test("dynamic repair fails closed when the run and planner draft Goal Contract hashes disagree", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-hash-mismatch", workflow.goalPrompt);
    const runtimeContext = JSON.parse(lineage.runtimeContextJson) as Record<string, unknown>;
    runtimeContext.goalContractHash = "0".repeat(64);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-hash-mismatch",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: JSON.stringify(runtimeContext),
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-hash-mismatch",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-hash-mismatch",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-hash-mismatch",
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.deepEqual(result, { status: "skipped", reason: "goal-contract-hash-mismatch" });
  } finally {
    await db.close();
  }
});

test("dynamic repair prompt seeds repair from implement profile and reverify from verifier profile", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-profile-hints", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-profile-hints",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-profile-hints",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-profile-hints",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });

    const composer = new CapturingWorkflowComposer(repairCompositionPlan());
    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-profile-hints",
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "npm test failed in todo component", findings: ["button handler missing"] },
      workflowComposer: composer,
    });

    assert.equal(result.status, "applied");
    assert.equal(composer.goalPrompts.length, 1);
    const prompt = composer.goalPrompts[0] ?? "";
    assert.match(prompt, /Profile reuse hints:/);
    assert.match(prompt, /"repairProfileSeed"/);
    assert.match(prompt, /"seedTaskId": "implement-feature"/);
    assert.match(prompt, /"seedAgentProfileId": "profile.impl"/);
    assert.match(prompt, /"seedPurpose": "repair_from_implementation"/);
    assert.match(prompt, /"reverifyProfileSeed"/);
    assert.match(prompt, /"seedTaskId": "verify-feature"/);
    assert.match(prompt, /"seedAgentProfileId": "profile.verify"/);
    assert.match(prompt, /"seedPurpose": "reverify_from_failed_validation"/);
    assert.match(prompt, /Use repairProfileSeed as the preferred source/);
    assert.match(prompt, /Use reverifyProfileSeed as the preferred source/);
    assert.match(prompt, /Do not reuse the original profile ids directly/);
    assert.match(prompt, /workerKind=repair_worker/);
    assert.match(prompt, /workerKind=validation_worker/);
  } finally {
    await db.close();
  }
});

test("dynamic repair revision reconnects pending downstream tasks after generated reverify", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    workflow.tasks.push(workflowTask("summarize-release", "Summarize Release", "implementer", "profile.impl", ["verify-feature"]));
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-downstream", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-downstream",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-downstream",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-downstream",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createWorkflowTaskPg(db, {
      id: "summarize-release",
      runId: "run-dynamic-repair-downstream",
      taskKey: "Summarize Release",
      status: "pending",
      sortOrder: 2,
      dependsOn: ["verify-feature"],
      snapshot: { agentProfileRef: "profile.impl" },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-downstream",
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "npm test failed in todo component", findings: ["button handler missing"] },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "applied");
    assert.deepEqual(result.newTaskIds, ["repair-verify-feature-attempt-1", "reverify-verify-feature-attempt-1"]);
    const reconnectTargetId = "reverify-verify-feature-attempt-1";

    const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      ["run-dynamic-repair-downstream"],
    );
    const summaryTask = run.workflow_manifest_json.tasks.find((task) => task.id === "summarize-release");
    assert.ok(summaryTask);
    assert.deepEqual(summaryTask.dependsOn, [reconnectTargetId]);

    const rows = await db.query<{ id: string; status: string; depends_on_json: string[] }>(
      "select id, status, depends_on_json from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-dynamic-repair-downstream"],
    );
    assert.deepEqual(rows.rows.map((row) => `${row.id}:${row.status}:${row.depends_on_json.join(",")}`), [
      "implement-feature:completed:",
      "verify-feature:failed:implement-feature",
      `summarize-release:pending:${reconnectTargetId}`,
      "repair-verify-feature-attempt-1:pending:implement-feature",
      "reverify-verify-feature-attempt-1:pending:repair-verify-feature-attempt-1",
    ]);

    const resources = await listResourcesPg(db, { resourceType: "workflow_dynamic_repair_revision" });
    assert.deepEqual((resources[0]?.summary as { downstreamDependencyChanges?: unknown }).downstreamDependencyChanges, [{
      taskId: "summarize-release",
      dependsOn: [reconnectTargetId],
    }]);
  } finally {
    await db.close();
  }
});

test("dynamic repair limits consecutive reverify repair chain by root failed task", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    workflow.tasks.push(workflowTask("summarize-release", "Summarize Release", "implementer", "profile.impl", ["verify-feature"]));
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-chain-limit", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-chain-limit",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-chain-limit",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-chain-limit",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createWorkflowTaskPg(db, {
      id: "summarize-release",
      runId: "run-dynamic-repair-chain-limit",
      taskKey: "Summarize Release",
      status: "pending",
      sortOrder: 2,
      dependsOn: ["verify-feature"],
      snapshot: { agentProfileRef: "profile.impl" },
    });

    const first = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-chain-limit",
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "first verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
      maxDynamicRepairRounds: 2,
    });

    assert.equal(first.status, "applied");
    const firstReverifyId = "reverify-verify-feature-attempt-1";
    await removeManifestDynamicRepairLineage(db, "run-dynamic-repair-chain-limit", firstReverifyId);
    await db.query(
      "update southstar.workflow_tasks set status = 'failed', completed_at = now(), updated_at = now() where run_id = $1 and id = $2",
      ["run-dynamic-repair-chain-limit", firstReverifyId],
    );
    const secondComposer = new CapturingWorkflowComposer(repairCompositionPlan());
    const second = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-chain-limit",
      failedTaskId: firstReverifyId,
      failedArtifactRefId: "artifact-ref-reverify-failed",
      failedArtifact: { summary: "reverify failed after first repair" },
      workflowComposer: secondComposer,
      maxDynamicRepairRounds: 2,
    });

    assert.equal(second.status, "applied");
    assert.deepEqual(second.newTaskIds, [
      "repair-reverify-verify-feature-attempt-1-attempt-2",
      "reverify-reverify-verify-feature-attempt-1-attempt-2",
    ]);
    const secondPrompt = secondComposer.goalPrompts[0] ?? "";
    assert.match(secondPrompt, /Root failed validation task: verify-feature/);
    assert.match(secondPrompt, /"seedTaskId": "repair-verify-feature-attempt-1"/);
    assert.match(secondPrompt, /"seedAgentProfileId": "profile.generated.dynamic-repair.repair"/);

    const secondReverifyId = "reverify-reverify-verify-feature-attempt-1-attempt-2";
    const rowsAfterSecond = await db.query<{ id: string; depends_on_json: string[]; snapshot_json: Record<string, unknown> }>(
      "select id, depends_on_json, snapshot_json from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-dynamic-repair-chain-limit"],
    );
    assert.deepEqual(
      rowsAfterSecond.rows.find((row) => row.id === "summarize-release")?.depends_on_json,
      [secondReverifyId],
    );
    const secondRepairSnapshot = rowsAfterSecond.rows.find((row) => row.id === "repair-reverify-verify-feature-attempt-1-attempt-2")?.snapshot_json.dynamicRepair as {
      rootFailedTaskId?: string;
      originalFailedTaskId?: string;
      failedTaskId?: string;
      round?: number;
    };
    assert.equal(secondRepairSnapshot.rootFailedTaskId, "verify-feature");
    assert.equal(secondRepairSnapshot.originalFailedTaskId, "verify-feature");
    assert.equal(secondRepairSnapshot.failedTaskId, firstReverifyId);
    assert.equal(secondRepairSnapshot.round, 2);

    await db.query(
      "update southstar.workflow_tasks set status = 'failed', completed_at = now(), updated_at = now() where run_id = $1 and id = $2",
      ["run-dynamic-repair-chain-limit", secondReverifyId],
    );
    const third = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-chain-limit",
      failedTaskId: secondReverifyId,
      failedArtifactRefId: "artifact-ref-reverify-2-failed",
      failedArtifact: { summary: "reverify failed after second repair" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
      maxDynamicRepairRounds: 2,
    });
    assert.deepEqual(third, { status: "skipped", reason: "dynamic-repair-round-limit" });

    const resources = await listResourcesPg(db, { resourceType: "workflow_dynamic_repair_revision" });
    const chainResources = resources.filter((resource) => resource.runId === "run-dynamic-repair-chain-limit");
    assert.equal(chainResources.length, 2);
    assert.deepEqual(chainResources.map((resource) => (resource.payload as { rootFailedTaskId?: string; round?: number }).rootFailedTaskId), [
      "verify-feature",
      "verify-feature",
    ]);
    assert.deepEqual(chainResources.map((resource) => (resource.payload as { round?: number }).round), [1, 2]);
  } finally {
    await db.close();
  }
});

test("failed validation callback applies dynamic repair revision before completion gate", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-callback-dynamic-repair", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-callback-dynamic-repair",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
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
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
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

test("failing verification report semantics apply dynamic repair revision", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-callback-semantic-verification-failure", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-callback-semantic-verification-failure",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-callback-semantic-verification-failure",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-callback-semantic-verification-failure",
      taskKey: "Verify Feature",
      status: "running",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      rootSessionId: "session-verify",
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createExecutorBindingPg(db, {
      runId: "run-callback-semantic-verification-failure",
      taskId: "verify-feature",
      attemptId: "attempt-1",
      torkJobId: "job-verify",
      status: "running",
      now: "2026-07-05T10:00:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });

    const result = await ingestTaskRunResultPg(db, {
      runId: "run-callback-semantic-verification-failure",
      taskId: "verify-feature",
      rootSessionId: "session-verify",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: {
        verification_report: {
          pass: false,
          safeToSave: false,
          summary: "Verifier found blocking failures.",
          testResults: [{ checkId: "ui-alarm", status: "failed", gating: "blocking" }],
        },
      },
      metrics: { tokens: 20 },
      receivedAt: "2026-07-05T10:05:00.000Z",
      events: [],
    }, {
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.accepted, false);
    assert.equal(result.dynamicRepairRevision?.status, "applied");
    const tasks = await db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-callback-semantic-verification-failure"],
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

test("direct verification report fields apply dynamic repair revision", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-callback-direct-verification-failure", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-callback-direct-verification-failure",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-callback-direct-verification-failure",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-callback-direct-verification-failure",
      taskKey: "Verify Feature",
      status: "running",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      rootSessionId: "session-verify",
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createExecutorBindingPg(db, {
      runId: "run-callback-direct-verification-failure",
      taskId: "verify-feature",
      attemptId: "attempt-1",
      torkJobId: "job-verify",
      status: "running",
      now: "2026-07-05T10:00:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });

    const result = await ingestTaskRunResultPg(db, {
      runId: "run-callback-direct-verification-failure",
      taskId: "verify-feature",
      rootSessionId: "session-verify",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: {
        summary: "Verifier did not produce structured evidence.",
        pass: false,
        safeToSave: false,
        testResults: [{ checkId: "pi-sdk-structured-output", status: "not-verified", gating: "blocking" }],
      },
      metrics: { tokens: 20 },
      receivedAt: "2026-07-05T10:05:00.000Z",
      events: [],
    }, {
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.accepted, false);
    assert.equal(result.dynamicRepairRevision?.status, "applied");
    const tasks = await db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-callback-direct-verification-failure"],
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

test("failed callback advances dynamic repair round when prior repair task exists", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    workflow.tasks.push(workflowTask("repair-verify-feature-attempt-1", "Existing Repair", "implementer", "profile.impl", ["implement-feature"]));
    const lineage = await seedPlannerDraftLineage(db, "run-callback-invalid-dynamic-repair", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-callback-invalid-dynamic-repair",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-callback-invalid-dynamic-repair",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-callback-invalid-dynamic-repair",
      taskKey: "Verify Feature",
      status: "running",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      rootSessionId: "session-verify",
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createWorkflowTaskPg(db, {
      id: "repair-verify-feature-attempt-1",
      runId: "run-callback-invalid-dynamic-repair",
      taskKey: "Existing Repair",
      status: "pending",
      sortOrder: 2,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createExecutorBindingPg(db, {
      runId: "run-callback-invalid-dynamic-repair",
      taskId: "verify-feature",
      attemptId: "attempt-1",
      torkJobId: "job-verify",
      status: "running",
      now: "2026-07-05T10:00:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });

    const result = await ingestTaskRunResultPg(db, {
      runId: "run-callback-invalid-dynamic-repair",
      taskId: "verify-feature",
      rootSessionId: "session-verify",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "verification_report", summary: "verification failed" },
      metrics: { tokens: 20 },
      receivedAt: "2026-07-05T10:05:00.000Z",
      events: [],
    }, {
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.accepted, false);
    assert.equal(result.dynamicRepairRevision?.status, "applied");
    assert.deepEqual(result.dynamicRepairRevision?.newTaskIds, [
      "repair-verify-feature-attempt-2",
      "reverify-verify-feature-attempt-2",
    ]);

    const tasks = await db.query<{ id: string; status: string }>(
      "select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order",
      ["run-callback-invalid-dynamic-repair"],
    );
    assert.deepEqual(tasks.rows.map((task) => `${task.id}:${task.status}`), [
      "implement-feature:completed",
      "verify-feature:failed",
      "repair-verify-feature-attempt-1:pending",
      "repair-verify-feature-attempt-2:pending",
      "reverify-verify-feature-attempt-2:pending",
    ]);
    const history = await listHistoryForRunPg(db, "run-callback-invalid-dynamic-repair");
    const evaluated = history.find((event) => event.eventType === "workflow.dynamic_repair_revision_evaluated");
    assert.equal((evaluated?.payload as { status?: string } | undefined)?.status, "applied");
  } finally {
    await db.close();
  }
});

test("dynamic repair round advances when prior repair task exists without revision resource", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    workflow.tasks.push(workflowTask("repair-verify-feature-attempt-1", "Existing Repair", "implementer", "profile.impl", ["implement-feature"]));
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-existing-task-no-resource", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-existing-task-no-resource",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-existing-task-no-resource",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-existing-task-no-resource",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });
    await createWorkflowTaskPg(db, {
      id: "repair-verify-feature-attempt-1",
      runId: "run-dynamic-repair-existing-task-no-resource",
      taskKey: "Existing Repair",
      status: "pending",
      sortOrder: 2,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.impl" },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-existing-task-no-resource",
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "applied");
    assert.deepEqual(result.newTaskIds, [
      "repair-verify-feature-attempt-2",
      "reverify-verify-feature-attempt-2",
    ]);
  } finally {
    await db.close();
  }
});

test("dynamic repair revision retries invalid LLM composition before appending tasks", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const workflow = baseWorkflow();
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-composition-retry", workflow.goalPrompt);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-composition-retry",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-composition-retry",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-composition-retry",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });

    const invalid = repairCompositionPlan();
    invalid.tasks[0]!.agentDefinitionRef = "capability.frontend-ui";
    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-composition-retry",
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "npm test failed in todo component", findings: ["button handler missing"] },
      workflowComposer: new GoalContractBindingWorkflowComposer([invalid, repairCompositionPlan()]),
    });

    assert.equal(result.status, "applied");
    assert.deepEqual(result.newTaskIds, ["repair-verify-feature-attempt-1", "reverify-verify-feature-attempt-1"]);
    const resources = await listResourcesPg(db, { resourceType: "workflow_dynamic_repair_revision" });
    const dynamicResource = resources.find((resource) => resource.runId === "run-dynamic-repair-composition-retry");
    assert.equal((dynamicResource?.payload as { repairLoopAttempts?: unknown[] } | undefined)?.repairLoopAttempts?.length, 2);
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
    promptInputs: {
      requirementIds: softwareGoalContract("Build a todo feature").requirements.map((requirement) => requirement.id),
    },
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

async function removeManifestDynamicRepairLineage(db: SouthstarDb, runId: string, taskId: string) {
  const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const workflow = {
    ...run.workflow_manifest_json,
    tasks: run.workflow_manifest_json.tasks.map((task) => {
      if (task.id !== taskId || !task.promptInputs?.dynamicRepair) return task;
      const { dynamicRepair: _dynamicRepair, ...promptInputs } = task.promptInputs;
      return { ...task, promptInputs };
    }),
  };
  await db.query(
    "update southstar.workflow_runs set workflow_manifest_json = $2::jsonb, updated_at = now() where id = $1",
    [runId, JSON.stringify(workflow)],
  );
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
        requirementIds: [],
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
        requirementIds: [],
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

class GoalContractBindingWorkflowComposer implements WorkflowComposer {
  private index = 0;

  constructor(
    private readonly plans: WorkflowCompositionPlan[],
    private readonly targetRequirementIds?: string[],
  ) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const plan = this.plans[Math.min(this.index, this.plans.length - 1)];
    this.index += 1;
    if (!plan) throw new Error("GoalContractBindingWorkflowComposer has no plans");
    return bindRequirementIds(plan, input, this.targetRequirementIds);
  }
}

class CapturingWorkflowComposer implements WorkflowComposer {
  readonly goalPrompts: string[] = [];

  constructor(private readonly plan: WorkflowCompositionPlan) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    this.goalPrompts.push(input.goalPrompt);
    return bindRequirementIds(this.plan, input);
  }
}

function bindRequirementIds(
  plan: WorkflowCompositionPlan,
  input: ComposeWorkflowInput,
  targetRequirementIds?: string[],
): WorkflowCompositionPlan {
  const copy = structuredClone(plan);
  const requirementIds = targetRequirementIds
    ?? input.goalContract.requirements.map((requirement) => requirement.id);
  copy.tasks.forEach((task) => {
    task.requirementIds = requirementIds;
  });
  return copy;
}

async function seedDynamicRepairPrimitives(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, { objectKey: "capability.frontend-ui", objectKind: "capability_spec", status: "approved", headVersionId: "capability.frontend-ui@1", state: { scope: "software", title: "Frontend UI" } });
  await upsertLibraryObject(db, { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", headVersionId: "agent.frontend-developer@1", state: { scope: "software", title: "Frontend Developer" } });
  await upsertLibraryObject(db, { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", headVersionId: "skill.react-ui@1", state: { scope: "software", title: "React UI", body: "# Instructions\n\nBuild React UI." } });
  await upsertLibraryObject(db, { objectKey: "tool.workspace-write", objectKind: "tool_definition", status: "approved", headVersionId: "tool.workspace-write@1", state: { scope: "global", title: "Workspace Write", toolName: "workspace-write", proxyToolName: "workspace-write-proxy" } });
  await upsertLibraryObject(db, { objectKey: "mcp.filesystem-workspace", objectKind: "mcp_tool_grant", status: "approved", headVersionId: "mcp.filesystem-workspace@1", state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] } });
  await upsertLibraryObject(db, { objectKey: "instruction.react-review", objectKind: "instruction_template", status: "approved", headVersionId: "instruction.react-review@1", state: { scope: "software", title: "React Review", content: "Use React best practices.", variables: [] } });
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

async function seedPlannerDraftLineage(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
  goalPrompt: string,
  goalContract: GoalContractV1 = softwareGoalContract(goalPrompt),
): Promise<{ goalContract: GoalContractV1; goalContractHash: string; runtimeContextJson: string }> {
  const contractHash = goalContractHash(goalContract);
  const draftId = `draft-${runId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: `Planner draft for ${runId}`,
    payload: { goalContract, goalContractHash: contractHash },
    summary: { goalContractHash: contractHash },
  });
  return {
    goalContract,
    goalContractHash: contractHash,
    runtimeContextJson: JSON.stringify({ draftId, goalContractHash: contractHash }),
  };
}

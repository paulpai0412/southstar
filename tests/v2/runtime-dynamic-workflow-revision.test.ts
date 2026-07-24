import assert from "node:assert/strict";
import test from "node:test";
import {
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { contentHashForPayload } from "../../src/v2/design-library/canonical-json.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { createExecutorBindingPg } from "../../src/v2/executor/postgres-bindings.ts";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import { dynamicRepairReconnectTargetTaskId, maybeApplyDynamicRepairRevisionPg } from "../../src/v2/runtime-revision/dynamic-repair-revision.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { goalContractHash, type GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import { captureRunLibrarySnapshotPg } from "../../src/v2/orchestration/run-library-snapshot.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import type { RuntimeServerContext } from "../../src/v2/server/runtime-context.ts";
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
    await seedActiveRepairProtection(db, "run-dynamic-repair", workflow, lineage);
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
    const accessRequirement = goalContract.requirements[0]!;
    const billingRequirement = goalContract.requirements[1]!;
    const workflow = baseWorkflow();
    const failedTask = workflow.tasks.find((task) => task.id === "verify-feature")!;
    failedTask.promptInputs = { requirementIds: [accessRequirement.id, billingRequirement.id], sliceId: "slice-billing" };
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
    await seedActiveRepairProtection(db, "run-dynamic-repair-compound-billing", workflow, lineage);
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
      failedRequirementIds: [billingRequirement.id],
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
    const coverageRevision = await db.one<{ payload_json: { effectiveCoverage: { entries: Array<{ requirementId: string; producerTaskIds: string[]; evaluatorTaskIds: string[] }> } } }>(
      "select payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_requirement_coverage_revision'",
      ["run-dynamic-repair-compound-billing"],
    );
    const preservedAccess = coverageRevision.payload_json.effectiveCoverage.entries.find((entry) => entry.requirementId === accessRequirement.id);
    assert.deepEqual(preservedAccess?.producerTaskIds, ["implement-feature"]);
    assert.deepEqual(preservedAccess?.evaluatorTaskIds, ["verify-feature"]);
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
    assert.equal(appendedTasks.every((task) => task.promptInputs?.sliceId === "slice-billing"), true);
  } finally {
    await db.close();
  }
});

test("dynamic repair host-normalizes proposed slice and requirement ownership to frozen lineage", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicRepairPrimitives(db);
    const goalContract = subscriptionGoalContract();
    const billingRequirement = goalContract.requirements[1]!;
    const workflow = baseWorkflow();
    const failedTask = workflow.tasks.find((task) => task.id === "verify-feature")!;
    failedTask.promptInputs = { requirementIds: [billingRequirement.id], sliceId: "slice-billing" };
    const lineage = await seedPlannerDraftLineage(db, "run-dynamic-repair-moved-slice", workflow.goalPrompt, goalContract);
    await createWorkflowRunPg(db, {
      id: "run-dynamic-repair-moved-slice",
      status: "running",
      domain: "software",
      goalPrompt: workflow.goalPrompt,
      workflowManifestJson: JSON.stringify(workflow),
      executionProjectionJson: JSON.stringify({}),
      snapshotJson: JSON.stringify({}),
      runtimeContextJson: lineage.runtimeContextJson,
      metricsJson: JSON.stringify({}),
    });
    await seedActiveRepairProtection(db, "run-dynamic-repair-moved-slice", workflow, lineage);
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-dynamic-repair-moved-slice",
      taskKey: "Implement Feature",
      status: "completed",
      sortOrder: 0,
      dependsOn: [],
      snapshot: { agentProfileRef: "profile.impl" },
    });
    await createWorkflowTaskPg(db, {
      id: "verify-feature",
      runId: "run-dynamic-repair-moved-slice",
      taskKey: "Verify Feature",
      status: "failed",
      sortOrder: 1,
      dependsOn: ["implement-feature"],
      snapshot: { agentProfileRef: "profile.verify" },
    });
    const moved = repairCompositionPlan();
    moved.tasks[0]!.sliceId = "slice-admin";
    moved.tasks[0]!.requirementIds = [goalContract.requirements[0]!.id];

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-moved-slice",
      failedTaskId: "verify-feature",
      failedRequirementIds: [billingRequirement.id],
      workflowComposer: new GoalContractBindingWorkflowComposer([moved], [billingRequirement.id]),
    });

    assert.equal(result.status, "applied", JSON.stringify(result));
    const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      ["run-dynamic-repair-moved-slice"],
    );
    const appendedTasks = run.workflow_manifest_json.tasks.filter((task) => task.id.includes("verify-feature-attempt-1"));
    assert.equal(appendedTasks.length, 2);
    assert.equal(appendedTasks.every((task) => task.promptInputs?.sliceId === "slice-billing"), true);
    assert.equal(appendedTasks.every((task) => (
      JSON.stringify(task.promptInputs?.requirementIds) === JSON.stringify([billingRequirement.id])
    )), true);
  } finally {
    await db.close();
  }
});

test("dynamic repair waits for hash-bound approval before expanding frozen authority", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-authority-approval";
    const workflow = await seedFrozenDynamicRepairRun(db, runId, true);

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "waiting_operator_approval");
    assert.match(result.approvalId, /^dynamic-repair-approval:/);
    const current = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.deepEqual(current.workflow_manifest_json, workflow);
    const approval = await db.one<{ status: string; payload_json: { goalContractHash: string; librarySnapshotHash: string; requestedAuthority: unknown } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'approval' and resource_key = $1",
      [result.approvalId],
    );
    assert.equal(approval.status, "waiting_operator_approval");
    assert.match(approval.payload_json.goalContractHash, /^[a-f0-9]{64}$/);
    assert.match(approval.payload_json.librarySnapshotHash, /^[a-f0-9]{64}$/);
    assert.ok(approval.payload_json.requestedAuthority);

    await db.query(
      "update southstar.runtime_resources set status = 'approved', updated_at = now() where resource_type = 'approval' and resource_key = $1",
      [result.approvalId],
    );
    const approvedRetry = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    assert.equal(approvedRetry.status, "applied");
  } finally {
    await db.close();
  }
});

test("generic approval route resumes a persisted dynamic repair proposal without replaying the callback or LLM", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-route-continuation";
    await seedFrozenDynamicRepairRun(db, runId, true);
    const first = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    assert.equal(first.status, "waiting_operator_approval");
    assert.equal((await db.one<{ count: string }>(
      "select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'dynamic_repair_request' and status = 'waiting_operator_approval'",
      [runId],
    )).count, "1");
    const context = {
      db,
      workflowComposer: {
        async compose(): Promise<WorkflowCompositionPlan> {
          throw new Error("approval continuation must not call the LLM composer");
        },
      },
    } as unknown as RuntimeServerContext;
    const decide = () => handleRuntimeRoute(context, new Request(
      `http://southstar.test/api/v2/runs/${runId}/approvals/${encodeURIComponent(first.approvalId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved", reason: "approve exact persisted repair" }),
      },
    ));

    const approvals = await Promise.all([decide(), decide()]);
    const approvalBodies = await Promise.all(approvals.map((response) => response.clone().json()));
    assert.deepEqual(approvals.map((response) => response.status), [200, 200], JSON.stringify(approvalBodies));
    const run = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    assert.equal(run.status, "running");
    assert.equal((await db.one<{ count: string }>(
      "select count(*) as count from southstar.workflow_tasks where run_id = $1 and id like 'repair-%'",
      [runId],
    )).count, "1");
    assert.equal((await db.one<{ count: string }>(
      "select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'workflow_dynamic_repair_revision'",
      [runId],
    )).count, "1");
  } finally {
    await db.close();
  }
});

test("rejecting a persisted dynamic repair proposal terminalizes the goal as unsatisfied", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-route-rejected";
    await seedFrozenDynamicRepairRun(db, runId, true);
    const first = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    assert.equal(first.status, "waiting_operator_approval");
    const response = await handleRuntimeRoute({ db } as unknown as RuntimeServerContext, new Request(
      `http://southstar.test/api/v2/runs/${runId}/approvals/${encodeURIComponent(first.approvalId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected", reason: "authority expansion rejected" }),
      },
    ));

    assert.equal(response.status, 200);
    const run = await db.one<{ status: string; completed_at: string | null }>(
      "select status, completed_at from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.equal(run.status, "completed");
    assert.ok(run.completed_at);
    const outcome = await db.one<{ status: string; payload_json: { failedRequirementIds: string[] } }>(
      "select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_outcome'",
      [runId],
    );
    assert.equal(outcome.status, "unsatisfied");
    assert.deepEqual(
      outcome.payload_json.failedRequirementIds,
      softwareGoalContract("Build a todo feature").requirements.map((requirement) => requirement.id),
    );
  } finally {
    await db.close();
  }
});

test("concurrent opposite dynamic repair decisions commit exactly one continuation", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-opposite-decision-race";
    await seedFrozenDynamicRepairRun(db, runId, true);
    const first = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    assert.equal(first.status, "waiting_operator_approval");
    const context = { db } as unknown as RuntimeServerContext;
    const decide = (decision: "approved" | "rejected") => handleRuntimeRoute(context, new Request(
      `http://southstar.test/api/v2/runs/${runId}/approvals/${encodeURIComponent(first.approvalId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason: `${decision} race decision` }),
      },
    ));

    const responses = await Promise.all([decide("approved"), decide("rejected")]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    const repairCount = Number((await db.one<{ count: string }>(
      "select count(*) as count from southstar.workflow_tasks where run_id = $1 and id like 'repair-%'",
      [runId],
    )).count);
    const outcomeCount = Number((await db.one<{ count: string }>(
      "select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_outcome'",
      [runId],
    )).count);
    assert.equal(repairCount + outcomeCount, 1);
  } finally {
    await db.close();
  }
});

test("dynamic repair fails closed when a composed primitive is absent from the run Library snapshot", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-unknown-snapshot-ref";
    const workflow = await seedFrozenDynamicRepairRun(db, runId, false);

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.deepEqual(result, { status: "skipped", reason: "dynamic-repair-ref-version-not-in-run-snapshot:tool.workspace-write@1" });
    const current = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.deepEqual(current.workflow_manifest_json, workflow);
  } finally {
    await db.close();
  }
});

test("current manifest Library refs do not bypass a missing frozen snapshot entry", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-current-ref-missing-snapshot";
    await seedFrozenDynamicRepairRun(db, runId, false, false);

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.deepEqual(result, { status: "skipped", reason: "dynamic-repair-ref-version-not-in-run-snapshot:tool.workspace-write@1" });
  } finally {
    await db.close();
  }
});

test("dynamic repair requires exact snapshotted object versions", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-snapshot-version-drift";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    await upsertLibraryObject(db, {
      objectKey: "tool.workspace-write",
      objectKind: "tool_definition",
      status: "approved",
      headVersionId: "tool.workspace-write@2",
      state: { scope: "global", title: "Workspace Write v2", runtimeToolNames: ["edit", "write"] },
    });

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.deepEqual(result, {
      status: "skipped",
      reason: "dynamic-repair-ref-version-not-in-run-snapshot:tool.workspace-write@2",
    });
  } finally {
    await db.close();
  }
});

test("dynamic repair snapshot closure includes agents md and recovery context workspace policies", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-complete-snapshot-closure";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    for (const objectKey of [
      "instruction.repair-agents-md",
      "policy.repair-recovery",
      "policy.repair-context",
      "policy.repair-workspace",
    ]) {
      await upsertLibraryObject(db, {
        objectKey,
        objectKind: objectKey.startsWith("instruction.") ? "instruction_template" : "policy_bundle",
        status: "approved",
        headVersionId: `${objectKey}@1`,
        state: objectKey.startsWith("instruction.")
          ? { scope: "software", title: objectKey, content: "Repair agents instructions", variables: [] }
          : { scope: "software", title: objectKey },
      });
    }
    const plan = repairCompositionPlan();
    for (const task of plan.tasks) {
      task.recoveryStrategyRefs = ["policy.repair-recovery"];
      task.contextPolicyRef = "policy.repair-context";
      task.workspacePolicyRef = "policy.repair-workspace";
    }
    for (const proposal of plan.generatedComponentProposals) {
      if (proposal.agentProfile) proposal.agentProfile.agentsMdRefs = ["instruction.repair-agents-md"];
    }

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([plan]),
    });

    assert.deepEqual(result, {
      status: "skipped",
      reason: "dynamic-repair-ref-version-not-in-run-snapshot:instruction.repair-agents-md@1",
    });
  } finally {
    await db.close();
  }
});

test("dynamic repair snapshot closure includes generated profile context and session policies", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-generated-profile-policy-closure";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    for (const objectKey of ["policy.repair-context", "policy.repair-session"]) {
      await upsertLibraryObject(db, {
        objectKey,
        objectKind: "policy_bundle",
        status: "approved",
        headVersionId: `${objectKey}@1`,
        state: { scope: "software", title: objectKey },
      });
    }
    const plan = repairCompositionPlan();
    for (const proposal of plan.generatedComponentProposals) {
      if (!proposal.agentProfile) continue;
      proposal.agentProfile.contextPolicyRef = "policy.repair-context";
      proposal.agentProfile.sessionPolicyRef = "policy.repair-session";
    }

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([plan]),
    });

    assert.deepEqual(result, {
      status: "skipped",
      reason: "dynamic-repair-ref-version-not-in-run-snapshot:policy.repair-context@1",
    });
  } finally {
    await db.close();
  }
});

test("dynamic repair allows generated profiles to load repo-local AGENTS instructions", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-repo-agents-md";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    const plan = repairCompositionPlan();
    for (const proposal of plan.generatedComponentProposals) {
      if (proposal.agentProfile) proposal.agentProfile.agentsMdRefs = ["repo:AGENTS.md"];
    }

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([plan]),
    });

    assert.equal(result.status, "applied", JSON.stringify(result));
  } finally {
    await db.close();
  }
});

test("dynamic repair fails closed when a runtime recovery strategy has no Library candidate version", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-recovery-ref-without-candidate";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    const plan = repairCompositionPlan();
    for (const task of plan.tasks) task.recoveryStrategyRefs = ["policy.repair-absent"];

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([plan]),
    });

    assert.deepEqual(result, {
      status: "skipped",
      reason: "dynamic-repair-runtime-ref-version-missing:policy.repair-absent",
    });
  } finally {
    await db.close();
  }
});

test("dynamic repair treats removed tool approval requirements as authority relaxation", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-tool-policy-relaxation";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = jsonb_set(
            workflow_manifest_json,
            '{agentProfiles}',
            (select jsonb_agg(jsonb_set(profile, '{toolPolicy}',
              '{"allowedTools":["tool.workspace-write"],"deniedTools":[],"requiresApprovalFor":["tool.workspace-write"]}'::jsonb))
               from jsonb_array_elements(workflow_manifest_json->'agentProfiles') profile)
          )
        where id = $1`,
      [runId],
    );

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "waiting_operator_approval");
    const approval = await db.one<{ payload_json: { requestedAuthority: { removedDeniedTools?: string[]; removedApprovalRequirements?: string[] } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'approval' and resource_key = $1",
      [result.approvalId],
    );
    assert.deepEqual(approval.payload_json.requestedAuthority.removedDeniedTools, []);
    assert.deepEqual(approval.payload_json.requestedAuthority.removedApprovalRequirements, ["tool.workspace-write"]);
  } finally {
    await db.close();
  }
});

test("dynamic repair computes executable authority per profile instead of unioning tool policies", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-multi-profile-policy";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    await db.query(
      `update southstar.workflow_runs
          set workflow_manifest_json = jsonb_set(
            workflow_manifest_json,
            '{agentProfiles}',
            (select jsonb_agg(jsonb_set(profile, '{toolPolicy}',
              '{"allowedTools":["tool.workspace-write"],"deniedTools":["tool.workspace-write"],"requiresApprovalFor":[]}'::jsonb))
               from jsonb_array_elements(workflow_manifest_json->'agentProfiles') profile)
          )
        where id = $1`,
      [runId],
    );
    const plan = repairCompositionPlan();
    const reverify = plan.generatedComponentProposals.find((proposal) => proposal.id.includes("reverify"));
    if (!reverify?.agentProfile) assert.fail("missing generated reverify profile");
    reverify.agentProfile.toolPolicy = {
      allowedTools: ["tool.workspace-write"],
      deniedTools: ["tool.workspace-write"],
      requiresApprovalFor: [],
    };

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([plan]),
    });

    assert.equal(result.status, "waiting_operator_approval");
    const approval = await db.one<{ payload_json: { requestedAuthority: { toolGrantRefs: string[]; removedDeniedTools: string[] } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'approval' and resource_key = $1",
      [result.approvalId],
    );
    assert.deepEqual(approval.payload_json.requestedAuthority.toolGrantRefs, ["tool.workspace-write"]);
    assert.deepEqual(approval.payload_json.requestedAuthority.removedDeniedTools, ["tool.workspace-write"]);
  } finally {
    await db.close();
  }
});

test("dynamic repair does not let a permissive sibling profile hide verifier approval relaxation", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-sibling-profile-approval-relaxation";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      [runId],
    );
    run.workflow_manifest_json.agentProfiles = run.workflow_manifest_json.agentProfiles?.map((profile) => ({
      ...profile,
      toolPolicy: {
        ...profile.toolPolicy,
        requiresApprovalFor: profile.id === "profile.verify" ? ["tool.workspace-write"] : [],
      },
    }));
    await db.query(
      "update southstar.workflow_runs set workflow_manifest_json = $2::jsonb where id = $1",
      [runId, JSON.stringify(run.workflow_manifest_json)],
    );

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(result.status, "waiting_operator_approval");
    const approval = await db.one<{ payload_json: { requestedAuthority: { removedApprovalRequirements: string[] } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'approval' and resource_key = $1",
      [result.approvalId],
    );
    assert.deepEqual(approval.payload_json.requestedAuthority.removedApprovalRequirements, ["tool.workspace-write"]);
  } finally {
    await db.close();
  }
});

test("dynamic repair merges compiled artifact and evaluator definitions for managed context", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-runtime-definition-merge";
    await seedFrozenDynamicRepairRun(db, runId, true, false);

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    assert.equal(result.status, "applied");
    const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
      "select workflow_manifest_json from southstar.workflow_runs where id = $1",
      [runId],
    );
    assert.equal(run.workflow_manifest_json.artifactContracts?.some((contract) => contract.id === "todo_app"), true);
    assert.equal(run.workflow_manifest_json.evaluatorPipelines?.some((pipeline) => pipeline.id === "todo-quality"), true);
  } finally {
    await db.close();
  }
});

test("active Goal Contract repair fails closed when its Library snapshot hash is missing", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-missing-snapshot-hash";
    await seedFrozenDynamicRepairRun(db, runId, true, false);
    await db.query(
      "update southstar.workflow_runs set runtime_context_json = runtime_context_json - 'librarySnapshotHash' where id = $1",
      [runId],
    );

    const result = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.deepEqual(result, { status: "skipped", reason: "dynamic-repair-library-snapshot-missing" });
  } finally {
    await db.close();
  }
});

test("tampered approved dynamic repair authority cannot be reused", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-tampered-approval";
    await seedFrozenDynamicRepairRun(db, runId, true);
    const request = () => maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    const first = await request();
    assert.equal(first.status, "waiting_operator_approval");
    await db.query(
      `update southstar.runtime_resources
          set status = 'approved', payload_json = jsonb_set(payload_json, '{proposalHash}', '"tampered"'::jsonb), updated_at = now()
        where resource_type = 'approval' and resource_key = $1`,
      [first.approvalId],
    );

    const retry = await request();

    assert.deepEqual(retry, { status: "skipped", reason: `dynamic-repair-authority-approval-invalid:${first.approvalId}` });
  } finally {
    await db.close();
  }
});

test("callback waiting for dynamic repair approval stays nonterminal", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-callback-repair-awaiting-approval";
    const workflow = await seedFrozenDynamicRepairRun(db, runId, true);
    await db.query(
      "update southstar.workflow_tasks set status = 'running', root_session_id = 'session-verify', completed_at = null where run_id = $1 and id = 'verify-feature'",
      [runId],
    );
    await createExecutorBindingPg(db, {
      runId,
      taskId: "verify-feature",
      attemptId: "attempt-1",
      torkJobId: "job-awaiting-approval",
      status: "running",
      now: "2026-07-11T00:00:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });
    await seedDynamicCallbackEvidenceState(db, {
      runId,
      taskId: "verify-feature",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      goalContract: softwareGoalContract(workflow.goalPrompt),
    });
    await db.query(
      "update southstar.workflow_tasks set status = 'running', root_session_id = 'session-implement', completed_at = null where run_id = $1 and id = 'implement-feature'",
      [runId],
    );
    await createExecutorBindingPg(db, {
      runId,
      taskId: "implement-feature",
      attemptId: "attempt-implement",
      torkJobId: "job-implement-tail",
      status: "running",
      now: "2026-07-11T00:00:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });

    const result = await ingestTaskRunResultPg(db, {
      runId,
      taskId: "verify-feature",
      rootSessionId: "session-verify",
      ok: false,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: { kind: "verification_report", summary: "verification failed" },
      metrics: {},
      receivedAt: "2026-07-11T00:05:00.000Z",
      events: [],
    }, { workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]) });

    assert.equal(result.dynamicRepairRevision?.status, "waiting_operator_approval");
    assert.equal((await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId])).status, "awaiting_approval");
    assert.equal((await db.one<{ count: string }>("select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_outcome'", [runId])).count, "0");
    assert.equal((await db.one<{ count: string }>("select count(*) as count from southstar.workflow_tasks where run_id = $1 and id like 'repair-%'", [runId])).count, "0");

    await ingestTaskRunResultPg(db, {
      runId,
      taskId: "implement-feature",
      rootSessionId: "session-implement",
      ok: true,
      attempts: 1,
      attemptId: "attempt-implement",
      artifact: { kind: "todo_app", summary: "parallel implementation tail completed" },
      metrics: {},
      receivedAt: "2026-07-11T00:06:00.000Z",
      events: [],
    });

    assert.equal((await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId])).status, "awaiting_approval");
    assert.equal((await db.one<{ count: string }>("select count(*) as count from southstar.runtime_resources where run_id = $1 and resource_type = 'goal_outcome'", [runId])).count, "0");
  } finally {
    await db.close();
  }
});

test("reverify callback uses effective repair coverage and can satisfy the goal", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-reverify-effective-coverage";
    const workflow = await seedFrozenDynamicRepairRun(db, runId, true, false);
    const baseCoverageBefore = await db.one<{ payload_json: unknown }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'goal_requirement_coverage' and resource_key = $1",
      [runId],
    );
    const revision = await maybeApplyDynamicRepairRevisionPg(db, {
      runId,
      failedTaskId: "verify-feature",
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });
    assert.equal(revision.status, "applied");
    const repairTaskId = revision.newTaskIds[0]!;
    const reverifyTaskId = revision.newTaskIds[1]!;
    const repairArtifact = await acceptOrRejectArtifactRefPg(db, {
      runId,
      taskId: repairTaskId,
      sessionId: "session-repair",
      attemptId: "attempt-1",
      handExecutionId: "hand-repair",
      producer: { actorType: "hand", providerId: "workspace" },
      artifactType: "todo_app",
      status: "accepted",
      content: { repaired: true },
      contractRefs: ["artifact.todo_app"],
      summary: "Repaired output",
      producedAt: "2026-07-11T01:00:00.000Z",
    });
    await db.query(
      "update southstar.workflow_tasks set status = case when id = $2 then 'completed' else 'running' end, root_session_id = case when id = $3 then 'session-reverify' else root_session_id end, completed_at = case when id = $2 then now() else null end where run_id = $1 and id in ($2, $3)",
      [runId, repairTaskId, reverifyTaskId],
    );
    await createExecutorBindingPg(db, {
      runId,
      taskId: reverifyTaskId,
      attemptId: "attempt-1",
      torkJobId: "job-reverify",
      status: "running",
      now: "2026-07-11T01:01:00.000Z",
      queueTimeoutSeconds: 3600,
      hardTimeoutSeconds: 600,
    });
    await seedDynamicCallbackEvidenceState(db, {
      runId,
      taskId: reverifyTaskId,
      sessionId: "session-reverify",
      attemptId: "attempt-1",
      goalContract: softwareGoalContract(workflow.goalPrompt),
      seedCoverage: false,
      evaluatorProfileRef: "todo-quality",
    });

    const result = await ingestTaskRunResultPg(db, {
      runId,
      taskId: reverifyTaskId,
      rootSessionId: "session-reverify",
      ok: true,
      attempts: 1,
      attemptId: "attempt-1",
      artifact: {
        kind: "verification_report",
        pass: true,
        verifiedArtifactRefs: [repairArtifact.artifactRefId],
      },
      metrics: {},
      receivedAt: "2026-07-11T01:05:00.000Z",
      events: [],
    });

    assert.equal(result.accepted, true);
    const requirementResult = await db.one<{ status: string; payload_json: { evaluatorTaskId: string } }>(
      "select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'requirement_evaluator_result' order by created_at desc limit 1",
      [runId],
    );
    assert.equal(requirementResult.status, "passed");
    assert.equal(requirementResult.payload_json.evaluatorTaskId, reverifyTaskId);
    assert.equal((await db.one<{ status: string }>("select status from southstar.runtime_resources where resource_type = 'goal_outcome' and resource_key = $1", [`goal-outcome:${runId}`])).status, "satisfied");
    assert.deepEqual((await db.one<{ payload_json: unknown }>("select payload_json from southstar.runtime_resources where resource_type = 'goal_requirement_coverage' and resource_key = $1", [runId])).payload_json, baseCoverageBefore.payload_json);
  } finally {
    await db.close();
  }
});

test("dynamic repair cannot reuse an authority approval after the base manifest changes", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-dynamic-repair-stale-approval";
    await seedFrozenDynamicRepairRun(db, runId, true);
    const input = {
      runId,
      failedTaskId: "verify-feature",
      failedArtifactRefId: "artifact-ref-verify-failed",
      failedArtifact: { summary: "verification failed" },
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    };
    const first = await maybeApplyDynamicRepairRevisionPg(db, input);
    assert.equal(first.status, "waiting_operator_approval");
    await db.query(
      "update southstar.runtime_resources set status = 'approved', updated_at = now() where resource_type = 'approval' and resource_key = $1",
      [first.approvalId],
    );
    await db.query(
      "update southstar.workflow_runs set workflow_manifest_json = jsonb_set(workflow_manifest_json, '{title}', to_jsonb('Changed after approval'::text)), updated_at = now() where id = $1",
      [runId],
    );

    const retry = await maybeApplyDynamicRepairRevisionPg(db, {
      ...input,
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
    });

    assert.equal(retry.status, "waiting_operator_approval");
    assert.notEqual(retry.approvalId, first.approvalId);
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
    await seedActiveRepairProtection(db, "run-dynamic-repair-profile-hints", workflow, lineage);
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
    await seedActiveRepairProtection(db, "run-dynamic-repair-downstream", workflow, lineage);
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

test("dynamic repair reconnect selection skips tasks without profiles and does not guess a target", () => {
  const workflow = baseWorkflow();
  const unprofiled = { ...workflowTask("summarize", "Summarize", "summary", "profile.impl", []), agentProfileRef: undefined };
  const verifier = workflowTask("reverify", "Reverify", "verifier", "profile.verify", []);

  assert.equal(dynamicRepairReconnectTargetTaskId([unprofiled, verifier], workflow.agentProfiles), verifier.id);
  assert.equal(dynamicRepairReconnectTargetTaskId([verifier, unprofiled], undefined), undefined);
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
    await seedActiveRepairProtection(db, "run-dynamic-repair-chain-limit", workflow, lineage);
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
    const exhaustedOutcome = await db.one<{ status: string; payload_json: { outcomeStatus: string; failedRequirementIds: string[] } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'goal_outcome' and resource_key = $1",
      ["goal-outcome:run-dynamic-repair-chain-limit"],
    );
    assert.equal(exhaustedOutcome.status, "unsatisfied");
    assert.equal(exhaustedOutcome.payload_json.outcomeStatus, "unsatisfied");
    assert.deepEqual(exhaustedOutcome.payload_json.failedRequirementIds, softwareGoalContract(workflow.goalPrompt).requirements.map((requirement) => requirement.id));
    const exhaustedRun = await db.one<{ status: string; completed_at: Date | null }>(
      "select status, completed_at from southstar.workflow_runs where id = $1",
      ["run-dynamic-repair-chain-limit"],
    );
    assert.equal(exhaustedRun.status, "completed");
    assert.ok(exhaustedRun.completed_at);
    const replay = await maybeApplyDynamicRepairRevisionPg(db, {
      runId: "run-dynamic-repair-chain-limit",
      failedTaskId: secondReverifyId,
      workflowComposer: new GoalContractBindingWorkflowComposer([repairCompositionPlan()]),
      maxDynamicRepairRounds: 2,
    });
    assert.deepEqual(replay, { status: "skipped", reason: "run-status:completed" });
    const history = await listHistoryForRunPg(db, "run-dynamic-repair-chain-limit");
    assert.equal(history.filter((event) => event.eventType === "workflow.dynamic_repair_exhausted").length, 1);
    assert.equal(history.filter((event) => event.eventType === "run.completed").length, 1);

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
    await seedActiveRepairProtection(db, "run-callback-dynamic-repair", workflow, lineage);
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
    await seedDynamicCallbackEvidenceState(db, {
      runId: "run-callback-dynamic-repair",
      taskId: "verify-feature",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      goalContract: lineage.goalContract,
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
    assert.equal(result.dynamicRepairRevision?.status, "applied", JSON.stringify(result.dynamicRepairRevision));
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
    await seedActiveRepairProtection(db, "run-callback-semantic-verification-failure", workflow, lineage);
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
    await seedDynamicCallbackEvidenceState(db, {
      runId: "run-callback-semantic-verification-failure",
      taskId: "verify-feature",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      goalContract: lineage.goalContract,
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
    await seedActiveRepairProtection(db, "run-callback-direct-verification-failure", workflow, lineage);
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
    await seedDynamicCallbackEvidenceState(db, {
      runId: "run-callback-direct-verification-failure",
      taskId: "verify-feature",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      goalContract: lineage.goalContract,
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
    await seedActiveRepairProtection(db, "run-callback-invalid-dynamic-repair", workflow, lineage);
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
    await seedDynamicCallbackEvidenceState(db, {
      runId: "run-callback-invalid-dynamic-repair",
      taskId: "verify-feature",
      sessionId: "session-verify",
      attemptId: "attempt-1",
      goalContract: lineage.goalContract,
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
    await seedActiveRepairProtection(db, "run-dynamic-repair-existing-task-no-resource", workflow, lineage);
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
    await seedActiveRepairProtection(db, "run-dynamic-repair-composition-retry", workflow, lineage);
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
        toolPolicy: { allowedTools: ["tool.workspace-write"], deniedTools: [], requiresApprovalFor: [] },
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
        toolPolicy: { allowedTools: ["tool.workspace-write"], deniedTools: [], requiresApprovalFor: [] },
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
      sliceId: "slice-main",
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
    toolGrantRefs: ["tool.workspace-write"],
    vaultLeasePolicyRefs: [],
    memoryScopeRefs: [],
    mcpGrantRefs: ["mcp.filesystem-workspace"],
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
        mcpGrantRefs: [],
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
        mcpGrantRefs: [],
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

async function seedFrozenDynamicRepairRun(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
  includeAuthorityObjects: boolean,
  clearCurrentAuthority = true,
): Promise<SouthstarWorkflowManifest> {
  await seedDynamicRepairPrimitives(db);
  const workflow = baseWorkflow();
  if (clearCurrentAuthority) {
    workflow.tasks = workflow.tasks.map((task) => ({ ...task, toolGrantRefs: [], mcpGrantRefs: [] }));
  } else {
    workflow.agentProfiles = workflow.agentProfiles?.map((profile) => ({
      ...profile,
      toolPolicy: { ...profile.toolPolicy, allowedTools: ["tool.workspace-write"] },
    }));
  }
  const lineage = await seedPlannerDraftLineage(db, runId, workflow.goalPrompt);
  const manifestHash = contentHashForPayload(workflow);
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: workflow.goalPrompt,
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({
      ...JSON.parse(lineage.runtimeContextJson),
      manifestHash,
    }),
    metricsJson: JSON.stringify({}),
  });
  await createWorkflowTaskPg(db, {
    id: "implement-feature",
    runId,
    taskKey: "Implement Feature",
    status: "completed",
    sortOrder: 0,
    dependsOn: [],
    snapshot: { agentProfileRef: "profile.impl" },
  });
  await createWorkflowTaskPg(db, {
    id: "verify-feature",
    runId,
    taskKey: "Verify Feature",
    status: "failed",
    sortOrder: 1,
    dependsOn: ["implement-feature"],
    snapshot: { agentProfileRef: "profile.verify" },
  });
  await seedActiveRepairProtection(db, runId, workflow, lineage, includeAuthorityObjects);
  return workflow;
}

async function seedActiveRepairProtection(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  runId: string,
  workflow: SouthstarWorkflowManifest,
  lineage: { goalContract: GoalContractV1; goalContractHash: string },
  includeAuthorityObjects = true,
): Promise<void> {
  const objectKeys = [
    "template.graph-dynamic-workflow",
    "agent.frontend-developer",
    "skill.react-ui",
    "instruction.react-review",
    "artifact.todo_app",
    "evaluator.todo-quality",
    "mcp.filesystem-workspace",
    ...(includeAuthorityObjects ? ["tool.workspace-write"] : []),
  ];
  const manifestHash = contentHashForPayload(workflow);
  await db.query(
    "update southstar.workflow_runs set runtime_context_json = runtime_context_json || $2::jsonb where id = $1",
    [runId, JSON.stringify({ manifestHash })],
  );
  const snapshot = await captureRunLibrarySnapshotPg(db, {
    runId,
    goalContractHash: lineage.goalContractHash,
    manifestHash,
    libraryObjectVersionRefs: objectKeys.map((objectKey) => ({ objectKey, versionRef: `${objectKey}@1` })),
  });
  await db.query(
    "update southstar.workflow_runs set runtime_context_json = runtime_context_json || $2::jsonb where id = $1",
    [runId, JSON.stringify({ librarySnapshotHash: snapshot.snapshotHash })],
  );
  await upsertRuntimeResourcePg(db, {
    id: `goal-requirement-coverage:${runId}`,
    resourceType: "goal_requirement_coverage",
    resourceKey: runId,
    runId,
    scope: "run",
    status: "frozen",
    title: "Goal Requirement Coverage",
    payload: {
      schemaVersion: "southstar.goal_requirement_coverage.v1",
      goalContractHash: lineage.goalContractHash,
      entries: lineage.goalContract.requirements.map((requirement) => ({
        requirementId: requirement.id,
        producerTaskIds: ["implement-feature"],
        artifactRefs: ["artifact.todo_app"],
        evaluatorTaskIds: ["verify-feature"],
        evaluatorProfileRefs: ["evaluator.schema-evaluator-v1"],
        requiredEvidenceKinds: ["artifact-ref"],
      })),
    },
  });
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
  await upsertLibraryObject(db, { objectKey: "template.graph-dynamic-workflow", objectKind: "workflow_template", status: "approved", headVersionId: "template.graph-dynamic-workflow@1", state: { scope: "software", title: "Dynamic repair workflow" } });
  await upsertLibraryObject(db, { objectKey: "capability.frontend-ui", objectKind: "capability_spec", status: "approved", headVersionId: "capability.frontend-ui@1", state: { scope: "software", title: "Frontend UI" } });
  await upsertLibraryObject(db, { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", headVersionId: "agent.frontend-developer@1", state: { scope: "software", title: "Frontend Developer" } });
  await upsertLibraryObject(db, { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", headVersionId: "skill.react-ui@1", state: { scope: "software", title: "React UI", body: "# Instructions\n\nBuild React UI." } });
  await upsertLibraryObject(db, { objectKey: "tool.workspace-write", objectKind: "tool_definition", status: "approved", headVersionId: "tool.workspace-write@1", state: { scope: "global", title: "Workspace Write", runtimeToolNames: ["edit", "write"] } });
  await upsertLibraryObject(db, { objectKey: "mcp.filesystem-workspace", objectKind: "mcp_tool_grant", status: "approved", headVersionId: "mcp.filesystem-workspace@1", state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] } });
  await upsertLibraryObject(db, { objectKey: "instruction.react-review", objectKind: "instruction_template", status: "approved", headVersionId: "instruction.react-review@1", state: { scope: "software", title: "React Review", content: "Use React best practices.", variables: [] } });
  await upsertLibraryObject(db, { objectKey: "artifact.todo_app", objectKind: "artifact_contract", status: "approved", headVersionId: "artifact.todo_app@1", state: { scope: "software", title: "Todo app artifact" } });
  await upsertLibraryObject(db, { objectKey: "evaluator.todo-quality", objectKind: "evaluator_profile", status: "approved", headVersionId: "evaluator.todo-quality@1", state: { scope: "software", title: "Todo quality evaluator" } });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "provides_capability", toObjectKey: "capability.frontend-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "uses", toObjectKey: "skill.react-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "produces_artifact", toObjectKey: "artifact.todo_app", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
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

async function seedDynamicCallbackEvidenceState(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    goalContract: GoalContractV1;
    seedCoverage?: boolean;
    evaluatorProfileRef?: string;
  },
): Promise<void> {
  const contractHash = goalContractHash(input.goalContract);
  if (input.seedCoverage !== false) await upsertRuntimeResourcePg(db, {
    id: `goal-requirement-coverage:${input.runId}`,
    resourceType: "goal_requirement_coverage",
    resourceKey: input.runId,
    runId: input.runId,
    scope: "run",
    status: "frozen",
    title: "Goal Requirement Coverage",
    payload: {
      schemaVersion: "southstar.goal_requirement_coverage.v1",
      goalContractHash: contractHash,
      entries: input.goalContract.requirements.map((requirement) => ({
        requirementId: requirement.id,
        producerTaskIds: ["implement-feature"],
        artifactRefs: ["artifact.todo_app"],
        evaluatorTaskIds: [input.taskId],
        evaluatorProfileRefs: ["evaluator.schema-evaluator-v1"],
        requiredEvidenceKinds: ["artifact-ref"],
      })),
    },
    summary: { goalContractHash: contractHash },
  });
  const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: handExecutionId,
    resourceType: "hand_execution",
    resourceKey: handExecutionId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "hand",
    status: "running",
    title: `Hand execution ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.runtime.hand_execution.v1",
      handExecutionId,
      providerId: "tork",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      brainBindingId: `brain-${input.runId}-${input.taskId}`,
      handBindingId: `hand-${input.runId}-${input.taskId}`,
      status: "running",
      queuedAt: "2026-07-05T10:00:00.000Z",
      queueTimeoutSeconds: 3600,
      heartbeatTimeoutSeconds: 60,
    },
  });
  const intentKey = `task-intent:${input.runId}:${input.taskId}:${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: intentKey,
    resourceType: "task_execution_intent",
    resourceKey: intentKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "task",
    status: "created",
    title: `Task intent ${input.taskId}`,
    payload: {
      schemaVersion: "southstar.brain.task_execution_intent.v1",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      handProviderId: "tork",
    },
  });
  const envelopeKey = `task-envelope-${input.runId}-${input.taskId}-${input.attemptId}`;
  await upsertRuntimeResourcePg(db, {
    id: envelopeKey,
    resourceType: "task_envelope",
    resourceKey: envelopeKey,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "task",
    status: "materialized",
    title: `Task envelope ${input.taskId}`,
    payload: {
      envelope: {
        schemaVersion: "southstar.task-envelope.v2",
        runId: input.runId,
        taskId: input.taskId,
        evaluatorPipeline: { id: input.evaluatorProfileRef ?? "schema-evaluator-v1" },
        session: { sessionId: input.sessionId },
      },
    },
    summary: { attemptId: input.attemptId },
  });
}

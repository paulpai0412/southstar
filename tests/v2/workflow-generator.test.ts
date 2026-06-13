import test from "node:test";
import assert from "node:assert/strict";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createPlannerDraft, revisePlannerDraft } from "../../src/v2/ui-api/local-api.ts";
import { generateConstrainedWorkflowPlan } from "../../src/v2/workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../../src/v2/workflow-generator/materialize.ts";
import { validateWorkflowGenerationPlan } from "../../src/v2/workflow-generator/validator.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";

const goalPrompt = [
  "新增 CLI 指令 calc sum <numbers...>，支援多數字、負數、小數、錯誤訊息。",
  "更新測試與 README。",
  "需要 checker 驗證與 final completion report。",
  "Fixture repo: /tmp/southstar-real-e2e/domain-pack-dynamic-feature",
].join("\n");

test("generates a non-fixed software DAG from prompt and domain pack", () => {
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-dynamic-feature",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });

  assert.equal(plan.intentRef, "implement_feature");
  assert.equal(plan.generatorPolicyRef, "software-feature-generator");
  assert.equal(plan.tasks.length >= 5, true, "broad feature prompt should produce at least five tasks");
  assert.notDeepEqual(plan.tasks.map((task) => task.id), ["planner", "implementer", "root-validator", "summary"]);
  assert.equal(plan.tasks.some((task) => task.roleRef === "maker"), true);
  assert.equal(plan.tasks.filter((task) => task.roleRef === "checker").length >= 1, true);
  assert.equal(plan.orchestration.phases.length >= 4, true);

  for (const task of plan.tasks) {
    assert.equal(typeof task.roleRef, "string");
    assert.equal(typeof task.agentProfileRef, "string");
    assert.ok(Array.isArray(task.dependsOn));
    assert.equal(typeof task.promptTemplateRef, "string");
    assert.equal(typeof task.promptInputs, "object");
    assert.ok(Array.isArray(task.requiredArtifactRefs));
    assert.equal(typeof task.evaluatorPipelineRef, "string");
    assert.ok(Array.isArray(task.recoveryStrategyRefs));
  }

  assert.deepEqual(validateWorkflowGenerationPlan(softwareDomainPack, plan), { ok: true, issues: [] });
});

test("rejects generated plans that violate generator policy constraints", () => {
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-invalid-feature",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });
  plan.tasks.push({
    ...plan.tasks[0],
    id: plan.tasks[0].id,
    roleRef: "not-allowed",
    agentProfileRef: "missing-profile",
    dependsOn: ["missing-task"],
    requiredArtifactRefs: ["missing-artifact"],
    evaluatorPipelineRef: "missing-pipeline",
  });
  plan.orchestration.phases.push({ id: "bad-phase", taskRefs: ["missing-task"] });
  plan.estimatedBudget.inputTokens = Number.MAX_SAFE_INTEGER;
  plan.estimatedBudget.costMicrosUsd = Number.MAX_SAFE_INTEGER;

  const result = validateWorkflowGenerationPlan(softwareDomainPack, plan);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.message.includes("duplicate task id")), true);
  assert.equal(result.issues.some((issue) => issue.message.includes("role not allowed")), true);
  assert.equal(result.issues.some((issue) => issue.message.includes("agent profile not allowed")), true);
  assert.equal(result.issues.some((issue) => issue.message.includes("artifact contract not allowed")), true);
  assert.equal(result.issues.some((issue) => issue.message.includes("evaluator pipeline not allowed")), true);
  assert.equal(result.issues.some((issue) => issue.message.includes("unknown dependency")), true);
  assert.equal(result.issues.some((issue) => issue.message.includes("unknown task ref")), true);
  assert.equal(result.issues.some((issue) => issue.path === "estimatedBudget.inputTokens"), true);
  assert.equal(result.issues.some((issue) => issue.path === "estimatedBudget.costMicrosUsd"), true);
});

test("materializes generation plan into a Southstar manifest with domain metadata", () => {
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-dynamic-feature",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });
  const manifest = materializeGenerationPlan({
    plan,
    domainPack: softwareDomainPack,
    goalPrompt,
  });

  assert.equal(manifest.domain, "software");
  assert.equal(manifest.intent, "implement_feature");
  assert.equal(manifest.domainPackRef?.id, "software");
  assert.equal(manifest.workflowGeneration?.planId, plan.id);
  assert.equal(manifest.tasks.length, plan.tasks.length);
  assert.deepEqual(manifest.roles, softwareDomainPack.roles);
  assert.deepEqual(manifest.agentProfiles, softwareDomainPack.agentProfiles);
  assert.deepEqual(manifest.artifactContracts, softwareDomainPack.artifactContracts);
  assert.deepEqual(manifest.evaluatorPipelines, softwareDomainPack.evaluatorPipelines);
  assert.deepEqual(manifest.contextPolicies, softwareDomainPack.contextPolicies);
  assert.deepEqual(manifest.sessionPolicies, softwareDomainPack.sessionPolicies);
  assert.deepEqual(manifest.memoryPolicies, softwareDomainPack.memoryPolicies);
  assert.deepEqual(manifest.workspacePolicies, softwareDomainPack.workspacePolicies);
  for (const task of manifest.tasks) {
    assert.equal(typeof task.roleRef, "string");
    assert.equal(typeof task.agentProfileRef, "string");
    assert.equal(typeof task.evaluatorPipelineRef, "string");
    assert.equal(task.rootSession.validator, "schema-evaluator-v1");
    assert.equal(task.execution.engine, "tork");
    assert.equal(task.execution.command[0], "southstar-agent-runner");
  }
});

test("createPlannerDraft persists generation plan and orchestration snapshot resources", async () => {
  const db = openSouthstarDb(":memory:");

  const draft = await createPlannerDraft(db, {
    goalPrompt,
    plannerClient: plannerClient(),
  });

  const generationPlans = listResources(db, { resourceType: "workflow_generation_plan", status: "validated" });
  const snapshots = listResources(db, { resourceType: "orchestration_snapshot", status: "created" });
  const drafts = listResources(db, { resourceType: "planner_draft", status: "validated" });

  assert.equal(draft.goalPrompt, goalPrompt);
  assert.equal(generationPlans.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(drafts.length, 1);
  assert.equal((generationPlans[0].payload as { tasks: unknown[] }).tasks.length >= 5, true);
  assert.equal((snapshots[0].payload as { phaseStates: unknown[] }).phaseStates.length >= 4, true);
});

test("createPlannerDraft uses domain-pack generation for narrow software prompts", async () => {
  const db = openSouthstarDb(":memory:");

  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });

  const generationPlans = listResources(db, { resourceType: "workflow_generation_plan", status: "validated" });
  const drafts = listResources(db, { resourceType: "planner_draft", status: "validated" });

  assert.equal(draft.goalPrompt, "implement calc sum");
  assert.equal(generationPlans.length, 1);
  assert.equal(drafts.length, 1);
  assert.equal((generationPlans[0].payload as { tasks: unknown[] }).tasks.length >= 4, true);
});

test("revisePlannerDraft keeps software revisions on the domain-pack generator path", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });

  const revised = await revisePlannerDraft(db, {
    draftId: draft.draftId,
    prompt: "add README examples",
    plannerClient: plannerClient(),
  });

  const generationPlans = listResources(db, { resourceType: "workflow_generation_plan", status: "validated" });

  assert.match(revised.draftId, /^draft-wf-gen-/);
  assert.equal(generationPlans.length, 2);
});

test("createPlannerDraft fails closed when no domain pack matches", async () => {
  const db = openSouthstarDb(":memory:");

  await assert.rejects(
    () =>
      createPlannerDraft(db, {
        goalPrompt: "write a poem about lunch",
        plannerClient: plannerClient(),
      }),
    /no domain pack matched prompt/,
  );
});

function plannerClient(): PiPlannerClient {
  return {
    generate: async () => {
      throw new Error("domain-pack planner path should not call plannerClient");
    },
  };
}

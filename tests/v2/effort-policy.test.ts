import test from "node:test";
import assert from "node:assert/strict";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { generateConstrainedWorkflowPlan } from "../../src/v2/workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../../src/v2/workflow-generator/materialize.ts";

test("sets simple effort policy for narrow generated workflows", () => {
  const goalPrompt = "implement calc sum";
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-narrow-effort",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });

  assert.deepEqual(plan.effortPolicy, {
    complexity: "simple",
    maxBrains: 1,
    maxHandsPerBrain: 1,
    maxParallelTasks: 1,
    maxToolCallsPerTask: 10,
    maxInputTokensPerBrain: 12_000,
    maxCostMicrosUsd: plan.tasks.length * 40_000,
    stopWhenEvidenceSufficient: true,
  });

  const manifest = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt });

  assert.deepEqual(manifest.effortPolicy, plan.effortPolicy);
});

test("sets broad effort policy for broad generated workflows", () => {
  const goalPrompt = [
    "新增 CLI 指令 calc sum <numbers...>，支援多數字、負數、小數、錯誤訊息。",
    "更新測試與 README。",
    "需要 checker 驗證與 final completion report。",
  ].join("\n");
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-broad-effort",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });

  assert.deepEqual(plan.effortPolicy, {
    complexity: "broad",
    maxBrains: 3,
    maxHandsPerBrain: 2,
    maxParallelTasks: 2,
    maxToolCallsPerTask: 20,
    maxInputTokensPerBrain: 20_000,
    maxCostMicrosUsd: plan.tasks.length * 60_000,
    stopWhenEvidenceSufficient: true,
  });

  const manifest = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt });

  assert.deepEqual(manifest.effortPolicy, plan.effortPolicy);
});

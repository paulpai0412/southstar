import assert from "node:assert/strict";
import test from "node:test";
import { loadRealE2EEnv } from "./env.ts";
import { runMvpSoftwareChangeScenario } from "./scenarios/mvp-software-change.ts";
import { runMemoryReuseScenario } from "./scenarios/memory-reuse.ts";
import { runSteeringRepairScenario } from "./scenarios/steering-repair.ts";
import { runDynamicDagExpansionScenario } from "./scenarios/dynamic-dag-expansion.ts";
import { runApprovalPolicyRealScenario } from "./scenarios/approval-policy-real.ts";
import { runCliRunGoalRealScenario } from "./scenarios/cli-run-goal-real.ts";
import { runDomainPackDynamicWorkflowFeatureScenario } from "./scenarios/domain-pack-dynamic-workflow-feature.ts";
import { runSkillSnapshotRealScenario } from "./scenarios/skill-snapshot-real.ts";
import { runUiApiRunGoalRealScenario } from "./scenarios/ui-api-run-goal-real.ts";
import { runUiBrowserOperationsScenario } from "./scenarios/ui-browser-operations.ts";
import { runVoiceCommandPolicyScenario } from "./scenarios/voice-command-policy.ts";
import {
  assertNoDurableSouthstarFolders,
  assertSqliteEvidence,
  collectPhase15RuntimeTimings,
  createScenarioContext,
  findForbiddenDurableFolders,
} from "./scenarios/harness.ts";
import { getRunStatus } from "../../src/v2/ui-api/local-api.ts";
import { assertPhase1QuantitativeGates } from "../../src/v2/quality/phase1-gates.ts";
import { assertPhase15QuantitativeGates } from "../../src/v2/quality/phase15-gates.ts";
import { assertDomainPackDynamicQuantitativeGates } from "../../src/v2/quality/domain-pack-dynamic-gates.ts";

test("Phase 1 real E2E suite", async () => {
  const e2eStartedAt = Date.now();
  const env = await loadRealE2EEnv();
  const dynamicFeature = await runDomainPackDynamicWorkflowFeatureScenario(env);
  const dynamicContext = createScenarioContext(env);
  const dynamicGate = assertDomainPackDynamicQuantitativeGates(dynamicContext.db, {
    runId: dynamicFeature.runId,
    ...dynamicFeature.timings,
  });
  assert.equal(dynamicGate.ok, true, dynamicGate.failures.join("\n"));
  const mvp = await runMvpSoftwareChangeScenario(env);
  await runMemoryReuseScenario(env, mvp.runId);
  await runSteeringRepairScenario(env, mvp.runId);
  await runDynamicDagExpansionScenario(env, mvp.runId);
  const phase15Api = await runUiApiRunGoalRealScenario(env);
  await runSkillSnapshotRealScenario(env, phase15Api.runId);
  await runVoiceCommandPolicyScenario(env, phase15Api.runId);
  await runApprovalPolicyRealScenario(env, phase15Api.runId);
  const phase15Cli = await runCliRunGoalRealScenario(env);
  const phase15Browser = await runUiBrowserOperationsScenario(env);
  const gateContext = createScenarioContext(env);
  const runtimeTimings = collectPhase15RuntimeTimings(gateContext.db, phase15Api.runId);
  const phase15GateResult = assertPhase15QuantitativeGates(gateContext.db, {
    runId: phase15Api.runId,
    serverStartMs: phase15Api.timings.serverStartMs,
    plannerMs: runtimeTimings.plannerMs,
    validationMs: runtimeTimings.validationMs,
    torkSubmitMs: runtimeTimings.torkSubmitMs,
    firstClientEventMs: runtimeTimings.firstClientEventMs,
    uiEventVisibilityMs: phase15Browser.timings.uiEventVisibilityMs,
    modeToggleMs: phase15Browser.timings.modeToggleMs,
    apiRunGoalCompletionMs: phase15Api.timings.apiRunGoalCompletionMs,
    cliRunGoalCompletionMs: phase15Cli.timings.cliRunGoalCompletionMs,
    browserScenarioMs: phase15Browser.timings.browserScenarioMs,
    durableFolderFindings: findForbiddenDurableFolders(process.cwd()),
  });
  assert.equal(phase15GateResult.ok, true, phase15GateResult.failures.join("\n"));
  console.log("phase15 quantitative gates passed");
  const context = createScenarioContext(env);
  assertSqliteEvidence(context.db);
  assertNoDurableSouthstarFolders(process.cwd());
  assertNoDurableSouthstarFolders(env.workspaceRoot);
  const uiStartedAt = Date.now();
  getRunStatus(context.db, mvp.runId);
  const gate = assertPhase1QuantitativeGates(context.db, {
    runId: mvp.runId,
    ...mvp.timings,
    e2eMs: Date.now() - e2eStartedAt,
    uiVisibilityMs: Date.now() - uiStartedAt,
  });
  if (!gate.ok) {
    throw new Error(`quantitative gates failed:\n${gate.failures.join("\n")}`);
  }
  console.log("all quantitative gates passed");
});

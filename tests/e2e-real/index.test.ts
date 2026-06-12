import test from "node:test";
import { loadRealE2EEnv } from "./env.ts";
import { runMvpSoftwareChangeScenario } from "./scenarios/mvp-software-change.ts";
import { runMemoryReuseScenario } from "./scenarios/memory-reuse.ts";
import { runSteeringRepairScenario } from "./scenarios/steering-repair.ts";
import { runDynamicDagExpansionScenario } from "./scenarios/dynamic-dag-expansion.ts";
import { runApprovalPolicyRealScenario } from "./scenarios/approval-policy-real.ts";
import { runCliRunGoalRealScenario } from "./scenarios/cli-run-goal-real.ts";
import { runSkillSnapshotRealScenario } from "./scenarios/skill-snapshot-real.ts";
import { runUiApiRunGoalRealScenario } from "./scenarios/ui-api-run-goal-real.ts";
import { runVoiceCommandPolicyScenario } from "./scenarios/voice-command-policy.ts";
import { assertNoDurableSouthstarFolders, assertSqliteEvidence, createScenarioContext } from "./scenarios/harness.ts";
import { getRunStatus } from "../../src/v2/ui-api/local-api.ts";
import { assertPhase1QuantitativeGates } from "../../src/v2/quality/phase1-gates.ts";

test("Phase 1 real E2E suite", async () => {
  const e2eStartedAt = Date.now();
  const env = await loadRealE2EEnv();
  const mvp = await runMvpSoftwareChangeScenario(env);
  await runMemoryReuseScenario(env, mvp.runId);
  await runSteeringRepairScenario(env, mvp.runId);
  await runDynamicDagExpansionScenario(env, mvp.runId);
  const phase15Api = await runUiApiRunGoalRealScenario(env);
  await runSkillSnapshotRealScenario(env, phase15Api.runId);
  await runVoiceCommandPolicyScenario(env, phase15Api.runId);
  await runApprovalPolicyRealScenario(env, phase15Api.runId);
  await runCliRunGoalRealScenario(env);
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

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadRealE2EEnv } from "./env.ts";
import { runDesignLibraryTemplateRealScenario } from "./scenarios/design-library-template-real.ts";

test("Design Library template real E2E develops todo-web feature issue through software-development workflow", async () => {
  const source = readFileSync(new URL("./scenarios/design-library-template-real.ts", import.meta.url), "utf8");
  assert.equal(/calc\s+sum|software-change|assertCalcSum|softwareGoalPrompt/.test(source), false, "new E2E must not reuse old calc-sum scenario helpers");
  assert.equal(/artifactEvidenceValidatorGoalPrompt|prepareSoftwareFixtureRepo|assertFixtureTests/.test(source), false, "new E2E must not use calc/software fixture helpers");
  assert.equal(/fake|mock|smoke|codex|opencode|builtin-agent/i.test(source), false, "new E2E must execute through Pi host adapter path only");

  const env = await loadRealE2EEnv();
  assert.equal(["http", "sdk"].includes(env.piPlannerMode), true, "planner must run via Pi host adapter mode");
  assert.equal(["http", "sdk"].includes(env.piHarnessMode), true, "agent harness must run via Pi host adapter mode");

  const result = await runDesignLibraryTemplateRealScenario(env);
  assert.match(result.runId, /^run-/);
  assert.match(result.templateVersionId, /^ver-/);
});

test("Design Library real E2E recovers incomplete evidence with compact retry", async () => {
  const env = await loadRealE2EEnv();
  const result = await runDesignLibraryTemplateRealScenario(env, { recoveryMode: "compact-retry" });
  assert.match(result.runId, /^run-/);
});

test("Design Library real E2E forks from checkpoint after rejected branch", async () => {
  const env = await loadRealE2EEnv();
  const result = await runDesignLibraryTemplateRealScenario(env, { recoveryMode: "fork-from-checkpoint" });
  assert.match(result.runId, /^run-/);
});

test("Design Library real E2E rolls back workspace before recovered attempt", async () => {
  const env = await loadRealE2EEnv();
  const result = await runDesignLibraryTemplateRealScenario(env, { recoveryMode: "rollback-workspace" });
  assert.match(result.runId, /^run-/);
});

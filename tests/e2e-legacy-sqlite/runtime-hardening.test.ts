import assert from "node:assert/strict";
import test from "node:test";
import { loadRealE2EEnv } from "./env.ts";
import { runRuntimeHardeningAutoReconcileRealScenario } from "./scenarios/runtime-hardening-auto-reconcile-real.ts";
import { runRuntimeHardeningConcurrencyRealScenario } from "./scenarios/runtime-hardening-concurrency-real.ts";
import { runRuntimeHardeningSoakRealScenario } from "./scenarios/runtime-hardening-soak-real.ts";

function numberFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

test("runtime hardening real E2E: auto reconcile + concurrency", async () => {
  const env = await loadRealE2EEnv();

  const auto = await runRuntimeHardeningAutoReconcileRealScenario(env);
  assert.ok(auto.runId.length > 0);

  const runCount = numberFromEnv("SOUTHSTAR_HARDENING_CONCURRENCY_RUNS", 10);
  const expectedMinTaskCount = numberFromEnv("SOUTHSTAR_HARDENING_CONCURRENCY_MIN_TASKS", 50);
  const concurrency = await runRuntimeHardeningConcurrencyRealScenario(env, {
    runCount,
    expectedMinTaskCount,
  });
  assert.equal(concurrency.runIds.length, runCount);
  console.log(`runtime hardening concurrency completed: runs=${concurrency.runIds.length}`);
});

test("runtime hardening real E2E: 24h soak (opt-in)", { skip: process.env.SOUTHSTAR_HARDENING_SOAK === "1" ? false : "set SOUTHSTAR_HARDENING_SOAK=1 to enable" }, async () => {
  const env = await loadRealE2EEnv();
  const durationMs = numberFromEnv("SOUTHSTAR_HARDENING_SOAK_DURATION_MS", 24 * 60 * 60 * 1000);
  const cycleIntervalMs = numberFromEnv("SOUTHSTAR_HARDENING_SOAK_INTERVAL_MS", 30_000);
  const minCycles = numberFromEnv("SOUTHSTAR_HARDENING_SOAK_MIN_CYCLES", 10);
  const soak = await runRuntimeHardeningSoakRealScenario(env, {
    durationMs,
    cycleIntervalMs,
    minCycles,
  });
  assert.equal(soak.durationMs >= durationMs, true);
  console.log(`runtime hardening soak completed: cycles=${soak.cycles}`);
});

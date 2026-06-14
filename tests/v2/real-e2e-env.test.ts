import test from "node:test";
import assert from "node:assert/strict";
import { loadRealE2EEnv } from "../../tests/e2e-real/env.ts";

test("real E2E env fails closed when required env is missing", async () => {
  await assert.rejects(() => loadRealE2EEnv({}, {
    dockerVersion: async () => {},
    southstarTaskContainersIdle: async () => {},
    torkHealth: async () => {},
    torkQueueIdle: async () => {},
    piConfig: async () => {},
  }), /Real E2E missing required env: TORK_BASE_URL, SOUTHSTAR_DB/);
});

test("real E2E env probes Docker, Tork, and Pi SDK config when endpoints are absent", async () => {
  const probes: string[] = [];
  const env = await loadRealE2EEnv({
    TORK_BASE_URL: "http://127.0.0.1:8000",
    SOUTHSTAR_DB: "/tmp/southstar-real-e2e/southstar.sqlite3",
    SOUTHSTAR_E2E_WORKSPACE: "/tmp/southstar-real-e2e",
  }, {
    dockerVersion: async () => { probes.push("docker"); },
    southstarTaskContainersIdle: async () => { probes.push("containers-idle"); },
    torkHealth: async () => { probes.push("tork"); },
    torkQueueIdle: async () => { probes.push("queue-idle"); },
    piConfig: async () => { probes.push("pi-sdk"); },
  });

  assert.deepEqual(probes, ["docker", "containers-idle", "tork", "queue-idle", "pi-sdk"]);
  assert.equal(env.workspaceRoot, "/tmp/southstar-real-e2e");
  assert.equal(env.piPlannerMode, "sdk");
  assert.equal(env.piHarnessMode, "sdk");
});

test("real E2E env probes HTTP Pi config when endpoints are present", async () => {
  const probes: string[] = [];
  const env = await loadRealE2EEnv({
    TORK_BASE_URL: "http://127.0.0.1:8000",
    SOUTHSTAR_DB: "/tmp/southstar-real-e2e/southstar.sqlite3",
    PI_PLANNER_ENDPOINT: "http://127.0.0.1:9000/plan",
    PI_HARNESS_ENDPOINT: "http://127.0.0.1:9000/harness",
  }, {
    dockerVersion: async () => { probes.push("docker"); },
    southstarTaskContainersIdle: async () => { probes.push("containers-idle"); },
    torkHealth: async () => { probes.push("tork"); },
    torkQueueIdle: async () => { probes.push("queue-idle"); },
    piConfig: async () => { probes.push("pi-http"); },
  });

  assert.deepEqual(probes, ["docker", "containers-idle", "tork", "queue-idle", "pi-http"]);
  assert.equal(env.piPlannerMode, "http");
  assert.equal(env.piHarnessMode, "http");
});

test("real E2E env fails closed when shared Tork queue is not idle", async () => {
  await assert.rejects(() => loadRealE2EEnv({
    TORK_BASE_URL: "http://127.0.0.1:8000",
    SOUTHSTAR_DB: "/tmp/southstar-real-e2e/southstar.sqlite3",
  }, {
    dockerVersion: async () => {},
    southstarTaskContainersIdle: async () => {},
    torkHealth: async () => {},
    torkQueueIdle: async () => {
      throw new Error("Tork queue contains active Southstar jobs: run-wf-stale");
    },
    piConfig: async () => {},
  }), /Tork queue contains active Southstar jobs/);
});

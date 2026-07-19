import test from "node:test";
import assert from "node:assert/strict";
import { loadRealPostgresE2EEnv, realE2EPlannerTimeoutMs } from "../e2e-postgres/postgres-real-harness.ts";

test("real E2E env fails closed when required env is missing", async () => {
  await assert.rejects(() => loadRealPostgresE2EEnv({}, {
    dockerVersion: async () => {},
    southstarTaskContainersIdle: async () => {},
    torkHealth: async () => {},
    torkQueueIdle: async () => {},
    piConfig: async () => {},
  }), /Real Postgres E2E missing required env: SOUTHSTAR_TEST_ADMIN_DATABASE_URL, TORK_BASE_URL/);
});

test("real E2E env probes Docker, Tork, and Pi SDK config when endpoints are absent", async () => {
  const probes: string[] = [];
  const env = await loadRealPostgresE2EEnv({
    SOUTHSTAR_TEST_ADMIN_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    TORK_BASE_URL: "http://127.0.0.1:8000",
    SOUTHSTAR_E2E_WORKSPACE: "/tmp/southstar-postgres-e2e",
  }, {
    dockerVersion: async () => { probes.push("docker"); },
    southstarTaskContainersIdle: async () => { probes.push("containers-idle"); },
    torkHealth: async () => { probes.push("tork"); },
    torkQueueIdle: async () => { probes.push("queue-idle"); },
    piConfig: async () => { probes.push("pi-sdk"); },
  });

  assert.deepEqual(probes, ["docker", "containers-idle", "tork", "queue-idle", "pi-sdk"]);
  assert.equal(env.postgresAdminUrl, "postgres://postgres:postgres@127.0.0.1:5432/postgres");
  assert.equal(env.workspaceRoot, "/tmp/southstar-postgres-e2e");
  assert.equal(env.piPlannerMode, "sdk");
  assert.equal(env.piHarnessMode, "sdk");
});

test("real E2E env can derive Postgres admin URL from the canonical runtime database URL", async () => {
  const env = await loadRealPostgresE2EEnv({
    SOUTHSTAR_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:55432/southstar",
    TORK_BASE_URL: "http://127.0.0.1:8000",
  }, {
    dockerVersion: async () => {},
    southstarTaskContainersIdle: async () => {},
    torkHealth: async () => {},
    torkQueueIdle: async () => {},
    piConfig: async () => {},
  });

  assert.equal(env.postgresAdminUrl, "postgres://postgres:postgres@127.0.0.1:55432/postgres");
  assert.equal(env.torkBaseUrl, "http://127.0.0.1:8000");
});

test("real E2E env probes HTTP Pi config when endpoints are present", async () => {
  const probes: string[] = [];
  const env = await loadRealPostgresE2EEnv({
    SOUTHSTAR_TEST_ADMIN_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    TORK_BASE_URL: "http://127.0.0.1:8000",
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

test("real E2E runtime server uses canonical Pi planner timeout env parsing", () => {
  assert.equal(realE2EPlannerTimeoutMs({}), 600_000);
  assert.equal(realE2EPlannerTimeoutMs({ SOUTHSTAR_PI_PLANNER_TIMEOUT_MS: "600000" }), 600_000);
  assert.equal(realE2EPlannerTimeoutMs({ SOUTHSTAR_PI_PLANNER_TIMEOUT_MS: "not-a-number" }), 600_000);
});

test("real E2E env fails closed when shared Tork queue is not idle", async () => {
  await assert.rejects(() => loadRealPostgresE2EEnv({
    SOUTHSTAR_TEST_ADMIN_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
    TORK_BASE_URL: "http://127.0.0.1:8000",
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

import test from "node:test";
import assert from "node:assert/strict";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";

test("loads v2 env defaults as Postgres-only runtime configuration", () => {
  assert.deepEqual(loadSouthstarEnv({}), {
    databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/southstar",
    testAdminDatabaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/postgres",
    torkBaseUrl: "http://127.0.0.1:8000",
    torkWebUrl: "http://127.0.0.1:8100",
    serverUrl: "http://127.0.0.1:3100",
    containerCallbackBaseUrl: undefined,
    dockerRequired: true,
    piPlannerEndpoint: undefined,
    piPlannerTimeoutMs: 180000,
    codexCliPath: "codex",
  });
});

test("loads explicit v2 env values", () => {
  assert.deepEqual(loadSouthstarEnv({
    SOUTHSTAR_DATABASE_URL: "postgres://southstar:secret@db.local:5432/automation",
    SOUTHSTAR_TEST_ADMIN_DATABASE_URL: "postgres://admin:secret@db.local:5432/postgres",
    TORK_BASE_URL: "http://tork.local",
    TORK_WEB_URL: "http://tork-web.local",
    SOUTHSTAR_SERVER_URL: "http://southstar.local",
    SOUTHSTAR_CONTAINER_CALLBACK_BASE_URL: "http://172.17.0.1:3100",
    SOUTHSTAR_REQUIRE_DOCKER: "0",
    PI_PLANNER_ENDPOINT: "http://pi.local/plan",
    SOUTHSTAR_PI_PLANNER_TIMEOUT_MS: "600000",
    CODEX_CLI_PATH: "/usr/bin/codex",
  }), {
    databaseUrl: "postgres://southstar:secret@db.local:5432/automation",
    testAdminDatabaseUrl: "postgres://admin:secret@db.local:5432/postgres",
    torkBaseUrl: "http://tork.local",
    torkWebUrl: "http://tork-web.local",
    serverUrl: "http://southstar.local",
    containerCallbackBaseUrl: "http://172.17.0.1:3100",
    dockerRequired: false,
    piPlannerEndpoint: "http://pi.local/plan",
    piPlannerTimeoutMs: 600000,
    codexCliPath: "/usr/bin/codex",
  });
});

test("keeps SOUTHSTAR_DB as transitional compatibility alias behind SOUTHSTAR_DATABASE_URL", () => {
  assert.equal(loadSouthstarEnv({ SOUTHSTAR_DB: "postgres://legacy/db" }).databaseUrl, "postgres://legacy/db");
  assert.equal(loadSouthstarEnv({
    SOUTHSTAR_DB: "postgres://legacy/db",
    SOUTHSTAR_DATABASE_URL: "postgres://primary/db",
  }).databaseUrl, "postgres://primary/db");
});

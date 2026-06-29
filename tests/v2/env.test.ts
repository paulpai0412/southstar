import test from "node:test";
import assert from "node:assert/strict";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";

test("loads v2 env defaults as Postgres-only runtime configuration", () => {
  assert.deepEqual(loadSouthstarEnv({}), {
    databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/southstar",
    torkBaseUrl: "http://127.0.0.1:8000",
    serverUrl: "http://127.0.0.1:3100",
    dockerRequired: true,
    piPlannerEndpoint: undefined,
    codexCliPath: "codex",
  });
});

test("loads explicit v2 env values", () => {
  assert.deepEqual(loadSouthstarEnv({
    SOUTHSTAR_DATABASE_URL: "postgres://southstar:secret@db.local:5432/automation",
    TORK_BASE_URL: "http://tork.local",
    SOUTHSTAR_SERVER_URL: "http://southstar.local",
    SOUTHSTAR_REQUIRE_DOCKER: "0",
    PI_PLANNER_ENDPOINT: "http://pi.local/plan",
    CODEX_CLI_PATH: "/usr/bin/codex",
  }), {
    databaseUrl: "postgres://southstar:secret@db.local:5432/automation",
    torkBaseUrl: "http://tork.local",
    serverUrl: "http://southstar.local",
    dockerRequired: false,
    piPlannerEndpoint: "http://pi.local/plan",
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

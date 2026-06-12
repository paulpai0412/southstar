import test from "node:test";
import assert from "node:assert/strict";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";

test("loads v2 env defaults without durable folders", () => {
  assert.deepEqual(loadSouthstarEnv({}), {
    databaseUrl: ".southstar/southstar-v2.sqlite3",
    torkBaseUrl: "http://127.0.0.1:8000",
    dockerRequired: true,
    piPlannerEndpoint: undefined,
    codexCliPath: "codex",
  });
});

test("loads explicit v2 env values", () => {
  assert.deepEqual(loadSouthstarEnv({
    SOUTHSTAR_DB: "/tmp/southstar.sqlite3",
    TORK_BASE_URL: "http://tork.local",
    SOUTHSTAR_REQUIRE_DOCKER: "0",
    PI_PLANNER_ENDPOINT: "http://pi.local/plan",
    CODEX_CLI_PATH: "/usr/bin/codex",
  }), {
    databaseUrl: "/tmp/southstar.sqlite3",
    torkBaseUrl: "http://tork.local",
    dockerRequired: false,
    piPlannerEndpoint: "http://pi.local/plan",
    codexCliPath: "/usr/bin/codex",
  });
});

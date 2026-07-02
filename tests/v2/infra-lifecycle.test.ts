import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarEnv } from "../../src/v2/config/env.ts";
import { createSouthstarInfraLifecycle, filterAllowedTorkBindSources, mergeTorkBindSources } from "../../src/v2/server/infra-lifecycle.ts";

test("infra start brings up local Postgres before Tork", async () => {
  const calls: string[] = [];
  let spawnedTorkConfig: string | undefined;
  let spawnedTestAdminDatabaseUrl: string | undefined;
  const lifecycle = createSouthstarInfraLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv({ testAdminDatabaseUrl: "postgres://admin:postgres@127.0.0.1:55432/postgres" }),
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readTextFile: async (path) => {
      calls.push(`read:${path}`);
      if (path === "/tmp/southstar/.tools/tork/southstar.config.toml") {
        return `[mounts.bind]
allowed = true
sources = [
  "/tmp/southstar-runs"
]
`;
      }
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    },
    spawnChild: (command, args, options) => {
      spawnedTorkConfig = typeof options.env?.TORK_CONFIG === "string" ? options.env.TORK_CONFIG : undefined;
      spawnedTestAdminDatabaseUrl = typeof options.env?.SOUTHSTAR_TEST_ADMIN_DATABASE_URL === "string"
        ? options.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL
        : undefined;
      calls.push(`${command} ${args.join(" ")}`);
      return { pid: 42, unref: () => calls.push("tork:unref") };
    },
    isProcessRunning: () => true,
    isTorkHealthy: async () => {
      calls.push("tork:health");
      return calls.filter((call) => call === "tork:health").length > 1;
    },
    isTorkWebHealthy: async () => {
      calls.push("tork-web:health");
      return calls.filter((call) => call === "tork-web:health").length > 1;
    },
    waitForTcp: async (host, port) => {
      calls.push(`tcp:${host}:${port}`);
    },
    waitForPostgresReady: async (databaseUrl) => {
      calls.push(`pg:${databaseUrl}`);
    },
    listWorkspaceMountSources: async () => ["/home/timmypai/apps/southstar-vocab"],
    writeTextFile: async (path, text) => {
      calls.push(`write:${path}:${text}`);
    },
    ensureDirectory: async (path) => {
      calls.push(`mkdir:${path}`);
    },
  });

  const result = await lifecycle.start();

  assert.equal(result.postgres.status, "started");
  assert.equal(result.tork.status, "started");
  assert.equal(result.torkWeb.status, "started");
  assert.equal(result.torkWeb.url, "http://127.0.0.1:8100");
  assert.equal(spawnedTorkConfig, "/tmp/southstar/.southstar/tork.generated.toml");
  assert.equal(spawnedTestAdminDatabaseUrl, "postgres://admin:postgres@127.0.0.1:55432/postgres");
  assert.deepEqual(calls, [
    "docker start southstar-postgres",
    "tcp:127.0.0.1:55432",
    "pg:postgres://postgres:postgres@127.0.0.1:55432/postgres",
    "tork:health",
    "mkdir:/tmp/southstar/.southstar/logs",
    "read:/tmp/southstar/.tools/tork/southstar.config.toml",
    `write:/tmp/southstar/.southstar/tork.generated.toml:${`[mounts.bind]
allowed = true
sources = [
  "/tmp/southstar-runs",
  "${process.env.HOME}/.pi/agent",
  "/tmp/southstar",
  "/home/timmypai/apps/southstar-vocab"
]

[coordinator]
address = "0.0.0.0:8000"
`}`,
    "/tmp/southstar/scripts/run-local-tork.sh ",
    "tork:unref",
    "write:/tmp/southstar/.southstar/logs/tork.pid:42",
    "tork:health",
    "docker inspect -f {{.State.Running}} southstar-tork-web",
    "tork-web:health",
    "docker rm -f southstar-tork-web",
    "docker run -d --name southstar-tork-web -p 8100:8100 --add-host host.docker.internal:host-gateway -e BACKEND_URL=http://host.docker.internal:8000 runabol/tork-web",
    "tork-web:health",
  ]);
});

test("infra start reuses an already healthy Tork Web container", async () => {
  const calls: string[] = [];
  const lifecycle = createSouthstarInfraLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv(),
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    spawnChild: () => ({ pid: 42, unref: () => {} }),
    isTorkHealthy: async () => true,
    isTorkWebHealthy: async () => {
      calls.push("tork-web:health");
      return true;
    },
    waitForTcp: async () => {},
    waitForPostgresReady: async () => {},
  });

  const result = await lifecycle.start();

  assert.equal(result.tork.status, "already-running");
  assert.equal(result.torkWeb.status, "already-running");
  assert.deepEqual(calls, [
    "docker start southstar-postgres",
    "docker inspect -f {{.State.Running}} southstar-tork-web",
    "tork-web:health",
  ]);
});

test("mergeTorkBindSources preserves allowlist and adds the active workspace root", () => {
  const merged = mergeTorkBindSources(`[datastore]
type = "postgres"

[mounts.bind]
allowed = true
sources = [
  "/tmp/southstar-runs"
]

[mounts.temp]
dir = "/tmp"
`, [
    "/tmp/southstar-runs",
    "/home/timmypai/apps/southstar",
  ]);

  assert.match(merged, /"\/tmp\/southstar-runs"/);
  assert.match(merged, /"\/home\/timmypai\/apps\/southstar"/);
  assert.equal((merged.match(/"\/tmp\/southstar-runs"/g) ?? []).length, 1);
});

test("filterAllowedTorkBindSources keeps legal repos and excludes Southstar project roots", () => {
  assert.deepEqual(filterAllowedTorkBindSources([
    "/home/timmypai/apps/southstar-vocab",
    process.cwd(),
    `${process.cwd()}/web`,
    "/workspace/repo",
    "relative/path",
    "/home/timmypai/apps/southstar-vocab",
  ]), [
    "/home/timmypai/apps/southstar-vocab",
  ]);
});

test("infra start reuses an already healthy Tork process", async () => {
  const calls: string[] = [];
  const lifecycle = createSouthstarInfraLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv(),
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    spawnChild: () => {
      throw new Error("should not spawn");
    },
    isTorkHealthy: async () => {
      calls.push("tork:health");
      return true;
    },
    isTorkWebHealthy: async () => {
      calls.push("tork-web:health");
      return true;
    },
    waitForTcp: async () => {},
    waitForPostgresReady: async (databaseUrl) => {
      calls.push(`pg:${databaseUrl}`);
    },
  });

  const result = await lifecycle.start();

  assert.equal(result.tork.status, "already-running");
  assert.equal(result.torkWeb.status, "already-running");
  assert.deepEqual(calls, [
    "docker start southstar-postgres",
    "pg:postgres://postgres:postgres@127.0.0.1:55432/postgres",
    "tork:health",
    "docker inspect -f {{.State.Running}} southstar-tork-web",
    "tork-web:health",
  ]);
});

test("infra stop shuts down Tork before local Postgres", async () => {
  const calls: string[] = [];
  let torkRunning = true;
  const lifecycle = createSouthstarInfraLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv(),
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "lsof") return { exitCode: 0, stdout: "77\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    processKill: (pid, signal) => {
      calls.push(`kill:${pid}:${signal ?? ""}`);
      if (pid === 77) torkRunning = false;
    },
    isProcessRunning: (pid) => pid === 77 ? torkRunning : false,
    readTextFile: async () => {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    },
    removeFile: async (path) => {
      calls.push(`rm:${path}`);
    },
    sleep: async () => {},
  });

  const result = await lifecycle.stop();

  assert.equal(result.torkWeb.status, "stopped");
  assert.equal(result.tork.status, "stopped");
  assert.equal(result.postgres.status, "stopped");
  assert.deepEqual(calls, [
    "docker stop southstar-tork-web",
    "lsof -tiTCP:8000 -sTCP:LISTEN",
    "kill:77:SIGTERM",
    "rm:/tmp/southstar/.southstar/logs/tork.pid",
    "docker stop southstar-postgres",
  ]);
});

test("infra stop falls back to the Tork listen port when the pid file is stale", async () => {
  const calls: string[] = [];
  let torkRunning = true;
  const lifecycle = createSouthstarInfraLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv(),
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "lsof") return { exitCode: 0, stdout: "88\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    processKill: (pid, signal) => {
      calls.push(`kill:${pid}:${signal ?? ""}`);
      if (pid === 88) torkRunning = false;
    },
    isProcessRunning: (pid) => pid === 88 ? torkRunning : false,
    readTextFile: async () => "77",
    removeFile: async (path) => {
      calls.push(`rm:${path}`);
    },
    sleep: async () => {},
  });

  const result = await lifecycle.stop();

  assert.equal(result.torkWeb.status, "stopped");
  assert.equal(result.tork.status, "stopped");
  assert.equal(result.tork.pid, 88);
  assert.deepEqual(calls, [
    "docker stop southstar-tork-web",
    "lsof -tiTCP:8000 -sTCP:LISTEN",
    "kill:88:SIGTERM",
    "rm:/tmp/southstar/.southstar/logs/tork.pid",
    "docker stop southstar-postgres",
  ]);
});

function localEnv(overrides: Partial<SouthstarEnv> = {}): SouthstarEnv {
  return {
    databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/southstar",
    torkBaseUrl: "http://127.0.0.1:8000",
    torkWebUrl: "http://127.0.0.1:8100",
    serverUrl: "http://127.0.0.1:3100",
    dockerRequired: true,
    codexCliPath: "codex",
    ...overrides,
  };
}

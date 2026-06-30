import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarEnv } from "../../src/v2/config/env.ts";
import { createSouthstarInfraLifecycle } from "../../src/v2/server/infra-lifecycle.ts";

test("infra start brings up local Postgres before Tork", async () => {
  const calls: string[] = [];
  const lifecycle = createSouthstarInfraLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv(),
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    spawnChild: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { pid: 42, unref: () => calls.push("tork:unref") };
    },
    isProcessRunning: () => true,
    isTorkHealthy: async () => {
      calls.push("tork:health");
      return calls.filter((call) => call === "tork:health").length > 1;
    },
    waitForTcp: async (host, port) => {
      calls.push(`tcp:${host}:${port}`);
    },
    waitForPostgresReady: async (databaseUrl) => {
      calls.push(`pg:${databaseUrl}`);
    },
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
  assert.deepEqual(calls, [
    "docker start southstar-postgres",
    "tcp:127.0.0.1:55432",
    "pg:postgres://postgres:postgres@127.0.0.1:55432/postgres",
    "tork:health",
    "mkdir:/tmp/southstar/.southstar/logs",
    "/tmp/southstar/scripts/run-local-tork.sh ",
    "tork:unref",
    "write:/tmp/southstar/.southstar/logs/tork.pid:42",
    "tork:health",
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
    waitForTcp: async () => {},
    waitForPostgresReady: async (databaseUrl) => {
      calls.push(`pg:${databaseUrl}`);
    },
  });

  const result = await lifecycle.start();

  assert.equal(result.tork.status, "already-running");
  assert.deepEqual(calls, [
    "docker start southstar-postgres",
    "pg:postgres://postgres:postgres@127.0.0.1:55432/postgres",
    "tork:health",
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

  assert.equal(result.tork.status, "stopped");
  assert.equal(result.postgres.status, "stopped");
  assert.deepEqual(calls, [
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

  assert.equal(result.tork.status, "stopped");
  assert.equal(result.tork.pid, 88);
  assert.deepEqual(calls, [
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
    serverUrl: "http://127.0.0.1:3100",
    dockerRequired: true,
    codexCliPath: "codex",
    ...overrides,
  };
}

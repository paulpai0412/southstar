import test from "node:test";
import assert from "node:assert/strict";
import type { SouthstarEnv } from "../../src/v2/config/env.ts";
import {
  connectSouthstarDbWithRetry,
  createRuntimeServerLifecycle,
  maybeStartSouthstarPostgresContainer,
} from "../../src/v2/server/runtime-server-lifecycle.ts";

test("auto-starts southstar-postgres container for local Postgres runtime URLs", async () => {
  const commands: Array<{ command: string; args: string[] }> = [];
  const waited: Array<{ host: string; port: number; timeoutMs: number }> = [];
  await maybeStartSouthstarPostgresContainer(localEnv({
    dockerRequired: true,
    databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/southstar",
  }), {
    runCommand: async (command, args) => {
      commands.push({ command, args });
      return { exitCode: 0, stdout: "southstar-postgres", stderr: "" };
    },
    waitForTcp: async (host, port, timeoutMs) => {
      waited.push({ host, port, timeoutMs });
    },
  });

  assert.deepEqual(commands, [{ command: "docker", args: ["start", "southstar-postgres"] }]);
  assert.deepEqual(waited, [{ host: "127.0.0.1", port: 55432, timeoutMs: 15_000 }]);
});

test("skips docker bootstrap when dockerRequired is disabled", async () => {
  const commands: string[] = [];
  await maybeStartSouthstarPostgresContainer(localEnv({
    dockerRequired: false,
  }), {
    runCommand: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(commands, []);
});

test("skips docker bootstrap for non-loopback Postgres hosts", async () => {
  const commands: string[] = [];
  await maybeStartSouthstarPostgresContainer(localEnv({
    databaseUrl: "postgres://southstar:secret@db.internal:55432/southstar",
  }), {
    runCommand: async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(commands, []);
});

test("fails closed when docker start command fails", async () => {
  await assert.rejects(
    () => maybeStartSouthstarPostgresContainer(localEnv(), {
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "No such container: southstar-postgres" }),
      waitForTcp: async () => {},
    }),
    /failed to auto-start docker container southstar-postgres: No such container: southstar-postgres/,
  );
});

test("start accepts server pidfile even when detached wrapper pid differs", async () => {
  let readCount = 0;
  const lifecycle = createRuntimeServerLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv(),
    sleep: async () => {},
    runCommand: async () => ({ exitCode: 0, stdout: "100\n", stderr: "" }),
    processKill: (pid) => {
      if (pid === 100 || pid === 200) return;
      const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
      throw error;
    },
    readTextFile: async () => {
      readCount += 1;
      if (readCount < 2) {
        const error = Object.assign(new Error("missing"), { code: "ENOENT" });
        throw error;
      }
      return JSON.stringify({
        pid: 200,
        host: "127.0.0.1",
        port: 3100,
        url: "http://127.0.0.1:3100",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp/southstar",
      });
    },
    writeTextFile: async () => {},
    ensureDirectory: async () => {},
    removeFile: async () => {},
  });

  const started = await lifecycle.start();
  assert.equal(started.status, "started");
  assert.equal(started.record.pid, 200);
});

test("start exports canonical Postgres and Tork env into detached serve process", async () => {
  let launchedScript = "";
  let readCount = 0;
  const lifecycle = createRuntimeServerLifecycle({
    cwd: "/tmp/southstar",
    envLoader: () => localEnv({
      databaseUrl: "postgres://southstar:secret@127.0.0.1:55432/southstar",
      torkBaseUrl: "http://127.0.0.1:8000",
      serverUrl: "http://127.0.0.1:3100",
    }),
    sleep: async () => {},
    runCommand: async (_command, args) => {
      launchedScript = args[1] ?? "";
      return { exitCode: 0, stdout: "100\n", stderr: "" };
    },
    processKill: (pid) => {
      if (pid === 100 || pid === 200) return;
      const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
      throw error;
    },
    readTextFile: async () => {
      readCount += 1;
      if (readCount < 2) {
        const error = Object.assign(new Error("missing"), { code: "ENOENT" });
        throw error;
      }
      return JSON.stringify({
        pid: 200,
        host: "127.0.0.1",
        port: 3100,
        url: "http://127.0.0.1:3100",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp/southstar",
      });
    },
    writeTextFile: async () => {},
    ensureDirectory: async () => {},
    removeFile: async () => {},
  });

  await lifecycle.start();

  assert.match(launchedScript, /SOUTHSTAR_DATABASE_URL='postgres:\/\/southstar:secret@127\.0\.0\.1:55432\/southstar'/);
  assert.match(launchedScript, /TORK_BASE_URL='http:\/\/127\.0\.0\.1:8000'/);
  assert.match(launchedScript, /SOUTHSTAR_SERVER_URL='http:\/\/127\.0\.0\.1:3100'/);
});

test("retries transient Postgres startup errors before succeeding", async () => {
  let attempts = 0;
  const db = await connectSouthstarDbWithRetry("postgres://postgres:postgres@127.0.0.1:55432/southstar", {
    openDb: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Connection terminated unexpectedly");
      return { close: async () => {}, query: async () => ({ rows: [], rowCount: 0 }), one: async () => ({}), maybeOne: async () => null, tx: async (fn) => await fn({} as never) } as never;
    },
    sleep: async () => {},
    timeoutMs: 5_000,
  });
  assert.ok(db);
  assert.equal(attempts, 3);
});

test("fails fast for non-transient Postgres errors", async () => {
  await assert.rejects(
    () => connectSouthstarDbWithRetry("postgres://postgres:postgres@127.0.0.1:55432/southstar", {
      openDb: async () => {
        throw new Error("schema validation failed");
      },
      sleep: async () => {},
      timeoutMs: 5_000,
    }),
    /schema validation failed/,
  );
});

function localEnv(overrides: Partial<SouthstarEnv> = {}): SouthstarEnv {
  return {
    databaseUrl: "postgres://postgres:postgres@127.0.0.1:55432/southstar",
    torkBaseUrl: "http://127.0.0.1:8000",
    serverUrl: "http://127.0.0.1:3100",
    dockerRequired: true,
    piPlannerEndpoint: undefined,
    codexCliPath: "codex",
    ...overrides,
  };
}

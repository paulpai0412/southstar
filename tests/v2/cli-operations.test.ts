import test from "node:test";
import assert from "node:assert/strict";
import { executeV2Command, main, parseV2Command } from "../../src/v2/cli.ts";
import type { CliRuntimeClient } from "../../src/v2/cli-client.ts";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";
import type { SouthstarInfraLifecycle } from "../../src/v2/server/infra-lifecycle.ts";
import type { RuntimeServerLifecycle } from "../../src/v2/server/runtime-server-lifecycle.ts";
import type { WebServerLifecycle } from "../../src/v2/server/web-server-lifecycle.ts";

test("parses phase 1.5 CLI commands", () => {
  assert.deepEqual(parseV2Command(["db:init", "--database-url", "postgres://db/southstar"]), {
    command: "db:init",
    databaseUrl: "postgres://db/southstar",
  });
  assert.deepEqual(parseV2Command(["db:init", "--config", "/tmp/southstar.yaml"]), {
    command: "db:init",
    configPath: "/tmp/southstar.yaml",
  });
  assert.deepEqual(parseV2Command(["db:migrate-legacy-contracts", "--database-url", "postgres://db/southstar"]), {
    command: "db:migrate-legacy-contracts",
    databaseUrl: "postgres://db/southstar",
    apply: false,
  });
  assert.deepEqual(parseV2Command(["db:migrate-legacy-contracts", "--config", "/tmp/southstar.yaml", "--apply"]), {
    command: "db:migrate-legacy-contracts",
    configPath: "/tmp/southstar.yaml",
    apply: true,
  });
  assert.deepEqual(parseV2Command(["serve"]), { command: "serve", host: undefined, port: undefined, pidFilePath: undefined });
  assert.deepEqual(parseV2Command(["start"]), { command: "start", host: undefined, port: undefined, pidFilePath: undefined });
  assert.deepEqual(parseV2Command(["stop"]), { command: "stop", pidFilePath: undefined });
  assert.deepEqual(parseV2Command(["status"]), { command: "server-status", pidFilePath: undefined });
  assert.deepEqual(parseV2Command(["status", "--pid-file", ".southstar/custom.pid"]), {
    command: "server-status",
    pidFilePath: ".southstar/custom.pid",
  });
  assert.deepEqual(parseV2Command(["serve", "--host", "0.0.0.0", "--port", "3200"]), {
    command: "serve",
    host: "0.0.0.0",
    port: 3200,
    pidFilePath: undefined,
  });
  assert.deepEqual(parseV2Command(["start", "--host", "0.0.0.0", "--port", "3200"]), {
    command: "start",
    host: "0.0.0.0",
    port: 3200,
    pidFilePath: undefined,
  });
  assert.throws(() => parseV2Command(["start", "--port", "0"]), /--port must be an integer between 1 and 65535/);
  assert.deepEqual(parseV2Command(["run-goal", "--goal", "Add calc sum"]), { command: "run-goal", goal: "Add calc sum" });
  assert.deepEqual(parseV2Command(["run-goal", "--goal", "Add calc sum", "--cwd", "/workspace/calc"]), {
    command: "run-goal",
    goal: "Add calc sum",
    cwd: "/workspace/calc",
  });
  assert.deepEqual(parseV2Command(["wait", "--run-id", "run-1"]), { command: "wait", runId: "run-1" });
  assert.deepEqual(parseV2Command(["tasks", "--run-id", "run-1"]), { command: "tasks", runId: "run-1" });
  assert.deepEqual(parseV2Command(["task", "--run-id", "run-1", "--task-id", "task-1"]), {
    command: "task",
    runId: "run-1",
    taskId: "task-1",
  });
  assert.deepEqual(parseV2Command(["artifacts", "--run-id", "run-1"]), { command: "artifacts", runId: "run-1" });
  assert.deepEqual(parseV2Command(["sessions", "--run-id", "run-1"]), { command: "sessions", runId: "run-1" });
  assert.deepEqual(parseV2Command(["memory", "--run-id", "run-1"]), { command: "memory", runId: "run-1" });
  assert.deepEqual(parseV2Command(["logs", "--run-id", "run-1"]), { command: "logs", runId: "run-1" });
  assert.deepEqual(parseV2Command(["voice-command", "--run-id", "run-1", "--transcript", "approve low risk"]), {
    command: "voice-command",
    runId: "run-1",
    transcript: "approve low risk",
  });
  assert.deepEqual(parseV2Command(["read-model", "--kind", "run-inspection", "--run-id", "run-1"]), {
    command: "read-model",
    kind: "run-inspection",
    runId: "run-1",
  });
  assert.deepEqual(parseV2Command(["read-model", "--kind", "task-detail", "--run-id", "run-1", "--task-id", "task-1"]), {
    command: "read-model",
    kind: "task-detail",
    runId: "run-1",
    taskId: "task-1",
  });
});

test("db:init executes through the V2 Postgres schema initializer", async () => {
  const initialized: string[] = [];
  const result = await executeV2Command(parseV2Command(["db:init", "--database-url", "postgres://db/southstar"]), {
    initializeSchema: async (databaseUrl) => {
      initialized.push(databaseUrl);
      return { version: "2026_06_17_test" };
    },
  });

  assert.deepEqual(initialized, ["postgres://db/southstar"]);
  assert.deepEqual(result, {
    kind: "db:init",
    result: { type: "db:init", schemaVersion: "2026_06_17_test" },
  });
});

test("server-backed phase 1.5 CLI commands execute through the runtime client without local db fallback", async () => {
  const calls: string[] = [];
  const runGoalRequests: Array<Record<string, unknown>> = [];
  const runtimeClient = {
    runGoal: async (body: Record<string, unknown>) => {
      runGoalRequests.push(body);
      return envelope("run-goal", { runId: "run-1" }, calls);
    },
    getRun: async () => envelope("status", { runId: "run-1" }, calls),
    listTasks: async () => envelope("tasks", [], calls),
    getTask: async () => envelope("task", { id: "task-1" }, calls),
    listArtifacts: async () => envelope("artifacts", [], calls),
    listSessions: async () => envelope("sessions", [], calls),
    listMemory: async () => envelope("memory", [], calls),
    listLogs: async () => envelope("logs", [], calls),
    voiceCommand: async () => envelope("voice-command", { transcript: "approve" }, calls),
    getReadModel: async () => envelope("read-model", { kind: "run-inspection", data: { runId: "run-1" } }, calls),
  } as unknown as CliRuntimeClient;

  const commands = [
    ["run-goal", "--goal", "Add calc sum"],
    ["wait", "--run-id", "run-1"],
    ["tasks", "--run-id", "run-1"],
    ["task", "--run-id", "run-1", "--task-id", "task-1"],
    ["artifacts", "--run-id", "run-1"],
    ["sessions", "--run-id", "run-1"],
    ["memory", "--run-id", "run-1"],
    ["logs", "--run-id", "run-1"],
    ["voice-command", "--run-id", "run-1", "--transcript", "approve"],
    ["read-model", "--kind", "run-inspection", "--run-id", "run-1"],
  ];

  for (const argv of commands) {
    const parsed = parseV2Command(argv);
    const result = await executeV2Command(parsed, { runtimeClient });
    assert.notEqual(result.kind, "serve");
  }
  assert.deepEqual(calls, ["run-goal", "status", "tasks", "task", "artifacts", "sessions", "memory", "logs", "voice-command", "read-model"]);
  assert.equal(runGoalRequests[0]?.goalPrompt, "Add calc sum");
  assert.equal(runGoalRequests[0]?.cwd, process.cwd());
  assert.match(String(runGoalRequests[0]?.idempotencyKey), /^[0-9a-f-]{36}$/);
});

test("task-detail read-model CLI requires task id", () => {
  assert.throws(
    () => parseV2Command(["read-model", "--kind", "task-detail", "--run-id", "run-1"]),
    /--task-id is required for task-detail read model/,
  );
});

test("server lifecycle commands execute through runtime + web lifecycle dependencies", async () => {
  const infraCalls: string[] = [];
  const runtimeCalls: string[] = [];
  const webCalls: string[] = [];
  const infraLifecycle = {
    start: async () => {
      infraCalls.push("start");
      return {
        postgres: { status: "started" as const, containerName: "southstar-postgres" },
        tork: { status: "started" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        torkWeb: { status: "started" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
      };
    },
    stop: async () => {
      infraCalls.push("stop");
      return {
        torkWeb: { status: "stopped" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
        tork: { status: "stopped" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        postgres: { status: "stopped" as const, containerName: "southstar-postgres" },
      };
    },
    status: async () => {
      infraCalls.push("status");
      return {
        postgres: { status: "running" as const, containerName: "southstar-postgres" },
        tork: { status: "running" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        torkWeb: { status: "running" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
      };
    },
  } satisfies SouthstarInfraLifecycle;
  const runtimeLifecycle = {
    serve: async () => {
      runtimeCalls.push("serve");
      return {
        status: "stopped",
        signal: "SIGTERM",
        pidFilePath: ".southstar/runtime-server.pid",
        record: {
          pid: 12345,
          host: "127.0.0.1",
          port: 3100,
          url: "http://127.0.0.1:3100",
          startedAt: "2026-06-27T00:00:00.000Z",
          cwd: "/tmp",
        },
      };
    },
    start: async () => {
      runtimeCalls.push("start");
      return {
        status: "started",
        pidFilePath: ".southstar/runtime-server.pid",
        record: {
          pid: 12346,
          host: "127.0.0.1",
          port: 3100,
          url: "http://127.0.0.1:3100",
          startedAt: "2026-06-27T00:00:00.000Z",
          cwd: "/tmp",
        },
      };
    },
    stop: async () => {
      runtimeCalls.push("stop");
      return { status: "not-running", pidFilePath: ".southstar/runtime-server.pid" };
    },
    status: async () => {
      runtimeCalls.push("status");
      return { status: "stopped", pidFilePath: ".southstar/runtime-server.pid" };
    },
  };
  const webLifecycle = {
    start: async () => {
      webCalls.push("start");
      return {
        status: "started" as const,
        pidFilePath: ".southstar/web-server.pid",
        record: {
          pid: 22346,
          host: "127.0.0.1",
          port: 30141,
          url: "http://127.0.0.1:30141",
          startedAt: "2026-06-27T00:00:00.000Z",
          cwd: "/tmp/pi-web",
          apiUrl: "http://127.0.0.1:3100",
        },
      };
    },
    stop: async () => {
      webCalls.push("stop");
      return { status: "not-running" as const, pidFilePath: ".southstar/web-server.pid" };
    },
    status: async () => {
      webCalls.push("status");
      return { status: "stopped" as const, pidFilePath: ".southstar/web-server.pid" };
    },
  };

  assert.equal((await executeV2Command(parseV2Command(["serve"]), { serverLifecycle: runtimeLifecycle as RuntimeServerLifecycle })).kind, "server:serve");
  assert.equal((await executeV2Command(parseV2Command(["start"]), {
    infraLifecycle,
    serverLifecycle: runtimeLifecycle as RuntimeServerLifecycle,
    webServerLifecycle: webLifecycle as WebServerLifecycle,
  })).kind, "server:start");
  assert.equal((await executeV2Command(parseV2Command(["stop"]), {
    infraLifecycle,
    serverLifecycle: runtimeLifecycle as RuntimeServerLifecycle,
    webServerLifecycle: webLifecycle as WebServerLifecycle,
  })).kind, "server:stop");
  assert.equal((await executeV2Command(parseV2Command(["status"]), {
    infraLifecycle,
    serverLifecycle: runtimeLifecycle as RuntimeServerLifecycle,
    webServerLifecycle: webLifecycle as WebServerLifecycle,
  })).kind, "server:status");
  assert.deepEqual(infraCalls, ["start", "stop", "status"]);
  assert.deepEqual(runtimeCalls, ["serve", "start", "stop", "status"]);
  assert.deepEqual(webCalls, ["start", "stop", "status"]);
});

test("server start and stop manage infra in dependency order", async () => {
  const calls: string[] = [];
  const infraLifecycle = {
    start: async () => {
      calls.push("infra:start");
      return {
        postgres: { status: "started" as const, containerName: "southstar-postgres" },
        tork: { status: "started" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        torkWeb: { status: "started" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
      };
    },
    stop: async () => {
      calls.push("infra:stop");
      return {
        torkWeb: { status: "stopped" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
        tork: { status: "stopped" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        postgres: { status: "stopped" as const, containerName: "southstar-postgres" },
      };
    },
    status: async () => {
      calls.push("infra:status");
      return {
        postgres: { status: "running" as const, containerName: "southstar-postgres" },
        tork: { status: "running" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        torkWeb: { status: "running" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
      };
    },
  } satisfies SouthstarInfraLifecycle;
  const runtimeLifecycle = {
    serve: async () => {
      calls.push("runtime:serve");
      throw new Error("not used");
    },
    start: async () => {
      calls.push("runtime:start");
      return {
        status: "started" as const,
        pidFilePath: ".southstar/runtime-server.pid",
        record: {
          pid: 12345,
          host: "127.0.0.1",
          port: 3100,
          url: "http://127.0.0.1:3100",
          startedAt: "2026-06-27T00:00:00.000Z",
          cwd: "/tmp",
        },
      };
    },
    stop: async () => {
      calls.push("runtime:stop");
      return { status: "stopped" as const, pidFilePath: ".southstar/runtime-server.pid", record: {
        pid: 12345,
        host: "127.0.0.1",
        port: 3100,
        url: "http://127.0.0.1:3100",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp",
      } };
    },
    status: async () => {
      calls.push("runtime:status");
      return { status: "running" as const, pidFilePath: ".southstar/runtime-server.pid", record: {
        pid: 12345,
        host: "127.0.0.1",
        port: 3100,
        url: "http://127.0.0.1:3100",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp",
      } };
    },
  } satisfies RuntimeServerLifecycle;
  const webLifecycle = {
    start: async () => {
      calls.push("web:start");
      return { status: "started" as const, pidFilePath: ".southstar/web-server.pid", record: {
        pid: 22346,
        host: "127.0.0.1",
        port: 30141,
        url: "http://127.0.0.1:30141",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp/pi-web",
        apiUrl: "http://127.0.0.1:3100",
      } };
    },
    stop: async () => {
      calls.push("web:stop");
      return { status: "stopped" as const, pidFilePath: ".southstar/web-server.pid", record: {
        pid: 22346,
        host: "127.0.0.1",
        port: 30141,
        url: "http://127.0.0.1:30141",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp/pi-web",
        apiUrl: "http://127.0.0.1:3100",
      } };
    },
    status: async () => {
      calls.push("web:status");
      return { status: "running" as const, pidFilePath: ".southstar/web-server.pid", record: {
        pid: 22346,
        host: "127.0.0.1",
        port: 30141,
        url: "http://127.0.0.1:30141",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp/pi-web",
        apiUrl: "http://127.0.0.1:3100",
      } };
    },
  } satisfies WebServerLifecycle;

  const started = await executeV2Command(parseV2Command(["start"]), {
    infraLifecycle,
    serverLifecycle: runtimeLifecycle,
    webServerLifecycle: webLifecycle,
  });
  const stopped = await executeV2Command(parseV2Command(["stop"]), {
    infraLifecycle,
    serverLifecycle: runtimeLifecycle,
    webServerLifecycle: webLifecycle,
  });
  const status = await executeV2Command(parseV2Command(["status"]), {
    infraLifecycle,
    serverLifecycle: runtimeLifecycle,
    webServerLifecycle: webLifecycle,
  });

  assert.equal(started.kind, "server:start");
  assert.equal(stopped.kind, "server:stop");
  assert.equal(status.kind, "server:status");
  assert.deepEqual(calls, [
    "infra:start",
    "runtime:start",
    "web:start",
    "web:stop",
    "runtime:stop",
    "infra:stop",
    "runtime:status",
    "web:status",
    "infra:status",
  ]);
});

test("main supports injected runtime client and does not need a local database", async () => {
  const writes: string[] = [];
  const runtimeClient = {
    getRun: async () => envelope("status", { canvas: { status: "unknown" } }, []),
  } as unknown as CliRuntimeClient;
  const exitCode = await main(["status", "--run-id", "run-missing"], {
    runtimeClient,
    write: (text) => writes.push(text),
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(writes[0]!).result.canvas.status, "unknown");
});

test("main supports injected runtime lifecycle for server status", async () => {
  const writes: string[] = [];
  const runtimeLifecycle = {
    serve: async () => ({
      status: "stopped",
      signal: "SIGTERM" as const,
      pidFilePath: ".southstar/runtime-server.pid",
      record: {
        pid: 1000,
        host: "127.0.0.1",
        port: 3100,
        url: "http://127.0.0.1:3100",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp",
      },
    }),
    start: async () => ({
      status: "started" as const,
      pidFilePath: ".southstar/runtime-server.pid",
      record: {
        pid: 1000,
        host: "127.0.0.1",
        port: 3100,
        url: "http://127.0.0.1:3100",
        startedAt: "2026-06-27T00:00:00.000Z",
        cwd: "/tmp",
      },
    }),
    stop: async () => ({ status: "not-running" as const, pidFilePath: ".southstar/runtime-server.pid" }),
    status: async () => ({ status: "stopped" as const, pidFilePath: ".southstar/runtime-server.pid" }),
  };
  const exitCode = await main(["status"], {
    infraLifecycle: {
      start: async () => ({
        postgres: { status: "started" as const, containerName: "southstar-postgres" },
        tork: { status: "started" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        torkWeb: { status: "started" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
      }),
      stop: async () => ({
        torkWeb: { status: "stopped" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
        tork: { status: "stopped" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        postgres: { status: "stopped" as const, containerName: "southstar-postgres" },
      }),
      status: async () => ({
        postgres: { status: "running" as const, containerName: "southstar-postgres" },
        tork: { status: "running" as const, baseUrl: "http://127.0.0.1:8000", pidFilePath: ".southstar/logs/tork.pid" },
        torkWeb: { status: "running" as const, url: "http://127.0.0.1:8100", containerName: "southstar-tork-web" },
      }),
    } satisfies SouthstarInfraLifecycle,
    serverLifecycle: runtimeLifecycle as RuntimeServerLifecycle,
    webServerLifecycle: {
      start: async () => ({
        status: "started" as const,
        pidFilePath: ".southstar/web-server.pid",
        record: {
          pid: 1100,
          host: "127.0.0.1",
          port: 30141,
          url: "http://127.0.0.1:30141",
          startedAt: "2026-06-27T00:00:00.000Z",
          cwd: "/tmp/pi-web",
          apiUrl: "http://127.0.0.1:3100",
        },
      }),
      stop: async () => ({ status: "not-running" as const, pidFilePath: ".southstar/web-server.pid" }),
      status: async () => ({ status: "stopped" as const, pidFilePath: ".southstar/web-server.pid" }),
    } as WebServerLifecycle,
    write: (text) => writes.push(text),
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(writes[0]!).kind, "server:status");
});

test("loads runtime server URL for CLI clients", () => {
  assert.equal(loadSouthstarEnv({}).serverUrl, "http://127.0.0.1:3100");
  assert.equal(loadSouthstarEnv({ SOUTHSTAR_SERVER_URL: "http://127.0.0.1:3999" }).serverUrl, "http://127.0.0.1:3999");
});

function envelope<T>(kind: string, result: T, calls: string[]) {
  calls.push(kind);
  return { ok: true as const, kind, result };
}

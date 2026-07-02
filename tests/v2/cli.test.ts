import test from "node:test";
import assert from "node:assert/strict";
import { executeV2Command, parseV2Command } from "../../src/v2/cli.ts";
import type { SouthstarInfraLifecycle } from "../../src/v2/server/infra-lifecycle.ts";
import type { RuntimeServerLifecycle } from "../../src/v2/server/runtime-server-lifecycle.ts";

test("parses v2 plan command", () => {
  assert.deepEqual(parseV2Command(["plan", "--goal", "implement calc sum"]), {
    command: "plan",
    goal: "implement calc sum",
  });
});

test("parses v2 run and status commands", () => {
  assert.deepEqual(parseV2Command(["run", "--draft-id", "draft-1"]), {
    command: "run",
    draftId: "draft-1",
  });
  assert.deepEqual(parseV2Command(["status", "--run-id", "run-1"]), {
    command: "status",
    runId: "run-1",
  });
  assert.deepEqual(parseV2Command(["status"]), {
    command: "server-status",
    pidFilePath: undefined,
  });
  assert.deepEqual(parseV2Command(["start"]), {
    command: "start",
    host: undefined,
    port: undefined,
    pidFilePath: undefined,
  });
  assert.deepEqual(parseV2Command(["stop"]), {
    command: "stop",
    pidFilePath: undefined,
  });
});

test("parses v2 steering and task-envelope commands", () => {
  assert.deepEqual(parseV2Command(["steer", "--run-id", "run-1", "--message", "keep minimal"]), {
    command: "steer",
    runId: "run-1",
    message: "keep minimal",
  });
  assert.deepEqual(parseV2Command(["task-envelope", "--run-id", "run-1", "--task-id", "task-1"]), {
    command: "task-envelope",
    runId: "run-1",
    taskId: "task-1",
  });
});

test("rejects missing v2 command args", () => {
  assert.throws(() => parseV2Command(["plan"]), /--goal is required/);
  assert.throws(() => parseV2Command(["unknown"]), /Unknown southstar:v2 command/);
});

test("executes v2 CLI plan/run/status/task-envelope through runtime client without local db fallback", async () => {
  const calls: string[] = [];
  const runtimeClient = {
    createPlannerDraft: async () => envelope("planner-draft", { draftId: "draft-1", goalPrompt: "implement calc sum", workflowId: "wf-1" }, calls),
    createRun: async () => envelope("run", { runId: "run-1", taskIds: ["task-1"] }, calls),
    getRun: async () => envelope("status", { canvas: { nodes: [] } }, calls),
    getTaskEnvelope: async () => envelope("task-envelope", { schemaVersion: "southstar.task-envelope.v2", taskId: "task-1" }, calls),
  } as any;

  assert.equal((await executeV2Command(parseV2Command(["plan", "--goal", "implement calc sum"]), { runtimeClient })).kind, "planner-draft");
  assert.equal((await executeV2Command(parseV2Command(["run", "--draft-id", "draft-1"]), { runtimeClient })).kind, "run");
  assert.equal((await executeV2Command(parseV2Command(["status", "--run-id", "run-1"]), { runtimeClient })).kind, "status");
  assert.equal((await executeV2Command(parseV2Command(["task-envelope", "--run-id", "run-1", "--task-id", "task-1"]), { runtimeClient })).kind, "task-envelope");
  assert.deepEqual(calls, ["planner-draft", "run", "status", "task-envelope"]);
});

test("v2 CLI commands fail closed without runtime client instead of using local SQLite fallback", async () => {
  await assert.rejects(
    () => executeV2Command(parseV2Command(["status", "--run-id", "run-1"]), {}),
    /runtime server client is required/,
  );
});

test("server lifecycle commands fail closed without lifecycle dependency", async () => {
  await assert.rejects(
    () => executeV2Command(parseV2Command(["status"]), { infraLifecycle: fakeInfraLifecycle() }),
    /runtime server lifecycle is required/,
  );
});

test("start command fails closed when web lifecycle dependency is missing", async () => {
  const runtimeLifecycle = {
    serve: async () => ({
      status: "stopped" as const,
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
    status: async () => ({ status: "running" as const, pidFilePath: ".southstar/runtime-server.pid", record: {
      pid: 1000,
      host: "127.0.0.1",
      port: 3100,
      url: "http://127.0.0.1:3100",
      startedAt: "2026-06-27T00:00:00.000Z",
      cwd: "/tmp",
    } }),
  } as RuntimeServerLifecycle;
  await assert.rejects(
    () => executeV2Command(parseV2Command(["start"]), {
      infraLifecycle: fakeInfraLifecycle(),
      serverLifecycle: runtimeLifecycle,
    }),
    /web server lifecycle is required/,
  );
});

function fakeInfraLifecycle(): SouthstarInfraLifecycle {
  return {
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
  };
}

function envelope<T>(kind: string, result: T, calls: string[]) {
  calls.push(kind);
  return { ok: true as const, kind, result };
}

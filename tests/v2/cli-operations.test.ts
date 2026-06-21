import test from "node:test";
import assert from "node:assert/strict";
import { executeV2Command, main, parseV2Command } from "../../src/v2/cli.ts";
import type { CliRuntimeClient } from "../../src/v2/cli-client.ts";
import { formatRunStatusSummary } from "../../src/v2/cli-format.ts";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";

test("parses phase 1.5 CLI commands", () => {
  assert.deepEqual(parseV2Command(["db:init", "--database-url", "postgres://db/southstar"]), {
    command: "db:init",
    databaseUrl: "postgres://db/southstar",
  });
  assert.deepEqual(parseV2Command(["db:init", "--config", "/tmp/southstar.yaml"]), {
    command: "db:init",
    configPath: "/tmp/southstar.yaml",
  });
  assert.deepEqual(parseV2Command(["serve"]), { command: "serve" });
  assert.deepEqual(parseV2Command(["run-goal", "--goal", "Add calc sum"]), { command: "run-goal", goal: "Add calc sum" });
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
  const runtimeClient = {
    runGoal: async () => envelope("run-goal", { runId: "run-1" }, calls),
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
});

test("task-detail read-model CLI requires task id", () => {
  assert.throws(
    () => parseV2Command(["read-model", "--kind", "task-detail", "--run-id", "run-1"]),
    /--task-id is required for task-detail read model/,
  );
});

test("serve command fails closed because it belongs to the runtime server entrypoint", async () => {
  await assert.rejects(
    () => executeV2Command(parseV2Command(["serve"]), {}),
    /serve is implemented by src\/v2\/server entrypoint task/,
  );
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

test("formats run status summary for CLI diagnostics", () => {
  assert.equal(formatRunStatusSummary({
    canvas: { runId: "run-1", status: "running" },
    runtime: { status: "running", latestProgress: "planner.completed", executorJobIds: ["job-1"], runningTaskIds: ["implementer"] },
  }), [
    "Run: run-1",
    "Status: running",
    "Running tasks: implementer",
    "Executor jobs: job-1",
    "Latest progress: planner.completed",
  ].join("\n"));
});

test("loads runtime server URL for CLI clients", () => {
  assert.equal(loadSouthstarEnv({}).serverUrl, "http://127.0.0.1:3100");
  assert.equal(loadSouthstarEnv({ SOUTHSTAR_SERVER_URL: "http://127.0.0.1:3999" }).serverUrl, "http://127.0.0.1:3999");
});

function envelope<T>(kind: string, result: T, calls: string[]) {
  calls.push(kind);
  return { ok: true as const, kind, result };
}

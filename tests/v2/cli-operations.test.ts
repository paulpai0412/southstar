import test from "node:test";
import assert from "node:assert/strict";
import { executeV2Command, parseV2Command } from "../../src/v2/cli.ts";
import { formatRunStatusSummary } from "../../src/v2/cli-format.ts";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("parses phase 1.5 CLI commands", () => {
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
});

test("server-backed phase 1.5 CLI commands fail closed until operation routes are complete", async () => {
  const db = openSouthstarDb(":memory:");

  const commands = [
    ["serve"],
    ["run-goal", "--goal", "Add calc sum"],
    ["wait", "--run-id", "run-1"],
    ["tasks", "--run-id", "run-1"],
    ["task", "--run-id", "run-1", "--task-id", "task-1"],
    ["artifacts", "--run-id", "run-1"],
    ["sessions", "--run-id", "run-1"],
    ["memory", "--run-id", "run-1"],
    ["logs", "--run-id", "run-1"],
    ["voice-command", "--run-id", "run-1", "--transcript", "approve"],
  ];

  for (const argv of commands) {
    const parsed = parseV2Command(argv);
    const expected = parsed.command === "serve"
      ? /serve is implemented by src\/v2\/server entrypoint task/
      : new RegExp(`${parsed.command} requires Southstar runtime server route implementation`);
    await assert.rejects(() => executeV2Command(parsed, { db }), expected);
  }
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

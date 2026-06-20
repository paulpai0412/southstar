import test from "node:test";
import assert from "node:assert/strict";
import { executeV2Command, parseV2Command } from "../../src/v2/cli.ts";

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
  assert.throws(() => parseV2Command(["status"]), /--run-id is required/);
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

function envelope<T>(kind: string, result: T, calls: string[]) {
  calls.push(kind);
  return { ok: true as const, kind, result };
}

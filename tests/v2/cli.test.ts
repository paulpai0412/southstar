import test from "node:test";
import assert from "node:assert/strict";
import { executeV2Command, parseV2Command } from "../../src/v2/cli.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import type { TorkClient } from "../../src/v2/executor/tork-client.ts";

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

test("executes v2 CLI commands through the local runtime API", async () => {
  const db = openSouthstarDb(":memory:");
  const plannerClient = plannerClientFor("implement calc sum");
  const torkClient = { submit: async () => ({ jobId: "job-1", status: "queued" }) } as TorkClient;

  const draft = await executeV2Command(parseV2Command(["plan", "--goal", "implement calc sum"]), {
    db,
    plannerClient,
    torkClient,
  });
  assert.equal(draft.kind, "planner-draft");
  assert.equal(draft.result.draftId, "draft-wf-software-mvp");

  const run = await executeV2Command(parseV2Command(["run", "--draft-id", draft.result.draftId]), {
    db,
    plannerClient,
    torkClient,
  });
  assert.equal(run.kind, "run");
  assert.equal(run.result.runId, "run-wf-software-mvp");

  const status = await executeV2Command(parseV2Command(["status", "--run-id", run.result.runId]), {
    db,
    plannerClient,
    torkClient,
  });
  assert.equal(status.kind, "status");
  assert.deepEqual(status.result.canvas.nodes.map((node) => node.id), ["task-implement"]);
});

test("revises planner draft through CLI command", async () => {
  const db = openSouthstarDb(":memory:");
  const plannerClient = plannerClientFor("implement calc sum");
  const torkClient = { submit: async () => ({ jobId: "job-1", status: "queued" }) } as TorkClient;
  const draft = await executeV2Command(parseV2Command(["plan", "--goal", "implement calc sum"]), {
    db,
    plannerClient,
    torkClient,
  });

  const revised = await executeV2Command(parseV2Command([
    "revise",
    "--draft-id",
    draft.result.draftId,
    "--prompt",
    "add summary task",
  ]), {
    db,
    plannerClient: plannerClientFor("implement calc sum with revision"),
    torkClient,
  });

  assert.equal(revised.kind, "planner-draft");
  assert.match(revised.result.draftId, /^draft-wf-software-mvp-rev-/);
});

function plannerClientFor(goal: string): PiPlannerClient {
  return {
    generate: async () => JSON.stringify({
      workflow: {
        schemaVersion: "southstar.v2",
        workflowId: "wf-software-mvp",
        title: "Software MVP",
        goalPrompt: goal,
        tasks: [{
          id: "task-implement",
          name: "Implement CLI",
          domain: "software",
          dependsOn: [],
          execution: {
            engine: "tork",
            image: "southstar/codex-agent:local",
            command: ["southstar-agent-runner"],
            env: {},
            mounts: [],
            timeoutSeconds: 900,
            infraRetry: { maxAttempts: 1 },
          },
          rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
          subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
        }],
        harnessDefinitions: [{
          id: "codex",
          kind: "codex",
          entrypoint: "southstar-agent-runner",
          image: "southstar/codex-agent:local",
          capabilities: ["software"],
          inputProtocol: "task-envelope-v1",
          eventProtocol: "southstar-events-v1",
          supportsCheckpoint: true,
          supportsSteering: true,
          supportsProgress: true,
        }],
        evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
        memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
        vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
        mcpServers: [],
        mcpGrants: [],
        progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
        steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
        learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
      },
      plannerTrace: { model: "pi-agent", promptHash: "hash", generatedAt: "2026-06-11T00:00:00.000Z" },
    }),
  };
}

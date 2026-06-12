import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { runRootSessionTask } from "../../src/v2/agent-runner/root-session.ts";
import type { AgentHarness } from "../../src/v2/harness/types.ts";
import type { TaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";

class RepairingHarness implements AgentHarness {
  readonly id = "codex";
  private attempts = 0;

  async run(input: { repairInstruction?: string }) {
    this.attempts += 1;
    if (this.attempts === 1) {
      return {
        artifact: { summary: "changed CLI" },
        progress: ["initial implementation"],
      };
    }
    assert.match(input.repairInstruction ?? "", /commandsRun, risks/);
    return {
      artifact: { summary: "changed CLI", commandsRun: ["npm test"], risks: [] },
      progress: ["repaired artifact"],
    };
  }
}

class AlwaysInvalidHarness implements AgentHarness {
  readonly id = "codex";

  async run() {
    return {
      artifact: { summary: "still incomplete" },
      progress: ["attempted implementation"],
    };
  }
}

test("root session retries invalid artifact and checkpoints repaired result", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-root",
  });
  const harness = new RepairingHarness();

  const result = await runRootSessionTask(db, {
    envelope: envelope(),
    harness,
    requiredFields: ["summary", "commandsRun", "risks"],
  });

  assert.deepEqual(result, {
    ok: true,
    attempts: 2,
    artifactResourceId: "artifact-run-1-task-1-attempt-2",
    checkpointResourceId: "checkpoint-run-1-task-1",
  });
  assert.deepEqual(listHistoryForRun(db, "run-1").map((event) => event.eventType), [
    "session.entry",
    "task.started",
    "progress.commentary",
    "artifact.created",
    "evaluator.completed",
    "repair.requested",
    "progress.commentary",
    "artifact.created",
    "evaluator.completed",
    "subagent.completed",
    "checkpoint.created",
  ]);
  assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
  assert.equal(listResources(db, { resourceType: "session_checkpoint", status: "created" }).length, 1);
});

test("root session fails when repair attempts are exhausted", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  createWorkflowTask(db, {
    id: "task-1",
    runId: "run-1",
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-root",
  });

  const result = await runRootSessionTask(db, {
    envelope: { ...envelope(), rootSession: { ...envelope().rootSession, maxRepairAttempts: 1 } },
    harness: new AlwaysInvalidHarness(),
    requiredFields: ["summary", "commandsRun"],
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(listHistoryForRun(db, "run-1").some((event) => event.eventType === "checkpoint.created"), false);
});

function envelope(): TaskEnvelope {
  return {
    schemaVersion: "southstar.task-envelope.v1",
    runId: "run-1",
    workflowId: "workflow-1",
    task: {
      id: "task-1",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "image",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 60,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    },
    rootSession: { id: "session-root", validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    memory: { items: [], capturedAt: "now" },
    skills: [],
    vaultLeases: [],
    mcpGrants: [],
    artifactContracts: ["implementation-report"],
    artifactContract: { artifactTypes: ["implementation-report"], requiredFields: ["summary", "commandsRun"] },
  };
}

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}

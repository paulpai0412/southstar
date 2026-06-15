import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun, getWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { ingestTaskRunResult } from "../../src/v2/executor/tork-callback.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";

test("Tork callback ingests container task result into durable SQLite state", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-1",
    taskId: "task-1",
    requiredArtifactRef: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });

  ingestTaskRunResult(db, {
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "session-root",
    ok: true,
    attempts: 1,
    artifact: {
      summary: "done",
      filesChanged: ["src/index.ts"],
      commandsRun: ["npm test"],
      testResults: [{ command: "npm test", status: "passed", output: "ok" }],
      risks: [],
      artifactEvidence: { testResults: [{ command: "npm test", status: "passed", output: "ok" }] },
    },
    metrics: { tokens: 42, costMicrosUsd: 420, toolCalls: 3, retryCount: 0, durationMs: 1000 },
    events: [
      { eventType: "session.entry", actorType: "root-session", payload: { rootSessionId: "session-root" } },
      { eventType: "subagent.completed", actorType: "subagent", payload: { subagentId: "impl" } },
      { eventType: "evaluator.completed", actorType: "evaluator", payload: { ok: true, missingFields: [] } },
    ],
  });

  assert.deepEqual(listHistoryForRun(db, "run-1").map((event) => event.eventType), [
    "session.entry",
    "subagent.completed",
    "evaluator.completed",
    "artifact.created",
    "checkpoint.created",
    "run.completed",
  ]);
  assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
  const checkpoints = listResources(db, { resourceType: "session_checkpoint", status: "created" });
  assert.equal(checkpoints.length, 1);
  assert.deepEqual((checkpoints[0]?.payload as { artifactRefs?: string[] }).artifactRefs, ["artifact-run-1-task-1-callback"]);
  assert.equal(JSON.parse(getWorkflowRun(db, "run-1")?.metricsJson ?? "{}").aggregate.tokens, 42);
  const task = db.prepare("select status, metrics_json from workflow_tasks where id = ?").get("task-1") as {
    status: string;
    metrics_json: string;
  };
  assert.equal(task.status, "completed");
  assert.equal(JSON.parse(task.metrics_json).aggregate.costMicrosUsd, 420);
  assert.equal(getWorkflowRun(db, "run-1")?.status, "passed");
});

test("Tork callback cleans ephemeral task materialization after ingest", () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = mkdtempSync(join(tmpdir(), "southstar-callback-cleanup-"));
  const taskDir = join(runRoot, "run-1", "task-1");
  mkdirSync(taskDir, { recursive: true });
  seedRunWithWorkflow(db, {
    runId: "run-1",
    taskId: "task-1",
    requiredArtifactRef: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });

  ingestTaskRunResult(db, {
    runId: "run-1",
    taskId: "task-1",
    rootSessionId: "session-root",
    ok: true,
    attempts: 1,
    artifact: {
      summary: "done",
      filesChanged: ["src/index.ts"],
      commandsRun: ["npm test"],
      testResults: [{ command: "npm test", status: "passed", output: "ok" }],
      risks: [],
      artifactEvidence: { testResults: [{ command: "npm test", status: "passed", output: "ok" }] },
    },
    metrics: { tokens: 42, costMicrosUsd: 420, toolCalls: 3, retryCount: 0, durationMs: 1000 },
    events: [],
    materializationRoot: runRoot,
  });

  assert.equal(existsSync(taskDir), false);
});

test("callback ingestion does not accept artifact when evidence validators fail", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-evidence-callback",
    taskId: "implement-feature",
    requiredArtifactRef: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });

  ingestTaskRunResult(db, {
    runId: "run-evidence-callback",
    taskId: "implement-feature",
    rootSessionId: "root-run-evidence-callback-implement-feature",
    ok: true,
    attempts: 1,
    artifact: {
      summary: "missing test evidence",
      commandsRun: [],
      testResults: [],
      filesChanged: [],
      risks: [],
      artifactEvidence: {},
    },
    metrics: { tokens: 128, costMicrosUsd: 0 },
    events: [],
  });

  const artifact = listResources(db, { resourceType: "artifact" })[0];
  assert.equal(artifact?.status, "needs_repair");
  assert.equal(listResources(db, { resourceType: "evidence_packet", status: "incomplete" }).length, 1);
  assert.equal(listResources(db, { resourceType: "validator_result", status: "failed" }).length >= 1, true);
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get("run-evidence-callback", "implement-feature") as { status: string };
  assert.equal(task.status, "failed");
});

function seedRunWithWorkflow(
  db: ReturnType<typeof openSouthstarDb>,
  input: { runId: string; taskId: string; requiredArtifactRef: string; evaluatorPipelineRef: string },
): void {
  const artifactContract = softwareDomainPack.artifactContracts
    .find((candidate) => candidate.id === input.requiredArtifactRef);
  if (!artifactContract) throw new Error(`unknown artifact contract ${input.requiredArtifactRef}`);

  createWorkflowRun(db, {
    id: input.runId,
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "workflow-1",
      title: "Callback test workflow",
      goalPrompt: "implement calc sum",
      domain: "software",
      tasks: [
        {
          id: input.taskId,
          name: input.taskId,
          domain: "software",
          dependsOn: [],
          requiredArtifactRefs: [input.requiredArtifactRef],
          evaluatorPipelineRef: input.evaluatorPipelineRef,
          execution: {
            engine: "tork",
            image: "southstar/pi-agent:local",
            command: ["southstar-agent-runner"],
            env: {},
            mounts: [],
            timeoutSeconds: 60,
            infraRetry: { maxAttempts: 1 },
          },
          rootSession: {
            validator: "schema-evaluator-v1",
            maxRepairAttempts: 2,
          },
          subagents: [
            {
              id: "impl",
              harnessId: "pi",
              prompt: "implement",
              requiredArtifacts: [input.requiredArtifactRef],
            },
          ],
        },
      ],
      harnessDefinitions: [
        {
          id: "pi",
          kind: "pi-agent",
          entrypoint: "southstar-agent-runner",
          image: "southstar/pi-agent:local",
          capabilities: [],
          inputProtocol: "task-envelope-v2",
          eventProtocol: "southstar-events-v1",
          supportsCheckpoint: true,
          supportsSteering: true,
          supportsProgress: true,
        },
      ],
      evaluators: [],
      artifactContracts: [artifactContract],
      evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
      memoryPolicy: {
        retrievalLimit: 5,
        writeRequiresApproval: false,
      },
      vaultPolicy: {
        leaseTtlSeconds: 3600,
        mountMode: "ephemeral-file",
      },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: {
        firstEventWithinSeconds: 60,
        minEventsPerLongTask: 1,
      },
      steeringPolicy: {
        enabled: true,
        acceptedSignals: ["pause", "resume", "revise-prompt", "repair"],
      },
      learningPolicy: {
        recordMemoryDeltas: true,
        recordWorkflowLearnings: true,
      },
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  createWorkflowTask(db, {
    id: input.taskId,
    runId: input.runId,
    taskKey: `task-${input.taskId}`,
    status: "running",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: "session-root",
  });
}

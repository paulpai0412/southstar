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
    artifactContractId: "implementation_report",
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
    "executor.callback_received",
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

test("Tork callback resolves artifact contract when task uses artifact-type ref", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-alias",
    taskId: "task-alias",
    requiredArtifactRef: "implementation-report",
    artifactContractId: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });

  ingestTaskRunResult(db, {
    runId: "run-alias",
    taskId: "task-alias",
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
  });

  assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get("run-alias", "task-alias") as { status: string };
  assert.equal(task.status, "completed");
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
    artifactContractId: "implementation_report",
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

test("callback ingestion is idempotent for duplicate callback payloads", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-dup",
    taskId: "task-dup",
    requiredArtifactRef: "implementation_report",
    artifactContractId: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });

  const callback = {
    runId: "run-dup",
    taskId: "task-dup",
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
  };

  ingestTaskRunResult(db, callback);
  ingestTaskRunResult(db, callback);

  const artifacts = listResources(db, { resourceType: "artifact" })
    .filter((resource) => resource.runId === "run-dup" && resource.taskId === "task-dup");
  assert.equal(artifacts.length, 1);
  assert.equal(listHistoryForRun(db, "run-dup").filter((event) => event.eventType === "executor.callback_received").length, 1);
});

test("terminal task status remains monotonic when late callback arrives", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-terminal",
    taskId: "task-terminal",
    requiredArtifactRef: "implementation_report",
    artifactContractId: "implementation_report",
    evaluatorPipelineRef: "software-feature-quality",
  });
  db.prepare("update workflow_tasks set status = 'failed' where run_id = ? and id = ?")
    .run("run-terminal", "task-terminal");

  ingestTaskRunResult(db, {
    runId: "run-terminal",
    taskId: "task-terminal",
    rootSessionId: "session-root",
    ok: true,
    attempts: 1,
    artifact: {
      summary: "late callback",
      filesChanged: ["src/index.ts"],
      commandsRun: ["npm test"],
      testResults: [{ command: "npm test", status: "passed", output: "ok" }],
      risks: [],
      artifactEvidence: { testResults: [{ command: "npm test", status: "passed", output: "ok" }] },
    },
    metrics: {},
    events: [],
  });

  const task = db.prepare("select status from workflow_tasks where run_id = ? and id = ?")
    .get("run-terminal", "task-terminal") as { status: string };
  assert.equal(task.status, "failed");
  assert.equal(listHistoryForRun(db, "run-terminal").some((event) => event.eventType === "executor.callback_ignored_terminal"), true);
});

test("callback ingestion records durable recovery resources when evaluator pipeline selects strategy", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-recovery-callback",
    taskId: "checker",
    requiredArtifactRef: "verification_report",
    artifactContractId: "verification_report",
    evaluatorPipelineRef: "software-verification-quality",
  });

  ingestTaskRunResult(db, {
    runId: "run-recovery-callback",
    taskId: "checker",
    rootSessionId: "root-run-recovery-callback-checker",
    ok: true,
    attempts: 1,
    artifact: {
      summary: "checker rejected approach",
      commandsRun: [
        { command: "npm test", result: "pass" },
        { command: "custom due-date probe", result: "failed" },
      ],
      testResults: [
        { checkId: "repositoryTests", command: "npm test", status: "passed", gating: "blocking", details: "npm test passed" },
        {
          checkId: "dueDatePersistenceProbe",
          command: "custom due-date probe",
          status: "failed",
          gating: "blocking",
          details: "due date persistence missing",
        },
      ],
      checkerFindings: [{ severity: "blocking", message: "due date persistence missing" }],
      risks: [],
    },
    metrics: { tokens: 64, costMicrosUsd: 0 },
    events: [],
  });

  const checkpoints = listResources(db, { resourceType: "session_checkpoint" })
    .filter((resource) => resource.runId === "run-recovery-callback")
    .map((resource) => resource.payload as { kind?: string });
  assert.equal(checkpoints.some((checkpoint) => checkpoint.kind === "before-recovery"), true);

  const decisions = listResources(db, { resourceType: "recovery_decision" })
    .filter((resource) => resource.runId === "run-recovery-callback");
  assert.equal(decisions.some((resource) => {
    const payload = resource.payload as { selectedStrategy?: string; strategy?: string };
    return payload.selectedStrategy === "fork-from-checkpoint" || payload.strategy === "fork-from-checkpoint";
  }), true);

  const operations = listResources(db, { resourceType: "session_operation" })
    .filter((resource) => resource.runId === "run-recovery-callback");
  assert.equal(operations.some((resource) => (resource.payload as { type?: string }).type === "fork"), true);
});

test("callback ingestion does not accept artifact when evidence validators fail", () => {
  const db = openSouthstarDb(":memory:");
  seedRunWithWorkflow(db, {
    runId: "run-evidence-callback",
    taskId: "implement-feature",
    requiredArtifactRef: "implementation_report",
    artifactContractId: "implementation_report",
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
  input: {
    runId: string;
    taskId: string;
    requiredArtifactRef: string;
    artifactContractId: string;
    evaluatorPipelineRef: string;
  },
): void {
  const artifactContract = softwareDomainPack.artifactContracts
    .find((candidate) => candidate.id === input.artifactContractId);
  if (!artifactContract) throw new Error(`unknown artifact contract ${input.artifactContractId}`);

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
          roleRef: input.taskId === "checker" ? "checker" : "maker",
          agentProfileRef: input.taskId === "checker" ? "software-checker-pi" : "software-maker-pi",
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
      roles: softwareDomainPack.roles,
      agentProfiles: softwareDomainPack.agentProfiles,
      artifactContracts: [artifactContract],
      evaluatorPipelines: softwareDomainPack.evaluatorPipelines,
      contextPolicies: softwareDomainPack.contextPolicies,
      sessionPolicies: softwareDomainPack.sessionPolicies,
      memoryPolicies: softwareDomainPack.memoryPolicies,
      workspacePolicies: softwareDomainPack.workspacePolicies,
      stopConditions: softwareDomainPack.stopConditions,
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

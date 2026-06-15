import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createPlannerDraft, createRunFromDraft, expandWorkflowRun } from "../../src/v2/ui-api/local-api.ts";
import type { WorkflowRevisionRequest } from "../../src/v2/manifests/types.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import type { TorkClient } from "../../src/v2/executor/tork-client.ts";

test("expands a running workflow through workflow_revision and submits added tasks to Tork", async () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-expansion-"));
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  const submittedJobs: unknown[] = [];
  const torkClient = {
    submit: async (projection) => {
      submittedJobs.push(projection.job);
      return { jobId: `job-${submittedJobs.length}`, status: "queued" };
    },
  } as TorkClient;
  const run = await createRunFromDraft(db, { draftId: draft.draftId, torkClient });

  const result = await expandWorkflowRun(db, {
    runId: run.runId,
    request: revisionRequest(run.runId),
    runRoot,
    callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
    torkClient,
  });

  assert.deepEqual(result.newTaskIds, ["task-follow-up-verification"]);
  assert.equal(listResources(db, { resourceType: "workflow_revision", status: "applied" }).length, 1);
  const queuedBindings = listResources(db, { resourceType: "executor_binding", status: "queued" })
    .filter((resource) => resource.runId === run.runId);
  const totalTasks = (db.prepare("select count(*) as count from workflow_tasks where run_id = ?").get(run.runId) as { count: number }).count;
  assert.equal(queuedBindings.length, totalTasks);
  assert.equal(submittedJobs.length, 2);
  const followUpJob = submittedJobs[1] as { tasks: Array<{ command: string[]; mounts: Array<{ source: string; target: string; readonly: boolean }> }> };
  assert.deepEqual(followUpJob.tasks[0].command, [
    "southstar-agent-runner",
    "--envelope",
    `/southstar-runs/${run.runId}/task-follow-up-verification/envelope.json`,
  ]);
  assert.deepEqual(followUpJob.tasks[0].mounts.at(-1), {
    source: runRoot,
    target: "/southstar-runs",
    readonly: true,
  });
  const envelope = JSON.parse(await readFile(join(runRoot, run.runId, "task-follow-up-verification", "envelope.json"), "utf8"));
  assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(envelope.taskId, "task-follow-up-verification");
  assert.equal(
    listHistoryForRun(db, run.runId).some((event) => event.eventType === "workflow.revision_requested"),
    true,
  );
  assert.equal(
    listHistoryForRun(db, run.runId).some((event) => event.eventType === "workflow.revision_validated"),
    true,
  );
  assert.equal(
    listHistoryForRun(db, run.runId).some((event) => event.eventType === "workflow.expanded"),
    true,
  );
  assert.equal(
    listHistoryForRun(db, run.runId).some((event) => event.eventType === "task.created"),
    true,
  );
});

function revisionRequest(runId: string): WorkflowRevisionRequest {
  return {
    revisionId: "rev-follow-up",
    baseRevisionId: "base",
    runId,
    actorType: "root-session",
    reason: "review requires follow-up verification task",
    addTasks: [{
      id: "task-follow-up-verification",
      name: "Follow-up verification",
      domain: "software",
      dependsOn: ["implement-feature"],
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
      subagents: [{ id: "verify", harnessId: "codex", prompt: "verify", requiredArtifacts: ["implementation-report"] }],
    }],
    removeTaskIds: [],
    dependencyChanges: [],
    idempotencyKey: "rev-follow-up",
  };
}

function plannerClient(): PiPlannerClient {
  return {
    generate: async () => JSON.stringify({
      workflow: {
        schemaVersion: "southstar.v2",
        workflowId: "wf-software-mvp",
        title: "Software MVP",
        goalPrompt: "implement calc sum",
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

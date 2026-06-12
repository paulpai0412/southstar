import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources, approveMemoryDelta, proposeMemoryDelta } from "../../src/v2/stores/resource-store.ts";
import {
  createPlannerDraft,
  createRunFromDraft,
  getRunStatus,
  steerRun,
  getTaskEnvelope,
} from "../../src/v2/ui-api/local-api.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import type { TorkClient } from "../../src/v2/executor/tork-client.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

test("creates planner draft resource from validated Pi planner output", async () => {
  const db = openSouthstarDb(":memory:");

  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });

  assert.equal(draft.goalPrompt, "implement calc sum");
  assert.equal(listResources(db, { resourceType: "planner_draft", status: "validated" }).length, 1);
});

test("creates run from draft, submits Tork projection, and exposes status", async () => {
  const db = openSouthstarDb(":memory:");
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-local-api-"));
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  const submittedJobs: unknown[] = [];

  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    runRoot,
    callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
    torkClient: {
      submit: async (projection) => {
        submittedJobs.push(projection.job);
        return { jobId: "job-1", status: "queued" };
      },
    } as TorkClient,
  });

  assert.equal(run.runId, "run-wf-software-mvp");
  assert.equal(submittedJobs.length, 1);
  const submitted = submittedJobs[0] as { tasks: Array<{ command: string[]; mounts: Array<{ source: string; target: string; readonly: boolean }> }> };
  assert.deepEqual(submitted.tasks[0].command, [
    "southstar-agent-runner",
    "--envelope",
    "/southstar-runs/run-wf-software-mvp/task-implement/envelope.json",
  ]);
  assert.deepEqual(submitted.tasks[0].mounts.at(-1), {
    source: runRoot,
    target: "/southstar-runs",
    readonly: true,
  });
  assert.equal(JSON.parse(await readFile(join(runRoot, run.runId, "task-implement", "envelope.json"), "utf8")).task.id, "task-implement");
  assert.equal(listResources(db, { resourceType: "executor_binding", status: "queued" }).length, 1);
  assert.deepEqual(getRunStatus(db, run.runId).canvas.nodes.map((node) => node.id), ["task-implement"]);
  assert.deepEqual(getRunStatus(db, run.runId).runtime.executorJobIds, ["job-1"]);
});

test("creates a distinct run id when the same planner draft is executed again", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  let jobs = 0;
  const torkClient = {
    submit: async () => ({ jobId: `job-${++jobs}`, status: "queued" }),
  } as TorkClient;

  const first = await createRunFromDraft(db, { draftId: draft.draftId, torkClient });
  const second = await createRunFromDraft(db, { draftId: draft.draftId, torkClient });

  assert.equal(first.runId, "run-wf-software-mvp");
  assert.notEqual(second.runId, first.runId);
  assert.match(second.runId, /^run-wf-software-mvp-/);
  assert.deepEqual(getRunStatus(db, second.runId).runtime.executorJobIds, ["job-2"]);
});

test("durably creates run and tasks before submitting through executor provider", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    submit: async ({ runId }) => {
      const runRow = db.prepare("select id from workflow_runs where id = ?").get(runId);
      const taskRow = db.prepare("select id from workflow_tasks where run_id = ? and id = ?")
        .get(runId, "task-implement");

      assert.equal((runRow as { id?: string } | undefined)?.id, runId);
      assert.equal((taskRow as { id?: string } | undefined)?.id, "task-implement");

      return {
        executorType: "tork",
        externalJobId: "job-provider-1",
        status: "queued",
        executionProjection: { executor: "tork" },
      };
    },
  };

  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    executorProvider,
  });

  assert.equal(run.runId, "run-wf-software-mvp");
  assert.equal(run.tork.jobId, "job-provider-1");
  assert.equal(listResources(db, { resourceType: "executor_binding", status: "queued" }).length, 1);
  assert.deepEqual(getRunStatus(db, run.runId).runtime.executorJobIds, ["job-provider-1"]);
});

test("steers run and builds task envelope with approved memory", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    torkClient: { submit: async () => ({ jobId: "job-1", status: "queued" }) } as TorkClient,
  });
  const delta = proposeMemoryDelta(db, run.runId, { preference: "minimal" });
  approveMemoryDelta(db, delta.id);

  steerRun(db, { runId: run.runId, message: "keep minimal" });
  const envelope = getTaskEnvelope(db, { runId: run.runId, taskId: "task-implement" });

  assert.equal(listHistoryForRun(db, run.runId).some((event) => event.eventType === "steering.received"), true);
  assert.equal(envelope.task.id, "task-implement");
  assert.deepEqual(envelope.memory.items[0].body, { preference: "minimal" });
});

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

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources, upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
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
  const fixtureRepo = await createGitFixtureRepo();
  const draft = await createPlannerDraft(db, {
    goalPrompt: `implement calc sum\nFixture repo: ${fixtureRepo}`,
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

  assert.match(run.runId, /^run-wf-gen-/);
  assert.equal(submittedJobs.length, 1);
  const submitted = submittedJobs[0] as { tasks: Array<{ command: string[]; mounts: Array<{ source: string; target: string; readonly: boolean }> }> };
  assert.deepEqual(submitted.tasks[0].command, [
    "southstar-agent-runner",
    "--envelope",
    `/southstar-runs/${run.runId}/understand-repo/envelope.json`,
  ]);
  assert.deepEqual(submitted.tasks[0].mounts.at(-1), {
    source: runRoot,
    target: "/southstar-runs",
    readonly: true,
  });
  const envelope = JSON.parse(await readFile(join(runRoot, run.runId, "understand-repo", "envelope.json"), "utf8"));
  assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(envelope.taskId, "understand-repo");
  assert.equal(envelope.skills[0]?.skillId, "software.calc-cli");
  assert.equal(listResources(db, { resourceType: "skill_snapshot", status: "resolved" }).length >= 3, true);
  assert.equal(countRunResources(db, run.runId, "workflow_generation_plan"), 1);
  assert.equal(countRunResources(db, run.runId, "orchestration_snapshot"), 1);
  assert.equal(countRunResources(db, run.runId, "workspace_snapshot") >= 1, true);
  assert.equal(listResources(db, { resourceType: "session_node", status: "active" }).length, 4);
  assert.equal(listResources(db, { resourceType: "session_checkpoint", status: "created" }).length, 4);
  assert.equal(listResources(db, { resourceType: "executor_binding", status: "queued" }).length, 1);
  assert.deepEqual(getRunStatus(db, run.runId).canvas.nodes.map((node) => node.id), [
    "understand-repo",
    "implement-feature",
    "verify-feature",
    "summarize-completion",
  ]);
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

  assert.match(first.runId, /^run-wf-gen-/);
  assert.notEqual(second.runId, first.runId);
  assert.match(second.runId, /^run-wf-gen-/);
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
        .get(runId, "implement-feature");

      assert.equal((runRow as { id?: string } | undefined)?.id, runId);
      assert.equal((taskRow as { id?: string } | undefined)?.id, "implement-feature");

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

  assert.match(run.runId, /^run-wf-gen-/);
  assert.equal(run.tork.jobId, "job-provider-1");
  assert.equal(listResources(db, { resourceType: "executor_binding", status: "queued" }).length, 1);
  assert.deepEqual(getRunStatus(db, run.runId).runtime.executorJobIds, ["job-provider-1"]);
});

test("steers run and builds task envelope with approved memory", async () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-local-api-minimal",
    scope: "software",
    status: "approved",
    title: "Minimal preference",
    payload: {
      kind: "preference",
      text: "minimal",
      confidence: 0.9,
      successScore: 0.9,
      tags: ["software"],
    },
  });
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    torkClient: { submit: async () => ({ jobId: "job-1", status: "queued" }) } as TorkClient,
  });

  steerRun(db, { runId: run.runId, message: "keep minimal" });
  const envelope = getTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });

  assert.equal(listHistoryForRun(db, run.runId).some((event) => event.eventType === "steering.received"), true);
  assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(envelope.taskId, "implement-feature");
  assert.equal(envelope.agentProfile.id, "software-maker-pi");
  assert.equal(envelope.skills[0]?.skillId, "software.calc-cli");
  assert.equal(envelope.contextPacket.selectedMemories[0]?.sourceRef, "mem-local-api-minimal");
  assert.match(envelope.agentPrompt, /minimal/);
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
          skillRefs: ["software.calc-cli"],
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

function countRunResources(db: ReturnType<typeof openSouthstarDb>, runId: string, resourceType: string): number {
  const row = db.prepare("select count(*) as count from runtime_resources where run_id = ? and resource_type = ?")
    .get(runId, resourceType) as { count: number };
  return row.count;
}

async function createGitFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "southstar-local-api-fixture-"));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "calc.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "southstar@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Southstar Test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
  return repo;
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  createPiSdkPlannerClient,
  generatePlanBundle,
  generatePlanBundleWithTimings,
  runPlannerRevisionLoop,
} from "../../src/v2/planner/pi-planner.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";

test("parses planner JSON output into a validated PlanBundle", async () => {
  const client: PiPlannerClient = {
    generate: async () => JSON.stringify(validBundle()),
  };

  const bundle = await generatePlanBundle(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  });

  assert.equal(bundle.workflow.workflowId, "wf-software-mvp");
  assert.equal(bundle.workflow.tasks.length, 1);
});

test("revision loop returns validation issues to planner and accepts repaired JSON", async () => {
  const prompts: string[] = [];
  const client: PiPlannerClient = {
    generate: async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        const invalid = validBundle();
        invalid.workflow.tasks[0].subagents[0].harnessId = "missing";
        return JSON.stringify(invalid);
      }
      return JSON.stringify(validBundle());
    },
  };

  const result = await runPlannerRevisionLoop(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  }, 2);

  assert.equal(result.workflow.tasks[0].subagents[0].harnessId, "codex");
  assert.match(prompts[1], /unknown harness id/);
});

test("planner rejects non-JSON output", async () => {
  const client: PiPlannerClient = {
    generate: async () => "not json",
  };

  await assert.rejects(() => generatePlanBundle(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  }), /valid JSON object/);
});

test("planner retries abbreviated JSON and records cumulative timings", async () => {
  const prompts: string[] = [];
  const client: PiPlannerClient = {
    generate: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? '{"workflow":{"tasks":[...]}}' : JSON.stringify(validBundle());
    },
  };

  const result = await generatePlanBundleWithTimings(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  });

  assert.equal(result.bundle.workflow.workflowId, "wf-software-mvp");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Do not use ellipses/);
  assert.equal(Number.isFinite(result.plannerMs), true);
  assert.equal(Number.isFinite(result.validationMs), true);
});

test("planner rejects compact Pi workflow output instead of canonicalizing old schema", async () => {
  const client: PiPlannerClient = {
    generate: async () => JSON.stringify({
      schemaVersion: "southstar.v2",
      workflows: [{
        kind: "SouthstarWorkflowManifest",
        id: "compact-old-schema",
        tasks: [],
      }],
    }),
  };

  await assert.rejects(() => generatePlanBundle(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  }), /workflow and plannerTrace/);
});

test("planner canonicalizes Pi canonical-like workflow output with schema drift", async () => {
  const malformed = validBundle();
  Object.assign(malformed.workflow.tasks[0], { domain: "planning" });
  malformed.workflow.tasks[0].skillRefs = ["software.readme"];
  malformed.workflow.tasks[0].execution.image = "docker.io/library/node:22-bookworm";
  malformed.workflow.tasks[0].execution.command = ["southstar-agent-runner", "run", "--task", "task-implement"];
  (malformed.workflow.tasks[0].execution.mounts as unknown[]) = [{
    source: "/tmp/repo",
    target: "/workspace",
    readOnly: false,
  }];
  (malformed.workflow as unknown as { harnessDefinitions: unknown }).harnessDefinitions = {};
  const client: PiPlannerClient = {
    generate: async () => JSON.stringify(malformed),
  };

  const bundle = await generatePlanBundle(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  });

  assert.equal(bundle.workflow.tasks[0].domain, "general");
  assert.equal(bundle.workflow.tasks[0].execution.image, "southstar/pi-agent:local");
  assert.deepEqual(bundle.workflow.tasks[0].execution.command, ["southstar-agent-runner", "run", "--task", "task-implement"]);
  assert.deepEqual(bundle.workflow.tasks[0].execution.mounts, [{
    source: "/tmp/repo",
    target: "/workspace",
    readonly: false,
  }]);
  assert.deepEqual(bundle.workflow.tasks[0].skillRefs, ["software.readme"]);
  assert.equal(Array.isArray(bundle.workflow.harnessDefinitions), true);
});

test("planner rejects malformed workflow tasks without throwing TypeError", async () => {
  const malformed = validBundle();
  (malformed.workflow as unknown as { tasks: unknown }).tasks = {};
  const client: PiPlannerClient = {
    generate: async () => JSON.stringify(malformed),
  };

  await assert.rejects(() => generatePlanBundle(client, {
    goalPrompt: "implement calc sum",
    schemaVersion: "southstar.v2",
    availableHarnesses: ["codex"],
  }), /Pi planner returned invalid PlanBundle/);
});

test("Pi SDK planner client sends prompt through AgentSession and returns assistant text", async () => {
  const prompts: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const client = createPiSdkPlannerClient({
    createSession: async () => ({
      on: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      prompt: async (prompt: string) => {
        prompts.push(prompt);
        listeners.forEach((listener) => listener({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify(validBundle()) }],
          }],
        }));
      },
    }),
  });

  const raw = await client.generate("plan this");

  assert.deepEqual(prompts, ["plan this"]);
  assert.equal(JSON.parse(raw).workflow.workflowId, "wf-software-mvp");
});

function validBundle() {
  return {
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
  };
}

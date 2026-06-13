import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { buildOperationsDashboardModel } from "../../src/v2/ui-api/operations-dashboard.ts";
import { createPlannerDraft, createRunFromDraft } from "../../src/v2/ui-api/local-api.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import type { TorkClient } from "../../src/v2/executor/tork-client.ts";

test("builds the pi-web operations dashboard first-screen contract", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "implement calc sum",
    plannerClient: plannerClient(),
  });
  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    torkClient: { submit: async () => ({ jobId: "job-1", status: "queued" }) } as TorkClient,
  });

  const dashboard = buildOperationsDashboardModel(db, { runId: run.runId });

  assert.equal(dashboard.surface, "pi-web.operations-dashboard.v1");
  assert.deepEqual(dashboard.panels.map((panel) => panel.id), [
    "planner-chat",
    "workflow-canvas",
    "runtime-monitor",
    "task-detail",
    "agent-definitions",
    "sessions-memory",
    "vault-mcp",
    "executor-ops",
  ]);
  assert.match(dashboard.plannerChat.drafts[0].id, /^draft-wf-gen-/);
  assert.deepEqual(dashboard.workflowCanvas.nodes.map((node) => node.id), [
    "understand-repo",
    "implement-feature",
    "verify-feature",
    "summarize-completion",
  ]);
  assert.equal(dashboard.agentDefinitions.harnesses.some((harness) => harness.id === "codex"), true);
  assert.equal(dashboard.executorOps.bindings[0].torkJobId, "job-1");
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

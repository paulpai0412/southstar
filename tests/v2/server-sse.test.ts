import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { readRunEventsSince, toSseFrame } from "../../src/v2/server/sse.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("SSE helpers read run events since cursor and serialize event frames", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-sse-")), "db.sqlite3"));
  createWorkflowRun(db, minimalRun("run-sse"));
  appendHistoryEvent(db, { runId: "run-sse", eventType: "progress.commentary", actorType: "agent", payload: { text: "first" } });
  appendHistoryEvent(db, { runId: "run-sse", eventType: "evaluator.completed", actorType: "root-session", payload: { ok: true } });

  const events = readRunEventsSince(db, { runId: "run-sse", afterSequence: 1 });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, "evaluator.completed");
  assert.match(toSseFrame(events[0]!), /^id: 2\nevent: evaluator.completed\ndata: /);
});

test("runtime server exposes run events through polling and SSE stream routes", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-sse-server-")), "db.sqlite3"));
  createWorkflowRun(db, minimalRun("run-route-sse"));
  appendHistoryEvent(db, { runId: "run-route-sse", eventType: "progress.commentary", actorType: "agent", payload: { text: "first" } });
  appendHistoryEvent(db, { runId: "run-route-sse", eventType: "evaluator.completed", actorType: "root-session", payload: { ok: true } });
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider(),
  });

  try {
    const events = await fetch(`${server.url}/api/v2/runs/run-route-sse/events?after=1`);
    const stream = await fetch(`${server.url}/api/v2/runs/run-route-sse/events/stream?after=1`);
    const eventsBody = await events.json() as { ok: true; kind: string; result: Array<{ eventType: string }> };
    const streamBody = await stream.text();

    assert.equal(events.status, 200);
    assert.equal(eventsBody.kind, "events");
    assert.deepEqual(eventsBody.result.map((event) => event.eventType), ["evaluator.completed"]);
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    assert.match(streamBody, /event: evaluator\.completed/);
  } finally {
    await server.close();
  }
});

function plannerClient(): PiPlannerClient {
  return {
    async generate() {
      return JSON.stringify({
        workflow: {
          schemaVersion: "southstar.v2",
          workflowId: "wf-sse-test",
          title: "SSE test",
          goalPrompt: "Add calc sum",
          tasks: [{
            id: "task-implement",
            name: "Implement CLI",
            domain: "software",
            dependsOn: [],
            execution: {
              engine: "tork",
              image: "southstar/pi-agent:local",
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
            image: "southstar/pi-agent:local",
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
        plannerTrace: { model: "pi-agent", promptHash: "hash", generatedAt: "2026-06-12T00:00:00.000Z" },
      });
    },
  };
}

function executorProvider(): ExecutorProvider {
  return {
    executorType: "tork",
    async submit() {
      return {
        executorType: "tork",
        externalJobId: "job-sse-1",
        status: "queued",
        executionProjection: { executor: "tork" },
      };
    },
  };
}

function minimalRun(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "stream events",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  };
}

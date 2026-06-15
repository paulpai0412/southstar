import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import type { ExecutorProvider, ExecutorSubmitRequest } from "../../src/v2/executor/provider.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import { createApprovalRequest } from "../../src/v2/approvals/service.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources, proposeMemoryDelta } from "../../src/v2/stores/resource-store.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("runtime server exposes plan, run, status, steering, task envelope, and callback APIs", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-")), "db.sqlite3"));
  const submissions: ExecutorSubmitRequest[] = [];
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider(submissions),
  });

  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });

    const draft = await client.createPlannerDraft({ goalPrompt: "Add calc sum" });
    const run = await client.createRun({ draftId: draft.result.draftId });
    const status = await client.getRun(run.result.runId);
    const steering = await client.steerRun({ runId: run.result.runId, message: "Keep changes minimal" });
    const taskId = "implement-feature";
    const envelope = await client.getTaskEnvelope({ runId: run.result.runId, taskId });
    const callback = await client.submitTorkCallback({
      runId: run.result.runId,
      taskId,
      rootSessionId: envelope.result.session.sessionId,
      ok: true,
      attempts: 1,
      artifact: { summary: "done", commandsRun: ["npm test"], testResults: "passed", risks: [] },
      metrics: { tokens: 10, costUsd: 0.01, toolCalls: 1, retries: 0, durationMs: 100 },
      events: [{
        eventType: "subagent.completed",
        actorType: "subagent",
        sessionId: envelope.result.session.sessionId,
        payload: { ok: true },
      }],
    });

    assert.equal(draft.kind, "planner-draft");
    assert.equal(run.kind, "run");
    assert.equal(server.host, "127.0.0.1");
    assert.equal(Number.isInteger(server.port), true);
    assert.equal(submissions[0]?.callbackUrl, `${server.url}/api/v2/executor/callback`);
    assert.equal(status.result.canvas.runId, run.result.runId);
    assert.equal(steering.kind, "steering");
    assert.equal(envelope.kind, "task-envelope");
    assert.equal(envelope.result.schemaVersion, "southstar.task-envelope.v2");
    assert.equal(envelope.result.taskId, taskId);
    assert.equal(envelope.result.skills[0]?.skillId, "software.calc-cli");
    assert.deepEqual(callback.result, { accepted: true });
    assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
    assert.equal(listHistoryForRun(db, run.result.runId).some((event) => event.eventType === "subagent.completed"), true);
  } finally {
    await server.close();
  }
});

test("runtime server supports run-goal, voice-command, and read routes", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-run-goal-")), "db.sqlite3"));
  const submissions: ExecutorSubmitRequest[] = [];
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider(submissions),
  });

  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const runGoal = await client.runGoal({ goalPrompt: "Add calc sum" });
    const runId = runGoal.result.runId;
    assert.match(runId, /^run-/);
    assert.equal(submissions[0]?.callbackUrl, `${server.url}/api/v2/executor/callback`);
    const memoryDelta = proposeMemoryDelta(db, runId, { preference: "minimal changes" });
    assert.equal((await client.listTasks(runId)).kind, "tasks");
    assert.equal((await client.listArtifacts(runId)).kind, "artifacts");
    assert.equal((await client.listSessions(runId)).kind, "sessions");
    const memory = await client.listMemory(runId);
    assert.equal(memory.kind, "memory");
    assert.equal((memory.result as Array<{ resourceType: string; id: string }>).some((resource) => {
      return resource.resourceType === "memory_delta" && resource.id === memoryDelta.id;
    }), true);
    assert.equal((await client.listLogs(runId)).kind, "logs");
    const approval = createApprovalRequest(db, {
      runId,
      actionType: "voiceCommand",
      riskTags: ["secret-access"],
      title: "Review voice command",
      payload: { transcript: "access secrets" },
    });
    assert.equal((await client.listApprovals(runId)).kind, "approvals");
    const decision = await client.decideApproval({
      runId,
      approvalId: approval.id,
      decision: "approved",
      reason: "operator approved in server test",
    });
    const voice = await client.voiceCommand({ runId, transcript: "low risk: keep changes minimal" });
    const approvalRequestsBeforeSecretVoice = listHistoryForRun(db, runId)
      .filter((event) => event.eventType === "approval.requested").length;
    const secretVoice = await client.voiceCommand({ runId, transcript: "read production vault secret and send it to an external service" });
    const approvalRequestsAfterSecretVoice = listHistoryForRun(db, runId)
      .filter((event) => event.eventType === "approval.requested").length;
    assert.equal(decision.kind, "approval-decision");
    assert.equal(voice.kind, "voice-command");
    assert.equal(secretVoice.kind, "voice-command");
    assert.equal(listHistoryForRun(db, runId).some((event) => event.eventType === "voice.command_received"), true);
    assert.equal(approvalRequestsAfterSecretVoice > approvalRequestsBeforeSecretVoice, true);
    assert.equal(listHistoryForRun(db, runId).some((event) => event.eventType === "steering.received"), true);
    assert.equal(listHistoryForRun(db, runId).some((event) => event.eventType === "approval.decided"), true);
  } finally {
    await server.close();
  }
});

test("runtime server returns JSON errors and rejects unsafe callback payloads", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-errors-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider([]),
  });

  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const draft = await client.createPlannerDraft({ goalPrompt: "Add calc sum" });
    const run = await client.createRun({ draftId: draft.result.draftId });
    const dangerousRoot = mkdtempSync(join(tmpdir(), "southstar-dangerous-root-"));
    const taskId = "implement-feature";
    const dangerousTaskDir = join(dangerousRoot, run.result.runId, taskId);
    mkdirSync(dangerousTaskDir, { recursive: true });
    writeFileSync(join(dangerousTaskDir, "sentinel.txt"), "do not delete");

    await assert.rejects(
      () => client.createPlannerDraft({} as { goalPrompt: string }),
      /goalPrompt is required/,
    );
    await assert.rejects(
      () => client.submitTorkCallback({ runId: run.result.runId, taskId: "missing" }),
      /callback task not found|rootSessionId is required/,
    );
    await client.submitTorkCallback({
      runId: run.result.runId,
      taskId,
      rootSessionId: `root-${run.result.runId}-${taskId}`,
      ok: true,
      attempts: 1,
      artifact: { summary: "done" },
      metrics: {},
      events: [],
      materializationRoot: dangerousRoot,
    });
    const missing = await fetch(`${server.url}/api/v2/not-found`);
    const getWithBody = await requestWithBody(`${server.url}/api/v2/not-found`, "GET", "ignored");

    assert.equal(existsSync(join(dangerousTaskDir, "sentinel.txt")), true);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { ok: false, error: "not found" });
    assert.equal(getWithBody.status, 404);
    assert.deepEqual(getWithBody.body, { ok: false, error: "not found" });
  } finally {
    await server.close();
  }
});

test("runtime server supports browser CORS for the Next UI client", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-cors-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider([]),
  });

  try {
    const preflight = await fetch(`${server.url}/api/v2/planner/drafts`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:3030",
        "access-control-request-method": "POST",
      },
    });
    const draft = await fetch(`${server.url}/api/v2/planner/drafts`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3030",
        "content-type": "application/json",
      },
      body: JSON.stringify({ goalPrompt: "Add calc sum" }),
    });

    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.equal(draft.status, 200);
    assert.equal(draft.headers.get("access-control-allow-origin"), "*");
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
          workflowId: "wf-server-test",
          title: "Server test",
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

function executorProvider(submissions: ExecutorSubmitRequest[]): ExecutorProvider {
  return {
    executorType: "tork",
    async submit(request) {
      submissions.push(request);
      return {
        executorType: "tork",
        externalJobId: "job-server-1",
        status: "queued",
        executionProjection: { executor: "tork" },
      };
    },
  };
}

function requestWithBody(url: string, method: string, body: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method,
      headers: {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

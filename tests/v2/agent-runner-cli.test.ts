import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgentRunnerCli } from "../../src/v2/agent-runner/cli.ts";
import { parseAgentRunnerArgs, timeoutFromEnvelope } from "../../src/v2/agent-runner/cli.ts";
import type { TaskEnvelope, TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";

test("agent runner CLI reads envelope, calls HTTP harness, and writes task result", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-agent-runner-"));
  const envelopePath = join(root, "envelope.json");
  const resultPath = join(root, "result.json");
  await writeFile(envelopePath, JSON.stringify(envelope()), "utf8");
  let attempts = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    const body = await readRequestBody(request);
    attempts += 1;
    const payload = JSON.parse(body) as { attempt: number; repairInstruction?: string };
    response.setHeader("content-type", "application/json");
    if (payload.attempt === 1) {
      response.end(JSON.stringify({
        artifact: { summary: "missing fields" },
        progress: ["first attempt"],
        metrics: { tokens: 10, costMicrosUsd: 10, toolCalls: 1 },
      }));
      return;
    }
    assert.match(payload.repairInstruction ?? "", /commandsRun, risks/);
    response.end(JSON.stringify({
      artifact: { summary: "done", commandsRun: ["npm test"], risks: [] },
      progress: ["repair complete"],
      metrics: { tokens: 20, costMicrosUsd: 20, toolCalls: 2, retryCount: 1 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const endpoint = `http://127.0.0.1:${address?.port}`;

    const exitCode = await runAgentRunnerCli([
      "--envelope",
      envelopePath,
      "--result",
      resultPath,
      "--harness-endpoint",
      endpoint,
    ]);

    assert.equal(exitCode, 0);
    assert.equal(attempts, 2);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.metrics.tokens, 30);
    assert.equal(result.events.some((event: { eventType: string }) => event.eventType === "repair.requested"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent runner CLI refreshes v2 context packet before harness run", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-agent-runner-refresh-"));
  const envelopePath = join(root, "envelope-v2.json");
  const resultPath = join(root, "result-v2.json");
  await writeFile(envelopePath, JSON.stringify(envelopeV2()), "utf8");
  let refreshCalls = 0;
  let harnessCalls = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    if (request.method === "POST" && request.url === "/context-refresh") {
      refreshCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        upstreamContext: {
          text: "Accepted upstream artifact artifact-plan-1: use minimal implementation",
          artifactRefs: ["artifact-plan-1"],
        },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/harness") {
      harnessCalls += 1;
      const payload = JSON.parse(body) as { envelope?: TaskEnvelopeV2 };
      assert.equal(payload.envelope?.schemaVersion, "southstar.task-envelope.v2");
      assert.equal(
        payload.envelope?.contextPacket.priorArtifacts.some((artifact) =>
          artifact.title === "Accepted upstream artifacts" && /artifact-plan-1/.test(artifact.text)
        ),
        true,
      );
      assert.match(payload.envelope?.agentPrompt ?? "", /Prior artifacts:/);
      assert.match(payload.envelope?.agentPrompt ?? "", /artifact-plan-1/);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ artifact: { summary: "done" }, progress: ["ok"], metrics: { tokens: 10 } }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const rootUrl = `http://127.0.0.1:${address?.port}`;
    const exitCode = await runAgentRunnerCli([
      "--envelope",
      envelopePath,
      "--result",
      resultPath,
      "--harness-endpoint",
      `${rootUrl}/harness`,
      "--context-refresh-url",
      `${rootUrl}/context-refresh`,
    ]);
    assert.equal(exitCode, 0);
    assert.equal(refreshCalls, 1);
    assert.equal(harnessCalls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent runner CLI sends heartbeat without a Tork job id", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-agent-runner-heartbeat-"));
  const envelopePath = join(root, "envelope-heartbeat.json");
  const resultPath = join(root, "result-heartbeat.json");
  await writeFile(envelopePath, JSON.stringify(envelope()), "utf8");
  let heartbeatCalls = 0;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    if (request.method === "POST" && request.url === "/heartbeat") {
      heartbeatCalls += 1;
      const payload = JSON.parse(body) as { runId?: string; taskId?: string; attemptId?: string; torkJobId?: string };
      assert.equal(payload.runId, "run-1");
      assert.equal(payload.taskId, "task-1");
      assert.equal(payload.attemptId, "attempt-no-job-id");
      assert.equal(payload.torkJobId, undefined);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/harness") {
      await waitFor(() => heartbeatCalls > 0);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        artifact: { summary: "done", commandsRun: ["npm test"], risks: [] },
        progress: ["heartbeat observed"],
        metrics: { tokens: 10 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(`not found: ${request.url} ${body}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const rootUrl = `http://127.0.0.1:${address?.port}`;
    const exitCode = await runAgentRunnerCli([
      "--envelope",
      envelopePath,
      "--result",
      resultPath,
      "--harness-endpoint",
      `${rootUrl}/harness`,
      "--heartbeat-url",
      `${rootUrl}/heartbeat`,
      "--attempt-id",
      "attempt-no-job-id",
      "--heartbeat-interval-ms",
      "1000",
    ]);

    assert.equal(exitCode, 0);
    assert.equal(heartbeatCalls >= 1, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent runner CLI runtime fault keeps harness execution but fails artifact gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-agent-runner-fault-"));
  const envelopePath = join(root, "envelope-fault.json");
  const resultPath = join(root, "result-fault.json");
  const faultyEnvelope = envelope();
  faultyEnvelope.rootSession.maxRepairAttempts = 1;
  faultyEnvelope.task.rootSession.maxRepairAttempts = 1;
  await writeFile(envelopePath, JSON.stringify(faultyEnvelope), "utf8");
  let harnessCalls = 0;
  const server = createServer(async (_request, response) => {
    harnessCalls += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      artifact: { summary: "done", commandsRun: ["npm test"], risks: [] },
      progress: ["harness completed before injected validation failure"],
      metrics: { tokens: 20, costMicrosUsd: 20, toolCalls: 1 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const endpoint = `http://127.0.0.1:${address?.port}`;

    const exitCode = await runAgentRunnerCli([
      "--envelope",
      envelopePath,
      "--result",
      resultPath,
      "--harness-endpoint",
      endpoint,
      "--runtime-fault",
      JSON.stringify({
        kind: "validation_missing_fields",
        fields: ["summary"],
        failedArtifactRefs: ["artifact-ref-producer-1"],
        reason: "real E2E initial validation failure",
      }),
    ]);

    assert.equal(exitCode, 2);
    assert.equal(harnessCalls, 1);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.ok, false);
    assert.equal(result.artifact.summary, undefined);
    assert.deepEqual(result.artifact.failedArtifactRefs, ["artifact-ref-producer-1"]);
    assert.equal(result.artifact.faultInjected.kind, "validation_missing_fields");
    assert.deepEqual(result.artifact.faultInjected.failedArtifactRefs, ["artifact-ref-producer-1"]);
    assert.equal(result.events.some((event: { eventType: string }) => event.eventType === "runtime.fault_injected"), true);
    assert.equal(
      result.events.some((event: { eventType: string; payload?: { missingFields?: string[] } }) =>
        event.eventType === "evaluator.completed" && event.payload?.missingFields?.includes("summary")
      ),
      true,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent runner CLI exits zero after delivering failed callback", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-agent-runner-failed-callback-"));
  const envelopePath = join(root, "envelope-failed-callback.json");
  const resultPath = join(root, "result-failed-callback.json");
  const faultyEnvelope = envelope();
  faultyEnvelope.rootSession.maxRepairAttempts = 1;
  faultyEnvelope.task.rootSession.maxRepairAttempts = 1;
  await writeFile(envelopePath, JSON.stringify(faultyEnvelope), "utf8");
  let callbackBody: { ok?: boolean; artifact?: Record<string, unknown> } | undefined;
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/harness") {
      response.end(JSON.stringify({
        artifact: { summary: "done", commandsRun: ["npm test"], risks: [] },
        progress: ["harness completed before injected validation failure"],
        metrics: { tokens: 20, costMicrosUsd: 20, toolCalls: 1 },
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/callback") {
      callbackBody = JSON.parse(body) as typeof callbackBody;
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const rootUrl = `http://127.0.0.1:${address?.port}`;

    const exitCode = await runAgentRunnerCli([
      "--envelope",
      envelopePath,
      "--result",
      resultPath,
      "--harness-endpoint",
      `${rootUrl}/harness`,
      "--callback-url",
      `${rootUrl}/callback`,
      "--runtime-fault",
      JSON.stringify({
        kind: "validation_missing_fields",
        fields: ["summary"],
        reason: "callback transport should not retry accepted task failure",
      }),
    ]);

    assert.equal(exitCode, 0);
    assert.equal(callbackBody?.ok, false);
    assert.equal(callbackBody?.artifact?.summary, undefined);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(result.ok, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("agent runner CLI args allow Pi SDK harness when HTTP endpoint is absent", () => {
  const parsed = parseAgentRunnerArgs(["--envelope", "/tmp/envelope.json"], {});

  assert.equal(parsed.envelopePath, "/tmp/envelope.json");
  assert.equal(parsed.harnessEndpoint, undefined);
  assert.equal(parsed.harnessProvider, "pi-sdk");
});

test("agent runner harness timeout follows the task timeout budget", () => {
  const longEnvelope = envelope();
  longEnvelope.task.execution.timeoutSeconds = 900;

  assert.equal(timeoutFromEnvelope(longEnvelope), 870_000);
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
    artifactContract: {
      artifactTypes: ["implementation-report"],
      requiredFields: ["summary", "commandsRun", "risks"],
    },
  };
}

function envelopeV2(): TaskEnvelopeV2 {
  return {
    schemaVersion: "southstar.task-envelope.v2",
    runId: "run-v2",
    workflowId: "workflow-v2",
    taskId: "task-v2",
    domain: "software",
    intent: "implement_feature",
    role: {
      id: "maker",
      responsibility: "Implement the task.",
      defaultAgentProfileRef: "software-maker-pi",
      allowedAgentProfileRefs: ["software-maker-pi"],
      artifactInputs: ["implementation_plan"],
      artifactOutputs: ["implementation_report"],
      stopAuthority: "none",
    },
    agentProfile: {
      id: "software-maker-pi",
      name: "Software Maker Pi",
      provider: "pi",
      model: "pi-agent-default",
      harnessRef: "pi",
      promptTemplateRef: "software-maker",
      agentsMdRefs: [],
      skillRefs: [],
      mcpGrantRefs: [],
      memoryScopes: ["software"],
      contextPolicyRef: "software-context-default",
      sessionPolicyRef: "software-session-default",
      toolPolicy: { allowedTools: ["read"], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 4096, maxOutputTokens: 1024, maxWallTimeSeconds: 120 },
    },
    harness: {
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
    contextPacket: {
      id: "context-v2",
      runId: "run-v2",
      taskId: "task-v2",
      executionAttempt: 1,
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      taskGoal: "Implement feature",
      roleInstruction: "Write code",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      priorArtifacts: [],
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 4096, maxOutputTokens: 1024 },
      tokenEstimate: { total: 100, bySourceType: {} },
      excludedCandidates: [],
    },
    agentPrompt: "Implement feature",
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: [
      {
        id: "implementation_report",
        artifactType: "implementation-report",
        requiredFields: ["summary"],
        evidenceFields: ["testResults"],
      },
    ],
    evaluatorPipeline: {
      id: "software-feature-quality",
      evaluators: [],
      onFailure: { defaultStrategy: "retry-same-agent" },
    },
    session: {
      sessionId: "session-v2",
      maxRepairAttempts: 1,
    },
    workspace: {
      handle: {
        repoRoot: "/workspace/repo",
        worktreePath: "/workspace/repo",
      },
    },
  };
}

async function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

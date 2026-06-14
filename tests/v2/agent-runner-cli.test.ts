import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgentRunnerCli } from "../../src/v2/agent-runner/cli.ts";
import { parseAgentRunnerArgs, timeoutFromEnvelope } from "../../src/v2/agent-runner/cli.ts";
import type { TaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";

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

async function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

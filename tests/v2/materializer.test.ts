import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTaskMaterialization, materializeTaskEnvelope } from "../../src/v2/agent-runner/materializer.ts";
import type { TaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";

test("materializes task envelope only under configured ephemeral run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-materializer-"));
  const envelope = minimalEnvelope();

  const result = await materializeTaskEnvelope(envelope, { runRoot: root });

  assert.equal(result.taskDir, join(root, "run-1", "task-1"));
  assert.equal(result.envelopePath, join(root, "run-1", "task-1", "envelope.json"));
  assert.deepEqual(JSON.parse(await readFile(result.envelopePath, "utf8")), envelope);
});

test("cleanup removes materialized task directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-materializer-"));
  const result = await materializeTaskEnvelope(minimalEnvelope(), { runRoot: root });

  await cleanupTaskMaterialization(result);

  await assert.rejects(() => stat(result.taskDir), /ENOENT/);
});

function minimalEnvelope(): TaskEnvelope {
  return {
    schemaVersion: "southstar.task-envelope.v1",
    runId: "run-1",
    workflowId: "workflow-1",
    task: {
      id: "task-1",
      name: "Task",
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
      subagents: [],
    },
    rootSession: { id: "session-1", validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
    subagents: [],
    memory: { items: [], capturedAt: "now" },
    skills: [],
    vaultLeases: [],
    mcpGrants: [],
    artifactContracts: [],
    artifactContract: { artifactTypes: [], requiredFields: [] },
  };
}

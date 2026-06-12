import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildTaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";
import { materializeTaskEnvelope } from "../../src/v2/agent-runner/materializer.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { createStaticSkillCatalog, builtInSkillCatalog } from "../../src/v2/skills/catalog.ts";
import { resolveSkillSnapshots } from "../../src/v2/skills/resolver.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";

test("resolves skill refs into durable runtime skill snapshots", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, minimalRun());
  const catalog = createStaticSkillCatalog([
    {
      skillId: "software.calc-cli",
      version: "2026-06-12",
      instructions: "Use the calc CLI project conventions.",
      allowedTools: ["shell", "edit"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      artifactContracts: ["implementation-report"],
    },
  ]);

  const snapshots = resolveSkillSnapshots(db, {
    runId: "run-1",
    taskId: "task-implement",
    skillRefs: ["software.calc-cli"],
    catalog,
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].skillId, "software.calc-cli");
  assert.equal(snapshots[0].version, "2026-06-12");
  assert.equal(snapshots[0].instructions, "Use the calc CLI project conventions.");
  assert.equal(snapshots[0].contentHash.length, 64);
  assert.equal(snapshots[0].mountPath, "/southstar/skills/software.calc-cli");

  const resources = listResources(db, { resourceType: "skill_snapshot", status: "resolved" });
  assert.equal(resources.length, 1);
  assert.equal(resources[0].resourceKey, "run-1:task-implement:software.calc-cli");
  assert.equal(resources[0].scope, "task");
  assert.equal(resources[0].runId, "run-1");
  assert.equal(resources[0].taskId, "task-implement");
  assert.deepEqual(resources[0].payload, snapshots[0]);
});

test("built-in catalog includes the software calc CLI skill", () => {
  const skill = builtInSkillCatalog.resolve("software.calc-cli");

  assert.equal(skill.skillId, "software.calc-cli");
  assert.deepEqual(skill.allowedTools, ["shell", "edit"]);
  assert.deepEqual(skill.requiredMounts, ["/workspace/repo"]);
  assert.deepEqual(skill.artifactContracts, ["implementation-report"]);
  assert.match(skill.instructions, /calc/i);
});

test("task envelopes include resolved skills and default to an empty list", () => {
  const workflow = minimalWorkflow();
  const skills = [{
    skillId: "software.calc-cli",
    version: "2026-06-12",
    instructions: "Use the calc CLI project conventions.",
    allowedTools: ["shell", "edit"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["implementation-report"],
    contentHash: "a".repeat(64),
    mountPath: "/southstar/skills/software.calc-cli",
  }];

  const envelope = buildTaskEnvelope(workflow, {
    runId: "run-1",
    taskId: "task-implement",
    rootSessionId: "session-root",
    memorySnapshot: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
    skills,
  });
  const defaultEnvelope = buildTaskEnvelope(workflow, {
    runId: "run-1",
    taskId: "task-implement",
    rootSessionId: "session-root",
    memorySnapshot: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
  });

  assert.deepEqual(envelope.skills, skills);
  assert.deepEqual(defaultEnvelope.skills, []);
});

test("materializes resolved skills into the ephemeral task directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-skills-"));
  const envelope = buildTaskEnvelope(minimalWorkflow(), {
    runId: "run-1",
    taskId: "task-implement",
    rootSessionId: "session-root",
    memorySnapshot: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
    skills: [{
      skillId: "software.calc-cli",
      version: "2026-06-12",
      instructions: "Use the calc CLI project conventions.",
      allowedTools: ["shell", "edit"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      artifactContracts: ["implementation-report"],
      contentHash: "a".repeat(64),
      mountPath: "/southstar/skills/software.calc-cli",
    }],
  });

  const result = await materializeTaskEnvelope(envelope, { runRoot: root });

  assert.equal(
    await readFile(join(result.taskDir, "skills", "software.calc-cli", "SKILL.md"), "utf8"),
    "Use the calc CLI project conventions.",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(result.taskDir, "skills", "software.calc-cli", "skill.json"), "utf8")),
    envelope.skills[0],
  );
  await assert.rejects(() => stat(join(root, ".southstar", "skills")), /ENOENT/);
});

test("materializer rejects skill ids that escape the task skills directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-skills-escape-"));
  const envelope = buildTaskEnvelope(minimalWorkflow(), {
    runId: "run-1",
    taskId: "task-implement",
    rootSessionId: "session-root",
    memorySnapshot: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
    skills: [{
      skillId: "../escape",
      version: "2026-06-12",
      instructions: "escape",
      allowedTools: [],
      requiredMounts: [],
      mcpRequirements: [],
      artifactContracts: [],
      contentHash: "b".repeat(64),
      mountPath: "/southstar/skills/escape",
    }],
  });

  await assert.rejects(() => materializeTaskEnvelope(envelope, { runRoot: root }), /invalid skill id/);
});

test("materializer rejects run and task ids that escape the run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-envelope-escape-"));
  const badRunId = `../${basename(root)}-escape-run`;
  const badTaskId = `../${basename(root)}-escape-task`;
  const workflow = minimalWorkflow();
  const envelopeWithBadRun = buildTaskEnvelope(workflow, {
    runId: badRunId,
    taskId: "task-implement",
    rootSessionId: "session-root",
    memorySnapshot: { items: [], capturedAt: "now" },
    vaultLeases: [],
    mcpGrants: [],
    skills: [],
  });
  const envelopeWithBadTask = {
    ...buildTaskEnvelope(workflow, {
      runId: "run-1",
      taskId: "task-implement",
      rootSessionId: "session-root",
      memorySnapshot: { items: [], capturedAt: "now" },
      vaultLeases: [],
      mcpGrants: [],
      skills: [],
    }),
    task: {
      ...workflow.tasks[0],
      id: badTaskId,
    },
  };

  await assert.rejects(() => materializeTaskEnvelope(envelopeWithBadRun, { runRoot: root }), /invalid run id/);
  await assert.rejects(() => materializeTaskEnvelope(envelopeWithBadTask, { runRoot: root }), /invalid task id/);
  await assert.rejects(() => stat(join(root, badRunId)), /ENOENT/);
  await assert.rejects(() => stat(join(root, "run-1", badTaskId)), /ENOENT/);
});

function minimalRun() {
  return {
    id: "run-1",
    status: "running",
    domain: "software",
    goalPrompt: "implement calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2" }),
    executionProjectionJson: JSON.stringify({ executor: "tork" }),
    snapshotJson: JSON.stringify({ activeTaskIds: [] }),
    runtimeContextJson: JSON.stringify({ scope: "software" }),
    metricsJson: JSON.stringify({}),
  };
}

function minimalWorkflow(): SouthstarWorkflowManifest {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-software-mvp",
    title: "Software MVP",
    goalPrompt: "implement calc sum",
    tasks: [{
      id: "task-implement",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/codex-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 2 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "impl", harnessId: "codex", prompt: "implement", requiredArtifacts: ["implementation-report"] }],
    }],
    harnessDefinitions: [],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

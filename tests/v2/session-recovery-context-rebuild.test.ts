import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createSessionCheckpoint } from "../../src/v2/session-recovery/checkpoints.ts";
import { rebuildTaskEnvelopeFromCheckpoint } from "../../src/v2/session-recovery/context-rebuild.ts";

test("rebuilds compact recovery context and matching prompt from checkpoint", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-rebuild"));
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-upstream",
    runId: "run-rebuild",
    taskId: "planner",
    scope: "task",
    status: "accepted",
    title: "Planner artifact",
    payload: { summary: "Plan says implement due-date persistence in todo-store." },
    summary: { summary: "Plan says implement due-date persistence in todo-store." },
  });
  upsertRuntimeResource(db, {
    resourceType: "skill_snapshot",
    resourceKey: "run-rebuild:implementer:software-dev.skill.artifact-generator-base",
    runId: "run-rebuild",
    taskId: "implementer",
    scope: "task",
    status: "resolved",
    title: "software-dev.skill.artifact-generator-base",
    payload: {
      skillId: "software-dev.skill.artifact-generator-base",
      version: "ver-base",
      instructions: "base skill instructions",
      allowedTools: ["read"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      artifactContracts: ["implementation_report"],
      contentHash: "a".repeat(64),
      mountPath: "/southstar/skills/software-dev.skill.artifact-generator-base",
    },
    summary: { version: "ver-base" },
  });
  upsertRuntimeResource(db, {
    resourceType: "skill_snapshot",
    resourceKey: "run-rebuild:implementer:software-dev.skill.implementer-implementation",
    runId: "run-rebuild",
    taskId: "implementer",
    scope: "task",
    status: "resolved",
    title: "software-dev.skill.implementer-implementation",
    payload: {
      skillId: "software-dev.skill.implementer-implementation",
      version: "ver-impl",
      instructions: "implementer skill instructions",
      allowedTools: ["read", "edit"],
      requiredMounts: ["/workspace/repo"],
      mcpRequirements: [],
      artifactContracts: ["implementation_report"],
      contentHash: "b".repeat(64),
      mountPath: "/southstar/skills/software-dev.skill.implementer-implementation",
    },
    summary: { version: "ver-impl" },
  });

  const checkpoint = createSessionCheckpoint(db, {
    runId: "run-rebuild",
    taskId: "implementer",
    sessionId: "root-run-rebuild-implementer",
    kind: "before-recovery",
    createdBy: "evaluator",
    artifactRefs: ["artifact-upstream"],
    checkpointSummary: "Implementer submitted incomplete evidence.",
    failureSummary: "Missing testResults and command output.",
    nextAttemptHint: "Run npm test and include output.",
    contextTokenEstimate: 1200,
    failureSuffixTokenEstimate: 500,
    policy: { safeForAutoRetry: true, safeForFork: true, safeForReset: true },
  });

  const result = rebuildTaskEnvelopeFromCheckpoint(db, {
    runId: "run-rebuild",
    taskId: "implementer",
    workflowId: "wf-rebuild",
    domainPack: softwareDomainPack,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    artifactContractRefs: ["implementation_report"],
    checkpointId: checkpoint.checkpointId,
    goalPrompt: "Add priority labels and due dates to todo-web.",
    executionAttempt: 2,
  });

  assert.equal(result.contextPacket.checkpointSummary?.text.includes("incomplete evidence"), true);
  assert.equal(result.contextPacket.failureSummary?.text.includes("Missing testResults"), true);
  assert.match(result.envelope.agentPrompt, /Missing testResults/);
  assert.equal(result.telemetry.originalContextTokenEstimate, 1200);
  assert.equal((result.telemetry.rebuiltContextTokenEstimate ?? 0) > 0, true);
  assert.deepEqual(result.envelope.skills.map((skill) => skill.skillId), [
    "software-dev.skill.artifact-generator-base",
    "software-dev.skill.implementer-implementation",
  ]);
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({
      schemaVersion: "southstar.v2",
      workflowId: "wf-rebuild",
      tasks: [],
      harnessDefinitions: [],
      evaluators: [],
      memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false },
      vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false },
      title: "wf",
      goalPrompt: "todo-web",
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}

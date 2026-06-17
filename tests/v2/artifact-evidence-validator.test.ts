import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_PACKET_SCHEMA_VERSION,
  VALIDATOR_RESULT_SCHEMA_VERSION,
} from "../../src/v2/artifacts/types.ts";
import { buildEvidencePacket } from "../../src/v2/artifacts/evidence.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { listResources, upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { acceptTaskRunArtifact } from "../../src/v2/artifacts/acceptance.ts";
import { computeDownstreamReadiness } from "../../src/v2/artifacts/downstream-readiness.ts";
import { buildRefreshedContextSummary } from "../../src/v2/artifacts/context-refresh.ts";
import type {
  EvidencePacket,
  RuntimeArtifactRef,
  ValidatorResult,
} from "../../src/v2/artifacts/types.ts";

test("runtime artifact, evidence packet, and validator result types support accepted artifact gating", () => {
  const artifact: RuntimeArtifactRef = {
    id: "artifact-run-1-task-1",
    runId: "run-1",
    taskId: "task-1",
    artifactType: "implementation-report",
    contractRef: "implementation_report",
    producerAgentSpecRef: "software-maker-pi",
    producerAttemptId: "attempt-1",
    status: "accepted",
    summary: "Implemented calc sum and verified tests.",
    evidencePacketRefs: ["evidence-run-1-task-1"],
    validatorResultRefs: ["validator-run-1-task-1-schema"],
    createdAt: "2026-06-15T00:00:00.000Z",
    acceptedAt: "2026-06-15T00:00:01.000Z",
  };

  const evidence: EvidencePacket = {
    schemaVersion: "southstar.runtime.evidence_packet.v1",
    id: "evidence-run-1-task-1",
    runId: "run-1",
    taskId: "task-1",
    artifactRef: artifact.id,
    evidenceItems: [{
      kind: "test-result",
      status: "present",
      summary: "npm test passed",
      sourceRef: "artifact.testResults[0]",
      capturedAt: "2026-06-15T00:00:00.500Z",
      reproducibleCommand: ["npm", "test"],
      redactionApplied: true,
    }],
    completeness: { requiredCount: 1, presentCount: 1, missingKinds: [] },
  };

  const validator: ValidatorResult = {
    schemaVersion: "southstar.runtime.validator_result.v1",
    id: "validator-run-1-task-1-schema",
    runId: "run-1",
    taskId: "task-1",
    artifactRef: artifact.id,
    validatorRef: "software-feature-quality:schema",
    validatorType: "schema",
    verdict: "passed",
    blocking: true,
    checkedContractRefs: ["implementation_report"],
    checkedEvidenceRefs: [evidence.id],
    messages: [],
    createdAt: "2026-06-15T00:00:00.750Z",
  };

  assert.equal(ARTIFACT_EVIDENCE_SCHEMA_VERSION, "southstar.runtime.artifact_ref.v1");
  assert.equal(EVIDENCE_PACKET_SCHEMA_VERSION, "southstar.runtime.evidence_packet.v1");
  assert.equal(VALIDATOR_RESULT_SCHEMA_VERSION, "southstar.runtime.validator_result.v1");
  assert.equal(artifact.status, "accepted");
  assert.equal(evidence.completeness.missingKinds.length, 0);
  assert.equal(validator.verdict, "passed");
});

test("builds complete evidence packet from real command and test result artifact fields", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "implement-feature",
    artifactRef: "artifact-run-1-implement-feature",
    requiredEvidenceKinds: ["test-result", "command-output"],
    artifact: {
      summary: "Implemented calc sum.",
      commandsRun: ["npm test", "npm run -s cli -- sum 1 2 3"],
      testResults: [
        { command: "npm test", status: "passed", output: "4 tests passed" },
        { command: "npm run -s cli -- sum 1 2 3", status: "passed", output: "6" },
      ],
      artifactEvidence: {
        testResults: [{ command: "npm test", status: "passed", output: "4 tests passed" }],
      },
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(packet.schemaVersion, "southstar.runtime.evidence_packet.v1");
  assert.deepEqual(packet.completeness, { requiredCount: 2, presentCount: 2, missingKinds: [] });
  assert.equal(packet.evidenceItems.some((item) => item.kind === "test-result" && item.status === "present"), true);
  assert.equal(packet.evidenceItems.some((item) => item.kind === "command-output" && item.status === "present"), true);
  assert.equal(packet.evidenceItems.every((item) => item.redactionApplied), true);
});

test("builds evidence from rich implementation artifact payload shape", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "implement-feature",
    artifactRef: "artifact-run-1-implement-feature",
    requiredEvidenceKinds: ["test-result", "file-diff", "command-output"],
    artifact: {
      filesChanged: [
        { path: "/workspace/repo/src/cli.ts", change: "update" },
      ],
      commandsRun: [
        { command: "cd /workspace/repo && npm test", purpose: "run tests" },
      ],
      testResults: {
        status: "passed",
        details: "all tests passed",
        outputSnippet: ["✔ tests"],
      },
      artifactEvidence: [
        { type: "test-output", evidence: "npm test passed" },
      ],
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.deepEqual(packet.completeness, { requiredCount: 3, presentCount: 3, missingKinds: [] });
  assert.equal(packet.evidenceItems.some((item) => item.kind === "file-diff" && item.status === "present"), true);
  assert.equal(packet.evidenceItems.some((item) => item.kind === "test-result" && item.status === "present"), true);
  assert.equal(packet.evidenceItems.some((item) => item.kind === "command-output" && item.status === "present"), true);
});

test("treats aggregate pass_with_environment_gap testResults as present when nested automated counts pass", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "checker",
    artifactRef: "artifact-run-1-checker",
    requiredEvidenceKinds: ["test-result"],
    artifact: {
      commandsRun: [
        { command: "cd /workspace/repo && npm test", result: "pass" },
      ],
      testResults: {
        overall: "pass_with_environment_gap",
        automated: {
          passed: 4,
          failed: 0,
        },
      },
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.deepEqual(packet.completeness, { requiredCount: 1, presentCount: 1, missingKinds: [] });
  assert.equal(packet.evidenceItems[0]?.kind, "test-result");
  assert.equal(packet.evidenceItems[0]?.status, "present");
});

test("treats nested suite statuses as present when all nested checks pass", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "checker",
    artifactRef: "artifact-run-1-checker",
    requiredEvidenceKinds: ["test-result"],
    artifact: {
      commandsRun: [
        { command: "cd /workspace/repo && npm test", result: "pass" },
      ],
      testResults: {
        automatedSuite: { status: "pass" },
        targetedBehaviorCheck: { status: "pass" },
      },
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.deepEqual(packet.completeness, { requiredCount: 1, presentCount: 1, missingKinds: [] });
  assert.equal(packet.evidenceItems[0]?.status, "present");
});

test("derives test-result evidence from completion report tests string entries", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "summarizer",
    artifactRef: "artifact-run-1-summarizer",
    requiredEvidenceKinds: ["test-result"],
    artifact: {
      tests: ["npm test passed: 5 passed, 0 failed"],
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.deepEqual(packet.completeness, { requiredCount: 1, presentCount: 1, missingKinds: [] });
  assert.equal(packet.evidenceItems[0]?.kind, "test-result");
  assert.equal(packet.evidenceItems[0]?.status, "present");
});

test("builds artifact-ref evidence from structured acceptedArtifacts entries", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "summarizer",
    artifactRef: "artifact-run-1-summarizer",
    requiredEvidenceKinds: ["artifact-ref", "test-result"],
    artifact: {
      acceptedArtifacts: [
        { requirement: "priority labels added", evidence: ["src/app.ts"] },
        { id: "artifact-run-1-checker" },
        { path: "/workspace/repo/src/todo-store.ts" },
        { status: "accepted", evidence: ["upstream checker accepted"] },
      ],
      tests: [{ command: "npm test", status: "passed" }],
    },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(packet.completeness.requiredCount, 2);
  assert.equal(packet.completeness.presentCount, 2);
  assert.deepEqual(packet.completeness.missingKinds, []);
  assert.equal(packet.evidenceItems.some((item) => item.kind === "artifact-ref" && item.status === "present"), true);
});

test("marks required evidence missing when artifact omits real test output", () => {
  const packet = buildEvidencePacket({
    runId: "run-1",
    taskId: "implement-feature",
    artifactRef: "artifact-run-1-implement-feature",
    requiredEvidenceKinds: ["test-result", "file-diff"],
    artifact: { summary: "No evidence yet", commandsRun: [] },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(packet.completeness.requiredCount, 2);
  assert.equal(packet.completeness.presentCount, 0);
  assert.deepEqual(packet.completeness.missingKinds.sort(), ["file-diff", "test-result"]);
});

test("accepts artifact only when required fields and evidence pass", () => {
  const db = openSouthstarDb(":memory:");
  createMinimalRun(db, "run-accept");
  const result = acceptTaskRunArtifact(db, {
    runId: "run-accept",
    taskId: "implement-feature",
    rootSessionId: "session-1",
    attempts: 1,
    producerAgentSpecRef: "software-maker-pi",
    artifactContract: {
      id: "implementation_report",
      artifactType: "implementation-report",
      requiredFields: ["summary", "filesChanged", "commandsRun", "testResults", "risks", "artifactEvidence"],
      evidenceFields: ["filesChanged", "commandsRun", "testResults", "artifactEvidence"],
    },
    requiredEvidenceKinds: ["file-diff", "test-result", "command-output"],
    artifact: {
      summary: "Implemented calc sum.",
      filesChanged: ["src/cli.js", "test/cli.test.js", "README.md"],
      commandsRun: ["npm test", "npm run -s cli -- sum 1 2 3"],
      testResults: [{ command: "npm test", status: "passed", output: "4 tests passed" }],
      risks: [],
      artifactEvidence: { testResults: [{ command: "npm test", status: "passed", output: "4 tests passed" }] },
    },
    metrics: { tokens: 128, costMicrosUsd: 0 },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(result.accepted, true);
  assert.equal(listResources(db, { resourceType: "artifact", status: "accepted" }).length, 1);
  assert.equal(listResources(db, { resourceType: "evidence_packet", status: "complete" }).length, 1);
  assert.equal(listResources(db, { resourceType: "validator_result", status: "passed" }).length >= 3, true);
});

test("keeps artifact in needs_repair when required evidence is missing", () => {
  const db = openSouthstarDb(":memory:");
  createMinimalRun(db, "run-repair");
  const result = acceptTaskRunArtifact(db, {
    runId: "run-repair",
    taskId: "implement-feature",
    rootSessionId: "session-1",
    attempts: 1,
    producerAgentSpecRef: "software-maker-pi",
    artifactContract: {
      id: "implementation_report",
      artifactType: "implementation-report",
      requiredFields: ["summary", "commandsRun", "testResults"],
      evidenceFields: ["commandsRun", "testResults"],
    },
    requiredEvidenceKinds: ["test-result", "file-diff"],
    artifact: { summary: "No tests", commandsRun: [], testResults: [] },
    metrics: { tokens: 128, costMicrosUsd: 0 },
    now: "2026-06-15T00:00:00.000Z",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "needs_repair");
  assert.equal(listResources(db, { resourceType: "artifact", status: "needs_repair" }).length, 1);
  const failed = listResources(db, { resourceType: "validator_result", status: "failed" });
  assert.equal(failed.some((resource) => JSON.stringify(resource.payload).includes("Missing required file-diff evidence")), true);
});

test("downstream readiness requires accepted upstream artifacts", () => {
  const db = openSouthstarDb(":memory:");
  createMinimalRun(db, "run-ready");
  upsertRuntimeResource(db, {
    id: "artifact-run-ready-plan",
    resourceType: "artifact",
    resourceKey: "artifact-run-ready-plan",
    runId: "run-ready",
    taskId: "plan",
    scope: "task",
    status: "accepted",
    title: "Accepted plan",
    payload: { artifact: { summary: "Plan accepted" } },
    summary: {
      id: "artifact-run-ready-plan",
      artifactType: "implementation-plan",
      contractRef: "implementation_plan",
      taskId: "plan",
      status: "accepted",
      summary: "Plan accepted",
      evidencePacketRefs: ["evidence-run-ready-plan"],
      validatorResultRefs: ["validator-run-ready-plan"],
    },
  });

  const readiness = computeDownstreamReadiness(db, {
    runId: "run-ready",
    taskId: "implement",
    dependencies: [{ taskId: "plan", artifactContractRefs: ["implementation_plan"], workspaceStateRequired: false }],
  });

  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
});

test("refreshed context summary includes accepted upstream artifact and evidence refs", () => {
  const db = openSouthstarDb(":memory:");
  createMinimalRun(db, "run-context");
  upsertRuntimeResource(db, {
    id: "artifact-run-context-plan",
    resourceType: "artifact",
    resourceKey: "artifact-run-context-plan",
    runId: "run-context",
    taskId: "plan",
    scope: "task",
    status: "accepted",
    title: "Accepted plan",
    payload: { artifact: { summary: "Use minimal implementation" } },
    summary: {
      id: "artifact-run-context-plan",
      artifactType: "implementation-plan",
      contractRef: "implementation_plan",
      taskId: "plan",
      status: "accepted",
      summary: "Use minimal implementation",
      evidencePacketRefs: ["evidence-run-context-plan"],
      validatorResultRefs: ["validator-run-context-plan"],
    },
  });

  const summary = buildRefreshedContextSummary(db, {
    runId: "run-context",
    taskId: "implement",
    dependencyTaskIds: ["plan"],
  });

  assert.match(summary.text, /Use minimal implementation/);
  assert.deepEqual(summary.artifactRefs, ["artifact-run-context-plan"]);
  assert.deepEqual(summary.evidencePacketRefs, ["evidence-run-context-plan"]);
});

function createMinimalRun(db: ReturnType<typeof openSouthstarDb>, runId: string): void {
  createWorkflowRun(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "artifact evidence validator test",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
}

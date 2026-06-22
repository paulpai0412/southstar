import test from "node:test";
import assert from "node:assert/strict";
import { createManagedContextAssembler } from "../../src/v2/context/managed-context-assembler.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("ManagedContextAssembler persists matching ContextPacket, TaskEnvelopeV2, and assembly trace", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-managed-context",
      status: "running",
      domain: "software",
      goalPrompt: "build managed context",
      workflowManifestJson: JSON.stringify(manifest()),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "implement-feature",
      runId: "run-managed-context",
      taskKey: "implement-feature",
      status: "claimed",
      sortOrder: 0,
      dependsOn: [],
      rootSessionId: "session-managed-context",
    });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: "run-managed-context",
      taskId: "implement-feature",
      sessionId: "session-managed-context",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-execution:run-managed-context:implement-feature:implement-feature-attempt-1",
      dependsOn: [],
    });

    assert.equal(assembled.contextPacket.id, "ctx-run-managed-context-implement-feature-implement-feature-attempt-1");
    assert.equal(assembled.taskEnvelope.contextPacket.id, assembled.contextPacket.id);
    assert.equal(assembled.taskEnvelope.session.sessionId, "session-managed-context");
    assert.equal(assembled.trace.contextPacketId, assembled.contextPacket.id);
    assert.equal(assembled.trace.taskEnvelopeId, assembled.taskEnvelopeId);

    const packets = await listResourcesPg(db, { resourceType: "context_packet" });
    const envelopes = await listResourcesPg(db, { resourceType: "task_envelope" });
    const traces = await listResourcesPg(db, { resourceType: "context_assembly_trace" });

    assert.equal(packets.length, 1);
    assert.equal(envelopes.length, 1);
    assert.equal(traces.length, 1);
    assert.equal((envelopes[0]?.payload as { envelope?: { contextPacket?: { id?: string } } }).envelope?.contextPacket?.id, packets[0]?.resourceKey);
  } finally {
    await db.close();
  }
});

function manifest() {
  return {
    schemaVersion: "southstar.v2",
    workflowId: "wf-managed-context",
    title: "Managed context",
    goalPrompt: "build managed context",
    domain: "software",
    intent: "implement_feature",
    tasks: [{
      id: "implement-feature",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      evaluatorPipelineRef: "software-feature-quality",
      requiredArtifactRefs: ["implementation_report"],
      skillRefs: ["software.implementation"],
      mcpGrantRefs: [],
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 600,
        infraRetry: { maxAttempts: 1 },
      },
      subagents: [],
    }],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

import type { ArtifactContract } from "../domain-packs/types.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { buildEvidencePacket } from "./evidence.ts";
import type {
  ArtifactLifecycleStatus,
  EvidenceKind,
  RuntimeArtifactRef,
  ValidatorResult,
} from "./types.ts";
import {
  evidenceValidatorResult,
  policyValidatorResult,
  schemaValidatorResult,
} from "./validator-results.ts";

export type AcceptTaskRunArtifactInput = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  attempts: number;
  producerAgentSpecRef: string;
  artifactContract: ArtifactContract;
  requiredEvidenceKinds: EvidenceKind[];
  artifact: Record<string, unknown>;
  metrics: unknown;
  now?: string;
};

export type AcceptTaskRunArtifactResult = {
  artifactResourceId: string;
  evidencePacketId: string;
  validatorResultIds: string[];
  accepted: boolean;
  status: ArtifactLifecycleStatus;
  blockingFailures: ValidatorResult[];
};

export function acceptTaskRunArtifact(db: SouthstarDb, input: AcceptTaskRunArtifactInput): AcceptTaskRunArtifactResult {
  const now = input.now ?? new Date().toISOString();
  const artifactResourceId = `artifact-${input.runId}-${input.taskId}-callback`;
  const normalizedArtifact = normalizeArtifactForContract(input.artifact, input.artifactContract);

  const evidencePacket = buildEvidencePacket({
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: artifactResourceId,
    requiredEvidenceKinds: input.requiredEvidenceKinds,
    artifact: normalizedArtifact,
    now,
  });

  const validatorResults = [
    schemaValidatorResult({
      runId: input.runId,
      taskId: input.taskId,
      artifactRef: artifactResourceId,
      contract: input.artifactContract,
      artifact: normalizedArtifact,
      now,
    }),
    evidenceValidatorResult({
      runId: input.runId,
      taskId: input.taskId,
      artifactRef: artifactResourceId,
      contractRef: input.artifactContract.id,
      evidence: evidencePacket,
      now,
    }),
    policyValidatorResult({
      runId: input.runId,
      taskId: input.taskId,
      artifactRef: artifactResourceId,
      contractRef: input.artifactContract.id,
      artifact: normalizedArtifact,
      now,
    }),
  ];

  const blockingFailures = validatorResults.filter((result) => result.blocking && result.verdict === "failed");
  const status: ArtifactLifecycleStatus = blockingFailures.length === 0 ? "accepted" : "needs_repair";

  upsertRuntimeResource(db, {
    id: evidencePacket.id,
    resourceType: "evidence_packet",
    resourceKey: evidencePacket.id,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.rootSessionId,
    scope: "task",
    status: evidencePacket.completeness.missingKinds.length === 0 ? "complete" : "incomplete",
    title: `Evidence for ${input.taskId}`,
    payload: evidencePacket,
    summary: evidencePacket.completeness,
  });

  const validatorResultIds: string[] = [];
  for (const validatorResult of validatorResults) {
    validatorResultIds.push(validatorResult.id);
    upsertRuntimeResource(db, {
      id: validatorResult.id,
      resourceType: "validator_result",
      resourceKey: validatorResult.id,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.rootSessionId,
      scope: "task",
      status: validatorResult.verdict,
      title: validatorResult.validatorRef,
      payload: validatorResult,
      summary: {
        verdict: validatorResult.verdict,
        blocking: validatorResult.blocking,
        messageCount: validatorResult.messages.length,
        repairHint: validatorResult.repairHint,
      },
    });
  }

  const artifactRef: RuntimeArtifactRef = {
    id: artifactResourceId,
    runId: input.runId,
    taskId: input.taskId,
    artifactType: input.artifactContract.artifactType,
    contractRef: input.artifactContract.id,
    producerAgentSpecRef: input.producerAgentSpecRef,
    producerAttemptId: `attempt-${input.attempts}`,
    status,
    summary: typeof normalizedArtifact.summary === "string" ? normalizedArtifact.summary : `${input.taskId} artifact`,
    payloadResourceRef: artifactResourceId,
    evidencePacketRefs: [evidencePacket.id],
    validatorResultRefs: validatorResultIds,
    createdAt: now,
    acceptedAt: status === "accepted" ? now : undefined,
  };

  upsertRuntimeResource(db, {
    id: artifactResourceId,
    resourceType: "artifact",
    resourceKey: artifactResourceId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.rootSessionId,
    scope: "task",
    status,
    title: status === "accepted" ? "Accepted callback artifact" : "Artifact needs repair",
    payload: { artifact: normalizedArtifact, rawArtifact: input.artifact, artifactRef },
    summary: artifactRef,
    metrics: input.metrics,
  });

  return {
    artifactResourceId,
    evidencePacketId: evidencePacket.id,
    validatorResultIds,
    accepted: status === "accepted",
    status,
    blockingFailures,
  };
}

function normalizeArtifactForContract(
  artifact: Record<string, unknown>,
  contract: ArtifactContract,
): Record<string, unknown> {
  const keys = [
    contract.id,
    contract.artifactType,
    contract.id.replace(/-/g, "_"),
    contract.id.replace(/_/g, "-"),
    contract.artifactType.replace(/-/g, "_"),
    contract.artifactType.replace(/_/g, "-"),
  ];
  for (const key of keys) {
    const nested = artifact[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return artifact;
}

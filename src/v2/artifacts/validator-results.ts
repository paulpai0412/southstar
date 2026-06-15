import type { ArtifactContract } from "../domain-packs/types.ts";
import type { EvidencePacket, ValidatorResult } from "./types.ts";
import { VALIDATOR_RESULT_SCHEMA_VERSION } from "./types.ts";

export function schemaValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contract: ArtifactContract;
  artifact: Record<string, unknown>;
  now?: string;
}): ValidatorResult {
  const messages = input.contract.requiredFields
    .filter((field) => !hasRequiredValue(input.artifact[field]))
    .map((field) => ({
      severity: "error" as const,
      path: field,
      text: `Missing required field ${field}`,
    }));
  return {
    schemaVersion: VALIDATOR_RESULT_SCHEMA_VERSION,
    id: `validator-${input.runId}-${input.taskId}-${input.contract.id}-schema`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contract.id}:schema`,
    validatorType: "schema",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contract.id],
    checkedEvidenceRefs: [],
    messages,
    repairHint: messages.length === 0
      ? undefined
      : `Return artifact fields: ${input.contract.requiredFields.join(", ")}`,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function evidenceValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contractRef: string;
  evidence: EvidencePacket;
  now?: string;
}): ValidatorResult {
  const missingMessages = input.evidence.completeness.missingKinds.map((kind) => ({
    severity: "error" as const,
    path: `evidence.${kind}`,
    text: `Missing required ${kind} evidence`,
  }));
  const invalidMessages = input.evidence.evidenceItems
    .filter((item) => item.status === "invalid" || item.status === "stale")
    .map((item) => ({
      severity: "error" as const,
      path: `evidence.${item.kind}`,
      text: `Invalid ${item.kind} evidence: ${item.summary}`,
    }));
  const messages = [...missingMessages, ...invalidMessages];
  return {
    schemaVersion: VALIDATOR_RESULT_SCHEMA_VERSION,
    id: `validator-${input.runId}-${input.taskId}-${input.contractRef}-evidence`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contractRef}:evidence`,
    validatorType: "custom",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contractRef],
    checkedEvidenceRefs: [input.evidence.id],
    messages,
    repairHint: messages.length === 0
      ? undefined
      : "Provide required evidence in artifactEvidence, testResults, filesChanged, or commandsRun.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function policyValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contractRef: string;
  artifact: Record<string, unknown>;
  now?: string;
}): ValidatorResult {
  const messages = policyViolationMessages(JSON.stringify(input.artifact));
  return {
    schemaVersion: VALIDATOR_RESULT_SCHEMA_VERSION,
    id: `validator-${input.runId}-${input.taskId}-${input.contractRef}-policy`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contractRef}:policy`,
    validatorType: "policy",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contractRef],
    checkedEvidenceRefs: [],
    messages,
    repairHint: messages.length === 0
      ? undefined
      : "Remove secret-shaped values and raw transcripts from artifact payload.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}

function hasRequiredValue(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return value !== undefined && value !== null && value !== "";
}

function policyViolationMessages(serializedArtifact: string): ValidatorResult["messages"] {
  if (/sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(serializedArtifact)) {
    return [{
      severity: "error",
      path: "artifact",
      text: "Artifact payload contains token-shaped or private-key-shaped value",
    }];
  }
  if (serializedArtifact.length > 50_000) {
    return [{
      severity: "error",
      path: "artifact",
      text: "Artifact payload exceeds 50000 byte compact history limit",
    }];
  }
  return [];
}

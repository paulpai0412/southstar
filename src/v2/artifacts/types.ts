export const ARTIFACT_EVIDENCE_SCHEMA_VERSION = "southstar.runtime.artifact_ref.v1";
export const ARTIFACT_REF_RESOURCE_TYPE = "artifact_ref";
export const EVIDENCE_PACKET_SCHEMA_VERSION = "southstar.runtime.evidence_packet.v1";
export const VALIDATOR_RESULT_SCHEMA_VERSION = "southstar.runtime.validator_result.v1";
export const DOWNSTREAM_READINESS_SCHEMA_VERSION = "southstar.runtime.downstream_readiness.v1";

export type ArtifactLifecycleStatus =
  | "created"
  | "schema_validated"
  | "evidence_validated"
  | "policy_validated"
  | "accepted"
  | "rejected"
  | "needs_repair";

export type ArtifactRefStatus = "accepted" | "rejected" | "needs_repair";

export type ArtifactRefProducer = {
  actorType: "hand" | "brain" | "tool-proxy" | "evaluator";
  providerId: string;
};

export type ArtifactContentRef = {
  kind: "runtime_resource" | "artifact_blob" | "secure_blob" | "external_url" | "inline_digest";
  ref: string;
  sha256: string;
};

export type ArtifactRefPayload = {
  schemaVersion: typeof ARTIFACT_EVIDENCE_SCHEMA_VERSION;
  artifactRefId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  producer: ArtifactRefProducer;
  artifactType: string;
  status: ArtifactRefStatus;
  contentRef?: ArtifactContentRef;
  contractRefs: string[];
  summary: string;
  failedArtifactRefs?: string[];
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  sourceEventRefs: string[];
  producedAt: string;
};

export type EvidenceKind =
  | "file-diff"
  | "test-result"
  | "command-output"
  | "url"
  | "screenshot"
  | "human-approval"
  | "artifact-ref"
  | "workspace-snapshot"
  | "policy-decision";

export type EvidenceItemStatus = "present" | "missing" | "invalid" | "stale";

export type RuntimeArtifactRef = {
  id: string;
  runId: string;
  taskId: string;
  artifactType: string;
  contractRef: string;
  producerAgentSpecRef: string;
  producerAttemptId: string;
  status: ArtifactLifecycleStatus;
  summary: string;
  payloadResourceRef?: string;
  blobRef?: string;
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
  createdAt: string;
  acceptedAt?: string;
};

export type EvidencePacket = {
  schemaVersion: typeof EVIDENCE_PACKET_SCHEMA_VERSION;
  id: string;
  runId: string;
  taskId: string;
  artifactRef: string;
  evidenceItems: Array<{
    kind: EvidenceKind;
    status: EvidenceItemStatus;
    summary: string;
    sourceRef?: string;
    sha256?: string;
    capturedAt: string;
    reproducibleCommand?: string[];
    redactionApplied: boolean;
  }>;
  completeness: {
    requiredCount: number;
    presentCount: number;
    missingKinds: string[];
  };
};

export type ValidatorResult = {
  schemaVersion: typeof VALIDATOR_RESULT_SCHEMA_VERSION;
  id: string;
  runId: string;
  taskId?: string;
  artifactRef?: string;
  validatorRef: string;
  validatorType: "schema" | "test" | "policy" | "checker-agent" | "human" | "pipeline" | "custom";
  verdict: "passed" | "failed" | "warning" | "skipped";
  blocking: boolean;
  checkedContractRefs: string[];
  checkedEvidenceRefs: string[];
  messages: Array<{ severity: "info" | "warning" | "error"; path?: string; text: string }>;
  metrics?: Record<string, number>;
  rerunCommand?: string[];
  repairHint?: string;
  createdAt: string;
};

export type DownstreamReadiness = {
  schemaVersion: typeof DOWNSTREAM_READINESS_SCHEMA_VERSION;
  runId: string;
  taskId: string;
  ready: boolean;
  blockers: Array<{
    dependencyTaskId: string;
    missingArtifactContractRefs: string[];
    missingEvidenceKinds: string[];
    workspaceStateRequired: boolean;
    workspaceReady: boolean;
  }>;
  checkedAt: string;
};

export type ArtifactEvidenceSummary = {
  artifactRef: string;
  artifactType: string;
  contractRef: string;
  taskId: string;
  status: ArtifactLifecycleStatus;
  summary: string;
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
};

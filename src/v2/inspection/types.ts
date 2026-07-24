export type InspectionHealth = "healthy" | "running" | "blocked" | "failed" | "unknown";

export type InspectionCauseCode =
  | "run_missing"
  | "task_failed"
  | "executor_issue"
  | "artifact_needs_repair"
  | "artifact_rejected"
  | "incomplete_evidence"
  | "blocking_validator_failed"
  | "completed_tasks_gate_failed"
  | "artifact_ref_gate_failed"
  | "evidence_gate_failed"
  | "tool_proxy_violation"
  | "payload_too_large"
  | "stop_condition_failed"
  | "stop_condition_missing"
  | "design_library_lineage_unavailable"
  | "task_stale_or_pending";

export type InspectionCause = {
  code: InspectionCauseCode;
  severity: "blocking" | "warning" | "info";
  taskId?: string;
  resourceRef?: string;
  message: string;
};

export type GateVerdict = {
  verdict: "passed" | "failed" | "not_applicable";
  actual: unknown;
  expected: string;
};

export type RuntimeGateVerdicts = {
  completedTasks: GateVerdict;
  acceptedArtifactsEqualCompletedTasks: GateVerdict;
  acceptedArtifactRefsEqualCompletedTasks: GateVerdict;
  completeEvidenceEqualAcceptedArtifacts: GateVerdict;
  blockingValidatorFailuresZero: GateVerdict;
  blockingToolProxyViolationsZero: GateVerdict;
  stopConditionPassed: GateVerdict;
  payloadSizeWithinLimit: GateVerdict;
};

export type RunInspectionCounts = {
  tasks: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  };
  resources: {
    acceptedArtifacts: number;
    acceptedArtifactRefs: number;
    evidenceRequiredArtifactRefs: number;
    needsRepairArtifacts: number;
    rejectedArtifacts: number;
    handExecutions: number;
    taskExecutionIntents: number;
    blockingToolProxyViolations: number;
    completeEvidencePackets: number;
    incompleteEvidencePackets: number;
    blockingValidatorFailures: number;
    oversizedPayloadRows: number;
  };
};

export type InspectedTask = {
  taskId: string;
  taskKey: string;
  status: string;
  sortOrder: number;
  dependsOn: string[];
  executor: {
    bindingId?: string;
    status?: string;
    executorType?: string;
    externalJobId?: string;
    runnerPhase?: string;
    lastHeartbeatAt?: string;
    issue: "missing_binding" | "timeout" | "orphaned" | "callback_missing" | "none";
  };
  artifact: {
    accepted: number;
    needsRepair: number;
    rejected: number;
    latestStatus?: string;
    resourceRefs: string[];
  };
  evidence: {
    complete: number;
    incomplete: number;
    latestStatus?: string;
    resourceRefs: string[];
    missingKinds: string[];
  };
  validators: {
    passed: number;
    failedBlocking: number;
    failedNonBlocking: number;
    latestFailedBlockingRef?: string;
  };
  causes: InspectionCause[];
};

export type DesignLibraryLineage =
  | {
      available: true;
      compiledFrom: {
        objectKey?: string;
        versionId?: string;
        source?: string;
      };
      sourceObject?: {
        objectId: string;
        objectKey: string;
        objectKind: string;
        status: string;
        headVersionId?: string;
      };
      sourceVersion?: {
        versionId: string;
        definitionKind: string;
        contentHash: string;
      };
      validatedFromRun?: {
        eventRef: string;
        validatedTemplateVersionId: string;
        createdAt: string;
      };
    }
  | {
      available: false;
      reason: "library_tables_missing" | "not_compiled_from_library" | "lineage_not_found";
    };

export type RunInspection = {
  runId: string;
  status: string;
  health: InspectionHealth;
  generatedFrom: {
    workflowManifestPresent: boolean;
    compiledFrom?: {
      objectKey?: string;
      versionId?: string;
      source?: string;
    };
  };
  counts: RunInspectionCounts;
  gates: RuntimeGateVerdicts;
  primaryCause: InspectionCause | null;
  contributingCauses: InspectionCause[];
  designLibrary: DesignLibraryLineage;
  tasks: InspectedTask[];
};

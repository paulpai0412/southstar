import { redactSecrets } from "../../src/runtime/redaction.ts";

export type OpenCodeFaultKind =
  | "verifier_failure"
  | "timeout"
  | "empty_response"
  | "malformed_artifact"
  | "lost_child_artifact";

export interface OpenCodeFaultEvidence {
  kind: OpenCodeFaultKind;
  issue_id?: string;
  child_run_id?: string;
  retryable: boolean;
  terminal: boolean;
  summary: string;
  artifact_valid?: boolean;
}

export function createOpenCodeVerifierFailure(issueId: string): OpenCodeFaultEvidence {
  return {
    kind: "verifier_failure",
    issue_id: issueId,
    retryable: false,
    terminal: true,
    summary: "OpenCode verifier rejected deterministic evidence",
  };
}

export function createOpenCodeTimeoutFault(childRunId: string): OpenCodeFaultEvidence {
  return compactFault({
    kind: "timeout",
    child_run_id: childRunId,
    retryable: true,
    terminal: false,
    summary: `OpenCode child ${childRunId} exceeded deterministic timeout`,
  });
}

export function createOpenCodeEmptyResponseFault(childRunId: string): OpenCodeFaultEvidence {
  return compactFault({
    kind: "empty_response",
    child_run_id: childRunId,
    retryable: true,
    terminal: false,
    summary: `OpenCode child ${childRunId} returned empty response`,
  });
}

export function createOpenCodeMalformedArtifact(childRunId: string): OpenCodeFaultEvidence {
  return compactFault({
    kind: "malformed_artifact",
    child_run_id: childRunId,
    retryable: true,
    terminal: false,
    artifact_valid: false,
    summary: `OpenCode child ${childRunId} returned malformed artifact`,
  });
}

export function createOpenCodeLostChildArtifact(childRunId: string): OpenCodeFaultEvidence {
  return compactFault({
    kind: "lost_child_artifact",
    child_run_id: childRunId,
    retryable: true,
    terminal: false,
    summary: `OpenCode child artifact arrived for unknown child ${childRunId}`,
  });
}

function compactFault(fault: OpenCodeFaultEvidence): OpenCodeFaultEvidence {
  return {
    ...fault,
    summary: redactSecrets(fault.summary).slice(0, 240),
  };
}

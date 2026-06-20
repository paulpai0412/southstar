export type ManagedAgentEndStateInput = {
  acceptedArtifactRefs: string[];
  finalReportArtifactRefs: string[];
  activeHandBindings: string[];
  unresolvedEvaluatorFindings: string[];
  toolEfficiency: { toolCalls: number; maxToolCalls: number };
  securityFindings: string[];
};

export type ManagedAgentEndStateResult = {
  ok: boolean;
  findings: string[];
};

export function evaluateManagedAgentEndState(input: ManagedAgentEndStateInput): ManagedAgentEndStateResult {
  const findings: string[] = [];
  const missingFinalRefs = input.acceptedArtifactRefs.filter((ref) => !input.finalReportArtifactRefs.includes(ref));
  if (missingFinalRefs.length > 0) {
    findings.push(`final report missing accepted artifact refs: ${missingFinalRefs.join(", ")}`);
  }
  if (input.activeHandBindings.length > 0) {
    findings.push(`active orphan hand bindings: ${input.activeHandBindings.join(", ")}`);
  }
  if (input.unresolvedEvaluatorFindings.length > 0) {
    findings.push(`unresolved evaluator findings: ${input.unresolvedEvaluatorFindings.join(", ")}`);
  }
  if (input.toolEfficiency.toolCalls > input.toolEfficiency.maxToolCalls) {
    findings.push(`tool call budget exceeded: ${input.toolEfficiency.toolCalls} > ${input.toolEfficiency.maxToolCalls}`);
  }
  if (input.securityFindings.length > 0) {
    findings.push(`security findings: ${input.securityFindings.join(", ")}`);
  }
  return { ok: findings.length === 0, findings };
}

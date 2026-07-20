export const CANONICAL_DIAGNOSTIC_CODES = {
  goalDesignPackageRequired: "canonical_goal_design_package_required",
  goalDesignPackageInvalid: "canonical_goal_design_package_invalid",
  goalRequirementCoverageMissing: "canonical_goal_requirement_coverage_missing",
  goalRequirementCoverageInvalid: "canonical_goal_requirement_coverage_invalid",
  criterionCoverageRequired: "canonical_criterion_coverage_required",
  requirementEvaluatorResultIncompatible: "canonical_requirement_evaluator_result_incompatible",
  goalRequirementInterpreterNotConfigured: "goal_requirement_interpreter_not_configured",
} as const;

export type CanonicalDiagnosticCode = typeof CANONICAL_DIAGNOSTIC_CODES[keyof typeof CANONICAL_DIAGNOSTIC_CODES];

export type CanonicalDiagnostic = {
  code: CanonicalDiagnosticCode;
  message: string;
};

export class CanonicalDiagnosticError extends Error {
  readonly status = 409;

  constructor(readonly code: CanonicalDiagnosticCode, detail: string) {
    super(`${code}: ${detail}`);
  }
}

export function canonicalDiagnostic(code: CanonicalDiagnosticCode, detail: string): CanonicalDiagnostic {
  return { code, message: `${code}: ${detail}` };
}

export function canonicalDiagnosticCode(value: unknown): CanonicalDiagnosticCode | undefined {
  return typeof value === "string" && Object.values(CANONICAL_DIAGNOSTIC_CODES).includes(value as CanonicalDiagnosticCode)
    ? value as CanonicalDiagnosticCode
    : undefined;
}

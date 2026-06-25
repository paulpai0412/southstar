import type { SouthstarDb } from "../db/postgres.ts";
import { createRuntimeExceptionController } from "../exceptions/runtime-exception-controller.ts";
import type {
  DispatchPreparationExceptionObservationInput,
  DispatchPreparationExceptionObservationResult,
  RecoveryPath,
  RuntimeExceptionClassification,
} from "../exceptions/types.ts";

const PROVIDER_ERROR_EXCERPT_LIMIT = 500;
const COMMON_TOKEN_REDACTION_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;
const CREDENTIAL_KEY_PATTERN = "(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)";
const DOUBLE_QUOTED_CREDENTIAL_FIELD_REDACTION_PATTERN = new RegExp(`((?:["']?${CREDENTIAL_KEY_PATTERN}["']?\\s*[=:]\\s*))"[^"]*"`, "gi");
const SINGLE_QUOTED_CREDENTIAL_FIELD_REDACTION_PATTERN = new RegExp(`((?:["']?${CREDENTIAL_KEY_PATTERN}["']?\\s*[=:]\\s*))'[^']*'`, "gi");
const AUTHORIZATION_VALUE_REDACTION_PATTERN = /((?:["']?AUTHORIZATION["']?\s*[=:]\s*))(?!["'])(?:Bearer\s+)?[^\s,;}\]]+(?:\s+[^\s,;}\]]+)?/gi;
const UNQUOTED_CREDENTIAL_FIELD_REDACTION_PATTERN = new RegExp(`((?:["']?${CREDENTIAL_KEY_PATTERN}["']?\\s*[=:]\\s*))(?!["'])[^\s,;}\\]]+`, "gi");
const DISPATCH_PREPARATION_RECOVERY_PATH: RecoveryPath = "retry-same-task-new-attempt";

export async function observeDispatchPreparationException(
  db: SouthstarDb,
  input: DispatchPreparationExceptionObservationInput,
): Promise<DispatchPreparationExceptionObservationResult> {
  const controller = createRuntimeExceptionController({ db });
  const exception = await controller.observe({
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    source: "scheduler",
    kind: "dispatch_preparation_failed",
    severity: "recoverable",
    observedAt: new Date().toISOString(),
    evidenceRefs: [input.recoveryKey],
    providerEvidence: { errorExcerpt: redactProviderErrorExcerpt(input.errorMessage) },
  });
  const classification = normalizeDispatchPreparationClassification(await controller.classify(exception));
  const decision = await controller.decide(classification);
  return { exception, decision };
}

export function redactProviderErrorExcerpt(errorMessage: string): string {
  return errorMessage
    .replace(COMMON_TOKEN_REDACTION_PATTERN, "[REDACTED]")
    .replace(DOUBLE_QUOTED_CREDENTIAL_FIELD_REDACTION_PATTERN, "$1\"[REDACTED]\"")
    .replace(SINGLE_QUOTED_CREDENTIAL_FIELD_REDACTION_PATTERN, "$1'[REDACTED]'")
    .replace(AUTHORIZATION_VALUE_REDACTION_PATTERN, "$1[REDACTED]")
    .replace(UNQUOTED_CREDENTIAL_FIELD_REDACTION_PATTERN, "$1[REDACTED]")
    .slice(0, PROVIDER_ERROR_EXCERPT_LIMIT);
}

function normalizeDispatchPreparationClassification(classification: RuntimeExceptionClassification): RuntimeExceptionClassification {
  const recoveryPath = classification.recoveryPath as unknown;
  if (typeof recoveryPath === "string" && recoveryPath.length > 0) return classification;
  return {
    ...classification,
    recoveryPath: DISPATCH_PREPARATION_RECOVERY_PATH,
    operatorApprovalRequired: false,
    reason: `${classification.payload.kind} classified for ${DISPATCH_PREPARATION_RECOVERY_PATH}`,
  };
}

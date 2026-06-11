import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../types/control-plane.ts";
import type {
  ExceptionPolicyActionDefinition,
  ExceptionPolicyRuleDefinition,
  WorkflowDefinition,
} from "../types/workflow.ts";

export interface ResolveExceptionOptions {
  maxRecoveryAttempts: number;
  now: string;
}

export interface ResolveExceptionResult {
  snapshot: IssueSnapshot;
  history: HistoryEntry[];
}

export function resolveExceptionPolicy(
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  options: ResolveExceptionOptions,
): ResolveExceptionResult {
  const next = structuredClone(snapshot) as IssueSnapshot;
  if (next.lifecycle_state !== "exception") {
    return { snapshot: next, history: [] };
  }

  const exception = exceptionRecord(next);
  const rule = verifierReleaseOwnedFailureRule(exception, workflow)
    ?? firstMatchingRule(workflow.exception_policy?.rules ?? [], exception);
  const baseAction = rule?.action ?? workflow.exception_policy?.default.action ?? { type: "quarantine" as const };
  const attemptCount = numberValue(exception.attempt_count);
  const exhausted = attemptCount >= options.maxRecoveryAttempts;
  const action = exhausted && rule?.on_exhausted
    ? exhaustedAction(rule.on_exhausted.type)
    : baseAction;

  applyAction(next, workflow, action, exception);
  next.runtime_context_json.exception = {
    ...next.runtime_context_json.exception,
    state: "resolved",
    last_reconciled_at: options.now,
    resolved_action: action.type,
    exhausted,
  };

  return {
    snapshot: next,
    history: [
      {
        event_type: "exception_resolved",
        payload: {
          exception_id: stringValue(exception.id, "unknown-exception"),
          rule: rule?.name ?? "default",
          action: action.type,
          exhausted,
          source_stage: exception.source_stage,
          target_stage: action.target_stage,
        },
      },
    ],
  };
}

function firstMatchingRule(
  rules: ExceptionPolicyRuleDefinition[],
  exception: Record<string, unknown>,
): ExceptionPolicyRuleDefinition | undefined {
  return rules.find((rule) =>
    Object.entries(rule.match).every(([field, expected]) => exception[field] === expected));
}

function applyAction(
  snapshot: IssueSnapshot,
  workflow: WorkflowDefinition,
  action: ExceptionPolicyActionDefinition,
  exception: Record<string, unknown>,
): void {
  delete snapshot.current_session_id;
  delete snapshot.runtime_context_json.owner_lease;

  if (action.type === "quarantine") {
    snapshot.lifecycle_state = "quarantined";
    return;
  }

  if (action.type === "fail") {
    snapshot.lifecycle_state = "failed";
    return;
  }

  const targetStage = action.type === "retry_same_stage"
    ? stringValue(exception.source_stage, "")
    : action.target_stage ?? "";
  const stage = workflow.stages[targetStage];
  if (!stage) {
    snapshot.lifecycle_state = "quarantined";
    return;
  }

  snapshot.runtime_context_json.stage_cursor = targetStage;
  if (
    isRuntimeInvariantRetry(action, exception) ||
    restartsFirstStage(action, workflow, targetStage) ||
    routesThroughWorkerDispatch(workflow, targetStage)
  ) {
    snapshot.lifecycle_state = "ready";
    snapshot.runtime_context_json.child_runs = [];
  } else {
    snapshot.lifecycle_state = stage.lifecycle_state as LifecycleState;
  }

  if (action.type === "return_to_stage" && action.carry_forward) {
    const payload = objectValue(exception.payload);
    const carry: Record<string, unknown> = {};
    for (const field of action.carry_forward) {
      if (payload[field] !== undefined) {
        carry[field] = payload[field];
      } else if (field === "feedback_for_implementation") {
        const synthesized = synthesizeImplementationFeedback(exception, payload);
        if (synthesized.length > 0) carry[field] = synthesized;
      }
    }
    snapshot.runtime_context_json.exception_carry_forward = carry;
  }
}

function verifierReleaseOwnedFailureRule(
  exception: Record<string, unknown>,
  workflow: WorkflowDefinition,
): ExceptionPolicyRuleDefinition | undefined {
  const payload = objectValue(exception.payload);
  const releaseStage = Object.entries(workflow.stages)
    .find(([, stage]) => stage.lifecycle_state === "releasing" || stage.lifecycle_state === "release_pending")?.[0];
  if (
    releaseStage &&
    exception.source_stage === "verification" &&
    exception.artifact_kind === "verification_result" &&
    exception.status === "failed_retryable" &&
    payload.failure_owner === "release"
  ) {
    return {
      name: "verification_release_owned_failure_routes_to_release",
      match: {},
      action: {
        type: "return_to_stage",
        target_stage: releaseStage,
        carry_forward: ["feedback_for_release"],
      },
      on_exhausted: { type: "quarantine" },
    };
  }
  return undefined;
}

function isRuntimeInvariantRetry(
  action: ExceptionPolicyActionDefinition,
  exception: Record<string, unknown>,
): boolean {
  return action.type === "retry_same_stage" && exception.category === "runtime_invariant";
}

function routesThroughWorkerDispatch(workflow: WorkflowDefinition, targetStage: string): boolean {
  const lifecycle = workflow.stages[targetStage]?.lifecycle_state;
  return lifecycle === "releasing" || lifecycle === "release_pending";
}

function restartsFirstStage(
  action: ExceptionPolicyActionDefinition,
  workflow: WorkflowDefinition,
  targetStage: string,
): boolean {
  return (action.type === "retry_stage" || action.type === "return_to_stage") && targetStage === Object.keys(workflow.stages)[0];
}

function exhaustedAction(type: "quarantine" | "fail"): ExceptionPolicyActionDefinition {
  return {
    type: type === "quarantine" ? "quarantine" : "fail",
  };
}

function exceptionRecord(snapshot: IssueSnapshot): Record<string, unknown> {
  const value = snapshot.runtime_context_json.exception;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : 0;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0
    ? value
    : fallback;
}

function synthesizeImplementationFeedback(
  exception: Record<string, unknown>,
  payload: Record<string, unknown>,
): string[] {
  const feedback: string[] = [];
  const summary = sanitizedString(payload.summary) || sanitizedString(exception.summary);
  if (summary) feedback.push(summary);

  for (const finding of reviewFindings(payload.review)) {
    const text = findingSummary(finding);
    if (text) feedback.push(text);
  }

  return feedback;
}

function reviewFindings(value: unknown): Record<string, unknown>[] {
  const review = objectValue(value);
  const findings = review.findings;
  return Array.isArray(findings)
    ? findings.filter((finding): finding is Record<string, unknown> =>
      typeof finding === "object" && finding !== null && !Array.isArray(finding))
    : [];
}

function findingSummary(finding: Record<string, unknown>): string {
  const summary = sanitizedString(finding.summary) || sanitizedString(finding.message);
  if (!summary) return "";
  const severity = sanitizedString(finding.severity);
  const area = sanitizedString(finding.area) || sanitizedString(finding.category);
  const prefix = [
    severity ? `[${severity}]` : "",
    area ? `${area}:` : "",
  ].filter(Boolean).join(" ");
  return prefix ? `${prefix} ${summary}` : summary;
}

function sanitizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

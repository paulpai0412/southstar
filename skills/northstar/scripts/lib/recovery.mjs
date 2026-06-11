export const recoveryRiskPolicy = Object.freeze({
  low: Object.freeze({
    confirmation: "auto",
    actions: Object.freeze(["inspect", "reconcile", "projection_retry"]),
  }),
  medium: Object.freeze({
    confirmation: "confirm",
    actions: Object.freeze(["repair_runtime", "create_pr", "update_runtime_metadata", "release"]),
  }),
  high: Object.freeze({
    confirmation: "second_confirmation",
    actions: Object.freeze(["force_push", "delete_branch", "merge", "close_pr", "rewrite_runtime_metadata"]),
  }),
});

const actionRisk = new Map(
  Object.entries(recoveryRiskPolicy).flatMap(([risk, policy]) => policy.actions.map((action) => [action, risk])),
);

const defaultNow = "1970-01-01T00:00:00.000Z";

export function recoveryRiskForAction(action) {
  const normalizedAction = typeof action === "string" && action.trim() !== "" ? action : "unknown";
  const risk = actionRisk.get(normalizedAction) ?? "high";

  return {
    action: normalizedAction,
    risk,
    confirmation: recoveryRiskPolicy[risk].confirmation,
  };
}

export function diagnoseRecovery(input = {}) {
  if (isSimpleRecoveryInput(input)) {
    return diagnoseSimpleInput(input);
  }

  const issues = Array.isArray(input.issues) ? input.issues : input.issue ? [input.issue] : [];
  const now = normalizeNow(input.now);
  const configPath = normalizeConfigPath(input.configPath);

  return issues.flatMap((issue) => diagnoseIssue(issue, now, configPath));
}

export function recoveryReport(input) {
  if (isDiagnosisInput(input)) {
    const diagnoses = normalizeDiagnosisInput(input);
    return {
      text: diagnoses.map(recoveryDiagnosisText).join("\n\n"),
      diagnoses,
    };
  }

  if (isSimpleRecoveryInput(input)) {
    const diagnosis = diagnoseSimpleInput(input);
    return {
      text: recoveryReportText(diagnosis, commandPlan("inspect", diagnosis.issue, [], normalizeConfigPath(input.configPath))),
      diagnoses: [diagnosis],
    };
  }

  const diagnoses = diagnoseRecovery(input);

  return {
    text: diagnoses.map(recoveryDiagnosisText).join("\n\n"),
    diagnoses,
  };
}

function diagnoseSimpleInput(input) {
  const issueNumber = input.issue ?? input.issue_number ?? "unknown";
  const state = String(input.lifecycle ?? input.lifecycle_state ?? input.state ?? "unknown");
  const configPath = normalizeConfigPath(input.configPath);

  if (state === "quarantined" && input.leaseExpired === true) {
    return newSimpleDiagnosis({
      issueNumber,
      state,
      diagnosis: "expired lease",
      action: "repair_runtime",
      commandPlan: commandPlan("repair-runtime", issueNumber, [], configPath),
    });
  }

  if (state === "failed") {
    return newSimpleDiagnosis({
      issueNumber,
      state,
      diagnosis: "failed",
      action: "inspect",
      commandPlan: commandPlan("inspect", issueNumber, [], configPath),
    });
  }

  if (state === "running" && input.projectionRetryable === true) {
    return newSimpleDiagnosis({
      issueNumber,
      state,
      diagnosis: "retryable projection",
      action: "projection_retry",
      commandPlan: commandPlan("retry-sync", issueNumber, [], configPath),
    });
  }

  if (state === "running" && input.branchExists === true && input.prExists === false) {
    return newSimpleDiagnosis({
      issueNumber,
      state,
      diagnosis: "branch without pr",
      action: "create_pr",
      commandPlan: commandPlan("start", issueNumber, [], configPath),
    });
  }

  if (state === "running" && input.prExists === true && input.runtimeHasPr === false) {
    return newSimpleDiagnosis({
      issueNumber,
      state,
      diagnosis: "pr without runtime metadata",
      action: "update_runtime_metadata",
      commandPlan: commandPlan("reconcile", issueNumber, [], configPath),
    });
  }

  if (state === "verified" && input.autoRelease === true) {
    return newSimpleDiagnosis({
      issueNumber,
      state,
      diagnosis: "verified auto release",
      action: "release",
      commandPlan: commandPlan("release", issueNumber, [], configPath),
    });
  }

  return {
    issue: issueNumber,
    issue_number: issueNumber,
    state,
    diagnosis: "none",
    message: "none",
    detected: false,
    requiresConfirmation: false,
    action: "inspect",
    ...recoveryRiskForAction("inspect"),
    commandPlan: commandPlan("inspect", issueNumber, [], configPath),
  };
}

function newSimpleDiagnosis({ issueNumber, state, diagnosis, action, commandPlan }) {
  const risk = recoveryRiskForAction(action);

  return {
    issue: issueNumber,
    issue_number: issueNumber,
    state,
    diagnosis,
    message: diagnosis,
    detected: true,
    requiresConfirmation: risk.confirmation !== "auto",
    action,
    risk: risk.risk,
    confirmation: risk.confirmation,
    commandPlan,
  };
}

function recoveryReportText(diagnosis, precheckCommandPlan) {
  const lines = [
    `issue: #${diagnosis.issue}`,
    `state: ${diagnosis.state}`,
    `diagnosis: ${diagnosis.diagnosis}`,
    `requires_confirmation: ${diagnosis.requiresConfirmation ? "yes" : "no"}`,
  ];

  if (precheckCommandPlan.text !== diagnosis.commandPlan.text) {
    lines.push(`precheck_command: ${precheckCommandPlan.text}`);
  }

  lines.push(`recovery_command: ${diagnosis.commandPlan.text}`);

  return lines.join("\n");
}

function recoveryDiagnosisText(diagnosis) {
  return [
    `Issue: ${diagnosis.issue_number}`,
    `State: ${diagnosis.state}`,
    `Diagnosis: ${diagnosis.diagnosis}`,
    `Confirmation: ${diagnosis.confirmation}`,
    `Command Plan: ${diagnosis.commandPlan.text}`,
  ].join("\n");
}

function isDiagnosisInput(input) {
  if (Array.isArray(input)) {
    return input.every(isDiagnosis);
  }

  return isDiagnosis(input);
}

function normalizeDiagnosisInput(input) {
  return Array.isArray(input) ? input : [input];
}

function isDiagnosis(input) {
  return input
    && typeof input === "object"
    && !Array.isArray(input)
    && typeof input.diagnosis === "string"
    && input.commandPlan
    && typeof input.commandPlan === "object"
    && typeof input.commandPlan.text === "string";
}

function isSimpleRecoveryInput(input) {
  return input
    && typeof input === "object"
    && !Array.isArray(input)
    && (
      typeof input.issue === "number"
      || typeof input.issue === "string"
      || Object.hasOwn(input, "lifecycle")
      || Object.hasOwn(input, "leaseExpired")
      || Object.hasOwn(input, "projectionRetryable")
      || Object.hasOwn(input, "branchExists")
      || Object.hasOwn(input, "prExists")
      || Object.hasOwn(input, "runtimeHasPr")
      || Object.hasOwn(input, "autoRelease")
    );
}

function diagnoseIssue(issue, now, configPath) {
  if (!issue || typeof issue !== "object") {
    return [];
  }

  const issueNumber = normalizeIssueNumber(issue);
  const state = String(issue.lifecycle_state ?? issue.state ?? "unknown");
  const runtimeContext = objectOrEmpty(issue.runtime_context_json);
  const diagnoses = [];

  if (state === "quarantined" && leaseExpired(runtimeContext.owner_lease, now)) {
    diagnoses.push(newDiagnosis({
      issueNumber,
      state,
      diagnosis: "quarantined_expired_lease",
      action: "repair_runtime",
      commandPlan: commandPlan("repair-runtime", issueNumber, [], configPath),
      detail: "Quarantined issue has an expired owner lease and needs operator-confirmed runtime repair.",
    }));
  }

  if (state === "failed") {
    diagnoses.push(newDiagnosis({
      issueNumber,
      state,
      diagnosis: "failed",
      action: "inspect",
      commandPlan: commandPlan("inspect", issueNumber, [], configPath),
      detail: "Issue is terminally failed; inspect before selecting a recovery path.",
    }));
  }

  for (const projection of retryableProjectionFailures(runtimeContext, now)) {
    diagnoses.push(newDiagnosis({
      issueNumber,
      state,
      diagnosis: "retryable_projection_failure",
      action: "projection_retry",
      commandPlan: commandPlan("retry-sync", issueNumber, ["--projection", String(projection.projection_target)], configPath),
      detail: `Projection ${String(projection.projection_target)} failed and is ready for retry.`,
    }));
  }

  if (hasBranch(issue, runtimeContext) && !hasPullRequest(issue, runtimeContext)) {
    diagnoses.push(newDiagnosis({
      issueNumber,
      state,
      diagnosis: "branch_without_pr",
      action: "create_pr",
      commandPlan: commandPlan("start", issueNumber, [], configPath),
      detail: "Issue branch exists without an associated pull request.",
    }));
  }

  const prNumber = externalPullRequestNumber(issue);
  if (prNumber !== undefined && runtimePullRequestNumber(runtimeContext) === undefined) {
    diagnoses.push(newDiagnosis({
      issueNumber,
      state,
      diagnosis: "pr_without_runtime_metadata",
      action: "update_runtime_metadata",
      commandPlan: commandPlan("reconcile", issueNumber, ["--pr", String(prNumber)], configPath),
      detail: "Pull request exists but runtime metadata does not record it.",
    }));
  }

  if (state === "verified" && autoReleaseEnabled(issue, runtimeContext)) {
    const releasePrNumber = prNumber ?? runtimePullRequestNumber(runtimeContext);
    diagnoses.push(newDiagnosis({
      issueNumber,
      state,
      diagnosis: "verified_auto_release",
      action: "release",
      commandPlan: commandPlan("release", issueNumber, releasePrNumber === undefined ? [] : ["--pr", String(releasePrNumber)], configPath),
      detail: "Issue is verified with auto-release enabled.",
    }));
  }

  return diagnoses;
}

function newDiagnosis({ issueNumber, state, diagnosis, action, commandPlan, detail }) {
  return {
    issue_number: issueNumber,
    state,
    diagnosis,
    action,
    detail,
    ...recoveryRiskForAction(action),
    commandPlan,
  };
}

function commandPlan(intent, issueNumber, extraArgs = [], configPath) {
  const argv = ["northstar", intent];
  if (configPath) {
    argv.push("--config", configPath);
  }
  argv.push("--issue", String(issueNumber), ...extraArgs);
  return {
    argv,
    text: argv.join(" "),
  };
}

function normalizeIssueNumber(issue) {
  return issue.issue_number ?? issue.issue_id ?? issue.number ?? "unknown";
}

function normalizeNow(now) {
  return typeof now === "string" && !Number.isNaN(Date.parse(now)) ? now : defaultNow;
}

function normalizeConfigPath(configPath) {
  return typeof configPath === "string" && configPath.trim() !== "" ? configPath : ".northstar.yaml";
}

function objectOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

function leaseExpired(lease, now) {
  if (!lease || typeof lease !== "object" || typeof lease.expires_at !== "string") {
    return false;
  }

  const expiresAt = Date.parse(lease.expires_at);
  const nowTime = Date.parse(now);
  return !Number.isNaN(expiresAt) && !Number.isNaN(nowTime) && expiresAt <= nowTime;
}

function retryableProjectionFailures(runtimeContext, now) {
  const projectionSync = Array.isArray(runtimeContext.projection_sync) ? runtimeContext.projection_sync : [];
  const nowTime = Date.parse(now);

  return projectionSync.filter((projection) => {
    if (!projection || typeof projection !== "object" || projection.status !== "failed") {
      return false;
    }

    if (projection.next_retry_at === undefined) {
      return true;
    }

    const nextRetryAt = Date.parse(String(projection.next_retry_at));
    return !Number.isNaN(nextRetryAt) && !Number.isNaN(nowTime) && nextRetryAt <= nowTime;
  });
}

function hasBranch(issue, runtimeContext) {
  return nonEmptyString(issue.branch)
    || nonEmptyString(issue.head_ref)
    || nonEmptyString(issue.worktree_branch)
    || nonEmptyString(runtimeContext.branch)
    || nonEmptyString(runtimeContext.head_ref)
    || nonEmptyString(runtimeContext.worktree_branch);
}

function hasPullRequest(issue, runtimeContext) {
  return externalPullRequestNumber(issue) !== undefined || runtimePullRequestNumber(runtimeContext) !== undefined;
}

function externalPullRequestNumber(issue) {
  if (positiveIntegerLike(issue.pr_number)) {
    return Number(issue.pr_number);
  }

  if (positiveIntegerLike(issue.pull_request?.number)) {
    return Number(issue.pull_request.number);
  }

  if (positiveIntegerLike(issue.pr?.number)) {
    return Number(issue.pr.number);
  }

  return undefined;
}

function runtimePullRequestNumber(runtimeContext) {
  if (positiveIntegerLike(runtimeContext.pr_number)) {
    return Number(runtimeContext.pr_number);
  }

  if (positiveIntegerLike(runtimeContext.pull_request?.number)) {
    return Number(runtimeContext.pull_request.number);
  }

  if (positiveIntegerLike(runtimeContext.github?.pr_number)) {
    return Number(runtimeContext.github.pr_number);
  }

  return undefined;
}

function autoReleaseEnabled(issue, runtimeContext) {
  return issue.auto_release === true
    || runtimeContext.auto_release === true
    || runtimeContext.release?.auto_release === true
    || runtimeContext.runtime?.auto_release === true;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function positiveIntegerLike(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    || typeof value === "string" && /^[1-9]\d*$/.test(value);
}

import test from "node:test";
import assert from "node:assert/strict";
import { resolveExceptionPolicy } from "../../src/runtime/exception-policy.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import type { WorkflowDefinition } from "../../src/types/workflow.ts";

const workflow: WorkflowDefinition = {
  id: "issue_to_pr_release",
  version: "2.0",
  domain: "software_development",
  roles: {
    implementation_agent: {
      run_mode: "background_child",
      agent: "build",
      load_skills: [],
      artifact: "implementation_result",
      timeout_seconds: 30,
    },
    verifier_agent: {
      run_mode: "background_child",
      agent: "review",
      load_skills: [],
      artifact: "verification_result",
      timeout_seconds: 30,
    },
    release_agent: {
      run_mode: "background_child",
      agent: "release",
      load_skills: [],
      artifact: "release_result",
      timeout_seconds: 30,
    },
  },
  stages: {
    implementation: {
      lifecycle_state: "running",
      role: "implementation_agent",
      on_success: "verification",
    },
    verification: {
      lifecycle_state: "verifying",
      role: "verifier_agent",
      on_success: "verified",
    },
    release: {
      lifecycle_state: "release_pending",
      role: "release_agent",
      on_success: "completed",
    },
  },
  exception_policy: {
    rules: [
      {
        name: "verification_retryable_returns_to_implementation",
        match: {
          source_stage: "verification",
          artifact_kind: "verification_result",
          status: "failed_retryable",
        },
        action: {
          type: "return_to_stage",
          target_stage: "implementation",
          carry_forward: ["feedback_for_implementation"],
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "release_retryable_retries_release",
        match: {
          source_stage: "release",
          artifact_kind: "release_result",
          status: "failed_retryable",
        },
        action: {
          type: "retry_stage",
          target_stage: "release",
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "runtime_invariant_missing_child_run_retries_stage",
        match: {
          category: "runtime_invariant",
          summary: "active_issue_missing_child_run",
        },
        action: {
          type: "retry_same_stage",
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "runtime_invariant_invalid_owner_lease_retries_stage",
        match: {
          category: "runtime_invariant",
          summary: "active_issue_invalid_owner_lease",
        },
        action: {
          type: "retry_same_stage",
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "runtime_invariant_host_liveness_loss_retries_stage",
        match: {
          category: "runtime_invariant",
          summary: "host_liveness_lost",
        },
        action: {
          type: "retry_same_stage",
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "worker_artifact_rejected_retries_implementation",
        match: {
          category: "runtime_invariant",
          summary: "worker_artifact_rejected_retryable",
        },
        action: {
          type: "retry_same_stage",
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "verifier_artifact_rejected_returns_to_implementation",
        match: {
          category: "runtime_invariant",
          summary: "artifact_rejected_retryable",
        },
        action: {
          type: "return_to_stage",
          target_stage: "implementation",
          carry_forward: ["error"],
        },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "blocked_requires_operator",
        match: {
          status: "blocked",
        },
        action: {
          type: "quarantine",
        },
      },
    ],
    default: {
      action: {
        type: "quarantine",
      },
    },
  },
};

test("exception resolver returns verification retryable failures to implementation", () => {
  const snapshot = newIssueSnapshot("github:7", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-1",
        source_stage: "verification",
        source_lifecycle: "verifying",
        source_role: "verifier_agent",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        category: "agent_reported_failure",
        severity: "retryable",
        retryable: true,
        attempt_count: 1,
        payload: { feedback_for_implementation: ["fix filter behavior"] },
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    feedback_for_implementation: ["fix filter behavior"],
  });
  assert.equal(result.history.at(-1)?.event_type, "exception_resolved");
});

test("exception resolver routes verifier release-owned readiness failures to release", () => {
  const snapshot = newIssueSnapshot("github:7-release", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-release-readiness",
        source_stage: "verification",
        source_lifecycle: "verifying",
        source_role: "verifier_agent",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        category: "agent_reported_failure",
        severity: "retryable",
        retryable: true,
        attempt_count: 1,
        payload: {
          failure_owner: "release",
          feedback_for_release: ["Update PR branch northstar/7 onto current main so GitHub reports it mergeable."],
          workspace_evidence: {
            matches_expected: true,
          },
        },
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "release");
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    feedback_for_release: ["Update PR branch northstar/7 onto current main so GitHub reports it mergeable."],
  });
  assert.equal(result.history.at(-1)?.payload.rule, "verification_release_owned_failure_routes_to_release");
});

test("exception resolver synthesizes implementation feedback from verifier failure details", () => {
  const snapshot = newIssueSnapshot("github:7b", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-1b",
        source_stage: "verification",
        source_lifecycle: "verifying",
        source_role: "verifier_agent",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        category: "agent_reported_failure",
        severity: "retryable",
        retryable: true,
        summary: "Verification failed because npm run build failed and workspace evidence did not match PR head.",
        attempt_count: 1,
        payload: {
          review: {
            findings: [
              {
                severity: "high",
                area: "build",
                summary: "npm run build fails because React type declarations are missing.",
              },
              {
                severity: "medium",
                category: "workspace_evidence",
                message: "Observed branch main instead of northstar/7.",
              },
            ],
          },
        },
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    feedback_for_implementation: [
      "Verification failed because npm run build failed and workspace evidence did not match PR head.",
      "[high] build: npm run build fails because React type declarations are missing.",
      "[medium] workspace_evidence: Observed branch main instead of northstar/7.",
    ],
  });
});

test("exception resolver exhausts retry budget to quarantined", () => {
  const snapshot = newIssueSnapshot("github:8", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-2",
        source_stage: "release",
        source_lifecycle: "release_pending",
        source_role: "release_agent",
        artifact_kind: "release_result",
        status: "failed_retryable",
        category: "agent_reported_failure",
        severity: "retryable",
        retryable: true,
        attempt_count: 2,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "quarantined");
  assert.equal(result.history.at(-1)?.event_type, "exception_resolved");
  assert.equal(result.history.at(-1)?.payload.exhausted, true);
});

test("exception resolver returns missing child-run invariant to ready for redispatch before exhaustion", () => {
  const snapshot = newIssueSnapshot("github:8b", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-missing-child-1",
        source_stage: "implementation",
        source_lifecycle: "running",
        source_role: "implementation_agent",
        category: "runtime_invariant",
        severity: "retryable",
        retryable: true,
        summary: "active_issue_missing_child_run",
        attempt_count: 1,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.equal(result.history.at(-1)?.payload.rule, "runtime_invariant_missing_child_run_retries_stage");
  assert.equal(result.history.at(-1)?.payload.action, "retry_same_stage");
  assert.equal(result.history.at(-1)?.payload.exhausted, false);
});

test("exception resolver returns invalid owner lease invariant to ready for redispatch", () => {
  const snapshot = newIssueSnapshot("github:8d", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-owner-lease-1",
        source_stage: "implementation",
        source_lifecycle: "running",
        source_role: "implementation_agent",
        category: "runtime_invariant",
        severity: "retryable",
        retryable: true,
        summary: "active_issue_invalid_owner_lease",
        attempt_count: 1,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.equal(result.history.at(-1)?.payload.rule, "runtime_invariant_invalid_owner_lease_retries_stage");
});

test("exception resolver returns host liveness loss invariant to ready for redispatch", () => {
  const snapshot = newIssueSnapshot("github:8e", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-host-loss-1",
        source_stage: "implementation",
        source_lifecycle: "running",
        source_role: "implementation_agent",
        category: "runtime_invariant",
        severity: "retryable",
        retryable: true,
        summary: "host_liveness_lost",
        attempt_count: 1,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.equal(result.history.at(-1)?.payload.rule, "runtime_invariant_host_liveness_loss_retries_stage");
});

test("exception resolver retries worker artifact rejection from implementation as a fresh dispatch", () => {
  const snapshot = newIssueSnapshot("github:8w", {
    lifecycle_state: "exception",
    runtime_context_json: {
      last_error: "agent result issue_number must be 8",
      exception: {
        id: "exc-worker-reject-1",
        source_stage: "implementation",
        source_lifecycle: "running",
        source_role: "implementation_agent",
        category: "runtime_invariant",
        severity: "retryable",
        retryable: true,
        summary: "worker_artifact_rejected_retryable",
        attempt_count: 1,
        payload: {
          error: "agent result issue_number must be 8",
        },
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.equal(result.snapshot.runtime_context_json.last_error, "agent result issue_number must be 8");
  assert.equal(result.history.at(-1)?.payload.rule, "worker_artifact_rejected_retries_implementation");
});

test("exception resolver returns verifier artifact rejection to implementation with carry-forward", () => {
  const snapshot = newIssueSnapshot("github:8f", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-verifier-reject-1",
        source_stage: "verification",
        source_lifecycle: "verifying",
        source_role: "verifier_agent",
        category: "runtime_invariant",
        severity: "retryable",
        retryable: true,
        summary: "artifact_rejected_retryable",
        attempt_count: 1,
        payload: {
          error: "agent result artifact_kind must be verification_result",
        },
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {
    error: "agent result artifact_kind must be verification_result",
  });
  assert.equal(result.history.at(-1)?.payload.rule, "verifier_artifact_rejected_returns_to_implementation");
});

test("exception resolver quarantines missing child-run invariant when retries exhausted", () => {
  const snapshot = newIssueSnapshot("github:8c", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-missing-child-2",
        source_stage: "implementation",
        source_lifecycle: "running",
        source_role: "implementation_agent",
        category: "runtime_invariant",
        severity: "retryable",
        retryable: true,
        summary: "active_issue_missing_child_run",
        attempt_count: 2,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "quarantined");
  assert.equal(result.history.at(-1)?.payload.rule, "runtime_invariant_missing_child_run_retries_stage");
  assert.equal(result.history.at(-1)?.payload.exhausted, true);
});

test("exception resolver is no-op for non-exception lifecycle", () => {
  const snapshot = newIssueSnapshot("github:9", {
    lifecycle_state: "running",
    runtime_context_json: {
      stage_cursor: "implementation",
      exception: {
        id: "exc-noop",
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "running");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.deepEqual(result.history, []);
});

test("exception resolver supports fail action on exhausted policy", () => {
  const failPolicyWorkflow: WorkflowDefinition = {
    ...workflow,
    exception_policy: {
      ...workflow.exception_policy!,
      rules: [
        {
          name: "verification_terminal_on_exhausted_fails",
          match: {
            source_stage: "verification",
            status: "failed_retryable",
          },
          action: {
            type: "retry_stage",
            target_stage: "verification",
          },
          on_exhausted: { type: "fail" },
        },
      ],
      default: {
        action: {
          type: "fail",
        },
      },
    },
  };
  const snapshot = newIssueSnapshot("github:10", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-fail",
        source_stage: "verification",
        status: "failed_retryable",
        attempt_count: 3,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, failPolicyWorkflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "failed");
  assert.equal(result.history.at(-1)?.payload.action, "fail");
  assert.equal(result.history.at(-1)?.payload.exhausted, true);
});

test("exception resolver quarantines retry_same_stage when source stage is missing", () => {
  const retrySameStageWorkflow: WorkflowDefinition = {
    ...workflow,
    exception_policy: {
      ...workflow.exception_policy!,
      rules: [
        {
          name: "artifact_validation_retry_same_stage",
          match: {
            category: "artifact_validation",
          },
          action: {
            type: "retry_same_stage",
          },
          on_exhausted: { type: "quarantine" },
        },
      ],
      default: {
        action: {
          type: "quarantine",
        },
      },
    },
  };
  const snapshot = newIssueSnapshot("github:11", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        category: "artifact_validation",
        id: "",
        attempt_count: "not-a-number" as unknown as number,
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, retrySameStageWorkflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "quarantined");
  assert.equal(result.history.at(-1)?.payload.exception_id, "unknown-exception");
  assert.equal(result.history.at(-1)?.payload.rule, "artifact_validation_retry_same_stage");
});

test("exception resolver tolerates non-object carry-forward payload", () => {
  const snapshot = newIssueSnapshot("github:12", {
    lifecycle_state: "exception",
    runtime_context_json: {
      exception: {
        id: "exc-carry-forward",
        source_stage: "verification",
        source_lifecycle: "verifying",
        source_role: "verifier_agent",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        category: "agent_reported_failure",
        severity: "retryable",
        retryable: true,
        attempt_count: 1,
        payload: "not-an-object",
      },
    },
  });

  const result = resolveExceptionPolicy(snapshot, workflow, {
    maxRecoveryAttempts: 2,
    now: "2026-06-03T00:00:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(result.snapshot.runtime_context_json.child_runs?.length ?? 0, 0);
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, {});
});

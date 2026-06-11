import assert from "node:assert/strict";
import test from "node:test";

const recoveryModule = "../../skills/northstar/scripts/lib/recovery.mjs";
const now = "2026-05-30T12:00:00.000Z";

function issue(overrides = {}) {
  return {
    issue_number: 42,
    lifecycle_state: "running",
    runtime_context_json: {
      child_runs: [],
      projection_sync: [],
    },
    ...overrides,
  };
}

function lease(expires_at = "2026-05-30T11:00:00.000Z") {
  return {
    lease_id: "lease-1",
    root_session_id: "root-1",
    role: "issue_worker",
    generation: 1,
    heartbeat_seq: 0,
    last_heartbeat_at: "2026-05-30T10:00:00.000Z",
    expires_at,
  };
}

test("northstar recovery diagnoses quarantined expired leases", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({
    issue: issue({
      lifecycle_state: "quarantined",
      runtime_context_json: {
        owner_lease: lease(),
        stage_cursor: "implementation",
        projection_sync: [],
      },
    }),
    now,
  });

  assert.equal(diagnoses[0].diagnosis, "quarantined_expired_lease");
  assert.equal(diagnoses[0].issue_number, 42);
  assert.equal(diagnoses[0].confirmation, "confirm");
});

test("northstar recovery diagnoses failed issues", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({ issue: issue({ lifecycle_state: "failed" }), now });

  assert.equal(diagnoses[0].diagnosis, "failed");
  assert.equal(diagnoses[0].commandPlan.text, "northstar inspect --config .northstar.yaml --issue 42");
});

test("northstar recovery command plans always include default config path", async () => {
  const { diagnoseRecovery, recoveryReport } = await import(recoveryModule);

  const [diagnosis] = diagnoseRecovery({ issue: issue({ lifecycle_state: "failed" }), now });
  const report = recoveryReport({ issue: 42, lifecycle: "quarantined", leaseExpired: true });

  assert.equal(diagnosis.commandPlan.text, "northstar inspect --config .northstar.yaml --issue 42");
  assert.match(report.text, /precheck_command: northstar inspect --config \.northstar\.yaml --issue 42/);
  assert.match(report.text, /recovery_command: northstar repair-runtime --config \.northstar\.yaml --issue 42/);
});

test("northstar recovery command plans include explicit config path when provided", async () => {
  const { diagnoseRecovery, recoveryReport } = await import(recoveryModule);
  const configPath = "/repo/.northstar.yaml";

  const [diagnosis] = diagnoseRecovery({
    issue: issue({ lifecycle_state: "failed" }),
    configPath,
    now,
  });
  const report = recoveryReport({ issue: 42, lifecycle: "quarantined", leaseExpired: true, configPath });

  assert.equal(diagnosis.commandPlan.text, "northstar inspect --config /repo/.northstar.yaml --issue 42");
  assert.match(report.text, /precheck_command: northstar inspect --config \/repo\/\.northstar\.yaml --issue 42/);
  assert.match(report.text, /recovery_command: northstar repair-runtime --config \/repo\/\.northstar\.yaml --issue 42/);
});

test("northstar recovery diagnoses retryable projection failures", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({
    issue: issue({
      runtime_context_json: {
        projection_sync: [
          {
            projection_target: "github_project",
            status: "failed",
            attempt: 2,
            last_error: "rate limited",
            next_retry_at: "2026-05-30T11:55:00.000Z",
          },
        ],
      },
    }),
    now,
  });

  assert.equal(diagnoses[0].diagnosis, "retryable_projection_failure");
  assert.equal(diagnoses[0].confirmation, "auto");
  assert.equal(diagnoses[0].commandPlan.text, "northstar retry-sync --config .northstar.yaml --issue 42 --projection github_project");
});

test("northstar recovery diagnoses branch-without-PR", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({
    issue: issue({
      branch: "northstar/issue-42",
      pull_request: null,
    }),
    now,
  });

  assert.equal(diagnoses[0].diagnosis, "branch_without_pr");
  assert.equal(diagnoses[0].confirmation, "confirm");
});

test("northstar recovery diagnoses PR-without-runtime metadata", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({
    issue: issue({
      pull_request: { number: 108, state: "open" },
      runtime_context_json: {
        projection_sync: [],
      },
    }),
    now,
  });

  assert.equal(diagnoses[0].diagnosis, "pr_without_runtime_metadata");
  assert.equal(diagnoses[0].issue_number, 42);
  assert.equal(diagnoses[0].state, "running");
});

test("northstar recovery diagnoses verified auto-release", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({
    issue: issue({
      lifecycle_state: "verified",
      auto_release: true,
      pull_request: { number: 108, state: "open" },
      runtime_context_json: {
        pr_number: 108,
        projection_sync: [],
      },
    }),
    now,
  });

  assert.equal(diagnoses[0].diagnosis, "verified_auto_release");
  assert.equal(diagnoses[0].confirmation, "confirm");
  assert.equal(diagnoses[0].commandPlan.text, "northstar release --config .northstar.yaml --issue 42 --pr 108");
});

test("northstar recovery detects all six canonical recovery cases", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const diagnoses = diagnoseRecovery({
    issues: [
      issue({
        issue_number: 1,
        lifecycle_state: "quarantined",
        runtime_context_json: { owner_lease: lease(), projection_sync: [] },
      }),
      issue({ issue_number: 2, lifecycle_state: "failed" }),
      issue({
        issue_number: 3,
        runtime_context_json: {
          projection_sync: [{ projection_target: "github_project", status: "failed", next_retry_at: "2026-05-30T11:55:00.000Z" }],
        },
      }),
      issue({ issue_number: 4, branch: "northstar/issue-4" }),
      issue({ issue_number: 5, pull_request: { number: 105, state: "open" } }),
      issue({
        issue_number: 6,
        lifecycle_state: "verified",
        auto_release: true,
        pull_request: { number: 106, state: "open" },
        runtime_context_json: { pr_number: 106, projection_sync: [] },
      }),
    ],
    now,
  });

  assert.deepEqual(diagnoses.map((diagnosis) => diagnosis.diagnosis).sort(), [
    "branch_without_pr",
    "failed",
    "pr_without_runtime_metadata",
    "quarantined_expired_lease",
    "retryable_projection_failure",
    "verified_auto_release",
  ]);
});

test("northstar recovery supports simple raw recovery inputs", async () => {
  const { diagnoseRecovery } = await import(recoveryModule);

  const cases = [
    diagnoseRecovery({ issue: 1, lifecycle: "quarantined", leaseExpired: true }),
    diagnoseRecovery({ issue: 2, lifecycle: "failed" }),
    diagnoseRecovery({ issue: 3, lifecycle: "running", projectionRetryable: true }),
    diagnoseRecovery({ issue: 4, lifecycle: "running", branchExists: true, prExists: false }),
    diagnoseRecovery({ issue: 5, lifecycle: "running", prExists: true, runtimeHasPr: false }),
    diagnoseRecovery({ issue: 6, lifecycle: "verified", autoRelease: true }),
  ];

  assert.equal(cases.filter((item) => item.detected).length, 6);
  assert.equal(cases[0].issue, 1);
  assert.equal(cases[0].state, "quarantined");
  assert.equal(cases[0].diagnosis, "expired lease");
  assert.equal(cases[0].message, "expired lease");
  assert.equal(cases[0].detected, true);
  assert.equal(cases[0].requiresConfirmation, true);
  assert.equal(cases[0].commandPlan.text, "northstar repair-runtime --config .northstar.yaml --issue 1");
  assert.equal(cases[2].requiresConfirmation, false);
});

test("northstar recovery risk gates explicit and unknown actions", async () => {
  const { recoveryRiskForAction } = await import(recoveryModule);

  assert.deepEqual(recoveryRiskForAction("force_push"), {
    action: "force_push",
    risk: "high",
    confirmation: "second_confirmation",
  });
  assert.deepEqual(recoveryRiskForAction("inspect"), {
    action: "inspect",
    risk: "low",
    confirmation: "auto",
  });
  assert.deepEqual(recoveryRiskForAction("unknown-action"), {
    action: "unknown-action",
    risk: "high",
    confirmation: "second_confirmation",
  });
});

test("northstar recovery report includes issue state diagnosis gate and command plan", async () => {
  const { diagnoseRecovery, recoveryReport } = await import(recoveryModule);

  const [diagnosis] = diagnoseRecovery({
    issue: issue({
      lifecycle_state: "quarantined",
      runtime_context_json: {
        owner_lease: lease(),
        projection_sync: [],
      },
    }),
    now,
  });

  const report = recoveryReport(diagnosis);

  assert.equal(typeof report, "object");
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0], diagnosis);
  assert.match(report.text, /Issue: 42/);
  assert.match(report.text, /State: quarantined/);
  assert.match(report.text, /Diagnosis: quarantined_expired_lease/);
  assert.match(report.text, /Confirmation: confirm/);
  assert.match(report.text, /Command Plan: northstar repair-runtime --config \.northstar\.yaml --issue 42/);
});

test("northstar recovery report accepts simple raw input directly", async () => {
  const { recoveryReport } = await import(recoveryModule);

  const report = recoveryReport({ issue: 123, lifecycle: "quarantined", leaseExpired: true });

  assert.equal(typeof report, "object");
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0].issue, 123);
  assert.match(report.text, /issue: #123/);
  assert.match(report.text, /state: quarantined/);
  assert.match(report.text, /diagnosis: expired lease/);
  assert.match(report.text, /requires_confirmation: yes/);
  assert.match(report.text, /northstar inspect --config \.northstar\.yaml --issue 123/);
});

test("northstar recovery report preserves simple diagnosis objects", async () => {
  const { diagnoseRecovery, recoveryReport } = await import(recoveryModule);
  const simpleInput = { issue: 1, lifecycle: "quarantined", leaseExpired: true };
  const diagnosis = diagnoseRecovery(simpleInput);

  const report = recoveryReport(diagnosis);

  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0], diagnosis);
  assert.equal(report.diagnoses[0].diagnosis, diagnosis.diagnosis);
  assert.deepEqual(report.diagnoses[0].commandPlan, diagnosis.commandPlan);
  assert.match(report.text, /Command Plan: northstar repair-runtime --config \.northstar\.yaml --issue 1/);
});

test("northstar recovery report text aligns simple raw precheck and recovery commands", async () => {
  const { recoveryReport } = await import(recoveryModule);

  const report = recoveryReport({ issue: 123, lifecycle: "quarantined", leaseExpired: true });

  assert.match(report.text, /precheck_command: northstar inspect --config \.northstar\.yaml --issue 123/);
  assert.match(report.text, /recovery_command: northstar repair-runtime --config \.northstar\.yaml --issue 123/);
  assert.equal(report.diagnoses[0].commandPlan.text, "northstar repair-runtime --config .northstar.yaml --issue 123");
  assert.match(report.text, new RegExp(`recovery_command: ${report.diagnoses[0].commandPlan.text}`));
});

test("northstar recovery report accepts hydrated raw issue wrappers", async () => {
  const { recoveryReport } = await import(recoveryModule);

  const report = recoveryReport({
    issue: issue({
      lifecycle_state: "quarantined",
      runtime_context_json: {
        owner_lease: lease(),
        projection_sync: [],
      },
    }),
    now,
  });

  assert.equal(typeof report, "object");
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0].diagnosis, "quarantined_expired_lease");
  assert.match(report.text, /Issue: 42/);
  assert.match(report.text, /State: quarantined/);
  assert.match(report.text, /Diagnosis: quarantined_expired_lease/);
  assert.match(report.text, /Command Plan: northstar repair-runtime --config \.northstar\.yaml --issue 42/);
});

test("northstar recovery report returns stable shape for diagnosis objects", async () => {
  const { diagnoseRecovery, recoveryReport } = await import(recoveryModule);
  const [diagnosis] = diagnoseRecovery({ issue: issue({ lifecycle_state: "failed" }), now });

  const report = recoveryReport(diagnosis);

  assert.deepEqual(Object.keys(report).sort(), ["diagnoses", "text"]);
  assert.equal(report.diagnoses.length, 1);
  assert.equal(report.diagnoses[0], diagnosis);
  assert.match(report.text, /Issue: 42/);
  assert.match(report.text, /Diagnosis: failed/);
  assert.match(report.text, /Command Plan: northstar inspect --config \.northstar\.yaml --issue 42/);
});

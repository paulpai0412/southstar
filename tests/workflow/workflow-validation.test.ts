import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflow, validateWorkflow, WorkflowValidationError } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const invalidFixtureDir = join(repoRoot, "tests/fixtures/workflows/invalid");

const baseWorkflow = {
  id: "invalid_fixture",
  version: "1.0",
  roles: {
    worker: {
      run_mode: "background_child",
      agent: "build",
      load_skills: ["tdd"],
      artifact: "worker_result",
      timeout_seconds: 30,
      retry_policy: { max_attempts: 2, backoff_seconds: [5] },
    },
  },
  stages: {
    implementation: {
      lifecycle_state: "running",
      role: "worker",
      on_success: "completed",
      on_failed_retryable: "implementation",
      on_failed_terminal: "failed",
    },
  },
};

test("workflow validation errors expose stable code, path, and message", () => {
  assert.throws(
    () => validateWorkflow({ ...baseWorkflow, id: "" }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_FIELD_REQUIRED");
      assert.equal(error.path, "workflow.id");
      assert.match(error.message, /workflow\.id/);
      return true;
    },
  );
});

test("workflow validation rejects unknown lifecycle states with machine-readable code", () => {
  assert.throws(
    () => validateWorkflow({
      ...baseWorkflow,
      stages: {
        implementation: {
          ...baseWorkflow.stages.implementation,
          lifecycle_state: "shipping",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_UNKNOWN_LIFECYCLE_STATE");
      assert.equal(error.path, "workflow.stages.implementation.lifecycle_state");
      return true;
    },
  );
});

test("workflow validation rejects missing stage transition targets", () => {
  assert.throws(
    () => validateWorkflow({
      ...baseWorkflow,
      stages: {
        implementation: {
          ...baseWorkflow.stages.implementation,
          on_success: "verification",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_UNKNOWN_STAGE_TARGET");
      assert.equal(error.path, "workflow.stages.implementation.on_success");
      return true;
    },
  );
});

test("workflow validation rejects role artifacts without declared artifact schema", () => {
  assert.throws(
    () => validateWorkflow({
      ...baseWorkflow,
      roles: {
        worker: {
          ...baseWorkflow.roles.worker,
          artifact: "unknown_packet",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_UNKNOWN_ARTIFACT_SCHEMA");
      assert.equal(error.path, "workflow.roles.worker.artifact");
      return true;
    },
  );
});

test("workflow validation rejects retry cycles without retry policy", () => {
  const { retry_policy: _retryPolicy, ...workerWithoutRetry } = baseWorkflow.roles.worker;
  assert.throws(
    () => validateWorkflow({
      ...baseWorkflow,
      roles: { worker: workerWithoutRetry },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_RETRY_CYCLE_WITHOUT_POLICY");
      assert.equal(error.path, "workflow.stages.implementation.on_failed_retryable");
      return true;
    },
  );
});

test("workflow validation accepts declarative exception policy", () => {
  const workflow = validateWorkflow({
    ...baseWorkflow,
    roles: {
      implementation_agent: {
        ...baseWorkflow.roles.worker,
        artifact: "implementation_result",
      },
      verifier_agent: {
        ...baseWorkflow.roles.worker,
        artifact: "verification_result",
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
        on_success: "completed",
      },
    },
    exception_policy: {
      max_recovery_attempts_from: "runtime.max_recovery_attempts",
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
      ],
      default: { action: { type: "quarantine" } },
    },
  });

  assert.equal(workflow.exception_policy?.rules[0]?.action.type, "return_to_stage");
  assert.deepEqual(workflow.exception_policy?.rules[0]?.action.carry_forward, ["feedback_for_implementation"]);
});

test("workflow validation rejects unknown exception policy match fields", () => {
  assert.throws(
    () => validateWorkflow({
      ...baseWorkflow,
      exception_policy: {
        rules: [
          {
            name: "bad_match",
            match: { unsupported: "value" },
            action: { type: "quarantine" },
          },
        ],
        default: { action: { type: "quarantine" } },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_EXCEPTION_POLICY_INVALID_MATCH_FIELD");
      assert.equal(error.path, "workflow.exception_policy.rules[0].match.unsupported");
      return true;
    },
  );
});

test("workflow validation rejects exception actions targeting unknown stages", () => {
  assert.throws(
    () => validateWorkflow({
      ...baseWorkflow,
      exception_policy: {
        rules: [
          {
            name: "bad_target",
            match: { source_stage: "implementation" },
            action: { type: "retry_stage", target_stage: "missing" },
          },
        ],
        default: { action: { type: "quarantine" } },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_EXCEPTION_POLICY_UNKNOWN_TARGET_STAGE");
      assert.equal(error.path, "workflow.exception_policy.rules[0].action.target_stage");
      return true;
    },
  );
});

test("invalid workflow fixtures fail with expected stable error codes", () => {
  const expectedCodes: Record<string, string> = {
    "missing-id.yaml": "WORKFLOW_FIELD_REQUIRED",
    "missing-version.yaml": "WORKFLOW_FIELD_REQUIRED",
    "empty-roles.yaml": "WORKFLOW_EMPTY_COLLECTION",
    "empty-stages.yaml": "WORKFLOW_EMPTY_COLLECTION",
    "missing-role.yaml": "WORKFLOW_UNKNOWN_ROLE",
    "missing-stage-target.yaml": "WORKFLOW_UNKNOWN_STAGE_TARGET",
    "unknown-lifecycle.yaml": "WORKFLOW_UNKNOWN_LIFECYCLE_STATE",
    "missing-artifact-schema.yaml": "WORKFLOW_UNKNOWN_ARTIFACT_SCHEMA",
    "retry-cycle-without-policy.yaml": "WORKFLOW_RETRY_CYCLE_WITHOUT_POLICY",
    "invalid-run-mode.yaml": "WORKFLOW_INVALID_RUN_MODE",
    "missing-stage-role.yaml": "WORKFLOW_FIELD_REQUIRED",
    "invalid-timeout.yaml": "WORKFLOW_FIELD_TYPE",
    "invalid-skills.yaml": "WORKFLOW_FIELD_TYPE",
    "invalid-retry-policy.yaml": "WORKFLOW_FIELD_TYPE",
    "unsupported-host-capability.yaml": "WORKFLOW_UNSUPPORTED_HOST_CAPABILITY",
    "exception-policy-unknown-action.yaml": "WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION",
    "exception-policy-unknown-match-field.yaml": "WORKFLOW_EXCEPTION_POLICY_INVALID_MATCH_FIELD",
    "exception-policy-missing-target.yaml": "WORKFLOW_EXCEPTION_POLICY_MISSING_TARGET_STAGE",
    "exception-policy-unknown-target.yaml": "WORKFLOW_EXCEPTION_POLICY_UNKNOWN_TARGET_STAGE",
  };

  const fixtureNames = readdirSync(invalidFixtureDir).filter((name) => name.endsWith(".yaml")).sort();
  assert.equal(fixtureNames.length, 19);

  for (const fixtureName of fixtureNames) {
    assert.throws(
      () => loadWorkflow(join(invalidFixtureDir, fixtureName), {
        hostCapabilities: {
          run_modes: ["background_child"],
          role_fields: ["agent", "load_skills", "timeout_seconds", "retry_policy"],
        },
      }),
      (error) => {
        assert.ok(error instanceof WorkflowValidationError, fixtureName);
        assert.equal(error.code, expectedCodes[fixtureName], fixtureName);
        return true;
      },
    );
  }
});

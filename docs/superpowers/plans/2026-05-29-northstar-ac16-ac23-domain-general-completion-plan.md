# Northstar AC16-AC23 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Northstar AC-16 through AC-23 from `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`: workflow schema errors, artifact schemas, intake, watch mode, security/redaction, packaging smoke, full code-goal mapping, and domain-general workflow fixtures.

**Architecture:** Keep the existing state machine pure and keep SQLite persistence in `src/runtime/store.ts`. The core lifecycle remains fixed; workflow-specific stages, events, artifacts, effects, and projection targets live in workflow metadata. Add focused modules for workflow validation errors, domain workflow schema validation, artifact validation, intake adapters, watch-loop orchestration, redaction, and credential providers; connect them through existing runtime event/history surfaces instead of adding new control-plane tables.

**Tech Stack:** Node 22.22+, TypeScript files executed by Node type stripping, `node:test`, `node:assert/strict`, `node:sqlite`, YAML fixtures, fake adapters/providers for unit tests, optional `npm run test:live` only for live smoke.

---

## Source And Baseline

- Source spec: `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- Current completed scope: AC-01 through AC-15, live SDK/GitHub smoke, and local merge to `main`
- Current branch expectation for execution: create a new feature branch from `main` before editing
- Existing test command: `npm test`
- Existing live smoke command: `npm run test:live`

## Scope

This plan implements:

| AC | Area | Primary New/Changed Files |
| --- | --- | --- |
| AC-16 | Workflow schema validation with stable error codes | `src/types/workflow.ts`, `src/types/workflow-validation.ts`, `tests/workflow/workflow-validation.test.ts`, `tests/fixtures/workflows/invalid/*.yaml` |
| AC-17 | Artifact schemas and artifact rejection history | `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts`, `tests/runtime/artifacts.test.ts`, `tests/runtime/state-machine.test.ts` |
| AC-18 | GitHub/local intake and idempotent intake history | `src/intake/types.ts`, `src/intake/local.ts`, `src/intake/github.ts`, `src/runtime/store.ts`, `tests/intake/intake.test.ts` |
| AC-19 | Watch loop abstraction | `src/runtime/watch.ts`, `src/cli/northstar.ts`, `tests/runtime/watch.test.ts`, `tests/cli/cli.test.ts` |
| AC-20 | Security, redaction, credential providers | `src/runtime/redaction.ts`, `src/runtime/credentials.ts`, `src/adapters/github/remote.ts`, `src/runtime/inspect.ts`, `tests/runtime/security.test.ts` |
| AC-21 | Packaging install/run smoke and version output | `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts`, `tests/cli/packaging.test.ts` |
| AC-22 | Full code-goal mapping | `docs/superpowers/ac16-ac23-coverage.md`, `docs/superpowers/full-ac-coverage.md`, `tests/spec/spec-compliance.test.ts` |
| AC-23 | Workflow domain generality | `tests/fixtures/workflows/content-creation-publish.yaml`, `tests/fixtures/workflows/office-report-delivery.yaml`, `tests/workflow/domain-workflow.test.ts`, `tests/runtime/state-machine.test.ts`, `src/types/workflow.ts`, `src/runtime/state-machine.ts`, `src/runtime/artifacts.ts` |

## Execution Rules

- Use TDD for every behavior: write failing test, run `npm test` and see the expected failure, implement the minimum code, rerun `npm test`.
- When a failure is unexpected, use `superpowers:systematic-debugging` before editing.
- Keep `src/runtime/state-machine.ts` pure: no filesystem, SQLite, GitHub, host SDKs, shell, or process execution.
- Do not add runtime control-plane tables beyond `issues` and `issue_history`.
- Runtime source must not import or shell out to `/home/timmypai/apps/autodev/scripts` or Python.
- Runtime source must not read arbitrary `process.env`; only config/bootstrap code may read `NORTHSTAR_CONFIG`, `NORTHSTAR_PROJECT_ROOT`, and `NORTHSTAR_DEBUG`.
- External commands must remain argv arrays. Reject shell-chain strings containing `&&`, `||`, or `;`.
- Do not store secrets in repo files, tests, docs, logs, SQLite history payloads, or inspect output.

---

## Task 1: AC-16 Workflow Validation Error Model

**Files:**
- Create: `src/types/workflow-validation.ts`
- Modify: `src/types/workflow.ts`
- Test: `tests/workflow/workflow-validation.test.ts`

- [ ] **Step 1: Write failing tests for stable workflow error codes**

Add `tests/workflow/workflow-validation.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { validateWorkflow, WorkflowValidationError } from "../../src/types/workflow.ts";

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
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `WorkflowValidationError` does not exist and `validateWorkflow` throws plain `Error` strings.

- [ ] **Step 3: Add workflow validation error type**

Create `src/types/workflow-validation.ts`:

```ts
export type WorkflowValidationErrorCode =
  | "WORKFLOW_FIELD_REQUIRED"
  | "WORKFLOW_FIELD_TYPE"
  | "WORKFLOW_EMPTY_COLLECTION"
  | "WORKFLOW_INVALID_RUN_MODE"
  | "WORKFLOW_UNKNOWN_ROLE"
  | "WORKFLOW_UNKNOWN_STAGE_TARGET"
  | "WORKFLOW_UNKNOWN_LIFECYCLE_STATE"
  | "WORKFLOW_UNKNOWN_ARTIFACT_SCHEMA"
  | "WORKFLOW_RETRY_CYCLE_WITHOUT_POLICY"
  | "WORKFLOW_UNSUPPORTED_HOST_CAPABILITY";

export class WorkflowValidationError extends Error {
  constructor(
    readonly code: WorkflowValidationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "WorkflowValidationError";
  }
}

export function workflowValidationError(
  code: WorkflowValidationErrorCode,
  path: string,
  message: string,
): WorkflowValidationError {
  return new WorkflowValidationError(code, path, message);
}
```

- [ ] **Step 4: Update workflow validator to use error codes**

Modify `src/types/workflow.ts`:

```ts
import { readFileSync } from "node:fs";
import { parseYamlSubset } from "../config/load-config.ts";
import { lifecycleStates } from "./control-plane.ts";
import {
  WorkflowValidationError,
  workflowValidationError,
  type WorkflowValidationErrorCode,
} from "./workflow-validation.ts";

export { WorkflowValidationError };

export interface WorkflowValidationOptions {
  artifactKinds?: string[];
  hostCapabilities?: {
    run_modes?: string[];
    role_fields?: string[];
  };
}

const defaultArtifactKinds = ["worker_result", "evidence_packet", "release_result"];
const defaultRunModes = ["root", "background_child", "manual_gate"];
```

Update `validateWorkflow` signature:

```ts
export function validateWorkflow(value: unknown, options: WorkflowValidationOptions = {}): WorkflowDefinition {
```

Inside `validateWorkflow`, after normalizing roles and stages, validate:

```ts
  if (Object.keys(normalizedRoles).length === 0) {
    throw workflowValidationError("WORKFLOW_EMPTY_COLLECTION", "workflow.roles", "workflow.roles must contain at least one role");
  }
  if (Object.keys(normalizedStages).length === 0) {
    throw workflowValidationError("WORKFLOW_EMPTY_COLLECTION", "workflow.stages", "workflow.stages must contain at least one stage");
  }

  const allowedArtifacts = new Set(options.artifactKinds ?? defaultArtifactKinds);
  const allowedRunModes = new Set(options.hostCapabilities?.run_modes ?? defaultRunModes);

  for (const [roleName, role] of Object.entries(normalizedRoles)) {
    if (!allowedRunModes.has(role.run_mode)) {
      throw workflowValidationError("WORKFLOW_INVALID_RUN_MODE", `workflow.roles.${roleName}.run_mode`, `unsupported run_mode ${role.run_mode}`);
    }
    if (role.artifact && !allowedArtifacts.has(role.artifact)) {
      throw workflowValidationError("WORKFLOW_UNKNOWN_ARTIFACT_SCHEMA", `workflow.roles.${roleName}.artifact`, `unknown artifact schema ${role.artifact}`);
    }
  }

  const stageNames = new Set(Object.keys(normalizedStages));
  const terminalStates = new Set(["ready", "claimed", "running", "verifying", "verified", "release_pending", "completed", "failed", "quarantined"]);
  const transitionKeys: Array<keyof StageDefinition> = [
    "on_success",
    "on_pass",
    "on_blocked",
    "on_blocked_transient",
    "on_failed_retryable",
    "on_failed_terminal",
    "on_fail_retryable",
    "on_fail_terminal",
  ];

  for (const [stageName, stage] of Object.entries(normalizedStages)) {
    if (!lifecycleStates.includes(stage.lifecycle_state as never)) {
      throw workflowValidationError("WORKFLOW_UNKNOWN_LIFECYCLE_STATE", `workflow.stages.${stageName}.lifecycle_state`, `unknown lifecycle state ${stage.lifecycle_state}`);
    }
    for (const key of transitionKeys) {
      const target = stage[key];
      if (target && !stageNames.has(target) && !terminalStates.has(target)) {
        throw workflowValidationError("WORKFLOW_UNKNOWN_STAGE_TARGET", `workflow.stages.${stageName}.${key}`, `unknown transition target ${target}`);
      }
    }
    const retryTarget = stage.on_failed_retryable ?? stage.on_fail_retryable;
    if (retryTarget === stageName && !normalizedRoles[stage.role]?.retry_policy) {
      throw workflowValidationError("WORKFLOW_RETRY_CYCLE_WITHOUT_POLICY", `workflow.stages.${stageName}.on_failed_retryable`, `retry cycle on ${stageName} requires role retry_policy`);
    }
  }
```

Replace helper throws with `workflowValidationError`. For example:

```ts
function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw workflowValidationError("WORKFLOW_FIELD_REQUIRED", field, `${field} must be a non-empty string`);
  }
  return value;
}
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS for existing tests and new workflow validation tests.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/types/workflow.ts src/types/workflow-validation.ts tests/workflow/workflow-validation.test.ts
git commit -m "feat: add workflow validation error codes"
```

---

## Task 2: AC-16 Invalid Workflow Fixtures And Capability Checks

**Files:**
- Create: `tests/fixtures/workflows/invalid/*.yaml`
- Modify: `tests/workflow/workflow-validation.test.ts`
- Modify: `src/types/workflow.ts`

- [ ] **Step 1: Add invalid fixture table test**

Append to `tests/workflow/workflow-validation.test.ts`:

```ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflow } from "../../src/types/workflow.ts";

const invalidFixtureDir = join(import.meta.dirname, "../fixtures/workflows/invalid");

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
  };

  const fixtureNames = readdirSync(invalidFixtureDir).filter((name) => name.endsWith(".yaml")).sort();
  assert.equal(fixtureNames.length, 15);

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
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `tests/fixtures/workflows/invalid` does not exist and `loadWorkflow` does not accept validation options.

- [ ] **Step 3: Add invalid fixture files**

Create `tests/fixtures/workflows/invalid/missing-id.yaml`:

```yaml
workflow:
  id: ""
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

Create the remaining 14 fixture files with these exact invalid changes:

```yaml
# tests/fixtures/workflows/invalid/missing-version.yaml
workflow:
  id: invalid_fixture
  version: ""
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/empty-roles.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/empty-stages.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
```

```yaml
# tests/fixtures/workflows/invalid/missing-role.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: reviewer
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/missing-stage-target.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: verification
```

```yaml
# tests/fixtures/workflows/invalid/unknown-lifecycle.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: shipping
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/missing-artifact-schema.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: unknown_packet
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/retry-cycle-without-policy.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_failed_retryable: implementation
      on_failed_terminal: failed
```

```yaml
# tests/fixtures/workflows/invalid/invalid-run-mode.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: foreground
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/missing-stage-role.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: ""
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/invalid-timeout.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: "slow"
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/invalid-skills.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills: "tdd"
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/invalid-retry-policy.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: "twice"
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

```yaml
# tests/fixtures/workflows/invalid/unsupported-host-capability.yaml
workflow:
  id: invalid_fixture
  version: "1.0"
  roles:
    worker:
      run_mode: background_child
      agent: build
      model: gpt-5
      load_skills:
        - tdd
      artifact: worker_result
      timeout_seconds: 30
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 5
  stages:
    implementation:
      lifecycle_state: running
      role: worker
      on_success: completed
```

- [ ] **Step 4: Add loadWorkflow validation options and host capability checks**

Modify `src/types/workflow.ts`:

```ts
export function loadWorkflow(path: string, options: WorkflowValidationOptions = {}): WorkflowDefinition {
  const parsed = parseYamlSubset(readFileSync(path, "utf8"));
  const workflow = getRecord(parsed, "workflow");
  return validateWorkflow(workflow, options);
}
```

Add capability check after role normalization:

```ts
  const supportedRoleFields = new Set(options.hostCapabilities?.role_fields ?? [
    "run_mode",
    "agent",
    "model",
    "load_skills",
    "artifact",
    "timeout_seconds",
    "retry_policy",
    "prompt_template",
  ]);

  for (const [roleName, roleValue] of Object.entries(roles)) {
    const roleRecord = getRecordValue(roleValue, `workflow.roles.${roleName}`);
    for (const key of Object.keys(roleRecord)) {
      if (!supportedRoleFields.has(key)) {
        throw workflowValidationError("WORKFLOW_UNSUPPORTED_HOST_CAPABILITY", `workflow.roles.${roleName}.${key}`, `selected host adapter does not support role field ${key}`);
      }
    }
  }
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS with 15 invalid workflow fixtures covered.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add src/types/workflow.ts tests/workflow/workflow-validation.test.ts tests/fixtures/workflows/invalid
git commit -m "test: cover invalid workflow schema fixtures"
```

---

## Task 2A: AC-23 Domain-General Workflow Fixtures

**Files:**
- Create: `tests/fixtures/workflows/content-creation-publish.yaml`
- Create: `tests/fixtures/workflows/office-report-delivery.yaml`
- Create: `tests/workflow/domain-workflow.test.ts`
- Modify: `tests/runtime/state-machine.test.ts`
- Modify: `src/types/workflow.ts`

- [ ] **Step 1: Write failing workflow-domain tests**

Create `tests/workflow/domain-workflow.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { lifecycleStates } from "../../src/types/control-plane.ts";
import { loadWorkflow, validateWorkflow, WorkflowValidationError } from "../../src/types/workflow.ts";
import { repoRoot } from "../helpers/repo.ts";

test("content creation workflow validates with domain-specific metadata and fixed lifecycle states", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));

  assert.equal(workflow.id, "content_creation_publish");
  assert.equal(workflow.domain, "content_creation");
  assert.deepEqual(Object.keys(workflow.artifact_schemas ?? {}).sort(), [
    "approval_packet",
    "draft_article",
    "editorial_packet",
    "publish_result",
  ]);
  assert.deepEqual(Object.keys(workflow.effects ?? {}).sort(), ["publish_content", "sync_content_calendar"]);
  assert.deepEqual(Object.keys(workflow.projection_targets ?? {}).sort(), ["content_calendar", "editorial_dashboard"]);

  for (const stage of Object.values(workflow.stages)) {
    assert.ok(lifecycleStates.includes(stage.lifecycle_state), stage.lifecycle_state);
  }
});

test("office report workflow validates without coding role names or GitHub/Git artifacts", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/office-report-delivery.yaml"));

  assert.equal(workflow.id, "office_report_delivery");
  assert.equal(workflow.domain, "office_automation");
  assert.deepEqual(Object.keys(workflow.artifact_schemas ?? {}).sort(), [
    "approval_packet",
    "email_delivery_result",
    "review_packet",
    "spreadsheet_report",
  ]);
  assert.equal(Object.keys(workflow.roles).includes("issue_worker"), false);
  assert.equal(Object.keys(workflow.roles).includes("pr_verifier"), false);
  assert.equal(Object.keys(workflow.roles).includes("release_worker"), false);
});

test("workflow validation rejects domain-specific lifecycle states", () => {
  assert.throws(
    () => validateWorkflow({
      id: "invalid_domain_state",
      version: "1.0",
      domain: "content_creation",
      artifact_schemas: {
        draft_article: { required_fields: ["summary"] },
      },
      roles: {
        writer: {
          run_mode: "background_child",
          agent: "writer",
          load_skills: ["drafting"],
          artifact: "draft_article",
          timeout_seconds: 600,
        },
      },
      stages: {
        draft: {
          lifecycle_state: "drafting",
          role: "writer",
          on_success: "completed",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_UNKNOWN_LIFECYCLE_STATE");
      assert.equal(error.path, "workflow.stages.draft.lifecycle_state");
      return true;
    },
  );
});
```

Append to `tests/runtime/state-machine.test.ts`:

```ts
test("domain workflow advances by canonical child artifacts without coding role chains", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));
  const lease = createOwnerLease({
    lease_id: "lease-domain",
    root_session_id: "root-domain",
    role: "content_coordinator",
    now: "2026-05-29T00:00:00.000Z",
    ttl_seconds: 60,
  });
  const snapshot = newIssueSnapshot("content-1", {
    lifecycle_state: "running",
    owner_lease: lease,
    stage_cursor: "draft",
  });

  const result = applyRuntimeEvents(snapshot, workflow, [
    { type: "start_stage", child_run_id: "child-draft", session_id: "session-draft", at: "2026-05-29T00:00:01.000Z" },
    { type: "child_artifact", child_run_id: "child-draft", status: "succeeded", artifact_history_id: 101, at: "2026-05-29T00:00:02.000Z" },
  ]);

  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "editorial_review");
  assert.equal(result.snapshot.lifecycle_state, "verifying");
  assert.equal(result.snapshot.runtime_context_json.child_runs[0].role, "writer");
});

test("domain workflow records gate, heartbeat, projection, and effect facts through canonical events", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));
  const lease = createOwnerLease({
    lease_id: "lease-domain",
    root_session_id: "root-domain",
    role: "content_coordinator",
    now: "2026-05-29T00:00:00.000Z",
    ttl_seconds: 60,
  });
  const snapshot = newIssueSnapshot("content-1", {
    lifecycle_state: "verified",
    owner_lease: lease,
    stage_cursor: "approval",
  });

  const result = applyRuntimeEvents(snapshot, workflow, [
    { type: "heartbeat", lease_id: "lease-domain", at: "2026-05-29T00:00:03.000Z", ttl_seconds: 60 },
    { type: "gate_result", status: "pass", at: "2026-05-29T00:00:04.000Z" },
    {
      type: "projection_result",
      projection_target: "content_calendar",
      status: "failed",
      attempt: 1,
      last_error: "calendar unavailable",
      next_retry_at: "2026-05-29T00:05:00.000Z",
      payload: { workflow_id: "content_creation_publish" },
    },
    {
      type: "effect_result",
      effect_type: "publish_content",
      status: "failed",
      last_error: "cms unavailable",
      next_retry_at: "2026-05-29T00:05:00.000Z",
    },
  ]);

  assert.equal(result.snapshot.runtime_context_json.owner_lease.heartbeat_seq, 1);
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "publish");
  assert.equal(result.snapshot.lifecycle_state, "release_pending");
  assert.match(JSON.stringify(result.history), /content_calendar/);
  assert.match(JSON.stringify(result.history), /publish_content/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because the domain workflow fixtures do not exist and `WorkflowDefinition` does not yet expose `domain`, `artifact_schemas`, `effects`, `event_mappings`, or `projection_targets`.

- [ ] **Step 3: Add domain workflow fixtures**

Create `tests/fixtures/workflows/content-creation-publish.yaml`:

```yaml
workflow:
  id: content_creation_publish
  version: "1.0"
  domain: content_creation
  artifact_schemas:
    draft_article:
      required_fields:
        - summary
        - title
        - body_text
    editorial_packet:
      required_fields:
        - summary
        - review_notes
        - retryable
    approval_packet:
      required_fields:
        - summary
        - approved
    publish_result:
      required_fields:
        - summary
        - published_url
        - confirmed_delivery
  event_mappings:
    cms_publish_complete:
      runtime_event: effect_result
      effect_type: publish_content
    calendar_sync_failed:
      runtime_event: projection_result
      projection_target: content_calendar
  effects:
    publish_content:
      adapter: content_publisher
      retryable: true
    sync_content_calendar:
      adapter: projection
      retryable: true
  projection_targets:
    content_calendar:
      adapter: local_report
    editorial_dashboard:
      adapter: local_report
  roles:
    writer:
      run_mode: background_child
      agent: writer
      load_skills:
        - drafting
      artifact: draft_article
      timeout_seconds: 3600
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 60
    editor:
      run_mode: background_child
      agent: editor
      load_skills:
        - editorial-review
      artifact: editorial_packet
      timeout_seconds: 1800
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 60
    approver:
      run_mode: manual_gate
      agent: manager
      load_skills: []
      artifact: approval_packet
      timeout_seconds: 86400
    publisher:
      run_mode: background_child
      agent: publisher
      load_skills:
        - publish-content
      artifact: publish_result
      timeout_seconds: 900
      retry_policy:
        max_attempts: 3
        backoff_seconds:
          - 60
          - 300
  stages:
    draft:
      lifecycle_state: running
      role: writer
      on_success: editorial_review
      on_failed_retryable: draft
      on_failed_terminal: failed
    editorial_review:
      lifecycle_state: verifying
      role: editor
      on_success: approval
      on_fail_retryable: draft
      on_fail_terminal: failed
    approval:
      lifecycle_state: verified
      role: approver
      on_pass: publish
      on_fail_retryable: draft
      on_fail_terminal: failed
    publish:
      lifecycle_state: release_pending
      role: publisher
      on_success: completed
      on_blocked_transient: verified
      on_failed_terminal: failed
```

Create `tests/fixtures/workflows/office-report-delivery.yaml`:

```yaml
workflow:
  id: office_report_delivery
  version: "1.0"
  domain: office_automation
  artifact_schemas:
    spreadsheet_report:
      required_fields:
        - summary
        - workbook_path
        - data_sources
    review_packet:
      required_fields:
        - summary
        - review_notes
        - retryable
    approval_packet:
      required_fields:
        - summary
        - approved
    email_delivery_result:
      required_fields:
        - summary
        - recipient_count
        - confirmed_delivery
  event_mappings:
    manager_approved:
      runtime_event: gate_result
      status: pass
    email_sent:
      runtime_event: effect_result
      effect_type: send_email
  effects:
    send_email:
      adapter: email
      retryable: true
    archive_document:
      adapter: document_store
      retryable: true
  projection_targets:
    delivery_log:
      adapter: local_report
    office_dashboard:
      adapter: local_report
  roles:
    data_collector:
      run_mode: background_child
      agent: analyst
      load_skills:
        - spreadsheets
      artifact: spreadsheet_report
      timeout_seconds: 3600
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 60
    reviewer:
      run_mode: background_child
      agent: reviewer
      load_skills:
        - documents
      artifact: review_packet
      timeout_seconds: 1800
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 60
    manager_approval:
      run_mode: manual_gate
      agent: manager
      load_skills: []
      artifact: approval_packet
      timeout_seconds: 86400
    mailer:
      run_mode: background_child
      agent: office-automation
      load_skills:
        - email-delivery
      artifact: email_delivery_result
      timeout_seconds: 900
      retry_policy:
        max_attempts: 3
        backoff_seconds:
          - 60
          - 300
  stages:
    collect_data:
      lifecycle_state: running
      role: data_collector
      on_success: assemble_review
      on_failed_retryable: collect_data
      on_failed_terminal: failed
    assemble_review:
      lifecycle_state: verifying
      role: reviewer
      on_success: manager_review
      on_fail_retryable: collect_data
      on_fail_terminal: failed
    manager_review:
      lifecycle_state: verified
      role: manager_approval
      on_pass: send_email
      on_fail_retryable: collect_data
      on_fail_terminal: failed
    send_email:
      lifecycle_state: release_pending
      role: mailer
      on_success: completed
      on_blocked_transient: verified
      on_failed_terminal: failed
```

- [ ] **Step 4: Extend workflow definitions without changing core lifecycle states**

Modify `src/types/workflow.ts`:

```ts
export interface ArtifactSchemaDefinition {
  required_fields: string[];
}

export interface EventMappingDefinition {
  runtime_event: string;
  [key: string]: unknown;
}

export interface EffectDefinition {
  adapter: string;
  retryable: boolean;
  [key: string]: unknown;
}

export interface ProjectionTargetDefinition {
  adapter: string;
  [key: string]: unknown;
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  domain?: string;
  roles: Record<string, RoleDefinition>;
  stages: Record<string, StageDefinition>;
  artifact_schemas?: Record<string, ArtifactSchemaDefinition>;
  event_mappings?: Record<string, EventMappingDefinition>;
  effects?: Record<string, EffectDefinition>;
  projection_targets?: Record<string, ProjectionTargetDefinition>;
}
```

Implementation notes:

- Keep the lifecycle allow-list imported from `src/types/control-plane.ts`.
- Define built-in artifact schema names as `worker_result`, `evidence_packet`, and `release_result`.
- Accept role artifacts when they are either built-in artifact names or keys in `workflow.artifact_schemas`.
- Reject any `stage.lifecycle_state` that is not in `lifecycleStates`.
- Preserve unknown adapter-specific metadata inside `event_mappings`, `effects`, and `projection_targets` as typed records.
- Do not add coding role-name checks such as `issue_worker`, `pr_verifier`, or `release_worker`.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. The two non-coding workflow fixtures validate, domain-specific lifecycle states are rejected, and a content workflow advances or records facts through canonical child artifact, gate result, heartbeat, projection result, and effect result events.

- [ ] **Step 6: Commit Task 2A**

Run:

```bash
git add src/types/workflow.ts tests/workflow/domain-workflow.test.ts tests/runtime/state-machine.test.ts tests/fixtures/workflows/content-creation-publish.yaml tests/fixtures/workflows/office-report-delivery.yaml
git commit -m "feat: add domain-general workflow fixtures"
```

---

## Task 3: AC-17 Artifact Schema Validators

**Files:**
- Create: `src/runtime/artifacts.ts`
- Create: `tests/runtime/artifacts.test.ts`
- Modify: `src/runtime/state-machine.ts`
- Modify: `src/types/control-plane.ts`

- [ ] **Step 1: Write failing artifact schema tests**

Create `tests/runtime/artifacts.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateArtifactPayload,
  ArtifactValidationError,
  artifactRejectionHistory,
} from "../../src/runtime/artifacts.ts";

const common = {
  schema_version: "1.0",
  issue_number: 35,
  role: "issue_worker",
  status: "success",
  observed_at: "2026-05-29T04:00:00.000Z",
  summary: "done",
  retryable: false,
};

test("worker_result success requires branch metadata and compact changed files", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "worker_result",
    branch: "northstar/issue-35",
    base_branch: "main",
    commit_sha: "abc123",
    changed_files: ["src/runtime/artifacts.ts"],
    self_check_summary: "npm test passed",
  });

  assert.equal(artifact.artifact_kind, "worker_result");
  assert.equal(artifact.status, "success");
});

test("evidence_packet pass requires PR gate metadata", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "evidence_packet",
    role: "pr_verifier",
    status: "pass",
    pr_number: 42,
    base_branch: "main",
    gate_results: [{ name: "npm test", status: "pass" }],
    verifier: { session_id: "verifier-1" },
  });

  assert.equal(artifact.artifact_kind, "evidence_packet");
});

test("release_result success requires merge confirmation fields", () => {
  const artifact = validateArtifactPayload({
    ...common,
    artifact_kind: "release_result",
    role: "release_worker",
    pr_number: 42,
    merge_status: "merged",
    merged_sha: "def456",
    local_sync_result: { status: "success" },
    cleanup_result: { status: "success" },
  });

  assert.equal(artifact.artifact_kind, "release_result");
});

test("artifact validators reject invalid payloads with stable codes", () => {
  const invalidCases = [
    [{ ...common, artifact_kind: "worker_result" }, "ARTIFACT_MISSING_FIELD"],
    [{ ...common, artifact_kind: "evidence_packet", status: "pass" }, "ARTIFACT_MISSING_FIELD"],
    [{ ...common, artifact_kind: "release_result", merge_status: "merged" }, "ARTIFACT_MISSING_FIELD"],
    [{ ...common, artifact_kind: "unknown" }, "ARTIFACT_UNKNOWN_KIND"],
    [{ ...common, artifact_kind: "worker_result", status: "success", branch: "b", base_branch: "main", commit_sha: "c", changed_files: "src/a.ts", self_check_summary: "ok" }, "ARTIFACT_FIELD_TYPE"],
    [{ ...common, artifact_kind: "worker_result", status: "success", branch: "b", base_branch: "main", commit_sha: "c", changed_files: ["src/a.ts"], self_check_summary: "ok", raw_transcript: "secret" }, "ARTIFACT_RAW_LOG_REJECTED"],
    [{ ...common, artifact_kind: "worker_result", status: "blocked", retryable: false }, "ARTIFACT_RETRYABLE_MISMATCH"],
    [{ ...common, artifact_kind: "release_result", status: "success", pr_number: 42, merge_status: "open", merged_sha: "sha" }, "ARTIFACT_MERGE_NOT_CONFIRMED"],
    [{ ...common, artifact_kind: "worker_result", summary: "x".repeat(5001) }, "ARTIFACT_FIELD_TOO_LARGE"],
    [{ ...common, artifact_kind: "worker_result", issue_number: "35" }, "ARTIFACT_FIELD_TYPE"],
    [{ ...common, artifact_kind: "worker_result", observed_at: "not-a-date" }, "ARTIFACT_FIELD_TYPE"],
    [{ ...common, artifact_kind: "worker_result", retryable: "no" }, "ARTIFACT_FIELD_TYPE"],
  ] as const;

  assert.equal(invalidCases.length, 12);
  for (const [payload, code] of invalidCases) {
    assert.throws(
      () => validateArtifactPayload(payload),
      (error) => {
        assert.ok(error instanceof ArtifactValidationError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test("artifact rejection history is compact and auditable", () => {
  const history = artifactRejectionHistory("issue-35", {
    artifact_kind: "worker_result",
    role: "issue_worker",
    reason: "ARTIFACT_MISSING_FIELD",
    path: "branch",
  });

  assert.equal(history.event_type, "artifact_rejected");
  assert.equal(history.payload.reason, "ARTIFACT_MISSING_FIELD");
  assert.equal(history.payload.artifact_kind, "worker_result");
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `src/runtime/artifacts.ts` does not exist.

- [ ] **Step 3: Implement artifact validators**

Create `src/runtime/artifacts.ts` with:

```ts
import type { HistoryEntry } from "../types/control-plane.ts";

export type ArtifactKind = "worker_result" | "evidence_packet" | "release_result";
export type ArtifactStatus = "success" | "pass" | "blocked" | "failed_retryable" | "failed_terminal";

export type ArtifactValidationErrorCode =
  | "ARTIFACT_UNKNOWN_KIND"
  | "ARTIFACT_MISSING_FIELD"
  | "ARTIFACT_FIELD_TYPE"
  | "ARTIFACT_FIELD_TOO_LARGE"
  | "ARTIFACT_RAW_LOG_REJECTED"
  | "ARTIFACT_RETRYABLE_MISMATCH"
  | "ARTIFACT_MERGE_NOT_CONFIRMED";

export class ArtifactValidationError extends Error {
  constructor(
    readonly code: ArtifactValidationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "ArtifactValidationError";
  }
}

export interface NormalizedArtifact {
  schema_version: string;
  artifact_kind: ArtifactKind;
  issue_number: number;
  role: string;
  status: ArtifactStatus;
  observed_at: string;
  summary: string;
  retryable: boolean;
  payload: Record<string, unknown>;
}

const rawLogFields = new Set(["raw_transcript", "raw_browser_trace", "terminal_log", "full_log"]);
const allowedKinds = new Set(["worker_result", "evidence_packet", "release_result"]);

export function validateArtifactPayload(value: unknown): NormalizedArtifact {
  const record = objectValue(value, "artifact");
  for (const key of Object.keys(record)) {
    if (rawLogFields.has(key)) {
      throw new ArtifactValidationError("ARTIFACT_RAW_LOG_REJECTED", key, `${key} is not allowed in artifact payloads`);
    }
  }

  const artifact_kind = stringValue(record.artifact_kind, "artifact_kind") as ArtifactKind;
  if (!allowedKinds.has(artifact_kind)) {
    throw new ArtifactValidationError("ARTIFACT_UNKNOWN_KIND", "artifact_kind", `unknown artifact kind ${artifact_kind}`);
  }

  const normalized: NormalizedArtifact = {
    schema_version: stringValue(record.schema_version, "schema_version"),
    artifact_kind,
    issue_number: numberValue(record.issue_number, "issue_number"),
    role: stringValue(record.role, "role"),
    status: stringValue(record.status, "status") as ArtifactStatus,
    observed_at: isoDateValue(record.observed_at, "observed_at"),
    summary: compactStringValue(record.summary, "summary", 5000),
    retryable: booleanValue(record.retryable, "retryable"),
    payload: record,
  };

  if ((normalized.status === "blocked" || normalized.status === "failed_retryable") && !normalized.retryable) {
    throw new ArtifactValidationError("ARTIFACT_RETRYABLE_MISMATCH", "retryable", `${normalized.status} artifacts must be retryable`);
  }

  if (artifact_kind === "worker_result" && normalized.status === "success") {
    requireString(record.branch, "branch");
    requireString(record.base_branch, "base_branch");
    requireString(record.commit_sha, "commit_sha");
    requireStringArray(record.changed_files, "changed_files");
    requireString(record.self_check_summary, "self_check_summary");
  }

  if (artifact_kind === "evidence_packet" && normalized.status === "pass") {
    numberValue(record.pr_number, "pr_number");
    requireString(record.base_branch, "base_branch");
    requireArray(record.gate_results, "gate_results");
    objectValue(record.verifier, "verifier");
  }

  if (artifact_kind === "release_result" && normalized.status === "success") {
    numberValue(record.pr_number, "pr_number");
    const mergeStatus = stringValue(record.merge_status, "merge_status");
    if (mergeStatus !== "merged") {
      throw new ArtifactValidationError("ARTIFACT_MERGE_NOT_CONFIRMED", "merge_status", "release success requires merge_status=merged");
    }
    requireString(record.merged_sha, "merged_sha");
  }

  return normalized;
}

export function artifactRejectionHistory(issueId: string, rejection: Record<string, unknown>): HistoryEntry {
  return {
    issue_id: issueId,
    event_type: "artifact_rejected",
    payload: {
      artifact_kind: rejection.artifact_kind,
      role: rejection.role,
      reason: rejection.reason,
      path: rejection.path,
    },
  };
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", path, `${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ArtifactValidationError(value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE", path, `${path} must be a non-empty string`);
  }
  return value;
}

function requireString(value: unknown, path: string): void {
  stringValue(value, path);
}

function compactStringValue(value: unknown, path: string, maxLength: number): string {
  const text = stringValue(value, path);
  if (text.length > maxLength) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TOO_LARGE", path, `${path} must be at most ${maxLength} characters`);
  }
  return text;
}

function numberValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArtifactValidationError(value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE", path, `${path} must be a number`);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ArtifactValidationError(value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE", path, `${path} must be a boolean`);
  }
  return value;
}

function isoDateValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", path, `${path} must be an ISO timestamp`);
  }
  return text;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ArtifactValidationError(value === undefined ? "ARTIFACT_MISSING_FIELD" : "ARTIFACT_FIELD_TYPE", path, `${path} must be an array`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  const array = requireArray(value, path);
  if (!array.every((item) => typeof item === "string")) {
    throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", path, `${path} must be an array of strings`);
  }
  return array as string[];
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS for artifact validator tests.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add src/runtime/artifacts.ts tests/runtime/artifacts.test.ts
git commit -m "feat: add artifact schema validators"
```

---

## Task 4: AC-17 Artifact Rejection Integration

**Files:**
- Modify: `src/runtime/state-machine.ts`
- Modify: `tests/runtime/state-machine.test.ts`

- [ ] **Step 1: Write failing state-machine rejection test**

Append to `tests/runtime/state-machine.test.ts`:

```ts
test("invalid child artifact records artifact rejection without advancing lifecycle", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml"));
  const snapshot = newIssueSnapshot("artifact-reject-1", {
    lifecycle_state: "running",
    runtime_context_json: {
      stage_cursor: "implementation",
      child_runs: [{
        child_run_id: "child-1",
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "issue_worker",
        status: "running",
        session_id: "session-1",
        started_at: now,
        last_seen_at: now,
      }],
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "child_artifact",
    child_run_id: "child-1",
    role: "issue_worker",
    artifact_kind: "worker_result",
    status: "succeeded",
    artifact_history_id: 999,
    at: now,
    observed_at: now,
    payload: { artifact_kind: "worker_result", status: "success" },
  }]);

  assert.equal(result.snapshot.lifecycle_state, "running");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), true);
  assert.equal(result.snapshot.runtime_context_json.child_runs?.[0]?.status, "running");
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because invalid artifacts currently advance from child events without schema validation.

- [ ] **Step 3: Validate artifacts in state machine**

Modify `src/runtime/state-machine.ts` near child artifact handling:

```ts
import { ArtifactValidationError, artifactRejectionHistory, validateArtifactPayload } from "./artifacts.ts";
```

Inside the child artifact branch before lifecycle advancement:

```ts
  const artifactStatus = event.status === "succeeded" ? "success" : event.status;
  try {
    validateArtifactPayload({
      schema_version: event.schema_version ?? "1.0",
      artifact_kind: event.artifact_kind,
      issue_number: Number(result.snapshot.issue_id),
      role: event.role,
      status: artifactStatus,
      observed_at: event.observed_at ?? new Date(0).toISOString(),
      summary: event.summary ?? "",
      retryable: event.retryable ?? event.status === "blocked" || event.status === "failed_retryable",
      ...(event.payload ?? {}),
    });
  } catch (error) {
    if (error instanceof ArtifactValidationError) {
      result.history.push(artifactRejectionHistory(result.snapshot.issue_id, {
        artifact_kind: event.artifact_kind,
        role: event.role,
        reason: error.code,
        path: error.path,
      }));
      return;
    }
    throw error;
  }
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. Invalid artifact submission records `artifact_rejected` and does not advance lifecycle.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add src/runtime/state-machine.ts tests/runtime/state-machine.test.ts
git commit -m "feat: reject invalid child artifacts"
```

---

## Task 5: AC-20 Redaction And Credential Providers

**Files:**
- Create: `src/runtime/redaction.ts`
- Create: `src/runtime/credentials.ts`
- Create: `tests/runtime/security.test.ts`
- Modify: `src/adapters/github/remote.ts`
- Modify: `src/runtime/inspect.ts`

- [ ] **Step 1: Write failing security tests**

Create `tests/runtime/security.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, compactHistoryPayload } from "../../src/runtime/redaction.ts";
import { FakeCredentialProvider } from "../../src/runtime/credentials.ts";
import { GitHubRemoteProjectionAdapter } from "../../src/adapters/github/remote.ts";
import { inspectSnapshot } from "../../src/runtime/inspect.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("redaction removes token-shaped values from nested payloads", () => {
  assert.deepEqual(redactSecrets({
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    nested: { authorization: "Bearer gho_abcdefghijklmnopqrstuvwxyz123456" },
  }), {
    token: "[REDACTED]",
    nested: { authorization: "[REDACTED]" },
  });
});

test("compact history payload rejects oversized raw logs", () => {
  assert.throws(
    () => compactHistoryPayload({ raw_transcript: "x".repeat(5000) }),
    /raw_transcript/,
  );
});

test("fake credential provider resolves configured credential names without exposing real tokens", async () => {
  const provider = new FakeCredentialProvider({ github: "ghp_fake_for_test" });
  assert.equal(await provider.resolve("github"), "ghp_fake_for_test");
  assert.equal(provider.describe("github"), "credential:github");
});

test("github projection errors are redacted", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    fetch: async () => new Response("failed Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456", { status: 500 }),
    now: () => "2026-05-29T03:00:00.000Z",
  });

  const result = await adapter.syncLabel({ issue_number: 1, labels: ["northstar"] });
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.last_error, /ghp_/);
  assert.match(result.last_error, /\[REDACTED\]/);
});

test("inspect output redacts secret-shaped projection payloads", () => {
  const report = inspectSnapshot(newIssueSnapshot("inspect-secret", {
    runtime_context_json: {
      projection_sync: [{
        projection_target: "label",
        status: "failed",
        last_error: "token ghp_abcdefghijklmnopqrstuvwxyz123456",
      }],
    },
  }), "2026-05-29T03:00:00.000Z");

  assert.doesNotMatch(report, /ghp_/);
  assert.match(report, /\[REDACTED\]/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because redaction and credential modules do not exist.

- [ ] **Step 3: Implement redaction helpers**

Create `src/runtime/redaction.ts`:

```ts
const tokenPattern = /\b(?:ghp|gho|github_pat|sk|xoxb|xoxp)_[A-Za-z0-9_=-]{16,}\b|Bearer\s+[A-Za-z0-9_./+=-]{20,}/g;
const rawLogFields = new Set(["raw_transcript", "raw_browser_trace", "terminal_log", "full_log"]);

export function redactSecrets<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(tokenPattern, "[REDACTED]") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = key.toLowerCase().includes("authorization") || key.toLowerCase().includes("token")
        ? "[REDACTED]"
        : redactSecrets(nested);
    }
    return output as T;
  }
  return value;
}

export function compactHistoryPayload(payload: Record<string, unknown>, maxStringLength = 4000): Record<string, unknown> {
  for (const key of Object.keys(payload)) {
    if (rawLogFields.has(key)) {
      throw new Error(`${key} is not allowed in history payloads`);
    }
  }
  return redactSecrets(truncateStrings(payload, maxStringLength));
}

function truncateStrings(value: unknown, maxStringLength: number): unknown {
  if (typeof value === "string") {
    return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}...[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateStrings(item, maxStringLength));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, truncateStrings(nested, maxStringLength)]));
  }
  return value;
}
```

- [ ] **Step 4: Implement credential provider abstraction**

Create `src/runtime/credentials.ts`:

```ts
export interface CredentialProvider {
  resolve(name: string): Promise<string>;
  describe(name: string): string;
}

export class FakeCredentialProvider implements CredentialProvider {
  constructor(private readonly credentials: Record<string, string>) {}

  async resolve(name: string): Promise<string> {
    const value = this.credentials[name];
    if (!value) {
      throw new Error(`Missing fake credential ${name}`);
    }
    return value;
  }

  describe(name: string): string {
    return `credential:${name}`;
  }
}
```

- [ ] **Step 5: Apply redaction to projection and inspect surfaces**

Modify `src/adapters/github/remote.ts`:

```ts
import { redactSecrets } from "../../runtime/redaction.ts";
```

Wrap remote response text in projection failures:

```ts
const responseText = redactSecrets(await response.text());
```

Modify `src/runtime/inspect.ts`:

```ts
import { redactSecrets } from "./redaction.ts";
```

When rendering projection errors:

```ts
String(redactSecrets(item.last_error ?? ""))
```

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. Secret-shaped values are redacted from projection and inspect surfaces.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add src/runtime/redaction.ts src/runtime/credentials.ts src/adapters/github/remote.ts src/runtime/inspect.ts tests/runtime/security.test.ts
git commit -m "feat: add runtime redaction and credential providers"
```

---

## Task 6: AC-18 Intake Adapters And Idempotent Store Writes

**Files:**
- Create: `src/intake/types.ts`
- Create: `src/intake/local.ts`
- Create: `src/intake/github.ts`
- Create: `tests/intake/intake.test.ts`
- Modify: `src/runtime/store.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing intake tests**

Create `tests/intake/intake.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalIssuePackets } from "../../src/intake/local.ts";
import { GitHubIssueIntakeAdapter } from "../../src/intake/github.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

test("local seeded intake works without GitHub credentials or projection calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-intake-"));
  try {
    const fixture = join(dir, "issue.yaml");
    await writeFile(fixture, [
      "issue_number: local-1",
      "title: Local seed",
      "source: local",
      "source_url: file://issue.yaml",
      "branch: northstar/local-1",
      "base_branch: main",
      "labels:",
      "  - northstar",
      "dependencies: []",
      "raw_text: Build local fixture",
      "ready_for_agent: true",
      "",
    ].join("\n"));

    const packets = await loadLocalIssuePackets([fixture]);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].source, "local");
    assert.equal(packets[0].ready_for_agent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("github intake normalizes issues from configured repo", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response(JSON.stringify([
      {
        number: 35,
        title: "Implement feature",
        html_url: "https://github.com/owner/repo/issues/35",
        body: "Issue body",
        labels: [{ name: "ready" }],
      },
    ]), { status: 200 }),
  });

  const packets = await adapter.listIssuePackets();
  assert.deepEqual(packets[0], {
    issue_number: "35",
    title: "Implement feature",
    source: "github",
    source_url: "https://github.com/owner/repo/issues/35",
    branch: "northstar/issue-35",
    base_branch: "main",
    labels: ["ready"],
    dependencies: [],
    raw_text: "Issue body",
    ready_for_agent: true,
  });
});

test("intake upsert is idempotent and appends auditable history facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-store-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));
  try {
    const packet = {
      issue_number: "local-1",
      title: "Local seed",
      source: "local",
      source_url: "file://issue.yaml",
      branch: "northstar/local-1",
      base_branch: "main",
      labels: ["northstar"],
      dependencies: [],
      raw_text: "Build local fixture",
      ready_for_agent: true,
    };

    store.upsertIssuePacket(packet);
    store.upsertIssuePacket({ ...packet, title: "Local seed updated" });

    const issues = store.listAllIssuesForTests();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].runtime_context_json.issue_packet.title, "Local seed updated");

    const history = store.listHistoryForTests("local:local-1");
    assert.equal(history.filter((entry) => entry.event_type === "intake_packet").length, 2);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `src/intake/*` and store intake helpers do not exist.

- [ ] **Step 3: Implement normalized intake types**

Create `src/intake/types.ts`:

```ts
export interface IssuePacket {
  issue_number: string;
  title: string;
  source: "github" | "local";
  source_url: string;
  branch: string;
  base_branch: string;
  labels: string[];
  dependencies: string[];
  raw_text: string;
  ready_for_agent: boolean;
}

export function issuePacketId(packet: IssuePacket): string {
  return `${packet.source}:${packet.issue_number}`;
}
```

- [ ] **Step 4: Implement local intake**

Create `src/intake/local.ts`:

```ts
import { readFile } from "node:fs/promises";
import { parseYamlSubset } from "../config/load-config.ts";
import type { IssuePacket } from "./types.ts";

export async function loadLocalIssuePackets(paths: string[]): Promise<IssuePacket[]> {
  const packets: IssuePacket[] = [];
  for (const path of paths) {
    const parsed = parseYamlSubset(await readFile(path, "utf8"));
    packets.push(normalizeLocalIssuePacket(parsed));
  }
  return packets;
}

function normalizeLocalIssuePacket(value: unknown): IssuePacket {
  const record = value as Record<string, unknown>;
  return {
    issue_number: String(record.issue_number),
    title: String(record.title),
    source: "local",
    source_url: String(record.source_url),
    branch: String(record.branch),
    base_branch: String(record.base_branch),
    labels: record.labels as string[],
    dependencies: record.dependencies as string[],
    raw_text: String(record.raw_text),
    ready_for_agent: record.ready_for_agent === true,
  };
}
```

- [ ] **Step 5: Implement GitHub intake**

Create `src/intake/github.ts`:

```ts
import type { IssuePacket } from "./types.ts";

export interface GitHubIssueIntakeAdapterOptions {
  repo: string;
  token: string;
  fetch?: typeof fetch;
  baseBranch?: string;
}

export class GitHubIssueIntakeAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly baseBranch: string;

  constructor(private readonly options: GitHubIssueIntakeAdapterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseBranch = options.baseBranch ?? "main";
  }

  async listIssuePackets(): Promise<IssuePacket[]> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.options.repo}/issues?state=open`, {
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub issue intake failed with ${response.status}: ${await response.text()}`);
    }
    const issues = await response.json() as Array<{
      number: number;
      title: string;
      html_url: string;
      body?: string | null;
      labels?: Array<{ name?: string }>;
    }>;
    return issues.map((issue) => ({
      issue_number: String(issue.number),
      title: issue.title,
      source: "github",
      source_url: issue.html_url,
      branch: `northstar/issue-${issue.number}`,
      base_branch: this.baseBranch,
      labels: (issue.labels ?? []).map((label) => String(label.name ?? "")).filter(Boolean),
      dependencies: [],
      raw_text: issue.body ?? "",
      ready_for_agent: true,
    }));
  }
}
```

- [ ] **Step 6: Add idempotent store upsert**

Modify `src/runtime/store.ts`:

```ts
import type { IssuePacket } from "../intake/types.ts";
import { issuePacketId } from "../intake/types.ts";
```

Add methods:

```ts
  upsertIssuePacket(packet: IssuePacket): void {
    const issueId = issuePacketId(packet);
    const existingRow = this.db.prepare("SELECT snapshot_json FROM issues WHERE id = ?").get(issueId);
    const snapshot = existingRow
      ? JSON.parse(String((existingRow as { snapshot_json: string }).snapshot_json)) as IssueSnapshot
      : newIssueSnapshot(issueId, { lifecycle_state: packet.ready_for_agent ? "ready" : "quarantined" });
    snapshot.runtime_context_json = {
      ...snapshot.runtime_context_json,
      issue_packet: packet,
    };

    this.db.exec("BEGIN");
    try {
      const sequence = this.nextSequence(issueId);
      this.insertHistory(issueId, sequence, {
        issue_id: issueId,
        event_type: "intake_packet",
        payload: packet,
      });
      if (existingRow) {
        this.updateSnapshot(issueId, snapshot);
      } else {
        this.insertSnapshot(snapshot);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listAllIssuesForTests(): IssueSnapshot[] {
    return this.db.prepare("SELECT snapshot_json FROM issues ORDER BY issue_id").all()
      .map((row) => JSON.parse(String((row as { snapshot_json: string }).snapshot_json)) as IssueSnapshot);
  }

  listHistoryForTests(issueId: string): HistoryEntry[] {
    return this.db.prepare("SELECT payload_json, event_type, issue_id FROM issue_history WHERE issue_id = ? ORDER BY id").all(issueId)
      .map((row) => ({
        issue_id: String((row as { issue_id: string }).issue_id),
        event_type: String((row as { event_type: string }).event_type),
        payload: JSON.parse(String((row as { payload_json: string }).payload_json)),
      }));
  }

  private insertSnapshot(snapshot: IssueSnapshot): void {
    validateSnapshot(snapshot);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO issues (
        id,
        lifecycle_state,
        current_session_id,
        worktree_path,
        runtime_context_json,
        snapshot_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.issue_id,
      snapshot.lifecycle_state,
      snapshot.current_session_id ?? null,
      snapshot.worktree_path ?? null,
      JSON.stringify(snapshot.runtime_context_json),
      JSON.stringify(snapshot),
      now,
    );
  }
```

- [ ] **Step 7: Import intake test in test index**

Modify `tests/index.test.ts`:

```ts
await import("./intake/intake.test.ts");
```

- [ ] **Step 8: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. Intake is idempotent and uses only existing runtime tables.

- [ ] **Step 9: Commit Task 6**

Run:

```bash
git add src/intake src/runtime/store.ts tests/intake tests/index.test.ts
git commit -m "feat: add idempotent issue intake"
```

---

## Task 7: AC-19 Watch Loop

**Files:**
- Create: `src/runtime/watch.ts`
- Create: `tests/runtime/watch.test.ts`
- Modify: `src/cli/northstar.ts`
- Modify: `tests/cli/cli.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing watch tests**

Create `tests/runtime/watch.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createWatchLoop } from "../../src/runtime/watch.ts";

test("watch loop reconstructs work from store on each cycle", async () => {
  const loaded: string[] = [];
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 2,
    acquireWriter: async () => ({ release: async () => undefined }),
    runCycle: async () => {
      loaded.push("cycle");
      return { activeIssues: 1, effectsStarted: 0 };
    },
    sleep: async () => undefined,
    shouldStop: () => false,
  });

  const result = await loop.run();
  assert.equal(result.cycles, 2);
  assert.deepEqual(loaded, ["cycle", "cycle"]);
});

test("watch loop stops before starting new effects after shutdown begins", async () => {
  let cycles = 0;
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 5,
    acquireWriter: async () => ({ release: async () => undefined }),
    runCycle: async () => {
      cycles += 1;
      return { activeIssues: 1, effectsStarted: 1 };
    },
    sleep: async () => undefined,
    shouldStop: () => cycles >= 1,
  });

  const result = await loop.run();
  assert.equal(result.cycles, 1);
});

test("watch loop enforces one writer per project", async () => {
  const loop = createWatchLoop({
    intervalMs: 1,
    maxCycles: 1,
    acquireWriter: async () => undefined,
    runCycle: async () => ({ activeIssues: 0, effectsStarted: 0 }),
    sleep: async () => undefined,
    shouldStop: () => false,
  });

  const result = await loop.run();
  assert.equal(result.cycles, 0);
  assert.equal(result.skipped_reason, "writer_lock_unavailable");
});
```

- [ ] **Step 2: Write failing CLI test for watch**

Append to `tests/cli/cli.test.ts`:

```ts
test("watch command is part of the CLI surface", () => {
  const parsed = runNorthstarCli(["watch"]);
  assert.equal(parsed.command, "watch");
  assert.match(formatNorthstarHelp(), /northstar watch/);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `src/runtime/watch.ts` does not exist and `watch` is not a CLI command.

- [ ] **Step 4: Implement watch loop abstraction**

Create `src/runtime/watch.ts`:

```ts
export interface WatchWriterLease {
  release(): Promise<void>;
}

export interface WatchCycleResult {
  activeIssues: number;
  effectsStarted: number;
}

export interface WatchLoopOptions {
  intervalMs: number;
  maxCycles?: number;
  acquireWriter(): Promise<WatchWriterLease | undefined>;
  runCycle(): Promise<WatchCycleResult>;
  sleep(ms: number): Promise<void>;
  shouldStop(): boolean;
}

export interface WatchLoopResult {
  cycles: number;
  skipped_reason?: "writer_lock_unavailable";
}

export function createWatchLoop(options: WatchLoopOptions) {
  return {
    async run(): Promise<WatchLoopResult> {
      const writer = await options.acquireWriter();
      if (!writer) {
        return { cycles: 0, skipped_reason: "writer_lock_unavailable" };
      }
      let cycles = 0;
      try {
        while (!options.shouldStop() && (options.maxCycles === undefined || cycles < options.maxCycles)) {
          await options.runCycle();
          cycles += 1;
          if (options.shouldStop() || cycles === options.maxCycles) {
            break;
          }
          await options.sleep(options.intervalMs);
        }
        return { cycles };
      } finally {
        await writer.release();
      }
    },
  };
}
```

- [ ] **Step 5: Add watch CLI command**

Modify `src/cli/northstar.ts`:

```ts
export const CLI_COMMANDS = [
  "init",
  "intake",
  "start",
  "reconcile",
  "reconcile-workspace",
  "heartbeat",
  "release",
  "repair-runtime",
  "inspect",
  "retry-sync",
  "watch",
];
```

- [ ] **Step 6: Import watch tests in test index**

Modify `tests/index.test.ts`:

```ts
await import("./runtime/watch.test.ts");
```

- [ ] **Step 7: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. Watch loop behavior is covered without daemonizing the test process.

- [ ] **Step 8: Commit Task 7**

Run:

```bash
git add src/runtime/watch.ts src/cli/northstar.ts tests/runtime/watch.test.ts tests/cli/cli.test.ts tests/index.test.ts
git commit -m "feat: add watch loop abstraction"
```

---

## Task 8: AC-21 Packaging Version And Local Install Smoke

**Files:**
- Modify: `src/cli/northstar.ts`
- Modify: `src/cli/entrypoint.ts`
- Create: `tests/cli/packaging.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing packaging tests**

Create `tests/cli/packaging.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

test("package exposes northstar binary and supported node range", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.bin.northstar, "src/cli/entrypoint.ts");
  assert.match(pkg.engines.node, />=22\.22\.2/);
});

test("entrypoint prints version and help through node run script", () => {
  const version = spawnSync("node", ["--run", "northstar", "--", "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /0\.1\.0/);

  const help = spawnSync("node", ["--run", "northstar", "--", "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /northstar watch/);
});

test("npm pack dry run includes CLI source and fixtures", () => {
  const result = spawnSync("npm", ["pack", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, /src\/cli\/entrypoint\.ts/);
  assert.match(result.stdout + result.stderr, /package\.json/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `--version` is not handled.

- [ ] **Step 3: Add version formatter**

Modify `src/cli/northstar.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function formatNorthstarVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
  return String(pkg.version);
}
```

- [ ] **Step 4: Add entrypoint version handling**

Modify `src/cli/entrypoint.ts`:

```ts
import { formatNorthstarHelp, formatNorthstarVersion, runNorthstarCli } from "./northstar.ts";

if (argv[0] === "--version" || argv[0] === "-v") {
  stdout.write(`${formatNorthstarVersion()}\n`);
  return 0;
}
```

- [ ] **Step 5: Import packaging tests in test index**

Modify `tests/index.test.ts`:

```ts
await import("./cli/packaging.test.ts");
```

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. CLI can print help and version through local package script, and `npm pack --dry-run` includes expected package files.

- [ ] **Step 7: Commit Task 8**

Run:

```bash
git add src/cli/northstar.ts src/cli/entrypoint.ts tests/cli/packaging.test.ts tests/index.test.ts
git commit -m "feat: add packaging smoke coverage"
```

---

## Task 9: AC-22 And AC-23 Coverage Mapping And Spec Compliance

**Files:**
- Create: `docs/superpowers/ac16-ac23-coverage.md`
- Create: `docs/superpowers/full-ac-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Write failing spec compliance test**

Append to `tests/spec/spec-compliance.test.ts`:

```ts
test("full coverage matrix maps AC-01 through AC-23", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/full-ac-coverage.md"), "utf8");
  for (let ac = 1; ac <= 23; ac += 1) {
    const id = `AC-${String(ac).padStart(2, "0")}`;
    assert.match(matrix, new RegExp(`\\| ${id} `), `${id} should be mapped`);
  }
  for (const phrase of [
    "tests/workflow/workflow-validation.test.ts",
    "tests/runtime/artifacts.test.ts",
    "tests/intake/intake.test.ts",
    "tests/runtime/watch.test.ts",
    "tests/runtime/security.test.ts",
    "tests/cli/packaging.test.ts",
    "tests/workflow/domain-workflow.test.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(phrase)));
  }
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because full coverage docs do not exist or do not include AC-23.

- [ ] **Step 3: Add AC-16 through AC-23 matrix**

Create `docs/superpowers/ac16-ac23-coverage.md`:

```md
# Northstar AC-16 Through AC-23 Coverage Matrix

| AC | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-16 | Workflow validation rejects invalid fixtures with stable machine-readable error codes. | `tests/workflow/workflow-validation.test.ts`, `tests/fixtures/workflows/invalid/*.yaml` | `src/types/workflow.ts`, `src/types/workflow-validation.ts` |
| AC-17 | Artifact schemas validate worker, evidence, and release payloads and reject invalid/raw-log artifacts with auditable rejection history. | `tests/runtime/artifacts.test.ts`, `tests/runtime/state-machine.test.ts` | `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts` |
| AC-18 | GitHub and local seeded intake normalize issue packets and idempotently upsert issue snapshots with history facts. | `tests/intake/intake.test.ts` | `src/intake/types.ts`, `src/intake/local.ts`, `src/intake/github.ts`, `src/runtime/store.ts` |
| AC-19 | Watch loop reconstructs from durable state each cycle, handles shutdown, and enforces a single writer abstraction. | `tests/runtime/watch.test.ts`, `tests/cli/cli.test.ts` | `src/runtime/watch.ts`, `src/cli/northstar.ts` |
| AC-20 | Runtime redacts token-shaped values, rejects raw logs, and resolves credentials through fake-testable providers. | `tests/runtime/security.test.ts` | `src/runtime/redaction.ts`, `src/runtime/credentials.ts`, `src/adapters/github/remote.ts`, `src/runtime/inspect.ts` |
| AC-21 | Package metadata exposes the CLI binary, Node range, help output, version output, and local pack smoke. | `tests/cli/packaging.test.ts` | `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts` |
| AC-22 | Planning documents map AC-01 through AC-23 to milestones and verification commands. | `tests/spec/spec-compliance.test.ts` | `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/ac16-ac23-coverage.md` |
| AC-23 | Domain-general workflow fixtures validate content creation and office automation without adding lifecycle states or coding role chains. | `tests/workflow/domain-workflow.test.ts`, `tests/runtime/state-machine.test.ts` | `src/types/workflow.ts`, `src/runtime/state-machine.ts`, `tests/fixtures/workflows/content-creation-publish.yaml`, `tests/fixtures/workflows/office-report-delivery.yaml` |
```

- [ ] **Step 4: Add full AC coverage matrix**

Create `docs/superpowers/full-ac-coverage.md` with one row for every AC:

```md
# Northstar Full Acceptance Coverage Matrix

| AC | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-01 | Project bootstrap and old Python runtime exclusion. | `tests/spec/spec-compliance.test.ts` | `package.json`, `src/**` |
| AC-02 | Config loading, schema validation, and env guardrails. | `tests/config/load-config.test.ts` | `src/config/load-config.ts`, `src/config/schema.ts` |
| AC-03 | SQLite store tables, transactions, rollback, and idempotent records. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| AC-04 | Workflow generality without hard-coded release chain. | `tests/workflow/workflow.test.ts` | `src/types/workflow.ts`, `src/runtime/engine.ts` |
| AC-05 | Role overrides and host adapter role payloads. | `tests/workflow/workflow.test.ts`, `tests/adapters/adapters.test.ts` | `src/types/workflow.ts`, `src/adapters/host/*.ts` |
| AC-06 | Owner lease invariants and quarantined resume rules. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts` |
| AC-07 | Heartbeat sequencing, timestamps, expiry, and liveness cases. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts` |
| AC-08 | Background child runs and artifact-driven advancement. | `tests/runtime/state-machine.test.ts`, `tests/adapters/adapters.test.ts` | `src/runtime/state-machine.ts`, `src/adapters/host/fake.ts` |
| AC-09 | GitHub projection retryable failure semantics. | `tests/adapters/adapters.test.ts`, `tests/runtime/engine-cycle.test.ts` | `src/adapters/github/projector.ts`, `src/adapters/github/remote.ts` |
| AC-10 | Release semantics and retryable sync/cleanup failures. | `tests/runtime/state-machine.test.ts`, `tests/adapters/adapters.test.ts` | `src/runtime/state-machine.ts`, `src/adapters/git/worktrees.ts` |
| AC-11 | Dedicated sync worktree planning and root checkout prevention. | `tests/adapters/adapters.test.ts` | `src/adapters/git/worktrees.ts` |
| AC-12 | Cross-platform paths and argv process specs. | `tests/adapters/adapters.test.ts`, `tests/spec/spec-compliance.test.ts` | `src/adapters/platform/paths.ts`, `src/adapters/platform/process.ts` |
| AC-13 | Runtime repair normalizes stale leases/projections and writes admin history. | `tests/runtime/repair-inspect.test.ts` | `src/runtime/repair.ts` |
| AC-14 | Inspect separates lifecycle, lease, child runs, and projection sync. | `tests/runtime/repair-inspect.test.ts` | `src/runtime/inspect.ts` |
| AC-15 | Test gate and source/test coverage. | `tests/index.test.ts`, `tests/spec/spec-compliance.test.ts` | `tests/**`, `docs/superpowers/*.md` |
| AC-16 | Workflow schema invalid fixtures and stable error codes. | `tests/workflow/workflow-validation.test.ts` | `src/types/workflow.ts`, `src/types/workflow-validation.ts` |
| AC-17 | Artifact schemas and artifact rejection history. | `tests/runtime/artifacts.test.ts`, `tests/runtime/state-machine.test.ts` | `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts` |
| AC-18 | GitHub/local intake and idempotent intake facts. | `tests/intake/intake.test.ts` | `src/intake/*.ts`, `src/runtime/store.ts` |
| AC-19 | Watch loop restart/shutdown/writer behavior. | `tests/runtime/watch.test.ts`, `tests/cli/cli.test.ts` | `src/runtime/watch.ts`, `src/cli/northstar.ts` |
| AC-20 | Security redaction, raw log rejection, fake credential providers. | `tests/runtime/security.test.ts` | `src/runtime/redaction.ts`, `src/runtime/credentials.ts` |
| AC-21 | CLI binary, Node range, version/help, local pack smoke. | `tests/cli/packaging.test.ts` | `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts` |
| AC-22 | Planning document maps AC-01 through AC-23 to implementation and verification. | `tests/spec/spec-compliance.test.ts` | `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/ac16-ac23-coverage.md` |
| AC-23 | Workflow domain generality for content creation and office automation. | `tests/workflow/domain-workflow.test.ts`, `tests/runtime/state-machine.test.ts` | `src/types/workflow.ts`, `src/runtime/state-machine.ts`, `tests/fixtures/workflows/content-creation-publish.yaml`, `tests/fixtures/workflows/office-report-delivery.yaml` |
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS. Full coverage matrix maps AC-01 through AC-23.

- [ ] **Step 6: Commit Task 9**

Run:

```bash
git add docs/superpowers/ac16-ac23-coverage.md docs/superpowers/full-ac-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map full northstar acceptance coverage"
```

---

## Task 10: Final Verification Gate

**Files:**
- Read-only verification unless a failure requires a TDD fix

- [ ] **Step 1: Run unit test suite**

Run:

```bash
npm test
```

Expected: PASS with all AC-16 through AC-23 tests included.

- [ ] **Step 2: Run CLI help and version smoke**

Run:

```bash
node --run northstar -- --help
node --run northstar -- --version
```

Expected: help includes `northstar watch`; version prints `0.1.0`.

- [ ] **Step 3: Run forbidden dependency scan**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
```

Expected: no matches.

- [ ] **Step 4: Run direct env-read scan**

Run:

```bash
rg "process\\.env\\." src
```

Expected: no matches. The existing config loader may read `process.env` as a default object, but production modules must not read `process.env.SOME_KEY`.

- [ ] **Step 5: Run shell-chain scan**

Run:

```bash
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
```

Expected: no matches.

- [ ] **Step 6: Run git status**

Run:

```bash
git status --short
```

Expected: clean after the final commit, or only intentional uncommitted files explicitly reported.

- [ ] **Step 7: Optional live smoke**

Run only when live credentials/config are intentionally available:

```bash
npm run test:live
```

Expected: either live tests pass with non-skipped evidence, or tests skip with explicit missing configuration. Unit completion does not require live credentials for AC-16 through AC-23.

- [ ] **Step 8: Final report**

Report:

```md
## AC-16 Through AC-23 Completion

- AC-16 Workflow Schema: `tests/workflow/workflow-validation.test.ts`, `tests/fixtures/workflows/invalid/*.yaml`, `src/types/workflow.ts`, `src/types/workflow-validation.ts`
- AC-17 Artifact Schemas: `tests/runtime/artifacts.test.ts`, `tests/runtime/state-machine.test.ts`, `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts`
- AC-18 Intake: `tests/intake/intake.test.ts`, `src/intake/types.ts`, `src/intake/local.ts`, `src/intake/github.ts`, `src/runtime/store.ts`
- AC-19 Watch: `tests/runtime/watch.test.ts`, `tests/cli/cli.test.ts`, `src/runtime/watch.ts`, `src/cli/northstar.ts`
- AC-20 Security: `tests/runtime/security.test.ts`, `src/runtime/redaction.ts`, `src/runtime/credentials.ts`, `src/adapters/github/remote.ts`, `src/runtime/inspect.ts`
- AC-21 Packaging: `tests/cli/packaging.test.ts`, `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts`
- AC-22 Code Goal Mapping: `tests/spec/spec-compliance.test.ts`, `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/ac16-ac23-coverage.md`
- AC-23 Workflow Domain Generality: `tests/workflow/domain-workflow.test.ts`, `tests/runtime/state-machine.test.ts`, `tests/fixtures/workflows/content-creation-publish.yaml`, `tests/fixtures/workflows/office-report-delivery.yaml`, `src/types/workflow.ts`

## Verification

- npm test: report Node test pass count and failing test details if any remain.
- CLI help/version: report whether `northstar watch`, help output, and version output are present.
- forbidden scans: report exact matches for forbidden Python/autodev dependencies, direct env reads, and shell-chain commands.
- git status: report clean status or list intentional uncommitted files.

## Deferred Work

- Host-specific production credential provider implementations beyond fake-testable abstraction.
- End-to-end daemon operation under a real process supervisor.
- Live GitHub intake smoke, if desired, as a separate live goal.
```

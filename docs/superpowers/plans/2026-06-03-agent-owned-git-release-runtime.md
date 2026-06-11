# Agent-Owned Git Release Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 2026-06-03 agent-owned git release design so Northstar keeps durable workflow control while agents own git, PR, merge, release, and recovery operations, with workflow-driven `exception` handling.

**Architecture:** Add `exception` as a non-active workflow-recovery lifecycle, validate `workflow.exception_policy`, and resolve exception issues through a pure policy resolver called by reconcile/watch. Move software-development delivery from Northstar-owned git/GitHub operations to JSON task contracts and schema-valid agent artifacts (`implementation_result`, `verification_result`, `release_result`). Preserve projection as eventual side effects that never drive lifecycle.

**Tech Stack:** Node >=22.22.2, native TypeScript/ESM with explicit `.ts` imports, `node:test` + `node:assert/strict`, SQLite via `node:sqlite`, YAML subset parser in `src/config/load-config.ts`.

---

## Source Map From Current Code

**Design input:** `docs/superpowers/specs/2026-06-03-agent-owned-git-release-design.md`

**Current constraints observed while reading source:**

- `src/types/control-plane.ts` owns the lifecycle union and currently includes `cancelled`; the design adds `exception` and does not discuss `cancelled`. Keep `cancelled` for existing external-issue-close behavior and add `exception`; do not remove tested behavior in the same change.
- `src/runtime/state-machine.ts` is pure and currently sends retryable/terminal child outcomes through per-stage transitions. It must instead raise structured exceptions for workflow-blocking abnormal outcomes.
- `src/types/workflow.ts` validates roles/stages and currently has no `exception_policy` model.
- `src/config/load-config.ts` parses only a limited YAML subset and cannot parse common inline list-object entries such as `- name: verification_retryable_returns_to_implementation`; extend it before adding YAML fixtures.
- `src/runtime/artifacts.ts` validates old software-dev artifacts (`worker_result`, `evidence_packet`, old `release_result`). Add new artifacts while retaining old custom/workflow compatibility until fixture migration is complete.
- `src/orchestrator/software-dev-driver.ts` currently owns worktree, commit/push, PR create/reuse, merge, sync-worktree, external merge reconciliation, and merge conflict recovery. This is the main boundary to rewrite.
- `src/orchestrator/cycle.ts` drives production reconcile/watch and currently calls domain delivery operations as foreground steps. It must call the exception resolver before active scheduling and must not treat projection failures as lifecycle failures.

## File Structure

### Create

- `src/runtime/exception-policy.ts`
  - Pure resolver for `exception -> target lifecycle/stage` based on `workflow.exception_policy` and `runtime.maxRecoveryAttempts`.
- `src/orchestrator/software-dev-contract.ts`
  - Software-development task envelopes, result validators, JSON parser, and prompt/task builders.
- `tests/runtime/exception-policy.test.ts`
  - Unit tests for policy matching, target stage validation, budget exhaustion, carry-forward, quarantine, and fail.
- `tests/orchestrator/software-dev-contract.test.ts`
  - Unit tests for task envelope building and new artifact validation semantics.
- Workflow invalid fixtures:
  - `tests/fixtures/workflows/invalid/exception-policy-unknown-action.yaml`
  - `tests/fixtures/workflows/invalid/exception-policy-unknown-match-field.yaml`
  - `tests/fixtures/workflows/invalid/exception-policy-missing-target.yaml`
  - `tests/fixtures/workflows/invalid/exception-policy-unknown-target.yaml`

### Modify

- `src/types/control-plane.ts`
  - Add `exception` to `lifecycleStates` and `LifecycleState`.
  - Add structured exception context types to `RuntimeContext`.
- `src/config/load-config.ts`
  - Support YAML list items with inline mapping prefixes (`- name: rule`) followed by nested fields.
- `src/types/workflow-validation.ts`
  - Add stable error codes for exception policy validation.
- `src/types/workflow.ts`
  - Add `ExceptionPolicyDefinition`, validate rule match/action/default/on_exhausted, and include the normalized policy on `WorkflowDefinition`.
  - Add built-in artifact kinds `implementation_result` and `verification_result`.
- `src/runtime/artifacts.ts`
  - Add new artifact statuses and validators for `implementation_result`, `verification_result`, and new `release_result` semantics.
- `src/runtime/state-machine.ts`
  - Add `exception_raised` runtime event and helper to centralize abnormal flow.
  - Convert blocking abnormal child artifacts and artifact validation failures to `exception`.
  - Complete release from schema-valid `release_result.status=completed` child artifact.
- `src/runtime/store.ts`
  - Ensure store accepts `exception`; keep `listActiveIssues()` unchanged because `exception` is not active.
- `src/runtime/repair.ts`
  - Release active ownership into `exception` instead of `ready`/`verified` for workflow-blocking invalid active runtime ownership.
- `src/adapters/github/project-v2.ts`
  - Project `exception` as `Blocked` or `Exception` depending on available Project options; first version maps to `Blocked` to avoid requiring a new Project option.
- `src/orchestrator/issue-flow.ts`
  - Map new statuses (`ready_for_verification`, `pass`, `completed`) to canonical child success, and map abnormal statuses into exception-raising events.
- `src/orchestrator/domain-driver.ts`
  - Remove delivery-truth return requirements from software-development paths while keeping generic interface compatibility.
- `src/orchestrator/software-dev-driver.ts`
  - Stop calling worktree/git/PR/merge APIs for lifecycle truth.
  - Dispatch implementation, verification, and release tasks to workers.
  - Parse/validate agent artifacts using `software-dev-contract.ts`.
- `src/orchestrator/production-dependencies.ts`
  - Stop wiring `SoftwareDevWorktreeOperator` into the software-development driver for delivery.
  - Keep GitHub adapters only for intake/projection and keep worktree cleanup dependencies only where they are still explicitly used by existing cleanup paths.
- `src/adapters/host/codex-worker.ts`
- `src/adapters/host/opencode-worker.ts`
- `src/adapters/host/pi-worker.ts`
  - Accept task JSON inputs and add release worker support.
- `tests/fixtures/workflows/issue-to-pr-release.yaml`
  - Move to version `2.0`, roles `implementation_agent`, `verifier_agent`, `release_agent`, new artifact names, and declarative `exception_policy`.
- `tests/index.test.ts`
  - Import new test files.
- Existing tests under `tests/runtime`, `tests/workflow`, `tests/orchestrator`, `tests/adapters`.
  - Update expected lifecycle/artifact names and add regression coverage for no Northstar-owned git delivery.

---

## Task 1: Extend YAML Parsing for List Objects

**Files:**
- Modify: `src/config/load-config.ts`
- Test: `tests/config/load-config.test.ts`

- [x] **Step 1: Write failing parser test**

Append this test near the other YAML/config parser tests in `tests/config/load-config.test.ts`:

```ts
import { parseYamlSubset } from "../../src/config/load-config.ts";

test("yaml subset parses list items with inline mapping prefixes", () => {
  const parsed = parseYamlSubset(`
workflow:
  exception_policy:
    rules:
      - name: verification_retryable_returns_to_implementation
        match:
          source_stage: verification
          artifact_kind: verification_result
          status: failed_retryable
        action:
          type: return_to_stage
          target_stage: implementation
          carry_forward:
            - feedback_for_implementation
        on_exhausted:
          type: quarantine
    default:
      action:
        type: quarantine
`);

  assert.deepEqual(parsed, {
    workflow: {
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
        ],
        default: { action: { type: "quarantine" } },
      },
    },
  });
});
```

- [x] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts
```

Expected: FAIL because `parseArray()` treats `- name: ...` as a scalar string.

- [x] **Step 3: Implement inline list-object parsing**

In `src/config/load-config.ts`, replace the `if (rest.length > 0) { ... }` block inside `parseArray()` with this implementation:

```ts
    if (rest.length > 0) {
      const inlineSeparator = rest.indexOf(":");
      if (inlineSeparator !== -1) {
        const key = rest.slice(0, inlineSeparator).trim();
        const scalarText = rest.slice(inlineSeparator + 1).trim();
        const item: Record<string, unknown> = {
          [key]: scalarText.length > 0 ? parseScalar(scalarText) : {},
        };
        const nextLine = lines[index + 1];
        if (nextLine && nextLine.indent > line.indent) {
          const parsed = parseObject(lines, index + 1, nextLine.indent);
          Object.assign(item, parsed.value);
          value.push(item);
          index = parsed.next;
          continue;
        }
        value.push(item);
        index += 1;
        continue;
      }

      value.push(parseScalar(rest));
      index += 1;
      continue;
    }
```

- [x] **Step 4: Run the focused test and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/config/load-config.ts tests/config/load-config.test.ts
git commit -m "feat: parse workflow exception policy yaml lists"
```

---

## Task 2: Add Workflow Exception Policy Schema and Validation

**Files:**
- Modify: `src/types/workflow-validation.ts`
- Modify: `src/types/workflow.ts`
- Modify: `tests/workflow/workflow-validation.test.ts`
- Create invalid fixtures listed in File Structure

- [x] **Step 1: Write failing validation tests**

Append these tests to `tests/workflow/workflow-validation.test.ts`:

```ts
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
```

- [x] **Step 2: Run validation tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/workflow/workflow-validation.test.ts
```

Expected: FAIL because `WorkflowDefinition` has no `exception_policy`, built-in artifacts do not include `implementation_result`/`verification_result`, and new error codes do not exist.

- [x] **Step 3: Add validation error codes**

In `src/types/workflow-validation.ts`, extend `WorkflowValidationErrorCode` with:

```ts
  | "WORKFLOW_EXCEPTION_POLICY_INVALID_RULE"
  | "WORKFLOW_EXCEPTION_POLICY_INVALID_MATCH_FIELD"
  | "WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION"
  | "WORKFLOW_EXCEPTION_POLICY_MISSING_TARGET_STAGE"
  | "WORKFLOW_EXCEPTION_POLICY_UNKNOWN_TARGET_STAGE"
```

- [x] **Step 4: Add workflow exception policy types**

In `src/types/workflow.ts`, add these interfaces near the existing workflow type definitions:

```ts
export type ExceptionMatchField =
  | "source_stage"
  | "source_role"
  | "artifact_kind"
  | "status"
  | "category"
  | "severity"
  | "retryable";

export type ExceptionActionType =
  | "retry_same_stage"
  | "retry_stage"
  | "return_to_stage"
  | "quarantine"
  | "fail";

export interface ExceptionPolicyActionDefinition {
  type: ExceptionActionType;
  target_stage?: string;
  carry_forward?: string[];
}

export interface ExceptionPolicyRuleDefinition {
  name: string;
  match: Partial<Record<ExceptionMatchField, string | boolean>>;
  action: ExceptionPolicyActionDefinition;
  on_exhausted?: { type: "quarantine" | "fail" };
}

export interface ExceptionPolicyDefinition {
  max_recovery_attempts_from?: "runtime.max_recovery_attempts";
  rules: ExceptionPolicyRuleDefinition[];
  default: { action: ExceptionPolicyActionDefinition };
}
```

Then add this property to `WorkflowDefinition`:

```ts
  exception_policy?: ExceptionPolicyDefinition;
```

- [x] **Step 5: Accept the new built-in artifact kinds**

In `src/types/workflow.ts`, update `builtInArtifactSchemas` to include:

```ts
  "implementation_result",
  "verification_result",
```

- [x] **Step 6: Normalize and validate `exception_policy`**

In `src/types/workflow.ts`, add this call inside `validateWorkflow()` after projections/effects are normalized:

```ts
  const exceptionPolicy = normalizeExceptionPolicy(workflow.exception_policy, stages);
```

Include it in the returned object:

```ts
    exception_policy: exceptionPolicy,
```

Use this helper implementation in the same file:

```ts
const exceptionMatchFields = new Set([
  "source_stage",
  "source_role",
  "artifact_kind",
  "status",
  "category",
  "severity",
  "retryable",
]);
const exceptionActionTypes = new Set(["retry_same_stage", "retry_stage", "return_to_stage", "quarantine", "fail"]);

function normalizeExceptionPolicy(value: unknown, stages: Record<string, unknown>): ExceptionPolicyDefinition | undefined {
  if (value === undefined) return undefined;
  const policy = getRecordValue(value, "workflow.exception_policy");
  const rulesValue = policy.rules;
  if (!Array.isArray(rulesValue)) {
    throw workflowValidationError("WORKFLOW_FIELD_TYPE", "workflow.exception_policy.rules", "rules must be an array");
  }
  const rules = rulesValue.map((ruleValue, index) => normalizeExceptionRule(ruleValue, index, stages));
  const defaultRecord = getRecordValue(policy.default, "workflow.exception_policy.default");
  return {
    max_recovery_attempts_from: policy.max_recovery_attempts_from === undefined
      ? undefined
      : stringValue(policy.max_recovery_attempts_from, "workflow.exception_policy.max_recovery_attempts_from") as "runtime.max_recovery_attempts",
    rules,
    default: {
      action: normalizeExceptionAction(defaultRecord.action, "workflow.exception_policy.default.action", stages),
    },
  };
}

function normalizeExceptionRule(value: unknown, index: number, stages: Record<string, unknown>): ExceptionPolicyRuleDefinition {
  const path = `workflow.exception_policy.rules[${index}]`;
  const rule = getRecordValue(value, path);
  const match = getRecordValue(rule.match, `${path}.match`);
  const matchEntries = Object.entries(match);
  if (matchEntries.length === 0) {
    throw workflowValidationError("WORKFLOW_EXCEPTION_POLICY_INVALID_RULE", `${path}.match`, "match must include at least one field");
  }
  const normalizedMatch: Partial<Record<ExceptionMatchField, string | boolean>> = {};
  for (const [field, fieldValue] of matchEntries) {
    if (!exceptionMatchFields.has(field)) {
      throw workflowValidationError("WORKFLOW_EXCEPTION_POLICY_INVALID_MATCH_FIELD", `${path}.match.${field}`, `unknown exception match field ${field}`);
    }
    if (typeof fieldValue !== "string" && typeof fieldValue !== "boolean") {
      throw workflowValidationError("WORKFLOW_FIELD_TYPE", `${path}.match.${field}`, "match values must be strings or booleans");
    }
    normalizedMatch[field as ExceptionMatchField] = fieldValue;
  }
  return {
    name: stringValue(rule.name, `${path}.name`),
    match: normalizedMatch,
    action: normalizeExceptionAction(rule.action, `${path}.action`, stages),
    on_exhausted: normalizeExceptionOnExhausted(rule.on_exhausted, `${path}.on_exhausted`),
  };
}

function normalizeExceptionAction(value: unknown, path: string, stages: Record<string, unknown>): ExceptionPolicyActionDefinition {
  const action = getRecordValue(value, path);
  const type = stringValue(action.type, `${path}.type`) as ExceptionActionType;
  if (!exceptionActionTypes.has(type)) {
    throw workflowValidationError("WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION", `${path}.type`, `unknown exception action ${type}`);
  }
  const targetStage = optionalStringValue(action.target_stage, `${path}.target_stage`);
  if ((type === "retry_stage" || type === "return_to_stage") && !targetStage) {
    throw workflowValidationError("WORKFLOW_EXCEPTION_POLICY_MISSING_TARGET_STAGE", `${path}.target_stage`, `${type} requires target_stage`);
  }
  if (targetStage && !stages[targetStage]) {
    throw workflowValidationError("WORKFLOW_EXCEPTION_POLICY_UNKNOWN_TARGET_STAGE", `${path}.target_stage`, `unknown target stage ${targetStage}`);
  }
  return {
    type,
    ...(targetStage === undefined ? {} : { target_stage: targetStage }),
    carry_forward: action.carry_forward === undefined ? undefined : stringArrayValue(action.carry_forward, `${path}.carry_forward`),
  };
}

function normalizeExceptionOnExhausted(value: unknown, path: string): { type: "quarantine" | "fail" } | undefined {
  if (value === undefined) return undefined;
  const record = getRecordValue(value, path);
  const type = stringValue(record.type, `${path}.type`);
  if (type !== "quarantine" && type !== "fail") {
    throw workflowValidationError("WORKFLOW_EXCEPTION_POLICY_INVALID_ACTION", `${path}.type`, "on_exhausted.type must be quarantine or fail");
  }
  return { type };
}
```

- [x] **Step 7: Run validation tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/workflow/workflow-validation.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/types/workflow.ts src/types/workflow-validation.ts tests/workflow/workflow-validation.test.ts tests/fixtures/workflows/invalid
git commit -m "feat: validate workflow exception policy"
```

---

## Task 3: Add `exception` Lifecycle and Pure Exception Resolver

**Files:**
- Modify: `src/types/control-plane.ts`
- Modify: `src/runtime/state-machine.ts`
- Create: `src/runtime/exception-policy.ts`
- Create: `tests/runtime/exception-policy.test.ts`
- Modify: `tests/runtime/store.test.ts`
- Modify: `tests/runtime/state-machine.test.ts`
- Modify: `src/adapters/github/project-v2.ts`

- [x] **Step 1: Write failing lifecycle/store test**

In `tests/runtime/store.test.ts`, update the lifecycle enumeration test to include `exception`:

```ts
for (const state of ["ready", "claimed", "running", "verifying", "verified", "release_pending", "exception", "completed", "cancelled", "failed", "quarantined"]) {
  store.createIssue(newIssueSnapshot(`store-active-${state}`, { lifecycle_state: state }));
}
```

Keep the active expectation unchanged:

```ts
assert.deepEqual(
  store.listActiveIssues().map((issue) => issue.lifecycle_state),
  ["claimed", "running", "verifying", "release_pending"],
);
```

- [x] **Step 2: Write resolver tests**

Create `tests/runtime/exception-policy.test.ts` with:

```ts
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
    implementation_agent: { run_mode: "background_child", agent: "build", load_skills: [], artifact: "implementation_result", timeout_seconds: 30 },
    verifier_agent: { run_mode: "background_child", agent: "review", load_skills: [], artifact: "verification_result", timeout_seconds: 30 },
    release_agent: { run_mode: "background_child", agent: "release", load_skills: [], artifact: "release_result", timeout_seconds: 30 },
  },
  stages: {
    implementation: { lifecycle_state: "running", role: "implementation_agent", on_success: "verification" },
    verification: { lifecycle_state: "verifying", role: "verifier_agent", on_success: "verified" },
    release: { lifecycle_state: "release_pending", role: "release_agent", on_success: "completed" },
  },
  exception_policy: {
    rules: [
      {
        name: "verification_retryable_returns_to_implementation",
        match: { source_stage: "verification", artifact_kind: "verification_result", status: "failed_retryable" },
        action: { type: "return_to_stage", target_stage: "implementation", carry_forward: ["feedback_for_implementation"] },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "release_retryable_retries_release",
        match: { source_stage: "release", artifact_kind: "release_result", status: "failed_retryable" },
        action: { type: "retry_stage", target_stage: "release" },
        on_exhausted: { type: "quarantine" },
      },
      {
        name: "blocked_requires_operator",
        match: { status: "blocked" },
        action: { type: "quarantine" },
      },
    ],
    default: { action: { type: "quarantine" } },
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

  const result = resolveExceptionPolicy(snapshot, workflow, { maxRecoveryAttempts: 2, now: "2026-06-03T00:00:00.000Z" });

  assert.equal(result.snapshot.lifecycle_state, "running");
  assert.equal(result.snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.deepEqual(result.snapshot.runtime_context_json.exception_carry_forward, { feedback_for_implementation: ["fix filter behavior"] });
  assert.equal(result.history.at(-1)?.event_type, "exception_resolved");
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

  const result = resolveExceptionPolicy(snapshot, workflow, { maxRecoveryAttempts: 2, now: "2026-06-03T00:00:00.000Z" });

  assert.equal(result.snapshot.lifecycle_state, "quarantined");
  assert.equal(result.history.at(-1)?.event_type, "exception_resolved");
  assert.equal(result.history.at(-1)?.payload.exhausted, true);
});
```

- [x] **Step 3: Run tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/exception-policy.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/store.test.ts
```

Expected: FAIL because the lifecycle and resolver do not exist.

- [x] **Step 4: Add `exception` lifecycle**

In `src/types/control-plane.ts`, add `"exception"` after `"release_pending"` in `lifecycleStates`, and add it to `LifecycleState`:

```ts
  | "exception"
```

Also add this structured context type and property:

```ts
export interface RuntimeExceptionContext {
  id: string;
  status?: "pending_reconcile" | "resolved";
  source_lifecycle?: string;
  source_stage?: string;
  source_role?: string;
  source_child_run_id?: string;
  artifact_kind?: string;
  status_value?: string;
  status?: string;
  category?: string;
  severity?: string;
  retryable?: boolean;
  summary?: string;
  recommended_action?: string;
  target_stage?: string;
  attempt_count?: number;
  max_attempts?: number;
  payload?: Record<string, unknown>;
  created_at?: string;
  last_reconciled_at?: string | null;
}
```

Then add to `RuntimeContext`:

```ts
  exception?: RuntimeExceptionContext;
  exception_carry_forward?: Record<string, unknown>;
```

If TypeScript rejects duplicate `status` meanings, use `state: "pending_reconcile" | "resolved"` for the resolver state and keep `status?: string` for artifact status.

- [x] **Step 5: Add project mapping**

In `src/adapters/github/project-v2.ts`, add:

```ts
  exception: "Blocked",
```

- [x] **Step 6: Create `src/runtime/exception-policy.ts`**

Create this file:

```ts
import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../types/control-plane.ts";
import type { ExceptionPolicyActionDefinition, ExceptionPolicyRuleDefinition, WorkflowDefinition } from "../types/workflow.ts";

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
  const rule = firstMatchingRule(workflow.exception_policy?.rules ?? [], exception);
  const baseAction = rule?.action ?? workflow.exception_policy?.default.action ?? { type: "quarantine" as const };
  const attemptCount = numberValue(exception.attempt_count);
  const exhausted = attemptCount >= options.maxRecoveryAttempts;
  const action = exhausted && rule?.on_exhausted
    ? exhaustedAction(rule.on_exhausted.type)
    : baseAction;

  applyAction(next, workflow, action, exception);
  const resolvedException = {
    ...exception,
    state: "resolved",
    last_reconciled_at: options.now,
    resolved_action: action.type,
    exhausted,
  };
  next.runtime_context_json.exception = resolvedException;

  return {
    snapshot: next,
    history: [{
      event_type: "exception_resolved",
      payload: {
        exception_id: stringValue(exception.id, "unknown-exception"),
        rule: rule?.name ?? "default",
        action: action.type,
        exhausted,
        source_stage: exception.source_stage,
        target_stage: action.target_stage,
      },
    }],
  };
}

function firstMatchingRule(rules: ExceptionPolicyRuleDefinition[], exception: Record<string, unknown>): ExceptionPolicyRuleDefinition | undefined {
  return rules.find((rule) => Object.entries(rule.match).every(([field, expected]) => exception[field] === expected));
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
  snapshot.lifecycle_state = stage.lifecycle_state as LifecycleState;
  if (action.type === "return_to_stage" && action.carry_forward) {
    const payload = objectValue(exception.payload);
    const carry: Record<string, unknown> = {};
    for (const field of action.carry_forward) {
      if (payload[field] !== undefined) carry[field] = payload[field];
    }
    snapshot.runtime_context_json.exception_carry_forward = carry;
  }
}

function exhaustedAction(type: "quarantine" | "fail"): ExceptionPolicyActionDefinition {
  return { type: type === "quarantine" ? "quarantine" : "fail" };
}

function exceptionRecord(snapshot: IssueSnapshot): Record<string, unknown> {
  const value = snapshot.runtime_context_json.exception;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
```

- [x] **Step 7: Run focused tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/exception-policy.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/store.test.ts
```

Expected: PASS.

- [x] **Step 8: Update test index**

Add this import to `tests/index.test.ts` near other runtime tests:

```ts
import "./runtime/exception-policy.test.ts";
```

- [x] **Step 9: Commit**

```bash
git add src/types/control-plane.ts src/runtime/exception-policy.ts src/adapters/github/project-v2.ts tests/runtime/exception-policy.test.ts tests/runtime/store.test.ts tests/index.test.ts
git commit -m "feat: add workflow exception lifecycle resolver"
```

---

## Task 4: Validate New Software-Development Artifact Contracts

**Files:**
- Modify: `src/runtime/artifacts.ts`
- Create: `src/orchestrator/software-dev-contract.ts`
- Create: `tests/orchestrator/software-dev-contract.test.ts`
- Modify: `tests/runtime/artifacts.test.ts`

- [x] **Step 1: Write failing artifact tests**

Append to `tests/runtime/artifacts.test.ts`:

```ts
test("validates implementation_result ready_for_verification", () => {
  const artifact = validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "implementation_result",
    status: "ready_for_verification",
    retryable: false,
    issue_number: 123,
    role: "implementation_agent",
    observed_at: "2026-06-03T12:00:00.000Z",
    summary: "Implemented todo filtering and opened PR #456.",
    pr: {
      url: "https://github.com/owner/repo/pull/456",
      number: 456,
      head_ref: "northstar/issue-123-todo-filter",
      head_sha: "abc123",
    },
    changed_files: ["app.js", "tests/todo-filter.test.js"],
    commands_run: [{ command: "npm test", status: "passed", summary: "12 tests passed." }],
    self_check_summary: "All issue requirements implemented and locally tested.",
    evidence: [{ type: "pull_request", url: "https://github.com/owner/repo/pull/456" }],
    next_action: "verify",
  });

  assert.equal(artifact.artifact_kind, "implementation_result");
  assert.equal(artifact.status, "ready_for_verification");
});

test("validates release_result completed requires confirmed release and issue update", () => {
  const artifact = validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "release_result",
    status: "completed",
    retryable: false,
    issue_number: 123,
    role: "release_agent",
    observed_at: "2026-06-03T13:00:00.000Z",
    summary: "PR #456 was merged successfully.",
    pr: { url: "https://github.com/owner/repo/pull/456", number: 456 },
    release: {
      confirmed: true,
      type: "github_pr_merge",
      merge_commit: "def456",
      released_at: "2026-06-03T13:00:00.000Z",
    },
    evidence: [{ type: "merge_commit", value: "def456" }],
    issue_update: {
      comment_summary: "Released via PR #456.",
      close_issue: true,
      labels_to_add: ["northstar:released"],
      labels_to_remove: ["northstar:ready"],
    },
  });

  assert.equal(artifact.artifact_kind, "release_result");
  assert.equal(artifact.status, "completed");
});
```

- [x] **Step 2: Write failing contract tests**

Create `tests/orchestrator/software-dev-contract.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildSoftwareDevAgentTask, parseSoftwareDevAgentResult } from "../../src/orchestrator/software-dev-contract.ts";

test("builds implementation task envelope with agent-owned git boundary", () => {
  const task = buildSoftwareDevAgentTask({
    taskKind: "implementation",
    runId: "northstar-production",
    issueId: "github:123",
    stage: "implementation",
    attempt: 1,
    repo: { provider: "github", name: "owner/repo", url: "https://github.com/owner/repo", base_branch: "main" },
    issue: { number: 123, title: "Add todo filter", body: "Acceptance criteria", url: "https://github.com/owner/repo/issues/123" },
    expectedArtifactKind: "implementation_result",
  });

  assert.equal(task.policy.git_is_agent_owned, true);
  assert.equal(task.policy.northstar_will_not_create_worktree, true);
  assert.equal(task.expected_output.artifact_kind, "implementation_result");
});

test("parses exact JSON agent result and rejects markdown", () => {
  const artifact = parseSoftwareDevAgentResult(JSON.stringify({
    schema_version: "1.0",
    artifact_kind: "verification_result",
    status: "failed_retryable",
    retryable: true,
    issue_number: 123,
    role: "verifier_agent",
    observed_at: "2026-06-03T12:30:00.000Z",
    summary: "Functional review failed.",
    feedback_for_implementation: ["Fix completed filter."],
    next_action: "return_to_implementation",
  }), { expectedArtifactKind: "verification_result", issueNumber: 123, role: "verifier_agent" });

  assert.equal(artifact.status, "failed_retryable");

  assert.throws(
    () => parseSoftwareDevAgentResult("```json\n{}\n```", { expectedArtifactKind: "verification_result", issueNumber: 123, role: "verifier_agent" }),
    /agent result must be exactly one JSON object/,
  );
});
```

- [x] **Step 3: Run focused tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/artifacts.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-contract.test.ts
```

Expected: FAIL because new artifacts and contract module do not exist.

- [x] **Step 4: Extend artifact kind/status types**

In `src/runtime/artifacts.ts`, update the type aliases:

```ts
export type ArtifactKind = "worker_result" | "evidence_packet" | "implementation_result" | "verification_result" | "release_result";
export type ArtifactStatus = "success" | "pass" | "completed" | "ready_for_verification" | "blocked" | "failed_retryable" | "failed_terminal";
```

Update `allowedKinds` and `allowedStatuses` to include the new values.

- [x] **Step 5: Add new validation blocks**

In `src/runtime/artifacts.ts`, add these validation branches after the existing common retryable validation:

```ts
  if (artifact_kind === "implementation_result" && normalized.status === "ready_for_verification") {
    const pr = objectValue(record.pr, "pr");
    requireString(pr.url, "pr.url");
    numberValue(pr.number, "pr.number");
    requireStringArray(record.changed_files, "changed_files");
    requireArray(record.commands_run, "commands_run");
    requireString(record.self_check_summary, "self_check_summary");
    requireArray(record.evidence, "evidence");
  }

  if (artifact_kind === "verification_result" && normalized.status === "pass") {
    const review = objectValue(record.review, "review");
    if (typeof review.requirements_passed !== "boolean") {
      throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "review.requirements_passed", "review.requirements_passed must be a boolean");
    }
    if (typeof review.code_review_passed !== "boolean") {
      throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "review.code_review_passed", "review.code_review_passed must be a boolean");
    }
    const functional = objectValue(record.functional_review, "functional_review");
    if (functional.required === true) {
      if (functional.status !== "pass") {
        throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "functional_review.status", "required functional review must pass");
      }
    }
    const browser = objectValue(record.browser_evidence, "browser_evidence");
    if (browser.required === true && booleanValue(browser.ran, "browser_evidence.ran") !== true) {
      throw new ArtifactValidationError("ARTIFACT_BROWSER_EVIDENCE_REQUIRED", "browser_evidence.ran", "required browser evidence must run");
    }
    if (record.release_recommendation !== "ready_for_release") {
      throw new ArtifactValidationError("ARTIFACT_FIELD_TYPE", "release_recommendation", "pass requires release_recommendation=ready_for_release");
    }
  }

  if (artifact_kind === "release_result" && normalized.status === "completed") {
    const release = objectValue(record.release, "release");
    if (booleanValue(release.confirmed, "release.confirmed") !== true) {
      throw new ArtifactValidationError("ARTIFACT_MERGE_NOT_CONFIRMED", "release.confirmed", "release completion requires confirmed=true");
    }
    requireString(release.merge_commit, "release.merge_commit");
    const issueUpdate = objectValue(record.issue_update, "issue_update");
    requireString(issueUpdate.comment_summary, "issue_update.comment_summary");
    requireArray(record.evidence, "evidence");
  }
```

- [x] **Step 6: Create software-dev contract module**

Create `src/orchestrator/software-dev-contract.ts`:

```ts
import { validateArtifactPayload, type NormalizedArtifact } from "../runtime/artifacts.ts";

export type SoftwareDevTaskKind = "implementation" | "verification" | "release";
export type SoftwareDevArtifactKind = "implementation_result" | "verification_result" | "release_result";

export interface SoftwareDevAgentTaskInput {
  task_json: SoftwareDevAgentTask;
  prompt: string;
  expected_artifact_kind: SoftwareDevArtifactKind;
}

export interface SoftwareDevAgentTask {
  schema_version: "1.0";
  task_kind: SoftwareDevTaskKind;
  northstar: {
    run_id: string;
    issue_id: string;
    stage: string;
    attempt: number;
  };
  repo: {
    provider: "github";
    name: string;
    url: string;
    base_branch: string;
  };
  issue: {
    number: number;
    title: string;
    body: string;
    url: string;
  };
  policy: {
    git_is_agent_owned: true;
    northstar_will_not_create_worktree: true;
    northstar_will_not_commit_or_push: true;
    northstar_will_not_create_or_merge_pr: true;
    northstar_will_not_validate_git_state: true;
  };
  expected_output: {
    artifact_kind: SoftwareDevArtifactKind;
    format: "json_object_only";
  };
}

export function buildSoftwareDevAgentTask(input: {
  taskKind: SoftwareDevTaskKind;
  runId: string;
  issueId: string;
  stage: string;
  attempt: number;
  repo: SoftwareDevAgentTask["repo"];
  issue: SoftwareDevAgentTask["issue"];
  expectedArtifactKind: SoftwareDevArtifactKind;
}): SoftwareDevAgentTask {
  return {
    schema_version: "1.0",
    task_kind: input.taskKind,
    northstar: {
      run_id: input.runId,
      issue_id: input.issueId,
      stage: input.stage,
      attempt: input.attempt,
    },
    repo: input.repo,
    issue: input.issue,
    policy: {
      git_is_agent_owned: true,
      northstar_will_not_create_worktree: true,
      northstar_will_not_commit_or_push: true,
      northstar_will_not_create_or_merge_pr: true,
      northstar_will_not_validate_git_state: true,
    },
    expected_output: {
      artifact_kind: input.expectedArtifactKind,
      format: "json_object_only",
    },
  };
}

export function buildSoftwareDevAgentPrompt(task: SoftwareDevAgentTask): string {
  return [
    "You are executing a Northstar software-development workflow stage.",
    "You own all git/repo/workspace operations. Northstar will not create worktrees, branches, commits, PRs, merges, or validate git state.",
    "Return exactly one JSON object matching the expected schema. No Markdown fences and no prose outside JSON.",
    "Do not include raw transcripts, raw browser traces, terminal logs, full logs, or secrets.",
    "Task JSON:",
    JSON.stringify(task, null, 2),
  ].join("\n");
}

export function parseSoftwareDevAgentResult(finalResponse: string, expected: {
  expectedArtifactKind: SoftwareDevArtifactKind;
  issueNumber: number;
  role: string;
}): NormalizedArtifact {
  const trimmed = finalResponse.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("agent result must be exactly one JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("agent result must be exactly one JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("agent result must be exactly one JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.artifact_kind !== expected.expectedArtifactKind) {
    throw new Error(`agent result artifact_kind must be ${expected.expectedArtifactKind}`);
  }
  if (record.issue_number !== expected.issueNumber) {
    throw new Error(`agent result issue_number must be ${expected.issueNumber}`);
  }
  if (record.role !== expected.role) {
    throw new Error(`agent result role must be ${expected.role}`);
  }
  return validateArtifactPayload(record);
}
```

- [x] **Step 7: Run focused tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/artifacts.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-contract.test.ts
```

Expected: PASS.

- [x] **Step 8: Update test index and commit**

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/software-dev-contract.test.ts";
```

Commit:

```bash
git add src/runtime/artifacts.ts src/orchestrator/software-dev-contract.ts tests/runtime/artifacts.test.ts tests/orchestrator/software-dev-contract.test.ts tests/index.test.ts
git commit -m "feat: validate agent-owned software dev artifacts"
```

---

## Task 5: Raise Exceptions From the State Machine

**Files:**
- Modify: `src/runtime/state-machine.ts`
- Modify: `src/orchestrator/issue-flow.ts`
- Modify: `tests/runtime/state-machine.test.ts`
- Modify: `tests/orchestrator/issue-flow.test.ts`

- [x] **Step 1: Write failing state-machine tests**

In `tests/runtime/state-machine.test.ts`, add tests for exception transitions:

```ts
test("implementation_result failed_retryable raises exception", () => {
  const snapshot = newIssueSnapshot("github:123", {
    lifecycle_state: "running",
    owner_lease: lease,
    stage_cursor: "implementation",
    child_runs: [{ child_run_id: "child-impl", lease_id: lease.lease_id, root_session_id: lease.root_session_id, role: "implementation_agent", status: "running", session_id: "s1", started_at: now, last_seen_at: now }],
    runtime_context_json: { issue_packet: { issue_number: "123" } },
  });

  const result = applyRuntimeEvents(snapshot, workflowV2(), [{
    type: "child_artifact",
    child_run_id: "child-impl",
    status: "failed_retryable",
    artifact_history_id: 99,
    at: now,
    artifact_kind: "implementation_result",
    schema_version: "1.0",
    role: "implementation_agent",
    summary: "implementation blocked on tests",
    retryable: true,
    payload: {
      schema_version: "1.0",
      artifact_kind: "implementation_result",
      issue_number: 123,
      role: "implementation_agent",
      status: "failed_retryable",
      observed_at: now,
      summary: "implementation blocked on tests",
      retryable: true,
      failure: { category: "test_failure" },
    },
  }]);

  assert.equal(result.snapshot.lifecycle_state, "exception");
  assert.equal(result.snapshot.current_session_id, undefined);
  assert.equal(result.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(result.snapshot.runtime_context_json.exception?.source_stage, "implementation");
  assert.equal(result.history.at(-1)?.event_type, "exception_raised");
});

test("release_result completed child artifact completes release", () => {
  const releaseLease = { ...lease, role: "release_agent" };
  const snapshot = newIssueSnapshot("github:123", {
    lifecycle_state: "release_pending",
    owner_lease: releaseLease,
    stage_cursor: "release",
    child_runs: [{ child_run_id: "child-release", lease_id: releaseLease.lease_id, root_session_id: releaseLease.root_session_id, role: "release_agent", status: "running", session_id: "s1", started_at: now, last_seen_at: now }],
    runtime_context_json: { issue_packet: { issue_number: "123" } },
  });

  const result = applyRuntimeEvents(snapshot, workflowV2(), [{
    type: "child_artifact",
    child_run_id: "child-release",
    status: "succeeded",
    artifact_history_id: 100,
    at: now,
    artifact_kind: "release_result",
    schema_version: "1.0",
    role: "release_agent",
    summary: "released",
    retryable: false,
    payload: {
      schema_version: "1.0",
      artifact_kind: "release_result",
      issue_number: 123,
      role: "release_agent",
      status: "completed",
      observed_at: now,
      summary: "released",
      retryable: false,
      pr: { url: "https://github.com/owner/repo/pull/456", number: 456 },
      release: { confirmed: true, type: "github_pr_merge", merge_commit: "merge-123", released_at: now },
      evidence: [{ type: "merge_commit", value: "merge-123" }],
      issue_update: { comment_summary: "Released", close_issue: true, labels_to_add: [], labels_to_remove: [] },
    },
  }]);

  assert.equal(result.snapshot.lifecycle_state, "completed");
  assert.equal(result.snapshot.runtime_context_json.release?.merge_commit, "merge-123");
});
```

Define `workflowV2()` in the same file as a local helper returning the three-stage workflow with new roles and `on_success` transitions.

- [x] **Step 2: Run tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/state-machine.test.ts
```

Expected: FAIL because abnormal artifacts still use old retry transitions and release child artifacts do not complete from `completed` status.

- [x] **Step 3: Add `exception_raised` event type**

In `src/runtime/state-machine.ts`, extend `RuntimeEvent` with:

```ts
  | {
      type: "exception_raised";
      at: string;
      category: string;
      severity: "retryable" | "terminal" | "blocked";
      retryable: boolean;
      summary: string;
      source_child_run_id?: string;
      artifact_kind?: string;
      status?: string;
      payload?: Record<string, unknown>;
    }
```

Add this switch case:

```ts
    case "exception_raised":
      raiseException(result, workflow, event);
      return;
```

- [x] **Step 4: Implement exception helper**

In `src/runtime/state-machine.ts`, add:

```ts
function raiseException(
  result: StateMachineResult,
  workflow: WorkflowDefinition,
  event: Extract<RuntimeEvent, { type: "exception_raised" }>,
): void {
  const snapshot = result.snapshot;
  const sourceLifecycle = snapshot.lifecycle_state;
  const sourceStage = snapshot.runtime_context_json.stage_cursor ?? firstStageName(workflow);
  const sourceRole = workflow.stages[sourceStage]?.role;
  const previousException = snapshot.runtime_context_json.exception;
  const previousRecord = previousException && typeof previousException === "object" && !Array.isArray(previousException)
    ? previousException as Record<string, unknown>
    : {};
  const previousAttempt = typeof previousRecord.attempt_count === "number" ? previousRecord.attempt_count : 0;

  delete snapshot.current_session_id;
  delete snapshot.runtime_context_json.owner_lease;
  snapshot.lifecycle_state = "exception";
  snapshot.runtime_context_json.exception = {
    id: `exc_${Date.parse(event.at) || Date.now()}_${result.history.length + 1}`,
    state: "pending_reconcile",
    source_lifecycle: sourceLifecycle,
    source_stage: sourceStage,
    source_role: sourceRole,
    source_child_run_id: event.source_child_run_id,
    artifact_kind: event.artifact_kind,
    status: event.status,
    category: event.category,
    severity: event.severity,
    retryable: event.retryable,
    summary: event.summary,
    attempt_count: previousAttempt + 1,
    payload: event.payload ?? {},
    created_at: event.at,
    last_reconciled_at: null,
  };
  for (const childRun of snapshot.runtime_context_json.child_runs ?? []) {
    if (childRun.status === "running" || childRun.status === "queued") {
      childRun.status = event.severity === "blocked" ? "blocked" : "failed";
      childRun.last_seen_at = event.at;
    }
  }
  appendHistory(result, "exception_raised", snapshot.runtime_context_json.exception as Record<string, unknown>);
}
```

- [x] **Step 5: Route abnormal child artifacts through exception**

In `applyChildArtifact()`, after validation succeeds and before applying `childTarget`, add:

```ts
  if (event.status === "blocked" || event.status === "failed_retryable" || event.status === "failed_terminal") {
    raiseException(result, workflow, {
      type: "exception_raised",
      at: event.at,
      category: "agent_reported_failure",
      severity: event.status === "blocked" ? "blocked" : event.status === "failed_terminal" ? "terminal" : "retryable",
      retryable: event.status !== "failed_terminal",
      summary: event.summary ?? `${event.status} child artifact`,
      source_child_run_id: event.child_run_id,
      artifact_kind: event.artifact_kind ?? stringValueForException(event.payload?.artifact_kind),
      status: stringValueForException(event.payload?.status) ?? event.status,
      payload: event.payload,
    });
    return;
  }
```

Add helper:

```ts
function stringValueForException(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

In the artifact validation catch block, replace retry-target logic with:

```ts
        raiseException(result, workflow, {
          type: "exception_raised",
          at: event.at,
          category: "artifact_validation",
          severity: "retryable",
          retryable: true,
          summary: `${error.code} at ${error.path}`,
          source_child_run_id: event.child_run_id,
          artifact_kind: event.artifact_kind ?? stringValueForException(event.payload?.artifact_kind),
          status: stringValueForException(event.payload?.status) ?? event.status,
          payload: { reason: error.code, path: error.path, artifact: event.payload ?? {} },
        });
        return;
```

- [x] **Step 6: Support new artifact success status mapping**

In `artifactStatusFromChildEvent()`, return payload status for the new kinds:

```ts
  const payloadStatus = event.payload?.status;
  if (typeof payloadStatus === "string" && ["ready_for_verification", "pass", "completed"].includes(payloadStatus)) {
    return payloadStatus;
  }
```

Update the release completion path in `applyChildArtifact()` after success validation:

```ts
  if ((event.artifact_kind ?? event.payload?.artifact_kind) === "release_result" && event.payload?.status === "completed") {
    const release = event.payload.release;
    const releaseRecord = release && typeof release === "object" && !Array.isArray(release) ? release as Record<string, unknown> : {};
    result.snapshot.runtime_context_json.release = {
      ...(result.snapshot.runtime_context_json.release ?? {}),
      confirmed: true,
      merge_commit: releaseRecord.merge_commit,
      issue_update: event.payload.issue_update,
    };
  }
```

Then existing stage `on_success: completed` performs lifecycle completion.

- [x] **Step 7: Update issue-flow artifact status mapping**

In `src/orchestrator/issue-flow.ts`, change `artifactEventStatus()` to:

```ts
function artifactEventStatus(status: unknown): "succeeded" | "blocked" | "failed_retryable" | "failed_terminal" {
  if (status === "success" || status === "pass" || status === "ready_for_verification" || status === "completed") return "succeeded";
  if (status === "blocked" || status === "failed_retryable" || status === "failed_terminal") return status;
  return "failed_retryable";
}
```

- [x] **Step 8: Run focused tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/state-machine.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/issue-flow.test.ts
```

Expected: PASS after updating old expectations that abnormal active artifacts now enter `exception` instead of direct retry/failed/quarantine.

- [x] **Step 9: Commit**

```bash
git add src/runtime/state-machine.ts src/orchestrator/issue-flow.ts tests/runtime/state-machine.test.ts tests/orchestrator/issue-flow.test.ts
git commit -m "feat: raise workflow exceptions from abnormal artifacts"
```

---

## Task 6: Update Software-Development Workflow Fixture to v2

**Files:**
- Modify: `tests/fixtures/workflows/issue-to-pr-release.yaml`
- Modify: `tests/workflow/workflow.test.ts`
- Modify: `tests/orchestrator/workflow-generality.test.ts`

- [x] **Step 1: Replace fixture with v2 workflow**

Rewrite `tests/fixtures/workflows/issue-to-pr-release.yaml` with:

```yaml
workflow:
  id: issue_to_pr_release
  version: "2.0"
  domain: software_development

  roles:
    implementation_agent:
      run_mode: background_child
      agent: build
      model: gpt-5
      load_skills:
        - tdd
        - git-master
      prompt_template: "Implement {{issue_title}} from {{issue_body}}. Northstar will provide task JSON and expects {{expected_artifact_fields}}."
      artifact: implementation_result
      timeout_seconds: 7200
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 30
          - 120

    verifier_agent:
      run_mode: background_child
      agent: review
      model: gpt-5
      load_skills:
        - review-work
        - browser-qa
        - git-master
      artifact: verification_result
      timeout_seconds: 7200

    release_agent:
      run_mode: background_child
      agent: release
      model: gpt-5
      load_skills:
        - git-master
      artifact: release_result
      timeout_seconds: 3600

  stages:
    implementation:
      lifecycle_state: running
      role: implementation_agent
      on_success: verification

    verification:
      lifecycle_state: verifying
      role: verifier_agent
      on_pass: verified
      on_success: verified

    release:
      lifecycle_state: release_pending
      role: release_agent
      on_success: completed

  exception_policy:
    max_recovery_attempts_from: runtime.max_recovery_attempts
    rules:
      - name: implementation_retryable_retries_implementation
        match:
          source_stage: implementation
          artifact_kind: implementation_result
          status: failed_retryable
        action:
          type: retry_stage
          target_stage: implementation
        on_exhausted:
          type: quarantine

      - name: verification_retryable_returns_to_implementation
        match:
          source_stage: verification
          artifact_kind: verification_result
          status: failed_retryable
        action:
          type: return_to_stage
          target_stage: implementation
          carry_forward:
            - feedback_for_implementation
        on_exhausted:
          type: quarantine

      - name: release_retryable_retries_release
        match:
          source_stage: release
          artifact_kind: release_result
          status: failed_retryable
        action:
          type: retry_stage
          target_stage: release
        on_exhausted:
          type: quarantine

      - name: artifact_validation_retries_same_stage
        match:
          category: artifact_validation
        action:
          type: retry_same_stage
        on_exhausted:
          type: quarantine

      - name: blocked_requires_operator
        match:
          status: blocked
        action:
          type: quarantine

      - name: terminal_agent_failure_requires_operator
        match:
          status: failed_terminal
        action:
          type: quarantine

    default:
      action:
        type: quarantine
```

- [x] **Step 2: Run workflow tests and verify failures**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/workflow/workflow.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/workflow-generality.test.ts
```

Expected: FAIL where tests still assert old role/artifact names.

- [x] **Step 3: Update workflow test assertions**

In `tests/workflow/workflow.test.ts`, change:

```ts
assert.equal(release.stages.implementation.role, "issue_worker");
```

to:

```ts
assert.equal(release.stages.implementation.role, "implementation_agent");
assert.equal(release.roles.implementation_agent.artifact, "implementation_result");
assert.equal(release.exception_policy?.default.action.type, "quarantine");
```

Change role override assertions to use `implementation_agent` if the fixture config role overrides are also updated, or keep the old override fixture and add a separate assertion that unknown role overrides are ignored. Use this exact assertion for the workflow fixture itself:

```ts
assert.equal(workflow.roles.implementation_agent.prompt_template?.includes("{{issue_title}}"), true);
```

- [x] **Step 4: Update `.northstar` test fixture role overrides**

In `tests/fixtures/.northstar.yaml`, rename role override keys from `issue_worker`, `pr_verifier`, and `release_worker` to `implementation_agent`, `verifier_agent`, and `release_agent`.

- [x] **Step 5: Run focused tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/workflow/workflow.test.ts
node --disable-warning=ExperimentalWarning tests/workflow/workflow-validation.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/workflow-generality.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add tests/fixtures/workflows/issue-to-pr-release.yaml tests/fixtures/.northstar.yaml tests/workflow/workflow.test.ts tests/orchestrator/workflow-generality.test.ts
git commit -m "feat: update software dev workflow to agent-owned v2"
```

---

## Task 7: Add Agent Task Input and Release Worker Support

**Files:**
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `src/adapters/host/codex-worker.ts`
- Modify: `src/adapters/host/opencode-worker.ts`
- Modify: `src/adapters/host/pi-worker.ts`
- Modify: `src/orchestrator/production-dependencies.ts`
- Modify: `tests/adapters/sdk-workers.test.ts`
- Modify: `tests/orchestrator/production-dependencies.test.ts`

- [x] **Step 1: Write failing worker interface test**

In `tests/adapters/sdk-workers.test.ts`, add a test for `runRelease()` using the same fake SDK style already present in that file:

```ts
test("sdk software dev workers accept release task input", async () => {
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread() {
          return { id: "codex-root", run: async () => ({ finalResponse: JSON.stringify({ ok: true }) }) };
        }
      },
    }),
  });

  const result = await worker.runRelease({
    task_json: {
      schema_version: "1.0",
      task_kind: "release",
      northstar: { run_id: "northstar-production", issue_id: "github:7", stage: "release", attempt: 1 },
      repo: { provider: "github", name: "owner/repo", url: "https://github.com/owner/repo", base_branch: "main" },
      issue: { number: 7, title: "Release", body: "Body", url: "https://github.com/owner/repo/issues/7" },
      policy: { git_is_agent_owned: true, northstar_will_not_create_worktree: true, northstar_will_not_commit_or_push: true, northstar_will_not_create_or_merge_pr: true, northstar_will_not_validate_git_state: true },
      expected_output: { artifact_kind: "release_result", format: "json_object_only" },
    },
    prompt: "release",
    expected_artifact_kind: "release_result",
    role_name: "release_agent",
    role: { run_mode: "background_child", agent: "release", load_skills: [], artifact: "release_result", timeout_seconds: 30 },
    timeout_ms: 30_000,
  });

  assert.equal(result.root_session_id, "codex-root");
});
```

- [x] **Step 2: Run adapter tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
```

Expected: FAIL because `runRelease` is not in the interface.

- [x] **Step 3: Update worker interfaces**

In `src/orchestrator/software-dev-driver.ts`, import the task input type:

```ts
import type { SoftwareDevAgentTaskInput } from "./software-dev-contract.ts";
```

Replace the worker input interfaces with a common task input:

```ts
export interface SoftwareDevWorkerRoleContext {
  role_name?: string;
  role?: RoleDefinition;
  timeout_ms?: number;
}

export type SoftwareDevWorkerInput = SoftwareDevAgentTaskInput & SoftwareDevWorkerRoleContext;
export type SoftwareDevVerificationInput = SoftwareDevAgentTaskInput & SoftwareDevWorkerRoleContext;
export type SoftwareDevReleaseInput = SoftwareDevAgentTaskInput & SoftwareDevWorkerRoleContext;

export interface SoftwareDevWorker {
  runImplementation(input: SoftwareDevWorkerInput): Promise<SoftwareDevWorkerResult>;
  runVerification(input: SoftwareDevVerificationInput): Promise<SoftwareDevWorkerResult>;
  runRelease(input: SoftwareDevReleaseInput): Promise<SoftwareDevWorkerResult>;
  dispose?(): Promise<void>;
}
```

- [x] **Step 4: Add `runRelease()` to SDK workers**

In each SDK worker, add:

```ts
  async runRelease(input: SoftwareDevReleaseInput): Promise<SoftwareDevWorkerResult> {
    return await this.run("release", input, this.verificationTimeoutMs);
  }
```

Update private `run()` role unions from:

```ts
role: "implement" | "verify"
```

to:

```ts
role: "implement" | "verify" | "release"
```

Use `this.workingDirectory` as the working directory; do not read `worktree_path` because the agent owns workspace selection.

- [x] **Step 5: Update role-delegating worker**

In `src/orchestrator/production-dependencies.ts`, add:

```ts
  async runRelease(input: SoftwareDevReleaseInput): Promise<SoftwareDevWorkerResult> {
    return await this.factory.workerForRole("release_agent").runRelease(input);
  }
```

and import `SoftwareDevReleaseInput`.

- [x] **Step 6: Update fake workers in tests**

Any test helper implementing `SoftwareDevWorker` must add:

```ts
async runRelease() {
  return { root_session_id: "fake-release-root", child_run_id: "fake-release-child", final_response: "{}", shell_fallbacks: 0 as const };
}
```

Use distinct IDs in helpers that assert queue behavior.

- [x] **Step 7: Run focused tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/adapters/sdk-workers.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/production-dependencies.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/orchestrator/software-dev-driver.ts src/adapters/host/codex-worker.ts src/adapters/host/opencode-worker.ts src/adapters/host/pi-worker.ts src/orchestrator/production-dependencies.ts tests/adapters/sdk-workers.test.ts tests/orchestrator/production-dependencies.test.ts
git commit -m "feat: send software dev task json to host workers"
```

---

## Task 8: Rewrite SoftwareDevDomainDriver Boundary

**Files:**
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `src/orchestrator/domain-driver.ts`
- Modify: `src/orchestrator/production-dependencies.ts`
- Modify: `tests/orchestrator/software-dev-driver.test.ts`
- Modify: `tests/orchestrator/production-dependencies.test.ts`

- [x] **Step 1: Write failing no-git production test**

In `tests/orchestrator/production-dependencies.test.ts`, add:

```ts
test("software development production path does not wire git delivery into domain driver", async () => {
  const config = fixtureConfig({ projectRoot: "/repo", repo: "owner/repo", hostAdapter: "codex" });
  const created = await createProductionDependencies({
    config,
    usage: "watch",
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async (command) => {
      throw new Error(`git delivery command must not run: ${command.command} ${command.args.join(" ")}`);
    },
    fetch: async () => jsonResponse([]),
    sdkWorkers: { codex: () => agentOwnedFakeWorker("codex") },
  });

  const driver = created.registry.resolve({ workflow: loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml"), config, dependencies: {} }) as unknown as { worktree?: unknown };
  assert.equal(driver.worktree, undefined);
});
```

Add helper:

```ts
function agentOwnedFakeWorker(kind: "codex" | "opencode" | "pi"): SoftwareDevWorker & { kind: "codex" | "opencode" | "pi" } {
  const response = JSON.stringify({
    schema_version: "1.0",
    artifact_kind: "implementation_result",
    status: "failed_retryable",
    retryable: true,
    issue_number: 1,
    role: "implementation_agent",
    observed_at: "2026-06-03T00:00:00.000Z",
    summary: "fake",
  });
  return {
    kind,
    async runImplementation() { return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: response, shell_fallbacks: 0 }; },
    async runVerification() { return { root_session_id: `${kind}-root-v`, child_run_id: `${kind}-child-v`, final_response: response, shell_fallbacks: 0 }; },
    async runRelease() { return { root_session_id: `${kind}-root-r`, child_run_id: `${kind}-child-r`, final_response: response, shell_fallbacks: 0 }; },
  };
}
```

- [x] **Step 2: Run production test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/production-dependencies.test.ts
```

Expected: FAIL because the driver is still constructed with `worktree`.

- [x] **Step 3: Change `prepareStage()` to no-op agent-owned metadata**

In `SoftwareDevDomainDriver.prepareStage()`, replace worktree preparation with:

```ts
  async prepareStage(input: DomainDriverContext): Promise<StagePreparation> {
    this.fixturePath = "";
    this.fixtureContent = "";
    this.branch = "";
    this.worktreePath = `agent-owned://${this.kind}/${this.runId}/issue-${input.issue.number}`;
    return { worktreePath: this.worktreePath, branch: "" };
  }
```

This keeps current `StagePreparation` compatibility while making the path explicitly non-filesystem.

- [x] **Step 4: Replace implementation finalization with agent artifact parsing**

In `finalizeWorkerArtifact()`, replace git/PR creation flow with:

```ts
  async finalizeWorkerArtifact(input: FinalizeWorkerArtifactInput): Promise<PullRequestResult> {
    const artifact = await this.runImplementationAgent(input);
    const pr = prFromImplementationArtifact(artifact.payload);
    return {
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      branch: pr.branch,
      commitSha: pr.commitSha,
      workerArtifact: artifact.payload,
    };
  }
```

Add helpers:

```ts
function prFromImplementationArtifact(payload: Record<string, unknown>): PullRequestResult {
  const pr = objectRecord(payload.pr, "pr");
  return {
    prNumber: numberFieldRequired(pr.number, "pr.number"),
    prUrl: stringFieldRequired(pr.url, "pr.url"),
    branch: typeof pr.head_ref === "string" ? pr.head_ref : "",
    commitSha: typeof pr.head_sha === "string" ? pr.head_sha : "",
  };
}

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function numberFieldRequired(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${path} must be a positive integer`);
  return value;
}

function stringFieldRequired(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}
```

- [x] **Step 5: Implement `runImplementationAgent()` using task contracts**

Add method to `SoftwareDevDomainDriver`:

```ts
  private async runImplementationAgent(input: DomainDriverContext) {
    const task = buildSoftwareDevAgentTask({
      taskKind: "implementation",
      runId: this.runId,
      issueId: input.issue.id,
      stage: input.stage.name,
      attempt: numericRuntimeAttempt(input.runtimeContext),
      repo: repoTaskMetadata(this.repo, this.baseBranch),
      issue: issueTaskMetadata(input),
      expectedArtifactKind: "implementation_result",
    });
    const prompt = buildSoftwareDevAgentPrompt(task);
    const result = await this.worker.runImplementation({
      ...softwareDevWorkerRoleContext(input.role),
      task_json: task,
      prompt,
      expected_artifact_kind: "implementation_result",
    });
    validateWorkerOutput(this.kind, "implementation", result.final_response, this.metrics);
    this.metrics.software_dev_driver_shell_fallbacks += result.shell_fallbacks;
    this.host.enqueue({ rootSessionId: result.root_session_id, childRunId: result.child_run_id, sessionId: result.session_id ?? result.child_run_id, capabilityReport: result.capability_report });
    return parseSoftwareDevAgentResult(result.final_response, {
      expectedArtifactKind: "implementation_result",
      issueNumber: input.issue.number,
      role: input.role.name,
    });
  }
```

Add imports:

```ts
import { buildSoftwareDevAgentPrompt, buildSoftwareDevAgentTask, parseSoftwareDevAgentResult } from "./software-dev-contract.ts";
```

Add helpers:

```ts
function numericRuntimeAttempt(runtimeContext: Record<string, unknown>): number {
  const exception = runtimeContext.exception;
  if (typeof exception === "object" && exception !== null && !Array.isArray(exception)) {
    const attempt = (exception as Record<string, unknown>).attempt_count;
    if (typeof attempt === "number" && Number.isFinite(attempt)) return attempt;
  }
  return 1;
}

function repoTaskMetadata(repo: string, baseBranch: string) {
  return { provider: "github" as const, name: repo, url: `https://github.com/${repo}`, base_branch: baseBranch };
}

function issueTaskMetadata(input: DomainDriverContext) {
  return { number: input.issue.number, title: input.issue.title, body: input.issue.body, url: input.issue.sourceUrl };
}
```

- [x] **Step 6: Rewrite verification and release to agent artifacts**

Replace `runAndValidateVerification()` internals with a task built as `taskKind: "verification"`, `expectedArtifactKind: "verification_result"`, and `worker.runVerification()`.

Replace `releaseVerifiedItem()` with:

```ts
  async releaseVerifiedItem(input: ReleaseVerifiedItemInput): Promise<ReleaseResult> {
    const task = buildSoftwareDevAgentTask({
      taskKind: "release",
      runId: this.runId,
      issueId: input.issue.id,
      stage: input.stage.name,
      attempt: numericRuntimeAttempt(input.runtimeContext),
      repo: repoTaskMetadata(this.repo, this.baseBranch),
      issue: issueTaskMetadata(input),
      expectedArtifactKind: "release_result",
    });
    const prompt = buildSoftwareDevAgentPrompt(task);
    const result = await this.worker.runRelease({
      ...softwareDevWorkerRoleContext(input.role),
      task_json: task,
      prompt,
      expected_artifact_kind: "release_result",
    });
    validateWorkerOutput(this.kind, "release", result.final_response, this.metrics);
    const artifact = parseSoftwareDevAgentResult(result.final_response, {
      expectedArtifactKind: "release_result",
      issueNumber: input.issue.number,
      role: input.role.name,
    });
    this.metrics.software_dev_driver_shell_fallbacks += result.shell_fallbacks;
    this.host.enqueue({ rootSessionId: result.root_session_id, childRunId: result.child_run_id, sessionId: result.session_id ?? result.child_run_id, capabilityReport: result.capability_report });
    const release = objectRecord(artifact.payload.release, "release");
    return {
      confirmed: release.confirmed === true,
      mergeSha: stringFieldRequired(release.merge_commit, "release.merge_commit"),
      releaseArtifact: artifact.payload,
    } as ReleaseResult;
  }
```

Then add optional `releaseArtifact?: Record<string, unknown>; issueUpdate?: Record<string, unknown>;` to `ReleaseResult` in `src/orchestrator/domain-driver.ts`.

- [x] **Step 7: Remove delivery calls from constructor path**

In `src/orchestrator/production-dependencies.ts`, construct the driver without `worktree`:

```ts
      baseBranch: input.config.git.baseBranch,
```

Do not pass `worktree` into `SoftwareDevDomainDriver`.

- [x] **Step 8: Run focused tests and update expectations**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/production-dependencies.test.ts
```

Expected after expectation updates: PASS. Remove or rewrite tests that assert `prepare-worktree`, `commit-push`, `createPullRequest`, `mergePullRequest`, and `syncBaseBranch` calls. Replace them with assertions that worker prompts contain `git_is_agent_owned` and no delivery gateway calls occur.

- [x] **Step 9: Commit**

```bash
git add src/orchestrator/software-dev-driver.ts src/orchestrator/domain-driver.ts src/orchestrator/production-dependencies.ts tests/orchestrator/software-dev-driver.test.ts tests/orchestrator/production-dependencies.test.ts
git commit -m "feat: make software dev git release agent-owned"
```

---

## Task 9: Resolve Exception Issues in Watch/Reconcile

**Files:**
- Modify: `src/orchestrator/cycle.ts`
- Modify: `src/runtime/repair.ts`
- Modify: `tests/orchestrator/watch-orchestrator.test.ts`
- Modify: `tests/runtime/repair-inspect.test.ts`

- [x] **Step 1: Write failing watch resolver test**

In `tests/orchestrator/watch-orchestrator.test.ts`, add a test that creates an `exception` issue with a verification retryable exception and runs one cycle:

```ts
test("run cycle resolves workflow exception according to exception_policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-exception-resolver-"));
  const store = SqliteControlPlaneStore.open(join(dir, "northstar.sqlite"));
  const workflowPath = join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml");
  const workflow = loadWorkflow(workflowPath);
  store.createIssue(newIssueSnapshot("github:77", {
    lifecycle_state: "exception",
    runtime_context_json: {
      issue_packet: { issue_number: "77", title: "Fix filter", raw_text: "Body" },
      exception: {
        id: "exc-77",
        source_lifecycle: "verifying",
        source_stage: "verification",
        source_role: "verifier_agent",
        artifact_kind: "verification_result",
        status: "failed_retryable",
        category: "agent_reported_failure",
        severity: "retryable",
        retryable: true,
        attempt_count: 1,
        payload: { feedback_for_implementation: ["Fix filter"] },
      },
    },
  }));

  const orchestrator = createProductionOrchestrator({
    store,
    host: new FakeHostAdapter(),
    domain: new FakeDomainDriver(),
    workflowPath,
    now: () => "2026-06-03T00:00:00.000Z",
    leaseTimeoutSeconds: 180,
    roleOverrides: {},
  });

  const result = await orchestrator.runCycle({ autoRelease: false, maxStarts: 0 });
  const snapshot = store.getIssue("github:77");

  assert.equal(result.progressed, true);
  assert.equal(snapshot.lifecycle_state, "running");
  assert.equal(snapshot.runtime_context_json.stage_cursor, "implementation");
  assert.equal(store.listHistory("github:77").at(-1)?.event_type, "exception_resolved");
});
```

Adapt imports to names already present in the file.

- [x] **Step 2: Run watch test and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
```

Expected: FAIL because run cycle ignores `exception` issues.

- [x] **Step 3: Call resolver before scheduling**

In `src/orchestrator/cycle.ts`, import:

```ts
import { resolveExceptionPolicy } from "../runtime/exception-policy.ts";
```

Inside `runCycle()` after initial issue load and before active issue calculation, add:

```ts
      const exceptionResolved = reconcileWorkflowExceptions({
        snapshots: allIssues,
        store: options.store,
        workflow,
        maxRecoveryAttempts: 2,
        now: options.now(),
      });
      if (exceptionResolved) {
        allIssues = options.store.listAllIssuesForTests();
      }
```

Use config value when available in this factory. If `createProductionOrchestrator()` does not currently receive `maxRecoveryAttempts`, add `maxRecoveryAttempts?: number` to its options and pass `config.runtime.maxRecoveryAttempts` from the CLI/factory call sites. Use default `2` only for tests that construct the orchestrator directly.

Add helper near other reconcile helpers:

```ts
function reconcileWorkflowExceptions(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  workflow: WorkflowDefinition;
  maxRecoveryAttempts: number;
  now: string;
}): boolean {
  let changed = false;
  for (const snapshot of input.snapshots) {
    if (snapshot.lifecycle_state !== "exception") continue;
    const result = resolveExceptionPolicy(snapshot, input.workflow, {
      maxRecoveryAttempts: input.maxRecoveryAttempts,
      now: input.now,
    });
    if (result.history.length === 0) continue;
    input.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, result.history, result.snapshot);
    changed = true;
  }
  return changed;
}
```

- [x] **Step 4: Change repair ownership release to exception**

In `src/runtime/repair.ts`, modify `lifecycleAfterOwnershipRelease()` so active invalid ownership enters `exception`:

```ts
function lifecycleAfterOwnershipRelease(previousLifecycle: LifecycleState): LifecycleState {
  if (["claimed", "running", "verifying", "release_pending"].includes(previousLifecycle)) {
    return "exception";
  }
  return "ready";
}
```

In `releaseActiveRuntimeOwnership()`, when `nextLifecycle === "exception"`, write `runtime_context_json.exception`:

```ts
  if (nextLifecycle === "exception") {
    next.runtime_context_json.exception = {
      id: `exc_repair_${Date.parse(input.now) || 0}`,
      state: "pending_reconcile",
      source_lifecycle: previousLifecycle,
      source_stage: previousStage,
      category: "runtime_invariant",
      severity: "retryable",
      retryable: true,
      summary: input.reasonCode,
      attempt_count: 1,
      payload: input.details ?? {},
      created_at: input.now,
      last_reconciled_at: null,
    };
  }
```

- [x] **Step 5: Run focused tests and update expectations**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/repair-inspect.test.ts
```

Expected after updates: PASS. Tests that previously expected active invalid ownership to return to `ready` or `verified` should expect `exception` with a structured exception context, except completed/terminal cleanup behavior remains unchanged.

- [x] **Step 6: Commit**

```bash
git add src/orchestrator/cycle.ts src/runtime/repair.ts tests/orchestrator/watch-orchestrator.test.ts tests/runtime/repair-inspect.test.ts
git commit -m "feat: reconcile workflow exceptions before scheduling"
```

---

## Task 10: Release Completion From Release Artifact and Projection Instructions

**Files:**
- Modify: `src/orchestrator/cycle.ts`
- Modify: `src/orchestrator/issue-flow.ts`
- Modify: `src/adapters/github/observability.ts`
- Modify: `tests/orchestrator/orchestrator-cli.test.ts`
- Modify: `tests/orchestrator/watch-orchestrator.test.ts`
- Modify: `tests/adapters/github-observability.test.ts`

- [x] **Step 1: Write failing release projection test**

In `tests/orchestrator/watch-orchestrator.test.ts`, add an auto-release test whose release worker returns a valid `release_result.completed` with `issue_update.comment_summary` and assert completed lifecycle plus projection retry isolation.

Use this release artifact in the fake worker:

```ts
const releaseArtifact = {
  schema_version: "1.0",
  artifact_kind: "release_result",
  status: "completed",
  retryable: false,
  issue_number: 88,
  role: "release_agent",
  observed_at: "2026-06-03T13:00:00.000Z",
  summary: "PR #456 was merged successfully.",
  pr: { url: "https://github.com/owner/repo/pull/456", number: 456 },
  release: { confirmed: true, type: "github_pr_merge", merge_commit: "def456", released_at: "2026-06-03T13:00:00.000Z" },
  evidence: [{ type: "merge_commit", value: "def456" }],
  issue_update: { comment_summary: "Released via PR #456.", close_issue: true, labels_to_add: ["northstar:released"], labels_to_remove: ["northstar:ready"] },
};
```

- [x] **Step 2: Run release tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
```

Expected: FAIL because release currently uses `submitConfirmedRelease()` with Northstar merge truth.

- [x] **Step 3: Submit release artifact as child artifact**

In `src/orchestrator/cycle.ts`, inside `releaseIssue()` after `domain.releaseVerifiedItem()` returns, replace `submitConfirmedRelease()` with `submitChildArtifactPayload()` when `release.releaseArtifact` exists:

```ts
      result = release.releaseArtifact
        ? submitChildArtifactPayload({
            snapshot,
            workflow,
            childRunId: snapshot.runtime_context_json.child_runs?.at(-1)?.child_run_id ?? `release-${input.issueId}`,
            artifactHistoryId: options.store.listHistory(input.issueId).length + 1,
            artifact: release.releaseArtifact,
            now: options.now(),
          })
        : submitConfirmedRelease({
            snapshot,
            workflow,
            mergeSha: release.mergeSha,
            syncWorktree: release.syncWorktree,
            now: options.now(),
          });
```

This keeps old tests passing while making agent-owned release the production path.

- [x] **Step 4: Project issue updates from release artifact**

In `releaseIssue()`, after committing the completed snapshot, read:

```ts
const releaseIssueUpdate = result.snapshot.runtime_context_json.release?.issue_update;
```

If it is an object, pass its `comment_summary`, `close_issue`, labels add/remove into the existing GitHub observability/projection adapter calls. Keep failures as projection retry history only. Do not mutate lifecycle on projection failures.

- [x] **Step 5: Run focused tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/orchestrator-cli.test.ts
node --disable-warning=ExperimentalWarning tests/adapters/github-observability.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/orchestrator/cycle.ts src/orchestrator/issue-flow.ts src/adapters/github/observability.ts tests/orchestrator/watch-orchestrator.test.ts tests/orchestrator/orchestrator-cli.test.ts tests/adapters/github-observability.test.ts
git commit -m "feat: complete release from agent artifact"
```

---

## Task 11: Remove Northstar Git/PR/Merge Truth From Production Path

**Files:**
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `src/orchestrator/production-dependencies.ts`
- Modify: `src/orchestrator/cycle.ts`
- Modify: `tests/orchestrator/software-dev-driver.test.ts`
- Modify: `tests/orchestrator/production-dependencies.test.ts`
- Modify: `tests/orchestrator/watch-orchestrator.test.ts`

- [x] **Step 1: Write throwing dependency regression test**

Create fakes in `tests/orchestrator/software-dev-driver.test.ts` where every old git/GitHub delivery method throws:

```ts
class ThrowingDeliveryGitHub extends RecordingGitHub {
  override async createFixtureBranch() { throw new Error("createFixtureBranch must not be called"); }
  override async readBranchCommit() { throw new Error("readBranchCommit must not be called"); }
  override async createPullRequest() { throw new Error("createPullRequest must not be called"); }
  override async createOrReusePullRequest() { throw new Error("createOrReusePullRequest must not be called"); }
  override async mergePullRequest() { throw new Error("mergePullRequest must not be called"); }
  override async findMergedPullRequestForIssue() { throw new Error("findMergedPullRequestForIssue must not be called"); }
}
```

Add a test that runs prepare/finalize/release using an agent-owned worker and asserts no throwing method is called.

- [x] **Step 2: Run software driver tests and verify failure**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
```

Expected: FAIL until all old delivery calls are removed from tested paths.

- [x] **Step 3: Delete or stop calling old delivery helpers**

In `src/orchestrator/software-dev-driver.ts`, remove call sites for:

```text
prepareIssueWorktree
commitAndPush
createFixtureBranch
readBranchCommit
createPullRequest
createOrReusePullRequest
mergePullRequest
findMergedPullRequestForIssue
syncBaseBranch
recoverSyncBaseBranch
recoverMergeConflict
```

Keep type definitions only if other tests still import them; otherwise remove interfaces from this file and update imports.

- [x] **Step 4: Disable external completion as lifecycle truth for software-dev driver**

In `SoftwareDevDomainDriver.reconcileExternalCompletion()`, return `undefined`:

```ts
  async reconcileExternalCompletion(_input: DomainDriverContext): Promise<ExternalCompletionResult | undefined> {
    return undefined;
  }
```

This preserves the generic interface while satisfying the design that Northstar no longer uses external PR merge state as software-development lifecycle truth.

- [x] **Step 5: Run regression tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/production-dependencies.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/orchestrator/software-dev-driver.ts src/orchestrator/production-dependencies.ts src/orchestrator/cycle.ts tests/orchestrator/software-dev-driver.test.ts tests/orchestrator/production-dependencies.test.ts tests/orchestrator/watch-orchestrator.test.ts
git commit -m "refactor: remove software dev delivery truth from runtime"
```

---

## Task 12: Documentation, Spec Compliance, and Full Verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- Modify: `docs/superpowers/specs/2026-06-03-agent-owned-git-release-design.md` if implementation notes differ from proposal
- Modify: `tests/spec/spec-compliance.test.ts`
- Modify: `tests/coverage/requirement-coverage.test.ts` if it tracks lifecycle/artifact requirements

- [x] **Step 1: Update runtime invariant docs**

In `CLAUDE.md`, replace the fixed lifecycle list with:

```text
ready, claimed, running, verifying, verified, release_pending, exception, completed, cancelled, failed, quarantined
```

Add this sentence:

```text
`exception` is a non-active automatic recovery state driven by `workflow.exception_policy`; `quarantined` remains the human-intervention state.
```

- [x] **Step 2: Update authoritative runtime spec**

In `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`, update the lifecycle section to include `exception`, and describe:

```text
Workflow-blocking abnormal outcomes transition into `exception` with structured context. Reconcile/watch resolves `exception` via `workflow.exception_policy` and `runtime.max_recovery_attempts`; exhausted or manual-required exceptions transition to `quarantined` or `failed` according to policy.
```

Also replace the old release completion invariant with:

```text
For the software-development workflow, release completion is driven by a schema-valid `release_result` artifact with `status=completed` and `release.confirmed=true`. Northstar does not validate PR existence, branch state, or merge commit existence for lifecycle truth.
```

- [x] **Step 3: Update spec compliance tests**

In `tests/spec/spec-compliance.test.ts`, update lifecycle expectations to include `exception`, and add assertions that the implementation contains:

```ts
assert.match(readFileSync("src/runtime/exception-policy.ts", "utf8"), /resolveExceptionPolicy/);
assert.match(readFileSync("src/orchestrator/software-dev-contract.ts", "utf8"), /git_is_agent_owned/);
```

- [x] **Step 4: Run focused spec tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/spec/spec-compliance.test.ts
```

Expected: PASS.

- [x] **Step 5: Run full unit/integration suite**

Run:

```bash
npm test
```

Expected: PASS. Do not run `test:e2e:*`, `test:live`, or `test:*:live` as part of routine verification.

- [x] **Step 6: Run coverage gate**

Run:

```bash
npm run test:coverage
```

Expected: PASS with at least 85% lines, branches, functions, and statements.

- [x] **Step 7: Commit**

```bash
git add CLAUDE.md docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md docs/superpowers/specs/2026-06-03-agent-owned-git-release-design.md tests/spec/spec-compliance.test.ts tests/coverage/requirement-coverage.test.ts
git commit -m "docs: document agent-owned release runtime invariants"
```

---

## Self-Review

### Spec Coverage

- Agent-owned git/worktree/branch/PR/merge/release operations: Tasks 7, 8, 11.
- Northstar as durable control plane: Tasks 2, 3, 5, 9, 10.
- Three stages implementation → verification → release: Task 6.
- Independent verifier and browser evidence contract: Task 4.
- New `exception` lifecycle: Tasks 3, 5, 9, 12.
- Workflow-driven exception policy: Tasks 2, 3, 6, 9.
- Runtime retry budget from `runtime.max_recovery_attempts`: Task 9.
- Release completion from `release_result.completed`: Tasks 4, 5, 10.
- Projection failures remain retryable and non-lifecycle: Tasks 5, 10, 12.
- Existing intentionally quarantined issues remain human-intervention state: Tasks 3 and 9 keep `quarantined` out of automatic scheduling.

### Type Consistency

- Artifact kinds are consistently `implementation_result`, `verification_result`, `release_result`.
- Workflow roles are consistently `implementation_agent`, `verifier_agent`, `release_agent`.
- Exception policy action types are consistently `retry_same_stage`, `retry_stage`, `return_to_stage`, `quarantine`, `fail`.
- New task input type is consistently `SoftwareDevAgentTaskInput` with `task_json`, `prompt`, and `expected_artifact_kind`.

### Verification Commands

Use these commands while executing tasks:

```bash
node --disable-warning=ExperimentalWarning tests/config/load-config.test.ts
node --disable-warning=ExperimentalWarning tests/workflow/workflow-validation.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/exception-policy.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/artifacts.test.ts
node --disable-warning=ExperimentalWarning tests/runtime/state-machine.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-contract.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/software-dev-driver.test.ts
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
npm test
npm run test:coverage
```

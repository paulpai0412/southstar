# Northstar Controlled Recovery Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first controlled recovery workflow slice by extracting current ad-hoc exception/recovery handling into a centralized recovery subsystem with deterministic catalog actions, policy checks, bounded evidence, and reconcile-only progression.

**Architecture:** Create `src/recovery/` as the single home for recovery classification, evidence collection, action matching, policy decisions, and deterministic execution results. `src/orchestrator/cycle.ts` should stop owning one-off recovery helper implementations and instead delegate blocked/exceptional cases to the recovery controller while keeping reconcile/runCycle as the only workflow progression path. This plan does not add LLM advisor execution yet; it establishes the catalog/policy boundary that LLM proposals will later use.

**Tech Stack:** TypeScript ESM, Node `node:test`, SQLite-backed `SqliteControlPlaneStore`, existing `DomainDriver` recovery hooks, existing state-machine/runtime-context JSON model.

---

## File Structure

Create focused recovery modules:

- Create: `src/recovery/types.ts`
  - Shared types: trigger, evidence packet, action definition, action result, policy decision.
- Create: `src/recovery/errors.ts`
  - Central error normalization and classification currently duplicated in orchestrator/software-dev code.
- Create: `src/recovery/blockers.ts`
  - Shared blocked_by list helpers and trigger construction.
- Create: `src/recovery/evidence.ts`
  - Bounded, redacted recovery evidence packet builder.
- Create: `src/recovery/catalog.ts`
  - Deterministic action catalog and matcher.
- Create: `src/recovery/controller.ts`
  - Policy-gated recovery orchestration called by reconcile/runCycle.
- Create: `tests/recovery/errors.test.ts`
  - Error normalization/classification tests.
- Create: `tests/recovery/catalog.test.ts`
  - Catalog matching and policy rejection tests.
- Create: `tests/recovery/evidence.test.ts`
  - Evidence packet shape, redaction, and size-bound tests.
- Create: `tests/recovery/controller.test.ts`
  - Controller behavior: clear blockers without dispatch, unsupported action rejected, failure remains blocked.

Modify existing files:

- Modify: `src/orchestrator/cycle.ts`
  - Remove local recovery helper implementations and call `RecoveryController`.
  - Keep lifecycle progression decisions in reconcile/runCycle.
- Modify: `src/orchestrator/domain-driver.ts`
  - Keep `recoverDispatchBlock` as deterministic domain hook used by catalog action executor.
- Modify: `src/orchestrator/software-dev-driver.ts`
  - Import shared recovery error helpers where applicable; keep domain-specific retryable errors local.
- Modify: `src/adapters/git/software-dev-worktree.ts`
  - No structural change expected; catalog calls existing methods through domain driver.
- Modify: `tests/orchestrator/watch-orchestrator.test.ts`
  - Update expectations from old event names where needed and verify orchestrator delegates recovery.
- Modify: `tests/orchestrator/software-dev-driver.test.ts`
  - Keep existing secret false-positive regression; import shared helpers only if necessary.
- Modify: `tests/index.test.ts`
  - Import new recovery test files.

---

### Task 1: Add centralized recovery types

**Files:**
- Create: `src/recovery/types.ts`
- Test indirectly from later tasks.

- [ ] **Step 1: Create the shared recovery type file**

Write `src/recovery/types.ts`:

```ts
import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../types/control-plane.ts";
import type { DomainDriver } from "../orchestrator/domain-driver.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import type { SqliteControlPlaneStore } from "../runtime/store.ts";
import type { ProductionObservability, ProductionProgressReporter } from "../orchestrator/cycle.ts";
import type { emptyManualCliMetrics } from "../orchestrator/metrics.ts";

export type RecoveryTriggerSource =
  | "dispatch"
  | "reconcile"
  | "release"
  | "projection"
  | "host_liveness"
  | "artifact";

export type RecoveryRisk = "safe" | "low" | "medium" | "high";

export interface RecoveryTrigger {
  source: RecoveryTriggerSource;
  lifecycleState: LifecycleState;
  stage?: string;
  blocker?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface RecoveryEvidencePacket {
  issue: {
    id: string;
    number?: number;
    lifecycleState: LifecycleState;
    stage?: string;
    workflowId: string;
    domain?: string;
  };
  trigger: RecoveryTrigger;
  runtime: {
    ownerLease?: Record<string, unknown>;
    childRuns: Array<Record<string, unknown>>;
    recentHistory: Array<Record<string, unknown>>;
    recoveryAttempts: number;
  };
  allowedActions: Array<{
    id: string;
    risk: RecoveryRisk;
    summary: string;
    requiredInputs: string[];
  }>;
}

export interface RecoveryActionInput {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  domain: DomainDriver;
  trigger: RecoveryTrigger;
  evidence: RecoveryEvidencePacket;
  now: string;
}

export interface RecoveryDryRunResult {
  ok: boolean;
  reason?: string;
}

export interface RecoveryExecutionResult {
  snapshot: IssueSnapshot;
  history: HistoryEntry[];
  message: string;
  clearedBlocker?: string;
}

export interface RecoveryActionDefinition {
  id: string;
  description: string;
  match: {
    lifecycleStates: LifecycleState[];
    stages?: string[];
    blockers?: string[];
    errorCodes?: string[];
    domains?: string[];
  };
  risk: RecoveryRisk;
  requiredInputs: string[];
  dryRun(input: RecoveryActionInput): Promise<RecoveryDryRunResult>;
  execute(input: RecoveryActionInput): Promise<RecoveryExecutionResult>;
}

export interface RecoveryPolicyDecision {
  decision: "accepted" | "rejected" | "approval_required";
  reason: string;
  actionId?: string;
}

export interface RecoveryControllerInput {
  snapshot: IssueSnapshot;
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
  observability?: ProductionObservability;
  metrics?: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  progress?: ProductionProgressReporter;
}

export interface RecoveryControllerResult {
  handled: boolean;
  snapshot: IssueSnapshot;
  nextAction: string;
  message: string;
}
```

- [ ] **Step 2: Run TypeScript import smoke through tests**

Run:

```bash
cd ../northstar
npx tsx -e "import './src/recovery/types.ts'; console.log('types imported')"
```

Expected: `types imported`.

- [ ] **Step 3: Commit**

```bash
git add src/recovery/types.ts
git commit -m "feat: add recovery subsystem types"
```

---

### Task 2: Centralize error normalization and recovery classification

**Files:**
- Create: `src/recovery/errors.ts`
- Create: `tests/recovery/errors.test.ts`
- Modify later: `src/orchestrator/cycle.ts`, `src/orchestrator/software-dev-driver.ts`

- [ ] **Step 1: Write failing tests for centralized error helpers**

Create `tests/recovery/errors.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  errorCode,
  errorMessage,
  isRecoverableDispatchBlocker,
  isVerifierArtifactRejection,
} from "../../src/recovery/errors.ts";
import { ArtifactValidationError } from "../../src/runtime/artifacts.ts";

test("recovery errors extract stable code and message", () => {
  const error = Object.assign(new Error("sync worktree dirty"), { code: "SYNC_WORKTREE_DIRTY" });
  assert.equal(errorCode(error), "SYNC_WORKTREE_DIRTY");
  assert.equal(errorMessage(error), "sync worktree dirty");
  assert.equal(errorCode("plain"), undefined);
  assert.equal(errorMessage("plain"), "plain");
});

test("recovery errors classify dispatch blockers by stable codes", () => {
  assert.equal(isRecoverableDispatchBlocker(Object.assign(new Error("dirty"), { code: "SYNC_WORKTREE_DIRTY" })), true);
  assert.equal(isRecoverableDispatchBlocker(Object.assign(new Error("ff"), { code: "SYNC_WORKTREE_FAST_FORWARD_FAILED" })), true);
  assert.equal(isRecoverableDispatchBlocker(Object.assign(new Error("other"), { code: "WORKTREE_NO_CHANGES" })), false);
});

test("recovery errors classify verifier artifact rejection", () => {
  assert.equal(isVerifierArtifactRejection(new ArtifactValidationError("ARTIFACT_MISSING_FIELD", "artifact_kind", "missing")), true);
  assert.equal(isVerifierArtifactRejection(Object.assign(new Error("bad artifact"), { code: "ARTIFACT_BAD" })), true);
  assert.equal(isVerifierArtifactRejection(new Error("browser acceptance requires a structured verifier evidence artifact")), true);
  assert.equal(isVerifierArtifactRejection(new Error("network down")), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/errors.test.ts
```

Expected: FAIL because `src/recovery/errors.ts` does not exist.

- [ ] **Step 3: Implement centralized helpers**

Create `src/recovery/errors.ts`:

```ts
import { ArtifactValidationError } from "../runtime/artifacts.ts";

const recoverableDispatchCodes = new Set([
  "SYNC_WORKTREE_DIRTY",
  "SYNC_WORKTREE_STATUS_FAILED",
  "SYNC_WORKTREE_FETCH_FAILED",
  "SYNC_WORKTREE_FAST_FORWARD_FAILED",
  "SYNC_WORKTREE_CREATE_FAILED",
  "SYNC_WORKTREE_RECOVERY_FAILED",
  "WORKTREE_BASE_SYNC_FAILED",
  "WORKTREE_CREATE_FAILED",
]);

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecoverableDispatchBlocker(error: unknown): boolean {
  return recoverableDispatchCodes.has(errorCode(error) ?? "");
}

export function isVerifierArtifactRejection(error: unknown): boolean {
  if (error instanceof ArtifactValidationError) return true;
  const code = errorCode(error);
  if (typeof code === "string" && code.startsWith("ARTIFACT_")) return true;
  return /browser acceptance requires a structured verifier evidence artifact|ARTIFACT_BROWSER_EVIDENCE_REQUIRED|ArtifactValidationError/i
    .test(errorMessage(error));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/errors.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recovery/errors.ts tests/recovery/errors.test.ts
git commit -m "feat: centralize recovery error classification"
```

---

### Task 3: Centralize blocker list helpers and trigger construction

**Files:**
- Create: `src/recovery/blockers.ts`
- Create: `tests/recovery/blockers.test.ts`
- Modify later: `src/orchestrator/cycle.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/recovery/blockers.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addBlockedBy,
  blockedByListForSnapshot,
  recoverableBlockedByForSnapshot,
  removeBlockedBy,
  triggerFromSnapshot,
} from "../../src/recovery/blockers.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("blocker helpers add remove and filter recoverable blockers", () => {
  assert.deepEqual(addBlockedBy(undefined, "sync_worktree"), ["sync_worktree"]);
  assert.deepEqual(addBlockedBy(["sync_worktree"], "sync_worktree"), ["sync_worktree"]);
  assert.deepEqual(removeBlockedBy(["sync_worktree", "dependency:1:missing"], "sync_worktree"), ["dependency:1:missing"]);

  const snapshot = newIssueSnapshot("github:1", {
    lifecycle_state: "ready",
    runtime_context_json: { blocked_by: ["sync_worktree", "dependency:1:missing"] },
  });
  assert.deepEqual(blockedByListForSnapshot(snapshot), ["sync_worktree", "dependency:1:missing"]);
  assert.deepEqual(recoverableBlockedByForSnapshot(snapshot), ["sync_worktree"]);
});

test("triggerFromSnapshot preserves state stage blocker and error code", () => {
  const snapshot = newIssueSnapshot("github:2", {
    lifecycle_state: "ready",
    runtime_context_json: {
      stage_cursor: "implementation",
      blocked_by: ["sync_worktree"],
      blocked_error_code: "SYNC_WORKTREE_DIRTY",
      last_error: "dirty",
    },
  });
  assert.deepEqual(triggerFromSnapshot(snapshot, "dispatch"), {
    source: "dispatch",
    lifecycleState: "ready",
    stage: "implementation",
    blocker: "sync_worktree",
    errorCode: "SYNC_WORKTREE_DIRTY",
    errorMessage: "dirty",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/blockers.test.ts
```

Expected: FAIL because `src/recovery/blockers.ts` does not exist.

- [ ] **Step 3: Implement blocker helpers**

Create `src/recovery/blockers.ts`:

```ts
import type { IssueSnapshot } from "../types/control-plane.ts";
import type { RecoveryTrigger, RecoveryTriggerSource } from "./types.ts";

export function blockedByListForSnapshot(snapshot: IssueSnapshot): string[] {
  const blockedBy = snapshot.runtime_context_json.blocked_by;
  if (!Array.isArray(blockedBy)) return [];
  return blockedBy.map(String).filter((value) => value.length > 0);
}

export function recoverableBlockedByForSnapshot(snapshot: IssueSnapshot): string[] {
  return blockedByListForSnapshot(snapshot).filter((value) => value === "sync_worktree" || value === "host_liveness");
}

export function addBlockedBy(value: unknown, blocker: string): string[] {
  const existing = Array.isArray(value) ? value.map(String) : [];
  return [...new Set([...existing, blocker])];
}

export function removeBlockedBy(value: unknown, blocker: string): string[] {
  const existing = Array.isArray(value) ? value.map(String) : [];
  return existing.filter((entry) => entry !== blocker);
}

export function triggerFromSnapshot(snapshot: IssueSnapshot, source: RecoveryTriggerSource): RecoveryTrigger {
  const blockers = recoverableBlockedByForSnapshot(snapshot);
  const stage = typeof snapshot.runtime_context_json.stage_cursor === "string"
    ? snapshot.runtime_context_json.stage_cursor
    : undefined;
  const errorCode = typeof snapshot.runtime_context_json.blocked_error_code === "string"
    ? snapshot.runtime_context_json.blocked_error_code
    : undefined;
  const errorMessage = typeof snapshot.runtime_context_json.last_error === "string"
    ? snapshot.runtime_context_json.last_error
    : undefined;
  return {
    source,
    lifecycleState: snapshot.lifecycle_state,
    ...(stage ? { stage } : {}),
    ...(blockers[0] ? { blocker: blockers[0] } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/blockers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recovery/blockers.ts tests/recovery/blockers.test.ts
git commit -m "feat: add recovery blocker helpers"
```

---

### Task 4: Build bounded recovery evidence packets

**Files:**
- Create: `src/recovery/evidence.ts`
- Create: `tests/recovery/evidence.test.ts`

- [ ] **Step 1: Write failing evidence tests**

Create `tests/recovery/evidence.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRecoveryEvidencePacket } from "../../src/recovery/evidence.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import type { HistoryEntry } from "../../src/types/control-plane.ts";

test("buildRecoveryEvidencePacket emits bounded sanitized issue and history context", () => {
  const snapshot = newIssueSnapshot("github:69", {
    lifecycle_state: "ready",
    runtime_context_json: {
      issue_packet: { issue_number: "69", title: "Task 1" },
      stage_cursor: "implementation",
      blocked_by: ["sync_worktree"],
      blocked_error_code: "SYNC_WORKTREE_DIRTY",
      last_error: "token sk-secret-value-123456 should redact",
      owner_lease: { lease_id: "lease-1", last_heartbeat_at: "2026-06-03T00:00:00.000Z" },
      child_runs: [{ child_run_id: "child-1", role: "issue_worker", status: "lost" }],
    },
  });
  const history: HistoryEntry[] = Array.from({ length: 30 }, (_, index) => ({
    event_type: `event_${index}`,
    payload: { message: `payload ${index} ghp_secretvalue1234567890` },
  }));

  const packet = buildRecoveryEvidencePacket({
    snapshot,
    workflowId: "issue_to_pr_release",
    workflowDomain: "software_development",
    trigger: {
      source: "dispatch",
      lifecycleState: "ready",
      stage: "implementation",
      blocker: "sync_worktree",
      errorCode: "SYNC_WORKTREE_DIRTY",
      errorMessage: "token sk-secret-value-123456 should redact",
    },
    recentHistory: history,
    allowedActions: [{ id: "sync_worktree.reset_dirty", risk: "low", summary: "Reset dirty sync worktree", requiredInputs: [] }],
  });

  assert.equal(packet.issue.id, "github:69");
  assert.equal(packet.issue.number, 69);
  assert.equal(packet.runtime.recentHistory.length, 20);
  assert.equal(JSON.stringify(packet).includes("sk-secret"), false);
  assert.equal(JSON.stringify(packet).includes("ghp_secret"), false);
  assert.deepEqual(packet.allowedActions.map((action) => action.id), ["sync_worktree.reset_dirty"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/evidence.test.ts
```

Expected: FAIL because `src/recovery/evidence.ts` does not exist.

- [ ] **Step 3: Implement evidence packet builder**

Create `src/recovery/evidence.ts`:

```ts
import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";
import { redactSecrets } from "../runtime/redaction.ts";
import type { RecoveryEvidencePacket, RecoveryTrigger } from "./types.ts";

export function buildRecoveryEvidencePacket(input: {
  snapshot: IssueSnapshot;
  workflowId: string;
  workflowDomain?: string;
  trigger: RecoveryTrigger;
  recentHistory: HistoryEntry[];
  allowedActions: RecoveryEvidencePacket["allowedActions"];
}): RecoveryEvidencePacket {
  const packet = issuePacket(input.snapshot);
  const issueNumber = Number(packet.issue_number ?? "0");
  return sanitizePacket({
    issue: {
      id: input.snapshot.issue_id,
      ...(Number.isInteger(issueNumber) && issueNumber > 0 ? { number: issueNumber } : {}),
      lifecycleState: input.snapshot.lifecycle_state,
      ...(input.trigger.stage ? { stage: input.trigger.stage } : {}),
      workflowId: input.workflowId,
      ...(input.workflowDomain ? { domain: input.workflowDomain } : {}),
    },
    trigger: input.trigger,
    runtime: {
      ownerLease: objectRecord(input.snapshot.runtime_context_json.owner_lease),
      childRuns: arrayRecords(input.snapshot.runtime_context_json.child_runs),
      recentHistory: input.recentHistory.slice(-20).map((entry) => ({
        event_type: entry.event_type,
        payload: entry.payload,
        created_at: entry.created_at,
      })),
      recoveryAttempts: recoveryAttempts(input.snapshot),
    },
    allowedActions: input.allowedActions,
  });
}

function sanitizePacket(packet: RecoveryEvidencePacket): RecoveryEvidencePacket {
  return JSON.parse(redactSecrets(JSON.stringify(packet))) as RecoveryEvidencePacket;
}

function issuePacket(snapshot: IssueSnapshot): Record<string, unknown> {
  const packet = snapshot.runtime_context_json.issue_packet;
  return typeof packet === "object" && packet !== null && !Array.isArray(packet) ? packet as Record<string, unknown> : {};
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function recoveryAttempts(snapshot: IssueSnapshot): number {
  const recovery = objectRecord(snapshot.runtime_context_json.recovery);
  const attempts = recovery?.attempt;
  return typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 0;
}
```

- [ ] **Step 4: Run evidence test**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/evidence.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recovery/evidence.ts tests/recovery/evidence.test.ts
git commit -m "feat: build recovery evidence packets"
```

---

### Task 5: Add deterministic recovery catalog and policy matcher

**Files:**
- Create: `src/recovery/catalog.ts`
- Create: `tests/recovery/catalog.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Create `tests/recovery/catalog.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDefaultRecoveryCatalog,
  matchRecoveryAction,
  policyDecisionForAction,
} from "../../src/recovery/catalog.ts";
import type { RecoveryTrigger } from "../../src/recovery/types.ts";

function trigger(overrides: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
  return {
    source: "dispatch",
    lifecycleState: "ready",
    blocker: "sync_worktree",
    errorCode: "SYNC_WORKTREE_DIRTY",
    ...overrides,
  };
}

test("catalog matches ready sync worktree dirty recovery", () => {
  const catalog = buildDefaultRecoveryCatalog();
  const action = matchRecoveryAction(catalog, trigger());
  assert.equal(action?.id, "sync_worktree.reset_dirty");
});

test("catalog matches worktree branch attach recovery", () => {
  const catalog = buildDefaultRecoveryCatalog();
  const action = matchRecoveryAction(catalog, trigger({ errorCode: "WORKTREE_CREATE_FAILED" }));
  assert.equal(action?.id, "worktree.attach_existing_branch");
});

test("catalog rejects unsupported state and unknown action", () => {
  const catalog = buildDefaultRecoveryCatalog();
  assert.equal(matchRecoveryAction(catalog, trigger({ lifecycleState: "running" })), undefined);
  const decision = policyDecisionForAction(undefined);
  assert.deepEqual(decision, { decision: "rejected", reason: "unsupported_action" });
});

test("policy accepts low risk catalog action", () => {
  const catalog = buildDefaultRecoveryCatalog();
  const action = matchRecoveryAction(catalog, trigger());
  assert.deepEqual(policyDecisionForAction(action), {
    decision: "accepted",
    reason: "auto_execute_low_risk",
    actionId: "sync_worktree.reset_dirty",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/catalog.test.ts
```

Expected: FAIL because `src/recovery/catalog.ts` does not exist.

- [ ] **Step 3: Implement catalog with dispatch recovery actions**

Create `src/recovery/catalog.ts`:

```ts
import type { RecoveryActionDefinition, RecoveryPolicyDecision, RecoveryTrigger } from "./types.ts";
import { clearRecoverableDispatchBlock, recordRecoverableDispatchRecoveryFailure } from "./results.ts";

export function buildDefaultRecoveryCatalog(): RecoveryActionDefinition[] {
  return [
    {
      id: "sync_worktree.reset_dirty",
      description: "Repair a dirty managed sync worktree before dispatch retry.",
      match: {
        lifecycleStates: ["ready"],
        blockers: ["sync_worktree"],
        errorCodes: ["SYNC_WORKTREE_DIRTY", "SYNC_WORKTREE_STATUS_FAILED", "SYNC_WORKTREE_FETCH_FAILED", "SYNC_WORKTREE_FAST_FORWARD_FAILED", "SYNC_WORKTREE_RECOVERY_FAILED", "WORKTREE_BASE_SYNC_FAILED"],
      },
      risk: "low",
      requiredInputs: [],
      async dryRun(input) {
        if (!input.domain.recoverDispatchBlock) return { ok: false, reason: "domain_missing_recoverDispatchBlock" };
        return { ok: true };
      },
      async execute(input) {
        if (!input.trigger.blocker) throw new Error("recovery trigger requires blocker");
        if (!input.domain.recoverDispatchBlock) throw new Error("domain_missing_recoverDispatchBlock");
        const stageName = input.trigger.stage ?? "implementation";
        const roleName = Object.values(input.workflow.stages).find((stage) => stage.lifecycle_state === "running")?.role
          ?? Object.values(input.workflow.stages)[0]?.role;
        if (!roleName) throw new Error("workflow has no recovery role");
        try {
          const recovered = await input.domain.recoverDispatchBlock({
            issue: {
              id: input.snapshot.issue_id,
              number: Number((input.snapshot.runtime_context_json.issue_packet as { issue_number?: unknown } | undefined)?.issue_number ?? 0),
              title: String((input.snapshot.runtime_context_json.issue_packet as { title?: unknown } | undefined)?.title ?? ""),
              body: String((input.snapshot.runtime_context_json.issue_packet as { raw_text?: unknown } | undefined)?.raw_text ?? ""),
              sourceUrl: String((input.snapshot.runtime_context_json.issue_packet as { source_url?: unknown } | undefined)?.source_url ?? ""),
            },
            workflow: { id: input.workflow.id, domain: input.workflow.domain },
            stage: { name: stageName },
            role: { name: roleName, definition: input.workflow.roles[roleName] },
            runtimeContext: input.snapshot.runtime_context_json,
            blocker: input.trigger.blocker,
            blockedErrorCode: input.trigger.errorCode,
          });
          if (!recovered?.recovered) throw new Error(recovered?.note ?? "dispatch recovery did not recover blocker");
          return clearRecoverableDispatchBlock({ snapshot: input.snapshot, blocker: input.trigger.blocker, now: input.now });
        } catch (error) {
          return recordRecoverableDispatchRecoveryFailure({ snapshot: input.snapshot, blocker: input.trigger.blocker, error, now: input.now });
        }
      },
    },
    {
      id: "worktree.attach_existing_branch",
      description: "Attach an existing issue branch to the managed worktree path without creating a duplicate branch.",
      match: {
        lifecycleStates: ["ready"],
        blockers: ["sync_worktree"],
        errorCodes: ["WORKTREE_CREATE_FAILED"],
      },
      risk: "low",
      requiredInputs: [],
      async dryRun(input) {
        if (!input.domain.recoverDispatchBlock) return { ok: false, reason: "domain_missing_recoverDispatchBlock" };
        return { ok: true };
      },
      async execute(input) {
        if (!input.trigger.blocker) throw new Error("recovery trigger requires blocker");
        if (!input.domain.recoverDispatchBlock) throw new Error("domain_missing_recoverDispatchBlock");
        const recovered = await input.domain.recoverDispatchBlock({
          issue: {
            id: input.snapshot.issue_id,
            number: Number((input.snapshot.runtime_context_json.issue_packet as { issue_number?: unknown } | undefined)?.issue_number ?? 0),
            title: String((input.snapshot.runtime_context_json.issue_packet as { title?: unknown } | undefined)?.title ?? ""),
            body: String((input.snapshot.runtime_context_json.issue_packet as { raw_text?: unknown } | undefined)?.raw_text ?? ""),
            sourceUrl: String((input.snapshot.runtime_context_json.issue_packet as { source_url?: unknown } | undefined)?.source_url ?? ""),
          },
          workflow: { id: input.workflow.id, domain: input.workflow.domain },
          stage: { name: input.trigger.stage ?? "implementation" },
          role: { name: Object.values(input.workflow.stages)[0].role, definition: input.workflow.roles[Object.values(input.workflow.stages)[0].role] },
          runtimeContext: input.snapshot.runtime_context_json,
          blocker: input.trigger.blocker,
          blockedErrorCode: input.trigger.errorCode,
        });
        if (!recovered?.recovered) throw new Error(recovered?.note ?? "dispatch recovery did not recover blocker");
        return clearRecoverableDispatchBlock({ snapshot: input.snapshot, blocker: input.trigger.blocker, now: input.now });
      },
    },
  ];
}

export function matchRecoveryAction(catalog: RecoveryActionDefinition[], trigger: RecoveryTrigger): RecoveryActionDefinition | undefined {
  return catalog.find((action) => {
    if (!action.match.lifecycleStates.includes(trigger.lifecycleState)) return false;
    if (action.match.stages && (!trigger.stage || !action.match.stages.includes(trigger.stage))) return false;
    if (action.match.blockers && (!trigger.blocker || !action.match.blockers.includes(trigger.blocker))) return false;
    if (action.match.errorCodes && (!trigger.errorCode || !action.match.errorCodes.includes(trigger.errorCode))) return false;
    return true;
  });
}

export function policyDecisionForAction(action: RecoveryActionDefinition | undefined): RecoveryPolicyDecision {
  if (!action) return { decision: "rejected", reason: "unsupported_action" };
  if (action.risk === "safe") return { decision: "accepted", reason: "auto_execute_safe", actionId: action.id };
  if (action.risk === "low") return { decision: "accepted", reason: "auto_execute_low_risk", actionId: action.id };
  return { decision: "approval_required", reason: `risk_${action.risk}_requires_operator_approval`, actionId: action.id };
}
```

Note: this step imports `src/recovery/results.ts`, which is created in Task 6. If implementing Task 5 before Task 6, create a temporary failing compile state and complete Task 6 immediately before running the catalog test. Do not commit a broken compile state.

- [ ] **Step 4: Continue directly to Task 6 before committing**

No commit yet because `src/recovery/results.ts` is needed.

---

### Task 6: Move recovery result builders out of orchestrator

**Files:**
- Create: `src/recovery/results.ts`
- Create: `tests/recovery/results.test.ts`
- Modify later: `src/orchestrator/cycle.ts`

- [ ] **Step 1: Write failing result tests**

Create `tests/recovery/results.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearRecoverableDispatchBlock,
  recoverableDispatchBlockedResult,
  recordRecoverableDispatchRecoveryFailure,
} from "../../src/recovery/results.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("recoverableDispatchBlockedResult records ready non-terminal blocker", () => {
  const snapshot = newIssueSnapshot("github:1", { lifecycle_state: "ready" });
  const result = recoverableDispatchBlockedResult({
    snapshot,
    error: Object.assign(new Error("dirty"), { code: "SYNC_WORKTREE_DIRTY" }),
    now: "2026-06-03T00:00:00.000Z",
  });
  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.deepEqual(result.snapshot.runtime_context_json.blocked_by, ["sync_worktree"]);
  assert.equal(result.snapshot.runtime_context_json.blocked_error_code, "SYNC_WORKTREE_DIRTY");
  assert.equal(result.history[0].event_type, "dispatch_blocked_recoverable");
});

test("clearRecoverableDispatchBlock clears recovery-only fields", () => {
  const snapshot = newIssueSnapshot("github:2", {
    lifecycle_state: "ready",
    runtime_context_json: {
      blocked_by: ["sync_worktree"],
      recoverable: true,
      blocked_error_code: "SYNC_WORKTREE_DIRTY",
      last_error: "dirty",
    },
  });
  const result = clearRecoverableDispatchBlock({ snapshot, blocker: "sync_worktree", now: "2026-06-03T00:00:00.000Z" });
  assert.equal(result.snapshot.runtime_context_json.blocked_by, undefined);
  assert.equal(result.snapshot.runtime_context_json.recoverable, undefined);
  assert.equal(result.history[0].event_type, "dispatch_recovery_succeeded");
});

test("recordRecoverableDispatchRecoveryFailure preserves blocker", () => {
  const snapshot = newIssueSnapshot("github:3", { lifecycle_state: "ready" });
  const result = recordRecoverableDispatchRecoveryFailure({ snapshot, blocker: "sync_worktree", error: new Error("still dirty"), now: "2026-06-03T00:00:00.000Z" });
  assert.deepEqual(result.snapshot.runtime_context_json.blocked_by, ["sync_worktree"]);
  assert.equal(result.snapshot.runtime_context_json.recoverable, true);
  assert.equal(result.history[0].event_type, "dispatch_recovery_failed_retryable");
});
```

- [ ] **Step 2: Run result test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/results.test.ts
```

Expected: FAIL because `src/recovery/results.ts` does not exist.

- [ ] **Step 3: Implement result builders**

Create `src/recovery/results.ts`:

```ts
import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";
import { addBlockedBy, removeBlockedBy } from "./blockers.ts";
import { errorCode, errorMessage } from "./errors.ts";

export function recoverableDispatchBlockedResult(input: {
  snapshot: IssueSnapshot;
  error: unknown;
  now: string;
}): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  const code = errorCode(input.error) ?? "DISPATCH_BLOCKED_RECOVERABLE";
  const message = errorMessage(input.error);
  const snapshot = structuredClone(input.snapshot) as IssueSnapshot;
  snapshot.lifecycle_state = "ready";
  delete snapshot.current_session_id;
  delete snapshot.runtime_context_json.owner_lease;
  delete snapshot.runtime_context_json.stage_cursor;
  snapshot.runtime_context_json = {
    ...snapshot.runtime_context_json,
    last_error: message,
    blocked_by: addBlockedBy(snapshot.runtime_context_json.blocked_by, "sync_worktree"),
    recoverable: true,
    blocked_error_code: code,
  };
  return {
    snapshot,
    history: [{
      event_type: "dispatch_blocked_recoverable",
      payload: { code, message, blocked_by: "sync_worktree", at: input.now },
    }],
  };
}

export function clearRecoverableDispatchBlock(input: {
  snapshot: IssueSnapshot;
  blocker: string;
  now: string;
}): { snapshot: IssueSnapshot; history: HistoryEntry[]; message: string; clearedBlocker: string } {
  const snapshot = structuredClone(input.snapshot) as IssueSnapshot;
  const remainingBlockedBy = removeBlockedBy(snapshot.runtime_context_json.blocked_by, input.blocker);
  if (remainingBlockedBy.length > 0) {
    snapshot.runtime_context_json.blocked_by = remainingBlockedBy;
  } else {
    delete snapshot.runtime_context_json.blocked_by;
    delete snapshot.runtime_context_json.recoverable;
    delete snapshot.runtime_context_json.blocked_error_code;
    delete snapshot.runtime_context_json.last_error;
  }
  return {
    snapshot,
    history: [{ event_type: "dispatch_recovery_succeeded", payload: { blocked_by: input.blocker, at: input.now } }],
    message: "Recoverable dispatch blocker cleared",
    clearedBlocker: input.blocker,
  };
}

export function recordRecoverableDispatchRecoveryFailure(input: {
  snapshot: IssueSnapshot;
  blocker: string;
  error: unknown;
  now: string;
}): { snapshot: IssueSnapshot; history: HistoryEntry[]; message: string } {
  const snapshot = structuredClone(input.snapshot) as IssueSnapshot;
  const message = errorMessage(input.error);
  snapshot.runtime_context_json = {
    ...snapshot.runtime_context_json,
    last_error: message,
    blocked_by: addBlockedBy(snapshot.runtime_context_json.blocked_by, input.blocker),
    recoverable: true,
    blocked_error_code: errorCode(input.error) ?? snapshot.runtime_context_json.blocked_error_code,
  };
  return {
    snapshot,
    history: [{
      event_type: "dispatch_recovery_failed_retryable",
      payload: {
        blocked_by: input.blocker,
        error: message,
        code: errorCode(input.error) ?? "DISPATCH_RECOVERY_FAILED",
        at: input.now,
      },
    }],
    message: `Dispatch recovery blocked: ${message}`,
  };
}
```

- [ ] **Step 4: Run result and catalog tests**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/results.test.ts
npx tsx tests/recovery/catalog.test.ts
```

Expected: both PASS.

- [ ] **Step 5: Commit catalog and result modules together**

```bash
git add src/recovery/catalog.ts src/recovery/results.ts tests/recovery/catalog.test.ts tests/recovery/results.test.ts
git commit -m "feat: add deterministic recovery catalog"
```

---

### Task 7: Add recovery controller and centralize dispatch-block recovery orchestration

**Files:**
- Create: `src/recovery/controller.ts`
- Create: `tests/recovery/controller.test.ts`
- Modify: `src/orchestrator/cycle.ts` in later task

- [ ] **Step 1: Write failing controller tests**

Create `tests/recovery/controller.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryController } from "../../src/recovery/controller.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../../src/types/workflow.ts";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";

class RecoveringDomainDriver extends FakeDomainDriver {
  async recoverDispatchBlock() {
    return { recovered: true };
  }
}

class NoRecoveryDomainDriver extends FakeDomainDriver {}

test("RecoveryController clears ready dispatch blocker without dispatching", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-recovery-controller-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const snapshot = newIssueSnapshot("github:1", {
      lifecycle_state: "ready",
      runtime_context_json: {
        issue_packet: { issue_number: "1", title: "Blocked" },
        blocked_by: ["sync_worktree"],
        blocked_error_code: "SYNC_WORKTREE_DIRTY",
        recoverable: true,
      },
    });
    store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [], snapshot);
    const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");
    const controller = new RecoveryController();

    const result = await controller.reconcile({
      snapshot,
      store,
      domain: new RecoveringDomainDriver(),
      workflow,
      now: "2026-06-03T00:00:00.000Z",
    });

    assert.equal(result.handled, true);
    assert.equal(result.nextAction, "dispatch_recovery_succeeded");
    assert.equal(store.getIssue("github:1").runtime_context_json.blocked_by, undefined);
    assert.equal(store.listHistory("github:1").some((entry) => entry.event_type === "dispatch_recovery_succeeded"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RecoveryController records policy rejection for unsupported recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-recovery-controller-reject-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const snapshot = newIssueSnapshot("github:2", {
      lifecycle_state: "running",
      runtime_context_json: {
        issue_packet: { issue_number: "2", title: "Unsupported" },
        blocked_by: ["sync_worktree"],
        blocked_error_code: "SYNC_WORKTREE_DIRTY",
        recoverable: true,
      },
    });
    store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [], snapshot);
    const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");
    const controller = new RecoveryController();

    const result = await controller.reconcile({
      snapshot,
      store,
      domain: new NoRecoveryDomainDriver(),
      workflow,
      now: "2026-06-03T00:00:00.000Z",
    });

    assert.equal(result.handled, true);
    assert.equal(result.nextAction, "recovery_policy_rejected");
    assert.equal(store.getIssue("github:2").runtime_context_json.blocked_by?.[0], "sync_worktree");
    assert.equal(store.listHistory("github:2").some((entry) => entry.event_type === "recovery_policy_rejected"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/controller.test.ts
```

Expected: FAIL because `src/recovery/controller.ts` does not exist.

- [ ] **Step 3: Implement recovery controller**

Create `src/recovery/controller.ts`:

```ts
import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";
import type { RecoveryControllerInput, RecoveryControllerResult } from "./types.ts";
import { recoverableBlockedByForSnapshot, triggerFromSnapshot } from "./blockers.ts";
import { buildRecoveryEvidencePacket } from "./evidence.ts";
import { buildDefaultRecoveryCatalog, matchRecoveryAction, policyDecisionForAction } from "./catalog.ts";

export class RecoveryController {
  async reconcile(input: RecoveryControllerInput): Promise<RecoveryControllerResult> {
    const blockers = recoverableBlockedByForSnapshot(input.snapshot);
    if (blockers.length === 0) {
      return { handled: false, snapshot: input.snapshot, nextAction: "none", message: "No recoverable blocker" };
    }

    const trigger = triggerFromSnapshot(input.snapshot, "reconcile");
    const catalog = buildDefaultRecoveryCatalog();
    const action = matchRecoveryAction(catalog, trigger);
    const evidence = buildRecoveryEvidencePacket({
      snapshot: input.snapshot,
      workflowId: input.workflow.id,
      workflowDomain: input.workflow.domain,
      trigger,
      recentHistory: input.store.listRecentHistory(input.snapshot.issue_id, 20),
      allowedActions: catalog.map((item) => ({
        id: item.id,
        risk: item.risk,
        summary: item.description,
        requiredInputs: item.requiredInputs,
      })),
    });
    const policy = policyDecisionForAction(action);

    if (!action || policy.decision !== "accepted") {
      const rejected = recordRecoveryPolicyRejected(input.snapshot, {
        reason: policy.reason,
        actionId: policy.actionId,
        at: input.now,
      });
      input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, rejected.history, rejected.snapshot);
      return {
        handled: true,
        snapshot: rejected.snapshot,
        nextAction: "recovery_policy_rejected",
        message: policy.reason,
      };
    }

    const dryRun = await action.dryRun({ ...input, trigger, evidence });
    if (!dryRun.ok) {
      const rejected = recordRecoveryPolicyRejected(input.snapshot, {
        reason: dryRun.reason ?? "dry_run_failed",
        actionId: action.id,
        at: input.now,
      });
      input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, rejected.history, rejected.snapshot);
      return {
        handled: true,
        snapshot: rejected.snapshot,
        nextAction: "recovery_policy_rejected",
        message: dryRun.reason ?? "dry_run_failed",
      };
    }

    const executed = await action.execute({ ...input, trigger, evidence });
    input.store.appendHistoryBatchAndUpdateSnapshot(input.snapshot.issue_id, executed.history, executed.snapshot);
    return {
      handled: true,
      snapshot: executed.snapshot,
      nextAction: executed.history.some((entry) => entry.event_type === "dispatch_recovery_failed_retryable")
        ? "dispatch_recovery_failed_retryable"
        : "dispatch_recovery_succeeded",
      message: executed.message,
    };
  }
}

function recordRecoveryPolicyRejected(snapshot: IssueSnapshot, input: {
  reason: string;
  actionId?: string;
  at: string;
}): { snapshot: IssueSnapshot; history: HistoryEntry[] } {
  const next = structuredClone(snapshot) as IssueSnapshot;
  next.runtime_context_json = {
    ...next.runtime_context_json,
    recovery: {
      status: "policy_rejected",
      last_policy_decision: input.reason,
      ...(input.actionId ? { proposed_action: input.actionId } : {}),
      at: input.at,
    },
  };
  return {
    snapshot: next,
    history: [{
      event_type: "recovery_policy_rejected",
      payload: {
        reason: input.reason,
        ...(input.actionId ? { action_id: input.actionId } : {}),
        at: input.at,
      },
    }],
  };
}
```

- [ ] **Step 4: Run controller test**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/controller.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recovery/controller.ts tests/recovery/controller.test.ts
git commit -m "feat: add recovery controller"
```

---

### Task 8: Refactor orchestrator cycle to delegate recovery and remove local exception/recovery helpers

**Files:**
- Modify: `src/orchestrator/cycle.ts`
- Modify: `tests/orchestrator/watch-orchestrator.test.ts`

- [ ] **Step 1: Write/confirm failing orchestrator regression tests**

Before modifying `cycle.ts`, run the existing focused tests that should stay green after refactor:

```bash
cd ../northstar
npx tsx tests/orchestrator/watch-orchestrator.test.ts
```

Expected before changes: PASS. After deleting local helpers but before wiring controller, expected: compile failures referencing removed functions. This is the RED signal for the refactor.

- [ ] **Step 2: Import recovery controller and centralized helpers**

In `src/orchestrator/cycle.ts`, add imports near the top:

```ts
import { RecoveryController } from "../recovery/controller.ts";
import { recoverableDispatchBlockedResult } from "../recovery/results.ts";
import { recoverableBlockedByForSnapshot } from "../recovery/blockers.ts";
import { errorCode, errorMessage, isRecoverableDispatchBlocker, isVerifierArtifactRejection } from "../recovery/errors.ts";
```

Remove local definitions of:

```ts
recoverableDispatchBlockedResult
clearRecoverableDispatchBlock
recordRecoverableDispatchRecoveryFailure
isVerifierArtifactRejection
isRecoverableDispatchBlocker
errorCode
errorMessage
recoverableBlockedByForSnapshot
addBlockedBy
removeBlockedBy
```

Keep dependency-specific helpers local if they only handle dependency blockers:

```ts
dependencyBlockedByForSnapshot
blockedByListForSnapshot
mergeDependencyBlockedBy
```

If `blockedByListForSnapshot` only duplicates shared helper behavior, replace it with an import from `src/recovery/blockers.ts`.

- [ ] **Step 3: Instantiate recovery controller once in createProductionOrchestrator**

Inside `createProductionOrchestrator`, immediately after workflow/manual setup:

```ts
const workflow = loadWorkflow(options.workflowPath);
const manual = emptyManualCliMetrics();
const recoveryController = new RecoveryController();
```

- [ ] **Step 4: Replace ready dispatch recovery in `reconcileIssue`**

Replace the existing `recoverReadyRecoverableDispatchBlockIfAvailable(...)` call with:

```ts
const readyRecovery = await recoveryController.reconcile({
  snapshot,
  store: options.store,
  domain: options.domain,
  workflow,
  now: options.now(),
  observability: options.observability,
  metrics: manual,
  projectId: options.projectId,
  progress: options.progress,
});
if (readyRecovery.handled && snapshot.lifecycle_state === "ready") {
  await syncIssueProgress(options.observability, readyRecovery.snapshot, options.now(), readyRecovery.message);
  await syncProjectProjection(options.observability, manual, options.store, readyRecovery.snapshot, workflow, options.projectId, {
    persistSyncedMarker: true,
    persistRetryMarker: true,
    now: options.now(),
    progress: options.progress,
  });
  return { next_action: readyRecovery.nextAction, issue: readyRecovery.snapshot };
}
```

Then delete local `recoverReadyRecoverableDispatchBlockIfAvailable`.

- [ ] **Step 5: Replace runCycle batch recovery**

Replace existing `reconcileReadyRecoverableDispatchBlocks(...)` implementation with a thin loop that calls the controller:

```ts
async function reconcileReadyRecoverableDispatchBlocks(input: {
  snapshots: IssueSnapshot[];
  store: SqliteControlPlaneStore;
  domain: DomainDriver;
  workflow: WorkflowDefinition;
  now: string;
  observability?: ProductionObservability;
  metrics: ReturnType<typeof emptyManualCliMetrics>;
  projectId?: string;
  progress?: ProductionProgressReporter;
  recoveryController: RecoveryController;
}): Promise<{ reconciled: boolean }> {
  let reconciled = false;
  for (const snapshot of input.snapshots) {
    if (snapshot.lifecycle_state !== "ready") continue;
    const result = await input.recoveryController.reconcile({
      snapshot,
      store: input.store,
      domain: input.domain,
      workflow: input.workflow,
      now: input.now,
      observability: input.observability,
      metrics: input.metrics,
      projectId: input.projectId,
      progress: input.progress,
    });
    if (!result.handled) continue;
    reconciled = true;
    await syncIssueProgress(input.observability, result.snapshot, input.now, result.message);
    await syncProjectProjection(input.observability, input.metrics, input.store, result.snapshot, input.workflow, input.projectId, {
      persistSyncedMarker: true,
      persistRetryMarker: true,
      now: input.now,
      progress: input.progress,
    });
  }
  return { reconciled };
}
```

Update the call site to pass `recoveryController`.

- [ ] **Step 6: Verify no removed local helpers remain**

Run:

```bash
cd ../northstar
rg -n "function recoverableDispatchBlockedResult|function clearRecoverableDispatchBlock|function recordRecoverableDispatchRecoveryFailure|function isRecoverableDispatchBlocker|function isVerifierArtifactRejection|function errorCode|function errorMessage" src/orchestrator/cycle.ts
```

Expected: no output.

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/errors.test.ts
npx tsx tests/recovery/blockers.test.ts
npx tsx tests/recovery/evidence.test.ts
npx tsx tests/recovery/results.test.ts
npx tsx tests/recovery/catalog.test.ts
npx tsx tests/recovery/controller.test.ts
npx tsx tests/orchestrator/watch-orchestrator.test.ts
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/cycle.ts tests/orchestrator/watch-orchestrator.test.ts
git commit -m "refactor: delegate orchestrator recovery handling"
```

---

### Task 9: Centralize verifier/artifact exception result construction

**Files:**
- Modify: `src/recovery/results.ts`
- Modify: `src/orchestrator/cycle.ts`
- Create: `tests/recovery/artifact-results.test.ts`

- [ ] **Step 1: Write failing test for verifier artifact rejection result**

Create `tests/recovery/artifact-results.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifierArtifactRejectedResult } from "../../src/recovery/results.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

test("verifierArtifactRejectedResult releases active ownership and records retryable artifact block", () => {
  const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");
  const snapshot = newIssueSnapshot("github:1", {
    lifecycle_state: "verifying",
    runtime_context_json: {
      stage_cursor: "verification",
      owner_lease: {
        lease_id: "lease-1",
        root_session_id: "root-1",
        role: "pr_verifier",
        generation: 1,
        heartbeat_seq: 0,
        last_heartbeat_at: "2026-06-03T00:00:00.000Z",
        expires_at: "2026-06-03T00:10:00.000Z",
      },
    },
  });

  const result = verifierArtifactRejectedResult({
    snapshot,
    workflow,
    error: new Error("artifact missing browser evidence"),
    now: "2026-06-03T00:01:00.000Z",
  });

  assert.equal(result.snapshot.lifecycle_state, "ready");
  assert.equal(result.snapshot.runtime_context_json.owner_lease, undefined);
  assert.equal(result.snapshot.runtime_context_json.recoverable, true);
  assert.equal(result.history.some((entry) => entry.event_type === "verifier_artifact_rejected"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/artifact-results.test.ts
```

Expected: FAIL because `verifierArtifactRejectedResult` is not exported from `src/recovery/results.ts`.

- [ ] **Step 3: Move verifier artifact result builder into recovery results**

Add to `src/recovery/results.ts`:

```ts
import type { WorkflowDefinition } from "../types/workflow.ts";
import { releaseActiveRuntimeOwnership } from "../runtime/repair.ts";

export function verifierArtifactRejectedResult(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  error: unknown;
  now: string;
}): { snapshot: IssueSnapshot; history: HistoryEntry[]; message: string } {
  const message = errorMessage(input.error);
  const result = releaseActiveRuntimeOwnership(input.snapshot, input.workflow, {
    now: input.now,
    reasonCode: "artifact_rejected_retryable",
    details: { error: message },
  });
  result.snapshot.runtime_context_json = {
    ...result.snapshot.runtime_context_json,
    last_error: message,
    recoverable: true,
  };
  const blockedBy = removeBlockedBy(result.snapshot.runtime_context_json.blocked_by, "verifier_artifact");
  if (blockedBy.length > 0) {
    result.snapshot.runtime_context_json.blocked_by = blockedBy;
  } else {
    delete result.snapshot.runtime_context_json.blocked_by;
  }
  result.history.push({
    event_type: "verifier_artifact_rejected",
    payload: { reason: message, retryable: true, at: input.now },
  });
  return { snapshot: result.snapshot, history: result.history, message };
}
```

Remove local `verifierArtifactRejectedResult` from `src/orchestrator/cycle.ts` and import it from `src/recovery/results.ts`.

- [ ] **Step 4: Run tests**

Run:

```bash
cd ../northstar
npx tsx tests/recovery/artifact-results.test.ts
npx tsx tests/orchestrator/watch-orchestrator.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recovery/results.ts src/orchestrator/cycle.ts tests/recovery/artifact-results.test.ts
git commit -m "refactor: centralize artifact recovery results"
```

---

### Task 10: Add recovery tests to the full suite

**Files:**
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Add imports to test index**

Add these imports near other runtime/orchestrator tests in `tests/index.test.ts`:

```ts
import "./recovery/errors.test.ts";
import "./recovery/blockers.test.ts";
import "./recovery/evidence.test.ts";
import "./recovery/results.test.ts";
import "./recovery/artifact-results.test.ts";
import "./recovery/catalog.test.ts";
import "./recovery/controller.test.ts";
```

- [ ] **Step 2: Run full tests**

Run:

```bash
cd ../northstar
npm test
```

Expected: all tests pass with the new recovery tests included.

- [ ] **Step 3: Commit**

```bash
git add tests/index.test.ts
git commit -m "test: include recovery subsystem tests"
```

---

### Task 11: Add migration guard tests for orchestrator exception concentration

**Files:**
- Create: `tests/orchestrator/recovery-architecture.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write architecture guard test**

Create `tests/orchestrator/recovery-architecture.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("orchestrator cycle delegates recovery helper implementations to src/recovery", async () => {
  const source = await readFile("src/orchestrator/cycle.ts", "utf8");
  for (const forbidden of [
    "function recoverableDispatchBlockedResult",
    "function clearRecoverableDispatchBlock",
    "function recordRecoverableDispatchRecoveryFailure",
    "function verifierArtifactRejectedResult",
    "function isRecoverableDispatchBlocker",
    "function isVerifierArtifactRejection",
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must live outside orchestrator/cycle.ts`);
  }
  assert.equal(source.includes("new RecoveryController()"), true);
});
```

- [ ] **Step 2: Add import to `tests/index.test.ts`**

Add:

```ts
import "./orchestrator/recovery-architecture.test.ts";
```

- [ ] **Step 3: Run architecture and full tests**

Run:

```bash
cd ../northstar
npx tsx tests/orchestrator/recovery-architecture.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/orchestrator/recovery-architecture.test.ts tests/index.test.ts
git commit -m "test: guard centralized recovery architecture"
```

---

### Task 12: Update implementation documentation and final verification

**Files:**
- Modify: `docs/superpowers/production-orchestrator-coverage.md` or create `docs/superpowers/controlled-recovery-coverage.md`

- [ ] **Step 1: Add coverage note**

Create `docs/superpowers/controlled-recovery-coverage.md`:

```md
# Controlled Recovery Coverage

Implemented first-slice controlled recovery architecture:

- Central recovery error classification in `src/recovery/errors.ts`.
- Central recovery blocker helpers in `src/recovery/blockers.ts`.
- Bounded recovery evidence packets in `src/recovery/evidence.ts`.
- Deterministic recovery catalog in `src/recovery/catalog.ts`.
- Policy-gated controller in `src/recovery/controller.ts`.
- Recovery result builders in `src/recovery/results.ts`.
- Orchestrator delegates ready dispatch blocker recovery to `RecoveryController`.
- Existing verifier artifact rejection recovery result construction is centralized.

Verified invariants:

- Recovery clears blockers but does not dispatch directly.
- Unsupported recovery actions remain blocked and emit `recovery_policy_rejected`.
- Orchestrator no longer owns recovery helper implementations.
- Existing production watch recovery behavior remains covered.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
cd ../northstar
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
cd ../northstar
git diff --stat HEAD
```

Expected: only planned recovery files and docs changed.

- [ ] **Step 4: Commit docs**

```bash
git add docs/superpowers/controlled-recovery-coverage.md
git commit -m "docs: document controlled recovery coverage"
```

---

## Final Verification

After all tasks are implemented, run:

```bash
cd ../northstar
npm test
git status --short
```

Expected:

- `npm test` reports all tests passing.
- `git status --short` is empty.

## Expected Result

After this plan is complete:

- Existing ad-hoc recovery code for ready dispatch blockers is extracted from `src/orchestrator/cycle.ts` into `src/recovery/*`.
- Existing verifier artifact recovery result construction is centralized in `src/recovery/results.ts`.
- Exception classification is centralized in `src/recovery/errors.ts`.
- Reconcile/runCycle still decide next workflow actions; recovery only records facts, clears blockers, or records policy rejection.
- The new architecture is protected by tests that prevent recovery helper logic from drifting back into the orchestrator.

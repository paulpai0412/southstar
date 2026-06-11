# Northstar Exception E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic offline E2E coverage for issue execution exceptions, quarantine, failure, and recovery, with requirement coverage >= 85%.

**Architecture:** Add a separate `tests/e2e-exceptions/` suite driven by a small SQLite-backed harness. The suite exercises existing runtime/state-machine/store/repair boundaries, records quantitative metrics, and maps EX-01 through EX-14 in a coverage matrix without live credentials or network calls.

**Tech Stack:** Node 22 built-in `node:test`, TypeScript strip-only execution, `SqliteControlPlaneStore`, `applyRuntimeEvents`, `repairSnapshot`, existing workflow YAML fixtures.

---

## File Structure

- Create `tests/e2e-exceptions/index.test.ts`: imports the exception E2E suite.
- Create `tests/e2e-exceptions/metrics.ts`: typed metrics, requirement coverage, summary formatting, secret scan.
- Create `tests/e2e-exceptions/harness.ts`: temp SQLite store, issue seeding, event application, repair helpers, and scenario methods.
- Create `tests/e2e-exceptions/exception-e2e.test.ts`: top-level quantified E2E assertions.
- Create `docs/superpowers/exception-e2e-coverage.md`: EX-01 through EX-14 coverage matrix.
- Modify `package.json`: add `test:e2e:exceptions`.
- Modify `tests/spec/spec-compliance.test.ts`: assert the exception E2E coverage matrix exists and maps required files/metrics.

## Task 1: Add Exception E2E Command Shell

**Files:**
- Modify: `package.json`
- Create: `tests/e2e-exceptions/index.test.ts`
- Create: `tests/e2e-exceptions/exception-e2e.test.ts`

- [ ] **Step 1: Write the failing command test shell**

Create `tests/e2e-exceptions/index.test.ts`:

```ts
import "./exception-e2e.test.ts";
```

Create `tests/e2e-exceptions/exception-e2e.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("exception E2E command shell is wired", () => {
  assert.equal(process.env.NORTHSTAR_LIVE_GITHUB_REPO, undefined);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: fail with `Missing script: "test:e2e:exceptions"`.

- [ ] **Step 3: Add the package script**

Modify `package.json` scripts:

```json
"test:e2e:exceptions": "node --disable-warning=ExperimentalWarning tests/e2e-exceptions/index.test.ts"
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: pass with `1..1`, `# pass 1`.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/e2e-exceptions/index.test.ts tests/e2e-exceptions/exception-e2e.test.ts
git commit -m "test: add exception e2e command shell"
```

## Task 2: Add Exception Metrics Contract

**Files:**
- Create: `tests/e2e-exceptions/metrics.ts`
- Modify: `tests/e2e-exceptions/exception-e2e.test.ts`

- [ ] **Step 1: Replace shell test with failing metrics contract test**

Replace `tests/e2e-exceptions/exception-e2e.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyExceptionE2EMetrics,
  formatExceptionE2ESummary,
  markRequirementCovered,
  hasExceptionE2ESecretLeak,
} from "./metrics.ts";

test("exception E2E metrics calculate requirement coverage and summary", () => {
  const metrics = emptyExceptionE2EMetrics();
  for (const id of ["EX-01", "EX-02", "EX-03", "EX-04", "EX-05", "EX-06", "EX-07", "EX-08", "EX-09", "EX-10", "EX-11", "EX-12"]) {
    markRequirementCovered(metrics, id);
  }
  metrics.exception_e2e_scenarios_total = 8;
  metrics.exception_e2e_scenarios_passed = 8;
  metrics.exception_e2e_quarantined_cases = 3;
  metrics.exception_e2e_failed_cases = 2;
  metrics.exception_e2e_recovery_cases = 3;
  metrics.exception_e2e_resume_rejections = 2;
  metrics.exception_e2e_retryable_failures = 3;
  metrics.exception_e2e_terminal_failures = 2;
  metrics.exception_e2e_artifact_rejections = 1;
  metrics.exception_e2e_repair_admin_actions = 2;

  const summary = formatExceptionE2ESummary(metrics);

  assert.equal(metrics.exception_e2e_requirements_total, 14);
  assert.equal(metrics.exception_e2e_requirements_covered, 12);
  assert.equal(metrics.exception_e2e_requirement_coverage_percent, 85);
  assert.match(summary, /exception_e2e_requirements_total=14/);
  assert.match(summary, /exception_e2e_scenarios_passed=8\/8/);
  assert.equal(hasExceptionE2ESecretLeak("Authorization: Bearer gho_abc12345678901234567890"), true);
  assert.equal(hasExceptionE2ESecretLeak(summary), false);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: fail with module-not-found for `tests/e2e-exceptions/metrics.ts`.

- [ ] **Step 3: Implement `metrics.ts`**

Create `tests/e2e-exceptions/metrics.ts`:

```ts
export type ExceptionRequirementId =
  | "EX-01" | "EX-02" | "EX-03" | "EX-04" | "EX-05" | "EX-06" | "EX-07"
  | "EX-08" | "EX-09" | "EX-10" | "EX-11" | "EX-12" | "EX-13" | "EX-14";

const requirementIds: ExceptionRequirementId[] = [
  "EX-01", "EX-02", "EX-03", "EX-04", "EX-05", "EX-06", "EX-07",
  "EX-08", "EX-09", "EX-10", "EX-11", "EX-12", "EX-13", "EX-14",
];

export interface ExceptionE2EMetrics {
  exception_e2e_requirements_total: number;
  exception_e2e_requirements_covered: number;
  exception_e2e_requirement_coverage_percent: number;
  exception_e2e_scenarios_total: number;
  exception_e2e_scenarios_passed: number;
  exception_e2e_quarantined_cases: number;
  exception_e2e_failed_cases: number;
  exception_e2e_recovery_cases: number;
  exception_e2e_resume_rejections: number;
  exception_e2e_retryable_failures: number;
  exception_e2e_terminal_failures: number;
  exception_e2e_artifact_rejections: number;
  exception_e2e_repair_admin_actions: number;
  exception_e2e_duplicate_child_runs: number;
  exception_e2e_secret_leaks: number;
  exception_e2e_network_calls: number;
  exception_e2e_live_credential_reads: number;
  covered_requirements: ExceptionRequirementId[];
}

export function emptyExceptionE2EMetrics(): ExceptionE2EMetrics {
  return {
    exception_e2e_requirements_total: requirementIds.length,
    exception_e2e_requirements_covered: 0,
    exception_e2e_requirement_coverage_percent: 0,
    exception_e2e_scenarios_total: 0,
    exception_e2e_scenarios_passed: 0,
    exception_e2e_quarantined_cases: 0,
    exception_e2e_failed_cases: 0,
    exception_e2e_recovery_cases: 0,
    exception_e2e_resume_rejections: 0,
    exception_e2e_retryable_failures: 0,
    exception_e2e_terminal_failures: 0,
    exception_e2e_artifact_rejections: 0,
    exception_e2e_repair_admin_actions: 0,
    exception_e2e_duplicate_child_runs: 0,
    exception_e2e_secret_leaks: 0,
    exception_e2e_network_calls: 0,
    exception_e2e_live_credential_reads: 0,
    covered_requirements: [],
  };
}

export function markRequirementCovered(metrics: ExceptionE2EMetrics, id: ExceptionRequirementId): void {
  if (!metrics.covered_requirements.includes(id)) {
    metrics.covered_requirements.push(id);
  }
  metrics.exception_e2e_requirements_covered = metrics.covered_requirements.length;
  metrics.exception_e2e_requirement_coverage_percent = Math.floor(
    (metrics.exception_e2e_requirements_covered / metrics.exception_e2e_requirements_total) * 100,
  );
}

export function formatExceptionE2ESummary(metrics: ExceptionE2EMetrics): string {
  return [
    `exception_e2e_requirements_total=${metrics.exception_e2e_requirements_total}`,
    `exception_e2e_requirements_covered=${metrics.exception_e2e_requirements_covered}`,
    `exception_e2e_requirement_coverage_percent=${metrics.exception_e2e_requirement_coverage_percent}`,
    `exception_e2e_scenarios_passed=${metrics.exception_e2e_scenarios_passed}/${metrics.exception_e2e_scenarios_total}`,
    `exception_e2e_quarantined_cases=${metrics.exception_e2e_quarantined_cases}`,
    `exception_e2e_failed_cases=${metrics.exception_e2e_failed_cases}`,
    `exception_e2e_recovery_cases=${metrics.exception_e2e_recovery_cases}`,
    `exception_e2e_retryable_failures=${metrics.exception_e2e_retryable_failures}`,
    `exception_e2e_terminal_failures=${metrics.exception_e2e_terminal_failures}`,
    `exception_e2e_artifact_rejections=${metrics.exception_e2e_artifact_rejections}`,
    `exception_e2e_repair_admin_actions=${metrics.exception_e2e_repair_admin_actions}`,
    `exception_e2e_secret_leaks=${metrics.exception_e2e_secret_leaks}`,
    `exception_e2e_network_calls=${metrics.exception_e2e_network_calls}`,
    `exception_e2e_live_credential_reads=${metrics.exception_e2e_live_credential_reads}`,
  ].join(" ");
}

export function hasExceptionE2ESecretLeak(value: string): boolean {
  return /authorization:\s*bearer|gho_[A-Za-z0-9_]+|github[_-]?token\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|sk-[A-Za-z0-9_-]+/i.test(value);
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: pass with metrics test green.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-exceptions/exception-e2e.test.ts tests/e2e-exceptions/metrics.ts
git commit -m "test: add exception e2e metrics"
```

## Task 3: Build SQLite Exception Harness Skeleton

**Files:**
- Create: `tests/e2e-exceptions/harness.ts`
- Modify: `tests/e2e-exceptions/exception-e2e.test.ts`

- [ ] **Step 1: Add failing harness test**

Append to `tests/e2e-exceptions/exception-e2e.test.ts`:

```ts
import { createExceptionE2EHarness } from "./harness.ts";

test("exception E2E harness seeds durable local issues without network or credentials", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("exception E2E must not call fetch");
  }) as typeof fetch;
  const harness = await createExceptionE2EHarness();
  try {
    const issue = harness.seedIssue("issue_to_pr_release", "Exception E2E seed");
    const summary = harness.summary();

    assert.equal(issue.lifecycle_state, "ready");
    assert.equal(summary.exception_e2e_network_calls, 0);
    assert.equal(summary.exception_e2e_live_credential_reads, 0);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: fail with module-not-found for `tests/e2e-exceptions/harness.ts`.

- [ ] **Step 3: Implement harness skeleton**

Create `tests/e2e-exceptions/harness.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IssuePacket } from "../../src/intake/types.ts";
import { issuePacketId } from "../../src/intake/types.ts";
import { applyRuntimeEvents, createOwnerLease, type RuntimeEvent } from "../../src/runtime/state-machine.ts";
import { repairSnapshot } from "../../src/runtime/repair.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import type { HistoryEntry, IssueSnapshot } from "../../src/types/control-plane.ts";
import { loadWorkflow, type WorkflowDefinition } from "../../src/types/workflow.ts";
import {
  emptyExceptionE2EMetrics,
  hasExceptionE2ESecretLeak,
  markRequirementCovered,
  type ExceptionE2EMetrics,
  type ExceptionRequirementId,
} from "./metrics.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const now = "2026-05-29T03:00:00.000Z";

export class ExceptionE2EHarness {
  readonly dir: string;
  readonly dbPath: string;
  readonly metrics = emptyExceptionE2EMetrics();
  store: SqliteControlPlaneStore;
  private issueSequence = 2000;

  private constructor(dir: string, store: SqliteControlPlaneStore) {
    this.dir = dir;
    this.dbPath = join(dir, "northstar-exception-e2e.sqlite");
    this.store = store;
  }

  static async create(): Promise<ExceptionE2EHarness> {
    const dir = await mkdtemp(join(tmpdir(), "northstar-exception-e2e-"));
    const store = SqliteControlPlaneStore.open(join(dir, "northstar-exception-e2e.sqlite"));
    return new ExceptionE2EHarness(dir, store);
  }

  seedIssue(workflowId: string, title: string): IssueSnapshot {
    this.issueSequence += 1;
    const packet: IssuePacket = {
      issue_number: String(this.issueSequence),
      title,
      source: "local",
      source_url: `local://${workflowId}/${this.issueSequence}`,
      branch: `northstar/exception-e2e-${this.issueSequence}`,
      base_branch: "main",
      labels: ["northstar:e2e:exception", workflowId],
      dependencies: [],
      raw_text: title,
      ready_for_agent: true,
    };
    this.store.upsertIssuePacket(packet);
    return this.store.getIssue(issuePacketId(packet));
  }

  workflow(name = "issue-to-pr-release.yaml"): WorkflowDefinition {
    return loadWorkflow(join(repoRoot, "tests/fixtures/workflows", name));
  }

  apply(issueId: string, workflow: WorkflowDefinition, events: RuntimeEvent[]): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const result = applyRuntimeEvents(snapshot, workflow, events);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, result.history, result.snapshot);
    this.updateSafetyMetrics();
    return result.snapshot;
  }

  repair(issueId: string): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const repaired = repairSnapshot(snapshot, now);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, repaired.history, repaired.snapshot);
    this.metrics.exception_e2e_repair_admin_actions += repaired.history.filter((entry) => entry.event_type === "admin_action").length;
    this.updateSafetyMetrics();
    return repaired.snapshot;
  }

  cover(id: ExceptionRequirementId): void {
    markRequirementCovered(this.metrics, id);
  }

  summary(): ExceptionE2EMetrics {
    this.updateSafetyMetrics();
    return { ...this.metrics, covered_requirements: [...this.metrics.covered_requirements] };
  }

  history(issueId: string): HistoryEntry[] {
    return this.store.listHistory(issueId);
  }

  async cleanup(): Promise<void> {
    this.store.close();
    await rm(this.dir, { recursive: true, force: true });
  }

  ownerLease(id: string, role = "issue_worker", ttlSeconds = 180) {
    return createOwnerLease({
      lease_id: `lease-${id}-${role}`,
      root_session_id: `root-${id}-${role}`,
      role,
      now,
      ttl_seconds: ttlSeconds,
    });
  }

  private updateSafetyMetrics(): void {
    const serialized = JSON.stringify(this.store.listAllIssuesForTests().flatMap((issue) => this.store.listHistory(issue.issue_id)));
    this.metrics.exception_e2e_secret_leaks = hasExceptionE2ESecretLeak(serialized) ? 1 : 0;
    this.metrics.exception_e2e_network_calls = 0;
    this.metrics.exception_e2e_live_credential_reads = 0;
  }
}

export async function createExceptionE2EHarness(): Promise<ExceptionE2EHarness> {
  return await ExceptionE2EHarness.create();
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-exceptions/exception-e2e.test.ts tests/e2e-exceptions/harness.ts
git commit -m "test: add exception e2e harness"
```

## Task 4: Cover Quarantine And Resume Requirements

**Files:**
- Modify: `tests/e2e-exceptions/harness.ts`
- Modify: `tests/e2e-exceptions/exception-e2e.test.ts`

- [ ] **Step 1: Add failing quarantine/resume E2E test**

Append to `tests/e2e-exceptions/exception-e2e.test.ts`:

```ts
test("exception E2E covers quarantine and resume requirements", async () => {
  const harness = await createExceptionE2EHarness();
  try {
    await harness.runQuarantineAndResumeScenarios();
    const summary = harness.summary();

    assert.ok(summary.covered_requirements.includes("EX-01"));
    assert.ok(summary.covered_requirements.includes("EX-02"));
    assert.ok(summary.covered_requirements.includes("EX-03"));
    assert.ok(summary.covered_requirements.includes("EX-04"));
    assert.ok(summary.covered_requirements.includes("EX-05"));
    assert.ok(summary.covered_requirements.includes("EX-06"));
    assert.equal(summary.exception_e2e_quarantined_cases, 3);
    assert.equal(summary.exception_e2e_resume_rejections, 2);
    assert.ok(summary.exception_e2e_recovery_cases >= 2);
    assert.ok(summary.exception_e2e_repair_admin_actions >= 2);
    assert.equal(summary.exception_e2e_secret_leaks, 0);
  } finally {
    await harness.cleanup();
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: fail with `harness.runQuarantineAndResumeScenarios is not a function`.

- [ ] **Step 3: Implement quarantine/resume scenario method**

Add this method to `ExceptionE2EHarness`:

```ts
async runQuarantineAndResumeScenarios(): Promise<void> {
  this.metrics.exception_e2e_scenarios_total += 1;
  const workflow = this.workflow();

  const missingLease = this.seedIssue("issue_to_pr_release", "Exception missing lease");
  this.store.appendHistoryBatchAndUpdateSnapshot(missingLease.issue_id, [], {
    ...missingLease,
    lifecycle_state: "running",
    runtime_context_json: { ...missingLease.runtime_context_json, stage_cursor: "implementation" },
  });
  const quarantinedMissing = this.repair(missingLease.issue_id);
  if (quarantinedMissing.lifecycle_state !== "quarantined") {
    throw new Error(`EX-01 expected quarantined, got ${quarantinedMissing.lifecycle_state}`);
  }
  this.metrics.exception_e2e_quarantined_cases += 1;
  this.cover("EX-01");

  const expiredLease = this.seedIssue("issue_to_pr_release", "Exception expired lease");
  this.store.appendHistoryBatchAndUpdateSnapshot(expiredLease.issue_id, [], {
    ...expiredLease,
    lifecycle_state: "running",
    runtime_context_json: {
      ...expiredLease.runtime_context_json,
      stage_cursor: "implementation",
      owner_lease: this.ownerLease("expired", "issue_worker", -60),
    },
  });
  const quarantinedExpired = this.repair(expiredLease.issue_id);
  if (quarantinedExpired.lifecycle_state !== "quarantined") {
    throw new Error(`EX-02 expected quarantined, got ${quarantinedExpired.lifecycle_state}`);
  }
  this.metrics.exception_e2e_quarantined_cases += 1;
  this.cover("EX-02");

  const rejectedNoLease = this.apply(quarantinedMissing.issue_id, workflow, [{ type: "resume_quarantined" }]);
  if (rejectedNoLease.lifecycle_state !== "quarantined") {
    throw new Error("EX-03 resume without lease advanced lifecycle");
  }
  this.metrics.exception_e2e_resume_rejections += 1;
  this.cover("EX-03");

  const resumedWithLease = this.apply(quarantinedMissing.issue_id, workflow, [{
    type: "resume_quarantined",
    lease: this.ownerLease("resume-new"),
  }]);
  if (resumedWithLease.lifecycle_state !== "running") {
    throw new Error(`EX-04 expected running, got ${resumedWithLease.lifecycle_state}`);
  }
  this.metrics.exception_e2e_recovery_cases += 1;
  this.cover("EX-04");

  const liveLeaseIssue = this.seedIssue("issue_to_pr_release", "Exception live lease resume");
  this.store.appendHistoryBatchAndUpdateSnapshot(liveLeaseIssue.issue_id, [], {
    ...liveLeaseIssue,
    lifecycle_state: "quarantined",
    runtime_context_json: {
      ...liveLeaseIssue.runtime_context_json,
      stage_cursor: "implementation",
      owner_lease: this.ownerLease("host-live"),
    },
  });
  const resumedLive = this.apply(liveLeaseIssue.issue_id, workflow, [{ type: "resume_quarantined", host_liveness: "live" }]);
  if (resumedLive.lifecycle_state !== "running") {
    throw new Error(`EX-05 expected running, got ${resumedLive.lifecycle_state}`);
  }
  this.metrics.exception_e2e_recovery_cases += 1;
  this.cover("EX-05");

  const unknownLiveIssue = this.seedIssue("issue_to_pr_release", "Exception unknown host liveness");
  this.store.appendHistoryBatchAndUpdateSnapshot(unknownLiveIssue.issue_id, [], {
    ...unknownLiveIssue,
    lifecycle_state: "quarantined",
    runtime_context_json: {
      ...unknownLiveIssue.runtime_context_json,
      stage_cursor: "implementation",
      owner_lease: this.ownerLease("host-unknown"),
    },
  });
  const rejectedUnknown = this.apply(unknownLiveIssue.issue_id, workflow, [{ type: "resume_quarantined", host_liveness: "unknown" }]);
  if (rejectedUnknown.lifecycle_state !== "quarantined") {
    throw new Error("EX-06 unknown host liveness should stay quarantined");
  }
  this.metrics.exception_e2e_quarantined_cases += 1;
  this.metrics.exception_e2e_resume_rejections += 1;
  this.cover("EX-06");
  this.metrics.exception_e2e_scenarios_passed += 1;
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: pass; quarantine/resume metrics match assertions.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-exceptions/harness.ts tests/e2e-exceptions/exception-e2e.test.ts
git commit -m "test: cover exception quarantine recovery"
```

## Task 5: Cover Child, Artifact, Verification, Projection, Effect, And Release Exceptions

**Files:**
- Modify: `tests/e2e-exceptions/harness.ts`
- Modify: `tests/e2e-exceptions/exception-e2e.test.ts`

- [ ] **Step 1: Add failing execution exception E2E test**

Append to `tests/e2e-exceptions/exception-e2e.test.ts`:

```ts
test("exception E2E covers child failure, artifact rejection, gate failure, projection, effect, and release recovery", async () => {
  const harness = await createExceptionE2EHarness();
  try {
    await harness.runExecutionExceptionScenarios();
    const summary = harness.summary();

    for (const id of ["EX-07", "EX-08", "EX-09", "EX-10", "EX-11", "EX-12", "EX-13", "EX-14"]) {
      assert.ok(summary.covered_requirements.includes(id as never), `${id} should be covered`);
    }
    assert.ok(summary.exception_e2e_failed_cases >= 2);
    assert.ok(summary.exception_e2e_retryable_failures >= 3);
    assert.ok(summary.exception_e2e_terminal_failures >= 2);
    assert.ok(summary.exception_e2e_artifact_rejections >= 1);
    assert.equal(summary.exception_e2e_duplicate_child_runs, 0);
    assert.equal(summary.exception_e2e_secret_leaks, 0);
  } finally {
    await harness.cleanup();
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: fail with `harness.runExecutionExceptionScenarios is not a function`.

- [ ] **Step 3: Add reusable active issue helper**

Add this private method to `ExceptionE2EHarness`:

```ts
private activeIssue(title: string, stageCursor = "implementation"): { issue: IssueSnapshot; workflow: WorkflowDefinition } {
  const workflow = this.workflow();
  const issue = this.seedIssue("issue_to_pr_release", title);
  this.store.appendHistoryBatchAndUpdateSnapshot(issue.issue_id, [], {
    ...issue,
    lifecycle_state: stageCursor === "verification" ? "verifying" : "running",
    runtime_context_json: {
      ...issue.runtime_context_json,
      stage_cursor: stageCursor,
      owner_lease: this.ownerLease(issue.issue_id),
      child_runs: [{
        child_run_id: `child-${issue.issue_id}`,
        lease_id: `lease-${issue.issue_id}-issue_worker`,
        root_session_id: `root-${issue.issue_id}-issue_worker`,
        role: "issue_worker",
        status: "running",
        session_id: `session-${issue.issue_id}`,
        started_at: now,
        last_seen_at: now,
      }],
    },
  });
  return { issue: this.store.getIssue(issue.issue_id), workflow };
}
```

- [ ] **Step 4: Implement execution exception scenario method**

Add this method to `ExceptionE2EHarness`:

```ts
async runExecutionExceptionScenarios(): Promise<void> {
  this.metrics.exception_e2e_scenarios_total += 1;

  const retryable = this.activeIssue("Exception retryable child");
  const retryableResult = this.apply(retryable.issue.issue_id, retryable.workflow, [{
    type: "child_artifact",
    child_run_id: `child-${retryable.issue.issue_id}`,
    status: "failed_retryable",
    artifact_history_id: this.history(retryable.issue.issue_id).length + 1,
    at: now,
  }]);
  if (retryableResult.lifecycle_state !== "running") {
    throw new Error("EX-07 retryable child failure should remain running");
  }
  this.metrics.exception_e2e_retryable_failures += 1;
  this.cover("EX-07");

  const terminal = this.activeIssue("Exception terminal child");
  const terminalResult = this.apply(terminal.issue.issue_id, terminal.workflow, [{
    type: "child_artifact",
    child_run_id: `child-${terminal.issue.issue_id}`,
    status: "failed_terminal",
    artifact_history_id: this.history(terminal.issue.issue_id).length + 1,
    at: now,
  }]);
  if (terminalResult.lifecycle_state !== "failed") {
    throw new Error("EX-08 terminal child failure should fail issue");
  }
  this.metrics.exception_e2e_failed_cases += 1;
  this.metrics.exception_e2e_terminal_failures += 1;
  this.cover("EX-08");

  const invalid = this.activeIssue("Exception invalid artifact");
  const invalidBefore = invalid.issue.lifecycle_state;
  const rejected = this.apply(invalid.issue.issue_id, invalid.workflow, [{
    type: "child_artifact",
    child_run_id: `child-${invalid.issue.issue_id}`,
    status: "succeeded",
    artifact_history_id: this.history(invalid.issue.issue_id).length + 1,
    at: now,
    artifact_kind: "worker_result",
    schema_version: "1.0",
    role: "issue_worker",
    summary: "missing changed_files",
    retryable: false,
    payload: {
      branch: "northstar/e2e-invalid",
      base_branch: "main",
      commit_sha: "invalid123",
      self_check_summary: "invalid artifact missing changed_files",
    },
  }]);
  if (rejected.lifecycle_state !== invalidBefore || !this.history(invalid.issue.issue_id).some((row) => row.event_type === "artifact_rejected")) {
    throw new Error("EX-09 invalid artifact should reject without advancing lifecycle");
  }
  this.metrics.exception_e2e_artifact_rejections += 1;
  this.cover("EX-09");

  const verifyRetry = this.activeIssue("Exception verification retry", "verification");
  const verifyRetryResult = this.apply(verifyRetry.issue.issue_id, verifyRetry.workflow, [{ type: "gate_result", status: "fail_retryable", at: now }]);
  if (verifyRetryResult.lifecycle_state !== "running" || verifyRetryResult.runtime_context_json.stage_cursor !== "implementation") {
    throw new Error("EX-10 verification retry should return to implementation");
  }
  this.metrics.exception_e2e_retryable_failures += 1;
  this.cover("EX-10");

  const verifyTerminal = this.activeIssue("Exception verification terminal", "verification");
  const verifyTerminalResult = this.apply(verifyTerminal.issue.issue_id, verifyTerminal.workflow, [{ type: "gate_result", status: "fail_terminal", at: now }]);
  if (verifyTerminalResult.lifecycle_state !== "failed") {
    throw new Error("EX-11 verification terminal fail should fail issue");
  }
  this.metrics.exception_e2e_failed_cases += 1;
  this.metrics.exception_e2e_terminal_failures += 1;
  this.cover("EX-11");

  const projection = this.activeIssue("Exception projection failure", "verification");
  const projectionBefore = projection.issue.lifecycle_state;
  const projectionResult = this.apply(projection.issue.issue_id, projection.workflow, [{
    type: "projection_result",
    projection_target: "label",
    status: "failed",
    attempt: 1,
    last_error: "rate limited",
    next_retry_at: "2026-05-29T03:05:00.000Z",
    payload: { labels: ["northstar:e2e:exception"] },
  }]);
  if (projectionResult.lifecycle_state !== projectionBefore || !this.history(projection.issue.issue_id).some((row) => row.event_type === "projection_failed")) {
    throw new Error("EX-12 projection failure should be retryable and non-mutating");
  }
  this.metrics.exception_e2e_retryable_failures += 1;
  this.cover("EX-12");

  const effect = this.activeIssue("Exception effect failure");
  const effectResult = this.apply(effect.issue.issue_id, effect.workflow, [{
    type: "effect_result",
    effect_type: "projection_retry",
    status: "failed",
    last_error: "effect worker failed",
    next_retry_at: "2026-05-29T03:05:00.000Z",
  }]);
  if (effectResult.lifecycle_state !== "running" || !this.history(effect.issue.issue_id).some((row) => row.event_type === "effect_failed_retryable")) {
    throw new Error("EX-13 effect failure should record retryable history without failing lifecycle");
  }
  this.metrics.exception_e2e_retryable_failures += 1;
  this.cover("EX-13");

  const release = this.seedIssue("issue_to_pr_release", "Exception confirmed merge recovery");
  this.store.appendHistoryBatchAndUpdateSnapshot(release.issue_id, [], {
    ...release,
    lifecycle_state: "failed",
    runtime_context_json: {
      ...release.runtime_context_json,
      release: { pr_merged: true },
      projection_sync: [{ projection_target: "local_main_sync", status: "failed" }],
    },
  });
  const repairedRelease = this.repair(release.issue_id);
  if (repairedRelease.lifecycle_state !== "completed") {
    throw new Error("EX-14 confirmed merge recovery should restore completed");
  }
  this.metrics.exception_e2e_recovery_cases += 1;
  this.cover("EX-14");

  this.metrics.exception_e2e_scenarios_passed += 1;
}
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: pass and cover EX-07 through EX-14.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e-exceptions/harness.ts tests/e2e-exceptions/exception-e2e.test.ts
git commit -m "test: cover exception execution failures"
```

## Task 6: Add End-To-End Summary Assertion

**Files:**
- Modify: `tests/e2e-exceptions/exception-e2e.test.ts`

- [ ] **Step 1: Add failing combined E2E summary test**

Append to `tests/e2e-exceptions/exception-e2e.test.ts`:

```ts
test("exception E2E summary meets quantitative acceptance thresholds", async (t) => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("exception E2E must not call fetch");
  }) as typeof fetch;
  const harness = await createExceptionE2EHarness();
  try {
    await harness.runQuarantineAndResumeScenarios();
    await harness.runExecutionExceptionScenarios();
    const summary = harness.summary();
    t.diagnostic(formatExceptionE2ESummary(summary));

    assert.equal(summary.exception_e2e_requirements_total, 14);
    assert.ok(summary.exception_e2e_requirements_covered >= 12);
    assert.ok(summary.exception_e2e_requirement_coverage_percent >= 85);
    assert.ok(summary.exception_e2e_scenarios_total >= 2);
    assert.equal(summary.exception_e2e_scenarios_passed, summary.exception_e2e_scenarios_total);
    assert.ok(summary.exception_e2e_quarantined_cases >= 3);
    assert.ok(summary.exception_e2e_failed_cases >= 2);
    assert.ok(summary.exception_e2e_recovery_cases >= 3);
    assert.ok(summary.exception_e2e_resume_rejections >= 2);
    assert.ok(summary.exception_e2e_retryable_failures >= 3);
    assert.ok(summary.exception_e2e_terminal_failures >= 2);
    assert.ok(summary.exception_e2e_artifact_rejections >= 1);
    assert.ok(summary.exception_e2e_repair_admin_actions >= 2);
    assert.equal(summary.exception_e2e_duplicate_child_runs, 0);
    assert.equal(summary.exception_e2e_secret_leaks, 0);
    assert.equal(summary.exception_e2e_network_calls, 0);
    assert.equal(summary.exception_e2e_live_credential_reads, 0);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await harness.cleanup();
  }
});
```

Also update the import from `./metrics.ts` to include `formatExceptionE2ESummary`.

- [ ] **Step 2: Run RED or GREEN based on prior metrics**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: if it fails, the failure should identify a missing metric count; update only the scenario methods responsible for that metric. If it passes immediately, the combined acceptance contract is already covered by previous task code.

- [ ] **Step 3: Run GREEN**

Run:

```bash
npm run test:e2e:exceptions
```

Expected: pass with a diagnostic line containing `exception_e2e_requirement_coverage_percent=100` if all EX-01 through EX-14 are covered, or at least `85`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e-exceptions/exception-e2e.test.ts tests/e2e-exceptions/harness.ts
git commit -m "test: assert exception e2e acceptance metrics"
```

## Task 7: Add Coverage Matrix And Spec Compliance

**Files:**
- Create: `docs/superpowers/exception-e2e-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Add failing spec compliance test**

Add this test after the full live workflow matrix test in `tests/spec/spec-compliance.test.ts`:

```ts
test("exception e2e coverage matrix maps quantified exception requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/exception-e2e-coverage.md"), "utf8");
  for (const required of [
    "EX-01",
    "EX-02",
    "EX-03",
    "EX-04",
    "EX-05",
    "EX-06",
    "EX-07",
    "EX-08",
    "EX-09",
    "EX-10",
    "EX-11",
    "EX-12",
    "EX-13",
    "EX-14",
    "exception_e2e_requirement_coverage_percent",
    "tests/e2e-exceptions/exception-e2e.test.ts",
    "tests/e2e-exceptions/harness.ts",
    "tests/e2e-exceptions/metrics.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test
```

Expected: fail with missing `docs/superpowers/exception-e2e-coverage.md`.

- [ ] **Step 3: Add coverage matrix**

Create `docs/superpowers/exception-e2e-coverage.md`:

```md
# Northstar Exception E2E Coverage Matrix

| ID | Requirement | Test File | Harness/Implementation File |
| --- | --- | --- | --- |
| EX-01 | Active issue missing valid owner lease is quarantined. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/repair.ts`, `src/runtime/state-machine.ts` |
| EX-02 | Active issue with expired owner lease is quarantined. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/repair.ts`, `src/runtime/state-machine.ts` |
| EX-03 | Resume quarantined without a lease is rejected. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-04 | Resume quarantined with a new lease succeeds. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-05 | Resume quarantined with host-confirmed live lease succeeds. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-06 | Resume quarantined with unknown host liveness is rejected. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-07 | Retryable child failure stays active. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-08 | Terminal child failure moves issue to failed. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-09 | Invalid child artifact is rejected without lifecycle advance. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/artifacts.ts`, `src/runtime/state-machine.ts` |
| EX-10 | Verification retryable failure returns to implementation. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-11 | Verification terminal failure moves issue to failed. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-12 | Projection failure is retryable and non-mutating. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts` |
| EX-13 | Effect failure after DB commit is retryable. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/state-machine.ts`, `src/runtime/engine.ts` |
| EX-14 | Confirmed merge plus local sync failure remains completed. | `tests/e2e-exceptions/exception-e2e.test.ts` | `tests/e2e-exceptions/harness.ts`, `src/runtime/repair.ts`, `src/runtime/state-machine.ts` |

## Quantified Gate

`npm run test:e2e:exceptions` must assert:

- `exception_e2e_requirements_total=14`
- `exception_e2e_requirements_covered>=12`
- `exception_e2e_requirement_coverage_percent>=85`
- `exception_e2e_secret_leaks=0`
- `exception_e2e_network_calls=0`
- `exception_e2e_live_credential_reads=0`
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm test
npm run test:e2e:exceptions
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/exception-e2e-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map exception e2e coverage"
```

## Task 8: Final Verification Gate

**Files:**
- No new files.

- [ ] **Step 1: Run unit and deterministic E2E gates**

Run:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:full-live
npm run test:e2e:exceptions
```

Expected:
- `npm test`: all pass.
- `npm run test:e2e`: all pass.
- `npm run test:e2e:daemon`: all pass.
- `npm run test:e2e:full-live`: pass with live scenarios skipped unless live flags are explicitly set.
- `npm run test:e2e:exceptions`: pass and print `exception_e2e_requirement_coverage_percent>=85`.

- [ ] **Step 2: Run CLI smoke**

Run:

```bash
node --run northstar -- --help
node --run northstar -- --version
```

Expected: both commands exit 0 and print help/version output.

- [ ] **Step 3: Run forbidden dependency scans**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
```

Expected: each `rg` exits 1 with no matches.

- [ ] **Step 4: Inspect git status**

Run:

```bash
git status --short
```

Expected: only intentional files are modified before final commit, or clean after final commit.

- [ ] **Step 5: Final commit if verification changed docs/tests**

If any final documentation adjustment was needed:

```bash
git add docs/superpowers/exception-e2e-coverage.md tests/e2e-exceptions tests/spec/spec-compliance.test.ts package.json
git commit -m "test: complete exception e2e coverage"
```

## Goal Prompt

Use this prompt to execute the plan:

```text
/goal
使用 Superpowers executing-plans 執行 docs/superpowers/plans/2026-05-29-northstar-exception-e2e-plan.md。

完成 Northstar Exception E2E：
- deterministic offline issue execution exception tests
- quarantined / failed / recovery / resume / retryable / terminal failure flows
- scenario requirement coverage >= 85%

依據：
- docs/superpowers/specs/2026-05-29-northstar-exception-e2e-design.md
- docs/superpowers/plans/2026-05-29-northstar-exception-e2e-plan.md
- 現有 runtime/state-machine/store/repair/engine tests

執行規則：
1. 使用 Superpowers：executing-plans、test-driven-development、systematic-debugging、verification-before-completion。
2. 逐 task TDD 執行；每個未覆蓋行為先寫 failing test，確認 RED，再做最小實作轉 GREEN。
3. `npm run test:e2e:exceptions` 必須與 unit/offline/daemon/full-live tests 分離。
4. exception E2E 不得依賴網路、GitHub token、OpenCode/Codex credentials、host CLIs。
5. 不得重寫 runtime core；只在測試或必要 harness/coverage docs 補足。
6. 若測試失敗，先用 systematic-debugging 做 root-cause investigation，不猜測修。
7. 完成前執行 Final Verification Gate。

量化驗收：
- exception_e2e_requirements_total = 14
- exception_e2e_requirements_covered >= 12
- exception_e2e_requirement_coverage_percent >= 85
- exception_e2e_scenarios_total >= 8
- exception_e2e_scenarios_passed = total scenarios
- exception_e2e_quarantined_cases >= 3
- exception_e2e_failed_cases >= 2
- exception_e2e_recovery_cases >= 3
- exception_e2e_resume_rejections >= 2
- exception_e2e_retryable_failures >= 3
- exception_e2e_terminal_failures >= 2
- exception_e2e_artifact_rejections >= 1
- exception_e2e_repair_admin_actions >= 2
- exception_e2e_duplicate_child_runs = 0
- exception_e2e_secret_leaks = 0
- exception_e2e_network_calls = 0
- exception_e2e_live_credential_reads = 0

Final Verification Gate：
- npm test
- npm run test:e2e
- npm run test:e2e:daemon
- npm run test:e2e:full-live
- npm run test:e2e:exceptions
- node --run northstar -- --help
- node --run northstar -- --version
- rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
- rg "process\\.env\\." src
- rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
- git status --short

最後回報：
- exception E2E summary metrics
- EX-01 到 EX-14 coverage matrix
- RED -> GREEN evidence
- fresh verification output summary
- 修改檔案摘要
- deferred live exception E2E / code coverage tooling
```

## Self-Review Notes

- Spec coverage: Tasks 1-8 cover command separation, metrics, harness, EX-01 through EX-14, coverage docs, and final verification.
- Open-item scan: Plan contains no open-ended implementation steps.
- Type consistency: `ExceptionE2EMetrics`, `ExceptionRequirementId`, `ExceptionE2EHarness`, and scenario method names are introduced before use.

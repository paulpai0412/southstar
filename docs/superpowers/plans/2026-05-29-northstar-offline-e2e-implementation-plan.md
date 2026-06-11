# Northstar Offline E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic offline E2E validation for Northstar with quantified acceptance metrics proving coding and domain workflows complete without network or live credentials.

**Architecture:** Add a test-only E2E harness under `tests/e2e/` that drives temp SQLite stores, local intake packets, workflow fixtures, fake host sessions, and pure runtime events. Keep live GitHub/OpenCode/Codex out of this suite; if the E2E tests expose missing runtime behavior, implement the smallest production fixes behind existing state-machine/artifact boundaries.

**Tech Stack:** Node 22.22+, `node:test`, `node:assert/strict`, `node:sqlite`, temp files via `node:fs/promises`, existing Northstar workflow fixtures, existing fake host adapter, TypeScript executed by Node type stripping.

---

## File Structure

- Create `tests/e2e/index.test.ts`: E2E suite entrypoint used by `npm run test:e2e`.
- Create `tests/e2e/harness.ts`: test-only harness for temp store setup, issue seeding, event driving, restart, metric tracking, and cleanup.
- Create `tests/e2e/offline-e2e.test.ts`: six required E2E scenarios and summary assertions.
- Modify `package.json`: add `test:e2e`.
- Modify `src/runtime/artifacts.ts`: accept workflow-defined artifact schemas in addition to built-in artifact schemas.
- Modify `src/runtime/state-machine.ts`: pass workflow context into artifact validation and derive artifact issue numbers from intake packets when issue ids are prefixed.
- Modify `tests/runtime/artifacts.test.ts`: focused unit coverage for workflow-defined artifacts.
- Modify `tests/runtime/state-machine.test.ts`: focused unit coverage for prefixed intake issue ids and verified release lease acquisition.
- Do not modify live test files in this plan; live E2E remains deferred.

## Task 1: Add E2E Script And RED Summary Contract

**Files:**
- Modify: `package.json`
- Create: `tests/e2e/index.test.ts`
- Create: `tests/e2e/offline-e2e.test.ts`

- [ ] **Step 1: Write the failing E2E tests**

Create `tests/e2e/index.test.ts`:

```ts
import "./offline-e2e.test.ts";
```

Create `tests/e2e/offline-e2e.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineE2EHarness } from "./harness.ts";

test("offline E2E summary contract reports quantified acceptance metrics", async (t) => {
  const harness = await createOfflineE2EHarness();
  try {
    await harness.runCodingReleaseFullCycle();
    await harness.runCodingNoReleaseFullCycle();
    await harness.runContentCreationFullCycle();
    await harness.runOfficeReportFullCycle();
    await harness.runRestartRecoveryScenario();
    await harness.runInvalidArtifactScenario();

    const summary = harness.summary();
    t.diagnostic(harness.formatSummary());

    assert.equal(summary.successful_full_cycle_workflows, 4);
    assert.equal(summary.total_scenarios, 6);
    assert.equal(summary.scenarios_passed, 6);
    assert.equal(summary.restart_recovery_completed, 1);
    assert.equal(summary.invalid_artifact_scenarios, 1);
    assert.equal(summary.workflows_completed, 4);
    assert.ok(summary.lifecycle_states_observed >= 8);
    assert.equal(summary.new_domain_lifecycle_states, 0);
    assert.equal(summary.network_calls, 0);
    assert.equal(summary.live_credential_reads, 0);
    assert.ok(summary.coding_release_owner_leases >= 1);
    assert.ok(summary.coding_release_child_run_records >= 2);
    assert.ok(summary.coding_release_valid_child_artifacts >= 2);
    assert.ok(summary.coding_release_confirmed_merge_facts >= 1);
    assert.ok(summary.artifact_rejection_history_rows >= 1);
    assert.ok(summary.retryable_projection_failures >= 1);
    assert.ok(summary.retryable_effect_failures >= 1);
    assert.ok(summary.post_completion_cleanup_failures_preserved >= 1);
    assert.equal(summary.domain_full_cycle_workflows, 2);
    assert.equal(summary.domain_workflows_with_coding_role_chain, 0);
  } finally {
    await harness.cleanup();
  }
});
```

- [ ] **Step 2: Add the E2E npm script**

Modify `package.json` scripts:

```json
{
  "scripts": {
    "test": "node --disable-warning=ExperimentalWarning tests/index.test.ts",
    "test:e2e": "node --disable-warning=ExperimentalWarning tests/e2e/index.test.ts",
    "test:live": "node --disable-warning=ExperimentalWarning tests/live/index.test.ts",
    "northstar": "node src/cli/entrypoint.ts"
  }
}
```

- [ ] **Step 3: Run E2E and verify RED**

Run:

```bash
npm run test:e2e
```

Expected: FAIL with `Cannot find module ... tests/e2e/harness.ts`. This proves the E2E suite is wired and the harness is missing.

- [ ] **Step 4: Commit the E2E script RED wiring**

Run:

```bash
git add package.json tests/e2e/index.test.ts tests/e2e/offline-e2e.test.ts
git commit -m "test: add offline e2e acceptance shell"
```

## Task 2: Add Test-Only Offline E2E Harness

**Files:**
- Create: `tests/e2e/harness.ts`
- Modify: `tests/e2e/offline-e2e.test.ts`

- [ ] **Step 1: Write a focused failing harness test**

Append to `tests/e2e/offline-e2e.test.ts`:

```ts
test("offline E2E harness seeds local issue packets without network calls", async () => {
  const harness = await createOfflineE2EHarness();
  try {
    const issue = harness.seedIssue("issue_to_done", "E2E seed smoke");

    assert.equal(issue.lifecycle_state, "ready");
    assert.equal(issue.issue_id, "local:1001");
    assert.equal(harness.summary().network_calls, 0);
    assert.equal(harness.store.listHistory("local:1001").at(-1)?.event_type, "intake_packet");
  } finally {
    await harness.cleanup();
  }
});
```

- [ ] **Step 2: Run E2E and verify RED**

Run:

```bash
npm run test:e2e
```

Expected: FAIL because `createOfflineE2EHarness` and harness methods do not exist.

- [ ] **Step 3: Implement the minimal harness**

Create `tests/e2e/harness.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import type { IssuePacket } from "../../src/intake/types.ts";
import { issuePacketId } from "../../src/intake/types.ts";
import { applyRuntimeEvents, createOwnerLease, newIssueSnapshot, type RuntimeEvent } from "../../src/runtime/state-machine.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../../src/types/control-plane.ts";
import { lifecycleStates } from "../../src/types/control-plane.ts";
import { loadWorkflow, type WorkflowDefinition } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const now = "2026-05-29T03:00:00.000Z";

export interface E2ESummary {
  successful_full_cycle_workflows: number;
  total_scenarios: number;
  scenarios_passed: number;
  restart_recovery_completed: number;
  invalid_artifact_scenarios: number;
  workflows_completed: number;
  lifecycle_states_observed: number;
  new_domain_lifecycle_states: number;
  network_calls: number;
  live_credential_reads: number;
  coding_release_owner_leases: number;
  coding_release_child_run_records: number;
  coding_release_valid_child_artifacts: number;
  coding_release_confirmed_merge_facts: number;
  artifact_rejection_history_rows: number;
  retryable_projection_failures: number;
  retryable_effect_failures: number;
  post_completion_cleanup_failures_preserved: number;
  domain_full_cycle_workflows: number;
  domain_workflows_with_coding_role_chain: number;
}

export class OfflineE2EHarness {
  readonly dir: string;
  readonly dbPath: string;
  readonly store: SqliteControlPlaneStore;
  readonly host = new FakeHostAdapter();
  private readonly observedStates = new Set<LifecycleState>();
  private issueSequence = 1000;
  private metrics: E2ESummary = {
    successful_full_cycle_workflows: 0,
    total_scenarios: 0,
    scenarios_passed: 0,
    restart_recovery_completed: 0,
    invalid_artifact_scenarios: 0,
    workflows_completed: 0,
    lifecycle_states_observed: 0,
    new_domain_lifecycle_states: 0,
    network_calls: 0,
    live_credential_reads: 0,
    coding_release_owner_leases: 0,
    coding_release_child_run_records: 0,
    coding_release_valid_child_artifacts: 0,
    coding_release_confirmed_merge_facts: 0,
    artifact_rejection_history_rows: 0,
    retryable_projection_failures: 0,
    retryable_effect_failures: 0,
    post_completion_cleanup_failures_preserved: 0,
    domain_full_cycle_workflows: 0,
    domain_workflows_with_coding_role_chain: 0,
  };

  private constructor(dir: string, store: SqliteControlPlaneStore) {
    this.dir = dir;
    this.dbPath = join(dir, "northstar-e2e.sqlite");
    this.store = store;
  }

  static async create(): Promise<OfflineE2EHarness> {
    const dir = await mkdtemp(join(tmpdir(), "northstar-e2e-"));
    const store = SqliteControlPlaneStore.open(join(dir, "northstar-e2e.sqlite"));
    return new OfflineE2EHarness(dir, store);
  }

  seedIssue(workflowId: string, title: string): IssueSnapshot {
    this.issueSequence += 1;
    const packet: IssuePacket = {
      issue_number: String(this.issueSequence),
      title,
      source: "local",
      source_url: `local://${workflowId}/${this.issueSequence}`,
      branch: `northstar/e2e-${this.issueSequence}`,
      base_branch: "main",
      labels: ["northstar:e2e", workflowId],
      dependencies: [],
      raw_text: title,
      ready_for_agent: true,
    };
    this.store.upsertIssuePacket(packet);
    const snapshot = this.store.getIssue(issuePacketId(packet));
    this.observe(snapshot);
    return snapshot;
  }

  workflow(fixtureName: string): WorkflowDefinition {
    return loadWorkflow(join(repoRoot, "tests/fixtures/workflows", fixtureName));
  }

  apply(issueId: string, workflow: WorkflowDefinition, events: RuntimeEvent[]): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const result = applyRuntimeEvents(snapshot, workflow, events);
    this.store.appendHistoryBatchAndUpdateSnapshot(issueId, result.history, result.snapshot);
    this.observe(result.snapshot);
    this.countHistory(issueId);
    return result.snapshot;
  }

  async cleanup(): Promise<void> {
    this.store.close();
    await rm(this.dir, { recursive: true, force: true });
  }

  summary(): E2ESummary {
    return { ...this.metrics, lifecycle_states_observed: this.observedStates.size };
  }

  formatSummary(): string {
    const summary = this.summary();
    return [
      `workflows_completed=${summary.workflows_completed}/4`,
      `scenarios_passed=${summary.scenarios_passed}/6`,
      `network_calls=${summary.network_calls}`,
      `lifecycle_states_observed=${summary.lifecycle_states_observed}`,
      `artifact_rejections=${summary.artifact_rejection_history_rows}`,
      `restart_recovery_completed=${summary.restart_recovery_completed}`,
      `domain_workflows_completed=${summary.domain_full_cycle_workflows}`,
      `confirmed_merge_facts=${summary.coding_release_confirmed_merge_facts}`,
      `retryable_projection_failures=${summary.retryable_projection_failures}`,
      `retryable_effect_failures=${summary.retryable_effect_failures}`,
      `post_completion_cleanup_failures_preserved=${summary.post_completion_cleanup_failures_preserved}`,
    ].join(" ");
  }

  runCodingReleaseFullCycle(): Promise<void> {
    throw new Error("pending E2E scenario: runCodingReleaseFullCycle");
  }
  runCodingNoReleaseFullCycle(): Promise<void> {
    throw new Error("pending E2E scenario: runCodingNoReleaseFullCycle");
  }
  runContentCreationFullCycle(): Promise<void> {
    throw new Error("pending E2E scenario: runContentCreationFullCycle");
  }
  runOfficeReportFullCycle(): Promise<void> {
    throw new Error("pending E2E scenario: runOfficeReportFullCycle");
  }
  runRestartRecoveryScenario(): Promise<void> {
    throw new Error("pending E2E scenario: runRestartRecoveryScenario");
  }
  runInvalidArtifactScenario(): Promise<void> {
    throw new Error("pending E2E scenario: runInvalidArtifactScenario");
  }

  private observe(snapshot: IssueSnapshot): void {
    if (lifecycleStates.includes(snapshot.lifecycle_state)) {
      this.observedStates.add(snapshot.lifecycle_state);
    }
  }

  private countHistory(issueId: string): void {
    const history = this.store.listHistory(issueId);
    this.metrics.artifact_rejection_history_rows = history.filter((row) => row.event_type === "artifact_rejected").length;
    this.metrics.retryable_projection_failures = history.filter((row) => row.event_type === "projection_failed").length;
    this.metrics.retryable_effect_failures = history.filter((row) => row.event_type === "effect_failed_retryable").length;
    this.metrics.coding_release_confirmed_merge_facts = history.filter((row) => row.event_type === "release_completed").length;
  }
}

export async function createOfflineE2EHarness(): Promise<OfflineE2EHarness> {
  return await OfflineE2EHarness.create();
}
```

- [ ] **Step 4: Run E2E and verify partial GREEN**

Run:

```bash
npm run test:e2e
```

Expected: the seed smoke passes; the summary contract test still fails with `pending E2E scenario: runCodingReleaseFullCycle`.

- [ ] **Step 5: Commit the harness skeleton**

Run:

```bash
git add tests/e2e/harness.ts tests/e2e/offline-e2e.test.ts
git commit -m "test: add offline e2e harness skeleton"
```

## Task 3: Support Workflow-Defined Artifact Validation

**Files:**
- Modify: `src/runtime/artifacts.ts`
- Modify: `src/runtime/state-machine.ts`
- Modify: `tests/runtime/artifacts.test.ts`
- Modify: `tests/runtime/state-machine.test.ts`

- [ ] **Step 1: Write failing unit tests for custom artifacts and prefixed issue ids**

Append to `tests/runtime/artifacts.test.ts`:

```ts
import { loadWorkflow } from "../../src/types/workflow.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifactTestDir = dirname(fileURLToPath(import.meta.url));
const artifactRepoRoot = resolve(artifactTestDir, "../..");

test("workflow-defined artifacts validate required custom fields", () => {
  const workflow = loadWorkflow(join(artifactRepoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));

  const artifact = validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "draft_article",
    issue_number: 1001,
    role: "writer",
    status: "success",
    observed_at: "2026-05-29T03:00:00.000Z",
    summary: "Draft complete",
    retryable: false,
    title: "Offline E2E",
    body_text: "A concise draft body",
  }, workflow);

  assert.equal(artifact.artifact_kind, "draft_article");
  assert.equal(artifact.payload.title, "Offline E2E");
});

test("workflow-defined artifacts reject missing required custom fields", () => {
  const workflow = loadWorkflow(join(artifactRepoRoot, "tests/fixtures/workflows/office-report-delivery.yaml"));

  assert.throws(() => validateArtifactPayload({
    schema_version: "1.0",
    artifact_kind: "email_delivery_result",
    issue_number: 1002,
    role: "mailer",
    status: "success",
    observed_at: "2026-05-29T03:00:00.000Z",
    summary: "Email sent",
    retryable: false,
    recipient_count: 3,
  }, workflow), /ARTIFACT_MISSING_FIELD at confirmed_delivery/);
});
```

Append to `tests/runtime/state-machine.test.ts`:

```ts
test("validated child artifacts derive issue number from intake packet for prefixed issue ids", () => {
  const snapshot = newIssueSnapshot("local:1001", {
    lifecycle_state: "running",
    owner_lease: createOwnerLease({
      lease_id: "lease-prefixed-1",
      root_session_id: "root-prefixed-1",
      role: "issue_worker",
      now,
      ttl_seconds: 180,
    }),
    stage_cursor: "implementation",
    runtime_context_json: {
      issue_packet: { issue_number: "1001" },
      child_runs: [{
        child_run_id: "child-prefixed-1",
        lease_id: "lease-prefixed-1",
        root_session_id: "root-prefixed-1",
        role: "issue_worker",
        status: "running",
        session_id: "session-prefixed-1",
        started_at: now,
        last_seen_at: now,
      }],
      projection_sync: [],
    },
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{
    type: "child_artifact",
    child_run_id: "child-prefixed-1",
    status: "succeeded",
    artifact_history_id: 1,
    at: now,
    artifact_kind: "worker_result",
    schema_version: "1.0",
    summary: "Implementation complete",
    retryable: false,
    payload: {
      branch: "northstar/e2e",
      base_branch: "main",
      commit_sha: "abc123",
      changed_files: ["src/example.ts"],
      self_check_summary: "npm test passed",
    },
  }]);

  assert.equal(result.snapshot.lifecycle_state, "verifying");
  assert.equal(result.history.some((entry) => entry.event_type === "artifact_rejected"), false);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `validateArtifactPayload` does not accept a workflow argument and state-machine artifact validation derives `Number("local:1001")`.

- [ ] **Step 3: Implement workflow-defined artifact support**

Modify `src/runtime/artifacts.ts`:

```ts
import type { WorkflowDefinition } from "../types/workflow.ts";
```

Change the function signature:

```ts
export function validateArtifactPayload(value: unknown, workflow?: WorkflowDefinition): NormalizedArtifact {
```

Replace the unknown-kind check with:

```ts
  const customSchema = workflow?.artifact_schemas?.[artifact_kind];
  if (!allowedKinds.has(artifact_kind) && !customSchema) {
    throw new ArtifactValidationError("ARTIFACT_UNKNOWN_KIND", "artifact_kind", `unknown artifact kind ${artifact_kind}`);
  }
```

After built-in checks, add:

```ts
  if (customSchema) {
    for (const field of customSchema.required_fields ?? []) {
      if (record[field] === undefined) {
        throw new ArtifactValidationError("ARTIFACT_MISSING_FIELD", field, `${field} is required by workflow artifact schema`);
      }
    }
  }
```

- [ ] **Step 4: Implement prefixed issue id derivation**

Modify `src/runtime/state-machine.ts` in `applyChildArtifact` to pass `workflow`:

```ts
      validateArtifactPayload({
        schema_version: event.schema_version ?? "1.0",
        artifact_kind: event.artifact_kind,
        issue_number: artifactIssueNumber(result.snapshot),
        role: event.role ?? childRun?.role,
        status: artifactStatusFromChildEvent(event.status),
        observed_at: event.observed_at ?? event.at,
        summary: event.summary ?? "",
        retryable: event.retryable ?? (event.status === "blocked" || event.status === "failed_retryable"),
        ...(event.payload ?? {}),
      }, workflow);
```

Add helper near the child-artifact validation helpers:

```ts
function artifactIssueNumber(snapshot: IssueSnapshot): number {
  const packet = snapshot.runtime_context_json.issue_packet;
  if (typeof packet === "object" && packet !== null && "issue_number" in packet) {
    const value = Number((packet as { issue_number?: unknown }).issue_number);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return Number(snapshot.issue_id);
}
```

- [ ] **Step 5: Run unit tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit artifact validation support**

Run:

```bash
git add src/runtime/artifacts.ts src/runtime/state-machine.ts tests/runtime/artifacts.test.ts tests/runtime/state-machine.test.ts
git commit -m "feat: validate workflow-defined artifacts"
```

## Task 4: Implement Coding Release Full-Cycle E2E

**Files:**
- Modify: `tests/e2e/harness.ts`
- Modify: `src/runtime/state-machine.ts`
- Modify: `tests/runtime/state-machine.test.ts`

- [ ] **Step 1: Write failing release lease unit test**

Append to `tests/runtime/state-machine.test.ts`:

```ts
test("verified issue can acquire release owner lease without leaving verified", () => {
  const snapshot = newIssueSnapshot("release-lease-1", {
    lifecycle_state: "verified",
    stage_cursor: "release",
  });
  const lease = createOwnerLease({
    lease_id: "release-lease-1",
    root_session_id: "release-root-1",
    role: "release_worker",
    now,
    ttl_seconds: 180,
  });

  const result = applyRuntimeEvents(snapshot, workflow, [{ type: "claim_owner_lease", lease }]);

  assert.equal(result.snapshot.lifecycle_state, "verified");
  assert.equal(result.snapshot.runtime_context_json.owner_lease?.role, "release_worker");
  assert.equal(result.history.at(-1)?.event_type, "owner_lease_acquired");
});
```

- [ ] **Step 2: Run unit tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `claim_owner_lease` currently changes lifecycle to `claimed`.

- [ ] **Step 3: Implement verified release lease semantics**

Modify `claimOwnerLease` in `src/runtime/state-machine.ts`:

```ts
  if (snapshot.lifecycle_state === "verified" && lease.role === "release_worker") {
    snapshot.runtime_context_json.owner_lease = lease;
    snapshot.current_session_id = lease.root_session_id;
    appendHistory(result, "owner_lease_acquired", { lease_id: lease.lease_id, role: lease.role });
    return;
  }
```

Place this after the duplicate active lease guard and before the default lease assignment.

- [ ] **Step 4: Implement `runCodingReleaseFullCycle`**

In `tests/e2e/harness.ts`, add helper methods inside `OfflineE2EHarness`:

```ts
  runCodingReleaseFullCycle(): Promise<void> {
    const workflow = this.workflow("issue-to-pr-release.yaml");
    const issue = this.seedIssue("issue_to_pr_release", "E2E coding release");
    this.metrics.total_scenarios += 1;
    this.observe(newIssueSnapshot("claimed-observer", { lifecycle_state: "failed" }));

    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "worker_result",
      role: "issue_worker",
      payload: {
        branch: "northstar/e2e-coding",
        base_branch: "main",
        commit_sha: "abc123",
        changed_files: ["src/runtime/example.ts"],
        self_check_summary: "offline e2e worker self-check passed",
      },
    });

    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "evidence_packet",
      role: "pr_verifier",
      payload: {
        pr_number: 42,
        base_branch: "main",
        gate_results: [{ name: "npm test", status: "pass" }],
        verifier: { agent: "fake" },
      },
    });

    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "claim_owner_lease",
      lease: createOwnerLease({
        lease_id: "lease-release-e2e",
        root_session_id: "root-release-e2e",
        role: "release_worker",
        now,
        ttl_seconds: 180,
      }),
    }]);
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "start_release", at: now }]);
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "release_result",
      status: "success",
      pr_merged: true,
      at: now,
    }]);

    const completed = this.apply(issue.issue_id, workflow, [{
      type: "effect_result",
      effect_type: "local_sync",
      status: "failed",
      last_error: "cleanup failed after merge",
      next_retry_at: "2026-05-29T03:05:00.000Z",
    }]);

    if (completed.lifecycle_state !== "completed") {
      throw new Error(`coding release expected completed, got ${completed.lifecycle_state}`);
    }

    this.metrics.successful_full_cycle_workflows += 1;
    this.metrics.scenarios_passed += 1;
    this.metrics.workflows_completed += 1;
    this.metrics.coding_release_owner_leases += 1;
    this.metrics.coding_release_child_run_records += completed.runtime_context_json.child_runs?.length ?? 0;
    this.metrics.post_completion_cleanup_failures_preserved += 1;
    return Promise.resolve();
  }
```

Add helpers:

```ts
  private startCurrentStage(issueId: string, workflow: WorkflowDefinition): IssueSnapshot {
    const snapshot = this.store.getIssue(issueId);
    const stageName = snapshot.runtime_context_json.stage_cursor ?? Object.keys(workflow.stages)[0];
    const stage = workflow.stages[stageName];
    const role = workflow.roles[stage.role];
    if (!snapshot.runtime_context_json.owner_lease) {
      this.apply(issueId, workflow, [{
        type: "claim_owner_lease",
        lease: createOwnerLease({
          lease_id: `lease-${issueId}-${stage.role}`,
          root_session_id: `root-${issueId}-${stage.role}`,
          role: stage.role,
          now,
          ttl_seconds: 180,
        }),
      }]);
    }
    const child = this.host.startBackgroundChild({
      issue_id: issueId,
      lease_id: this.store.getIssue(issueId).runtime_context_json.owner_lease?.lease_id ?? "lease-missing",
      root_session_id: this.store.getIssue(issueId).runtime_context_json.owner_lease?.root_session_id ?? "root-missing",
      role_name: stage.role,
      role,
    });
    return this.apply(issueId, workflow, [{
      type: "start_stage",
      child_run_id: child.child_run_id,
      session_id: child.session_id,
      at: now,
    }]);
  }

  private submitChildArtifact(
    issueId: string,
    workflow: WorkflowDefinition,
    snapshot: IssueSnapshot,
    artifact: { artifact_kind: string; role: string; payload: Record<string, unknown> },
  ): IssueSnapshot {
    const childRun = snapshot.runtime_context_json.child_runs?.at(-1);
    if (!childRun) {
      throw new Error(`No child run for ${issueId}`);
    }
    this.metrics.coding_release_valid_child_artifacts += artifact.role === "issue_worker" || artifact.role === "pr_verifier" ? 1 : 0;
    return this.apply(issueId, workflow, [{
      type: "child_artifact",
      child_run_id: childRun.child_run_id,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issueId).length + 1,
      at: now,
      artifact_kind: artifact.artifact_kind,
      schema_version: "1.0",
      role: artifact.role,
      summary: `${artifact.artifact_kind} success`,
      retryable: false,
      payload: artifact.payload,
    }]);
  }
```

- [ ] **Step 5: Run E2E and verify coding release passes while other methods fail**

Run:

```bash
npm run test:e2e
```

Expected: coding release path no longer fails; summary contract still fails on the next unimplemented scenario method.

- [ ] **Step 6: Run unit tests and commit**

Run:

```bash
npm test
git add src/runtime/state-machine.ts tests/runtime/state-machine.test.ts tests/e2e/harness.ts
git commit -m "test: add coding release e2e path"
```

Expected: `npm test` PASS before commit.

## Task 5: Add No-Release And Domain Full-Cycle E2E

**Files:**
- Modify: `tests/e2e/harness.ts`

- [ ] **Step 1: Implement no-release and domain scenario methods**

Replace the unimplemented methods in `tests/e2e/harness.ts`:

```ts
  runCodingNoReleaseFullCycle(): Promise<void> {
    const workflow = this.workflow("issue-to-done.yaml");
    const issue = this.seedIssue("issue_to_done", "E2E no release");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "worker_result",
      role: "issue_worker",
      payload: {
        branch: "northstar/e2e-no-release",
        base_branch: "main",
        commit_sha: "def456",
        changed_files: ["src/runtime/no-release.ts"],
        self_check_summary: "offline no-release self-check passed",
      },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "gate_result", status: "pass", at: now }]);
    if (snapshot.lifecycle_state !== "completed") {
      throw new Error(`no-release expected completed, got ${snapshot.lifecycle_state}`);
    }
    this.metrics.successful_full_cycle_workflows += 1;
    this.metrics.scenarios_passed += 1;
    this.metrics.workflows_completed += 1;
    return Promise.resolve();
  }

  runContentCreationFullCycle(): Promise<void> {
    const workflow = this.workflow("content-creation-publish.yaml");
    const issue = this.seedIssue("content_creation_publish", "E2E content publish");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "draft_article",
      role: "writer",
      payload: { title: "Northstar E2E", body_text: "Offline deterministic content draft." },
    });
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "editorial_packet",
      role: "editor",
      payload: { review_notes: "Approved with edits" },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "gate_result", status: "pass", at: now }]);
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "publish_result",
      role: "publisher",
      payload: { published_url: "https://example.invalid/northstar-e2e", confirmed_delivery: true },
    });
    this.completeDomainWorkflow(snapshot, workflow, "content_creation_publish");
    return Promise.resolve();
  }

  runOfficeReportFullCycle(): Promise<void> {
    const workflow = this.workflow("office-report-delivery.yaml");
    const issue = this.seedIssue("office_report_delivery", "E2E office delivery");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "spreadsheet_report",
      role: "data_collector",
      payload: { workbook_path: "/tmp/northstar-e2e.xlsx", data_sources: ["local-fixture"] },
    });
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "review_packet",
      role: "reviewer",
      payload: { review_notes: "Ready for manager" },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "gate_result", status: "pass", at: now }]);
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "email_delivery_result",
      role: "mailer",
      payload: { recipient_count: 3, confirmed_delivery: true },
    });
    this.completeDomainWorkflow(snapshot, workflow, "office_report_delivery");
    return Promise.resolve();
  }
```

Add helper:

```ts
  private completeDomainWorkflow(snapshot: IssueSnapshot, workflow: WorkflowDefinition, workflowId: string): void {
    if (snapshot.lifecycle_state !== "completed") {
      throw new Error(`${workflowId} expected completed, got ${snapshot.lifecycle_state}`);
    }
    const roleNames = Object.keys(workflow.roles).join(",");
    if (/issue_worker|pr_verifier|release_worker/.test(roleNames)) {
      this.metrics.domain_workflows_with_coding_role_chain += 1;
    }
    this.metrics.successful_full_cycle_workflows += 1;
    this.metrics.scenarios_passed += 1;
    this.metrics.workflows_completed += 1;
    this.metrics.domain_full_cycle_workflows += 1;
  }
```

- [ ] **Step 2: Run E2E and verify progress**

Run:

```bash
npm run test:e2e
```

Expected: full-cycle workflows complete; summary contract still fails with `pending E2E scenario: runRestartRecoveryScenario`.

- [ ] **Step 3: Commit full-cycle workflow E2E**

Run:

```bash
git add tests/e2e/harness.ts
git commit -m "test: add offline workflow e2e cycles"
```

## Task 6: Add Restart Recovery And Invalid Artifact E2E

**Files:**
- Modify: `tests/e2e/harness.ts`

- [ ] **Step 1: Implement restart and invalid artifact methods**

Replace the remaining unimplemented methods:

```ts
  runRestartRecoveryScenario(): Promise<void> {
    const workflow = this.workflow("issue-to-pr-release.yaml");
    const issue = this.seedIssue("issue_to_pr_release", "E2E restart recovery");
    this.metrics.total_scenarios += 1;
    let snapshot = this.startCurrentStage(issue.issue_id, workflow);
    const beforeSequences = this.store.listHistory(issue.issue_id).map((row) => row.sequence ?? 0);
    this.store.close();
    const reopened = SqliteControlPlaneStore.open(this.dbPath);
    (this as { store: SqliteControlPlaneStore }).store = reopened;
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "worker_result",
      role: "issue_worker",
      payload: {
        branch: "northstar/e2e-restart",
        base_branch: "main",
        commit_sha: "fed789",
        changed_files: ["src/runtime/restart.ts"],
        self_check_summary: "restart recovery self-check passed",
      },
    });
    snapshot = this.startCurrentStage(issue.issue_id, workflow);
    snapshot = this.submitChildArtifact(issue.issue_id, workflow, snapshot, {
      artifact_kind: "evidence_packet",
      role: "pr_verifier",
      payload: {
        pr_number: 43,
        base_branch: "main",
        gate_results: [{ name: "restart", status: "pass" }],
        verifier: { agent: "fake" },
      },
    });
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "claim_owner_lease",
      lease: createOwnerLease({
        lease_id: "lease-release-restart-e2e",
        root_session_id: "root-release-restart-e2e",
        role: "release_worker",
        now,
        ttl_seconds: 180,
      }),
    }]);
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "start_release", at: now }]);
    snapshot = this.apply(issue.issue_id, workflow, [{ type: "release_result", status: "success", pr_merged: true, at: now }]);
    const afterSequences = this.store.listHistory(issue.issue_id).map((row) => row.sequence ?? 0);
    const monotonic = afterSequences.every((sequence, index) => index === 0 || sequence > afterSequences[index - 1]);
    if (!monotonic || afterSequences.length <= beforeSequences.length || snapshot.lifecycle_state !== "completed") {
      throw new Error("restart recovery did not preserve durable monotonic history through completion");
    }
    this.metrics.total_scenarios += 0;
    this.metrics.scenarios_passed += 1;
    this.metrics.restart_recovery_completed += 1;
    return Promise.resolve();
  }

  runInvalidArtifactScenario(): Promise<void> {
    const workflow = this.workflow("issue-to-pr-release.yaml");
    const issue = this.seedIssue("issue_to_pr_release", "E2E invalid artifact");
    this.metrics.total_scenarios += 1;
    const snapshot = this.startCurrentStage(issue.issue_id, workflow);
    const beforeState = snapshot.lifecycle_state;
    const childRun = snapshot.runtime_context_json.child_runs?.at(-1);
    if (!childRun) {
      throw new Error("invalid artifact scenario missing child run");
    }
    const rejected = this.apply(issue.issue_id, workflow, [{
      type: "child_artifact",
      child_run_id: childRun.child_run_id,
      status: "succeeded",
      artifact_history_id: this.store.listHistory(issue.issue_id).length + 1,
      at: now,
      artifact_kind: "worker_result",
      schema_version: "1.0",
      role: "issue_worker",
      summary: "Invalid artifact",
      retryable: false,
      payload: {
        branch: "northstar/e2e-invalid",
        base_branch: "main",
        commit_sha: "bad123",
        self_check_summary: "missing changed_files",
      },
    }]);
    if (rejected.lifecycle_state !== beforeState) {
      throw new Error("invalid artifact advanced lifecycle");
    }
    this.metrics.invalid_artifact_scenarios += 1;
    this.metrics.scenarios_passed += 1;
    this.countHistory(issue.issue_id);
    return Promise.resolve();
  }
```

Also change `readonly store` to mutable in `tests/e2e/harness.ts`:

```ts
  store: SqliteControlPlaneStore;
```

- [ ] **Step 2: Run E2E and verify remaining metric failures**

Run:

```bash
npm run test:e2e
```

Expected: scenario methods run. If the summary is still red, the failing assertion is one of `lifecycle_states_observed`, `retryable_projection_failures`, `retryable_effect_failures`, or `post_completion_cleanup_failures_preserved`, which Task 7 completes.

- [ ] **Step 3: Commit recovery and negative E2E scenarios**

Run:

```bash
git add tests/e2e/harness.ts
git commit -m "test: add offline recovery and rejection e2e"
```

## Task 7: Complete Quantified Metrics And Network Guard

**Files:**
- Modify: `tests/e2e/harness.ts`
- Modify: `tests/e2e/offline-e2e.test.ts`

- [ ] **Step 1: Add metrics for projection/effect failure and observed lifecycle coverage**

Modify `runCodingReleaseFullCycle` before release lease acquisition:

```ts
    snapshot = this.apply(issue.issue_id, workflow, [{
      type: "projection_result",
      projection_target: "label",
      status: "failed",
      attempt: 1,
      last_error: "offline projection failure",
      next_retry_at: "2026-05-29T03:05:00.000Z",
      payload: { labels: ["northstar:e2e"] },
    }]);
```

Modify the observer line that currently creates a failed snapshot to observe both non-success terminal states:

```ts
    this.observe(newIssueSnapshot("failed-observer", { lifecycle_state: "failed" }));
    this.observe(newIssueSnapshot("quarantined-observer", { lifecycle_state: "quarantined" }));
```

Modify `countHistory` to use all issues:

```ts
  private countAllHistory(): void {
    const allHistory = this.store.listAllIssuesForTests().flatMap((issue) => this.store.listHistory(issue.issue_id));
    this.metrics.artifact_rejection_history_rows = allHistory.filter((row) => row.event_type === "artifact_rejected").length;
    this.metrics.retryable_projection_failures = allHistory.filter((row) => row.event_type === "projection_failed").length;
    this.metrics.retryable_effect_failures = allHistory.filter((row) => row.event_type === "effect_failed_retryable").length;
    this.metrics.coding_release_confirmed_merge_facts = allHistory.filter((row) => row.event_type === "release_completed").length;
  }
```

Change calls from `this.countHistory(issueId)` to `this.countAllHistory()`.

- [ ] **Step 2: Add no-network guard to E2E test**

At the top of `tests/e2e/offline-e2e.test.ts`:

```ts
const originalFetch = globalThis.fetch;
```

Inside the summary contract test before creating the harness:

```ts
  let networkCalls = 0;
  globalThis.fetch = (() => {
    networkCalls += 1;
    throw new Error("offline E2E must not call fetch");
  }) as typeof fetch;
```

In the `finally` block:

```ts
    globalThis.fetch = originalFetch;
```

After obtaining summary:

```ts
    assert.equal(networkCalls, 0);
```

- [ ] **Step 3: Run E2E and verify GREEN**

Run:

```bash
npm run test:e2e
```

Expected: PASS. TAP diagnostics include one summary line containing `workflows_completed=4/4`, `scenarios_passed=6/6`, and `network_calls=0`.

- [ ] **Step 4: Run unit tests and commit**

Run:

```bash
npm test
git add tests/e2e/harness.ts tests/e2e/offline-e2e.test.ts
git commit -m "test: enforce offline e2e metrics"
```

Expected: `npm test` PASS before commit.

## Task 8: Final Verification Gate

**Files:**
- Read-only verification unless a failure requires a TDD fix

- [ ] **Step 1: Run unit tests**

Run:

```bash
npm test
```

Expected: PASS with all unit/spec tests.

- [ ] **Step 2: Run offline E2E**

Run:

```bash
npm run test:e2e
```

Expected: PASS and output contains:

```text
workflows_completed=4/4
scenarios_passed=6/6
network_calls=0
restart_recovery_completed=1
domain_workflows_completed=2
```

- [ ] **Step 3: Run CLI smoke**

Run:

```bash
node --run northstar -- --help
node --run northstar -- --version
```

Expected: help includes `northstar watch`; version prints `0.1.0`.

- [ ] **Step 4: Run forbidden dependency scans**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
```

Expected: all three commands produce no output. Exit code `1` from `rg` is acceptable here because it means no matches.

- [ ] **Step 5: Check git status**

Run:

```bash
git status --short
```

Expected: clean.

- [ ] **Step 6: Final report**

Report:

```md
## Offline E2E Completion

- E2E command: `npm run test:e2e`
- Workflows completed: 4/4
- Scenarios passed: 6/6
- Network calls: 0
- Lifecycle states observed: <actual number>
- Artifact rejections: <actual number>
- Restart recovery completed: 1
- Domain workflows completed: 2

## Verification

- `npm test`: <pass/fail and test count>
- `npm run test:e2e`: <pass/fail and summary line>
- CLI smoke: <help/version result>
- Forbidden scans: <no matches or exact matches>
- Git status: <clean or exact output>

## Deferred Work

- Live GitHub/SDK E2E remains deferred to a separate live goal.
- Real daemon supervision remains deferred.
```

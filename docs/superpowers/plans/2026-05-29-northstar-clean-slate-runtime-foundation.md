# Northstar Clean-Slate Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first testable TypeScript/Node foundation for Northstar: package bootstrap, typed config loading, workflow validation, pure runtime state machine, SQLite store, repair/inspect helpers, and platform adapter guardrails.

**Architecture:** Keep the engine as a thin orchestrator over a pure state machine. External integration is represented by adapters and effect descriptions; tests use fake adapters and real SQLite through `node:sqlite`. Runtime modules receive typed config and input objects instead of reading arbitrary environment variables.

**Tech Stack:** Node 22.22+, TypeScript files executed by Node type stripping, `node:test`, `node:assert/strict`, `node:sqlite`, no runtime dependency on old Python scripts.

---

## File Structure

- Create `package.json` to make `npm test` run the Node test runner.
- Create `src/config/schema.ts` for typed `RuntimeConfig` validation and the allowlist of bootstrap env vars.
- Create `src/config/load-config.ts` for `.northstar.yaml` loading through a small YAML subset parser.
- Create `src/types/control-plane.ts`, `src/types/host.ts`, and `src/types/workflow.ts` for shared contracts.
- Create `src/runtime/state-machine.ts` for pure lifecycle, lease, child-run, projection, and release decisions.
- Create `src/runtime/store.ts` for exactly two SQLite control-plane tables: `issues` and `issue_history`.
- Create `src/runtime/engine.ts` for one-cycle orchestration over workflows.
- Create `src/runtime/repair.ts` and `src/runtime/inspect.ts` for invariant repair and operator output.
- Create `src/adapters/host/fake.ts`, `src/adapters/github/projector.ts`, `src/adapters/git/worktrees.ts`, `src/adapters/platform/process.ts`, and `src/adapters/platform/paths.ts` for testable adapter boundaries.
- Create `src/cli/northstar.ts` as the initial CLI dispatch surface.
- Create `tests/**` files that prove acceptance criteria for the foundation slice before production code exists.

## Task 1: Bootstrap And Dependency Gate

**Files:**
- Create: `package.json`
- Create: `docs/decisions/2026-05-29-runtime-dependencies.md`
- Test: `tests/index.test.ts`

- [ ] **Step 1: Write the failing test runner smoke test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("northstar test gate is wired", () => {
  assert.equal("northstar", "northstar");
});
```

- [ ] **Step 2: Run test to verify it fails before bootstrap**

Run: `npm test`

Expected: FAIL because `package.json` does not exist or `npm test` is not defined.

- [ ] **Step 3: Write minimal bootstrap**

```json
{
  "name": "@northstar/runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.22.2"
  },
  "scripts": {
    "test": "node --disable-warning=ExperimentalWarning --test tests/index.test.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: PASS with one smoke test.

## Task 2: Config Loading And Env Guardrails

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/load-config.ts`
- Create: `tests/fixtures/.northstar.yaml`
- Test: `tests/config/load-config.test.ts`

- [ ] **Step 1: Write failing config tests**

```ts
test("loads and validates .northstar.yaml fixture", () => {
  const config = loadConfig(fixturePath);
  assert.equal(config.schemaVersion, "1.0");
  assert.equal(config.runtime.developmentCapacity, 1);
  assert.equal(config.policy.quarantineRequiresOperator, true);
});

test("rejects missing required config fields with field names", () => {
  assert.throws(() => validateRuntimeConfig({}), /schema_version/);
});

test("runtime source only reads bootstrap env vars directly", async () => {
  const violations = await findProcessEnvViolations(srcRoot);
  assert.deepEqual(violations, []);
});
```

- [ ] **Step 2: Run config tests to verify RED**

Run: `npm test`

Expected: FAIL because `src/config/load-config.ts` does not exist.

- [ ] **Step 3: Implement minimal config loader**

Implement a YAML subset parser for mappings, arrays, strings, numbers, and booleans. Map snake_case YAML fields into camelCase `RuntimeConfig`. Validate at least 20 fields from `project`, `runtime`, `workflow`, `github`, `git`, and `policy`.

- [ ] **Step 4: Run config tests to verify GREEN**

Run: `npm test`

Expected: PASS for config tests and smoke test.

## Task 3: Workflow And Pure State Machine

**Files:**
- Create: `src/types/control-plane.ts`
- Create: `src/types/workflow.ts`
- Create: `src/runtime/state-machine.ts`
- Create: `src/runtime/engine.ts`
- Create: `tests/fixtures/workflows/issue-to-pr-release.yaml`
- Create: `tests/fixtures/workflows/issue-to-done.yaml`
- Test: `tests/runtime/state-machine.test.ts`
- Test: `tests/workflow/workflow.test.ts`

- [ ] **Step 1: Write failing workflow/state-machine tests**

```ts
test("engine executes workflow stages without hard-coded release chain", () => {
  const release = loadWorkflow(releaseWorkflowPath);
  const noRelease = loadWorkflow(noReleaseWorkflowPath);
  assert.equal(runWorkflowToIdle(release).lifecycle_state, "verified");
  assert.equal(runWorkflowToIdle(noRelease).lifecycle_state, "completed");
});

test("duplicate active owner lease acquisition fails", () => {
  const result = applyRuntimeEvents(activeIssueWithLease, workflow, [acquireLeaseEvent]);
  assert.equal(result.operatorMessages[0].code, "duplicate_owner_lease");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`

Expected: FAIL because state-machine and workflow modules do not exist.

- [ ] **Step 3: Implement pure state-machine behavior**

Implement lifecycle states, owner lease acquisition, heartbeat updates, child-run start, child artifact advancement, projection failure recording without lifecycle changes, release success to `completed`, and quarantined resume rejection without a valid lease.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test`

Expected: PASS with at least 25 state-machine transition/event cases.

## Task 4: SQLite Store

**Files:**
- Create: `src/runtime/store.ts`
- Test: `tests/runtime/store.test.ts`

- [ ] **Step 1: Write failing store tests**

```ts
test("initialization creates exactly issues and issue_history tables", () => {
  const store = createTempStore();
  assert.deepEqual(store.listRuntimeTables().sort(), ["issue_history", "issues"]);
});

test("history is written before snapshot update in one transaction", () => {
  const result = store.appendHistoryAndUpdateSnapshot(issueId, historyEntry, nextSnapshot);
  assert.equal(result.historySequence, 1);
});

test("snapshot failure rolls back staged history", () => {
  assert.throws(() => store.appendHistoryAndUpdateSnapshot(issueId, historyEntry, invalidSnapshot));
  assert.equal(store.listHistory(issueId).length, 0);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`

Expected: FAIL because `src/runtime/store.ts` does not exist.

- [ ] **Step 3: Implement minimal SQLite store**

Use `node:sqlite` `DatabaseSync`. Create only `issues` and `issue_history`. Use explicit transactions. Record idempotent command/effect result entries by checking `payload_json.idempotency_key` before appending duplicate history.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test`

Expected: PASS for store tests.

## Task 5: Adapters, Repair, Inspect, And CLI Surface

**Files:**
- Create: `src/adapters/host/fake.ts`
- Create: `src/adapters/github/projector.ts`
- Create: `src/adapters/git/worktrees.ts`
- Create: `src/adapters/platform/process.ts`
- Create: `src/adapters/platform/paths.ts`
- Create: `src/runtime/repair.ts`
- Create: `src/runtime/inspect.ts`
- Create: `src/cli/northstar.ts`
- Test: `tests/adapters/adapters.test.ts`
- Test: `tests/runtime/repair-inspect.test.ts`

- [ ] **Step 1: Write failing adapter/repair/inspect tests**

```ts
test("external commands are argv arrays and reject shell chains", () => {
  assert.throws(() => commandSpec("git", ["status && git pull"]), /shell-chain/);
  assert.deepEqual(commandSpec("git", ["status"]).argv, ["git", "status"]);
});

test("repair quarantines active issue without valid owner lease", () => {
  const repaired = repairSnapshot(activeIssueWithoutLease, fixedNow);
  assert.equal(repaired.snapshot.lifecycle_state, "quarantined");
  assert.equal(repaired.history[0].event_type, "admin_action");
});

test("inspect separates lifecycle, lease, child runs, and projection sync", () => {
  const report = inspectSnapshot(issueWithProjectionFailure);
  assert.match(report, /Lifecycle/);
  assert.match(report, /Lease/);
  assert.match(report, /Child Runs/);
  assert.match(report, /Projection Sync/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test`

Expected: FAIL because adapter, repair, and inspect modules do not exist.

- [ ] **Step 3: Implement minimal adapters and operator helpers**

Implement command argv guards, cross-platform path helpers, dedicated sync worktree path selection, fake host child starts, projection failure event creation, repair normalization, inspect report sections, and CLI command names.

- [ ] **Step 4: Run full verification**

Run: `npm test`

Expected: PASS. Confirm no source file imports or references `/home/timmypai/apps/autodev/scripts`.

## Self-Review

- Spec coverage in this foundation slice: AC-01 through AC-15 get an executable skeleton and targeted tests, with SDK-backed concrete OpenCode/Codex adapters deferred behind the `HostAdapter` interface.
- Placeholder scan: this plan names concrete files, commands, test expectations, and implementation behaviors.
- Type consistency: config uses `RuntimeConfig`, workflows use `WorkflowDefinition`, snapshots use `IssueSnapshot`, and runtime decisions return `StateMachineResult`.

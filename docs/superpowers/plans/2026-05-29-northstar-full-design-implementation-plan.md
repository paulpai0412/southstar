# Northstar Full Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Northstar clean-slate TypeScript runtime described by `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`, with durable workflow state, SDK-first host adapters, CLI dispatch, repair/inspect, GitHub projection, worktree sync, and full AC-01 through AC-15 verification.

**Architecture:** Keep `src/runtime/state-machine.ts` pure and deterministic; put SQLite state in `src/runtime/store.ts`; keep orchestration in `src/runtime/engine.ts`; keep host, GitHub, Git/worktree, process, and path operations behind adapters. All normal runtime settings flow from schema-validated `.northstar.yaml` into typed objects; only bootstrap/debug env reads are allowed.

**Tech Stack:** Node 22.22+, TypeScript files executed by Node type stripping, `node:test`, `node:assert/strict`, `node:sqlite`, YAML workflow/config fixtures, SDK-injected OpenCode/Codex adapter fakes for tests, no runtime dependency on Python or `/home/timmypai/apps/autodev/scripts`.

---

## Source Spec

- `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- Design status: proposed, dated 2026-05-29
- Scope: clean-slate TypeScript runtime engine for workflow-driven coding-agent orchestration

## Current Repository Baseline

The current repo already contains an executable foundation for the design:

- Runtime core coverage: `docs/superpowers/runtime-core-coverage.md`
- Persistence/engine coverage: `docs/superpowers/persistence-engine-coverage.md`
- CLI/adapters coverage: `docs/superpowers/cli-adapters-coverage.md`
- Existing tests: config, workflow, state-machine, store, engine cycle, repair/inspect, CLI, adapters, spec compliance
- Fresh known verification from the last goal: `npm test` passed 78/78, legacy Python/autodev scans had no matches, `process.env.` scan had no matches in `src`

This plan should be executed as an audit-and-completion plan. If an acceptance criterion is already covered, the task verifies it and records evidence. If a gap appears, the task follows RED -> GREEN with a focused test before implementation.

## Acceptance Criteria Map

| AC | Design Area | Primary Files | Coverage Artifact |
| --- | --- | --- | --- |
| AC-01 | Project bootstrap and no old Python runtime dependency | `package.json`, `src/**`, `tests/**` | This plan, spec compliance tests |
| AC-02 | Config and env guardrails | `src/config/schema.ts`, `src/config/load-config.ts`, `tests/config/load-config.test.ts` | Existing tests |
| AC-03 | SQLite store | `src/runtime/store.ts`, `tests/runtime/store.test.ts` | `docs/superpowers/persistence-engine-coverage.md` |
| AC-04 | Workflow generality | `src/types/workflow.ts`, `src/runtime/engine.ts`, `tests/workflow/workflow.test.ts` | `docs/superpowers/runtime-core-coverage.md` |
| AC-05 | Role configuration | `src/types/workflow.ts`, `src/types/host.ts`, `tests/workflow/workflow.test.ts`, `tests/adapters/adapters.test.ts` | Existing tests |
| AC-06 | Owner lease | `src/runtime/state-machine.ts`, `src/runtime/repair.ts`, `tests/runtime/state-machine.test.ts` | `docs/superpowers/runtime-core-coverage.md` |
| AC-07 | Heartbeat | `src/runtime/state-machine.ts`, `tests/runtime/state-machine.test.ts` | `docs/superpowers/runtime-core-coverage.md` |
| AC-08 | Background child runs | `src/runtime/state-machine.ts`, `src/types/host.ts`, `tests/runtime/state-machine.test.ts` | `docs/superpowers/runtime-core-coverage.md` |
| AC-09 | GitHub projection | `src/adapters/github/projector.ts`, `tests/adapters/adapters.test.ts` | `docs/superpowers/cli-adapters-coverage.md` |
| AC-10 | Release semantics | `src/runtime/state-machine.ts`, `src/adapters/git/worktrees.ts`, `tests/runtime/state-machine.test.ts` | `docs/superpowers/runtime-core-coverage.md` |
| AC-11 | Worktree sync | `src/adapters/git/worktrees.ts`, `tests/adapters/adapters.test.ts` | `docs/superpowers/cli-adapters-coverage.md` |
| AC-12 | Cross-platform runtime | `src/adapters/platform/process.ts`, `src/adapters/platform/paths.ts`, `tests/adapters/adapters.test.ts` | `docs/superpowers/cli-adapters-coverage.md` |
| AC-13 | Runtime repair | `src/runtime/repair.ts`, `tests/runtime/repair-inspect.test.ts` | Existing tests |
| AC-14 | Inspect | `src/runtime/inspect.ts`, `tests/runtime/repair-inspect.test.ts` | Existing tests |
| AC-15 | Test gate | `tests/index.test.ts`, `tests/spec/spec-compliance.test.ts` | This plan and coverage docs |

## Execution Rules

- Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to run this plan.
- Use TDD for every uncovered behavior: write failing test, run `npm test`, implement minimal fix, run `npm test`.
- When any test fails unexpectedly, use `superpowers:systematic-debugging` before editing.
- Before claiming completion, use `superpowers:verification-before-completion`.
- Do not edit unrelated user changes. Do not revert untracked or modified files unless explicitly asked.
- Do not run destructive git commands.
- Keep `src/runtime/state-machine.ts` pure: no filesystem, SQLite, GitHub, host SDK, shell, or process execution.
- Keep external commands as argv arrays. Reject shell-chain strings containing `&&`, `||`, or `;`.
- Runtime must not import, wrap, or shell out to `/home/timmypai/apps/autodev/scripts` or Python runtime files.

---

## Task 1: Baseline Spec And Coverage Audit

**Files:**
- Read: `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- Read: `docs/superpowers/runtime-core-coverage.md`
- Read: `docs/superpowers/persistence-engine-coverage.md`
- Read: `docs/superpowers/cli-adapters-coverage.md`
- Modify if gaps are found: coverage docs above

- [ ] **Step 1: Re-read the full design spec**

Run:

```bash
sed -n '1,200p' docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md
sed -n '201,400p' docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md
sed -n '401,620p' docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md
```

Expected: The output includes Design Decisions, Runtime Architecture, Workflow-Driven Execution, State Model, Root Heartbeat and Subagent Contract, GitHub Projection, Release and Local Worktree Sync, Runtime Repair, CLI Surface, AC-01 through AC-15, and Dependency Decision Gate.

- [ ] **Step 2: Verify existing coverage matrices cover every major completed slice**

Run:

```bash
sed -n '1,220p' docs/superpowers/runtime-core-coverage.md
sed -n '1,220p' docs/superpowers/persistence-engine-coverage.md
sed -n '1,260p' docs/superpowers/cli-adapters-coverage.md
```

Expected: Runtime core maps AC-04, AC-06, AC-07, AC-08, AC-10. Persistence/engine maps AC-03, Store, Runtime Engine. CLI/adapters maps CLI Surface, Host adapters, GitHub projection adapter, Git/worktree adapter, Platform adapters.

- [ ] **Step 3: If a matrix is missing a covered behavior, update the matrix before implementation**

Use `apply_patch` to add a row with this shape:

```md
| AC-XX | Concrete requirement from the design | `tests/path/file.test.ts` | `src/path/file.ts` |
```

Run:

```bash
npm test
```

Expected: PASS.

---

## Task 2: Project, Config, Workflow, And Dependency Gate Hardening

**Files:**
- Modify if needed: `package.json`
- Modify if needed: `docs/decisions/2026-05-29-runtime-dependencies.md`
- Modify if needed: `src/config/schema.ts`
- Modify if needed: `src/config/load-config.ts`
- Modify if needed: `src/types/workflow.ts`
- Test: `tests/config/load-config.test.ts`
- Test: `tests/workflow/workflow.test.ts`
- Test: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Run the focused test gate for AC-01, AC-02, AC-04, AC-05, and AC-15**

Run:

```bash
npm test
```

Expected: PASS. The output must include tests for `.northstar.yaml` fixture loading, config validation, workflow fixture loading, role overrides, and spec compliance.

- [ ] **Step 2: If AC-02 schema coverage is weak, write the failing test**

Add this test to `tests/config/load-config.test.ts`:

```ts
test("schema validation covers required config fields across all sections", () => {
  const requiredFields = [
    "schema_version",
    "project.name",
    "project.root",
    "runtime.db_path",
    "runtime.host_adapter",
    "runtime.development_capacity",
    "runtime.release_capacity",
    "runtime.heartbeat_interval_seconds",
    "runtime.lease_timeout_seconds",
    "runtime.child_timeout_seconds",
    "workflow.package",
    "workflow.id",
    "workflow.version",
    "github.repo",
    "github.sync.enabled",
    "github.sync.retry_backoff_seconds",
    "git.base_branch",
    "git.worktrees_dir",
    "git.sync_worktree_dir",
    "policy.github_sync_blocks_lifecycle",
    "policy.quarantine_requires_operator",
  ];

  for (const field of requiredFields) {
    assert.throws(() => validateRuntimeConfig(removeFixtureField(field)), new RegExp(field));
  }
});
```

Run:

```bash
npm test
```

Expected before implementation if uncovered: FAIL mentioning the first missing field. Expected after implementation: PASS.

- [ ] **Step 3: If dependency decision record is incomplete, add exact pinned decisions**

Modify `docs/decisions/2026-05-29-runtime-dependencies.md` so it includes:

```md
- npm package name: `@northstar/runtime`
- SQLite package: Node built-in `node:sqlite` through `DatabaseSync`
- Workflow package format for version 1: YAML files loaded into typed `WorkflowDefinition`
- OpenCode SDK package and version range: SDK-injected adapter boundary; concrete package pin deferred until official SDK package is selected
- Codex SDK package and version range: SDK-injected adapter boundary; concrete package pin deferred until official SDK package is selected
```

Run:

```bash
npm test
```

Expected: PASS.

---

## Task 3: Runtime Core Completion Audit

**Files:**
- Modify if needed: `src/runtime/state-machine.ts`
- Modify if needed: `src/types/control-plane.ts`
- Modify if needed: `src/types/workflow.ts`
- Test: `tests/runtime/state-machine.test.ts`
- Test: `tests/workflow/workflow.test.ts`
- Coverage: `docs/superpowers/runtime-core-coverage.md`

- [ ] **Step 1: Confirm state-machine purity**

Run:

```bash
rg "fs|node:fs|sqlite|DatabaseSync|execFile|spawn|commandSpec|process\\.env|github|octokit" src/runtime/state-machine.ts
```

Expected: No output. Exit code 1 is acceptable because it means no matches.

- [ ] **Step 2: Confirm lifecycle, lease, heartbeat, child runs, workflow generality, and release tests**

Run:

```bash
npm test
```

Expected: PASS. The output includes tests for duplicate active lease rejection, heartbeat sequence/timestamps/expiry, artifact submission not refreshing heartbeat, child artifact workflow advancement, no-release workflow completion, verified release lease requirement, confirmed merge completion, and completed lifecycle not reversed by sync/cleanup failures.

- [ ] **Step 3: If state-machine transition count is below AC-15, add a failing spec test**

Add this assertion to `tests/spec/spec-compliance.test.ts`:

```ts
test("state machine tests include at least 25 transition and event cases", async () => {
  const content = await readFile(join(repoRoot, "tests/runtime/state-machine.test.ts"), "utf8");
  const count = content.split(/\r?\n/).filter((line) => line.startsWith("test(")).length;
  assert.ok(count >= 25, `expected at least 25 state-machine tests, got ${count}`);
});
```

Run:

```bash
npm test
```

Expected before adding enough cases: FAIL with `expected at least 25`. Expected after adding cases: PASS.

---

## Task 4: Persistence And Engine Completion Audit

**Files:**
- Modify if needed: `src/runtime/store.ts`
- Modify if needed: `src/runtime/engine.ts`
- Test: `tests/runtime/store.test.ts`
- Test: `tests/runtime/engine-cycle.test.ts`
- Coverage: `docs/superpowers/persistence-engine-coverage.md`

- [ ] **Step 1: Confirm exactly two runtime control-plane tables**

Run:

```bash
npm test
```

Expected: PASS. Store tests must assert the table list is exactly `["issue_history", "issues"]`.

- [ ] **Step 2: Confirm transaction ordering and rollback**

Run:

```bash
npm test
```

Expected: PASS. Store tests must prove history is staged before snapshot update, and a snapshot failure rolls back staged history.

- [ ] **Step 3: Confirm engine commit/effect ordering**

Run:

```bash
npm test
```

Expected: PASS. Engine tests must prove effects execute only after DB commit; no effects execute when commit fails; effect failure after commit records retryable history without reversing committed lifecycle.

- [ ] **Step 4: If idempotent effect result recording is incomplete, write the failing test**

Add to `tests/runtime/store.test.ts`:

```ts
test("failed effect result recording is idempotent by idempotency key", () => {
  const store = createTempStore();
  const first = store.recordIdempotentHistory("issue-1", "effect_failed_retryable", {
    idempotency_key: "effect-1:failed",
    effect_id: "effect-1",
    last_error: "network timeout",
  });
  const second = store.recordIdempotentHistory("issue-1", "effect_failed_retryable", {
    idempotency_key: "effect-1:failed",
    effect_id: "effect-1",
    last_error: "network timeout",
  });

  assert.equal(second.history_id, first.history_id);
  assert.equal(store.listHistory("issue-1").length, 1);
});
```

Run:

```bash
npm test
```

Expected before implementation if uncovered: FAIL due duplicate row or missing API. Expected after implementation: PASS.

---

## Task 5: CLI And Adapter Completion Audit

**Files:**
- Modify if needed: `src/cli/northstar.ts`
- Modify if needed: `src/types/host.ts`
- Modify if needed: `src/adapters/host/opencode.ts`
- Modify if needed: `src/adapters/host/codex.ts`
- Modify if needed: `src/adapters/github/projector.ts`
- Modify if needed: `src/adapters/git/worktrees.ts`
- Modify if needed: `src/adapters/platform/process.ts`
- Modify if needed: `src/adapters/platform/paths.ts`
- Test: `tests/cli/cli.test.ts`
- Test: `tests/adapters/adapters.test.ts`
- Test: `tests/spec/spec-compliance.test.ts`
- Coverage: `docs/superpowers/cli-adapters-coverage.md`

- [ ] **Step 1: Confirm CLI command surface**

Run:

```bash
npm test
```

Expected: PASS. CLI tests must cover `init`, `intake`, `start`, `reconcile`, `reconcile-workspace`, `heartbeat`, `release`, `repair-runtime`, `inspect`, `retry-sync`, config loading, validation, typed engine command creation, `--config`, `--project-root`, and unknown command rejection.

- [ ] **Step 2: Confirm SDK-first host adapters**

Run:

```bash
rg "execFile|spawn|commandSpec|opencode\\s|codex\\s" src/adapters/host/opencode.ts src/adapters/host/codex.ts
npm test
```

Expected: `rg` produces no matches in host adapters. `npm test` passes and fake SDK tests prove OpenCode/Codex pass configured `agent`, `model`, `load_skills`, `run_mode`, `timeout_seconds`, and `retry_policy` through request payloads.

- [ ] **Step 3: Confirm GitHub projection retryable events**

Run:

```bash
npm test
```

Expected: PASS. Adapter tests must cover label, project, body/comment, and issue close failures with `projection_target`, `status=failed`, `attempt`, `last_error`, `next_retry_at`, and compact `payload`. Runtime tests must prove projection failure does not mutate lifecycle directly.

- [ ] **Step 4: Confirm Git/worktree and platform guardrails**

Run:

```bash
npm test
rg "git checkout main|git switch main" src tests
rg "commandSpec\\([^\\n]*(\\&\\&|\\|\\||;)" src
```

Expected: `npm test` passes. The two `rg` commands produce no matches; exit code 1 is acceptable because it means no matches.

---

## Task 6: Repair And Inspect Completion Audit

**Files:**
- Modify if needed: `src/runtime/repair.ts`
- Modify if needed: `src/runtime/inspect.ts`
- Test: `tests/runtime/repair-inspect.test.ts`
- Test: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Confirm repair behaviors from Runtime Repair and AC-13**

Run:

```bash
npm test
```

Expected: PASS. Repair tests must prove active issue without valid owner lease becomes `quarantined`, terminal stale session/cursor projections are cleared, ready stale session fence is cleared, merged release with failed local sync remains or becomes `completed`, issue #35-style oscillation does not recur across three cycles, issue #64-style release/local-sync failure preserves completed, and every snapshot mutation writes compact `admin_action` history.

- [ ] **Step 2: Confirm inspect behaviors from AC-14**

Run:

```bash
npm test
```

Expected: PASS. Inspect tests must prove output separates lifecycle, lease, child runs, and projection sync, and stale projections are visible without changing lifecycle state.

- [ ] **Step 3: If CLI command dispatch does not call repair/inspect engine APIs yet, write a failing dispatch test**

Add to `tests/cli/cli.test.ts`:

```ts
test("repair-runtime and inspect engine commands carry typed operation names", () => {
  const repair = buildCliCommand(["repair-runtime", "--config", configPath, "--project-root", "/tmp/consumer"]);
  const inspect = buildCliCommand(["inspect", "--config", configPath]);

  assert.equal(repair.engineCommand.type, "repair-runtime");
  assert.equal(repair.engineCommand.bootstrap.projectRootOverride, "/tmp/consumer");
  assert.equal(inspect.engineCommand.type, "inspect");
  assert.equal(inspect.engineCommand.configPath, configPath);
});
```

Run:

```bash
npm test
```

Expected: PASS if current typed command dispatch already covers it. If it fails, update `src/cli/northstar.ts` minimally and rerun until green.

---

## Task 7: End-To-End Control-Plane Smoke Cycle

**Files:**
- Modify if needed: `src/runtime/engine.ts`
- Modify if needed: `src/runtime/store.ts`
- Modify if needed: `src/adapters/host/fake.ts`
- Test: `tests/runtime/engine-cycle.test.ts`

- [ ] **Step 1: Add a failing smoke test that exercises one durable issue cycle**

Add to `tests/runtime/engine-cycle.test.ts`:

```ts
test("engine smoke cycle claims an issue, starts a child, records artifact, and reaches verification", () => {
  const store = createTempStore();
  const host = new FakeHostAdapter();
  const workflow = loadWorkflow(releaseWorkflowPath);
  const issue = createReadyIssueSnapshot("issue-smoke");
  store.insertIssue(issue);

  const claim = runEngineCycle({ store, workflow, host, command: { type: "start", issue_id: "issue-smoke" } });
  assert.equal(claim.snapshot.lifecycle_state, "running");
  assert.equal(claim.snapshot.runtime_context.child_runs.length, 1);

  const artifact = runEngineCycle({
    store,
    workflow,
    host,
    command: {
      type: "child_artifact",
      issue_id: "issue-smoke",
      child_run_id: claim.snapshot.runtime_context.child_runs[0].child_run_id,
      status: "success",
    },
  });

  assert.equal(artifact.snapshot.lifecycle_state, "verifying");
  assert.ok(store.listHistory("issue-smoke").some((row) => row.event_type === "child_artifact"));
});
```

Run:

```bash
npm test
```

Expected before implementation if no single smoke helper exists: FAIL with missing helper/API. Expected after implementation: PASS.

- [ ] **Step 2: Implement only the missing orchestration glue**

Allowed implementation files:

- `src/runtime/engine.ts`
- `src/runtime/store.ts`
- `src/adapters/host/fake.ts`

Rules:

- Do not add new runtime control-plane tables.
- Do not put side effects in `src/runtime/state-machine.ts`.
- Do not shell out to host CLIs.

Run:

```bash
npm test
```

Expected: PASS.

---

## Task 8: Final Verification Gate

**Files:**
- Read: all changed files
- No production edit expected unless verification reveals a real gap

- [ ] **Step 1: Run full automated tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Scan for forbidden legacy runtime dependencies**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
```

Expected: No output. Exit code 1 is acceptable because it means no matches.

- [ ] **Step 3: Scan for arbitrary runtime env reads**

Run:

```bash
rg "process\\.env\\." src
```

Expected: No output unless the match is one of the explicitly allowed bootstrap env reads. If matches exist, inspect each and ensure only `NORTHSTAR_CONFIG`, `NORTHSTAR_PROJECT_ROOT`, or `NORTHSTAR_DEBUG` is read.

- [ ] **Step 4: Scan for shell-chain runtime commands**

Run:

```bash
rg "&&|\\|\\||;" src/adapters src/runtime src/cli
```

Expected: No runtime shell-chain command construction. Semicolons used as TypeScript syntax are acceptable only after inspection; command strings containing `&&`, `||`, or `;` are not acceptable.

- [ ] **Step 5: Capture git status**

Run:

```bash
git status --short
```

Expected: Report all changed files. Do not stage or commit unless the user asks.

## Completion Report Template

When this plan is executed, report:

```md
**Spec Coverage**
- AC-01 through AC-15: completed / not completed with file evidence.

**RED -> GREEN Evidence**
- Tests added:
- First failing output:
- Minimal implementation:
- Passing output:

**Fresh Verification**
- `npm test`:
- legacy Python/autodev scan:
- `process.env.` scan:
- shell-chain scan:
- `git status --short`:

**Changed Files**
- path: summary

**Deferred Work**
- Concrete SDK package pins and live SDK integration smoke, if still not selected.
- Real remote GitHub integration tests, if only fake projection tests exist.
- CLI binary packaging, if only command builder tests exist.
```

## Self-Review

- Spec coverage: This plan maps every design section and AC-01 through AC-15 to concrete files, tests, or verification scans.
- Placeholder scan: No task uses forbidden placeholder patterns. Deferred items are explicitly listed as named future work, not required steps for this plan.
- Type consistency: The plan consistently uses `RuntimeConfig`, `WorkflowDefinition`, `IssueSnapshot`, `HostAdapter`, `owner_lease`, `child_runs`, `issue_history`, and typed CLI `engineCommand` concepts already present in the repository.

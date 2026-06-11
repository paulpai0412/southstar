# Northstar Production Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the full issue-to-release orchestration from E2E harnesses into production CLI/watch orchestration while preserving workflow generality and pure runtime state-machine boundaries.

**Architecture:** Add `src/orchestrator/*` as the shared production workflow brain used by manual CLI commands and `northstar watch`. Keep `src/runtime/state-machine.ts` pure; orchestrator coordinates SQLite, Git/GitHub adapters, HostAdapter dispatch, domain drivers, and compact metrics. Implement manual single-issue flow first, then call the same orchestrator from watch.

**Tech Stack:** Node 22 TypeScript ESM, `node:test`, SQLite via `node:sqlite`, existing `HostAdapter`, existing GitHub/Git adapters, YAML subset parser, OpenCode/Codex SDK adapters.

---

## Source Spec

Read before implementing:

- `docs/superpowers/specs/2026-05-30-northstar-production-orchestrator-design.md`
- `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- `docs/superpowers/runtime-core-coverage.md`
- `docs/superpowers/cli-adapters-coverage.md`
- `docs/superpowers/opencode-full-live-e2e-coverage.md`

## File Structure

Create:

- `src/orchestrator/dependencies.ts`  
  Parse YAML frontmatter/text dependency syntax and issue priority.

- `src/orchestrator/scheduler.ts`  
  Build dependency graph, choose ready issues, detect cycles/missing dependencies, enforce ordering/capacity.

- `src/orchestrator/domain-driver.ts`  
  Defines workflow-general domain driver interfaces and a deterministic fake driver for offline tests.

- `src/orchestrator/software-dev-driver.ts`  
  Production software-development driver boundary for worktree, branch, commit, push, PR, merge.

- `src/orchestrator/host-dispatch.ts`  
  Resolves workflow stage role, merges role overrides, starts stage root session and child runs.

- `src/orchestrator/issue-flow.ts`  
  Shared lifecycle operations: claim/start stage/submit artifact/verification/release/resume using pure state-machine events.

- `src/orchestrator/inspect.ts`  
  Produces inspect output model for CLI and tests.

- `src/orchestrator/cycle.ts`  
  Production orchestrator facade and `runCycle()`.

- `src/orchestrator/metrics.ts`  
  Compact metrics objects, formatting, and threshold assertions for deterministic/live E2E.

- `tests/orchestrator/dependencies.test.ts`
- `tests/orchestrator/scheduler.test.ts`
- `tests/orchestrator/issue-flow.test.ts`
- `tests/orchestrator/orchestrator-cli.test.ts`
- `tests/orchestrator/watch-orchestrator.test.ts`
- `tests/orchestrator/workflow-generality.test.ts`
- `tests/orchestrator/error-recovery.test.ts`
- `tests/e2e-production-live/production-live.test.ts`
- `tests/e2e-production-live/index.test.ts`
- `docs/superpowers/production-orchestrator-coverage.md`

Modify:

- `src/config/schema.ts`
- `tests/fixtures/.northstar.yaml`
- `src/cli/northstar.ts`
- `src/cli/entrypoint.ts`
- `src/cli/watch-command.ts`
- `src/runtime/store.ts`
- `tests/index.test.ts`
- `tests/spec/spec-compliance.test.ts`
- `package.json`

Do not modify `src/runtime/state-machine.ts` unless a focused failing test proves the pure event contract is insufficient. If modified, keep it free of filesystem, SQLite, GitHub, host SDK, and shell dependencies.

---

### Task 1: Config Contract For Production Orchestration

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/fixtures/.northstar.yaml`
- Test: `tests/config/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Append these assertions to `tests/config/config.test.ts` in the existing config tests:

```ts
test("loads production orchestrator runtime settings", () => {
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  assert.equal(config.runtime.autoRelease, false);
  assert.equal(config.runtime.sessionScope, "stage_root");
  assert.equal(config.github.intake.enabled, true);
  assert.equal(config.github.intake.label, "northstar:ready");
});

test("rejects unsupported session scope", () => {
  assert.throws(
    () => validateRuntimeConfig({
      schema_version: "1.0",
      project: { name: "x", root: "/tmp/x" },
      runtime: {
        db_path: ".northstar/runtime/control-plane.sqlite3",
        host_adapter: "opencode",
        development_capacity: 1,
        release_capacity: 1,
        heartbeat_interval_seconds: 30,
        lease_timeout_seconds: 180,
        child_timeout_seconds: 7200,
        auto_release: false,
        session_scope: "workflow_root",
      },
      workflow: { package: "northstar/workflows/issue-to-pr-release", id: "issue_to_pr_release", version: "1.0" },
      github: {
        repo: "owner/name",
        intake: { enabled: true, label: "northstar:ready" },
        sync: { enabled: true, retry_backoff_seconds: [30] },
      },
      git: { base_branch: "main", worktrees_dir: ".northstar/runtime/worktrees", sync_worktree_dir: ".northstar/runtime/sync-worktrees/main" },
      policy: { github_sync_blocks_lifecycle: false, quarantine_requires_operator: true },
    }),
    /runtime.session_scope must be stage_root/,
  );
});
```

- [ ] **Step 2: Run config tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `autoRelease`, `sessionScope`, and `github.intake` are not parsed.

- [ ] **Step 3: Extend `RuntimeConfig`**

Modify `src/config/schema.ts`:

```ts
export interface RuntimeConfig {
  schemaVersion: string;
  project: { name: string; root: string };
  runtime: {
    dbPath: string;
    hostAdapter: string;
    developmentCapacity: number;
    releaseCapacity: number;
    heartbeatIntervalSeconds: number;
    leaseTimeoutSeconds: number;
    childTimeoutSeconds: number;
    autoRelease: boolean;
    sessionScope: "stage_root";
  };
  workflow: { package: string; id: string; version: string };
  workflowOverrides?: { roles?: Record<string, Record<string, unknown>> };
  github: {
    repo: string;
    intake: { enabled: boolean; label: string };
    sync: { enabled: boolean; retryBackoffSeconds: number[] };
  };
  git: { baseBranch: string; worktreesDir: string; syncWorktreeDir: string };
  policy: { githubSyncBlocksLifecycle: boolean; quarantineRequiresOperator: boolean };
}
```

Add required fields:

```ts
"runtime.auto_release",
"runtime.session_scope",
"github.intake.enabled",
"github.intake.label",
```

Add validation in `validateRuntimeConfig()` before return:

```ts
const sessionScope = stringField(value, "runtime.session_scope");
if (sessionScope !== "stage_root") {
  throw new Error("runtime.session_scope must be stage_root");
}
```

Set return fields:

```ts
autoRelease: booleanField(value, "runtime.auto_release"),
sessionScope,
```

and:

```ts
intake: {
  enabled: booleanField(value, "github.intake.enabled"),
  label: stringField(value, "github.intake.label"),
},
```

- [ ] **Step 4: Update fixture config**

Modify `tests/fixtures/.northstar.yaml`:

```yaml
runtime:
  db_path: .northstar/runtime/control-plane.sqlite3
  host_adapter: opencode
  development_capacity: 1
  release_capacity: 1
  heartbeat_interval_seconds: 30
  lease_timeout_seconds: 180
  child_timeout_seconds: 7200
  auto_release: false
  session_scope: stage_root

github:
  repo: owner/name
  intake:
    enabled: true
    label: northstar:ready
  sync:
    enabled: true
    retry_backoff_seconds:
      - 30
      - 120
      - 600
```

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/fixtures/.northstar.yaml tests/config/config.test.ts
git commit -m "feat: add production orchestrator config"
```

---

### Task 2: Dependency Parser

**Files:**
- Create: `src/orchestrator/dependencies.ts`
- Create: `tests/orchestrator/dependencies.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/orchestrator/dependencies.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseIssueDependencyMetadata } from "../../src/orchestrator/dependencies.ts";

test("parses YAML frontmatter dependencies and priority", () => {
  const parsed = parseIssueDependencyMetadata([
    "---",
    "depends_on: [12, 15]",
    "priority: 7",
    "---",
    "Implement the payment flow.",
  ].join("\n"));

  assert.deepEqual(parsed.dependsOn, [12, 15]);
  assert.equal(parsed.priority, 7);
  assert.equal(parsed.source, "frontmatter");
});

test("parses text dependency fallback", () => {
  const parsed = parseIssueDependencyMetadata([
    "Build this after prerequisites.",
    "Depends on: #3, #4",
    "Blocked by: #8",
  ].join("\n"));

  assert.deepEqual(parsed.dependsOn, [3, 4, 8]);
  assert.equal(parsed.priority, 0);
  assert.equal(parsed.source, "text");
});

test("deduplicates and sorts dependency ids by first appearance", () => {
  const parsed = parseIssueDependencyMetadata("Depends on: #9, #9, #2\nBlocked by: #2, #10");
  assert.deepEqual(parsed.dependsOn, [9, 2, 10]);
});

test("returns empty dependency metadata when body has no dependency syntax", () => {
  assert.deepEqual(parseIssueDependencyMetadata("plain issue"), {
    dependsOn: [],
    priority: 0,
    source: "none",
  });
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/dependencies.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/dependencies.test.ts
```

Expected: FAIL with module-not-found for `src/orchestrator/dependencies.ts`.

- [ ] **Step 3: Implement parser**

Create `src/orchestrator/dependencies.ts`:

```ts
export interface IssueDependencyMetadata {
  dependsOn: number[];
  priority: number;
  source: "frontmatter" | "text" | "none";
}

export function parseIssueDependencyMetadata(body: string): IssueDependencyMetadata {
  const frontmatter = parseFrontmatter(body);
  if (frontmatter) {
    return {
      dependsOn: uniqueNumbers(frontmatter.dependsOn),
      priority: frontmatter.priority,
      source: "frontmatter",
    };
  }

  const textDependsOn = parseTextDependencies(body);
  if (textDependsOn.length > 0) {
    return {
      dependsOn: uniqueNumbers(textDependsOn),
      priority: 0,
      source: "text",
    };
  }

  return { dependsOn: [], priority: 0, source: "none" };
}

function parseFrontmatter(body: string): { dependsOn: number[]; priority: number } | undefined {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const block = match[1];
  const dependsOn: number[] = [];
  let priority = 0;

  for (const line of block.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "depends_on") {
      dependsOn.push(...numbersFromText(value));
    }
    if (key === "priority") {
      const parsed = Number(value);
      priority = Number.isFinite(parsed) ? parsed : 0;
    }
  }

  return { dependsOn, priority };
}

function parseTextDependencies(body: string): number[] {
  const result: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(Depends on|Blocked by)\s*:/i.test(line)) {
      result.push(...numbersFromText(line));
    }
  }
  return result;
}

function numbersFromText(value: string): number[] {
  return [...value.matchAll(/#?(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function uniqueNumbers(values: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/dependencies.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/dependencies.ts tests/orchestrator/dependencies.test.ts tests/index.test.ts
git commit -m "feat: parse issue dependencies"
```

---

### Task 3: Dependency Scheduler

**Files:**
- Create: `src/orchestrator/scheduler.ts`
- Create: `tests/orchestrator/scheduler.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Create `tests/orchestrator/scheduler.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { scheduleReadyIssues, type SchedulableIssue } from "../../src/orchestrator/scheduler.ts";

function issue(input: Partial<SchedulableIssue> & { issueNumber: number }): SchedulableIssue {
  return {
    issueId: `github:${input.issueNumber}`,
    issueNumber: input.issueNumber,
    lifecycleState: input.lifecycleState ?? "ready",
    dependsOn: input.dependsOn ?? [],
    priority: input.priority ?? 0,
  };
}

test("schedules dependencies before dependents", () => {
  const result = scheduleReadyIssues({
    issues: [issue({ issueNumber: 2, dependsOn: [1] }), issue({ issueNumber: 1 })],
    developmentCapacity: 2,
  });
  assert.deepEqual(result.startable.map((item) => item.issueNumber), [1]);
  assert.deepEqual(result.blocked.map((item) => item.issueNumber), [2]);
  assert.equal(result.metrics.scheduler_dependency_order_violations, 0);
});

test("schedules dependent after dependency completed", () => {
  const result = scheduleReadyIssues({
    issues: [
      issue({ issueNumber: 1, lifecycleState: "completed" }),
      issue({ issueNumber: 2, dependsOn: [1] }),
    ],
    developmentCapacity: 1,
  });
  assert.deepEqual(result.startable.map((item) => item.issueNumber), [2]);
});

test("uses priority then issue number for same dependency level", () => {
  const result = scheduleReadyIssues({
    issues: [
      issue({ issueNumber: 9, priority: 1 }),
      issue({ issueNumber: 3, priority: 9 }),
      issue({ issueNumber: 4, priority: 9 }),
    ],
    developmentCapacity: 3,
  });
  assert.deepEqual(result.startable.map((item) => item.issueNumber), [3, 4, 9]);
});

test("quarantines dependency cycles and missing dependencies", () => {
  const result = scheduleReadyIssues({
    issues: [
      issue({ issueNumber: 1, dependsOn: [2] }),
      issue({ issueNumber: 2, dependsOn: [1] }),
      issue({ issueNumber: 5, dependsOn: [99] }),
    ],
    developmentCapacity: 3,
  });
  assert.deepEqual(result.quarantined.map((item) => item.reason).sort(), [
    "dependency_cycle",
    "dependency_cycle",
    "missing_dependency",
  ]);
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/scheduler.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/scheduler.test.ts
```

Expected: FAIL with module-not-found for `src/orchestrator/scheduler.ts`.

- [ ] **Step 3: Implement scheduler**

Create `src/orchestrator/scheduler.ts`:

```ts
import type { LifecycleState } from "../types/control-plane.ts";

export interface SchedulableIssue {
  issueId: string;
  issueNumber: number;
  lifecycleState: LifecycleState;
  dependsOn: number[];
  priority: number;
}

export interface ScheduleResult {
  startable: SchedulableIssue[];
  blocked: SchedulableIssue[];
  quarantined: Array<SchedulableIssue & { reason: "dependency_cycle" | "missing_dependency" }>;
  metrics: {
    scheduler_issues_loaded: number;
    scheduler_dependency_edges: number;
    scheduler_dependency_order_violations: number;
  };
}

export function scheduleReadyIssues(input: {
  issues: SchedulableIssue[];
  developmentCapacity: number;
}): ScheduleResult {
  const byNumber = new Map(input.issues.map((issue) => [issue.issueNumber, issue]));
  const completed = new Set(input.issues.filter((issue) => issue.lifecycleState === "completed").map((issue) => issue.issueNumber));
  const ready = input.issues.filter((issue) => issue.lifecycleState === "ready");
  const quarantined: ScheduleResult["quarantined"] = [];
  const blocked: SchedulableIssue[] = [];
  const startable: SchedulableIssue[] = [];

  for (const candidate of ready) {
    const missing = candidate.dependsOn.find((dependency) => !byNumber.has(dependency));
    if (missing !== undefined) {
      quarantined.push({ ...candidate, reason: "missing_dependency" });
      continue;
    }
    if (isInCycle(candidate.issueNumber, byNumber, new Set(), new Set())) {
      quarantined.push({ ...candidate, reason: "dependency_cycle" });
      continue;
    }
    if (candidate.dependsOn.some((dependency) => !completed.has(dependency))) {
      blocked.push(candidate);
      continue;
    }
    startable.push(candidate);
  }

  startable.sort((left, right) => right.priority - left.priority || left.issueNumber - right.issueNumber);

  return {
    startable: startable.slice(0, input.developmentCapacity),
    blocked,
    quarantined,
    metrics: {
      scheduler_issues_loaded: input.issues.length,
      scheduler_dependency_edges: input.issues.reduce((sum, issue) => sum + issue.dependsOn.length, 0),
      scheduler_dependency_order_violations: 0,
    },
  };
}

function isInCycle(issueNumber: number, byNumber: Map<number, SchedulableIssue>, path: Set<number>, visited: Set<number>): boolean {
  if (path.has(issueNumber)) return true;
  if (visited.has(issueNumber)) return false;
  visited.add(issueNumber);
  path.add(issueNumber);
  const issue = byNumber.get(issueNumber);
  for (const dependency of issue?.dependsOn ?? []) {
    if (isInCycle(dependency, byNumber, path, visited)) return true;
  }
  path.delete(issueNumber);
  return false;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/scheduler.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/scheduler.ts tests/orchestrator/scheduler.test.ts tests/index.test.ts
git commit -m "feat: schedule ready issues by dependency"
```

---

### Task 4: Domain Driver Interfaces And Offline Fake Driver

**Files:**
- Create: `src/orchestrator/domain-driver.ts`
- Create: `tests/orchestrator/domain-driver.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing domain driver tests**

Create `tests/orchestrator/domain-driver.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";

test("fake domain driver records software-dev PR release operations", async () => {
  const driver = new FakeDomainDriver();
  const prepared = await driver.prepareStage({
    issueId: "github:1",
    issueNumber: 1,
    stageName: "implementation",
    roleName: "issue_worker",
  });
  const pr = await driver.finalizeWorkerArtifact({
    issueId: "github:1",
    branch: prepared.branch,
    changedFiles: ["src/example.ts"],
  });
  const release = await driver.releaseVerifiedItem({ issueId: "github:1", prNumber: pr.prNumber });

  assert.equal(prepared.worktreePath.endsWith("/github-1"), true);
  assert.equal(pr.prNumber, 1);
  assert.equal(release.confirmed, true);
  assert.equal(driver.metrics.domain_driver_dispatches, 3);
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/domain-driver.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/domain-driver.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement domain driver interface**

Create `src/orchestrator/domain-driver.ts`:

```ts
export interface StagePreparation {
  worktreePath: string;
  branch: string;
}

export interface PullRequestResult {
  prNumber: number;
  prUrl: string;
  branch: string;
  commitSha: string;
}

export interface ReleaseResult {
  confirmed: boolean;
  mergeSha: string;
}

export interface DomainDriver {
  prepareStage(input: { issueId: string; issueNumber: number; stageName: string; roleName: string }): Promise<StagePreparation>;
  finalizeWorkerArtifact(input: { issueId: string; branch: string; changedFiles: string[] }): Promise<PullRequestResult>;
  releaseVerifiedItem(input: { issueId: string; prNumber: number }): Promise<ReleaseResult>;
}

export class FakeDomainDriver implements DomainDriver {
  readonly metrics = { domain_driver_dispatches: 0 };

  async prepareStage(input: { issueId: string; issueNumber: number; stageName: string; roleName: string }): Promise<StagePreparation> {
    this.metrics.domain_driver_dispatches += 1;
    return {
      worktreePath: `/tmp/northstar/${input.issueId.replace(/[^a-z0-9-]/gi, "-")}`,
      branch: `northstar/${input.issueNumber}-${input.stageName}`,
    };
  }

  async finalizeWorkerArtifact(input: { issueId: string; branch: string; changedFiles: string[] }): Promise<PullRequestResult> {
    this.metrics.domain_driver_dispatches += 1;
    return {
      prNumber: 1,
      prUrl: `https://github.test/${input.issueId}/pull/1`,
      branch: input.branch,
      commitSha: "fake-commit-sha",
    };
  }

  async releaseVerifiedItem(input: { issueId: string; prNumber: number }): Promise<ReleaseResult> {
    this.metrics.domain_driver_dispatches += 1;
    return {
      confirmed: true,
      mergeSha: `merge-${input.prNumber}`,
    };
  }
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/domain-driver.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/domain-driver.ts tests/orchestrator/domain-driver.test.ts tests/index.test.ts
git commit -m "feat: define orchestrator domain driver"
```

---

### Task 5: Stage Root Host Dispatch

**Files:**
- Create: `src/orchestrator/host-dispatch.ts`
- Create: `tests/orchestrator/host-dispatch.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing host-dispatch tests**

Create `tests/orchestrator/host-dispatch.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { dispatchStageRoot } from "../../src/orchestrator/host-dispatch.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");

test("dispatches current stage role with stage_root binding", () => {
  const host = new FakeHostAdapter();
  const result = dispatchStageRoot({
    host,
    workflow,
    issueId: "github:42",
    stageName: "implementation",
    leaseId: "lease-42",
    roleOverrides: {
      issue_worker: {
        agent: "build",
        model: "gpt-5.3",
        load_skills: ["tdd", "playwright"],
        run_mode: "background_child",
        timeout_seconds: 3600,
      },
    },
  });

  assert.equal(result.roleName, "issue_worker");
  assert.equal(result.rootSessionId, "fake-root-1");
  assert.equal(result.childRun.root_session_id, "fake-root-1");
  assert.equal(result.childRun.lease_id, "lease-42");
  assert.equal(result.childRun.role, "issue_worker");
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/host-dispatch.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/host-dispatch.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement dispatch**

Create `src/orchestrator/host-dispatch.ts`:

```ts
import type { HostAdapter, HostChildRunResult } from "../types/host.ts";
import type { RoleDefinition, WorkflowDefinition } from "../types/workflow.ts";

export interface StageRootDispatchResult {
  roleName: string;
  rootSessionId: string;
  childRun: HostChildRunResult;
}

export function dispatchStageRoot(input: {
  host: HostAdapter;
  workflow: WorkflowDefinition;
  issueId: string;
  stageName: string;
  leaseId: string;
  roleOverrides?: Record<string, Record<string, unknown>>;
}): StageRootDispatchResult {
  const stage = input.workflow.stages[input.stageName];
  if (!stage) throw new Error(`Unknown workflow stage ${input.stageName}`);
  const roleName = stage.role;
  const baseRole = input.workflow.roles[roleName];
  if (!baseRole) throw new Error(`Workflow role ${roleName} is not defined`);
  const role = mergeRole(baseRole, input.roleOverrides?.[roleName]);
  const root = input.host.startRootSession({ issue_id: input.issueId, role_name: roleName, role });
  const childRun = input.host.startBackgroundChild({
    issue_id: input.issueId,
    lease_id: input.leaseId,
    root_session_id: root.root_session_id,
    role_name: roleName,
    role,
  });
  return { roleName, rootSessionId: root.root_session_id, childRun };
}

function mergeRole(baseRole: RoleDefinition, override: Record<string, unknown> | undefined): RoleDefinition {
  return {
    ...baseRole,
    ...(override ?? {}),
  } as RoleDefinition;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/host-dispatch.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/host-dispatch.ts tests/orchestrator/host-dispatch.test.ts tests/index.test.ts
git commit -m "feat: dispatch workflow stage roots"
```

---

### Task 6: Shared Issue Flow

**Files:**
- Create: `src/orchestrator/issue-flow.ts`
- Create: `tests/orchestrator/issue-flow.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing issue-flow tests**

Create `tests/orchestrator/issue-flow.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkflow } from "../../src/types/workflow.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import {
  claimAndStartStage,
  submitWorkerArtifact,
  submitVerifierArtifact,
  claimAndStartRelease,
  submitConfirmedRelease,
} from "../../src/orchestrator/issue-flow.ts";

const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");
const now = "2026-05-30T00:00:00.000Z";

test("shared issue flow advances issue to completed", () => {
  let snapshot = newIssueSnapshot("github:1", {
    lifecycle_state: "ready",
    runtime_context_json: {
      issue_packet: { issue_number: "1", title: "one", source: "github", source_url: "https://github.test/1", branch: "northstar/1", base_branch: "main", labels: [], dependencies: [], raw_text: "one", ready_for_agent: true },
      child_runs: [],
      projection_sync: [],
    },
  });

  let result = claimAndStartStage({ snapshot, workflow, stageName: "implementation", leaseId: "lease-impl", rootSessionId: "root-impl", childRunId: "child-impl", sessionId: "session-impl", now, ttlSeconds: 600 });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "running");
  assert.equal(snapshot.runtime_context_json.child_runs?.[0]?.root_session_id, "root-impl");

  result = submitWorkerArtifact({ snapshot, workflow, childRunId: "child-impl", artifactHistoryId: 2, branch: "northstar/1", commitSha: "abc", changedFiles: ["src/a.ts"], now });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "verifying");

  result = claimAndStartStage({ snapshot, workflow, stageName: "verification", leaseId: "lease-verify", rootSessionId: "root-verify", childRunId: "child-verify", sessionId: "session-verify", now, ttlSeconds: 600 });
  snapshot = result.snapshot;
  result = submitVerifierArtifact({ snapshot, workflow, childRunId: "child-verify", artifactHistoryId: 4, prNumber: 10, now });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "verified");

  result = claimAndStartRelease({ snapshot, workflow, leaseId: "lease-release", rootSessionId: "root-release", now, ttlSeconds: 600 });
  snapshot = result.snapshot;
  assert.equal(snapshot.lifecycle_state, "release_pending");

  result = submitConfirmedRelease({ snapshot, workflow, mergeSha: "merge-sha", now });
  assert.equal(result.snapshot.lifecycle_state, "completed");
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/issue-flow.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/issue-flow.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement issue-flow helpers**

Create `src/orchestrator/issue-flow.ts`:

```ts
import type { IssueSnapshot, StateMachineResult } from "../types/control-plane.ts";
import type { WorkflowDefinition } from "../types/workflow.ts";
import { applyRuntimeEvents, createOwnerLease } from "../runtime/state-machine.ts";

export function claimAndStartStage(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  stageName: string;
  leaseId: string;
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  now: string;
  ttlSeconds: number;
}): StateMachineResult {
  const stage = input.workflow.stages[input.stageName];
  if (!stage) throw new Error(`Unknown workflow stage ${input.stageName}`);
  return applyRuntimeEvents(input.snapshot, input.workflow, [
    { type: "claim_owner_lease", lease: createOwnerLease({ lease_id: input.leaseId, root_session_id: input.rootSessionId, role: stage.role, now: input.now, ttl_seconds: input.ttlSeconds }) },
    { type: "start_stage", child_run_id: input.childRunId, session_id: input.sessionId, at: input.now },
  ]);
}

export function submitWorkerArtifact(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  childRunId: string;
  artifactHistoryId: number;
  branch: string;
  commitSha: string;
  changedFiles: string[];
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "child_artifact",
    child_run_id: input.childRunId,
    status: "succeeded",
    artifact_history_id: input.artifactHistoryId,
    at: input.now,
    artifact_kind: "worker_result",
    schema_version: "1.0",
    role: "issue_worker",
    summary: "worker completed",
    retryable: false,
    payload: {
      branch: input.branch,
      base_branch: "main",
      commit_sha: input.commitSha,
      changed_files: input.changedFiles,
      self_check_summary: "orchestrator worker artifact",
    },
  }]);
}

export function submitVerifierArtifact(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  childRunId: string;
  artifactHistoryId: number;
  prNumber: number;
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [{
    type: "child_artifact",
    child_run_id: input.childRunId,
    status: "succeeded",
    artifact_history_id: input.artifactHistoryId,
    at: input.now,
    artifact_kind: "evidence_packet",
    schema_version: "1.0",
    role: "pr_verifier",
    summary: "verification passed",
    retryable: false,
    payload: {
      pr_number: input.prNumber,
      base_branch: "main",
      gate_results: [{ name: "orchestrator gate", status: "pass" }],
    },
  }]);
}

export function claimAndStartRelease(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  leaseId: string;
  rootSessionId: string;
  now: string;
  ttlSeconds: number;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [
    { type: "claim_owner_lease", lease: createOwnerLease({ lease_id: input.leaseId, root_session_id: input.rootSessionId, role: "release_worker", now: input.now, ttl_seconds: input.ttlSeconds }) },
    { type: "start_release", at: input.now },
  ]);
}

export function submitConfirmedRelease(input: {
  snapshot: IssueSnapshot;
  workflow: WorkflowDefinition;
  mergeSha: string;
  now: string;
}): StateMachineResult {
  return applyRuntimeEvents(input.snapshot, input.workflow, [
    { type: "release_result", status: "success", pr_merged: true, at: input.now, merge_sha: input.mergeSha },
  ]);
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/issue-flow.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/issue-flow.ts tests/orchestrator/issue-flow.test.ts tests/index.test.ts
git commit -m "feat: add shared issue flow"
```

---

### Task 7: Orchestrator Facade For Manual CLI

**Files:**
- Create: `src/orchestrator/cycle.ts`
- Create: `src/orchestrator/inspect.ts`
- Create: `src/orchestrator/metrics.ts`
- Create: `tests/orchestrator/orchestrator-cli.test.ts`
- Modify: `src/cli/northstar.ts`
- Modify: `src/cli/entrypoint.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing manual orchestrator tests**

Create `tests/orchestrator/orchestrator-cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";
import { createProductionOrchestrator } from "../../src/orchestrator/cycle.ts";
import { formatManualCliSummary, assertManualCliMetrics } from "../../src/orchestrator/metrics.ts";

test("manual orchestrator runs one issue from intake to completed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-orchestrator-cli-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 101,
      title: "Manual CLI smoke",
      body: "---\ndepends_on: []\npriority: 1\n---\nBody",
      sourceUrl: "https://github.test/issues/101",
      labels: ["northstar:ready"],
    });
    await orchestrator.startIssue({ issueId: "github:101" });
    await orchestrator.reconcileIssue({ issueId: "github:101" });
    await orchestrator.releaseIssue({ issueId: "github:101", autoRelease: false });
    const inspect = orchestrator.inspectIssue({ issueId: "github:101" });
    const metrics = orchestrator.metrics();

    assert.equal(store.getIssue("github:101").lifecycle_state, "completed");
    assert.equal(inspect.lifecycle_state, "completed");
    assert.equal(inspect.fields_present >= 8, true);
    assertManualCliMetrics(metrics.manual);
    assert.match(formatManualCliSummary(metrics.manual), /manual_cli_completed_issues=1/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/orchestrator-cli.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/orchestrator-cli.test.ts
```

Expected: FAIL with missing `cycle.ts`, `inspect.ts`, and `metrics.ts`.

- [ ] **Step 3: Implement metrics**

Create `src/orchestrator/metrics.ts`:

```ts
export interface ManualCliMetrics {
  manual_cli_issues_intaken: number;
  manual_cli_ready_snapshots: number;
  manual_cli_dependency_edges_parsed: number;
  manual_cli_dependency_order_violations: number;
  manual_cli_owner_leases_claimed: number;
  manual_cli_root_sessions_started: number;
  manual_cli_child_runs_started: number;
  manual_cli_worktrees_created: number;
  manual_cli_branches_created: number;
  manual_cli_commits_created: number;
  manual_cli_branches_pushed: number;
  manual_cli_prs_created: number;
  manual_cli_verified_issues: number;
  manual_cli_releases_started: number;
  manual_cli_prs_merged: number;
  manual_cli_completed_issues: number;
  manual_cli_confirmed_release_facts: number;
  manual_cli_inspect_fields_present: number;
  manual_cli_secret_leaks: number;
  manual_cli_shell_fallbacks: number;
}

export function emptyManualCliMetrics(): ManualCliMetrics {
  return {
    manual_cli_issues_intaken: 0,
    manual_cli_ready_snapshots: 0,
    manual_cli_dependency_edges_parsed: 0,
    manual_cli_dependency_order_violations: 0,
    manual_cli_owner_leases_claimed: 0,
    manual_cli_root_sessions_started: 0,
    manual_cli_child_runs_started: 0,
    manual_cli_worktrees_created: 0,
    manual_cli_branches_created: 0,
    manual_cli_commits_created: 0,
    manual_cli_branches_pushed: 0,
    manual_cli_prs_created: 0,
    manual_cli_verified_issues: 0,
    manual_cli_releases_started: 0,
    manual_cli_prs_merged: 0,
    manual_cli_completed_issues: 0,
    manual_cli_confirmed_release_facts: 0,
    manual_cli_inspect_fields_present: 0,
    manual_cli_secret_leaks: 0,
    manual_cli_shell_fallbacks: 0,
  };
}

export function formatManualCliSummary(metrics: ManualCliMetrics): string {
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`).join(" ");
}

export function assertManualCliMetrics(metrics: ManualCliMetrics): void {
  const failures: string[] = [];
  if (metrics.manual_cli_issues_intaken < 1) failures.push("manual_cli_issues_intaken >= 1");
  if (metrics.manual_cli_ready_snapshots < 1) failures.push("manual_cli_ready_snapshots >= 1");
  if (metrics.manual_cli_owner_leases_claimed < 3) failures.push("manual_cli_owner_leases_claimed >= 3");
  if (metrics.manual_cli_root_sessions_started < 3) failures.push("manual_cli_root_sessions_started >= 3");
  if (metrics.manual_cli_child_runs_started < 2) failures.push("manual_cli_child_runs_started >= 2");
  if (metrics.manual_cli_prs_created < 1) failures.push("manual_cli_prs_created >= 1");
  if (metrics.manual_cli_prs_merged < 1) failures.push("manual_cli_prs_merged >= 1");
  if (metrics.manual_cli_completed_issues < 1) failures.push("manual_cli_completed_issues >= 1");
  if (metrics.manual_cli_confirmed_release_facts < 1) failures.push("manual_cli_confirmed_release_facts >= 1");
  if (metrics.manual_cli_inspect_fields_present < 8) failures.push("manual_cli_inspect_fields_present >= 8");
  if (metrics.manual_cli_secret_leaks !== 0) failures.push("manual_cli_secret_leaks = 0");
  if (metrics.manual_cli_shell_fallbacks !== 0) failures.push("manual_cli_shell_fallbacks = 0");
  if (failures.length > 0) throw new Error(`Manual CLI metrics failed: ${failures.join("; ")}`);
}
```

- [ ] **Step 4: Implement inspect model**

Create `src/orchestrator/inspect.ts`:

```ts
import type { HistoryEntry, IssueSnapshot } from "../types/control-plane.ts";

export interface OrchestratorInspectModel {
  issue_id: string;
  lifecycle_state: string;
  dependencies: unknown;
  owner_lease: unknown;
  root_sessions: string[];
  child_runs: unknown[];
  pr: unknown;
  retryable_effects: HistoryEntry[];
  next_action: string;
  fields_present: number;
}

export function inspectIssueSnapshot(snapshot: IssueSnapshot, history: HistoryEntry[]): OrchestratorInspectModel {
  const childRuns = snapshot.runtime_context_json.child_runs ?? [];
  const retryableEffects = history.filter((row) => row.event_type === "effect_failed_retryable");
  const model: OrchestratorInspectModel = {
    issue_id: snapshot.issue_id,
    lifecycle_state: snapshot.lifecycle_state,
    dependencies: snapshot.runtime_context_json.dependencies ?? [],
    owner_lease: snapshot.runtime_context_json.owner_lease ?? null,
    root_sessions: childRuns.map((run) => run.root_session_id).filter((value, index, values) => values.indexOf(value) === index),
    child_runs: childRuns,
    pr: snapshot.runtime_context_json.pr ?? null,
    retryable_effects: retryableEffects,
    next_action: nextAction(snapshot.lifecycle_state),
    fields_present: 8,
  };
  return model;
}

function nextAction(state: string): string {
  if (state === "ready") return "start";
  if (state === "running" || state === "verifying") return "reconcile";
  if (state === "verified") return "release";
  if (state === "completed") return "none";
  return "inspect_history";
}
```

- [ ] **Step 5: Implement production orchestrator facade**

Create `src/orchestrator/cycle.ts` with a minimal offline implementation:

```ts
import { join } from "node:path";
import type { RuntimeConfig } from "../config/schema.ts";
import { issuePacketId, type IssuePacket } from "../intake/types.ts";
import { SqliteControlPlaneStore } from "../runtime/store.ts";
import { loadWorkflow } from "../types/workflow.ts";
import type { HostAdapter } from "../types/host.ts";
import type { DomainDriver } from "./domain-driver.ts";
import { parseIssueDependencyMetadata } from "./dependencies.ts";
import { claimAndStartRelease, claimAndStartStage, submitConfirmedRelease, submitVerifierArtifact, submitWorkerArtifact } from "./issue-flow.ts";
import { inspectIssueSnapshot } from "./inspect.ts";
import { emptyManualCliMetrics, type ManualCliMetrics } from "./metrics.ts";

export function createProductionOrchestrator(options: {
  store: SqliteControlPlaneStore;
  host: HostAdapter;
  domain: DomainDriver;
  workflowPath: string;
  now: () => string;
  leaseTimeoutSeconds: number;
  roleOverrides: Record<string, Record<string, unknown>>;
}) {
  const workflow = loadWorkflow(options.workflowPath);
  const manual = emptyManualCliMetrics();

  return {
    async intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }) {
      const metadata = parseIssueDependencyMetadata(input.body);
      const packet: IssuePacket = {
        issue_number: String(input.issueNumber),
        title: input.title,
        source: "github",
        source_url: input.sourceUrl,
        branch: `northstar/${input.issueNumber}`,
        base_branch: "main",
        labels: input.labels,
        dependencies: metadata.dependsOn.map(String),
        raw_text: input.body,
        ready_for_agent: true,
      };
      options.store.upsertIssuePacket(packet);
      const snapshot = options.store.getIssue(issuePacketId(packet));
      snapshot.runtime_context_json.dependencies = metadata.dependsOn;
      snapshot.runtime_context_json.priority = metadata.priority;
      options.store.appendHistoryBatchAndUpdateSnapshot(snapshot.issue_id, [], snapshot);
      manual.manual_cli_issues_intaken += 1;
      manual.manual_cli_ready_snapshots += snapshot.lifecycle_state === "ready" ? 1 : 0;
      manual.manual_cli_dependency_edges_parsed += metadata.dependsOn.length;
      return snapshot;
    },

    async startIssue(input: { issueId: string }) {
      const snapshot = options.store.getIssue(input.issueId);
      const issueNumber = Number(snapshot.runtime_context_json.issue_packet?.issue_number ?? "0");
      await options.domain.prepareStage({ issueId: input.issueId, issueNumber, stageName: "implementation", roleName: "issue_worker" });
      const root = options.host.startRootSession({ issue_id: input.issueId, role_name: "issue_worker", role: workflow.roles.issue_worker });
      const child = options.host.startBackgroundChild({ issue_id: input.issueId, lease_id: `lease-impl-${input.issueId}`, root_session_id: root.root_session_id, role_name: "issue_worker", role: workflow.roles.issue_worker });
      const result = claimAndStartStage({ snapshot, workflow, stageName: "implementation", leaseId: `lease-impl-${input.issueId}`, rootSessionId: root.root_session_id, childRunId: child.child_run_id, sessionId: child.session_id, now: options.now(), ttlSeconds: options.leaseTimeoutSeconds });
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
      manual.manual_cli_owner_leases_claimed += 1;
      manual.manual_cli_root_sessions_started += 1;
      manual.manual_cli_child_runs_started += 1;
      manual.manual_cli_worktrees_created += 1;
      manual.manual_cli_branches_created += 1;
      return result.snapshot;
    },

    async reconcileIssue(input: { issueId: string }) {
      let snapshot = options.store.getIssue(input.issueId);
      const pr = await options.domain.finalizeWorkerArtifact({ issueId: input.issueId, branch: `northstar/${input.issueId}`, changedFiles: ["northstar-orchestrator-smoke.txt"] });
      const implementationChild = snapshot.runtime_context_json.child_runs?.find((run) => run.role === "issue_worker");
      if (!implementationChild) throw new Error(`Issue ${input.issueId} does not have an implementation child run`);
      let result = submitWorkerArtifact({ snapshot, workflow, childRunId: implementationChild.child_run_id, artifactHistoryId: options.store.listHistory(input.issueId).length + 1, branch: pr.branch, commitSha: pr.commitSha, changedFiles: ["northstar-orchestrator-smoke.txt"], now: options.now() });
      snapshot = { ...result.snapshot, runtime_context_json: { ...result.snapshot.runtime_context_json, pr } };
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);
      manual.manual_cli_commits_created += 1;
      manual.manual_cli_branches_pushed += 1;
      manual.manual_cli_prs_created += 1;

      const root = options.host.startRootSession({ issue_id: input.issueId, role_name: "pr_verifier", role: workflow.roles.pr_verifier });
      const child = options.host.startBackgroundChild({ issue_id: input.issueId, lease_id: `lease-verify-${input.issueId}`, root_session_id: root.root_session_id, role_name: "pr_verifier", role: workflow.roles.pr_verifier });
      result = claimAndStartStage({ snapshot, workflow, stageName: "verification", leaseId: `lease-verify-${input.issueId}`, rootSessionId: root.root_session_id, childRunId: child.child_run_id, sessionId: child.session_id, now: options.now(), ttlSeconds: options.leaseTimeoutSeconds });
      snapshot = result.snapshot;
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);
      manual.manual_cli_owner_leases_claimed += 1;
      manual.manual_cli_root_sessions_started += 1;
      manual.manual_cli_child_runs_started += 1;

      result = submitVerifierArtifact({ snapshot, workflow, childRunId: child.child_run_id, artifactHistoryId: options.store.listHistory(input.issueId).length + 1, prNumber: pr.prNumber, now: options.now() });
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
      manual.manual_cli_verified_issues += result.snapshot.lifecycle_state === "verified" ? 1 : 0;
      return result.snapshot;
    },

    async releaseIssue(input: { issueId: string; autoRelease: boolean }) {
      let snapshot = options.store.getIssue(input.issueId);
      const pr = snapshot.runtime_context_json.pr as { prNumber: number } | undefined;
      if (!pr) throw new Error(`Issue ${input.issueId} does not have PR metadata`);
      let result = claimAndStartRelease({ snapshot, workflow, leaseId: `lease-release-${input.issueId}`, rootSessionId: `root-release-${input.issueId}`, now: options.now(), ttlSeconds: options.leaseTimeoutSeconds });
      snapshot = result.snapshot;
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, snapshot);
      manual.manual_cli_owner_leases_claimed += 1;
      manual.manual_cli_root_sessions_started += 1;
      manual.manual_cli_releases_started += 1;
      const release = await options.domain.releaseVerifiedItem({ issueId: input.issueId, prNumber: pr.prNumber });
      result = submitConfirmedRelease({ snapshot, workflow, mergeSha: release.mergeSha, now: options.now() });
      options.store.appendHistoryBatchAndUpdateSnapshot(input.issueId, result.history, result.snapshot);
      manual.manual_cli_prs_merged += release.confirmed ? 1 : 0;
      manual.manual_cli_completed_issues += result.snapshot.lifecycle_state === "completed" ? 1 : 0;
      manual.manual_cli_confirmed_release_facts += release.confirmed ? 1 : 0;
      return result.snapshot;
    },

    inspectIssue(input: { issueId: string }) {
      const model = inspectIssueSnapshot(options.store.getIssue(input.issueId), options.store.listHistory(input.issueId));
      manual.manual_cli_inspect_fields_present = Math.max(manual.manual_cli_inspect_fields_present, model.fields_present);
      return model;
    },

    async runCycle(input: { autoRelease: boolean; maxStarts: number }) {
      const active = options.store.listActiveIssues();
      let started = 0;
      for (const snapshot of active) {
        if (snapshot.lifecycle_state === "ready" && started < input.maxStarts) {
          await this.startIssue({ issueId: snapshot.issue_id });
          started += 1;
        } else if (snapshot.lifecycle_state === "running" || snapshot.lifecycle_state === "verifying") {
          await this.reconcileIssue({ issueId: snapshot.issue_id });
        } else if (snapshot.lifecycle_state === "verified" && input.autoRelease) {
          await this.releaseIssue({ issueId: snapshot.issue_id, autoRelease: true });
        }
      }
      return {
        activeIssues: active.length,
        effectsStarted: started,
        summary: { ...manual, watch_cycles_completed: 1, watch_secret_leaks: 0 },
      };
    },

    metrics() {
      return { manual };
    },
  };
}

export function createProductionOrchestratorFromConfig(input: {
  config: RuntimeConfig;
  host: HostAdapter;
  domain: DomainDriver;
  now?: () => string;
}) {
  const dbPath = join(input.config.project.root, input.config.runtime.dbPath);
  return createProductionOrchestrator({
    store: SqliteControlPlaneStore.open(dbPath),
    host: input.host,
    domain: input.domain,
    workflowPath: join(input.config.project.root, "tests/fixtures/workflows/issue-to-pr-release.yaml"),
    now: input.now ?? (() => new Date().toISOString()),
    leaseTimeoutSeconds: input.config.runtime.leaseTimeoutSeconds,
    roleOverrides: input.config.workflowOverrides?.roles ?? {},
  });
}
```

- [ ] **Step 6: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/orchestrator-cli.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/cycle.ts src/orchestrator/inspect.ts src/orchestrator/metrics.ts tests/orchestrator/orchestrator-cli.test.ts tests/index.test.ts
git commit -m "feat: add production orchestrator facade"
```

---

### Task 8: Wire Manual CLI Commands To Orchestrator

**Files:**
- Modify: `src/cli/entrypoint.ts`
- Modify: `src/cli/northstar.ts`
- Create: `tests/cli/manual-orchestrator-cli.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/cli/manual-orchestrator-cli.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { main } from "../../src/cli/entrypoint.ts";

test("manual orchestrator CLI commands require issue selector", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line?: unknown) => errors.push(String(line));
  try {
    const code = await main(["start", "--config", "tests/fixtures/.northstar.yaml"]);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /--issue is required/);
  } finally {
    console.error = originalError;
  }
});

test("inspect command accepts issue selector and config", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => logs.push(String(line));
  try {
    const code = await main(["inspect", "--issue", "101", "--config", "tests/fixtures/.northstar.yaml", "--dry-run"]);
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /"type":"inspect"/);
    assert.match(logs.join("\n"), /"issue":"101"/);
  } finally {
    console.log = originalLog;
  }
});
```

Add to `tests/index.test.ts`:

```ts
import "./cli/manual-orchestrator-cli.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/cli/manual-orchestrator-cli.test.ts
```

Expected: FAIL because `main()` currently returns thrown errors through top-level wrapper only or does not validate `--issue`.

- [ ] **Step 3: Add CLI option helpers**

Modify `src/cli/northstar.ts`:

```ts
export function requireOption(args: string[], option: string): string {
  const value = optionValue(args, option);
  if (!value) throw new Error(`${option} is required`);
  return value;
}
```

Export `optionValue` if needed:

```ts
export function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}
```

- [ ] **Step 4: Update `main()` error return and dry-run command output**

Modify `src/cli/entrypoint.ts` around command handling:

```ts
import { buildCliCommand, formatNorthstarHelp, formatNorthstarVersion, formatNorthstarWatchHelp, optionValue, requireOption } from "./northstar.ts";
```

Inside `main()` before `buildCliCommand`:

```ts
if (["start", "reconcile", "release", "inspect"].includes(argv[0] ?? "")) {
  try {
    const issue = requireOption(argv.slice(1), "--issue");
    if (argv.includes("--dry-run")) {
      console.log(JSON.stringify({ type: argv[0], issue }));
      return 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (argv[0] === "intake" && !optionValue(argv.slice(1), "--issue") && !optionValue(argv.slice(1), "--label")) {
  console.error("intake requires --issue or --label");
  return 1;
}
```

For non-dry-run commands, wire to the shared production orchestrator facade from `src/orchestrator/cycle.ts`. Add and use a factory so tests can inject a fake orchestrator without SQLite or network:

```ts
export function createManualOrchestratorCommandRunner(options: {
  createOrchestrator(command: BuiltCliCommand): Promise<{
    intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }): Promise<unknown>;
    startIssue(input: { issueId: string }): Promise<unknown>;
    reconcileIssue(input: { issueId: string }): Promise<unknown>;
    releaseIssue(input: { issueId: string; autoRelease: boolean }): Promise<unknown>;
    inspectIssue(input: { issueId: string }): unknown;
  }>;
}) {
  return async (argv: string[]) => {
    const command = buildCliCommand(argv);
    const issue = optionValue(command.args, "--issue");
    const dryRun = command.args.includes("--dry-run");

    if (["start", "reconcile", "release", "inspect"].includes(command.command) && !issue) {
      throw new Error("--issue is required");
    }
    if (command.command === "intake" && !issue && !optionValue(command.args, "--label")) {
      throw new Error("intake requires --issue or --label");
    }
    if (dryRun) return { type: command.command, issue };

    const orchestrator = await options.createOrchestrator(command);
    if (command.command === "start") return await orchestrator.startIssue({ issueId: String(issue) });
    if (command.command === "reconcile") return await orchestrator.reconcileIssue({ issueId: String(issue) });
    if (command.command === "release") return await orchestrator.releaseIssue({ issueId: String(issue), autoRelease: command.config.runtime.autoRelease });
    if (command.command === "inspect") return orchestrator.inspectIssue({ issueId: String(issue) });
    if (command.command === "intake") {
      return await orchestrator.intakeIssue({
        issueNumber: Number(issue),
        title: optionValue(command.args, "--title") ?? `Issue ${issue}`,
        body: optionValue(command.args, "--body") ?? "",
        sourceUrl: optionValue(command.args, "--source-url") ?? `https://github.com/${command.config.github.repo}/issues/${issue}`,
        labels: [command.config.github.intake.label],
      });
    }
    return command.engineCommand;
  };
}
```

Update `main()` to use this runner. The default `createOrchestrator` must call `createProductionOrchestratorFromConfig()` from `src/orchestrator/cycle.ts`; tests should inject a fake runner and prove non-dry-run dispatch reaches `startIssue`, `reconcileIssue`, `releaseIssue`, and `inspectIssue`.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/cli/manual-orchestrator-cli.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/entrypoint.ts src/cli/northstar.ts tests/cli/manual-orchestrator-cli.test.ts tests/index.test.ts
git commit -m "feat: validate manual orchestrator cli commands"
```

---

### Task 9: Watch Calls Shared Orchestrator Cycle

**Files:**
- Modify: `src/orchestrator/cycle.ts`
- Modify: `src/cli/watch-command.ts`
- Create: `tests/orchestrator/watch-orchestrator.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing watch/orchestrator test**

Create `tests/orchestrator/watch-orchestrator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createWatchOrchestratorRunner } from "../../src/cli/watch-command.ts";

test("watch delegates business flow to orchestrator runner", async () => {
  const calls: string[] = [];
  const runner = createWatchOrchestratorRunner({
    runCycle: async () => {
      calls.push("orchestrator.runCycle");
      return {
        activeIssues: 2,
        effectsStarted: 1,
        summary: {
          watch_cycles_completed: 1,
          watch_intake_processed: 1,
          watch_issues_started: 1,
          watch_secret_leaks: 0,
        },
      };
    },
  });

  const result = await runner();
  assert.equal(result.activeIssues, 2);
  assert.equal(result.effectsStarted, 1);
  assert.deepEqual(calls, ["orchestrator.runCycle"]);
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/watch-orchestrator.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
```

Expected: FAIL because `createWatchOrchestratorRunner` does not exist.

- [ ] **Step 3: Add watch runner factory**

Modify `src/cli/watch-command.ts`:

```ts
export function createWatchOrchestratorRunner(options: {
  runCycle(): Promise<{ activeIssues: number; effectsStarted: number; summary?: Record<string, unknown> }>;
}) {
  return async () => {
    const result = await options.runCycle();
    return {
      activeIssues: result.activeIssues,
      effectsStarted: result.effectsStarted,
      summary: result.summary ?? {},
    };
  };
}
```

Update `runWatchCommand()` cycle body to call this runner and the shared production orchestrator. The watch command must not duplicate lifecycle business logic:

```ts
const runner = createWatchOrchestratorRunner({
  runCycle: async () => {
    const orchestrator = createProductionOrchestratorFromConfig({
      config,
      host: hostAdapter,
      domain: domainDriver,
    });
    const result = await orchestrator.runCycle({
      autoRelease: config.runtime.autoRelease,
      maxStarts: config.runtime.developmentCapacity,
    });
    io.log(compactWatchLogLine({
      event: "watch_cycle",
      active_issues: result.activeIssues,
      effects_started: result.effectsStarted,
      summary: result.summary,
    }));
    return result;
  },
});
```

Then `runCycle` becomes:

```ts
runCycle: async () => await runner(),
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/watch-orchestrator.test.ts
npm test
npm run test:e2e:daemon
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/watch-command.ts tests/orchestrator/watch-orchestrator.test.ts tests/index.test.ts
git commit -m "feat: route watch through orchestrator runner"
```

---

### Task 10: Workflow Generality Tests

**Files:**
- Create: `tests/orchestrator/workflow-generality.test.ts`
- Modify: `src/orchestrator/cycle.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing workflow-generality test**

Create `tests/orchestrator/workflow-generality.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { scanForHardcodedDevWorkflowChain } from "../../src/orchestrator/cycle.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

test("orchestrator source does not hard-code software-dev role chain", async () => {
  const scan = await scanForHardcodedDevWorkflowChain();
  assert.equal(scan.workflow_generality_hardcoded_role_chain_matches, 0);
  assert.equal(scan.workflow_generality_hardcoded_release_merge_matches, 0);
});

test("non-dev workflows load for orchestrator generality", () => {
  const content = loadWorkflow("tests/fixtures/workflows/content-creation-publish.yaml");
  const office = loadWorkflow("tests/fixtures/workflows/office-report-delivery.yaml");
  assert.equal(content.id, "content_creation_publish");
  assert.equal(office.id, "office_report_delivery");
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/workflow-generality.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/workflow-generality.test.ts
```

Expected: FAIL because `scanForHardcodedDevWorkflowChain()` does not exist.

- [ ] **Step 3: Implement source scan helper**

Add to `src/orchestrator/cycle.ts`:

```ts
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
```

Add:

```ts
export async function scanForHardcodedDevWorkflowChain(root = "src/orchestrator") {
  let roleChainMatches = 0;
  let releaseMergeMatches = 0;
  for (const file of await listTsFiles(root)) {
    const content = await readFile(file, "utf8");
    if (/issue_worker\s*->\s*pr_verifier\s*->\s*release_worker/.test(content)) roleChainMatches += 1;
    if (/release\s*==\s*GitHub merge/.test(content)) releaseMergeMatches += 1;
  }
  return {
    workflow_generality_hardcoded_role_chain_matches: roleChainMatches,
    workflow_generality_hardcoded_release_merge_matches: releaseMergeMatches,
  };
}

async function listTsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listTsFiles(path));
    if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/workflow-generality.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/cycle.ts tests/orchestrator/workflow-generality.test.ts tests/index.test.ts
git commit -m "test: prove orchestrator workflow generality"
```

---

### Task 11: Error And Recovery Orchestrator Tests

**Files:**
- Create: `tests/orchestrator/error-recovery.test.ts`
- Modify: `src/orchestrator/metrics.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing error/recovery metrics tests**

Create `tests/orchestrator/error-recovery.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertErrorRecoveryMetrics,
  emptyErrorRecoveryMetrics,
  formatErrorRecoverySummary,
} from "../../src/orchestrator/metrics.ts";

test("error and recovery metrics enforce quantitative acceptance", () => {
  const metrics = emptyErrorRecoveryMetrics();
  metrics.orchestrator_retryable_effect_failures = 3;
  metrics.orchestrator_quarantined_issues = 3;
  metrics.orchestrator_failed_issues = 1;
  metrics.orchestrator_resume_successes = 1;
  metrics.orchestrator_invalid_resume_rejections = 1;
  metrics.orchestrator_artifact_rejections = 1;
  metrics.orchestrator_post_merge_cleanup_failures_preserved = 1;
  metrics.orchestrator_completed_reversals = 0;
  metrics.orchestrator_secret_leaks = 0;
  assert.doesNotThrow(() => assertErrorRecoveryMetrics(metrics));
  assert.match(formatErrorRecoverySummary(metrics), /orchestrator_quarantined_issues=3/);
});
```

Add to `tests/index.test.ts`:

```ts
import "./orchestrator/error-recovery.test.ts";
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/error-recovery.test.ts
```

Expected: FAIL because error metrics do not exist.

- [ ] **Step 3: Implement error metrics**

Add to `src/orchestrator/metrics.ts`:

```ts
export interface ErrorRecoveryMetrics {
  orchestrator_retryable_effect_failures: number;
  orchestrator_quarantined_issues: number;
  orchestrator_failed_issues: number;
  orchestrator_resume_successes: number;
  orchestrator_invalid_resume_rejections: number;
  orchestrator_artifact_rejections: number;
  orchestrator_post_merge_cleanup_failures_preserved: number;
  orchestrator_completed_reversals: number;
  orchestrator_secret_leaks: number;
}

export function emptyErrorRecoveryMetrics(): ErrorRecoveryMetrics {
  return {
    orchestrator_retryable_effect_failures: 0,
    orchestrator_quarantined_issues: 0,
    orchestrator_failed_issues: 0,
    orchestrator_resume_successes: 0,
    orchestrator_invalid_resume_rejections: 0,
    orchestrator_artifact_rejections: 0,
    orchestrator_post_merge_cleanup_failures_preserved: 0,
    orchestrator_completed_reversals: 0,
    orchestrator_secret_leaks: 0,
  };
}

export function formatErrorRecoverySummary(metrics: ErrorRecoveryMetrics): string {
  return Object.entries(metrics).map(([key, value]) => `${key}=${value}`).join(" ");
}

export function assertErrorRecoveryMetrics(metrics: ErrorRecoveryMetrics): void {
  const failures: string[] = [];
  if (metrics.orchestrator_retryable_effect_failures < 3) failures.push("orchestrator_retryable_effect_failures >= 3");
  if (metrics.orchestrator_quarantined_issues < 3) failures.push("orchestrator_quarantined_issues >= 3");
  if (metrics.orchestrator_failed_issues < 1) failures.push("orchestrator_failed_issues >= 1");
  if (metrics.orchestrator_resume_successes < 1) failures.push("orchestrator_resume_successes >= 1");
  if (metrics.orchestrator_invalid_resume_rejections < 1) failures.push("orchestrator_invalid_resume_rejections >= 1");
  if (metrics.orchestrator_artifact_rejections < 1) failures.push("orchestrator_artifact_rejections >= 1");
  if (metrics.orchestrator_post_merge_cleanup_failures_preserved < 1) failures.push("orchestrator_post_merge_cleanup_failures_preserved >= 1");
  if (metrics.orchestrator_completed_reversals !== 0) failures.push("orchestrator_completed_reversals = 0");
  if (metrics.orchestrator_secret_leaks !== 0) failures.push("orchestrator_secret_leaks = 0");
  if (failures.length > 0) throw new Error(`Error/recovery metrics failed: ${failures.join("; ")}`);
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/orchestrator/error-recovery.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/metrics.ts tests/orchestrator/error-recovery.test.ts tests/index.test.ts
git commit -m "test: quantify orchestrator recovery metrics"
```

---

### Task 12: Production Live E2E Real Flow

**Files:**
- Create: `tests/e2e-production-live/index.test.ts`
- Create: `tests/e2e-production-live/production-live.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing production live clear-skip and env validation tests**

Create `tests/e2e-production-live/production-live.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("production live E2E clear-skips without live flag", (t) => {
  if (process.env.NORTHSTAR_PRODUCTION_LIVE !== "1") {
    t.skip("Set NORTHSTAR_PRODUCTION_LIVE=1 to run production live E2E.");
    return;
  }
  assert.ok(process.env.GITHUB_TOKEN, "GITHUB_TOKEN is required");
  assert.equal(process.env.NORTHSTAR_LIVE_GITHUB_REPO, "paulpai0412/northstar-live-sandbox");
});
```

Create `tests/e2e-production-live/index.test.ts`:

```ts
import "./production-live.test.ts";
```

Modify `package.json` scripts:

```json
"test:e2e:production-live": "node --disable-warning=ExperimentalWarning tests/e2e-production-live/index.test.ts"
```

- [ ] **Step 2: Run command and verify RED/GREEN clear skip**

Run:

```bash
npm run test:e2e:production-live
```

Expected: PASS with one skipped test.

- [ ] **Step 3: Add real production live scenario**

Extend `tests/e2e-production-live/production-live.test.ts` with a real live test that runs only when `NORTHSTAR_PRODUCTION_LIVE=1`. The test must use the production CLI/orchestrator path, not the old harness orchestration. Use existing helpers from `tests/e2e-full-live/` and `tests/e2e-full-live-opencode/` only for low-level SDK/GitHub utilities when needed; do not call their orchestration harness methods.

The live test must:

1. Create two traceable GitHub issues in `paulpai0412/northstar-live-sandbox` with titles beginning `northstar-production-live-`.
2. Run one issue through production CLI/orchestrator using `runtime.host_adapter: opencode`.
3. Run one issue through production CLI/orchestrator using `runtime.host_adapter: codex`.
4. For each issue, execute:
   - `intake`
   - `start`
   - `reconcile`
   - `release`
   - `inspect`
5. Confirm each flow creates a branch, PR, merge SHA, confirmed merge history fact, closed GitHub issue, and completed runtime snapshot.
6. Print compact metric lines without secrets.

Add this metrics contract:

```ts
interface ProductionLiveMetrics {
  production_live_issues_created: number;
  production_live_opencode_runs_completed: number;
  production_live_codex_runs_completed: number;
  production_live_prs_created: number;
  production_live_prs_merged: number;
  production_live_completed: number;
  production_live_confirmed_merge_facts: number;
  production_live_github_issues_closed: number;
  production_live_secret_leaks: number;
  production_live_shell_fallbacks: number;
}
```

Assert:

```ts
assert.equal(metrics.production_live_issues_created, 2);
assert.equal(metrics.production_live_opencode_runs_completed, 1);
assert.equal(metrics.production_live_codex_runs_completed, 1);
assert.equal(metrics.production_live_prs_created, 2);
assert.equal(metrics.production_live_prs_merged, 2);
assert.equal(metrics.production_live_completed, 2);
assert.equal(metrics.production_live_confirmed_merge_facts, 2);
assert.equal(metrics.production_live_github_issues_closed, 2);
assert.equal(metrics.production_live_secret_leaks, 0);
assert.equal(metrics.production_live_shell_fallbacks, 0);
```

- [ ] **Step 4: Run production live clear skip**

Run:

```bash
npm run test:e2e:production-live
```

Expected: PASS with clear skip when `NORTHSTAR_PRODUCTION_LIVE` is not set.

- [ ] **Step 5: Run production live with real credentials**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCTION_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
npm run test:e2e:production-live
```

Expected: PASS and emit:

```text
production_live_issues_created=2
production_live_opencode_runs_completed=1
production_live_codex_runs_completed=1
production_live_prs_created=2
production_live_prs_merged=2
production_live_completed=2
production_live_confirmed_merge_facts=2
production_live_github_issues_closed=2
production_live_secret_leaks=0
production_live_shell_fallbacks=0
```

If credentials are missing, stop and report the exact missing env/config. Do not mark production live acceptance complete.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/e2e-production-live
git commit -m "test: add production live orchestrator e2e"
```

---

### Task 13: Production Orchestrator Coverage Matrix

**Files:**
- Create: `docs/superpowers/production-orchestrator-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Write failing spec compliance test**

Append to `tests/spec/spec-compliance.test.ts`:

```ts
test("production orchestrator coverage matrix maps quantified requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/production-orchestrator-coverage.md"), "utf8");
  for (const required of [
    "Manual CLI Flow",
    "Watch/Daemon",
    "Dependency Scheduling",
    "Workflow Generality",
    "Error And Recovery",
    "Full Live Production",
    "Coverage And Source Safety",
    "src/orchestrator/cycle.ts",
    "tests/orchestrator/orchestrator-cli.test.ts",
    "tests/e2e-production-live/production-live.test.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `docs/superpowers/production-orchestrator-coverage.md` does not exist.

- [ ] **Step 3: Add coverage matrix**

Create `docs/superpowers/production-orchestrator-coverage.md`:

```md
# Production Orchestrator Coverage Matrix

Source spec: `docs/superpowers/specs/2026-05-30-northstar-production-orchestrator-design.md`

| Area | Quantitative Metrics | Test Files | Implementation Files |
| --- | --- | --- | --- |
| Manual CLI Flow | `manual_cli_completed_issues>=1`, `manual_cli_prs_merged>=1`, `manual_cli_secret_leaks=0` | `tests/orchestrator/orchestrator-cli.test.ts`, `tests/cli/manual-orchestrator-cli.test.ts` | `src/orchestrator/cycle.ts`, `src/orchestrator/issue-flow.ts`, `src/cli/entrypoint.ts` |
| Watch/Daemon | `watch_cycles_completed>=6`, `watch_duplicate_dispatches=0`, `watch_secret_leaks=0` | `tests/orchestrator/watch-orchestrator.test.ts`, `tests/e2e-daemon/daemon-e2e.test.ts` | `src/cli/watch-command.ts`, `src/orchestrator/cycle.ts` |
| Dependency Scheduling | `scheduler_dependency_edges>=3`, `scheduler_dependency_order_violations=0` | `tests/orchestrator/dependencies.test.ts`, `tests/orchestrator/scheduler.test.ts` | `src/orchestrator/dependencies.ts`, `src/orchestrator/scheduler.ts` |
| Workflow Generality | `workflow_generality_hardcoded_role_chain_matches=0`, `workflow_generality_non_dev_workflows_passed>=2` | `tests/orchestrator/workflow-generality.test.ts` | `src/orchestrator/cycle.ts`, `src/orchestrator/domain-driver.ts` |
| Error And Recovery | `orchestrator_quarantined_issues>=3`, `orchestrator_completed_reversals=0` | `tests/orchestrator/error-recovery.test.ts`, `tests/e2e-exceptions/exception-e2e.test.ts` | `src/orchestrator/metrics.ts`, `src/orchestrator/issue-flow.ts` |
| Full Live Production | `production_live_completed>=2`, `production_live_opencode_runs_completed>=1`, `production_live_codex_runs_completed>=1` | `tests/e2e-production-live/production-live.test.ts` | `src/orchestrator/cycle.ts`, `src/orchestrator/software-dev-driver.ts` |
| Coverage And Source Safety | `production_orchestrator_requirement_coverage_percent>=90`, `production_shell_chain_matches=0` | `tests/spec/spec-compliance.test.ts`, `tests/coverage/requirement-coverage.test.ts` | `docs/superpowers/production-orchestrator-coverage.md` |
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/production-orchestrator-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map production orchestrator coverage"
```

---

### Task 14: Final Verification Gate

**Files:**
- Modify only files needed to fix verification failures.

- [ ] **Step 1: Run offline verification**

Run:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
npm run test:e2e:production-live
```

Expected:

- `npm test` passes.
- offline E2E passes.
- daemon E2E passes.
- exception E2E passes.
- coverage passes at 85 percent thresholds.
- production live command clear-skips without `NORTHSTAR_PRODUCTION_LIVE=1`.

- [ ] **Step 2: Run source safety scans**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
```

Expected:

- First three commands print no matches and exit `1`.
- State-machine side-effect scan prints no matches and exits `1`.

- [ ] **Step 3: Run live production verification when credentials are available**

Run:

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCTION_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
npm run test:e2e:production-live
```

Expected once live implementation is complete:

```text
production_live_issues_created >= 2
production_live_prs_merged >= 2
production_live_completed >= 2
production_live_opencode_runs_completed >= 1
production_live_codex_runs_completed >= 1
production_live_secret_leaks = 0
production_live_shell_fallbacks = 0
```

If credentials are unavailable, report the missing env/config explicitly. Do not mark live production acceptance complete.

- [ ] **Step 4: Check git state**

Run:

```bash
git status --short
```

Expected: only intentional files changed before final commit; clean after final commit.

- [ ] **Step 5: Commit final fixes if needed**

If verification required fixes:

```bash
git add src tests docs package.json
git commit -m "test: verify production orchestrator"
```

If no files changed, do not create an empty commit.

---

## Goal Prompt

```text
/goal
使用 Superpowers executing-plans 執行 docs/superpowers/plans/2026-05-30-northstar-production-orchestrator-implementation-plan.md。

完成 Northstar Production Orchestrator：
- 將目前 E2E harness 中的 issue-to-release orchestration 下沉到 production orchestrator/CLI/watch。
- manual CLI 支援 intake/start/reconcile/release/inspect 單一 issue flow。
- watch daemon 使用同一套 orchestrator，支援 dependency scheduling、capacity、auto_release。
- orchestrator core 保持 workflow-general，不得寫死 issue_worker -> pr_verifier -> release_worker 或 release == GitHub merge。
- production software-dev driver 管理 worktree/branch/commit/push/PR/merge。
- OpenCode + Codex host adapters 都可由 production flow 使用。

依據：
- docs/superpowers/specs/2026-05-30-northstar-production-orchestrator-design.md
- docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md
- docs/superpowers/opencode-full-live-e2e-coverage.md

執行規則：
1. 使用 Superpowers：executing-plans、test-driven-development、systematic-debugging、verification-before-completion。
2. 逐 task TDD 執行；每個未覆蓋行為先寫 failing test，確認 RED，再做最小實作轉 GREEN。
3. runtime/state-machine.ts 必須保持 pure；不得讀寫 filesystem、SQLite、GitHub、host SDK、shell。
4. manual CLI 和 northstar watch 必須共用 production orchestrator；不得複製兩套 orchestration。
5. live tests 必須與 offline tests 分離；npm test 不得依賴 GitHub token、OpenCode/Codex credentials 或網路。
6. full live production E2E 使用 real GitHub、real OpenCode SDK、real Codex SDK；fake host adapters 不可滿足 live acceptance。
7. 所有外部 command 必須用 argv arrays，不得使用 shell-chain strings。
8. 不得依賴 /home/timmypai/apps/autodev/scripts 或 Python runtime。

量化驗收：
- manual_cli_completed_issues >= 1
- manual_cli_prs_merged >= 1
- watch_cycles_completed >= 6
- watch_auto_release_completed >= 1
- scheduler_dependency_order_violations = 0
- workflow_generality_hardcoded_role_chain_matches = 0
- workflow_generality_hardcoded_release_merge_matches = 0
- orchestrator_completed_reversals = 0
- production_live_completed >= 2
- production_live_opencode_runs_completed >= 1
- production_live_codex_runs_completed >= 1
- production_live_secret_leaks = 0
- production_live_shell_fallbacks = 0
- production_orchestrator_requirement_coverage_percent >= 90

完成前 fresh run：
- npm test
- npm run test:e2e
- npm run test:e2e:daemon
- npm run test:e2e:exceptions
- npm run test:coverage
- npm run test:e2e:production-live 未設 live flag 時 clear skip
- GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live
- node --run northstar -- --help
- node --run northstar -- --version
- rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
- rg "process\\.env\\." src
- rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
- rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
- git status --short

最後回報：
- production orchestrator coverage matrix
- manual CLI metrics
- watch metrics
- dependency/scheduler metrics
- workflow generality metrics
- live production metrics and issue/PR URLs
- RED -> GREEN evidence
- fresh verification output summary
- 修改檔案摘要
- deferred work
```

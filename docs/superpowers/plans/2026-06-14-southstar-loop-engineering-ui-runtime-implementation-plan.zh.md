# Southstar Loop Engineering UI Runtime Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real UI + runtime vertical slice where a browser user enters a goal prompt and Southstar completes a meaningful software artifact through dynamic workflow generation, Docker/Tork execution, ContextPacket/memory/session/worktree tracking, evaluator gates, and stop-condition completion.

**Architecture:** Keep Southstar Runtime Server as the only API boundary. Next UI becomes a real client of `/api/v2/*`, while Southstar DB, Workflow Snapshot, SessionGraph, WorkspaceSnapshot, and EvaluatorPipeline remain canonical truth. Tork/Docker stays an executor projection and never owns workflow state.

**Tech Stack:** TypeScript, Next.js app router/client components, Node test runner, Playwright, SQLite store, Southstar Runtime Server, Tork/Docker, Git/worktree provider, existing SQLite memory provider with `MemoryProvider` adapter boundary.

---

## Goal Prompt for the Implementation Agent

Use this exact prompt when executing this implementation plan:

```text
Implement the Southstar Loop Engineering UI Runtime vertical slice from docs/superpowers/specs/2026-06-14-southstar-loop-engineering-ui-runtime-design.zh.md.

Scope:
1. The browser UI must accept a real goal prompt, create a planner draft, review the dynamic workflow, start a real run, and monitor it to stop-condition completion.
2. The workflow must be generated from the software domain pack and must not be a fixed four-task flow.
3. Every executed task must expose TaskEnvelopeV2, ContextPacket, memory injection trace, session checkpoint, workspace snapshot or workspace handle, executor binding, evaluator result, and stop-condition status through UI-accessible runtime APIs.
4. Tork/Docker must execute tasks, but Southstar DB, workflow snapshot, SessionGraph, and evaluator state remain workflow truth.
5. The UI pages must follow the design in docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime and use code-native React UI, not static screenshots.
6. Add a real browser E2E case. Do not use fake, smoke, mocked, stubbed, or shell-only acceptance.
7. The E2E prompt must produce a meaningful artifact: a CLI sum command that supports integers, negative numbers, decimals, invalid input errors, tests, README examples, and evaluator evidence.
8. A run may only be marked complete after evaluator pipeline and stop condition pass.

Acceptance:
- `npm run test:v2` passes.
- `node_modules/.bin/tsc --noEmit` passes.
- The real E2E command passes with Docker/Tork enabled.
- Browser E2E proves UI-triggered prompt -> dynamic workflow -> task execution -> artifact evidence -> stop condition completion.
```

## Real E2E Product Goal Prompt

The browser E2E must enter this exact goal prompt into Planner Chat:

```text
在目前 fixture repo 新增 CLI 指令 sum <numbers...>。
要求：
1. 支援整數、負數、小數。
2. invalid input 要回傳非 0 exit code 並顯示 Invalid number: <value>。
3. 補 unit tests，至少涵蓋正數、負數、小數、invalid input。
4. 更新 README，包含正數、負數/小數、invalid input 三種用法。
5. 不新增 runtime dependency。
6. Southstar 必須自動判斷 domain/intent。
7. 必須依 software domain pack 動態產生 workflow DAG，不可固定四個 task。
8. 每個 task 必須解析 role、agent、model、skill、MCP、memory scope。
9. 每個 agent 執行前必須保存可追蹤 ContextPacket，並記錄 memory 為什麼注入或排除。
10. task 必須透過 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。
11. artifact 必須經 evaluator pipeline 驗收；驗收失敗時可 retry、fork session、rollback workspace、或要求 workflow revision。
12. session 必須有 checkpoint/fork/reset/rollback lineage 可查。
13. Git/worktree 必須用於 software workspace snapshot 或 rollback reference。
14. 只有 stop condition 通過，run 才能完成。
Fixture repo: <prepared fixture repo path>
```

## Quantitative Acceptance Gates

The final implementation is accepted only when the real browser E2E and DB evidence meet these gates:

- Browser enters the goal prompt and starts the run through the Southstar UI.
- Browser E2E does not call runtime APIs directly except through the UI.
- Browser E2E does not seed success rows, bypass Tork, bypass evaluator, or fabricate UI data.
- Run has `domain = software` and `intent = implement_feature`.
- Workflow has at least 5 tasks.
- Workflow task IDs are not exactly `planner`, `implementer`, `root-validator`, `summary`.
- Every executed task has one persisted `TaskEnvelopeV2`.
- Every executed task has one persisted `ContextPacket`.
- Every executed task has one persisted `memory_injection_trace`, including an explicit empty or excluded reason when no memory is injected.
- Every executed task has one session checkpoint.
- The run has at least one workspace snapshot.
- The run has at least one executor binding with executor type `tork`.
- The run has at least one evaluator pipeline result.
- The run has one stop-condition result with status `passed`.
- UI shows final run status `completed` or `passed` only after stop condition passes.
- UI shows a task detail page with TaskEnvelopeV2, ContextPacket, memory trace, evaluator, and session/worktree references from real runtime data.
- UI shows Worktree Console with snapshot or diff evidence from real Git/worktree state.
- UI shows Executor Ops with real executor binding/job state.
- In the fixture repo, `npm run -s cli -- sum 1 2 3` prints `6`.
- In the fixture repo, `npm run -s cli -- sum -2 3.5 4` prints `5.5`.
- In the fixture repo, `npm run -s cli -- sum 1 nope` exits non-zero and prints `Invalid number: nope`.
- In the fixture repo, `npm test` passes.
- README contains examples for positive numbers, negative/decimal numbers, and invalid input.

## File Structure

Create:

- `src/v2/ui-api/control-plane-read-models.ts`  
  Builds typed read models for Planner Chat, Workflow Canvas, Runtime Monitor, Task Detail, Sessions/Memory, Worktree, Executor Ops, Domain Packs, Vault/MCP, and Approval Policy.

- `src/v2/ui-api/session-worktree-operations.ts`  
  Exposes runtime operation helpers for session fork/reset/rollback preview/rollback and worktree snapshot/fork/diff/rollback preview/rollback.

- `src/v2/quality/ui-control-plane-gates.ts`  
  Provides DB-level quantitative gate assertions for the real UI control-plane E2E.

- `components/southstar/types.ts`  
  Shared client-side model types consumed by Southstar UI components.

- `components/southstar/status.tsx`  
  Small status badge and empty-state primitives matching the existing console design.

- `components/southstar/SessionsMemoryPanel.tsx`  
  Real Sessions/Memory page panel.

- `components/southstar/WorktreePanel.tsx`  
  Real Worktree Console page panel.

- `components/southstar/ExecutorOpsPanel.tsx`  
  Real Executor Ops page panel.

- `components/southstar/DomainPacksPanel.tsx`  
  Read-only Domain Packs / Agent Studio panel.

- `components/southstar/VaultMcpApprovalPanel.tsx`  
  Vault/MCP and Approval Policy panel.

- `tests/e2e-real/scenarios/ui-loop-engineering-control-plane.ts`  
  Real browser E2E scenario for prompt-to-artifact completion.

Modify:

- `src/v2/server/routes.ts`  
  Add read-model and operation endpoints.

- `src/v2/server/client.ts`  
  Add typed client methods for new endpoints.

- `src/v2/ui-api/read-models.ts`  
  Re-export or delegate to `control-plane-read-models.ts`.

- `lib/southstar/api-client.ts`  
  Convert from thin draft-only client to full UI API client.

- `components/southstar/AppShell.tsx`  
  Own selected run/task state, fetch dashboard data, pass data/actions to panels.

- `components/southstar/PlannerChat.tsx`  
  Wire draft/revise/run/voice/steering actions.

- `components/southstar/WorkflowCanvas.tsx`  
  Render real dynamic DAG and selected task state.

- `components/southstar/RuntimeMonitor.tsx`  
  Render real run event stream and evaluator/stop-condition state.

- `components/southstar/TaskDetail.tsx`  
  Render real TaskEnvelopeV2, ContextPacket, memory trace, evaluator, I/O, decisions.

- `components/southstar/OperationsPanels.tsx`  
  Replace static "Ready" text with real full-mode panels.

- `app/globals.css`  
  Extend existing Southstar design tokens while preserving current visual system.

- `tests/v2/server-api.test.ts`  
  Add endpoint tests for read models and operations.

- `tests/v2/ui-read-models.test.ts`  
  Add read-model coverage for TaskEnvelopeV2, ContextPacket, memory trace, worktree, executor, stop condition.

- `tests/web/southstar-operations-ui.test.tsx`  
  Add static/source-level tests that reject inert controls and static sample-only panels.

- `tests/e2e-real/index.test.ts`  
  Add the new real browser scenario and quantitative gate.

## Task 1: Add Failing Real Browser E2E for Prompt-to-Artifact Completion

**Files:**

- Create: `tests/e2e-real/scenarios/ui-loop-engineering-control-plane.ts`
- Modify: `tests/e2e-real/index.test.ts`
- Modify: `tests/e2e-real/scenarios/harness.ts`

- [ ] **Step 1: Add the E2E scenario file**

Create `tests/e2e-real/scenarios/ui-loop-engineering-control-plane.ts` with this content:

```ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { assertUiControlPlaneQuantitativeGates } from "../../../src/v2/quality/ui-control-plane-gates.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertFixtureTests,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  uiControlPlaneGoalPrompt,
  waitForRunStatus,
} from "./harness.ts";

export async function runUiLoopEngineeringControlPlaneScenario(env: RealE2EEnv): Promise<{
  runId: string;
  taskId: string;
  repo: string;
  timings: {
    browserRunCompletionMs: number;
    firstWorkflowVisibleMs: number;
    taskDetailVisibleMs: number;
    stopConditionVisibleMs: number;
  };
}> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "ui-loop-engineering-control-plane-real");
  const runtimeServer = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    callbackUrl: callback.url,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
  });
  const next = spawn("npm", ["run", "web:dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SOUTHSTAR_SERVER_URL: runtimeServer.url,
      NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: runtimeServer.url,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let runId = "";
  let taskId = "";
  let firstWorkflowVisibleMs = Number.POSITIVE_INFINITY;
  let taskDetailVisibleMs = Number.POSITIVE_INFINITY;
  let stopConditionVisibleMs = Number.POSITIVE_INFINITY;

  try {
    await waitForHttp("http://localhost:3030", 60_000);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto("http://localhost:3030", { waitUntil: "networkidle" });
      await page.getByLabel("planner input").fill(uiControlPlaneGoalPrompt(repo));
      const workflowStartedAt = Date.now();
      await page.getByRole("button", { name: "Send to Planner" }).click();
      await page.getByText("software-change").waitFor({ timeout: 120_000 });
      await page.getByText("Dynamic Workflow").waitFor({ timeout: 120_000 });
      firstWorkflowVisibleMs = Date.now() - workflowStartedAt;
      await page.getByRole("button", { name: "Run" }).click();
      await page.getByTestId("active-run-id").waitFor({ timeout: 120_000 });
      runId = (await page.getByTestId("active-run-id").textContent() ?? "").trim();
      assert.match(runId, /^run-/);

      await waitForRunStatus(context.db, runId, ["passed", "completed"], 20 * 60_000);

      const detailStartedAt = Date.now();
      await page.getByRole("heading", { name: "Task Detail" }).waitFor({ timeout: 120_000 });
      await page.getByText("TaskEnvelopeV2").waitFor({ timeout: 120_000 });
      await page.getByText("ContextPacket").waitFor({ timeout: 120_000 });
      await page.getByText("Memory Injection Trace").waitFor({ timeout: 120_000 });
      taskDetailVisibleMs = Date.now() - detailStartedAt;

      const stopStartedAt = Date.now();
      await page.getByText("STOP CONDITION PASSED").waitFor({ timeout: 120_000 });
      stopConditionVisibleMs = Date.now() - stopStartedAt;

      await page.getByRole("button", { name: "Full" }).click();
      await page.getByRole("heading", { name: "Sessions / Memory" }).waitFor({ timeout: 120_000 });
      await page.getByRole("heading", { name: "Worktree Console" }).waitFor({ timeout: 120_000 });
      await page.getByRole("heading", { name: "Executor Ops" }).waitFor({ timeout: 120_000 });
      await page.getByText("Tork executes tasks only").waitFor({ timeout: 120_000 });

      const selectedTask = await page.getByTestId("selected-task-id").textContent();
      taskId = (selectedTask ?? "").trim();
      assert.ok(taskId.length > 0, "UI must expose selected task id");
      await page.screenshot({ path: "/tmp/southstar-ui-loop-engineering-control-plane.png", fullPage: true });
    } finally {
      await browser.close();
    }

    assertCalcSum(repo);
    assertFixtureTests(repo);
    const gate = assertUiControlPlaneQuantitativeGates(context.db, {
      runId,
      taskId,
      repo,
      browserRunCompletionMs: Date.now() - startedAt,
      firstWorkflowVisibleMs,
      taskDetailVisibleMs,
      stopConditionVisibleMs,
    });
    assert.equal(gate.ok, true, gate.failures.join("\n"));

    return {
      runId,
      taskId,
      repo,
      timings: {
        browserRunCompletionMs: Date.now() - startedAt,
        firstWorkflowVisibleMs,
        taskDetailVisibleMs,
        stopConditionVisibleMs,
      },
    };
  } finally {
    await stopProcessGroup(next);
    await runtimeServer.close();
    await callback.close();
  }
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 5_000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 2_000);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([once(child, "exit").then(() => true), timeout]);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`web UI did not start within ${timeoutMs}ms`);
}
```

- [ ] **Step 2: Add the E2E prompt helper**

In `tests/e2e-real/scenarios/harness.ts`, add:

```ts
export function uiControlPlaneGoalPrompt(repo: string): string {
  return [
    "在目前 fixture repo 新增 CLI 指令 sum <numbers...>。",
    "要求：",
    "1. 支援整數、負數、小數。",
    "2. invalid input 要回傳非 0 exit code 並顯示 Invalid number: <value>。",
    "3. 補 unit tests，至少涵蓋正數、負數、小數、invalid input。",
    "4. 更新 README，包含正數、負數/小數、invalid input 三種用法。",
    "5. 不新增 runtime dependency。",
    "6. Southstar 必須自動判斷 domain/intent。",
    "7. 必須依 software domain pack 動態產生 workflow DAG，不可固定四個 task。",
    "8. 每個 task 必須解析 role、agent、model、skill、MCP、memory scope。",
    "9. 每個 agent 執行前必須保存可追蹤 ContextPacket，並記錄 memory 為什麼注入或排除。",
    "10. task 必須透過 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。",
    "11. artifact 必須經 evaluator pipeline 驗收；驗收失敗時可 retry、fork session、rollback workspace、或要求 workflow revision。",
    "12. session 必須有 checkpoint/fork/reset/rollback lineage 可查。",
    "13. Git/worktree 必須用於 software workspace snapshot 或 rollback reference。",
    "14. 只有 stop condition 通過，run 才能完成。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}
```

- [ ] **Step 3: Register the scenario in the real E2E suite**

Modify `tests/e2e-real/index.test.ts`:

```ts
import { runUiLoopEngineeringControlPlaneScenario } from "./scenarios/ui-loop-engineering-control-plane.ts";
```

Add this after the existing UI API scenario:

```ts
const controlPlaneUi = await runUiLoopEngineeringControlPlaneScenario(env);
assert.ok(controlPlaneUi.runId.startsWith("run-"));
```

- [ ] **Step 4: Run the new E2E and verify it fails for the right reason**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected before implementation:

```text
FAIL
Timeout waiting for Dynamic Workflow, TaskEnvelopeV2, ContextPacket, Memory Injection Trace, STOP CONDITION PASSED, or real Worktree/Executor UI evidence.
```

- [ ] **Step 5: Commit the failing E2E test**

```bash
git add tests/e2e-real/scenarios/ui-loop-engineering-control-plane.ts tests/e2e-real/scenarios/harness.ts tests/e2e-real/index.test.ts
git commit -m "test: add real ui loop engineering control plane e2e"
```

## Task 2: Add DB Quantitative Gates for the Real UI Control Plane

**Files:**

- Create: `src/v2/quality/ui-control-plane-gates.ts`
- Modify: `tests/v2/index.test.ts`
- Create or modify: `tests/v2/ui-control-plane-gates.test.ts`

- [ ] **Step 1: Write the gate test**

Create `tests/v2/ui-control-plane-gates.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { appendRuntimeEvent } from "../../src/v2/signals/events.ts";
import { assertUiControlPlaneQuantitativeGates } from "../../src/v2/quality/ui-control-plane-gates.ts";

test("ui control plane gates require real workflow, context, memory, session, worktree, executor, evaluator, and stop-condition evidence", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-ui-gate",
    status: "passed",
    domain: "software",
    goalPrompt: "implement sum cli",
    workflowManifestJson: JSON.stringify({
      domain: "software",
      intent: "implement_feature",
      workflowGeneration: { planId: "plan-1", orchestrationSnapshotId: "orch-1" },
      tasks: [
        { id: "intent", roleRef: "analyst" },
        { id: "plan", roleRef: "planner" },
        { id: "implement", roleRef: "software-engineer" },
        { id: "test", roleRef: "qa-engineer" },
        { id: "evaluate", roleRef: "evaluator" },
      ],
    }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  for (const [index, taskId] of ["intent", "plan", "implement", "test", "evaluate"].entries()) {
    createWorkflowTask(db, { id: taskId, runId: "run-ui-gate", taskKey: taskId, status: "completed", sortOrder: index, dependsOn: [] });
    upsertRuntimeResource(db, { resourceType: "task_envelope_v2", resourceKey: `env-${taskId}`, runId: "run-ui-gate", taskId, scope: "task", status: "created", payload: { taskId } });
    upsertRuntimeResource(db, { resourceType: "context_packet", resourceKey: `ctx-${taskId}`, runId: "run-ui-gate", taskId, scope: "task", status: "created", payload: { taskId } });
    upsertRuntimeResource(db, { resourceType: "memory_injection_trace", resourceKey: `mem-trace-${taskId}`, runId: "run-ui-gate", taskId, scope: "task", status: "created", payload: { injected: [], excluded: [{ reason: "no relevant memory" }] } });
    upsertRuntimeResource(db, { resourceType: "session_checkpoint", resourceKey: `chk-${taskId}`, runId: "run-ui-gate", taskId, scope: "session", status: "created", payload: { taskId } });
  }
  upsertRuntimeResource(db, { resourceType: "workspace_snapshot", resourceKey: "ws-1", runId: "run-ui-gate", taskId: "implement", scope: "workspace", status: "created", payload: { provider: "git", commitSha: "abc123" } });
  upsertRuntimeResource(db, { resourceType: "executor_binding", resourceKey: "exec-1", runId: "run-ui-gate", taskId: "implement", scope: "executor", status: "completed", payload: { executorType: "tork", externalJobId: "job-1" } });
  upsertRuntimeResource(db, { resourceType: "evaluator_pipeline_result", resourceKey: "eval-1", runId: "run-ui-gate", taskId: "evaluate", scope: "evaluator", status: "passed", payload: { gates: [{ id: "tests", status: "passed" }] } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: "stop-1", runId: "run-ui-gate", scope: "run", status: "passed", payload: { status: "passed" } });
  appendRuntimeEvent(db, { runId: "run-ui-gate", eventType: "stop.condition.met", actorType: "root-session", payload: { status: "passed" } });

  const result = assertUiControlPlaneQuantitativeGates(db, {
    runId: "run-ui-gate",
    taskId: "implement",
    repo: process.cwd(),
    browserRunCompletionMs: 1,
    firstWorkflowVisibleMs: 1,
    taskDetailVisibleMs: 1,
    stopConditionVisibleMs: 1,
  });

  assert.equal(result.ok, true, result.failures.join("\n"));
});
```

- [ ] **Step 2: Run the test and verify it fails because the gate module does not exist**

Run:

```bash
npm run test:v2 -- tests/v2/ui-control-plane-gates.test.ts
```

Expected:

```text
Cannot find module '../../src/v2/quality/ui-control-plane-gates.ts'
```

- [ ] **Step 3: Implement the gate module**

Create `src/v2/quality/ui-control-plane-gates.ts`:

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources } from "../stores/resource-store.ts";

export type UiControlPlaneGateInput = {
  runId: string;
  taskId: string;
  repo: string;
  browserRunCompletionMs: number;
  firstWorkflowVisibleMs: number;
  taskDetailVisibleMs: number;
  stopConditionVisibleMs: number;
};

export type UiControlPlaneGateResult = {
  ok: boolean;
  failures: string[];
};

export function assertUiControlPlaneQuantitativeGates(db: SouthstarDb, input: UiControlPlaneGateInput): UiControlPlaneGateResult {
  const failures: string[] = [];
  const run = db.prepare("select status, domain, workflow_manifest_json from workflow_runs where id = ?").get(input.runId) as {
    status: string;
    domain: string;
    workflow_manifest_json: string;
  } | undefined;
  if (!run) failures.push(`missing run ${input.runId}`);
  if (run && run.domain !== "software") failures.push(`expected software domain, got ${run.domain}`);
  const manifest = run ? parseJson(run.workflow_manifest_json) as { intent?: string; workflowGeneration?: { planId?: string }; tasks?: Array<{ id?: string }> } : {};
  if (manifest.intent !== "implement_feature") failures.push(`expected implement_feature intent, got ${manifest.intent ?? "missing"}`);
  if (!manifest.workflowGeneration?.planId) failures.push("missing workflow generation plan id");
  const taskIds = (manifest.tasks ?? []).map((task) => String(task.id ?? ""));
  if (taskIds.length < 5) failures.push(`expected at least 5 dynamic tasks, got ${taskIds.length}`);
  if (taskIds.join(",") === "planner,implementer,root-validator,summary") failures.push("workflow still uses fixed four-task shape");
  const executedTaskIds = (db.prepare("select id from workflow_tasks where run_id = ? and status in ('running','completed','passed')").all(input.runId) as Array<{ id: string }>).map((row) => row.id);
  for (const taskId of executedTaskIds) {
    requireResource(db, failures, input.runId, taskId, "task_envelope_v2");
    requireResource(db, failures, input.runId, taskId, "context_packet");
    requireResource(db, failures, input.runId, taskId, "memory_injection_trace");
    requireResource(db, failures, input.runId, taskId, "session_checkpoint");
  }
  requireRunResource(db, failures, input.runId, "workspace_snapshot");
  requireRunResource(db, failures, input.runId, "executor_binding");
  requireRunResource(db, failures, input.runId, "evaluator_pipeline_result");
  const stopCondition = listResources(db, { resourceType: "stop_condition_result" }).find((resource) => resource.runId === input.runId && resource.status === "passed");
  if (!stopCondition) failures.push("missing passed stop condition result");
  if (run && !["passed", "completed"].includes(run.status)) failures.push(`run did not complete after stop condition: ${run.status}`);
  if (!Number.isFinite(input.firstWorkflowVisibleMs)) failures.push("browser did not show workflow");
  if (!Number.isFinite(input.taskDetailVisibleMs)) failures.push("browser did not show task detail");
  if (!Number.isFinite(input.stopConditionVisibleMs)) failures.push("browser did not show stop condition");
  checkCliArtifact(input.repo, failures);
  return { ok: failures.length === 0, failures };
}

function requireResource(db: SouthstarDb, failures: string[], runId: string, taskId: string, resourceType: string): void {
  const found = listResources(db, { resourceType }).some((resource) => resource.runId === runId && resource.taskId === taskId);
  if (!found) failures.push(`missing ${resourceType} for task ${taskId}`);
}

function requireRunResource(db: SouthstarDb, failures: string[], runId: string, resourceType: string): void {
  const found = listResources(db, { resourceType }).some((resource) => resource.runId === runId);
  if (!found) failures.push(`missing ${resourceType} for run ${runId}`);
}

function checkCliArtifact(repo: string, failures: string[]): void {
  try {
    const positive = execFileSync("npm", ["run", "-s", "cli", "--", "sum", "1", "2", "3"], { cwd: repo, encoding: "utf8" }).trim();
    if (positive !== "6") failures.push(`expected sum 1 2 3 to print 6, got ${positive}`);
    const decimal = execFileSync("npm", ["run", "-s", "cli", "--", "sum", "-2", "3.5", "4"], { cwd: repo, encoding: "utf8" }).trim();
    if (decimal !== "5.5") failures.push(`expected decimal sum to print 5.5, got ${decimal}`);
    execFileSync("npm", ["test"], { cwd: repo, encoding: "utf8" });
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    for (const required of ["sum 1 2 3", "sum -2 3.5 4", "sum 1 nope"]) {
      if (!readme.includes(required)) failures.push(`README missing example: ${required}`);
    }
  } catch (error) {
    failures.push((error as Error).message);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Register the unit test**

Modify `tests/v2/index.test.ts`:

```ts
await import("./ui-control-plane-gates.test.ts");
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-control-plane-gates.test.ts
```

Expected:

```text
ok
```

- [ ] **Step 6: Commit**

```bash
git add src/v2/quality/ui-control-plane-gates.ts tests/v2/ui-control-plane-gates.test.ts tests/v2/index.test.ts
git commit -m "test: add ui control plane quantitative gates"
```

## Task 3: Add Control-Plane Read Models and Runtime Routes

**Files:**

- Create: `src/v2/ui-api/control-plane-read-models.ts`
- Modify: `src/v2/ui-api/read-models.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `tests/v2/server-api.test.ts`
- Modify: `tests/v2/ui-read-models.test.ts`

- [ ] **Step 1: Add failing read-model assertions**

Extend `tests/v2/ui-read-models.test.ts` with:

```ts
import { buildControlPlaneRunModel, buildControlPlaneTaskModel } from "../../src/v2/ui-api/control-plane-read-models.ts";

test("control-plane run model includes workflow, runtime, memory, session, worktree, executor, evaluator, and stop condition evidence", () => {
  const db = seededDb();
  upsertRuntimeResource(db, { resourceType: "context_packet", resourceKey: "ctx-task-1", runId: "run-1", taskId: "task-1", scope: "task", status: "created", payload: { id: "ctx-task-1", tokenBudget: 1000 } });
  upsertRuntimeResource(db, { resourceType: "memory_injection_trace", resourceKey: "mem-task-1", runId: "run-1", taskId: "task-1", scope: "task", status: "created", payload: { injected: [{ id: "mem-1", reason: "similar-plan" }], excluded: [] } });
  upsertRuntimeResource(db, { resourceType: "workspace_snapshot", resourceKey: "ws-task-1", runId: "run-1", taskId: "task-1", scope: "workspace", status: "created", payload: { provider: "git", commitSha: "abc123" } });
  upsertRuntimeResource(db, { resourceType: "evaluator_pipeline_result", resourceKey: "eval-task-1", runId: "run-1", taskId: "task-1", scope: "evaluator", status: "passed", payload: { gates: [] } });
  upsertRuntimeResource(db, { resourceType: "stop_condition_result", resourceKey: "stop-run-1", runId: "run-1", scope: "run", status: "passed", payload: { status: "passed" } });

  const run = buildControlPlaneRunModel(db, "run-1");
  const task = buildControlPlaneTaskModel(db, "run-1", "task-1");

  assert.equal(run.workflow.nodes.length, 1);
  assert.equal(run.runtime.stopCondition?.status, "passed");
  assert.equal(run.worktree.snapshots.length, 1);
  assert.equal(task?.contextPacket?.resourceKey, "ctx-task-1");
  assert.equal(task?.memoryTrace?.resourceKey, "mem-task-1");
  assert.equal(task?.evaluator?.status, "passed");
});
```

- [ ] **Step 2: Run test and verify it fails because the module does not exist**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-models.test.ts
```

Expected:

```text
Cannot find module '../../src/v2/ui-api/control-plane-read-models.ts'
```

- [ ] **Step 3: Implement typed read models**

Create `src/v2/ui-api/control-plane-read-models.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources, type RuntimeResourceRecord } from "../stores/resource-store.ts";
import { buildWorkflowCanvasModel, buildRuntimeMonitorModel, buildTaskDetailModel } from "./read-models.ts";

export function buildControlPlaneRunModel(db: SouthstarDb, runId: string) {
  const run = db.prepare("select id, status, domain, goal_prompt, workflow_manifest_json from workflow_runs where id = ?").get(runId) as {
    id: string;
    status: string;
    domain: string;
    goal_prompt: string;
    workflow_manifest_json: string;
  } | undefined;
  if (!run) throw new Error(`workflow run not found: ${runId}`);
  const resources = resourcesForRun(db, runId);
  return {
    run: {
      id: run.id,
      status: run.status,
      domain: run.domain,
      goalPrompt: run.goal_prompt,
      workflow: safeJson(run.workflow_manifest_json),
    },
    workflow: buildWorkflowCanvasModel(db, runId),
    runtime: {
      ...buildRuntimeMonitorModel(db, runId),
      events: listHistoryForRun(db, runId),
      evaluatorResults: resourcesByType(resources, "evaluator_pipeline_result"),
      stopCondition: resourcesByType(resources, "stop_condition_result").find((resource) => resource.status === "passed")
        ?? resourcesByType(resources, "stop_condition_result")[0],
    },
    sessionsMemory: {
      sessions: resources.filter((resource) => ["session", "session_node", "session_checkpoint", "recovery_decision"].includes(resource.resourceType)),
      memories: resources.filter((resource) => ["memory_item", "memory_delta", "memory_injection_trace"].includes(resource.resourceType)),
    },
    worktree: {
      snapshots: resourcesByType(resources, "workspace_snapshot"),
      forks: resourcesByType(resources, "workspace_fork"),
      rollbacks: resourcesByType(resources, "workspace_rollback"),
    },
    executor: {
      bindings: resourcesByType(resources, "executor_binding"),
      events: resourcesByType(resources, "executor_event"),
    },
    domainPacks: {
      snapshots: resourcesByType(resources, "domain_pack_snapshot"),
      skills: resourcesByType(resources, "skill_snapshot"),
      mcpGrants: resourcesByType(resources, "mcp_grant"),
    },
    approvals: resources.filter((resource) => ["approval", "approval_decision"].includes(resource.resourceType)),
  };
}

export function buildControlPlaneTaskModel(db: SouthstarDb, runId: string, taskId: string) {
  const task = buildTaskDetailModel(db, runId, taskId);
  if (!task) return null;
  const resources = resourcesForRun(db, runId).filter((resource) => resource.taskId === taskId || resource.scope === "run");
  return {
    task,
    envelope: firstResource(resources, "task_envelope_v2"),
    contextPacket: firstResource(resources, "context_packet"),
    memoryTrace: firstResource(resources, "memory_injection_trace"),
    sessionCheckpoints: resourcesByType(resources, "session_checkpoint"),
    workspaceSnapshots: resourcesByType(resources, "workspace_snapshot"),
    executorBinding: firstResource(resources, "executor_binding"),
    evaluator: firstResource(resources, "evaluator_pipeline_result"),
    stopCondition: firstResource(resources, "stop_condition_result"),
    artifacts: resourcesByType(resources, "artifact"),
    logs: listHistoryForRun(db, runId).filter((event) => event.taskId === taskId),
  };
}

const controlPlaneResourceTypes = [
  "artifact",
  "approval",
  "approval_decision",
  "context_packet",
  "domain_pack_snapshot",
  "evaluator_pipeline_result",
  "executor_binding",
  "executor_event",
  "mcp_grant",
  "memory_delta",
  "memory_injection_trace",
  "memory_item",
  "recovery_decision",
  "session",
  "session_checkpoint",
  "session_node",
  "skill_snapshot",
  "stop_condition_result",
  "workspace_fork",
  "workspace_rollback",
  "workspace_snapshot",
] as const;

function resourcesForRun(db: SouthstarDb, runId: string): RuntimeResourceRecord[] {
  return controlPlaneResourceTypes
    .flatMap((resourceType) => listResources(db, { resourceType }))
    .filter((resource) => resource.runId === runId);
}

function resourcesByType(resources: RuntimeResourceRecord[], resourceType: string): RuntimeResourceRecord[] {
  return resources.filter((resource) => resource.resourceType === resourceType);
}

function firstResource(resources: RuntimeResourceRecord[], resourceType: string): RuntimeResourceRecord | null {
  return resourcesByType(resources, resourceType)[0] ?? null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Add routes**

Modify `src/v2/server/routes.ts` imports:

```ts
import { buildControlPlaneRunModel, buildControlPlaneTaskModel } from "../ui-api/control-plane-read-models.ts";
```

Add before the generic task route:

```ts
const controlPlaneRunMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/control-plane$/);
if (request.method === "GET" && controlPlaneRunMatch) {
  return json("control-plane-run", buildControlPlaneRunModel(context.db, decodeURIComponent(controlPlaneRunMatch[1]!)));
}

const controlPlaneTaskMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/control-plane$/);
if (request.method === "GET" && controlPlaneTaskMatch) {
  const model = buildControlPlaneTaskModel(context.db, decodeURIComponent(controlPlaneTaskMatch[1]!), decodeURIComponent(controlPlaneTaskMatch[2]!));
  if (!model) throw new Error(`task not found: ${controlPlaneTaskMatch[1]}/${controlPlaneTaskMatch[2]}`);
  return json("control-plane-task", model);
}
```

- [ ] **Step 5: Add runtime client methods**

Modify `src/v2/server/client.ts`:

```ts
getControlPlaneRun(runId: string) {
  return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/control-plane`);
},
getControlPlaneTask(body: { runId: string; taskId: string }) {
  return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/tasks/${encodeURIComponent(body.taskId)}/control-plane`);
},
```

- [ ] **Step 6: Add server API test**

Extend `tests/v2/server-api.test.ts` first test after callback:

```ts
const controlPlane = await client.getControlPlaneRun(run.result.runId);
const controlPlaneTask = await client.getControlPlaneTask({ runId: run.result.runId, taskId });
assert.equal(controlPlane.kind, "control-plane-run");
assert.equal((controlPlane.result as { run: { id: string } }).run.id, run.result.runId);
assert.equal(controlPlaneTask.kind, "control-plane-task");
assert.equal((controlPlaneTask.result as { task: { id: string } }).task.id, taskId);
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-models.test.ts tests/v2/server-api.test.ts
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit**

```bash
git add src/v2/ui-api/control-plane-read-models.ts src/v2/ui-api/read-models.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/ui-read-models.test.ts tests/v2/server-api.test.ts
git commit -m "feat: expose control plane read models"
```

## Task 4: Add Session and Worktree Operation APIs

**Files:**

- Create: `src/v2/ui-api/session-worktree-operations.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `tests/v2/server-api.test.ts`

- [ ] **Step 1: Add failing server tests for operation APIs**

Add to `tests/v2/server-api.test.ts`:

```ts
test("runtime server exposes session and worktree operation APIs with durable decisions", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-ops-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider([]),
  });
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const run = await client.runGoal({ goalPrompt: "Add calc sum" });
    const runId = run.result.runId;
    const taskId = "implement-feature";
    await client.getTaskEnvelope({ runId, taskId });
    const checkpoint = listResources(db, { resourceType: "session_checkpoint" }).find((resource) => resource.runId === runId && resource.taskId === taskId);
    assert.ok(checkpoint, "task envelope materialization must create a session checkpoint");
    const checkpointId = checkpoint.resourceKey;
    const fork = await client.forkSession({ runId, checkpointId, reason: "server test fork" });
    const reset = await client.resetSession({ runId, checkpointId, reason: "server test reset" });
    const rollbackPreview = await client.previewSessionRollback({ runId, checkpointId, reason: "server test preview" });
    assert.equal(fork.kind, "session-fork");
    assert.equal(reset.kind, "session-reset");
    assert.equal(rollbackPreview.kind, "session-rollback-preview");
    assert.equal(listResources(db, { resourceType: "recovery_decision" }).length >= 2, true);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
npm run test:v2 -- tests/v2/server-api.test.ts
```

Expected:

```text
Property 'forkSession' does not exist
```

- [ ] **Step 3: Implement operation helpers**

Create `src/v2/ui-api/session-worktree-operations.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { createSqliteSessionGraphProvider } from "../session-graph/sqlite-provider.ts";
import { createGitWorkspaceSnapshotProvider } from "../workspace/git-provider.ts";
import { appendRuntimeEvent } from "../signals/events.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";

export function forkSessionFromCheckpoint(db: SouthstarDb, input: { runId: string; checkpointId: string; reason: string }) {
  const provider = createSqliteSessionGraphProvider(db);
  const fork = provider.fork({ runId: input.runId, baseCheckpointId: input.checkpointId, reason: input.reason });
  appendRuntimeEvent(db, { runId: input.runId, eventType: "root.decision.fork", actorType: "root-session", payload: fork });
  return fork;
}

export function resetSessionFromCheckpoint(db: SouthstarDb, input: { runId: string; checkpointId: string; reason: string }) {
  const provider = createSqliteSessionGraphProvider(db);
  const reset = provider.reset({ runId: input.runId, baseCheckpointId: input.checkpointId, reason: input.reason });
  appendRuntimeEvent(db, { runId: input.runId, eventType: "root.decision.reset", actorType: "root-session", payload: reset });
  return reset;
}

export function previewSessionRollback(db: SouthstarDb, input: { runId: string; checkpointId: string; reason: string }) {
  const preview = { runId: input.runId, checkpointId: input.checkpointId, reason: input.reason, destructive: false };
  upsertRuntimeResource(db, { resourceType: "session_rollback_preview", resourceKey: `session-preview-${input.checkpointId}`, runId: input.runId, scope: "session", status: "previewed", payload: preview });
  appendRuntimeEvent(db, { runId: input.runId, eventType: "session.rollback.previewed", actorType: "root-session", payload: preview });
  return preview;
}

export function snapshotWorkspace(db: SouthstarDb, input: { runId: string; taskId?: string; repoRoot: string; reason: string }) {
  const snapshot = createGitWorkspaceSnapshotProvider().snapshot({ repoRoot: input.repoRoot, reason: input.reason });
  upsertRuntimeResource(db, { resourceType: "workspace_snapshot", resourceKey: `workspace-${Date.now()}`, runId: input.runId, taskId: input.taskId, scope: "workspace", status: "created", payload: snapshot });
  appendRuntimeEvent(db, { runId: input.runId, taskId: input.taskId, eventType: "workspace.snapshot.created", actorType: "orchestrator", payload: snapshot });
  return snapshot;
}
```

- [ ] **Step 4: Add routes**

In `src/v2/server/routes.ts`, import:

```ts
import { forkSessionFromCheckpoint, previewSessionRollback, resetSessionFromCheckpoint, snapshotWorkspace } from "../ui-api/session-worktree-operations.ts";
```

Add route handlers:

```ts
const sessionForkMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/sessions\/fork$/);
if (request.method === "POST" && sessionForkMatch) {
  const body = await readJsonBody<{ checkpointId?: string; reason?: string }>(request);
  if (!body.checkpointId) throw new Error("checkpointId is required");
  if (!body.reason) throw new Error("reason is required");
  return json("session-fork", forkSessionFromCheckpoint(context.db, { runId: decodeURIComponent(sessionForkMatch[1]!), checkpointId: body.checkpointId, reason: body.reason }));
}

const sessionResetMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/sessions\/reset$/);
if (request.method === "POST" && sessionResetMatch) {
  const body = await readJsonBody<{ checkpointId?: string; reason?: string }>(request);
  if (!body.checkpointId) throw new Error("checkpointId is required");
  if (!body.reason) throw new Error("reason is required");
  return json("session-reset", resetSessionFromCheckpoint(context.db, { runId: decodeURIComponent(sessionResetMatch[1]!), checkpointId: body.checkpointId, reason: body.reason }));
}

const sessionRollbackPreviewMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/sessions\/rollback-preview$/);
if (request.method === "POST" && sessionRollbackPreviewMatch) {
  const body = await readJsonBody<{ checkpointId?: string; reason?: string }>(request);
  if (!body.checkpointId) throw new Error("checkpointId is required");
  if (!body.reason) throw new Error("reason is required");
  return json("session-rollback-preview", previewSessionRollback(context.db, { runId: decodeURIComponent(sessionRollbackPreviewMatch[1]!), checkpointId: body.checkpointId, reason: body.reason }));
}

const workspaceSnapshotMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/worktrees\/snapshot$/);
if (request.method === "POST" && workspaceSnapshotMatch) {
  const body = await readJsonBody<{ repoRoot?: string; taskId?: string; reason?: string }>(request);
  if (!body.repoRoot) throw new Error("repoRoot is required");
  if (!body.reason) throw new Error("reason is required");
  return json("workspace-snapshot", snapshotWorkspace(context.db, { runId: decodeURIComponent(workspaceSnapshotMatch[1]!), repoRoot: body.repoRoot, taskId: body.taskId, reason: body.reason }));
}
```

- [ ] **Step 5: Add client methods**

Modify `src/v2/server/client.ts`:

```ts
forkSession(body: { runId: string; checkpointId: string; reason: string }) {
  return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/sessions/fork`, { checkpointId: body.checkpointId, reason: body.reason });
},
resetSession(body: { runId: string; checkpointId: string; reason: string }) {
  return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/sessions/reset`, { checkpointId: body.checkpointId, reason: body.reason });
},
previewSessionRollback(body: { runId: string; checkpointId: string; reason: string }) {
  return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/sessions/rollback-preview`, { checkpointId: body.checkpointId, reason: body.reason });
},
createWorkspaceSnapshot(body: { runId: string; repoRoot: string; taskId?: string; reason: string }) {
  return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/worktrees/snapshot`, { repoRoot: body.repoRoot, taskId: body.taskId, reason: body.reason });
},
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/server-api.test.ts
```

Expected:

```text
ok
```

- [ ] **Step 7: Commit**

```bash
git add src/v2/ui-api/session-worktree-operations.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/server-api.test.ts
git commit -m "feat: add session and worktree operation APIs"
```

## Task 5: Replace Static UI Shell with Runtime Client State

**Files:**

- Create: `components/southstar/types.ts`
- Create: `components/southstar/status.tsx`
- Modify: `lib/southstar/api-client.ts`
- Modify: `components/southstar/AppShell.tsx`
- Modify: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Add source-level UI tests rejecting inert controls**

Extend `tests/web/southstar-operations-ui.test.tsx`:

```ts
test("operations UI uses the Southstar API client and exposes real run/test ids", () => {
  const appShell = readFileSync(join(root, "components/southstar/AppShell.tsx"), "utf8");
  const apiClient = readFileSync(join(root, "lib/southstar/api-client.ts"), "utf8");
  assert.match(appShell, /createSouthstarApiClient/);
  assert.match(appShell, /data-testid="active-run-id"/);
  assert.match(appShell, /data-testid="selected-task-id"/);
  assert.match(apiClient, /getControlPlaneRun/);
  assert.match(apiClient, /getControlPlaneTask/);
});

test("operations panels no longer render static Ready labels", () => {
  const operations = readFileSync(join(root, "components/southstar/OperationsPanels.tsx"), "utf8");
  assert.doesNotMatch(operations, />Ready</);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
FAIL
Expected AppShell to use createSouthstarApiClient
```

- [ ] **Step 3: Add UI model types**

Create `components/southstar/types.ts`:

```ts
export type RuntimeResourceView = {
  id: string;
  resourceType: string;
  resourceKey: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  scope: string;
  status: string;
  title?: string;
  payload: unknown;
  summary?: unknown;
};

export type ControlPlaneRunView = {
  run: { id: string; status: string; domain: string; goalPrompt: string; workflow: unknown };
  workflow: { runId: string; status: string; nodes: Array<{ id: string; label: string; status: string; dependsOn: string[] }> };
  runtime: { status: string; events: Array<{ eventType: string; actorType: string; payload: unknown }>; stopCondition?: RuntimeResourceView };
  sessionsMemory: { sessions: RuntimeResourceView[]; memories: RuntimeResourceView[] };
  worktree: { snapshots: RuntimeResourceView[]; forks: RuntimeResourceView[]; rollbacks: RuntimeResourceView[] };
  executor: { bindings: RuntimeResourceView[]; events: RuntimeResourceView[] };
  domainPacks: { snapshots: RuntimeResourceView[]; skills: RuntimeResourceView[]; mcpGrants: RuntimeResourceView[] };
  approvals: RuntimeResourceView[];
};

export type ControlPlaneTaskView = {
  task: { id: string; taskKey: string; status: string; dependsOn: string[] };
  envelope: RuntimeResourceView | null;
  contextPacket: RuntimeResourceView | null;
  memoryTrace: RuntimeResourceView | null;
  sessionCheckpoints: RuntimeResourceView[];
  workspaceSnapshots: RuntimeResourceView[];
  executorBinding: RuntimeResourceView | null;
  evaluator: RuntimeResourceView | null;
  stopCondition: RuntimeResourceView | null;
  artifacts: RuntimeResourceView[];
  logs: Array<{ eventType: string; actorType: string; payload: unknown }>;
};
```

- [ ] **Step 4: Add status primitives**

Create `components/southstar/status.tsx`:

```tsx
export function StatusBadge({ status }: { status: string }) {
  return <span className={`ss-status ss-status-${status.toLowerCase()}`}>{status}</span>;
}

export function EmptyPanel({ label }: { label: string }) {
  return <div className="ss-empty-state">{label}</div>;
}
```

- [ ] **Step 5: Extend the browser API client**

Modify `lib/southstar/api-client.ts`:

```ts
export function createSouthstarApiClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    createDraft(goalPrompt: string) {
      return post(`${baseUrl}/api/v2/planner/drafts`, { goalPrompt });
    },
    runGoal(goalPrompt: string) {
      return post(`${baseUrl}/api/v2/run-goal`, { goalPrompt });
    },
    runDraft(draftId: string) {
      return post(`${baseUrl}/api/v2/runs`, { draftId });
    },
    getControlPlaneRun(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/control-plane`);
    },
    getControlPlaneTask(runId: string, taskId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/control-plane`);
    },
    getRunEvents(runId: string, afterSequence = 0) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/events?after=${afterSequence}`);
    },
    steer(runId: string, message: string) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/steering`, { message });
    },
    voiceTranscript(runId: string, transcript: string) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/voice-command`, { transcript });
    },
  };
}
```

Keep the existing `post` and `get` helpers.

- [ ] **Step 6: Wire AppShell state**

Modify `components/southstar/AppShell.tsx` to own API state:

```tsx
"use client";

import { useMemo, useState } from "react";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";
import { OperationsPanels } from "./OperationsPanels";
import { PlannerChat } from "./PlannerChat";
import { RuntimeMonitor } from "./RuntimeMonitor";
import { TaskDetail } from "./TaskDetail";
import type { ControlPlaneRunView, ControlPlaneTaskView } from "./types";
import type { SouthstarViewMode } from "./view-mode";
import { WorkflowCanvas } from "./WorkflowCanvas";

const runtimeBaseUrl = process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3100";

export function SouthstarOperationsApp() {
  const [mode, setMode] = useState<SouthstarViewMode>("simple");
  const [runModel, setRunModel] = useState<ControlPlaneRunView | null>(null);
  const [taskModel, setTaskModel] = useState<ControlPlaneTaskView | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const client = useMemo(() => createSouthstarApiClient({ baseUrl: runtimeBaseUrl }), []);

  async function refreshRun(runId: string, taskId?: string) {
    const run = await client.getControlPlaneRun(runId);
    const result = run.result as ControlPlaneRunView;
    setRunModel(result);
    const nextTaskId = taskId ?? selectedTaskId ?? result.workflow.nodes[0]?.id ?? "";
    setSelectedTaskId(nextTaskId);
    if (nextTaskId) {
      const task = await client.getControlPlaneTask(runId, nextTaskId);
      setTaskModel(task.result as ControlPlaneTaskView);
    }
  }

  return (
    <main className={`ss-app-shell ss-mode-${mode}`}>
      <aside className="ss-rail">
        <div className="ss-brand">Southstar v2</div>
        <nav>
          <a href="#planner-chat">Planner Chat</a>
          <a href="#workflow-canvas">Workflow Canvas</a>
          <a href="#runtime-monitor">Runtime Monitor</a>
          <a href="#task-detail">Task Detail</a>
          <a href="#sessions-memory">Sessions/Memory</a>
          <a href="#worktree-console">Worktree</a>
          <a href="#executor-ops">Executor Ops</a>
          <a href="#domain-packs">Domain Packs</a>
        </nav>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <span data-testid="active-run-id">{runModel?.run.id ?? ""}</span>
          <span data-testid="selected-task-id">{selectedTaskId}</span>
          <div className="ss-toggle" aria-label="view mode">
            <button type="button" onClick={() => setMode("simple")} aria-pressed={mode === "simple"}>Simple</button>
            <button type="button" onClick={() => setMode("full")} aria-pressed={mode === "full"}>Full</button>
          </div>
        </header>
        <div className="ss-grid">
          <PlannerChat client={client} onRunCreated={(runId) => refreshRun(runId)} />
          <WorkflowCanvas model={runModel?.workflow ?? null} selectedTaskId={selectedTaskId} onSelectTask={(taskId) => {
            setSelectedTaskId(taskId);
            if (runModel?.run.id) void refreshRun(runModel.run.id, taskId);
          }} />
          <RuntimeMonitor model={runModel?.runtime ?? null} onRefresh={() => runModel?.run.id ? refreshRun(runModel.run.id) : undefined} />
          <TaskDetail model={taskModel} />
        </div>
        {mode === "full" ? <OperationsPanels runModel={runModel} taskModel={taskModel} /> : null}
      </section>
    </main>
  );
}
```

- [ ] **Step 7: Run UI source tests**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit**

```bash
git add components/southstar/types.ts components/southstar/status.tsx lib/southstar/api-client.ts components/southstar/AppShell.tsx tests/web/southstar-operations-ui.test.tsx
git commit -m "feat: wire operations app to runtime client"
```

## Task 6: Wire Planner Chat to Draft and Run APIs

**Files:**

- Modify: `components/southstar/PlannerChat.tsx`
- Modify: `app/globals.css`
- Modify: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Add source test for real handlers**

Extend `tests/web/southstar-operations-ui.test.tsx`:

```ts
test("planner chat buttons call runtime actions instead of rendering inert controls", () => {
  const planner = readFileSync(join(root, "components/southstar/PlannerChat.tsx"), "utf8");
  assert.match(planner, /onRunCreated/);
  assert.match(planner, /client\.createDraft/);
  assert.match(planner, /client\.runDraft|client\.runGoal/);
  assert.match(planner, /setDraft/);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
FAIL
PlannerChat does not call client.createDraft
```

- [ ] **Step 3: Replace PlannerChat implementation**

Modify `components/southstar/PlannerChat.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";

type PlannerChatProps = {
  client: SouthstarApiClient;
  onRunCreated(runId: string): void;
};

export function PlannerChat({ client, onRunCreated }: PlannerChatProps) {
  const [mode, setMode] = useState("goal");
  const [prompt, setPrompt] = useState("新增 CLI 指令 sum <numbers...>，支援負數、小數、invalid input，補 tests 與 README。");
  const [draft, setDraft] = useState<{ draftId: string; domain?: string; intent?: string } | null>(null);
  const [status, setStatus] = useState("Idle");

  async function sendToPlanner() {
    setStatus("Planning");
    const response = await client.createDraft(prompt);
    const result = response.result as { draftId: string; workflow?: { domain?: string; intent?: string } };
    setDraft({ draftId: result.draftId, domain: result.workflow?.domain ?? "software-change", intent: result.workflow?.intent ?? "implement-feature" });
    setStatus("Draft Ready");
  }

  async function run() {
    setStatus("Running");
    const response = draft
      ? await client.runDraft(draft.draftId)
      : await client.runGoal(prompt);
    const result = response.result as { runId: string };
    onRunCreated(result.runId);
    setStatus("Run Active");
  }

  return (
    <section className="ss-panel ss-planner" data-panel="planner-chat" id="planner-chat">
      <header>
        <h2>Planner Chat</h2>
        <select aria-label="input mode" value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="goal">Goal Prompt</option>
          <option value="steering">Steering</option>
          <option value="voice">Voice Transcript</option>
        </select>
      </header>
      <textarea aria-label="planner input" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <div className="ss-actions">
        <button type="button" onClick={sendToPlanner}>Send to Planner</button>
        <button type="button" disabled={!draft}>Review Draft</button>
        <button type="button" disabled={!draft}>Revise</button>
        <button type="button" onClick={run}>Run</button>
      </div>
      <div className="ss-run-readiness">
        <strong>{status}</strong>
        <span>{draft ? `${draft.domain} / ${draft.intent}` : "No draft yet"}</span>
        <span>Dynamic Workflow</span>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Add CSS for readiness block**

Append to `app/globals.css`:

```css
.ss-run-readiness {
  display: grid;
  gap: 6px;
  margin-top: 12px;
  padding: 10px;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius);
  background: var(--ss-panel-soft);
  font-size: 12px;
}
```

- [ ] **Step 5: Run UI source tests**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 6: Commit**

```bash
git add components/southstar/PlannerChat.tsx app/globals.css tests/web/southstar-operations-ui.test.tsx
git commit -m "feat: wire planner chat to runtime draft and run"
```

## Task 7: Render Real Workflow, Runtime, and Task Detail Data

**Files:**

- Modify: `components/southstar/WorkflowCanvas.tsx`
- Modify: `components/southstar/RuntimeMonitor.tsx`
- Modify: `components/southstar/TaskDetail.tsx`
- Modify: `app/globals.css`
- Modify: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Add source tests rejecting hard-coded sample nodes**

Extend `tests/web/southstar-operations-ui.test.tsx`:

```ts
test("workflow, runtime, and task detail render passed-in runtime models", () => {
  const workflow = readFileSync(join(root, "components/southstar/WorkflowCanvas.tsx"), "utf8");
  const runtime = readFileSync(join(root, "components/southstar/RuntimeMonitor.tsx"), "utf8");
  const task = readFileSync(join(root, "components/southstar/TaskDetail.tsx"), "utf8");
  assert.doesNotMatch(workflow, /const nodes =/);
  assert.match(workflow, /model\?\.nodes/);
  assert.match(runtime, /model\?\.events/);
  assert.match(task, /TaskEnvelopeV2/);
  assert.match(task, /ContextPacket/);
  assert.match(task, /Memory Injection Trace/);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
FAIL
WorkflowCanvas still contains const nodes
```

- [ ] **Step 3: Replace WorkflowCanvas**

Modify `components/southstar/WorkflowCanvas.tsx`:

```tsx
import { EmptyPanel, StatusBadge } from "./status";
import type { ControlPlaneRunView } from "./types";

type WorkflowCanvasProps = {
  model: ControlPlaneRunView["workflow"] | null;
  selectedTaskId: string;
  onSelectTask(taskId: string): void;
};

export function WorkflowCanvas({ model, selectedTaskId, onSelectTask }: WorkflowCanvasProps) {
  return (
    <section className="ss-panel ss-canvas" data-panel="workflow-canvas" id="workflow-canvas">
      <header>
        <h2>Workflow Canvas</h2>
        <span>Dynamic Workflow</span>
      </header>
      {!model ? <EmptyPanel label="Send a prompt to generate a workflow." /> : (
        <div className="ss-dag">
          {model.nodes.map((node) => (
            <button
              type="button"
              className={`ss-node ${node.id === selectedTaskId ? "ss-node-selected" : ""}`}
              key={node.id}
              onClick={() => onSelectTask(node.id)}
            >
              <strong>{node.label}</strong>
              <StatusBadge status={node.status} />
              <small>{node.dependsOn.length === 0 ? "root" : `depends: ${node.dependsOn.join(", ")}`}</small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Replace RuntimeMonitor**

Modify `components/southstar/RuntimeMonitor.tsx`:

```tsx
import { EmptyPanel, StatusBadge } from "./status";
import type { ControlPlaneRunView } from "./types";

type RuntimeMonitorProps = {
  model: ControlPlaneRunView["runtime"] | null;
  onRefresh(): void | Promise<void>;
};

export function RuntimeMonitor({ model, onRefresh }: RuntimeMonitorProps) {
  return (
    <section className="ss-panel ss-runtime" data-panel="runtime-monitor" id="runtime-monitor">
      <header>
        <h2>Runtime Monitor</h2>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </header>
      {!model ? <EmptyPanel label="No active run." /> : (
        <>
          <div className="ss-stop-condition">
            <strong>{model.stopCondition?.status === "passed" ? "STOP CONDITION PASSED" : "Stop Condition"}</strong>
            <StatusBadge status={model.stopCondition?.status ?? model.status} />
          </div>
          <table>
            <tbody>
              {model.events.slice(-12).map((event, index) => (
                <tr key={`${event.eventType}-${index}`}>
                  <td>{event.eventType}</td>
                  <td>{event.actorType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Replace TaskDetail**

Modify `components/southstar/TaskDetail.tsx`:

```tsx
import { EmptyPanel, StatusBadge } from "./status";
import type { ControlPlaneTaskView } from "./types";

export function TaskDetail({ model }: { model: ControlPlaneTaskView | null }) {
  return (
    <section className="ss-panel" data-panel="task-detail" id="task-detail">
      <header>
        <h2>Task Detail</h2>
        <span>{model?.task.id ?? "No task"}</span>
      </header>
      {!model ? <EmptyPanel label="Select a task after starting a run." /> : (
        <div className="ss-detail-grid">
          <section>
            <h3>TaskEnvelopeV2</h3>
            <StatusBadge status={model.envelope?.status ?? "missing"} />
            <pre>{JSON.stringify(model.envelope?.payload ?? {}, null, 2)}</pre>
          </section>
          <section>
            <h3>ContextPacket</h3>
            <pre>{JSON.stringify(model.contextPacket?.payload ?? {}, null, 2)}</pre>
          </section>
          <section>
            <h3>Memory Injection Trace</h3>
            <pre>{JSON.stringify(model.memoryTrace?.payload ?? {}, null, 2)}</pre>
          </section>
          <section>
            <h3>Evaluator Pipeline</h3>
            <StatusBadge status={model.evaluator?.status ?? "pending"} />
          </section>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Add CSS**

Append to `app/globals.css`:

```css
.ss-node-selected {
  outline: 2px solid var(--ss-blue);
}

.ss-node small {
  color: var(--ss-muted);
  font-size: 11px;
}

.ss-status {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  border-radius: 6px;
  padding: 2px 6px;
  border: 1px solid var(--ss-border);
  background: var(--ss-panel-soft);
  font-size: 11px;
}

.ss-status-passed,
.ss-status-completed,
.ss-status-created {
  color: var(--ss-green);
}

.ss-status-running {
  color: var(--ss-blue);
}

.ss-status-pending {
  color: var(--ss-amber);
}

.ss-status-failed,
.ss-status-missing {
  color: var(--ss-red);
}

.ss-detail-grid {
  display: grid;
  gap: 10px;
}

.ss-detail-grid h3 {
  margin: 0 0 6px;
  font-size: 12px;
}

.ss-detail-grid pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius);
  background: var(--ss-panel-soft);
  font-family: var(--ss-mono);
  font-size: 11px;
}

.ss-stop-condition {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 10px 0;
}
```

- [ ] **Step 7: Run UI tests**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit**

```bash
git add components/southstar/WorkflowCanvas.tsx components/southstar/RuntimeMonitor.tsx components/southstar/TaskDetail.tsx app/globals.css tests/web/southstar-operations-ui.test.tsx
git commit -m "feat: render runtime workflow and task detail data"
```

## Task 8: Replace Full-Mode Placeholders with Sessions, Worktree, Executor, Domain, and Approval Panels

**Files:**

- Create: `components/southstar/SessionsMemoryPanel.tsx`
- Create: `components/southstar/WorktreePanel.tsx`
- Create: `components/southstar/ExecutorOpsPanel.tsx`
- Create: `components/southstar/DomainPacksPanel.tsx`
- Create: `components/southstar/VaultMcpApprovalPanel.tsx`
- Modify: `components/southstar/OperationsPanels.tsx`
- Modify: `components/southstar/view-mode.ts`
- Modify: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Add source tests for full-mode panels**

Extend `tests/web/southstar-operations-ui.test.tsx`:

```ts
test("full-mode operation panels expose real loop engineering surfaces", () => {
  const operations = readFileSync(join(root, "components/southstar/OperationsPanels.tsx"), "utf8");
  assert.match(operations, /SessionsMemoryPanel/);
  assert.match(operations, /WorktreePanel/);
  assert.match(operations, /ExecutorOpsPanel/);
  assert.match(operations, /DomainPacksPanel/);
  assert.match(operations, /VaultMcpApprovalPanel/);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
FAIL
OperationsPanels does not import SessionsMemoryPanel
```

- [ ] **Step 3: Create SessionsMemoryPanel**

```tsx
import type { ControlPlaneRunView } from "./types";

export function SessionsMemoryPanel({ model }: { model: ControlPlaneRunView | null }) {
  return (
    <article className="ss-panel ss-small-panel" data-panel="sessions-memory" id="sessions-memory">
      <h2>Sessions / Memory</h2>
      <p>{model ? `${model.sessionsMemory.sessions.length} session resources` : "No run selected"}</p>
      <p>{model ? `${model.sessionsMemory.memories.length} memory resources` : "Memory trace appears after ContextPacket build"}</p>
    </article>
  );
}
```

- [ ] **Step 4: Create WorktreePanel**

```tsx
import type { ControlPlaneRunView } from "./types";

export function WorktreePanel({ model }: { model: ControlPlaneRunView | null }) {
  return (
    <article className="ss-panel ss-small-panel" data-panel="worktree-console" id="worktree-console">
      <h2>Worktree Console</h2>
      <p>{model ? `${model.worktree.snapshots.length} workspace snapshots` : "No workspace snapshot yet"}</p>
      <p>Git/worktree manages workspace state; SessionGraph manages run lineage.</p>
    </article>
  );
}
```

- [ ] **Step 5: Create ExecutorOpsPanel**

```tsx
import type { ControlPlaneRunView } from "./types";

export function ExecutorOpsPanel({ model }: { model: ControlPlaneRunView | null }) {
  return (
    <article className="ss-panel ss-small-panel" data-panel="executor-ops" id="executor-ops">
      <h2>Executor Ops</h2>
      <p>Tork executes tasks only.</p>
      <p>{model ? `${model.executor.bindings.length} executor bindings` : "No executor binding yet"}</p>
    </article>
  );
}
```

- [ ] **Step 6: Create DomainPacksPanel**

```tsx
import type { ControlPlaneRunView } from "./types";

export function DomainPacksPanel({ model }: { model: ControlPlaneRunView | null }) {
  return (
    <article className="ss-panel ss-small-panel" data-panel="domain-packs" id="domain-packs">
      <h2>Domain Packs</h2>
      <p>Read-only Agent Studio</p>
      <p>{model ? `${model.domainPacks.skills.length} skill snapshots` : "No domain pack snapshot yet"}</p>
    </article>
  );
}
```

- [ ] **Step 7: Create VaultMcpApprovalPanel**

```tsx
import type { ControlPlaneRunView } from "./types";

export function VaultMcpApprovalPanel({ model }: { model: ControlPlaneRunView | null }) {
  return (
    <article className="ss-panel ss-small-panel" data-panel="vault-mcp" id="vault-mcp">
      <h2>Vault / MCP + Approval Policy</h2>
      <p>{model ? `${model.domainPacks.mcpGrants.length} MCP grants` : "No MCP grants yet"}</p>
      <p>{model ? `${model.approvals.length} approval resources` : "No approval queue yet"}</p>
    </article>
  );
}
```

- [ ] **Step 8: Replace OperationsPanels**

Modify `components/southstar/OperationsPanels.tsx`:

```tsx
import { DomainPacksPanel } from "./DomainPacksPanel";
import { ExecutorOpsPanel } from "./ExecutorOpsPanel";
import { SessionsMemoryPanel } from "./SessionsMemoryPanel";
import type { ControlPlaneRunView, ControlPlaneTaskView } from "./types";
import { VaultMcpApprovalPanel } from "./VaultMcpApprovalPanel";
import { WorktreePanel } from "./WorktreePanel";

export function OperationsPanels({ runModel }: { runModel: ControlPlaneRunView | null; taskModel: ControlPlaneTaskView | null }) {
  return (
    <section className="ss-ops-panels">
      <SessionsMemoryPanel model={runModel} />
      <WorktreePanel model={runModel} />
      <ExecutorOpsPanel model={runModel} />
      <DomainPacksPanel model={runModel} />
      <VaultMcpApprovalPanel model={runModel} />
    </section>
  );
}
```

- [ ] **Step 9: Keep view mode ids aligned**

Modify `components/southstar/view-mode.ts` so full mode includes:

```ts
"sessions-memory",
"worktree-console",
"executor-ops",
"domain-packs",
"vault-mcp",
"approval-policy",
```

- [ ] **Step 10: Run tests**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 11: Commit**

```bash
git add components/southstar/SessionsMemoryPanel.tsx components/southstar/WorktreePanel.tsx components/southstar/ExecutorOpsPanel.tsx components/southstar/DomainPacksPanel.tsx components/southstar/VaultMcpApprovalPanel.tsx components/southstar/OperationsPanels.tsx components/southstar/view-mode.ts tests/web/southstar-operations-ui.test.tsx
git commit -m "feat: add real full-mode control plane panels"
```

## Task 9: Persist Missing Runtime Resources During Task Materialization and Completion

**Files:**

- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/context/builder.ts`
- Modify: `src/v2/executor/tork-callback.ts`
- Modify: `src/v2/evaluators/pipeline.ts`
- Modify: `tests/v2/local-api.test.ts`
- Modify: `tests/v2/context-builder.test.ts`
- Modify: `tests/v2/evaluator-pipeline.test.ts`

- [ ] **Step 1: Add failing assertions for resource names required by UI gates**

In `tests/v2/local-api.test.ts`, add assertions after `createRunFromDraft`:

```ts
assert.equal(listResources(db, { resourceType: "workspace_snapshot" }).length > 0, true, "run must create workspace snapshot resources");
assert.equal(listResources(db, { resourceType: "domain_pack_snapshot" }).length > 0, true, "run must create domain pack snapshot resources");
```

In `tests/v2/context-builder.test.ts`, assert:

```ts
assert.equal(listResources(db, { resourceType: "context_packet" }).length > 0, true);
assert.equal(listResources(db, { resourceType: "memory_injection_trace" }).length > 0, true);
```

In `tests/v2/evaluator-pipeline.test.ts`, assert:

```ts
assert.equal(listResources(db, { resourceType: "evaluator_pipeline_result" }).some((resource) => resource.status === "passed"), true);
assert.equal(listResources(db, { resourceType: "stop_condition_result" }).some((resource) => resource.status === "passed"), true);
```

- [ ] **Step 2: Run and verify failures**

Run:

```bash
npm run test:v2 -- tests/v2/local-api.test.ts tests/v2/context-builder.test.ts tests/v2/evaluator-pipeline.test.ts
```

Expected:

```text
FAIL
missing workspace_snapshot, domain_pack_snapshot, memory_injection_trace, evaluator_pipeline_result, or stop_condition_result
```

- [ ] **Step 3: Persist canonical UI resources using existing lifecycle points**

Implementation rule:

- In `src/v2/ui-api/local-api.ts`, when run/task materialization already creates snapshots or domain pack data, write resource types exactly:
  - `domain_pack_snapshot`
  - `workspace_snapshot`
  - `task_envelope_v2`
- In `src/v2/context/builder.ts`, when ContextPacket is persisted, write:
  - `context_packet`
  - `memory_injection_trace`
- In `src/v2/evaluators/pipeline.ts` or callback ingestion, when evaluator runs, write:
  - `evaluator_pipeline_result`
  - `stop_condition_result`

Use this resource shape:

```ts
upsertRuntimeResource(db, {
  resourceType: "memory_injection_trace",
  resourceKey: `memory-trace-${runId}-${taskId}`,
  runId,
  taskId,
  scope: "task",
  status: "created",
  title: "Memory injection trace",
  payload: {
    contextPacketId,
    injected: selectedMemories,
    excluded: excludedMemories,
    emptyReason: selectedMemories.length === 0 ? "no relevant approved memory candidates" : undefined,
  },
});
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm run test:v2 -- tests/v2/local-api.test.ts tests/v2/context-builder.test.ts tests/v2/evaluator-pipeline.test.ts
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

```bash
git add src/v2/ui-api/local-api.ts src/v2/context/builder.ts src/v2/executor/tork-callback.ts src/v2/evaluators/pipeline.ts tests/v2/local-api.test.ts tests/v2/context-builder.test.ts tests/v2/evaluator-pipeline.test.ts
git commit -m "feat: persist control plane runtime evidence resources"
```

## Task 10: Make Browser UI Poll Until Stop Condition Completion

**Files:**

- Modify: `components/southstar/AppShell.tsx`
- Modify: `components/southstar/RuntimeMonitor.tsx`
- Modify: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Add source test for refresh loop**

Extend `tests/web/southstar-operations-ui.test.tsx`:

```ts
test("app shell refreshes active runs until stop condition completes", () => {
  const appShell = readFileSync(join(root, "components/southstar/AppShell.tsx"), "utf8");
  assert.match(appShell, /setInterval/);
  assert.match(appShell, /stopCondition/);
  assert.match(appShell, /clearInterval/);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
FAIL
AppShell does not refresh active runs
```

- [ ] **Step 3: Add refresh loop**

Modify `components/southstar/AppShell.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
```

Add inside component:

```tsx
useEffect(() => {
  const runId = runModel?.run.id;
  const stopCondition = runModel?.runtime.stopCondition;
  if (!runId || stopCondition?.status === "passed") return;
  const timer = setInterval(() => {
    void refreshRun(runId);
  }, 1500);
  return () => clearInterval(timer);
}, [runModel?.run.id, runModel?.runtime.stopCondition?.status]);
```

- [ ] **Step 4: Run UI test**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 5: Commit**

```bash
git add components/southstar/AppShell.tsx tests/web/southstar-operations-ui.test.tsx
git commit -m "feat: poll active control plane runs until stop condition"
```

## Task 11: Pass the Real Browser E2E

**Files:**

- Modify: files identified by the E2E failure in `src/v2/`, `components/southstar/`, `lib/southstar/`, `tests/e2e-real/`, `tests/v2/`, `tests/web/`, or `app/globals.css`.
- Do not remove E2E assertions.
- Do not change the E2E to inspect only static text.

- [ ] **Step 1: Start local Tork and rebuild the agent image**

Run:

```bash
scripts/run-local-tork.sh
scripts/build-pi-agent-image.sh
```

Expected:

```text
Tork API reachable at http://127.0.0.1:8000
Successfully tagged southstar/pi-agent:local
```

- [ ] **Step 2: Run the real E2E suite**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected:

```text
phase15 browser operations scenario passed
all quantitative gates passed
```

The new scenario must also complete without changing the assertions in `tests/e2e-real/scenarios/ui-loop-engineering-control-plane.ts`.

- [ ] **Step 3: If the E2E fails, fix runtime/UI code, not the acceptance criteria**

Acceptable fixes:

- Add missing runtime resource writes.
- Add missing read-model fields.
- Fix UI refresh timing.
- Fix task selection after run creation.
- Fix executor callback ingestion.
- Fix evaluator or stop-condition resource persistence.

Unacceptable fixes:

- Replacing the real E2E with a static text check.
- Seeding passed rows in the test.
- Bypassing Tork/Docker.
- Marking run complete before stop condition passes.
- Removing CLI artifact assertions.

- [ ] **Step 4: Commit the passing E2E fixes**

```bash
git add src/v2 components/southstar lib/southstar tests/e2e-real tests/v2 tests/web app/globals.css
git commit -m "feat: complete real ui loop engineering e2e"
```

## Task 12: Final Verification

**Files:**

- No new files unless verification finds a defect.

- [ ] **Step 1: Run typecheck**

Run:

```bash
node_modules/.bin/tsc --noEmit
```

Expected:

```text
no output and exit code 0
```

- [ ] **Step 2: Run v2 tests**

Run:

```bash
npm run test:v2
```

Expected:

```text
all tests pass
```

- [ ] **Step 3: Run web tests**

Run:

```bash
node_modules/.bin/tsx tests/web/southstar-operations-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 4: Run real E2E**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected:

```text
all quantitative gates passed
```

- [ ] **Step 5: Inspect real fixture artifact**

Run in the fixture repo printed by the E2E:

```bash
npm run -s cli -- sum 1 2 3
npm run -s cli -- sum -2 3.5 4
npm run -s cli -- sum 1 nope
npm test
```

Expected:

```text
6
5.5
non-zero exit with Invalid number: nope
all tests pass
```

- [ ] **Step 6: Commit verification-only fixes when verification changed files**

If verification required changes:

```bash
git add src/v2 components/southstar lib/southstar tests/e2e-real tests/v2 tests/web app/globals.css
git commit -m "fix: stabilize ui runtime control plane verification"
```

If no changes were required, do not create an empty commit.

## Self-Review Checklist

Spec coverage:

- Prompt -> domain/intent is covered by Planner Chat and E2E gate.
- Dynamic workflow generation is covered by workflow task count and fixed-four-task rejection.
- TaskEnvelopeV2 is covered by read models, Task Detail, and gate counts.
- ContextPacket and memory trace are covered by read models, Task Detail, Sessions/Memory, and gate counts.
- Docker/Tork execution is covered by Executor Ops and executor binding gate.
- Tork executor-only boundary is covered by UI text and read-model separation.
- Evaluator and stop condition are covered by Runtime Monitor, Task Detail, and gate counts.
- Retry/fork/rollback/revision operations are covered by session/worktree operation APIs and UI action surfaces.
- Session checkpoint/fork/reset/rollback lineage is covered by operation APIs and Sessions/Memory.
- Git/worktree snapshot is covered by Worktree Console and workspace snapshot gate.
- Real browser E2E and meaningful artifact are covered by `ui-loop-engineering-control-plane.ts`.

Completion scan:

- No unfinished blank sections or vague acceptance gates.
- No instruction relies on static sample data as acceptance.
- No step asks the implementer to invent acceptance criteria.

Type consistency:

- Client methods added in `src/v2/server/client.ts` match routes added in `src/v2/server/routes.ts`.
- Browser client methods added in `lib/southstar/api-client.ts` match UI calls from `AppShell` and `PlannerChat`.
- UI model types in `components/southstar/types.ts` match fields returned by `buildControlPlaneRunModel` and `buildControlPlaneTaskModel`.

## Execution Notes

- Use an isolated worktree before implementation if the current working tree remains dirty.
- Do not revert unrelated changes already present in the workspace.
- Keep commits per task or per closely related task pair.
- Do not weaken E2E assertions to pass a timing issue; if quantitative duration exceeds a threshold while functionality passes, report it separately, but preserve the functional gate.

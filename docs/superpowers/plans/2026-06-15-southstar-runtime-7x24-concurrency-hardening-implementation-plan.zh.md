# Southstar Runtime 7x24 Concurrency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 runtime + API/read-model hardening，讓 heartbeat/reconcile/action 可自動執行並在 10 runs / 50 tasks 下穩定運作，且不破壞 Southstar completion truth。

**Architecture:** 在現有 v2 runtime 上新增背景 control loop（reconcile + action dispatch），補齊 runner heartbeat 注入、callback 冪等與 terminal monotonicity、SQLite 併發設定、Tork client 韌性，以及 read-model 觀測欄位。整體採分階段（A/B/C）但同次開發週期一次完成交付。

**Tech Stack:** TypeScript ESM, Node 22, node:test, node:sqlite, Southstar v2 runtime, Tork HTTP API。

---

## File Structure

### New files
- `src/v2/server/runtime-loops.ts` — reconcile loop lifecycle, single-flight/backoff/jitter, shutdown hook。
- `src/v2/executor/action-dispatcher.ts` — 根據 reconcile classification 執行 cancel/retry/alert 的自動 action。
- `tests/v2/runtime-loops.test.ts` — loop 啟停、single-flight、error backoff 測試。
- `tests/v2/callback-idempotency.test.ts` — callback receipt idempotency + terminal monotonicity 測試。

### Modified files
- `src/v2/server/http-server.ts`
- `src/v2/server/runtime-context.ts`
- `src/v2/server/routes.ts`
- `src/v2/executor/reconciler.ts`
- `src/v2/executor/tork-projection.ts`
- `src/v2/executor/tork-provider.ts`
- `src/v2/executor/tork-callback.ts`
- `src/v2/executor/tork-client.ts`
- `src/v2/stores/sqlite.ts`
- `src/v2/stores/history-store.ts`
- `src/v2/ui-api/page-models/executor.ts`
- `src/v2/ui-api/read-models.ts`
- `tests/v2/executor-observability.test.ts`
- `tests/v2/server-api.test.ts`
- `tests/v2/index.test.ts`
- `tests/e2e-real/scenarios/executor-observability-real.ts`

---

### Task 1: 建立 Runtime Loop 骨架（Phase A）

**Files:**
- Create: `src/v2/server/runtime-loops.ts`
- Modify: `src/v2/server/http-server.ts`
- Modify: `src/v2/server/runtime-context.ts`
- Test: `tests/v2/runtime-loops.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: 寫 failing test（loop 會啟動並可關閉）**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeLoopController } from "../../src/v2/server/runtime-loops.ts";

test("runtime loop starts once and stops cleanly", async () => {
  let calls = 0;
  const loop = createRuntimeLoopController({
    intervalMs: 10,
    runOnce: async () => { calls += 1; },
  });
  loop.start();
  await new Promise((r) => setTimeout(r, 35));
  await loop.stop();
  assert.ok(calls >= 1);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`
Expected: FAIL（`runtime-loops.ts` not found）

- [ ] **Step 3: 實作最小 loop controller**

```ts
export function createRuntimeLoopController(input: { intervalMs: number; runOnce: () => Promise<void> }) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = true;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try { await input.runOnce(); } finally { running = false; }
  }
  return {
    start() {
      if (timer) return;
      stopped = false;
      timer = setInterval(() => { void tick(); }, input.intervalMs);
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      while (running) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
```

- [ ] **Step 4: 在 http server 掛 loop lifecycle**

```ts
const reconcileLoop = context.createReconcileLoop?.();
reconcileLoop?.start();
// close()
await reconcileLoop?.stop();
```

- [ ] **Step 5: 跑測試確認通過並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/server/runtime-loops.ts src/v2/server/http-server.ts src/v2/server/runtime-context.ts tests/v2/runtime-loops.test.ts tests/v2/index.test.ts
git commit -m "feat: add runtime reconcile loop lifecycle"
```

---

### Task 2: 讓 Heartbeat 自動注入 Runner（Phase A）

**Files:**
- Modify: `src/v2/executor/tork-projection.ts`
- Modify: `src/v2/executor/tork-provider.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: 寫 failing test（projection env 包含 heartbeat）**

```ts
test("tork projection injects heartbeat url and attempt id", () => {
  const projection = buildTorkJobProjection(workflow, {
    runId: "run-1",
    callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
    heartbeatUrl: "http://127.0.0.1:3000/api/v2/executor/heartbeat",
    envelopeBasePath: "/southstar-runs",
  });
  const env = projection.job.tasks[0]!.env;
  assert.equal(env.SOUTHSTAR_HEARTBEAT_URL, "http://127.0.0.1:3000/api/v2/executor/heartbeat");
  assert.equal(env.SOUTHSTAR_ATTEMPT_ID, "attempt-1");
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`
Expected: FAIL（`heartbeatUrl` option 不存在）

- [ ] **Step 3: 擴充 projection options 並注入 env**

```ts
export type TorkProjectionOptions = {
  callbackUrl: string;
  heartbeatUrl?: string;
  envelopeBasePath: string;
  runId: string;
};

...(options.heartbeatUrl ? { SOUTHSTAR_HEARTBEAT_URL: options.heartbeatUrl } : {}),
SOUTHSTAR_ATTEMPT_ID: "attempt-1",
```

- [ ] **Step 4: 在 provider/local-api 串入 heartbeatUrl**

```ts
const projection = buildTorkJobProjection(request.workflow, {
  runId: request.runId,
  callbackUrl,
  heartbeatUrl: request.heartbeatUrl,
  envelopeBasePath,
});
```

- [ ] **Step 5: 跑測試並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/executor/tork-projection.ts src/v2/executor/tork-provider.ts src/v2/ui-api/local-api.ts tests/v2/executor-observability.test.ts
git commit -m "feat: inject heartbeat env into tork projection"
```

---

### Task 3: Callback 冪等與 Terminal Monotonicity（Phase A）

**Files:**
- Modify: `src/v2/executor/tork-callback.ts`
- Modify: `src/v2/server/routes.ts`
- Create: `tests/v2/callback-idempotency.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: 寫 failing tests（重送 callback 不重複入庫）**

```ts
test("duplicate callback is idempotent", () => {
  ingestTaskRunResult(db, payload);
  ingestTaskRunResult(db, payload);
  const artifacts = listResources(db, { resourceType: "artifact" }).filter((r) => r.runId === "run-1" && r.taskId === "task-1");
  assert.equal(artifacts.length, 1);
});
```

- [ ] **Step 2: 再加 failing test（terminal 任務不可被晚到 callback 翻轉）**

```ts
test("terminal task status is monotonic", () => {
  setTaskStatus("failed");
  ingestTaskRunResult(db, successPayload);
  const row = db.prepare("select status from workflow_tasks where run_id=? and id=?").get("run-1", "task-1") as { status: string };
  assert.equal(row.status, "failed");
});
```

- [ ] **Step 3: 跑測試確認失敗**

Run: `npm run test:v2`

- [ ] **Step 4: 在 callback ingress 加 receipt fence**

```ts
const receiptKey = `callback:${result.runId}:${result.taskId}:${result.attempts}:${hash(JSON.stringify(result.artifact))}`;
const exists = db.prepare("select 1 from workflow_history where run_id=? and idempotency_key=?").get(result.runId, receiptKey);
if (exists) return;
appendHistoryEvent(db, { runId: result.runId, taskId: result.taskId, eventType: "executor.callback_received", actorType: "executor", idempotencyKey: receiptKey, payload: { receiptKey } });
```

- [ ] **Step 5: 更新 task status 時套 monotonic 規則**

```ts
const current = readTaskStatus(db, runId, taskId);
if (["completed", "failed", "cancelled"].includes(current)) return;
updateTaskStatus(...);
```

- [ ] **Step 6: 跑測試並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/executor/tork-callback.ts src/v2/server/routes.ts tests/v2/callback-idempotency.test.ts tests/v2/index.test.ts
git commit -m "feat: harden callback idempotency and terminal monotonicity"
```

---

### Task 4: 自動 Action Dispatcher（Phase B）

**Files:**
- Create: `src/v2/executor/action-dispatcher.ts`
- Modify: `src/v2/executor/reconciler.ts`
- Modify: `src/v2/executor/policy.ts`
- Test: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: 寫 failing test（orphaned 會 auto cancel 並記 command）**

```ts
test("reconcile dispatches cancel command for orphaned binding", async () => {
  const commandsBefore = listResources(db, { resourceType: "executor_job_command" }).length;
  await reconcileExecutorBindings(db, { tork, actionMode: "auto" });
  const commandsAfter = listResources(db, { resourceType: "executor_job_command" }).length;
  assert.equal(commandsAfter, commandsBefore + 1);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`

- [ ] **Step 3: 新增 dispatcher**

```ts
export async function dispatchExecutorActions(db: SouthstarDb, input: { finding: ExecutorReconcileFinding; tork: TorkObservationClient }) {
  const key = `executor-action:${input.finding.bindingId}:${input.finding.classification}`;
  const exists = db.prepare("select 1 from workflow_history where run_id=? and idempotency_key=?").get(input.finding.runId, key);
  if (exists) return;
  if (input.finding.actions.includes("cancel-executor")) {
    await input.tork.cancelJob(input.finding.bindingId);
  }
  appendHistoryEvent(db, { runId: input.finding.runId, taskId: input.finding.taskId, eventType: "executor.action_dispatched", actorType: "orchestrator", idempotencyKey: key, payload: input.finding });
}
```

- [ ] **Step 4: reconcile 中串 dispatcher（auto mode）**

```ts
if (input.actionMode === "auto") {
  await dispatchExecutorActions(db, { finding, tork: input.tork });
}
```

- [ ] **Step 5: 跑測試並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/executor/action-dispatcher.ts src/v2/executor/reconciler.ts src/v2/executor/policy.ts tests/v2/executor-observability.test.ts
git commit -m "feat: add automatic reconcile action dispatcher"
```

---

### Task 5: SQLite 併發硬化（Phase B）

**Files:**
- Modify: `src/v2/stores/sqlite.ts`
- Modify: `src/v2/stores/history-store.ts`
- Test: `tests/v2/sqlite-store.test.ts`

- [ ] **Step 1: 寫 failing test（DB pragma 啟用）**

```ts
test("sqlite opens with wal and busy timeout", () => {
  const db = openSouthstarDb(":memory:");
  const mode = db.prepare("pragma journal_mode").get() as { journal_mode: string };
  const timeout = db.prepare("pragma busy_timeout").get() as { busy_timeout: number };
  assert.ok(["wal", "memory"].includes(mode.journal_mode.toLowerCase()));
  assert.ok(timeout.busy_timeout >= 5000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`

- [ ] **Step 3: sqlite 初始化加入 pragma**

```ts
const db = new DatabaseSync(path);
db.exec("pragma foreign_keys = on;");
db.exec("pragma journal_mode = WAL;");
db.exec("pragma busy_timeout = 5000;");
db.exec(SOUTHSTAR_V2_SCHEMA);
```

- [ ] **Step 4: history append 加唯一衝突重試**

```ts
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    // select next sequence + insert
    break;
  } catch (error) {
    if (!String((error as Error).message).includes("UNIQUE")) throw error;
    if (attempt === 2) throw error;
  }
}
```

- [ ] **Step 5: 跑測試並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/stores/sqlite.ts src/v2/stores/history-store.ts tests/v2/sqlite-store.test.ts
git commit -m "feat: harden sqlite for concurrent runtime writes"
```

---

### Task 6: Tork Client timeout/retry/backoff（Phase B）

**Files:**
- Modify: `src/v2/executor/tork-client.ts`
- Modify: `src/v2/executor/provider.ts`
- Test: `tests/v2/tork-client.test.ts`

- [ ] **Step 1: 寫 failing test（超時會拋可辨識錯誤）**

```ts
test("tork client aborts on timeout", async () => {
  const client = new TorkClient({ baseUrl: "http://127.0.0.1:9", requestTimeoutMs: 50, retryCount: 0 });
  await assert.rejects(() => client.getJob("job-1"), /timeout/i);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`

- [ ] **Step 3: 實作 request wrapper（AbortController + retry）**

```ts
private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (attempt === this.retryCount) throw new Error(`Tork request timeout/retry exhausted: ${(error as Error).message}`);
      await sleep(this.retryBaseMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}
```

- [ ] **Step 4: 跑測試並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/executor/tork-client.ts src/v2/executor/provider.ts tests/v2/tork-client.test.ts
git commit -m "feat: add timeout and retry backoff to tork client"
```

---

### Task 7: Read-model 補齊觀測欄位（Phase C）

**Files:**
- Modify: `src/v2/ui-api/page-models/executor.ts`
- Modify: `src/v2/ui-api/read-models.ts`
- Test: `tests/v2/server-api.test.ts`

- [ ] **Step 1: 寫 failing test（bindings API 回傳 lastHeartbeatAgeMs 等欄位）**

```ts
assert.equal(typeof model.bindings[0]?.lastHeartbeatAgeMs, "number");
assert.equal(typeof model.bindings[0]?.lastReconcileAt, "string");
assert.equal(typeof model.bindings[0]?.workflowTaskStatus, "string");
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`

- [ ] **Step 3: 實作欄位轉換**

```ts
lastHeartbeatAgeMs: payload.lastHeartbeatAt ? Date.now() - Date.parse(payload.lastHeartbeatAt) : null,
lastReconcileAt: payload.lastReconcileAt ?? null,
workflowTaskStatus: readWorkflowTaskStatus(...),
```

- [ ] **Step 4: 跑測試並 commit**

Run: `npm run test:v2`

```bash
git add src/v2/ui-api/page-models/executor.ts src/v2/ui-api/read-models.ts tests/v2/server-api.test.ts
git commit -m "feat: enrich executor read models for runtime observability"
```

---

### Task 8: Real E2E Gate（10/50 + reconcile p95 + 24h soak hook）（Phase C）

**Files:**
- Modify: `tests/e2e-real/scenarios/executor-observability-real.ts`
- Modify: `src/v2/quality/executor-observability-gates.ts`
- Modify: `tests/v2/executor-observability.test.ts`

- [ ] **Step 1: 寫 failing gate test（reconcile p95 門檻）**

```ts
const gate = assertExecutorObservabilityGates(db, {
  runId,
  maxReconcileP95Ms: 30_000,
  minBindings: 3,
});
assert.equal(gate.ok, true, gate.failures.join("\n"));
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run test:v2`

- [ ] **Step 3: 擴充 gate 計算（reconcile cycle duration / lag / stuck count）**

```ts
if (metrics.reconcileP95Ms > input.maxReconcileP95Ms) {
  failures.push(`reconcile p95 ${metrics.reconcileP95Ms} > ${input.maxReconcileP95Ms}`);
}
```

- [ ] **Step 4: 跑 v2 與 real e2e**

Run:
- `npm run test:v2`
- `SOUTHSTAR_DB=/tmp/southstar-executor-observability-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real`

Expected:
- v2 全綠
- real e2e fail-closed 且 gate 通過

- [ ] **Step 5: commit**

```bash
git add src/v2/quality/executor-observability-gates.ts tests/e2e-real/scenarios/executor-observability-real.ts tests/v2/executor-observability.test.ts
git commit -m "test: enforce runtime 7x24 observability gates"
```

---

## Final Verification Checklist

- [ ] `npm test`
- [ ] `npm run test:v2`
- [ ] `SOUTHSTAR_DB=/tmp/southstar-executor-observability-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real`
- [ ] `git status --short` 為乾淨
- [ ] 用 SQL 抽樣檢查 `executor_binding`、`executor_reconcile_result`、`executor_job_command` 有一致 evidence

## Spec Coverage Self-Review

- 背景 reconcile loop：Task 1 + Task 4。
- heartbeat 自動注入：Task 2。
- callback idempotency + monotonic：Task 3。
- 全自動 action（受 policy）：Task 4。
- SQLite 併發與穩定性：Task 5。
- 外部呼叫韌性：Task 6。
- API/read-model 控制面觀測：Task 7。
- 定量 gate + real E2E：Task 8。

無 placeholder / TODO；每 task 都有檔案、測試、命令與 commit。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-southstar-runtime-7x24-concurrency-hardening-implementation-plan.zh.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
# Southstar Runtime Control Plane API Completeness Design

日期：2026-06-23
狀態：design draft

## 1. 背景

Southstar v2 已完成 Postgres canonical runtime truth、managed runtime loop、Tork hand execution、runtime exception/recovery decision apply、managed context/session/memory，以及 real E2E case 25/26。下一步先不做 UI，也不移植 `~/apps/pi-web`。本設計只補齊 Southstar runtime API，使未來任何 UI，包括改造後的 pi-web，都能透過正式 API 操作 workflow 執行流程。

本階段的核心問題不是畫面，而是 API surface 是否完整覆蓋：

- normal workflow execution。
- Tork queued/running/terminal/timeout/lost 異常。
- Tork 內 agent、hand、brain、evaluator 異常。
- recovery decision、approval、apply、scheduler retry。
- session timeline、checkpoint、reset/fork/rollback。
- run-local memory、memory delta、approval/reject/invalidate。
- UI 未來需要的 read model、event stream 與 command response。

## 2. 目標

1. 補齊 P0 runtime control API，讓外部 UI 可不依賴 DB 直查、不依賴 transient process state、不使用 fake rows。
2. 讓每個 command 都有 durable command result、history event、resource/evidence refs 與 read-model 反映。
3. 統一 normal、Tork 異常、agent 異常、memory、session 的 API 查詢與操作語意。
4. 把既有 client 已暴露但 server 尚未實作的 run lifecycle command 補成正式 contract。
5. 把目前一次性 SSE response 改成可長連線、可重連的 event stream contract。
6. 公開 session store 與 memory service 中已存在但尚未成為 route 的能力。
7. 建立 API E2E 驗收矩陣，確保未來 UI 能以 API 完成 operator 工作流。

## 3. 非目標

- 不做 UI、mockup、Next.js app 或 pi-web 移植。
- 不把 Tork UI 或 Tork job state 當 workflow truth。
- 不新增另一套 workflow engine。
- 不讓 task/recovery command 直接繞過 scheduler submit Tork。
- 不在 P0 實作 domain-pack memory pinning、skill note conversion、workflow builder UI。
- 不重新引入 SQLite/V1/local-only API 作為 v2 runtime path。

## 4. 設計選項

### 4.1 選項 A：只補缺失 endpoint

優點是改動最小，可以快速補 `pause/resume/cancel`、memory approval route、session events route。缺點是 API contract 容易延續目前分散狀態：`executor_binding`、`hand_execution`、`managed-agents`、`runtime-monitor` 各自有不同 vocabulary，未來 UI 仍要自行拼接。

### 4.2 選項 B：先建立完整 API contract，再逐步實作

優點是能一次定義 command response、event stream、read model、runtime status、session/memory/recovery 語意，避免 UI 移植時反覆修 API。缺點是第一階段文件與測試設計較多。

### 4.3 選項 C：先移植 pi-web 再補 API

優點是可快速看到畫面。缺點是 UI 會倒逼臨時 endpoint，容易出現 component 內 hard-code mapping 或直接依賴 DB/resource 細節。

### 4.4 推薦

採 **選項 B：API-first contract**。

P0 不做 UI，但所有 P0 endpoint 必須以 future UI consumer 的需求設計：可重連、可刷新、可 deep-link、可 action allowlist、可取得 evidence refs、可用 API E2E 驗證。

## 5. API 分層

```text
External UI / CLI / automation
  -> Southstar Runtime API
      -> Command APIs
      -> Query APIs
      -> Read Models
      -> Event Stream
      -> Runtime Loop Control
  -> Postgres canonical truth
      -> workflow_runs / workflow_tasks / workflow_history
      -> runtime_resources
      -> session store
      -> memory service
      -> recovery decision applier
      -> scheduler / Tork observer
```

P0 API 分成五層：

1. Command API：改 durable state，永遠寫 event/resource。
2. Query API：查低階 resource/evidence，但仍用 stable JSON contract。
3. Read Model API：UI page 或 operator view 用的聚合資料。
4. Event Stream API：即時進度、事件、異常、approval、recovery。
5. Runtime Loop API：檢查與手動喚醒 scheduler/recovery/Tork observer。

## 6. 通用 Command Contract

所有 P0 command endpoint 使用同一個 request/response shell。

```ts
type RuntimeCommandRequest = {
  commandId: string;
  actor: { type: "user" | "system" | "root-session"; id?: string };
  reason?: string;
  dryRun?: boolean;
  payload?: Record<string, unknown>;
};

type RuntimeCommandResult = {
  commandId: string;
  accepted: boolean;
  status: "applied" | "queued" | "blocked" | "rejected" | "noop";
  affectedRunId?: string;
  affectedTaskId?: string;
  affectedSessionId?: string;
  resourceRefs: Array<{ resourceType: string; resourceKey: string }>;
  eventRefs: Array<{ runId: string; sequence: number; eventType: string }>;
  nextSuggestedActions: string[];
  message?: string;
};
```

規則：

- `commandId` 必須 idempotent。
- `dryRun=true` 不改 state，但回傳 allow/deny、原因與預期 effects。
- 所有非 dry-run command 至少寫一筆 `workflow_history` event 或 `runtime_resource`。
- command 不回傳假成功；若缺 dependency，回 `blocked`。
- command response 不要求 UI 再猜下一步；`nextSuggestedActions` 由 server 根據 action allowlist 產生。

## 7. P0 Task 1：Run Lifecycle Command API

### 7.1 Endpoints

```text
POST /api/v2/runs/:runId/pause
POST /api/v2/runs/:runId/resume
POST /api/v2/runs/:runId/cancel
GET  /api/v2/runs/:runId/actions
```

### 7.2 Semantics

- `pause`：run status 轉 `paused`，scheduler 不再 submit 新 hand。已在 Tork 跑的 hand 預設不強制 cancel；若 `payload.cancelActiveJobs=true`，則建立 cancel intent。
- `resume`：run 從 `paused`、`blocked`、可恢復 exception state 回到 `scheduling`，由 scheduler 決定下一步，不直接 submit Tork。
- `cancel`：run 轉 `cancelled`，建立 active hand cancel intent，後續 callback 只能當 audit evidence，不能改 run fate。
- `actions`：回傳當前 run 可執行 action allowlist 與 blocked reason。

### 7.3 Evidence

事件：

- `run.command_requested`
- `run.paused`
- `run.resumed`
- `run.cancel_requested`
- `run.cancelled`

resource：

- `runtime_command`
- 必要時 `task_execution_intent(status=cancel_requested)`

## 8. P0 Task 2：Live Event Stream API

### 8.1 Endpoints

```text
GET /api/v2/runs/:runId/events?after=0
GET /api/v2/runs/:runId/events/stream?after=0
```

### 8.2 Semantics

`events` 是 paged/polling API。`events/stream` 是真正長連線 SSE，不是一次性 response。

SSE 規則：

- 支援 `Last-Event-ID` 與 `after`。
- 每個 event id 使用 `workflow_history.sequence`。
- 無新事件時送 heartbeat。
- terminal run 可在送出 terminal event 後關閉，也可用 query `closeOnTerminal=false` 保持 heartbeat。
- stream 不讀 transient in-memory queue；只讀 Postgres history，因此 server restart 後可重連。

### 8.3 Event Frame

```ts
type RuntimeEventFrame = {
  sequence: number;
  eventType: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  actorType: string;
  payload: unknown;
  createdAt: string;
};
```

P0 必須包含 normal progress、planner、context assembly、Tork submit、heartbeat、callback、artifact、memory、approval、exception、recovery、completion events。

## 9. P0 Task 3：Runtime Health / Loop Control API

### 9.1 Endpoints

```text
GET  /api/v2/runtime/health
GET  /api/v2/runtime/loops
POST /api/v2/runtime/loops/:loopId/tick
POST /api/v2/runtime/wake
```

### 9.2 Loop IDs

P0 loop ids：

- `runnable-task-scheduler`
- `recovery-controller`
- `tork-exception-observer`
- `recovery-decision-applier`
- `executor-reconciler`

### 9.3 Semantics

- `health` 回 DB、managed runtime deps、Tork observation availability、loop configured/running state。
- `loops` 回 interval、last tick、last success、last error、backoff state。
- `tick` 執行單一 loop 一次，回傳 processed counts。
- `wake` 依 runId/taskId 觸發相關 loop 一次，不能越權改 state。

若目前 loop controller 未記錄 last tick/error，P0 要新增 in-process health projection；canonical outcome 仍以 DB event/resource 為準。

## 10. P0 Task 4：Task / Recovery Command API

### 10.1 Endpoints

```text
GET  /api/v2/runs/:runId/tasks/:taskId/actions
POST /api/v2/runs/:runId/tasks/:taskId/retry
POST /api/v2/runs/:runId/tasks/:taskId/fork-session
POST /api/v2/runs/:runId/tasks/:taskId/reset-session
POST /api/v2/runs/:runId/tasks/:taskId/rollback-session
POST /api/v2/runs/:runId/tasks/:taskId/request-revision
```

### 10.2 Semantics

- `retry`：建立 retry intent 或 recovery decision，task 回可排程狀態，由 scheduler 重建 context/envelope。
- `fork-session`：建立 recovery decision path `fork-session`，保留 parent session/checkpoint lineage。
- `reset-session`：建立 recovery decision path `reset-session`，排除失敗 suffix。
- `rollback-session`：建立 recovery decision path `rollback-session`，需要 operator approval 與 workspace/snapshot evidence。
- `request-revision`：建立 workflow revision request，不直接修改 active manifest。

Task command 不直接 submit Tork。所有重新執行都必須經過 scheduler，確保 managed context/session/memory path 一致。

## 11. P0 Task 5：Tork / Hand Execution API

### 11.1 Endpoints

```text
GET  /api/v2/runs/:runId/hand-executions
GET  /api/v2/runs/:runId/hand-executions/:handExecutionId
GET  /api/v2/runs/:runId/executor-jobs
GET  /api/v2/runs/:runId/executor-jobs/:jobId
POST /api/v2/runs/:runId/executor-jobs/:jobId/reconcile
POST /api/v2/runs/:runId/executor-jobs/:jobId/cancel
```

### 11.2 Unified Execution Projection

P0 read model 必須把 legacy `executor_binding` 與 managed `hand_execution` 投影成一致 shape：

```ts
type ExecutionProjection = {
  executionId: string;
  kind: "hand_execution" | "executor_binding";
  providerId: "tork" | string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "lost" | "superseded";
  externalJobId?: string;
  heartbeat?: { lastHeartbeatAt?: string; heartbeatSeq?: number };
  terminal?: { completedAt?: string; reason?: string };
  callback?: { receivedAt?: string; ok?: boolean; eventRefs: unknown[] };
  exceptionRefs: string[];
};
```

### 11.3 Tork 異常分類

P0 必須區分：

- queued timeout。
- running heartbeat timeout。
- terminal failed。
- callback missing。
- stale/late callback。
- lost external job。
- cancelled by operator。

分類結果必須可在 `GET /exceptions` 與 execution projection 中查到。

## 12. P0 Task 6：Session Timeline / Checkpoint API

### 12.1 Endpoints

```text
GET /api/v2/runs/:runId/sessions
GET /api/v2/sessions/:sessionId/events
GET /api/v2/sessions/:sessionId/checkpoints
GET /api/v2/sessions/:sessionId/checkpoints/:checkpointId
GET /api/v2/sessions/:sessionId/lineage
```

### 12.2 Query Params

`events` 支援：

- `afterSequence`
- `beforeSequence`
- `limit`
- `eventTypes`
- `taskId`
- `correlationId`
- `artifactRef`
- `aroundEventId`
- `windowBefore`
- `windowAfter`

### 12.3 Semantics

Session API 是 read/evidence API。P0 的 task-level fork/reset/rollback command 走 recovery decision；session route 不直接改 run/task fate。

## 13. P0 Task 7：Memory Decision API

### 13.1 Endpoints

```text
GET  /api/v2/runs/:runId/memory
GET  /api/v2/runs/:runId/memory-deltas
POST /api/v2/memory-deltas/:deltaId/approve
POST /api/v2/memory-deltas/:deltaId/reject
POST /api/v2/runs/:runId/memory/invalidate
GET  /api/v2/memory/search
```

### 13.2 Semantics

- run-local memory：同一 run 內 active 即可注入。
- memory delta：`pending_approval` 不能跨 run 注入。
- approve：建立或更新 approved `memory_item`。
- reject：把 `memory_delta` 轉 `rejected`，寫 history event。
- invalidate：使 run-local memory 不再被後續 context assembly 選入。
- search：只回 policy 允許注入或供 operator 檢查的候選。

P0 不做 pin-to-domain-pack、convert-to-skill-note、domain pack publish。

## 14. P0 Task 8：Unified Operator Read Models

### 14.1 Endpoints

```text
GET /api/v2/read-models/run-summary/:runId
GET /api/v2/read-models/runtime-monitor/:runId
GET /api/v2/read-models/task-detail/:runId/:taskId
GET /api/v2/read-models/executions/:runId
GET /api/v2/read-models/exceptions/:runId
GET /api/v2/read-models/sessions-memory/:runId
GET /api/v2/runs/:runId/managed-agents
```

Existing endpoints may stay, but P0 should normalize shape and schema versions so future UI does not need resource-type special cases.

### 14.2 Required Evidence By Flow

Normal flow：

- run status。
- task statuses。
- context packet refs。
- hand execution refs。
- Tork external job id。
- progress/commentary events。
- artifact refs。
- evaluator/completion gate summary。
- memory refs。

Tork abnormal flow：

- queued/running timeout classification。
- external job id。
- last heartbeat。
- observer event。
- runtime exception。
- recovery decision。
- recovery execution/apply result。

Agent abnormal flow：

- brain/hand/evaluator failure event。
- failed artifact refs。
- rejection reason。
- checkpoint refs。
- reset/fork/rollback marker refs。
- retry context refs。

Memory flow：

- run-local memory active/invalidated。
- memory delta pending/approved/rejected。
- approved memory item。
- source refs。

Session flow：

- session id。
- event slice。
- checkpoints。
- lineage markers。
- rollback/reset/fork evidence。

## 15. State And Action Rules

### 15.1 Run Status

P0 API must treat these as first-class states:

```text
draft -> scheduling -> running -> completed
                   -> paused -> scheduling
                   -> blocked
                   -> cancelling -> cancelled
                   -> failed
```

Existing statuses may be mapped, but read models must expose stable normalized status and raw status.

### 15.2 Action Allowlist

Each read model should include:

```ts
type ActionAvailability = {
  action: string;
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  endpoint?: string;
};
```

UI must not infer allowed actions from button logic. API owns availability.

## 16. E2E 驗收矩陣

P0 implementation must add API-level tests, not browser tests.

| Case | 必測內容 | 通過條件 |
|---|---|---|
| Normal workflow | create/execute/events/read models | API 可看見 context、Tork submit、progress、artifact、completion |
| Run pause/resume | pause while schedulable, resume to scheduler | no new hand while paused; resume creates event and scheduler continues |
| Run cancel | cancel active run | run terminal cancelled; late callback cannot complete run |
| Live stream | connect, receive events, reconnect after sequence | no event loss; heartbeat present |
| Tork queued timeout | observer classifies timeout | exception + decision visible through API |
| Tork running timeout | heartbeat stale | hand execution lost/failed evidence visible |
| Tork terminal failed | failed callback/job | exception and recovery path visible |
| Agent failure | hand/brain/evaluator failure | session event, exception, recovery decision visible |
| Recovery apply | approve/apply decision | state transition + recovery execution visible |
| Session timeline | query events/checkpoints | correct filtering and checkpoint payload |
| Memory approve/reject | approve/reject delta | approved memory item or rejected delta visible |
| Memory invalidate | invalidate run-local memory | future read model marks invalidated; context excludes it |

## 17. Implementation Order

1. Command contract helper：idempotent command resource/event writer。
2. Run lifecycle routes：pause/resume/cancel/actions。
3. Real SSE stream：persistent polling loop over Postgres history + heartbeat。
4. Session routes：events/checkpoints/lineage。
5. Memory routes：approve/reject/invalidate/search。
6. Execution projection：unify hand_execution/executor_binding query shape。
7. Runtime loop health/tick/wake routes。
8. Task/recovery command routes。
9. Read model normalization and action allowlist。
10. API E2E matrix。

This order gives UI consumers useful foundations early while keeping risky recovery commands behind existing recovery decision semantics.

## 18. Acceptance Criteria

- `createRuntimeServerClient()` only exposes methods that server routes actually implement.
- Every command endpoint is idempotent by `commandId`.
- Every command writes durable evidence and returns event/resource refs.
- `events/stream` holds a connection, sends heartbeat, supports reconnect, and does not lose events after restart.
- Session timeline/checkpoint APIs are backed by `SessionStore`, not ad hoc history filtering in UI.
- Memory approval/reject/invalidate APIs are backed by memory service semantics.
- Tork/hand execution APIs expose both external job evidence and Southstar-owned fate.
- Normal, Tork abnormal, agent abnormal, memory, and session flows are all covered by API E2E.
- Future UI can operate workflow execution using only Southstar API, without DB access or fake state.

## 19. Implementation Evidence

- Runtime command contract implemented in `src/v2/ui-api/commands/runtime-command.ts`.
- Run lifecycle API implemented in `src/v2/server/run-lifecycle-routes.ts`.
- Durable SSE stream implemented in `src/v2/server/runtime-event-stream.ts`, with HTTP server streaming support in `src/v2/server/http-server.ts`.
- Session API implemented in `src/v2/server/session-routes.ts`.
- Memory decision API implemented in `src/v2/server/memory-routes.ts`.
- Execution projection API implemented in `src/v2/read-models/executions.ts` and `src/v2/server/execution-routes.ts`.
- Task recovery command API implemented in `src/v2/server/task-command-routes.ts`.
- Runtime loop health API implemented in `src/v2/server/runtime-loop-registry.ts`.
- Normalized read models implemented for `run-summary`, `executions`, and `exceptions`.
- API E2E coverage added in `tests/e2e-postgres/cases/27-runtime-api-completeness.test.ts`.
- Real HTTP SSE shutdown behavior is covered by `tests/v2/runtime-event-stream.test.ts`.

## 20. Open Questions

1. 是否要保留現有 `/api/v2/ui/*` endpoint 名稱，或將 P0 normalized read models 全部放在 `/api/v2/read-models/*`？建議保留舊 endpoint 作 compatibility，新增 normalized read models。
2. `pause(cancelActiveJobs=true)` 是否應立刻呼叫 provider cancel，或只建立 cancel intent 由 loop apply？建議 P0 先建立 intent，由 loop/provider action apply，避免 route 直接綁死 Tork。
3. `runtime/loops/:loopId/tick` 是否允許 production 使用？建議預設需要 explicit config flag 或 operator token；測試環境開啟。
4. `memory/search` 是否允許跨 run 查 approved memory？建議依 domain memory policy 與 scope filter，不做 unrestricted search。

## 21. Handoff To Implementation Plan

下一份 implementation plan 應以 TDD 切 task，每個 task 先加 failing API test，再實作 route/service/read model。每個 task 的 done criteria 必須包含：

- unit 或 API integration test。
- Postgres evidence assertion。
- client method sync。
- command/event/resource idempotency check。
- read model assertion。

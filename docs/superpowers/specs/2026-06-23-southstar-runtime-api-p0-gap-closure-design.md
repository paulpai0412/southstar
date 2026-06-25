# Southstar Runtime API P0 Gap Closure Design

日期：2026-06-23
狀態：design draft

## 1. 背景

2026-06-23 的 Southstar Runtime Control Plane API completeness 已合併到 `main`。該批工作建立了 runtime command contract、run lifecycle command、event stream、session、memory、execution projection、runtime loop health、task recovery command、read model alignment，以及 case 27 API E2E。

本次設計不是重開一套 Runtime API，也不是修復未 merge 的 worktree。已確認 `main` 包含 6/23 API completeness commit chain。實際缺口是：原設計承諾的部分 operator API surface 未被 implementation plan 的測試與 acceptance checklist 覆蓋，且 future UI 仍可能需要 raw fetch 來操作部分既有 server route。

本文件定義 P0 gap closure and extension rules：可以為必要功能新增 API，但新增 API 必須沿用 6/23 原 API 設計原則、route 樣式、command contract、durable evidence 與 read-model 可觀察性。

## 2. 目標

1. 補齊 executor job-level operator API，尤其是 `executor-jobs/:jobId/cancel` 與 action allowlist。
2. 補齊 `createRuntimeServerClient()` 對既有與新增 operator APIs 的 typed method alignment，避免 future UI raw fetch。
3. 建立新增 operator API 的設計規則：resource-owned、command-contract、durable evidence、read-model visible、client-aligned。
4. 更新 API gap coverage matrix，確保後續實作不只補 endpoint，也補 command evidence、read model、client method 與 tests。
5. 保持 Postgres canonical truth：provider/Tork side effects 只能是 evidence 或 downstream action，不能成為 workflow fate 的來源。

## 3. 非目標

- 不新增 `/api/v2/operator/*`、`/api/v2/actions/*`、`/api/v2/tork/*` 等第二套控制面。
- 不重寫 6/23 Runtime API completeness 大設計。
- 不改 UI、不移植 pi-web、不新增 dashboard。
- 不重構 recovery decision applier、runtime loop scheduler 或 Tork observer。
- 不讓 API route 直接把 provider state 當 canonical workflow truth。

## 4. 原 API 設計原則

所有新增或補齊的 API 必須遵守以下規則。

### 4.1 Route namespace

新增 route 必須掛在既有 resource namespace 下：

```text
/api/v2/runs/:runId/<resource>
/api/v2/runs/:runId/<resource>/:resourceId
/api/v2/runs/:runId/<resource>/:resourceId/<action>
/api/v2/read-models/:kind/:runId
```

不得新增平行 facade namespace 來包同一件事。若功能是 executor job action，就放在 `/runs/:runId/executor-jobs/:jobId/...`。若功能是 recovery decision action，就放在 `/runs/:runId/recovery-decisions/:decisionId/...`。

### 4.2 Command contract

所有會改 durable state 的 endpoint 必須使用既有 `RuntimeCommandRequest` request shell：

```ts
type RuntimeCommandRequest = {
  commandId: string;
  actor: { type: "user" | "system" | "root-session"; id?: string };
  reason?: string;
  dryRun?: boolean;
  payload?: Record<string, unknown>;
};
```

response 必須使用 `RuntimeCommandResult`：

```ts
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

不得為單一 action 新增另一套 `CancelJobRequest` 或 action-specific result shape。

### 4.3 Durable evidence

非 dry-run command 必須至少寫：

- `runtime_command` resource。
- `run.command_requested` history event。
- action-specific history event，例如 `executor_job.cancel_requested`。
- affected resource status 或 resource payload evidence。

Command replay 必須 by `commandId` idempotent，且回傳第一次 command 的 result。

### 4.4 Query and read model

Query endpoint 不直接暴露 raw DB payload 作為 public contract。若 UI 需要聚合 view，優先新增或擴充 `/api/v2/read-models/*`，而不是讓 UI 拼 `runtime_resources`。

### 4.5 Provider boundary

Southstar API owns workflow truth。Tork 或其他 provider 只提供 observation、side effect result 或 evidence。Route 可以建立 cancel intent 或呼叫 provider action，但 workflow fate 必須由 Southstar-owned resource/history/read model 表達。

## 5. Gap Ledger

| Area | 6/23 design expectation | Current state | Gap closure |
|---|---|---|---|
| Executor job cancel | `POST /api/v2/runs/:runId/executor-jobs/:jobId/cancel` | `execution-routes.ts` has list/detail/reconcile only | Add cancel command route using RuntimeCommand contract |
| Executor job action allowlist | UI should not infer action availability | run/task actions exist; job actions do not | Add `GET /api/v2/runs/:runId/executor-jobs/:jobId/actions` |
| Runtime client | Client should align with implemented routes | client exposes many routes but not all operator routes | Add typed client methods for existing and new operator APIs |
| API E2E | case 27 covers lifecycle/stream/execution/session/memory/loop | no job-level cancel assertion | Extend case 27 or equivalent API coverage with executor job cancel |

## 6. Executor Job Action API

### 6.1 Endpoints

```text
GET  /api/v2/runs/:runId/executor-jobs/:jobId/actions
POST /api/v2/runs/:runId/executor-jobs/:jobId/cancel
```

`jobId` resolves through the existing execution projection. It may match:

- `externalJobId`
- `torkJobId`
- `jobId`
- resource key for an `executor_binding` or `hand_execution`

### 6.2 Action availability

`GET /actions` returns the same action-availability style used by run/task control APIs:

```ts
type ActionAvailability = {
  action: "cancel" | "reconcile";
  allowed: boolean;
  reason?: string;
  requiresApproval?: boolean;
  endpoint?: string;
};
```

Rules:

- `cancel` allowed for active statuses: `submitted`, `queued`, `starting`, `running`, `heartbeat-lost`, `queue-timeout`, `hard-timeout`, `callback-missing`, `orphaned`.
- `cancel` not allowed for terminal statuses: `completed`, `failed`, `cancelled`, `lost`, `superseded`, `cancel_requested`.
- `reconcile` allowed when a provider observation client is configured and the execution has an external job id.

### 6.3 Cancel command semantics

`POST /cancel` uses `RuntimeCommandRequest`.

Active execution:

- status becomes `cancel_requested`.
- payload and summary status are updated consistently.
- legacy `executor_binding` also sets `payload.southstarExecutorStatus = "cancel_requested"`.
- writes `runtime_command`, `run.command_requested`, and `executor_job.cancel_requested`.
- returns `status: "applied"`.
- returns `nextSuggestedActions: ["reconcile-executor-job", "watch-events"]`.

Terminal execution:

- no resource mutation.
- command result is `status: "noop"`.
- response explains that execution is terminal.
- duplicate command replay returns the stored result.

Missing or mismatched execution:

- route returns the existing error envelope style.
- no `runtime_command` is written.
- this prevents command ids from becoming durable evidence for non-existent resources.

Dry run:

- no mutation and no history/resource write.
- response returns `noop` if action would be allowed, or `blocked` with reason if not allowed.

Provider side effects:

- P0 route records Southstar cancel intent.
- If provider cancel is available in the runtime context, implementation may call the existing provider-action abstraction and append provider evidence.
- Provider cancel failure must not change Southstar command acceptance. It should be visible as provider evidence and reconciled by existing observer/reconcile paths.

## 7. Client Alignment

`createRuntimeServerClient()` should expose typed methods for all operator-facing routes in the P0 control plane. The client is not a second API layer; it is a thin URL/body wrapper over implemented server routes.

Add methods for existing routes:

```ts
approveRecoveryDecision(input: {
  runId: string;
  decisionId: string;
  decision: "approved" | "rejected";
  reason: string;
})

applyRecoveryDecision(input: {
  runId: string;
  decisionId: string;
})

getRuntimeHealth()
getRuntimeLoops()
tickRuntimeLoop(input: { loopId: RuntimeLoopId })
wakeRuntime(input?: { runId?: string; taskId?: string })

reconcileExecutorJob(input: { runId: string; jobId: string })
getExecutorJobActions(input: { runId: string; jobId: string })
cancelExecutorJob(input: RuntimeCommandRequest & { runId: string; jobId: string })
```

Client methods must not point to routes that do not exist. Tests must assert exact URL and body shape.

## 8. Read Model Impact

No new read-model kind is required for this P0 gap. Existing surfaces must reflect job cancel state:

- `GET /api/v2/runs/:runId/executor-jobs/:jobId`
- `GET /api/v2/read-models/executions/:runId`
- `GET /api/v2/runs/:runId/events`

`ExecutionProjection` already exposes both normalized `status` and `rawStatus`. For `cancel_requested`:

- `status` may remain normalized as `cancelled` for high-level display.
- `rawStatus` must remain `cancel_requested` so UI can distinguish requested cancellation from terminal cancellation.

The action-specific history event is the durable audit trail for who requested the cancellation and why.

## 9. Error Handling

Use existing API error envelope and HTTP behavior. Do not add a new error schema.

| Scenario | Expected behavior |
|---|---|
| invalid command body | validation error from existing request parser |
| missing execution | error envelope; no durable command |
| run/job mismatch | error envelope; no durable command |
| duplicate command id | stored command result replay |
| dry run allowed | `noop`; no writes |
| dry run blocked | `blocked`; no writes |
| active execution cancel | `applied`; resource/event/command writes |
| terminal execution cancel | `noop`; command evidence may be recorded only if the execution exists and the request is otherwise valid |
| provider cancel failure | command remains accepted if Southstar intent was durably recorded; provider failure is evidence |

## 10. Testing Acceptance

### 10.1 Unit/API route tests

Extend `tests/v2/execution-routes.test.ts`:

- active `hand_execution` cancel writes `cancel_requested`.
- active `executor_binding` cancel writes `cancel_requested` to resource status, payload status, summary status, and `southstarExecutorStatus`.
- duplicate `commandId` replays the first result.
- terminal execution cancel returns `noop`.
- missing job returns error envelope and writes no command.
- `dryRun=true` mutates nothing.
- job actions endpoint reports cancel/reconcile availability.

### 10.2 Client alignment tests

Extend `tests/v2/runtime-api-client-alignment.test.ts` or `tests/v2/execution-routes.test.ts`:

- exact URLs and bodies for `cancelExecutorJob`, `reconcileExecutorJob`, and `getExecutorJobActions`.
- exact URLs and bodies for recovery decision approval/apply.
- exact URLs for runtime health, loops, tick, and wake.
- assertion that client methods point only to implemented routes.

### 10.3 API E2E

Extend case 27 or an API-focused Postgres case:

- seed or run an active execution with `externalJobId`.
- call executor job cancel through HTTP route or client.
- assert `runtime_command` exists.
- assert history has `executor_job.cancel_requested`.
- assert execution projection reflects `rawStatus: "cancel_requested"`.
- assert the route remains idempotent on replay.

## 11. Acceptance Criteria

- All new mutable endpoints use `RuntimeCommandRequest` and `RuntimeCommandResult`.
- No new control-plane namespace is introduced.
- `executor-jobs/:jobId/actions` and `executor-jobs/:jobId/cancel` are implemented under existing `/runs/:runId/executor-jobs` namespace.
- Job cancel writes durable command/event/resource evidence.
- Terminal and dry-run cases do not mutate execution resources.
- Client methods exist for all P0 operator routes needed by future UI.
- Tests cover route behavior, idempotency, client URL/body shape, and API-level evidence.
- Existing 6/23 API completeness semantics remain unchanged.

## 12. Handoff To Implementation Plan

The implementation plan should be a focused follow-up to the 6/23 API completeness work. It should use TDD and cover:

1. failing tests for executor job actions and cancel command.
2. minimal extension to `execution-routes.ts`.
3. reuse of `recordRuntimeCommandPg()` and existing execution projection helpers.
4. client method alignment.
5. API/E2E coverage update.
6. final verification with `npm run test:v2` and the API-focused E2E command.

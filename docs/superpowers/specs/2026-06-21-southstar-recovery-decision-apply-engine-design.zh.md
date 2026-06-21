# Southstar Recovery Decision Apply Engine Design

日期：2026-06-21
狀態：design reviewed

## 1. 背景

Southstar v2 目前已完成 managed runtime 的主要骨架：

- Postgres 是 canonical runtime truth。
- `/api/v2/runs/:runId/execute` 只把 run 轉為 `scheduling`，不直接提交 executor。
- `RunnableTaskScheduler` 會 claim runnable task，建立 brain/hand binding，並透過 `TorkHandProvider.executeTask()` 以 per-task Tork hand 執行。
- Tork 是 hand backend，不是 workflow owner。
- callback ingestion 會寫入 canonical `artifact_ref`，completion 由 evaluator gate 決定。
- `RuntimeExceptionController` 已可把 abnormal evidence 寫成 `runtime_exception`，並分類成 `recovery_decision`。
- completion gate 已會擋 unresolved runtime exception、blocking tool proxy violation、缺 accepted artifact_ref 的 run。

目前缺口在於：`runtime_exception -> recovery_decision` 已存在，但 `recovery_decision` 尚未成為真正改變 task/run/hand fate 的 canonical apply path。這會造成 operator 能看到「系統知道該怎麼做」，但 runtime loop 尚未穩定執行「真的恢復」。

本設計補上 **Recovery Decision Apply Engine**，讓 Southstar 從「可觀測、可判斷」進一步成為「可自動恢復、可審計完成」。

## 2. 設計目標

1. `recovery_decision` 必須有明確狀態機，不只是 payload 裡的一個 path。
2. 只有 `RecoveryDecisionApplier` 能依 `recovery_decision.path` 改變 task/run/hand fate。
3. `RuntimeExceptionController` 保持 observe/classify/decide 邊界，不直接 apply recovery。
4. 所有 apply 必須 idempotent；同一 decision 重跑不能產生重複 attempt、binding、execution 或 history event。
5. automatic recovery 與 operator-approved recovery 走同一個 applier。
6. provider side effect 失敗不可破壞 Southstar truth；必須寫成 evidence。
7. completion gate 必須持續阻擋 unresolved exception、unapplied decision、waiting approval。
8. Tork queue timeout、running hang、terminal-without-callback 都要能形成可重放的 recovery execution chain。

## 3. 非目標

- 不重新設計 workflow manifest。
- 不把 Tork internal state 當成 canonical truth。
- 不把 recovery apply 塞回 callback handler、scheduler 或 Tork observer。
- 不在本階段實作完整 UI console；只要求 API/read model 有足夠 evidence。
- 不重新導入 legacy SQLite 或 V1/Northstar runtime recovery policy。
- 不讓任一 provider-specific retry 取代 Southstar recovery decision state machine。

## 4. 架構

```text
RuntimeObservation
  -> RuntimeExceptionController.observe()
  -> RuntimeExceptionController.classify()
  -> RuntimeExceptionController.decide()
  -> recovery_decision(status=recorded | waiting_operator_approval)

RecoveryDecisionApplier
  -> claim applicable recovery_decision
  -> validate current run/task/hand state
  -> write recovery_execution(started)
  -> apply state transition
  -> perform provider side effects when needed
  -> write recovery_execution terminal status
  -> update recovery_decision status
  -> resolve or keep runtime_exception open

RunnableTaskScheduler
  -> sees pending task
  -> creates new attempt / hand_execution
  -> submits per-task Tork hand
```

Component boundaries：

- `RuntimeExceptionController`：正規化 abnormal evidence、分類 severity/path、建立 `recovery_decision`。
- `RecoveryDecisionApplier`：唯一依 decision 改 runtime fate 的元件。
- `PostgresRecoveryController`：保留為 helper，用於 checkpoint、wake brain、reprovision hand、rollback primitive 等 managed recovery action。
- `RunnableTaskScheduler`：只 dispatch `pending` 且 dependencies satisfied 的 task；不內建 exception policy。
- `TorkObserver`：只觀測 queued/running/terminal evidence；不自行重派。
- `CompletionGate`：只做 finalization gate；有 open exception、unapplied decision 或 waiting approval 時不能 pass。

核心原則：

```text
classification is not recovery.
decision is not applied.
only the applier mutates runtime fate after abnormal execution.
```

## 5. Recovery Decision State Machine

`recovery_decision` resource 使用以下狀態：

```text
recorded
  -> waiting_operator_approval
  -> approved
  -> applying
  -> applied
  -> blocked
  -> failed
  -> superseded
```

狀態語意：

- `recorded`：decision 已建立，可被自動 apply。
- `waiting_operator_approval`：需要 operator 核准，applier 不可自動 claim。
- `approved`：operator 已核准，可被 applier claim。
- `applying`：applier 已取得鎖並開始 apply。
- `applied`：state transition 和必要 evidence 已完成。
- `blocked`：precondition 不足或 retry budget exhausted，需 operator 決定下一步。
- `failed`：apply 過程失敗；失敗原因必須有 `recovery_execution` evidence。
- `superseded`：已有 newer attempt、newer decision 或 terminal success 取代此 decision。

Allowed transitions：

```text
recorded -> applying
recorded -> waiting_operator_approval
recorded -> superseded
recorded -> blocked

waiting_operator_approval -> approved
waiting_operator_approval -> blocked

approved -> applying
approved -> superseded

applying -> applied
applying -> failed
applying -> blocked
applying -> superseded

failed -> recorded        -- only through a new decision resource
blocked -> approved       -- only through explicit operator action
```

`failed -> recorded` 不更新同一 resource，而是建立新的 decision 或 operator action，以保留原始 failure evidence。

## 6. Recovery Execution Resource

新增 canonical resource：

```text
resource_type = "recovery_execution"
resource_key = "recovery_execution:{decisionId}:{attempt}"
status = started | succeeded | failed | superseded | blocked
```

Payload：

```ts
type RecoveryExecutionPayload = {
  schemaVersion: "southstar.runtime.recovery_execution.v1";
  executionId: string;
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  path: RecoveryPath;
  status: "started" | "succeeded" | "failed" | "superseded" | "blocked";
  stateChanges: Array<{
    resourceType: string;
    resourceKey: string;
    fromStatus?: string;
    toStatus?: string;
    reason: string;
  }>;
  providerActions: Array<{
    providerId: string;
    action: "poll" | "cancel" | "destroy" | "provision" | "snapshot" | "rollback" | "wake";
    status: "requested" | "succeeded" | "failed" | "skipped";
    evidenceRef?: string;
    errorExcerpt?: string;
  }>;
  createdAt: string;
  completedAt?: string;
};
```

每次 apply 都必須同時寫 `workflow_history`：

- `recovery_execution.started`
- `recovery_execution.provider_action_recorded`
- `recovery_execution.succeeded`
- `recovery_execution.failed`
- `recovery_execution.blocked`
- `recovery_execution.superseded`

## 7. Apply Semantics By Path

### 7.1 `requeue-hand-execution`

用於 `tork_queue_timeout`。

Flow：

```text
claim decision
  -> best-effort provider poll/cancel
  -> old hand_execution = lost
  -> task = pending
  -> decision = applied
  -> exception = resolved
  -> scheduler later submits new attempt
```

Rules：

- 不必等待 Tork cancel 成功才讓 Southstar task 回 `pending`。
- provider cancel 失敗必須寫入 `recovery_execution.providerActions`。
- 如果 task 已 completed 且有 accepted artifact_ref，decision 轉 `superseded`。
- 如果 retry budget exhausted，decision 轉 `blocked`，task 轉 `blocked`。

### 7.2 `reprovision-hand`

用於 `tork_running_hang`、`hand_provision_failed`、`hand_submit_failed`。

Flow：

```text
claim decision
  -> best-effort provider poll/cancel/destroy
  -> old hand_execution = lost
  -> old hand_binding = lost or destroyed
  -> create before-recovery checkpoint
  -> PostgresRecoveryController reprovisions hand
  -> task = pending
  -> decision = applied
  -> exception = resolved
```

Rules：

- 若 provider evidence 標示 `workspaceUnsafe=true`，不得自動 apply；decision 轉 `waiting_operator_approval` 或 `blocked`。
- 若 hand snapshot missing 且 path 需要 rollback，必須 `blocked`。
- 新 hand binding 必須帶 recovery key，避免重跑產生第二個 hand。

### 7.3 `retry-same-task-new-attempt`

用於 `tork_terminal_without_callback`、`scheduler_claim_stale` 或 callback result 無法可靠重建。

Flow：

```text
claim decision
  -> current hand_execution = superseded
  -> task = pending
  -> decision = applied
  -> scheduler creates new attempt
```

Rules：

- 若 provider terminal result 可重建成 callback-equivalent evidence，應優先 ingest evidence，而不是重跑。
- 若 current attempt 已被 newer attempt supersede，decision 轉 `superseded`。

### 7.4 `wake-new-brain`

用於 `brain_wake_failed` 或 failed/lost brain binding。

Flow：

```text
claim decision
  -> create before-recovery checkpoint
  -> PostgresRecoveryController wakes brain
  -> task remains pending or claimed according to precondition
  -> decision = applied
```

Rules：

- 不直接完成 task。
- 若 task 尚未 dispatch，可回 `pending`；若已有 active hand execution，僅更新 brain binding evidence。

### 7.5 `repair-artifact`

用於 `artifact_rejected` 或 callback contract violation。

Flow：

```text
claim decision
  -> keep rejected artifact_ref as evidence
  -> create repair context refs
  -> task = pending or repair_requested
  -> decision = applied
```

Rules：

- rejected artifact 不可刪除。
- repair attempt context 必須包含 rejected artifact refs 和 evaluator findings。

### 7.6 `rollback-workspace`

用於 workspace unsafe 的 running hang 或 risky recovery。

Flow：

```text
decision = waiting_operator_approval
  -> operator approves
  -> claim approved decision
  -> create before-rollback checkpoint
  -> restore hand snapshot / rollback workspace
  -> task = pending
  -> decision = applied
```

Rules：

- 一律需要 operator approval。
- 沒有 checkpoint/snapshot evidence 時不可 apply。
- rollback provider action 失敗時，decision 轉 `failed` 或 `blocked`，不可默默重派。

### 7.7 `block-for-operator`

用於 tool proxy violation、provider unreachable、intake invalid 或需要人工判斷的狀態。

Flow：

```text
decision = waiting_operator_approval or blocked
  -> task = blocked
  -> completion gate remains failed/not passable
  -> operator chooses approve retry, fail-task, fail-run, or custom recovery
```

Rules：

- 不自動 resolve exception。
- operator action 必須寫入 `operator_approval` 或 `operator_recovery_action` resource。

### 7.8 `fail-task` And `fail-run`

Explicit terminal recovery path。

Rules：

- `fail-task` 只把 task 轉 `failed`；run 最終狀態仍由 completion gate 判斷。
- `fail-run` 可把 run 轉 `failed`，但必須先寫 evaluator/recovery evidence。
- apply failure 不可預設轉 `fail-run`。

## 8. Operator Approval

新增或統一 operator approval flow：

```text
GET  /api/v2/runs/:runId/exceptions
POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval
POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply
```

Approval payload：

```ts
type RecoveryDecisionApprovalInput = {
  decision: "approved" | "rejected";
  reason: string;
  selectedPathOverride?: RecoveryPath;
};
```

Rules：

- approval 只允許作用於 `waiting_operator_approval` 或 `blocked` decision。
- `approved` 使 decision 進入 `approved`，等待 applier。
- `rejected` 使 decision 進入 `blocked`，或依 operator 指定 path 建立新 decision。
- path override 必須保留原 decision 和原 exception，不能覆蓋原始 evidence。

## 9. Runtime Loop Integration

`createManagedRuntimeLoopController()` 新增 applier loop：

```text
executor-reconciler
runnable-task-scheduler
recovery-controller
tork-exception-observer
recovery-decision-applier
```

Loop ordering：

1. observer/reconciler 先寫 exception/decision。
2. applier apply automatic 或 approved decision。
3. scheduler dispatch 被釋放回 `pending` 的 task。
4. completion gate 只在 callback/evaluator path 或 explicit finalization path 執行。

Applier loop 必須可重入：

- 若上一輪 crash 在 `applying`，下一輪可根據 `recovery_execution` 和 current state 恢復。
- stale `applying` decision 超過 lease timeout 後可重新 claim。

## 10. Concurrency And Idempotency

Applier claim 必須在 Postgres transaction 中完成：

```text
lock workflow_run
lock recovery_decision resource
lock target workflow_task
lock target hand_execution / hand_binding when present
compare current statuses
write recovery_execution started
transition decision -> applying
commit
```

Apply state transition 也必須具備 idempotency keys：

- `recovery_execution:{decisionId}:started`
- `recovery_execution:{decisionId}:succeeded`
- `decision:{decisionId}:status:{status}`
- `task:{runId}:{taskId}:recovery:{decisionId}`
- `hand_execution:{handExecutionId}:lost:{decisionId}`

Duplicate handling：

- 已有 succeeded execution：直接回傳 existing result。
- 已有 terminal successful newer attempt：decision -> `superseded`。
- concurrent claim lost：另一個 applier 已取得，當前 loop skip。
- DB unique conflict：重新讀取 resource，不建立第二份 execution。

## 11. Tork Provider Interaction

Tork 是 provider evidence source，不是 runtime truth。

Provider actions：

- `poll`：查詢 Tork job 狀態，寫入 provider evidence。
- `cancel`：best-effort cancel old job。
- `destroy`：destroy/lost old hand binding。
- `provision`：透過 hand provider 建立新 hand。

Tork queue timeout：

```text
queued too long
  -> poll/cancel best effort
  -> old hand_execution lost
  -> task pending
```

Tork running hang：

```text
heartbeat stale
  -> poll/cancel/destroy best effort
  -> hand_execution lost
  -> hand_binding lost or destroyed
  -> task pending after reprovision
```

Tork terminal without callback：

```text
provider terminal but no callback receipt
  -> reconstruct callback-equivalent evidence if possible
  -> otherwise retry-same-task-new-attempt
```

Provider unreachable：

```text
poll/cancel fails
  -> recovery_execution records failed provider action
  -> optional runtime_exception(provider_unreachable)
  -> Southstar state transition continues only if policy allows
```

## 12. Completion Gate Rules

Completion gate must fail or remain not passable when any of these exist：

- unresolved `runtime_exception`
- `recovery_decision` in `recorded`, `waiting_operator_approval`, `approved`, `applying`, `failed`, or `blocked`
- `recovery_execution` in `started` without terminal state
- task terminal status without accepted `artifact_ref`
- blocking `tool_proxy_violation`

Completion may pass only when：

1. all tasks are terminal successful according to evaluator rules;
2. each completed task has accepted `artifact_ref`;
3. no unresolved runtime exception exists;
4. no unapplied or waiting recovery decision exists;
5. no blocking tool proxy/resource violation exists.

## 13. API And Read Model

Exception read model should include：

- exception kind/severity/source/status
- decision path/status/operatorApprovalRequired
- latest recovery execution status
- affected run/task/session/hand/attempt
- provider action summaries
- whether completion gate is blocked by this exception/decision

Managed-agent read model should include `recovery_execution` alongside existing `runtime_exception` and `recovery_decision` resources.

Run inspection should show an ordered chain：

```text
runtime_exception.observed
runtime_exception.recovery_decided
recovery_execution.started
recovery_execution.provider_action_recorded
recovery_execution.succeeded
runtime_exception.resolved
task.dispatch_submitted
```

## 14. Error Handling

### 14.1 Precondition Failure

Examples：

- target hand execution missing
- task already completed
- run already terminal
- attempt already superseded

Handling：

- Do not blindly apply.
- Mark decision `superseded` when a newer successful attempt exists.
- Mark decision `blocked` when evidence is insufficient.
- Always write `recovery_execution` terminal evidence.

### 14.2 Provider Side-Effect Failure

Examples：

- Tork cancel timeout
- Tork unreachable
- hand destroy failed
- rollback snapshot missing

Handling：

- Write provider action evidence.
- If policy allows, continue Southstar state transition even when cancel fails.
- If provider failure makes state unsafe, mark decision `blocked` or `failed`.
- Optionally record `runtime_exception(kind=provider_unreachable)`.

### 14.3 State Transition Failure

Examples：

- DB transaction conflict
- unique violation
- concurrent applier claim

Handling：

- Retry idempotently.
- Re-read resources after conflict.
- Never create duplicate attempts or duplicate executions for the same decision.

## 15. Testing Strategy

Use TDD. Tests should be added before implementation.

Unit tests：

- `tests/v2/recovery-decision-applier.test.ts`
  - `requeue-hand-execution` moves old hand execution to `lost`, task to `pending`, decision to `applied`, exception to `resolved`.
  - `reprovision-hand` marks old hand lost, creates new hand binding, returns task to `pending`.
  - `retry-same-task-new-attempt` supersedes current attempt and returns task to `pending`.
  - `waiting_operator_approval` decisions are not auto-applied.
  - completed task with accepted artifact supersedes stale decision.
  - repeated apply does not duplicate `recovery_execution`.

API/read model tests：

- `tests/v2/operator-recovery-approval-routes.test.ts`
  - operator approve moves decision to `approved`.
  - operator reject moves decision to `blocked` or creates explicit fail path.
  - exception read model includes latest recovery execution.

Real E2E cases：

- `tests/e2e-postgres/cases/21-recovery-decision-apply-requeue.test.ts`
  - stale queued Tork hand -> decision -> applier -> task pending -> scheduler new attempt -> callback completed -> completion gate passed.
- `tests/e2e-postgres/cases/22-recovery-decision-apply-reprovision.test.ts`
  - stale running hang -> reprovision -> new hand -> new attempt -> completed.
- `tests/e2e-postgres/cases/23-operator-approved-recovery-apply.test.ts`
  - rollback/block decision waits for approval and only applies after approval.
- `tests/e2e-postgres/cases/24-provider-unreachable-apply-failure.test.ts`
  - Tork cancel/poll failure writes provider evidence and keeps Southstar truth explainable.

Static gates：

- `tests/e2e-postgres/postgres-real-matrix-static.test.ts` must include cases 21-24.
- no SQLite/local API coupling.
- no whole-workflow submit regression in `/api/v2/runs/:runId/execute`.

## 16. Acceptance Criteria

1. Automatic recovery decisions are applied by runtime loop without operator action when policy allows.
2. Operator-required decisions do not apply until approved.
3. Queue timeout recovery produces a new attempt and can complete the run.
4. Running hang recovery reprovisions or blocks safely according to workspace evidence.
5. Provider action failure is visible as evidence and does not corrupt task/run state.
6. Completion gate cannot pass with unresolved exception, unapplied decision, waiting approval, or started recovery execution.
7. Every apply path writes `workflow_history` and `runtime_resources` evidence.
8. Re-running the same applier loop is safe.
9. `npm test`, `npm run test:v2`, `npm run web:build`, and Postgres static E2E pass.

## 17. Rollout Plan

1. Add contracts and failing tests for `recovery_execution` and applier state machine.
2. Implement `RecoveryDecisionApplier` with one path first: `requeue-hand-execution`.
3. Add `reprovision-hand`, reusing `PostgresRecoveryController` for hand provision/checkpoint.
4. Add operator approval routes and read-model projection.
5. Add provider side-effect evidence and Tork poll/cancel integration.
6. Wire applier loop into `createManagedRuntimeLoopController()`.
7. Add real E2E cases 21-24 and update static matrix.
8. Re-run full verification and update runbook.

## 18. Open Design Decisions Fixed By This Spec

- `RuntimeExceptionController.decide()` does not apply recovery.
- `recovery_decision.status=recorded` means "ready for automatic apply" only when `operatorApprovalRequired=false`.
- `operatorApprovalRequired=true` decisions must begin as `waiting_operator_approval` or be moved there before applier claim.
- Provider cancel failure is not automatically fatal.
- Completion remains evaluator-owned; recovery apply only prepares state for retry, repair, block, or explicit fail path.

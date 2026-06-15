# Southstar Executor Observability & Reconciliation 設計文件

日期：2026-06-15

## 1. 目標

本設計重新回到既有 Southstar/Tork 邊界：**不 fork Tork**，Tork 仍作為外部 Docker executor；Southstar 仍掌握 workflow truth、runtime truth、artifact truth、evaluator truth 與 stop condition truth。

本設計要補上的能力是：Southstar 能清楚掌握 Tork/Docker task 的真實執行狀態，包含：

- task 是否已送出給 Tork；
- 是否仍在 queue；
- 是否真的開始執行；
- container 內的 `southstar-agent-runner` 是否仍有 heartbeat；
- 是否 queue timeout；
- 是否 heartbeat timeout；
- 是否 hard execution timeout；
- Tork 已 terminal 但 Southstar 未收到 callback/artifact；
- Southstar workflow 已 terminal 但 Tork job/container 仍殘留；
- Tork job 消失或狀態與 Southstar runtime 不一致；
- operator 能在 UI 看到問題並執行 cancel/retry/reconcile/diagnostic。

核心產物是新增一層 **Executor Observability & Reconciliation Layer**：

```text
SouthstarWorkflowManifest
  -> Southstar runtime state / evaluator / stop condition
  -> TorkExecutorProvider submits Docker execution
  -> ExecutorBinding records durable executor linkage
  -> Agent runner heartbeat records liveness
  -> ExecutorReconciler polls Tork and compares state
  -> Southstar policy decides retry/fail/quarantine/cancel
```

## 2. 非目標

- 不 fork Tork。
- 不讓 Tork DB 成為 Southstar workflow truth。
- 不讓 Tork job success 直接代表 Southstar task success。
- 不讓 callback 直接繞過 artifact contract、evaluator pipeline 或 stop condition。
- 不讓 UI 直接呼叫 Tork API；UI 操作仍走 Southstar command API。
- 不在第一階段讀 Tork Postgres 內部 schema 作主要 truth。
- 不把 executor failure 直接等同 workflow failure；executor failure 是 fact，後續由 Southstar policy 決定。

## 3. 核心邊界

維持既有架構原則：

```text
SouthstarWorkflowManifest
  = semantic workflow truth

Southstar SQLite
  = durable runtime truth

Tork
  = Docker executor / queue / worker / container lifecycle

Tork job status
  != Southstar task completion

Container callback
  != Southstar task completion

Agent message says "done"
  != Southstar run completion
```

Run 完成仍必須由 Southstar 判斷：

```text
required artifacts exist
+ artifact contracts passed
+ evaluator pipelines passed
+ stop condition passed
+ no blocking approval
+ runtime emits completion event
```

## 4. Executor Binding 模型

每次 Southstar submit Tork execution，都必須建立或更新 durable `executor_binding` resource。第一階段不新增 table，沿用 `runtime_resources`：

```text
runtime_resources.resource_type = executor_binding
runtime_resources.resource_type = executor_event
runtime_resources.resource_type = executor_reconcile_result
runtime_resources.resource_type = executor_log_ref
```

概念層級：

```text
workflow_run
  -> workflow_task
      -> task_attempt
          -> executor_binding
              -> tork job/task/container observation
              -> runner heartbeat
              -> timeout state
              -> reconciliation state
```

`executor_binding.payload_json` 標準欄位：

```ts
type ExecutorBindingPayload = {
  runId: string;
  taskId: string;
  attemptId: string;

  executorType: "tork";

  torkJobId: string;
  torkTaskId?: string;
  containerId?: string;

  southstarExecutorStatus:
    | "submitted"
    | "queued"
    | "starting"
    | "running"
    | "heartbeat-lost"
    | "queue-timeout"
    | "hard-timeout"
    | "callback-missing"
    | "completed"
    | "failed"
    | "cancelled"
    | "lost"
    | "orphaned";

  torkObservedStatus?: string;
  dockerObservedStatus?: string;

  submittedAt: string;
  startedAt?: string;
  lastTorkObservedAt?: string;

  lastHeartbeatAt?: string;
  heartbeatSeq?: number;
  runnerPhase?:
    | "booting"
    | "root-session-started"
    | "subagent-running"
    | "artifact-uploading"
    | "callback-sent"
    | "shutdown";

  queueTimeoutAt: string;
  heartbeatTimeoutAt?: string;
  hardTimeoutAt: string;

  callbackReceivedAt?: string;
  terminalObservedAt?: string;

  reconcileGeneration: number;
  lastReconcileAt?: string;
  lastReconcileError?: string;

  logsRef?: string;
  idempotencyKey: string;
};
```

### 4.1 不變式

1. `executor_binding` 是 Southstar 對 Tork execution 的唯一 durable linkage。
2. Tork status 只能更新 executor observation，不可直接完成 workflow task。
3. Heartbeat 只能證明 runner liveness，不可證明 artifact success。
4. Callback 只能提交 artifact/event fact，不可繞過 evaluator。
5. Reconciler 可以標記 `lost`、`orphaned`、`heartbeat-lost`、`queue-timeout`、`hard-timeout`、`callback-missing`，但是否 retry/fail/quarantine 由 Southstar policy 決定。
6. Terminal workflow task 若仍有 running Tork job，必須標記 orphan 並嘗試 cancel，但不得反轉 workflow terminal state。

## 5. 四層狀態模型

UI/read model 不應只顯示一個 `running`。每個 task 至少分四層：

```text
Workflow Task Status
  pending / running / completed / failed / cancelled

Executor Status
  submitted / queued / starting / running / heartbeat-lost / queue-timeout / hard-timeout / callback-missing / completed / failed / cancelled / lost / orphaned

Runner Status
  no-heartbeat-yet / booting / root-session-started / subagent-running / artifact-uploading / callback-sent / shutdown

Evaluator Status
  pending / passed / failed / repair-requested
```

這能讓 operator 分辨：

- Tork 尚未排到 worker；
- Docker 已啟動但 runner 沒 heartbeat；
- runner 有 heartbeat 但 artifact 還沒回來；
- artifact 回來但 evaluator 沒過；
- workflow 已完成但 Tork job 還在；
- Tork job 已完成但 callback/artifact 丟失。

## 6. Heartbeat Protocol

`southstar-agent-runner` 在 container 內啟動後，必須定期向 Southstar runtime server 回報 heartbeat。

Endpoint：

```text
POST /api/v2/executor/heartbeat
```

Payload：

```json
{
  "runId": "run-123",
  "taskId": "implement",
  "attemptId": "attempt-1",
  "executorType": "tork",
  "torkJobId": "job-abc",
  "torkTaskId": "task-def",
  "rootSessionId": "session-xyz",
  "heartbeatSeq": 12,
  "phase": "subagent-running",
  "message": "running npm test",
  "observedAt": "2026-06-15T12:00:00.000Z"
}
```

Southstar 行為：

1. 驗證 run/task/attempt/binding 存在。
2. append `workflow_history` event：`executor.heartbeat`。
3. 更新 `executor_binding.payload_json.lastHeartbeatAt`、`heartbeatSeq`、`runnerPhase`。
4. 若 executor status 是 `submitted` 或 `queued`，可提升為 `running`，但不可完成 task。
5. 若 heartbeat 帶 progress message，另 append `agent.commentary` 或 `progress.commentary`。

Heartbeat 必須有 idempotency：

```text
idempotency_key = executor-heartbeat:<runId>:<taskId>:<attemptId>:<heartbeatSeq>
```

## 7. Timeout Taxonomy

Southstar 必須拆分三種 timeout，避免誤判。

### 7.1 Queue Timeout

定義：job 已 submit，但太久沒有 observed running 或 heartbeat。

判斷：

```text
southstarExecutorStatus in submitted/queued
and now > queueTimeoutAt
```

事件：

```text
executor.queue_timeout
```

常見原因：

- Tork worker 沒啟動；
- Docker pull 卡住；
- queue 卡住；
- Tork scheduler 沒接 job；
- provider health 異常。

預設處置：

- 標記 binding `queue-timeout`；
- 寫 reconcile result；
- UI 顯示 worker/queue diagnostic；
- 不直接讓 workflow task failed，除非 policy 指定。

### 7.2 Heartbeat Timeout

定義：Tork 觀測為 running，但 runner 太久沒有 heartbeat。

判斷：

```text
torkObservedStatus is running-like
and lastHeartbeatAt exists
and now > heartbeatTimeoutAt
```

事件：

```text
executor.heartbeat_lost
```

常見原因：

- container process 卡住；
- agent runner 卡住；
- runner 在長 tool call 裡沒有 heartbeat；
- callback network 失敗；
- Docker container hang。

預設處置：

- 標記 binding `heartbeat-lost`；
- 拉 Tork logs；
- 觸發 reconcile；
- 依 policy cancel/retry/fork/quarantine；
- 不直接完成或失敗 workflow task。

### 7.3 Hard Execution Timeout

定義：task attempt 超過絕對最大執行時間。

判斷：

```text
now > hardTimeoutAt
and executor status not terminal
```

事件：

```text
executor.hard_timeout
```

預設處置：

- 呼叫 Tork cancel；
- 標記 binding `hard-timeout`；
- append `root.decision.retry` 或 `task.failed_timeout`；
- retry 次數未用完時建立新 attempt；
- retry 用完後依 policy fail/quarantine/await approval。

## 8. Executor Reconciler

新增 ExecutorReconciler loop，負責定期比較 Southstar executor bindings 與 Tork observed state。

週期建議：

```text
watch mode: every 10-30 seconds
manual command: POST /api/v2/executor/reconcile
```

Pseudo flow：

```text
1. load active executor_binding resources
2. for each binding:
     read workflow_run and workflow_task state
     query Tork getJob/getTask/logs where supported
     normalize Tork status
     compare Tork state, Southstar state, heartbeat, timeout windows
     write executor_reconcile_result
     update executor_binding observation fields
     enqueue policy action if required
3. never mutate workflow task completion directly from Tork status
```

### 8.1 Reconcile Cases

#### Case A：Southstar running，但 Tork job not found

```text
workflow_task = running
executor_binding exists
Tork getJob = 404/not found
```

Mark：

```text
executor.lost
southstarExecutorStatus = lost
```

Policy：

- retry submit；
- fail infra attempt；
- quarantine if repeated。

#### Case B：Tork running，但 Southstar task terminal

```text
workflow_task in completed/failed/cancelled
Tork status running-like
```

Mark：

```text
executor.orphaned
southstarExecutorStatus = orphaned
```

Policy：

- cancel Tork job/task；
- append audit event；
- never reverse terminal workflow task。

#### Case C：Tork completed，但 Southstar 沒 callback/artifact

```text
Tork status completed-like
callbackReceivedAt missing
accepted artifact missing
```

Mark：

```text
executor.callback_missing
southstarExecutorStatus = callback-missing
```

Policy：

- fetch logs/output artifact if available；
- if recoverable artifact exists, ingest as late artifact fact；
- otherwise fail infra attempt and retry if attempts remain。

#### Case D：Tork failed，但 Southstar still running

```text
Tork status failed-like
workflow_task running
```

Mark：

```text
executor.failed_observed
southstarExecutorStatus = failed
```

Policy：

- record executor failure fact；
- retry/fail/quarantine by task policy。

#### Case E：Queued too long

```text
status submitted/queued
now > queueTimeoutAt
```

Mark：

```text
executor.queue_timeout
southstarExecutorStatus = queue-timeout
```

Policy：

- show Tork health diagnostics；
- optionally resubmit；
- avoid duplicate Tork jobs unless idempotency fence permits。

#### Case F：Heartbeat stale

```text
Tork running-like
now > heartbeatTimeoutAt
```

Mark：

```text
executor.heartbeat_lost
southstarExecutorStatus = heartbeat-lost
```

Policy：

- fetch logs；
- optionally cancel/retry；
- quarantine if repeated。

## 9. Tork Adapter Capability Model

擴充 Tork adapter，不要求 upstream Tork 必須一次支援所有 inspect 能力。Adapter 必須明確回報 capabilities。

```ts
type TorkAdapterCapabilities = {
  supportsJobInspect: boolean;
  supportsTaskInspect: boolean;
  supportsJobCancel: boolean;
  supportsTaskCancel: boolean;
  supportsJobLogs: boolean;
  supportsTaskLogs: boolean;
  supportsWorkerHealth: boolean;
};
```

`TorkClient` 目標介面：

```ts
type TorkClient = {
  submit(projection: TorkJobProjection): Promise<TorkSubmitResult>;
  getJob(jobId: string): Promise<TorkJobObservation>;
  listTasks?(jobId: string): Promise<TorkTaskObservation[]>;
  getTask?(jobId: string, taskId: string): Promise<TorkTaskObservation>;
  cancelJob(jobId: string): Promise<void>;
  cancelTask?(jobId: string, taskId: string): Promise<void>;
  getJobLogs(jobId: string): Promise<string>;
  getTaskLogs?(jobId: string, taskId: string): Promise<string>;
  getWorkerHealth?(): Promise<TorkWorkerHealth>;
  capabilities(): TorkAdapterCapabilities;
};
```

若某能力不可用，Southstar 必須在 UI/read model 顯示 `unavailable`，不得製造假觀測。

## 10. API Surface

新增 executor observability API：

```text
POST /api/v2/executor/heartbeat
POST /api/v2/executor/reconcile

GET  /api/v2/executor/bindings
GET  /api/v2/executor/bindings/:bindingId
GET  /api/v2/executor/bindings/:bindingId/events
GET  /api/v2/executor/bindings/:bindingId/logs

POST /api/v2/executor/bindings/:bindingId/cancel
POST /api/v2/executor/bindings/:bindingId/retry
POST /api/v2/executor/bindings/:bindingId/mark-lost
POST /api/v2/executor/bindings/:bindingId/adopt-callback
```

UI 操作仍走 Southstar command API：

- cancel：Southstar records command/audit，再呼叫 Tork cancel。
- retry：Southstar 建立新 task attempt/binding，再 submit Tork。
- reconcile：Southstar poll Tork 並更新 binding observation。
- adopt callback：Southstar 把 late artifact/log/output 轉成 auditable fact，再走 evaluator。

## 11. Store / Event 設計

新增或標準化 event types：

```text
executor.submitted
executor.observed
executor.heartbeat
executor.queue_timeout
executor.heartbeat_lost
executor.hard_timeout
executor.callback_received
executor.callback_missing
executor.failed_observed
executor.lost
executor.orphaned
executor.cancel_requested
executor.cancelled
executor.retry_requested
executor.reconcile_started
executor.reconcile_completed
executor.reconcile_failed
executor.logs_captured
```

`runtime_resources` resource types：

```text
executor_binding
executor_event
executor_reconcile_result
executor_log_ref
```

每次 resource mutation 必須與 history event 在同一 SQLite transaction 內完成，或至少確保 append history 先於 projection/cache update。

## 12. Policy Model

新增 executor policy config，來源仍應是 Southstar config / manifest policy，不直接讀任意 env。

```yaml
executor_policy:
  queue_timeout_seconds: 120
  heartbeat_interval_seconds: 10
  heartbeat_timeout_seconds: 45
  hard_timeout_grace_seconds: 30
  reconcile_interval_seconds: 15
  max_executor_retries: 2
  on_queue_timeout: reconcile_then_alert
  on_heartbeat_lost: reconcile_then_cancel_retry
  on_callback_missing: recover_artifact_or_retry
  on_orphaned: cancel_executor_only
```

Policy action set：

```text
observe_only
alert_operator
fetch_logs
reconcile_again
cancel_executor
retry_attempt
fail_attempt
quarantine_run
await_approval
```

## 13. UI / Read Model

Executor Ops、Runtime Monitor、Task Detail 必須顯示四層狀態。

### 13.1 Executor Ops

顯示：

- active executor bindings；
- Tork job id / task id / container id；
- Southstar executor status；
- Tork observed status；
- last heartbeat age；
- runner phase；
- queue timeout / heartbeat timeout / hard timeout deadline；
- last reconcile result；
- adapter capabilities；
- job logs availability；
- actions：cancel、retry、reconcile、open logs、mark lost。

### 13.2 Runtime Monitor

在 run event stream 中顯示：

- executor.submitted；
- executor.heartbeat；
- executor.heartbeat_lost；
- executor.callback_missing；
- executor.orphaned；
- executor.reconcile_completed。

### 13.3 Task Detail

對 selected task 顯示：

```text
Workflow status
Executor status
Runner status
Evaluator status
Heartbeat timeline
Tork observation
Timeout deadlines
Reconcile decisions
Recovery commands
```

## 14. E2E / Test Strategy

### 14.1 Unit Tests

- `ExecutorBinding` payload validator accepts valid binding and rejects missing required fields。
- Heartbeat endpoint updates binding liveness and appends idempotent history。
- Queue timeout detection marks `queue-timeout` without failing workflow task directly。
- Heartbeat timeout detection marks `heartbeat-lost` without completing/failing workflow task directly。
- Hard timeout triggers cancel command and policy action。
- Tork completed + missing callback marks `callback-missing`。
- Southstar terminal + Tork running marks `orphaned` and requests cancel without reversing terminal task。
- Tork missing + Southstar running marks `lost`。

### 14.2 Adapter Tests

- Tork capabilities expose supported/unsupported inspect operations。
- Tork job status is normalized into running-like / terminal-like / failed-like categories。
- Tork logs are captured into `executor_log_ref` without storing raw huge logs in history。
- Tork cancel failure records retryable executor event, not workflow failure。

### 14.3 Integration Tests

Use fake Tork adapter for deterministic cases：

1. queued too long；
2. running with fresh heartbeat；
3. running with stale heartbeat；
4. completed with callback；
5. completed without callback；
6. failed while workflow task running；
7. orphaned Tork job after Southstar terminal；
8. lost job not found。

### 14.4 Real E2E

When Docker/Tork is available：

- run a task that heartbeats then completes；
- run a task that sleeps beyond heartbeat timeout；
- cancel an active Tork job through Southstar command API；
- verify Executor Ops shows binding, heartbeat, Tork status, logs/ref, reconcile result。

Real E2E must not bypass Southstar DB or fabricate executor rows.

## 15. Implementation Slices

### Slice 1：Binding Schema + Submit Event

- Standardize `executor_binding` payload。
- `TorkExecutorProvider.submit()` records binding/resource/history。
- Existing UI/read models show binding status from real resource。

### Slice 2：Heartbeat Endpoint + Runner Heartbeat

- Add `/api/v2/executor/heartbeat`。
- Add heartbeat loop in `southstar-agent-runner`。
- Persist heartbeat events idempotently。

### Slice 3：Reconciler Core

- Add `ExecutorReconciler` module。
- Query Tork status via adapter。
- Detect lost/orphaned/callback-missing/queue-timeout/heartbeat-lost/hard-timeout。
- Persist reconcile result and binding updates。

### Slice 4：Policy Actions

- Add executor policy evaluator。
- Implement cancel/retry/alert/observe actions。
- Ensure workflow task completion remains evaluator/stop-condition driven。

### Slice 5：UI Read Models and Commands

- Executor Ops page reads bindings/reconcile/log status。
- Task Detail shows four-layer status。
- Runtime Monitor shows executor events。
- Commands: cancel/retry/reconcile/open logs。

### Slice 6：E2E and Hardening

- Add deterministic fake Tork integration tests。
- Add real Tork heartbeat/reconcile E2E where environment is explicitly configured。
- Add log size/secret redaction checks。

## 16. Risks and Mitigations

### Risk：Tork API lacks task/container detail

Mitigation：capability model + best-effort observation + runner heartbeat as primary liveness signal。

### Risk：Heartbeat false positives during long tool calls

Mitigation：runner heartbeat must run outside subagent blocking call where possible；policy uses grace window before cancel/retry。

### Risk：Duplicate retries create duplicate Tork jobs

Mitigation：attempt id + executor binding idempotency key + retry command fence。

### Risk：Large logs leak into history

Mitigation：history stores compact log refs/summaries only；large logs go to artifact/blob/resource with size/redaction policy。

### Risk：Executor state accidentally drives workflow completion

Mitigation：tests enforce Tork terminal status cannot directly set workflow task completed；completion requires evaluator/stop condition。

## 17. Acceptance Criteria

- Southstar records one durable `executor_binding` for every submitted Tork execution.
- UI can show whether each task is submitted, queued, running, heartbeat-lost, timed-out, completed, failed, lost, or orphaned.
- `southstar-agent-runner` sends heartbeat events while container execution is active.
- Southstar distinguishes queue timeout, heartbeat timeout, and hard execution timeout.
- Reconciler detects lost, orphaned, callback-missing, queue-timeout, heartbeat-lost, hard-timeout, and failed-observed cases.
- Executor events are appended to `workflow_history` with compact payloads and idempotency keys.
- Tork status and callback cannot bypass artifact validation, evaluator pipeline, or stop condition.
- Terminal workflow task is not reversed by executor orphan/cancel/reconcile events.
- Operator can cancel, retry, and reconcile executor bindings through Southstar API, not direct Tork API.
- Executor Ops and Task Detail expose four-layer status from real Southstar read models.
- Tests cover deterministic fake Tork cases and at least one real heartbeat/reconcile path when real Docker/Tork E2E is enabled.

## 18. Spec Self-Review

Placeholder scan：本文沒有占位標記、待補段落或未命名章節。

Consistency check：本文維持不 fork Tork、Southstar canonical truth、Tork executor-only 邊界；所有 executor observations 都不直接完成 workflow。

Scope check：本文聚焦 executor observability/reconciliation，不包含 UI 1:1 全頁 rewrite、domain pack editor 或 Tork fork。

Ambiguity check：timeout 分成 queue/heartbeat/hard；狀態分 workflow/executor/runner/evaluator 四層；callback 與 Tork terminal status 都明確不能繞過 evaluator/stop condition。

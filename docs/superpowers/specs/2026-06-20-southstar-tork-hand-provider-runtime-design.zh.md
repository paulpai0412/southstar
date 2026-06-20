# Southstar Tork Hand Provider Runtime Design

日期：2026-06-20
狀態：design draft

## 1. 背景

Southstar 目前已經有 managed-agent meta-harness 的主要 interface 與 Postgres runtime 骨架：`SessionStore`、`BrainProvider`、`HandProvider`、Postgres `workflow_history`、`runtime_resources`、managed scheduler、recovery controller、vault/tool proxy、read model、real Postgres E2E 都已存在。

但現行 `/api/v2/runs/:runId/execute` 仍先把整個 workflow submit 給 Tork，之後才由 managed scheduler 補 `brain_binding`、`hand_binding`、`task.dispatch_submitted` 等 runtime state。這會讓 Tork 成為實際 workflow executor，而 managed-agent layer 變成補資料。這不符合 managed agents 的目標：Southstar 應是 durable control plane，Tork 應是可替換的 hand execution plane。

本設計把 Tork 改成 **per-task HandProvider**：Southstar scheduler 決定哪些 task 可跑、何時可跑、可以併發多少；Tork 只負責實際執行單一 task job、queue/worker/heartbeat/callback observation。Postgres 仍是唯一 runtime truth。

## 2. 目標

1. `/execute` 不再直接 submit whole-workflow Tork job。
2. Tork submit 只發生在 `TorkHandProvider.executeTask()` 或等價 per-task hand execution boundary。
3. Run、task、hand execution 狀態能區分 `scheduling`、`claimed`、`queued`、`running`。
4. Southstar scheduler 能控制 task 併發，而 Tork worker pool 負責實際 job 執行併發。
5. `artifact_ref` 成為 dependency gate 與 evaluator completion 的 canonical artifact contract。
6. Completion 必須經 evaluator/end-state gate，不可只由 Tork terminal status 決定。
7. Recovery decision、checkpoint、attempt lineage 由 Southstar 持久化控制。

## 3. 非目標

- 不把 Southstar 改成 Tork workflow wrapper。
- 不讓 Tork DAG 成為 canonical dependency truth。
- 不在此設計中實作新的 Tork server 或 worker。
- 不要求立即移除 legacy executor APIs；但新 managed runtime path 不應依賴 whole-workflow submit。
- 不以 Tork internal retry 取代 Southstar recovery policy。

## 4. Remaining Work From Managed-Agent Design

目前已經有 managed-agent meta-harness 的主要 interface 與 Postgres runtime 骨架；真正還要補的是：

1. **`artifact_ref` 契約統一**：scheduler、callback、evaluator、read models 必須使用同一種 accepted/rejected artifact resource contract。舊 `artifact` 可作 compatibility projection 或 blob/detail，但不可作 dependency gate truth。
2. **Evaluator/end-state gate 接入 completion**：所有 task terminal 後，run 進入 `evaluating`；只有 evaluator/end-state gate 通過後才能 `passed`。
3. **Work item intake 自動化**：external prompt/GitHub issue/Linear ticket 等 intake 應建立或解析 `work_item`，並自動 link run attempt。
4. **Tool proxy 全路徑 enforcement**：sandbox/hand execution 不可持有 raw long-lived credentials；所有高風險 tool call 必須透過 vault lease + tool proxy。
5. **更 native 的 brain-hand task loop**：scheduler claim task 後，由 brain/hand provider 驅動 task execution；Tork 是 hand provider，不是補資料目標。

本文件聚焦第 1、2、5 項，並為第 3、4 項保留相容邊界。

## 5. Architecture

```text
Operator / CLI / UI
  -> Southstar Runtime Server
      -> Work Item Registry
      -> Workflow Draft / Run API
      -> Runnable Task Scheduler
      -> BrainProvider Registry
      -> HandProvider Registry
          -> TorkHandProvider
              -> Tork Queue / Worker / Callback
      -> SessionStore
      -> Artifact/Evaluator Pipeline
      -> Recovery Controller
      -> Read Models
```

Boundary responsibilities:

- **Southstar Runtime**：control plane。負責 run lifecycle、task dependency、context packet、brain binding、hand binding、artifact/evaluator gate、recovery、read model。
- **TorkHandProvider**：execution plane。負責 single-task Tork job submission、queue/running/terminal observation、callback correlation。
- **BrainProvider**：strategy plane。負責 wake from session/context，產生 task execution intent、tool decisions、artifact decisions。第一階段可讓 task envelope runner 承接 brain behavior，但狀態與介面要保留 brain boundary。
- **Postgres**：唯一 truth。Tork state 必須投影回 `workflow_history` 與 `runtime_resources`。

## 6. Status Model

### 6.1 Run Lifecycle

```text
created
  -> scheduling
  -> running
  -> evaluating
  -> passed | failed | cancelled
```

- `created`：draft 已轉成 run，tasks/context packets 已建立，但 scheduler 尚未接管。
- `scheduling`：`/execute` 已接管 run，scheduler 可 claim runnable tasks；不代表 Tork worker 已開始。
- `running`：至少一個 `hand_execution` 或 task 已由 Tork worker 實際 running。
- `evaluating`：所有 tasks terminal，正在執行 artifact/end-state gates。
- `passed` / `failed` / `cancelled`：terminal run state。

### 6.2 Task Lifecycle

```text
pending
  -> claimed
  -> queued
  -> running
  -> completed | failed | cancelled | lost
```

- `pending`：尚未 ready 或尚未被 scheduler claim。
- `claimed`：scheduler 已用 Postgres transaction claim，準備提交 hand execution。
- `queued`：Tork job 已提交，等待 worker。
- `running`：Tork heartbeat、poll 或 callback 已確認 worker 開始。
- `completed`：task artifact gate accepted。
- `failed`：task terminal failure，等待 recovery/evaluator policy。
- `lost`：execution attempt 無法確認，需 recovery decision。

### 6.3 Hand Execution Lifecycle

```text
queued
  -> running
  -> completed | failed | lost | superseded | cancelled
```

`hand_execution` 是單次 Tork task job attempt。它必須保存：

- `handExecutionId`
- `runId`
- `taskId`
- `sessionId`
- `attemptId`
- `providerId = "tork"`
- `torkJobId`
- `queuedAt`
- `startedAt?`
- `terminalAt?`
- `previousAttemptId?`
- `supersededBy?`
- `queueTimeoutSeconds`
- `heartbeatTimeoutSeconds`

### 6.4 Concurrency Semantics

Southstar 控制 logical concurrency；Tork 控制 worker execution concurrency。

`claimed`、`queued`、`running` 都應占用 run-level concurrency slot，因為它們都代表 Southstar 已承諾一次 execution attempt。這可避免短時間內 submit 過多 Tork jobs，超出 operator 對 run 的控制。

Concurrency inputs:

- `effortPolicy.maxParallelTasks`
- `effortPolicy.maxHandsPerBrain`
- `providerCapacity.tork.maxQueuedPerRun`
- `providerCapacity.tork.maxRunningPerRun`
- work item 或 domain policy 的 risk/cost limit

## 7. New Data Flow

### 7.1 Draft

```text
POST /api/v2/planner/drafts
  -> generate constrained workflow plan
  -> materialize workflow manifest
  -> runtime_resources(planner_draft, status=validated)
```

### 7.2 Run

```text
POST /api/v2/runs
  -> workflow_runs(status=created)
  -> workflow_tasks(status=pending)
  -> context_packet per task
  -> workflow_history: run.created, task.created
```

If the request originates from a work item, run creation must link:

```text
work_items.run_refs_json += { runId, runAttempt }
workflow_runs.runtime_context_json.workItemRef = { workItemId, runAttempt }
```

### 7.3 Execute

```text
POST /api/v2/runs/:runId/execute
  -> validate run is created/scheduling
  -> workflow_runs.status = scheduling
  -> workflow_history: run.scheduling_started
  -> wake scheduler
  -> return without submitting Tork job directly
```

`/execute` means Southstar has accepted control of the run. It does not mean Tork has started a worker.

### 7.4 Scheduler Tick

```text
for each run in scheduling/running:
  read workflow_tasks
  read accepted artifact_ref task ids
  find pending tasks whose dependencies are accepted
  apply concurrency/capacity gates
  transactionally claim task: pending -> claimed
  create/wake brain_binding
  create hand_binding(providerId=tork)
  call TorkHandProvider.executeTask()
```

Atomic claim must lock the run/task rows and re-check task status plus concurrency counters in the same transaction.

### 7.5 Tork Hand Execution

```text
TorkHandProvider.executeTask()
  -> materialize only this task envelope
  -> submit one Tork job for this task
  -> runtime_resources(hand_execution, status=queued)
  -> workflow_tasks.status = queued
  -> workflow_history: hand.execute_queued
```

Compatibility projection may also write `executor_binding`, but canonical managed runtime state is `hand_execution`.

### 7.6 Tork Started

Tork heartbeat, callback, or poll observes worker start:

```text
hand_execution: queued -> running
workflow_tasks: queued -> running
workflow_runs: scheduling -> running
workflow_history: hand.execute_started
```

### 7.7 Tork Terminal Callback

```text
callback received
  -> workflow_history: executor.callback_received
  -> append agent/task events
  -> artifact_ref accepted/rejected
  -> workflow_history: artifact.accepted or artifact.rejected
  -> hand_execution completed/failed
  -> workflow_tasks completed/failed
```

Callback identity must include:

- `runId`
- `taskId`
- `attemptId`
- `handExecutionId`
- artifact hash

This identity is used for idempotency and late callback handling.

### 7.8 Fan-In

```text
upstream task completed
  -> accepted artifact_ref exists
  -> downstream dependency becomes ready
  -> scheduler may claim downstream/fan-in task
  -> fan-in context reads accepted artifact refs and selected session events
```

Fan-in must not consume raw upstream transcripts by default.

### 7.9 Completion

```text
all tasks terminal
  -> workflow_runs.status = evaluating
  -> run end-state evaluator
  -> passed if gates pass
  -> failed if gates reject or unresolved terminal failures remain
```

Tork terminal state alone is insufficient to mark run `passed`.

## 8. Artifact Contract

`artifact_ref` is the canonical runtime resource for dependency gating and evaluator completion.

Required fields:

```ts
type ArtifactRefPayload = {
  schemaVersion: "southstar.runtime.artifact_ref.v1";
  artifactType: string;
  producerTaskId: string;
  status: "accepted" | "rejected" | "needs_repair";
  contentRef?: string;
  summary: string;
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  sourceEventRefs: string[];
};
```

Resource shape:

```text
runtime_resources(
  resource_type = "artifact_ref",
  resource_key = "artifact-ref:{runId}:{taskId}:{attemptId}:{hash}",
  run_id,
  task_id,
  session_id,
  scope = "artifact",
  status = accepted | rejected | needs_repair
)
```

Legacy `artifact` may remain as compatibility projection or blob/detail storage, but it cannot be used by managed scheduler or completion gate.

## 9. Recovery And Error Handling

### 9.1 Tork Queued Timeout

```text
task = queued, hand_execution = queued
queueTimeoutSeconds exceeded
  -> recovery_decision(strategy="requeue-hand-execution")
  -> old hand_execution = lost
  -> task -> pending or claimed according to retry policy
  -> scheduler submits new Tork job
```

Queued timeout is not task failure. It means this execution attempt did not start.

### 9.2 Running Heartbeat Lost

```text
task = running, hand_execution = running
heartbeatTimeoutSeconds exceeded
  -> recovery_decision(strategy="reprovision-hand")
  -> session_checkpoint(type=before-recovery)
  -> old hand_execution = lost
  -> new hand_execution submitted
```

### 9.3 Tork Terminal Failure

```text
Tork job failed or callback ok=false
  -> artifact_ref rejected or failure evidence
  -> task failed
  -> evaluator/recovery policy decides retry, fork, or run failure
```

### 9.4 Duplicate Or Late Callback

Duplicate callback:

- Same `runId/taskId/attemptId/handExecutionId/artifactHash`.
- Return accepted duplicate result.
- Do not append duplicate terminal events.

Late callback:

- Callback belongs to superseded/lost attempt.
- Record as late observation.
- Do not overwrite newer attempt or task status.

### 9.5 Brain Crash

```text
brain_binding failed/lost
  -> recovery_decision(strategy="wake-new-brain")
  -> session_checkpoint(type=before-recovery)
  -> BrainProvider.wake(sessionId, contextPacketId)
```

Brain recovery reads Postgres session/context truth, not old process memory.

## 10. Tork Retry Policy

Tork internal retry must not hide attempt lineage from Southstar.

Recommended default:

- Tork internal retry: disabled or set to 0/1 for transient worker bootstrap failures only.
- Southstar retry: canonical retry/fork/requeue/reprovision policy.
- Every execution attempt gets a new `handExecutionId`.

If Tork retry is enabled, each retry attempt must be observable through callback/poll events and mapped to Southstar attempt lineage. Otherwise it should not be used for managed runtime paths.

## 11. API Changes

### 11.1 Execute

`POST /api/v2/runs/:runId/execute`

Response:

```json
{
  "runId": "run-...",
  "status": "scheduling",
  "schedulerWakeRequested": true
}
```

No `externalJobId` is returned from `/execute`, because no Tork job is submitted at this layer.

### 11.2 Scheduler Tick

Internal or operator route may expose:

```text
POST /api/v2/runs/:runId/scheduler/tick
```

Response includes:

- claimed task ids
- queued hand execution ids
- skipped task ids and reasons
- capacity/concurrency decisions

### 11.3 Hand Execution Read Model

Read models should expose:

- `brain_binding`
- `hand_binding`
- `hand_execution`
- `artifact_ref`
- queue/running/terminal timestamps
- attempt lineage
- recovery decision refs

## 12. Migration Plan

### Slice 1: State And Contract Cleanup

- Add run status `scheduling`, `evaluating`.
- Add task status `claimed`, `queued`, `lost`.
- Add `hand_execution` taxonomy and static gates.
- Make callback write `artifact_ref`.
- Keep legacy `artifact` only as compatibility projection.
- Update scheduler to read accepted `artifact_ref` only after callback writes it.

### Slice 2: Thin Execute

- Change `/execute` from whole-workflow submit to run scheduling start.
- Append `run.scheduling_started`.
- Wake scheduler without submitting Tork job directly.
- Move old whole-workflow dispatch behind a deprecated compatibility path or tests-only fixture.

### Slice 3: Per-Task TorkHandProvider

- Add `executeTask()` or equivalent hand execution method.
- Materialize a single task envelope.
- Submit one Tork job per claimed task.
- Write `hand_execution queued`.
- Update task status to `queued`.
- Map Tork start/heartbeat/callback into `running` and terminal states.

### Slice 4: Evaluator Completion Gate

- When all tasks terminal, set run to `evaluating`.
- Run end-state evaluator.
- Set `passed` only when required artifact graph and security/hand/evidence gates pass.
- Set `failed` when evaluator rejects or unrecovered terminal failures remain.

## 13. Testing Strategy

Unit tests:

- `/execute` does not call `executorProvider.submit`.
- `/execute` moves run `created -> scheduling`.
- Scheduler claims only dependency-ready tasks.
- `claimed` / `queued` / `running` occupy concurrency slots.
- `artifact_ref` unlocks downstream tasks.
- Legacy `artifact` does not unlock managed scheduler dependencies.
- Duplicate callbacks are idempotent.
- Late callbacks do not overwrite superseded attempts.

Integration tests:

- Two independent tasks submit two Tork hand executions concurrently.
- Downstream fan-in waits for accepted upstream `artifact_ref`.
- Queue timeout requeues through recovery decision.
- Running heartbeat loss triggers `reprovision-hand`.
- All terminal tasks move run to `evaluating`, then evaluator sets final run state.

Real Postgres/Tork E2E:

- Normal per-task Tork execution.
- Parallel runnable tasks.
- Fan-in task execution after accepted artifacts.
- Queued timeout or lost worker recovery.
- Duplicate callback behavior.
- Completion only through evaluator gate.

## 14. Acceptance Criteria

1. `/execute` never submits a whole-workflow Tork job in the managed runtime path.
2. A run can be `scheduling` while all Tork jobs are still absent or queued.
3. Scheduler can submit multiple independent task Tork jobs up to configured concurrency.
4. Tork queue/running/terminal observations are recorded as `hand_execution` state.
5. Accepted `artifact_ref` unlocks downstream tasks; legacy `artifact` does not.
6. Callback duplicate and late callback behavior is idempotent and lineage-safe.
7. Queue timeout and heartbeat lost recovery create `recovery_decision` before retry/reprovision.
8. Run `passed` requires evaluator/end-state gate, not only Tork terminal success.
9. Read models show task status, hand execution status, queue/running timestamps, and recovery lineage.
10. Real Postgres/Tork E2E proves normal, parallel, fan-in, recovery, and completion-gate behavior.

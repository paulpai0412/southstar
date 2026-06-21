# Southstar Managed Runtime Operational Hardening Design

日期：2026-06-21
狀態：design reviewed

## 1. 背景

Southstar v2 已完成主要 runtime 方向轉換：

- `southstar` CLI 已指向 `src/v2/cli.ts`。
- Postgres 是 canonical runtime truth。
- `/api/v2/runs/:runId/execute` 已改成 thin controller，只把 run 轉成 `scheduling`。
- `RunnableTaskScheduler` 會 claim runnable task、建立 `brain_binding` / `hand_binding`，並透過 `TorkHandProvider.executeTask()` per-task submit。
- Tork 不再是 workflow owner，而是 hand execution backend。
- callback ingestion 會寫入 canonical `artifact_ref`，completion 由 evaluator gate 決定 `passed` / `failed`。
- `work_items` intake、tool proxy policy、managed read model、recovery loop、real Postgres E2E case `00-13` 都已存在。

歷史上 V1/Northstar runtime 曾有 exception policy、repair、watch/recovery 相關實作，例如 `src/runtime/exception-policy.ts`、`src/runtime/repair.ts`、`src/runtime/state-machine.ts`、exception E2E suites。這些程式碼已在移除 legacy Northstar runtime 時刪除，因為它們綁定舊的 `IssueSnapshot`、`lifecycle_state`、workflow stage、owner lease 與 child run projection，不適合作為 V2 Postgres/per-task Tork hand runtime 的 canonical path。

V2 目前仍保留並應重用的能力包括：

- `src/v2/session-recovery/postgres-controller.ts`：可建立 `recovery_decision`、checkpoint、wake brain、reprovision hand。
- `src/v2/executor/postgres-tork-callback.ts`：callback receipt、stale/terminal callback handling、`artifact_ref` 寫入、hand execution terminal patch。
- `src/v2/evaluators/completion-gate.ts`：all-terminal task 後的 evaluator completion gate。
- `src/v2/tool-proxy/policy-enforcer.ts`：credential-shaped payload 掃描與 blocking violation。
- `src/v2/server/runtime-loops.ts`：managed scheduler 與 recovery controller loop。

目前缺口不再是「有沒有 V2 runtime」，而是 production runtime 的 operational hardening：queued/running timeout、Tork hang、callback drift、tool proxy violation、artifact rejection、brain/hand failure 等 runtime exception 必須被集中分類、審計並決定 recovery path。否則每個 subsystem 會各自處理錯誤，最後 operator 看見的是分散的 failure evidence，而不是一條可解釋、可重放、可恢復的 runtime decision chain。

本文把下一階段收斂成同一份設計：

1. Managed runtime lifecycle hardening。
2. 集中式 runtime exception handling。
3. Tool proxy full-path enforcement。
4. Work item intake end-to-end。
5. Read model、real E2E、operator runbook 對齊。

## 2. 設計目標

1. Southstar 持續作為 durable control plane；Tork、Pi、container、tool backend 都只是 provider。
2. 所有 runtime exception 先進入集中 `RuntimeExceptionController`，再由 recovery policy 決定處置。
3. `queued`、`running`、`completed`、`failed`、`lost`、`blocked` 的狀態轉換都有 Postgres evidence。
4. Tork runtime timeout 與 hang 不由 Tork 自行決定 workflow fate，而由 Southstar 根據 hand execution evidence 做 recovery decision。
5. Tool proxy enforcement 覆蓋 intake、context packet、task envelope、hand sandbox、tool call、callback artifact/event/metrics。
6. Work item intake 成為 API、CLI、UI、GitHub-like source 到 draft/run 的共同入口。
7. Completion gate 只接受 accepted `artifact_ref`、無 blocking exception、無 unresolved recovery decision 的 run。
8. Read model 能讓 operator 看見每個 exception、classification、recovery decision、attempt lineage 與 final evaluator result。
9. Real E2E case 必須覆蓋正常路徑、timeout、hang、late callback、credential violation、intake dedupe、manual operator intervention。

## 3. 非目標

- 不新增另一套 workflow engine。
- 不把 Tork internal state 當成 canonical truth。
- 不讓 provider-specific retry 取代 Southstar recovery policy。
- 不讓 exception handling 只存在 log 或 test helper。
- 不重新導入 legacy SQLite 或 V1 Northstar runtime。
- 不在本階段要求完整自動修復所有 exception；需要 operator approval 的 recovery path 必須明確保留。

## 4. 目標架構

```text
Intake Sources
  API / CLI / UI / GitHub-like source
    -> WorkItemIntakeService
    -> Workflow Draft / Run
    -> RunExecutionController
    -> RunnableTaskScheduler
    -> BrainProvider
    -> HandProvider
       -> TorkHandProvider.executeTask()
       -> Tork queue / worker
       -> callback / heartbeat / poll observation
    -> ArtifactRefStore
    -> RuntimeExceptionController
    -> RecoveryDecisionEngine
    -> CompletionGate
    -> Read Models / Operator UI
```

Key principle：

```text
Provider observation is evidence.
Southstar exception classification is decision input.
Recovery decision is the only path that mutates runtime fate after abnormal execution.
Completion gate is the only path that finalizes run status.
```

## 5. Runtime Exception Handling

### 5.1 Central Controller

新增集中元件：

```ts
interface RuntimeExceptionController {
  observe(input: RuntimeObservation): Promise<RuntimeException | null>;
  classify(input: RuntimeException): Promise<RuntimeExceptionClassification>;
  decide(input: RuntimeExceptionClassification): Promise<RecoveryDecision>;
  apply(input: RecoveryDecision): Promise<RecoveryApplicationResult>;
}
```

`RuntimeExceptionController` 不直接替代 scheduler、callback、tool proxy、completion gate。它負責把所有 abnormal evidence 正規化成同一種 exception resource，再交給 recovery policy。

### 5.2 Exception Resource

所有 runtime exception 寫入 `runtime_resources`：

```text
resource_type = "runtime_exception"
resource_key = "runtime_exception:{runId}:{scope}:{fingerprint}"
scope = run | task | hand | brain | tool | intake | evaluator
status = observed | classified | deciding | recovering | resolved | blocked | terminal
```

Payload：

```ts
type RuntimeExceptionPayload = {
  schemaVersion: "southstar.runtime.exception.v1";
  exceptionId: string;
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId?: string;
  brainBindingId?: string;
  handBindingId?: string;
  source:
    | "scheduler"
    | "tork-observer"
    | "callback"
    | "heartbeat"
    | "tool-proxy"
    | "artifact-gate"
    | "completion-gate"
    | "intake"
    | "operator";
  kind:
    | "tork_queue_timeout"
    | "tork_running_hang"
    | "tork_terminal_without_callback"
    | "late_callback"
    | "stale_callback"
    | "callback_contract_violation"
    | "artifact_rejected"
    | "tool_proxy_violation"
    | "brain_wake_failed"
    | "hand_provision_failed"
    | "hand_submit_failed"
    | "scheduler_claim_stale"
    | "intake_invalid"
    | "completion_gate_failed"
    | "provider_unreachable";
  severity: "info" | "warning" | "recoverable" | "blocking" | "terminal";
  observedAt: string;
  classifiedAt?: string;
  evidenceRefs: string[];
  providerEvidence?: Record<string, unknown>;
  retryBudgetRef?: string;
  recoveryDecisionRef?: string;
};
```

每個 exception 同步寫入 `workflow_history`：

- `runtime_exception.observed`
- `runtime_exception.classified`
- `runtime_exception.recovery_decided`
- `runtime_exception.resolved`
- `runtime_exception.blocked`

### 5.3 Central Decision Rules

Recovery decision 必須由 exception classification 產生，不允許 callback handler、Tork observer、tool proxy 各自直接重跑 task。

```ts
type RecoveryPath =
  | "none-observe-only"
  | "requeue-hand-execution"
  | "reprovision-hand"
  | "wake-new-brain"
  | "retry-same-task-new-attempt"
  | "repair-artifact"
  | "rollback-workspace"
  | "block-for-operator"
  | "fail-task"
  | "fail-run";
```

Recovery decision 寫入既有或擴充的 `recovery_decision` resource：

```ts
type RecoveryDecisionPayload = {
  schemaVersion: "southstar.runtime.recovery_decision.v1";
  decisionId: string;
  exceptionId: string;
  runId: string;
  taskId?: string;
  handExecutionId?: string;
  path: RecoveryPath;
  reason: string;
  operatorApprovalRequired: boolean;
  previousAttemptId?: string;
  nextAttemptId?: string;
  supersedes?: string[];
  evidenceRefs: string[];
  createdAt: string;
};
```

## 6. Exception Scenarios

### 6.1 Tork Queue Timeout

Condition：

- `hand_execution.status = queued`
- `queuedAt + queueTimeoutSeconds < now`
- no `hand.execute_started`
- Tork job still queued, missing, or unreachable

Flow：

```text
RuntimeObserver detects queued timeout
  -> runtime_exception(kind=tork_queue_timeout, severity=recoverable)
  -> recovery_decision(path=requeue-hand-execution)
  -> old hand_execution = lost
  -> task returns to pending or claimed for new attempt
  -> new handExecutionId / attemptId
  -> scheduler submits new per-task Tork job
```

If retry budget is exhausted：

```text
recovery_decision(path=block-for-operator)
task = blocked
run remains running or failed by completion gate when terminal
```

### 6.2 Tork Running Hang

Condition：

- `hand_execution.status = running`
- latest heartbeat older than `heartbeatTimeoutSeconds`
- no terminal callback
- Tork job still running, lost, or not observable

Flow：

```text
RuntimeObserver detects heartbeat loss
  -> runtime_exception(kind=tork_running_hang, severity=recoverable)
  -> recovery_decision(path=reprovision-hand)
  -> old hand_execution = lost
  -> optional Tork cancel command resource
  -> hand_binding = lost or destroyed
  -> new hand_binding provisioned
  -> new attempt submitted
```

If workspace state is unsafe or partial writes are detected：

```text
recovery_decision(path=rollback-workspace, operatorApprovalRequired=true)
task = blocked
operator chooses rollback or continue from snapshot
```

### 6.3 Tork Terminal Without Callback

Condition：

- Tork says job terminal
- Southstar has no callback receipt
- no accepted or rejected `artifact_ref`

Flow：

```text
runtime_exception(kind=tork_terminal_without_callback)
  -> try callback artifact recovery if Tork logs expose result
  -> otherwise recovery_decision(path=retry-same-task-new-attempt)
```

Tork terminal status alone cannot complete task.

### 6.4 Late Or Stale Callback

Condition：

- callback arrives for superseded `attemptId` or old `handExecutionId`
- task already terminal from newer attempt

Flow：

```text
runtime_exception(kind=late_callback or stale_callback, severity=warning)
  -> recovery_decision(path=none-observe-only)
  -> callback stored as ignored evidence
  -> no task/run status mutation
```

### 6.5 Callback Contract Violation

Condition：

- callback missing required lineage
- artifact payload does not satisfy required schema
- `runId/taskId/attemptId/handExecutionId` mismatch

Flow：

```text
runtime_exception(kind=callback_contract_violation, severity=blocking)
  -> artifact_ref(status=rejected) if payload can be safely represented
  -> recovery_decision(path=repair-artifact or block-for-operator)
```

### 6.6 Tool Proxy Violation

Condition：

- credential-shaped value appears in context packet, envelope, tool call, callback artifact, callback events, or metrics
- hand sandbox attempts direct provider credential use
- lease missing, expired, over-scoped, or used outside allowed tool set

Flow：

```text
ToolProxyPolicyEnforcer detects violation
  -> tool_proxy_violation(status=blocking)
  -> runtime_exception(kind=tool_proxy_violation, severity=blocking)
  -> recovery_decision(path=block-for-operator or fail-task)
  -> completion gate fails while blocking violation exists
```

### 6.7 Artifact Rejected

Condition：

- callback returns `ok=false`
- artifact gate rejects required fields
- evaluator detects unsupported final report

Flow：

```text
artifact_ref(status=rejected or needs_repair)
  -> runtime_exception(kind=artifact_rejected)
  -> recovery_decision(path=repair-artifact or retry-same-task-new-attempt)
```

### 6.8 Brain Or Hand Provision Failure

Condition：

- `BrainProvider.wake()` fails
- `HandProvider.provision()` fails
- `TorkHandProvider.executeTask()` submit fails

Flow：

```text
runtime_exception(kind=brain_wake_failed | hand_provision_failed | hand_submit_failed)
  -> release claim if no hand execution was accepted
  -> recovery_decision(path=wake-new-brain | reprovision-hand | retry-same-task-new-attempt)
```

## 7. Lifecycle Hardening

### 7.1 Run Lifecycle

```text
created
  -> scheduling
  -> running
  -> evaluating
  -> passed | failed | cancelled
```

Rules：

- `scheduling` starts when `/execute` succeeds.
- `running` starts only when at least one task or hand execution is `running`, or when queued work has been accepted by scheduler and provider evidence confirms execution ownership.
- `evaluating` starts only when all tasks are terminal.
- `passed` / `failed` are written only by completion gate.

### 7.2 Task Lifecycle

```text
pending
  -> claimed
  -> queued
  -> running
  -> completed | failed | lost | blocked | cancelled
```

Rules：

- `claimed`, `queued`, `running` all consume run-level concurrency slots.
- `queued` must have exactly one active `hand_execution`.
- `running` requires heartbeat, callback progress, or Tork observation evidence.
- `completed` requires accepted `artifact_ref`.
- `lost` requires runtime exception classification.
- `blocked` requires runtime exception plus recovery decision requiring operator approval or unrecoverable policy failure.

### 7.3 Hand Execution Lifecycle

```text
queued
  -> running
  -> completed | failed | lost | superseded | cancelled
```

Rules：

- Same `runId/taskId` cannot have two non-terminal hand executions for the same active attempt.
- A retry creates a new `attemptId` and `handExecutionId`.
- Old active attempts must become `lost`, `superseded`, or `cancelled` before a replacement attempt becomes active.
- Late callbacks from superseded attempts are evidence only.

## 8. Tool Proxy Full-Path Enforcement

Tool proxy enforcement has three layers.

### 8.1 Pre-Execution Gate

Before hand execution submit：

- Scan work item metadata, workflow manifest runtime context, context packet, task envelope, and hand execution payload.
- Reject raw token-shaped values and forbidden env keys.
- Require `toolProxyPolicyRef` for every task intent.
- Materialized envelope may contain proxy endpoint, lease id, allowed tool names, TTL, redaction policy; it may not contain raw credentials.

### 8.2 Runtime Tool Call Gate

During task execution：

- Hand sandbox calls Southstar tool proxy, not provider APIs directly.
- Tool proxy validates lease, allowed tool, scope, TTL, task lineage, risk tags.
- Tool call result is filtered/redacted before it can become session event or artifact content.
- Every tool call writes `tool_proxy_call` resource and history event.

### 8.3 Callback Gate

On callback：

- Scan artifact, events, metrics, and logs before accepting.
- Credential leak creates `tool_proxy_violation` and `runtime_exception`.
- Callback cannot write accepted `artifact_ref` while blocking violation exists for the same hand execution.

## 9. Work Item Intake End-To-End

Work item intake becomes the only product-level entry for new work.

```text
source request
  -> WorkItemIntakeService
  -> work_items row
  -> workflow draft
  -> workflow run
  -> run.runtime_context_json.workItemRef
  -> /execute
```

Inputs：

- API prompt。
- CLI command。
- UI workflow chat。
- GitHub-like issue or ticket。
- Custom source adapter。

Rules：

- Same `(sourceProvider, sourceRef)` dedupes to one work item.
- Every run created from a work item records `runAttempt`.
- Recovery/fork attempts link back to the same work item unless operator explicitly creates a child work item.
- Intake validation failure creates `runtime_exception(kind=intake_invalid)` only after a work item identity can be established; otherwise it returns request-level validation error without runtime mutation.
- UI and read model show work item, run attempts, current run status, blocking exceptions, and last recovery decision together.

## 10. Completion Gate

Completion gate passes only when all conditions are true：

1. All tasks are terminal.
2. Every completed task has accepted `artifact_ref`.
3. No blocking `tool_proxy_violation` exists.
4. No unresolved `runtime_exception` with severity `blocking` or `terminal` exists.
5. No open `recovery_decision` is waiting for operator approval.
6. Final report or completion artifact references required upstream accepted artifact refs.

Failure does not directly mean retry. Completion failure creates:

```text
runtime_exception(kind=completion_gate_failed)
  -> recovery_decision(path=repair-artifact | block-for-operator | fail-run)
```

## 11. Read Model And Operator UX

Run inspection must expose：

- work item identity and run attempt。
- task status and active attempt。
- brain binding and hand binding。
- hand execution status, Tork job id, queue age, heartbeat age。
- accepted/rejected `artifact_ref`。
- runtime exceptions grouped by scope and severity。
- recovery decision and approval requirement。
- tool proxy violations。
- evaluator result and findings。

Operator actions：

- approve recovery。
- retry same task new attempt。
- reprovision hand。
- wake new brain。
- mark exception resolved with reason。
- block task。
- fail run through evaluator path。

Operator action must append history and update resource state; it must not mutate task/run status without going through recovery application or completion gate.

## 12. Real E2E Matrix

Existing case `00-13` remains canonical. Add hardening cases after current matrix:

```text
14 tork queue timeout recovery
15 tork running hang heartbeat recovery
16 late callback from superseded attempt
17 tool proxy runtime call enforcement
18 work item intake to run execution
19 completion gate blocks unresolved exception
20 operator-approved rollback/retry path
```

Rules：

- Real cases run one command at a time.
- Missing Postgres/Tork/Pi infra fails closed.
- Assertions use Postgres rows and read models, not console text.
- No fake/mock/test-only shortcut in real cases.

## 13. Implementation Boundaries

New focused modules：

- `src/v2/exceptions/runtime-exception-controller.ts`
- `src/v2/exceptions/types.ts`
- `src/v2/exceptions/postgres-runtime-exceptions.ts`
- `src/v2/executor/tork-observer.ts`
- `src/v2/tool-proxy/runtime-enforcement.ts`
- `src/v2/work-items/run-materialization.ts`

Extend existing modules instead of rebuilding their responsibilities：

- `src/v2/server/runtime-loops.ts`：add exception observer loop。
- `src/v2/scheduler/runnable-task-scheduler.ts`：report claim/provision/submit failures through exception controller。
- `src/v2/executor/postgres-tork-callback.ts`：route stale/late/contract failures through exception controller。
- `src/v2/evaluators/completion-gate.ts`：block unresolved exceptions。
- `src/v2/session-recovery/postgres-controller.ts`：consume runtime exception classifications and persist decision lineage。
- `src/v2/server/routes.ts`：add operator exception/recovery endpoints。
- `src/v2/read-models/*`：surface exception and recovery state。

## 14. Acceptance Criteria

1. `/execute` remains thin and never whole-workflow submits to Tork。
2. Every per-task Tork job has `hand_execution` lineage。
3. Queue timeout produces `runtime_exception(tork_queue_timeout)` and recovery decision。
4. Running hang produces `runtime_exception(tork_running_hang)` and recovery decision。
5. Late callback from superseded attempt is ignored as evidence only。
6. Callback contract violation cannot complete task。
7. Tool proxy violation blocks accepted artifact and completion。
8. Completion gate fails unresolved blocking exceptions。
9. Work item intake links API/CLI/UI-created runs to canonical `work_items`。
10. Read model exposes exception classification and recovery decision。
11. Real E2E cases cover queue timeout, running hang, late callback, tool proxy enforcement, intake-to-run, and operator-approved recovery。
12. Root `npm test`, `tsc --noEmit`, `npm run web:build`, and static Postgres boundary tests pass。

## 15. Risks

- Exception controller can become a god object if it owns provider-specific logic. Keep provider observation adapters separate from classification/decision.
- Over-eager auto-recovery can repeat harmful actions. Retry budget and operator approval are mandatory for rollback, destructive workspace changes, and repeated timeouts.
- Tool proxy enforcement may initially block existing harness behavior. The migration must fail closed in real runtime while tests document required envelope/proxy shape.
- Real E2E timeout cases can be slow or flaky if they wait for wall-clock defaults. Tests should use short per-case timeout config while preserving the same production code path.

## 16. Next Step

Write an implementation plan that starts with exception resource contracts and controller tests, then wires Tork queue/running timeout detection, completion gate blocking, tool proxy enforcement, intake-to-run materialization, read model exposure, and real E2E hardening cases.

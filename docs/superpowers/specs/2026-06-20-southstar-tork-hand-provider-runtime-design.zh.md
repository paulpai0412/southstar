# Southstar Tork Hand Provider Managed Runtime Design

日期：2026-06-20
更新：2026-06-21
狀態：design reviewed

## 1. 背景

Southstar 目前已經有 managed-agent meta-harness 的主要 interface 與 Postgres runtime 骨架：`SessionStore`、`BrainProvider`、`HandProvider`、Postgres `workflow_history`、`runtime_resources`、managed scheduler、recovery controller、vault/tool proxy、read model、real Postgres E2E 都已存在。

但現行 `/api/v2/runs/:runId/execute` 仍先把整個 workflow submit 給 Tork，之後才由 managed scheduler 補 `brain_binding`、`hand_binding`、`task.dispatch_submitted` 等 runtime state。這會讓 Tork 成為實際 workflow executor，而 managed-agent layer 變成補資料。這不符合 managed agents 的目標：Southstar 應是 durable control plane，Tork 應是可替換的 hand execution plane。

本設計把 Tork 改成 **per-task HandProvider**：Southstar scheduler 決定哪些 task 可跑、何時可跑、可以併發多少；Tork 只負責實際執行單一 task job、queue/worker/heartbeat/callback observation。Postgres 仍是唯一 runtime truth。

這份文件同時把既有 remaining work 納入同一條 runtime 設計，而不是另開補資料機制：

1. `artifact_ref` 契約統一。
2. evaluator/end-state gate 接入 completion。
3. work item intake 自動化。
4. tool proxy 全路徑 enforcement。
5. 更 native 的 brain-hand task loop。

## 2. 目標

1. `/execute` 不再直接 submit whole-workflow Tork job。
2. Tork submit 只發生在 `TorkHandProvider.executeTask()` 或等價 per-task hand execution boundary。
3. Run、task、hand execution 狀態能區分 `scheduling`、`claimed`、`queued`、`running`。
4. Southstar scheduler 能控制 task 併發，而 Tork worker pool 負責實際 job 執行併發。
5. `artifact_ref` 成為 dependency gate 與 evaluator completion 的 canonical artifact contract。
6. Completion 必須經 evaluator/end-state gate，不可只由 Tork terminal status 決定。
7. Work item intake 統一 API、CLI、UI、GitHub-like source 到 canonical `work_items`。
8. Tool proxy policy 對 run/context/envelope/callback 全路徑 fail-closed。
9. Recovery decision、checkpoint、attempt lineage 由 Southstar 持久化控制。
10. Brain/hand loop 成為 managed runtime 的執行模型，Tork 只是其中一個 hand backend。

## 3. 非目標

- 不把 Southstar 改成 Tork workflow wrapper。
- 不讓 Tork DAG 成為 canonical dependency truth。
- 不在此設計中實作新的 Tork server 或 worker。
- 不要求立即移除 legacy executor APIs；但新 managed runtime path 不應依賴 whole-workflow submit。
- 不以 Tork internal retry 取代 Southstar recovery policy。
- 不讓 external issue/ticket projection 直接決定 run terminal status。
- 不讓 tool proxy 成為 optional helper；它是 managed runtime 的安全邊界。

## 4. 整體架構

```text
Intake Sources
  GitHub / Linear / CLI / UI / API prompt
    -> WorkItemIntakeService
       -> work_items canonical record
       -> Workflow Draft / Run materialization

Southstar Managed Runtime
  -> RunExecutionController
  -> RunnableTaskScheduler
  -> BrainProvider
  -> HandProviderRegistry
       -> TorkHandProvider
  -> ArtifactRefStore / ArtifactGate
  -> EvaluatorCompletionGate
  -> ToolProxyPolicyEnforcer
  -> RecoveryController
  -> Read Models

Execution Plane
  -> Tork queue / worker / callback / heartbeat
```

Boundary responsibilities:

- **WorkItemIntakeService**：把 external source 轉成 canonical `work_items`，負責 dedupe、source identity、run attempt linkage。
- **RunExecutionController**：只把 run 轉成 `scheduling`，喚醒 scheduler，不 submit Tork workflow。
- **RunnableTaskScheduler**：決定 dependency ready、claim、concurrency、brain wake、hand execution submit。
- **BrainProvider**：從 session/context 醒來，產生 task execution intent 與 tool/artifact expectations。第一階段可由 deterministic/default brain intent 承接，但 contract 要存在。
- **HandProvider**：執行一個 task attempt。Tork 是 `TorkHandProvider`，不是 workflow owner。
- **ArtifactRefStore**：唯一負責 canonical `artifact_ref` normalization、hash、accepted/rejected/needs_repair gate。
- **EvaluatorCompletionGate**：唯一能把 all-terminal run 變成 `passed` 或 `failed` 的元件。
- **ToolProxyPolicyEnforcer**：保證所有 hand/tool 路徑使用 vault lease + proxy，不允許 raw credential 進入 hand sandbox、Tork envelope、callback artifact。
- **RecoveryController**：根據 queued timeout、running heartbeat loss、rejected artifact、evaluator failure 建立 recovery decision，並產生新 attempt lineage。
- **Postgres**：唯一 truth。Tork state、brain intent、tool calls、artifact refs、evaluator result 都必須投影回 `workflow_history` 與 `runtime_resources`。

Tork 的價值仍保留：queue、worker pool、job isolation、callback/heartbeat、execution log。但 Southstar 不再把 workflow DAG 與 completion truth 交給 Tork。

## 5. Status Model

### 5.1 Run Lifecycle

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

### 5.2 Task Lifecycle

```text
pending
  -> claimed
  -> queued
  -> running
  -> completed | failed | cancelled | lost | blocked
```

- `pending`：尚未 ready 或尚未被 scheduler claim。
- `claimed`：scheduler 已用 Postgres transaction claim，準備建立 brain intent 與提交 hand execution。
- `queued`：Tork job 已提交，等待 worker。
- `running`：Tork heartbeat、poll 或 callback 已確認 worker 開始。
- `completed`：task artifact gate accepted。
- `failed`：task terminal failure，等待 recovery/evaluator policy。
- `lost`：execution attempt 無法確認，需 recovery decision。
- `blocked`：policy 或 intake/security 條件阻擋，需要 recovery 或 operator intervention。

### 5.3 Hand Execution Lifecycle

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
- `brainBindingId`
- `handBindingId`
- `providerId = "tork"`
- `torkJobId`
- `queuedAt`
- `startedAt`
- `terminalAt`
- `previousAttemptId`
- `supersededBy`
- `queueTimeoutSeconds`
- `heartbeatTimeoutSeconds`

### 5.4 Concurrency Semantics

Southstar 控制 logical concurrency；Tork 控制 worker execution concurrency。

`claimed`、`queued`、`running` 都應占用 run-level concurrency slot，因為它們都代表 Southstar 已承諾一次 execution attempt。這可避免短時間內 submit 過多 Tork jobs，超出 operator 對 run 的控制。

Concurrency inputs:

- `effortPolicy.maxParallelTasks`
- `effortPolicy.maxHandsPerBrain`
- `providerCapacity.tork.maxQueuedPerRun`
- `providerCapacity.tork.maxRunningPerRun`
- work item 或 domain policy 的 risk/cost limit

## 6. Canonical Resource Contracts

### 6.1 `artifact_ref`

`artifact_ref` 是 dependency gate 與 evaluator completion 的 canonical runtime resource。舊 `artifact` 可以保留為 payload/blob/detail 或 legacy read model projection，但不能被 scheduler 或 evaluator 當成 truth。

Resource shape:

```text
runtime_resources(
  resource_type = "artifact_ref",
  resource_key = "artifact_ref:{runId}:{taskId}:{attemptId}:{contentHash}",
  run_id,
  task_id,
  session_id,
  scope = "artifact",
  status = accepted | rejected | needs_repair,
  payload_json = ArtifactRefPayload,
  summary_json = ArtifactRefSummary,
  metrics_json = ArtifactRefMetrics
)
```

Payload:

```ts
type ArtifactRefPayload = {
  schemaVersion: "southstar.runtime.artifact_ref.v1";
  artifactRefId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  producer: {
    actorType: "hand" | "brain" | "tool-proxy" | "evaluator";
    providerId: string;
  };
  artifactType: string;
  status: "accepted" | "rejected" | "needs_repair";
  contentRef?: {
    kind: "runtime_resource" | "secure_blob" | "external_url" | "inline_digest";
    ref: string;
    sha256: string;
  };
  contractRefs: string[];
  summary: string;
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  sourceEventRefs: string[];
  producedAt: string;
};
```

Rules:

- Callback ingestion must validate `runId/taskId/attemptId/handExecutionId` lineage before accepting an artifact.
- `ArtifactRefStore.acceptOrReject()` normalizes payload, computes content hash, writes idempotent `artifact_ref`, and appends `artifact.accepted`, `artifact.rejected`, or `artifact.needs_repair`.
- Scheduler `dependenciesReady()` reads only accepted `artifact_ref` rows.
- Fan-in task context receives accepted `artifact_ref` summaries and selected `contentRef`; raw upstream transcripts are not passed by default.
- Legacy `artifact` rows do not unlock downstream work or final completion.

### 6.2 `hand_execution`

`hand_execution` tracks a single provider execution attempt.

```ts
type HandExecutionPayload = {
  schemaVersion: "southstar.runtime.hand_execution.v1";
  handExecutionId: string;
  providerId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  brainBindingId: string;
  handBindingId: string;
  externalJobId?: string;
  status: "queued" | "running" | "completed" | "failed" | "lost" | "superseded" | "cancelled";
  queuedAt: string;
  startedAt?: string;
  terminalAt?: string;
  previousAttemptId?: string;
  supersededBy?: string;
};
```

Same task and same active attempt can have only one non-terminal `hand_execution`.

### 6.3 `tool_proxy_policy` and `tool_proxy_violation`

Tool proxy policy is produced during run materialization or intake policy classification.

```ts
type ToolProxyPolicy = {
  schemaVersion: "southstar.tool_proxy_policy.v1";
  runId: string;
  sessionId: string;
  allowedTools: string[];
  requiredProxyTools: string[];
  forbiddenDirectEnvKeys: string[];
  vaultLeaseRefs: string[];
  maxLeaseTtlSeconds: number;
  redactResultPayloads: true;
  failClosed: true;
};
```

Violation payload:

```ts
type ToolProxyViolation = {
  schemaVersion: "southstar.tool_proxy_violation.v1";
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId?: string;
  severity: "blocking" | "warning";
  reason:
    | "raw_credential_in_context"
    | "raw_credential_in_envelope"
    | "direct_tool_without_proxy"
    | "callback_payload_leak"
    | "missing_required_lease"
    | "expired_lease";
  evidenceRef: string;
  redactedExcerpt?: string;
  detectedAt: string;
};
```

Completion gate must fail closed when unresolved blocking `tool_proxy_violation` exists.

## 7. Work Item Intake Automation

Work item is the canonical work identity before draft/run. External records are source inputs or projections, not runtime truth.

Input:

```ts
type WorkItemIntakeInput = {
  sourceProvider: "api" | "cli" | "github" | "linear" | "ui" | "scheduler";
  sourceScope?: string;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  body: string;
  domain: string;
  priority?: "low" | "normal" | "high" | "urgent";
  labels?: string[];
  requestedBy?: string;
  metadata?: Record<string, unknown>;
};
```

Responsibilities:

- **Dedupe**：`sourceProvider + sourceRef` is the idempotency key for external sources. Without `sourceRef`, generate an internal id.
- **Normalize**：GitHub issue、Linear ticket、CLI prompt、UI prompt all become one `work_items` shape.
- **Policy classify**：select domain、effort policy hint、security profile、allowed tools、evaluator profile。
- **Draft seed**：create planner draft seed with `workItemRef`。
- **Run linkage**：every run attempt from the same work item updates `run_refs_json` and `workflow_runs.runtime_context_json.workItemRef`。
- **Attempt semantics**：one active run attempt per work item by default. Parallel attempts require explicit operator request.
- **Projection**：external issue/ticket status is projection only; evaluator gate remains final runtime truth.

Run reference:

```ts
type WorkItemRunRef = {
  runId: string;
  runAttempt: number;
  statusAtLink: "created" | "scheduling";
  reason: "initial" | "retry" | "operator_requested" | "recovery_fork";
  createdAt: string;
};
```

`workflow_runs.runtime_context_json.workItemRef`:

```json
{
  "workItemId": "wi_...",
  "sourceProvider": "github",
  "sourceRef": "owner/repo#123",
  "runAttempt": 2,
  "intakeVersion": "southstar.work_item_intake.v1"
}
```

Error handling:

- Duplicate external webhook returns the existing work item and appends an event when useful.
- Incomplete source payload creates `work_items(status=needs_triage)` and does not auto-draft.
- Active run conflict rejects or queues the requested attempt unless `allowParallelAttempts=true`.
- External projection failure records `projection_failed` resource/history and does not alter run truth.

## 8. New Runtime Data Flow

### 8.1 Intake To Draft

```text
external source/prompt
  -> WorkItemIntakeService.upsert()
  -> work_items(status=open|ready|needs_triage)
  -> planner draft generated with workItemRef
  -> runtime_resources(planner_draft, status=validated)
```

### 8.2 Draft To Run

```text
POST /api/v2/runs
  -> workflow_runs(status=created)
  -> workflow_tasks(status=pending)
  -> context_packet per task
  -> tool_proxy_policy per run/session
  -> workflow_history: run.created, task.created
  -> work_items.run_refs_json += WorkItemRunRef
```

### 8.3 Execute

```text
POST /api/v2/runs/:runId/execute
  -> validate run is created/scheduling
  -> workflow_runs.status = scheduling
  -> workflow_history: run.scheduling_started
  -> wake scheduler
  -> return without submitting Tork job directly
```

`/execute` means Southstar has accepted control of the run. It does not mean Tork has started a worker.

### 8.4 Native Brain-Hand Scheduler Tick

```text
for each run in scheduling/running:
  read workflow_tasks
  read accepted artifact_ref task ids
  find pending tasks whose dependencies are accepted
  apply concurrency/capacity gates
  transactionally claim task: pending -> claimed
  BrainProvider.wake(sessionId, contextPacketId)
  create TaskExecutionIntent
  ToolProxyPolicyEnforcer validates intent and context
  HandProvider.provision()
  TorkHandProvider.executeTask()
```

Atomic claim must lock the run/task rows and re-check task status plus concurrency counters in the same transaction.

### 8.5 Task Execution Intent

```ts
type TaskExecutionIntent = {
  schemaVersion: "southstar.brain.task_execution_intent.v1";
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  attemptId: string;
  expectedArtifactContracts: string[];
  allowedToolNames: string[];
  toolProxyPolicyRef: string;
  handProviderId: "tork" | string;
  executionMode: "single_task";
  instructionsRef: string;
  inputArtifactRefs: string[];
};
```

First implementation can use deterministic/default brain intent:

- Reads manifest task, context packet, accepted upstream refs.
- Produces `TaskExecutionIntent`.
- Emits `brain.intent_created`.
- Keeps the contract compatible with later Pi/Codex/Claude Code brain providers.

### 8.6 Tork Hand Execution

```ts
type ExecuteTaskInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  brainBindingId: string;
  handBindingId: string;
  intent: TaskExecutionIntent;
  contextPacketRef: string;
  acceptedInputArtifactRefs: string[];
  toolProxyPolicyRef: string;
};
```

```text
TorkHandProvider.executeTask()
  -> validate tool proxy policy and envelope
  -> materialize only this task envelope
  -> submit one Tork job for this task
  -> runtime_resources(hand_execution, status=queued)
  -> workflow_tasks.status = queued
  -> workflow_history: hand.execute_queued
```

Legacy `HandProvider.execute(binding, call)` can remain as compatibility wrapper. Managed scheduler must call `executeTask()` or an equivalent typed adapter.

### 8.7 Tork Started

Tork heartbeat, callback, or poll observes worker start:

```text
hand_execution: queued -> running
workflow_tasks: queued -> running
workflow_runs: scheduling -> running
workflow_history: hand.execute_started
```

### 8.8 Tork Terminal Callback

```text
callback received
  -> workflow_history: executor.callback_received
  -> validate callback lineage
  -> append selected agent/task events
  -> scan for tool proxy violations
  -> ArtifactRefStore writes accepted/rejected/needs_repair artifact_ref
  -> hand_execution completed/failed
  -> workflow_tasks completed/failed/lost/blocked
```

Callback identity must include:

- `runId`
- `taskId`
- `attemptId`
- `handExecutionId`
- artifact hash

This identity is used for idempotency and late callback handling.

### 8.9 Fan-In

```text
upstream task completed
  -> accepted artifact_ref exists
  -> downstream dependency becomes ready
  -> scheduler may claim downstream/fan-in task
  -> fan-in context reads accepted artifact refs and selected session events
```

Fan-in must not consume raw upstream transcripts by default.

### 8.10 Completion

```text
all tasks terminal
  -> workflow_runs.status = evaluating
  -> EvaluatorCompletionGate runs
  -> passed if gates pass
  -> failed if gates reject or unresolved terminal failures remain
```

Tork terminal state alone is insufficient to mark run `passed`.

## 9. Evaluator Completion Gate

Completion gate inputs:

- task statuses
- accepted/rejected/needs_repair `artifact_ref`
- required artifact contracts from domain pack and manifest
- final report artifact refs
- evaluator result resources
- recovery decisions
- tool proxy violations
- work item policy and attempt policy

`passed` requires:

1. All required tasks are terminal and no unresolved `failed` or `lost` task remains.
2. Every required artifact contract has an accepted `artifact_ref`.
3. Final/completion report references all required upstream accepted refs.
4. No unresolved evaluator finding remains.
5. No unresolved blocking `tool_proxy_violation` remains.
6. Recovery policy has no pending mandatory action.

`failed` is produced when:

- Evaluator explicitly rejects the end state.
- Required artifact is missing.
- Terminal failure exceeds recovery policy.
- Security/tool proxy gate fails closed.
- Work item policy disallows further attempts.

`needs_repair` does not directly make the run failed. It creates a recovery decision or follow-up task until policy is exhausted.

## 10. Tool Proxy Full-Path Enforcement

Tool proxy enforcement has four fail-closed points.

### 10.1 Run Materialization

- Domain/security profile produces `tool_proxy_policy`.
- Context packet can include only `vaultLeaseRef`, `toolProxyEndpointRef`, and allowed tool names.
- Context packet, `workflow_manifest_json`, and `runtime_context_json` are scanned for credential-like values.
- Raw token/password/API key values create blocking `tool_proxy_violation`.

### 10.2 Hand/Tork Envelope Creation

- `TorkHandProvider.executeTask()` calls policy enforcer before materializing envelope.
- Envelope includes only tool proxy endpoint, lease id, capability names, and redaction policy.
- Tork job env cannot contain forbidden direct env keys.
- Required proxy tool without active vault lease blocks the task and records policy evidence.

### 10.3 Tool Call Execution

- Hand sandbox calls Southstar tool proxy, not provider APIs directly.
- Tool proxy validates lease run/session/tool/expiry/scope.
- Tool handler raw result is not written directly to session/log/artifact.
- Redacted summary, secure blob digest, or contentRef is persisted.
- Each call writes `tool_proxy_call` and `tool_proxy.called`.

### 10.4 Callback And Artifact Ingestion

- Callback payload is scanned before `artifact_ref` acceptance.
- Credential-like values, raw lease secrets, or forbidden env keys create `artifact_ref(status=rejected)` plus blocking violation.
- Completion gate fails closed while blocking violations remain unresolved.

## 11. Recovery And Error Handling

### 11.1 Tork Queued Timeout

```text
task = queued, hand_execution = queued
queueTimeoutSeconds exceeded
  -> recovery_decision(strategy="requeue-hand-execution")
  -> old hand_execution = lost
  -> task -> pending or claimed according to retry policy
  -> scheduler submits new Tork job
```

Queued timeout is not task failure. It means this execution attempt did not start.

### 11.2 Running Heartbeat Lost

```text
task = running, hand_execution = running
heartbeatTimeoutSeconds exceeded
  -> recovery_decision(strategy="reprovision-hand")
  -> session_checkpoint(type=before-recovery)
  -> old hand_execution = lost
  -> new hand_execution submitted
```

### 11.3 Tork Terminal Failure

```text
Tork job failed or callback ok=false
  -> artifact_ref rejected or failure evidence
  -> task failed
  -> evaluator/recovery policy decides retry, fork, or run failure
```

### 11.4 Duplicate Or Late Callback

Duplicate callback:

- Same `runId/taskId/attemptId/handExecutionId/artifactHash`.
- Return accepted duplicate result.
- Do not append duplicate terminal events.

Late callback:

- Callback belongs to superseded/lost attempt.
- Record as late observation.
- Do not overwrite newer attempt or task status.

### 11.5 Brain Crash

```text
brain_binding failed/lost
  -> recovery_decision(strategy="wake-new-brain")
  -> session_checkpoint(type=before-recovery)
  -> BrainProvider.wake(sessionId, contextPacketId)
```

Brain recovery reads Postgres session/context truth, not old process memory.

### 11.6 Policy Or Intent Failure

If `BrainProvider.wake()`, intent creation, or tool policy validation fails:

- Task must not silently return to `pending`.
- Runtime writes `recovery_decision` or blocking policy resource.
- Task moves to `blocked` or `failed` according to policy.
- Scheduler does not retry without a new decision.

## 12. Tork Retry Policy

Tork internal retry must not hide attempt lineage from Southstar.

Recommended default:

- Tork internal retry: disabled or set to 0/1 for transient worker bootstrap failures only.
- Southstar retry: canonical retry/fork/requeue/reprovision policy.
- Every execution attempt gets a new `handExecutionId`.

If Tork retry is enabled, each retry attempt must be observable through callback/poll events and mapped to Southstar attempt lineage. Otherwise it should not be used for managed runtime paths.

## 13. API Changes

### 13.1 Execute

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

### 13.2 Work Item Intake

`POST /api/v2/work-items/intake`

Response:

```json
{
  "workItemId": "wi_...",
  "status": "ready",
  "deduped": false
}
```

The route is an API entry point for the same service used by CLI/UI/GitHub-like adapters.

### 13.3 Scheduler Tick

Internal or operator route may expose:

```text
POST /api/v2/runs/:runId/scheduler/tick
```

Response includes:

- claimed task ids
- queued hand execution ids
- skipped task ids and reasons
- capacity/concurrency decisions

### 13.4 Hand Execution Read Model

Read models should expose:

- work item ref and run attempt
- `brain_binding`
- `task_execution_intent`
- `hand_binding`
- `hand_execution`
- `artifact_ref`
- evaluator result and completion gate status
- tool proxy policy and violations
- queue/running/terminal timestamps
- attempt lineage
- recovery decision refs

## 14. Migration Slices

Each slice must leave runtime behavior verifiable and keep Postgres as canonical truth.

### Slice 1: Canonical Contracts

- Add or formalize `artifact_ref`, `hand_execution`, `tool_proxy_policy`, `tool_proxy_violation` contracts.
- Update taxonomy and static runtime gates.
- Add `ArtifactRefStore`.
- Callback ingestion writes `artifact_ref`.
- Legacy `artifact` remains only compatibility projection.

### Slice 2: Evaluator Completion Gate

- All terminal tasks move run to `evaluating`.
- Add `EvaluatorCompletionGate`.
- Gate checks artifact graph, final report refs, unresolved failures, recovery decisions, and tool proxy violations.
- Only gate pass can set `passed`.

### Slice 3: Automated Intake

- Add `WorkItemIntakeService.upsert()`.
- Wire API/CLI/UI entry points through intake service.
- Draft/run creation carries `workItemRef`.
- Enforce one active attempt per work item unless explicitly overridden.

### Slice 4: Tool Proxy Enforcement

- Add run/context/envelope/callback scanning.
- Tork envelope forbids raw credentials.
- Required proxy tools require active vault leases.
- Blocking violations fail completion gate.

### Slice 5: Native Brain-Hand Loop

- Scheduler claim changes `pending -> claimed`.
- Default brain creates `TaskExecutionIntent`.
- Add `TorkHandProvider.executeTask()` for single-task Tork jobs.
- Task lifecycle becomes `claimed -> queued -> running -> terminal`.
- `/execute` starts scheduling only.

### Slice 6: Per-Task Tork Runtime E2E

- Independent tasks submit multiple Tork jobs under Southstar concurrency.
- Fan-in waits for accepted `artifact_ref`.
- Queued/running observation updates state.
- Duplicate/late callback is lineage-safe.
- Recovery decision is written before retry/requeue/reprovision.

## 15. Testing Strategy

### Unit Tests

- `artifact_ref` normalization, hash, idempotency.
- Scheduler only uses accepted `artifact_ref` to unlock dependencies.
- Legacy `artifact` does not unlock dependencies.
- Completion gate pass/fail/needs_repair.
- Tool proxy violation fail-closed behavior.
- Work item dedupe and run attempt linkage.
- Brain intent validation.
- Same task cannot have two active hand executions.
- `/execute` does not call `executorProvider.submit`.

### Postgres Integration Tests

- Run moves `created -> scheduling`; Tork job absent until scheduler claim.
- Scheduler claim/queued/running occupy concurrency slots.
- Callback writes `artifact_ref` and terminal hand execution.
- All terminal tasks move `running -> evaluating -> final`.
- Active work item attempt conflict follows policy.
- Raw credential in context/envelope/callback creates blocking violation.

### Real Postgres/Tork E2E

- Normal per-task Tork execution.
- Two runnable tasks submit two Tork jobs under `maxParallelTasks`.
- Fan-in task starts only after upstream accepted refs.
- Tork queued timeout or lost heartbeat recovery.
- Duplicate callback idempotency.
- Final passed only after evaluator gate.
- Security case proves no raw credential in runtime surfaces.

## 16. Acceptance Criteria

1. Managed `/execute` path never submits a whole-workflow Tork job.
2. `scheduling` can exist while no Tork worker is running.
3. Scheduler can submit per-task Tork jobs concurrently within Southstar limits.
4. Every Tork task attempt has `hand_execution` lineage.
5. Downstream readiness uses only accepted `artifact_ref`.
6. Legacy `artifact` cannot unlock dependency or completion.
7. All run terminal transitions pass through `evaluating` and evaluator gate.
8. Work item intake creates stable deduped `work_items` and run attempt refs.
9. Tool proxy policy blocks raw credential context/envelope/callback paths.
10. Recovery creates `recovery_decision` before retry/requeue/reprovision.
11. Read models expose work item, brain intent, hand execution, artifact refs, evaluator result, policy violations, and recovery lineage.
12. Existing whole-workflow submit remains only as explicitly deprecated compatibility path or tests fixture; managed runtime does not depend on it.

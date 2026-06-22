# Southstar Managed Context Session Memory Design

日期：2026-06-22
狀態：design draft

## 1. 背景

Southstar v2 目前已把 runtime 主軸收斂到 Postgres canonical truth、per-task Tork hand、runtime exception/recovery decision apply、completion gate 與 managed-agent read model。現有能力包含：

- `TaskEnvelopeV2` 可承載 `contextPacket`、session、artifact contracts、skills、MCP grants、vault lease refs、workspace handle 與 rendered `agentPrompt`。
- `ContextPacket` 已有 selected memories、knowledge cards、prior artifacts、checkpoint summary、failure summary、workspace summary、token estimate 與 managed source refs 欄位。
- `SessionStore` 已支援 append/slice session events 與 idempotent checkpoint。
- callback ingestion 已寫入 `artifact_ref`、session events、hand terminal state，並由 completion gate 決定 run final status。
- `RuntimeExceptionController` 與 `RecoveryDecisionApplier` 已能把 abnormal evidence 轉成 recovery decision 並套用 state transition。
- domain pack 已有 `sessionPolicies` 與 `memoryPolicies`，其中 `software-memory-default` 定義 Postgres provider、scope、ranking、compression、approval policy。

目前缺口在於 context/session/memory 還沒有成為整個 workflow 的共同 runtime 主路徑：

- `context/postgres-builder.ts` 目前可注入 knowledge cards，但 `selectedMemories` 仍是空集合。
- session event slice、checkpoint refs、artifact refs、memory refs 與 rollback/reset marker 尚未統一由一個 assembler 決定。
- normal task execution 與 recovery task execution 曾存在兩條 context materialization 路徑；舊 `dispatchRecoveryExecutionPg()` 會直接 materialize recovery envelope 並 submit Tork。
- validator/consumer failure、producer artifact repair、reset/fork/rollback、memory writeback 雖可由既有元件組合出來，但尚未有一份 workflow-wide contract 保證所有 role/task 都走同一套規則。

本設計把下一階段收斂成 **Managed Context 主路徑**：task 真正執行時，session/history/checkpoint/artifact_ref/memory 必須被統一組成 compact `ContextPacket` 與 `TaskEnvelopeV2`；callback 後的 output/finding/memory 必須回寫成下一個 task 或 recovery attempt 可用的 durable context。

## 2. 設計目標

1. 建立 workflow-wide `ManagedContextAssembler`，正常流程與異常恢復流程都由同一條 path 組 context。
2. 明確分離 `ContextPacket` 與 `TaskEnvelopeV2` 的職責。
3. session checkpoint/fork/reset/rollback 全部以 recovery decision 驅動，不由 UI/session API 直接改 runtime fate。
4. memory 分成 run-local memory 與 long-term memory approval path；同一 workflow 內可立即使用短期 memory，跨 run memory 必須審核。
5. validator/consumer failure 透過 artifact producer/consumer lineage 泛化到任意 DAG，不 hardcode role 名稱。
6. recovery applier 不 materialize envelope、不 submit Tork；它只改 durable state，讓 scheduler 重新走 canonical context assembly。
7. 每個 attempt 的 session/event/resource 都有一致 lineage keys，可被 reset/rollback/context selection 正確納入或排除。
8. context assembly 必須 deterministic、可驗證、可追溯、可安全掃描 credential。
9. real E2E 必須同時覆蓋 normal flow 與 abnormal flow，且兩者都驗證 session/memory/context handling。

## 3. 非目標

- 不新增另一套 workflow engine。
- 不把 Tork DAG back-edge 當成 semantic repair loop。
- 不讓 Tork/Pi/container process state 成為 session truth。
- 不把完整 transcript、raw logs 或 raw tool result 直接塞入 task envelope。
- 不讓 pending long-term memory 自動跨 run 注入。
- 不在本設計 hardcode implement/validator role 行為；producer/consumer repair 必須由 artifact lineage 與 recovery policy 推導。
- 不重新導入 SQLite、V1/Northstar runtime 或舊 local API path。

## 4. 核心決策

1. 移除舊 recovery dispatcher 主路徑。
   `dispatchRecoveryExecutionPg()` 不再直接 materialize recovery envelope + submit Tork。implementation plan 應移除該函式與 runtime 呼叫點；若測試仍需 fixture，必須改名為 test-only helper，不能留在 production recovery path。case 04/05 應改走 recovery decision apply + scheduler。

2. session 操作全部走 recovery decision。
   `fork-session`、`reset-session`、`rollback-session` 都建立或更新 recovery decision，由 `RecoveryDecisionApplier` 套用。session API 不直接改 task/run/hand fate。

3. rollback-session 包含 workspace rollback。
   rollback 必須有 workspace snapshot 或 hand snapshot evidence，且一律需要 operator approval。rollback apply 成功後寫 rollback marker，context builder 必須排除 marker 覆蓋的 refs。

4. memory 使用雙層模型。
   run-local memory 同一 workflow 內可立即被後續 task/recovery attempt 使用；long-term memory 先寫 `memory_delta(status=pending_approval)`，approval 後才生成 `memory_item(status=approved)`。

5. envelope 採 compact blocks + source refs。
   `TaskEnvelopeV2` 不放完整 transcript。runner 啟動所需 context 由 compact `ContextBlock` 組成，完整 evidence 留在 Postgres resource/history，可由 source refs 追溯。

6. assembler 採三個實作單元，不做五層 class 過度拆分。
   內部可保留 collectors/planner/validator 概念，但 implementation 上收斂成 `ContextSourceBuilder`、`ContextAssemblyPolicy`、`ManagedContextAssembler`。

## 5. ContextPacket 與 TaskEnvelopeV2

`ContextPacket` 是 task 的語意上下文。它回答：

- task 目標是什麼？
- role instruction 與 agent profile 是什麼？
- 哪些 upstream accepted `artifact_ref` 可用？
- 哪些 run-local/long-term memory 被注入？
- 這次 execution 從哪個 checkpoint/failure/rollback state 恢復？
- 哪些 session events 被納入、摘要、排除？
- token budget 如何使用？
- 所有來源 refs 是什麼？

`TaskEnvelopeV2` 是 container/hand runner 的完整執行契約。它包含 `ContextPacket`，並增加：

- run/task/workflow identity。
- role、agent profile、harness definition。
- skill snapshots。
- MCP grants。
- vault lease refs。
- artifact contracts。
- evaluator pipeline。
- session id 與 baseCheckpointId。
- workspace handle 或 snapshot ref。
- rendered `agentPrompt`。

簡化規則：

```text
ContextPacket = agent 要知道什麼
TaskEnvelopeV2 = container 要怎麼執行這個 agent task
```

因此 memory/session/artifact selection 不應散落在 `TaskEnvelopeV2` builder 裡。正確順序是：

```text
ManagedContextAssembler
  -> ContextPacket
  -> TaskEnvelopeFactory wraps ContextPacket into TaskEnvelopeV2
  -> Materializer writes envelope file/resource
  -> Tork hand executes
```

## 6. 目標架構

```text
RunnableTaskScheduler
  -> ManagedContextAssembler.buildTaskContext(runId, taskId, attemptId)
     -> ContextSourceBuilder.collect()
     -> ContextAssemblyPolicy.planAndValidate()
     -> persist context_packet + task_envelope + context_assembly_trace
  -> brain_binding / hand_binding
  -> task_execution_intent
  -> TorkHandProvider.executeTask()
  -> Tork/Pi runner reads TaskEnvelopeV2
  -> callback
  -> CallbackIngestion writes durable outputs
  -> next scheduler/recovery/completion cycle reads same durable context
```

### 6.1 ContextSourceBuilder

`ContextSourceBuilder` 從 Postgres 收集候選資料，並轉成候選 `ContextBlock` 或 candidate refs。它不決定最終要放入 prompt 的內容。

來源：

- session events：同 session、同 run、同 artifact/failure correlation 的 compact slice。
- accepted upstream `artifact_ref`：依 DAG dependsOn 與 producer/consumer lineage。
- checkpoint：task-start、artifact-accepted、before-recovery、manual。
- run-local memory：同 run、status active、未被 rollback invalidated。
- long-term memory：status approved、符合 domain/project scope 與 allowed kinds。
- knowledge cards：既有 evolution selection。
- failure context：runtime exception、validator/evaluator finding、rejected artifact。
- workspace context：workspace snapshot、rollback evidence、changed files summary。
- tool proxy/security context：allowed tool refs、lease refs、forbidden actions summary。

### 6.2 ContextAssemblyPolicy

`ContextAssemblyPolicy` 是防錯核心。它根據 domain/context/memory/session policy 做 deterministic selection。

責任：

- scope filter。
- accepted artifact only。
- artifact producer/consumer lineage resolution。
- run-local memory active only。
- long-term memory approved only。
- pending `memory_delta` 不跨 run 注入。
- reset marker 排除失敗 attempt suffix。
- rollback marker 排除 invalidated events/artifacts/run-local memory。
- token budget enforcement。
- ranking/order deterministic。
- excluded candidates 附 reason。
- credential-shaped content scan。
- source refs 完整性驗證。
- required artifact/checkpoint/session ref validation。

### 6.3 ManagedContextAssembler

`ManagedContextAssembler` 串接 source builder 與 policy，輸出並持久化：

- `context_packet` resource。
- `task_envelope` resource。
- `context_assembly_trace` resource 或 summary。

`context_assembly_trace` 至少包含：

- assembler version。
- runId/taskId/sessionId/attemptId/handExecutionId。
- selected source refs。
- excluded candidate refs/reasons。
- token estimate。
- rollback/reset marker refs。
- memory selected/excluded counts。
- deterministic `cacheKey` 或 source fingerprint。

如果 validation 失敗，assembler 必須停止在 Southstar 層，不提交 Tork。validation failure 可形成 `runtime_exception(kind=context_assembly_failed)` 或 scheduler prepare failure，依嚴重度決定 recovery path。

## 7. Normal Flow Data Flow

```text
Run created
  -> workflow_tasks pending
  -> scheduler claims runnable task
  -> attemptId / handExecutionId assigned
  -> ManagedContextAssembler builds context
  -> task-start checkpoint
  -> context_packet + task_envelope + assembly_trace persisted
  -> brain_binding / hand_binding
  -> task_execution_intent
  -> TorkHandProvider.executeTask()
  -> Tork/Pi runner reads TaskEnvelopeV2
  -> callback
  -> callback ingestion writes:
       session events
       artifact_ref
       hand_execution terminal state
       run-local memory
       memory_delta candidates
  -> completion gate or next runnable task
```

Normal flow rules：

- scheduler 是唯一 submit per-task Tork hand 的 runtime path。
- task completion requires accepted `artifact_ref`。
- downstream task readiness depends on accepted upstream `artifact_ref` and DAG dependencies。
- downstream task context includes compact artifact summaries/refs, not full artifact bodies unless policy allows inline digest summary。
- run-local memory created by upstream task can be injected into downstream task in the same run。
- selected context must record `managedSourceRefs` for event refs, transform refs, checkpoint refs, artifact refs and memory refs。

## 8. Abnormal Flow Data Flow

```text
runtime_exception
  -> recovery_decision
  -> RecoveryDecisionApplier
     -> create before-recovery checkpoint
     -> apply fork/reset/rollback/requeue/reprovision state changes
     -> task back to pending or blocked
  -> scheduler
  -> ManagedContextAssembler rebuilds fresh context from durable refs
  -> per-task Tork hand
```

Abnormal flow rules：

- recovery applier does not materialize task envelope。
- recovery applier does not submit Tork。
- every recovery attempt rebuilds fresh context。
- stale/late callbacks are audit evidence only and cannot mutate current task/run fate。
- context after recovery must include relevant failure summary/checkpoint refs and exclude invalidated source ranges。
- completion gate blocks unresolved runtime exception, unapplied recovery decision, waiting approval, active rollback inconsistency, missing accepted artifact, or credential violation。

## 9. Attempt Lineage Contract

`attempt events` 是一次 task execution attempt 期間產生的 history/resource evidence，不是單一 event type。

任何可能進入下一次 context selection 的 event/resource 都必須能追到：

```text
runId
taskId
sessionId
attemptId
handExecutionId
contextPacketId
taskEnvelopeId
artifactRefIds
checkpointId
correlationId / causationId when available
```

attempt 開始於 scheduler claim task 並準備 dispatch：

```text
pending task
  -> scheduler claim
  -> attemptId assigned
  -> handExecutionId assigned
  -> task-start checkpoint
  -> context_packet / task_envelope
  -> brain.woke
  -> hand.provisioned
  -> brain.intent_created
  -> hand.execute_queued
  -> task.dispatch_submitted
```

執行中可能產生：

```text
executor.heartbeat
session.entry
progress.commentary
tool_proxy_call
tool_proxy_result
hand running observation
```

callback 時產生：

```text
executor.callback_received
artifact.accepted | artifact.rejected
artifact.created
executor.callback_completed
hand_execution terminal patch
checkpoint.created(kind=artifact-accepted)
memory.writeback_recorded
memory_delta.created
```

exception/recovery 時產生：

```text
runtime_exception.observed
runtime_exception.classified
runtime_exception.recovery_decided
recovery_execution.started
checkpoint.created(kind=before-recovery)
recovery_execution.succeeded | blocked | failed
```

reset/rollback/context assembly 必須使用 attempt lineage 決定哪些 source 可被注入。

## 10. Session Semantics

session truth 只來自 Postgres event/resource，不來自 Pi/Tork process memory。

每次 task attempt 都有一個 `sessionId`，`workflow_tasks.root_session_id` 指向目前 active session。host-native Pi rewind/fork 只能是 optimization；若 provider 不支援，Southstar 仍可透過 checkpoint + context replay 完成恢復。

### 10.1 Checkpoint Types

- `task-start`：scheduler claim 後、submit 前建立。記錄 context packet、task envelope、input artifact refs、workspace snapshot ref。
- `artifact-accepted`：callback accepted 後建立。記錄 artifact refs、session event range、memory writeback refs。
- `before-recovery`：RecoveryDecisionApplier apply 前建立。記錄 exception、decision、failed hand/session、最後有效 context refs。
- `manual`：operator 明確要求 checkpoint 時建立。

### 10.2 Fork

`fork-session` 從 checkpoint 建立新的 session branch，用於探索替代策略。

Rules：

- 不 invalidated 原 branch。
- 產生新 `sessionId`。
- task 回 `pending`。
- scheduler 下一輪重建 context。
- context source refs 指向 base checkpoint 與 fork reason。

### 10.3 Reset

`reset-session` 重跑同一 task。

Rules：

- 從 checkpoint 重建 context。
- checkpoint 後的舊 attempt events 不再注入新 context。
- 舊 active hand/session attempt 標 `superseded` 或 `lost`。
- task 回 `pending`。
- 不處理 workspace rollback。
- 不影響 approved long-term memory。
- 只排除該 attempt checkpoint 後產生的 run-local memory。

### 10.4 Rollback

`rollback-session` 包含 workspace rollback 語義，必須 operator approval。

Rules：

- requires `workspaceSnapshotRef` or `handSnapshotRef` evidence。
- decision starts as `waiting_operator_approval`。
- approval 後 applier 執行 provider workspace rollback action。
- 寫入 `session_rollback` / `workspace_rollback` / rollback marker。
- rollback marker invalidates checkpoint 後受影響 events、artifact refs、run-local memory、pending memory_delta。
- affected task/downstream task 轉 `pending` 或 `blocked` 重新評估。
- scheduler 下一輪重建 context。

### 10.5 Host-Native Rewind

`host-native-rewind` 是 provider action，不是 canonical truth。

Rules：

- 成功時仍必須寫 Southstar checkpoint/session operation evidence。
- 失敗時 fallback 到 Southstar-native reset/fork。
- 不可跳過 `RecoveryDecisionApplier` 與 context assembly。

## 11. Memory Semantics

memory 分為 run-local memory 與 long-term memory。

### 11.1 Run-Local Memory

Run-local memory 是 workflow 內的短期學習匯流排。

Properties：

- scope：`run:{runId}` 或 `run-local`。
- status：`active | invalidated`。
- 來源：callback artifact、session summary、evaluator finding、consumer failure、operator note。
- 用途：同一 workflow 內後續 task 或 recovery attempt 可立即注入。
- 不跨 run 使用。
- reset/rollback 可 invalidated。

### 11.2 Long-Term Memory

Long-term memory 是跨 run 可重用記憶。

Flow：

```text
candidate learning
  -> memory_delta(status=pending_approval)
  -> operator/learning approval
  -> memory_item(status=approved)
```

Rules：

- 未 approval 不可跨 run 注入。
- memory text 必須是 compact summary 或 extracted claim。
- raw transcript 不直接進 long-term memory。
- rejected artifact 不可自動成為 positive memory，但可成為 failure lesson candidate。
- credential-shaped content 禁止寫入 run-local 或 long-term memory。
- approval 後保留 source refs，讓 operator 可 audit 這個 memory 為何被注入。

### 11.3 Retrieval

`ManagedContextAssembler` memory retrieval：

```text
read active run-local memory for same run
search approved long-term memory by scopes/kinds/query
rank by relevance/recency/success/confidence
compress to memory ContextBlock
enforce maxInjectedTokens
record selected/excluded candidates
```

Ranking 使用 domain pack `memoryPolicies[].ranking`。Compression 使用 policy `compression`，初期可用 extractive summary，後續再加入 semantic compression。

### 11.4 Writeback

Callback/evaluator/operator writeback：

```text
Callback artifact/session events/evaluator findings
  -> MemoryWritebackPolicy
  -> run-local memory active
  -> memory_delta pending_approval for long-term candidates
  -> source refs point to artifact_ref/evaluator/session events
```

## 12. Artifact Producer/Consumer Repair Loop

本設計不 hardcode implement/validator。任意 consumer task 因 input `artifact_ref` 失敗，都可透過 artifact lineage target producer task。

General flow：

```text
producer task
  -> artifact_ref accepted
consumer task
  -> consumes artifact_ref
  -> fails/rejects/finding linked to artifact_ref
Southstar
  -> runtime_exception
  -> recovery_decision targets producer task or current task by policy
  -> before-recovery checkpoint
  -> run-local failure memory
  -> target task new attempt
consumer/downstream
  -> waits for new accepted artifact_ref
```

Rules：

- DAG tells which tasks depend on which producers。
- `artifact_ref` tells what was consumed。
- finding/evaluator report tells why it failed。
- recovery policy decides who retries。
- session reset/fork gives the target task a clean new attempt。
- run-local memory carries repair hints forward。
- Tork DAG does not own semantic back-edge。

If producer artifact was previously accepted but later failed by consumer validation, do not delete the artifact. Preserve it as evidence and create repair/supersession lineage:

```text
artifact_ref attempt-1 = accepted, later superseded/repair_required by finding
artifact_ref attempt-2 = new accepted artifact after repair
consumer consumes attempt-2
```

If current statuses are insufficient, introduce `artifact_repair_marker` or `artifact_lineage` resource instead of mutating immutable artifact payload。

## 13. Exception And Recovery Integration

All abnormal paths enter `RuntimeExceptionController` before recovery.

### 13.1 Queue Timeout

```text
hand_execution queued timeout
  -> runtime_exception(tork_queue_timeout)
  -> recovery_decision(requeue-hand-execution)
  -> old hand_execution lost
  -> task pending
  -> scheduler rebuilds context and submits attempt N+1
```

### 13.2 Running Hang / Hand Lost

```text
running hang / hand lost
  -> runtime_exception(tork_running_hang)
  -> recovery_decision(reprovision-hand)
  -> before-recovery checkpoint
  -> old hand/attempt lost
  -> new hand binding if needed
  -> task pending
  -> scheduler rebuilds context and submits attempt N+1
```

### 13.3 Artifact Rejected / Consumer Finding

```text
artifact rejected or consumer finding
  -> runtime_exception(artifact_rejected | validation_failed)
  -> recovery_decision(reset-session | repair-artifact | fork-session)
  -> before-recovery checkpoint
  -> target task pending
  -> context excludes failing suffix
  -> context includes failure summary and run-local repair memory
```

### 13.4 Operator Rollback

```text
operator rollback-session
  -> recovery_decision(rollback-session, waiting_operator_approval)
  -> operator approval
  -> before-recovery checkpoint
  -> workspace rollback evidence
  -> rollback marker invalidates affected refs
  -> affected task/downstream pending or blocked
  -> scheduler rebuilds context
```

### 13.5 Late / Stale Callback

```text
late/stale callback
  -> runtime_exception(stale_callback | late_callback)
  -> recovery_decision(none-observe-only)
  -> callback preserved as ignored evidence
  -> no context mutation except audit trail
```

## 14. Security And Validation

Context assembly and callback ingestion must both enforce security constraints.

Pre-submit validation：

- no raw credential-shaped content in context blocks。
- no raw secret in task envelope, hand payload, task intent, memory, artifact summaries。
- vault leases are refs only。
- MCP grants list allowed server/tool names only。
- tool proxy policy ref exists for task intent。
- rollback-invalidated refs excluded。
- required artifact refs and checkpoint refs exist。
- token estimate within policy。
- managed source refs populated。

Callback validation：

- scan artifact/events/metrics before persistence。
- rejected or blocked callback cannot create accepted artifact_ref。
- credential leak creates `tool_proxy_violation` and runtime exception。
- memory writeback uses sanitized compact summary only。

## 15. Resource Model Additions

Prefer `runtime_resources` over new dedicated tables unless query pressure requires tables later。

New or clarified resource types：

- `context_assembly_trace`：assembler source selection and validation trace。
- `memory_item`：
  - run-local: `scope=run:{runId}`, `status=active|invalidated`。
  - long-term: `scope=software|project`, `status=approved|archived`。
- `memory_delta`：`status=pending_approval|approved|rejected|invalidated`。
- `session_operation` or explicit `session_fork` / `session_reset` / `session_rollback` resources。
- `workspace_rollback`：provider action evidence for rollback-session。
- `rollback_marker`：invalidated event/artifact/memory refs/ranges。
- `artifact_repair_marker` or `artifact_lineage`：consumer finding supersedes producer artifact。

Resource payloads must include lineage keys where applicable：

```text
runId
taskId
sessionId
attemptId
handExecutionId
contextPacketId
taskEnvelopeId
artifactRefIds
checkpointId
sourceRefs
```

## 16. API And Route Semantics

Existing routes can remain, but semantics change to decision-driven behavior。

- `POST /api/v2/runs/:runId/tasks/:taskId/fork-session`
  creates recovery decision path `fork-session` and returns decision/read model evidence。

- `POST /api/v2/runs/:runId/tasks/:taskId/reset-session`
  creates recovery decision path `reset-session` and returns decision/read model evidence。

- `POST /api/v2/runs/:runId/tasks/:taskId/rollback-session`
  creates recovery decision path `rollback-session`, status `waiting_operator_approval`。

- `POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval`
  approves/rejects operator-gated recovery。

- `POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply`
  explicit apply trigger; runtime loop may also apply。

- `GET /api/v2/runs/:runId/tasks/:taskId/envelope`
  returns latest persisted `TaskEnvelopeV2` built by assembler, not an ad hoc envelope built by route-local logic。

## 17. Read Model Requirements

Run/task read models must expose enough evidence for operator debugging：

- latest `context_packet` with selected block counts and source refs。
- latest `task_envelope` summary。
- context assembly trace, excluded reasons and validation errors。
- session lineage: current session, base checkpoint, attempt history。
- memory selected/excluded, run-local active memory, long-term approved memory refs。
- pending memory deltas。
- rollback/reset/fork markers。
- artifact producer/consumer lineage。
- runtime exceptions and recovery decisions。
- recovery executions and provider actions。

## 18. Migration And Removal Plan

1. Add canonical assembler and tests while leaving current scheduler behavior intact behind a local call boundary。
2. Update scheduler to build context/envelope through assembler before hand execution。
3. Move route envelope read to persisted latest task envelope。
4. Add memory service and writeback policy。
5. Add session operation recovery paths for fork/reset/rollback。
6. Update recovery applier to create session/rollback markers and release tasks without materializing envelopes。
7. Remove `dispatchRecoveryExecutionPg()` from production runtime and update E2E case 04/05 away from direct recovery submit。
8. Add static gate preventing runtime imports/calls to legacy dispatcher。

## 19. Testing Strategy

### 19.1 Unit And Integration Tests

`ManagedContextAssembler`：

- collects accepted upstream `artifact_ref`。
- injects active run-local memory。
- injects approved long-term memory。
- excludes pending long-term `memory_delta`。
- excludes rollback-invalidated refs。
- records `managedSourceRefs` and `context_assembly_trace`。
- enforces token budget。
- rejects credential-shaped content。
- persists `context_packet` and `task_envelope` with matching ids。

`ContextAssemblyPolicy`：

- deterministic ranking/order。
- excluded candidate reasons。
- rollback/reset/fork source filtering。
- source refs completeness。

`MemoryService`：

- callback/evaluator finding -> run-local memory active。
- long-term candidate -> `memory_delta(pending_approval)`。
- approval -> `memory_item(approved)`。
- rollback invalidates run-local memory and pending deltas。

`RecoveryDecisionApplier`：

- fork/reset/rollback creates checkpoint/marker and releases correct target task。
- rollback requires approval。
- applier does not submit Tork。
- applier does not materialize envelope。

Static gates：

- no runtime code imports/calls `dispatchRecoveryExecutionPg`。
- no SQLite/local API usage in v2 runtime path。
- no task envelope contains raw credential-shaped values。

### 19.2 Real E2E Requirements

Real E2E must include both normal and abnormal flow with Tork/Pi/Postgres。

#### Real E2E 1: Normal Flow Context Propagation

```text
task A through real Tork/Pi
  -> callback accepted
  -> session events persisted
  -> artifact_ref accepted
  -> run-local memory active
task B through real Tork/Pi
  -> TaskEnvelopeV2 includes:
       accepted artifact_ref from A
       compact session summary/source refs
       run-local memory from A
       approved long-term memory if seeded
  -> callback accepted
  -> completion gate passed
```

Required Postgres evidence：

- `context_packet.selectedMemories.length > 0`。
- `context_packet.priorArtifacts` references task A artifact。
- `managedSourceRefs.rawEventRefs` or `transformRefs` populated。
- checkpoint refs populated where policy requires。
- `task_envelope.payload.envelope.contextPacket.id` matches persisted context packet。
- `workflow_history` has session events for both task attempts。
- `artifact_ref` for both tasks accepted。
- run final status `passed`。

#### Real E2E 2: Abnormal Flow Recovery Context

```text
producer task through real Tork/Pi
  -> artifact_ref accepted
consumer task through real Tork/Pi
  -> callback rejected or evaluator finding linked to producer artifact_ref
  -> runtime_exception
  -> recovery_decision targets producer/current task by artifact lineage
  -> before-recovery checkpoint
  -> run-local failure memory active
  -> target task new attempt through real Tork/Pi
  -> TaskEnvelopeV2 includes:
       failure summary
       failed artifact_ref/source refs
       checkpoint ref
       run-local repair memory
       excludes invalidated failed suffix
  -> repaired callback accepted
  -> downstream reruns or completion gate passes
```

Required Postgres evidence：

- `runtime_exception` created。
- `recovery_decision` applied。
- `recovery_execution` succeeded。
- `session_checkpoint(kind=before-recovery)`。
- new `sessionId` / new `attemptId`。
- old attempt marked `lost` or `superseded` where applicable。
- run-local memory created from failure finding。
- rebuilt `context_packet` includes failure/memory/checkpoint refs。
- rebuilt `task_envelope` uses new context packet。
- final accepted artifact from retry。
- completion gate no longer blocked。

## 20. Acceptance Criteria

1. All executable task attempts use `ManagedContextAssembler` to create persisted context packet and task envelope。
2. Normal path and recovery path use the same context assembly logic。
3. `dispatchRecoveryExecutionPg()` is removed from runtime path, with tests updated away from direct recovery submit。
4. session fork/reset/rollback are recovery decisions, not direct session mutations。
5. rollback-session requires operator approval and writes workspace rollback evidence。
6. run-local memory is injected within the same workflow without approval。
7. long-term memory requires approval before cross-run injection。
8. consumer failure can target producer task through artifact lineage without role hardcoding。
9. every context packet includes source refs sufficient to audit selected events/artifacts/memory/checkpoints。
10. reset/rollback markers affect context selection deterministically。
11. real E2E covers both normal and abnormal Tork/Pi/Postgres flows with session and memory evidence。

## 21. Open Implementation Risks

- Context assembly could become too large if not kept to three practical units.
  Mitigation：`ContextSourceBuilder` functions stay small; `ContextAssemblyPolicy` owns deterministic filtering; `ManagedContextAssembler` only orchestrates/persists。

- Memory ranking may be weak without semantic search.
  Mitigation：start with deterministic lexical/metadata scoring using existing policy weights; leave vector search as provider improvement。

- Existing E2E 04/05 may depend on legacy dispatcher behavior.
  Mitigation：rewrite them as canonical recovery path tests instead of preserving dispatcher。

- Workspace rollback provider action may fail after approval.
  Mitigation：record provider action failure as `recovery_execution` evidence and keep task blocked; do not partially mark context rolled back without marker evidence。

- Context source refs may be incomplete for older history events.
  Mitigation：assembler can create transform refs and omitted ranges; implementation should gradually enforce full lineage for new events。

## 22. Consistency Check

- Southstar remains canonical truth；Tork remains execution backend。
- Recovery decision apply remains the only abnormal fate mutation path。
- Scheduler remains the only submit path。
- Context assembly is shared by normal and recovery attempts。
- Session truth comes from Postgres, not process memory。
- Memory propagation is workflow-wide and not role-specific。
- No hardcoded implement/validator loop is required；artifact lineage generalizes producer/consumer repair。

# Southstar Pi Planner + Tork Runtime 設計文件（中文版）

日期：2026-06-11

## 1. 目標

Southstar v2 是一套動態 multi-agent workflow system。核心設計是：

- 以 `pi-web` 作為唯一 UI。
- 以 Pi Agent LLM 作為 planner，負責根據 user prompt 生成 workflow 與 agent/container 定義。
- 一次 planner run 產生一份 `SouthstarWorkflowManifest`，它是唯一 canonical workflow。
- `SouthstarWorkflowManifest.tasks[]` 同時包含 DAG、Tork execution spec、agent/root/subagent 定義、artifact gate、memory、vault、MCP 與 retry/approval policy。
- Southstar 不 fork Tork；Tork 以 upstream execution provider 方式整合。
- 以 Tork 負責 Docker job、container lifecycle、retry 與 executor 狀態。
- 以 SQLite 保存所有 durable state，包括 session、memory、artifact、vault、MCP、executor binding、progress、steering、signals。
- container agent 依 `TaskEnvelope` 動態生成並執行，完成後銷毀 container，但保留必要 session、memory、vault lease、artifact 與 evaluator result。

MVP 先完成 software engineering domain workflow，後續再加入 data analysis、deep research、voice/mobile、CubeSandbox 與 learning loop。

## 2. 非目標

- 不遷移舊 Southstar/Northstar v1 SQLite 資料。
- 不保留 v1 GitHub issue lifecycle 作為核心 runtime model。
- 不硬編碼 `issue_to_pr_release` 這類固定 workflow。
- 不整合成兩個 web；Tork Web 不作為 iframe、第二 dashboard 或外部必要 UI。
- 不讓 Tork DB 成為 Southstar source of truth。
- MVP 不直接支援 CubeSandbox；CubeSandbox 只作為後續 `SandboxProvider` 或 executor provider。
- 不讓 LLM output 直接執行；所有 planner output 必須先經 schema validation、policy check、UI approval。

## 3. MVP 範圍

MVP 必須形成一條完整 vertical slice：

1. 使用者在 `pi-web` 輸入 goal prompt。
2. Pi Agent planner session 產生 `SouthstarWorkflowManifest`。
3. `SouthstarWorkflowManifest` 內含單一 task DAG，每個 task node 帶有 execution spec 與 agent runtime metadata。
4. Southstar 對 canonical workflow manifest 執行 schema validation、policy validation 與 Tork execution projection validation。
5. UI 顯示 workflow canvas、agent definition、runtime plan 與 approval gate。
6. approval 後送出 Tork Docker execution。
7. container 內啟動 `southstar-agent-runner`。
8. runner 從 SQLite/materialized input 載入 `TaskEnvelope`。
9. task root session 建立 root session，載入 memory snapshot、vault lease、MCP grants、subagent definition。
10. root session 派發 subagent/harness 執行。
11. subagent 產生 artifact。
12. evaluator 驗證 artifact schema、quality rubric、policy。
13. 若不合格，root session 要求同一 subagent repair。
14. evaluator 通過後建立 checkpoint，保存 artifact、session、memory delta、signals。
15. orchestrator 更新 workflow run status。
16. UI runtime monitor 即時顯示 task 狀態、progress commentary、executor job、artifact 與 evaluator result。

MVP domain：

- 第一版：software engineering workflow。
- 第二階段：data analysis workflow。
- 後續：deep research workflow。

## 4. 系統架構

```text
pi-web / Southstar UI
  -> Planner Chat
      -> Pi Workflow Planner Session
          -> SouthstarWorkflowManifest draft
              -> canonical workflow DAG
              -> task execution specs
              -> agent/root/subagent metadata
          -> Manifest validators
          -> Draft revision
          -> UI approval
          -> Tork provider materializes execution projection
          -> Tork submit
              -> Docker task container
                  -> southstar-agent-runner
                      -> TaskEnvelope
                      -> task root session
                      -> subagent execution
                      -> artifact evaluator gate
                      -> repair loop
                      -> validated artifact
          -> SQLite durable stores
          -> Runtime Monitor / Canvas / Task Detail / Artifact Viewer
```

Pi Agent 是 planner 與 orchestrator-facing LLM。Codex 不再是主 orchestrator，而是可被編排的 worker agent type。Pi、Codex、Claude Code 與 custom agent 都透過 `HarnessDefinition` 在 Docker task 中啟動。

## 5. 兩支影片納入的設計要求

### 5.1 Managed Agents / Agent OS

從 managed agents / multi-agent architecture 方向萃取出的要求：

- agent 必須是 stateless template。`AgentDefinition` 描述 agent 的 role、model、prompt、tools、MCP、skills、harness，但不保存工作記憶。
- session 是動態 execution state。`SessionStore` 保存 root/subagent transcript、checkpoint、fork、rollback、clone lineage。
- memory 以 scoped snapshot 掛載到 session，不長在 agent template 上，也不取代 artifact truth。
- worker container 必須 disposable。container 可建立、銷毀、重建，state 由 SQLite 與 `TaskEnvelope` materialize。
- coordinator 不做所有工作。Pi planner/root supervisor 負責拆 task、派工、監控、修正、彙整。
- harness 必須 explicit。每個 worker 啟動時明確指定 `pi-agent`、`codex`、`claude-code` 或 custom runner。
- checkpoint 是 scheduling primitive。orchestrator 可以從有效 checkpoint fork/clone 新 session。
- multi-model routing 是必要功能。不同 task node 可選不同 model/harness 以優化 cost、latency、token efficiency。
- evaluator 是 first-class module。root session gate 不能只靠 raw LLM output。
- fast sandbox 是後續關鍵。Docker/Tork 是 MVP；CubeSandbox 或 remote sandbox 後續接成 `SandboxProvider`。

### 5.2 Voice / Fragmented-Time Workflow

從 voice / fragmented-time workflow 方向萃取出的要求：

- voice 是 task controller，不只是文字輸入替代品。MVP 先支援等價的 command/steering event。
- workflow 是 asynchronous。使用者可下達任務後離開，workflow 在背景跑 DAG 並更新 UI。
- progress 必須 structured。runner 產生可通知、可唸出的 `progress.commentary`，不能只有 raw logs。
- steering 必須 interruptible。使用者可在 running workflow 插入修正，root session 決定 steer current subagent、restart node、rollback checkpoint 或 re-plan。
- mobile UI 需要 compressed state：running nodes、blocked nodes、next approval、latest artifact、safe actions。
- generative UI 必須 schema-driven。planner/root session 產生 structured view model，而不是任意 UI。
- runtime 要管理 multiple active tasks：multi-run queue、notification、focus mode。
- learning loop 必須保存 success/failure signals、repair 次數、model/agent 表現、operator steering，供下一次 planner 使用。

## 6. Canonical Workflow Manifest

### 6.1 SouthstarWorkflowManifest

`SouthstarWorkflowManifest` 是唯一 durable workflow truth。它描述「要完成什麼、task DAG 如何連接、每個 task 如何由 Tork 執行、由哪些 agent 做、artifact 要符合什麼 schema、需要哪些 session/memory/vault/MCP scope」。

核心欄位：

```text
manifestVersion
runId
domain
intent
workflow
tasks
taskExecution
rootSessionPolicy
agentDefinitions
harnessDefinitions
environmentDefinitions
artifactSchemas
evaluators
approvalPolicy
retryPolicy
checkpointPolicy
progressPolicy
steeringPolicy
learningPolicy
memoryPlan
vaultLeases
mcpGrants
executorBindings
```

每個 task node 同時包含 DAG、execution 與 agent runtime metadata：

```text
taskKey
dependsOn
execution                   engine=tork, image, command, env, mounts, timeout, resources, infraRetry
agentRuntime                rootSession, subagents, harnessRefs, model/tool/skill policy
gates                       evaluatorRefs, artifactContracts, onFail decision policy
resources                   memoryRefs, vaultLeaseRefs, mcpGrants
approvalPolicy
retryPolicy
```

`AgentDefinition` 封裝 agent 執行語意，不交給 Tork 判斷：

```text
agentId
agentType                  pi | codex | claude | custom
harnessRef
role
model
systemPrompt
taskPromptTemplate
skills
memoryRefs
vaultLeaseRefs
mcpGrants
artifactContract
containerProfileRef
timeoutPolicy
repairPolicy
```

### 6.2 Dynamic DAG Expansion / Workflow Revision

MVP 保留「執行中動態生成新 task DAG」能力，但只透過 Southstar canonical workflow revision 完成，不讓 Tork 直接修改 workflow。原始 manifest 是 base revision；`workflow_runs.workflow_manifest_json` 保存目前已生效 canonical revision；每次擴展都必須有 history event、resource record、validator 結果與 fingerprint。

允許發起 expansion request 的 actor：

- Pi planner：使用者 prompt refine 後產生新 task。
- root session：artifact gate 發現缺口，需要補驗證、補研究或補修復 task。
- review/evaluator agent：只能提出 structured finding 與 suggested expansion，不能直接改 DAG。
- orchestrator：根據 policy 將 finding 轉成 revision request、approval 或 reject。

Revision resource 以 `runtime_resources(resource_type='workflow_revision')` 保存：

```text
revisionId
baseRevisionId
runId
actorType
reason
status                       proposed | validated | approved | rejected | applied
manifestPatch
affectedTaskKeys
newTaskKeys
removedTaskKeys              MVP 只能移除尚未 started 的 task
dependencyChanges
validationResult
approvalRef
manifestFingerprint
idempotencyKey
```

相關 history events：

```text
workflow.revision_requested
workflow.revision_validated
workflow.revision_approved
workflow.revision_rejected
workflow.expanded
task.created
task.dependency_added
task.dependency_removed
```

Guardrails：

- revision 後的 task DAG 必須 acyclic。
- running / completed task 不可被刪除或覆寫結果。
- 已完成 task 的 artifact 不可被改寫；若需要修正，建立新 task 或新 attempt。
- dependency change 只能套用到 pending task；若影響 running task，必須走 cancel/retry policy。
- 新 task 的 `execution` 必須通過 Docker image、command、mount、env、resource、timeout allowlist。
- 新 task 的 agent/runtime metadata 必須通過 harness、MCP、vault、memory scope validator。
- 高風險 expansion，例如新增外部網路工具、讀取新 secret、寫入 production mount，必須產生 approval。
- `workflow.expanded`、`workflow_runs.workflow_manifest_json` 更新、`workflow_tasks` 新增/更新、`runtime_resources(workflow_revision)` 狀態更新必須在同一 SQLite transaction。

Tork 的角色保持單純：Southstar revision applied 後，只把新增或需要重跑的 task attempt materialize 成新的 Tork job/task。Tork callback 只回報 execution 狀態，不回寫 canonical DAG。

### 6.3 HarnessDefinition

`HarnessDefinition` 描述 agent 在 worker container 內如何啟動。它與 `AgentDefinition` 分離，讓同一個 role 可以切換 Pi Agent、Codex、Claude Code 或 custom runner，而不改 workflow semantics。

核心欄位：

```text
harnessId
harnessType                pi-agent | codex | claude-code | custom
entrypoint
capabilities
inputProtocol              task-envelope | stdin-json | http | mcp
eventProtocol              southstar-events | sse | jsonl
sessionAdapter
toolAdapter
supportsCheckpoint
supportsSteering
supportsProgressCommentary
```

規則：

- `AgentDefinition` 選擇 `harnessRef`。
- Tork 只看到 container image、command、env、mount、timeout。
- Harness 負責 agent-specific protocol translation。
- Southstar 負責 manifest、stores、evaluator、vault、MCP policy。
- Harness output 必須正規化成 Southstar runtime events 與 artifact contracts。

### 6.4 Tork Execution Projection

Tork execution projection 是 `SouthstarWorkflowManifest.tasks[].execution` 經 Tork provider materialize 出來的 executor job request。它不是第二份 canonical flow，也不包含 agent 語意，不知道 root session、subagent、artifact gate、memory body、vault secret 或 MCP token。

Tork task command 形狀：

```text
southstar-agent-runner --envelope /southstar/envelope/<taskId>.json
```

Tork task 只需要：

```text
image
command
env
mounts
resources
timeout
retry
webhook
```

Southstar 與 Tork 用 `runtime_resources(resource_type='executor_binding')` 關聯：

```text
runId
taskId
executorType = tork
torkJobId
torkTaskId
attemptId
manifestFingerprint
projectionFingerprint
status
lastEventAt
```

## 7. Planner 如何生成單一 workflow

Pi-web 不直接手寫 manifest。流程是：

1. 使用者輸入 goal prompt。
2. UI 呼叫 `POST /api/planner/drafts`。
3. Pi planner session 收到：
   - user goal prompt，
   - `SouthstarWorkflowManifest` schema，
   - available harness definitions，
   - available container profiles，
   - allowed MCP servers/tools，
   - vault lease policy，
   - evaluator contracts，
   - E2E/quality constraints。
4. Pi 產生一個 `SouthstarWorkflowManifest` JSON。
5. Southstar validator 驗證：
   - workflow schema，
   - task DAG，
   - task execution sections，
   - task/harness references，
   - artifact/evaluator references，
   - MCP grant scope，
   - vault lease scope，
   - no durable folder state policy。
6. UI 顯示 draft。
7. 使用者可用 prompt revise。
8. revision 產生 `workflow_history` 的 `planner.revised` event，並更新 `workflow_runs.snapshot_json` 的 draft projection。
9. approval 後更新 `workflow_runs` 的 manifest JSON，append `manifest.approved` event，並 submit Tork。

重要原則：

- 不 fork Tork；Tork 作為 upstream execution provider。
- 不維護兩份 workflow；`SouthstarWorkflowManifest` 是唯一 canonical flow。
- Planner 產生 canonical workflow；Tork provider 從 task `execution` section materialize Tork job。
- Southstar validators 負責保證 canonical workflow、execution spec、agent runtime metadata 一致。
- Tork 只負責 Docker 管理，不承擔 workflow semantics。

## 8. Task Root Session 設計

每個 task 有一個 root session。它不是一般 worker，而是該 task 的 schema validator、artifact gate、repair supervisor。

root session 職責：

1. 載入 `TaskEnvelope`。
2. 建立 root session record。
3. 載入 scoped memory snapshot。
4. 建立 vault leases。
5. 建立 MCP grants。
6. 選擇 subagent/harness。
7. 執行 subagent。
8. 接收 artifact。
9. 執行 evaluator。
10. 若失敗，產生 repair instruction。
11. 重試到通過或超過 `maxRepairAttempts`。
12. 建立 checkpoint。
13. 保存 session entries、artifact blobs、evaluator results、signals。
14. 回報 orchestrator。

這比單純讓 subagent 自己宣稱完成更好，因為：

- artifact 有 schema gate。
- repair loop 可被量化。
- root session 保存 checkpoint/fork lineage。
- orchestrator 不需要理解每種 domain artifact 的細節。
- evaluator 可逐步替換成更強的 rubric/policy validator。

## 9. Session / Memory / Vault

### 9.1 Session

Session 是 execution transcript 與 checkpoint，不是 agent template。

保存內容：

- root session entry。
- subagent session entry。
- tool calls。
- progress commentary。
- checkpoint。
- repair instruction。
- fork/clone lineage。

復用方式：

- same-session resume。
- fork from checkpoint。
- clone selected checkpoint into new task。
- summary injection。
- trace-only audit。

### 9.2 Memory

Memory 是可復用、經 approval 的知識或偏好，不是完整 transcript dump。

保存內容：

- approved preference。
- domain pattern。
- workflow learning。
- repair lesson。
- model/harness performance signal。

復用方式：

1. planner 根據 goal/domain 查詢 approved memory。
2. 產生 bounded memory snapshot。
3. snapshot 寫入 `TaskEnvelope`。
4. task 執行後提出 memory delta。
5. memory delta 經 approval 後才成為 reusable memory item。

### 9.3 Vault

Vault 是 secret store，不等於一般 file store。runtime 只拿到 scoped lease/ref；secret value 不寫入 `workflow_history`。

規則：

- secret durable state 由 encrypted credential provider 管理；若後續需要 SQLite 支援，寫入集中式 `secure_blobs`，並用 `runtime_resources` 的 `vault_secret_ref` / `vault_lease` resource 做索引與審計關聯。
- container 只取得 task-scoped lease。
- lease 可 materialize 成 env 或 ephemeral file。
- 不 mount `~/.ssh`。
- SSH 不是 container management 必要能力；若 task 需要 SSH，必須透過 vault lease 明確授權。

## 10. MCP 設計

MCP 是 task-scoped tool grant。MCP server registration 與 grant 以 `runtime_resources` 的 `mcp_server` / `mcp_grant` resource 集中保存；每次變更同時 append `workflow_history` event，例如 `mcp.server_registered`、`mcp.grant_created`、`mcp.grant_revoked`。

規則：

- 每個 task 明確列出 allowed MCP servers/tools。
- agent container 只拿到該 task 的 grants。
- MCP credentials 透過 vault lease 注入。
- UI 必須可審核 MCP grants。

## 11. SQLite Durable Store

MVP 不用資料夾保存 durable state。SQLite 是唯一 durable store。

核心 runtime tables 採原 Northstar `issues + issue_history` 精神：少量 snapshot 表 + append-only history。但為了未來 learning loop、session reload、memory reuse、vault/MCP registry、executor reconciliation，不把所有資源都塞在 history 裡，而是先抽成集中式 resource table。

核心 tables：

```text
workflow_runs
workflow_tasks
workflow_history
runtime_resources
artifact_blobs
secure_blobs
```

`workflow_runs` 保存 run-level snapshot：

```text
id
status
domain
goal_prompt
executor_job_id
workflow_manifest_json
execution_projection_json
snapshot_json
runtime_context_json
metrics_json
created_at
updated_at
completed_at
```

`workflow_tasks` 保存 task/node-level snapshot 與 session index：

```text
id
run_id
task_key
status
sort_order
depends_on_json
root_session_id
subagent_session_ids_json
executor_task_id
snapshot_json
metrics_json
created_at
updated_at
completed_at
```

`workflow_history` 是 append-only truth：

```text
id
run_id
task_id
sequence
event_type
actor_type
session_id
idempotency_key
correlation_id
causation_id
payload_json
created_at
```

`runtime_resources` 是集中式 resource/projection table，用來避免未來 learning loop 再改大 schema：

```text
id
resource_type
resource_key
run_id
task_id
session_id
scope
status
title
payload_json
summary_json
metrics_json
created_at
updated_at
expires_at
```

`resource_type` 先保留這些值：

```text
session
session_checkpoint
memory_item
memory_delta
workflow_learning
workflow_revision
artifact
vault_secret_ref
vault_lease
mcp_server
mcp_grant
executor_binding
approval
```

`artifact_blobs` 只放大型 artifact / binary / 長文本，metadata 對應 `runtime_resources.resource_type = artifact`：

```text
id
resource_id
run_id
task_id
session_id
artifact_type
content_type
size_bytes
sha256
body_blob
metadata_json
created_at
```

`secure_blobs` 只放加密 secret payload，不放一般 workflow state，也不被 agent 直接讀取：

```text
id
resource_id
provider
key_id
ciphertext_blob
metadata_json
created_at
rotated_at
```

Session / Memory / Learning 載入規則：

- Session metadata、root/subagent lineage、summary、checkpoint 指標放 `runtime_resources(resource_type='session'|'session_checkpoint')`。
- Session transcript 仍以 `workflow_history.session_id` 查詢，避免雙寫完整內容。
- Memory item 與 memory delta 放 `runtime_resources(resource_type='memory_item'|'memory_delta')`，approval / supersede / retrieval 事件 append 到 `workflow_history`。
- Workflow learning 放 `runtime_resources(resource_type='workflow_learning')`，供 planner 下次產生 flow 時查詢。
- `runtime_resources` 是可重建 projection/cache；每次 resource 變更必須先 append `workflow_history`，再同 transaction 更新 resource row。

管理欄位全部放 JSON：

- subagent 執行時間、工具調用次數、異常 retry、repair retry、executor retry、token 數量、成本明細，先以 `subagent.completed`、`model.usage_reported`、`tool.completed`、`retry.exception` 等事件寫入 `workflow_history.payload_json`。
- `workflow_tasks.metrics_json` 保存 task-level aggregate cache。
- `workflow_runs.metrics_json` 保存 workflow-level aggregate cache。
- `metrics_json` 可由 `workflow_history` 重建，不是唯一真相。
- 成本使用整數 `microsUsd`，不要使用 float。

`metrics_json` 範例：

```json
{
  "wallDurationMs": 300000,
  "agentDurationMsTotal": 600000,
  "toolCallCountTotal": 18,
  "exceptionRetryCountTotal": 1,
  "repairRetryCountTotal": 1,
  "executorRetryCountTotal": 0,
  "tokens": {
    "input": 42000,
    "output": 6800,
    "total": 48800
  },
  "cost": {
    "microsUsd": 15320,
    "pricingSource": "provider-usage"
  }
}
```

`workflow_runs` 不放 `current_task_id`，因為並行 task 會失真。active/blocked/completed tasks 從 `workflow_tasks.status` 查詢；`workflow_runs.snapshot_json.activeTaskIds` 只能作為可重建 cache。

Idempotency / concurrency 規則：

- `workflow_history(run_id, sequence)` 必須 unique。
- external callback 必須帶 `idempotency_key`，避免 Tork retry 或 webhook 重送造成重複計數。
- append history、更新 `workflow_tasks`、更新 `workflow_runs`、更新 `runtime_resources` 必須在同一 SQLite transaction。
- sequence 產生需使用 `BEGIN IMMEDIATE` 或等價機制，避免 parallel task 同時寫入 race。

允許 ephemeral runtime materialization：

```text
/tmp/southstar-runs/<runId>/<taskId>/
```

但完成後必須清除，不能成為 durable state。

## 12. UI 功能

第一版 UI 直接整合 pi-web，需要單一 web app，不保留獨立 Tork Web。

必備 panels：

- Planner Chat。
- Planner Drafts。
- Workflow Canvas。
- Agent Definitions。
- Runtime Monitor。
- Task Detail Drawer。
- Artifact Viewer。
- Sessions and Memory。
- Vault/MCP Review。
- Executor Ops。
- Mobile Run Summary。
- Progress Commentary。
- Steering Controls。

Dashboard 保留，但重新定位為 runtime operations dashboard。

## 13. API Surface

MVP API：

```text
POST /api/v2/planner/drafts
POST /api/v2/planner/drafts/:id/revise
POST /api/v2/runs
GET  /api/v2/runs/:runId/canvas
GET  /api/v2/runs/:runId/runtime
GET  /api/v2/runs/:runId/tasks/:taskId
GET  /api/v2/runs/:runId/artifacts/:artifactId
GET  /api/v2/runs/:runId/sessions-memory
GET  /api/v2/runs/:runId/vault-mcp
POST /api/v2/runs/:runId/steer
POST /api/v2/runs/:runId/checkpoints/:checkpointId/rollback
GET  /api/v2/executor/tork/:jobId
```

## 14. Tork 與 Docker 管理

Tork 負責：

- Docker job submit。
- Docker task scheduling。
- container lifecycle。
- infra retry。
- timeout。
- executor events。
- logs/events 回傳。

Southstar 負責：

- workflow semantics。
- manifest validation。
- task root session。
- subagent orchestration。
- artifact validation。
- session/memory/vault/MCP。
- UI read models。

Tork Provider / Adapter 不是 fork 後的自製 engine，也不是第二套 flow compiler。它只處理：

- 從 `SouthstarWorkflowManifest.tasks[].execution` materialize Tork job request。
- submit Tork job。
- poll/subscribe Tork job status。
- convert Tork runtime events into `workflow_history` 的 `executor.event` events，並更新 `workflow_tasks.snapshot_json` / `metrics_json`。
- reconcile executor bindings。

## 15. E2E 設計要求

E2E 必須使用真實環境：

- 真實 Docker。
- 真實 Tork。
- 真實 Pi planner 或 configured real harness。
- 真實 fixture repo。
- 真實 SQLite。
- 真實 UI/API。

E2E 不得使用：

- fake Tork。
- fake Docker。
- mock LLM result。
- static manifest shortcut。
- smoke-only test。

MVP E2E 要證明：

- prompt 可生成單一 canonical workflow manifest。
- workflow manifest 可通過 schema/policy/execution projection validation。
- Tork 真的啟動 Docker task。
- task root session 真的執行 artifact gate。
- evaluator 可拒絕 invalid artifact 並要求 repair。
- repair 後 artifact 通過。
- session/memory/artifact/vault/MCP/executor/progress/steering/signals 都寫入 SQLite。
- UI 可看到 workflow canvas、agent definition、runtime monitor。

## 16. 階段規劃

### Phase 1：MVP Software Workflow

- Manifest pair。
- SQLite stores。
- Pi planner。
- Tork adapter。
- Docker task runner。
- root session。
- evaluator/repair loop。
- pi-web runtime UI。
- 真實 E2E。

### Phase 2：Data Analysis Domain

- CSV/dataframe harness。
- profiling artifact。
- cleaning report。
- chart artifact。
- final report artifact。
- data-analysis E2E。

### Phase 3：Voice / Mobile / Fragmented-Time Workflow

- voice command as steering event。
- mobile compressed summary。
- multi-run queue。
- notification/focus mode。

### Phase 4：CubeSandbox / Sandbox Provider

- executor provider abstraction。
- CubeSandbox compatibility test。
- provider switch UI。

### Phase 5：Learning Loop

- workflow learning。
- memory delta approval queue。
- planner memory injection。
- model/harness performance signals。

### Phase 6：Production Hardening

- vault encryption。
- retention policy。
- backup/restore。
- cancellation/reconciliation。
- stuck executor detection。

## 17. 成功定義

MVP 完成標準：

- 使用者可在 pi-web 輸入 prompt 並生成 workflow。
- UI 可預覽 workflow canvas 與 agent definitions。
- approval 後 Tork 真的啟動 Docker task。
- container 內根據 `TaskEnvelope` 啟動 agent harness。
- task root session 驗證 artifact，必要時 repair。
- 所有 durable state 都在 SQLite。
- 不建立 durable session/memory/artifact/vault/executor folder。
- real E2E 通過。
- dashboard 可監控真實 run。

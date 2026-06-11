# Southstar Pi Planner + Tork Runtime Design

日期：2026-06-11

## 目標

Southstar v2 是一套以 Pi Agent 為 planner、以 manifest pair 描述 runtime、以 Tork 管理 Docker execution 的 dynamic multi-agent workflow system。第一版使用 `pi-web` 作為唯一 UI，不再建立第二個 web dashboard，也不遷移舊 SQLite 資料。

使用者在 `pi-web` 輸入任務 prompt 後，Pi Agent 先產生可審核的 `PlanBundle`。`PlanBundle` 內含兩份設定：

- `SouthstarManifest`：Southstar 的語意 truth，描述 workflow、task、agent、root session、subagent、artifact gate、memory、vault、MCP、approval 與 retry/completion policy。
- `TorkManifest`：Tork 的 Docker execution request，只描述 image、command、env、mount、timeout、resource limit、infra retry 與 webhook。

這兩份 manifest 由同一個 planner run 一次產生，靠 `runId`、`taskId` 與 `executorBinding` 關聯。Southstar 不把 agent 語意轉譯成 Tork 語意；Tork 也不需要理解 Pi Agent、Codex Agent、root session、subagent、artifact validation 或 MCP grants。

## 非目標

- 不遷移舊 Northstar/Southstar v1 SQLite 資料。
- 不保留 v1 GitHub issue lifecycle 作為 core runtime model。
- 不把 `issue_to_pr_release` 當成 hard-coded workflow。
- 不把 Tork Web 作為第二個 web app、iframe 或外部 dashboard。
- 不讓 Tork DB 成為 Southstar source of truth。
- 不在 MVP 支援 CubeSandbox；CubeSandbox 只作為 future `SandboxProvider`。
- 不讓 LLM output 直接執行；所有 planner output 都必須先通過 schema validation、policy check 與 UI approval。

## MVP 範圍

MVP 先完成 software engineering domain flow，之後再加入 data analysis domain。Deep research 放到後續版本。

MVP 必須包含：

- Pi-web 單一 UI。
- Pi Agent planner session。
- Prompt 生成 `PlanBundle`。
- Prompt refine 生成新的 draft revision。
- `SouthstarManifest` schema validation。
- `TorkManifest` schema validation。
- Workflow canvas 預覽。
- Agent definition 檢視。
- Runtime monitor。
- Task detail、artifact viewer、executor logs。
- Approval gate。
- Tork Docker execution。
- `TaskEnvelope` 載入。
- Task root session。
- Subagent execution，第一版可為 0 或 1 個 subagent。
- Artifact schema validation。
- Repair loop。
- SessionStore、MemoryStore、ArtifactStore、VaultStore interface。
- SQLite encrypted vault。
- MCP registry 與 scoped grants。

## 系統架構

```text
pi-web / Southstar UI
  -> Planner Chat
      -> Pi Workflow Orchestrator Session
          -> PlanBundle draft
              -> SouthstarManifest
              -> TorkManifest
          -> Southstar validators
          -> draft revision
          -> UI approval
          -> Tork submit
              -> Docker task container
                  -> southstar-agent-runner
                      -> TaskEnvelope
                      -> task root session
                      -> subagent execution
                      -> artifact gate
                      -> repair loop
                      -> validated artifact
          -> Southstar SQLite projection
          -> Runtime Monitor / Canvas / Task Detail
```

Pi Agent 是 planner 與 orchestrator-facing LLM。Codex 不再是主 orchestrator；Codex 是可被編排的 worker agent type。Pi、Codex 與後續 agent 都透過 `AgentDefinition` 進入 task container。

## Manifest Pair

### SouthstarManifest

`SouthstarManifest` 是 durable semantic truth。它描述「要完成什麼、由哪些 agent 做、產出要符合什麼 artifact schema、需要哪些 session/memory/vault/MCP scope」。

核心欄位：

```text
manifestVersion
runId
domain
intent
workflow
tasks
rootSessionPolicy
agentDefinitions
artifactSchemas
approvalPolicy
retryPolicy
memoryPlan
vaultLeases
mcpGrants
executorBindings
```

`agentDefinitions` 封裝所有 agent 執行設定，不外露給 Tork 做語意判斷：

```text
agentId
agentType                  pi | codex | claude | custom
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

### TorkManifest

`TorkManifest` 只描述 Docker execution。Tork task 不知道 agent type、root session、subagent 或 artifact gate，只知道要執行 `southstar-agent-runner`。

核心欄位：

```text
name
inputs
secrets
defaults
webhooks
tasks
```

每個 Tork task 的 command 形狀：

```text
southstar-agent-runner --envelope /southstar/envelope/<taskId>.json
```

每個 Tork task 只需要：

```text
image
run
env
mounts
timeout
retry
queue
priority
limits
webhook
```

`TorkManifest` 中的 `env` 至少包含：

```text
SOUTHSTAR_RUN_ID
SOUTHSTAR_TASK_ID
SOUTHSTAR_ENVELOPE_PATH
SOUTHSTAR_CALLBACK_URL
SOUTHSTAR_VAULT_LEASE_REF
```

## Planner Flow

Pi-web 會開一個 Southstar planner session。使用者輸入 prompt 後，Southstar backend 會提供 planner context：

- 使用者 prompt。
- domain pack，例如 `software_engineering`。
- agent catalog。
- container image catalog。
- artifact schema library。
- workflow pattern library。
- MCP registry。
- Vault policy。
- Tork runtime constraints。
- `SouthstarManifest` JSON schema。
- `TorkManifest` JSON schema。
- 前一版 draft revision，若是 refine。

Planner output 是 `PlanBundle`：

```json
{
  "summary": "short human-readable plan",
  "southstarManifest": {},
  "torkManifest": {},
  "questions": [],
  "risks": [],
  "validationNotes": []
}
```

Planner 不直接 submit execution。流程固定為：

```text
prompt
  -> PlanBundle draft
  -> schema validation
  -> policy validation
  -> invalid: errors fed back to planner for repair
  -> valid: save draft revision
  -> canvas preview
  -> user refine or approve
  -> approve: submit Tork job
```

### Prompt Refine

MVP 支援 full regenerate：使用者用自然語言調整，planner 讀上一版 draft 後產生完整新版 `PlanBundle`。

後續版本加入局部 patch：

- JSON Patch。
- prompt-to-patch。
- visual node editing。
- locked sections，避免 planner 改動已鎖定的 agent definition 或 MCP grant。
- diff view。

## Task Root Session

每個 Tork task 進入 container 後，由 `southstar-agent-runner` 載入 `TaskEnvelope` 並建立 task root session。

`TaskEnvelope` 包含：

```text
runId
taskId
rootSession
agentDefinitions
prompt
skills
memoryRefs
vaultLeaseRefs
mcpServers
allowedMcpTools
artifactSchema
repairPolicy
callback
```

Root session 是 task supervisor，不是一般 worker。它負責：

- 載入 task context。
- 載入 session/memory/skills/vault/MCP grants。
- 啟動 subagent。
- 收集 subagent output。
- 驗證 artifact schema。
- 驗證 artifact policy。
- 不合格時產生 repair prompt。
- 要求 subagent 修正。
- 合格後寫入 ArtifactStore。
- 回報 Southstar runtime event。

這是 Claude-style subagent 模型的 Southstar runtime extension。Claude Agent SDK 的 subagent 概念是 parent agent 啟動 isolated subagent，subagent 最終結果回到 parent；SessionStore 可保留 transcript。Southstar 在此模型上增加 artifact gate、repair loop、durable stores、executor event projection 與 UI approval，因為 Southstar 是 workflow runtime，不只是單次 agent conversation。

MVP 規則：

- 每個 executable task 都有 root session。
- Subagent 數量可以是 0 或 1。
- Root session 必須產出 validated artifact。
- Artifact invalid 時最多依 `repairPolicy.maxAttempts` 修正。
- 修正耗盡後 task 進入 failed 或 quarantined。

## Stores

Southstar v2 使用新資料與單一 SQLite durable store，不遷移舊資料，也不使用 persistent runtime folders 保存 session、memory、vault、artifact 或 executor binding。

```text
.southstar/southstar-v2.sqlite3
```

SQLite 是 Southstar 的 source of truth。MVP 允許 SQLite WAL sidecar files；除此之外，Southstar 不建立 durable `artifacts/`、`sessions/`、`memory/`、`vault/` 或 `runs/` folders。

Core tables:

```text
planner_drafts
planner_revisions
southstar_manifests
tork_manifests
workflow_runs
workflow_tasks
task_envelopes
session_records
session_entries
memory_items
memory_deltas
artifact_records
artifact_blobs
vault_secrets
vault_leases
mcp_servers
mcp_grants
executor_bindings
executor_events
runtime_events
```

### SessionStore

保存 root session 與 subagent transcript。資料寫入 SQLite `session_records` 與 `session_entries`，不寫入 persistent JSONL folders。

用途：

- Resume。
- Debug。
- UI session viewer。
- Root/subagent trace。

Session reuse modes:

- Same-session resume：同一個 root session 或 subagent session 因暫停、重試、container restart 或 repair loop 繼續執行時，從 `session_records` 與 `session_entries` 載入原 transcript，延續同一 session id。
- Fork from checkpoint：planner refine、manual retry 或 alternative branch 需要保留上下文但不能污染原 session 時，建立新 `session_record`，記錄 `parent_session_id` 與 `fork_from_entry_id`。
- Session summary injection：當完整 transcript 太長時，runner 先從 SQLite 取出 session summary 或由 compaction job 產生 summary，再把 summary 注入 prompt，而不是載入整份 transcript。
- Trace-only reuse：UI、debug、audit 可以讀完整 transcript；agent 預設不能任意讀取其他 task 的完整 session，必須經 scope policy 授權。

Session reuse scope:

```text
same_task        current task root/subagent only
same_run         same workflow run
same_workflow    same workflow id and domain
same_project     same project/workspace
global           disabled by default
```

### MemoryStore

保存可重用但非權威的 context，例如使用者偏好、domain facts、成功/失敗 patterns。

Memory 寫入 SQLite `memory_items`；container 產出的 memory update 先進 `memory_deltas`，由 orchestrator/policy 審核後才合併。Memory 不作為 workflow truth，不覆蓋 manifest、artifact 或 policy。

Memory reuse modes:

- Retrieval injection：planner 或 runner 依 domain、workflow、agent role、task type、project scope、tags 與 recency 從 `memory_items` 檢索少量 relevant memory，組成 `memorySnapshot` 放入 `TaskEnvelope`。
- Planner context：Pi planner 產生 `PlanBundle` 時可讀 workflow/domain/project memory，例如偏好的軟工流程、常用 agent、常見失敗與安全限制。
- Agent context：root session 或 subagent 執行 task 時只取得 task-scoped memory snapshot，不直接取得整個 MemoryStore。
- Memory delta proposal：agent 執行完成後只能產生 `memory-delta.json` 或 structured delta，寫入 `memory_deltas`，由 policy、root session gate 或 operator approval 決定是否 merge 到 `memory_items`。
- Deprecation and conflict handling：memory item 可被 superseded、expired 或 marked invalid；新 memory 不直接覆蓋舊 memory，必須保留 provenance。

Memory item metadata:

```text
id
scope
domain
workflowId
projectRef
agentRole
taskType
tags
content
summary
provenanceSessionId
provenanceArtifactId
confidence
createdAt
updatedAt
expiresAt
supersedes
```

Memory injection rules:

- Memory snapshot 必須有 token budget。
- Secret、private key、raw credential、Vault value 不可進 memory。
- Artifact fact 優先於 memory；memory 只能提供 context。
- Cross-project memory 預設停用，除非 operator 明確授權。
- Planner 和 agent prompt 需要標示 memory 是參考，不是 execution instruction。

### ArtifactStore

保存非秘密輸出：

- artifact JSON。
- reports。
- patches。
- datasets。
- logs refs。
- screenshots refs。
- validation reports。

Artifact 寫入 SQLite `artifact_records` 與 `artifact_blobs`。JSON/text artifact 直接存入 table；binary artifact 使用 BLOB。MVP 可以設定 artifact/log size limit，超過限制時 task 失敗或要求使用外部 object store provider；但 MVP 不使用 persistent local folders 作為 artifact store。

### VaultStore

Vault 不是 FileStore。Vault 管 secrets 與 capability leases。

MVP 採：

```text
VaultStore interface + SQLite encrypted vault
```

Vault 行為：

- Secret value 不進 session。
- Secret value 不進 memory。
- Secret value 不進 artifact。
- Container 只拿 lease/ref 或短期 env/temp file。
- Container 結束後 secret material 必須消失。
- UI 只顯示 lease、scope、policy 與使用紀錄，不顯示 secret value。
- Secret value 以 encrypted blob 存入 SQLite `vault_secrets`。
- Vault lease metadata 存入 SQLite `vault_leases`。
- 解密後的 secret material 只可 materialize 到 runtime ephemeral mount。

## Container Mount Policy

Docker container 的 mount point 是 Southstar agent runtime contract 的一部分，由 `TaskEnvelope` 與 executor binding 一起產生。Tork 只接收 mount request；mount 的語意由 Southstar 定義。

Durable data 不存在 mount folder。Container 啟動前，Southstar agent runner 會從 SQLite 將 task 所需內容 materialize 到 ephemeral staging area，使用 tmpfs、Docker volume 或 OS temp directory；task 結束後，runner 將 artifact/session/memory delta/log 摘要寫回 SQLite，並刪除 staging area。

每個 task container 固定使用以下路徑：

```text
/southstar/envelope/      read-only, task envelope and resolved manifests
/southstar/workspace/     read-write or read-only, task workspace or repo worktree
/southstar/artifacts/     read-write, non-secret outputs
/southstar/sessions/      append-only by convention, root/subagent transcript spool
/southstar/memory/        read-only memory snapshot plus writable memory-delta output
/southstar/skills/        read-only resolved skills
/southstar/mcp/           read-only generated MCP config
/southstar/cache/         optional cache, policy-controlled
/run/southstar/secrets/   tmpfs or Docker secret mount, secret material only
/run/southstar/ssh/       tmpfs SSH material when an SSH lease is granted
/tmp/                     tmpfs scratch space
```

No durable host-side task layout is allowed. Runtime staging may use an ephemeral path such as:

```text
/tmp/southstar-runs/<runId>/<taskId>/
```

This path is not a store. It is created for Docker mounting only and must be deleted after task completion or cancellation.

Rules:

- `envelope`, `skills`, `mcp` are read-only inside the container.
- `artifacts` is a temporary output directory; final persistence goes through SQLite `ArtifactStore`.
- `sessions` is a temporary spool; final persistence goes through SQLite `SessionStore`.
- `memory` contains a read-only snapshot and a writable `memory-delta.json`; final persistence goes through SQLite `MemoryStore`.
- `vault` values are never bind-mounted from normal host paths.
- `/run/southstar/secrets` and `/run/southstar/ssh` must be tmpfs, Docker secrets, or equivalent ephemeral material.
- The container must not receive `~/.ssh`, user home directories, or broad host mounts.
- All durable outputs are copied or committed into SQLite after validation.
- Ephemeral staging paths must be cleaned up even when task execution fails.

## MCP Design

MCP 作為 first-class interface 納入 agent definition，但必須 scoped。

Planner 可提出 MCP grants：

```text
mcpServerId
allowedTools
agentId
taskId
vaultLeaseRefs
reason
```

Southstar validator 檢查：

- agent 是否允許使用該 MCP server。
- tool grant 是否過寬。
- 是否需要 vault lease。
- 是否符合 domain pack policy。

Container 啟動時，Southstar 產生 task-scoped MCP config：

```text
mcpServers
allowedTools
envFromVaultLease
```

Agent 不取得全域 MCP 權限，只取得 task-specific grants。

## SSH Policy

SSH 不作為 Southstar container 管理面。MVP 不在 task container 內啟動 `sshd`，也不透過 SSH 進 container 管理流程。Container lifecycle 由 Tork/Docker 管理；debug、logs、cancel、retry、restart 透過 Southstar API、Tork API 與 executor events 完成。

SSH 只作為 task capability，例如：

- clone private git repository。
- push git branch。
- access remote host when a domain workflow explicitly requires it。

這類 SSH capability 必須由 Vault 管理：

```text
Vault secret -> Vault lease -> /run/southstar/ssh/id_ed25519
Vault known_hosts -> /run/southstar/ssh/known_hosts
GIT_SSH_COMMAND -> ssh -i /run/southstar/ssh/id_ed25519 -o UserKnownHostsFile=/run/southstar/ssh/known_hosts -o IdentitiesOnly=yes
```

Rules:

- 不允許直接 mount 使用者的 `~/.ssh`。
- 不允許把 private key 寫入 session、memory、artifact 或 Tork logs。
- `known_hosts` 必須由 Vault lease 或 trusted project config 提供，不預設關閉 host key checking。
- SSH key material 只存在於 ephemeral mount。
- SSH lease 必須記錄 agent、task、allowed host、allowed operation 與 expiry。
- 若使用 local SSH agent socket，必須是顯式 `ssh-agent` lease，並限制 target host/operation；MVP 預設不啟用。
- Container debug shell 可以作為 dev-only admin action，但不是 SSH；production policy 預設關閉。

## Executor And Tork

Tork 是 MVP executor，負責 Docker management。

Tork 責任：

- Submit job。
- Run task container。
- Timeout。
- Infra retry。
- Worker queue。
- Node status。
- Container logs。
- Job/task status。
- Webhook state change。

Southstar 責任：

- Planner session。
- Manifest validation。
- Workflow semantic state。
- Agent definition。
- Task root session policy。
- Artifact schema。
- Repair loop。
- Session/memory/vault/MCP。
- Approval。
- UI read model。

Southstar 不與 Tork DB 做 DB-level merge。Southstar SQLite 是 source of truth；Tork DB/API 是 executor operational store。

Southstar SQLite 保存 executor binding 與 normalized executor events：

```text
executor
executorJobId
executorTaskId
executorAttemptId
executorStatus
containerId
exitCode
logsRef
lastExecutorEventAt
```

Runtime events：

```text
executor.job.submitted
executor.task.started
executor.task.running
executor.task.completed
executor.task.failed
executor.task.timeout
executor.task.lost
artifact.received
artifact.validated
artifact.rejected
artifact.repair_requested
artifact.repaired
```

UI 主要讀 Southstar SQLite projection。需要 task logs、nodes、queues、raw Tork status 時，Southstar API 透過 Tork adapter 查 Tork API。

## UI Architecture

Southstar 第一版只有一個 web app：`pi-web / Southstar UI`。不部署第二個 Tork Web，不用 iframe。Tork Web 只作為可抽取的參考來源；需要的功能重做或抽成 pi-web 內部 components。

主 UI：

```text
Southstar Dashboard
  Planner Chat
  Planner Drafts
  Workflow Canvas
  Agent Definitions
  Runtime Monitor
  Task Detail Drawer
  Artifact Viewer
  Sessions and Memory
  Vault and MCP Review
  Executor Ops
```

### Planner Chat

- 使用 Pi Agent LLM 產生 `PlanBundle`。
- 支援 prompt refine。
- 顯示 draft revision。
- 顯示 validation errors。
- 顯示 planner repair result。
- Approve 後才能 submit runtime。

### Workflow Canvas

顯示 Southstar semantic graph，不顯示純 Tork DAG。

Node 類型：

- stage。
- task。
- root session。
- subagent。
- artifact gate。
- manual approval。

Node 狀態：

- draft。
- approved。
- queued。
- running。
- validating。
- repairing。
- completed。
- failed。
- quarantined。

### Agent Definitions

顯示每個 task 的 agent 設定：

- agent type。
- container image。
- entrypoint。
- prompt。
- skills。
- memory refs。
- vault refs。
- MCP grants。
- artifact schema。
- timeout/retry/resource limits。

MVP read-only。後續可加入局部編輯與 prompt-to-patch。

### Runtime Monitor

讀 Southstar SQLite projection，顯示：

- workflow run status。
- task progress。
- root session status。
- subagent status。
- artifact validation result。
- repair loop count。
- executor binding。

### Task Detail Drawer

顯示單一 task：

- semantic input。
- generated task envelope。
- root session transcript link。
- subagent output。
- artifact JSON。
- validator errors。
- repair prompts。
- final validated artifact。
- executor logs。

### Executor Ops

從 Tork Web 的功能集合抽取需要的能力，直接整合到 pi-web：

- job list filtered by Southstar run。
- task status。
- container logs。
- worker nodes。
- queues。
- cancel/restart executor action。
- exit code。
- retry count。

Executor Ops 只管 Docker/Tork operational detail，不承載 workflow 語意。

### Vault And MCP Review

Vault UI：

- lease id。
- scope。
- target task。
- status。
- created/expired time。
- audit events。
- 不顯示 secret value。

MCP UI：

- mcp server。
- allowed tools。
- granted agent。
- granted task。
- policy reason。
- usage events。

## Dashboard Compatibility

原本 dashboard 的型態保留，語意替換。

保留：

- board/read-model pattern。
- detail drawer。
- wizard/action allowlist。
- SSE/runtime stream。
- operator actions。
- local API pattern。

替換：

- GitHub issue board -> workflow run/task board。
- Northstar lifecycle -> Southstar v2 run/task states。
- Issue detail -> run/task/artifact detail。
- Wizard -> planner wizard。
- v1 runtime stream -> v2 run/task/session events。

不保留：

- 舊 SQLite data。
- v1 lifecycle columns。
- hard-coded `issue_to_pr_release` interpretation。
- GitHub issue/PR/release 作為 core UI 語意。

## API Surface

Southstar UI 讀 Southstar API：

```text
GET  /api/southstar/planner/drafts
POST /api/southstar/planner/drafts
POST /api/southstar/planner/drafts/:id/refine
POST /api/southstar/planner/drafts/:id/validate
POST /api/southstar/planner/drafts/:id/approve

GET  /api/southstar/runs
GET  /api/southstar/runs/:runId
GET  /api/southstar/runs/:runId/graph
GET  /api/southstar/runs/:runId/events
GET  /api/southstar/runs/:runId/tasks

GET  /api/southstar/tasks/:taskId
GET  /api/southstar/tasks/:taskId/artifacts
GET  /api/southstar/tasks/:taskId/sessions
GET  /api/southstar/tasks/:taskId/executor
POST /api/southstar/tasks/:taskId/cancel
POST /api/southstar/tasks/:taskId/retry

GET  /api/southstar/vault/leases
GET  /api/southstar/mcp/grants

GET  /api/southstar/executor/tork/jobs/:jobId
GET  /api/southstar/executor/tork/tasks/:taskId/logs
GET  /api/southstar/executor/tork/nodes
GET  /api/southstar/executor/tork/queues
POST /api/southstar/executor/tork/actions
```

## Repository Strategy

現有 code 不做就地大改。v2 先平行新增，舊 code 當零件庫與經驗來源。

建議新增：

```text
src/v2/
  manifests/
  planner/
  executor/
  sessions/
  stores/
  vault/
  mcp/
  agent-runner/
  ui-api/
```

Pi-web 整合到單一 UI：

```text
apps/pi-web/
  southstar/
    planner-chat/
    workflow-canvas/
    runtime-monitor/
    task-detail/
    executor-ops/
    vault-mcp/
```

如果 repository 暫時不是 monorepo，MVP 可先把 `pi-web` code 移入 Southstar 或以 workspace package 方式接入，但最終使用者只啟動一個 web app。

## CubeSandbox

MVP 不支援 CubeSandbox。Tork 目前可作為 Docker/Podman/Shell executor；CubeSandbox 是否可透過 Docker-compatible API 間接使用，需要後續實測。

長期保留 abstraction：

```text
Executor: tork
RuntimeProvider: docker | podman | shell
SandboxProvider: docker | cubesandbox | remote
```

如果 CubeSandbox 不相容 Docker/OCI，後續用 `SandboxProvider` 或 Tork shell/API wrapper 接入，不讓 Tork 或 Tork manifest 承載 agent 語意。

## Security

- LLM output 永遠是 draft。
- Execution 必須經 validation 與 user approval。
- Vault secret value 不寫入 session/memory/artifact/log。
- MCP grants 預設最小權限。
- Agent container 只拿 task-scoped envelope。
- Tork secret redaction 可作為 executor 層輔助，但 Southstar Vault 才是 secret policy source。
- Executor logs 進 UI 前要做 redaction。
- Planner 不可自動擴權；新增高風險 MCP/Vault grant 必須顯示在 approval UI。

## Testing Strategy

MVP 測試分層：

- Manifest schema tests。
- PlanBundle validation tests。
- Prompt refine revision tests。
- Vault lease redaction tests。
- MCP grant policy tests。
- Tork manifest shape tests。
- Executor binding projection tests。
- TaskEnvelope load tests。
- Root session artifact validation tests。
- Repair loop tests。
- UI API read-model tests。
- Canvas state projection tests。

舊測試不作為 v2 blocking gate。保留 `test:legacy` 與新增 `test:v2`，MVP 以 `test:v2` 作為完成標準。

## Implementation Phases

Phase 1：v2 contracts

- `PlanBundle` schema。
- `SouthstarManifest` schema。
- `TorkManifest` schema。
- `TaskEnvelope` schema。
- Local v2 SQLite schema。

Phase 2：Pi planner loop

- Planner prompt context。
- Generate draft。
- Validate。
- Repair invalid output。
- Save draft revision。
- Prompt refine。

Phase 3：Tork executor integration

- Submit Tork manifest。
- Store executor binding。
- Receive webhook or poll。
- Project executor events into SQLite。
- Fetch logs/nodes/queues。

Phase 4：Agent runner

- Load envelope。
- Create root session。
- Run agent/subagent。
- Validate artifact。
- Repair loop。
- Persist sessions/artifacts/events into SQLite。
- Clean up ephemeral staging paths。

Phase 5：Single UI

- Planner Chat。
- Workflow Canvas。
- Agent Definitions。
- Runtime Monitor。
- Task Detail。
- Executor Ops。
- Vault/MCP Review。

Phase 6：Legacy retirement

- Stop expanding v1 runtime。
- Archive old dashboard semantics。
- Remove or isolate legacy tests。
- Keep reusable adapters only where they match v2 contracts.

## Acceptance Criteria

- A user can enter a software engineering prompt in pi-web and receive a valid `PlanBundle` draft.
- The draft contains both `SouthstarManifest` and `TorkManifest`.
- Invalid planner output is repaired before approval.
- The canvas renders workflow stages, tasks, root session, subagent, artifact gate and approval state.
- Agent definitions show prompt, image, skills, memory, vault, MCP and artifact contract.
- User can approve a draft and submit it to Tork.
- Tork runs Docker tasks through `southstar-agent-runner`.
- Southstar records executor binding and normalized executor events.
- Task root session produces a validated artifact.
- Invalid artifact triggers repair loop.
- Session reuse supports same-session resume, fork from checkpoint and summary injection with explicit scope.
- Memory reuse happens through scoped retrieval snapshots and memory delta approval, not full-store agent access.
- Runtime monitor updates from Southstar v2 SQLite projection.
- Task detail shows artifact, session links, validator results and executor logs.
- Task containers use the fixed Southstar mount contract.
- Session, memory, artifact, vault, MCP grants, executor bindings and runtime events persist in SQLite, not durable folders.
- Ephemeral Docker staging paths are deleted after task completion, cancellation or failure.
- Vault UI never reveals secret values.
- MCP UI shows task-scoped grants.
- SSH is not used for container management; SSH task capabilities are granted only through Vault leases and ephemeral mounts.
- No old SQLite data is required for MVP.
- There is only one web app: pi-web/Southstar UI.

## References

- Tork workflow engine and runtime model: https://github.com/runabol/tork
- Tork Web UI reference: https://github.com/runabol/tork-web
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK sessions and SessionStore: https://code.claude.com/docs/en/agent-sdk/session-storage
- Claude Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Claude Agent SDK skills: https://code.claude.com/docs/en/agent-sdk/skills
- Claude Agent SDK MCP: https://code.claude.com/docs/en/agent-sdk/mcp

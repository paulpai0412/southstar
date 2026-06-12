# Southstar Pi Planner Tork MVP 實作計劃（中文版）

> **給 agentic worker：** 實作本計劃時必須使用 `superpowers:subagent-driven-development`（建議）或 `superpowers:executing-plans`，並逐項更新 checkbox。

**Goal：** 依設計文件實作 Southstar v2。第一階段先完成 MVP：pi-web 是唯一 UI；Pi Agent LLM 產生 workflow 與 container agent definition；Southstar 保存語意 manifest、workflow revision、session、memory、vault、MCP、artifact、executor binding；Tork 負責 Docker execution；task root session 負責 artifact gate 與 repair loop；E2E 必須使用真實 Docker、真實 Tork、真實 harness、真實案例。

**Architecture：** 採單一 canonical workflow manifest。`SouthstarWorkflowManifest` 是 workflow truth，描述 task DAG、Tork execution spec、agent、harness、root session、memory、vault、MCP、evaluator、progress、steering、learning。Southstar 不 fork Tork；Tork 以 upstream execution provider 整合，從 manifest 的 `tasks[].execution` materialize job。runtime container 只接收 sealed `TaskEnvelope`，完成 task 後銷毀；durable state 全部寫入 SQLite。

**Tech Stack：** TypeScript、Node.js、SQLite、Pi Agent SDK、Tork、Docker、pi-web UI、Node test runner、Playwright、real Docker/Tork E2E runner。

---

## 1. 實作原則

- MVP 必須放在 Phase 1。
- 不遷移舊資料。
- 不保留第二個 web。
- 不 iframe Tork Web。
- Tork 只負責 Docker workflow execution，不理解 Southstar agent semantics。
- 不 fork Tork；MVP 使用 upstream Tork provider，未來如需替換 engine 走 `ExecutorProvider` 介面。
- Southstar 不把 durable session/memory/artifact/vault/executor state 存到資料夾。
- E2E 不可使用 smoke/fake/mock/stub。
- 若真實 E2E 環境缺少 Docker、Tork、SQLite DB path、real harness credential，測試必須 fail closed，不能自動 skip。

## 2. Phase 1 MVP 範圍

MVP 要完成一條可操作的 software engineering workflow：

1. pi-web Planner Chat 接收 user goal prompt。
2. Pi planner 產生 `SouthstarWorkflowManifest`。
3. `SouthstarWorkflowManifest` 同時包含 task DAG、execution spec 與 agent/runtime metadata。
4. validator 驗證 workflow schema、policy、execution projection。
5. UI 顯示 workflow canvas、agent definitions、runtime plan。
6. 使用者 approval。
7. Southstar 寫入 SQLite。
8. Southstar submit Tork job。
9. Tork 啟動 Docker task。
10. container 內執行 `southstar-agent-runner`。
11. runner 載入 `TaskEnvelope`。
12. root session 派發 subagent/harness。
13. subagent 完成真實 task。
14. root evaluator 檢查 artifact。
15. artifact 不合格時要求 repair。
16. 若 artifact gap 需要新 task，root session 只提出 structured expansion request；orchestrator 產生 `workflow_revision`，validator 通過後 append `workflow.expanded` 並新增 pending task。
17. artifact 通過後 checkpoint。
18. orchestrator 更新 run/task status。
19. UI runtime monitor 顯示真實狀態。

## 3. 檔案結構

Phase 1 建立或修改：

```text
src/v2/cli.ts
src/v2/config/env.ts
src/v2/manifests/types.ts
src/v2/manifests/validate.ts
src/v2/manifests/workflow-revision.ts
src/v2/manifests/plan-bundle.ts
src/v2/planner/types.ts
src/v2/planner/pi-planner.ts
src/v2/planner/revision-loop.ts
src/v2/stores/sqlite.ts
src/v2/stores/schema.ts
src/v2/stores/planner-store.ts
src/v2/stores/run-store.ts
src/v2/stores/resource-store.ts
src/v2/stores/session-store.ts
src/v2/stores/memory-store.ts
src/v2/stores/vault-store.ts
src/v2/stores/mcp-store.ts
src/v2/executor/tork-projection.ts
src/v2/executor/tork-client.ts
src/v2/executor/executor-bindings.ts
src/v2/agent-runner/task-envelope.ts
src/v2/agent-runner/materializer.ts
src/v2/agent-runner/root-session.ts
src/v2/harness/types.ts
src/v2/harness/registry.ts
src/v2/harness/pi-harness.ts
src/v2/harness/codex-harness.ts
src/v2/evaluators/types.ts
src/v2/evaluators/runner.ts
src/v2/signals/events.ts
src/v2/signals/progress.ts
src/v2/ui-api/read-models.ts
src/v2/ui-api/local-api.ts
src/v2/ui-api/routes.ts
src/v2/ui/components/PlannerChat.tsx
src/v2/ui/components/WorkflowCanvas.tsx
src/v2/ui/components/AgentDefinitionsPanel.tsx
src/v2/ui/components/RuntimeMonitor.tsx
src/v2/ui/components/TaskDetailDrawer.tsx
src/v2/ui/components/ArtifactViewer.tsx
src/v2/ui/components/SessionsMemoryPanel.tsx
src/v2/ui/components/VaultMcpReview.tsx
src/v2/ui/components/ExecutorOpsPanel.tsx
tests/v2/index.test.ts
tests/v2/manifests.test.ts
tests/v2/sqlite-store.test.ts
tests/v2/workflow-revision.test.ts
tests/v2/tork-projection.test.ts
tests/v2/root-session.test.ts
tests/v2/memory-reuse.test.ts
tests/e2e-real/index.test.ts
tests/e2e-real/env.ts
tests/e2e-real/scenarios/mvp-software-change.ts
tests/e2e-real/scenarios/memory-reuse.ts
tests/e2e-real/scenarios/steering-repair.ts
tests/e2e-real/scenarios/dynamic-dag-expansion.ts
tests/e2e-real/metrics.ts
docs/e2e/southstar-real-e2e.md
package.json
```

## 4. SQLite Schema

SQLite 是唯一 durable store。Phase 1 採最小 runtime schema，沿用原 Northstar `issues + issue_history` 的 snapshot/history 模型。不要為 session、memory、MCP、evaluator、progress、steering、usage、cost 各拆表。

Phase 1 必須建立以下集中 tables：

```text
workflow_runs
workflow_tasks
workflow_history
runtime_resources
artifact_blobs
secure_blobs
```

`workflow_runs` 欄位：

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

`workflow_tasks` 欄位：

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

`workflow_history` 欄位：

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

`runtime_resources` 欄位：

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

`resource_type` 先包含：

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

`artifact_blobs` 欄位：

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

`secure_blobs` 欄位：

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

Session / Memory / Learning 的儲存策略：

- session metadata、root/subagent lineage、summary、checkpoint pointer 放 `runtime_resources`。
- session transcript 仍用 `workflow_history.session_id` 查，避免完整內容雙寫。
- memory item、memory delta、workflow learning、workflow revision 放 `runtime_resources`，approval/retrieval/supersede/revision apply append 到 `workflow_history`。
- vault lease、MCP server/grant、executor binding、artifact metadata 都放 `runtime_resources`，詳細事件 append 到 `workflow_history`。
- secure value 不進 history，只能進 encrypted provider 或 `secure_blobs`。

管理欄位全部放 JSON，不新增獨立 columns：

- `workflow_history.payload_json.metrics`：subagent/harness 單次事件的 duration、tool calls、retry、tokens、cost。
- `workflow_tasks.metrics_json`：task-level aggregate cache。
- `workflow_runs.metrics_json`：workflow-level aggregate cache。
- `metrics_json` 必須可由 `workflow_history` 重建。
- cost 使用整數 `microsUsd`。

`workflow_runs` 不放 `current_task_id`。並行 task 狀態從 `workflow_tasks.status` 查詢；`snapshot_json.activeTaskIds` 只能是 cache。

Idempotency / transaction 規則：

- `workflow_history(run_id, sequence)` 必須 unique。
- external callback 必須寫入 `idempotency_key`。
- append history、更新 run/task snapshot、更新 runtime resource 必須同一 transaction。
- sequence allocation 使用 `BEGIN IMMEDIATE` 或等價 write lock。

只允許 ephemeral materialization：

```text
/tmp/southstar-runs/<runId>/<taskId>/
```

task 完成或失敗後都必須清除。

## 5. 量化指標

Phase 1 完成時必須達到：

| 指標 | 目標 | 證據 |
| --- | ---: | --- |
| planner manifest generation | `<= 120s` | `workflow_history` 的 `planner.draft_created` 到 `manifest.validated` |
| manifest validation | `<= 2s` | `npm run test:v2` |
| Tork submit latency | `<= 10s` | run 建立到 Tork job id |
| real E2E completion | `<= 15m` | `tests/e2e-real/metrics.ts` |
| workflow graph size | `>= 4` tasks | `workflow_tasks` |
| harness/subagent invocation | `>= 2` | `workflow_history` 的 `subagent.started/subagent.completed` |
| artifact evaluator coverage | `100%` required artifacts | `workflow_history` 的 `evaluator.completed` |
| repair loop | invalid artifact 在 `<= 2` attempts 內修復 | `workflow_history` 的 `repair.requested/retry.*` |
| dynamic DAG expansion | review/root request 後新增 `>= 1` task 並維持 DAG acyclic | `runtime_resources.workflow_revision`、`workflow_history.workflow.expanded`、`workflow_tasks` |
| progress commentary | first event `<= 10s`，long task 至少 `3` events | `workflow_history` 的 `progress.commentary` |
| steering | steering event 必須影響或記錄 root decision | `workflow_history` 的 `steering.received` 與 root decision event |
| SQLite durability | 所有 durable state 寫入 SQLite | `workflow_*` + `runtime_resources` + blob tables |
| no durable folders | `.southstar` 下無 session/memory/artifact/vault folders | filesystem assertion |
| memory reuse | 第二個 run 載入 approved memory | `workflow_history` 的 `memory.item_approved/session.entry` |
| management metrics | task/run/resource 匯總 token、成本、工具調用、retry | `workflow_tasks.metrics_json`、`workflow_runs.metrics_json`、`runtime_resources.metrics_json` |
| UI runtime visibility | API event 後 `<= 3s` 可見 | Playwright real UI E2E |

## 6. Goal Prompts

### MVP Software Workflow Goal Prompt

```text
在真實 fixture repo 中完成一個小型軟工任務：新增 CLI 指令 `calc sum <numbers...>`，支援多個數字輸入、錯誤訊息、測試、README 用法，並產出 implementation artifact。artifact 必須包含修改摘要、測試指令與結果、風險、以及後續建議。請把 workflow 拆成 planner、implementer、root validator、summary 四個任務，implementer 必須在 Docker/Tork task 中執行。
```

### Root Session Artifact Gate Prompt

```text
你是 task root session。你必須驗證 subagent 交回的 artifact 是否符合 schema、是否真的執行測試、是否包含 patch summary、commands run、risks。若 artifact 不合格，產生 repair instruction 並要求同一個 subagent 重新處理。只有 evaluator 通過後才能把 task 交回 orchestrator。
```

### Steering Prompt

```text
請保持最小改動，不要新增 runtime dependency。若測試失敗，優先修復現有實作與測試，不要改變 goal scope。
```

### Memory Reuse Prompt

```text
沿用上一個成功軟工 run 的偏好：最小改動、不新增 dependency、artifact 必須列出測試指令與結果。請在新 run 開始前載入可用 memory snapshot，並在結束時提出新的 memory delta。
```

### Data Analysis Phase Goal Prompt

```text
針對真實 CSV 資料集執行資料分析 workflow：profile schema、清理缺失值、產出至少三個統計洞察、一個 chart artifact、一份結論報告。所有 artifact 需經 root evaluator 驗證，並保存 session、memory delta、artifact blob 到 SQLite。
```

## 7. Phase 1 任務清單

### Task 1：加入 v2 script 與測試入口

- [ ] 修改 `package.json`：

```json
{
  "scripts": {
    "test:v2": "tsx tests/v2/index.test.ts",
    "test:e2e:real": "tsx tests/e2e-real/index.test.ts",
    "southstar:v2": "tsx src/v2/cli.ts"
  }
}
```

- [ ] 建立 `tests/v2/index.test.ts`，集中載入 workflow manifest、SQLite、Tork projection、root session、memory reuse tests。
- [ ] 建立 `src/v2/config/env.ts`，讀取 `SOUTHSTAR_DB`、`TORK_BASE_URL`、`PI_AGENT_DIR`、`CODEX_CLI_PATH`。
- [ ] 執行 `npm run test:v2`，預期初始失敗，因模組尚未實作。

### Task 2：定義 Canonical Workflow contracts

- [ ] 建立 `src/v2/manifests/types.ts`。
- [ ] 定義 `SouthstarWorkflowManifest`、`WorkflowTaskDefinition`、`TaskExecutionSpec`、`PlanBundle`。
- [ ] 定義 `HarnessDefinition`、`TaskDefinition`、`EvaluatorDefinition`、`McpServerDefinition`、`McpGrantDefinition`、`VaultLeaseDefinition`。
- [ ] 建立 `src/v2/manifests/validate.ts`。
- [ ] validator 必須檢查：
  - schema version。
  - task references。
  - task DAG acyclic。
  - harness references。
  - evaluator references。
  - execution spec 可 materialize 成 Tork job。
  - 不把 memory/vault secret/session transcript 放入 execution projection。
- [ ] 建立 `src/v2/manifests/workflow-revision.ts`，定義 `WorkflowRevisionRequest`、`WorkflowRevisionResult`、`applyWorkflowRevision(base, request)`。
- [ ] revision validator 必須檢查：
  - running / completed task 不可刪除。
  - completed task artifact 不可覆寫，只能新增 task 或 attempt。
  - dependency change 只能套用 pending task。
  - 新 task 的 execution、harness、MCP、vault、memory scope 都通過相同 validator。
  - 每次 apply 都產生新的 `manifestFingerprint`。
- [ ] 建立 `tests/v2/manifests.test.ts`。
- [ ] 建立 `tests/v2/workflow-revision.test.ts`，覆蓋新增 task、拒絕 cycle、拒絕刪除 completed task。
- [ ] 執行 `npm run test:v2`。

### Task 3：實作 SQLite schema

- [ ] 建立 `src/v2/stores/schema.ts`。
- [ ] 建立 `src/v2/stores/sqlite.ts`。
- [ ] schema 必須建立第 4 節列出的所有 tables。
- [ ] `openSouthstarDb(path)` 必須自動建立 `.southstar` 目錄並執行 schema。
- [ ] 建立 `tests/v2/sqlite-store.test.ts`，確認所有 tables 存在。
- [ ] 執行 `npm run test:v2`。

### Task 4：實作 durable stores

- [ ] 建立 run/task/history/resource/artifact/secure stores。
- [ ] 所有 store 都接受 `SouthstarDb`，不能自行開 DB。
- [ ] `history-store` 必須支援 append-only event：
  - `appendHistoryEvent`
  - `listHistoryForRun`
  - `listHistoryForTask`
  - `listHistoryForSession`
- [ ] `run-store`、`task-store`、`resource-store` 必須支援從 history aggregate 後更新 `metrics_json`。
- [ ] `resource-store` 必須支援 workflow revision：
  - `requestWorkflowRevision`
  - `validateWorkflowRevision`
  - `approveWorkflowRevision`
  - `applyWorkflowExpansion`
- [ ] `applyWorkflowExpansion` 必須在同一 transaction 內：
  - append `workflow.expanded`。
  - upsert `runtime_resources(resource_type='workflow_revision')`。
  - 更新 `workflow_runs.workflow_manifest_json`。
  - 新增或更新 `workflow_tasks`。
- [ ] memory 以 `runtime_resources` + `workflow_history` event 實作，必須支援：
  - `retrieveApprovedMemory`
  - `proposeMemoryDelta`
  - `approveMemoryDelta`
- [ ] vault lease 以 `runtime_resources` + `workflow_history` event 記錄；若 MVP 需要保存 secret value，必須使用 encrypted provider 或 `secure_blobs`，不能把 secret value 放入 history。
- [ ] vault 行為必須支援：
  - encrypted secret。
  - task-scoped lease。
  - lease TTL。
- [ ] MCP 以 `runtime_resources` + `workflow_history` event 記錄，必須支援：
  - server registration。
  - task-scoped allowed tools。
- [ ] 建立 memory reuse unit tests。
- [ ] 執行 `npm run test:v2`。

### Task 5：實作 Pi planner

- [ ] 建立 `src/v2/planner/types.ts`。
- [ ] 建立 `src/v2/planner/pi-planner.ts`。
- [ ] production path 必須呼叫真實 Pi Agent SDK 或正式 client，不可 hard-code manifest template。
- [ ] planner prompt 必須要求只輸出一個 JSON object。
- [ ] JSON object 必須符合 `PlanBundle`。
- [ ] 建立 `src/v2/planner/revision-loop.ts`。
- [ ] revision loop 需將 validation issues 傳回 Pi planner 修正。
- [ ] unit test 可使用 deterministic fixture client；real Pi planner 在 E2E 驗證。
- [ ] 執行 `npm run test:v2`。

### Task 6：實作 Tork execution projection 與 client

- [ ] 建立 `src/v2/executor/tork-projection.ts`。
- [ ] `buildTorkJobProjection(workflow)` 從 `SouthstarWorkflowManifest.tasks[].execution` 產生 Docker execution job。
- [ ] Tork projection 只能包含 image、command、env、mount、timeout、resources、retry/webhook。
- [ ] 建立 `src/v2/executor/tork-client.ts`。
- [ ] `TorkClient.submit()` 必須呼叫真實 Tork HTTP API。
- [ ] 建立 `tests/v2/tork-projection.test.ts`。
- [ ] E2E 驗證真實 Tork endpoint。
- [ ] 執行 `npm run test:v2`。

### Task 7：實作 TaskEnvelope 與 ephemeral materializer

- [ ] 建立 `src/v2/agent-runner/task-envelope.ts`。
- [ ] `TaskEnvelope` 必須包含：
  - runId。
  - taskId。
  - rootSessionId。
  - goalPrompt。
  - taskPrompt。
  - subagents。
  - memorySnapshot。
  - vaultLeases。
  - mcpGrants。
  - evaluator。
  - steering。
- [ ] 建立 `src/v2/agent-runner/materializer.ts`。
- [ ] materializer 只可寫入 `/tmp/southstar-runs/<runId>/<taskId>/`。
- [ ] 成功與失敗都要 cleanup。
- [ ] E2E 檢查 `.southstar` 下沒有 durable folders。

### Task 8：實作 harness registry 與 root session

- [ ] 建立 `src/v2/harness/types.ts`。
- [ ] 建立 `src/v2/harness/registry.ts`。
- [ ] 建立 `src/v2/harness/pi-harness.ts`。
- [ ] 建立 `src/v2/harness/codex-harness.ts`。
- [ ] production harness 不可回傳固定 artifact。
- [ ] 建立 `src/v2/agent-runner/root-session.ts`。
- [ ] root session control loop：
  1. 載入 `TaskEnvelope`。
  2. 建立 session record。
  3. 執行 subagent harness。
  4. 保存 progress events。
  5. 保存 artifact。
  6. evaluator 檢查 required artifacts。
  7. 失敗時產生 repair instruction。
  8. retry 至通過或超過上限。
  9. 建立 checkpoint。
  10. 回報 orchestrator。
- [ ] 建立 `tests/v2/root-session.test.ts`，證明 fail-then-repair 行為。
- [ ] 執行 `npm run test:v2`。

### Task 9：實作 evaluator、progress、steering、signals

- [ ] 建立 `src/v2/evaluators/types.ts`。
- [ ] 建立 `src/v2/evaluators/runner.ts`。
- [ ] evaluator 必須檢查 artifact required fields。
- [ ] 建立 `src/v2/signals/events.ts`。
- [ ] 建立 `src/v2/signals/progress.ts`。
- [ ] runtime event types 至少包含：
  - `run.created`
  - `task.started`
  - `progress.commentary`
  - `steering.received`
  - `artifact.created`
  - `evaluator.completed`
  - `checkpoint.created`
  - `run.completed`
- [ ] 所有 event 都要寫入 `workflow_history`。`workflow_runs.metrics_json` 與 `workflow_tasks.metrics_json` 只作為可重建的 aggregate cache。
- [ ] 執行 `npm run test:v2`。

### Task 10：實作 UI API read models

- [ ] 建立 `src/v2/ui-api/read-models.ts`。
- [ ] 建立 `src/v2/ui-api/local-api.ts`。
- [ ] 建立 `src/v2/ui-api/routes.ts`。
- [ ] API 必須支援：

```text
POST /api/v2/planner/drafts
POST /api/v2/planner/drafts/:id/revise
POST /api/v2/runs
GET  /api/v2/runs/:runId/canvas
GET  /api/v2/runs/:runId/runtime
GET  /api/v2/runs/:runId/tasks/:taskId
POST /api/v2/runs/:runId/steer
GET  /api/v2/runs/:runId/sessions-memory
GET  /api/v2/runs/:runId/vault-mcp
GET  /api/v2/executor/tork/:jobId
```

- [ ] React components 不可直接讀 Tork；只能透過 Southstar API。
- [ ] 用真實 SQLite 資料測試 read model。

### Task 11：整合 pi-web 單一 UI

- [ ] 從 pi-web 抽取需要的 board/runtime UI patterns。
- [ ] 不保留第二個 web。
- [ ] 不 iframe Tork Web。
- [ ] 第一屏是 operations dashboard，不是 landing page。
- [ ] UI 必須包含：
  - Planner Chat。
  - Workflow Canvas。
  - Runtime Monitor。
  - Task Detail Drawer。
  - Agent Definitions。
  - Sessions/Memory。
  - Vault/MCP Review。
  - Executor Ops。
- [ ] Runtime Monitor 必須顯示：
  - run status。
  - task status。
  - Tork job id。
  - progress commentary。
  - evaluator result。
  - repair attempt count。
  - latest workflow revision / expansion event。
  - latest steering event。
- [ ] Playwright UI E2E 必須使用 real run + real SQLite，不可使用 static snapshot。

### Task 12：建立 real E2E harness

- [ ] 建立 `tests/e2e-real/env.ts`。
- [ ] 必須檢查：
  - `TORK_BASE_URL`。
  - `SOUTHSTAR_DB`。
  - `docker version`。
  - Tork health endpoint。
  - real harness credential/config。
- [ ] 缺少任何必要條件時 throw error 並 exit non-zero。
- [ ] 建立 `tests/e2e-real/metrics.ts`。
- [ ] 建立 `tests/e2e-real/index.test.ts`。
- [ ] `index.test.ts` 必須依序執行 MVP software-change、steering repair、dynamic DAG expansion、memory reuse scenarios，最後才 assert metrics 與 durable folder 檢查。
- [ ] 建立 `docs/e2e/southstar-real-e2e.md`，列出真實環境啟動方式。

執行指令：

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

### Task 13：建立 real software fixture 與 MVP scenario

- [ ] 建立 `tests/e2e-real/fixtures/software-change/`。
- [ ] fixture repo 初始功能只支援 `calc add <a> <b>`。
- [ ] E2E goal 要讓 agent 新增 `calc sum <numbers...>`。
- [ ] scenario 必須：
  1. 複製 fixture 到 temp real git repo。
  2. 執行 `git init`。
  3. 建立 initial commit。
  4. 送出 MVP goal prompt 到 real Pi planner。
  5. 驗證 generated `PlanBundle`。
  6. 寫入 SQLite。
  7. submit real Tork job。
  8. 等待 Docker task 完成。
  9. 驗證 `calc sum 1 2 3` 輸出 `6`。
  10. 執行真實 fixture tests。
  11. 驗證 artifact/evaluator/session/memory/executor tables。

### Task 14：建立 steering repair、memory reuse 與 dynamic DAG expansion E2E

- [ ] `steering-repair.ts`：
  - running 中插入 steering prompt。
  - evaluator 自然拒絕 invalid artifact。
  - root session 產生 repair instruction。
  - repaired artifact 通過。
- [ ] `dynamic-dag-expansion.ts`：
  - 使用真實 MVP run，不可用 fixture manifest 取代 planner output。
  - 在 review/root gate 階段要求新增一個 follow-up verification task。
  - 驗證 `runtime_resources` 有 `resource_type='workflow_revision'` 且 `status='applied'`。
  - 驗證 `workflow_history` 有 `workflow.revision_requested`、`workflow.revision_validated`、`workflow.expanded`、`task.created`。
  - 驗證新增後的 `workflow_tasks` 至少多 `1` 筆，且 DAG validator 回傳 acyclic。
  - 驗證新增 task 被 materialize 成真實 Tork task/attempt，而不是只存在 SQLite。
- [ ] `memory-reuse.ts`：
  - approve 第一個成功 run 的 memory delta。
  - 第二個 run 載入 approved memory snapshot。
  - artifact 明確反映 memory preference。

### Task 15：建立 orchestrator CLI

- [ ] `southstar:v2 plan --goal "<goal prompt>"`。
- [ ] `southstar:v2 revise --draft-id <id> --prompt "<revision prompt>"`。
- [ ] `southstar:v2 run --draft-id <id>`。
- [ ] `southstar:v2 status --run-id <id>`。
- [ ] `southstar:v2 steer --run-id <id> --message "<steering prompt>"`。
- [ ] `southstar:v2 task-envelope --run-id <id> --task-id <id>`。
- [ ] CLI 必須呼叫與 UI 相同的 planner/executor/store modules。

## 8. Phase 1 驗收

執行：

```bash
npm run test:v2
```

預期：

```text
zero failed assertions
```

執行 real E2E：

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

預期：

```text
MVP software-change scenario passed
memory reuse scenario passed
steering repair scenario passed
dynamic DAG expansion scenario passed
all quantitative gates passed
```

SQLite evidence：

```bash
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 ".tables"
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "select status, count(*) from workflow_runs group by status;"
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "select event_type, count(*) from workflow_history group by event_type;"
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "select json_extract(metrics_json,'$.tokens.total') as tokens, json_extract(metrics_json,'$.cost.microsUsd') as cost_micros_usd from workflow_runs;"
```

預期：

```text
workflow_runs contains passed runs
workflow_history contains evaluator.completed, repair.requested, workflow.expanded, task.created, memory.item_approved, session.entry, subagent.completed events
runtime_resources contains applied workflow_revision resources
workflow_runs.metrics_json contains aggregate tokens and cost
```

檔案系統檢查：

```bash
find .southstar -mindepth 1 -maxdepth 2 -type d -print
```

預期：

```text
沒有 session、memory、artifact、vault、executor durable folders
```

## 9. 後續 Phase

### Phase 2：Data Analysis Domain

- [ ] 加入 data-analysis domain pack。
- [ ] 建立真實 CSV fixture。
- [ ] 建立 data-analysis harness。
- [ ] 產出 schema profile、cleaning report、insight report、chart artifact、final report。
- [ ] real E2E 處理至少 `1,000` rows。
- [ ] data-analysis run time `<= 20m`。

### Phase 3：Mobile / Voice / Fragmented-Time Workflow

- [ ] `GET /api/v2/runs/:runId/mobile-summary`。
- [ ] `POST /api/v2/runs/:runId/voice-command`。
- [ ] voice command 轉成 `workflow_history` 的 `steering.received` event。
- [ ] mobile summary API `<= 1s`。
- [ ] mobile viewport `<= 3s` 顯示 compressed state。

### Phase 4：Executor Provider / CubeSandbox

- [ ] 保留 Tork 為 production executor。
- [ ] 增加 `ExecutorProvider` interface。
- [ ] CubeSandbox 只能在真實 compatibility test 通過後開放。
- [ ] provider switch 不可改變 `SouthstarWorkflowManifest` semantics。

### Phase 5：Learning Loop

- [ ] successful run 後產生 workflow learning。
- [ ] approved workflow learning 進入 planner bounded memory snapshot。
- [ ] UI 提供 memory delta / workflow learning review queue。
- [ ] 第二次 run 證明使用 approved learning，但不暴露完整 transcript。

### Phase 6：Production Hardening

- [ ] vault secret encryption；secret value 不進 `workflow_history`，只記 lease/ref event。
- [ ] retention policy。
- [ ] DB backup/export/restore。
- [ ] run cancellation。
- [ ] Tork job cancellation。
- [ ] executor reconciliation。
- [ ] stuck executor detection。
- [ ] expired vault lease enforcement。

## 10. MVP 完成定義

Phase 1 只有在以下條件全部滿足才算完成：

- `npm run test:v2` 通過。
- `npm run test:e2e:real` 在真實 Docker/Tork 環境通過。
- MVP goal prompt 產生真實 workflow 與真實 Docker task。
- root session 至少拒絕一次 invalid artifact 並接受 repaired artifact。
- SQLite 保存 session、memory、artifact、evaluator result、vault lease、MCP grant、executor binding、progress、steering、signal、runtime events。
- UI 顯示 real run 的 workflow canvas、agent definition、runtime monitor、task detail、artifact viewer、sessions/memory、vault/MCP、executor ops。
- `.southstar` 不含 durable session/memory/artifact/vault/executor folders。
- 文件記錄 Tork API version、Docker image assumptions、real E2E prerequisites。

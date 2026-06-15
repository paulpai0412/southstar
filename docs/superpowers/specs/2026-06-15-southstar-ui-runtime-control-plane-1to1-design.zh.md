# Southstar UI Runtime Control Plane 1:1 設計文件

日期：2026-06-15

## 1. 目標

本設計把 `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime` 內的 UI 範本，逐頁 1:1 實作成 Southstar 真實操作台。完成後，使用者可從 UI 下 prompt，經由 Southstar runtime 建立 dynamic workflow、執行 Tork/Docker task、監控 session/memory/worktree/executor/evaluator/approval 狀態，最後只在 stop condition 通過後完成 run。

本設計採完整範圍：

- 範本中可見的資料欄位必須來自 Southstar API/read model。
- 範本中可見的操作按鈕必須呼叫真 command API。
- 缺少的 API、store、event、read model 與 runtime command 必須補齊。
- 不使用 fake、smoke、mock、硬編 demo rows 或 screenshot 當 UI。
- Tork 只當 executor；workflow truth 仍由 Southstar DB、workflow snapshot、session graph 與 evaluator/stop condition 決定。

## 2. 非目標

- 不把 Tork Web iframe 到 Southstar UI。
- 不用靜態 PNG 當產品 UI。
- 不把 Tork、Git、MCP、Vault 或 UI 本身變成 workflow canonical truth。
- 不以 agent 自述完成當 run 完成依據。
- 不在沒有真 runtime effect 的情況下標示操作已完成。

## 3. 實作策略

採 **Vertical Slice Page-by-Page**。每一張範本頁都是一個可驗收 vertical slice，必須同時完成：

- code-native UI 1:1 重現範本 layout、密度、狀態與控制元件。
- Southstar runtime API endpoint。
- SQLite/read model/store/event 對應。
- UI action 真正呼叫 API。
- E2E 驗收，從 UI 操作到 runtime state 變化。
- 對 executor/worktree/session/memory 的操作，都有可追蹤 audit/event/resource record。

交付順序：

1. `01 Planner Chat / Run Launcher`
2. `02 Workflow Canvas`
3. `03 Runtime Monitor`
4. `09 Task Detail`
5. `04 Sessions / Memory`
6. `05 Worktree Console`
7. `06 Executor Ops`
8. `07 Domain Packs / Agent Studio`
9. `08 Vault / MCP / Approval Policy`

## 4. 整體架構

```text
Next UI
  -> lib/southstar/api-client.ts
  -> Southstar Runtime Server
      -> UI Command API
      -> Page Read Models
      -> Runtime Store / Resource Store / History Store
      -> Domain Pack / Planner / Context Builder / Session Graph
      -> Worktree / Executor / Evaluator / Approval
```

Canonical truth：

- Workflow truth：Southstar DB + workflow snapshot + session graph。
- Task execution truth：Southstar task/event/resource records。
- Executor truth：Tork job/container status，僅作 execution projection。
- Workspace truth：Git/worktree snapshots。
- Completion truth：Evaluator result + stop condition result。

## 5. API 分層

### 5.1 Page Read Models

UI 主要讀 page-level 聚合 endpoint，不直接在前端拼湊多個低階 endpoint。

```text
GET /api/v2/ui/planner
GET /api/v2/ui/workflow-canvas?runId=...
GET /api/v2/ui/runtime-monitor?runId=...
GET /api/v2/ui/task-detail?runId=...&taskId=...
GET /api/v2/ui/sessions-memory?runId=...
GET /api/v2/ui/worktree?runId=...
GET /api/v2/ui/executor
GET /api/v2/ui/domain-packs
GET /api/v2/ui/governance
```

### 5.2 Command APIs

所有 UI 操作按鈕都對應 command endpoint。每個 command 都要：

1. 改變 durable state。
2. 追加 runtime event / audit event。
3. 讓對應 page read model 立即反映新狀態。

通用 request：

```ts
{
  commandId: string;
  actor: { type: "user" | "system" | "root-session"; id?: string };
  reason?: string;
  dryRun?: boolean;
  payload: object;
}
```

通用 response：

```ts
{
  commandId: string;
  accepted: boolean;
  status: "applied" | "queued" | "rejected";
  affectedRunId?: string;
  affectedTaskId?: string;
  resourceRefs: string[];
  eventRefs: string[];
  nextSuggestedActions: string[];
}
```

### 5.3 Evidence APIs

```text
GET /api/v2/runs/:runId/events
GET /api/v2/runs/:runId/evaluator-results
GET /api/v2/runs/:runId/stop-condition
GET /api/v2/runs/:runId/context-packets
GET /api/v2/audit-log
```

## 6. API 與 Runtime 缺口盤點

| 頁面 | 目前已有 | 必補 API / Runtime 能力 |
|---|---|---|
| Planner Chat / Run Launcher | `POST /planner/drafts`、`POST /runs`、`POST /run-goal`、draft/run 基本狀態 | draft list/history、draft detail/readiness、domain/intent confidence、task assignment preview、context budget preview、artifact contract preview、stop condition preview、policy controls 更新 |
| Workflow Canvas | `GET /runs/:id`、`GET /tasks`、`GET /task/envelope`、events | graph read model、edge types、repair/revision edges、root session decision timeline、node actions：retry/fork/rollback/request revision、ContextPacket trace overlay |
| Runtime Monitor | run status、events、logs、artifacts、approvals | run list、pause/resume/cancel、executor job list、artifact progress、evaluator result summary、stop gate result、integration health、export logs |
| Task Detail | task detail、TaskEnvelopeV2 | task logs、task artifacts、task evaluator pipeline result、task retry、fork session、rollback workspace、request workflow revision、approval action surface |
| Sessions / Memory | sessions read model、memory resources | session fork/reset/rollback APIs、memory approval/reject、pin to domain pack、convert to skill note、do-not-inject rule、memory search/filter、token efficiency metrics |
| Worktree Console | git snapshot provider exists in runtime path | worktree timeline read model、create snapshot、fork worktree、rollback preview、rollback execute、diff preview、open/download patch、safety checks |
| Executor Ops | Tork submit/callback binding | executor health、job queue、job detail/logs/callback/env、retry job、cancel job、reconcile job、retry failed jobs、worker pool status |
| Domain Packs / Agent Studio | software domain pack exists in code | domain pack list/detail、DSL read model、validation diagnostics、workflow preview、agent profile detail、skills/MCP/tool policy read models |
| Vault / MCP / Approval Policy | approval list + decision endpoint、voice risk policy | MCP list/add/health、tool grant matrix、vault secret groups、approval queue、audit log、policy simulator、policy version history |

## 7. Command Model

### 7.1 Run lifecycle

```text
POST /api/v2/runs/:runId/pause
POST /api/v2/runs/:runId/resume
POST /api/v2/runs/:runId/cancel
```

- `pause`：run status -> `paused`，future executor submissions blocked。已跑 job 不強殺，除非 payload 帶 `cancelActiveJobs=true`。
- `resume`：run status -> `running`，重新評估 runnable tasks。
- `cancel`：run status -> `cancelled`，通知 executor cancel active jobs，寫入 stop condition cancelled result。

### 7.2 Task repair

```text
POST /api/v2/runs/:runId/tasks/:taskId/retry
POST /api/v2/runs/:runId/tasks/:taskId/fork-session
POST /api/v2/runs/:runId/tasks/:taskId/rollback-workspace
POST /api/v2/runs/:runId/tasks/:taskId/request-revision
```

- `retry`：新增 task attempt，重建 ContextPacket，重新 submit executor。
- `fork-session`：從 task root session checkpoint 建 branch session，保留 lineage。
- `rollback-workspace`：必須先有 rollback preview；執行後建立 worktree rollback record。
- `request-revision`：建立 workflow revision request，Planner/DomainPack generator 產生修正版 DAG，revision edge 顯示於 canvas。

### 7.3 Session / Memory

```text
POST /api/v2/sessions/:sessionId/fork
POST /api/v2/sessions/:sessionId/reset
POST /api/v2/sessions/:sessionId/rollback

POST /api/v2/memory/:memoryId/approve
POST /api/v2/memory/:memoryId/reject
POST /api/v2/memory/:memoryId/pin-to-domain-pack
POST /api/v2/memory/:memoryId/convert-to-skill-note
POST /api/v2/memory/:memoryId/do-not-inject
```

- session graph 是 lineage truth。
- memory approval 只影響未來 injection，不改過去 ContextPacket。
- `do-not-inject` 建立 exclusion rule，ContextBuilder 後續必須遵守。
- `convert-to-skill-note` 產生 skill note resource，不直接修改 domain pack DSL；修改 domain pack 必須走 edit/publish 流程。

### 7.4 Worktree

```text
POST /api/v2/runs/:runId/worktree/snapshots
POST /api/v2/runs/:runId/worktree/fork
POST /api/v2/runs/:runId/worktree/rollback-preview
POST /api/v2/runs/:runId/worktree/rollback
```

- Git/worktree 管理 software workspace snapshot/rollback。
- rollback 是 destructive，需要 approval policy gate。
- rollback preview 必須保存 diff、untracked file list、risk checks。
- rollback execute 只能對 preview id 執行，避免 UI 直接傳任意 ref。

### 7.5 Executor

```text
POST /api/v2/executor/jobs/:jobId/retry
POST /api/v2/executor/jobs/:jobId/cancel
POST /api/v2/executor/jobs/:jobId/reconcile
POST /api/v2/executor/retry-failed
```

- executor job state 不是 workflow truth。
- reconcile 比對 Tork job/callback 與 Southstar DB。
- retry job 最終建立 Southstar task attempt，不直接在 Tork 裡偷偷重跑。

### 7.6 Approval / MCP / Vault

```text
POST /api/v2/approvals/:approvalId/decision
POST /api/v2/approval-policy/simulate
POST /api/v2/mcp
POST /api/v2/vault/secret-groups
```

- secrets/MCP/tool grants 只以 scoped grants 出現在 TaskEnvelopeV2。
- approval policy simulator 只回 simulated decision，不改 state。
- actual approval decision 必須寫 audit log。

## 8. Store / Resource / Event 設計

保留現有 SQLite store，新增或標準化這些 resource/event 類型：

```text
planner_draft
workflow_generation_plan
orchestration_snapshot
executor_binding
artifact
evaluator_result
stop_condition_result
context_packet
memory_item
memory_delta
memory_decision
session_checkpoint
session_fork
session_rollback
session_reset
worktree_snapshot
worktree_diff
worktree_rollback_preview
worktree_rollback
executor_job
executor_worker
executor_log
domain_pack_snapshot
domain_pack_validation
mcp_connection
mcp_grant
vault_secret_group
approval
approval_policy_version
audit_log
```

每個 command 至少寫入一個 `workflow_history` event 或 `audit_log` resource。read model 不可依賴 transient in-memory state。

## 9. UI 架構

現有 `SouthstarOperationsApp` 會拆成 Shell + Pages + Page Read Models + Command Hooks。

### 9.1 Routes

```text
app/
  page.tsx              -> redirect /planner
  planner/page.tsx      -> 01 Planner Chat / Run Launcher
  workflow/page.tsx     -> 02 Workflow Canvas
  runtime/page.tsx      -> 03 Runtime Monitor
  task/page.tsx         -> 09 Task Detail
  sessions/page.tsx     -> 04 Sessions / Memory
  worktree/page.tsx     -> 05 Worktree Console
  executor/page.tsx     -> 06 Executor Ops
  domain-packs/page.tsx -> 07 Domain Packs / Agent Studio
  governance/page.tsx   -> 08 Vault / MCP / Approval Policy
```

真 route 比單頁內部 state 更適合此專案，因為每頁 read model 大、需要 deep link、refresh 與獨立 E2E。

### 9.2 Shell

```text
components/southstar/shell/
  SouthstarShell.tsx
  SideRail.tsx
  TopRunBar.tsx
  StatusFooter.tsx
  RunSelector.tsx
```

Shell 負責左側 rail、active page、run selector、environment/health/user block 與 route navigation，不直接持有頁面業務邏輯。

### 9.3 Pages

```text
components/southstar/pages/
  PlannerPage.tsx
  WorkflowCanvasPage.tsx
  RuntimeMonitorPage.tsx
  TaskDetailPage.tsx
  SessionsMemoryPage.tsx
  WorktreeConsolePage.tsx
  ExecutorOpsPage.tsx
  DomainPacksAgentStudioPage.tsx
  GovernancePage.tsx
```

每頁只吃自己的 read model，不在 component 內 hard-code sample rows。

### 9.4 Hooks

```text
components/southstar/hooks/
  useSouthstarPageModel.ts
  useSouthstarCommand.ts
  useRunPolling.ts
  useRunEvents.ts
  useSelectedRun.ts
```

hook 負責呼叫 API、pending/error、refresh page read model 與使用者回饋。hook 不可自行製造假成功狀態。

### 9.5 Shared UI

```text
components/southstar/ui/
  Button.tsx
  Panel.tsx
  StatusBadge.tsx
  DataTable.tsx
  MetricCard.tsx
  Timeline.tsx
  SplitPane.tsx
  CodeBlock.tsx
  GraphCanvas.tsx
```

設計系統延續範本：深色 rail、白色 panel、細 border、8px radius、密集但可讀的 operations typography。所有重要文字與控制元件必須 code-native。

## 10. Page 行為

### 10.1 Planner Chat / Run Launcher

- prompt tabs：Goal Prompt、Steering、Voice Transcript。
- prompt history 來自 draft/run records。
- workflow draft canvas 顯示 domain/intent、DAG preview、task assignment。
- readiness 顯示 domain/intent confidence、workflow draft、assignments、MCP grants、memory policy、artifact contract。
- context budget 顯示 prompt/system、memory、skills/MCP schemas、workspace snapshot。
- policy controls 可更新 repair attempts、fork on failure、rollback strategy、workspace isolation、human approval。
- `Run Now` 建立真 run 並導向 runtime monitor。

### 10.2 Workflow Canvas

- DAG node count = workflow task count。
- edge types 包含 dependency、context packet trace、repair/revision、evaluator gate。
- selected node 顯示 TaskEnvelopeV2 summary、artifact contract、evaluator influence、actions、ContextPacket trace、memory injection、events。
- 底部顯示 workflow revision timeline 與 root session decisions。

### 10.3 Runtime Monitor

- KPI row 來自 run/task/artifact/evaluator/executor metrics。
- event stream 使用 SSE + polling fallback。
- executor jobs、artifact progress、integration health、stop gate、evaluator pipeline、run decision、alerts 都從 read model 取得。
- `Pause`、`Cancel Run`、`Export Logs` 都是真 command。

### 10.4 Task Detail

- 展示 TaskEnvelopeV2、ContextPacket、memory injection trace、logs、artifacts、evaluator result、repair actions。
- task retry 建立新 attempt。
- fork/rollback/revision 操作必須改 session/worktree/workflow resources。

### 10.5 Sessions / Memory

- session lineage graph、checkpoint table、memory console、memory detail/actions、token efficiency、provider binding。
- memory approval/reject/do-not-inject 影響未來 injection，不改歷史 ContextPacket。
- token efficiency 由 ContextPacket/memory trace 聚合。

### 10.6 Worktree Console

- snapshot timeline、worktree tree、diff preview、operations panel、safety checks、executor mount status。
- rollback 必須先 preview，再 execute。
- diff/download patch 來自 git/worktree state。

### 10.7 Executor Ops

- health cards、jobs queue、selected job detail/logs/callback/env/reconcile、worker pool、policy/integration health。
- retry/cancel/reconcile 走 Southstar command，不能只打 Tork。

### 10.8 Domain Packs / Agent Studio

- domain pack list/detail 來自 registry/read model。
- DSL viewer/editor state、agent profiles、artifact contracts、evaluator pipeline、workflow preview、validation diagnostics。
- edit/publish 走 versioned domain pack resource，不直接修改 code constant。

### 10.9 Vault / MCP / Approval Policy

- MCP connections、tool grant matrix、secret vault、approval queue、audit log、risk policy、simulator、policy history。
- approval decision 寫 audit log。
- policy simulator 不改 state。
- MCP/vault grants 以 scoped grant 進 TaskEnvelopeV2。

## 11. E2E 驗收

### 11.1 主 E2E：UI Prompt-to-Artifact Loop

Goal prompt：

```text
在真實 fixture repo 中完成一個可驗收的軟體 feature：
新增 CLI 指令 calc sum <numbers...>。
需求：
- 支援多個數字參數。
- 輸出數字總和。
- 保留既有 CLI 行為。
- 新增單元測試與 README 使用說明。
- 最後產出 code patch、test evidence、README evidence、evaluator report。
Fixture repo: <real temp git repo path>
```

流程：

1. 開 `/planner`。
2. 輸入 goal prompt。
3. 按 `Send to Planner`。
4. UI 顯示 domain/intent、dynamic workflow draft、task assignments、context budget、artifact contract、stop condition。
5. 按 `Run Now`。
6. 轉到 `/runtime`。
7. event stream 出現 planner/context/memory/executor/docker/agent/artifact/evaluator/stop condition events。
8. `/workflow` 可看到 DAG、ContextPacket trace、evaluator gate。
9. `/task` 可看到 TaskEnvelopeV2、ContextPacket、memory injection trace、artifact/evaluator result。
10. 若 evaluator failure 被刻意觸發，UI 可執行 retry/fork/rollback/revision 其中至少一條真 recovery path。
11. 最後只有 stop condition 通過，run 狀態才可完成。

### 11.2 量化 Gate

- `workflow_runs.status = completed`。
- 至少 1 個 artifact resource，且包含 code patch/test evidence/README evidence/evaluator report。
- 至少 1 個 `evaluator_result` 且 `ok=true`。
- 至少 1 個 `stop_condition_result` 且 `status=passed`。
- 每個 executed task 都有 `TaskEnvelopeV2`。
- 每個 executed task 都有 `ContextPacket`。
- 每個 ContextPacket 都有 memory selected/excluded trace，即使 selected 為 0 也要有 reason。
- Tork executor binding 存在，並有 callback evidence。
- UI read model 不得包含 hard-coded fixture rows。
- E2E 透過 browser 操作，不直接呼叫 private functions 製造狀態。

### 11.3 每頁 E2E

- Planner：draft/run/revise/readiness/task assignment/context budget/artifact contract/stop condition 都來自 API。
- Workflow Canvas：DAG、selected node、ContextPacket trace、root decision timeline 與至少一個 recovery command 真執行。
- Runtime Monitor：SSE/polling、pause/resume/cancel、executor jobs、artifact progress、evaluator/stop gate 真更新。
- Task Detail：TaskEnvelopeV2、ContextPacket、artifact、evaluator、retry attempt 真更新。
- Sessions / Memory：fork/reset/rollback 建立 lineage resource；memory approval/exclusion 改變 future injection。
- Worktree：snapshot、rollback preview、rollback execute 真改 worktree state。
- Executor Ops：job list/detail/logs/retry/cancel/reconcile 真走 runtime command。
- Domain Packs：list/detail/validate/preview/publish/edit 真走 domain pack resource。
- Governance：approval decision、policy simulation、audit log、MCP/vault grants 真更新。

### 11.4 測試命令

既有驗證：

```bash
npm run test:v2
node_modules/.bin/tsc --noEmit
SOUTHSTAR_DB=/tmp/southstar-ui-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real
```

新增 UI E2E：

```bash
npm run test:e2e:ui
```

`test:e2e:ui` 必須啟動真 Southstar runtime server、真 Next UI、真 Tork/Docker executor，透過 Playwright 操作 UI。

## 12. Completion Rule

此 UI rewrite 不以「看起來像範本」作為完成。完成必須同時滿足：

- 視覺接近範本。
- 所有範本可見資料接真 API。
- 所有範本可見操作接真 command API。
- 主 E2E 從 UI prompt 到 artifact pass。
- 每頁至少一條代表性真互動 E2E pass。
- 無 fake/mock/smoke path 被用作完成證據。

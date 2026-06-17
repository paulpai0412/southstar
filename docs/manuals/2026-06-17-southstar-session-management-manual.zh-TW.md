# Southstar v2 Session Management 與 Recovery Action 手冊（草案）

> 日期：2026-06-17  
> 範圍：`src/v2/*`（Southstar v2 runtime / UI API / read models）

## 1. 目的

本文整理 Southstar v2 目前的：

- session management 怎麼做
- 資料流怎麼跑
- 何時 checkpoint
- `fork / reset / rollback` 的實際語義（記錄意圖 vs 真正執行）
- operator 常用 action 與 API 路徑

---

## 2. 一張圖看懂（Session + Recovery）

```mermaid
flowchart TD
  %% ========== 主執行流 ==========
  subgraph AUTO["自動執行主流程（runtime）"]
    A[POST /api/v2/run-goal] --> B[建立 workflow_runs / workflow_tasks]
    B --> C[createSession<br/>session_node + session]
    C --> D[Checkpoint #1<br/>task-start]
    D --> E[Materialize TaskEnvelope + Submit Tork]
    E --> F[Agent Runner Heartbeat]
    E --> G[/api/v2/tork/callback]
    G --> H[Idempotency 檢查]
    H --> I[Artifact Acceptance + Evaluator]
    I -->|accepted| J[Checkpoint #2<br/>artifact-accepted]
    I -->|needs_repair/rejected| K[task failed / repair]
    J --> L[更新 task/run 狀態 + metrics]
  end

  %% ========== Operator / UI Action ==========
  subgraph OP["Operator / UI 指令路徑"]
    N[UI Commands]
    N -.-> O[task retry / fork-session / rollback-workspace<br/>/ request-revision<br/>→ recovery_decision / workflow_revision_request + history]
    N -.-> P[session fork / reset / rollback<br/>→ session_fork/reset/rollback + history]
    N --> Q[worktree snapshot]
    Q --> R[rollback-preview]
    R --> S[rollback-workspace（有實際 git 動作）]
    S --> T[worktree_rollback + history]
  end

  %% ========== Session Graph API ==========
  subgraph SG["SessionGraph Provider（內部 API）"]
    U[fork/reset/rollback]
    U --> V[session_node + recovery_decision + history]
  end

  %% ========== Read Model ==========
  subgraph RM["Read Models / UI"]
    M[sessions-memory / workflow-canvas / runtime-monitor]
  end

  L --> M
  K --> M
  O --> M
  P --> M
  T --> M
  V --> M

  %% policy 宣告但尚未完整自動接線
  W[[before-recovery checkpoint<br/>(policy 已宣告，接線待補)]]
  O -. planned .-> W
```

---

## 3. 核心資料模型

### 3.1 關鍵表

- `workflow_runs`
- `workflow_tasks`（含 `root_session_id`）
- `workflow_history`（事件序列）
- `runtime_resources`（session / checkpoint / recovery 等資源）

參考：`src/v2/stores/schema.ts`

### 3.2 Session 相關 resource type

- `session`
- `session_node`
- `session_checkpoint`
- `recovery_decision`
- `session_fork` / `session_reset` / `session_rollback`（UI lineage command 層）

參考：
- `src/v2/session-graph/sqlite-provider.ts`
- `src/v2/ui-api/commands/session-memory-commands.ts`

---

## 4. Checkpoint 目前何時發生

目前已落地兩個時機：

1. **task-start checkpoint**  
   在 task materialization / submit 前建立
2. **artifact-accepted checkpoint**  
   callback ingestion 接受 artifact 後建立

參考：
- `src/v2/ui-api/local-api.ts`（task-start）
- `src/v2/executor/tork-callback.ts`（artifact-accepted）
- `src/v2/agent-runner/root-session.ts`（root-session loop 也會建 checkpoint）

> `sessionPolicies.checkpointOn` 雖有 `before-recovery` 宣告，但目前尚未完整自動接線。

參考：`src/v2/domain-packs/software.ts`

---

## 5. fork / reset / rollback：行為矩陣

| 動作 | 入口 | 目前行為 | 是否直接觸發新執行 | 是否動到 git workspace |
|---|---|---|---|---|
| `session fork` | `/api/v2/sessions/:id/fork` | 寫 `session_fork` + history | 否（目前偏記錄意圖） | 否 |
| `session reset` | `/api/v2/sessions/:id/reset` | 寫 `session_reset` + history | 否（目前偏記錄意圖） | 否 |
| `session rollback` | `/api/v2/sessions/:id/rollback` | 寫 `session_rollback` + history | 否（目前偏記錄意圖） | 否 |
| `task fork-session` | `/api/v2/runs/:runId/tasks/:taskId/fork-session` | 寫 `recovery_decision` + event | 否（queued intent） | 否 |
| `task rollback-workspace` | `/api/v2/runs/:runId/tasks/:taskId/rollback-workspace` | 寫 `recovery_decision` + event | 否（queued intent） | 否 |
| `worktree rollback` | `/api/v2/runs/:runId/worktree/rollback` | 寫 rollback 資源 + event | 不涉及新 run | **是（執行 git 操作）** |

參考：
- `src/v2/server/ui-routes.ts`
- `src/v2/ui-api/commands/task-commands.ts`
- `src/v2/ui-api/commands/session-memory-commands.ts`
- `src/v2/ui-api/commands/worktree-commands.ts`

---

## 6. 常用 API（operator）

### Run / 監看

- `POST /api/v2/run-goal`
- `GET /api/v2/runs/:runId`
- `GET /api/v2/runs/:runId/logs`
- `GET /api/v2/runs/:runId/sessions`
- `GET /api/v2/ui/sessions-memory?runId=...`

### Recovery / Session

- `POST /api/v2/runs/:runId/tasks/:taskId/retry`
- `POST /api/v2/runs/:runId/tasks/:taskId/fork-session`
- `POST /api/v2/runs/:runId/tasks/:taskId/rollback-workspace`
- `POST /api/v2/runs/:runId/tasks/:taskId/request-revision`
- `POST /api/v2/sessions/:sessionId/fork`
- `POST /api/v2/sessions/:sessionId/reset`
- `POST /api/v2/sessions/:sessionId/rollback`

### Worktree rollback（安全流程）

1. `POST /api/v2/runs/:runId/worktree/snapshots`
2. `POST /api/v2/runs/:runId/worktree/rollback-preview`
3. `POST /api/v2/runs/:runId/worktree/rollback`

---

## 7. 現況結論（TL;DR）

- Southstar v2 的 session lineage 已有 durable 基礎（session node/checkpoint/recovery）。
- checkpoint 已落地：`task-start`、`artifact-accepted`。
- 多數 fork/reset/rollback action 在 UI command 層目前是「**記錄可審計意圖**」；
  真正直接改 workspace 的是 worktree rollback API。
- `before-recovery` 目前屬於 policy 層已宣告、runtime 自動接線尚待補齊。

---

## 8. 主要程式碼索引

- Session graph provider：`src/v2/session-graph/sqlite-provider.ts`
- Session 型別：`src/v2/session-graph/types.ts`
- Run 建立與 materialization：`src/v2/ui-api/local-api.ts`
- Callback ingestion：`src/v2/executor/tork-callback.ts`
- UI command routes：`src/v2/server/ui-routes.ts`
- Session/Memory commands：`src/v2/ui-api/commands/session-memory-commands.ts`
- Task recovery commands：`src/v2/ui-api/commands/task-commands.ts`
- Worktree commands：`src/v2/ui-api/commands/worktree-commands.ts`
- Read model（Sessions/Memory）：
  - `src/v2/read-models/sessions-memory.ts`
  - `src/v2/ui-api/page-models/sessions-memory.ts`
- 資料表 schema：`src/v2/stores/schema.ts`

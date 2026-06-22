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
    C --> D[Build ContextPacket + TaskEnvelope]
    D --> E[Checkpoint<br/>task-start]
    E --> F[Per-task Tork submit]
    F --> G[Agent Runner Heartbeat]
    F --> H[/api/v2/tork/callback]
    H --> I[Idempotency 檢查]
    I --> J[Artifact Acceptance + Evaluator]
    J -->|accepted| K[artifact_ref + memory writeback]
    J -->|needs_repair/rejected| L[task failed / runtime exception]
    K --> M[更新 task/run 狀態 + metrics]
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
    X[sessions-memory / workflow-canvas / runtime-monitor]
  end

  M --> X
  L --> X
  O --> X
  P --> X
  T --> X
  V --> X

  W[[before-recovery checkpoint<br/>recovery apply / scheduler 使用]]
  O --> W
  W --> E
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
- `src/v2/session/postgres-session-store.ts`
- `src/v2/read-models/postgres-core.ts`

---

## 4. Checkpoint 目前何時發生

目前已落地兩個 checkpoint 時機，另有 callback writeback：

1. **task-start checkpoint**
   runnable-task scheduler 先建立 `context_packet` 與 `task_envelope`，再建立 task-start checkpoint，checkpoint refs 會指回本次 context/envelope 與已選入的 artifact refs。
2. **before-recovery checkpoint**
   recovery decision apply 前後保留失敗上下文，讓 reset/fork/rollback 後的下一次 scheduler dispatch 可以重建 context。
3. **callback writeback（不是 checkpoint）**
   callback ingestion 接受 artifact 後寫入 `artifact_ref`、history、hand/task state 與 memory delta；目前不建立 `artifact-accepted` checkpoint。

參考：
- `src/v2/scheduler/runnable-task-scheduler.ts`（task-start / context packet / envelope / per-task Tork hand submit）
- `src/v2/executor/postgres-tork-callback.ts`（artifact_ref / memory / callback state writeback）
- `src/v2/exceptions/recovery-decision-applier.ts`（recovery apply / task release / before-recovery refs）
- `src/v2/agent-runner/root-session.ts`（root-session loop 也會建 checkpoint）

參考：`src/v2/domain-packs/software.ts`

---

## 5. fork / reset / rollback：行為矩陣

| 動作 | 入口 | 目前行為 | 是否直接觸發新執行 | 是否動到 git workspace |
|---|---|---|---|---|
| `session fork` | `/api/v2/sessions/:id/fork` | 寫 `session_fork` + history | 否（目前偏記錄意圖） | 否 |
| `session reset` | `/api/v2/sessions/:id/reset` | 寫 `session_reset` + history | 否（目前偏記錄意圖） | 否 |
| `session rollback` | `/api/v2/sessions/:id/rollback` | 寫 `session_rollback` + history | 否（目前偏記錄意圖） | 否 |
| `task fork-session` | recovery decision `fork-session` | 建新 branch session，task 回 `pending` | 是，由 scheduler 重建 context 後 submit | 否 |
| `task reset-session` | recovery decision `reset-session` | 新 attempt/session，排除 checkpoint 後 failed suffix | 是，由 scheduler 重建 context 後 submit | 否 |
| `task rollback-session` | recovery decision `rollback-session` | 需要 operator approval，workspace rollback + rollback marker | 是，由 scheduler 重建 context 後 submit | **是** |
| `task rollback-workspace` | `/api/v2/runs/:runId/tasks/:taskId/rollback-workspace` | 寫 `recovery_decision` + event，等待 apply/approval | 否（queued intent） | 否 |
| `worktree rollback` | `/api/v2/runs/:runId/worktree/rollback` | 寫 rollback 資源 + event | 不涉及新 run | **是（執行 git 操作）** |

參考：
- `src/v2/server/ui-routes.ts`
- `src/v2/server/routes.ts`
- `src/v2/session-recovery/postgres-controller.ts`
- `src/v2/exceptions/recovery-decision-applier.ts`
- `src/v2/scheduler/runnable-task-scheduler.ts`

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
- checkpoint 已落地：`task-start`、`before-recovery`；callback 已落地 `artifact_ref`、history、memory writeback 與 hand/task state writeback。
- 多數 fork/reset/rollback action 在 UI command 層目前是「**記錄可審計意圖**」；
  真正直接改 workspace 的是 worktree rollback API。
- recovery decision apply 不直接 submit Tork；它釋放 task 後，由 scheduler 建立新的 `context_packet` / `task_envelope` 並 per-task submit。

---

## 8. 主要程式碼索引

- Session store：`src/v2/session/postgres-session-store.ts`
- Session 型別：`src/v2/session-graph/types.ts`
- Run 建立：`src/v2/ui-api/postgres-run-api.ts`
- Runnable task materialization / context assembly / submit：`src/v2/scheduler/runnable-task-scheduler.ts`
- Callback ingestion：`src/v2/executor/postgres-tork-callback.ts`
- UI command routes：`src/v2/server/ui-routes.ts`
- Runtime command routes：`src/v2/server/routes.ts`
- Recovery controller：`src/v2/session-recovery/postgres-controller.ts`
- Recovery decision apply：`src/v2/exceptions/recovery-decision-applier.ts`
- Read model（Sessions/Memory）：
  - `src/v2/read-models/postgres-core.ts`
  - `src/v2/read-models/managed-agents.ts`
- 資料表 schema：`src/v2/db/schema.ts`

## 9. v1 Recovery Semantics Update

Session recovery actions are now committed by Southstar, not directly by LLM output.

- LLM/agent may suggest recovery in artifacts.
- Evaluator/policy classifies failure facts.
- Southstar creates `before-recovery` checkpoints and `recovery_decision` resources.
- Recovery rebuild creates immutable `context_packet` plus matching `task_envelope.agentPrompt`.
- Pi-native rewind/fork/resume is an optimization and falls back to Southstar-native replay.
- Real Postgres E2E validates normal and abnormal managed context/session/memory propagation through Tork/Pi/Postgres.

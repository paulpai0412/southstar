# Southstar v2 Operations UI / API / Executor 設計文件（Phase 1.5）

日期：2026-06-12

## 1. 目標

Phase 1 已完成 Southstar v2 runtime MVP：Pi planner 產生 canonical `SouthstarWorkflowManifest`，SQLite 保存 durable state，Tork 作為 Docker execution provider，root session 負責 artifact gate 與 repair loop，並以真實 Docker/Tork/SQLite/Pi harness E2E 驗證。

Phase 1.5 的目標是把「可測試 runtime」推進為「可操作產品雛形」：

- Southstar repo 內建唯一 web app，不 iframe Tork Web，不依賴另一個 `pi-web` runtime。
- `Southstar Runtime Server` 成為 UI、CLI、mobile/voice client 共用的操作核心。
- UI 與 CLI 同步完成完整操作閉環：prompt -> draft -> review/revise -> run -> monitor -> steer/voice transcript -> inspect artifact/session/memory。
- 引入 `ExecutorProvider` 邊界，Phase 1.5 完整遷移 Tork provider，但不實作 Docker provider。
- 保留 SQLite；抽出 store boundary，Phase 2 才接 Postgres adapter，不在 Phase 1.5 將 Southstar DB 搬入 Tork Postgres。
- 引入 approval policy，預設 `policy` mode，支援 `manual` 與 `auto` override，讓遠端語音操作不被低風險 approval 卡住。

## 2. 非目標

- 不重寫 Phase 1 runtime core。
- 不移除 Tork，不改成直接 Docker executor。
- 不把 Southstar durable state 併入 Tork Postgres。
- 不做真正語音 ASR、手機 app 或麥克風權限整合；Phase 1.5 只做 voice transcript command flow。
- 不做 data analysis domain；資料分析待 UI/API/CLI 操作閉環穩定後再加入。
- 不做 production auth、多租戶、遠端部署安全模型。

## 3. 已確認決策

### 3.1 操作入口

UI 與 CLI/API server 一起做，不縮範圍。實作採垂直切片優先，先證明同一條 runtime flow 可由 UI 與 CLI 觸發、監控、插入 steering、查看結果。

### 3.2 UI 所在位置

選擇 Southstar repo 內建唯一 web app：

```text
apps/southstar/
  app/
  components/southstar/
  lib/southstar/
  src/v2/
```

可以參考原 `~/apps/pi-web` 的 UI pattern，但不可讓 Southstar web runtime 依賴外部 `~/apps/pi-web`。

### 3.3 Runtime server

採單一 Southstar Node runtime server：

```text
CLI / Next UI / mobile voice client
  -> Southstar Runtime Server
      -> Planner service
      -> Store boundary
      -> ExecutorProvider
      -> Tork callback endpoint
      -> SSE / polling read APIs
```

Next UI 是 client，不直接操作 SQLite/Tork。Tork callback 也進 runtime server，而不是進 Next API route。

### 3.4 Executor

Phase 1.5 只做：

```ts
interface ExecutorProvider {
  id: string;
  submit(input: ExecutorSubmitInput): Promise<ExecutorBinding>;
  getStatus(binding: ExecutorBinding): Promise<ExecutorStatus>;
  cancel(binding: ExecutorBinding): Promise<ExecutorCancelResult>;
}
```

第一個 provider 是 `TorkExecutorProvider`，包住目前 `TorkClient`、Tork projection 與 callback ingestion。UI/server/CLI 不可直接依賴 `TorkClient`。

### 3.5 DB

Phase 1.5 保留 SQLite：

```text
Southstar durable store = SQLite
Tork datastore = Docker Postgres
```

不整併。原因是兩者資料生命週期不同，Phase 1.5 的主要風險在操作閉環，不應同時換 DB。Phase 1.5 只抽 store boundary，Phase 2 再做 Postgres adapter。

## 4. UI 視覺方向

採「Hybrid Workflow IDE」為主基調，保留 light ops console 的清晰度與 dark command center 的 event/log 密度。

參考概念：

- Option 1 Light Ops Console：`/home/timmypai/.codex/generated_images/019e984e-99bd-7563-bb61-c5133b2a795d/ig_0b73285c23e48317016a2b5fd2c7b881919296b1f2d75082c8.png`
- Option 2 Dark Command Center：`/home/timmypai/.codex/generated_images/019e984e-99bd-7563-bb61-c5133b2a795d/ig_0b73285c23e48317016a2b60c29af88191aa67761df0d1b759.png`
- Option 3 Hybrid Workflow IDE（主基準）：`/home/timmypai/.codex/generated_images/019e984e-99bd-7563-bb61-c5133b2a795d/ig_0b73285c23e48317016a2b61d291188191bf1cc04164cba39d.png`

設計原則：

- 操作型產品，不做 marketing hero。
- 第一屏就是工作台。
- 8px radius 以下，薄邊框，克制色彩，避免裝飾性 orb/glow/gradient。
- DAG canvas 是中心，Planner Chat 與 Runtime Monitor 是左右主控。
- 表格、事件流、task detail、executor 狀態要密集但可讀。
- Voice 併入 Planner Chat，不做獨立 voice panel。
- 所有重要文字與控制元件必須 code-native，不使用靜態 screenshot 當 UI。

## 5. 簡易版 / 完整版

同一個 UI 支援 view mode：

```text
View: Simple | Full
```

切換只改 layout density 與 panel visibility，不改 API 與資料來源。

### 5.1 Simple Mode

目標是遠端、語音、手機或低干擾操作：

- Planner Chat，含文字 prompt、steering、voice transcript。
- Draft summary、Review Draft、Revise、Run。
- Workflow Canvas 簡化 DAG。
- Current Run status。
- Current Task artifact / evaluator result。
- Approval next action。

### 5.2 Full Mode

目標是 operator 深度診斷：

- Planner Chat + draft/revision timeline。
- Workflow Canvas。
- Runtime Monitor：polling + SSE event stream。
- Task Detail。
- Agent Definitions + Skill refs。
- Sessions/Memory。
- Vault/MCP。
- Executor Ops。
- Approval Policy。
- Artifacts / logs / events。

## 6. Planner Chat + Voice Transcript

Planner Chat 是主要 command surface，支援三類輸入：

```text
Goal Prompt
Steering
Voice Transcript
```

Voice transcript 是語音轉文字後的標準輸入形式。Phase 1.5 不做 ASR，只接受 transcript：

```json
{
  "mode": "voice-transcript",
  "transcript": "幫我確認 root validator 為什麼卡住，低風險可自動 approve"
}
```

runtime server 依 approval policy 決定將 transcript 轉為：

- `steering.received`
- draft revision prompt
- approval decision
- run action
- pending approval request

所有 voice command 必須 append `workflow_history`，並保存 decision trace。

## 7. Agent Skills 設計

Skill 不直接長在 agent runtime state 上，而是透過 skill catalog、SQLite snapshot 與 task envelope 三層管理。

### 7.1 Source Skill Catalog

Skill source 可以來自：

- repo 內建 skill catalog。
- user 匯入的 local skill pack。
- future remote/marketplace skill pack。

source catalog 是定義來源，不是每次 run 的 durable truth。

### 7.2 Runtime Skill Snapshot

planner 產生 manifest 後，Southstar 解析 skill refs，將實際使用版本保存成 durable snapshot：

```text
runtime_resources.resource_type = skill_pack | skill_snapshot | skill_grant
```

snapshot 需包含：

- `skillId`
- `version`
- `contentHash`
- `instructions`
- `allowedTools`
- `requiredMounts`
- `mcpRequirements`
- `artifactContracts`

### 7.3 Manifest 引用

`AgentDefinition` 與 subagent 都只引用 skill refs：

```ts
agentDefinitions: [{
  id: "pi-implementer",
  skillRefs: ["software.patch.minimal", "artifact.report.v1"]
}]

tasks[].subagents: [{
  id: "implementer",
  agentId: "pi-implementer",
  skillRefs: ["software.calc-cli"]
}]
```

### 7.4 TaskEnvelope Materialization

container 只拿該 task 需要的 resolved skills：

```ts
skills: [{
  skillId,
  version,
  contentHash,
  instructions,
  allowedTools,
  mountPath: "/southstar/skills/software.calc-cli"
}]
```

實體檔案只允許 materialize 到：

```text
/tmp/southstar-runs/<runId>/<taskId>/skills/*
```

task 結束後清除。durable skill snapshot 留在 SQLite，不保存成 `.southstar/skills` runtime folder。

## 8. Approval Policy

預設 mode 是 `policy`：

```ts
approvalPolicy: {
  mode: "manual" | "auto" | "policy";
  autoApprove: {
    plannerDraft: boolean;
    workflowRevision: boolean;
    memoryDelta: boolean;
    lowRiskArtifactGate: boolean;
    steering: boolean;
    voiceCommand: boolean;
  };
  requireManualFor: string[];
}
```

### 8.1 Manual

所有 draft review、workflow revision、memory delta、approval action 都需要人工確認。

### 8.2 Auto

允許低風險流程自動推進，用於本機 demo、遠端語音或非 production workflow。仍必須寫 audit event。

### 8.3 Policy

低風險自動，高風險人工：

- code change、secret access、external write、deployment、成本超限、刪除動作要求人工。
- low-risk steering、read-only inspection、artifact summary、memory suggestion 可 auto approve。

所有 approval decision 都要：

- 寫 `runtime_resources.resource_type='approval'`。
- append `workflow_history`。
- UI/CLI 可查 pending/approved/rejected/auto-approved。

## 9. Runtime Server API

Phase 1.5 API：

```text
POST /api/v2/planner/drafts
POST /api/v2/planner/drafts/:draftId/revise
POST /api/v2/runs
POST /api/v2/run-goal
GET  /api/v2/runs/:runId
GET  /api/v2/runs/:runId/events
GET  /api/v2/runs/:runId/events/stream
GET  /api/v2/runs/:runId/tasks
GET  /api/v2/runs/:runId/tasks/:taskId
GET  /api/v2/runs/:runId/artifacts
GET  /api/v2/runs/:runId/sessions
GET  /api/v2/runs/:runId/memory
POST /api/v2/runs/:runId/steering
POST /api/v2/runs/:runId/voice-command
POST /api/v2/approvals/:approvalId/decision
POST /api/v2/tork/callback
```

事件更新支援 polling 與 SSE。SSE 是 Runtime Monitor 的主要即時來源，polling 是 fallback。

## 10. CLI 操作

Phase 1.5 CLI：

```bash
southstar:v2 serve
southstar:v2 run-goal --goal "..."
southstar:v2 plan --goal "..."
southstar:v2 revise --draft-id <draftId> --prompt "..."
southstar:v2 run --draft-id <draftId>
southstar:v2 wait --run-id <runId>
southstar:v2 status --run-id <runId>
southstar:v2 tasks --run-id <runId>
southstar:v2 task --run-id <runId> --task-id <taskId>
southstar:v2 artifacts --run-id <runId>
southstar:v2 sessions --run-id <runId>
southstar:v2 memory --run-id <runId>
southstar:v2 logs --run-id <runId>
southstar:v2 steer --run-id <runId> --message "..."
southstar:v2 voice-command --run-id <runId> --transcript "..."
```

`serve` 啟動 runtime server 與 callback endpoint。CLI 其他命令預設呼叫 server API；若 server 未啟動，可選擇 fail closed，不偷偷改走另一套 runtime path。

## 11. UI 操作流程

### 11.1 Draft Flow

```text
Planner Chat goal prompt
  -> POST /api/v2/planner/drafts
  -> Draft Review 顯示 manifest summary / DAG / agents / skills / mounts / memory / vault / MCP
  -> Review Draft or Revise
```

### 11.2 Run Flow

```text
Run
  -> POST /api/v2/runs
  -> ExecutorProvider.submit
  -> TorkExecutorProvider
  -> Tork callback
  -> SQLite update
  -> SSE / polling 更新 UI
```

### 11.3 Inspect Flow

```text
Click task
  -> GET /api/v2/runs/:runId/tasks/:taskId
  -> show TaskEnvelope summary, artifact, evaluator, repair, session, memory, executor binding
```

### 11.4 Steering / Voice Flow

```text
Planner Chat input mode = Steering or Voice Transcript
  -> POST /api/v2/runs/:runId/steering
  -> or POST /api/v2/runs/:runId/voice-command
  -> approval policy
  -> history event
  -> root decision visible in Runtime Monitor
```

## 12. Testing / 驗收

### 12.1 Real E2E

新增真實 E2E：

1. `ui-api-run-goal-real.ts`
   - 透過 runtime server API 產生 draft、run、wait、查 artifact/session/memory。

2. `cli-run-goal-real.ts`
   - 用 `southstar:v2 run-goal` 完成 calc sum fixture。

3. `ui-browser-operations.ts`
   - 啟動 Next UI。
   - 輸入 prompt。
   - 看到 workflow canvas。
   - run 後看到 progress/task/artifact。

4. `voice-command-policy.ts`
   - POST transcript。
   - policy auto/hold decision。
   - history 有 voice/steering/root decision。

5. `approval-policy.ts`
   - policy mode 低風險 auto approve。
   - 高風險產生 pending approval。
   - manual decision 可推進流程。

### 12.2 UI 驗收

- Simple / Full mode 可切換。
- Planner Chat 內含 text prompt、steering、voice transcript。
- Draft Review 可顯示 skill refs、mounts、agents、DAG。
- Runtime Monitor 可用 SSE 更新，polling fallback 可用。
- Task Detail 可查 artifact、evaluator、repair、session。
- Executor Ops 不直接暴露 Tork 為 workflow source，只顯示 provider binding。

### 12.3 Regression

- Phase 1 `npm run test:e2e:real` 必須維持通過。
- `npm run test:v2` 必須維持通過。
- `npm test` 必須維持通過。

## 13. 風險與緩解

| 風險 | 緩解 |
| --- | --- |
| UI 直接碰 SQLite/Tork，導致 runtime 邊界混亂 | UI 只呼叫 runtime server API |
| 同時做 UI/CLI/server 範圍過大 | 以垂直切片實作，每個切片都跑真 E2E |
| approval auto mode 造成高風險操作失控 | 預設 policy；高風險 require manual；所有 auto approval 寫 audit |
| skill source 與 runtime snapshot 混淆 | source catalog 與 runtime skill snapshot 分離 |
| SSE 不穩造成 UI 不更新 | polling fallback 必須存在 |
| ExecutorProvider 抽象過度 | Phase 1.5 只包 Tork provider，不做 Docker provider |
| DB abstraction 變成大改 | store boundary 先服務 server/API，不重寫已穩定 SQLite schema |

## 14. 完成定義

Phase 1.5 完成時，使用者可以：

1. 啟動 `southstar:v2 serve`。
2. 開啟 Southstar 內建 UI。
3. 在 Planner Chat 輸入 goal prompt。
4. 審核 draft，必要時 revise。
5. 按 Run，看到 Tork executor binding 與 DAG 狀態。
6. 在 Runtime Monitor 看到 progress / events。
7. 點 task 查看 artifact、evaluator、session、memory。
8. 在 Planner Chat 插入 steering 或 voice transcript。
9. 由 approval policy 自動通過低風險 action，並保留 audit。
10. 用 CLI 完成同樣操作與診斷。


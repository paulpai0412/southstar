# Southstar Operator Product Control Tower Design

## 1. 背景

目前 `/home/timmypai/apps/southstar/web` 已有 Chat、Workflow、Operator 三個模式，也已完成 Operator 左側 Project Scope / Operator Focus、中間 Runtime State Board / workflow progress、右側 shared floating sidecar 的基礎能力。產品 audit 顯示：現況已接近「可 debug」，但還未達到「可營運」。

本設計將 Operator 從 MVP debug tool 調整為產品級 **Incident Control Tower**：使用者進入 Operator 後，第一眼要能知道哪個 workflow 卡住、卡在哪個 task、原因是什麼、影響範圍是什麼、下一步應該做哪個 action，以及若需要 debug，該從 DAG / History / Live SSE / Artifacts 哪裡切入。

## 2. 產品目標

1. 一眼看出目前整體執行健康度。
2. 一眼看出所有需要人工處理的 incident。
3. 點選 incident 後，不先掉進 raw log，而是先看到 operator-readable summary。
4. 支援從 summary 逐步下鑽到 DAG、History、Live SSE、Actions、Artifacts。
5. Workflow tab 能把 template selection、validate、launch、handoff Operator 串成一條產品旅程。
6. Workflow DAG node click 後，右側 agent profile 編輯要像 task workspace，而不是單純表單。
7. Chat、Workflow、Operator 三個模式有清楚關係：Chat 用於非 workflow job 與一般互動，Workflow 用於 DAG 生成/修訂/啟動，Operator 用於監控與復原。
8. 保留現有 pi-web / Southstar UI style，不另創新的視覺系統。

## 3. 非目標

- 不重做整個 AppShell。
- 不引入新的大型 UI framework。
- 不新增 runtime lifecycle state。
- 不讓前端自行推論 runtime truth；前端只呈現 read model 與可解釋的 derived view。
- 不把 raw SSE / raw history 移除；只是在它們上方增加產品語意層。
- 不要求 mobile 完整等價桌面 workflow authoring，但窄屏下 mode switching 與 sidecar/tab 操作必須可靠。

## 4. 推薦方案

採用 **Answer-first Incident Console**。

其他方案：

- 方案 A：只加強現有 state board 與 tabs。成本低，但仍像 debug console，無法解決「下一步是什麼」。
- 方案 B：Answer-first Incident Console。用 incident summary 統一 attention、state、task、history、actions。推薦。
- 方案 C：完全重做成獨立 Operator app。長期可行，但現階段會破壞 Chat / Workflow / Operator 的一致性。

本設計選 B，原因是它能沿用目前 AppShell、SidecarShell、Operator read model、workflow canvas 與 CSS tokens，同時把產品價值推到最前面。

## 5. 目標資訊架構

```text
+--------------------------------------------------------------------------------+
| top bar: project scope status | Chat | Workflow | Operator | runtime health     |
+----------------------+---------------------------------------------------------+
| LEFT                 | CENTER                                                  |
| Project Scope        | Operator Command Center                                 |
| selected repo        | - health strip: runs / blocked / stale / last refresh    |
| filter health        | - priority lanes: Needs Action / At Risk / Running / OK  |
|----------------------| - selected incident summary                              |
| Operator Focus       | - selected workflow progress or DAG                      |
| grouped incidents    |                                                         |
| grouped runs         |                                                         |
+----------------------+---------------------------------------------------------+
                         +------------------------------------------------------+
                         | shared sidecar                                       |
                         | Summary | DAG | History | Live SSE | Actions | Artifacts |
                         | Summary is always operator-readable first            |
                         +------------------------------------------------------+
```

## 6. Core product objects

### 6.1 Incident

Incident 是 Operator UI 的第一級產品物件，不是 backend lifecycle state。它從 `attentionItems`、run status、task debug read model、history/resource refs 轉成可讀 summary。

```ts
type OperatorIncident = {
  id: string;
  runId: string;
  taskId: string | null;
  severity: "blocked" | "error" | "warning" | "info";
  status: "needs_action" | "observing" | "recovering" | "resolved";
  title: string;
  cause: string;
  impact: string;
  nextAction: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  ageLabel: string;
  evidenceRefs: string[];
  commandIds: string[];
};
```

### 6.2 Priority lane

Runtime State Board 保留 lifecycle grouping，但產品主視角改為 priority lane：

- `Needs Action`: blocked, exception, failed, quarantined, or command-required attention.
- `At Risk`: scheduling/running/verifying 超過 expected age、repeated retry、stale callback warning。
- `Running`: active without current attention。
- `Recently Resolved`: completed/recovered within recent window。

State Board 可作為 secondary scan，但 priority lane 是第一視角。

### 6.3 Task Summary

Sidecar 每個 task debug tab 上方固定一張 summary：

```text
Task: Implement empty-input guard
State: queued, blocked by stale_callback
Cause: callback attempt 101 arrived after attempt 115 became current
Impact: implementation task cannot advance; downstream verify and summary are pending
Recommended next action: retry task or review recovery decision
Evidence: history #1535, exception runtime-exception-...
```

使用者先讀 summary，再決定要看 DAG、History、Live SSE、Actions、Artifacts。

## 7. Mode journeys

### 7.1 Chat

Chat empty state 應該說明：

- 目前 selected project。
- Chat 能做什麼：一般對話、ad-hoc 問答、非 workflow job、單次操作。
- Chat 不負責正式 workflow DAG lifecycle；需要 DAG 生成、修訂、validate、launch 時引導到 Workflow tab。
- Primary action：選 project 或開始新 chat。

### 7.2 Workflow

Workflow tab 應該變成 launch journey：

1. 選 project。
2. 選 workflow template。
3. 中央顯示 template preview：用途、inputs、agents、expected DAG shape。
4. 填入 goal / input。
5. Validate DAG。
6. Launch run。
7. 成功後顯示 handoff：`Open in Operator`。

Workflow DAG node click 應該開啟右側 **Task Profile Workspace**：

1. 頂部 summary 顯示 task intent、role、目前 agent profile、editable/read-only 狀態。
2. Profile comparison 顯示 base profile、effective profile、local override diff。
3. Recommendation 區塊顯示候選 profiles、skills、MCP grants 與推薦理由。
4. Edit 區塊才是 provider/model/thinking/instruction/skills/MCP form。
5. Save 前顯示 validation impact：保存後 draft 會變成 `needs_validation`，launch 前必須重新 validate。
6. Runtime node 只能 read-only，並顯示「此 run 已 materialize，請回 draft 編輯」。
7. Save 成功後中心 DAG / launch preview 顯示 needs validation 狀態。

這個調整的核心是：使用者不是在編輯一個抽象 agent profile，而是在調整「這個 workflow task 要用什麼 agent 能力完成」。因此右側面板必須先回答 task purpose、目前配置、為何推薦替代 profile、改了會影響什麼。

### 7.3 Operator

Operator journey：

1. 選 project 或 all projects。
2. 看 health strip。
3. 看 priority lanes。
4. 點 Needs Action incident。
5. 中央顯示 incident summary 與 workflow progress。
6. 右側 sidecar 顯示 Summary tab，再下鑽 DAG/History/SSE/Actions/Artifacts。
7. 執行 action 前看 consequence preview 與 reason input。
8. action 後看到 command result、updated state、next polling timestamp。

## 8. Layout behavior

### 8.1 Desktop

- 左側維持上下兩區：Project Scope、Operator Focus。
- 中間第一屏要同時看到 health strip、priority lanes、selected workflow progress。
- 右側 sidecar 預設 floating，但 tab header 必須 sticky 且永遠可點。
- pinned mode 不能讓中心內容窄到無法閱讀；低於安全寬度時自動轉 floating。
- Workflow node profile sidecar 使用同一個 SidecarShell；tab label 仍是 `Node Profile`，內容第一屏必須是 summary + diff，而不是直接進入長表單。

### 8.2 Narrow viewport

- sidebar open 時不能遮住 mode tabs。
- mode rail 需要保持可操作，或 sidebar 必須有明確 close/back affordance。
- sidecar 在窄屏使用 full-screen sheet，不使用桌面 floating overlay。

## 9. Visual style

遵守現有 chat/workflow UI：

- 使用 `web/app/globals.css` 既有 tokens。
- 維持平面、低裝飾、可掃描的 operational UI。
- 不新增 marketing hero、large cards、illustration-heavy layout。
- 不使用新色系作為主題；severity 使用現有 warning/danger text treatment。
- 卡片只用在 repeated incident/run/task item，不把整頁 section 包成大卡。

## 10. Error and empty states

每個 mode 的 empty state 都必須回答：

1. 目前缺什麼。
2. 為什麼需要它。
3. 使用者下一步可以做什麼。

Operator API error 不是 empty state。要明確顯示：

- last successful refresh time。
- current API error。
- retry button。
- stale data marker if stale model remains visible。

## 11. Accessibility requirements

- Mode tabs, sidebar rows, sidecar tabs, action buttons 必須可 keyboard 操作。
- Sidecar tab header 不可被內容遮擋。
- 所有 icon-only buttons 必須有 accessible name。
- warning/danger 狀態不能只靠顏色，需有文字 label。
- click target 建議至少 32px 高；mobile 需至少 40px。
- raw JSON 區塊要保持可 copy 與 horizontal scroll，不壓縮文字到不可讀。

## 12. Acceptance criteria

1. Operator overview 第一屏能看出 active runs、blocked incidents、stale/at-risk count、last refresh。
2. Duplicate stale callback attentions 會被 group 成可讀 incident groups。
3. 點選 incident 後，中間與 sidecar 都先顯示 summary。
4. Sidecar tabs 在 History 長內容 scroll 狀態仍可點。
5. Actions tab 顯示 consequence preview、reason input、command result。
6. Workflow tab 選 template 後，中央顯示 launch preview，而不是 generic empty state。
7. Launch run 後有 `Open in Operator` handoff。
8. Workflow DAG node click 後，Node Profile 右側面板顯示 task summary、effective profile、override diff、candidate recommendations、validation impact。
9. Runtime node profile 是 read-only，且說明要回 draft 編輯。
10. Mobile/narrow viewport 下 mode switching 不被 sidebar 擋住。
11. `npm --prefix web run lint` 通過。
12. `npm --prefix web run build` 通過。
13. `npm test` 通過。
14. Playwright smoke captures desktop Operator overview、sidecar summary、sidecar tabs、mobile mode switching、workflow node profile editor。

# Southstar Runtime 7x24 穩定執行與多任務並行 Hardening 設計

日期：2026-06-15

## 1. 目標

在不改變 Southstar/Tork 邊界前提下，補齊 runtime 控制面，使 Southstar 可穩定 7x24 運行，並支援多任務並行。

本設計範圍：

- **包含**：runtime + API/read-model（控制面）
- **不包含**：前端 UI 視覺改版

目標 SLO（第一版）：

- 並行能力：10 runs / 50 tasks
- reconcile p95 < 30s
- 連續運行 24h（soak）

部署策略：

- 近期：單實例 runtime
- 設計預留：未來可升級多實例（leader/lease seam）

## 2. 非目標

- 不 fork Tork。
- 不讓 Tork 成為 workflow/task completion truth。
- 不讓 heartbeat 或 reconcile 直接完成 workflow task。
- 不讓 callback 繞過 artifact/evidence/validator/evaluator/stop-condition。
- 不新增前端 UI 功能頁與視覺互動。

## 3. 核心不變式

1. **Southstar 是唯一 runtime truth**（workflow_runs / workflow_tasks / workflow_history / runtime_resources）。
2. **Tork 只提供 executor observation**，不能直接驅動 task completed。
3. **Heartbeat 是 liveness-only**。
4. **Reconcile 是 observation + classification + policy action trigger**，不是 completion shortcut。
5. **Callback 必須冪等**，且 task terminal 狀態單調不可逆（不可被晚到事件翻轉）。

## 4. 目標架構（Runtime Control Loop）

新增三段控制流，均在 runtime 內執行：

1. `HeartbeatIngestor`（API 入口）
2. `ExecutorReconcilerLoop`（背景週期 loop）
3. `PolicyActionDispatcher`（受 policy 約束的自動 action）

## 5. 交付策略（分階段，但同次實作完成）

- Phase A：loop + heartbeat 注入 + callback 冪等
- Phase B：全自動 action dispatcher（受 policy）
- Phase C：壓測/soak + 指標 gate

同一分支一次完成 A/B/C，最後以完整驗收證據整體交付。

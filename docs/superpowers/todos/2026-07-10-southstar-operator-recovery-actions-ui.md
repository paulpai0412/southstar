# Southstar Operator Recovery Actions UI Todo

## Goal

讓 Operator 可以在選定單一 workflow run/task 時，清楚區分「平常可發起的 task recovery」、「有 recovery decision 才能處理的 recovery flow」，以及「workflow/run/executor control」。

## Scope

- [x] Workflow state dashboard 的每張 workflow card 內顯示 run controls。
- [x] 新增 Recovery tab panel，只在有 recovery / approval / decision 可處理時顯示。
- [x] Task Action panel 顯示平常可用的 task-level recovery actions。
- [x] 移除左側 run row 與 workflow card 上的 pause/cancel 快捷按鈕。

## Task Action Panel

- [x] 固定列出 `Retry Task`。
- [x] 固定列出 `Fork Session`。
- [x] 固定列出 `Reset Session`。
- [x] 固定列出 `Rollback Session`。
- [x] 固定列出 `Request Workflow Revision`。
- [x] `Rollback Session` 沒有 usable `workspace_snapshot` 時 disabled，並顯示缺 snapshot 的原因。
- [x] `Fork Session`、`Reset Session`、`Rollback Session` 支援可選 `checkpointId`。
- [x] `Rollback Session` 支援選 `workspaceSnapshotRef`。
- [x] `Request Workflow Revision` 使用清楚命名，不再顯示成一般 `Request Revision`。

## Recovery Tab Panel

- [x] 新增 `Recovery` tab panel。
- [x] 只有當 selected run/task 有 recovery decision、approval、recovery execution 或 attention recovery command 時顯示。
- [x] 顯示待處理 recovery item 的完整內容，不只顯示 id。
- [x] 顯示 `Approve Recovery`。
- [x] 顯示 `Reject Recovery`。
- [x] 顯示 `Apply Recovery`。
- [x] 顯示 approval 類 commands，例如 approve/reject approval。
- [x] 沒有對應 recovery/approval resource 時，不顯示這些 commands。

## Workflow Card Controls

- [x] 在 State Dashboard 的每張 workflow card 內顯示 run controls。
- [x] 每張 workflow card 引用該 run 的 commands。
- [x] `Pause Run` / `Resume Run` 使用同一顆切換式 button。
- [x] 支援 `Cancel Run`。
- [x] executor actions 不放在 workflow control row；保留在 executor/recovery/debug context 中出現。
- [x] 移除左側 run row 的 pause/cancel button。
- [x] 移除 workflow card 上的 pause/cancel button。

## Data And State

- [x] 一般 task actions 不依賴 attention item。
- [x] Recovery tab commands 只來自 recovery / approval / decision read model。
- [x] Fork/reset/rollback 產生新 `root_session_id` 後，debug panel 要能看出新舊 session lineage。
- [x] Context debug 要顯示實際使用的 `baseCheckpointId`。
- [x] Memory debug 要標示哪些 memory 來自舊 session、哪些被 rollback invalidated。

## Known Gap

- [x] Production 會在 task start 前 capture clean Git `workspace_snapshot`。
- [x] Production rollback 對 clean Git snapshot 會還原 workspace 檔案；dirty/evidence-only snapshot 只記錄 evidence。
- [x] 在沒有 usable snapshot 時，rollback UI 明確 disabled。

## Out Of Scope

- 不重做 recovery engine。
- 不改 workflow execution state machine。
- 不把 recovery decision actions 常駐在 task action panel。

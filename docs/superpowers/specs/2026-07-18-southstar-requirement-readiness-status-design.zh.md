# Southstar Requirement Readiness Status Design

## Problem

Goal Requirements 目前只在 footer 顯示整體 readiness。Visual contract 尚未確認時，host 會將 draft 保持為 `confirmable=false`，但 requirement list 沒有把 validation issue 對應回個別 requirement，使用者因此不知道要修哪一列。

## Decision

沿用既有 `GoalRequirementsContent`、`validationIssues`、`coveragePreview` 與 UI contract selection，不新增資料表或第二套 readiness state。

每個非 superseded requirement 顯示一個可讀取的 status badge：

- `warning`：該 requirement 有 validation issue、未回答的 open question，或必要 visual contract 缺失／未確認。
- `complete`：沒有 requirement-level validation issue、沒有 open question，且 coverage 為 `ready`（或 host 已回報整體 confirmable）。
- `neutral`：尚無足夠 host readiness 資料，或該 requirement 不需要 visual contract。

Status badge 具備文字與 `aria-label`，不只依賴顏色。點擊 requirement row 仍使用既有 `onRequirementSelect`，由現有 sidecar 流程開啟 requirement；visual contract ref 由既有 editor 入口處理。

List header 顯示已完成／總數，footer 維持單一 primary action。主按鈕仍以 host-owned `confirmable` 為準，瀏覽器只做顯示與導覽，不自行放寬 gate。

## Implementation

1. 在 `GoalRequirementListBlock` 建立小型純函式，依 requirement index/path 對應 validation issues，並合併 open questions 與 coverage status。
2. 在每列加入 status icon、文字 label、`data-testid` 和 tooltip/aria label。
3. 在 header 加入完成數摘要，讓使用者知道還剩多少列。
4. 補 UI static/regression tests，覆蓋 warning、complete、neutral 與 aggregate count。
5. 保留現有 UI contract PATCH、AppShell readiness merge 與 backend contract status persistence，不修改其資料模型。

## Acceptance criteria

- 每個 requirement 都能清楚顯示 warning 或完成狀態。
- Visual contract 未確認時，對應 requirement 顯示 warning；其他已完成 requirement 不被整體 warning 淹沒。
- Visual contract 確認後，AppShell 更新 readiness，對應列可顯示完成狀態。
- `Confirm requirements` 仍不可繞過 host 的 `confirmable=false`。
- 不新增 fixture、fallback、平行 API 或資料表。

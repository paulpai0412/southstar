# Southstar Managed Agents Runtime Runbook

日期：2026-06-20

## 1. 目的

本 runbook 說明 operator 如何檢查 managed-agent runtime 的 session、brain、hand、recovery、tool proxy 與 evaluator 狀態。這裡的操作假設 Postgres 是 canonical runtime truth；Tork、container、host SDK、Pi/Codex/Claude Code harness 都只是 provider 或外部執行表面。

## 2. 快速檢查

1. 確認 run 存在於 `workflow_runs`，且狀態不是 terminal stale state。
2. 查詢 managed-agent read model：`GET /api/v2/runs/:runId/managed-agents`。
3. 檢查 `workflow_history` 是否持續寫入 session event。
4. 檢查 `runtime_resources` 中的 `brain_binding`、`hand_binding`、`context_packet`、`session_checkpoint`、`recovery_decision`、`tool_proxy_call`。
5. 若 read model 與 Postgres row 不一致，優先相信 Postgres row，再修 read model projection。

## 3. brain crash recovery

1. 查詢 run 的 managed-agent read model，定位 failed 或 lost 的 `brain_binding`。
2. 在 `workflow_history` 找到同一個 `runId`、`taskId`、`sessionId` 的 `brain.failed` 或相關 failure event。
3. 確認最近的 `context_packet` 有 source event ids、artifact refs、checkpoint refs，且沒有依賴舊 process memory。
4. 觸發 `wake-new-brain` recovery。
5. 確認 recovery 寫入 `recovery_decision` 與 `before-recovery` checkpoint。
6. 確認新 `brain_binding` 狀態為 `running`，且 provider payload 只包含 recovery key、context packet id 或其他可審計 metadata。
7. 若再次失敗，先檢查 session event 是否足以重建 prompt，再檢查 provider 啟動錯誤；不要直接修改舊 brain process state。

## 4. hand reprovision

1. 查詢 `hand_binding`，定位 failed、lost 或 orphan hand。
2. 確認 hand failure 已寫入 session event，例如 `hand.failed`。
3. 觸發 `reprovision-hand` recovery。
4. 確認新 `hand_binding` 已建立且狀態為 `provisioned`。
5. 確認舊 hand 沒有被當成 session truth；session truth 只來自 Postgres event/resource。
6. 若 workspace 需要 rollback，先確認 `hand_snapshot` 或 workspace snapshot ref，再執行 rollback 類 recovery。
7. 若 reprovision 成功但 task 沒有繼續 dispatch，檢查 runnable-task scheduler 是否看到 runnable task 與 active brain/hand binding。

## 5. credential isolation

1. 檢查 task envelope、sandbox env、hand provider payload 不含 token-shaped value。
2. 確認 credential 只以 `vault_lease` resource、`secure_blobs` digest/encrypted blob、以及 tool proxy grant 形式存在。
3. 檢查 `vault_lease` 的 runtime resource summary 只保存 `secretRef`、allowed tools、expiry，不保存 raw credential。
4. 檢查所有 tool call 透過 `tool_proxy_call` 記錄，且 handler raw result 不直接回到 hand sandbox。
5. 確認 proxy result、`workflow_history` event、runtime resource payload/summary 都不包含 raw credential。
6. 若發現 credential 出現在 event 或 resource，停止該 run 的外部 tool dispatch，rotate 對應 credential，並保留污染 row 作為 incident evidence。

## 6. fan-in and completion

1. fan-in task 只能讀 accepted artifact refs、selected event slices、context packet references，不讀完整上游 transcript。
2. task completion 必須由 artifact gate 與 end-state evaluator 決定。
3. Tork/executor/hand terminal status 只代表外部執行結束，不可直接完成 workflow run。
4. 若 evaluator 顯示 incomplete，建立 recovery decision 或 follow-up task，不要手動把 run 標成 completed。

## 7. 常用 Postgres 檢查

```sql
select resource_type, resource_key, status, run_id, task_id, session_id, summary_json
from southstar.runtime_resources
where run_id = $1
order by created_at, resource_type, resource_key;
```

```sql
select sequence, event_type, actor_type, task_id, session_id, payload_json
from southstar.workflow_history
where run_id = $1
order by sequence;
```

```sql
select id, resource_id, provider, key_id, metadata_json
from southstar.secure_blobs
where resource_id = $1;
```

## 8. 驗證指令

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres:10
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres:11
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres:12
```

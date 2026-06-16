# Southstar Runtime Hardening Real E2E — create-goal Prompt + 量化驗收標準

## 建議 create-goal objective（可直接貼到 `create_goal.objective`）

```text
在 worktree 分支 feat/runtime-7x24-hardening 完成 Southstar runtime 7x24 + 多任務併發 hardening 的 Real E2E 驗收：
1) 建立並通過 runtime-hardening real E2E 案例（auto reconcile loop、10 runs/50 tasks concurrency、24h soak opt-in）；
2) 嚴格使用真實 Docker/Tork 與 Southstar runtime API，不可 fake/mock/smoke-only shortcut；
3) host adapter 使用 Pi（planner/harness 走 Pi SDK 或 Pi HTTP endpoint）；
4) 以量化 gates 驗收（reconcile p95<30s、executor bypass=0、scenario 結束 active Tork jobs=0、無 SQLITE_BUSY 未恢復證據）；
5) 產出 SQLite 可追蹤 evidence（executor_binding、executor_reconcile_result、executor_job_command、workflow_history）。
```

## 量化驗收標準（硬門檻）

### A. Auto Reconcile Loop（runtime-hardening-auto-reconcile-real）
- `workflow_history.executor.heartbeat >= 3`
- `executor_reconcile_result.classification=orphaned >= 1`
- `executor_job_command` 至少有一次 `action=cancel-executor`（executed 或 failed 都算已嘗試）
- `executor_job_command(status=executed, action=alert-operator) >= 1`
- orphan reconcile latency `<= 30_000ms`
- `task.completed.from_executor_status == 0`
- scenario 後 active Southstar Tork jobs `== 0`

### B. 併發（runtime-hardening-concurrency-real）
- 併發 runs `== 10`（可用 env 覆寫但預設必須是 10）
- 總 workflow tasks `>= 50`
- heartbeat 總數 `>= 30`
- 執行過的 `executor_job_command >= 10`
- reconcile latency p95 `< 30_000ms`
- `task.completed.from_executor_status == 0`
- workflow_history 不得出現 `SQLITE_BUSY` / `database is locked` 未恢復證據
- scenario 後 active Southstar Tork jobs `== 0`

### C. Soak（runtime-hardening-soak-real，opt-in）
- 預設 24h (`SOUTHSTAR_HARDENING_SOAK_DURATION_MS`)
- cycle 數量 `>= SOUTHSTAR_HARDENING_SOAK_MIN_CYCLES`
- soak reconcile latency p95 `< 30_000ms`
- workflow_history 不得出現 `SQLITE_BUSY` / `database is locked` 未恢復證據
- scenario 後 active Southstar Tork jobs `== 0`

## 執行命令

```bash
# 只跑 runtime hardening 新增案例（不重跑既有 full real suite）
SOUTHSTAR_DB=/tmp/southstar-runtime-hardening-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real:hardening
```

### Soak 開啟（24h）

```bash
SOUTHSTAR_HARDENING_SOAK=1 \
SOUTHSTAR_HARDENING_SOAK_DURATION_MS=$((24*60*60*1000)) \
SOUTHSTAR_HARDENING_SOAK_INTERVAL_MS=30000 \
SOUTHSTAR_HARDENING_SOAK_MIN_CYCLES=10 \
SOUTHSTAR_DB=/tmp/southstar-runtime-hardening-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real:hardening
```

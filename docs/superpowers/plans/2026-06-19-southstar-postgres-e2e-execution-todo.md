# Southstar Postgres E2E 執行 Todo（可依表執行）

日期：2026-06-19  
範圍：`tests/e2e-postgres/cases/00..09`（非 UI）

## 執行規則

1. 一次只跑一個 case（不要整包串跑）。
2. 先跑 `00 -> 01 -> 02` 基礎，再跑 `03..09` 生命周期。
3. 需要真實 infra；缺少 env 要 fail-closed。
4. `npm run test:e2e:postgres` 只跑 static manifest，不會跑真案例。

## 必要環境

```bash
export SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
export TORK_BASE_URL=http://127.0.0.1:8000
export SOUTHSTAR_CALLBACK_HOST=172.17.0.1
# Pi OAuth 模式（沿用 ~/.pi/agent 掛載），不走 mock
```

## 可執行 Todo 表

| Todo | Case | 測試目的 | 核心內容 | 目前進度 | 最新結果 | 已做修復 | 驗證命令 |
|---|---|---|---|---|---|---|---|
| [x] | 00 infra preflight | 驗證 Postgres/Tork/Pi 可達 | schema init + endpoint probe | 已完成 | ✅ PASS（本輪實跑） | 無 | `npm run test:e2e:postgres:00` |
| [x] | 01 db schema init | 驗證 `db:init` 與 schema 約束 | 未初始化 DB 應拒絕；禁止表不存在 | 已完成 | ✅ PASS（本輪實跑） | 修正錯誤 import 路徑：`../../src` -> `../../../src` | `npm run test:e2e:postgres:01` |
| [x] | 02 runtime API contract | 驗證 planner/run/read-model/envelope API | `/planner/drafts`、`/runs`、`/read-models/run-inspection`、envelope | 已完成 | ✅ PASS（本輪實跑） | 修正 read-model 斷言：`resources` 改為 `counts.resources` | `npm run test:e2e:postgres:02` |
| [x] | 03 normal software run | 驗證完整正常流（Tork/Pi/callback） | run execute -> callback -> artifact accepted -> run passed | 已完成 | ✅ PASS（本輪實跑） | 先前已修：materialization mount + Pi OAuth runtime env | `npm run test:e2e:postgres:03` |
| [x] | 04 artifact repair/recovery | 驗證失敗回調後可 recovery 重試成功 | 先 callback fail，再 `/runs/:id/recovery/dispatch` | 已完成 | ✅ PASS（本輪實跑） | 改走新 recovery API；移除 fail callback 固定 `attemptId` 以對齊 binding 生成 | `npm run test:e2e:postgres:04` |
| [x] | 05 session recovery | 驗證 session checkpoint + 新 root session rerun | callback fail(session_lost) -> recovery -> checkpoint/evidence | 已完成 | ✅ PASS（本輪實跑） | 改走新 recovery API；移除固定 `attemptId` | `npm run test:e2e:postgres:05` |
| [x] | 06 executor reconcile | 驗證 lost binding reconcile 不汙染 run/task lifecycle | 建立 binding -> `/executor/reconcile` -> lost/actions/history | 已完成 | ✅ PASS（本輪實跑） | 新增 `POST /api/v2/executor/bindings`，case 改走 API | `npm run test:e2e:postgres:06` |
| [x] | 07 evolution learning | 驗證 signals/cards/deltas/wiki/read-model lineage | evolution APIs + wiki link + center counts | 已完成 | ✅ PASS（本輪實跑） | draft/run 建立改走 `/api/v2/planner/drafts` + `/api/v2/runs` | `npm run test:e2e:postgres:07` |
| [x] | 08 evolution sandbox baseline/candidate | 驗證 sandbox baseline/candidate 真實執行與決策 | 建立 experiment -> baseline/candidate execute -> trial -> decision | 已完成 | ✅ PASS（本輪實跑） | case 改為 API-first（含 experiments start/evaluator-output）；sandbox runtime 對齊 materialization mount + Pi OAuth env；修復 Tork mount allowlist（workspace mount 改為 runRoot 可允許來源） | `npm run test:e2e:postgres:08` |
| [x] | 09 regression rollback | 驗證 regression monitor rollback/alert policy | observation -> monitor -> rollback/alert -> acknowledge | 已完成 | ✅ PASS（本輪實跑） | 改走新 regression APIs（observations + monitor run） | `npm run test:e2e:postgres:09` |

## 靜態邊界驗證（每次都要跑）

| Todo | 項目 | 命令 | 預期 |
|---|---|---|---|
| [x] | Postgres real E2E manifest/static gates | `npm run test:e2e:postgres` | PASS（僅 static，不跑真案例） |

## 08 修復完成紀錄

| 子項 | 結果 |
|---|---|
| API-first 改造 | ✅ 已完成：使用 `/api/v2/evolution/deltas/:id/run-sandbox`、`/api/v2/evolution/experiments/:id/start`、`/api/v2/evolution/experiments/:id/evaluator-output` |
| runtime 對齊 | ✅ 已完成：sandbox dispatch 對齊 materialization mount + Pi OAuth env 注入 |
| 根因修復 | ✅ 已完成：修正 Tork 拒絕 mount（`src bind mount is not allowed`），workspace mount 來源改為允許的 `runRoot` |
| 回歸 | ✅ 已完成：`08` PASS、`09` PASS |

## 建議執行順序（copy 可用）

```bash
npm run test:e2e:postgres:00
npm run test:e2e:postgres:01
npm run test:e2e:postgres:02
npm run test:e2e:postgres:03
npm run test:e2e:postgres:04
npm run test:e2e:postgres:05
npm run test:e2e:postgres:06
npm run test:e2e:postgres:07
npm run test:e2e:postgres:08
npm run test:e2e:postgres:09
npm run test:e2e:postgres
```

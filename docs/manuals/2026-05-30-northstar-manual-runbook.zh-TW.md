# Northstar 手動執行操作手冊

日期：2026-05-30

本手冊說明目前 Northstar 專案如何由使用者手動執行、驗證，以及如何理解 workflow / role / stage / root session 的綁定關係。

## 目前可手動執行的層級

目前分成三種可操作層級：

1. 離線驗證：不需要 GitHub token、不需要 Codex/OpenCode credentials、不需要網路。
2. 真實 production-live E2E：會真的建立 GitHub issue、啟動 Codex/OpenCode SDK worker、建立 PR、merge PR、關閉 issue。
3. CLI/watch production path：一般 `northstar` CLI/watch 預設 factory 會直接建立真實 GitHub gateway、Git/worktree adapter、Codex/OpenCode SDK worker，並透過 `DomainDriverRegistry` resolve domain driver。

換句話說：你可以用 `npm run test:e2e:production-live` 跑受控 sandbox live E2E；也可以在 consumer repo 放一份 `.northstar.yaml`，用 `northstar watch` 自動接手帶有 `northstar:ready` label 的 GitHub issue。

## 前置需求

請先確認 Node 版本：

```bash
node --version
```

需要 Node.js `>=22.22.2`。

安裝 dependency：

```bash
npm install
```

確認 CLI 可執行：

```bash
node --run northstar -- --help
node --run northstar -- --version
```

## GitHub 與 SDK credentials

真實 live E2E 需要 GitHub access：

```bash
gh auth status
gh auth token
```

執行 live E2E 時不要把 token 寫進 repo。建議在 shell 裡用：

```bash
export GITHUB_TOKEN="$(gh auth token)"
export NORTHSTAR_LIVE_GITHUB_REPO="paulpai0412/northstar-live-sandbox"
```

Codex / OpenCode SDK credentials 使用本機 credential store 或 SDK 自己支援的環境設定。不要寫入 `.northstar.yaml`、docs、tests、logs 或 SQLite history。

## Workflow 與 role 綁定

目前主要 software development workflow 在：

```text
tests/fixtures/workflows/issue-to-pr-release.yaml
```

目前 workflow：

```yaml
workflow:
  id: issue_to_pr_release
  domain: software_development
```

`domain: software_development` 會透過 `DomainDriverRegistry` resolve 到 production `SoftwareDevDomainDriver`。如果 workflow id 是 `issue_to_pr_release`，目前也保留 fallback 到 software-dev driver。

Role 定義：

```yaml
roles:
  issue_worker:
    run_mode: background_child
    agent: build
    model: gpt-5

  pr_verifier:
    run_mode: background_child
    agent: review
    model: gpt-5

  release_worker:
    run_mode: background_child
    agent: release
    model: gpt-5
```

Stage 綁定：

```yaml
stages:
  implementation:
    lifecycle_state: running
    role: issue_worker
    on_success: verification

  verification:
    lifecycle_state: verifying
    role: pr_verifier
    on_pass: verified

  release:
    lifecycle_state: release_pending
    role: release_worker
    on_success: completed
```

意思是：

- `implementation` stage 使用 `issue_worker`
- `verification` stage 使用 `pr_verifier`
- `release` stage 使用 `release_worker`

目前 config 要求：

```yaml
runtime:
  session_scope: stage_root
```

所以可以理解為：每個 stage 會建立自己的 root session，該 stage 的 background child run 掛在該 root session 底下。不是整個 issue 共用同一個 root session。

## 建立本機 config

根目錄目前不一定有 `.northstar.yaml`。如要測 CLI config loading，可先複製 fixture：

```bash
cp tests/fixtures/.northstar.yaml .northstar.yaml
```

再修改：

```yaml
project:
  name: northstar-live-sandbox
  root: /absolute/path/to/your/consumer/project

runtime:
  db_path: .northstar/runtime/control-plane.sqlite3
  host_adapter: codex
  development_capacity: 1
  release_capacity: 1
  heartbeat_interval_seconds: 30
  lease_timeout_seconds: 180
  child_timeout_seconds: 7200
  auto_release: false
  session_scope: stage_root

workflow:
  package: northstar/workflows/issue-to-pr-release
  id: issue_to_pr_release
  version: "1.0"

github:
  repo: paulpai0412/northstar-live-sandbox
  intake:
    enabled: true
    label: northstar:ready
  sync:
    enabled: true
    retry_backoff_seconds:
      - 30
      - 120
      - 600

git:
  base_branch: main
  worktrees_dir: .northstar/runtime/worktrees
  sync_worktree_dir: .northstar/runtime/sync-worktrees/main
```

本機 repo readiness 的產品語意：Northstar 不會在 consumer root 執行 `git checkout main` 或 `git switch main`。consumer root 是 operator 的工作目錄，可能在 auto-release 後顯示 `main...origin/main [behind N]`；這不是 lifecycle failure。需要機器可讀的最新 `main` 時，應使用 `.northstar/runtime/sync-worktrees/main` 作為安全同步 worktree，避免和 issue worktrees 或 operator shell 搶同一個 checkout。

建議加上 credentials 設定，讓 CLI/watch 可從環境或 `gh auth token` 取得 GitHub token：

```yaml
credentials:
  github:
    token_env: GITHUB_TOKEN
    allow_gh_token_fallback: true
  host_sdk:
    codex:
      mode: sdk_default
    opencode:
      mode: sdk_default
```

若 `workflow.path` 有設定且是相對路徑，會以 `project.root` 作為基準。若未設定，`issue_to_pr_release` 會使用 Northstar package 內建 workflow，不依賴你目前 shell 的 cwd。

## 離線驗證

先跑不依賴 live credentials 的測試：

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
```

預期：

- 不需要 GitHub token
- 不需要 Codex/OpenCode credentials
- 不需要網路
- 不會真的建立 GitHub issue 或 PR

## 真實 production-live E2E

這是目前建議你手動跑完整 live workflow 的方式。

先確認未設 live flag 時會 clear skip：

```bash
npm run test:e2e:production-live
```

預期結果：

- 測試被 skip
- 訊息提示設定 `NORTHSTAR_PRODUCTION_LIVE=1`

接著執行真實 live：

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCTION_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
npm run test:e2e:production-live
```

這個指令會真的執行：

1. 建立 OpenCode-backed GitHub issue
2. 透過 production registry / production factory / SoftwareDevDomainDriver 執行 implementation
3. 啟動 OpenCode SDK worker
4. 建立 branch
5. 建立 PR
6. 啟動 verifier worker
7. merge PR
8. confirmed merge fact
9. runtime lifecycle 進入 `completed`
10. 關閉 GitHub issue
11. 再跑一次 Codex-backed flow

預期量化結果：

```text
production_live_issues_created=2
production_live_opencode_runs_completed=1
production_live_codex_runs_completed=1
production_live_prs_created=2
production_live_prs_merged=2
production_live_completed=2
production_live_confirmed_merge_facts=2
production_live_github_issues_closed=2
production_live_secret_leaks=0
production_live_shell_fallbacks=0
```

## 手動建立 issue 後跑 live E2E

若你想先自己在 GitHub 建 issue：

```bash
gh issue create \
  --repo paulpai0412/northstar-live-sandbox \
  --title "northstar manual smoke issue" \
  --body "請建立一個 northstar manual smoke fixture file" \
  --label "northstar:ready"
```

一般 `northstar watch` 會掃描 configured GitHub repo 內 open 且帶有 `northstar:ready` label 的 issue。若 issue 有 `Depends-On` / `Blocked-By` 文字標記，或 GitHub linked issue 關係，Northstar 會合併 dependency 資訊並依 dependency order dispatch。

## CLI 手動指令

CLI help：

```bash
node --run northstar -- --help
```

支援指令：

```text
northstar init
northstar intake
northstar start
northstar reconcile
northstar reconcile-workspace
northstar heartbeat
northstar release
northstar repair-runtime
northstar inspect
northstar retry-sync
northstar watch
```

Dry-run / dispatch 類測試：

```bash
node --run northstar -- inspect --issue 101 --config .northstar.yaml --dry-run
node --run northstar -- start --issue 101 --config .northstar.yaml --dry-run
```

非 dry-run 的 manual flow 形狀如下：

```bash
node --run northstar -- intake --issue 101 --title "Issue 101" --body "..." --config .northstar.yaml
node --run northstar -- start --issue 101 --config .northstar.yaml
node --run northstar -- reconcile --issue 101 --config .northstar.yaml
node --run northstar -- release --issue 101 --config .northstar.yaml
node --run northstar -- inspect --issue 101 --config .northstar.yaml
```

非 dry-run 會使用 `.northstar.yaml` 的真實 dependencies。必要條件：

- `github.repo` 指向目標 consumer repo，例如 `owner/repo`
- `project.root` 是該 consumer repo 的本機絕對路徑
- `GITHUB_TOKEN` 已設定，或 `credentials.github.allow_gh_token_fallback: true` 且 `gh auth token` 可用
- Codex/OpenCode SDK credentials 已由本機 credential store 或 SDK 支援的 env 設定完成

## Watch daemon

查看 watch help：

```bash
node --run northstar -- watch --help
```

基本形狀：

```bash
node --run northstar -- watch --config .northstar.yaml --interval-ms 1000 --max-cycles 5
```

Watch 會：

1. load `.northstar.yaml`
2. 開啟 `.northstar/runtime/control-plane.sqlite3`
3. 從 SQLite reconstruct active issues / leases / recent history
4. 透過 production factory 建立 orchestrator
5. 掃描 configured GitHub repo 中 open 且帶有 `northstar:ready` label 的 issue
6. 合併 native linked issue dependency 與文字 dependency marker
7. 依 capacity / dependency scheduling 執行 cycle
8. 建立或重用 issue worktree、branch、PR
9. 同步 GitHub issue label、progress comment、status marker、PR verifier comment、Project 欄位

中斷續行時，watch/CLI restart 後會從 SQLite snapshot 與 GitHub/Git 狀態重建流程，重用既有 worktree、branch、PR，不應建立 duplicate PR。

## State lifecycle

目前 runtime core 支援的 lifecycle states：

```text
ready
claimed
running
verifying
verified
release_pending
completed
failed
quarantined
```

一般 issue-to-PR-release happy path：

```text
ready
-> claimed
-> running
-> verifying
-> verified
-> release_pending
-> completed
```

異常流程：

```text
running/verifying/release_pending
-> quarantined
-> resume with valid lease
-> running/verifying/release_pending
```

Terminal failure：

```text
running/verifying/release_pending
-> failed
```

## 如何確認沒有 secrets 或 shell fallback

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
```

預期都是沒有輸出。

## 建議操作順序

第一次自己測時，建議順序：

1. `npm install`
2. `npm test`
3. `npm run test:e2e`
4. `npm run test:e2e:daemon`
5. `npm run test:e2e:exceptions`
6. `npm run test:coverage`
7. `node --run northstar -- --help`
8. `npm run test:e2e:production-live`
9. 設定 `GITHUB_TOKEN` / `NORTHSTAR_PRODUCTION_LIVE=1` / `NORTHSTAR_LIVE_GITHUB_REPO`
10. 跑真實 production-live E2E

## 目前限制與下一步

已完成：

- Runtime state machine
- SQLite store / engine cycle
- CLI command surface
- Host adapter boundary
- GitHub projection / Git worktree adapter tests
- DomainDriverRegistry
- Production SoftwareDevDriver
- Full production-live E2E through production registry/factory/driver
- 一般 CLI/watch 預設 factory 直接接上真實 GitHub gateway、Git adapter、Codex/OpenCode SDK worker
- watch 自動接手 `northstar:ready` GitHub issue
- native GitHub linked issue dependency discovery
- consumer repo `.northstar.yaml` configurable production run
- restart/resume 重用 worktree、branch、PR
- GitHub issue/PR/Project progress observability

尚未完全產品化：

- production OS service packaging 尚未完成，現在可用 CLI/watch process 手動啟動。
- npm publish 尚未完成，consumer repo 目前可用 local package path 或 repo checkout 執行 Northstar。
- `content_creation` domain driver 尚未實作，目前是 recognized deferred domain。
- `office_automation` domain driver 尚未實作，目前是 recognized deferred domain。

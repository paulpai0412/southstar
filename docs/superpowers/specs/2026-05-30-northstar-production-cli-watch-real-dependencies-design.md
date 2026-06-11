# Northstar Production CLI/Watch Real Dependencies Design

Date: 2026-05-30

## Purpose

Northstar currently has a production registry/factory shape and a production-live E2E path, but the general CLI/watch default factory still uses unconfigured dependency boundaries. This design turns the general CLI/watch path into a real software-development production operator for consumer repositories.

The target behavior is:

- A consumer repo needs one required config file: `.northstar.yaml`.
- `northstar watch` scans configured GitHub issues and dispatches eligible work.
- Manual CLI commands can intake/start/reconcile/release/inspect one issue.
- Production execution uses real GitHub API, real git/worktree operations, and real Codex/OpenCode SDK workers.
- Runtime state remains durable and restartable through SQLite, GitHub, and Git state reconstruction.
- GitHub issue, PR, and Project surfaces show observable execution progress.

This design does not implement `content_creation` or `office_automation` domain drivers. Those remain recognized deferred domains.

## Scope

In scope:

- Default production factory dependency wiring.
- GitHub issue discovery and intake for `northstar:ready` issues.
- Manual CLI issue intake from GitHub.
- Configurable consumer repo support.
- Role-level host adapter override.
- Real git worktree/branch/commit/push/PR/merge flow.
- GitHub issue/PR/project observability.
- Credentials provider chain.
- Restart/resume semantics.
- Offline tests with fake injected dependencies.
- Live tests against a configured sandbox repo.

Out of scope:

- Publishing `@northstar/runtime` to npm.
- Production OS service installation.
- Content creation and office automation driver implementations.

## Consumer Repo Integration

The first production version uses one required consumer repo config file:

```text
consumer-repo/
  .northstar.yaml
  .northstar/
    runtime/
      control-plane.sqlite3
      worktrees/
      sync-worktrees/main/
```

Northstar creates `.northstar/runtime` paths as needed. The user maintains only `.northstar.yaml`.

Example:

```yaml
schema_version: "1.1"

project:
  name: my-consumer-repo
  root: /home/me/apps/my-consumer-repo

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
  domain: software_development

workflow_overrides:
  roles:
    issue_worker:
      host_adapter: codex
      agent: build
      model: gpt-5
      load_skills:
        - tdd
    pr_verifier:
      host_adapter: opencode
      agent: review
      model: gpt-5
      load_skills:
        - review-work
    release_worker:
      host_adapter: codex
      agent: release
      model: gpt-5

github:
  repo: owner/my-consumer-repo
  intake:
    enabled: true
    label: northstar:ready
  sync:
    enabled: true
    retry_backoff_seconds:
      - 30
      - 120
      - 600
  project:
    enabled: false

git:
  base_branch: main
  worktrees_dir: .northstar/runtime/worktrees
  sync_worktree_dir: .northstar/runtime/sync-worktrees/main

credentials:
  github:
    token_env: GITHUB_TOKEN
    allow_gh_token_fallback: true
  host_sdk:
    codex:
      mode: sdk_default
    opencode:
      mode: sdk_default

policy:
  github_sync_blocks_lifecycle: false
  quarantine_requires_operator: true
```

The CLI must support both:

```bash
cd /home/timmypai/apps/northstar
node --run northstar -- watch --config /home/me/apps/my-consumer-repo/.northstar.yaml
```

and package/bin use from the consumer repo:

```bash
cd /home/me/apps/my-consumer-repo
npx northstar watch --config .northstar.yaml
```

Northstar must not require `process.cwd()` to be the Northstar repository. Built-in workflow resolution must be package-relative, not cwd-relative.

## Architecture

### ProductionDependencyFactory

`ProductionDependencyFactory` builds real dependencies from config:

- SQLite store under `project.root`.
- GitHub gateway for the configured `github.repo`.
- Git worktree executor using argv-array command specs.
- SDK worker factory for Codex and OpenCode.
- Host adapter bridge.
- DomainDriverRegistry.
- ProductionOrchestrator.

CLI and watch must use the same factory. There must not be a separate watch-only orchestration stack.

The existing unconfigured default production dependencies must be replaced by real dependency wiring. Configuration errors should fail fast with stable error codes and clear messages.

### GitHubIssueIntakeAdapter

`watch` uses this adapter to discover open GitHub issues.

Rules:

- Only issues with `github.intake.label`, default `northstar:ready`, are eligible.
- Issues without the ready label are ignored.
- Already-intaked issues are not duplicated.
- Manual `northstar intake --issue N` reads title/body/labels/source URL from GitHub.
- Explicit dependency markers are parsed from issue body:
  - `Depends-On: #123`
  - `Blocked-By: #123`
- Native GitHub linked issue dependency discovery is included:
  - issue timeline `connected_event`, `cross-referenced`, or equivalent linked-reference events when available
  - task-list style references in issue body such as `- [ ] #123`
  - GitHub API permission or shape failures become retryable intake warnings
- Marker and native dependency sources are merged, deduplicated, sorted, and persisted in runtime context/history.

If a dependency is not completed or is not yet known to Northstar, the issue remains deferred with an auditable reason. This is not a lifecycle failure.

### HostAdapterResolver

Host resolution uses:

1. `workflow_overrides.roles.<role>.host_adapter`
2. `runtime.host_adapter`

Supported values:

- `codex`
- `opencode`

Unknown values fail fast. There is no silent fallback.

### ProductionSoftwareDevDomainDriver

The production software-development driver manages:

- Issue worktree creation outside the consumer root worktree.
- Branch creation or reuse.
- SDK worker execution in the issue worktree.
- Full worktree commit.
- Push to origin.
- PR create or reuse.
- Verification prompt/evidence.
- PR merge on release.
- GitHub issue close after confirmed completion.

Each issue gets an isolated worktree:

```text
<project.root>/.northstar/runtime/worktrees/issue-<number>-<slug>
```

Branch naming:

```text
northstar/issue-<number>-<slug>
```

The consumer root worktree must never receive `git checkout main` or `git switch main`. Git operations run through argv arrays and use `git -C <path>` where needed.

Commit policy:

- The issue worktree is the isolation boundary.
- All changed files in the issue worktree are committed as the issue result.
- If there are no changed files, Northstar records a retryable or blocked result instead of creating an empty PR.

PR policy:

- If a PR already exists for the branch, reuse it.
- If a branch already exists, reuse/read it.
- PR metadata is persisted in runtime context/history so release can resume after restart.

### GitHubProjectAdapter

If configured, Project v2 fields are synced:

```yaml
github:
  project:
    enabled: true
    project_id: PVT_xxx
    fields:
      status: Status
      lifecycle_state: Northstar State
      owner_role: Owner Role
      host_adapter: Host Adapter
      pr_url: PR
      last_heartbeat_at: Last Heartbeat
      retry_count: Retry Count
```

Project sync is observability, not core lifecycle, unless `policy.github_sync_blocks_lifecycle` is explicitly enabled.

## Data Flow

### Watch Flow

1. Load `.northstar.yaml`.
2. Open SQLite store under `project.root`.
3. Build production dependencies through `ProductionDependencyFactory`.
4. Scan configured GitHub repo open issues.
5. Intake eligible `northstar:ready` issues.
6. Parse dependency markers and native linked issue dependencies.
7. Run scheduler:
   - completed dependencies only
   - issue number ascending
   - within `runtime.development_capacity`
8. Start or reconcile active issues.
9. Execute implementation stage through configured SDK host.
10. Create/reuse branch and PR.
11. Execute verifier stage.
12. If verifier passes, transition to `verified`.
13. If `runtime.auto_release` is true, execute release.
14. Confirm merge, close issue, transition to `completed`.

### Manual CLI Flow

```bash
northstar intake --issue 123 --config .northstar.yaml
northstar start --issue 123 --config .northstar.yaml
northstar reconcile --issue 123 --config .northstar.yaml
northstar release --issue 123 --config .northstar.yaml
northstar inspect --issue 123 --config .northstar.yaml
```

Manual CLI acts on one issue at a time. `intake --issue` fetches issue details from GitHub.

### Release Flow

`runtime.auto_release` defaults to false.

When false:

- Watch stops at `verified`.
- User runs `northstar release --issue N`.

When true:

- Watch can release automatically after verification passes.

Both paths require confirmed merge before `completed`.

## Restart And Resume Semantics

Northstar must support interruption and continuation.

### Watch Or CLI Crash

On restart:

- Load active issues from SQLite.
- Load recent history.
- Reconstruct runtime context including branch, worktree, PR, stage, lease, and last artifact metadata.

### Worker Interruption

If heartbeat expires:

- Read host status.
- If host is live, resume/reconcile through host resume hints.
- If host is missing or unknown, move to quarantine or retryable recovery according to workflow policy.

### Worktree Or Branch Already Exists

Reuse existing worktree/branch. Do not create duplicate branches for the same issue.

### PR Already Exists

Reuse existing PR by branch/head. Do not create duplicate PRs for the same issue.

### Merge Completed Before Crash

If merge is confirmed after restart:

- Transition or keep lifecycle as `completed`.
- Close issue and cleanup are retryable post-completion effects.
- Completed must not be reversed.

## Credentials

### GitHub

Credential source order:

1. Configured env var, default `GITHUB_TOKEN`.
2. If explicitly allowed, `gh auth token` through argv-array process execution.
3. Otherwise fail fast.

Stable missing credential error:

```text
GITHUB_CREDENTIAL_MISSING
```

Tokens are memory-only. They must not be written to:

- repo files
- docs
- tests
- logs
- SQLite history
- worker prompts

### Codex And OpenCode SDK

Northstar does not store SDK tokens. It imports SDK packages and relies on SDK-native credentials or local session stores.

Authentication/config errors become clear production errors:

- `CODEX_CREDENTIAL_MISSING`
- `OPENCODE_CREDENTIAL_MISSING`
- `HOST_SDK_CONFIG_INVALID`

Northstar must not shell out to `codex` or `opencode` CLIs.

### Git

Git push uses the user machine's existing git credential helper, SSH agent, or GitHub auth setup.

Auth failures are redacted and recorded as retryable effects, not direct lifecycle failure.

## GitHub Observability

GitHub observability is part of production operation.

### Issue Labels

Northstar syncs state labels:

- `northstar:ready`
- `northstar:claimed`
- `northstar:running`
- `northstar:verifying`
- `northstar:verified`
- `northstar:release-pending`
- `northstar:completed`
- `northstar:quarantined`
- `northstar:failed`

### Issue Comments

Northstar writes progress comments for:

- Intake accepted.
- Stage start.
- Implementation result with branch/commit/PR URL.
- Verification result.
- Release result with merge SHA.
- Quarantine/failure reason and operator action.

### Issue Body Status Marker

Northstar may update a bounded marker:

```text
<!-- northstar-status -->
...
<!-- /northstar-status -->
```

The marker must not overwrite the user-authored issue body.

### PR Observability

PR body includes:

- source issue URL
- workflow id/domain
- role and host summary
- changed files summary
- verifier evidence summary

PR comments include verifier pass/fail evidence and release result.

### Projection Failure Semantics

Projection failures produce retryable projection events. By default they do not mutate lifecycle and do not block core progress.

## Error Handling

### Config Invalid

Fail fast. Do not write lifecycle failure.

Examples:

- Missing required repo.
- Unknown host adapter.
- Missing GitHub credential.
- Invalid project config.

### GitHub Transient Failure

Record retryable projection/effect history. Do not directly mark issue failed.

### Git Or Worktree Failure

Rules:

- Branch exists: reuse/read.
- Worktree exists: reuse if it matches the issue.
- No changes: retryable/blocked result, no empty PR.
- Commit/push failure: retryable effect.

### SDK Worker Failure

Timeout, empty response, malformed response, or SDK auth/config failure are classified by type:

- credential/config: fail fast for command setup
- transient SDK failure: retryable
- malformed artifact: retryable until retry policy exhausted
- retry policy exhausted: workflow policy decides quarantine or failed

### Verifier Failure

Verifier explicit fail follows workflow `on_fail_retryable` or `on_fail_terminal`.

### Release Safety

Release requires PR metadata. Merge success without confirmed merge SHA cannot complete.

Confirmed merge cannot be reversed by later cleanup or issue-close failure.

## Testing Strategy

### Offline Unit And Integration

Run through `npm test`.

Coverage:

- Real dependency factory composition with fake process/GitHub/SDK dependencies.
- Config schema for credentials and project settings.
- Host adapter default and role override.
- Ready-label issue discovery.
- Dependency marker parsing.
- Native linked issue dependency discovery and retryable API failure behavior.
- Worktree command generation through argv arrays.
- No root checkout/switch.
- Secret redaction.
- Resume reconstruction.
- Observability projection events.

### Offline E2E

Run through existing E2E commands or a new production CLI/watch E2E command.

Coverage:

- Complete issue to completed flow using temp git repo and fake GitHub/SDK dependencies.
- Restart/resume after worktree created.
- Restart/resume after PR created.
- Restart/resume after merge confirmed.
- Duplicate PR prevention.

### Live E2E

Run only when explicitly enabled:

```bash
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_PRODUCTION_LIVE=1 \
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox \
npm run test:e2e:production-live
```

Live E2E must use:

- real GitHub issue
- real configured repo
- real local worktree
- real Codex/OpenCode SDK
- real commit/push
- real PR
- real merge
- real issue close

The sandbox repo must not be hardcoded in production source.

## Quantitative Acceptance

Required metrics:

```text
production_cli_real_dependency_factory = 1
production_watch_real_dependency_factory = 1
production_default_unconfigured_dependencies = 0
consumer_repo_configurable = 1
sandbox_repo_hardcoded_in_src = 0
consumer_project_root_configurable = 1
production_live_runs_against_configured_repo = 1
consumer_config_abs_path_supported = 1
consumer_repo_local_package_cli_supported = 1
northstar_cwd_not_required_for_consumer_run = 1
runtime_state_written_under_consumer_root = 1
builtin_workflow_resolves_package_relative = 1
github_ready_issues_discovered >= 2
github_non_ready_issues_ignored >= 1
dependency_blocked_dispatches >= 1
dependency_order_violations = 0
native_linked_issue_dependencies_discovered >= 1
native_linked_issue_dependencies_merged_with_markers >= 1
native_linked_issue_dependency_duplicates_removed >= 1
native_linked_issue_api_failure_retryable >= 1
native_linked_issue_api_failure_does_not_fail_lifecycle = 1
role_host_default_resolutions >= 1
role_host_override_resolutions >= 1
github_token_env_used = 1
github_gh_token_fallback_used >= 1
github_missing_credential_fails_fast = 1
sdk_credentials_not_written_to_history = 1
worker_prompts_contain_secret_tokens = 0
git_auth_failure_retryable = 1
worktrees_created >= 1
worktree_reuse_cases >= 1
branches_pushed >= 1
prs_created >= 1
prs_reused >= 1
confirmed_merges >= 1
github_issues_closed >= 1
resume_after_watch_restart_completed >= 1
resume_reuses_existing_worktree = 1
resume_reuses_existing_branch = 1
resume_reuses_existing_pr = 1
resume_duplicate_prs_created = 0
resume_completed_reversals = 0
github_issue_state_labels_synced >= 1
github_issue_progress_comments_created >= 3
github_issue_status_marker_updated >= 1
github_pr_body_contains_source_issue = 1
github_pr_verifier_comment_created >= 1
github_project_lifecycle_field_synced >= 1
github_project_pr_url_field_synced >= 1
github_projection_failures_retryable >= 1
github_projection_failures_do_not_mutate_lifecycle = 1
production_secret_leaks = 0
observability_secret_leaks = 0
production_shell_chain_commands = 0
```

## Final Verification Gate

Implementation must run:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
npm run test:e2e:production-live
GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live
node --run northstar -- --help
node --run northstar -- watch --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "paulpai0412/northstar-live-sandbox" src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
git status --short
```

`npm test`, offline E2E, daemon E2E, exception E2E, and coverage must not require GitHub token, network, Codex credentials, OpenCode credentials, or host CLIs.

## Deferred Work

- Production OS service packaging.
- npm package publishing.
- `content_creation` production domain driver.
- `office_automation` production domain driver.

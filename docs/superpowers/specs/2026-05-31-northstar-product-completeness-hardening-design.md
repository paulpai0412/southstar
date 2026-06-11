# Northstar Product Completeness Hardening Design

Date: 2026-05-31

## 1. Purpose

This design turns the Vocabulary UAT findings into a product-completeness hardening roadmap for Northstar.

The goal is to make Northstar reliable enough for long-running unattended software-development automation and usable enough that an operator can move from a brainstorming spec and writing-plans implementation plan into executable GitHub issues without manually assembling labels, Project fields, dependencies, configuration, and watch commands.

This design is split into two implementation versions:

- **V1: Long-Running Reliability And Real Project Observability**
- **V2: Product UX, Spec-To-Issues Intake, And Rich Execution Evidence**

V1 must be implemented first. V2 depends on V1's reliability guarantees.

## 2. Background

The Vocabulary UAT proved that Northstar can run a real software-development workflow:

```text
GitHub issue -> northstar:ready -> watch intake -> local worktree -> SDK worker
-> commit/push -> PR -> verifier -> merge -> close issue -> runtime completed
```

The final clean validation completed five dependency-ordered issues after Northstar commit `87f7ef6`, plus one recovery issue for a consumer test configuration defect.

The UAT also exposed product gaps:

1. Stale watch locks can block future watch runs.
2. PR merge conflicts need first-class recovery.
3. Completed worktrees accumulate without policy.
4. Real parallel execution needs `development_capacity=2` validation.
5. GitHub Project viewer status can drift from runtime lifecycle because Project field sync is incomplete.
6. SDK worker outputs need structured artifacts, not only natural-language summaries.
7. Consumer setup still requires too much operator knowledge.
8. Native GitHub dependency discovery must be merged with marker dependencies.
9. Brainstorming specs and implementation plans need a product path into executable GitHub issues.

## 3. Goals

### V1 Goals

- Recover stale watch locks safely.
- Detect and recover PR merge conflicts without terminally failing issues.
- Apply a durable completed-worktree cleanup policy.
- Prove true parallel production execution with `development_capacity=2`.
- Implement real GitHub Project v2 field sync for both precise runtime lifecycle and viewer-friendly status.
- Validate the full path with a real live E2E run: real GitHub issues, Project, SDK worker, local worktrees, PRs, merges, issue closes, and browser tests.

### V2 Goals

- Convert brainstorming design specs and writing-plans implementation plans into executable GitHub issues.
- Provide a Northstar skill operator flow for setup, issue planning, running, status, and recovery.
- Require structured worker/verifier/release artifacts.
- Discover dependencies from marker syntax and native GitHub relationships.
- Improve inspect/status output and GitHub issue/PR observability.

## 4. Non-Goals

- Publishing Northstar to npm.
- OS service packaging for systemd, launchd, or Windows Service.
- Implementing `content_creation` or `office_automation` domain drivers.
- Replacing Superpowers brainstorming or writing-plans. Northstar consumes their outputs; it does not replace them.
- Storing secrets in repo files, GitHub issues, Project fields, PR comments, runtime logs, SQLite history, or worker prompts.

## 5. Shared Constraints

- Runtime state-machine remains pure: no filesystem, SQLite, GitHub, host SDK, shell, or process access.
- External commands use argv arrays, not shell-chain strings.
- Offline tests must not require network, GitHub credentials, SDK credentials, or host CLIs.
- Live E2E tests are separate from unit/offline tests.
- Projection failures are retryable observability failures by default; they do not directly mutate lifecycle.
- Production source must not hardcode sandbox repositories or user-specific paths.
- All generated issue bodies, Project fields, PR comments, logs, and SQLite payloads must pass secret redaction checks.

## 6. V1 Architecture

### 6.1 Stale Watch Lock Recovery

Current behavior can leave `watch.lock` behind after an interrupted watch process. A later watch run then exits with `writer_lock_unavailable`.

The lock file becomes a structured JSON record:

```json
{
  "pid": 12345,
  "started_at": "2026-05-31T10:00:00.000Z",
  "heartbeat_at": "2026-05-31T10:01:00.000Z",
  "project_root": "/consumer/repo",
  "config_path": "/consumer/repo/.northstar.yaml",
  "host": "hostname"
}
```

Watch updates `heartbeat_at` once per cycle.

On startup, if a lock exists:

- PID is absent or not running: reclaim.
- PID exists but heartbeat age exceeds `runtime.watch_lock_stale_seconds`: reclaim.
- PID exists and heartbeat is fresh: reject with `writer_lock_unavailable`.
- Project root or config path mismatch: reject unless explicit recovery command is used.

Every reclaim writes an admin recovery event with stale reason, old PID, old heartbeat, and new PID.

Acceptance metrics:

- `stale_watch_locks_detected >= 1`
- `stale_watch_locks_reclaimed >= 1`
- `fresh_watch_locks_rejected >= 1`
- `duplicate_watch_writers = 0`

### 6.2 Merge Conflict Auto-Recovery

PR merge conflicts must be retryable workflow recovery, not permanent `release_pending` stalls.

The GitHub software-development gateway exposes stable release error codes:

- `PR_MERGE_CONFLICT`
- `PR_NOT_MERGEABLE_YET`
- `PR_MERGE_PERMISSION_DENIED`
- `PR_MERGE_UNKNOWN_FAILURE`

When release receives `PR_MERGE_CONFLICT`:

1. Record compact retryable recovery history.
2. Keep or move lifecycle into a recoverable implementation state, not terminal `failed`.
3. Fetch latest `origin/<base_branch>`.
4. Reuse or recreate the issue worktree from latest base.
5. Re-run the implementation worker with conflict recovery context.
6. Push a new commit to the existing issue branch when possible.
7. Reuse the existing PR rather than opening duplicates.
8. Re-run verifier and release.

Recovery is capped by `runtime.max_recovery_attempts`. Exceeding the cap quarantines the issue with a clear operator action.

Acceptance metrics:

- `merge_conflicts_detected >= 1`
- `merge_conflict_recovery_attempts >= 1`
- `merge_conflict_recovered_prs_merged >= 1`
- `merge_conflict_terminal_failures = 0`
- `resume_duplicate_prs_created = 0`
- `completed_reversals = 0`

### 6.3 Completed Worktree Cleanup Policy

Completed worktrees should not accumulate indefinitely.

Config:

```yaml
cleanup:
  completed_worktrees: archive # archive | delete | keep
  keep_last: 5
  failed_or_quarantined: keep # keep | archive
```

Rules:

- Cleanup runs only after confirmed completion.
- Cleanup is a post-completion effect.
- Cleanup failure records retryable cleanup history and never reverses `completed`.
- Archive path: `.northstar/runtime/archive/worktrees/<issue-slug>-<timestamp>`.
- Delete is allowed only for managed paths under configured `git.worktrees_dir`.

Acceptance metrics:

- `completed_worktree_cleanup_attempts >= 1`
- `completed_worktrees_archived_or_deleted >= 1`
- `cleanup_failures_retryable >= 1`
- `cleanup_completed_reversals = 0`

### 6.4 Capacity=2 Parallel Production Validation

The production scheduler must support real parallel issue execution.

Live graph:

```text
#A foundation
  -> #B parallel feature
  -> #C parallel feature
#B + #C
  -> #D integration
#D
  -> #E final browser UAT
```

Config sets `runtime.development_capacity: 2`.

Expected behavior:

- #A runs first.
- After #A completes, #B and #C can both become active in the same execution window.
- #B and #C use distinct worktrees, branches, root sessions, child runs, and PRs.
- Release may remain serialized to avoid merge races.
- No dependency order violations are allowed.

Acceptance metrics:

- `parallel_ready_siblings >= 2`
- `parallel_active_issue_workers >= 2`
- `parallel_overlap_seconds >= 1`
- `parallel_duplicate_prs_created = 0`
- `parallel_cross_issue_contamination = 0`
- `parallel_merge_conflicts_unrecovered = 0`
- `dependency_order_violations = 0`

### 6.5 GitHub Project Viewer Status Real Sync

Northstar must update GitHub Project viewer fields to match real runtime state.

Two fields are updated:

- `Northstar Lifecycle`: exact runtime lifecycle.
- `Status`: viewer-friendly status.

Mapping:

| Runtime lifecycle | Northstar Lifecycle | Status |
| --- | --- | --- |
| `ready` | `ready` | `Todo` |
| `running` | `running` | `In Progress` |
| `verifying` | `verifying` | `In Review` |
| `verified` | `verified` | `Ready to Release` |
| `release_pending` | `release_pending` | `Releasing` |
| `completed` | `completed` | `Done` |
| `failed` | `failed` | `Failed` |
| `quarantined` | `quarantined` | `Blocked` |

Additional fields:

- `PR URL`
- `Merge SHA`
- `Current Stage`
- `Last Error`
- `Retry Count`
- `Blocked By`

Implementation:

- Replace stubbed Project sync with real GitHub Project v2 GraphQL operations.
- Discover project item id from issue content id.
- Discover field ids and single-select option ids at runtime.
- Cache discovery in memory per process.
- Do not hardcode Project #28, field ids, option ids, or sandbox repo.
- If fields are missing, production sync records a retryable projection failure. Setup/doctor reports missing fields and can create them only after explicit user confirmation.

Sync points:

- Intake: `ready` / `Todo`
- Start implementation: `running` / `In Progress`
- Verification: `verifying` / `In Review`
- Verified: `verified` / `Ready to Release`
- Release started: `release_pending` / `Releasing`
- Confirmed merge: `completed` / `Done`, plus PR URL and merge SHA
- Quarantine/failed: `Blocked` or `Failed`, plus last error

Acceptance metrics:

- `github_project_items_synced >= 5`
- `github_project_lifecycle_completed >= 5`
- `github_project_status_done >= 5`
- `github_project_pr_urls_synced >= 5`
- `github_project_merge_shas_synced >= 5`
- `github_project_status_mismatches = 0`
- `github_projection_failures_retryable >= 1`
- `github_projection_failures_do_not_mutate_lifecycle = 1`

## 7. V1 Live E2E Gate

V1 is complete only after a real production E2E run passes.

Required live path:

- Real GitHub repo.
- Real GitHub Project.
- Real Project field sync.
- Real GitHub issues.
- Real production watch.
- Real SDK worker.
- Real local worktrees.
- Real PR create/reuse.
- Real merge.
- Real issue close.
- Real browser test evidence.

Required metrics:

- `live_issues_created >= 5`
- `live_completed_issues >= 5`
- `live_prs_merged >= 5`
- `live_project_lifecycle_completed >= 5`
- `live_project_status_done >= 5`
- `live_parallel_active_issue_workers >= 2`
- `live_browser_tests_passed >= 1`
- `live_secret_leaks = 0`
- `live_smoke_only = 0`
- `fake_production_path_used = 0`

## 8. V2 Architecture

### 8.1 Spec-To-Issues Execution Intake

Northstar skill gains a first-class intake flow that turns validated Superpowers outputs into executable GitHub issues.

Inputs:

- Design spec path.
- Implementation plan path.
- Target GitHub repo.
- Optional Project id.
- Mode: `dry-run` or `apply`.

Default mode is `dry-run`. `apply` requires explicit confirmation.

The generated issue set includes:

- title
- objective
- source documents
- scope
- acceptance criteria
- quantitative metrics
- required tests
- dependencies
- Northstar execution notes

Issue body template:

```md
## Objective

## Source Documents
- Spec:
- Implementation Plan:

## Scope

## Acceptance Criteria

## Quantitative Metrics

## Required Tests

## Dependencies
Depends-On: #...

## Northstar Execution Notes
- domain: software_development
- expected driver: software-dev
- requires live GitHub: yes/no
- requires browser evidence: yes/no
```

Preflight checks before `apply`:

- Target repo exists.
- Local repo exists or can be cloned.
- `.northstar.yaml` exists and validates, or setup can create it.
- GitHub credential is available.
- Required labels exist or can be created.
- Project exists if requested.
- Required Project fields exist or setup can create them after confirmation.
- Workflow resolves.
- Host SDK credentials are usable.
- Build/test/browser commands are discoverable when required.
- Generated issue bodies contain no secret-shaped values.
- Dependency graph has no cycles.

Acceptance metrics:

- `spec_plan_inputs_validated = 1`
- `issues_generated_from_plan >= 5`
- `issue_acceptance_criteria_present = 1`
- `issue_quantitative_metrics_present = 1`
- `dependency_graph_edges >= 4`
- `dependency_graph_cycles = 0`
- `dry_run_requires_no_github_mutation = 1`
- `apply_requires_confirmation = 1`
- `preflight_missing_project_fields_detected >= 1`
- `secret_leaks_in_generated_issues = 0`

### 8.2 Structured Artifact Contract

SDK child outputs must include machine-readable artifacts.

Worker artifact:

```json
{
  "artifact_kind": "worker_result",
  "status": "success",
  "changed_files": ["src/App.tsx"],
  "commands_run": [
    { "command": "npm test", "status": "passed" }
  ],
  "test_summary": {
    "passed": 18,
    "failed": 0
  },
  "risks": [],
  "next_action": "ready_for_verification",
  "recovery_hint": null
}
```

Verifier artifact:

```json
{
  "artifact_kind": "evidence_packet",
  "status": "pass",
  "pr_number": 123,
  "commands_run": [
    { "command": "npm run build", "status": "passed" },
    { "command": "npm test", "status": "passed" }
  ],
  "browser_evidence": {
    "ran": true,
    "tests_passed": 12
  },
  "risks": []
}
```

Rules:

- Missing required fields reject the artifact.
- Rejected artifacts do not advance lifecycle.
- Raw logs are not persisted.
- Compact summaries are persisted.
- Secret-shaped values reject the artifact.
- Release requires verifier evidence with build/test/browser evidence when the issue requires browser acceptance.

Acceptance metrics:

- `structured_worker_artifacts_validated >= 1`
- `structured_verifier_artifacts_validated >= 1`
- `malformed_artifacts_rejected >= 1`
- `artifact_secret_leaks = 0`

### 8.3 Consumer Bootstrap Skill

Northstar skill provides operator-facing intents:

- `setup`
- `plan issues`
- `run`
- `status`
- `recover`

`setup`:

- Detect GitHub repo.
- Render `.northstar.yaml`.
- Ask whether to create Project.
- Create labels after confirmation.
- Verify credentials.
- Run doctor.

`plan issues`:

- Convert a feature brief or spec/plan pair into issue drafts.
- Show dependency graph.
- Ask confirmation before creating issues.
- Add dependency markers and Project items.

`run`:

- Start bounded or continuous watch.
- Show exact command.
- Use daemon mode only when future service packaging exists.

`status`:

- Summarize runtime, GitHub issue, PR, Project, and worker state.

`recover`:

- Diagnose stale lock, merge conflict, failed/quarantined issue, stale branch/PR, and projection failure.
- Propose safe recovery.
- Require confirmation before destructive action.

Acceptance metrics:

- `skill_setup_creates_config = 1`
- `skill_project_create_requires_confirmation = 1`
- `skill_plan_issues_creates_dependencies >= 3`
- `skill_status_reads_runtime_and_github = 1`
- `skill_recover_detects_stale_lock = 1`
- `skill_secret_leaks = 0`

### 8.4 Native GitHub Dependency Discovery

Dependency discovery merges multiple sources:

- `Depends-On` / `Blocked-By` markers.
- GitHub issue body tasklist references.
- GitHub linked issue or cross-reference APIs when available.

Rules:

- Merge and dedupe dependencies.
- Preserve source evidence.
- API failure records retryable intake warning.
- API failure does not fail lifecycle.
- Marker dependencies remain usable when native APIs are unavailable.

Acceptance metrics:

- `native_dependencies_discovered >= 1`
- `marker_dependencies_merged >= 1`
- `dependency_duplicates_removed >= 1`
- `native_dependency_api_failure_retryable >= 1`
- `native_dependency_api_failure_lifecycle_failures = 0`

### 8.5 Product Observability And Inspect

`northstar inspect --issue` includes:

- lifecycle
- Project lifecycle/status
- PR URL
- merge SHA
- current stage
- last heartbeat
- owner lease
- root sessions
- child runs
- retryable failures
- cleanup backlog
- recovery suggestion

`northstar inspect --summary` includes:

- active issues
- blocked issues
- stale locks
- failed/quarantined issues
- projection failures
- cleanup backlog
- dependency order risks

GitHub issue status marker uses single upsert behavior. Comments are reserved for significant transitions and errors. PR comments include verifier evidence, commands passed, browser evidence, and release readiness.

Acceptance metrics:

- `inspect_issue_fields_present >= 12`
- `inspect_summary_active_issues >= 1`
- `github_issue_status_marker_upserts >= 3`
- `github_comment_noise_ratio <= 1.5`
- `pr_verifier_evidence_comments >= 1`

## 9. Testing Strategy

### Offline Tests

- Watch lock stale/fresh/mismatch behavior.
- Merge conflict recovery state transitions and retry caps.
- Cleanup path safety and retryable cleanup failures.
- Project field GraphQL request planning with fake fetch.
- Spec-to-issues parser and issue body generation.
- Artifact validator and redaction.
- Native dependency discovery merge/dedupe/failure behavior.
- Inspect output shape.

### Live Tests

Live tests are separated from `npm test`.

V1 live test requires:

- `NORTHSTAR_PRODUCT_HARDENING_LIVE=1`
- `GITHUB_TOKEN` or `gh auth token`
- `NORTHSTAR_LIVE_GITHUB_REPO`
- `NORTHSTAR_LIVE_GITHUB_PROJECT_ID`
- SDK credentials available through local credential store or environment.

V1 live test creates real issues and verifies:

- real Project field updates
- real parallel execution
- real PR merges
- real completed lifecycle
- real browser tests

V2 live test uses a small spec and implementation plan to generate issues, apply them after confirmation in test configuration, and complete at least three issues through Northstar.

## 10. Rollout Order

1. V1 offline tests and implementation.
2. V1 live E2E.
3. V1 docs and operator manual update.
4. V2 spec-to-issues intake.
5. V2 structured artifacts.
6. V2 bootstrap/status/recover skill flows.
7. V2 native dependency discovery.
8. V2 inspect/observability polish.
9. V2 live E2E.

## 11. Final Acceptance

The full hardening effort is complete when:

- V1 live E2E passes with at least five real issues.
- V1 Project viewer fields match runtime state for every completed issue.
- V1 proves `development_capacity=2` with overlapping active workers.
- V2 can convert a spec and implementation plan into issue drafts with dependency graph and quantitative metrics.
- V2 can apply generated issues only after confirmation.
- V2 generated issues can be completed by Northstar through real PR merge.
- Browser evidence is collected for browser-facing consumer changes.
- No production source hardcodes sandbox repo or user paths.
- No secrets are leaked into files, logs, GitHub, Project fields, PR comments, or SQLite history.

# Northstar Production Orchestrator Design

Date: 2026-05-30

## Goal

Move the full workflow orchestration that currently lives in E2E harnesses into production engine/CLI/watch code.

The production system must support both:

- Manual single-issue operation through CLI commands.
- Automated daemon operation through `northstar watch`.

The implementation order is manual CLI first, then watch, but both are in scope for this version.

## Current Context

Northstar already has:

- A pure runtime state machine in `src/runtime/state-machine.ts`.
- SQLite persistence in `src/runtime/store.ts`.
- A thin `RuntimeEngine` and command-cycle helper in `src/runtime/engine.ts`.
- CLI command parsing in `src/cli/northstar.ts`.
- A `watch` loop shell in `src/cli/watch-command.ts`.
- SDK-first OpenCode/Codex host adapters.
- Full live E2E harnesses under `tests/e2e-full-live*`.

The missing production piece is a workflow orchestrator that performs the actual end-to-end operational flow:

```text
GitHub issue intake
  -> dependency scheduling
  -> owner lease
  -> root session / child dispatch
  -> worktree / branch / artifact
  -> commit / push / PR
  -> verification
  -> release / confirmed merge
  -> completed
```

Today that orchestration is mostly encoded in test harnesses. This design moves it behind production interfaces without making the state machine impure.

## Architecture

Add a production orchestrator layer:

```text
src/orchestrator/
  intake.ts
  scheduler.ts
  issue-flow.ts
  worktree-runner.ts
  host-dispatch.ts
  pr-flow.ts
  release-flow.ts
  cycle.ts
```

The orchestrator becomes the shared workflow brain for:

- `northstar intake`
- `northstar start`
- `northstar reconcile`
- `northstar release`
- `northstar inspect`
- `northstar watch`
- deterministic offline E2E
- full live production E2E

Manual CLI commands and `northstar watch` must call this same orchestrator layer. They must not carry separate copies of the intake, dependency scheduling, stage dispatch, PR, verification, or release flow.

The runtime state machine remains pure. It receives snapshots and runtime events, then returns the next snapshot, history rows, effects, and operator messages. It must not read/write filesystem, Git, GitHub, host SDKs, shell, or SQLite directly.

## Component Responsibilities

### `intake.ts`

Fetches GitHub issues either by explicit issue number or by label:

```bash
northstar intake --issue 123
northstar intake --label northstar:ready
```

It normalizes each issue into an `IssuePacket`, parses dependencies and priority, and writes issue snapshots/history through the store.

Dependency parsing supports:

```yaml
---
depends_on: [12, 15]
priority: 10
---
```

and fallback text forms:

```text
Depends on: #12, #15
Blocked by: #18
```

### `scheduler.ts`

Builds a dependency graph and chooses which ready items can run.

Rules:

- Dependencies must complete before dependents start.
- Dependency cycles quarantine the affected issue set.
- Missing dependency references quarantine the affected issue unless explicitly configured to ignore external dependencies.
- Same dependency level sorts by priority, then issue number.
- `runtime.development_capacity` limits concurrent implementation starts.
- `runtime.release_capacity` limits concurrent release starts.

### `issue-flow.ts`

Owns production lifecycle actions:

- Claim owner lease.
- Start current workflow stage.
- Record heartbeat.
- Submit child artifact.
- Apply gate result.
- Resume quarantined issue with a valid new lease or host-confirmed live lease.

It delegates pure transitions to `applyRuntimeEvents()`.

### `worktree-runner.ts`

Owns software-development worktree preparation:

- Create issue worktree outside the consumer root worktree.
- Create/reuse issue branch.
- Keep all Git commands as argv arrays.
- Prevent `git checkout main` or `git switch main` in the consumer root.
- Detect dirty/ambiguous worktree state and quarantine or record retryable history.

### `host-dispatch.ts`

Selects OpenCode or Codex using:

```yaml
runtime:
  host_adapter: opencode
```

or:

```yaml
runtime:
  host_adapter: codex
```

Dispatch configuration is derived from:

```text
stage_cursor -> workflow.stages[stage].role
role_name -> workflow.roles[role_name] merged with workflow_overrides.roles[role_name]
runtime.host_adapter -> OpenCodeHostAdapter or CodexHostAdapter
```

### `pr-flow.ts`

Owns the software-development PR path:

- Detect worker output changes in the issue worktree.
- Commit and push the issue branch.
- Create or reuse the GitHub PR.
- Submit a `worker_result` artifact to the runtime.
- Dispatch the verifier stage.

### `release-flow.ts`

Owns release semantics:

- Manual `northstar release --issue <n>` may merge a verified PR.
- `northstar watch` may merge only when `runtime.auto_release: true`.
- A PR merge must be confirmed before the issue can transition to `completed`.
- After confirmed merge, local sync or cleanup failures must not reverse `completed`.

## Manual CLI Flow

The first production path is manual and single-issue friendly:

```bash
northstar intake --issue 123
northstar start --issue 123
northstar reconcile --issue 123
northstar release --issue 123
northstar inspect --issue 123
```

`northstar intake --label northstar:ready` supports batch intake.

Manual lifecycle:

```text
intake --issue
  -> ready or quarantined

start --issue
  -> dependency check
  -> claim issue_worker lease
  -> prepare worktree/branch
  -> start issue_worker root session
  -> start issue_worker background child
  -> running

reconcile --issue
  -> read child status/artifact
  -> commit/push/create PR
  -> submit worker_result
  -> start verifier root session/child
  -> submit evidence/gate
  -> verified

release --issue
  -> claim release_worker lease
  -> start_release
  -> merge PR
  -> confirmed merge fact
  -> completed
```

`inspect --issue` must show lifecycle, dependencies, owner lease, root sessions, child runs, PR metadata, retryable effects, quarantine reasons, and next suggested action.

## Watch Flow

`northstar watch` is a daemon shell. It must stay thin.

Watch responsibilities:

- Load config.
- Open SQLite store.
- Acquire a writer lock.
- Handle sleep/interval/max-cycles.
- Handle SIGTERM graceful shutdown.
- Emit compact logs.
- Call `orchestrator.runCycle()`.

Watch must not duplicate business logic for issue workers, verifier dispatch, PRs, merge, or release. Those belong in the orchestrator.

Each watch cycle performs:

1. Intake phase if configured.
2. Schedule phase.
3. Start phase for capacity-limited ready issues.
4. Reconcile phase for active issues.
5. Release phase for verified issues when `auto_release` is enabled.
6. Repair/safety phase for invalid leases, stale children, retryable effects, and quarantine facts.

Suggested config:

```yaml
runtime:
  development_capacity: 1
  release_capacity: 1
  auto_release: false
  session_scope: stage_root

github:
  intake:
    enabled: true
    label: northstar:ready
```

## Watch And Orchestrator Split

```text
watch
  = daemon shell
  = loop / lock / signal / logging

orchestrator
  = workflow brain
  = intake / scheduling / stage dispatch / git / github / release / repair facts

state-machine
  = pure transition core
  = snapshot + events -> snapshot + history + effects
```

Conceptual orchestrator API:

```ts
orchestrator.intake({ issue: 123 })
orchestrator.intake({ label: "northstar:ready" })
orchestrator.startIssue({ issueId })
orchestrator.reconcileIssue({ issueId })
orchestrator.releaseIssue({ issueId })
orchestrator.runCycle({
  intake: true,
  autoRelease: config.runtime.auto_release,
  maxDevelopmentStarts: config.runtime.development_capacity,
  maxReleaseStarts: config.runtime.release_capacity,
})
```

## Workflow-General Boundary

The first full production driver targets software-development PR release, but the orchestrator core must remain workflow-general.

It must not hard-code:

```text
issue_worker -> pr_verifier -> release_worker
verified -> PR merge
release == GitHub merge
```

Instead the core reads:

```text
current stage
stage.role
role artifact kind
workflow transitions
workflow effects
domain driver capabilities
```

Use two layers:

```text
Workflow Orchestrator Core
  - workflow stages/roles/artifacts/effects
  - dependency scheduling
  - owner lease
  - stage start
  - child dispatch
  - artifact validation
  - state-machine transition
  - retry/quarantine/recovery
  - effect ordering
  - watch cycle

Domain Runtime Driver
  - software_dev_pr_release
      Git worktree
      branch/commit/push
      GitHub PR create
      PR merge
  - future content_publish
      CMS draft/publish
  - future office_delivery
      document/report/email/calendar
```

This version must fully implement the software-development PR release driver. Content creation and office automation are not required to have live production E2E in this version, but offline tests must prove the core does not hard-code the software-development role chain.

## Root Session Binding

This version uses:

```yaml
runtime:
  session_scope: stage_root
```

`stage_root` semantics:

- Each stage entry claims an owner lease for that stage role.
- Each lease generation starts one root session.
- Background child runs for that stage bind to that root session.
- The next stage starts a new lease/root session.

Happy path:

```text
implementation
  role=issue_worker
  lease=lease-impl-...
  root_session=root-impl-...
  child_run=child-impl-...

verification
  role=pr_verifier
  lease=lease-verify-...
  root_session=root-verify-...
  child_run=child-verify-...

release
  role=release_worker
  lease=lease-release-...
  root_session=root-release-...
```

SQLite snapshot/history must answer:

- Which role used which root session.
- Which child run belonged to which root session.
- Which lease generation owned the stage.

Retrying a stage creates a new lease generation/root session and preserves prior history.

`workflow_root` is explicitly deferred. The code should not make future support impossible, but this version does not implement it.

## Error Handling

### Quarantine

Use quarantine for runtime ownership or safety problems:

- Active issue missing valid owner lease.
- Expired owner lease.
- Dependency cycle.
- Missing dependency when strict dependency resolution is enabled.
- Unsafe resume.
- Dirty or ambiguous worktree state.
- Child artifact cannot be safely attributed.

Quarantine writes compact audit history and requires operator action or a valid resume path.

### Retryable Effects

Use retryable effect history for external side-effect failures that should not directly fail lifecycle:

- GitHub label/project/comment sync failure.
- Push failure.
- PR create transient failure.
- Local main sync failure after merge.
- Worktree cleanup failure.

### Failed

Use failed lifecycle for terminal workflow failures:

- Worker artifact terminal failure.
- Verifier terminal failure.
- Release terminal failure before merge.
- Artifact schema invalid after retry policy exhaustion.

### Release Safety

- `completed` requires confirmed merge or domain-specific confirmed release fact.
- Release success without confirmation is rejected.
- After confirmed merge, local sync and cleanup failures must not reverse `completed`.
- `watch` can merge only when `runtime.auto_release: true`.

### Secret Safety

- Secrets must not be written to docs, repo files, SQLite history, or logs.
- History payloads must remain compact.
- Logs must be redacted.
- Live E2E must verify `secret_leaks=0`.

## Testing And Acceptance

### Quantitative Acceptance Gates

The implementation is not complete until these metrics are produced by deterministic tests and, where marked live, by full live production E2E. Metrics must be emitted in compact summary lines so `/goal` can verify them without reading raw logs.

#### Manual CLI Flow Metrics

The manual flow must run against one deterministic offline issue and one live GitHub issue.

```text
manual_cli_issues_intaken >= 1
manual_cli_ready_snapshots >= 1
manual_cli_dependency_edges_parsed >= 1
manual_cli_dependency_order_violations = 0
manual_cli_owner_leases_claimed >= 3
manual_cli_root_sessions_started >= 3
manual_cli_child_runs_started >= 2
manual_cli_worktrees_created >= 1
manual_cli_branches_created >= 1
manual_cli_commits_created >= 1
manual_cli_branches_pushed >= 1
manual_cli_prs_created >= 1
manual_cli_verified_issues >= 1
manual_cli_releases_started >= 1
manual_cli_prs_merged >= 1
manual_cli_completed_issues >= 1
manual_cli_confirmed_release_facts >= 1
manual_cli_inspect_fields_present >= 8
manual_cli_secret_leaks = 0
manual_cli_shell_fallbacks = 0
```

`manual_cli_inspect_fields_present` must count at least lifecycle, dependencies, owner lease, root sessions, child runs, PR metadata, retryable effects, and next action.

#### Watch/Daemon Metrics

The watch flow must be tested with `auto_release=false` and `auto_release=true`.

```text
watch_cycles_completed >= 6
watch_intake_processed >= 2
watch_ready_issues_loaded >= 2
watch_dependency_order_violations = 0
watch_issues_started >= 2
watch_root_sessions_started >= 4
watch_child_runs_started >= 4
watch_verified_issues >= 2
watch_stops_at_verified >= 1
watch_auto_release_completed >= 1
watch_duplicate_dispatches = 0
watch_writer_lock_collisions >= 1
watch_sigterms_handled >= 1
watch_sigterm_exit_ms <= 5000
watch_secret_leaks = 0
```

#### Dependency Scheduling Metrics

Deterministic scheduler tests must cover sequential and parallel cases.

```text
scheduler_issues_loaded >= 5
scheduler_dependency_edges >= 3
scheduler_sequential_order_passes >= 1
scheduler_parallel_batches >= 1
scheduler_priority_tiebreak_passes >= 1
scheduler_issue_number_tiebreak_passes >= 1
scheduler_cycle_quarantines >= 1
scheduler_missing_dependency_quarantines >= 1
scheduler_dependency_order_violations = 0
```

#### Workflow Generality Metrics

The orchestrator core must prove it is not hard-coded to the software-development chain.

```text
workflow_generality_workflows_tested >= 3
workflow_generality_non_dev_workflows_passed >= 2
workflow_generality_hardcoded_role_chain_matches = 0
workflow_generality_hardcoded_release_merge_matches = 0
workflow_generality_domain_driver_dispatches >= 3
```

The three workflows must include:

- `issue_to_pr_release`
- one content creation workflow
- one office automation workflow

#### Error And Recovery Metrics

```text
orchestrator_retryable_effect_failures >= 3
orchestrator_quarantined_issues >= 3
orchestrator_failed_issues >= 1
orchestrator_resume_successes >= 1
orchestrator_invalid_resume_rejections >= 1
orchestrator_artifact_rejections >= 1
orchestrator_post_merge_cleanup_failures_preserved >= 1
orchestrator_completed_reversals = 0
orchestrator_secret_leaks = 0
```

#### Full Live Production Metrics

Full live production E2E must use real GitHub and real OpenCode/Codex SDK paths. Fake host adapters cannot satisfy these metrics.

```text
production_live_issues_created >= 2
production_live_intake_packets = production_live_issues_created
production_live_dependency_edges_parsed >= 1
production_live_dependencies_resolved >= 1
production_live_root_sessions_started >= 6
production_live_child_runs_started >= 4
production_live_worktrees_created >= 2
production_live_branches_created >= 2
production_live_commits_created >= 2
production_live_branches_pushed >= 2
production_live_prs_created >= 2
production_live_prs_merged >= 2
production_live_completed >= 2
production_live_confirmed_merge_facts >= 2
production_live_opencode_runs_completed >= 1
production_live_codex_runs_completed >= 1
production_live_secret_leaks = 0
production_live_shell_fallbacks = 0
production_live_duration_seconds <= 1800
```

#### Coverage And Source Safety Metrics

```text
production_orchestrator_requirement_coverage_percent >= 90
production_orchestrator_code_coverage_lines >= 85
production_orchestrator_code_coverage_branches >= 85
production_orchestrator_code_coverage_functions >= 85
production_orchestrator_code_coverage_statements >= 85
forbidden_autodev_script_matches = 0
forbidden_python_runtime_matches = 0
production_shell_chain_matches = 0
runtime_state_machine_side_effect_matches = 0
```

### Offline Deterministic Tests

Offline tests must not require GitHub token, OpenCode/Codex credentials, network, or host CLIs.

Required coverage:

- Dependency parser:
  - YAML frontmatter `depends_on`.
  - Text `Depends on:` / `Blocked by:`.
  - Priority parsing.
  - Cycle detection.
  - Missing dependency quarantine.
- Scheduler:
  - Dependency order.
  - Priority and issue number tie-break.
  - Development capacity.
  - Release capacity.
- Orchestrator:
  - Single issue reaches `completed`.
  - Two dependent issues execute sequentially.
  - Two independent issues execute in parallel when capacity allows.
  - `auto_release=false` stops at `verified`.
  - `auto_release=true` reaches `completed`.
- Workflow generality:
  - Software-development workflow passes.
  - Content creation or office automation fixture proves no hard-coded role chain.
- Error flows:
  - Worktree failure records retryable history.
  - PR create failure records retryable history.
  - Verifier terminal failure moves to `failed`.
  - Expired lease moves to `quarantined`.

### Full Live Production E2E

Live tests require:

```bash
NORTHSTAR_PRODUCTION_LIVE=1
GITHUB_TOKEN=...
NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox
```

The live production E2E must use real GitHub and real OpenCode/Codex SDK paths. It must not use fake host adapters to satisfy live acceptance.

Minimum metrics:

```text
production_live_issues_created >= 1
production_live_intake_packets = production_live_issues_created
production_live_dependencies_resolved >= 1
production_live_root_sessions_started >= 3
production_live_child_runs_started >= 2
production_live_worktrees_created >= 1
production_live_branches_pushed >= 1
production_live_prs_created >= 1
production_live_prs_merged >= 1
production_live_completed >= 1
production_live_confirmed_merge_facts >= 1
production_live_secret_leaks = 0
production_live_shell_fallbacks = 0
```

### Manual CLI Acceptance

The following sequence must be usable by a human:

```bash
northstar intake --issue <n>
northstar start --issue <n>
northstar reconcile --issue <n>
northstar release --issue <n>
northstar inspect --issue <n>
```

Each command must produce clear output and leave auditable SQLite history.

### Watch Acceptance

```bash
northstar watch --max-cycles 10 --log-json
```

Minimum metrics:

```text
watch_cycles_completed >= 3
watch_intake_processed >= 1
watch_issues_started >= 1
watch_issues_completed >= 1 when auto_release=true
watch_stops_at_verified >= 1 when auto_release=false
watch_duplicate_dispatches = 0
watch_secret_leaks = 0
```

## Deferred Work

- `runtime.session_scope=workflow_root`.
- Full live production E2E for content creation and office automation.
- OS-level service packaging for daemon supervision.
- Human approval gates beyond `auto_release`.
- Multi-repo dependency graphs.

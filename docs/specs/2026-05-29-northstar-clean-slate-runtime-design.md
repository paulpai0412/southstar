# Northstar Clean-Slate Runtime Design

## Status

- Date: 2026-05-29
- Status: proposed
- Project name: Northstar
- Target path: `/home/timmypai/apps/northstar`
- Scope: clean-slate TypeScript runtime engine for durable workflow-driven automation orchestration

## Purpose

Northstar is a durable, SDK-first, workflow-driven control plane for automation workflows. Coding-agent delivery is the first workflow family, not the only supported domain. It is not a coding agent and is not a replacement for OpenCode, Codex, Claude Code, office/document agents, browser automation agents, or any other host runtime. It sits above host runtimes and owns durable workflow state, work scheduling, root-session leases, background child handoff, verification/delivery policy, projection, local synchronization, recovery, and audit.

The initial implementation must be a new TypeScript project, not a rewrite-in-place of the existing Python runtime. The old `autodev` repository is a reference for behavior and failure modes only. Northstar should not depend on old Python scripts at runtime.

## Domain-General Workflow Model

Northstar keeps the runtime control-plane lifecycle stable while allowing workflow packages to define domain-specific stages, roles, artifacts, gates, effects, and projection targets.

The core lifecycle set is intentionally fixed:

- `ready`
- `claimed`
- `running`
- `verifying`
- `verified`
- `release_pending`
- `exception`
- `completed`
- `cancelled`
- `failed`
- `quarantined`

These states are runtime invariants used by scheduling, lease ownership, repair, inspection, active issue listing, capacity control, and operator dashboards. Workflow packages must not add new core lifecycle states. `exception` is a non-active automatic recovery state resolved by policy; `quarantined` is the human-intervention state.

Workflow-specific state belongs in workflow metadata:

- `stage_cursor`
- workflow stage names such as `draft`, `editorial_review`, `approval`, `send_email`, or `archive`
- workflow artifact kinds such as `draft_article`, `editorial_packet`, `spreadsheet_report`, or `email_delivery_result`
- workflow effect kinds such as `publish_content`, `send_email`, `archive_document`, `sync_project`, or `merge_pr`

Runtime events also remain canonical at the control-plane boundary. Domain-specific host observations and artifacts are normalized into canonical runtime events such as child artifacts, gate results, projection results, effect results, operator commands, and heartbeats. Workflow packages may define event mappings, but arbitrary workflow event strings must not directly mutate lifecycle state without passing through schema validation and transition rules.

This two-layer model lets Northstar run coding, content creation, office automation, and other long-running workflows without making repair and scheduling domain-specific.

## Design Decisions

### Clean-Slate Project

Northstar will live in `/home/timmypai/apps/northstar`.

The runtime implementation will be TypeScript/Node. Existing Python scripts from `/home/timmypai/apps/autodev/scripts` are not part of the new runtime surface. They may be read as historical reference during planning and implementation, but Northstar must not import, shell out to, or wrap them as compatibility commands.

### SDK-First Host Adapters

Northstar core must not call host CLIs directly as its primary runtime integration. It depends on a host adapter interface and prefers SDK-backed implementations.

Required host adapter operations:

- `startRootSession`
- `recordHeartbeat` or host-native session ping when supported
- `startBackgroundChild`
- `readRootStatus`
- `readChildStatus`
- `resumeHint`
- `capabilities`

OpenCode and Codex adapters should be SDK-first. CLI fallback may exist only as a debug/development adapter and must be explicit in config.

### Cross-Platform Runtime

Northstar must support Windows and Linux.

Rules:

- Use Node and TypeScript platform APIs for paths and processes.
- Represent external commands as argv arrays, not shell-chain strings.
- Do not depend on Bash, Zsh, POSIX job control, or `start_new_session`-style behavior.
- Keep OS-specific process handling behind a platform adapter.
- Keep git/worktree operations behind a git adapter.

### Unified Configuration

Consumer projects use `.northstar.yaml`.

Northstar runtime state lives under `.northstar/runtime/`.

Runtime settings should not be scattered across environment variables. Environment variables are allowed only for bootstrap/debug overrides:

- `NORTHSTAR_CONFIG`
- `NORTHSTAR_PROJECT_ROOT`
- `NORTHSTAR_DEBUG`

All normal runtime configuration must come from `.northstar.yaml`, be schema-validated, and be passed as a typed `RuntimeConfig` object. Runtime modules must not read arbitrary `process.env` values.

Example:

```yaml
schema_version: "1.0"

project:
  name: vocab1
  root: /home/timmypai/apps/vocab1

runtime:
  db_path: .northstar/runtime/control-plane.sqlite3
  host_adapter: opencode
  development_capacity: 1
  release_capacity: 1
  heartbeat_interval_seconds: 30
  lease_timeout_seconds: 180
  child_timeout_seconds: 7200

workflow:
  package: northstar/workflows/issue-to-pr-release
  id: issue_to_pr_release
  version: "1.0"

github:
  repo: owner/name
  sync:
    enabled: true
    retry_backoff_seconds: [30, 120, 600]

git:
  base_branch: main
  worktrees_dir: .northstar/runtime/worktrees
  sync_worktree_dir: .northstar/runtime/sync-worktrees/main

policy:
  github_sync_blocks_lifecycle: false
  quarantine_requires_operator: true
```

## Runtime Architecture

Northstar is organized around a small pure state machine plus adapters.

Suggested structure:

```text
src/
  cli/northstar.ts
  runtime/engine.ts
  runtime/state-machine.ts
  runtime/store.ts
  runtime/events.ts
  runtime/effects.ts
  runtime/policy.ts
  runtime/repair.ts
  adapters/host/opencode.ts
  adapters/host/codex.ts
  adapters/github/projector.ts
  adapters/git/worktrees.ts
  adapters/platform/process.ts
  adapters/platform/paths.ts
  config/load-config.ts
  config/schema.ts
  types/control-plane.ts
  types/host.ts
  types/workflow.ts
tests/
  runtime/
  adapters/
  config/
```

### Runtime Engine

`runtime/engine.ts` is the only orchestration loop.

Each engine cycle:

1. Load active issue snapshots from SQLite.
2. Load recent relevant `issue_history` facts.
3. Collect runtime events from DB facts, host adapters, operator commands, and effect results.
4. Evaluate the pure state machine.
5. Commit history and snapshot changes in one transaction.
6. Execute external effects only after the DB commit.
7. Record effect results as new history rows for the next cycle.

### State Machine

`runtime/state-machine.ts` is pure logic. It does not call the filesystem, shell, GitHub, host SDKs, or SQLite.

Input:

- issue snapshot
- workflow definition
- runtime events
- policy

Output:

- lifecycle transitions
- snapshot updates
- history entries
- effects
- operator messages

### Store

`runtime/store.ts` owns SQLite persistence.

Runtime control-plane tables remain:

- `issues`
- `issue_history`

Do not add additional runtime control-plane tables in the first implementation. New concepts such as owner leases, child runs, effect queues, and projection state live in `issues.runtime_context_json` and auditable `issue_history.payload_json`.

Every decision writes history before updating the issue snapshot.

## Workflow-Driven Execution

Northstar core does not hard-code `issue_worker -> pr_verifier -> release_worker`.

Northstar core also does not hard-code coding as the only domain. A workflow package may describe a coding release, content creation pipeline, office report delivery, compliance review, or another automation process, as long as its stages map to the stable runtime lifecycle set and its host observations are normalized into validated runtime events.

The engine provides primitives:

- lifecycle state
- owner lease
- stage cursor
- child run
- artifact fact
- gate result
- transition
- effect
- audit history

Workflow packages define roles, stages, gates, retry policies, and effects.

Example:

```yaml
workflow:
  id: issue_to_pr_release
  version: "1.0"

  roles:
    issue_worker:
      run_mode: background_child
      agent: build
      model: ""
      load_skills:
        - tdd
        - git-master
      artifact: worker_result
      timeout_seconds: 7200

    pr_verifier:
      run_mode: background_child
      agent: review
      load_skills:
        - review-work
        - browser-qa
      artifact: evidence_packet
      timeout_seconds: 7200

    release_worker:
      run_mode: background_child
      agent: release
      load_skills:
        - git-master
      artifact: release_result
      timeout_seconds: 3600

  stages:
    implementation:
      lifecycle_state: running
      role: issue_worker
      on_success: verification
      on_blocked: quarantined
      on_failed_retryable: implementation
      on_failed_terminal: failed

    verification:
      lifecycle_state: verifying
      role: pr_verifier
      on_pass: verified
      on_fail_retryable: implementation
      on_fail_terminal: failed

    release:
      lifecycle_state: release_pending
      role: release_worker
      on_success: completed
      on_blocked_transient: verified
      on_failed_terminal: failed
```

Consumer config may override role settings:

```yaml
workflow_overrides:
  roles:
    issue_worker:
      agent: codex-gpt-5.3
      load_skills:
        - tdd
        - playwright
```

The engine passes role settings to the host adapter. It must not hard-code skill names or host-specific role syntax.

### Workflow Schema

Version 1 workflow packages are YAML files. A workflow package must declare:

- `id`
- `version`
- `roles`
- `stages`
- optional `domain`
- optional `gates`
- optional `artifact_schemas`
- optional `event_mappings`
- optional `effects`
- optional `projection_targets`
- optional `policies`

Each role must declare:

- `run_mode`: `root`, `background_child`, or `manual_gate`
- `artifact`: artifact kind expected from the role, or empty for roles that do not submit artifacts
- optional `agent`
- optional `model`
- optional `load_skills`
- optional `timeout_seconds`
- optional `retry_policy`
- optional `prompt_template`

Each stage must declare:

- `lifecycle_state`
- `role`
- terminal or next-stage transitions for success, blocked, retryable failure, and terminal failure

Workflow validation must reject:

- stages that point to missing roles
- transitions that point to missing stages or unknown lifecycle states
- role artifacts that have no artifact schema
- domain-specific lifecycle state names such as `drafting`, `publishing`, or `emailing`
- cycles without an explicit retry policy
- host-required role fields that are not supported by the selected adapter capabilities

Workflow schema validation should produce machine-readable error codes so `northstar inspect` and code-goal verification can report exact failures.

Domain-specific workflow examples should be represented as workflow fixtures rather than runtime branches. For example:

- `content_creation_publish` may define stages such as `draft`, `editorial_review`, `approval`, and `publish`, with artifacts such as `draft_article`, `editorial_packet`, and `publish_result`.
- `office_report_delivery` may define stages such as `collect_data`, `assemble_report`, `manager_review`, and `send_email`, with artifacts such as `spreadsheet_report`, `review_packet`, and `email_delivery_result`.

Both examples still use only the fixed lifecycle states such as `running`, `verifying`, `verified`, `release_pending`, and `completed`.

### Artifact Schemas

Artifacts are normalized workflow facts, not files. Artifact payloads are stored in `issue_history.payload_json`, with optional compact `body_text` only when human-readable context is useful.

Version 1 must define built-in artifact schemas for the coding workflow family:

- `worker_result`
- `evidence_packet`
- `release_result`

The artifact validator must also support workflow-defined artifact schemas. A workflow package may declare domain artifacts such as `draft_article`, `editorial_packet`, `spreadsheet_report`, `approval_packet`, `publish_result`, or `email_delivery_result`. These custom artifact schemas must be validated before they can drive lifecycle transitions, and invalid domain artifacts must produce artifact rejection history just like invalid built-in artifacts.

All artifact schemas must include:

- `schema_version`
- `artifact_kind`
- `issue_number`
- `role`
- `status`
- `observed_at`
- `summary`
- `retryable`

`worker_result` must include implementation branch metadata when status is success:

- `branch`
- `base_branch`
- `commit_sha` or equivalent host/git ref
- compact changed-file list
- self-check summary

`evidence_packet` must include verifier-owned acceptance fields when status is pass:

- `pr_number` when the workflow has a PR gate
- `base_branch`
- gate results
- verifier actor/session metadata

`release_result` must include release outcome fields:

- `pr_number`
- merge status
- merged SHA when merge succeeded
- local sync result if attempted
- cleanup result if attempted

Artifact validation failure records an artifact rejection event. It must not be silently treated as a valid blocked/fail result.

## Intake Contract

`northstar intake` converts external work items into issue rows and issue packet facts.

Version 1 intake sources:

- GitHub issues
- local seeded YAML/JSON issue packets

The intake layer is adapter-driven. The engine receives normalized issue packets with:

- `issue_number` or stable local id
- `title`
- `source`
- `source_url`
- `branch`
- `base_branch`
- `labels`
- `dependencies`
- `raw_text`
- `ready_for_agent`

GitHub intake must not hard-code a default tracker repository. The repository comes from `.northstar.yaml`.

Local seeded intake must work without GitHub credentials and must not call GitHub projection effects unless the workflow explicitly materializes a GitHub-backed issue.

Intake must be idempotent. Re-running intake for the same source item updates the compact issue packet projection without deleting history.

## State Model

### Lifecycle State

Northstar keeps a small lifecycle set:

- `ready`
- `claimed`
- `running`
- `verifying`
- `verified`
- `release_pending`
- `exception`
- `completed`
- `cancelled`
- `failed`
- `quarantined`

Workflow definitions may map stages onto these lifecycle states, but the core lifecycle set stays stable for scheduling, repair, and operator inspection.

### Owner Lease

Any active issue must have one valid owner lease. Active means:

- `claimed`
- `running`
- `verifying`
- `release_pending`

`owner_lease` lives in `issues.runtime_context_json.owner_lease` and is audited in `issue_history`.

Required lease fields:

- `lease_id`
- `root_session_id`
- `role`
- `generation`
- `heartbeat_seq`
- `last_heartbeat_at`
- `expires_at`

`current_session_id` remains the operator resume pointer for the current root session. It is not the only liveness source.

`resume quarantined -> running` must create a new owner lease or reattach to a host-confirmed live root lease. Otherwise the transition is rejected.

### Background Child Runs

Child runs live in `issues.runtime_context_json.child_runs` and are audited in history.

Required fields:

- `child_run_id`
- `lease_id`
- `role`
- `status`
- `session_id`
- `started_at`
- `last_seen_at`
- `artifact_history_id`

Allowed statuses:

- `queued`
- `running`
- `succeeded`
- `blocked`
- `failed`
- `lost`

The state machine must not depend on foreground task return. It advances from child events and persisted artifact facts.

## Root Heartbeat and Subagent Contract

Root sessions are long-lived issue coordinators.

Root responsibilities:

- establish an owner lease
- write heartbeat events periodically
- start background child runs
- observe child status
- call reconcile or follow engine decisions

Root non-responsibilities:

- implementing issue scope directly
- performing final acceptance outside workflow role
- relying on foreground child task completion as lifecycle truth

Child responsibilities:

- execute assigned role
- submit the configured artifact or terminal outcome
- not create unrelated root sessions

Heartbeat updates lease liveness only. Artifact submission must not refresh root heartbeat.

## GitHub Projection

GitHub labels, issue body, status comments, project fields, and issue close are eventual projections.

GitHub is the first projection adapter, not the projection model itself. Workflow packages may name projection targets that are backed by GitHub, local reports, document systems, email delivery, or other adapters. Projection target failure is always an auditable retryable projection fact unless a workflow policy explicitly routes it to a manual gate.

Lifecycle transitions may enqueue projection effects. Projection failure is recorded as `issue_history` but must not move an issue into `failed` or `quarantined`.

`inspect` must show lifecycle state separately from projection state.

Projection attempts should include:

- `projection_target`
- `status`
- `attempt`
- `last_error`
- `next_retry_at`
- compact payload

Project stats are projection data, not lifecycle data. Aggregates such as issue counts by lifecycle state, stage duration, retry counts, and projection failure counts may be rendered to GitHub Projects or local reports, but stats failure must not block lifecycle transitions.

Stats projection must read from SQLite snapshots/history and write projection attempt results back to `issue_history`.

## Release and Local Worktree Sync

Release lifecycle is separate from local projection cleanup.

For non-coding workflow families, `release_pending` represents delivery pending rather than PR release specifically. Coding workflows consume schema-valid `release_result` artifacts as delivery truth. Content workflows may use publish confirmation, and office workflows may use document/email delivery confirmation.

Rules:

- `verified -> release_pending` requires release owner lease.
- For software-development workflows, `release_result status=completed` with `release.confirmed=true` may transition to `completed`.
- Northstar validates artifact schema and required fields only; PR existence, branch state, and merge-commit existence are not lifecycle truth.
- Once completion is confirmed, local sync, issue close, project sync, or cleanup failure must not reverse `completed`.
- Failed local sync is a retryable projection/effect failure.

Local main sync uses a dedicated sync worktree:

`.northstar/runtime/sync-worktrees/main`

Do not run `git checkout main` or `git switch main` in the consumer root worktree.

Issue worktree cleanup is a retryable effect. Cleanup success clears `issue_worktree_path` and `issues.worktree_path` projections.

## Runtime Repair

Northstar provides:

`northstar repair-runtime --project-root <project>`

The command normalizes older or inconsistent DB snapshots into new invariants without deleting audit history.

Repair behaviors:

- active issue without valid owner lease becomes `exception` with structured recovery context unless latest artifacts prove a stable later state
- terminal issue with stale session/cursor projections has those projections cleared
- ready issue with stale session fence has session fence cleared
- merged release with failed local sync is normalized to `completed` plus retryable projection failure
- each repair action writes `admin_action` history

Repair must not add runtime tables or raw log artifacts.

## CLI Surface

Initial clean CLI:

- `northstar init`
- `northstar intake`
- `northstar start`
- `northstar reconcile`
- `northstar reconcile-workspace`
- `northstar heartbeat`
- `northstar release`
- `northstar repair-runtime`
- `northstar inspect`
- `northstar retry-sync`

CLI commands load `.northstar.yaml`, validate config, create an engine command, and call engine APIs.

## Daemon and Watch Mode

The first runtime must support single-shot CLI commands. It should also define a daemon/watch mode for continuous operation:

- `northstar watch`

Watch mode repeatedly runs engine cycles at a configured interval, handles shutdown signals, and records compact lifecycle output.

Watch mode must not keep uncommitted state in memory as the source of truth. On restart, occupancy, leases, pending effects, and retryable projections are reconstructed from SQLite.

The watch loop must enforce:

- one writer process per project runtime DB
- bounded development capacity
- bounded release capacity
- graceful shutdown without starting new effects after shutdown begins
- compact logs with no raw agent transcripts

## Security and Secrets

Northstar must avoid storing secrets in SQLite history, logs, or config examples.

Rules:

- `.northstar.yaml` may reference credential names or provider profiles, but should not require raw tokens.
- Host SDK credentials and GitHub tokens are resolved by adapter-specific credential providers.
- Logs and history must redact token-shaped values.
- Artifact payloads must reject raw terminal transcripts, raw browser traces, and large logs.
- Projection errors must be compact and must not include Authorization headers or full command environments.
- `inspect` must never print secret values.

Credential provider behavior must be testable with fake providers.

## Packaging and Distribution

Northstar should be installable as a Node CLI package. The initial package may be local-only, but the source layout must allow publishing as an npm package later.

Distribution surfaces:

- CLI binary: `northstar`
- workflow packages under a versioned workflow directory
- host adapter packages or modules
- optional host plugin packaging later

The initial implementation must document the supported Node version range and package manager command.

OpenCode/Codex host plugin integration is not required for the first code goal unless explicitly included in that goal. The core CLI and SDK adapter contracts are required.

## Code Goal Usage

This spec is intended to be usable as input to code-goal execution.

Before implementation, create a plan that maps acceptance criteria to milestones. Each milestone must list:

- AC ids covered
- files/modules expected
- test commands
- manual verification, if any

No milestone may claim completion without running its listed verification command.

Suggested first code-goal milestone order:

1. Project skeleton, config, dependency decision record: AC-01, AC-02, dependency gate.
2. SQLite store and state machine primitives: AC-03, AC-06, AC-07.
3. Workflow schema and role config: AC-04, AC-05.
4. Fake host integration and background child flow: AC-08.
5. Projection, release, worktree, and repair behavior: AC-09 through AC-13.
6. Inspect and final test gate: AC-14, AC-15.
7. Completion hardening: AC-16 through AC-23.

## Quantifiable Acceptance Criteria

### AC-01 Project

- `/home/timmypai/apps/northstar/package.json` exists.
- `npm test` runs from `/home/timmypai/apps/northstar`.
- Runtime source lives under `/home/timmypai/apps/northstar/src`.
- No runtime source imports from or shells out to `/home/timmypai/apps/autodev/scripts/*.py`.

### AC-02 Config

- `.northstar.yaml` fixture loading is covered by automated tests.
- Schema validation covers at least 20 config fields.
- Only `NORTHSTAR_CONFIG`, `NORTHSTAR_PROJECT_ROOT`, and `NORTHSTAR_DEBUG` may be read directly from `process.env`.
- A test fails if runtime modules read any other environment variable directly.

### AC-03 SQLite Store

- Store initialization creates exactly two runtime control-plane tables: `issues` and `issue_history`.
- Store tests cover append-history-before-update ordering.
- Store tests cover transaction rollback when snapshot update fails after history append is staged.
- Store tests cover idempotent command/effect result recording.

### AC-04 Workflow Generality

- At least two workflow fixtures pass validation and execution tests:
  - `issue_to_pr_release`
  - one workflow that does not include a release stage
- A test proves the engine can execute both workflows without hard-coded role-chain logic.

### AC-05 Role Configuration

- Tests cover at least 6 role override cases across `agent`, `model`, `load_skills`, `run_mode`, `timeout_seconds`, and `retry_policy`.
- Host adapter start requests include the configured role agent and skills.

### AC-06 Owner Lease

- Duplicate active owner lease acquisition for the same issue fails.
- `resume quarantined -> running` without a new or host-confirmed live lease is rejected.
- `resume quarantined -> running` with a valid new lease succeeds.
- Active lifecycle states without lease are reported as invariant violations by repair/inspect.

### AC-07 Heartbeat

- Heartbeat increments `owner_lease.heartbeat_seq`.
- Heartbeat updates `last_heartbeat_at` and `expires_at`.
- Artifact submission does not update lease heartbeat fields.
- Tests cover active, expired, and unknown host liveness cases.

### AC-08 Background Child Runs

- Fake host integration starts a background `issue_worker` child.
- Child artifact submission advances the workflow to the next configured stage.
- Root session does not need to wait for foreground child completion in tests.
- Child run records include `child_run_id`, `lease_id`, `role`, `status`, `session_id`, and timestamps.

### AC-09 GitHub Projection

- Tests simulate label sync failure, project sync failure, body/comment sync failure, and issue close failure.
- In all projection failure tests, lifecycle state remains unchanged.
- Each failure records retryable projection history with `projection_target`, `status=failed`, `last_error`, and `next_retry_at`.

### AC-10 Release Semantics

- PR merge success transitions issue to `completed`.
- Local main sync failure after confirmed merge does not move issue from `completed` to `failed`.
- Issue worktree cleanup failure after confirmed merge does not move issue from `completed` to `failed`.
- Failed local sync and cleanup each produce retryable effect history.

### AC-11 Worktree Sync

- Local main sync uses `.northstar/runtime/sync-worktrees/main`.
- Tests assert consumer root worktree does not receive `git checkout main` or `git switch main`.
- Tests cover sync worktree creation, reuse, failure, and repair.

### AC-12 Cross-Platform

- Path adapter tests include Linux-style and Windows-style fixture paths.
- Process adapter tests verify external commands are represented as argv arrays.
- No production code constructs shell-chain command strings containing `&&`, `||`, or `;` for runtime execution.

### AC-13 Runtime Repair

- A fixture modeled on the observed `vocab1` issue #35 loop is repaired so 3 consecutive reconcile cycles do not produce `running -> quarantined -> running` oscillation.
- A fixture modeled on the observed `vocab1` issue #64 release/local-sync failure preserves or restores `completed` when merge is confirmed.
- Repair writes compact `admin_action` history for every snapshot mutation.

### AC-14 Inspect

- `northstar inspect` output includes separate sections for:
  - lifecycle
  - lease
  - child runs
  - projection sync
- Inspect tests verify stale projections are visible without changing lifecycle state.

### AC-15 Test Gate

- `npm test` passes.
- Test files exist for state machine, store, config, workflow, adapters, repair, and inspect.
- State machine tests include at least 25 transition/event cases.

### AC-16 Workflow Schema

- Workflow schema validation tests cover at least 15 invalid workflow fixtures.
- Invalid fixture tests include missing role, missing stage target, unknown lifecycle state, missing artifact schema, unsupported host capability, and retry cycle without retry policy.
- Validation errors include stable machine-readable error codes.

### AC-17 Artifact Schemas

- `worker_result`, `evidence_packet`, and `release_result` schemas have unit tests for success, blocked, retryable fail, and terminal fail payloads.
- Workflow-defined custom artifact schemas have tests for at least two non-coding workflow fixtures.
- Invalid artifact payloads are rejected and recorded as artifact rejection history.
- At least 12 artifact validation cases are tested.

### AC-18 Intake

- GitHub issue intake and local seeded intake each have automated tests.
- Intake is idempotent: running the same fixture twice produces one current issue row and at least two auditable intake/history facts.
- Local seeded intake tests run without GitHub credentials or GitHub projection calls.

### AC-19 Daemon Watch

- `northstar watch` has a testable loop abstraction.
- Watch mode tests cover restart reconstruction from SQLite, shutdown before starting new effects, and one-writer-per-project enforcement.
- Watch mode does not store runtime truth only in process memory.

### AC-20 Security

- Tests verify `inspect`, logs, history payload helpers, and projection error rendering redact token-shaped values.
- Runtime rejects artifact payloads containing raw transcript/log fields above configured compact-size limits.
- Credential provider tests use fake providers and do not require real tokens.

### AC-21 Packaging

- `package.json` defines a `northstar` CLI binary.
- The supported Node version range is declared.
- A local install/run test verifies the CLI can load config and print version/help output.

### AC-22 Code Goal Mapping

- A planning document exists that maps AC-01 through AC-23 to implementation milestones.
- Each milestone lists verification commands.
- The final milestone requires `npm test` and any documented cross-platform/path test command.

### AC-23 Workflow Domain Generality

- Workflow fixtures exist for `content_creation_publish` and `office_report_delivery`.
- Both fixtures use domain-specific stage names, role names, artifact kinds, effect kinds, and projection target names while mapping only to fixed runtime lifecycle states.
- Tests prove the fixed lifecycle state set remains unchanged and workflow validation rejects domain-specific lifecycle states.
- Tests prove workflow validation accepts workflow-defined artifact schemas, event mappings, effects, and projection targets without hard-coded coding role chains.
- State-machine or engine tests prove domain workflow state advances or records facts through canonical child artifact, gate result, effect result, projection result, and heartbeat events.

## Dependency Decision Gate

Before implementation starts, the project must add a short dependency decision record under `docs/decisions/` that pins these choices:

- OpenCode SDK package and version range
- Codex SDK package and version range
- SQLite package
- workflow package format for version 1
- npm package name

The first implementation should prefer YAML workflow packages because they are easy for operators to inspect and override. TypeScript workflow modules may be added later only if a real workflow needs executable extension points.

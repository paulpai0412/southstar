# Northstar Skill Phase Command Design

Date: 2026-06-01

Status: Draft for review

## Purpose

Northstar skill should become the operator-facing entrypoint for using Northstar from any consumer repository. The user should not need to remember low-level CLI details, runtime states, GitHub Project field names, or recovery commands before they can run software-development automation safely.

The skill set should use a phase-based workflow with stable aliases:

- planning and issue decomposition
- consumer repository setup
- guided execution
- runtime and GitHub observability
- recovery
- project completion reporting

## Current Gap

The current skill already contains planning-oriented intents such as `/northstar-grill`, `/northstar-to-spec`, `/northstar-to-plan`, and `/northstar-to-issues`. It also has natural-language intents and script mappings for setup, run, status, and recover.

The gap is consistency:

- planning commands are visible as explicit slash-style intents
- production operation commands are partially implicit
- init/watch/recovery/report behavior is not yet organized as a clear phase model
- command details are concentrated in `SKILL.md`, making the skill harder to maintain as behavior grows
- consumer repo users still need to understand `.northstar.yaml`, GitHub labels, Project views, watch/manual flow, and recovery rules

## Design Decision

Use **phase workflow first**, with common aliases.

Primary commands:

| Command | Purpose |
| --- | --- |
| `/northstar-plan` | Interactive planning entrypoint for grill, spec, plan, and issue generation. |
| `/northstar-setup` | Initialize or validate consumer repo config, credentials, Project viewer, and runtime prerequisites. |
| `/northstar-execute` | Guided execution of ready issues through watch/manual flow. |
| `/northstar-observe` | Inspect runtime, GitHub issue/PR, Project viewer, and progress evidence. |
| `/northstar-recover` | Diagnose and repair runtime/GitHub/Project inconsistencies. |
| `/northstar-report` | Produce project completion report and execution evidence. |

Common aliases:

| Alias | Maps To |
| --- | --- |
| `/northstar-init` | `/northstar-setup` |
| `/northstar-watch` | `/northstar-execute` |
| `/northstar-status` | `/northstar-observe` |
| `/northstar-recovery` | `/northstar-recover` |

Planning aliases:

| Alias | Maps To |
| --- | --- |
| `/northstar-grill` | `/northstar-plan` grill mode |
| `/northstar-to-spec` | `/northstar-plan` spec mode |
| `/northstar-to-plan` | `/northstar-plan` implementation-plan mode |
| `/northstar-to-issues` | `/northstar-plan` issue-table mode |

Low-level CLI commands such as `intake`, `start`, `reconcile`, `release`, `inspect`, `repair-runtime`, and `retry-sync` remain available as advanced operator actions. They should not become the primary skill UX.

## Skill File Structure

Keep one top-level skill and split command details into references.

Target layout:

```text
skills/northstar/
  SKILL.md
  references/
    commands/
      plan.md
      setup.md
      execute.md
      observe.md
      recover.md
      report.md
    issue-table-schema.md
    project-viewer.md
    safety-rules.md
    training-manual.md
  scripts/
    doctor.mjs
    render-config.mjs
    sync-global.mjs
    lib/
      operator-commands.mjs
```

`SKILL.md` should contain only:

- when to use the skill
- command map and aliases
- default safety rules
- which reference file to open for each command
- production mutation boundary rules

Each command reference should contain:

- intent
- required inputs
- interaction flow
- CLI mapping
- GitHub Project behavior
- recovery behavior
- acceptance checklist
- report output expectations

## Command Behavior

### `/northstar-plan`

`/northstar-plan` is the high-level planning entrypoint.

It should ask which planning mode to use:

- grill requirements
- write design/spec
- write implementation plan
- convert plan into Northstar-ready GitHub issue table

The issue-table mode must generate issues sized so one root session can realistically complete each issue.

Issue rows should include:

- title
- body
- acceptance criteria
- priority
- dependencies
- labels
- Project Status
- Northstar Lifecycle
- Current Stage
- workflow id/domain
- suggested role

### `/northstar-setup`

`/northstar-setup` prepares a consumer repo.

It should:

- locate or create `.northstar.yaml`
- validate package-local Northstar access
- validate GitHub credentials without printing secrets
- validate Codex/OpenCode credentials without printing secrets
- validate workflow and role config
- check GitHub Project fields and views
- ask before creating or repairing Project viewer resources
- run doctor checks

### `/northstar-execute`

`/northstar-execute` uses **guided auto** by default.

Flow:

1. Load `.northstar.yaml`.
2. Discover open GitHub issues labeled `northstar:ready`.
3. Exclude non-ready, closed, completed, or blocked issues.
4. Resolve dependencies and priority.
5. Display execution queue.
6. Show workflow, role, host adapter, release mode, and Project target.
7. Ask for confirmation.
8. Run watch or a single-issue flow.
9. Record commands and results for later reporting.

The skill should not silently dispatch issues without showing the execution queue first.

### `/northstar-observe`

`/northstar-observe` reports the current state across:

- runtime SQLite state
- runtime history
- GitHub issue labels
- GitHub issue comments
- PR status
- Project fields
- Project views
- active worktrees
- leases and child runs

It should identify drift explicitly, for example:

- issue completed but Project still Ready
- PR merged but runtime not completed
- lifecycle labels accumulated
- Project item missing
- stale PR URL or Merge SHA

### `/northstar-recover`

`/northstar-recover` uses aggressive recovery with guards.

Safe automatic repairs:

- add missing Project item
- repair Project fields
- remove stale Northstar lifecycle labels
- retry completed projection sync
- reconcile closed issue plus merged PR into runtime completed
- reuse existing branch or PR
- retry retryable effect failures
- resume expired quarantined lease when safe

Actions requiring explicit confirmation:

- rerun implementation worker
- rerun verifier
- force release or merge
- close or reopen GitHub issue
- modify main after merge

The recovery command must prefer idempotent repair before rerunning workers.

### `/northstar-report`

`/northstar-report` produces a Project completion report.

Default report sections:

- project summary
- issue completion status
- PR and merge evidence
- dependency ordering result
- verification output
- browser/UAT evidence when available
- GitHub Project consistency
- recovery actions
- unresolved blockers
- follow-up recommendations

Training manual output should be optional, for example through `--training-manual` or an interactive confirmation.

## GitHub Project Viewer Behavior

Project viewer setup is interactive by default.

Required fields:

- Status
- Northstar Lifecycle
- Current Stage
- Priority
- Dependencies
- PR URL
- Merge SHA
- Last Run At
- Recovery State

Recommended views:

- Northstar Board
- Active Runs
- Blocked Recovery
- Release Evidence
- Completed

If fields or views are missing, the skill should list the diff and ask whether to create or repair them. It must not silently mutate a user Project.

## Operator Command Mapping

The skill command router should map phase commands to existing CLI operations.

Expected mapping:

| Skill Command | CLI / Script Mapping |
| --- | --- |
| `/northstar-plan` | planning reference flow; `/northstar-to-issues` may call `northstar plan-issues` |
| `/northstar-setup` | doctor, render-config, Project viewer validation |
| `/northstar-execute` | `northstar watch` or issue-specific intake/start/reconcile/release |
| `/northstar-observe` | `northstar inspect --summary` plus Project/PR checks |
| `/northstar-recover` | `northstar repair-runtime`, `retry-sync`, completed reconcile |
| `/northstar-report` | inspect summary, runtime history, GitHub evidence aggregation |

Aliases must resolve to the same command records as their primary command.

## Safety Rules

The skill must preserve these rules:

- do not print or write secrets
- do not mutate GitHub Project without confirmation
- do not dispatch ready issues without showing the execution queue first
- do not create duplicate PRs for the same issue
- do not rerun SDK workers during recovery without confirmation
- do not use fake adapters in production operation flow
- do not require live GitHub credentials for offline skill tests
- keep low-level CLI commands available for advanced operator use, but do not make them the primary UX

## Acceptance Criteria

### Command UX

- AC-SKILL-01: `SKILL.md` documents the six primary phase commands.
- AC-SKILL-02: `SKILL.md` documents common aliases.
- AC-SKILL-03: `SKILL.md` documents planning aliases.
- AC-SKILL-04: Each primary command has a reference file.
- AC-SKILL-05: The skill tells the agent which reference file to read for each command.

### Command Mapping

- AC-SKILL-06: Operator command mapping resolves all six primary commands.
- AC-SKILL-07: Operator command mapping resolves all common aliases.
- AC-SKILL-08: Planning aliases resolve to `/northstar-plan` modes.
- AC-SKILL-09: Unknown command returns a clear unsupported-command error.
- AC-SKILL-10: Low-level issue actions remain available as advanced actions.

### Guided Execution

- AC-SKILL-11: `/northstar-execute` produces an issue queue before starting watch.
- AC-SKILL-12: Queue includes issue number, title, priority, dependencies, workflow, role, host adapter, and release mode.
- AC-SKILL-13: Execution requires explicit confirmation unless a documented non-interactive flag is used.
- AC-SKILL-14: Dependency ordering is shown before execution.

### Recovery

- AC-SKILL-15: `/northstar-recover` distinguishes safe automatic repairs from confirmation-required repairs.
- AC-SKILL-16: Projection repair, stale label cleanup, completed reconcile, and branch/PR reuse are safe repairs.
- AC-SKILL-17: Worker rerun, verifier rerun, force release, issue close/reopen, and post-merge main mutation require confirmation.

### Project Viewer

- AC-SKILL-18: `/northstar-setup` or `/northstar-observe` can detect missing Project fields.
- AC-SKILL-19: Missing Project fields/views are reported as a diff.
- AC-SKILL-20: Project viewer creation or repair requires confirmation.

### Reporting

- AC-SKILL-21: `/northstar-report` produces project summary, issue/PR/merge evidence, dependency ordering, verification, recovery actions, and unresolved blockers.
- AC-SKILL-22: Training manual output is optional, not default.

### Offline Verification

- AC-SKILL-23: Tests cover command parser and alias mapping.
- AC-SKILL-24: Tests cover reference file presence.
- AC-SKILL-25: Tests cover local consumer repo simulation without GitHub token.
- AC-SKILL-26: Offline tests do not require network, GitHub credentials, Codex credentials, OpenCode credentials, or host CLIs.

### Global Skill

- AC-SKILL-27: Global skill sync preserves the same command map.
- AC-SKILL-28: Doctor can verify the synced global skill is usable.

## Out of Scope

This design does not require:

- live GitHub smoke
- real Project API mutation
- real SDK worker execution
- browser screenshots
- npm publishing
- OS service packaging

Those can be follow-up work after the offline skill UX and local simulation are stable.

## Open Questions

1. Should `/northstar-report --training-manual` be implemented as a flag, an interactive option, or a separate `/northstar-training-report` alias?
2. Should `/northstar-execute` support a documented non-interactive mode for CI, or should that remain CLI-only?
3. Should Project viewer repair prefer GitHub API first and Chrome automation fallback, or should Chrome automation be a separate explicit mode?

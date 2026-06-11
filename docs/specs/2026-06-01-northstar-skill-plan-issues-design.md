# Northstar Skill Plan-Issues Design

## Goal

Build a Northstar-specific skill workflow and production CLI command that turn clarified product/design work into Northstar-ready GitHub issues. The workflow should borrow the lightweight command-oriented UX from Matt Pocock-style skills, keep Superpowers-style spec and implementation planning rigor, and make all GitHub/Project/runtime mutations through Northstar production code.

## Background

Northstar already has a consumer-repo skill, config rendering, doctor checks, Project viewer definitions, runtime intake, watch scheduling, GitHub projection, and a `spec-plan-intake` helper that can generate issue drafts from a spec and implementation plan. The current gap is that issue generation is not a complete production flow: there is no first-class `northstar plan-issues` command that can create or reuse GitHub issues, assign labels, sync GitHub Project fields, and write runtime intake snapshots in one idempotent operation.

The target user experience should feel like a dedicated Northstar skill rather than a set of manual `gh` commands. The skill should guide users from idea clarification to spec, implementation plan, issue table, GitHub issues, Project visibility, and runtime-ready work.

## Non-Goals

- Do not copy Matt Pocock's skills verbatim into Northstar.
- Do not make skill prompt text the only place where GitHub mutations are defined.
- Do not make `npm test` depend on GitHub tokens, network access, OpenCode/Codex credentials, or host CLIs.
- Do not store generated Northstar product docs under `docs/superpowers`.
- Do not alter `runtime/state-machine.ts` purity.
- Do not implement content creation or office automation domain drivers as part of this work.

## Document Paths

Northstar-owned generated documents use Northstar product paths:

- Design specs: `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Implementation plans: `docs/plans/YYYY-MM-DD-<topic>-implementation-plan.md`

Superpowers remains a methodology source, not a document namespace for generated Northstar product artifacts.

## Skill UX

Extend `skills/northstar` with Matt Pocock-style, Northstar-specific intents:

- `/northstar-grill`
- `/northstar-to-spec`
- `/northstar-to-plan`
- `/northstar-to-issues`

The skill owns interaction, discovery, confirmation gates, and command planning. It must not scatter production GitHub mutations across prompt instructions. Any mutation that creates or updates GitHub issues, labels, Projects, Project fields, or runtime intake state must be performed by Northstar production CLI/API modules.

### `/northstar-grill`

Use this when requirements are unclear. Ask one question at a time and infer answers from local repo/docs/code when possible before asking the user. Questions should gather:

- target user and product goal
- workflow and domain
- completion definition
- acceptance criteria
- quantitative metrics
- required tests
- browser evidence needs
- external credential or production data risks
- whether each slice can be completed by one Northstar root session

### `/northstar-to-spec`

Create a design spec at `docs/specs/YYYY-MM-DD-<topic>-design.md`. The spec must include:

- problem and goal
- scope and out-of-scope
- workflow/domain
- user-visible behavior
- runtime and Project observability
- acceptance criteria
- quantitative metrics
- testing strategy
- risks and recovery behavior

### `/northstar-to-plan`

Create an implementation plan at `docs/plans/YYYY-MM-DD-<topic>-implementation-plan.md`. The plan should preserve Superpowers-style TDD structure: concrete files, failing tests, implementation steps, verification gates, and task boundaries. Plan tasks are inputs to issue generation, but a plan task is not automatically a GitHub issue unless it passes issue modeling gates.

### `/northstar-to-issues`

Call the production CLI:

```bash
node --run northstar -- plan-issues --config .northstar.yaml --spec <spec> --plan <plan> --dry-run
```

and, after explicit confirmation:

```bash
node --run northstar -- plan-issues --config .northstar.yaml --spec <spec> --plan <plan> --apply --confirm
```

The skill must show the issue table, dependency graph, ready/HITL split, Project mutation plan, runtime intake plan, and secret-scan result before apply.

## Production CLI

Add a first-class command:

```bash
northstar plan-issues --config <path> --spec <path> --plan <path> --dry-run
northstar plan-issues --config <path> --spec <path> --plan <path> --apply --confirm
```

Options:

- `--dry-run`: generate and validate the issue table without mutations.
- `--apply`: create/reuse/update GitHub issues and related projections.
- `--confirm`: required with `--apply`.
- `--github-only`: skip runtime intake writes.
- `--format json`: emit machine-readable output.

`--dry-run` must:

- perform zero GitHub, Project, or SQLite mutations
- parse spec and plan
- generate the issue table
- validate dependency graph
- evaluate `root_session_fit`
- scan for secret-shaped values
- check required Project schema
- report the exact apply mutation plan

`--apply --confirm` must:

- create or reuse GitHub issues
- apply labels
- add or reuse GitHub Project items
- sync Project fields
- rewrite dependency placeholders to real GitHub issue numbers
- write runtime intake snapshots/history by default
- skip runtime writes when `--github-only` is present
- preserve idempotency on repeated runs

## Issue Table Schema

Every generated issue table row must contain:

- `issue_key`
- `title`
- `type`: `AFK` or `HITL`
- `priority`
- `depends_on`
- `root_session_fit`
- `root_session_fit_reason`
- `acceptance_cluster`
- `required_tests`
- `browser_evidence_required`
- `workflow_id`
- `domain`
- `initial_lifecycle`
- `project_status`
- `current_stage`
- `source_spec`
- `source_plan`
- `source_fingerprint`

Issue body frontmatter is the source of truth for dependency and scheduling metadata:

```yaml
---
depends_on: [12, 13]
priority: 80
northstar:
  issue_key: ISS-003
  workflow_id: issue_to_pr_release
  domain: software_development
  type: AFK
  root_session_fit: true
  acceptance_cluster: auth-login
  browser_evidence_required: true
  required_tests:
    - npm test
    - npm run test:e2e
  source_spec: docs/specs/2026-06-01-auth-design.md
  source_plan: docs/plans/2026-06-01-auth-implementation-plan.md
  source_fingerprint: sha256:...
---
```

Each body must also include an idempotency marker:

```md
<!-- northstar-plan-issue
issue_key: ISS-003
source_fingerprint: sha256:...
-->
```

## Root Session Fit Gate

`root_session_fit = true` only when all conditions are met:

- acceptance criteria count is no more than 5
- required test command count is no more than 4
- estimated primary files/modules count is no more than 4
- no cross-domain work
- no human decision is required
- no external credentials, billing, or production data mutation are required
- work can complete in one PR
- work can be verified by automated tests or browser evidence

If any condition fails:

- `root_session_fit = false`
- issue type is `HITL` unless the planner can split the work into valid AFK slices
- do not add `northstar:ready`
- add `northstar:blocked`
- Project `Status = Blocked`
- Project `Northstar Lifecycle = blocked`
- `Blocked By` or `Last Error` explains the reason

## Label Semantics

AFK issue with `root_session_fit=true`:

- GitHub issue remains open
- add `northstar:ready`
- Project `Status = Todo`
- Project `Northstar Lifecycle = ready`
- Project `Current Stage = implementation`

HITL issue or `root_session_fit=false`:

- GitHub issue remains open
- do not add `northstar:ready`
- add `northstar:blocked`
- Project `Status = Blocked`
- Project `Northstar Lifecycle = blocked`
- Project `Blocked By` or `Last Error` explains the blocker

User-defined labels must be preserved.

## Project Fields And Views

Required Project fields:

- `Status`
- `Northstar Lifecycle`
- `Current Stage`
- `Northstar PR`
- `Northstar Merge SHA`
- `Last Error`
- `Retry Count`
- `Blocked By`
- `Priority`
- `Depends On`
- `Root Session Fit`
- `Issue Type`
- `Acceptance Cluster`
- `Required Tests`
- `Source Plan`
- `Source Fingerprint`

Required Project views:

- `Northstar Board`
- `Active Runs`
- `Planning`
- `Blocked Recovery`
- `Release Evidence`
- `Completed`

The issue body/frontmatter is the source of truth. Project fields are projections for observability and must be retryable if GitHub Project sync fails.

## Idempotency And Reuse

Apply must be safe to rerun.

Reuse lookup order:

1. Search existing issues for the `northstar-plan-issue` marker and matching `issue_key`/`source_fingerprint`.
2. If marker is absent, title matches may be reported as warnings, but must not automatically reuse unless explicitly confirmed by the implementation design.

Apply behavior:

- issue absent: create issue
- issue exists and open: update body/labels/Project fields/runtime intake as needed
- issue exists and closed with runtime completed: do not rewrite completed evidence; repair Project evidence only
- issue exists and closed without runtime completed: mark as external completion candidate and let reconcile/watch converge

Repeated apply must not create duplicate issues.

## Dependency Handling

Dry-run dependencies use issue keys such as `ISS-001`.

After apply:

- dependency placeholders are rewritten to GitHub issue numbers
- frontmatter `depends_on` contains numeric GitHub issue numbers
- body includes human-readable markers such as `Depends-On: #12`
- scheduler reads stable dependency metadata from body/frontmatter
- Project `Depends On` displays the human-readable dependency list

Dependency cycles and missing references must fail before mutation.

## Runtime Intake

By default, apply writes runtime intake snapshots/history for AFK ready issues. `--github-only` disables runtime writes.

Runtime intake rules:

- AFK `root_session_fit=true` issues enter `ready`
- HITL or blocked issues must not be dispatchable by watch
- runtime intake must be idempotent on repeated apply
- runtime history must not contain secrets
- projection failures must be retryable and must not mutate lifecycle

## Security

All generated content and stored history must pass secret-shape scanning. The scanner must reject at least:

- GitHub token-like values
- OpenAI/Codex/OpenCode API key-like values
- long high-entropy base64-like strings

Secrets must not be written to:

- repo files
- docs
- tests
- logs
- SQLite history
- worker prompts
- GitHub issue comments
- GitHub Project fields

## Tests

Unit tests must cover:

- spec + plan to issue table
- complete issue table fields
- root session fit pass/fail cases
- dependency graph preservation
- dependency cycle failure
- missing dependency failure
- secret scan failures
- idempotency marker and fingerprint generation
- ready vs blocked label semantics
- dry-run mutation count is zero
- apply requires `--confirm`
- `--github-only` skips runtime intake

Offline E2E must cover:

- dry-run no mutation
- apply creates AFK ready issues and blocked HITL issues through fake gateways
- Project field sync through fake Project gateway
- runtime snapshots only for AFK ready issues
- scheduler sees only AFK ready issues
- repeated apply reuses issues and creates zero duplicates
- Project projection failure becomes retryable and does not fail lifecycle

Live GitHub E2E must be separate from `npm test` and guarded by explicit flags. It must validate a configured sandbox consumer repo without hardcoding that repo in production source.

Live acceptance requires:

- create at least 2 AFK issues
- create at least 1 HITL/blocked issue
- create at least 1 dependency edge
- AFK issues have `northstar:ready`
- HITL issues do not have `northstar:ready`
- Project fields are synced for Status, Lifecycle, Stage, Priority, Depends On, Root Session Fit, Issue Type, Acceptance Cluster, Required Tests, Source Plan, and Source Fingerprint
- repeated apply creates zero duplicate issues
- runtime intake contains AFK ready snapshots
- `watch --max-cycles 1` sees AFK ready issues and does not dispatch HITL/blocked issues

## Quantitative Acceptance Criteria

- `northstar_skill_matt_style_commands_documented >= 4`
- `plan_issues_cli_command_exists = 1`
- `plan_issues_dry_run_mutations = 0`
- `plan_issues_issue_table_fields >= 16`
- `plan_issues_root_session_fit_gate_cases >= 4`
- `plan_issues_secret_scan_cases >= 2`
- `plan_issues_dependency_edges_preserved >= 1`
- `plan_issues_apply_requires_confirm = 1`
- `plan_issues_apply_created >= 1`
- `plan_issues_apply_reused >= 1`
- `plan_issues_duplicate_issues_created = 0`
- `plan_issues_ready_labels_applied >= 1`
- `plan_issues_blocked_labels_applied >= 1`
- `plan_issues_project_items_created >= 1`
- `plan_issues_project_fields_synced >= 8`
- `plan_issues_runtime_intake_snapshots_created >= 1`
- `plan_issues_github_only_runtime_writes = 0`
- `plan_issues_project_projection_failures_retryable >= 1`
- `plan_issues_secret_leaks = 0`
- `production_shell_chain_commands = 0`

## Verification Gate

Implementation must pass:

```bash
npm test
npm run test:e2e
npm run test:coverage
node --run northstar -- --help
node --run northstar -- plan-issues --help
node --run northstar -- plan-issues --config <fixture> --spec <fixture> --plan <fixture> --dry-run
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests skills
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src skills
git status --short
```

Live verification must be guarded, for example:

```bash
NORTHSTAR_PLAN_ISSUES_LIVE=1 \
GITHUB_TOKEN="$(gh auth token)" \
NORTHSTAR_LIVE_GITHUB_REPO=<owner/repo> \
NORTHSTAR_LIVE_GITHUB_PROJECT_ID=<project-id> \
npm run test:e2e:plan-issues-live
```

If live credentials are absent, live tests must clearly skip or fail with actionable missing configuration. They must not pretend to pass.

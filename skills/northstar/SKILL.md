---
name: northstar
description: Operate Northstar from a consumer repository: bootstrap config, run doctor checks, watch ready issues, operate one issue, observe progress, recover stuck issues, and sync this skill globally.
---

# Northstar Global Skill

Use this skill when the user asks to set up, operate, observe, or recover Northstar in a consumer repository.

## Phase Command Model

Northstar uses **phase workflow first**. Prefer these phase commands over low-level CLI names:

| Command | Purpose |
| --- | --- |
| `/northstar-plan` | Interactive planning entrypoint for grill, spec, implementation plan, and issue generation. |
| `/northstar-setup` | Initialize or validate consumer repo config, credentials, Project viewer, and runtime prerequisites. |
| `/northstar-execute` | Guided auto execution of ready issues through watch or a single-issue flow. |
| `/northstar-observe` | Inspect runtime, GitHub issue/PR, Project viewer, and progress evidence. |
| `/northstar-recover` | Diagnose and repair runtime, GitHub, and Project inconsistencies using aggressive recovery with guards. |
| `/northstar-report` | Produce a project completion report with issue, PR, merge, verification, and recovery evidence. |

Common aliases:

- `/northstar-init` maps to `/northstar-setup`.
- `/northstar-watch` maps to `/northstar-execute`.
- `/northstar-status` maps to `/northstar-observe`.
- `/northstar-recovery` maps to `/northstar-recover`.

Planning aliases:

- `/northstar-grill` maps to `/northstar-plan` grill mode and CLI `plan-grill --brief <path> --dry-run`.
- `/northstar-to-spec` maps to `/northstar-plan` spec mode and CLI `plan-spec --brief <path> --answers <path> --out <spec>`.
- `/northstar-to-plan` maps to `/northstar-plan` implementation-plan mode and CLI `plan-implementation --spec <path> --out <plan>`.
- `/northstar-to-issues` maps to `/northstar-plan` issue-table mode and CLI `plan-issues --spec <path> --plan <path> --dry-run`.

Planning content contracts:

- `/northstar-grill` follows `northstar:planning-grill`: ask exactly one question at a time, walk the decision tree branch-by-branch, inspect code/docs instead of asking when the answer is discoverable, and wait for user approval before moving to PRD/spec or implementation.
- `/northstar-to-spec` follows `northstar:planning-spec`: synthesize the already resolved context into a PRD/spec; do not interview the user again. The PRD/spec must include problem/objective, solution, numbered user stories, implementation decisions, testing decisions, out-of-scope items, major modules, and deep-module opportunities.
- `/northstar-to-plan` follows `northstar:implementation-planning`: create a runtime-ready execution contract from the PRD/spec. The plan must include checkbox steps, exact commands, expected outcomes, focused verification, commit boundaries, workflow-stage mapping, issue-slicing hints, and runtime/Project evidence expectations.
- `/northstar-to-issues` follows `northstar:issue-slicing`: convert the PRD/spec and implementation plan into independently grabbable tracer-bullet vertical slices. Each issue must be narrow, end-to-end, classified as AFK or HITL, dependency-aware, and reviewed for granularity/dependencies before `--apply --confirmed`.

`/northstar-execute` must use Guided auto by default: show the issue queue, dependency order, workflow, role, host adapter, release mode, and expected effects before starting watch.

## Core Rules

- Treat the current directory as the consumer repository unless the user gives another path.
- Do not write `.northstar.yaml` until the user confirms the generated draft.
- Do not create or modify GitHub Projects, fields, or views until the user confirms.
- Do not write secrets to config, docs, logs, SQLite history, worker prompts, Project fields, issue comments, or PR comments.
- Use Northstar CLI through an explicit `--config` path.
- Prefer the local Northstar repository discovered by `NORTHSTAR_ROOT` or doctor checks.
- Use package or `npx northstar` mode only when configured or when local mode is unavailable and the user confirms.
- Use safety-gated recovery. Low-risk inspect/reconcile actions may run automatically; medium/high-risk actions require confirmation.
- When the user asks to guide a project from zero to completion, use the Interactive Ask-Question Workflow.
- Do not take over implementation, verification, browser/UI testing, merge, branch, or worktree cleanup for Northstar issues. Those are worker responsibilities. The operator may observe, approve a manual release gate, run low-risk reconcile, or repair runtime bugs in Northstar itself.
- When creating validation issues after runtime changes, prefer the requested host adapter in `.northstar.yaml` before issue creation. For Pi validation use `runtime.host_adapter: pi` and confirm doctor accepts `@earendil-works/pi-coding-agent`.

## Fast Path Commands

Set paths once and reuse explicit argv. Replace issue numbers and repo paths; do not rely on shell aliases or implicit config discovery.

```bash
export NORTHSTAR_ROOT=/path/to/northstar
npm run northstar -- doctor --config /path/to/consumer/.northstar.yaml --json
npm run northstar -- inspect --config /path/to/consumer/.northstar.yaml --issue 15 --json
npm run northstar -- watch --config /path/to/consumer/.northstar.yaml --bounded --max-cycles 40 --idle-timeout-seconds 120
npm run northstar -- release --config /path/to/consumer/.northstar.yaml --issue 15 --confirmed
npm run northstar -- reconcile --config /path/to/consumer/.northstar.yaml --issue 15
npm run northstar -- repair-runtime --config /path/to/consumer/.northstar.yaml --issue 15 --dry-run
```

Use GitHub CLI for read-only cross-checks when authenticated:

```bash
gh issue view 15 --repo owner/repo --json number,state,closedAt,labels,url
gh pr view 16 --repo owner/repo --json number,state,mergedAt,mergeCommit,headRefName,baseRefName,url
```

## Lifecycle Semantics

Use these meanings when interpreting the board, runtime DB, and Project fields:

| State | Meaning | Operator action |
| --- | --- | --- |
| `ready` | Ready to dispatch the current `stage_cursor` stage. | `start` or `watch`. |
| `running` | Implementation worker active. | Observe or reconcile only. |
| `verifying` | Verifier worker active. | Observe or reconcile only. |
| `verified` | Verification passed and release can be started. | Auto release may dispatch release; manual mode moves to `release_pending`. |
| `release_pending` | Waiting for human release approval. No worker is active. | Show/press `Approve Release`, then run `release --confirmed`. |
| `releasing` | Release worker active and owns git/merge/cleanup. | Observe or reconcile only. |
| `quarantined` | Automatic exception policy stopped and requires operator resume. | Inspect evidence before resume; do not clear fields blindly. |
| `completed` | Release confirmed and terminal cleanup recorded. | Report evidence. |

`release_pending` is not an active worker state. `releasing` is the active release state. A dashboard that cannot show both states is stale.

## Worker And Git Boundaries

- Implementation worker owns issue branch/worktree creation and code commits for the feature. It should reuse an existing issue worktree/branch on retry or resume unless the worktree is corrupt; prompts must say this explicitly.
- Verifier worker owns functional acceptance checks, tests, and browser/UI validation when the issue has UI acceptance criteria. It must return evidence, not just `pass`.
- Release worker owns PR merge, release evidence, managed sync worktree update, and issue worktree cleanup. If repo root cannot be checked out or pulled because it is dirty or on another branch, release may still complete when the managed sync worktree matches `origin/main` and `repo_root_sync` records `skipped` with the reason.
- Root/operator code must not run feature git operations for the worker. Root may repair Northstar runtime bugs, run read-only git status/log checks, or commit Northstar/pi-web code changes when the user explicitly asks.
- For local repo development, inspect scope with `git status -sb` and `git diff --stat`; stage explicit paths; commit separately per repo; push the current branch. Avoid `git add -A` when the worktree contains unrelated changes.

## Artifact And Retry Rules

- Artifacts must be contract-shaped before a worker finishes. Prompts should require the worker to self-check required fields against the contract.
- Implementation artifacts must include workspace evidence such as branch/worktree id, `base_source`, and `base_commit` so stale-base failures are diagnosable.
- Verifier `failed_retryable` must carry actionable feedback forward to the next implementation or release stage even when the artifact lacks a dedicated feedback field. Preserve status, stage, failing area, command output summary, and concrete next action.
- Route verifier failures by failure domain: product/build/test/UI acceptance failures return to implementation; GitHub mergeability, branch freshness, PR merge, local sync, or cleanup failures belong to release when the implementation artifact is otherwise accepted.
- Exception flow should retry the same stage under the same conditions first. After configured retries are exhausted, apply stage-aware field clearing and quarantine for human resume.
- Resuming from quarantine should continue with the original issue branch/worktree when available and healthy. It should not start a new worktree just because the issue was quarantined.

## Natural Language Intents

- "Set up this repo for Northstar."
- "Setup this repo for Northstar."
- "Check whether Northstar can run here."
- "Start watching ready issues."
- "Run issue #123."
- "Inspect issue #123."
- "Release issue #123."
- "Plan issues from this spec and implementation plan."
- "Show Northstar progress."
- "Show Northstar status."
- "Recover issue #123."
- "Recover stuck issues."
- "Open the Northstar Project viewer."
- "Sync the Northstar skill globally."
- "Guide me through a new Northstar project."
- "Use questions to run Northstar from init to completion."

## Workflows

### Interactive Ask-Question Workflow

Use this when the user wants an interactive Northstar automation flow for a consumer repo. Ask one short multiple-choice question at a time and wait for the user's answer before continuing. Do not perform file, GitHub, Project, issue, PR, or release mutations until the step explicitly reaches a confirmation gate.

After each answer:

1. Record the selected option in the working summary.
2. Run only read-only discovery needed for the next question.
3. State the next action and ask the next question.

#### Step 1: Project Entry

Ask:

`What should Northstar do with this project?`

- A. Initialize a new consumer repo
- B. Check an existing repo
- C. Take over existing GitHub issues

Read-only actions after the answer: run doctor/preflight, detect git root, GitHub remote, default branch, and existing `.northstar.yaml`.

#### Step 2: Project Type

Ask:

`What kind of project should this workflow produce or maintain?`

- A. Web app
- B. Library or backend
- C. Documentation or automation
- D. Other software-development project

Use `software_development` / `issue_to_pr_release` unless the user explicitly asks for a deferred domain. If they choose a deferred domain such as content creation or office automation, explain that the domain slot is recognized but the production driver is not implemented yet.

#### Step 3: GitHub Repository

Ask:

`How should Northstar connect to GitHub?`

- A. Use the existing GitHub remote
- B. Create a new GitHub repo
- C. Local-only draft setup for now

GitHub Mutation Gate: before creating a repo or labels, show the exact repo owner/name, default branch, and command plan. Wait for explicit confirmation.

#### Step 4: Project Viewer

Ask:

`How should progress be shown in GitHub Projects?`

- A. Create or update GitHub Project viewer
- B. Use an existing Project
- C. Disable Project viewer for now

If enabled, plan fields and views before mutation. Required fields are `Status`, `Northstar Lifecycle`, `Current Stage`, `PR URL`, `Merge SHA`, `Last Error`, `Retry Count`, and `Blocked By`. Required views are `Northstar Board`, `Active Runs`, `Blocked Recovery`, and `Release Evidence`.

If the GitHub Project field API works but the Project view API is unavailable or incomplete, use Chrome automation to operate the GitHub UI after the user confirms the Project mutation plan. Do not tell the user to create the views manually. Use the logged-in browser session, keep secrets out of screenshots/logs, and verify the visible Project UI after each view is created or updated.

#### Step 5: Issue Source

Ask:

`How should Northstar create or select work items?`

- A. Generate issues from a spec and implementation plan
- B. Use existing GitHub issues with `northstar:ready`
- C. Manually draft the first batch of issues

For generated issues, dry-run first. Show issue titles, dependency markers, acceptance criteria, quantitative metrics, and secret-scan results. GitHub Mutation Gate: only create issues after explicit confirmation.

#### Step 6: Scheduling

Ask:

`How should issues be scheduled?`

- A. Single issue first
- B. Sequential dependency flow
- C. Parallel flow
- D. Mixed dependency graph

For parallel or mixed scheduling, confirm `runtime.development_capacity` and dependency ordering. Never dispatch dependency-blocked issues.

#### Step 7: Execution Mode

Ask:

`How should Northstar execute the work?`

- A. Manual one-issue run
- B. Watch daemon auto-runs northstar:ready
- C. Dry-run only

Configuration Gate: write `.northstar.yaml` only after the user confirms the draft. Execution Gate: before starting `watch`, `start`, `reconcile`, or `release`, show the exact `northstar` command argv and expected effects.

#### Step 8: Monitoring

Ask:

`How should I report progress while Northstar runs?`

- A. Concise status updates only
- B. Detailed issue/PR/Project table
- C. Browser-verified Project viewer monitoring

Progress reports must include active issues, lifecycle, GitHub Project `Status`, `Northstar Lifecycle`, current stage, PR URL, merge SHA, blockers, retryable failures, and next action. Use browser verification when the user wants viewer confirmation.

#### Step 9: Recovery Policy

Ask:

`How should Northstar handle abnormal execution?`

- A. Auto-run low-risk reconcile and ask for risky actions
- B. Ask before every recovery action
- C. Stop immediately and report diagnostics

Classify failures as stale lock, expired lease, SDK failure, runtime invariant violations (missing child run, invalid owner lease, host liveness loss), artifact validation failures, verifier artifact rejection, Project projection mismatch, browser/UAT failure, exception, quarantined, or failed. Apply workflow `exception_policy` automatic actions first (`retry_stage`, `retry_same_stage`, `return_to_stage`); use quarantine/fail only when rules demand or retries are exhausted. Recovery Gate: medium/high-risk actions require explicit confirmation.

#### Step 10: Completion Report

Ask:

`What completion report do you need?`

- A. Short summary
- B. Full audit report
- C. Training-manual style report

Final reports must include repo URL, Project URL when enabled, issue URLs, PR URLs, merge SHAs, dependency order, browser/UAT evidence when applicable, recovery actions, unresolved blockers, and recommended next steps.

### Bootstrap

1. Run doctor checks.
2. Detect git root, GitHub remote, default branch, and existing `.northstar.yaml`.
3. Render a config draft with `runtime.auto_release: true`, `runtime.host_adapter: codex`, and `github.project.enabled: false`, plus a workflow file draft copied from `skills/northstar/templates/workflow.issue-to-pr-release.yaml`.
4. Plan labels and Project fields/views.
5. Show the draft summary, label plan, Project plan, and doctor command argv arrays.
6. Ask before writing `.northstar.yaml` and `.northstar/workflows/issue-to-pr-release.yaml`.
7. Ask separately before creating or mutating Project fields/views.

### Operate

Map issue operations to Northstar CLI command plans:

- `intake`
- `start`
- `reconcile`
- `release`
- `inspect`
- `watch`
- `run` maps to `watch`
- `status` maps to `inspect --summary`
- `recover` maps to `repair-runtime`

### Plan Issues

1. For `/northstar-grill`, read the brief and run `plan-grill --config <config> --brief <brief> --dry-run`. Use the returned `nextQuestion` as the only user-facing question. Do not dump the entire question queue unless the user asks for an audit view.
2. Continue grilling until decisions that affect architecture, dependency order, verification, and Project/GitHub mutation gates are resolved. If a question can be answered by reading source, docs, config, history, or runtime state, inspect those instead of asking.
3. For `/northstar-to-spec`, run `plan-spec --config <config> --brief <brief> --answers <answers> --out <spec>` only after the grill direction is approved. This stage synthesizes known context; it must not ask fresh interview questions.
4. For `/northstar-to-plan`, run `plan-implementation --config <config> --spec <spec> --out <plan>`. The plan must be a `northstar:implementation-planning` execution contract with checkbox steps, exact commands, expected results, commit boundaries, workflow-stage mapping, issue-slicing hints, and runtime/Project evidence expectations.
5. For `/northstar-to-issues`, read the design spec and implementation plan named by the user, then run `plan-issues --config <config> --spec <spec> --plan <plan> --dry-run` by default.
6. Review generated titles, source spec/plan paths, dependency markers, AFK/HITL classification, vertical-slice scope, acceptance criteria, quantitative metrics, required tests, and secret-scan results.
7. Ask for explicit confirmation before issue creation; only run `plan-issues --apply --confirmed` after the GitHub Mutation Gate is approved.
8. Stop before mutation if the dependency graph has a cycle, an issue is a horizontal layer-only slice, granularity/dependencies are unapproved, or generated issue content contains secret-shaped values.

### Recover

1. Inspect runtime and GitHub state.
2. Diagnose stuck state.
3. Produce recovery options for stale locks, runtime invariants, artifact validation failures, verifier artifact rejections, failed or quarantined issues, stale branches or PRs, and Project projection failures.
4. Ask before medium or high-risk actions.

### Status

1. Read runtime status, GitHub issue/PR status, and Project status.
2. Summarize active issues, exception issues pending reconcile, quarantined issues, stale locks, ready issues, open PRs, Project mismatches, blocked items, and release evidence.
3. Keep the report read-only.

### Raw SQLite Inspection

Prefer `inspect --summary` or `inspect --issue <number>` for runtime state. If direct SQLite inspection is needed, read `.schema issue_history` and `.schema issues` before writing a query. Do not invent transition-table columns.

Runtime table contract:

- `issue_history` columns are `id`, `issue_id`, `sequence`, `event_type`, `payload_json`, and `created_at`.
- `issues` columns are `id`, `lifecycle_state`, `current_session_id`, `worktree_path`, `runtime_context_json`, `snapshot_json`, and `updated_at`; `issues` uses `id` as the issue key.
- Runtime reasons and recovery facts are inside JSON payloads. Query them with `json_extract(payload_json,'$.reason')`, `json_extract(payload_json,'$.reason_code')`, `json_extract(payload_json,'$.code')`, or `json_extract(payload_json,'$.lifecycle')`.

Read-only examples:

```bash
sqlite3 .northstar/runtime/control-plane.sqlite3 ".schema issue_history"
sqlite3 .northstar/runtime/control-plane.sqlite3 "select sequence,event_type,created_at,payload_json from issue_history where issue_id='github:69' order by sequence;"
sqlite3 .northstar/runtime/control-plane.sqlite3 "select sequence,event_type,created_at,json_extract(payload_json,'$.reason_code') as reason_code,json_extract(payload_json,'$.code') as code from issue_history where issue_id='github:69' order by sequence;"
sqlite3 .northstar/runtime/control-plane.sqlite3 "select id,lifecycle_state,updated_at,runtime_context_json from issues where id='github:69';"
```

### Project Viewer

Project viewer setup uses `Northstar Lifecycle`, `Status`, `PR URL`, `Merge SHA`, `Current Stage`, `Last Error`, `Retry Count`, and `Blocked By`.

Required views:

- `Northstar Board` grouped by `Status`.
- `Active Runs` filtered to active `Status` values.
- `Blocked Recovery` filtered to blocked and failed items.
- `Release Evidence` showing `PR URL` and `Merge SHA`.
- `Completed` filtered to done items.

When Project view APIs are unavailable, the skill must use Chrome automation to create and verify the views in the GitHub UI. Browser Verification Gate: before considering Project setup complete, inspect the browser-visible Project viewer and confirm these exact views:

- Northstar Board: board layout grouped by Status.
- Active Runs: table layout filtered to Status In Progress, In Review, Ready to Release, or Releasing.
- Blocked Recovery: table layout filtered to Status Blocked or Failed.
- Release Evidence: table layout showing Merge SHA and PR URL.
- Completed: table layout filtered to Status Done.

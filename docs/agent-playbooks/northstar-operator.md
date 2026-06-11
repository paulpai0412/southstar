# Northstar Operator Playbook

This playbook is the shared Northstar operator contract for Codex, Claude, OpenCode, and Pi-agent wrappers. Agent-specific slash commands must stay thin: read this playbook, inspect the current repository when needed, and call the Northstar CLI through explicit argv.

## Root Rules

- Treat the current directory as the consumer repository unless the operator gives another path.
- Use `/home/timmypai/apps/northstar` as the local Northstar runtime root when available.
- Prefer `node --run northstar -- <command> --config <config>` from the Northstar repo for every CLI action.
- Do not write `.northstar.yaml`, mutate GitHub issues, mutate GitHub Projects, dispatch workers, or release PRs until the relevant gate below is approved.
- Do not write secrets to config, prompts, docs, logs, runtime history, issue comments, PR comments, or Project fields.
- Show exact argv before medium or high-risk actions.

## Slash Commands

| Slash command | Purpose | Default CLI action |
| --- | --- | --- |
| `/northstar-plan` | Interactive planning entrypoint | Start with `plan-grill` or ask for brief/spec paths |
| `/northstar-grill` | Ask one planning question at a time | `plan-grill --config <config> --brief <brief> --dry-run` |
| `/northstar-to-spec` | Convert approved context into PRD/spec | `plan-spec --config <config> --brief <brief> --answers <answers> --out <spec>` |
| `/northstar-to-plan` | Convert PRD/spec into execution plan | `plan-implementation --config <config> --spec <spec> --out <plan>` |
| `/northstar-to-issues` | Draft or create GitHub issue slices | `plan-issues --config <config> --spec <spec> --plan <plan> --dry-run` |
| `/northstar-setup` | Bootstrap or validate a consumer repo | `doctor --config <config>` |
| `/northstar-init` | Alias for setup | `doctor --config <config>` |
| `/northstar-execute` | Run ready issues | `watch --config <config>` after execution gate |
| `/northstar-watch` | Alias for execute | `watch --config <config>` |
| `/northstar-observe` | Inspect state | `inspect --config <config> --summary` |
| `/northstar-status` | Alias for observe | `inspect --config <config> --summary` |
| `/northstar-recover` | Diagnose and repair stuck runtime state | `repair-runtime --config <config>` after recovery gate |
| `/northstar-recovery` | Alias for recover | `repair-runtime --config <config>` |
| `/northstar-report` | Produce completion/audit report | `inspect --config <config> --summary` plus issue/PR evidence |

## Planning Contract

### Grill

- Follow the `northstar:planning-grill` contract.
- Ask exactly one question at a time.
- Walk the decision tree branch-by-branch.
- If the answer is discoverable from source, docs, config, runtime state, git history, or GitHub state, inspect those sources instead of asking the operator.
- Do not move to PRD/spec, implementation plan, issue creation, or execution until the operator approves the resolved direction.

### PRD / Spec

- Follow the `northstar:planning-spec` contract.
- Synthesize known context; do not restart an interview.
- Include objective, product requirements, user stories, implementation decisions, testing decisions, out-of-scope items, acceptance criteria, quantitative metrics, required tests, major modules, and deep-module opportunities.
- Leave unresolved questions in Open Questions instead of inventing answers.

### Implementation Plan

- Follow the `northstar:implementation-planning` contract.
- Use checkbox steps.
- Include exact commands and expected outcomes.
- Keep tasks bite-sized and independently verifiable.
- Include commit boundaries.
- Map the work to the runtime workflow stages that will execute it.
- Include issue-slicing guidance for downstream GitHub issue generation.
- State runtime, Project, PR, merge, browser, or test evidence expected for each task when applicable.
- Preserve Northstar architecture boundaries and avoid unrelated refactors.

### Issues

- Follow the `northstar:issue-slicing` contract.
- Generate tracer-bullet vertical slices, not horizontal layer-only tickets.
- Classify each issue as AFK or HITL.
- Include dependencies, acceptance criteria, quantitative metrics, required tests, source spec path, source plan path, and Northstar execution notes.
- Dry-run first. Create GitHub issues only after explicit approval and `--apply --confirmed`.

## Gates

- Configuration Gate: write `.northstar.yaml` only after the operator approves the draft.
- GitHub Mutation Gate: create labels, Project fields/views, or issues only after showing the exact repo, Project target, and argv.
- Execution Gate: start `watch`, `start`, `reconcile`, or `release` only after showing issue queue, dependencies, host adapter, workflow, release mode, and expected effects.
- Recovery Gate: run low-risk inspect/reconcile automatically when useful; ask before actions that can mutate branches, PRs, runtime lifecycle, Project state, or releases.

## Raw SQLite Inspection

- Prefer `inspect --summary` or `inspect --issue <number>` for runtime state.
- If direct SQLite inspection is needed, read `.schema issue_history` and `.schema issues` before writing a query. Do not invent transition-table columns.
- `issue_history` columns are `id`, `issue_id`, `sequence`, `event_type`, `payload_json`, and `created_at`.
- `issues` columns are `id`, `lifecycle_state`, `current_session_id`, `worktree_path`, `runtime_context_json`, `snapshot_json`, and `updated_at`; use `id` as the issue key.
- Runtime reasons and recovery facts are inside JSON payloads. Query them with `json_extract(payload_json,'$.reason')`, `json_extract(payload_json,'$.reason_code')`, `json_extract(payload_json,'$.code')`, or `json_extract(payload_json,'$.lifecycle')`.

Useful read-only examples:

```bash
sqlite3 .northstar/runtime/control-plane.sqlite3 ".schema issue_history"
sqlite3 .northstar/runtime/control-plane.sqlite3 "select sequence,event_type,created_at,payload_json from issue_history where issue_id='github:69' order by sequence;"
sqlite3 .northstar/runtime/control-plane.sqlite3 "select sequence,event_type,created_at,json_extract(payload_json,'$.reason_code') as reason_code,json_extract(payload_json,'$.code') as code from issue_history where issue_id='github:69' order by sequence;"
sqlite3 .northstar/runtime/control-plane.sqlite3 "select id,lifecycle_state,updated_at,runtime_context_json from issues where id='github:69';"
```

## CLI Examples

Run from `/home/timmypai/apps/northstar` unless the operator says otherwise:

```bash
node --run northstar -- plan-grill --config /path/to/repo/.northstar.yaml --brief docs/brief.md --dry-run
node --run northstar -- plan-spec --config /path/to/repo/.northstar.yaml --brief docs/brief.md --answers docs/answers.md --out docs/specs/feature.md
node --run northstar -- plan-implementation --config /path/to/repo/.northstar.yaml --spec docs/specs/feature.md --out docs/plans/feature.md
node --run northstar -- plan-issues --config /path/to/repo/.northstar.yaml --spec docs/specs/feature.md --plan docs/plans/feature.md --dry-run
node --run northstar -- inspect --config /path/to/repo/.northstar.yaml --summary
node --run northstar -- watch --config /path/to/repo/.northstar.yaml
```

## Agent Wrapper Requirements

- Codex: install `skills/northstar` as a Codex skill.
- Claude: expose slash commands that instruct Claude to follow this playbook.
- OpenCode: add `command` templates and include this playbook in `instructions` or command templates.
- Pi-agent: inject this playbook into the Pi SDK prompt/session context before asking Pi to operate Northstar.

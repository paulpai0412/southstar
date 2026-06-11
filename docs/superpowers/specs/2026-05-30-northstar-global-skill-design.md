# Northstar Global Skill Design

Date: 2026-05-30

## Purpose

Northstar can now execute a real software-development production path for a consumer repository: GitHub issue intake, isolated local issue worktree, SDK-backed implementation, git add/commit/push, pull request create/reuse, verifier, merge, issue close, and runtime completion. The remaining usability gap is that operators still need to know `.northstar.yaml`, environment requirements, CLI commands, issue labels, watch flow, manual issue flow, observability setup, and recovery commands.

This design adds a repo-managed Northstar Codex skill that turns those details into a natural-language operator surface. The first version is a Bootstrap + Operator skill: it can help a consumer repo connect to Northstar, verify readiness, operate issues, start long-running watch, inspect progress, and run safety-gated recovery.

The skill source lives inside the Northstar repository and can be synchronized to the global Codex skills directory.

## Current Capability Baseline

Northstar already has these production capabilities:

- Consumer repositories can connect through one `.northstar.yaml`.
- `northstar watch` can scan GitHub issues with the configured ready label.
- Manual CLI commands can intake, start, reconcile, release, and inspect one issue.
- The production default factory wires real GitHub gateway, git/worktree operator, Codex/OpenCode SDK workers, DomainDriverRegistry, and ProductionOrchestrator.
- Production live E2E has verified the local-worktree path through issue creation, SDK worktree modification, git add/commit/push, PR, merge, close issue, and runtime completed.
- Restart/resume semantics reuse existing worktree, branch, and PR without duplicate PR creation.
- GitHub labels, issue progress comments, PR verifier comments, and optional Project sync exist as observability surfaces.

The skill must not replace runtime behavior. It operates Northstar through documented CLI/config/GitHub boundaries.

## Product Shape

The first version supports these natural-language intents:

- "Set up this repo for Northstar."
- "Check whether Northstar can run here."
- "Start watching ready issues."
- "Run issue #123."
- "Inspect issue #123."
- "Release issue #123."
- "Show Northstar progress."
- "Recover issue #123."
- "Recover stuck issues."
- "Sync the Northstar skill globally."

The skill maps those intents to deterministic workflows:

- Bootstrap consumer config.
- Run platform and credential doctor checks.
- Operate Northstar CLI commands.
- Read runtime/GitHub progress.
- Diagnose and recover stuck issues with explicit risk gates.
- Synchronize repo-managed skill files to the global Codex skill directory.

## CLI Entry Strategy

The first version uses a dual-entry design:

- Default: local Northstar repository.
- Future-compatible: package or `npx northstar`.

The default local repository path is discovered in this order:

1. `NORTHSTAR_ROOT` environment variable.
2. Skill config, if present.
3. The current Northstar repository when the skill is run from the repo.
4. Common user workspace locations.

A developer-specific checked-out Northstar path may be configured locally, but no implementation may hardcode one user or operating-system path as the only supported location.

The skill validates the selected Northstar root before use:

- `package.json` exists.
- `node --run northstar -- --help` succeeds.
- `node --run northstar -- watch --help` succeeds.
- Required source files for the CLI entrypoint exist.

For consumer repos, the skill invokes Northstar with an explicit config path:

```bash
node --run northstar -- <command> --config /absolute/path/to/consumer/.northstar.yaml
```

The skill must not depend on `process.cwd()` being the Northstar repository.

## Consumer Repo Bootstrap

Bootstrap is confirmation-gated. The skill may draft config automatically, but it must not write `.northstar.yaml` until the user confirms.

Bootstrap detects:

- Consumer repo root.
- Git remote.
- Default branch.
- GitHub `owner/repo`.
- Existing `.northstar.yaml`.
- Existing Northstar runtime directory.
- Existing GitHub ready label.
- GitHub credential availability.
- Codex/OpenCode SDK readiness.

The generated `.northstar.yaml` defaults to:

- `runtime.host_adapter: codex`
- `workflow.domain: software_development`
- `github.intake.label: northstar:ready`
- `runtime.auto_release: true`
- `github.project.enabled: false`
- GitHub credentials referenced by environment or `gh` fallback, never stored directly.
- Relative runtime paths under `.northstar/runtime`.

Role host strategy:

- Default implementation, verification, and release workers use Codex.
- Role-level overrides may switch verifier or all roles to OpenCode.
- OpenCode readiness is checked only when selected.

## Watch And Operation Modes

The skill supports long-running watch as a first-version operator feature:

```bash
northstar watch --config .northstar.yaml
```

It also supports bounded watch smoke checks:

```bash
northstar watch --config .northstar.yaml --max-cycles 1 --log-json
```

First-version long-running watch is terminal/session based. Production OS service installation is deferred.

The skill should avoid duplicate watch startup when it can detect an existing active watch process or writer lock. If detection is uncertain, it reports uncertainty and asks before starting another long-running watch.

Manual issue operation maps to:

- `northstar intake --issue N`
- `northstar start --issue N`
- `northstar reconcile --issue N`
- `northstar release --issue N`
- `northstar inspect --issue N`

Auto-release is enabled by default through config, but release still requires verifier pass, PR metadata, and confirmed merge semantics from Northstar runtime.

## GitHub Observability

The skill supports three observability layers:

1. Labels.
2. Issue/PR comments and status markers.
3. Optional GitHub Project viewer.

Default labels:

- `northstar:ready`
- `northstar:running`
- `northstar:verifying`
- `northstar:verified`
- `northstar:completed`
- `northstar:failed`
- `northstar:quarantined`

Issue progress comments should mark key transitions:

- Intake accepted.
- Implementation started.
- PR ready.
- Verifier passed.
- Release completed.
- Failure or quarantine reason.

Issue body status marker:

```markdown
<!-- northstar-status -->
...
<!-- /northstar-status -->
```

The marker is updated in place instead of repeatedly appending noisy status text.

PR comments include verifier evidence summary and release outcome.

Projection failures are retryable observability failures. They must not directly mutate lifecycle state.

## GitHub Project Fields

GitHub Project viewer setup is optional and must be explicitly approved by the user. The skill must not create projects, fields, or views without asking.

The skill offers three Project choices:

1. Do not enable Project viewer.
2. Use an existing Project.
3. Create a new Northstar Project.

Recommended first-version fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `Northstar Lifecycle` | single select | Runtime lifecycle state. |
| `Northstar Stage` | single select | Intake, implementation, verification, release, recovery. |
| `Northstar Role` | single select | Current or last role. |
| `Northstar Host` | single select | Codex or OpenCode. |
| `Northstar PR` | URL or text | Pull request URL. |
| `Northstar Branch` | text | Issue branch. |
| `Northstar Dependency` | single select | Dependency state. |
| `Northstar Attention` | single select | Operator attention state. |
| `Northstar Last Update` | date | Last runtime update. |
| `Northstar Retry Count` | number | Retry count. |
| `Northstar Auto Release` | single select | Enabled, disabled, or issue override. |

Recommended views:

- `Northstar Board`: board grouped by `Northstar Lifecycle`.
- `Active Runs`: table filtered to active lifecycle states.
- `Needs Attention`: table or board for failed/quarantined/attention items.
- `Release Queue`: table for verified/release_pending items.
- `Completed`: table sorted by last update descending.
- `Dependencies`: table grouped or filtered by `Northstar Dependency`.

If Project permissions or API shape are unavailable, the skill should continue with labels/comments and report the Project setup blocker clearly.

## Cross-Platform Contract

Northstar and the skill must treat Linux, macOS, and Windows as first-class supported environments.

Core requirements:

- No hardcoded Unix-only source paths in production source.
- No reliance on `/tmp`, `/home`, `/bin/sh`, shell scripts, or Unix path separators in production logic.
- Paths are resolved with Node `path` APIs.
- External commands are executed as argv arrays.
- Shell-chain command strings are rejected.
- Runtime state is written under the consumer repo `.northstar/runtime`.
- CLI can run from any current working directory with an absolute `--config`.
- Node scripts are used for skill sync and doctor commands instead of `.sh` as the only entry.
- `git`, `gh`, and `node` discovery accounts for `.exe` and `.cmd` on Windows.
- `GIT_ASKPASS` strategy must have a Windows-compatible form.
- `node:sqlite` support is checked in doctor output.

The first version supports terminal/session long-running watch across platforms. OS service packaging is deferred:

- Linux `systemd`
- macOS `launchd`
- Windows Service or Task Scheduler

The first implementation should include deterministic portability tests for Linux-style, macOS-style, Windows drive-letter, Windows backslash, UNC path, and paths containing spaces. A full three-OS live CI matrix is deferred.

## Skill Source And Sync

The Northstar repository owns the skill source:

```text
skills/
  northstar/
    SKILL.md
    README.md
    templates/
      northstar.yaml
      workflow.issue-to-pr-release.yaml
    scripts/
      sync-global.mjs
      doctor.mjs
      render-config.mjs
```

Global sync copies the local skill to:

- Linux/macOS: `~/.codex/skills/northstar`
- Windows: `%USERPROFILE%\.codex\skills\northstar`

Sync behavior:

- Directly overwrite the global skill target.
- Use Node `fs` and `path` APIs.
- Do not require shell scripts.
- Preserve the repository copy as the source of truth.

Suggested npm scripts:

```json
{
  "skill:sync": "node skills/northstar/scripts/sync-global.mjs",
  "skill:doctor": "node skills/northstar/scripts/doctor.mjs",
  "skill:render-config": "node skills/northstar/scripts/render-config.mjs"
}
```

## Doctor

`doctor.mjs` reports a structured readiness result:

- Platform and architecture.
- Node version.
- `node:sqlite` availability.
- Git executable availability.
- `gh` executable and auth status.
- Northstar local root or package mode readiness.
- Northstar CLI help.
- Codex SDK readiness.
- OpenCode SDK readiness when configured.
- Current directory git repo status.
- GitHub remote parse result.
- `.northstar.yaml` existence and schema validation.
- GitHub repo access.
- Ready label status.
- Optional Project permissions.
- Path portability warnings.

Failures use stable error codes, for example:

- `NORTHSTAR_ROOT_MISSING`
- `NORTHSTAR_CLI_UNAVAILABLE`
- `NORTHSTAR_CONFIG_MISSING`
- `NORTHSTAR_CONFIG_INVALID`
- `NORTHSTAR_GITHUB_CREDENTIAL_MISSING`
- `NORTHSTAR_GITHUB_ACCESS_DENIED`
- `NORTHSTAR_SDK_UNAVAILABLE`
- `NORTHSTAR_PROJECT_PERMISSION_MISSING`
- `NORTHSTAR_PORTABILITY_BLOCKED`

Doctor output must not include secrets.

## Recovery Policy

The skill supports safety-gated recovery orchestration.

Low-risk actions may run automatically:

- Doctor/readiness check.
- Inspect issue.
- Bounded watch smoke.
- Read config.
- Read GitHub issue, PR, Project state.
- Retry projection sync.
- Reconcile already-running issue.
- Release an already-verified issue when `auto_release: true`.

Medium-risk actions require a clear summary and confirmation:

- Write or modify `.northstar.yaml`.
- Create or modify GitHub labels.
- Enable Project viewer.
- Create Project fields or views.
- Resume quarantined issue.
- Start long-running watch.
- Manually run a full issue flow.

High-risk actions require explicit second confirmation:

- Force push.
- Delete worktree.
- Delete branch.
- Close or reopen PR.
- Discard runtime state.
- Retry terminal failed issue from scratch.
- Modify auto-release policy.
- Create a new GitHub Project.

Recovery detection covers:

- Quarantined issue.
- Failed issue.
- Expired lease.
- Retryable projection failure.
- Branch exists but PR is missing.
- PR exists but runtime lacks PR metadata.
- Verified issue not released.
- Watch interrupted or restarted.
- Duplicate watch startup risk.

Recovery reports should include:

```text
issue: #123
state: quarantined
diagnosis: expired lease
safe_action: resume with new lease
requires_confirmation: yes
command_plan:
  northstar inspect --issue 123
  northstar start --issue 123
```

## Security

The skill must never write secrets to:

- `.northstar.yaml`
- docs
- logs
- SQLite history
- worker prompts
- Project fields
- issue comments

Credentials are referenced by environment variable names or local credential providers only.

Worker prompts must not include GitHub tokens or SDK credentials.

All command output included in reports must pass through redaction.

## Acceptance Metrics

First-version implementation must prove:

- `skill_bootstrap_config_draft_created = 1`
- `skill_bootstrap_requires_confirmation = 1`
- `skill_global_sync_overwrites_target = 1`
- `skill_doctor_platform_reported = 1`
- `skill_doctor_node_sqlite_checked = 1`
- `skill_doctor_git_gh_checked = 1`
- `skill_doctor_northstar_cli_checked = 1`
- `skill_doctor_sdk_checked >= 1`
- `skill_project_setup_requires_confirmation = 1`
- `skill_project_fields_defined >= 8`
- `skill_project_views_defined >= 5`
- `skill_operator_issue_commands_mapped >= 6`
- `skill_recovery_scenarios_detected >= 6`
- `skill_high_risk_actions_require_confirmation = 1`
- `skill_shell_chain_commands = 0`
- `skill_hardcoded_unix_paths_in_src = 0`
- `skill_linux_path_fixtures_passed >= 4`
- `skill_macos_path_fixtures_passed >= 4`
- `skill_windows_path_fixtures_passed >= 4`

## Test Strategy

Unit and deterministic tests:

- Skill sync overwrites target directory using Node APIs.
- Doctor reports platform, Node, SQLite, git, gh, Northstar CLI, SDK, and config status.
- Config renderer creates a draft without writing until confirmed.
- Project field/view definitions include the required fields and views.
- Project setup requires confirmation.
- Operator command mapping covers intake, start, reconcile, release, inspect, and watch.
- Recovery detector identifies supported stuck states.
- High-risk actions require explicit confirmation.
- Cross-platform path fixtures pass.
- Shell-chain commands are rejected.
- Source scans prove no hardcoded Unix-only production paths.

Live tests remain separated from offline tests:

- Offline tests must not require GitHub token, SDK credentials, or network.
- Live tests may validate GitHub Project setup and production issue operation when explicitly enabled.

## Deferred Work

- npm publish.
- Codex plugin packaging.
- OS service installation for long-running watch.
- Full Linux/macOS/Windows live CI matrix.
- Content creation domain driver.
- Office automation domain driver.
- Rich browser UI dashboard beyond GitHub Projects.

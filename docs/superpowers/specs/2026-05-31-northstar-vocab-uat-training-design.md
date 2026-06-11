# Northstar Vocabulary UAT Training Design

Date: 2026-05-31

## Purpose

This design defines a full user-acceptance test for operating Northstar from a consumer repository through the Northstar Codex skill. The UAT validates that an operator can use natural-language skill workflows to bootstrap a new repository, create GitHub issues and Project monitoring, dispatch software-development work through Northstar, and produce a usable English vocabulary web app.

The result is also an education and training artifact. Every meaningful Northstar skill operation must be recorded into a Markdown manual so a future operator can repeat the same process in another consumer repository.

## Selected Approach

Use the complete education-training UAT scope.

- Consumer repository: `paulpai0412/northstar-vocab-uat`.
- Application: English vocabulary learning web app.
- Worker host: Codex as the primary execution host.
- OpenCode: documented as a role-level host override and optional extension, not required for this UAT pass.
- Workflow: `software_development` domain with issue-to-PR-release behavior.
- Issue strategy: ordered dependency chain.
- GitHub Project: enabled, with multiple operator views.
- Output: a real usable web app and a training manual.

Deployment to an external hosting provider is out of scope for this UAT. Local browser verification is required.

## Current Northstar Capability Assumptions

The UAT assumes the current Northstar repository already supports:

- Northstar global/local skill bootstrap and operation workflows.
- Consumer `.northstar.yaml` generation after explicit user confirmation.
- Real production CLI/watch dependency wiring for GitHub, git/worktree, Codex/OpenCode SDK worker boundaries, and software-development domain driver.
- GitHub ready-label issue intake.
- Local issue worktree execution.
- Branch, commit, push, PR creation or reuse, verifier, merge, issue close, and runtime completed lifecycle.
- GitHub labels, comments, PR comments, and optional Project field sync as observability surfaces.
- Restart/resume semantics that reuse worktree, branch, and PR.

If any assumption fails during UAT, the training manual must record the blocker, evidence, and recovery action.

## UAT Repository

The UAT uses a new GitHub consumer repository:

```text
paulpai0412/northstar-vocab-uat
```

The repository should contain a small web application whose scope is large enough to require multiple dependent issues but small enough to complete in one UAT run.

Recommended app shape:

- Frontend-only web app.
- No production backend dependency.
- Local development command documented in `README.md`.
- Persistent progress may use browser local storage.
- Tests may be lightweight, but the app must have a repeatable local verification command.

The Northstar repository itself remains the tool provider. The UAT consumer repository must not require copying Northstar source into the consumer repo.

## Application Requirements

The English vocabulary app must support:

- A vocabulary deck with at least 20 seed words.
- Word, part of speech, definition, example sentence, and pronunciation hint fields.
- Practice mode with card reveal.
- Quiz mode with at least multiple-choice questions.
- Progress tracking for attempted and mastered words.
- Review queue that prioritizes weak or unmastered words.
- Responsive layout for desktop and mobile viewport widths.
- Clear empty, loading, and completion states where applicable.
- Local browser verification instructions.

The UAT is successful only if the final app can be opened locally and used for a complete study flow:

1. Choose or load a deck.
2. Study at least one word.
3. Take at least one quiz.
4. Update progress.
5. Revisit review state.

## GitHub Issue Design

The UAT creates a dependency chain of issues in the consumer repository. All executable issues must receive the configured ready label:

```text
northstar:ready
```

Recommended issue set:

| Order | Issue | Purpose | Depends On |
| --- | --- | --- | --- |
| 1 | Project scaffold and local dev command | Create the app skeleton, scripts, README, and baseline layout. | None |
| 2 | Vocabulary data model and seed deck | Add structured word data and deck loading. | Issue 1 |
| 3 | Practice mode | Add flashcard study experience. | Issue 2 |
| 4 | Quiz mode | Add quiz generation and answer feedback. | Issue 2 |
| 5 | Progress tracking and review queue | Persist progress and prioritize review. | Issues 3 and 4 |
| 6 | Responsive UI polish and final verification | Improve usability and add final verification notes. | Issue 5 |

Dependency declarations must use both:

- Native GitHub linked issue relationships when available.
- Text markers such as `Depends-On: #N` as a fallback and audit trail.

Northstar must not dispatch an issue before its dependencies are completed.

## GitHub Project Design

The skill must ask before creating a GitHub Project. For this UAT, the intended answer is yes.

Project name:

```text
Northstar Vocabulary UAT
```

Required fields:

| Field | Type | Purpose |
| --- | --- | --- |
| `Northstar Lifecycle` | single select | Runtime lifecycle state. |
| `Northstar Stage` | single select | Intake, implementation, verification, release, recovery. |
| `Northstar Role` | single select | Current or last role. |
| `Northstar Host` | single select | Codex or OpenCode. |
| `Northstar Issue Order` | number | Planned issue order. |
| `Northstar Blocked By` | text | Blocking issue numbers or dependency summary. |
| `Northstar PR` | URL or text | Pull request URL. |
| `Northstar Branch` | text | Git branch used by Northstar. |
| `Northstar Merge SHA` | text | Confirmed merge SHA. |
| `Northstar Heartbeat` | date | Last heartbeat or runtime update. |
| `Northstar Retry Count` | number | Retry count. |
| `Northstar Last Error` | text | Compact last error summary. |
| `Northstar Completed At` | date | Completion timestamp. |
| `Northstar Attention` | single select | None, blocked, failed, quarantined, needs operator. |

Required views:

| View | Purpose |
| --- | --- |
| `PM Roadmap` | Ordered list grouped by lifecycle and sorted by issue order. |
| `Engineer Work Queue` | Active implementation and verification work with branch and PR columns. |
| `Runtime Ops` | Lifecycle, heartbeat, retry, error, and attention monitoring. |
| `Release Queue` | Verified or release-pending issues. |
| `Completed` | Completed issues sorted by completion timestamp. |
| `Dependencies` | Blocked and dependency-related issues. |

Project setup failure must not fail the entire UAT if labels and comments still provide observability. It must be recorded as a UAT defect or environmental blocker.

## Northstar Skill Operation Model

All operator actions must be expressed as Northstar skill-driven operations, not ad hoc manual CLI usage.

The skill may run Northstar CLI commands internally, but the training manual must record the operator intent and the resulting command/evidence at a useful level.

Required skill operation categories:

- Bootstrap consumer repository.
- Run readiness/doctor checks.
- Draft and confirm `.northstar.yaml`.
- Ask whether to create Project monitoring.
- Create or confirm labels.
- Create issues.
- Configure dependency markers and native linked issue relationships.
- Start watch or run manual issue flow.
- Inspect progress.
- Recover or retry if needed.
- Verify local app.
- Summarize completion.

The skill must not write secrets to repository files, GitHub issues, Project fields, PR comments, logs, SQLite history, or worker prompts.

## UAT Flow

The primary UAT flow is:

1. Create the consumer repository `paulpai0412/northstar-vocab-uat`.
2. Clone or initialize the consumer repository locally.
3. Use the Northstar skill to bootstrap the repo.
4. Confirm generated `.northstar.yaml`.
5. Confirm Project creation and field/view setup.
6. Generate the ordered issue set.
7. Add ready labels only when issues are ready for Northstar intake.
8. Start Northstar watch or execute the manual flow through the skill.
9. Observe issue lifecycle and Project updates.
10. Let Northstar implement, verify, release, merge, and close each issue.
11. Run local app verification in a browser.
12. Record all operations and evidence into the training manual.

The recommended execution mode is watch-driven after bootstrap. Manual issue commands may be used for diagnosis or recovery.

## Quantitative Acceptance Criteria

The UAT must produce a summary table with these metrics:

| Metric | Required Value |
| --- | --- |
| `uat_consumer_repos_created` | `1` |
| `uat_project_created_or_reused` | `1` |
| `uat_project_fields_configured` | `>= 12` |
| `uat_project_views_configured` | `>= 5` |
| `uat_issues_created` | `>= 6` |
| `uat_dependency_edges_created` | `>= 5` |
| `uat_dependency_order_violations` | `0` |
| `uat_ready_labeled_issues` | `>= 6` |
| `uat_northstar_completed_issues` | `>= 6` |
| `uat_prs_created_or_reused` | `>= 6` |
| `uat_prs_merged` | `>= 6` |
| `uat_github_issues_closed` | `>= 6` |
| `uat_project_lifecycle_updates` | `>= 6` |
| `uat_progress_comments_created` | `>= 6` |
| `uat_manual_recovery_actions` | `>= 0` |
| `uat_duplicate_prs_created` | `0` |
| `uat_secret_leaks` | `0` |
| `uat_training_manual_sections_completed` | `>= 8` |
| `uat_browser_study_flow_passed` | `1` |

The app-level verification must record:

| Metric | Required Value |
| --- | --- |
| `vocab_seed_words` | `>= 20` |
| `practice_words_studied` | `>= 1` |
| `quiz_questions_answered` | `>= 1` |
| `progress_updates_recorded` | `>= 1` |
| `review_queue_items_visible` | `>= 1` |
| `desktop_viewport_verified` | `1` |
| `mobile_viewport_verified` | `1` |

## Training Manual

The UAT must create a Markdown training manual in the Northstar repository, not in the consumer repo unless explicitly chosen later.

Recommended path:

```text
docs/training/northstar-vocab-uat-training-manual.md
```

Required sections:

1. Overview and goals.
2. Prerequisites and credentials.
3. Consumer repo creation.
4. Northstar skill bootstrap.
5. `.northstar.yaml` review.
6. Project fields and views.
7. Issue design and dependency ordering.
8. Starting watch or manual execution.
9. Observing progress in GitHub issues, PRs, and Project views.
10. Recovery and retry procedures.
11. Local browser acceptance testing.
12. Final metrics and evidence.
13. Troubleshooting.
14. Reuse checklist for a different consumer repo.

Each operation entry should record:

- Timestamp.
- Operator intent.
- Northstar skill action.
- Important generated command or GitHub operation.
- Evidence URL or local file path.
- Result.
- Follow-up or recovery action if needed.

## Safety And Permissions

The UAT requires explicit confirmation before:

- Creating the GitHub consumer repository.
- Creating or changing GitHub Project fields and views.
- Writing `.northstar.yaml`.
- Starting long-running watch.
- Merging PRs.
- Running recovery actions that mutate git, GitHub, or runtime state.

The UAT must not:

- Store secrets in repository files.
- Store secrets in GitHub issue bodies, comments, Project fields, or PR comments.
- Store secrets in worker prompts or SQLite history.
- Use shell-chain command strings for external process execution.
- Hardcode the sandbox or UAT repository in production source.
- Use fake production paths to satisfy UAT acceptance.

## Deferred Work

These items are outside this UAT design:

- External hosting deployment.
- OpenCode as the primary execution host for all issues.
- Content creation and office automation domain driver implementation.
- Production OS service installation.
- npm publishing of Northstar.

## Design Review Checklist

- The UAT validates a real consumer repository rather than only the Northstar repo.
- The issue set is ordered and dependency-sensitive.
- GitHub Project monitoring is explicit and confirmation-gated.
- The manual records skill-level operations, not only raw commands.
- Quantitative metrics distinguish Northstar runtime completion from app usability.
- The design avoids deployment scope creep.
- Secrets, fake production paths, and hardcoded repository shortcuts are excluded.

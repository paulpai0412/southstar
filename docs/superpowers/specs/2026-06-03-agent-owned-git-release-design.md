# Agent-Owned Git Release Runtime Design

## Status

- Date: 2026-06-03
- Status: proposed
- Target repository: `/home/timmypai/apps/northstar`
- Scope: redesign Northstar software-development delivery so all git, worktree, branch, PR, merge, and release operations are owned by LLM agents, while Northstar remains the durable workflow control plane.

## Problem

Northstar currently owns too much software-development git state. The runtime prepares worktrees, tracks branches, commits and pushes changes, creates PRs, merges PRs, syncs a local main worktree, performs merge-conflict recovery, and reconciles external merge state. This makes release failures expand into many git-specific runtime patches. When git state is abnormal, Northstar lifecycle state can become abnormal too.

The desired redesign is to remove git and repo-state ownership from Northstar. Northstar should dispatch structured prompts and JSON task contracts to LLM agents. Agents handle all git/GitHub repo operations and return schema-valid JSON artifacts. Northstar validates artifacts, records evidence, drives workflow state, and projects issue/project updates.

## Goals

1. Make all git-related work agent-owned:
   - clone/fetch/workspace creation
   - worktree/branch strategy
   - commits and pushes
   - PR creation/update
   - PR inspection and mergeability handling
   - conflict recovery
   - release/merge execution
2. Keep Northstar as the control plane:
   - issue intake
   - lifecycle state
   - owner leases and scheduling
   - retry and recovery policy
   - prompt rendering
   - JSON schema validation
   - artifact storage and audit
   - GitHub issue/project projection
3. Preserve three workflow stages:
   - implementation
   - verification
   - release
4. Use an independent verifier agent that performs both code/PR review and functional review, including browser review for UI/browser changes.
5. Centralize abnormal workflow handling in a new `exception` lifecycle state.
6. Reserve `quarantined` for issues that require human intervention.

## Non-Goals

- Northstar will not validate whether a PR exists, is mergeable, or was merged.
- Northstar will not validate whether a commit SHA exists.
- Northstar will not create, clean, or track agent workspaces.
- Northstar will not sync a local main worktree as part of software-development delivery.
- Northstar will not perform git conflict recovery.
- This design does not introduce multi-verifier quorum.

## Design Decisions

### 1. Boundary: Northstar owns orchestration, agents own git

Northstar owns:

- issue intake
- lifecycle state
- leases, scheduling, retry, exception handling, and quarantine
- prompt and JSON task construction
- JSON output schema validation
- artifact persistence and audit history
- GitHub issue comments, issue close, labels, and project sync as projection

LLM agents own:

- all local workspace decisions
- git clone/fetch/worktree/branch operations
- implementation changes
- tests and verification commands
- PR create/update
- PR review and repo inspection
- merge/release
- git or release error recovery

Northstar's source of truth becomes schema-valid agent artifacts and lifecycle history. Git branch state, PR mergeability, local worktree cleanliness, and commit existence are not Northstar sources of truth.

```text
┌──────────────────────────────────────────────┐
│ Northstar Core Runtime                        │
│ - lifecycle / leases / scheduler              │
│ - prompt + JSON task contracts                │
│ - JSON schema validation                      │
│ - artifact persistence                        │
│ - issue/project projection                    │
│ - no git / worktree / branch / PR state       │
└──────────────────────┬───────────────────────┘
                       │ JSON task contract
                       ▼
┌──────────────────────────────────────────────┐
│ Implementation Agent                         │
│ - isolated workspace                          │
│ - git branch/commit/push                      │
│ - PR create/update                            │
│ - implementation_result JSON                  │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Independent Verifier Agent                   │
│ - code and PR review                          │
│ - requirements validation                     │
│ - functional review                           │
│ - browser review for UI/browser changes       │
│ - verification_result JSON                    │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Release Agent                                │
│ - final repo/PR inspection                    │
│ - merge/release                               │
│ - git/release error recovery                  │
│ - release_result JSON                         │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│ Northstar Projection                         │
│ - comment/close issue                         │
│ - update labels/project fields                │
└──────────────────────────────────────────────┘
```

### 2. Workflow remains implementation → verification → release

The software-development workflow keeps three stages and three separate agents:

```text
ready
  │
  ▼
running
  stage: implementation
  role: implementation_agent
  artifact: implementation_result
  │
  ▼
verifying
  stage: verification
  role: verifier_agent
  artifact: verification_result
  │
  ▼
verified
  │
  │ release mode permits release
  ▼
release_pending
  stage: release
  role: release_agent
  artifact: release_result
  │
  ▼
completed
```

The verifier agent is independent. It is not only a PR reviewer. It is a quality acceptance agent responsible for:

- checking issue requirements
- reviewing code and scope
- checking tests and risk
- performing functional review for all non-docs changes
- performing browser functional review for UI/browser changes
- returning browser evidence when browser review is required

### 3. Release gate defaults to automatic but supports manual

Default behavior remains automatic release. Existing config is retained:

```yaml
runtime:
  auto_release: true
```

Semantic mapping:

```text
runtime.auto_release: true  → release mode auto
runtime.auto_release: false → release mode manual
```

In auto mode, a valid `verification_result` with `status=pass` and `release_recommendation=ready_for_release` permits dispatching the release agent.

In manual mode, Northstar stays at `verified` until an operator approval event allows the release stage to start.

### 4. Agent workspace is fully agent-owned

Northstar gives agents repo identity and issue context. It does not create, suggest, track, validate, or clean workspace paths.

Agent task input includes repo metadata:

```json
{
  "repo": {
    "provider": "github",
    "name": "owner/repo",
    "url": "https://github.com/owner/repo",
    "base_branch": "main"
  }
}
```

Agents decide whether to clone, use a git worktree, reuse an existing checkout, or create temporary directories. Agents are responsible for cleanup when appropriate.

### 5. New artifact kinds

The old software-development built-ins are replaced:

```text
old: worker_result       → new: implementation_result
old: evidence_packet     → new: verification_result
old: release_result      → kept: release_result with new semantics
```

Allowed high-level statuses:

```text
implementation_result:
  - ready_for_verification
  - failed_retryable
  - failed_terminal
  - blocked

verification_result:
  - pass
  - failed_retryable
  - failed_terminal
  - blocked

release_result:
  - completed
  - failed_retryable
  - failed_terminal
  - blocked
```

### 6. Completion source of truth changes

Old completion rule:

```text
Northstar confirms PR merge, then lifecycle becomes completed.
```

New completion rule:

```text
Release agent returns schema-valid release_result with status=completed,
release.confirmed=true, and required evidence.
```

Northstar validates the JSON shape and required fields. Northstar does not check GitHub to prove the PR is merged or the merge commit exists.

### 7. GitHub issue/project projection remains Northstar-owned

Release agent returns issue update instructions:

```json
{
  "issue_update": {
    "comment_summary": "Released via PR #456. Verification passed and merge completed.",
    "close_issue": true,
    "labels_to_add": ["northstar:released"],
    "labels_to_remove": ["northstar:ready"]
  }
}
```

Northstar turns this into projection effects:

- issue comment
- issue close
- label update
- project update

Projection failure is retryable projection state and must not reverse `completed`.

## JSON Contracts

### Common task envelope

Northstar sends each agent a JSON task envelope plus prompt instructions:

```json
{
  "schema_version": "1.0",
  "task_kind": "implementation",
  "northstar": {
    "run_id": "northstar-production",
    "issue_id": "github-123",
    "stage": "implementation",
    "attempt": 1
  },
  "repo": {
    "provider": "github",
    "name": "owner/repo",
    "url": "https://github.com/owner/repo",
    "base_branch": "main"
  },
  "issue": {
    "number": 123,
    "title": "Add todo filter",
    "body": "...",
    "url": "https://github.com/owner/repo/issues/123"
  },
  "policy": {
    "git_is_agent_owned": true,
    "northstar_will_not_create_worktree": true,
    "northstar_will_not_commit_or_push": true,
    "northstar_will_not_create_or_merge_pr": true,
    "northstar_will_not_validate_git_state": true
  },
  "expected_output": {
    "artifact_kind": "implementation_result",
    "format": "json_object_only"
  }
}
```

Agent final responses must be exactly one JSON object: no markdown fence, no prose outside JSON, no raw logs, and no secrets.

### Implementation result

Successful implementation result:

```json
{
  "schema_version": "1.0",
  "artifact_kind": "implementation_result",
  "status": "ready_for_verification",
  "retryable": false,
  "issue_number": 123,
  "observed_at": "2026-06-03T12:00:00.000Z",
  "summary": "Implemented todo filtering and opened PR #456.",
  "pr": {
    "url": "https://github.com/owner/repo/pull/456",
    "number": 456,
    "head_ref": "northstar/issue-123-todo-filter",
    "head_sha": "abc123"
  },
  "changed_files": ["app.js", "styles.css", "tests/todo-filter.test.js"],
  "commands_run": [
    {
      "command": "npm test",
      "status": "passed",
      "summary": "12 tests passed."
    }
  ],
  "self_check_summary": "All issue requirements implemented and locally tested.",
  "evidence": [
    {
      "type": "test",
      "summary": "npm test passed."
    },
    {
      "type": "pull_request",
      "url": "https://github.com/owner/repo/pull/456"
    }
  ],
  "next_action": "verify"
}
```

### Verification result

Verification pass with browser evidence:

```json
{
  "schema_version": "1.0",
  "artifact_kind": "verification_result",
  "status": "pass",
  "retryable": false,
  "issue_number": 123,
  "observed_at": "2026-06-03T12:30:00.000Z",
  "summary": "Implementation satisfies the issue requirements. Functional browser review passed.",
  "pr": {
    "url": "https://github.com/owner/repo/pull/456",
    "number": 456
  },
  "review": {
    "requirements_passed": true,
    "code_review_passed": true,
    "risk_level": "low",
    "notes": []
  },
  "functional_review": {
    "required": true,
    "method": "browser",
    "status": "pass",
    "scenarios": [
      {
        "name": "Create and filter todo items",
        "status": "pass",
        "summary": "Created active/completed todos and filter buttons showed correct items."
      }
    ]
  },
  "browser_evidence": {
    "required": true,
    "ran": true,
    "screenshots": ["final_runs/run_123/filter-active.png"],
    "console_errors": [],
    "tests_passed": 1
  },
  "release_recommendation": "ready_for_release"
}
```

Documentation-only changes may skip functional review, but the verifier must explicitly explain why:

```json
{
  "functional_review": {
    "required": false,
    "method": "not_applicable",
    "status": "skipped",
    "reason": "Documentation-only change."
  },
  "browser_evidence": {
    "required": false,
    "ran": false,
    "screenshots": [],
    "console_errors": [],
    "tests_passed": 0
  }
}
```

Verification retryable failure includes actionable feedback:

```json
{
  "schema_version": "1.0",
  "artifact_kind": "verification_result",
  "status": "failed_retryable",
  "retryable": true,
  "issue_number": 123,
  "observed_at": "2026-06-03T12:30:00.000Z",
  "summary": "Functional browser review failed: completed filter still shows active todos.",
  "feedback_for_implementation": [
    "Fix completed filter so active todos are hidden.",
    "Add a regression test for active/completed filter separation."
  ],
  "next_action": "return_to_implementation"
}
```

### Release result

Completed release result:

```json
{
  "schema_version": "1.0",
  "artifact_kind": "release_result",
  "status": "completed",
  "retryable": false,
  "issue_number": 123,
  "observed_at": "2026-06-03T13:00:00.000Z",
  "summary": "PR #456 was merged successfully.",
  "pr": {
    "url": "https://github.com/owner/repo/pull/456",
    "number": 456
  },
  "release": {
    "confirmed": true,
    "type": "github_pr_merge",
    "merge_commit": "def456",
    "released_at": "2026-06-03T13:00:00.000Z"
  },
  "evidence": [
    {
      "type": "pull_request",
      "url": "https://github.com/owner/repo/pull/456"
    },
    {
      "type": "merge_commit",
      "value": "def456"
    }
  ],
  "issue_update": {
    "comment_summary": "Released via PR #456. Verification passed and merge completed.",
    "close_issue": true,
    "labels_to_add": ["northstar:released"],
    "labels_to_remove": ["northstar:ready"]
  }
}
```

Release retryable failure:

```json
{
  "schema_version": "1.0",
  "artifact_kind": "release_result",
  "status": "failed_retryable",
  "retryable": true,
  "issue_number": 123,
  "observed_at": "2026-06-03T13:00:00.000Z",
  "summary": "Release could not complete because tests failed after rebasing the PR.",
  "pr": {
    "url": "https://github.com/owner/repo/pull/456",
    "number": 456
  },
  "failure": {
    "category": "post_rebase_test_failure",
    "agent_attempted_recovery": true,
    "attempts": 2,
    "details": "Rebased onto main, fixed conflicts, but npm test still fails."
  },
  "next_action": "retry_release_or_return_to_implementation"
}
```

## Validation Rules

Northstar validates:

- JSON object only
- `schema_version`
- `artifact_kind`
- status enum for that artifact kind
- `issue_number` matches the runtime issue
- `observed_at` is an ISO timestamp
- `summary` is non-empty and compact
- `retryable` is consistent with status
- no raw transcript, raw browser trace, terminal log, full log, or secret-shaped values
- required evidence fields for successful outcomes

Northstar does not validate:

- PR existence
- PR merged state
- branch existence
- commit existence
- merge commit existence
- whether tests actually ran
- whether screenshots actually exist

## Functional and Browser Review Policy

Verifier policy:

```text
docs-only change:
  requirements/code review required
  functional_review may be skipped with explicit reason

non-docs change:
  functional_review required

UI/browser change:
  browser functional review required
  browser_evidence.ran must be true
  screenshots or scenario evidence required
```

Northstar validates the verifier's structured claim. Northstar does not perform the browser review itself.

## Centralized Exception Handling

### New lifecycle state

Add a new core lifecycle state:

```text
exception
```

Updated lifecycle set:

```text
ready
claimed
running
verifying
verified
release_pending
exception
completed
failed
quarantined
```

State categories:

```text
Active:
  claimed
  running
  verifying
  release_pending

Automatic exception handling:
  exception

Human intervention:
  quarantined

Terminal:
  completed
  failed
```

`exception` is not active and does not require an owner lease. Entering `exception` clears active owner lease/session state and records structured exception context.

### Exception vs. quarantined

The distinction is simple:

```text
exception:
  automatic exception handling zone.
  Reconcile may retry, reroute, return to implementation, or escalate.

quarantined:
  human intervention zone.
  No automatic retry.
```

All workflow-blocking abnormal outcomes enter `exception` first. Only cases that require human action, or that exhaust automatic recovery attempts, enter `quarantined`.

```text
running / verifying / release_pending
        │
        │ abnormal
        ▼
┌────────────────────────┐
│ exception              │
│ - classify             │
│ - retry                │
│ - reroute              │
│ - carry feedback       │
└───────────┬────────────┘
            │ retry succeeds
            ▼
   back to workflow stage

            │ retry exhausted / manual required
            ▼
┌────────────────────────┐
│ quarantined            │
│ - human intervention   │
│ - no automatic retry   │
└────────────────────────┘
```

### Exception entry conditions

Examples:

- `implementation_result.failed_retryable`
- `implementation_result.failed_terminal`
- `implementation_result.blocked`
- `verification_result.failed_retryable`
- `verification_result.failed_terminal`
- `verification_result.blocked`
- `release_result.failed_retryable`
- `release_result.failed_terminal`
- `release_result.blocked`
- JSON parse failure
- artifact schema validation failure
- artifact binding mismatch
- host dispatch failure
- child timeout or lost child
- lease lost
- workflow-blocking runtime invariant violation

Projection failures do not enter `exception`. Issue comment, issue close, label, or project sync failures remain projection retries and must not mutate lifecycle.

### Exception context

`runtime_context_json.exception` stores the structured exception:

```json
{
  "exception": {
    "id": "exc_20260603_001",
    "status": "pending_reconcile",
    "source_lifecycle": "release_pending",
    "source_stage": "release",
    "source_role": "release_agent",
    "source_child_run_id": "child_abc",
    "artifact_kind": "release_result",
    "category": "agent_reported_failure",
    "severity": "retryable",
    "retryable": true,
    "summary": "Release agent could not complete merge after conflict recovery.",
    "recommended_action": "retry_stage",
    "target_stage": "release",
    "attempt_count": 1,
    "max_attempts": 2,
    "payload": {
      "agent_diagnosis": {
        "category": "merge_conflict",
        "attempts": 2
      }
    },
    "created_at": "2026-06-03T13:00:00.000Z",
    "last_reconciled_at": null
  }
}
```

### Retry budget

Use existing config:

```yaml
runtime:
  max_recovery_attempts: 2
```

`runtime.max_recovery_attempts` is the automatic exception recovery budget. If the exception resolver reaches this budget for the source stage/category, it escalates to `quarantined`.

### Workflow-defined exception policy

Exception handling must be workflow-driven, not hard-coded in runtime branches. The runtime owns the generic exception lifecycle and resolver engine. Each workflow owns the declarative policy that maps exception facts to recovery actions.

Add `exception_policy` to workflow YAML:

```yaml
exception_policy:
  max_recovery_attempts_from: runtime.max_recovery_attempts

  rules:
    - name: verification_retryable_returns_to_implementation
      match:
        source_stage: verification
        artifact_kind: verification_result
        status: failed_retryable
      action:
        type: return_to_stage
        target_stage: implementation
        carry_forward:
          - feedback_for_implementation
      on_exhausted:
        type: quarantine

  default:
    action:
      type: quarantine
```

The resolver evaluates rules in order. The first matching rule wins. If no rule matches, `default.action` applies.

Supported match fields in the first version:

```text
source_stage
source_role
artifact_kind
status
category
severity
retryable
```

All match fields are exact-match predicates. The first version does not support expression languages, arbitrary JavaScript, nested boolean logic, or host-specific commands in YAML.

Supported action types:

```text
retry_same_stage:
  resume the exception source stage

retry_stage:
  resume a declared target stage

return_to_stage:
  resume a declared target stage and optionally carry selected artifact fields forward

quarantine:
  transition exception → quarantined for human intervention

fail:
  transition exception → failed
```

`on_exhausted` is evaluated when the exception attempt count reaches `runtime.max_recovery_attempts`. First-version `on_exhausted.type` may be only `quarantine` or `fail`.

### Reconcile resolver

Only reconcile/watch resolves `exception` issues. It does not contain software-development-specific retry logic. It performs this generic algorithm:

```text
1. Load snapshot where lifecycle_state == exception.
2. Read runtime_context_json.exception.
3. Read workflow.exception_policy.
4. Find the first matching policy rule, or use default.action.
5. If attempt_count >= runtime.max_recovery_attempts, use on_exhausted if present.
6. Validate the action target against workflow.stages.
7. Apply the action and append auditable history.
```

Policy action outcomes:

```text
retry_same_stage:
  exception → source stage lifecycle
  stage_cursor = source_stage

retry_stage:
  exception → target stage lifecycle
  stage_cursor = target_stage

return_to_stage:
  exception → target stage lifecycle
  stage_cursor = target_stage
  carry selected fields into runtime_context_json.exception_carry_forward

quarantine:
  exception → quarantined

fail:
  exception → failed
```

This design keeps abnormal flow centralized without making the runtime hard-code domain-specific exception decisions.

### Workflow validation for exception policy

Workflow validation must reject invalid exception policies before runtime execution:

```text
- rule.name must be a non-empty string.
- rule.match must include at least one supported match field.
- unknown match fields are rejected.
- action.type must be one of retry_same_stage, retry_stage, return_to_stage, quarantine, fail.
- retry_stage and return_to_stage require target_stage.
- target_stage must exist in workflow.stages.
- carry_forward, when present, must be an array of non-empty strings.
- on_exhausted.type must be quarantine or fail.
- default.action must exist.
- default.action follows the same action validation rules.
```

## Runtime Architecture Changes

### New contract module

Add a software-development contract module, for example:

```text
src/orchestrator/software-dev-contract.ts
```

Responsibilities:

- define task/result types
- build implementation, verification, and release task JSON
- parse and validate agent result JSON
- normalize happy-path results to canonical runtime events
- normalize abnormal results to `exception_raised`

### State machine changes

Add lifecycle state `exception` and event `exception_raised`.

`exception_raised` behavior:

```text
- lifecycle_state = exception
- write runtime_context_json.exception
- clear current owner lease/session
- preserve source_stage and source_lifecycle in exception context
- append exception_raised history
```

Happy-path stage artifacts continue workflow progression:

```text
implementation_result.ready_for_verification → verification
verification_result.pass                   → verified
release_result.completed                   → completed
```

Abnormal artifacts go to `exception`, not directly to retry, failed, or quarantined.

### SoftwareDevDomainDriver changes

The production software-development driver must stop performing git/GitHub repo delivery operations.

Remove or stop calling:

- `prepareIssueWorktree`
- `commitAndPush`
- `createFixtureBranch`
- `readBranchCommit`
- `createPullRequest`
- `createOrReusePullRequest`
- `mergePullRequest`
- `findMergedPullRequestForIssue`
- `syncBaseBranch`
- merge-conflict recovery in Northstar
- sync worktree recovery in Northstar

The driver should dispatch agent tasks and validate returned JSON artifacts.

### Production dependencies

Software-development production delivery should no longer depend on `SoftwareDevWorktreeOperator` or git adapters.

Northstar may still construct GitHub adapters for:

- issue intake
- observability/projection
- issue comments/close/project updates

These adapters must not be used as PR/branch/merge truth sources for lifecycle transitions.

### Host worker input

Host worker input should move away from branch/worktree fields and toward task JSON:

```ts
interface SoftwareDevAgentTaskInput {
  task_json: ImplementationTask | VerificationTask | ReleaseTask;
  prompt: string;
  expected_artifact_kind: "implementation_result" | "verification_result" | "release_result";
}
```

Prompts must include the boundary rule:

```text
You own all git/repo/workspace operations. Northstar will not create worktrees, branches, commits, PRs, merges, or validate git state. Return exactly one JSON object matching the expected schema.
```

## Workflow YAML Shape

Recommended workflow package:

```yaml
workflow:
  id: issue_to_pr_release
  version: "2.0"
  domain: software_development

  roles:
    implementation_agent:
      run_mode: background_child
      agent: build
      model: gpt-5
      load_skills:
        - tdd
        - git-master
      artifact: implementation_result
      timeout_seconds: 7200

    verifier_agent:
      run_mode: background_child
      agent: review
      model: gpt-5
      load_skills:
        - review-work
        - browser-qa
        - git-master
      artifact: verification_result
      timeout_seconds: 7200

    release_agent:
      run_mode: background_child
      agent: release
      model: gpt-5
      load_skills:
        - git-master
      artifact: release_result
      timeout_seconds: 3600

  stages:
    implementation:
      lifecycle_state: running
      role: implementation_agent
      on_success: verification

    verification:
      lifecycle_state: verifying
      role: verifier_agent
      on_pass: verified
      on_success: verified

    release:
      lifecycle_state: release_pending
      role: release_agent
      on_success: completed

  exception_policy:
    max_recovery_attempts_from: runtime.max_recovery_attempts

    rules:
      - name: implementation_retryable_retries_implementation
        match:
          source_stage: implementation
          artifact_kind: implementation_result
          status: failed_retryable
        action:
          type: retry_stage
          target_stage: implementation
        on_exhausted:
          type: quarantine

      - name: verification_retryable_returns_to_implementation
        match:
          source_stage: verification
          artifact_kind: verification_result
          status: failed_retryable
        action:
          type: return_to_stage
          target_stage: implementation
          carry_forward:
            - feedback_for_implementation
        on_exhausted:
          type: quarantine

      - name: release_retryable_retries_release
        match:
          source_stage: release
          artifact_kind: release_result
          status: failed_retryable
        action:
          type: retry_stage
          target_stage: release
        on_exhausted:
          type: quarantine

      - name: artifact_validation_retries_same_stage
        match:
          category: artifact_validation
        action:
          type: retry_same_stage
        on_exhausted:
          type: quarantine

      - name: blocked_requires_operator
        match:
          status: blocked
        action:
          type: quarantine

      - name: terminal_agent_failure_requires_operator
        match:
          status: failed_terminal
        action:
          type: quarantine

    default:
      action:
        type: quarantine
```

Abnormal transitions are intentionally omitted from the workflow stage happy path. They are handled by centralized exception logic through `exception_policy`, not by scattered per-stage failure transitions.

## Migration and Compatibility

### Config

Keep existing fields:

```yaml
runtime:
  auto_release: true
  max_recovery_attempts: 2
```

No new `exception.max_auto_retries` config is introduced in the first version.

### Existing quarantined issues

Repair/migration rule:

```text
If an existing quarantined issue has runtime_context_json.exception with pending/retryable/recoverable status,
migrate lifecycle_state to exception.

Otherwise keep it quarantined.
```

This avoids automatically reviving issues that were intentionally quarantined for human action.

### Documentation updates

Update or supersede:

- `CLAUDE.md`
- `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- workflow fixtures
- operator runbook
- artifact schema documentation

The old release invariant must be replaced:

```text
Old:
  completion requires Northstar-confirmed PR merge

New:
  completion requires schema-valid release_result.completed from release agent
```

## Testing Strategy

### State machine

Required tests:

1. `implementation_result.ready_for_verification` transitions `running → verifying`.
2. `implementation_result.failed_retryable` transitions `running → exception`.
3. `verification_result.pass` transitions `verifying → verified`.
4. `verification_result.failed_retryable` transitions `verifying → exception`.
5. `release_result.completed` transitions `release_pending → completed`.
6. `release_result.failed_retryable` transitions `release_pending → exception`.
7. Invalid artifact schema transitions active state to `exception`.
8. Exception resolver with remaining budget resumes target stage.
9. Exception resolver with exhausted budget transitions `exception → quarantined`.
10. `quarantined` issues do not auto retry.
11. Projection failures do not enter `exception`.

### Artifact validation

Required tests:

- valid `implementation_result.ready_for_verification`
- invalid implementation result missing `pr.url`
- valid `verification_result.pass` with browser evidence
- valid docs-only verification with skipped functional review
- invalid browser-required verification without `browser_evidence.ran=true`
- valid verification retryable failure with feedback
- valid `release_result.completed`
- invalid completed release without `release.confirmed=true`
- invalid completed release without `issue_update.comment_summary`
- valid release retryable failure

### Production dependency tests

Use throwing fakes to prove the software-development production path no longer calls git/repo delivery operations:

- no worktree preparation
- no commit/push
- no PR creation by Northstar
- no PR merge by Northstar
- no sync worktree refresh by Northstar
- no external merge reconciliation as lifecycle truth

### Exception policy and resolver tests

Required tests:

- workflow validation accepts a valid `exception_policy`.
- workflow validation rejects unknown exception action types.
- workflow validation rejects unknown exception match fields.
- workflow validation rejects `target_stage` values that are not declared workflow stages.
- verification retryable failure returns to implementation according to YAML policy while budget remains.
- release retryable failure retries release according to YAML policy while budget remains.
- implementation retryable failure retries implementation according to YAML policy while budget remains.
- blocked exceptions escalate to `quarantined` according to YAML policy.
- retry budget exhaustion uses `on_exhausted` and transitions to `quarantined`.
- terminal agent failure escalates to `quarantined` by default policy.
- changing YAML policy changes resolver behavior without changing runtime code.

## Implementation Milestone Outline

1. Lifecycle and state-machine exception support.
2. Workflow schema support for `exception_policy`.
3. New artifact kinds and validators.
4. Software-development task/result contract module.
5. Agent-owned software-dev driver rewrite.
6. Production dependency removal for git/worktree delivery.
7. YAML-driven reconcile exception resolver.
8. Projection from `release_result.issue_update`.
9. Workflow fixtures and documentation updates.
10. Full test and coverage update.

## Acceptance Criteria

- Northstar software-development delivery no longer calls git/worktree/PR/merge operations directly.
- Northstar dispatches implementation, verification, and release agent tasks with explicit JSON contracts.
- `implementation_result`, `verification_result`, and `release_result` are validated as built-in artifacts.
- UI/browser changes require verifier browser evidence through the contract.
- Release completion is driven by schema-valid `release_result.completed`, not by Northstar-confirmed PR merge.
- All workflow-blocking abnormal outcomes enter `exception` first.
- Exception recovery decisions are driven by `workflow.exception_policy`, not hard-coded software-development runtime branches.
- Automatic exception recovery uses `runtime.max_recovery_attempts` as the retry budget.
- Exhausted or manual-required exceptions transition to `quarantined` according to `exception_policy`.
- Projection failures do not mutate lifecycle.
- Existing intentionally quarantined issues remain quarantined unless repair can prove they are recoverable exceptions.

# Northstar Operator Dashboard Design

## Goal

Build a local operator dashboard for Northstar issue execution while preserving host adapter parity across Pi, Codex, and OpenCode.

The dashboard should let an operator see the complete Northstar workflow state, inspect issue execution, run safe lifecycle actions, and use Pi as an operator assistant. Pi must not become the only execution path. Northstar remains the workflow and control-plane authority.

## Decision

Keep `pi-web` and `northstar` as separate projects for the first implementation.

`pi-web` becomes the first local client for a Northstar operator API. Northstar exposes stable local API models and allowlisted actions. This avoids making Northstar Pi-specific, keeps the CLI/runtime small, and lets pi-web reuse its existing Pi session viewer, SSE, skill management, and chat UI.

If the dashboard later becomes a core Northstar product, extract it into a dedicated `northstar-web` package. Do not move the full pi-web application into Northstar in the MVP.

## Non-Goals

- Do not replace Northstar CLI/watch with Pi agent natural-language shell execution.
- Do not make Pi required for Northstar automation.
- Do not sync raw transcripts, terminal logs, full tool arguments, or full session JSONL content to GitHub.
- Do not implement a full GitHub diff viewer in the MVP. Link to GitHub PRs instead.
- Do not make GitHub Project the source of truth. It is an external projection only.

## Architecture

```text
pi-web
  Northstar tab
    Project board
    Issue detail
    Run timeline
    Session viewer links
    Operator actions
    Guided wizard
    Pi operator assistant

Northstar local API
  Read runtime config
  Read control-plane SQLite
  Read normalized run events
  Invoke allowlisted orchestrator actions
  Resolve GitHub issue and PR metadata

Northstar runtime
  GitHub intake
  SQLite control-plane
  Workflow stages
  Host adapter execution
  PR/release orchestration
  GitHub observability projection

Host adapters
  Pi
  Codex
  OpenCode
```

Northstar owns workflow state and action semantics. pi-web renders that state and provides operator controls.

## Source of Truth

The source of truth is the Northstar runtime:

- `.northstar.yaml` for project configuration
- `.northstar/runtime/control-plane.sqlite3` for issue snapshots and history
- `.northstar/runtime/worktrees/*` for issue worktrees
- `.northstar/runtime/sync-worktrees/main` for the machine-readable synced base branch

GitHub issue labels, issue body markers, PR comments, and Project fields are projections. Projection failures must be visible in the dashboard but must not mutate lifecycle state unless the Northstar policy explicitly says so.

## Dashboard Views

### Project Board

The board groups issues by Northstar lifecycle:

- `ready`
- `running`
- `verifying`
- `verified`
- `release_pending`
- `completed`
- `failed`
- `quarantined`

Each card shows:

- issue number and title
- lifecycle and current stage
- host adapter used for the current or latest child run
- dependency count and blocked state
- PR number and merge state
- latest root session id
- latest child run id
- last heartbeat or terminal timestamp
- next recommended action
- projection failure indicator

This view resembles GitHub Projects, but it uses Northstar lifecycle semantics and Northstar runtime state.

### Issue Detail

Issue detail shows:

- GitHub issue title, URL, labels, and dependency references
- Northstar lifecycle state and current stage
- owner lease and heartbeat when active
- child runs with role, status, root session id, session id, and capability report
- worktree path and branch
- PR URL, PR status, merge SHA
- retryable effects and projection failures
- accepted artifacts and summaries
- next action recommendation

This view resembles GitHub issue detail, but it adds runtime state that GitHub cannot represent cleanly.

### Run Timeline

The timeline shows ordered runtime events:

- intake packet recorded
- owner lease claimed
- root session started
- child run started
- worktree prepared
- worker artifact accepted or rejected
- branch pushed
- PR created or reused
- verifier run started
- evidence packet accepted or rejected
- release started
- PR merged
- issue closed
- projection synced or failed
- quarantine, retryable failure, or terminal failure

Timeline events should be compact, redacted, and filterable by stage, role, and severity.

### Session Viewer

For Pi-backed runs, pi-web can link directly to the existing Pi session viewer because Pi persists JSONL session files under `~/.pi/agent/sessions`.

For Codex and OpenCode-backed runs, the dashboard uses Northstar normalized run events instead of Pi JSONL. This preserves host neutrality.

Session links should be optional metadata. Missing session content must not prevent issue inspection.

### Operator Actions

The dashboard exposes allowlisted actions only:

- `intake`
- `start`
- `reconcile`
- `release`
- `retry-sync`
- `inspect`

High-impact actions require confirmation:

- `release`
- retrying a failed or quarantined issue
- manual repair actions added later

Each action response displays:

- action result
- updated lifecycle
- created or reused PR
- changed projection status
- next recommended action

The UI must call Northstar action APIs. It must not ask Pi to run arbitrary shell commands for lifecycle control.

### Guided Wizard

The dashboard includes a guided wizard for taking a user from a blank or partially configured repository to a completed Northstar run.

The wizard follows the Northstar skill phase model:

- `plan`
- `setup`
- `execute`
- `monitor`
- `recovery`
- `report`

Each phase is a stateful checklist with:

- required inputs
- read-only discovery steps
- generated command plans
- confirmation gates
- allowed Northstar API actions
- GitHub or Project mutations, if any
- completion evidence
- next recommended phase

The wizard should use the same language as the Northstar skill commands:

- `/northstar-plan`
- `/northstar-setup`
- `/northstar-execute`
- `/northstar-observe`
- `/northstar-recover`
- `/northstar-report`

The wizard is not a chat-only flow. Pi can explain and guide each phase, but the UI records wizard state and invokes Northstar API actions through allowlisted operations.

#### Plan Phase

The plan phase helps the operator define work before runtime setup:

- collect project intent
- identify the target repository
- choose whether to generate issues from a spec and implementation plan
- dry-run issue drafts
- show dependency order, acceptance criteria, and secret-scan status
- ask for confirmation before creating GitHub issues

Allowed actions:

- read project context
- run planning dry-runs
- create issues only after confirmation

#### Setup Phase

The setup phase prepares Northstar in the consumer repository:

- run doctor checks
- detect GitHub remote and default branch
- render `.northstar.yaml` draft
- validate credentials and host SDK availability
- select default host adapter while preserving Pi, Codex, and OpenCode support
- plan GitHub labels and Project viewer fields
- ask before writing config or mutating GitHub

Allowed actions:

- doctor
- render config draft
- write config after confirmation
- create labels after confirmation
- create or update Project fields/views after confirmation

#### Execute Phase

The execute phase starts work:

- show issue queue and dependency order
- show workflow, role, host adapter, capacity, and release mode
- choose single-issue or watch execution
- show exact expected effects before dispatch

Allowed actions:

- intake
- start
- watch
- reconcile
- release when auto-release policy allows it or the operator confirms

#### Monitor Phase

The monitor phase observes active work:

- show active issues and stage transitions
- show GitHub issue, PR, and Project projection status
- show root sessions, child sessions, heartbeats, worktrees, and artifacts
- show retryable failures and next actions
- link Pi-backed runs to the Pi session viewer

Allowed actions:

- inspect
- list issues
- list events
- retry projection sync
- open session viewer links

#### Recovery Phase

The recovery phase diagnoses abnormal states:

- stale watch lock
- expired lease
- SDK timeout or credential failure
- git push or PR creation failure
- merge conflict
- Project projection mismatch
- failed browser or UAT verification
- quarantined or failed issue

Recovery actions are risk-classified. Low-risk inspect and reconcile actions can run automatically. Medium and high-risk actions require explicit confirmation.

Allowed actions:

- inspect
- reconcile
- retry-sync
- repair-runtime after confirmation when needed
- release retry after confirmation

#### Report Phase

The report phase produces completion evidence:

- repo URL
- Project URL when enabled
- issue URLs
- PR URLs
- merge SHAs
- dependency order
- host adapter usage
- verification commands and results
- browser or UAT evidence when available
- recovery actions
- unresolved blockers
- recommended next steps

The report can be short, full audit, or training-manual style.

## Pi Operator Assistant

Pi acts as an operator assistant, not as the workflow authority.

Pi can:

- explain why an issue is blocked
- summarize runtime history
- suggest the next action
- draft GitHub issue text
- draft a Northstar plan
- guide wizard phases from plan through report
- inspect dashboard-visible state
- call allowlisted Northstar actions through a tool/API

Pi should not:

- directly mutate SQLite
- directly edit `.northstar.yaml` without an explicit operator action
- run unrestricted shell commands to drive lifecycle
- bypass Northstar idempotency and action checks

Pi sessions used for operator assistance are separate from issue worker sessions. This separation prevents confusion between "agent doing product work" and "agent helping the operator".

## Northstar Local API

Northstar should expose local API models that both CLI and web clients can use.

Initial read endpoints:

- `GET /projects`
- `GET /projects/:projectId/issues`
- `GET /projects/:projectId/issues/:issueId`
- `GET /projects/:projectId/issues/:issueId/history`
- `GET /projects/:projectId/issues/:issueId/events`
- `GET /projects/:projectId/issues/:issueId/sessions`
- `GET /projects/:projectId/wizard`

Initial action endpoint:

- `POST /projects/:projectId/issues/:issueId/actions`
- `POST /projects/:projectId/wizard/actions`

Action body:

```json
{
  "action": "start"
}
```

Action names map to existing Northstar CLI/orchestrator commands.

Wizard actions map to Northstar phase commands and local API operations. They must return the updated wizard state and any generated command plan before performing mutations.

The API can be implemented as a local Node module first, then wrapped by pi-web Next.js API routes. It does not need a standalone daemon in the MVP.

## Data Models

### Issue Card

```ts
interface NorthstarIssueCard {
  issueId: string;
  issueNumber: number | null;
  title: string;
  lifecycle: string;
  currentStage: string | null;
  hostAdapter: "pi" | "codex" | "opencode" | null;
  prUrl: string | null;
  mergeSha: string | null;
  lastHeartbeatAt: string | null;
  nextAction: string;
  hasProjectionFailure: boolean;
  hasRetryableEffect: boolean;
}
```

### Issue Detail

```ts
interface NorthstarIssueDetail extends NorthstarIssueCard {
  sourceUrl: string | null;
  labels: string[];
  dependencies: unknown[];
  ownerLease: unknown | null;
  childRuns: NorthstarChildRun[];
  worktreePath: string | null;
  branch: string | null;
  history: NorthstarTimelineEvent[];
  projectionSync: unknown[];
  artifacts: NorthstarArtifactSummary[];
}
```

### Child Run

```ts
interface NorthstarChildRun {
  childRunId: string;
  rootSessionId: string;
  sessionId: string;
  role: string;
  status: string;
  hostAdapter: "pi" | "codex" | "opencode" | null;
  capabilityReport: unknown | null;
  sessionLink: string | null;
}
```

### Timeline Event

```ts
interface NorthstarTimelineEvent {
  id: number | null;
  sequence: number | null;
  createdAt: string | null;
  eventType: string;
  severity: "info" | "warning" | "error";
  stage: string | null;
  role: string | null;
  summary: string;
  payloadPreview: unknown;
}
```

Payload previews are redacted and bounded. They must not include raw transcripts.

### Artifact Summary

```ts
interface NorthstarArtifactSummary {
  historyId: number | null;
  role: string;
  artifactKind: "worker_result" | "evidence_packet" | "release_result" | string;
  status: string;
  observedAt: string | null;
  summary: string;
  payloadPreview: unknown;
}
```

Artifact summaries come from accepted artifact history and must use the same redaction and size bounds as timeline payload previews.

### Wizard State

```ts
type NorthstarWizardPhase =
  | "plan"
  | "setup"
  | "execute"
  | "monitor"
  | "recovery"
  | "report";

interface NorthstarWizardState {
  projectId: string;
  currentPhase: NorthstarWizardPhase;
  phases: NorthstarWizardPhaseState[];
  selectedOptions: Record<string, unknown>;
  commandPlans: NorthstarCommandPlan[];
  confirmationGates: NorthstarConfirmationGate[];
  evidence: NorthstarWizardEvidence[];
  nextRecommendedAction: string | null;
}
```

### Wizard Phase State

```ts
interface NorthstarWizardPhaseState {
  phase: NorthstarWizardPhase;
  status: "not_started" | "ready" | "waiting_for_confirmation" | "running" | "completed" | "blocked";
  summary: string;
  requiredInputs: string[];
  completedChecks: string[];
  blockers: string[];
}
```

### Command Plan

```ts
interface NorthstarCommandPlan {
  id: string;
  phase: NorthstarWizardPhase;
  description: string;
  argv: string[];
  expectedEffects: string[];
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
}
```

### Confirmation Gate

```ts
interface NorthstarConfirmationGate {
  id: string;
  phase: NorthstarWizardPhase;
  title: string;
  reason: string;
  commandPlanIds: string[];
  status: "open" | "approved" | "rejected";
}
```

### Wizard Evidence

```ts
interface NorthstarWizardEvidence {
  phase: NorthstarWizardPhase;
  kind: "doctor" | "config" | "github" | "project" | "runtime" | "verification" | "recovery" | "report";
  summary: string;
  links: Array<{ label: string; url: string }>;
  payloadPreview: unknown;
}
```

Wizard state should be resumable. In the MVP it can be derived from runtime state and cached in pi-web local state. A later phase can persist it in Northstar runtime storage.

## Run Events

The MVP can use existing `issue_history` as the initial event source. A later phase adds a dedicated `run_events` table for normalized host event streaming.

`run_events` should capture:

- session created
- message started
- assistant text summary
- tool call started
- tool call completed
- command started
- command completed
- artifact emitted
- final response received

All events must pass through redaction and size bounds before persistence.

## GitHub Projection

GitHub projection should remain bounded:

- update lifecycle labels
- upsert a Northstar status marker in the issue body
- create transition comments for meaningful lifecycle changes
- comment PR verifier evidence summary
- sync Project fields when configured

The issue body marker should include:

- lifecycle
- current stage
- PR URL
- latest root session id
- latest child run id
- last heartbeat
- next action
- recent projection failure summary

Do not sync raw session content to GitHub.

## Integration Strategy

### Phase 1: pi-web Northstar Tab

Add a Northstar tab to pi-web. The tab uses Next.js API routes that call a Northstar local API module.

New pi-web routes:

- `GET /api/northstar/projects`
- `GET /api/northstar/projects/[projectId]/issues`
- `GET /api/northstar/projects/[projectId]/issues/[issueId]`
- `GET /api/northstar/projects/[projectId]/issues/[issueId]/events`
- `GET /api/northstar/projects/[projectId]/wizard`
- `POST /api/northstar/projects/[projectId]/wizard/actions`
- `POST /api/northstar/projects/[projectId]/issues/[issueId]/actions`

Phase 1 is read-heavy and action-light. It proves the operator model without restructuring either repository.

### Phase 2: Northstar Local API Package

Add a stable Northstar local API package or module that can be imported by pi-web.

The module owns:

- config loading
- store opening
- issue list projection
- issue detail projection
- action dispatch
- wizard state projection
- wizard command-plan generation
- error normalization
- redaction

This prevents pi-web from depending on SQLite table details.

### Phase 3: Guided Wizard

Add the guided wizard to pi-web after issue board/detail data is stable.

The wizard should:

- start from a selected repository or project root
- guide `plan`, `setup`, `execute`, `monitor`, `recovery`, and `report`
- show one decision at a time
- store selected options in wizard state
- generate command plans for each phase
- require confirmation before config, GitHub, Project, dispatch, release, or recovery mutations
- let the operator switch from wizard to issue detail or board without losing context

The wizard should use Pi for explanations and recommendations, while Northstar local API owns the actual action model.

### Phase 4: Pi Operator Tools

Expose Northstar actions as Pi tools:

- inspect issue
- summarize issue
- list blocked issues
- recommend next action
- get wizard state
- advance wizard phase
- generate wizard command plan
- execute allowlisted action

Pi operator sessions can then use Northstar skills while still operating through the Northstar API.

### Phase 5: Dedicated Northstar Web Decision

After the dashboard proves useful, decide whether to:

- keep it as a pi-web integration, or
- extract a dedicated `northstar-web` project, or
- create a shared UI package used by both.

The extraction decision should be based on whether non-Pi operators need the dashboard.

## Security and Safety

- Redact secrets before storing or displaying payload previews.
- Bound payload preview length.
- Treat full session content as local-only.
- Require confirmation before release and retry actions.
- Require confirmation before wizard actions that write config, create GitHub issues, mutate labels, mutate Project fields/views, dispatch workers, merge PRs, or run recovery.
- Keep action names allowlisted.
- Do not expose arbitrary shell execution through the dashboard.
- Do not let Pi directly edit Northstar runtime tables.
- Do not let Pi directly advance wizard state without the same confirmation gates the UI uses.
- Preserve the existing lifecycle idempotency rules.

## MVP Acceptance Criteria

- pi-web shows a Northstar board grouped by lifecycle.
- pi-web shows issue detail with child runs, root sessions, worktree, PR, projection failures, and next action.
- Pi-backed child runs link to the existing Pi session viewer when a session file is resolvable.
- Codex and OpenCode child runs still appear with normalized runtime information.
- The dashboard can invoke `inspect`, `start`, `reconcile`, `release`, and `retry-sync` through Northstar allowlisted actions.
- The wizard guides a user through `plan`, `setup`, `execute`, `monitor`, `recovery`, and `report`.
- The wizard shows generated command plans and expected effects before mutation.
- The wizard preserves Pi, Codex, and OpenCode adapter choices and does not make Pi required for worker execution.
- Pi can explain wizard phases and recommend next steps, but all wizard mutations use Northstar allowlisted actions.
- GitHub issue projection remains bounded to lifecycle/status summaries.
- No raw transcript or full terminal log is posted to GitHub.
- Northstar CLI/watch behavior remains unchanged.

## Recommended First Implementation Plan

Start with Phase 1 and Phase 2 together:

1. Add Northstar local API read models.
2. Add issue list and issue detail projection tests.
3. Add allowlisted action wrapper tests.
4. Add pi-web API routes that call the Northstar local API.
5. Add pi-web Northstar tab with board and issue detail.
6. Add Pi session links for Pi-backed child runs.
7. Add wizard state and command-plan models.
8. Add wizard UI for plan, setup, execute, monitor, recovery, and report.
9. Add Pi operator tools for read-only wizard help first.
10. Add bounded GitHub status marker improvements only after dashboard state is stable.

This sequence gives immediate operator visibility while preserving host adapter neutrality.

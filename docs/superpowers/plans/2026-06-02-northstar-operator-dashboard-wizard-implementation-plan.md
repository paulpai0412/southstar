# Northstar Operator Dashboard Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first local Northstar operator dashboard and guided wizard so a user can select a project, inspect runtime state, follow `plan -> setup -> execute -> monitor -> recovery -> report`, and run only allowlisted Northstar actions.

**Architecture:** Northstar owns the typed local API, read models, wizard state, command plans, confirmation gates, and action semantics. pi-web is the first client: it loads the Northstar local API through a small server-side bridge, renders the board/detail/timeline/wizard views, and uses Pi only for explanation and recommendations. Pi, Codex, and OpenCode remain equivalent worker host adapters; MCP is represented in the API model as a future capability field only.

**Tech Stack:** Node 22 TypeScript ESM, `node:test`, SQLite through `node:sqlite`, existing Northstar orchestrator/runtime modules, Next.js 16 App Router, React 19, pi-web CSS variables and session viewer.

---

## Source Spec

Read before implementing:

- `docs/superpowers/specs/2026-06-02-northstar-operator-dashboard-design.md`
- `src/runtime/store.ts`
- `src/orchestrator/inspect.ts`
- `src/orchestrator/production-factory.ts`
- `skills/northstar/scripts/lib/operator-commands.mjs`
- `skills/northstar/scripts/lib/setup-flow.mjs`
- `/home/timmypai/apps/pi-web/AGENTS.md`
- `/home/timmypai/apps/pi-web/components/AppShell.tsx`

## Scope Boundary

This plan implements the dashboard and wizard MVP. The current `codex/session-0536` branch has skill-level `plan-issues` command planning, but the production `northstar plan-issues` CLI is not present in `src/cli/northstar.ts`. Therefore:

- The wizard plan phase must support existing GitHub issues and dry-run issue drafts through the skill planning helper.
- The wizard must show a clear blocked confirmation gate when the user asks to create GitHub issues and production `plan-issues --apply --confirm` is unavailable.
- Actual GitHub issue creation from specs should be enabled only after `docs/plans/2026-06-01-northstar-skill-plan-issues-implementation-plan.md` is completed or restored.
- Setup, execute, monitor, recovery, and report phases are implemented against the existing runtime/orchestrator commands.

## File Structure

Northstar files:

- Create `src/operator-dashboard/models.ts`  
  Shared dashboard, action, wizard, command-plan, confirmation-gate, evidence, and report types.

- Create `src/operator-dashboard/read-model.ts`  
  Pure functions that turn `IssueSnapshot` and `HistoryEntry` rows into board cards, issue details, event timelines, session links, and report evidence.

- Create `src/operator-dashboard/wizard.ts`  
  Pure wizard state machine and command-plan generator for `plan`, `setup`, `execute`, `monitor`, `recovery`, and `report`.

- Create `src/operator-dashboard/local-api.ts`  
  Runtime-backed local API facade. It loads config, opens the control-plane store, returns read models, returns wizard state, and invokes allowlisted actions.

- Modify `src/runtime/store.ts`  
  Add public listing helpers for dashboard reads.

- Modify `src/cli/entrypoint.ts`  
  No new CLI command in the MVP. Add no behavior unless a later task discovers tests require a CLI bridge.

- Modify `tests/index.test.ts`  
  Import the new dashboard tests.

Northstar tests:

- Create `tests/operator-dashboard/read-model.test.ts`
- Create `tests/operator-dashboard/wizard.test.ts`
- Create `tests/operator-dashboard/local-api.test.ts`
- Modify `tests/runtime/store.test.ts`

pi-web files:

- Create `/home/timmypai/apps/pi-web/lib/northstar/types.ts`  
  Client-side mirror of the Northstar local API JSON contract.

- Create `/home/timmypai/apps/pi-web/lib/northstar/server-client.ts`  
  Server-only bridge that dynamically loads the Northstar local API from `NORTHSTAR_ROOT` or the selected project root.

- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/route.ts`
- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/route.ts`
- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/route.ts`
- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/events/route.ts`
- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/actions/route.ts`
- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/wizard/route.ts`
- Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/wizard/actions/route.ts`

- Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`
- Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarBoard.tsx`
- Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarIssueDetail.tsx`
- Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarTimeline.tsx`
- Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarWizard.tsx`
- Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarPiAssistant.tsx`
- Modify `/home/timmypai/apps/pi-web/components/AppShell.tsx`

pi-web verification:

- Run `cd /home/timmypai/apps/pi-web && node_modules/.bin/tsc --noEmit`
- Run `cd /home/timmypai/apps/pi-web && npm run lint`
- Run `cd /home/timmypai/apps/pi-web && npm run dev`
- Verify the Northstar tab in browser at `http://localhost:3030`

---

### Task 1: Northstar Store Listing And Dashboard Types

**Files:**
- Create: `src/operator-dashboard/models.ts`
- Modify: `src/runtime/store.ts`
- Modify: `tests/runtime/store.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing store tests**

Append to `tests/runtime/store.test.ts`:

```ts
test("dashboard issue listing returns every snapshot in stable issue order", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    store.createIssue(newIssueSnapshot("github:2", { lifecycle_state: "running" }));
    store.createIssue(newIssueSnapshot("github:1", { lifecycle_state: "ready" }));

    assert.deepEqual(
      store.listIssues().map((issue) => issue.issue_id),
      ["github:1", "github:2"],
    );
  } finally {
    store.close();
    await cleanup();
  }
});

test("dashboard history map returns issue histories keyed by issue id", async () => {
  const { store, cleanup } = await createTempStore();
  try {
    const first = store.createIssue(newIssueSnapshot("github:1"));
    const second = store.createIssue(newIssueSnapshot("github:2"));
    store.recordIdempotentHistory(first.id, {
      event_type: "runtime_event",
      payload: { idempotency_key: "first-event", value: "one" },
    });
    store.recordIdempotentHistory(second.id, {
      event_type: "runtime_event",
      payload: { idempotency_key: "second-event", value: "two" },
    });

    const histories = store.listHistoriesByIssueId(["github:1", "github:2"]);

    assert.equal(histories.get("github:1")?.[0].payload.value, "one");
    assert.equal(histories.get("github:2")?.[0].payload.value, "two");
  } finally {
    store.close();
    await cleanup();
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/store.test.ts
```

Expected: FAIL because `listIssues` and `listHistoriesByIssueId` do not exist.

- [ ] **Step 3: Add public store listing helpers**

In `src/runtime/store.ts`, add these methods to `SqliteControlPlaneStore`:

```ts
  listIssues(): IssueSnapshot[] {
    return this.db.prepare(`
      SELECT snapshot_json
      FROM issues
      ORDER BY
        CASE
          WHEN id LIKE 'github:%' THEN CAST(SUBSTR(id, 8) AS INTEGER)
          ELSE NULL
        END,
        id
    `).all().map((row) => JSON.parse(row.snapshot_json as string) as IssueSnapshot);
  }

  listHistoriesByIssueId(issueIds: string[]): Map<string, HistoryEntry[]> {
    const histories = new Map<string, HistoryEntry[]>();
    for (const issueId of issueIds) {
      histories.set(issueId, this.listHistory(issueId));
    }
    return histories;
  }
```

- [ ] **Step 4: Create dashboard type contract**

Create `src/operator-dashboard/models.ts`:

```ts
import type { HistoryEntry, IssueSnapshot, LifecycleState } from "../types/control-plane.ts";

export const northstarWizardPhases = ["plan", "setup", "execute", "monitor", "recovery", "report"] as const;
export type NorthstarWizardPhase = typeof northstarWizardPhases[number];

export type OperatorActionName = "intake" | "start" | "reconcile" | "release" | "retry-sync" | "inspect";
export type WizardActionName =
  | "select_phase"
  | "generate_command_plan"
  | "approve_gate"
  | "reject_gate"
  | "run_phase_action";

export interface NorthstarProjectSummary {
  projectId: string;
  name: string;
  root: string;
  repo: string;
  hostAdapter: "codex" | "opencode" | "pi";
  configPath: string;
  runtimeDbPath: string;
}

export interface NorthstarBoard {
  project: NorthstarProjectSummary;
  groups: NorthstarBoardGroup[];
}

export interface NorthstarBoardGroup {
  lifecycle: LifecycleState;
  cards: NorthstarBoardCard[];
}

export interface NorthstarBoardCard {
  issueId: string;
  issueNumber: string | null;
  title: string;
  lifecycle: LifecycleState;
  currentStage: string | null;
  latestHostAdapter: "codex" | "opencode" | "pi" | null;
  dependencyCount: number;
  blocked: boolean;
  prUrl: string | null;
  mergeSha: string | null;
  latestRootSessionId: string | null;
  latestChildRunId: string | null;
  lastHeartbeatAt: string | null;
  nextRecommendedAction: string;
  projectionFailure: boolean;
}

export interface NorthstarIssueDetail {
  snapshot: IssueSnapshot;
  title: string;
  sourceUrl: string | null;
  labels: string[];
  inspect: Record<string, unknown>;
  timeline: NorthstarRunEvent[];
  sessionLinks: NorthstarSessionLink[];
  acceptedArtifacts: NorthstarArtifactSummary[];
}

export interface NorthstarRunEvent {
  id: string;
  sequence: number;
  eventType: string;
  severity: "info" | "warning" | "error";
  createdAt: string | null;
  summary: string;
  payloadPreview: unknown;
}

export interface NorthstarSessionLink {
  host: "pi" | "codex" | "opencode";
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  href: string | null;
}

export interface NorthstarArtifactSummary {
  historyId: number;
  kind: string;
  summary: string;
}

export interface NorthstarWizardState {
  projectId: string;
  currentPhase: NorthstarWizardPhase;
  phases: NorthstarWizardPhaseState[];
  selectedOptions: Record<string, unknown>;
  commandPlans: NorthstarCommandPlan[];
  confirmationGates: NorthstarConfirmationGate[];
  evidence: NorthstarWizardEvidence[];
  nextRecommendedAction: string | null;
}

export interface NorthstarWizardPhaseState {
  phase: NorthstarWizardPhase;
  status: "not_started" | "ready" | "waiting_for_confirmation" | "running" | "completed" | "blocked";
  summary: string;
  requiredInputs: string[];
  completedChecks: string[];
  blockers: string[];
}

export interface NorthstarCommandPlan {
  id: string;
  phase: NorthstarWizardPhase;
  description: string;
  argv: string[];
  expectedEffects: string[];
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
}

export interface NorthstarConfirmationGate {
  id: string;
  phase: NorthstarWizardPhase;
  title: string;
  reason: string;
  commandPlanIds: string[];
  status: "open" | "approved" | "rejected";
}

export interface NorthstarWizardEvidence {
  phase: NorthstarWizardPhase;
  kind: "doctor" | "config" | "github" | "project" | "runtime" | "verification" | "recovery" | "report";
  summary: string;
  links: Array<{ label: string; url: string }>;
  payloadPreview: unknown;
}

export interface OperatorActionRequest {
  action: OperatorActionName;
  issueId: string;
  confirmed?: boolean;
}

export interface OperatorActionResponse {
  action: OperatorActionName;
  result: unknown;
  updatedIssue?: NorthstarIssueDetail;
  nextRecommendedAction: string | null;
}

export interface WizardActionRequest {
  action: WizardActionName;
  phase?: NorthstarWizardPhase;
  gateId?: string;
  commandPlanId?: string;
  issueId?: string;
  options?: Record<string, unknown>;
  confirmed?: boolean;
}

export interface WizardActionResponse {
  state: NorthstarWizardState;
  actionResult?: unknown;
}

export interface DashboardReadInput {
  project: NorthstarProjectSummary;
  issues: IssueSnapshot[];
  historiesByIssueId: Map<string, HistoryEntry[]>;
  now: string;
}
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/runtime/store.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/operator-dashboard/models.ts src/runtime/store.ts tests/runtime/store.test.ts tests/index.test.ts
git commit -m "feat: add operator dashboard data contract"
```

---

### Task 2: Northstar Board, Detail, Timeline, And Session Read Models

**Files:**
- Create: `src/operator-dashboard/read-model.ts`
- Create: `tests/operator-dashboard/read-model.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing read-model tests**

Create `tests/operator-dashboard/read-model.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildNorthstarBoard, buildNorthstarIssueDetail } from "../../src/operator-dashboard/read-model.ts";
import type { NorthstarProjectSummary } from "../../src/operator-dashboard/models.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import type { HistoryEntry } from "../../src/types/control-plane.ts";

const project: NorthstarProjectSummary = {
  projectId: "northstar-test",
  name: "northstar-test",
  root: "/repo",
  repo: "owner/repo",
  hostAdapter: "pi",
  configPath: "/repo/.northstar.yaml",
  runtimeDbPath: "/repo/.northstar/runtime/control-plane.sqlite3",
};

test("board groups issues by lifecycle and preserves host adapter parity", () => {
  const ready = newIssueSnapshot("github:1", {
    lifecycle_state: "ready",
  });
  ready.runtime_context_json.issue_packet = {
    issue_number: "1",
    title: "Ready task",
    source_url: "https://github.com/owner/repo/issues/1",
    labels: ["northstar:ready"],
    dependencies: [],
  };

  const running = newIssueSnapshot("github:2", {
    lifecycle_state: "running",
    stage_cursor: "implementation",
  });
  running.runtime_context_json.child_runs = [{
    child_run_id: "child-2",
    lease_id: "lease-2",
    root_session_id: "root-2",
    role: "developer",
    status: "running",
    session_id: "pi-session-2",
    started_at: "2026-06-02T01:00:00.000Z",
    last_seen_at: "2026-06-02T01:01:00.000Z",
    capability_report: {
      host: "pi",
      applied: ["agent", "model"],
      defaulted: [],
      unsupported: ["mcp_servers"],
    },
  }];

  const board = buildNorthstarBoard({
    project,
    issues: [ready, running],
    historiesByIssueId: new Map(),
    now: "2026-06-02T01:02:00.000Z",
  });

  assert.deepEqual(board.groups.find((group) => group.lifecycle === "ready")?.cards.map((card) => card.issueId), ["github:1"]);
  assert.deepEqual(board.groups.find((group) => group.lifecycle === "running")?.cards.map((card) => card.latestHostAdapter), ["pi"]);
});

test("issue detail includes compact timeline, redacted payload preview, and Pi session link", () => {
  const snapshot = newIssueSnapshot("github:7", { lifecycle_state: "running" });
  snapshot.runtime_context_json.issue_packet = {
    issue_number: "7",
    title: "Inspect task",
    source_url: "https://github.com/owner/repo/issues/7",
    labels: ["northstar:ready"],
    dependencies: [],
  };
  snapshot.runtime_context_json.child_runs = [{
    child_run_id: "child-7",
    lease_id: "lease-7",
    root_session_id: "root-7",
    role: "developer",
    status: "running",
    session_id: "pi-session-7",
    started_at: "2026-06-02T02:00:00.000Z",
    last_seen_at: "2026-06-02T02:01:00.000Z",
    capability_report: {
      host: "pi",
      applied: ["agent"],
      defaulted: ["model"],
      unsupported: [],
    },
  }];
  const history: HistoryEntry[] = [{
    id: 1,
    sequence: 1,
    event_type: "effect_failed_retryable",
    created_at: "2026-06-02T02:01:00.000Z",
    payload: { last_error: "token ghp_abcdefghijklmnopqrstuvwxyz123456 leaked" },
  }];

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T02:02:00.000Z",
  });

  assert.equal(detail.title, "Inspect task");
  assert.equal(detail.timeline[0].severity, "error");
  assert.match(JSON.stringify(detail.timeline[0].payloadPreview), /ghp_\*\*\*/);
  assert.equal(detail.sessionLinks[0].host, "pi");
  assert.equal(detail.sessionLinks[0].href, "/?session=pi-session-7");
});
```

Append to `tests/index.test.ts`:

```ts
import "./operator-dashboard/read-model.test.ts";
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/read-model.test.ts
```

Expected: FAIL because `src/operator-dashboard/read-model.ts` does not exist.

- [ ] **Step 3: Implement read-model functions**

Create `src/operator-dashboard/read-model.ts` with these exports:

```ts
import { inspectIssueSnapshot } from "../orchestrator/inspect.ts";
import { redactSecrets } from "../runtime/redaction.ts";
import { lifecycleStates, type ChildRun, type HistoryEntry, type IssueSnapshot } from "../types/control-plane.ts";
import type {
  DashboardReadInput,
  NorthstarArtifactSummary,
  NorthstarBoard,
  NorthstarBoardCard,
  NorthstarIssueDetail,
  NorthstarProjectSummary,
  NorthstarRunEvent,
  NorthstarSessionLink,
} from "./models.ts";

export function buildNorthstarBoard(input: DashboardReadInput): NorthstarBoard {
  const histories = input.historiesByIssueId;
  const cards = input.issues.map((snapshot) => boardCardForSnapshot(snapshot, histories.get(snapshot.issue_id) ?? [], input.now));
  return {
    project: input.project,
    groups: lifecycleStates.map((lifecycle) => ({
      lifecycle,
      cards: cards.filter((card) => card.lifecycle === lifecycle),
    })),
  };
}

export function buildNorthstarIssueDetail(input: {
  project: NorthstarProjectSummary;
  snapshot: IssueSnapshot;
  history: HistoryEntry[];
  now: string;
}): NorthstarIssueDetail {
  return {
    snapshot: redactSecrets(input.snapshot),
    title: issueTitle(input.snapshot),
    sourceUrl: issueSourceUrl(input.snapshot),
    labels: issueLabels(input.snapshot),
    inspect: redactSecrets(inspectIssueSnapshot(input.snapshot, input.history)) as Record<string, unknown>,
    timeline: input.history.map((entry) => runEventForHistory(entry)),
    sessionLinks: sessionLinksForSnapshot(input.snapshot),
    acceptedArtifacts: acceptedArtifactsForHistory(input.history),
  };
}

export function runEventForHistory(entry: HistoryEntry): NorthstarRunEvent {
  return {
    id: String(entry.id ?? `${entry.sequence ?? 0}:${entry.event_type}`),
    sequence: entry.sequence ?? 0,
    eventType: entry.event_type,
    severity: eventSeverity(entry),
    createdAt: entry.created_at ?? null,
    summary: summarizeEvent(entry),
    payloadPreview: compactPayloadPreview(redactSecrets(entry.payload)),
  };
}
```

Add helper functions in the same file with these concrete behaviors:

- `boardCardForSnapshot` reads issue packet fields from `snapshot.runtime_context_json.issue_packet`.
- `latestHostAdapter` reads the last child run capability report host and returns `codex`, `opencode`, `pi`, or `null`.
- `nextRecommendedAction` returns `start` for `ready`, `reconcile` for `claimed/running/verifying`, `release` for `verified`, `retry-sync` when history has `effect_failed_retryable`, `inspect` for `failed/quarantined`, and `none` for `completed/cancelled`.
- `projectionFailure` is true when any `runtime_context_json.projection_sync` row has `status` equal to `failed` or `retryable`.
- `eventSeverity` returns `error` for event names containing `failed`, `quarantine`, or `violation`; `warning` for names containing `retry`, `blocked`, or `stale`; otherwise `info`.
- `compactPayloadPreview` returns primitives unchanged, arrays capped to 10 items, objects capped to 20 sorted keys, and strings capped to 500 characters.
- `sessionLinksForSnapshot` returns `/ ?session=` links without the space for Pi child runs, and `null` href for Codex/OpenCode child runs.

The Pi link expression must be:

```ts
const href = host === "pi" ? `/?session=${encodeURIComponent(run.session_id)}` : null;
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/read-model.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operator-dashboard/read-model.ts tests/operator-dashboard/read-model.test.ts tests/index.test.ts
git commit -m "feat: add northstar dashboard read models"
```

---

### Task 3: Northstar Guided Wizard State And Command Plans

**Files:**
- Create: `src/operator-dashboard/wizard.ts`
- Create: `tests/operator-dashboard/wizard.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing wizard tests**

Create `tests/operator-dashboard/wizard.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialWizardState,
  generateWizardCommandPlan,
  reduceWizardAction,
} from "../../src/operator-dashboard/wizard.ts";

test("initial wizard state exposes all northstar phases and starts at plan", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: false,
    hostAdapter: "codex",
    issueCount: 0,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: false,
  });

  assert.equal(state.currentPhase, "plan");
  assert.deepEqual(state.phases.map((phase) => phase.phase), ["plan", "setup", "execute", "monitor", "recovery", "report"]);
  assert.equal(state.phases.find((phase) => phase.phase === "setup")?.status, "ready");
  assert.equal(state.nextRecommendedAction, "Generate a plan command or move to setup for an existing GitHub issue workflow.");
});

test("wizard setup plan preserves codex opencode and pi host adapter choices", () => {
  const plan = generateWizardCommandPlan({
    phase: "setup",
    configPath: "/repo/.northstar.yaml",
    hostAdapter: "pi",
    options: { selectedHostAdapter: "opencode" },
  });

  assert.equal(plan.phase, "setup");
  assert.equal(plan.risk, "medium");
  assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(plan.argv, ["node", "skills/northstar/scripts/doctor.mjs", "--config", "/repo/.northstar.yaml"]);
  assert.match(plan.expectedEffects.join("\n"), /Host adapter choices remain codex, opencode, and pi/);
});

test("wizard create issues plan is blocked when production plan-issues cli is absent", () => {
  const state = buildInitialWizardState({
    projectId: "northstar-test",
    configPath: "/repo/.northstar.yaml",
    hasConfig: true,
    hostAdapter: "codex",
    issueCount: 0,
    activeIssueCount: 0,
    hasRetryableFailures: false,
    planIssuesCliAvailable: false,
  });

  const next = reduceWizardAction(state, {
    action: "generate_command_plan",
    phase: "plan",
    options: { mode: "create_issues", specPath: "docs/spec.md", planPath: "docs/plan.md" },
  });

  assert.equal(next.phases.find((phase) => phase.phase === "plan")?.status, "blocked");
  assert.match(next.confirmationGates[0].reason, /production northstar plan-issues CLI is not available/);
  assert.equal(next.commandPlans[0].requiresConfirmation, true);
  assert.equal(next.commandPlans[0].risk, "high");
});

test("wizard execute plan requires confirmation before dispatching workers", () => {
  const plan = generateWizardCommandPlan({
    phase: "execute",
    configPath: "/repo/.northstar.yaml",
    issueId: "github:42",
    hostAdapter: "pi",
    options: { mode: "single_issue" },
  });

  assert.deepEqual(plan.argv, ["node", "--run", "northstar", "--", "start", "--config", "/repo/.northstar.yaml", "--issue", "42"]);
  assert.equal(plan.risk, "medium");
  assert.equal(plan.requiresConfirmation, true);
  assert.match(plan.expectedEffects.join("\n"), /Dispatch one Northstar worker through the configured host adapter pi/);
});
```

Append to `tests/index.test.ts`:

```ts
import "./operator-dashboard/wizard.test.ts";
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/wizard.test.ts
```

Expected: FAIL because `src/operator-dashboard/wizard.ts` does not exist.

- [ ] **Step 3: Implement wizard phase state**

Create `src/operator-dashboard/wizard.ts` with these exports:

```ts
import type { HostAdapterName } from "../config/schema.ts";
import type {
  NorthstarCommandPlan,
  NorthstarConfirmationGate,
  NorthstarWizardPhase,
  NorthstarWizardState,
  WizardActionRequest,
} from "./models.ts";
import { northstarWizardPhases } from "./models.ts";

export interface WizardContext {
  projectId: string;
  configPath: string;
  hasConfig: boolean;
  hostAdapter: HostAdapterName;
  issueCount: number;
  activeIssueCount: number;
  hasRetryableFailures: boolean;
  planIssuesCliAvailable: boolean;
}

export function buildInitialWizardState(context: WizardContext): NorthstarWizardState {
  return {
    projectId: context.projectId,
    currentPhase: "plan",
    phases: northstarWizardPhases.map((phase) => phaseStateForContext(phase, context)),
    selectedOptions: {
      hostAdapter: context.hostAdapter,
      planIssuesCliAvailable: context.planIssuesCliAvailable,
    },
    commandPlans: [],
    confirmationGates: [],
    evidence: [],
    nextRecommendedAction: nextRecommendation(context),
  };
}
```

Add `phaseStateForContext` with these rules:

- `plan`: `ready` when there are no issues; `completed` when `issueCount > 0`.
- `setup`: `ready` when `hasConfig` is false; `completed` when `hasConfig` is true.
- `execute`: `ready` when `issueCount > 0`; `blocked` when no issue exists.
- `monitor`: `ready` when `activeIssueCount > 0`; `not_started` otherwise.
- `recovery`: `ready` when `hasRetryableFailures` is true; `not_started` otherwise.
- `report`: `ready` when `issueCount > 0`; `not_started` otherwise.

- [ ] **Step 4: Implement command-plan generation**

In `src/operator-dashboard/wizard.ts`, add:

```ts
export function generateWizardCommandPlan(input: {
  phase: NorthstarWizardPhase;
  configPath: string;
  hostAdapter: HostAdapterName;
  issueId?: string;
  options?: Record<string, unknown>;
}): NorthstarCommandPlan {
  if (input.phase === "plan") return planPhaseCommand(input);
  if (input.phase === "setup") return setupPhaseCommand(input);
  if (input.phase === "execute") return executePhaseCommand(input);
  if (input.phase === "monitor") return monitorPhaseCommand(input);
  if (input.phase === "recovery") return recoveryPhaseCommand(input);
  return reportPhaseCommand(input);
}
```

Use exact command mappings:

```ts
function setupPhaseCommand(input: { configPath: string; hostAdapter: HostAdapterName; options?: Record<string, unknown> }): NorthstarCommandPlan {
  return {
    id: "setup:doctor",
    phase: "setup",
    description: "Run Northstar setup doctor and review config, GitHub label, and Project viewer plans.",
    argv: ["node", "skills/northstar/scripts/doctor.mjs", "--config", input.configPath],
    expectedEffects: [
      "Read local platform, git, GitHub, credential, CLI, and SDK availability.",
      "No config, GitHub label, or GitHub Project mutation occurs without a separate confirmation gate.",
      `Host adapter choices remain codex, opencode, and pi; selected default is ${String(input.options?.selectedHostAdapter ?? input.hostAdapter)}.`,
    ],
    risk: "medium",
    requiresConfirmation: true,
  };
}

function executePhaseCommand(input: { configPath: string; hostAdapter: HostAdapterName; issueId?: string; options?: Record<string, unknown> }): NorthstarCommandPlan {
  const issueNumber = issueNumberFromIssueId(input.issueId);
  if (String(input.options?.mode ?? "single_issue") === "watch") {
    return {
      id: "execute:watch",
      phase: "execute",
      description: "Start Northstar watch mode for ready issues.",
      argv: ["node", "--run", "northstar", "--", "watch", "--config", input.configPath, "--max-cycles", "1", "--log-json"],
      expectedEffects: [`Dispatch ready issues through the configured host adapter ${input.hostAdapter}.`],
      risk: "medium",
      requiresConfirmation: true,
    };
  }
  return {
    id: `execute:start:${issueNumber}`,
    phase: "execute",
    description: `Start Northstar issue #${issueNumber}.`,
    argv: ["node", "--run", "northstar", "--", "start", "--config", input.configPath, "--issue", issueNumber],
    expectedEffects: [`Dispatch one Northstar worker through the configured host adapter ${input.hostAdapter}.`],
    risk: "medium",
    requiresConfirmation: true,
  };
}
```

Also implement:

- `planPhaseCommand`: dry-run issue drafts when `options.mode` is `draft_issues`; high-risk blocked plan for `create_issues`; low-risk empty argv for interactive planning.
- `monitorPhaseCommand`: `["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]`, low risk, no confirmation.
- `recoveryPhaseCommand`: `["node", "--run", "northstar", "--", "repair-runtime", "--config", configPath]`, high risk, confirmation required.
- `reportPhaseCommand`: `["node", "--run", "northstar", "--", "inspect", "--config", configPath, "--summary"]`, low risk, no confirmation.

- [ ] **Step 5: Implement wizard action reducer**

Add:

```ts
export function reduceWizardAction(state: NorthstarWizardState, request: WizardActionRequest): NorthstarWizardState {
  if (request.action === "select_phase" && request.phase) {
    return { ...state, currentPhase: request.phase };
  }
  if (request.action === "generate_command_plan" && request.phase) {
    const context = contextFromState(state);
    const plan = generateWizardCommandPlan({
      phase: request.phase,
      configPath: String(state.selectedOptions.configPath ?? "/repo/.northstar.yaml"),
      hostAdapter: String(state.selectedOptions.hostAdapter ?? "codex") as HostAdapterName,
      issueId: request.issueId,
      options: request.options,
    });
    const gate = confirmationGateForPlan(plan, context.planIssuesCliAvailable);
    return {
      ...state,
      currentPhase: request.phase,
      commandPlans: [plan, ...state.commandPlans.filter((item) => item.id !== plan.id)],
      confirmationGates: gate
        ? [gate, ...state.confirmationGates.filter((item) => item.id !== gate.id)]
        : state.confirmationGates,
      phases: updatePhaseStatus(state.phases, request.phase, gate?.id === "plan:create-issues:blocked" ? "blocked" : plan.requiresConfirmation ? "waiting_for_confirmation" : "ready"),
      nextRecommendedAction: plan.requiresConfirmation ? `Review and approve ${plan.description}` : `Run ${plan.description}`,
    };
  }
  if (request.action === "approve_gate" && request.gateId) {
    return {
      ...state,
      confirmationGates: state.confirmationGates.map((gate) => gate.id === request.gateId ? { ...gate, status: "approved" } : gate),
    };
  }
  if (request.action === "reject_gate" && request.gateId) {
    return {
      ...state,
      confirmationGates: state.confirmationGates.map((gate) => gate.id === request.gateId ? { ...gate, status: "rejected" } : gate),
    };
  }
  return state;
}
```

Implement helper functions in the same file:

- `issueNumberFromIssueId("github:42")` returns `"42"`.
- `issueNumberFromIssueId(undefined)` throws `NORTHSTAR_WIZARD_ISSUE_REQUIRED`.
- `confirmationGateForPlan` creates an open gate for every plan with `requiresConfirmation`.
- `confirmationGateForPlan` uses id `plan:create-issues:blocked` and reason `GitHub issue creation requires confirmation, but production northstar plan-issues CLI is not available in this branch.` when the plan id is `plan:create-issues`.
- `updatePhaseStatus` returns a new phase array without mutating the old one.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/wizard.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/operator-dashboard/wizard.ts tests/operator-dashboard/wizard.test.ts tests/index.test.ts
git commit -m "feat: add northstar guided wizard state"
```

---

### Task 4: Northstar Local API Facade And Allowlisted Actions

**Files:**
- Create: `src/operator-dashboard/local-api.ts`
- Create: `tests/operator-dashboard/local-api.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing local API tests**

Create `tests/operator-dashboard/local-api.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNorthstarLocalApi } from "../../src/operator-dashboard/local-api.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("local API reads project board, issue detail, events, and wizard state", async () => {
  const fixture = await createApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });
    const board = api.getBoard();
    const detail = api.getIssue("github:11");
    const events = api.listIssueEvents("github:11");
    const wizard = api.getWizard();

    assert.equal(board.project.repo, "owner/repo");
    assert.equal(board.groups.find((group) => group.lifecycle === "ready")?.cards.length, 1);
    assert.equal(detail.title, "Dashboard issue");
    assert.equal(events[0].eventType, "runtime_event");
    assert.equal(wizard.currentPhase, "plan");
  } finally {
    await fixture.cleanup();
  }
});

test("local API rejects non-allowlisted operator actions", async () => {
  const fixture = await createApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });
    await assert.rejects(
      async () => await api.runIssueAction({ action: "shell" as never, issueId: "github:11" }),
      /NORTHSTAR_OPERATOR_ACTION_NOT_ALLOWED/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("local API requires confirmation for release actions", async () => {
  const fixture = await createApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });
    await assert.rejects(
      async () => await api.runIssueAction({ action: "release", issueId: "github:11" }),
      /NORTHSTAR_OPERATOR_ACTION_REQUIRES_CONFIRMATION/,
    );
  } finally {
    await fixture.cleanup();
  }
});
```

Add fixture helper in the same test file:

```ts
async function createApiFixture() {
  const dir = await mkdtemp(join(tmpdir(), "northstar-local-api-"));
  const dbPath = join(dir, ".northstar/runtime/control-plane.sqlite3");
  await mkdir(join(dir, ".northstar/runtime"), { recursive: true });
  const configPath = join(dir, ".northstar.yaml");
  await writeFile(configPath, [
    'schema_version: "1"',
    "project:",
    "  name: api-fixture",
    `  root: ${dir}`,
    "runtime:",
    "  db_path: .northstar/runtime/control-plane.sqlite3",
    "  host_adapter: pi",
    "  development_capacity: 1",
    "  release_capacity: 1",
    "  heartbeat_interval_seconds: 30",
    "  lease_timeout_seconds: 300",
    "  child_timeout_seconds: 900",
    "  watch_lock_stale_seconds: 120",
    "  max_recovery_attempts: 2",
    "  auto_release: false",
    "  session_scope: stage_root",
    "workflow:",
    "  package: builtin",
    "  id: issue_to_pr_release",
    '  version: "1"',
    "github:",
    "  repo: owner/repo",
    "  intake:",
    "    enabled: true",
    "    label: northstar:ready",
    "  sync:",
    "    enabled: false",
    "    retry_backoff_seconds:",
    "      - 60",
    "git:",
    "  base_branch: main",
    "  worktrees_dir: .northstar/runtime/worktrees",
    "  sync_worktree_dir: .northstar/runtime/sync-worktrees/main",
    "cleanup:",
    "  completed_worktrees: archive",
    "  keep_last: 5",
    "  failed_or_quarantined: keep",
    "policy:",
    "  github_sync_blocks_lifecycle: false",
    "  quarantine_requires_operator: true",
    "",
  ].join("\n"));

  const store = SqliteControlPlaneStore.open(dbPath);
  const snapshot = newIssueSnapshot("github:11");
  snapshot.runtime_context_json.issue_packet = {
    issue_number: "11",
    title: "Dashboard issue",
    source_url: "https://github.com/owner/repo/issues/11",
    labels: ["northstar:ready"],
    dependencies: [],
  };
  store.createIssue(snapshot);
  store.recordIdempotentHistory("github:11", {
    event_type: "runtime_event",
    payload: { idempotency_key: "event-11", ok: true },
  });
  store.close();

  return {
    configPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
```

Append to `tests/index.test.ts`:

```ts
import "./operator-dashboard/local-api.test.ts";
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/local-api.test.ts
```

Expected: FAIL because `src/operator-dashboard/local-api.ts` does not exist.

- [ ] **Step 3: Implement local API read methods**

Create `src/operator-dashboard/local-api.ts` with:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import { createProductionOrchestratorFromDefaultFactory } from "../orchestrator/production-factory.ts";
import { normalizeRuntimePath } from "../adapters/platform/paths.ts";
import { SqliteControlPlaneStore } from "../runtime/store.ts";
import type { OperatorActionName, OperatorActionRequest, OperatorActionResponse, WizardActionRequest, WizardActionResponse } from "./models.ts";
import { buildNorthstarBoard, buildNorthstarIssueDetail, runEventForHistory } from "./read-model.ts";
import { buildInitialWizardState, reduceWizardAction } from "./wizard.ts";

const allowlistedActions = new Set<OperatorActionName>(["intake", "start", "reconcile", "release", "retry-sync", "inspect"]);
const confirmationRequired = new Set<OperatorActionName>(["release"]);

export function createNorthstarLocalApi(input: { configPath: string; now?: () => string }) {
  const config = loadConfig(input.configPath);
  const now = input.now ?? (() => new Date().toISOString());
  const storePath = runtimeStorePath(config);

  function openStore() {
    return SqliteControlPlaneStore.open(storePath);
  }

  function projectSummary() {
    return {
      projectId: config.project.name,
      name: config.project.name,
      root: config.project.root,
      repo: config.github.repo,
      hostAdapter: config.runtime.hostAdapter,
      configPath: input.configPath,
      runtimeDbPath: storePath,
    };
  }

  return {
    getProject() {
      return projectSummary();
    },
    getBoard() {
      const store = openStore();
      try {
        const issues = store.listIssues();
        return buildNorthstarBoard({
          project: projectSummary(),
          issues,
          historiesByIssueId: store.listHistoriesByIssueId(issues.map((issue) => issue.issue_id)),
          now: now(),
        });
      } finally {
        store.close();
      }
    },
    getIssue(issueId: string) {
      const store = openStore();
      try {
        return buildNorthstarIssueDetail({
          project: projectSummary(),
          snapshot: store.getIssue(issueId),
          history: store.listHistory(issueId),
          now: now(),
        });
      } finally {
        store.close();
      }
    },
    listIssueEvents(issueId: string) {
      const store = openStore();
      try {
        return store.listHistory(issueId).map((entry) => runEventForHistory(entry));
      } finally {
        store.close();
      }
    },
    getWizard() {
      const store = openStore();
      try {
        const issues = store.listIssues();
        const histories = store.listHistoriesByIssueId(issues.map((issue) => issue.issue_id));
        const activeIssueCount = issues.filter((issue) => ["claimed", "running", "verifying", "release_pending"].includes(issue.lifecycle_state)).length;
        const hasRetryableFailures = [...histories.values()].some((history) => history.some((entry) => entry.event_type === "effect_failed_retryable"));
        return buildInitialWizardState({
          projectId: config.project.name,
          configPath: input.configPath,
          hasConfig: existsSync(input.configPath),
          hostAdapter: config.runtime.hostAdapter,
          issueCount: issues.length,
          activeIssueCount,
          hasRetryableFailures,
          planIssuesCliAvailable: false,
        });
      } finally {
        store.close();
      }
    },
    runWizardAction(request: WizardActionRequest): WizardActionResponse {
      const state = this.getWizard();
      return { state: reduceWizardAction(state, request) };
    },
    runIssueAction(request: OperatorActionRequest): Promise<OperatorActionResponse> | OperatorActionResponse {
      return runIssueActionFromConfig({ config, request, configPath: input.configPath, now });
    },
  };
}
```

Add `runtimeStorePath(config)`:

```ts
function runtimeStorePath(config: RuntimeConfig): string {
  return normalizeRuntimePath(config.project.root, config.runtime.dbPath);
}
```

- [ ] **Step 4: Implement allowlisted action execution**

In `src/operator-dashboard/local-api.ts`, add:

```ts
async function runIssueActionFromConfig(input: {
  config: RuntimeConfig;
  configPath: string;
  request: OperatorActionRequest;
  now: () => string;
}): Promise<OperatorActionResponse> {
  if (!allowlistedActions.has(input.request.action)) {
    throw new Error("NORTHSTAR_OPERATOR_ACTION_NOT_ALLOWED");
  }
  if (confirmationRequired.has(input.request.action) && input.request.confirmed !== true) {
    throw new Error("NORTHSTAR_OPERATOR_ACTION_REQUIRES_CONFIRMATION");
  }

  const built = await createProductionOrchestratorFromDefaultFactory({
    config: input.config,
    usage: "cli",
    now: input.now,
  });
  const orchestrator = built.orchestrator;

  if (input.request.action === "start") {
    const result = await orchestrator.startIssue({ issueId: input.request.issueId });
    return { action: "start", result, nextRecommendedAction: "reconcile" };
  }
  if (input.request.action === "reconcile") {
    const result = await orchestrator.reconcileIssue({ issueId: input.request.issueId });
    return { action: "reconcile", result, nextRecommendedAction: "inspect" };
  }
  if (input.request.action === "release") {
    const result = await orchestrator.releaseIssue({ issueId: input.request.issueId, autoRelease: input.config.runtime.autoRelease });
    return { action: "release", result, nextRecommendedAction: "inspect" };
  }
  if (input.request.action === "retry-sync") {
    const result = await orchestrator.retrySyncIssue({ issueId: input.request.issueId });
    return { action: "retry-sync", result, nextRecommendedAction: "inspect" };
  }
  if (input.request.action === "inspect") {
    const result = orchestrator.inspectIssue({ issueId: input.request.issueId });
    return { action: "inspect", result, nextRecommendedAction: "none" };
  }
  throw new Error("NORTHSTAR_OPERATOR_INTAKE_REQUIRES_GITHUB_ISSUE_PAYLOAD");
}
```

`intake` stays allowlisted but requires a GitHub issue payload path in a later task. The API must reject bare `intake` instead of guessing issue content.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/operator-dashboard/local-api.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/operator-dashboard/local-api.ts tests/operator-dashboard/local-api.test.ts tests/index.test.ts
git commit -m "feat: add northstar local operator api"
```

---

### Task 5: pi-web Northstar Server Routes

**Files:**
- Create: `/home/timmypai/apps/pi-web/lib/northstar/types.ts`
- Create: `/home/timmypai/apps/pi-web/lib/northstar/server-client.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/route.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/route.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/route.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/events/route.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/actions/route.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/wizard/route.ts`
- Create: `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/wizard/actions/route.ts`

- [ ] **Step 1: Add pi-web Northstar JSON types**

Create `/home/timmypai/apps/pi-web/lib/northstar/types.ts`:

```ts
export type NorthstarWizardPhase = "plan" | "setup" | "execute" | "monitor" | "recovery" | "report";
export type NorthstarHostAdapter = "codex" | "opencode" | "pi";
export type NorthstarLifecycle =
  | "ready"
  | "claimed"
  | "running"
  | "verifying"
  | "verified"
  | "release_pending"
  | "completed"
  | "cancelled"
  | "failed"
  | "quarantined";

export interface NorthstarProjectSummary {
  projectId: string;
  name: string;
  root: string;
  repo: string;
  hostAdapter: NorthstarHostAdapter;
  configPath: string;
  runtimeDbPath: string;
}

export interface NorthstarBoardCard {
  issueId: string;
  issueNumber: string | null;
  title: string;
  lifecycle: NorthstarLifecycle;
  currentStage: string | null;
  latestHostAdapter: NorthstarHostAdapter | null;
  dependencyCount: number;
  blocked: boolean;
  prUrl: string | null;
  mergeSha: string | null;
  latestRootSessionId: string | null;
  latestChildRunId: string | null;
  lastHeartbeatAt: string | null;
  nextRecommendedAction: string;
  projectionFailure: boolean;
}

export interface NorthstarBoardGroup {
  lifecycle: NorthstarLifecycle;
  cards: NorthstarBoardCard[];
}

export interface NorthstarBoard {
  project: NorthstarProjectSummary;
  groups: NorthstarBoardGroup[];
}

export interface NorthstarRunEvent {
  id: string;
  sequence: number;
  eventType: string;
  severity: "info" | "warning" | "error";
  createdAt: string | null;
  summary: string;
  payloadPreview: unknown;
}

export interface NorthstarSessionLink {
  host: NorthstarHostAdapter;
  rootSessionId: string;
  childRunId: string;
  sessionId: string;
  href: string | null;
}

export interface NorthstarIssueDetail {
  snapshot: unknown;
  title: string;
  sourceUrl: string | null;
  labels: string[];
  inspect: Record<string, unknown>;
  timeline: NorthstarRunEvent[];
  sessionLinks: NorthstarSessionLink[];
  acceptedArtifacts: Array<{ historyId: number; kind: string; summary: string }>;
}

export interface NorthstarWizardState {
  projectId: string;
  currentPhase: NorthstarWizardPhase;
  phases: Array<{
    phase: NorthstarWizardPhase;
    status: "not_started" | "ready" | "waiting_for_confirmation" | "running" | "completed" | "blocked";
    summary: string;
    requiredInputs: string[];
    completedChecks: string[];
    blockers: string[];
  }>;
  selectedOptions: Record<string, unknown>;
  commandPlans: Array<{
    id: string;
    phase: NorthstarWizardPhase;
    description: string;
    argv: string[];
    expectedEffects: string[];
    risk: "low" | "medium" | "high";
    requiresConfirmation: boolean;
  }>;
  confirmationGates: Array<{
    id: string;
    phase: NorthstarWizardPhase;
    title: string;
    reason: string;
    commandPlanIds: string[];
    status: "open" | "approved" | "rejected";
  }>;
  evidence: Array<{
    phase: NorthstarWizardPhase;
    kind: string;
    summary: string;
    links: Array<{ label: string; url: string }>;
    payloadPreview: unknown;
  }>;
  nextRecommendedAction: string | null;
}
```

- [ ] **Step 2: Add server-only dynamic Northstar loader**

Create `/home/timmypai/apps/pi-web/lib/northstar/server-client.ts`:

```ts
import "server-only";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface NorthstarServerApi {
  getProject(): unknown;
  getBoard(): unknown;
  getIssue(issueId: string): unknown;
  listIssueEvents(issueId: string): unknown;
  getWizard(): unknown;
  runWizardAction(request: unknown): unknown;
  runIssueAction(request: unknown): Promise<unknown> | unknown;
}

export async function loadNorthstarApiForRequest(request: Request): Promise<NorthstarServerApi> {
  const url = new URL(request.url);
  const configPath = url.searchParams.get("config") ?? process.env.NORTHSTAR_CONFIG;
  if (!configPath) throw new Error("NORTHSTAR_CONFIG is required");

  const northstarRoot = process.env.NORTHSTAR_ROOT ?? inferNorthstarRootFromConfig(configPath);
  const modulePath = join(northstarRoot, "src/operator-dashboard/local-api.ts");
  if (!existsSync(modulePath)) throw new Error(`Northstar local API not found at ${modulePath}`);

  const mod = await import(pathToFileURL(modulePath).href);
  return mod.createNorthstarLocalApi({ configPath: resolve(configPath) });
}

function inferNorthstarRootFromConfig(_configPath: string): string {
  return process.env.NORTHSTAR_ROOT ?? "/home/timmypai/.codex/worktrees/0536/northstar";
}
```

The hardcoded fallback is acceptable for the local MVP and must be removed only when packaging pi-web against a published Northstar package.

- [ ] **Step 3: Add route handlers**

Create the route files with the same pattern. Example for `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/wizard/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadNorthstarApiForRequest } from "@/lib/northstar/server-client";

export async function GET(request: Request) {
  try {
    const api = await loadNorthstarApiForRequest(request);
    return NextResponse.json({ wizard: api.getWizard() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/wizard/actions/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadNorthstarApiForRequest } from "@/lib/northstar/server-client";

export async function POST(request: Request) {
  try {
    const api = await loadNorthstarApiForRequest(request);
    const body = await request.json();
    return NextResponse.json(await api.runWizardAction(body));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

Create `/home/timmypai/apps/pi-web/app/api/northstar/projects/[projectId]/issues/[issueId]/actions/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadNorthstarApiForRequest } from "@/lib/northstar/server-client";

export async function POST(request: Request, context: { params: Promise<{ issueId: string }> }) {
  try {
    const api = await loadNorthstarApiForRequest(request);
    const params = await context.params;
    const body = await request.json();
    return NextResponse.json(await api.runIssueAction({ ...body, issueId: decodeURIComponent(params.issueId) }));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

Use the same loader for project, board, issue, and events routes:

- `GET /api/northstar/projects` returns `{ projects: [api.getProject()] }`.
- `GET /api/northstar/projects/[projectId]` returns `{ board: api.getBoard() }`.
- `GET /api/northstar/projects/[projectId]/issues/[issueId]` returns `{ issue: api.getIssue(issueId) }`.
- `GET /api/northstar/projects/[projectId]/issues/[issueId]/events` returns `{ events: api.listIssueEvents(issueId) }`.

- [ ] **Step 4: Typecheck pi-web**

Run:

```bash
cd /home/timmypai/apps/pi-web && node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit in pi-web**

```bash
cd /home/timmypai/apps/pi-web
git add lib/northstar app/api/northstar
git commit -m "feat: add northstar local api routes"
```

---

### Task 6: pi-web Northstar Dashboard Shell And Board

**Files:**
- Create: `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`
- Create: `/home/timmypai/apps/pi-web/components/northstar/NorthstarBoard.tsx`
- Modify: `/home/timmypai/apps/pi-web/components/AppShell.tsx`

- [ ] **Step 1: Create dashboard shell component**

Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { NorthstarBoard as NorthstarBoardModel, NorthstarIssueDetail, NorthstarWizardState } from "@/lib/northstar/types";
import { NorthstarBoard } from "./NorthstarBoard";
import { NorthstarIssueDetail as NorthstarIssueDetailView } from "./NorthstarIssueDetail";
import { NorthstarWizard } from "./NorthstarWizard";
import { NorthstarPiAssistant } from "./NorthstarPiAssistant";

interface Props {
  configPath: string | null;
}

export function NorthstarDashboard({ configPath }: Props) {
  const [board, setBoard] = useState<NorthstarBoardModel | null>(null);
  const [wizard, setWizard] = useState<NorthstarWizardState | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [issue, setIssue] = useState<NorthstarIssueDetail | null>(null);
  const [view, setView] = useState<"board" | "wizard" | "assistant">("board");
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => configPath ? `?config=${encodeURIComponent(configPath)}` : "", [configPath]);

  const refresh = useCallback(async () => {
    if (!configPath) return;
    setError(null);
    const projectsResponse = await fetch(`/api/northstar/projects${query}`);
    const projectsJson = await projectsResponse.json();
    if (!projectsResponse.ok) throw new Error(projectsJson.error ?? "Failed to load Northstar project");
    const projectId = projectsJson.projects[0].projectId;

    const [boardResponse, wizardResponse] = await Promise.all([
      fetch(`/api/northstar/projects/${encodeURIComponent(projectId)}${query}`),
      fetch(`/api/northstar/projects/${encodeURIComponent(projectId)}/wizard${query}`),
    ]);
    const boardJson = await boardResponse.json();
    const wizardJson = await wizardResponse.json();
    if (!boardResponse.ok) throw new Error(boardJson.error ?? "Failed to load Northstar board");
    if (!wizardResponse.ok) throw new Error(wizardJson.error ?? "Failed to load Northstar wizard");
    setBoard(boardJson.board);
    setWizard(wizardJson.wizard);
  }, [configPath, query]);

  useEffect(() => {
    refresh().catch((err) => setError(String(err)));
  }, [refresh]);

  useEffect(() => {
    if (!board || !selectedIssueId) return;
    fetch(`/api/northstar/projects/${encodeURIComponent(board.project.projectId)}/issues/${encodeURIComponent(selectedIssueId)}${query}`)
      .then((response) => response.json().then((json) => ({ response, json })))
      .then(({ response, json }) => {
        if (!response.ok) throw new Error(json.error ?? "Failed to load issue");
        setIssue(json.issue);
      })
      .catch((err) => setError(String(err)));
  }, [board, selectedIssueId, query]);

  if (!configPath) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Select a project with a `.northstar.yaml` file.</div>;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
      <div style={{ height: 36, display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        {(["board", "wizard", "assistant"] as const).map((item) => (
          <button key={item} onClick={() => setView(item)} style={{
            height: 36,
            padding: "0 12px",
            border: "none",
            borderRight: "1px solid var(--border)",
            borderTop: view === item ? "2px solid var(--accent)" : "2px solid transparent",
            background: view === item ? "var(--bg-selected)" : "transparent",
            color: view === item ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
          }}>{item === "board" ? "Board" : item === "wizard" ? "Wizard" : "Pi"}</button>
        ))}
        <button onClick={() => refresh().catch((err) => setError(String(err)))} title="Refresh Northstar state" style={{
          marginLeft: "auto",
          height: 28,
          width: 32,
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
        }}>R</button>
      </div>
      {error && <div style={{ padding: "8px 12px", color: "#ef4444", borderBottom: "1px solid var(--border)", fontSize: 12 }}>{error}</div>}
      <div style={{ flex: 1, overflow: "hidden" }}>
        {view === "board" && board && <NorthstarBoard board={board} selectedIssueId={selectedIssueId} onSelectIssue={setSelectedIssueId} />}
        {view === "wizard" && board && wizard && <NorthstarWizard board={board} wizard={wizard} query={query} onWizardChange={setWizard} onRefresh={refresh} />}
        {view === "assistant" && board && wizard && <NorthstarPiAssistant board={board} wizard={wizard} />}
      </div>
      {issue && view === "board" && <NorthstarIssueDetailView issue={issue} onClose={() => setIssue(null)} />}
    </div>
  );
}
```

- [ ] **Step 2: Create board component**

Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarBoard.tsx`:

```tsx
"use client";

import type { NorthstarBoard as NorthstarBoardModel, NorthstarBoardCard } from "@/lib/northstar/types";

interface Props {
  board: NorthstarBoardModel;
  selectedIssueId: string | null;
  onSelectIssue: (issueId: string) => void;
}

const lifecycleLabels: Record<string, string> = {
  ready: "Ready",
  claimed: "Claimed",
  running: "Running",
  verifying: "Verifying",
  verified: "Verified",
  release_pending: "Release",
  completed: "Done",
  cancelled: "Cancelled",
  failed: "Failed",
  quarantined: "Quarantined",
};

export function NorthstarBoard({ board, selectedIssueId, onSelectIssue }: Props) {
  return (
    <div style={{ height: "100%", display: "grid", gridTemplateRows: "auto 1fr", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>{board.project.name}</strong>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{board.project.repo}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{board.project.hostAdapter}</span>
      </div>
      <div style={{ overflow: "auto", padding: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(220px, 1fr))", gap: 10, minWidth: 940 }}>
          {board.groups.filter((group) => group.cards.length > 0).map((group) => (
            <section key={group.lifecycle} style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", minHeight: 120 }}>
              <header style={{ height: 32, padding: "0 10px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{lifecycleLabels[group.lifecycle] ?? group.lifecycle}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{group.cards.length}</span>
              </header>
              <div style={{ display: "grid", gap: 8, padding: 8 }}>
                {group.cards.map((card) => (
                  <IssueCard key={card.issueId} card={card} selected={selectedIssueId === card.issueId} onSelectIssue={onSelectIssue} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function IssueCard({ card, selected, onSelectIssue }: { card: NorthstarBoardCard; selected: boolean; onSelectIssue: (issueId: string) => void }) {
  return (
    <button onClick={() => onSelectIssue(card.issueId)} style={{
      textAlign: "left",
      width: "100%",
      border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
      borderRadius: 6,
      background: "var(--bg)",
      color: "var(--text)",
      padding: 10,
      cursor: "pointer",
      display: "grid",
      gap: 6,
    }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{card.issueNumber ? `#${card.issueNumber}` : card.issueId}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 600 }}>{card.title}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
        {card.currentStage && <span>{card.currentStage}</span>}
        {card.latestHostAdapter && <span>{card.latestHostAdapter}</span>}
        {card.dependencyCount > 0 && <span>{card.dependencyCount} deps</span>}
        {card.projectionFailure && <span style={{ color: "#ef4444" }}>projection</span>}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.nextRecommendedAction}</div>
    </button>
  );
}
```

- [ ] **Step 3: Add Northstar tab in AppShell**

Modify `/home/timmypai/apps/pi-web/components/AppShell.tsx`:

- Import `NorthstarDashboard`.
- Add `const [workspaceView, setWorkspaceView] = useState<"chat" | "northstar">("chat");`.
- Add a `Northstar` button in the top bar next to branch/system controls.
- Render `<NorthstarDashboard configPath={activeCwd ? `${activeCwd}/.northstar.yaml` : null} />` when `workspaceView === "northstar"`.
- Keep chat rendering unchanged when `workspaceView === "chat"`.

Use this button style:

```tsx
<button
  onClick={() => setWorkspaceView((view) => view === "northstar" ? "chat" : "northstar")}
  title="Northstar"
  style={{
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: "100%",
    padding: "0 12px",
    background: workspaceView === "northstar" ? "var(--bg-selected)" : "none",
    border: "none",
    borderTop: workspaceView === "northstar" ? "2px solid var(--accent)" : "2px solid transparent",
    borderRight: "1px solid var(--border)",
    color: workspaceView === "northstar" ? "var(--text)" : "var(--text-muted)",
    cursor: "pointer",
    fontSize: 11,
    whiteSpace: "nowrap",
  }}
>
  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>N</span>
  <span>Northstar</span>
</button>
```

- [ ] **Step 4: Verify pi-web compiles**

Run:

```bash
cd /home/timmypai/apps/pi-web && node_modules/.bin/tsc --noEmit
cd /home/timmypai/apps/pi-web && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit in pi-web**

```bash
cd /home/timmypai/apps/pi-web
git add components/AppShell.tsx components/northstar/NorthstarDashboard.tsx components/northstar/NorthstarBoard.tsx
git commit -m "feat: add northstar dashboard board"
```

---

### Task 7: pi-web Issue Detail, Timeline, And Actions

**Files:**
- Create: `/home/timmypai/apps/pi-web/components/northstar/NorthstarIssueDetail.tsx`
- Create: `/home/timmypai/apps/pi-web/components/northstar/NorthstarTimeline.tsx`
- Modify: `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`

- [ ] **Step 1: Create timeline component**

Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarTimeline.tsx`:

```tsx
"use client";

import type { NorthstarRunEvent } from "@/lib/northstar/types";

export function NorthstarTimeline({ events }: { events: NorthstarRunEvent[] }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {events.map((event) => (
        <div key={event.id} style={{
          display: "grid",
          gridTemplateColumns: "72px 1fr",
          gap: 8,
          padding: "8px 0",
          borderBottom: "1px solid var(--border)",
        }}>
          <div style={{ fontSize: 11, color: severityColor(event.severity), fontVariantNumeric: "tabular-nums" }}>{event.sequence}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{event.eventType}</span>
              {event.createdAt && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{new Date(event.createdAt).toLocaleString()}</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{event.summary}</div>
            <pre style={{
              margin: "6px 0 0",
              padding: 8,
              border: "1px solid var(--border)",
              borderRadius: 4,
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 11,
              overflow: "auto",
              maxHeight: 140,
            }}>{JSON.stringify(event.payloadPreview, null, 2)}</pre>
          </div>
        </div>
      ))}
    </div>
  );
}

function severityColor(severity: NorthstarRunEvent["severity"]) {
  if (severity === "error") return "#ef4444";
  if (severity === "warning") return "rgba(234,179,8,0.95)";
  return "var(--text-dim)";
}
```

- [ ] **Step 2: Create issue detail drawer**

Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarIssueDetail.tsx`:

```tsx
"use client";

import type { NorthstarIssueDetail as NorthstarIssueDetailModel } from "@/lib/northstar/types";
import { NorthstarTimeline } from "./NorthstarTimeline";

interface Props {
  issue: NorthstarIssueDetailModel;
  onClose: () => void;
}

export function NorthstarIssueDetail({ issue, onClose }: Props) {
  return (
    <aside style={{
      position: "absolute",
      top: 36,
      right: 0,
      bottom: 0,
      width: "min(560px, 100vw)",
      background: "var(--bg)",
      borderLeft: "1px solid var(--border)",
      boxShadow: "0 0 24px rgba(0,0,0,0.18)",
      zIndex: 180,
      display: "flex",
      flexDirection: "column",
    }}>
      <header style={{ minHeight: 44, padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", borderBottom: "1px solid var(--border)" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{issue.title}</div>
          {issue.sourceUrl && <a href={issue.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--accent)" }}>{issue.sourceUrl}</a>}
        </div>
        <button onClick={onClose} title="Close" style={{ width: 28, height: 28, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}>x</button>
      </header>
      <div style={{ flex: 1, overflow: "auto", padding: 12, display: "grid", gap: 14 }}>
        <section>
          <h2 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--text-muted)" }}>Sessions</h2>
          <div style={{ display: "grid", gap: 6 }}>
            {issue.sessionLinks.length === 0 && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>No session links</span>}
            {issue.sessionLinks.map((link) => link.href ? (
              <a key={link.childRunId} href={link.href} style={{ fontSize: 12, color: "var(--accent)" }}>{link.host} {link.sessionId}</a>
            ) : (
              <span key={link.childRunId} style={{ fontSize: 12, color: "var(--text-muted)" }}>{link.host} {link.sessionId}</span>
            ))}
          </div>
        </section>
        <section>
          <h2 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--text-muted)" }}>Inspect</h2>
          <pre style={{ margin: 0, padding: 10, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 11, overflow: "auto" }}>{JSON.stringify(issue.inspect, null, 2)}</pre>
        </section>
        <section>
          <h2 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--text-muted)" }}>Timeline</h2>
          <NorthstarTimeline events={issue.timeline} />
        </section>
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Add action buttons in dashboard**

In `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`, add an `runIssueAction` callback:

```tsx
const runIssueAction = useCallback(async (issueId: string, action: "start" | "reconcile" | "release" | "retry-sync" | "inspect") => {
  if (!board) return;
  const confirmed = action === "release" ? window.confirm("Release this Northstar issue?") : true;
  if (!confirmed) return;
  const response = await fetch(`/api/northstar/projects/${encodeURIComponent(board.project.projectId)}/issues/${encodeURIComponent(issueId)}/actions${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, confirmed }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? `Failed to run ${action}`);
  await refresh();
}, [board, query, refresh]);
```

Pass it into `NorthstarBoard` and add compact icon-like text buttons on each card for the card `nextRecommendedAction`. Keep buttons 28px high and fixed width 72px so cards do not resize on hover.

- [ ] **Step 4: Verify pi-web compiles**

Run:

```bash
cd /home/timmypai/apps/pi-web && node_modules/.bin/tsc --noEmit
cd /home/timmypai/apps/pi-web && npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit in pi-web**

```bash
cd /home/timmypai/apps/pi-web
git add components/northstar/NorthstarIssueDetail.tsx components/northstar/NorthstarTimeline.tsx components/northstar/NorthstarDashboard.tsx components/northstar/NorthstarBoard.tsx
git commit -m "feat: add northstar issue detail actions"
```

---

### Task 8: pi-web Guided Wizard UI

**Files:**
- Create: `/home/timmypai/apps/pi-web/components/northstar/NorthstarWizard.tsx`
- Modify: `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`

- [ ] **Step 1: Create wizard component**

Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarWizard.tsx`:

```tsx
"use client";

import type { CSSProperties } from "react";
import type { NorthstarBoard, NorthstarWizardPhase, NorthstarWizardState } from "@/lib/northstar/types";

interface Props {
  board: NorthstarBoard;
  wizard: NorthstarWizardState;
  query: string;
  onWizardChange: (state: NorthstarWizardState) => void;
  onRefresh: () => Promise<void>;
}

export function NorthstarWizard({ board, wizard, query, onWizardChange, onRefresh }: Props) {
  async function send(action: Record<string, unknown>) {
    const response = await fetch(`/api/northstar/projects/${encodeURIComponent(board.project.projectId)}/wizard/actions${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? "Wizard action failed");
    onWizardChange(json.state);
  }

  async function runApprovedPlan(planId: string) {
    const plan = wizard.commandPlans.find((item) => item.id === planId);
    if (!plan) throw new Error("Command plan not found");
    const gate = wizard.confirmationGates.find((item) => item.commandPlanIds.includes(plan.id));
    if (plan.requiresConfirmation && gate?.status !== "approved") throw new Error("Approve the confirmation gate before running this plan");
    if (plan.phase === "monitor" || plan.phase === "report") {
      await onRefresh();
      return;
    }
    if (plan.phase !== "execute") throw new Error("This wizard phase does not have an executable dashboard action in the MVP");
    const issueArgIndex = plan.argv.indexOf("--issue");
    const issueNumber = issueArgIndex >= 0 ? plan.argv[issueArgIndex + 1] : "";
    if (!issueNumber) throw new Error("Execute plan does not include an issue selector");
    const response = await fetch(`/api/northstar/projects/${encodeURIComponent(board.project.projectId)}/issues/${encodeURIComponent(`github:${issueNumber}`)}/actions${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "start", confirmed: true }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? "Failed to run approved wizard command");
    await onRefresh();
  }

  const phase = wizard.phases.find((item) => item.phase === wizard.currentPhase) ?? wizard.phases[0];
  const plans = wizard.commandPlans.filter((plan) => plan.phase === wizard.currentPhase);
  const gates = wizard.confirmationGates.filter((gate) => gate.phase === wizard.currentPhase);

  return (
    <div style={{ height: "100%", display: "grid", gridTemplateColumns: "220px 1fr", overflow: "hidden" }}>
      <nav style={{ borderRight: "1px solid var(--border)", background: "var(--bg-panel)", overflow: "auto", padding: 8 }}>
        {wizard.phases.map((item) => (
          <button key={item.phase} onClick={() => send({ action: "select_phase", phase: item.phase })} style={{
            width: "100%",
            height: 42,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0 10px",
            border: "none",
            borderRadius: 4,
            background: wizard.currentPhase === item.phase ? "var(--bg-selected)" : "transparent",
            color: wizard.currentPhase === item.phase ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
          }}>
            <span>{phaseLabel(item.phase)}</span>
            <span style={{ color: statusColor(item.status), fontSize: 11 }}>{item.status}</span>
          </button>
        ))}
      </nav>
      <main style={{ overflow: "auto", padding: 14, display: "grid", gap: 14, alignContent: "start" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 16 }}>{phaseLabel(wizard.currentPhase)}</h1>
          <span style={{ fontSize: 12, color: statusColor(phase.status) }}>{phase.status}</span>
        </header>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>{phase.summary}</p>
        {wizard.nextRecommendedAction && <div style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", fontSize: 12 }}>{wizard.nextRecommendedAction}</div>}
        <section style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button onClick={() => send({ action: "generate_command_plan", phase: wizard.currentPhase, options: defaultOptions(wizard.currentPhase, board) })} style={buttonStyle("primary")}>Plan Command</button>
          <button onClick={onRefresh} style={buttonStyle("secondary")}>Refresh</button>
        </section>
        <section style={{ display: "grid", gap: 8 }}>
          {plans.map((plan) => (
            <div key={plan.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, display: "grid", gap: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{plan.description}</strong>
                <span style={{ fontSize: 11, color: riskColor(plan.risk) }}>{plan.risk}</span>
              </div>
              <pre style={{ margin: 0, padding: 8, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", overflow: "auto", fontSize: 11 }}>{JSON.stringify(plan.argv)}</pre>
              <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-muted)", fontSize: 12 }}>
                {plan.expectedEffects.map((effect) => <li key={effect}>{effect}</li>)}
              </ul>
              <div>
                <button onClick={() => runApprovedPlan(plan.id)} style={buttonStyle("secondary")}>Run Approved</button>
              </div>
            </div>
          ))}
        </section>
        <section style={{ display: "grid", gap: 8 }}>
          {gates.map((gate) => (
            <div key={gate.id} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, background: "var(--bg-panel)", display: "grid", gap: 8 }}>
              <strong style={{ fontSize: 13 }}>{gate.title}</strong>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{gate.reason}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => send({ action: "approve_gate", gateId: gate.id })} style={buttonStyle("primary")}>Approve</button>
                <button onClick={() => send({ action: "reject_gate", gateId: gate.id })} style={buttonStyle("secondary")}>Reject</button>
                <span style={{ alignSelf: "center", fontSize: 11, color: "var(--text-dim)" }}>{gate.status}</span>
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
```

Add helpers in the same file:

```tsx
function phaseLabel(phase: NorthstarWizardPhase) {
  return phase === "plan" ? "Plan" : phase === "setup" ? "Setup" : phase === "execute" ? "Execute" : phase === "monitor" ? "Monitor" : phase === "recovery" ? "Recovery" : "Report";
}

function defaultOptions(phase: NorthstarWizardPhase, board: NorthstarBoard) {
  if (phase === "execute") {
    const firstReady = board.groups.flatMap((group) => group.cards).find((card) => card.lifecycle === "ready");
    return { mode: "single_issue", issueId: firstReady?.issueId };
  }
  if (phase === "plan") return { mode: "interactive" };
  return {};
}

function statusColor(status: string) {
  if (status === "blocked") return "#ef4444";
  if (status === "waiting_for_confirmation") return "rgba(234,179,8,0.95)";
  if (status === "completed") return "#22c55e";
  return "var(--text-muted)";
}

function riskColor(risk: string) {
  if (risk === "high") return "#ef4444";
  if (risk === "medium") return "rgba(234,179,8,0.95)";
  return "var(--text-muted)";
}

function buttonStyle(kind: "primary" | "secondary"): CSSProperties {
  return {
    height: 30,
    padding: "0 10px",
    border: "1px solid var(--border)",
    borderRadius: 4,
    background: kind === "primary" ? "var(--accent)" : "var(--bg)",
    color: kind === "primary" ? "#fff" : "var(--text)",
    cursor: "pointer",
    fontSize: 12,
  };
}
```

- [ ] **Step 2: Fix execute default issue id pass-through**

In `NorthstarWizard`, when calling `send` for `generate_command_plan`, include `issueId` from default options:

```tsx
const options = defaultOptions(wizard.currentPhase, board);
send({ action: "generate_command_plan", phase: wizard.currentPhase, issueId: options.issueId, options });
```

- [ ] **Step 3: Verify pi-web compiles**

Run:

```bash
cd /home/timmypai/apps/pi-web && node_modules/.bin/tsc --noEmit
cd /home/timmypai/apps/pi-web && npm run lint
```

Expected: PASS.

- [ ] **Step 4: Browser verification**

Run:

```bash
cd /home/timmypai/apps/pi-web && npm run dev
```

Open `http://localhost:3030`, select a project with `.northstar.yaml`, click `Northstar`, and verify:

- Board tab loads.
- Wizard tab shows Plan, Setup, Execute, Monitor, Recovery, Report.
- Plan Command creates a visible command plan.
- Execute command plan shows `start --issue` when a ready issue exists.
- Creating issues from plan is visibly blocked when production `plan-issues` CLI is unavailable.

- [ ] **Step 5: Commit in pi-web**

```bash
cd /home/timmypai/apps/pi-web
git add components/northstar/NorthstarWizard.tsx components/northstar/NorthstarDashboard.tsx
git commit -m "feat: add northstar guided wizard ui"
```

---

### Task 9: Pi Operator Assistant Read-Only Guidance

**Files:**
- Create: `/home/timmypai/apps/pi-web/components/northstar/NorthstarPiAssistant.tsx`
- Modify: `/home/timmypai/apps/pi-web/components/northstar/NorthstarDashboard.tsx`

- [ ] **Step 1: Create Pi assistant summary component**

Create `/home/timmypai/apps/pi-web/components/northstar/NorthstarPiAssistant.tsx`:

```tsx
"use client";

import type { NorthstarBoard, NorthstarWizardState } from "@/lib/northstar/types";

interface Props {
  board: NorthstarBoard;
  wizard: NorthstarWizardState;
}

export function NorthstarPiAssistant({ board, wizard }: Props) {
  const activeCount = board.groups.flatMap((group) => group.cards).filter((card) => ["claimed", "running", "verifying", "release_pending"].includes(card.lifecycle)).length;
  const blockedCount = board.groups.flatMap((group) => group.cards).filter((card) => card.blocked || card.projectionFailure).length;
  const prompt = [
    "You are guiding a Northstar operator. Explain state and recommend next steps only.",
    "Do not run shell commands. Do not mutate GitHub. Do not advance wizard gates.",
    `Project: ${board.project.name}`,
    `Repo: ${board.project.repo}`,
    `Default host adapter: ${board.project.hostAdapter}`,
    `Current wizard phase: ${wizard.currentPhase}`,
    `Next recommended action: ${wizard.nextRecommendedAction ?? "none"}`,
    `Active issue count: ${activeCount}`,
    `Blocked or projection-failed cards: ${blockedCount}`,
  ].join("\n");

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 14, display: "grid", gap: 12, alignContent: "start" }}>
      <h1 style={{ margin: 0, fontSize: 16 }}>Pi Operator</h1>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>
        Use this context in a Pi session to explain Northstar state and recommend the next allowed action.
      </p>
      <pre style={{
        margin: 0,
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        fontSize: 12,
        overflow: "auto",
        whiteSpace: "pre-wrap",
      }}>{prompt}</pre>
    </div>
  );
}
```

- [ ] **Step 2: Confirm no mutations are available from Pi assistant**

Review `/home/timmypai/apps/pi-web/components/northstar/NorthstarPiAssistant.tsx` and confirm it has:

- no `fetch` calls
- no action buttons
- no direct calls to `/wizard/actions`
- no issue action route calls

- [ ] **Step 3: Verify pi-web compiles**

Run:

```bash
cd /home/timmypai/apps/pi-web && node_modules/.bin/tsc --noEmit
cd /home/timmypai/apps/pi-web && npm run lint
```

Expected: PASS.

- [ ] **Step 4: Commit in pi-web**

```bash
cd /home/timmypai/apps/pi-web
git add components/northstar/NorthstarPiAssistant.tsx components/northstar/NorthstarDashboard.tsx
git commit -m "feat: add northstar pi operator guidance"
```

---

### Task 10: End-To-End Verification And Documentation

**Files:**
- Create: `docs/superpowers/operator-dashboard-wizard-coverage.md`
- Modify: `docs/superpowers/specs/2026-06-02-northstar-operator-dashboard-design.md` only if implementation discovers a design correction.

- [ ] **Step 1: Run Northstar verification**

Run:

```bash
cd /home/timmypai/.codex/worktrees/0536/northstar
npm test
```

Expected: PASS.

- [ ] **Step 2: Run pi-web verification**

Run:

```bash
cd /home/timmypai/apps/pi-web
node_modules/.bin/tsc --noEmit
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Run local browser verification**

Run:

```bash
cd /home/timmypai/apps/pi-web
NORTHSTAR_ROOT=/home/timmypai/.codex/worktrees/0536/northstar npm run dev
```

Open `http://localhost:3030` and verify:

- Northstar tab appears after a project directory is selected.
- Board groups runtime issues by lifecycle.
- Issue detail drawer shows inspect JSON, timeline, and Pi session links when present.
- Wizard shows six phases and does not lose state when switching to board and back.
- Wizard command plans show argv arrays and expected effects before any mutation.
- Release and recovery actions require confirmation.
- Pi assistant view only shows context and does not expose mutation controls.

- [ ] **Step 4: Create coverage document**

Create `docs/superpowers/operator-dashboard-wizard-coverage.md`:

```md
# Northstar Operator Dashboard Wizard Coverage

| Requirement | Evidence | Notes |
| --- | --- | --- |
| Board groups issues by lifecycle | `tests/operator-dashboard/read-model.test.ts` | Uses Northstar runtime snapshots, not GitHub Project state |
| Issue detail shows timeline and session links | `tests/operator-dashboard/read-model.test.ts` | Pi links use `/?session=`; Codex/OpenCode links are local runtime metadata |
| Local API is allowlisted | `tests/operator-dashboard/local-api.test.ts` | Rejects unknown actions |
| Release requires confirmation | `tests/operator-dashboard/local-api.test.ts` | Recovery confirmation covered by wizard command-plan risk gates |
| Wizard phases exist | `tests/operator-dashboard/wizard.test.ts` | `plan`, `setup`, `execute`, `monitor`, `recovery`, `report` |
| Wizard preserves host adapter parity | `tests/operator-dashboard/wizard.test.ts` | Codex, OpenCode, and Pi remain listed as choices |
| GitHub issue creation does not run without production CLI | `tests/operator-dashboard/wizard.test.ts` | Shows blocked gate until `northstar plan-issues` is restored |
| pi-web routes load local API | `node_modules/.bin/tsc --noEmit` in pi-web | Dynamic local import is server-only |
| pi-web UI renders dashboard and wizard | Browser verification | Manual local browser check |
| Pi assistant is read-only | Source review of `NorthstarPiAssistant.tsx` | No fetch or mutation controls |
```

- [ ] **Step 5: Commit Northstar docs**

```bash
cd /home/timmypai/.codex/worktrees/0536/northstar
git add docs/superpowers/operator-dashboard-wizard-coverage.md
git commit -m "docs: add operator dashboard wizard coverage"
```

- [ ] **Step 6: Report remaining known limitation**

In the final implementation report, state:

```text
The dashboard/wizard MVP can guide planning and produce dry-run/blocked command plans, but actual spec-to-GitHub issue creation remains blocked until the production northstar plan-issues CLI is restored or implemented.
```

---

## Execution Order

1. Implement Tasks 1-4 in the Northstar worktree.
2. Run `npm test` in Northstar.
3. Implement Tasks 5-9 in `/home/timmypai/apps/pi-web`.
4. Run pi-web TypeScript and lint checks.
5. Run browser verification.
6. Add coverage documentation.
7. Commit Northstar and pi-web changes separately.

## Self-Review Checklist

- The plan covers board, issue detail, timeline, session links, operator actions, guided wizard, Pi guidance, and coverage docs.
- The plan preserves Pi/Codex/OpenCode parity by keeping host adapter selection in config and wizard state.
- The plan does not introduce arbitrary shell execution.
- The plan keeps MCP as a future capability field and does not configure MCP servers.
- The plan calls out the current production `plan-issues` gap and makes GitHub issue creation blocked until that gap is resolved.
- All mutation paths use allowlisted API actions or explicit confirmation gates.

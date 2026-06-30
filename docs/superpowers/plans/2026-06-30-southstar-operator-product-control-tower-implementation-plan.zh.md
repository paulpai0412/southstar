# Southstar Operator Product Control Tower Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current Southstar web Operator MVP into a product-grade incident control tower with grouped incidents, answer-first task summaries, safe recovery actions, workflow launch handoff, and reliable responsive navigation.

**Architecture:** Keep the active UI in `/home/timmypai/apps/southstar/web` and follow existing Chat/Workflow visual patterns. Add a small web-local derived incident layer under `web/lib/operator/`, then compose it through focused Operator components instead of adding more raw tabs. Keep runtime truth in existing read models and use frontend derivation only for presentation grouping, labels, and prioritization.

**Tech Stack:** Next.js 16 app router, React 19, TypeScript, existing CSS tokens in `web/app/globals.css`, React Flow via existing `SouthstarWorkflowCanvas`, native `node:test`, Playwright smoke via system Chrome.

---

## Source Design

Spec:

`/home/timmypai/apps/southstar/docs/superpowers/specs/2026-06-30-southstar-operator-product-control-tower-design.zh.md`

Audit evidence:

`/home/timmypai/apps/southstar/docs/superpowers/audits/2026-06-30-product-ui-review/`

Active app:

`/home/timmypai/apps/southstar/web`

Do not import retired root-level UI folders into `web/`.

## File Structure

Create:

- `web/lib/operator/incidents.ts`  
  Builds grouped operator incidents, priority lanes, age labels, and summary copy from `OperatorOverview`.

- `web/components/operator/OperatorHealthStrip.tsx`  
  Shows runs, blocked incidents, at-risk count, last refresh, and stale/error state.

- `web/components/operator/OperatorAttentionQueue.tsx`  
  Replaces the repeated raw attention list with grouped incidents.

- `web/components/operator/OperatorIncidentPanel.tsx`  
  Center answer-first incident card for selected incident.

- `web/components/operator/OperatorTaskSummary.tsx`  
  Sidecar summary panel shown above debug tabs.

- `web/components/workflow/WorkflowNodeProfileSummary.tsx`  
  Product-readable summary, effective profile, override diff, and validation impact for selected workflow node.

- `web/components/workflow/WorkflowNodeProfileRecommendations.tsx`  
  Candidate profile/skill/MCP recommendation list with plain reasons.

- `web/components/workflow/WorkflowLaunchPreview.tsx`  
  Productized template preview and launch checklist for the Workflow tab.

- `tests/web/southstar-operator-product-control-tower.test.tsx`  
  Static/helper coverage for product-level Operator behavior.

- `tests/web/southstar-product-responsive.test.tsx`  
  Static and Playwright-script coverage for sidecar/mobile blockers.

Modify:

- `web/lib/operator/types.ts`  
  Add presentation types for incidents and priority lanes.

- `web/components/operator/OperatorSidebar.tsx`  
  Use `OperatorAttentionQueue`, show scope/filter health, keep Project Scope above Operator Focus.

- `web/components/operator/OperatorWorkspace.tsx`  
  Add health strip, priority lanes, selected incident panel, and keep workflow progress/DAG below.

- `web/components/operator/OperatorStateBoard.tsx`  
  Keep lifecycle board but make it secondary to priority scan.

- `web/components/operator/OperatorTaskTabs.tsx`  
  Add summary-first experience and ensure summary remains visible before raw debug panels.

- `web/components/operator/OperatorActionsPanel.tsx`  
  Add consequence preview, required reason input, and command result feedback.

- `web/components/WorkflowNodeProfileEditor.tsx`  
  Reframe from raw form into summary-first task profile workspace.

- `web/components/SidecarShell.tsx`  
  Fix tab header click interception and mobile full-screen sheet behavior.

- `web/components/AppShell.tsx`  
  Pass selected incident, last refresh/error, responsive sidecar mode, and workflow launch handoff.

- `web/components/WorkflowSidebar.tsx`  
  Ensure selected workflow template updates the center launch preview.

- `web/app/globals.css`  
  Add product-control-tower classes using existing tokens.

## Task 1: Derived Incident Model

**Files:**

- Create: `web/lib/operator/incidents.ts`
- Modify: `web/lib/operator/types.ts`
- Test: `tests/web/southstar-operator-product-control-tower.test.tsx`

- [ ] **Step 1: Write failing helper tests**

Add this test file:

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("operator incident helpers group duplicate attention by run task and cause", async () => {
  const { buildOperatorIncidents } = await import("../../web/lib/operator/incidents.ts");
  const overview = {
    runs: [
      { runId: "run-1", status: "scheduling", title: "Fix empty input", updatedAt: "2026-06-30T12:00:00.000Z" },
    ],
    attentionItems: [
      {
        id: "a",
        severity: "blocked",
        title: "stale_callback runtime exception",
        reason: "stale_callback",
        runId: "run-1",
        taskId: "task.implement",
        updatedAt: "2026-06-30T12:01:00.000Z",
        commands: [{ id: "task.retry", label: "Retry Task", enabled: true, requiresConfirmation: true }],
        detail: { evidenceRefs: ["history:1"] },
      },
      {
        id: "b",
        severity: "blocked",
        title: "stale_callback runtime exception",
        reason: "stale_callback",
        runId: "run-1",
        taskId: "task.implement",
        updatedAt: "2026-06-30T12:02:00.000Z",
        commands: [{ id: "task.retry", label: "Retry Task", enabled: true, requiresConfirmation: true }],
        detail: { evidenceRefs: ["history:2"] },
      },
    ],
    commandResults: [],
    runtimeHealth: { activeRunCount: 1, attentionCount: 2, blockedCount: 2 },
    defaultSelection: { runId: "run-1", taskId: "task.implement", attentionItemId: "a" },
  };

  const incidents = buildOperatorIncidents(overview);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].runId, "run-1");
  assert.equal(incidents[0].taskId, "task.implement");
  assert.equal(incidents[0].severity, "blocked");
  assert.equal(incidents[0].status, "needs_action");
  assert.match(incidents[0].cause, /stale_callback/);
  assert.match(incidents[0].nextAction, /Retry Task/);
  assert.deepEqual(incidents[0].sourceAttentionIds, ["a", "b"]);
});

test("operator priority lanes separate needs action from running", async () => {
  const { buildOperatorIncidents, buildOperatorPriorityLanes } = await import("../../web/lib/operator/incidents.ts");
  const overview = {
    runs: [
      { runId: "run-1", status: "scheduling", title: "Blocked run", updatedAt: "2026-06-30T12:00:00.000Z" },
      { runId: "run-2", status: "running", title: "Healthy run", updatedAt: "2026-06-30T12:00:00.000Z" },
    ],
    attentionItems: [
      { id: "a", severity: "blocked", title: "Blocked", reason: "stale_callback", runId: "run-1", taskId: "task.implement" },
    ],
    commandResults: [],
    runtimeHealth: { activeRunCount: 2, attentionCount: 1, blockedCount: 1 },
    defaultSelection: null,
  };

  const incidents = buildOperatorIncidents(overview);
  const lanes = buildOperatorPriorityLanes(overview.runs, incidents);
  assert.equal(lanes.needsAction.length, 1);
  assert.equal(lanes.running.length, 1);
  assert.equal(lanes.running[0].runId, "run-2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: fail because `web/lib/operator/incidents.ts` does not exist.

- [ ] **Step 3: Add presentation types**

Append to `web/lib/operator/types.ts`:

```ts
export type OperatorIncidentStatus = "needs_action" | "observing" | "recovering" | "resolved";

export type OperatorIncident = {
  id: string;
  runId: string;
  taskId: string | null;
  severity: "blocked" | "error" | "warning" | "info";
  status: OperatorIncidentStatus;
  title: string;
  cause: string;
  impact: string;
  nextAction: string;
  ageLabel: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  evidenceRefs: string[];
  commandIds: string[];
  sourceAttentionIds: string[];
};

export type OperatorPriorityLanes = {
  needsAction: OperatorIncident[];
  atRisk: OperatorIncident[];
  running: OperatorRun[];
  recentlyResolved: OperatorIncident[];
};
```

- [ ] **Step 4: Implement incident helpers**

Create `web/lib/operator/incidents.ts`:

```ts
import type { OperatorAttentionItem, OperatorIncident, OperatorOverview, OperatorPriorityLanes, OperatorRun } from "./types";

const severityOrder = new Map([
  ["blocked", 4],
  ["error", 3],
  ["warning", 2],
  ["info", 1],
]);

export function buildOperatorIncidents(overview: OperatorOverview): OperatorIncident[] {
  const runs = new Map(overview.runs.map((run) => [run.runId, run]));
  const groups = new Map<string, OperatorAttentionItem[]>();

  for (const item of overview.attentionItems) {
    const key = [
      item.runId || "global",
      item.taskId || "run",
      item.reason || item.title || item.kind || "attention",
    ].join("::");
    groups.set(key, [...(groups.get(key) || []), item]);
  }

  return [...groups.entries()].map(([key, items]) => {
    const first = items[0]!;
    const run = first.runId ? runs.get(first.runId) : undefined;
    const severity = highestSeverity(items);
    const commandIds = unique(items.flatMap((item) => item.commands?.map((command) => command.id) || []));
    const evidenceRefs = unique(items.flatMap(readEvidenceRefs));
    const nextAction = commandIds.length > 0
      ? `Review and run ${items.flatMap((item) => item.commands || [])[0]?.label || commandIds[0]}`
      : "Open history and review recovery evidence";

    return {
      id: `incident:${key}`,
      runId: first.runId || "",
      taskId: first.taskId || null,
      severity,
      status: severity === "blocked" || severity === "error" ? "needs_action" : "observing",
      title: first.title || `${severity} incident`,
      cause: first.reason || first.kind || first.title || "unknown",
      impact: run ? `${run.title} cannot progress normally while this incident is active.` : "Runtime attention requires review.",
      nextAction,
      ageLabel: formatAge(first.updatedAt || run?.updatedAt),
      firstSeenAt: oldestDate(items.map((item) => item.updatedAt)),
      lastSeenAt: newestDate(items.map((item) => item.updatedAt)),
      evidenceRefs,
      commandIds,
      sourceAttentionIds: items.map((item) => item.id),
    };
  }).sort(compareIncidents);
}

export function buildOperatorPriorityLanes(runs: OperatorRun[], incidents: OperatorIncident[]): OperatorPriorityLanes {
  const incidentRunIds = new Set(incidents.map((incident) => incident.runId));
  return {
    needsAction: incidents.filter((incident) => incident.status === "needs_action"),
    atRisk: incidents.filter((incident) => incident.status === "observing"),
    running: runs.filter((run) => !incidentRunIds.has(run.runId)),
    recentlyResolved: incidents.filter((incident) => incident.status === "resolved"),
  };
}

function highestSeverity(items: OperatorAttentionItem[]): OperatorIncident["severity"] {
  return items.reduce<OperatorIncident["severity"]>((highest, item) => {
    const severity = normalizeSeverity(item.severity);
    return (severityOrder.get(severity) || 0) > (severityOrder.get(highest) || 0) ? severity : highest;
  }, "info");
}

function normalizeSeverity(severity: string): OperatorIncident["severity"] {
  if (severity === "blocked" || severity === "error" || severity === "warning" || severity === "info") return severity;
  return "info";
}

function readEvidenceRefs(item: OperatorAttentionItem): string[] {
  const refs = item.detail?.evidenceRefs;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareIncidents(a: OperatorIncident, b: OperatorIncident): number {
  return (severityOrder.get(b.severity) || 0) - (severityOrder.get(a.severity) || 0);
}

function formatAge(value: string | undefined): string {
  if (!value) return "age unknown";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "age unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function oldestDate(values: Array<string | undefined>): string | null {
  const dates = values.map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  return dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : null;
}

function newestDate(values: Array<string | undefined>): string | null {
  const dates = values.map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  return dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add web/lib/operator/types.ts web/lib/operator/incidents.ts tests/web/southstar-operator-product-control-tower.test.tsx
git commit -m "feat: derive operator incident model"
```

## Task 2: Grouped Operator Focus Sidebar

**Files:**

- Create: `web/components/operator/OperatorAttentionQueue.tsx`
- Modify: `web/components/operator/OperatorSidebar.tsx`
- Test: `tests/web/southstar-operator-product-control-tower.test.tsx`

- [ ] **Step 1: Write failing source guard**

Append:

```ts
test("Operator sidebar uses grouped incident attention queue", () => {
  const sidebar = source("web/components/operator/OperatorSidebar.tsx");
  const queue = source("web/components/operator/OperatorAttentionQueue.tsx");
  assert.match(sidebar, /OperatorAttentionQueue/);
  assert.match(queue, /sourceAttentionIds/);
  assert.match(queue, /nextAction/);
  assert.match(queue, /aria-pressed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/web/southstar-operator-control-tower.test.tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: fail because `OperatorAttentionQueue.tsx` does not exist.

- [ ] **Step 3: Create grouped queue component**

Create `web/components/operator/OperatorAttentionQueue.tsx`:

```tsx
"use client";

import type { OperatorIncident } from "@/lib/operator/types";

export function OperatorAttentionQueue({
  incidents,
  selectedIncidentId,
  onSelectIncident,
}: {
  incidents: OperatorIncident[];
  selectedIncidentId: string | null;
  onSelectIncident: (incident: OperatorIncident) => void;
}) {
  if (incidents.length === 0) {
    return <p className="operator-muted">No incidents need attention.</p>;
  }

  return (
    <div className="operator-attention-queue">
      {incidents.map((incident) => (
        <button
          key={incident.id}
          type="button"
          className="operator-list-row operator-incident-row"
          aria-pressed={selectedIncidentId === incident.id}
          onClick={() => onSelectIncident(incident)}
        >
          <strong>{incident.severity}</strong>
          <span>{incident.title}</span>
          <em>{incident.cause}</em>
          <small>{incident.sourceAttentionIds.length} events · {incident.ageLabel}</small>
          <small>{incident.nextAction}</small>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire sidebar**

Modify `OperatorSidebar` props:

```ts
incidents: OperatorIncident[];
selectedIncidentId: string | null;
onSelectIncident: (incident: OperatorIncident) => void;
```

Replace the raw attention list with:

```tsx
<OperatorAttentionQueue
  incidents={incidents}
  selectedIncidentId={selectedIncidentId}
  onSelectIncident={onSelectIncident}
/>
```

Keep `Running Workflows` below the queue.

- [ ] **Step 5: Add CSS**

Append to `web/app/globals.css`:

```css
.operator-incident-row {
  grid-template-columns: max-content minmax(0, 1fr);
}

.operator-incident-row em,
.operator-incident-row small {
  grid-column: 2;
  color: var(--text-dim);
  font-size: 11px;
  font-style: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 6: Run tests**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add web/components/operator/OperatorAttentionQueue.tsx web/components/operator/OperatorSidebar.tsx web/app/globals.css tests/web/southstar-operator-product-control-tower.test.tsx
git commit -m "feat: group operator attention queue"
```

## Task 3: Health Strip And Priority Lanes

**Files:**

- Create: `web/components/operator/OperatorHealthStrip.tsx`
- Create: `web/components/operator/OperatorIncidentPanel.tsx`
- Modify: `web/components/operator/OperatorWorkspace.tsx`
- Modify: `web/components/operator/OperatorStateBoard.tsx`
- Test: `tests/web/southstar-operator-product-control-tower.test.tsx`

- [ ] **Step 1: Write failing source guard**

Append:

```ts
test("Operator workspace leads with health strip priority lanes and incident summary", () => {
  const workspace = source("web/components/operator/OperatorWorkspace.tsx");
  assert.match(workspace, /OperatorHealthStrip/);
  assert.match(workspace, /OperatorIncidentPanel/);
  assert.match(workspace, /priorityLanes/);
  assert.match(source("web/components/operator/OperatorHealthStrip.tsx"), /blocked incidents/);
  assert.match(source("web/components/operator/OperatorIncidentPanel.tsx"), /Recommended next action/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: fail because the new components do not exist.

- [ ] **Step 3: Create health strip**

Create `OperatorHealthStrip.tsx`:

```tsx
"use client";

import type { OperatorIncident, OperatorOverview } from "@/lib/operator/types";

export function OperatorHealthStrip({
  overview,
  incidents,
  error,
}: {
  overview: OperatorOverview;
  incidents: OperatorIncident[];
  error: string | null;
}) {
  const blocked = incidents.filter((incident) => incident.status === "needs_action").length;
  const atRisk = incidents.filter((incident) => incident.status === "observing").length;

  return (
    <section className="operator-health-strip" aria-label="Operator runtime health">
      <div><strong>{overview.runs.length}</strong><span>active runs</span></div>
      <div><strong>{blocked}</strong><span>blocked incidents</span></div>
      <div><strong>{atRisk}</strong><span>at risk</span></div>
      <div><strong>{overview.runtimeHealth.attentionCount}</strong><span>attention events</span></div>
      {error ? <p className="operator-muted operator-danger">Operator overview error: {error}</p> : null}
    </section>
  );
}
```

- [ ] **Step 4: Create incident panel**

Create `OperatorIncidentPanel.tsx`:

```tsx
"use client";

import type { OperatorIncident } from "@/lib/operator/types";

export function OperatorIncidentPanel({ incident }: { incident: OperatorIncident | null }) {
  if (!incident) {
    return (
      <section className="operator-panel operator-incident-panel">
        <header className="operator-panel-header"><h2>Incident Summary</h2></header>
        <p className="operator-muted">Select an incident to see cause, impact, evidence, and next action.</p>
      </section>
    );
  }

  return (
    <section className="operator-panel operator-incident-panel">
      <header className="operator-panel-header">
        <h2>{incident.title}</h2>
        <strong className="operator-run-severity">{incident.severity}</strong>
      </header>
      <dl className="operator-summary-grid">
        <dt>Cause</dt><dd>{incident.cause}</dd>
        <dt>Impact</dt><dd>{incident.impact}</dd>
        <dt>Recommended next action</dt><dd>{incident.nextAction}</dd>
        <dt>Age</dt><dd>{incident.ageLabel}</dd>
      </dl>
    </section>
  );
}
```

- [ ] **Step 5: Wire workspace**

In `OperatorWorkspace.tsx`, compute:

```ts
const incidents = useMemo(() => buildOperatorIncidents(overview), [overview]);
const priorityLanes = useMemo(() => buildOperatorPriorityLanes(overview.runs, incidents), [overview.runs, incidents]);
const selectedIncident = incidents.find((incident) => incident.id === selectedIncidentId) || incidents[0] || null;
```

Render before `OperatorStateBoard`:

```tsx
<OperatorHealthStrip overview={overview} incidents={incidents} error={error} />
<OperatorIncidentPanel incident={selectedIncident} />
```

Pass `priorityLanes` to a simple lane block:

```tsx
<section className="operator-panel operator-priority-lanes">
  <header className="operator-panel-header"><h2>Priority</h2></header>
  <div className="operator-priority-grid">
    <div><strong>Needs Action</strong><span>{priorityLanes.needsAction.length}</span></div>
    <div><strong>At Risk</strong><span>{priorityLanes.atRisk.length}</span></div>
    <div><strong>Running</strong><span>{priorityLanes.running.length}</span></div>
    <div><strong>Recently Resolved</strong><span>{priorityLanes.recentlyResolved.length}</span></div>
  </div>
</section>
```

- [ ] **Step 6: Add CSS**

```css
.operator-health-strip,
.operator-priority-grid,
.operator-summary-grid {
  display: grid;
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  margin-bottom: 10px;
}

.operator-health-strip {
  grid-template-columns: repeat(4, minmax(120px, 1fr));
}

.operator-health-strip > div,
.operator-priority-grid > div,
.operator-summary-grid > dt,
.operator-summary-grid > dd {
  background: var(--bg);
  padding: 8px 10px;
}

.operator-health-strip strong,
.operator-priority-grid strong {
  display: block;
  color: var(--text);
  font-size: 13px;
}

.operator-health-strip span,
.operator-priority-grid span,
.operator-summary-grid dt {
  color: var(--text-muted);
  font-size: 11px;
}

.operator-summary-grid {
  grid-template-columns: 150px minmax(0, 1fr);
  margin: 0;
  border: 0;
}
```

- [ ] **Step 7: Run tests**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
npm --prefix web run lint
```

Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add web/components/operator/OperatorHealthStrip.tsx web/components/operator/OperatorIncidentPanel.tsx web/components/operator/OperatorWorkspace.tsx web/components/operator/OperatorStateBoard.tsx web/app/globals.css tests/web/southstar-operator-product-control-tower.test.tsx
git commit -m "feat: add operator health and incident summary"
```

## Task 4: Summary-First Sidecar And Tab Click Fix

**Files:**

- Create: `web/components/operator/OperatorTaskSummary.tsx`
- Modify: `web/components/operator/OperatorTaskTabs.tsx`
- Modify: `web/components/SidecarShell.tsx`
- Modify: `web/app/globals.css`
- Test: `tests/web/southstar-product-responsive.test.tsx`

- [ ] **Step 1: Write failing source guard**

Create:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("sidecar has sticky clickable tabs above scrollable content", () => {
  const shell = source("web/components/SidecarShell.tsx");
  const css = source("web/app/globals.css");
  assert.match(shell, /sidecar-tabs/);
  assert.match(css, /\\.sidecar-tabs/);
  assert.match(css, /position: sticky/);
  assert.match(css, /z-index: 2/);
});

test("operator task tabs render summary before raw debug panels", () => {
  const tabs = source("web/components/operator/OperatorTaskTabs.tsx");
  assert.match(tabs, /OperatorTaskSummary/);
  assert.match(tabs, /Task Summary/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx tests/web/southstar-product-responsive.test.tsx
```

Expected: fail because `OperatorTaskSummary` and sticky tab CSS are missing.

- [ ] **Step 3: Create task summary component**

Create `OperatorTaskSummary.tsx`:

```tsx
"use client";

import type { OperatorTaskDebug } from "@/lib/operator/types";

export function OperatorTaskSummary({ debug }: { debug: OperatorTaskDebug }) {
  const task = debug.data.task;
  const latest = debug.data.history[0];
  const action = debug.data.actions[0];

  return (
    <section className="operator-task-summary">
      <header className="operator-panel-header"><h2>Task Summary</h2></header>
      <dl className="operator-summary-grid">
        <dt>Task</dt><dd>{task.taskKey}</dd>
        <dt>Status</dt><dd>{task.status}</dd>
        <dt>Latest event</dt><dd>{latest ? `${latest.eventType} by ${latest.actorType}` : "No history yet"}</dd>
        <dt>Recommended next action</dt><dd>{action?.label || "Review DAG, History, Live SSE, and Artifacts"}</dd>
      </dl>
    </section>
  );
}
```

- [ ] **Step 4: Render summary in sidecar task tabs**

In `OperatorTaskTabs.tsx`, import and render:

```tsx
import { OperatorTaskSummary } from "./OperatorTaskSummary";
```

Wrap each debug branch in a fragment:

```tsx
if (kind === "operatorHistory") {
  return (
    <>
      <OperatorTaskSummary debug={debug.model} />
      <OperatorHistoryPanel history={debug.model.data.history} />
    </>
  );
}
```

Repeat the same summary wrapper for DAG, Live SSE, Actions, and Artifacts.

- [ ] **Step 5: Fix sidecar tab header layering**

In `web/app/globals.css`, update:

```css
.sidecar-tabs {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-panel);
}

.sidecar-content {
  min-height: 0;
  overflow: auto;
}
```

If `.sidecar-tabs` is inside `.sidecar-header`, move only the tab list CSS to the element that contains clickable tab buttons. The accepted result is that scrollable History content cannot cover tab buttons.

- [ ] **Step 6: Run tests and manual smoke**

```bash
npx tsx tests/web/southstar-product-responsive.test.tsx
npm --prefix web run lint
```

Then run a smoke click with system Chrome:

```bash
node --input-type=module scripts/smoke/operator-sidecar-tabs.mjs
```

Expected: clicks `History`, `DAG`, `Actions`, and `Live SSE` without pointer interception.

- [ ] **Step 7: Commit**

```bash
git add web/components/operator/OperatorTaskSummary.tsx web/components/operator/OperatorTaskTabs.tsx web/components/SidecarShell.tsx web/app/globals.css tests/web/southstar-product-responsive.test.tsx
git commit -m "fix: keep operator sidecar tabs clickable"
```

## Task 5: Safe Recovery Actions

**Files:**

- Modify: `web/components/operator/OperatorActionsPanel.tsx`
- Test: `tests/web/southstar-operator-product-control-tower.test.tsx`

- [ ] **Step 1: Write failing source guard**

Append:

```ts
test("operator actions require reason and show consequence preview", () => {
  const panel = source("web/components/operator/OperatorActionsPanel.tsx");
  assert.match(panel, /Consequence/);
  assert.match(panel, /operator-action-reason/);
  assert.match(panel, /reason\.trim\(\)/);
  assert.match(panel, /Command result/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: fail until the reason/consequence UI exists.

- [ ] **Step 3: Add consequence preview and required reason**

In `OperatorActionsPanel.tsx`, add local state:

```ts
const [reasonByCommand, setReasonByCommand] = useState<Record<string, string>>({});
```

Before invoking command:

```ts
const reason = reasonByCommand[command.id]?.trim() || "";
if (command.requiresConfirmation && !reason) {
  setActionError("A reason is required before running this recovery action.");
  return;
}
```

Include reason in body:

```ts
body: JSON.stringify({
  endpoint: command.endpoint,
  body: { ...(command.body || {}), reason },
}),
```

Render preview:

```tsx
<p className="operator-muted">
  <strong>Consequence:</strong> This command may update task recovery state for {taskId}.
</p>
<input
  className="operator-action-reason"
  value={reasonByCommand[command.id] || ""}
  onChange={(event) => setReasonByCommand((current) => ({ ...current, [command.id]: event.target.value }))}
  placeholder="Reason for audit history"
/>
```

Render result heading:

```tsx
<div className="operator-section-label">Command result</div>
```

- [ ] **Step 4: Run tests**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
npm --prefix web run lint
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add web/components/operator/OperatorActionsPanel.tsx tests/web/southstar-operator-product-control-tower.test.tsx
git commit -m "feat: require reason for operator recovery actions"
```

## Task 6: Productized Workflow Node Profile Workspace

**Files:**

- Create: `web/components/workflow/WorkflowNodeProfileSummary.tsx`
- Create: `web/components/workflow/WorkflowNodeProfileRecommendations.tsx`
- Modify: `web/components/WorkflowNodeProfileEditor.tsx`
- Modify: `web/app/globals.css`
- Modify: `tests/web/workflow-node-profile-editor-ui.test.tsx`

- [ ] **Step 1: Write failing product source guard**

Extend `tests/web/workflow-node-profile-editor-ui.test.tsx`:

```ts
test("workflow node profile editor is summary-first task workspace", () => {
  const editor = readFileSync(join(root, "web/components/WorkflowNodeProfileEditor.tsx"), "utf8");
  const summary = readFileSync(join(root, "web/components/workflow/WorkflowNodeProfileSummary.tsx"), "utf8");
  const recommendations = readFileSync(join(root, "web/components/workflow/WorkflowNodeProfileRecommendations.tsx"), "utf8");

  assert.match(editor, /WorkflowNodeProfileSummary/);
  assert.match(editor, /WorkflowNodeProfileRecommendations/);
  assert.match(summary, /Task Profile Summary/);
  assert.match(summary, /Effective profile/);
  assert.match(summary, /Override diff/);
  assert.match(summary, /needs_validation/);
  assert.match(recommendations, /Recommended alternatives/);
  assert.match(recommendations, /agentProfiles/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/web/workflow-node-profile-editor-ui.test.tsx
```

Expected: fail because summary/recommendation components do not exist.

- [ ] **Step 3: Create summary component**

Create `web/components/workflow/WorkflowNodeProfileSummary.tsx`:

```tsx
"use client";

import type { WorkflowNodeProfileForm } from "@/lib/workflow/node-profile";

export function WorkflowNodeProfileSummary({
  taskId,
  mode,
  editable,
  dirty,
  selectedDefinition,
  form,
  serverForm,
}: {
  taskId: string;
  mode: "draft" | "runtime";
  editable: boolean;
  dirty: boolean;
  selectedDefinition: Record<string, unknown> | undefined;
  form: WorkflowNodeProfileForm;
  serverForm: WorkflowNodeProfileForm;
}) {
  const taskName = stringValue(selectedDefinition?.taskName) || taskId;
  const roleRef = stringValue(selectedDefinition?.roleRef) || "default role";
  const agentProfileRef = stringValue(selectedDefinition?.agentProfileRef) || "default profile";
  const diff = profileDiff(form, serverForm);

  return (
    <section className="workflow-node-profile-summary">
      <header className="operator-panel-header"><h2>Task Profile Summary</h2></header>
      <dl className="operator-summary-grid">
        <dt>Task</dt><dd>{taskName}</dd>
        <dt>Role</dt><dd>{roleRef}</dd>
        <dt>Effective profile</dt><dd>{agentProfileRef}</dd>
        <dt>Edit mode</dt><dd>{editable ? "Draft override editable" : mode === "runtime" ? "Runtime read-only" : "Read-only"}</dd>
        <dt>Validation impact</dt><dd>{dirty ? "Saving marks this draft needs_validation before launch." : "No pending override changes."}</dd>
        <dt>Override diff</dt><dd>{diff.length > 0 ? diff.join(", ") : "No local override diff"}</dd>
      </dl>
    </section>
  );
}

function profileDiff(form: WorkflowNodeProfileForm, serverForm: WorkflowNodeProfileForm): string[] {
  const fields: Array<keyof WorkflowNodeProfileForm> = ["provider", "model", "thinkingLevel", "instruction", "skillRefs", "mcpGrantRefs"];
  return fields.filter((field) => JSON.stringify(form[field]) !== JSON.stringify(serverForm[field]));
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}
```

- [ ] **Step 4: Create recommendations component**

Create `web/components/workflow/WorkflowNodeProfileRecommendations.tsx`:

```tsx
"use client";

type Candidate = {
  id: string;
  model?: string;
};

export function WorkflowNodeProfileRecommendations({ candidates }: { candidates: Record<string, unknown> | undefined }) {
  const alternatives = readRecord(candidates?.alternatives);
  const agentProfiles = readCandidates(alternatives?.agentProfiles);
  const skills = readCandidates(alternatives?.skills);
  const mcpServers = readCandidates(alternatives?.mcpServers);

  return (
    <section className="workflow-node-profile-recommendations">
      <header className="operator-panel-header"><h2>Recommended alternatives</h2></header>
      <RecommendationList title="Agent profiles" items={agentProfiles} empty="No agent profile alternatives returned." />
      <RecommendationList title="Skills" items={skills} empty="No skill alternatives returned." />
      <RecommendationList title="MCP grants" items={mcpServers} empty="No MCP alternatives returned." />
    </section>
  );
}

function RecommendationList({ title, items, empty }: { title: string; items: Candidate[]; empty: string }) {
  return (
    <div className="workflow-node-profile-recommendation-list">
      <div className="operator-section-label">{title}</div>
      {items.length === 0 ? <p className="operator-muted">{empty}</p> : items.map((item) => (
        <div key={item.id} className="workflow-node-profile-recommendation-row">
          <strong>{item.id}</strong>
          <span>{item.model ? `Model: ${item.model}` : "Candidate from agent library"}</span>
        </div>
      ))}
    </div>
  );
}

function readCandidates(value: unknown): Candidate[] {
  return Array.isArray(value) ? value.map(readCandidate).filter((item): item is Candidate => item !== null) : [];
}

function readCandidate(value: unknown): Candidate | null {
  const record = readRecord(value);
  const id = typeof record?.id === "string" ? record.id : "";
  if (!id) return null;
  const model = typeof record?.model === "string" ? record.model : undefined;
  return { id, ...(model ? { model } : {}) };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
```

- [ ] **Step 5: Wire summary and recommendations before form fields**

In `WorkflowNodeProfileEditor.tsx`, import:

```ts
import { WorkflowNodeProfileRecommendations } from "./workflow/WorkflowNodeProfileRecommendations";
import { WorkflowNodeProfileSummary } from "./workflow/WorkflowNodeProfileSummary";
```

Inside the scrollable content, render these before the editable form sections:

```tsx
<WorkflowNodeProfileSummary
  taskId={taskId}
  mode={mode}
  editable={editable}
  dirty={dirty}
  selectedDefinition={selectedDefinitionRecord}
  form={form}
  serverForm={serverForm}
/>
<WorkflowNodeProfileRecommendations candidates={recordValue(candidates)} />
```

Keep the existing form controls below these two components.

- [ ] **Step 6: Add product copy for read-only runtime mode**

Replace the current read-only message with:

```tsx
<div className="workflow-node-profile-readonly">
  Runtime tasks are read-only because this run has already materialized task envelopes. Edit the planner draft, validate again, and launch a new run to change this task profile.
</div>
```

- [ ] **Step 7: Add CSS**

Append:

```css
.workflow-node-profile-summary,
.workflow-node-profile-recommendations {
  border: 1px solid var(--border);
  background: var(--bg);
}

.workflow-node-profile-recommendation-list {
  padding: 8px;
  border-top: 1px solid var(--border);
}

.workflow-node-profile-recommendation-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 2px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--border);
}

.workflow-node-profile-recommendation-row strong {
  color: var(--text);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.workflow-node-profile-recommendation-row span,
.workflow-node-profile-readonly {
  color: var(--text-muted);
  font-size: 12px;
}

.workflow-node-profile-readonly {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  padding: 10px;
}
```

- [ ] **Step 8: Run tests**

Run:

```bash
npx tsx tests/web/workflow-node-profile-editor-ui.test.tsx
npm --prefix web run lint
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add web/components/workflow/WorkflowNodeProfileSummary.tsx web/components/workflow/WorkflowNodeProfileRecommendations.tsx web/components/WorkflowNodeProfileEditor.tsx web/app/globals.css tests/web/workflow-node-profile-editor-ui.test.tsx
git commit -m "feat: make workflow node profile summary-first"
```

## Task 7: Workflow Launch Preview And Operator Handoff

**Files:**

- Create: `web/components/workflow/WorkflowLaunchPreview.tsx`
- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/WorkflowSidebar.tsx`
- Test: `tests/web/southstar-operator-product-control-tower.test.tsx`

- [ ] **Step 1: Write failing source guard**

Append:

```ts
test("Workflow mode exposes launch preview and Operator handoff", () => {
  const shell = source("web/components/AppShell.tsx");
  const preview = source("web/components/workflow/WorkflowLaunchPreview.tsx");
  assert.match(shell, /WorkflowLaunchPreview/);
  assert.match(preview, /Open in Operator/);
  assert.match(preview, /Validate DAG/);
  assert.match(preview, /Launch run/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: fail because launch preview does not exist.

- [ ] **Step 3: Create launch preview component**

Create `WorkflowLaunchPreview.tsx`:

```tsx
"use client";

import type { WorkflowTemplateSummary } from "@/lib/workflow/types";

export function WorkflowLaunchPreview({
  template,
  cwd,
  latestRunId,
  onOpenOperator,
}: {
  template: WorkflowTemplateSummary | null;
  cwd: string | null;
  latestRunId: string | null;
  onOpenOperator: (runId: string) => void;
}) {
  if (!template) {
    return (
      <section className="workflow-launch-preview">
        <h2>Select a workflow template</h2>
        <p>Choose a template from the library to preview agents, inputs, validation, and launch steps.</p>
      </section>
    );
  }

  return (
    <section className="workflow-launch-preview">
      <h2>{template.name || template.id}</h2>
      <p>{cwd ? `Project: ${cwd}` : "Select a project before launching this workflow."}</p>
      <ol>
        <li>Review template agents and expected DAG.</li>
        <li>Validate DAG.</li>
        <li>Launch run.</li>
        <li>Open in Operator.</li>
      </ol>
      <div className="operator-segmented">
        <button type="button" disabled={!cwd}>Validate DAG</button>
        <button type="button" disabled={!cwd}>Launch run</button>
        <button type="button" disabled={!latestRunId} onClick={() => latestRunId && onOpenOperator(latestRunId)}>
          Open in Operator
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Render preview in Workflow mode empty/selection state**

In `AppShell.tsx`, import:

```ts
import { WorkflowLaunchPreview } from "./workflow/WorkflowLaunchPreview";
```

In center content, when `appMode === "workflow"` and no chat session is open, render:

```tsx
<WorkflowLaunchPreview
  template={selectedWorkflowTemplate}
  cwd={currentCwd}
  latestRunId={operatorSelectedRunId}
  onOpenOperator={(runId) => {
    setAppMode("operator");
    setOperatorSelectedRunId(runId);
  }}
/>
```

- [ ] **Step 5: Add styling**

```css
.workflow-launch-preview {
  max-width: 760px;
  margin: 18px auto;
  padding: 0 16px;
  color: var(--text);
}

.workflow-launch-preview h2 {
  font-size: 16px;
  margin: 0 0 8px;
}

.workflow-launch-preview p,
.workflow-launch-preview li {
  color: var(--text-muted);
  font-size: 12px;
}
```

- [ ] **Step 6: Run tests**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
npm --prefix web run lint
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add web/components/workflow/WorkflowLaunchPreview.tsx web/components/AppShell.tsx web/app/globals.css tests/web/southstar-operator-product-control-tower.test.tsx
git commit -m "feat: add workflow launch handoff"
```

## Task 8: Responsive Navigation And Sidecar Sheet

**Files:**

- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/SidecarShell.tsx`
- Modify: `web/app/globals.css`
- Test: `tests/web/southstar-product-responsive.test.tsx`
- Create: `scripts/smoke/operator-responsive.mjs`

- [ ] **Step 1: Write failing static guard**

Append:

```ts
test("mobile navigation keeps mode tabs reachable and sidecar as sheet", () => {
  const css = source("web/app/globals.css");
  const shell = source("web/components/AppShell.tsx");
  assert.match(css, /@media \\(max-width: 720px\\)/);
  assert.match(css, /\\.sidebar-container\\.sidebar-open/);
  assert.match(css, /\\.sidecar-shell/);
  assert.match(shell, /data-testid="mode-operator"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx tests/web/southstar-product-responsive.test.tsx
```

Expected: fail until responsive CSS is added.

- [ ] **Step 3: Add mobile CSS**

In `globals.css`:

```css
@media (max-width: 720px) {
  .sidebar-container.sidebar-open {
    top: 36px;
    width: min(88vw, 340px);
    z-index: 80;
  }

  .sidecar-shell {
    top: 36px;
    right: 0;
    left: 0;
    width: 100vw !important;
    max-width: none;
    border-left: 0;
  }

  .sidecar-floating,
  .sidecar-pinned,
  .sidecar-expanded {
    height: calc(100vh - 36px);
  }
}
```

The exact selector names must match current `AppShell` and `SidecarShell`; adjust only if the existing class names differ.

- [ ] **Step 4: Add smoke script**

Create `scripts/smoke/operator-responsive.mjs`:

```js
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
  await page.goto("http://127.0.0.1:30141", { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.getByTestId("mode-operator").click();
  await page.waitForTimeout(800);
  const pressed = await page.getByTestId("mode-operator").getAttribute("aria-pressed");
  if (pressed !== "true") throw new Error("Operator mode was not reachable on mobile");
} finally {
  await browser.close();
}
```

- [ ] **Step 5: Run smoke**

Ensure app is running:

```bash
npm run southstar:status
```

Run:

```bash
node scripts/smoke/operator-responsive.mjs
```

Expected: exits 0.

- [ ] **Step 6: Run tests**

```bash
npx tsx tests/web/southstar-product-responsive.test.tsx
npm --prefix web run lint
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add web/components/AppShell.tsx web/components/SidecarShell.tsx web/app/globals.css tests/web/southstar-product-responsive.test.tsx scripts/smoke/operator-responsive.mjs
git commit -m "fix: make operator navigation responsive"
```

## Task 9: Product Empty States And Accessibility Labels

**Files:**

- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/AppModeRail.tsx`
- Modify: `web/components/operator/*`
- Test: `tests/web/southstar-operator-product-control-tower.test.tsx`

- [ ] **Step 1: Write failing source guard**

Append:

```ts
test("product empty states explain mode purpose and primary action", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /Chat handles ad-hoc questions/);
  assert.match(shell, /Workflow handles DAG generation/);
  assert.match(shell, /Operator helps you monitor and recover/);
  assert.match(source("web/components/AppModeRail.tsx"), /aria-label/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
```

Expected: fail because copy and labels are incomplete.

- [ ] **Step 3: Add empty state copy**

Replace generic get-started copy with mode-specific messages:

```tsx
const modeEmptyState = {
  chat: {
    title: "Start with Chat",
    body: "Chat handles ad-hoc questions, non-workflow jobs, and one-off project interactions.",
    action: "Select a project or start a new chat.",
  },
  workflow: {
    title: "Plan and launch a workflow",
    body: "Workflow handles DAG generation, task profile tuning, validation, and launch.",
    action: "Select a project and choose or generate a workflow.",
  },
  operator: {
    title: "Monitor and recover runs",
    body: "Operator helps you monitor launched workflows, inspect incidents, and apply recovery actions.",
    action: "Review active incidents or select a running workflow.",
  },
} as const;
```

Render title/body/action in the existing placeholder area.

- [ ] **Step 4: Add accessible labels**

For icon-only buttons in `AppModeRail`, `SidecarShell`, and Operator controls, ensure:

```tsx
<button type="button" aria-label="Open Operator" title="Operator monitor">
```

For sidecar mode buttons:

```tsx
<button type="button" aria-label="Float sidecar">Float</button>
```

- [ ] **Step 5: Run tests and lint**

```bash
npx tsx tests/web/southstar-operator-product-control-tower.test.tsx
npm --prefix web run lint
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add web/components/AppShell.tsx web/components/AppModeRail.tsx web/components/SidecarShell.tsx web/components/operator tests/web/southstar-operator-product-control-tower.test.tsx
git commit -m "feat: clarify product empty states"
```

## Task 10: Final Verification

**Files:**

- Modify: `docs/superpowers/audits/2026-06-30-product-ui-review/product-ui-review.md`
- Test: full verification

- [ ] **Step 1: Run full web checks**

```bash
npm --prefix web run lint
npm --prefix web run build
```

Expected: lint exits 0; build exits 0. Existing warning from `app/api/sessions/[id]/export/route.ts` is acceptable only if unchanged.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run browser smoke**

```bash
npm run southstar:status
node scripts/smoke/operator-responsive.mjs
node scripts/smoke/operator-sidecar-tabs.mjs
```

Expected: status shows web at `http://127.0.0.1:30141`; smoke scripts exit 0.

- [ ] **Step 4: Capture final screenshots**

Use system Chrome Playwright and save:

```text
docs/superpowers/audits/2026-06-30-product-ui-review/final-operator-overview.png
docs/superpowers/audits/2026-06-30-product-ui-review/final-sidecar-summary.png
docs/superpowers/audits/2026-06-30-product-ui-review/final-workflow-node-profile.png
docs/superpowers/audits/2026-06-30-product-ui-review/final-mobile-operator.png
```

- [ ] **Step 5: Update audit note**

Append a final section:

```md
## Final Verification Screens

- `final-operator-overview.png`: health strip, priority lanes, grouped incidents visible.
- `final-sidecar-summary.png`: task summary visible before debug details.
- `final-workflow-node-profile.png`: node profile editor shows task summary, effective profile, override diff, recommendations, and validation impact.
- `final-mobile-operator.png`: Operator mode reachable on narrow viewport.
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/audits/2026-06-30-product-ui-review scripts/smoke tests web
git commit -m "test: verify operator product control tower"
```

## Execution Notes

- Keep commits small and task-scoped.
- Do not modify runtime state-machine invariants.
- Do not add new lifecycle states.
- Do not introduce new UI palette or design system.
- If a task exposes missing backend data, keep the first pass frontend-derived and add a separate backend read-model follow-up only after the UI need is proven.

## Self-Review

- Spec coverage: incident model, priority lanes, grouped attention, summary-first sidecar, safe actions, workflow node profile workspace, workflow launch handoff, responsive navigation, empty states, accessibility labels, and verification all map to tasks.
- Placeholder scan: no unspecified implementation placeholders remain.
- Type consistency: `OperatorIncident`, `OperatorPriorityLanes`, `OperatorOverview`, `OperatorRun`, and `OperatorTaskDebug` names align with existing `web/lib/operator/types.ts` plus Task 1 additions.

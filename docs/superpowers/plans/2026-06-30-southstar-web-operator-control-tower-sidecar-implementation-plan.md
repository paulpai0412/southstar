# Southstar Web Operator Control Tower Sidecar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the live `/home/timmypai/apps/southstar/web` Operator tab into a pi-web style control tower that shows repo-filtered workflow progress, task-level exceptions, history, live SSE, actions, and artifacts at a glance.

**Architecture:** The active UI is the Next app running on port `30141` from `/home/timmypai/apps/southstar/web`; all new UI code lands under `web/` and must not import retired root-level UI folders. Useful legacy operator and workflow-canvas code is copied into new web-local folders before use, because the old root folders will be deleted later. The shell keeps Chat and Workflow behavior, enables Operator mode, replaces the fixed right panel with a shared floating sidecar, and uses runtime read models plus task-filtered SSE for debug views.

**Tech Stack:** Next.js 16 app router, React 19, TypeScript, existing pi-web CSS tokens in `web/app/globals.css`, React Flow via `@xyflow/react`, ELK via `elkjs`, runtime v2 Postgres read models, native `node:test`, Playwright smoke testing.

---

## Current Live Entry

Use this repository root for implementation:

`/home/timmypai/apps/southstar`

The UI currently in use is:

`/home/timmypai/apps/southstar/web`

Port confirmation:

```bash
curl -I http://127.0.0.1:30141
```

Expected:

```text
HTTP/1.1 200 OK
```

Main entry files:

- `/home/timmypai/apps/southstar/web/app/page.tsx`
- `/home/timmypai/apps/southstar/web/components/AppShell.tsx`
- `/home/timmypai/apps/southstar/web/components/AppModeRail.tsx`
- `/home/timmypai/apps/southstar/web/app/globals.css`

Current useful legacy source folders:

- `/home/timmypai/apps/southstar/components/southstar/operator/`
- `/home/timmypai/apps/southstar/components/southstar/workflow-canvas/`

Rule for this implementation:

Do not import root-level `components/southstar/*` or `lib/southstar/*` from the active `web/` app. Copy useful code into new `web/` folders first.

## Layout Contract

```text
+----------------------------------------------------------------------------------+
| top bar: sidebar | theme | Chat | Workflow | Operator | session/runtime signals  |
+------------------+---------------------------------------------------------------+
| LEFT             | CENTER                                                        |
| Project Scope    | Runtime State Board                                           |
| - Southstar      | [Created] [Scheduling] [Running] [Verifying] [Blocked]        |
| - repo picker    |                                                               |
| - refresh        | Selected Workflow Progress                                    |
|------------------| - timeline/progress list first                                |
| Operator Focus   | - DAG toggle using web-local React Flow canvas                 |
| - attention      | - click task opens sidecar tabs                                |
| - running flows  |                                                               |
+------------------+---------------------------------------------------------------+
                         +----------------------------------------------+
                         | floating shared sidecar                      |
                         | Files | DAG | History | Live SSE | Actions   |
                         | task/run scoped debug, artifacts, resources  |
                         +----------------------------------------------+
```

Sidecar modes:

- `floating`: default; overlays the right edge and does not shrink the center content.
- `pinned`: docks at the right edge and reserves width.
- `expanded`: larger fixed overlay for deep debug.
- `hidden`: closed, with a top-right reopen button.

## Legacy Dependency Inventory

The live Chat panel is already web-native:

- `/home/timmypai/apps/southstar/web/components/ChatWindow.tsx`
- `/home/timmypai/apps/southstar/web/components/MessageView.tsx`
- `/home/timmypai/apps/southstar/web/hooks/useAgentSession.ts`

No root-level old UI imports were found in Chat.

The live Workflow panel has one root-level old UI import:

- `/home/timmypai/apps/southstar/web/components/WorkflowDagBlock.tsx`

It imports:

```ts
import { SouthstarWorkflowCanvas } from "../../components/southstar/workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowDependencyModel, WorkflowTaskNodeModel } from "../../components/southstar/workflow-canvas/types";
```

`WorkflowDagBlock` is the workflow message DAG wrapper. The actual React DAG renderer is `SouthstarWorkflowCanvas`, which uses `@xyflow/react` and ELK. This must be copied to `web/components/workflow-canvas/` and then imported locally.

The root-level Operator code contains useful behavior but must not be imported by the live `web/` app:

- `ActiveRunStrip.tsx`
- `AttentionQueue.tsx`
- `InterventionPanel.tsx`
- `OperatorBoard.tsx` normalizers
- `RunEventStreamPanel.tsx` SSE parser and reconnect cursor behavior

Copy the useful logic into:

- `/home/timmypai/apps/southstar/web/components/operator/`
- `/home/timmypai/apps/southstar/web/lib/operator/`

## File Structure

Create:

- `web/components/ProjectScopePicker.tsx`  
  Web-local repo/cwd selector copied from the useful SessionSidebar behavior, styled with the same pi-web tokens.

- `web/components/SidecarShell.tsx`  
  Shared floating/pinned/expanded/hidden sidecar used by Chat, Workflow, and Operator.

- `web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx`  
  Copied React Flow canvas.

- `web/components/workflow-canvas/WorkflowDependencyEdge.tsx`  
  Copied dependency edge renderer.

- `web/components/workflow-canvas/WorkflowTaskNode.tsx`  
  Copied task node renderer.

- `web/components/workflow-canvas/colors.ts`  
  Copied status color helpers.

- `web/components/workflow-canvas/layout.ts`  
  Copied ELK layout helper.

- `web/components/workflow-canvas/types.ts`  
  Copied canvas model types.

- `web/components/operator/OperatorSidebar.tsx`  
  Left Operator block with Project Scope and Operator Focus.

- `web/components/operator/OperatorWorkspace.tsx`  
  Center Operator board and selected workflow progress/DAG toggle.

- `web/components/operator/OperatorStateBoard.tsx`  
  Runtime state board grouped by lifecycle buckets.

- `web/components/operator/OperatorWorkflowProgress.tsx`  
  Selected workflow timeline/progress rows and DAG toggle.

- `web/components/operator/OperatorTaskTabs.tsx`  
  Sidecar tab content for DAG, History, Live SSE, Actions, and Artifacts.

- `web/components/operator/OperatorLiveStream.tsx`  
  Task/run scoped SSE debug stream view.

- `web/components/operator/OperatorHistoryPanel.tsx`  
  Durable history timeline from the task debug read model.

- `web/components/operator/OperatorActionsPanel.tsx`  
  Confirmation + reason command runner copied from useful InterventionPanel behavior.

- `web/components/operator/OperatorArtifactsPanel.tsx`  
  Task resources and artifact refs.

- `web/hooks/useOperatorOverview.ts`  
  Fetches `/api/operator/overview`, applies repo filter, and auto-refreshes.

- `web/hooks/useOperatorTaskDebug.ts`  
  Fetches `/api/operator/task-debug?runId=...&taskId=...`.

- `web/hooks/useRuntimeEventStream.ts`  
  Shared SSE reader with per-scope cursor and reconnect behavior.

- `web/lib/operator/types.ts`  
  Web Operator view types.

- `web/lib/operator/normalizers.ts`  
  Copied normalizers from root OperatorBoard, adapted to web-local types.

- `web/lib/operator/progress.ts`  
  State bucket helpers, selected workflow progress helpers, repo filter helpers.

- `web/lib/operator/sse.ts`  
  Copied SSE parsing and URL builders from RunEventStreamPanel.

- `web/app/api/operator/overview/route.ts`  
  Next proxy to `/api/v2/ui/operator-overview`, preserving query params.

- `web/app/api/operator/task-debug/route.ts`  
  Next proxy to `/api/v2/ui/operator-task-debug`.

- `web/app/api/operator/runs/[runId]/events/stream/route.ts`  
  Next proxy to `/api/v2/runs/:runId/events/stream` with `taskId`, `after`, and `closeOnTerminal`.

- `src/v2/read-models/operator-task-debug.ts`  
  Backend read model for selected task history/resources/artifacts/actions.

- `tests/v2/operator-task-debug-read-model.test.ts`  
  Runtime contract test for task debug history and resources.

- `tests/v2/runtime-event-stream-task-filter.test.ts`  
  Runtime contract test for task-filtered SSE event reads.

- `tests/web/southstar-web-operator-control-tower.test.tsx`  
  Static and helper tests for the live `/web` shell, legacy import isolation, sidecar tabs, and Operator mode.

Modify:

- `web/package.json`  
  Add `@xyflow/react` and `elkjs` dependencies.

- `web/package-lock.json`  
  Generated by `npm --prefix web install @xyflow/react@^12.11.1 elkjs@^0.11.1`.

- `web/components/AppModeRail.tsx`  
  Enable Operator tab.

- `web/components/AppShell.tsx`  
  Render Operator sidebar/workspace and replace the fixed right panel with `SidecarShell`.

- `web/components/WorkflowDagBlock.tsx`  
  Import web-local workflow canvas.

- `web/components/TabBar.tsx`  
  Expand tab kind support for sidecar tabs.

- `web/app/globals.css`  
  Add small pi-web style classes for sidecar and Operator surfaces.

- `src/v2/server/sse.ts`  
  Add optional `taskId` filtering.

- `src/v2/server/runtime-event-stream.ts`  
  Pass `taskId` query to the SSE reader.

- `src/v2/server/ui-routes.ts`  
  Add `/api/v2/ui/operator-task-debug`.

- `src/v2/read-models/operator-overview.ts`  
  Include best-effort `cwd` and `projectRoot` on active runs by reading run context and planner draft request metadata.

- `src/v2/ui-api/postgres-run-api.ts`  
  Preserve draft `cwd` into run `runtime_context_json` when creating a run from a draft.

## Task 1: Web-Local Workflow Canvas Copy

**Files:**

- Create: `web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx`
- Create: `web/components/workflow-canvas/WorkflowDependencyEdge.tsx`
- Create: `web/components/workflow-canvas/WorkflowTaskNode.tsx`
- Create: `web/components/workflow-canvas/colors.ts`
- Create: `web/components/workflow-canvas/layout.ts`
- Create: `web/components/workflow-canvas/types.ts`
- Modify: `web/components/WorkflowDagBlock.tsx`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Test: `tests/web/southstar-web-operator-control-tower.test.tsx`

- [ ] **Step 1: Write the failing legacy import isolation test**

Create `tests/web/southstar-web-operator-control-tower.test.tsx` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("live web workflow DAG uses a web-local React Flow canvas", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");
  assert.match(block, /\\.\\/workflow-canvas\\/SouthstarWorkflowCanvas/);
  assert.match(block, /\\.\\/workflow-canvas\\/types/);
  assert.doesNotMatch(block, /\\.\\.\\/\\.\\.\\/components\\/southstar\\/workflow-canvas/);
});

test("live web app does not import retired root UI folders", () => {
  const checkedFiles = [
    "web/components/AppShell.tsx",
    "web/components/ChatWindow.tsx",
    "web/components/MessageView.tsx",
    "web/components/WorkflowDagBlock.tsx",
    "web/components/WorkflowSidebar.tsx",
  ];
  for (const file of checkedFiles) {
    const text = source(file);
    assert.doesNotMatch(text, /components\\/southstar\\//, `${file} imports retired root UI components`);
    assert.doesNotMatch(text, /lib\\/southstar\\//, `${file} imports retired root UI libs`);
  }
});

test("web-local workflow canvas keeps React Flow and ELK behavior", () => {
  assert.match(source("web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /@xyflow\\/react/);
  assert.match(source("web/components/workflow-canvas/layout.ts"), /elkjs\\/lib\\/elk\\.bundled\\.js/);
  assert.match(source("web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /MiniMap/);
  assert.match(source("web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /Controls/);
  assert.match(source("web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /Background/);
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
not ok
```

The failure names `web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx` as missing or reports the old `../../components/southstar/workflow-canvas` import.

- [ ] **Step 3: Copy the workflow canvas files into web**

Run:

```bash
mkdir -p web/components/workflow-canvas
cp components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx
cp components/southstar/workflow-canvas/WorkflowDependencyEdge.tsx web/components/workflow-canvas/WorkflowDependencyEdge.tsx
cp components/southstar/workflow-canvas/WorkflowTaskNode.tsx web/components/workflow-canvas/WorkflowTaskNode.tsx
cp components/southstar/workflow-canvas/colors.ts web/components/workflow-canvas/colors.ts
cp components/southstar/workflow-canvas/layout.ts web/components/workflow-canvas/layout.ts
cp components/southstar/workflow-canvas/types.ts web/components/workflow-canvas/types.ts
```

- [ ] **Step 4: Install the web-local canvas dependencies**

Run:

```bash
npm --prefix web install @xyflow/react@^12.11.1 elkjs@^0.11.1
```

Expected:

```text
added
```

If npm reports the packages are already up to date, accept that output as success.

- [ ] **Step 5: Update WorkflowDagBlock imports**

Change the imports at the top of `web/components/WorkflowDagBlock.tsx` to:

```ts
import { SouthstarWorkflowCanvas } from "./workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel, WorkflowDependencyModel, WorkflowTaskNodeModel } from "./workflow-canvas/types";
```

- [ ] **Step 6: Run the canvas isolation test**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 7: Commit**

Run:

```bash
git add web/components/workflow-canvas web/components/WorkflowDagBlock.tsx web/package.json web/package-lock.json tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "refactor: move workflow canvas into web app"
```

Expected:

```text
[branch ...] refactor: move workflow canvas into web app
```

## Task 2: Runtime Task Debug and Task-Filtered SSE Contracts

**Files:**

- Create: `src/v2/read-models/operator-task-debug.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Modify: `src/v2/server/sse.ts`
- Modify: `src/v2/server/runtime-event-stream.ts`
- Modify: `src/v2/read-models/operator-overview.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Test: `tests/v2/operator-task-debug-read-model.test.ts`
- Test: `tests/v2/runtime-event-stream-task-filter.test.ts`

- [ ] **Step 1: Write the failing task debug read-model test**

Create `tests/v2/operator-task-debug-read-model.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, appendHistoryEventPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("operator task debug read model returns selected task history and resources", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-operator-task-debug";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "debug task progress",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: JSON.stringify({ cwd: "/home/timmypai/apps/southstar" }),
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, {
      id: "task-build",
      runId,
      taskKey: "Build",
      status: "running",
      sortOrder: 1,
      dependsOn: [],
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId: "task-build",
      eventType: "task.started",
      actorType: "orchestrator",
      payload: { message: "Build started" },
    });
    await appendHistoryEventPg(db, {
      runId,
      taskId: "task-build",
      eventType: "artifact.accepted",
      actorType: "checker",
      payload: { artifactId: "artifact-build-1", summary: "Implementation report accepted" },
    });
    await upsertRuntimeResourcePg(db, {
      resourceType: "artifact_ref",
      resourceKey: "artifact-build-1",
      runId,
      taskId: "task-build",
      scope: "artifact",
      status: "accepted",
      title: "Implementation report",
      payload: { kind: "implementation_result", path: "artifacts/build.json" },
      summary: { kind: "implementation_result" },
    });

    const request = new Request(`http://127.0.0.1/api/v2/ui/operator-task-debug?runId=${runId}&taskId=task-build`);
    const response = await handleRuntimeRoute({ db } as any, request);
    assert.ok(response);
    assert.equal(response!.status, 200);
    const body = await response!.json() as any;
    assert.equal(body.kind, "ui-operator-task-debug");
    assert.equal(body.result.schemaVersion, "southstar.read_model.operator_task_debug.v1");
    assert.equal(body.result.data.runId, runId);
    assert.equal(body.result.data.task.taskId, "task-build");
    assert.deepEqual(body.result.data.history.map((item: any) => item.eventType), ["artifact.accepted", "task.started"]);
    assert.equal(body.result.data.resources[0].resourceKey, "artifact-build-1");
    assert.equal(body.result.data.artifacts[0].resourceKey, "artifact-build-1");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Write the failing SSE filter test**

Create `tests/v2/runtime-event-stream-task-filter.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowRunPg, appendHistoryEventPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { readRunEventsSince } from "../../src/v2/server/sse.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("readRunEventsSince can filter by task id while preserving run-level events when requested", async () => {
  const db = await createTestPostgresDb();
  try {
    const runId = "run-sse-task-filter";
    await createWorkflowRunPg(db, {
      id: runId,
      status: "running",
      domain: "software",
      goalPrompt: "stream task filter",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await appendHistoryEventPg(db, { runId, eventType: "run.created", actorType: "orchestrator", payload: {} });
    await appendHistoryEventPg(db, { runId, taskId: "task-a", eventType: "task.a", actorType: "worker", payload: {} });
    await appendHistoryEventPg(db, { runId, taskId: "task-b", eventType: "task.b", actorType: "worker", payload: {} });

    const taskOnly = await readRunEventsSince(db, { runId, afterSequence: 0, taskId: "task-a", includeRunEvents: false });
    assert.deepEqual(taskOnly.map((event) => event.eventType), ["task.a"]);

    const withRunEvents = await readRunEventsSince(db, { runId, afterSequence: 0, taskId: "task-a", includeRunEvents: true });
    assert.deepEqual(withRunEvents.map((event) => event.eventType), ["run.created", "task.a"]);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 3: Run the failing tests**

Run:

```bash
npx tsx tests/v2/operator-task-debug-read-model.test.ts
npx tsx tests/v2/runtime-event-stream-task-filter.test.ts
```

Expected:

```text
not ok
```

The first failure names the missing `operator-task-debug` route. The second failure names unsupported `taskId` input.

- [ ] **Step 4: Implement task-filtered SSE reads**

Update `src/v2/server/sse.ts` so the function signature is:

```ts
export async function readRunEventsSince(db: SouthstarDb, input: {
  runId: string;
  afterSequence?: number;
  taskId?: string;
  includeRunEvents?: boolean;
}): Promise<RuntimeEventFrame[]> {
  const rows = await db.query<{
    sequence: number;
    event_type: string;
    run_id: string;
    task_id: string | null;
    session_id: string | null;
    actor_type: string;
    payload_json: unknown;
    created_at: Date | string;
  }>(
    `select sequence, event_type, run_id, task_id, session_id, actor_type, payload_json, created_at
       from southstar.workflow_history
      where run_id = $1
        and sequence > $2
        and (
          $3::text is null
          or task_id = $3
          or ($4::boolean and task_id is null)
        )
      order by sequence`,
    [input.runId, input.afterSequence || 0, input.taskId || null, input.includeRunEvents || true],
  );
  return rows.rows.map((row) => ({
    sequence: row.sequence,
    eventType: row.event_type,
    runId: row.run_id,
    taskId: row.task_id || undefined,
    sessionId: row.session_id || undefined,
    actorType: row.actor_type,
    payload: row.payload_json,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}
```

- [ ] **Step 5: Pass SSE query params through runtime-event-stream**

In `src/v2/server/runtime-event-stream.ts`, extend `createRuntimeEventStreamResponse`:

```ts
const taskId = url.searchParams.get("taskId") || undefined;
const includeRunEvents = url.searchParams.get("includeRunEvents") !== "false";
```

Pass both values into `createRuntimeEventStream`, then into every `readRunEventsSince` call:

```ts
const events = await readRunEventsSince(context.db, {
  runId: input.runId,
  afterSequence: nextAfter,
  taskId: input.taskId,
  includeRunEvents: input.includeRunEvents,
});
```

Apply the same input fields to the `finalEvents` call.

- [ ] **Step 6: Create the operator task debug read model**

Create `src/v2/read-models/operator-task-debug.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";

export async function buildOperatorTaskDebugReadModelPg(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const task = await db.maybeOne<{
    id: string;
    task_key: string;
    status: string;
    sort_order: number;
    depends_on_json: unknown;
    root_session_id: string | null;
    executor_task_id: string | null;
    snapshot_json: unknown;
    metrics_json: unknown;
    updated_at: Date;
  }>(
    `select id, task_key, status, sort_order, depends_on_json, root_session_id, executor_task_id, snapshot_json, metrics_json, updated_at
       from southstar.workflow_tasks
      where run_id = $1 and id = $2`,
    [input.runId, input.taskId],
  );
  if (!task) throw new Error(`task not found: ${input.runId}/${input.taskId}`);

  const history = await db.query<{
    sequence: number;
    event_type: string;
    actor_type: string;
    session_id: string | null;
    payload_json: unknown;
    created_at: Date;
  }>(
    `select sequence, event_type, actor_type, session_id, payload_json, created_at
       from southstar.workflow_history
      where run_id = $1 and task_id = $2
      order by sequence desc
      limit 120`,
    [input.runId, input.taskId],
  );

  const resources = await db.query<{
    resource_type: string;
    resource_key: string;
    status: string;
    title: string | null;
    payload_json: unknown;
    summary_json: unknown;
    updated_at: Date;
  }>(
    `select resource_type, resource_key, status, title, payload_json, summary_json, updated_at
       from southstar.runtime_resources
      where run_id = $1 and task_id = $2
      order by updated_at desc, resource_key
      limit 120`,
    [input.runId, input.taskId],
  );

  const mappedResources = resources.rows.map((row) => ({
    resourceType: row.resource_type,
    resourceKey: row.resource_key,
    status: row.status,
    title: row.title || row.resource_key,
    payload: row.payload_json,
    summary: row.summary_json,
    updatedAt: row.updated_at.toISOString(),
  }));

  return {
    schemaVersion: "southstar.read_model.operator_task_debug.v1",
    kind: "operator-task-debug",
    data: {
      runId: input.runId,
      task: {
        taskId: task.id,
        taskKey: task.task_key,
        status: task.status,
        sortOrder: task.sort_order,
        dependsOn: stringArray(task.depends_on_json),
        rootSessionId: task.root_session_id,
        executorTaskId: task.executor_task_id,
        snapshot: task.snapshot_json,
        metrics: task.metrics_json,
        updatedAt: task.updated_at.toISOString(),
      },
      history: history.rows.map((row) => ({
        sequence: row.sequence,
        eventType: row.event_type,
        actorType: row.actor_type,
        sessionId: row.session_id || undefined,
        payload: row.payload_json,
        createdAt: row.created_at.toISOString(),
      })),
      resources: mappedResources,
      artifacts: mappedResources.filter((row) => row.resourceType === "artifact_ref"),
      actions: mappedResources.filter((row) => ["runtime_command", "approval", "recovery_decision"].includes(row.resourceType)),
    },
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
```

- [ ] **Step 7: Add the backend UI route**

In `src/v2/server/ui-routes.ts`, import the read model:

```ts
import { buildOperatorTaskDebugReadModelPg } from "../read-models/operator-task-debug.ts";
```

Add this branch before `return undefined`:

```ts
if (request.method === "GET" && url.pathname === "/api/v2/ui/operator-task-debug") {
  return json("ui-operator-task-debug", await buildOperatorTaskDebugReadModelPg(context.db, {
    runId: requiredQuery(url, "runId"),
    taskId: requiredQuery(url, "taskId"),
  }));
}
```

- [ ] **Step 8: Preserve cwd in run context and overview**

In `src/v2/ui-api/postgres-run-api.ts`, when building `runtimeContextJson`, read `bundle.plannerRequest?.cwd` and preserve it:

```ts
const plannerRequest = asRecord(bundle.plannerRequest);
const cwd = stringValue(plannerRequest.cwd);
runtimeContextJson: JSON.stringify({
  draftId: input.draftId,
  scope: workflow.domain,
  ...(cwd ? { cwd, projectRoot: cwd } : {}),
}),
```

In `src/v2/read-models/operator-overview.ts`, include `runtime_context_json` in the active run query and map:

```ts
runtime_context_json: unknown;
```

Use:

```ts
const runtimeContext = asRecord(run.runtime_context_json);
const cwd = stringValue(runtimeContext.cwd);
const projectRoot = stringValue(runtimeContext.projectRoot) || cwd;
```

Add these fields to `ActiveRun`:

```ts
cwd?: string;
projectRoot?: string;
```

And return them when present:

```ts
...(cwd ? { cwd } : {}),
...(projectRoot ? { projectRoot } : {}),
```

- [ ] **Step 9: Run runtime tests**

Run:

```bash
npx tsx tests/v2/operator-task-debug-read-model.test.ts
npx tsx tests/v2/runtime-event-stream-task-filter.test.ts
```

Expected:

```text
ok
```

- [ ] **Step 10: Commit**

Run:

```bash
git add src/v2/read-models/operator-task-debug.ts src/v2/server/ui-routes.ts src/v2/server/sse.ts src/v2/server/runtime-event-stream.ts src/v2/read-models/operator-overview.ts src/v2/ui-api/postgres-run-api.ts tests/v2/operator-task-debug-read-model.test.ts tests/v2/runtime-event-stream-task-filter.test.ts
git commit -m "feat: add operator task debug runtime contracts"
```

Expected:

```text
[branch ...] feat: add operator task debug runtime contracts
```

## Task 3: Web Operator API Proxies and Data Helpers

**Files:**

- Create: `web/app/api/operator/overview/route.ts`
- Create: `web/app/api/operator/task-debug/route.ts`
- Create: `web/app/api/operator/runs/[runId]/events/stream/route.ts`
- Create: `web/lib/operator/types.ts`
- Create: `web/lib/operator/normalizers.ts`
- Create: `web/lib/operator/progress.ts`
- Create: `web/lib/operator/sse.ts`
- Test: `tests/web/southstar-web-operator-control-tower.test.tsx`

- [ ] **Step 1: Add failing web proxy and helper tests**

Append to `tests/web/southstar-web-operator-control-tower.test.tsx`:

```ts
test("web operator API proxies route to v2 runtime endpoints", () => {
  assert.match(source("web/app/api/operator/overview/route.ts"), /\\/api\\/v2\\/ui\\/operator-overview/);
  assert.match(source("web/app/api/operator/task-debug/route.ts"), /\\/api\\/v2\\/ui\\/operator-task-debug/);
  assert.match(source("web/app/api/operator/runs/[runId]/events/stream/route.ts"), /events\\/stream/);
  assert.match(source("web/app/api/operator/runs/[runId]/events/stream/route.ts"), /taskId/);
});

test("web operator helpers normalize overview and build stream urls", async () => {
  const normalizers = await import("../../web/lib/operator/normalizers.ts");
  const sse = await import("../../web/lib/operator/sse.ts");
  assert.equal(typeof normalizers.normalizeOperatorOverview, "function");
  assert.equal(typeof sse.parseSseBuffer, "function");
  assert.equal(typeof sse.operatorRuntimeEventStreamUrl, "function");

  const overview = normalizers.normalizeOperatorOverview({
    activeRuns: [{ runId: "run-a", status: "running", title: "Build", cwd: "/repo/a" }],
    attentionItems: [{ id: "attn-a", severity: "blocked", title: "Task blocked", runId: "run-a", taskId: "task-a" }],
  });
  assert.equal(overview.runs[0].runId, "run-a");
  assert.equal(overview.attentionItems[0].taskId, "task-a");
  assert.equal(
    sse.operatorRuntimeEventStreamUrl({ runId: "run-a", taskId: "task-a", after: "12" }),
    "/api/operator/runs/run-a/events/stream?closeOnTerminal=false&taskId=task-a&after=12",
  );
});
```

- [ ] **Step 2: Run the failing web helper tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
not ok
```

The failure names missing `web/app/api/operator/*` or `web/lib/operator/*`.

- [ ] **Step 3: Create the operator proxy routes**

Create `web/app/api/operator/overview/route.ts`:

```ts
import { proxyWorkflowV2Json } from "../../../../lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/ui/operator-overview");
}
```

Create `web/app/api/operator/task-debug/route.ts`:

```ts
import { proxyWorkflowV2Json } from "../../../../lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/ui/operator-task-debug");
}
```

Create `web/app/api/operator/runs/[runId]/events/stream/route.ts`:

```ts
import { buildWorkflowV2Url, workflowV2BlockedResponse } from "../../../../../../lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  try {
    const upstreamUrl = buildWorkflowV2Url(`/api/v2/runs/${encodeURIComponent(runId)}/events/stream`);
    upstreamUrl.search = request.nextUrl.search;
    const response = await fetch(upstreamUrl, {
      headers: {
        accept: "text/event-stream",
        ...(request.headers.get("last-event-id") ? { "last-event-id": request.headers.get("last-event-id")! } : {}),
      },
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type": response.headers.get("content-type") || "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
    });
  } catch {
    return workflowV2BlockedResponse();
  }
}
```

- [ ] **Step 4: Create operator types**

Create `web/lib/operator/types.ts`:

```ts
export type OperatorRun = {
  runId: string;
  status: string;
  title: string;
  domain?: string;
  cwd?: string;
  projectRoot?: string;
  updatedAt?: string;
};

export type OperatorAttentionItem = {
  id: string;
  kind?: string;
  severity: string;
  interventionMode?: string;
  title: string;
  reason?: string;
  runId?: string;
  taskId?: string;
  status?: string;
  source?: { resourceType?: string; resourceKey?: string; ref?: string };
  detail?: Record<string, unknown>;
  commands?: OperatorCommand[];
  suggestedCommandId?: string;
};

export type OperatorCommand = {
  id: string;
  label: string;
  endpoint?: string;
  method?: string;
  enabled: boolean;
  requiresConfirmation: boolean;
  disabledReason?: string;
  body?: Record<string, unknown>;
};

export type OperatorCommandResult = {
  commandId: string;
  status: string;
  accepted?: boolean;
  message?: string;
  affectedRunId?: string;
  affectedTaskId?: string;
  updatedAt?: string;
};

export type OperatorOverview = {
  runs: OperatorRun[];
  attentionItems: OperatorAttentionItem[];
  commandResults: OperatorCommandResult[];
  runtimeHealth: {
    activeRunCount: number;
    attentionCount: number;
    blockedCount: number;
  };
  defaultSelection: { runId?: string; taskId?: string; attentionItemId?: string } | null;
};

export type OperatorTaskDebug = {
  schemaVersion: "southstar.read_model.operator_task_debug.v1";
  kind: "operator-task-debug";
  data: {
    runId: string;
    task: {
      taskId: string;
      taskKey: string;
      status: string;
      sortOrder: number;
      dependsOn: string[];
      rootSessionId?: string | null;
      executorTaskId?: string | null;
      snapshot?: unknown;
      metrics?: unknown;
      updatedAt?: string;
    };
    history: OperatorHistoryItem[];
    resources: OperatorResourceItem[];
    artifacts: OperatorResourceItem[];
    actions: OperatorResourceItem[];
  };
};

export type OperatorHistoryItem = {
  sequence: number;
  eventType: string;
  actorType: string;
  sessionId?: string;
  payload: unknown;
  createdAt: string;
};

export type OperatorResourceItem = {
  resourceType: string;
  resourceKey: string;
  status: string;
  title: string;
  payload: unknown;
  summary: unknown;
  updatedAt: string;
};

export type RuntimeEventItem = {
  id: string;
  sequence?: number;
  eventType: string;
  runId?: string;
  taskId?: string;
  text: string;
  payload?: unknown;
  createdAt?: string;
};
```

- [ ] **Step 5: Create normalizers and progress helpers**

Create `web/lib/operator/normalizers.ts`:

```ts
import type { OperatorAttentionItem, OperatorCommand, OperatorCommandResult, OperatorOverview, OperatorRun } from "./types";

export function normalizeOperatorOverview(input: unknown): OperatorOverview {
  const model = unwrapEnvelope(input);
  const runs = coerceArray<any>(model?.activeRuns || model?.runs || model?.data?.runs)
    .map(readRun)
    .filter((run): run is OperatorRun => run !== null);
  const attentionItems = coerceArray<any>(model?.attentionItems || model?.items || model?.data?.attentionItems)
    .map(readAttention)
    .filter((item): item is OperatorAttentionItem => item !== null);
  const commandResults = coerceArray<any>(model?.commandResults || model?.data?.commandResults)
    .map(readCommandResult)
    .filter((item): item is OperatorCommandResult => item !== null);
  return {
    runs,
    attentionItems,
    commandResults,
    runtimeHealth: {
      activeRunCount: numberValue(model?.runtimeHealth?.activeRunCount) || runs.length,
      attentionCount: numberValue(model?.runtimeHealth?.attentionCount) || attentionItems.length,
      blockedCount: numberValue(model?.runtimeHealth?.blockedCount) || attentionItems.filter((item) => item.severity === "blocked").length,
    },
    defaultSelection: recordValue(model?.defaultSelection) as OperatorOverview["defaultSelection"] || null,
  };
}

function readRun(run: any): OperatorRun | null {
  const runId = stringValue(run?.runId || run?.id);
  if (!runId) return null;
  return {
    runId,
    status: stringValue(run?.status) || "unknown",
    title: stringValue(run?.title || run?.goalPrompt) || runId,
    ...(stringValue(run?.domain) ? { domain: stringValue(run.domain) } : {}),
    ...(stringValue(run?.cwd) ? { cwd: stringValue(run.cwd) } : {}),
    ...(stringValue(run?.projectRoot) ? { projectRoot: stringValue(run.projectRoot) } : {}),
    ...(stringValue(run?.updatedAt) ? { updatedAt: stringValue(run.updatedAt) } : {}),
  };
}

function readAttention(item: any): OperatorAttentionItem | null {
  const id = stringValue(item?.id || item?.resourceKey || item?.title);
  if (!id) return null;
  const commands = coerceArray<any>(item?.commands).map(readCommand).filter((command): command is OperatorCommand => command !== null);
  return {
    id,
    kind: stringValue(item?.kind),
    severity: stringValue(item?.severity) || "info",
    interventionMode: stringValue(item?.interventionMode),
    title: stringValue(item?.title) || "Operator attention",
    reason: stringValue(item?.reason),
    runId: stringValue(item?.runId || item?.scope?.runId),
    taskId: stringValue(item?.taskId || item?.scope?.taskId),
    status: stringValue(item?.status),
    source: recordValue(item?.source) as OperatorAttentionItem["source"],
    detail: recordValue(item?.detail),
    commands,
    suggestedCommandId: stringValue(item?.suggestedCommandId || item?.commandId),
  };
}

function readCommand(command: any): OperatorCommand | null {
  const id = stringValue(command?.id);
  if (!id) return null;
  return {
    id,
    label: stringValue(command?.label) || id,
    endpoint: stringValue(command?.endpoint),
    method: stringValue(command?.method) || "POST",
    enabled: Boolean(command?.enabled),
    requiresConfirmation: Boolean(command?.requiresConfirmation),
    disabledReason: stringValue(command?.disabledReason),
    body: recordValue(command?.body),
  };
}

function readCommandResult(result: any): OperatorCommandResult | null {
  const commandId = stringValue(result?.commandId);
  const status = stringValue(result?.status);
  if (!commandId || !status) return null;
  return {
    commandId,
    status,
    accepted: typeof result?.accepted === "boolean" ? result.accepted : undefined,
    message: stringValue(result?.message),
    affectedRunId: stringValue(result?.affectedRunId),
    affectedTaskId: stringValue(result?.affectedTaskId),
    updatedAt: stringValue(result?.updatedAt),
  };
}

function unwrapEnvelope(input: any): any {
  return input?.result || input;
}

function coerceArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
```

Create `web/lib/operator/progress.ts`:

```ts
import type { OperatorAttentionItem, OperatorRun } from "./types";

export const operatorStateBuckets = ["created", "scheduling", "running", "verifying", "blocked", "paused"] as const;
export type OperatorStateBucket = (typeof operatorStateBuckets)[number];

export function bucketForRunStatus(status: string): OperatorStateBucket {
  if (status === "created" || status === "ready" || status === "validated") return "created";
  if (status === "scheduling" || status === "queued") return "scheduling";
  if (status === "verifying" || status === "release_pending") return "verifying";
  if (status === "blocked" || status === "exception" || status === "failed" || status === "quarantined") return "blocked";
  if (status === "paused") return "paused";
  return "running";
}

export function runMatchesCwd(run: OperatorRun, cwd: string | null): boolean {
  if (!cwd) return true;
  return run.cwd === cwd || run.projectRoot === cwd || Boolean(run.cwd?.startsWith(`${cwd}/`));
}

export function attentionMatchesRuns(item: OperatorAttentionItem, runs: OperatorRun[]): boolean {
  if (!item.runId) return true;
  return runs.some((run) => run.runId === item.runId);
}
```

- [ ] **Step 6: Create SSE helpers**

Create `web/lib/operator/sse.ts`:

```ts
import type { RuntimeEventItem } from "./types";

type SseFrame = {
  id?: string;
  eventType: string;
  data: string;
};

export function operatorRuntimeEventStreamUrl(input: { runId: string; taskId?: string | null; after?: string | null; includeRunEvents?: boolean }): string {
  const params = new URLSearchParams({ closeOnTerminal: "false" });
  if (input.taskId) params.set("taskId", input.taskId);
  if (input.after) params.set("after", input.after);
  if (input.includeRunEvents === false) params.set("includeRunEvents", "false");
  return `/api/operator/runs/${encodeURIComponent(input.runId)}/events/stream?${params.toString()}`;
}

export function parseSseBuffer(buffer: string): { frames: SseFrame[]; remaining: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const remaining = parts.pop() || "";
  return {
    frames: parts.map(parseSseFrame).filter((frame): frame is SseFrame => frame !== null),
    remaining,
  };
}

export function runtimeEventFromFrame(frame: SseFrame): RuntimeEventItem | null {
  if (frame.eventType === "heartbeat") return null;
  try {
    const parsed = JSON.parse(frame.data) as Record<string, unknown>;
    const sequence = typeof parsed.sequence === "number" ? parsed.sequence : undefined;
    return {
      id: frame.id || (sequence !== undefined ? String(sequence) : `${Date.now()}`),
      sequence,
      eventType: stringValue(parsed.eventType) || frame.eventType,
      runId: stringValue(parsed.runId),
      taskId: stringValue(parsed.taskId),
      text: eventText(parsed, frame.data),
      payload: parsed.payload,
      createdAt: stringValue(parsed.createdAt),
    };
  } catch {
    return {
      id: frame.id || `${Date.now()}`,
      eventType: frame.eventType,
      text: frame.data,
    };
  }
}

function parseSseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) eventType = line.slice(6).trimStart();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0 && eventType === "message" && !id) return null;
  return { ...(id ? { id } : {}), eventType, data: dataLines.join("\n") };
}

function eventText(parsed: Record<string, unknown>, fallback: string): string {
  const payload = parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
    ? parsed.payload as Record<string, unknown>
    : {};
  return stringValue(parsed.message)
    || stringValue(parsed.summary)
    || stringValue(payload.message)
    || stringValue(payload.summary)
    || fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 7: Run web helper tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit**

Run:

```bash
git add web/app/api/operator web/lib/operator tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "feat: add web operator api helpers"
```

Expected:

```text
[branch ...] feat: add web operator api helpers
```

## Task 4: Shared Floating Sidecar

**Files:**

- Create: `web/components/SidecarShell.tsx`
- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/TabBar.tsx`
- Modify: `web/app/globals.css`
- Test: `tests/web/southstar-web-operator-control-tower.test.tsx`

- [ ] **Step 1: Add failing sidecar shell tests**

Append:

```ts
test("AppShell uses shared floating sidecar instead of mode-specific fixed file panel", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /SidecarShell/);
  assert.match(shell, /sidecarTabs/);
  assert.match(shell, /sidecarMode/);
  assert.match(shell, /openSidecarTab/);
  assert.doesNotMatch(shell, /right-panel-container\\$\\{rightPanelOpen/);
});

test("SidecarShell supports shared Files DAG History Live SSE Actions tabs", () => {
  const sidecar = source("web/components/SidecarShell.tsx");
  for (const token of ["floating", "pinned", "expanded", "hidden", "Files", "DAG", "History", "Live SSE", "Actions"]) {
    assert.match(sidecar, new RegExp(token));
  }
  assert.match(sidecar, /data-testid="sidecar-shell"/);
});
```

- [ ] **Step 2: Run the failing sidecar tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
not ok
```

The failure names missing `SidecarShell`.

- [ ] **Step 3: Expand tab kinds**

Modify `web/components/TabBar.tsx` so `Tab["kind"]` is:

```ts
kind?:
  | "file"
  | "workflowResource"
  | "workflowNodeProfile"
  | "operatorDag"
  | "operatorHistory"
  | "operatorStream"
  | "operatorActions"
  | "operatorArtifacts";
```

Add optional fields:

```ts
runId?: string;
taskId?: string;
attentionId?: string;
```

- [ ] **Step 4: Create SidecarShell**

Create `web/components/SidecarShell.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";
import { TabBar, type Tab } from "./TabBar";

export type SidecarMode = "floating" | "pinned" | "expanded" | "hidden";

export function SidecarShell({
  tabs,
  activeTabId,
  mode,
  width,
  onModeChange,
  onWidthChange,
  onSelectTab,
  onCloseTab,
  children,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  mode: SidecarMode;
  width: number;
  onModeChange: (mode: SidecarMode) => void;
  onWidthChange: (width: number) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  children: ReactNode;
}) {
  if (mode === "hidden") {
    return (
      <button
        data-testid="sidecar-reopen"
        type="button"
        title="Show sidecar"
        onClick={() => onModeChange("floating")}
        className="sidecar-reopen-button"
      >
        <PanelIcon />
      </button>
    );
  }

  const expanded = mode === "expanded";
  const sidecarWidth = expanded ? "min(960px, calc(100vw - 24px))" : `min(${width}px, calc(100vw - 24px))`;

  return (
    <aside
      data-testid="sidecar-shell"
      className={`sidecar-shell sidecar-${mode}`}
      style={{ width: sidecarWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        title="Resize sidecar"
        className="sidecar-resize-handle"
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = width;
          const move = (moveEvent: PointerEvent) => {
            onWidthChange(Math.min(Math.floor(window.innerWidth * 0.82), Math.max(320, startWidth + (startX - moveEvent.clientX))));
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
      />
      <header className="sidecar-header">
        <div className="sidecar-tabs">
          <TabBar tabs={tabs} activeTabId={activeTabId || ""} onSelectTab={onSelectTab} onCloseTab={onCloseTab} />
        </div>
        <button type="button" title="Floating" onClick={() => onModeChange("floating")} aria-pressed={mode === "floating"}>Float</button>
        <button type="button" title="Pinned" onClick={() => onModeChange("pinned")} aria-pressed={mode === "pinned"}>Pin</button>
        <button type="button" title="Expanded" onClick={() => onModeChange("expanded")} aria-pressed={mode === "expanded"}>Expand</button>
        <button type="button" title="Hide" onClick={() => onModeChange("hidden")}>Hide</button>
      </header>
      <div className="sidecar-content">
        {children}
      </div>
      <span hidden>Files DAG History Live SSE Actions</span>
    </aside>
  );
}

function PanelIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}
```

- [ ] **Step 5: Add sidecar CSS**

Append to `web/app/globals.css`:

```css
.sidecar-shell {
  position: fixed;
  top: 44px;
  right: 12px;
  bottom: 12px;
  z-index: 260;
  display: flex;
  flex-direction: column;
  min-width: 320px;
  max-width: calc(100vw - 24px);
  background: var(--bg);
  border: 1px solid var(--border);
  box-shadow: 0 18px 44px rgba(0,0,0,0.16);
  overflow: hidden;
}

.sidecar-pinned {
  top: 36px;
  right: 0;
  bottom: 0;
  border-right: 0;
  border-bottom: 0;
  box-shadow: -10px 0 28px rgba(0,0,0,0.12);
}

.sidecar-expanded {
  left: 12px;
  right: 12px;
}

.sidecar-header {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 36px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}

.sidecar-tabs {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.sidecar-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.sidecar-resize-handle {
  position: absolute;
  left: -4px;
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
}

.sidecar-reopen-button {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: var(--bg-panel);
  border: none;
  border-left: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
}
```

- [ ] **Step 6: Replace fixed right panel state in AppShell**

In `web/components/AppShell.tsx`, rename state:

```ts
const [sidecarTabs, setSidecarTabs] = useState<Tab[]>([]);
const [activeSidecarTabId, setActiveSidecarTabId] = useState<string | null>(null);
const [sidecarMode, setSidecarMode] = useState<SidecarMode>("hidden");
const [sidecarWidth, setSidecarWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
```

Add:

```ts
const openSidecarTab = useCallback((tab: Tab) => {
  setSidecarTabs((prev) => prev.find((item) => item.id === tab.id) ? prev : [...prev, tab]);
  setActiveSidecarTabId(tab.id);
  setSidecarMode((mode) => mode === "hidden" ? "floating" : mode);
}, []);
```

Update `handleOpenFile`, `handleOpenWorkflowResource`, and `handleWorkflowDagNodeSelect` to call `openSidecarTab`.

Remove the fixed `right-panel-container` block from the JSX and render:

```tsx
<SidecarShell
  tabs={sidecarTabs}
  activeTabId={activeSidecarTabId}
  mode={sidecarMode}
  width={sidecarWidth}
  onModeChange={setSidecarMode}
  onWidthChange={setSidecarWidth}
  onSelectTab={setActiveSidecarTabId}
  onCloseTab={handleCloseSidecarTab}
>
  {renderSidecarContent()}
</SidecarShell>
```

Create `renderSidecarContent()` using the current FileViewer, WorkflowResourceViewer, and WorkflowNodeProfileEditor branches.

- [ ] **Step 7: Run sidecar tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit**

Run:

```bash
git add web/components/SidecarShell.tsx web/components/AppShell.tsx web/components/TabBar.tsx web/app/globals.css tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "feat: add shared floating sidecar"
```

Expected:

```text
[branch ...] feat: add shared floating sidecar
```

## Task 5: Operator Sidebar and Center Workspace

**Files:**

- Create: `web/components/ProjectScopePicker.tsx`
- Create: `web/components/operator/OperatorSidebar.tsx`
- Create: `web/components/operator/OperatorWorkspace.tsx`
- Create: `web/components/operator/OperatorStateBoard.tsx`
- Create: `web/components/operator/OperatorWorkflowProgress.tsx`
- Create: `web/hooks/useOperatorOverview.ts`
- Modify: `web/components/AppModeRail.tsx`
- Modify: `web/components/AppShell.tsx`
- Modify: `web/app/globals.css`
- Test: `tests/web/southstar-web-operator-control-tower.test.tsx`

- [ ] **Step 1: Add failing Operator shell tests**

Append:

```ts
test("Operator mode is enabled in the live web AppModeRail", () => {
  const rail = source("web/components/AppModeRail.tsx");
  assert.doesNotMatch(rail, /disabled=\\{item\\.id === "operator"\\}/);
  assert.doesNotMatch(rail, /Operator mode is outside this implementation cycle/);
});

test("AppShell renders Operator sidebar and workspace from the live web folder", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /OperatorSidebar/);
  assert.match(shell, /OperatorWorkspace/);
  assert.match(shell, /appMode === "operator"/);
});

test("Operator sidebar keeps project scope above operator focus", () => {
  const sidebar = source("web/components/operator/OperatorSidebar.tsx");
  assert.match(sidebar, /Project Scope/);
  assert.match(sidebar, /Operator Focus/);
  assert.match(sidebar, /ProjectScopePicker/);
  assert.match(sidebar, /Attention/);
  assert.match(sidebar, /Running Workflows/);
});

test("Operator workspace includes state board and selected workflow progress with DAG toggle", () => {
  assert.match(source("web/components/operator/OperatorWorkspace.tsx"), /OperatorStateBoard/);
  assert.match(source("web/components/operator/OperatorWorkspace.tsx"), /OperatorWorkflowProgress/);
  assert.match(source("web/components/operator/OperatorWorkflowProgress.tsx"), /DAG/);
  assert.match(source("web/components/operator/OperatorWorkflowProgress.tsx"), /Progress/);
});
```

- [ ] **Step 2: Run the failing Operator shell tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
not ok
```

The failure names disabled Operator mode or missing Operator components.

- [ ] **Step 3: Create ProjectScopePicker**

Create `web/components/ProjectScopePicker.tsx` by copying the useful cwd dropdown behavior from `SessionSidebar` and keeping this public interface:

```tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { PiAgentTitle } from "./SessionSidebar";

export function ProjectScopePicker({
  selectedCwd,
  onCwdChange,
  label = "Project Scope",
}: {
  selectedCwd: string | null;
  onCwdChange: (cwd: string | null) => void;
  label?: string;
}) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [homeDir, setHomeDir] = useState("");
  const [open, setOpen] = useState(false);
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/sessions?scope=all", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { sessions?: SessionInfo[] }) => setSessions(data.sessions || []))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    fetch("/api/home").then((res) => res.json()).then((data: { home?: string }) => {
      if (data.home) setHomeDir(data.home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const recentCwds = useMemo(() => {
    const latestByCwd = new Map<string, string>();
    for (const session of sessions) {
      if (!session.cwd) continue;
      const previous = latestByCwd.get(session.cwd);
      if (!previous || session.modified > previous) latestByCwd.set(session.cwd, session.modified);
    }
    const rows = [...latestByCwd.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, 8).map(([cwd]) => cwd);
    return selectedCwd && !rows.includes(selectedCwd) ? [selectedCwd, ...rows] : rows;
  }, [sessions, selectedCwd]);

  const commitCustomPath = useCallback(async () => {
    const cwd = customPathValue.trim();
    if (!cwd) return;
    setCustomPathError(null);
    const res = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json() as { cwd?: string; error?: string };
    if (!res.ok || !data.cwd) {
      setCustomPathError(data.error || "Directory does not exist");
      return;
    }
    onCwdChange(data.cwd);
    setCustomPathValue("");
    setCustomPathOpen(false);
    setOpen(false);
  }, [customPathValue, onCwdChange]);

  return (
    <div data-testid="project-scope-picker" style={{ padding: "12px 10px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <PiAgentTitle />
        <span style={{ color: "var(--text-dim)", fontSize: 11, fontWeight: 650, textTransform: "uppercase" }}>{label}</span>
      </div>
      <div ref={ref} style={{ position: "relative" }}>
        <button type="button" onClick={() => setOpen((value) => !value)} className="project-scope-button" title={selectedCwd || ""}>
          {selectedCwd ? shortenCwd(selectedCwd, homeDir) : "Select project..."}
        </button>
        {open ? (
          <div className="project-scope-menu">
            <button type="button" onClick={() => { onCwdChange(null); setOpen(false); }} className="project-scope-menu-item">
              All projects
            </button>
            {recentCwds.map((cwd) => (
              <button key={cwd} type="button" onClick={() => { onCwdChange(cwd); setOpen(false); }} className="project-scope-menu-item" title={cwd}>
                {shortenCwd(cwd, homeDir)}
              </button>
            ))}
            {customPathOpen ? (
              <div style={{ padding: 8 }}>
                <input value={customPathValue} onChange={(event) => setCustomPathValue(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") void commitCustomPath(); }} />
                <button type="button" onClick={() => void commitCustomPath()}>Use</button>
                {customPathError ? <p className="operator-muted operator-danger">{customPathError}</p> : null}
              </div>
            ) : (
              <button type="button" onClick={() => setCustomPathOpen(true)} className="project-scope-menu-item">
                Choose path...
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function shortenCwd(cwd: string, homeDir?: string): string {
  const path = homeDir && cwd.startsWith(homeDir) ? `~${cwd.slice(homeDir.length)}` : cwd;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join("/")}`;
}
```

- [ ] **Step 4: Create useOperatorOverview**

Create `web/hooks/useOperatorOverview.ts`:

```ts
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { normalizeOperatorOverview } from "@/lib/operator/normalizers";
import { attentionMatchesRuns, runMatchesCwd } from "@/lib/operator/progress";
import type { OperatorOverview } from "@/lib/operator/types";

export function useOperatorOverview(cwd: string | null) {
  const [model, setModel] = useState<OperatorOverview>(() => ({
    runs: [],
    attentionItems: [],
    commandResults: [],
    runtimeHealth: { activeRunCount: 0, attentionCount: 0, blockedCount: 0 },
    defaultSelection: null,
  }));
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/operator/overview", { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        setModel(normalizeOperatorOverview(data));
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => controller.abort();
  }, [refreshKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return useMemo(() => {
    const runs = model.runs.filter((run) => runMatchesCwd(run, cwd));
    return {
      model: {
        ...model,
        runs,
        attentionItems: model.attentionItems.filter((item) => attentionMatchesRuns(item, runs)),
      },
      error,
      refresh,
    };
  }, [cwd, error, model, refresh]);
}
```

- [ ] **Step 5: Create OperatorSidebar**

Create `web/components/operator/OperatorSidebar.tsx` with Project Scope top block and Operator Focus lower block:

```tsx
"use client";

import { ProjectScopePicker } from "../ProjectScopePicker";
import type { OperatorAttentionItem, OperatorRun } from "@/lib/operator/types";

export function OperatorSidebar({
  cwd,
  runs,
  attentionItems,
  selectedRunId,
  selectedTaskId,
  onCwdChange,
  onSelectRun,
  onSelectAttention,
  onRefresh,
}: {
  cwd: string | null;
  runs: OperatorRun[];
  attentionItems: OperatorAttentionItem[];
  selectedRunId: string | null;
  selectedTaskId: string | null;
  onCwdChange: (cwd: string | null) => void;
  onSelectRun: (runId: string) => void;
  onSelectAttention: (item: OperatorAttentionItem) => void;
  onRefresh: () => void;
}) {
  return (
    <div data-testid="operator-sidebar" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ProjectScopePicker selectedCwd={cwd} onCwdChange={onCwdChange} label="Project Scope" />
      <section style={{ flex: "0 0 42%", minHeight: 150, overflow: "auto", borderBottom: "1px solid var(--border)" }}>
        <OperatorSectionHeader title="Operator Focus" actionLabel="Refresh" onAction={onRefresh} />
        <div style={{ padding: "0 6px 8px" }}>
          <div className="operator-section-label">Attention</div>
          {attentionItems.length === 0 ? <p className="operator-muted">No attention items.</p> : attentionItems.map((item) => (
            <button key={item.id} type="button" className="operator-list-row" aria-pressed={selectedTaskId === item.taskId} onClick={() => onSelectAttention(item)}>
              <strong>{item.severity}</strong>
              <span>{item.title}</span>
            </button>
          ))}
        </div>
      </section>
      <section style={{ flex: "1 1 0", minHeight: 0, overflow: "auto" }}>
        <div className="operator-section-label">Running Workflows</div>
        <div style={{ padding: "0 6px 8px" }}>
          {runs.length === 0 ? <p className="operator-muted">{cwd ? "No workflows for this project." : "No active workflows."}</p> : runs.map((run) => (
            <button key={run.runId} type="button" className="operator-list-row" aria-pressed={selectedRunId === run.runId} onClick={() => onSelectRun(run.runId)}>
              <strong>{run.status}</strong>
              <span>{run.title}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function OperatorSectionHeader({ title, actionLabel, onAction }: { title: string; actionLabel: string; onAction: () => void }) {
  return (
    <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 10px" }}>
      <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 650, textTransform: "uppercase" }}>{title}</span>
      <button type="button" onClick={onAction}>{actionLabel}</button>
    </header>
  );
}
```

- [ ] **Step 6: Create Operator workspace components**

Create `web/components/operator/OperatorStateBoard.tsx`:

```tsx
"use client";

import { bucketForRunStatus, operatorStateBuckets } from "@/lib/operator/progress";
import type { OperatorRun } from "@/lib/operator/types";

export function OperatorStateBoard({ runs, selectedRunId, onSelectRun }: { runs: OperatorRun[]; selectedRunId: string | null; onSelectRun: (runId: string) => void }) {
  return (
    <section data-testid="operator-state-board" className="operator-panel">
      <header className="operator-panel-header">
        <h2>Runtime State Board</h2>
      </header>
      <div className="operator-state-grid">
        {operatorStateBuckets.map((bucket) => {
          const bucketRuns = runs.filter((run) => bucketForRunStatus(run.status) === bucket);
          return (
            <div key={bucket} className="operator-state-column">
              <div className="operator-state-title">{bucket}</div>
              {bucketRuns.map((run) => (
                <button key={run.runId} type="button" className="operator-run-card" aria-pressed={selectedRunId === run.runId} onClick={() => onSelectRun(run.runId)}>
                  <strong>{run.status}</strong>
                  <span>{run.title}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

Create `web/components/operator/OperatorWorkflowProgress.tsx`:

```tsx
"use client";

import { useState } from "react";
import { SouthstarWorkflowCanvas } from "../workflow-canvas/SouthstarWorkflowCanvas";
import type { WorkflowCanvasModel } from "../workflow-canvas/types";
import type { OperatorAttentionItem, OperatorRun } from "@/lib/operator/types";

export function OperatorWorkflowProgress({
  run,
  attentionItems,
  canvas,
  selectedTaskId,
  onSelectTask,
}: {
  run: OperatorRun | null;
  attentionItems: OperatorAttentionItem[];
  canvas: WorkflowCanvasModel;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
}) {
  const [view, setView] = useState<"progress" | "dag">("progress");
  return (
    <section data-testid="operator-workflow-progress" className="operator-panel operator-progress-panel">
      <header className="operator-panel-header">
        <h2>{run?.title || "Selected Workflow"}</h2>
        <div className="operator-segmented">
          <button type="button" aria-pressed={view === "progress"} onClick={() => setView("progress")}>Progress</button>
          <button type="button" aria-pressed={view === "dag"} onClick={() => setView("dag")}>DAG</button>
        </div>
      </header>
      {view === "dag" ? (
        <SouthstarWorkflowCanvas canvas={canvas} selectedTaskId={selectedTaskId} onSelectTask={onSelectTask} />
      ) : (
        <ol className="operator-progress-list">
          {canvas.nodes.map((node) => (
            <li key={node.id}>
              <button type="button" onClick={() => onSelectTask(node.id)} aria-pressed={selectedTaskId === node.id}>
                <strong>{node.status}</strong>
                <span>{node.label}</span>
                {attentionItems.some((item) => item.taskId === node.id) ? <em>attention</em> : null}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

Create `web/components/operator/OperatorWorkspace.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { normalizeOperatorOverview } from "@/lib/operator/normalizers";
import type { OperatorAttentionItem, OperatorOverview } from "@/lib/operator/types";
import type { WorkflowCanvasModel } from "../workflow-canvas/types";
import { OperatorStateBoard } from "./OperatorStateBoard";
import { OperatorWorkflowProgress } from "./OperatorWorkflowProgress";

export function OperatorWorkspace({
  overview,
  selectedRunId,
  selectedTaskId,
  onSelectRun,
  onSelectTask,
}: {
  overview: OperatorOverview;
  selectedRunId: string | null;
  selectedTaskId: string | null;
  onSelectRun: (runId: string) => void;
  onSelectTask: (input: { runId: string; taskId: string; attention?: OperatorAttentionItem }) => void;
}) {
  const [workflowModel, setWorkflowModel] = useState<any>(null);
  const selectedRun = overview.runs.find((run) => run.runId === selectedRunId) || overview.runs[0] || null;
  const effectiveRunId = selectedRunId || selectedRun?.runId || null;

  useEffect(() => {
    if (!effectiveRunId) {
      setWorkflowModel(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/workflow/ui?runId=${encodeURIComponent(effectiveRunId)}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => setWorkflowModel(data.result || data))
      .catch(() => setWorkflowModel(null));
    return () => controller.abort();
  }, [effectiveRunId]);

  const canvas = useMemo(() => workflowCanvasFromUiModel(workflowModel, effectiveRunId), [workflowModel, effectiveRunId]);
  const attentionForRun = overview.attentionItems.filter((item) => !effectiveRunId || item.runId === effectiveRunId);

  return (
    <main data-testid="operator-workspace" className="operator-workspace">
      <OperatorStateBoard runs={overview.runs} selectedRunId={effectiveRunId} onSelectRun={onSelectRun} />
      <OperatorWorkflowProgress
        run={selectedRun}
        attentionItems={attentionForRun}
        canvas={canvas}
        selectedTaskId={selectedTaskId}
        onSelectTask={(taskId) => {
          if (effectiveRunId) onSelectTask({ runId: effectiveRunId, taskId, attention: attentionForRun.find((item) => item.taskId === taskId) });
        }}
      />
    </main>
  );
}

export function workflowCanvasFromUiModel(model: any, runId: string | null): WorkflowCanvasModel {
  const candidate = model?.canvasModel || model?.data?.canvasModel || model?.canvas || model?.data || {};
  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const edges = Array.isArray(candidate.edges) ? candidate.edges : [];
  return {
    graphId: String(candidate.graphId || runId || "operator-runtime"),
    mode: candidate.mode === "draft" ? "draft" : "runtime",
    selectedNodeId: typeof candidate.selectedNodeId === "string" ? candidate.selectedNodeId : null,
    nodes: nodes.map((node: any) => ({
      id: String(node.id),
      label: String(node.label || node.taskKey || node.id),
      kind: "task",
      status: String(node.status || "unknown"),
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn.filter((item: unknown): item is string => typeof item === "string") : [],
      roleRef: typeof node.roleRef === "string" ? node.roleRef : undefined,
      agentProfileRef: typeof node.agentProfileRef === "string" ? node.agentProfileRef : undefined,
      artifactKind: typeof node.artifactKind === "string" ? node.artifactKind : undefined,
      badges: Array.isArray(node.badges) ? node.badges : [],
      attention: node.attention || null,
    })),
    edges: edges.map((edge: any, index: number) => ({
      id: String(edge.id || `${edge.source || edge.from}->${edge.target || edge.to}-${index}`),
      source: String(edge.source || edge.from),
      target: String(edge.target || edge.to),
      status: edge.status === "ready" || edge.status === "active" || edge.status === "blocked" || edge.status === "satisfied" ? edge.status : "pending",
    })),
  };
}
```

- [ ] **Step 7: Enable Operator mode in AppModeRail**

In `web/components/AppModeRail.tsx`, remove the Operator disabled behavior:

```tsx
disabled={false}
title={item.title}
cursor: "pointer"
opacity: 1
```

Keep the existing icon and horizontal/vertical styling.

- [ ] **Step 8: Wire Operator into AppShell**

In `web/components/AppShell.tsx`, import:

```ts
import { OperatorSidebar } from "./operator/OperatorSidebar";
import { OperatorWorkspace } from "./operator/OperatorWorkspace";
import { useOperatorOverview } from "@/hooks/useOperatorOverview";
```

Add state:

```ts
const operator = useOperatorOverview(activeCwd);
const [operatorSelectedRunId, setOperatorSelectedRunId] = useState<string | null>(null);
const [operatorSelectedTaskId, setOperatorSelectedTaskId] = useState<string | null>(null);
```

Render Operator sidebar when `appMode === "operator"`:

```tsx
{appMode === "operator" ? (
  <OperatorSidebar
    cwd={activeCwd}
    runs={operator.model.runs}
    attentionItems={operator.model.attentionItems}
    selectedRunId={operatorSelectedRunId}
    selectedTaskId={operatorSelectedTaskId}
    onCwdChange={handleCwdChange}
    onSelectRun={setOperatorSelectedRunId}
    onSelectAttention={(item) => {
      if (item.runId) setOperatorSelectedRunId(item.runId);
      setOperatorSelectedTaskId(item.taskId || null);
      if (item.runId && item.taskId) openOperatorTaskSidecar({ runId: item.runId, taskId: item.taskId, attentionId: item.id });
    }}
    onRefresh={operator.refresh}
  />
) : appMode === "workflow" ? (
  <WorkflowSidebar ... />
) : (
  <SessionSidebar ... />
)}
```

Render center Operator workspace when `appMode === "operator"`:

```tsx
{appMode === "operator" ? (
  <OperatorWorkspace
    overview={operator.model}
    selectedRunId={operatorSelectedRunId}
    selectedTaskId={operatorSelectedTaskId}
    onSelectRun={setOperatorSelectedRunId}
    onSelectTask={({ runId, taskId, attention }) => {
      setOperatorSelectedRunId(runId);
      setOperatorSelectedTaskId(taskId);
      openOperatorTaskSidecar({ runId, taskId, attentionId: attention?.id });
    }}
  />
) : showChat ? (
  <ChatWindow ... />
) : ...}
```

- [ ] **Step 9: Add Operator CSS**

Append compact pi-web style classes to `web/app/globals.css`:

```css
.operator-workspace {
  height: 100%;
  min-width: 0;
  overflow: auto;
  background: var(--bg);
  padding: 10px;
}

.operator-panel {
  border: 1px solid var(--border);
  background: var(--bg);
  margin-bottom: 10px;
}

.operator-panel-header {
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.operator-panel-header h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
  color: var(--text);
}

.operator-state-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 1px;
  background: var(--border);
  overflow-x: auto;
}

.operator-state-column {
  min-height: 150px;
  background: var(--bg);
  padding: 8px;
}

.operator-state-title,
.operator-section-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  padding: 7px 10px;
}

.operator-run-card,
.operator-list-row,
.operator-progress-list button {
  width: 100%;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  padding: 7px 8px;
  cursor: pointer;
}

.operator-run-card[aria-pressed="true"],
.operator-list-row[aria-pressed="true"],
.operator-progress-list button[aria-pressed="true"] {
  background: var(--bg-selected);
  border-color: var(--border);
  color: var(--text);
}

.operator-muted {
  margin: 0;
  padding: 8px 10px;
  color: var(--text-dim);
  font-size: 12px;
}

.operator-danger {
  color: #ef4444;
}

.operator-segmented {
  display: inline-flex;
  border: 1px solid var(--border);
}

.operator-segmented button {
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  padding: 4px 8px;
  cursor: pointer;
}

.operator-segmented button:last-child {
  border-right: 0;
}

.operator-segmented button[aria-pressed="true"] {
  background: var(--bg-selected);
  color: var(--text);
}

.project-scope-button,
.project-scope-menu-item {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 8px 10px;
  cursor: pointer;
}

.project-scope-button {
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-scope-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 120;
  background: var(--bg);
  border: 1px solid var(--border);
  box-shadow: 0 6px 20px rgba(0,0,0,0.10);
}
```

- [ ] **Step 10: Run Operator shell tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 11: Commit**

Run:

```bash
git add web/components/ProjectScopePicker.tsx web/components/operator web/hooks/useOperatorOverview.ts web/components/AppModeRail.tsx web/components/AppShell.tsx web/app/globals.css tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "feat: add operator control tower workspace"
```

Expected:

```text
[branch ...] feat: add operator control tower workspace
```

## Task 6: Operator Task Sidecar Tabs

**Files:**

- Create: `web/hooks/useOperatorTaskDebug.ts`
- Create: `web/hooks/useRuntimeEventStream.ts`
- Create: `web/components/operator/OperatorTaskTabs.tsx`
- Create: `web/components/operator/OperatorHistoryPanel.tsx`
- Create: `web/components/operator/OperatorLiveStream.tsx`
- Create: `web/components/operator/OperatorActionsPanel.tsx`
- Create: `web/components/operator/OperatorArtifactsPanel.tsx`
- Modify: `web/components/AppShell.tsx`
- Test: `tests/web/southstar-web-operator-control-tower.test.tsx`

- [ ] **Step 1: Add failing task sidecar tests**

Append:

```ts
test("Operator task sidecar exposes DAG History Live SSE Actions Artifacts tabs", () => {
  const tabs = source("web/components/operator/OperatorTaskTabs.tsx");
  for (const token of ["DAG", "History", "Live SSE", "Actions", "Artifacts"]) {
    assert.match(tabs, new RegExp(token));
  }
  assert.match(source("web/components/operator/OperatorHistoryPanel.tsx"), /history/);
  assert.match(source("web/components/operator/OperatorLiveStream.tsx"), /Task stream/);
  assert.match(source("web/components/operator/OperatorLiveStream.tsx"), /Run stream/);
});

test("AppShell opens operator task tabs into the shared sidecar", () => {
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /openOperatorTaskSidecar/);
  assert.match(shell, /operatorHistory/);
  assert.match(shell, /operatorStream/);
  assert.match(shell, /operatorActions/);
  assert.match(shell, /operatorArtifacts/);
});
```

- [ ] **Step 2: Run the failing sidecar tab tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
not ok
```

The failure names missing Operator task tab files.

- [ ] **Step 3: Create task debug hook**

Create `web/hooks/useOperatorTaskDebug.ts`:

```ts
"use client";

import { useEffect, useState } from "react";
import type { OperatorTaskDebug } from "@/lib/operator/types";

export function useOperatorTaskDebug(runId: string | null, taskId: string | null) {
  const [model, setModel] = useState<OperatorTaskDebug | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId || !taskId) {
      setModel(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/operator/task-debug?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(taskId)}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((data) => {
        setModel((data.result || data) as OperatorTaskDebug);
        setError(null);
      })
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => controller.abort();
  }, [runId, taskId]);

  return { model, error };
}
```

- [ ] **Step 4: Create runtime event stream hook**

Create `web/hooks/useRuntimeEventStream.ts`:

```ts
"use client";

import { useEffect, useRef, useState } from "react";
import { operatorRuntimeEventStreamUrl, parseSseBuffer, runtimeEventFromFrame } from "@/lib/operator/sse";
import type { RuntimeEventItem } from "@/lib/operator/types";

export function useRuntimeEventStream(input: { runId: string | null; taskId?: string | null; scope: "task" | "run" }) {
  const [events, setEvents] = useState<RuntimeEventItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!input.runId) {
      setEvents([]);
      setError(null);
      return;
    }
    const streamKey = `${input.runId}:${input.scope}:${input.taskId || "all"}`;
    let closed = false;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      controller = new AbortController();
      let buffer = "";
      try {
        const response = await fetch(operatorRuntimeEventStreamUrl({
          runId: input.runId!,
          taskId: input.scope === "task" ? input.taskId : null,
          after: cursorRef.current[streamKey],
          includeRunEvents: input.scope === "task",
        }), { headers: { accept: "text/event-stream" }, signal: controller.signal });
        if (!response.ok) throw new Error(`event stream failed with ${response.status}`);
        if (!response.body) throw new Error("event stream response missing body");
        setError(null);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSseBuffer(buffer);
          buffer = parsed.remaining;
          for (const frame of parsed.frames) {
            if (frame.id) cursorRef.current[streamKey] = frame.id;
            const event = runtimeEventFromFrame(frame);
            if (event) setEvents((current) => [event, ...current].slice(0, 200));
          }
        }
      } catch (caught) {
        if (closed || controller?.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!closed) reconnectTimer = window.setTimeout(connect, 1200);
    };

    setEvents([]);
    void connect();
    return () => {
      closed = true;
      controller?.abort();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, [input.runId, input.scope, input.taskId]);

  return { events, error };
}
```

- [ ] **Step 5: Create History, Stream, Actions, and Artifacts panels**

Create `web/components/operator/OperatorHistoryPanel.tsx`:

```tsx
"use client";

import type { OperatorHistoryItem } from "@/lib/operator/types";

export function OperatorHistoryPanel({ history }: { history: OperatorHistoryItem[] }) {
  return (
    <section data-testid="operator-history-panel" className="operator-debug-panel">
      {history.length === 0 ? <p className="operator-muted">No history for this task.</p> : (
        <ol className="operator-debug-list">
          {history.map((item) => (
            <li key={item.sequence}>
              <strong>#{item.sequence} {item.eventType}</strong>
              <span>{item.actorType} · {item.createdAt}</span>
              <pre>{JSON.stringify(item.payload, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

Create `web/components/operator/OperatorLiveStream.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRuntimeEventStream } from "@/hooks/useRuntimeEventStream";

export function OperatorLiveStream({ runId, taskId }: { runId: string | null; taskId: string | null }) {
  const [scope, setScope] = useState<"task" | "run">("task");
  const { events, error } = useRuntimeEventStream({ runId, taskId, scope });
  return (
    <section data-testid="operator-live-stream" className="operator-debug-panel">
      <header className="operator-panel-header">
        <h2>{scope === "task" ? "Task stream" : "Run stream"}</h2>
        <div className="operator-segmented">
          <button type="button" aria-pressed={scope === "task"} onClick={() => setScope("task")} disabled={!taskId}>Task stream</button>
          <button type="button" aria-pressed={scope === "run"} onClick={() => setScope("run")}>Run stream</button>
        </div>
      </header>
      {error ? <p className="operator-muted operator-danger">{error}</p> : null}
      {events.length === 0 ? <p className="operator-muted">Waiting for runtime events.</p> : (
        <ol className="operator-debug-list">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.sequence ? `#${event.sequence} ` : ""}{event.eventType}</strong>
              <span>{event.taskId || "run"} · {event.createdAt || ""}</span>
              <pre>{event.text}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

Create `web/components/operator/OperatorActionsPanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";

export function OperatorActionsPanel({
  runId,
  taskId,
  commands,
  commandResults,
  onCommandComplete,
}: {
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const [reasonByCommand, setReasonByCommand] = useState<Record<string, string>>({});
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);

  async function invoke(command: OperatorCommand) {
    if (!command.endpoint || !command.enabled) return;
    const reason = (reasonByCommand[command.id] || "").trim();
    if (command.requiresConfirmation && !reason) return;
    if (command.requiresConfirmation && !window.confirm(`Run ${command.label} with reason "${reason}"?`)) return;
    setPendingCommandId(command.id);
    try {
      await fetch(command.endpoint, {
        method: command.method || "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(command.body || {}),
          runId,
          taskId,
          commandId: `ui:${command.id}:${Date.now()}:${crypto.randomUUID()}`,
          actor: { type: "user", id: "operator-ui" },
          ...(reason ? { reason } : {}),
        }),
      });
      onCommandComplete();
    } finally {
      setPendingCommandId(null);
    }
  }

  return (
    <section data-testid="operator-actions-panel" className="operator-debug-panel">
      {commands.length === 0 ? <p className="operator-muted">No actions available for this target.</p> : commands.map((command) => (
        <div key={command.id} className="operator-action-row">
          {command.requiresConfirmation ? (
            <input value={reasonByCommand[command.id] || ""} onChange={(event) => setReasonByCommand((current) => ({ ...current, [command.id]: event.currentTarget.value }))} />
          ) : null}
          <button type="button" disabled={!command.enabled || pendingCommandId === command.id || (command.requiresConfirmation && !(reasonByCommand[command.id] || "").trim())} onClick={() => void invoke(command)}>
            {pendingCommandId === command.id ? `Pending ${command.label}` : command.label}
          </button>
          {!command.enabled && command.disabledReason ? <p className="operator-muted">{command.disabledReason}</p> : null}
        </div>
      ))}
      {commandResults.slice(0, 6).map((result) => (
        <p key={`${result.commandId}:${result.updatedAt || result.status}`} className="operator-muted">{result.status} · {result.commandId} {result.message || ""}</p>
      ))}
    </section>
  );
}
```

Create `web/components/operator/OperatorArtifactsPanel.tsx`:

```tsx
"use client";

import type { OperatorResourceItem } from "@/lib/operator/types";

export function OperatorArtifactsPanel({ artifacts, resources }: { artifacts: OperatorResourceItem[]; resources: OperatorResourceItem[] }) {
  const rows = artifacts.length > 0 ? artifacts : resources;
  return (
    <section data-testid="operator-artifacts-panel" className="operator-debug-panel">
      {rows.length === 0 ? <p className="operator-muted">No artifacts or task resources.</p> : (
        <ol className="operator-debug-list">
          {rows.map((item) => (
            <li key={`${item.resourceType}:${item.resourceKey}`}>
              <strong>{item.resourceType} · {item.status}</strong>
              <span>{item.title}</span>
              <pre>{JSON.stringify({ summary: item.summary, payload: item.payload }, null, 2)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Create OperatorTaskTabs**

Create `web/components/operator/OperatorTaskTabs.tsx`:

```tsx
"use client";

import { useOperatorTaskDebug } from "@/hooks/useOperatorTaskDebug";
import type { OperatorCommand, OperatorCommandResult } from "@/lib/operator/types";
import { OperatorActionsPanel } from "./OperatorActionsPanel";
import { OperatorArtifactsPanel } from "./OperatorArtifactsPanel";
import { OperatorHistoryPanel } from "./OperatorHistoryPanel";
import { OperatorLiveStream } from "./OperatorLiveStream";

export function OperatorTaskTabs({
  kind,
  runId,
  taskId,
  commands,
  commandResults,
  onCommandComplete,
}: {
  kind: "operatorDag" | "operatorHistory" | "operatorStream" | "operatorActions" | "operatorArtifacts";
  runId: string | null;
  taskId: string | null;
  commands: OperatorCommand[];
  commandResults: OperatorCommandResult[];
  onCommandComplete: () => void;
}) {
  const debug = useOperatorTaskDebug(runId, taskId);
  if (!runId || !taskId) return <p className="operator-muted">Select a task to inspect DAG, History, Live SSE, Actions, and Artifacts.</p>;
  if (debug.error) return <p className="operator-muted operator-danger">{debug.error}</p>;
  if (!debug.model) return <p className="operator-muted">Loading task debug data.</p>;

  if (kind === "operatorHistory") return <OperatorHistoryPanel history={debug.model.data.history} />;
  if (kind === "operatorStream") return <OperatorLiveStream runId={runId} taskId={taskId} />;
  if (kind === "operatorActions") return <OperatorActionsPanel runId={runId} taskId={taskId} commands={commands} commandResults={commandResults} onCommandComplete={onCommandComplete} />;
  if (kind === "operatorArtifacts") return <OperatorArtifactsPanel artifacts={debug.model.data.artifacts} resources={debug.model.data.resources} />;

  return (
    <section className="operator-debug-panel">
      <header className="operator-panel-header"><h2>DAG</h2></header>
      <p className="operator-muted">DAG task selected: {debug.model.data.task.taskKey}</p>
      <pre>{JSON.stringify(debug.model.data.task, null, 2)}</pre>
      <span hidden>DAG History Live SSE Actions Artifacts</span>
    </section>
  );
}
```

- [ ] **Step 7: Open task tabs from AppShell**

In `web/components/AppShell.tsx`, add:

```ts
const openOperatorTaskSidecar = useCallback((input: { runId: string; taskId: string; attentionId?: string }) => {
  const prefix = `operator:${input.runId}:${input.taskId}`;
  const tabs: Tab[] = [
    { id: `${prefix}:dag`, label: "DAG", filePath: input.taskId, kind: "operatorDag", runId: input.runId, taskId: input.taskId, attentionId: input.attentionId },
    { id: `${prefix}:history`, label: "History", filePath: input.taskId, kind: "operatorHistory", runId: input.runId, taskId: input.taskId, attentionId: input.attentionId },
    { id: `${prefix}:stream`, label: "Live SSE", filePath: input.taskId, kind: "operatorStream", runId: input.runId, taskId: input.taskId, attentionId: input.attentionId },
    { id: `${prefix}:actions`, label: "Actions", filePath: input.taskId, kind: "operatorActions", runId: input.runId, taskId: input.taskId, attentionId: input.attentionId },
    { id: `${prefix}:artifacts`, label: "Artifacts", filePath: input.taskId, kind: "operatorArtifacts", runId: input.runId, taskId: input.taskId, attentionId: input.attentionId },
  ];
  setSidecarTabs((current) => {
    const byId = new Map(current.map((tab) => [tab.id, tab]));
    for (const tab of tabs) byId.set(tab.id, byId.get(tab.id) || tab);
    return [...byId.values()];
  });
  setActiveSidecarTabId(`${prefix}:history`);
  setSidecarMode((mode) => mode === "hidden" ? "floating" : mode);
}, []);
```

In `renderSidecarContent`, add:

```tsx
if (activeSidecarTab?.kind?.startsWith("operator")) {
  return (
    <OperatorTaskTabs
      kind={activeSidecarTab.kind}
      runId={activeSidecarTab.runId || null}
      taskId={activeSidecarTab.taskId || null}
      commands={operator.model.attentionItems.find((item) => item.id === activeSidecarTab.attentionId)?.commands || []}
      commandResults={operator.model.commandResults}
      onCommandComplete={operator.refresh}
    />
  );
}
```

- [ ] **Step 8: Add debug panel CSS**

Append:

```css
.operator-debug-panel {
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--bg);
}

.operator-debug-list {
  margin: 0;
  padding: 8px;
  list-style: none;
}

.operator-debug-list li {
  border-bottom: 1px solid var(--border);
  padding: 8px 2px;
}

.operator-debug-list strong,
.operator-debug-list span {
  display: block;
  font-size: 12px;
}

.operator-debug-list span {
  color: var(--text-dim);
  margin-top: 2px;
}

.operator-debug-list pre,
.operator-debug-panel pre {
  margin: 6px 0 0;
  padding: 8px;
  overflow: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.operator-action-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) max-content;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
```

- [ ] **Step 9: Run task sidecar tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 10: Commit**

Run:

```bash
git add web/hooks/useOperatorTaskDebug.ts web/hooks/useRuntimeEventStream.ts web/components/operator/OperatorTaskTabs.tsx web/components/operator/OperatorHistoryPanel.tsx web/components/operator/OperatorLiveStream.tsx web/components/operator/OperatorActionsPanel.tsx web/components/operator/OperatorArtifactsPanel.tsx web/components/AppShell.tsx web/app/globals.css tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "feat: add operator task debug sidecar tabs"
```

Expected:

```text
[branch ...] feat: add operator task debug sidecar tabs
```

## Task 7: Verification and Browser Smoke

**Files:**

- Modify only files touched by prior tasks when fixes are needed.

- [ ] **Step 1: Run targeted runtime tests**

Run:

```bash
npx tsx tests/v2/operator-task-debug-read-model.test.ts
npx tsx tests/v2/runtime-event-stream-task-filter.test.ts
```

Expected:

```text
ok
```

- [ ] **Step 2: Run targeted web tests**

Run:

```bash
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected:

```text
ok
```

- [ ] **Step 3: Run web lint**

Run:

```bash
npm --prefix web run lint
```

Expected:

```text
No ESLint warnings or errors
```

If ESLint prints a different success summary, accept it if the exit code is `0`.

- [ ] **Step 4: Run web build**

Run:

```bash
npm --prefix web run build
```

Expected:

```text
Compiled successfully
```

- [ ] **Step 5: Confirm the live port**

Run:

```bash
curl -I http://127.0.0.1:30141
```

Expected:

```text
HTTP/1.1 200 OK
```

- [ ] **Step 6: Browser smoke the live UI**

Use Playwright or the browser skill against `http://127.0.0.1:30141` and verify:

```text
1. Chat tab still opens existing chat UI.
2. Workflow tab still renders workflow sidebar and workflow DAG blocks.
3. Operator tab is clickable.
4. Operator left sidebar shows Project Scope above Operator Focus.
5. Runtime State Board is visible in the center.
6. Selecting a task opens the shared sidecar.
7. Sidecar tabs include DAG, History, Live SSE, Actions, and Artifacts.
8. Live SSE can switch between Task stream and Run stream.
9. Floating, pinned, expanded, and hidden sidecar modes do not overlap the top bar.
```

- [ ] **Step 7: Run the main non-live test gate**

Run:

```bash
npm test
```

Expected:

```text
ok
```

- [ ] **Step 8: Commit verification fixes**

If any verification fixes were required, run:

```bash
git add web src tests
git commit -m "fix: stabilize operator control tower verification"
```

Expected when fixes exist:

```text
[branch ...] fix: stabilize operator control tower verification
```

If no verification fixes were required, do not create an empty commit.

## Acceptance Checklist

- [ ] `http://127.0.0.1:30141` remains the active UI.
- [ ] Chat panel remains web-native and keeps existing behavior.
- [ ] Workflow panel no longer imports root-level `components/southstar/workflow-canvas`.
- [ ] Useful old workflow canvas code is copied into `web/components/workflow-canvas/`.
- [ ] Useful old operator code is copied into `web/components/operator/` and `web/lib/operator/`.
- [ ] Operator tab is enabled.
- [ ] Left Operator sidebar has two blocks: Project Scope and Operator Focus.
- [ ] Project Scope preserves repo/cwd selection and filters runs by repo when run metadata includes `cwd` or `projectRoot`.
- [ ] Center top state board groups by runtime states.
- [ ] Center lower view defaults to progress and can toggle to DAG.
- [ ] Clicking an attention item or task opens the shared sidecar.
- [ ] Shared sidecar works across Chat, Workflow, and Operator file/resource/task tabs.
- [ ] Sidecar supports floating, pinned, expanded, and hidden modes.
- [ ] Task sidecar shows durable History.
- [ ] Task sidecar shows Live SSE with Task stream and Run stream.
- [ ] Task sidecar shows Actions with reason-confirmed commands.
- [ ] Task sidecar shows Artifacts/resources.
- [ ] No active `web/` UI file imports retired root-level UI folders.

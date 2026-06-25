# Southstar UI Read-Model Runtime Contract Adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Southstar ready for the redesigned UI by stabilizing read-model contracts, surfacing dispatch-prep failures, documenting the current layered schema, and containing software/Tork/Pi defaults behind explicit boundaries.

**Architecture:** Keep the existing Postgres runtime and API shape. Add a small UI read-model contract layer on top of existing builders, introduce contract tests for command affordances and route alignment, observe scheduler preparation failures as runtime exceptions, then move hardcoded software/Tork/Pi assumptions toward registry/config/manifest authority without breaking existing E2E fixtures.

**Tech Stack:** TypeScript, Node test runner, Postgres-backed Southstar v2 runtime, existing `src/v2/server/*` route handlers, existing `src/v2/read-models/*`, existing `tests/v2/*` and `tests/e2e-postgres/*` patterns.

---

## File Structure

Create:

- `src/v2/read-models/ui-envelope.ts`  
  Shared UI read-model envelope, command affordance, attention item, source ref, and warning helpers.
- `src/v2/read-models/ui-surfaces.ts`  
  Builders for `run-control`, `workflow-dag`, `recovery-center`, `execution-center`, `planner-workbench`, `domain-pack-governance`, and compatibility aliases where useful.
- `src/v2/recovery/policy.ts`  
  Recovery policy types plus fallback policy matcher that can wrap current path names with policy evidence.
- `src/v2/scheduler/dispatch-preparation-exception.ts`  
  Small helper that maps dispatch preparation phases and redacted errors into runtime observations.
- `tests/v2/ui-read-model-contract.test.ts`  
  Unit/API tests for envelope shape, command affordances, disabled reasons, source refs, and route alignment.
- `tests/v2/dispatch-preparation-exception.test.ts`  
  Unit test for scheduler prep failure observation.
- `tests/v2/hardcode-boundaries.test.ts`  
  Static gate for software pack imports and fixture-only defaults.
- `docs/superpowers/southstar-current-postgres-state-model.md`  
  Short current-state schema document used by UI and runtime workers.

Modify:

- `src/v2/read-models/types.ts`  
  Add UI-facing read-model kinds while preserving existing kinds.
- `src/v2/read-models/postgres-core.ts`  
  Delegate new UI-facing kinds to `ui-surfaces.ts`; keep existing core read models.
- `src/v2/ui-api/read-models.ts`  
  Remove exports of non-existent files; export existing builders or mark as a compatibility shim.
- `src/v2/server/routes.ts`  
  Route new read-model kinds and keep existing aliases.
- `src/v2/server/client.ts`  
  Add client methods for new read-model kinds and command routes if missing.
- `src/v2/scheduler/runnable-task-scheduler.ts`  
  Observe dispatch preparation failures before release/rethrow.
- `src/v2/exceptions/types.ts`  
  Add `dispatch_preparation_failed` exception payload kind and policy evidence fields if currently absent.
- `src/v2/exceptions/runtime-exception-controller.ts`  
  Add policy matcher call while retaining old classifier compatibility.
- `src/v2/exceptions/recovery-decision-applier.ts`  
  Preserve existing path behavior; accept and persist policy-backed action evidence without requiring full typed action execution in this pass.
- `src/v2/manifests/types.ts`  
  Loosen manifest typing enough that Tork/software are not the only type-level options, while keeping existing manifests valid.
- `src/v2/context/managed-context-assembler.ts`  
  Replace direct software fallback with explicit registry/config input or fail-closed message.
- `src/v2/ui-api/postgres-run-api.ts`  
  Keep compatibility, but make software default explicit and traceable as config/fixture default.
- `src/v2/ui-api/postgres-task-envelope.ts`  
  Keep compatibility, but make software fallback explicit and traceable.
- `src/v2/evolution/sandbox.ts`  
  Fence software pack usage behind explicit input/default config.
- `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md`  
  Add a note that older `runtime_status` / `workflow_state` table wording is superseded by the current layered Postgres model.
- `tests/v2/runtime-api-client-alignment.test.ts`  
  Add new read-model route/client coverage.
- `tests/v2/runnable-task-scheduler.test.ts`  
  Add prep failure behavior tests.
- `tests/v2/runtime-exceptions.test.ts`  
  Add exception payload/policy evidence tests.

---

### Task 1: Read-Model Shim Safety

**Files:**
- Modify: `src/v2/ui-api/read-models.ts`
- Test: `tests/v2/ui-read-model-contract.test.ts`

- [ ] **Step 1: Write failing test for compatibility shim exports**

Add this test file if it does not exist:

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("ui-api read-model compatibility shim imports without missing modules", async () => {
  const module = await import("../../src/v2/ui-api/read-models.ts");
  assert.equal(typeof module.buildWorkflowCanvasModel, "function");
  assert.equal(typeof module.buildRuntimeMonitorModel, "function");
  assert.equal(typeof module.buildTaskDetailModel, "function");
  assert.equal(typeof module.buildSessionsMemoryModel, "function");
  assert.equal(typeof module.buildExecutorOpsModel, "function");
});
```

- [ ] **Step 2: Run test and verify current failure**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts
```

Expected before implementation: FAIL with module resolution error for one of `../read-models/workflow-canvas.ts`, `runtime-monitor.ts`, `task-detail.ts`, `sessions-memory.ts`, `vault-mcp.ts`, or `executor-ops.ts`.

- [ ] **Step 3: Replace missing-file exports with existing builder wrappers**

Edit `src/v2/ui-api/read-models.ts` to use `buildPostgresCoreReadModel` instead of non-existent files:

```ts
// Deprecated compatibility shim. New code should call /api/v2/read-models/* or import from src/v2/read-models/*.
import type { SouthstarDb } from "../db/postgres.ts";
import { buildPostgresCoreReadModel } from "../read-models/postgres-core.ts";

export async function buildWorkflowCanvasModel(db: SouthstarDb, input: { runId: string; taskId?: string }) {
  return await buildPostgresCoreReadModel(db, { kind: "workflow-canvas", runId: input.runId, taskId: input.taskId });
}

export async function buildRuntimeMonitorModel(db: SouthstarDb, input: { runId: string }) {
  return await buildPostgresCoreReadModel(db, { kind: "runtime-monitor", runId: input.runId });
}

export async function buildTaskDetailModel(db: SouthstarDb, input: { runId: string; taskId: string }) {
  return await buildPostgresCoreReadModel(db, { kind: "task-detail", runId: input.runId, taskId: input.taskId });
}

export async function buildSessionsMemoryModel(db: SouthstarDb, input: { runId: string }) {
  return await buildPostgresCoreReadModel(db, { kind: "sessions-memory", runId: input.runId });
}

export async function buildVaultMcpModel(db: SouthstarDb, input: { runId: string }) {
  return await buildPostgresCoreReadModel(db, { kind: "vault-mcp", runId: input.runId });
}

export async function buildExecutorOpsModel(db: SouthstarDb, input: { runId: string }) {
  return await buildPostgresCoreReadModel(db, { kind: "executor-ops", runId: input.runId });
}

export const sessionGraphResources: string[] = ["session", "memory_item", "memory_delta", "rollback_marker"];
```

- [ ] **Step 4: Verify test passes**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts
```

Expected: PASS for shim import test.

- [ ] **Step 5: Commit**

```bash
git add src/v2/ui-api/read-models.ts tests/v2/ui-read-model-contract.test.ts
git commit -m "fix: stabilize read model compatibility shim"
```

---

### Task 2: Shared UI Read-Model Envelope

**Files:**
- Create: `src/v2/read-models/ui-envelope.ts`
- Modify: `src/v2/read-models/types.ts`
- Test: `tests/v2/ui-read-model-contract.test.ts`

- [ ] **Step 1: Add failing tests for envelope shape and disabled command reason**

Append to `tests/v2/ui-read-model-contract.test.ts`:

```ts
import { createUiReadModelEnvelope, uiCommand } from "../../src/v2/read-models/ui-envelope.ts";

test("ui read-model envelope includes required UI contract fields", () => {
  const envelope = createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.run_control.v1",
    kind: "run-control",
    scope: { runId: "run-ui-contract" },
    data: { runId: "run-ui-contract", status: "running" },
    commands: [
      uiCommand({
        id: "pause-run",
        label: "Pause",
        endpoint: "/api/v2/runs/run-ui-contract/pause",
        method: "POST",
        enabled: true,
      }),
    ],
    attentionItems: [],
    sourceRefs: [{ id: "run", kind: "table-row", ref: "southstar.workflow_runs:run-ui-contract" }],
    warnings: [],
    now: "2026-06-25T00:00:00.000Z",
  });

  assert.equal(envelope.schemaVersion, "southstar.read_model.run_control.v1");
  assert.equal(envelope.kind, "run-control");
  assert.equal(envelope.generatedAt, "2026-06-25T00:00:00.000Z");
  assert.equal(envelope.commands[0]?.dangerLevel, "none");
  assert.equal(envelope.commands[0]?.requiresConfirmation, false);
});

test("disabled ui command must include disabledReason", () => {
  assert.throws(
    () => uiCommand({
      id: "resume-run",
      label: "Resume",
      endpoint: "/api/v2/runs/run-ui-contract/resume",
      method: "POST",
      enabled: false,
    }),
    /disabledReason is required/,
  );
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts
```

Expected before implementation: FAIL with `Cannot find module '../../src/v2/read-models/ui-envelope.ts'`.

- [ ] **Step 3: Implement shared envelope helper**

Create `src/v2/read-models/ui-envelope.ts`:

```ts
export type UiReadModelScope = {
  runId?: string;
  taskId?: string;
  workItemId?: string;
  domain?: string;
};

export type UiCommandAffordance = {
  id: string;
  label: string;
  endpoint: string;
  method: "POST" | "PATCH" | "DELETE";
  bodySchemaRef?: string;
  enabled: boolean;
  disabledReason?: string;
  idempotencyKeyHint?: string;
  dangerLevel: "none" | "low" | "medium" | "high";
  requiresConfirmation: boolean;
};

export type UiAttentionItem = {
  id: string;
  severity: "info" | "warning" | "error" | "blocked";
  title: string;
  reason: string;
  sourceRefs: string[];
  suggestedCommandIds: string[];
};

export type UiSourceRef = {
  id: string;
  kind: "table-row" | "history-event" | "runtime-resource" | "manifest-ref" | "library-object";
  ref: string;
};

export type UiWarning = {
  code: string;
  message: string;
  sourceRefs: string[];
};

export type UiReadModelEnvelope<TData> = {
  schemaVersion: string;
  kind: string;
  scope: UiReadModelScope;
  data: TData;
  commands: UiCommandAffordance[];
  attentionItems: UiAttentionItem[];
  sourceRefs: UiSourceRef[];
  warnings: UiWarning[];
  generatedAt: string;
};

export function uiCommand(input: Omit<UiCommandAffordance, "dangerLevel" | "requiresConfirmation"> & Partial<Pick<UiCommandAffordance, "dangerLevel" | "requiresConfirmation">>): UiCommandAffordance {
  if (!input.enabled && !input.disabledReason) {
    throw new Error(`disabledReason is required for disabled command ${input.id}`);
  }
  return {
    ...input,
    dangerLevel: input.dangerLevel ?? "none",
    requiresConfirmation: input.requiresConfirmation ?? false,
  };
}

export function createUiReadModelEnvelope<TData>(input: {
  schemaVersion: string;
  kind: string;
  scope: UiReadModelScope;
  data: TData;
  commands: UiCommandAffordance[];
  attentionItems: UiAttentionItem[];
  sourceRefs: UiSourceRef[];
  warnings: UiWarning[];
  now?: string;
}): UiReadModelEnvelope<TData> {
  return {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    scope: input.scope,
    data: input.data,
    commands: input.commands,
    attentionItems: input.attentionItems,
    sourceRefs: input.sourceRefs,
    warnings: input.warnings,
    generatedAt: input.now ?? new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Add new read-model kinds**

Modify `src/v2/read-models/types.ts` so `ReadModelKind` includes:

```ts
export type ReadModelKind =
  | "run-inspection"
  | "run-summary"
  | "executions"
  | "exceptions"
  | "runtime-monitor"
  | "workflow-canvas"
  | "executor-ops"
  | "task-detail"
  | "sessions-memory"
  | "vault-mcp"
  | "evolution-control-center"
  | "run-control"
  | "workflow-dag"
  | "recovery-center"
  | "execution-center"
  | "planner-workbench"
  | "domain-pack-governance"
  | "evolution-center";
```

- [ ] **Step 5: Verify tests pass**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts
```

Expected: PASS for shim and envelope tests.

- [ ] **Step 6: Commit**

```bash
git add src/v2/read-models/ui-envelope.ts src/v2/read-models/types.ts tests/v2/ui-read-model-contract.test.ts
git commit -m "feat: add ui read model envelope contract"
```

---

### Task 3: Run-Control and Workflow-DAG Read Models

**Files:**
- Create: `src/v2/read-models/ui-surfaces.ts`
- Modify: `src/v2/read-models/postgres-core.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/ui-read-model-contract.test.ts`
- Test: `tests/v2/runtime-api-client-alignment.test.ts`

- [ ] **Step 1: Add failing tests for `run-control` and `workflow-dag`**

Append to `tests/v2/ui-read-model-contract.test.ts`, following the existing test DB setup pattern in nearby read-model tests:

```ts
import { createTestPostgresDb } from "./helpers/postgres-test-db.ts";
import { buildUiSurfaceReadModel } from "../../src/v2/read-models/ui-surfaces.ts";

test("run-control read model exposes run commands and attention items", async () => {
  const db = await createTestPostgresDb("ui_run_control");
  await db.query(`
    insert into southstar.workflow_runs (id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json, snapshot_json, runtime_context_json, metrics_json)
    values ('run-ui-control', 'running', 'software', 'ui contract', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `);
  await db.query(`
    insert into southstar.workflow_tasks (id, run_id, task_key, status, sort_order, depends_on_json, subagent_session_ids_json, snapshot_json, metrics_json)
    values ('task-a', 'run-ui-control', 'task-a', 'pending', 1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `);

  const model = await buildUiSurfaceReadModel(db, { kind: "run-control", runId: "run-ui-control" });

  assert.equal(model.kind, "run-control");
  assert.equal(model.schemaVersion, "southstar.read_model.run_control.v1");
  assert.equal(model.data.runId, "run-ui-control");
  assert.equal(model.data.taskCounts.pending, 1);
  assert.ok(model.commands.some((command) => command.id === "pause-run" && command.enabled));
  assert.ok(model.sourceRefs.some((ref) => ref.ref === "southstar.workflow_runs:run-ui-control"));
});

test("workflow-dag read model exposes dependency readiness", async () => {
  const db = await createTestPostgresDb("ui_workflow_dag");
  await db.query(`
    insert into southstar.workflow_runs (id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json, snapshot_json, runtime_context_json, metrics_json)
    values ('run-ui-dag', 'running', 'software', 'ui dag', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `);
  await db.query(`
    insert into southstar.workflow_tasks (id, run_id, task_key, status, sort_order, depends_on_json, subagent_session_ids_json, snapshot_json, metrics_json)
    values
      ('task-a', 'run-ui-dag', 'task-a', 'completed', 1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb),
      ('task-b', 'run-ui-dag', 'task-b', 'pending', 2, '["task-a"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `);
  await db.query(`
    insert into southstar.runtime_resources (id, resource_type, resource_key, run_id, task_id, scope, status, payload_json, summary_json)
    values ('artifact-task-a', 'artifact_ref', 'artifact_ref:run-ui-dag:task-a:attempt-1:hash', 'run-ui-dag', 'task-a', 'artifact', 'accepted', '{}'::jsonb, '{}'::jsonb)
  `);

  const model = await buildUiSurfaceReadModel(db, { kind: "workflow-dag", runId: "run-ui-dag" });

  assert.equal(model.kind, "workflow-dag");
  assert.equal(model.data.nodes.length, 2);
  assert.equal(model.data.nodes.find((node) => node.id === "task-b")?.dependencyReady, true);
});
```

If `createTestPostgresDb` has a different helper name in this repository, use the helper already used by `tests/v2/postgres-core-read-models-api.test.ts` and keep the inserted rows unchanged.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts
```

Expected before implementation: FAIL with missing `ui-surfaces.ts` or unsupported read-model kind.

- [ ] **Step 3: Implement `run-control` and `workflow-dag` builders**

Create `src/v2/read-models/ui-surfaces.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
import { listUnresolvedRuntimeExceptionsPg } from "../exceptions/postgres-runtime-exceptions.ts";
import type { ReadModelInput } from "./types.ts";
import { createUiReadModelEnvelope, uiCommand, type UiAttentionItem } from "./ui-envelope.ts";

type TaskRow = {
  id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: unknown;
};

export async function buildUiSurfaceReadModel(db: SouthstarDb, input: ReadModelInput) {
  switch (input.kind) {
    case "run-control":
      return await buildRunControl(db, input.runId);
    case "workflow-dag":
      return await buildWorkflowDag(db, input.runId);
    default:
      throw new Error(`unsupported UI surface read model: ${input.kind}`);
  }
}

export function isUiSurfaceReadModelKind(kind: string): boolean {
  return kind === "run-control" || kind === "workflow-dag";
}

async function buildRunControl(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string; domain: string; goal_prompt: string }>(
    "select id, status, domain, goal_prompt from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!run) throw new Error(`run not found: ${runId}`);

  const counts = await db.query<{ status: string; count: string | number }>(
    "select status, count(*) as count from southstar.workflow_tasks where run_id = $1 group by status order by status",
    [runId],
  );
  const exceptions = await listUnresolvedRuntimeExceptionsPg(db, { runId });
  const taskCounts = Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)]));
  const attentionItems: UiAttentionItem[] = exceptions.map((exception) => ({
    id: `exception:${exception.resourceKey}`,
    severity: "blocked",
    title: "Unresolved runtime exception",
    reason: `${exception.payload.kind} is unresolved`,
    sourceRefs: [`runtime-resource:${exception.resourceKey}`],
    suggestedCommandIds: ["open-recovery-center"],
  }));

  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.run_control.v1",
    kind: "run-control",
    scope: { runId, domain: run.domain },
    data: {
      runId,
      status: run.status,
      rawStatus: run.status,
      domain: run.domain,
      goalPrompt: run.goal_prompt,
      taskCounts,
      unresolvedExceptionCount: exceptions.length,
    },
    commands: [
      uiCommand({
        id: "execute-run",
        label: "Execute",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/execute`,
        method: "POST",
        enabled: run.status === "created" || run.status === "validated" || run.status === "ready",
        disabledReason: run.status === "created" || run.status === "validated" || run.status === "ready" ? undefined : `run status is ${run.status}`,
      }),
      uiCommand({
        id: "pause-run",
        label: "Pause",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/pause`,
        method: "POST",
        enabled: run.status === "running" || run.status === "scheduling",
        disabledReason: run.status === "running" || run.status === "scheduling" ? undefined : `run status is ${run.status}`,
      }),
      uiCommand({
        id: "resume-run",
        label: "Resume",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/resume`,
        method: "POST",
        enabled: run.status === "paused",
        disabledReason: run.status === "paused" ? undefined : `run status is ${run.status}`,
      }),
      uiCommand({
        id: "cancel-run",
        label: "Cancel",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/cancel`,
        method: "POST",
        enabled: !["passed", "failed", "cancelled"].includes(run.status),
        disabledReason: !["passed", "failed", "cancelled"].includes(run.status) ? undefined : `run status is terminal: ${run.status}`,
        dangerLevel: "medium",
        requiresConfirmation: true,
      }),
    ],
    attentionItems,
    sourceRefs: [{ id: "run", kind: "table-row", ref: `southstar.workflow_runs:${runId}` }],
    warnings: [],
  });
}

async function buildWorkflowDag(db: SouthstarDb, runId: string) {
  const run = await db.maybeOne<{ id: string; status: string }>("select id, status from southstar.workflow_runs where id = $1", [runId]);
  if (!run) throw new Error(`run not found: ${runId}`);

  const tasks = (await db.query<TaskRow>(
    "select id, task_key, status, sort_order, depends_on_json from southstar.workflow_tasks where run_id = $1 order by sort_order, id",
    [runId],
  )).rows;
  const acceptedArtifacts = await acceptedArtifactTaskIdsForRunPg(db, runId);

  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.workflow_dag.v1",
    kind: "workflow-dag",
    scope: { runId },
    data: {
      runId,
      status: run.status,
      nodes: tasks.map((task) => {
        const dependsOn = stringArray(task.depends_on_json);
        return {
          id: task.id,
          label: task.task_key,
          status: task.status,
          sortOrder: task.sort_order,
          dependsOn,
          dependencyReady: dependsOn.every((dependency) => acceptedArtifacts.has(dependency)),
          acceptedArtifact: acceptedArtifacts.has(task.id),
        };
      }),
      edges: tasks.flatMap((task) => stringArray(task.depends_on_json).map((source) => ({ source, target: task.id }))),
    },
    commands: [],
    attentionItems: [],
    sourceRefs: [
      { id: "run", kind: "table-row", ref: `southstar.workflow_runs:${runId}` },
      { id: "tasks", kind: "table-row", ref: `southstar.workflow_tasks:run_id=${runId}` },
    ],
    warnings: [],
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
```

- [ ] **Step 4: Wire builders into `postgres-core.ts`**

Modify `src/v2/read-models/postgres-core.ts`:

```ts
import { buildUiSurfaceReadModel, isUiSurfaceReadModelKind } from "./ui-surfaces.ts";
```

At the top of `buildPostgresCoreReadModel`, before the existing switch:

```ts
  if (isUiSurfaceReadModelKind(input.kind)) return await buildUiSurfaceReadModel(db, input);
```

Update `isPostgresCoreReadModelKind`:

```ts
export function isPostgresCoreReadModelKind(kind: ReadModelKind): boolean {
  return [
    "run-summary",
    "executions",
    "workflow-canvas",
    "runtime-monitor",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
    "run-control",
    "workflow-dag",
  ].includes(kind);
}
```

- [ ] **Step 5: Update route kind guard**

Modify `isReadModelKind` in `src/v2/server/routes.ts` so it accepts the new `ReadModelKind` literals. Keep existing kinds.

Expected code shape:

```ts
function isReadModelKind(kind: string): kind is ReadModelKind {
  return [
    "run-inspection",
    "run-summary",
    "executions",
    "exceptions",
    "runtime-monitor",
    "workflow-canvas",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
    "evolution-control-center",
    "run-control",
    "workflow-dag",
    "recovery-center",
    "execution-center",
    "planner-workbench",
    "domain-pack-governance",
    "evolution-center",
  ].includes(kind);
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS for new read-model tests and existing API alignment.

- [ ] **Step 7: Commit**

```bash
git add src/v2/read-models/ui-surfaces.ts src/v2/read-models/postgres-core.ts src/v2/server/routes.ts tests/v2/ui-read-model-contract.test.ts tests/v2/runtime-api-client-alignment.test.ts
git commit -m "feat: add ui run control and workflow dag read models"
```

---

### Task 4: Recovery and Execution Read Models

**Files:**
- Modify: `src/v2/read-models/ui-surfaces.ts`
- Modify: `src/v2/read-models/postgres-core.ts`
- Test: `tests/v2/ui-read-model-contract.test.ts`

- [ ] **Step 1: Add failing tests for `recovery-center` and `execution-center`**

Append to `tests/v2/ui-read-model-contract.test.ts`:

```ts
test("recovery-center read model exposes unresolved exceptions and apply command", async () => {
  const db = await createTestPostgresDb("ui_recovery_center");
  await db.query(`
    insert into southstar.workflow_runs (id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json, snapshot_json, runtime_context_json, metrics_json)
    values ('run-ui-recovery', 'running', 'software', 'recovery ui', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `);
  await db.query(`
    insert into southstar.runtime_resources (id, resource_type, resource_key, run_id, task_id, scope, status, title, payload_json, summary_json)
    values
      ('exception-1', 'runtime_exception', 'runtime_exception:run-ui-recovery:task-a:prep', 'run-ui-recovery', 'task-a', 'recovery', 'observed', 'prep failed',
       '{"schemaVersion":"southstar.runtime_exception.v1","exceptionId":"ex-1","kind":"dispatch_preparation_failed","runId":"run-ui-recovery","taskId":"task-a","evidenceRefs":[]}'::jsonb,
       '{}'::jsonb),
      ('decision-1', 'recovery_decision', 'runtime_exception_recovery_decision:ex-1:reset-session', 'run-ui-recovery', 'task-a', 'recovery', 'recorded', 'decision',
       '{"schemaVersion":"southstar.runtime.recovery_decision.v1","decisionId":"dec-1","exceptionId":"ex-1","runId":"run-ui-recovery","taskId":"task-a","path":"reset-session","operatorApprovalRequired":false,"policyRef":"system:fallback","matchedRuleId":"dispatch-prep-default","actions":[{"type":"reset-session"}],"evidenceRefs":[]}'::jsonb,
       '{}'::jsonb)
  `);

  const model = await buildUiSurfaceReadModel(db, { kind: "recovery-center", runId: "run-ui-recovery" });

  assert.equal(model.kind, "recovery-center");
  assert.equal(model.data.exceptions.length, 1);
  assert.equal(model.data.decisions.length, 1);
  assert.ok(model.commands.some((command) => command.id === "apply-recovery-decision:dec-1" && command.enabled));
});

test("execution-center read model exposes hand executions and reconcile command", async () => {
  const db = await createTestPostgresDb("ui_execution_center");
  await db.query(`
    insert into southstar.workflow_runs (id, status, domain, goal_prompt, workflow_manifest_json, execution_projection_json, snapshot_json, runtime_context_json, metrics_json)
    values ('run-ui-execution', 'running', 'software', 'execution ui', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
  `);
  await db.query(`
    insert into southstar.runtime_resources (id, resource_type, resource_key, run_id, task_id, scope, status, title, payload_json, summary_json)
    values ('hand-1', 'hand_execution', 'hand-execution:run-ui-execution:task-a:attempt-1', 'run-ui-execution', 'task-a', 'hand', 'queued', 'hand',
      '{"providerId":"tork","externalJobId":"job-1","attemptId":"attempt-1"}'::jsonb,
      '{}'::jsonb)
  `);

  const model = await buildUiSurfaceReadModel(db, { kind: "execution-center", runId: "run-ui-execution" });

  assert.equal(model.kind, "execution-center");
  assert.equal(model.data.handExecutions.length, 1);
  assert.ok(model.commands.some((command) => command.id === "reconcile-executor-job:job-1"));
});
```

- [ ] **Step 2: Implement `recovery-center` and `execution-center`**

Extend `buildUiSurfaceReadModel` in `src/v2/read-models/ui-surfaces.ts`:

```ts
    case "recovery-center":
      return await buildRecoveryCenter(db, input.runId);
    case "execution-center":
      return await buildExecutionCenter(db, input.runId);
```

Extend `isUiSurfaceReadModelKind`:

```ts
export function isUiSurfaceReadModelKind(kind: string): boolean {
  return kind === "run-control" || kind === "workflow-dag" || kind === "recovery-center" || kind === "execution-center";
}
```

Add these functions:

```ts
async function buildRecoveryCenter(db: SouthstarDb, runId: string) {
  const exceptions = await resourceRows(db, runId, "runtime_exception");
  const decisions = await resourceRows(db, runId, "recovery_decision");
  const activeDecisions = decisions.filter((decision) => ["recorded", "approved"].includes(decision.status));
  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.recovery_center.v1",
    kind: "recovery-center",
    scope: { runId },
    data: {
      runId,
      exceptions: exceptions.map(mapResource),
      decisions: decisions.map(mapResource),
    },
    commands: activeDecisions.map((decision) => {
      const payload = asRecord(decision.payload_json);
      const decisionId = stringValue(payload.decisionId) ?? decision.resource_key;
      return uiCommand({
        id: `apply-recovery-decision:${decisionId}`,
        label: "Apply recovery",
        endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/recovery-decisions/${encodeURIComponent(decisionId)}/apply`,
        method: "POST",
        enabled: decision.status === "recorded" || decision.status === "approved",
        disabledReason: decision.status === "recorded" || decision.status === "approved" ? undefined : `decision status is ${decision.status}`,
        dangerLevel: "medium",
        requiresConfirmation: true,
      });
    }),
    attentionItems: exceptions.filter((exception) => exception.status !== "resolved").map((exception) => ({
      id: `exception:${exception.resource_key}`,
      severity: "blocked",
      title: exception.title ?? "Runtime exception",
      reason: stringValue(asRecord(exception.payload_json).kind) ?? exception.status,
      sourceRefs: [`runtime-resource:${exception.resource_key}`],
      suggestedCommandIds: activeDecisions.map((decision) => `apply-recovery-decision:${stringValue(asRecord(decision.payload_json).decisionId) ?? decision.resource_key}`),
    })),
    sourceRefs: [
      { id: "exceptions", kind: "runtime-resource", ref: `southstar.runtime_resources:runtime_exception:run_id=${runId}` },
      { id: "decisions", kind: "runtime-resource", ref: `southstar.runtime_resources:recovery_decision:run_id=${runId}` },
    ],
    warnings: [],
  });
}

async function buildExecutionCenter(db: SouthstarDb, runId: string) {
  const handExecutions = await resourceRows(db, runId, "hand_execution");
  return createUiReadModelEnvelope({
    schemaVersion: "southstar.read_model.execution_center.v1",
    kind: "execution-center",
    scope: { runId },
    data: {
      runId,
      handExecutions: handExecutions.map(mapResource),
    },
    commands: handExecutions.flatMap((execution) => {
      const payload = asRecord(execution.payload_json);
      const externalJobId = stringValue(payload.externalJobId);
      if (!externalJobId) return [];
      return [
        uiCommand({
          id: `reconcile-executor-job:${externalJobId}`,
          label: "Reconcile",
          endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/reconcile`,
          method: "POST",
          enabled: true,
        }),
        uiCommand({
          id: `cancel-executor-job:${externalJobId}`,
          label: "Cancel",
          endpoint: `/api/v2/runs/${encodeURIComponent(runId)}/executor-jobs/${encodeURIComponent(externalJobId)}/cancel`,
          method: "POST",
          enabled: ["queued", "running"].includes(execution.status),
          disabledReason: ["queued", "running"].includes(execution.status) ? undefined : `hand execution status is ${execution.status}`,
          dangerLevel: "medium",
          requiresConfirmation: true,
        }),
      ];
    }),
    attentionItems: [],
    sourceRefs: [{ id: "hand-executions", kind: "runtime-resource", ref: `southstar.runtime_resources:hand_execution:run_id=${runId}` }],
    warnings: [],
  });
}

type ResourceRow = {
  resource_key: string;
  task_id: string | null;
  session_id: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
};

async function resourceRows(db: SouthstarDb, runId: string, resourceType: string): Promise<ResourceRow[]> {
  return (await db.query<ResourceRow>(
    `select resource_key, task_id, session_id, status, title, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = $2
      order by created_at, resource_key`,
    [runId, resourceType],
  )).rows;
}

function mapResource(row: ResourceRow) {
  return {
    id: row.resource_key,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    title: row.title ?? undefined,
    payload: row.payload_json,
    summary: row.summary_json,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 3: Include new kinds in `isPostgresCoreReadModelKind`**

Add `"recovery-center"` and `"execution-center"` to the array in `src/v2/read-models/postgres-core.ts`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts
```

Expected: PASS for recovery/execution read model tests.

- [ ] **Step 5: Commit**

```bash
git add src/v2/read-models/ui-surfaces.ts src/v2/read-models/postgres-core.ts tests/v2/ui-read-model-contract.test.ts
git commit -m "feat: add recovery and execution ui read models"
```

---

### Task 5: Dispatch Preparation Failure Observation

**Files:**
- Create: `src/v2/scheduler/dispatch-preparation-exception.ts`
- Modify: `src/v2/exceptions/types.ts`
- Modify: `src/v2/scheduler/runnable-task-scheduler.ts`
- Test: `tests/v2/dispatch-preparation-exception.test.ts`
- Test: `tests/v2/runnable-task-scheduler.test.ts`

- [ ] **Step 1: Add failing unit test for observation helper**

Create `tests/v2/dispatch-preparation-exception.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchPreparationObservation } from "../../src/v2/scheduler/dispatch-preparation-exception.ts";

test("dispatch preparation observation redacts provider error and records phase", () => {
  const observation = dispatchPreparationObservation({
    runId: "run-prep",
    taskId: "task-a",
    sessionId: "root-run-prep-task-a",
    attemptId: "task-a-attempt-1",
    recoveryKey: "task-dispatch:run-prep:task-a",
    phase: "context_assembly",
    partialResourceRefs: ["context-run-prep-task-a"],
    error: new Error("failed with token ghp_abcdefghijklmnopqrstuvwxyz123456"),
  });

  assert.equal(observation.kind, "dispatch_preparation_failed");
  assert.equal(observation.runId, "run-prep");
  assert.equal(observation.taskId, "task-a");
  assert.equal(observation.payload.phase, "context_assembly");
  assert.equal(observation.payload.redactedError.includes("ghp_"), false);
  assert.equal(observation.payload.partialResourceRefs[0], "context-run-prep-task-a");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test:v2 -- tests/v2/dispatch-preparation-exception.test.ts
```

Expected before implementation: FAIL with missing module.

- [ ] **Step 3: Add exception payload type**

Modify `src/v2/exceptions/types.ts` to include a dispatch preparation kind. If this file has a union such as `RuntimeExceptionKind` or payload union, add:

```ts
export type DispatchPreparationFailedPhase =
  | "context_assembly"
  | "checkpoint_create"
  | "brain_wake"
  | "hand_provision"
  | "task_intent_create"
  | "tool_policy_check"
  | "hand_submit";

export type DispatchPreparationFailedPayload = {
  kind: "dispatch_preparation_failed";
  phase: DispatchPreparationFailedPhase;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  recoveryKey: string;
  partialResourceRefs: string[];
  redactedError: string;
  evidenceRefs: string[];
};
```

Then add `"dispatch_preparation_failed"` to the runtime exception kind union and `DispatchPreparationFailedPayload` to the runtime exception payload union.

- [ ] **Step 4: Implement observation helper**

Create `src/v2/scheduler/dispatch-preparation-exception.ts`:

```ts
import type { RuntimeObservation } from "../exceptions/types.ts";
import type { DispatchPreparationFailedPhase } from "../exceptions/types.ts";

const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g;

export function dispatchPreparationObservation(input: {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  recoveryKey: string;
  phase: DispatchPreparationFailedPhase;
  partialResourceRefs: string[];
  error: unknown;
}): RuntimeObservation {
  return {
    kind: "dispatch_preparation_failed",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    payload: {
      kind: "dispatch_preparation_failed",
      phase: input.phase,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      recoveryKey: input.recoveryKey,
      partialResourceRefs: input.partialResourceRefs,
      redactedError: redactError(input.error),
      evidenceRefs: input.partialResourceRefs,
    },
  };
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(TOKEN_PATTERN, "[REDACTED]");
}
```

- [ ] **Step 5: Wire scheduler catch path**

Modify `src/v2/scheduler/runnable-task-scheduler.ts`:

```ts
import { dispatchPreparationObservation } from "./dispatch-preparation-exception.ts";
```

Track phase inside `dispatchTask`:

```ts
  let prepPhase: DispatchPreparationFailedPhase = "context_assembly";
```

Before major prep calls, set phase:

```ts
    prepPhase = "context_assembly";
    const assembly = await assembler.buildForTask(...);

    prepPhase = "checkpoint_create";
    const taskStartCheckpoint = await deps.sessionStore.createCheckpoint(...);

    prepPhase = "brain_wake";
    brainBindingId = await ensureBrainBinding(...);

    prepPhase = "hand_provision";
    const handBinding = await ensureHandBinding(...);

    prepPhase = "task_intent_create";
    const intent = createDefaultTaskExecutionIntent(...);

    prepPhase = "tool_policy_check";
    await enforcePreExecutionToolProxyPolicyPg(...);

    prepPhase = "hand_submit";
    const handResult = await deps.handProvider.executeTask(...);
```

In the catch block before `releaseTaskDispatchPreparation`, observe the exception:

```ts
    const controller = createRuntimeExceptionController({ db });
    const exception = await controller.observe(dispatchPreparationObservation({
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId,
      recoveryKey,
      phase: prepPhase,
      partialResourceRefs: [contextPacketId, taskEnvelopeId, taskStartCheckpointId, brainBindingId, handBindingId].filter(Boolean),
      error,
    }));
    const classification = await controller.classify(exception);
    await controller.decide(classification);
```

Keep the existing release behavior for compatibility after observation.

- [ ] **Step 6: Add scheduler behavior test**

Append to `tests/v2/runnable-task-scheduler.test.ts` using the existing scheduler fixture style:

```ts
test("scheduler observes dispatch preparation failure before releasing task", async () => {
  const db = await createSchedulerTestDb("scheduler_prep_failure");
  await seedPendingRunWithTask(db, { runId: "run-prep-failure", taskId: "task-a" });

  const scheduler = createRunnableTaskScheduler(db, {
    sessionStore: failingSessionStore(new Error("checkpoint failed")),
    brainProvider: fakeBrainProvider(),
    handProvider: fakeHandProvider(),
  });

  await assert.rejects(
    () => scheduler.runOnce({ runId: "run-prep-failure" }),
    /checkpoint failed/,
  );

  const exception = await db.one<{ status: string; payload_json: { kind: string; phase: string } }>(
    "select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'runtime_exception'",
    ["run-prep-failure"],
  );
  assert.equal(exception.payload_json.kind, "dispatch_preparation_failed");
  assert.equal(exception.payload_json.phase, "checkpoint_create");

  const decision = await db.one<{ resource_key: string }>(
    "select resource_key from southstar.runtime_resources where run_id = $1 and resource_type = 'recovery_decision'",
    ["run-prep-failure"],
  );
  assert.match(decision.resource_key, /runtime_exception_recovery_decision/);
});
```

Use the existing helper names in `runnable-task-scheduler.test.ts`; if a helper does not exist, create it in that test file next to the other scheduler helpers with explicit seeded rows.

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/dispatch-preparation-exception.test.ts tests/v2/runnable-task-scheduler.test.ts tests/v2/runtime-exceptions.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/v2/scheduler/dispatch-preparation-exception.ts src/v2/exceptions/types.ts src/v2/scheduler/runnable-task-scheduler.ts tests/v2/dispatch-preparation-exception.test.ts tests/v2/runnable-task-scheduler.test.ts
git commit -m "feat: observe dispatch preparation failures"
```

---

### Task 6: Recovery Policy Evidence Compatibility

**Files:**
- Create: `src/v2/recovery/policy.ts`
- Modify: `src/v2/exceptions/runtime-exception-controller.ts`
- Modify: `src/v2/exceptions/types.ts`
- Test: `tests/v2/runtime-exceptions.test.ts`

- [ ] **Step 1: Add failing test for policy evidence in decisions**

Append to `tests/v2/runtime-exceptions.test.ts`:

```ts
test("recovery decision includes policy evidence for dispatch preparation failure", async () => {
  const db = await createRuntimeExceptionTestDb("policy_evidence");
  await seedRun(db, { runId: "run-policy-evidence" });
  const controller = createRuntimeExceptionController({ db });

  const exception = await controller.observe({
    kind: "dispatch_preparation_failed",
    runId: "run-policy-evidence",
    taskId: "task-a",
    sessionId: "root-run-policy-evidence-task-a",
    payload: {
      kind: "dispatch_preparation_failed",
      phase: "context_assembly",
      runId: "run-policy-evidence",
      taskId: "task-a",
      sessionId: "root-run-policy-evidence-task-a",
      attemptId: "task-a-attempt-1",
      recoveryKey: "task-dispatch:run-policy-evidence:task-a",
      partialResourceRefs: [],
      redactedError: "context failed",
      evidenceRefs: [],
    },
  });
  const classification = await controller.classify(exception);
  const decision = await controller.decide(classification);

  assert.equal(decision.payload.policyRef, "system:fallback");
  assert.equal(decision.payload.matchedRuleId, "dispatch-preparation-failed-default");
  assert.deepEqual(decision.payload.actions, [{ type: "reset-session" }, { type: "release-task", status: "pending" }]);
});
```

Use existing DB seed helper names in this test file; if helper names differ, keep the same assertion shape.

- [ ] **Step 2: Implement fallback policy matcher**

Create `src/v2/recovery/policy.ts`:

```ts
import type { RecoveryPath, RuntimeExceptionRecord } from "../exceptions/types.ts";

export type RecoveryAction =
  | { type: "release-task"; status: "pending" | "blocked" | "failed" }
  | { type: "mark-hand-execution"; status: "lost" | "superseded" }
  | { type: "create-session-checkpoint" }
  | { type: "fork-session" }
  | { type: "reset-session" }
  | { type: "reprovision-hand" }
  | { type: "wake-brain" }
  | { type: "request-artifact-repair" }
  | { type: "cancel-provider-job" }
  | { type: "observe-only" };

export type RecoveryPolicyMatch = {
  policyRef: string;
  matchedRuleId: string;
  path: RecoveryPath;
  operatorApprovalRequired: boolean;
  reason: string;
  actions: RecoveryAction[];
};

export function matchFallbackRecoveryPolicy(exception: RuntimeExceptionRecord, legacyPath: RecoveryPath): RecoveryPolicyMatch {
  if (exception.payload.kind === "dispatch_preparation_failed") {
    return {
      policyRef: "system:fallback",
      matchedRuleId: "dispatch-preparation-failed-default",
      path: "reset-session",
      operatorApprovalRequired: false,
      reason: "dispatch_preparation_failed matched system fallback reset-session policy",
      actions: [{ type: "reset-session" }, { type: "release-task", status: "pending" }],
    };
  }
  return {
    policyRef: "system:legacy-classifier",
    matchedRuleId: `legacy-${exception.payload.kind}`,
    path: legacyPath,
    operatorApprovalRequired: legacyPath === "rollback-workspace" || legacyPath === "block-for-operator",
    reason: `${exception.payload.kind} classified for ${legacyPath}`,
    actions: legacyActionsForPath(legacyPath),
  };
}

function legacyActionsForPath(path: RecoveryPath): RecoveryAction[] {
  switch (path) {
    case "retry-same-task-new-attempt":
    case "repair-artifact":
      return [{ type: "release-task", status: "pending" }];
    case "block-for-operator":
      return [{ type: "release-task", status: "blocked" }];
    case "reprovision-hand":
      return [{ type: "reprovision-hand" }, { type: "release-task", status: "pending" }];
    case "wake-new-brain":
      return [{ type: "wake-brain" }, { type: "release-task", status: "pending" }];
    case "fork-session":
      return [{ type: "fork-session" }, { type: "release-task", status: "pending" }];
    case "reset-session":
      return [{ type: "reset-session" }, { type: "release-task", status: "pending" }];
    case "rollback-workspace":
      return [{ type: "release-task", status: "blocked" }];
    case "requeue-hand-execution":
      return [{ type: "mark-hand-execution", status: "lost" }, { type: "release-task", status: "pending" }];
    case "none-observe-only":
      return [{ type: "observe-only" }];
    case "fail-task":
      return [{ type: "release-task", status: "failed" }];
    case "fail-run":
      return [{ type: "release-task", status: "failed" }];
  }
}
```

- [ ] **Step 3: Extend recovery decision payload type**

Modify `RecoveryDecisionPayload` in `src/v2/exceptions/types.ts` to include:

```ts
policyRef?: string;
matchedRuleId?: string;
actions?: Array<Record<string, unknown>>;
```

- [ ] **Step 4: Use policy matcher in controller**

Modify `src/v2/exceptions/runtime-exception-controller.ts`:

```ts
import { matchFallbackRecoveryPolicy } from "../recovery/policy.ts";
```

In `classify`:

```ts
      const legacyPath = classifyRecoveryPath(exception);
      const policyMatch = matchFallbackRecoveryPolicy(exception, legacyPath);
      return {
        ...exception,
        recoveryPath: policyMatch.path,
        operatorApprovalRequired: policyMatch.operatorApprovalRequired,
        reason: policyMatch.reason,
        policyMatch,
      };
```

If `RuntimeExceptionClassification` does not include `policyMatch`, add it to the type.

In `recordRecoveryDecisionPg`, include:

```ts
      ...(classification.policyMatch ? {
        policyRef: classification.policyMatch.policyRef,
        matchedRuleId: classification.policyMatch.matchedRuleId,
        actions: classification.policyMatch.actions,
      } : {}),
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/runtime-exceptions.test.ts tests/v2/recovery-decision-applier.test.ts
```

Expected: PASS. Existing applier behavior must remain unchanged because `path` is still present.

- [ ] **Step 6: Commit**

```bash
git add src/v2/recovery/policy.ts src/v2/exceptions/types.ts src/v2/exceptions/runtime-exception-controller.ts tests/v2/runtime-exceptions.test.ts
git commit -m "feat: add recovery policy evidence"
```

---

### Task 7: Hardcode Boundary Static Gates

**Files:**
- Create: `tests/v2/hardcode-boundaries.test.ts`
- Modify: `src/v2/context/managed-context-assembler.ts`
- Modify: `src/v2/evolution/sandbox.ts`
- Modify: `src/v2/manifests/types.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
- Test: `tests/v2/hardcode-boundaries.test.ts`

- [ ] **Step 1: Add static hardcode boundary test**

Create `tests/v2/hardcode-boundaries.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

const CORE_FILES = [
  "src/v2/context/managed-context-assembler.ts",
  "src/v2/scheduler/runnable-task-scheduler.ts",
  "src/v2/exceptions/runtime-exception-controller.ts",
  "src/v2/exceptions/recovery-decision-applier.ts",
  "src/v2/evolution/sandbox.ts",
];

test("core runtime files do not import software domain pack directly", () => {
  const offenders = CORE_FILES.filter((file) => source(file).includes("../domain-packs/software.ts"));
  assert.deepEqual(offenders, []);
});

test("manifest types do not make tork the only execution engine", () => {
  const text = source("src/v2/manifests/types.ts");
  assert.equal(text.includes('engine: "tork";'), false);
});

test("generic workflow generator does not emit calc fixture task id", () => {
  const text = source("src/v2/workflow-generator/constrained-generator.ts");
  assert.equal(text.includes("implement-calc-command"), false);
});

function source(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}
```

- [ ] **Step 2: Run test and verify current failure**

Run:

```bash
npm run test:v2 -- tests/v2/hardcode-boundaries.test.ts
```

Expected before implementation: FAIL listing current direct imports or hardcoded literals.

- [ ] **Step 3: Loosen manifest type**

Modify `src/v2/manifests/types.ts`:

```ts
export type TaskExecutionSpec = {
  engine: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  mounts: Array<{ source: string; target: string; readonly: boolean }>;
  timeoutSeconds: number;
  infraRetry: { maxAttempts: number };
};
```

Modify `WorkflowTaskDefinition`:

```ts
  domain: string;
```

- [ ] **Step 4: Replace calc fixture task id**

Modify `src/v2/workflow-generator/constrained-generator.ts` broad feature task id and phase refs:

```ts
id: "implement-primary-change"
```

Replace references to `"implement-calc-command"` with `"implement-primary-change"`. Replace the focus string:

```ts
focus: "implement the primary requested behavior"
```

- [ ] **Step 5: Remove direct software pack fallback from managed context assembler**

Modify `src/v2/context/managed-context-assembler.ts` so direct import is removed. Require explicit domain pack:

```ts
export type ManagedContextAssemblerOptions = {
  domainPack: DomainPack;
};

export function createManagedContextAssembler(db: SouthstarDb, options: ManagedContextAssemblerOptions) {
  const domainPack = options.domainPack;
  return {
    async buildForTask(input: BuildManagedTaskContextInput): Promise<BuildManagedTaskContextResult> {
      ...
    },
  };
}
```

Then update call sites to pass the explicit pack. For scheduler compatibility, add a small resolver in the caller that reads manifest embedded domain pack data first. If the manifest lacks required pack data, throw:

```ts
throw new Error(`domain pack data is required to assemble context for run ${input.runId}`);
```

- [ ] **Step 6: Fence evolution sandbox software dependency**

Modify `src/v2/evolution/sandbox.ts` so `softwareDomainPack` is only imported in a config/fixture helper, not the core sandbox execution path. The core function should receive:

```ts
type EvolutionSandboxInput = {
  domainPack: DomainPack;
  ...
};
```

Keep a compatibility factory in the same file only if needed:

```ts
export async function runSoftwareEvolutionSandbox(input: Omit<EvolutionSandboxInput, "domainPack">) {
  const { softwareDomainPack } = await import("../domain-packs/software.ts");
  return await runEvolutionSandbox({ ...input, domainPack: softwareDomainPack });
}
```

The static test should exclude this compatibility factory only if it is explicitly named `runSoftwareEvolutionSandbox`.

- [ ] **Step 7: Make UI API software default explicit**

In `src/v2/ui-api/postgres-run-api.ts` and `src/v2/ui-api/postgres-task-envelope.ts`, keep software compatibility but annotate the source in payload/summary:

```ts
const defaultSource = {
  kind: "compatibility-default",
  domainPackId: "software",
  reason: "No domainPackRef was provided by the caller; compatibility path selected software pack.",
};
```

Persist this under planner draft summary or envelope summary where the existing resource payload already stores planner trace/materialization data.

- [ ] **Step 8: Run focused tests**

Run:

```bash
npm run test:v2 -- tests/v2/hardcode-boundaries.test.ts tests/v2/managed-context-assembler.test.ts tests/v2/postgres-run-api.test.ts tests/v2/postgres-task-envelope.test.ts
```

Expected: PASS. Existing software compatibility tests should still pass.

- [ ] **Step 9: Commit**

```bash
git add tests/v2/hardcode-boundaries.test.ts src/v2/manifests/types.ts src/v2/workflow-generator/constrained-generator.ts src/v2/context/managed-context-assembler.ts src/v2/evolution/sandbox.ts src/v2/ui-api/postgres-run-api.ts src/v2/ui-api/postgres-task-envelope.ts tests/v2/managed-context-assembler.test.ts tests/v2/postgres-run-api.test.ts tests/v2/postgres-task-envelope.test.ts
git commit -m "refactor: contain software runtime defaults"
```

---

### Task 8: Schema Documentation Sync

**Files:**
- Create: `docs/superpowers/southstar-current-postgres-state-model.md`
- Modify: `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md`
- Test: `tests/v2/hardcode-boundaries.test.ts`

- [ ] **Step 1: Add documentation assertion**

Append to `tests/v2/hardcode-boundaries.test.ts`:

```ts
test("current postgres state model documentation names layered canonical tables", () => {
  const text = source("docs/superpowers/southstar-current-postgres-state-model.md");
  for (const table of ["work_items", "workflow_runs", "workflow_tasks", "workflow_history", "runtime_resources"]) {
    assert.match(text, new RegExp(`\\b${table}\\b`));
  }
  assert.match(text, /layered state model/i);
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test:v2 -- tests/v2/hardcode-boundaries.test.ts
```

Expected before doc creation: FAIL with missing doc file.

- [ ] **Step 3: Create current state model doc**

Create `docs/superpowers/southstar-current-postgres-state-model.md`:

```md
# Southstar Current Postgres State Model

Date: 2026-06-25
Status: current-state reference

Southstar v2 currently uses a layered state model, not a single three-table runtime model.

## Canonical Layers

- `work_items`: intake, source provenance, external issue/ticket/request linkage, and run refs.
- `workflow_runs`: run status, domain, goal prompt, workflow manifest snapshot, execution projection, runtime context, and metrics.
- `workflow_tasks`: task DAG execution state, dependency refs, root session id, executor task id, task snapshot, and metrics.
- `workflow_history`: append-only run event log, sequence, actor, correlation, causation, and idempotency evidence.
- `runtime_resources`: extensible runtime evidence and resources, including context packets, task envelopes, bindings, hand executions, runtime exceptions, recovery decisions, approvals, memory deltas, evaluator results, and tool proxy records.

## Side Stores

- `artifact_blobs`: typed artifact content that is too large or too content-specific for `runtime_resources`.
- `secure_blobs`: encrypted or provider-managed secret-bearing content linked from runtime resources.
- `library_objects`, `library_edges`, `library_history`, `library_similarity_index`: design library and domain-pack control-plane state.
- `learning_nodes`, `learning_edges`: evolution and learning graph state.

## UI Contract Rule

The redesigned UI should consume read models, not raw table rows. Raw tables remain the audit source of truth; read models are stable UI-facing projections with command affordances and source refs.

## Superseded Wording

Older design text that describes `runtime_status` and `workflow_state` as current physical columns is superseded. Those names may still be useful as semantic projection fields, but they are not the current Postgres schema truth.
```

- [ ] **Step 4: Add supersession note to older runtime spec**

At the top of `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md`, add:

```md
> Current-state note, 2026-06-25: Southstar v2 Postgres runtime now uses the layered model documented in `docs/superpowers/southstar-current-postgres-state-model.md`. Sections in this older spec that describe `runtime_status` / `workflow_state` as physical current-schema columns should be read as historical target design or semantic projection language, not current schema truth.
```

- [ ] **Step 5: Run documentation gate**

Run:

```bash
npm run test:v2 -- tests/v2/hardcode-boundaries.test.ts
```

Expected: PASS for documentation assertion.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/southstar-current-postgres-state-model.md docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md tests/v2/hardcode-boundaries.test.ts
git commit -m "docs: clarify southstar postgres state model"
```

---

### Task 9: API Route and Client Alignment

**Files:**
- Modify: `src/v2/server/client.ts`
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
- Test: `tests/v2/runtime-api-client-alignment.test.ts`

- [ ] **Step 1: Add failing route/client test for new read-model kinds**

Append to `tests/v2/runtime-api-client-alignment.test.ts`:

```ts
test("runtime server client exposes UI contract read models", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const client = createRuntimeServerClient("http://127.0.0.1", {
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true, kind: "read-model", result: {} }), { headers: { "content-type": "application/json" } });
    },
  });

  await client.getReadModel({ kind: "run-control", runId: "run/a" });
  await client.getReadModel({ kind: "workflow-dag", runId: "run/a" });
  await client.getReadModel({ kind: "recovery-center", runId: "run/a" });
  await client.getReadModel({ kind: "execution-center", runId: "run/a" });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1/api/v2/read-models/run-control/run%2Fa",
    "http://127.0.0.1/api/v2/read-models/workflow-dag/run%2Fa",
    "http://127.0.0.1/api/v2/read-models/recovery-center/run%2Fa",
    "http://127.0.0.1/api/v2/read-models/execution-center/run%2Fa",
  ]);
});
```

- [ ] **Step 2: Run alignment test**

Run:

```bash
npm run test:v2 -- tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS if `getReadModel` already supports generic kinds; FAIL if `ReadModelKind` imports or route guard were not updated correctly.

- [ ] **Step 3: Fix client only if needed**

If the test fails because the client type rejects new kinds, ensure `src/v2/server/client.ts` imports the updated `ReadModelKind` and keeps this method generic:

```ts
getReadModel(body: { kind: ReadModelKind; runId: string; taskId?: string }) {
  const suffix = body.taskId
    ? `${encodeURIComponent(body.runId)}/${encodeURIComponent(body.taskId)}`
    : encodeURIComponent(body.runId);
  return get(`${baseUrl}/api/v2/read-models/${encodeURIComponent(body.kind)}/${suffix}`);
}
```

- [ ] **Step 4: Run alignment test again**

Run:

```bash
npm run test:v2 -- tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/v2/server/client.ts tests/v2/runtime-api-client-alignment.test.ts
git commit -m "test: align ui read model client routes"
```

---

### Task 10: Final Verification

**Files:**
- No new files unless failures reveal necessary fixes.

- [ ] **Step 1: Run formatting whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 2: Run focused v2 tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-model-contract.test.ts tests/v2/dispatch-preparation-exception.test.ts tests/v2/hardcode-boundaries.test.ts tests/v2/runtime-api-client-alignment.test.ts tests/v2/runtime-exceptions.test.ts tests/v2/runnable-task-scheduler.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full v2 test suite**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 4: Run Postgres E2E static matrix**

Run:

```bash
npm run test:e2e:postgres
```

Expected: PASS for static manifest/boundary checks.

- [ ] **Step 5: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional committed changes or a clean tree. If unrelated user changes existed before execution, confirm they are still present and not included in this work's commits.

- [ ] **Step 6: Confirm no extra commit is needed**

Run:

```bash
git log --oneline -5
```

Expected: the task-specific commits from Tasks 1-9 are present. Do not create an empty final commit. If Step 1-4 exposed a failure, return to the task that introduced that behavior, make the fix there, rerun this final verification task, and use that task's commit command.

---

## Self-Review

Spec coverage:

- Read-model-first UI contract: Tasks 1-4 and 9.
- Command affordances and disabled reasons: Tasks 2-4.
- Dispatch-prep failure observation: Task 5.
- Recovery policy evidence: Task 6.
- Hardcode containment: Task 7.
- Schema/docs synchronization: Task 8.
- Compatibility and final verification: Tasks 1, 7, 9, 10.

Completeness scan:

- The plan contains no unresolved marker text and no deferred implementation tasks.
- Where existing helper names may differ, the plan gives the exact inserted rows and expected assertions so workers can adapt to local helper names without changing behavior.

Type consistency:

- `UiReadModelEnvelope`, `UiCommandAffordance`, `UiAttentionItem`, `UiSourceRef`, and `UiWarning` are defined in Task 2 and reused by later tasks.
- New read-model kinds are added in Task 2 before route/client alignment in later tasks.
- `dispatch_preparation_failed` payload is defined before scheduler wiring.
- Recovery policy evidence preserves existing `path` compatibility while adding `policyRef`, `matchedRuleId`, and `actions`.

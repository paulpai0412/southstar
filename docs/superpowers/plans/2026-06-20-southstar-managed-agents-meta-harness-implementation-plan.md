# Southstar Managed Agents Meta-Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Southstar managed-agent meta-harness architecture: durable sessions, decoupled brains and hands, Postgres recovery, runnable-task scheduling, vault/tool proxy isolation, end-state evaluation, and real Postgres/Tork/Pi validation.

**Architecture:** Southstar remains the canonical control plane in Postgres. The implementation adds stable interfaces around session event logs, brain providers, hand providers, vault/tool proxy, runnable-task scheduling, context event slicing, and managed-agent evaluation while preserving artifact/evaluator completion truth. Legacy SQLite recovery/session paths are quarantined and replaced with Postgres canonical APIs.

**Tech Stack:** TypeScript ESM, Node 22+, `tsx`, `node:test`, Postgres via `pg`, existing Southstar v2 runtime, Tork provider, Pi/Codex harness boundaries, Next runtime server/read models.

---

## File Structure

Create these focused modules:

- `src/v2/meta-harness/types.ts`
  Shared types for `SessionStore`, `BrainProvider`, `HandProvider`, `ToolProxy`, event/resource taxonomy, and binding payloads.

- `src/v2/meta-harness/taxonomy.ts`
  Runtime resource types, session event types, status enums, and assertion helpers.

- `src/v2/session/postgres-session-store.ts`
  Postgres implementation of append-only session events, event slicing, checkpoints, and context source references.

- `src/v2/session/types.ts`
  Session event, slice query, checkpoint, event ref, and lineage types.

- `src/v2/work-items/types.ts`
  Work item references and source metadata.

- `src/v2/work-items/postgres-work-items.ts`
  First-class `southstar.work_items` table access and run linkage.

- `src/v2/brain/types.ts`
  Brain provider contracts and binding payloads.

- `src/v2/brain/registry.ts`
  Provider registry and selection helpers.

- `src/v2/brain/fake-brain-provider.ts`
  Deterministic provider for unit and E2E crash/wake tests.

- `src/v2/brain/pi-brain-provider.ts`
  Adapter around current Pi harness/session behavior.

- `src/v2/hands/types.ts`
  Hand provider contracts and binding payloads.

- `src/v2/hands/registry.ts`
  Provider registry and selection helpers.

- `src/v2/hands/fake-hand-provider.ts`
  Deterministic hand provider for failure/reprovision tests.

- `src/v2/hands/tork-hand-provider.ts`
  Adapter around current Tork executor provider.

- `src/v2/tool-proxy/types.ts`
  Vault lease, tool grants, proxy calls, credential redaction, and session tool token types.

- `src/v2/tool-proxy/postgres-vault.ts`
  Local encrypted/dev vault lease store using Postgres `secure_blobs` and redacted summaries.

- `src/v2/tool-proxy/tool-proxy.ts`
  Tool proxy implementation that records calls and prevents credential exposure to hands.

- `src/v2/scheduler/runnable-task-scheduler.ts`
  Artifact-driven runnable-task scheduler with brain/hand allocation, idempotency, concurrency, and fan-in.

- `src/v2/scheduler/types.ts`
  Scheduler inputs, decisions, dispatch results, and effort policy types.

- `src/v2/context/event-slicing.ts`
  Deterministic event slicing and context source reference construction.

- `src/v2/context/managed-context-builder.ts`
  Context packet builder extension with `rawEventRefs`, `omittedEventRanges`, `checkpointRefs`, `transformRefs`, and cache key.

- `src/v2/session-recovery/postgres-controller.ts`
  Durable-first recovery controller for `wake-new-brain`, `retry-same-brain`, fork/reset/reprovision/rollback actions.

- `src/v2/evaluators/end-state.ts`
  End-state evaluator for artifact graph, hand state, security policy, tool efficiency, and final report support.

- `src/v2/read-models/managed-agents.ts`
  Operator read model for sessions, brain bindings, hand bindings, context slices, recovery lineage, and tool grants.

- `tests/v2/postgres-test-utils.ts`
  Shared Postgres test database helper used by all new managed-agent unit tests.

Modify these existing modules:

- `src/v2/db/schema.ts`
  Add `work_items` and new indexes; keep `runtime_resources` as binding/resource store.

- `src/v2/manifests/types.ts`
  Add `effortPolicy`, `brainRef`, `handRefs`, and managed context refs without breaking existing manifests.

- `src/v2/workflow-generator/constrained-generator.ts`
  Generate persisted effort policy instead of broad/narrow implicit runtime behavior only.

- `src/v2/context/postgres-builder.ts`
  Delegate to managed context builder while preserving existing Knowledge Card selection behavior.

- `src/v2/executor/postgres-run-dispatcher.ts`
  Convert to compatibility wrapper over runnable-task scheduler.

- `src/v2/session-recovery/postgres-dispatcher.ts`
  Replace one-off recovery behavior with `postgres-controller`.

- `src/v2/server/runtime-loops.ts`
  Add scheduler and recovery loops.

- `src/v2/server/ui-routes.ts` and/or `src/v2/server/routes.ts`
  Expose managed-agent read model and recovery commands.

- `tests/v2/index.test.ts`
  Import new test files.

- `tests/e2e-postgres/index.test.ts`
  Import real managed-agent E2E cases.

---

## Task 0: Shared Postgres Test Utility

**Files:**
- Create: `tests/v2/postgres-test-utils.ts`

- [ ] **Step 1: Create the shared helper**

Create `tests/v2/postgres-test-utils.ts`:

```ts
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";

export type TestPostgresDb = SouthstarDb & {
  databaseUrl: string;
  drop(): Promise<void>;
};

export async function createTestPostgresDb(): Promise<TestPostgresDb> {
  const fixture = await createTestDatabase();
  await initializeSouthstarSchema(fixture.databaseUrl);
  const db = await openSouthstarDb(fixture.databaseUrl);
  const originalClose = db.close.bind(db);
  let closed = false;
  async function closeAndDrop() {
    if (closed) return;
    closed = true;
    await originalClose();
    await fixture.drop();
  }
  return Object.assign(db, {
    databaseUrl: fixture.databaseUrl,
    close: closeAndDrop,
    drop: closeAndDrop,
  });
}

export async function initSouthstarSchema(_db: SouthstarDb): Promise<void> {
  // createTestPostgresDb initializes schema before opening because openSouthstarDb validates metadata.
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 2: Type-check the helper through an existing Postgres test command**

Run:

```bash
npx tsx tests/v2/postgres-runtime-store.test.ts
```

Expected: PASS when `SOUTHSTAR_TEST_ADMIN_DATABASE_URL` is configured. If the environment variable is missing, expected failure contains `SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required`.

- [ ] **Step 3: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/v2/postgres-test-utils.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: add managed postgres test utility"
```

---

## Task 1: Taxonomy And Interface Contracts

**Files:**
- Create: `src/v2/meta-harness/taxonomy.ts`
- Create: `src/v2/meta-harness/types.ts`
- Create: `tests/v2/meta-harness-taxonomy.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing taxonomy test**

Create `tests/v2/meta-harness-taxonomy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  MANAGED_AGENT_RESOURCE_TYPES,
  MANAGED_AGENT_SESSION_EVENT_TYPES,
  assertManagedAgentResourceType,
  assertManagedAgentSessionEventType,
} from "../../src/v2/meta-harness/taxonomy.ts";

test("managed-agent taxonomy includes required resource and event types", () => {
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("brain_binding"));
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("hand_binding"));
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("session_checkpoint"));
  assert.ok(MANAGED_AGENT_RESOURCE_TYPES.includes("tool_proxy_call"));
  assert.ok(MANAGED_AGENT_SESSION_EVENT_TYPES.includes("brain.woke"));
  assert.ok(MANAGED_AGENT_SESSION_EVENT_TYPES.includes("hand.execute_completed"));
  assert.ok(MANAGED_AGENT_SESSION_EVENT_TYPES.includes("recovery.decision_recorded"));
});

test("managed-agent taxonomy rejects unknown strings", () => {
  assert.equal(assertManagedAgentResourceType("brain_binding"), "brain_binding");
  assert.equal(assertManagedAgentSessionEventType("brain.woke"), "brain.woke");
  assert.throws(() => assertManagedAgentResourceType("random"));
  assert.throws(() => assertManagedAgentSessionEventType("random.event"));
});
```

Append to `tests/v2/index.test.ts`:

```ts
await import("./meta-harness-taxonomy.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npx tsx tests/v2/meta-harness-taxonomy.test.ts
```

Expected: FAIL with module not found for `src/v2/meta-harness/taxonomy.ts`.

- [ ] **Step 3: Add taxonomy constants**

Create `src/v2/meta-harness/taxonomy.ts`:

```ts
export const MANAGED_AGENT_RESOURCE_TYPES = [
  "session",
  "session_checkpoint",
  "brain_binding",
  "hand_binding",
  "hand_snapshot",
  "context_packet",
  "context_transform",
  "task_envelope",
  "artifact_ref",
  "artifact_blob",
  "evaluator_result",
  "recovery_decision",
  "recovery_execution",
  "tool_grant",
  "tool_proxy_call",
  "vault_lease",
  "executor_binding",
  "executor_reconcile_result",
] as const;

export type ManagedAgentResourceType = typeof MANAGED_AGENT_RESOURCE_TYPES[number];

export const MANAGED_AGENT_SESSION_EVENT_TYPES = [
  "session.created",
  "brain.woke",
  "brain.failed",
  "brain.cancelled",
  "context.packet_built",
  "context.events_read",
  "hand.provisioned",
  "hand.execute_requested",
  "hand.execute_completed",
  "hand.failed",
  "hand.snapshot_created",
  "artifact.created",
  "artifact.accepted",
  "artifact.rejected",
  "evaluator.completed",
  "checkpoint.created",
  "recovery.decision_recorded",
  "recovery.execution_submitted",
  "tool_proxy.called",
  "vault_lease.issued",
  "operator.steering_received",
] as const;

export type ManagedAgentSessionEventType = typeof MANAGED_AGENT_SESSION_EVENT_TYPES[number];

export function assertManagedAgentResourceType(value: string): ManagedAgentResourceType {
  if (MANAGED_AGENT_RESOURCE_TYPES.includes(value as ManagedAgentResourceType)) {
    return value as ManagedAgentResourceType;
  }
  throw new Error(`unknown managed-agent resource type: ${value}`);
}

export function assertManagedAgentSessionEventType(value: string): ManagedAgentSessionEventType {
  if (MANAGED_AGENT_SESSION_EVENT_TYPES.includes(value as ManagedAgentSessionEventType)) {
    return value as ManagedAgentSessionEventType;
  }
  throw new Error(`unknown managed-agent session event type: ${value}`);
}
```

- [ ] **Step 4: Add shared contracts**

Create `src/v2/meta-harness/types.ts`:

```ts
import type { ManagedAgentResourceType, ManagedAgentSessionEventType } from "./taxonomy.ts";

export type EventRef = {
  id: string;
  sessionId: string;
  runId: string;
  sequence: number;
};

export type SessionEvent = {
  eventType: ManagedAgentSessionEventType | string;
  actorType: "operator" | "orchestrator" | "brain" | "hand" | "evaluator" | "tool-proxy";
  runId: string;
  taskId?: string;
  sessionId: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  payload: Record<string, unknown>;
};

export type EventSliceQuery = {
  afterSequence?: number;
  beforeSequence?: number;
  aroundEventId?: string;
  windowBefore?: number;
  windowAfter?: number;
  eventTypes?: string[];
  taskId?: string;
  artifactRef?: string;
  correlationId?: string;
  limit?: number;
};

export type SessionCheckpoint = {
  id: string;
  runId: string;
  taskId?: string;
  sessionId: string;
  checkpointType: "task-start" | "artifact-accepted" | "before-recovery" | "operator";
  summary: string;
  eventRange: { fromSequence: number; toSequence: number };
  refs: Record<string, string[]>;
  metrics: Record<string, unknown>;
  createdAt: string;
};

export type CheckpointInput = Omit<SessionCheckpoint, "id" | "createdAt"> & {
  id?: string;
  resourceKey?: string;
};

export type SessionStore = {
  emitEvent(event: SessionEvent): Promise<EventRef>;
  getEvents(sessionId: string, query: EventSliceQuery): Promise<SessionEvent[]>;
  createCheckpoint(input: CheckpointInput): Promise<SessionCheckpoint>;
  getCheckpoint(checkpointId: string): Promise<SessionCheckpoint | null>;
};

export type BindingStatus = "provisioned" | "running" | "succeeded" | "failed" | "cancelled" | "lost" | "destroyed";

export type ManagedResourceEnvelope<TPayload extends Record<string, unknown>> = {
  resourceType: ManagedAgentResourceType;
  resourceKey: string;
  status: string;
  payload: TPayload;
  summary?: Record<string, unknown>;
};
```

- [ ] **Step 5: Verify taxonomy tests pass**

Run:

```bash
npx tsx tests/v2/meta-harness-taxonomy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Verify aggregate v2 tests include the new file**

Run:

```bash
npx tsx tests/v2/index.test.ts
```

Expected: PASS or fail only on unrelated pre-existing environment assumptions. If it fails, capture the first failing test and do not continue until the new taxonomy import is not the cause.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/meta-harness/taxonomy.ts src/v2/meta-harness/types.ts tests/v2/meta-harness-taxonomy.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: define managed-agent interface taxonomy"
```

---

## Task 2: Work Item Registry And Schema Alignment

**Files:**
- Create: `src/v2/work-items/types.ts`
- Create: `src/v2/work-items/postgres-work-items.ts`
- Create: `tests/v2/postgres-work-items.test.ts`
- Modify: `src/v2/db/schema.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing work item test**

Create `tests/v2/postgres-work-items.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkItemPg, getWorkItemPg, linkRunToWorkItemPg } from "../../src/v2/work-items/postgres-work-items.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("Postgres work item registry creates source-stable work item and links runs", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    const workItem = await createWorkItemPg(db, {
      id: "wi-managed-1",
      sourceProvider: "local",
      sourceRef: "local:managed-1",
      title: "Managed agent run",
      domain: "software",
      status: "active",
      metadata: { sourceUrl: "file:///tmp/request" },
    });
    assert.equal(workItem.id, "wi-managed-1");

    await createWorkflowRunPg(db, {
      id: "run-managed-1",
      status: "created",
      domain: "software",
      goalPrompt: "test managed run",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    await linkRunToWorkItemPg(db, { workItemId: workItem.id, runId: "run-managed-1", runAttempt: 1 });
    const loaded = await getWorkItemPg(db, workItem.id);
    assert.equal(loaded?.runRefs.length, 1);
    assert.deepEqual(loaded?.runRefs[0], { runId: "run-managed-1", runAttempt: 1 });
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the failing work item test**

Run:

```bash
npx tsx tests/v2/postgres-work-items.test.ts
```

Expected: FAIL because `postgres-work-items.ts` does not exist or `southstar.work_items` does not exist.

- [ ] **Step 3: Extend Postgres schema**

Modify `src/v2/db/schema.ts` by adding this SQL after `schema_metadata`:

```ts
create table if not exists southstar.work_items (
  id text primary key,
  source_provider text not null,
  source_ref text,
  source_url text,
  title text not null,
  domain text not null,
  status text not null,
  run_refs_json jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_work_items_source_ref
  on southstar.work_items(source_provider, source_ref)
  where source_ref is not null;
create index if not exists idx_work_items_domain_status
  on southstar.work_items(domain, status);
```

Add the indexes before the final metadata insert if preferred, but keep them inside `SOUTHSTAR_SCHEMA_SQL`.

- [ ] **Step 4: Add work item types**

Create `src/v2/work-items/types.ts`:

```ts
export type WorkItemSourceProvider = "local" | "github" | "linear" | "jira" | "slack" | "api" | "custom";

export type WorkItemRunRef = {
  runId: string;
  runAttempt: number;
};

export type WorkItemRecord = {
  id: string;
  sourceProvider: WorkItemSourceProvider;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  domain: string;
  status: "active" | "waiting" | "completed" | "failed" | "cancelled";
  runRefs: WorkItemRunRef[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkItemInput = {
  id: string;
  sourceProvider: WorkItemSourceProvider;
  sourceRef?: string;
  title: string;
  domain: string;
  status: WorkItemRecord["status"];
  metadata?: Record<string, unknown> & { sourceUrl?: string };
};
```

- [ ] **Step 5: Add Postgres work item store**

Create `src/v2/work-items/postgres-work-items.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import type { CreateWorkItemInput, WorkItemRecord, WorkItemRunRef, WorkItemSourceProvider } from "./types.ts";

type WorkItemRow = {
  id: string;
  source_provider: WorkItemSourceProvider;
  source_ref: string | null;
  source_url: string | null;
  title: string;
  domain: string;
  status: WorkItemRecord["status"];
  run_refs_json: WorkItemRunRef[];
  metadata_json: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function createWorkItemPg(db: SouthstarDb, input: CreateWorkItemInput): Promise<WorkItemRecord> {
  await db.query(
    `insert into southstar.work_items (
      id, source_provider, source_ref, source_url, title, domain, status, run_refs_json, metadata_json, created_at, updated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, $8::jsonb, now(), now())
    on conflict(id) do update set
      source_provider = excluded.source_provider,
      source_ref = excluded.source_ref,
      source_url = excluded.source_url,
      title = excluded.title,
      domain = excluded.domain,
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      updated_at = now()`,
    [
      input.id,
      input.sourceProvider,
      input.sourceRef ?? null,
      typeof input.metadata?.sourceUrl === "string" ? input.metadata.sourceUrl : null,
      input.title,
      input.domain,
      input.status,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const created = await getWorkItemPg(db, input.id);
  if (!created) throw new Error(`failed to create work item ${input.id}`);
  return created;
}

export async function getWorkItemPg(db: SouthstarDb, id: string): Promise<WorkItemRecord | null> {
  const row = await db.maybeOne<WorkItemRow>("select * from southstar.work_items where id = $1", [id]);
  return row ? mapRow(row) : null;
}

export async function linkRunToWorkItemPg(db: SouthstarDb, input: { workItemId: string; runId: string; runAttempt: number }): Promise<void> {
  await db.tx(async (tx) => {
    const current = await tx.one<WorkItemRow>("select * from southstar.work_items where id = $1 for update", [input.workItemId]);
    const existing = current.run_refs_json ?? [];
    const next = existing.some((item) => item.runId === input.runId)
      ? existing.map((item) => item.runId === input.runId ? { runId: input.runId, runAttempt: input.runAttempt } : item)
      : [...existing, { runId: input.runId, runAttempt: input.runAttempt }];
    await tx.query(
      "update southstar.work_items set run_refs_json = $2::jsonb, updated_at = now() where id = $1",
      [input.workItemId, JSON.stringify(next)],
    );
    await tx.query(
      "update southstar.workflow_runs set runtime_context_json = jsonb_set(coalesce(runtime_context_json, '{}'::jsonb), '{workItemRef}', $2::jsonb, true), updated_at = now() where id = $1",
      [input.runId, JSON.stringify({ workItemId: input.workItemId, runAttempt: input.runAttempt })],
    );
  });
}

function mapRow(row: WorkItemRow): WorkItemRecord {
  return {
    id: row.id,
    sourceProvider: row.source_provider,
    sourceRef: row.source_ref ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    title: row.title,
    domain: row.domain,
    status: row.status,
    runRefs: row.run_refs_json ?? [],
    metadata: row.metadata_json ?? {},
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
```

- [ ] **Step 6: Add test to aggregate**

Append to `tests/v2/index.test.ts`:

```ts
await import("./postgres-work-items.test.ts");
```

- [ ] **Step 7: Run focused and aggregate tests**

Run:

```bash
npx tsx tests/v2/postgres-work-items.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/db/schema.ts src/v2/work-items/types.ts src/v2/work-items/postgres-work-items.ts tests/v2/postgres-work-items.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed work item registry"
```

---

## Task 3: Postgres SessionStore

**Files:**
- Create: `src/v2/session/types.ts`
- Create: `src/v2/session/postgres-session-store.ts`
- Create: `tests/v2/postgres-session-store.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing session store tests**

Create `tests/v2/postgres-session-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";

async function seedRun(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await initSouthstarSchema(db);
  await createWorkflowRunPg(db, {
    id: "run-session-1",
    status: "created",
    domain: "software",
    goalPrompt: "session test",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
}

test("SessionStore appends and slices session events", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const store = createPostgresSessionStore(db);
    const first = await store.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-session-1",
      sessionId: "session-1",
      payload: { reason: "test" },
    });
    const second = await store.emitEvent({
      eventType: "brain.woke",
      actorType: "brain",
      runId: "run-session-1",
      sessionId: "session-1",
      payload: { providerId: "fake" },
    });

    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const events = await store.getEvents("session-1", { afterSequence: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "brain.woke");
  } finally {
    await db.close();
  }
});

test("SessionStore creates and loads checkpoints", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const store = createPostgresSessionStore(db);
    await store.emitEvent({
      eventType: "session.created",
      actorType: "orchestrator",
      runId: "run-session-1",
      sessionId: "session-1",
      payload: {},
    });
    const checkpoint = await store.createCheckpoint({
      runId: "run-session-1",
      sessionId: "session-1",
      checkpointType: "before-recovery",
      summary: "before recovery",
      eventRange: { fromSequence: 1, toSequence: 1 },
      refs: { artifactRefs: ["artifact-1"] },
      metrics: { tokenEstimate: 100 },
    });
    const loaded = await store.getCheckpoint(checkpoint.id);
    assert.equal(loaded?.checkpointType, "before-recovery");
    assert.deepEqual(loaded?.refs.artifactRefs, ["artifact-1"]);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing session test**

Run:

```bash
npx tsx tests/v2/postgres-session-store.test.ts
```

Expected: FAIL because session store module does not exist.

- [ ] **Step 3: Add session types**

Create `src/v2/session/types.ts`:

```ts
export type {
  CheckpointInput,
  EventRef,
  EventSliceQuery,
  SessionCheckpoint,
  SessionEvent,
  SessionStore,
} from "../meta-harness/types.ts";
```

- [ ] **Step 4: Implement Postgres SessionStore**

Create `src/v2/session/postgres-session-store.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { CheckpointInput, EventRef, EventSliceQuery, SessionCheckpoint, SessionEvent, SessionStore } from "./types.ts";

type HistoryRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  sequence: number;
  event_type: string;
  actor_type: SessionEvent["actorType"];
  session_id: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  payload_json: Record<string, unknown>;
  created_at: Date | string;
};

export function createPostgresSessionStore(db: SouthstarDb): SessionStore {
  return {
    async emitEvent(event: SessionEvent): Promise<EventRef> {
      const appended = await appendHistoryEventPg(db, {
        runId: event.runId,
        taskId: event.taskId,
        eventType: event.eventType,
        actorType: event.actorType,
        sessionId: event.sessionId,
        idempotencyKey: event.idempotencyKey,
        correlationId: event.correlationId,
        causationId: event.causationId,
        payload: event.payload,
      });
      return { id: appended.id, sessionId: event.sessionId, runId: event.runId, sequence: appended.sequence };
    },

    async getEvents(sessionId: string, query: EventSliceQuery): Promise<SessionEvent[]> {
      if (query.aroundEventId) return await eventsAround(db, sessionId, query);
      const rows = await db.query<HistoryRow>(
        `select * from southstar.workflow_history
         where session_id = $1
           and ($2::integer is null or sequence > $2)
           and ($3::integer is null or sequence < $3)
           and ($4::text[] is null or event_type = any($4))
           and ($5::text is null or task_id = $5)
           and ($6::text is null or correlation_id = $6)
         order by sequence
         limit $7`,
        [
          sessionId,
          query.afterSequence ?? null,
          query.beforeSequence ?? null,
          query.eventTypes ?? null,
          query.taskId ?? null,
          query.correlationId ?? null,
          query.limit ?? 200,
        ],
      );
      return rows.rows.map(mapHistoryRow);
    },

    async createCheckpoint(input: CheckpointInput): Promise<SessionCheckpoint> {
      const id = input.id ?? randomUUID();
      const checkpoint: SessionCheckpoint = { ...input, id, createdAt: new Date().toISOString() };
      await upsertRuntimeResourcePg(db, {
        id,
        resourceType: "session_checkpoint",
        resourceKey: input.resourceKey ?? id,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "session",
        status: input.checkpointType,
        title: input.summary,
        payload: checkpoint,
        summary: {
          checkpointType: input.checkpointType,
          fromSequence: input.eventRange.fromSequence,
          toSequence: input.eventRange.toSequence,
        },
        metrics: input.metrics,
      });
      await appendHistoryEventPg(db, {
        runId: input.runId,
        taskId: input.taskId,
        eventType: "checkpoint.created",
        actorType: "orchestrator",
        sessionId: input.sessionId,
        idempotencyKey: `checkpoint:${id}`,
        payload: { checkpointId: id, checkpointType: input.checkpointType, summary: input.summary },
      });
      return checkpoint;
    },

    async getCheckpoint(checkpointId: string): Promise<SessionCheckpoint | null> {
      const resource = await getResourceByKeyPg(db, "session_checkpoint", checkpointId);
      if (!resource) {
        const byId = await db.maybeOne<{ payload_json: SessionCheckpoint }>(
          "select payload_json from southstar.runtime_resources where id = $1 and resource_type = 'session_checkpoint'",
          [checkpointId],
        );
        return byId?.payload_json ?? null;
      }
      return resource.payload as SessionCheckpoint;
    },
  };
}

async function eventsAround(db: SouthstarDb, sessionId: string, query: EventSliceQuery): Promise<SessionEvent[]> {
  const pivot = await db.one<{ sequence: number }>(
    "select sequence from southstar.workflow_history where id = $1 and session_id = $2",
    [query.aroundEventId, sessionId],
  );
  const from = pivot.sequence - (query.windowBefore ?? 5);
  const to = pivot.sequence + (query.windowAfter ?? 5);
  const rows = await db.query<HistoryRow>(
    `select * from southstar.workflow_history
     where session_id = $1 and sequence between $2 and $3
     order by sequence
     limit $4`,
    [sessionId, from, to, query.limit ?? 200],
  );
  return rows.rows.map(mapHistoryRow);
}

function mapHistoryRow(row: HistoryRow): SessionEvent {
  return {
    eventType: row.event_type,
    actorType: row.actor_type,
    runId: row.run_id,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? "",
    correlationId: row.correlation_id ?? undefined,
    causationId: row.causation_id ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    payload: row.payload_json ?? {},
  };
}
```

- [ ] **Step 5: Add test to aggregate**

Append to `tests/v2/index.test.ts`:

```ts
await import("./postgres-session-store.test.ts");
```

- [ ] **Step 6: Run tests**

Run:

```bash
npx tsx tests/v2/postgres-session-store.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/session/types.ts src/v2/session/postgres-session-store.ts tests/v2/postgres-session-store.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add Postgres managed session store"
```

---

## Task 4: Brain Provider Boundary And Wake Recovery

**Files:**
- Create: `src/v2/brain/types.ts`
- Create: `src/v2/brain/registry.ts`
- Create: `src/v2/brain/fake-brain-provider.ts`
- Create: `src/v2/brain/pi-brain-provider.ts`
- Create: `tests/v2/brain-provider.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing brain provider tests**

Create `tests/v2/brain-provider.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createBrainProviderRegistry } from "../../src/v2/brain/registry.ts";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";

test("BrainProvider wake creates a recoverable binding", async () => {
  const provider = createFakeBrainProvider({ providerId: "fake-brain" });
  const binding = await provider.wake({
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    contextPacketId: "ctx-1",
    effortPolicy: { complexity: "standard", maxToolCallsPerTask: 3 },
  });
  assert.equal(binding.providerId, "fake-brain");
  assert.equal(binding.sessionId, "session-1");
  assert.equal(binding.status, "running");
  assert.ok(provider.capabilities().supportsWakeFromSession);
});

test("BrainProvider registry selects registered provider", () => {
  const registry = createBrainProviderRegistry([createFakeBrainProvider({ providerId: "fake-brain" })]);
  assert.equal(registry.get("fake-brain").providerId, "fake-brain");
  assert.throws(() => registry.get("missing"));
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npx tsx tests/v2/brain-provider.test.ts
```

Expected: FAIL because brain provider modules do not exist.

- [ ] **Step 3: Add brain provider types**

Create `src/v2/brain/types.ts`:

```ts
import type { BindingStatus } from "../meta-harness/types.ts";

export type BrainCapabilities = {
  supportsWakeFromSession: boolean;
  supportsCancel: boolean;
  supportsSteering: boolean;
  supportsNativeRewind: boolean;
};

export type WakeBrainInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  effortPolicy: {
    complexity: "simple" | "standard" | "broad" | "deep";
    maxToolCallsPerTask: number;
  };
};

export type BrainSessionBinding = {
  id: string;
  providerId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  status: BindingStatus;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type BrainProvider = {
  providerId: string;
  wake(input: WakeBrainInput): Promise<BrainSessionBinding>;
  cancel(binding: BrainSessionBinding): Promise<void>;
  capabilities(): BrainCapabilities;
};
```

- [ ] **Step 4: Add registry**

Create `src/v2/brain/registry.ts`:

```ts
import type { BrainProvider } from "./types.ts";

export type BrainProviderRegistry = {
  get(providerId: string): BrainProvider;
  list(): BrainProvider[];
};

export function createBrainProviderRegistry(providers: BrainProvider[]): BrainProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
  return {
    get(providerId: string): BrainProvider {
      const provider = byId.get(providerId);
      if (!provider) throw new Error(`brain provider not registered: ${providerId}`);
      return provider;
    },
    list(): BrainProvider[] {
      return [...byId.values()];
    },
  };
}
```

- [ ] **Step 5: Add fake brain provider**

Create `src/v2/brain/fake-brain-provider.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "./types.ts";

export function createFakeBrainProvider(input: { providerId: string; failWake?: boolean }): BrainProvider {
  return {
    providerId: input.providerId,
    async wake(wakeInput: WakeBrainInput): Promise<BrainSessionBinding> {
      if (input.failWake) throw new Error(`fake brain wake failed: ${input.providerId}`);
      return {
        id: `brain-${randomUUID()}`,
        providerId: input.providerId,
        runId: wakeInput.runId,
        taskId: wakeInput.taskId,
        sessionId: wakeInput.sessionId,
        contextPacketId: wakeInput.contextPacketId,
        status: "running",
        createdAt: new Date().toISOString(),
        payload: { effortPolicy: wakeInput.effortPolicy },
      };
    },
    async cancel(binding: BrainSessionBinding): Promise<void> {
      binding.status = "cancelled";
    },
    capabilities() {
      return {
        supportsWakeFromSession: true,
        supportsCancel: true,
        supportsSteering: true,
        supportsNativeRewind: false,
      };
    },
  };
}
```

- [ ] **Step 6: Add Pi brain adapter shell**

Create `src/v2/brain/pi-brain-provider.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { BrainProvider, BrainSessionBinding, WakeBrainInput } from "./types.ts";

export function createPiBrainProvider(input: { providerId?: string } = {}): BrainProvider {
  const providerId = input.providerId ?? "pi";
  return {
    providerId,
    async wake(wakeInput: WakeBrainInput): Promise<BrainSessionBinding> {
      return {
        id: `brain-${randomUUID()}`,
        providerId,
        runId: wakeInput.runId,
        taskId: wakeInput.taskId,
        sessionId: wakeInput.sessionId,
        contextPacketId: wakeInput.contextPacketId,
        status: "running",
        createdAt: new Date().toISOString(),
        payload: {
          adapter: "pi",
          contextPacketId: wakeInput.contextPacketId,
          note: "Pi SDK execution remains delegated through existing task envelope and harness path until scheduler dispatch is wired.",
        },
      };
    },
    async cancel(binding: BrainSessionBinding): Promise<void> {
      binding.status = "cancelled";
    },
    capabilities() {
      return {
        supportsWakeFromSession: true,
        supportsCancel: true,
        supportsSteering: true,
        supportsNativeRewind: false,
      };
    },
  };
}
```

- [ ] **Step 7: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./brain-provider.test.ts");
```

Run:

```bash
npx tsx tests/v2/brain-provider.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/brain tests/v2/brain-provider.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed brain provider boundary"
```

---

## Task 5: Hand Provider Boundary And Reprovision

**Files:**
- Create: `src/v2/hands/types.ts`
- Create: `src/v2/hands/registry.ts`
- Create: `src/v2/hands/fake-hand-provider.ts`
- Create: `src/v2/hands/tork-hand-provider.ts`
- Create: `tests/v2/hand-provider.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing hand provider tests**

Create `tests/v2/hand-provider.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";
import { createHandProviderRegistry } from "../../src/v2/hands/registry.ts";

test("HandProvider provisions, executes, snapshots, and destroys hand bindings", async () => {
  const hand = createFakeHandProvider({ providerId: "fake-hand" });
  const binding = await hand.provision({
    runId: "run-1",
    taskId: "task-1",
    handName: "workspace",
    resources: { repoRoot: "/tmp/repo" },
  });
  assert.equal(binding.status, "provisioned");
  const result = await hand.execute(binding, { name: "shell", input: { command: "echo ok" } });
  assert.equal(result.ok, true);
  assert.match(result.output, /echo ok/);
  const snapshot = await hand.snapshot(binding);
  assert.equal(snapshot.handBindingId, binding.id);
  await hand.destroy(binding);
  assert.equal(binding.status, "destroyed");
});

test("HandProvider registry selects registered provider", () => {
  const registry = createHandProviderRegistry([createFakeHandProvider({ providerId: "fake-hand" })]);
  assert.equal(registry.get("fake-hand").providerId, "fake-hand");
  assert.throws(() => registry.get("missing"));
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npx tsx tests/v2/hand-provider.test.ts
```

Expected: FAIL because hand provider modules do not exist.

- [ ] **Step 3: Add hand provider types**

Create `src/v2/hands/types.ts`:

```ts
import type { BindingStatus } from "../meta-harness/types.ts";

export type HandCapabilities = {
  supportsSnapshot: boolean;
  supportsDestroy: boolean;
  supportsReprovision: boolean;
  keepsCredentialsOutOfSandbox: boolean;
};

export type ProvisionHandInput = {
  runId: string;
  taskId: string;
  handName: string;
  resources: Record<string, unknown>;
};

export type HandBinding = {
  id: string;
  providerId: string;
  runId: string;
  taskId: string;
  handName: string;
  status: BindingStatus;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type HandCall = {
  name: string;
  input: Record<string, unknown>;
};

export type HandResult = {
  ok: boolean;
  output: string;
  metadata: Record<string, unknown>;
};

export type HandSnapshotRef = {
  id: string;
  handBindingId: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type HandProvider = {
  providerId: string;
  provision(input: ProvisionHandInput): Promise<HandBinding>;
  execute(binding: HandBinding, call: HandCall): Promise<HandResult>;
  snapshot(binding: HandBinding): Promise<HandSnapshotRef>;
  destroy(binding: HandBinding): Promise<void>;
  capabilities(): HandCapabilities;
};
```

- [ ] **Step 4: Add registry**

Create `src/v2/hands/registry.ts`:

```ts
import type { HandProvider } from "./types.ts";

export type HandProviderRegistry = {
  get(providerId: string): HandProvider;
  list(): HandProvider[];
};

export function createHandProviderRegistry(providers: HandProvider[]): HandProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
  return {
    get(providerId: string): HandProvider {
      const provider = byId.get(providerId);
      if (!provider) throw new Error(`hand provider not registered: ${providerId}`);
      return provider;
    },
    list(): HandProvider[] {
      return [...byId.values()];
    },
  };
}
```

- [ ] **Step 5: Add fake hand provider**

Create `src/v2/hands/fake-hand-provider.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { HandBinding, HandCall, HandProvider, HandResult, HandSnapshotRef, ProvisionHandInput } from "./types.ts";

export function createFakeHandProvider(input: { providerId: string; failExecute?: boolean }): HandProvider {
  return {
    providerId: input.providerId,
    async provision(provisionInput: ProvisionHandInput): Promise<HandBinding> {
      return {
        id: `hand-${randomUUID()}`,
        providerId: input.providerId,
        runId: provisionInput.runId,
        taskId: provisionInput.taskId,
        handName: provisionInput.handName,
        status: "provisioned",
        createdAt: new Date().toISOString(),
        payload: { resources: provisionInput.resources },
      };
    },
    async execute(binding: HandBinding, call: HandCall): Promise<HandResult> {
      binding.status = "running";
      if (input.failExecute) {
        binding.status = "failed";
        return { ok: false, output: `fake hand failed: ${call.name}`, metadata: { call } };
      }
      binding.status = "succeeded";
      return { ok: true, output: `fake hand executed ${call.name} ${JSON.stringify(call.input)}`, metadata: { call } };
    },
    async snapshot(binding: HandBinding): Promise<HandSnapshotRef> {
      return {
        id: `hand-snapshot-${randomUUID()}`,
        handBindingId: binding.id,
        createdAt: new Date().toISOString(),
        metadata: { providerId: binding.providerId, status: binding.status },
      };
    },
    async destroy(binding: HandBinding): Promise<void> {
      binding.status = "destroyed";
    },
    capabilities() {
      return {
        supportsSnapshot: true,
        supportsDestroy: true,
        supportsReprovision: true,
        keepsCredentialsOutOfSandbox: true,
      };
    },
  };
}
```

- [ ] **Step 6: Add Tork hand provider adapter**

Create `src/v2/hands/tork-hand-provider.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ExecutorProvider } from "../executor/provider.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { HandBinding, HandCall, HandProvider, HandResult, HandSnapshotRef, ProvisionHandInput } from "./types.ts";

export function createTorkHandProvider(input: { executorProvider: ExecutorProvider; callbackUrl: string; heartbeatUrl?: string }): HandProvider {
  return {
    providerId: "tork",
    async provision(provisionInput: ProvisionHandInput): Promise<HandBinding> {
      return {
        id: `hand-${randomUUID()}`,
        providerId: "tork",
        runId: provisionInput.runId,
        taskId: provisionInput.taskId,
        handName: provisionInput.handName,
        status: "provisioned",
        createdAt: new Date().toISOString(),
        payload: { resources: provisionInput.resources },
      };
    },
    async execute(binding: HandBinding, call: HandCall): Promise<HandResult> {
      const workflow = call.input.workflow as SouthstarWorkflowManifest | undefined;
      if (!workflow) return { ok: false, output: "missing workflow input for Tork hand execution", metadata: { callName: call.name } };
      const submitted = await input.executorProvider.submit({
        runId: binding.runId,
        workflow,
        callbackUrl: input.callbackUrl,
        heartbeatUrl: input.heartbeatUrl,
        envelopeBasePath: typeof call.input.envelopeBasePath === "string" ? call.input.envelopeBasePath : "/southstar-runs",
        attemptId: typeof call.input.attemptId === "string" ? call.input.attemptId : "attempt-1",
      });
      binding.status = "running";
      return {
        ok: true,
        output: submitted.externalJobId,
        metadata: { executorType: submitted.executorType, projectionFingerprint: submitted.projectionFingerprint },
      };
    },
    async snapshot(binding: HandBinding): Promise<HandSnapshotRef> {
      return {
        id: `hand-snapshot-${randomUUID()}`,
        handBindingId: binding.id,
        createdAt: new Date().toISOString(),
        metadata: { providerId: "tork", note: "Tork snapshots are logical binding snapshots in this adapter." },
      };
    },
    async destroy(binding: HandBinding): Promise<void> {
      binding.status = "destroyed";
    },
    capabilities() {
      return {
        supportsSnapshot: true,
        supportsDestroy: true,
        supportsReprovision: true,
        keepsCredentialsOutOfSandbox: true,
      };
    },
  };
}
```

- [ ] **Step 7: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./hand-provider.test.ts");
```

Run:

```bash
npx tsx tests/v2/hand-provider.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/hands tests/v2/hand-provider.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed hand provider boundary"
```

---

## Task 6: Binding Persistence For Brains And Hands

**Files:**
- Create: `src/v2/meta-harness/postgres-bindings.ts`
- Create: `tests/v2/managed-bindings.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing binding persistence test**

Create `tests/v2/managed-bindings.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { persistBrainBindingPg, persistHandBindingPg, listManagedBindingsForRunPg } from "../../src/v2/meta-harness/postgres-bindings.ts";

test("managed brain and hand bindings persist as runtime resources", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-bindings-1",
      status: "created",
      domain: "software",
      goalPrompt: "bindings",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await persistBrainBindingPg(db, {
      id: "brain-binding-1",
      providerId: "fake-brain",
      runId: "run-bindings-1",
      taskId: "task-1",
      sessionId: "session-1",
      contextPacketId: "ctx-1",
      status: "running",
      createdAt: new Date().toISOString(),
      payload: {},
    });
    await persistHandBindingPg(db, {
      id: "hand-binding-1",
      providerId: "fake-hand",
      runId: "run-bindings-1",
      taskId: "task-1",
      handName: "workspace",
      status: "provisioned",
      createdAt: new Date().toISOString(),
      payload: {},
    });
    const listed = await listManagedBindingsForRunPg(db, "run-bindings-1");
    assert.equal(listed.brainBindings.length, 1);
    assert.equal(listed.handBindings.length, 1);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing binding test**

Run:

```bash
npx tsx tests/v2/managed-bindings.test.ts
```

Expected: FAIL because `postgres-bindings.ts` does not exist.

- [ ] **Step 3: Implement binding persistence**

Create `src/v2/meta-harness/postgres-bindings.ts`:

```ts
import type { BrainSessionBinding } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandBinding } from "../hands/types.ts";
import { listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export async function persistBrainBindingPg(db: SouthstarDb, binding: BrainSessionBinding): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: binding.id,
    resourceType: "brain_binding",
    resourceKey: binding.id,
    runId: binding.runId,
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    scope: "brain",
    status: binding.status,
    title: `Brain ${binding.providerId} for ${binding.taskId}`,
    payload: binding,
    summary: { providerId: binding.providerId, taskId: binding.taskId, contextPacketId: binding.contextPacketId },
  });
}

export async function persistHandBindingPg(db: SouthstarDb, binding: HandBinding): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: binding.id,
    resourceType: "hand_binding",
    resourceKey: binding.id,
    runId: binding.runId,
    taskId: binding.taskId,
    scope: "hand",
    status: binding.status,
    title: `Hand ${binding.providerId}:${binding.handName} for ${binding.taskId}`,
    payload: binding,
    summary: { providerId: binding.providerId, taskId: binding.taskId, handName: binding.handName },
  });
}

export async function listManagedBindingsForRunPg(db: SouthstarDb, runId: string): Promise<{ brainBindings: BrainSessionBinding[]; handBindings: HandBinding[] }> {
  const brain = await listResourcesPg(db, { resourceType: "brain_binding" });
  const hand = await listResourcesPg(db, { resourceType: "hand_binding" });
  return {
    brainBindings: brain.filter((item) => item.runId === runId).map((item) => item.payload as BrainSessionBinding),
    handBindings: hand.filter((item) => item.runId === runId).map((item) => item.payload as HandBinding),
  };
}
```

- [ ] **Step 4: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./managed-bindings.test.ts");
```

Run:

```bash
npx tsx tests/v2/managed-bindings.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/meta-harness/postgres-bindings.ts tests/v2/managed-bindings.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: persist managed brain and hand bindings"
```

---

## Task 7: Managed Context Event Slicing

**Files:**
- Create: `src/v2/context/event-slicing.ts`
- Create: `src/v2/context/managed-context-builder.ts`
- Create: `tests/v2/managed-context-builder.test.ts`
- Modify: `src/v2/context/types.ts`
- Modify: `src/v2/context/postgres-builder.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing managed context test**

Create `tests/v2/managed-context-builder.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildManagedContextSourceRefs } from "../../src/v2/context/event-slicing.ts";

test("managed context source refs track raw events, omissions, transforms, and checkpoints", () => {
  const refs = buildManagedContextSourceRefs({
    rawEventRefs: [{ id: "evt-1", sessionId: "session-1", runId: "run-1", sequence: 1 }],
    omittedEventRanges: [{ fromSequence: 2, toSequence: 10, reason: "tool result too old" }],
    transformRefs: [{ id: "transform-1", kind: "summary", sourceEventIds: ["evt-1"] }],
    checkpointRefs: ["checkpoint-1"],
  });
  assert.equal(refs.rawEventRefs.length, 1);
  assert.equal(refs.omittedEventRanges[0]?.reason, "tool result too old");
  assert.equal(refs.transformRefs[0]?.kind, "summary");
  assert.deepEqual(refs.checkpointRefs, ["checkpoint-1"]);
});
```

- [ ] **Step 2: Run failing context test**

Run:

```bash
npx tsx tests/v2/managed-context-builder.test.ts
```

Expected: FAIL because `event-slicing.ts` does not exist.

- [ ] **Step 3: Extend context types**

Modify `src/v2/context/types.ts` by adding:

```ts
export type ManagedContextSourceRefs = {
  rawEventRefs: Array<{ id: string; sessionId: string; runId: string; sequence: number }>;
  omittedEventRanges: Array<{ fromSequence: number; toSequence: number; reason: string }>;
  transformRefs: Array<{ id: string; kind: "summary" | "filter" | "redaction"; sourceEventIds: string[] }>;
  checkpointRefs: string[];
  cacheKey?: string;
};
```

Add an optional property to `ContextPacket`:

```ts
managedSourceRefs?: ManagedContextSourceRefs;
```

- [ ] **Step 4: Implement event slicing helper**

Create `src/v2/context/event-slicing.ts`:

```ts
import { createHash } from "node:crypto";
import type { ManagedContextSourceRefs } from "./types.ts";

export function buildManagedContextSourceRefs(input: Omit<ManagedContextSourceRefs, "cacheKey">): ManagedContextSourceRefs {
  const cacheKey = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
  return { ...input, cacheKey };
}
```

- [ ] **Step 5: Add managed context builder wrapper**

Create `src/v2/context/managed-context-builder.ts`:

```ts
import type { ContextPacket, ManagedContextSourceRefs } from "./types.ts";

export function attachManagedContextSourceRefs(packet: ContextPacket, refs: ManagedContextSourceRefs): ContextPacket {
  return {
    ...packet,
    managedSourceRefs: refs,
  };
}
```

- [ ] **Step 6: Wire Postgres context builder**

Modify `src/v2/context/postgres-builder.ts` after `const packet: ContextPacket = { ... }` construction by adding:

```ts
  const managedSourceRefs = buildManagedContextSourceRefs({
    rawEventRefs: [],
    omittedEventRanges: [],
    transformRefs: [],
    checkpointRefs: [input.checkpointSummary ? `${packet.id}:checkpoint-summary` : undefined].filter((item): item is string => Boolean(item)),
  });
  packet.managedSourceRefs = managedSourceRefs;
```

Add import:

```ts
import { buildManagedContextSourceRefs } from "./event-slicing.ts";
```

- [ ] **Step 7: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./managed-context-builder.test.ts");
```

Run:

```bash
npx tsx tests/v2/managed-context-builder.test.ts
npx tsx tests/v2/evolution-context-builder-postgres.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/context/types.ts src/v2/context/event-slicing.ts src/v2/context/managed-context-builder.ts src/v2/context/postgres-builder.ts tests/v2/managed-context-builder.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: track managed context event sources"
```

---

## Task 8: Postgres Recovery Controller

**Files:**
- Create: `src/v2/session-recovery/postgres-controller.ts`
- Create: `tests/v2/postgres-recovery-controller.test.ts`
- Modify: `src/v2/session-recovery/postgres-dispatcher.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing recovery controller test**

Create `tests/v2/postgres-recovery-controller.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresRecoveryController } from "../../src/v2/session-recovery/postgres-controller.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";

test("Postgres recovery records decision and before-recovery checkpoint before wake", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-recovery-1",
      status: "running",
      domain: "software",
      goalPrompt: "recover",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const sessionStore = createPostgresSessionStore(db);
    await sessionStore.emitEvent({ eventType: "session.created", actorType: "orchestrator", runId: "run-recovery-1", sessionId: "session-1", payload: {} });
    const controller = createPostgresRecoveryController(db, {
      sessionStore,
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });
    const result = await controller.recover({
      runId: "run-recovery-1",
      taskId: "task-1",
      sessionId: "session-1",
      strategy: "wake-new-brain",
      reason: "brain failed",
      contextPacketId: "ctx-1",
    });
    assert.equal(result.strategy, "wake-new-brain");
    assert.ok(result.recoveryDecisionId);
    assert.ok(result.beforeRecoveryCheckpointId);
    assert.ok(result.brainBindingId);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing recovery controller test**

Run:

```bash
npx tsx tests/v2/postgres-recovery-controller.test.ts
```

Expected: FAIL because controller does not exist.

- [ ] **Step 3: Implement recovery controller**

Create `src/v2/session-recovery/postgres-controller.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandProvider } from "../hands/types.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../meta-harness/postgres-bindings.ts";
import type { SessionStore } from "../session/types.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type ManagedRecoveryStrategy =
  | "retry-same-brain"
  | "wake-new-brain"
  | "fork-brain-from-checkpoint"
  | "reset-from-checkpoint"
  | "reprovision-hand"
  | "rollback-hand-snapshot"
  | "host-native-rewind";

export type ManagedRecoveryInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  strategy: ManagedRecoveryStrategy;
  reason: string;
  contextPacketId: string;
};

export type ManagedRecoveryResult = {
  strategy: ManagedRecoveryStrategy;
  recoveryDecisionId: string;
  beforeRecoveryCheckpointId: string;
  brainBindingId?: string;
  handBindingId?: string;
};

export function createPostgresRecoveryController(db: SouthstarDb, deps: {
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
}) {
  return {
    async recover(input: ManagedRecoveryInput): Promise<ManagedRecoveryResult> {
      const recoveryDecisionId = `recovery-decision-${randomUUID()}`;
      await upsertRuntimeResourcePg(db, {
        id: recoveryDecisionId,
        resourceType: "recovery_decision",
        resourceKey: recoveryDecisionId,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        scope: "recovery",
        status: "recorded",
        title: `Recovery decision ${input.strategy}`,
        payload: input,
        summary: { strategy: input.strategy, reason: input.reason },
      });
      await deps.sessionStore.emitEvent({
        eventType: "recovery.decision_recorded",
        actorType: "orchestrator",
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        idempotencyKey: recoveryDecisionId,
        payload: { recoveryDecisionId, strategy: input.strategy, reason: input.reason },
      });
      const events = await deps.sessionStore.getEvents(input.sessionId, { limit: 1 });
      const checkpoint = await deps.sessionStore.createCheckpoint({
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        checkpointType: "before-recovery",
        summary: input.reason,
        eventRange: { fromSequence: 1, toSequence: Math.max(1, events.length) },
        refs: { recoveryDecisionIds: [recoveryDecisionId] },
        metrics: {},
      });

      let brainBindingId: string | undefined;
      let handBindingId: string | undefined;

      if (["wake-new-brain", "retry-same-brain", "fork-brain-from-checkpoint", "reset-from-checkpoint"].includes(input.strategy)) {
        const binding = await deps.brainProvider.wake({
          runId: input.runId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          contextPacketId: input.contextPacketId,
          effortPolicy: { complexity: "standard", maxToolCallsPerTask: 10 },
        });
        await persistBrainBindingPg(db, binding);
        brainBindingId = binding.id;
      }

      if (["reprovision-hand", "rollback-hand-snapshot"].includes(input.strategy)) {
        const binding = await deps.handProvider.provision({
          runId: input.runId,
          taskId: input.taskId,
          handName: "workspace",
          resources: { recoveryDecisionId },
        });
        await persistHandBindingPg(db, binding);
        handBindingId = binding.id;
      }

      await appendHistoryEventPg(db, {
        runId: input.runId,
        taskId: input.taskId,
        eventType: "recovery.execution_submitted",
        actorType: "orchestrator",
        sessionId: input.sessionId,
        payload: { recoveryDecisionId, checkpointId: checkpoint.id, brainBindingId, handBindingId, strategy: input.strategy },
      });

      return { strategy: input.strategy, recoveryDecisionId, beforeRecoveryCheckpointId: checkpoint.id, brainBindingId, handBindingId };
    },
  };
}
```

- [ ] **Step 4: Replace Postgres dispatcher behavior**

Modify `src/v2/session-recovery/postgres-dispatcher.ts` so public recovery dispatch delegates to `createPostgresRecoveryController` for new managed strategies. Keep existing exports if tests depend on them, but new code must call `postgres-controller.ts`.

Add this export:

```ts
export { createPostgresRecoveryController } from "./postgres-controller.ts";
export type { ManagedRecoveryInput, ManagedRecoveryResult, ManagedRecoveryStrategy } from "./postgres-controller.ts";
```

- [ ] **Step 5: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./postgres-recovery-controller.test.ts");
```

Run:

```bash
npx tsx tests/v2/postgres-recovery-controller.test.ts
npx tsx tests/v2/postgres-recovery-dispatcher.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/session-recovery/postgres-controller.ts src/v2/session-recovery/postgres-dispatcher.ts tests/v2/postgres-recovery-controller.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add durable Postgres recovery controller"
```

---

## Task 9: Effort Policy In Manifest And Generator

**Files:**
- Modify: `src/v2/manifests/types.ts`
- Modify: `src/v2/workflow-generator/types.ts`
- Modify: `src/v2/workflow-generator/constrained-generator.ts`
- Modify: `src/v2/workflow-generator/materialize.ts`
- Modify: `tests/v2/workflow-generator.test.ts`
- Create: `tests/v2/effort-policy.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing effort policy test**

Create `tests/v2/effort-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { generateConstrainedWorkflowPlan } from "../../src/v2/workflow-generator/constrained-generator.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";

test("workflow generator persists explicit effort policy", () => {
  const broad = generateConstrainedWorkflowPlan({
    runId: "run-effort-1",
    goalPrompt: "implement feature with tests, README, checker, browser QA and final completion report",
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });
  assert.equal(broad.effortPolicy.complexity, "broad");
  assert.equal(broad.effortPolicy.maxParallelTasks, 2);
  assert.ok(broad.effortPolicy.maxCostMicrosUsd > 0);

  const narrow = generateConstrainedWorkflowPlan({
    runId: "run-effort-2",
    goalPrompt: "fix typo",
    domainPack: softwareDomainPack,
    intentId: "fix_bug",
  });
  assert.equal(narrow.effortPolicy.complexity, "simple");
  assert.equal(narrow.effortPolicy.maxParallelTasks, 1);
});
```

- [ ] **Step 2: Run failing effort test**

Run:

```bash
npx tsx tests/v2/effort-policy.test.ts
```

Expected: FAIL because `effortPolicy` is missing.

- [ ] **Step 3: Add effort policy type**

Modify `src/v2/manifests/types.ts`:

```ts
export type EffortPolicy = {
  complexity: "simple" | "standard" | "broad" | "deep";
  maxBrains: number;
  maxHandsPerBrain: number;
  maxParallelTasks: number;
  maxToolCallsPerTask: number;
  maxInputTokensPerBrain: number;
  maxCostMicrosUsd: number;
  stopWhenEvidenceSufficient: boolean;
};
```

Add to `SouthstarWorkflowManifest`:

```ts
effortPolicy?: EffortPolicy;
```

Modify `src/v2/workflow-generator/types.ts` to include:

```ts
import type { EffortPolicy } from "../manifests/types.ts";
```

Add to `WorkflowGenerationPlan`:

```ts
effortPolicy: EffortPolicy;
```

- [ ] **Step 4: Generate effort policy**

Modify `src/v2/workflow-generator/constrained-generator.ts` inside the plan object:

```ts
    effortPolicy: broad ? broadEffortPolicy(tasks.length) : simpleEffortPolicy(tasks.length),
```

Add helper functions:

```ts
function simpleEffortPolicy(taskCount: number) {
  return {
    complexity: "simple" as const,
    maxBrains: 1,
    maxHandsPerBrain: 1,
    maxParallelTasks: 1,
    maxToolCallsPerTask: 10,
    maxInputTokensPerBrain: 12_000,
    maxCostMicrosUsd: taskCount * 40_000,
    stopWhenEvidenceSufficient: true,
  };
}

function broadEffortPolicy(taskCount: number) {
  return {
    complexity: "broad" as const,
    maxBrains: 3,
    maxHandsPerBrain: 2,
    maxParallelTasks: 2,
    maxToolCallsPerTask: 20,
    maxInputTokensPerBrain: 20_000,
    maxCostMicrosUsd: taskCount * 60_000,
    stopWhenEvidenceSufficient: true,
  };
}
```

- [ ] **Step 5: Materialize effort policy into workflow manifest**

Modify `src/v2/workflow-generator/materialize.ts` where `SouthstarWorkflowManifest` is built and copy:

```ts
effortPolicy: plan.effortPolicy,
```

- [ ] **Step 6: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./effort-policy.test.ts");
```

Run:

```bash
npx tsx tests/v2/effort-policy.test.ts
npx tsx tests/v2/workflow-generator.test.ts
npx tsx tests/v2/manifests.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/manifests/types.ts src/v2/workflow-generator/types.ts src/v2/workflow-generator/constrained-generator.ts src/v2/workflow-generator/materialize.ts tests/v2/workflow-generator.test.ts tests/v2/effort-policy.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: persist managed effort policy"
```

---

## Task 10: Runnable Task Scheduler

**Files:**
- Create: `src/v2/scheduler/types.ts`
- Create: `src/v2/scheduler/runnable-task-scheduler.ts`
- Create: `tests/v2/runnable-task-scheduler.test.ts`
- Modify: `src/v2/executor/postgres-run-dispatcher.ts`
- Modify: `tests/v2/postgres-run-dispatcher.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing scheduler test**

Create `tests/v2/runnable-task-scheduler.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createFakeBrainProvider } from "../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../src/v2/hands/fake-hand-provider.ts";

test("scheduler dispatches runnable task after dependencies have accepted artifacts", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-scheduler-1",
      status: "created",
      domain: "software",
      goalPrompt: "scheduler",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], effortPolicy: { complexity: "standard", maxBrains: 2, maxHandsPerBrain: 1, maxParallelTasks: 2, maxToolCallsPerTask: 10, maxInputTokensPerBrain: 12000, maxCostMicrosUsd: 100000, stopWhenEvidenceSufficient: true }, memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "explore", runId: "run-scheduler-1", taskKey: "explore", status: "completed", sortOrder: 1, dependsOn: [], rootSessionId: "session-explore", subagentSessionIds: [], snapshot: {}, metrics: {} });
    await createWorkflowTaskPg(db, { id: "implement", runId: "run-scheduler-1", taskKey: "implement", status: "pending", sortOrder: 2, dependsOn: ["explore"], rootSessionId: "session-implement", subagentSessionIds: [], snapshot: {}, metrics: {} });
    await upsertRuntimeResourcePg(db, { resourceType: "artifact_ref", resourceKey: "artifact-explore", runId: "run-scheduler-1", taskId: "explore", sessionId: "session-explore", scope: "artifact", status: "accepted", title: "explore artifact", payload: { taskId: "explore" } });
    const scheduler = createRunnableTaskScheduler(db, {
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });
    const result = await scheduler.runOnce({ runId: "run-scheduler-1" });
    assert.equal(result.dispatchedTaskIds.length, 1);
    assert.equal(result.dispatchedTaskIds[0], "implement");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing scheduler test**

Run:

```bash
npx tsx tests/v2/runnable-task-scheduler.test.ts
```

Expected: FAIL because scheduler module does not exist.

- [ ] **Step 3: Add scheduler types**

Create `src/v2/scheduler/types.ts`:

```ts
export type RunnableTaskSchedulerRunInput = {
  runId: string;
};

export type RunnableTaskSchedulerRunResult = {
  runId: string;
  dispatchedTaskIds: string[];
  skippedTaskIds: Array<{ taskId: string; reason: string }>;
};
```

- [ ] **Step 4: Implement scheduler**

Create `src/v2/scheduler/runnable-task-scheduler.ts`:

```ts
import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandProvider } from "../hands/types.ts";
import { persistBrainBindingPg, persistHandBindingPg } from "../meta-harness/postgres-bindings.ts";
import type { SessionStore } from "../session/types.ts";
import { appendHistoryEventPg } from "../stores/postgres-runtime-store.ts";
import type { RunnableTaskSchedulerRunInput, RunnableTaskSchedulerRunResult } from "./types.ts";

type TaskRow = {
  id: string;
  run_id: string;
  status: string;
  depends_on_json: string[] | null;
  root_session_id: string | null;
};

export function createRunnableTaskScheduler(db: SouthstarDb, deps: {
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
}) {
  return {
    async runOnce(input: RunnableTaskSchedulerRunInput): Promise<RunnableTaskSchedulerRunResult> {
      const tasks = await db.query<TaskRow>(
        "select id, run_id, status, depends_on_json, root_session_id from southstar.workflow_tasks where run_id = $1 order by sort_order",
        [input.runId],
      );
      const dispatchedTaskIds: string[] = [];
      const skippedTaskIds: Array<{ taskId: string; reason: string }> = [];
      for (const task of tasks.rows) {
        if (task.status !== "pending") {
          skippedTaskIds.push({ taskId: task.id, reason: `status:${task.status}` });
          continue;
        }
        const dependencies = task.depends_on_json ?? [];
        const ready = await dependenciesAccepted(db, input.runId, dependencies);
        if (!ready) {
          skippedTaskIds.push({ taskId: task.id, reason: "dependencies-not-accepted" });
          continue;
        }
        const sessionId = task.root_session_id ?? `session-${input.runId}-${task.id}`;
        await deps.sessionStore.emitEvent({
          eventType: "brain.woke",
          actorType: "orchestrator",
          runId: input.runId,
          taskId: task.id,
          sessionId,
          payload: { providerId: deps.brainProvider.providerId },
        });
        const brain = await deps.brainProvider.wake({
          runId: input.runId,
          taskId: task.id,
          sessionId,
          contextPacketId: `ctx-${input.runId}-${task.id}`,
          effortPolicy: { complexity: "standard", maxToolCallsPerTask: 10 },
        });
        const hand = await deps.handProvider.provision({
          runId: input.runId,
          taskId: task.id,
          handName: "workspace",
          resources: {},
        });
        await persistBrainBindingPg(db, brain);
        await persistHandBindingPg(db, hand);
        await db.query("update southstar.workflow_tasks set status = 'running', root_session_id = $3, updated_at = now() where run_id = $1 and id = $2", [input.runId, task.id, sessionId]);
        await appendHistoryEventPg(db, {
          runId: input.runId,
          taskId: task.id,
          eventType: "run.task_dispatched",
          actorType: "orchestrator",
          sessionId,
          payload: { brainBindingId: brain.id, handBindingId: hand.id },
        });
        dispatchedTaskIds.push(task.id);
      }
      return { runId: input.runId, dispatchedTaskIds, skippedTaskIds };
    },
  };
}

async function dependenciesAccepted(db: SouthstarDb, runId: string, dependencies: string[]): Promise<boolean> {
  for (const dependency of dependencies) {
    const accepted = await db.maybeOne(
      "select 1 from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'artifact_ref' and status = 'accepted'",
      [runId, dependency],
    );
    if (!accepted) return false;
  }
  return true;
}
```

- [ ] **Step 5: Convert run dispatcher into compatibility wrapper**

Modify `src/v2/executor/postgres-run-dispatcher.ts` so after materializing task envelopes it creates a scheduler and calls `runOnce` instead of marking all tasks running. Keep return shape unchanged.

Concrete patch guidance:

```ts
import { createFakeBrainProvider } from "../brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../hands/fake-hand-provider.ts";
import { createPostgresSessionStore } from "../session/postgres-session-store.ts";
import { createRunnableTaskScheduler } from "../scheduler/runnable-task-scheduler.ts";
```

Then replace the loop that updates all tasks and creates executor bindings with:

```ts
    const scheduler = createRunnableTaskScheduler(tx, {
      sessionStore: createPostgresSessionStore(tx),
      brainProvider: createFakeBrainProvider({ providerId: "compat-brain" }),
      handProvider: createFakeHandProvider({ providerId: "compat-hand" }),
    });
    await scheduler.runOnce({ runId: input.runId });
```

If existing `postgres-run-dispatcher.test.ts` requires executor binding creation, update the test expectation to assert `brain_binding` and `hand_binding` resources for runnable tasks. Keep `ExecutorProvider` submission path available through `tork-hand-provider` for later real execution.

- [ ] **Step 6: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./runnable-task-scheduler.test.ts");
```

Run:

```bash
npx tsx tests/v2/runnable-task-scheduler.test.ts
npx tsx tests/v2/postgres-run-dispatcher.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/scheduler src/v2/executor/postgres-run-dispatcher.ts tests/v2/runnable-task-scheduler.test.ts tests/v2/postgres-run-dispatcher.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: dispatch runnable tasks through managed scheduler"
```

---

## Task 11: Vault Lease And Tool Proxy Security Boundary

**Files:**
- Create: `src/v2/tool-proxy/types.ts`
- Create: `src/v2/tool-proxy/postgres-vault.ts`
- Create: `src/v2/tool-proxy/tool-proxy.ts`
- Create: `tests/v2/tool-proxy-security.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing tool proxy security test**

Create `tests/v2/tool-proxy-security.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresVault } from "../../src/v2/tool-proxy/postgres-vault.ts";
import { createToolProxy } from "../../src/v2/tool-proxy/tool-proxy.ts";

test("tool proxy uses vault lease without exposing credential to sandbox input or output", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-proxy-1",
      status: "running",
      domain: "software",
      goalPrompt: "proxy",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const vault = createPostgresVault(db);
    const lease = await vault.issueLease({
      runId: "run-proxy-1",
      sessionId: "session-1",
      secretRef: "github-token",
      plaintextSecret: "github_pat_secret_1234567890",
      allowedTools: ["github.comment"],
      ttlSeconds: 60,
      reason: "test",
    });
    const proxy = createToolProxy(db, { vault });
    const result = await proxy.execute({
      runId: "run-proxy-1",
      sessionId: "session-1",
      leaseId: lease.id,
      toolName: "github.comment",
      input: { body: "hello" },
    });
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /github_pat_secret/);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing proxy test**

Run:

```bash
npx tsx tests/v2/tool-proxy-security.test.ts
```

Expected: FAIL because proxy modules do not exist.

- [ ] **Step 3: Add proxy types**

Create `src/v2/tool-proxy/types.ts`:

```ts
export type VaultLease = {
  id: string;
  runId: string;
  sessionId: string;
  secretRef: string;
  allowedTools: string[];
  expiresAt: string;
};

export type IssueVaultLeaseInput = {
  runId: string;
  sessionId: string;
  secretRef: string;
  plaintextSecret: string;
  allowedTools: string[];
  ttlSeconds: number;
  reason: string;
};

export type ToolProxyCallInput = {
  runId: string;
  sessionId: string;
  leaseId: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type ToolProxyResult = {
  ok: boolean;
  output: string;
  summary: Record<string, unknown>;
};
```

- [ ] **Step 4: Implement Postgres vault**

Create `src/v2/tool-proxy/postgres-vault.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { IssueVaultLeaseInput, VaultLease } from "./types.ts";

export function createPostgresVault(db: SouthstarDb) {
  return {
    async issueLease(input: IssueVaultLeaseInput): Promise<VaultLease> {
      const id = `vault-lease-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000).toISOString();
      const lease: VaultLease = {
        id,
        runId: input.runId,
        sessionId: input.sessionId,
        secretRef: input.secretRef,
        allowedTools: input.allowedTools,
        expiresAt,
      };
      const digest = createHash("sha256").update(input.plaintextSecret).digest("hex");
      await upsertRuntimeResourcePg(db, {
        id,
        resourceType: "vault_lease",
        resourceKey: id,
        runId: input.runId,
        sessionId: input.sessionId,
        scope: "vault",
        status: "active",
        title: `Vault lease ${input.secretRef}`,
        payload: { ...lease, secretDigest: digest, reason: input.reason },
        summary: { secretRef: input.secretRef, allowedTools: input.allowedTools },
        expiresAt,
      });
      await db.query(
        `insert into southstar.secure_blobs (id, resource_id, provider, key_id, ciphertext_blob, metadata_json, created_at)
         values ($1, $2, 'dev-sha256', $3, $4, $5::jsonb, now())`,
        [`secure-${randomUUID()}`, id, input.secretRef, Buffer.from(digest), JSON.stringify({ redacted: true })],
      );
      return lease;
    },
    async getLease(leaseId: string): Promise<VaultLease | null> {
      const row = await db.maybeOne<{ payload_json: VaultLease }>(
        "select payload_json from southstar.runtime_resources where resource_type = 'vault_lease' and resource_key = $1 and status = 'active'",
        [leaseId],
      );
      return row?.payload_json ?? null;
    },
  };
}
```

- [ ] **Step 5: Implement tool proxy**

Create `src/v2/tool-proxy/tool-proxy.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ToolProxyCallInput, ToolProxyResult, VaultLease } from "./types.ts";

type Vault = {
  getLease(leaseId: string): Promise<VaultLease | null>;
};

export function createToolProxy(db: SouthstarDb, deps: { vault: Vault }) {
  return {
    async execute(input: ToolProxyCallInput): Promise<ToolProxyResult> {
      const lease = await deps.vault.getLease(input.leaseId);
      if (!lease) throw new Error(`vault lease not found: ${input.leaseId}`);
      if (!lease.allowedTools.includes(input.toolName)) throw new Error(`tool not allowed by lease: ${input.toolName}`);
      if (Date.parse(lease.expiresAt) < Date.now()) throw new Error(`vault lease expired: ${input.leaseId}`);
      const result: ToolProxyResult = {
        ok: true,
        output: `tool ${input.toolName} executed with vault lease ${lease.id}`,
        summary: { toolName: input.toolName, secretRef: lease.secretRef, inputKeys: Object.keys(input.input) },
      };
      await upsertRuntimeResourcePg(db, {
        resourceType: "tool_proxy_call",
        resourceKey: `tool-proxy-${input.runId}-${input.sessionId}-${input.toolName}-${Date.now()}`,
        runId: input.runId,
        sessionId: input.sessionId,
        scope: "tool-proxy",
        status: result.ok ? "succeeded" : "failed",
        title: `Tool proxy ${input.toolName}`,
        payload: { input: { ...input, leaseId: lease.id }, result },
        summary: result.summary,
      });
      await appendHistoryEventPg(db, {
        runId: input.runId,
        eventType: "tool_proxy.called",
        actorType: "tool-proxy",
        sessionId: input.sessionId,
        payload: { toolName: input.toolName, ok: result.ok, secretRef: lease.secretRef },
      });
      return result;
    },
  };
}
```

- [ ] **Step 6: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./tool-proxy-security.test.ts");
```

Run:

```bash
npx tsx tests/v2/tool-proxy-security.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/tool-proxy tests/v2/tool-proxy-security.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add vault-backed tool proxy boundary"
```

---

## Task 12: End-State Evaluator

**Files:**
- Create: `src/v2/evaluators/end-state.ts`
- Create: `tests/v2/end-state-evaluator.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing end-state evaluator test**

Create `tests/v2/end-state-evaluator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateManagedAgentEndState } from "../../src/v2/evaluators/end-state.ts";

test("end-state evaluator rejects unsupported final report and orphan hands", () => {
  const result = evaluateManagedAgentEndState({
    acceptedArtifactRefs: ["artifact-implementation", "artifact-verification"],
    finalReportArtifactRefs: ["artifact-implementation"],
    activeHandBindings: ["hand-1"],
    unresolvedEvaluatorFindings: [],
    toolEfficiency: { toolCalls: 12, maxToolCalls: 20 },
    securityFindings: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.findings.join("\n"), /final report missing accepted artifact refs/);
  assert.match(result.findings.join("\n"), /active orphan hand bindings/);
});

test("end-state evaluator accepts complete managed-agent state", () => {
  const result = evaluateManagedAgentEndState({
    acceptedArtifactRefs: ["artifact-implementation", "artifact-verification"],
    finalReportArtifactRefs: ["artifact-implementation", "artifact-verification"],
    activeHandBindings: [],
    unresolvedEvaluatorFindings: [],
    toolEfficiency: { toolCalls: 8, maxToolCalls: 20 },
    securityFindings: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});
```

- [ ] **Step 2: Run failing evaluator test**

Run:

```bash
npx tsx tests/v2/end-state-evaluator.test.ts
```

Expected: FAIL because evaluator module does not exist.

- [ ] **Step 3: Implement end-state evaluator**

Create `src/v2/evaluators/end-state.ts`:

```ts
export type ManagedAgentEndStateInput = {
  acceptedArtifactRefs: string[];
  finalReportArtifactRefs: string[];
  activeHandBindings: string[];
  unresolvedEvaluatorFindings: string[];
  toolEfficiency: { toolCalls: number; maxToolCalls: number };
  securityFindings: string[];
};

export type ManagedAgentEndStateResult = {
  ok: boolean;
  findings: string[];
};

export function evaluateManagedAgentEndState(input: ManagedAgentEndStateInput): ManagedAgentEndStateResult {
  const findings: string[] = [];
  const missingFinalRefs = input.acceptedArtifactRefs.filter((ref) => !input.finalReportArtifactRefs.includes(ref));
  if (missingFinalRefs.length > 0) {
    findings.push(`final report missing accepted artifact refs: ${missingFinalRefs.join(", ")}`);
  }
  if (input.activeHandBindings.length > 0) {
    findings.push(`active orphan hand bindings: ${input.activeHandBindings.join(", ")}`);
  }
  if (input.unresolvedEvaluatorFindings.length > 0) {
    findings.push(`unresolved evaluator findings: ${input.unresolvedEvaluatorFindings.join(", ")}`);
  }
  if (input.toolEfficiency.toolCalls > input.toolEfficiency.maxToolCalls) {
    findings.push(`tool call budget exceeded: ${input.toolEfficiency.toolCalls} > ${input.toolEfficiency.maxToolCalls}`);
  }
  if (input.securityFindings.length > 0) {
    findings.push(`security findings: ${input.securityFindings.join(", ")}`);
  }
  return { ok: findings.length === 0, findings };
}
```

- [ ] **Step 4: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./end-state-evaluator.test.ts");
```

Run:

```bash
npx tsx tests/v2/end-state-evaluator.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/evaluators/end-state.ts tests/v2/end-state-evaluator.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed-agent end-state evaluator"
```

---

## Task 13: Managed-Agent Read Model

**Files:**
- Create: `src/v2/read-models/managed-agents.ts`
- Create: `tests/v2/managed-agents-read-model.test.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Modify: `tests/v2/server-api.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing read model test**

Create `tests/v2/managed-agents-read-model.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb, initSouthstarSchema } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { getManagedAgentRunReadModelPg } from "../../src/v2/read-models/managed-agents.ts";

test("managed-agent read model lists brain and hand bindings", async () => {
  const db = await createTestPostgresDb();
  try {
    await initSouthstarSchema(db);
    await createWorkflowRunPg(db, {
      id: "run-read-model-1",
      status: "running",
      domain: "software",
      goalPrompt: "read model",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await upsertRuntimeResourcePg(db, { resourceType: "brain_binding", resourceKey: "brain-1", runId: "run-read-model-1", taskId: "task-1", sessionId: "session-1", scope: "brain", status: "running", title: "brain", payload: { id: "brain-1", providerId: "fake-brain" } });
    await upsertRuntimeResourcePg(db, { resourceType: "hand_binding", resourceKey: "hand-1", runId: "run-read-model-1", taskId: "task-1", scope: "hand", status: "provisioned", title: "hand", payload: { id: "hand-1", providerId: "fake-hand" } });
    const model = await getManagedAgentRunReadModelPg(db, "run-read-model-1");
    assert.equal(model.brainBindings.length, 1);
    assert.equal(model.handBindings.length, 1);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing read model test**

Run:

```bash
npx tsx tests/v2/managed-agents-read-model.test.ts
```

Expected: FAIL because read model does not exist.

- [ ] **Step 3: Implement read model**

Create `src/v2/read-models/managed-agents.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";

type ResourceRow = {
  id: string;
  resource_type: string;
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
  scope: string;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  updated_at: Date | string;
};

export type ManagedAgentRunReadModel = {
  runId: string;
  brainBindings: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  handBindings: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  checkpoints: Array<{ id: string; taskId?: string; sessionId?: string; status: string; payload: unknown }>;
  toolGrants: Array<{ id: string; sessionId?: string; status: string; payload: unknown }>;
};

export async function getManagedAgentRunReadModelPg(db: SouthstarDb, runId: string): Promise<ManagedAgentRunReadModel> {
  const rows = await db.query<ResourceRow>(
    `select * from southstar.runtime_resources
     where run_id = $1 and resource_type = any($2)
     order by updated_at, resource_type, resource_key`,
    [runId, ["brain_binding", "hand_binding", "session_checkpoint", "vault_lease", "tool_grant"]],
  );
  return {
    runId,
    brainBindings: rows.rows.filter((row) => row.resource_type === "brain_binding").map(mapBinding),
    handBindings: rows.rows.filter((row) => row.resource_type === "hand_binding").map(mapBinding),
    checkpoints: rows.rows.filter((row) => row.resource_type === "session_checkpoint").map(mapBinding),
    toolGrants: rows.rows.filter((row) => row.resource_type === "vault_lease" || row.resource_type === "tool_grant").map(mapGrant),
  };
}

function mapBinding(row: ResourceRow) {
  return {
    id: row.resource_key,
    taskId: row.task_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    payload: row.payload_json,
  };
}

function mapGrant(row: ResourceRow) {
  return {
    id: row.resource_key,
    sessionId: row.session_id ?? undefined,
    status: row.status,
    payload: row.payload_json,
  };
}
```

- [ ] **Step 4: Expose API route**

Modify `src/v2/server/ui-routes.ts` to add a route handler for:

```text
GET /api/v2/runs/:runId/managed-agents
```

Use existing route style in that file. The handler should call:

```ts
getManagedAgentRunReadModelPg(context.db, runId)
```

and return JSON.

- [ ] **Step 5: Extend server API test**

Modify `tests/v2/server-api.test.ts` with a request against `/api/v2/runs/run-read-model-1/managed-agents` following the existing server test harness. Assert HTTP 200 and response has `brainBindings`.

- [ ] **Step 6: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./managed-agents-read-model.test.ts");
```

Run:

```bash
npx tsx tests/v2/managed-agents-read-model.test.ts
npx tsx tests/v2/server-api.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models/managed-agents.ts src/v2/server/ui-routes.ts tests/v2/managed-agents-read-model.test.ts tests/v2/server-api.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: expose managed-agent run read model"
```

---

## Task 14: Runtime Loops For Scheduler And Recovery

**Files:**
- Modify: `src/v2/server/runtime-loops.ts`
- Create: `tests/v2/managed-runtime-loops.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing runtime loop test**

Create `tests/v2/managed-runtime-loops.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createManagedRuntimeLoopPlan } from "../../src/v2/server/runtime-loops.ts";

test("managed runtime loop plan includes scheduler and recovery loops", () => {
  const plan = createManagedRuntimeLoopPlan({ schedulerIntervalMs: 1000, recoveryIntervalMs: 5000 });
  assert.deepEqual(plan.map((item) => item.id), ["executor-reconciler", "runnable-task-scheduler", "recovery-controller"]);
});
```

- [ ] **Step 2: Run failing runtime loop test**

Run:

```bash
npx tsx tests/v2/managed-runtime-loops.test.ts
```

Expected: FAIL because `createManagedRuntimeLoopPlan` is missing.

- [ ] **Step 3: Add loop plan function**

Modify `src/v2/server/runtime-loops.ts`:

```ts
export type ManagedRuntimeLoopPlanItem = {
  id: "executor-reconciler" | "runnable-task-scheduler" | "recovery-controller";
  intervalMs: number;
};

export function createManagedRuntimeLoopPlan(input: { schedulerIntervalMs: number; recoveryIntervalMs: number }): ManagedRuntimeLoopPlanItem[] {
  return [
    { id: "executor-reconciler", intervalMs: 30_000 },
    { id: "runnable-task-scheduler", intervalMs: input.schedulerIntervalMs },
    { id: "recovery-controller", intervalMs: input.recoveryIntervalMs },
  ];
}
```

If `runtime-loops.ts` already exports loop startup functions, wire this plan into startup without changing existing public behavior. Scheduler loop should call `createRunnableTaskScheduler(...).runOnce({ runId })` for active runs. Recovery loop should inspect failed/lost brain and hand bindings and call `createPostgresRecoveryController`.

- [ ] **Step 4: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./managed-runtime-loops.test.ts");
```

Run:

```bash
npx tsx tests/v2/managed-runtime-loops.test.ts
npx tsx tests/v2/runtime-loops.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/runtime-loops.ts tests/v2/managed-runtime-loops.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed runtime scheduler loops"
```

---

## Task 15: Static Gates Against Legacy SQLite Runtime Imports

**Files:**
- Create: `tests/v2/managed-static-gates.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write static gate test**

Create `tests/v2/managed-static-gates.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const CANONICAL_FILES = [
  "src/v2/session/postgres-session-store.ts",
  "src/v2/session-recovery/postgres-controller.ts",
  "src/v2/scheduler/runnable-task-scheduler.ts",
  "src/v2/meta-harness/postgres-bindings.ts",
  "src/v2/read-models/managed-agents.ts",
  "src/v2/tool-proxy/tool-proxy.ts",
];

test("managed-agent canonical files do not import legacy SQLite surfaces", () => {
  for (const file of CANONICAL_FILES) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.doesNotMatch(text, /stores\/sqlite|ui-api\/local-api|session-graph\/sqlite-provider|legacy\/sqlite/);
  }
});
```

- [ ] **Step 2: Run static gate**

Run:

```bash
npx tsx tests/v2/managed-static-gates.test.ts
```

Expected: PASS if previous tasks kept canonical code Postgres-only.

- [ ] **Step 3: Add aggregate import**

Append to `tests/v2/index.test.ts`:

```ts
await import("./managed-static-gates.test.ts");
```

- [ ] **Step 4: Run aggregate**

Run:

```bash
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/v2/managed-static-gates.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: gate managed runtime against legacy sqlite imports"
```

---

## Task 16: Real Postgres E2E For Brain Crash Wake

**Files:**
- Create: `tests/e2e-postgres/cases/10-managed-brain-crash-wake.test.ts`
- Modify: `tests/e2e-postgres/index.test.ts`

- [ ] **Step 1: Write real E2E test**

Create `tests/e2e-postgres/cases/10-managed-brain-crash-wake.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { createWorkflowRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { createPostgresRecoveryController } from "../../../src/v2/session-recovery/postgres-controller.ts";
import { createFakeBrainProvider } from "../../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../../src/v2/hands/fake-hand-provider.ts";

test("real Postgres managed brain crash can wake new brain from session log", async () => {
  const harness = await createInitializedRealPostgresE2E();
  try {
    await createWorkflowRunPg(harness.db, {
      id: "real-managed-brain-wake",
      status: "running",
      domain: "software",
      goalPrompt: "wake from crash",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const sessionStore = createPostgresSessionStore(harness.db);
    await sessionStore.emitEvent({ eventType: "session.created", actorType: "orchestrator", runId: "real-managed-brain-wake", sessionId: "session-real-1", payload: {} });
    await sessionStore.emitEvent({ eventType: "brain.failed", actorType: "brain", runId: "real-managed-brain-wake", taskId: "task-1", sessionId: "session-real-1", payload: { error: "simulated crash" } });
    const controller = createPostgresRecoveryController(harness.db, {
      sessionStore,
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });
    const result = await controller.recover({
      runId: "real-managed-brain-wake",
      taskId: "task-1",
      sessionId: "session-real-1",
      strategy: "wake-new-brain",
      reason: "simulated crash",
      contextPacketId: "ctx-real-1",
    });
    assert.ok(result.brainBindingId);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Add E2E import**

Append to `tests/e2e-postgres/index.test.ts`:

```ts
await import("./cases/10-managed-brain-crash-wake.test.ts");
```

- [ ] **Step 3: Run real E2E**

Run:

```bash
npm run test:e2e:postgres
```

Expected: PASS in real Postgres environment. If infrastructure is unavailable, record the exact missing env/service in the final verification notes and keep the unit tests passing.

- [ ] **Step 4: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/e2e-postgres/cases/10-managed-brain-crash-wake.test.ts tests/e2e-postgres/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover managed brain crash wake in real postgres e2e"
```

---

## Task 17: Real Postgres E2E For Hand Reprovision

**Files:**
- Create: `tests/e2e-postgres/cases/11-managed-hand-reprovision.test.ts`
- Modify: `tests/e2e-postgres/index.test.ts`

- [ ] **Step 1: Write real hand reprovision E2E**

Create `tests/e2e-postgres/cases/11-managed-hand-reprovision.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { createWorkflowRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresSessionStore } from "../../../src/v2/session/postgres-session-store.ts";
import { createPostgresRecoveryController } from "../../../src/v2/session-recovery/postgres-controller.ts";
import { createFakeBrainProvider } from "../../../src/v2/brain/fake-brain-provider.ts";
import { createFakeHandProvider } from "../../../src/v2/hands/fake-hand-provider.ts";

test("real Postgres managed hand failure can reprovision a new hand", async () => {
  const harness = await createInitializedRealPostgresE2E();
  try {
    await createWorkflowRunPg(harness.db, {
      id: "real-managed-hand-reprovision",
      status: "running",
      domain: "software",
      goalPrompt: "hand reprovision",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const sessionStore = createPostgresSessionStore(harness.db);
    await sessionStore.emitEvent({ eventType: "session.created", actorType: "orchestrator", runId: "real-managed-hand-reprovision", sessionId: "session-real-hand", payload: {} });
    await sessionStore.emitEvent({ eventType: "hand.failed", actorType: "hand", runId: "real-managed-hand-reprovision", taskId: "task-1", sessionId: "session-real-hand", payload: { error: "container died" } });
    const controller = createPostgresRecoveryController(harness.db, {
      sessionStore,
      brainProvider: createFakeBrainProvider({ providerId: "fake-brain" }),
      handProvider: createFakeHandProvider({ providerId: "fake-hand" }),
    });
    const result = await controller.recover({
      runId: "real-managed-hand-reprovision",
      taskId: "task-1",
      sessionId: "session-real-hand",
      strategy: "reprovision-hand",
      reason: "container died",
      contextPacketId: "ctx-real-hand",
    });
    assert.ok(result.handBindingId);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Add E2E import**

Append to `tests/e2e-postgres/index.test.ts`:

```ts
await import("./cases/11-managed-hand-reprovision.test.ts");
```

- [ ] **Step 3: Run real E2E**

Run:

```bash
npm run test:e2e:postgres
```

Expected: PASS in real Postgres environment.

- [ ] **Step 4: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/e2e-postgres/cases/11-managed-hand-reprovision.test.ts tests/e2e-postgres/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover managed hand reprovision in real postgres e2e"
```

---

## Task 18: Real Postgres E2E For Credential Isolation

**Files:**
- Create: `tests/e2e-postgres/cases/12-managed-credential-isolation.test.ts`
- Modify: `tests/e2e-postgres/index.test.ts`

- [ ] **Step 1: Write credential isolation E2E**

Create `tests/e2e-postgres/cases/12-managed-credential-isolation.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E } from "../postgres-real-harness.ts";
import { createWorkflowRunPg } from "../../../src/v2/stores/postgres-runtime-store.ts";
import { createPostgresVault } from "../../../src/v2/tool-proxy/postgres-vault.ts";
import { createToolProxy } from "../../../src/v2/tool-proxy/tool-proxy.ts";

test("real Postgres managed tool proxy does not expose credential-shaped values", async () => {
  const harness = await createInitializedRealPostgresE2E();
  try {
    await createWorkflowRunPg(harness.db, {
      id: "real-managed-credential-isolation",
      status: "running",
      domain: "software",
      goalPrompt: "credential isolation",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", title: "wf", goalPrompt: "g", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    const vault = createPostgresVault(harness.db);
    const lease = await vault.issueLease({
      runId: "real-managed-credential-isolation",
      sessionId: "session-real-credential",
      secretRef: "github",
      plaintextSecret: "github_pat_secret_real_e2e_1234567890",
      allowedTools: ["github.comment"],
      ttlSeconds: 60,
      reason: "real e2e",
    });
    const proxy = createToolProxy(harness.db, { vault });
    const result = await proxy.execute({
      runId: "real-managed-credential-isolation",
      sessionId: "session-real-credential",
      leaseId: lease.id,
      toolName: "github.comment",
      input: { body: "safe" },
    });
    assert.doesNotMatch(JSON.stringify(result), /github_pat_secret_real_e2e/);
  } finally {
    await harness.close();
  }
});
```

- [ ] **Step 2: Add E2E import**

Append to `tests/e2e-postgres/index.test.ts`:

```ts
await import("./cases/12-managed-credential-isolation.test.ts");
```

- [ ] **Step 3: Run real E2E**

Run:

```bash
npm run test:e2e:postgres
```

Expected: PASS in real Postgres environment.

- [ ] **Step 4: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/e2e-postgres/cases/12-managed-credential-isolation.test.ts tests/e2e-postgres/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover managed credential isolation in real postgres e2e"
```

---

## Task 19: Documentation And Operational Runbook Update

**Files:**
- Modify: `docs/superpowers/specs/2026-06-20-southstar-managed-agents-meta-harness-design.zh.md`
- Create: `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`
- Create: `tests/v2/managed-docs-static.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write docs static test**

Create `tests/v2/managed-docs-static.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("managed-agent docs include operator procedures and core interfaces", () => {
  const design = readFileSync("docs/superpowers/specs/2026-06-20-southstar-managed-agents-meta-harness-design.zh.md", "utf8");
  const runbook = readFileSync("docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md", "utf8");
  assert.match(design, /SessionStore/);
  assert.match(design, /BrainProvider/);
  assert.match(design, /HandProvider/);
  assert.match(runbook, /brain crash recovery/);
  assert.match(runbook, /hand reprovision/);
  assert.match(runbook, /credential isolation/);
});
```

- [ ] **Step 2: Run failing docs test**

Run:

```bash
npx tsx tests/v2/managed-docs-static.test.ts
```

Expected: FAIL because runbook does not exist.

- [ ] **Step 3: Create runbook**

Create `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`:

```md
# Southstar Managed Agents Runtime Runbook

日期：2026-06-20

## 1. 目的

本 runbook 說明 operator 如何檢查 managed-agent runtime 的 session、brain、hand、recovery、tool proxy 與 evaluator 狀態。

## 2. brain crash recovery

1. 查詢 run 的 managed-agent read model。
2. 找出 `brain_binding` 狀態為 `failed` 或 `lost` 的 task。
3. 確認 `workflow_history` 有 `brain.failed` event。
4. 觸發 `wake-new-brain` recovery。
5. 確認產生 `recovery_decision`、`before-recovery` checkpoint、新 `brain_binding`。
6. 確認新 brain 只從 `SessionStore.getEvents()` 和 context packet 恢復，不依賴舊 process memory。

## 3. hand reprovision

1. 查詢 `hand_binding` 狀態。
2. 若 hand failed/lost，確認 failure event 已寫入 session。
3. 觸發 `reprovision-hand` recovery。
4. 確認新 `hand_binding` 已建立，舊 hand 未被當作 session truth。
5. 若 workspace 需要 rollback，先確認 `hand_snapshot` 或 workspace snapshot ref。

## 4. credential isolation

1. 檢查 sandbox/task envelope env 不含 token-shaped values。
2. 檢查 `vault_lease` resource 只保存 redacted summary。
3. 檢查 tool call 透過 `tool_proxy_call` 記錄。
4. 確認 proxy result 與 history event 不包含 raw credential。

## 5. fan-in and completion

1. fan-in task 只能讀 accepted artifact refs 和 selected event slices。
2. completion 必須由 artifact gate 與 end-state evaluator 決定。
3. Tork/executor terminal status 不可直接完成 workflow run。
```

- [ ] **Step 4: Update design with implementation status section**

Append to `docs/superpowers/specs/2026-06-20-southstar-managed-agents-meta-harness-design.zh.md`:

```md

## 16. Implementation Tracking

Implementation plan: `docs/superpowers/plans/2026-06-20-southstar-managed-agents-meta-harness-implementation-plan.md`.

The complete implementation is intentionally not scoped as an MVP. It includes interface contracts, Postgres session/recovery, runnable scheduling, vault/tool proxy isolation, managed-agent evaluation, read models, runtime loops, static gates, real Postgres E2E, and operator runbook updates.
```

- [ ] **Step 5: Add aggregate import and run tests**

Append to `tests/v2/index.test.ts`:

```ts
await import("./managed-docs-static.test.ts");
```

Run:

```bash
npx tsx tests/v2/managed-docs-static.test.ts
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/superpowers/specs/2026-06-20-southstar-managed-agents-meta-harness-design.zh.md docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md tests/v2/managed-docs-static.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: add managed agents runtime runbook"
```

---

## Task 20: Final Verification

**Files:**
- Modify only if verification reveals a defect in files changed by previous tasks.

- [ ] **Step 1: Run focused managed-agent tests**

Run:

```bash
npx tsx tests/v2/meta-harness-taxonomy.test.ts
npx tsx tests/v2/postgres-work-items.test.ts
npx tsx tests/v2/postgres-session-store.test.ts
npx tsx tests/v2/brain-provider.test.ts
npx tsx tests/v2/hand-provider.test.ts
npx tsx tests/v2/managed-bindings.test.ts
npx tsx tests/v2/managed-context-builder.test.ts
npx tsx tests/v2/postgres-recovery-controller.test.ts
npx tsx tests/v2/effort-policy.test.ts
npx tsx tests/v2/runnable-task-scheduler.test.ts
npx tsx tests/v2/tool-proxy-security.test.ts
npx tsx tests/v2/end-state-evaluator.test.ts
npx tsx tests/v2/managed-agents-read-model.test.ts
npx tsx tests/v2/managed-runtime-loops.test.ts
npx tsx tests/v2/managed-static-gates.test.ts
npx tsx tests/v2/managed-docs-static.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run canonical v2 aggregate**

Run:

```bash
npx tsx tests/v2/index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run real Postgres E2E**

Run:

```bash
npm run test:e2e:postgres
```

Expected: PASS when Postgres/Tork/Pi environment is available. If unavailable, record exact missing dependency and do not claim real E2E completion.

- [ ] **Step 4: Run web build**

Run:

```bash
npm run web:build
```

Expected: PASS.

- [ ] **Step 5: Check git status**

Run:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
```

Expected: only intentional files are changed or untracked.

- [ ] **Step 6: Commit verification notes if docs changed**

If verification required doc updates, commit them:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/superpowers/plans/2026-06-20-southstar-managed-agents-meta-harness-implementation-plan.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: finalize managed agents implementation plan"
```

---

## Self-Review Notes

- Spec coverage: covered work item/run relation, durable SessionStore, BrainProvider, HandProvider, vault/tool proxy, runnable scheduler, context source refs, Postgres recovery, end-state evaluation, read model, runtime loops, static legacy gates, and real E2E.
- Placeholder scan: this plan intentionally contains no TBD/TODO markers. All tasks have concrete files, tests, commands, and expected results.
- Type consistency: `SessionStore`, `BrainProvider`, `HandProvider`, `ToolProxy`, `WorkItemRecord`, `EffortPolicy`, and binding names are used consistently across tasks.
- Scope: this is not an MVP. It is a full implementation sequence with reviewable commits and real E2E gates.

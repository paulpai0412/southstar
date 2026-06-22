# Southstar Managed Context Session Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical managed context path so every normal and recovery task attempt receives a persisted `ContextPacket`/`TaskEnvelopeV2` assembled from session history, checkpoints, artifact refs, run-local memory, approved long-term memory, and recovery evidence.

**Architecture:** Add a three-unit context assembly path: `ContextSourceBuilder`, `ContextAssemblyPolicy`, and `ManagedContextAssembler`. Scheduler becomes the only Tork submit path, recovery applier only mutates durable state, callback ingestion writes memory/lineage evidence, and legacy recovery direct-submit is removed from production runtime.

**Tech Stack:** TypeScript ESM, Node.js `node:test`, Postgres runtime resources/history, existing Southstar v2 stores, Tork/Pi real E2E harness.

---

## Source Spec

Implement against:

- `docs/superpowers/specs/2026-06-22-southstar-managed-context-session-memory-design.zh.md`

Do not reintroduce SQLite, V1/Northstar runtime paths, whole-workflow Tork submit recovery, or UI/browser E2E.

## Repo Commands

Use the repo-local git metadata:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short --branch --untracked-files=all
```

Each task below lists exact `git add` and `git commit` commands for that task.

Run Postgres-backed tests with:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Run real E2E cases one at a time:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT="${PI_HARNESS_ENDPOINT:?set PI_HARNESS_ENDPOINT to the local Pi harness URL}" \
SOUTHSTAR_CALLBACK_HOST=172.17.0.1 \
npm run test:e2e:postgres:25
```

## File Structure

Create:

- `src/v2/context/source-builder.ts`
  Collects Postgres session/artifact/checkpoint/memory/failure/workspace candidates and maps them into context candidates.
- `src/v2/context/assembly-policy.ts`
  Applies filtering, ranking, token budget, rollback/reset invalidation, source refs, and credential validation.
- `src/v2/context/managed-context-assembler.ts`
  Orchestrates source builder + policy, builds `ContextPacket` + `TaskEnvelopeV2`, persists `context_packet`, `task_envelope`, and `context_assembly_trace`.
- `src/v2/memory/postgres-memory-service.ts`
  Implements run-local memory, pending long-term memory deltas, approval promotion, retrieval, and invalidation.
- `src/v2/memory/writeback-policy.ts`
  Converts callback/evaluator findings into run-local memory and long-term `memory_delta` candidates.
- `src/v2/artifacts/lineage.ts`
  Resolves producer/consumer artifact lineage and creates repair markers without mutating immutable artifact payloads.
- `src/v2/session-recovery/session-operations.ts`
  Helpers for fork/reset/rollback session decisions, rollback markers, and affected task selection.
- `tests/v2/managed-context-contracts.test.ts`
- `tests/v2/postgres-memory-service.test.ts`
- `tests/v2/context-assembly-policy.test.ts`
- `tests/v2/context-source-builder.test.ts`
- `tests/v2/managed-context-assembler.test.ts`
- `tests/v2/managed-context-scheduler.test.ts`
- `tests/v2/callback-memory-writeback.test.ts`
- `tests/v2/session-recovery-operations.test.ts`
- `tests/v2/legacy-recovery-dispatcher-removal.test.ts`
- `tests/e2e-postgres/cases/25-normal-context-session-memory-flow.test.ts`
- `tests/e2e-postgres/cases/26-abnormal-context-session-memory-recovery.test.ts`

Modify:

- `src/v2/context/types.ts`
- `src/v2/exceptions/types.ts`
- `src/v2/exceptions/runtime-exception-controller.ts`
- `src/v2/exceptions/recovery-decision-applier.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/scheduler/runnable-task-scheduler.ts`
- `src/v2/ui-api/postgres-task-envelope.ts`
- `src/v2/read-models/postgres-core.ts`
- `src/v2/read-models/managed-agents.ts`
- `src/v2/server/routes.ts`
- `src/v2/server/runtime-loops.ts`
- `tests/v2/index.test.ts`
- `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- `tests/e2e-postgres/README.md`
- `package.json`

Delete or remove from production runtime:

- `src/v2/session-recovery/postgres-dispatcher.ts`
- `tests/v2/postgres-recovery-dispatcher.test.ts`
- `/api/v2/runs/:runId/recovery/dispatch` route.

---

### Task 1: Managed Context Contracts

**Files:**
- Modify: `src/v2/context/types.ts`
- Modify: `src/v2/exceptions/types.ts`
- Create: `tests/v2/managed-context-contracts.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing contract test**

Create `tests/v2/managed-context-contracts.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
  type ContextAssemblyTrace,
  type ContextBlockCandidate,
  type ManagedContextSourceRefs,
} from "../../src/v2/context/types.ts";
import type { RecoveryPath, RuntimeExceptionKind } from "../../src/v2/exceptions/types.ts";

test("managed context contracts expose attempt lineage, trace, memory refs, and rollback refs", () => {
  const candidate: ContextBlockCandidate = {
    id: "candidate-memory-1",
    sourceType: "memory",
    title: "Repair hint",
    text: "Validator failure can be repaired by updating tests.",
    sourceRef: "memory_item:run-local:1",
    tokenEstimate: 12,
    score: 0.8,
    lineage: {
      runId: "run-1",
      taskId: "implement",
      sessionId: "session-1",
      attemptId: "implement-attempt-2",
      handExecutionId: "hand-execution:run-1:implement:implement-attempt-2",
      contextPacketId: "ctx-run-1-implement-attempt-2",
      taskEnvelopeId: "task-envelope-run-1-implement-attempt-2",
      artifactRefIds: ["artifact_ref:run-1:producer"],
      checkpointId: "checkpoint-1",
    },
  };

  assert.equal(candidate.lineage?.attemptId, "implement-attempt-2");
  assert.equal(candidate.score, 0.8);

  const refs: ManagedContextSourceRefs = {
    rawEventRefs: [{ id: "event-1", sessionId: "session-1", runId: "run-1", sequence: 1 }],
    omittedEventRanges: [{ fromSequence: 2, toSequence: 4, reason: "reset-session excluded failed suffix" }],
    transformRefs: [{ id: "summary-1", kind: "summary", sourceEventIds: ["event-1"] }],
    checkpointRefs: ["checkpoint-1"],
    artifactRefs: ["artifact_ref:run-1:producer"],
    memoryRefs: ["memory_item:run-local:1"],
    rollbackMarkerRefs: ["rollback-marker-1"],
    cacheKey: "stable",
  };

  assert.deepEqual(refs.artifactRefs, ["artifact_ref:run-1:producer"]);
  assert.deepEqual(refs.memoryRefs, ["memory_item:run-local:1"]);
  assert.deepEqual(refs.rollbackMarkerRefs, ["rollback-marker-1"]);

  const trace: ContextAssemblyTrace = {
    schemaVersion: CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
    traceId: "context-trace-run-1-implement-attempt-2",
    runId: "run-1",
    taskId: "implement",
    sessionId: "session-1",
    attemptId: "implement-attempt-2",
    handExecutionId: "hand-execution:run-1:implement:implement-attempt-2",
    contextPacketId: "ctx-run-1-implement-attempt-2",
    taskEnvelopeId: "task-envelope-run-1-implement-attempt-2",
    selectedSourceRefs: ["memory_item:run-local:1"],
    excludedCandidates: [{ sourceRef: "memory_delta:pending-1", reason: "scope-mismatch", tokenEstimate: 20 }],
    tokenEstimate: { total: 12, bySourceType: { memory: 12 } },
    validation: { ok: true, errors: [] },
    createdAt: "2026-06-22T00:00:00.000Z",
  };

  assert.equal(trace.validation.ok, true);
  assert.equal(trace.schemaVersion, "southstar.context_assembly_trace.v1");
});

test("runtime exception contracts include managed context recovery paths", () => {
  const path: RecoveryPath = "reset-session";
  const rollbackPath: RecoveryPath = "rollback-session";
  const exceptionKind: RuntimeExceptionKind = "validation_failed";
  assert.equal(path, "reset-session");
  assert.equal(rollbackPath, "rollback-session");
  assert.equal(exceptionKind, "validation_failed");
});
```

Add to `tests/v2/index.test.ts` after `managed-context-builder.test.ts`:

```ts
await import("./managed-context-contracts.test.ts");
```

- [ ] **Step 2: Run the failing contract test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because `ContextBlockCandidate`, `ContextAssemblyTrace`, new source refs, `validation_failed`, `reset-session`, `fork-session`, and `rollback-session` are not defined.

- [ ] **Step 3: Add context contract types**

In `src/v2/context/types.ts`, extend `ManagedContextSourceRefs` and add trace/candidate types:

```ts
export const CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE = "context_assembly_trace";
export const CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION = "southstar.context_assembly_trace.v1";

export type AttemptLineageRefs = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId?: string;
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefIds?: string[];
  checkpointId?: string;
  correlationId?: string;
  causationId?: string;
};

export type ContextBlockCandidate = ContextBlock & {
  score: number;
  confidence?: number;
  successScore?: number;
  recencyScore?: number;
  lineage?: AttemptLineageRefs;
};

export type ContextAssemblyValidation = {
  ok: boolean;
  errors: Array<{ code: string; message: string; sourceRef?: string }>;
};

export type ContextAssemblyTrace = {
  schemaVersion: typeof CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION;
  traceId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  contextPacketId: string;
  taskEnvelopeId: string;
  selectedSourceRefs: string[];
  excludedCandidates: ContextExclusion[];
  tokenEstimate: TokenEstimate;
  validation: ContextAssemblyValidation;
  rollbackMarkerRefs?: string[];
  resetMarkerRefs?: string[];
  createdAt: string;
};
```

Update `ManagedContextSourceRefs`:

```ts
export type ManagedContextSourceRefs = {
  rawEventRefs: Array<{ id: string; sessionId: string; runId: string; sequence: number }>;
  omittedEventRanges: Array<{ fromSequence: number; toSequence: number; reason: string }>;
  transformRefs: Array<{ id: string; kind: "summary" | "filter" | "redaction"; sourceEventIds: string[] }>;
  checkpointRefs: string[];
  artifactRefs?: string[];
  memoryRefs?: string[];
  rollbackMarkerRefs?: string[];
  resetMarkerRefs?: string[];
  cacheKey?: string;
};
```

- [ ] **Step 4: Add recovery path and exception kind contracts**

In `src/v2/exceptions/types.ts`, add to `RUNTIME_EXCEPTION_KINDS`:

```ts
"validation_failed",
"context_assembly_failed",
```

Add to `RecoveryPath`:

```ts
| "fork-session"
| "reset-session"
| "rollback-session"
```

- [ ] **Step 5: Run the contract test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `managed-context-contracts.test.ts`; other failures are task-local regressions to fix before committing.

- [ ] **Step 6: Commit contracts**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/context/types.ts src/v2/exceptions/types.ts tests/v2/managed-context-contracts.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed context contracts"
```

---

### Task 2: Postgres Memory Service

**Files:**
- Create: `src/v2/memory/postgres-memory-service.ts`
- Modify: `src/v2/memory/provider.ts`
- Create: `tests/v2/postgres-memory-service.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing memory service test**

Create `tests/v2/postgres-memory-service.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  approveMemoryDeltaPg,
  createMemoryDeltaPg,
  invalidateRunLocalMemoryPg,
  searchMemoryForContextPg,
  writeRunLocalMemoryPg,
} from "../../src/v2/memory/postgres-memory-service.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("Postgres memory service separates run-local memory from long-term approved memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-memory-service",
      status: "running",
      domain: "software",
      goalPrompt: "memory service",
      workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", tasks: [] }),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });

    const runLocal = await writeRunLocalMemoryPg(db, {
      runId: "run-memory-service",
      taskId: "task-a",
      sessionId: "session-a",
      attemptId: "task-a-attempt-1",
      kind: "repair_hint",
      text: "Use validator failure to repair the producer artifact.",
      tags: ["validator", "repair"],
      sourceRefs: ["artifact_ref:producer"],
    });

    const delta = await createMemoryDeltaPg(db, {
      runId: "run-memory-service",
      taskId: "task-a",
      sessionId: "session-a",
      scope: "software",
      kind: "failure_lesson",
      text: "Consumer validation findings should cite producer artifact refs.",
      tags: ["artifact-lineage"],
      confidence: 0.82,
      successScore: 0.74,
      sourceRefs: ["runtime_exception:validation_failed"],
    });

    const beforeApproval = await searchMemoryForContextPg(db, {
      runId: "run-memory-service",
      query: "validator producer repair",
      scopes: ["software"],
      allowedKinds: ["repair_hint", "failure_lesson"],
      maxCandidates: 10,
    });

    assert.equal(beforeApproval.some((candidate) => candidate.id === runLocal.memoryId), true);
    assert.equal(beforeApproval.some((candidate) => candidate.id === delta.deltaId), false);

    const approved = await approveMemoryDeltaPg(db, {
      deltaId: delta.deltaId,
      approvedBy: "operator",
      reason: "promote stable lesson",
    });

    const afterApproval = await searchMemoryForContextPg(db, {
      runId: "another-run",
      query: "consumer validation producer artifact",
      scopes: ["software"],
      allowedKinds: ["failure_lesson"],
      maxCandidates: 10,
    });

    assert.equal(afterApproval.some((candidate) => candidate.id === approved.memoryId), true);

    await invalidateRunLocalMemoryPg(db, {
      runId: "run-memory-service",
      sourceRefs: ["artifact_ref:producer"],
      invalidatedBy: "rollback-marker-1",
      reason: "rollback invalidated producer artifact",
    });

    const afterInvalidation = await searchMemoryForContextPg(db, {
      runId: "run-memory-service",
      query: "validator producer repair",
      scopes: ["software"],
      allowedKinds: ["repair_hint", "failure_lesson"],
      maxCandidates: 10,
    });

    assert.equal(afterInvalidation.some((candidate) => candidate.id === runLocal.memoryId), false);
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./postgres-memory-service.test.ts");
```

- [ ] **Step 2: Run the failing memory service test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with missing `src/v2/memory/postgres-memory-service.ts`.

- [ ] **Step 3: Add memory service types**

In `src/v2/memory/provider.ts`, add shared async types without removing existing `MemoryProvider`:

```ts
export type ContextMemorySearchInput = {
  runId: string;
  query: string;
  scopes: string[];
  allowedKinds: string[];
  maxCandidates: number;
};

export type ContextMemoryCandidate = MemoryCandidate & {
  sourceRefs: string[];
  status: "active" | "approved";
  runId?: string;
  taskId?: string;
  sessionId?: string;
};
```

- [ ] **Step 4: Implement Postgres memory service**

Create `src/v2/memory/postgres-memory-service.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, listResourcesPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ContextMemoryCandidate, ContextMemorySearchInput } from "./provider.ts";

export type WriteRunLocalMemoryInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  attemptId?: string;
  handExecutionId?: string;
  kind: string;
  text: string;
  tags: string[];
  sourceRefs: string[];
};

export type CreateMemoryDeltaInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  scope: string;
  kind: string;
  text: string;
  tags: string[];
  confidence: number;
  successScore: number;
  sourceRefs: string[];
};

export async function writeRunLocalMemoryPg(db: SouthstarDb, input: WriteRunLocalMemoryInput): Promise<{ memoryId: string }> {
  const memoryId = `memory_item:run-local:${input.runId}:${stableHash([input.kind, input.text, input.sourceRefs]).slice(0, 24)}`;
  await upsertRuntimeResourcePg(db, {
    id: memoryId,
    resourceType: "memory_item",
    resourceKey: memoryId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: `run:${input.runId}`,
    status: "active",
    title: `Run-local memory: ${input.kind}`,
    payload: {
      schemaVersion: "southstar.memory_item.v1",
      memoryId,
      memoryScope: "run-local",
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      handExecutionId: input.handExecutionId,
      kind: input.kind,
      text: input.text,
      tags: [...input.tags].sort(),
      sourceRefs: [...input.sourceRefs].sort(),
    },
    summary: { kind: input.kind, tokenEstimate: estimateTokens(input.text), sourceRefs: input.sourceRefs.length },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "memory.run_local_recorded",
    actorType: "orchestrator",
    idempotencyKey: `${memoryId}:recorded`,
    payload: { memoryId, kind: input.kind, sourceRefs: input.sourceRefs },
  });
  return { memoryId };
}

export async function createMemoryDeltaPg(db: SouthstarDb, input: CreateMemoryDeltaInput): Promise<{ deltaId: string }> {
  const deltaId = `memory_delta:${input.runId}:${stableHash([input.scope, input.kind, input.text, input.sourceRefs]).slice(0, 24)}`;
  await upsertRuntimeResourcePg(db, {
    id: deltaId,
    resourceType: "memory_delta",
    resourceKey: deltaId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: input.scope,
    status: "pending_approval",
    title: `Memory delta: ${input.kind}`,
    payload: {
      schemaVersion: "southstar.memory_delta.v1",
      deltaId,
      scope: input.scope,
      kind: input.kind,
      text: input.text,
      tags: [...input.tags].sort(),
      confidence: input.confidence,
      successScore: input.successScore,
      sourceRefs: [...input.sourceRefs].sort(),
    },
    summary: { kind: input.kind, confidence: input.confidence, successScore: input.successScore },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "memory_delta.created",
    actorType: "orchestrator",
    idempotencyKey: `${deltaId}:created`,
    payload: { deltaId, scope: input.scope, kind: input.kind },
  });
  return { deltaId };
}

export async function approveMemoryDeltaPg(
  db: SouthstarDb,
  input: { deltaId: string; approvedBy: string; reason: string },
): Promise<{ memoryId: string }> {
  const delta = await db.maybeOne<{ run_id: string | null; task_id: string | null; session_id: string | null; scope: string; payload_json: Record<string, unknown> }>(
    "select run_id, task_id, session_id, scope, payload_json from southstar.runtime_resources where resource_type = 'memory_delta' and resource_key = $1",
    [input.deltaId],
  );
  if (!delta) throw new Error(`memory_delta not found: ${input.deltaId}`);
  const text = stringValue(delta.payload_json.text);
  const kind = stringValue(delta.payload_json.kind);
  const sourceRefs = stringArray(delta.payload_json.sourceRefs);
  const memoryId = `memory_item:${delta.scope}:${stableHash([kind, text, sourceRefs]).slice(0, 24)}`;
  await upsertRuntimeResourcePg(db, {
    id: memoryId,
    resourceType: "memory_item",
    resourceKey: memoryId,
    runId: delta.run_id ?? undefined,
    taskId: delta.task_id ?? undefined,
    sessionId: delta.session_id ?? undefined,
    scope: delta.scope,
    status: "approved",
    title: `Approved memory: ${kind}`,
    payload: {
      schemaVersion: "southstar.memory_item.v1",
      memoryId,
      memoryScope: "long-term",
      scope: delta.scope,
      kind,
      text,
      tags: stringArray(delta.payload_json.tags),
      confidence: numberValue(delta.payload_json.confidence) ?? 0,
      successScore: numberValue(delta.payload_json.successScore) ?? 0,
      sourceRefs,
      approvedBy: input.approvedBy,
      approvedReason: input.reason,
      sourceDeltaId: input.deltaId,
    },
    summary: { kind, sourceDeltaId: input.deltaId },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "memory_delta",
    resourceKey: input.deltaId,
    runId: delta.run_id ?? undefined,
    taskId: delta.task_id ?? undefined,
    sessionId: delta.session_id ?? undefined,
    scope: delta.scope,
    status: "approved",
    title: `Memory delta: ${kind}`,
    payload: { ...delta.payload_json, approvedMemoryId: memoryId, approvedBy: input.approvedBy, approvedReason: input.reason },
  });
  await appendHistoryEventPg(db, {
    runId: delta.run_id ?? "memory-approval",
    taskId: delta.task_id ?? undefined,
    sessionId: delta.session_id ?? undefined,
    eventType: "memory_delta.approved",
    actorType: "operator",
    idempotencyKey: `${input.deltaId}:approved`,
    payload: { deltaId: input.deltaId, memoryId, approvedBy: input.approvedBy, reason: input.reason },
  });
  return { memoryId };
}

export async function searchMemoryForContextPg(db: SouthstarDb, input: ContextMemorySearchInput): Promise<ContextMemoryCandidate[]> {
  const resources = (await listResourcesPg(db, { resourceType: "memory_item" }))
    .filter((resource) => resource.status === "approved" || (resource.status === "active" && resource.runId === input.runId));
  const allowed = new Set(input.allowedKinds);
  const queryTerms = terms(input.query);
  const candidates = resources
    .map((resource) => {
      const payload = asRecord(resource.payload);
      const kind = stringValue(payload.kind);
      const text = stringValue(payload.text);
      if (!kind || !text || !allowed.has(kind)) return null;
      const isRunLocal = resource.status === "active" && resource.scope === `run:${input.runId}`;
      const isLongTerm = resource.status === "approved" && input.scopes.includes(resource.scope);
      if (!isRunLocal && !isLongTerm) return null;
      const score = scoreText(text, queryTerms);
      if (score <= 0 && queryTerms.length > 0) return null;
      return {
        id: resource.resourceKey,
        scope: resource.scope,
        kind,
        text,
        score,
        confidence: numberValue(payload.confidence) ?? 1,
        successScore: numberValue(payload.successScore) ?? 1,
        tokenEstimate: estimateTokens(text),
        sourceRef: resource.resourceKey,
        sourceRefs: stringArray(payload.sourceRefs),
        status: resource.status as "active" | "approved",
        runId: resource.runId,
        taskId: resource.taskId,
        sessionId: resource.sessionId,
      } satisfies ContextMemoryCandidate;
    })
    .filter((candidate): candidate is ContextMemoryCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return candidates.slice(0, input.maxCandidates);
}

export async function invalidateRunLocalMemoryPg(
  db: SouthstarDb,
  input: { runId: string; sourceRefs: string[]; invalidatedBy: string; reason: string },
): Promise<{ invalidated: number }> {
  const rows = await db.query<{ resource_key: string; payload_json: Record<string, unknown>; task_id: string | null; session_id: string | null }>(
    `select resource_key, payload_json, task_id, session_id
       from southstar.runtime_resources
      where resource_type = 'memory_item'
        and run_id = $1
        and scope = $2
        and status = 'active'`,
    [input.runId, `run:${input.runId}`],
  );
  let invalidated = 0;
  for (const row of rows.rows) {
    const sourceRefs = stringArray(row.payload_json.sourceRefs);
    if (!sourceRefs.some((ref) => input.sourceRefs.includes(ref))) continue;
    invalidated += 1;
    await upsertRuntimeResourcePg(db, {
      resourceType: "memory_item",
      resourceKey: row.resource_key,
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      scope: `run:${input.runId}`,
      status: "invalidated",
      title: `Invalidated run-local memory`,
      payload: { ...row.payload_json, invalidatedBy: input.invalidatedBy, invalidatedReason: input.reason },
    });
  }
  return { invalidated };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function terms(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function scoreText(text: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 1;
  const haystack = text.toLowerCase();
  return queryTerms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) / queryTerms.length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
```

- [ ] **Step 5: Run the memory service test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `postgres-memory-service.test.ts`.

- [ ] **Step 6: Commit memory service**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/memory/provider.ts src/v2/memory/postgres-memory-service.ts tests/v2/postgres-memory-service.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add postgres memory service"
```

---

### Task 3: Context Assembly Policy

**Files:**
- Create: `src/v2/context/assembly-policy.ts`
- Create: `tests/v2/context-assembly-policy.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing assembly policy test**

Create `tests/v2/context-assembly-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { assembleContextBlocks } from "../../src/v2/context/assembly-policy.ts";
import type { ContextBlockCandidate } from "../../src/v2/context/types.ts";

test("assembly policy injects allowed memory and excludes pending, rollback-invalidated, secret-shaped, and over-budget candidates", () => {
  const candidates: ContextBlockCandidate[] = [
    candidate("artifact", "artifact-a", "Accepted upstream artifact summary", 8, 0.9),
    candidate("memory", "memory-run", "Repair hint from this run", 8, 0.8),
    candidate("memory", "memory-pending", "Pending long-term memory", 8, 0.95),
    candidate("memory", "memory-secret", "Token sk-1234567890abcdefghijklmnopqrstuvwxyz leaked", 8, 0.99),
    candidate("memory", "memory-invalidated", "Rollback invalidated memory", 8, 0.7),
    candidate("knowledge_card", "card-a", "Approved failure lesson", 8, 0.6),
  ];

  const result = assembleContextBlocks({
    candidates,
    maxInputTokens: 30,
    maxMemoryTokens: 12,
    pendingMemoryRefs: ["memory-pending"],
    invalidatedSourceRefs: ["memory-invalidated"],
    requiredSourceRefs: ["artifact-a"],
  });

  assert.equal(result.validation.ok, true);
  assert.deepEqual(result.selected.map((block) => block.sourceRef), ["artifact-a", "memory-run", "card-a"]);
  assert.equal(result.excludedCandidates.some((item) => item.sourceRef === "memory-pending" && item.reason === "scope-mismatch"), true);
  assert.equal(result.excludedCandidates.some((item) => item.sourceRef === "memory-secret" && item.reason === "kind-mismatch"), true);
  assert.equal(result.excludedCandidates.some((item) => item.sourceRef === "memory-invalidated" && item.reason === "scope-mismatch"), true);
  assert.equal(result.tokenEstimate.total <= 30, true);
});

test("assembly policy fails validation when required source refs are missing", () => {
  const result = assembleContextBlocks({
    candidates: [candidate("memory", "memory-run", "Repair hint", 8, 0.8)],
    maxInputTokens: 30,
    maxMemoryTokens: 12,
    pendingMemoryRefs: [],
    invalidatedSourceRefs: [],
    requiredSourceRefs: ["artifact-a"],
  });

  assert.equal(result.validation.ok, false);
  assert.match(result.validation.errors[0]?.message ?? "", /required source ref missing: artifact-a/);
});

function candidate(
  sourceType: ContextBlockCandidate["sourceType"],
  sourceRef: string,
  text: string,
  tokenEstimate: number,
  score: number,
): ContextBlockCandidate {
  return {
    id: `${sourceType}-${sourceRef}`,
    sourceType,
    title: sourceRef,
    text,
    sourceRef,
    tokenEstimate,
    score,
  };
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./context-assembly-policy.test.ts");
```

- [ ] **Step 2: Run the failing policy test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with missing `src/v2/context/assembly-policy.ts`.

- [ ] **Step 3: Implement assembly policy**

Create `src/v2/context/assembly-policy.ts`:

```ts
import type {
  ContextAssemblyValidation,
  ContextBlock,
  ContextBlockCandidate,
  ContextExclusion,
  TokenEstimate,
} from "./types.ts";

export type ContextAssemblyPolicyInput = {
  candidates: ContextBlockCandidate[];
  maxInputTokens: number;
  maxMemoryTokens: number;
  pendingMemoryRefs: string[];
  invalidatedSourceRefs: string[];
  requiredSourceRefs: string[];
};

export type ContextAssemblyPolicyResult = {
  selected: ContextBlock[];
  excludedCandidates: ContextExclusion[];
  tokenEstimate: TokenEstimate;
  validation: ContextAssemblyValidation;
};

const SECRET_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/i;

export function assembleContextBlocks(input: ContextAssemblyPolicyInput): ContextAssemblyPolicyResult {
  const pending = new Set(input.pendingMemoryRefs);
  const invalidated = new Set(input.invalidatedSourceRefs);
  const excluded: ContextExclusion[] = [];
  const selected: ContextBlock[] = [];
  let totalTokens = 0;
  let memoryTokens = 0;

  for (const candidate of [...input.candidates].sort(compareCandidate)) {
    const sourceRef = candidate.sourceRef ?? candidate.id;
    if (pending.has(sourceRef)) {
      excluded.push(exclusion(candidate, "scope-mismatch"));
      continue;
    }
    if (invalidated.has(sourceRef)) {
      excluded.push(exclusion(candidate, "scope-mismatch"));
      continue;
    }
    if (SECRET_PATTERN.test(candidate.text)) {
      excluded.push(exclusion(candidate, "kind-mismatch"));
      continue;
    }
    if (candidate.sourceType === "memory" && memoryTokens + candidate.tokenEstimate > input.maxMemoryTokens) {
      excluded.push(exclusion(candidate, "over-budget"));
      continue;
    }
    if (totalTokens + candidate.tokenEstimate > input.maxInputTokens) {
      excluded.push(exclusion(candidate, "over-budget"));
      continue;
    }
    selected.push(toBlock(candidate));
    totalTokens += candidate.tokenEstimate;
    if (candidate.sourceType === "memory") memoryTokens += candidate.tokenEstimate;
  }

  const selectedRefs = new Set(selected.map((block) => block.sourceRef ?? block.id));
  const errors = input.requiredSourceRefs
    .filter((sourceRef) => !selectedRefs.has(sourceRef))
    .map((sourceRef) => ({ code: "required-source-missing", sourceRef, message: `required source ref missing: ${sourceRef}` }));

  const bySourceType: Record<string, number> = {};
  for (const block of selected) bySourceType[block.sourceType] = (bySourceType[block.sourceType] ?? 0) + block.tokenEstimate;
  return {
    selected,
    excludedCandidates: excluded,
    tokenEstimate: { total: totalTokens, bySourceType },
    validation: { ok: errors.length === 0, errors },
  };
}

function compareCandidate(left: ContextBlockCandidate, right: ContextBlockCandidate): number {
  const priority = sourcePriority(left.sourceType) - sourcePriority(right.sourceType);
  if (priority !== 0) return priority;
  return right.score - left.score || (left.sourceRef ?? left.id).localeCompare(right.sourceRef ?? right.id);
}

function sourcePriority(sourceType: string): number {
  if (sourceType === "artifact") return 0;
  if (sourceType === "failure") return 1;
  if (sourceType === "checkpoint") return 2;
  if (sourceType === "memory") return 3;
  if (sourceType === "knowledge_card") return 4;
  return 5;
}

function exclusion(candidate: ContextBlockCandidate, reason: ContextExclusion["reason"]): ContextExclusion {
  return { sourceRef: candidate.sourceRef ?? candidate.id, reason, tokenEstimate: candidate.tokenEstimate };
}

function toBlock(candidate: ContextBlockCandidate): ContextBlock {
  return {
    id: candidate.id,
    sourceType: candidate.sourceType,
    title: candidate.title,
    text: candidate.text,
    sourceRef: candidate.sourceRef,
    tokenEstimate: candidate.tokenEstimate,
  };
}
```

- [ ] **Step 4: Run the policy test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `context-assembly-policy.test.ts`.

- [ ] **Step 5: Commit assembly policy**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/context/assembly-policy.ts tests/v2/context-assembly-policy.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add managed context assembly policy"
```

---

### Task 4: Context Source Builder

**Files:**
- Create: `src/v2/context/source-builder.ts`
- Create: `tests/v2/context-source-builder.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing source builder test**

Create `tests/v2/context-source-builder.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { collectContextSourcesPg } from "../../src/v2/context/source-builder.ts";
import { writeRunLocalMemoryPg, createMemoryDeltaPg, approveMemoryDeltaPg } from "../../src/v2/memory/postgres-memory-service.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("context source builder collects accepted artifacts, session events, checkpoints, active run memory, and approved long-term memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-source-builder",
      status: "running",
      domain: "software",
      goalPrompt: "source builder",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "producer", runId: "run-source-builder", taskKey: "producer", status: "completed", sortOrder: 0, dependsOn: [] });
    await createWorkflowTaskPg(db, { id: "consumer", runId: "run-source-builder", taskKey: "consumer", status: "pending", sortOrder: 1, dependsOn: ["producer"] });

    const artifact = await acceptOrRejectArtifactRefPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      attemptId: "producer-attempt-1",
      handExecutionId: "hand-execution:run-source-builder:producer:producer-attempt-1",
      producer: { actorType: "hand", providerId: "tork" },
      artifactType: "implementation_report",
      status: "accepted",
      content: { kind: "implementation_report", summary: "producer completed feature" },
      contractRefs: ["implementation_report"],
      summary: "producer completed feature",
      evidenceRefs: [],
      evaluatorResultRefs: [],
      sourceEventRefs: ["event-producer"],
    });

    const store = createPostgresSessionStore(db);
    await store.emitEvent({
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      eventType: "session.entry",
      actorType: "hand",
      payload: { message: "producer session event", artifactRefs: [artifact.artifactRefId] },
    });
    const checkpoint = await store.createCheckpoint({
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      checkpointType: "artifact-accepted",
      summary: "producer artifact accepted",
      eventRange: { fromSequence: 1, toSequence: 2 },
      refs: { artifactRefs: [artifact.artifactRefId] },
    });
    const runMemory = await writeRunLocalMemoryPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      kind: "repair_hint",
      text: "Producer used stable implementation pattern.",
      tags: ["producer"],
      sourceRefs: [artifact.artifactRefId],
    });
    const delta = await createMemoryDeltaPg(db, {
      runId: "run-source-builder",
      taskId: "producer",
      sessionId: "session-producer",
      scope: "software",
      kind: "failure_lesson",
      text: "Accepted artifacts should list validation commands.",
      tags: ["artifact"],
      confidence: 0.9,
      successScore: 0.8,
      sourceRefs: [artifact.artifactRefId],
    });
    const approved = await approveMemoryDeltaPg(db, { deltaId: delta.deltaId, approvedBy: "operator", reason: "useful lesson" });
    await upsertRuntimeResourcePg(db, {
      resourceType: "rollback_marker",
      resourceKey: "rollback-marker-ignored",
      runId: "run-source-builder",
      taskId: "consumer",
      scope: "session",
      status: "created",
      title: "no invalidation",
      payload: { invalidatedSourceRefs: [] },
    });

    const sources = await collectContextSourcesPg(db, {
      runId: "run-source-builder",
      taskId: "consumer",
      sessionId: "session-consumer",
      dependsOn: ["producer"],
      query: "producer validation",
      memoryScopes: ["software"],
      allowedMemoryKinds: ["repair_hint", "failure_lesson"],
      maxMemoryCandidates: 10,
      checkpointRefs: [checkpoint.id],
    });

    assert.equal(sources.candidates.some((candidate) => candidate.sourceRef === artifact.artifactRefId), true);
    assert.equal(sources.candidates.some((candidate) => candidate.sourceRef === runMemory.memoryId), true);
    assert.equal(sources.candidates.some((candidate) => candidate.sourceRef === approved.memoryId), true);
    assert.equal(sources.sourceRefs.rawEventRefs.length > 0, true);
    assert.deepEqual(sources.sourceRefs.checkpointRefs, [checkpoint.id]);
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./context-source-builder.test.ts");
```

- [ ] **Step 2: Run the failing source builder test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with missing `src/v2/context/source-builder.ts`.

- [ ] **Step 3: Implement source builder**

Create `src/v2/context/source-builder.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { buildManagedContextSourceRefs } from "./event-slicing.ts";
import type { ContextBlockCandidate, ManagedContextSourceRefs } from "./types.ts";
import { searchMemoryForContextPg } from "../memory/postgres-memory-service.ts";

export type CollectContextSourcesInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  dependsOn: string[];
  query: string;
  memoryScopes: string[];
  allowedMemoryKinds: string[];
  maxMemoryCandidates: number;
  checkpointRefs: string[];
};

export type CollectContextSourcesResult = {
  candidates: ContextBlockCandidate[];
  sourceRefs: ManagedContextSourceRefs;
  pendingMemoryRefs: string[];
  invalidatedSourceRefs: string[];
};

type ResourceRow = {
  resource_key: string;
  resource_type: string;
  status: string;
  task_id: string | null;
  session_id: string | null;
  payload_json: Record<string, unknown>;
  summary_json: Record<string, unknown>;
};

type EventRow = {
  id: string;
  run_id: string;
  task_id: string | null;
  session_id: string | null;
  sequence: number;
  event_type: string;
  payload_json: Record<string, unknown>;
};

export async function collectContextSourcesPg(db: SouthstarDb, input: CollectContextSourcesInput): Promise<CollectContextSourcesResult> {
  const [artifactCandidates, eventRefs, checkpointCandidates, memoryCandidates, invalidatedSourceRefs, pendingMemoryRefs] = await Promise.all([
    acceptedArtifactCandidates(db, input),
    sessionEventRefs(db, input),
    checkpointCandidatesForRefs(db, input),
    memoryCandidatesForInput(db, input),
    rollbackInvalidatedSourceRefs(db, input.runId),
    pendingMemoryDeltaRefs(db, input.runId),
  ]);
  const candidates = [...artifactCandidates, ...checkpointCandidates, ...memoryCandidates];
  const sourceRefs = buildManagedContextSourceRefs({
    rawEventRefs: eventRefs,
    omittedEventRanges: [],
    transformRefs: [],
    checkpointRefs: input.checkpointRefs,
    artifactRefs: artifactCandidates.map((candidate) => candidate.sourceRef).filter((value): value is string => Boolean(value)),
    memoryRefs: memoryCandidates.map((candidate) => candidate.sourceRef).filter((value): value is string => Boolean(value)),
    rollbackMarkerRefs: [],
  });
  return { candidates, sourceRefs, pendingMemoryRefs, invalidatedSourceRefs };
}

async function acceptedArtifactCandidates(db: SouthstarDb, input: CollectContextSourcesInput): Promise<ContextBlockCandidate[]> {
  if (input.dependsOn.length === 0) return [];
  const rows = await db.query<ResourceRow>(
    `select resource_key, resource_type, status, task_id, session_id, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'artifact_ref'
        and status = 'accepted'
        and task_id = any($2::text[])
      order by created_at, resource_key`,
    [input.runId, input.dependsOn],
  );
  return rows.rows.map((row) => {
    const text = stringValue(row.summary_json.summary) || stringValue(row.payload_json.summary) || `Accepted artifact ${row.resource_key}`;
    return candidate("artifact", row.resource_key, "Accepted artifact", text, row.resource_key, 1, {
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      artifactRefIds: [row.resource_key],
    });
  });
}

async function checkpointCandidatesForRefs(db: SouthstarDb, input: CollectContextSourcesInput): Promise<ContextBlockCandidate[]> {
  if (input.checkpointRefs.length === 0) return [];
  const rows = await db.query<ResourceRow>(
    `select resource_key, resource_type, status, task_id, session_id, payload_json, summary_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'session_checkpoint'
        and resource_key = any($2::text[])`,
    [input.runId, input.checkpointRefs],
  );
  return rows.rows.map((row) => {
    const text = stringValue(row.payload_json.summary)
      || stringValue(asRecord(row.payload_json.summaries).checkpointSummary)
      || stringValue(row.summary_json.checkpointSummary)
      || `Checkpoint ${row.resource_key}`;
    return candidate("checkpoint", row.resource_key, "Checkpoint", text, row.resource_key, 0.95, {
      runId: input.runId,
      taskId: row.task_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      checkpointId: row.resource_key,
    });
  });
}

async function memoryCandidatesForInput(db: SouthstarDb, input: CollectContextSourcesInput): Promise<ContextBlockCandidate[]> {
  const memories = await searchMemoryForContextPg(db, {
    runId: input.runId,
    query: input.query,
    scopes: input.memoryScopes,
    allowedKinds: input.allowedMemoryKinds,
    maxCandidates: input.maxMemoryCandidates,
  });
  return memories.map((memory) => candidate("memory", memory.id, memory.kind, memory.text, memory.id, memory.score, {
    runId: memory.runId ?? input.runId,
    taskId: memory.taskId,
    sessionId: memory.sessionId,
  }));
}

async function sessionEventRefs(db: SouthstarDb, input: CollectContextSourcesInput): Promise<ManagedContextSourceRefs["rawEventRefs"]> {
  const rows = await db.query<EventRow>(
    `select id, run_id, task_id, session_id, sequence, event_type, payload_json
       from southstar.workflow_history
      where run_id = $1
        and (session_id = $2 or task_id = any($3::text[]))
      order by sequence
      limit 50`,
    [input.runId, input.sessionId, input.dependsOn],
  );
  return rows.rows
    .filter((row) => row.session_id)
    .map((row) => ({ id: row.id, runId: row.run_id, sessionId: row.session_id!, sequence: row.sequence }));
}

async function rollbackInvalidatedSourceRefs(db: SouthstarDb, runId: string): Promise<string[]> {
  const rows = await db.query<{ payload_json: Record<string, unknown> }>(
    "select payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'rollback_marker' and status = 'created'",
    [runId],
  );
  return [...new Set(rows.rows.flatMap((row) => stringArray(row.payload_json.invalidatedSourceRefs)))].sort();
}

async function pendingMemoryDeltaRefs(db: SouthstarDb, runId: string): Promise<string[]> {
  const rows = await db.query<{ resource_key: string }>(
    "select resource_key from southstar.runtime_resources where run_id = $1 and resource_type = 'memory_delta' and status = 'pending_approval'",
    [runId],
  );
  return rows.rows.map((row) => row.resource_key).sort();
}

function candidate(
  sourceType: ContextBlockCandidate["sourceType"],
  id: string,
  title: string,
  text: string,
  sourceRef: string,
  score: number,
  lineage: ContextBlockCandidate["lineage"],
): ContextBlockCandidate {
  return { id: `${sourceType}-${id}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(), sourceType, title, text, sourceRef, tokenEstimate: estimateTokens(text), score, lineage };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
```

- [ ] **Step 4: Run the source builder test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `context-source-builder.test.ts`.

- [ ] **Step 5: Commit source builder**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/context/source-builder.ts tests/v2/context-source-builder.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: collect managed context sources"
```

---

### Task 5: Managed Context Assembler

**Files:**
- Create: `src/v2/context/managed-context-assembler.ts`
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
- Create: `tests/v2/managed-context-assembler.test.ts`
- Modify: `tests/v2/postgres-task-envelope.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing assembler test**

Create `tests/v2/managed-context-assembler.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createManagedContextAssembler } from "../../src/v2/context/managed-context-assembler.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("ManagedContextAssembler persists matching ContextPacket, TaskEnvelopeV2, and assembly trace", async () => {
  const db = await createTestPostgresDb();
  try {
    const manifest = {
      schemaVersion: "southstar.v2",
      workflowId: "wf-managed-context",
      title: "Managed context",
      goalPrompt: "build managed context",
      domain: "software",
      intent: "implement_feature",
      tasks: [{
        id: "implement-feature",
        name: "Implement",
        domain: "software",
        dependsOn: [],
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        evaluatorPipelineRef: "software-feature-quality",
        requiredArtifactRefs: ["implementation_report"],
        skillRefs: ["software.implementation"],
        mcpGrantRefs: [],
        rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
        execution: { engine: "tork", image: "southstar/pi-agent:local", command: ["southstar-agent-runner"], env: {}, mounts: [], timeoutSeconds: 600, infraRetry: { maxAttempts: 1 } },
        subagents: [],
      }],
      harnessDefinitions: [{ id: "pi", kind: "pi-agent", entrypoint: "southstar-agent-runner", image: "southstar/pi-agent:local", capabilities: ["software"], inputProtocol: "task-envelope-v2", eventProtocol: "southstar-events-v1", supportsCheckpoint: true, supportsSteering: true, supportsProgress: true }],
      memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
      vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
      steeringPolicy: { enabled: true, acceptedSignals: [] },
      learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    };
    await createWorkflowRunPg(db, {
      id: "run-managed-context",
      status: "running",
      domain: "software",
      goalPrompt: "build managed context",
      workflowManifestJson: JSON.stringify(manifest),
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "implement-feature", runId: "run-managed-context", taskKey: "implement-feature", status: "claimed", sortOrder: 0, dependsOn: [] });

    const assembler = createManagedContextAssembler(db, { domainPack: softwareDomainPack });
    const assembled = await assembler.buildForTask({
      runId: "run-managed-context",
      taskId: "implement-feature",
      sessionId: "session-managed-context",
      attemptId: "implement-feature-attempt-1",
      handExecutionId: "hand-execution:run-managed-context:implement-feature:implement-feature-attempt-1",
      dependsOn: [],
    });

    assert.equal(assembled.contextPacket.id, "ctx-run-managed-context-implement-feature-implement-feature-attempt-1");
    assert.equal(assembled.taskEnvelope.contextPacket.id, assembled.contextPacket.id);
    assert.equal(assembled.taskEnvelope.session.sessionId, "session-managed-context");
    assert.equal(assembled.trace.contextPacketId, assembled.contextPacket.id);
    assert.equal(assembled.trace.taskEnvelopeId, assembled.taskEnvelopeId);

    const packets = await listResourcesPg(db, { resourceType: "context_packet" });
    const envelopes = await listResourcesPg(db, { resourceType: "task_envelope" });
    const traces = await listResourcesPg(db, { resourceType: "context_assembly_trace" });
    assert.equal(packets.length, 1);
    assert.equal(envelopes.length, 1);
    assert.equal(traces.length, 1);
    assert.equal((envelopes[0]?.payload as { envelope?: { contextPacket?: { id?: string } } }).envelope?.contextPacket?.id, packets[0]?.resourceKey);
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./managed-context-assembler.test.ts");
```

- [ ] **Step 2: Run the failing assembler test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with missing `src/v2/context/managed-context-assembler.ts`.

- [ ] **Step 3: Implement assembler**

Create `src/v2/context/managed-context-assembler.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { softwareDomainPack } from "../domain-packs/software.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import { buildTaskEnvelopeV2, type TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import { assembleContextBlocks } from "./assembly-policy.ts";
import { collectContextSourcesPg } from "./source-builder.ts";
import {
  CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE,
  CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
  type ContextAssemblyTrace,
  type ContextPacket,
} from "./types.ts";

export type ManagedContextAssemblerOptions = {
  domainPack?: DomainPack;
};

export type BuildManagedTaskContextInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  dependsOn: string[];
  checkpointRefs?: string[];
  failureSummary?: string;
};

export type BuildManagedTaskContextResult = {
  contextPacket: ContextPacket;
  taskEnvelope: TaskEnvelopeV2;
  taskEnvelopeId: string;
  trace: ContextAssemblyTrace;
};

export function createManagedContextAssembler(db: SouthstarDb, options: ManagedContextAssemblerOptions = {}) {
  const domainPack = options.domainPack ?? softwareDomainPack;
  return {
    async buildForTask(input: BuildManagedTaskContextInput): Promise<BuildManagedTaskContextResult> {
      const workflow = await readWorkflow(db, input.runId);
      const task = required(workflow.tasks.find((candidate) => candidate.id === input.taskId), `unknown task: ${input.taskId}`);
      const role = required(domainPack.roles.find((candidate) => candidate.id === task.roleRef), `missing role ${task.roleRef}`);
      const profile = required(domainPack.agentProfiles.find((candidate) => candidate.id === task.agentProfileRef), `missing agent profile ${task.agentProfileRef}`);
      const harness = required(workflow.harnessDefinitions.find((candidate) => candidate.id === profile.harnessRef), `missing harness ${profile.harnessRef}`);
      const evaluatorPipeline = required(domainPack.evaluatorPipelines.find((candidate) => candidate.id === task.evaluatorPipelineRef), `missing evaluator pipeline ${task.evaluatorPipelineRef}`);
      const artifactContracts = (task.requiredArtifactRefs ?? []).map((ref) => required(domainPack.artifactContracts.find((contract) => contract.id === ref), `missing artifact contract ${ref}`));
      const contextPolicy = domainPack.contextPolicies.find((policy) => policy.id === profile.contextPolicyRef) ?? domainPack.contextPolicies[0];
      const memoryPolicy = domainPack.memoryPolicies.find((policy) => policy.id === contextPolicy?.memoryPolicyRef) ?? domainPack.memoryPolicies[0];
      const sources = await collectContextSourcesPg(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        dependsOn: input.dependsOn,
        query: `${workflow.goalPrompt ?? ""} ${task.name ?? task.id}`,
        memoryScopes: memoryPolicy?.scopes ?? [],
        allowedMemoryKinds: memoryPolicy?.allowedKinds ?? [],
        maxMemoryCandidates: memoryPolicy?.maxCandidates ?? 8,
        checkpointRefs: input.checkpointRefs ?? [],
      });
      const assembly = assembleContextBlocks({
        candidates: sources.candidates,
        maxInputTokens: contextPolicy?.maxInputTokens ?? 20_000,
        maxMemoryTokens: memoryPolicy?.maxInjectedTokens ?? 1_500,
        pendingMemoryRefs: sources.pendingMemoryRefs,
        invalidatedSourceRefs: sources.invalidatedSourceRefs,
        requiredSourceRefs: [],
      });
      if (!assembly.validation.ok) {
        throw new Error(`context assembly failed: ${assembly.validation.errors.map((error) => error.message).join("; ")}`);
      }
      const contextPacketId = `ctx-${input.runId}-${input.taskId}-${input.attemptId}`;
      const taskEnvelopeId = `task-envelope-${input.runId}-${input.taskId}-${input.attemptId}`;
      const priorArtifacts = assembly.selected.filter((block) => block.sourceType === "artifact");
      const selectedMemories = assembly.selected.filter((block) => block.sourceType === "memory");
      const selectedKnowledgeCards = assembly.selected.filter((block) => block.sourceType === "knowledge_card");
      const checkpointSummary = assembly.selected.find((block) => block.sourceType === "checkpoint");
      const failureSummary = input.failureSummary
        ? { id: `failure-${input.runId}-${input.taskId}-${input.attemptId}`, sourceType: "failure" as const, title: "Failure", text: input.failureSummary, tokenEstimate: estimateTokens(input.failureSummary) }
        : undefined;
      const contextPacket: ContextPacket = {
        id: contextPacketId,
        runId: input.runId,
        taskId: input.taskId,
        rootSessionId: input.sessionId,
        executionAttempt: attemptNumber(input.attemptId),
        roleRef: role.id,
        agentProfileRef: profile.id,
        taskGoal: workflow.goalPrompt ?? task.name ?? input.taskId,
        roleInstruction: role.responsibility,
        systemInstruction: profile.systemPromptRef,
        agentsMdBlocks: [],
        artifactContracts: artifactContracts.map((contract) => ({
          id: `artifact-contract-${contract.id}`,
          sourceType: "artifact",
          title: contract.id,
          text: `Artifact type: ${contract.artifactType}. Required fields: ${contract.requiredFields.join(", ")}.`,
          sourceRef: contract.id,
          tokenEstimate: 12,
        })),
        selectedMemories,
        selectedKnowledgeCards,
        priorArtifacts,
        checkpointSummary,
        failureSummary,
        skillInstructions: [],
        mcpGrantSummary: [],
        forbiddenActions: profile.toolPolicy.deniedTools,
        budget: profile.budgetPolicy,
        tokenEstimate: assembly.tokenEstimate,
        excludedCandidates: assembly.excludedCandidates,
        managedSourceRefs: sources.sourceRefs,
      };
      const envelope = buildTaskEnvelopeV2({
        runId: input.runId,
        workflowId: workflow.workflowId,
        taskId: input.taskId,
        domain: workflow.domain ?? domainPack.id,
        intent: workflow.intent ?? "implement_feature",
        role,
        agentProfile: profile,
        harness,
        contextPacket,
        skills: [],
        mcpGrants: (task.mcpGrantRefs ?? []).map((grantRef) => ({ serverId: grantRef, allowedTools: [] })),
        vaultLeases: [],
        artifactContracts,
        evaluatorPipeline,
        session: { sessionId: input.sessionId, baseCheckpointId: input.checkpointRefs?.[0], maxRepairAttempts: task.rootSession.maxRepairAttempts },
      });
      const trace: ContextAssemblyTrace = {
        schemaVersion: CONTEXT_ASSEMBLY_TRACE_SCHEMA_VERSION,
        traceId: `context-trace-${input.runId}-${input.taskId}-${input.attemptId}`,
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        handExecutionId: input.handExecutionId,
        contextPacketId,
        taskEnvelopeId,
        selectedSourceRefs: assembly.selected.map((block) => block.sourceRef ?? block.id),
        excludedCandidates: assembly.excludedCandidates,
        tokenEstimate: assembly.tokenEstimate,
        validation: assembly.validation,
        createdAt: new Date().toISOString(),
      };
      await persistAssembly(db, { input, contextPacket, envelope, taskEnvelopeId, trace });
      return { contextPacket, taskEnvelope: envelope, taskEnvelopeId, trace };
    },
  };
}

async function persistAssembly(
  db: SouthstarDb,
  input: {
    input: BuildManagedTaskContextInput;
    contextPacket: ContextPacket;
    envelope: TaskEnvelopeV2;
    taskEnvelopeId: string;
    trace: ContextAssemblyTrace;
  },
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: input.contextPacket.id,
    resourceType: "context_packet",
    resourceKey: input.contextPacket.id,
    runId: input.input.runId,
    taskId: input.input.taskId,
    sessionId: input.input.sessionId,
    scope: "context",
    status: "created",
    title: `Context ${input.input.taskId}`,
    payload: input.contextPacket,
    summary: { tokenEstimate: input.contextPacket.tokenEstimate.total, attemptId: input.input.attemptId },
  });
  await upsertRuntimeResourcePg(db, {
    id: input.taskEnvelopeId,
    resourceType: "task_envelope",
    resourceKey: input.taskEnvelopeId,
    runId: input.input.runId,
    taskId: input.input.taskId,
    sessionId: input.input.sessionId,
    scope: "task",
    status: "materialized",
    title: `TaskEnvelope ${input.input.taskId}`,
    payload: { envelope: input.envelope },
    summary: { schemaVersion: input.envelope.schemaVersion, contextPacketId: input.contextPacket.id, attemptId: input.input.attemptId },
  });
  await upsertRuntimeResourcePg(db, {
    id: input.trace.traceId,
    resourceType: CONTEXT_ASSEMBLY_TRACE_RESOURCE_TYPE,
    resourceKey: input.trace.traceId,
    runId: input.input.runId,
    taskId: input.input.taskId,
    sessionId: input.input.sessionId,
    scope: "context",
    status: input.trace.validation.ok ? "valid" : "invalid",
    title: `Context assembly trace ${input.input.taskId}`,
    payload: input.trace,
    summary: { selectedSourceRefs: input.trace.selectedSourceRefs.length, excludedCandidates: input.trace.excludedCandidates.length },
  });
}

async function readWorkflow(db: SouthstarDb, runId: string): Promise<SouthstarWorkflowManifest> {
  const row = await db.maybeOne<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  if (!row) throw new Error(`workflow run not found: ${runId}`);
  return row.workflow_manifest_json;
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function attemptNumber(attemptId: string): number {
  const match = attemptId.match(/attempt-(\d+)/);
  return match ? Number(match[1]) : 1;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
```

- [ ] **Step 4: Update task envelope API to read persisted envelopes**

In `src/v2/ui-api/postgres-task-envelope.ts`, add a persisted envelope reader before fallback building:

```ts
export async function getPostgresTaskEnvelope(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2> {
  const persisted = await latestPersistedTaskEnvelope(db, input);
  if (persisted) return persisted;
  return await buildPostgresTaskEnvelopeFromLatestContext(db, input);
}

async function latestPersistedTaskEnvelope(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2 | null> {
  const row = await db.maybeOne<{ payload_json: { envelope?: TaskEnvelopeV2 } }>(
    `select payload_json
       from southstar.runtime_resources
      where resource_type = 'task_envelope'
        and run_id = $1
        and task_id = $2
      order by created_at desc
      limit 1`,
    [input.runId, input.taskId],
  );
  return row?.payload_json.envelope ?? null;
}

async function buildPostgresTaskEnvelopeFromLatestContext(db: SouthstarDb, input: { runId: string; taskId: string }): Promise<TaskEnvelopeV2> {
  // Move the current getPostgresTaskEnvelope body into this helper unchanged.
}
```

Keep the fallback for existing API compatibility; scheduler will persist canonical envelopes before real execution.

- [ ] **Step 5: Update tests for persisted envelope behavior**

Modify `tests/v2/postgres-task-envelope.test.ts` by adding an assertion after retrieving an envelope:

```ts
const persisted = await db.maybeOne<{ payload_json: { envelope?: { contextPacket?: { id?: string } } } }>(
  "select payload_json from southstar.runtime_resources where resource_type = 'task_envelope' and run_id = $1 order by created_at desc limit 1",
  [run.runId],
);
assert.equal(persisted === null || typeof persisted.payload_json.envelope?.contextPacket?.id === "string", true);
```

- [ ] **Step 6: Run assembler tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `managed-context-assembler.test.ts` and existing `postgres-task-envelope.test.ts`.

- [ ] **Step 7: Commit assembler**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/context/managed-context-assembler.ts src/v2/ui-api/postgres-task-envelope.ts tests/v2/managed-context-assembler.test.ts tests/v2/postgres-task-envelope.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: assemble managed task context"
```

---

### Task 6: Scheduler Integration

**Files:**
- Modify: `src/v2/scheduler/runnable-task-scheduler.ts`
- Create: `tests/v2/managed-context-scheduler.test.ts`
- Modify: `tests/v2/runnable-task-scheduler.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing scheduler integration test**

Create `tests/v2/managed-context-scheduler.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createRunnableTaskScheduler } from "../../src/v2/scheduler/runnable-task-scheduler.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import type { BrainProvider } from "../../src/v2/brain/types.ts";
import type { HandProvider } from "../../src/v2/hands/types.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runnable scheduler builds managed context packet, task envelope, and trace before hand submit", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRun(db);
    const submitted: Array<{ contextPacketRef: string; workflowRuntime?: unknown }> = [];
    const scheduler = createRunnableTaskScheduler(db, {
      sessionStore: createPostgresSessionStore(db),
      brainProvider: {
        providerId: "test-brain",
        wake: async (input) => ({ id: `brain-${input.taskId}`, providerId: "test-brain", runId: input.runId, taskId: input.taskId, sessionId: input.sessionId, status: "running", createdAt: new Date().toISOString(), payload: {} }),
      } satisfies BrainProvider,
      handProvider: {
        providerId: "test-hand",
        provision: async (input) => ({ id: `hand-${input.taskId}`, providerId: "test-hand", runId: input.runId, taskId: input.taskId, handName: input.handName, status: "provisioned", createdAt: new Date().toISOString(), payload: {} }),
        executeTask: async (_binding, input) => {
          submitted.push({ contextPacketRef: input.contextPacketRef, workflowRuntime: (input.workflow as { runtime?: unknown }).runtime });
          return { ok: true, output: `job-${input.taskId}`, metadata: { externalJobId: `job-${input.taskId}` } };
        },
        capabilities: () => ({ supportsSnapshot: true, supportsDestroy: true, supportsReprovision: true, keepsCredentialsOutOfSandbox: true }),
      } satisfies HandProvider,
    });

    const result = await scheduler.runOnce({ runId: "run-scheduler-managed-context" });
    assert.deepEqual(result.dispatchedTaskIds, ["implement-feature"]);
    assert.equal(submitted.length, 1);

    const packets = await listResourcesPg(db, { resourceType: "context_packet" });
    const envelopes = await listResourcesPg(db, { resourceType: "task_envelope" });
    const traces = await listResourcesPg(db, { resourceType: "context_assembly_trace" });
    assert.equal(packets.length, 1);
    assert.equal(envelopes.length, 1);
    assert.equal(traces.length, 1);
    assert.equal(submitted[0]?.contextPacketRef, packets[0]?.resourceKey);
  } finally {
    await db.close();
  }
});

async function seedRun(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  const manifest = {
    schemaVersion: "southstar.v2",
    workflowId: "wf-scheduler-managed-context",
    title: "Scheduler managed context",
    goalPrompt: "submit with managed context",
    domain: "software",
    intent: "implement_feature",
    tasks: [{
      id: "implement-feature",
      name: "Implement",
      domain: "software",
      dependsOn: [],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      evaluatorPipelineRef: "software-feature-quality",
      requiredArtifactRefs: ["implementation_report"],
      skillRefs: ["software.implementation"],
      mcpGrantRefs: [],
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 1 },
      execution: { engine: "tork", image: "southstar/pi-agent:local", command: ["southstar-agent-runner"], env: {}, mounts: [], timeoutSeconds: 600, infraRetry: { maxAttempts: 1 } },
      subagents: [],
    }],
    harnessDefinitions: [{ id: "pi", kind: "pi-agent", entrypoint: "southstar-agent-runner", image: "southstar/pi-agent:local", capabilities: ["software"], inputProtocol: "task-envelope-v2", eventProtocol: "southstar-events-v1", supportsCheckpoint: true, supportsSteering: true, supportsProgress: true }],
    memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 60, mountMode: "env" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 30, minEventsPerLongTask: 1 },
    steeringPolicy: { enabled: true, acceptedSignals: [] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    executionPolicy: { maxParallelTasks: 1 },
  };
  await createWorkflowRunPg(db, {
    id: "run-scheduler-managed-context",
    status: "running",
    domain: "software",
    goalPrompt: "submit with managed context",
    workflowManifestJson: JSON.stringify(manifest),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, { id: "implement-feature", runId: "run-scheduler-managed-context", taskKey: "implement-feature", status: "pending", sortOrder: 0, dependsOn: [] });
  await upsertRuntimeResourcePg(db, { resourceType: "context_packet", resourceKey: "legacy-context-should-not-be-used", runId: "run-scheduler-managed-context", taskId: "implement-feature", scope: "context", status: "created", payload: { id: "legacy-context-should-not-be-used" } });
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./managed-context-scheduler.test.ts");
```

- [ ] **Step 2: Run the failing scheduler test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because scheduler still reads the latest existing `context_packet` instead of building a fresh managed context.

- [ ] **Step 3: Integrate assembler into scheduler dispatch**

In `src/v2/scheduler/runnable-task-scheduler.ts`, import:

```ts
import { createManagedContextAssembler } from "../context/managed-context-assembler.ts";
```

Inside `dispatchTask`, replace `contextPacketId = await contextPacketIdForTask(...)` with:

```ts
const assembler = createManagedContextAssembler(db);
const assembly = await assembler.buildForTask({
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  attemptId,
  handExecutionId,
  dependsOn: input.dependsOn,
});
contextPacketId = assembly.contextPacket.id;
```

Include `taskEnvelopeId` in `task.dispatch_submitted` payload:

```ts
payload: {
  brainBindingId,
  handBindingId,
  contextPacketId,
  taskEnvelopeId: assembly.taskEnvelopeId,
  attemptId,
  handExecutionId,
},
```

Remove the `contextPacketIdForTask` fallback from this submit path after all tests pass.

- [ ] **Step 4: Add task-start checkpoint during scheduler dispatch**

After assembler build and before hand provider submit, call `deps.sessionStore.createCheckpoint`:

```ts
const taskStartCheckpoint = await deps.sessionStore.createCheckpoint({
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  resourceKey: `checkpoint:${input.runId}:${input.taskId}:${attemptId}:task-start`,
  checkpointType: "task-start",
  summary: `Task ${input.taskId} start for ${attemptId}`,
  eventRange: { fromSequence: 0, toSequence: 0 },
  refs: {
    contextPacketIds: [contextPacketId],
    taskEnvelopeIds: [assembly.taskEnvelopeId],
    artifactRefs: assembly.contextPacket.priorArtifacts.map((block) => block.sourceRef).filter((value): value is string => Boolean(value)),
  },
  metrics: { tokenEstimate: assembly.contextPacket.tokenEstimate.total },
});
```

Add `taskStartCheckpoint.id` to `hand.execute_queued` or `task.dispatch_submitted` payload.

- [ ] **Step 5: Run scheduler tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `managed-context-scheduler.test.ts` and existing `runnable-task-scheduler.test.ts`.

- [ ] **Step 6: Commit scheduler integration**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/scheduler/runnable-task-scheduler.ts tests/v2/managed-context-scheduler.test.ts tests/v2/runnable-task-scheduler.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: build managed context before task dispatch"
```

---

### Task 7: Callback Memory Writeback And Artifact Lineage

**Files:**
- Create: `src/v2/memory/writeback-policy.ts`
- Create: `src/v2/artifacts/lineage.ts`
- Modify: `src/v2/executor/postgres-tork-callback.ts`
- Create: `tests/v2/callback-memory-writeback.test.ts`
- Modify: `tests/v2/postgres-tork-callback.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing callback writeback test**

Create `tests/v2/callback-memory-writeback.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("callback ingestion writes run-local memory and long-term memory delta without approving cross-run memory", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedRunTask(db);
    await ingestTaskRunResultPg(db, {
      runId: "run-callback-memory",
      taskId: "implement",
      rootSessionId: "session-implement",
      attemptId: "implement-attempt-1",
      attempts: 1,
      ok: true,
      artifact: {
        kind: "implementation_report",
        summary: "Implemented feature and learned that validator failures should cite producer artifacts.",
        memoryCandidates: [{
          scope: "software",
          kind: "failure_lesson",
          text: "Validator findings should include producer artifact refs.",
          tags: ["validation"],
          confidence: 0.8,
          successScore: 0.7,
        }],
      },
      metrics: { durationMs: 1 },
      events: [{ eventType: "session.entry", actorType: "hand", sessionId: "session-implement", payload: { message: "implemented feature" } }],
      receivedAt: "2026-06-22T01:00:00.000Z",
    });

    const memory = await listResourcesPg(db, { resourceType: "memory_item" });
    const deltas = await listResourcesPg(db, { resourceType: "memory_delta" });
    assert.equal(memory.some((resource) => resource.status === "active" && resource.scope === "run:run-callback-memory"), true);
    assert.equal(deltas.some((resource) => resource.status === "pending_approval" && resource.scope === "software"), true);
  } finally {
    await db.close();
  }
});

async function seedRunTask(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await createWorkflowRunPg(db, {
    id: "run-callback-memory",
    status: "running",
    domain: "software",
    goalPrompt: "callback memory",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, { id: "implement", runId: "run-callback-memory", taskKey: "implement", status: "queued", sortOrder: 0, dependsOn: [] });
}
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./callback-memory-writeback.test.ts");
```

- [ ] **Step 2: Run the failing callback writeback test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because callback ingestion does not create memory resources.

- [ ] **Step 3: Implement writeback policy**

Create `src/v2/memory/writeback-policy.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { createMemoryDeltaPg, writeRunLocalMemoryPg } from "./postgres-memory-service.ts";

export type MemoryCandidateFromArtifact = {
  scope?: string;
  kind?: string;
  text?: string;
  tags?: string[];
  confidence?: number;
  successScore?: number;
};

export async function writeCallbackMemoryPg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    sessionId: string;
    attemptId: string;
    handExecutionId: string;
    artifactRefId: string;
    artifact: unknown;
    ok: boolean;
  },
): Promise<{ runLocalMemoryIds: string[]; memoryDeltaIds: string[] }> {
  const summary = summaryText(input.artifact);
  const runLocalMemoryIds: string[] = [];
  const memoryDeltaIds: string[] = [];
  if (summary) {
    const recorded = await writeRunLocalMemoryPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      handExecutionId: input.handExecutionId,
      kind: input.ok ? "artifact_summary" : "failure_summary",
      text: summary,
      tags: [input.ok ? "accepted-artifact" : "rejected-artifact"],
      sourceRefs: [input.artifactRefId],
    });
    runLocalMemoryIds.push(recorded.memoryId);
  }
  for (const candidate of memoryCandidates(input.artifact)) {
    const delta = await createMemoryDeltaPg(db, {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      scope: candidate.scope ?? "software",
      kind: candidate.kind ?? "workflow_learning",
      text: candidate.text!,
      tags: candidate.tags ?? [],
      confidence: candidate.confidence ?? 0.5,
      successScore: candidate.successScore ?? 0.5,
      sourceRefs: [input.artifactRefId],
    });
    memoryDeltaIds.push(delta.deltaId);
  }
  return { runLocalMemoryIds, memoryDeltaIds };
}

function summaryText(artifact: unknown): string {
  if (artifact && typeof artifact === "object" && typeof (artifact as { summary?: unknown }).summary === "string") {
    return (artifact as { summary: string }).summary;
  }
  return "";
}

function memoryCandidates(artifact: unknown): MemoryCandidateFromArtifact[] {
  if (!artifact || typeof artifact !== "object") return [];
  const value = (artifact as { memoryCandidates?: unknown }).memoryCandidates;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is MemoryCandidateFromArtifact => Boolean(item && typeof item === "object"))
    .filter((item) => typeof item.text === "string" && item.text.trim().length > 0);
}
```

- [ ] **Step 4: Add artifact repair marker helper**

Create `src/v2/artifacts/lineage.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export async function recordArtifactRepairMarkerPg(
  db: SouthstarDb,
  input: {
    runId: string;
    producerTaskId: string;
    consumerTaskId: string;
    artifactRefId: string;
    findingRef: string;
    reason: string;
  },
): Promise<{ markerId: string }> {
  const markerId = `artifact_repair_marker:${input.runId}:${input.artifactRefId}:${input.findingRef}`.replace(/[^a-zA-Z0-9:_-]+/g, "-");
  await upsertRuntimeResourcePg(db, {
    id: markerId,
    resourceType: "artifact_repair_marker",
    resourceKey: markerId,
    runId: input.runId,
    taskId: input.producerTaskId,
    scope: "artifact",
    status: "repair_required",
    title: "Artifact repair required",
    payload: {
      schemaVersion: "southstar.artifact_repair_marker.v1",
      markerId,
      producerTaskId: input.producerTaskId,
      consumerTaskId: input.consumerTaskId,
      artifactRefId: input.artifactRefId,
      findingRef: input.findingRef,
      reason: input.reason,
    },
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.producerTaskId,
    eventType: "artifact.repair_required",
    actorType: "evaluator",
    idempotencyKey: `${markerId}:created`,
    payload: { markerId, artifactRefId: input.artifactRefId, consumerTaskId: input.consumerTaskId },
  });
  return { markerId };
}
```

- [ ] **Step 5: Call writeback policy from callback ingestion**

In `src/v2/executor/postgres-tork-callback.ts`, import:

```ts
import { writeCallbackMemoryPg } from "../memory/writeback-policy.ts";
```

After `artifactRef` is created and before task status update, add:

```ts
const memoryWriteback = await writeCallbackMemoryPg(tx, {
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  attemptId,
  handExecutionId,
  artifactRefId: artifactRef.artifactRefId,
  artifact: result.artifact,
  ok: result.ok,
});
await appendHistoryEventPg(tx, {
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  eventType: "memory.writeback_recorded",
  actorType: "orchestrator",
  payload: memoryWriteback,
});
```

- [ ] **Step 6: Run callback tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `callback-memory-writeback.test.ts` and existing callback tests.

- [ ] **Step 7: Commit callback writeback**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/memory/writeback-policy.ts src/v2/artifacts/lineage.ts src/v2/executor/postgres-tork-callback.ts tests/v2/callback-memory-writeback.test.ts tests/v2/postgres-tork-callback.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: record callback memory writeback"
```

---

### Task 8: Session Recovery Operations

**Files:**
- Create: `src/v2/session-recovery/session-operations.ts`
- Modify: `src/v2/exceptions/recovery-decision-applier.ts`
- Modify: `src/v2/exceptions/runtime-exception-controller.ts`
- Create: `tests/v2/session-recovery-operations.test.ts`
- Modify: `tests/v2/recovery-decision-applier.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing session operations test**

Create `tests/v2/session-recovery-operations.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { applySessionRecoveryOperationPg } from "../../src/v2/session-recovery/session-operations.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("session recovery operations reset task from checkpoint and require approval for rollback", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, {
      id: "run-session-ops",
      status: "running",
      domain: "software",
      goalPrompt: "session ops",
      workflowManifestJson: "{}",
      executionProjectionJson: "{}",
      snapshotJson: "{}",
      runtimeContextJson: "{}",
      metricsJson: "{}",
    });
    await createWorkflowTaskPg(db, { id: "implement", runId: "run-session-ops", taskKey: "implement", status: "failed", sortOrder: 0, dependsOn: [] });

    const reset = await applySessionRecoveryOperationPg(db, {
      runId: "run-session-ops",
      taskId: "implement",
      sessionId: "session-old",
      path: "reset-session",
      checkpointId: "checkpoint-base",
      reason: "reset after validation failure",
      approved: true,
    });
    assert.equal(reset.status, "succeeded");
    assert.equal(reset.newSessionId, "root-run-session-ops-implement-reset-2");

    const task = await db.one<{ status: string; root_session_id: string | null }>(
      "select status, root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
      ["run-session-ops", "implement"],
    );
    assert.equal(task.status, "pending");
    assert.equal(task.root_session_id, "root-run-session-ops-implement-reset-2");

    const rollbackBlocked = await applySessionRecoveryOperationPg(db, {
      runId: "run-session-ops",
      taskId: "implement",
      sessionId: "session-old",
      path: "rollback-session",
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace-snapshot-1",
      reason: "rollback workspace",
      approved: false,
    });
    assert.equal(rollbackBlocked.status, "waiting_operator_approval");

    const rollback = await applySessionRecoveryOperationPg(db, {
      runId: "run-session-ops",
      taskId: "implement",
      sessionId: "session-old",
      path: "rollback-session",
      checkpointId: "checkpoint-base",
      workspaceSnapshotRef: "workspace-snapshot-1",
      reason: "rollback workspace",
      approved: true,
    });
    assert.equal(rollback.status, "succeeded");
    const markers = await listResourcesPg(db, { resourceType: "rollback_marker" });
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.status, "created");
  } finally {
    await db.close();
  }
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./session-recovery-operations.test.ts");
```

- [ ] **Step 2: Run the failing session operations test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL with missing `src/v2/session-recovery/session-operations.ts`.

- [ ] **Step 3: Implement session operations helper**

Create `src/v2/session-recovery/session-operations.ts`:

```ts
import type { RecoveryPath } from "../exceptions/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type ApplySessionRecoveryOperationInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  path: Extract<RecoveryPath, "fork-session" | "reset-session" | "rollback-session">;
  checkpointId: string;
  workspaceSnapshotRef?: string;
  reason: string;
  approved: boolean;
};

export type ApplySessionRecoveryOperationResult = {
  status: "succeeded" | "waiting_operator_approval";
  newSessionId?: string;
  markerId?: string;
};

export async function applySessionRecoveryOperationPg(
  db: SouthstarDb,
  input: ApplySessionRecoveryOperationInput,
): Promise<ApplySessionRecoveryOperationResult> {
  if (input.path === "rollback-session" && !input.approved) return { status: "waiting_operator_approval" };
  if (input.path === "rollback-session" && !input.workspaceSnapshotRef) throw new Error("rollback-session requires workspaceSnapshotRef");
  const nextAttempt = await nextAttemptNumber(db, input.runId, input.taskId, input.path);
  const newSessionId = `root-${input.runId}-${input.taskId}-${operationName(input.path)}-${nextAttempt}`;
  const operationId = `session_operation:${input.runId}:${input.taskId}:${input.path}:${nextAttempt}`;
  await upsertRuntimeResourcePg(db, {
    id: operationId,
    resourceType: `session_${operationName(input.path)}`,
    resourceKey: operationId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "session",
    status: "succeeded",
    title: `Session ${operationName(input.path)}`,
    payload: {
      schemaVersion: "southstar.session_operation.v1",
      operationId,
      runId: input.runId,
      taskId: input.taskId,
      oldSessionId: input.sessionId,
      newSessionId,
      checkpointId: input.checkpointId,
      path: input.path,
      reason: input.reason,
      workspaceSnapshotRef: input.workspaceSnapshotRef,
    },
  });
  if (input.path === "rollback-session") {
    const markerId = `rollback-marker:${input.runId}:${input.taskId}:${nextAttempt}`;
    await upsertRuntimeResourcePg(db, {
      id: markerId,
      resourceType: "rollback_marker",
      resourceKey: markerId,
      runId: input.runId,
      taskId: input.taskId,
      sessionId: newSessionId,
      scope: "session",
      status: "created",
      title: "Rollback marker",
      payload: {
        schemaVersion: "southstar.rollback_marker.v1",
        markerId,
        checkpointId: input.checkpointId,
        workspaceSnapshotRef: input.workspaceSnapshotRef,
        invalidatedSourceRefs: [],
        reason: input.reason,
      },
    });
  }
  await db.query(
    "update southstar.workflow_tasks set status = 'pending', root_session_id = $1, completed_at = null, updated_at = now() where run_id = $2 and id = $3",
    [newSessionId, input.runId, input.taskId],
  );
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: `session.${operationName(input.path)}`,
    actorType: "orchestrator",
    idempotencyKey: `${operationId}:history`,
    payload: { operationId, oldSessionId: input.sessionId, newSessionId, checkpointId: input.checkpointId, path: input.path },
  });
  return { status: "succeeded", newSessionId };
}

async function nextAttemptNumber(db: SouthstarDb, runId: string, taskId: string, path: string): Promise<number> {
  const row = await db.one<{ count: string }>(
    "select count(*) as count from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = $3",
    [runId, taskId, `session_${operationName(path)}`],
  );
  return Number(row.count) + 1;
}

function operationName(path: string): "fork" | "reset" | "rollback" {
  if (path === "fork-session") return "fork";
  if (path === "rollback-session") return "rollback";
  return "reset";
}
```

- [ ] **Step 4: Wire session paths into recovery decision applier**

In `src/v2/exceptions/recovery-decision-applier.ts`, import:

```ts
import { applySessionRecoveryOperationPg } from "../session-recovery/session-operations.ts";
```

Add a branch before simple recovery paths:

```ts
if (
  applyingDecision.payload.path === "fork-session"
  || applyingDecision.payload.path === "reset-session"
  || applyingDecision.payload.path === "rollback-session"
) {
  const approved = applyingDecision.status === "approved" || !applyingDecision.payload.operatorApprovalRequired;
  const operation = await applySessionRecoveryOperationPg(deps.db, {
    runId: applyingDecision.payload.runId,
    taskId: requiredTaskId(applyingDecision),
    sessionId: applyingDecision.payload.evidenceRefs[0] ?? "unknown-session",
    path: applyingDecision.payload.path,
    checkpointId: applyingDecision.payload.evidenceRefs.find((ref) => ref.startsWith("checkpoint")) ?? "checkpoint-missing",
    workspaceSnapshotRef: applyingDecision.payload.evidenceRefs.find((ref) => ref.startsWith("workspace-snapshot")),
    reason: applyingDecision.payload.reason,
    approved,
  });
  if (operation.status === "waiting_operator_approval") {
    return { status: "skipped", executionResourceKey: started.resourceKey, reason: "rollback-session waiting for operator approval" };
  }
  await completeRecoveryExecutionPg(deps.db, {
    runId: applyingDecision.payload.runId,
    executionResourceKey: started.resourceKey,
    status: "succeeded",
    completedAt: now,
    stateChanges: [{ resourceType: "workflow_task", resourceKey: requiredTaskId(applyingDecision), toStatus: "pending", reason: applyingDecision.payload.path }],
    providerActions: [],
  });
  return await finalizeRecoveryDecisionAppliedPg(deps.db, { decision: applyingDecision, executionResourceKey: started.resourceKey, now });
}
```

If `requiredTaskId` does not exist, add a local helper:

```ts
function requiredTaskId(decision: RuntimeRecoveryDecisionRecord): string {
  if (!decision.payload.taskId) throw new Error(`recovery decision ${decision.decisionId} requires taskId`);
  return decision.payload.taskId;
}
```

- [ ] **Step 5: Update runtime exception controller decision mapping**

In `src/v2/exceptions/runtime-exception-controller.ts`, map validation/artifact failure to `reset-session` or `repair-artifact` based on existing policy. Keep existing behavior for current tests; add only explicit support for `validation_failed`:

```ts
if (classification.payload.kind === "validation_failed") {
  return "reset-session";
}
```

Use the local decision helper pattern already present in the file.

- [ ] **Step 6: Run recovery/session tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for `session-recovery-operations.test.ts`, `recovery-decision-applier.test.ts`, and operator approval route tests.

- [ ] **Step 7: Commit session operations**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/session-recovery/session-operations.ts src/v2/exceptions/recovery-decision-applier.ts src/v2/exceptions/runtime-exception-controller.ts tests/v2/session-recovery-operations.test.ts tests/v2/recovery-decision-applier.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: apply session recovery operations"
```

---

### Task 9: Remove Legacy Recovery Direct Submit

**Files:**
- Delete: `src/v2/session-recovery/postgres-dispatcher.ts`
- Delete: `tests/v2/postgres-recovery-dispatcher.test.ts`
- Modify: `src/v2/server/routes.ts`
- Create: `tests/v2/legacy-recovery-dispatcher-removal.test.ts`
- Modify: `tests/v2/index.test.ts`
- Modify: `tests/e2e-postgres/cases/04-artifact-repair-recovery.test.ts`
- Modify: `tests/e2e-postgres/cases/05-session-recovery.test.ts`

- [ ] **Step 1: Write the static removal test**

Create `tests/v2/legacy-recovery-dispatcher-removal.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("legacy recovery direct-submit dispatcher is removed from production runtime", () => {
  assert.equal(existsSync(join(root, "src/v2/session-recovery/postgres-dispatcher.ts")), false);
  assert.equal(existsSync(join(root, "tests/v2/postgres-recovery-dispatcher.test.ts")), false);
  for (const path of [
    "src/v2/server/routes.ts",
    "tests/e2e-postgres/cases/04-artifact-repair-recovery.test.ts",
    "tests/e2e-postgres/cases/05-session-recovery.test.ts",
  ]) {
    const text = readFileSync(join(root, path), "utf8");
    assert.doesNotMatch(text, /dispatchRecoveryExecutionPg|recovery\/dispatch|postgres-recovery-dispatcher/);
  }
});
```

Add to `tests/v2/index.test.ts` and remove `await import("./postgres-recovery-dispatcher.test.ts");`:

```ts
await import("./legacy-recovery-dispatcher-removal.test.ts");
```

- [ ] **Step 2: Run the failing removal test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because legacy dispatcher file, test, route, and E2E calls still exist.

- [ ] **Step 3: Remove the server route**

In `src/v2/server/routes.ts`:

- Remove import of `dispatchRecoveryExecutionPg`.
- Remove the `/api/v2/runs/:runId/recovery/dispatch` route block.
- Keep recovery decision approval/apply routes unchanged.

- [ ] **Step 4: Delete legacy dispatcher files**

Use `apply_patch` delete hunks:

```text
*** Delete File: src/v2/session-recovery/postgres-dispatcher.ts
*** Delete File: tests/v2/postgres-recovery-dispatcher.test.ts
```

- [ ] **Step 5: Rewrite E2E cases 04 and 05 away from direct recovery submit**

Update `tests/e2e-postgres/cases/04-artifact-repair-recovery.test.ts` to:

- create failure callback or artifact rejection.
- assert `runtime_exception` and `recovery_decision`.
- call recovery decision apply route or runtime loop.
- assert task returns `pending`.
- run scheduler/per-task hand for retry.
- assert new context packet/task envelope includes failure summary and checkpoint refs.

Update `tests/e2e-postgres/cases/05-session-recovery.test.ts` to:

- create session failure callback.
- assert `before-recovery` checkpoint.
- apply `reset-session` or `reprovision-hand` decision.
- assert new session id and task `pending`.
- run scheduler/per-task hand for retry.
- assert accepted artifact and completion.

Use the existing case helper style and do not call `/recovery/dispatch`.

- [ ] **Step 6: Run removal tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for static removal test and no imports of deleted dispatcher.

- [ ] **Step 7: Commit legacy removal**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/routes.ts tests/v2/index.test.ts tests/v2/legacy-recovery-dispatcher-removal.test.ts tests/e2e-postgres/cases/04-artifact-repair-recovery.test.ts tests/e2e-postgres/cases/05-session-recovery.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add --update src/v2/session-recovery/postgres-dispatcher.ts tests/v2/postgres-recovery-dispatcher.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "refactor: remove legacy recovery dispatcher"
```

---

### Task 10: Read Models And Routes

**Files:**
- Modify: `src/v2/read-models/postgres-core.ts`
- Modify: `src/v2/read-models/managed-agents.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `tests/v2/postgres-core-read-models-api.test.ts`
- Modify: `tests/v2/managed-agents-read-model.test.ts`

- [ ] **Step 1: Write failing read model assertions**

In `tests/v2/managed-agents-read-model.test.ts`, add a test that seeds `context_packet`, `task_envelope`, `context_assembly_trace`, `memory_item`, `memory_delta`, and `rollback_marker`, then asserts the read model exposes them:

```ts
assert.equal(model.resources.some((resource) => resource.resourceType === "context_assembly_trace"), true);
assert.equal(model.resources.some((resource) => resource.resourceType === "task_envelope"), true);
assert.equal(model.resources.some((resource) => resource.resourceType === "rollback_marker"), true);
assert.equal(model.resources.some((resource) => resource.resourceType === "memory_delta"), true);
```

In `tests/v2/postgres-core-read-models-api.test.ts`, extend sessions-memory expectations:

```ts
assert.equal(sessions.data.memory.some((item: { status?: string }) => item.status === "active"), true);
assert.equal(sessions.data.memoryDeltas.some((item: { status?: string }) => item.status === "pending_approval"), true);
```

- [ ] **Step 2: Run failing read model tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: FAIL because read models do not expose all managed context resources.

- [ ] **Step 3: Update core sessions-memory model**

In `src/v2/read-models/postgres-core.ts`, change `sessionsMemory`:

```ts
async function sessionsMemory(db: SouthstarDb, runId: string) {
  const sessions = await resources(db, runId, "session");
  const memory = await resources(db, runId, "memory_item");
  const memoryDeltas = await resources(db, runId, "memory_delta");
  const rollbacks = await resources(db, runId, "rollback_marker");
  return {
    sessions: sessions.map(mapResource),
    memory: memory.map(mapResource),
    memoryDeltas: memoryDeltas.map(mapResource),
    rollbacks: rollbacks.map(mapResource),
  };
}
```

- [ ] **Step 4: Update managed agents read model resource set**

In `src/v2/read-models/managed-agents.ts`, include:

```ts
"task_envelope",
"context_assembly_trace",
"memory_item",
"memory_delta",
"rollback_marker",
"artifact_repair_marker",
```

in the managed resource types list.

- [ ] **Step 5: Run read model tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS for read-model tests.

- [ ] **Step 6: Commit read model updates**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models/postgres-core.ts src/v2/read-models/managed-agents.ts src/v2/server/routes.ts tests/v2/postgres-core-read-models-api.test.ts tests/v2/managed-agents-read-model.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: expose managed context read models"
```

---

### Task 11: Real E2E Normal Flow

**Files:**
- Create: `tests/e2e-postgres/cases/25-normal-context-session-memory-flow.test.ts`
- Modify: `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- Modify: `tests/e2e-postgres/README.md`
- Modify: `package.json`

- [ ] **Step 1: Add package script and matrix entry**

In `package.json`, add:

```json
"test:e2e:postgres:25": "tsx tests/e2e-postgres/cases/25-normal-context-session-memory-flow.test.ts"
```

In `tests/e2e-postgres/postgres-real-matrix-static.test.ts`, add `"25-normal-context-session-memory-flow.test.ts"` to `implementedCases`.

In `tests/e2e-postgres/README.md`, add case 25 to implemented order and matrix:

```md
npm run test:e2e:postgres:25   # normal managed context/session/memory propagation
```

- [ ] **Step 2: Write real E2E normal flow case**

Create `tests/e2e-postgres/cases/25-normal-context-session-memory-flow.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForExecutorBindingStatus,
  waitForTorkJob,
} from "../postgres-real-harness.ts";

test("25 normal context/session/memory flow: real Tork/Pi propagates context from task A to task B", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "normal managed context E2E: produce an implementation artifact and validate it using injected run-local memory" }),
    });
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    await api(server.port, `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`, { method: "POST", body: "{}" });

    assert.equal(run.taskIds.length >= 2, true, "normal context E2E requires producer and consumer tasks");
    const taskA = run.taskIds[0]!;
    const taskB = run.taskIds[1]!;

    await waitUntilContextEnvelopeExists(env.db, run.runId, taskA);
    const firstBinding = await waitForLatestExecutorBinding(env.db, run.runId, taskA);
    await waitForTorkJob(infra.torkBaseUrl, firstBinding.torkJobId);
    await waitForExecutorBindingStatus(env.db, firstBinding.bindingId, ["completed"]);

    await waitUntilContextEnvelopeExists(env.db, run.runId, taskB);
    const secondContext = await latestContextPacket(env.db, run.runId, taskB);
    assert.equal((secondContext.payload_json.priorArtifacts ?? []).length > 0, true);
    assert.equal((secondContext.payload_json.selectedMemories ?? []).length > 0, true);
    assert.equal(Boolean(secondContext.payload_json.managedSourceRefs?.artifactRefs?.length), true);
    assert.equal(Boolean(secondContext.payload_json.managedSourceRefs?.memoryRefs?.length), true);

    const secondEnvelope = await latestTaskEnvelope(env.db, run.runId, taskB);
    assert.equal(secondEnvelope.payload_json.envelope.contextPacket.id, secondContext.resource_key);

    const secondBinding = await waitForLatestExecutorBinding(env.db, run.runId, taskB);
    await waitForTorkJob(infra.torkBaseUrl, secondBinding.torkJobId);
    await waitForExecutorBindingStatus(env.db, secondBinding.bindingId, ["completed"]);

    const artifactRefs = await env.db.query<{ status: string }>(
      "select status from southstar.runtime_resources where run_id = $1 and resource_type = 'artifact_ref'",
      [run.runId],
    );
    assert.equal(artifactRefs.rows.filter((row) => row.status === "accepted").length >= 2, true);
  } finally {
    await server.close();
    await env.close();
  }
});

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

async function waitUntilContextEnvelopeExists(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.maybeOne("select 1 from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'task_envelope'", [runId, taskId]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`task envelope did not appear for ${runId}/${taskId}`);
}

async function waitForLatestExecutorBinding(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string, taskId: string): Promise<{ bindingId: string; torkJobId: string }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.maybeOne<{ resource_key: string; payload_json: { torkJobId?: string; externalJobId?: string } }>(
      "select resource_key, payload_json from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'executor_binding' order by created_at desc limit 1",
      [runId, taskId],
    );
    const torkJobId = row?.payload_json.torkJobId ?? row?.payload_json.externalJobId;
    if (row && torkJobId) return { bindingId: row.resource_key, torkJobId };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`executor binding did not appear for ${runId}/${taskId}`);
}

async function latestContextPacket(db: { one<T>(sql: string, params?: unknown[]): Promise<T> }, runId: string, taskId: string) {
  return await db.one<{ resource_key: string; payload_json: { priorArtifacts?: unknown[]; selectedMemories?: unknown[]; managedSourceRefs?: { artifactRefs?: string[]; memoryRefs?: string[] } } }>(
    "select resource_key, payload_json from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'context_packet' order by created_at desc limit 1",
    [runId, taskId],
  );
}

async function latestTaskEnvelope(db: { one<T>(sql: string, params?: unknown[]): Promise<T> }, runId: string, taskId: string) {
  return await db.one<{ payload_json: { envelope: { contextPacket: { id: string } } } }>(
    "select payload_json from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'task_envelope' order by created_at desc limit 1",
    [runId, taskId],
  );
}
```

- [ ] **Step 3: Run static matrix**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres
```

Expected: PASS static matrix with case 25 included.

- [ ] **Step 4: Run real E2E case 25 when infrastructure is ready**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT="${PI_HARNESS_ENDPOINT:?set PI_HARNESS_ENDPOINT to the local Pi harness URL}" \
SOUTHSTAR_CALLBACK_HOST=172.17.0.1 \
npm run test:e2e:postgres:25
```

Expected: PASS with real Postgres rows for two task envelopes, accepted artifacts, session events, and memory refs.

- [ ] **Step 5: Commit E2E normal case**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add package.json tests/e2e-postgres/cases/25-normal-context-session-memory-flow.test.ts tests/e2e-postgres/postgres-real-matrix-static.test.ts tests/e2e-postgres/README.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover normal managed context e2e"
```

---

### Task 12: Real E2E Abnormal Flow

**Files:**
- Create: `tests/e2e-postgres/cases/26-abnormal-context-session-memory-recovery.test.ts`
- Modify: `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- Modify: `tests/e2e-postgres/README.md`
- Modify: `package.json`

- [ ] **Step 1: Add package script and matrix entry**

In `package.json`, add:

```json
"test:e2e:postgres:26": "tsx tests/e2e-postgres/cases/26-abnormal-context-session-memory-recovery.test.ts"
```

In `tests/e2e-postgres/postgres-real-matrix-static.test.ts`, add `"26-abnormal-context-session-memory-recovery.test.ts"` to `implementedCases`.

In `tests/e2e-postgres/README.md`, add:

```md
npm run test:e2e:postgres:26   # abnormal managed context/session/memory recovery
```

- [ ] **Step 2: Write real E2E abnormal flow case**

Create `tests/e2e-postgres/cases/26-abnormal-context-session-memory-recovery.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  requireRealPostgresInfra,
  waitForExecutorBindingStatus,
  waitForTorkJob,
} from "../postgres-real-harness.ts";

test("26 abnormal context/session/memory recovery: validator failure rebuilds producer context through real Tork/Pi", async () => {
  const infra = requireRealPostgresInfra();
  await probeRealPostgresTorkPi(infra);
  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({ goalPrompt: "abnormal managed context E2E: produce an artifact, fail validation, repair with run-local memory" }),
    });
    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    await api(server.port, `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`, { method: "POST", body: "{}" });

    const producerTaskId = run.taskIds[0]!;
    const firstBinding = await waitForLatestExecutorBinding(env.db, run.runId, producerTaskId);
    await waitForTorkJob(infra.torkBaseUrl, firstBinding.torkJobId);
    await waitForExecutorBindingStatus(env.db, firstBinding.bindingId, ["completed"]);

    const producerArtifact = await latestAcceptedArtifact(env.db, run.runId, producerTaskId);
    await api(server.port, "/api/v2/tork/callback", {
      method: "POST",
      body: JSON.stringify({
        runId: run.runId,
        taskId: producerTaskId,
        rootSessionId: `root-${run.runId}-${producerTaskId}`,
        ok: false,
        attempts: 2,
        attemptId: `${producerTaskId}-attempt-2`,
        artifact: {
          kind: "validation_report",
          summary: "Validator found producer artifact missing command evidence.",
          failedArtifactRefs: [producerArtifact.resource_key],
          memoryCandidates: [{
            scope: "software",
            kind: "failure_lesson",
            text: "Producer repairs should include command evidence after validator failure.",
            tags: ["validator", "repair"],
            confidence: 0.8,
            successScore: 0.7,
          }],
        },
        metrics: { durationMs: 1 },
        events: [{ eventType: "validator.finding", actorType: "evaluator", sessionId: `root-${run.runId}-${producerTaskId}`, payload: { failedArtifactRefs: [producerArtifact.resource_key] } }],
        receivedAt: "2026-06-22T02:00:00.000Z",
      }),
    });

    await waitForRuntimeException(env.db, run.runId);
    await waitForRecoveryDecision(env.db, run.runId);
    const applyResult = await api<{ status: string }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/recovery-decisions/${encodeURIComponent(await latestRecoveryDecisionKey(env.db, run.runId))}/apply`,
      { method: "POST", body: "{}" },
    );
    assert.match(applyResult.status, /applied|blocked|skipped/);

    await waitForTaskPending(env.db, run.runId, producerTaskId);
    await api(server.port, `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`, { method: "POST", body: "{}" });

    await waitUntilContextEnvelopeExists(env.db, run.runId, producerTaskId);
    const retryContext = await latestContextPacket(env.db, run.runId, producerTaskId);
    assert.equal(Boolean(retryContext.payload_json.failureSummary), true);
    assert.equal(Boolean(retryContext.payload_json.selectedMemories?.length), true);
    assert.equal(Boolean(retryContext.payload_json.managedSourceRefs?.checkpointRefs?.length), true);

    const retryBinding = await waitForLatestExecutorBinding(env.db, run.runId, producerTaskId);
    await waitForTorkJob(infra.torkBaseUrl, retryBinding.torkJobId);
    await waitForExecutorBindingStatus(env.db, retryBinding.bindingId, ["completed"]);

    const retryArtifact = await latestAcceptedArtifact(env.db, run.runId, producerTaskId);
    assert.notEqual(retryArtifact.resource_key, producerArtifact.resource_key);
  } finally {
    await server.close();
    await env.close();
  }
});

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

async function waitForLatestExecutorBinding(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string, taskId: string): Promise<{ bindingId: string; torkJobId: string }> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.maybeOne<{ resource_key: string; payload_json: { torkJobId?: string; externalJobId?: string } }>(
      "select resource_key, payload_json from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'executor_binding' order by created_at desc limit 1",
      [runId, taskId],
    );
    const torkJobId = row?.payload_json.torkJobId ?? row?.payload_json.externalJobId;
    if (row && torkJobId) return { bindingId: row.resource_key, torkJobId };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`executor binding did not appear for ${runId}/${taskId}`);
}

async function latestAcceptedArtifact(db: { one<T>(sql: string, params?: unknown[]): Promise<T> }, runId: string, taskId: string) {
  return await db.one<{ resource_key: string }>(
    "select resource_key from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'artifact_ref' and status = 'accepted' order by created_at desc limit 1",
    [runId, taskId],
  );
}

async function waitForRuntimeException(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string): Promise<void> {
  await waitForRow(db, "runtime_exception", runId);
}

async function waitForRecoveryDecision(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string): Promise<void> {
  await waitForRow(db, "recovery_decision", runId);
}

async function waitForRow(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, resourceType: string, runId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.maybeOne("select 1 from southstar.runtime_resources where run_id = $1 and resource_type = $2", [runId, resourceType]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${resourceType} did not appear for ${runId}`);
}

async function latestRecoveryDecisionKey(db: { one<T>(sql: string, params?: unknown[]): Promise<T> }, runId: string): Promise<string> {
  const row = await db.one<{ resource_key: string }>(
    "select resource_key from southstar.runtime_resources where run_id = $1 and resource_type = 'recovery_decision' order by created_at desc limit 1",
    [runId],
  );
  return row.resource_key;
}

async function waitForTaskPending(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.maybeOne<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1 and id = $2", [runId, taskId]);
    if (row?.status === "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`task did not return to pending: ${runId}/${taskId}`);
}

async function waitUntilContextEnvelopeExists(db: { maybeOne<T>(sql: string, params?: unknown[]): Promise<T | null> }, runId: string, taskId: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await db.maybeOne("select 1 from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'task_envelope'", [runId, taskId]);
    if (row) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`task envelope did not appear for ${runId}/${taskId}`);
}

async function latestContextPacket(db: { one<T>(sql: string, params?: unknown[]): Promise<T> }, runId: string, taskId: string) {
  return await db.one<{ payload_json: { failureSummary?: unknown; selectedMemories?: unknown[]; managedSourceRefs?: { checkpointRefs?: string[] } } }>(
    "select payload_json from southstar.runtime_resources where run_id = $1 and task_id = $2 and resource_type = 'context_packet' order by created_at desc limit 1",
    [runId, taskId],
  );
}
```

Keep this case fail-closed if real infra is absent through `requireRealPostgresInfra()` and `probeRealPostgresTorkPi()`.

- [ ] **Step 3: Run static matrix**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres
```

Expected: PASS static matrix with case 26 included.

- [ ] **Step 4: Run real E2E case 26 when infrastructure is ready**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT="${PI_HARNESS_ENDPOINT:?set PI_HARNESS_ENDPOINT to the local Pi harness URL}" \
SOUTHSTAR_CALLBACK_HOST=172.17.0.1 \
npm run test:e2e:postgres:26
```

Expected: PASS with real recovery decision, recovery execution, before-recovery checkpoint, run-local failure memory, rebuilt context packet, and retry artifact evidence.

- [ ] **Step 5: Commit E2E abnormal case**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add package.json tests/e2e-postgres/cases/26-abnormal-context-session-memory-recovery.test.ts tests/e2e-postgres/postgres-real-matrix-static.test.ts tests/e2e-postgres/README.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover abnormal managed context e2e"
```

---

### Task 13: Final Verification And Documentation

**Files:**
- Modify: `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`
- Modify: `docs/manuals/2026-06-17-southstar-session-management-manual.zh-TW.md`
- Modify: `tests/e2e-postgres/README.md`

- [ ] **Step 1: Update managed runtime runbook**

In `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`, add a section after recovery decision apply:

```md
## 4.2 managed context / session / memory

1. 每個 executable attempt 必須有 `context_packet`、`task_envelope`、`context_assembly_trace`。
2. `task_envelope.payload.envelope.contextPacket.id` 必須等於同 task 最新 `context_packet.resource_key`。
3. normal downstream task 應只讀 accepted `artifact_ref`、active run-local memory、approved long-term memory。
4. reset-session 會排除 failed suffix；rollback-session 會排除 rollback marker 覆蓋的 refs。
5. recovery applier 不 submit Tork；task 回 `pending` 後由 scheduler 重建 context 並 per-task submit。
```

- [ ] **Step 2: Update session manual**

In `docs/manuals/2026-06-17-southstar-session-management-manual.zh-TW.md`, update the fork/reset/rollback matrix:

```md
| `session fork` | recovery decision `fork-session` | 建新 branch session + task pending | 是，由 scheduler | 否 |
| `session reset` | recovery decision `reset-session` | 新 attempt/session，排除 checkpoint 後 failed suffix | 是，由 scheduler | 否 |
| `session rollback` | recovery decision `rollback-session` | 需 approval，workspace rollback + rollback marker | 是，由 scheduler | 是 |
```

- [ ] **Step 3: Run full verification**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
```

Expected: PASS.

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS.

Run:

```bash
node_modules/.bin/tsc --noEmit
```

Expected: exit 0. If `.next/types` route generation is required, run `npm run web:build` once and then rerun `node_modules/.bin/tsc --noEmit`.

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres
```

Expected: PASS static matrix.

Run real cases when infrastructure is available:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT="${PI_HARNESS_ENDPOINT:?set PI_HARNESS_ENDPOINT to the local Pi harness URL}" \
SOUTHSTAR_CALLBACK_HOST=172.17.0.1 \
npm run test:e2e:postgres:25
```

Expected: PASS normal session/memory/context flow.

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT="${PI_HARNESS_ENDPOINT:?set PI_HARNESS_ENDPOINT to the local Pi harness URL}" \
SOUTHSTAR_CALLBACK_HOST=172.17.0.1 \
npm run test:e2e:postgres:26
```

Expected: PASS abnormal recovery session/memory/context flow.

- [ ] **Step 4: Commit docs and final verification updates**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md docs/manuals/2026-06-17-southstar-session-management-manual.zh-TW.md tests/e2e-postgres/README.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: document managed context operations"
```

## Final Acceptance Checklist

- [ ] `ManagedContextAssembler` is the scheduler path for all executable attempts.
- [ ] `context_packet`, `task_envelope`, and `context_assembly_trace` exist for every submitted attempt.
- [ ] run-local memory is injected inside the same workflow without approval.
- [ ] long-term memory stays pending until approval.
- [ ] reset-session and rollback-session affect context selection through durable markers.
- [ ] rollback-session requires operator approval and workspace snapshot evidence.
- [ ] `dispatchRecoveryExecutionPg()` and `/recovery/dispatch` are removed from production runtime.
- [ ] consumer failure can target producer repair through artifact lineage, without role-specific code.
- [ ] real E2E case 25 proves normal Tork/Pi/Postgres session/memory/context propagation.
- [ ] real E2E case 26 proves abnormal Tork/Pi/Postgres recovery context propagation.

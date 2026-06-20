# Southstar Managed Runtime Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the managed runtime contract design so Southstar owns scheduling, artifact gating, evaluator completion, work item intake, tool proxy enforcement, and per-task Tork hand execution.

**Architecture:** Postgres remains the canonical runtime store. `/execute` starts Southstar scheduling only; the scheduler creates brain intent and per-task hand executions; Tork is used behind `TorkHandProvider.executeTask()` for one task attempt. `artifact_ref`, evaluator completion gate, work item run refs, and tool proxy policy resources become the contracts used by dependency, security, recovery, and read models.

**Tech Stack:** TypeScript, Node.js, Postgres, Tork executor provider, `node:test`, `tsx`, existing Southstar v2 runtime stores.

---

## Scope Check

The spec covers five runtime contracts, but they are one dependency chain rather than independent products:

1. `artifact_ref` is required before scheduler dependency and evaluator completion can be correct.
2. Evaluator completion depends on `artifact_ref`, task status, recovery, and tool proxy violations.
3. Work item intake feeds run metadata and attempt policy into the same runtime path.
4. Tool proxy enforcement must run before hand execution and before artifact acceptance.
5. Native brain-hand loop is the execution path that ties all contracts together.

This plan keeps them in one implementation plan because each task leaves a runnable, tested Southstar runtime surface.

## File Structure

Create focused files instead of expanding existing large files:

- Create `src/v2/artifacts/artifact-ref-store.ts` for artifact ref payload construction, hashing, idempotent upsert, and accepted dependency queries.
- Modify `src/v2/artifacts/types.ts` to export canonical artifact ref types and constants.
- Modify `src/v2/executor/postgres-tork-callback.ts` so callbacks write `artifact_ref`, update `hand_execution`, and no longer directly mark runs final.
- Create `src/v2/evaluators/completion-gate.ts` for the end-state reducer that turns all-terminal runs into `evaluating`, then `passed` or `failed`.
- Create `src/v2/work-items/intake-service.ts` for source normalization, dedupe, work item creation, and run attempt linkage.
- Modify `src/v2/work-items/types.ts` for the richer `WorkItemRunRef`.
- Create `src/v2/tool-proxy/policy-enforcer.ts` for context/envelope/callback scanning and violation resources.
- Modify `src/v2/tool-proxy/types.ts` for policy and violation payload types.
- Create `src/v2/brain/task-intent.ts` for `TaskExecutionIntent` and deterministic default intent creation.
- Modify `src/v2/hands/types.ts` to add `ExecuteTaskInput`, `HandExecutionPayload`, and optional `executeTask`.
- Modify `src/v2/hands/tork-hand-provider.ts` to submit one-task Tork jobs through `executeTask`.
- Modify `src/v2/scheduler/runnable-task-scheduler.ts` to claim `pending -> claimed`, create intent, enforce policy, call `executeTask`, and transition `queued`.
- Create `src/v2/server/run-execution-controller.ts` for thin `/execute`.
- Modify `src/v2/server/routes.ts` to call the thin controller and add work item intake route.
- Modify `src/v2/server/runtime-context.ts` only if additional service dependencies are needed.
- Modify read models under `src/v2/read-models/` and inspections under `src/v2/inspection/` only after canonical resources exist.
- Add tests under `tests/v2/` first for unit/contract behavior.
- Add or update tests under `tests/e2e-postgres/` after unit and Postgres integration paths pass.

Use the repo-local git command when committing:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add <files>
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "<message>"
```

## Task 1: Canonical `artifact_ref` Store

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/artifacts/types.ts`
- Create: `/home/timmypai/apps/southstar/src/v2/artifacts/artifact-ref-store.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/scheduler/runnable-task-scheduler.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/artifact-ref-store.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing artifact ref store tests**

Create `/home/timmypai/apps/southstar/tests/v2/artifact-ref-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPostgresTestDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { acceptOrRejectArtifactRefPg, acceptedArtifactTaskIdsForRunPg } from "../../src/v2/artifacts/artifact-ref-store.ts";

test("artifact_ref store writes deterministic accepted refs and accepted dependency task ids", async () => {
  const db = await createInMemoryPostgresTestDb();
  await createWorkflowRunPg(db, {
    id: "run-artifact-ref",
    status: "running",
    domain: "software",
    goalPrompt: "ship a feature",
    workflowManifestJson: JSON.stringify({ id: "wf", tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: "task-a",
    runId: "run-artifact-ref",
    taskKey: "task-a",
    status: "running",
    sortOrder: 1,
    dependsOn: [],
    subagentSessionIds: [],
  });

  const first = await acceptOrRejectArtifactRefPg(db, {
    runId: "run-artifact-ref",
    taskId: "task-a",
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-exec-1",
    producer: { actorType: "hand", providerId: "tork" },
    artifactType: "completion_report",
    status: "accepted",
    contractRefs: ["completion_report"],
    summary: "completed implementation",
    evidenceRefs: ["history:1"],
    evaluatorResultRefs: [],
    sourceEventRefs: ["executor.callback_received"],
    content: { acceptedArtifacts: ["src/app.ts"], tests: ["npm test"] },
  });
  const second = await acceptOrRejectArtifactRefPg(db, {
    runId: "run-artifact-ref",
    taskId: "task-a",
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-exec-1",
    producer: { actorType: "hand", providerId: "tork" },
    artifactType: "completion_report",
    status: "accepted",
    contractRefs: ["completion_report"],
    summary: "completed implementation",
    evidenceRefs: ["history:1"],
    evaluatorResultRefs: [],
    sourceEventRefs: ["executor.callback_received"],
    content: { acceptedArtifacts: ["src/app.ts"], tests: ["npm test"] },
  });

  assert.equal(first.resourceId, second.resourceId);
  assert.equal(first.artifactRefId, second.artifactRefId);
  assert.deepEqual([...(await acceptedArtifactTaskIdsForRunPg(db, "run-artifact-ref"))], ["task-a"]);

  const resources = await listResourcesPg(db, { resourceType: "artifact_ref" });
  assert.equal(resources.length, 1);
  assert.equal(resources[0]!.status, "accepted");
  assert.equal(resources[0]!.scope, "artifact");
  assert.equal(resources[0]!.payload.schemaVersion, "southstar.runtime.artifact_ref.v1");
  assert.equal(resources[0]!.payload.handExecutionId, "hand-exec-1");
});

test("legacy artifact rows do not count as accepted dependency refs", async () => {
  const db = await createInMemoryPostgresTestDb();
  await createWorkflowRunPg(db, {
    id: "run-legacy-artifact",
    status: "running",
    domain: "software",
    goalPrompt: "ship a feature",
    workflowManifestJson: JSON.stringify({ id: "wf", tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  await db.query(
    `insert into southstar.runtime_resources (
      id, resource_type, resource_key, run_id, task_id, session_id, scope, status,
      title, payload_json, summary_json, metrics_json
    ) values (
      'legacy-artifact-1', 'artifact', 'legacy-artifact-1', 'run-legacy-artifact', 'task-a', 'session-a',
      'artifact', 'accepted', 'Legacy artifact', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
    )`,
  );

  assert.deepEqual([...(await acceptedArtifactTaskIdsForRunPg(db, "run-legacy-artifact"))], []);
});
```

Add the import to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./artifact-ref-store.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/artifacts/artifact-ref-store.ts`.

- [ ] **Step 3: Add artifact ref types**

In `/home/timmypai/apps/southstar/src/v2/artifacts/types.ts`, replace the current contents with:

```ts
export const ARTIFACT_EVIDENCE_SCHEMA_VERSION = "southstar.runtime.artifact_ref.v1";
export const ARTIFACT_REF_RESOURCE_TYPE = "artifact_ref";

export type ArtifactRefStatus = "accepted" | "rejected" | "needs_repair";

export type ArtifactRefProducer = {
  actorType: "hand" | "brain" | "tool-proxy" | "evaluator";
  providerId: string;
};

export type ArtifactContentRef = {
  kind: "runtime_resource" | "secure_blob" | "external_url" | "inline_digest";
  ref: string;
  sha256: string;
};

export type ArtifactRefPayload = {
  schemaVersion: typeof ARTIFACT_EVIDENCE_SCHEMA_VERSION;
  artifactRefId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  producer: ArtifactRefProducer;
  artifactType: string;
  status: ArtifactRefStatus;
  contentRef?: ArtifactContentRef;
  contractRefs: string[];
  summary: string;
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  sourceEventRefs: string[];
  producedAt: string;
};
```

- [ ] **Step 4: Implement artifact ref store**

Create `/home/timmypai/apps/southstar/src/v2/artifacts/artifact-ref-store.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import {
  ARTIFACT_EVIDENCE_SCHEMA_VERSION,
  ARTIFACT_REF_RESOURCE_TYPE,
  type ArtifactRefPayload,
  type ArtifactRefProducer,
  type ArtifactRefStatus,
} from "./types.ts";

export type ArtifactRefWriteInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  producer: ArtifactRefProducer;
  artifactType: string;
  status: ArtifactRefStatus;
  contractRefs: string[];
  summary: string;
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  sourceEventRefs: string[];
  content: unknown;
  producedAt?: string;
};

export type ArtifactRefWriteResult = {
  resourceId: string;
  artifactRefId: string;
  contentHash: string;
};

export async function acceptOrRejectArtifactRefPg(db: SouthstarDb, input: ArtifactRefWriteInput): Promise<ArtifactRefWriteResult> {
  const contentHash = sha256Stable(input.content);
  const artifactRefId = `artifact_ref:${input.runId}:${input.taskId}:${input.attemptId}:${contentHash}`;
  const producedAt = input.producedAt ?? new Date().toISOString();
  const payload: ArtifactRefPayload = {
    schemaVersion: ARTIFACT_EVIDENCE_SCHEMA_VERSION,
    artifactRefId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId: input.attemptId,
    handExecutionId: input.handExecutionId,
    producer: input.producer,
    artifactType: input.artifactType,
    status: input.status,
    contentRef: {
      kind: "inline_digest",
      ref: contentHash,
      sha256: contentHash,
    },
    contractRefs: [...input.contractRefs].sort(),
    summary: input.summary,
    evidenceRefs: [...input.evidenceRefs],
    evaluatorResultRefs: [...input.evaluatorResultRefs],
    sourceEventRefs: [...input.sourceEventRefs],
    producedAt,
  };
  const resource = await upsertRuntimeResourcePg(db, {
    id: artifactRefId,
    resourceType: ARTIFACT_REF_RESOURCE_TYPE,
    resourceKey: artifactRefId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "artifact",
    status: input.status,
    title: `Artifact ref ${input.taskId}`,
    payload,
    summary: {
      artifactRefId,
      artifactType: input.artifactType,
      contractRefs: payload.contractRefs,
      contentHash,
    },
    metrics: {},
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: `artifact.${input.status}`,
    actorType: "orchestrator",
    idempotencyKey: `artifact-ref:${artifactRefId}:${input.status}`,
    payload: { artifactRefId, resourceId: resource.id, contentHash, status: input.status },
  }).catch((error) => {
    if (isUniqueViolation(error)) return { id: artifactRefId, sequence: 0, createdAt: producedAt };
    throw error;
  });
  return { resourceId: resource.id, artifactRefId, contentHash };
}

export async function acceptedArtifactTaskIdsForRunPg(db: SouthstarDb, runId: string): Promise<Set<string>> {
  const rows = await db.query<{ task_id: string }>(
    `select distinct task_id
       from southstar.runtime_resources
      where run_id = $1
        and task_id is not null
        and resource_type = 'artifact_ref'
        and status = 'accepted'
      order by task_id`,
    [runId],
  );
  return new Set(rows.rows.map((row) => row.task_id));
}

export function sha256Stable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /duplicate key|unique constraint|23505/i.test(error.message);
}
```

- [ ] **Step 5: Reuse artifact ref store in scheduler**

In `/home/timmypai/apps/southstar/src/v2/scheduler/runnable-task-scheduler.ts`, add:

```ts
import { acceptedArtifactTaskIdsForRunPg } from "../artifacts/artifact-ref-store.ts";
```

Delete the local `acceptedArtifactTaskIdsForRun()` function. Replace:

```ts
const acceptedArtifactTaskIds = await acceptedArtifactTaskIdsForRun(db, input.runId);
```

with:

```ts
const acceptedArtifactTaskIds = await acceptedArtifactTaskIdsForRunPg(db, input.runId);
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/artifacts/types.ts src/v2/artifacts/artifact-ref-store.ts src/v2/scheduler/runnable-task-scheduler.ts tests/v2/artifact-ref-store.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add canonical artifact ref store"
```

## Task 2: Evaluator Completion Gate

**Files:**
- Create: `/home/timmypai/apps/southstar/src/v2/evaluators/completion-gate.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/executor/postgres-tork-callback.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/completion-gate.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing completion gate tests**

Create `/home/timmypai/apps/southstar/tests/v2/completion-gate.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPostgresTestDb } from "./postgres-test-utils.ts";
import { acceptOrRejectArtifactRefPg } from "../../src/v2/artifacts/artifact-ref-store.ts";
import { evaluateRunCompletionGatePg } from "../../src/v2/evaluators/completion-gate.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listHistoryForRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("completion gate moves all-completed run through evaluating to passed", async () => {
  const db = await createInMemoryPostgresTestDb();
  await seedRunWithTasks(db, "run-completion-pass", ["task-a"]);
  await db.query("update southstar.workflow_tasks set status = 'completed' where run_id = $1", ["run-completion-pass"]);
  await acceptOrRejectArtifactRefPg(db, {
    runId: "run-completion-pass",
    taskId: "task-a",
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-exec-1",
    producer: { actorType: "hand", providerId: "tork" },
    artifactType: "completion_report",
    status: "accepted",
    contractRefs: ["completion_report"],
    summary: "complete",
    evidenceRefs: [],
    evaluatorResultRefs: [],
    sourceEventRefs: [],
    content: { final: true, refs: ["task-a"] },
  });

  const result = await evaluateRunCompletionGatePg(db, { runId: "run-completion-pass" });

  assert.equal(result.status, "passed");
  const run = await db.one<{ status: string; completed_at: string | null }>("select status, completed_at from southstar.workflow_runs where id = $1", ["run-completion-pass"]);
  assert.equal(run.status, "passed");
  assert.equal(typeof run.completed_at, "string");
  const events = await listHistoryForRunPg(db, "run-completion-pass");
  assert.deepEqual(events.map((event) => event.eventType).filter((eventType) => eventType.startsWith("run.")), [
    "run.evaluating_started",
    "run.completed",
  ]);
});

test("completion gate fails closed with missing artifact refs and blocking tool violation", async () => {
  const db = await createInMemoryPostgresTestDb();
  await seedRunWithTasks(db, "run-completion-fail", ["task-a"]);
  await db.query("update southstar.workflow_tasks set status = 'completed' where run_id = $1", ["run-completion-fail"]);
  await upsertRuntimeResourcePg(db, {
    id: "violation-1",
    resourceType: "tool_proxy_violation",
    resourceKey: "violation-1",
    runId: "run-completion-fail",
    taskId: "task-a",
    sessionId: "session-a",
    scope: "security",
    status: "blocking",
    title: "Tool proxy violation",
    payload: { reason: "callback_payload_leak" },
    summary: {},
    metrics: {},
  });

  const result = await evaluateRunCompletionGatePg(db, { runId: "run-completion-fail" });

  assert.equal(result.status, "failed");
  assert.equal(result.findings.some((finding) => finding.includes("missing accepted artifact_ref for task task-a")), true);
  assert.equal(result.findings.some((finding) => finding.includes("blocking tool proxy violation")), true);
});

async function seedRunWithTasks(db: Awaited<ReturnType<typeof createInMemoryPostgresTestDb>>, runId: string, taskIds: string[]) {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "ship feature",
    workflowManifestJson: JSON.stringify({ id: "wf", tasks: taskIds.map((id) => ({ id })) }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  for (const [index, taskId] of taskIds.entries()) {
    await createWorkflowTaskPg(db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "running",
      sortOrder: index + 1,
      dependsOn: [],
      subagentSessionIds: [],
    });
  }
}
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./completion-gate.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/evaluators/completion-gate.ts`.

- [ ] **Step 3: Implement completion gate**

Create `/home/timmypai/apps/southstar/src/v2/evaluators/completion-gate.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, listResourcesPg, updateWorkflowRunStatusPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type CompletionGateResult = {
  runId: string;
  status: "passed" | "failed" | "not_ready";
  findings: string[];
};

type TaskRow = { id: string; status: string };

export async function evaluateRunCompletionGatePg(db: SouthstarDb, input: { runId: string }): Promise<CompletionGateResult> {
  return await db.tx(async (tx) => {
    const tasks = await tx.query<TaskRow>("select id, status from southstar.workflow_tasks where run_id = $1 order by sort_order, id", [input.runId]);
    if (tasks.rows.length === 0) return { runId: input.runId, status: "not_ready", findings: ["run has no tasks"] };
    if (!tasks.rows.every((task) => ["completed", "failed", "cancelled", "lost", "blocked"].includes(task.status))) {
      return { runId: input.runId, status: "not_ready", findings: ["tasks are not terminal"] };
    }

    await updateWorkflowRunStatusPg(tx, input.runId, "evaluating");
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      eventType: "run.evaluating_started",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:evaluating`,
      payload: { taskCount: tasks.rows.length },
    }).catch(ignoreUniqueViolation);

    const acceptedRefs = await listResourcesPg(tx, { resourceType: "artifact_ref", status: "accepted" });
    const acceptedTaskIds = new Set(acceptedRefs.filter((resource) => resource.runId === input.runId).map((resource) => resource.taskId).filter(Boolean));
    const blockingViolations = (await listResourcesPg(tx, { resourceType: "tool_proxy_violation" }))
      .filter((resource) => resource.runId === input.runId && resource.status === "blocking");

    const findings: string[] = [];
    for (const task of tasks.rows) {
      if (task.status !== "completed") findings.push(`task ${task.id} terminal status is ${task.status}`);
      if (!acceptedTaskIds.has(task.id)) findings.push(`missing accepted artifact_ref for task ${task.id}`);
    }
    for (const violation of blockingViolations) {
      findings.push(`blocking tool proxy violation ${violation.id}`);
    }

    const status: "passed" | "failed" = findings.length === 0 ? "passed" : "failed";
    await updateWorkflowRunStatusPg(tx, input.runId, status);
    await upsertRuntimeResourcePg(tx, {
      id: `completion-gate:${input.runId}`,
      resourceType: "evaluator_result",
      resourceKey: `completion-gate:${input.runId}`,
      runId: input.runId,
      scope: "evaluator",
      status,
      title: "Completion gate",
      payload: { status, findings },
      summary: { findingCount: findings.length },
      metrics: {},
    });
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      eventType: "run.completed",
      actorType: "evaluator",
      idempotencyKey: `completion-gate:${input.runId}:completed`,
      payload: { status, findings },
    }).catch(ignoreUniqueViolation);
    return { runId: input.runId, status, findings };
  });
}

function ignoreUniqueViolation(error: unknown): void {
  if (error instanceof Error && /duplicate key|unique constraint|23505/i.test(error.message)) return;
  throw error;
}
```

- [ ] **Step 4: Update callback ingestion to call artifact ref store and completion gate**

In `/home/timmypai/apps/southstar/src/v2/executor/postgres-tork-callback.ts`, add imports:

```ts
import { acceptOrRejectArtifactRefPg } from "../artifacts/artifact-ref-store.ts";
import { evaluateRunCompletionGatePg } from "../evaluators/completion-gate.ts";
```

Replace the `artifact` upsert block with:

```ts
const handExecutionId = result.attemptId
  ? `hand-execution:${result.runId}:${result.taskId}:${result.attemptId}`
  : `hand-execution:${result.runId}:${result.taskId}:attempt-${result.attempts}`;
const artifactRef = await acceptOrRejectArtifactRefPg(tx, {
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  attemptId: result.attemptId ?? `attempt-${result.attempts}`,
  handExecutionId,
  producer: { actorType: "hand", providerId: "tork" },
  artifactType: result.ok ? "task_result" : "task_failure",
  status: result.ok ? "accepted" : "rejected",
  contractRefs: result.ok ? ["task_result"] : ["task_failure"],
  summary: result.ok ? `Task ${result.taskId} completed` : `Task ${result.taskId} failed`,
  evidenceRefs: [],
  evaluatorResultRefs: [],
  sourceEventRefs: ["executor.callback_received"],
  content: result.artifact,
  producedAt: result.receivedAt,
});
const artifactResourceId = artifactRef.resourceId;
```

Keep the legacy `artifact.created` event only as a compatibility event, or rename the payload field to include `artifactRefId`:

```ts
payload: {
  artifactResourceId,
  artifactRefId: artifactRef.artifactRefId,
  attempts: result.attempts,
  accepted: result.ok,
},
```

Replace the direct run terminal update block with:

```ts
const allTasks = await tx.query<{ status: string }>("select status from southstar.workflow_tasks where run_id = $1", [result.runId]);
if (allTasks.rows.length > 0 && allTasks.rows.every((row) => ["completed", "failed", "cancelled", "lost", "blocked"].includes(row.status))) {
  await evaluateRunCompletionGatePg(tx, { runId: result.runId });
  await triggerRunCompletedKnowledgeCardSynthesis(tx, {
    runId: result.runId,
    actor: "southstar-evolution",
    reason: "workflow run completed",
  });
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/evaluators/completion-gate.ts src/v2/executor/postgres-tork-callback.ts tests/v2/completion-gate.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: gate run completion through evaluator"
```

## Task 3: Work Item Intake Automation

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/work-items/types.ts`
- Create: `/home/timmypai/apps/southstar/src/v2/work-items/intake-service.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/work-items/postgres-work-items.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/server/routes.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/work-item-intake.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing intake tests**

Create `/home/timmypai/apps/southstar/tests/v2/work-item-intake.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPostgresTestDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { getWorkItemPg } from "../../src/v2/work-items/postgres-work-items.ts";
import { intakeWorkItemPg, linkRunAttemptFromWorkItemPg } from "../../src/v2/work-items/intake-service.ts";

test("work item intake dedupes external source and preserves metadata", async () => {
  const db = await createInMemoryPostgresTestDb();
  const first = await intakeWorkItemPg(db, {
    sourceProvider: "github",
    sourceScope: "owner/repo",
    sourceRef: "owner/repo#123",
    sourceUrl: "https://github.com/owner/repo/issues/123",
    title: "Fix callback completion",
    body: "The run completes too early.",
    domain: "software",
    priority: "high",
    labels: ["runtime"],
    requestedBy: "operator",
  });
  const second = await intakeWorkItemPg(db, {
    sourceProvider: "github",
    sourceScope: "owner/repo",
    sourceRef: "owner/repo#123",
    sourceUrl: "https://github.com/owner/repo/issues/123",
    title: "Fix callback completion updated",
    body: "Updated body.",
    domain: "software",
    priority: "high",
    labels: ["runtime"],
    requestedBy: "operator",
  });

  assert.equal(first.workItemId, second.workItemId);
  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  const record = await getWorkItemPg(db, first.workItemId);
  assert.equal(record?.title, "Fix callback completion updated");
  assert.equal(record?.metadata.body, "Updated body.");
  assert.equal(record?.metadata.sourceScope, "owner/repo");
});

test("work item run attempt linkage writes richer run refs and runtime context", async () => {
  const db = await createInMemoryPostgresTestDb();
  const intake = await intakeWorkItemPg(db, {
    sourceProvider: "api",
    title: "Build feature",
    body: "Build the runtime feature.",
    domain: "software",
  });
  await createWorkflowRunPg(db, {
    id: "run-linked",
    status: "created",
    domain: "software",
    goalPrompt: "Build feature",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  await linkRunAttemptFromWorkItemPg(db, {
    workItemId: intake.workItemId,
    runId: "run-linked",
    statusAtLink: "created",
    reason: "initial",
  });

  const record = await getWorkItemPg(db, intake.workItemId);
  assert.equal(record?.runRefs.length, 1);
  assert.equal(record?.runRefs[0]?.runAttempt, 1);
  assert.equal(record?.runRefs[0]?.reason, "initial");
  const run = await db.one<{ runtime_context_json: Record<string, unknown> }>("select runtime_context_json from southstar.workflow_runs where id = $1", ["run-linked"]);
  assert.deepEqual(run.runtime_context_json.workItemRef, {
    workItemId: intake.workItemId,
    sourceProvider: "api",
    runAttempt: 1,
    intakeVersion: "southstar.work_item_intake.v1",
  });
});
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./work-item-intake.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/work-items/intake-service.ts`.

- [ ] **Step 3: Extend work item types**

In `/home/timmypai/apps/southstar/src/v2/work-items/types.ts`, make `WorkItemRunRef`:

```ts
export type WorkItemRunRef = {
  runId: string;
  runAttempt: number;
  statusAtLink?: "created" | "scheduling";
  reason?: "initial" | "retry" | "operator_requested" | "recovery_fork";
  createdAt?: string;
};
```

Add intake types:

```ts
export type WorkItemIntakeInput = {
  sourceProvider: WorkItemSourceProvider;
  sourceScope?: string;
  sourceRef?: string;
  sourceUrl?: string;
  title: string;
  body: string;
  domain: string;
  priority?: "low" | "normal" | "high" | "urgent";
  labels?: string[];
  requestedBy?: string;
  metadata?: Record<string, unknown>;
};

export type WorkItemIntakeResult = {
  workItemId: string;
  status: WorkItemRecord["status"];
  deduped: boolean;
};
```

If `WorkItemSourceProvider` does not include these values, set it to:

```ts
export type WorkItemSourceProvider = "api" | "cli" | "github" | "linear" | "ui" | "scheduler";
```

- [ ] **Step 4: Update run ref parsing**

In `/home/timmypai/apps/southstar/src/v2/work-items/postgres-work-items.ts`, replace `parseRunRefs()` with:

```ts
function parseRunRefs(value: WorkItemRunRef[] | string): WorkItemRunRef[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.map((ref) => ({
        runId: String((ref as { runId?: unknown }).runId),
        runAttempt: Number((ref as { runAttempt?: unknown }).runAttempt),
        statusAtLink: statusAtLinkValue((ref as { statusAtLink?: unknown }).statusAtLink),
        reason: reasonValue((ref as { reason?: unknown }).reason),
        createdAt: typeof (ref as { createdAt?: unknown }).createdAt === "string"
          ? String((ref as { createdAt?: unknown }).createdAt)
          : undefined,
      }))
    : [];
}

function statusAtLinkValue(value: unknown): WorkItemRunRef["statusAtLink"] {
  return value === "created" || value === "scheduling" ? value : undefined;
}

function reasonValue(value: unknown): WorkItemRunRef["reason"] {
  return value === "initial" || value === "retry" || value === "operator_requested" || value === "recovery_fork"
    ? value
    : undefined;
}
```

- [ ] **Step 5: Implement intake service**

Create `/home/timmypai/apps/southstar/src/v2/work-items/intake-service.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { createWorkItemPg, getWorkItemPg } from "./postgres-work-items.ts";
import type { WorkItemIntakeInput, WorkItemIntakeResult, WorkItemRunRef } from "./types.ts";

export async function intakeWorkItemPg(db: SouthstarDb, input: WorkItemIntakeInput): Promise<WorkItemIntakeResult> {
  const id = input.sourceRef
    ? `wi_${safeId(input.sourceProvider)}_${safeId(input.sourceRef)}`
    : `wi_${randomUUID()}`;
  const existing = input.sourceRef
    ? await db.maybeOne<{ id: string }>(
        "select id from southstar.work_items where source_provider = $1 and source_ref = $2",
        [input.sourceProvider, input.sourceRef],
      )
    : null;
  const metadata = {
    ...(input.metadata ?? {}),
    body: input.body,
    sourceScope: input.sourceScope,
    sourceUrl: input.sourceUrl,
    priority: input.priority ?? "normal",
    labels: input.labels ?? [],
    requestedBy: input.requestedBy,
  };
  const record = await createWorkItemPg(db, {
    id: existing?.id ?? id,
    sourceProvider: input.sourceProvider,
    sourceRef: input.sourceRef,
    title: input.title,
    domain: input.domain,
    status: input.body.trim().length > 0 ? "ready" : "needs_triage",
    metadata,
  });
  return { workItemId: record.id, status: record.status, deduped: Boolean(existing) };
}

export async function linkRunAttemptFromWorkItemPg(
  db: SouthstarDb,
  input: {
    workItemId: string;
    runId: string;
    statusAtLink: "created" | "scheduling";
    reason: "initial" | "retry" | "operator_requested" | "recovery_fork";
  },
): Promise<WorkItemRunRef> {
  return await db.tx(async (tx) => {
    const workItem = await getWorkItemPg(tx, input.workItemId);
    if (!workItem) throw new Error(`work item not found: ${input.workItemId}`);
    const runAttempt = workItem.runRefs.length === 0 ? 1 : Math.max(...workItem.runRefs.map((ref) => ref.runAttempt)) + 1;
    const createdAt = new Date().toISOString();
    const runRef: WorkItemRunRef = {
      runId: input.runId,
      runAttempt,
      statusAtLink: input.statusAtLink,
      reason: input.reason,
      createdAt,
    };
    await tx.query(
      "update southstar.work_items set run_refs_json = $1::jsonb, updated_at = now() where id = $2",
      [JSON.stringify([...workItem.runRefs, runRef]), input.workItemId],
    );
    const workItemRef = {
      workItemId: workItem.id,
      sourceProvider: workItem.sourceProvider,
      ...(workItem.sourceRef ? { sourceRef: workItem.sourceRef } : {}),
      runAttempt,
      intakeVersion: "southstar.work_item_intake.v1",
    };
    await tx.query(
      `update southstar.workflow_runs
          set runtime_context_json = jsonb_set(runtime_context_json, '{workItemRef}', $1::jsonb, true),
              updated_at = now()
        where id = $2`,
      [JSON.stringify(workItemRef), input.runId],
    );
    return runRef;
  });
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}
```

- [ ] **Step 6: Add intake route**

In `/home/timmypai/apps/southstar/src/v2/server/routes.ts`, add:

```ts
import { intakeWorkItemPg } from "../work-items/intake-service.ts";
```

Before planner routes, add:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/work-items/intake") {
  const body = await readJsonBody<{
    sourceProvider?: "api" | "cli" | "github" | "linear" | "ui" | "scheduler";
    sourceScope?: string;
    sourceRef?: string;
    sourceUrl?: string;
    title?: string;
    body?: string;
    domain?: string;
    priority?: "low" | "normal" | "high" | "urgent";
    labels?: string[];
    requestedBy?: string;
    metadata?: Record<string, unknown>;
  }>(request);
  if (!body.sourceProvider) throw new Error("sourceProvider is required");
  if (!body.title) throw new Error("title is required");
  if (!body.domain) throw new Error("domain is required");
  return json("work-item-intake", await intakeWorkItemPg(context.db, {
    sourceProvider: body.sourceProvider,
    sourceScope: body.sourceScope,
    sourceRef: body.sourceRef,
    sourceUrl: body.sourceUrl,
    title: body.title,
    body: body.body ?? "",
    domain: body.domain,
    priority: body.priority,
    labels: body.labels,
    requestedBy: body.requestedBy,
    metadata: body.metadata,
  }));
}
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/work-items/types.ts src/v2/work-items/intake-service.ts src/v2/work-items/postgres-work-items.ts src/v2/server/routes.ts tests/v2/work-item-intake.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add work item intake service"
```

## Task 4: Tool Proxy Policy Enforcement

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/tool-proxy/types.ts`
- Create: `/home/timmypai/apps/southstar/src/v2/tool-proxy/policy-enforcer.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/tool-proxy/tool-proxy.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/tool-proxy-policy.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing policy tests**

Create `/home/timmypai/apps/southstar/tests/v2/tool-proxy-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPostgresTestDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, listResourcesPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { assertNoRawCredentialPayloadPg, createToolProxyViolationPg, scanForCredentialLeak } from "../../src/v2/tool-proxy/policy-enforcer.ts";

test("tool proxy policy scanner rejects raw credentials and records blocking violation", async () => {
  const db = await createInMemoryPostgresTestDb();
  await createWorkflowRunPg(db, {
    id: "run-tool-policy",
    status: "created",
    domain: "software",
    goalPrompt: "use a tool",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  const finding = scanForCredentialLeak({ env: { GITHUB_TOKEN: "ghp_12345678901234567890" } });
  assert.equal(finding?.reason, "raw_credential_in_envelope");

  await createToolProxyViolationPg(db, {
    runId: "run-tool-policy",
    taskId: "task-a",
    sessionId: "session-a",
    handExecutionId: "hand-exec-a",
    severity: "blocking",
    reason: finding!.reason,
    evidenceRef: "test-envelope",
    redactedExcerpt: finding!.redactedExcerpt,
  });

  const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.status, "blocking");
});

test("assertNoRawCredentialPayloadPg fails closed when callback artifact leaks a token", async () => {
  const db = await createInMemoryPostgresTestDb();
  await createWorkflowRunPg(db, {
    id: "run-callback-leak",
    status: "running",
    domain: "software",
    goalPrompt: "callback",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  const result = await assert.rejects(
    () => assertNoRawCredentialPayloadPg(db, {
      runId: "run-callback-leak",
      taskId: "task-a",
      sessionId: "session-a",
      handExecutionId: "hand-exec-a",
      evidenceRef: "callback",
      value: { output: "token sk-123456789012345678901234" },
    }),
    /raw credential detected/,
  );
  assert.equal(result, undefined);
  const violations = await listResourcesPg(db, { resourceType: "tool_proxy_violation" });
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.payload.reason, "callback_payload_leak");
});
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./tool-proxy-policy.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/tool-proxy/policy-enforcer.ts`.

- [ ] **Step 3: Add policy types**

In `/home/timmypai/apps/southstar/src/v2/tool-proxy/types.ts`, add:

```ts
export type ToolProxyViolationReason =
  | "raw_credential_in_context"
  | "raw_credential_in_envelope"
  | "direct_tool_without_proxy"
  | "callback_payload_leak"
  | "missing_required_lease"
  | "expired_lease";

export type ToolProxyPolicyPayload = {
  schemaVersion: "southstar.tool_proxy_policy.v1";
  runId: string;
  sessionId: string;
  allowedTools: string[];
  requiredProxyTools: string[];
  forbiddenDirectEnvKeys: string[];
  vaultLeaseRefs: string[];
  maxLeaseTtlSeconds: number;
  redactResultPayloads: true;
  failClosed: true;
};

export type ToolProxyViolationPayload = {
  schemaVersion: "southstar.tool_proxy_violation.v1";
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId?: string;
  severity: "blocking" | "warning";
  reason: ToolProxyViolationReason;
  evidenceRef: string;
  redactedExcerpt?: string;
  detectedAt: string;
};
```

- [ ] **Step 4: Implement policy enforcer**

Create `/home/timmypai/apps/southstar/src/v2/tool-proxy/policy-enforcer.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { ToolProxyViolationPayload, ToolProxyViolationReason } from "./types.ts";

export type CredentialLeakFinding = {
  reason: ToolProxyViolationReason;
  redactedExcerpt: string;
};

export type ToolProxyViolationInput = {
  runId: string;
  taskId?: string;
  sessionId?: string;
  handExecutionId?: string;
  severity: "blocking" | "warning";
  reason: ToolProxyViolationReason;
  evidenceRef: string;
  redactedExcerpt?: string;
};

export function scanForCredentialLeak(value: unknown): CredentialLeakFinding | null {
  const text = JSON.stringify(value);
  if (!text) return null;
  if (/"[^"]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)[^"]*"\s*:/i.test(text)) {
    return { reason: "raw_credential_in_envelope", redactedExcerpt: redactText(text) };
  }
  if (/\b(ghp|gho|ghu|ghs|ghr|sk)-?[A-Za-z0-9_]{16,}\b/.test(text)) {
    return { reason: "raw_credential_in_envelope", redactedExcerpt: redactText(text) };
  }
  return null;
}

export async function assertNoRawCredentialPayloadPg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId?: string;
    sessionId?: string;
    handExecutionId?: string;
    evidenceRef: string;
    value: unknown;
  },
): Promise<void> {
  const finding = scanForCredentialLeak(input.value);
  if (!finding) return;
  await createToolProxyViolationPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    handExecutionId: input.handExecutionId,
    severity: "blocking",
    reason: "callback_payload_leak",
    evidenceRef: input.evidenceRef,
    redactedExcerpt: finding.redactedExcerpt,
  });
  throw new Error(`raw credential detected in ${input.evidenceRef}`);
}

export async function createToolProxyViolationPg(db: SouthstarDb, input: ToolProxyViolationInput): Promise<{ id: string }> {
  const id = `tool-proxy-violation:${input.runId}:${input.taskId ?? "run"}:${randomUUID()}`;
  const payload: ToolProxyViolationPayload = {
    schemaVersion: "southstar.tool_proxy_violation.v1",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    handExecutionId: input.handExecutionId,
    severity: input.severity,
    reason: input.reason,
    evidenceRef: input.evidenceRef,
    redactedExcerpt: input.redactedExcerpt,
    detectedAt: new Date().toISOString(),
  };
  await upsertRuntimeResourcePg(db, {
    id,
    resourceType: "tool_proxy_violation",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "security",
    status: input.severity,
    title: `Tool proxy violation ${input.reason}`,
    payload,
    summary: { reason: input.reason, severity: input.severity },
    metrics: {},
  });
  await appendHistoryEventPg(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "tool_proxy.violation",
    actorType: "tool-proxy",
    payload,
  });
  return { id };
}

function redactText(value: string): string {
  return value
    .replace(/\b(ghp|gho|ghu|ghs|ghr|sk)-?[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(/("(?:[^"]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|API[_-]?KEY)[^"]*)"\s*:\s*)"[^"]*"/gi, "$1\"[REDACTED]\"")
    .slice(0, 500);
}
```

- [ ] **Step 5: Integrate callback scanning**

In `/home/timmypai/apps/southstar/src/v2/executor/postgres-tork-callback.ts`, import:

```ts
import { assertNoRawCredentialPayloadPg } from "../tool-proxy/policy-enforcer.ts";
```

Before `acceptOrRejectArtifactRefPg(...)`, add:

```ts
await assertNoRawCredentialPayloadPg(tx, {
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  handExecutionId,
  evidenceRef: `callback:${result.runId}:${result.taskId}:${result.attemptId ?? result.attempts}`,
  value: result.artifact,
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/tool-proxy/types.ts src/v2/tool-proxy/policy-enforcer.ts src/v2/executor/postgres-tork-callback.ts tests/v2/tool-proxy-policy.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: enforce tool proxy policy"
```

## Task 5: Brain Intent and Hand Execution Types

**Files:**
- Create: `/home/timmypai/apps/southstar/src/v2/brain/task-intent.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/hands/types.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/brain-task-intent.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing brain intent tests**

Create `/home/timmypai/apps/southstar/tests/v2/brain-task-intent.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultTaskExecutionIntent } from "../../src/v2/brain/task-intent.ts";

test("default brain intent creates a single-task hand execution contract", () => {
  const intent = createDefaultTaskExecutionIntent({
    runId: "run-intent",
    taskId: "task-a",
    sessionId: "session-a",
    contextPacketId: "context-a",
    attemptId: "attempt-1",
    expectedArtifactContracts: ["task_result"],
    allowedToolNames: ["github"],
    toolProxyPolicyRef: "policy-a",
    handProviderId: "tork",
    instructionsRef: "context-a",
    inputArtifactRefs: ["artifact_ref:upstream"],
  });

  assert.equal(intent.schemaVersion, "southstar.brain.task_execution_intent.v1");
  assert.equal(intent.executionMode, "single_task");
  assert.equal(intent.handProviderId, "tork");
  assert.deepEqual(intent.expectedArtifactContracts, ["task_result"]);
});
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./brain-task-intent.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/brain/task-intent.ts`.

- [ ] **Step 3: Add hand execution types**

In `/home/timmypai/apps/southstar/src/v2/hands/types.ts`, add:

```ts
export type TaskExecutionIntent = {
  schemaVersion: "southstar.brain.task_execution_intent.v1";
  runId: string;
  taskId: string;
  sessionId: string;
  contextPacketId: string;
  attemptId: string;
  expectedArtifactContracts: string[];
  allowedToolNames: string[];
  toolProxyPolicyRef: string;
  handProviderId: "tork" | string;
  executionMode: "single_task";
  instructionsRef: string;
  inputArtifactRefs: string[];
};

export type ExecuteTaskInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  handExecutionId: string;
  brainBindingId: string;
  handBindingId: string;
  intent: TaskExecutionIntent;
  contextPacketRef: string;
  acceptedInputArtifactRefs: string[];
  toolProxyPolicyRef: string;
  workflow: unknown;
  callbackUrl?: string;
  heartbeatUrl?: string;
  envelopeBasePath?: string;
};

export type HandExecutionPayload = {
  schemaVersion: "southstar.runtime.hand_execution.v1";
  handExecutionId: string;
  providerId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  brainBindingId: string;
  handBindingId: string;
  externalJobId?: string;
  status: "queued" | "running" | "completed" | "failed" | "lost" | "superseded" | "cancelled";
  queuedAt: string;
  startedAt?: string;
  terminalAt?: string;
  previousAttemptId?: string;
  supersededBy?: string;
};
```

Extend `HandProvider` with optional `executeTask`:

```ts
executeTask?(binding: HandBinding, input: ExecuteTaskInput): Promise<HandResult>;
```

- [ ] **Step 4: Implement default brain intent**

Create `/home/timmypai/apps/southstar/src/v2/brain/task-intent.ts`:

```ts
import type { TaskExecutionIntent } from "../hands/types.ts";

export type DefaultTaskExecutionIntentInput = Omit<TaskExecutionIntent, "schemaVersion" | "executionMode">;

export function createDefaultTaskExecutionIntent(input: DefaultTaskExecutionIntentInput): TaskExecutionIntent {
  return {
    schemaVersion: "southstar.brain.task_execution_intent.v1",
    executionMode: "single_task",
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    contextPacketId: input.contextPacketId,
    attemptId: input.attemptId,
    expectedArtifactContracts: [...input.expectedArtifactContracts],
    allowedToolNames: [...input.allowedToolNames],
    toolProxyPolicyRef: input.toolProxyPolicyRef,
    handProviderId: input.handProviderId,
    instructionsRef: input.instructionsRef,
    inputArtifactRefs: [...input.inputArtifactRefs],
  };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/brain/task-intent.ts src/v2/hands/types.ts tests/v2/brain-task-intent.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add brain task intent contract"
```

## Task 6: Thin `/execute` Controller

**Files:**
- Create: `/home/timmypai/apps/southstar/src/v2/server/run-execution-controller.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/server/routes.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/run-execution-controller.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing thin execute tests**

Create `/home/timmypai/apps/southstar/tests/v2/run-execution-controller.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPostgresTestDb } from "./postgres-test-utils.ts";
import { startRunSchedulingPg } from "../../src/v2/server/run-execution-controller.ts";
import { createWorkflowRunPg, listHistoryForRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";

test("startRunSchedulingPg moves run to scheduling and does not submit executor jobs", async () => {
  const db = await createInMemoryPostgresTestDb();
  await createWorkflowRunPg(db, {
    id: "run-thin-execute",
    status: "created",
    domain: "software",
    goalPrompt: "ship",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  const result = await startRunSchedulingPg(db, { runId: "run-thin-execute" });

  assert.deepEqual(result, {
    runId: "run-thin-execute",
    status: "scheduling",
    schedulerWakeRequested: true,
  });
  const run = await db.one<{ status: string; executor_job_id: string | null }>("select status, executor_job_id from southstar.workflow_runs where id = $1", ["run-thin-execute"]);
  assert.equal(run.status, "scheduling");
  assert.equal(run.executor_job_id, null);
  const events = await listHistoryForRunPg(db, "run-thin-execute");
  assert.equal(events.some((event) => event.eventType === "run.scheduling_started"), true);
});
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./run-execution-controller.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with an import error for `src/v2/server/run-execution-controller.ts`.

- [ ] **Step 3: Implement thin execute controller**

Create `/home/timmypai/apps/southstar/src/v2/server/run-execution-controller.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { appendHistoryEventPg } from "../stores/postgres-runtime-store.ts";

export type StartRunSchedulingResult = {
  runId: string;
  status: "scheduling";
  schedulerWakeRequested: true;
};

export async function startRunSchedulingPg(db: SouthstarDb, input: { runId: string }): Promise<StartRunSchedulingResult> {
  return await db.tx(async (tx) => {
    const run = await tx.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1 for update", [input.runId]);
    if (!run) throw new Error(`run not found: ${input.runId}`);
    if (!["created", "scheduling"].includes(run.status)) throw new Error(`run cannot start scheduling from status ${run.status}`);
    await tx.query("update southstar.workflow_runs set status = 'scheduling', updated_at = now() where id = $1", [input.runId]);
    await appendHistoryEventPg(tx, {
      runId: input.runId,
      eventType: "run.scheduling_started",
      actorType: "orchestrator",
      idempotencyKey: `run:${input.runId}:scheduling-started`,
      payload: { previousStatus: run.status },
    }).catch(ignoreUniqueViolation);
    return { runId: input.runId, status: "scheduling", schedulerWakeRequested: true };
  });
}

function ignoreUniqueViolation(error: unknown): void {
  if (error instanceof Error && /duplicate key|unique constraint|23505/i.test(error.message)) return;
  throw error;
}
```

- [ ] **Step 4: Wire route to thin execute**

In `/home/timmypai/apps/southstar/src/v2/server/routes.ts`, add:

```ts
import { startRunSchedulingPg } from "./run-execution-controller.ts";
```

Replace the `/api/v2/runs/:runId/execute` route body with:

```ts
const runId = decodeURIComponent(executeMatch[1]!);
return json("run-execute", await startRunSchedulingPg(context.db, { runId }));
```

Remove callback URL validation from this route. The scheduler and `TorkHandProvider.executeTask()` own callback URL validation.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/server/run-execution-controller.ts src/v2/server/routes.ts tests/v2/run-execution-controller.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: make run execute start scheduling only"
```

## Task 7: Per-Task `TorkHandProvider.executeTask`

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/hands/tork-hand-provider.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/executor/provider.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/tork-hand-provider.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing Tork hand provider test**

Create `/home/timmypai/apps/southstar/tests/v2/tork-hand-provider.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTorkHandProvider } from "../../src/v2/hands/tork-hand-provider.ts";
import type { ExecutorProvider, ExecutorSubmitRequest } from "../../src/v2/executor/provider.ts";
import type { ExecuteTaskInput, HandBinding } from "../../src/v2/hands/types.ts";

test("TorkHandProvider.executeTask submits a single-task workflow with hand execution metadata", async () => {
  const submitted: ExecutorSubmitRequest[] = [];
  const executorProvider: ExecutorProvider = {
    executorType: "tork",
    async submit(request) {
      submitted.push(request);
      return { executorType: "tork", externalJobId: "job-1", status: "queued" };
    },
  };
  const provider = createTorkHandProvider({ executorProvider, callbackUrl: "http://127.0.0.1/callback" });
  const binding: HandBinding = {
    id: "hand-binding-1",
    providerId: "tork",
    runId: "run-hand",
    taskId: "task-a",
    handName: "workspace",
    status: "provisioned",
    createdAt: new Date().toISOString(),
    payload: {},
  };
  const input: ExecuteTaskInput = {
    runId: "run-hand",
    taskId: "task-a",
    sessionId: "session-a",
    attemptId: "attempt-1",
    handExecutionId: "hand-exec-1",
    brainBindingId: "brain-binding-1",
    handBindingId: "hand-binding-1",
    contextPacketRef: "context-a",
    acceptedInputArtifactRefs: [],
    toolProxyPolicyRef: "policy-a",
    workflow: {
      id: "wf",
      tasks: [
        { id: "task-a", title: "Task A" },
        { id: "task-b", title: "Task B" },
      ],
      evaluators: [],
    },
    intent: {
      schemaVersion: "southstar.brain.task_execution_intent.v1",
      runId: "run-hand",
      taskId: "task-a",
      sessionId: "session-a",
      contextPacketId: "context-a",
      attemptId: "attempt-1",
      expectedArtifactContracts: ["task_result"],
      allowedToolNames: [],
      toolProxyPolicyRef: "policy-a",
      handProviderId: "tork",
      executionMode: "single_task",
      instructionsRef: "context-a",
      inputArtifactRefs: [],
    },
  };

  const result = await provider.executeTask!(binding, input);

  assert.equal(result.ok, true);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.attemptId, "attempt-1");
  assert.equal(submitted[0]!.workflow.tasks.length, 1);
  assert.equal(submitted[0]!.workflow.tasks[0]!.id, "task-a");
  assert.equal(submitted[0]!.workflow.runtime?.handExecutionId, "hand-exec-1");
});
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./tork-hand-provider.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `executeTask` is not implemented.

- [ ] **Step 3: Allow runtime metadata on executor workflow request**

If TypeScript rejects `workflow.runtime`, update `/home/timmypai/apps/southstar/src/v2/executor/provider.ts`:

```ts
export type ExecutorSubmitRequest = {
  runId: string;
  workflow: SouthstarWorkflowManifest & { runtime?: Record<string, unknown> };
  callbackUrl?: string;
  heartbeatUrl?: string;
  envelopeBasePath?: string;
  attemptId?: string;
};
```

- [ ] **Step 4: Implement `executeTask`**

In `/home/timmypai/apps/southstar/src/v2/hands/tork-hand-provider.ts`, add an `executeTask` method before `snapshot`:

```ts
async executeTask(binding: HandBinding, taskInput): Promise<HandResult> {
  const workflow = taskInput.workflow as SouthstarWorkflowManifest | undefined;
  if (!workflow) {
    binding.status = "failed";
    binding.payload = { ...binding.payload, lastError: "missing workflow input for Tork task execution" };
    return { ok: false, output: "missing workflow input for Tork task execution", metadata: { handExecutionId: taskInput.handExecutionId } };
  }
  const task = Array.isArray(workflow.tasks) ? workflow.tasks.find((candidate) => candidate.id === taskInput.taskId) : undefined;
  if (!task) {
    binding.status = "failed";
    binding.payload = { ...binding.payload, lastError: `task not found in workflow: ${taskInput.taskId}` };
    return { ok: false, output: `task not found in workflow: ${taskInput.taskId}`, metadata: { handExecutionId: taskInput.handExecutionId } };
  }
  const singleTaskWorkflow = {
    ...workflow,
    tasks: [task],
    runtime: {
      runId: taskInput.runId,
      taskId: taskInput.taskId,
      sessionId: taskInput.sessionId,
      attemptId: taskInput.attemptId,
      handExecutionId: taskInput.handExecutionId,
      brainBindingId: taskInput.brainBindingId,
      handBindingId: taskInput.handBindingId,
      contextPacketRef: taskInput.contextPacketRef,
      acceptedInputArtifactRefs: taskInput.acceptedInputArtifactRefs,
      toolProxyPolicyRef: taskInput.toolProxyPolicyRef,
      intent: taskInput.intent,
    },
  };
  const validation = validateWorkflowManifest(singleTaskWorkflow);
  if (!validation.ok) {
    binding.status = "failed";
    binding.payload = { ...binding.payload, lastError: "invalid single-task workflow input", validationIssues: validation.issues };
    return { ok: false, output: `invalid single-task workflow input: ${validation.issues.map((issue) => issue.path).join(", ")}`, metadata: { validationIssues: validation.issues } };
  }
  const submitted = await input.executorProvider.submit({
    runId: binding.runId,
    workflow: singleTaskWorkflow,
    callbackUrl: taskInput.callbackUrl ?? input.callbackUrl,
    heartbeatUrl: taskInput.heartbeatUrl ?? input.heartbeatUrl,
    envelopeBasePath: taskInput.envelopeBasePath ?? "/southstar-runs",
    attemptId: taskInput.attemptId,
  });
  binding.status = "running";
  binding.payload = {
    ...binding.payload,
    handExecutionId: taskInput.handExecutionId,
    executorType: submitted.executorType,
    executorStatus: submitted.status,
    externalJobId: submitted.externalJobId,
    projectionFingerprint: submitted.projectionFingerprint,
    providerPayload: submitted.providerPayload,
  };
  return {
    ok: true,
    output: submitted.externalJobId,
    metadata: {
      handExecutionId: taskInput.handExecutionId,
      executorType: submitted.executorType,
      externalJobId: submitted.externalJobId,
      projectionFingerprint: submitted.projectionFingerprint,
    },
  };
},
```

Keep the existing legacy `execute()` method unchanged.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/hands/tork-hand-provider.ts src/v2/executor/provider.ts tests/v2/tork-hand-provider.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: submit per-task tork hand executions"
```

## Task 8: Native Scheduler Brain-Hand Loop

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/scheduler/runnable-task-scheduler.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/runnable-task-scheduler.test.ts`

- [ ] **Step 1: Add failing scheduler test for claimed and queued states**

In `/home/timmypai/apps/southstar/tests/v2/runnable-task-scheduler.test.ts`, add:

```ts
test("scheduler claims a runnable task, creates brain intent, and queues one hand execution", async () => {
  const db = await createInMemoryPostgresTestDb();
  await seedRunWithTwoIndependentTasks(db, "run-native-loop");
  const calls: string[] = [];
  const scheduler = createRunnableTaskScheduler(db, {
    sessionStore: createPostgresSessionStore(db),
    brainProvider: createFakeBrainProvider({ providerId: "brain-test" }),
    handProvider: {
      ...createFakeHandProvider({ providerId: "tork" }),
      async executeTask(binding, input) {
        calls.push(input.taskId);
        return { ok: true, output: "job-1", metadata: { externalJobId: "job-1", handExecutionId: input.handExecutionId } };
      },
    },
  });

  const result = await scheduler.runOnce({ runId: "run-native-loop" });

  assert.deepEqual(result.dispatchedTaskIds.sort(), ["task-a", "task-b"]);
  assert.deepEqual(calls.sort(), ["task-a", "task-b"]);
  const tasks = await db.query<{ id: string; status: string }>("select id, status from southstar.workflow_tasks where run_id = $1 order by id", ["run-native-loop"]);
  assert.deepEqual(tasks.rows.map((row) => [row.id, row.status]), [["task-a", "queued"], ["task-b", "queued"]]);
  const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
  assert.equal(handExecutions.length, 2);
  assert.equal(handExecutions.every((resource) => resource.status === "queued"), true);
  const intents = await listResourcesPg(db, { resourceType: "task_execution_intent" });
  assert.equal(intents.length, 2);
});
```

Use existing test helpers in that file. If `seedRunWithTwoIndependentTasks` does not exist, add this helper in the test file:

```ts
async function seedRunWithTwoIndependentTasks(db: Awaited<ReturnType<typeof createInMemoryPostgresTestDb>>, runId: string) {
  await createWorkflowRunPg(db, {
    id: runId,
    status: "scheduling",
    domain: "software",
    goalPrompt: "run parallel tasks",
    workflowManifestJson: JSON.stringify({ id: "wf", tasks: [{ id: "task-a" }, { id: "task-b" }], effortPolicy: { maxParallelTasks: 2 } }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  for (const [index, taskId] of ["task-a", "task-b"].entries()) {
    await createWorkflowTaskPg(db, {
      id: taskId,
      runId,
      taskKey: taskId,
      status: "pending",
      sortOrder: index + 1,
      dependsOn: [],
      subagentSessionIds: [],
    });
    await upsertRuntimeResourcePg(db, {
      id: `context-${runId}-${taskId}`,
      resourceType: "context_packet",
      resourceKey: `context-${runId}-${taskId}`,
      runId,
      taskId,
      sessionId: `session-${taskId}`,
      scope: "task",
      status: "ready",
      title: "Context packet",
      payload: { id: `context-${runId}-${taskId}` },
      summary: {},
      metrics: {},
    });
  }
}
```

- [ ] **Step 2: Run the failing scheduler test**

Run:

```bash
npm run test:v2
```

Expected: FAIL because scheduler sets tasks directly to `running` and does not call `executeTask`.

- [ ] **Step 3: Change claim state to `claimed` and count active slots**

In `/home/timmypai/apps/southstar/src/v2/scheduler/runnable-task-scheduler.ts`, replace active count query:

```ts
"select count(*) as running_count from southstar.workflow_tasks where run_id = $1 and status = 'running'",
```

with:

```ts
"select count(*) as running_count from southstar.workflow_tasks where run_id = $1 and status in ('claimed', 'queued', 'running')",
```

Replace the claim update:

```ts
"update southstar.workflow_tasks set status = 'running', root_session_id = $1, updated_at = now() where run_id = $2 and id = $3",
```

with:

```ts
"update southstar.workflow_tasks set status = 'claimed', root_session_id = $1, updated_at = now() where run_id = $2 and id = $3",
```

- [ ] **Step 4: Create intent and persist `task_execution_intent`**

Add imports:

```ts
import { createDefaultTaskExecutionIntent } from "../brain/task-intent.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
```

After `handBindingId` is available in `dispatchTask()`, create:

```ts
const attemptId = `${input.taskId}-attempt-1`;
const handExecutionId = `hand-execution:${input.runId}:${input.taskId}:${attemptId}`;
const intent = createDefaultTaskExecutionIntent({
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  contextPacketId,
  attemptId,
  expectedArtifactContracts: ["task_result"],
  allowedToolNames: [],
  toolProxyPolicyRef: `tool-proxy-policy:${input.runId}:${input.sessionId}`,
  handProviderId: deps.handProvider.providerId,
  instructionsRef: contextPacketId,
  inputArtifactRefs: [],
});
await upsertRuntimeResourcePg(db, {
  id: `task-intent:${input.runId}:${input.taskId}:${attemptId}`,
  resourceType: "task_execution_intent",
  resourceKey: `task-intent:${input.runId}:${input.taskId}:${attemptId}`,
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  scope: "task",
  status: "created",
  title: `Task execution intent ${input.taskId}`,
  payload: intent,
  summary: { handProviderId: intent.handProviderId, expectedArtifactContracts: intent.expectedArtifactContracts },
  metrics: {},
});
await appendHistoryEventOnce(db, {
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  eventType: "brain.intent_created",
  actorType: "brain",
  idempotencyKey: `${recoveryKey}:brain-intent-created`,
  payload: { attemptId, handExecutionId, intentResourceKey: `task-intent:${input.runId}:${input.taskId}:${attemptId}` },
});
```

- [ ] **Step 5: Call `executeTask` and persist `hand_execution` queued**

After intent creation, add:

```ts
if (!deps.handProvider.executeTask) throw new Error(`hand provider ${deps.handProvider.providerId} does not support executeTask`);
const handBinding = await latestHandBinding(db, input.runId, input.taskId);
const handResult = await deps.handProvider.executeTask(handBinding, {
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  attemptId,
  handExecutionId,
  brainBindingId,
  handBindingId,
  intent,
  contextPacketRef: contextPacketId,
  acceptedInputArtifactRefs: [],
  toolProxyPolicyRef: intent.toolProxyPolicyRef,
  workflow: input.manifest,
});
if (!handResult.ok) throw new Error(handResult.output);
await upsertRuntimeResourcePg(db, {
  id: handExecutionId,
  resourceType: "hand_execution",
  resourceKey: handExecutionId,
  runId: input.runId,
  taskId: input.taskId,
  sessionId: input.sessionId,
  scope: "hand",
  status: "queued",
  title: `Hand execution ${input.taskId}`,
  payload: {
    schemaVersion: "southstar.runtime.hand_execution.v1",
    handExecutionId,
    providerId: deps.handProvider.providerId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    attemptId,
    brainBindingId,
    handBindingId,
    externalJobId: typeof handResult.metadata.externalJobId === "string" ? handResult.metadata.externalJobId : handResult.output,
    status: "queued",
    queuedAt: new Date().toISOString(),
  },
  summary: { providerId: deps.handProvider.providerId, attemptId },
  metrics: {},
});
await db.query("update southstar.workflow_tasks set status = 'queued', updated_at = now() where run_id = $1 and id = $2", [input.runId, input.taskId]);
```

Add helper:

```ts
async function latestHandBinding(db: SouthstarDb, runId: string, taskId: string): Promise<HandBinding> {
  const row = await db.one<{ payload_json: Record<string, unknown>; id: string; status: string }>(
    `select id, status, payload_json
       from southstar.runtime_resources
      where resource_type = 'hand_binding'
        and run_id = $1
        and task_id = $2
      order by created_at desc
      limit 1`,
    [runId, taskId],
  );
  return {
    id: row.id,
    providerId: stringValue(row.payload_json.providerId) ?? "tork",
    runId,
    taskId,
    handName: stringValue(row.payload_json.handName) ?? "workspace",
    status: row.status as HandBinding["status"],
    createdAt: new Date().toISOString(),
    payload: row.payload_json,
  };
}
```

Import `HandBinding` from `../hands/types.ts`.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/scheduler/runnable-task-scheduler.ts tests/v2/runnable-task-scheduler.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: run native brain hand scheduler loop"
```

## Task 9: Callback Hand Execution State and Tork Started Observation

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/executor/postgres-tork-callback.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/server/routes.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/tork-callback-managed-state.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/index.test.ts`

- [ ] **Step 1: Write failing callback managed state test**

Create `/home/timmypai/apps/southstar/tests/v2/tork-callback-managed-state.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryPostgresTestDb } from "./postgres-test-utils.ts";
import { createWorkflowRunPg, createWorkflowTaskPg, listResourcesPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { ingestTaskRunResultPg } from "../../src/v2/executor/postgres-tork-callback.ts";

test("callback completes current hand execution and writes accepted artifact_ref", async () => {
  const db = await createInMemoryPostgresTestDb();
  await createWorkflowRunPg(db, {
    id: "run-callback-managed",
    status: "running",
    domain: "software",
    goalPrompt: "callback",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, {
    id: "task-a",
    runId: "run-callback-managed",
    taskKey: "task-a",
    status: "running",
    sortOrder: 1,
    dependsOn: [],
    subagentSessionIds: [],
  });
  await upsertRuntimeResourcePg(db, {
    id: "hand-execution:run-callback-managed:task-a:attempt-1",
    resourceType: "hand_execution",
    resourceKey: "hand-execution:run-callback-managed:task-a:attempt-1",
    runId: "run-callback-managed",
    taskId: "task-a",
    sessionId: "session-a",
    scope: "hand",
    status: "running",
    title: "Hand execution",
    payload: { handExecutionId: "hand-execution:run-callback-managed:task-a:attempt-1", status: "running" },
    summary: {},
    metrics: {},
  });

  await ingestTaskRunResultPg(db, {
    runId: "run-callback-managed",
    taskId: "task-a",
    rootSessionId: "session-a",
    attempts: 1,
    attemptId: "attempt-1",
    ok: true,
    artifact: { summary: "done" },
    metrics: {},
    events: [],
  });

  const handExecutions = await listResourcesPg(db, { resourceType: "hand_execution" });
  assert.equal(handExecutions[0]!.status, "completed");
  const artifactRefs = await listResourcesPg(db, { resourceType: "artifact_ref" });
  assert.equal(artifactRefs.length, 1);
  assert.equal(artifactRefs[0]!.status, "accepted");
});
```

Add to `/home/timmypai/apps/southstar/tests/v2/index.test.ts`:

```ts
await import("./tork-callback-managed-state.test.ts");
```

- [ ] **Step 2: Run the failing callback test**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `hand_execution` stays running.

- [ ] **Step 3: Update callback hand execution state**

In `/home/timmypai/apps/southstar/src/v2/executor/postgres-tork-callback.ts`, after task status update, add:

```ts
await upsertRuntimeResourcePg(tx, {
  id: handExecutionId,
  resourceType: "hand_execution",
  resourceKey: handExecutionId,
  runId: result.runId,
  taskId: result.taskId,
  sessionId: result.rootSessionId,
  scope: "hand",
  status: result.ok ? "completed" : "failed",
  title: `Hand execution ${result.taskId}`,
  payload: {
    schemaVersion: "southstar.runtime.hand_execution.v1",
    handExecutionId,
    providerId: "tork",
    runId: result.runId,
    taskId: result.taskId,
    sessionId: result.rootSessionId,
    attemptId: result.attemptId ?? `attempt-${result.attempts}`,
    status: result.ok ? "completed" : "failed",
    terminalAt: result.receivedAt ?? new Date().toISOString(),
  },
  summary: { accepted: result.ok },
  metrics: result.metrics,
});
```

- [ ] **Step 4: Add heartbeat/start route state transition**

Find the existing heartbeat route in `/home/timmypai/apps/southstar/src/v2/server/routes.ts`. If it only appends executor heartbeat events, extend it to:

```ts
await upsertRuntimeResourcePg(context.db, {
  id: `hand-execution:${body.runId}:${body.taskId}:${body.attemptId}`,
  resourceType: "hand_execution",
  resourceKey: `hand-execution:${body.runId}:${body.taskId}:${body.attemptId}`,
  runId: body.runId,
  taskId: body.taskId,
  sessionId: body.sessionId,
  scope: "hand",
  status: "running",
  title: `Hand execution ${body.taskId}`,
  payload: {
    schemaVersion: "southstar.runtime.hand_execution.v1",
    handExecutionId: `hand-execution:${body.runId}:${body.taskId}:${body.attemptId}`,
    providerId: "tork",
    runId: body.runId,
    taskId: body.taskId,
    sessionId: body.sessionId,
    attemptId: body.attemptId,
    status: "running",
    startedAt: new Date().toISOString(),
  },
  summary: {},
  metrics: {},
});
await context.db.query("update southstar.workflow_tasks set status = 'running', updated_at = now() where run_id = $1 and id = $2 and status in ('queued', 'claimed')", [body.runId, body.taskId]);
await context.db.query("update southstar.workflow_runs set status = 'running', updated_at = now() where id = $1 and status = 'scheduling'", [body.runId]);
```

Match names to the route's existing request body fields. Keep legacy heartbeat response compatible.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/executor/postgres-tork-callback.ts src/v2/server/routes.ts tests/v2/tork-callback-managed-state.test.ts tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: track managed hand execution state"
```

## Task 10: Read Models and Runtime Gates

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/read-models/postgres-run-inspection.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/inspection/postgres-inspect-run.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/inspection/runtime-gates.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/managed-agents-read-model.test.ts`
- Test: `/home/timmypai/apps/southstar/tests/v2/inspection-gates.test.ts`

- [ ] **Step 1: Add failing read model assertions**

In `/home/timmypai/apps/southstar/tests/v2/managed-agents-read-model.test.ts`, add assertions to the existing managed run detail test:

```ts
assert.equal(detail.resources.some((resource) => resource.resourceType === "artifact_ref"), true);
assert.equal(detail.resources.some((resource) => resource.resourceType === "hand_execution"), true);
assert.equal(detail.resources.some((resource) => resource.resourceType === "task_execution_intent"), true);
assert.equal(detail.resources.some((resource) => resource.resourceType === "evaluator_result"), true);
```

In `/home/timmypai/apps/southstar/tests/v2/inspection-gates.test.ts`, add:

```ts
test("runtime gates reject legacy artifact-only completion", () => {
  const verdict = evaluateRuntimeGates({
    counts: {
      tasks: { completed: 1, failed: 0, running: 0 },
      resources: {
        acceptedArtifacts: 0,
        acceptedArtifactRefs: 0,
        needsRepairArtifacts: 0,
        rejectedArtifacts: 0,
        completeEvidencePackets: 0,
        incompleteEvidencePackets: 0,
        blockingValidatorFailures: 0,
        oversizedPayloadRows: 0,
      },
    },
  });
  assert.equal(verdict.acceptedArtifactRefsEqualCompletedTasks.ok, false);
});
```

- [ ] **Step 2: Run failing read model/gate tests**

Run:

```bash
npm run test:v2
```

Expected: FAIL because inspection counts do not expose `acceptedArtifactRefs`.

- [ ] **Step 3: Add artifact ref and hand execution counts**

In `/home/timmypai/apps/southstar/src/v2/inspection/postgres-inspect-run.ts`, add counts for:

```ts
acceptedArtifactRefs: resources.artifactRefs.filter((resource) => resource.status === "accepted").length,
handExecutions: resources.handExecutions.length,
taskExecutionIntents: resources.taskExecutionIntents.length,
blockingToolProxyViolations: resources.toolProxyViolations.filter((resource) => resource.status === "blocking").length,
```

Build `resources.artifactRefs`, `resources.handExecutions`, `resources.taskExecutionIntents`, and `resources.toolProxyViolations` from `runtime_resources` by `resource_type`.

- [ ] **Step 4: Update runtime gates**

In `/home/timmypai/apps/southstar/src/v2/inspection/runtime-gates.ts`, replace legacy artifact completion checks with:

```ts
acceptedArtifactRefsEqualCompletedTasks: {
  ok: counts.resources.acceptedArtifactRefs === counts.tasks.completed,
  actual: { acceptedArtifactRefs: counts.resources.acceptedArtifactRefs, completedTasks: counts.tasks.completed },
  expected: "accepted artifact_ref count equals completed task count",
},
```

Keep a separate legacy artifact count only for compatibility display.

- [ ] **Step 5: Update read model resources**

In `/home/timmypai/apps/southstar/src/v2/read-models/postgres-run-inspection.ts`, include the new resource types in the task/run detail model:

```ts
const managedResourceTypes = new Set([
  "artifact_ref",
  "brain_binding",
  "hand_binding",
  "hand_execution",
  "task_execution_intent",
  "evaluator_result",
  "tool_proxy_policy",
  "tool_proxy_violation",
  "recovery_decision",
]);
```

When mapping task detail, expose resources whose `resourceType` is in this set.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/read-models/postgres-run-inspection.ts src/v2/inspection/postgres-inspect-run.ts src/v2/inspection/runtime-gates.ts tests/v2/managed-agents-read-model.test.ts tests/v2/inspection-gates.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: expose managed runtime contract resources"
```

## Task 11: Postgres Integration Coverage

**Files:**
- Test: `/home/timmypai/apps/southstar/tests/e2e-postgres/cases/13-managed-per-task-tork-runtime.test.ts`
- Modify: `/home/timmypai/apps/southstar/tests/e2e-postgres/index.test.ts`

- [ ] **Step 1: Write failing Postgres integration case**

Create `/home/timmypai/apps/southstar/tests/e2e-postgres/cases/13-managed-per-task-tork-runtime.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresRealHarness } from "../postgres-real-harness.ts";

test("13 managed per-task Tork runtime: execute schedules, scheduler queues hand executions, callback gates completion", async () => {
  const harness = await createPostgresRealHarness();
  await harness.withServer(async ({ db, apiFetch }) => {
    const draft = await apiFetch<{ draftId: string }>("/api/v2/planner/drafts", {
      method: "POST",
      body: { goalPrompt: "Create a tiny CLI and verify it." },
    });
    const run = await apiFetch<{ runId: string }>("/api/v2/runs", {
      method: "POST",
      body: { draftId: draft.draftId },
    });
    const execute = await apiFetch<{ status: string; schedulerWakeRequested: boolean }>(`/api/v2/runs/${encodeURIComponent(run.runId)}/execute`, {
      method: "POST",
      body: {},
    });

    assert.equal(execute.status, "scheduling");
    assert.equal(execute.schedulerWakeRequested, true);
    const runAfterExecute = await db.one<{ status: string; executor_job_id: string | null }>("select status, executor_job_id from southstar.workflow_runs where id = $1", [run.runId]);
    assert.equal(runAfterExecute.status, "scheduling");
    assert.equal(runAfterExecute.executor_job_id, null);

    await harness.tickRuntimeLoops({ runId: run.runId, ticks: 3 });

    const handExecutions = await db.query<{ status: string }>("select status from southstar.runtime_resources where run_id = $1 and resource_type = 'hand_execution'", [run.runId]);
    assert.equal(handExecutions.rows.length > 0, true);
    assert.equal(handExecutions.rows.every((row) => ["queued", "running", "completed", "failed"].includes(row.status)), true);

    await harness.completeQueuedHandExecutions({ runId: run.runId, ok: true });

    const artifactRefs = await db.query<{ status: string }>("select status from southstar.runtime_resources where run_id = $1 and resource_type = 'artifact_ref'", [run.runId]);
    assert.equal(artifactRefs.rows.some((row) => row.status === "accepted"), true);
    const finalRun = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [run.runId]);
    assert.equal(["evaluating", "passed"].includes(finalRun.status), true);
  });
});
```

Add to `/home/timmypai/apps/southstar/tests/e2e-postgres/index.test.ts`:

```ts
await import("./cases/13-managed-per-task-tork-runtime.test.ts");
```

- [ ] **Step 2: Run failing Postgres E2E**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres
```

Expected: FAIL because harness helper methods `tickRuntimeLoops` or `completeQueuedHandExecutions` do not exist.

- [ ] **Step 3: Add harness helpers**

In `/home/timmypai/apps/southstar/tests/e2e-postgres/postgres-real-harness.ts`, add:

```ts
async function tickRuntimeLoops(input: { runId: string; ticks: number }): Promise<void> {
  for (let index = 0; index < input.ticks; index += 1) {
    await runtimeLoops.tickOnce({ runId: input.runId });
  }
}

async function completeQueuedHandExecutions(input: { runId: string; ok: boolean }): Promise<void> {
  const rows = await db.query<{ task_id: string; session_id: string | null; payload_json: Record<string, unknown> }>(
    `select task_id, session_id, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and resource_type = 'hand_execution'
        and status in ('queued', 'running')`,
    [input.runId],
  );
  for (const row of rows.rows) {
    await apiFetch("/api/v2/tork/callback", {
      method: "POST",
      body: {
        runId: input.runId,
        taskId: row.task_id,
        rootSessionId: row.session_id ?? `session-${row.task_id}`,
        attempts: 1,
        attemptId: String(row.payload_json.attemptId ?? "attempt-1"),
        ok: input.ok,
        artifact: { summary: `completed ${row.task_id}`, acceptedArtifacts: [row.task_id], tests: [] },
        metrics: {},
        events: [],
      },
    });
  }
}
```

Expose both helpers from the object returned by `withServer`.

- [ ] **Step 4: Run Postgres E2E**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/e2e-postgres/cases/13-managed-per-task-tork-runtime.test.ts tests/e2e-postgres/index.test.ts tests/e2e-postgres/postgres-real-harness.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover managed per-task tork runtime"
```

## Task 12: Final Verification and Cleanup

**Files:**
- Modify only files required by failing verification output.

- [ ] **Step 1: Run full v2 tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS.

- [ ] **Step 2: Run full Postgres E2E**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:e2e:postgres
```

Expected: PASS.

- [ ] **Step 3: Run web build**

Run:

```bash
npm run web:build
```

Expected: PASS with Next.js build completed.

- [ ] **Step 4: Run static checks for legacy whole-workflow dependency**

Run:

```bash
rg -n "dispatchPostgresRunExecutionPg\\(|executorProvider\\.submit\\(" src/v2
```

Expected: `executorProvider.submit` appears in executor providers, compatibility dispatcher, recovery dispatch, and `TorkHandProvider.executeTask`; it must not appear in `/api/v2/runs/:runId/execute` route or `startRunSchedulingPg`.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
```

Expected: only intentional files are modified.

- [ ] **Step 6: Commit verification cleanup**

If Step 1-4 required cleanup changes, commit them:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add <changed-files>
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: verify managed runtime contracts"
```

If no files changed, do not create an empty commit.

## Self-Review Checklist

- Spec coverage:
  - `artifact_ref` contract: Task 1, Task 2, Task 9, Task 10, Task 11.
  - evaluator/end-state completion: Task 2, Task 10, Task 11.
  - work item intake: Task 3.
  - tool proxy full-path enforcement: Task 4, Task 10, Task 11.
  - native brain-hand loop: Task 5, Task 6, Task 7, Task 8, Task 9.
  - per-task Tork hand provider: Task 7, Task 8, Task 11.
  - read model and gates: Task 10.
  - final verification: Task 12.
- Placeholder scan:
  - Checked for unresolved markers and empty implementation notes; none remain.
- Type consistency:
  - `TaskExecutionIntent`, `ExecuteTaskInput`, `HandExecutionPayload`, `ArtifactRefPayload`, `ToolProxyPolicyPayload`, and `ToolProxyViolationPayload` names match the design document and task snippets.
  - State names use `scheduling`, `claimed`, `queued`, `running`, `evaluating`, `passed`, `failed`, `lost`, and `blocked` consistently.

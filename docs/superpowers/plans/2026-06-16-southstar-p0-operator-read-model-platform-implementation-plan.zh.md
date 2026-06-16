# Southstar P0 Operator Read Model Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P0 Operator Read Model Platform from `docs/superpowers/specs/2026-06-16-southstar-p0-operator-read-model-platform-design.zh.md`: a versioned read-model registry plus a runtime + Design Library run-inspection diagnostic core.

**Architecture:** Add `src/v2/inspection/*` as the side-effect-free diagnostic core, then add `src/v2/read-models/*` as a versioned envelope/registry projection layer. Server API and CLI consume read models through the registry/runtime server; UI-facing code migrates away from substantive logic in `src/v2/ui-api/read-models.ts`.

**Tech Stack:** TypeScript ESM, Node 22 native TS execution via `tsx`, `node:test`, `node:assert/strict`, SQLite via `node:sqlite`, existing Southstar v2 stores/resources/history APIs.

---

## File Structure

### New files

- `src/v2/inspection/types.ts` — public diagnostic model types for run inspection, task summaries, causes, gates, and Design Library lineage.
- `src/v2/inspection/runtime-gates.ts` — deterministic runtime gate evaluation from inspected counts/resources.
- `src/v2/inspection/design-library-lineage.ts` — tolerant Design Library lineage lookup that never breaks runtime inspection.
- `src/v2/inspection/explain-failure.ts` — deterministic priority sorting/selection of primary and contributing causes.
- `src/v2/inspection/inspect-run.ts` — DB aggregation entry point `inspectRun(db, { runId })`.
- `src/v2/read-models/envelope.ts` — shared `ReadModelEnvelope` builder and diagnostics types.
- `src/v2/read-models/types.ts` — read model kind/input/type definitions.
- `src/v2/read-models/registry.ts` — dispatch `buildReadModel(db, input)` by kind.
- `src/v2/read-models/workflow-canvas.ts` — migrated workflow canvas projection.
- `src/v2/read-models/runtime-monitor.ts` — migrated runtime monitor projection.
- `src/v2/read-models/task-detail.ts` — migrated task detail projection.
- `src/v2/read-models/sessions-memory.ts` — migrated sessions/memory projection.
- `src/v2/read-models/vault-mcp.ts` — migrated vault/MCP projection.
- `src/v2/read-models/executor-ops.ts` — migrated executor ops projection.
- `src/v2/read-models/run-inspection.ts` — read-model adapter wrapping `inspectRun` in an envelope.
- `tests/v2/run-inspection.test.ts` — unit tests for diagnostic core and lineage tolerance.
- `tests/v2/read-model-registry.test.ts` — unit tests for envelopes, registry, and migrated read model outputs.

### Modified files

- `src/v2/ui-api/read-models.ts` — reduce to deprecated thin re-export shim or delete after imports are migrated.
- `src/v2/ui-api/local-api.ts` — import read model builders from `src/v2/read-models/*` or consume `envelope.data` where local API still returns legacy composite shapes.
- `src/v2/ui-api/operations-dashboard.ts` — migrate imports to new read-model files or registry data.
- `src/v2/ui-api/page-models/*.ts` — migrate imports away from substantive `ui-api/read-models.ts`.
- `src/v2/server/routes.ts` — add `/api/v2/read-models/:kind/:runId` and `/api/v2/read-models/task-detail/:runId/:taskId` routes through registry.
- `src/v2/server/client.ts` — add `getReadModel({ kind, runId, taskId })`.
- `src/v2/cli.ts` — parse and execute `read-model --kind ... --run-id ... [--task-id ...]` through runtime client.
- `tests/v2/ui-read-models.test.ts` — update imports/expectations for new builders/envelopes.
- `tests/v2/server-api.test.ts` — cover read-model routes.
- `tests/v2/cli-operations.test.ts` — cover CLI read-model command and server-backed execution.
- `tests/v2/index.test.ts` — import the two new test files.

---

## Task 1: Add Run Inspection Types and First Failing Tests

**Files:**
- Create: `src/v2/inspection/types.ts`
- Create: `tests/v2/run-inspection.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Create the initial failing run inspection tests**

Create `tests/v2/run-inspection.test.ts` with this content:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { createLibraryObject, appendVersionCreated, appendLibraryHistory } from "../../src/v2/design-library/store.ts";
import { inspectRun } from "../../src/v2/inspection/inspect-run.ts";

const runId = "run-inspect-1";

test("inspectRun returns healthy for a passed run with complete runtime evidence", () => {
  const db = seededInspectionDb({ runStatus: "passed", taskStatus: "completed" });
  seedAcceptedArtifactEvidenceValidator(db, "task-1");
  seedStopCondition(db, "passed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.runId, runId);
  assert.equal(inspection.status, "passed");
  assert.equal(inspection.health, "healthy");
  assert.equal(inspection.primaryCause, null);
  assert.equal(inspection.gates.completedTasks.verdict, "passed");
  assert.equal(inspection.gates.acceptedArtifactsEqualCompletedTasks.verdict, "passed");
  assert.equal(inspection.gates.completeEvidenceEqualAcceptedArtifacts.verdict, "passed");
  assert.equal(inspection.gates.blockingValidatorFailuresZero.verdict, "passed");
  assert.equal(inspection.gates.stopConditionPassed.verdict, "passed");
  assert.equal(inspection.tasks[0]?.artifact.accepted, 1);
  assert.equal(inspection.tasks[0]?.evidence.complete, 1);
  assert.equal(inspection.tasks[0]?.validators.passed, 1);
});

test("inspectRun reports missing runs as unknown with run_missing primary cause", () => {
  const db = openSouthstarDb(":memory:");

  const inspection = inspectRun(db, { runId: "missing-run" });

  assert.equal(inspection.runId, "missing-run");
  assert.equal(inspection.status, "missing");
  assert.equal(inspection.health, "unknown");
  assert.equal(inspection.primaryCause?.code, "run_missing");
  assert.equal(inspection.primaryCause?.severity, "blocking");
  assert.deepEqual(inspection.tasks, []);
});

test("incomplete evidence outranks blocking validator failure as primary cause", () => {
  const db = seededInspectionDb({ runStatus: "failed", taskStatus: "completed" });
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-run-inspect-1-task-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "needs_repair",
    title: "Implementation artifact",
    payload: { summary: "missing test evidence" },
  });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: "evidence-run-inspect-1-task-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "incomplete",
    title: "Evidence packet",
    payload: { completeness: { missingKinds: ["test-result"] } },
  });
  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: "validator-run-inspect-1-task-1-evidence",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "failed",
    title: "Evidence validator",
    payload: { verdict: "failed", blocking: true, message: "Missing required test-result evidence" },
  });
  seedStopCondition(db, "failed");

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.primaryCause?.code, "incomplete_evidence");
  assert.equal(inspection.primaryCause?.taskId, "task-1");
  assert.equal(
    inspection.contributingCauses.some((cause) => cause.code === "blocking_validator_failed"),
    true,
  );
  assert.equal(inspection.tasks[0]?.evidence.missingKinds.includes("test-result"), true);
});

test("Design Library lineage is tolerant when library tables are absent", () => {
  const db = openSouthstarDb(":memory:");
  db.exec("drop table library_history; drop table library_objects; drop table library_similarity_index;");
  createWorkflowRun(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "inspect run",
    workflowManifestJson: JSON.stringify({ compiledFrom: { objectKey: "template-a", versionId: "ver-a" } }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });

  const inspection = inspectRun(db, { runId });

  assert.deepEqual(inspection.designLibrary, {
    available: false,
    reason: "library_tables_missing",
  });
  assert.equal(inspection.health, "running");
});

test("Design Library lineage is available when compiledFrom and validated_from_run exist", () => {
  const db = seededInspectionDb({
    runStatus: "passed",
    taskStatus: "completed",
    workflowManifest: { compiledFrom: { objectKey: "software-dev.template.issue", versionId: "ver-template-1", source: "design-library" } },
  });
  seedAcceptedArtifactEvidenceValidator(db, "task-1");
  seedStopCondition(db, "passed");
  const object = createLibraryObject(db, {
    objectKey: "software-dev.template.issue",
    objectKind: "workflow_template",
    status: "approved",
    state: {},
    actorType: "user",
  });
  appendVersionCreated(db, {
    objectId: object.objectId,
    definitionKind: "workflow_template",
    versionId: "ver-template-1",
    payload: { schemaVersion: "southstar.library.workflow_template.v1" },
    createdBy: "user",
    status: "approved",
  });
  appendLibraryHistory(db, {
    objectId: object.objectId,
    eventType: "template.validated_from_run",
    actorType: "runtime",
    payload: { runId, fromVersionId: "ver-template-1", templateVersionId: "ver-template-validated" },
  });

  const inspection = inspectRun(db, { runId });

  assert.equal(inspection.designLibrary.available, true);
  if (inspection.designLibrary.available) {
    assert.equal(inspection.designLibrary.compiledFrom.versionId, "ver-template-1");
    assert.equal(inspection.designLibrary.validatedFromRun?.validatedTemplateVersionId, "ver-template-validated");
  }
});

function seededInspectionDb(input: { runStatus: string; taskStatus: string; workflowManifest?: unknown }): SouthstarDb {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: runId,
    status: input.runStatus,
    domain: "software",
    goalPrompt: "inspect run",
    workflowManifestJson: JSON.stringify(input.workflowManifest ?? { schemaVersion: "southstar.v2" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-1",
    runId,
    taskKey: "task-implement",
    status: input.taskStatus,
    sortOrder: 0,
    dependsOn: [],
  });
  return db;
}

function seedAcceptedArtifactEvidenceValidator(db: SouthstarDb, taskId: string): void {
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: `executor-${runId}-${taskId}-attempt-1`,
    runId,
    taskId,
    scope: "executor",
    status: "submitted",
    title: "Executor binding",
    payload: { executorType: "tork", torkJobId: "job-1", southstarExecutorStatus: "submitted", runnerPhase: "shutdown" },
  });
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: `artifact-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "task",
    status: "accepted",
    title: "Accepted artifact",
    payload: { summary: "done" },
  });
  upsertRuntimeResource(db, {
    resourceType: "evidence_packet",
    resourceKey: `evidence-${runId}-${taskId}`,
    runId,
    taskId,
    scope: "task",
    status: "complete",
    title: "Complete evidence",
    payload: { completeness: { missingKinds: [] } },
  });
  upsertRuntimeResource(db, {
    resourceType: "validator_result",
    resourceKey: `validator-${runId}-${taskId}-schema`,
    runId,
    taskId,
    scope: "task",
    status: "passed",
    title: "Schema validator",
    payload: { verdict: "passed", blocking: true },
  });
}

function seedStopCondition(db: SouthstarDb, status: "passed" | "failed"): void {
  upsertRuntimeResource(db, {
    resourceType: "stop_condition_result",
    resourceKey: `stop-${runId}`,
    runId,
    scope: "run",
    status,
    title: "Stop condition",
    payload: { status },
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "stop_condition.evaluated",
    actorType: "evaluator",
    payload: { status },
  });
}
```

- [ ] **Step 2: Add the test import to `tests/v2/index.test.ts`**

Add this import near the other v2 imports:

```ts
await import("./run-inspection.test.ts");
```

- [ ] **Step 3: Run the new test and verify it fails because the implementation does not exist**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/run-inspection.test.ts
```

Expected: FAIL with an import error for `src/v2/inspection/inspect-run.ts` or missing exported `inspectRun`.

- [ ] **Step 4: Create `src/v2/inspection/types.ts`**

Create `src/v2/inspection/types.ts` with this content:

```ts
export type InspectionHealth = "healthy" | "running" | "blocked" | "failed" | "unknown";

export type InspectionCauseCode =
  | "run_missing"
  | "task_failed"
  | "executor_issue"
  | "artifact_needs_repair"
  | "artifact_rejected"
  | "incomplete_evidence"
  | "blocking_validator_failed"
  | "stop_condition_failed"
  | "stop_condition_missing"
  | "design_library_lineage_unavailable"
  | "task_stale_or_pending";

export type InspectionCause = {
  code: InspectionCauseCode;
  severity: "blocking" | "warning" | "info";
  taskId?: string;
  resourceRef?: string;
  message: string;
};

export type GateVerdict = {
  verdict: "passed" | "failed" | "not_applicable";
  actual: unknown;
  expected: string;
};

export type RuntimeGateVerdicts = {
  completedTasks: GateVerdict;
  acceptedArtifactsEqualCompletedTasks: GateVerdict;
  completeEvidenceEqualAcceptedArtifacts: GateVerdict;
  blockingValidatorFailuresZero: GateVerdict;
  stopConditionPassed: GateVerdict;
  payloadSizeWithinLimit: GateVerdict;
};

export type RunInspectionCounts = {
  tasks: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
  };
  resources: {
    acceptedArtifacts: number;
    needsRepairArtifacts: number;
    rejectedArtifacts: number;
    completeEvidencePackets: number;
    incompleteEvidencePackets: number;
    blockingValidatorFailures: number;
    oversizedPayloadRows: number;
  };
};

export type InspectedTask = {
  taskId: string;
  taskKey: string;
  status: string;
  sortOrder: number;
  dependsOn: string[];
  executor: {
    bindingId?: string;
    status?: string;
    executorType?: string;
    externalJobId?: string;
    runnerPhase?: string;
    lastHeartbeatAt?: string;
    issue: "missing_binding" | "timeout" | "orphaned" | "callback_missing" | "none";
  };
  artifact: {
    accepted: number;
    needsRepair: number;
    rejected: number;
    latestStatus?: string;
    resourceRefs: string[];
  };
  evidence: {
    complete: number;
    incomplete: number;
    latestStatus?: string;
    resourceRefs: string[];
    missingKinds: string[];
  };
  validators: {
    passed: number;
    failedBlocking: number;
    failedNonBlocking: number;
    latestFailedBlockingRef?: string;
  };
  causes: InspectionCause[];
};

export type DesignLibraryLineage =
  | {
      available: true;
      compiledFrom: {
        objectKey?: string;
        versionId?: string;
        source?: string;
      };
      sourceObject?: {
        objectId: string;
        objectKey: string;
        objectKind: string;
        status: string;
        headVersionId?: string;
      };
      sourceVersion?: {
        versionId: string;
        definitionKind: string;
        contentHash: string;
      };
      validatedFromRun?: {
        eventRef: string;
        validatedTemplateVersionId: string;
        createdAt: string;
      };
    }
  | {
      available: false;
      reason: "library_tables_missing" | "not_compiled_from_library" | "lineage_not_found";
    };

export type RunInspection = {
  runId: string;
  status: string;
  health: InspectionHealth;
  generatedFrom: {
    workflowManifestPresent: boolean;
    compiledFrom?: {
      objectKey?: string;
      versionId?: string;
      source?: string;
    };
  };
  counts: RunInspectionCounts;
  gates: RuntimeGateVerdicts;
  primaryCause: InspectionCause | null;
  contributingCauses: InspectionCause[];
  designLibrary: DesignLibraryLineage;
  tasks: InspectedTask[];
};
```

- [ ] **Step 5: Commit the failing tests and types**

Run:

```bash
git add src/v2/inspection/types.ts tests/v2/run-inspection.test.ts tests/v2/index.test.ts
git commit -m "test: specify run inspection diagnostics"
```

---

## Task 2: Implement Runtime Gates and Design Library Lineage

**Files:**
- Create: `src/v2/inspection/runtime-gates.ts`
- Create: `src/v2/inspection/design-library-lineage.ts`
- Test: `tests/v2/run-inspection.test.ts`

- [ ] **Step 1: Create runtime gate evaluator**

Create `src/v2/inspection/runtime-gates.ts` with this content:

```ts
import type { RuntimeGateVerdicts, RunInspectionCounts } from "./types.ts";

export function evaluateRuntimeInspectionGates(input: {
  runStatus: string;
  counts: RunInspectionCounts;
  stopConditionStatus?: string;
}): RuntimeGateVerdicts {
  const completed = input.counts.tasks.completed;
  const accepted = input.counts.resources.acceptedArtifacts;
  const completeEvidence = input.counts.resources.completeEvidencePackets;
  const blockingFailures = input.counts.resources.blockingValidatorFailures;
  const oversized = input.counts.resources.oversizedPayloadRows;
  return {
    completedTasks: {
      verdict: completed > 0 ? "passed" : "failed",
      actual: completed,
      expected: ">= 1 completed task",
    },
    acceptedArtifactsEqualCompletedTasks: {
      verdict: accepted === completed ? "passed" : "failed",
      actual: { acceptedArtifacts: accepted, completedTasks: completed },
      expected: "accepted artifacts == completed tasks",
    },
    completeEvidenceEqualAcceptedArtifacts: {
      verdict: completeEvidence === accepted ? "passed" : "failed",
      actual: { completeEvidencePackets: completeEvidence, acceptedArtifacts: accepted },
      expected: "complete evidence packets == accepted artifacts",
    },
    blockingValidatorFailuresZero: {
      verdict: blockingFailures === 0 ? "passed" : "failed",
      actual: blockingFailures,
      expected: "blocking validator failures == 0",
    },
    stopConditionPassed: {
      verdict: input.stopConditionStatus === "passed" ? "passed" : "failed",
      actual: input.stopConditionStatus ?? "missing",
      expected: "latest stop condition status == passed",
    },
    payloadSizeWithinLimit: {
      verdict: oversized === 0 ? "passed" : "failed",
      actual: oversized,
      expected: "artifact/evidence/validator payload_json rows over 50000 bytes == 0",
    },
  };
}

export function allRuntimeGatesPassed(gates: RuntimeGateVerdicts): boolean {
  return Object.values(gates).every((gate) => gate.verdict === "passed");
}
```

- [ ] **Step 2: Create tolerant Design Library lineage reader**

Create `src/v2/inspection/design-library-lineage.ts` with this content:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { DesignLibraryLineage } from "./types.ts";

type CompiledFrom = {
  objectKey?: string;
  versionId?: string;
  source?: string;
};

export function readDesignLibraryLineage(db: SouthstarDb, input: {
  runId: string;
  workflowManifest: unknown;
}): DesignLibraryLineage {
  if (!hasTable(db, "library_objects") || !hasTable(db, "library_history")) {
    return { available: false, reason: "library_tables_missing" };
  }
  const compiledFrom = compiledFromManifest(input.workflowManifest);
  if (!compiledFrom) {
    return { available: false, reason: "not_compiled_from_library" };
  }
  const sourceObject = compiledFrom.objectKey
    ? db.prepare("select id, object_key, object_kind, status, head_version_id from library_objects where object_key = ?")
      .get(compiledFrom.objectKey) as LibraryObjectRow | undefined
    : undefined;
  const sourceVersion = compiledFrom.versionId
    ? db.prepare(`
        select payload_json
        from library_history
        where event_type = 'version.created'
          and json_extract(payload_json, '$.versionId') = ?
        order by created_at desc
        limit 1
      `).get(compiledFrom.versionId) as { payload_json: string } | undefined
    : undefined;
  if (!sourceObject && !sourceVersion) {
    return { available: false, reason: "lineage_not_found" };
  }
  const validated = db.prepare(`
    select id, payload_json, created_at
    from library_history
    where event_type = 'template.validated_from_run'
      and json_extract(payload_json, '$.runId') = ?
    order by created_at desc
    limit 1
  `).get(input.runId) as { id: string; payload_json: string; created_at: string } | undefined;
  const versionPayload = sourceVersion ? parseJson(sourceVersion.payload_json) as {
    versionId?: string;
    definitionKind?: string;
    contentHash?: string;
  } : undefined;
  const validatedPayload = validated ? parseJson(validated.payload_json) as { templateVersionId?: string } : undefined;
  return {
    available: true,
    compiledFrom,
    sourceObject: sourceObject ? {
      objectId: sourceObject.id,
      objectKey: sourceObject.object_key,
      objectKind: sourceObject.object_kind,
      status: sourceObject.status,
      headVersionId: sourceObject.head_version_id ?? undefined,
    } : undefined,
    sourceVersion: versionPayload ? {
      versionId: String(versionPayload.versionId ?? compiledFrom.versionId ?? "unknown"),
      definitionKind: String(versionPayload.definitionKind ?? "unknown"),
      contentHash: String(versionPayload.contentHash ?? "unknown"),
    } : undefined,
    validatedFromRun: validated ? {
      eventRef: validated.id,
      validatedTemplateVersionId: String(validatedPayload?.templateVersionId ?? "unknown"),
      createdAt: validated.created_at,
    } : undefined,
  };
}

function hasTable(db: SouthstarDb, name: string): boolean {
  const row = db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) as { 1: number } | undefined;
  return Boolean(row);
}

function compiledFromManifest(value: unknown): CompiledFrom | undefined {
  const manifest = asRecord(value);
  const direct = asRecord(manifest?.compiledFrom);
  const metadata = asRecord(manifest?.metadata);
  const nested = asRecord(metadata?.compiledFrom);
  const compiledFrom = direct ?? nested;
  if (!compiledFrom) return undefined;
  const objectKey = stringOrUndefined(compiledFrom.objectKey) ?? stringOrUndefined(compiledFrom.templateObjectKey);
  const versionId = stringOrUndefined(compiledFrom.versionId) ?? stringOrUndefined(compiledFrom.templateVersionId);
  const source = stringOrUndefined(compiledFrom.source);
  if (!objectKey && !versionId && !source) return undefined;
  return { objectKey, versionId, source };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type LibraryObjectRow = {
  id: string;
  object_key: string;
  object_kind: string;
  status: string;
  head_version_id: string | null;
};
```

- [ ] **Step 3: Run the run-inspection test and confirm it still fails because `inspect-run.ts` is missing**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/run-inspection.test.ts
```

Expected: FAIL with import error for `src/v2/inspection/inspect-run.ts`.

- [ ] **Step 4: Commit gates and lineage utilities**

Run:

```bash
git add src/v2/inspection/runtime-gates.ts src/v2/inspection/design-library-lineage.ts
git commit -m "feat: add inspection gates and library lineage reader"
```

---

## Task 3: Implement Run Inspection Aggregator and Failure Explanation

**Files:**
- Create: `src/v2/inspection/explain-failure.ts`
- Create: `src/v2/inspection/inspect-run.ts`
- Test: `tests/v2/run-inspection.test.ts`

- [ ] **Step 1: Create deterministic failure explanation**

Create `src/v2/inspection/explain-failure.ts` with this content:

```ts
import type { InspectionCause } from "./types.ts";

const priority: Record<InspectionCause["code"], number> = {
  run_missing: 10,
  task_failed: 20,
  executor_issue: 30,
  artifact_rejected: 40,
  artifact_needs_repair: 41,
  incomplete_evidence: 50,
  blocking_validator_failed: 60,
  stop_condition_failed: 70,
  stop_condition_missing: 71,
  design_library_lineage_unavailable: 80,
  task_stale_or_pending: 90,
};

export function explainRunFailure(causes: InspectionCause[]): {
  primaryCause: InspectionCause | null;
  contributingCauses: InspectionCause[];
} {
  const sorted = [...causes].sort((a, b) => {
    const byPriority = priority[a.code] - priority[b.code];
    if (byPriority !== 0) return byPriority;
    return (a.taskId ?? "").localeCompare(b.taskId ?? "") || (a.resourceRef ?? "").localeCompare(b.resourceRef ?? "");
  });
  const primaryCause = sorted.find((cause) => cause.severity === "blocking") ?? null;
  return {
    primaryCause,
    contributingCauses: primaryCause ? sorted.filter((cause) => cause !== primaryCause) : sorted,
  };
}
```

- [ ] **Step 2: Create `inspectRun` aggregator**

Create `src/v2/inspection/inspect-run.ts` with this content:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { RuntimeResourceRecord } from "../stores/resource-store.ts";
import { listResources } from "../stores/resource-store.ts";
import { readDesignLibraryLineage } from "./design-library-lineage.ts";
import { explainRunFailure } from "./explain-failure.ts";
import { allRuntimeGatesPassed, evaluateRuntimeInspectionGates } from "./runtime-gates.ts";
import type { DesignLibraryLineage, InspectionCause, InspectionHealth, InspectedTask, RunInspection, RunInspectionCounts } from "./types.ts";

export function inspectRun(db: SouthstarDb, input: { runId: string }): RunInspection {
  const run = db.prepare("select * from workflow_runs where id = ?").get(input.runId) as WorkflowRunRow | undefined;
  if (!run) {
    const counts = emptyCounts();
    const gates = evaluateRuntimeInspectionGates({ runStatus: "missing", counts });
    const cause: InspectionCause = {
      code: "run_missing",
      severity: "blocking",
      message: `Run not found: ${input.runId}`,
    };
    return {
      runId: input.runId,
      status: "missing",
      health: "unknown",
      generatedFrom: { workflowManifestPresent: false },
      counts,
      gates,
      primaryCause: cause,
      contributingCauses: [],
      designLibrary: { available: false, reason: libraryTablesMissing(db) ? "library_tables_missing" : "not_compiled_from_library" },
      tasks: [],
    };
  }

  const workflowManifest = parseJson(run.workflow_manifest_json);
  const tasks = listTaskRows(db, input.runId);
  const resources = resourcesForRun(db, input.runId);
  const inspectedTasks = tasks.map((task) => inspectTask(task, resources));
  const counts = countInspection(tasks, resources);
  const stopConditionStatus = latestStopConditionStatus(resources.stopConditions);
  const gates = evaluateRuntimeInspectionGates({ runStatus: run.status, counts, stopConditionStatus });
  const designLibrary = readDesignLibraryLineage(db, { runId: input.runId, workflowManifest });
  const causes = [
    ...inspectedTasks.flatMap((task) => task.causes),
    ...gateCauses(gates),
    ...designLibraryCauses(designLibrary),
  ];
  const explanation = explainRunFailure(causes);
  return {
    runId: input.runId,
    status: run.status,
    health: healthForRun(run.status, explanation.primaryCause, gates),
    generatedFrom: {
      workflowManifestPresent: run.workflow_manifest_json.length > 0,
      compiledFrom: compiledFrom(workflowManifest),
    },
    counts,
    gates,
    primaryCause: explanation.primaryCause,
    contributingCauses: explanation.contributingCauses,
    designLibrary,
    tasks: inspectedTasks,
  };
}

function inspectTask(task: WorkflowTaskRow, resources: RunResources): InspectedTask {
  const artifacts = resources.artifacts.filter((resource) => resource.taskId === task.id);
  const evidencePackets = resources.evidencePackets.filter((resource) => resource.taskId === task.id);
  const validators = resources.validators.filter((resource) => resource.taskId === task.id);
  const binding = resources.executorBindings.filter((resource) => resource.taskId === task.id).at(-1);
  const causes: InspectionCause[] = [];
  if (task.status === "failed") {
    causes.push({ code: "task_failed", severity: "blocking", taskId: task.id, message: `Task failed: ${task.id}` });
  }
  if (!binding && ["running", "pending"].includes(task.status)) {
    causes.push({ code: "executor_issue", severity: "blocking", taskId: task.id, message: `Task has no executor binding: ${task.id}` });
  }
  for (const artifact of artifacts) {
    if (artifact.status === "rejected") {
      causes.push({ code: "artifact_rejected", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact rejected for task ${task.id}` });
    }
    if (artifact.status === "needs_repair") {
      causes.push({ code: "artifact_needs_repair", severity: "blocking", taskId: task.id, resourceRef: artifact.id, message: `Artifact needs repair for task ${task.id}` });
    }
  }
  for (const evidence of evidencePackets) {
    if (evidence.status === "incomplete") {
      causes.push({ code: "incomplete_evidence", severity: "blocking", taskId: task.id, resourceRef: evidence.id, message: `Evidence packet incomplete for task ${task.id}` });
    }
  }
  for (const validator of validators) {
    const payload = asRecord(validator.payload);
    if (validator.status === "failed" && payload?.blocking === true) {
      causes.push({ code: "blocking_validator_failed", severity: "blocking", taskId: task.id, resourceRef: validator.id, message: `Blocking validator failed for task ${task.id}` });
    }
  }
  const bindingPayload = asRecord(binding?.payload);
  const executorIssue = executorIssueFor(binding);
  if (executorIssue !== "none") {
    causes.push({ code: "executor_issue", severity: "blocking", taskId: task.id, resourceRef: binding?.id, message: `Executor issue ${executorIssue} for task ${task.id}` });
  }
  return {
    taskId: task.id,
    taskKey: task.task_key,
    status: task.status,
    sortOrder: task.sort_order,
    dependsOn: parseStringArray(task.depends_on_json),
    executor: {
      bindingId: binding?.id,
      status: binding?.status,
      executorType: stringField(bindingPayload, "executorType"),
      externalJobId: stringField(bindingPayload, "externalJobId") ?? stringField(bindingPayload, "torkJobId"),
      runnerPhase: stringField(bindingPayload, "runnerPhase"),
      lastHeartbeatAt: stringField(bindingPayload, "lastHeartbeatAt"),
      issue: executorIssue,
    },
    artifact: {
      accepted: artifacts.filter((resource) => resource.status === "accepted").length,
      needsRepair: artifacts.filter((resource) => resource.status === "needs_repair").length,
      rejected: artifacts.filter((resource) => resource.status === "rejected").length,
      latestStatus: artifacts.at(-1)?.status,
      resourceRefs: artifacts.map((resource) => resource.id),
    },
    evidence: {
      complete: evidencePackets.filter((resource) => resource.status === "complete").length,
      incomplete: evidencePackets.filter((resource) => resource.status === "incomplete").length,
      latestStatus: evidencePackets.at(-1)?.status,
      resourceRefs: evidencePackets.map((resource) => resource.id),
      missingKinds: unique(evidencePackets.flatMap((resource) => missingKinds(resource.payload))),
    },
    validators: {
      passed: validators.filter((resource) => resource.status === "passed").length,
      failedBlocking: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking === true).length,
      failedNonBlocking: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking !== true).length,
      latestFailedBlockingRef: validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking === true).at(-1)?.id,
    },
    causes,
  };
}

function resourcesForRun(db: SouthstarDb, runId: string): RunResources {
  return {
    executorBindings: listResources(db, { resourceType: "executor_binding" }).filter((resource) => resource.runId === runId),
    artifacts: listResources(db, { resourceType: "artifact" }).filter((resource) => resource.runId === runId),
    evidencePackets: listResources(db, { resourceType: "evidence_packet" }).filter((resource) => resource.runId === runId),
    validators: listResources(db, { resourceType: "validator_result" }).filter((resource) => resource.runId === runId),
    stopConditions: listResources(db, { resourceType: "stop_condition_result" }).filter((resource) => resource.runId === runId),
  };
}

function countInspection(tasks: WorkflowTaskRow[], resources: RunResources): RunInspectionCounts {
  const oversizedPayloadRows = [...resources.artifacts, ...resources.evidencePackets, ...resources.validators]
    .filter((resource) => JSON.stringify(resource.payload).length > 50_000).length;
  return {
    tasks: {
      total: tasks.length,
      completed: tasks.filter((task) => task.status === "completed").length,
      failed: tasks.filter((task) => task.status === "failed").length,
      running: tasks.filter((task) => task.status === "running").length,
      pending: tasks.filter((task) => task.status === "pending").length,
    },
    resources: {
      acceptedArtifacts: resources.artifacts.filter((resource) => resource.status === "accepted").length,
      needsRepairArtifacts: resources.artifacts.filter((resource) => resource.status === "needs_repair").length,
      rejectedArtifacts: resources.artifacts.filter((resource) => resource.status === "rejected").length,
      completeEvidencePackets: resources.evidencePackets.filter((resource) => resource.status === "complete").length,
      incompleteEvidencePackets: resources.evidencePackets.filter((resource) => resource.status === "incomplete").length,
      blockingValidatorFailures: resources.validators.filter((resource) => resource.status === "failed" && asRecord(resource.payload)?.blocking === true).length,
      oversizedPayloadRows,
    },
  };
}

function gateCauses(gates: ReturnType<typeof evaluateRuntimeInspectionGates>): InspectionCause[] {
  const causes: InspectionCause[] = [];
  if (gates.stopConditionPassed.verdict === "failed") {
    causes.push({
      code: gates.stopConditionPassed.actual === "missing" ? "stop_condition_missing" : "stop_condition_failed",
      severity: "blocking",
      message: `Stop condition gate failed: ${String(gates.stopConditionPassed.actual)}`,
    });
  }
  if (gates.payloadSizeWithinLimit.verdict === "failed") {
    causes.push({ code: "artifact_rejected", severity: "warning", message: "Runtime resource payload size gate failed" });
  }
  return causes;
}

function designLibraryCauses(lineage: DesignLibraryLineage): InspectionCause[] {
  if (lineage.available) return [];
  return [{
    code: "design_library_lineage_unavailable",
    severity: "warning",
    message: `Design Library lineage unavailable: ${lineage.reason}`,
  }];
}

function healthForRun(status: string, primaryCause: InspectionCause | null, gates: ReturnType<typeof evaluateRuntimeInspectionGates>): InspectionHealth {
  if (status === "missing") return "unknown";
  if (["failed", "cancelled"].includes(status)) return "failed";
  if (["passed", "completed"].includes(status) && !primaryCause && allRuntimeGatesPassed(gates)) return "healthy";
  if (primaryCause?.severity === "blocking") return ["passed", "completed"].includes(status) ? "failed" : "blocked";
  if (["running", "pending", "created"].includes(status)) return "running";
  return "unknown";
}

function latestStopConditionStatus(resources: RuntimeResourceRecord[]): string | undefined {
  return resources.at(-1)?.status;
}

function executorIssueFor(binding: RuntimeResourceRecord | undefined): InspectedTask["executor"]["issue"] {
  if (!binding) return "none";
  const payload = asRecord(binding.payload);
  const status = stringField(payload, "southstarExecutorStatus") ?? binding.status;
  if (status === "timeout") return "timeout";
  if (status === "orphaned") return "orphaned";
  if (status === "callback_missing") return "callback_missing";
  return "none";
}

function compiledFrom(workflowManifest: unknown): RunInspection["generatedFrom"]["compiledFrom"] {
  const manifest = asRecord(workflowManifest);
  const direct = asRecord(manifest?.compiledFrom);
  const metadata = asRecord(manifest?.metadata);
  const nested = asRecord(metadata?.compiledFrom);
  const source = direct ?? nested;
  if (!source) return undefined;
  return {
    objectKey: stringField(source, "objectKey") ?? stringField(source, "templateObjectKey"),
    versionId: stringField(source, "versionId") ?? stringField(source, "templateVersionId"),
    source: stringField(source, "source"),
  };
}

function libraryTablesMissing(db: SouthstarDb): boolean {
  const row = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'library_history'").get() as { 1: number } | undefined;
  return !row;
}

function listTaskRows(db: SouthstarDb, runId: string): WorkflowTaskRow[] {
  return db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId) as WorkflowTaskRow[];
}

function emptyCounts(): RunInspectionCounts {
  return {
    tasks: { total: 0, completed: 0, failed: 0, running: 0, pending: 0 },
    resources: {
      acceptedArtifacts: 0,
      needsRepairArtifacts: 0,
      rejectedArtifacts: 0,
      completeEvidencePackets: 0,
      incompleteEvidencePackets: 0,
      blockingValidatorFailures: 0,
      oversizedPayloadRows: 0,
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function parseStringArray(text: string): string[] {
  const value = parseJson(text);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function missingKinds(payload: unknown): string[] {
  const record = asRecord(payload);
  const completeness = asRecord(record?.completeness);
  const missing = completeness?.missingKinds;
  return Array.isArray(missing) ? missing.filter((item): item is string => typeof item === "string") : [];
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type RunResources = {
  executorBindings: RuntimeResourceRecord[];
  artifacts: RuntimeResourceRecord[];
  evidencePackets: RuntimeResourceRecord[];
  validators: RuntimeResourceRecord[];
  stopConditions: RuntimeResourceRecord[];
};

type WorkflowRunRow = {
  id: string;
  status: string;
  workflow_manifest_json: string;
};

type WorkflowTaskRow = {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  sort_order: number;
  depends_on_json: string;
};
```

- [ ] **Step 3: Run the run-inspection tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/run-inspection.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run all v2 tests to catch type/import issues**

Run:

```bash
npm run test:v2
```

Expected: PASS or failures only in tests that will be intentionally migrated by later tasks. If unrelated tests fail, inspect and fix before committing.

- [ ] **Step 5: Commit run inspection implementation**

Run:

```bash
git add src/v2/inspection tests/v2/run-inspection.test.ts tests/v2/index.test.ts
git commit -m "feat: add run inspection diagnostics"
```

---

## Task 4: Add Read Model Envelope, Migrated Builders, and Registry Tests

**Files:**
- Create: `src/v2/read-models/envelope.ts`
- Create: `src/v2/read-models/types.ts`
- Create: `src/v2/read-models/workflow-canvas.ts`
- Create: `src/v2/read-models/runtime-monitor.ts`
- Create: `src/v2/read-models/task-detail.ts`
- Create: `src/v2/read-models/sessions-memory.ts`
- Create: `src/v2/read-models/vault-mcp.ts`
- Create: `src/v2/read-models/executor-ops.ts`
- Create: `src/v2/read-models/run-inspection.ts`
- Create: `src/v2/read-models/registry.ts`
- Create: `tests/v2/read-model-registry.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing registry test**

Create `tests/v2/read-model-registry.test.ts` with this content:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { appendRuntimeEvent } from "../../src/v2/signals/events.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { buildReadModel } from "../../src/v2/read-models/registry.ts";

const runId = "run-read-model-1";

test("read model registry wraps workflow canvas in a versioned envelope", () => {
  const db = seededDb();

  const envelope = buildReadModel(db, { kind: "workflow-canvas", runId });

  assert.equal(envelope.schemaVersion, "southstar.read_model.workflow_canvas.v1");
  assert.equal(envelope.kind, "workflow-canvas");
  assert.equal(typeof envelope.generatedAt, "string");
  assert.deepEqual(envelope.diagnostics, { stale: false, warnings: [] });
  assert.deepEqual(envelope.data, {
    runId,
    status: "running",
    nodes: [{ id: "task-1", label: "task-implement", status: "running", dependsOn: [] }],
  });
});

test("read model registry builds task-detail and run-inspection envelopes", () => {
  const db = seededDb();
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: "binding-1",
    runId,
    taskId: "task-1",
    scope: "executor",
    status: "running",
    payload: { executorType: "tork", torkJobId: "job-1" },
  });

  const taskDetail = buildReadModel(db, { kind: "task-detail", runId, taskId: "task-1" });
  const inspection = buildReadModel(db, { kind: "run-inspection", runId });

  assert.equal(taskDetail.schemaVersion, "southstar.read_model.task_detail.v1");
  assert.equal(taskDetail.kind, "task-detail");
  assert.equal((taskDetail.data as { taskKey?: string }).taskKey, "task-implement");
  assert.equal(inspection.schemaVersion, "southstar.read_model.run_inspection.v1");
  assert.equal(inspection.kind, "run-inspection");
  assert.equal((inspection.data as { runId?: string }).runId, runId);
});

test("read model registry rejects missing taskId for task-detail", () => {
  const db = seededDb();

  assert.throws(
    () => buildReadModel(db, { kind: "task-detail", runId }),
    /taskId is required for task-detail read model/,
  );
});

test("read model registry exposes runtime-monitor, executor-ops, sessions-memory, and vault-mcp", () => {
  const db = seededDb();
  appendRuntimeEvent(db, {
    runId,
    taskId: "task-1",
    eventType: "progress.commentary",
    actorType: "agent",
    payload: { message: "running tests" },
  });
  upsertRuntimeResource(db, {
    resourceType: "session",
    resourceKey: "session-1",
    runId,
    taskId: "task-1",
    sessionId: "session-1",
    scope: "task",
    status: "active",
    payload: { summary: "root" },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "memory-1",
    runId,
    scope: "software",
    status: "approved",
    payload: { preference: "minimal" },
  });
  upsertRuntimeResource(db, {
    resourceType: "vault_lease",
    resourceKey: "lease-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "active",
    payload: { secretRef: "github-token" },
  });
  upsertRuntimeResource(db, {
    resourceType: "mcp_grant",
    resourceKey: "mcp-1",
    runId,
    taskId: "task-1",
    scope: "task",
    status: "active",
    payload: { serverId: "github" },
  });

  assert.equal(buildReadModel(db, { kind: "runtime-monitor", runId }).kind, "runtime-monitor");
  assert.equal(buildReadModel(db, { kind: "executor-ops", runId }).kind, "executor-ops");
  assert.equal(buildReadModel(db, { kind: "sessions-memory", runId }).kind, "sessions-memory");
  assert.equal(buildReadModel(db, { kind: "vault-mcp", runId }).kind, "vault-mcp");
});

function seededDb() {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "inspect read models",
    workflowManifestJson: "{}",
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  createWorkflowTask(db, {
    id: "task-1",
    runId,
    taskKey: "task-implement",
    status: "running",
    sortOrder: 0,
    dependsOn: [],
  });
  return db;
}
```

- [ ] **Step 2: Add the registry test import**

Add this line to `tests/v2/index.test.ts`:

```ts
await import("./read-model-registry.test.ts");
```

- [ ] **Step 3: Run the registry test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/read-model-registry.test.ts
```

Expected: FAIL with import error for `src/v2/read-models/registry.ts`.

- [ ] **Step 4: Add envelope and type files**

Create `src/v2/read-models/envelope.ts`:

```ts
export type ReadModelWarning = {
  code: string;
  message: string;
  severity: "info" | "warning";
  resourceRef?: string;
};

export type ReadModelDiagnostics = {
  stale: boolean;
  warnings: ReadModelWarning[];
};

export type ReadModelEnvelope<TKind extends string, TData> = {
  schemaVersion: string;
  kind: TKind;
  generatedAt: string;
  data: TData;
  diagnostics: ReadModelDiagnostics;
};

export function envelopeReadModel<TKind extends string, TData>(input: {
  schemaVersion: string;
  kind: TKind;
  data: TData;
  warnings?: ReadModelWarning[];
}): ReadModelEnvelope<TKind, TData> {
  return {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    generatedAt: new Date().toISOString(),
    data: input.data,
    diagnostics: {
      stale: false,
      warnings: input.warnings ?? [],
    },
  };
}
```

Create `src/v2/read-models/types.ts`:

```ts
export type ReadModelKind =
  | "run-inspection"
  | "runtime-monitor"
  | "workflow-canvas"
  | "executor-ops"
  | "task-detail"
  | "sessions-memory"
  | "vault-mcp";

export type ReadModelInput = {
  kind: ReadModelKind;
  runId: string;
  taskId?: string;
};
```

- [ ] **Step 5: Create migrated read model builder files**

Create `src/v2/read-models/workflow-canvas.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildWorkflowCanvasData(db: SouthstarDb, runId: string) {
  const run = getRun(db, runId);
  return {
    runId,
    status: run?.status ?? "unknown",
    nodes: listTasks(db, runId).map((task) => ({
      id: task.id,
      label: task.task_key,
      status: task.status,
      dependsOn: JSON.parse(task.depends_on_json) as string[],
    })),
  };
}

function getRun(db: SouthstarDb, runId: string): { id: string; status: string } | undefined {
  return db.prepare("select id, status from workflow_runs where id = ?").get(runId) as { id: string; status: string } | undefined;
}

function listTasks(db: SouthstarDb, runId: string): WorkflowTaskRow[] {
  return db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId) as WorkflowTaskRow[];
}

type WorkflowTaskRow = {
  id: string;
  task_key: string;
  status: string;
  depends_on_json: string;
};
```

Create `src/v2/read-models/runtime-monitor.ts`:

```ts
import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildRuntimeMonitorData(db: SouthstarDb, runId: string) {
  const run = db.prepare("select id, status from workflow_runs where id = ?").get(runId) as { id: string; status: string } | undefined;
  const history = listHistoryForRun(db, runId);
  const latestProgress = [...history].reverse().find((event) => event.eventType === "progress.commentary")?.payload as { message?: string } | undefined;
  const latestSteering = [...history].reverse().find((event) => event.eventType === "steering.received")?.payload as { message?: string } | undefined;
  const executorBindings = listResources(db, { resourceType: "executor_binding" });
  return {
    runId,
    status: run?.status ?? "unknown",
    latestProgress: latestProgress?.message,
    latestSteering: latestSteering?.message,
    executorJobIds: [...new Set(
      executorBindings
        .filter((binding) => binding.runId === runId)
        .map((binding) => executorJobId(binding.payload))
        .filter((jobId): jobId is string => typeof jobId === "string"),
    )],
    runningTaskIds: (db.prepare("select id from workflow_tasks where run_id = ? and status = 'running' order by sort_order").all(runId) as Array<{ id: string }>).map((task) => task.id),
  };
}

function executorJobId(payload: unknown): string | undefined {
  const record = payload as { externalJobId?: unknown; torkJobId?: unknown };
  return typeof record.externalJobId === "string"
    ? record.externalJobId
    : typeof record.torkJobId === "string"
      ? record.torkJobId
      : undefined;
}
```

Create `src/v2/read-models/task-detail.ts`:

```ts
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildTaskDetailData(db: SouthstarDb, runId: string, taskId: string) {
  const task = db.prepare("select * from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as WorkflowTaskRow | undefined;
  if (!task) return null;
  const latestBinding = listResources(db, { resourceType: "executor_binding" })
    .filter((resource) => resource.runId === runId && resource.taskId === taskId)
    .at(-1);
  return {
    id: task.id,
    runId: task.run_id,
    taskKey: task.task_key,
    status: task.status,
    dependsOn: JSON.parse(task.depends_on_json) as string[],
    rootSessionId: task.root_session_id,
    subagentSessionIds: JSON.parse(task.subagent_session_ids_json) as string[],
    executorTaskId: task.executor_task_id,
    snapshot: JSON.parse(task.snapshot_json) as unknown,
    metrics: JSON.parse(task.metrics_json) as unknown,
    executorObservation: latestBinding ? {
      bindingId: latestBinding.id,
      status: latestBinding.status,
      payload: latestBinding.payload,
    } : null,
  };
}

type WorkflowTaskRow = {
  id: string;
  run_id: string;
  task_key: string;
  status: string;
  depends_on_json: string;
  root_session_id: string | null;
  subagent_session_ids_json: string;
  executor_task_id: string | null;
  snapshot_json: string;
  metrics_json: string;
};
```

Create `src/v2/read-models/sessions-memory.ts`:

```ts
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildSessionsMemoryData(db: SouthstarDb, runId: string) {
  return {
    runId,
    sessions: sessionGraphResources(db).filter((resource) => resource.runId === runId),
    memoryItems: listResources(db, { resourceType: "memory_item" }).filter((resource) => resource.runId === runId),
  };
}

export function sessionGraphResources(db: SouthstarDb) {
  return [
    ...listResources(db, { resourceType: "session" }),
    ...listResources(db, { resourceType: "session_node" }),
    ...listResources(db, { resourceType: "session_checkpoint" }),
    ...listResources(db, { resourceType: "recovery_decision" }),
  ];
}
```

Create `src/v2/read-models/vault-mcp.ts`:

```ts
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildVaultMcpData(db: SouthstarDb, runId: string) {
  return {
    runId,
    vaultLeases: listResources(db, { resourceType: "vault_lease" }).filter((resource) => resource.runId === runId),
    mcpGrants: listResources(db, { resourceType: "mcp_grant" }).filter((resource) => resource.runId === runId),
  };
}
```

Create `src/v2/read-models/executor-ops.ts`:

```ts
import { listResources } from "../stores/resource-store.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildExecutorOpsData(db: SouthstarDb, runId: string) {
  return {
    runId,
    bindings: listResources(db, { resourceType: "executor_binding" })
      .filter((resource) => resource.runId === runId)
      .map((resource) => {
        const payload = resource.payload as { southstarExecutorStatus?: string; runnerPhase?: string; lastHeartbeatAt?: string };
        return {
          id: resource.id,
          status: resource.status,
          taskId: resource.taskId,
          torkJobId: executorJobId(resource.payload),
          statusLayers: {
            workflowTaskStatus: resource.taskId ? (db.prepare("select status from workflow_tasks where run_id = ? and id = ?").get(runId, resource.taskId) as { status: string } | undefined)?.status ?? "unknown" : "unknown",
            executorStatus: payload.southstarExecutorStatus ?? resource.status,
            runnerStatus: payload.runnerPhase ?? "no-heartbeat-yet",
          },
          lastHeartbeatAt: payload.lastHeartbeatAt ?? null,
        };
      }),
  };
}

function executorJobId(payload: unknown): string | undefined {
  const record = payload as { externalJobId?: unknown; torkJobId?: unknown };
  return typeof record.externalJobId === "string"
    ? record.externalJobId
    : typeof record.torkJobId === "string"
      ? record.torkJobId
      : undefined;
}
```

Create `src/v2/read-models/run-inspection.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { inspectRun } from "../inspection/inspect-run.ts";

export function buildRunInspectionData(db: SouthstarDb, runId: string) {
  return inspectRun(db, { runId });
}
```

- [ ] **Step 6: Create registry dispatch**

Create `src/v2/read-models/registry.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { envelopeReadModel, type ReadModelEnvelope } from "./envelope.ts";
import type { ReadModelInput } from "./types.ts";
import { buildExecutorOpsData } from "./executor-ops.ts";
import { buildRunInspectionData } from "./run-inspection.ts";
import { buildRuntimeMonitorData } from "./runtime-monitor.ts";
import { buildSessionsMemoryData } from "./sessions-memory.ts";
import { buildTaskDetailData } from "./task-detail.ts";
import { buildVaultMcpData } from "./vault-mcp.ts";
import { buildWorkflowCanvasData } from "./workflow-canvas.ts";

export function buildReadModel(db: SouthstarDb, input: ReadModelInput): ReadModelEnvelope<string, unknown> {
  switch (input.kind) {
    case "run-inspection":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.run_inspection.v1", kind: input.kind, data: buildRunInspectionData(db, input.runId) });
    case "runtime-monitor":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.runtime_monitor.v1", kind: input.kind, data: buildRuntimeMonitorData(db, input.runId) });
    case "workflow-canvas":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.workflow_canvas.v1", kind: input.kind, data: buildWorkflowCanvasData(db, input.runId) });
    case "executor-ops":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.executor_ops.v1", kind: input.kind, data: buildExecutorOpsData(db, input.runId) });
    case "task-detail": {
      if (!input.taskId) throw new Error("taskId is required for task-detail read model");
      const data = buildTaskDetailData(db, input.runId, input.taskId);
      if (!data) throw new Error(`task not found: ${input.runId}/${input.taskId}`);
      return envelopeReadModel({ schemaVersion: "southstar.read_model.task_detail.v1", kind: input.kind, data });
    }
    case "sessions-memory":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.sessions_memory.v1", kind: input.kind, data: buildSessionsMemoryData(db, input.runId) });
    case "vault-mcp":
      return envelopeReadModel({ schemaVersion: "southstar.read_model.vault_mcp.v1", kind: input.kind, data: buildVaultMcpData(db, input.runId) });
  }
}
```

- [ ] **Step 7: Run registry tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/read-model-registry.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit read model registry**

Run:

```bash
git add src/v2/read-models tests/v2/read-model-registry.test.ts tests/v2/index.test.ts
git commit -m "feat: add read model registry and envelopes"
```

---

## Task 5: Migrate Deprecated UI Read Model Imports

**Files:**
- Modify: `src/v2/ui-api/read-models.ts`
- Modify: `tests/v2/ui-read-models.test.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/ui-api/operations-dashboard.ts`
- Modify: `src/v2/ui-api/page-models/*.ts` when they import from `../read-models.ts`

- [ ] **Step 1: Replace `src/v2/ui-api/read-models.ts` with a thin compatibility shim**

Overwrite `src/v2/ui-api/read-models.ts` with:

```ts
// Deprecated compatibility shim. New code imports from src/v2/read-models/*.
export { buildWorkflowCanvasData as buildWorkflowCanvasModel } from "../read-models/workflow-canvas.ts";
export { buildRuntimeMonitorData as buildRuntimeMonitorModel } from "../read-models/runtime-monitor.ts";
export { buildTaskDetailData as buildTaskDetailModel } from "../read-models/task-detail.ts";
export { buildSessionsMemoryData as buildSessionsMemoryModel, sessionGraphResources } from "../read-models/sessions-memory.ts";
export { buildVaultMcpData as buildVaultMcpModel } from "../read-models/vault-mcp.ts";
export { buildExecutorOpsData as buildExecutorOpsModel } from "../read-models/executor-ops.ts";
```

- [ ] **Step 2: Update `tests/v2/ui-read-models.test.ts` imports to new read model files**

Replace its read-model import block with:

```ts
import { buildRuntimeMonitorData } from "../../src/v2/read-models/runtime-monitor.ts";
import { buildTaskDetailData } from "../../src/v2/read-models/task-detail.ts";
import { buildWorkflowCanvasData } from "../../src/v2/read-models/workflow-canvas.ts";
import { buildSessionsMemoryData } from "../../src/v2/read-models/sessions-memory.ts";
import { buildVaultMcpData } from "../../src/v2/read-models/vault-mcp.ts";
import { buildExecutorOpsData } from "../../src/v2/read-models/executor-ops.ts";
```

Then replace usages in the file:

```ts
buildWorkflowCanvasModel -> buildWorkflowCanvasData
buildRuntimeMonitorModel -> buildRuntimeMonitorData
buildTaskDetailModel -> buildTaskDetailData
buildSessionsMemoryModel -> buildSessionsMemoryData
buildVaultMcpModel -> buildVaultMcpData
buildExecutorOpsModel -> buildExecutorOpsData
```

- [ ] **Step 3: Migrate production imports that can move cleanly**

Run:

```bash
rg -n "ui-api/read-models|\.\./read-models\.ts|\./read-models\.ts" src/v2 tests/v2
```

For each production import that points at `src/v2/ui-api/read-models.ts`, replace it with the specific new file. Use these mappings:

```ts
buildWorkflowCanvasModel -> ../read-models/workflow-canvas.ts buildWorkflowCanvasData
buildRuntimeMonitorModel -> ../read-models/runtime-monitor.ts buildRuntimeMonitorData
buildTaskDetailModel -> ../read-models/task-detail.ts buildTaskDetailData
buildSessionsMemoryModel -> ../read-models/sessions-memory.ts buildSessionsMemoryData
sessionGraphResources -> ../read-models/sessions-memory.ts sessionGraphResources
buildVaultMcpModel -> ../read-models/vault-mcp.ts buildVaultMcpData
buildExecutorOpsModel -> ../read-models/executor-ops.ts buildExecutorOpsData
```

When a file is under `src/v2/ui-api/page-models/`, use relative imports such as:

```ts
import { buildTaskDetailData } from "../../read-models/task-detail.ts";
```

When a file is under `src/v2/ui-api/`, use:

```ts
import { buildRuntimeMonitorData } from "../read-models/runtime-monitor.ts";
```

- [ ] **Step 4: Run the UI read model test**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/ui-read-models.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run v2 tests to catch missed imports**

Run:

```bash
npm run test:v2
```

Expected: PASS or failures directly related to server/CLI read-model routes that later tasks implement. Fix any import errors before committing.

- [ ] **Step 6: Commit migration shim and imports**

Run:

```bash
git add src/v2/ui-api/read-models.ts src/v2/ui-api tests/v2/ui-read-models.test.ts
git commit -m "refactor: migrate ui read models to projection layer"
```

---

## Task 6: Add Read Model API Routes and Runtime Client Support

**Files:**
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `tests/v2/server-api.test.ts`

- [ ] **Step 1: Add failing API assertions to `tests/v2/server-api.test.ts`**

Inside the `runtime server supports run-goal, voice-command, and read routes` test, after `const runId = runGoal.result.runId;`, add:

```ts
    const readModel = await client.getReadModel({ kind: "run-inspection", runId });
    assert.equal(readModel.kind, "read-model");
    assert.equal(readModel.result.kind, "run-inspection");
    assert.equal(readModel.result.schemaVersion, "southstar.read_model.run_inspection.v1");
    assert.equal((readModel.result.data as { runId?: string }).runId, runId);
```

Also add a new test near the server error tests:

```ts
test("runtime server rejects unknown read model kinds with JSON error", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-read-model-errors-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider([]),
  });

  try {
    const response = await fetch(`${server.url}/api/v2/read-models/not-a-kind/run-1`);
    assert.equal(response.status, 400);
    const body = await response.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /unknown read model kind/);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run server API test and verify it fails on missing client method or route**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/server-api.test.ts
```

Expected: FAIL with `client.getReadModel is not a function` or route not found.

- [ ] **Step 3: Add client method to `src/v2/server/client.ts`**

Import `ReadModelKind`:

```ts
import type { ReadModelKind } from "../read-models/types.ts";
```

Add this method inside `createRuntimeServerClient` before `submitTorkCallback`:

```ts
    getReadModel(body: { kind: ReadModelKind; runId: string; taskId?: string }) {
      const suffix = body.kind === "task-detail"
        ? `${encodeURIComponent(body.runId)}/${encodeURIComponent(requiredTaskId(body.taskId))}`
        : encodeURIComponent(body.runId);
      return get(`${baseUrl}/api/v2/read-models/${encodeURIComponent(body.kind)}/${suffix}`);
    },
```

Add this helper near the bottom of the file before `post`:

```ts
function requiredTaskId(taskId: string | undefined): string {
  if (!taskId) throw new Error("taskId is required for task-detail read model");
  return taskId;
}
```

- [ ] **Step 4: Add read-model route to `src/v2/server/routes.ts`**

Add imports:

```ts
import { buildReadModel } from "../read-models/registry.ts";
import type { ReadModelKind } from "../read-models/types.ts";
```

Add this route block before the existing `runMatch` route:

```ts
    const readModelMatch = url.pathname.match(/^\/api\/v2\/read-models\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (request.method === "GET" && readModelMatch) {
      const kind = decodeURIComponent(readModelMatch[1]!) as ReadModelKind;
      if (!isReadModelKind(kind)) throw new Error(`unknown read model kind: ${kind}`);
      return json("read-model", buildReadModel(context.db, {
        kind,
        runId: decodeURIComponent(readModelMatch[2]!),
        taskId: readModelMatch[3] ? decodeURIComponent(readModelMatch[3]) : undefined,
      }));
    }
```

Add this helper near other route helpers:

```ts
function isReadModelKind(kind: string): kind is ReadModelKind {
  return [
    "run-inspection",
    "runtime-monitor",
    "workflow-canvas",
    "executor-ops",
    "task-detail",
    "sessions-memory",
    "vault-mcp",
  ].includes(kind);
}
```

- [ ] **Step 5: Run server API tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/server-api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit API and client support**

Run:

```bash
git add src/v2/server/routes.ts src/v2/server/client.ts tests/v2/server-api.test.ts
git commit -m "feat: expose read model API routes"
```

---

## Task 7: Add CLI `read-model` Command

**Files:**
- Modify: `src/v2/cli.ts`
- Modify: `tests/v2/cli-operations.test.ts`

- [ ] **Step 1: Extend CLI operation tests for parsing and execution**

In `tests/v2/cli-operations.test.ts`, add these assertions to the `parses phase 1.5 CLI commands` test:

```ts
  assert.deepEqual(parseV2Command(["read-model", "--kind", "run-inspection", "--run-id", "run-1"]), {
    command: "read-model",
    kind: "run-inspection",
    runId: "run-1",
  });
  assert.deepEqual(parseV2Command(["read-model", "--kind", "task-detail", "--run-id", "run-1", "--task-id", "task-1"]), {
    command: "read-model",
    kind: "task-detail",
    runId: "run-1",
    taskId: "task-1",
  });
```

In the fake `runtimeClient`, add:

```ts
    getReadModel: async () => envelope("read-model", { kind: "run-inspection", data: { runId: "run-1" } }, calls),
```

Add this argv item to the `commands` array:

```ts
    ["read-model", "--kind", "run-inspection", "--run-id", "run-1"],
```

Update the final expected calls:

```ts
  assert.deepEqual(calls, ["run-goal", "status", "tasks", "task", "artifacts", "sessions", "memory", "logs", "voice-command", "read-model"]);
```

Add a new test:

```ts
test("task-detail read-model CLI requires task id", () => {
  assert.throws(
    () => parseV2Command(["read-model", "--kind", "task-detail", "--run-id", "run-1"]),
    /--task-id is required for task-detail read model/,
  );
});
```

- [ ] **Step 2: Run CLI tests and verify they fail**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/cli-operations.test.ts
```

Expected: FAIL with `Unknown southstar:v2 command: read-model`.

- [ ] **Step 3: Modify `src/v2/cli.ts` command types and parser**

Add import:

```ts
import type { ReadModelKind } from "./read-models/types.ts";
```

Add this variant to `V2Command`:

```ts
  | { command: "read-model"; kind: ReadModelKind; runId: string; taskId?: string }
```

Add this parser case before `default`:

```ts
    case "read-model": {
      const kind = requireFlag(args, "--kind") as ReadModelKind;
      const runId = requireFlag(args, "--run-id");
      const taskId = optionalFlag(args, "--task-id");
      if (kind === "task-detail" && !taskId) throw new Error("--task-id is required for task-detail read model");
      return { command, kind, runId, taskId };
    }
```

Add helper after `requireFlag`:

```ts
function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
```

Add execute case before `serve`:

```ts
    case "read-model":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).getReadModel({
        kind: command.kind,
        runId: command.runId,
        taskId: command.taskId,
      }));
```

Add `"read-model"` to `needsRuntimeServer` list.

- [ ] **Step 4: Run CLI tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/cli-operations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit CLI read-model command**

Run:

```bash
git add src/v2/cli.ts tests/v2/cli-operations.test.ts
git commit -m "feat: add read model cli command"
```

---

## Task 8: Final Integration, Acceptance Audit, and Verification

**Files:**
- Modify: `tests/v2/index.test.ts` if import order needs adjustment
- Modify: any tests surfaced by full-suite verification

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/v2/run-inspection.test.ts
node --disable-warning=ExperimentalWarning tests/v2/read-model-registry.test.ts
node --disable-warning=ExperimentalWarning tests/v2/ui-read-models.test.ts
node --disable-warning=ExperimentalWarning tests/v2/server-api.test.ts
node --disable-warning=ExperimentalWarning tests/v2/cli-operations.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run the full v2 suite**

Run:

```bash
npm run test:v2
```

Expected: PASS.

If it fails, fix only failures caused by this plan. Do not change unrelated runtime behavior.

- [ ] **Step 3: Run the top-level test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Audit that read model layer has no raw payload return in run-inspection**

Run:

```bash
rg -n "payload:" src/v2/inspection src/v2/read-models/run-inspection.ts
```

Expected: no output for `run-inspection.ts` and no raw artifact/evidence/validator payload properties in `src/v2/inspection/*`. If output appears in helper code for internal parsing only, confirm returned `RunInspection` does not include raw payload fields.

- [ ] **Step 5: Audit `ui-api/read-models.ts` is a shim only**

Run:

```bash
wc -l src/v2/ui-api/read-models.ts
rg -n "function|prepare\(|listResources|listHistory" src/v2/ui-api/read-models.ts
```

Expected: small line count and no substantive DB/query logic.

- [ ] **Step 6: Audit API and CLI route availability**

Run:

```bash
rg -n "read-models|read-model|getReadModel" src/v2/server src/v2/cli.ts src/v2/server/client.ts tests/v2
```

Expected: route, client, CLI parser/executor, and tests are all present.

- [ ] **Step 7: Commit any final fixes**

Run:

```bash
git status --short
git add src/v2 tests/v2
git commit -m "test: verify operator read model platform"
```

If `git status --short` is clean, skip the commit and record that no final fixes were needed.

---

## Completion Checklist

Before declaring this implementation complete, verify each item with file/test evidence:

- [ ] `src/v2/inspection/*` exists and does not import server, CLI, or UI modules.
- [ ] `src/v2/read-models/*` exists and every P0 read model returns `ReadModelEnvelope` through registry.
- [ ] `run-inspection` aggregates run, tasks, executor binding, artifacts, evidence packets, validator results, stop condition, runtime gates, and Design Library lineage.
- [ ] `incomplete_evidence` outranks `blocking_validator_failed` as primary cause.
- [ ] Design Library lineage missing returns structured unavailable reason and does not throw.
- [ ] API exposes `/api/v2/read-models/:kind/:runId` and task-detail `:taskId` route.
- [ ] CLI exposes `southstar:v2 read-model --kind ... --run-id ... [--task-id ...]` and uses runtime server client.
- [ ] `src/v2/ui-api/read-models.ts` is a deprecated shim or removed after migration.
- [ ] `run-inspection` does not return raw artifact/evidence/validator payload.
- [ ] `npm run test:v2` passes.
- [ ] `npm test` passes.

## Spec Coverage Review

This plan maps every requirement from `docs/superpowers/specs/2026-06-16-southstar-p0-operator-read-model-platform-design.zh.md` to implementation tasks:

- Diagnostic core: Tasks 1–3.
- Runtime gates: Task 2 and Task 3.
- Design Library lineage tolerance: Task 2 and Task 3.
- Versioned read model envelope: Task 4.
- Read model registry and migrated builders: Task 4 and Task 5.
- API namespace: Task 6.
- CLI namespace command: Task 7.
- Breaking-change migration away from substantive `ui-api/read-models.ts`: Task 5.
- Testing and acceptance audit: Task 8.

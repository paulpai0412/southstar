# Southstar Session Recovery Token Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement durable Southstar session recovery with compact checkpoints, retry/fork/reset/rollback/rewind semantics, token telemetry, Pi-native optimization fallback, and real Design Library E2E coverage.

**Architecture:** Southstar remains the durable source of truth. Recovery actions write immutable checkpoint, decision, operation, context, envelope, and history facts before dispatching effects. Pi-native rewind/fork/resume is an optimization path selected only when capability and checkpoint anchors are safe; every failure falls back to Southstar-native replay or a blocked auditable state.

**Tech Stack:** Node >=22.22.2, ESM TypeScript via tsx/native type stripping, SQLite runtime resources/history, node:test, Tork/Docker real executor, Pi planner/harness, existing Design Library real E2E.

---

## File Structure

Create focused recovery modules under `src/v2/session-recovery/`:

- `src/v2/session-recovery/types.ts` — versioned checkpoint, recovery decision, operation, telemetry, and strategy types.
- `src/v2/session-recovery/checkpoints.ts` — create/read/validate immutable checkpoints and compact summaries.
- `src/v2/session-recovery/telemetry.ts` — token estimate and estimated savings helpers.
- `src/v2/session-recovery/context-rebuild.ts` — build checkpoint-aware recovery `ContextPacket` and matching `TaskEnvelopeV2`.
- `src/v2/session-recovery/policy.ts` — deterministic recovery strategy classification and authorization.
- `src/v2/session-recovery/operations.ts` — commit recovery decisions, session operations, and Southstar-native replay resources.
- `src/v2/session-recovery/pi-capabilities.ts` — Pi-native capability interface, safe-anchor checks, and fallback records.

Modify existing orchestration/UI/read-model files:

- `src/v2/context/builder.ts` — allow explicit packet ids/attempt labels and support checkpoint/failure summaries for recovery packets.
- `src/v2/agent-runner/task-envelope.ts` — export prompt rendering or add a safe `refreshTaskEnvelopePrompt` helper.
- `src/v2/agent-runner/cli.ts` — fix context refresh so refreshed context reaches the prompt.
- `src/v2/ui-api/local-api.ts` — create richer task-start checkpoints, attach workspace snapshots, and expose recovery dispatch helpers.
- `src/v2/executor/tork-callback.ts` — create artifact-accepted checkpoints and trigger/record recovery decisions for failed accepted-path callbacks where policy says recoverable.
- `src/v2/ui-api/commands/task-commands.ts` — upgrade retry/fork/rollback commands to durable recovery requests.
- `src/v2/ui-api/commands/session-memory-commands.ts` — implement fork/reset/rollback/rewind command semantics through recovery operations.
- `src/v2/server/ui-routes.ts` — add `/api/v2/sessions/:sessionId/rewind` route.
- `src/v2/read-models/sessions-memory.ts` and `src/v2/ui-api/page-models/sessions-memory.ts` — expose checkpoints, operations, branch lineage, telemetry.
- `src/v2/ui-api/page-models/workflow-canvas.ts` — expose recovery edges.
- `src/v2/quality/design-library-gates.ts` — add Design Library session recovery E2E gate checks.
- `tests/v2/*` — unit/integration tests.
- `tests/e2e-real/scenarios/design-library-template-real.ts` and `tests/e2e-real/design-library-template-real.test.ts` — real E2E recovery variants based on Design Library todo-web scenario.

Use commit commands with this repository's active git dir:

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add <files>
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "message"
```

---

### Task 1: Add Versioned Session Recovery Contracts

**Files:**
- Create: `src/v2/session-recovery/types.ts`
- Create: `tests/v2/session-recovery-types.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `tests/v2/session-recovery-types.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecoveryStrategy,
  recoveryStrategies,
  validateSessionCheckpoint,
  validateRecoveryDecision,
  validateSessionOperation,
} from "../../src/v2/session-recovery/types.ts";

test("session recovery strategies are explicit and stable", () => {
  assert.deepEqual(recoveryStrategies, [
    "retry-same-agent",
    "fork-from-checkpoint",
    "reset-from-checkpoint",
    "host-native-rewind",
    "rollback-workspace",
    "request-workflow-revision",
    "ask-human",
  ]);
  assert.equal(isRecoveryStrategy("fork-from-checkpoint"), true);
  assert.equal(isRecoveryStrategy("unknown"), false);
});

test("checkpoint validation rejects missing compact summary", () => {
  assert.throws(() => validateSessionCheckpoint({
    schemaVersion: "southstar.session-checkpoint.v1",
    checkpointId: "chk-1",
    runId: "run-1",
    taskId: "task-1",
    sessionId: "session-1",
    kind: "before-recovery",
    createdBy: "orchestrator",
    artifactRefs: [],
    evidencePacketRefs: [],
    validatorResultRefs: [],
    summaries: {
      checkpointSummary: "",
      decisions: [],
      filesTouched: [],
      filesInspected: [],
    },
    tokenTelemetry: { contextTokenEstimate: 10, checkpointSummaryTokenEstimate: 0 },
    policy: {
      safeForAutoRetry: true,
      safeForFork: true,
      safeForReset: true,
      safeForWorkspaceRollback: false,
    },
  }), /checkpointSummary is required/);
});

test("recovery decision validation requires before-recovery checkpoint", () => {
  assert.throws(() => validateRecoveryDecision({
    schemaVersion: "southstar.recovery-decision.v1",
    decisionId: "decision-1",
    runId: "run-1",
    taskId: "task-1",
    source: "evaluator",
    requestedStrategy: "retry-same-agent",
    selectedStrategy: "retry-same-agent",
    beforeRecoveryCheckpointId: "",
    reason: "missing evidence",
    evaluatorFindingRefs: [],
    authorization: { mode: "auto", policyReasons: ["repairable artifact"] },
    execution: { status: "queued" },
    tokenTelemetry: {},
  }), /beforeRecoveryCheckpointId is required/);
});

test("session operation validation rejects failed operation without error", () => {
  assert.throws(() => validateSessionOperation({
    operationId: "op-1",
    runId: "run-1",
    taskId: "task-1",
    type: "rewind",
    baseCheckpointId: "chk-1",
    host: "pi",
    status: "failed",
    fallbackUsed: true,
  }), /failed session operation requires error/);
});
```

- [ ] **Step 2: Register the test**

Modify `tests/v2/index.test.ts` to import the new file near other v2 tests:

```ts
await import("./session-recovery-types.test.ts");
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-types.test.ts
```

Expected: FAIL with `Cannot find module '../../src/v2/session-recovery/types.ts'`.

- [ ] **Step 4: Implement recovery types and validators**

Create `src/v2/session-recovery/types.ts`:

```ts
export const recoveryStrategies = [
  "retry-same-agent",
  "fork-from-checkpoint",
  "reset-from-checkpoint",
  "host-native-rewind",
  "rollback-workspace",
  "request-workflow-revision",
  "ask-human",
] as const;

export type RecoveryStrategy = typeof recoveryStrategies[number];

export function isRecoveryStrategy(value: unknown): value is RecoveryStrategy {
  return typeof value === "string" && (recoveryStrategies as readonly string[]).includes(value);
}

export type SessionCheckpointV1 = {
  schemaVersion: "southstar.session-checkpoint.v1";
  checkpointId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  kind: "task-start" | "artifact-accepted" | "before-recovery" | "manual";
  createdBy: "orchestrator" | "evaluator" | "operator" | "root-session";
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefs: string[];
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
  workspaceSnapshotRef?: string;
  hostSessionAnchor?: {
    host: "pi" | "codex" | "claude-code" | "custom";
    rootSessionId?: string;
    streamSessionId?: string;
    providerCheckpointId?: string;
    rewindSupported?: boolean;
  };
  summaries: {
    checkpointSummary: string;
    decisions: string[];
    filesTouched: string[];
    filesInspected: string[];
    failureSummary?: string;
    attemptedApproach?: string;
    nextAttemptHint?: string;
  };
  tokenTelemetry: {
    contextTokenEstimate: number;
    checkpointSummaryTokenEstimate: number;
    failureSuffixTokenEstimate?: number;
  };
  policy: {
    safeForAutoRetry: boolean;
    safeForFork: boolean;
    safeForReset: boolean;
    safeForWorkspaceRollback: boolean;
  };
};

export type RecoveryDecisionV1 = {
  schemaVersion: "southstar.recovery-decision.v1";
  decisionId: string;
  runId: string;
  taskId: string;
  source: "evaluator" | "operator" | "executor-observation" | "agent-suggestion";
  requestedStrategy: RecoveryStrategy;
  selectedStrategy: RecoveryStrategy;
  baseCheckpointId?: string;
  beforeRecoveryCheckpointId: string;
  reason: string;
  evaluatorFindingRefs: string[];
  agentSuggestion?: { strategy: string; confidence?: "low" | "medium" | "high"; reason: string };
  authorization: { mode: "auto" | "operator-approved" | "blocked"; approvalRef?: string; policyReasons: string[] };
  execution: {
    status: "queued" | "running" | "succeeded" | "failed" | "fallback-used";
    hostPath?: "pi-native" | "southstar-native";
    fallbackReason?: string;
    newSessionId?: string;
    newTaskEnvelopeId?: string;
  };
  tokenTelemetry: {
    originalContextTokenEstimate?: number;
    rebuiltContextTokenEstimate?: number;
    omittedFailureSuffixEstimate?: number;
    estimatedSavings?: number;
  };
};

export type SessionOperationV1 = {
  operationId: string;
  runId: string;
  taskId: string;
  type: "fork" | "reset" | "rewind" | "replay";
  baseCheckpointId: string;
  oldSessionId?: string;
  newSessionId?: string;
  host: "pi" | "southstar-native";
  status: "queued" | "succeeded" | "failed";
  fallbackUsed: boolean;
  error?: string;
};

export function validateSessionCheckpoint(value: SessionCheckpointV1): SessionCheckpointV1 {
  requireString(value.checkpointId, "checkpointId");
  requireString(value.runId, "runId");
  requireString(value.taskId, "taskId");
  requireString(value.sessionId, "sessionId");
  requireString(value.summaries.checkpointSummary, "checkpointSummary");
  if (!Number.isFinite(value.tokenTelemetry.contextTokenEstimate)) throw new Error("contextTokenEstimate must be finite");
  if (!Number.isFinite(value.tokenTelemetry.checkpointSummaryTokenEstimate)) throw new Error("checkpointSummaryTokenEstimate must be finite");
  return value;
}

export function validateRecoveryDecision(value: RecoveryDecisionV1): RecoveryDecisionV1 {
  requireString(value.decisionId, "decisionId");
  requireString(value.runId, "runId");
  requireString(value.taskId, "taskId");
  requireString(value.beforeRecoveryCheckpointId, "beforeRecoveryCheckpointId");
  requireString(value.reason, "reason");
  if (!isRecoveryStrategy(value.requestedStrategy)) throw new Error(`unknown requestedStrategy: ${String(value.requestedStrategy)}`);
  if (!isRecoveryStrategy(value.selectedStrategy)) throw new Error(`unknown selectedStrategy: ${String(value.selectedStrategy)}`);
  return value;
}

export function validateSessionOperation(value: SessionOperationV1): SessionOperationV1 {
  requireString(value.operationId, "operationId");
  requireString(value.runId, "runId");
  requireString(value.taskId, "taskId");
  requireString(value.baseCheckpointId, "baseCheckpointId");
  if (value.status === "failed" && !value.error) throw new Error("failed session operation requires error");
  return value;
}

function requireString(value: string | undefined, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-types.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/types.ts tests/v2/session-recovery-types.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: add session recovery contracts"
```

---

### Task 2: Add Token Telemetry Helpers

**Files:**
- Create: `src/v2/session-recovery/telemetry.ts`
- Create: `tests/v2/session-recovery-telemetry.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write telemetry tests**

Create `tests/v2/session-recovery-telemetry.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, recoverySavingsTelemetry } from "../../src/v2/session-recovery/telemetry.ts";

test("estimateTokens uses stable quarter-character approximation", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("recoverySavingsTelemetry clamps negative savings to zero", () => {
  assert.deepEqual(recoverySavingsTelemetry({
    originalContextTokenEstimate: 100,
    rebuiltContextTokenEstimate: 70,
    omittedFailureSuffixEstimate: 50,
  }), {
    originalContextTokenEstimate: 100,
    rebuiltContextTokenEstimate: 70,
    omittedFailureSuffixEstimate: 50,
    estimatedSavings: 30,
  });

  assert.equal(recoverySavingsTelemetry({
    originalContextTokenEstimate: 50,
    rebuiltContextTokenEstimate: 60,
    omittedFailureSuffixEstimate: 10,
  }).estimatedSavings, 0);
});
```

- [ ] **Step 2: Register the test**

Add to `tests/v2/index.test.ts`:

```ts
await import("./session-recovery-telemetry.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-telemetry.test.ts
```

Expected: FAIL with missing `telemetry.ts`.

- [ ] **Step 4: Implement telemetry helpers**

Create `src/v2/session-recovery/telemetry.ts`:

```ts
export type RecoverySavingsTelemetryInput = {
  originalContextTokenEstimate?: number;
  rebuiltContextTokenEstimate?: number;
  omittedFailureSuffixEstimate?: number;
};

export type RecoverySavingsTelemetry = {
  originalContextTokenEstimate?: number;
  rebuiltContextTokenEstimate?: number;
  omittedFailureSuffixEstimate?: number;
  estimatedSavings?: number;
};

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function recoverySavingsTelemetry(input: RecoverySavingsTelemetryInput): RecoverySavingsTelemetry {
  const original = finiteNumber(input.originalContextTokenEstimate);
  const rebuilt = finiteNumber(input.rebuiltContextTokenEstimate);
  const omitted = finiteNumber(input.omittedFailureSuffixEstimate);
  const estimatedSavings = original !== undefined && rebuilt !== undefined
    ? Math.max(0, original - rebuilt)
    : undefined;
  return {
    ...(original !== undefined ? { originalContextTokenEstimate: original } : {}),
    ...(rebuilt !== undefined ? { rebuiltContextTokenEstimate: rebuilt } : {}),
    ...(omitted !== undefined ? { omittedFailureSuffixEstimate: omitted } : {}),
    ...(estimatedSavings !== undefined ? { estimatedSavings } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-telemetry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/telemetry.ts tests/v2/session-recovery-telemetry.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: add recovery token telemetry helpers"
```

---

### Task 3: Create Rich Checkpoint Store Helpers

**Files:**
- Create: `src/v2/session-recovery/checkpoints.ts`
- Create: `tests/v2/session-recovery-checkpoints.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write checkpoint persistence tests**

Create `tests/v2/session-recovery-checkpoints.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createSessionCheckpoint, getSessionCheckpoint } from "../../src/v2/session-recovery/checkpoints.ts";

test("creates immutable rich session checkpoint resource and history", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-checkpoint"));

  const checkpoint = createSessionCheckpoint(db, {
    runId: "run-checkpoint",
    taskId: "implementer",
    sessionId: "root-run-checkpoint-implementer",
    kind: "before-recovery",
    createdBy: "evaluator",
    contextPacketId: "ctx-1",
    taskEnvelopeId: "env-1",
    artifactRefs: ["artifact-1"],
    evidencePacketRefs: ["evidence-1"],
    validatorResultRefs: ["validator-1"],
    workspaceSnapshotRef: "workspace-1",
    checkpointSummary: "Implementation evidence is missing test results.",
    failureSummary: "Validator rejected missing testResults.",
    attemptedApproach: "Submitted artifact before running npm test.",
    nextAttemptHint: "Run npm test and include command output.",
    contextTokenEstimate: 900,
    failureSuffixTokenEstimate: 300,
    policy: { safeForAutoRetry: true, safeForFork: true, safeForReset: true, safeForWorkspaceRollback: false },
  });

  assert.equal(checkpoint.kind, "before-recovery");
  assert.equal(checkpoint.tokenTelemetry.checkpointSummaryTokenEstimate > 0, true);

  const stored = getSessionCheckpoint(db, checkpoint.checkpointId);
  assert.equal(stored?.checkpointId, checkpoint.checkpointId);
  assert.equal(stored?.summaries.failureSummary, "Validator rejected missing testResults.");

  const resources = listResources(db, { resourceType: "session_checkpoint" });
  assert.equal(resources.length, 1);
  assert.equal(resources[0]?.status, "created");
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false }, vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false }, title: "wf", goalPrompt: "todo-web" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
```

- [ ] **Step 2: Register the test**

Add:

```ts
await import("./session-recovery-checkpoints.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-checkpoints.test.ts
```

Expected: FAIL with missing `checkpoints.ts`.

- [ ] **Step 4: Implement checkpoint helper**

Create `src/v2/session-recovery/checkpoints.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../stores/resource-store.ts";
import { estimateTokens } from "./telemetry.ts";
import type { SessionCheckpointV1 } from "./types.ts";
import { validateSessionCheckpoint } from "./types.ts";

export type CreateSessionCheckpointInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  kind: SessionCheckpointV1["kind"];
  createdBy: SessionCheckpointV1["createdBy"];
  contextPacketId?: string;
  taskEnvelopeId?: string;
  artifactRefs?: string[];
  evidencePacketRefs?: string[];
  validatorResultRefs?: string[];
  workspaceSnapshotRef?: string;
  hostSessionAnchor?: SessionCheckpointV1["hostSessionAnchor"];
  checkpointSummary: string;
  decisions?: string[];
  filesTouched?: string[];
  filesInspected?: string[];
  failureSummary?: string;
  attemptedApproach?: string;
  nextAttemptHint?: string;
  contextTokenEstimate?: number;
  failureSuffixTokenEstimate?: number;
  policy?: Partial<SessionCheckpointV1["policy"]>;
};

export function createSessionCheckpoint(db: SouthstarDb, input: CreateSessionCheckpointInput): SessionCheckpointV1 {
  requireRun(db, input.runId);
  const checkpointId = `checkpoint-${input.runId}-${input.taskId}-${input.kind}-${randomUUID()}`;
  const checkpoint = validateSessionCheckpoint({
    schemaVersion: "southstar.session-checkpoint.v1",
    checkpointId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    kind: input.kind,
    createdBy: input.createdBy,
    contextPacketId: input.contextPacketId,
    taskEnvelopeId: input.taskEnvelopeId,
    artifactRefs: input.artifactRefs ?? [],
    evidencePacketRefs: input.evidencePacketRefs ?? [],
    validatorResultRefs: input.validatorResultRefs ?? [],
    workspaceSnapshotRef: input.workspaceSnapshotRef,
    hostSessionAnchor: input.hostSessionAnchor,
    summaries: {
      checkpointSummary: input.checkpointSummary,
      decisions: input.decisions ?? [],
      filesTouched: input.filesTouched ?? [],
      filesInspected: input.filesInspected ?? [],
      failureSummary: input.failureSummary,
      attemptedApproach: input.attemptedApproach,
      nextAttemptHint: input.nextAttemptHint,
    },
    tokenTelemetry: {
      contextTokenEstimate: input.contextTokenEstimate ?? estimateTokens(input.checkpointSummary),
      checkpointSummaryTokenEstimate: estimateTokens(input.checkpointSummary),
      failureSuffixTokenEstimate: input.failureSuffixTokenEstimate,
    },
    policy: {
      safeForAutoRetry: input.policy?.safeForAutoRetry ?? false,
      safeForFork: input.policy?.safeForFork ?? false,
      safeForReset: input.policy?.safeForReset ?? false,
      safeForWorkspaceRollback: input.policy?.safeForWorkspaceRollback ?? false,
    },
  });

  upsertRuntimeResource(db, {
    id: checkpointId,
    resourceType: "session_checkpoint",
    resourceKey: checkpointId,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    scope: "session",
    status: "created",
    title: `${input.kind} checkpoint`,
    payload: checkpoint,
    summary: {
      kind: input.kind,
      checkpointSummary: input.checkpointSummary,
      artifactRefs: checkpoint.artifactRefs,
      tokenTelemetry: checkpoint.tokenTelemetry,
    },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    eventType: "checkpoint.created",
    actorType: input.createdBy,
    payload: { checkpointId, kind: input.kind, contextPacketId: input.contextPacketId },
  });
  return checkpoint;
}

export function getSessionCheckpoint(db: SouthstarDb, checkpointId: string): SessionCheckpointV1 | null {
  const resource = getResourceByKey(db, "session_checkpoint", checkpointId);
  if (!resource) return null;
  return validateSessionCheckpoint(resource.payload as SessionCheckpointV1);
}

function requireRun(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (!row) throw new Error(`unknown workflow run: ${runId}`);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-checkpoints.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/checkpoints.ts tests/v2/session-recovery-checkpoints.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: add rich session checkpoints"
```

---

### Task 4: Fix Context Refresh Prompt Consistency

**Files:**
- Modify: `src/v2/agent-runner/task-envelope.ts`
- Modify: `src/v2/agent-runner/cli.ts`
- Test: `tests/v2/agent-runner-cli.test.ts`

- [ ] **Step 1: Add failing test for refreshed prompt**

Append to `tests/v2/agent-runner-cli.test.ts`:

```ts
test("context refresh regenerates agentPrompt with upstream artifact summary", async () => {
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        upstreamContext: {
          text: "Accepted upstream artifact artifact-1: Implemented todo priority persistence.",
          artifactRefs: ["artifact-1"],
          evidencePacketRefs: [],
          validatorResultRefs: [],
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/refresh`;
  try {
    const envelope = minimalTaskEnvelopeV2();
    const refreshed = await refreshEnvelopeContext(url, envelope);
    assert.equal(refreshed.contextPacket.priorArtifacts.some((artifact) => artifact.sourceRef === "artifact-1"), true);
    assert.match(refreshed.agentPrompt, /Accepted upstream artifact artifact-1/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
```

If `minimalTaskEnvelopeV2()` is not already available in the test file, add a local helper that returns a valid `TaskEnvelopeV2` with empty prior artifacts and one artifact contract.

- [ ] **Step 2: Export refresh function for testing**

In `src/v2/agent-runner/cli.ts`, change:

```ts
async function refreshEnvelopeContext(url: string, envelope: AnyTaskEnvelope): Promise<AnyTaskEnvelope> {
```

to:

```ts
export async function refreshEnvelopeContext(url: string, envelope: AnyTaskEnvelope): Promise<AnyTaskEnvelope> {
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/agent-runner-cli.test.ts
```

Expected before implementation: FAIL because `agentPrompt` does not include the refreshed upstream artifact summary.

- [ ] **Step 4: Export prompt refresh helper**

In `src/v2/agent-runner/task-envelope.ts`, export a helper after `buildTaskEnvelopeV2`:

```ts
export function refreshTaskEnvelopeV2Prompt(envelope: TaskEnvelopeV2): TaskEnvelopeV2 {
  return {
    ...envelope,
    agentPrompt: renderContextPacketPrompt(envelope.contextPacket, {
      role: envelope.role,
      agentProfile: envelope.agentProfile,
      artifactContracts: envelope.artifactContracts,
      evaluatorPipeline: envelope.evaluatorPipeline,
    }),
  };
}
```

- [ ] **Step 5: Use prompt refresh after context refresh**

In `src/v2/agent-runner/cli.ts`, import the helper:

```ts
import { refreshTaskEnvelopeV2Prompt, type AnyTaskEnvelope } from "./task-envelope.ts";
```

Update the return object in `refreshEnvelopeContext` for v2 envelopes:

```ts
  const refreshed = {
    ...envelope,
    contextPacket: {
      ...envelope.contextPacket,
      priorArtifacts: [
        ...envelope.contextPacket.priorArtifacts,
        {
          id: `upstream-${envelope.runId}-${envelope.taskId}`,
          sourceType: "artifact" as const,
          title: "Accepted upstream artifacts",
          text,
          sourceRef: payload.upstreamContext?.artifactRefs?.join(","),
          tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
        },
      ],
    },
  };
  return refreshTaskEnvelopeV2Prompt(refreshed);
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/agent-runner-cli.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/agent-runner/task-envelope.ts src/v2/agent-runner/cli.ts tests/v2/agent-runner-cli.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "fix: regenerate prompt after context refresh"
```

---

### Task 5: Build Recovery Context and Envelope Rebuild

**Files:**
- Create: `src/v2/session-recovery/context-rebuild.ts`
- Create: `tests/v2/session-recovery-context-rebuild.test.ts`
- Modify: `src/v2/context/builder.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write context rebuild test**

Create `tests/v2/session-recovery-context-rebuild.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createSessionCheckpoint } from "../../src/v2/session-recovery/checkpoints.ts";
import { rebuildTaskEnvelopeFromCheckpoint } from "../../src/v2/session-recovery/context-rebuild.ts";

test("rebuilds compact recovery context and matching prompt from checkpoint", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-rebuild"));
  upsertRuntimeResource(db, {
    resourceType: "artifact",
    resourceKey: "artifact-upstream",
    runId: "run-rebuild",
    taskId: "planner",
    scope: "task",
    status: "accepted",
    title: "Planner artifact",
    payload: { summary: "Plan says implement due-date persistence in todo-store." },
    summary: { summary: "Plan says implement due-date persistence in todo-store." },
  });
  const checkpoint = createSessionCheckpoint(db, {
    runId: "run-rebuild",
    taskId: "implementer",
    sessionId: "root-run-rebuild-implementer",
    kind: "before-recovery",
    createdBy: "evaluator",
    artifactRefs: ["artifact-upstream"],
    checkpointSummary: "Implementer submitted incomplete evidence.",
    failureSummary: "Missing testResults and command output.",
    nextAttemptHint: "Run npm test and include output.",
    contextTokenEstimate: 1200,
    failureSuffixTokenEstimate: 500,
    policy: { safeForAutoRetry: true, safeForFork: true, safeForReset: true },
  });

  const result = rebuildTaskEnvelopeFromCheckpoint(db, {
    runId: "run-rebuild",
    taskId: "implementer",
    workflowId: "wf-rebuild",
    domainPack: softwareDomainPack,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    artifactContractRefs: ["implementation_report"],
    checkpointId: checkpoint.checkpointId,
    goalPrompt: "Add priority labels and due dates to todo-web.",
    executionAttempt: 2,
  });

  assert.equal(result.contextPacket.checkpointSummary?.text.includes("incomplete evidence"), true);
  assert.equal(result.contextPacket.failureSummary?.text.includes("Missing testResults"), true);
  assert.match(result.envelope.agentPrompt, /Missing testResults/);
  assert.equal(result.telemetry.originalContextTokenEstimate, 1200);
  assert.equal(result.telemetry.rebuiltContextTokenEstimate > 0, true);
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-rebuild", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false }, vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false }, title: "wf", goalPrompt: "todo-web" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
```

- [ ] **Step 2: Register the test**

Add:

```ts
await import("./session-recovery-context-rebuild.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-context-rebuild.test.ts
```

Expected: FAIL with missing `context-rebuild.ts`.

- [ ] **Step 4: Allow context builder attempt-specific packet ids**

In `src/v2/context/builder.ts`, extend `BuildContextPacketInput`:

```ts
  contextPacketId?: string;
```

Change packet id assignment:

```ts
    id: input.contextPacketId ?? `ctx-${input.runId}-${input.taskId}-attempt-${executionAttempt}`,
```

- [ ] **Step 5: Implement rebuild helper**

Create `src/v2/session-recovery/context-rebuild.ts`:

```ts
import type { DomainPack } from "../domain-packs/types.ts";
import { buildContextPacket } from "../context/builder.ts";
import { buildTaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { ContextPacket } from "../context/types.ts";
import type { TaskEnvelopeV2 } from "../agent-runner/task-envelope.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import { getSessionCheckpoint } from "./checkpoints.ts";
import { recoverySavingsTelemetry } from "./telemetry.ts";
import type { RecoverySavingsTelemetry } from "./telemetry.ts";

export type RebuildTaskEnvelopeInput = {
  runId: string;
  taskId: string;
  workflowId: string;
  domainPack: DomainPack;
  roleRef: string;
  agentProfileRef: string;
  artifactContractRefs: string[];
  checkpointId: string;
  goalPrompt: string;
  executionAttempt: number;
};

export type RebuildTaskEnvelopeResult = {
  contextPacket: ContextPacket;
  envelope: TaskEnvelopeV2;
  telemetry: RecoverySavingsTelemetry;
};

export function rebuildTaskEnvelopeFromCheckpoint(db: SouthstarDb, input: RebuildTaskEnvelopeInput): RebuildTaskEnvelopeResult {
  const checkpoint = getSessionCheckpoint(db, input.checkpointId);
  if (!checkpoint) throw new Error(`session checkpoint not found: ${input.checkpointId}`);
  if (checkpoint.runId !== input.runId) throw new Error(`checkpoint ${input.checkpointId} does not belong to run ${input.runId}`);
  if (checkpoint.taskId !== input.taskId) throw new Error(`checkpoint ${input.checkpointId} does not belong to task ${input.taskId}`);

  const contextPacket = buildContextPacket(db, {
    contextPacketId: `ctx-${input.runId}-${input.taskId}-recovery-${input.executionAttempt}`,
    runId: input.runId,
    taskId: input.taskId,
    rootSessionId: checkpoint.sessionId,
    executionAttempt: input.executionAttempt,
    goalPrompt: input.goalPrompt,
    domainPack: input.domainPack,
    roleRef: input.roleRef,
    agentProfileRef: input.agentProfileRef,
    artifactContractRefs: input.artifactContractRefs,
    priorArtifactRefs: checkpoint.artifactRefs,
    checkpointSummary: checkpoint.summaries.checkpointSummary,
    failureSummary: compactFailureText(checkpoint),
    workspaceSummary: checkpoint.workspaceSnapshotRef ? `Workspace snapshot: ${checkpoint.workspaceSnapshotRef}` : undefined,
  });

  const runtimeTask = resolveRuntimeTask(input.domainPack, input.roleRef, input.agentProfileRef, input.artifactContractRefs);
  const envelope = buildTaskEnvelopeV2({
    runId: input.runId,
    workflowId: input.workflowId,
    taskId: input.taskId,
    domain: input.domainPack.id,
    intent: "recovery",
    role: runtimeTask.role,
    agentProfile: runtimeTask.agentProfile,
    harness: {
      id: runtimeTask.agentProfile.harnessRef,
      kind: runtimeTask.agentProfile.harnessRef === "pi" ? "pi-agent" : "custom",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: [input.domainPack.id],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket,
    skills: [],
    mcpGrants: [],
    vaultLeases: [],
    artifactContracts: runtimeTask.artifactContracts,
    evaluatorPipeline: runtimeTask.evaluatorPipeline,
    session: { sessionId: checkpoint.sessionId, baseCheckpointId: checkpoint.checkpointId, maxRepairAttempts: 1 },
  });

  upsertRuntimeResource(db, {
    id: `task-envelope-${input.runId}-${input.taskId}-recovery-${input.executionAttempt}`,
    resourceType: "task_envelope",
    resourceKey: `task-envelope-${input.runId}-${input.taskId}-recovery-${input.executionAttempt}`,
    runId: input.runId,
    taskId: input.taskId,
    sessionId: checkpoint.sessionId,
    scope: input.domainPack.id,
    status: "created",
    title: "Recovery TaskEnvelopeV2",
    payload: envelope,
    summary: { contextPacketId: contextPacket.id, baseCheckpointId: checkpoint.checkpointId },
  });

  return {
    contextPacket,
    envelope,
    telemetry: recoverySavingsTelemetry({
      originalContextTokenEstimate: checkpoint.tokenTelemetry.contextTokenEstimate,
      rebuiltContextTokenEstimate: contextPacket.tokenEstimate.total,
      omittedFailureSuffixEstimate: checkpoint.tokenTelemetry.failureSuffixTokenEstimate,
    }),
  };
}

function compactFailureText(checkpoint: NonNullable<ReturnType<typeof getSessionCheckpoint>>): string | undefined {
  return [
    checkpoint.summaries.failureSummary,
    checkpoint.summaries.attemptedApproach ? `Attempted approach: ${checkpoint.summaries.attemptedApproach}` : undefined,
    checkpoint.summaries.nextAttemptHint ? `Next attempt: ${checkpoint.summaries.nextAttemptHint}` : undefined,
  ].filter(Boolean).join("\n") || undefined;
}

function resolveRuntimeTask(domainPack: DomainPack, roleRef: string, agentProfileRef: string, artifactContractRefs: string[]) {
  const role = domainPack.roles.find((candidate) => candidate.id === roleRef);
  const agentProfile = domainPack.agentProfiles.find((candidate) => candidate.id === agentProfileRef);
  if (!role) throw new Error(`missing role ${roleRef}`);
  if (!agentProfile) throw new Error(`missing agent profile ${agentProfileRef}`);
  const artifactContracts = artifactContractRefs.map((ref) => {
    const contract = domainPack.artifactContracts.find((candidate) => candidate.id === ref);
    if (!contract) throw new Error(`missing artifact contract ${ref}`);
    return contract;
  });
  const evaluatorPipeline = domainPack.evaluatorPipelines[0];
  if (!evaluatorPipeline) throw new Error("missing evaluator pipeline");
  return { role, agentProfile, artifactContracts, evaluatorPipeline };
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-context-rebuild.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/context-rebuild.ts src/v2/context/builder.ts tests/v2/session-recovery-context-rebuild.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: rebuild recovery context from checkpoints"
```

---

### Task 6: Add Recovery Policy Classifier

**Files:**
- Create: `src/v2/session-recovery/policy.ts`
- Create: `tests/v2/session-recovery-policy.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write classifier tests**

Create `tests/v2/session-recovery-policy.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRecoveryStrategy } from "../../src/v2/session-recovery/policy.ts";

test("missing artifact fields classify as compact retry", () => {
  assert.deepEqual(classifyRecoveryStrategy({
    taskId: "checker",
    artifactStatus: "needs_repair",
    missingFields: ["testResults"],
    validatorFindings: [],
    retryCount: 0,
    maxRetryAttempts: 2,
    workspaceDirty: false,
    checkerRejectedApproach: false,
    executorIssue: "none",
  }), {
    strategy: "retry-same-agent",
    authorizationMode: "auto",
    reason: "Artifact is repairable: missing testResults.",
    policyReasons: ["artifact_needs_repair", "retry_budget_available"],
  });
});

test("checker rejection classifies as fork", () => {
  assert.equal(classifyRecoveryStrategy({
    taskId: "checker",
    artifactStatus: "failed",
    missingFields: [],
    validatorFindings: ["browser behavior rejected"],
    retryCount: 0,
    maxRetryAttempts: 2,
    workspaceDirty: false,
    checkerRejectedApproach: true,
    executorIssue: "none",
  }).strategy, "fork-from-checkpoint");
});

test("dirty workspace test failure classifies as workspace rollback requiring operator", () => {
  const decision = classifyRecoveryStrategy({
    taskId: "implementer",
    artifactStatus: "failed",
    missingFields: [],
    validatorFindings: ["npm test failed"],
    retryCount: 0,
    maxRetryAttempts: 2,
    workspaceDirty: true,
    checkerRejectedApproach: false,
    executorIssue: "none",
  });
  assert.equal(decision.strategy, "rollback-workspace");
  assert.equal(decision.authorizationMode, "operator-approved");
});
```

- [ ] **Step 2: Register test**

Add:

```ts
await import("./session-recovery-policy.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-policy.test.ts
```

Expected: FAIL with missing `policy.ts`.

- [ ] **Step 4: Implement policy**

Create `src/v2/session-recovery/policy.ts`:

```ts
import type { RecoveryStrategy } from "./types.ts";

export type RecoveryPolicyInput = {
  taskId: string;
  artifactStatus: "accepted" | "needs_repair" | "rejected" | "failed" | "missing";
  missingFields: string[];
  validatorFindings: string[];
  retryCount: number;
  maxRetryAttempts: number;
  workspaceDirty: boolean;
  checkerRejectedApproach: boolean;
  executorIssue: "none" | "timeout" | "callback_missing" | "orphaned";
};

export type RecoveryPolicyDecision = {
  strategy: RecoveryStrategy;
  authorizationMode: "auto" | "operator-approved" | "blocked";
  reason: string;
  policyReasons: string[];
};

export function classifyRecoveryStrategy(input: RecoveryPolicyInput): RecoveryPolicyDecision {
  if (input.executorIssue !== "none") {
    return {
      strategy: "retry-same-agent",
      authorizationMode: "auto",
      reason: `Executor issue ${input.executorIssue}; replay from checkpoint without penalizing agent output.`,
      policyReasons: ["executor_issue", input.executorIssue],
    };
  }
  if (input.workspaceDirty && input.validatorFindings.some((finding) => /test failed|npm test|browser/i.test(finding))) {
    return {
      strategy: "rollback-workspace",
      authorizationMode: "operator-approved",
      reason: "Workspace-changing attempt failed verification; rollback preview is required before retry.",
      policyReasons: ["workspace_dirty", "verification_failed"],
    };
  }
  if (input.checkerRejectedApproach) {
    return {
      strategy: "fork-from-checkpoint",
      authorizationMode: "auto",
      reason: "Checker rejected the approach; preserve old branch and fork from checkpoint.",
      policyReasons: ["checker_rejected_approach"],
    };
  }
  if ((input.artifactStatus === "needs_repair" || input.missingFields.length > 0) && input.retryCount < input.maxRetryAttempts) {
    return {
      strategy: "retry-same-agent",
      authorizationMode: "auto",
      reason: `Artifact is repairable: missing ${input.missingFields.join(", ") || "required evidence"}.`,
      policyReasons: ["artifact_needs_repair", "retry_budget_available"],
    };
  }
  if (input.retryCount >= input.maxRetryAttempts) {
    return {
      strategy: "reset-from-checkpoint",
      authorizationMode: "auto",
      reason: "Retry budget exhausted; reset from checkpoint with compact context.",
      policyReasons: ["retry_budget_exhausted"],
    };
  }
  return {
    strategy: "ask-human",
    authorizationMode: "blocked",
    reason: "No safe automatic recovery strategy matched the failure facts.",
    policyReasons: ["no_strategy_matched"],
  };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-policy.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/policy.ts tests/v2/session-recovery-policy.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: classify session recovery strategies"
```

---

### Task 7: Commit Recovery Decisions and Session Operations

**Files:**
- Create: `src/v2/session-recovery/operations.ts`
- Create: `tests/v2/session-recovery-operations.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write operation persistence tests**

Create `tests/v2/session-recovery-operations.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { createSessionCheckpoint } from "../../src/v2/session-recovery/checkpoints.ts";
import { commitRecoveryDecision, recordSessionOperation } from "../../src/v2/session-recovery/operations.ts";

test("commits recovery decision with before-recovery checkpoint", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-op"));
  const checkpoint = createSessionCheckpoint(db, {
    runId: "run-op",
    taskId: "checker",
    sessionId: "session-checker",
    kind: "before-recovery",
    createdBy: "evaluator",
    checkpointSummary: "Checker rejected missing browser evidence.",
    failureSummary: "No browser behavior evidence.",
    contextTokenEstimate: 1000,
    policy: { safeForFork: true },
  });

  const decision = commitRecoveryDecision(db, {
    runId: "run-op",
    taskId: "checker",
    source: "evaluator",
    requestedStrategy: "fork-from-checkpoint",
    selectedStrategy: "fork-from-checkpoint",
    beforeRecoveryCheckpointId: checkpoint.checkpointId,
    baseCheckpointId: checkpoint.checkpointId,
    reason: "checker rejected approach",
    evaluatorFindingRefs: ["validator-1"],
    authorization: { mode: "auto", policyReasons: ["checker_rejected_approach"] },
    tokenTelemetry: { originalContextTokenEstimate: 1000, rebuiltContextTokenEstimate: 350, estimatedSavings: 650 },
  });

  assert.equal(decision.selectedStrategy, "fork-from-checkpoint");
  assert.equal(listResources(db, { resourceType: "recovery_decision" }).length, 1);
});

test("records failed Pi session operation with fallback flag", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-pi-fallback"));
  const op = recordSessionOperation(db, {
    runId: "run-pi-fallback",
    taskId: "checker",
    type: "rewind",
    baseCheckpointId: "checkpoint-1",
    oldSessionId: "session-old",
    host: "pi",
    status: "failed",
    fallbackUsed: true,
    error: "Pi rewind unsupported",
  });
  assert.equal(op.fallbackUsed, true);
  assert.equal(listResources(db, { resourceType: "session_operation" }).length, 1);
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false }, vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false }, title: "wf", goalPrompt: "todo-web" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
```

- [ ] **Step 2: Register test**

Add:

```ts
await import("./session-recovery-operations.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-operations.test.ts
```

Expected: FAIL with missing `operations.ts`.

- [ ] **Step 4: Implement operations helper**

Create `src/v2/session-recovery/operations.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { RecoveryDecisionV1, RecoveryStrategy, SessionOperationV1 } from "./types.ts";
import { validateRecoveryDecision, validateSessionOperation } from "./types.ts";

export type CommitRecoveryDecisionInput = {
  runId: string;
  taskId: string;
  source: RecoveryDecisionV1["source"];
  requestedStrategy: RecoveryStrategy;
  selectedStrategy: RecoveryStrategy;
  beforeRecoveryCheckpointId: string;
  baseCheckpointId?: string;
  reason: string;
  evaluatorFindingRefs?: string[];
  agentSuggestion?: RecoveryDecisionV1["agentSuggestion"];
  authorization: RecoveryDecisionV1["authorization"];
  tokenTelemetry?: RecoveryDecisionV1["tokenTelemetry"];
};

export function commitRecoveryDecision(db: SouthstarDb, input: CommitRecoveryDecisionInput): RecoveryDecisionV1 {
  requireRun(db, input.runId);
  const decisionId = `recovery-${input.runId}-${input.taskId}-${randomUUID()}`;
  const decision = validateRecoveryDecision({
    schemaVersion: "southstar.recovery-decision.v1",
    decisionId,
    runId: input.runId,
    taskId: input.taskId,
    source: input.source,
    requestedStrategy: input.requestedStrategy,
    selectedStrategy: input.selectedStrategy,
    baseCheckpointId: input.baseCheckpointId,
    beforeRecoveryCheckpointId: input.beforeRecoveryCheckpointId,
    reason: input.reason,
    evaluatorFindingRefs: input.evaluatorFindingRefs ?? [],
    agentSuggestion: input.agentSuggestion,
    authorization: input.authorization,
    execution: { status: "queued" },
    tokenTelemetry: input.tokenTelemetry ?? {},
  });
  upsertRuntimeResource(db, {
    id: decisionId,
    resourceType: "recovery_decision",
    resourceKey: decisionId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "session",
    status: "queued",
    title: input.selectedStrategy,
    payload: decision,
    summary: { selectedStrategy: input.selectedStrategy, reason: input.reason, tokenTelemetry: decision.tokenTelemetry },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "recovery.decision",
    actorType: input.source,
    payload: decision,
  });
  return decision;
}

export function recordSessionOperation(db: SouthstarDb, input: Omit<SessionOperationV1, "operationId">): SessionOperationV1 {
  requireRun(db, input.runId);
  const operationId = `session-operation-${input.runId}-${input.taskId}-${randomUUID()}`;
  const operation = validateSessionOperation({ operationId, ...input });
  upsertRuntimeResource(db, {
    id: operationId,
    resourceType: "session_operation",
    resourceKey: operationId,
    runId: operation.runId,
    taskId: operation.taskId,
    sessionId: operation.newSessionId ?? operation.oldSessionId,
    scope: "session",
    status: operation.status,
    title: `${operation.type} via ${operation.host}`,
    payload: operation,
    summary: { type: operation.type, host: operation.host, fallbackUsed: operation.fallbackUsed, error: operation.error },
  });
  appendHistoryEvent(db, {
    runId: operation.runId,
    taskId: operation.taskId,
    sessionId: operation.newSessionId ?? operation.oldSessionId,
    eventType: "session.operation_recorded",
    actorType: "orchestrator",
    payload: operation,
  });
  return operation;
}

function requireRun(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select 1 from workflow_runs where id = ?").get(runId);
  if (!row) throw new Error(`unknown workflow run: ${runId}`);
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-recovery-operations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/operations.ts tests/v2/session-recovery-operations.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: record recovery decisions and operations"
```

---

### Task 8: Upgrade Session Graph Fork/Reset/Rollback to Rich Operations

**Files:**
- Modify: `src/v2/session-graph/types.ts`
- Modify: `src/v2/session-graph/sqlite-provider.ts`
- Modify: `tests/v2/session-graph.test.ts`

- [ ] **Step 1: Add test for reset superseding old active session**

Append to `tests/v2/session-graph.test.ts`:

```ts
test("reset from checkpoint records superseded session operation", () => {
  const db = openSouthstarDb(":memory:");
  insertRun(db, "run-reset");
  const graph = createSqliteSessionGraphProvider(db);
  const session = graph.createSession({ runId: "run-reset", taskId: "checker", roleRef: "checker", agentProfileRef: "software-checker-pi" });
  const checkpoint = graph.checkpoint({ sessionId: session.id, runId: "run-reset", taskId: "checker", contextPacketId: "ctx-reset", artifactRefs: [], transcriptSummary: "before reset" });
  const reset = graph.reset({ runId: "run-reset", taskId: "checker", baseCheckpointId: checkpoint.id, reason: "context rot" });
  assert.equal(reset.strategy, "reset-from-checkpoint");
  const opCount = count(db, "session_operation");
  assert.equal(opCount, 1);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/session-graph.test.ts
```

Expected before implementation: FAIL because `session_operation` is not recorded by reset.

- [ ] **Step 3: Update provider to record operations**

In `src/v2/session-graph/sqlite-provider.ts`, import:

```ts
import { recordSessionOperation } from "../session-recovery/operations.ts";
```

After fork decision persistence, add:

```ts
      recordSessionOperation(db, {
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId ?? "unknown-task",
        type: "fork",
        baseCheckpointId: input.baseCheckpointId,
        oldSessionId: checkpoint.sessionId,
        newSessionId: fork.id,
        host: "southstar-native",
        status: "succeeded",
        fallbackUsed: false,
      });
```

After reset decision persistence, add:

```ts
      recordSessionOperation(db, {
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId ?? "unknown-task",
        type: "reset",
        baseCheckpointId: input.baseCheckpointId,
        oldSessionId: checkpoint.sessionId,
        newSessionId: resetSession.id,
        host: "southstar-native",
        status: "succeeded",
        fallbackUsed: false,
      });
```

After rollback decision persistence, add:

```ts
      recordSessionOperation(db, {
        runId: input.runId,
        taskId: input.taskId ?? checkpoint.taskId ?? "unknown-task",
        type: "replay",
        baseCheckpointId: input.checkpointId,
        oldSessionId: checkpoint.sessionId,
        newSessionId: checkpoint.sessionId,
        host: "southstar-native",
        status: "succeeded",
        fallbackUsed: false,
      });
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/session-graph.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-graph/types.ts src/v2/session-graph/sqlite-provider.ts tests/v2/session-graph.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: record session graph recovery operations"
```

---

### Task 9: Upgrade Task Recovery Commands to Commit Durable Decisions

**Files:**
- Modify: `src/v2/ui-api/commands/task-commands.ts`
- Modify: `tests/v2/ui-control-plane-1to1.test.ts`

- [ ] **Step 1: Add command test for recovery decision payload**

In `tests/v2/ui-control-plane-1to1.test.ts`, extend `workflow canvas model exposes real DAG and recovery command effects` after `retryTaskCommand`:

```ts
  const recoveryRows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'recovery_decision'
  `).all(run.runId, taskId) as Array<{ payload_json: string }>;
  assert.equal(recoveryRows.length >= 1, true);
  const parsed = recoveryRows.map((row) => JSON.parse(row.payload_json));
  assert.equal(parsed.some((payload) => payload.schemaVersion === "southstar.recovery-decision.v1"), true);
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/ui-control-plane-1to1.test.ts
```

Expected: FAIL because existing task command writes a legacy `recovery_decision` payload.

- [ ] **Step 3: Update task command implementation**

In `src/v2/ui-api/commands/task-commands.ts`, import helpers:

```ts
import { createSessionCheckpoint } from "../../session-recovery/checkpoints.ts";
import { commitRecoveryDecision } from "../../session-recovery/operations.ts";
import type { RecoveryStrategy } from "../../session-recovery/types.ts";
```

Replace `recordTaskDecision` body with creation of a before-recovery checkpoint and recovery decision:

```ts
function recordTaskDecision(db: SouthstarDb, input: TaskCommand, eventType: string, status: string, title: string, next: string): SouthstarCommandResult {
  const sessionId = taskSessionId(db, input.runId, input.taskId) ?? `root-${input.runId}-${input.taskId}`;
  const checkpoint = createSessionCheckpoint(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId,
    kind: "before-recovery",
    createdBy: input.actor.type === "root-session" ? "root-session" : input.actor.type === "user" ? "operator" : "orchestrator",
    checkpointSummary: input.payload.reason ?? input.reason ?? title,
    failureSummary: input.payload.reason ?? input.reason,
    contextTokenEstimate: latestContextTokenEstimate(db, input.runId, input.taskId),
    policy: { safeForAutoRetry: status === "retry", safeForFork: status === "fork", safeForReset: status === "retry", safeForWorkspaceRollback: status === "rollback" },
  });
  const strategy = strategyForStatus(status);
  const decision = commitRecoveryDecision(db, {
    runId: input.runId,
    taskId: input.taskId,
    source: input.actor.type === "user" ? "operator" : "evaluator",
    requestedStrategy: strategy,
    selectedStrategy: strategy,
    beforeRecoveryCheckpointId: checkpoint.checkpointId,
    baseCheckpointId: checkpoint.checkpointId,
    reason: input.payload.reason ?? input.reason ?? title,
    authorization: { mode: status === "rollback" ? "operator-approved" : "auto", policyReasons: [`operator_${status}`] },
    tokenTelemetry: { originalContextTokenEstimate: checkpoint.tokenTelemetry.contextTokenEstimate },
  });
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, reason: input.payload.reason ?? "", recoveryDecisionId: decision.decisionId, checkpointId: checkpoint.checkpointId },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "queued",
    affectedRunId: input.runId,
    affectedTaskId: input.taskId,
    resourceRefs: [decision.decisionId, checkpoint.checkpointId],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: [next],
  };
}

function strategyForStatus(status: string): RecoveryStrategy {
  if (status === "retry") return "retry-same-agent";
  if (status === "fork") return "fork-from-checkpoint";
  if (status === "rollback") return "rollback-workspace";
  return "ask-human";
}

function taskSessionId(db: SouthstarDb, runId: string, taskId: string): string | undefined {
  const row = db.prepare("select root_session_id from workflow_tasks where run_id = ? and id = ?").get(runId, taskId) as { root_session_id: string | null } | undefined;
  return row?.root_session_id ?? undefined;
}

function latestContextTokenEstimate(db: SouthstarDb, runId: string, taskId: string): number {
  const row = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and task_id = ? and resource_type = 'context_packet'
    order by updated_at desc limit 1
  `).get(runId, taskId) as { payload_json: string } | undefined;
  if (!row) return 1;
  const payload = JSON.parse(row.payload_json) as { tokenEstimate?: { total?: number } };
  return typeof payload.tokenEstimate?.total === "number" ? payload.tokenEstimate.total : 1;
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-control-plane-1to1.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/ui-api/commands/task-commands.ts tests/v2/ui-control-plane-1to1.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: commit durable task recovery decisions"
```

---

### Task 10: Add Pi-native Capability Interface and Fallback Records

**Files:**
- Create: `src/v2/session-recovery/pi-capabilities.ts`
- Create: `tests/v2/pi-session-recovery.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write Pi fallback test**

Create `tests/v2/pi-session-recovery.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { attemptPiNativeRewind } from "../../src/v2/session-recovery/pi-capabilities.ts";

test("Pi-native rewind unsupported records fallback operation", async () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, run("run-pi"));
  const result = await attemptPiNativeRewind(db, {
    runId: "run-pi",
    taskId: "checker",
    oldSessionId: "pi-session-old",
    baseCheckpointId: "checkpoint-pi",
    anchor: { host: "pi", rootSessionId: "pi-session-old", rewindSupported: false },
    client: { readStatus: async () => "live" },
  });
  assert.equal(result.status, "fallback-required");
  assert.equal(result.reason, "Pi rewind capability unsupported for checkpoint anchor.");
  assert.equal(listResources(db, { resourceType: "session_operation" })[0]?.status, "failed");
});

function run(id: string) {
  return {
    id,
    status: "running",
    domain: "software",
    goalPrompt: "todo-web feature",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 0, writeRequiresApproval: false }, vaultPolicy: { leaseTtlSeconds: 0, mountMode: "ephemeral-file" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 1, minEventsPerLongTask: 1 }, steeringPolicy: { enabled: true, acceptedSignals: [] }, learningPolicy: { recordMemoryDeltas: false, recordWorkflowLearnings: false }, title: "wf", goalPrompt: "todo-web" }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  };
}
```

- [ ] **Step 2: Register test**

Add:

```ts
await import("./pi-session-recovery.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/pi-session-recovery.test.ts
```

Expected: FAIL with missing `pi-capabilities.ts`.

- [ ] **Step 4: Implement Pi capability module**

Create `src/v2/session-recovery/pi-capabilities.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { recordSessionOperation } from "./operations.ts";
import type { SessionCheckpointV1 } from "./types.ts";

export type PiRecoveryClient = {
  readStatus(sessionId: string): Promise<"live" | "missing" | "unknown">;
  rewindToCheckpoint?: (input: { sessionId: string; providerCheckpointId?: string }) => Promise<{ sessionId: string }>;
};

export type AttemptPiNativeRewindInput = {
  runId: string;
  taskId: string;
  oldSessionId: string;
  baseCheckpointId: string;
  anchor: NonNullable<SessionCheckpointV1["hostSessionAnchor"]>;
  client: PiRecoveryClient;
};

export type AttemptPiNativeRewindResult =
  | { status: "succeeded"; sessionId: string }
  | { status: "fallback-required"; reason: string };

export async function attemptPiNativeRewind(db: SouthstarDb, input: AttemptPiNativeRewindInput): Promise<AttemptPiNativeRewindResult> {
  if (input.anchor.host !== "pi") {
    return fail(db, input, "Checkpoint anchor is not a Pi session.");
  }
  if (input.anchor.rewindSupported !== true || !input.client.rewindToCheckpoint) {
    return fail(db, input, "Pi rewind capability unsupported for checkpoint anchor.");
  }
  const status = await input.client.readStatus(input.oldSessionId);
  if (status !== "live") {
    return fail(db, input, `Pi session is ${status}.`);
  }
  try {
    const result = await input.client.rewindToCheckpoint({
      sessionId: input.oldSessionId,
      providerCheckpointId: input.anchor.providerCheckpointId,
    });
    recordSessionOperation(db, {
      runId: input.runId,
      taskId: input.taskId,
      type: "rewind",
      baseCheckpointId: input.baseCheckpointId,
      oldSessionId: input.oldSessionId,
      newSessionId: result.sessionId,
      host: "pi",
      status: "succeeded",
      fallbackUsed: false,
    });
    return { status: "succeeded", sessionId: result.sessionId };
  } catch (error) {
    return fail(db, input, (error as Error).message);
  }
}

function fail(db: SouthstarDb, input: AttemptPiNativeRewindInput, reason: string): AttemptPiNativeRewindResult {
  recordSessionOperation(db, {
    runId: input.runId,
    taskId: input.taskId,
    type: "rewind",
    baseCheckpointId: input.baseCheckpointId,
    oldSessionId: input.oldSessionId,
    host: "pi",
    status: "failed",
    fallbackUsed: true,
    error: reason,
  });
  return { status: "fallback-required", reason };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/pi-session-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/session-recovery/pi-capabilities.ts tests/v2/pi-session-recovery.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: add pi native recovery fallback"
```

---

### Task 11: Expose Recovery in Read Models

**Files:**
- Modify: `src/v2/read-models/sessions-memory.ts`
- Modify: `src/v2/ui-api/page-models/sessions-memory.ts`
- Modify: `src/v2/ui-api/page-models/workflow-canvas.ts`
- Modify: `tests/v2/ui-read-models.test.ts`

- [ ] **Step 1: Add read model expectations**

In `tests/v2/ui-read-models.test.ts`, add a test:

```ts
test("sessions memory read model exposes recovery telemetry and session operations", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-recovery-rm", status: "running", domain: "software", goalPrompt: "todo-web", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  upsertRuntimeResource(db, {
    resourceType: "session_operation",
    resourceKey: "op-1",
    runId: "run-recovery-rm",
    taskId: "checker",
    sessionId: "session-new",
    scope: "session",
    status: "succeeded",
    title: "fork via southstar-native",
    payload: { operationId: "op-1", type: "fork", baseCheckpointId: "checkpoint-1", host: "southstar-native", status: "succeeded", fallbackUsed: false, runId: "run-recovery-rm", taskId: "checker" },
    summary: { fallbackUsed: false },
  });
  upsertRuntimeResource(db, {
    resourceType: "recovery_decision",
    resourceKey: "decision-1",
    runId: "run-recovery-rm",
    taskId: "checker",
    scope: "session",
    status: "queued",
    title: "fork-from-checkpoint",
    payload: { tokenTelemetry: { estimatedSavings: 500 }, selectedStrategy: "fork-from-checkpoint" },
  });
  const model = buildSessionsMemoryPageModel(db, { runId: "run-recovery-rm" });
  assert.equal(model.lineage.some((entry) => entry.type === "session_operation"), true);
  assert.equal(model.recoveryTelemetry.estimatedSavingsTotal, 500);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-models.test.ts
```

Expected: FAIL because `session_operation` and `recoveryTelemetry` are missing from the model.

- [ ] **Step 3: Update session graph resources**

In `src/v2/read-models/sessions-memory.ts`, include session operations:

```ts
    ...listResources(db, { resourceType: "session_operation" }),
```

- [ ] **Step 4: Update Sessions/Memory page model**

In `src/v2/ui-api/page-models/sessions-memory.ts`, add `session_operation` to `sessionTypes`:

```ts
  const sessionTypes = new Set(["session", "session_node", "session_checkpoint", "session_fork", "session_reset", "session_rollback", "recovery_decision", "session_operation"]);
```

Add recovery telemetry before return:

```ts
  const recoveryResources = scoped.filter((row) => row.resource_type === "recovery_decision");
  const estimatedSavingsTotal = recoveryResources.reduce((sum, row) => {
    const payload = JSON.parse(row.payload_json) as { tokenTelemetry?: { estimatedSavings?: number } };
    return sum + (typeof payload.tokenTelemetry?.estimatedSavings === "number" ? payload.tokenTelemetry.estimatedSavings : 0);
  }, 0);
```

Add to returned object:

```ts
    recoveryTelemetry: { estimatedSavingsTotal, recoveryDecisionCount: recoveryResources.length },
```

- [ ] **Step 5: Add workflow canvas recovery operation edges**

In `src/v2/ui-api/page-models/workflow-canvas.ts`, load operations:

```ts
  const sessionOperations = listResources(db, { resourceType: "session_operation" }).filter((resource) => resource.runId === input.runId);
```

Add edges:

```ts
  const operationEdges = sessionOperations.filter((resource) => resource.taskId).map((resource) => ({ id: `operation-${resource.id}`, source: resource.taskId!, target: resource.taskId!, kind: "repair-revision" as const }));
```

Include `...operationEdges` in `edges`.

- [ ] **Step 6: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-read-models.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/read-models/sessions-memory.ts src/v2/ui-api/page-models/sessions-memory.ts src/v2/ui-api/page-models/workflow-canvas.ts tests/v2/ui-read-models.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: expose session recovery read models"
```

---

### Task 12: Add Rewind Route and Session Command Semantics

**Files:**
- Modify: `src/v2/server/ui-routes.ts`
- Modify: `src/v2/ui-api/commands/session-memory-commands.ts`
- Modify: `tests/v2/ui-control-plane-1to1.test.ts`

- [ ] **Step 1: Add command unit assertions**

In `tests/v2/ui-control-plane-1to1.test.ts`, in the sessions memory command test, add:

```ts
  const rewindResult = rollbackSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-rewind-compatible", actor: { type: "user" }, payload: { checkpointId: "chk-1", reason: "rewind via compatible command path" } });
  assert.equal(rewindResult.accepted, true);
```

Add a server route contract test if this test file already has server coverage:

```ts
  const rewindResponse = await fetch(`${server.url}/api/v2/sessions/${encodeURIComponent("sess-root")}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: "cmd-rewind", actor: { type: "user" }, payload: { checkpointId: "chk-1", reason: "operator rewind" } }),
  });
  const rewindPayload = await rewindResponse.json() as { kind: string; result: { accepted: boolean } };
  assert.equal(rewindPayload.kind, "command-result");
```

- [ ] **Step 2: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/ui-control-plane-1to1.test.ts
```

Expected: FAIL for missing `/rewind` route if server assertion is added.

- [ ] **Step 3: Add rewind command function**

In `src/v2/ui-api/commands/session-memory-commands.ts`, export:

```ts
export function rewindSessionCommand(db: SouthstarDb, input: SessionCommand): SouthstarCommandResult {
  return recordSessionLineage(db, input, "session_operation", "session.rewind.requested", "queued");
}
```

In `recordSessionLineage`, when `resourceType === "session_operation"`, payload must include operation fields:

```ts
    payload: resourceType === "session_operation"
      ? { operationId: input.commandId, sessionId: input.sessionId, checkpointId, reason: input.payload.reason ?? "", type: "rewind", baseCheckpointId: checkpointId ?? "", host: "pi", status: "queued", fallbackUsed: false }
      : { sessionId: input.sessionId, checkpointId, reason: input.payload.reason ?? "" },
```

- [ ] **Step 4: Wire route**

In `src/v2/server/ui-routes.ts`, import `rewindSessionCommand` and update route regex:

```ts
const sessionCommand = url.pathname.match(/^\/api\/v2\/sessions\/([^/]+)\/(fork|reset|rollback|rewind)$/);
```

Add branch:

```ts
    if (sessionCommand[2] === "rewind") return json("command-result", rewindSessionCommand(context.db, input));
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/ui-control-plane-1to1.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/server/ui-routes.ts src/v2/ui-api/commands/session-memory-commands.ts tests/v2/ui-control-plane-1to1.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "feat: add session rewind command route"
```

---

### Task 13: Add Design Library Session Recovery Gates

**Files:**
- Modify: `src/v2/quality/design-library-gates.ts`
- Create: `tests/v2/design-library-session-recovery-gates.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write gate tests**

Create `tests/v2/design-library-session-recovery-gates.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { assertDesignLibrarySessionRecoveryGates } from "../../src/v2/quality/design-library-gates.ts";

test("Design Library session recovery gates require checkpoint decision operation and telemetry", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-dl-recovery", status: "passed", domain: "software", goalPrompt: "todo-web", workflowManifestJson: JSON.stringify({ compiledFrom: { templateVersionId: "ver-1" }, tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  upsertRuntimeResource(db, { resourceType: "session_checkpoint", resourceKey: "chk", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess", scope: "session", status: "created", payload: { kind: "before-recovery" } });
  upsertRuntimeResource(db, { resourceType: "recovery_decision", resourceKey: "rec", runId: "run-dl-recovery", taskId: "checker", scope: "session", status: "queued", payload: { selectedStrategy: "retry-same-agent", tokenTelemetry: { estimatedSavings: 100 } } });
  upsertRuntimeResource(db, { resourceType: "session_operation", resourceKey: "op", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess2", scope: "session", status: "succeeded", payload: { type: "replay", fallbackUsed: false } });
  upsertRuntimeResource(db, { resourceType: "context_packet", resourceKey: "ctx", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess2", scope: "software", status: "created", payload: { tokenEstimate: { total: 100 }, checkpointSummary: { text: "checkpoint" } } });
  upsertRuntimeResource(db, { resourceType: "task_envelope", resourceKey: "env", runId: "run-dl-recovery", taskId: "checker", sessionId: "sess2", scope: "software", status: "created", payload: { agentPrompt: "checkpoint" } });

  const gate = assertDesignLibrarySessionRecoveryGates(db, { runId: "run-dl-recovery" });
  assert.equal(gate.ok, true, gate.failures.join("\n"));
});

test("Design Library session recovery gates fail without token telemetry", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, { id: "run-dl-recovery-missing", status: "passed", domain: "software", goalPrompt: "todo-web", workflowManifestJson: JSON.stringify({ tasks: [] }), executionProjectionJson: "{}", snapshotJson: "{}", runtimeContextJson: "{}", metricsJson: "{}" });
  const gate = assertDesignLibrarySessionRecoveryGates(db, { runId: "run-dl-recovery-missing" });
  assert.equal(gate.ok, false);
  assert.equal(gate.failures.includes("missing recovery_decision with token telemetry"), true);
});
```

- [ ] **Step 2: Register test**

Add:

```ts
await import("./design-library-session-recovery-gates.test.ts");
```

- [ ] **Step 3: Run failing test**

Run:

```bash
npm run test:v2 -- tests/v2/design-library-session-recovery-gates.test.ts
```

Expected: FAIL with missing `assertDesignLibrarySessionRecoveryGates`.

- [ ] **Step 4: Implement gates**

Append to `src/v2/quality/design-library-gates.ts`:

```ts
export function assertDesignLibrarySessionRecoveryGates(
  db: SouthstarDb,
  input: { runId: string },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  const beforeRecovery = count(db, `
    select count(*) as count from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'session_checkpoint'
      and json_extract(payload_json, '$.kind') = 'before-recovery'
  `);
  if (beforeRecovery < 1) failures.push("missing before-recovery checkpoint");

  const decisionTelemetry = count(db, `
    select count(*) as count from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'recovery_decision'
      and json_extract(payload_json, '$.tokenTelemetry.estimatedSavings') is not null
  `);
  if (decisionTelemetry < 1) failures.push("missing recovery_decision with token telemetry");

  const operations = count(db, `
    select count(*) as count from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'session_operation'
  `);
  if (operations < 1) failures.push("missing session_operation");

  const recoveryContexts = count(db, `
    select count(*) as count from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'context_packet'
      and json_extract(payload_json, '$.checkpointSummary.text') is not null
  `);
  if (recoveryContexts < 1) failures.push("missing recovery context packet with checkpoint summary");

  const matchingPrompts = count(db, `
    select count(*) as count from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'task_envelope'
      and json_extract(payload_json, '$.agentPrompt') like '%checkpoint%'
  `);
  if (matchingPrompts < 1) failures.push("missing recovery task envelope prompt with checkpoint context");

  return { ok: failures.length === 0, failures };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2 -- tests/v2/design-library-session-recovery-gates.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add src/v2/quality/design-library-gates.ts tests/v2/design-library-session-recovery-gates.test.ts tests/v2/index.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "test: add design library recovery gates"
```

---

### Task 14: Extend Design Library Real E2E with Recovery Variants

**Files:**
- Modify: `tests/e2e-real/scenarios/design-library-template-real.ts`
- Modify: `tests/e2e-real/design-library-template-real.test.ts`

- [ ] **Step 1: Add scenario mode type**

In `tests/e2e-real/scenarios/design-library-template-real.ts`, add near exports:

```ts
export type DesignLibraryRecoveryMode = "none" | "compact-retry" | "fork-from-checkpoint" | "rollback-workspace";
```

Change function signature:

```ts
export async function runDesignLibraryTemplateRealScenario(
  env: RealE2EEnv,
  options: { recoveryMode?: DesignLibraryRecoveryMode } = {},
): Promise<{ runId: string; repo: string; templateVersionId: string; durationMs: number }> {
```

- [ ] **Step 2: Add recovery prompt modifier helper**

Add helper in same file:

```ts
function recoveryModeInstructions(mode: DesignLibraryRecoveryMode): string[] {
  if (mode === "compact-retry") {
    return [
      "Session recovery test mode: compact-retry.",
      "The first checker artifact must omit testResults evidence so Southstar can trigger retry-same-agent recovery. The recovered attempt must include complete commandsRun, testResults, and artifactEvidence.",
    ];
  }
  if (mode === "fork-from-checkpoint") {
    return [
      "Session recovery test mode: fork-from-checkpoint.",
      "The first implementation branch should intentionally miss due-date persistence so the checker rejects the product direction. The forked recovery branch must implement priority labels, due dates, overdue filtering, and persistence completely.",
    ];
  }
  if (mode === "rollback-workspace") {
    return [
      "Session recovery test mode: rollback-workspace.",
      "The first implementation branch should create a failing workspace mutation in src/todo-store.ts or src/app.ts so Southstar performs rollback preview/apply before a recovered attempt fixes the feature.",
    ];
  }
  return [];
}
```

- [ ] **Step 3: Inject mode instructions into issue packet**

After `const issue = todoWebFeatureIssuePacket(repo);`, add:

```ts
    const recoveryInstructions = recoveryModeInstructions(options.recoveryMode ?? "none");
    const issueWithRecovery = recoveryInstructions.length === 0
      ? issue
      : {
        ...issue,
        body: [issue.body, ...recoveryInstructions].join("\n"),
        acceptanceCriteria: [...issue.acceptanceCriteria, ...recoveryInstructions],
      };
```

Replace later uses of `issue` in design/compile/reuse inputs with `issueWithRecovery` for the run-producing path. Keep the reuse check using a clean second issue so template reuse still tests normal matching.

- [ ] **Step 4: Import and apply recovery gate**

Update import from `design-library-gates.ts`:

```ts
import { assertDesignLibraryQuantitativeGates, assertDesignLibraryRealE2EGates, assertDesignLibrarySessionRecoveryGates } from "../../../src/v2/quality/design-library-gates.ts";
```

After `assertDesignLibraryRealE2EGates`, add:

```ts
    if ((options.recoveryMode ?? "none") !== "none") {
      const recoveryGate = assertDesignLibrarySessionRecoveryGates(context.db, { runId: run.runId });
      assert.equal(recoveryGate.ok, true, recoveryGate.failures.join("\n"));
    }
```

- [ ] **Step 5: Add E2E test entries**

In `tests/e2e-real/design-library-template-real.test.ts`, add three tests after the base test:

```ts
test("Design Library real E2E recovers incomplete evidence with compact retry", async () => {
  const env = await loadRealE2EEnv();
  const result = await runDesignLibraryTemplateRealScenario(env, { recoveryMode: "compact-retry" });
  assert.match(result.runId, /^run-/);
});

test("Design Library real E2E forks from checkpoint after rejected branch", async () => {
  const env = await loadRealE2EEnv();
  const result = await runDesignLibraryTemplateRealScenario(env, { recoveryMode: "fork-from-checkpoint" });
  assert.match(result.runId, /^run-/);
});

test("Design Library real E2E rolls back workspace before recovered attempt", async () => {
  const env = await loadRealE2EEnv();
  const result = await runDesignLibraryTemplateRealScenario(env, { recoveryMode: "rollback-workspace" });
  assert.match(result.runId, /^run-/);
});
```

- [ ] **Step 6: Run scenario source guard**

Run:

```bash
npm run test:e2e:design-library-real
```

Expected: With real environment configured, tests execute through Pi/Tork. Without real environment, fail early in `loadRealE2EEnv` rather than passing through fake/mock/smoke paths.

- [ ] **Step 7: Commit**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add tests/e2e-real/scenarios/design-library-template-real.ts tests/e2e-real/design-library-template-real.test.ts
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "test: add design library recovery e2e variants"
```

---

### Task 15: Full Verification and Documentation Update

**Files:**
- Modify: `docs/manuals/2026-06-17-southstar-session-management-manual.zh-TW.md`
- Verify: all changed source/tests

- [ ] **Step 1: Update manual with final v1 semantics**

Append a new section to `docs/manuals/2026-06-17-southstar-session-management-manual.zh-TW.md`:

```md
## 9. v1 Recovery Semantics Update

Session recovery actions are now committed by Southstar, not directly by LLM output.

- LLM/agent may suggest recovery in artifacts.
- Evaluator/policy classifies failure facts.
- Southstar creates `before-recovery` checkpoints and `recovery_decision` resources.
- Recovery rebuild creates immutable `context_packet` plus matching `task_envelope.agentPrompt`.
- Pi-native rewind/fork/resume is an optimization and falls back to Southstar-native replay.
- Real Design Library E2E validates compact retry, fork-from-checkpoint, and rollback-workspace paths using the todo-web feature issue scenario.
```

- [ ] **Step 2: Run targeted v2 tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 3: Run full routine test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Run real E2E only when environment is configured**

Run when Tork/Docker/Pi harness credentials are available:

```bash
npm run test:e2e:design-library-real
```

Expected with real environment: PASS. Expected without real environment: fails during environment loading and does not report a false pass.

- [ ] **Step 5: Inspect git diff for unrelated edits**

Run:

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git status --short
```

Expected: Only files touched by this plan are staged/modified for the final commit. Pre-existing unrelated work may still appear; do not stage unrelated files.

- [ ] **Step 6: Commit manual update**

```bash
GIT_DIR=.git-local GIT_WORK_TREE=. git add docs/manuals/2026-06-17-southstar-session-management-manual.zh-TW.md
GIT_DIR=.git-local GIT_WORK_TREE=. git commit -m "docs: update session recovery manual"
```

---

## Self-Review Notes

Spec coverage mapping:

- Durable-first architecture: Tasks 1, 3, 7, 8, 9.
- Compact checkpoints: Tasks 1, 3.
- Context refresh compatibility and matching prompt: Task 4.
- Recovery context rebuild: Task 5.
- Retry/fork/reset/rollback/rewind semantics: Tasks 6, 8, 9, 10, 12.
- Pi-native optimization/fallback: Task 10.
- Token telemetry observability: Tasks 2, 5, 7, 11, 13.
- Read models: Task 11.
- Real Design Library E2E: Tasks 13, 14.
- Manual/doc update: Task 15.

Placeholder scan: no open-ended implementation steps are intentionally left for the executor. Each task includes target files, test commands, expected failures, and concrete code shapes.

Type consistency: `SessionCheckpointV1`, `RecoveryDecisionV1`, `SessionOperationV1`, `RecoveryStrategy`, `createSessionCheckpoint`, `commitRecoveryDecision`, `recordSessionOperation`, `rebuildTaskEnvelopeFromCheckpoint`, and `attemptPiNativeRewind` are introduced before use in later tasks.

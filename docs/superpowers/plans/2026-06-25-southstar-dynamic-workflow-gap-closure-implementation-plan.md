# Southstar Dynamic Workflow Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the dynamic workflow gaps across planner draft API, validator coverage, compiler/audit trace, generated proposal lifecycle, runtime ref materialization, and domain/scope handling.

**Architecture:** Keep LLM output as proposal and Southstar validator/compiler/runtime as authority. The plan proceeds in phases: first expose planner draft orchestration state through stable API DTOs, then tighten validator and compiler guarantees, then add durable proposal lifecycle, contain legacy ref compatibility, and finally thread domain/scope through the dynamic path. All behavior is developed with failing tests first; implementation execution must use subagent-driven development with spec reviewer and code quality reviewer tasks after each implementation task.

**Tech Stack:** TypeScript, Node 22, `node:test`, Postgres test harness, Southstar v2 runtime server, existing API envelope style, existing `WorkflowComposerMode`.

---

## Source Spec

- `docs/superpowers/specs/2026-06-25-southstar-dynamic-workflow-gap-closure-design.md`
- Existing dynamic workflow design: `docs/superpowers/specs/2026-06-24-southstar-llm-orchestrator-p1-design.md`
- Existing API design: `docs/superpowers/specs/2026-06-23-southstar-api-completeness-for-runtime-control-plane-design.zh.md`

## Execution Policy

Use `superpowers:subagent-driven-development` to execute this plan:

1. Dispatch a fresh implementer subagent per task.
2. Require TDD in each task: write failing tests, run them to confirm red, implement, run green.
3. Dispatch a spec compliance reviewer subagent after each task.
4. Dispatch a code quality reviewer subagent after spec approval.
5. Do not skip either reviewer task.
6. Commit after each task passes tests and both reviewers approve.

Use this Postgres test URL when required:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
```

Use `.git-local` for explicit git commands:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
```

Do not add these existing untracked files:

```text
.git.snapshots.bak/
.tmp/
tsconfig.tsbuildinfo
```

## File Structure

- Modify `src/v2/ui-api/postgres-run-api.ts`
  - Define planner draft public DTO types.
  - Add draft summary/orchestration helper functions.
  - Return rich draft and run results from existing helper functions.
  - Add approve/reject helpers.
- Modify `src/v2/server/routes.ts`
  - Add `GET /api/v2/planner/drafts/:draftId/orchestration`.
  - Add `POST /api/v2/planner/drafts/:draftId/approve`.
  - Add `POST /api/v2/planner/drafts/:draftId/reject`.
  - Add `POST /api/v2/planner/drafts/:draftId/runs`.
  - Return rich responses from existing planner/run routes.
- Modify `src/v2/server/client.ts`
  - Let `runGoal()` and `createPlannerDraft()` accept `orchestrationMode` and `composerMode`.
  - Add `getPlannerDraftOrchestration()`, `approvePlannerDraft()`, `rejectPlannerDraft()`, and `createRunFromPlannerDraft()`.
- Modify `tests/v2/postgres-run-api.test.ts`
  - Add helper-level draft summary, invalid draft, lifecycle, and run response tests.
- Modify `tests/v2/runtime-api-client-alignment.test.ts`
  - Add client method URL/body tests.
- Modify `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`
  - Add inspect endpoint checkpoint between draft creation and run materialization.
- Modify `src/v2/orchestration/composition-validator.ts`
  - Add `inputArtifactRefs` upstream satisfiability and `templateSlotRef` compatibility checks.
- Modify `src/v2/orchestration/composition-compiler.ts`
  - Freeze selected library version refs only.
  - Pass explicit scope/domain through compilation.
- Modify `src/v2/orchestration/composition-repair-loop.ts`
  - Include previous failed composition plan in repair prompt when available.
- Modify `src/v2/orchestration/llm-composer.ts`
  - Expose sanitized prompt/response hash metadata for `llmTrace`.
- Modify `src/v2/context/managed-context-assembler.ts` and `src/v2/ui-api/postgres-task-envelope.ts`
  - Remove duplicated legacy maps or route them through one explicit compatibility helper.
- Create `src/v2/orchestration/library-ref-compat.ts`
  - Own remaining legacy alias normalization as a compatibility boundary.
- Modify `src/v2/design-library/software-library-seed.ts`
  - Add template slot metadata required by validator tests.
- Create or modify proposal lifecycle route/helper tests.
  - Persist and expose `library_component_proposal` resources.

## Phase Map

| Phase | Tasks | Result |
|---|---|---|
| P0-A | Tasks 1-4 | Planner draft inspect API and rich draft/run responses |
| P0-B | Task 5 | Validator artifact-flow and template-slot coverage |
| P1-A | Task 6 | Selected-only version freeze, sanitized `llmTrace`, previous-plan repair prompt |
| P1-B | Task 7 | Generated proposal lifecycle API |
| P1-C | Task 8 | Legacy ref map containment and canonical runtime envelopes |
| P2 | Task 9 | Domain/scope threading and `software` hardcode removal |
| Verification | Task 10 | Focused tests, E2E, typecheck, final reviewers |

## Task 1: Rich Planner Draft DTO Helpers

**Files:**
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`

- [ ] **Step 1: Write failing helper tests**

Add imports near the top of `tests/v2/postgres-run-api.test.ts`:

```ts
import {
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
} from "../../src/v2/ui-api/postgres-run-api.ts";
```

If the file already imports these names from the same module, extend the existing import instead of adding a duplicate.

Add this test after the existing validated `llm-constrained` draft test:

```ts
test("planner draft create result and orchestration view expose status diagnostics and task summaries", async () => {
  const db = await createTestPostgresDb();
  try {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with orchestration inspection",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
    });

    assert.equal(draft.status, "validated");
    assert.equal(draft.canMaterialize, true);
    assert.equal(draft.planner, "library-constrained-llm");
    assert.equal(draft.orchestrationMode, "llm-constrained");
    assert.equal(draft.composerMode, "fixture");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.blockingReasons, []);
    assert.equal(draft.taskSummaries.length >= 4, true);
    assert.equal(draft.taskSummaries.every((task) => typeof task.taskId === "string" && task.taskId.length > 0), true);
    assert.equal(draft.taskSummaries.some((task) => task.selectedLibraryRefs.skillRefs.length > 0), true);

    const view = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(view.draftId, draft.draftId);
    assert.equal(view.status, "validated");
    assert.equal(view.canMaterialize, true);
    assert.equal(view.workflow?.workflowId, draft.workflowId);
    assert.equal(view.workflow?.taskCount, draft.taskSummaries.length);
    assert.equal(view.plannerTrace?.composerMode, "fixture");
    assert.equal(view.orchestrationSnapshot?.validationOk, true);
    assert.equal(view.actions.some((action) => action.action === "approve" && action.allowed), true);
    assert.equal(view.actions.some((action) => action.action === "materialize-run" && action.allowed), true);
  } finally {
    await db.close();
  }
});
```

Add this invalid draft test in the same file:

```ts
test("invalid planner draft result is inspectable and cannot materialize", async () => {
  const db = await createTestPostgresDb();
  try {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with invalid dynamic workflow",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: {
        async compose() {
          return {
            schemaVersion: "southstar.workflow_composition_plan.v1",
            title: "Invalid Plan",
            selectedWorkflowTemplateRef: "template.software-feature",
            rationale: "missing required coverage",
            tasks: [],
            rejectedCandidates: [],
            generatedComponentProposals: [],
          };
        },
      },
    });

    assert.equal(draft.status, "invalid");
    assert.equal(draft.canMaterialize, false);
    assert.equal(draft.validationIssues.length > 0, true);
    assert.equal(draft.blockingReasons.length > 0, true);
    assert.deepEqual(draft.taskSummaries, []);

    const view = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(view.status, "invalid");
    assert.equal(view.canMaterialize, false);
    assert.equal(view.actions.some((action) => action.action === "approve" && !action.allowed), true);
    assert.equal(view.actions.some((action) => action.action === "materialize-run" && !action.allowed), true);

    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not materializable/,
    );
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because `getPostgresPlannerDraftOrchestration` does not exist and `createPostgresPlannerDraft()` does not return `status`, `canMaterialize`, `validationIssues`, `blockingReasons`, or `taskSummaries`.

- [ ] **Step 3: Add DTO types and summary helpers**

In `src/v2/ui-api/postgres-run-api.ts`, replace the existing `PostgresPlannerDraftResult` and `PostgresRunResult` types with:

```ts
export type PlannerDraftStatus = "validated" | "invalid" | "approved" | "rejected" | "archived";

export type PlannerDraftTaskSummary = {
  taskId: string;
  name: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
  agentDefinitionRef?: string;
  selectedLibraryRefs: {
    instructionRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
    inputArtifactRefs: string[];
    outputArtifactRefs: string[];
    evaluatorProfileRef?: string;
  };
};

export type PlannerDraftSummary = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: PlannerDraftStatus;
  canMaterialize: boolean;
  planner: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode | string;
  validationIssues: Array<{ code: string; path: string; message: string }>;
  blockingReasons: string[];
  taskSummaries: PlannerDraftTaskSummary[];
};

export type PlannerDraftOrchestrationView = PlannerDraftSummary & {
  title?: string;
  workflow?: {
    workflowId: string;
    title: string;
    domain: string;
    intent: string;
    taskCount: number;
  };
  plannerTrace?: {
    model?: string;
    generatedAt?: string;
    analyzerType?: string;
    composerMode?: string;
    composerFallbackUsed?: boolean;
    validatorAttempts?: number;
    repairAttempts?: number;
    finalValidationOk?: boolean;
    candidatePacketHash?: string;
    compositionHash?: string;
  };
  orchestrationSnapshot?: {
    schemaVersion?: string;
    candidatePacketHash?: string;
    selectedTaskCount?: number;
    validationOk?: boolean;
    libraryVersionRefCount?: number;
  };
  repairAttempts: Array<{ attempt: number; validationOk: boolean; issueCount: number }>;
  actions: Array<{ action: "approve" | "reject" | "materialize-run"; allowed: boolean; reason?: string; endpoint?: string }>;
};

export type PostgresPlannerDraftResult = PlannerDraftSummary;

export type PlannerRunTaskSummary = {
  taskId: string;
  name: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
};

export type PostgresRunResult = {
  runId: string;
  draftId: string;
  workflowId: string;
  status: "created";
  taskIds: string[];
  taskSummaries: PlannerRunTaskSummary[];
};
```

Add this helper below `createPostgresPlannerDraft()`:

```ts
export async function getPostgresPlannerDraftOrchestration(
  db: SouthstarDb,
  input: { draftId: string },
): Promise<PlannerDraftOrchestrationView> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  return summarizePlannerDraftResource(input.draftId, draft.status, draft.title ?? undefined, draft.payload, draft.summary);
}
```

Add these private helpers near the bottom of the file before `inferIntent()`:

```ts
type PlannerDraftResourcePayload = PlanBundle & {
  requirementSpec?: unknown;
  candidatePacket?: unknown;
  unavailableRequirements?: unknown[];
  repairAttempts?: Array<{ attempt: number; validation?: { ok?: boolean; issues?: Array<{ code: string; path: string; message: string }> } }>;
  orchestrationSnapshot?: {
    schemaVersion?: string;
    candidatePacketHash?: string;
    selectedCompositionPlan?: { tasks?: unknown[] };
    validation?: { ok?: boolean; issues?: Array<{ code: string; path: string; message: string }> };
    compiler?: { libraryVersionRefs?: string[] };
  };
  lifecycle?: Record<string, unknown>;
};

function summarizePlannerDraftResource(
  draftId: string,
  resourceStatus: string,
  title: string | undefined,
  payload: unknown,
  summary: unknown,
): PlannerDraftOrchestrationView {
  const payloadRecord = isRecord(payload) ? payload as PlannerDraftResourcePayload : {};
  const summaryRecord = isRecord(summary) ? summary : {};
  const workflow = payloadRecord.workflow;
  const plannerTrace = isRecord(payloadRecord.plannerTrace) ? payloadRecord.plannerTrace : {};
  const orchestrationSnapshot = isRecord(payloadRecord.orchestrationSnapshot) ? payloadRecord.orchestrationSnapshot : undefined;
  const status = normalizeDraftStatus(resourceStatus);
  const validationIssues = collectDraftValidationIssues(payloadRecord);
  const blockingReasons = collectDraftBlockingReasons(status, payloadRecord, validationIssues, workflow);
  const workflowId = typeof summaryRecord.workflowId === "string"
    ? summaryRecord.workflowId
    : typeof workflow?.workflowId === "string"
      ? workflow.workflowId
      : draftId.replace(/^draft-/, "");
  const goalPrompt = typeof summaryRecord.goalPrompt === "string"
    ? summaryRecord.goalPrompt
    : typeof workflow?.goalPrompt === "string"
      ? workflow.goalPrompt
      : "";
  const planner = typeof summaryRecord.planner === "string"
    ? summaryRecord.planner
    : typeof plannerTrace.model === "string"
      ? plannerTrace.model
      : "unknown";
  const composerMode = typeof plannerTrace.composerMode === "string" ? plannerTrace.composerMode : undefined;
  const orchestrationMode = planner === "library-constrained-llm" ? "llm-constrained" : "deterministic";
  const taskSummaries = workflow ? summarizeWorkflowTasks(workflow, payloadRecord.orchestrationSnapshot?.selectedCompositionPlan) : [];
  const canMaterialize = (status === "validated" || status === "approved") && blockingReasons.length === 0 && Boolean(workflow);
  return {
    draftId,
    goalPrompt,
    workflowId,
    status,
    canMaterialize,
    planner,
    orchestrationMode,
    composerMode,
    validationIssues,
    blockingReasons,
    taskSummaries,
    title,
    workflow: workflow
      ? {
          workflowId: workflow.workflowId,
          title: workflow.title,
          domain: workflow.domain,
          intent: workflow.intent,
          taskCount: workflow.tasks.length,
        }
      : undefined,
    plannerTrace: summarizePlannerTrace(plannerTrace),
    orchestrationSnapshot: orchestrationSnapshot
      ? {
          schemaVersion: typeof orchestrationSnapshot.schemaVersion === "string" ? orchestrationSnapshot.schemaVersion : undefined,
          candidatePacketHash: typeof orchestrationSnapshot.candidatePacketHash === "string" ? orchestrationSnapshot.candidatePacketHash : undefined,
          selectedTaskCount: Array.isArray(orchestrationSnapshot.selectedCompositionPlan?.tasks) ? orchestrationSnapshot.selectedCompositionPlan.tasks.length : undefined,
          validationOk: orchestrationSnapshot.validation?.ok,
          libraryVersionRefCount: orchestrationSnapshot.compiler?.libraryVersionRefs?.length,
        }
      : undefined,
    repairAttempts: summarizeRepairAttempts(payloadRecord.repairAttempts),
    actions: draftActions(draftId, status, canMaterialize),
  };
}
```

Add the support helpers used above:

```ts
function normalizeDraftStatus(status: string): PlannerDraftStatus {
  if (status === "validated" || status === "invalid" || status === "approved" || status === "rejected" || status === "archived") {
    return status;
  }
  return status === "created" ? "validated" : "invalid";
}

function collectDraftValidationIssues(payload: PlannerDraftResourcePayload): Array<{ code: string; path: string; message: string }> {
  const snapshotIssues = payload.orchestrationSnapshot?.validation?.issues;
  if (Array.isArray(snapshotIssues)) return snapshotIssues.map(normalizeValidationIssue);
  const latestAttempt = Array.isArray(payload.repairAttempts) ? payload.repairAttempts.at(-1) : undefined;
  const attemptIssues = latestAttempt?.validation?.issues;
  if (Array.isArray(attemptIssues)) return attemptIssues.map(normalizeValidationIssue);
  return [];
}

function normalizeValidationIssue(issue: { code: string; path: string; message: string }): { code: string; path: string; message: string } {
  return { code: issue.code, path: issue.path, message: issue.message };
}

function collectDraftBlockingReasons(
  status: PlannerDraftStatus,
  payload: PlannerDraftResourcePayload,
  validationIssues: Array<{ code: string; path: string; message: string }>,
  workflow: SouthstarWorkflowManifest | undefined,
): string[] {
  const reasons: string[] = [];
  if (status === "invalid") reasons.push("planner draft is invalid");
  if (status === "rejected") reasons.push("planner draft is rejected");
  if (status === "archived") reasons.push("planner draft is archived");
  if (!workflow) reasons.push("planner draft has no compiled workflow");
  if (validationIssues.length > 0) reasons.push(`${validationIssues.length} validation issue(s)`);
  if (Array.isArray(payload.unavailableRequirements) && payload.unavailableRequirements.length > 0) {
    reasons.push(`${payload.unavailableRequirements.length} unavailable requirement(s)`);
  }
  return [...new Set(reasons)];
}

function summarizeWorkflowTasks(
  workflow: SouthstarWorkflowManifest,
  composition?: { tasks?: unknown[] },
): PlannerDraftTaskSummary[] {
  const compositionTasks = new Map<string, Record<string, unknown>>();
  if (Array.isArray(composition?.tasks)) {
    for (const task of composition.tasks) {
      if (isRecord(task) && typeof task.id === "string") compositionTasks.set(task.id, task);
    }
  }
  return workflow.tasks.map((task) => {
    const compositionTask = compositionTasks.get(task.id);
    return {
      taskId: task.id,
      name: task.name ?? task.id,
      dependsOn: [...task.dependsOn],
      roleRef: task.roleRef,
      agentProfileRef: task.agentProfileRef,
      agentDefinitionRef: stringFromRecord(compositionTask, "agentDefinitionRef"),
      selectedLibraryRefs: {
        instructionRefs: stringArrayFromValue(compositionTask?.instructionRefs ?? task.instructionRefs),
        skillRefs: stringArrayFromValue(compositionTask?.skillRefs ?? task.skillRefs),
        toolGrantRefs: stringArrayFromValue(compositionTask?.toolGrantRefs ?? task.toolGrantRefs),
        mcpGrantRefs: stringArrayFromValue(compositionTask?.mcpGrantRefs ?? task.mcpGrantRefs),
        vaultLeasePolicyRefs: stringArrayFromValue(compositionTask?.vaultLeasePolicyRefs ?? task.vaultLeasePolicyRefs),
        inputArtifactRefs: stringArrayFromValue(compositionTask?.inputArtifactRefs),
        outputArtifactRefs: stringArrayFromValue(compositionTask?.outputArtifactRefs ?? task.requiredArtifactRefs),
        evaluatorProfileRef: stringFromRecord(compositionTask, "evaluatorProfileRef") ?? task.evaluatorPipelineRef,
      },
    };
  });
}

function summarizePlannerTrace(value: Record<string, unknown>): PlannerDraftOrchestrationView["plannerTrace"] {
  return {
    model: stringFromRecord(value, "model"),
    generatedAt: stringFromRecord(value, "generatedAt"),
    analyzerType: stringFromRecord(value, "analyzerType"),
    composerMode: stringFromRecord(value, "composerMode"),
    composerFallbackUsed: booleanFromRecord(value, "composerFallbackUsed"),
    validatorAttempts: numberFromRecord(value, "validatorAttempts"),
    repairAttempts: numberFromRecord(value, "repairAttempts"),
    finalValidationOk: booleanFromRecord(value, "finalValidationOk"),
    candidatePacketHash: stringFromRecord(value, "candidatePacketHash"),
    compositionHash: stringFromRecord(value, "compositionHash"),
  };
}

function summarizeRepairAttempts(value: PlannerDraftResourcePayload["repairAttempts"]): PlannerDraftOrchestrationView["repairAttempts"] {
  if (!Array.isArray(value)) return [];
  return value.map((attempt) => ({
    attempt: attempt.attempt,
    validationOk: attempt.validation?.ok === true,
    issueCount: attempt.validation?.issues?.length ?? 0,
  }));
}

function draftActions(draftId: string, status: PlannerDraftStatus, canMaterialize: boolean): PlannerDraftOrchestrationView["actions"] {
  return [
    {
      action: "approve",
      allowed: status === "validated",
      reason: status === "validated" ? undefined : `approve requires validated draft, got ${status}`,
      endpoint: `/api/v2/planner/drafts/${encodeURIComponent(draftId)}/approve`,
    },
    {
      action: "reject",
      allowed: status === "validated" || status === "approved" || status === "invalid",
      reason: status === "archived" ? "archived draft cannot be rejected" : undefined,
      endpoint: `/api/v2/planner/drafts/${encodeURIComponent(draftId)}/reject`,
    },
    {
      action: "materialize-run",
      allowed: canMaterialize,
      reason: canMaterialize ? undefined : "draft cannot materialize a run",
      endpoint: `/api/v2/planner/drafts/${encodeURIComponent(draftId)}/runs`,
    },
  ];
}

function stringFromRecord(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function booleanFromRecord(record: Record<string, unknown> | undefined, field: string): boolean | undefined {
  const value = record?.[field];
  return typeof value === "boolean" ? value : undefined;
}

function numberFromRecord(record: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = record?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayFromValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Return summaries from draft creation**

In `createDeterministicPlannerDraft()`, replace the final return with:

```ts
  return getPostgresPlannerDraftOrchestration(db, { draftId });
```

In `createLibraryConstrainedPlannerDraft()`, replace every `return { draftId, goalPrompt: input.goalPrompt, workflowId... }` with:

```ts
    return getPostgresPlannerDraftOrchestration(db, { draftId });
```

Use this for invalid branches and validated branch.

- [ ] **Step 5: Make run creation use materializable status**

In `createPostgresRunFromDraft()`, replace:

```ts
  if (draft.status !== "validated") throw new Error(`planner draft is not validated: ${input.draftId}`);
```

with:

```ts
  const draftView = summarizePlannerDraftResource(input.draftId, draft.status, draft.title ?? undefined, draft.payload, draft.summary);
  if (!draftView.canMaterialize) throw new Error(`planner draft is not materializable: ${input.draftId}`);
```

Keep the existing `bundle` and `workflow` assignments after this check.

- [ ] **Step 6: Return rich run result**

At the end of `createPostgresRunFromDraft()`, replace:

```ts
  return { runId, taskIds };
```

with:

```ts
  return {
    runId,
    draftId: input.draftId,
    workflowId: workflow.workflowId,
    status: "created",
    taskIds,
    taskSummaries: workflow.tasks.map((task) => ({
      taskId: task.id,
      name: task.name ?? task.id,
      dependsOn: [...task.dependsOn],
      roleRef: task.roleRef,
      agentProfileRef: task.agentProfileRef,
    })),
  };
```

- [ ] **Step 7: Run tests and verify green**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/ui-api/postgres-run-api.ts \
  tests/v2/postgres-run-api.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: expose planner draft orchestration summaries"
```

## Task 2: Draft Inspect And Lifecycle Routes

**Files:**
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`

- [ ] **Step 1: Write failing route tests**

Append this test to `tests/v2/postgres-run-api.test.ts` near the existing server route tests:

```ts
test("planner draft orchestration route exposes inspect approve reject and draft-owned run creation", async () => {
  const db = await createTestPostgresDb();
  const server = await createTestRuntimeServer({ db });
  try {
    const create = await api<{ draftId: string; status: string; canMaterialize: boolean; taskSummaries: unknown[] }>(
      server.port,
      "/api/v2/planner/drafts",
      {
        method: "POST",
        body: JSON.stringify({
          goalPrompt: "implement calc sum through draft orchestration route",
          orchestrationMode: "llm-constrained",
          composerMode: "fixture",
        }),
      },
    );
    assert.equal(create.status, "validated");
    assert.equal(create.canMaterialize, true);
    assert.equal(create.taskSummaries.length >= 4, true);

    const inspect = await api<{ draftId: string; actions: Array<{ action: string; allowed: boolean }> }>(
      server.port,
      `/api/v2/planner/drafts/${encodeURIComponent(create.draftId)}/orchestration`,
    );
    assert.equal(inspect.draftId, create.draftId);
    assert.equal(inspect.actions.some((action) => action.action === "approve" && action.allowed), true);

    const approved = await api<{ status: string; canMaterialize: boolean }>(
      server.port,
      `/api/v2/planner/drafts/${encodeURIComponent(create.draftId)}/approve`,
      { method: "POST", body: JSON.stringify({ actorId: "operator-a", reason: "reviewed dynamic workflow" }) },
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.canMaterialize, true);

    const run = await api<{ draftId: string; workflowId: string; status: string; runId: string; taskSummaries: unknown[] }>(
      server.port,
      `/api/v2/planner/drafts/${encodeURIComponent(create.draftId)}/runs`,
      { method: "POST", body: "{}" },
    );
    assert.equal(run.draftId, create.draftId);
    assert.equal(run.status, "created");
    assert.equal(run.workflowId.length > 0, true);
    assert.equal(run.taskSummaries.length >= 4, true);
  } finally {
    await server.close();
    await db.close();
  }
});
```

Add a rejected draft route test:

```ts
test("rejected planner draft cannot create a run", async () => {
  const db = await createTestPostgresDb();
  const server = await createTestRuntimeServer({ db });
  try {
    const create = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({
        goalPrompt: "implement calc sum but reject draft",
        orchestrationMode: "llm-constrained",
        composerMode: "fixture",
      }),
    });
    const rejected = await api<{ status: string; canMaterialize: boolean }>(
      server.port,
      `/api/v2/planner/drafts/${encodeURIComponent(create.draftId)}/reject`,
      { method: "POST", body: JSON.stringify({ actorId: "operator-a", reason: "needs revision" }) },
    );
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.canMaterialize, false);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/v2/planner/drafts/${encodeURIComponent(create.draftId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.ok, false);
    const body = await response.text();
    assert.match(body, /planner draft is not materializable/);
  } finally {
    await server.close();
    await db.close();
  }
});
```

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because the inspect, approve, reject, and draft-owned run routes do not exist.

- [ ] **Step 3: Add approve/reject helpers**

In `src/v2/ui-api/postgres-run-api.ts`, add imports:

```ts
  updateRuntimeResourcePg,
```

from `../stores/postgres-runtime-store.ts` if that helper exists. If it does not exist, add a small local update query inside the helper using `db.query`.

Add these exported helpers below `getPostgresPlannerDraftOrchestration()`:

```ts
export async function approvePostgresPlannerDraft(
  db: SouthstarDb,
  input: { draftId: string; actorId?: string; reason?: string },
): Promise<PlannerDraftOrchestrationView> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  const view = summarizePlannerDraftResource(input.draftId, draft.status, draft.title ?? undefined, draft.payload, draft.summary);
  if (view.status === "approved") return view;
  if (view.status !== "validated") throw new Error(`planner draft cannot be approved from status ${view.status}: ${input.draftId}`);
  await updatePlannerDraftLifecycle(db, input.draftId, "approved", {
    approvedAt: new Date().toISOString(),
    approvedBy: input.actorId ?? "unknown",
    reason: input.reason ?? "approved",
  });
  return getPostgresPlannerDraftOrchestration(db, { draftId: input.draftId });
}

export async function rejectPostgresPlannerDraft(
  db: SouthstarDb,
  input: { draftId: string; actorId?: string; reason?: string },
): Promise<PlannerDraftOrchestrationView> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);
  const view = summarizePlannerDraftResource(input.draftId, draft.status, draft.title ?? undefined, draft.payload, draft.summary);
  if (view.status === "rejected") return view;
  if (view.status === "archived") throw new Error(`planner draft cannot be rejected from status archived: ${input.draftId}`);
  await updatePlannerDraftLifecycle(db, input.draftId, "rejected", {
    rejectedAt: new Date().toISOString(),
    rejectedBy: input.actorId ?? "unknown",
    reason: input.reason ?? "rejected",
  });
  return getPostgresPlannerDraftOrchestration(db, { draftId: input.draftId });
}

async function updatePlannerDraftLifecycle(
  db: SouthstarDb,
  draftId: string,
  status: PlannerDraftStatus,
  lifecyclePatch: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `update southstar.runtime_resources
        set status = $2,
            payload_json = jsonb_set(
              payload_json,
              '{lifecycle}',
              coalesce(payload_json->'lifecycle', '{}'::jsonb) || $3::jsonb,
              true
            ),
            updated_at = now()
      where resource_type = 'planner_draft'
        and resource_key = $1`,
    [draftId, status, JSON.stringify(lifecyclePatch)],
  );
}
```

- [ ] **Step 4: Add routes**

In `src/v2/server/routes.ts`, extend the import from `postgres-run-api.ts` to include:

```ts
  approvePostgresPlannerDraft,
  getPostgresPlannerDraftOrchestration,
  rejectPostgresPlannerDraft,
```

Add these route blocks before the existing `POST /api/v2/runs` route:

```ts
    const plannerDraftOrchestrationMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/orchestration$/);
    if (request.method === "GET" && plannerDraftOrchestrationMatch) {
      const draftId = decodeURIComponent(plannerDraftOrchestrationMatch[1]!);
      return json("planner-draft-orchestration", await getPostgresPlannerDraftOrchestration(context.db, { draftId }));
    }

    const plannerDraftApproveMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/approve$/);
    if (request.method === "POST" && plannerDraftApproveMatch) {
      const draftId = decodeURIComponent(plannerDraftApproveMatch[1]!);
      const body = await readJsonBody<{ actorId?: unknown; reason?: unknown }>(request);
      return json("planner-draft-approve", await approvePostgresPlannerDraft(context.db, {
        draftId,
        actorId: optionalString(body.actorId),
        reason: optionalString(body.reason),
      }));
    }

    const plannerDraftRejectMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/reject$/);
    if (request.method === "POST" && plannerDraftRejectMatch) {
      const draftId = decodeURIComponent(plannerDraftRejectMatch[1]!);
      const body = await readJsonBody<{ actorId?: unknown; reason?: unknown }>(request);
      return json("planner-draft-reject", await rejectPostgresPlannerDraft(context.db, {
        draftId,
        actorId: optionalString(body.actorId),
        reason: optionalString(body.reason),
      }));
    }

    const plannerDraftRunMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/runs$/);
    if (request.method === "POST" && plannerDraftRunMatch) {
      const draftId = decodeURIComponent(plannerDraftRunMatch[1]!);
      return json("run", await createPostgresRunFromDraft(context.db, { draftId }));
    }
```

- [ ] **Step 5: Run tests and verify green**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/ui-api/postgres-run-api.ts \
  src/v2/server/routes.ts \
  tests/v2/postgres-run-api.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add planner draft orchestration routes"
```

## Task 3: Runtime Client Alignment

**Files:**
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
- Modify: `src/v2/server/client.ts`

- [ ] **Step 1: Write failing client tests**

Add this test to `tests/v2/runtime-api-client-alignment.test.ts`:

```ts
test("runtime client supports planner draft orchestration lifecycle routes", async () => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const server = await createRecordingServer(calls);
  try {
    const client = createRuntimeServerClient({ baseUrl: server.baseUrl });
    await client.createPlannerDraft({
      goalPrompt: "inspect dynamic workflow",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
    });
    await client.runGoal({
      goalPrompt: "run dynamic workflow",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
    });
    await client.getPlannerDraftOrchestration("draft-wf-1");
    await client.approvePlannerDraft({ draftId: "draft-wf-1", actorId: "operator-a", reason: "reviewed" });
    await client.rejectPlannerDraft({ draftId: "draft-wf-2", actorId: "operator-a", reason: "needs revision" });
    await client.createRunFromPlannerDraft("draft-wf-1");

    assert.deepEqual(calls.map((call) => [call.method, call.path]), [
      ["POST", "/api/v2/planner/drafts"],
      ["POST", "/api/v2/run-goal"],
      ["GET", "/api/v2/planner/drafts/draft-wf-1/orchestration"],
      ["POST", "/api/v2/planner/drafts/draft-wf-1/approve"],
      ["POST", "/api/v2/planner/drafts/draft-wf-2/reject"],
      ["POST", "/api/v2/planner/drafts/draft-wf-1/runs"],
    ]);
    assert.deepEqual(calls[0]!.body, {
      goalPrompt: "inspect dynamic workflow",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
    });
    assert.deepEqual(calls[3]!.body, { actorId: "operator-a", reason: "reviewed" });
  } finally {
    await server.close();
  }
});
```

If `createRecordingServer()` does not exist in this test file, use the existing local recording helper pattern already present in the file instead of introducing a new server harness.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: FAIL because the client method signatures and new methods do not exist.

- [ ] **Step 3: Update client request types and methods**

In `src/v2/server/client.ts`, add:

```ts
type PlannerDraftRequest = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: "fixture" | "llm" | "llm-with-fixture-fallback";
};
```

Replace:

```ts
    runGoal(body: { goalPrompt: string }) {
      return post<RunGoalResult>(`${baseUrl}/api/v2/run-goal`, body);
    },
    createPlannerDraft(body: { goalPrompt: string }) {
      return post(`${baseUrl}/api/v2/planner/drafts`, body);
    },
```

with:

```ts
    runGoal(body: PlannerDraftRequest) {
      return post<RunGoalResult>(`${baseUrl}/api/v2/run-goal`, body);
    },
    createPlannerDraft(body: PlannerDraftRequest) {
      return post(`${baseUrl}/api/v2/planner/drafts`, body);
    },
    getPlannerDraftOrchestration(draftId: string) {
      return get(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/orchestration`);
    },
    approvePlannerDraft(body: { draftId: string; actorId?: string; reason?: string }) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/approve`, {
        actorId: body.actorId,
        reason: body.reason,
      });
    },
    rejectPlannerDraft(body: { draftId: string; actorId?: string; reason?: string }) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(body.draftId)}/reject`, {
        actorId: body.actorId,
        reason: body.reason,
      });
    },
    createRunFromPlannerDraft(draftId: string) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/runs`, {});
    },
```

- [ ] **Step 4: Run tests and verify green**

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/server/client.ts \
  tests/v2/runtime-api-client-alignment.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: align runtime client with planner draft routes"
```

## Task 4: Dynamic Workflow E2E Inspect Checkpoint

**Files:**
- Modify: `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`

- [ ] **Step 1: Write failing E2E checkpoint**

In `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`, after draft creation and before `POST /api/v2/runs`, add:

```ts
    const inspect = await api<{
      draftId: string;
      status: string;
      canMaterialize: boolean;
      taskSummaries: unknown[];
      plannerTrace?: { composerMode?: string };
      actions: Array<{ action: string; allowed: boolean }>;
    }>(server.port, `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/orchestration`);
    assert.equal(inspect.draftId, draft.draftId);
    assert.equal(inspect.status, "validated");
    assert.equal(inspect.canMaterialize, true);
    assert.equal(inspect.plannerTrace?.composerMode, "llm");
    assert.equal(inspect.taskSummaries.length >= 4, true);
    assert.equal(inspect.actions.some((action) => action.action === "materialize-run" && action.allowed), true);
    checkpoint("CP1", "draft orchestration inspect endpoint confirms materializable llm workflow");
```

Rename the existing later `CP1` checkpoint to `CP2`, and increment subsequent checkpoint labels by one in that file so labels remain ordered.

- [ ] **Step 2: Run the E2E case and verify red or pass**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts
```

Expected before Tasks 1-3 are merged: FAIL because the inspect endpoint does not exist. Expected after Tasks 1-3: PASS.

- [ ] **Step 3: Commit Task 4**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: inspect dynamic workflow draft in e2e"
```

## Task 5: Validator Artifact Flow And Template Slot Coverage

**Files:**
- Modify: `tests/v2/workflow-composition-validator.test.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/design-library/software-library-seed.ts`

- [ ] **Step 1: Write failing tests**

Add tests that prove:

- a task with `inputArtifactRefs: ["artifact.implementation_report"]` and no upstream producer is rejected with `input_artifact_not_satisfied`.
- a summary task depending on both verifier and code-quality reviewer can consume `artifact.verification_report`.
- an unknown `templateSlotRef` is rejected with `unknown_template_slot`.
- a task assigned to a declared slot without the slot's required capability is rejected with `template_slot_capability_mismatch`.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-validator.test.ts
```

Expected: FAIL because validator does not check artifact satisfiability or slot compatibility yet.

- [ ] **Step 3: Implement validator checks**

Implement deterministic checks only:

- Build upstream ancestor sets from `dependsOn`.
- Build available artifact set for each task from initial input refs plus upstream task outputs.
- Parse selected template slot metadata from the selected workflow template candidate state.
- Verify `templateSlotRef`, required capabilities, allowed outputs, and dependency slot rules when declared.

- [ ] **Step 4: Run validator tests and commit**

Run the same validator test command. Expected: PASS.

Commit:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/composition-validator.ts \
  src/v2/design-library/software-library-seed.ts \
  tests/v2/workflow-composition-validator.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: validate dynamic workflow artifact flow and template slots"
```

## Task 6: Compiler Audit Trace And Repair Prompt

**Files:**
- Modify: `tests/v2/workflow-composition-compiler.test.ts`
- Modify: `tests/v2/composition-repair-loop.test.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Modify: `src/v2/orchestration/composition-repair-loop.ts`
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

- compiler excludes unselected candidate `versionRef`s from `orchestrationSnapshot.compiler.libraryVersionRefs`.
- compiler includes selected template, agent, profile, instruction, skill, tool, MCP, vault, artifact, and evaluator version refs.
- repair loop second prompt includes validator issues and the previous failed composition plan when a plan exists.
- repair loop does not invent previous plan content when the prior attempt failed before producing a plan.
- persisted planner draft includes sanitized `llmTrace` with model, prompt hash, response hash or parse status, validation status, and issue codes.
- persisted planner draft does not include raw prompt or raw LLM response in `llmTrace`.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-compiler.test.ts tests/v2/composition-repair-loop.test.ts tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because selected-only freeze, previous-plan repair prompt, and `llmTrace` are not implemented.

- [ ] **Step 3: Implement compiler, repair, and trace changes**

Implement:

- selected ref collection from `WorkflowCompositionPlan` instead of full `CandidatePacket`.
- version ref lookup from candidate summaries by selected ref.
- repair prompt rendering with bounded previous plan JSON when the previous attempt produced a composition.
- `llmTrace` metadata collection without raw prompt/response storage.

- [ ] **Step 4: Run tests and commit**

Run the same command. Expected: PASS.

Commit:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/composition-compiler.ts \
  src/v2/orchestration/composition-repair-loop.ts \
  src/v2/orchestration/llm-composer.ts \
  src/v2/ui-api/postgres-run-api.ts \
  tests/v2/workflow-composition-compiler.test.ts \
  tests/v2/composition-repair-loop.test.ts \
  tests/v2/postgres-run-api.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: harden dynamic workflow audit trace and repair prompts"
```

## Task 7: Generated Proposal Lifecycle API

**Files:**
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`

- [ ] **Step 1: Write failing tests**

Add tests for:

- composition with `generatedComponentProposals` persists `library_component_proposal` resources when the draft is created.
- `GET /api/v2/planner/drafts/:draftId/proposals` returns proposal summaries.
- approve/reject proposal routes mutate proposal status only.
- converting a proposal creates a draft library object or returns a blocked response if conversion is not supported for that kind.
- selecting a generated proposal as a runtime ref remains invalid.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because proposal lifecycle helpers/routes do not exist.

- [ ] **Step 3: Implement proposal resources and routes**

Implement `library_component_proposal` runtime resource persistence and route helpers:

```text
GET  /api/v2/planner/drafts/:draftId/proposals
POST /api/v2/planner/drafts/:draftId/proposals/:proposalId/approve
POST /api/v2/planner/drafts/:draftId/proposals/:proposalId/reject
POST /api/v2/planner/drafts/:draftId/proposals/:proposalId/convert-to-library-draft
```

Do not grant runtime permission from proposal approval.

- [ ] **Step 4: Run tests and commit**

Run the same command. Expected: PASS.

Commit:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/ui-api/postgres-run-api.ts \
  src/v2/server/routes.ts \
  src/v2/server/client.ts \
  tests/v2/postgres-run-api.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add generated component proposal lifecycle"
```

## Task 8: Legacy Ref Map Containment

**Files:**
- Create: `src/v2/orchestration/library-ref-compat.ts`
- Modify: `src/v2/context/managed-context-assembler.ts`
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
- Modify: `tests/v2/managed-context-assembler.test.ts`
- Modify: `tests/v2/postgres-task-envelope.test.ts`
- Modify: `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that prove:

- both managed context assembly and fallback task envelope use the same compatibility helper.
- new dynamic workflow compiled manifests emit canonical prefixed refs.
- E2E case 29 persisted `materializedLibraryRefs` contain canonical refs and no legacy unprefixed aliases.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/managed-context-assembler.test.ts tests/v2/postgres-task-envelope.test.ts
```

Expected: FAIL because duplicate legacy maps still exist and canonical-ref assertions are missing.

- [ ] **Step 3: Extract compatibility helper**

Create `src/v2/orchestration/library-ref-compat.ts` and move the remaining legacy alias mapping there. Update both callers to use the helper. Do not normalize refs inside the strict materializer.

- [ ] **Step 4: Run tests and commit**

Run focused tests and E2E case 29. Expected: PASS.

Commit:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/library-ref-compat.ts \
  src/v2/context/managed-context-assembler.ts \
  src/v2/ui-api/postgres-task-envelope.ts \
  tests/v2/managed-context-assembler.test.ts \
  tests/v2/postgres-task-envelope.test.ts \
  tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "refactor: contain legacy library ref compatibility"
```

## Task 9: Multi-Domain Scope Threading

**Files:**
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/workflow-composition-compiler.test.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/orchestration/candidate-resolver.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`

- [ ] **Step 1: Write failing tests**

Add tests that prove:

- `createPostgresPlannerDraft({ scope: "research" })` does not silently use `software`.
- candidate resolution, validator, compiler, workflow domain, task domain, and runtime context receive the requested scope.
- unsupported scope fails with a clear unsupported-scope error.

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts tests/v2/workflow-composition-compiler.test.ts
```

Expected: FAIL because dynamic workflow path currently hardcodes `software`.

- [ ] **Step 3: Thread scope explicitly**

Add `scope?: string` to planner draft input and pass it through candidate resolution, repair validation, compiler validation, manifest domain/task domain, and runtime context. Keep `software` as default only when scope is omitted.

- [ ] **Step 4: Run tests and commit**

Run focused tests. Expected: PASS.

Commit:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/ui-api/postgres-run-api.ts \
  src/v2/orchestration/candidate-resolver.ts \
  src/v2/orchestration/composition-validator.ts \
  src/v2/orchestration/composition-compiler.ts \
  tests/v2/postgres-run-api.test.ts \
  tests/v2/workflow-composition-compiler.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: thread dynamic workflow scope"
```

## Task 10: Final Verification And Review

**Files:**
- No production file changes unless a verification failure reveals a root cause.

- [ ] **Step 1: Run focused tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Run:

```bash
node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts
```

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run broader v2 suite**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  npm run test:v2
```

Expected: PASS.

- [ ] **Step 3: Typecheck**

Run:

```bash
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Dispatch final reviewers**

Use subagent-driven development review gates:

- Spec compliance reviewer: confirm every requirement in `2026-06-25-southstar-dynamic-workflow-gap-closure-design.md` is implemented or explicitly deferred by the plan.
- Code quality reviewer: check API DTO boundaries, route ordering, error behavior, and test clarity.

- [ ] **Step 5: Commit verification fixes if needed**

If verification requires fixes, commit only those fixes:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add <changed-files>
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "fix: stabilize planner draft orchestration api"
```

## Acceptance Checklist

- [ ] P0 API: `POST /api/v2/planner/drafts` returns status, validation issues, materialization readiness, and task summaries.
- [ ] P0 API: `GET /api/v2/planner/drafts/:draftId/orchestration` returns a compact public orchestration view.
- [ ] P0 API: invalid/rejected drafts are inspectable and cannot create runs; approved drafts remain materializable.
- [ ] P0 API: `POST /api/v2/planner/drafts/:draftId/runs` works as a draft-owned run materialization route.
- [ ] P0 Validator: `inputArtifactRefs` must be satisfied by initial inputs or upstream outputs.
- [ ] P0 Validator: `templateSlotRef` must be declared and compatible with selected agent/artifacts.
- [ ] P1 Audit: compiler freezes selected library version refs only.
- [ ] P1 Trace: planner draft persists sanitized `llmTrace`.
- [ ] P1 Repair: repair prompt includes previous failed plan when available.
- [ ] P1 Proposal: generated proposals are durable resources with list/approve/reject/convert routes.
- [ ] P1 Runtime: new envelopes consume compiled canonical manifest refs; legacy aliases are contained.
- [ ] P2 Scope: dynamic workflow path accepts explicit scope/domain and does not silently fall back to `software`.
- [ ] Runtime client methods align with new and changed routes.
- [ ] Dynamic workflow E2E case 29 verifies orchestration inspection before run creation and canonical materialized refs.
- [ ] Execution used subagent-driven development, TDD, spec reviewer, and code quality reviewer gates.

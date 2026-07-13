# Southstar Staged Goal Requirement、Validation 與 Visual Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在既有 Southstar Goal Design pipeline 中加入可討論與確認的 Requirement Draft、提前完成的 validation resolution、Library candidate 自動續跑、真實 evaluator/artifact contract、Visual Requirement review，以及 criterion-level completion。

**Architecture:** 保留 Workflow chat → planner draft → Goal Design Package → resolver/composer/compiler → Postgres run → Tork/evaluator/completion gate 主路徑。新增三個深 module：Goal Requirement Draft、Goal Validation Resolver、UI Interaction Contract；其餘改動深化既有 persistence、Library graph、Composer、right viewer 與 evaluator seam，不建立第二套 planner、Library、DAG 或 runtime。

**Tech Stack:** Node.js >=22.22.2、TypeScript ESM、tsx、Node node:test、Postgres southstar schema、Next.js 16、React 19、現有 Pi LLM provider、Library file/graph sync、Tork。

## Global Constraints

- Production source of truth remains src/v2/ and web/; do not restore the retired root Next app.
- Production composition remains composerMode: "llm" and fail-closed. Do not add fixture or llm-with-fixture-fallback runtime modes.
- Do not add production seed files, fixed domain packs, canned requirements, fixed slice/task counts, fake evaluators, mock runtime evidence, smoke-only gates, or hardcoded software/flashcard behavior.
- Workflow chat remains the Goal entry. Preserve the existing message stream, Goal card, right viewer/editor, WorkflowDagBlock, AppShell and DAG canvas.
- Persist new phases and revisions in existing runtime_resources/planner_draft payloads. Do not add a new database table.
- Every blocking requirement must be user-confirmed, owned by exactly one Slice, bound to approved/versioned artifact and evaluator Library objects, and covered by an independent evaluator.
- LLM proposes semantic content only. Host code owns ids, exact schemas, allowed values, hashes, revisions, approvals, Library refs, evidence validation and final verdicts.
- Candidate generation may be automatic after Requirement Confirm; candidate approval/import is always explicit.
- Goal-scoped UI Interaction Contracts are runtime/planner resources, never Library files.
- Use focused inline boundary doubles in new tests. Do not add shared fixture modules or depend on tests/v2/fixtures for the new acceptance path.
- Do not run live/E2E/Tork/host tests during routine tasks. Run the final browser E2E only when the user explicitly authorizes it after focused and build gates pass.

---

## File Structure

### New runtime files

- src/v2/orchestration/goal-requirement-draft.ts — rich Requirement Draft types, strict LLM parsing, revisions, validation, hashing and projection to GoalContractV1.
- src/v2/orchestration/goal-validation-resolver.ts — Library coverage preview, approved artifact/evaluator resolution, version-pinned bindings and structured gaps.
- src/v2/orchestration/ui-interaction-contract.ts — goal-scoped screen/layout/state/flow contract, strict patching, validation and hashing.
- tests/v2/goal-requirement-draft.test.ts — Requirement interpretation, confirmation and revision invariants.
- tests/v2/goal-validation-resolver.test.ts — approved graph resolution, partial/missing coverage and binding invariants.
- tests/v2/ui-interaction-contract.test.ts — screen/state/action/criterion validation and revision tests.
- web/components/GoalRequirementListBlock.tsx — Requirement review message block and stage confirmation.
- web/components/GoalRequirementEditor.tsx — existing sidecar-hosted structured Requirement editor.
- web/components/UiInteractionContractViewer.tsx — safe structured low-fidelity renderer and element inspector.
- web/app/api/workflow/planner-drafts/[draftId]/goal-requirements/[requirementId]/route.ts — thin Requirement patch proxy.
- web/app/api/workflow/planner-drafts/[draftId]/confirm-requirements/route.ts — thin Requirement confirmation proxy.
- web/app/api/workflow/planner-drafts/[draftId]/ui-contracts/[contractId]/route.ts — thin visual contract patch proxy.

### Existing runtime files to deepen

- src/v2/orchestration/goal-contract.ts
- src/v2/orchestration/goal-design.ts
- src/v2/orchestration/goal-design-draft-service.ts
- src/v2/orchestration/run-goal-service.ts
- src/v2/orchestration/candidate-resolver.ts
- src/v2/orchestration/composition-validator.ts
- src/v2/orchestration/composition-compiler.ts
- src/v2/orchestration/goal-requirement-coverage.ts
- src/v2/design-library/importers/library-candidate-extractor.ts
- src/v2/design-library/importers/library-llm-import-analyzer.ts
- src/v2/design-library/importers/library-import-draft-store.ts
- src/v2/design-library/files/library-file-parser.ts
- src/v2/design-library/files/library-file-store.ts
- src/v2/design-library/runtime-types.ts
- src/v2/server/planner-routes.ts
- src/v2/server/library-routes.ts
- src/v2/server/client.ts
- src/v2/ui-api/postgres-run-api.ts
- src/v2/context/managed-context-assembler.ts
- src/v2/agent-runner/task-envelope.ts
- src/v2/evaluators/requirement-evaluator-results.ts
- src/v2/evaluators/completion-gate.ts
- src/v2/read-models/workflow-ui.ts

### Existing web files to deepen

- web/lib/types.ts
- web/lib/workflow/types.ts
- web/lib/workflow/generate-stream.ts
- web/hooks/useAgentSession.ts
- web/components/MessageView.tsx
- web/components/GoalSlicePlanBlock.tsx
- web/components/GoalSliceEditor.tsx
- web/components/AppShell.tsx
- tests/web/southstar-workflow-canvas-ui.test.tsx

---

### Task 1: Goal Requirement Draft Domain Module

**Files:**
- Create: src/v2/orchestration/goal-requirement-draft.ts
- Create: tests/v2/goal-requirement-draft.test.ts
- Modify: src/v2/orchestration/goal-contract.ts
- Modify: tests/v2/index.test.ts

**Interfaces:**
- Consumes: GoalContractV1, finalizeGoalContract(), contentHashForPayload().
- Produces: GoalRequirementDraftV1, GoalRequirementDraftIssue, finalizeGoalRequirementDraft(), reviseGoalRequirementDraft(), validateGoalRequirementDraft(), goalRequirementDraftHash(), confirmGoalRequirementDraft().

- [ ] **Step 1: Write the failing domain tests**

~~~ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmGoalRequirementDraft,
  finalizeGoalRequirementDraft,
  reviseGoalRequirementDraft,
  validateGoalRequirementDraft,
} from '../../src/v2/orchestration/goal-requirement-draft.ts';

test('Requirement Draft preserves host ids and projects confirmed criteria to GoalContractV1', () => {
  const draft = finalizeGoalRequirementDraft({
    goalPrompt: 'Create an offline article',
    cwd: '/workspace/article',
    summary: 'Create an offline article',
    requirements: [{
      title: 'Offline delivery',
      statement: 'The article opens without a network',
      source: 'explicit',
      blocking: true,
      userVisibleBehaviors: ['Reader opens the article locally'],
      businessRules: ['No network dependency'],
      acceptanceCriteria: [{
        statement: 'article.html opens while the network is disabled',
        evidenceIntent: ['browser interaction', 'screenshot'],
      }],
      expectedOutcomeArtifacts: [{ description: 'Offline HTML', mediaType: 'text/html' }],
      verificationIntent: ['Open the file with network disabled'],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
    }],
    nonGoals: [],
    blockingInputs: [],
  });

  assert.match(draft.requirements[0]!.id, /^req-/);
  assert.match(draft.requirements[0]!.acceptanceCriteria[0]!.id, /^criterion-/);
  const confirmed = confirmGoalRequirementDraft(draft, {
    domain: 'design/article',
    intent: 'create_offline_article',
    workType: 'general',
    expectedArtifactRefs: [],
    requiredCapabilities: [],
    assumptions: [],
    requestedSideEffects: ['workspace-write'],
  });
  assert.deepEqual(confirmed.requirements[0]!.acceptanceCriteria, [
    'article.html opens while the network is disabled',
  ]);
});

test('Requirement revision preserves ids for edits and creates lineage for split requirements', () => {
  const first = validDraft();
  const edited = reviseGoalRequirementDraft(first, {
    kind: 'update',
    requirementId: first.requirements[0]!.id,
    patch: { statement: 'The revised observable outcome' },
  });
  assert.equal(edited.requirements[0]!.id, first.requirements[0]!.id);
  assert.equal(edited.parentRevision, first.revision);
  assert.notEqual(edited.draftHash, first.draftHash);
});

test('blocking requirements reject empty criteria and unresolved questions', () => {
  const issues = validateGoalRequirementDraft(validDraft({
    acceptanceCriteria: [],
    openQuestions: ['Which output is required?'],
  }));
  assert.deepEqual(new Set(issues.map((issue) => issue.code)), new Set([
    'blocking_requirement_missing_criteria',
    'blocking_requirement_has_open_question',
  ]));
});
~~~

- [ ] **Step 2: Run the focused test and verify red**

Run: npx tsx tests/v2/goal-requirement-draft.test.ts

Expected: FAIL with ERR_MODULE_NOT_FOUND for goal-requirement-draft.ts.

- [ ] **Step 3: Add the strict draft types, host finalizer and revision operations**

~~~ts
export type GoalAcceptanceCriterionDraftV1 = {
  id: string;
  statement: string;
  evidenceIntent: string[];
};

export type GoalRequirementDraftItemV1 = {
  id: string;
  title: string;
  statement: string;
  source: 'explicit' | 'inferred';
  blocking: boolean;
  userVisibleBehaviors: string[];
  businessRules: string[];
  acceptanceCriteria: GoalAcceptanceCriterionDraftV1[];
  expectedOutcomeArtifacts: Array<{ description: string; mediaType?: string }>;
  verificationIntent: string[];
  assumptions: string[];
  openQuestions: string[];
  riskTags: string[];
  interactionContractRefs: string[];
  status: 'needs_clarification' | 'ready' | 'confirmed' | 'superseded';
};

export type GoalRequirementDraftV1 = {
  schemaVersion: 'southstar.goal_requirement_draft.v1';
  revision: number;
  parentRevision?: number;
  originalPrompt: string;
  workspace: { cwd: string; projectRef?: string };
  summary: string;
  requirements: GoalRequirementDraftItemV1[];
  nonGoals: string[];
  blockingInputs: string[];
  draftHash: string;
};

export function goalRequirementDraftHash(
  draft: Omit<GoalRequirementDraftV1, 'draftHash'>,
): string {
  return contentHashForPayload(draft);
}

export function confirmGoalRequirementDraft(
  draft: GoalRequirementDraftV1,
  interpretation: {
    domain: string;
    intent: string;
    workType: GoalContractV1['workType'];
    expectedArtifactRefs: string[];
    requiredCapabilities: string[];
    assumptions: string[];
    requestedSideEffects: string[];
  },
): GoalContractV1 {
  const issues = validateGoalRequirementDraft(draft);
  if (issues.length > 0) {
    throw new Error('goal_requirement_draft_invalid: ' + JSON.stringify(issues));
  }
  return finalizeGoalContract({
    goalPrompt: draft.originalPrompt,
    cwd: draft.workspace.cwd,
    interpretation: {
      ...interpretation,
      summary: draft.summary,
      requirements: draft.requirements
        .filter((requirement) => requirement.status !== 'superseded')
        .map((requirement) => ({
          statement: requirement.statement,
          acceptanceCriteria: requirement.acceptanceCriteria.map((criterion) => criterion.statement),
          blocking: requirement.blocking,
          source: requirement.source,
          expectedArtifacts: requirement.expectedOutcomeArtifacts,
        })),
      nonGoals: draft.nonGoals,
      blockingInputs: draft.blockingInputs,
      riskTags: [...new Set(draft.requirements.flatMap((requirement) => requirement.riskTags))],
    },
  });
}
~~~

Implement finalizeGoalRequirementDraft() so it assigns req- and criterion- ids from contentHashForPayload(), derives status from openQuestions, inserts revision 1, and rejects duplicate semantic ids. Implement reviseGoalRequirementDraft() as an exhaustive update | create | supersede | restore | split | merge switch that preserves parentRevision and recomputes the canonical hash.

- [ ] **Step 4: Run focused domain tests**

Run: npx tsx tests/v2/goal-requirement-draft.test.ts && npx tsx tests/v2/goal-contract.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/v2/orchestration/goal-requirement-draft.ts src/v2/orchestration/goal-contract.ts tests/v2/goal-requirement-draft.test.ts tests/v2/index.test.ts
git commit -m "feat: add versioned goal requirement drafts"
~~~

---

### Task 2: LLM Requirement Interpretation and Revision

**Files:**
- Modify: src/v2/orchestration/goal-requirement-draft.ts
- Modify: src/v2/orchestration/goal-contract.ts
- Modify: src/v2/server/runtime-context.ts
- Test: tests/v2/goal-requirement-draft.test.ts

**Interfaces:**
- Consumes: LlmTextClient, ResolvedGoalDesignSkillV1, WorkspaceGoalDiscoveryV1.
- Produces: GoalRequirementDraftInterpreter, createLlmGoalRequirementDraftInterpreter().

- [ ] **Step 1: Add failing strict-output tests**

~~~ts
test('LLM Requirement interpreter returns rich requirements without Library refs or Slices', async () => {
  const prompts: string[] = [];
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: 'inline-requirement-test',
    client: {
      async generateText({ prompt }) {
        prompts.push(prompt);
        return JSON.stringify({
          summary: 'Create an offline article',
          requirements: [{
            title: 'Offline delivery',
            statement: 'The article opens without a network',
            source: 'explicit',
            blocking: true,
            userVisibleBehaviors: ['Open locally'],
            businessRules: ['No network'],
            acceptanceCriteria: [{
              statement: 'article.html opens with network disabled',
              evidenceIntent: ['browser interaction'],
            }],
            expectedOutcomeArtifacts: [{ description: 'Offline HTML', mediaType: 'text/html' }],
            verificationIntent: ['Open in a browser'],
            assumptions: [],
            openQuestions: [],
            riskTags: [],
            interactionContractRefs: [],
          }],
          nonGoals: [],
          blockingInputs: [],
        });
      },
    },
  });
  const draft = await interpreter.interpret({
    goalPrompt: 'Create an offline article',
    cwd: '/workspace/article',
    workspaceDiscovery: discovery('/workspace/article'),
    goalDesignSkill: skill(),
  });
  assert.equal(draft.revision, 1);
  assert.doesNotMatch(prompts[0]!, /evaluatorContracts|slicePlan|agentDefinitionRef/);
});

test('LLM revision cannot supply host ids, hashes or status', async () => {
  const interpreter = createLlmGoalRequirementDraftInterpreter({
    model: 'inline-invalid-revision',
    client: { async generateText() {
      return JSON.stringify({ kind: 'revision', requirementId: 'req-invented', draftHash: 'bad' });
    } },
  });
  await assert.rejects(
    () => interpreter.revise({ currentDraft: validDraft(), message: 'change it' }),
    /invalid Goal Requirement revision/,
  );
});
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: npx tsx tests/v2/goal-requirement-draft.test.ts

Expected: FAIL because createLlmGoalRequirementDraftInterpreter is missing.

- [ ] **Step 3: Implement strict interpreter and one repair attempt**

~~~ts
export type GoalRequirementDraftInterpreter = {
  interpret(input: {
    goalPrompt: string;
    cwd: string;
    projectRef?: string;
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    goalDesignSkill: ResolvedGoalDesignSkillV1;
    onDelta?: (text: string) => void;
  }): Promise<GoalRequirementDraftV1>;
  revise(input: {
    currentDraft: GoalRequirementDraftV1;
    message: string;
    selectedRequirementId?: string;
  }): Promise<
    | { kind: 'revision'; draft: GoalRequirementDraftV1; summary: string }
    | { kind: 'needs_input'; question: string }
  >;
};
~~~

Build the prompt from the approved Goal Design skill plus bounded workspace discovery. Require exact JSON keys shown in Task 1, prohibit Library refs/Slices/DAG fields, parse once plus one repair prompt, and pass semantic output through finalizeGoalRequirementDraft()/reviseGoalRequirementDraft(). Do not accept ids, revision, parentRevision, status or hashes from LLM output.

- [ ] **Step 4: Wire the runtime context to provide this interpreter**

Add goalRequirementInterpreter beside the existing goalInterpreter/goalDesigner dependencies. Keep the old GoalContractInterpreter adapter for legacy draft routes until Task 6 removes its use from the Goal Design entry.

- [ ] **Step 5: Run focused tests**

Run: npx tsx tests/v2/goal-requirement-draft.test.ts && npx tsx tests/v2/goal-design.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/goal-requirement-draft.ts src/v2/orchestration/goal-contract.ts src/v2/server/runtime-context.ts tests/v2/goal-requirement-draft.test.ts
git commit -m "feat: interpret goal requirements before slice design"
~~~

---

### Task 3: Persisted Requirement Review Phases and Routes

**Files:**
- Modify: src/v2/orchestration/goal-design-draft-service.ts
- Modify: src/v2/orchestration/run-goal-service.ts
- Modify: src/v2/server/planner-routes.ts
- Modify: src/v2/server/client.ts
- Modify: tests/v2/postgres-run-api.test.ts
- Modify: tests/v2/run-goal-service.test.ts

**Interfaces:**
- Consumes: GoalRequirementDraftInterpreter, persistPlannerDraftResource(), upsertRuntimeResourcePg().
- Produces: persistGoalRequirementDraftRevisionPg(), loadCurrentGoalRequirementDraftPg(), reviseGoalRequirementPg(), confirmGoalRequirementsPg(), GoalDesignPhase.

- [ ] **Step 1: Add failing Postgres phase and idempotency tests**

~~~ts
test('Goal submission persists requirements_review before Slice design', async () => {
  await withDb(async (db) => {
    const result = await preparePostgresGoalRequirementDraft(db, {
      goalPrompt: 'Create an offline article',
      cwd: '/workspace/article',
      mode: 'review_before_compose',
      templatePolicy: { mode: 'auto' },
      requirementInterpreter: fixedRequirementInterpreter(validDraft()),
    });
    assert.equal(result.status, 'requirements_review');
    const stored = await getResourceByKeyPg(db, 'planner_draft', result.draftId);
    assert.equal((stored!.payload as any).goalDesignPhase, 'requirements_review');
    assert.equal((stored!.payload as any).goalRequirementDraft.revision, 1);
    assert.equal((stored!.payload as any).goalDesignPackage, undefined);
  });
});

test('Requirement confirmation is hash-bound and idempotent', async () => {
  await withDb(async (db) => {
    const draft = await createRequirementReviewDraft(db);
    const first = await confirmGoalRequirementsPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
    });
    const replay = await confirmGoalRequirementsPg(db, {
      draftId: draft.draftId,
      expectedDraftHash: draft.goalRequirementDraftHash,
    });
    assert.equal(first.goalContractHash, replay.goalContractHash);
    assert.equal(first.status, 'validation_resolving');
  });
});

test('editing a confirmed requirement stales bindings, slices and unmaterialized DAG drafts', async () => {
  await withDb(async (db) => {
    const ready = await createValidationReadyDraft(db);
    const revised = await reviseGoalRequirementPg(db, {
      draftId: ready.draftId,
      expectedDraftHash: ready.goalRequirementDraftHash,
      requirementId: ready.requirementId,
      patch: { statement: 'Changed observable outcome' },
    });
    assert.equal(revised.status, 'requirements_review');
    assert.equal(revised.invalidated.validationBindings, true);
    assert.equal(revised.invalidated.slicePlan, true);
  });
});
~~~

- [ ] **Step 2: Run the focused Postgres tests and verify red**

Run: npx tsx tests/v2/postgres-run-api.test.ts

Expected: FAIL because the Requirement phase functions are missing.

- [ ] **Step 3: Add append-only revisions and phase transitions**

~~~ts
export type GoalDesignPhase =
  | 'requirements_review'
  | 'requirements_confirmed'
  | 'validation_resolving'
  | 'library_review'
  | 'validation_ready'
  | 'slice_review'
  | 'ready_to_compose'
  | 'composing'
  | 'dag_validated';

export async function persistGoalRequirementDraftRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; draft: GoalRequirementDraftV1 },
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    resourceType: 'goal_requirement_draft_revision',
    resourceKey: input.draftId + ':revision:' + input.draft.revision,
    scope: 'planner',
    status: 'persisted',
    title: 'Goal Requirement Draft revision ' + input.draft.revision,
    payload: input.draft,
    summary: { draftHash: input.draft.draftHash, revision: input.draft.revision },
  });
}
~~~

Use SELECT ... FOR UPDATE and expected hash checks for edit/confirm. On confirmation, persist the canonical GoalContractV1/hash and phase validation_resolving; do not call GoalDesigner or Composer. On upstream edits, mark derived goal_design_package_revision/planner drafts stale with an explicit staleReason.

- [ ] **Step 4: Add thin HTTP routes**

Add:

- PATCH /api/v2/planner/drafts/:draftId/goal-requirements/:requirementId
- POST /api/v2/planner/drafts/:draftId/confirm-requirements

Parse exact patch keys, expectedDraftHash and actor. Return 409 for stale hashes, 422 for invalid Requirement drafts, and 404 for missing drafts.

- [ ] **Step 5: Run service and route tests**

Run: npx tsx tests/v2/postgres-run-api.test.ts && npx tsx tests/v2/run-goal-service.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/goal-design-draft-service.ts src/v2/orchestration/run-goal-service.ts src/v2/server/planner-routes.ts src/v2/server/client.ts tests/v2/postgres-run-api.test.ts tests/v2/run-goal-service.test.ts
git commit -m "feat: add requirement review and confirmation phases"
~~~

---

### Task 4: Requirement List Message Block and Sidecar Editor

**Files:**
- Create: web/components/GoalRequirementListBlock.tsx
- Create: web/components/GoalRequirementEditor.tsx
- Create: web/app/api/workflow/planner-drafts/[draftId]/goal-requirements/[requirementId]/route.ts
- Create: web/app/api/workflow/planner-drafts/[draftId]/confirm-requirements/route.ts
- Modify: web/lib/types.ts
- Modify: web/lib/workflow/types.ts
- Modify: web/lib/workflow/generate-stream.ts
- Modify: web/hooks/useAgentSession.ts
- Modify: web/components/MessageView.tsx
- Modify: web/components/AppShell.tsx
- Test: tests/web/southstar-workflow-canvas-ui.test.tsx

**Interfaces:**
- Consumes: GoalRequirementDraftV1 read model, GoalDesignPhase, Requirement patch/confirm routes.
- Produces: GoalRequirementsContent, GoalRequirementSelection, onGoalRequirementSelect(), onConfirmRequirements().

- [ ] **Step 1: Add failing rendered interaction tests**

~~~tsx
test('Requirement block renders coverage state and opens the existing sidecar editor', async () => {
  const root = await renderWorkflowHarness({
    content: [{
      type: 'goalRequirements',
      draftId: 'draft-goal-1',
      status: 'requirements_review',
      goalRequirementDraftHash: 'hash-1',
      draft: requirementDraftView(),
      coveragePreview: [{
        requirementId: 'req-review',
        status: 'missing',
        missingKinds: ['evaluator'],
      }],
    }],
  });
  assert.match(root.textContent ?? '', /Review flow/);
  assert.match(root.textContent ?? '', /Evaluator missing/);
  click('[data-testid="goal-requirement-item-req-review"]');
  assert.ok(document.querySelector('[data-testid="goal-requirement-editor"]'));
});

test('Requirement confirm posts the displayed draft hash and does not compose a DAG', async () => {
  const calls = installFetchRecorder({
    '/confirm-requirements': { status: 'validation_resolving' },
  });
  await renderWorkflowHarness({ content: [goalRequirementsBlock()] });
  click('[data-testid="goal-requirements-confirm"]');
  assert.deepEqual(JSON.parse(calls[0]!.body), { expectedDraftHash: 'hash-1' });
  assert.equal(calls.some((call) => call.url.includes('confirm-goal-design')), false);
});
~~~

- [ ] **Step 2: Run the web UI tests and verify red**

Run: npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx

Expected: FAIL because goalRequirements content and components do not exist.

- [ ] **Step 3: Add typed content and the compact Requirement block**

~~~ts
export interface GoalRequirementsContent {
  type: 'goalRequirements';
  draftId: string;
  status: string;
  goalRequirementDraftHash: string;
  draft: unknown;
  coveragePreview?: unknown[];
}

export type GoalRequirementSelection = {
  draftId: string;
  expectedDraftHash: string;
  requirementId: string;
  draft: unknown;
};
~~~

GoalRequirementListBlock must display explicit/inferred, blocking, AC count, clarification status, coverage ready/partial/missing/manual and visual review status. The Confirm button is enabled only from the host-projected confirmable flag; the browser must not recompute contract validity.

- [ ] **Step 4: Add the sidecar editor and thin proxies**

GoalRequirementEditor edits statement, behaviors, business rules, criteria/evidence intent, artifacts, verification intent, questions and visual refs. Save sends one structured patch plus expectedDraftHash. Preserve AppShell selection/viewer state and do not add a page, modal workbench or second layout.

- [ ] **Step 5: Make Workflow chat phase-aware**

When the active draft phase is requirements_review, send the normal revise stream with draftId, expectedDraftHash and selectedRequirementId. Handle goal_requirements SSE events by replacing the message block; do not append readiness diagnostics as session-list text.

- [ ] **Step 6: Run UI tests and production build**

Run: npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx && npm --prefix web run build

Expected: PASS.

- [ ] **Step 7: Commit**

~~~bash
git add web/components/GoalRequirementListBlock.tsx web/components/GoalRequirementEditor.tsx web/app/api/workflow/planner-drafts/[draftId]/goal-requirements/[requirementId]/route.ts web/app/api/workflow/planner-drafts/[draftId]/confirm-requirements/route.ts web/lib/types.ts web/lib/workflow/types.ts web/lib/workflow/generate-stream.ts web/hooks/useAgentSession.ts web/components/MessageView.tsx web/components/AppShell.tsx tests/web/southstar-workflow-canvas-ui.test.tsx
git commit -m "feat: review goal requirements in workflow chat"
~~~

---

### Task 5: Approved Library Validation Resolver

**Files:**
- Create: src/v2/orchestration/goal-validation-resolver.ts
- Create: tests/v2/goal-validation-resolver.test.ts
- Modify: src/v2/orchestration/candidate-resolver.ts
- Modify: src/v2/design-library/types.ts
- Modify: tests/v2/index.test.ts

**Interfaces:**
- Consumes: GoalContractV1, GoalRequirementDraftV1, approved library_objects/library_edges, injected GoalValidationCandidateRanker.
- Produces: RequirementCoveragePreviewV1, RequirementValidationBindingV1, GoalValidationGapV1, resolveGoalValidationPg().

- [ ] **Step 1: Add failing graph resolution tests**

~~~ts
test('resolver binds only approved artifact and evaluator versions', async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, 'artifact.article-html', 'artifact.article-html@1');
    await approvedEvaluator(db, 'evaluator.offline-browser', 'evaluator.offline-browser@2');
    await validatesArtifactEdge(db, 'evaluator.offline-browser', 'artifact.article-html');
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: 'artifact.article-html',
        evaluatorRef: 'evaluator.offline-browser',
        verificationMode: 'browser_interaction',
        procedureRef: 'procedure.offline-open',
      }),
    });
    assert.equal(result.gaps.length, 0);
    assert.equal(result.bindings[0]!.artifactContractVersionRefs[0], 'artifact.article-html@1');
    assert.equal(result.bindings[0]!.evaluatorProfileVersionRef, 'evaluator.offline-browser@2');
    assert.deepEqual(result.bindings[0]!.acceptanceCriteria, confirmedContract().requirements[0]!.acceptanceCriteria);
  });
});

test('resolver reports a structured gap instead of selecting draft or invented refs', async () => {
  await withDb(async (db) => {
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: 'artifact.missing',
        evaluatorRef: 'evaluator.missing',
        verificationMode: 'deterministic',
        procedureRef: 'procedure.missing',
      }),
    });
    assert.deepEqual(result.bindings, []);
    assert.deepEqual(result.gaps.map((gap) => gap.kind).sort(), ['artifact', 'evaluator']);
  });
});
~~~

- [ ] **Step 2: Run the resolver tests and verify red**

Run: npx tsx tests/v2/goal-validation-resolver.test.ts

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement types and the approved-graph filter**

~~~ts
export type RequirementValidationBindingV1 = {
  schemaVersion: 'southstar.requirement_validation_binding.v1';
  id: string;
  requirementId: string;
  criterionIds: string[];
  acceptanceCriteria: string[];
  artifactContractRefs: string[];
  artifactContractVersionRefs: string[];
  evaluatorProfileRef: string;
  evaluatorProfileVersionRef: string;
  verificationMode: 'deterministic' | 'browser_interaction' | 'semantic_review' | 'human_approval';
  criterionChecks: Array<{
    criterionId: string;
    procedureRef: string;
    expectedEvidenceKinds: string[];
  }>;
  requiredEvidenceKinds: string[];
  independence: 'independent';
  failureClassifications: string[];
};

export type GoalValidationResolutionV1 = {
  schemaVersion: 'southstar.goal_validation_resolution.v1';
  goalContractHash: string;
  requirementDraftHash: string;
  previews: RequirementCoveragePreviewV1[];
  bindings: RequirementValidationBindingV1[];
  gaps: GoalValidationGapV1[];
  resolutionHash: string;
};
~~~

The ranker may return semantic recommendations, but resolveGoalValidationPg() must load each object, require status approved, require headVersionId, require artifact_contract/evaluator_profile kinds, verify validates_artifact/validates edges and verify procedure/evidence compatibility from object state before constructing a binding.

- [ ] **Step 4: Add invariant validation**

Reject duplicate bindings, unknown requirement/criterion ids, criteria drift, missing versions, unsupported procedure refs, artifact/evaluator graph mismatch and non-independent bindings. Preview can be partial; final resolution for blocking requirements cannot.

- [ ] **Step 5: Run focused resolver and candidate tests**

Run: npx tsx tests/v2/goal-validation-resolver.test.ts && npx tsx tests/v2/library-candidate-resolver.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/goal-validation-resolver.ts src/v2/orchestration/candidate-resolver.ts src/v2/design-library/types.ts tests/v2/goal-validation-resolver.test.ts tests/v2/index.test.ts
git commit -m "feat: resolve requirement validation before composition"
~~~

---

### Task 6: Validation Persistence, Automatic Import Draft and Resume

**Files:**
- Modify: src/v2/orchestration/goal-design-draft-service.ts
- Modify: src/v2/design-library/importers/library-import-draft-store.ts
- Modify: src/v2/server/library-routes.ts
- Modify: src/v2/server/planner-routes.ts
- Modify: tests/v2/postgres-run-api.test.ts
- Modify: tests/v2/library-import-drafts.test.ts

**Interfaces:**
- Consumes: resolveGoalValidationPg(), createLibraryImportDraft(), installLibraryImportCandidates().
- Produces: persistGoalValidationResolutionPg(), resumeGoalValidationAfterLibraryImportPg(), originGoalDraftId metadata.

- [ ] **Step 1: Add failing lifecycle tests**

~~~ts
test('confirmed requirements with gaps automatically create one linked import draft', async () => {
  await withDb(async (db) => {
    const goal = await createConfirmedRequirementDraft(db);
    const result = await resolveAndPersistGoalValidationPg(db, {
      draftId: goal.draftId,
      expectedGoalContractHash: goal.goalContractHash,
      resolver: missingEvaluatorResolver(),
      libraryImportLlmProvider: candidateProvider(),
    });
    assert.equal(result.status, 'library_review');
    assert.ok(result.libraryImportDraftId);
    const importDraft = await getResourceByKeyPg(db, 'library_import_draft', result.libraryImportDraftId!);
    assert.equal((importDraft!.payload as any).originGoalDraftId, goal.draftId);
  });
});

test('candidate install resumes the same Goal and reaches validation_ready', async () => {
  await withDb(async (db) => {
    const waiting = await createGoalWaitingForEvaluator(db);
    await installLinkedCandidatesAndResume(db, waiting);
    const stored = await getResourceByKeyPg(db, 'planner_draft', waiting.goalDraftId);
    assert.equal((stored!.payload as any).goalDesignPhase, 'validation_ready');
    assert.equal((stored!.payload as any).goalValidationResolution.gaps.length, 0);
  });
});
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: npx tsx tests/v2/postgres-run-api.test.ts && npx tsx tests/v2/library-import-drafts.test.ts

Expected: FAIL because origin/resume behavior is missing.

- [ ] **Step 3: Persist resolution and create a gap-only import draft**

Store goal_validation_resolution_revision resources keyed by draftId and resolution hash. When gaps exist, call createLibraryImportDraft() with only confirmed gap descriptors, criterion intent and bounded existing candidates. Add originGoalDraftId/originGoalContractHash to the import draft host payload; do not ask LLM to echo these fields.

- [ ] **Step 4: Resume from the Library route after committed reconcile**

After installLibraryImportCandidates() returns successfully, library-routes.ts loads originGoalDraftId and calls resumeGoalValidationAfterLibraryImportPg(). This route-level orchestration keeps design-library independent of orchestration. Emit goal_validation_resumed in the response/SSE; if resume fails after a committed import, return installed=true plus a recoverable resume error and leave the Goal in library_review.

- [ ] **Step 5: Run lifecycle tests**

Run: npx tsx tests/v2/postgres-run-api.test.ts && npx tsx tests/v2/library-import-drafts.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/goal-design-draft-service.ts src/v2/design-library/importers/library-import-draft-store.ts src/v2/server/library-routes.ts src/v2/server/planner-routes.ts tests/v2/postgres-run-api.test.ts tests/v2/library-import-drafts.test.ts
git commit -m "feat: resume goal validation after library import"
~~~

---

### Task 7: Real Artifact Contract and Evaluator Profile Authoring

**Files:**
- Modify: src/v2/design-library/importers/library-candidate-extractor.ts
- Modify: src/v2/design-library/importers/library-llm-import-analyzer.ts
- Modify: src/v2/design-library/importers/library-import-draft-store.ts
- Modify: src/v2/design-library/files/library-file-parser.ts
- Modify: src/v2/design-library/files/library-file-store.ts
- Modify: src/v2/design-library/runtime-types.ts
- Modify: tests/v2/library-file-parser.test.ts
- Modify: tests/v2/library-import-drafts.test.ts
- Modify: tests/v2/library-file-store.test.ts

**Interfaces:**
- Consumes: existing artifact/evaluator YAML file kinds.
- Produces: strict artifact validationRules/schemaRef/provenanceRequirements and evaluator verificationProcedures/resultSchemaRef/independencePolicy fields.

- [ ] **Step 1: Add failing parser and import-schema tests**

~~~ts
test('artifact contract requires real content and provenance rules', () => {
  const parsed = parseLibraryFileContent({
    path: 'library/artifacts/article-html.artifact.yaml',
    content: [
      'schemaVersion: southstar.library.artifact_contract_file.v1',
      'id: artifact.article-html',
      'title: Article HTML',
      'scope: design/article',
      'status: approved',
      'artifactType: article-html',
      'mediaTypes:',
      '  - text/html',
      'requiredFields:',
      '  - content',
      'validationRules:',
      '  - rule.offline-self-contained',
      'evidenceKinds:',
      '  - screenshot',
      'provenanceRequirements:',
      '  - workspace-artifact',
    ].join('\\n'),
  });
  assert.equal(parsed.ok, true);
});

test('evaluator profile requires executable procedures and a result schema', () => {
  const parsed = parseLibraryFileContent({
    path: 'library/evaluators/offline-browser.evaluator.yaml',
    content: validEvaluatorYaml({
      verificationProcedures: [{
        id: 'procedure.offline-open',
        checkKind: 'browser_interaction',
        instruction: 'Open the artifact with network disabled and record the result.',
        allowedEvidenceKinds: ['screenshot', 'test-result'],
      }],
      resultSchemaRef: 'southstar.requirement_evaluator_result.v2',
      independencePolicy: 'independent',
    }),
  });
  assert.equal(parsed.ok, true);
});
~~~

- [ ] **Step 2: Run parser/import tests and verify red**

Run: npx tsx tests/v2/library-file-parser.test.ts && npx tsx tests/v2/library-import-drafts.test.ts

Expected: FAIL because the new vocabulary fields are not parsed/rendered/validated.

- [ ] **Step 3: Extend candidate and YAML schemas**

Add exact candidate fields:

~~~ts
type ArtifactImportFields = {
  artifactType: string;
  mediaTypes: string[];
  requiredFields: string[];
  validationRules: string[];
  evidenceKinds: EvidenceKind[];
  provenanceRequirements: string[];
};

type EvaluatorImportFields = {
  validatesArtifactRefs: string[];
  verificationModes: VerificationMode[];
  requiredInputs: string[];
  verificationProcedures: Array<{
    id: string;
    checkKind: VerificationMode;
    instruction: string;
    allowedEvidenceKinds: EvidenceKind[];
  }>;
  evidenceKinds: EvidenceKind[];
  resultSchemaRef: 'southstar.requirement_evaluator_result.v2';
  independencePolicy: 'independent';
  failureClassifications: string[];
};
~~~

The LLM import prompt must enumerate allowed verificationMode/evidenceKind values, require exact fields, forbid status/schema/path/version, preserve source provenance and instruct the model to propose reusable applicability rather than copy goal-specific AC into the profile.

- [ ] **Step 4: Validate references and graph projections**

Parser rejects missing/duplicate procedure ids, unsupported modes/evidence, non-independent profiles and evaluator artifact refs without artifact. Store projects validatesArtifactRefs to validates_artifact edges and preserves structured profile state in library_objects.

- [ ] **Step 5: Run Library tests**

Run: npx tsx tests/v2/library-file-parser.test.ts && npx tsx tests/v2/library-file-store.test.ts && npx tsx tests/v2/library-import-drafts.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/design-library/importers src/v2/design-library/files src/v2/design-library/runtime-types.ts tests/v2/library-file-parser.test.ts tests/v2/library-file-store.test.ts tests/v2/library-import-drafts.test.ts
git commit -m "feat: make artifact and evaluator contracts executable"
~~~

---

### Task 8: Slice Design from Confirmed Bindings and Package V2

**Files:**
- Modify: src/v2/orchestration/goal-design.ts
- Modify: src/v2/orchestration/goal-design-draft-service.ts
- Modify: src/v2/orchestration/composer.ts
- Modify: src/v2/orchestration/llm-composer.ts
- Modify: src/v2/orchestration/composition-validator.ts
- Modify: tests/v2/goal-design.test.ts
- Modify: tests/v2/workflow-composition-validator.test.ts

**Interfaces:**
- Consumes: GoalContractV1, GoalRequirementDraftV1, RequirementValidationBindingV1[].
- Produces: GoalDesignPackageV2, GoalSliceDesigner, designGoalSlicesWithLlm(), validateGoalDesignPackageV2().

- [ ] **Step 1: Add failing package and prompt tests**

~~~ts
test('Slice designer receives confirmed bindings and cannot invent requirements or criteria', async () => {
  const prompts: string[] = [];
  const pkg = await designGoalSlicesWithLlm({
    goalContract: confirmedContract(),
    requirementDraft: confirmedRequirementDraft(),
    validationBindings: [resolvedBinding()],
    workspaceDiscovery: discovery('/workspace/article'),
    mode: 'review_before_compose',
    templatePolicy: { mode: 'auto' },
    skill: goalDesignSkill(),
    client: inlineSliceClient(prompts),
    model: 'inline-slice-test',
  });
  assert.match(prompts[0]!, /ValidationBindings/);
  assert.doesNotMatch(prompts[0]!, /create evaluatorContracts/i);
  assert.equal(pkg.schemaVersion, 'southstar.goal_design_package.v2');
  assert.equal(pkg.validationBindings[0]!.evaluatorProfileRef, 'evaluator.offline-browser');
});

test('Package V2 rejects unresolved bindings and Slice-owned invented criteria', () => {
  const issues = validateGoalDesignPackageV2(packageV2({
    validationBindings: [],
  }));
  assert.ok(issues.some((issue) => issue.code === 'requirement_missing_validation_binding'));
});
~~~

- [ ] **Step 2: Run Goal Design tests and verify red**

Run: npx tsx tests/v2/goal-design.test.ts

Expected: FAIL because Package V2 and slice-only designer are missing.

- [ ] **Step 3: Add Package V2 without a parallel planner**

~~~ts
export type GoalDesignPackageV2 = {
  schemaVersion: 'southstar.goal_design_package.v2';
  revision: number;
  parentRevision?: number;
  goalContract: GoalContractV1;
  requirementDraftHash: string;
  validationBindings: RequirementValidationBindingV1[];
  slicePlan: GoalSlicePlanV1;
  compositionStrategy: CompositionStrategyV1;
  templatePolicy: WorkflowTemplatePolicyV1;
  goalContractHash: string;
  validationBindingsHash: string;
  slicePlanHash: string;
  packageHash: string;
  goalDesignSkillRef: string;
  goalDesignSkillVersionRef: string;
  workspaceDiscoveryHash: string;
  mode: GoalDesignMode;
};
~~~

Keep legacy V1 drafts readable for inspection but require regeneration before composition. Replace the LLM output schema with slicePlan + compositionStrategy only. Host inserts the confirmed contract/bindings/hashes.

- [ ] **Step 4: Strengthen validators and Composer preconditions**

Validate one owner Slice per blocking requirement, exact requirement ids, binding completeness, criteria equality, approved/versioned refs, artifact flow and acyclic dependencies. llm-composer.ts receives the frozen V2 package and must select evaluatorProfileRef from each binding; it cannot invent or replace it.

- [ ] **Step 5: Run Goal Design and composition validation tests**

Run: npx tsx tests/v2/goal-design.test.ts && npx tsx tests/v2/workflow-composition-validator.test.ts && npx tsx tests/v2/llm-workflow-composer.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/goal-design.ts src/v2/orchestration/goal-design-draft-service.ts src/v2/orchestration/composer.ts src/v2/orchestration/llm-composer.ts src/v2/orchestration/composition-validator.ts tests/v2/goal-design.test.ts tests/v2/workflow-composition-validator.test.ts tests/v2/llm-workflow-composer.test.ts
git commit -m "feat: design slices from resolved validation bindings"
~~~

---

### Task 9: Compile Real Artifact/Evaluator Contracts and Freeze Coverage

**Files:**
- Modify: src/v2/orchestration/composition-compiler.ts
- Modify: src/v2/orchestration/goal-requirement-coverage.ts
- Modify: src/v2/ui-api/postgres-run-api.ts
- Modify: src/v2/manifests/types.ts
- Modify: tests/v2/workflow-composition-compiler.test.ts
- Modify: tests/v2/postgres-run-api.test.ts

**Interfaces:**
- Consumes: GoalDesignPackageV2 bindings and approved Library object states.
- Produces: manifest ArtifactContract/EvaluatorPipelineDefinition from Library state, frozen criterion coverage and version refs.

- [ ] **Step 1: Add failing compiler tests**

~~~ts
test('compiler uses Library artifact fields instead of the summary placeholder', async () => {
  const compiled = await compileWithResolvedBinding(db, {
    artifactState: {
      artifactType: 'article-html',
      requiredFields: ['content'],
      validationRules: ['rule.offline-self-contained'],
      evidenceKinds: ['screenshot'],
      provenanceRequirements: ['workspace-artifact'],
    },
  });
  assert.deepEqual(compiled.workflow.artifactContracts[0]!.requiredFields, ['content']);
  assert.notDeepEqual(compiled.workflow.artifactContracts[0]!.requiredFields, ['summary']);
});

test('coverage freezes criterion ids and evaluator profile versions', async () => {
  const compiled = await compileWithResolvedBinding(db);
  const entry = compiled.goalRequirementCoverage.entries[0]!;
  assert.deepEqual(entry.criterionIds, ['criterion-offline']);
  assert.deepEqual(entry.evaluatorProfileVersionRefs, ['evaluator.offline-browser@2']);
});
~~~

- [ ] **Step 2: Run compiler tests and verify red**

Run: npx tsx tests/v2/workflow-composition-compiler.test.ts

Expected: FAIL because manifest/coverage do not expose criterion/version fields.

- [ ] **Step 3: Replace placeholder compilation**

Make compileGoalDesignArtifactContracts() async and load each binding artifact object by ref. Require approved status and exact pinned headVersionId. Map requiredFields, validationRules, evidenceKinds and provenanceRequirements into ArtifactContract. Build evaluator pipelines from the selected profile procedure and binding criterionChecks.

- [ ] **Step 4: Freeze criterion-aware coverage**

Extend coverage entries with criterionIds, acceptanceCriteria, evaluatorProfileVersionRefs and validationBindingId. createPostgresRunFromDraft() persists the same frozen resource and verifies package/coverage/manifest hashes before run creation.

- [ ] **Step 5: Run compiler and run materialization tests**

Run: npx tsx tests/v2/workflow-composition-compiler.test.ts && npx tsx tests/v2/postgres-run-api.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/composition-compiler.ts src/v2/orchestration/goal-requirement-coverage.ts src/v2/ui-api/postgres-run-api.ts src/v2/manifests/types.ts tests/v2/workflow-composition-compiler.test.ts tests/v2/postgres-run-api.test.ts
git commit -m "feat: compile frozen validation contracts from library"
~~~

---

### Task 10: UI Interaction Contract Domain and Persistence

**Files:**
- Create: src/v2/orchestration/ui-interaction-contract.ts
- Create: tests/v2/ui-interaction-contract.test.ts
- Modify: src/v2/orchestration/goal-design-draft-service.ts
- Modify: src/v2/server/planner-routes.ts
- Modify: tests/v2/postgres-run-api.test.ts
- Modify: tests/v2/index.test.ts

**Interfaces:**
- Consumes: GoalRequirementDraftV1 criterion ids and revision persistence.
- Produces: UiInteractionContractV1, finalizeUiInteractionContract(), reviseUiInteractionContract(), validateUiInteractionContract(), persistUiInteractionContractRevisionPg().

- [ ] **Step 1: Add failing visual contract tests**

~~~ts
test('UI contract binds required states and actions to real criteria', () => {
  const contract = finalizeUiInteractionContract({
    requirementIds: ['req-review'],
    screens: [{
      id: 'screen-review',
      title: 'Review',
      purpose: 'Review one card',
      layout: { regions: [{ id: 'region-main', role: 'main', position: 'center', childRefs: ['element-reveal'] }] },
      elements: [{
        id: 'element-reveal',
        type: 'button',
        label: 'Reveal answer',
        visibleInStates: ['question'],
        enabledInStates: ['question'],
      }],
      states: ['loading', 'empty', 'question', 'answer', 'error'],
      actions: [{
        id: 'action-reveal',
        triggerElementId: 'element-reveal',
        fromState: 'question',
        toState: 'answer',
        expectedEffect: 'Show the answer',
      }],
      responsiveRules: ['main action remains visible at 375px'],
      accessibilityRules: ['reveal action has button role'],
    }],
    flows: [{ id: 'flow-review', steps: ['action-reveal'], successOutcome: 'Answer is visible' }],
    criterionBindings: [{
      criterionId: 'criterion-reveal',
      screenIds: ['screen-review'],
      elementIds: ['element-reveal'],
      actionIds: ['action-reveal'],
    }],
  }, knownRequirementDraft());
  assert.equal(validateUiInteractionContract(contract, knownRequirementDraft()).length, 0);
});

test('UI contract rejects unknown elements, states, actions and criteria', () => {
  const issues = validateUiInteractionContract(invalidUiContract(), knownRequirementDraft());
  assert.ok(issues.some((issue) => issue.code === 'unknown_criterion'));
  assert.ok(issues.some((issue) => issue.code === 'unknown_action_element'));
  assert.ok(issues.some((issue) => issue.code === 'unknown_transition_state'));
});
~~~

- [ ] **Step 2: Run focused tests and verify red**

Run: npx tsx tests/v2/ui-interaction-contract.test.ts

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement strict contract, patching and hash**

Implement the UiInteractionContractV1 shape from the approved spec. Host owns id/revision/hash. Validate unique screen/region/element/action/flow ids, region child refs, state transitions, flow steps, requirement ids and criterion bindings. reviseUiInteractionContract() accepts exact structured patches and preserves lineage.

- [ ] **Step 4: Persist revisions and routes**

Persist ui_interaction_contract_revision resources keyed by draftId:contractId:revision. Add PATCH /api/v2/planner/drafts/:draftId/ui-contracts/:contractId with expectedContractHash. Requirement Confirm is blocked when a required visual contract lacks a valid confirmed hash.

- [ ] **Step 5: Run visual and Postgres tests**

Run: npx tsx tests/v2/ui-interaction-contract.test.ts && npx tsx tests/v2/postgres-run-api.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/orchestration/ui-interaction-contract.ts src/v2/orchestration/goal-design-draft-service.ts src/v2/server/planner-routes.ts tests/v2/ui-interaction-contract.test.ts tests/v2/postgres-run-api.test.ts tests/v2/index.test.ts
git commit -m "feat: add versioned ui interaction contracts"
~~~

---

### Task 11: Structured Visual Preview, Editing and Worker Context

**Files:**
- Create: web/components/UiInteractionContractViewer.tsx
- Create: web/app/api/workflow/planner-drafts/[draftId]/ui-contracts/[contractId]/route.ts
- Modify: web/components/GoalRequirementEditor.tsx
- Modify: web/components/AppShell.tsx
- Modify: web/lib/types.ts
- Modify: src/v2/context/managed-context-assembler.ts
- Modify: src/v2/agent-runner/task-envelope.ts
- Modify: tests/web/southstar-workflow-canvas-ui.test.tsx
- Modify: tests/v2/managed-context-assembler.test.ts

**Interfaces:**
- Consumes: UiInteractionContractV1 read model and patch route.
- Produces: safe screen/state/viewport preview, element selection patches and prior/context delivery to producer/evaluator tasks.

- [ ] **Step 1: Add failing UI and context tests**

~~~tsx
test('visual requirement opens the existing right viewer with screen and state controls', async () => {
  await renderRequirementWithUiContract(uiContractView());
  click('[data-testid="goal-requirement-open-ui-contract"]');
  assert.ok(document.querySelector('[data-testid="ui-interaction-contract-viewer"]'));
  assert.match(document.body.textContent ?? '', /screen-review/);
  click('[data-testid="ui-state-answer"]');
  assert.equal(document.querySelector('[data-element-id="element-reveal"]'), null);
});
~~~

~~~ts
test('managed context supplies the frozen UI contract only to owning producer and evaluator tasks', async () => {
  const packet = await assembleContextForUiRequirement();
  assert.equal(packet.uiInteractionContracts.length, 1);
  assert.equal(packet.uiInteractionContracts[0]!.contractHash, 'ui-hash-1');
});
~~~

- [ ] **Step 2: Run UI/context tests and verify red**

Run: npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx && npx tsx tests/v2/managed-context-assembler.test.ts

Expected: FAIL because viewer/context fields are missing.

- [ ] **Step 3: Implement a safe structured renderer**

Render only known region/element types from the contract; never inject LLM HTML, CSS or script. Provide screen, state and desktop/mobile selectors; element inspector edits label, visibleInStates, enabledInStates and action linkage through the structured patch route. Keep the viewer inside existing AppShell sidecar and provide expand-to-large-view without a new page shell.

- [ ] **Step 4: Deliver frozen contracts to tasks**

Resolve UI contract refs from the Goal Design package/resource, include only contracts linked to task requirementIds, and render a UI Interaction Contracts section in TaskEnvelope. Include contract hash, screens, states, actions, flows and criterion bindings; do not include unrelated drafts.

- [ ] **Step 5: Run UI, context and web build gates**

Run: npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx && npx tsx tests/v2/managed-context-assembler.test.ts && npm --prefix web run build

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add web/components/UiInteractionContractViewer.tsx web/components/GoalRequirementEditor.tsx web/components/AppShell.tsx web/app/api/workflow/planner-drafts/[draftId]/ui-contracts/[contractId]/route.ts web/lib/types.ts src/v2/context/managed-context-assembler.ts src/v2/agent-runner/task-envelope.ts tests/web/southstar-workflow-canvas-ui.test.tsx tests/v2/managed-context-assembler.test.ts
git commit -m "feat: review visual requirements in the existing sidecar"
~~~

---

### Task 12: Criterion-Level Evaluator Results and Completion

**Files:**
- Modify: src/v2/evaluators/requirement-evaluator-results.ts
- Modify: src/v2/evaluators/completion-gate.ts
- Modify: src/v2/artifacts/evidence.ts
- Modify: src/v2/agent-runner/task-envelope.ts
- Modify: tests/v2/postgres-tork-callback.test.ts
- Modify: tests/v2/completion-gate.test.ts
- Modify: tests/v2/completion-gate-exceptions.test.ts

**Interfaces:**
- Consumes: frozen criterion coverage, evaluator output artifact, accepted producer refs.
- Produces: RequirementEvaluatorResultV2 and host-computed requirement/Goal verdict.

- [ ] **Step 1: Add failing criterion/evidence tests**

~~~ts
test('evaluator result passes only when every frozen criterion has valid evidence', async () => {
  const result = await recordRequirementEvaluatorResultsPg(db, {
    ...evaluatorCallback(),
    artifact: {
      acceptedArtifacts: ['artifact-ref-producer'],
      criteriaResults: [{
        criterionId: 'criterion-offline',
        verdict: 'passed',
        evidenceRefs: ['screenshot:offline'],
        findings: [],
      }],
      screenshots: [{ ref: 'screenshot:offline', status: 'valid' }],
    },
  });
  assert.equal(result.ok, true);
});

test('LLM overall passed cannot hide a missing or failed criterion', async () => {
  const result = await recordRequirementEvaluatorResultsPg(db, {
    ...evaluatorCallback(),
    artifact: {
      verdict: 'passed',
      criteriaResults: [],
      acceptedArtifacts: ['artifact-ref-producer'],
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.findings.join('\\n'), /missing criterion result/);
});
~~~

- [ ] **Step 2: Run callback/completion tests and verify red**

Run: npx tsx tests/v2/postgres-tork-callback.test.ts && npx tsx tests/v2/completion-gate.test.ts

Expected: FAIL because V2 criteriaResults are not validated.

- [ ] **Step 3: Parse and validate RequirementEvaluatorResultV2**

Require exact criterion ids from frozen coverage, exact evaluator profile ref/version, accepted producer artifacts, independent evaluator task and valid evidence refs/kinds. Compute each criterion verdict from callback status plus evidence validity. Compute overall verdict as blocked when required input/evidence is missing, failed when any blocking criterion fails, and passed only when all blocking criteria pass.

- [ ] **Step 4: Deepen the existing completion gate**

Keep existing requirement_evaluator_result resources and completion gate query path. Accept V1 only for legacy frozen coverage; new Package V2 runs require V2 results. Completion checks every blocking criterion, profile version, accepted artifact and evaluator task identity.

- [ ] **Step 5: Run evaluator gates**

Run: npx tsx tests/v2/postgres-tork-callback.test.ts && npx tsx tests/v2/completion-gate.test.ts && npx tsx tests/v2/completion-gate-exceptions.test.ts

Expected: PASS.

- [ ] **Step 6: Commit**

~~~bash
git add src/v2/evaluators/requirement-evaluator-results.ts src/v2/evaluators/completion-gate.ts src/v2/artifacts/evidence.ts src/v2/agent-runner/task-envelope.ts tests/v2/postgres-tork-callback.test.ts tests/v2/completion-gate.test.ts tests/v2/completion-gate-exceptions.test.ts
git commit -m "feat: gate completion on criterion evidence"
~~~

---

### Task 13: End-to-End Focused Integration and Regression Gates

**Files:**
- Modify: tests/v2/postgres-run-api.test.ts
- Modify: tests/v2/workflow-ui-read-model.test.ts
- Modify: tests/web/southstar-workflow-canvas-ui.test.tsx
- Modify: tests/v2/index.test.ts

**Interfaces:**
- Consumes: all Tasks 1–12 public interfaces.
- Produces: one no-gap Goal flow, one auto-candidate/resume flow, one visual Goal flow and preserved legacy inspection coverage.

- [ ] **Step 1: Add a focused cross-module Goal lifecycle test**

~~~ts
test('Requirement review through validated DAG has no late candidate gap', async () => {
  await withDb(async (db) => {
    await seedApprovedValidationObjectsInline(db);
    const submitted = await submitGoalForRequirementReview(db);
    const confirmed = await confirmRequirements(db, submitted);
    assert.equal(confirmed.status, 'validation_ready');
    const sliced = await designAndConfirmSlices(db, confirmed);
    const composed = await composeValidatedDraft(db, sliced);
    assert.equal(composed.status, 'validated');
    assert.deepEqual(composed.validationIssues, []);
    assert.equal(composed.goalRequirementCoverage.entries[0]!.criterionIds.length > 0, true);
  });
});
~~~

Use inline graph object/edge setup in this test file; do not import deterministic composer or software graph fixtures. Inject an inline WorkflowComposer at the interface only, and assert the production validators/compiler reject unresolved refs.

- [ ] **Step 2: Add read-model/UI state assertions**

Assert Requirement review, Library review, Slice review and ready-to-compose are projected from persisted resources; browser blocks confirmation on stale hashes and renders visual contract selection in the existing sidecar.

- [ ] **Step 3: Run all focused tests**

Run:

~~~bash
npx tsx tests/v2/goal-requirement-draft.test.ts
npx tsx tests/v2/goal-validation-resolver.test.ts
npx tsx tests/v2/ui-interaction-contract.test.ts
npx tsx tests/v2/goal-design.test.ts
npx tsx tests/v2/postgres-run-api.test.ts
npx tsx tests/v2/workflow-composition-validator.test.ts
npx tsx tests/v2/workflow-composition-compiler.test.ts
npx tsx tests/v2/postgres-tork-callback.test.ts
npx tsx tests/v2/completion-gate.test.ts
npx tsx tests/v2/workflow-ui-read-model.test.ts
npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
~~~

Expected: all PASS.

- [ ] **Step 4: Run broad local gates**

Run:

~~~bash
npm run test:v2
npm --prefix web run build
~~~

Expected: both exit 0. Do not run real browser/live/Tork tests in this step.

- [ ] **Step 5: Inspect production hardcode and placeholder regressions**

Run:

~~~bash
rg -n 'fixture|mock|fake|smoke|flashcard|software_feature|\\[\"summary\"\\]' src/v2/orchestration src/v2/evaluators src/v2/design-library web/components
~~~

Expected: no new runtime fallback, domain-specific Goal behavior or fixed artifact summary placeholder introduced by this plan. Existing unrelated strings must be reviewed, not mechanically deleted.

- [ ] **Step 6: Commit**

~~~bash
git add tests/v2/postgres-run-api.test.ts tests/v2/workflow-ui-read-model.test.ts tests/web/southstar-workflow-canvas-ui.test.tsx tests/v2/index.test.ts
git commit -m "test: cover staged goal validation lifecycle"
~~~

---

## Execution Order and Review Gates

Execute Tasks 1–13 in order. Tasks 1–3 establish canonical Requirement truth; Task 4 exposes it in the existing UI; Tasks 5–7 make Library validation real; Tasks 8–9 freeze it into composition; Tasks 10–11 add visual contracts; Task 12 closes runtime truth; Task 13 is the broad regression gate.

After every task:

1. run the exact focused tests;
2. inspect git diff --check and git status --short;
3. review that only listed files changed;
4. commit the independently testable result;
5. do not continue on a red gate.

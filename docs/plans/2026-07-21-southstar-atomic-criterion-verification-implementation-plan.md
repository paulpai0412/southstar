# Atomic Criterion Verification Implementation Plan

> **Execution:** Inline, dependency ordered, test-first. Finish with one reviewed issue #4 commit.

**Goal:** Make atomic Criterion bindings, evidence, evaluator results, and blocking state the canonical completion authority in Goal Design V3.

**Architecture:** Replace the uncommitted Requirement Validation Binding V2 shape with V3. Keep one Requirement aggregate whose children each own one Criterion and its pinned artifact, evaluator, mode, and procedure. Reuse the existing resolver, compiler, stale invalidation, coverage read model, and UI.

**Tech Stack:** Node 22, TypeScript, Postgres, `node:test`, React 19, Next.js 16.

## Global constraints

- Accept only `southstar.goal_design_package.v3` and `southstar.requirement_validation_binding.v3`.
- Missing or stale canonical data fails closed; no V2 adapter or composition fallback.
- Criterion `blocking` controls readiness and completion.
- Preserve unrelated changes in the dirty branch.
- Create one issue #4 commit only after every gate passes; do not push or merge.

---

### Task 1: Atomic parser and resolver

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/orchestration/goal-requirement-draft.ts`
- Modify: `src/v2/orchestration/goal-validation-resolver.ts`
- Modify: `src/v2/orchestration/goal-validation-llm-adapter.ts`
- Modify: `src/v2/orchestration/goal-design.ts`
- Test: `tests/v2/goal-requirement-draft.test.ts`
- Test: `tests/v2/goal-validation-resolver.test.ts`
- Test: `tests/v2/goal-design.test.ts`

**Produces:**

```ts
type RequirementValidationBindingV3 = {
  schemaVersion: "southstar.requirement_validation_binding.v3";
  id: string;
  requirementId: string;
  criterionBindings: Array<{
    criterionContract: CriterionVerificationContractV1;
    artifactContractRef: string;
    artifactContractVersionRef: string;
    evaluatorProfileRef: string;
    evaluatorProfileVersionRef: string;
    verificationMode: RequirementValidationMode;
    procedureRef: string;
    expectedEvidenceKinds: string[];
    independence: "independent";
    failureClassifications: string[];
  }>;
};
```

- [ ] Write tests that reject zero/multiple assurance modes and resolve deterministic and browser Criteria in one Requirement to different pinned children.
- [ ] Run `node --import tsx --test tests/v2/goal-requirement-draft.test.ts tests/v2/goal-validation-resolver.test.ts tests/v2/goal-design.test.ts`; verify failure is caused by the old array/multi-owner contract.
- [ ] Require exactly one assurance value. Invoke the existing ranker with one-Criterion Requirement views, resolve approved candidates, aggregate successful children, and derive gap/readiness blocking from each Criterion.
- [ ] Run the same command; expect all selected tests to pass.

---

### Task 2: Compiler, coverage, and evaluator authority

**Files:**
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/orchestration/goal-requirement-coverage.ts`
- Modify: `src/v2/evaluators/requirement-evaluator-results.ts`
- Modify: `src/v2/orchestration/goal-validation-lifecycle.ts`
- Test: `tests/v2/workflow-composition-compiler.test.ts`
- Test: `tests/v2/completion-gate.test.ts`
- Test: `tests/v2/completion-gate-exceptions.test.ts`
- Test: `tests/v2/postgres-run-api.test.ts`

**Expected coverage child:**

```ts
{
  criterionId,
  criterionVersion,
  blocking,
  artifactContractRef,
  artifactContractVersionRef,
  evaluatorProfileRef,
  evaluatorProfileVersionRef,
  verificationMode,
  procedureRef,
  expectedEvidenceKinds,
}
```

- [ ] Write tests that compile two evaluator profiles from one Requirement, project both Criterion children, block on a failed blocking Criterion only, and reject a missing/non-V3 package.
- [ ] Run `node --import tsx --test tests/v2/workflow-composition-compiler.test.ts tests/v2/completion-gate.test.ts tests/v2/completion-gate-exceptions.test.ts tests/v2/postgres-run-api.test.ts`; verify the old Requirement-level fields or optional package fallback fail.
- [ ] Traverse `validationBindings[].criterionBindings[]` in compiler/evaluator code. Make Goal Design Package V3 mandatory in compiler and coverage inputs. Keep Requirement grouping while exposing child bindings and evaluating each child independently.
- [ ] Run the same command; expect all selected tests to pass.

---

### Task 3: Freshness, lineage, identity, parser, and Library lock

**Files:**
- Modify: `src/v2/orchestration/goal-requirement-draft.ts`
- Modify: `src/v2/orchestration/goal-design.ts`
- Modify: `src/v2/orchestration/goal-design-draft-service.ts`
- Modify: `src/v2/orchestration/goal-execution-set.ts`
- Modify: `src/v2/orchestration/goal-contract.ts`
- Modify: `src/v2/orchestration/goal-validation-lifecycle.ts`
- Modify: `src/v2/read-models/workflow-ui.ts`
- Test: `tests/v2/goal-requirement-draft.test.ts`
- Test: `tests/v2/goal-design.test.ts`
- Test: `tests/v2/goal-contract.test.ts`
- Test: `tests/v2/postgres-run-api.test.ts`
- Test: `tests/v2/workflow-ui-read-model.test.ts`

- [ ] Write tests for asymmetric identity ambiguity, full Criterion stale comparison, per-slice IDs/tags/versions, malformed stored artifacts, stale source DAG/Goal outcome, and a selected Library version/status mutation before persistence.
- [ ] Run `node --import tsx --test tests/v2/goal-requirement-draft.test.ts tests/v2/goal-design.test.ts tests/v2/goal-contract.test.ts tests/v2/postgres-run-api.test.ts tests/v2/workflow-ui-read-model.test.ts`; observe the expected regressions.
- [ ] Reject every nonempty unmatched pair except one-to-one. Compare the complete Criterion contract. Preserve canonical identity in `goalContractForSlice`. Reuse `expectedArtifactsArray`. Stale source/downstream resources and filter stale Goal outcomes.
- [ ] In the persistence transaction, call `findLibraryObjectByKeyForUpdate` for every selected child artifact/evaluator and require `status === "approved"` plus the exact pinned head version; otherwise throw `goal_validation_library_binding_stale: <key>@<version>`.
- [ ] Run the same command; expect all selected tests to pass.

---

### Task 4: Criterion coverage UI and issue gate

**Files:**
- Modify: `web/lib/workflow/types.ts`
- Modify: `web/components/GoalContractInspector.tsx`
- Modify: `web/lib/workflow/goal-contract-display.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] Write a UI test with canonical `{ requirementId: "R1", criteriaResults: [{ criterionId: "C1", verdict: "failed" }] }` and assert the C1 artifact/evaluator chain is visible and failed.
- [ ] Run `node --import tsx --test tests/web/southstar-workflow-canvas-ui.test.tsx`; verify the old aggregate/plural-ID projection fails.
- [ ] Render Requirement-grouped Criterion rows with observable claim as the primary label and IDs/refs as secondary metadata. Match results by singular `requirementId` and `criterionId`; remove duplicate aggregate binding labels.
- [ ] Run the UI test, then `npm test`, `npm run test:v2`, `npm exec tsc -- --noEmit`, `npm --prefix web exec tsc -- --noEmit`, `npm --prefix web run build`, and `git diff --check`.
- [ ] Review the complete diff against the approved spec, fix findings with red/green tests, and create one issue #4 commit without push or merge.

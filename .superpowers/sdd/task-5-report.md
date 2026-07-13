# Task 5 report: structured Library readiness errors in workflow chat

Status: complete

Implemented `WorkflowGenerateHttpError` parsing for structured non-OK workflow responses and propagated the stable `library_not_ready` code and diagnostics to the workflow session hook. The hook now gives actionable guidance to open Library and sync diagnostics while preserving the generic message for unrelated failures.

Verification:

- `npx tsx --test --test-name-pattern='Library readiness' tests/web/southstar-workflow-canvas-ui.test.tsx` — 3/3 pass, including the browser harness path.
- `npx tsc --noEmit --pretty false` — pass.
- `npm --prefix web run build` — pass (a concurrent build was already running; its process completed successfully).
- `git diff --check` — pass.

The test covers structured stream parsing and the rendered workflow-chat guidance without introducing production fallbacks or fixture composer behavior.

# Task 5 report: approved Library validation resolver

Status: complete

Implemented `resolveGoalValidationPg()` and the approved validation candidate
closed-set helper. The resolver consumes the confirmed Goal Contract and
Requirement Draft, accepts semantic ranker recommendations, and host-validates
all artifact/evaluator refs, current versions, graph edges, verification
procedures, evidence compatibility, criteria preservation, and independent
evaluation policy before producing a version-pinned binding. Missing or
incompatible candidates are returned as structured gaps; no Library object is
created or selected outside the approved graph.

Added real Postgres tests covering approved binding, invented/draft refs,
criteria drift/evidence mismatch, and stale graph edges. Registered the focused
suite in `tests/v2/index.test.ts`.

Verification:

- `npx tsc --noEmit --pretty false` — pass.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts` — 4/4 pass.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts tests/v2/library-candidate-resolver.test.ts` — 9/9 pass.
- `git diff --check` — pass.

No fixtures, seed graph, domain special cases, or LLM calls were added to the
production resolver.

## Review: final range c6a0daa..8024954

Spec Compliance: **CONDITIONAL — not ready to accept as complete**.

Strengths:

- `resolveApprovedValidationCandidates()` reads approved `artifact_contract` and
  `evaluator_profile` graph objects only, rejects missing head versions, and
  filters evaluator candidates through active `validates_artifact`/`validates`
  edges with compatible endpoint versions (`candidate-resolver.ts:35-60`).
- Resolver output pins the current artifact/evaluator versions, preserves Goal
  Contract acceptance-criteria text, and rejects draft/invented refs, criteria
  drift, stale edges, unsupported procedures, and non-independent evaluators
  (`goal-validation-resolver.ts:223-362`).
- Ranker compatibility is now explicit: the host accepts a callable ranker,
  an object with `rank()`, a single recommendation, an array, or a wrapped
  `recommendations` result (`goal-validation-resolver.ts:50-66,455-482`). The
  public result/gap/preview/binding types are exported (`goal-validation-resolver.ts:75-80`).
- Focused Postgres coverage passes (4 resolver tests), including approved
  binding, invented/draft refs, criteria/evidence mismatch, and stale edge
  behavior.

Critical issues:

1. The resolver has no final-readiness gate. `resolveGoalValidationPg()` always
   returns a resolution containing `bindings` plus `gaps`, including blocking
   requirements with `missing`, `partial`, or `manual` previews; there is no
   `assertReady`/final mode or equivalent host invariant
   (`goal-validation-resolver.ts:88-197`). A caller that passes only the
   non-empty bindings to composition can proceed while blocking coverage is
   absent. Task 9 may add a downstream compiler gate, but until that gate is
   present and consumes this exact resolution, Task 5 does not satisfy the
   brief's “do not allow composition from missing/partial/manual coverage”.

2. Ranker-provided `expectedEvidenceKinds` is now unioned with the requirement
   criterion evidence intent, but it is still not constrained to that host-owned
   set (`goal-validation-resolver.ts:364-402`, final range `8024954`). A
   semantic ranker can still add an invented kind (for example, adding
   `screenshot` to a criterion whose intent is only `test-result`) whenever both
   Library objects happen to accept it. Evidence must be derived from each
   confirmed criterion; ranker suggestions should be constrained to that set or
   rejected as an `evidence` gap, otherwise the evaluator binding can validate a
   different claim than the Goal Contract.

Important issues:

1. Evidence compatibility is permissive when declarations are absent and uses
   a union of procedure/evaluator evidence lists. If `allowedEvidenceKinds` or
   artifact evidence kinds are empty, the corresponding check is skipped
   (`goal-validation-resolver.ts:368-381`). A missing evaluator result schema,
   procedure evidence declaration, or artifact evidence declaration therefore
   does not create a gap, contrary to the requirement that schema/procedure/
   evidence be real. Require the declared schema/evidence fields and validate
   expected evidence against every applicable declaration (intersection), not a
   union.

2. Procedure compatibility checks only that a procedure id exists. The
   procedure's own mode/check kind is never compared with the selected
   `verificationMode` (`goal-validation-resolver.ts:326-350`), so a procedure
   declared as deterministic can be bound to a browser-interaction evaluator
   recommendation.

3. Passing `scope: "all"` finds all approved objects (the graph store treats
   `all` as unscoped) but `validationEdgesTo()` searches only edge scopes
   `"all"` and `"global"`, omitting real domain-scoped edges
   (`candidate-resolver.ts:75-89`). This silently reports missing evaluator
   coverage for an otherwise valid all-scope request.

4. `GoalValidationGapV1.candidateRefs` is never populated; every gap defaults
   it to `[]` (`goal-validation-resolver.ts:486-498`). The previews expose
   candidates, but the structured gap itself cannot drive the later explicit
   candidate approval flow promised by the brief.

5. Validation edges with null endpoint version refs are accepted
   (`candidate-resolver.ts:49-55`). Although the output binding pins current
   object versions, an unpinned edge can survive an object revision and still
   authorize a new pair. Either require exact edge endpoint versions for a
   frozen binding or record/validate an explicit compatibility policy.

Minor issues:

- `validateArtifactContract()` accepts any one of `validationRules`, `schemaRef`,
  or `requiredFields`, while evaluator result schema is not checked at all
  (`goal-validation-resolver.ts:487-493`). Align these checks with the actual
  artifact/evaluator authoring schema so approved but incomplete files cannot
  become candidates.
- The new suite covers four happy/negative paths but has no test for callable
  rankers, wrapped recommendations, duplicate recommendations, `scope: "all"`,
  missing procedure/schema/evidence declarations, or blocking readiness gating.

Task quality assessment: **good foundation, incomplete contract enforcement**.
The closed-set graph lookup, host-owned version pinning, criteria preservation,
and ranker compatibility are well factored and the focused tests are real
Postgres tests. Address the two Critical and five Important issues (or add an
explicit downstream gate that is tested end-to-end) before marking Task 5
complete.

## Review follow-up: final range 8024954..working-tree

Status: complete.

Resolved the review findings:

- Added `ready`, `goalValidationResolutionReady()`, and
  `assertGoalValidationResolutionReady()`. The assertion fails closed when a
  blocking preview is not ready, has no binding, is manual, or has a blocking
  gap; Task 9 can call this exact host gate before compilation.
- Evidence is now derived from each confirmed criterion's `evidenceIntent`.
  Ranker evidence may only be a subset; extra kinds are rejected as an
  evidence gap, and criterion checks retain criterion-specific evidence.
- Approved evaluator objects must declare a result schema, matching procedure
  mode/check kind, non-empty procedure/evaluator evidence declarations, and
  independent policy. Approved artifacts must declare validation content and
  evidence kinds; absent declarations fail closed.
- `scope: "all"` now reads graph edges across every scope. Validation edges
  must be active and pin both endpoint versions to current approved heads.
- Actionable gaps are populated with the approved artifact/evaluator candidate
  refs that can resolve them.

Follow-up verification:

- `npx tsc --noEmit --pretty false` — pass.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts` — 6/6 pass.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts tests/v2/library-candidate-resolver.test.ts` — 11/11 pass.
- `git diff --check` — pass.

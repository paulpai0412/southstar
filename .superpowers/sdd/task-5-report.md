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

## Final review: c6a0daa..e6558f6

Spec Compliance: **CONDITIONAL — resolver invariants are now fail-closed, but
the current approved file-authored Library cannot yet produce a ready binding**.

Verified resolved requirements:

- `ready` is computed from every blocking preview and blocking gap, and
  `assertGoalValidationResolutionReady()` fails closed when the optional
  backward-compatible `ready` field is absent (`goal-validation-resolver.ts:205-233`,
  `design-library/types.ts:321-330`).
- Evidence is criterion-derived; ranker extras are rejected, and procedure,
  evaluator, artifact, and result-schema declarations are required
  (`goal-validation-resolver.ts:415-475`).
- Procedure mode/check kind is checked; `scope: "all"` reads all edge scopes;
  validation edges require active exact endpoint head versions; candidate refs
  are populated from the preview candidate set (`candidate-resolver.ts:49-89`,
  `goal-validation-resolver.ts:195-203`).
- Focused Postgres tests pass: 6/6, including invented evidence, readiness,
  unpinned edges, and `scope: "all"`. `npx tsc --noEmit --pretty false` also
  passes.

Remaining critical integration issue:

1. The strict pinned-edge and object-state checks are incompatible with the
   repository's current file-authored Library graph. `projectLibraryFileToGraph`
   emits `validates_artifact` edges without `fromVersionRef`/`toVersionRef`
   (`src/v2/design-library/files/library-file-store.ts:345-386`), while the
   resolver now requires both refs to equal current heads
   (`src/v2/orchestration/candidate-resolver.ts:49-55`). Existing approved
   evaluator files such as `library/evaluators/flashcard-deck-validator.evaluator.yaml`
   declare only `validatesArtifactRefs` and `evidenceKinds`; they do not declare
   verification modes/procedures, result schema, or independence policy. Existing
   artifact files such as `library/artifacts/flashcard-deck-spec.artifact.yaml`
   declare `artifactType` and evidence kinds but no validation rules/schema/required
   fields. Consequently, all current real file-backed candidates resolve to
   gaps and `ready=false`; only the synthetic test graph with manually enriched
   state can bind.

This is acceptable only if the next Library authoring/migration task updates the
file projection and existing approved evaluator/artifact files before Task 9
invokes the readiness gate. Otherwise Task 5 is not operational in the current
product. Add an integration test that syncs one real approved evaluator/artifact
file pair and proves a ready binding after the schema/edge migration.

Task quality assessment: **invariant implementation is strong and fail-closed;
production compatibility remains blocked by the Library authoring contract**.

## Final follow-up: c6a0daa..fe2a993

Candidate gap fallback is now actionable even when the preview has no
artifact/evaluator candidates: gaps use the approved closed-set refs, and the
unpinned-edge test asserts the evaluator ref is exposed. Focused resolver tests
remain green (6/6).

The production compatibility blocker above remains unchanged: current
file-authored graph edges are unversioned and current approved evaluator/
artifact files lack the strict state fields required for a ready binding.

## Compatibility implementation: file-backed Library ready path

Status: complete.

- File graph projection now resolves each referenced target from Postgres at
  edge write time and persists `fromVersionRef` and `toVersionRef` for every
  active edge. Missing target versions fail closed; no placeholder is added.
- The YAML parser now supports nested evidence arrays inside evaluator
  verification procedure objects.
- Existing approved flashcard artifact/evaluator authoring files now carry
  schema refs, required fields, validation rules, evidence kinds, independent
  evaluator policy, result schemas, mode-matching procedures, and failure
  classifications.
- A real Postgres integration test syncs those files, asserts version-pinned
  graph edges, and resolves a `ready=true` binding. Resolver/candidate and
  existing library parser/store suites remain green.
- A separate file-backed regression keeps an older approved artifact/evaluator
  pair blocked when the strict validation contract fields are absent.

Follow-up verification:

- `npx tsc --noEmit --pretty false` — pass.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts` — 6/6 pass.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts tests/v2/library-candidate-resolver.test.ts` — 11/11 pass.
- `git diff --check` — pass.

Final compatibility verification rerun:

- `npx tsx --test tests/v2/goal-validation-resolver.test.ts` — 8/8 pass,
  including the ready file-backed pair and blocked legacy pair.
- `npx tsx --test tests/v2/goal-validation-resolver.test.ts tests/v2/library-file-parser.test.ts tests/v2/library-file-store.test.ts tests/v2/library-candidate-resolver.test.ts` — 41/41 pass.
- `npx tsc --noEmit --pretty false` and `git diff --check` — pass.

## Artifact head repin follow-up

- Artifact file sync now transactionally repins active inbound
  `validates_artifact` edges to the artifact's current head version without
  requiring evaluator resync. Approved evaluator source heads are used; stale
  or non-executable sources are deactivated. Recreated edges retain scope,
  weight, and source metadata, while stale rows remain inactive for audit.
- A real file-backed Postgres regression syncs the approved flashcard artifact
  as v1, syncs its evaluator once, then syncs an in-memory v2 artifact record
  without evaluator resync. It proves the old edge is inactive, the new edge
  is pinned and metadata-preserving, and validation resolution remains
  `ready=true`.

Repin verification:

- `npx tsx --test tests/v2/library-file-store.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-candidate-resolver.test.ts tests/v2/goal-validation-resolver.test.ts` — 34/34 pass.

## Review: compatibility follow-up 7c81d1d..ae31a1e

Spec Compliance: **CONDITIONAL PASS**.

Verified:

- File-backed sync resolves each target's current head and writes both
  `fromVersionRef` and `toVersionRef`; missing target versions fail closed
  (`library-file-store.ts:160-205,266-307`). The integration test confirms the
  edge values and a real approved flashcard artifact/evaluator pair resolves
  with `ready=true` (`tests/v2/goal-validation-resolver.test.ts:218-263`).
- Nested `allowedEvidenceKinds` arrays in evaluator procedures are parsed and
  survive sync; the authored evaluator files provide mode-matching procedures,
  result schemas, independence policy, evidence kinds, and failure classes.
- The legacy pair remains blocked when strict artifact/evaluator fields are
  absent, preserving fail-closed behavior (`tests/v2/goal-validation-resolver.test.ts:265-293`).
- The modified flashcard YAML files are Library authoring files under
  `library/`, not test fixtures, seed runtime code, or hardcoded resolver
  branches. Focused combined verification passes 41/41; TypeScript and diff
  checks pass.

Remaining important lifecycle issue:

1. Versioned inbound edges are not refreshed when only the target artifact file
   changes. `versionedEdge()` pins the target head only while syncing the source
   evaluator file; `deactivateLibraryEdgesForSourceExcept()` keys retained edges
   by edge type/target/scope and ignores endpoint versions. Therefore an
   artifact revision leaves evaluator edges pointing at the old target head,
   and the resolver correctly returns no ready binding until every referencing
   evaluator file is resynced. Either update inbound validation edges when a
   target head changes, or provide a transactional graph reconcile that rewrites
   all affected pinned edges. Add a regression test for artifact v1 → v2 sync
   followed by resolver readiness without evaluator reimport.

Task quality assessment: **strong and operational for the initial file-backed
pair; conditional until target-version edge refresh is handled**. The legacy
blocked test and real sync→resolve test materially validate the intended
boundary without adding seed/fixture behavior.

## Final lifecycle review: ae31a1e..13dcc94

Spec Compliance: **CONDITIONAL PASS**.

Verified:

- Artifact sync locks the current artifact row and repins inbound active
  `validates_artifact` edges inside the caller transaction. Only approved
  `evaluator_profile` sources with a current head are retained; non-approved,
  non-evaluator, or headless sources are inactivated
  (`library-graph-store.ts:179-255`).
- Recreated edges preserve scope, weight, and `metadata_json`; old versioned
  rows are retained as inactive audit history. The v1→v2 integration regression
  proves exactly one active edge, old edge inactive, metadata unchanged, and
  resolver `ready=true` without evaluator resync
  (`tests/v2/goal-validation-resolver.test.ts:244-313`).
- Batch reconcile also invokes repin after object upserts, so the operation is
  transactional for the complete file catalog. Combined lifecycle tests pass
  34/34.

Remaining issues:

1. `repinInboundValidationEdgesForArtifact()` filters only
   `edge_type = 'validates_artifact'`. The resolver still accepts the generic
   `validates` edge type, so a manually/legacy graph-backed evaluator using
   `validates` remains pinned to the old artifact head after an artifact
   revision and is rejected until its source is resynced. Either repin both
   accepted validation edge types or explicitly remove `validates` from the
   resolver contract. Add a regression for the generic edge.

2. Source status changes are filtered by the resolver, but an evaluator changed
   from approved to draft/deprecated is not immediately inactivated at sync
   time; repin runs on artifact sync, not evaluator sync. This leaves an active
   stale row in the graph until a later artifact update. If the audit invariant
   requires stale rows to be inactive immediately, invoke the same inbound-edge
   cleanup when an evaluator source loses executable status.

Task quality assessment: **strong transactional lifecycle repair with minor
contract coverage gaps**. The requested approved-source filtering, metadata
preservation, stale-row audit, and artifact v1→v2 readiness regression are
implemented and verified; address generic `validates` handling before claiming
full lifecycle coverage.

## Final lifecycle compatibility follow-up

- Artifact repin now covers both resolver-supported edge types:
  `validates_artifact` and generic `validates`. Each old active row is retained
  as inactive audit history and recreated with the current artifact and
  approved evaluator head refs while carrying source metadata.
- Non-approved evaluator source syncs now remove its active validation edges
  immediately, including both edge types, while preserving ordinary draft
  agent/tool edge behavior. This closes the evaluator downgrade/deprecation
  stale-edge window without changing unrelated Library draft semantics.
- Operator lifecycle deprecate/block transitions use the same source cleanup,
  so validation edges without file metadata are also inactivated immediately.
- Regression coverage now proves generic-edge v1→v2 repin and approved
  evaluator downgrade deactivation on real file-backed Postgres objects.

Final verification:

- `npx tsx --test tests/v2/library-file-store.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-candidate-resolver.test.ts tests/v2/goal-validation-resolver.test.ts tests/v2/library-object-lifecycle.test.ts` — 42/42 pass.
- `npx tsc --noEmit --pretty false` and `git diff --check` — pass.

## Final Task 5 lifecycle verdict at 8795842

Spec Compliance: **PASS**.

The final lifecycle requirements are satisfied:

- Artifact repin handles both `validates_artifact` and `validates` in one
  transaction, keeps old rows inactive for audit, preserves metadata/scope/
  weight, and leaves the v1→v2 resolver path `ready=true`.
- File sync and operator deprecate/block transitions call the same narrowly
  scoped `deactivateValidationEdgesForSource()` helper. It targets only the two
  validation edge types, so ordinary agent/tool/capability edges are not
  blanket-deactivated; metadata-less validation rows are also covered.
- The source filter remains fail-closed: only approved evaluator profiles with
  current heads can be repinned. Existing ordinary-edge reconciliation keeps
  declared non-validation edges intact.
- Lifecycle regression coverage passes: 35/35 for the requested file/store/
  resolver suite, plus 7/7 lifecycle tests (42/42 combined as reported).
  TypeScript and diff checks pass.

Quality assessment: **ready for Task 5 handoff**. The implementation is
transactional, version-pinned, audit-preserving, and avoids fixture/seed or
domain-specific runtime behavior. A separate ordinary-edge assertion would be
useful future coverage, but the production SQL edge-type filter is explicit and
the requested safety boundary is enforced.

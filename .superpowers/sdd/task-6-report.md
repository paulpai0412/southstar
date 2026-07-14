# Task 6 report: validation persistence, linked Library import, and resume

Status: COMPLETE

Commit: `c3fba75 feat: resume goal validation after library import`

## Implemented

- Added `resolveAndPersistGoalValidationPg()` and `persistGoalValidationResolutionPg()` with optimistic Goal Contract/Requirement hash checks.
- Persisted immutable `goal_validation_resolution_revision` snapshots and version/hash-bound `goal_requirement_validation_binding` resources, while projecting the current resolution, bindings, and gaps into the existing planner draft.
- Added strict LLM validation-ranking prompt/schema handling. The host accepts only the documented verification modes and exact output keys; the existing resolver still validates every recommended ref, graph edge, procedure, evidence kind, and version.
- Added gap-only candidate generation from confirmed Requirement/criterion intent and bounded approved candidate refs. The request does not use seed content, fixtures, canned domains, or Goal-specific production mappings.
- Added deterministic Goal-linked Library import draft ids plus host-owned `originGoalDraftId`, Goal Contract hash, Requirement Draft hash, and resolution hash metadata. Sequential retries reuse the same persisted candidates without a second LLM call.
- Added explicit install/reconcile resume through the Library route. JSON and SSE responses report `goal_validation_resumed`; post-commit resume failure is recoverable and never rolls back installed Library state.
- Added stale invalidation: a Requirement revision stales linked draft candidates and all immutable validation resources. Stale candidates cannot install or resume.
- Resume re-resolves the current approved graph into the same Goal planner draft. It does not recreate the Goal Contract, planner draft, workflow run, or child run.

## TDD evidence

RED observed before production changes:

- `npx tsx tests/v2/postgres-run-api.test.ts` failed because `resolveAndPersistGoalValidationPg` was not exported.
- `npx tsx tests/v2/library-import-drafts.test.ts` failed because linked draft creation returned two random ids.

GREEN verification:

- `npx tsc --noEmit --pretty false` — pass.
- `npx tsx --test --test-name-pattern='confirmed requirements with gaps|candidate install resumes|Requirement revision marks linked|confirm-requirements route resolves validation' tests/v2/postgres-run-api.test.ts` — 4/4 pass.
- `npx tsx --test --test-name-pattern='reuses one host-linked draft|linked candidate install stays committed|linked candidate install stream emits' tests/v2/library-import-drafts.test.ts` — 3/3 pass.
- `git diff --check` — pass.

## Full-suite observations

- `npx tsx tests/v2/postgres-run-api.test.ts` — 54/56 pass. The two failures are pre-existing Library readiness setup gaps: tests that install/reconcile without the now-required approved `goal_design` and `composer_guidance` purpose skills.
- `npx tsx tests/v2/library-import-drafts.test.ts` — 34/48 pass. The fourteen failures are the same pre-existing required-purpose-cardinality setup gap; all three Task 6 Library cases pass.
- `npx tsx tests/v2/run-goal-service.test.ts` — 31/36 pass. The five failures are environmental and all fail while scanning inaccessible `/tmp/snap-private-tmp` before reaching Task 6 behavior.

## Concerns

- The focused Task 6 behavior is green. The branch-wide baseline failures above belong to the Task 5 Library readiness/test-environment follow-up and were intentionally not changed in this task to avoid mixing scopes.

## Review blocker follow-up

Status: VERIFIED

Follow-up commit: `372b8d5 fix: complete goal validation import lifecycle`

- Completed the governed `artifact_contract` and `evaluator_contract` candidate schema across the LLM prompt, strict host parser, persisted candidate parser, YAML renderer, and graph sync. Evaluator modes, procedures, allowed evidence kinds, independence policy, result schema, and failure classifications are now explicit and host-validated.
- Installed ontology edges now pin both source and target Library object versions.
- Added immutable Goal-linked import attempt identity. An active matching draft remains idempotent, while an installed partial attempt creates a new follow-up draft even when the validation resolution hash is unchanged.
- Added a current-origin gate before JSON/SSE install and before resume. It checks Goal Contract, Requirement Draft, validation resolution, and validation gap hashes; stale candidates are rejected before Library state changes.
- Closed the install TOCTOU window: the final install transaction locks the planner row before the import row, rechecks the complete origin, commits any stale marker, and cleans preflighted files without publishing graph state.
- Missing Library LLM configuration now fails closed with a structured `goal_validation_provider_not_configured` response and actionable readiness data before requirement confirmation mutates the Goal draft.
- Split the LLM ranking/import adapter and Postgres validation lifecycle out of `goal-design-draft-service.ts`; existing public exports remain compatible.
- Post-commit re-resolution failure preserves approved Library state and returns a recoverable Goal error.
- Post-commit missing-provider recovery preserves structured `code`, `httpStatus`, and actionable `readiness` data.
- Independent blocker-only re-review completed with no remaining blockers.

Follow-up verification:

- `npx tsc --noEmit --pretty false` — pass.
- `node --import tsx --test tests/v2/goal-validation-resolver.test.ts tests/v2/library-candidate-resolver.test.ts` — 14/14 pass.
- Focused Task 6 Postgres lifecycle/provider/stale/race suite — 12/12 pass.
- Focused Library candidate/schema/tamper/pinned-edge/stale JSON+SSE suite — 7/7 pass.
- Focused staged run-goal route — 1/1 pass.
- Production addition scan for fixture/mock/fake/seed/domain examples — no matches.
- `git diff --check` — pass.
- Full `library-import-drafts.test.ts` — 38/50 pass; the same twelve Task 5 required-purpose-cardinality setup failures remain, with no additional failure introduced by the strict parser or transaction guard.

## Task 5/6 issue re-review and final correction

Status: VERIFIED

- Replaced the duplicated validation-candidate checks with one strict per-kind candidate schema used by LLM output normalization, persisted draft parsing, Library YAML parsing, graph-state validation, and Goal validation resolution.
- Artifact contracts now require media types, evidence kinds, validation rules, schema/required fields, and provenance requirements. Evaluator contracts now require artifact refs, inputs, evidence, modes, executable procedures with instructions, independent policy, the exact `southstar.requirement_evaluator_result.v2` result schema, and failure classifications.
- Unknown executable-contract fields fail closed in both files and already-persisted graph state. Host projection fields such as `declaredStatus` remain outside the authored contract and are explicitly excluded before exact validation.
- Candidate descriptions round-trip for every supported kind. Missing tool/MCP descriptions remain absent; the renderer no longer invents generic descriptions.
- Candidate install, legacy import approval, browser file PATCH, and startup/manual reconcile now coordinate through the same Postgres advisory lock. Catalog reads occur after lock acquisition.
- Multi-file imports stage outside the watched Library root, publish only while holding the reconcile lock, reconcile in the same database transaction, and roll back matching published content before releasing the lock on failure.
- Replacement publication uses expected-original comparison, so a concurrent operator edit after preflight is preserved and the stale install fails.
- Goal validation resume orchestration moved from the Library route into the Goal validation lifecycle service; routes now only adapt HTTP/SSE inputs and outputs.
- The old required-purpose-cardinality test setup gaps were corrected with explicit approved Library primitives. No production seed, fixture composer, mock, fake, fallback, or goal-specific mapping was added.

Final verification:

- `npx tsc --noEmit --pretty false` — pass.
- `node --import tsx --test tests/v2/library-file-parser.test.ts` — 16/16 pass.
- `node --import tsx --test tests/v2/goal-validation-resolver.test.ts` — 10/10 pass.
- `node --import tsx --test tests/v2/library-reconcile-postgres.test.ts` — 9/9 pass.
- `node --import tsx --test tests/v2/library-import-drafts.test.ts` — 53/53 pass.
- `node --import tsx --test tests/v2/library-chat-routes.test.ts` — 13/13 pass.
- Focused Postgres Goal validation/import/resume/stale/race suite — 6/6 pass.
- `git diff --check` — pass.

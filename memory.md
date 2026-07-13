# Goal Validation Pipeline Working Memory

## Active objective

Complete a genuinely operable flow:

`Goal -> Requirement -> Slice -> DAG -> Execution -> Evaluation`

The implementation must use approved, versioned Library contracts and real evaluator outputs. Do not replace missing production behavior with seeds, fixtures, fake/mock/smoke paths, Goal-specific hardcode, or production composer fallbacks.

## Frozen Task 6 reliability stage

- Frozen commits:
  - `e5c39e6 fix: recover durable library publications`
  - `49eb085 fix: isolate live library publication files`
  - `59a4946 fix: track library publication ownership`
- Purpose: keep Library file publication and Postgres reconciliation recoverable when a process fails between file publication and database commit.
- Included boundaries: sibling-filesystem durable publication journal, advisory-lock/CAS publication seam, commit proof, startup/manual recovery, atomic journal visibility, and identity-safe rollback.
- Shared paths covered: validation candidate install, legacy Library approval, and Library file PATCH.
- Evidence at freeze time:
  - affected Library regression: 99/99 passing
  - Goal validation/install/resume: 8/8 passing
  - final reconcile crash-boundary tests: 13/13 passing
  - `npx tsc --noEmit`: passing
  - `git diff --check`: passing
- Final reliability evidence: immutable journal content plus durable ownership identity preserves both in-place edits and identical-byte atomic replacements; focused ownership/recovery tests and the 53-test Library import suite pass.
- Scope rule: Task 6 is closed. Do not add more transaction/recovery machinery unless a failing production-path test proves a correctness defect that blocks the Goal flow. Prefer recording non-blocking infrastructure improvements for later.

## Completed product stages

1. Strict Goal Requirement Draft domain with stable host-selected ids, hashes, validation, revision, and confirmation.
2. LLM requirement interpretation/revision with strict structured output and bounded repair.
3. Persisted requirement review phases, revisions, and thin APIs.
4. Workflow-chat requirement list plus right-side requirement editing and confirmation.
5. Approved Library validation resolution from requirement criteria to version-pinned artifact contracts and evaluator profiles.
6. Validation-gap import candidate creation, approval/install/reconcile, and Goal validation resume.

## Mainline remaining work

1. Audit Task 7 only for missing executable artifact/evaluator authoring fields; much of its schema work was pulled forward by Task 6.
2. Build slices only from confirmed requirements and resolved validation bindings.
3. Compile those slices and bindings into a validated, executable DAG manifest with frozen Library version references and criterion coverage.
4. Execute the persisted DAG through the existing scheduler/hand/Tork path.
5. Parse real criterion-level evaluator artifacts and compute requirement/Goal completion in the existing completion gate.
6. Add only the UI interaction contract work needed for requirements that require screen/layout confirmation.
7. Verify focused end-to-end flows: no-gap, validation-gap/import/resume, visual requirement, execution, evaluator verdict, and completion.

## Delivery priority

Prioritize the first working vertical path over additional infrastructure generalization. A stage is not complete merely because its schema or isolated tests pass; it must feed the next stage using persisted production data.

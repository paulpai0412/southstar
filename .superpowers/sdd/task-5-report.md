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

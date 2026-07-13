# Task 5 report: structured Library readiness errors in workflow chat

Status: complete

Implemented `WorkflowGenerateHttpError` parsing for structured non-OK workflow responses and propagated the stable `library_not_ready` code and diagnostics to the workflow session hook. The hook now gives actionable guidance to open Library and sync diagnostics while preserving the generic message for unrelated failures.

Verification:

- `npx tsx --test --test-name-pattern='Library readiness' tests/web/southstar-workflow-canvas-ui.test.tsx` — 3/3 pass, including the browser harness path.
- `npx tsc --noEmit --pretty false` — pass.
- `npm --prefix web run build` — pass (a concurrent build was already running; its process completed successfully).
- `git diff --check` — pass.

The test covers structured stream parsing and the rendered workflow-chat guidance without introducing production fallbacks or fixture composer behavior.

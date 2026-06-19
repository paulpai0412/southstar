# Legacy SQLite quarantine manifest

These production files are compatibility-only SQLite-era surfaces. They carry `@legacy-sqlite-quarantine` and must not receive new behavior. New code must use Postgres/async APIs.

Canonical v2 tests are Postgres/non-legacy via `tests/v2/index.test.ts`. The old aggregate is retained as `tests/v2/legacy-sqlite.index.test.ts` for compatibility/reference only.

- src/v2/context/builder.ts
- src/v2/design-library/designer.ts
- src/v2/design-library/lifecycle.ts
- src/v2/design-library/reuse.ts
- src/v2/design-library/store.ts
- src/v2/evaluators/pipeline.ts
- src/v2/evaluators/stop-condition.ts
- src/v2/executor/reconciler.ts
- src/v2/executor/tork-callback.ts
- src/v2/inspection/design-library-lineage.ts
- src/v2/inspection/inspect-run.ts
- src/v2/planner/library-aware-validator.ts
- src/v2/planner/library-search.ts
- src/v2/quality/artifact-evidence-gates.ts
- src/v2/quality/design-library-gates.ts
- src/v2/quality/domain-pack-dynamic-gates.ts
- src/v2/quality/executor-observability-gates.ts
- src/v2/quality/phase15-gates.ts
- src/v2/quality/phase1-gates.ts
- src/v2/quality/productized-ui-library-planner-gates.ts
- src/v2/quality/runtime-hardening-gates.ts
- src/v2/quality/ui-control-plane-gates.ts
- src/v2/read-models/executor-ops.ts
- src/v2/read-models/runtime-monitor.ts
- src/v2/read-models/task-detail.ts
- src/v2/read-models/workflow-canvas.ts
- src/v2/legacy/sqlite/root-session.ts
- src/v2/session-graph/sqlite-provider.ts
- src/v2/session-recovery/checkpoints.ts
- src/v2/session-recovery/dispatcher.ts
- src/v2/session-recovery/operations.ts
- src/v2/stores/history-store.ts
- src/v2/stores/metrics-store.ts
- src/v2/stores/resource-store.ts
- src/v2/stores/run-store.ts
- src/v2/stores/sqlite.ts
- src/v2/stores/task-store.ts
- src/v2/ui-api/commands/domain-pack-commands.ts
- src/v2/ui-api/commands/executor-commands.ts
- src/v2/ui-api/commands/governance-commands.ts
- src/v2/ui-api/commands/session-memory-commands.ts
- src/v2/ui-api/commands/task-commands.ts
- src/v2/ui-api/commands/worktree-commands.ts
- src/v2/ui-api/local-api.ts
- src/v2/ui-api/operations-dashboard.ts
- src/v2/ui-api/page-models/executor.ts
- src/v2/ui-api/page-models/internal.ts
- src/v2/ui-api/page-models/operations-tab.ts
- src/v2/ui-api/page-models/planner.ts
- src/v2/ui-api/page-models/runtime-monitor.ts
- src/v2/ui-api/page-models/sessions-memory.ts
- src/v2/ui-api/page-models/workflow-canvas.ts

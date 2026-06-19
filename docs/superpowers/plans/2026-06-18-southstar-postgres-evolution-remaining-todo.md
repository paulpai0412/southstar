# Southstar Postgres Evolution Remaining TODO

> Rule: implement new Postgres/async APIs only. Keep old SQLite/sync APIs isolated for compatibility until final removal. Do not extend old APIs.

## A. New Postgres runtime API surface

- [x] A1. Add Postgres planner/run creation API separate from old `ui-api/local-api.ts`.
  - Create `src/v2/ui-api/postgres-run-api.ts`.
  - Persist planner draft, workflow run, workflow tasks, history, and context packets via Postgres stores.
  - Use `buildContextPacketWithKnowledgeCards` for task contexts.
  - Expose server routes for Postgres-backed `POST /api/v2/planner/drafts`, `POST /api/v2/runs`, and `POST /api/v2/run-goal` when `context.db` is Postgres.
- [x] A2. Add Postgres task envelope API separate from old local API.
  - Create `src/v2/ui-api/postgres-task-envelope.ts` if needed.
  - Build TaskEnvelopeV2 from Postgres run/task/resources/context packet.
- [x] A3. Add Postgres status/read-model routes for runtime monitor, workflow canvas, task detail, sessions-memory, executor-ops, vault-mcp.
  - Do not edit old SQLite read-model implementation except routing isolation.
- [x] A4. Update `src/v2/cli.ts` to avoid local SQLite fallback for new runtime commands.
  - Commands that need runtime state use runtime server/read-model client.
  - Keep local SQLite mode only under explicit legacy injection in tests.

## B. Executor/callback/recovery Postgres path

- [x] B1. Add Postgres executor binding store.
- [x] B2. Add Postgres Tork callback ingestion path.
- [x] B3. Add Postgres reconcile path.
- [x] B4. Add Postgres recovery dispatch/session checkpoint path.

## C. Evolution policy completion

- [x] C1. Complete delta validation: target existence, target version, patch allowlist, runtime invariant protection, evidence subgraph hash.
- [x] C2. Complete promotion policy engine: prompt/skill/profile/flow matrix and approval integration.
- [x] C3. Complete run-completed batch Knowledge Card synthesis trigger.
- [x] C4. Complete wiki maintenance: alias normalization, stale backlink rewiring, conflict workflow.

## D. Sandbox real execution

- [x] D1. Materialize sandbox baseline/candidate runs with `run_mode='sandbox'`.
- [x] D2. Pass `SOUTHSTAR_RUN_MODE=sandbox` and `SOUTHSTAR_SANDBOX_EXPERIMENT_ID` to executor tasks.
- [x] D3. Isolate sandbox workspaces via temp worktrees/fixture copies.
- [x] D4. Connect evaluator pipeline outputs to sandbox trial decisions.

## E. UI operations

- [x] E1. Add Evolution Control Center command buttons for approve/reject card, approve/reject delta, run sandbox, rollback asset.
- [x] E2. Add graph node selection and wiki link moderation UI.
- [x] E3. Add canary/regression alert handling UI.

## F. Static gates and final SQLite removal

- [x] F1. Add gates for no unquarantined `node:sqlite`, `sqlite-provider`, or SQLite memory usage in new production paths.
- [x] F2. Move old SQLite API files into explicit legacy/quarantine folder or remove after callers are migrated.
  - Quarantined legacy SQLite production files with `@legacy-sqlite-quarantine` and `src/v2/legacy/sqlite/QUARANTINE_MANIFEST.md`; no new behavior should be added there.
- [x] F3. Convert DB-backed unit tests to Postgres-only.
  - Canonical `tests/v2/index.test.ts` now imports Postgres/non-legacy tests only; old aggregate retained as `tests/v2/legacy-sqlite.index.test.ts`.

## G. E2E completion

- [ ] G1. Migrate existing real E2E harness away from SQLite assertions.
- [ ] G2. Add full no-MVP real E2E matrix with real Postgres/Tork/Pi.
- [ ] G3. Add real sandbox baseline/candidate E2E.

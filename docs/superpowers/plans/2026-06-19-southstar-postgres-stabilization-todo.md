# Southstar Postgres/Evolution Stabilization TODO

Date: 2026-06-19
Branch: `stabilize/postgres-evolution-boundary`

## Objective

Converge the current mixed SQLite/Postgres, old/new API, and partially tested WIP into a stable, reviewable state without bulk-deleting valuable legacy domain logic.

The end state of this stabilization pass is:

- Canonical v2 runtime/server/CLI/API path is Postgres/async.
- Legacy SQLite API/E2E surfaces are explicitly quarantined and non-canonical.
- Pure domain logic is separated from DB-backed legacy loops where practical.
- Verification gates clearly identify which layer failed.
- Work is staged in reviewable commits instead of one large WIP blob.

## Non-goals for this pass

- Do not delete all SQLite code in one pass.
- Do not extend old SQLite/local APIs with new behavior.
- Do not rewrite every legacy module to Postgres at once.
- Do not claim full real E2E completion unless real Postgres/Tork/Pi infra has been run.

## Phase 0 — Safety and audit

- [x] Create stabilization branch.
- [x] Write `/tmp` WIP patch/status/untracked backups.
- [x] Review git history around SQLite runtime, real E2E, productized UI, session recovery, Postgres/evolution specs.
- [x] Keep `.southstar/` generated runtime state out of commits unless a file is explicitly required (`.southstar/` added to `.gitignore`).

## Phase 1 — Commit boundary plan

- [x] Commit A: Postgres DB/config foundation (`fa96fd2`).
- [x] Commit B: Postgres runtime API/read-model/CLI/server path plus Evolution backend (`53a5b8e`).
- [x] Commit C: Evolution Control Center UI/read-model wiring (`496690f`).
- [x] Commit D/E: Legacy SQLite quarantine, E2E isolation, and pure root-session split (`da7af12`).
- [x] Commit F: Stabilization TODO/checklist and verification evidence updates (`0b48020` plus final docs commit).

## Phase 2 — Canonical/legacy boundary gates

- [x] `test:e2e:real` points to `tests/e2e-postgres/index.test.ts`.
- [x] Legacy real E2E physically lives under `tests/e2e-legacy-sqlite/`.
- [x] Canonical v2 aggregate excludes SQLite-backed tests.
- [x] CLI tests exercise runtime-client-only behavior, no local SQLite fallback.
- [x] Active root-session artifact gate is pure; DB-backed root-session loop is quarantined.
- [x] Static gates prevent active runtime/server/CLI/Postgres paths from importing legacy SQLite/local API modules.

## Phase 3 — Verification gates to run before staging completion

### Required local gates

- [x] `npx tsx tests/v2/evolution-static-gates.test.ts`
- [x] `npx tsx tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- [x] `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npx tsx tests/v2/index.test.ts`
- [x] `npm test`
- [x] `npm run web:build`

### Real infra gates, pending infra availability

- [ ] `npm run test:e2e:postgres` with real Postgres/Tork/Pi environment.
- [ ] Validate real sandbox baseline/candidate execution through Tork/Pi.
- [ ] Validate real software-development lifecycle scenarios through Postgres/Tork/Pi.

## Phase 4 — Staging rules

- [x] Use pathspec-based `git add`, never `git add .`.
- [x] Stage move of `tests/e2e-real` to `tests/e2e-legacy-sqlite` as a rename, not as silent delete/loss.
- [x] Exclude generated `.southstar/` runtime state unless explicitly reviewed.
- [x] Inspect each staged diff before commit.
- [x] Each commit must pass its focused gate or be marked as requiring later aggregate verification.

## Phase 5 — Follow-up migration after stabilization

After this pass is committed and verified, migrate one legacy module group at a time:

1. Legacy read-models -> Postgres read-models.
2. Legacy inspection/context builders -> Postgres equivalents.
3. Legacy executor callback/reconcile -> Postgres executor modules.
4. Legacy session recovery persistence -> Postgres dispatcher/checkpoints.
5. Legacy design library storage -> Postgres/runtime-resource or learning-graph model.
6. Legacy quality gates -> Postgres queries or pure gate inputs.
7. Legacy local API -> quarantine/delete once no tests/docs depend on it.
8. Finally remove SQLite production code only after canonical Postgres real E2E passes.

## Completion criteria for this stabilization pass

- [x] Working tree has reviewable staged/committed chunks.
- [x] No active runtime/server/CLI/Postgres path imports legacy SQLite/local APIs.
- [x] Canonical tests pass.
- [x] Web build passes.
- [x] Remaining legacy surfaces are documented as quarantine, not active runtime.
- [x] Real E2E gaps are listed explicitly rather than hidden.

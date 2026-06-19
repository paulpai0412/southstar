# Legacy SQLite quarantine

This directory marks the boundary for compatibility-only SQLite-era runtime APIs while Southstar v2 moves to Postgres/async APIs.

Current policy:

- New production code must use Postgres APIs under `src/v2/db`, `src/v2/stores/postgres-*`, `src/v2/ui-api/postgres-*`, `src/v2/context/postgres-*`, and `src/v2/read-models/postgres-*`.
- Legacy SQLite implementation files outside this directory must carry the `@legacy-sqlite-quarantine` marker until they are moved here or deleted.
- Do not extend quarantined SQLite APIs for new behavior.
- Legacy SQLite real E2E lives under `tests/e2e-legacy-sqlite/`; canonical real E2E is Postgres/Tork/Pi under `tests/e2e-postgres/`.
- DB-backed root-session compatibility lives in `src/v2/legacy/sqlite/root-session.ts`; active `src/v2/agent-runner/root-session.ts` is pure artifact-gate logic only.

# Legacy SQLite Real E2E Suite

This directory contains the pre-Postgres real E2E scenarios that exercise the legacy SQLite/local API runtime surface.

They are intentionally **not canonical** for Southstar v2 anymore. The canonical real E2E suite is:

```bash
npm run test:e2e:postgres
# or
npm run test:e2e:real
```

Run this legacy suite only for migration/debugging of historical behavior:

```bash
npm run test:e2e:legacy-sqlite
```

Rules:

- Do not add new canonical scenarios here.
- Do not import this directory from `tests/e2e-postgres/`.
- Do not point `test:e2e:real` back to this directory.
- New real E2E coverage must use Postgres/Tork/Pi through `tests/e2e-postgres/`.

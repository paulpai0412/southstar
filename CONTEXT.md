# Southstar current architecture context

This repository's active implementation is the Postgres-backed Southstar v2 runtime:

- Runtime and orchestration: `src/v2/`
- Operator/browser API projections: `src/v2/read-models/`, `src/v2/ui-api/`, and `src/v2/server/`
- Active Next.js UI: `web/`
- Persistence: Postgres under the `southstar` schema
- Execution path: scheduler → hand provider → Tork/Pi → callback or observer settlement

## Durable boundaries

1. Goal Design produces an explicit Goal Contract, requirement coverage, and approved Library references.
2. Composition validation is followed by canonical manifest acceptance, including provenance and materialized profile checks.
3. Planner Draft lineage persists the Goal Contract, manifest, coverage, and their hashes before a run is materialized.
4. Runs own immutable manifest truth; tasks, history, runtime resources, sessions, and artifacts are projections or durable evidence of that run.
5. Callback and provider-observer terminal observations settle the same `hand_execution` attempt identity; stale and late callbacks remain audit evidence.
6. Browsers consume read models through the web transport adapter and must not reconstruct runtime truth from raw tables.

## Library and profile rules

- Approved Library graph data is the source for production composition.
- Library file publication, import approval, and startup reconciliation converge through the catalog sync service and its advisory transaction lock.
- Agent Profile overrides are normalized, projected, and materialized through the profile contract; runtime execution uses the materialized profile, not a browser-only interpretation.
- Missing required Library data or unsupported bindings fail closed with persisted diagnostics; there are no automatic alternate selections.

## Historical scope

Documents under `docs/specs/`, `docs/plans/`, `docs/manuals/`, and `docs/decisions/` that explicitly describe Northstar, SQLite, issue-to-PR, or the retired root Next app are historical references. The Southstar dynamic-workflow design and current v2 code/tests take precedence when they conflict. See `docs/adr/README.md` for the active decision index.

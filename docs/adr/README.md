# Active architecture decision index

This directory is the index for decisions that govern the active Southstar v2 implementation. The current source and tests are the final authority; historical documents remain useful context but are not active contracts unless a current module explicitly adopts them.

## Active decisions

- `CONTEXT.md` — current source-of-truth map and durable boundaries.
- `AGENTS.md` — repository working contract, runtime invariants, and verification rules.
- `docs/specs/2026-06-05-southstar-dynamic-workflow-runtime-design.md` — Southstar's generic workflow/runtime direction; use current `src/v2` behavior for details.

## Historical references

- `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`
- `docs/specs/2026-06-01-northstar-skill-phase-command-design.md`
- `docs/specs/2026-06-01-northstar-skill-plan-issues-design.md`
- `docs/plans/` and `docs/manuals/` files whose names or content identify Northstar, SQLite, or issue-to-PR behavior
- `docs/decisions/` entries that predate the Southstar v2 Postgres implementation

When a historical document is needed to explain a compatibility or migration behavior, cite the specific current code/test that still uses it. Do not introduce a new runtime path solely to satisfy historical Northstar terminology.

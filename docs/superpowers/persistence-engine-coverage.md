# Persistence/Engine Coverage Matrix

Scope: Northstar persistence and engine orchestration only: SQLite store, engine cycle, effects/history ordering, and idempotent effect result recording.

| Area | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-03 | Store initialization creates exactly `issues` and `issue_history`, with no additional runtime control-plane tables. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| AC-03 | Issue snapshots persist `runtime_context_json` and history rows persist compact `payload_json`. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| AC-03 | Store writes history before updating snapshots and rolls back staged history if snapshot update fails. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| AC-03 | Store records idempotent command/effect result history without duplicates. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| Store | Active issue listing only returns `claimed`, `running`, `verifying`, and `release_pending`. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| Store | Recent history facts are loaded newest-first internally and returned in chronological order for engine consumption. | `tests/runtime/store.test.ts` | `src/runtime/store.ts` |
| Runtime Engine | Engine loads active snapshots, passes recent `issue_history` facts to event collection, evaluates the pure state machine, commits history/snapshot, then executes effects. | `tests/runtime/engine-cycle.test.ts` | `src/runtime/engine.ts`, `src/runtime/store.ts` |
| Runtime Engine | External effects are not executed if DB commit fails. | `tests/runtime/engine-cycle.test.ts` | `src/runtime/engine.ts` |
| Runtime Engine | If effect execution fails after commit, the committed lifecycle snapshot remains and retryable effect history is recorded idempotently. | `tests/runtime/engine-cycle.test.ts` | `src/runtime/engine.ts`, `src/runtime/store.ts` |

## Notes

- `src/runtime/state-machine.ts` remains pure and is not responsible for SQLite or effect execution.
- Persistence state is limited to the runtime control-plane tables `issues` and `issue_history`.
- External integrations remain injected into the engine through collection and effect execution callbacks for deterministic tests.

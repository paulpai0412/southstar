# Runtime Core Coverage Matrix

Scope: Northstar Runtime Core only: state machine, owner lease, heartbeat, background child runs, workflow generality, and release semantics.

| AC | Runtime Core Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| AC-04 | Validate and execute `issue_to_pr_release` and a workflow without release-stage hard-coding. | `tests/workflow/workflow.test.ts` | `src/types/workflow.ts`, `src/runtime/engine.ts`, `src/runtime/state-machine.ts` |
| AC-06 | Enforce owner lease invariants, duplicate lease rejection, quarantined resume rejection, valid new lease resume, and active issue invariant reporting. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts`, `src/types/control-plane.ts` |
| AC-07 | Heartbeat increments sequence, updates heartbeat timestamps/expiry, rejects bad lease/liveness, and artifact submission does not refresh heartbeat. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts`, `src/types/control-plane.ts` |
| AC-08 | Stage start creates background child runs; child records include identifiers, root session binding, role, status, session, timestamps, and artifact history; child artifacts drive workflow advancement without foreground completion. | `tests/runtime/state-machine.test.ts` | `src/runtime/state-machine.ts`, `src/types/control-plane.ts` |
| AC-10 | Release pass moves to `verified`, release start requires `release_worker` owner lease, confirmed merge completes, unconfirmed merge is rejected, and sync/cleanup failures do not reverse completed lifecycle. | `tests/runtime/state-machine.test.ts`, `tests/fixtures/workflows/issue-to-pr-release.yaml` | `src/runtime/state-machine.ts`, `src/types/control-plane.ts` |

## Notes

- `src/runtime/state-machine.ts` remains pure runtime logic; it does not read or write filesystem, SQLite, GitHub, host SDKs, or shell.
- Persistence, CLI, GitHub/Git adapters, repair, and inspect are outside this Runtime Core goal except where existing tests provide surrounding evidence.
- Runtime core is verified through `npm test` plus source scans required by the goal prompt.

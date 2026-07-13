# Task 3 report — Runtime Startup, Health, And Goal Readiness Guard

Base commit: `8d1d2de` (`docs: correct library reconcile report`)

Implementation commit: `53f5b49` (`feat: require library readiness before goals`)

## Changes

- Added `prepareRuntimeLibraryPg` and made managed runtime startup reconcile the absolute Library root before creating/listening on the runtime server.
- Added classified startup failure persistence/status (`library_not_ready`) and immediate detached-start failure detection.
- Threaded the resolved Library root into the runtime context.
- Added the pre-claim `/api/v2/run-goal` readiness guard with stable JSON 503 output for JSON and SSE callers.
- Added Library readiness to runtime health and made readiness determine health status.
- Added focused lifecycle, run-goal, health, and route tests. Existing unrelated run-goal test setup now seeds a ready readiness resource.

## Verification

```text
$ npx tsc -p tsconfig.json --noEmit --pretty false

Process exited with code 0.
```

```text
$ git diff --check

Process exited with code 0.
```

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts
...
1..12
# tests 12
# pass 12
# fail 0
# cancelled 0
```

```text
$ npx tsx --test --test-name-pattern='run-goal returns structured 503|POST /api/v2/run-goal requires the one-prompt|POST /api/v2/run-goal streams' tests/v2/run-goal-service.test.ts
...
1..3
# tests 3
# pass 3
# fail 0
# cancelled 0
```

```text
$ npx tsx --test tests/v2/runtime-loop-routes.test.ts tests/v2/routes.test.ts
...
1..5
# tests 5
# pass 5
# fail 0
# cancelled 0
```

Requested focused command:

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
...
1..46
# tests 46
# pass 41
# fail 5
# cancelled 0
```

The five failures are pre-existing workspace-discovery failures in unrelated run-goal tests. Each has the same error:

```text
Error: EACCES: permission denied, scandir '/tmp/snap-private-tmp'
    at async readdir (node:internal/fs/promises:955:18)
    at async addPath (src/v2/orchestration/goal-workspace-discovery.ts:56:25)
    at async discoverGoalWorkspace (src/v2/orchestration/goal-workspace-discovery.ts:84:3)
```

The new readiness test passed in that run (`run-goal returns structured 503 before claiming a submission when Library is not ready`), as did all lifecycle and route tests. Unrelated pre-existing worktree changes were not staged or committed.

## Follow-up race fix

Follow-up regression: `start()` now removes the prior `runtime-server-start.failure.json` before launching the detached child. A failure written by that new child remains observable by `waitForPidRecord`; only the stale prior record is cleared.

Follow-up red/green verification:

```text
$ npx tsx --test --test-name-pattern='clears a stale Library startup failure' tests/v2/runtime-server-lifecycle.test.ts
...
not ok 1 - start clears a stale Library startup failure before launching a new child
error: 'Southstar runtime Library is not ready: expected exactly one approved goal_design skill, found 0'
```

After the fix:

```text
$ npx tsx --test --test-name-pattern='clears a stale Library startup failure' tests/v2/runtime-server-lifecycle.test.ts
1..1
# tests 1
# pass 1
# fail 0
```

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts
1..13
# tests 13
# pass 13
# fail 0
```

```text
$ npx tsc -p tsconfig.json --noEmit --pretty false
Process exited with code 0.

$ npx tsx --test tests/v2/runtime-loop-routes.test.ts tests/v2/routes.test.ts
1..5
# tests 5
# pass 5
# fail 0

$ npx tsx --test --test-name-pattern='run-goal returns structured 503|POST /api/v2/run-goal requires the one-prompt|POST /api/v2/run-goal streams' tests/v2/run-goal-service.test.ts
1..3
# tests 3
# pass 3
# fail 0
```

Fresh requested focused command after the race fix:

```text
$ npx tsx --test tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
1..47
# tests 47
# pass 42
# fail 5
# cancelled 0
```

The same five unrelated pre-existing failures remain: `EACCES: permission denied, scandir '/tmp/snap-private-tmp'` from workspace discovery.

# Southstar CubeSandbox Executor Provider Coverage & Verification Audit

## Requirement-to-evidence map

| Requirement | Evidence | Status |
| --- | --- | --- |
| Config-only executor control plane (`provider=tork|cubesandbox`) from `.southstar.yaml` | `src/config/schema.ts`, `src/v2/runtime/dependencies.ts`, `src/v2/cli.ts`, `tests/config/southstar-config.test.ts`, `tests/v2/runtime-dependencies.test.ts` | ✅ |
| Runtime must not use `TORK_BASE_URL`, `CUBESANDBOX_API_URL`, `E2B_API_URL`, `E2B_API_KEY` for executor runtime config | `rg -n "TORK_BASE_URL|CUBESANDBOX_API_URL|E2B_API_URL|E2B_API_KEY" src -S` => no matches; `src/v2/config/env.ts` no longer includes `torkBaseUrl` | ✅ |
| Keep Tork support | `src/v2/executor/tork-provider.ts`, `tests/v2/executor-provider.test.ts`, `tests/v2/local-api.test.ts` | ✅ |
| CubeSandbox SDK adapter/provider implementation | `src/v2/executor/cubesandbox/sdk-client.ts`, `src/v2/executor/cubesandbox/provider.ts`, `tests/v2/cubesandbox-sdk-client.test.ts`, `tests/v2/cubesandbox-provider.test.ts` | ✅ |
| Provider-neutral callback route `/api/v2/executor/callback` | `src/v2/server/routes.ts`, `src/v2/executor/callback.ts`, `tests/v2/server-api.test.ts`, `tests/v2/executor-callback.test.ts` | ✅ |
| Callback binding safety (binding exists + run/task/executor type match) | `src/v2/executor/callback.ts`, `tests/v2/executor-callback.test.ts` (`binding run-task mismatch`, `executor type mismatch`) | ✅ |
| ExecutorRuntimeManager/factory integration | `src/v2/executor/runtime-manager.ts`, `src/v2/executor/factory.ts`, `src/v2/runtime/dependencies.ts`, `tests/v2/executor-runtime-manager.test.ts`, `tests/v2/executor-factory.test.ts` | ✅ |
| Strict cleanup/reconcile/exception handling | cleanup attempts/finalizer in `src/v2/executor/cubesandbox/provider.ts`; orphan reconcile cleanup + timings; tests in `tests/v2/cubesandbox-provider.test.ts`; real-E2E exception scenarios in `tests/e2e-cubesandbox/scenarios/*` | ✅ (code+unit) / ⏳ (real run pending) |
| Executor ops provider-neutral health/read model | `src/v2/ui-api/read-models.ts`, `tests/v2/ui-read-models.test.ts` | ✅ |
| Workflow completion remains evaluator+stop-condition driven (not executor-status-driven) | `src/v2/executor/tork-callback.ts` (`runTaskEvaluatorPipeline`, `evaluateRunStopConditions`), tests in `tests/v2/evaluator-pipeline.test.ts`, `tests/v2/stop-condition.test.ts`; callback-missing scenario enforces no executor-only completion signal | ✅ |
| Real CubeSandbox E2E with quantitative gates and evidence artifacts | `tests/e2e-cubesandbox/*` (env, gates, scenarios, evidence writes) and `package.json` script `test:e2e:cubesandbox` | ⏳ blocked by local CubeSandbox API availability |

## Fresh command verification

### Green commands

- `npm run test:v2` ✅
- `npm test` ✅
- `npm run test:e2e:cubesandbox` ✅ (env-guard test pass; real scenarios skipped when `SOUTHSTAR_CUBESANDBOX_E2E!=1`)

### Real-mode probe (with test key)

Command:

```bash
SOUTHSTAR_CUBESANDBOX_E2E=1 \
SOUTHSTAR_CONFIG=tests/fixtures/southstar/config/.southstar.cubesandbox.yaml \
SOUTHSTAR_TEST_SECRET_cubesandbox_api_key=dummy \
npm run test:e2e:cubesandbox
```

Observed failure:

- `CubeSandbox API unreachable at http://127.0.0.1:3000/health`
- preflight message suggests dev-env commonly uses `http://127.0.0.1:13000`

Port probes at audit time:

- `curl http://127.0.0.1:3000/health` -> connection refused
- `curl http://127.0.0.1:13000/health` -> connection refused

## Commits in this implementation thread

- `72c4c50` feat: wire v2 CLI local runtime deps from .southstar config
- `508164f` test: add real cubesandbox e2e harness and executor health model
- `798fa4b` feat: route runtime API through executor manager and orphan reconcile cleanup
- `6824d27` test: add cubesandbox config fixture and real e2e setup docs
- `7335163` test: harden cubesandbox real e2e metrics and evidence capture
- `20301b1` fix: normalize credential env keys for config refs
- `c795f97` feat: tighten executor callback binding checks and cleanup finalizer attempts
- `e14ae90` test: add cubesandbox e2e API preflight with actionable diagnostics
- `934e901` refactor: remove tork base url from v2 env config loader

## Remaining blocker to close objective

Real CubeSandbox infrastructure is not reachable from this environment. The acceptance objective still requires one successful real run with:

1. Reachable CubeSandbox API URL in `.southstar.yaml`
2. `SOUTHSTAR_CUBESANDBOX_E2E=1`
3. `SOUTHSTAR_TEST_SECRET_cubesandbox_api_key` (or normalized key from configured `api_key_ref`)
4. Callback-reachable host for `/api/v2/executor/callback`
5. Generated evidence JSON + SQLite proof satisfying quantitative gates

Until those are produced, the goal is not complete.

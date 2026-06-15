# CubeSandbox Real E2E

This suite is **real provider acceptance** only when `SOUTHSTAR_CUBESANDBOX_E2E=1`.

## Required env

- `SOUTHSTAR_CUBESANDBOX_E2E=1`
- `SOUTHSTAR_CONFIG=<path-to-cubesandbox-.southstar.yaml>`
- `SOUTHSTAR_TEST_SECRET_<api_key_ref>=<real-api-key>`
- optional: `SOUTHSTAR_CALLBACK_HOST` (default `127.0.0.1`)
- optional: `SOUTHSTAR_E2E_EVIDENCE_DIR` (default `.southstar/evidence/cubesandbox`)

`SOUTHSTAR_CONFIG` must set:

- `executor.provider: cubesandbox`
- `executor.cubesandbox.sdk: e2b-compatible`
- `executor.cubesandbox.api_url`
- `executor.cubesandbox.api_key_ref`
- `executor.cubesandbox.template_id`
- `executor.lifecycle.task_wall_timeout_seconds <= 15` (timeout scenario)
- `executor.lifecycle.callback_wait_timeout_seconds <= 45` (callback-missing scenario)

## Run

```bash
npm run test:e2e:cubesandbox
```

Without `SOUTHSTAR_CUBESANDBOX_E2E=1`, real scenarios are skipped and only fail-closed env validation runs.

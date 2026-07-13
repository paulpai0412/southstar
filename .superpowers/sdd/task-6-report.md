# Task 6 report: startup-proven browser Case 32

Status: complete

Implemented the real startup path for Case 32 without a test-only Library sync list:

- `createRealRuntimeServer` now accepts an optional `libraryRoot` and invokes the production `prepareRuntimeLibraryPg` seam before creating the runtime server.
- Case 32 passes the repository Library root, asserts a startup readiness snapshot and file provenance for the metadata-selected Goal Design skill, and records `/api/workflow/generate` request bodies to ensure skill bodies/ids are not sent by the browser.
- Removed the explicit `syncBaseLibrary` helper and its hardcoded relative-path list.
- Added the named `test:e2e:browser:32` package script.

Focused verification:

```text
npx tsc --noEmit --pretty false
exit 0

npx tsx --test tests/e2e-browser/browser-e2e-static.test.ts
2 tests, 2 pass

git diff --check
exit 0
```

The explicitly requested live Browser/Tork/Postgres Case 32 run was not started in this implementation pass; it requires the managed infrastructure and live Pi/Tork configuration. The test remains runnable with:

```bash
SOUTHSTAR_E2E_PROJECT_CWD=/home/timmypai/apps/southstar-vocab npm run test:e2e:browser:32
```

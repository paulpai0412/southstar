# Northstar Live E2E Coverage Matrix

| Requirement | Test File | Implementation File |
| --- | --- | --- |
| GitHub temporary issue creation with traceable `northstar-smoke-*` audit output. | `tests/e2e-live/github-live-e2e.test.ts` | `src/adapters/github/remote.ts` |
| GitHub label and body/comment projection sync. | `tests/e2e-live/github-live-e2e.test.ts` | `src/adapters/github/remote.ts` |
| GitHub Project v2 sync requires `NORTHSTAR_LIVE_GITHUB_PROJECT_ID`. | `tests/e2e-live/github-live-e2e.test.ts` | `src/adapters/github/remote.ts` |
| GitHub retryable projection failure is recorded without secret leakage. | `tests/e2e-live/github-live-e2e.test.ts` | `src/adapters/github/remote.ts`, `src/adapters/github/projector.ts` |
| OpenCode SDK root and child run through SDK-first boundary. | `tests/e2e-live/host-sdk-live-e2e.test.ts` | `src/adapters/host/opencode.ts`, `src/adapters/host/sdk-loaders.ts` |
| Codex SDK root and child run through SDK-first boundary. | `tests/e2e-live/host-sdk-live-e2e.test.ts` | `src/adapters/host/codex.ts`, `src/adapters/host/sdk-loaders.ts` |
| Live E2E summary metrics and skip/fail environment rules. | `tests/e2e-live/*.test.ts`, `tests/e2e-live/live-env.ts`, `tests/e2e-live/live-metrics.ts` | `package.json` |

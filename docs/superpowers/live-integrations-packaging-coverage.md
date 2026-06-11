# Live Integrations And Packaging Coverage Matrix

Scope: SDK package wiring, live smoke separation, GitHub remote projection tests, CLI binary packaging, and finishing workflow guardrails.

| Area | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| CLI binary packaging | `package.json` exposes `bin.northstar` and `node --run northstar -- --help` works through the executable entrypoint. | `tests/cli/cli.test.ts` | `package.json`, `src/cli/entrypoint.ts`, `src/cli/northstar.ts` |
| CLI executable dispatch | Help can be invoked without loading `.northstar.yaml`; normal commands still dispatch through typed CLI builder. | `tests/cli/cli.test.ts` | `src/cli/entrypoint.ts`, `src/cli/northstar.ts` |
| OpenCode SDK wiring | Concrete OpenCode SDK package name is pinned and dynamically imported through a narrow loader boundary; unit tests use injected fake SDK clients. | `tests/adapters/adapters.test.ts`, `tests/live/host-sdk-live.test.ts` | `package.json`, `src/adapters/host/sdk-loaders.ts`, `src/adapters/host/opencode.ts` |
| Codex SDK wiring | Concrete Codex SDK package name is pinned and dynamically imported through a narrow loader boundary; unit tests use injected fake SDK clients. | `tests/adapters/adapters.test.ts`, `tests/live/host-sdk-live.test.ts` | `package.json`, `src/adapters/host/sdk-loaders.ts`, `src/adapters/host/codex.ts` |
| GitHub remote integration | GitHub label sync, body/comment sync, issue close, Project v2 item sync via issue node discovery + GraphQL mutation, traceable live smoke issue logging, and remote failure-to-retryable-event paths are covered with injected fetch. | `tests/adapters/adapters.test.ts`, `tests/live/github-live.test.ts` | `src/adapters/github/remote.ts`, `src/adapters/github/projector.ts` |
| Live test separation | `npm test` does not require network or credentials; `npm run test:live` explicitly skips when required env is missing. | `tests/live/index.test.ts`, `tests/live/host-sdk-live.test.ts`, `tests/live/github-live.test.ts` | `package.json`, `src/adapters/host/sdk-loaders.ts`, `src/adapters/github/remote.ts` |
| Integration workflow | Commit, push, PR, merge, and discard are left to the finishing-branch user choice. | Final verification report | Superpowers finishing-a-development-branch workflow |

## Live Environment

- OpenCode smoke: `NORTHSTAR_LIVE_OPENCODE=1`
- Codex smoke: `NORTHSTAR_LIVE_CODEX=1`
- GitHub smoke: `NORTHSTAR_LIVE_GITHUB=1`, `GITHUB_TOKEN`, `NORTHSTAR_LIVE_GITHUB_REPO`, `NORTHSTAR_LIVE_GITHUB_PROJECT_ID`

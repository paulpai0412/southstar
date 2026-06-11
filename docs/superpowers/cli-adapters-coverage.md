# CLI/Adapters Coverage Matrix

Scope: CLI config loading and command dispatch, SDK-first host adapters, GitHub projection adapter, Git/worktree adapter, and platform process/path adapters.

Out of scope for this goal: runtime core state-machine behavior, SQLite persistence internals, repair/inspect internals beyond command dispatch, and concrete remote service integrations.

| Area | Requirement | Tests | Implementation |
| --- | --- | --- | --- |
| CLI Surface | Required commands exist: `init`, `intake`, `start`, `reconcile`, `reconcile-workspace`, `heartbeat`, `release`, `repair-runtime`, `inspect`, `retry-sync`; unknown commands are rejected. | `tests/cli/cli.test.ts` | `src/cli/northstar.ts` |
| CLI Surface | Each command loads `.northstar.yaml` or the `--config` override, validates config through the config schema, and creates a typed engine command object. | `tests/cli/cli.test.ts`, `tests/config/load-config.test.ts` | `src/cli/northstar.ts`, `src/config/load-config.ts`, `src/config/schema.ts` |
| CLI Surface | `--project-root` works only as bootstrap/debug override and is carried in engine command bootstrap metadata without mutating argv. | `tests/cli/cli.test.ts` | `src/cli/northstar.ts` |
| Host adapters | `HostAdapter` includes `startRootSession`, `recordHeartbeat`, `startBackgroundChild`, `readRootStatus`, `readChildStatus`, `resumeHint`, and `capabilities`. | `tests/adapters/adapters.test.ts` | `src/types/host.ts`, `src/adapters/host/fake.ts`, `src/adapters/host/opencode.ts`, `src/adapters/host/codex.ts`, `src/adapters/host/pi-worker.ts`, `src/adapters/host/capabilities.ts` |
| Host adapters | OpenCode adapter is SDK-first, shells out to no host CLI, and passes configured `agent`, `model`, `load_skills`, `run_mode`, `timeout_seconds`, and `retry_policy` through request payloads. | `tests/adapters/adapters.test.ts`, `tests/spec/spec-compliance.test.ts` | `src/adapters/host/opencode.ts` |
| Host adapters | Codex adapter is SDK-first, shells out to no host CLI, and passes configured `agent`, `model`, `load_skills`, `run_mode`, `timeout_seconds`, and `retry_policy` through request payloads. | `tests/adapters/adapters.test.ts`, `tests/spec/spec-compliance.test.ts` | `src/adapters/host/codex.ts` |
| GitHub projection adapter | Label, project, body/comment, and issue close sync failures produce retryable projection events with `projection_target`, `status=failed`, `attempt`, `last_error`, `next_retry_at`, and compact `payload`. | `tests/adapters/adapters.test.ts` | `src/adapters/github/projector.ts` |
| GitHub projection adapter | Projection failures are represented as history-ready events and do not mutate lifecycle directly. | `tests/adapters/adapters.test.ts`, `tests/runtime/engine-cycle.test.ts` | `src/adapters/github/projector.ts`, `src/runtime/engine.ts` |
| Git/worktree adapter | Local main sync uses `.northstar/runtime/sync-worktrees/main`; creation and reuse are planned via argv arrays. | `tests/adapters/adapters.test.ts` | `src/adapters/git/worktrees.ts`, `src/adapters/platform/process.ts` |
| Git/worktree adapter | Sync worktree failures produce retryable effect history; repair produces compact `admin_action` history; issue worktree cleanup is planned as retryable effect. | `tests/adapters/adapters.test.ts` | `src/adapters/git/worktrees.ts` |
| Git/worktree adapter | Consumer root worktree never receives `git checkout main` or `git switch main`. | `tests/adapters/adapters.test.ts` | `src/adapters/git/worktrees.ts` |
| Platform adapters | Linux-style and Windows-style path fixtures pass. | `tests/adapters/adapters.test.ts` | `src/adapters/platform/paths.ts` |
| Platform adapters | Process command specs are argv arrays; shell-chain command strings containing `&&`, `||`, or `;` are rejected. | `tests/adapters/adapters.test.ts` | `src/adapters/platform/process.ts` |
| Platform adapters | Production source does not construct shell-chain runtime commands. | `tests/spec/spec-compliance.test.ts` | `src/adapters/platform/process.ts`, `src/adapters/git/worktrees.ts` |
| Test gate | CLI and adapter tests exist, and this coverage matrix maps scoped requirements to tests and implementation files. | `tests/cli/cli.test.ts`, `tests/adapters/adapters.test.ts`, `tests/spec/spec-compliance.test.ts` | `docs/superpowers/cli-adapters-coverage.md` |

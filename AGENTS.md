# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What Northstar is

Northstar (`@northstar/runtime`) is a durable, SDK-first, workflow-driven **control plane** for long-running automation. It is *not* a coding agent — it sits above host runtimes (OpenCode, Codex, Pi) and owns durable workflow state, scheduling, owner leases, background child handoff, verification/release policy, projection, recovery, and audit. Coding-agent delivery (`issue_to_pr_release`) is the first workflow family, not the only supported domain.

The authoritative design + acceptance criteria is `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`. Read it before changing runtime invariants — most non-obvious constraints below come from there.

## Runtime & tooling

- Node `>=22.22.2`, ESM (`"type": "module"`). TypeScript runs **directly** via Node's native type stripping — there is **no build step** and no `tsc`. Source imports use explicit `.ts` extensions (e.g. `import ... from "./store.ts"`). This requires a Node binary built **with** TS support; a build without it fails every script with `ERR_UNKNOWN_FILE_EXTENSION` / `ERR_NO_TYPESCRIPT` (verify with `node --version` ≥ 22.22.2 before assuming a test failure is real).
- No third-party test framework: tests use `node:test` + `node:assert/strict`. Each test file self-runs on import.
- SDK host adapters (`@openai/codex-sdk`, `@opencode-ai/sdk`, `@earendil-works/pi-coding-agent`) are `optionalDependencies` — the runtime and its tests work without them via fake adapters.

## Commands

```bash
npm test                         # full unit/integration suite (tests/index.test.ts)
node --disable-warning=ExperimentalWarning tests/runtime/state-machine.test.ts   # run a single test file
npm run northstar -- <command> --config .northstar.yaml                          # run the CLI locally

npm run test:coverage            # c8 coverage + requirement gates (85% lines/branches/funcs/statements)
npm run test:coverage:code       # c8 code coverage only
```

There is no lint step. The `test:e2e:*` and `test:live`/`test:*:live` scripts drive real hosts/GitHub and require credentials — do not run them as part of routine verification.

`npm test` is the gate to keep green. A single test is run by executing its file path directly (it imports `node:test`, which runs on load).

## Architecture

Data flows **bottom-up**: a pure state machine decides transitions, the engine commits them, the orchestrator wires domain behavior, and adapters perform side effects.

- **`src/runtime/state-machine.ts`** — pure logic. Given (snapshot, workflow, events, policy) it returns lifecycle transitions, snapshot updates, history entries, effects, and operator messages. It must **never** touch fs, shell, SQLite, GitHub, or host SDKs. This purity is load-bearing for repair/replay.
- **`src/runtime/engine.ts`** — the single orchestration loop. Each cycle: load active issues → collect events → evaluate state machine → **commit history+snapshot in one transaction** → execute external effects *only after* commit → record effect results as history for the next cycle. Effects never run before the DB commit.
- **`src/runtime/store.ts`** — SQLite persistence with exactly **two** control-plane tables: `issues` and `issue_history`. Do **not** add runtime tables. New concepts (owner leases, child runs, effect queues, projection state) live inside `issues.runtime_context_json` and audited `issue_history.payload_json`. Every decision appends history *before* updating the snapshot.
- **`src/orchestrator/`** — production wiring. `production-factory.ts` / `cycle.ts` build a running orchestrator; `domain-registry.ts` resolves a `DomainDriver` by workflow domain; `software-dev-driver.ts` is the coding-domain driver; `scheduler.ts`, `issue-flow.ts`, `dependencies.ts`, `worktree-cleanup.ts` cover scheduling/capacity/dependency/cleanup. Other domains (`content_creation`, `office_automation`) are recognized-but-deferred.
- **`src/adapters/`** — all side effects, behind interfaces. `host/` (codex/opencode/pi SDK workers + `fake.ts` + `worker-factory.ts`), `github/` (projection, issues, Projects v2, gateway), `git/` (worktrees), `platform/` (`paths.ts`, `process.ts`).
- **`src/cli/`** — `entrypoint.ts` (bin `northstar`), `northstar.ts` (command parse/help/config load), `watch-command.ts`.
- **`src/config/`** — `schema.ts` + `load-config.ts` for `.northstar.yaml` → typed `RuntimeConfig`.
- **`src/intake/`** — adapter-driven, idempotent intake (GitHub issues + local seeded packets) → normalized issue packets.
- **`src/types/`** — `control-plane.ts`, `host.ts`, `workflow.ts` (+ `loadWorkflow`), `workflow-validation.ts`.
- **`src/operator-dashboard/`** — read models, wizard, and `local-api.ts` consumed by the external pi-web app (`~/apps/pi-web/components/northstar/`).

### Core invariants (enforced by tests; don't break casually)

- **Fixed lifecycle set**: `ready, claimed, running, verifying, verified, release_pending, exception, completed, cancelled, failed, quarantined`. Workflow packages map their stages onto these but must **not** add lifecycle states. Domain-specific names (`drafting`, `publishing`) are rejected by workflow validation. `exception` is a non-active automatic recovery state driven by `workflow.exception_policy`; `quarantined` remains the human-intervention state.
- **Owner lease**: every *active* issue (`claimed/running/verifying/release_pending`) must hold one valid `owner_lease` in `runtime_context_json`. `resume quarantined -> running` requires a new or host-confirmed live lease. Heartbeat updates lease liveness only — artifact submission must **not** refresh the heartbeat.
- **Effects after commit**: external effects run only after the DB transaction; effect results become history rows next cycle. The state machine advances from child events + persisted artifact facts, never from foreground task return.
- **Projection is eventual**: GitHub labels/body/comments/Projects/close and stats are projections. Projection failure records retryable `issue_history` but must **never** move an issue to `failed`/`quarantined`. `inspect` shows lifecycle state separately from projection state.
- **Release semantics**: for the software-development workflow, completion is driven by a schema-valid `release_result` artifact with `status=completed` and `release.confirmed=true`. Northstar validates artifact shape and required fields only; PR existence, branch state, and merge-commit existence are not lifecycle truth. Post-completion sync/cleanup/close failures are retryable effects and must **not** reverse `completed`.
- **Cross-platform**: Windows + Linux. Represent external commands as **argv arrays**, never shell-chain strings (`&&`/`||`/`;`). Keep OS process handling behind `platform/`, git behind `git/`.
- **Config-only**: all runtime config comes from schema-validated `.northstar.yaml` → `RuntimeConfig`. Runtime modules may read **only** `NORTHSTAR_CONFIG`, `NORTHSTAR_PROJECT_ROOT`, `NORTHSTAR_DEBUG` from `process.env` (a test enforces this).
- **Secrets/size**: redact token-shaped values in logs/history/inspect; reject artifact payloads carrying raw transcripts/large logs.

## Workflows (YAML packages)

Workflows are YAML, not code. A package declares `id, version, roles, stages` (+ optional `domain, gates, artifact_schemas, event_mappings, effects, projection_targets, policies`). Stages carry a `lifecycle_state` + a `role` + success/blocked/retryable/terminal transitions. Validation (`workflow-validation.ts`) emits stable machine-readable error codes and rejects: missing role/stage targets, unknown lifecycle states, role artifacts without a schema, domain lifecycle names, retry cycles without a policy, and host fields unsupported by the adapter.

Built-in artifact kinds: `worker_result`, `evidence_packet`, `implementation_result`, `verification_result`, `release_result`. Fixtures live in `tests/fixtures/workflows/` (valid families incl. `content-creation-publish`, `office-report-delivery`; invalid cases under `invalid/`). When adding/altering workflow behavior, add a fixture rather than a runtime branch.

## Operator skill

`skills/northstar/` is a global Codex skill for *operating* Northstar from a consumer repo (phase commands `/northstar-plan|setup|execute|observe|recover|report`). Its `.mjs` scripts under `scripts/lib/` are covered by `tests/skills/*`. `npm run skill:sync` / `skill:doctor` / `skill:render-config` manage it. This skill is separate from the runtime — changing one rarely requires changing the other.

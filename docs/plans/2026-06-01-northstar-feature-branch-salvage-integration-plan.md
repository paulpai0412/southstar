# Northstar Feature Branch Salvage Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely recover valid work from `origin/codex/opencode-full-live-e2e` and `stash@{0}` into `main` without landing stale, unrelated, or unverified changes.

**Architecture:** Do not merge the 144-commit feature branch directly. Create small integration branches from current `main`, salvage one feature slice at a time, run the relevant offline verification gates, then merge via focused PRs or reviewed local merges.

**Tech Stack:** Git, Node.js test runner, existing Northstar TypeScript runtime, repository-local skill files.

---

## Current Evidence

As of 2026-06-01:

```text
main...origin/codex/opencode-full-live-e2e = 3 144
```

Meaning:

- `main` has 3 commits not present in the old feature branch.
- `origin/codex/opencode-full-live-e2e` has 144 commits not present in `main`.
- `stash@{0}` preserves additional uncommitted work from `codex/opencode-full-live-e2e`.

Important refs:

```text
main: 485665e Merge remote-tracking branch 'origin/main'
origin/codex/opencode-full-live-e2e: 3c5cfac fix: base issue worktrees on sync worktree
stash@{0}: On codex/opencode-full-live-e2e: preserve codex/opencode-full-live-e2e before switching main
```

Do not delete:

- `origin/codex/opencode-full-live-e2e`
- local `codex/opencode-full-live-e2e`
- `stash@{0}`

## Integration Policy

- Do not run `git merge origin/codex/opencode-full-live-e2e` into `main`.
- Do not `stash pop` onto `main`.
- Do not use `git reset --hard`.
- Salvage by topic, not by raw branch history.
- Each salvage branch starts from current `main`.
- Each branch must pass its own verification gate before integration.
- Live tests remain opt-in and must not block offline recovery unless the slice is explicitly live-only.

## Salvage Slices

| Slice | Purpose | Source Areas | Risk | Priority |
| --- | --- | --- | --- | --- |
| S1 | Northstar skill set | `skills/northstar`, `tests/skills`, skill scripts in `package.json` | Medium | P0 |
| S2 | plan-issues implementation | `src/planning`, `src/adapters/github/plan-issues.ts`, `tests/planning`, `tests/e2e-plan-issues` | Medium | P0 |
| S3 | production orchestrator core | `src/orchestrator`, orchestrator tests, CLI/watch integration | High | P1 |
| S4 | GitHub observability and projection recovery | `src/adapters/github/*`, `src/orchestrator/cycle.ts`, runtime repair/inspect | High | P1 |
| S5 | production software-dev driver and adapters | Git/worktree, host workers, software-dev driver | High | P1 |
| S6 | live/product hardening E2E suites | `tests/e2e-*live*`, training docs, live metrics | High | P2 |
| S7 | docs and coverage matrices | docs/manuals, docs/superpowers coverage files, training docs | Low | P2 |

## Preflight Commands

- [ ] Confirm current branch and cleanliness:

```bash
git status -sb
git branch --show-current
git rev-list --left-right --count main...origin/codex/opencode-full-live-e2e
git stash list --max-count=3
```

Expected:

```text
## main...origin/main
main
3 144
stash@{0}: On codex/opencode-full-live-e2e: preserve codex/opencode-full-live-e2e before switching main
```

- [ ] Preserve an audit snapshot:

```bash
git diff --name-status main...origin/codex/opencode-full-live-e2e > /tmp/northstar-feature-branch-diff.txt
git log --oneline --reverse main..origin/codex/opencode-full-live-e2e > /tmp/northstar-feature-branch-commits.txt
git stash show --name-status stash@{0} > /tmp/northstar-stash-diff.txt
```

Expected:

```text
/tmp/northstar-feature-branch-diff.txt exists
/tmp/northstar-feature-branch-commits.txt exists
/tmp/northstar-stash-diff.txt exists
```

---

## Task S1: Salvage Northstar Skill Set First

**Goal:** Bring a coherent `skills/northstar` package back to `main`, aligned with `docs/specs/2026-06-01-northstar-skill-phase-command-design.md` and `docs/plans/2026-06-01-northstar-skill-phase-command-implementation-plan.md`.

**Files to recover or recreate:**

- `skills/northstar/**`
- `tests/skills/**`
- `package.json` skill scripts only
- `tests/index.test.ts` skill test imports only

**Do not recover in this slice:**

- `src/orchestrator/**`
- production GitHub adapters
- live E2E suites
- unrelated runtime changes

Steps:

- [ ] Create a new branch from `main`:

```bash
git switch main
git switch -c codex/salvage-northstar-skill
```

- [ ] Recover skill files from the old branch:

```bash
git restore --source=origin/codex/opencode-full-live-e2e -- skills/northstar tests/skills
```

- [ ] Recover only package script hunks manually. Do not copy the full `package.json` blindly.

Required scripts:

```json
"skill:doctor": "node skills/northstar/scripts/doctor.mjs",
"skill:sync": "node skills/northstar/scripts/sync-global.mjs",
"skill:render-config": "node skills/northstar/scripts/render-config.mjs"
```

- [ ] Recover only skill test imports in `tests/index.test.ts`.

Expected imports:

```ts
import "./skills/northstar-config-renderer.test.ts";
import "./skills/northstar-doctor.test.ts";
import "./skills/northstar-operator-commands.test.ts";
import "./skills/northstar-platform.test.ts";
import "./skills/northstar-portability.test.ts";
import "./skills/northstar-project-viewer.test.ts";
import "./skills/northstar-recovery.test.ts";
import "./skills/northstar-setup-flow.test.ts";
import "./skills/northstar-skill-files.test.ts";
import "./skills/northstar-spec-plan-intake.test.ts";
import "./skills/northstar-sync.test.ts";
```

- [ ] Align `skills/northstar/SKILL.md` with phase command design:

Required commands:

```text
/northstar-plan
/northstar-setup
/northstar-execute
/northstar-observe
/northstar-recover
/northstar-report
/northstar-init
/northstar-watch
/northstar-status
/northstar-recovery
/northstar-grill
/northstar-to-spec
/northstar-to-plan
/northstar-to-issues
```

- [ ] Run verification:

```bash
npm test
npm run skill:doctor
node skills/northstar/scripts/sync-global.mjs --target /tmp/northstar-global-skill-check
rg "GITHUB_TOKEN|NORTHSTAR_PRODUCTION_LIVE|NORTHSTAR_FULL_LIVE|OPENAI_API_KEY|OPENCODE" skills/northstar tests/skills
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|argv: \\[[^\\n]*(?:&&|\\|\\||;)" skills/northstar/scripts
git status --short
```

Expected:

- `npm test` passes.
- `skill:doctor` reports zero failed checks.
- global sync simulation succeeds.
- credential scan has no runtime dependency on live secrets.
- shell-chain source scan has no runtime command construction matches.

- [ ] Commit:

```bash
git add package.json skills/northstar tests/skills tests/index.test.ts
git commit -m "feat: restore northstar skill set"
```

---

## Task S2: Salvage Plan-Issues Implementation

**Goal:** Restore the production `northstar plan-issues` workflow after the skill package is stable.

**Files to recover:**

- `src/planning/**`
- `src/adapters/github/plan-issues.ts`
- `tests/planning/**`
- `tests/adapters/github-plan-issues.test.ts`
- `tests/cli/plan-issues-cli.test.ts`
- `tests/e2e-plan-issues/**`
- `tests/fixtures/plan-issues/**`
- `docs/plan-issues-coverage.md`
- `docs/specs/2026-06-01-northstar-skill-plan-issues-design.md`
- `docs/plans/2026-06-01-northstar-skill-plan-issues-implementation-plan.md`

Steps:

- [ ] Create branch from updated `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/salvage-plan-issues
```

- [ ] Restore files:

```bash
git restore --source=origin/codex/opencode-full-live-e2e -- src/planning src/adapters/github/plan-issues.ts tests/planning tests/adapters/github-plan-issues.test.ts tests/cli/plan-issues-cli.test.ts tests/e2e-plan-issues tests/fixtures/plan-issues docs/plan-issues-coverage.md docs/specs/2026-06-01-northstar-skill-plan-issues-design.md docs/plans/2026-06-01-northstar-skill-plan-issues-implementation-plan.md
```

- [ ] Manually merge CLI entrypoint changes needed for `plan-issues`.

Review from old branch:

```bash
git diff main...origin/codex/opencode-full-live-e2e -- src/cli/entrypoint.ts src/cli/northstar.ts package.json tests/index.test.ts
```

- [ ] Run verification:

```bash
npm test
node --run northstar -- plan-issues --help
rg "process\\.env\\." src/planning src/adapters/github/plan-issues.ts tests/planning tests/e2e-plan-issues
git status --short
```

- [ ] Commit:

```bash
git add src/planning src/adapters/github/plan-issues.ts tests/planning tests/adapters/github-plan-issues.test.ts tests/cli/plan-issues-cli.test.ts tests/e2e-plan-issues tests/fixtures/plan-issues docs/plan-issues-coverage.md docs/specs/2026-06-01-northstar-skill-plan-issues-design.md docs/plans/2026-06-01-northstar-skill-plan-issues-implementation-plan.md src/cli package.json tests/index.test.ts
git commit -m "feat: restore northstar plan-issues workflow"
```

---

## Task S3: Salvage Production Orchestrator Core

**Goal:** Restore workflow-general production orchestrator core without live adapters first.

**Files to recover:**

- `src/orchestrator/dependencies.ts`
- `src/orchestrator/domain-driver.ts`
- `src/orchestrator/domain-registry.ts`
- `src/orchestrator/host-dispatch.ts`
- `src/orchestrator/inspect.ts`
- `src/orchestrator/issue-flow.ts`
- `src/orchestrator/metrics.ts`
- `src/orchestrator/scheduler.ts`
- `src/orchestrator/workflow-path.ts`
- `tests/orchestrator/dependencies.test.ts`
- `tests/orchestrator/domain-driver.test.ts`
- `tests/orchestrator/domain-registry.test.ts`
- `tests/orchestrator/host-dispatch.test.ts`
- `tests/orchestrator/inspect.test.ts`
- `tests/orchestrator/issue-flow.test.ts`
- `tests/orchestrator/scheduler.test.ts`
- `tests/orchestrator/workflow-generality.test.ts`

Do not recover in this slice:

- production GitHub gateway
- software-dev driver
- live E2E
- worktree cleanup

Verification:

```bash
npm test
rg "issue_worker.*pr_verifier.*release_worker|release == GitHub merge" src/orchestrator tests/orchestrator
rg "fetch\\(|spawn\\(|execFile\\(|DatabaseSync" src/orchestrator
git status --short
```

Expected:

- Tests pass.
- No hard-coded role chain.
- No direct external effects in pure orchestrator helpers.

---

## Task S4: Salvage GitHub Observability And Projection Recovery

**Goal:** Restore the fixes for Project item creation, completed projection retry, retry-sync behavior, completed reconcile idempotency, lifecycle label exclusivity, and duplicate merged PR prevention.

**Files to recover or rework carefully:**

- `src/adapters/github/issues.ts`
- `src/adapters/github/observability.ts`
- `src/adapters/github/project-v2.ts`
- `src/orchestrator/cycle.ts`
- `src/runtime/repair.ts`
- `src/runtime/redaction.ts`
- `tests/adapters/github-issues.test.ts`
- `tests/adapters/github-observability.test.ts`
- `tests/adapters/github-project-v2.test.ts`
- `tests/orchestrator/error-recovery.test.ts`
- `tests/orchestrator/watch-orchestrator.test.ts`
- `tests/runtime/repair-inspect.test.ts`

Acceptance:

- Missing Project item is created or recoverable.
- Completed projection failure retries after active issue count is zero.
- `retry-sync --issue` does real projection repair.
- `reconcile --issue` on completed issue does not create a new PR.
- Lifecycle labels are mutually exclusive.
- Closed issue plus merged PR reconciles to completed.
- Same issue does not create a second release PR.

Verification:

```bash
npm test
node --run northstar -- retry-sync --help
node --run northstar -- reconcile --help
rg "projection_failed|project_projection_synced|northstar:completed" src tests
git status --short
```

---

## Task S5: Salvage Production Software-Dev Driver And Real Dependency Factory

**Goal:** Restore real production CLI/watch dependency wiring after the core orchestrator and projection recovery are stable.

**Files to recover:**

- `src/adapters/git/executor.ts`
- `src/adapters/git/software-dev-worktree.ts`
- `src/adapters/git/worktrees.ts`
- `src/adapters/github/software-dev-gateway.ts`
- `src/adapters/host/codex-worker.ts`
- `src/adapters/host/opencode-worker.ts`
- `src/adapters/host/worker-factory.ts`
- `src/orchestrator/production-dependencies.ts`
- `src/orchestrator/production-factory.ts`
- `src/orchestrator/software-dev-driver.ts`
- `src/orchestrator/worktree-cleanup.ts`
- related tests under `tests/adapters` and `tests/orchestrator`

Verification:

```bash
npm test
rg "&&|\\|\\||;" src/adapters src/orchestrator tests/adapters tests/orchestrator
rg "paulpai0412/northstar-live-sandbox" src
rg "process\\.env\\." src
git status --short
```

Expected:

- Production source is repo-configurable.
- No sandbox hardcode in `src`.
- No shell-chain commands.
- SDK credentials are read through configured credential providers, not written to history.

---

## Task S6: Salvage Live And Product Hardening E2E As Opt-In Suites

**Goal:** Restore live E2E suites only after offline production behavior passes.

**Files to recover:**

- `tests/e2e-full-live-opencode/**`
- `tests/e2e-product-hardening-live/**`
- `tests/e2e-production-cli-watch/**`
- `tests/e2e-production-live/**`
- `tests/e2e-production-live-worktree/**`
- relevant package scripts

Verification:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
npm run test:e2e:production-live
npm run test:e2e:production-live-worktree
git status --short
```

Expected:

- Live commands skip clearly when live flags or credentials are missing.
- `npm test` and offline E2E do not require live credentials.
- Live suites remain separate from default tests.

---

## Task S7: Salvage Docs, Coverage Matrices, And Training Artifacts

**Goal:** Restore docs that still describe implemented behavior after slices S1-S6 are integrated.

Recover docs only when the corresponding implementation slice is merged.

Examples:

- global skill docs after S1
- plan-issues docs after S2
- orchestrator docs after S3
- production CLI/watch docs after S5
- product hardening docs after S6

Verification:

```bash
rg "deferred|not implemented|TODO|fake|smoke" docs skills/northstar
npm test
git status --short
```

Expected:

- Docs do not claim live or production behavior that has not been restored.

---

## Final Integration Gate

After all selected slices are merged into `main`:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
node --run northstar -- --help
node --run northstar -- watch --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests skills
rg "process\\.env\\." src
rg "paulpai0412/northstar-live-sandbox" src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src skills tests
git status --short
```

Expected:

- Offline gates pass.
- Live-only tests remain opt-in.
- No sandbox repo hardcode in production source.
- No legacy autodev/Python runtime dependency.
- Main is clean and synchronized with GitHub.

## Recommended Execution Order

1. S1: Northstar skill set.
2. S2: plan-issues implementation.
3. S3: production orchestrator core.
4. S4: GitHub observability/projection recovery.
5. S5: production software-dev driver and dependency factory.
6. S6: live/product hardening E2E.
7. S7: docs and training artifacts.

This order restores user-facing operator capability first, then planning-to-issues, then production execution, then live evidence.

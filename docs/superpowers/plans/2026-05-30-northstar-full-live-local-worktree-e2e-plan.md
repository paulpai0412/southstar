# Northstar Full Live Local Worktree Production E2E Plan

> REQUIRED SUB-SKILLS: Use `superpowers:executing-plans`, `superpowers:test-driven-development`, `superpowers:systematic-debugging`, and `superpowers:verification-before-completion`.

## Goal

Verify the missing full live local-worktree production path with real production CLI/default factory dependencies:

`GitHub issue -> northstar:ready -> CLI intake -> local issue worktree -> SDK worker modifies worktree -> git add/commit/push -> PR create/reuse -> verifier -> merge -> close issue -> runtime completed`.

This plan intentionally does not use the existing production-live fixture gateway branch shortcut. It uses the general production factory and the real GitHub gateway, git worktree operator, and SDK worker factory.

## Task 1: Add Live Worktree E2E Command Skeleton

Files:
- `package.json`
- `tests/e2e-production-live-worktree/index.test.ts`

Steps:
- [ ] Write a failing test command for `npm run test:e2e:production-live-worktree`.
- [ ] Add clear skip behavior when `NORTHSTAR_PRODUCTION_LIVE_WORKTREE !== "1"`.
- [ ] Verify RED by running the new command before the script or test exists.
- [ ] Add the script and minimal test file.
- [ ] Verify GREEN for the clear-skip path.

## Task 2: Force SDK Workers To Use The Issue Worktree

Files:
- `tests/adapters/sdk-workers.test.ts`
- `src/adapters/host/codex-worker.ts`
- `src/adapters/host/opencode-worker.ts`

Steps:
- [ ] Write failing tests proving Codex and OpenCode prefer `input.worktree_path` over constructor `workingDirectory`.
- [ ] Verify RED.
- [ ] Update both SDK worker implementations to use the input worktree path for implementation runs.
- [ ] Verify GREEN with `npm test`.

## Task 3: Add Deterministic Local Worktree Live Harness

Files:
- `tests/e2e-production-live-worktree/index.test.ts`
- `tests/e2e-production-live-worktree/local-worktree-live.test.ts`
- `tests/e2e-production-live-worktree/harness.ts`

Steps:
- [ ] Write a failing live/offline test that asserts the harness exports all required metrics and forbids fixture gateway shortcut usage.
- [ ] Implement a harness that:
  - Creates a temporary consumer clone/workspace of `NORTHSTAR_LIVE_GITHUB_REPO`.
  - Writes a consumer `.northstar.yaml`.
  - Writes a workflow file with a prompt requiring the SDK worker to create a deterministic file in the issue worktree.
  - Creates a real GitHub issue and applies `northstar:ready`.
  - Runs real `node src/cli/entrypoint.ts intake/start/reconcile/release/inspect` as separate processes with argv arrays.
  - Uses `GIT_ASKPASS` backed by `GITHUB_TOKEN` from environment without writing secrets into the repo.
  - Opens SQLite after the run and verifies `completed` lifecycle and confirmed merge history.
- [ ] Verify RED for missing harness behavior.
- [ ] Implement the harness minimally.
- [ ] Verify GREEN for non-live structural tests and clear skip.

## Task 4: Live Verification

Steps:
- [ ] Run the clear-skip command without live flag.
- [ ] Run the live command:
  `GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE_WORKTREE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live-worktree`
- [ ] If GitHub/Git/SDK/API mismatch occurs, use systematic debugging before changing code.
- [ ] Capture issue URL, PR URL, merge SHA, and all quantitative metrics.

## Task 5: Final Verification Gate

Run:
- [ ] `npm test`
- [ ] `npm run test:e2e`
- [ ] `npm run test:e2e:daemon`
- [ ] `npm run test:e2e:exceptions`
- [ ] `npm run test:e2e:production-cli-watch`
- [ ] `npm run test:coverage`
- [ ] `npm run test:e2e:production-live-worktree` without live flag
- [ ] live worktree command with GitHub token
- [ ] `node --run northstar -- --help`
- [ ] `node --run northstar -- watch --help`
- [ ] safety `rg` scans from the goal prompt
- [ ] `git status --short`

## Acceptance Metrics

The live worktree command must output and assert:

- `live_worktree_issues_created >= 1`
- `live_worktrees_created >= 1`
- `live_worktree_paths_under_consumer_root = 1`
- `live_sdk_working_directory_is_worktree = 1`
- `live_sdk_modified_worktree_files >= 1`
- `live_git_add_commands >= 1`
- `live_git_commit_commands >= 1`
- `live_git_push_commands >= 1`
- `live_branches_pushed >= 1`
- `live_prs_created_or_reused >= 1`
- `live_prs_merged >= 1`
- `live_confirmed_merge_facts >= 1`
- `live_runtime_completed >= 1`
- `live_github_issues_closed >= 1`
- `live_resume_reuses_existing_worktree = 1`
- `live_resume_reuses_existing_branch = 1`
- `live_resume_reuses_existing_pr = 1`
- `live_duplicate_prs_created = 0`
- `live_completed_reversals = 0`
- `live_fixture_gateway_shortcuts_used = 0`
- `live_shell_chain_commands = 0`
- `live_secret_leaks = 0`

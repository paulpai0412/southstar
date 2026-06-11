# Northstar Live Smoke And Git Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Actually run Northstar live SDK and GitHub project smoke tests when credentials/configuration are available, then offer finishing-branch git integration choices without mutating git state until the user chooses.

**Architecture:** Do not change runtime core, state-machine, or SQLite store. This is an execution/configuration plan: verify SDK packages, install only with approval, inspect live environment without printing secrets, run live tests, and use Superpowers finishing-a-development-branch for commit/PR/merge options.

**Tech Stack:** Node 22.22+, npm optional dependencies, `node:test`, GitHub REST/Project live environment variables, Superpowers finishing workflow.

---

## Task 1: Baseline And Safety Checks

**Files:**
- Read: `package.json`
- Read: `tests/live/host-sdk-live.test.ts`
- Read: `tests/live/github-live.test.ts`

- [ ] **Step 1: Confirm branch**

Run:

```bash
git branch --show-current
```

Expected: `codex-execute-northstar-full-plan`.

- [ ] **Step 2: Verify unit baseline**

Run:

```bash
npm test
```

Expected: PASS.

## Task 2: SDK Package Install/Verification

**Files:**
- Read/modify if npm install changes it: `package.json`
- Read/modify if npm install creates it: `package-lock.json`

- [ ] **Step 1: Check whether SDK packages are installed locally**

Run:

```bash
npm ls opencode-ai @openai/codex-sdk
```

Expected: both packages installed, or npm reports missing packages.

- [ ] **Step 2: If missing, install with approval**

Run only after approval/escalation:

```bash
npm install
```

Expected: optional SDK dependencies installed or a clear npm package resolution error. If a package name/version is invalid, use systematic-debugging before changing package pins.

## Task 3: Live Environment Readiness

**Files:**
- No repo writes expected

- [ ] **Step 1: Check live env presence without printing values**

Run:

```bash
test -n "${NORTHSTAR_LIVE_OPENCODE:-}" && echo NORTHSTAR_LIVE_OPENCODE=set || echo NORTHSTAR_LIVE_OPENCODE=missing
test -n "${NORTHSTAR_LIVE_CODEX:-}" && echo NORTHSTAR_LIVE_CODEX=set || echo NORTHSTAR_LIVE_CODEX=missing
test -n "${NORTHSTAR_LIVE_GITHUB:-}" && echo NORTHSTAR_LIVE_GITHUB=set || echo NORTHSTAR_LIVE_GITHUB=missing
test -n "${GITHUB_TOKEN:-}" && echo GITHUB_TOKEN=set || echo GITHUB_TOKEN=missing
test -n "${NORTHSTAR_LIVE_GITHUB_REPO:-}" && echo NORTHSTAR_LIVE_GITHUB_REPO=set || echo NORTHSTAR_LIVE_GITHUB_REPO=missing
test -n "${NORTHSTAR_LIVE_GITHUB_PROJECT_ID:-}" && echo NORTHSTAR_LIVE_GITHUB_PROJECT_ID=set || echo NORTHSTAR_LIVE_GITHUB_PROJECT_ID=missing
```

Expected: all required vars set for non-skipped live execution. If any required var is missing, stop and report the exact missing names.

## Task 4: Run Live Smoke

**Files:**
- No repo writes expected unless live test implementation needs a bug fix

- [ ] **Step 1: Run live tests**

Run:

```bash
npm run test:live
```

Expected: live SDK tests and GitHub test actually run, not all skip. If any skip remains, report the exact skipped requirement.

- [ ] **Step 2: Confirm GitHub project sync evidence**

Expected: GitHub live output includes a traceable `northstar-smoke-*` issue number or URL, or a clear failure pointing to missing/invalid GitHub Project configuration.

## Task 5: Fresh Verification Gate

**Files:**
- No production edit expected

- [ ] **Step 1: Run all required verification**

Run:

```bash
npm test
npm run test:live
node --run northstar -- --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
git status --short
```

Expected: unit tests pass, live tests include actual execution evidence or a precise missing config list, CLI help prints, source scans have no forbidden hits.

## Task 6: Finishing Branch Choice

**Files:**
- Git state only after user choice

- [ ] **Step 1: Use finishing-a-development-branch**

Present exactly:

```text
Implementation complete. What would you like to do?

1. Merge back to main locally
2. Push and create a Pull Request
3. Keep the branch as-is
4. Discard this work

Which option?
```

Expected: no commit, push, PR, merge, or discard before the user chooses.

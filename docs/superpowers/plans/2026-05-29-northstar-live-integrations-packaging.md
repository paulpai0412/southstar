# Northstar Live Integrations And Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live-integration boundaries and packaging for Northstar without making unit tests depend on network, GitHub credentials, or host runtime credentials.

**Architecture:** Keep existing runtime core, state machine, and SQLite store intact. Add narrow SDK loader modules for OpenCode and Codex, a GitHub remote adapter with injected fetch for unit tests and real `fetch` for live tests, and an executable CLI entrypoint that dispatches through the existing CLI builder. Live tests run under `npm run test:live` and explicitly skip with actionable reasons when required environment is missing.

**Tech Stack:** Node 22.22+, TypeScript type stripping, `node:test`, built-in `fetch`, optional dynamic imports for SDK packages, no host CLI shell-out, no Python/autodev runtime dependency.

---

## Task 1: Baseline And Plan Review

**Files:**
- Read: `package.json`
- Read: `src/adapters/host/opencode.ts`
- Read: `src/adapters/host/codex.ts`
- Read: `src/adapters/github/projector.ts`
- Read: `src/cli/northstar.ts`

- [ ] **Step 1: Verify current branch**

Run:

```bash
git branch --show-current
```

Expected: `codex-execute-northstar-full-plan`.

- [ ] **Step 2: Run baseline unit tests**

Run:

```bash
npm test
```

Expected: PASS.

---

## Task 2: Package Scripts, Binary Entrypoint, And CLI Help

**Files:**
- Modify: `package.json`
- Modify: `src/cli/northstar.ts`
- Create: `src/cli/entrypoint.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing tests for help and executable dispatch**

Add tests that assert:

```ts
assert.match(formatNorthstarHelp(), /northstar init/);
assert.match(formatNorthstarHelp(), /northstar retry-sync/);
```

and use `execFileSync(process.execPath, [entrypointPath, "--help"], { encoding: "utf8" })` to assert the executable prints help without requiring `.northstar.yaml`.

Run:

```bash
npm test
```

Expected before implementation: FAIL because `formatNorthstarHelp` and/or `src/cli/entrypoint.ts` do not exist.

- [ ] **Step 2: Implement minimal CLI entrypoint and package metadata**

Add:

```json
"bin": { "northstar": "src/cli/entrypoint.ts" },
"scripts": {
  "test": "node --disable-warning=ExperimentalWarning tests/index.test.ts",
  "test:live": "node --disable-warning=ExperimentalWarning tests/live/index.test.ts",
  "northstar": "node src/cli/entrypoint.ts"
}
```

Implement `formatNorthstarHelp()` and `main(argv)` in `src/cli/entrypoint.ts`.

Run:

```bash
npm test
node --run northstar -- --help
```

Expected: PASS and help text printed.

---

## Task 3: OpenCode/Codex SDK Package Wiring

**Files:**
- Modify: `package.json`
- Modify: `docs/decisions/2026-05-29-runtime-dependencies.md`
- Create: `src/adapters/host/sdk-loaders.ts`
- Modify: `src/adapters/host/opencode.ts`
- Modify: `src/adapters/host/codex.ts`
- Modify: `tests/adapters/adapters.test.ts`

- [ ] **Step 1: Write failing SDK loader tests**

Add tests that call:

```ts
assert.equal(opencodeSdkPackageName(), "opencode-ai");
assert.equal(codexSdkPackageName(), "@openai/codex-sdk");
assert.match(openCodeLoader.toString(), /import\("opencode-ai"\)/);
assert.match(codexLoader.toString(), /import\("@openai\/codex-sdk"\)/);
```

Run:

```bash
npm test
```

Expected before implementation: FAIL because SDK loader functions do not exist.

- [ ] **Step 2: Implement minimal dynamic SDK loader boundary**

Create loader functions that dynamically import the concrete package names but are not invoked by unit tests. Keep adapters accepting injected SDK clients for unit tests.

Run:

```bash
npm test
```

Expected: PASS.

---

## Task 4: GitHub Remote Adapter And Unit Tests

**Files:**
- Create: `src/adapters/github/remote.ts`
- Modify: `tests/adapters/adapters.test.ts`

- [ ] **Step 1: Write failing unit tests with injected fetch**

Add tests for a `GitHubRemoteProjectionAdapter` that assert:

```ts
await adapter.syncLabel({ issue_number: 1, labels: ["northstar-smoke-test"] });
await adapter.syncBodyComment({ issue_number: 1, body: "northstar-smoke-body" });
await adapter.closeIssue({ issue_number: 1 });
```

The fake fetch should capture GitHub REST URLs and methods. Add a failure test where fake fetch returns status 500 and adapter returns a retryable projection event from `projectionFailureEvent`.

Run:

```bash
npm test
```

Expected before implementation: FAIL because remote adapter does not exist.

- [ ] **Step 2: Implement remote adapter with injected fetch**

Implement only label sync, body/comment sync, issue close, and retryable projection failure conversion. Project sync may return a clear skip result when no project config is provided.

Run:

```bash
npm test
```

Expected: PASS.

---

## Task 5: Live Smoke Tests

**Files:**
- Create: `tests/live/index.test.ts`
- Create: `tests/live/host-sdk-live.test.ts`
- Create: `tests/live/github-live.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add live test suite with explicit skip reasons**

Live tests must read environment only from `tests/live/**` and skip with clear messages when missing:

- `NORTHSTAR_LIVE_OPENCODE=1`
- `NORTHSTAR_LIVE_CODEX=1`
- `NORTHSTAR_LIVE_GITHUB=1`
- `GITHUB_TOKEN`
- `NORTHSTAR_LIVE_GITHUB_REPO`

Run:

```bash
npm run test:live
```

Expected without env: PASS with skipped tests and actionable skip reasons.

- [ ] **Step 2: Ensure live GitHub test uses traceable smoke names**

GitHub live tests must use `northstar-smoke-*` labels/comments/titles and either create a temporary issue or use a configured issue.

Run:

```bash
npm run test:live
```

Expected without env: skipped. Expected with env: real remote smoke executes.

---

## Task 6: Coverage Matrix And Final Verification

**Files:**
- Create: `docs/superpowers/live-integrations-packaging-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Write coverage matrix and compliance test**

Add a matrix mapping SDK wiring, GitHub remote tests, live test separation, CLI binary packaging, and finishing workflow to implementation/tests.

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Fresh verification**

Run:

```bash
npm test
npm run test:live
node --run northstar -- --help
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "['\\\"][^'\\\"]*(&&|\\|\\||;)[^'\\\"]*['\\\"]" src/adapters src/runtime src/cli
git status --short
```

Expected: unit tests pass; live tests either run or explicitly skip; CLI help prints; forbidden legacy/env scans produce no matches; shell-chain scan has no runtime command string construction.

## Deferred Work

- Installing and exercising concrete SDK packages may require network and credentials.
- Full GitHub project-field sync live coverage requires a configured project target.
- Commit, push, PR, merge, and cleanup wait for the user’s finishing-branch choice.

# Northstar Live GitHub/SDK E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live E2E suite proving real GitHub sandbox projection, required GitHub Project v2 sync, and real OpenCode/Codex SDK-backed no-op root and child runs.

**Architecture:** Keep live tests under `tests/e2e-live/` and keep them separate from deterministic `npm test` and `npm run test:e2e`. Use existing adapter boundaries (`GitHubRemoteProjectionAdapter`, `OpenCodeHostAdapter`, `CodexHostAdapter`, SDK loaders) and add only narrow live harness helpers for environment validation, metrics, timeout, and redacted summaries.

**Tech Stack:** Node 22.22+, `node:test`, `node:assert/strict`, native `fetch`, existing TypeScript runtime, GitHub REST/GraphQL through `GitHubRemoteProjectionAdapter`, optional SDK packages `@opencode-ai/sdk` and `@openai/codex-sdk`.

---

## Source Spec

Use [docs/superpowers/specs/2026-05-29-northstar-live-and-daemon-e2e-design.md](/home/timmypai/apps/northstar/docs/superpowers/specs/2026-05-29-northstar-live-and-daemon-e2e-design.md) as the authoritative requirement source.

## File Structure

- Modify `package.json`: add `test:e2e:live`.
- Create `tests/e2e-live/index.test.ts`: live E2E suite entrypoint.
- Create `tests/e2e-live/live-env.ts`: environment validation with skip/fail semantics.
- Create `tests/e2e-live/live-metrics.ts`: metrics accumulator and summary formatting.
- Create `tests/e2e-live/github-live-e2e.test.ts`: real GitHub sandbox repo E2E.
- Create `tests/e2e-live/host-sdk-live-e2e.test.ts`: real OpenCode/Codex SDK E2E.
- Modify `src/adapters/host/sdk-loaders.ts`: add narrow factory helpers only if the real SDK package needs a normalized client adapter boundary.
- Modify `tests/live/*.test.ts` only if needed to share helpers without duplicating environment rules.
- Create `docs/superpowers/live-e2e-coverage.md`: coverage matrix for live E2E.
- Do not modify `src/runtime/state-machine.ts`, `src/runtime/store.ts`, or deterministic offline E2E unless a failing test proves a shared helper is required.

## Task 1: Add Live E2E Command And Summary Contract

**Files:**
- Modify: `package.json`
- Create: `tests/e2e-live/index.test.ts`
- Create: `tests/e2e-live/live-metrics.ts`
- Create: `tests/e2e-live/live-env.ts`
- Create: `tests/e2e-live/github-live-e2e.test.ts`
- Create: `tests/e2e-live/host-sdk-live-e2e.test.ts`

- [ ] **Step 1: Write failing live E2E shell tests**

Create `tests/e2e-live/index.test.ts`:

```ts
import "./github-live-e2e.test.ts";
import "./host-sdk-live-e2e.test.ts";
```

Create `tests/e2e-live/live-metrics.ts`:

```ts
export interface LiveE2EMetrics {
  github_temporary_issues_created: number;
  github_labels_synced: number;
  github_comments_synced: number;
  github_project_items_synced: number;
  github_issues_closed: number;
  github_retryable_projection_failures: number;
  github_live_cleanup_errors: number;
  sdk_packages_loaded: number;
  sdk_root_sessions_started: number;
  sdk_background_children_started: number;
  sdk_status_reads: number;
  sdk_shell_fallbacks: number;
  sdk_live_timeouts: number;
  sdk_live_duration_seconds: number;
}

export function emptyLiveE2EMetrics(): LiveE2EMetrics {
  return {
    github_temporary_issues_created: 0,
    github_labels_synced: 0,
    github_comments_synced: 0,
    github_project_items_synced: 0,
    github_issues_closed: 0,
    github_retryable_projection_failures: 0,
    github_live_cleanup_errors: 0,
    sdk_packages_loaded: 0,
    sdk_root_sessions_started: 0,
    sdk_background_children_started: 0,
    sdk_status_reads: 0,
    sdk_shell_fallbacks: 0,
    sdk_live_timeouts: 0,
    sdk_live_duration_seconds: 0,
  };
}

export function formatLiveSummary(metrics: LiveE2EMetrics): string {
  return [
    `github_temporary_issues_created=${metrics.github_temporary_issues_created}`,
    `github_labels_synced=${metrics.github_labels_synced}`,
    `github_comments_synced=${metrics.github_comments_synced}`,
    `github_project_items_synced=${metrics.github_project_items_synced}`,
    `github_issues_closed=${metrics.github_issues_closed}`,
    `github_retryable_projection_failures=${metrics.github_retryable_projection_failures}`,
    `github_live_cleanup_errors=${metrics.github_live_cleanup_errors}`,
    `sdk_packages_loaded=${metrics.sdk_packages_loaded}/2`,
    `sdk_root_sessions_started=${metrics.sdk_root_sessions_started}/2`,
    `sdk_background_children_started=${metrics.sdk_background_children_started}/2`,
    `sdk_status_reads=${metrics.sdk_status_reads}`,
    `sdk_shell_fallbacks=${metrics.sdk_shell_fallbacks}`,
    `sdk_live_timeouts=${metrics.sdk_live_timeouts}`,
    `sdk_live_duration_seconds=${metrics.sdk_live_duration_seconds}`,
  ].join(" ");
}
```

Create `tests/e2e-live/live-env.ts`:

```ts
export interface LiveGitHubEnv {
  token: string;
  repo: string;
  projectId: string;
}

export function liveGitHubEnabled(): boolean {
  return process.env.NORTHSTAR_LIVE_GITHUB === "1";
}

export function requireLiveGitHubEnv(): LiveGitHubEnv {
  const missing = [
    ...(process.env.GITHUB_TOKEN ? [] : ["GITHUB_TOKEN"]),
    ...(process.env.NORTHSTAR_LIVE_GITHUB_REPO ? [] : ["NORTHSTAR_LIVE_GITHUB_REPO"]),
    ...(process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID ? [] : ["NORTHSTAR_LIVE_GITHUB_PROJECT_ID"]),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing GitHub live E2E configuration: ${missing.join(", ")}`);
  }
  return {
    token: process.env.GITHUB_TOKEN!,
    repo: process.env.NORTHSTAR_LIVE_GITHUB_REPO!,
    projectId: process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID!,
  };
}

export function liveSdkEnabled(name: "opencode" | "codex"): boolean {
  return process.env[name === "opencode" ? "NORTHSTAR_LIVE_OPENCODE" : "NORTHSTAR_LIVE_CODEX"] === "1";
}
```

Create `tests/e2e-live/github-live-e2e.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { emptyLiveE2EMetrics, formatLiveSummary } from "./live-metrics.ts";
import { liveGitHubEnabled, requireLiveGitHubEnv } from "./live-env.ts";

test("live GitHub E2E summary contract", async (t) => {
  if (!liveGitHubEnabled()) {
    t.skip("Set NORTHSTAR_LIVE_GITHUB=1 to run live GitHub E2E.");
    return;
  }

  requireLiveGitHubEnv();
  const metrics = emptyLiveE2EMetrics();
  t.diagnostic(formatLiveSummary(metrics));

  assert.equal(metrics.github_temporary_issues_created, 1);
});
```

Create `tests/e2e-live/host-sdk-live-e2e.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { emptyLiveE2EMetrics, formatLiveSummary } from "./live-metrics.ts";
import { liveSdkEnabled } from "./live-env.ts";

test("live SDK E2E summary contract", async (t) => {
  if (!liveSdkEnabled("opencode") && !liveSdkEnabled("codex")) {
    t.skip("Set NORTHSTAR_LIVE_OPENCODE=1 and NORTHSTAR_LIVE_CODEX=1 to run live SDK E2E.");
    return;
  }

  const metrics = emptyLiveE2EMetrics();
  t.diagnostic(formatLiveSummary(metrics));

  assert.equal(metrics.sdk_packages_loaded, 2);
});
```

- [ ] **Step 2: Add npm script**

Modify `package.json`:

```json
"test:e2e:live": "node --disable-warning=ExperimentalWarning tests/e2e-live/index.test.ts"
```

- [ ] **Step 3: Run live E2E and verify RED/SKIP behavior**

Run:

```bash
npm run test:e2e:live
```

Expected without live flags: PASS with two skipped tests and clear skip reasons.

Run:

```bash
NORTHSTAR_LIVE_GITHUB=1 npm run test:e2e:live
```

Expected: FAIL with `Missing GitHub live E2E configuration: GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO, NORTHSTAR_LIVE_GITHUB_PROJECT_ID`.

- [ ] **Step 4: Commit live shell**

```bash
git add package.json tests/e2e-live/index.test.ts tests/e2e-live/live-env.ts tests/e2e-live/live-metrics.ts tests/e2e-live/github-live-e2e.test.ts tests/e2e-live/host-sdk-live-e2e.test.ts
git commit -m "test: add live e2e acceptance shell"
```

## Task 2: Implement GitHub Sandbox E2E

**Files:**
- Modify: `tests/e2e-live/github-live-e2e.test.ts`
- Modify: `tests/e2e-live/live-metrics.ts`

- [ ] **Step 1: Write failing GitHub E2E assertions**

Replace `tests/e2e-live/github-live-e2e.test.ts` with:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubRemoteProjectionAdapter } from "../../src/adapters/github/remote.ts";
import { emptyLiveE2EMetrics, formatLiveSummary } from "./live-metrics.ts";
import { liveGitHubEnabled, requireLiveGitHubEnv } from "./live-env.ts";

const smokePrefix = "northstar-smoke";

test("live GitHub sandbox repo syncs issue, label, comment, project, close, and retryable failure", async (t) => {
  if (!liveGitHubEnabled()) {
    t.skip("Set NORTHSTAR_LIVE_GITHUB=1 to run live GitHub E2E.");
    return;
  }

  const env = requireLiveGitHubEnv();
  const metrics = emptyLiveE2EMetrics();
  const issue = await createTemporaryIssue(env.repo, env.token);
  metrics.github_temporary_issues_created += 1;
  t.diagnostic(`northstar-live-github-issue ${issue.number} ${issue.html_url}`);

  const adapter = new GitHubRemoteProjectionAdapter({ repo: env.repo, token: env.token });
  const label = `${smokePrefix}-${Date.now()}`;
  const labelResult = await adapter.syncLabel({ issue_number: issue.number, labels: [label] });
  const commentResult = await adapter.syncBodyComment({
    issue_number: issue.number,
    body: `${smokePrefix}-comment ${new Date().toISOString()}`,
  });
  const projectResult = await adapter.syncProject({
    issue_number: issue.number,
    project_id: env.projectId,
  });
  const closeResult = await adapter.closeIssue({ issue_number: issue.number });
  const failureAdapter = new GitHubRemoteProjectionAdapter({
    repo: env.repo,
    token: env.token,
    fetch: async () => new Response("redacted failure", { status: 500 }),
  });
  const failureResult = await failureAdapter.syncLabel({ issue_number: issue.number, labels: [`${label}-fail`] });

  metrics.github_labels_synced += labelResult.status === "success" ? 1 : 0;
  metrics.github_comments_synced += commentResult.status === "success" ? 1 : 0;
  metrics.github_project_items_synced += projectResult.status === "success" ? 1 : 0;
  metrics.github_issues_closed += closeResult.status === "success" ? 1 : 0;
  metrics.github_retryable_projection_failures += failureResult.status === "failed" ? 1 : 0;
  t.diagnostic(formatLiveSummary(metrics));

  assert.equal(metrics.github_temporary_issues_created, 1);
  assert.ok(metrics.github_labels_synced >= 1);
  assert.ok(metrics.github_comments_synced >= 1);
  assert.equal(metrics.github_project_items_synced, 1);
  assert.equal(metrics.github_issues_closed, 1);
  assert.ok(metrics.github_retryable_projection_failures >= 1);
  assert.equal(metrics.github_live_cleanup_errors, 0);
});

async function createTemporaryIssue(repo: string, token: string): Promise<{ number: number; html_url: string }> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      title: `${smokePrefix}-issue ${new Date().toISOString()}`,
      body: `${smokePrefix}-body created by Northstar live E2E`,
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub temporary issue creation failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as { number: number; html_url: string };
}
```

- [ ] **Step 2: Run RED with explicit live mode and incomplete env**

Run:

```bash
NORTHSTAR_LIVE_GITHUB=1 npm run test:e2e:live
```

Expected without full env: FAIL with missing config. With `GITHUB_TOKEN`, `NORTHSTAR_LIVE_GITHUB_REPO`, and `NORTHSTAR_LIVE_GITHUB_PROJECT_ID` configured, expected behavior before sandbox exists is FAIL from GitHub repo/project access.

- [ ] **Step 3: Ensure sandbox repo exists**

Run with escalation because this uses GitHub network:

```bash
gh repo view paulpai0412/northstar-live-sandbox --json nameWithOwner,url,visibility
```

If the view command reports that the repository does not exist, run:

```bash
gh repo create paulpai0412/northstar-live-sandbox --private
```

Expected: repo exists and is private. Do not write tokens to files.

- [ ] **Step 4: Run GREEN with live env**

Run:

```bash
NORTHSTAR_LIVE_GITHUB=1 GITHUB_TOKEN="$GITHUB_TOKEN" NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" npm run test:e2e:live
```

Expected: GitHub test PASS and diagnostic includes `github_temporary_issues_created=1`, `github_project_items_synced=1`, `github_issues_closed=1`, `github_retryable_projection_failures=1`.

- [ ] **Step 5: Commit GitHub live E2E**

```bash
git add tests/e2e-live/github-live-e2e.test.ts tests/e2e-live/live-metrics.ts
git commit -m "test: add github sandbox live e2e"
```

## Task 3: Implement SDK No-Op Root And Child E2E

**Files:**
- Modify: `tests/e2e-live/host-sdk-live-e2e.test.ts`
- Modify: `tests/e2e-live/live-env.ts`
- Modify: `src/adapters/host/sdk-loaders.ts` only if real SDK normalization is required.
- Modify: `docs/decisions/2026-05-29-runtime-dependencies.md` if actual package API differs from the existing decision record.

- [ ] **Step 1: Write failing SDK E2E assertions**

Replace `tests/e2e-live/host-sdk-live-e2e.test.ts` with:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { CodexHostAdapter, type CodexSdk } from "../../src/adapters/host/codex.ts";
import { OpenCodeHostAdapter, type OpenCodeSdk } from "../../src/adapters/host/opencode.ts";
import { codexLoader, openCodeLoader } from "../../src/adapters/host/sdk-loaders.ts";
import type { HostAdapter } from "../../src/types/host.ts";
import type { RoleDefinition } from "../../src/types/workflow.ts";
import { emptyLiveE2EMetrics, formatLiveSummary } from "./live-metrics.ts";
import { liveSdkEnabled } from "./live-env.ts";

const noopRole: RoleDefinition = {
  run_mode: "background_child",
  agent: "noop",
  model: "live-smoke",
  load_skills: [],
  artifact: "worker_result",
  timeout_seconds: 120,
};

test("live OpenCode and Codex SDKs start no-op root and child runs", async (t) => {
  if (!liveSdkEnabled("opencode") && !liveSdkEnabled("codex")) {
    t.skip("Set NORTHSTAR_LIVE_OPENCODE=1 and NORTHSTAR_LIVE_CODEX=1 to run live SDK E2E.");
    return;
  }

  const metrics = emptyLiveE2EMetrics();
  const started = Date.now();
  if (liveSdkEnabled("opencode")) {
    await runSdkSmoke("opencode", await openCodeLoader(), metrics);
  }
  if (liveSdkEnabled("codex")) {
    await runSdkSmoke("codex", await codexLoader(), metrics);
  }
  metrics.sdk_live_duration_seconds = Math.ceil((Date.now() - started) / 1000);
  t.diagnostic(formatLiveSummary(metrics));

  assert.equal(metrics.sdk_packages_loaded, 2);
  assert.equal(metrics.sdk_root_sessions_started, 2);
  assert.equal(metrics.sdk_background_children_started, 2);
  assert.ok(metrics.sdk_status_reads >= 2);
  assert.equal(metrics.sdk_shell_fallbacks, 0);
  assert.equal(metrics.sdk_live_timeouts, 0);
  assert.ok(metrics.sdk_live_duration_seconds <= 240);
});

async function runSdkSmoke(name: "opencode" | "codex", sdkModule: unknown, metrics: ReturnType<typeof emptyLiveE2EMetrics>): Promise<void> {
  metrics.sdk_packages_loaded += 1;
  const adapter = makeLiveAdapter(name, sdkModule);
  const root = await withTimeout(Promise.resolve(adapter.startRootSession({
    issue_id: `live-${name}-issue`,
    role_name: "noop",
    role: noopRole,
  })), 120_000, `${name} root session timed out`);
  metrics.sdk_root_sessions_started += 1;
  const child = await withTimeout(Promise.resolve(adapter.startBackgroundChild({
    issue_id: `live-${name}-issue`,
    lease_id: `live-${name}-lease`,
    root_session_id: root.root_session_id,
    role_name: "noop",
    role: noopRole,
  })), 120_000, `${name} child run timed out`);
  metrics.sdk_background_children_started += 1;
  const rootStatus = adapter.readRootStatus(root.root_session_id);
  const childStatus = adapter.readChildStatus(child.child_run_id);
  if (rootStatus.status) metrics.sdk_status_reads += 1;
  if (childStatus.status) metrics.sdk_status_reads += 1;
}

function makeLiveAdapter(name: "opencode" | "codex", sdkModule: unknown): HostAdapter {
  if (name === "opencode") {
    return new OpenCodeHostAdapter(normalizeOpenCodeSdk(sdkModule));
  }
  return new CodexHostAdapter(normalizeCodexSdk(sdkModule));
}

function normalizeOpenCodeSdk(sdkModule: unknown): OpenCodeSdk {
  const sdk = sdkModule as { sessions?: OpenCodeSdk["sessions"]; children?: OpenCodeSdk["children"] };
  if (!sdk.sessions || !sdk.children) {
    throw new Error("OpenCode SDK module does not expose sessions and children APIs required by live E2E.");
  }
  return { sessions: sdk.sessions, children: sdk.children };
}

function normalizeCodexSdk(sdkModule: unknown): CodexSdk {
  const sdk = sdkModule as { root?: CodexSdk["root"]; child?: CodexSdk["child"] };
  if (!sdk.root || !sdk.child) {
    throw new Error("Codex SDK module does not expose root and child APIs required by live E2E.");
  }
  return { root: sdk.root, child: sdk.child };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```

- [ ] **Step 2: Run RED with live SDK flags**

Run:

```bash
NORTHSTAR_LIVE_OPENCODE=1 NORTHSTAR_LIVE_CODEX=1 npm run test:e2e:live
```

Expected: FAIL if SDK credentials/API are not configured, or FAIL with a clear API mismatch message from `normalizeOpenCodeSdk` or `normalizeCodexSdk`. This is the required root-cause evidence before changing SDK normalization.

- [ ] **Step 3: Normalize actual SDK APIs behind narrow boundaries**

If the real SDK modules do not expose the expected `sessions/children` or `root/child` shapes, inspect package exports with Node dynamic import:

```bash
node --input-type=module -e 'const m=await import("@opencode-ai/sdk"); console.log(Object.keys(m).sort())'
node --input-type=module -e 'const m=await import("@openai/codex-sdk"); console.log(Object.keys(m).sort())'
```

Then add narrow normalizer helpers in `src/adapters/host/sdk-loaders.ts`:

```ts
export interface NormalizedLiveSdk {
  startRoot(input: unknown): { id: string } | Promise<{ id: string }>;
  startChild(input: unknown): { id: string; sessionId: string } | Promise<{ id: string; sessionId: string }>;
  rootStatus(id: string): { status: "live" | "missing" | "unknown" };
  childStatus(id: string): { status: string };
}
```

Keep the normalizer in the SDK boundary file. Do not add SDK imports to runtime core.

- [ ] **Step 4: Run GREEN with live SDK env**

Run:

```bash
NORTHSTAR_LIVE_OPENCODE=1 NORTHSTAR_LIVE_CODEX=1 npm run test:e2e:live
```

Expected: PASS and diagnostic includes `sdk_packages_loaded=2/2`, `sdk_root_sessions_started=2/2`, `sdk_background_children_started=2/2`, `sdk_shell_fallbacks=0`, `sdk_live_timeouts=0`.

- [ ] **Step 5: Commit SDK live E2E**

```bash
git add tests/e2e-live/host-sdk-live-e2e.test.ts tests/e2e-live/live-env.ts src/adapters/host/sdk-loaders.ts docs/decisions/2026-05-29-runtime-dependencies.md
git commit -m "test: add host sdk live e2e"
```

Only include `src/adapters/host/sdk-loaders.ts` or the decision record if they changed.

## Task 4: Add Live E2E Coverage Matrix

**Files:**
- Create: `docs/superpowers/live-e2e-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Write failing matrix test**

Append to `tests/spec/spec-compliance.test.ts`:

```ts
test("live e2e coverage matrix maps live GitHub and SDK requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/live-e2e-coverage.md"), "utf8");
  for (const required of [
    "GitHub temporary issue",
    "GitHub Project v2 sync",
    "GitHub retryable projection failure",
    "OpenCode SDK root and child run",
    "Codex SDK root and child run",
    "tests/e2e-live/github-live-e2e.test.ts",
    "tests/e2e-live/host-sdk-live-e2e.test.ts",
  ]) {
    assert.match(matrix, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
```

- [ ] **Step 2: Run RED**

```bash
npm test
```

Expected: FAIL because `docs/superpowers/live-e2e-coverage.md` does not exist.

- [ ] **Step 3: Add matrix**

Create `docs/superpowers/live-e2e-coverage.md`:

```md
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
```

- [ ] **Step 4: Run GREEN and commit**

```bash
npm test
git add docs/superpowers/live-e2e-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map live e2e coverage"
```

## Task 5: Final Verification Gate

**Files:**
- Read-only unless verification exposes a defect.

- [ ] **Step 1: Run deterministic tests**

```bash
npm test
npm run test:e2e
```

Expected: both PASS and neither requires live credentials.

- [ ] **Step 2: Run live E2E**

```bash
npm run test:e2e:live
```

Expected with no live flags: PASS with explicit skips.

Run live-enabled command with configured env:

```bash
NORTHSTAR_LIVE_GITHUB=1 NORTHSTAR_LIVE_OPENCODE=1 NORTHSTAR_LIVE_CODEX=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox NORTHSTAR_LIVE_GITHUB_PROJECT_ID="$NORTHSTAR_LIVE_GITHUB_PROJECT_ID" GITHUB_TOKEN="$GITHUB_TOKEN" npm run test:e2e:live
```

Expected: PASS with summary fields for GitHub and SDK metrics. If credentials are unavailable, report the exact missing items and leave goal incomplete rather than claiming live completion.

- [ ] **Step 3: Run source scans**

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(&&|\\|\\||;)" src/adapters src/runtime src/cli
git status --short
```

Expected: the three `rg` commands produce no output; `git status --short` is clean after commits.

- [ ] **Step 4: Final report**

Report live summary metrics, RED/GREEN evidence, missing credential/config items if any, changed files, and deferred daemon E2E work.

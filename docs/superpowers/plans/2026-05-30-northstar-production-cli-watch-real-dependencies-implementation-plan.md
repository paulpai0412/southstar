# Northstar Production CLI/Watch Real Dependencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make general `northstar` CLI/watch use real production dependencies for configurable consumer repos: GitHub issue intake, git worktrees, Codex/OpenCode SDK workers, PR/merge/release, restart/resume, and GitHub observability.

**Architecture:** Replace the current unconfigured default production factory with a config-driven dependency factory. The factory wires credential providers, GitHub gateway/intake/observability adapters, git worktree operations, role-based SDK worker resolution, DomainDriverRegistry, and ProductionOrchestrator. Runtime state remains in SQLite under the consumer repo, while production source stays free of sandbox repo hardcoding and shell-chain commands.

**Tech Stack:** TypeScript on Node 22, built-in `node:test`, Node SQLite, GitHub REST/GraphQL via `fetch`, git/gh through argv-array process adapters, `@openai/codex-sdk`, `@opencode-ai/sdk`.

---

## Source Spec

Implement:

- `docs/superpowers/specs/2026-05-30-northstar-production-cli-watch-real-dependencies-design.md`
- Keep compatibility with:
  - `docs/superpowers/specs/2026-05-30-northstar-domain-driver-registry-design.md`
  - `docs/superpowers/specs/2026-05-30-northstar-production-orchestrator-design.md`
  - `docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md`

## File Structure

Create:

- `src/runtime/credential-provider.ts` - GitHub credential provider chain and stable credential errors.
- `src/adapters/github/issues.ts` - GitHub issue discovery, issue read, dependency marker parsing, native linked issue discovery.
- `src/adapters/github/software-dev-gateway.ts` - production GitHub gateway for branch/PR/merge/close/reuse.
- `src/adapters/github/observability.ts` - issue label/comment/body marker, PR comment/body, Project v2 projection.
- `src/adapters/git/executor.ts` - argv-array git executor abstraction with fakeable process dependency.
- `src/adapters/git/software-dev-worktree.ts` - worktree path, branch, status, commit, push, cleanup operations.
- `src/adapters/host/worker-factory.ts` - role host resolution and SDK worker creation.
- `src/adapters/host/codex-worker.ts` - production Codex SDK `SoftwareDevWorker`.
- `src/adapters/host/opencode-worker.ts` - production OpenCode SDK `SoftwareDevWorker`.
- `src/orchestrator/production-dependencies.ts` - default production dependency composition used by CLI/watch.
- `tests/runtime/credential-provider.test.ts`
- `tests/adapters/github-issues.test.ts`
- `tests/adapters/github-software-dev-gateway.test.ts`
- `tests/adapters/github-observability.test.ts`
- `tests/adapters/git-software-dev-worktree.test.ts`
- `tests/adapters/host-worker-factory.test.ts`
- `tests/orchestrator/production-dependencies.test.ts`
- `tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts`
- `tests/e2e-production-cli-watch/index.test.ts`

Modify:

- `src/config/schema.ts` - add credentials, GitHub project config, workflow domain/path fields.
- `src/config/load-config.ts` - preserve current YAML subset behavior while validating new config.
- `src/cli/entrypoint.ts` - manual intake reads issue from GitHub through production factory.
- `src/cli/watch-command.ts` - watch discovers ready GitHub issues before running cycles.
- `src/orchestrator/production-factory.ts` - delegate default production factory to real dependency composition.
- `src/orchestrator/software-dev-driver.ts` - support real worktree/commit/push gateway flow without fixture-only behavior.
- `src/types/workflow.ts` - ensure workflow domain/path resolution supports package-relative built-ins.
- `tests/fixtures/.northstar.yaml` - add schema 1.1 credentials/project fields.
- `package.json` - add `test:e2e:production-cli-watch` if needed.
- `docs/manuals/2026-05-30-northstar-manual-runbook.zh-TW.md` - update manual once CLI/watch is truly live-capable.
- Coverage docs if this repository uses requirement-matrix gates for this area.

---

## Task 1: Config Schema For Consumer Repo Credentials And Project Settings

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/config/load-config.test.ts`
- Modify: `tests/fixtures/.northstar.yaml`

- [ ] **Step 1: Write failing config schema tests**

Add tests that prove `.northstar.yaml` supports one-file consumer configuration.

```ts
test("config accepts production credentials and github project settings", () => {
  const config = loadConfig("tests/fixtures/.northstar.yaml");

  assert.equal(config.schemaVersion, "1.1");
  assert.equal(config.credentials?.github.tokenEnv, "GITHUB_TOKEN");
  assert.equal(config.credentials?.github.allowGhTokenFallback, true);
  assert.equal(config.credentials?.hostSdk.codex.mode, "sdk_default");
  assert.equal(config.credentials?.hostSdk.opencode.mode, "sdk_default");
  assert.equal(config.github.project?.enabled, false);
  assert.equal(config.workflow.domain, "software_development");
});

test("config rejects unknown host adapter", () => {
  assert.throws(() => validateRuntimeConfig({
    schema_version: "1.1",
    project: { name: "x", root: "/tmp/x" },
    runtime: {
      db_path: ".northstar/runtime/control-plane.sqlite3",
      host_adapter: "unknown",
      development_capacity: 1,
      release_capacity: 1,
      heartbeat_interval_seconds: 30,
      lease_timeout_seconds: 180,
      child_timeout_seconds: 7200,
      auto_release: false,
      session_scope: "stage_root",
    },
    workflow: { package: "northstar/workflows/issue-to-pr-release", id: "issue_to_pr_release", version: "1.0", domain: "software_development" },
    github: { repo: "owner/repo", intake: { enabled: true, label: "northstar:ready" }, sync: { enabled: true, retry_backoff_seconds: [30] } },
    git: { base_branch: "main", worktrees_dir: ".northstar/runtime/worktrees", sync_worktree_dir: ".northstar/runtime/sync-worktrees/main" },
    policy: { github_sync_blocks_lifecycle: false, quarantine_requires_operator: true },
    credentials: { github: { token_env: "GITHUB_TOKEN", allow_gh_token_fallback: true }, host_sdk: { codex: { mode: "sdk_default" }, opencode: { mode: "sdk_default" } } },
  }), /runtime.host_adapter must be codex or opencode/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `RuntimeConfig` has no `credentials`, no `github.project`, no `workflow.domain`, and host adapter validation is missing.

- [ ] **Step 3: Update `RuntimeConfig` and validation**

Add these types and validation:

```ts
type HostAdapterName = "codex" | "opencode";

credentials?: {
  github: {
    tokenEnv: string;
    allowGhTokenFallback: boolean;
  };
  hostSdk: {
    codex: { mode: "sdk_default" };
    opencode: { mode: "sdk_default" };
  };
};

workflow: {
  package: string;
  id: string;
  version: string;
  domain?: string;
  path?: string;
};

github: {
  repo: string;
  intake: { enabled: boolean; label: string };
  sync: { enabled: boolean; retryBackoffSeconds: number[] };
  project?: {
    enabled: boolean;
    projectId?: string;
    fields?: Record<string, string>;
  };
};
```

Validation rules:

```ts
if (!["codex", "opencode"].includes(runtimeHostAdapter)) {
  throw new Error("runtime.host_adapter must be codex or opencode");
}
```

Defaults:

```ts
credentials: {
  github: {
    tokenEnv: stringFieldOrDefault(value, "credentials.github.token_env", "GITHUB_TOKEN"),
    allowGhTokenFallback: booleanFieldOrDefault(value, "credentials.github.allow_gh_token_fallback", false),
  },
  hostSdk: {
    codex: { mode: "sdk_default" },
    opencode: { mode: "sdk_default" },
  },
}
```

- [ ] **Step 4: Update fixture config**

Set `tests/fixtures/.northstar.yaml` to schema `1.1` and add:

```yaml
workflow:
  package: northstar/workflows/issue-to-pr-release
  id: issue_to_pr_release
  version: "1.0"
  domain: software_development

github:
  project:
    enabled: false

credentials:
  github:
    token_env: GITHUB_TOKEN
    allow_gh_token_fallback: true
  host_sdk:
    codex:
      mode: sdk_default
    opencode:
      mode: sdk_default
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS for config tests.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts tests/config/load-config.test.ts tests/fixtures/.northstar.yaml
git commit -m "feat: extend production config schema"
```

---

## Task 2: Credential Provider Chain

**Files:**
- Create: `src/runtime/credential-provider.ts`
- Create: `tests/runtime/credential-provider.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("github credential provider uses configured env token", async () => {
  const token = await resolveGitHubToken({
    tokenEnv: "NORTHSTAR_TEST_TOKEN",
    allowGhTokenFallback: true,
    env: { NORTHSTAR_TEST_TOKEN: "ghp_envtoken" },
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "should not run" }),
  });

  assert.equal(token.source, "env");
  assert.equal(token.token, "ghp_envtoken");
});

test("github credential provider uses gh fallback only when enabled", async () => {
  const token = await resolveGitHubToken({
    tokenEnv: "MISSING",
    allowGhTokenFallback: true,
    env: {},
    runCommand: async (command) => {
      assert.deepEqual(command, { command: "gh", args: ["auth", "token"] });
      return { exitCode: 0, stdout: "gho_from_cli\n", stderr: "" };
    },
  });

  assert.equal(token.source, "gh");
  assert.equal(token.token, "gho_from_cli");
});

test("github credential provider fails fast without credentials", async () => {
  await assert.rejects(() => resolveGitHubToken({
    tokenEnv: "MISSING",
    allowGhTokenFallback: false,
    env: {},
    runCommand: async () => ({ exitCode: 0, stdout: "gho_unused", stderr: "" }),
  }), /GITHUB_CREDENTIAL_MISSING/);
});

test("credential provider redacts tokens from errors", async () => {
  await assert.rejects(() => resolveGitHubToken({
    tokenEnv: "MISSING",
    allowGhTokenFallback: true,
    env: {},
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "bad ghp_secretvalue" }),
  }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /GITHUB_CREDENTIAL_MISSING/);
    assert.doesNotMatch(error.message, /ghp_secretvalue/);
    return true;
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because `src/runtime/credential-provider.ts` does not exist.

- [ ] **Step 3: Implement credential provider**

```ts
import { redactSecrets } from "./redaction.ts";

export interface CommandRunner {
  (command: { command: string; args: string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export class CredentialError extends Error {
  readonly code: "GITHUB_CREDENTIAL_MISSING";

  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
    this.code = "GITHUB_CREDENTIAL_MISSING";
  }
}

export async function resolveGitHubToken(input: {
  tokenEnv: string;
  allowGhTokenFallback: boolean;
  env?: Record<string, string | undefined>;
  runCommand: CommandRunner;
}): Promise<{ token: string; source: "env" | "gh" }> {
  const env = input.env ?? process.env;
  const envToken = env[input.tokenEnv]?.trim();
  if (envToken) return { token: envToken, source: "env" };

  if (!input.allowGhTokenFallback) {
    throw new CredentialError(`GITHUB_CREDENTIAL_MISSING: set ${input.tokenEnv} or enable gh fallback`);
  }

  const result = await input.runCommand({ command: "gh", args: ["auth", "token"] });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new CredentialError(`GITHUB_CREDENTIAL_MISSING: gh auth token failed: ${redactSecrets(result.stderr)}`);
  }

  return { token: result.stdout.trim(), source: "gh" };
}
```

- [ ] **Step 4: Wire tests into test index**

Import `tests/runtime/credential-provider.test.ts` in `tests/index.test.ts`.

- [ ] **Step 5: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/credential-provider.ts tests/runtime/credential-provider.test.ts tests/index.test.ts
git commit -m "feat: add github credential provider"
```

---

## Task 3: GitHub Issue Intake Adapter

**Files:**
- Create: `src/adapters/github/issues.ts`
- Create: `tests/adapters/github-issues.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("discovers only ready labeled open issues and sorts by issue number", async () => {
  const fetches: string[] = [];
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    readyLabel: "northstar:ready",
    fetch: async (url) => {
      fetches.push(String(url));
      return jsonResponse([
        issue({ number: 3, labels: [{ name: "other" }] }),
        issue({ number: 2, labels: [{ name: "northstar:ready" }] }),
        issue({ number: 1, labels: [{ name: "northstar:ready" }] }),
      ]);
    },
  });

  const issues = await adapter.listReadyIssues();

  assert.deepEqual(issues.map((item) => item.number), [1, 2]);
  assert.equal(fetches.length, 1);
});

test("manual intake reads issue details from github", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    readyLabel: "northstar:ready",
    fetch: async () => jsonResponse(issue({
      number: 44,
      title: "Build report",
      body: "Depends-On: #12\nBlocked-By: #13",
      labels: [{ name: "northstar:ready" }],
    })),
  });

  const item = await adapter.readIssue(44);

  assert.equal(item.issueId, "github:44");
  assert.deepEqual(item.dependencies, [12, 13]);
});

test("dependency marker parser accepts Depends-On and Blocked-By", () => {
  assert.deepEqual(parseIssueDependencies("Depends-On: #7\nBlocked-By: #8\nDepends-On: owner/repo#9"), [7, 8, 9]);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because `GitHubIssueIntakeAdapter` is missing.

- [ ] **Step 3: Implement adapter**

```ts
import { redactSecrets } from "../../runtime/redaction.ts";

export interface GitHubReadyIssue {
  issueId: string;
  number: number;
  title: string;
  body: string;
  sourceUrl: string;
  labels: string[];
  dependencies: number[];
}

export class GitHubIssueIntakeAdapter {
  constructor(private readonly options: {
    repo: string;
    token: string;
    readyLabel: string;
    fetch?: typeof fetch;
  }) {}

  async listReadyIssues(): Promise<GitHubReadyIssue[]> {
    const issues = await this.request<GitHubApiIssue[]>(`/issues?state=open&per_page=100`);
    return issues
      .filter((item) => !("pull_request" in item))
      .filter((item) => item.labels.some((label) => label.name === this.options.readyLabel))
      .map((item) => this.normalize(item))
      .sort((a, b) => a.number - b.number);
  }

  async readIssue(number: number): Promise<GitHubReadyIssue> {
    return this.normalize(await this.request<GitHubApiIssue>(`/issues/${number}`));
  }

  private normalize(item: GitHubApiIssue): GitHubReadyIssue {
    return {
      issueId: `github:${item.number}`,
      number: item.number,
      title: item.title,
      body: item.body ?? "",
      sourceUrl: item.html_url,
      labels: item.labels.map((label) => label.name),
      dependencies: parseIssueDependencies(item.body ?? ""),
    };
  }

  private async request<T>(path: string): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${this.options.repo}${path}`, {
      method: "GET",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub issue intake failed with ${response.status}: ${redactSecrets(await response.text())}`);
    }
    return await response.json() as T;
  }
}

export function parseIssueDependencies(body: string): number[] {
  const result = new Set<number>();
  const pattern = /(?:Depends-On|Blocked-By):\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
  for (const match of body.matchAll(pattern)) {
    result.add(Number(match[1]));
  }
  return [...result].sort((a, b) => a - b);
}
```

Define local `GitHubApiIssue` in the same file:

```ts
interface GitHubApiIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}
```

- [ ] **Step 4: Add test helpers**

Use local helpers in the test:

```ts
function issue(overrides: Partial<GitHubApiIssue> = {}): GitHubApiIssue {
  return {
    number: 1,
    title: "Issue",
    body: "",
    html_url: "https://github.com/owner/repo/issues/1",
    labels: [],
    ...overrides,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 5: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github/issues.ts tests/adapters/github-issues.test.ts tests/index.test.ts
git commit -m "feat: add github issue intake adapter"
```

---

## Task 3A: Native GitHub Linked Issue Dependency Discovery

**Files:**
- Modify: `src/adapters/github/issues.ts`
- Modify: `tests/adapters/github-issues.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests proving native linked issue discovery is merged with explicit markers and does not fail lifecycle when GitHub linked-reference APIs are unavailable.

```ts
test("native linked issue dependencies are discovered and merged with marker dependencies", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    readyLabel: "northstar:ready",
    fetch: async (url) => {
      if (String(url).includes("/timeline")) {
        return jsonResponse([
          {
            event: "connected",
            source: { issue: { number: 8 } },
          },
          {
            event: "cross-referenced",
            source: { issue: { number: 9 } },
          },
          {
            event: "connected",
            source: { issue: { number: 8 } },
          },
        ]);
      }
      return jsonResponse(issue({
        number: 7,
        body: "Depends-On: #8\n- [ ] #10",
        labels: [{ name: "northstar:ready" }],
      }));
    },
  });

  const item = await adapter.readIssue(7);

  assert.deepEqual(item.dependencies, [8, 9, 10]);
  assert.equal(item.dependencyDiscovery.nativeLinkedIssueDependenciesDiscovered, 2);
  assert.equal(item.dependencyDiscovery.duplicatesRemoved, 1);
});

test("native linked issue api failure is retryable and does not fail issue read", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    readyLabel: "northstar:ready",
    fetch: async (url) => {
      if (String(url).includes("/timeline")) {
        return new Response("ghp_secret", { status: 403 });
      }
      return jsonResponse(issue({
        number: 7,
        body: "Depends-On: #8",
        labels: [{ name: "northstar:ready" }],
      }));
    },
  });

  const item = await adapter.readIssue(7);

  assert.deepEqual(item.dependencies, [8]);
  assert.equal(item.dependencyDiscovery.nativeLinkedIssueApiFailureRetryable, 1);
  assert.equal(item.dependencyDiscovery.nativeLinkedIssueApiFailureDoesNotFailLifecycle, 1);
  assert.doesNotMatch(item.dependencyDiscovery.warning ?? "", /ghp_secret/);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because `GitHubIssueIntakeAdapter` does not call timeline/native linked reference discovery and does not return dependency discovery metrics.

- [ ] **Step 3: Extend dependency discovery model**

Update `GitHubReadyIssue`:

```ts
dependencyDiscovery: {
  markerDependencies: number[];
  nativeLinkedIssueDependencies: number[];
  nativeLinkedIssueDependenciesDiscovered: number;
  duplicatesRemoved: number;
  nativeLinkedIssueApiFailureRetryable: number;
  nativeLinkedIssueApiFailureDoesNotFailLifecycle: 1;
  warning?: string;
};
```

Keep `dependencies` as the merged sorted list used by scheduler.

- [ ] **Step 4: Implement native linked issue discovery**

Add:

```ts
async discoverNativeLinkedDependencies(issueNumber: number): Promise<{
  dependencies: number[];
  warning?: string;
  apiFailureRetryable: number;
}> {
  const response = await (this.options.fetch ?? fetch)(
    `https://api.github.com/repos/${this.options.repo}/issues/${issueNumber}/timeline?per_page=100`,
    {
      method: "GET",
      headers: {
        "accept": "application/vnd.github.mockingbird-preview+json",
        "authorization": `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    return {
      dependencies: [],
      warning: `native linked issue discovery failed with ${response.status}: ${redactSecrets(await response.text())}`,
      apiFailureRetryable: 1,
    };
  }

  const events = await response.json() as Array<Record<string, unknown>>;
  return {
    dependencies: parseNativeLinkedIssueEvents(events),
    apiFailureRetryable: 0,
  };
}
```

Add parser:

```ts
export function parseNativeLinkedIssueEvents(events: Array<Record<string, unknown>>): number[] {
  const result = new Set<number>();
  for (const event of events) {
    const source = event.source as { issue?: { number?: unknown } } | undefined;
    const number = source?.issue?.number;
    if (typeof number === "number" && Number.isInteger(number)) {
      result.add(number);
    }
  }
  return [...result].sort((a, b) => a - b);
}
```

Extend body parser to include task-list references:

```ts
const taskListPattern = /-\s+\[[ xX]\]\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/g;
```

- [ ] **Step 5: Merge and deduplicate dependencies**

In `normalize`, merge:

```ts
const markerDependencies = parseIssueDependencies(item.body ?? "");
const native = await this.discoverNativeLinkedDependencies(item.number);
const merged = [...new Set([...markerDependencies, ...native.dependencies])].sort((a, b) => a - b);
const duplicatesRemoved = markerDependencies.length + native.dependencies.length - merged.length;
```

If current `normalize` is synchronous, split it into `normalizeIssue` and async `enrichIssueDependencies`.

- [ ] **Step 6: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/github/issues.ts tests/adapters/github-issues.test.ts
git commit -m "feat: discover native github issue dependencies"
```

---

## Task 4: Git Executor And Worktree Operator

**Files:**
- Create: `src/adapters/git/executor.ts`
- Create: `src/adapters/git/software-dev-worktree.ts`
- Create: `tests/adapters/git-software-dev-worktree.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("plans issue worktree outside consumer root and uses argv arrays", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  const worktree = await operator.prepareIssueWorktree({ issueNumber: 42, slug: "build-report" });

  assert.equal(worktree.path, "/repo/.northstar/runtime/worktrees/issue-42-build-report");
  assert.equal(worktree.branch, "northstar/issue-42-build-report");
  assert.deepEqual(calls[0], {
    command: "git",
    args: ["-C", "/repo", "worktree", "add", "-b", "northstar/issue-42-build-report", "/repo/.northstar/runtime/worktrees/issue-42-build-report", "main"],
  });
});

test("commit and push uses issue worktree and rejects empty changes", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const operator = new SoftwareDevWorktreeOperator({
    projectRoot: "/repo",
    worktreesDir: ".northstar/runtime/worktrees",
    baseBranch: "main",
    runCommand: async (command) => {
      calls.push(command);
      if (command.args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  await assert.rejects(() => operator.commitAndPush({
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-42-build-report",
    branch: "northstar/issue-42-build-report",
    message: "northstar issue 42",
  }), /WORKTREE_NO_CHANGES/);
});

test("root worktree never receives checkout or switch main", async () => {
  const commands = createIssueWorktreeCommandPlan({
    projectRoot: "/repo",
    worktreePath: "/repo/.northstar/runtime/worktrees/issue-1-a",
    branch: "northstar/issue-1-a",
    baseBranch: "main",
  });

  assert.equal(commands.some((command) => command.args.join(" ").includes("checkout main")), false);
  assert.equal(commands.some((command) => command.args.join(" ").includes("switch main")), false);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because worktree operator files are missing.

- [ ] **Step 3: Implement git executor types**

```ts
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandRunner {
  (command: { command: string; args: string[] }): Promise<ProcessResult>;
}

export class GitOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GitOperationError";
    this.code = code;
  }
}
```

- [ ] **Step 4: Implement worktree operator**

```ts
import { join, resolve } from "node:path";
import { commandSpec } from "../platform/process.ts";
import { redactSecrets } from "../../runtime/redaction.ts";
import type { GitCommandRunner } from "./executor.ts";
import { GitOperationError } from "./executor.ts";

export class SoftwareDevWorktreeOperator {
  constructor(private readonly options: {
    projectRoot: string;
    worktreesDir: string;
    baseBranch: string;
    runCommand: GitCommandRunner;
  }) {}

  async prepareIssueWorktree(input: { issueNumber: number; slug: string }) {
    const safeSlug = sanitizeSlug(input.slug);
    const branch = `northstar/issue-${input.issueNumber}-${safeSlug}`;
    const path = resolve(this.options.projectRoot, this.options.worktreesDir, `issue-${input.issueNumber}-${safeSlug}`);
    const command = commandSpec("git", ["-C", this.options.projectRoot, "worktree", "add", "-b", branch, path, this.options.baseBranch]);
    const result = await this.options.runCommand(command);
    if (result.exitCode !== 0 && !/already exists/i.test(result.stderr)) {
      throw new GitOperationError("WORKTREE_CREATE_FAILED", redactSecrets(result.stderr));
    }
    return { path, branch };
  }

  async commitAndPush(input: { worktreePath: string; branch: string; message: string }) {
    const status = await this.options.runCommand(commandSpec("git", ["-C", input.worktreePath, "status", "--porcelain"]));
    if (status.exitCode !== 0) throw new GitOperationError("WORKTREE_STATUS_FAILED", redactSecrets(status.stderr));
    if (status.stdout.trim().length === 0) throw new GitOperationError("WORKTREE_NO_CHANGES", "WORKTREE_NO_CHANGES");

    for (const command of [
      commandSpec("git", ["-C", input.worktreePath, "add", "-A"]),
      commandSpec("git", ["-C", input.worktreePath, "commit", "-m", input.message]),
      commandSpec("git", ["-C", input.worktreePath, "push", "origin", input.branch]),
    ]) {
      const result = await this.options.runCommand(command);
      if (result.exitCode !== 0) throw new GitOperationError("WORKTREE_GIT_FAILED", redactSecrets(result.stderr));
    }
  }
}

export function createIssueWorktreeCommandPlan(input: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}) {
  return [commandSpec("git", ["-C", input.projectRoot, "worktree", "add", "-b", input.branch, input.worktreePath, input.baseBranch])];
}

export function sanitizeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "issue";
}
```

- [ ] **Step 5: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/git/executor.ts src/adapters/git/software-dev-worktree.ts tests/adapters/git-software-dev-worktree.test.ts tests/index.test.ts
git commit -m "feat: add production worktree operator"
```

---

## Task 5: GitHub Software-Dev Gateway

**Files:**
- Create: `src/adapters/github/software-dev-gateway.ts`
- Create: `tests/adapters/github-software-dev-gateway.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("creates or reuses pull request for branch", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      calls.push({ path: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/pulls?")) return jsonResponse([{ number: 9, html_url: "https://github.com/owner/repo/pull/9" }]);
      return jsonResponse({});
    },
  });

  const pr = await gateway.createOrReusePullRequest({
    title: "Issue 1",
    head: "northstar/issue-1-a",
    base: "main",
    body: "body",
  });

  assert.equal(pr.number, 9);
  assert.equal(pr.reused, true);
});

test("confirmed merge requires merge sha", async () => {
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => jsonResponse({ merged: true }),
  });

  await assert.rejects(() => gateway.mergePullRequest({ number: 1, commit_title: "merge" }), /MERGE_SHA_MISSING/);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because gateway is missing.

- [ ] **Step 3: Implement gateway**

Implement methods:

```ts
export class GitHubSoftwareDevGateway implements SoftwareDevGitHubGateway {
  async createOrReusePullRequest(input: { title: string; head: string; base: string; body: string }) {
    const existing = await this.request<Array<{ number: number; html_url: string }>>(
      `/pulls?state=open&head=${encodeURIComponent(owner(this.repo) + ":" + input.head)}&base=${encodeURIComponent(input.base)}`,
      "GET",
    );
    if (existing[0]) return { ...existing[0], reused: true };
    return { ...(await this.request<{ number: number; html_url: string }>("/pulls", "POST", input)), reused: false };
  }

  async mergePullRequest(input: { number: number; commit_title: string }) {
    const result = await this.request<{ merged?: boolean; sha?: string }>(`/pulls/${input.number}/merge`, "PUT", {
      commit_title: input.commit_title,
      merge_method: "squash",
    });
    if (result.merged && !result.sha) throw new Error("MERGE_SHA_MISSING");
    return { merged: result.merged === true, sha: result.sha ?? "" };
  }
}
```

Also implement:

- `readBranchCommit`
- `createFixtureBranch` compatibility wrapper only if still required by `SoftwareDevGitHubGateway`
- `closeIssue`
- `addIssueComment`
- `updateIssueLabels`
- `updateIssueBodyMarker`
- `createPullRequest` delegating to `createOrReusePullRequest`

All request errors must pass through `redactSecrets`.

- [ ] **Step 4: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/software-dev-gateway.ts tests/adapters/github-software-dev-gateway.test.ts tests/index.test.ts
git commit -m "feat: add production github software gateway"
```

---

## Task 6: GitHub Observability Adapter

**Files:**
- Create: `src/adapters/github/observability.ts`
- Create: `tests/adapters/github-observability.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("issue observability syncs state label, progress comment, and body marker", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes("/issues/5") && init?.method === "GET") return jsonResponse({ body: "user body" });
      return jsonResponse({});
    },
  });

  await adapter.syncIssueProgress({
    issueNumber: 5,
    lifecycleState: "running",
    comment: "Northstar running issue_worker",
    statusMarkdown: "State: running",
  });

  assert.equal(requests.some((item) => item.url.endsWith("/issues/5/labels")), true);
  assert.equal(requests.some((item) => item.url.endsWith("/issues/5/comments")), true);
  assert.equal(requests.some((item) => item.method === "PATCH" && JSON.stringify(item.body).includes("northstar-status")), true);
});

test("projection failure is retryable and does not mutate lifecycle", async () => {
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => new Response("ghp_secret", { status: 500 }),
    now: () => "2026-05-30T00:00:00.000Z",
  });

  const result = await adapter.trySyncIssueProgress({
    issueNumber: 5,
    lifecycleState: "running",
    comment: "comment",
    statusMarkdown: "state",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.projection_target, "github_observability");
  assert.doesNotMatch(result.last_error, /ghp_secret/);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because adapter is missing.

- [ ] **Step 3: Implement observability adapter**

Implement:

- `syncIssueProgress`
- `trySyncIssueProgress`
- `syncPrProgress`
- `syncProjectFields`
- `replaceStatusMarker(body, markdown)`

State label mapping:

```ts
const stateLabel: Record<string, string> = {
  ready: "northstar:ready",
  claimed: "northstar:claimed",
  running: "northstar:running",
  verifying: "northstar:verifying",
  verified: "northstar:verified",
  release_pending: "northstar:release-pending",
  completed: "northstar:completed",
  quarantined: "northstar:quarantined",
  failed: "northstar:failed",
};
```

Marker function:

```ts
export function replaceStatusMarker(body: string, markdown: string): string {
  const marker = `<!-- northstar-status -->\n${markdown}\n<!-- /northstar-status -->`;
  const pattern = /<!-- northstar-status -->[\s\S]*?<!-- \/northstar-status -->/;
  return pattern.test(body) ? body.replace(pattern, marker) : `${marker}\n\n${body}`;
}
```

Failures return retryable projection events and never lifecycle events.

- [ ] **Step 4: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/observability.ts tests/adapters/github-observability.test.ts tests/index.test.ts
git commit -m "feat: add github observability adapter"
```

---

## Task 7: Production SDK Worker Factory

**Files:**
- Create: `src/adapters/host/worker-factory.ts`
- Create: `src/adapters/host/codex-worker.ts`
- Create: `src/adapters/host/opencode-worker.ts`
- Create: `tests/adapters/host-worker-factory.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("role host resolver uses global default and role override", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "codex",
    roleOverrides: {
      pr_verifier: { host_adapter: "opencode" },
    },
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
  });

  assert.equal(resolver.resolveHostForRole("issue_worker"), "codex");
  assert.equal(resolver.resolveHostForRole("pr_verifier"), "opencode");
});

test("role host resolver rejects unknown host", () => {
  const resolver = new HostWorkerFactory({
    defaultHost: "codex",
    roleOverrides: {
      issue_worker: { host_adapter: "bad" },
    },
    codexWorker: () => fakeWorker("codex"),
    opencodeWorker: () => fakeWorker("opencode"),
  });

  assert.throws(() => resolver.workerForRole("issue_worker"), /HOST_ADAPTER_UNKNOWN/);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because worker factory is missing.

- [ ] **Step 3: Implement worker factory**

```ts
import type { SoftwareDevWorker } from "../../orchestrator/software-dev-driver.ts";

export type ProductionHostName = "codex" | "opencode";

export class HostWorkerFactory {
  constructor(private readonly input: {
    defaultHost: ProductionHostName;
    roleOverrides: Record<string, Record<string, unknown>>;
    codexWorker: () => SoftwareDevWorker;
    opencodeWorker: () => SoftwareDevWorker;
  }) {}

  resolveHostForRole(roleName: string): ProductionHostName {
    const override = this.input.roleOverrides[roleName]?.host_adapter;
    const host = typeof override === "string" ? override : this.input.defaultHost;
    if (host !== "codex" && host !== "opencode") {
      throw new Error(`HOST_ADAPTER_UNKNOWN: ${host}`);
    }
    return host;
  }

  workerForRole(roleName: string): SoftwareDevWorker {
    return this.resolveHostForRole(roleName) === "opencode"
      ? this.input.opencodeWorker()
      : this.input.codexWorker();
  }
}
```

- [ ] **Step 4: Implement production Codex/OpenCode workers**

Move production-safe SDK worker logic from tests into `src/adapters/host/codex-worker.ts` and `src/adapters/host/opencode-worker.ts`.

Codex worker must:

- import SDK through `codexLoader`
- use SDK default credentials
- run in the issue worktree
- return `root_session_id`, `child_run_id`, `final_response`, `shell_fallbacks: 0`
- avoid `codex` CLI shell-out

OpenCode worker must:

- import SDK through `openCodeLoader`
- use SDK default credentials
- run in the issue worktree
- return `root_session_id`, `child_run_id`, `session_id`, `final_response`, `shell_fallbacks: 0`
- avoid `opencode` CLI shell-out

Credential/config failures must use these error messages:

```text
CODEX_CREDENTIAL_MISSING
OPENCODE_CREDENTIAL_MISSING
HOST_SDK_CONFIG_INVALID
```

- [ ] **Step 5: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/host/worker-factory.ts src/adapters/host/codex-worker.ts src/adapters/host/opencode-worker.ts tests/adapters/host-worker-factory.test.ts tests/index.test.ts
git commit -m "feat: add production sdk worker factory"
```

---

## Task 8: Refactor SoftwareDevDomainDriver To Real Worktree Flow

**Files:**
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `tests/orchestrator/software-dev-driver.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("software-dev driver prepares real issue worktree and commits pushed branch after worker", async () => {
  const calls: string[] = [];
  const driver = new SoftwareDevDomainDriver({
    repo: "owner/repo",
    kind: "codex",
    runId: "run-1",
    github: fakeGithub({ calls }),
    worker: fakeWorker("implementation ok", calls),
    host: new QueuedHostSessionBridge(),
    metrics: emptyMetrics(),
    baseBranch: "main",
    worktree: {
      prepareIssueWorktree: async () => {
        calls.push("prepare-worktree");
        return { path: "/repo/.northstar/runtime/worktrees/issue-1-a", branch: "northstar/issue-1-a" };
      },
      commitAndPush: async () => calls.push("commit-push"),
    },
  });

  const prep = await driver.prepareStage(domainContext({ issueNumber: 1, title: "A" }));
  assert.equal(prep.worktreePath, "/repo/.northstar/runtime/worktrees/issue-1-a");
  assert.equal(prep.branch, "northstar/issue-1-a");

  await driver.finalizeWorkerArtifact(finalizeInput({ issueNumber: 1, branch: prep.branch }));

  assert.deepEqual(calls, ["prepare-worktree", "implementation-worker", "commit-push", "create-pr", "verification-worker"]);
});

test("software-dev driver reuses existing PR and does not duplicate", async () => {
  const github = fakeGithub({ reusedPr: true });
  const driver = driverWithFakeDependencies({ github });
  await driver.prepareStage(domainContext({ issueNumber: 2, title: "Reuse" }));
  const result = await driver.finalizeWorkerArtifact(finalizeInput({ issueNumber: 2 }));

  assert.equal(result.prNumber, 10);
  assert.equal(github.createdPrCount, 0);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because `SoftwareDevDomainDriver` does not accept a worktree operator and still contains fixture-only behavior.

- [ ] **Step 3: Update driver constructor**

Add optional real worktree dependency:

```ts
worktree?: {
  prepareIssueWorktree(input: { issueNumber: number; slug: string }): Promise<{ path: string; branch: string }>;
  commitAndPush(input: { worktreePath: string; branch: string; message: string }): Promise<void>;
};
```

Keep existing fixture behavior only for tests that intentionally do not pass `worktree`, but production factory must always pass it.

- [ ] **Step 4: Update prepare stage**

Use worktree when provided:

```ts
const worktree = this.worktree
  ? await this.worktree.prepareIssueWorktree({ issueNumber: input.issue.number, slug: input.issue.title })
  : { path: `live://${this.kind}/${this.runId}`, branch: `${this.runId}-issue-${input.issue.number}` };
this.branch = worktree.branch;
this.worktreePath = worktree.path;
```

Pass `worktree.path` into worker prompts and worker execution.

- [ ] **Step 5: Update finalize stage**

Before PR creation:

```ts
if (this.worktree) {
  await retryable("commit and push worktree", this.metrics, () => this.worktree!.commitAndPush({
    worktreePath: this.worktreePath,
    branch: this.branch,
    message: `northstar issue ${input.issue.number}: ${input.issue.title}`,
  }));
}
const pr = "createOrReusePullRequest" in this.github
  ? await this.github.createOrReusePullRequest(...)
  : await this.github.createPullRequest(...);
```

- [ ] **Step 6: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/orchestrator/software-dev-driver.ts tests/orchestrator/software-dev-driver.test.ts
git commit -m "feat: run software dev driver through worktrees"
```

---

## Task 9: Production Dependency Factory Wiring

**Files:**
- Create: `src/orchestrator/production-dependencies.ts`
- Modify: `src/orchestrator/production-factory.ts`
- Create: `tests/orchestrator/production-dependencies.test.ts`
- Modify: `tests/orchestrator/production-factory.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("default production factory creates real dependency composition", async () => {
  const created = await createProductionDependencies({
    config: fixtureConfig({
      projectRoot: "/repo",
      repo: "owner/repo",
      hostAdapter: "codex",
    }),
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async () => jsonResponse([]),
    sdkWorkers: {
      codex: () => fakeWorker("codex"),
      opencode: () => fakeWorker("opencode"),
    },
  });

  assert.equal(created.metrics.production_cli_real_dependency_factory, 1);
  assert.equal(created.metrics.production_default_unconfigured_dependencies, 0);
  assert.ok(created.host);
  assert.ok(created.registry);
});

test("production factory writes runtime state under consumer root", () => {
  const result = resolveProductionStorePath({
    projectRoot: "/consumer",
    dbPath: ".northstar/runtime/control-plane.sqlite3",
  });

  assert.equal(result, "/consumer/.northstar/runtime/control-plane.sqlite3");
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because `production-dependencies.ts` is missing.

- [ ] **Step 3: Implement `createProductionDependencies`**

Inputs:

```ts
export async function createProductionDependencies(input: {
  config: RuntimeConfig;
  usage: "cli" | "watch";
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  runCommand?: CommandRunner;
  sdkWorkers?: {
    codex?: () => SoftwareDevWorker;
    opencode?: () => SoftwareDevWorker;
  };
})
```

Build:

- GitHub token through `resolveGitHubToken`.
- `GitHubIssueIntakeAdapter`.
- `GitHubSoftwareDevGateway`.
- `GitHubObservabilityAdapter`.
- `SoftwareDevWorktreeOperator`.
- `QueuedHostSessionBridge`.
- `HostWorkerFactory`.
- `DomainDriverRegistry` resolving `SoftwareDevDomainDriver`.

Metrics:

```ts
production_cli_real_dependency_factory: input.usage === "cli" ? 1 : 0
production_watch_real_dependency_factory: input.usage === "watch" ? 1 : 0
production_default_unconfigured_dependencies: 0
```

- [ ] **Step 4: Replace unconfigured default factory**

In `src/orchestrator/production-factory.ts`, make `createProductionOrchestratorFromDefaultFactory` async if needed:

```ts
export async function createProductionOrchestratorFromDefaultFactory(input: { ... }) {
  const dependencies = await createProductionDependencies({ config: input.config, usage: input.usage ?? "cli" });
  return createProductionOrchestratorFromFactory({
    ...input,
    host: dependencies.host,
    registry: dependencies.registry,
    store: input.store,
  });
}
```

Update callers to await it.

- [ ] **Step 5: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/production-dependencies.ts src/orchestrator/production-factory.ts tests/orchestrator/production-dependencies.test.ts tests/orchestrator/production-factory.test.ts tests/index.test.ts
git commit -m "feat: wire real production dependencies"
```

---

## Task 10: CLI Intake Reads GitHub Issue And Uses Async Production Factory

**Files:**
- Modify: `src/cli/entrypoint.ts`
- Modify: `tests/cli/manual-orchestrator-cli.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("manual intake reads issue details from production github intake adapter", async () => {
  const calls: unknown[] = [];
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async (input) => {
        calls.push(input);
        return { ok: true };
      },
      startIssue: async () => ({ ok: true }),
      reconcileIssue: async () => ({ ok: true }),
      releaseIssue: async () => ({ ok: true }),
      inspectIssue: () => ({ ok: true }),
    }),
    readIssue: async (issueNumber) => ({
      issueId: `github:${issueNumber}`,
      number: issueNumber,
      title: "GitHub title",
      body: "GitHub body",
      sourceUrl: "https://github.com/owner/repo/issues/55",
      labels: ["northstar:ready"],
      dependencies: [],
    }),
  });

  await runner(["intake", "--issue", "55", "--config", "tests/fixtures/.northstar.yaml"]);

  assert.deepEqual(calls[0], {
    issueNumber: 55,
    title: "GitHub title",
    body: "GitHub body",
    sourceUrl: "https://github.com/owner/repo/issues/55",
    labels: ["northstar:ready"],
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because manual command runner has no `readIssue` dependency.

- [ ] **Step 3: Update manual runner**

Add optional dependency:

```ts
readIssue?: (issueNumber: number, command: BuiltCliCommand) => Promise<GitHubReadyIssue>;
```

For `intake --issue`:

```ts
const githubIssue = options.readIssue
  ? await options.readIssue(issueNumber, command)
  : undefined;
return await orchestrator.intakeIssue({
  issueNumber,
  title: githubIssue?.title ?? optionValue(command.args, "--title") ?? `Issue ${issue}`,
  body: githubIssue?.body ?? optionValue(command.args, "--body") ?? "",
  sourceUrl: githubIssue?.sourceUrl ?? optionValue(command.args, "--source-url") ?? `https://github.com/${command.config.github.repo}/issues/${issue}`,
  labels: githubIssue?.labels ?? [optionValue(command.args, "--label") ?? command.config.github.intake.label],
});
```

In production `main`, create production dependencies and pass `readIssue`.

- [ ] **Step 4: Update async default factory callers**

Because default factory now resolves credentials, ensure `entrypoint.ts` awaits factory creation.

- [ ] **Step 5: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/entrypoint.ts tests/cli/manual-orchestrator-cli.test.ts
git commit -m "feat: read github issue during manual intake"
```

---

## Task 11: Watch Discovers Ready Issues Before Scheduling

**Files:**
- Modify: `src/cli/watch-command.ts`
- Modify: `tests/orchestrator/watch-orchestrator.test.ts` or create `tests/cli/watch-command-production.test.ts`

- [ ] **Step 1: Write failing test**

```ts
test("watch intakes ready github issues before running cycle", async () => {
  const calls: string[] = [];
  const result = await runWatchCycleWithProductionIntake({
    listReadyIssues: async () => [
      readyIssue({ number: 2, title: "Second" }),
      readyIssue({ number: 1, title: "First" }),
    ],
    orchestrator: {
      intakeIssue: async (input) => calls.push(`intake:${input.issueNumber}`),
      runCycle: async () => ({ activeIssues: 2, effectsStarted: 1, historyRows: 3 }),
    },
    maxStarts: 1,
    autoRelease: false,
  });

  assert.deepEqual(calls, ["intake:1", "intake:2"]);
  assert.equal(result.activeIssues, 2);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because watch does not discover GitHub issues.

- [ ] **Step 3: Implement watch intake helper**

Create exported helper in `watch-command.ts`:

```ts
export async function runWatchCycleWithProductionIntake(input: {
  listReadyIssues(): Promise<GitHubReadyIssue[]>;
  orchestrator: {
    intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }): Promise<unknown>;
    runCycle(input: { autoRelease: boolean; maxStarts: number }): Promise<{ activeIssues: number; effectsStarted: number; historyRows?: number }>;
  };
  maxStarts: number;
  autoRelease: boolean;
}) {
  const issues = await input.listReadyIssues();
  for (const issue of issues.sort((a, b) => a.number - b.number)) {
    await input.orchestrator.intakeIssue({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      sourceUrl: issue.sourceUrl,
      labels: issue.labels,
    });
  }
  return await input.orchestrator.runCycle({ autoRelease: input.autoRelease, maxStarts: input.maxStarts });
}
```

Use this helper inside `runWatchCommand`.

- [ ] **Step 4: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/watch-command.ts tests/cli/watch-command-production.test.ts
git commit -m "feat: let watch intake ready github issues"
```

---

## Task 12: Dependency Scheduling From Marker And Native Issue Dependencies

**Files:**
- Modify: `src/orchestrator/dependencies.ts`
- Modify: `src/orchestrator/scheduler.ts`
- Modify: `tests/orchestrator/dependencies.test.ts`
- Modify: `tests/orchestrator/scheduler.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("scheduler blocks issue until Depends-On issue is completed", () => {
  const scheduled = scheduleReadyIssues({
    issues: [
      scheduledIssue({ issueId: "github:1", number: 1, lifecycle: "completed" }),
      scheduledIssue({ issueId: "github:2", number: 2, lifecycle: "ready", dependencies: [1] }),
      scheduledIssue({ issueId: "github:3", number: 3, lifecycle: "ready", dependencies: [99] }),
    ],
    maxStarts: 2,
  });

  assert.deepEqual(scheduled.startable.map((item) => item.issueId), ["github:2"]);
  assert.deepEqual(scheduled.blocked.map((item) => item.issueId), ["github:3"]);
  assert.equal(scheduled.metrics.dependency_order_violations, 0);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because scheduler does not consider merged marker/native dependency issue numbers.

- [ ] **Step 3: Add dependency model**

Persist dependencies in `runtime_context_json` when issue is intaked:

```ts
dependencies: {
  issue_numbers: [123],
  blocked_reason: "waiting_for_dependency",
}
```

Update scheduler to:

- map completed issue numbers from snapshots
- block ready issues whose merged marker/native dependency numbers are not completed
- sort startable issues by issue number
- return auditable blocked reason

- [ ] **Step 4: Run tests to verify GREEN**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/dependencies.ts src/orchestrator/scheduler.ts tests/orchestrator/dependencies.test.ts tests/orchestrator/scheduler.test.ts
git commit -m "feat: schedule issues by discovered dependencies"
```

---

## Task 13: Restart/Resume Reconstruction

**Files:**
- Modify: `src/orchestrator/software-dev-driver.ts`
- Modify: `src/runtime/store.ts` if metadata querying helper is needed
- Create: `tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts`
- Create: `tests/e2e-production-cli-watch/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing offline E2E resume test**

```ts
test("production cli/watch resumes existing worktree branch and PR after restart", async () => {
  const harness = await createProductionCliWatchHarness();

  await harness.createReadyIssue({ number: 10, title: "Resume smoke" });
  await harness.runWatchCycle();
  await harness.simulateProcessRestart();
  await harness.runWatchCycle();
  await harness.runWatchCycle({ autoRelease: true });

  const metrics = harness.metrics();
  assert.equal(metrics.resume_after_watch_restart_completed, 1);
  assert.equal(metrics.resume_reuses_existing_worktree, 1);
  assert.equal(metrics.resume_reuses_existing_branch, 1);
  assert.equal(metrics.resume_reuses_existing_pr, 1);
  assert.equal(metrics.resume_duplicate_prs_created, 0);
  assert.equal(metrics.resume_completed_reversals, 0);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm run test:e2e:production-cli-watch
```

Expected: FAIL because command or resume support is missing.

- [ ] **Step 3: Implement E2E harness with fake dependencies**

Harness uses:

- temp consumer repo
- fake GitHub issue/PR store
- fake SDK workers that write files into issue worktree
- real SQLite store
- production dependency factory with injected fakes

Required fake worker behavior:

```ts
async runImplementation(input) {
  await writeFile(join(input.worktree_path, "northstar-output.json"), JSON.stringify({ issue: input.issue_number }));
  return { root_session_id: "root-impl", child_run_id: "child-impl", final_response: "{\"status\":\"ok\"}", shell_fallbacks: 0 };
}
```

- [ ] **Step 4: Add reconstruction support**

The driver must reconstruct from persisted runtime context/history:

- worktree path
- branch
- PR number/URL
- merge SHA

If the worktree/branch/PR exists, reuse it and increment resume metrics.

- [ ] **Step 5: Run E2E to verify GREEN**

```bash
npm run test:e2e:production-cli-watch
```

Expected: PASS and metrics match resume acceptance.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/software-dev-driver.ts src/runtime/store.ts tests/e2e-production-cli-watch package.json
git commit -m "feat: resume production cli watch work"
```

---

## Task 14: GitHub Observability In Orchestrator Flow

**Files:**
- Modify: `src/orchestrator/production-dependencies.ts`
- Modify: `src/orchestrator/cycle.ts`
- Modify: `tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts`

- [ ] **Step 1: Write failing E2E observability test**

```ts
test("production flow syncs issue labels comments marker and PR evidence", async () => {
  const harness = await createProductionCliWatchHarness();

  await harness.createReadyIssue({ number: 11, title: "Observe smoke" });
  await harness.runWatchCycle();
  await harness.runWatchCycle();
  await harness.runWatchCycle({ autoRelease: true });

  const metrics = harness.metrics();
  assert.equal(metrics.github_issue_state_labels_synced >= 1, true);
  assert.equal(metrics.github_issue_progress_comments_created >= 3, true);
  assert.equal(metrics.github_issue_status_marker_updated >= 1, true);
  assert.equal(metrics.github_pr_body_contains_source_issue, 1);
  assert.equal(metrics.github_pr_verifier_comment_created >= 1, true);
  assert.equal(metrics.github_projection_failures_do_not_mutate_lifecycle, 1);
});
```

- [ ] **Step 2: Run E2E to verify RED**

```bash
npm run test:e2e:production-cli-watch
```

Expected: FAIL because observability is not invoked by the flow.

- [ ] **Step 3: Inject observability into production dependencies**

Expose callbacks to the orchestrator/domain driver:

- on issue intake
- on stage start
- on PR created/reused
- on verifier result
- on release result
- on quarantine/failure

If cycle currently has no callback interface, add a small `ProductionObservers` interface and default no-op implementation:

```ts
export interface ProductionObservers {
  issueProgress(input: IssueProgressProjection): Promise<void>;
  prProgress(input: PrProgressProjection): Promise<void>;
}
```

Projection failures become history rows with retryable status and do not mutate lifecycle.

- [ ] **Step 4: Run E2E to verify GREEN**

```bash
npm run test:e2e:production-cli-watch
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/production-dependencies.ts src/orchestrator/cycle.ts tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts
git commit -m "feat: project production progress to github"
```

---

## Task 15: Consumer Repo CLI Invocation And Built-In Workflow Resolution

**Files:**
- Modify: `src/orchestrator/production-factory.ts`
- Modify: `src/types/workflow.ts`
- Modify: `tests/cli/packaging.test.ts`
- Modify: `tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
test("northstar cwd is not required for consumer config run", async () => {
  const harness = await createConsumerRepoCliHarness();

  const result = await harness.runNorthstarFromConsumerRepo(["inspect", "--issue", "1", "--config", ".northstar.yaml", "--dry-run"]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.metrics.northstar_cwd_not_required_for_consumer_run, 1);
});

test("builtin workflow resolves package relative", () => {
  const path = resolveBuiltinWorkflowPath({
    packageName: "northstar/workflows/issue-to-pr-release",
    workflowId: "issue_to_pr_release",
  });

  assert.match(path, /tests\/fixtures\/workflows\/issue-to-pr-release\.yaml$/);
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
npm test
```

Expected: FAIL because workflow path is based on `process.cwd()`.

- [ ] **Step 3: Implement package-relative workflow resolution**

Use module-relative resolution:

```ts
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
return resolve(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml");
```

Keep explicit `workflow.path` support:

```ts
if (config.workflow.path) return resolve(config.project.root, config.workflow.path);
```

- [ ] **Step 4: Run tests to verify GREEN**

```bash
npm test
npm run test:e2e:production-cli-watch
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/production-factory.ts src/types/workflow.ts tests/cli/packaging.test.ts tests/e2e-production-cli-watch/production-cli-watch-e2e.test.ts
git commit -m "feat: support consumer repo northstar invocation"
```

---

## Task 16: Production Live E2E Uses Configured Consumer Repo Worktree Flow

**Files:**
- Modify: `tests/e2e-production-live/production-live.test.ts`
- Modify: `tests/e2e-production-live/index.test.ts`
- Modify: production adapters as needed

- [ ] **Step 1: Write failing live acceptance assertions**

Update production-live E2E to assert:

```ts
assert.equal(metrics.consumer_repo_configurable, 1);
assert.equal(metrics.sandbox_repo_hardcoded_in_src, 0);
assert.equal(metrics.consumer_project_root_configurable, 1);
assert.equal(metrics.production_live_runs_against_configured_repo, 1);
assert.equal(metrics.worktrees_created >= 1, true);
assert.equal(metrics.branches_pushed >= 1, true);
assert.equal(metrics.prs_created >= 1, true);
assert.equal(metrics.confirmed_merges >= 1, true);
assert.equal(metrics.github_issues_closed >= 1, true);
```

- [ ] **Step 2: Run live test to verify RED or clear skip**

Without flag:

```bash
npm run test:e2e:production-live
```

Expected: clear skip.

With flag:

```bash
GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live
```

Expected: FAIL until live test uses real consumer-configured worktree flow.

- [ ] **Step 3: Migrate live test to production CLI/watch path**

The live test must:

- create temp consumer repo clone or temp git repo configured to sandbox remote
- write `.northstar.yaml` pointing at temp consumer root and configured repo
- create one ready GitHub issue
- invoke production factory through CLI/watch helpers
- let worker modify local worktree
- commit/push branch
- create/reuse PR
- merge PR
- close issue
- inspect completed lifecycle

Do not hardcode sandbox repo in `src`.

- [ ] **Step 4: Run live test to verify GREEN**

```bash
GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live
```

Expected:

```text
production_live_runs_against_configured_repo=1
worktrees_created>=1
branches_pushed>=1
prs_created>=1
confirmed_merges>=1
github_issues_closed>=1
production_secret_leaks=0
production_shell_chain_commands=0
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e-production-live/production-live.test.ts tests/e2e-production-live/index.test.ts src
git commit -m "test: run production live through consumer config"
```

---

## Task 17: Manual Runbook Update

**Files:**
- Modify: `docs/manuals/2026-05-30-northstar-manual-runbook.zh-TW.md`

- [ ] **Step 1: Update manual for real CLI/watch**

Replace the previous limitation text with:

```md
一般 `northstar start/reconcile/release/watch` 現在會透過 production dependency factory 建立真實 GitHub/Git/SDK dependencies。完整 live flow 可透過 consumer repo 的 `.northstar.yaml` 執行。
```

Add production commands:

```bash
cd /home/me/apps/my-consumer-repo
GITHUB_TOKEN="$(gh auth token)" npx northstar watch --config .northstar.yaml --interval-ms 1000 --max-cycles 10
GITHUB_TOKEN="$(gh auth token)" npx northstar intake --issue 123 --config .northstar.yaml
GITHUB_TOKEN="$(gh auth token)" npx northstar start --issue 123 --config .northstar.yaml
GITHUB_TOKEN="$(gh auth token)" npx northstar reconcile --issue 123 --config .northstar.yaml
GITHUB_TOKEN="$(gh auth token)" npx northstar release --issue 123 --config .northstar.yaml
GITHUB_TOKEN="$(gh auth token)" npx northstar inspect --issue 123 --config .northstar.yaml
```

- [ ] **Step 2: Run doc sanity scan**

```bash
rg "還不是完整 live operator CLI|尚未接上真實 SDK/GitHub" docs/manuals/2026-05-30-northstar-manual-runbook.zh-TW.md
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/manuals/2026-05-30-northstar-manual-runbook.zh-TW.md
git commit -m "docs: update production cli watch manual"
```

---

## Task 18: Final Verification Gate

**Files:**
- No source files unless verification reveals a defect.

- [ ] **Step 1: Run offline unit tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run offline E2E tests**

```bash
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:e2e:production-cli-watch
```

Expected: PASS. No GitHub token, SDK credentials, network, or host CLI required.

- [ ] **Step 3: Run coverage**

```bash
npm run test:coverage
```

Expected: PASS with all configured thresholds >= 85%.

- [ ] **Step 4: Verify production live clear skip**

```bash
npm run test:e2e:production-live
```

Expected: clear skip when `NORTHSTAR_PRODUCTION_LIVE` is not set.

- [ ] **Step 5: Run production live**

```bash
GITHUB_TOKEN="$(gh auth token)" NORTHSTAR_PRODUCTION_LIVE=1 NORTHSTAR_LIVE_GITHUB_REPO=paulpai0412/northstar-live-sandbox npm run test:e2e:production-live
```

Expected: PASS with real issue, worktree, branch, commit, push, PR, merge, issue close.

- [ ] **Step 6: Verify CLI help**

```bash
node --run northstar -- --help
node --run northstar -- watch --help
```

Expected: both PASS.

- [ ] **Step 7: Run source safety scans**

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "paulpai0412/northstar-live-sandbox" src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
rg "readFileSync|writeFileSync|DatabaseSync|fetch\\(|spawn\\(|execFile\\(" src/runtime/state-machine.ts
```

Expected: no output.

- [ ] **Step 8: Check git status**

```bash
git status --short
```

Expected: only intentional files are modified before final commit, or clean after final commit.

- [ ] **Step 9: Final commit**

```bash
git add src tests docs package.json tests/fixtures/.northstar.yaml
git commit -m "feat: wire production cli watch dependencies"
```

---

## Final Report Requirements

The implementing agent must report:

- Implementation plan path.
- Production dependency factory metrics.
- Consumer repo config metrics.
- GitHub issue intake metrics.
- Native linked issue dependency discovery metrics.
- Worktree/branch/PR/merge metrics.
- Resume metrics.
- GitHub observability metrics.
- Live issue/PR URLs and merge SHAs.
- RED -> GREEN evidence.
- Fresh verification output summary.
- Modified files summary.
- Remaining deferred work: OS service packaging, npm publish, `content_creation`, `office_automation`.

## Plan Self-Review

- Spec coverage: Tasks 1-17 plus Task 3A map to config, credentials, issue intake, native linked issue discovery, host resolution, worktree operator, GitHub gateway, observability, production dependency wiring, CLI/watch flow, resume, live E2E, and docs.
- Red-flag scan: This plan has no empty markers and no intentionally vague implementation steps.
- Type consistency: New factory, adapter, worker, and metric names are introduced before later tasks use them.
- Scope check: The plan stays focused on production CLI/watch real dependencies for software development. Other domains remain out of scope.

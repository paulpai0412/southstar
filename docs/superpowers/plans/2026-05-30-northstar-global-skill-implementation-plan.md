# Northstar Global Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repo-managed Northstar Codex skill that can be synchronized globally and used from consumer repositories to bootstrap, doctor, operate, observe, and safely recover Northstar software-development issue flows.

**Architecture:** The Northstar repository remains the source of truth for the skill. The skill delegates runtime behavior to existing Northstar CLI/config/GitHub boundaries and uses focused Node scripts for cross-platform sync, doctor checks, config rendering, Project viewer definitions, operator command planning, and recovery diagnosis. Offline tests verify the skill contract without network, GitHub token, or SDK credentials.

**Tech Stack:** Node.js ESM scripts, Node test runner, existing Northstar TypeScript tests, `fs/promises`, `path`, `os`, `child_process.execFile`, `.northstar.yaml` template rendering, existing CLI scripts.

---

## Scope Check

This plan implements the first version of the Bootstrap + Operator skill from `docs/superpowers/specs/2026-05-30-northstar-global-skill-design.md`.

In scope:

- Repo-managed local skill source under `skills/northstar`.
- Global skill sync by direct overwrite.
- Cross-platform Node script utilities.
- Config draft rendering with confirmation-gated write behavior.
- Doctor/readiness checks.
- Project fields/views definitions and confirmation gate.
- Operator command mapping.
- Safety-gated recovery diagnosis.
- Deterministic Linux/macOS/Windows portability tests.

Out of scope:

- npm publish.
- Codex plugin packaging.
- OS service installation.
- Live three-OS CI matrix.
- Content creation and office automation drivers.

## File Structure

- Create `skills/northstar/SKILL.md`: Natural-language skill instructions and operational workflows.
- Create `skills/northstar/README.md`: Human-readable installation and usage notes.
- Create `skills/northstar/templates/northstar.yaml`: Consumer `.northstar.yaml` template with explicit replacement markers.
- Create `skills/northstar/templates/workflow.issue-to-pr-release.yaml`: Software-development workflow template.
- Create `skills/northstar/scripts/lib/platform.mjs`: Cross-platform filesystem, command, executable, and path helpers.
- Create `skills/northstar/scripts/lib/config-renderer.mjs`: Consumer repo detection and `.northstar.yaml` draft rendering.
- Create `skills/northstar/scripts/lib/doctor.mjs`: Structured readiness checks.
- Create `skills/northstar/scripts/lib/project-viewer.mjs`: GitHub Project field/view definitions and setup plan.
- Create `skills/northstar/scripts/lib/operator-commands.mjs`: Natural-language intent to Northstar CLI command plan mapping.
- Create `skills/northstar/scripts/lib/recovery.mjs`: Recovery diagnosis and risk policy.
- Create `skills/northstar/scripts/sync-global.mjs`: Directly overwrite global skill target.
- Create `skills/northstar/scripts/doctor.mjs`: CLI wrapper for doctor checks.
- Create `skills/northstar/scripts/render-config.mjs`: CLI wrapper for config draft rendering.
- Modify `package.json`: Add `skill:sync`, `skill:doctor`, and `skill:render-config`.
- Modify `tests/index.test.ts`: Import skill tests.
- Create `tests/skills/northstar-skill-files.test.ts`: Skill source and npm script tests.
- Create `tests/skills/northstar-platform.test.ts`: Cross-platform helper tests.
- Create `tests/skills/northstar-sync.test.ts`: Global sync overwrite tests.
- Create `tests/skills/northstar-config-renderer.test.ts`: Config draft and confirmation tests.
- Create `tests/skills/northstar-doctor.test.ts`: Doctor readiness tests.
- Create `tests/skills/northstar-project-viewer.test.ts`: Project field/view tests.
- Create `tests/skills/northstar-operator-commands.test.ts`: Operator command mapping tests.
- Create `tests/skills/northstar-recovery.test.ts`: Recovery diagnosis and risk tests.
- Create `tests/skills/northstar-portability.test.ts`: Linux/macOS/Windows portability gates.

## Task 1: Skill Source Scaffold And npm Scripts

**Files:**
- Create: `skills/northstar/SKILL.md`
- Create: `skills/northstar/README.md`
- Create: `skills/northstar/templates/northstar.yaml`
- Create: `skills/northstar/templates/workflow.issue-to-pr-release.yaml`
- Modify: `package.json`
- Modify: `tests/index.test.ts`
- Create: `tests/skills/northstar-skill-files.test.ts`

- [ ] **Step 1: Write the failing skill source test**

Add `tests/skills/northstar-skill-files.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");

test("northstar skill source files and package scripts exist", async () => {
  const skill = await readFile(join(repoRoot, "skills/northstar/SKILL.md"), "utf8");
  const readme = await readFile(join(repoRoot, "skills/northstar/README.md"), "utf8");
  const configTemplate = await readFile(join(repoRoot, "skills/northstar/templates/northstar.yaml"), "utf8");
  const workflowTemplate = await readFile(join(repoRoot, "skills/northstar/templates/workflow.issue-to-pr-release.yaml"), "utf8");
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

  assert.match(skill, /Northstar Global Skill/);
  assert.match(skill, /setup this repo/i);
  assert.match(skill, /recover stuck issues/i);
  assert.match(readme, /npm run skill:sync/);
  assert.match(configTemplate, /__PROJECT_ROOT__/);
  assert.match(configTemplate, /auto_release: true/);
  assert.match(configTemplate, /project:\n    enabled: false/);
  assert.match(workflowTemplate, /issue_to_pr_release/);
  assert.equal(pkg.scripts["skill:sync"], "node skills/northstar/scripts/sync-global.mjs");
  assert.equal(pkg.scripts["skill:doctor"], "node skills/northstar/scripts/doctor.mjs");
  assert.equal(pkg.scripts["skill:render-config"], "node skills/northstar/scripts/render-config.mjs");
});
```

- [ ] **Step 2: Import the failing test**

Add this line to `tests/index.test.ts` after the CLI tests:

```ts
import "./skills/northstar-skill-files.test.ts";
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with an error like `ENOENT: no such file or directory, open '.../skills/northstar/SKILL.md'`.

- [ ] **Step 4: Add minimal skill files**

Create `skills/northstar/SKILL.md`:

```markdown
---
name: northstar
description: Operate Northstar from a consumer repository: bootstrap config, run doctor checks, watch ready issues, operate one issue, observe progress, recover stuck issues, and sync this skill globally.
---

# Northstar Global Skill

Use this skill when the user asks to set up, operate, observe, or recover Northstar in a consumer repository.

## Core Rules

- Treat the current directory as the consumer repository unless the user gives another path.
- Do not write `.northstar.yaml` until the user confirms the generated draft.
- Do not create or modify GitHub Projects, fields, or views until the user confirms.
- Do not write secrets to config, docs, logs, SQLite history, worker prompts, Project fields, issue comments, or PR comments.
- Use Northstar CLI through an explicit `--config` path.
- Prefer the local Northstar repository discovered by `NORTHSTAR_ROOT` or doctor checks.
- Use package or `npx northstar` mode only when configured or when local mode is unavailable and the user confirms.
- Use safety-gated recovery. Low-risk inspect/reconcile actions may run automatically; medium/high-risk actions require confirmation.

## Natural Language Intents

- "Set up this repo for Northstar."
- "Check whether Northstar can run here."
- "Start watching ready issues."
- "Run issue #123."
- "Inspect issue #123."
- "Release issue #123."
- "Show Northstar progress."
- "Recover issue #123."
- "Recover stuck issues."
- "Sync the Northstar skill globally."

## Workflows

### Bootstrap

1. Run doctor checks.
2. Detect git root, GitHub remote, default branch, and existing `.northstar.yaml`.
3. Render a config draft with `runtime.auto_release: true`, `runtime.host_adapter: codex`, and `github.project.enabled: false`.
4. Show the draft summary.
5. Ask before writing `.northstar.yaml`.

### Operate

Map issue operations to Northstar CLI command plans:

- `intake`
- `start`
- `reconcile`
- `release`
- `inspect`
- `watch`

### Recover

1. Inspect runtime and GitHub state.
2. Diagnose stuck state.
3. Produce a recovery report.
4. Ask before medium or high-risk actions.
```

Create `skills/northstar/README.md`:

```markdown
# Northstar Skill

This directory is the source of truth for the Northstar Codex skill.

## Sync

Run:

```bash
npm run skill:sync
```

This overwrites the global skill at `~/.codex/skills/northstar` or `%USERPROFILE%\.codex\skills\northstar`.

## Doctor

Run:

```bash
npm run skill:doctor -- --json
```

## Render Consumer Config

Run from a consumer repo:

```bash
npm run skill:render-config -- --cwd /path/to/consumer --json
```
```

Create `skills/northstar/templates/northstar.yaml`:

```yaml
schema_version: "1.1"

project:
  name: __PROJECT_NAME__
  root: "__PROJECT_ROOT__"

runtime:
  db_path: .northstar/runtime/control-plane.sqlite3
  host_adapter: codex
  development_capacity: 1
  release_capacity: 1
  heartbeat_interval_seconds: 30
  lease_timeout_seconds: 600
  child_timeout_seconds: 7200
  auto_release: true
  session_scope: stage_root

workflow:
  package: builtin
  id: issue_to_pr_release
  version: "1.0"
  domain: software_development

github:
  repo: __GITHUB_REPO__
  intake:
    enabled: true
    label: northstar:ready
  sync:
    enabled: true
    retry_backoff_seconds:
      - 30
      - 120
      - 600
  project:
    enabled: false

git:
  base_branch: __BASE_BRANCH__
  worktrees_dir: .northstar/runtime/worktrees
  sync_worktree_dir: .northstar/runtime/sync-worktrees/main

credentials:
  github:
    token_env: GITHUB_TOKEN
    allow_gh_token_fallback: true
  host_sdk:
    codex:
      mode: sdk_default
    opencode:
      mode: sdk_default

policy:
  github_sync_blocks_lifecycle: false
  quarantine_requires_operator: true
```

Create `skills/northstar/templates/workflow.issue-to-pr-release.yaml`:

```yaml
workflow:
  id: issue_to_pr_release
  version: "1.0"
  domain: software_development
  roles:
    issue_worker:
      run_mode: background_child
      agent: build
      model: gpt-5
      load_skills:
        - tdd
      prompt_template: "Implement {{issue_title}} from {{issue_body}} in {{worktree_path}} on {{branch}} and return {{expected_artifact_fields}}."
      artifact: worker_result
      timeout_seconds: 7200
      retry_policy:
        max_attempts: 2
        backoff_seconds:
          - 30
          - 120
    pr_verifier:
      run_mode: background_child
      agent: review
      model: gpt-5
      load_skills:
        - review-work
      artifact: evidence_packet
      timeout_seconds: 7200
    release_worker:
      run_mode: background_child
      agent: release
      model: gpt-5
      load_skills:
        - git-master
      artifact: release_result
      timeout_seconds: 3600
  stages:
    implementation:
      lifecycle_state: running
      role: issue_worker
      on_success: verification
      on_blocked: quarantined
      on_failed_retryable: implementation
      on_failed_terminal: failed
    verification:
      lifecycle_state: verifying
      role: pr_verifier
      on_pass: verified
      on_success: verified
      on_fail_retryable: implementation
      on_fail_terminal: failed
    release:
      lifecycle_state: release_pending
      role: release_worker
      on_success: completed
      on_blocked_transient: verified
      on_failed_terminal: failed
```

- [ ] **Step 5: Add npm scripts**

Modify `package.json` scripts:

```json
"skill:sync": "node skills/northstar/scripts/sync-global.mjs",
"skill:doctor": "node skills/northstar/scripts/doctor.mjs",
"skill:render-config": "node skills/northstar/scripts/render-config.mjs"
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill source files and package scripts exist`.

- [ ] **Step 7: Commit**

Run:

```bash
git add package.json tests/index.test.ts tests/skills/northstar-skill-files.test.ts skills/northstar
git commit -m "feat: scaffold northstar global skill"
```

## Task 2: Cross-Platform Script Library

**Files:**
- Create: `skills/northstar/scripts/lib/platform.mjs`
- Create: `tests/skills/northstar-platform.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing platform tests**

Create `tests/skills/northstar-platform.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const platformLib = "../../skills/northstar/scripts/lib/platform.mjs";

test("northstar skill platform helpers resolve global skill dir by platform", async () => {
  const { globalSkillDirForHome } = await import(platformLib);

  assert.equal(globalSkillDirForHome({ platform: "linux", home: "/home/alice" }), "/home/alice/.codex/skills/northstar");
  assert.equal(globalSkillDirForHome({ platform: "darwin", home: "/Users/alice" }), "/Users/alice/.codex/skills/northstar");
  assert.equal(globalSkillDirForHome({ platform: "win32", home: "C:\\Users\\Alice" }), "C:\\Users\\Alice\\.codex\\skills\\northstar");
});

test("northstar skill platform helpers reject shell-chain command specs", async () => {
  const { commandSpec } = await import(platformLib);

  assert.deepEqual(commandSpec("git", ["status"]), { command: "git", args: ["status"] });
  assert.throws(() => commandSpec("git", ["status", "&&", "echo bad"]), /NORTHSTAR_SKILL_SHELL_CHAIN/);
  assert.throws(() => commandSpec("cmd && bad", []), /NORTHSTAR_SKILL_SHELL_CHAIN/);
});

test("northstar skill platform helpers copy directories by overwrite", async () => {
  const { copyDirectoryOverwrite } = await import(platformLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-platform-"));
  const source = join(dir, "source");
  const target = join(dir, "target");

  try {
    await writeFile(join(source, "missing-parent.txt"), "fails");
  } catch {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source, { recursive: true }));
    await writeFile(join(source, "a.txt"), "source");
  }
  await import("node:fs/promises").then(({ mkdir }) => mkdir(target, { recursive: true }));
  await writeFile(join(target, "old.txt"), "old");

  await copyDirectoryOverwrite(source, target);
  const { readFile, access } = await import("node:fs/promises");
  assert.equal(await readFile(join(target, "a.txt"), "utf8"), "source");
  await assert.rejects(() => access(join(target, "old.txt")));
  await rm(dir, { recursive: true, force: true });
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-platform.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../skills/northstar/scripts/lib/platform.mjs`.

- [ ] **Step 3: Implement platform helpers**

Create `skills/northstar/scripts/lib/platform.mjs`:

```js
import { execFile } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import path from "node:path";

export function globalSkillDirForHome({ platform = process.platform, home }) {
  const adapter = platform === "win32" ? path.win32 : path.posix;
  return adapter.join(home, ".codex", "skills", "northstar");
}

export function commandSpec(command, args = []) {
  const parts = [command, ...args];
  const invalid = parts.find((part) => /&&|\|\||;/.test(String(part)));
  if (invalid) {
    throw new Error(`NORTHSTAR_SKILL_SHELL_CHAIN: ${invalid}`);
  }
  return { command, args };
}

export function runCommand(spec, options = {}) {
  commandSpec(spec.command, spec.args ?? []);
  return new Promise((resolve) => {
    execFile(spec.command, spec.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export async function copyDirectoryOverwrite(source, target) {
  await rm(target, { recursive: true, force: true });
  await cp(source, target, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
  });
}

export function isWindowsPlatform(platform = process.platform) {
  return platform === "win32";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for all `northstar skill platform helpers` tests.

- [ ] **Step 5: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/platform.mjs tests/skills/northstar-platform.test.ts tests/index.test.ts
git commit -m "feat: add northstar skill platform helpers"
```

## Task 3: Global Skill Sync

**Files:**
- Create: `skills/northstar/scripts/sync-global.mjs`
- Create: `tests/skills/northstar-sync.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing sync tests**

Create `tests/skills/northstar-sync.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const syncModule = "../../skills/northstar/scripts/sync-global.mjs";

test("northstar skill sync overwrites global target", async () => {
  const { syncGlobalSkill } = await import(syncModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-sync-"));
  const source = join(dir, "source");
  const target = join(dir, "target");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# Northstar Global Skill\n");
  await writeFile(join(target, "old.txt"), "old");

  const result = await syncGlobalSkill({ sourceDir: source, targetDir: target });

  assert.equal(result.skill_global_sync_overwrites_target, 1);
  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "# Northstar Global Skill\n");
  await assert.rejects(() => readFile(join(target, "old.txt"), "utf8"));
});

test("northstar skill sync resolves target from home and platform", async () => {
  const { resolveSyncTarget } = await import(syncModule);

  assert.equal(resolveSyncTarget({ platform: "linux", home: "/home/alice" }), "/home/alice/.codex/skills/northstar");
  assert.equal(resolveSyncTarget({ platform: "win32", home: "C:\\Users\\Alice" }), "C:\\Users\\Alice\\.codex\\skills\\northstar");
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-sync.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../sync-global.mjs`.

- [ ] **Step 3: Implement sync script**

Create `skills/northstar/scripts/sync-global.mjs`:

```js
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { copyDirectoryOverwrite, globalSkillDirForHome } from "./lib/platform.mjs";

export function resolveSyncTarget({ platform = process.platform, home = homedir(), targetDir } = {}) {
  return targetDir ?? globalSkillDirForHome({ platform, home });
}

export function defaultSourceDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function syncGlobalSkill({ sourceDir = defaultSourceDir(), targetDir = resolveSyncTarget() } = {}) {
  await copyDirectoryOverwrite(sourceDir, targetDir);
  return {
    sourceDir,
    targetDir,
    skill_global_sync_overwrites_target: 1,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targetFlag = process.argv.indexOf("--target");
  const targetDir = targetFlag === -1 ? undefined : process.argv[targetFlag + 1];
  const result = await syncGlobalSkill({ targetDir });
  console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill sync` tests.

- [ ] **Step 5: Commit**

Run:

```bash
git add skills/northstar/scripts/sync-global.mjs tests/skills/northstar-sync.test.ts tests/index.test.ts
git commit -m "feat: add northstar skill global sync"
```

## Task 4: Consumer Config Renderer

**Files:**
- Create: `skills/northstar/scripts/lib/config-renderer.mjs`
- Create: `skills/northstar/scripts/render-config.mjs`
- Create: `tests/skills/northstar-config-renderer.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing config renderer tests**

Create `tests/skills/northstar-config-renderer.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const rendererModule = "../../skills/northstar/scripts/lib/config-renderer.mjs";

test("northstar skill renders config draft without writing by default", async () => {
  const { renderNorthstarConfigDraft, maybeWriteConfig } = await import(rendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-config-"));
  const draft = renderNorthstarConfigDraft({
    projectName: "consumer",
    projectRoot: dir,
    githubRepo: "owner/consumer",
    baseBranch: "main",
  });

  assert.match(draft.content, /root: "/);
  assert.match(draft.content, /repo: owner\/consumer/);
  assert.match(draft.content, /auto_release: true/);
  assert.match(draft.content, /project:\n    enabled: false/);
  assert.equal(draft.skill_bootstrap_config_draft_created, 1);
  assert.equal(draft.skill_bootstrap_requires_confirmation, 1);
  await assert.rejects(() => readFile(join(dir, ".northstar.yaml"), "utf8"));

  const skipped = await maybeWriteConfig({ path: join(dir, ".northstar.yaml"), content: draft.content, confirmed: false });
  assert.equal(skipped.written, false);
  await assert.rejects(() => readFile(join(dir, ".northstar.yaml"), "utf8"));
});

test("northstar skill writes config only when confirmed", async () => {
  const { maybeWriteConfig } = await import(rendererModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-skill-config-write-"));
  const path = join(dir, ".northstar.yaml");

  const result = await maybeWriteConfig({ path, content: "schema_version: \"1.1\"\n", confirmed: true });

  assert.equal(result.written, true);
  assert.equal(await readFile(path, "utf8"), "schema_version: \"1.1\"\n");
});

test("northstar skill parses github remote into owner repo", async () => {
  const { parseGitHubRemote } = await import(rendererModule);

  assert.equal(parseGitHubRemote("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(parseGitHubRemote("https://example.com/owner/repo.git"), undefined);
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-config-renderer.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../config-renderer.mjs`.

- [ ] **Step 3: Implement config renderer library**

Create `skills/northstar/scripts/lib/config-renderer.mjs`:

```js
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function renderNorthstarConfigDraft(input) {
  const content = [
    'schema_version: "1.1"',
    "",
    "project:",
    `  name: ${input.projectName}`,
    `  root: "${input.projectRoot}"`,
    "",
    "runtime:",
    "  db_path: .northstar/runtime/control-plane.sqlite3",
    "  host_adapter: codex",
    "  development_capacity: 1",
    "  release_capacity: 1",
    "  heartbeat_interval_seconds: 30",
    "  lease_timeout_seconds: 600",
    "  child_timeout_seconds: 7200",
    "  auto_release: true",
    "  session_scope: stage_root",
    "",
    "workflow:",
    "  package: builtin",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "  domain: software_development",
    "",
    "github:",
    `  repo: ${input.githubRepo}`,
    "  intake:",
    "    enabled: true",
    "    label: northstar:ready",
    "  sync:",
    "    enabled: true",
    "    retry_backoff_seconds:",
    "      - 30",
    "      - 120",
    "      - 600",
    "  project:",
    "    enabled: false",
    "",
    "git:",
    `  base_branch: ${input.baseBranch}`,
    "  worktrees_dir: .northstar/runtime/worktrees",
    "  sync_worktree_dir: .northstar/runtime/sync-worktrees/main",
    "",
    "credentials:",
    "  github:",
    "    token_env: GITHUB_TOKEN",
    "    allow_gh_token_fallback: true",
    "  host_sdk:",
    "    codex:",
    "      mode: sdk_default",
    "    opencode:",
    "      mode: sdk_default",
    "",
    "policy:",
    "  github_sync_blocks_lifecycle: false",
    "  quarantine_requires_operator: true",
    "",
  ].join("\n");

  return {
    content,
    skill_bootstrap_config_draft_created: 1,
    skill_bootstrap_requires_confirmation: 1,
  };
}

export async function maybeWriteConfig({ path, content, confirmed }) {
  if (!confirmed) {
    return { written: false, path };
  }
  await writeFile(path, content);
  return { written: true, path };
}

export function parseGitHubRemote(remote) {
  const https = remote.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = remote.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return undefined;
}

export async function renderConfigFromCwd({ cwd = process.cwd(), githubRepo, baseBranch = "main" } = {}) {
  const projectRoot = resolve(cwd);
  const projectName = projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "consumer";
  return renderNorthstarConfigDraft({
    projectName,
    projectRoot,
    githubRepo,
    baseBranch,
  });
}

export async function loadTemplate(path) {
  return await readFile(path, "utf8");
}
```

- [ ] **Step 4: Implement render-config wrapper**

Create `skills/northstar/scripts/render-config.mjs`:

```js
import { join, resolve } from "node:path";
import { maybeWriteConfig, renderConfigFromCwd } from "./lib/config-renderer.mjs";

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cwd = resolve(optionValue(process.argv, "--cwd") ?? process.cwd());
  const githubRepo = optionValue(process.argv, "--github-repo");
  const baseBranch = optionValue(process.argv, "--base-branch") ?? "main";
  const write = process.argv.includes("--write");
  const confirmed = process.argv.includes("--confirmed");
  if (!githubRepo) {
    console.error("NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED");
    process.exitCode = 1;
  } else {
    const draft = await renderConfigFromCwd({ cwd, githubRepo, baseBranch });
    const result = write
      ? await maybeWriteConfig({ path: join(cwd, ".northstar.yaml"), content: draft.content, confirmed })
      : { written: false };
    console.log(JSON.stringify({ ...draft, ...result }, null, 2));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill renders config draft without writing by default`.

- [ ] **Step 6: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/config-renderer.mjs skills/northstar/scripts/render-config.mjs tests/skills/northstar-config-renderer.test.ts tests/index.test.ts
git commit -m "feat: add northstar skill config renderer"
```

## Task 5: Doctor Readiness Checks

**Files:**
- Create: `skills/northstar/scripts/lib/doctor.mjs`
- Create: `skills/northstar/scripts/doctor.mjs`
- Create: `tests/skills/northstar-doctor.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing doctor tests**

Create `tests/skills/northstar-doctor.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const doctorModule = "../../skills/northstar/scripts/lib/doctor.mjs";

test("northstar skill doctor reports platform, sqlite, git, gh, cli, and sdk checks", async () => {
  const { runDoctor } = await import(doctorModule);
  const calls: string[] = [];
  const result = await runDoctor({
    platform: "linux",
    arch: "x64",
    env: { NORTHSTAR_ROOT: "/repo/northstar", GITHUB_TOKEN: "ghp_fake" },
    cwd: "/consumer",
    importModule: async (specifier: string) => {
      if (specifier === "node:sqlite") return {};
      if (specifier === "@openai/codex-sdk") return { Codex: class {} };
      throw new Error(`missing ${specifier}`);
    },
    runCommand: async (spec: { command: string; args: string[] }) => {
      calls.push([spec.command, ...spec.args].join(" "));
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    fileExists: async () => true,
  });

  assert.equal(result.skill_doctor_platform_reported, 1);
  assert.equal(result.skill_doctor_node_sqlite_checked, 1);
  assert.equal(result.skill_doctor_git_gh_checked, 1);
  assert.equal(result.skill_doctor_northstar_cli_checked, 1);
  assert.equal(result.skill_doctor_sdk_checked, 1);
  assert.equal(result.checks.githubCredential.status, "ok");
  assert.equal(result.checks.secrets_redacted, true);
  assert.ok(calls.some((call) => call.includes("git --version")));
  assert.ok(calls.some((call) => call.includes("gh --version")));
});

test("northstar skill doctor reports missing github credential without leaking token values", async () => {
  const { runDoctor } = await import(doctorModule);
  const result = await runDoctor({
    platform: "win32",
    arch: "x64",
    env: {},
    cwd: "C:\\consumer",
    importModule: async () => ({}),
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "bad ghp_secret" }),
    fileExists: async () => false,
  });

  assert.equal(result.checks.githubCredential.status, "error");
  assert.equal(result.checks.githubCredential.code, "NORTHSTAR_GITHUB_CREDENTIAL_MISSING");
  assert.doesNotMatch(JSON.stringify(result), /ghp_secret/);
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-doctor.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../doctor.mjs`.

- [ ] **Step 3: Implement doctor library**

Create `skills/northstar/scripts/lib/doctor.mjs`:

```js
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { commandSpec, runCommand as defaultRunCommand } from "./platform.mjs";

function redact(value) {
  return String(value).replace(/gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+/gi, "[REDACTED]");
}

function ok(extra = {}) {
  return { status: "ok", ...extra };
}

function error(code, message, extra = {}) {
  return { status: "error", code, message: redact(message), ...extra };
}

export async function runDoctor(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const fileExists = options.fileExists ?? (async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });

  const checks = {};
  checks.platform = ok({ platform, arch, cwd });

  try {
    await importModule("node:sqlite");
    checks.nodeSqlite = ok();
  } catch (cause) {
    checks.nodeSqlite = error("NORTHSTAR_NODE_SQLITE_UNAVAILABLE", cause.message);
  }

  const git = await runCommand(commandSpec("git", ["--version"]), { cwd });
  const gh = await runCommand(commandSpec("gh", ["--version"]), { cwd });
  checks.git = git.exitCode === 0 ? ok() : error("NORTHSTAR_GIT_UNAVAILABLE", git.stderr);
  checks.gh = gh.exitCode === 0 ? ok() : error("NORTHSTAR_GH_UNAVAILABLE", gh.stderr);

  checks.githubCredential = env.GITHUB_TOKEN
    ? ok({ source: "env:GITHUB_TOKEN" })
    : error("NORTHSTAR_GITHUB_CREDENTIAL_MISSING", "GITHUB_TOKEN is missing");

  const northstarRoot = env.NORTHSTAR_ROOT ? resolve(env.NORTHSTAR_ROOT) : cwd;
  const packageJson = await fileExists(resolve(northstarRoot, "package.json"));
  checks.northstarRoot = packageJson ? ok({ northstarRoot }) : error("NORTHSTAR_ROOT_MISSING", northstarRoot);
  const cli = packageJson
    ? await runCommand(commandSpec("node", ["--run", "northstar", "--", "--help"]), { cwd: northstarRoot })
    : { exitCode: 1, stderr: "package.json missing" };
  checks.northstarCli = cli.exitCode === 0 ? ok() : error("NORTHSTAR_CLI_UNAVAILABLE", cli.stderr);

  try {
    await importModule("@openai/codex-sdk");
    checks.codexSdk = ok();
  } catch (cause) {
    checks.codexSdk = error("NORTHSTAR_SDK_UNAVAILABLE", cause.message);
  }

  checks.secrets_redacted = !/gh[opsu]_[A-Za-z0-9_]+|github_pat_|sk-/i.test(JSON.stringify(checks));

  return {
    checks,
    skill_doctor_platform_reported: 1,
    skill_doctor_node_sqlite_checked: 1,
    skill_doctor_git_gh_checked: 1,
    skill_doctor_northstar_cli_checked: 1,
    skill_doctor_sdk_checked: checks.codexSdk.status === "ok" ? 1 : 0,
  };
}
```

- [ ] **Step 4: Implement doctor wrapper**

Create `skills/northstar/scripts/doctor.mjs`:

```js
import { runDoctor } from "./lib/doctor.mjs";

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDoctor();
  console.log(JSON.stringify(result, null, 2));
  const hasBlockingError = Object.values(result.checks).some((check) => check?.status === "error")
    && process.argv.includes("--require-ready");
  process.exitCode = hasBlockingError ? 1 : 0;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill doctor` tests.

- [ ] **Step 6: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/doctor.mjs skills/northstar/scripts/doctor.mjs tests/skills/northstar-doctor.test.ts tests/index.test.ts
git commit -m "feat: add northstar skill doctor checks"
```

## Task 6: Project Viewer Definitions And Confirmation Gate

**Files:**
- Create: `skills/northstar/scripts/lib/project-viewer.mjs`
- Create: `tests/skills/northstar-project-viewer.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing Project viewer tests**

Create `tests/skills/northstar-project-viewer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const projectModule = "../../skills/northstar/scripts/lib/project-viewer.mjs";

test("northstar skill defines project fields and views for progress monitoring", async () => {
  const { northstarProjectFields, northstarProjectViews, projectSetupPlan } = await import(projectModule);

  assert.equal(northstarProjectFields.length >= 8, true);
  assert.equal(northstarProjectViews.length >= 5, true);
  assert.ok(northstarProjectFields.some((field) => field.name === "Northstar Lifecycle" && field.type === "single_select"));
  assert.ok(northstarProjectFields.some((field) => field.name === "Northstar PR"));
  assert.ok(northstarProjectViews.some((view) => view.name === "Northstar Board" && view.layout === "board"));
  assert.ok(northstarProjectViews.some((view) => view.name === "Active Runs"));

  const plan = projectSetupPlan({ mode: "create_new", confirmed: false });
  assert.equal(plan.skill_project_setup_requires_confirmation, 1);
  assert.equal(plan.canMutate, false);
  assert.equal(plan.skill_project_fields_defined, northstarProjectFields.length);
  assert.equal(plan.skill_project_views_defined, northstarProjectViews.length);
});

test("northstar project setup can mutate only after confirmation", async () => {
  const { projectSetupPlan } = await import(projectModule);

  assert.equal(projectSetupPlan({ mode: "none", confirmed: false }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "existing", confirmed: false }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "existing", confirmed: true }).canMutate, true);
  assert.equal(projectSetupPlan({ mode: "create_new", confirmed: true }).canMutate, true);
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-project-viewer.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../project-viewer.mjs`.

- [ ] **Step 3: Implement Project viewer definitions**

Create `skills/northstar/scripts/lib/project-viewer.mjs`:

```js
export const northstarProjectFields = [
  { name: "Northstar Lifecycle", type: "single_select", options: ["ready", "running", "verifying", "verified", "release_pending", "completed", "failed", "quarantined"] },
  { name: "Northstar Stage", type: "single_select", options: ["intake", "implementation", "verification", "release", "recovery"] },
  { name: "Northstar Role", type: "single_select", options: ["issue_worker", "pr_verifier", "release_worker"] },
  { name: "Northstar Host", type: "single_select", options: ["codex", "opencode"] },
  { name: "Northstar PR", type: "text" },
  { name: "Northstar Branch", type: "text" },
  { name: "Northstar Dependency", type: "single_select", options: ["unblocked", "blocked", "cycle", "missing", "completed"] },
  { name: "Northstar Attention", type: "single_select", options: ["none", "needs_operator", "retrying", "failed", "quarantined"] },
  { name: "Northstar Last Update", type: "date" },
  { name: "Northstar Retry Count", type: "number" },
  { name: "Northstar Auto Release", type: "single_select", options: ["enabled", "disabled", "issue_override"] },
];

export const northstarProjectViews = [
  { name: "Northstar Board", layout: "board", groupBy: "Northstar Lifecycle" },
  { name: "Active Runs", layout: "table", filter: "Northstar Lifecycle:ready,running,verifying,verified,release_pending" },
  { name: "Needs Attention", layout: "table", filter: "Northstar Attention:needs_operator,retrying,failed,quarantined" },
  { name: "Release Queue", layout: "table", filter: "Northstar Lifecycle:verified,release_pending" },
  { name: "Completed", layout: "table", filter: "Northstar Lifecycle:completed", sortBy: "Northstar Last Update desc" },
  { name: "Dependencies", layout: "table", groupBy: "Northstar Dependency" },
];

export function projectSetupPlan({ mode, confirmed }) {
  const wantsMutation = mode === "existing" || mode === "create_new";
  return {
    mode,
    canMutate: Boolean(wantsMutation && confirmed),
    skill_project_setup_requires_confirmation: 1,
    skill_project_fields_defined: northstarProjectFields.length,
    skill_project_views_defined: northstarProjectViews.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill defines project fields and views`.

- [ ] **Step 5: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/project-viewer.mjs tests/skills/northstar-project-viewer.test.ts tests/index.test.ts
git commit -m "feat: define northstar project viewer"
```

## Task 7: Operator Command Mapping

**Files:**
- Create: `skills/northstar/scripts/lib/operator-commands.mjs`
- Create: `tests/skills/northstar-operator-commands.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing operator command tests**

Create `tests/skills/northstar-operator-commands.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const commandsModule = "../../skills/northstar/scripts/lib/operator-commands.mjs";

test("northstar skill maps operator intents to explicit CLI argv arrays", async () => {
  const { commandPlanForIntent, supportedOperatorIntents } = await import(commandsModule);
  const config = "/repo/.northstar.yaml";

  assert.equal(supportedOperatorIntents.length >= 6, true);
  assert.deepEqual(commandPlanForIntent({ intent: "intake", issue: 123, configPath: config }).argv, ["node", "--run", "northstar", "--", "intake", "--config", config, "--issue", "123"]);
  assert.deepEqual(commandPlanForIntent({ intent: "start", issue: 123, configPath: config }).argv, ["node", "--run", "northstar", "--", "start", "--config", config, "--issue", "123"]);
  assert.deepEqual(commandPlanForIntent({ intent: "reconcile", issue: 123, configPath: config }).argv, ["node", "--run", "northstar", "--", "reconcile", "--config", config, "--issue", "123"]);
  assert.deepEqual(commandPlanForIntent({ intent: "release", issue: 123, configPath: config }).argv, ["node", "--run", "northstar", "--", "release", "--config", config, "--issue", "123"]);
  assert.deepEqual(commandPlanForIntent({ intent: "inspect", issue: 123, configPath: config }).argv, ["node", "--run", "northstar", "--", "inspect", "--config", config, "--issue", "123"]);
  assert.deepEqual(commandPlanForIntent({ intent: "watch", configPath: config, maxCycles: 1 }).argv, ["node", "--run", "northstar", "--", "watch", "--config", config, "--max-cycles", "1"]);
});

test("northstar skill operator command mapping rejects missing issue selectors", async () => {
  const { commandPlanForIntent } = await import(commandsModule);

  assert.throws(() => commandPlanForIntent({ intent: "inspect", configPath: ".northstar.yaml" }), /NORTHSTAR_SKILL_ISSUE_REQUIRED/);
  assert.throws(() => commandPlanForIntent({ intent: "unknown", configPath: ".northstar.yaml" }), /NORTHSTAR_SKILL_UNKNOWN_INTENT/);
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-operator-commands.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../operator-commands.mjs`.

- [ ] **Step 3: Implement operator command mapping**

Create `skills/northstar/scripts/lib/operator-commands.mjs`:

```js
export const supportedOperatorIntents = ["intake", "start", "reconcile", "release", "inspect", "watch"];

export function commandPlanForIntent(input) {
  if (!supportedOperatorIntents.includes(input.intent)) {
    throw new Error(`NORTHSTAR_SKILL_UNKNOWN_INTENT: ${input.intent}`);
  }
  const argv = ["node", "--run", "northstar", "--", input.intent, "--config", input.configPath];
  if (input.intent === "watch") {
    if (input.maxCycles !== undefined) argv.push("--max-cycles", String(input.maxCycles));
    if (input.logJson) argv.push("--log-json");
    return { argv, skill_operator_issue_commands_mapped: supportedOperatorIntents.length };
  }
  if (!Number.isInteger(input.issue)) {
    throw new Error(`NORTHSTAR_SKILL_ISSUE_REQUIRED: ${input.intent}`);
  }
  argv.push("--issue", String(input.issue));
  return { argv, skill_operator_issue_commands_mapped: supportedOperatorIntents.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill maps operator intents`.

- [ ] **Step 5: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/operator-commands.mjs tests/skills/northstar-operator-commands.test.ts tests/index.test.ts
git commit -m "feat: map northstar skill operator commands"
```

## Task 8: Recovery Diagnosis And Risk Gates

**Files:**
- Create: `skills/northstar/scripts/lib/recovery.mjs`
- Create: `tests/skills/northstar-recovery.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing recovery tests**

Create `tests/skills/northstar-recovery.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

const recoveryModule = "../../skills/northstar/scripts/lib/recovery.mjs";

test("northstar skill detects supported recovery scenarios", async () => {
  const { diagnoseRecovery, recoveryRiskForAction } = await import(recoveryModule);

  const cases = [
    diagnoseRecovery({ issue: 1, lifecycle: "quarantined", leaseExpired: true }),
    diagnoseRecovery({ issue: 2, lifecycle: "failed" }),
    diagnoseRecovery({ issue: 3, lifecycle: "running", projectionRetryable: true }),
    diagnoseRecovery({ issue: 4, lifecycle: "running", branchExists: true, prExists: false }),
    diagnoseRecovery({ issue: 5, lifecycle: "running", prExists: true, runtimeHasPr: false }),
    diagnoseRecovery({ issue: 6, lifecycle: "verified", autoRelease: true }),
  ];

  assert.equal(cases.filter((item) => item.detected).length, 6);
  assert.equal(cases[0].requiresConfirmation, true);
  assert.equal(cases[2].requiresConfirmation, false);
  assert.equal(recoveryRiskForAction("force_push").confirmation, "second_confirmation");
  assert.equal(recoveryRiskForAction("inspect").confirmation, "auto");
});

test("northstar skill recovery report includes issue state diagnosis and command plan", async () => {
  const { recoveryReport } = await import(recoveryModule);
  const report = recoveryReport({ issue: 123, lifecycle: "quarantined", leaseExpired: true });

  assert.match(report.text, /issue: #123/);
  assert.match(report.text, /state: quarantined/);
  assert.match(report.text, /diagnosis: expired lease/);
  assert.match(report.text, /requires_confirmation: yes/);
  assert.match(report.text, /northstar inspect --issue 123/);
});
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-recovery.test.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test
```

Expected: FAIL with `Cannot find module .../recovery.mjs`.

- [ ] **Step 3: Implement recovery diagnosis**

Create `skills/northstar/scripts/lib/recovery.mjs`:

```js
const riskPolicy = {
  inspect: { risk: "low", confirmation: "auto" },
  reconcile: { risk: "low", confirmation: "auto" },
  retry_projection_sync: { risk: "low", confirmation: "auto" },
  release_verified: { risk: "low", confirmation: "auto" },
  resume_quarantined: { risk: "medium", confirmation: "confirm" },
  start_long_running_watch: { risk: "medium", confirmation: "confirm" },
  write_config: { risk: "medium", confirmation: "confirm" },
  modify_project: { risk: "medium", confirmation: "confirm" },
  retry_failed_terminal: { risk: "high", confirmation: "second_confirmation" },
  force_push: { risk: "high", confirmation: "second_confirmation" },
  delete_worktree: { risk: "high", confirmation: "second_confirmation" },
  delete_branch: { risk: "high", confirmation: "second_confirmation" },
};

export function recoveryRiskForAction(action) {
  return riskPolicy[action] ?? { risk: "high", confirmation: "second_confirmation" };
}

export function diagnoseRecovery(input) {
  if (input.lifecycle === "quarantined" && input.leaseExpired) {
    return diagnosis(input, "expired lease", "resume_quarantined", true);
  }
  if (input.lifecycle === "failed") {
    return diagnosis(input, "terminal failed issue", "retry_failed_terminal", true);
  }
  if (input.projectionRetryable) {
    return diagnosis(input, "retryable projection failure", "retry_projection_sync", false);
  }
  if (input.branchExists && !input.prExists) {
    return diagnosis(input, "branch exists but PR is missing", "reconcile", false);
  }
  if (input.prExists && !input.runtimeHasPr) {
    return diagnosis(input, "PR exists but runtime lacks PR metadata", "reconcile", false);
  }
  if (input.lifecycle === "verified" && input.autoRelease) {
    return diagnosis(input, "verified issue awaiting auto release", "release_verified", false);
  }
  return {
    issue: input.issue,
    lifecycle: input.lifecycle,
    detected: false,
    diagnosis: "no supported recovery scenario detected",
    action: "inspect",
    requiresConfirmation: false,
  };
}

export function recoveryReport(input) {
  const item = diagnoseRecovery(input);
  const commandPlan = [
    `northstar inspect --issue ${input.issue}`,
    item.action === "release_verified"
      ? `northstar release --issue ${input.issue}`
      : item.action === "retry_projection_sync"
        ? `northstar reconcile --issue ${input.issue}`
        : `northstar start --issue ${input.issue}`,
  ];
  return {
    ...item,
    skill_recovery_scenarios_detected: item.detected ? 1 : 0,
    text: [
      `issue: #${input.issue}`,
      `state: ${input.lifecycle}`,
      `diagnosis: ${item.diagnosis}`,
      `safe_action: ${item.action}`,
      `requires_confirmation: ${item.requiresConfirmation ? "yes" : "no"}`,
      "command_plan:",
      ...commandPlan.map((command) => `  ${command}`),
    ].join("\n"),
  };
}

function diagnosis(input, message, action, requiresConfirmation) {
  return {
    issue: input.issue,
    lifecycle: input.lifecycle,
    detected: true,
    diagnosis: message,
    action,
    risk: recoveryRiskForAction(action).risk,
    requiresConfirmation,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill detects supported recovery scenarios`.

- [ ] **Step 5: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/recovery.mjs tests/skills/northstar-recovery.test.ts tests/index.test.ts
git commit -m "feat: add northstar skill recovery policy"
```

## Task 9: Cross-Platform Portability Gates

**Files:**
- Create: `tests/skills/northstar-portability.test.ts`
- Modify: `tests/index.test.ts`
- Modify: `skills/northstar/scripts/lib/platform.mjs` if tests reveal gaps.

- [ ] **Step 1: Write failing or strengthening portability tests**

Create `tests/skills/northstar-portability.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const platformLib = "../../skills/northstar/scripts/lib/platform.mjs";
const repoRoot = new URL("../..", import.meta.url).pathname;

test("northstar skill has linux macos and windows path fixture coverage", async () => {
  const { globalSkillDirForHome } = await import(platformLib);
  const fixtures = [
    ["linux", "/home/alice", "/home/alice/.codex/skills/northstar"],
    ["linux", "/home/alice/project with spaces", "/home/alice/project with spaces/.codex/skills/northstar"],
    ["darwin", "/Users/alice", "/Users/alice/.codex/skills/northstar"],
    ["darwin", "/Users/alice/Work Projects", "/Users/alice/Work Projects/.codex/skills/northstar"],
    ["win32", "C:\\Users\\Alice", "C:\\Users\\Alice\\.codex\\skills\\northstar"],
    ["win32", "C:\\Users\\Alice Smith", "C:\\Users\\Alice Smith\\.codex\\skills\\northstar"],
    ["win32", "\\\\server\\share\\Alice", "\\\\server\\share\\Alice\\.codex\\skills\\northstar"],
  ];

  for (const [platform, home, expected] of fixtures) {
    assert.equal(globalSkillDirForHome({ platform, home }), expected);
  }
});

test("northstar skill source avoids hardcoded unix-only production paths and shell scripts", async () => {
  const files = await listFiles(join(repoRoot, "skills/northstar"));
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");

  assert.doesNotMatch(combined, /\/home\/timmypai\/apps\/northstar/);
  assert.doesNotMatch(combined, /\/tmp\/northstar/);
  assert.doesNotMatch(combined, /\/bin\/sh/);
  assert.doesNotMatch(combined, /\.sh\b/);
});

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    if (entry.isFile()) result.push(path);
  }
  return result;
}
```

Add this import to `tests/index.test.ts`:

```ts
import "./skills/northstar-portability.test.ts";
```

- [ ] **Step 2: Run test to verify current behavior**

Run:

```bash
npm test
```

Expected: PASS if Task 2 implementation already supports all fixtures. If FAIL, failure must name the exact unsupported path fixture.

- [ ] **Step 3: Fix any path fixture gap**

If the UNC fixture fails, update `globalSkillDirForHome` in `skills/northstar/scripts/lib/platform.mjs` to use `path.win32.join` for `platform === "win32"`:

```js
export function globalSkillDirForHome({ platform = process.platform, home }) {
  const adapter = platform === "win32" ? path.win32 : path.posix;
  return adapter.join(home, ".codex", "skills", "northstar");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test
```

Expected: PASS for `northstar skill has linux macos and windows path fixture coverage`.

- [ ] **Step 5: Commit**

Run:

```bash
git add skills/northstar/scripts/lib/platform.mjs tests/skills/northstar-portability.test.ts tests/index.test.ts
git commit -m "test: add northstar skill portability gates"
```

## Task 10: Spec Compliance Matrix And Final Verification

**Files:**
- Create: `docs/superpowers/northstar-global-skill-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`
- Modify: `tests/coverage/requirement-coverage.test.ts` if the requirement coverage gate requires new matrix registration.

- [ ] **Step 1: Write the coverage matrix**

Create `docs/superpowers/northstar-global-skill-coverage.md`:

```markdown
# Northstar Global Skill Coverage

| Requirement | Test Files | Implementation Files |
| --- | --- | --- |
| Bootstrap config draft requires confirmation | `tests/skills/northstar-config-renderer.test.ts` | `skills/northstar/scripts/lib/config-renderer.mjs` |
| Global sync overwrites target | `tests/skills/northstar-sync.test.ts` | `skills/northstar/scripts/sync-global.mjs`, `skills/northstar/scripts/lib/platform.mjs` |
| Doctor reports platform, SQLite, git, gh, CLI, SDK | `tests/skills/northstar-doctor.test.ts` | `skills/northstar/scripts/lib/doctor.mjs`, `skills/northstar/scripts/doctor.mjs` |
| Project setup requires confirmation and defines fields/views | `tests/skills/northstar-project-viewer.test.ts` | `skills/northstar/scripts/lib/project-viewer.mjs` |
| Operator issue commands map to argv arrays | `tests/skills/northstar-operator-commands.test.ts` | `skills/northstar/scripts/lib/operator-commands.mjs` |
| Recovery scenarios and risk gates | `tests/skills/northstar-recovery.test.ts` | `skills/northstar/scripts/lib/recovery.mjs` |
| Linux/macOS/Windows path fixtures and no Unix-only hardcoding | `tests/skills/northstar-portability.test.ts` | `skills/northstar/scripts/lib/platform.mjs`, `skills/northstar/scripts/*.mjs` |
| Skill source instructions exist | `tests/skills/northstar-skill-files.test.ts` | `skills/northstar/SKILL.md`, `skills/northstar/README.md` |
```

- [ ] **Step 2: Add spec compliance test**

Append this test to `tests/spec/spec-compliance.test.ts`:

```ts
test("northstar global skill coverage matrix maps skill requirements", async () => {
  const content = await readFile("docs/superpowers/northstar-global-skill-coverage.md", "utf8");

  for (const requirement of [
    "Bootstrap config draft requires confirmation",
    "Global sync overwrites target",
    "Doctor reports platform, SQLite, git, gh, CLI, SDK",
    "Project setup requires confirmation and defines fields/views",
    "Operator issue commands map to argv arrays",
    "Recovery scenarios and risk gates",
    "Linux/macOS/Windows path fixtures and no Unix-only hardcoding",
  ]) {
    assert.match(content, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
```

- [ ] **Step 3: Run spec compliance test**

Run:

```bash
npm test
```

Expected: PASS for `northstar global skill coverage matrix maps skill requirements`.

- [ ] **Step 4: Run final verification gate**

Run:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:e2e:production-cli-watch
npm run test:coverage
npm run skill:doctor -- --json
npm run skill:render-config -- --cwd "$PWD" --github-repo owner/repo --json
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests skills
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src skills
rg "/home/timmypai/apps/northstar|/tmp/northstar|/bin/sh|\\.sh\\b" src skills
git status --short
```

Expected:

- Unit/offline/e2e/coverage tests pass.
- `skill:doctor` exits `0` unless `--require-ready` is explicitly supplied.
- `skill:render-config` prints a JSON draft and does not write `.northstar.yaml`.
- The first five `rg` scans print no matches.
- `git status --short` shows only intended changes before the final commit.

- [ ] **Step 5: Commit**

Run:

```bash
git add docs/superpowers/northstar-global-skill-coverage.md tests/spec/spec-compliance.test.ts tests/coverage/requirement-coverage.test.ts
git commit -m "test: cover northstar global skill requirements"
```

## Final Report Requirements

When execution completes, report:

- Skill source path.
- Global sync command and target behavior.
- Doctor summary metrics.
- Config bootstrap metrics.
- Project viewer fields/views metrics.
- Operator command mapping metrics.
- Recovery scenario metrics.
- Cross-platform portability metrics.
- Fresh verification output summary.
- Modified files summary.
- Deferred work: npm publish, Codex plugin packaging, OS service installation, full three-OS live CI matrix, content creation driver, office automation driver.

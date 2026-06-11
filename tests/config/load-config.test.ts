import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseYamlSubset, readBootstrapEnv } from "../../src/config/load-config.ts";
import { ALLOWED_BOOTSTRAP_ENV, validateRuntimeConfig } from "../../src/config/schema.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const fixturePath = join(repoRoot, "tests/fixtures/.northstar.yaml");
const srcRoot = join(repoRoot, "src");

test("loads and validates .northstar.yaml fixture", () => {
  const config = loadConfig(fixturePath);

  assert.equal(config.schemaVersion, "1.1");
  assert.equal(config.project.name, "vocab1");
  assert.equal(config.project.root, "/home/timmypai/apps/vocab1");
  assert.equal(config.runtime.dbPath, ".northstar/runtime/control-plane.sqlite3");
  assert.equal(config.runtime.hostAdapter, "opencode");
  assert.equal(config.runtime.developmentCapacity, 1);
  assert.equal(config.runtime.releaseCapacity, 1);
  assert.equal(config.runtime.heartbeatIntervalSeconds, 30);
  assert.equal(config.runtime.leaseTimeoutSeconds, 180);
  assert.equal(config.runtime.childTimeoutSeconds, 7200);
  assert.equal(config.runtime.watchLockStaleSeconds, 120);
  assert.equal(config.runtime.maxRecoveryAttempts, 2);
  assert.equal(config.runtime.autoRelease, false);
  assert.equal(config.runtime.sessionScope, "stage_root");
  assert.equal(config.workflow.package, "northstar/workflows/issue-to-pr-release");
  assert.equal(config.workflow.id, "issue_to_pr_release");
  assert.equal(config.workflow.version, "1.0");
  assert.equal(config.workflow.domain, "software_development");
  assert.equal(config.github.repo, "owner/name");
  assert.equal(config.github.intake.enabled, true);
  assert.equal(config.github.intake.label, "northstar:ready");
  assert.equal(config.github.sync.enabled, true);
  assert.deepEqual(config.github.sync.retryBackoffSeconds, [30, 120, 600]);
  assert.equal(config.github.project?.enabled, false);
  assert.equal(config.credentials?.github.tokenEnv, "GITHUB_TOKEN");
  assert.equal(config.credentials?.github.allowGhTokenFallback, true);
  assert.equal(config.credentials?.hostSdk.codex.mode, "sdk_default");
  assert.equal(config.credentials?.hostSdk.opencode.mode, "sdk_default");
  assert.equal(config.credentials?.hostSdk.pi.mode, "sdk_default");
  assert.equal(config.git.baseBranch, "main");
  assert.equal(config.git.worktreesDir, ".northstar/runtime/worktrees");
  assert.equal(config.git.syncWorktreeDir, ".northstar/runtime/sync-worktrees/main");
  assert.equal(config.cleanup.completedWorktrees, "archive");
  assert.equal(config.cleanup.keepLast, 5);
  assert.equal(config.cleanup.failedOrQuarantined, "keep");
  assert.equal(config.policy.githubSyncBlocksLifecycle, false);
  assert.equal(config.policy.quarantineRequiresOperator, true);
});

test("rejects unknown runtime host adapter", () => {
  assert.throws(
    () => validateRuntimeConfig({
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
        watch_lock_stale_seconds: 120,
        max_recovery_attempts: 2,
        auto_release: false,
        session_scope: "stage_root",
      },
      workflow: { package: "northstar/workflows/issue-to-pr-release", id: "issue_to_pr_release", version: "1.0", domain: "software_development" },
      github: {
        repo: "owner/name",
        intake: { enabled: true, label: "northstar:ready" },
        sync: { enabled: true, retry_backoff_seconds: [30] },
      },
      git: { base_branch: "main", worktrees_dir: ".northstar/runtime/worktrees", sync_worktree_dir: ".northstar/runtime/sync-worktrees/main" },
      cleanup: { completed_worktrees: "archive", keep_last: 5, failed_or_quarantined: "keep" },
      policy: { github_sync_blocks_lifecycle: false, quarantine_requires_operator: true },
      credentials: {
        github: { token_env: "GITHUB_TOKEN", allow_gh_token_fallback: true },
        host_sdk: { codex: { mode: "sdk_default" }, opencode: { mode: "sdk_default" } },
      },
    }),
    /runtime.host_adapter must be codex, opencode, or pi/,
  );
});

test("runtime config accepts pi host adapter and credentials", () => {
  const config = validateRuntimeConfig(baseConfig({
    runtime: {
      host_adapter: "pi",
    },
    credentials: {
      host_sdk: {
        pi: { mode: "sdk_default" },
      },
    },
  }));

  assert.equal(config.runtime.hostAdapter, "pi");
  assert.equal(config.credentials?.hostSdk.pi.mode, "sdk_default");
});

test("runtime config accepts watch lock recovery and cleanup policy", () => {
  const config = validateRuntimeConfig({
    schema_version: "1",
    project: { name: "demo", root: "/tmp/demo" },
    runtime: {
      db_path: ".northstar/runtime/northstar.sqlite",
      host_adapter: "codex",
      development_capacity: 2,
      release_capacity: 1,
      heartbeat_interval_seconds: 30,
      lease_timeout_seconds: 300,
      child_timeout_seconds: 900,
      watch_lock_stale_seconds: 120,
      max_recovery_attempts: 2,
      auto_release: true,
      session_scope: "stage_root",
    },
    workflow: { package: "builtin", id: "issue_to_pr_release", version: "1" },
    github: {
      repo: "owner/repo",
      intake: { enabled: true, label: "northstar:ready" },
      sync: { enabled: true, retry_backoff_seconds: [60, 300] },
    },
    git: {
      base_branch: "main",
      worktrees_dir: ".northstar/runtime/worktrees",
      sync_worktree_dir: ".northstar/runtime/sync-worktrees/main",
    },
    cleanup: {
      completed_worktrees: "archive",
      keep_last: 5,
      failed_or_quarantined: "keep",
    },
    policy: {
      github_sync_blocks_lifecycle: false,
      quarantine_requires_operator: true,
    },
  });

  assert.equal(config.runtime.watchLockStaleSeconds, 120);
  assert.equal(config.runtime.maxRecoveryAttempts, 2);
  assert.equal(config.cleanup.completedWorktrees, "archive");
  assert.equal(config.cleanup.keepLast, 5);
  assert.equal(config.cleanup.failedOrQuarantined, "keep");
});

test("cleanup policy rejects unsafe values", () => {
  assert.throws(() => validateRuntimeConfig(baseConfig({
    cleanup: { completed_worktrees: "wipe", keep_last: 5, failed_or_quarantined: "keep" },
  })), /cleanup.completed_worktrees must be archive, delete, or keep/);

  assert.throws(() => validateRuntimeConfig(baseConfig({
    cleanup: { completed_worktrees: "archive", keep_last: -1, failed_or_quarantined: "keep" },
  })), /cleanup.keep_last must be a non-negative integer/);

  assert.throws(() => validateRuntimeConfig(baseConfig({
    cleanup: { completed_worktrees: "archive", keep_last: 1.5, failed_or_quarantined: "keep" },
  })), /cleanup.keep_last must be a non-negative integer/);

  assert.throws(() => validateRuntimeConfig(baseConfig({
    cleanup: { completed_worktrees: "archive", keep_last: 5, failed_or_quarantined: "delete" },
  })), /cleanup.failed_or_quarantined must be keep, or archive/);
});

test("rejects missing required config fields with field names", () => {
  assert.throws(
    () => validateRuntimeConfig({}),
    /schema_version|project.name|runtime.db_path|workflow.id/,
  );
});

test("rejects unsupported runtime session scope", () => {
  assert.throws(
    () => validateRuntimeConfig({
      schema_version: "1.0",
      project: { name: "x", root: "/tmp/x" },
      runtime: {
        db_path: ".northstar/runtime/control-plane.sqlite3",
        host_adapter: "opencode",
        development_capacity: 1,
        release_capacity: 1,
        heartbeat_interval_seconds: 30,
        lease_timeout_seconds: 180,
        child_timeout_seconds: 7200,
        watch_lock_stale_seconds: 120,
        max_recovery_attempts: 2,
        auto_release: false,
        session_scope: "workflow_root",
      },
      workflow: { package: "northstar/workflows/issue-to-pr-release", id: "issue_to_pr_release", version: "1.0" },
      github: {
        repo: "owner/name",
        intake: { enabled: true, label: "northstar:ready" },
        sync: { enabled: true, retry_backoff_seconds: [30] },
      },
      git: { base_branch: "main", worktrees_dir: ".northstar/runtime/worktrees", sync_worktree_dir: ".northstar/runtime/sync-worktrees/main" },
      cleanup: { completed_worktrees: "archive", keep_last: 5, failed_or_quarantined: "keep" },
      policy: { github_sync_blocks_lifecycle: false, quarantine_requires_operator: true },
    }),
    /runtime.session_scope must be stage_root/,
  );
});

test("normalizes optional production config defaults", () => {
  const config = validateRuntimeConfig(baseConfig({
    workflow: { package: "northstar/workflows/issue-to-pr-release", id: "issue_to_pr_release", version: "1.0" },
    github: {
      repo: "owner/name",
      intake: { enabled: true, label: "northstar:ready" },
      sync: { enabled: true, retry_backoff_seconds: [30] },
    },
  }));

  assert.equal(config.workflow.domain, undefined);
  assert.equal(config.workflow.path, undefined);
  assert.equal(config.workflowOverrides, undefined);
  assert.equal(config.github.project, undefined);
  assert.equal(config.credentials?.github.tokenEnv, "GITHUB_TOKEN");
  assert.equal(config.credentials?.github.allowGhTokenFallback, false);
  assert.equal(config.credentials?.hostSdk.codex.mode, "sdk_default");
  assert.equal(config.credentials?.hostSdk.opencode.mode, "sdk_default");
  assert.equal(config.credentials?.hostSdk.pi.mode, "sdk_default");
});

test("normalizes github project fields and workflow overrides", () => {
  const config = validateRuntimeConfig(baseConfig({
    workflow: {
      package: "northstar/workflows/issue-to-pr-release",
      id: "issue_to_pr_release",
      version: "1.0",
      path: "./workflow.yaml",
      domain: "software_development",
    },
    workflow_overrides: { roles: { issue_worker: { model: "gpt-5" } } },
    github: {
      repo: "owner/name",
      intake: { enabled: true, label: "northstar:ready" },
      sync: { enabled: true, retry_backoff_seconds: [30] },
      project: {
        enabled: true,
        project_id: "PVT_kwDOAA",
        fields: { Lifecycle: "completed", PR: "https://example.test/pr/1" },
      },
    },
  }));

  assert.deepEqual(config.workflowOverrides, { roles: { issue_worker: { model: "gpt-5" } } });
  assert.deepEqual(config.github.project, {
    enabled: true,
    projectId: "PVT_kwDOAA",
    fields: { Lifecycle: "completed", PR: "https://example.test/pr/1" },
  });
});

test("rejects invalid production config optional sections", () => {
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ workflow_overrides: [] })),
    /workflow_overrides must be a mapping/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ workflow: { package: "pkg", id: "wf", version: "1", path: "" } })),
    /workflow.path must be a non-empty string/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ github: { repo: "owner/name", intake: { enabled: true, label: "northstar:ready" }, sync: { enabled: true, retry_backoff_seconds: ["30"] } } })),
    /github.sync.retry_backoff_seconds must be an array of numbers/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ github: { repo: "owner/name", intake: { enabled: true, label: "northstar:ready" }, sync: { enabled: true, retry_backoff_seconds: [30] }, project: "bad" } })),
    /github.project must be a mapping/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ github: { repo: "owner/name", intake: { enabled: true, label: "northstar:ready" }, sync: { enabled: true, retry_backoff_seconds: [30] }, project: { enabled: true, fields: { Lifecycle: 1 } } } })),
    /github.project.fields must be a string mapping/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ credentials: { github: { allow_gh_token_fallback: "yes" } } })),
    /credentials.github.allow_gh_token_fallback must be a boolean/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ credentials: { host_sdk: { codex: { mode: "cli" } } } })),
    /credentials.host_sdk.codex.mode must be sdk_default/,
  );
  assert.throws(
    () => validateRuntimeConfig(baseConfig({ credentials: { host_sdk: { pi: { mode: "cli" } } } })),
    /credentials.host_sdk.pi.mode must be sdk_default/,
  );
});

test("yaml subset parses list items with inline mapping prefixes", () => {
  const parsed = parseYamlSubset(`
workflow:
  exception_policy:
    rules:
      - name: verification_retryable_returns_to_implementation
        match:
          source_stage: verification
          artifact_kind: verification_result
          status: failed_retryable
        action:
          type: return_to_stage
          target_stage: implementation
          carry_forward:
            - feedback_for_implementation
        on_exhausted:
          type: quarantine
    default:
      action:
        type: quarantine
`);

  assert.deepEqual(parsed, {
    workflow: {
      exception_policy: {
        rules: [
          {
            name: "verification_retryable_returns_to_implementation",
            match: {
              source_stage: "verification",
              artifact_kind: "verification_result",
              status: "failed_retryable",
            },
            action: {
              type: "return_to_stage",
              target_stage: "implementation",
              carry_forward: ["feedback_for_implementation"],
            },
            on_exhausted: { type: "quarantine" },
          },
        ],
        default: { action: { type: "quarantine" } },
      },
    },
  });
});

test("reads only bootstrap environment overrides", () => {
  const env = readBootstrapEnv({
    NORTHSTAR_CONFIG: "/tmp/.northstar.yaml",
    NORTHSTAR_PROJECT_ROOT: "/tmp/project",
    NORTHSTAR_DEBUG: "1",
    HOME: "/home/example",
    SECRET_TOKEN: "do-not-read",
  });

  assert.deepEqual(Object.keys(env).sort(), [...ALLOWED_BOOTSTRAP_ENV].sort());
  assert.equal(env.NORTHSTAR_CONFIG, "/tmp/.northstar.yaml");
});

test("runtime source only reads bootstrap env vars directly", async () => {
  const violations = await findProcessEnvViolations(srcRoot);

  assert.deepEqual(violations, []);
});

async function findProcessEnvViolations(root: string): Promise<string[]> {
  const files = await listSourceFiles(root);
  const violations: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const matches = content.matchAll(/process\.env\.([A-Z0-9_]+)/g);
    for (const match of matches) {
      if (!ALLOWED_BOOTSTRAP_ENV.includes(match[1])) {
        violations.push(`${file}:${match[1]}`);
      }
    }
  }

  return violations;
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return deepMerge({
    schema_version: "1.1",
    project: { name: "x", root: "/tmp/x" },
    runtime: {
      db_path: ".northstar/runtime/control-plane.sqlite3",
      host_adapter: "opencode",
      development_capacity: 1,
      release_capacity: 1,
      heartbeat_interval_seconds: 30,
      lease_timeout_seconds: 180,
      child_timeout_seconds: 7200,
      watch_lock_stale_seconds: 120,
      max_recovery_attempts: 2,
      auto_release: false,
      session_scope: "stage_root",
    },
    workflow: { package: "northstar/workflows/issue-to-pr-release", id: "issue_to_pr_release", version: "1.0" },
    github: {
      repo: "owner/name",
      intake: { enabled: true, label: "northstar:ready" },
      sync: { enabled: true, retry_backoff_seconds: [30] },
    },
    git: { base_branch: "main", worktrees_dir: ".northstar/runtime/worktrees", sync_worktree_dir: ".northstar/runtime/sync-worktrees/main" },
    cleanup: { completed_worktrees: "archive", keep_last: 5, failed_or_quarantined: "keep" },
    policy: { github_sync_blocks_lifecycle: false, quarantine_requires_operator: true },
  }, overrides);
}

function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = output[key];
    output[key] = isPlainRecord(baseValue) && isPlainRecord(value)
      ? deepMerge(baseValue, value)
      : value;
  }
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

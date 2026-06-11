import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const doctorLib = "../../skills/northstar/scripts/lib/doctor.mjs";
const doctorWrapper = resolve("skills/northstar/scripts/doctor.mjs");
const execFileAsync = promisify(execFile);

type CommandSpec = { command: string; args?: string[] };
const validConsumerConfig = [
  'schema_version: "1.1"',
  "project:",
  "  name: consumer",
  "  root: /consumer",
  "runtime:",
  "  db_path: .northstar/runtime/control-plane.sqlite3",
  "  host_adapter: codex",
  "  development_capacity: 1",
  "  release_capacity: 1",
  "  heartbeat_interval_seconds: 30",
  "  lease_timeout_seconds: 600",
  "  child_timeout_seconds: 7200",
  "  watch_lock_stale_seconds: 120",
  "  max_recovery_attempts: 2",
  "  auto_release: true",
  "  session_scope: stage_root",
  "workflow:",
  "  package: builtin",
  "  id: issue_to_pr_release",
  '  version: "1.0"',
  "github:",
  "  repo: owner/repo",
  "  intake:",
  "    enabled: true",
  "    label: northstar:ready",
  "  sync:",
  "    enabled: true",
  "    retry_backoff_seconds:",
  "      - 30",
  "  project:",
  "    enabled: false",
  "git:",
  "  base_branch: main",
  "  worktrees_dir: .northstar/runtime/worktrees",
  "  sync_worktree_dir: .northstar/runtime/sync-worktrees/main",
  "cleanup:",
  "  completed_worktrees: archive",
  "  keep_last: 5",
  "  failed_or_quarantined: keep",
  "policy:",
  "  github_sync_blocks_lifecycle: false",
  "  quarantine_requires_operator: true",
].join("\n");

const projectConsumerConfig = validConsumerConfig.replace(
  "  project:\n    enabled: false",
  "  project:\n    enabled: true\n    project_id: PROJECT_NODE_ID",
);

const consumerConfigMissingHardeningFields = [
  'schema_version: "1.1"',
  "project:",
  "  name: consumer",
  "  root: /consumer",
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
  "workflow:",
  "  package: builtin",
  "  id: issue_to_pr_release",
  '  version: "1.0"',
  "github:",
  "  repo: owner/repo",
  "  intake:",
  "    enabled: true",
  "    label: northstar:ready",
  "  sync:",
  "    enabled: true",
  "    retry_backoff_seconds:",
  "      - 30",
  "git:",
  "  base_branch: main",
  "  worktrees_dir: .northstar/runtime/worktrees",
  "  sync_worktree_dir: .northstar/runtime/sync-worktrees/main",
  "policy:",
  "  github_sync_blocks_lifecycle: false",
  "  quarantine_requires_operator: true",
].join("\n");

function byId(result: { checks: Array<{ id: string }> }, id: string) {
  const check = result.checks.find((item) => item.id === id);
  assert.ok(check, `missing check ${id}`);
  return check;
}

test("northstar skill doctor reports platform, node sqlite, git, gh, northstar CLI, and sdk checks", async () => {
  const { runDoctor } = await import(doctorLib);
  const commands: Array<{ spec: CommandSpec; cwd?: string }> = [];

  const result = await runDoctor({
    cwd: "/repo",
    env: { GITHUB_TOKEN: "ghp_secret-token" },
    platform: "linux",
    arch: "x64",
    nodeVersion: "v24.0.0",
    importModule: async (specifier: string) => {
      assert.ok(["node:sqlite", "@openai/codex-sdk", "@earendil-works/pi-coding-agent"].includes(specifier));
      return {};
    },
    fileExists: async (path: string) => path === "/repo/package.json",
    runCommand: async (spec: CommandSpec, options: { cwd?: string } = {}) => {
      commands.push({ spec, cwd: options.cwd });
      return { exitCode: 0, stdout: `${spec.command} ok`, stderr: "" };
    },
  });

  assert.deepEqual(
    result.checks.map((check: { id: string }) => check.id),
    [
      "platform",
      "node_sqlite",
      "git",
      "gh",
      "github_credential",
      "northstar_root",
      "northstar_cli",
      "sdk",
      "config",
      "github_repo_access",
      "github_labels",
      "github_project",
    ],
  );
  assert.equal(byId(result, "platform").status, "ok");
  assert.equal(byId(result, "node_sqlite").status, "ok");
  assert.equal(byId(result, "git").status, "ok");
  assert.equal(byId(result, "gh").status, "ok");
  assert.equal(byId(result, "northstar_cli").status, "ok");
  assert.equal(byId(result, "sdk").status, "ok");
  assert.deepEqual(commands.map(({ spec }) => [spec.command, spec.args]), [
    ["git", ["--version"]],
    ["gh", ["--version"]],
    ["node", ["--run", "northstar", "--", "--help"]],
  ]);
  assert.equal(commands[2].cwd, "/repo");
  assert.deepEqual(result.metrics, {
    skill_doctor_platform_reported: 1,
    skill_doctor_node_sqlite_checked: 1,
    skill_doctor_git_gh_checked: 1,
    skill_doctor_northstar_cli_checked: 1,
    skill_doctor_sdk_checked: 1,
  });
});

test("northstar skill doctor accepts gh auth token fallback and checks consumer config", async () => {
  const { runDoctor } = await import(doctorLib);
  const commands: Array<{ spec: CommandSpec; cwd?: string }> = [];

  const result = await runDoctor({
    cwd: "/consumer",
    env: { NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
    readFile: async (path: string) => {
      assert.equal(path, "/consumer/.northstar.yaml");
      return validConsumerConfig;
    },
    runCommand: async (spec: CommandSpec, options: { cwd?: string } = {}) => {
      commands.push({ spec, cwd: options.cwd });
      if (spec.command === "gh" && spec.args?.join(" ") === "auth token") {
        return { exitCode: 0, stdout: "gho_secret-fallback-token\n", stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.[0] === "repo") {
        return { exitCode: 0, stdout: '{"nameWithOwner":"owner/repo"}', stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.[0] === "label") {
        return { exitCode: 0, stdout: '[{"name":"northstar:ready"},{"name":"northstar:blocked"},{"name":"northstar:quarantined"}]', stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  assert.equal(byId(result, "github_credential").status, "ok");
  assert.match(byId(result, "github_credential").message, /gh auth token fallback/);
  assert.equal(byId(result, "config").status, "ok");
  assert.equal(byId(result, "github_repo_access").status, "ok");
  assert.equal(byId(result, "github_labels").status, "ok");
  assert.equal(byId(result, "github_project").status, "skipped");
  assert.equal(result.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /gho_secret-fallback-token/);
  assert.ok(commands.some(({ spec }) => spec.command === "gh" && spec.args?.join(" ") === "auth token"));
});

test("northstar skill doctor requires all managed GitHub labels", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    cwd: "/consumer",
    env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
    readFile: async () => validConsumerConfig,
    runCommand: async (spec: CommandSpec) => {
      if (spec.command === "gh" && spec.args?.[0] === "repo") {
        return { exitCode: 0, stdout: '{"nameWithOwner":"owner/repo"}', stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.[0] === "label") {
        return { exitCode: 0, stdout: '[{"name":"northstar:ready"}]', stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  const labels = byId(result, "github_labels") as {
    status: string;
    code?: string;
    requiredLabels?: string[];
    missingLabels?: string[];
  };
  assert.equal(labels.status, "missing");
  assert.equal(labels.code, "NORTHSTAR_GITHUB_LABELS_MISSING");
  assert.deepEqual(labels.requiredLabels, ["northstar:ready", "northstar:blocked", "northstar:quarantined"]);
  assert.deepEqual(labels.missingLabels, ["northstar:blocked", "northstar:quarantined"]);
  assert.equal(result.ready, false);
});

test("northstar skill doctor reports missing consumer config as not ready", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    cwd: "/consumer",
    env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json",
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });

  assert.equal(byId(result, "config").status, "missing");
  assert.equal(byId(result, "config").code, "NORTHSTAR_CONFIG_MISSING");
  assert.equal(byId(result, "github_repo_access").status, "skipped");
  assert.equal(result.ready, false);
});

test("northstar skill doctor rejects incomplete consumer config as invalid", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    cwd: "/consumer",
    env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
    readFile: async () => [
      'schema_version: "1.1"',
      "github:",
      "  repo: owner/repo",
    ].join("\n"),
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });

  assert.equal(byId(result, "config").status, "invalid");
  assert.equal(byId(result, "config").code, "NORTHSTAR_CONFIG_INVALID");
  assert.match(byId(result, "config").message, /Missing required config fields/);
  assert.equal(byId(result, "github_repo_access").status, "skipped");
  assert.equal(result.ready, false);
});

test("northstar skill doctor requires runtime hardening and cleanup policy config", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    cwd: "/consumer",
    env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
    readFile: async () => consumerConfigMissingHardeningFields,
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });

  assert.equal(byId(result, "config").status, "invalid");
  assert.match(byId(result, "config").message, /runtime.watch_lock_stale_seconds/);
  assert.match(byId(result, "config").message, /runtime.max_recovery_attempts/);
  assert.match(byId(result, "config").message, /cleanup.completed_worktrees/);
  assert.match(byId(result, "config").message, /cleanup.keep_last/);
  assert.match(byId(result, "config").message, /cleanup.failed_or_quarantined/);
  assert.equal(result.ready, false);
});

test("northstar skill doctor rejects invalid cleanup policy values", async () => {
  const { runDoctor } = await import(doctorLib);

  for (const [config, message] of [
    [
      validConsumerConfig.replace("  completed_worktrees: archive", "  completed_worktrees: wipe"),
      /cleanup.completed_worktrees must be archive, delete, or keep/,
    ],
    [
      validConsumerConfig.replace("  keep_last: 5", "  keep_last: 1.5"),
      /cleanup.keep_last must be a non-negative integer/,
    ],
    [
      validConsumerConfig.replace("  failed_or_quarantined: keep", "  failed_or_quarantined: delete"),
      /cleanup.failed_or_quarantined must be keep, or archive/,
    ],
  ] as const) {
    const result = await runDoctor({
      cwd: "/consumer",
      env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
      importModule: async () => ({}),
      fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
      readFile: async () => config,
      runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });

    assert.equal(byId(result, "config").status, "invalid");
    assert.match(byId(result, "config").message, message);
    assert.equal(result.ready, false);
  }
});

test("northstar skill doctor rejects invalid runtime hardening values", async () => {
  const { runDoctor } = await import(doctorLib);

  for (const [config, message] of [
    [
      validConsumerConfig.replace("  watch_lock_stale_seconds: 120", "  watch_lock_stale_seconds: -1"),
      /runtime.watch_lock_stale_seconds must be a non-negative integer/,
    ],
    [
      validConsumerConfig.replace("  max_recovery_attempts: 2", "  max_recovery_attempts: 1.5"),
      /runtime.max_recovery_attempts must be a non-negative integer/,
    ],
  ] as const) {
    const result = await runDoctor({
      cwd: "/consumer",
      env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
      importModule: async () => ({}),
      fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
      readFile: async () => config,
      runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });

    assert.equal(byId(result, "config").status, "invalid");
    assert.match(byId(result, "config").message, message);
    assert.equal(result.ready, false);
  }
});

test("northstar skill doctor verifies configured GitHub Project access", async () => {
  const { runDoctor } = await import(doctorLib);
  const commands: Array<CommandSpec> = [];

  const result = await runDoctor({
    cwd: "/consumer",
    env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
    readFile: async () => projectConsumerConfig,
    runCommand: async (spec: CommandSpec) => {
      commands.push(spec);
      if (spec.command === "gh" && spec.args?.[0] === "repo") {
        return { exitCode: 0, stdout: '{"nameWithOwner":"owner/repo"}', stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.[0] === "label") {
        return { exitCode: 0, stdout: '[{"name":"northstar:ready"},{"name":"northstar:blocked"},{"name":"northstar:quarantined"}]', stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.join(" ").includes("PROJECT_NODE_ID")) {
        return { exitCode: 0, stdout: '{"data":{"node":{"id":"PROJECT_NODE_ID","title":"Northstar"}}}', stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  assert.equal(byId(result, "github_project").status, "ok");
  assert.ok(commands.some((spec) => spec.command === "gh" && spec.args?.[0] === "api" && spec.args?.includes("graphql")));
  assert.equal(result.ready, true);
});

test("northstar skill doctor rejects GitHub Project GraphQL responses without a project node", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    cwd: "/consumer",
    env: { GITHUB_TOKEN: "ghp_secret-token", NORTHSTAR_ROOT: "/northstar" },
    importModule: async () => ({}),
    fileExists: async (path: string) => path === "/northstar/package.json" || path === "/consumer/.northstar.yaml",
    readFile: async () => projectConsumerConfig,
    runCommand: async (spec: CommandSpec) => {
      if (spec.command === "gh" && spec.args?.[0] === "repo") {
        return { exitCode: 0, stdout: '{"nameWithOwner":"owner/repo"}', stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.[0] === "label") {
        return { exitCode: 0, stdout: '[{"name":"northstar:ready"},{"name":"northstar:blocked"},{"name":"northstar:quarantined"}]', stderr: "" };
      }
      if (spec.command === "gh" && spec.args?.[0] === "api") {
        return { exitCode: 0, stdout: '{"data":{"node":null}}', stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  assert.equal(byId(result, "github_project").status, "missing");
  assert.equal(byId(result, "github_project").code, "NORTHSTAR_GITHUB_PROJECT_ACCESS_MISSING");
  assert.equal(result.ready, false);
});

test("northstar skill doctor checks github credential ok when GITHUB_TOKEN is present", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    env: { GITHUB_TOKEN: "github_pat_secret-value" },
    importModule: async () => ({}),
    fileExists: async () => false,
    runCommand: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });

  const credential = byId(result, "github_credential");
  assert.equal(credential.status, "ok");
  assert.match(credential.message, /GITHUB_TOKEN is set/);
  assert.doesNotMatch(JSON.stringify(result), /github_pat_secret-value/);
});

test("northstar skill doctor redacts secrets and reports missing GitHub credential when absent", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    env: { NORTHSTAR_ROOT: "/repo" },
    importModule: async (specifier: string) => {
      if (specifier === "node:sqlite") {
        throw new Error("sqlite unavailable sk-secret");
      }
      throw new Error("sdk unavailable github_pat_secret");
    },
    fileExists: async () => true,
    runCommand: async (spec: CommandSpec) => ({
      exitCode: 1,
      stdout: "",
      stderr: `${spec.command} failed ghp_secret gho_secret ghu_secret ghs_secret github_pat_secret sk-secret`,
    }),
  });

  assert.equal(byId(result, "github_credential").status, "missing");
  assert.equal(byId(result, "github_credential").code, "NORTHSTAR_GITHUB_CREDENTIAL_MISSING");
  assert.match(byId(result, "github_credential").message, /GitHub credential unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /ghp_secret|gho_secret|ghu_secret|ghs_secret|github_pat_secret|sk-secret/);
  assert.match(JSON.stringify(result), /\[REDACTED\]/);
});

test("northstar skill doctor redacts known sensitive env values even when not token-shaped", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    env: { GITHUB_TOKEN: "LEAK", NORTHSTAR_ROOT: "/repo/LEAK" },
    importModule: async (specifier: string) => {
      throw new Error(`${specifier} echoed LEAK`);
    },
    fileExists: async () => true,
    runCommand: async (spec: CommandSpec) => ({
      exitCode: 1,
      stdout: "",
      stderr: `${spec.command} echoed LEAK`,
    }),
  });

  assert.doesNotMatch(JSON.stringify(result), /LEAK/);
  assert.match(JSON.stringify(result), /\[REDACTED\]/);
  assert.equal(byId(result, "northstar_root").northstarRoot, "/repo/[REDACTED]");
});

test("northstar skill doctor treats blank GitHub token as missing", async () => {
  const { runDoctor } = await import(doctorLib);

  const result = await runDoctor({
    env: { GITHUB_TOKEN: "   " },
    importModule: async () => ({}),
    fileExists: async () => false,
    runCommand: async (spec: CommandSpec) => {
      if (spec.command === "gh" && spec.args?.join(" ") === "auth token") {
        return { exitCode: 1, stdout: "", stderr: "not logged in" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  const credential = byId(result, "github_credential");
  assert.equal(credential.status, "missing");
  assert.equal(credential.code, "NORTHSTAR_GITHUB_CREDENTIAL_MISSING");
});

test("northstar skill doctor wrapper accepts --json and exits zero without require-ready", async () => {
  const { parseDoctorArgs } = await import("../../skills/northstar/scripts/doctor.mjs");
  const { runDoctor } = await import(doctorLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-doctor-json-"));

  try {
    assert.deepEqual(parseDoctorArgs(["--json"]), { configPath: undefined, requireReady: false });
    const result = await runDoctor({ env: isolatedDoctorEnv(dir), cwd: dir });
    assert.equal(typeof result.ready, "boolean");
    assert.ok(Array.isArray(result.checks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar skill doctor wrapper accepts explicit config path", async () => {
  const { parseDoctorArgs } = await import("../../skills/northstar/scripts/doctor.mjs");

  assert.deepEqual(parseDoctorArgs(["--config", "/consumer/.northstar.yaml", "--require-ready"]), {
    configPath: "/consumer/.northstar.yaml",
    requireReady: true,
  });
});

test("northstar skill doctor wrapper exits nonzero for unknown arguments", async () => {
  const { parseDoctorArgs } = await import("../../skills/northstar/scripts/doctor.mjs");

  assert.throws(() => parseDoctorArgs(["--wat"]), /Unknown argument: --wat/);
});

test("northstar skill doctor wrapper redacts token-shaped unknown arguments", async () => {
  const { parseDoctorArgs } = await import("../../skills/northstar/scripts/doctor.mjs");
  const { redactSecrets } = await import(doctorLib);

  assert.throws(() => parseDoctorArgs(["ghp_secretToken123"]), /Unknown argument: ghp_secretToken123/);
  assert.equal(redactSecrets("Unknown argument: ghp_secretToken123"), "Unknown argument: [REDACTED]");
});

test("northstar skill doctor wrapper exits nonzero with --require-ready when checks include errors", async () => {
  const { parseDoctorArgs } = await import("../../skills/northstar/scripts/doctor.mjs");
  const { runDoctor } = await import(doctorLib);
  const dir = await mkdtemp(join(tmpdir(), "northstar-doctor-require-ready-"));

  try {
    const parsed = parseDoctorArgs(["--require-ready"]);
    const result = await runDoctor({ env: isolatedDoctorEnv(dir), cwd: dir });
    assert.equal(parsed.requireReady, true);
    assert.equal(result.ready, false);
    assert.ok(result.checks.some((check: { status: string }) => check.status !== "ok"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function isolatedDoctorEnv(northstarRoot: string): NodeJS.ProcessEnv {
  return {
    HOME: northstarRoot,
    NORTHSTAR_ROOT: northstarRoot,
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpdir(),
    USERPROFILE: northstarRoot,
  };
}

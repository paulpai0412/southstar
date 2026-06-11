import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import { loadConfig } from "../../src/config/load-config.ts";
import {
  createProductionDependencies,
  resolveProductionStorePath,
} from "../../src/orchestrator/production-dependencies.ts";
import type { RuntimeConfig } from "../../src/config/schema.ts";
import type { SoftwareDevWorker } from "../../src/orchestrator/software-dev-driver.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

test("default production factory creates real dependency composition", async () => {
  const created = await createProductionDependencies({
    config: fixtureConfig({
      projectRoot: "/repo",
      repo: "owner/repo",
      hostAdapter: "codex",
    }),
    usage: "cli",
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async () => jsonResponse([]),
    sdkWorkers: {
      codex: () => fakeWorker("codex"),
      opencode: () => fakeWorker("opencode"),
      pi: () => fakeWorker("pi"),
    },
  });

  assert.equal(created.metrics.production_cli_real_dependency_factory, 1);
  assert.equal(created.metrics.production_default_unconfigured_dependencies, 0);
  assert.ok(created.host);
  assert.ok(created.registry);
  assert.ok(created.issueIntake);
});

test("production factory writes runtime state under consumer root", () => {
  const result = resolveProductionStorePath({
    projectRoot: "/consumer",
    dbPath: ".northstar/runtime/control-plane.sqlite3",
  });

  assert.equal(result, resolve("/consumer/.northstar/runtime/control-plane.sqlite3"));
});

test("production factory configures SDK worker timeouts from runtime child timeout", async () => {
  const config = fixtureConfig({
    projectRoot: "/repo",
    repo: "owner/repo",
    hostAdapter: "codex",
  });
  config.runtime.childTimeoutSeconds = 1234;
  const created = await createProductionDependencies({
    config,
    usage: "watch",
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async () => jsonResponse([]),
  });

  const driver = created.registry.resolve({
    workflow: loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml"),
    config,
    dependencies: {},
  }) as unknown as {
    worker: { factory: { input: { codexWorker: () => unknown; opencodeWorker: () => unknown } } };
  };
  const codex = driver.worker.factory.input.codexWorker() as { implementationTimeoutMs: number; verificationTimeoutMs: number };
  const opencode = driver.worker.factory.input.opencodeWorker() as { implementationTimeoutMs: number; verificationTimeoutMs: number };

  assert.equal(codex.implementationTimeoutMs, 1_234_000);
  assert.equal(codex.verificationTimeoutMs, 1_234_000);
  assert.equal(opencode.implementationTimeoutMs, 1_234_000);
  assert.equal(opencode.verificationTimeoutMs, 1_234_000);
});

test("production factory wires pi worker symmetrically with codex and opencode", async () => {
  const config = fixtureConfig({
    projectRoot: "/repo",
    repo: "owner/repo",
    hostAdapter: "pi",
  });
  const created = await createProductionDependencies({
    config,
    usage: "watch",
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    fetch: async () => jsonResponse([]),
    sdkWorkers: {
      codex: () => fakeWorker("codex"),
      opencode: () => fakeWorker("opencode"),
      pi: () => fakeWorker("pi"),
    },
  });

  const driver = created.registry.resolve({
    workflow: loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml"),
    config,
    dependencies: {},
  }) as unknown as {
    worker: { factory: { resolveHostForRole(roleName: string): string; workerForRole(roleName: string): { kind: string } } };
  };

  assert.equal(driver.worker.factory.resolveHostForRole("implementation_agent"), "pi");
  assert.equal(driver.worker.factory.workerForRole("implementation_agent").kind, "pi");
});

test("software development production path does not wire git delivery into domain driver", async () => {
  const config = fixtureConfig({ projectRoot: "/repo", repo: "owner/repo", hostAdapter: "codex" });
  const created = await createProductionDependencies({
    config,
    usage: "watch",
    env: { GITHUB_TOKEN: "ghp_token" },
    runCommand: async (command) => {
      throw new Error(`git delivery command must not run: ${command.command} ${command.args.join(" ")}`);
    },
    fetch: async () => jsonResponse([]),
    sdkWorkers: { codex: () => agentOwnedFakeWorker("codex") },
  });

  const driver = created.registry.resolve({
    workflow: loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml"),
    config,
    dependencies: {},
  }) as unknown as { worktree?: unknown };
  assert.equal(driver.worktree, undefined);
});

function fixtureConfig(input: {
  projectRoot: string;
  repo: string;
  hostAdapter: "codex" | "opencode" | "pi";
}): RuntimeConfig {
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  return {
    ...config,
    project: { ...config.project, root: input.projectRoot },
    runtime: { ...config.runtime, hostAdapter: input.hostAdapter },
    github: { ...config.github, repo: input.repo },
  };
}

function fakeWorker(kind: "codex" | "opencode" | "pi"): SoftwareDevWorker & { kind: "codex" | "opencode" | "pi" } {
  return {
    kind,
    async runImplementation() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
    async runVerification() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
    async runRelease() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: "ok", shell_fallbacks: 0 };
    },
  };
}

function agentOwnedFakeWorker(kind: "codex" | "opencode" | "pi"): SoftwareDevWorker & { kind: "codex" | "opencode" | "pi" } {
  const implementationResponse = JSON.stringify({
    schema_version: "1.0",
    artifact_kind: "implementation_result",
    status: "ready_for_verification",
    retryable: false,
    issue_number: 1,
    role: "implementation_agent",
    observed_at: "2026-06-03T00:00:00.000Z",
    summary: "implementation complete",
    pr: { url: "https://github.test/pull/1", number: 1, head_ref: "northstar/1", head_sha: "head-sha-1" },
    changed_files: ["src/index.ts"],
    commands_run: [{ command: "npm test", status: "passed" }],
    self_check_summary: "ok",
    evidence: [{ type: "test", value: "npm test" }],
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-1",
      base_source: "origin/main",
      base_commit: "base-sha-1",
      expected_branch: "northstar/1",
      observed_branch: "northstar/1",
      expected_head_sha: "head-sha-1",
      observed_head_sha: "head-sha-1",
      matches_expected: true,
    },
  });
  const verificationResponse = JSON.stringify({
    schema_version: "1.0",
    artifact_kind: "verification_result",
    status: "pass",
    retryable: false,
    issue_number: 1,
    role: "verifier_agent",
    observed_at: "2026-06-03T00:00:00.000Z",
    summary: "verification passed",
    review: { requirements_passed: true, code_review_passed: true },
    functional_review: { required: false, status: "pass" },
    browser_evidence: { required: false, ran: false },
    workspace_evidence: {
      path_checked: ".northstar/runtime/worktrees/issue-1",
      expected_branch: "northstar/1",
      observed_branch: "northstar/1",
      expected_head_sha: "head-sha-1",
      observed_head_sha: "head-sha-1",
      matches_expected: true,
    },
    release_recommendation: "ready_for_release",
  });
  const releaseResponse = JSON.stringify({
    schema_version: "1.0",
    artifact_kind: "release_result",
    status: "completed",
    retryable: false,
    issue_number: 1,
    role: "release_agent",
    observed_at: "2026-06-03T00:00:00.000Z",
    summary: "release completed",
    release: {
      confirmed: true,
      merge_commit: "merge-sha-1",
      local_sync: {
        base_branch: "main",
        synced: true,
        local_head: "merge-sha-1",
        remote_head: "merge-sha-1",
        matches_remote: true,
      },
      repo_root_sync: {
        status: "skipped",
        reason: "repo_root_dirty",
      },
      worktree_cleanup: {
        path: ".northstar/runtime/worktrees/issue-1-production",
        removed: true,
      },
    },
    issue_update: { comment_summary: "Released", close_issue: true, labels_to_add: ["northstar:released"], labels_to_remove: ["northstar:ready"] },
    evidence: [
      { type: "merge_commit", value: "merge-sha-1" },
      { type: "local_remote_sync", value: "main at merge-sha-1" },
      { type: "worktree_cleanup", value: "removed .northstar/runtime/worktrees/issue-1-production" },
    ],
  });
  return {
    kind,
    async runImplementation() {
      return { root_session_id: `${kind}-root`, child_run_id: `${kind}-child`, final_response: implementationResponse, shell_fallbacks: 0 };
    },
    async runVerification() {
      return { root_session_id: `${kind}-root-v`, child_run_id: `${kind}-child-v`, final_response: verificationResponse, shell_fallbacks: 0 };
    },
    async runRelease() {
      return { root_session_id: `${kind}-root-r`, child_run_id: `${kind}-child-r`, final_response: releaseResponse, shell_fallbacks: 0 };
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

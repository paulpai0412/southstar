import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandSpec, containsShellChain } from "../../src/adapters/platform/process.ts";
import { normalizeRuntimePath } from "../../src/adapters/platform/paths.ts";
import { planMainSync, planWorktreeCleanup } from "../../src/adapters/git/worktrees.ts";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { OpenCodeHostAdapter } from "../../src/adapters/host/opencode.ts";
import { CodexHostAdapter } from "../../src/adapters/host/codex.ts";
import {
  codexLoader,
  codexSdkPackageName,
  openCodeLoader,
  opencodeSdkPackageName,
  piLoader,
  piSdkPackageName,
} from "../../src/adapters/host/sdk-loaders.ts";
import { GitHubRemoteProjectionAdapter } from "../../src/adapters/github/remote.ts";
import { projectionFailureEvent } from "../../src/adapters/github/projector.ts";
import { loadConfig } from "../../src/config/load-config.ts";
import { loadWorkflow, resolveWorkflowRoles } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");

test("external commands are argv arrays and reject shell chains", () => {
  assert.equal(containsShellChain("status && git pull"), true);
  assert.throws(() => commandSpec("git", ["status && git pull"]), /shell-chain/);
  assert.deepEqual(commandSpec("git", ["status"]).argv, ["git", "status"]);
});

test("path adapter handles linux and windows style fixture paths", () => {
  assert.equal(normalizeRuntimePath("/home/me/app", ".northstar/runtime").includes(".northstar"), true);
  assert.equal(normalizeRuntimePath("C:\\Users\\me\\app", ".northstar\\runtime").includes(".northstar"), true);
});

test("local main sync uses dedicated sync worktree and never root checkout main", () => {
  const plan = planMainSync({
    projectRoot: "/home/timmypai/apps/vocab1",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
  });

  assert.equal(plan.worktreePath, "/home/timmypai/apps/vocab1/.northstar/runtime/sync-worktrees/main");
  assert.equal(plan.commands.some((command) => command.argv.join(" ") === "git checkout main"), false);
  assert.equal(plan.commands.some((command) => command.argv.join(" ") === "git switch main"), false);
  assert.equal(plan.commands.some((command) => command.argv.join(" ") === "git reset --hard origin/main"), false);
  assert.deepEqual(plan.commands.at(-1)?.argv, [
    "git",
    "-C",
    "/home/timmypai/apps/vocab1",
    "worktree",
    "add",
    "--detach",
    "/home/timmypai/apps/vocab1/.northstar/runtime/sync-worktrees/main",
    "origin/main",
  ]);
});

test("worktree cleanup failure is represented as retryable effect history", () => {
  const effect = planWorktreeCleanup("/tmp/issue-worktree");

  assert.equal(effect.type, "worktree_cleanup");
  assert.deepEqual(effect.command.argv, ["git", "worktree", "remove", "/tmp/issue-worktree"]);
});

test("fake host start request includes configured role agent and skills", () => {
  const config = loadConfig(join(repoRoot, "tests/fixtures/.northstar.yaml"));
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml"));
  const roles = resolveWorkflowRoles(workflow, config.workflowOverrides);
  const host = new FakeHostAdapter();

  assert.deepEqual(host.capabilities(), ["root-session", "background-child", "heartbeat"]);
  assert.deepEqual(host.startRootSession({
    issue_id: "issue-1",
    role_name: "implementation_agent",
    role: roles.implementation_agent,
  }), {
    root_session_id: "fake-root-issue-1-implementation_agent",
  });
  assert.deepEqual(host.recordHeartbeat("lease-1"), { status: "recorded" });
  const child = host.startBackgroundChild({
    issue_id: "issue-1",
    lease_id: "lease-1",
    root_session_id: "root-1",
    role_name: "implementation_agent",
    role: roles.implementation_agent,
  });

  assert.equal(child.root_session_id, "root-1");
  assert.equal(child.agent, "codex-gpt-5.3");
  assert.deepEqual(child.load_skills, ["tdd", "playwright"]);
  assert.equal(child.status, "running");
  assert.deepEqual(host.readRootStatus("root-1"), { status: "live" });
  assert.deepEqual(host.readChildStatus(child.child_run_id), { status: "running" });
  assert.equal(host.resumeHint("root-1"), "resume root-1");
});

test("opencode adapter is SDK-first and passes full configured role payload", () => {
  const config = loadConfig(join(repoRoot, "tests/fixtures/.northstar.yaml"));
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml"));
  const roles = resolveWorkflowRoles(workflow, config.workflowOverrides);
  const observed: Record<string, unknown> = {};
  const adapter = new OpenCodeHostAdapter({
    sessions: {
      start: (request) => {
        observed.root = request;
        return { id: "opencode-root-1" };
      },
      heartbeat: (leaseId) => {
        observed.heartbeat = leaseId;
      },
      status: (sessionId) => ({ status: sessionId === "opencode-root-1" ? "live" : "missing" }),
      resumeHint: (sessionId) => `opencode resume ${sessionId}`,
    },
    children: {
      start: (request) => {
        observed.child = request;
        return { id: "opencode-child-1", sessionId: "opencode-child-session-1" };
      },
      status: () => ({ status: "running" }),
    },
  });

  assert.deepEqual(adapter.capabilities(), ["sdk", "root-session", "background-child", "heartbeat"]);
  assert.equal(adapter.startRootSession({ issue_id: "issue-1", role_name: "implementation_agent", role: roles.implementation_agent }).root_session_id, "opencode-root-1");
  assert.deepEqual(adapter.startBackgroundChild({
    issue_id: "issue-1",
    lease_id: "lease-1",
    root_session_id: "opencode-root-1",
    role_name: "implementation_agent",
    role: roles.implementation_agent,
  }), {
    child_run_id: "opencode-child-1",
    root_session_id: "opencode-root-1",
    session_id: "opencode-child-session-1",
    status: "running",
    agent: "codex-gpt-5.3",
    load_skills: ["tdd", "playwright"],
  });
  adapter.recordHeartbeat("lease-1");

  assert.equal(observed.heartbeat, "lease-1");
  assert.equal(adapter.readRootStatus("opencode-root-1").status, "live");
  assert.equal(adapter.readChildStatus("opencode-child-1").status, "running");
  assert.equal(adapter.resumeHint("opencode-root-1"), "opencode resume opencode-root-1");
  assert.deepEqual((observed.child as { role: unknown }).role, roles.implementation_agent);
});

test("codex adapter is SDK-first and passes full configured role payload", () => {
  const config = loadConfig(join(repoRoot, "tests/fixtures/.northstar.yaml"));
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/issue-to-pr-release.yaml"));
  const roles = resolveWorkflowRoles(workflow, config.workflowOverrides);
  const observed: Record<string, unknown> = {};
  const adapter = new CodexHostAdapter({
    root: {
      start: (request) => {
        observed.root = request;
        return { id: "codex-root-1" };
      },
      ping: (leaseId) => {
        observed.heartbeat = leaseId;
      },
      status: (sessionId) => ({ status: sessionId === "codex-root-1" ? "live" : "missing" }),
      resume: (sessionId) => `codex resume ${sessionId}`,
    },
    child: {
      start: (request) => {
        observed.child = request;
        return { id: "codex-child-1", sessionId: "codex-child-session-1" };
      },
      status: () => ({ status: "running" }),
    },
  });

  assert.deepEqual(adapter.capabilities(), ["sdk", "root-session", "background-child", "heartbeat"]);
  assert.equal(adapter.startRootSession({ issue_id: "issue-1", role_name: "implementation_agent", role: roles.implementation_agent }).root_session_id, "codex-root-1");
  assert.deepEqual(adapter.startBackgroundChild({
    issue_id: "issue-1",
    lease_id: "lease-1",
    root_session_id: "codex-root-1",
    role_name: "implementation_agent",
    role: roles.implementation_agent,
  }), {
    child_run_id: "codex-child-1",
    root_session_id: "codex-root-1",
    session_id: "codex-child-session-1",
    status: "running",
    agent: "codex-gpt-5.3",
    load_skills: ["tdd", "playwright"],
  });
  adapter.recordHeartbeat("lease-1");

  assert.equal(observed.heartbeat, "lease-1");
  assert.equal(adapter.readRootStatus("codex-root-1").status, "live");
  assert.equal(adapter.readChildStatus("codex-child-1").status, "running");
  assert.equal(adapter.resumeHint("codex-root-1"), "codex resume codex-root-1");
  assert.deepEqual((observed.child as { role: unknown }).role, roles.implementation_agent);
});

test("host SDK loaders pin concrete package names behind dynamic import boundaries", () => {
  assert.equal(opencodeSdkPackageName(), "@opencode-ai/sdk");
  assert.equal(codexSdkPackageName(), "@openai/codex-sdk");
  assert.match(openCodeLoader.toString(), /import\("@opencode-ai\/sdk"\)/);
  assert.match(codexLoader.toString(), /import\("@openai\/codex-sdk"\)/);
});

test("host SDK loaders include pi package behind dynamic import boundaries", () => {
  assert.equal(piSdkPackageName(), "@earendil-works/pi-coding-agent");
  assert.match(piLoader.toString(), /import\("@earendil-works\/pi-coding-agent"\)/);
});

test("projection failure events are compact and retryable for all targets", () => {
  const targets = ["label", "project", "body_comment", "issue_close"];

  for (const target of targets) {
    assert.deepEqual(projectionFailureEvent(target, "rate limited", "2026-05-29T03:05:00.000Z", {
      attempt: 2,
      payload: { compact: true },
    }), {
      type: "projection_result",
      projection_target: target,
      status: "failed",
      attempt: 2,
      last_error: "rate limited",
      next_retry_at: "2026-05-29T03:05:00.000Z",
      payload: { compact: true },
    });
  }
});

test("github remote adapter syncs labels, body comments, and issue close through REST calls", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    },
  });

  await adapter.syncLabel({ issue_number: 1, labels: ["northstar-smoke-test"] });
  await adapter.syncBodyComment({ issue_number: 1, body: "northstar-smoke-body" });
  await adapter.closeIssue({ issue_number: 1 });

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["POST", "https://api.github.com/repos/owner/repo/issues/1/labels"],
    ["POST", "https://api.github.com/repos/owner/repo/issues/1/comments"],
    ["PATCH", "https://api.github.com/repos/owner/repo/issues/1"],
  ]);
  assert.match(calls[0].body ?? "", /northstar-smoke-test/);
  assert.match(calls[1].body ?? "", /northstar-smoke-body/);
  assert.match(calls[2].body ?? "", /closed/);
});

test("github remote adapter syncs Project v2 by discovering issue node id and adding project item", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
      if (String(url).endsWith("/issues/7")) {
        return new Response(JSON.stringify({ node_id: "ISSUE_node_7" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_item_1" } } } }), { status: 200 });
    },
  });

  assert.deepEqual(await adapter.syncProject({ issue_number: 7, project_id: "PVT_project_1" }), {
    type: "projection_result",
    projection_target: "project",
    status: "success",
    payload: { issue_number: 7, project_id: "PVT_project_1", project_item_id: "PVTI_item_1" },
  });

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "https://api.github.com/repos/owner/repo/issues/7"],
    ["POST", "https://api.github.com/graphql"],
  ]);
  assert.match(calls[1].body ?? "", /addProjectV2ItemById/);
  assert.match(calls[1].body ?? "", /PVT_project_1/);
  assert.match(calls[1].body ?? "", /ISSUE_node_7/);
});

test("github remote adapter skips project sync when project id is absent", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async () => {
      throw new Error("project skip should not call GitHub");
    },
  });

  assert.deepEqual(await adapter.syncProject({ issue_number: 7 }), {
    type: "projection_skipped",
    projection_target: "project",
    status: "skipped",
    reason: "NORTHSTAR_LIVE_GITHUB_PROJECT_ID is not configured",
    payload: { issue_number: 7 },
  });
});

test("github remote adapter converts project discovery HTTP failures into retryable projection events", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async () => new Response("missing issue", { status: 404 }),
    now: () => "2026-05-29T03:00:00.000Z",
  });

  assert.deepEqual(await adapter.syncProject({ issue_number: 7, project_id: "PVT_project_1" }), {
    type: "projection_result",
    projection_target: "project",
    status: "failed",
    attempt: 1,
    last_error: "GitHub project issue discovery failed with 404: missing issue",
    next_retry_at: "2026-05-29T03:01:00.000Z",
    payload: { issue_number: 7, project_id: "PVT_project_1" },
  });
});

test("github remote adapter converts missing project issue node id into retryable projection events", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async () => new Response(JSON.stringify({}), { status: 200 }),
    now: () => "2026-05-29T03:00:00.000Z",
  });

  assert.deepEqual(await adapter.syncProject({ issue_number: 7, project_id: "PVT_project_1" }), {
    type: "projection_result",
    projection_target: "project",
    status: "failed",
    attempt: 1,
    last_error: "GitHub project issue discovery did not return node_id",
    next_retry_at: "2026-05-29T03:01:00.000Z",
    payload: { issue_number: 7, project_id: "PVT_project_1" },
  });
});

test("github remote adapter converts remote failures into retryable projection events", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async () => new Response("server exploded", { status: 500 }),
    now: () => "2026-05-29T03:00:00.000Z",
  });

  assert.deepEqual(await adapter.syncLabel({ issue_number: 1, labels: ["northstar-smoke-test"] }), {
    type: "projection_result",
    projection_target: "label",
    status: "failed",
    attempt: 1,
    last_error: "GitHub label sync failed with 500: server exploded",
    next_retry_at: "2026-05-29T03:01:00.000Z",
    payload: { issue_number: 1, labels: ["northstar-smoke-test"] },
  });
});

test("github remote adapter converts Project v2 GraphQL failures into retryable projection events", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "token-1",
    fetch: async (url) => {
      if (String(url).endsWith("/issues/7")) {
        return new Response(JSON.stringify({ node_id: "ISSUE_node_7" }), { status: 200 });
      }
      return new Response(JSON.stringify({ errors: [{ message: "project field denied" }] }), { status: 200 });
    },
    now: () => "2026-05-29T03:00:00.000Z",
  });

  assert.deepEqual(await adapter.syncProject({ issue_number: 7, project_id: "PVT_project_1" }), {
    type: "projection_result",
    projection_target: "project",
    status: "failed",
    attempt: 1,
    last_error: "GitHub project sync failed: project field denied",
    next_retry_at: "2026-05-29T03:01:00.000Z",
    payload: { issue_number: 7, project_id: "PVT_project_1" },
  });
});

test("worktree sync plans cover create, reuse, failure, and repair", () => {
  const createPlan = planMainSync({
    projectRoot: "/home/timmypai/apps/vocab1",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    syncWorktreeExists: false,
  });
  const reusePlan = planMainSync({
    projectRoot: "/home/timmypai/apps/vocab1",
    syncWorktreeDir: ".northstar/runtime/sync-worktrees/main",
    baseBranch: "main",
    syncWorktreeExists: true,
  });

  assert.equal(createPlan.mode, "create");
  assert.equal(reusePlan.mode, "reuse");
  assert.deepEqual(reusePlan.commands.map((command) => command.argv.slice(2, 5).join(" ")), [
    "/home/timmypai/apps/vocab1/.northstar/runtime/sync-worktrees/main status --porcelain",
    "/home/timmypai/apps/vocab1/.northstar/runtime/sync-worktrees/main fetch origin",
    "/home/timmypai/apps/vocab1/.northstar/runtime/sync-worktrees/main merge --ff-only",
  ]);
  assert.equal(createPlan.failureHistory("boom").event_type, "effect_failed_retryable");
  assert.equal(createPlan.repairHistory().payload.action, "repair_sync_worktree");
});

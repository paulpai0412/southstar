import test from "node:test";
import assert from "node:assert/strict";
import { fullLiveEnabled, fullLiveScenarioSelected, requireFullLiveEnv } from "./env.ts";
import { emptyFullLiveMetrics, formatFullLiveSummary, hasFullLiveSecretLeak } from "./metrics.ts";
import { GitHubSandboxClient } from "./github-sandbox.ts";
import { CodexFullLiveWorker } from "./codex-worker.ts";
import { createFullLiveRuntimeDriver } from "./runtime-driver.ts";
import { assertFixtureGate, buildParallelMetrics, buildSequentialMetrics, FullLiveHarness } from "./harness.ts";
import { buildSuiteMetrics } from "./suite-metrics.ts";

test("full live env skips when NORTHSTAR_FULL_LIVE is absent", () => {
  assert.equal(fullLiveEnabled({}), false);
});

test("full live env fails with actionable missing fields when enabled", () => {
  assert.throws(
    () => requireFullLiveEnv({ NORTHSTAR_FULL_LIVE: "1" }),
    /Missing full live E2E configuration: GITHUB_TOKEN, NORTHSTAR_LIVE_GITHUB_REPO/,
  );
});

test("full live env requires sandbox repository", () => {
  assert.throws(
    () => requireFullLiveEnv({
      NORTHSTAR_FULL_LIVE: "1",
      GITHUB_TOKEN: "gho_example",
      NORTHSTAR_LIVE_GITHUB_REPO: "paulpai0412/northstar",
    }),
    /NORTHSTAR_LIVE_GITHUB_REPO must be paulpai0412\/northstar-live-sandbox/,
  );
});

test("full live scenario filter can isolate one live scenario", () => {
  assert.equal(fullLiveScenarioSelected("single", {}), true);
  assert.equal(fullLiveScenarioSelected("single", { NORTHSTAR_FULL_LIVE_SCENARIO: "" }), true);
  assert.equal(fullLiveScenarioSelected("single", { NORTHSTAR_FULL_LIVE_SCENARIO: "single" }), true);
  assert.equal(fullLiveScenarioSelected("sequential", { NORTHSTAR_FULL_LIVE_SCENARIO: "single" }), false);
});

test("full live metrics summary includes suite totals and detects secret-shaped values", () => {
  const metrics = emptyFullLiveMetrics();
  metrics.full_live_total_issues_created = 5;
  metrics.full_live_total_completed = 5;
  metrics.full_live_total_prs_merged = 5;
  metrics.full_live_total_fixture_files_created = 5;
  metrics.full_live_total_duration_seconds = 42;

  const summary = formatFullLiveSummary(metrics);

  assert.match(summary, /full_live_total_issues_created=5/);
  assert.match(summary, /full_live_total_completed=5/);
  assert.equal(hasFullLiveSecretLeak("authorization: bearer gho_abc"), true);
  assert.equal(hasFullLiveSecretLeak(summary), false);
});

test("github sandbox helper creates issue, branch commit, PR, merge, and close via REST", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith("/issues")) return jsonResponse({ number: 11, html_url: "https://github.test/issues/11", node_id: "I_11" });
    if (String(url).endsWith("/git/ref/heads/main")) return jsonResponse({ object: { sha: "mainsha" } });
    if (String(url).endsWith("/git/trees/mainsha")) return jsonResponse({ sha: "treesha" });
    if (String(url).endsWith("/git/blobs")) return jsonResponse({ sha: "blobsha" });
    if (String(url).endsWith("/git/trees")) return jsonResponse({ sha: "newtree" });
    if (String(url).endsWith("/git/commits")) return jsonResponse({ sha: "commitsha" });
    if (String(url).endsWith("/git/refs")) return jsonResponse({ ref: "refs/heads/northstar-smoke-branch" });
    if (String(url).includes("/pulls") && init?.method === "POST") return jsonResponse({ number: 22, html_url: "https://github.test/pulls/22", head: { ref: "northstar-smoke-branch" } });
    if (String(url).endsWith("/pulls/22/files")) return jsonResponse([{ filename: "northstar-smoke/run/issue.json", contents_url: "contents" }]);
    if (String(url).endsWith("/contents/northstar-smoke%2Frun%2Fissue.json?ref=northstar-smoke-branch")) return jsonResponse({ content: Buffer.from("{\"ok\":true}", "utf8").toString("base64") });
    if (String(url).endsWith("/pulls/22/merge")) return jsonResponse({ merged: true, sha: "mergesha" });
    if (String(url).endsWith("/issues/11/comments")) return jsonResponse({ html_url: "https://github.test/issues/11#issuecomment" });
    if (String(url).endsWith("/issues/11")) return jsonResponse({ state: "closed" });
    return jsonResponse({});
  };
  const client = new GitHubSandboxClient({ repo: "paulpai0412/northstar-live-sandbox", token: "gho_fake", fetch: fetchImpl });

  const issue = await client.createIssue({ title: "northstar-smoke issue", body: "body" });
  const branch = await client.createFixtureBranch({
    branch: "northstar-smoke-branch",
    base: "main",
    path: "northstar-smoke/run/issue.json",
    content: JSON.stringify({ ok: true }),
    message: "northstar smoke fixture",
  });
  const pr = await client.createPullRequest({ title: "northstar smoke", head: branch.branch, base: "main", body: "body" });
  const files = await client.listPullRequestFiles(pr.number);
  const content = await client.readFileContent({ path: "northstar-smoke/run/issue.json", ref: branch.branch });
  const merge = await client.mergePullRequest({ number: pr.number, commit_title: "northstar smoke merge" });
  const comment = await client.addIssueComment(issue.number, "northstar smoke cleanup");
  const closed = await client.closeIssue(issue.number);

  assert.equal(issue.number, 11);
  assert.equal(branch.commit_sha, "commitsha");
  assert.equal(pr.number, 22);
  assert.equal(files[0].filename, "northstar-smoke/run/issue.json");
  assert.equal(content, "{\"ok\":true}");
  assert.equal(merge.sha, "mergesha");
  assert.equal(comment.html_url, "https://github.test/issues/11#issuecomment");
  assert.equal(closed.state, "closed");
  assert.equal(calls.some((call) => /authorization/i.test(JSON.stringify(call.body))), false);
});

test("full live harness comments and closes smoke issue when a later step fails", async () => {
  const cleanupCalls: Array<{ type: "comment" | "close"; number: number; body?: string }> = [];
  const harness = new FullLiveHarness({ repo: "paulpai0412/northstar-live-sandbox", token: "gho_fake" });
  (harness as unknown as { github: unknown }).github = {
    createIssue: async () => ({ number: 44, html_url: "https://github.test/issues/44" }),
    createFixtureBranch: async () => {
      throw new Error("branch creation failed with token gho_should_be_redacted");
    },
    addIssueComment: async (number: number, body: string) => {
      cleanupCalls.push({ type: "comment", number, body });
      return { html_url: "https://github.test/issues/44#issuecomment" };
    },
    closeIssue: async (number: number) => {
      cleanupCalls.push({ type: "close", number });
      return { state: "closed" };
    },
  };
  (harness as unknown as { codex: unknown }).codex = {
    runImplementation: async () => ({
      root_session_id: "root-impl",
      child_run_id: "child-impl",
      final_response: JSON.stringify({ status: "ok" }),
    }),
  };

  await assert.rejects(
    () => harness.runSingleIssueScenario(),
    /branch creation failed/,
  );

  assert.equal(cleanupCalls.length, 2);
  assert.equal(cleanupCalls[0].type, "comment");
  assert.equal(cleanupCalls[0].number, 44);
  assert.match(cleanupCalls[0].body ?? "", /Full live E2E failed after creating this smoke issue/);
  assert.doesNotMatch(cleanupCalls[0].body ?? "", /gho_should_be_redacted/);
  assert.deepEqual(cleanupCalls[1], { type: "close", number: 44 });
});

test("github sandbox helper initializes empty sandbox repository before fixture branch", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let refReads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url).endsWith("/git/ref/heads/main")) {
      refReads += 1;
      if (refReads === 1) return jsonResponse({ message: "Git Repository is empty." }, 409);
      return jsonResponse({ object: { sha: "mainsha" } });
    }
    if (String(url).endsWith("/contents/README.md")) return jsonResponse({ commit: { sha: "initcommit" } });
    if (String(url).endsWith("/git/blobs")) return jsonResponse({ sha: "fixtureblob" });
    if (String(url).endsWith("/git/trees/mainsha")) return jsonResponse({ sha: "maintree" });
    if (String(url).endsWith("/git/trees")) return jsonResponse({ sha: "fixturetree" });
    if (String(url).endsWith("/git/commits")) return jsonResponse({ sha: "fixturecommit" });
    if (String(url).endsWith("/git/refs")) return jsonResponse({ ref: "refs/heads/main" });
    return jsonResponse({});
  };
  const client = new GitHubSandboxClient({ repo: "paulpai0412/northstar-live-sandbox", token: "gho_fake", fetch: fetchImpl });

  const branch = await client.createFixtureBranch({
    branch: "northstar-smoke-branch",
    base: "main",
    path: "northstar-smoke/run/issue.json",
    content: JSON.stringify({ ok: true }),
    message: "northstar smoke fixture",
  });

  assert.equal(branch.commit_sha, "fixturecommit");
  const readmeInit = calls.find((call) => call.url.endsWith("/contents/README.md"));
  assert.deepEqual(readmeInit?.body, {
    message: "Initialize northstar live sandbox",
    content: Buffer.from("# Northstar live sandbox\n", "utf8").toString("base64"),
    branch: "main",
  });
  assert.deepEqual(calls.filter((call) => call.url.endsWith("/git/refs")).map((call) => call.body), [
    { ref: "refs/heads/northstar-smoke-branch", sha: "fixturecommit" },
  ]);
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("codex full live worker records implementation and verifier child outputs without shell fallback", async () => {
  const prompts: string[] = [];
  const worker = new CodexFullLiveWorker({
    run: async (input) => {
      prompts.push(input.prompt);
      return {
        root_session_id: `root-${input.role}`,
        child_run_id: `child-${input.role}`,
        final_response: JSON.stringify({ status: "ok", role: input.role, branch: "northstar-smoke-branch" }),
        duration_ms: 12,
      };
    },
  });

  const implementation = await worker.runImplementation({
    issue_number: 11,
    issue_url: "https://github.test/issues/11",
    repo: "paulpai0412/northstar-live-sandbox",
    branch: "northstar-smoke-branch",
    fixture_path: "northstar-smoke/run/issue.json",
    fixture_content: "{\"ok\":true}",
  });
  const verification = await worker.runVerification({
    pr_number: 22,
    pr_url: "https://github.test/pulls/22",
    expected_fixture_path: "northstar-smoke/run/issue.json",
  });

  assert.equal(implementation.role, "implement");
  assert.equal(verification.role, "verify");
  assert.equal(implementation.shell_fallbacks, 0);
  assert.equal(verification.shell_fallbacks, 0);
  assert.match(prompts[0], /Do not modify any repository except paulpai0412\/northstar-live-sandbox/);
  assert.match(prompts[1], /Return compact JSON evidence/);
});

test("runtime driver can complete issue_to_pr_release from worker, verifier, and release facts", async () => {
  const driver = await createFullLiveRuntimeDriver();
  try {
    const issue = driver.seedIssue({ issue_number: 11, title: "northstar smoke", source_url: "https://github.test/issues/11" });
    driver.startImplementation(issue.issue_id);
    driver.submitWorkerResult(issue.issue_id, {
      branch: "northstar-smoke-branch",
      commit_sha: "abc123",
      changed_files: ["northstar-smoke/run/issue.json"],
      self_check_summary: "full live implementation completed",
    });
    driver.startVerification(issue.issue_id);
    driver.submitVerifierEvidence(issue.issue_id, {
      pr_number: 22,
      gate_results: [{ name: "fixture gate", status: "pass" }],
    });
    driver.claimRelease(issue.issue_id);
    const completed = driver.submitReleaseSuccess(issue.issue_id, { merge_sha: "merge123" });

    assert.equal(completed.lifecycle_state, "completed");
    assert.equal(driver.confirmedMergeFacts(), 1);
  } finally {
    await driver.cleanup();
  }
});

test("fixture gate rejects missing expected fixture path and content mismatch", () => {
  assert.doesNotThrow(() => assertFixtureGate({
    files: [{ filename: "northstar-smoke/run/issue.json" }],
    expected_path: "northstar-smoke/run/issue.json",
    expected_content: "{\"issue\":11}",
    actual_content: "{\"issue\":11}",
  }));
  assert.throws(() => assertFixtureGate({
    files: [{ filename: "other.json" }],
    expected_path: "northstar-smoke/run/issue.json",
    expected_content: "{\"issue\":11}",
    actual_content: "{\"issue\":11}",
  }), /missing expected fixture path/);
  assert.throws(() => assertFixtureGate({
    files: [{ filename: "northstar-smoke/run/issue.json" }],
    expected_path: "northstar-smoke/run/issue.json",
    expected_content: "{\"issue\":11}",
    actual_content: "{\"issue\":12}",
  }), /fixture content mismatch/);
});

test("sequential metrics require two completed issues with one active worker at a time", () => {
  const metrics = buildSequentialMetrics([
    {
      started_at: 100,
      completed_at: 200,
      completed: true,
      merged: true,
      fixture_path: "northstar-smoke/run/one.json",
    },
    {
      started_at: 250,
      completed_at: 400,
      completed: true,
      merged: true,
      fixture_path: "northstar-smoke/run/two.json",
    },
  ], 42);

  assert.equal(metrics.full_live_sequential_issues_created, 2);
  assert.equal(metrics.full_live_sequential_completed, 2);
  assert.equal(metrics.full_live_sequential_prs_created, 2);
  assert.equal(metrics.full_live_sequential_prs_merged, 2);
  assert.equal(metrics.full_live_sequential_ordering_violations, 0);
  assert.equal(metrics.full_live_sequential_max_active_issue_workers, 1);
  assert.equal(metrics.full_live_sequential_fixture_files_created, 2);
  assert.equal(metrics.full_live_sequential_cross_issue_contamination, 0);
  assert.equal(metrics.full_live_sequential_duration_seconds, 42);
});

test("parallel metrics require overlapping completed issues and no merge conflicts", () => {
  const metrics = buildParallelMetrics([
    {
      started_at: 100,
      completed_at: 500,
      completed: true,
      merged: true,
      fixture_path: "northstar-smoke/run/one.json",
    },
    {
      started_at: 200,
      completed_at: 400,
      completed: true,
      merged: true,
      fixture_path: "northstar-smoke/run/two.json",
    },
  ], 51);

  assert.equal(metrics.full_live_parallel_issues_created, 2);
  assert.equal(metrics.full_live_parallel_completed, 2);
  assert.equal(metrics.full_live_parallel_prs_created, 2);
  assert.equal(metrics.full_live_parallel_prs_merged, 2);
  assert.equal(metrics.full_live_parallel_overlap_seconds, 1);
  assert.equal(metrics.full_live_parallel_max_active_issue_workers, 2);
  assert.equal(metrics.full_live_parallel_fixture_files_created, 2);
  assert.equal(metrics.full_live_parallel_cross_issue_contamination, 0);
  assert.equal(metrics.full_live_parallel_merge_conflicts, 0);
  assert.equal(metrics.full_live_parallel_duration_seconds, 51);
});

test("suite metrics aggregate single, sequential, and parallel live results", () => {
  const single = emptyFullLiveMetrics();
  single.full_live_issues_created = 1;
  single.full_live_runtime_issues_completed = 1;
  single.full_live_prs_merged = 1;
  single.full_live_fixture_files_created = 1;
  single.full_live_secret_leaks = 0;

  const sequential = emptyFullLiveMetrics();
  sequential.full_live_sequential_issues_created = 2;
  sequential.full_live_sequential_completed = 2;
  sequential.full_live_sequential_prs_merged = 2;
  sequential.full_live_sequential_fixture_files_created = 2;

  const parallel = emptyFullLiveMetrics();
  parallel.full_live_parallel_issues_created = 2;
  parallel.full_live_parallel_completed = 2;
  parallel.full_live_parallel_prs_merged = 2;
  parallel.full_live_parallel_fixture_files_created = 2;
  parallel.full_live_parallel_merge_conflicts = 0;

  const metrics = buildSuiteMetrics({ single, sequential, parallel }, 90);

  assert.equal(metrics.full_live_total_issues_created, 5);
  assert.equal(metrics.full_live_total_completed, 5);
  assert.equal(metrics.full_live_total_prs_merged, 5);
  assert.equal(metrics.full_live_total_fixture_files_created, 5);
  assert.equal(metrics.full_live_total_failed_releases, 0);
  assert.equal(metrics.full_live_total_secret_leaks, 0);
  assert.equal(metrics.full_live_total_duration_seconds, 90);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubSoftwareDevGateway } from "../../src/adapters/github/software-dev-gateway.ts";

test("creates or reuses pull request for branch", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      calls.push({ path: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/pulls?")) {
        return jsonResponse([{ number: 9, html_url: "https://github.com/owner/repo/pull/9" }]);
      }
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
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("creates pull request when no existing branch PR is open", async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      calls.push({
        path: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).includes("/pulls?")) return jsonResponse([]);
      return jsonResponse({ number: 10, html_url: "https://github.com/owner/repo/pull/10" });
    },
  });

  const pr = await gateway.createPullRequest({
    title: "Issue 2",
    head: "northstar/issue-2",
    base: "main",
    body: "body",
  });

  assert.equal(pr.number, 10);
  assert.equal(calls.some((call) => call.path.endsWith("/pulls") && call.method === "POST"), true);
});

test("confirmed merge requires merge sha", async () => {
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => jsonResponse({ merged: true }),
  });

  await assert.rejects(() => gateway.mergePullRequest({ number: 1, commit_title: "merge" }), /MERGE_SHA_MISSING/);
});

test("software dev gateway classifies merge conflict with stable code", async () => {
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response(JSON.stringify({ message: "Merge conflict" }), { status: 409 }),
  });

  await assert.rejects(
    () => gateway.mergePullRequest({ number: 12, commit_title: "merge" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "PR_MERGE_CONFLICT");
      return true;
    },
  );
});

test("software dev gateway classifies conflict-like 405 merge responses as merge conflict", async () => {
  const cases = [
    "Merge conflict",
    "Pull request is dirty",
    "This branch cannot be automatically merged",
  ];

  for (const body of cases) {
    const gateway = new GitHubSoftwareDevGateway({
      repo: "owner/repo",
      token: "token",
      fetch: async () => new Response(body, { status: 405 }),
    });

    await assert.rejects(
      () => gateway.mergePullRequest({ number: 12, commit_title: "merge" }),
      (error) => {
        assert.equal((error as { code?: string }).code, "PR_MERGE_CONFLICT");
        return true;
      },
    );
  }
});

test("software dev gateway classifies merge blocked and permission errors with stable codes", async () => {
  const cases = [
    { status: 405, body: "Pull Request is not mergeable", code: "PR_NOT_MERGEABLE_YET" },
    { status: 403, body: "Resource not accessible by integration", code: "PR_MERGE_PERMISSION_DENIED" },
    { status: 500, body: "GitHub outage", code: "PR_MERGE_UNKNOWN_FAILURE" },
  ];

  for (const mergeCase of cases) {
    const gateway = new GitHubSoftwareDevGateway({
      repo: "owner/repo",
      token: "token",
      fetch: async () => new Response(mergeCase.body, { status: mergeCase.status }),
    });

    await assert.rejects(
      () => gateway.mergePullRequest({ number: 12, commit_title: "merge" }),
      (error) => {
        assert.equal((error as { code?: string }).code, mergeCase.code);
        return true;
      },
    );
  }
});

test("software dev gateway classifies generic 405 merge failure as unknown", async () => {
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response("Method not allowed", { status: 405 }),
  });

  await assert.rejects(
    () => gateway.mergePullRequest({ number: 12, commit_title: "merge" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "PR_MERGE_UNKNOWN_FAILURE");
      return true;
    },
  );
});

test("software dev gateway does not classify not-mergeable text on non-405 statuses as readiness", async () => {
  const cases = [
    { status: 500, code: "PR_MERGE_UNKNOWN_FAILURE" },
    { status: 403, code: "PR_MERGE_PERMISSION_DENIED" },
    { status: 409, code: "PR_MERGE_CONFLICT" },
  ];

  for (const mergeCase of cases) {
    const gateway = new GitHubSoftwareDevGateway({
      repo: "owner/repo",
      token: "token",
      fetch: async () => new Response("Pull Request is not mergeable", { status: mergeCase.status }),
    });

    await assert.rejects(
      () => gateway.mergePullRequest({ number: 12, commit_title: "merge" }),
      (error) => {
        assert.equal((error as { code?: string }).code, mergeCase.code);
        return true;
      },
    );
  }
});

test("github software gateway covers merge false, close, comments, labels, and request errors", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      calls.push({ path: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("/git/ref/heads/existing")) {
        return jsonResponse({ object: { sha: "existing-sha" } });
      }
      if (String(url).includes("/pulls/3/merge")) {
        return jsonResponse({ merged: false });
      }
      if (String(url).includes("/fail")) {
        return new Response("ghp_secret", { status: 500 });
      }
      return jsonResponse({});
    },
  });

  const branch = await gateway.createFixtureBranch({
    branch: "existing",
    base: "main",
    path: "fixture.json",
    content: "{}",
    message: "message",
  });
  const merge = await gateway.mergePullRequest({ number: 3, commit_title: "merge" });
  await gateway.closeIssue(3);
  await gateway.addIssueComment(3, "comment");
  await gateway.updateIssueLabels(3, ["northstar:running"]);

  assert.equal(branch.commit_sha, "existing-sha");
  assert.deepEqual(merge, { merged: false, sha: "" });
  assert.equal(calls.some((call) => call.path.includes("/issues/3/comments") && call.method === "POST"), true);
  assert.equal(calls.some((call) => call.path.includes("/issues/3/labels") && call.method === "POST"), true);
});

test("github software gateway redacts request failures", async () => {
  const gateway = new GitHubSoftwareDevGateway({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => new Response("ghp_secret", { status: 500 }),
  });

  await assert.rejects(
    () => gateway.closeIssue(9),
    (error) => error instanceof Error && /failed with 500/.test(error.message) && !/ghp_secret/.test(error.message),
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

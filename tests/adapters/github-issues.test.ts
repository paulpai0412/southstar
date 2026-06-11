import test from "node:test";
import assert from "node:assert/strict";
import { GitHubIssueIntakeAdapter, parseIssueDependencies } from "../../src/adapters/github/issues.ts";

interface GitHubApiIssueFixture {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

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

test("native linked issue dependencies are discovered and merged with marker dependencies", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    readyLabel: "northstar:ready",
    fetch: async (url) => {
      if (String(url).includes("/timeline")) {
        return jsonResponse([
          { event: "connected", source: { issue: { number: 8 } } },
          { event: "cross-referenced", source: { issue: { number: 9 } } },
          { event: "connected", source: { issue: { number: 8 } } },
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

function issue(overrides: Partial<GitHubApiIssueFixture> = {}): GitHubApiIssueFixture {
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

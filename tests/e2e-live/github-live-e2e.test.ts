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

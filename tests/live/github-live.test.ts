import test from "node:test";
import assert from "node:assert/strict";
import { GitHubRemoteProjectionAdapter } from "../../src/adapters/github/remote.ts";

const smokePrefix = "northstar-smoke";

test("live GitHub remote projection smoke uses a traceable temporary issue", async (t) => {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.NORTHSTAR_LIVE_GITHUB_REPO;
  const projectId = process.env.NORTHSTAR_LIVE_GITHUB_PROJECT_ID;
  const missing = [
    ...(process.env.NORTHSTAR_LIVE_GITHUB === "1" ? [] : ["NORTHSTAR_LIVE_GITHUB=1"]),
    ...(token ? [] : ["GITHUB_TOKEN"]),
    ...(repo ? [] : ["NORTHSTAR_LIVE_GITHUB_REPO"]),
    ...(projectId ? [] : ["NORTHSTAR_LIVE_GITHUB_PROJECT_ID"]),
  ];
  if (missing.length > 0) {
    t.skip(`Missing GitHub live smoke configuration: ${missing.join(", ")}.`);
    return;
  }

  const issue = await createTemporaryIssue(repo, token);
  console.log(`northstar-live-github-issue ${issue.number} ${issue.html_url}`);
  const adapter = new GitHubRemoteProjectionAdapter({ repo, token });
  const label = `${smokePrefix}-${Date.now()}`;

  const labelResult = await adapter.syncLabel({ issue_number: issue.number, labels: [label] });
  const commentResult = await adapter.syncBodyComment({
    issue_number: issue.number,
    body: `${smokePrefix}-comment ${new Date().toISOString()}`,
  });
  const projectResult = await adapter.syncProject({
    issue_number: issue.number,
    project_id: projectId,
  });
  const closeResult = await adapter.closeIssue({ issue_number: issue.number });

  assert.equal(labelResult.status, "success");
  assert.equal(commentResult.status, "success");
  assert.equal(projectResult.status, "success");
  assert.equal(closeResult.status, "success");
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
      body: `${smokePrefix}-body created by Northstar live smoke`,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub temporary issue creation failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as { number: number; html_url: string };
}

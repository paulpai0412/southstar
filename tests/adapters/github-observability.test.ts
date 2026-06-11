import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GitHubObservabilityAdapter,
  replaceStatusMarker,
} from "../../src/adapters/github/observability.ts";

test("issue observability syncs state label, progress comment, and body marker", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes("/issues/5") && init?.method === "GET") return jsonResponse({ body: "user body" });
      return jsonResponse({});
    },
  });

  await adapter.syncIssueProgress({
    issueNumber: 5,
    lifecycleState: "running",
    comment: "Northstar running issue_worker",
    statusMarkdown: "State: running",
  });

  assert.equal(requests.some((item) => item.url.endsWith("/issues/5/labels")), true);
  assert.equal(requests.some((item) => item.url.endsWith("/issues/5/comments")), true);
  assert.equal(requests.some((item) => item.method === "PATCH" && JSON.stringify(item.body).includes("northstar-status")), true);
});

test("issue observability keeps lifecycle labels mutually exclusive and preserves user labels", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith("/issues/9/labels") && method === "GET") {
        return jsonResponse([
          { name: "northstar:ready" },
          { name: "northstar:running" },
          { name: "northstar:completed" },
          { name: "customer:keep" },
        ]);
      }
      if (String(url).endsWith("/issues/9") && method === "GET") return jsonResponse({ body: "body" });
      return jsonResponse({});
    },
  });

  await adapter.syncIssueProgress({
    issueNumber: 9,
    lifecycleState: "completed",
    comment: "Northstar completed",
    statusMarkdown: "State: completed",
  });

  const deletedLabels = requests
    .filter((request) => request.method === "DELETE")
    .map((request) => decodeURIComponent(request.url.split("/labels/").at(-1) ?? ""));
  assert.deepEqual(deletedLabels.sort(), ["northstar:ready", "northstar:running"]);
  assert.equal(deletedLabels.includes("northstar:completed"), false);
  assert.equal(deletedLabels.includes("customer:keep"), false);
  assert.deepEqual(
    requests.find((request) => request.method === "POST" && request.url.endsWith("/issues/9/labels"))?.body,
    { labels: ["northstar:completed"] },
  );
});

test("issue observability projects dependency blocked ready issues to blocked label", async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith("/issues/40/labels") && method === "GET") {
        return jsonResponse([
          { name: "northstar:ready" },
          { name: "customer:keep" },
        ]);
      }
      if (String(url).endsWith("/issues/40") && method === "GET") return jsonResponse({ body: "body" });
      return jsonResponse({});
    },
  });

  await adapter.syncIssueProgress({
    issueNumber: 40,
    lifecycleState: "ready",
    blockedBy: ["dependency:39:quarantined"],
    comment: "Northstar ready but dependency blocked",
    statusMarkdown: "State: ready\nBlocked By: dependency:39:quarantined",
  });

  const deletedLabels = requests
    .filter((request) => request.method === "DELETE")
    .map((request) => decodeURIComponent(request.url.split("/labels/").at(-1) ?? ""));
  assert.deepEqual(deletedLabels, ["northstar:ready"]);
  assert.deepEqual(
    requests.find((request) => request.method === "POST" && request.url.endsWith("/issues/40/labels"))?.body,
    { labels: ["northstar:blocked"] },
  );
});

test("issue observability upserts one status marker and bounds progress comments", async () => {
  const comments: unknown[] = [];
  const patches: unknown[] = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      if (String(url).endsWith("/issues/7/comments")) comments.push(JSON.parse(String(init?.body)));
      if (String(url).endsWith("/issues/7") && init?.method === "PATCH") patches.push(JSON.parse(String(init?.body)));
      if (String(url).endsWith("/issues/7") && init?.method === "GET") {
        return jsonResponse({ body: "<!-- northstar-status -->\nold\n<!-- /northstar-status -->\n\nbody" });
      }
      return jsonResponse({});
    },
  });

  const significantTransitions = ["ready", "running", "completed"];
  const retryableFailures = ["projection failed"];

  for (const lifecycleState of significantTransitions) {
    await adapter.syncIssueProgress({
      issueNumber: 7,
      lifecycleState,
      comment: `Northstar ${lifecycleState}`,
      statusMarkdown: `State: ${lifecycleState}`,
      progressSignificance: "transition",
    });
  }
  await adapter.syncIssueProgress({
    issueNumber: 7,
    lifecycleState: "running",
    comment: "Retryable effect failed: projection failed",
    statusMarkdown: "State: running",
    progressSignificance: "retryable_failure",
  });
  await adapter.syncIssueProgress({
    issueNumber: 7,
    lifecycleState: "running",
    comment: "Heartbeat only",
    statusMarkdown: "State: running",
    progressSignificance: "routine",
  });

  const progressComments = comments;
  const statusMarkerUpserts = patches.length;
  assert.equal(progressComments.length <= significantTransitions.length + retryableFailures.length, true);
  assert.equal(statusMarkerUpserts >= 3, true);
  assert.equal(patches.every((patch) => {
    const body = String((patch as { body?: string }).body ?? "");
    return (body.match(/<!-- northstar-status -->/g)?.length ?? 0) === 1 &&
      (body.match(/<!-- \/northstar-status -->/g)?.length ?? 0) === 1;
  }), true);
});

test("projection failure is retryable and does not mutate lifecycle", async () => {
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => new Response("ghp_secret", { status: 500 }),
    now: () => "2026-05-30T00:00:00.000Z",
  });

  const result = await adapter.trySyncIssueProgress({
    issueNumber: 5,
    lifecycleState: "running",
    comment: "comment",
    statusMarkdown: "state",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.projection_target, "github_observability");
  assert.equal(result.mutates_lifecycle, false);
  assert.doesNotMatch(result.last_error, /ghp_secret/);
});

test("projection failure redacts issue progress payload", async () => {
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => new Response("failed", { status: 500 }),
    now: () => "2026-05-30T00:00:00.000Z",
  });

  const result = await adapter.trySyncIssueProgress({
    issueNumber: 5,
    lifecycleState: "running",
    comment: "comment github_pat_SECRETSECRETSECRETSECRETSECRET",
    statusMarkdown: "state github_pat_SECRETSECRETSECRETSECRETSECRET",
  });

  assert.equal(result.status, "failed");
  assert.doesNotMatch(JSON.stringify(result.payload), /github_pat_SECRET/);
  assert.match(JSON.stringify(result.payload), /\[REDACTED\]/);
});

test("projection success redacts issue progress payload", async () => {
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      if (String(url).endsWith("/issues/5") && init?.method === "GET") return jsonResponse({ body: "body" });
      return jsonResponse({});
    },
  });

  const result = await adapter.trySyncIssueProgress({
    issueNumber: 5,
    lifecycleState: "running",
    comment: "comment github_pat_SECRETSECRETSECRETSECRETSECRET",
    statusMarkdown: "state github_pat_SECRETSECRETSECRETSECRETSECRET",
  });

  assert.equal(result.status, "success");
  assert.doesNotMatch(JSON.stringify(result.payload), /github_pat_SECRET/);
  assert.match(JSON.stringify(result.payload), /\[REDACTED\]/);
});

test("issue progress uses fallback label and replaces existing status marker", async () => {
  const patches: unknown[] = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (url, init) => {
      if (String(url).endsWith("/issues/6") && init?.method === "GET") {
        return jsonResponse({ body: "<!-- northstar-status -->\nold\n<!-- /northstar-status -->\n\nbody" });
      }
      if (String(url).endsWith("/issues/6") && init?.method === "PATCH") {
        patches.push(JSON.parse(String(init?.body)));
      }
      return jsonResponse({});
    },
  });

  await adapter.syncIssueProgress({
    issueNumber: 6,
    lifecycleState: "custom_state",
    comment: "custom",
    statusMarkdown: "State: custom_state",
  });

  assert.match(JSON.stringify(patches), /State: custom_state/);
  assert.doesNotMatch(JSON.stringify(patches), /\nold\n/);
});

test("PR progress and skipped project field sync are lifecycle-neutral", async () => {
  const comments: unknown[] = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (_url, init) => {
      comments.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return jsonResponse({});
    },
  });

  await adapter.syncPrProgress({ prNumber: 11, body: "Verifier approved" });
  const skipped = await adapter.syncProjectFields({ issueNumber: 5, lifecycleState: "running" });

  assert.deepEqual(comments, [{ body: "Verifier approved" }]);
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.reason, "github.project.project_id is not configured");
  assert.equal(skipped.mutates_lifecycle, false);
});

test("PR progress formats supplied verifier evidence release readiness and redacts secrets", async () => {
  const comments: Array<{ body: string }> = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (_url, init) => {
      comments.push(JSON.parse(String(init?.body)));
      return jsonResponse({});
    },
  });

  await adapter.syncPrProgress({
    prNumber: 11,
    body: "Verifier approved github_pat_11SECRETSECRETSECRETSECRETSECRETSECRET",
    verifierEvidence: "verifier artifact accepted",
    commandsPassed: ["node tests/orchestrator/inspect.test.ts", "npm test"],
    browserEvidence: "screenshot evidence/browser.png",
    releaseReadiness: "ready after verifier approval",
  });

  const prVerifierEvidenceComments = comments.filter((comment) => comment.body.includes("Verifier Evidence"));
  assert.equal(prVerifierEvidenceComments.length >= 1, true);
  assert.match(comments[0].body, /Commands Passed/);
  assert.match(comments[0].body, /Browser Evidence/);
  assert.match(comments[0].body, /Release Readiness/);
  assert.doesNotMatch(comments[0].body, /github_pat_11SECRET/);
});

test("project field sync calls Project v2 client and returns projection result with metrics", async () => {
  const graphqlRequests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      graphqlRequests.push(body);
      if (body.query.includes("IssueProjectItem")) {
        return jsonResponse({
          data: {
            repository: {
              issue: {
                projectItems: {
                  nodes: [{ id: "PVTI_item_1", project: { id: "PVT_project_1" } }],
                },
              },
            },
          },
        });
      }
      if (body.query.includes("ProjectFields")) {
        return jsonResponse({
          data: {
            node: {
              id: "PVT_project_1",
              fields: {
                nodes: [
                  singleSelectField("F_lifecycle", "Northstar Lifecycle", ["completed"]),
                  singleSelectField("F_status", "Status", ["Done"]),
                  projectField("F_pr", "PR URL", "TEXT"),
                ],
              },
            },
          },
        });
      }
      return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
    },
  });

  const synced = await adapter.syncProjectFields({
    issueNumber: 5,
    projectId: "PVT_project_1",
    lifecycleState: "completed",
    fields: { pr_url: "https://example.test/pr/11" },
  });

  const updates = graphqlRequests.filter((request) => request.query.includes("UpdateProjectField"));

  assert.equal(synced.status, "success");
  assert.equal(synced.projection_target, "github_project");
  assert.equal(synced.mutates_lifecycle, false);
  assert.equal(synced.payload.metrics.github_project_items_synced, 1);
  assert.equal(synced.payload.metrics.github_project_lifecycle_completed, 1);
  assert.equal(synced.payload.metrics.github_project_status_done, 1);
  assert.equal(synced.payload.metrics.github_project_pr_urls_synced, 1);
  assert.deepEqual(updates.map((request) => request.variables.fieldId), ["F_lifecycle", "F_status", "F_pr"]);
  assert.deepEqual(updates[0].variables.value, { singleSelectOptionId: "F_lifecycle_completed" });
  assert.deepEqual(updates[1].variables.value, { singleSelectOptionId: "F_status_Done" });
});

test("project field sync converts Project v2 errors into retryable lifecycle-neutral projection failures", async () => {
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => jsonResponse({ errors: [{ message: "bad token ghp_token" }] }),
    now: () => "2026-05-30T00:00:00.000Z",
  });

  const result = await adapter.syncProjectFields({
    issueNumber: 5,
    projectId: "PVT_project_1",
    lifecycleState: "completed",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.projection_target, "github_project");
  assert.equal(result.mutates_lifecycle, false);
  assert.equal(result.next_retry_at, "2026-05-30T00:01:00.000Z");
  assert.doesNotMatch(result.last_error, /ghp_token/);
});

test("project field sync redacts secret-shaped field values from success projection payloads", async () => {
  const secret = "github_pat_11SECRETSECRETSECRETSECRETSECRETSECRET";
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: fakeProjectFetch({
      fields: [
        singleSelectField("F_lifecycle", "Northstar Lifecycle", ["completed"]),
        singleSelectField("F_status", "Status", ["Done"]),
        projectField("F_pr", "PR URL", "TEXT"),
        projectField("F_error", "Last Error", "TEXT"),
      ],
    }),
  });

  const result = await adapter.syncProjectFields({
    issueNumber: 5,
    projectId: "PVT_project_1",
    lifecycleState: "completed",
    fields: {
      pr_url: "https://example.test/pr/11",
      last_error: `remote failed with ${secret}`,
    },
  });

  const serializedPayload = JSON.stringify(result.payload);
  assert.equal(result.status, "success");
  assert.equal(result.payload.issueNumber, 5);
  assert.equal(result.payload.metrics.github_project_items_synced, 1);
  assert.match(serializedPayload, /https:\/\/example\.test\/pr\/11/);
  assert.doesNotMatch(serializedPayload, new RegExp(secret));
});

test("project field sync redacts secret-shaped field values from failure projection payloads", async () => {
  const secret = "github_pat_22SECRETSECRETSECRETSECRETSECRETSECRET";
  const adapter = new GitHubObservabilityAdapter({
    repo: "owner/repo",
    token: "ghp_token",
    fetch: async () => jsonResponse({ errors: [{ message: "project unavailable" }] }),
    now: () => "2026-05-30T00:00:00.000Z",
  });

  const result = await adapter.syncProjectFields({
    issueNumber: 5,
    projectId: "PVT_project_1",
    lifecycleState: "completed",
    fields: {
      last_error: `worker emitted ${secret}`,
      pr_url: "https://example.test/pr/11",
    },
  });

  const serializedPayload = JSON.stringify(result.payload);
  assert.equal(result.status, "failed");
  assert.equal(result.payload.issueNumber, 5);
  assert.equal(result.payload.lifecycleState, "completed");
  assert.match(serializedPayload, /https:\/\/example\.test\/pr\/11/);
  assert.doesNotMatch(serializedPayload, new RegExp(secret));
});

test("status marker helper appends or replaces status block deterministically", () => {
  assert.match(replaceStatusMarker("body", "State: running"), /^<!-- northstar-status -->/);
  assert.equal(
    replaceStatusMarker("before\n<!-- northstar-status -->\nold\n<!-- /northstar-status -->\nafter", "State: completed"),
    "before\n<!-- northstar-status -->\nState: completed\n<!-- /northstar-status -->\nafter",
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function singleSelectField(id: string, name: string, options: string[]) {
  return {
    __typename: "ProjectV2SingleSelectField",
    id,
    name,
    options: options.map((option) => ({ id: `${id}_${option}`, name: option })),
  };
}

function projectField(id: string, name: string, dataType: string) {
  return {
    __typename: "ProjectV2Field",
    id,
    name,
    dataType,
  };
}

function fakeProjectFetch(input: { fields: unknown[] }): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.query.includes("IssueProjectItem")) {
      return jsonResponse({
        data: {
          repository: {
            issue: {
              projectItems: {
                nodes: [{ id: "PVTI_item_1", project: { id: "PVT_project_1" } }],
              },
            },
          },
        },
      });
    }
    if (body.query.includes("ProjectFields")) {
      return jsonResponse({ data: { node: { id: "PVT_project_1", fields: { nodes: input.fields } } } });
    }
    return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
  };
}

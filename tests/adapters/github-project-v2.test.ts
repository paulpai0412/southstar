import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GitHubProjectV2Client,
  lifecycleStatusByState,
  projectStatusForLifecycle,
} from "../../src/adapters/github/project-v2.ts";

test("exports viewer status mapping for every Northstar lifecycle state", () => {
  assert.deepEqual(lifecycleStatusByState, {
    ready: "Todo",
    claimed: "In Progress",
    running: "In Progress",
    verifying: "In Review",
    verified: "Ready to Release",
    release_pending: "Pending Release Approval",
    releasing: "Releasing",
    completed: "Done",
    cancelled: "Cancelled",
    exception: "Blocked",
    failed: "Failed",
    quarantined: "Blocked",
  });
  assert.deepEqual(projectStatusForLifecycle("verifying"), {
    lifecycle: "verifying",
    status: "In Review",
  });
});

test("syncIssueFields discovers issue item, fields, options, updates fields, and returns metrics", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.github.com/graphql");
      assert.equal(init?.method, "POST");
      assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer ghp_testtoken$/);
      const body = JSON.parse(String(init?.body));
      requests.push(body);

      if (body.query.includes("IssueProjectItem")) {
        return jsonResponse({
          data: {
            repository: {
              issue: {
                projectItems: {
                  nodes: [
                    { id: "PVTI_other", project: { id: "PVT_other" } },
                    { id: "PVTI_item_1", project: { id: "PVT_project_1" } },
                  ],
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
                  singleSelectField("F_lifecycle", "Northstar Lifecycle", ["completed", "running"]),
                  singleSelectField("F_status", "Status", ["Done", "In Progress"]),
                  projectField("F_pr", "PR URL", "TEXT"),
                  projectField("F_sha", "Merge SHA", "TEXT"),
                  projectField("F_stage", "Current Stage", "TEXT"),
                  projectField("F_error", "Last Error", "TEXT"),
                  projectField("F_retry", "Retry Count", "NUMBER"),
                  projectField("F_blocked", "Blocked By", "TEXT"),
                ],
              },
            },
          },
        });
      }

      if (body.query.includes("UpdateProjectField")) {
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
      }

      throw new Error(`unexpected query ${body.query}`);
    },
  });

  const metrics = await client.syncIssueFields({
    issueNumber: 7,
    lifecycle: "completed",
    prUrl: "https://github.com/owner/repo/pull/10",
    mergeSha: "abc123",
    currentStage: "release",
    lastError: "none",
    retryCount: 2,
    blockedBy: "issue-3",
  });

  assert.equal(requests.filter((request) => request.query.includes("IssueProjectItem")).length, 1);
  assert.equal(requests.filter((request) => request.query.includes("ProjectFields")).length, 1);
  assert.equal(requests.filter((request) => request.query.includes("UpdateProjectField")).length, 8);

  const updates = requests.filter((request) => request.query.includes("UpdateProjectField"));
  assert.deepEqual(updates.map((request) => request.variables.fieldId), [
    "F_lifecycle",
    "F_status",
    "F_pr",
    "F_sha",
    "F_stage",
    "F_error",
    "F_retry",
    "F_blocked",
  ]);
  assert.deepEqual(updates[0].variables.value, { singleSelectOptionId: "F_lifecycle_completed" });
  assert.deepEqual(updates[1].variables.value, { singleSelectOptionId: "F_status_Done" });
  assert.deepEqual(updates[6].variables.value, { number: 2 });

  assert.deepEqual(metrics, {
    github_project_items_synced: 1,
    github_project_status_done: 1,
    github_project_lifecycle_completed: 1,
    github_project_pr_urls_synced: 1,
    github_project_merge_shas_synced: 1,
    github_project_status_mismatches: 0,
  });

  await client.syncIssueFields({ issueNumber: 8, lifecycle: "running" });
  assert.equal(requests.filter((request) => request.query.includes("ProjectFields")).length, 1);
});

test("syncIssueFields honors explicit Status override for completed recovery projection", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);

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
                  singleSelectField("F_status", "Status", ["Done", "Blocked"]),
                  projectField("F_error", "Last Error", "TEXT"),
                  projectField("F_blocked", "Blocked By", "TEXT"),
                ],
              },
            },
          },
        });
      }

      if (body.query.includes("UpdateProjectField")) {
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
      }

      throw new Error(`unexpected query ${body.query}`);
    },
  });

  const metrics = await client.syncIssueFields({
    issueNumber: 7,
    lifecycle: "completed",
    fields: {
      Status: "Blocked",
      "Last Error": "sync worktree refresh failed",
      "Blocked By": "sync_worktree",
    },
  });

  const updates = requests.filter((request) => request.query.includes("UpdateProjectField"));
  assert.deepEqual(updates.map((request) => request.variables.fieldId), [
    "F_lifecycle",
    "F_status",
    "F_error",
    "F_blocked",
  ]);
  assert.deepEqual(updates[1]?.variables.value, { singleSelectOptionId: "F_status_Blocked" });
  assert.equal(metrics.github_project_status_done, 0);
  assert.equal(metrics.github_project_lifecycle_completed, 1);
  assert.equal(metrics.github_project_status_mismatches, 0);
});

test("syncIssueFields projects empty recovery fields to clear stale Project errors", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);

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
                  projectField("F_error", "Last Error", "TEXT"),
                  projectField("F_blocked", "Blocked By", "TEXT"),
                ],
              },
            },
          },
        });
      }

      if (body.query.includes("UpdateProjectField")) {
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
      }

      throw new Error(`unexpected query ${body.query}`);
    },
  });

  await client.syncIssueFields({
    issueNumber: 7,
    lifecycle: "completed",
    fields: {
      "Last Error": "",
      "Blocked By": "",
    },
  });

  const updates = requests.filter((request) => request.query.includes("UpdateProjectField"));
  assert.deepEqual(updates.map((request) => request.variables.fieldId), [
    "F_lifecycle",
    "F_status",
    "F_error",
    "F_blocked",
  ]);
  assert.deepEqual(updates[2]?.variables.value, { text: "" });
  assert.deepEqual(updates[3]?.variables.value, { text: "" });
});

test("syncIssueFields adds issue to configured Project when item is missing", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);

      if (body.query.includes("IssueProjectItem")) {
        return jsonResponse({
          data: {
            repository: {
              issue: {
                id: "I_issue_7",
                projectItems: {
                  nodes: [{ id: "PVTI_other", project: { id: "PVT_other" } }],
                },
              },
            },
          },
        });
      }

      if (body.query.includes("AddIssueToProject")) {
        assert.deepEqual(body.variables, {
          projectId: "PVT_project_1",
          contentId: "I_issue_7",
        });
        return jsonResponse({
          data: {
            addProjectV2ItemById: {
              item: { id: "PVTI_added_7" },
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
                  singleSelectField("F_lifecycle", "Northstar Lifecycle", ["running"]),
                  singleSelectField("F_status", "Status", ["In Progress"]),
                ],
              },
            },
          },
        });
      }

      if (body.query.includes("UpdateProjectField")) {
        assert.equal(body.variables.itemId, "PVTI_added_7");
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_added_7" } } } });
      }

      throw new Error(`unexpected query ${body.query}`);
    },
  });

  const metrics = await client.syncIssueFields({ issueNumber: 7, lifecycle: "running" });

  assert.equal(requests.filter((request) => request.query.includes("AddIssueToProject")).length, 1);
  assert.equal(requests.filter((request) => request.query.includes("UpdateProjectField")).length, 2);
  assert.equal(metrics.github_project_items_synced, 1);
});

test("syncIssueFields repairs missing Northstar lifecycle option before projecting cancelled", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let lifecycleOptions = ["ready", "completed"];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);

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
                  singleSelectField("F_lifecycle", "Northstar Lifecycle", lifecycleOptions),
                  singleSelectField("F_status", "Status", ["Todo", "Cancelled", "Done"]),
                ],
              },
            },
          },
        });
      }

      if (body.query.includes("RepairProjectSingleSelectOption")) {
        assert.equal(body.variables.fieldId, "F_lifecycle");
        assert.deepEqual(
          (body.variables.singleSelectOptions as Array<{ name: string }>).map((option) => option.name),
          ["ready", "completed", "cancelled"],
        );
        lifecycleOptions = ["ready", "completed", "cancelled"];
        return jsonResponse({
          data: {
            updateProjectV2Field: {
              projectV2Field: singleSelectField("F_lifecycle", "Northstar Lifecycle", lifecycleOptions),
            },
          },
        });
      }

      if (body.query.includes("UpdateProjectField")) {
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
      }

      throw new Error(`unexpected query ${body.query}`);
    },
  });

  await client.syncIssueFields({ issueNumber: 7, lifecycle: "cancelled" });

  assert.equal(requests.filter((request) => request.query.includes("RepairProjectSingleSelectOption")).length, 1);
  const updates = requests.filter((request) => request.query.includes("UpdateProjectField"));
  assert.deepEqual(updates.map((request) => request.variables.value), [
    { singleSelectOptionId: "F_lifecycle_cancelled" },
    { singleSelectOptionId: "F_status_Cancelled" },
  ]);
});

test("syncIssueFields repairs missing Northstar Status option before projecting cancelled", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let statusOptions = ["Todo", "Done"];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);

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
                  singleSelectField("F_lifecycle", "Northstar Lifecycle", ["ready", "cancelled", "completed"]),
                  singleSelectField("F_status", "Status", statusOptions),
                ],
              },
            },
          },
        });
      }

      if (body.query.includes("RepairProjectSingleSelectOption")) {
        assert.equal(body.variables.fieldId, "F_status");
        assert.deepEqual(
          (body.variables.singleSelectOptions as Array<{ name: string }>).map((option) => option.name),
          ["Todo", "Done", "Cancelled"],
        );
        statusOptions = ["Todo", "Done", "Cancelled"];
        return jsonResponse({
          data: {
            updateProjectV2Field: {
              projectV2Field: singleSelectField("F_status", "Status", statusOptions),
            },
          },
        });
      }

      if (body.query.includes("UpdateProjectField")) {
        return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
      }

      throw new Error(`unexpected query ${body.query}`);
    },
  });

  await client.syncIssueFields({ issueNumber: 7, lifecycle: "cancelled" });

  assert.equal(requests.filter((request) => request.query.includes("RepairProjectSingleSelectOption")).length, 1);
  const updates = requests.filter((request) => request.query.includes("UpdateProjectField"));
  assert.deepEqual(updates.map((request) => request.variables.value), [
    { singleSelectOptionId: "F_lifecycle_cancelled" },
    { singleSelectOptionId: "F_status_Cancelled" },
  ]);
});

test("syncIssueFields supports GitHub default Status casing and Northstar field aliases", async () => {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_testtoken",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);

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
                  singleSelectField("F_lifecycle", "Northstar Lifecycle", ["running", "completed"]),
                  singleSelectField("F_status", "Status", ["Backlog", "Ready", "In progress", "In review", "Done"]),
                  projectField("F_pr", "Northstar PR", "TEXT"),
                  projectField("F_sha", "Northstar Merge SHA", "TEXT"),
                ],
              },
            },
          },
        });
      }

      return jsonResponse({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_item_1" } } } });
    },
  });

  await client.syncIssueFields({
    issueNumber: 7,
    lifecycle: "running",
    prUrl: "https://github.com/owner/repo/pull/10",
    mergeSha: "abc123",
  });

  const updates = requests.filter((request) => request.query.includes("UpdateProjectField"));
  assert.deepEqual(updates.map((request) => request.variables.fieldId), [
    "F_lifecycle",
    "F_status",
    "F_pr",
    "F_sha",
  ]);
  assert.deepEqual(updates[1].variables.value, { singleSelectOptionId: "F_status_In progress" });
  assert.deepEqual(updates[2].variables.value, { text: "https://github.com/owner/repo/pull/10" });
  assert.deepEqual(updates[3].variables.value, { text: "abc123" });
});

test("syncIssueFields throws clear redacted errors for missing options and GraphQL failures", async () => {
  const missingOptionClient = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_secret_token",
    fetch: fakeProjectFetch({
      fields: [
        singleSelectField("F_lifecycle", "Northstar Lifecycle", ["completed"]),
        singleSelectField("F_status", "Status", ["In Progress"]),
      ],
    }),
  });

  await assert.rejects(
    () => missingOptionClient.syncIssueFields({ issueNumber: 7, lifecycle: "completed" }),
    (error: unknown) => {
      assert.match(String(error), /missing option "Done" for Project field "Status"/);
      assert.doesNotMatch(String(error), /ghp_secret_token/);
      return true;
    },
  );

  const graphqlFailureClient = new GitHubProjectV2Client({
    repo: "owner/repo",
    projectId: "PVT_project_1",
    token: "ghp_secret_token",
    fetch: async () => jsonResponse({ errors: [{ message: "bad credentials ghp_secret_token" }] }),
  });

  await assert.rejects(
    () => graphqlFailureClient.syncIssueFields({ issueNumber: 7, lifecycle: "completed" }),
    (error: unknown) => {
      assert.match(String(error), /GitHub Project GraphQL failed/);
      assert.doesNotMatch(String(error), /ghp_secret_token/);
      return true;
    },
  );
});

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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

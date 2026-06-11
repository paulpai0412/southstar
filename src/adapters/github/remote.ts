import { projectionFailureEvent } from "./projector.ts";
import { redactSecrets } from "../../runtime/redaction.ts";

export interface GitHubRemoteProjectionAdapterOptions {
  repo: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => string;
  retryDelaySeconds?: number;
}

export class GitHubRemoteProjectionAdapter {
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly retryDelaySeconds: number;

  constructor(options: GitHubRemoteProjectionAdapterOptions) {
    this.repo = options.repo;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.retryDelaySeconds = options.retryDelaySeconds ?? 60;
  }

  async syncLabel(input: { issue_number: number; labels: string[] }) {
    return this.requestProjection("label", `/issues/${input.issue_number}/labels`, "POST", {
      labels: input.labels,
    }, input);
  }

  async syncBodyComment(input: { issue_number: number; body: string }) {
    return this.requestProjection("body_comment", `/issues/${input.issue_number}/comments`, "POST", {
      body: input.body,
    }, input);
  }

  async closeIssue(input: { issue_number: number }) {
    return this.requestProjection("issue_close", `/issues/${input.issue_number}`, "PATCH", {
      state: "closed",
    }, input);
  }

  async syncProject(input: { issue_number: number; project_id?: string }) {
    if (!input.project_id) {
      return {
        type: "projection_skipped",
        projection_target: "project",
        status: "skipped",
        reason: "NORTHSTAR_LIVE_GITHUB_PROJECT_ID is not configured",
        payload: input,
      };
    }

    const issueResponse = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/issues/${input.issue_number}`, {
      method: "GET",
      headers: this.githubHeaders(),
    });
    if (!issueResponse.ok) {
      const responseText = redactSecrets(await issueResponse.text());
      return this.projectionFailure(
        "project",
        `GitHub project issue discovery failed with ${issueResponse.status}: ${responseText}`,
        { payload: input },
      );
    }

    const issue = await issueResponse.json() as { node_id?: string };
    if (!issue.node_id) {
      return this.projectionFailure("project", "GitHub project issue discovery did not return node_id", { payload: input });
    }

    const graphqlResponse = await this.fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: this.githubHeaders(),
      body: JSON.stringify({
        query: `
          mutation AddProjectV2Item($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
              item {
                id
              }
            }
          }
        `,
        variables: {
          projectId: input.project_id,
          contentId: issue.node_id,
        },
      }),
    });
    if (!graphqlResponse.ok) {
      const responseText = redactSecrets(await graphqlResponse.text());
      return this.projectionFailure(
        "project",
        `GitHub project sync failed with ${graphqlResponse.status}: ${responseText}`,
        { payload: input },
      );
    }

    const graphqlResult = await graphqlResponse.json() as {
      data?: { addProjectV2ItemById?: { item?: { id?: string } } };
      errors?: Array<{ message?: string }>;
    };
    if (graphqlResult.errors?.length) {
      return this.projectionFailure(
        "project",
        redactSecrets(`GitHub project sync failed: ${graphqlResult.errors.map((error) => error.message ?? "unknown GraphQL error").join("; ")}`),
        { payload: input },
      );
    }

    const projectItemId = graphqlResult.data?.addProjectV2ItemById?.item?.id;
    return {
      type: "projection_result",
      projection_target: "project",
      status: "success",
      payload: {
        ...input,
        ...(projectItemId ? { project_item_id: projectItemId } : {}),
      },
    };
  }

  private async requestProjection(
    projectionTarget: string,
    path: string,
    method: string,
    body: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: this.githubHeaders(),
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return {
        type: "projection_result",
        projection_target: projectionTarget,
        status: "success",
        payload,
      };
    }

    const responseText = redactSecrets(await response.text());
    return this.projectionFailure(
      projectionTarget,
      `GitHub ${projectionTarget.replace("_", " ")} sync failed with ${response.status}: ${responseText}`,
      { payload },
    );
  }

  private githubHeaders() {
    return {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${this.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }

  private projectionFailure(
    projectionTarget: string,
    lastError: string,
    options: { payload: Record<string, unknown> },
  ) {
    return projectionFailureEvent(
      projectionTarget,
      redactSecrets(lastError),
      addSeconds(this.now(), this.retryDelaySeconds),
      options,
    );
  }
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

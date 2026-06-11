import { redactSecrets } from "../../runtime/redaction.ts";
import type { SoftwareDevGitHubGateway } from "../../orchestrator/software-dev-driver.ts";

interface GatewayOptions {
  repo: string;
  token: string;
  fetch?: typeof fetch;
}

interface GitHubPullRequest {
  number: number;
  html_url: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string | null } | null;
}

export type PullRequestMergeErrorCode =
  | "PR_MERGE_CONFLICT"
  | "PR_NOT_MERGEABLE_YET"
  | "PR_MERGE_PERMISSION_DENIED"
  | "PR_MERGE_UNKNOWN_FAILURE";

export class PullRequestMergeError extends Error {
  readonly code: PullRequestMergeErrorCode;
  readonly status: number;

  constructor(code: PullRequestMergeErrorCode, message: string, status: number) {
    super(message);
    this.name = "PullRequestMergeError";
    this.code = code;
    this.status = status;
  }
}

export class GitHubSoftwareDevGateway implements SoftwareDevGitHubGateway {
  private readonly options: GatewayOptions;

  constructor(options: GatewayOptions) {
    this.options = options;
  }

  async createOrReusePullRequest(input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<GitHubPullRequest & { reused: boolean }> {
    const existing = await this.request<GitHubPullRequest[]>(
      `/pulls?state=open&head=${encodeURIComponent(repoOwner(this.options.repo) + ":" + input.head)}&base=${encodeURIComponent(input.base)}`,
      "GET",
    );
    if (existing[0]) return { ...existing[0], reused: true };

    const created = await this.request<GitHubPullRequest>("/pulls", "POST", input);
    return { ...created, reused: false };
  }

  async createPullRequest(input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<GitHubPullRequest> {
    return await this.createOrReusePullRequest(input);
  }

  async mergePullRequest(input: { number: number; commit_title: string }): Promise<{ merged: boolean; sha: string }> {
    const response = await this.githubFetch(`/pulls/${input.number}/merge`, "PUT", {
      commit_title: input.commit_title,
      merge_method: "squash",
    });
    if (!response.ok) {
      const text = redactTokenShapes(await response.text());
      throw new PullRequestMergeError(classifyMergeError(response.status, text), mergeErrorMessage(response.status, text), response.status);
    }
    const result = await response.json() as { merged?: boolean; sha?: string };
    if (result.merged === true && !result.sha) {
      throw new Error("MERGE_SHA_MISSING");
    }
    return { merged: result.merged === true, sha: result.sha ?? "" };
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.request(`/issues/${issueNumber}`, "PATCH", { state: "closed" });
  }

  async findMergedPullRequestForIssue(input: {
    issueNumber: number;
    branch: string;
    base: string;
  }): Promise<{ number: number; html_url: string; merge_commit_sha?: string; head_sha?: string } | undefined> {
    const issue = await this.request<{ state?: string }>(`/issues/${input.issueNumber}`, "GET");
    const existing = await this.request<GitHubPullRequest[]>(
      `/pulls?state=closed&head=${encodeURIComponent(repoOwner(this.options.repo) + ":" + input.branch)}&base=${encodeURIComponent(input.base)}`,
      "GET",
    );
    const merged = existing.find((pr) => pr.merged_at && pr.merge_commit_sha);
    if (!merged && issue.state !== "closed") {
      return undefined;
    }
    if (!merged) {
      return undefined;
    }
    return {
      number: merged.number,
      html_url: merged.html_url,
      merge_commit_sha: merged.merge_commit_sha ?? undefined,
      head_sha: merged.head?.sha ?? undefined,
    };
  }

  async readBranchCommit(input: { branch: string }): Promise<{ branch: string; commit_sha: string }> {
    const ref = await this.request<{ object?: { sha?: string } }>(`/git/ref/heads/${encodeURI(input.branch)}`, "GET");
    return { branch: input.branch, commit_sha: ref.object?.sha ?? "" };
  }

  async createFixtureBranch(input: {
    branch: string;
    base: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ branch: string; commit_sha: string }> {
    const existing = await this.readBranchCommit({ branch: input.branch }).catch(() => undefined);
    if (existing?.commit_sha) return existing;

    const base = await this.readBranchCommit({ branch: input.base });
    await this.request("/git/refs", "POST", {
      ref: `refs/heads/${input.branch}`,
      sha: base.commit_sha,
    });
    const content = btoa(input.content);
    const result = await this.request<{ commit?: { sha?: string } }>(
      `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
      "PUT",
      { message: input.message, content, branch: input.branch },
    );
    return { branch: input.branch, commit_sha: result.commit?.sha ?? base.commit_sha };
  }

  async addIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/issues/${issueNumber}/comments`, "POST", { body });
  }

  async updateIssueLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.request(`/issues/${issueNumber}/labels`, "POST", { labels });
  }

  private async request<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
    const response = await this.githubFetch(path, method, body);
    if (!response.ok) {
      throw new Error(`GitHub software-dev gateway failed with ${response.status}: ${redactTokenShapes(await response.text())}`);
    }
    return await response.json() as T;
  }

  private async githubFetch(path: string, method: string, body?: unknown): Promise<Response> {
    return await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${this.options.repo}${path}`, {
      method,
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.options.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

function classifyMergeError(status: number, text: string): PullRequestMergeErrorCode {
  if (status === 409) return "PR_MERGE_CONFLICT";
  if (status === 403) return "PR_MERGE_PERMISSION_DENIED";
  if (status === 405 && /conflict|dirty|merge conflict|cannot be automatically merged/i.test(text)) return "PR_MERGE_CONFLICT";
  if (status === 405 && /not mergeable|mergeable state/i.test(text)) return "PR_NOT_MERGEABLE_YET";
  return "PR_MERGE_UNKNOWN_FAILURE";
}

function mergeErrorMessage(status: number, text: string): string {
  return `GitHub pull request merge failed with ${status}: ${text}`;
}

function repoOwner(repo: string): string {
  return repo.split("/")[0] ?? repo;
}

function redactTokenShapes(value: string): string {
  return redactSecrets(value).replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}

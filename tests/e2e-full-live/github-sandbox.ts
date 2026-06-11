import { redactSecrets } from "../../src/runtime/redaction.ts";

export interface GitHubSandboxClientOptions {
  repo: string;
  token: string;
  fetch?: typeof fetch;
}

export interface SandboxIssue {
  number: number;
  html_url: string;
  node_id?: string;
}

export interface SandboxPullRequest {
  number: number;
  html_url: string;
}

export interface SandboxIssueComment {
  html_url: string;
}

export class GitHubSandboxClient {
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubSandboxClientOptions) {
    this.repo = options.repo;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createIssue(input: { title: string; body: string }): Promise<SandboxIssue> {
    return await this.request(`/issues`, "POST", input);
  }

  async readIssue(number: number): Promise<SandboxIssue & { state?: string }> {
    return await this.request(`/issues/${number}`, "GET");
  }

  async addLabels(number: number, labels: string[]): Promise<void> {
    await this.request(`/issues/${number}/labels`, "POST", { labels });
  }

  async createFixtureBranch(input: {
    branch: string;
    base: string;
    path: string;
    content: string;
    message: string;
  }): Promise<{ branch: string; commit_sha: string }> {
    const baseRef = await this.readBaseRef(input.base);
    const baseTree = await this.request<{ sha: string }>(`/git/trees/${baseRef.object.sha}`, "GET");
    const blob = await this.request<{ sha: string }>(`/git/blobs`, "POST", {
      content: Buffer.from(input.content, "utf8").toString("base64"),
      encoding: "base64",
    });
    const tree = await this.request<{ sha: string }>(`/git/trees`, "POST", {
      base_tree: baseTree.sha,
      tree: [{ path: input.path, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await this.request<{ sha: string }>(`/git/commits`, "POST", {
      message: input.message,
      tree: tree.sha,
      parents: [baseRef.object.sha],
    });
    await this.request(`/git/refs`, "POST", {
      ref: `refs/heads/${input.branch}`,
      sha: commit.sha,
    });
    return { branch: input.branch, commit_sha: commit.sha };
  }

  async readBranchCommit(input: { branch: string }): Promise<{ branch: string; commit_sha: string }> {
    const ref = await this.request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(input.branch)}`, "GET");
    return { branch: input.branch, commit_sha: ref.object.sha };
  }

  private async readBaseRef(base: string): Promise<{ object: { sha: string } }> {
    try {
      return await this.request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(base)}`, "GET");
    } catch (error) {
      if (!isEmptyRepositoryError(error)) {
        throw error;
      }
      await this.initializeEmptyRepository(base);
      return await this.request<{ object: { sha: string } }>(`/git/ref/heads/${encodeURIComponent(base)}`, "GET");
    }
  }

  private async initializeEmptyRepository(base: string): Promise<void> {
    await this.request(`/contents/README.md`, "PUT", {
      message: "Initialize northstar live sandbox",
      content: Buffer.from("# Northstar live sandbox\n", "utf8").toString("base64"),
      branch: base,
    });
  }

  async createPullRequest(input: { title: string; head: string; base: string; body: string }): Promise<SandboxPullRequest> {
    return await this.request(`/pulls`, "POST", input);
  }

  async listPullRequests(input: { head: string; base: string; state?: "open" | "closed" | "all" }): Promise<SandboxPullRequest[]> {
    return await this.request(
      `/pulls?state=${input.state ?? "all"}&head=${encodeURIComponent(this.repo.split("/")[0] + ":" + input.head)}&base=${encodeURIComponent(input.base)}`,
      "GET",
    );
  }

  async listPullRequestFiles(number: number): Promise<Array<{ filename: string }>> {
    return await this.request(`/pulls/${number}/files`, "GET");
  }

  async readFileContent(input: { path: string; ref: string }): Promise<string> {
    const encodedPath = encodeURIComponent(input.path);
    const result = await this.request<{ content?: string }>(`/contents/${encodedPath}?ref=${encodeURIComponent(input.ref)}`, "GET");
    return Buffer.from((result.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
  }

  async mergePullRequest(input: { number: number; commit_title: string }): Promise<{ merged: boolean; sha: string }> {
    return await this.request(`/pulls/${input.number}/merge`, "PUT", {
      commit_title: input.commit_title,
      merge_method: "squash",
    });
  }

  async closeIssue(number: number): Promise<{ state?: string }> {
    return await this.request(`/issues/${number}`, "PATCH", { state: "closed" });
  }

  async addIssueComment(number: number, body: string): Promise<SandboxIssueComment> {
    return await this.request(`/issues/${number}/comments`, "POST", { body });
  }

  private async request<T = Record<string, unknown>>(path: string, method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new Error(`GitHub sandbox request ${method} ${path} failed with ${response.status}: ${redactSecrets(await response.text())}`);
    }
    return await response.json() as T;
  }

  private headers() {
    return {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${this.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }
}

function isEmptyRepositoryError(error: unknown): boolean {
  return error instanceof Error && /failed with 409: .*Git Repository is empty/i.test(error.message);
}

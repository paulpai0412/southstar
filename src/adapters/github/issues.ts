import { redactSecrets } from "../../runtime/redaction.ts";

export interface GitHubReadyIssue {
  issueId: string;
  number: number;
  title: string;
  body: string;
  sourceUrl: string;
  labels: string[];
  state?: "open" | "closed" | string;
  stateReason?: string | null;
  closedAt?: string | null;
  dependencies: number[];
  dependencyDiscovery: DependencyDiscovery;
}

export interface DependencyDiscovery {
  markerDependencies: number[];
  nativeLinkedIssueDependencies: number[];
  nativeLinkedIssueDependenciesDiscovered: number;
  duplicatesRemoved: number;
  nativeLinkedIssueApiFailureRetryable: number;
  nativeLinkedIssueApiFailureDoesNotFailLifecycle: 1;
  warning?: string;
}

interface GitHubApiIssue {
  number: number;
  title: string;
  body?: string | null;
  html_url: string;
  state?: string;
  state_reason?: string | null;
  closed_at?: string | null;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

export class GitHubIssueIntakeAdapter {
  private readonly repo: string;
  private readonly token: string;
  private readonly readyLabel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    repo: string;
    token: string;
    readyLabel: string;
    fetch?: typeof fetch;
  }) {
    this.repo = options.repo;
    this.token = options.token;
    this.readyLabel = options.readyLabel;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listReadyIssues(): Promise<GitHubReadyIssue[]> {
    const issues = await this.request<GitHubApiIssue[]>("/issues?state=open&per_page=100");
    return issues
      .filter((item) => item.pull_request === undefined)
      .filter((item) => item.labels.some((label) => label.name === this.readyLabel))
      .map((item) => this.normalize(item))
      .sort((a, b) => a.number - b.number);
  }

  async readIssue(number: number): Promise<GitHubReadyIssue> {
    return await this.enrichIssueDependencies(this.normalize(await this.request<GitHubApiIssue>(`/issues/${number}`)));
  }

  async readIssueState(number: number): Promise<{
    number: number;
    state: "open" | "closed" | string;
    stateReason?: string | null;
    closedAt?: string | null;
    labels: string[];
  }> {
    const issue = await this.request<GitHubApiIssue>(`/issues/${number}`);
    return {
      number: issue.number,
      state: issue.state ?? "open",
      ...(issue.state_reason === undefined ? {} : { stateReason: issue.state_reason }),
      ...(issue.closed_at === undefined ? {} : { closedAt: issue.closed_at }),
      labels: issue.labels.map((label) => label.name),
    };
  }

  private normalize(item: GitHubApiIssue): GitHubReadyIssue {
    const body = item.body ?? "";
    const markerDependencies = parseIssueDependencies(body);
    return {
      issueId: `github:${item.number}`,
      number: item.number,
      title: item.title,
      body,
      sourceUrl: item.html_url,
      labels: item.labels.map((label) => label.name),
      ...(item.state === undefined ? {} : { state: item.state }),
      ...(item.state_reason === undefined ? {} : { stateReason: item.state_reason }),
      ...(item.closed_at === undefined ? {} : { closedAt: item.closed_at }),
      dependencies: markerDependencies,
      dependencyDiscovery: {
        markerDependencies,
        nativeLinkedIssueDependencies: [],
        nativeLinkedIssueDependenciesDiscovered: 0,
        duplicatesRemoved: 0,
        nativeLinkedIssueApiFailureRetryable: 0,
        nativeLinkedIssueApiFailureDoesNotFailLifecycle: 1,
      },
    };
  }

  private async enrichIssueDependencies(issue: GitHubReadyIssue): Promise<GitHubReadyIssue> {
    const native = await this.discoverNativeLinkedDependencies(issue.number);
    const dependencies = [...new Set([...issue.dependencyDiscovery.markerDependencies, ...native.dependencies])].sort((a, b) => a - b);
    const duplicatesRemoved = issue.dependencyDiscovery.markerDependencies.length + native.dependencies.length - dependencies.length;
    return {
      ...issue,
      dependencies,
      dependencyDiscovery: {
        markerDependencies: issue.dependencyDiscovery.markerDependencies,
        nativeLinkedIssueDependencies: native.dependencies,
        nativeLinkedIssueDependenciesDiscovered: native.dependencies.length,
        duplicatesRemoved,
        nativeLinkedIssueApiFailureRetryable: native.apiFailureRetryable,
        nativeLinkedIssueApiFailureDoesNotFailLifecycle: 1,
        ...(native.warning === undefined ? {} : { warning: native.warning }),
      },
    };
  }

  private async discoverNativeLinkedDependencies(issueNumber: number): Promise<{
    dependencies: number[];
    warning?: string;
    apiFailureRetryable: number;
  }> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/issues/${issueNumber}/timeline?per_page=100`, {
      method: "GET",
      headers: {
        "accept": "application/vnd.github.mockingbird-preview+json",
        "authorization": `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });

    if (!response.ok) {
      return {
        dependencies: [],
        warning: `native linked issue discovery failed with ${response.status}: ${redactGitHubWarning(await response.text())}`,
        apiFailureRetryable: 1,
      };
    }

    const events = await response.json();
    return {
      dependencies: Array.isArray(events) ? parseNativeLinkedIssueEvents(events as Array<Record<string, unknown>>) : [],
      apiFailureRetryable: 0,
    };
  }

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method: "GET",
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub issue intake failed with ${response.status}: ${redactSecrets(await response.text())}`);
    }
    return await response.json() as T;
  }
}

export function parseIssueDependencies(body: string): number[] {
  const result = new Set<number>();
  const dependencyPattern = /(?:Depends-On|Blocked-By):\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
  for (const match of body.matchAll(dependencyPattern)) {
    result.add(Number(match[1]));
  }
  const taskListPattern = /-\s+\[[ xX]\]\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/g;
  for (const match of body.matchAll(taskListPattern)) {
    result.add(Number(match[1]));
  }
  return [...result].sort((a, b) => a - b);
}

export function parseNativeLinkedIssueEvents(events: Array<Record<string, unknown>>): number[] {
  const result = new Set<number>();
  for (const event of events) {
    const source = event.source as { issue?: { number?: unknown } } | undefined;
    const number = source?.issue?.number;
    if (typeof number === "number" && Number.isInteger(number)) {
      result.add(number);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function redactGitHubWarning(value: string): string {
  return redactSecrets(value).replace(/\b(?:ghp|gho|github_pat|sk|xoxb|xoxp)_[^\s]+/g, "[REDACTED]");
}

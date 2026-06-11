import { redactSecrets } from "../../runtime/redaction.ts";
import { projectionFailureEvent } from "./projector.ts";
import { GitHubProjectV2Client } from "./project-v2.ts";

export interface GitHubObservabilityAdapterOptions {
  repo: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => string;
  retryDelaySeconds?: number;
}

export class GitHubObservabilityAdapter {
  private readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => string;
  private readonly retryDelaySeconds: number;
  private readonly projectClients = new Map<string, GitHubProjectV2Client>();

  constructor(options: GitHubObservabilityAdapterOptions) {
    this.repo = options.repo;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.retryDelaySeconds = options.retryDelaySeconds ?? 60;
  }

  async syncIssueProgress(input: {
    issueNumber: number;
    lifecycleState: string;
    blockedBy?: string[];
    comment: string;
    statusMarkdown: string;
    progressSignificance?: "transition" | "retryable_failure" | "routine";
  }): Promise<void> {
    const label = progressLabel(input.lifecycleState, input.blockedBy);
    await this.removeStaleLifecycleLabels(input.issueNumber, label);
    await this.request(`/issues/${input.issueNumber}/labels`, "POST", { labels: [label] });
    if (shouldCreateProgressComment(input.progressSignificance)) {
      await this.request(`/issues/${input.issueNumber}/comments`, "POST", { body: redactShortTokens(input.comment) });
    }
    await this.upsertIssueStatusMarker(input.issueNumber, input.statusMarkdown);
  }

  private async removeStaleLifecycleLabels(issueNumber: number, targetLabel: string): Promise<void> {
    const labelsResult = await this.request<unknown>(`/issues/${issueNumber}/labels`, "GET");
    const labels = Array.isArray(labelsResult) ? labelsResult as Array<{ name?: string }> : [];
    const lifecycleLabels = new Set(Object.values(stateLabel));
    for (const label of labels) {
      const name = label.name;
      if (!name || name === targetLabel || !lifecycleLabels.has(name)) continue;
      await this.request(`/issues/${issueNumber}/labels/${encodeURIComponent(name)}`, "DELETE");
    }
  }

  private async upsertIssueStatusMarker(issueNumber: number, statusMarkdown: string): Promise<void> {
    const issue = await this.request<{ body?: string | null }>(`/issues/${issueNumber}`, "GET");
    await this.request(`/issues/${issueNumber}`, "PATCH", {
      body: replaceStatusMarker(issue.body ?? "", redactShortTokens(statusMarkdown)),
    });
  }

  async trySyncIssueProgress(input: {
    issueNumber: number;
    lifecycleState: string;
    blockedBy?: string[];
    comment: string;
    statusMarkdown: string;
  }) {
    try {
      await this.syncIssueProgress(input);
      return {
        type: "projection_result",
        projection_target: "github_observability",
        status: "success",
        mutates_lifecycle: false,
        payload: redactedIssueProgressPayload(input),
      };
    } catch (error) {
      return {
        ...projectionFailureEvent(
          "github_observability",
          redactShortTokens(error instanceof Error ? error.message : String(error)),
          addSeconds(this.now(), this.retryDelaySeconds),
          { payload: redactedIssueProgressPayload(input) },
        ),
        mutates_lifecycle: false,
      };
    }
  }

  async syncPrProgress(input: {
    prNumber: number;
    body: string;
    verifierEvidence?: string;
    commandsPassed?: string[];
    browserEvidence?: string;
    releaseReadiness?: string;
  }): Promise<void> {
    await this.request(`/issues/${input.prNumber}/comments`, "POST", { body: formatPrProgressComment(input) });
  }

  async syncProjectFields(input: {
    issueNumber: number;
    lifecycleState: string;
    projectId?: string;
    fields?: Record<string, unknown>;
  }) {
    if (!input.projectId) {
      return {
        type: "projection_skipped",
        projection_target: "github_project",
        status: "skipped",
        reason: "github.project.project_id is not configured",
        mutates_lifecycle: false,
        payload: redactedProjectionPayload(input),
      };
    }
    try {
      const metrics = await this.projectClient(input.projectId).syncIssueFields({
        issueNumber: input.issueNumber,
        lifecycle: input.lifecycleState,
        fields: input.fields,
      });
      return {
        type: "projection_result",
        projection_target: "github_project",
        status: "success",
        mutates_lifecycle: false,
        payload: redactedProjectionPayload(input, metrics),
      };
    } catch (error) {
      return {
        ...projectionFailureEvent(
          "github_project",
          redactShortTokens(error instanceof Error ? error.message : String(error)),
          addSeconds(this.now(), this.retryDelaySeconds),
          { payload: redactedProjectionPayload(input) },
        ),
        mutates_lifecycle: false,
      };
    }
  }

  private async request<T = unknown>(path: string, method: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: this.githubHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`GitHub observability failed with ${response.status}: ${redactShortTokens(await response.text())}`);
    }
    return await response.json() as T;
  }

  private githubHeaders() {
    return {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${this.token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    };
  }

  private projectClient(projectId: string): GitHubProjectV2Client {
    const existing = this.projectClients.get(projectId);
    if (existing) {
      return existing;
    }
    const client = new GitHubProjectV2Client({
      repo: this.repo,
      projectId,
      token: this.token,
      fetch: this.fetchImpl,
    });
    this.projectClients.set(projectId, client);
    return client;
  }
}

export const stateLabel: Record<string, string> = {
  ready: "northstar:ready",
  blocked: "northstar:blocked",
  claimed: "northstar:claimed",
  running: "northstar:running",
  verifying: "northstar:verifying",
  verified: "northstar:verified",
  release_pending: "northstar:release-pending",
  releasing: "northstar:releasing",
  completed: "northstar:completed",
  quarantined: "northstar:quarantined",
  failed: "northstar:failed",
};

function progressLabel(lifecycleState: string, blockedBy: string[] | undefined): string {
  return blockedBy && blockedBy.length > 0 ? stateLabel.blocked : stateLabel[lifecycleState] ?? `northstar:${lifecycleState}`;
}

export function replaceStatusMarker(body: string, markdown: string): string {
  const marker = `<!-- northstar-status -->\n${markdown}\n<!-- /northstar-status -->`;
  const pattern = /<!-- northstar-status -->[\s\S]*?<!-- \/northstar-status -->/;
  return pattern.test(body) ? body.replace(pattern, marker) : `${marker}\n\n${body}`;
}

function shouldCreateProgressComment(significance: "transition" | "retryable_failure" | "routine" | undefined): boolean {
  return significance !== "routine";
}

function formatPrProgressComment(input: {
  body: string;
  verifierEvidence?: string;
  commandsPassed?: string[];
  browserEvidence?: string;
  releaseReadiness?: string;
}): string {
  const sections = [input.body];
  if (input.verifierEvidence) {
    sections.push(`Verifier Evidence\n${input.verifierEvidence}`);
  }
  if (input.commandsPassed?.length) {
    sections.push(`Commands Passed\n${input.commandsPassed.map((command) => `- ${command}`).join("\n")}`);
  }
  if (input.browserEvidence) {
    sections.push(`Browser Evidence\n${input.browserEvidence}`);
  }
  if (input.releaseReadiness) {
    sections.push(`Release Readiness\n${input.releaseReadiness}`);
  }
  return redactShortTokens(sections.join("\n\n"));
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function redactShortTokens(value: string): string {
  return redactSecrets(value).replace(/\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]+\b/g, "[REDACTED]");
}

function redactedProjectionPayload(
  input: {
    issueNumber: number;
    lifecycleState: string;
    projectId?: string;
    fields?: Record<string, unknown>;
  },
  metrics?: Record<string, number>,
): Record<string, unknown> {
  return redactSecrets({
    ...input,
    ...(metrics === undefined ? {} : { metrics }),
  });
}

function redactedIssueProgressPayload(input: {
  issueNumber: number;
  lifecycleState: string;
  blockedBy?: string[];
  comment: string;
  statusMarkdown: string;
}): Record<string, unknown> {
  return redactSecrets(input);
}

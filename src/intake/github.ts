import type { IssuePacket } from "./types.ts";
import {
  mergeDependencySources,
  nativeDependencyFailureWarning,
  parseIssueDependencyMetadata,
  type DependencySource,
  type RetryableIntakeWarning,
} from "../orchestrator/dependencies.ts";

export interface NativeDependencyDiscoveryInput {
  issueNumber: number;
  repo: string;
  body: string;
}

export interface GitHubIssueIntakeAdapterOptions {
  repo: string;
  token: string;
  fetch?: typeof fetch;
  baseBranch?: string;
  discoverNativeDependencies?: (input: NativeDependencyDiscoveryInput) => Promise<DependencySource[]>;
}

export class GitHubIssueIntakeAdapter {
  private readonly options: GitHubIssueIntakeAdapterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly baseBranch: string;

  constructor(options: GitHubIssueIntakeAdapterOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseBranch = options.baseBranch ?? "main";
  }

  async listIssuePackets(): Promise<IssuePacket[]> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.options.repo}/issues?state=open`, {
      headers: {
        "accept": "application/vnd.github+json",
        "authorization": `Bearer ${this.options.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub issue intake failed with ${response.status}: ${await response.text()}`);
    }
    const issues = await response.json() as Array<{
      number: number;
      title: string;
      html_url: string;
      body?: string | null;
      labels?: Array<{ name?: string }>;
    }>;
    return await Promise.all(issues.map(async (issue) => {
      const body = issue.body ?? "";
      const markers = markerDependenciesFromBody(body);
      const native = tasklistDependenciesFromBody(body);
      const warnings: RetryableIntakeWarning[] = [];

      if (this.options.discoverNativeDependencies) {
        try {
          native.push(...await this.options.discoverNativeDependencies({
            issueNumber: issue.number,
            repo: this.options.repo,
            body,
          }));
        } catch (error) {
          warnings.push(nativeDependencyFailureWarning({
            issueNumber: issue.number,
            message: error instanceof Error ? error.message : String(error),
          }));
        }
      }

      const discovery = mergeDependencySources({ markers, native });
      const packet: IssuePacket & {
        dependency_discovery?: typeof discovery;
        intake_warnings?: RetryableIntakeWarning[];
      } = {
        issue_number: String(issue.number),
        title: issue.title,
        source: "github",
        source_url: issue.html_url,
        branch: `northstar/issue-${issue.number}`,
        base_branch: this.baseBranch,
        labels: (issue.labels ?? []).map((label) => String(label.name ?? "")).filter(Boolean),
        dependencies: discovery.dependencies.map((dependency) => String(dependency.issue)),
        raw_text: body,
        ready_for_agent: true,
      };
      if (discovery.dependencies.length > 0) packet.dependency_discovery = discovery;
      if (warnings.length > 0) packet.intake_warnings = warnings;
      return packet;
    }));
  }
}

function markerDependenciesFromBody(body: string): DependencySource[] {
  const metadata = parseIssueDependencyMetadata(body);
  if (metadata.source === "none") return [];
  return metadata.dependsOn.map((issue) => ({ issue, source: metadata.source }));
}

function tasklistDependenciesFromBody(body: string): DependencySource[] {
  const dependencies: DependencySource[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[[ xX]\]\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)\b/);
    if (!match) continue;
    dependencies.push({ issue: Number(match[1]), source: "tasklist" });
  }
  return dependencies;
}

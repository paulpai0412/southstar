export interface IssueDependencyMetadata {
  dependsOn: number[];
  priority: number;
  source: "frontmatter" | "text" | "none";
}

export interface DependencySource {
  issue: number;
  source: string;
}

export interface MergedDependency {
  issue: number;
  sources: string[];
}

export interface DependencyMergeMetrics {
  native_dependencies_discovered: number;
  marker_dependencies_merged: number;
  dependency_duplicates_removed: number;
}

export interface RetryableIntakeWarning {
  event_type: "intake_warning_retryable";
  payload: {
    issue_number: number;
    message: string;
    next_retry_at?: string;
    native_dependency_api_failure_retryable: 1;
  };
}

export function parseIssueDependencyMetadata(body: string): IssueDependencyMetadata {
  const frontmatter = parseFrontmatter(body);
  if (frontmatter) {
    return {
      dependsOn: uniqueNumbers(frontmatter.dependsOn),
      priority: frontmatter.priority,
      source: "frontmatter",
    };
  }

  const textDependsOn = parseTextDependencies(body);
  if (textDependsOn.length > 0) {
    return {
      dependsOn: uniqueNumbers(textDependsOn),
      priority: 0,
      source: "text",
    };
  }

  return { dependsOn: [], priority: 0, source: "none" };
}

export function mergeDependencySources(input: {
  markers: DependencySource[];
  native: DependencySource[];
}): { dependencies: MergedDependency[]; metrics: DependencyMergeMetrics } {
  const byIssue = new Map<number, MergedDependency>();
  for (const dependency of [...input.markers, ...input.native]) {
    const current = byIssue.get(dependency.issue) ?? { issue: dependency.issue, sources: [] };
    if (!current.sources.includes(dependency.source)) current.sources.push(dependency.source);
    byIssue.set(dependency.issue, current);
  }

  return {
    dependencies: [...byIssue.values()],
    metrics: {
      native_dependencies_discovered: input.native.length,
      marker_dependencies_merged: input.markers.length,
      dependency_duplicates_removed: input.markers.length + input.native.length - byIssue.size,
    },
  };
}

export function nativeDependencyFailureWarning(input: {
  issueNumber: number;
  message: string;
  nextRetryAt?: string;
}): RetryableIntakeWarning {
  return {
    event_type: "intake_warning_retryable",
    payload: {
      issue_number: input.issueNumber,
      message: input.message,
      next_retry_at: input.nextRetryAt,
      native_dependency_api_failure_retryable: 1,
    },
  };
}

function parseFrontmatter(body: string): { dependsOn: number[]; priority: number } | undefined {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;

  const dependsOn: number[] = [];
  let priority = 0;

  for (const line of match[1].split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "depends_on") {
      dependsOn.push(...numbersFromText(value));
    } else if (key === "priority") {
      const parsed = Number(value);
      priority = Number.isFinite(parsed) ? parsed : 0;
    }
  }

  return { dependsOn, priority };
}

function parseTextDependencies(body: string): number[] {
  const result: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(Depends(?: |-)?On|Blocked(?: |-)?By)\s*:/i.test(line)) {
      result.push(...numbersFromText(line));
    }
  }
  return result;
}

function numbersFromText(value: string): number[] {
  return [...value.matchAll(/#?(\d+)/g)]
    .map((match) => Number(match[1]))
    .filter((number) => Number.isInteger(number) && number > 0);
}

function uniqueNumbers(values: number[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

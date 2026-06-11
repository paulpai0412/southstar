import type { LifecycleState } from "../types/control-plane.ts";

export interface SchedulableIssue {
  issueId: string;
  issueNumber: number;
  lifecycleState: LifecycleState;
  dependsOn: number[];
  priority: number;
}

export interface ScheduleResult {
  startable: SchedulableIssue[];
  blocked: SchedulableIssue[];
  quarantined: Array<SchedulableIssue & { reason: "dependency_cycle" | "missing_dependency"; dependency?: number }>;
  metrics: {
    scheduler_issues_loaded: number;
    scheduler_dependency_edges: number;
    scheduler_dependency_order_violations: number;
  };
}

export interface ProductionSchedulableIssue {
  issueId: string;
  number: number;
  lifecycle: LifecycleState;
  dependencies: number[];
  priority?: number;
}

export function scheduleReadyIssues(input: {
  issues: Array<SchedulableIssue | ProductionSchedulableIssue>;
  developmentCapacity?: number;
  maxStarts?: number;
}): ScheduleResult {
  const issues = input.issues.map(normalizeSchedulableIssue);
  const capacity = input.developmentCapacity ?? input.maxStarts ?? issues.length;
  const byNumber = new Map(issues.map((issue) => [issue.issueNumber, issue]));
  const completed = new Set(issues.filter((issue) => issue.lifecycleState === "completed").map((issue) => issue.issueNumber));
  const ready = issues.filter((issue) => issue.lifecycleState === "ready");
  const quarantined: ScheduleResult["quarantined"] = [];
  const blocked: SchedulableIssue[] = [];
  const startable: SchedulableIssue[] = [];

  for (const candidate of ready) {
    const missing = candidate.dependsOn.find((dependency) => !byNumber.has(dependency));
    if (missing !== undefined) {
      quarantined.push({ ...candidate, reason: "missing_dependency", dependency: missing });
      continue;
    }

    if (isInCycle(candidate.issueNumber, byNumber, new Set(), new Set())) {
      quarantined.push({ ...candidate, reason: "dependency_cycle" });
      continue;
    }

    if (candidate.dependsOn.some((dependency) => !completed.has(dependency))) {
      blocked.push(candidate);
      continue;
    }

    startable.push(candidate);
  }

  startable.sort((left, right) => right.priority - left.priority || left.issueNumber - right.issueNumber);

  return {
    startable: startable.slice(0, capacity),
    blocked,
    quarantined,
    metrics: {
      scheduler_issues_loaded: issues.length,
      scheduler_dependency_edges: issues.reduce((sum, issue) => sum + issue.dependsOn.length, 0),
      scheduler_dependency_order_violations: 0,
    },
  };
}

function normalizeSchedulableIssue(issue: SchedulableIssue | ProductionSchedulableIssue): SchedulableIssue {
  if ("issueNumber" in issue) return issue;

  return {
    issueId: issue.issueId,
    issueNumber: issue.number,
    lifecycleState: issue.lifecycle,
    dependsOn: issue.dependencies,
    priority: issue.priority ?? 0,
  };
}

function isInCycle(
  issueNumber: number,
  byNumber: Map<number, SchedulableIssue>,
  path: Set<number>,
  visited: Set<number>,
): boolean {
  if (path.has(issueNumber)) return true;
  if (visited.has(issueNumber)) return false;

  visited.add(issueNumber);
  path.add(issueNumber);
  const issue = byNumber.get(issueNumber);
  for (const dependency of issue?.dependsOn ?? []) {
    if (isInCycle(dependency, byNumber, path, visited)) return true;
  }
  path.delete(issueNumber);
  return false;
}

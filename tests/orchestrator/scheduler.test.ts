import test from "node:test";
import assert from "node:assert/strict";
import { scheduleReadyIssues, type SchedulableIssue } from "../../src/orchestrator/scheduler.ts";

function issue(input: Partial<SchedulableIssue> & { issueNumber: number }): SchedulableIssue {
  return {
    issueId: `github:${input.issueNumber}`,
    issueNumber: input.issueNumber,
    lifecycleState: input.lifecycleState ?? "ready",
    dependsOn: input.dependsOn ?? [],
    priority: input.priority ?? 0,
  };
}

test("schedules dependencies before dependents", () => {
  const result = scheduleReadyIssues({
    issues: [issue({ issueNumber: 2, dependsOn: [1] }), issue({ issueNumber: 1 })],
    developmentCapacity: 2,
  });

  assert.deepEqual(result.startable.map((item) => item.issueNumber), [1]);
  assert.deepEqual(result.blocked.map((item) => item.issueNumber), [2]);
  assert.equal(result.metrics.scheduler_dependency_order_violations, 0);
});

test("schedules dependent after dependency completed", () => {
  const result = scheduleReadyIssues({
    issues: [
      issue({ issueNumber: 1, lifecycleState: "completed" }),
      issue({ issueNumber: 2, dependsOn: [1] }),
    ],
    developmentCapacity: 1,
  });

  assert.deepEqual(result.startable.map((item) => item.issueNumber), [2]);
});

test("uses priority then issue number for same dependency level", () => {
  const result = scheduleReadyIssues({
    issues: [
      issue({ issueNumber: 9, priority: 1 }),
      issue({ issueNumber: 3, priority: 9 }),
      issue({ issueNumber: 4, priority: 9 }),
    ],
    developmentCapacity: 3,
  });

  assert.deepEqual(result.startable.map((item) => item.issueNumber), [3, 4, 9]);
});

test("quarantines dependency cycles and missing dependencies", () => {
  const result = scheduleReadyIssues({
    issues: [
      issue({ issueNumber: 1, dependsOn: [2] }),
      issue({ issueNumber: 2, dependsOn: [1] }),
      issue({ issueNumber: 5, dependsOn: [99] }),
    ],
    developmentCapacity: 3,
  });

  assert.deepEqual(result.quarantined.map((item) => item.reason).sort(), [
    "dependency_cycle",
    "dependency_cycle",
    "missing_dependency",
  ]);
});

test("scheduler blocks issue until Depends-On issue is completed using production dependency shape", () => {
  const scheduled = scheduleReadyIssues({
    issues: [
      productionIssue({ issueId: "github:1", number: 1, lifecycle: "completed" }),
      productionIssue({ issueId: "github:2", number: 2, lifecycle: "ready", dependencies: [1] }),
      productionIssue({ issueId: "github:3", number: 3, lifecycle: "ready", dependencies: [99] }),
    ],
    maxStarts: 2,
  });

  assert.deepEqual(scheduled.startable.map((item) => item.issueId), ["github:2"]);
  assert.deepEqual(scheduled.quarantined.map((item) => item.issueId), ["github:3"]);
  assert.equal(scheduled.metrics.scheduler_dependency_order_violations, 0);
});

function productionIssue(input: {
  issueId: string;
  number: number;
  lifecycle: SchedulableIssue["lifecycleState"];
  dependencies?: number[];
}) {
  return {
    issueId: input.issueId,
    number: input.number,
    lifecycle: input.lifecycle,
    dependencies: input.dependencies ?? [],
    priority: 0,
  } as unknown as SchedulableIssue;
}

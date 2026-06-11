import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeDependencySources,
  nativeDependencyFailureWarning,
  parseIssueDependencyMetadata,
} from "../../src/orchestrator/dependencies.ts";

test("parses YAML frontmatter dependencies and priority", () => {
  const parsed = parseIssueDependencyMetadata([
    "---",
    "depends_on: [12, 15]",
    "priority: 7",
    "---",
    "Implement the payment flow.",
  ].join("\n"));

  assert.deepEqual(parsed.dependsOn, [12, 15]);
  assert.equal(parsed.priority, 7);
  assert.equal(parsed.source, "frontmatter");
});

test("parses text dependency fallback", () => {
  const parsed = parseIssueDependencyMetadata([
    "Build this after prerequisites.",
    "Depends on: #3, #4",
    "Blocked by: #8",
  ].join("\n"));

  assert.deepEqual(parsed.dependsOn, [3, 4, 8]);
  assert.equal(parsed.priority, 0);
  assert.equal(parsed.source, "text");
});

test("parses hyphenated GitHub dependency markers", () => {
  const parsed = parseIssueDependencyMetadata("Depends-On: #1\nBlocked-By: #2");
  assert.deepEqual(parsed.dependsOn, [1, 2]);
  assert.equal(parsed.source, "text");
});

test("deduplicates and sorts dependency ids by first appearance", () => {
  const parsed = parseIssueDependencyMetadata("Depends on: #9, #9, #2\nBlocked by: #2, #10");
  assert.deepEqual(parsed.dependsOn, [9, 2, 10]);
});

test("returns empty dependency metadata when body has no dependency syntax", () => {
  assert.deepEqual(parseIssueDependencyMetadata("plain issue"), {
    dependsOn: [],
    priority: 0,
    source: "none",
  });
});

test("dependency discovery merges marker and native dependencies with source evidence", () => {
  const result = mergeDependencySources({
    markers: [{ issue: 2, source: "Depends-On" }, { issue: 3, source: "Blocked-By" }],
    native: [{ issue: 2, source: "tasklist" }, { issue: 4, source: "linked_issue" }],
  });

  assert.deepEqual(result.dependencies.map((item) => item.issue).sort(), [2, 3, 4]);
  assert.equal(result.metrics.native_dependencies_discovered, 2);
  assert.equal(result.metrics.marker_dependencies_merged, 2);
  assert.equal(result.metrics.dependency_duplicates_removed, 1);
  assert.equal(result.dependencies.find((item) => item.issue === 2)?.sources.length, 2);
});

test("native dependency API failure records retryable warning without lifecycle failure", () => {
  const warning = nativeDependencyFailureWarning({
    issueNumber: 10,
    message: "GraphQL permission denied",
    nextRetryAt: "2026-05-31T02:00:00.000Z",
  });

  assert.equal(warning.event_type, "intake_warning_retryable");
  assert.equal(warning.payload.native_dependency_api_failure_retryable, 1);
  assert.equal("native_dependency_api_failure_lifecycle_failures" in warning.payload, false);
});

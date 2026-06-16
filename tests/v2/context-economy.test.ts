import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createRunBrief, createRepoFactCache, createArtifactSummary, buildContextSourceSummary } from "../../src/v2/context/economy.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";

test("creates one run brief and repo fact cache per run", () => {
  const db = openSouthstarDb(":memory:");
  seedRun(db, "run-context-economy");
  createRunBrief(db, {
    runId: "run-context-economy",
    requirementSpec: { summary: "todo-web priority feature", acceptanceCriteria: ["priority", "overdue"], nonGoals: ["deploy"] },
    selectedTemplateRefs: ["software.workflow.feature-implementation"],
    selectedAgentRefs: ["software.implementer", "software.coding-reviewer"],
    risk: "low",
    releaseMode: "none",
  });
  createRepoFactCache(db, {
    runId: "run-context-economy",
    repoPath: "/tmp/todo-web",
    facts: { packageManager: "npm", testCommand: "npm test", framework: "vite", relevantFiles: ["src/App.tsx"], localPreviewCommand: "npm run dev" },
  });

  const rows = db.prepare("select resource_type, resource_key from runtime_resources where run_id = ? order by resource_type").all("run-context-economy") as Array<{ resource_type: string; resource_key: string }>;
  assert.equal(rows.filter((row) => row.resource_type === "run_brief").length, 1);
  assert.equal(rows.filter((row) => row.resource_type === "repo_fact_cache").length, 1);
});

test("context source summary includes upstream artifact summaries", () => {
  const db = openSouthstarDb(":memory:");
  seedRun(db, "run-context-summary");
  createWorkflowTask(db, { id: "fix", runId: "run-context-summary", taskKey: "fix", status: "completed", sortOrder: 1, dependsOn: [], rootSessionId: "root-fix", snapshot: {} });
  createWorkflowTask(db, { id: "coding-review", runId: "run-context-summary", taskKey: "coding-review", status: "pending", sortOrder: 2, dependsOn: ["fix"], rootSessionId: "root-coding-review", snapshot: {} });
  createRunBrief(db, {
    runId: "run-context-summary",
    requirementSpec: { summary: "parser fix", acceptanceCriteria: ["escaped pipe"], nonGoals: [] },
    selectedTemplateRefs: ["software.workflow.bug-diagnosis-fix"],
    selectedAgentRefs: ["software.reproducer", "software.diagnoser"],
    risk: "low",
    releaseMode: "none",
  });
  createRepoFactCache(db, {
    runId: "run-context-summary",
    repoPath: "/tmp/markdown-notes",
    facts: { packageManager: "npm", testCommand: "npm test", framework: "node", relevantFiles: ["src/table-parser.ts"] },
  });
  createArtifactSummary(db, {
    runId: "run-context-summary",
    taskId: "fix",
    artifactRef: "artifact-fix",
    summary: "Fixed escaped pipe parsing and added regression tests.",
    evidenceRefs: ["evidence-fix"],
    validatorRefs: ["validator-fix"],
    riskNotes: ["parser edge cases"],
  });

  const summary = buildContextSourceSummary(db, { runId: "run-context-summary", taskId: "coding-review", dependencyTaskIds: ["fix"] });
  assert.equal(summary.sources.some((source) => source.kind === "run_brief"), true);
  assert.equal(summary.sources.some((source) => source.kind === "repo_fact_cache"), true);
  assert.equal(summary.sources.some((source) => source.kind === "artifact_summary" && source.sourceRef === "artifact-fix"), true);
  assert.match(summary.text, /Fixed escaped pipe parsing/);
});

test("review task context can reference upstream summaries before broad rediscovery", () => {
  const db = openSouthstarDb(":memory:");
  seedRun(db, "run-review");
  createWorkflowTask(db, { id: "implement", runId: "run-review", taskKey: "implement", status: "completed", sortOrder: 1, dependsOn: [], rootSessionId: "root-implement", snapshot: {} });
  createWorkflowTask(db, { id: "coding-review", runId: "run-review", taskKey: "coding-review", status: "pending", sortOrder: 2, dependsOn: ["implement"], rootSessionId: "root-coding-review", snapshot: {} });
  upsertRuntimeResource(db, { resourceType: "artifact", resourceKey: "artifact-implement", runId: "run-review", taskId: "implement", scope: "task", status: "accepted", payload: { summary: "Implemented priority labels" }, summary: { summary: "Implemented priority labels", evidencePacketRefs: ["evidence-1"], validatorResultRefs: ["validator-1"] } });
  createArtifactSummary(db, { runId: "run-review", taskId: "implement", artifactRef: "artifact-implement", summary: "Implemented priority labels", evidenceRefs: ["evidence-1"], validatorRefs: ["validator-1"], riskNotes: [] });

  const summary = buildContextSourceSummary(db, { runId: "run-review", taskId: "coding-review", dependencyTaskIds: ["implement"] });
  assert.deepEqual(summary.artifactSummaryRefs, ["artifact-summary-run-review-implement-artifact-implement"].sort());
});

function seedRun(db: ReturnType<typeof openSouthstarDb>, runId: string): void {
  createWorkflowRun(db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: runId,
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
}

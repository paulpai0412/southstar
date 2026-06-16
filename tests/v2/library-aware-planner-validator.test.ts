import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { validateLibraryAwarePlannerResult } from "../../src/v2/planner/library-aware-validator.ts";
import type { LibraryAwarePlannerResult } from "../../src/v2/planner/library-aware-types.ts";

test("validates a feature planner result assembled from library refs", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, true, validation.issues.map((issue) => issue.message).join("\n"));
});

test("rejects missing agent profile refs and unsafe grants", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  result.tasks[1]!.agentProfileRef = "missing-profile";
  result.tasks[2]!.mcpGrantRefs = ["filesystem.workspace-write"];

  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "unknown_agent_profile"), true);
  assert.equal(validation.issues.some((issue) => issue.code === "readonly_agent_has_write_grant"), true);
});

test("rejects planner attempts to invent ad hoc Docker images", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  result.tasks[1]!.executionImage = "southstar/custom-feature-agent:latest";

  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "unapproved_execution_image"), true);
});

test("requires approval for high risk generated components", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });
  const result = validFeatureResult();
  result.generatedComponents.push({
    id: "generated-merge-profile",
    kind: "agent_profile",
    risk: "high",
    reason: "merge profile missing",
    validationStatus: "unvalidated",
  });

  const validation = validateLibraryAwarePlannerResult(db, result);
  assert.equal(validation.ok, false);
  assert.equal(validation.issues.some((issue) => issue.code === "high_risk_generated_component_requires_approval"), true);
});

function validFeatureResult(): LibraryAwarePlannerResult {
  return {
    schemaVersion: "southstar.library-aware-planner-result.v1",
    draftTitle: "Todo Web Feature",
    requirementSpec: {
      summary: "Add priority labels and overdue filter",
      acceptanceCriteria: ["priority labels", "due dates", "overdue filter", "localStorage persistence"],
      nonGoals: ["do not deploy"],
      repoPath: "/tmp/todo-web",
    },
    selectedTemplateRefs: ["software.workflow.feature-implementation"],
    confidence: "high",
    risk: "low",
    releaseMode: "none",
    tasks: [
      task("explore", [], "software.explorer", "software.explorer.codex.readonly", ["software.repo-inspection"], ["filesystem.readonly"], ["run_brief", "repo_fact_cache", "implementation_plan"]),
      task("implement", ["explore"], "software.implementer", "software.implementer.pi.workspace-write", ["software.minimal-patch", "software.test-evidence"], ["filesystem.workspace-write", "shell.test-runner"], ["implementation_report"]),
      task("coding-review", ["implement"], "software.coding-reviewer", "software.coding-reviewer.codex.readonly", ["software.code-review"], ["filesystem.readonly", "git.readonly"], ["code_review_report"]),
      task("spec-alignment", ["implement"], "software.spec-alignment", "software.spec-alignment.codex.readonly", ["software.spec-alignment-skill"], ["filesystem.readonly"], ["spec_alignment_report"]),
      task("summarize", ["coding-review", "spec-alignment"], "software.summarizer", "software.summarizer.codex.readonly", ["software.completion-report"], ["filesystem.readonly"], ["completion_report"]),
    ],
    rationale: {
      summary: "Feature template matched a web feature request with low release risk.",
      templateReasons: [{ ref: "software.workflow.feature-implementation", score: 0.94, reason: "feature intent and acceptance criteria matched" }],
      taskReasons: [],
      rejectedAlternatives: [],
    },
    generatedComponents: [],
    requiredClarifications: [],
    requiredApprovals: [],
    librarySearchTrace: { query: "priority due date overdue", matchedRefs: ["software.workflow.feature-implementation"], rejectedRefs: [] },
  };
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  mcpGrantRefs: string[],
  artifactContractRefs: string[],
): LibraryAwarePlannerResult["tasks"][number] {
  return {
    id,
    name: id,
    dependsOn,
    agentDefinitionRef,
    agentProfileRef,
    skillRefs,
    mcpGrantRefs,
    artifactContractRefs,
    evaluatorRef: "software.completion-gate",
    rationale: `Use ${agentDefinitionRef}`,
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareEngineeringStarterLibrary } from "../../src/v2/design-library/software-engineering-starter.ts";
import { listLibraryVersions } from "../../src/v2/design-library/store.ts";

type ObjectRow = { id: string; object_key: string; object_kind: string; state_json: string };

function libraryRows(db: ReturnType<typeof openSouthstarDb>, kind?: string): ObjectRow[] {
  const sql = kind
    ? "select id, object_key, object_kind, state_json from library_objects where object_kind = ? order by object_key"
    : "select id, object_key, object_kind, state_json from library_objects order by object_key";
  return (kind ? db.prepare(sql).all(kind) : db.prepare(sql).all()) as ObjectRow[];
}

test("software engineering starter library seeds five workflow templates and productized agents", () => {
  const db = openSouthstarDb(":memory:");
  const result = seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });

  assert.equal(result.workflowTemplateRefs.length, 5);
  assert.equal(result.agentDefinitionRefs.includes("software.release-operator"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.release-reporter"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.coding-reviewer"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.spec-alignment"), true);
  assert.equal(result.agentDefinitionRefs.includes("software.browser-qa"), true);

  const templates = libraryRows(db, "workflow_template");
  assert.deepEqual(templates.map((row) => row.object_key), [
    "software.workflow.bug-diagnosis-fix",
    "software.workflow.documentation-update",
    "software.workflow.feature-implementation",
    "software.workflow.refactor-safety-net",
    "software.workflow.test-coverage-improvement",
  ]);

  const feature = JSON.parse(templates.find((row) => row.object_key === "software.workflow.feature-implementation")!.state_json) as {
    payload: { flow: { nodes: Array<{ id: string; agentDefinitionRef?: string; skillRefs?: string[] }> } };
  };
  const nodeIds = feature.payload.flow.nodes.map((node) => node.id);
  assert.equal(nodeIds.includes("coding-review"), true);
  assert.equal(nodeIds.includes("spec-alignment"), true);
  assert.equal(nodeIds.includes("release-commit-curation"), true);
  assert.equal(feature.payload.flow.nodes.some((node) => node.agentDefinitionRef === "software.release-operator" && node.skillRefs?.includes("software.commit-curation")), true);

  const agentDefinitions = libraryRows(db, "agent_definition");
  assert.equal(agentDefinitions.length >= 20, true);

  const profiles = libraryRows(db, "agent_profile");
  assert.equal(profiles.some((row) => row.object_key === "software.release-operator.commit-local"), true);
  assert.equal(profiles.some((row) => row.object_key === "software.release-operator.readiness-readonly"), true);
  assert.equal(profiles.some((row) => row.object_key === "software.release-operator.merge-approved"), true);

  const skills = libraryRows(db, "skill_definition");
  for (const skill of [
    "software.repo-inspection",
    "software.minimal-patch",
    "software.test-evidence",
    "software.code-review",
    "software.spec-alignment-skill",
    "software.browser-qa-skill",
    "software.commit-curation",
    "software.merge-readiness",
    "software.merge-operation",
    "software.release-reporting",
  ]) {
    assert.equal(skills.some((row) => row.object_key === skill), true, `missing ${skill}`);
  }

  for (const row of libraryRows(db)) {
    const versions = listLibraryVersions(db, row.id);
    assert.equal(versions.length >= 1, true, `missing immutable version for ${row.object_key}`);
  }
});

test("release operator profiles separate read-only readiness from approved merge mutation", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareEngineeringStarterLibrary(db, { actorType: "migration" });

  const profiles = libraryRows(db, "agent_profile").map((row) => ({
    key: row.object_key,
    payload: JSON.parse(row.state_json).payload as { allowedTools: string[]; mcpGrantRefs: string[]; approvalPolicy?: { requireManualFor?: string[] } },
  }));
  const readiness = profiles.find((row) => row.key === "software.release-operator.readiness-readonly")!;
  const merge = profiles.find((row) => row.key === "software.release-operator.merge-approved")!;

  assert.equal(readiness.payload.allowedTools.includes("edit"), false);
  assert.equal(readiness.payload.mcpGrantRefs.includes("git.readonly"), true);
  assert.equal(merge.payload.mcpGrantRefs.includes("github.pr-write"), true);
  assert.equal(merge.payload.approvalPolicy?.requireManualFor?.includes("github.pr-write"), true);
});

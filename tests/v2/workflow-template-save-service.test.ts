import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import { seedSoftwareLibraryGraph } from "./fixtures/software-library-graph.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { saveWorkflowTemplateDraft } from "../../src/v2/design-library/templates/workflow-template-save-service.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("saves workflow template and generated profile files then syncs draft objects", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-template-save-"));
  try {
    const result = await saveWorkflowTemplateDraft(db, {
      root,
      scope: "software",
      templateId: "template.todo-webapp",
      title: "Todo Webapp",
      nodes: [{
        id: "implement-ui",
        title: "Implement UI",
        agentRef: "agent.frontend-developer",
        skillRefs: ["skill.react-ui"],
        toolGrantRefs: ["tool.workspace-write"],
        mcpGrantRefs: [],
      }, {
        id: "validate-ui",
        title: "Validate UI",
        agentRef: "agent.browser-verifier",
        skillRefs: ["skill.browser-verification"],
        toolGrantRefs: ["tool.browser"],
        mcpGrantRefs: [],
      }],
      edges: [{ from: "implement-ui", to: "validate-ui" }],
      libraryVersionRefs: ["agent.frontend-developer@test", "skill.react-ui@test"],
      compositionPlan: savedCompositionPlan() as any,
    });

    assert.equal(result.template.relativePath, "templates/saved/todo-webapp.workflow.yaml");
    assert.equal(result.profiles[0]?.relativePath, "profiles/generated/todo-webapp/implement-ui.profile.yaml");
    const templateYaml = await readFile(join(root, result.template.relativePath), "utf8");
    assert.match(templateYaml, /profile.generated.todo-webapp.implement-ui/);
    assert.match(templateYaml, /compositionPlanJsonBase64:/);
    assert.match(await readFile(join(root, result.profiles[0]!.relativePath), "utf8"), /agent\.frontend-developer/);
    const templateObject = await findLibraryObjectByKey(db, "template.todo-webapp");
    assert.equal(templateObject?.status, "draft");
    assert.equal(typeof templateObject?.state.compositionPlanJsonBase64, "string");
    assert.equal((await findLibraryObjectByKey(db, "profile.generated.todo-webapp.implement-ui"))?.status, "draft");
    const profileEdges = await findLibraryEdgesFrom(db, "template.todo-webapp", "part_of_template", { scope: "software" });
    assert.deepEqual(
      profileEdges.map((edge) => edge.toObjectKey),
      ["profile.generated.todo-webapp.implement-ui", "profile.generated.todo-webapp.validate-ui"],
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function savedCompositionPlan() {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Saved Todo Webapp",
    selectedWorkflowTemplateRef: "template.todo-webapp",
    rationale: "Saved reusable template composition.",
    tasks: [{
      id: "implement-ui",
      name: "Implement UI",
      responsibility: "Implement the UI.",
      nodePromptSpec: {
        nodeType: "implement",
        goal: "Implement UI.",
        requirements: ["Build UI."],
        boundaries: [],
        nonGoals: [],
        deliverableDocuments: [],
        expectedOutputs: ["artifact.implementation"],
        testCases: [],
        acceptanceCriteria: ["UI exists."],
        implementationScope: ["UI code."],
      },
      dependsOn: [],
      templateSlotRef: "implement-ui",
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.todo-webapp.implement-ui",
      instructionRefs: [],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation"],
      evaluatorProfileRef: "evaluator.software-verification-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "Implement UI.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

test("quotes YAML scalar-like titles before syncing", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-template-save-"));
  try {
    const result = await saveWorkflowTemplateDraft(db, {
      root,
      scope: "software",
      templateId: "template.boolean-title",
      title: "true",
      nodes: [{
        id: "implement-ui",
        title: "false",
        agentRef: "agent.frontend-developer",
        skillRefs: [],
        toolGrantRefs: [],
        mcpGrantRefs: [],
      }],
      edges: [],
      libraryVersionRefs: [],
    });

    assert.match(await readFile(join(root, result.template.relativePath), "utf8"), /title: "true"/);
    assert.match(await readFile(join(root, result.profiles[0]!.relativePath), "utf8"), /title: "false"/);
    assert.equal((await findLibraryObjectByKey(db, "template.boolean-title"))?.status, "draft");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("saved workflow templates remain draft proposals until separately approved", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-template-save-draft-"));
  try {
    await saveWorkflowTemplateDraft(db, {
      root,
      scope: "software",
      templateId: "template.reusable-webapp",
      title: "Reusable Webapp",
      nodes: [{
        id: "implement-ui",
        title: "Implement UI",
        agentRef: "agent.frontend-developer",
        skillRefs: ["skill.react-ui"],
        toolGrantRefs: ["tool.workspace-write"],
        mcpGrantRefs: [],
      }],
      edges: [],
      libraryVersionRefs: ["agent.frontend-developer@test", "skill.react-ui@test"],
    });

    assert.match(await readFile(join(root, "templates/saved/reusable-webapp.workflow.yaml"), "utf8"), /status: draft/);
    assert.match(await readFile(join(root, "profiles/generated/reusable-webapp/implement-ui.profile.yaml"), "utf8"), /status: draft/);
    assert.equal((await findLibraryObjectByKey(db, "template.reusable-webapp"))?.status, "draft");
    assert.equal((await findLibraryObjectByKey(db, "profile.generated.reusable-webapp.implement-ui"))?.status, "draft");

    const candidates = await resolveWorkflowCandidates(db, {
      scope: "software",
      requirementSpec: {
        summary: "Build a reusable web app",
        workType: "software_feature",
        requiredCapabilities: [],
        expectedArtifacts: [],
        acceptanceCriteria: [],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
    });
    assert.equal(candidates.workflowTemplateCandidates.some((candidate) => candidate.ref === "template.reusable-webapp"), false);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsafe template and node identifiers before writing files", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-template-save-"));
  try {
    await assert.rejects(
      saveWorkflowTemplateDraft(db, {
        root,
        scope: "software",
        templateId: "template../bad",
        title: "Bad",
        nodes: [{
          id: "../escape",
          title: "Bad Node",
          agentRef: "agent.frontend-developer",
          skillRefs: [],
          toolGrantRefs: [],
          mcpGrantRefs: [],
        }],
        edges: [],
        libraryVersionRefs: [],
      }),
      /templateId must match/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime save-template route writes draft workflow template proposals by default", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-template-route-"));
  try {
    await seedSoftwareLibraryGraph(db);
    await upsertRuntimeResourcePg(db, {
      id: "draft-route",
      resourceType: "planner_draft",
      resourceKey: "draft-route",
      scope: "planner",
      status: "validated",
      title: "Route Draft",
      payload: {
        workflow: {
          workflowId: "wf-route",
          title: "Route Workflow",
          tasks: [{
            id: "implement-ui",
            name: "Implement UI",
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            dependsOn: [],
            skillRefs: ["skill.software-implementation"],
            toolGrantRefs: ["tool.workspace-write"],
            mcpGrantRefs: ["mcp.filesystem-workspace"],
          }],
        },
      },
      summary: {
        goalPrompt: "implement ui",
        workflowId: "wf-route",
      },
    });

    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/workflow/drafts/draft-route/save-template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "software",
        templateId: "template.route-save",
        title: "Route Save",
        nodes: [{
          id: "browser-body-must-not-win",
          title: "Browser Body Must Not Win",
          agentRef: "agent.browser-body",
          skillRefs: [],
          toolGrantRefs: [],
          mcpGrantRefs: [],
        }],
      }),
    }));

    assert.equal(response.status, 200);
    const payload = await response.json() as { kind: string; result: { draftId: string; template: { relativePath: string } } };
    assert.equal(payload.kind, "workflow-template-save");
    assert.equal(payload.result.draftId, "draft-route");
    assert.equal(payload.result.template.relativePath, "templates/saved/route-save.workflow.yaml");
    const profile = await readFile(join(libraryRoot, "profiles/generated/route-save/implement-ui.profile.yaml"), "utf8");
    const templateYaml = await readFile(join(libraryRoot, payload.result.template.relativePath), "utf8");
    assert.match(profile, /agent\.software-maker/);
    assert.match(profile, /skill\.software-implementation/);
    assert.match(profile, /tool\.workspace-write/);
    assert.match(profile, /mcp\.filesystem-workspace/);
    assert.match(templateYaml, /libraryVersionRefs:/);
    assert.match(templateYaml, /agent\.software-maker@/);
    assert.match(templateYaml, /skill\.software-implementation@/);
    assert.match(templateYaml, /tool\.workspace-write@/);
    assert.match(templateYaml, /mcp\.filesystem-workspace@/);
    assert.match(templateYaml, /status: draft/);
    assert.equal((await findLibraryObjectByKey(db, "template.route-save"))?.status, "draft");
    assert.equal((await findLibraryObjectByKey(db, "profile.generated.route-save.implement-ui"))?.status, "draft");
    assert.doesNotMatch(profile, /agent\.browser-body/);
    assert.equal(await findLibraryObjectByKey(db, "agent.maker"), null);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("runtime save-template route derives generated profile agent refs from role refs", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-template-route-generated-"));
  try {
    await seedSoftwareLibraryGraph(db);
    await upsertRuntimeResourcePg(db, {
      id: "draft-generated-route",
      resourceType: "planner_draft",
      resourceKey: "draft-generated-route",
      scope: "planner",
      status: "validated",
      title: "Generated Route Draft",
      payload: {
        workflow: {
          workflowId: "wf-generated-route",
          title: "Generated Route Workflow",
          tasks: [{
            id: "task.implement-ui",
            name: "Implement UI",
            roleRef: "software-maker",
            agentProfileRef: "generated.agent_profile.todo.implementer",
            dependsOn: [],
            skillRefs: ["skill.software-implementation"],
            toolGrantRefs: ["tool.workspace-write"],
            mcpGrantRefs: ["mcp.filesystem-workspace"],
          }],
        },
      },
      summary: {
        goalPrompt: "implement ui",
        workflowId: "wf-generated-route",
      },
    });

    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/workflow/drafts/draft-generated-route/save-template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "software",
        templateId: "template.generated-route-save",
        title: "Generated Route Save",
      }),
    }));

    assert.equal(response.status, 200);
    const profile = await readFile(join(libraryRoot, "profiles/generated/generated-route-save/implement-ui.profile.yaml"), "utf8");
    assert.match(profile, /agent\.software-maker/);
    assert.match(profile, /status: draft/);
    assert.equal((await findLibraryObjectByKey(db, "template.generated-route-save"))?.status, "draft");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("runtime save-template route rejects workflow tasks without a graph-backed agent ref", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-template-route-unknown-agent-"));
  try {
    await upsertRuntimeResourcePg(db, {
      id: "draft-unknown-agent",
      resourceType: "planner_draft",
      resourceKey: "draft-unknown-agent",
      scope: "planner",
      status: "validated",
      title: "Unknown Agent Draft",
      payload: {
        workflow: {
          workflowId: "wf-unknown-agent",
          title: "Unknown Agent Workflow",
          tasks: [{
            id: "implement-ui",
            name: "Implement UI",
            roleRef: "maker",
            agentProfileRef: "unknown-maker-profile",
            dependsOn: [],
          }],
        },
      },
      summary: {
        goalPrompt: "implement ui",
        workflowId: "wf-unknown-agent",
      },
    });

    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/workflow/drafts/draft-unknown-agent/save-template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "software",
        templateId: "template.unknown-agent-save",
        title: "Unknown Agent Save",
      }),
    }));

    assert.equal(response.status, 400);
    assert.match(await response.text(), /agentRef does not resolve to a graph-backed agent definition: agent\.maker/);
    assert.deepEqual(await readdir(libraryRoot), []);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("runtime save-template route rejects selected primitive refs missing from the graph", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-template-route-unknown-primitive-"));
  try {
    await seedSoftwareLibraryGraph(db);
    await upsertRuntimeResourcePg(db, {
      id: "draft-unknown-primitive",
      resourceType: "planner_draft",
      resourceKey: "draft-unknown-primitive",
      scope: "planner",
      status: "validated",
      title: "Unknown Primitive Draft",
      payload: {
        workflow: {
          workflowId: "wf-unknown-primitive",
          title: "Unknown Primitive Workflow",
          tasks: [{
            id: "implement-ui",
            name: "Implement UI",
            agentProfileRef: "software-maker-pi",
            dependsOn: [],
            skillRefs: ["skill.missing-primitive"],
          }],
        },
      },
      summary: {
        goalPrompt: "implement ui",
        workflowId: "wf-unknown-primitive",
      },
    });

    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/workflow/drafts/draft-unknown-primitive/save-template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "software",
        templateId: "template.unknown-primitive-save",
        title: "Unknown Primitive Save",
      }),
    }));

    assert.equal(response.status, 400);
    assert.match(await response.text(), /library ref does not resolve to a graph object: skill\.missing-primitive/);
    assert.deepEqual(await readdir(libraryRoot), []);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

test("runtime save-template route rejects missing planner draft ids", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-template-route-missing-"));
  try {
    const response = await handleRuntimeRoute({ db, libraryRoot } as any, new Request("http://local/api/v2/workflow/drafts/missing-draft/save-template", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "software",
        templateId: "template.missing-save",
        title: "Missing Save",
        nodes: [{
          id: "should-not-write",
          title: "Should Not Write",
          agentRef: "agent.browser-verifier",
          skillRefs: [],
          toolGrantRefs: [],
          mcpGrantRefs: [],
        }],
        edges: [],
      }),
    }));

    assert.equal(response.status, 404);
    assert.deepEqual(await readdir(libraryRoot), []);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

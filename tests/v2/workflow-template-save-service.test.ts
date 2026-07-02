import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import { saveWorkflowTemplateDraft } from "../../src/v2/design-library/templates/workflow-template-save-service.ts";
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
    });

    assert.equal(result.template.relativePath, "templates/saved/todo-webapp.workflow.yaml");
    assert.equal(result.profiles[0]?.relativePath, "profiles/generated/todo-webapp/implement-ui.profile.yaml");
    assert.match(await readFile(join(root, result.template.relativePath), "utf8"), /profile.generated.todo-webapp.implement-ui/);
    assert.match(await readFile(join(root, result.profiles[0]!.relativePath), "utf8"), /agent\.frontend-developer/);
    assert.equal((await findLibraryObjectByKey(db, "template.todo-webapp"))?.status, "draft");
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
    });

    assert.match(await readFile(join(root, result.template.relativePath), "utf8"), /title: "true"/);
    assert.match(await readFile(join(root, result.profiles[0]!.relativePath), "utf8"), /title: "false"/);
    assert.equal((await findLibraryObjectByKey(db, "template.boolean-title"))?.status, "draft");
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
      }),
      /templateId must match/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

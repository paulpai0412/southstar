import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findLibraryEdgesFrom,
  findLibraryObjectByKey,
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
import {
  composeNodeProfileDraft,
  saveNodeProfileDraft,
} from "../../src/v2/design-library/profile-composer/node-profile-draft-service.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("composes a validated node profile from approved graph primitives", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedProfilePrimitives(db);

    const draft = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a todo web app UI",
      preferredAgentRef: "agent.frontend-developer",
    });

    assert.equal(draft.validation.ok, true);
    assert.equal(draft.profile.agentRef, "agent.frontend-developer");
    assert.deepEqual(draft.profile.skillRefs, ["skill.react-ui"]);
    assert.deepEqual(draft.profile.toolGrantRefs, ["tool.workspace-write"]);
    assert.deepEqual(draft.profile.mcpGrantRefs, ["mcp.filesystem-workspace"]);
    assert.deepEqual(draft.profile.instructionRefs, ["instruction.react-review"]);
  } finally {
    await db.close();
  }
});

test("does not compose unapproved primitive refs through graph edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedProfilePrimitives(db);
    await upsertLibraryObject(db, {
      objectKey: "skill.experimental-ui",
      objectKind: "skill_spec",
      status: "blocked",
      headVersionId: "skill.experimental-ui@1",
      state: { scope: "software", title: "Experimental UI" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "uses",
      toObjectKey: "skill.experimental-ui",
      scope: "software",
    });

    const draft = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a todo web app UI",
      preferredAgentRef: "agent.frontend-developer",
    });

    assert.equal(draft.validation.ok, true);
    assert.deepEqual(draft.profile.skillRefs, ["skill.react-ui"]);
  } finally {
    await db.close();
  }
});

test("saves a valid profile draft as a local file and syncs it to graph", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-profile-draft-"));
  try {
    await seedProfilePrimitives(db);
    const draft = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a todo web app UI",
      preferredAgentRef: "agent.frontend-developer",
    });

    const saved = await saveNodeProfileDraft(db, {
      root,
      draft,
      templateId: "template.todo-webapp",
      actor: "operator",
      reason: "save generated node profile",
    });

    assert.equal(saved.relativePath, "profiles/generated/todo-webapp/implement-ui.profile.yaml");
    await access(join(root, saved.relativePath));
    const content = await readFile(join(root, saved.relativePath), "utf8");
    assert.match(content, /schemaVersion: southstar\.library\.generated_agent_profile_file\.v1/);
    assert.match(content, /agentRef: agent\.frontend-developer/);
    const savedProfileId = "profile.generated.todo-webapp.implement-ui";
    assert.equal((await findLibraryObjectByKey(db, savedProfileId))?.status, "draft");
    assert.deepEqual(
      (await findLibraryEdgesFrom(db, savedProfileId, "uses", { scope: "software" }))
        .map((edge) => edge.toObjectKey),
      ["skill.react-ui"],
    );
    assert.deepEqual(
      (await findLibraryEdgesFrom(db, savedProfileId, "allows_tool", { scope: "software" }))
        .map((edge) => edge.toObjectKey),
      ["tool.workspace-write"],
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects saving profile drafts that add unsupported agent skills", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-profile-draft-unsupported-"));
  try {
    await seedProfilePrimitives(db);
    await upsertLibraryObject(db, {
      objectKey: "skill.database-design",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.database-design@1",
      state: { scope: "software", title: "Database Design" },
    });
    const draft = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a todo web app UI",
      preferredAgentRef: "agent.frontend-developer",
    });
    const tampered = {
      ...draft,
      profile: {
        ...draft.profile,
        skillRefs: [...draft.profile.skillRefs, "skill.database-design"],
      },
      validation: { ok: true, issues: [] },
    };

    await assert.rejects(
      () => saveNodeProfileDraft(db, {
        root,
        draft: tampered,
        templateId: "template.todo-webapp",
        actor: "operator",
        reason: "attempt unsupported skill",
      }),
      /cannot save invalid node profile draft/,
    );

    await assert.rejects(access(join(root, "profiles/generated/todo-webapp/implement-ui.profile.yaml")), /ENOENT/);
    assert.equal(await findLibraryObjectByKey(db, tampered.profile.profileId), null);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uses a stable profile id for repeated saves of the same template node", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-profile-draft-stable-"));
  try {
    await seedProfilePrimitives(db);
    const first = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a todo web app UI",
      preferredAgentRef: "agent.frontend-developer",
      templateId: "template.todo-webapp",
    });
    await saveNodeProfileDraft(db, {
      root,
      draft: first,
      templateId: "template.todo-webapp",
      actor: "operator",
      reason: "first save",
    });

    const second = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a calendar web app UI",
      preferredAgentRef: "agent.frontend-developer",
      templateId: "template.todo-webapp",
    });
    await saveNodeProfileDraft(db, {
      root,
      draft: second,
      templateId: "template.todo-webapp",
      actor: "operator",
      reason: "second save",
    });

    assert.equal(first.profile.profileId, "profile.generated.todo-webapp.implement-ui");
    assert.equal(second.profile.profileId, "profile.generated.todo-webapp.implement-ui");
    assert.equal((await findLibraryObjectByKey(db, "profile.generated.todo-webapp.implement-ui"))?.status, "draft");
    assert.equal(await findLibraryObjectByKey(db, "profile.generated.build-a-todo-web-app-ui.implement-ui"), null);
    assert.equal(await findLibraryObjectByKey(db, "profile.generated.build-a-calendar-web-app-ui.implement-ui"), null);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("profile draft compose and save routes return envelopes", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-profile-route-"));
  try {
    await seedProfilePrimitives(db);
    const context = { db, libraryRoot } as any;

    const composeResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/profile-drafts/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "software",
        nodeId: "implement-ui",
        requirement: "Build a todo web app UI",
        preferredAgentRef: "agent.frontend-developer",
        templateId: "template.todo-webapp",
      }),
    }));
    assert.equal(composeResponse.status, 200);
    const composed = await composeResponse.json() as {
      ok: boolean;
      kind: string;
      result: Awaited<ReturnType<typeof composeNodeProfileDraft>>;
    };
    assert.equal(composed.ok, true);
    assert.equal(composed.kind, "library-profile-draft");
    assert.equal(composed.result.validation.ok, true);

    const saveResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/profile-drafts/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: composed.result,
        templateId: "template.todo-webapp",
        actor: "operator",
        reason: "save generated node profile",
      }),
    }));
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json() as { ok: boolean; kind: string; result: { relativePath: string } };
    assert.equal(saved.ok, true);
    assert.equal(saved.kind, "library-profile-draft-save");
    assert.equal(saved.result.relativePath, "profiles/generated/todo-webapp/implement-ui.profile.yaml");
    assert.equal((await findLibraryObjectByKey(db, composed.result.profile.profileId))?.status, "draft");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});

async function seedProfilePrimitives(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: { scope: "software", title: "Frontend Developer" },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: { scope: "software", title: "React UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write" },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace" },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review" },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "requires_tool",
    toObjectKey: "tool.workspace-write",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "allows_mcp_grant",
    toObjectKey: "mcp.filesystem-workspace",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.react-review",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "uses",
    toObjectKey: "skill.react-ui",
    scope: "software",
  });
}

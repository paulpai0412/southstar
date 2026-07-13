import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyLibraryObjectLifecycleAction } from "../../src/v2/design-library/lifecycle/library-object-lifecycle.ts";
import { listLibraryFiles, readLibraryFile, syncLibraryFileToGraph, writeLibraryFile } from "../../src/v2/design-library/files/library-file-store.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("writes, reads, lists, and syncs an agent file to draft graph rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    const content = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
capabilityRefs:
  - capability.react-ui
allowedToolRefs:
  - tool.workspace-read
---

# Identity

Builds React interfaces.
`;

    const written = await writeLibraryFile({ root, relativePath: "agents/frontend-developer.agent.md", content });
    assert.equal(written.relativePath, "agents/frontend-developer.agent.md");

    await writeLibraryFile({
      root,
      relativePath: "agents/nested/backend-developer.agent.md",
      content: content.replaceAll("frontend-developer", "backend-developer").replace("Frontend Developer", "Backend Developer"),
    });
    await writeLibraryFile({ root, relativePath: "notes/readme.txt", content: "ignored" });

    const listed = await listLibraryFiles({ root });
    assert.deepEqual(
      listed.map((file) => file.relativePath),
      ["agents/frontend-developer.agent.md", "agents/nested/backend-developer.agent.md"],
    );

    const read = await readLibraryFile({ root, relativePath: "agents/frontend-developer.agent.md" });
    assert.equal(read.parsed.ok, true);
    if (!read.parsed.ok) throw new Error("expected parsed agent file");
    assert.equal(read.parsed.file.path, "library/agents/frontend-developer.agent.md");
    assert.equal(read.parsed.file.objectKind, "agent_definition");

    await upsertLibraryObject(db, {
      objectKey: "capability.react-ui",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.react-ui@test",
      state: { scope: "software" },
    });
    await upsertLibraryObject(db, {
      objectKey: "tool.workspace-read",
      objectKind: "tool_definition",
      status: "approved",
      headVersionId: "tool.workspace-read@test",
      state: { scope: "software" },
    });

    const synced = await syncLibraryFileToGraph(db, { root, relativePath: "agents/frontend-developer.agent.md" });
    assert.equal(synced.object.objectKey, "agent.frontend-developer");

    const object = await findLibraryObjectByKey(db, "agent.frontend-developer");
    assert.equal(object?.objectKind, "agent_definition");
    assert.equal(object?.status, "draft");
    assert.equal(object?.state.title, "Frontend Developer");

    const edges = await findLibraryEdgesFrom(db, "agent.frontend-developer", "provides_capability", {
      scope: "software",
      status: "active",
    });
    assert.deepEqual(
      edges.map((edge) => edge.toObjectKey),
      ["capability.react-ui"],
    );

    const fileText = await readFile(join(root, "agents/frontend-developer.agent.md"), "utf8");
    assert.match(fileText, /Builds React interfaces/);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves lifecycle status when syncing an unchanged library file", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    const relativePath = "skills/browser-verification.skill.md";
    const draftContent = `---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.browser-verification
title: Browser Verification
scope: software
status: draft
---

# Instructions

Verify browser behavior.
`;

    await writeLibraryFile({ root, relativePath, content: draftContent });
    const initialSync = await syncLibraryFileToGraph(db, { root, relativePath });
    assert.equal(initialSync.object.status, "draft");

    await applyLibraryObjectLifecycleAction(db, {
      objectKey: "skill.browser-verification",
      action: "approve",
      actor: "operator",
      reason: "validated in a local workflow",
    });

    const unchangedSync = await syncLibraryFileToGraph(db, { root, relativePath });
    assert.equal(unchangedSync.object.headVersionId, initialSync.object.headVersionId);
    assert.equal(unchangedSync.object.status, "approved");
    assert.equal(unchangedSync.object.state.status, "approved");
    assert.equal((await findLibraryObjectByKey(db, "skill.browser-verification"))?.status, "approved");

    await writeLibraryFile({
      root,
      relativePath,
      content: draftContent.replace("Verify browser behavior.", "Verify browser behavior after UI changes."),
    });

    const changedSync = await syncLibraryFileToGraph(db, { root, relativePath });
    assert.notEqual(changedSync.object.headVersionId, initialSync.object.headVersionId);
    assert.equal(changedSync.object.status, "draft");
    assert.equal(changedSync.object.state.status, "draft");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sync deactivates source-file edges that are removed from the file", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    const relativePath = "agents/capability-cleanup.agent.md";
    const withRef = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.capability-cleanup
title: Capability Cleanup
scope: software
status: draft
requiresCapabilityRefs:
  - capability.old
---

# Identity
`;
    const withoutRef = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.capability-cleanup
title: Capability Cleanup
scope: software
status: draft
---

# Identity
`;

    await upsertLibraryObject(db, {
      objectKey: "capability.old",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.old@test",
      state: { scope: "software" },
    });
    await writeLibraryFile({ root, relativePath, content: withRef });
    await syncLibraryFileToGraph(db, { root, relativePath });

    assert.deepEqual(
      (await findLibraryEdgesFrom(db, "agent.capability-cleanup", "requires_capability", {
        scope: "software",
        status: "active",
      })).map((edge) => edge.toObjectKey),
      ["capability.old"],
    );

    await writeLibraryFile({ root, relativePath, content: withoutRef });
    await syncLibraryFileToGraph(db, { root, relativePath });

    assert.deepEqual(
      (await findLibraryEdgesFrom(db, "agent.capability-cleanup", "requires_capability", {
        scope: "software",
        status: "active",
      })).map((edge) => edge.toObjectKey),
      [],
    );
    assert.deepEqual(
      (await findLibraryEdgesFrom(db, "agent.capability-cleanup", "requires_capability", {
        scope: "software",
        status: "inactive",
      })).map((edge) => edge.toObjectKey),
      ["capability.old"],
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("writes create a missing library root safely", async () => {
  const parent = await mkdtemp(join(tmpdir(), "southstar-library-parent-"));
  const root = join(parent, "missing-library-root");

  try {
    const content = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.new
title: New Agent
scope: software
status: draft
---

# Identity
`;

    const written = await writeLibraryFile({ root, relativePath: "agents/new.agent.md", content });
    assert.equal(written.relativePath, "agents/new.agent.md");

    const read = await readLibraryFile({ root, relativePath: "agents/new.agent.md" });
    assert.equal(read.content, content);
    assert.equal(read.parsed.ok, true);

    assert.deepEqual(
      (await listLibraryFiles({ root })).map((file) => file.relativePath),
      ["agents/new.agent.md"],
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects read and write paths outside the library root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const outside = await mkdtemp(join(tmpdir(), "southstar-library-outside-"));
  const outsidePath = join(outside, "escaped.agent.md");

  try {
    await assert.rejects(
      writeLibraryFile({ root, relativePath: "../escaped.agent.md", content: "escaped" }),
      /library file path escapes root/,
    );
    await assert.rejects(
      writeLibraryFile({ root, relativePath: outsidePath, content: "escaped" }),
      /library file path escapes root/,
    );
    await assert.rejects(readLibraryFile({ root, relativePath: "../escaped.agent.md" }), /library file path escapes root/);

    await assert.rejects(access(outsidePath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("normalizes safe library paths that remain inside root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));

  try {
    const content = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.a
title: Agent A
scope: software
status: draft
---

# Identity
`;

    const written = await writeLibraryFile({ root, relativePath: "agents/../agents/a.agent.md", content });
    assert.equal(written.relativePath, "agents/a.agent.md");

    const read = await readLibraryFile({ root, relativePath: "agents/../agents/a.agent.md" });
    assert.equal(read.relativePath, "agents/a.agent.md");
    assert.equal(read.parsed.ok, true);
    if (!read.parsed.ok) throw new Error("expected parsed agent file");
    assert.equal(read.parsed.file.path, "library/agents/a.agent.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects writes through symlinked directories under the library root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const outside = await mkdtemp(join(tmpdir(), "southstar-library-outside-"));
  const outsidePath = join(outside, "escaped.agent.md");

  try {
    await symlink(outside, join(root, "link"), "dir");

    await assert.rejects(
      writeLibraryFile({ root, relativePath: "link/escaped.agent.md", content: "escaped" }),
      /library file path uses symlink/,
    );
    await assert.rejects(access(outsidePath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects reads through symlinked directories and files under the library root", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const outside = await mkdtemp(join(tmpdir(), "southstar-library-outside-"));

  try {
    await writeFile(join(outside, "escaped.agent.md"), "escaped", "utf8");
    await symlink(outside, join(root, "link"), "dir");
    await symlink(join(outside, "escaped.agent.md"), join(root, "escaped.agent.md"), "file");

    await assert.rejects(readLibraryFile({ root, relativePath: "link/escaped.agent.md" }), /library file path uses symlink/);
    await assert.rejects(readLibraryFile({ root, relativePath: "escaped.agent.md" }), /library file path uses symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("syncs generated profile tool and mcp grant refs but does not infer vault ontology edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.frontend-developer",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.frontend-developer@test",
      state: { scope: "software" },
    });
    await upsertLibraryObject(db, {
      objectKey: "tool.workspace-write",
      objectKind: "tool_definition",
      status: "approved",
      headVersionId: "tool.workspace-write@test",
      state: { scope: "software" },
    });
    await upsertLibraryObject(db, {
      objectKey: "mcp.filesystem-workspace",
      objectKind: "mcp_tool_grant",
      status: "approved",
      headVersionId: "mcp.filesystem-workspace@test",
      state: { scope: "software" },
    });
    await writeLibraryFile({
      root,
      relativePath: "profiles/todo-implement-ui.profile.yaml",
      content: `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: profile.generated.todo.implement-ui
title: Todo Implement UI Profile
scope: software
status: draft
agentRef: agent.frontend-developer
toolGrantRefs:
  - tool.workspace-write
mcpGrantRefs:
  - mcp.filesystem-workspace
vaultLeasePolicyRefs:
  - vault.github-write-token
`,
    });

    await syncLibraryFileToGraph(db, { root, relativePath: "profiles/todo-implement-ui.profile.yaml" });

    const toolEdges = await findLibraryEdgesFrom(db, "profile.generated.todo.implement-ui", "allows_tool", {
      scope: "software",
      status: "active",
    });
    assert.deepEqual(
      toolEdges.map((edge) => edge.toObjectKey),
      ["tool.workspace-write"],
    );

    const mcpEdges = await findLibraryEdgesFrom(db, "profile.generated.todo.implement-ui", "allows_mcp_grant", {
      scope: "software",
      status: "active",
    });
    assert.deepEqual(
      mcpEdges.map((edge) => edge.toObjectKey),
      ["mcp.filesystem-workspace"],
    );

    const vaultEdges = await findLibraryEdgesFrom(db, "profile.generated.todo.implement-ui", "requires_secret_group", {
      scope: "software",
      status: "active",
    });
    assert.deepEqual(vaultEdges.map((edge) => edge.toObjectKey), []);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sync projects catalog domain membership edges for agent files", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    await writeLibraryFile({
      root,
      relativePath: "domains/marketing.domain.yaml",
      content: `schemaVersion: southstar.library.domain_taxonomy_file.v1
id: domain.marketing
title: Marketing
scope: marketing
status: approved
`,
    });
    await syncLibraryFileToGraph(db, { root, relativePath: "domains/marketing.domain.yaml" });
    await writeLibraryFile({
      root,
      relativePath: "agents/marketing-seo-specialist.agent.md",
      content: `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.marketing-seo-specialist
title: SEO Specialist
scope: marketing
status: approved
---

# Identity

Plans organic search programs.
`,
    });

    await syncLibraryFileToGraph(db, { root, relativePath: "agents/marketing-seo-specialist.agent.md" });

    const domainObject = await findLibraryObjectByKey(db, "domain.marketing");
    assert.equal(domainObject?.objectKind, "domain_taxonomy");
    assert.equal(domainObject?.state.scope, "marketing");

    const edges = await findLibraryEdgesFrom(db, "agent.marketing-seo-specialist", "belongs_to_domain", {
      scope: "marketing",
      status: "active",
    });
    assert.deepEqual(
      edges.map((edge) => edge.toObjectKey),
      ["domain.marketing"],
    );
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing refs without writing source or placeholder graph rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    await writeLibraryFile({
      root,
      relativePath: "agents/frontend-developer.agent.md",
      content: `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
allowedToolRefs:
  - tool.workspace-read
---

# Identity
`,
    });

    await assert.rejects(
      syncLibraryFileToGraph(db, { root, relativePath: "agents/frontend-developer.agent.md" }),
      /unresolved Library reference tool\.workspace-read from agent\.frontend-developer/,
    );
    assert.equal(await findLibraryObjectByKey(db, "agent.frontend-developer"), null);
    assert.equal(await findLibraryObjectByKey(db, "tool.workspace-read"), null);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("existing referenced objects are not mutated by file sync", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    await upsertLibraryObject(db, {
      objectKey: "tool.workspace-read",
      objectKind: "tool_definition",
      status: "approved",
      headVersionId: "tool.workspace-read@approved",
      state: { title: "Workspace Read", scope: "global" },
    });
    const content = `---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.safe-placeholder
title: Safe Placeholder
scope: software
status: draft
requiresToolRefs:
  - tool.workspace-read
---

# Instructions
`;

    await writeLibraryFile({ root, relativePath: "skills/safe-placeholder.skill.md", content });
    await syncLibraryFileToGraph(db, { root, relativePath: "skills/safe-placeholder.skill.md" });

    const tool = await findLibraryObjectByKey(db, "tool.workspace-read");
    assert.equal(tool?.status, "approved");
    assert.equal(tool?.headVersionId, "tool.workspace-read@approved");
    assert.equal(tool?.state.title, "Workspace Read");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown referenced object prefixes before writing graph rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    await writeLibraryFile({
      root,
      relativePath: "agents/frontend-developer.agent.md",
      content: `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
capabilityRefs:
  - mystery.react-ui
---

# Identity
`,
    });

    await assert.rejects(
      syncLibraryFileToGraph(db, { root, relativePath: "agents/frontend-developer.agent.md" }),
      /unsupported referenced object key prefix: mystery.react-ui/,
    );
    assert.equal(await findLibraryObjectByKey(db, "agent.frontend-developer"), null);
    assert.equal(await findLibraryObjectByKey(db, "mystery.react-ui"), null);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid files during sync without writing graph rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();

  try {
    await writeLibraryFile({
      root,
      relativePath: "agents/invalid.agent.md",
      content: `---
schemaVersion: southstar.library.agent_definition_file.v1
title: Invalid Agent
scope: software
status: draft
---

# Identity
`,
    });

    await assert.rejects(syncLibraryFileToGraph(db, { root, relativePath: "agents/invalid.agent.md" }), /id: id is required/);
    assert.equal(await findLibraryObjectByKey(db, "agent.invalid"), null);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

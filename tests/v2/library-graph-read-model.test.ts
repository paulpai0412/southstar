import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { buildLibraryGraphReadModel } from "../../src/v2/read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../../src/v2/read-models/library-workspace.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("builds library workspace domains grouped by scope and object kind", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
    await seedObject(db, "tool.browser", "tool_definition", "global", "Browser");

    const model = await buildLibraryWorkspaceReadModel(db, { selectedScope: "software" });

    assert.equal(model.selectedScope, "software");
    assert.deepEqual(
      model.domains.map((domain) => domain.scope),
      ["global", "software"],
    );

    const globalDomain = model.domains.find((domain) => domain.scope === "global");
    const softwareDomain = model.domains.find((domain) => domain.scope === "software");

    assert.equal(globalDomain?.objectKindCounts.tool_definition, 1);
    assert.equal(softwareDomain?.objectKindCounts.agent_definition, 1);
    assert.equal(softwareDomain?.counts.agent_definition, 1);
    assert.deepEqual(
      softwareDomain?.objects.map((object) => object.objectKey),
      ["agent.frontend-developer"],
    );
    assert.deepEqual(
      softwareDomain?.objectGroups.map((group) => [group.objectKind, group.objects.map((object) => object.objectKey)]),
      [["agent_definition", ["agent.frontend-developer"]]],
    );
  } finally {
    await db.close();
  }
});

test("includes missing-scope global objects adjacent to scoped software nodes", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
    await seedObject(db, "tool.implicit-global", "tool_definition", undefined, "Implicit Global");
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "requires_tool",
      toObjectKey: "tool.implicit-global",
      scope: "software",
    });

    const softwareGraph = await buildLibraryGraphReadModel(db, { scope: "software" });

    assert.deepEqual(
      softwareGraph.nodes.map((node) => node.objectKey),
      ["agent.frontend-developer", "tool.implicit-global"],
    );
    assert.deepEqual(
      softwareGraph.edges.map((edge) => [edge.fromObjectKey, edge.edgeType, edge.toObjectKey]),
      [["agent.frontend-developer", "requires_tool", "tool.implicit-global"]],
    );
  } finally {
    await db.close();
  }
});

test("focused scoped graph hides global-only neighborhoods under concrete domains", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedLibraryGraph(db);

    const focusedGlobalGraph = await buildLibraryGraphReadModel(db, {
      scope: "software",
      objectKey: "tool.browser",
      depth: 1,
    });

    assert.deepEqual(focusedGlobalGraph.nodes, []);
    assert.deepEqual(focusedGlobalGraph.edges, []);
  } finally {
    await db.close();
  }
});

test("builds scoped library graph neighborhoods and keeps unconnected global nodes out of domain graphs", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedLibraryGraph(db);

    const softwareNeighborhood = await buildLibraryGraphReadModel(db, {
      scope: "software",
      objectKey: "agent.frontend-developer",
      depth: 1,
    });
    assert.equal(softwareNeighborhood.activeScope, "software");
    assert.deepEqual(softwareNeighborhood.availableScopes, ["all", "global", "research", "software"]);
    assert.deepEqual(
      softwareNeighborhood.nodes.map((node) => node.objectKey),
      ["agent.frontend-developer", "capability.react-ui"],
    );
    assert.deepEqual(
      softwareNeighborhood.edges.map((edge) => [edge.fromObjectKey, edge.edgeType, edge.toObjectKey, edge.scope]),
      [["agent.frontend-developer", "provides_capability", "capability.react-ui", "software"]],
    );

    const researchGraph = await buildLibraryGraphReadModel(db, { scope: "research" });
    assert.deepEqual(
      researchGraph.nodes.map((node) => node.objectKey),
      ["agent.researcher", "capability.web-research"],
    );
    assert.equal(researchGraph.nodes.some((node) => node.objectKey === "agent.frontend-developer"), false);
    assert.equal(researchGraph.nodes.some((node) => node.objectKey === "tool.browser"), false);
    assert.equal(researchGraph.nodes.some((node) => node.objectKey === "tool.global-helper"), false);

    const globalGraph = await buildLibraryGraphReadModel(db, { scope: "global" });
    assert.deepEqual(
      globalGraph.nodes.map((node) => node.objectKey),
      ["tool.browser", "tool.global-helper"],
    );
    assert.deepEqual(
      globalGraph.edges.map((edge) => [edge.fromObjectKey, edge.toObjectKey]),
      [["tool.browser", "tool.global-helper"]],
    );

    const allGraph = await buildLibraryGraphReadModel(db);
    const explicitAllGraph = await buildLibraryGraphReadModel(db, { scope: "all" });
    assert.deepEqual(explicitAllGraph, allGraph);
  } finally {
    await db.close();
  }
});

async function seedLibraryGraph(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
  await seedObject(db, "capability.react-ui", "capability_spec", "software", "React UI");
  await seedObject(db, "agent.researcher", "agent_definition", "research", "Researcher");
  await seedObject(db, "capability.web-research", "capability_spec", "research", "Web Research");
  await seedObject(db, "tool.browser", "tool_definition", "global", "Browser");
  await seedObject(db, "tool.global-helper", "tool_definition", "global", "Global Helper");

  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "provides_capability",
    toObjectKey: "capability.react-ui",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.researcher",
    edgeType: "provides_capability",
    toObjectKey: "capability.web-research",
    scope: "research",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "tool.browser",
    edgeType: "supports_skill",
    toObjectKey: "tool.global-helper",
    scope: "global",
  });
}

async function seedObject(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
  objectKey: string,
  objectKind: Parameters<typeof upsertLibraryObject>[1]["objectKind"],
  scope: string | undefined,
  title: string,
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind,
    status: "approved",
    state: scope === undefined ? { title } : { title, scope },
  });
}

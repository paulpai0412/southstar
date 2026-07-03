import assert from "node:assert/strict";
import test from "node:test";
import {
  listLibraryEdges,
  listLibraryObjects,
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
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
    assert.equal(softwareNeighborhood.edges[0]?.status, "active");

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

test("exposes ontology edge metadata in library graph read model and route", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer");
    await seedObject(db, "skill.react-ui", "skill_spec", "software", "React UI");
    await seedObject(db, "skill.legacy-ui", "skill_spec", "software", "Legacy UI");
    await seedObject(db, "tool.browser", "tool_definition", "software", "Browser");
    await seedObject(db, "workflow.ui-build", "workflow_template", "software", "UI Build");
    await seedObject(db, "workflow.ui-review", "workflow_template", "software", "UI Review");

    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "uses",
      toObjectKey: "skill.react-ui",
      scope: "software",
      metadata: {
        confidence: 0.87,
        rationale: "The frontend agent calls for React UI work.",
        source: "library-import-candidate",
        draftId: "draft-ontology-1",
        evidenceRefs: ["candidate:skill.react-ui"],
      },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "conflicts_with",
      toObjectKey: "skill.legacy-ui",
      scope: "software",
      metadata: {
        ontologyCategory: "conflict",
        sourceKind: "operator-note",
      },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "workflow.ui-build",
      edgeType: "workflow_precedes",
      toObjectKey: "workflow.ui-review",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "similar_to",
      toObjectKey: "tool.browser",
      scope: "software",
      metadata: {
        confidence: 0.42,
      },
    });

    const model = await buildLibraryGraphReadModel(db, { scope: "software" });
    const usesEdge = graphEdge(model, "agent.frontend-developer", "uses", "skill.react-ui");
    assert.deepEqual(usesEdge.ontology, {
      category: "usage",
      confidence: 0.87,
      rationale: "The frontend agent calls for React UI work.",
      source: "library-import-candidate",
      draftId: "draft-ontology-1",
      evidenceRefs: ["candidate:skill.react-ui"],
    });
    assert.deepEqual(graphEdge(model, "skill.react-ui", "conflicts_with", "skill.legacy-ui").ontology, {
      category: "conflict",
      source: "operator-note",
    });
    assert.deepEqual(graphEdge(model, "workflow.ui-build", "workflow_precedes", "workflow.ui-review").ontology, {
      category: "workflow_order",
    });
    assert.deepEqual(graphEdge(model, "skill.react-ui", "similar_to", "tool.browser").ontology, {
      category: "similarity",
      confidence: 0.42,
    });

    const response = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/graph?scope=software"),
    );
    assert.equal(response.status, 200);
    const envelope = await response.json() as any;
    assert.equal(envelope.ok, true);
    assert.deepEqual(
      graphEdge(envelope.result, "agent.frontend-developer", "uses", "skill.react-ui").ontology,
      usesEdge.ontology,
    );
  } finally {
    await db.close();
  }
});

test("filters library graph read model and route by domain kind and status", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedObject(db, "agent.frontend-developer", "agent_definition", "software", "Frontend Developer", "approved");
    await seedObject(db, "agent.draft-planner", "agent_definition", "software", "Draft Planner", "draft");
    await seedObject(db, "skill.react-ui", "skill_spec", "software", "React UI", "approved");
    await seedObject(db, "agent.researcher", "agent_definition", "research", "Researcher", "approved");
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "requires_skill",
      toObjectKey: "skill.react-ui",
      scope: "software",
    });

    const model = await buildLibraryGraphReadModel(db, {
      scope: "software",
      kind: "agent_definition",
      status: "approved",
    });

    assert.deepEqual(
      model.nodes.map((node) => node.objectKey),
      ["agent.frontend-developer"],
    );
    assert.deepEqual(model.edges, []);

    const response = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/graph?scope=software&kind=skill_spec&status=approved"),
    );
    assert.equal(response.status, 200);
    const envelope = await response.json() as any;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.kind, "library-graph");
    assert.deepEqual(
      envelope.result.nodes.map((node: { objectKey: string }) => node.objectKey),
      ["skill.react-ui"],
    );

    const edgeFilteredResponse = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/graph?scope=software&edgeType=requires_skill"),
    );
    assert.equal(edgeFilteredResponse.status, 200);
    const edgeFiltered = await edgeFilteredResponse.json() as any;
    assert.deepEqual(
      edgeFiltered.result.edges.map((edge: { edgeType: string }) => edge.edgeType),
      ["requires_skill"],
    );

    const invalid = await handleRuntimeRoute(
      { db } as any,
      new Request("http://local/api/v2/library/graph?scope=software&kind=nope&status=approved"),
    );
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json() as any).error, /invalid library kind: nope/);
  } finally {
    await db.close();
  }
});

test("list helpers treat all scope as no scope", async () => {
  const db = await createTestPostgresDb();

  try {
    await seedLibraryGraph(db);

    const implicitAllObjects = await listLibraryObjects(db);
    const explicitAllObjects = await listLibraryObjects(db, { scope: "all" });
    assert.deepEqual(
      explicitAllObjects.map((object) => object.objectKey),
      implicitAllObjects.map((object) => object.objectKey),
    );

    const implicitAllEdges = await listLibraryEdges(db);
    const explicitAllEdges = await listLibraryEdges(db, { scope: "all" });
    assert.deepEqual(
      explicitAllEdges.map((edge) => edge.id),
      implicitAllEdges.map((edge) => edge.id),
    );
  } finally {
    await db.close();
  }
});

function graphEdge(
  model: { edges: Array<{ fromObjectKey: string; edgeType: string; toObjectKey: string }> },
  fromObjectKey: string,
  edgeType: string,
  toObjectKey: string,
) {
  const edge = model.edges.find(
    (candidate) =>
      candidate.fromObjectKey === fromObjectKey &&
      candidate.edgeType === edgeType &&
      candidate.toObjectKey === toObjectKey,
  );
  assert.ok(edge, `expected edge ${fromObjectKey} ${edgeType} ${toObjectKey}`);
  return edge as typeof edge & { ontology?: unknown };
}

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
  status: Parameters<typeof upsertLibraryObject>[1]["status"] = "approved",
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind,
    status,
    state: scope === undefined ? { title } : { title, scope },
  });
}

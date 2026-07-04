# Southstar Graph Metadata Runtime Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the existing Library -> Workflow Generate -> runtime execution chain so LLM workflow composition reads compact Postgres graph metadata directly, produces DAG node profiles from approved graph refs, and runtime materializes those selected agent/skill/tool/MCP refs into Docker-visible task snapshots.

**Architecture:** Do not replace the current Library tab, composition, validator, manifest compiler, or Tork hand provider. Extend the existing modules: `resolveWorkflowCandidates()` adds a compact graph metadata packet, `llm-composer` uses that packet as the candidate source, validators keep refs inside the graph closure, and `runtime-library-materializer` plus `agent-runner/materializer` produce immutable task bundles under `/tmp/southstar-runs`.

**Tech Stack:** TypeScript ESM, `tsx`, Postgres `southstar.library_objects` / `library_edges`, existing `src/v2/orchestration/*`, existing `src/v2/agent-runner/*`, Next/Tork runtime task envelopes.

---

## Current Gap Summary

The current code already has these pieces:

- `src/v2/design-library/files/library-file-parser.ts` syncs `.skill.md` files as `skill_spec`.
- `src/v2/design-library/importers/library-import-draft-store.ts` can copy imported skill supporting files to `library/skills/<slug>/...`.
- `src/v2/orchestration/candidate-resolver.ts` already returns `profilePrimitiveCandidates`.
- `src/v2/orchestration/llm-composer.ts` already tells the LLM to compose generated profiles from primitives.
- `src/v2/design-library/profile-composer/generated-profile-validator.ts` already validates `agent -> supports_skill -> skill_spec` and skill-required tool/MCP/instruction refs.
- `src/v2/orchestration/composition-compiler.ts` already synthesizes runtime `AgentProfile` objects for validated generated profile refs.

The missing executable chain:

- The LLM does not yet receive one compact node/edge metadata JSON packet as the primary graph candidate source.
- Runtime materialization still expects `skill_definition`, while imported/file-backed skills are `skill_spec`.
- Runtime materialization does not snapshot imported skill supporting files.
- Task materialization writes only `SKILL.md` and `skill.json`; it does not write `agent-profile/`, `tools/`, `mcp/`, or copied skill bundle files.
- There is no single integration test proving graph metadata -> LLM composition shape -> manifest refs -> runtime snapshot -> Docker-visible task bundle.

---

## File Structure

- Create: `src/v2/orchestration/graph-metadata-packet.ts`
  Builds compact approved Postgres graph node/edge metadata for LLM composition. This is a focused helper used by `candidate-resolver`, not a new orchestration path.
- Modify: `src/v2/design-library/types.ts`
  Add graph metadata packet types to `CandidatePacket`.
- Modify: `src/v2/orchestration/candidate-resolver.ts`
  Include `graphMetadataCandidates` while preserving existing candidate fields for compatibility.
- Modify: `src/v2/orchestration/llm-composer.ts`
  Add `GraphMetadataCandidates` to the composer prompt and bounded packet output.
- Modify: `src/v2/orchestration/composition-validator.ts`
  Treat graph metadata refs as the canonical allowed ref set when present, then keep existing DB closure validation.
- Modify: `src/v2/skills/types.ts`
  Extend `ResolvedSkillSnapshot` with immutable bundle file snapshots.
- Modify: `src/v2/orchestration/runtime-library-materializer.ts`
  Resolve `skill_spec`, derive instructions from body/state, read skill bundle files from the local library root, and return bundle snapshots.
- Modify: `src/v2/context/managed-context-assembler.ts`
  Pass the runtime library root into `materializeTaskLibraryRefs`.
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
  Pass the runtime library root into `materializeTaskLibraryRefs`.
- Modify: `src/v2/agent-runner/materializer.ts`
  Write agent profile, tool policy, MCP grants, and skill bundle files under each task directory.
- Test: `tests/v2/graph-metadata-candidate-packet.test.ts`
- Test: `tests/v2/llm-workflow-composer.test.ts`
- Test: `tests/v2/workflow-dynamic-profile-composition.test.ts`
- Test: `tests/v2/runtime-library-materializer.test.ts`
- Test: `tests/v2/materializer.test.ts`
- Test: `tests/v2/runtime-generated-profile-chain.test.ts`

---

## Task 1: Add Compact Graph Metadata Packet

**Files:**
- Create: `src/v2/orchestration/graph-metadata-packet.ts`
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/orchestration/candidate-resolver.ts`
- Test: `tests/v2/graph-metadata-candidate-packet.test.ts`

- [ ] **Step 1: Write the failing graph packet test**

Create `tests/v2/graph-metadata-candidate-packet.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { buildGraphMetadataCandidatePacket } from "../../src/v2/orchestration/graph-metadata-packet.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("builds compact approved graph metadata nodes and executable edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGraph(db);

    const packet = await buildGraphMetadataCandidatePacket(db, { scope: "engineering" });

    assert.deepEqual(packet.nodes.map((node) => node.ref), [
      "agent.frontend-developer",
      "mcp.filesystem-workspace",
      "skill.react-ui",
      "tool.workspace-write",
    ]);
    assert.deepEqual(packet.edges.map((edge) => `${edge.from}|${edge.type}|${edge.to}`), [
      "agent.frontend-developer|supports_skill|skill.react-ui",
      "skill.react-ui|allows_mcp_grant|mcp.filesystem-workspace",
      "skill.react-ui|requires_tool|tool.workspace-write",
    ]);
    assert.equal(packet.nodes.find((node) => node.ref === "skill.react-ui")?.bodyPreview?.includes("very long"), false);
  } finally {
    await db.close();
  }
});

test("workflow candidate resolver includes graph metadata without removing legacy fields", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedGraph(db);
    await upsertLibraryObject(db, {
      objectKey: "capability.frontend-ui",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.frontend-ui@1",
      state: { scope: "engineering", title: "Frontend UI" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "provides_capability",
      toObjectKey: "capability.frontend-ui",
      scope: "engineering",
    });

    const packet = await resolveWorkflowCandidates(db, {
      scope: "engineering",
      requirementSpec: {
        summary: "Build a todo app",
        workType: "software_feature",
        requiredCapabilities: ["capability.frontend-ui"],
        expectedArtifacts: [],
        acceptanceCriteria: [],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
    });

    assert.equal(packet.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.react-ui"), true);
    assert.equal(packet.profilePrimitiveCandidates?.skills.includes("skill.react-ui"), true);
  } finally {
    await db.close();
  }
});

async function seedGraph(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: {
      scope: "engineering",
      title: "Frontend Developer",
      description: "Builds frontend web applications.",
      aliases: ["react", "ui", "webapp"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: {
      scope: "engineering",
      title: "React UI",
      description: "Implements React UI.",
      body: "# Instructions\n\nUse React.\n\nvery long body should not be sent in full",
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write", toolName: "workspace-write", proxyToolName: "workspace-write-proxy" },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "supports_skill",
    toObjectKey: "skill.react-ui",
    scope: "engineering",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "requires_tool",
    toObjectKey: "tool.workspace-write",
    scope: "engineering",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "allows_mcp_grant",
    toObjectKey: "mcp.filesystem-workspace",
    scope: "engineering",
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.blocked",
    objectKind: "agent_definition",
    status: "blocked",
    headVersionId: "agent.blocked@1",
    state: { scope: "engineering", title: "Blocked" },
  });
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm exec --yes tsx -- tests/v2/graph-metadata-candidate-packet.test.ts
```

Expected: FAIL with module-not-found for `graph-metadata-packet.ts` or missing `graphMetadataCandidates`.

- [ ] **Step 3: Add graph metadata types**

Modify `src/v2/design-library/types.ts`:

```ts
export type GraphMetadataNodeCandidate = {
  ref: string;
  kind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  versionRef: string | null;
  scope: string;
  title: string;
  description?: string;
  aliases: string[];
  bodyPreview?: string;
  runtime?: Record<string, unknown>;
};

export type GraphMetadataEdgeCandidate = {
  from: string;
  type: LibraryEdgeType;
  to: string;
  scope: string;
  weight: number;
  rationale?: string;
};

export type GraphMetadataCandidatePacket = {
  schemaVersion: "southstar.graph_metadata_candidates.v1";
  scope: string;
  nodes: GraphMetadataNodeCandidate[];
  edges: GraphMetadataEdgeCandidate[];
};
```

Then extend `CandidatePacket`:

```ts
  graphMetadataCandidates?: GraphMetadataCandidatePacket;
```

- [ ] **Step 4: Implement graph packet builder**

Create `src/v2/orchestration/graph-metadata-packet.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import type {
  GraphMetadataCandidatePacket,
  GraphMetadataEdgeCandidate,
  GraphMetadataNodeCandidate,
  LibraryDefinitionKind,
} from "../design-library/types.ts";

const INCLUDED_KINDS: ReadonlySet<LibraryDefinitionKind> = new Set([
  "agent_definition",
  "agent_profile",
  "skill_spec",
  "tool_definition",
  "mcp_tool_grant",
  "instruction_template",
  "artifact_contract",
  "evaluator_profile",
  "capability_spec",
  "policy_bundle",
  "workflow_template",
  "vault_lease_policy",
]);

const BODY_PREVIEW_CHARS = 280;

export async function buildGraphMetadataCandidatePacket(
  db: SouthstarDb,
  input: { scope: string },
): Promise<GraphMetadataCandidatePacket> {
  const objects = (await listLibraryObjects(db, { scope: input.scope, status: "approved" }))
    .filter((object) => INCLUDED_KINDS.has(object.objectKind));
  const objectKeys = new Set(objects.map((object) => object.objectKey));
  const edges = (await listLibraryEdges(db, { scope: input.scope, status: "active" }))
    .filter((edge) => objectKeys.has(edge.fromObjectKey) && objectKeys.has(edge.toObjectKey));

  return {
    schemaVersion: "southstar.graph_metadata_candidates.v1",
    scope: input.scope,
    nodes: objects.map(toNode).sort((left, right) => left.ref.localeCompare(right.ref)),
    edges: edges.map(toEdge).sort((left, right) => `${left.from}|${left.type}|${left.to}`.localeCompare(`${right.from}|${right.type}|${right.to}`)),
  };
}

function toNode(object: Awaited<ReturnType<typeof listLibraryObjects>>[number]): GraphMetadataNodeCandidate {
  const state = object.state;
  const title = stringValue(state.title) ?? stringValue(state.displayName) ?? object.objectKey;
  const body = stringValue(state.body);
  return {
    ref: object.objectKey,
    kind: object.objectKind,
    status: object.status,
    versionRef: object.headVersionId,
    scope: stringValue(state.scope) ?? "global",
    title,
    ...(stringValue(state.description) ? { description: stringValue(state.description) } : {}),
    aliases: stringArray(state.aliases),
    ...(body ? { bodyPreview: body.slice(0, BODY_PREVIEW_CHARS) } : {}),
    runtime: compactRuntimeState(object.objectKind, state),
  };
}

function toEdge(edge: Awaited<ReturnType<typeof listLibraryEdges>>[number]): GraphMetadataEdgeCandidate {
  return {
    from: edge.fromObjectKey,
    type: edge.edgeType,
    to: edge.toObjectKey,
    scope: edge.scope,
    weight: edge.weight,
    ...(stringValue(edge.metadata.rationale) ? { rationale: stringValue(edge.metadata.rationale) } : {}),
  };
}

function compactRuntimeState(kind: LibraryDefinitionKind, state: Record<string, unknown>): Record<string, unknown> {
  if (kind === "tool_definition") {
    return pickDefined(state, ["toolName", "proxyToolName", "allowedCommands", "access"]);
  }
  if (kind === "mcp_tool_grant") {
    return pickDefined(state, ["serverId", "allowedTools"]);
  }
  if (kind === "skill_spec") {
    return pickDefined(state, ["allowedTools", "requiredMounts", "mcpRequirements", "artifactContracts", "sourcePath", "assetBundlePath"]);
  }
  if (kind === "agent_definition") {
    return pickDefined(state, ["runtimeRole"]);
  }
  if (kind === "agent_profile") {
    return pickDefined(state, ["runtimeProfile", "agentRef", "skillRefs", "toolGrantRefs", "mcpGrantRefs", "instructionRefs"]);
  }
  return {};
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
```

- [ ] **Step 5: Attach graph packet to existing candidate resolver**

Modify `src/v2/orchestration/candidate-resolver.ts`:

```ts
import { buildGraphMetadataCandidatePacket } from "./graph-metadata-packet.ts";
```

Inside `resolveWorkflowCandidates()`, before `return`:

```ts
  const graphMetadataCandidates = await buildGraphMetadataCandidatePacket(db, { scope: input.scope });
```

Add it to the return object:

```ts
    graphMetadataCandidates,
```

- [ ] **Step 6: Run the test and commit**

Run:

```bash
npm exec --yes tsx -- tests/v2/graph-metadata-candidate-packet.test.ts
npm exec --yes tsc --noEmit --pretty false
```

Expected: both commands exit 0.

Commit:

```bash
git add src/v2/orchestration/graph-metadata-packet.ts src/v2/design-library/types.ts src/v2/orchestration/candidate-resolver.ts tests/v2/graph-metadata-candidate-packet.test.ts
git commit -m "feat: add workflow graph metadata candidates"
```

---

## Task 2: Make LLM Composition Use Graph Metadata JSON

**Files:**
- Modify: `src/v2/orchestration/llm-composer.ts`
- Test: `tests/v2/llm-workflow-composer.test.ts`

- [ ] **Step 1: Add failing composer prompt assertions**

In `tests/v2/llm-workflow-composer.test.ts`, update the existing prompt test or add:

```ts
test("LLM composer prompt includes graph metadata candidates as the direct ref source", async () => {
  const prompts: string[] = [];
  const composer = createLlmWorkflowComposer({
    complete: async (messages) => {
      prompts.push(messages.map((message) => message.content).join("\n"));
      return JSON.stringify(validCompositionPlan());
    },
  });

  await composer.compose({
    goalPrompt: "build todo app",
    candidatePacket: {
      ...candidatePacket(),
      graphMetadataCandidates: {
        schemaVersion: "southstar.graph_metadata_candidates.v1",
        scope: "software",
        nodes: [
          { ref: "agent.frontend-developer", kind: "agent_definition", status: "approved", versionRef: "agent.frontend-developer@1", scope: "software", title: "Frontend Developer", aliases: [] },
          { ref: "skill.react-ui", kind: "skill_spec", status: "approved", versionRef: "skill.react-ui@1", scope: "software", title: "React UI", aliases: [] },
          { ref: "tool.workspace-write", kind: "tool_definition", status: "approved", versionRef: "tool.workspace-write@1", scope: "global", title: "Workspace Write", aliases: [] },
        ],
        edges: [
          { from: "agent.frontend-developer", type: "supports_skill", to: "skill.react-ui", scope: "software", weight: 1 },
          { from: "skill.react-ui", type: "requires_tool", to: "tool.workspace-write", scope: "software", weight: 1 },
        ],
      },
    },
  });

  assert.match(prompts[0] ?? "", /GraphMetadataCandidates:/);
  assert.match(prompts[0] ?? "", /agent\.frontend-developer/);
  assert.match(prompts[0] ?? "", /supports_skill/);
  assert.match(prompts[0] ?? "", /Use GraphMetadataCandidates as the direct source of selectable refs/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm exec --yes tsx -- tests/v2/llm-workflow-composer.test.ts
```

Expected: FAIL because the prompt does not contain `GraphMetadataCandidates`.

- [ ] **Step 3: Add graph metadata prompt instructions**

Modify `renderComposerPrompt()` in `src/v2/orchestration/llm-composer.ts` so the instruction block includes:

```ts
    "Use GraphMetadataCandidates as the direct source of selectable refs for DAG tasks and generated profiles.",
    "Every selected agentDefinitionRef, agentProfileRef, skillRef, toolGrantRef, mcpGrantRef, instructionRef, artifact ref, and evaluator ref must come from GraphMetadataCandidates.nodes when that packet is present.",
    "Use GraphMetadataCandidates.edges to justify profile closure: agent supports skill, skill requires tools, skill allows MCP grants, and skill uses instructions.",
```

Add the packet section before `CandidatePacket:`:

```ts
    "GraphMetadataCandidates:",
    JSON.stringify(boundedPacket.graphMetadataCandidates ?? {
      schemaVersion: "southstar.graph_metadata_candidates.v1",
      scope: "none",
      nodes: [],
      edges: [],
    }),
    "",
```

- [ ] **Step 4: Bound graph metadata size**

In `boundCandidatePacket()`, preserve a compact graph packet:

```ts
    graphMetadataCandidates: packet.graphMetadataCandidates
      ? {
        ...packet.graphMetadataCandidates,
        nodes: packet.graphMetadataCandidates.nodes.slice(0, 500),
        edges: packet.graphMetadataCandidates.edges.slice(0, 1_500),
      }
      : undefined,
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm exec --yes tsx -- tests/v2/llm-workflow-composer.test.ts
npm exec --yes tsc --noEmit --pretty false
```

Expected: both commands exit 0.

Commit:

```bash
git add src/v2/orchestration/llm-composer.ts tests/v2/llm-workflow-composer.test.ts
git commit -m "feat: compose workflows from graph metadata packet"
```

---

## Task 3: Validate LLM Output Against Graph Metadata Refs And Closure

**Files:**
- Modify: `src/v2/orchestration/composition-validator.ts`
- Test: `tests/v2/workflow-dynamic-profile-composition.test.ts`

- [ ] **Step 1: Add failing validation tests**

Add these tests to `tests/v2/workflow-dynamic-profile-composition.test.ts`:

```ts
test("workflow composition rejects generated profile refs absent from graph metadata candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    packet.graphMetadataCandidates = {
      schemaVersion: "southstar.graph_metadata_candidates.v1",
      scope: "software",
      nodes: packet.graphMetadataCandidates!.nodes.filter((node) => node.ref !== "skill.react-ui"),
      edges: packet.graphMetadataCandidates!.edges.filter((edge) => edge.from !== "skill.react-ui" && edge.to !== "skill.react-ui"),
    };

    const validation = await validateWorkflowCompositionPlan(db, packet, generatedProfilePlan(), { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "ref_not_in_candidate_packet" && issue.message.includes("skill.react-ui")), true);
  } finally {
    await db.close();
  }
});

test("workflow composition rejects generated profile that ignores graph metadata conflict edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedDynamicPrimitives(db);
    await upsertLibraryObject(db, {
      objectKey: "skill.legacy-ui",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.legacy-ui@1",
      state: { scope: "software", title: "Legacy UI" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "supports_skill",
      toObjectKey: "skill.legacy-ui",
      scope: "software",
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react-ui",
      edgeType: "conflicts_with",
      toObjectKey: "skill.legacy-ui",
      scope: "software",
    });
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: requirementSpec(),
      scope: "software",
    });
    const plan = generatedProfilePlan();
    plan.tasks[0]!.skillRefs = ["skill.react-ui", "skill.legacy-ui"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });

    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "conflicting_refs"), true);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npm exec --yes tsx -- tests/v2/workflow-dynamic-profile-composition.test.ts
```

Expected: FAIL because graph metadata candidate refs and conflict edges are not yet enforced.

- [ ] **Step 3: Use graph metadata refs as the allowed set**

In `src/v2/orchestration/composition-validator.ts`, add:

```ts
function graphMetadataRefSet(packet: CandidatePacket): Set<string> | null {
  if (!packet.graphMetadataCandidates) return null;
  return new Set(packet.graphMetadataCandidates.nodes.map((node) => node.ref));
}
```

Where the validator currently builds `candidateRefSet`, merge the graph metadata set:

```ts
  const metadataRefs = graphMetadataRefSet(packet);
  const candidateRefSet = metadataRefs ?? buildLegacyCandidateRefSet(packet);
```

Keep the old candidate set builder as `buildLegacyCandidateRefSet()` so existing tests and callers without graph metadata continue to work.

- [ ] **Step 4: Reject conflicting and incompatible refs**

Add this helper:

```ts
function validateGraphMetadataConflictEdges(
  packet: CandidatePacket,
  task: WorkflowCompositionPlan["tasks"][number],
  taskIndex: number,
  issues: WorkflowCompositionValidationIssue[],
): void {
  const graph = packet.graphMetadataCandidates;
  if (!graph) return;
  const selected = new Set([
    task.agentDefinitionRef,
    task.agentProfileRef,
    ...task.instructionRefs,
    ...task.skillRefs,
    ...task.toolGrantRefs,
    ...task.mcpGrantRefs,
    ...task.vaultLeasePolicyRefs,
    ...task.inputArtifactRefs,
    ...task.outputArtifactRefs,
    task.evaluatorProfileRef,
  ]);
  for (const edge of graph.edges) {
    if (edge.type !== "conflicts_with" && edge.type !== "incompatible_with") continue;
    if (selected.has(edge.from) && selected.has(edge.to)) {
      issues.push(issue("conflicting_refs", `tasks.${taskIndex}`, `${edge.from} ${edge.type} ${edge.to}`));
    }
  }
}
```

Call it for every task after selected refs are checked:

```ts
    validateGraphMetadataConflictEdges(packet, task, taskIndex, issues);
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm exec --yes tsx -- tests/v2/workflow-dynamic-profile-composition.test.ts
npm exec --yes tsc --noEmit --pretty false
```

Expected: both commands exit 0.

Commit:

```bash
git add src/v2/orchestration/composition-validator.ts tests/v2/workflow-dynamic-profile-composition.test.ts
git commit -m "fix: validate compositions against graph metadata"
```

---

## Task 4: Materialize `skill_spec` And Skill Bundle Files At Runtime

**Files:**
- Modify: `src/v2/skills/types.ts`
- Modify: `src/v2/orchestration/runtime-library-materializer.ts`
- Modify: `src/v2/context/managed-context-assembler.ts`
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
- Test: `tests/v2/runtime-library-materializer.test.ts`

- [ ] **Step 1: Add failing runtime materializer tests**

Add to `tests/v2/runtime-library-materializer.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";

test("runtime materializer resolves approved skill_spec body and supporting bundle files", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-root-"));
  try {
    await mkdir(join(libraryRoot, "skills", "react-ui", "references"), { recursive: true });
    await writeFile(join(libraryRoot, "skills", "react-ui", "references", "patterns.md"), "Use controlled inputs.", "utf8");
    await upsertLibraryObject(db, {
      objectKey: "skill.react-ui",
      objectKind: "skill_spec",
      status: "approved",
      headVersionId: "skill.react-ui@1",
      state: {
        scope: "software",
        title: "React UI",
        body: "# Instructions\n\nBuild React UI.",
        sourcePath: "library/skills/react-ui.skill.md",
        assetBundlePath: "library/skills/react-ui",
        allowedTools: ["workspace-write"],
        requiredMounts: ["workspace"],
        mcpRequirements: ["filesystem-workspace"],
        artifactContracts: ["artifact.web_app"],
      },
    });

    const materialized = await materializeTaskLibraryRefs(db, {
      runId: "run-skill-spec",
      taskId: "task-ui",
      sessionId: "session-skill-spec",
      libraryRoot,
      instructionRefs: [],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
    });

    assert.equal(materialized.skills[0]?.skillId, "skill.react-ui");
    assert.match(materialized.skills[0]?.instructions ?? "", /Build React UI/);
    assert.deepEqual(materialized.skills[0]?.allowedTools, ["workspace-write"]);
    assert.equal(materialized.skills[0]?.bundleFiles?.[0]?.relativePath, "references/patterns.md");
    assert.equal(Buffer.from(materialized.skills[0]?.bundleFiles?.[0]?.contentBase64 ?? "", "base64").toString("utf8"), "Use controlled inputs.");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm exec --yes tsx -- tests/v2/runtime-library-materializer.test.ts
```

Expected: FAIL because `materializeTaskLibraryRefs` expects `skill_definition` and has no `libraryRoot` / `bundleFiles`.

- [ ] **Step 3: Extend `ResolvedSkillSnapshot`**

Modify `src/v2/skills/types.ts`:

```ts
export type SkillBundleFileSnapshot = {
  relativePath: string;
  contentBase64: string;
  contentHash: string;
};

export type ResolvedSkillSnapshot = SkillSourceDefinition & {
  contentHash: string;
  mountPath: string;
  sourcePath?: string;
  assetBundlePath?: string;
  bundleFiles?: SkillBundleFileSnapshot[];
};
```

- [ ] **Step 4: Extend materializer input**

Modify `MaterializeTaskLibraryRefsInput` in `src/v2/orchestration/runtime-library-materializer.ts`:

```ts
  libraryRoot?: string;
```

Add imports:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
```

- [ ] **Step 5: Resolve skill specs and preserve old seed compatibility**

Replace the current skill loop in `runtime-library-materializer.ts` with:

```ts
  const skills: ResolvedSkillSnapshot[] = [];
  for (const skillRef of unique(input.skillRefs)) {
    const object = await approvedSkillObject(db, skillRef);
    const instructionsText = skillInstructions(object.state);
    const sourcePath = optionalStringField(object.state, "sourcePath");
    const assetBundlePath = optionalStringField(object.state, "assetBundlePath") ?? defaultSkillAssetBundlePath(object.objectKey);
    const bundleFiles = await readSkillBundleFiles(input.libraryRoot, assetBundlePath);
    skills.push({
      skillId: object.objectKey,
      version: object.headVersionId ?? "runtime",
      instructions: instructionsText,
      allowedTools: optionalStringArray(object.state, "allowedTools"),
      requiredMounts: optionalStringArray(object.state, "requiredMounts"),
      mcpRequirements: optionalStringArray(object.state, "mcpRequirements"),
      artifactContracts: optionalStringArray(object.state, "artifactContracts"),
      contentHash: sha256(JSON.stringify({ skillRef: object.objectKey, instructions: instructionsText, bundleFiles })),
      mountPath: `/skills/${object.objectKey}`,
      ...(sourcePath ? { sourcePath } : {}),
      ...(assetBundlePath ? { assetBundlePath } : {}),
      ...(bundleFiles.length > 0 ? { bundleFiles } : {}),
    });
  }
```

Add helpers:

```ts
async function approvedSkillObject(db: SouthstarDb, objectKey: string): Promise<LibraryObjectSummary> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object || object.status !== "approved") throw new Error(`missing approved library object: ${objectKey}`);
  if (object.objectKind !== "skill_spec" && object.objectKind !== "skill_definition") {
    throw new Error(`library object kind mismatch for ${objectKey}: expected skill_spec, got ${object.objectKind}`);
  }
  return object;
}

function skillInstructions(state: Record<string, unknown>): string {
  const direct = optionalStringField(state, "instructions");
  if (direct) return direct;
  const structured = state.instructions;
  if (structured && typeof structured === "object" && typeof (structured as { content?: unknown }).content === "string") {
    return (structured as { content: string }).content;
  }
  const body = optionalStringField(state, "body");
  if (body) return body;
  throw new Error("invalid instructions");
}

function optionalStringArray(state: Record<string, unknown>, field: string): string[] {
  const value = state[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalStringField(state: Record<string, unknown>, field: string): string | undefined {
  const value = state[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultSkillAssetBundlePath(objectKey: string): string | undefined {
  if (!objectKey.startsWith("skill.")) return undefined;
  const slug = objectKey.slice("skill.".length).replaceAll(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
  return `library/skills/${slug}`;
}

async function readSkillBundleFiles(libraryRoot: string | undefined, assetBundlePath: string | undefined): Promise<ResolvedSkillSnapshot["bundleFiles"]> {
  if (!libraryRoot || !assetBundlePath) return [];
  const root = resolve(libraryRoot);
  const relativeBundle = assetBundlePath.replace(/^library\//, "");
  const bundleRoot = resolve(root, relativeBundle);
  if (!isWithinRoot(bundleRoot, root)) throw new Error(`skill asset bundle escapes library root: ${assetBundlePath}`);
  try {
    const stats = await stat(bundleRoot);
    if (!stats.isDirectory()) return [];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return await collectSkillBundleFiles(bundleRoot, bundleRoot);
}

async function collectSkillBundleFiles(directory: string, root: string): Promise<NonNullable<ResolvedSkillSnapshot["bundleFiles"]>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: NonNullable<ResolvedSkillSnapshot["bundleFiles"]> = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSkillBundleFiles(absolutePath, root));
      continue;
    }
    if (!entry.isFile()) continue;
    const content = await readFile(absolutePath);
    files.push({
      relativePath: relative(root, absolutePath).split(/[\\/]+/g).join("/"),
      contentBase64: content.toString("base64"),
      contentHash: sha256(content),
    });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
```

- [ ] **Step 6: Pass library root from runtime callers**

In both `src/v2/context/managed-context-assembler.ts` and `src/v2/ui-api/postgres-task-envelope.ts`, pass:

```ts
        libraryRoot: process.env.SOUTHSTAR_LIBRARY_ROOT ?? `${process.cwd()}/library`,
```

inside the `materializeTaskLibraryRefs()` input object.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
npm exec --yes tsx -- tests/v2/runtime-library-materializer.test.ts
npm exec --yes tsc --noEmit --pretty false
```

Expected: both commands exit 0.

Commit:

```bash
git add src/v2/skills/types.ts src/v2/orchestration/runtime-library-materializer.ts src/v2/context/managed-context-assembler.ts src/v2/ui-api/postgres-task-envelope.ts tests/v2/runtime-library-materializer.test.ts
git commit -m "fix: materialize skill specs with bundle snapshots"
```

---

## Task 5: Write Docker-Visible Runtime Task Bundles

**Files:**
- Modify: `src/v2/agent-runner/materializer.ts`
- Test: `tests/v2/materializer.test.ts`

- [ ] **Step 1: Add failing v2 bundle materialization test**

Add to `tests/v2/materializer.test.ts`:

```ts
import type { TaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";

test("materializes v2 task profile, tools, MCP grants, and skill bundle files for Docker mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-materializer-v2-"));
  const envelope = minimalEnvelopeV2();

  const result = await materializeTaskEnvelope(envelope, { runRoot: root });

  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "agent-profile", "profile.json"), "utf8")), envelope.agentProfile);
  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "tools", "tool-policy.json"), "utf8")), envelope.toolProxyPolicy);
  assert.deepEqual(JSON.parse(await readFile(join(result.taskDir, "mcp", "grants.json"), "utf8")), envelope.mcpGrants);
  assert.equal(await readFile(join(result.taskDir, "skills", "skill.react-ui", "references", "patterns.md"), "utf8"), "Use controlled inputs.");
});

function minimalEnvelopeV2(): TaskEnvelopeV2 {
  return {
    schemaVersion: "southstar.task-envelope.v2",
    runId: "run-v2",
    workflowId: "workflow-v2",
    taskId: "task-v2",
    domain: "software",
    intent: "implement_feature",
    role: {
      id: "frontend-developer",
      responsibility: "Build UI",
      defaultAgentProfileRef: "profile.generated.todo.task-v2",
      allowedAgentProfileRefs: ["profile.generated.todo.task-v2"],
      artifactInputs: [],
      artifactOutputs: ["web_app"],
      stopAuthority: "can-suggest",
    },
    agentProfile: {
      id: "profile.generated.todo.task-v2",
      name: "Todo UI",
      provider: "codex",
      model: "gpt-5",
      harnessRef: "codex",
      agentsMdRefs: [],
      promptTemplateRef: "instruction.react-review",
      skillRefs: ["skill.react-ui"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      memoryScopes: [],
      contextPolicyRef: "context.generated",
      sessionPolicyRef: "session.generated",
      toolPolicy: { allowedTools: ["tool.workspace-write"], deniedTools: [], requiresApprovalFor: [] },
      budgetPolicy: { maxInputTokens: 12000, maxOutputTokens: 2000, maxWallTimeSeconds: 900 },
      instruction: "Build the UI.",
    },
    harness: {
      id: "codex",
      kind: "codex",
      entrypoint: "southstar-agent-runner",
      image: "southstar-agent-runner",
      capabilities: ["workspace"],
      inputProtocol: "task-envelope-v2",
      eventProtocol: "southstar-events-v1",
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    },
    contextPacket: {
      id: "ctx-v2",
      runId: "run-v2",
      taskId: "task-v2",
      rootSessionId: "session-v2",
      executionAttempt: 1,
      roleRef: "frontend-developer",
      agentProfileRef: "profile.generated.todo.task-v2",
      taskGoal: "Build todo app",
      roleInstruction: "Build UI",
      systemInstruction: "instruction.react-review",
      agentsMdBlocks: [],
      artifactContracts: [],
      selectedMemories: [],
      priorArtifacts: [],
      skillInstructions: [],
      mcpGrantSummary: [],
      forbiddenActions: [],
      budget: { maxInputTokens: 12000, maxOutputTokens: 2000, maxWallTimeSeconds: 900 },
      tokenEstimate: { total: 0, bySourceType: {} },
      excludedCandidates: [],
      managedSourceRefs: [],
    },
    agentPrompt: "Build todo app",
    skills: [{
      skillId: "skill.react-ui",
      version: "skill.react-ui@1",
      instructions: "Build React UI.",
      allowedTools: ["workspace-write"],
      requiredMounts: ["workspace"],
      mcpRequirements: ["filesystem-workspace"],
      artifactContracts: [],
      contentHash: "hash",
      mountPath: "/skills/skill.react-ui",
      bundleFiles: [{
        relativePath: "references/patterns.md",
        contentBase64: Buffer.from("Use controlled inputs.", "utf8").toString("base64"),
        contentHash: "bundle-hash",
      }],
    }],
    mcpGrants: [{ serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] }],
    vaultLeases: [],
    toolProxyPolicy: {
      schemaVersion: "southstar.tool_proxy_policy.v1",
      runId: "run-v2",
      sessionId: "session-v2",
      allowedTools: ["workspace-write"],
      requiredProxyTools: ["workspace-write-proxy"],
      forbiddenDirectEnvKeys: [],
      vaultLeaseRefs: [],
      maxLeaseTtlSeconds: 900,
      redactResultPayloads: true,
      failClosed: true,
    },
    materializedLibraryRefs: {
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: [],
    },
    artifactContracts: [],
    evaluatorPipeline: { id: "evaluator.generated", evaluators: [], onFailure: { defaultStrategy: "ask-human" } },
    session: { sessionId: "session-v2", maxRepairAttempts: 1 },
  };
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm exec --yes tsx -- tests/v2/materializer.test.ts
```

Expected: FAIL because `agent-profile/profile.json`, `tools/tool-policy.json`, `mcp/grants.json`, and bundle files are not written.

- [ ] **Step 3: Write v2 runtime bundle files**

Modify `src/v2/agent-runner/materializer.ts`:

```ts
  if (envelope.schemaVersion === "southstar.task-envelope.v2") {
    await writeFile(join(taskDir, "context-packet.json"), JSON.stringify(envelope.contextPacket, null, 2));
    await mkdir(join(taskDir, "agent-profile"), { recursive: true });
    await writeFile(join(taskDir, "agent-profile", "profile.json"), JSON.stringify(envelope.agentProfile, null, 2));
    if (envelope.toolProxyPolicy) {
      await mkdir(join(taskDir, "tools"), { recursive: true });
      await writeFile(join(taskDir, "tools", "tool-policy.json"), JSON.stringify(envelope.toolProxyPolicy, null, 2));
    }
    await mkdir(join(taskDir, "mcp"), { recursive: true });
    await writeFile(join(taskDir, "mcp", "grants.json"), JSON.stringify(envelope.mcpGrants, null, 2));
  }
```

Keep it inside the existing v2 branch and before returning.

- [ ] **Step 4: Write skill bundle files safely**

Inside the existing skill loop in `src/v2/agent-runner/materializer.ts`, after `skill.json`:

```ts
    for (const file of skill.bundleFiles ?? []) {
      const filePath = resolveChildPath(skillDir, file.relativePath, "skill bundle file");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from(file.contentBase64, "base64"));
    }
```

Update imports:

```ts
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
```

Add helper:

```ts
function resolveChildPath(parentDir: string, childPath: string, label: string): string {
  if (!childPath || childPath.includes("\0")) throw new Error(`invalid ${label}: ${childPath}`);
  const root = resolve(parentDir);
  const target = resolve(root, childPath);
  const relativeTarget = relative(root, target);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) throw new Error(`invalid ${label}: ${childPath}`);
  return target;
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm exec --yes tsx -- tests/v2/materializer.test.ts
npm exec --yes tsc --noEmit --pretty false
```

Expected: both commands exit 0.

Commit:

```bash
git add src/v2/agent-runner/materializer.ts tests/v2/materializer.test.ts
git commit -m "feat: materialize runtime task bundles"
```

---

## Task 6: Prove The Full Existing Chain End-To-End In Tests

**Files:**
- Create: `tests/v2/runtime-generated-profile-chain.test.ts`

- [ ] **Step 1: Write the end-to-end chain test**

Create `tests/v2/runtime-generated-profile-chain.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeTaskEnvelope } from "../../src/v2/agent-runner/materializer.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { materializeTaskLibraryRefs } from "../../src/v2/orchestration/runtime-library-materializer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import { buildTaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("graph metadata composition refs materialize into Docker-visible task bundle", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-root-"));
  const runRoot = await mkdtemp(join(tmpdir(), "southstar-run-root-"));
  try {
    await seedExecutableGraph(db, libraryRoot);
    const candidatePacket = await resolveWorkflowCandidates(db, {
      scope: "software",
      requirementSpec: {
        summary: "Build todo web app",
        workType: "software_feature",
        requiredCapabilities: ["capability.frontend-ui"],
        expectedArtifacts: ["artifact.web_app"],
        acceptanceCriteria: ["Todo app works"],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
    });

    assert.equal(candidatePacket.graphMetadataCandidates?.nodes.some((node) => node.ref === "skill.react-ui"), true);

    const composition = generatedCompositionPlan();
    const validation = await validateWorkflowCompositionPlan(db, candidatePacket, composition, { scope: "software" });
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));

    const compiled = await compileWorkflowComposition(db, {
      runId: "run-chain",
      goalPrompt: "Build todo web app",
      candidatePacket,
      composition,
      scope: "software",
    });
    const task = compiled.workflow.tasks[0]!;
    const profile = compiled.workflow.agentProfiles!.find((candidate) => candidate.id === task.agentProfileRef)!;
    const role = compiled.workflow.roles!.find((candidate) => candidate.id === task.roleRef)!;
    const materialized = await materializeTaskLibraryRefs(db, {
      runId: "run-chain",
      taskId: task.id,
      sessionId: "session-chain",
      libraryRoot,
      instructionRefs: task.instructionRefs,
      skillRefs: task.skillRefs,
      toolGrantRefs: task.toolGrantRefs,
      mcpGrantRefs: task.mcpGrantRefs,
      vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
    });
    const envelope = buildTaskEnvelopeV2({
      runId: "run-chain",
      workflowId: compiled.workflow.workflowId,
      taskId: task.id,
      domain: "software",
      intent: "implement_feature",
      role,
      agentProfile: profile,
      harness: compiled.workflow.harnessDefinitions[0]!,
      contextPacket: {
        id: "ctx-chain",
        runId: "run-chain",
        taskId: task.id,
        rootSessionId: "session-chain",
        executionAttempt: 1,
        roleRef: role.id,
        agentProfileRef: profile.id,
        taskGoal: "Build todo web app",
        roleInstruction: role.responsibility,
        systemInstruction: profile.promptTemplateRef,
        agentsMdBlocks: [],
        artifactContracts: [],
        selectedMemories: [],
        priorArtifacts: [],
        skillInstructions: [],
        mcpGrantSummary: [],
        forbiddenActions: [],
        budget: profile.budgetPolicy,
        tokenEstimate: { total: 0, bySourceType: {} },
        excludedCandidates: [],
        managedSourceRefs: [],
      },
      skills: materialized.skills,
      mcpGrants: materialized.mcpGrants,
      vaultLeases: materialized.vaultLeases,
      toolProxyPolicy: materialized.toolProxyPolicy,
      materializedLibraryRefs: {
        instructionRefs: task.instructionRefs,
        skillRefs: task.skillRefs,
        toolGrantRefs: task.toolGrantRefs,
        mcpGrantRefs: task.mcpGrantRefs,
        vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
      },
      artifactContracts: [],
      evaluatorPipeline: { id: "evaluator.generated", evaluators: [], onFailure: { defaultStrategy: "ask-human" } },
      session: { sessionId: "session-chain", maxRepairAttempts: 1 },
    });

    const taskMaterialization = await materializeTaskEnvelope(envelope, { runRoot });

    assert.match(await readFile(join(taskMaterialization.taskDir, "skills", "skill.react-ui", "SKILL.md"), "utf8"), /Build React UI/);
    assert.equal(await readFile(join(taskMaterialization.taskDir, "skills", "skill.react-ui", "references", "patterns.md"), "utf8"), "Use controlled inputs.");
    assert.equal(JSON.parse(await readFile(join(taskMaterialization.taskDir, "tools", "tool-policy.json"), "utf8")).allowedTools.includes("workspace-write"), true);
    assert.equal(JSON.parse(await readFile(join(taskMaterialization.taskDir, "mcp", "grants.json"), "utf8"))[0].serverId, "filesystem-workspace");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
    await rm(runRoot, { recursive: true, force: true });
  }
});

function generatedCompositionPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Todo web app",
    selectedWorkflowTemplateRef: "template.dynamic-single-task",
    rationale: "Use graph metadata candidates.",
    tasks: [{
      id: "implement-ui",
      name: "Implement UI",
      responsibility: "Build todo web app UI",
      dependsOn: [],
      templateSlotRef: "implement",
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.todo.implement-ui",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.web_app"],
      evaluatorProfileRef: "evaluator.web-app",
      recoveryStrategyRefs: [],
      rationale: "Frontend agent uses React skill and workspace write access.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.todo.implement-ui",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from graph metadata.",
      validationStatus: "validated",
    }],
  };
}

async function seedExecutableGraph(db: Awaited<ReturnType<typeof createTestPostgresDb>>, libraryRoot: string) {
  await mkdir(join(libraryRoot, "skills", "react-ui", "references"), { recursive: true });
  await writeFile(join(libraryRoot, "skills", "react-ui", "references", "patterns.md"), "Use controlled inputs.", "utf8");
  await upsertLibraryObject(db, {
    objectKey: "template.dynamic-single-task",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.dynamic-single-task@1",
    state: { scope: "software", title: "Dynamic Single Task" },
  });
  await upsertLibraryObject(db, {
    objectKey: "capability.frontend-ui",
    objectKind: "capability_spec",
    status: "approved",
    headVersionId: "capability.frontend-ui@1",
    state: { scope: "software", title: "Frontend UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: {
      scope: "software",
      title: "Frontend Developer",
      runtimeRole: {
        id: "frontend-developer",
        responsibility: "Build frontend UI",
        defaultAgentProfileRef: "profile.generated.todo.implement-ui",
        allowedAgentProfileRefs: ["profile.generated.todo.implement-ui"],
        artifactInputs: [],
        artifactOutputs: ["web_app"],
        stopAuthority: "can-suggest",
      },
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: {
      scope: "software",
      title: "React UI",
      body: "# Instructions\n\nBuild React UI.",
      assetBundlePath: "library/skills/react-ui",
      allowedTools: ["workspace-write"],
      requiredMounts: ["workspace"],
      mcpRequirements: ["filesystem-workspace"],
      artifactContracts: ["artifact.web_app"],
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write", toolName: "workspace-write", proxyToolName: "workspace-write-proxy" },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review", content: "Use React best practices.", variables: [] },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.web_app",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.web_app@1",
    state: { scope: "software", title: "Web App" },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.web-app",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.web-app@1",
    state: { scope: "software", title: "Web App Evaluator" },
  });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "provides_capability", toObjectKey: "capability.frontend-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "uses_instruction", toObjectKey: "instruction.react-review", scope: "software" });
}
```

- [ ] **Step 2: Run the test and verify it passes after Tasks 1-5**

Run:

```bash
npm exec --yes tsx -- tests/v2/runtime-generated-profile-chain.test.ts
```

Expected: PASS. If it fails, fix the exact gap in the module named by the stack trace before continuing.

- [ ] **Step 3: Run focused regression tests**

Run:

```bash
npm exec --yes tsx -- tests/v2/graph-metadata-candidate-packet.test.ts
npm exec --yes tsx -- tests/v2/llm-workflow-composer.test.ts
npm exec --yes tsx -- tests/v2/workflow-dynamic-profile-composition.test.ts
npm exec --yes tsx -- tests/v2/runtime-library-materializer.test.ts
npm exec --yes tsx -- tests/v2/materializer.test.ts
npm exec --yes tsx -- tests/v2/runtime-generated-profile-chain.test.ts
npm exec --yes tsc --noEmit --pretty false
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add tests/v2/runtime-generated-profile-chain.test.ts
git commit -m "test: cover graph metadata runtime chain"
```

---

## Execution Notes

- Keep the old `profilePrimitiveCandidates` field during this plan. It remains compatibility data for current tests and UI, while `graphMetadataCandidates` becomes the LLM's direct candidate source.
- Do not add `GraphRetrievalQuery`.
- Do not create a new workflow generator.
- Do not move runtime execution out of the existing task envelope/Tork materialization path.
- Do not mount the live `library/` folder into Docker. Snapshot selected files into `/tmp/southstar-runs/<runId>/<taskId>` and keep the existing Tork mount of `/tmp/southstar-runs -> /southstar-runs`.
- Keep fail-closed behavior: missing approved refs, wrong object kinds, invalid graph closure, missing tool policy fields, or unsafe bundle paths must throw before Tork submission.

## Final Verification Gate

After all tasks:

```bash
npm exec --yes tsx -- tests/v2/graph-metadata-candidate-packet.test.ts
npm exec --yes tsx -- tests/v2/llm-workflow-composer.test.ts
npm exec --yes tsx -- tests/v2/workflow-dynamic-profile-composition.test.ts
npm exec --yes tsx -- tests/v2/runtime-library-materializer.test.ts
npm exec --yes tsx -- tests/v2/materializer.test.ts
npm exec --yes tsx -- tests/v2/runtime-generated-profile-chain.test.ts
npm exec --yes tsc --noEmit --pretty false
git diff --check
```

If web UI files are changed while executing this plan, also run:

```bash
npm --prefix web run build
```

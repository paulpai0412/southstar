# Southstar Library-Constrained LLM Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore dynamic LLM workflow DAG composition while constraining all selected workflow, agent, profile, skill, tool, MCP, vault, artifact, evaluator, and policy refs to approved Postgres library candidates.

**Architecture:** Add a Postgres-native typed contract graph over `library_objects` via `library_edges`, then build a deterministic candidate resolver that emits a bounded candidate packet. The LLM composer outputs only `WorkflowCompositionPlan` refs from that packet; a deterministic validator/compiler turns the validated plan into the existing `SouthstarWorkflowManifest` runtime shape and stores an orchestration snapshot.

**Tech Stack:** TypeScript, Node 22, Postgres, `pg`, `node:test`, existing Southstar v2 runtime modules, no vector search, no recursive CTE, no graph DB.

---

## Constraints

- Do not use vector search in this implementation.
- Do not use recursive CTE in this implementation.
- Do not introduce Apache AGE, Neo4j, or any graph DB dependency.
- Do not remove the current deterministic constrained generator until the llm-constrained path has tests and API coverage.
- Do not let generated component proposals become selected runtime permissions.
- Use `.git-local` for git commands from `/home/timmypai/apps/southstar`.

## File Structure

- Modify `src/v2/db/schema.ts`
  - Add `southstar.library_edges`.
  - Add direct lookup indexes.
  - Bump `SOUTHSTAR_SCHEMA_VERSION`.

- Modify `src/v2/design-library/types.ts`
  - Add `tool_definition`, `instruction_template`, `vault_lease_policy` to `LibraryDefinitionKind`.
  - Add `LibraryEdgeType`, `LibraryObjectSummary`, `LibraryEdgeRecord`, `RequirementSpecV2`, `CandidatePacket`, `WorkflowCompositionPlan`, `WorkflowCompositionPatch`, `GeneratedComponentProposal`, and validation issue types.

- Create `src/v2/design-library/library-graph-store.ts`
  - Insert/upsert library objects.
  - Insert direct typed edges.
  - Query approved object summaries.
  - Query direct outgoing/incoming edges.

- Create `src/v2/design-library/software-library-seed.ts`
  - Seed approved software workflow template, agent definitions, agent profiles, skills, instructions, tool grants, artifact contracts, evaluators, policies, and direct edges equivalent to current deterministic behavior.

- Create `src/v2/orchestration/requirement-analyzer.ts`
  - Provide deterministic P0 requirement analyzer with an injectable LLM-compatible interface for later.

- Create `src/v2/orchestration/candidate-resolver.ts`
  - Resolve approved candidates from direct edges only.
  - Return unavailable requirements instead of inventing permissions.

- Create `src/v2/orchestration/composer.ts`
  - Define `WorkflowComposer` interface.
  - Provide `DeterministicFixtureComposer` for tests.

- Modify `src/v2/manifests/types.ts`
  - Add optional `instructionRefs`, `toolGrantRefs`, and `vaultLeasePolicyRefs` to `WorkflowTaskDefinition` so compiled manifests preserve selected library refs.

- Create `src/v2/orchestration/composition-validator.ts`
  - Validate schema, refs, approved status, candidate membership, DAG cycles in memory, profile implements agent, profile allows skills/tools/MCP/vault/instructions, artifact/evaluator compatibility, and generated proposal non-selection.

- Create `src/v2/orchestration/composition-compiler.ts`
  - Compile validated composition into existing `WorkflowGenerationPlan` and `SouthstarWorkflowManifest`.
  - Store orchestration snapshot payload shape.

- Modify `src/v2/ui-api/postgres-run-api.ts`
  - Add `orchestrationMode?: "deterministic" | "llm-constrained"`.
  - Keep current deterministic default for compatibility.
  - Add llm-constrained path behind explicit input.

- Modify `src/v2/server/routes.ts`
  - Pass request `orchestrationMode` into `createPostgresPlannerDraft()`.

- Tests:
  - Create `tests/v2/library-graph-store.test.ts`.
  - Create `tests/v2/library-candidate-resolver.test.ts`.
  - Create `tests/v2/workflow-composition-validator.test.ts`.
  - Create `tests/v2/workflow-composition-compiler.test.ts`.
  - Modify `tests/v2/postgres-run-api.test.ts`.
  - Modify `tests/v2/postgres-store.test.ts` if it asserts the full schema table list.

---

### Task 1: Add Postgres Library Edges Schema

**Files:**
- Modify: `src/v2/db/schema.ts`
- Test: `tests/v2/postgres-store.test.ts`
- Test: `tests/e2e-postgres/cases/01-db-schema-init.test.ts`

- [ ] **Step 1: Write the failing schema test**

In `tests/v2/postgres-store.test.ts`, extend the table assertion to include `library_edges`. If the file uses an array of expected tables, add `"library_edges"` beside `"library_objects"` and `"library_history"`.

Expected assertion content:

```ts
assert.equal(tableNames.includes("library_edges"), true);
```

Also add index checks if the test already checks indexes:

```ts
assert.equal(indexNames.includes("idx_library_edges_from"), true);
assert.equal(indexNames.includes("idx_library_edges_to"), true);
assert.equal(indexNames.includes("idx_library_edges_scope"), true);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run test:postgres
```

Expected: FAIL because `library_edges` does not exist in the initialized schema.

- [ ] **Step 3: Update the schema**

In `src/v2/db/schema.ts`, change:

```ts
export const SOUTHSTAR_SCHEMA_VERSION = "2026_06_20_managed_agents_work_items_v1";
```

to:

```ts
export const SOUTHSTAR_SCHEMA_VERSION = "2026_06_23_library_edges_v1";
```

Add this SQL after `southstar.library_similarity_index` and before `southstar.learning_nodes`:

```sql
create table if not exists southstar.library_edges (
  id text primary key default gen_random_uuid()::text,
  from_object_key text not null,
  from_version_ref text,
  edge_type text not null,
  to_object_key text not null,
  to_version_ref text,
  scope text not null default 'global',
  status text not null default 'active',
  weight double precision not null default 1,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

Add these indexes after the existing `idx_library_similarity_signature` index:

```sql
create index if not exists idx_library_edges_from
  on southstar.library_edges(from_object_key, edge_type, status);
create index if not exists idx_library_edges_to
  on southstar.library_edges(to_object_key, edge_type, status);
create index if not exists idx_library_edges_scope
  on southstar.library_edges(scope, edge_type, status);
```

- [ ] **Step 4: Run schema tests**

Run:

```bash
npm run test:postgres
```

Expected: PASS.

If e2e schema init test is available:

```bash
npm run test:e2e:postgres:01
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/db/schema.ts tests/v2/postgres-store.test.ts tests/e2e-postgres/cases/01-db-schema-init.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add library contract edge schema"
```

---

### Task 2: Add Library Graph Types And Store

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Create: `src/v2/design-library/library-graph-store.ts`
- Test: `tests/v2/library-graph-store.test.ts`

- [ ] **Step 1: Write failing graph store tests**

Create `tests/v2/library-graph-store.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesFrom,
  findLibraryEdgesTo,
  upsertLibraryEdge,
  upsertLibraryObject,
} from "../../src/v2/design-library/library-graph-store.ts";

test("library graph store upserts approved objects and direct typed edges", async () => {
  await withDb(async (db) => {
    await upsertLibraryObject(db, {
      objectKey: "agent.software-maker",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.software-maker@v1",
      state: { displayName: "Software Maker" },
    });
    await upsertLibraryObject(db, {
      objectKey: "profile.software-maker-pi",
      objectKind: "agent_profile",
      status: "approved",
      headVersionId: "profile.software-maker-pi@v1",
      state: { agentDefinitionRef: "agent.software-maker" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "profile.software-maker-pi",
      fromVersionRef: "profile.software-maker-pi@v1",
      edgeType: "implements",
      toObjectKey: "agent.software-maker",
      toVersionRef: "agent.software-maker@v1",
      scope: "software",
      status: "active",
      weight: 1,
      metadata: { seeded: true },
    });

    const profiles = await findApprovedLibraryObjectsByKind(db, "agent_profile", "software");
    assert.deepEqual(profiles.map((row) => row.objectKey), ["profile.software-maker-pi"]);

    const outgoing = await findLibraryEdgesFrom(db, "profile.software-maker-pi", "implements");
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0].toObjectKey, "agent.software-maker");

    const incoming = await findLibraryEdgesTo(db, "agent.software-maker", "implements");
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].fromObjectKey, "profile.software-maker-pi");
  });
});

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
tsx tests/v2/library-graph-store.test.ts
```

Expected: FAIL because `library-graph-store.ts` does not exist.

- [ ] **Step 3: Extend design-library types**

In `src/v2/design-library/types.ts`, extend `LibraryDefinitionKind` to include:

```ts
  | "tool_definition"
  | "instruction_template"
  | "vault_lease_policy"
```

Add these exported types near the existing library type definitions:

```ts
export type LibraryEdgeType =
  | "implements"
  | "provides_capability"
  | "requires_capability"
  | "supports_skill"
  | "requires_skill"
  | "allows_tool"
  | "requires_tool"
  | "uses_instruction"
  | "requires_secret_group"
  | "allows_mcp_grant"
  | "produces_artifact"
  | "consumes_artifact"
  | "validates_artifact"
  | "uses_policy"
  | "part_of_template"
  | "supersedes"
  | "blocked_by";

export type LibraryObjectSummary = {
  id: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  headVersionId: string | null;
  state: Record<string, unknown>;
};

export type LibraryEdgeRecord = {
  id: string;
  fromObjectKey: string;
  fromVersionRef: string | null;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  toVersionRef: string | null;
  scope: string;
  status: "active" | "inactive" | "blocked";
  weight: number;
  metadata: Record<string, unknown>;
};
```

- [ ] **Step 4: Implement the graph store**

Create `src/v2/design-library/library-graph-store.ts`:

```ts
import { createHash, randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type {
  LibraryDefinitionKind,
  LibraryDefinitionStatus,
  LibraryEdgeRecord,
  LibraryEdgeType,
  LibraryObjectSummary,
} from "./types.ts";

export type UpsertLibraryObjectInput = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  headVersionId?: string;
  state: Record<string, unknown>;
};

export type UpsertLibraryEdgeInput = {
  fromObjectKey: string;
  fromVersionRef?: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  toVersionRef?: string;
  scope?: string;
  status?: "active" | "inactive" | "blocked";
  weight?: number;
  metadata?: Record<string, unknown>;
};

export async function upsertLibraryObject(db: SouthstarDb, input: UpsertLibraryObjectInput): Promise<LibraryObjectSummary> {
  const id = `lib-${hash(input.objectKey).slice(0, 16)}`;
  const row = await db.one<LibraryObjectRow>(
    `insert into southstar.library_objects (
       id, object_key, object_kind, status, head_version_id, state_json, updated_at
     ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
     on conflict(object_key) do update set
       object_kind = excluded.object_kind,
       status = excluded.status,
       head_version_id = excluded.head_version_id,
       state_json = excluded.state_json,
       updated_at = now()
     returning *`,
    [id, input.objectKey, input.objectKind, input.status, input.headVersionId ?? null, JSON.stringify(input.state)],
  );
  return mapObject(row);
}

export async function upsertLibraryEdge(db: SouthstarDb, input: UpsertLibraryEdgeInput): Promise<LibraryEdgeRecord> {
  const id = `edge-${hash([
    input.fromObjectKey,
    input.fromVersionRef ?? "",
    input.edgeType,
    input.toObjectKey,
    input.toVersionRef ?? "",
    input.scope ?? "global",
  ].join("|")).slice(0, 20)}`;
  const row = await db.one<LibraryEdgeRow>(
    `insert into southstar.library_edges (
       id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
       scope, status, weight, metadata_json
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict(id) do update set
       from_version_ref = excluded.from_version_ref,
       to_version_ref = excluded.to_version_ref,
       status = excluded.status,
       weight = excluded.weight,
       metadata_json = excluded.metadata_json
     returning *`,
    [
      id,
      input.fromObjectKey,
      input.fromVersionRef ?? null,
      input.edgeType,
      input.toObjectKey,
      input.toVersionRef ?? null,
      input.scope ?? "global",
      input.status ?? "active",
      input.weight ?? 1,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return mapEdge(row);
}

export async function findApprovedLibraryObjectsByKind(
  db: SouthstarDb,
  objectKind: LibraryDefinitionKind,
  scope?: string,
): Promise<LibraryObjectSummary[]> {
  const result = await db.query<LibraryObjectRow>(
    `select *
       from southstar.library_objects
      where object_kind = $1
        and status = 'approved'
        and ($2::text is null or state_json->>'scope' = $2 or state_json->'domainRefs' ? $2)
      order by object_key`,
    [objectKind, scope ?? null],
  );
  return result.rows.map(mapObject);
}

export async function findLibraryObjectByKey(db: SouthstarDb, objectKey: string): Promise<LibraryObjectSummary | null> {
  const row = await db.maybeOne<LibraryObjectRow>("select * from southstar.library_objects where object_key = $1", [objectKey]);
  return row ? mapObject(row) : null;
}

export async function findLibraryEdgesFrom(
  db: SouthstarDb,
  fromObjectKey: string,
  edgeType?: LibraryEdgeType,
): Promise<LibraryEdgeRecord[]> {
  const result = await db.query<LibraryEdgeRow>(
    `select *
       from southstar.library_edges
      where from_object_key = $1
        and status = 'active'
        and ($2::text is null or edge_type = $2)
      order by edge_type, to_object_key`,
    [fromObjectKey, edgeType ?? null],
  );
  return result.rows.map(mapEdge);
}

export async function findLibraryEdgesTo(
  db: SouthstarDb,
  toObjectKey: string,
  edgeType?: LibraryEdgeType,
): Promise<LibraryEdgeRecord[]> {
  const result = await db.query<LibraryEdgeRow>(
    `select *
       from southstar.library_edges
      where to_object_key = $1
        and status = 'active'
        and ($2::text is null or edge_type = $2)
      order by edge_type, from_object_key`,
    [toObjectKey, edgeType ?? null],
  );
  return result.rows.map(mapEdge);
}

type LibraryObjectRow = {
  id: string;
  object_key: string;
  object_kind: LibraryDefinitionKind;
  status: LibraryDefinitionStatus;
  head_version_id: string | null;
  state_json: Record<string, unknown>;
};

type LibraryEdgeRow = {
  id: string;
  from_object_key: string;
  from_version_ref: string | null;
  edge_type: LibraryEdgeType;
  to_object_key: string;
  to_version_ref: string | null;
  scope: string;
  status: "active" | "inactive" | "blocked";
  weight: number;
  metadata_json: Record<string, unknown>;
};

function mapObject(row: LibraryObjectRow): LibraryObjectSummary {
  return {
    id: row.id,
    objectKey: row.object_key,
    objectKind: row.object_kind,
    status: row.status,
    headVersionId: row.head_version_id,
    state: row.state_json,
  };
}

function mapEdge(row: LibraryEdgeRow): LibraryEdgeRecord {
  return {
    id: row.id,
    fromObjectKey: row.from_object_key,
    fromVersionRef: row.from_version_ref,
    edgeType: row.edge_type,
    toObjectKey: row.to_object_key,
    toVersionRef: row.to_version_ref,
    scope: row.scope,
    status: row.status,
    weight: row.weight,
    metadata: row.metadata_json,
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

Remove `randomUUID` from the import if TypeScript reports it is unused.

- [ ] **Step 5: Run the focused test**

Run:

```bash
tsx tests/v2/library-graph-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run v2 tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/design-library/types.ts src/v2/design-library/library-graph-store.ts tests/v2/library-graph-store.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add library graph store"
```

---

### Task 3: Seed Approved Software Library Graph

**Files:**
- Create: `src/v2/design-library/software-library-seed.ts`
- Test: `tests/v2/library-candidate-resolver.test.ts`

- [ ] **Step 1: Write failing seed smoke test**

Create the first version of `tests/v2/library-candidate-resolver.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { findLibraryEdgesFrom, findLibraryEdgesTo } from "../../src/v2/design-library/library-graph-store.ts";

test("software library seed creates approved agent/profile/tool/artifact contract edges", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);

    const makerProfiles = await findLibraryEdgesTo(db, "agent.software-maker", "implements");
    assert.equal(makerProfiles.some((edge) => edge.fromObjectKey === "profile.software-maker-pi"), true);

    const makerProfileEdges = await findLibraryEdgesFrom(db, "profile.software-maker-pi");
    assert.equal(makerProfileEdges.some((edge) => edge.edgeType === "supports_skill" && edge.toObjectKey === "skill.software-implementation"), true);
    assert.equal(makerProfileEdges.some((edge) => edge.edgeType === "allows_tool" && edge.toObjectKey === "tool.workspace-write"), true);

    const evaluatorEdges = await findLibraryEdgesFrom(db, "evaluator.software-feature-quality");
    assert.equal(evaluatorEdges.some((edge) => edge.edgeType === "validates_artifact" && edge.toObjectKey === "artifact.implementation_report"), true);
  });
});

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
tsx tests/v2/library-candidate-resolver.test.ts
```

Expected: FAIL because `software-library-seed.ts` does not exist.

- [ ] **Step 3: Implement the software seed**

Create `src/v2/design-library/software-library-seed.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "./library-graph-store.ts";

export async function seedSoftwareLibraryGraph(db: SouthstarDb): Promise<void> {
  await seedObjects(db);
  await seedEdges(db);
}

async function seedObjects(db: SouthstarDb): Promise<void> {
  for (const object of SOFTWARE_LIBRARY_OBJECTS) {
    await upsertLibraryObject(db, object);
  }
}

async function seedEdges(db: SouthstarDb): Promise<void> {
  for (const edge of SOFTWARE_LIBRARY_EDGES) {
    await upsertLibraryEdge(db, edge);
  }
}

const SOFTWARE_LIBRARY_OBJECTS = [
  object("workflow.software.explore-make-check", "workflow_template", {
    displayName: "Software Explore Make Check",
    scope: "software",
    domainRefs: ["software"],
    requiredCapabilities: ["capability.repo-understanding", "capability.code-change", "capability.verification", "capability.completion-summary"],
  }),
  object("agent.software-explorer", "agent_definition", {
    displayName: "Software Explorer",
    scope: "software",
    domainRefs: ["software"],
    responsibilityBoundary: ["Inspect repository context", "Produce implementation plan"],
  }),
  object("agent.software-maker", "agent_definition", {
    displayName: "Software Maker",
    scope: "software",
    domainRefs: ["software"],
    responsibilityBoundary: ["Modify workspace files", "Produce implementation report"],
  }),
  object("agent.software-checker", "agent_definition", {
    displayName: "Software Checker",
    scope: "software",
    domainRefs: ["software"],
    responsibilityBoundary: ["Verify behavior", "Produce verification report"],
  }),
  object("agent.software-summarizer", "agent_definition", {
    displayName: "Software Summarizer",
    scope: "software",
    domainRefs: ["software"],
    responsibilityBoundary: ["Summarize completion evidence"],
  }),
  object("profile.software-explorer-codex", "agent_profile", {
    displayName: "Software Explorer Codex",
    scope: "software",
    agentDefinitionRef: "agent.software-explorer",
    hostAdapter: "codex",
    readOnly: true,
  }),
  object("profile.software-maker-pi", "agent_profile", {
    displayName: "Software Maker Pi",
    scope: "software",
    agentDefinitionRef: "agent.software-maker",
    hostAdapter: "pi-agent",
    readOnly: false,
  }),
  object("profile.software-checker-codex", "agent_profile", {
    displayName: "Software Checker Codex",
    scope: "software",
    agentDefinitionRef: "agent.software-checker",
    hostAdapter: "codex",
    readOnly: true,
  }),
  object("profile.software-summarizer-codex", "agent_profile", {
    displayName: "Software Summarizer Codex",
    scope: "software",
    agentDefinitionRef: "agent.software-summarizer",
    hostAdapter: "codex",
    readOnly: true,
  }),
  object("skill.repo-exploration", "skill_definition", { displayName: "Repo Exploration", scope: "software" }),
  object("skill.software-implementation", "skill_definition", { displayName: "Software Implementation", scope: "software" }),
  object("skill.software-verification", "skill_definition", { displayName: "Software Verification", scope: "software" }),
  object("skill.completion-summary", "skill_definition", { displayName: "Completion Summary", scope: "software" }),
  object("tool.workspace-read", "tool_definition", { displayName: "Workspace Read", scope: "software", sideEffect: "read" }),
  object("tool.workspace-write", "tool_definition", { displayName: "Workspace Write", scope: "software", sideEffect: "write" }),
  object("instruction.software-explorer", "instruction_template", { displayName: "Software Explorer Prompt", scope: "software" }),
  object("instruction.software-maker", "instruction_template", { displayName: "Software Maker Prompt", scope: "software" }),
  object("instruction.software-checker", "instruction_template", { displayName: "Software Checker Prompt", scope: "software" }),
  object("instruction.software-summarizer", "instruction_template", { displayName: "Software Summarizer Prompt", scope: "software" }),
  object("artifact.implementation_plan", "artifact_contract", { artifactType: "implementation-plan", scope: "software" }),
  object("artifact.implementation_report", "artifact_contract", { artifactType: "implementation-report", scope: "software" }),
  object("artifact.verification_report", "artifact_contract", { artifactType: "verification-report", scope: "software" }),
  object("artifact.completion_report", "artifact_contract", { artifactType: "completion-report", scope: "software" }),
  object("evaluator.software-plan-quality", "evaluator_profile", { displayName: "Software Plan Quality", scope: "software" }),
  object("evaluator.software-feature-quality", "evaluator_profile", { displayName: "Software Feature Quality", scope: "software" }),
  object("evaluator.software-verification-quality", "evaluator_profile", { displayName: "Software Verification Quality", scope: "software" }),
  object("evaluator.software-completion-quality", "evaluator_profile", { displayName: "Software Completion Quality", scope: "software" }),
  object("policy.readonly-checker", "policy_bundle", { displayName: "Readonly Checker", scope: "software" }),
  object("capability.repo-understanding", "capability_spec", { displayName: "Repo Understanding", scope: "software" }),
  object("capability.code-change", "capability_spec", { displayName: "Code Change", scope: "software" }),
  object("capability.verification", "capability_spec", { displayName: "Verification", scope: "software" }),
  object("capability.completion-summary", "capability_spec", { displayName: "Completion Summary", scope: "software" }),
] as const;

const SOFTWARE_LIBRARY_EDGES = [
  edge("workflow.software.explore-make-check", "requires_capability", "capability.repo-understanding"),
  edge("workflow.software.explore-make-check", "requires_capability", "capability.code-change"),
  edge("workflow.software.explore-make-check", "requires_capability", "capability.verification"),
  edge("workflow.software.explore-make-check", "requires_capability", "capability.completion-summary"),
  edge("agent.software-explorer", "provides_capability", "capability.repo-understanding"),
  edge("agent.software-maker", "provides_capability", "capability.code-change"),
  edge("agent.software-checker", "provides_capability", "capability.verification"),
  edge("agent.software-summarizer", "provides_capability", "capability.completion-summary"),
  edge("profile.software-explorer-codex", "implements", "agent.software-explorer"),
  edge("profile.software-maker-pi", "implements", "agent.software-maker"),
  edge("profile.software-checker-codex", "implements", "agent.software-checker"),
  edge("profile.software-summarizer-codex", "implements", "agent.software-summarizer"),
  edge("profile.software-explorer-codex", "supports_skill", "skill.repo-exploration"),
  edge("profile.software-maker-pi", "supports_skill", "skill.software-implementation"),
  edge("profile.software-checker-codex", "supports_skill", "skill.software-verification"),
  edge("profile.software-summarizer-codex", "supports_skill", "skill.completion-summary"),
  edge("profile.software-explorer-codex", "allows_tool", "tool.workspace-read"),
  edge("profile.software-maker-pi", "allows_tool", "tool.workspace-read"),
  edge("profile.software-maker-pi", "allows_tool", "tool.workspace-write"),
  edge("profile.software-checker-codex", "allows_tool", "tool.workspace-read"),
  edge("profile.software-summarizer-codex", "allows_tool", "tool.workspace-read"),
  edge("profile.software-explorer-codex", "uses_instruction", "instruction.software-explorer"),
  edge("profile.software-maker-pi", "uses_instruction", "instruction.software-maker"),
  edge("profile.software-checker-codex", "uses_instruction", "instruction.software-checker"),
  edge("profile.software-summarizer-codex", "uses_instruction", "instruction.software-summarizer"),
  edge("agent.software-explorer", "produces_artifact", "artifact.implementation_plan"),
  edge("agent.software-maker", "produces_artifact", "artifact.implementation_report"),
  edge("agent.software-checker", "produces_artifact", "artifact.verification_report"),
  edge("agent.software-summarizer", "produces_artifact", "artifact.completion_report"),
  edge("evaluator.software-plan-quality", "validates_artifact", "artifact.implementation_plan"),
  edge("evaluator.software-feature-quality", "validates_artifact", "artifact.implementation_report"),
  edge("evaluator.software-verification-quality", "validates_artifact", "artifact.verification_report"),
  edge("evaluator.software-completion-quality", "validates_artifact", "artifact.completion_report"),
] as const;

function object(objectKey: string, objectKind: Parameters<typeof upsertLibraryObject>[1]["objectKind"], state: Record<string, unknown>) {
  return {
    objectKey,
    objectKind,
    status: "approved" as const,
    headVersionId: `${objectKey}@v1`,
    state,
  };
}

function edge(fromObjectKey: string, edgeType: Parameters<typeof upsertLibraryEdge>[1]["edgeType"], toObjectKey: string) {
  return {
    fromObjectKey,
    fromVersionRef: `${fromObjectKey}@v1`,
    edgeType,
    toObjectKey,
    toVersionRef: `${toObjectKey}@v1`,
    scope: "software",
    status: "active" as const,
    weight: 1,
    metadata: { seed: "software-library-v1" },
  };
}
```

- [ ] **Step 4: Run the seed test**

Run:

```bash
tsx tests/v2/library-candidate-resolver.test.ts
```

Expected: PASS for the seed smoke test.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/design-library/software-library-seed.ts tests/v2/library-candidate-resolver.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: seed software library graph"
```

---

### Task 4: Implement Requirement Analyzer And Candidate Resolver

**Files:**
- Create: `src/v2/orchestration/requirement-analyzer.ts`
- Create: `src/v2/orchestration/candidate-resolver.ts`
- Modify: `tests/v2/library-candidate-resolver.test.ts`

- [ ] **Step 1: Add failing resolver test**

Add these imports to the top of `tests/v2/library-candidate-resolver.test.ts`:

```ts
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
```

Append this test body below the existing seed smoke test:

```ts

test("candidate resolver returns approved direct-edge candidates without vector or recursive traversal", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);
    const requirement = analyzeRequirementDeterministically("implement calc sum");
    const packet = await resolveWorkflowCandidates(db, { requirementSpec: requirement, scope: "software" });

    assert.deepEqual(packet.unavailableRequirements, []);
    assert.equal(packet.workflowTemplateCandidates[0]?.ref, "workflow.software.explore-make-check");
    assert.equal(packet.agentCandidatesByCapability["capability.code-change"]?.[0]?.ref, "agent.software-maker");
    assert.equal(packet.profileCandidatesByAgent["agent.software-maker"]?.[0]?.ref, "profile.software-maker-pi");
    assert.equal(packet.skillCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) => candidate.ref === "skill.software-implementation"), true);
    assert.equal(packet.toolCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) => candidate.ref === "tool.workspace-write"), true);
  });
});
```

- [ ] **Step 2: Run the failing resolver test**

Run:

```bash
tsx tests/v2/library-candidate-resolver.test.ts
```

Expected: FAIL because orchestration modules do not exist.

- [ ] **Step 3: Add orchestration types**

In `src/v2/design-library/types.ts`, add:

```ts
export type RequirementSpecV2 = {
  summary: string;
  workType: "software_feature" | "bugfix" | "research" | "data_analysis" | "migration" | "ops_recovery" | "general";
  requiredCapabilities: string[];
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  riskNotes: string[];
  workspaceAssumptions: string[];
  missingInputs: string[];
};

export type CandidateSummary = {
  ref: string;
  versionRef: string | null;
  kind: LibraryDefinitionKind;
  displayName: string;
  state: Record<string, unknown>;
  reason: string;
};

export type CandidatePacket = {
  requirementSpec: RequirementSpecV2;
  workflowTemplateCandidates: CandidateSummary[];
  agentCandidatesByCapability: Record<string, CandidateSummary[]>;
  profileCandidatesByAgent: Record<string, CandidateSummary[]>;
  skillCandidatesByProfile: Record<string, CandidateSummary[]>;
  toolCandidatesByProfile: Record<string, CandidateSummary[]>;
  mcpGrantCandidatesByProfile: Record<string, CandidateSummary[]>;
  instructionCandidatesByProfile: Record<string, CandidateSummary[]>;
  artifactContractCandidates: CandidateSummary[];
  evaluatorCandidatesByArtifact: Record<string, CandidateSummary[]>;
  policyConstraints: CandidateSummary[];
  unavailableRequirements: Array<{
    capabilityRef: string;
    reason: "no_approved_candidate" | "blocked_by_policy" | "requires_approval";
  }>;
};
```

- [ ] **Step 4: Implement deterministic requirement analyzer**

Create `src/v2/orchestration/requirement-analyzer.ts`:

```ts
import type { RequirementSpecV2 } from "../design-library/types.ts";

export function analyzeRequirementDeterministically(goalPrompt: string): RequirementSpecV2 {
  const workType = /fix|bug|failing|修正|錯誤/i.test(goalPrompt) ? "bugfix" : "software_feature";
  return {
    summary: goalPrompt.trim(),
    workType,
    requiredCapabilities: [
      "capability.repo-understanding",
      "capability.code-change",
      "capability.verification",
      "capability.completion-summary",
    ],
    expectedArtifacts: [
      "artifact.implementation_plan",
      "artifact.implementation_report",
      "artifact.verification_report",
      "artifact.completion_report",
    ],
    acceptanceCriteria: [goalPrompt.trim()],
    nonGoals: [],
    riskNotes: [],
    workspaceAssumptions: [],
    missingInputs: [],
  };
}
```

- [ ] **Step 5: Implement candidate resolver**

Create `src/v2/orchestration/candidate-resolver.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import {
  findApprovedLibraryObjectsByKind,
  findLibraryEdgesFrom,
  findLibraryEdgesTo,
  findLibraryObjectByKey,
} from "../design-library/library-graph-store.ts";
import type { CandidatePacket, CandidateSummary, RequirementSpecV2 } from "../design-library/types.ts";

export type ResolveWorkflowCandidatesInput = {
  requirementSpec: RequirementSpecV2;
  scope: string;
};

export async function resolveWorkflowCandidates(db: SouthstarDb, input: ResolveWorkflowCandidatesInput): Promise<CandidatePacket> {
  const workflowTemplateCandidates = (await findApprovedLibraryObjectsByKind(db, "workflow_template", input.scope)).map((object) =>
    summary(object.objectKey, object.headVersionId, object.objectKind, object.state, "approved workflow template in scope")
  );

  const agentCandidatesByCapability: Record<string, CandidateSummary[]> = {};
  const unavailableRequirements: CandidatePacket["unavailableRequirements"] = [];
  for (const capabilityRef of input.requirementSpec.requiredCapabilities) {
    const providers = await findLibraryEdgesTo(db, capabilityRef, "provides_capability");
    const candidates = await summariesForRefs(db, providers.map((edge) => edge.fromObjectKey), `provides ${capabilityRef}`);
    agentCandidatesByCapability[capabilityRef] = candidates.filter((candidate) => candidate.kind === "agent_definition");
    if (agentCandidatesByCapability[capabilityRef].length === 0) {
      unavailableRequirements.push({ capabilityRef, reason: "no_approved_candidate" });
    }
  }

  const profileCandidatesByAgent: Record<string, CandidateSummary[]> = {};
  for (const agents of Object.values(agentCandidatesByCapability)) {
    for (const agent of agents) {
      const profiles = await findLibraryEdgesTo(agent.ref, "implements");
      profileCandidatesByAgent[agent.ref] = await summariesForRefs(db, profiles.map((edge) => edge.fromObjectKey), `implements ${agent.ref}`);
    }
  }

  const skillCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const toolCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const mcpGrantCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  const instructionCandidatesByProfile: Record<string, CandidateSummary[]> = {};
  for (const profiles of Object.values(profileCandidatesByAgent)) {
    for (const profile of profiles) {
      skillCandidatesByProfile[profile.ref] = await linkedSummaries(db, profile.ref, "supports_skill");
      toolCandidatesByProfile[profile.ref] = await linkedSummaries(db, profile.ref, "allows_tool");
      mcpGrantCandidatesByProfile[profile.ref] = await linkedSummaries(db, profile.ref, "allows_mcp_grant");
      instructionCandidatesByProfile[profile.ref] = await linkedSummaries(db, profile.ref, "uses_instruction");
    }
  }

  const artifactContractCandidates = await summariesForRefs(db, input.requirementSpec.expectedArtifacts, "expected artifact");
  const evaluatorCandidatesByArtifact: Record<string, CandidateSummary[]> = {};
  for (const artifact of artifactContractCandidates) {
    const validators = await findLibraryEdgesTo(db, artifact.ref, "validates_artifact");
    evaluatorCandidatesByArtifact[artifact.ref] = await summariesForRefs(db, validators.map((edge) => edge.fromObjectKey), `validates ${artifact.ref}`);
  }

  return {
    requirementSpec: input.requirementSpec,
    workflowTemplateCandidates,
    agentCandidatesByCapability,
    profileCandidatesByAgent,
    skillCandidatesByProfile,
    toolCandidatesByProfile,
    mcpGrantCandidatesByProfile,
    instructionCandidatesByProfile,
    artifactContractCandidates,
    evaluatorCandidatesByArtifact,
    policyConstraints: [],
    unavailableRequirements,
  };
}

async function linkedSummaries(db: SouthstarDb, fromRef: string, edgeType: Parameters<typeof findLibraryEdgesFrom>[2]): Promise<CandidateSummary[]> {
  const edges = await findLibraryEdgesFrom(db, fromRef, edgeType);
  return await summariesForRefs(db, edges.map((edge) => edge.toObjectKey), `${edgeType} from ${fromRef}`);
}

async function summariesForRefs(db: SouthstarDb, refs: string[], reason: string): Promise<CandidateSummary[]> {
  const summaries: CandidateSummary[] = [];
  for (const ref of [...new Set(refs)].sort()) {
    const object = await findLibraryObjectByKey(db, ref);
    if (object?.status === "approved") {
      summaries.push(summary(object.objectKey, object.headVersionId, object.objectKind, object.state, reason));
    }
  }
  return summaries;
}

function summary(
  ref: string,
  versionRef: string | null,
  kind: CandidateSummary["kind"],
  state: Record<string, unknown>,
  reason: string,
): CandidateSummary {
  return {
    ref,
    versionRef,
    kind,
    displayName: typeof state.displayName === "string" ? state.displayName : ref,
    state,
    reason,
  };
}
```

If TypeScript rejects `Parameters<typeof findLibraryEdgesFrom>[2]`, replace that helper parameter with `edgeType: import("../design-library/types.ts").LibraryEdgeType`.

- [ ] **Step 6: Run resolver tests**

Run:

```bash
tsx tests/v2/library-candidate-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/design-library/types.ts src/v2/orchestration/requirement-analyzer.ts src/v2/orchestration/candidate-resolver.ts tests/v2/library-candidate-resolver.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: resolve workflow candidates from library graph"
```

---

### Task 5: Add Workflow Composition Plan And Validator

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Create: `src/v2/orchestration/composition-validator.ts`
- Create: `tests/v2/workflow-composition-validator.test.ts`

- [ ] **Step 1: Write failing validator tests**

Create `tests/v2/workflow-composition-validator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { validateWorkflowCompositionPlan } from "../../src/v2/orchestration/composition-validator.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";

test("validator accepts a composition that uses approved candidates", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const validation = await validateWorkflowCompositionPlan(db, packet, validComposition());
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.issues, []);
  });
});

test("validator rejects refs outside the candidate packet", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[1].agentProfileRef = "profile.unapproved-writer";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "ref_not_in_candidate_packet"), true);
  });
});

test("validator rejects dependency cycles in memory", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[0].dependsOn = ["summarize-completion"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "dependency_cycle"), true);
  });
});

function validComposition(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Software Dynamic Feature Workflow",
    selectedWorkflowTemplateRef: "workflow.software.explore-make-check",
    rationale: "Use explorer, maker, checker, and summarizer roles.",
    tasks: [
      task("understand-repo", [], "agent.software-explorer", "profile.software-explorer-codex", ["skill.repo-exploration"], ["tool.workspace-read"], ["instruction.software-explorer"], ["artifact.implementation_plan"], "evaluator.software-plan-quality"),
      task("implement-feature", ["understand-repo"], "agent.software-maker", "profile.software-maker-pi", ["skill.software-implementation"], ["tool.workspace-read", "tool.workspace-write"], ["instruction.software-maker"], ["artifact.implementation_report"], "evaluator.software-feature-quality"),
      task("verify-feature", ["implement-feature"], "agent.software-checker", "profile.software-checker-codex", ["skill.software-verification"], ["tool.workspace-read"], ["instruction.software-checker"], ["artifact.verification_report"], "evaluator.software-verification-quality"),
      task("summarize-completion", ["verify-feature"], "agent.software-summarizer", "profile.software-summarizer-codex", ["skill.completion-summary"], ["tool.workspace-read"], ["instruction.software-summarizer"], ["artifact.completion_report"], "evaluator.software-completion-quality"),
    ],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  toolGrantRefs: string[],
  instructionRefs: string[],
  outputArtifactRefs: string[],
  evaluatorProfileRef: string,
) {
  return {
    id,
    name: id,
    responsibility: id,
    dependsOn,
    templateSlotRef: id,
    agentDefinitionRef,
    agentProfileRef,
    instructionRefs,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: id,
  };
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 2: Run the failing validator tests**

Run:

```bash
tsx tests/v2/workflow-composition-validator.test.ts
```

Expected: FAIL because validator/types do not exist.

- [ ] **Step 3: Add composition types**

In `src/v2/design-library/types.ts`, add:

```ts
export type GeneratedComponentProposal = {
  id: string;
  kind: LibraryDefinitionKind;
  risk: "low" | "medium" | "high";
  reason: string;
  validationStatus: "validated" | "unvalidated";
};

export type WorkflowCompositionTask = {
  id: string;
  name: string;
  responsibility: string;
  dependsOn: string[];
  templateSlotRef: string;
  agentDefinitionRef: string;
  agentProfileRef: string;
  instructionRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  inputArtifactRefs: string[];
  outputArtifactRefs: string[];
  evaluatorProfileRef: string;
  contextPolicyRef?: string;
  workspacePolicyRef?: string;
  recoveryStrategyRefs: string[];
  rationale: string;
};

export type WorkflowCompositionPlan = {
  schemaVersion: "southstar.workflow_composition_plan.v1";
  title: string;
  selectedWorkflowTemplateRef: string;
  rationale: string;
  tasks: WorkflowCompositionTask[];
  rejectedCandidates: Array<{ ref: string; reason: string }>;
  generatedComponentProposals: GeneratedComponentProposal[];
};

export type WorkflowCompositionPatch = {
  schemaVersion: "southstar.workflow_composition_patch.v1";
  basePlanHash: string;
  operations: Array<
    | { op: "replace-task"; taskId: string; task: WorkflowCompositionTask }
    | { op: "remove-task"; taskId: string }
    | { op: "add-task"; task: WorkflowCompositionTask }
    | { op: "replace-ref"; taskId: string; field: keyof WorkflowCompositionTask; fromRef: string; toRef: string }
  >;
  rationale: string;
};

export type WorkflowCompositionValidationIssueCode =
  | "invalid_schema_version"
  | "unknown_template"
  | "duplicate_task_id"
  | "unknown_dependency"
  | "dependency_cycle"
  | "ref_not_in_candidate_packet"
  | "profile_does_not_implement_agent"
  | "profile_does_not_allow_skill"
  | "profile_does_not_allow_tool"
  | "profile_does_not_allow_mcp"
  | "profile_does_not_allow_instruction"
  | "evaluator_does_not_validate_artifact"
  | "generated_component_selected";

export type WorkflowCompositionValidationIssue = {
  code: WorkflowCompositionValidationIssueCode;
  path: string;
  message: string;
};

export type WorkflowCompositionValidationResult = {
  ok: boolean;
  issues: WorkflowCompositionValidationIssue[];
};
```

- [ ] **Step 4: Implement validator**

Create `src/v2/orchestration/composition-validator.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { findLibraryEdgesFrom } from "../design-library/library-graph-store.ts";
import type {
  CandidatePacket,
  WorkflowCompositionPlan,
  WorkflowCompositionValidationIssue,
  WorkflowCompositionValidationResult,
} from "../design-library/types.ts";

export async function validateWorkflowCompositionPlan(
  db: SouthstarDb,
  packet: CandidatePacket,
  plan: WorkflowCompositionPlan,
): Promise<WorkflowCompositionValidationResult> {
  const issues: WorkflowCompositionValidationIssue[] = [];
  if (plan.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    issues.push(issue("invalid_schema_version", "schemaVersion", "schemaVersion must be southstar.workflow_composition_plan.v1"));
  }
  if (!candidateRefs(packet).has(plan.selectedWorkflowTemplateRef)) {
    issues.push(issue("unknown_template", "selectedWorkflowTemplateRef", `template is not an approved candidate: ${plan.selectedWorkflowTemplateRef}`));
  }
  validateTaskIds(plan, issues);
  validateCandidateMembership(packet, plan, issues);
  await validateEdges(db, plan, issues);
  return { ok: issues.length === 0, issues };
}

function validateTaskIds(plan: WorkflowCompositionPlan, issues: WorkflowCompositionValidationIssue[]): void {
  const seen = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (seen.has(task.id)) {
      issues.push(issue("duplicate_task_id", `tasks.${index}.id`, `duplicate task id: ${task.id}`));
    }
    seen.add(task.id);
  }
  for (const [index, task] of plan.tasks.entries()) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep)) {
        issues.push(issue("unknown_dependency", `tasks.${index}.dependsOn`, `unknown dependency: ${dep}`));
      }
    }
  }
  if (hasCycle(plan.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn })))) {
    issues.push(issue("dependency_cycle", "tasks", "task dependency graph contains a cycle"));
  }
}

function validateCandidateMembership(packet: CandidatePacket, plan: WorkflowCompositionPlan, issues: WorkflowCompositionValidationIssue[]): void {
  const refs = candidateRefs(packet);
  const proposalRefs = new Set(plan.generatedComponentProposals.map((proposal) => proposal.id));
  for (const [taskIndex, task] of plan.tasks.entries()) {
    const selectedRefs = [
      task.agentDefinitionRef,
      task.agentProfileRef,
      task.evaluatorProfileRef,
      ...task.instructionRefs,
      ...task.skillRefs,
      ...task.toolGrantRefs,
      ...task.mcpGrantRefs,
      ...task.vaultLeasePolicyRefs,
      ...task.inputArtifactRefs,
      ...task.outputArtifactRefs,
    ];
    for (const ref of selectedRefs) {
      if (proposalRefs.has(ref)) {
        issues.push(issue("generated_component_selected", `tasks.${taskIndex}`, `generated proposal cannot be selected for runtime: ${ref}`));
      }
      if (!refs.has(ref)) {
        issues.push(issue("ref_not_in_candidate_packet", `tasks.${taskIndex}`, `ref is not in candidate packet: ${ref}`));
      }
    }
  }
}

async function validateEdges(db: SouthstarDb, plan: WorkflowCompositionPlan, issues: WorkflowCompositionValidationIssue[]): Promise<void> {
  for (const [taskIndex, task] of plan.tasks.entries()) {
    await requireOutgoingEdge(db, task.agentProfileRef, "implements", task.agentDefinitionRef, issues, "profile_does_not_implement_agent", `tasks.${taskIndex}.agentProfileRef`);
    for (const skillRef of task.skillRefs) {
      await requireOutgoingEdge(db, task.agentProfileRef, "supports_skill", skillRef, issues, "profile_does_not_allow_skill", `tasks.${taskIndex}.skillRefs`);
    }
    for (const toolRef of task.toolGrantRefs) {
      await requireOutgoingEdge(db, task.agentProfileRef, "allows_tool", toolRef, issues, "profile_does_not_allow_tool", `tasks.${taskIndex}.toolGrantRefs`);
    }
    for (const mcpRef of task.mcpGrantRefs) {
      await requireOutgoingEdge(db, task.agentProfileRef, "allows_mcp_grant", mcpRef, issues, "profile_does_not_allow_mcp", `tasks.${taskIndex}.mcpGrantRefs`);
    }
    for (const instructionRef of task.instructionRefs) {
      await requireOutgoingEdge(db, task.agentProfileRef, "uses_instruction", instructionRef, issues, "profile_does_not_allow_instruction", `tasks.${taskIndex}.instructionRefs`);
    }
    for (const artifactRef of task.outputArtifactRefs) {
      await requireOutgoingEdge(db, task.evaluatorProfileRef, "validates_artifact", artifactRef, issues, "evaluator_does_not_validate_artifact", `tasks.${taskIndex}.evaluatorProfileRef`);
    }
  }
}

async function requireOutgoingEdge(
  db: SouthstarDb,
  fromRef: string,
  edgeType: Parameters<typeof findLibraryEdgesFrom>[2],
  toRef: string,
  issues: WorkflowCompositionValidationIssue[],
  code: WorkflowCompositionValidationIssue["code"],
  path: string,
): Promise<void> {
  const edges = await findLibraryEdgesFrom(db, fromRef, edgeType);
  if (!edges.some((edge) => edge.toObjectKey === toRef)) {
    issues.push(issue(code, path, `${fromRef} does not have ${edgeType} edge to ${toRef}`));
  }
}

function candidateRefs(packet: CandidatePacket): Set<string> {
  const refs = new Set<string>();
  for (const candidate of packet.workflowTemplateCandidates) refs.add(candidate.ref);
  for (const values of Object.values(packet.agentCandidatesByCapability)) for (const candidate of values) refs.add(candidate.ref);
  for (const values of Object.values(packet.profileCandidatesByAgent)) for (const candidate of values) refs.add(candidate.ref);
  for (const values of Object.values(packet.skillCandidatesByProfile)) for (const candidate of values) refs.add(candidate.ref);
  for (const values of Object.values(packet.toolCandidatesByProfile)) for (const candidate of values) refs.add(candidate.ref);
  for (const values of Object.values(packet.mcpGrantCandidatesByProfile)) for (const candidate of values) refs.add(candidate.ref);
  for (const values of Object.values(packet.instructionCandidatesByProfile)) for (const candidate of values) refs.add(candidate.ref);
  for (const candidate of packet.artifactContractCandidates) refs.add(candidate.ref);
  for (const values of Object.values(packet.evaluatorCandidatesByArtifact)) for (const candidate of values) refs.add(candidate.ref);
  for (const candidate of packet.policyConstraints) refs.add(candidate.ref);
  return refs;
}

function hasCycle(tasks: Array<{ id: string; dependsOn: string[] }>): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function issue(code: WorkflowCompositionValidationIssue["code"], path: string, message: string): WorkflowCompositionValidationIssue {
  return { code, path, message };
}
```

If TypeScript rejects `Parameters<typeof findLibraryEdgesFrom>[2]`, replace the parameter with `edgeType: import("../design-library/types.ts").LibraryEdgeType`.

- [ ] **Step 5: Run validator tests**

Run:

```bash
tsx tests/v2/workflow-composition-validator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run v2 tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/design-library/types.ts src/v2/orchestration/composition-validator.ts tests/v2/workflow-composition-validator.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: validate constrained workflow composition"
```

---

### Task 6: Add Composer Interface And Compiler

**Files:**
- Create: `src/v2/orchestration/composer.ts`
- Create: `src/v2/orchestration/composition-compiler.ts`
- Modify: `src/v2/manifests/types.ts`
- Test: `tests/v2/workflow-composition-compiler.test.ts`

- [ ] **Step 1: Write failing compiler test**

Create `tests/v2/workflow-composition-compiler.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { DeterministicFixtureComposer } from "../../src/v2/orchestration/composer.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";

test("compiler materializes validated composition into Southstar manifest and snapshot", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const packet = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({ goalPrompt: "implement calc sum", candidatePacket: packet });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-software-test",
      goalPrompt: "implement calc sum",
      candidatePacket: packet,
      composition,
    });

    assert.equal(compiled.workflow.schemaVersion, "southstar.v2");
    assert.equal(compiled.workflow.workflowGeneration?.generatorPolicyRef, "library-constrained-llm");
    assert.deepEqual(compiled.workflow.tasks.map((task) => task.id), ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);
    assert.equal(compiled.workflow.tasks[1].agentProfileRef, "profile.software-maker-pi");
    assert.equal(compiled.workflow.tasks[1].skillRefs?.includes("skill.software-implementation"), true);
    assert.equal(compiled.workflow.tasks[1].toolGrantRefs?.includes("tool.workspace-write"), true);
    assert.equal(compiled.workflow.tasks[1].instructionRefs?.includes("instruction.software-maker"), true);
    assert.equal(compiled.orchestrationSnapshot.validation.ok, true);
    assert.equal(compiled.orchestrationSnapshot.candidateSummary.agentProfileRefs.includes("profile.software-maker-pi"), true);
  });
});

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 2: Run failing compiler test**

Run:

```bash
tsx tests/v2/workflow-composition-compiler.test.ts
```

Expected: FAIL because composer/compiler do not exist.

- [ ] **Step 3: Add selected library refs to manifest task type**

In `src/v2/manifests/types.ts`, add these optional fields to `WorkflowTaskDefinition` near the existing `skillRefs?: string[];` and `mcpGrantRefs?: string[];` fields:

```ts
  instructionRefs?: string[];
  toolGrantRefs?: string[];
  vaultLeasePolicyRefs?: string[];
```

- [ ] **Step 4: Implement composer interface and fixture composer**

Create `src/v2/orchestration/composer.ts`:

```ts
import type { CandidatePacket, WorkflowCompositionPlan, WorkflowCompositionTask } from "../design-library/types.ts";

export type ComposeWorkflowInput = {
  goalPrompt: string;
  candidatePacket: CandidatePacket;
};

export interface WorkflowComposer {
  compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan>;
}

export class DeterministicFixtureComposer implements WorkflowComposer {
  async compose(_input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    return {
      schemaVersion: "southstar.workflow_composition_plan.v1",
      title: "Software Dynamic Feature Workflow",
      selectedWorkflowTemplateRef: "workflow.software.explore-make-check",
      rationale: "Fixture composer selects the approved software explore-make-check pattern.",
      tasks: [
        task("understand-repo", [], "agent.software-explorer", "profile.software-explorer-codex", ["skill.repo-exploration"], ["tool.workspace-read"], ["instruction.software-explorer"], ["artifact.implementation_plan"], "evaluator.software-plan-quality"),
        task("implement-feature", ["understand-repo"], "agent.software-maker", "profile.software-maker-pi", ["skill.software-implementation"], ["tool.workspace-read", "tool.workspace-write"], ["instruction.software-maker"], ["artifact.implementation_report"], "evaluator.software-feature-quality"),
        task("verify-feature", ["implement-feature"], "agent.software-checker", "profile.software-checker-codex", ["skill.software-verification"], ["tool.workspace-read"], ["instruction.software-checker"], ["artifact.verification_report"], "evaluator.software-verification-quality"),
        task("summarize-completion", ["verify-feature"], "agent.software-summarizer", "profile.software-summarizer-codex", ["skill.completion-summary"], ["tool.workspace-read"], ["instruction.software-summarizer"], ["artifact.completion_report"], "evaluator.software-completion-quality"),
      ],
      rejectedCandidates: [],
      generatedComponentProposals: [],
    };
  }
}

function task(
  id: string,
  dependsOn: string[],
  agentDefinitionRef: string,
  agentProfileRef: string,
  skillRefs: string[],
  toolGrantRefs: string[],
  instructionRefs: string[],
  outputArtifactRefs: string[],
  evaluatorProfileRef: string,
): WorkflowCompositionTask {
  return {
    id,
    name: id.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" "),
    responsibility: id,
    dependsOn,
    templateSlotRef: id,
    agentDefinitionRef,
    agentProfileRef,
    instructionRefs,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
    inputArtifactRefs: [],
    outputArtifactRefs,
    evaluatorProfileRef,
    recoveryStrategyRefs: ["retry-same-agent"],
    rationale: `Select ${agentProfileRef} for ${id}.`,
  };
}
```

- [ ] **Step 5: Implement composition compiler**

Create `src/v2/orchestration/composition-compiler.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";
import type { CandidatePacket, WorkflowCompositionPlan, WorkflowCompositionValidationResult } from "../design-library/types.ts";

export type CompileWorkflowCompositionInput = {
  runId: string;
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  composition: WorkflowCompositionPlan;
};

export type CompiledWorkflowComposition = {
  workflow: SouthstarWorkflowManifest;
  orchestrationSnapshot: {
    schemaVersion: "southstar.orchestration_snapshot.v1";
    draftId: string;
    requirementSpec: CandidatePacket["requirementSpec"];
    candidatePacketHash: string;
    candidateSummary: {
      workflowTemplateRefs: string[];
      agentDefinitionRefs: string[];
      agentProfileRefs: string[];
      skillRefs: string[];
      toolGrantRefs: string[];
      mcpGrantRefs: string[];
      artifactContractRefs: string[];
      evaluatorProfileRefs: string[];
      policyRefs: string[];
    };
    selectedCompositionPlan: WorkflowCompositionPlan;
    validation: WorkflowCompositionValidationResult;
    compiler: {
      version: "library-constrained-compiler-v1";
      manifestHash: string;
      libraryVersionRefs: string[];
    };
  };
};

export async function compileWorkflowComposition(
  db: SouthstarDb,
  input: CompileWorkflowCompositionInput,
): Promise<CompiledWorkflowComposition> {
  const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, input.composition);
  if (!validation.ok) {
    throw new Error(`workflow composition failed validation: ${JSON.stringify(validation.issues)}`);
  }
  const workflow: SouthstarWorkflowManifest = {
    schemaVersion: "southstar.v2",
    workflowId: `wf-composed-${hash(input.runId).slice(0, 12)}`,
    title: input.composition.title,
    goalPrompt: input.goalPrompt,
    domain: "software",
    intent: input.candidatePacket.requirementSpec.workType === "bugfix" ? "fix_bug" : "implement_feature",
    workflowGeneration: {
      planId: `composition-${hash(JSON.stringify(input.composition)).slice(0, 12)}`,
      generatorPolicyRef: "library-constrained-llm",
      orchestrationSnapshotId: `orch-${hash(JSON.stringify(input.composition)).slice(0, 12)}`,
    },
    tasks: input.composition.tasks.map((task): WorkflowTaskDefinition => ({
      id: task.id,
      name: task.name,
      domain: "software",
      roleRef: roleFromAgent(task.agentDefinitionRef),
      agentProfileRef: task.agentProfileRef,
      dependsOn: task.dependsOn,
      promptInputs: { goalPrompt: input.goalPrompt, responsibility: task.responsibility, instructionRefs: task.instructionRefs },
      requiredArtifactRefs: task.outputArtifactRefs,
      evaluatorPipelineRef: task.evaluatorProfileRef,
      recoveryStrategyRefs: task.recoveryStrategyRefs,
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: {
        validator: "schema-evaluator-v1",
        maxRepairAttempts: 2,
      },
      instructionRefs: task.instructionRefs,
      skillRefs: task.skillRefs,
      toolGrantRefs: task.toolGrantRefs,
      vaultLeasePolicyRefs: task.vaultLeasePolicyRefs,
      mcpGrantRefs: task.mcpGrantRefs,
      subagents: [{
        id: `${roleFromAgent(task.agentDefinitionRef)}-${task.id}`,
        harnessId: harnessFromProfile(task.agentProfileRef),
        prompt: `${task.instructionRefs.join(",")}: ${JSON.stringify({ goalPrompt: input.goalPrompt, responsibility: task.responsibility })}`,
        requiredArtifacts: task.outputArtifactRefs,
      }],
    })),
    harnessDefinitions: [
      {
        id: "pi",
        kind: "pi-agent",
        entrypoint: "southstar-agent-runner",
        image: "southstar/pi-agent:local",
        capabilities: ["software"],
        inputProtocol: "task-envelope-v2",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      },
      {
        id: "codex",
        kind: "codex",
        entrypoint: "southstar-agent-runner",
        image: "southstar/pi-agent:local",
        capabilities: ["software"],
        inputProtocol: "task-envelope-v2",
        eventProtocol: "southstar-events-v1",
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      },
    ],
    evaluators: [{
      id: "schema-evaluator-v1",
      kind: "schema",
      artifactTypes: input.composition.tasks.flatMap((task) => task.outputArtifactRefs),
      requiredFields: ["summary"],
    }],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
  const snapshot = {
    schemaVersion: "southstar.orchestration_snapshot.v1" as const,
    draftId: input.runId,
    requirementSpec: input.candidatePacket.requirementSpec,
    candidatePacketHash: hash(JSON.stringify(input.candidatePacket)),
    candidateSummary: summarizeCandidates(input.candidatePacket),
    selectedCompositionPlan: input.composition,
    validation,
    compiler: {
      version: "library-constrained-compiler-v1" as const,
      manifestHash: hash(JSON.stringify(workflow)),
      libraryVersionRefs: collectVersionRefs(input.candidatePacket),
    },
  };
  return { workflow, orchestrationSnapshot: snapshot };
}

function summarizeCandidates(packet: CandidatePacket): CompiledWorkflowComposition["orchestrationSnapshot"]["candidateSummary"] {
  return {
    workflowTemplateRefs: packet.workflowTemplateCandidates.map((candidate) => candidate.ref),
    agentDefinitionRefs: flatten(packet.agentCandidatesByCapability),
    agentProfileRefs: flatten(packet.profileCandidatesByAgent),
    skillRefs: flatten(packet.skillCandidatesByProfile),
    toolGrantRefs: flatten(packet.toolCandidatesByProfile),
    mcpGrantRefs: flatten(packet.mcpGrantCandidatesByProfile),
    artifactContractRefs: packet.artifactContractCandidates.map((candidate) => candidate.ref),
    evaluatorProfileRefs: flatten(packet.evaluatorCandidatesByArtifact),
    policyRefs: packet.policyConstraints.map((candidate) => candidate.ref),
  };
}

function collectVersionRefs(packet: CandidatePacket): string[] {
  const refs = [
    ...packet.workflowTemplateCandidates,
    ...Object.values(packet.agentCandidatesByCapability).flat(),
    ...Object.values(packet.profileCandidatesByAgent).flat(),
    ...Object.values(packet.skillCandidatesByProfile).flat(),
    ...Object.values(packet.toolCandidatesByProfile).flat(),
    ...Object.values(packet.mcpGrantCandidatesByProfile).flat(),
    ...packet.artifactContractCandidates,
    ...Object.values(packet.evaluatorCandidatesByArtifact).flat(),
    ...packet.policyConstraints,
  ].map((candidate) => candidate.versionRef).filter((value): value is string => Boolean(value));
  return [...new Set(refs)].sort();
}

function flatten(values: Record<string, Array<{ ref: string }>>): string[] {
  return [...new Set(Object.values(values).flat().map((candidate) => candidate.ref))].sort();
}

function roleFromAgent(agentDefinitionRef: string): string {
  return agentDefinitionRef.replace(/^agent\.software-/, "");
}

function harnessFromProfile(agentProfileRef: string): string {
  return agentProfileRef.includes("-pi") ? "pi" : "codex";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 6: Run compiler tests**

Run:

```bash
tsx tests/v2/workflow-composition-compiler.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run validator and resolver tests**

Run:

```bash
tsx tests/v2/library-candidate-resolver.test.ts
tsx tests/v2/workflow-composition-validator.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/manifests/types.ts src/v2/orchestration/composer.ts src/v2/orchestration/composition-compiler.ts tests/v2/workflow-composition-compiler.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: compile constrained workflow compositions"
```

---

### Task 7: Integrate LLM-Constrained Mode Into Planner Draft API

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`

- [ ] **Step 1: Add failing API test for explicit llm-constrained mode**

Append this test to `tests/v2/postgres-run-api.test.ts`; no new imports are needed because this file already imports `test`, `assert`, and `createPostgresPlannerDraft`:

```ts
test("Postgres planner drafts support explicit llm-constrained mode with orchestration snapshot", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
    });
    assert.match(draft.draftId, /^draft-wf-composed-/);

    const draftResource = await db.one<{ payload_json: { plannerTrace: { model: string }; orchestrationSnapshot: { validation: { ok: boolean } } }; summary_json: { planner: string } }>(
      "select payload_json, summary_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "library-constrained-llm");
    assert.equal(draftResource.payload_json.plannerTrace.model, "southstar-library-constrained-fixture-composer");
    assert.equal(draftResource.payload_json.orchestrationSnapshot.validation.ok, true);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);
  });
});
```

Add a server route test body for explicit mode inside the existing server test or as a new test:

```ts
const draft = await api<{ draftId: string; workflowId: string }>(server.url, "/api/v2/planner/drafts", {
  method: "POST",
  body: JSON.stringify({ goalPrompt: "implement calc sum", orchestrationMode: "llm-constrained" }),
});
assert.match(draft.draftId, /^draft-wf-composed-/);
```

- [ ] **Step 2: Run failing API test**

Run:

```bash
tsx tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because `createPostgresPlannerDraft` does not accept `orchestrationMode`.

- [ ] **Step 3: Modify planner draft API**

In `src/v2/ui-api/postgres-run-api.ts`, add imports:

```ts
import { seedSoftwareLibraryGraph } from "../design-library/software-library-seed.ts";
import { analyzeRequirementDeterministically } from "../orchestration/requirement-analyzer.ts";
import { resolveWorkflowCandidates } from "../orchestration/candidate-resolver.ts";
import { DeterministicFixtureComposer } from "../orchestration/composer.ts";
import { compileWorkflowComposition } from "../orchestration/composition-compiler.ts";
```

Change the input type:

```ts
export type CreatePostgresPlannerDraftInput = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
};
```

Change the signature:

```ts
export async function createPostgresPlannerDraft(db: SouthstarDb, input: CreatePostgresPlannerDraftInput): Promise<PostgresPlannerDraftResult> {
  if (input.orchestrationMode === "llm-constrained") {
    return await createLibraryConstrainedPlannerDraft(db, input);
  }
  return await createDeterministicPlannerDraft(db, input);
}
```

Rename the existing body to:

```ts
async function createDeterministicPlannerDraft(db: SouthstarDb, input: { goalPrompt: string }): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-software-${hash(input.goalPrompt).slice(0, 12)}`;
  const plan = generateConstrainedWorkflowPlan({
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    domainPack: softwareDomainPack,
    intentId: inferIntent(input.goalPrompt),
  });
  const workflow = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt: input.goalPrompt });
  const bundle: PlanBundle & { generationPlan: typeof plan } = {
    workflow,
    plannerTrace: { model: "southstar-postgres-constrained-planner", promptHash: hash(input.goalPrompt), generatedAt: new Date().toISOString() },
    generationPlan: plan,
  };
  const draftId = `draft-${workflow.workflowId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: workflow.title,
    payload: bundle,
    summary: { goalPrompt: input.goalPrompt, workflowId: workflow.workflowId, planner: "postgres-constrained" },
  });
  return { draftId, goalPrompt: input.goalPrompt, workflowId: workflow.workflowId };
}
```

Add:

```ts
async function createLibraryConstrainedPlannerDraft(db: SouthstarDb, input: { goalPrompt: string }): Promise<PostgresPlannerDraftResult> {
  const draftRunId = `draft-library-${hash(input.goalPrompt).slice(0, 12)}`;
  await seedSoftwareLibraryGraph(db);
  const requirementSpec = analyzeRequirementDeterministically(input.goalPrompt);
  const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
  if (candidatePacket.unavailableRequirements.length > 0) {
    const draftId = `draft-invalid-${hash(input.goalPrompt).slice(0, 12)}`;
    await upsertRuntimeResourcePg(db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "invalid",
      title: "Invalid Library-Constrained Planner Draft",
      payload: { requirementSpec, candidatePacket },
      summary: { goalPrompt: input.goalPrompt, planner: "library-constrained-llm", status: "invalid" },
    });
    return { draftId, goalPrompt: input.goalPrompt, workflowId: "" };
  }
  const composer = new DeterministicFixtureComposer();
  const composition = await composer.compose({ goalPrompt: input.goalPrompt, candidatePacket });
  const compiled = await compileWorkflowComposition(db, {
    runId: draftRunId,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    composition,
  });
  const bundle: PlanBundle & { orchestrationSnapshot: typeof compiled.orchestrationSnapshot } = {
    workflow: compiled.workflow,
    plannerTrace: {
      model: "southstar-library-constrained-fixture-composer",
      promptHash: hash(input.goalPrompt),
      generatedAt: new Date().toISOString(),
    },
    orchestrationSnapshot: compiled.orchestrationSnapshot,
  };
  const draftId = `draft-${compiled.workflow.workflowId}`;
  await upsertRuntimeResourcePg(db, {
    id: draftId,
    resourceType: "planner_draft",
    resourceKey: draftId,
    scope: "planner",
    status: "validated",
    title: compiled.workflow.title,
    payload: bundle,
    summary: { goalPrompt: input.goalPrompt, workflowId: compiled.workflow.workflowId, planner: "library-constrained-llm" },
  });
  return { draftId, goalPrompt: input.goalPrompt, workflowId: compiled.workflow.workflowId };
}
```

- [ ] **Step 4: Pass orchestration mode through server routes**

In `src/v2/server/routes.ts`, locate the planner draft route that currently calls:

```ts
createPostgresPlannerDraft(context.db, { goalPrompt: body.goalPrompt })
```

Change it to:

```ts
createPostgresPlannerDraft(context.db, {
  goalPrompt: body.goalPrompt,
  orchestrationMode: body.orchestrationMode === "llm-constrained" ? "llm-constrained" : "deterministic",
})
```

Apply the same change to any second planner-draft call in the file.

- [ ] **Step 5: Run API tests**

Run:

```bash
tsx tests/v2/postgres-run-api.test.ts
```

Expected: PASS. The existing default test still uses deterministic mode and the new explicit test uses llm-constrained mode.

- [ ] **Step 6: Run route and runtime tests likely to be affected**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add src/v2/ui-api/postgres-run-api.ts src/v2/server/routes.ts tests/v2/postgres-run-api.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add library-constrained planner draft mode"
```

---

### Task 8: Add Regression Tests Against Hardcoded LLM-Constrained Path

**Files:**
- Create: `tests/v2/library-constrained-regression.test.ts`

- [ ] **Step 1: Write regression tests**

Create `tests/v2/library-constrained-regression.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createPostgresPlannerDraft } from "../../src/v2/ui-api/postgres-run-api.ts";

test("llm-constrained path stores selected refs and validator proof in planner draft", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with tests and docs",
      orchestrationMode: "llm-constrained",
    });
    const resource = await db.one<{ payload_json: { orchestrationSnapshot: { candidateSummary: { agentProfileRefs: string[] }; validation: { ok: boolean } } } }>(
      "select payload_json from southstar.runtime_resources where resource_key = $1",
      [draft.draftId],
    );
    assert.equal(resource.payload_json.orchestrationSnapshot.validation.ok, true);
    assert.deepEqual(
      resource.payload_json.orchestrationSnapshot.candidateSummary.agentProfileRefs,
      ["profile.software-checker-codex", "profile.software-explorer-codex", "profile.software-maker-pi", "profile.software-summarizer-codex"],
    );
  });
});

test("llm-constrained implementation does not call broad or narrow task generators directly", async () => {
  const source = await readFile(new URL("../../src/v2/ui-api/postgres-run-api.ts", import.meta.url), "utf8");
  const llmConstrainedFunction = source.slice(source.indexOf("async function createLibraryConstrainedPlannerDraft"));
  assert.equal(llmConstrainedFunction.includes("broadFeatureTasks"), false);
  assert.equal(llmConstrainedFunction.includes("narrowFeatureTasks"), false);
  assert.equal(llmConstrainedFunction.includes("isBroadFeaturePrompt"), false);
});

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
```

- [ ] **Step 2: Run regression test**

Run:

```bash
tsx tests/v2/library-constrained-regression.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all v2 tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add tests/v2/library-constrained-regression.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover library-constrained orchestration path"
```

---

### Task 9: Final Verification And Documentation Alignment

**Files:**
- Modify: `docs/superpowers/specs/2026-06-23-southstar-library-constrained-llm-orchestrator-design.zh.md` only if implementation reveals a mismatch.
- Create or modify no runtime files in this task unless a verification failure points to a specific prior task defect.

- [ ] **Step 1: Run focused tests**

Run:

```bash
tsx tests/v2/library-graph-store.test.ts
tsx tests/v2/library-candidate-resolver.test.ts
tsx tests/v2/workflow-composition-validator.test.ts
tsx tests/v2/workflow-composition-compiler.test.ts
tsx tests/v2/library-constrained-regression.test.ts
tsx tests/v2/postgres-run-api.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run full v2 suite**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 3: Run real Postgres E2E smoke if local infra is available**

Run:

```bash
npm run test:e2e:postgres:01
npm run test:e2e:postgres:27
```

Expected: PASS. If local Postgres or external runtime dependencies are unavailable, record the exact missing environment variable or service in the final report.

- [ ] **Step 4: Confirm no forbidden query/dependency slipped in**

Run:

```bash
rg -n "WITH RECURSIVE|recursive|pgvector|vector|Apache AGE|Neo4j|age_" src/v2 tests/v2
```

Expected: no matches except documentation comments that explicitly state the feature is not used.

- [ ] **Step 5: Confirm git status**

Run:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
```

Expected: no unstaged implementation changes from this plan. Pre-existing unrelated untracked files may remain; list them in the final report and do not stage them.

- [ ] **Step 6: Commit any final doc alignment**

Only if this task changed documentation:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add docs/superpowers/specs/2026-06-23-southstar-library-constrained-llm-orchestrator-design.zh.md
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "docs: align library-constrained orchestrator design"
```

---

## Execution Notes

- The first implementation pass uses `DeterministicFixtureComposer` to prove the contract without depending on live LLM availability.
- A later plan should replace or augment the fixture composer with a real `plannerClient` adapter that outputs `WorkflowCompositionPlan`, then run the same validator/compiler tests against recorded fixtures.
- The current deterministic constrained generator remains the default until the team explicitly flips the default mode.
- The seed graph intentionally mirrors current software explorer/maker/checker/summarizer behavior so runtime behavior can be compared before removing hardcoded generation.

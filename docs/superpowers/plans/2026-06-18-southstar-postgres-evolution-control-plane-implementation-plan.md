# Southstar Postgres Evolution Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Postgres-only Southstar evolution control plane described in `docs/superpowers/specs/2026-06-17-southstar-postgres-evolution-control-plane-design.md`, covering every success criterion in section 19 with real Postgres/Tork/Pi E2E coverage; this is not an MVP or phased subset.

**Architecture:** Replace SQLite persistence with an async Postgres store that owns only the `southstar` schema and validates metadata at startup. Add a simplified canonical learning graph (`learning_nodes` + `learning_edges`), Knowledge Card pipeline, deterministic ContextBuilder card injection, LLM Wiki bidirectional link read models, delta/sandbox/promotion services, graph/read-model APIs, and an Evolution Control Center UI. Keep Tork executor-only by going through existing executor/Tork clients and by banning Southstar SQL references to `tork.*`.

**Tech Stack:** Node >=22.22.2, TypeScript ESM via `tsx`, `node:test`, `pg`, Postgres schemas, existing Tork/Pi runtime path for real sandbox E2E, Next/React UI, existing Southstar server/API conventions.

---

## Non-negotiable implementation constraints

- No MVP/phased-subset implementation: every success criterion in spec section 19 must be implemented and verified before completion. The phrase "first version" in the source design means the full spec-scoped v1, not a minimal prompt-only or UI-only slice.
- Keep the schema simple: do not add `knowledge_wiki_pages`, `knowledge_wiki_links`, `delta_proposals`, `sandbox_experiments`, or `asset_versions` dedicated tables in this implementation. Store canonical wiki/link/evolution truth in `southstar.learning_nodes` + `southstar.learning_edges`; store operational projections and asset/delta/experiment payloads in `southstar.runtime_resources`.
- No SQLite runtime fallback remains after Task 5. Remove `node:sqlite` usage from v2 runtime code.
- No DB-backed tests use `:memory:` after Postgres migration. Unit tests may stay pure and DB-free.
- Runtime startup validates `southstar.schema_metadata` and fails fast; it does not create or mutate schema.
- `db:init` is the only path that creates/mutates schema objects.
- E2E tests in `tests/e2e-postgres/` require a real Postgres server and, for sandbox promotion, real Tork + Pi harness endpoints. Missing infra fails with a clear error instead of skipping.
- Real E2E must cover low/medium/high Knowledge Card risk behavior, prompt delta promotion, skill delta promotion, low-risk profile promotion, medium-risk profile canary, high-risk profile approval, flow delta approval-only behavior, regression-triggered rollback, and graph lineage. Do not stop after a single prompt-delta happy path.
- Do not create test-only production endpoints, fake executor providers, smoke-only assertions, source-code hardcoded IDs to satisfy tests, or bug-specific conditionals.
- Southstar code and tests must not contain direct SQL references matching `\btork\s*\.` or `set search_path.*tork`.
- Mutating API commands record actor, reason, command id, and an audit/history event.

## File structure

### Create

- `src/v2/db/postgres.ts` — async Postgres connection pool, transaction helper, startup schema metadata validation.
- `src/v2/db/schema.ts` — versioned `southstar` DDL used by `db:init`.
- `src/v2/db/init.ts` — explicit schema initializer and validator.
- `src/v2/db/test-database.ts` — real Postgres test database create/drop helper.
- `src/v2/evolution/types.ts` — Knowledge Card, DeltaProposal, AssetVersion, SandboxExperiment, LLM Wiki link/page, and graph read-model types.
- `src/v2/evolution/learning-graph.ts` — node/edge persistence and graph queries.
- `src/v2/evolution/signals.ts` — structured learning signal capture from runtime facts.
- `src/v2/evolution/cards.ts` — deterministic clustering, card candidate building, validation, activation/approval.
- `src/v2/evolution/context-cards.ts` — deterministic active-card selection and injection trace creation.
- `src/v2/evolution/deltas.ts` — card-to-delta classifier and delta validator.
- `src/v2/evolution/assets.ts` — versioned prompt/skill/profile/flow asset registry, promotion, canary, rollback.
- `src/v2/evolution/sandbox.ts` — baseline/candidate sandbox experiment orchestration and decision rules.
- `src/v2/evolution/wiki.ts` — LLM Wiki page projection, typed bidirectional links, backlinks, related cards, and link validation on top of `learning_nodes`/`learning_edges` only.
- `src/v2/evolution/read-models.ts` — overview, signal, card, delta, experiment, asset, graph/wiki read models.
- `src/v2/server/evolution-routes.ts` — `/api/v2/evolution/*` HTTP route handlers.
- `src/v2/quality/evolution-gates.ts` — assertions for E2E/control-plane correctness.
- `app/evolution/page.tsx` — top-level Evolution Control Center page.
- `components/southstar/pages/EvolutionControlCenterPage.tsx` — UI page sections.
- `components/southstar/evolution/EvolutionGraphViewer.tsx` — bounded local graph rendering.
- `components/southstar/evolution/KnowledgeWikiPanel.tsx` — wiki page, backlinks, forward links, evidence, usage, downstream impact, and conflict/supersession panels.
- `tests/v2/postgres-store.test.ts` — Postgres store/schema tests.
- `tests/v2/evolution-*.test.ts` — unit/integration tests for graph/cards/wiki/context/deltas/sandbox/assets/read-models.
- `tests/e2e-postgres/postgres-real-harness.ts` — real Postgres + real server/Tork/Pi harness utilities.
- `tests/e2e-postgres/evolution-control-plane-real.test.ts` — real E2E scenarios.
- `tests/e2e-postgres/index.test.ts` — imports all Postgres E2E tests.

### Modify

- `package.json` — add `pg`, `@types/pg`, and scripts `test:postgres`, `test:e2e:postgres`.
- `src/config/schema.ts`, `src/config/load-config.ts` — add Postgres config, reject SQLite paths for v2 runtime.
- `src/cli/southstar.ts`, `src/cli/entrypoint.ts` — add `db:init` command wired to explicit schema init.
- `src/v2/config/env.ts` — use `SOUTHSTAR_DATABASE_URL` only as bootstrap override; no SQLite default.
- `src/v2/stores/*.ts` — convert synchronous SQLite store functions to async Postgres queries.
- `src/v2/context/types.ts`, `src/v2/context/builder.ts` — replace runtime memory retrieval with Knowledge Card selection and card injection trace; keep `memory_injection_trace` read compatibility only if existing UI still needs it.
- `src/v2/ui-api/local-api.ts`, `src/v2/server/runtime-context.ts`, `src/v2/server/http-server.ts`, `src/v2/server/routes.ts` — use async DB handle and mount evolution routes.
- `src/v2/ui-api/read-models.ts`, `src/v2/read-models/registry.ts`, `src/v2/read-models/types.ts` — expose evolution read models.
- Existing `tests/v2/*.test.ts` — migrate DB-backed tests from `openSouthstarDb(":memory:")` to real Postgres test DB helper.
- Existing `tests/e2e-real/*` — replace SQLite assertions with Postgres evidence assertions after Task 5.

---

## Task 1: Add real Postgres E2E tests first

**Files:**
- Create: `tests/e2e-postgres/postgres-real-harness.ts`
- Create: `tests/e2e-postgres/evolution-control-plane-real.test.ts`
- Create: `tests/e2e-postgres/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add test scripts and dependencies**

Modify `package.json`:

```json
{
  "scripts": {
    "test:postgres": "tsx tests/v2/postgres-store.test.ts",
    "test:e2e:postgres": "tsx tests/e2e-postgres/index.test.ts"
  },
  "dependencies": {
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/pg": "^8.11.10"
  }
}
```

Keep existing scripts and dependencies; merge these keys instead of replacing the whole file.

- [ ] **Step 2: Create the real Postgres harness**

Create `tests/e2e-postgres/postgres-real-harness.ts`:

```ts
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";

export type RealPostgresE2E = {
  adminUrl: string;
  databaseName: string;
  databaseUrl: string;
  workdir: string;
  configPath: string;
  close(): Promise<void>;
};

export async function createRealPostgresE2E(): Promise<RealPostgresE2E> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required, for example postgres://postgres:postgres@127.0.0.1:5432/postgres");
  }
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();

  const databaseUrl = replaceDatabase(adminUrl, databaseName);
  const workdir = await mkdtemp(join(tmpdir(), "southstar-postgres-e2e-"));
  const configPath = join(workdir, ".northstar.yaml");
  await writeFile(configPath, [
    'schema_version: "1.0"',
    "project:",
    "  name: southstar-postgres-e2e",
    `  root: ${workdir}`,
    "runtime:",
    `  database_url: ${databaseUrl}`,
    "  heartbeat_interval_seconds: 30",
    "  lock_timeout_seconds: 180",
    "  task_timeout_seconds: 7200",
    "  max_retry_attempts: 2",
    "intake:",
    "  mode: local",
    "sources:",
    "  local:",
    "    enabled: true",
    "projection:",
    "  local:",
    "    enabled: false",
    "    blocks_runtime: false",
    "packs:",
    "  search_paths:",
    "    - .northstar/packs",
    "workflow:",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "  path: .northstar/workflows/issue-to-pr-release.yaml",
    "agents:",
    "  path: .northstar/agents",
    "",
  ].join("\n"));

  return {
    adminUrl,
    databaseName,
    databaseUrl,
    workdir,
    configPath,
    async close() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
      await rm(workdir, { recursive: true, force: true });
    },
  };
}

export function runSouthstar(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("npm", ["run", "southstar", "--", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`southstar ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

export function requireRealSandboxInfra(): { torkBaseUrl: string; piHarnessEndpoint: string } {
  const torkBaseUrl = process.env.TORK_BASE_URL;
  const piHarnessEndpoint = process.env.PI_HARNESS_ENDPOINT;
  if (!torkBaseUrl || !piHarnessEndpoint) {
    throw new Error("TORK_BASE_URL and PI_HARNESS_ENDPOINT are required for real sandbox E2E; this suite does not use fake executors");
  }
  return { torkBaseUrl, piHarnessEndpoint };
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

- [ ] **Step 3: Create real E2E test cases**

Create `tests/e2e-postgres/evolution-control-plane-real.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createRealPostgresE2E, requireRealSandboxInfra, runSouthstar } from "./postgres-real-harness.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { openSouthstarDb } from "../../src/v2/db/postgres.ts";
import { createHttpPiPlannerClient } from "../../src/v2/planner/pi-planner.ts";
import { TorkClient } from "../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";

async function api<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

test("db:init creates southstar schema and runtime refuses uninitialized databases", async () => {
  const env = await createRealPostgresE2E();
  try {
    await assert.rejects(() => openSouthstarDb(env.databaseUrl), /db:init has not run|schema_metadata/i);

    runSouthstar(["db:init", "--config", env.configPath]);
    const db = await openSouthstarDb(env.databaseUrl);
    const metadata = await db.one<{ schema_name: string; version: string }>(
      "select schema_name, version from southstar.schema_metadata where schema_name = $1",
      ["southstar"],
    );
    assert.equal(metadata.schema_name, "southstar");
    assert.match(metadata.version, /^2026_06_17/);

    const client = new Client({ connectionString: env.databaseUrl });
    await client.connect();
    const tables = await client.query<{ table_schema: string; table_name: string }>(
      "select table_schema, table_name from information_schema.tables where table_schema in ('southstar', 'tork') order by table_schema, table_name",
    );
    await client.end();
    assert.equal(tables.rows.some((row) => row.table_schema === "southstar" && row.table_name === "workflow_runs"), true);
    assert.equal(tables.rows.some((row) => row.table_schema === "southstar" && row.table_name === "learning_nodes"), true);
  } finally {
    await env.close();
  }
});

test("repair signals synthesize an active Knowledge Card and ContextBuilder records card injection trace", async () => {
  const env = await createRealPostgresE2E();
  try {
    runSouthstar(["db:init", "--config", env.configPath]);
    const db = await openSouthstarDb(env.databaseUrl);
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: createHttpPiPlannerClient({ endpoint: process.env.PI_PLANNER_ENDPOINT ?? "http://127.0.0.1:3999/planner" }),
      executorProvider: new TorkExecutorProvider({ torkClient: new TorkClient({ baseUrl: process.env.TORK_BASE_URL ?? "http://127.0.0.1:8000" }) }),
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const signalBody = {
        actor: "e2e-operator",
        reason: "prove repeated repair evidence becomes deterministic injected knowledge",
        signals: [
          {
            signalKind: "repair_success",
            runId: "run-evo-1",
            taskId: "implement-feature",
            roleRef: "maker",
            intent: "implement_feature",
            agentProfileRef: "software-maker-pi",
            artifactType: "implementation_report",
            failureKind: "missing_required_field",
            missingFields: ["commandsRun", "risks"],
            repairInstruction: "include commandsRun and risks",
            outcome: "passed_after_repair",
            sourceRefs: ["artifact-e2e-1", "eval-e2e-1"],
          },
          {
            signalKind: "repair_success",
            runId: "run-evo-2",
            taskId: "implement-feature",
            roleRef: "maker",
            intent: "implement_feature",
            agentProfileRef: "software-maker-pi",
            artifactType: "implementation_report",
            failureKind: "missing_required_field",
            missingFields: ["commandsRun", "risks"],
            repairInstruction: "include commandsRun and risks",
            outcome: "passed_after_repair",
            sourceRefs: ["artifact-e2e-2", "eval-e2e-2"],
          },
        ],
      };
      const captured = await api<{ nodeIds: string[] }>(server.url, "/api/v2/evolution/signals", {
        method: "POST",
        body: JSON.stringify(signalBody),
      });
      assert.equal(captured.nodeIds.length, 2);

      const synth = await api<{ cardIds: string[] }>(server.url, "/api/v2/evolution/cards/synthesize", {
        method: "POST",
        body: JSON.stringify({ actor: "e2e-operator", reason: "cluster repeated implementation report repair signals" }),
      });
      assert.equal(synth.cardIds.length, 1);

      const cards = await api<Array<{ id: string; status: string; payload: { claims: Array<{ evidenceNodeRefs: string[] }> } }>>(server.url, "/api/v2/evolution/cards");
      assert.equal(cards[0]?.status, "active");
      assert.deepEqual(cards[0]?.payload.claims[0]?.evidenceNodeRefs.sort(), captured.nodeIds.sort());

      const preview = await api<{ contextPacketId: string; selectedCardRefs: string[]; traceId: string }>(server.url, "/api/v2/evolution/context-preview", {
        method: "POST",
        body: JSON.stringify({
          runId: "run-evo-context",
          taskId: "implement-feature",
          goalPrompt: "implement feature and produce implementation_report",
          domain: "software",
          intent: "implement_feature",
          roleRef: "maker",
          agentProfileRef: "software-maker-pi",
          artifactTypes: ["implementation_report"],
          promptTemplateRef: "software-maker-pi",
          skillRefs: ["software.minimal-patch"],
          flowTemplateRef: "software.workflow.feature-implementation",
        }),
      });
      assert.deepEqual(preview.selectedCardRefs, synth.cardIds);
      assert.match(preview.traceId, /^card-trace-/);

      const trace = await db.one<{ payload_json: unknown }>(
        "select payload_json from southstar.runtime_resources where resource_type = $1 and resource_key = $2",
        ["knowledge_card_injection_trace", preview.traceId],
      );
      assert.match(JSON.stringify(trace.payload_json), /implementation_report/);
    } finally {
      await server.close();
      await db.close();
    }
  } finally {
    await env.close();
  }
});

test("prompt delta sandbox validates baseline vs candidate, auto-promotes, then rollback restores previous active asset", async () => {
  const sandboxInfra = requireRealSandboxInfra();
  const env = await createRealPostgresE2E();
  try {
    runSouthstar(["db:init", "--config", env.configPath]);
    const db = await openSouthstarDb(env.databaseUrl);
    const server = await createSouthstarRuntimeServer({
      db,
      plannerClient: createHttpPiPlannerClient({ endpoint: process.env.PI_PLANNER_ENDPOINT ?? sandboxInfra.piHarnessEndpoint }),
      executorProvider: new TorkExecutorProvider({ torkClient: new TorkClient({ baseUrl: sandboxInfra.torkBaseUrl }) }),
      torkObservationClient: new TorkClient({ baseUrl: sandboxInfra.torkBaseUrl }),
      runRoot: env.workdir,
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const baseline = await api<{ assetId: string }>(server.url, "/api/v2/evolution/assets/register", {
        method: "POST",
        body: JSON.stringify({
          actor: "e2e-operator",
          reason: "register current active software maker prompt before proposing a delta",
          assetKind: "prompt_template",
          assetRef: "prompt-software-maker",
          version: "v1",
          status: "active",
          payload: {
            sections: ["Produce a concise implementation_report with summary and filesChanged."],
          },
        }),
      });
      assert.match(baseline.assetId, /^asset-/);

      const signalResult = await api<{ nodeIds: string[] }>(server.url, "/api/v2/evolution/signals", {
        method: "POST",
        body: JSON.stringify({
          actor: "e2e-operator",
          reason: "record evidence for prompt self-check delta",
          signals: [
            {
              signalKind: "repair_success",
              runId: "run-delta-1",
              taskId: "implement-feature",
              roleRef: "maker",
              intent: "implement_feature",
              agentProfileRef: "software-maker-pi",
              promptTemplateRef: "prompt-software-maker",
              artifactType: "implementation_report",
              failureKind: "missing_required_field",
              missingFields: ["commandsRun", "risks"],
              repairInstruction: "add a final artifact checklist before returning implementation_report",
              outcome: "passed_after_repair",
              sourceRefs: ["artifact-delta-1", "eval-delta-1"],
            },
            {
              signalKind: "repair_success",
              runId: "run-delta-2",
              taskId: "implement-feature",
              roleRef: "maker",
              intent: "implement_feature",
              agentProfileRef: "software-maker-pi",
              promptTemplateRef: "prompt-software-maker",
              artifactType: "implementation_report",
              failureKind: "missing_required_field",
              missingFields: ["commandsRun", "risks"],
              repairInstruction: "add a final artifact checklist before returning implementation_report",
              outcome: "passed_after_repair",
              sourceRefs: ["artifact-delta-2", "eval-delta-2"],
            },
          ],
        }),
      });
      assert.equal(signalResult.nodeIds.length, 2);

      const cards = await api<{ cardIds: string[] }>(server.url, "/api/v2/evolution/cards/synthesize", {
        method: "POST",
        body: JSON.stringify({ actor: "e2e-operator", reason: "synthesize prompt delta source card" }),
      });
      assert.equal(cards.cardIds.length, 1);

      const deltas = await api<{ deltaIds: string[] }>(server.url, "/api/v2/evolution/deltas/synthesize", {
        method: "POST",
        body: JSON.stringify({
          actor: "e2e-operator",
          reason: "propose bounded prompt delta from active card",
          sourceCardRefs: cards.cardIds,
          targetRef: "prompt-software-maker",
          targetVersion: "v1",
        }),
      });
      assert.equal(deltas.deltaIds.length, 1);

      const experiment = await api<{ experimentId: string; decision: string; candidateAssetId: string }>(
        server.url,
        `/api/v2/evolution/deltas/${encodeURIComponent(deltas.deltaIds[0]!)}/run-sandbox`,
        { method: "POST", body: JSON.stringify({ actor: "e2e-operator", reason: "validate candidate through real Tork/Pi sandbox" }) },
      );
      assert.equal(experiment.decision, "passed");
      assert.match(experiment.candidateAssetId, /^asset-/);

      const assetsAfterPromotion = await api<Array<{ id: string; status: string; promotedByDeltaId?: string }>>(server.url, "/api/v2/evolution/assets");
      assert.equal(assetsAfterPromotion.some((asset) => asset.id === experiment.candidateAssetId && asset.status === "active" && asset.promotedByDeltaId === deltas.deltaIds[0]), true);
      assert.equal(assetsAfterPromotion.some((asset) => asset.id === baseline.assetId && asset.status === "superseded"), true);

      const rollback = await api<{ activeAssetId: string; rolledBackFromAssetId: string }>(
        server.url,
        `/api/v2/evolution/assets/${encodeURIComponent(experiment.candidateAssetId)}/rollback`,
        { method: "POST", body: JSON.stringify({ actor: "e2e-operator", reason: "prove rollback restores previous active prompt version" }) },
      );
      assert.equal(rollback.activeAssetId, baseline.assetId);
      assert.equal(rollback.rolledBackFromAssetId, experiment.candidateAssetId);

      const graph = await api<{ nodes: Array<{ id: string; type: string }>; edges: Array<{ type: string }> }>(
        server.url,
        `/api/v2/evolution/graph?nodeId=${encodeURIComponent(deltas.deltaIds[0]!)}`,
      );
      assert.equal(graph.nodes.some((node) => node.id === cards.cardIds[0] && node.type === "knowledge_card"), true);
      assert.equal(graph.edges.some((edge) => edge.type === "TESTED"), true);
      assert.equal(graph.edges.some((edge) => edge.type === "ROLLED_BACK_TO"), true);
    } finally {
      await server.close();
      await db.close();
    }
  } finally {
    await env.close();
  }
});
```

The test uses only production evolution APIs. Do not add an E2E-only seed endpoint or test-only route to satisfy it.

- [ ] **Step 4: Create E2E index**

Create `tests/e2e-postgres/index.test.ts`:

```ts
await import("./evolution-control-plane-real.test.ts");
```

- [ ] **Step 5: Run the red E2E tests**

Run:

```bash
npm install
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:e2e:postgres
```

Expected: FAIL because `src/v2/db/postgres.ts`, `db:init`, and evolution APIs do not exist yet. The failure proves the tests are wired and not passing by hardcoded behavior.

---

## Task 2: Add explicit Postgres schema init and startup validation

**Files:**
- Create: `src/v2/db/schema.ts`
- Create: `src/v2/db/init.ts`
- Create: `src/v2/db/postgres.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/cli/southstar.ts`
- Modify: `src/cli/entrypoint.ts`
- Test: `tests/v2/postgres-store.test.ts`

- [ ] **Step 1: Write Postgres schema tests**

Create `tests/v2/postgres-store.test.ts` with real Postgres admin DB setup from `src/v2/db/test-database.ts`. Assert:

```ts
assert.deepEqual(requiredTables.sort(), [
  "artifact_blobs",
  "learning_edges",
  "learning_nodes",
  "library_history",
  "library_objects",
  "library_similarity_index",
  "runtime_resources",
  "schema_metadata",
  "secure_blobs",
  "workflow_history",
  "workflow_runs",
  "workflow_tasks",
].sort());
await assert.rejects(() => openSouthstarDb(uninitializedUrl), /db:init has not run|schema_metadata/i);
```

- [ ] **Step 2: Implement DDL**

Create `src/v2/db/schema.ts` exporting:

```ts
export const SOUTHSTAR_SCHEMA_VERSION = "2026_06_17_postgres_evolution_v1";
export const SOUTHSTAR_SCHEMA_SQL = `
create schema if not exists southstar;
create extension if not exists pgcrypto;

create table if not exists southstar.schema_metadata (
  schema_name text primary key,
  version text not null,
  initialized_at timestamptz not null default now()
);

create table if not exists southstar.workflow_runs (...);
create table if not exists southstar.workflow_tasks (...);
create table if not exists southstar.workflow_history (...);
create table if not exists southstar.runtime_resources (...);
create table if not exists southstar.artifact_blobs (...);
create table if not exists southstar.secure_blobs (...);
create table if not exists southstar.library_objects (...);
create table if not exists southstar.library_history (...);
create table if not exists southstar.library_similarity_index (...);

create table if not exists southstar.learning_nodes (
  id text primary key,
  node_type text not null,
  scope text not null,
  status text not null,
  run_id text,
  task_id text,
  session_id text,
  resource_ref text,
  payload_jsonb jsonb not null default '{}'::jsonb,
  summary_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists southstar.learning_edges (
  id text primary key default gen_random_uuid()::text,
  from_node_id text not null references southstar.learning_nodes(id),
  edge_type text not null,
  to_node_id text not null references southstar.learning_nodes(id),
  weight double precision not null default 1,
  evidence_jsonb jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Do not create dedicated asset/delta/experiment/wiki tables in this implementation.
-- Store asset versions, delta proposals, sandbox experiments, wiki page projections, and link proposals as southstar.runtime_resources rows, and mirror lineage/relationships as learning graph nodes/edges.

insert into southstar.schema_metadata(schema_name, version)
values ('southstar', '${SOUTHSTAR_SCHEMA_VERSION}')
on conflict(schema_name) do update set version = excluded.version;
`;
```

Expand `...` with the existing SQLite schema columns converted to Postgres types: `text`, `integer`, `bytea`, `jsonb`, `timestamptz`, equivalent unique constraints and indexes. Keep all runtime tables in the `southstar` schema.

- [ ] **Step 3: Implement DB init and validation**

Create `src/v2/db/init.ts`:

```ts
import { Client } from "pg";
import { SOUTHSTAR_SCHEMA_SQL, SOUTHSTAR_SCHEMA_VERSION } from "./schema.ts";

export async function initializeSouthstarSchema(databaseUrl: string): Promise<{ version: string }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(SOUTHSTAR_SCHEMA_SQL);
    await client.query("commit");
    return { version: SOUTHSTAR_SCHEMA_VERSION };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

export async function validateSouthstarSchema(client: Pick<Client, "query">): Promise<void> {
  const result = await client.query<{ version: string }>(
    "select version from southstar.schema_metadata where schema_name = $1",
    ["southstar"],
  ).catch((error) => {
    throw new Error(`Southstar Postgres schema is not initialized; run db:init first. ${error.message}`);
  });
  const version = result.rows[0]?.version;
  if (version !== SOUTHSTAR_SCHEMA_VERSION) {
    throw new Error(`Southstar schema version mismatch: expected ${SOUTHSTAR_SCHEMA_VERSION}, got ${version ?? "missing"}`);
  }
}
```

- [ ] **Step 4: Implement Postgres DB handle**

Create `src/v2/db/postgres.ts` with:

```ts
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { validateSouthstarSchema } from "./init.ts";

export type SouthstarDb = {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  one<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (db: SouthstarDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function openSouthstarDb(databaseUrl: string): Promise<SouthstarDb> {
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error("Southstar v2 requires a Postgres database URL; SQLite paths are not supported");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await validateSouthstarSchema(client);
  } finally {
    client.release();
  }
  return poolDb(pool);
}

function poolDb(pool: Pool): SouthstarDb {
  return {
    async query(sql, params = []) { return pool.query(sql, params); },
    async one(sql, params = []) {
      const result = await pool.query(sql, params);
      if (result.rows.length !== 1) throw new Error(`expected exactly one row, got ${result.rows.length}`);
      return result.rows[0];
    },
    async maybeOne(sql, params = []) {
      const result = await pool.query(sql, params);
      if (result.rows.length > 1) throw new Error(`expected zero or one row, got ${result.rows.length}`);
      return result.rows[0] ?? null;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(clientDb(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function clientDb(client: PoolClient): SouthstarDb {
  return {
    async query(sql, params = []) { return client.query(sql, params); },
    async one(sql, params = []) {
      const result = await client.query(sql, params);
      if (result.rows.length !== 1) throw new Error(`expected exactly one row, got ${result.rows.length}`);
      return result.rows[0];
    },
    async maybeOne(sql, params = []) {
      const result = await client.query(sql, params);
      if (result.rows.length > 1) throw new Error(`expected zero or one row, got ${result.rows.length}`);
      return result.rows[0] ?? null;
    },
    tx: (fn) => fn(clientDb(client)),
    close: async () => {},
  };
}
```

- [ ] **Step 5: Add `db:init` CLI**

Modify `src/cli/southstar.ts` to include `"db:init"` in `CLI_COMMANDS`, parse `--config`, and load `runtime.database_url`.

Modify `src/cli/entrypoint.ts` before the generic output branch:

```ts
if (argv[0] === "db:init") {
  const command = buildCliCommand(argv);
  const { initializeSouthstarSchema } = await import("../v2/db/init.ts");
  const result = await initializeSouthstarSchema(command.config.runtime.databaseUrl);
  console.log(JSON.stringify({ type: "db:init", schema: "southstar", version: result.version }));
  return 0;
}
```

- [ ] **Step 6: Run Postgres schema tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:postgres
```

Expected: PASS for schema creation, metadata validation, and SQLite URL rejection.

---

## Task 3: Convert v2 stores and runtime server to async Postgres

**Files:**
- Modify: `src/v2/stores/run-store.ts`
- Modify: `src/v2/stores/task-store.ts`
- Modify: `src/v2/stores/history-store.ts`
- Modify: `src/v2/stores/resource-store.ts`
- Modify: `src/v2/stores/metrics-store.ts`
- Modify: `src/v2/design-library/store.ts`
- Modify: `src/v2/session-graph/sqlite-provider.ts` -> rename to `postgres-provider.ts`
- Modify: `src/v2/context/builder.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/server/*.ts`
- Modify: all DB-backed `tests/v2/*.test.ts`

- [ ] **Step 1: Make store tests fail on async API changes**

Update representative DB-backed tests to use:

```ts
const fixture = await createSouthstarTestDatabase();
try {
  await initializeSouthstarSchema(fixture.databaseUrl);
  const db = await openSouthstarDb(fixture.databaseUrl);
  // test body
  await db.close();
} finally {
  await fixture.drop();
}
```

- [ ] **Step 2: Convert store functions**

Convert every store function to `async` and replace SQLite calls:

```ts
await db.query(
  `insert into southstar.workflow_runs (...) values ($1, $2, ...)`,
  [input.id, input.status, ...],
);
const row = await db.maybeOne<WorkflowRunRow>(
  "select * from southstar.workflow_runs where id = $1",
  [runId],
);
```

Use `jsonb` columns by passing plain objects directly through `pg`, not stringified JSON, for new Postgres columns. For backward-compatible fields whose TS names end in `Json`, parse/serialize at the store boundary until callers are updated.

- [ ] **Step 3: Preserve transactional history/resource mutations**

Replace manual `begin immediate` blocks with:

```ts
await db.tx(async (tx) => {
  await updateWorkflowManifest(tx, input.runId, input.workflowManifestJson);
  await upsertRuntimeResource(tx, { ... });
  await appendHistoryEvent(tx, { ... });
});
```

`appendHistoryEvent` must compute `sequence` inside the same transaction with row-level locking:

```sql
select coalesce(max(sequence), 0) + 1 as next
from southstar.workflow_history
where run_id = $1
for update
```

If Postgres rejects aggregate `for update`, lock the run row first:

```sql
select id from southstar.workflow_runs where id = $1 for update
```

then compute the next sequence.

- [ ] **Step 4: Convert server route handlers and CLI command execution**

Every call chain receiving `SouthstarDb` becomes async. Route handlers already return `Promise<Response>`, so await store/read-model calls in `src/v2/server/routes.ts` and `src/v2/server/evolution-routes.ts`.

- [ ] **Step 5: Remove SQLite module usage**

Delete or leave only a compile-failing tombstone for `src/v2/stores/sqlite.ts`:

```ts
throw new Error("Southstar v2 SQLite store was removed. Use src/v2/db/postgres.ts.");
```

Then replace all imports of `../stores/sqlite.ts` with `../db/postgres.ts` or test helpers.

- [ ] **Step 6: Run full v2 tests against Postgres**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:v2
```

Expected: PASS. If failures occur, fix the store abstraction or callers; do not add result-specific code branches.

---

## Task 4: Implement learning graph and structured signal capture

**Files:**
- Create: `src/v2/evolution/types.ts`
- Create: `src/v2/evolution/learning-graph.ts`
- Create: `src/v2/evolution/signals.ts`
- Modify: `src/v2/executor/tork-callback.ts`
- Modify: `src/v2/session-recovery/operations.ts`
- Test: `tests/v2/evolution-learning-graph.test.ts`
- Test: `tests/v2/evolution-signals.test.ts`

- [ ] **Step 1: Define types**

Create `src/v2/evolution/types.ts` with exact unions from the spec for `LearningNodeType`, `LearningEdgeType`, `KnowledgeCard`, `DeltaProposal`, `AssetVersion`, `SandboxExperiment`, `WikiPageReadModel`, `WikiLinkRelation`, and `GraphReadModel`. `AssetVersion`, `DeltaProposal`, `SandboxExperiment`, and wiki page/link data are payload types stored in `runtime_resources` plus graph nodes/edges; they are not dedicated database tables.

- [ ] **Step 2: Implement graph persistence**

`src/v2/evolution/learning-graph.ts` exposes:

```ts
export async function createLearningNode(db: SouthstarDb, input: CreateLearningNodeInput): Promise<{ id: string }>;
export async function createLearningEdge(db: SouthstarDb, input: CreateLearningEdgeInput): Promise<{ id: string }>;
export async function getEvidenceSubgraph(db: SouthstarDb, nodeId: string, depth: number): Promise<GraphReadModel>;
export async function getLineage(db: SouthstarDb, nodeId: string): Promise<GraphReadModel>;
export async function getImpactGraph(db: SouthstarDb, assetVersionId: string): Promise<GraphReadModel>;
export async function getKnowledgeCardEvidence(db: SouthstarDb, cardId: string): Promise<GraphReadModel>;
```

Use recursive CTEs bounded by `depth <= 4` and `limit 200` to avoid whole-graph reads.

- [ ] **Step 3: Implement signal capture**

`src/v2/evolution/signals.ts` exposes:

```ts
export async function recordLearningSignal(db: SouthstarDb, input: LearningSignalInput): Promise<{ nodeId: string }>;
export async function recordLearningSignals(db: SouthstarDb, input: { actor: string; reason: string; signals: LearningSignalInput[] }): Promise<{ nodeIds: string[] }>;
```

Each signal writes one `learning_signal` node plus `workflow_history` event `evolution.learning_signal_recorded` when `runId` exists. Reject payloads over configured size and redact token-shaped values.

- [ ] **Step 4: Wire runtime signal sources**

From existing callback/recovery code, record signals for:

- accepted artifact summaries,
- evaluator pass/fail result,
- repair requested,
- repair succeeded,
- session checkpoint `transcriptSummary`,
- context packet creation,
- cost/duration/retry/tool-call metrics.

Do not extract raw transcripts.

- [ ] **Step 5: Run tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-learning-graph.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-signals.test.ts
```

Expected: PASS with real Postgres.

---

## Task 4A: Implement simplified LLM Wiki bidirectional link layer

**Files:**
- Create: `src/v2/evolution/wiki.ts`
- Modify: `src/v2/evolution/types.ts`
- Modify: `src/v2/evolution/learning-graph.ts`
- Test: `tests/v2/evolution-wiki.test.ts`
- Test: `tests/e2e-postgres/evolution-control-plane-real.test.ts`

**Storage rule:** Do not create wiki-specific tables. A wiki page is a read-model projection over a `learning_nodes` row. A wiki link is a typed `learning_edges` row. Link proposals, moderation decisions, and page snapshots are optional `runtime_resources` rows only when they are operator-facing projections; they are not canonical truth.

- [ ] **Step 1: Define wiki types without adding tables**

Add these types to `src/v2/evolution/types.ts`:

```ts
export type WikiLinkRelation =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "derived_from"
  | "used_by"
  | "improved"
  | "regressed"
  | "related_topic"
  | "same_as"
  | "broader_than"
  | "narrower_than";

export type WikiLinkStatus = "proposed" | "active" | "rejected" | "stale" | "superseded";

export type WikiPageReadModel = {
  nodeId: string;
  nodeType: LearningNodeType;
  title: string;
  summary: string;
  status: string;
  topicKey?: string;
  aliases: string[];
  forwardLinks: WikiLinkReadModel[];
  backlinks: WikiLinkReadModel[];
  evidenceLinks: WikiLinkReadModel[];
  runtimeUsageLinks: WikiLinkReadModel[];
  downstreamImpactLinks: WikiLinkReadModel[];
  conflictLinks: WikiLinkReadModel[];
  supersessionLinks: WikiLinkReadModel[];
};

export type WikiLinkReadModel = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: WikiLinkRelation;
  status: WikiLinkStatus;
  confidence: number;
  reason: string;
  evidenceNodeRefs: string[];
  createdAt: string;
};
```

Map wiki relations to existing graph edge types instead of adding tables:

```ts
const WIKI_RELATION_TO_EDGE_TYPE = {
  supports: "SUPPORTED_BY",
  contradicts: "CONFLICTS_WITH",
  supersedes: "SUPERSEDES",
  derived_from: "DERIVED_FROM",
  used_by: "INJECTED_CARD",
  improved: "HELPED",
  regressed: "HURT",
  related_topic: "BASED_ON",
  same_as: "BASED_ON",
  broader_than: "BASED_ON",
  narrower_than: "BASED_ON",
} as const;
```

- [ ] **Step 2: Implement wiki service over graph edges**

Create `src/v2/evolution/wiki.ts`:

```ts
export async function getWikiPage(db: SouthstarDb, nodeId: string): Promise<WikiPageReadModel>;
export async function proposeWikiLink(db: SouthstarDb, input: ProposeWikiLinkInput): Promise<{ edgeId: string }>;
export async function approveWikiLink(db: SouthstarDb, input: ModerateWikiLinkInput): Promise<void>;
export async function rejectWikiLink(db: SouthstarDb, input: ModerateWikiLinkInput): Promise<void>;
export async function listBacklinks(db: SouthstarDb, nodeId: string): Promise<WikiLinkReadModel[]>;
export async function listForwardLinks(db: SouthstarDb, nodeId: string): Promise<WikiLinkReadModel[]>;
export async function findOrphanKnowledgeCards(db: SouthstarDb): Promise<Array<{ nodeId: string; topicKey: string }>>;
export async function findStaleWikiLinks(db: SouthstarDb): Promise<Array<{ edgeId: string; reason: string }>>;
```

Validation rules:

- source node and target node must exist,
- relation must be one of `WikiLinkRelation`,
- every proposed link must include `reason`, `confidence`, and at least one existing `evidenceNodeRefs` item unless relation is `same_as`,
- no raw transcript, large log, or secret-like payload in edge evidence,
- LLM may propose links but cannot approve or promote them,
- links involving high-risk/security/tool expansion topics require operator approval before status becomes `active`.

- [ ] **Step 3: Add runtime-generated backlinks**

When ContextBuilder injects a Knowledge Card, create a graph edge from the task/context node to the card node with edge type `INJECTED_CARD` and evidence containing the trace id. `getWikiPage(cardNodeId)` must then show this under `runtimeUsageLinks`.

When a card produces a delta, promotion, canary, rollback, or regression result, create edges:

- card -> delta: `BASED_ON`,
- delta -> sandbox experiment: `TESTED`,
- delta -> promoted asset: `PROMOTED_TO`,
- promoted asset -> regression signal: `HURT`,
- rollback -> previous asset: `ROLLED_BACK_TO`.

`getWikiPage(cardNodeId)` must expose those as `downstreamImpactLinks`.

- [ ] **Step 4: Add wiki tests**

Create `tests/v2/evolution-wiki.test.ts` with real Postgres assertions:

```ts
test("wiki page exposes forward links and backlinks from learning_edges", async () => {
  const db = await openInitializedTestDb();
  const a = await createLearningNode(db, { nodeType: "knowledge_card", scope: "software", status: "active", payload: { topicKey: "artifact-self-check" }, summaryText: "Artifact self-check" });
  const b = await createLearningNode(db, { nodeType: "failure_kind", scope: "software", status: "active", payload: { failureKind: "missing_required_field" }, summaryText: "Missing required field" });
  const link = await proposeWikiLink(db, {
    fromNodeId: a.id,
    toNodeId: b.id,
    relation: "supports",
    actor: "test-operator",
    reason: "Card claim cites repeated missing required field evidence.",
    confidence: 0.9,
    evidenceNodeRefs: [b.id],
  });
  await approveWikiLink(db, { edgeId: link.edgeId, actor: "test-operator", reason: "Evidence node exists and relation is bounded." });

  const pageA = await getWikiPage(db, a.id);
  const pageB = await getWikiPage(db, b.id);
  assert.equal(pageA.forwardLinks.some((item) => item.toNodeId === b.id && item.relation === "supports"), true);
  assert.equal(pageB.backlinks.some((item) => item.fromNodeId === a.id && item.relation === "supports"), true);
});
```

Add tests for rejected links, orphan card detection, stale links after supersession, and runtime usage backlinks after card injection.

- [ ] **Step 5: Add real wiki E2E**

Extend `tests/e2e-postgres/evolution-control-plane-real.test.ts` with a real API scenario:

1. record two evidence-backed Knowledge Cards,
2. propose a typed wiki link through public API,
3. approve it through public API,
4. fetch page A and assert forward link to B,
5. fetch page B and assert backlink from A,
6. inject card A through ContextBuilder preview or normal task context creation,
7. fetch page A and assert runtime usage backlink,
8. produce delta/promotion/rollback from card A,
9. fetch page A and assert downstream impact backlink and rollback lineage.

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT=http://127.0.0.1:4010/run \
npm run test:e2e:postgres
```

Expected: PASS. The test must fail if wiki links are stored only as detached JSON without `learning_edges` rows, or if backlinks cannot be derived by reversing graph edges.

---

## Task 5: Implement Knowledge Cards and deterministic ContextBuilder injection

**Files:**
- Create: `src/v2/evolution/cards.ts`
- Create: `src/v2/evolution/context-cards.ts`
- Modify: `src/v2/context/types.ts`
- Modify: `src/v2/context/builder.ts`
- Modify: `src/v2/domain-packs/types.ts`
- Test: `tests/v2/evolution-cards.test.ts`
- Test: `tests/v2/evolution-context-cards.test.ts`

- [ ] **Step 1: Extend context types**

Modify `ContextBlock.sourceType` to include `"knowledge_card"`; add `selectedKnowledgeCards` to `ContextPacket` while keeping `selectedMemories` as an empty compatibility alias until UI migration completes.

- [ ] **Step 2: Implement card clustering and validation**

`src/v2/evolution/cards.ts` implements:

```ts
export async function synthesizeKnowledgeCards(db: SouthstarDb, input: { actor: string; reason: string; runId?: string }): Promise<{ cardIds: string[] }>;
export function validateKnowledgeCard(card: KnowledgeCard, evidenceNodeIds: Set<string>): CardValidationResult;
export async function approveKnowledgeCard(db: SouthstarDb, input: { cardId: string; actor: string; reason: string; commandId: string }): Promise<void>;
export async function rejectKnowledgeCard(db: SouthstarDb, input: { cardId: string; actor: string; reason: string; commandId: string }): Promise<void>;
```

Cluster by exact structured keys: `scope`, `intent`, `roleRef`, `artifactType`, `failureKind`, sorted `missingFields`, `agentProfileRef`, `skillRef`, `promptTemplateRef`, `flowTemplateRef`.

Activation policy:

- low/medium risk + validator pass -> `active`,
- high risk + validator pass -> `pending_approval`,
- validator fail -> `rejected` with auditable reason.

- [ ] **Step 3: Implement deterministic card selection**

`src/v2/evolution/context-cards.ts` implements:

```ts
export async function selectKnowledgeCardsForTask(db: SouthstarDb, input: TaskCardSelectionInput): Promise<CardSelectionResult>;
export async function persistKnowledgeCardInjectionTrace(db: SouthstarDb, input: PersistCardTraceInput): Promise<{ traceId: string }>;
```

Rank by `supportCount`, `successScore`, `confidence`, and recency. Exclude `superseded`, `do_not_inject`, `stale`, and conflicting active high-confidence cards.

- [ ] **Step 4: Replace memory provider in ContextBuilder**

Modify `buildContextPacket` to call `selectKnowledgeCardsForTask` using task metadata. Persist `runtime_resources(resource_type='knowledge_card_injection_trace')` containing matched metadata, selected refs, excluded refs/reasons, scores, and token contribution.

- [ ] **Step 5: Run card/context tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-cards.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-context-cards.test.ts
```

Expected: PASS. The tests must prove cited evidence exists and that selection is deterministic across repeated runs.

---

## Task 6: Implement delta proposals, sandbox validation, asset versioning, promotion, canary, rollback

**Files:**
- Create: `src/v2/evolution/deltas.ts`
- Create: `src/v2/evolution/sandbox.ts`
- Create: `src/v2/evolution/assets.ts`
- Create: `src/v2/evolution/regression-monitor.ts`
- Test: `tests/v2/evolution-deltas.test.ts`
- Test: `tests/v2/evolution-sandbox.test.ts`
- Test: `tests/v2/evolution-assets.test.ts`
- Test: `tests/v2/evolution-regression-monitor.test.ts`

- [ ] **Step 1: Implement delta classifier and validator**

`deltas.ts` maps active cards to `DeltaProposal` resources and graph nodes for every spec delta kind: `knowledge_card_delta`, `prompt_delta`, `skill_delta`, `agent_profile_delta`, and `flow_delta`. Validator rejects nonexistent targets, wrong target version, missing source card/node refs, secret-like payloads, oversized logs, runtime invariant changes, automatic flow promotion, and high-risk profile/security auto-promotion.

- [ ] **Step 2: Implement asset registry**

`assets.ts` exposes:

```ts
export async function createAssetVersion(db: SouthstarDb, input: CreateAssetVersionInput): Promise<{ id: string }>;
export async function promoteAssetVersion(db: SouthstarDb, input: PromoteAssetVersionInput): Promise<void>;
export async function routeAgentProfileCanary(input: { runId: string; taskId: string; percentage: number }): "baseline" | "candidate";
export async function rollbackAssetVersion(db: SouthstarDb, input: RollbackInput): Promise<{ activeAssetId: string; rolledBackFromAssetId: string }>;
```

Promotion never overwrites payload content. Implement the full promotion matrix: low/medium Knowledge Cards auto-active after validation except high-risk pending approval; prompt and skill deltas auto-promote after sandbox pass; low-risk profile deltas auto-promote; medium-risk profile deltas enter canary; high-risk profile and all flow deltas require human approval. Rollback appends graph/history facts and marks bad versions `rolled_back`.

- [ ] **Step 3: Implement sandbox validation**

`sandbox.ts` creates `sandbox_experiment` resources and graph nodes. It runs baseline and candidate variants through the existing executor/Tork/Pi path where the case requires agent execution, and through real local commands only for deterministic regression cases that do not require an agent. Every trial is marked `run_mode='sandbox'` and gets `SOUTHSTAR_RUN_MODE=sandbox`, `SOUTHSTAR_SANDBOX_EXPERIMENT_ID`, isolated worktree/fixture path, metrics, evaluator refs, and artifact refs.

Decision rules exactly follow the spec:

- candidate pass rate >= baseline pass rate,
- targeted replay failure fixed,
- cost/duration within thresholds,
- no blocked/high-risk failure introduced,
- required evaluators pass.

- [ ] **Step 4: Run delta/sandbox/asset tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-deltas.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-sandbox.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-assets.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-regression-monitor.test.ts
```

Expected: PASS with no fake executor classes in the test code. Assertions must cover prompt, skill, low-risk profile, medium-risk profile canary, high-risk profile approval, flow approval-only behavior, and regression-triggered rollback.

---

## Task 7: Add Evolution API and read models

**Files:**
- Create: `src/v2/server/evolution-routes.ts`
- Create: `src/v2/evolution/read-models.ts`
- Create: `src/v2/evolution/wiki.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/read-models/types.ts`
- Modify: `src/v2/read-models/registry.ts`
- Test: `tests/v2/evolution-api.test.ts`
- Test: `tests/v2/evolution-read-models.test.ts`

- [ ] **Step 1: Implement routes from the spec**

Support:

```text
GET  /api/v2/evolution/overview
GET  /api/v2/evolution/signals
POST /api/v2/evolution/signals
GET  /api/v2/evolution/cards
GET  /api/v2/evolution/cards/:id
POST /api/v2/evolution/cards/:id/approve
POST /api/v2/evolution/cards/:id/reject
POST /api/v2/evolution/cards/synthesize
GET  /api/v2/evolution/deltas
GET  /api/v2/evolution/deltas/:id
POST /api/v2/evolution/deltas/synthesize
POST /api/v2/evolution/deltas/:id/approve
POST /api/v2/evolution/deltas/:id/reject
POST /api/v2/evolution/deltas/:id/run-sandbox
GET  /api/v2/evolution/experiments
GET  /api/v2/evolution/assets
GET  /api/v2/evolution/assets/:id
POST /api/v2/evolution/assets/register
POST /api/v2/evolution/assets/:id/rollback
GET  /api/v2/evolution/graph?nodeId=...
GET  /api/v2/evolution/wiki/:nodeId
GET  /api/v2/evolution/wiki/:nodeId/backlinks
GET  /api/v2/evolution/wiki/:nodeId/links
POST /api/v2/evolution/wiki/links
POST /api/v2/evolution/wiki/links/:edgeId/approve
POST /api/v2/evolution/wiki/links/:edgeId/reject
GET  /api/v2/evolution/wiki/orphans
GET  /api/v2/evolution/wiki/stale-links
```

Add `POST /api/v2/evolution/context-preview` only if it uses production ContextBuilder and records the same resources as normal context creation; document it as operator preview, not test-only.

- [ ] **Step 2: Enforce mutating command audit contract**

All POST bodies require:

```ts
type EvolutionCommandBody = {
  actor: string;
  reason: string;
  commandId?: string;
};
```

If `commandId` is omitted, generate one and persist it in `workflow_history` or `runtime_resources.summary_json` depending on whether the command is run-scoped.

- [ ] **Step 3: Implement read models**

`read-models.ts` returns the page sections in spec section 16.2: health overview, signal feed, card library, delta queue, experiments, assets, canary/regression, graph summary, and wiki backlink summary. Wiki read models must be derived from `learning_nodes` and `learning_edges`, not from dedicated wiki tables.

- [ ] **Step 4: Run API tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-api.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres tsx tests/v2/evolution-read-models.test.ts
```

Expected: PASS. Tests must issue HTTP requests against `createSouthstarRuntimeServer`; do not call service functions directly in API tests.

---

## Task 8: Add Evolution Control Center UI

**Files:**
- Create: `app/evolution/page.tsx`
- Create: `components/southstar/pages/EvolutionControlCenterPage.tsx`
- Create: `components/southstar/evolution/EvolutionGraphViewer.tsx`
- Create: `components/southstar/evolution/KnowledgeWikiPanel.tsx`
- Modify: `components/southstar/app-shell/SouthstarTabRail.tsx`
- Modify: `components/southstar/types.ts`
- Test: `tests/web/southstar-evolution-control-center.test.tsx`

- [ ] **Step 1: Add top-level navigation**

Add an `Evolution` tab pointing to `/evolution`, not a subsection under Sessions/Memory.

- [ ] **Step 2: Implement page sections**

Render these panels using existing Southstar UI components:

- Evolution Health Overview,
- Learning Signal Feed,
- Knowledge Card Library,
- Delta Proposal Queue,
- Sandbox Experiments,
- Asset Version Registry,
- Canary / Regression Monitor,
- Graph Viewer,
- Knowledge Wiki page/backlinks panel.

- [ ] **Step 3: Implement bounded graph viewer**

`EvolutionGraphViewer` consumes `GraphReadModel`, renders only local neighborhoods, and exposes node type/status labels. It must not request the entire graph by default.

- [ ] **Step 4: Implement Knowledge Wiki panel**

`KnowledgeWikiPanel` consumes `WikiPageReadModel` and renders:

- page title/status/topic aliases,
- forward links,
- backlinks,
- evidence links,
- runtime usage links,
- downstream impact links,
- conflict and supersession warnings.

The panel must call `/api/v2/evolution/wiki/:nodeId`; it must not query a dedicated wiki table or assume links are embedded only in card JSON.

- [ ] **Step 5: Run UI tests**

Run:

```bash
npm test -- tests/web/southstar-evolution-control-center.test.tsx
npm run web:build
```

Expected: PASS and production build succeeds.

---

## Task 9: Add static gates for Tork boundary, SQLite removal, secrets, and no hardcoded E2E shortcuts

**Files:**
- Create: `tests/v2/evolution-static-gates.test.ts`
- Create: `src/v2/quality/evolution-gates.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Add static source tests**

Assert:

```ts
assert.equal(matches(/\btork\s*\./i, sourceFiles).length, 0);
assert.equal(matches(/node:sqlite|better-sqlite|sqlite-provider|openSouthstarDb\(":memory:"\)/i, sourceFiles).length, 0);
assert.equal(matches(/e2e\/seed|test-only|fake executor|mock executor/i, productionSourceFiles).length, 0);
assert.equal(matches(/create table .*knowledge_wiki_pages|create table .*knowledge_wiki_links|create table .*asset_versions|create table .*delta_proposals|create table .*sandbox_experiments/i, sourceFiles).length, 0);
```

Allow `tests/e2e-postgres` to mention missing infra errors, but not fake/mock classes.

- [ ] **Step 2: Add quality gates**

`assertEvolutionControlPlaneGates(db)` verifies:

- schema metadata present,
- at least one active Knowledge Card has cited evidence,
- context trace selected cards deterministically,
- a sandbox experiment has baseline and candidate trials,
- a promoted asset has rollback target,
- graph contains evidence/promotion/rollback lineage,
- wiki pages expose backlinks by reversing `learning_edges`,
- no dedicated wiki/asset/delta/experiment tables exist,
- no raw transcript-sized payloads in learning nodes.

- [ ] **Step 3: Run static gates**

Run:

```bash
tsx tests/v2/evolution-static-gates.test.ts
```

Expected: PASS.

---

## Task 10: Add no-MVP completeness E2E scenarios

**Files:**
- Modify: `tests/e2e-postgres/evolution-control-plane-real.test.ts`
- Modify: `src/v2/quality/evolution-gates.ts`

- [ ] **Step 1: Add Knowledge Card risk lifecycle E2E**

Extend `tests/e2e-postgres/evolution-control-plane-real.test.ts` with one real API-driven test that records evidence and synthesizes:

- low-risk card -> `active`,
- medium-risk card -> `active`,
- high-risk card recommending tool/MCP/security/release changes -> `pending_approval`,
- high-risk approve command -> `active`,
- reject command -> `rejected`,
- do-not-inject command -> excluded from ContextBuilder.

- [ ] **Step 2: Add all delta-kind promotion-policy E2E**

Add real API-driven E2E assertions for:

- `knowledge_card_delta` lifecycle update/supersede,
- `prompt_delta` sandbox pass -> active asset,
- `skill_delta` sandbox pass -> active asset,
- low-risk `agent_profile_delta` sandbox pass -> active asset,
- medium-risk `agent_profile_delta` sandbox pass -> `canary`, with deterministic canary routing by run/task hash,
- high-risk `agent_profile_delta` sandbox pass -> `pending_approval`,
- `flow_delta` dry-run DAG validation -> `pending_approval`, never auto-promoted.

Each case must persist graph nodes/edges and runtime audit facts; no service-only assertions.

- [ ] **Step 3: Add regression monitor and rollback E2E**

Create a promoted/canary asset, record post-promotion regression metrics through production APIs, run the regression monitor, and assert:

- low-risk auto-promoted asset rolls back automatically,
- high-risk/approval-required asset creates an approval alert instead of auto-rollback,
- rollback restores the previous active version without deleting history,
- graph has `ROLLED_BACK_TO` and `HURT` lineage.

- [ ] **Step 4: Add LLM Wiki bidirectional link E2E**

Through public APIs only, create two evidence-backed Knowledge Cards, propose and approve a typed wiki link, assert page A forward links to page B, assert page B backlinks to page A, inject one card into a task context, and assert its wiki page shows runtime usage and downstream impact backlinks derived from `learning_edges`.

- [ ] **Step 5: Add run-completed batch synthesis E2E**

Complete a real or fixture-backed run through the normal callback path, record repeated repair/evaluator signals, and assert run completion triggers batch Knowledge Card synthesis without manual `/cards/synthesize`.

- [ ] **Step 6: Run no-MVP E2E slice**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT=http://127.0.0.1:4010/run \
npm run test:e2e:postgres
```

Expected: PASS. Coverage must show every spec section 19 success criterion is exercised by real APIs and real Postgres.

---

## Task 11: Run full verification and real E2E gates

**Files:**
- Modify any tests still importing SQLite helpers.
- Update docs only if commands or config fields changed.

- [ ] **Step 1: Full unit/integration suite**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:v2
```

Expected: PASS.

- [ ] **Step 2: Real Postgres evolution E2E**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT=http://127.0.0.1:4010/run \
npm run test:e2e:postgres
```

Expected: PASS. Evidence must show real databases created/dropped, real HTTP server routes exercised, real sandbox baseline/candidate trials recorded, and asset rollback restored previous active version.

- [ ] **Step 3: Existing real E2E suite after Postgres migration**

Run only when real infra is available:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
PI_HARNESS_ENDPOINT=http://127.0.0.1:4010/run \
npm run test:e2e:real
```

Expected: PASS with Postgres evidence assertions replacing SQLite evidence assertions.

- [ ] **Step 4: Product build**

Run:

```bash
npm run web:build
```

Expected: PASS.

---

## Self-review against the design spec

- Postgres-only runtime: covered by Tasks 2, 3, 9, 10.
- Separate `tork` and `southstar` schemas; no direct `tork.*` SQL: covered by Tasks 2, 9.
- Runtime truth tables in `southstar`: covered by Tasks 2, 3.
- Learning graph: covered by Task 4.
- Simplified table strategy: covered by Task 2 schema tests and Task 9 static gates; wiki/assets/deltas/experiments are resources + graph nodes/edges, not dedicated tables.
- LLM Wiki bidirectional links: covered by Task 4A, Task 7 APIs, Task 8 UI, and Task 10 E2E.
- Knowledge Cards and lifecycle: covered by Task 5.
- Deterministic ContextBuilder card selection and injection trace: covered by Task 5 and E2E Task 1.
- Delta proposals and validation: covered by Task 6.
- Sandbox baseline/candidate validation: covered by Task 6 and E2E Tasks 1 and 10.
- Asset versioning, promotion, canary, rollback: covered by Task 6 and E2E Tasks 1 and 10.
- Full non-MVP success-criteria coverage: covered by Task 10 and Task 11.
- Graph API/read models: covered by Task 7.
- Evolution Control Center UI: covered by Task 8.
- Real E2E cases, no fake/smoke/mock/hardcode: covered by Task 1 constraints and Task 11 verification.

Plan complete and saved to `docs/superpowers/plans/2026-06-18-southstar-postgres-evolution-control-plane-implementation-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

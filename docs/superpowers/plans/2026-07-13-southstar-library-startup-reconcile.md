# Southstar Library Startup Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Git-managed, approved Library files atomically reconcile into the Postgres Library graph before Southstar accepts Goal traffic, with durable readiness diagnostics shared by startup, Library authoring, imports, APIs, and the browser.

**Architecture:** Add one file-catalog and reconcile boundary under `src/v2/design-library/files/`. It discovers all supported files, resolves a reference-closed approved set without placeholders, atomically projects file-backed graph state and readiness resources, then exposes a read-only readiness guard to startup, health, and `/run-goal`. Existing Library Save & Sync and import approval call the same reconcile boundary; the browser never supplies or executes a Goal Design skill.

**Tech Stack:** Node.js `>=22.22.2`, TypeScript ESM executed with `tsx`, Postgres `southstar` schema through the existing `SouthstarDb` abstraction, Next.js 16.2.1, React 19.2.4, Node `assert` tests, and Playwright browser E2E.

## Global Constraints

- Production workflow composition remains `composerMode: "llm"`; do not add fixture or fallback composer modes.
- Do not add seed content, domain packs, fixture data, mocks, fakes, smoke substitutes, placeholder graph objects, or hardcoded Library object ids.
- Runtime Goal and composer code reads the Postgres graph only; `/api/v2/run-goal` must not scan files or mutate Library state.
- A file declaring `status: approved` is deployment-approved only after parser, schema, reference-closure, and required-purpose validation succeeds.
- Required runtime skills are selected by metadata purpose (`goal_design` and `composer_guidance`), never by a concrete object key.
- All graph writes, edge reconciliation, removal deprecation, snapshot persistence, and readiness persistence occur in one Postgres transaction protected by an advisory transaction lock.
- Removed file-backed objects are deprecated and their outgoing file-sourced edges are deactivated; existing run snapshots remain unchanged.
- Invalid approved files and required-purpose cardinality violations fail reconciliation; invalid non-approved and non-core incomplete files are excluded with structured diagnostics.
- Preserve unrelated dirty worktree changes, especially the existing recovery and Operator UI edits.
- Do not add a Postgres table; persist immutable snapshots and the current pointer in `runtime_resources`.

---

## File Structure

- Create `src/v2/design-library/files/library-reconcile-service.ts`: catalog discovery, approved closure resolution, purpose validation, transactional graph projection, snapshot/readiness persistence, and readiness queries.
- Modify `src/v2/design-library/files/library-file-parser.ts`: retain safely parsed lifecycle metadata on parse failures so approved-invalid files can fail closed without re-parsing YAML elsewhere.
- Modify `src/v2/design-library/files/library-file-types.ts`: add failed-parse metadata and typed reconcile diagnostics.
- Modify `src/v2/design-library/files/library-file-store.ts`: expose supported reference projection and replace placeholder-producing batch behavior with object-first, edge-second graph synchronization.
- Modify `src/v2/design-library/library-graph-store.ts`: add narrow file-provenance and outgoing-edge lifecycle helpers used by the reconcile transaction.
- Modify `src/v2/server/runtime-server-lifecycle.ts`: reconcile after Postgres connection and before runtime listen/PID readiness.
- Modify `src/v2/server/planner-routes.ts`: reject Goal generation with structured HTTP 503 before idempotency claim when Library readiness is absent or failed.
- Modify `src/v2/server/routes.ts`: include Library readiness in runtime health.
- Modify `src/v2/server/library-routes.ts`: make Save & Sync call full reconciliation.
- Modify `src/v2/design-library/importers/library-import-draft-store.ts`: publish import approval using the same transaction-level projection rules and refresh readiness.
- Modify `web/lib/workflow/generate-stream.ts`: parse structured upstream workflow errors.
- Modify `web/hooks/useAgentSession.ts`: display an actionable Library-not-ready message.
- Modify `tests/e2e-postgres/postgres-real-harness.ts`: invoke the production runtime-start preparation seam, not a test-only file list.
- Modify `tests/e2e-browser/32-goal-vocabulary-browser.test.ts`: remove explicit base-Library sync and verify startup provenance/readiness plus existing UI snapshots.

### Task 1: Parse-Aware Library Catalog And Closed Approved Set

**Files:**

- Create: `src/v2/design-library/files/library-reconcile-service.ts`
- Modify: `src/v2/design-library/files/library-file-parser.ts`
- Modify: `src/v2/design-library/files/library-file-types.ts`
- Modify: `src/v2/design-library/files/library-file-store.ts`
- Test: `tests/v2/library-reconcile-service.test.ts`

**Interfaces:**

- Consumes: `listLibraryFiles({ root })`, `readLibraryFile({ root, relativePath })`, `projectLibraryFileToGraph(file)`.
- Produces: `loadLibraryFileCatalog(input: { root: string }): Promise<LibraryFileCatalog>`, `resolveClosedApprovedLibraryFileSet(records: LibraryFileRecord[]): ClosedApprovedLibraryFileSet`, `validateRequiredLibraryPurposes(records: LibraryFileRecord[]): LibraryFileDiagnostic[]`, and `libraryFileReferences(file: LibraryFileRecord): string[]`.
- Produces parse failure metadata as `LibraryFileParseResult` member `metadata?: { status?: LibraryFileStatus; objectKey?: string }`.

- [ ] **Step 1: Write failing unit tests for parse metadata, closure, duplicates, and purpose cardinality**

Create `tests/v2/library-reconcile-service.test.ts` with table-driven records and temporary files:

```ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LibraryFileRecord } from "../../src/v2/design-library/files/library-file-types.ts";
import {
  loadLibraryFileCatalog,
  resolveClosedApprovedLibraryFileSet,
  validateRequiredLibraryPurposes,
} from "../../src/v2/design-library/files/library-reconcile-service.ts";

function record(input: {
  objectKey: string;
  kind?: LibraryFileRecord["kind"];
  status?: LibraryFileRecord["status"];
  purpose?: string;
  refs?: string[];
}): LibraryFileRecord {
  const kind = input.kind ?? "skill";
  return {
    path: `library/${kind}s/${input.objectKey}.${kind === "skill" ? "skill.md" : "tool.yaml"}`,
    kind,
    objectKey: input.objectKey,
    objectKind: kind === "skill" ? "skill_spec" : "tool_definition",
    id: input.objectKey,
    title: input.objectKey,
    scope: "global",
    status: input.status ?? "approved",
    schemaVersion: kind === "skill"
      ? "southstar.library.skill_spec_file.v1"
      : "southstar.library.tool_definition_file.v1",
    frontmatter: {
      id: input.objectKey,
      title: input.objectKey,
      scope: "global",
      status: input.status ?? "approved",
      purpose: input.purpose,
      requiresToolRefs: input.refs ?? [],
    },
    definition: {
      id: input.objectKey,
      title: input.objectKey,
      scope: "global",
      status: input.status ?? "approved",
      purpose: input.purpose,
      requiresToolRefs: input.refs ?? [],
    },
    body: "Use this instruction body.",
    sourceHash: input.objectKey.padEnd(64, "0").slice(0, 64),
  };
}

test("closed approved set recursively excludes files with missing references", () => {
  const tool = record({ objectKey: "tool.present", kind: "tool" });
  const closed = record({ objectKey: "skill.closed", refs: ["tool.present"] });
  const directMissing = record({ objectKey: "skill.direct", refs: ["tool.missing"] });
  const transitiveMissing = record({ objectKey: "skill.transitive", refs: ["skill.direct"] });
  const result = resolveClosedApprovedLibraryFileSet([tool, closed, directMissing, transitiveMissing]);
  assert.deepEqual(result.included.map((item) => item.objectKey).sort(), ["skill.closed", "tool.present"]);
  assert.deepEqual(result.excluded.map((item) => item.objectKey).sort(), ["skill.direct", "skill.transitive"]);
  assert.deepEqual(result.excluded.find((item) => item.objectKey === "skill.direct")?.missingRefs, ["tool.missing"]);
  assert.deepEqual(
    resolveClosedApprovedLibraryFileSet([transitiveMissing, directMissing, closed, tool]),
    result,
  );
});

test("catalog discovers every supported Library file kind", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-kinds-"));
  const cases = [
    ["agents/a.agent.md", "southstar.library.agent_definition_file.v1", "agent.a"],
    ["skills/s.skill.md", "southstar.library.skill_spec_file.v1", "skill.s"],
    ["tools/t.tool.yaml", "southstar.library.tool_definition_file.v1", "tool.t"],
    ["mcp/m.mcp.yaml", "southstar.library.mcp_grant_file.v1", "mcp.m"],
    ["vault/v.vault.yaml", "southstar.library.vault_lease_policy_file.v1", "vault.v"],
    ["profiles/p.profile.yaml", "southstar.library.generated_agent_profile_file.v1", "profile.p"],
    ["workflows/w.workflow.yaml", "southstar.library.workflow_template_file.v1", "workflow.w"],
    ["capabilities/c.capability.yaml", "southstar.library.capability_spec_file.v1", "capability.c"],
    ["artifacts/a.artifact.yaml", "southstar.library.artifact_contract_file.v1", "artifact.a"],
    ["domains/d.domain.yaml", "southstar.library.domain_taxonomy_file.v1", "domain.d"],
    ["evaluators/e.evaluator.yaml", "southstar.library.evaluator_profile_file.v1", "evaluator.e"],
  ] as const;
  for (const [relativePath, schemaVersion, id] of cases) {
    await mkdir(join(root, relativePath.split("/")[0]!), { recursive: true });
    const common = `schemaVersion: ${schemaVersion}\nid: ${id}\ntitle: ${id}\nscope: global\nstatus: draft\n`;
    const content = relativePath.endsWith(".md") ? `---\n${common}---\ninstructions\n` : common;
    await writeFile(join(root, relativePath), content);
  }
  const catalog = await loadLibraryFileCatalog({ root });
  assert.deepEqual(new Set(catalog.records.map((file) => file.kind)), new Set([
    "agent", "skill", "tool", "mcp", "vault", "generated_profile", "workflow_template",
    "capability", "artifact", "domain", "evaluator",
  ]));
});

test("required purposes are metadata-driven and require exactly one non-empty skill body", () => {
  const goal = record({ objectKey: "skill.any-goal-id", purpose: "goal_design" });
  const composer = record({ objectKey: "skill.any-composer-id", purpose: "composer_guidance" });
  assert.deepEqual(validateRequiredLibraryPurposes([goal, composer]), []);
  assert.match(validateRequiredLibraryPurposes([goal])[0]?.message ?? "", /composer_guidance.*found 0/);
  assert.match(validateRequiredLibraryPurposes([goal, { ...goal, objectKey: "skill.duplicate" }, composer])[0]?.message ?? "", /goal_design.*found 2/);
});

test("catalog reports invalid draft but marks invalid approved as fatal", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  await mkdir(join(root, "skills"));
  await writeFile(join(root, "skills", "draft.skill.md"), `---\nschemaVersion: wrong\nid: skill.draft\ntitle: Draft\nscope: global\nstatus: draft\n---\nbody\n`);
  await writeFile(join(root, "skills", "approved.skill.md"), `---\nschemaVersion: wrong\nid: skill.approved\ntitle: Approved\nscope: global\nstatus: approved\n---\nbody\n`);
  const catalog = await loadLibraryFileCatalog({ root });
  assert.equal(catalog.records.length, 0);
  assert.equal(catalog.diagnostics.length, 2);
  assert.equal(catalog.diagnostics.find((item) => item.objectKey === "skill.draft")?.fatal, false);
  assert.equal(catalog.diagnostics.find((item) => item.objectKey === "skill.approved")?.fatal, true);
});

test("catalog makes duplicate object keys fatal and names both paths", async () => {
  const result = resolveClosedApprovedLibraryFileSet([
    record({ objectKey: "skill.same" }),
    { ...record({ objectKey: "skill.same" }), path: "library/skills/second.skill.md" },
  ]);
  assert.equal(result.diagnostics[0]?.code, "duplicate_object_key");
  assert.deepEqual(result.diagnostics[0]?.paths.sort(), [
    "library/skills/second.skill.md",
    "library/skills/skill.same.skill.md",
  ]);
});
```

- [ ] **Step 2: Run the new tests and confirm the module/interfaces are absent**

Run: `npx tsx --test tests/v2/library-reconcile-service.test.ts`

Expected: FAIL with `Cannot find module .../library-reconcile-service.ts`.

- [ ] **Step 3: Extend parse results with lifecycle metadata available on validation failure**

In `library-file-types.ts`, define the discriminated parse result as:

```ts
export type LibraryFileParseMetadata = {
  status?: LibraryFileStatus;
  objectKey?: string;
};

export type LibraryFileParseResult =
  | { ok: true; file: LibraryFileRecord; issues: LibraryFileValidationIssue[]; metadata: LibraryFileParseMetadata }
  | { ok: false; issues: LibraryFileValidationIssue[]; metadata?: LibraryFileParseMetadata };
```

In `parseLibraryFileContent`, after parsing the frontmatter/YAML object, construct metadata once and include it in both validation outcomes:

```ts
const metadata = {
  status: VALID_STATUSES.has(status as LibraryFileRecord["status"])
    ? status as LibraryFileRecord["status"]
    : undefined,
  objectKey: id || undefined,
};

if (issues.some((issue) => issue.severity === "error")) {
  return { ok: false, issues, metadata };
}

return { ok: true, file, issues, metadata };
```

Keep syntax/frontmatter failures as `{ ok: false, issues }`, because no trustworthy declared status exists.

- [ ] **Step 4: Export typed reference extraction from the existing graph projection vocabulary**

In `library-file-store.ts`, add:

```ts
export function libraryFileReferences(file: LibraryFileRecord): string[] {
  return [...new Set(projectLibraryFileToGraph(file).edges.map((edge) => edge.toObjectKey))].sort();
}
```

Do not add a second reference-key list. `projectLibraryFileToGraph` and `EDGE_REF_PROJECTIONS` remain the single reference vocabulary.

- [ ] **Step 5: Implement catalog loading, duplicate detection, fixed-point closure, and purpose validation**

Create `library-reconcile-service.ts` with these public types and pure functions:

```ts
import { createHash } from "node:crypto";
import type { LibraryDefinitionKind } from "../types.ts";
import { libraryFileReferences, listLibraryFiles, readLibraryFile } from "./library-file-store.ts";
import type { LibraryFileRecord } from "./library-file-types.ts";

export type LibraryFileDiagnostic = {
  code: "parse_invalid" | "duplicate_object_key" | "missing_reference" | "required_purpose_cardinality" | "required_purpose_content";
  message: string;
  fatal: boolean;
  paths: string[];
  objectKey?: string;
  missingRefs: string[];
};

export type LibraryFileCatalog = {
  root: string;
  records: LibraryFileRecord[];
  diagnostics: LibraryFileDiagnostic[];
};

export type ClosedApprovedLibraryFileSet = {
  included: LibraryFileRecord[];
  excluded: Array<LibraryFileDiagnostic & { objectKey: string }>;
  diagnostics: LibraryFileDiagnostic[];
};

export async function loadLibraryFileCatalog(input: { root: string }): Promise<LibraryFileCatalog> {
  const entries = await listLibraryFiles(input);
  const reads = await Promise.all(entries.map((entry) => readLibraryFile({ root: input.root, relativePath: entry.relativePath })));
  const records: LibraryFileRecord[] = [];
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const read of reads) {
    if (read.parsed.ok) {
      records.push(read.parsed.file);
      continue;
    }
    diagnostics.push({
      code: "parse_invalid",
      message: read.parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      fatal: read.parsed.metadata?.status === "approved" || read.parsed.metadata?.status === undefined,
      paths: [`library/${read.relativePath}`],
      objectKey: read.parsed.metadata?.objectKey,
      missingRefs: [],
    });
  }
  return { root: input.root, records: records.sort((a, b) => a.path.localeCompare(b.path)), diagnostics };
}

export function resolveClosedApprovedLibraryFileSet(records: LibraryFileRecord[]): ClosedApprovedLibraryFileSet {
  const byKey = new Map<string, LibraryFileRecord[]>();
  for (const record of records) byKey.set(record.objectKey, [...(byKey.get(record.objectKey) ?? []), record]);
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const [objectKey, matches] of byKey) {
    if (matches.length > 1) diagnostics.push({
      code: "duplicate_object_key",
      message: `duplicate Library object key ${objectKey}`,
      fatal: true,
      paths: matches.map((item) => item.path).sort(),
      objectKey,
      missingRefs: [],
    });
  }
  if (diagnostics.length > 0) return { included: [], excluded: [], diagnostics };

  const approved = records.filter((record) => record.status === "approved");
  const candidates = new Map(approved.map((record) => [record.objectKey, record]));
  const missingByKey = new Map<string, string[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [objectKey, record] of [...candidates]) {
      const missing = libraryFileReferences(record).filter((ref) => !candidates.has(ref));
      if (missing.length === 0) continue;
      candidates.delete(objectKey);
      missingByKey.set(objectKey, missing);
      changed = true;
    }
  }
  const excluded = approved
    .filter((record) => !candidates.has(record.objectKey))
    .map((record) => ({
      code: "missing_reference" as const,
      message: `${record.objectKey} is excluded because required references are not in the approved closed set`,
      fatal: false,
      paths: [record.path],
      objectKey: record.objectKey,
      missingRefs: missingByKey.get(record.objectKey) ?? libraryFileReferences(record).filter((ref) => !candidates.has(ref)),
    }));
  return { included: [...candidates.values()].sort((a, b) => a.objectKey.localeCompare(b.objectKey)), excluded, diagnostics };
}

export function validateRequiredLibraryPurposes(records: LibraryFileRecord[]): LibraryFileDiagnostic[] {
  const diagnostics: LibraryFileDiagnostic[] = [];
  for (const purpose of ["goal_design", "composer_guidance"] as const) {
    const matches = records.filter((record) => record.objectKind === "skill_spec" && record.definition.purpose === purpose);
    if (matches.length !== 1) {
      diagnostics.push({
        code: "required_purpose_cardinality",
        message: `expected exactly one approved ${purpose} skill, found ${matches.length}`,
        fatal: true,
        paths: matches.map((item) => item.path),
        missingRefs: [],
      });
      continue;
    }
    if (!matches[0]!.body.trim()) diagnostics.push({
      code: "required_purpose_content",
      message: `${purpose} skill must contain a non-empty instruction body`,
      fatal: true,
      paths: [matches[0]!.path],
      objectKey: matches[0]!.objectKey,
      missingRefs: [],
    });
  }
  return diagnostics;
}
```

Remove unused imports until `tsc` and ESLint-equivalent checks are clean; `createHash` and `LibraryDefinitionKind` are used by Task 2 and may be introduced there instead of this commit.

- [ ] **Step 6: Run the focused tests**

Run: `npx tsx --test tests/v2/library-reconcile-service.test.ts`

Expected: PASS for all four tests.

- [ ] **Step 7: Commit the pure catalog and closure boundary**

```bash
git add src/v2/design-library/files/library-file-parser.ts src/v2/design-library/files/library-file-types.ts src/v2/design-library/files/library-file-store.ts src/v2/design-library/files/library-reconcile-service.ts tests/v2/library-reconcile-service.test.ts
git commit -m "feat: resolve closed approved library catalog"
```

### Task 2: Atomic Graph Reconcile, Deprecation, Snapshot, And Readiness

**Files:**

- Modify: `src/v2/design-library/files/library-reconcile-service.ts`
- Modify: `src/v2/design-library/files/library-file-store.ts`
- Modify: `src/v2/design-library/library-graph-store.ts`
- Test: `tests/v2/library-reconcile-postgres.test.ts`
- Modify: `tests/v2/index.test.ts`

**Interfaces:**

- Consumes: Task 1 `LibraryFileCatalog`, `ClosedApprovedLibraryFileSet`, `loadLibraryFileCatalog`, `resolveClosedApprovedLibraryFileSet`, `validateRequiredLibraryPurposes`, and existing `upsertRuntimeResourcePg`/`getResourceByKeyPg`.
- Produces: `syncLibraryFileRecordsToGraphPg(db: SouthstarDb, input: LibraryGraphSyncInput): Promise<LibraryGraphSyncResult>`, `reconcileLibraryFilesPg(db: SouthstarDb, input: { root: string; trigger: LibraryReconcileTrigger }): Promise<LibraryReconcileResult>`, `loadLibraryReadinessPg(db: SouthstarDb): Promise<LibraryReadiness | null>`, and `requireLibraryReadinessPg(db: SouthstarDb): Promise<LibraryReadiness>`.

- [ ] **Step 1: Write failing Postgres tests for atomic sync, idempotency, closure exclusion, and removal deprecation**

Create `tests/v2/library-reconcile-postgres.test.ts` using the repository's existing `withPostgresTestDb`/schema helper. The core assertions must be:

```ts
test("reconcile publishes a closed approved snapshot and is idempotent", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createLibraryRoot({
      "skills/goal.skill.md": approvedSkill("skill.goal-any", "goal_design"),
      "skills/composer.skill.md": approvedSkill("skill.composer-any", "composer_guidance"),
      "skills/excluded.skill.md": approvedSkill("skill.excluded", "worker", ["tool.missing"]),
    });
    const first = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    const historyAfterFirst = Number((await db.one<{ count: string }>("select count(*)::text as count from southstar.library_history")).count);
    const second = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    const historyAfterSecond = Number((await db.one<{ count: string }>("select count(*)::text as count from southstar.library_history")).count);
    assert.equal(first.status, "ready_with_warnings");
    assert.equal(first.snapshotHash, second.snapshotHash);
    assert.deepEqual(first.included.map((item) => item.objectKey).sort(), ["skill.composer-any", "skill.goal-any"]);
    assert.equal(first.excluded[0]?.objectKey, "skill.excluded");
    assert.equal((await findLibraryObjectByKey(db, "skill.excluded"))?.status, "blocked");
    assert.equal((await loadLibraryReadinessPg(db))?.ready, true);
    assert.equal((await listLibraryEdges(db)).filter((edge) => edge.status === "active").length, 0);
    assert.equal(historyAfterSecond, historyAfterFirst);
  });
});

test("reconcile rolls back graph and readiness when approved content is invalid", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot();
    const before = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    await writeFile(join(root, "skills", "bad.skill.md"), invalidApprovedSkill("skill.bad"));
    await assert.rejects(
      reconcileLibraryFilesPg(db, { root, trigger: "startup"),
      (error: unknown) => error instanceof LibraryReconcileError && error.diagnostics.some((item) => item.code === "parse_invalid"),
    );
    assert.equal((await loadLibraryReadinessPg(db))?.snapshotHash, before.snapshotHash);
    assert.equal(await findLibraryObjectByKey(db, "skill.bad"), null);
  });
});

test("removed file-backed object is deprecated while unrelated graph object is untouched", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot({ extraSkill: "skill.removed" });
    await createLibraryObject(db, unrelatedGeneratedObject("profile.runtime-generated"));
    await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    await rm(join(root, "skills", "extra.skill.md"));
    const result = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    assert.deepEqual(result.deprecatedObjectKeys, ["skill.removed"]);
    assert.equal((await findLibraryObjectByKey(db, "skill.removed"))?.status, "deprecated");
    assert.equal((await findLibraryEdgesFrom(db, "skill.removed", { status: "inactive" })).length, 1);
    assert.equal((await findLibraryObjectByKey(db, "profile.runtime-generated"))?.status, "approved");
  });
});

test("content changes create a new object version and snapshot without mutating a frozen run", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot();
    const first = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    const originalRef = first.included.find((item) => item.objectKey === "skill.goal-any")!.versionRef;
    const run = await createWorkflowRunPg(db, frozenRunInput({ libraryVersionRefs: [originalRef] }));
    await writeFile(join(root, "skills", "goal.skill.md"), approvedSkill("skill.goal-any", "goal_design", [], "Changed body"));
    const second = await reconcileLibraryFilesPg(db, { root, trigger: "library_save" });
    assert.notEqual(second.snapshotHash, first.snapshotHash);
    assert.notEqual(second.included.find((item) => item.objectKey === "skill.goal-any")!.versionRef, originalRef);
    assert.deepEqual(JSON.parse((await getWorkflowRunPg(db, run.id))!.snapshotJson).libraryVersionRefs, [originalRef]);
  });
});

test("concurrent reconciles serialize on the advisory transaction lock", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot();
    const [left, right] = await Promise.all([
      reconcileLibraryFilesPg(db, { root, trigger: "startup" }),
      reconcileLibraryFilesPg(db, { root, trigger: "startup" }),
    ]);
    assert.equal(left.snapshotHash, right.snapshotHash);
    const active = await listLibraryEdges(db, { status: "active" });
    assert.equal(new Set(active.map((edge) => edge.id)).size, active.length);
  });
});

async function withPostgresTestDb(run: (db: Awaited<ReturnType<typeof createTestPostgresDb>>) => Promise<void>) {
  const db = await createTestPostgresDb();
  try { await run(db); } finally { await db.close(); }
}

function approvedSkill(
  id: string,
  purpose: string,
  requiresToolRefs: string[] = [],
  body = "Use these reviewed instructions.",
): string {
  const refs = requiresToolRefs.length === 0
    ? "requiresToolRefs: []\n"
    : `requiresToolRefs:\n${requiresToolRefs.map((ref) => `  - ${ref}`).join("\n")}\n`;
  return `---\nschemaVersion: southstar.library.skill_spec_file.v1\nid: ${id}\ntitle: ${id}\nscope: global\nstatus: approved\npurpose: ${purpose}\n${refs}---\n${body}\n`;
}

function invalidApprovedSkill(id: string): string {
  return `---\nschemaVersion: wrong\nid: ${id}\ntitle: ${id}\nscope: global\nstatus: approved\n---\nbody\n`;
}

async function createLibraryRoot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-reconcile-"));
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), content);
  }
  return root;
}

async function createMinimalReadyLibraryRoot(input: { extraSkill?: string } = {}): Promise<string> {
  return createLibraryRoot({
    "skills/goal.skill.md": approvedSkill("skill.goal-any", "goal_design"),
    "skills/composer.skill.md": approvedSkill("skill.composer-any", "composer_guidance"),
    ...(input.extraSkill ? {
      "skills/extra.skill.md": approvedSkill(input.extraSkill, "worker", ["tool.extra"]),
      "tools/extra.tool.yaml": "schemaVersion: southstar.library.tool_definition_file.v1\nid: tool.extra\ntitle: Extra Tool\nscope: global\nstatus: approved\n",
    } : {}),
  });
}

function unrelatedGeneratedObject(objectKey: string): UpsertLibraryObjectInput {
  return {
    objectKey,
    objectKind: "agent_profile",
    status: "approved",
    headVersionId: `${objectKey}@runtime`,
    state: { scope: "global", source: "runtime-generated" },
  };
}

function frozenRunInput(snapshot: Record<string, unknown>): WorkflowRunInput {
  return {
    id: `run-${randomUUID()}`,
    status: "planned",
    domain: "test",
    goalPrompt: "preserve captured Library refs",
    workflowManifestJson: JSON.stringify({}),
    executionProjectionJson: JSON.stringify({}),
    snapshotJson: JSON.stringify(snapshot),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  };
}
```

Use these additional imports at the top of the test:

```ts
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { WorkflowRunInput } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createWorkflowRunPg, getWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import type { UpsertLibraryObjectInput } from "../../src/v2/design-library/library-graph-store.ts";
import {
  createLibraryObject,
  findLibraryEdgesFrom,
  findLibraryObjectByKey,
  listLibraryEdges,
} from "../../src/v2/design-library/library-graph-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
```

Use helper bodies that emit real supported Library file schemas. Do not insert graph fixtures for file-backed objects.

- [ ] **Step 2: Run the Postgres test and confirm reconcile persistence is absent**

Run: `npx tsx --test tests/v2/library-reconcile-postgres.test.ts`

Expected: FAIL because `reconcileLibraryFilesPg`, `LibraryReconcileError`, and readiness APIs are not exported.

- [ ] **Step 3: Add narrow graph-store helpers for file provenance and edge lifecycle**

In `library-graph-store.ts`, add functions using existing row mappers:

```ts
export async function listFileBackedLibraryObjectsForUpdate(db: SouthstarDb) {
  const result = await db.query<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
     from southstar.library_objects
     where state_json->>'sourcePath' like 'library/%'
     order by object_key
     for update`,
  );
  return result.rows.map(mapObject);
}

export async function deactivateOutgoingLibraryEdges(db: SouthstarDb, objectKey: string): Promise<number> {
  const result = await db.query(
    `update southstar.library_edges
        set status = 'inactive'
      where from_object_key = $1 and status = 'active'`,
    [objectKey],
  );
  return result.rowCount ?? 0;
}

export async function appendLibraryHistoryEvent(db: SouthstarDb, input: {
  objectId: string;
  eventType: "file_reconciled" | "file_deprecated";
  payload: Record<string, unknown>;
}): Promise<void> {
  const next = await db.one<{ sequence: number }>(
    `select coalesce(max(sequence), 0) + 1 as sequence
       from southstar.library_history
      where object_id = $1`,
    [input.objectId],
  );
  const id = `libhist-${createHash("sha256")
    .update(`${input.objectId}|${next.sequence}|${input.eventType}`)
    .digest("hex").slice(0, 20)}`;
  await db.query(
    `insert into southstar.library_history (
       id, object_id, sequence, event_type, actor_type, payload_json
     ) values ($1, $2, $3, $4, 'library_reconcile', $5::jsonb)`,
    [id, input.objectId, next.sequence, input.eventType, JSON.stringify(input.payload)],
  );
}
```

Use the module's existing `createHash` import and private `mapObject` mapper; do not add a second row-to-domain conversion.

- [ ] **Step 4: Replace placeholder-producing batch sync with object-first, edge-second synchronization**

In `library-file-store.ts`, implement and export:

```ts
export type LibraryGraphSyncInput = {
  executable: LibraryFileRecord[];
  nonExecutable: Array<{ file: LibraryFileRecord; status: "draft" | "deprecated" | "blocked"; reason?: string }>;
};

export type LibraryGraphSyncResult = {
  objects: LibraryObjectSummary[];
  edges: LibraryEdgeRecord[];
  results: Array<{ object: LibraryObjectSummary; edges: LibraryEdgeRecord[] }>;
};

export async function syncLibraryFileRecordsToGraphPg(
  db: SouthstarDb,
  input: LibraryGraphSyncInput,
): Promise<LibraryGraphSyncResult> {
  const all = [
    ...input.executable.map((file) => ({ file, forcedStatus: "approved" as const })),
    ...input.nonExecutable.map(({ file, status }) => ({ file, forcedStatus: status })),
  ];
  const projections = all.map(({ file, forcedStatus }) => {
    validateLibraryFileGraphReferences(file);
    const projection = projectLibraryFileToGraph(file);
    return {
      file,
      projection: {
        ...projection,
        object: {
          ...projection.object,
          status: forcedStatus,
          state: { ...projection.object.state, status: forcedStatus, declaredStatus: file.status },
        },
      },
    };
  });
  const available = new Set(projections.map(({ projection }) => projection.object.objectKey));
  for (const { projection } of projections) {
    for (const edge of projection.edges) {
      if (!available.has(edge.toObjectKey)) throw new Error(`unresolved Library reference ${edge.toObjectKey} from ${projection.object.objectKey}`);
    }
  }
  const objects = [];
  for (const { projection } of projections) objects.push(await upsertLibraryObject(db, projection.object));
  const edges = [];
  for (const { file, projection } of projections) {
    const activeEdges = projection.object.status === "approved" ? projection.edges : [];
    await deactivateLibraryEdgesForSourceExcept(db, {
      fromObjectKey: projection.object.objectKey,
      sourcePath: file.path,
      keepEdges: activeEdges,
    });
    for (const edge of activeEdges) edges.push(await upsertLibraryEdge(db, { ...edge, status: "active", weight: 1 }));
  }
  return {
    objects,
    edges,
    results: projections.map(({ projection }) => ({
      object: objects.find((object) => object.objectKey === projection.object.objectKey)!,
      edges: edges.filter((edge) => edge.fromObjectKey === projection.object.objectKey),
    })),
  };
}
```

Delete calls to `ensureReferencedObject` from production file-sync paths. Retain canonical domain behavior only if the canonical domain exists as a parsed Library file; the reconcile algorithm must not synthesize it.

- [ ] **Step 5: Implement canonical snapshot hashing and typed readiness resources**

In `library-reconcile-service.ts`, add:

```ts
export type LibraryReconcileTrigger = "startup" | "library_save" | "import_approval";

export type LibraryReconcileResult = {
  schemaVersion: "southstar.library_sync_snapshot.v1";
  snapshotHash: string;
  status: "ready" | "ready_with_warnings";
  sourceRoot: string;
  trigger: LibraryReconcileTrigger;
  included: Array<{ path: string; objectKey: string; objectKind: LibraryDefinitionKind; sourceHash: string; versionRef: string }>;
  excluded: Array<{ path: string; objectKey?: string; reason: string; missingRefs: string[] }>;
  deprecatedObjectKeys: string[];
  warnings: string[];
};

export type LibraryReadiness = {
  schemaVersion: "southstar.library_readiness.v1";
  ready: true;
  status: "ready" | "ready_with_warnings";
  snapshotHash: string;
  sourceRoot: string;
  reconciledAt: string;
  trigger: LibraryReconcileTrigger;
  includedCount: number;
  excludedCount: number;
  diagnostics: LibraryFileDiagnostic[];
};

export class LibraryReconcileError extends Error {
  readonly code = "library_reconcile_failed";
  constructor(readonly diagnostics: LibraryFileDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; "));
  }
}

export class LibraryNotReadyError extends Error {
  readonly code = "library_not_ready";
  readonly status = 503;
  constructor(readonly diagnostics: LibraryFileDiagnostic[], message = "Library reconciliation has not produced a ready snapshot") {
    super(message);
  }
}

function snapshotHash(records: LibraryFileRecord[]): string {
  const canonical = records
    .map((record) => ({
      path: record.path,
      objectKey: record.objectKey,
      objectKind: record.objectKind,
      status: record.status,
      sourceHash: record.sourceHash,
      refs: libraryFileReferences(record),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function loadLibraryReadinessPg(db: SouthstarDb): Promise<LibraryReadiness | null> {
  const resource = await getResourceByKeyPg(db, "library_readiness", "library-readiness:current");
  return resource ? resource.payload as LibraryReadiness : null;
}

export async function requireLibraryReadinessPg(db: SouthstarDb): Promise<LibraryReadiness> {
  const readiness = await loadLibraryReadinessPg(db);
  if (!readiness?.ready) throw new LibraryNotReadyError([]);
  return readiness;
}
```

- [ ] **Step 6: Implement one advisory-locked transaction for the complete reconciliation**

Implement `reconcileLibraryFilesPg` so discovery happens before the transaction and every write happens inside it:

```ts
export async function reconcileLibraryFilesPg(
  db: SouthstarDb,
  input: { root: string; trigger: LibraryReconcileTrigger },
): Promise<LibraryReconcileResult> {
  const catalog = await loadLibraryFileCatalog({ root: input.root });
  const closed = resolveClosedApprovedLibraryFileSet(catalog.records);
  const purposeDiagnostics = validateRequiredLibraryPurposes(closed.included);
  const fatal = [...catalog.diagnostics, ...closed.diagnostics, ...purposeDiagnostics].filter((item) => item.fatal);
  if (fatal.length > 0) throw new LibraryReconcileError(fatal);
  const hash = snapshotHash(catalog.records);

  return db.tx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", ["southstar.library.reconcile.v1"]);
    const existing = await listFileBackedLibraryObjectsForUpdate(tx);
    const existingByKey = new Map(existing.map((item) => [item.objectKey, item]));
    const effectiveExecutable = closed.included.filter((file) => {
      const current = existingByKey.get(file.objectKey);
      const versionRef = `${file.objectKey}@${file.sourceHash.slice(0, 12)}`;
      return !(current?.headVersionId === versionRef && (current.status === "blocked" || current.status === "deprecated"));
    });
    const effectivePurposeDiagnostics = validateRequiredLibraryPurposes(effectiveExecutable);
    if (effectivePurposeDiagnostics.length > 0) throw new LibraryReconcileError(effectivePurposeDiagnostics);
    const includedKeys = new Set(effectiveExecutable.map((item) => item.objectKey));
    const excludedKeys = new Set(closed.excluded.map((item) => item.objectKey));
    const nonExecutableStatus = (file: LibraryFileRecord): "draft" | "deprecated" | "blocked" => {
      const current = existingByKey.get(file.objectKey);
      const versionRef = `${file.objectKey}@${file.sourceHash.slice(0, 12)}`;
      if (current?.headVersionId === versionRef && (current.status === "blocked" || current.status === "deprecated")) {
        return current.status;
      }
      if (excludedKeys.has(file.objectKey)) return "blocked";
      if (file.status === "deprecated" || file.status === "blocked") return file.status;
      return "draft";
    };
    const nonExecutable = catalog.records
      .filter((file) => !includedKeys.has(file.objectKey))
      .map((file) => ({
        file,
        status: nonExecutableStatus(file),
        reason: excludedKeys.has(file.objectKey) ? "reference closure incomplete" : undefined,
      }));
    const synced = await syncLibraryFileRecordsToGraphPg(tx, { executable: effectiveExecutable, nonExecutable });

    const presentKeys = new Set(catalog.records.map((item) => item.objectKey));
    const deprecatedObjectKeys: string[] = [];
    for (const object of existing) {
      if (presentKeys.has(object.objectKey)) continue;
      await updateLibraryObjectStatus(tx, { objectKey: object.objectKey, status: "deprecated" });
      await deactivateOutgoingLibraryEdges(tx, object.objectKey);
      await appendLibraryHistoryEvent(tx, {
        objectId: object.id,
        eventType: "file_deprecated",
        payload: { objectKey: object.objectKey, snapshotHash: hash, trigger: input.trigger },
      });
      deprecatedObjectKeys.push(object.objectKey);
    }

    for (const object of synced.objects) {
      const before = existing.find((item) => item.objectKey === object.objectKey);
      if (before?.headVersionId === object.headVersionId && before.status === object.status) continue;
      await appendLibraryHistoryEvent(tx, {
        objectId: object.id,
        eventType: "file_reconciled",
        payload: {
          objectKey: object.objectKey,
          previousVersionRef: before?.headVersionId ?? null,
          versionRef: object.headVersionId,
          status: object.status,
          snapshotHash: hash,
          trigger: input.trigger,
        },
      });
    }

    const diagnostics = [...catalog.diagnostics, ...closed.excluded];
    const result: LibraryReconcileResult = {
      schemaVersion: "southstar.library_sync_snapshot.v1",
      snapshotHash: hash,
      status: diagnostics.length > 0 ? "ready_with_warnings" : "ready",
      sourceRoot: input.root,
      trigger: input.trigger,
      included: effectiveExecutable.map((file) => ({
        path: file.path,
        objectKey: file.objectKey,
        objectKind: file.objectKind,
        sourceHash: file.sourceHash,
        versionRef: `${file.objectKey}@${file.sourceHash.slice(0, 12)}`,
      })),
      excluded: diagnostics.map((item) => ({
        path: item.paths[0] ?? "",
        objectKey: item.objectKey,
        reason: item.message,
        missingRefs: item.missingRefs,
      })),
      deprecatedObjectKeys: deprecatedObjectKeys.sort(),
      warnings: diagnostics.map((item) => item.message),
    };
    const reconciledAt = new Date().toISOString();
    const readiness: LibraryReadiness = {
      schemaVersion: "southstar.library_readiness.v1",
      ready: true,
      status: result.status,
      snapshotHash: hash,
      sourceRoot: input.root,
      reconciledAt,
      trigger: input.trigger,
      includedCount: result.included.length,
      excludedCount: result.excluded.length,
      diagnostics,
    };
    await upsertRuntimeResourcePg(tx, {
      resourceType: "library_sync_snapshot",
      resourceKey: `library-sync:${hash}`,
      scope: "runtime",
      status: result.status,
      title: `Library sync ${hash.slice(0, 12)}`,
      payload: result,
      summary: result.status,
      metrics: { included: result.included.length, excluded: result.excluded.length },
    });
    await upsertRuntimeResourcePg(tx, {
      resourceType: "library_readiness",
      resourceKey: "library-readiness:current",
      scope: "runtime",
      status: result.status,
      title: "Current Library readiness",
      payload: readiness,
      summary: result.status,
      metrics: { included: result.included.length, excluded: result.excluded.length },
    });
    return result;
  });
}
```

`RuntimeResourceInput.status` and `scope` are strings in `postgres-runtime-store.ts`; use `scope: "runtime"` and the reconcile status values shown above.

- [ ] **Step 7: Run focused Postgres and existing Library file-store tests**

Run:

```bash
npx tsx --test tests/v2/library-reconcile-service.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-file-store.test.ts
```

Expected: PASS; no `@placeholder` object is written.

- [ ] **Step 8: Register the new test in the v2 suite and commit**

Add `import "./library-reconcile-postgres.test.ts";` beside other design-library tests in `tests/v2/index.test.ts`, then run `npm run test:v2` and expect PASS.

```bash
git add src/v2/design-library/files/library-reconcile-service.ts src/v2/design-library/files/library-file-store.ts src/v2/design-library/library-graph-store.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/index.test.ts
git commit -m "feat: reconcile library graph atomically"
```

### Task 3: Runtime Startup, Health, And Goal Readiness Guard

**Files:**

- Modify: `src/v2/server/runtime-server-lifecycle.ts`
- Modify: `src/v2/server/planner-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/runtime-server-lifecycle.test.ts`
- Test: `tests/v2/run-goal-service.test.ts`
- Test: `tests/v2/routes.test.ts`

**Interfaces:**

- Consumes: Task 2 `reconcileLibraryFilesPg`, `loadLibraryReadinessPg`, `requireLibraryReadinessPg`, `LibraryNotReadyError`.
- Produces: `prepareRuntimeLibraryPg(db: SouthstarDb, input: { libraryRoot: string }): Promise<LibraryReconcileResult>` as the reusable production startup seam used by managed lifecycle and the real E2E harness.
- Produces: `RuntimeServerStatusResult` variant `{ status: "library_not_ready"; pidFilePath: string; failureFilePath: string; failure: RuntimeServerStartupFailureRecord }`.

- [ ] **Step 1: Write a failing lifecycle ordering test**

In `runtime-server-lifecycle.test.ts`, inject observable operations into the lifecycle factory and assert reconcile finishes before runtime creation/listen:

```ts
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import type {
  LibraryFileDiagnostic,
  LibraryReconcileResult,
} from "../../src/v2/design-library/files/library-reconcile-service.ts";

const fatalDiagnostic: LibraryFileDiagnostic = {
  code: "required_purpose_cardinality",
  message: "expected exactly one approved goal_design skill, found 0",
  fatal: true,
  paths: [],
  missingRefs: [],
};

function readyReconcileResult(): LibraryReconcileResult {
  return {
    schemaVersion: "southstar.library_sync_snapshot.v1",
    snapshotHash: "abc123",
    status: "ready",
    sourceRoot: "/workspace/southstar/library",
    trigger: "startup",
    included: [],
    excluded: [],
    deprecatedObjectKeys: [],
    warnings: [],
  };
}

test("serve reconciles Library before creating the runtime server", async () => {
  const calls: string[] = [];
  const testDb = { close: async () => {} } as SouthstarDb;
  const testRuntimeHandle = { server: { host: "127.0.0.1", port: 3100, close: async () => {} } };
  const lifecycle = createRuntimeServerLifecycle({
    connectDb: async () => testDb,
    prepareRuntimeLibrary: async (_db, input) => {
      calls.push(`reconcile:${input.libraryRoot}`);
      return readyReconcileResult();
    },
    createRuntime: async () => {
      calls.push("listen");
      return testRuntimeHandle;
    },
    waitForShutdownSignal: async () => "SIGTERM",
    writeTextFile: async () => {},
    removeFile: async () => {},
    envLoader: () => localEnv({ dockerRequired: false }),
    cwd: "/workspace/southstar",
  });
  await lifecycle.serve({ host: "127.0.0.1", port: 3100 });
  assert.deepEqual(calls, ["reconcile:/workspace/southstar/library", "listen"]);
});

test("serve does not listen or write a ready pid record when Library reconcile fails", async () => {
  let listened = false;
  const writes: string[] = [];
  const testDb = { close: async () => {} } as SouthstarDb;
  const testRuntimeHandle = { server: { host: "127.0.0.1", port: 3100, close: async () => {} } };
  const lifecycle = createRuntimeServerLifecycle({
    connectDb: async () => testDb,
    prepareRuntimeLibrary: async () => { throw new LibraryReconcileError([fatalDiagnostic]); },
    createRuntime: async () => { listened = true; return testRuntimeHandle; },
    writeTextFile: async (path) => { writes.push(path); },
    removeFile: async () => {},
    envLoader: () => localEnv({ dockerRequired: false }),
    cwd: "/workspace/southstar",
  });
  await assert.rejects(lifecycle.serve({ host: "127.0.0.1", port: 3100 }), /Library/);
  assert.equal(listened, false);
  assert.equal(writes.some((path) => path.endsWith("runtime-server.pid")), false);
  assert.equal(writes.some((path) => path.endsWith("runtime-server-start.failure.json")), true);
});

test("status reports a persisted Library reconcile startup failure", async () => {
  const lifecycle = createRuntimeServerLifecycle({
    cwd: "/workspace/southstar",
    readTextFile: async (path) => {
      if (path.endsWith("runtime-server-start.failure.json")) return JSON.stringify({
        schemaVersion: "southstar.runtime_start_failure.v1",
        code: "library_not_ready",
        message: "expected exactly one approved goal_design skill, found 0",
        diagnostics: [fatalDiagnostic],
        failedAt: "2026-07-13T00:00:00.000Z",
      });
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  const status = await lifecycle.status();
  assert.equal(status.status, "library_not_ready");
  if (status.status === "library_not_ready") assert.equal(status.failure.code, "library_not_ready");
});
```

Use the lifecycle's actual injection names and PID test helper; preserve existing lifecycle behavior.

- [ ] **Step 2: Write failing API tests for JSON/SSE 503 before submission claim and health readiness**

Add route tests that do not create a readiness resource:

```ts
for (const accept of ["application/json", "text/event-stream"]) {
  test(`run-goal returns structured 503 before claim for ${accept}`, async () => {
    const response = await requestRuntime("/api/v2/run-goal", {
      method: "POST",
      headers: { accept, "content-type": "application/json" },
      body: JSON.stringify({ goal: "Build a vocabulary app", projectCwd: "/tmp/project" }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "library_not_ready",
      message: "Library reconciliation has not produced a ready snapshot",
      diagnostics: [],
    });
    assert.equal(await countGoalSubmissionClaims(db), 0);
  });
}

test("runtime health exposes current Library readiness", async () => {
  await persistReadyLibraryResource(db, { snapshotHash: "abc123" });
  const response = await requestRuntime("/api/v2/runtime/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).library.snapshotHash, "abc123");
});
```

Update shared route-test DB setup to persist a ready `library_readiness` resource for tests unrelated to readiness. Do not add an application bypass flag.

- [ ] **Step 3: Run the lifecycle and route tests to verify failure**

Run:

```bash
npx tsx --test tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
```

Expected: FAIL because startup does not reconcile and `/run-goal` does not guard readiness.

- [ ] **Step 4: Add the production startup preparation seam and call it before listen**

In `runtime-server-lifecycle.ts`, add:

```ts
export async function prepareRuntimeLibraryPg(
  db: SouthstarDb,
  input: { libraryRoot: string },
): Promise<LibraryReconcileResult> {
  return reconcileLibraryFilesPg(db, { root: input.libraryRoot, trigger: "startup" });
}
```

Extend `RuntimeServerLifecycleInput` with deterministic test seams and startup failure state:

```ts
export type RuntimeServerStartupFailureRecord = {
  schemaVersion: "southstar.runtime_start_failure.v1";
  code: "library_not_ready";
  message: string;
  diagnostics: LibraryFileDiagnostic[];
  failedAt: string;
};

type RuntimeServerLifecycleInput = {
  // keep all existing members
  libraryRoot?: string;
  connectDb?: (databaseUrl: string) => Promise<SouthstarDb>;
  prepareRuntimeLibrary?: typeof prepareRuntimeLibraryPg;
  createRuntime?: (
    host: string,
    port: number,
    env: SouthstarEnv,
    db: SouthstarDb,
    input: { callbackBaseUrl: string; libraryRoot: string },
  ) => Promise<{ server: Pick<SouthstarRuntimeServer, "host" | "port" | "close"> }>;
  waitForShutdownSignal?: () => Promise<"SIGINT" | "SIGTERM">;
};

export type RuntimeServerStatusResult =
  | { status: "running"; pidFilePath: string; record: RuntimeServerPidRecord }
  | { status: "stopped"; pidFilePath: string; staleRecord?: RuntimeServerPidRecord }
  | {
      status: "library_not_ready";
      pidFilePath: string;
      failureFilePath: string;
      failure: RuntimeServerStartupFailureRecord;
    };
```

Resolve the Library root once from lifecycle configuration:

```ts
const libraryRoot = resolve(
  input.cwd ?? process.cwd(),
  input.libraryRoot ?? process.env.SOUTHSTAR_LIBRARY_ROOT ?? "library",
);
const db = input.connectDb
  ? await input.connectDb(env.databaseUrl)
  : await connectSouthstarDbWithRetry(env.databaseUrl, { sleep });
await (input.prepareRuntimeLibrary ?? prepareRuntimeLibraryPg)(db, { libraryRoot });
const runtime = await (input.createRuntime ?? createRuntime)(host, port, env, db, {
  callbackBaseUrl,
  libraryRoot,
});
signal = await (input.waitForShutdownSignal ?? waitForShutdownSignal)();
```

Thread the same absolute `libraryRoot` into `RuntimeServerContext`; do not let routes derive a second root.

Persist and surface only the classified startup failure:

```ts
import { dirname, resolve } from "node:path";

const failureFilePath = resolve(dirname(pidFilePath), "runtime-server-start.failure.json");

// At the start of serve, before reconcile:
await removeFile(failureFilePath).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
});

// In serve's catch block, before closing the database:
if (error instanceof LibraryReconcileError) {
  await writeTextFile(failureFilePath, JSON.stringify({
    schemaVersion: "southstar.runtime_start_failure.v1",
    code: "library_not_ready",
    message: error.message,
    diagnostics: error.diagnostics,
    failedAt: now().toISOString(),
  } satisfies RuntimeServerStartupFailureRecord, null, 2));
}

// In status(), when there is no live PID record:
const failure = await readStartupFailure(failureFilePath);
if (failure) return { status: "library_not_ready", pidFilePath, failureFilePath, failure };
```

Make `waitForPidRecord` check the failure file on every poll and immediately throw `Southstar runtime Library is not ready: ${failure.message}` instead of waiting 90 seconds. A successful startup removes the stale failure file before writing the PID record.

- [ ] **Step 5: Guard `/run-goal` before idempotency claim and return stable structured errors**

At the start of the `/api/v2/run-goal` branch in `planner-routes.ts`, before `claimGoalSubmissionPg`, add:

```ts
try {
  await requireLibraryReadinessPg(context.db);
} catch (error: unknown) {
  if (!(error instanceof LibraryNotReadyError)) throw error;
  return new Response(JSON.stringify({
    ok: false,
    error: error.code,
    message: error.message,
    diagnostics: error.diagnostics,
  }), {
    status: error.status,
    headers: { "content-type": "application/json", ...corsHeaders() },
  });
}
```

This response occurs before choosing JSON versus SSE generation so both clients receive a normal HTTP 503 JSON response.

- [ ] **Step 6: Add Library readiness to runtime health**

In the `/api/v2/runtime/health` handler in `routes.ts`, load readiness and add a `library` field:

```ts
const library = await loadLibraryReadinessPg(context.db);
return json("runtime-health", {
  database,
  managedRuntime,
  torkObservation,
  loops,
  library: library ? {
    ready: true,
    status: library.status,
    snapshotHash: library.snapshotHash,
    includedCount: library.includedCount,
    excludedCount: library.excludedCount,
    diagnostics: library.diagnostics,
  } : {
    ready: false,
    status: "not_ready",
    snapshotHash: null,
    includedCount: 0,
    excludedCount: 0,
    diagnostics: [],
  },
}, database.ok && library?.ready ? 200 : 503);
```

- [ ] **Step 7: Run focused tests and commit runtime readiness**

Run:

```bash
npx tsx --test tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
```

Expected: PASS, including no submission claim for the 503 path.

```bash
git add src/v2/server/runtime-server-lifecycle.ts src/v2/server/planner-routes.ts src/v2/server/routes.ts tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts
git commit -m "feat: require library readiness before goals"
```

### Task 4: Unify Library Save & Sync And Import Approval

**Files:**

- Modify: `src/v2/server/library-routes.ts`
- Modify: `src/v2/design-library/importers/library-import-draft-store.ts`
- Modify: `src/v2/design-library/files/library-file-store.ts`
- Modify: `web/lib/library/types.ts`
- Modify: `web/lib/library/api.ts`
- Create: `web/components/library/LibraryReadinessBanner.tsx`
- Modify: `web/components/library/LibraryWorkspace.tsx`
- Test: `tests/v2/library-chat-routes.test.ts`
- Test: `tests/v2/library-import-drafts.test.ts`
- Test: `tests/web/southstar-library-workspace-interaction.test.tsx`

**Interfaces:**

- Consumes: Task 2 `reconcileLibraryFilesPg` and transaction-level `syncLibraryFileRecordsToGraphPg`.
- Produces: Library sync response `{ file, reconcile }`, where `reconcile` is `LibraryReconcileResult`; import approval returns its existing result plus `librarySnapshotHash`.
- Produces: `GET /api/v2/library/readiness`, browser `readLibraryReadiness()`, and an in-layout readiness banner in the existing Library workspace.

- [ ] **Step 1: Write failing route test proving Save & Sync refreshes the complete snapshot**

In `library-chat-routes.test.ts`, save a second required-purpose file before syncing the first, then assert the sync response includes both:

```ts
test("Library file sync reconciles the complete root and publishes readiness", async () => {
  await writeLibraryFile({ root, relativePath: "skills/goal.skill.md", content: approvedGoalSkill });
  await writeLibraryFile({ root, relativePath: "skills/composer.skill.md", content: approvedComposerSkill });
  const response = await requestRuntime("/api/v2/library/files/skills%2Fgoal.skill.md/sync", { method: "POST" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.file.relativePath, "skills/goal.skill.md");
  assert.deepEqual(body.reconcile.included.map((item: { objectKey: string }) => item.objectKey).sort(), [
    "skill.test-composer",
    "skill.test-goal",
  ]);
  assert.equal((await loadLibraryReadinessPg(db))?.snapshotHash, body.reconcile.snapshotHash);
});
```

- [ ] **Step 2: Write failing import test proving approved files use the same closed-set transaction**

In `library-import-drafts.test.ts`, approve a draft containing a skill with an absent tool ref and assert:

```ts
test("import approval cannot publish an unclosed approved object", async () => {
  const draft = await createImportDraftWithFile({
    relativePath: "skills/imported.skill.md",
    content: approvedWorkerSkill({ id: "skill.imported", requiresToolRefs: ["tool.absent"] }),
  });
  const result = await approveLibraryImportDraft(db, { root, draftId: draft.id });
  assert.equal(result.reconcile.status, "ready_with_warnings");
  assert.equal(result.reconcile.excluded.find((item) => item.objectKey === "skill.imported")?.missingRefs[0], "tool.absent");
  assert.equal((await findLibraryObjectByKey(db, "skill.imported"))?.status, "blocked");
});
```

The test root must contain valid approved `goal_design` and `composer_guidance` skills so the incomplete imported worker is a warning, not a core readiness failure.

- [ ] **Step 3: Run route/import tests and verify old single-file semantics fail**

Run:

```bash
npx tsx --test tests/v2/library-chat-routes.test.ts tests/v2/library-import-drafts.test.ts
```

Expected: FAIL because sync returns only one graph result and import does not return a reconcile snapshot.

- [ ] **Step 4: Route Library sync through the full reconcile service**

Replace the single-file graph call in `library-routes.ts` with:

```ts
const root = libraryRoot(context);
const file = await readLibraryFile({ root, relativePath });
if (!file.parsed.ok) return new Response(JSON.stringify({ ok: false, error: "library_file_invalid", issues: file.parsed.issues }), {
  status: 422,
  headers: { "content-type": "application/json" },
});
let reconcile: LibraryReconcileResult;
try {
  reconcile = await reconcileLibraryFilesPg(context.db, { root, trigger: "library_save" });
} catch (error: unknown) {
  if (!(error instanceof LibraryReconcileError)) throw error;
  return new Response(JSON.stringify({ ok: false, error: error.code, diagnostics: error.diagnostics }), {
    status: 422,
    headers: { "content-type": "application/json" },
  });
}
return json("library-file-sync", { file: { relativePath, parsed: file.parsed }, reconcile });
```

Leave unexpected DB errors as 500 through the existing route error boundary.

- [ ] **Step 5: Make import approval use the shared projection core and publish readiness**

Refactor `approveLibraryImportDraft` so it has one filesystem preflight and one DB transaction:

```ts
const installedFiles = await installApprovedImportFiles(input);
try {
  const catalog = await loadLibraryFileCatalog({ root: input.root });
  const { result: reconcile, graphSync } = await reconcileLibraryCatalogPg(db, {
    catalog,
    root: input.root,
    trigger: "import_approval",
    rejectExistingObjectKeys: new Set(installedFiles.map((file) => file.objectKey)),
  });
  const importedKeys = new Set(installedFiles.map((file) => file.objectKey));
  return {
    draftId: input.draftId,
    status: "approved" as const,
    proposal: reserved.proposal,
    files: installedFiles.map((file) => ({ relativePath: file.relativePath })),
    synced: graphSync.results.filter((item) => importedKeys.has(item.object.objectKey)),
    reconcile,
    librarySnapshotHash: reconcile.snapshotHash,
  };
} catch (error) {
  await Promise.all(installedFiles.map((file) => removeLibraryFileIfContentMatches({
    root: input.root,
    relativePath: file.relativePath,
    content: file.content,
  })));
  throw error;
}
```

Extract `reconcileLibraryCatalogPg(db, input): Promise<{ result: LibraryReconcileResult; graphSync: LibraryGraphSyncResult }>` from Task 2 so `reconcileLibraryFilesPg` is a discovery wrapper and import can pass its already-read catalog. `reconcileLibraryCatalogPg` owns the advisory-locked DB transaction and supports `rejectExistingObjectKeys` by checking locked graph rows before any upsert. Update `LibraryImportDraftApprovalResult` to retain `synced` and add `reconcile: LibraryReconcileResult` plus `librarySnapshotHash: string`. Remove `syncNewLibraryFileRecordsToGraph` and `syncLibraryFileRecordToGraph` usage from import approval paths.

- [ ] **Step 6: Expose the current readiness through the existing Library proxy**

Add a read-only branch to `library-routes.ts`:

```ts
if (request.method === "GET" && url.pathname === "/api/v2/library/readiness") {
  const readiness = await loadLibraryReadinessPg(context.db);
  return json("library-readiness", {
    readiness: readiness ? {
      ready: true,
      status: readiness.status,
      snapshotHash: readiness.snapshotHash,
      includedCount: readiness.includedCount,
      excludedCount: readiness.excludedCount,
      diagnostics: readiness.diagnostics,
    } : {
      ready: false,
      status: "not_ready",
      snapshotHash: null,
      includedCount: 0,
      excludedCount: 0,
      diagnostics: [],
    },
  });
}
```

The existing `web/app/api/library/[...path]/route.ts` proxy must pass `/api/library/readiness` to this runtime route without adding a new route file.

- [ ] **Step 7: Show readiness and diagnostics in the existing Library workspace**

In `web/lib/library/types.ts`, define:

```ts
export type LibraryReadinessView = {
  ready: boolean;
  status: "ready" | "ready_with_warnings" | "not_ready";
  snapshotHash: string | null;
  includedCount: number;
  excludedCount: number;
  diagnostics: Array<{ code: string; message: string; paths: string[]; missingRefs: string[] }>;
};

export type LibraryReconcileResult = {
  schemaVersion: "southstar.library_sync_snapshot.v1";
  snapshotHash: string;
  status: "ready" | "ready_with_warnings";
  sourceRoot: string;
  trigger: "startup" | "library_save" | "import_approval";
  included: Array<{ path: string; objectKey: string; objectKind: string; sourceHash: string; versionRef: string }>;
  excluded: Array<{ path: string; objectKey?: string; reason: string; missingRefs: string[] }>;
  deprecatedObjectKeys: string[];
  warnings: string[];
};

export type LibraryFileSyncResult = {
  file: { relativePath: string; parsed: LibraryFileParseResult };
  reconcile: LibraryReconcileResult;
};
```

In `web/lib/library/api.ts`, add:

```ts
export async function readLibraryReadiness(): Promise<LibraryReadinessView> {
  const response = await fetch("/api/library/readiness", { cache: "no-store" });
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json() as { readiness: LibraryReadinessView };
  return body.readiness;
}

export function readinessFromReconcile(result: LibraryReconcileResult): LibraryReadinessView {
  return {
    ready: true,
    status: result.status,
    snapshotHash: result.snapshotHash,
    includedCount: result.included.length,
    excludedCount: result.excluded.length,
    diagnostics: result.excluded.map((item) => ({
      code: "reconcile_excluded",
      message: item.reason,
      paths: item.path ? [item.path] : [],
      missingRefs: item.missingRefs,
    })),
  };
}
```

Create `LibraryReadinessBanner.tsx`:

```tsx
import type { LibraryReadinessView } from "@/lib/library/types";

export function LibraryReadinessBanner({ readiness }: { readiness: LibraryReadinessView }) {
  return (
    <section data-testid="library-readiness" aria-live="polite">
      <strong>{readiness.ready ? "Library ready" : "Library not ready"}</strong>
      <span>{readiness.snapshotHash ? readiness.snapshotHash.slice(0, 12) : "No successful snapshot"}</span>
      <span>{readiness.includedCount} included · {readiness.excludedCount} excluded</span>
      {readiness.diagnostics.map((diagnostic) => (
        <p key={`${diagnostic.code}:${diagnostic.paths.join("|")}`}>{diagnostic.message}</p>
      ))}
    </section>
  );
}
```

In `LibraryWorkspace.tsx`, add `readiness: LibraryReadinessView` to the provider context, initialize it to the `not_ready` value, load it with `readLibraryReadiness()` in the existing active-workspace effect, replace it with `readinessFromReconcile(result.reconcile)` after `syncLibraryFile(savePath)`, and render `<LibraryReadinessBanner readiness={context.readiness} />` above the existing `<LibrarySidebar>` in `LibrarySidebarPanel`. Do not introduce another tab, modal, or Library layout.

- [ ] **Step 8: Test the readiness banner and sync refresh**

In `southstar-library-workspace-interaction.test.tsx`, add a focused browser-harness rendering test:

```tsx
test("LibraryReadinessBanner shows snapshot and excluded diagnostics", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryReadinessBanner } from "./web/components/library/LibraryReadinessBanner";
    createRoot(document.getElementById("root")).render(
      <LibraryReadinessBanner readiness={{
        ready: true,
        status: "ready_with_warnings",
        snapshotHash: "abc123def456",
        includedCount: 4,
        excludedCount: 1,
        diagnostics: [{
          code: "missing_reference",
          message: "skill.worker is missing tool.browser",
          paths: ["library/skills/worker.skill.md"],
          missingRefs: ["tool.browser"],
        }],
      }} />
    );
  `, async (page) => {
    const banner = page.getByTestId("library-readiness");
    await banner.waitFor();
    assert.match(await banner.innerText(), /Library ready.*abc123def456.*4 included.*1 excluded/s);
    assert.match(await banner.innerText(), /skill.worker is missing tool.browser/);
  });
});
```

Extend the existing `library file API helpers unwrap envelopes` test with:

```ts
if (String(input) === "/api/library/readiness") {
  return new Response(JSON.stringify({ readiness: {
    ready: true, status: "ready", snapshotHash: "abc123", includedCount: 2, excludedCount: 0, diagnostics: [],
  } }));
}
const readiness = await api.readLibraryReadiness();
assert.equal(readiness.snapshotHash, "abc123");
assert.deepEqual(requests.at(-1), { url: "/api/library/readiness", method: "GET", body: undefined });
```

In the existing `LibraryWorkspaceProvider` Save & Sync browser scenario's `page.route`, return this sync response:

```ts
await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
  ok: true,
  result: {
    file: { relativePath: "software/agents/planner.agent.md" },
    reconcile: {
      schemaVersion: "southstar.library_sync_snapshot.v1",
      status: "ready",
      snapshotHash: "def456",
      sourceRoot: "/workspace/library",
      trigger: "library_save",
      included: [
        { path: "library/skills/goal.skill.md", objectKey: "skill.goal", objectKind: "skill_spec", sourceHash: "a", versionRef: "skill.goal@a" },
        { path: "library/skills/composer.skill.md", objectKey: "skill.composer", objectKind: "skill_spec", sourceHash: "b", versionRef: "skill.composer@b" },
        { path: "library/agents/planner.agent.md", objectKey: "agent.planner", objectKind: "agent_definition", sourceHash: "c", versionRef: "agent.planner@c" },
        { path: "library/tools/read.tool.yaml", objectKey: "tool.read", objectKind: "tool_definition", sourceHash: "d", versionRef: "tool.read@d" },
        { path: "library/tools/write.tool.yaml", objectKey: "tool.write", objectKind: "tool_definition", sourceHash: "e", versionRef: "tool.write@e" },
      ],
      excluded: [],
      deprecatedObjectKeys: [],
      warnings: [],
    },
  },
}) });
```

After its existing Save & Sync click, add:

```ts
await page.getByTestId("library-readiness").waitFor();
assert.match(await page.getByTestId("library-readiness").innerText(), /def456.*5 included.*0 excluded/s);
```

- [ ] **Step 9: Run focused Library tests and commit shared semantics**

Run:

```bash
npx tsx --test tests/v2/library-chat-routes.test.ts tests/v2/library-import-drafts.test.ts tests/v2/library-file-store.test.ts tests/v2/library-reconcile-postgres.test.ts
npx tsx --test tests/web/southstar-library-workspace-interaction.test.tsx
```

Expected: PASS; Save & Sync and import approval both return a current snapshot hash.

```bash
git add src/v2/server/library-routes.ts src/v2/design-library/importers/library-import-draft-store.ts src/v2/design-library/files/library-file-store.ts src/v2/design-library/files/library-reconcile-service.ts web/lib/library/types.ts web/lib/library/api.ts web/components/library/LibraryReadinessBanner.tsx web/components/library/LibraryWorkspace.tsx tests/v2/library-chat-routes.test.ts tests/v2/library-import-drafts.test.ts tests/web/southstar-library-workspace-interaction.test.tsx
git commit -m "refactor: share library reconcile across authoring"
```

### Task 5: Structured Browser Error For Library Readiness

**Files:**

- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/hooks/useAgentSession.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**

- Consumes: runtime 503 body `{ error: "library_not_ready"; message: string; diagnostics: LibraryFileDiagnostic[] }`.
- Produces: `WorkflowGenerateHttpError` with `code`, `status`, and `diagnostics` and user-facing Library guidance.

- [ ] **Step 1: Write a failing Web test for the structured 503 path**

Add a test that stubs `/api/workflow/generate` with HTTP 503 JSON:

```tsx
test("Workflow chat explains Library readiness failures", async () => {
  mockFetchResponse(503, {
    error: "library_not_ready",
    message: "Library reconciliation has not produced a ready snapshot",
    diagnostics: [{
      code: "required_purpose_cardinality",
      message: "expected exactly one approved goal_design skill, found 0",
      fatal: true,
      paths: [],
      missingRefs: [],
    }],
  });
  render(<WorkflowTestShell />);
  await submitWorkflowPrompt("Build a vocabulary app");
  assert.match(screen.getByText(/Library is not ready/i).textContent ?? "", /Open Library.*sync diagnostics/i);
  assert.doesNotMatch(screen.getByText(/Library is not ready/i).textContent ?? "", /Workflow generation failed: \{/);
});
```

Use the file's existing renderer, fetch stubbing, and input helpers instead of introducing another test harness.

- [ ] **Step 2: Run the Web test and verify raw error text is shown**

Run: `npx tsx --test tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: FAIL because `generate-stream.ts` throws raw response text and the hook prefixes the generic workflow error.

- [ ] **Step 3: Parse structured upstream errors into a typed exception**

In `generate-stream.ts`, add:

```ts
export class WorkflowGenerateHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly diagnostics: unknown[] = [],
  ) {
    super(message);
    this.name = "WorkflowGenerateHttpError";
  }
}

async function throwWorkflowGenerateError(response: Response): Promise<never> {
  const text = await response.text();
  let payload: { error?: string; message?: string; diagnostics?: unknown[] } = {};
  try { payload = JSON.parse(text) as typeof payload; } catch { /* preserve plain upstream text */ }
  throw new WorkflowGenerateHttpError(
    (payload.message ?? text) || `Workflow generation failed with HTTP ${response.status}`,
    response.status,
    payload.error,
    payload.diagnostics ?? [],
  );
}
```

Replace the current non-OK branch with `await throwWorkflowGenerateError(response)`.

- [ ] **Step 4: Render an actionable message only for the stable readiness code**

In `useAgentSession.ts`, update the catch branch:

```ts
const failure = error instanceof WorkflowGenerateHttpError && error.code === "library_not_ready"
  ? `Library is not ready: ${error.message}. Open Library to review and sync diagnostics, then retry this Goal.`
  : `Workflow generation failed: ${error instanceof Error ? error.message : String(error)}`;
appendAssistantMessage(failure);
```

Use the hook's existing assistant-message append function and state update names; only replace message selection.

- [ ] **Step 5: Run Web tests and production build, then commit**

Run:

```bash
npx tsx --test tests/web/southstar-workflow-canvas-ui.test.tsx
npm --prefix web run build
```

Expected: PASS and successful Next.js production build.

```bash
git add web/lib/workflow/generate-stream.ts web/hooks/useAgentSession.ts tests/web/southstar-workflow-canvas-ui.test.tsx
git commit -m "fix: explain library readiness in workflow chat"
```

### Task 6: Real Startup-Proven Browser Case 32 And Final Regression Gate

**Files:**

- Modify: `tests/e2e-postgres/postgres-real-harness.ts`
- Modify: `tests/e2e-browser/32-goal-vocabulary-browser.test.ts`
- Modify: `package.json`
- Verify: `library/skills/southstar-goal-design.skill.md`
- Verify: `library/skills/southstar-slice-to-dag-composer.skill.md`

**Interfaces:**

- Consumes: Task 3 `prepareRuntimeLibraryPg`, Task 2 `loadLibraryReadinessPg`, existing browser snapshot helpers, and the real runtime/browser harness.
- Produces: Case 32 that proves a normal production startup seam makes the Goal Design and composer skills graph-backed without `syncBaseLibrary` or an explicit file list.

- [ ] **Step 1: Change the real runtime harness to use the production startup preparation seam**

In `postgres-real-harness.ts`, add `libraryRoot?: string` to the existing `createRealRuntimeServer` input type. Immediately after the existing `plannerClient`, `workflowComposer`, and `executorProvider` setup and before its existing `return await createSouthstarRuntimeServer`, insert:

```ts
const libraryRoot = input.libraryRoot ?? resolve(process.cwd(), "library");
await prepareRuntimeLibraryPg(input.db, { libraryRoot });
```

Add `libraryRoot,` immediately after `db: input.db as never,` in the existing `createSouthstarRuntimeServer` argument. Preserve its current planner, import provider, executor, managed runtime, Tork observation, callback, and reconcile-loop values unchanged.

This is a production startup function call, not a test-only sync helper. It discovers the complete Library directory dynamically.

- [ ] **Step 2: Remove the Case 32 sync helper and assert readiness provenance**

In `32-goal-vocabulary-browser.test.ts`:

- remove the `syncLibraryFileToGraph` import;
- delete `syncBaseLibrary` and its hardcoded relative-path array;
- delete `await syncBaseLibrary(env.db)`;
- pass `libraryRoot: resolve(repositoryRoot, "library")` to `createRealRuntimeServer`;
- collect JSON request bodies for `/api/workflow/generate` with a Playwright `page.on("request")` listener;
- after runtime startup, assert:

```ts
const workflowGenerateBodies: unknown[] = [];
page.on("request", (request) => {
  if (!request.url().endsWith("/api/workflow/generate") || request.method() !== "POST") return;
  workflowGenerateBodies.push(request.postDataJSON());
});
```

Then verify startup provenance:

```ts
const readiness = await loadLibraryReadinessPg(env.db);
assert.equal(readiness?.ready, true);
assert.equal(readiness?.trigger, "startup");
const goalSkill = await loadGoalDesignSkillPg(env.db);
assert.ok(goalSkill.versionRef);
const goalSkillObject = await findLibraryObjectByKey(env.db, goalSkill.objectKey);
assert.equal(goalSkillObject?.state.purpose, "goal_design");
assert.match(String(goalSkillObject?.state.sourcePath), /^library\/skills\//);
```

After Goal submission, assert the browser request remains goal-only:

```ts
assert.ok(workflowGenerateBodies.length > 0);
for (const body of workflowGenerateBodies) {
  const keys = JSON.stringify(body);
  assert.doesNotMatch(keys, /"(?:skillBody|goalDesignSkill|goalDesignSkillId|composerSkillId)"/);
}
```

Keep all current browser action screenshots/snapshots and existing assertions for Library import, Goal, Slice Plan, DAG, execution, and completion.

- [ ] **Step 3: Add the named Case 32 browser script**

In `package.json`, add to `scripts`:

```json
"test:e2e:browser:32": "tsx tests/e2e-browser/32-goal-vocabulary-browser.test.ts"
```

- [ ] **Step 4: Run non-live focused regression tests first**

Run:

```bash
npx tsx --test tests/v2/library-reconcile-service.test.ts tests/v2/library-reconcile-postgres.test.ts tests/v2/library-file-store.test.ts tests/v2/library-chat-routes.test.ts tests/v2/library-import-drafts.test.ts tests/v2/runtime-server-lifecycle.test.ts tests/v2/run-goal-service.test.ts tests/v2/routes.test.ts tests/web/southstar-workflow-canvas-ui.test.tsx
npm run test:v2
npm --prefix web run build
```

Expected: every command exits 0; no test writes an `@placeholder` Library version.

- [ ] **Step 5: Start the managed infrastructure required by the explicitly requested browser E2E**

Run:

```bash
npm run southstar:status
npm run southstar:start
```

Expected: Postgres, Tork, Southstar runtime, and the `web/` Next.js app report healthy. Runtime health JSON contains `library.ready: true` and a non-null snapshot hash.

- [ ] **Step 6: Run the real Case 32 browser E2E from the requested project CWD**

Run:

```bash
SOUTHSTAR_E2E_PROJECT_CWD=/home/timmypai/apps/southstar-vocab npm run test:e2e:browser:32
```

Expected: PASS; browser snapshots exist for every defined UI action; the generated Goal/DAG uses `/home/timmypai/apps/southstar-vocab`; no setup step calls a test-only Library sync function.

- [ ] **Step 7: Inspect runtime evidence instead of accepting only a green UI**

Run:

```bash
npm run southstar:status
curl -fsS http://127.0.0.1:3100/api/v2/runtime/health
```

Expected: managed services remain healthy; health includes the same current `library.snapshotHash` recorded by Case 32; no log contains `expected exactly one approved Goal Design skill, found 0`, `@placeholder`, or a fixture composer mode.

- [ ] **Step 8: Commit the production-proven E2E**

```bash
git add tests/e2e-postgres/postgres-real-harness.ts tests/e2e-browser/32-goal-vocabulary-browser.test.ts package.json
git commit -m "test: prove startup library reconcile in case 32"
```

- [ ] **Step 9: Run final verification before declaring completion**

Use the `superpowers:verification-before-completion` skill. Run:

```bash
git status --short
git diff --check HEAD~6..HEAD
npm test
npm --prefix web run build
SOUTHSTAR_E2E_PROJECT_CWD=/home/timmypai/apps/southstar-vocab npm run test:e2e:browser:32
```

Expected: all verification commands exit 0. `git status --short` may show only the user's pre-existing unrelated recovery/Operator UI edits; implementation files from this plan are committed.

## Acceptance Mapping

- AC-01/AC-02 startup discovery and pre-listen readiness: Tasks 1, 2, and 3.
- AC-03 metadata-selected Goal Design and composer guidance: Tasks 1, 2, and 6.
- AC-04 no seed, fixture, hardcoded id, placeholder, or fallback: Tasks 1, 2, and final scans in Task 6.
- AC-05 atomic objects, edges, lifecycle, snapshot, and readiness: Task 2.
- AC-06 idempotent content-addressed snapshot: Task 2.
- AC-07 removed file-backed objects deprecated without touching runtime-generated objects: Task 2.
- AC-08 `/run-goal` is read-only and returns structured 503: Task 3.
- AC-09 health/readiness diagnostics: Tasks 2 and 3.
- AC-10 Save & Sync and import share reconcile semantics: Task 4.
- AC-11 actionable browser message: Task 5.
- AC-12 real browser Case 32 removes test-only sync and preserves UI action snapshots: Task 6.

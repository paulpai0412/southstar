import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { WorkflowRunInput } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createWorkflowRunPg, getResourceByKeyPg, getWorkflowRunPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import type { UpsertLibraryObjectInput } from "../../src/v2/design-library/library-graph-store.ts";
import {
  createLibraryObject,
  findLibraryEdgesFrom,
  findLibraryObjectByKey,
  listLibraryEdges,
} from "../../src/v2/design-library/library-graph-store.ts";
import {
  LibraryReconcileError,
  loadLibraryReadinessPg,
  reconcileLibraryFilesPg,
} from "../../src/v2/design-library/files/library-reconcile-service.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

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
      reconcileLibraryFilesPg(db, { root, trigger: "startup" }),
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

test("snapshot resources are immutable while current readiness follows the latest reconcile", async () => {
  await withPostgresTestDb(async (db) => {
    const firstRoot = await createMinimalReadyLibraryRoot();
    const secondRoot = await createMinimalReadyLibraryRoot();
    await reconcileLibraryFilesPg(db, { root: firstRoot, trigger: "startup" });
    const second = await reconcileLibraryFilesPg(db, { root: secondRoot, trigger: "library_save" });

    const snapshot = await getResourceByKeyPg(db, "library_sync_snapshot", `library-sync:${second.snapshotHash}`);
    assert.equal((snapshot?.payload as { sourceRoot?: string }).sourceRoot, firstRoot);
    assert.equal((snapshot?.payload as { trigger?: string }).trigger, "startup");
    const readiness = await loadLibraryReadinessPg(db);
    assert.equal(readiness?.sourceRoot, secondRoot);
    assert.equal(readiness?.trigger, "library_save");
  });
});

test("non-executable files with unknown references persist without graph placeholders", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createLibraryRoot({
      "skills/goal.skill.md": approvedSkill("skill.goal-any", "goal_design"),
      "skills/composer.skill.md": approvedSkill("skill.composer-any", "composer_guidance"),
      "skills/draft.skill.md": approvedSkill("skill.draft", "worker", ["mystery.missing"]).replace("status: approved", "status: draft"),
    });
    const result = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    assert.equal(result.status, "ready");
    assert.equal((await findLibraryObjectByKey(db, "skill.draft"))?.status, "draft");
    assert.equal(await findLibraryObjectByKey(db, "mystery.missing"), null);
    assert.equal((await listLibraryEdges(db)).filter((edge) => edge.fromObjectKey === "skill.draft").length, 0);
  });
});

async function withPostgresTestDb(run: (db: Awaited<ReturnType<typeof createTestPostgresDb>>) => Promise<void>) {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
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

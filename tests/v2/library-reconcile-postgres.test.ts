import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/db/postgres.ts";
import type { WorkflowRunInput } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createWorkflowRunPg, getResourceByKeyPg, getWorkflowRunPg, upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import type { UpsertLibraryObjectInput } from "../../src/v2/design-library/library-graph-store.ts";
import {
  createLibraryObject,
  findLibraryEdgesFrom,
  findLibraryObjectByKey,
  listLibraryEdges,
} from "../../src/v2/design-library/library-graph-store.ts";
import {
  LibraryReconcileError,
  acquireLibraryReconcileLockPg,
  commitLibraryFilePublicationPg,
  loadLibraryReadinessPg,
  reconcileLibraryFilesPg,
} from "../../src/v2/design-library/files/library-reconcile-service.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { listLibraryFilePublications, prepareLibraryFilePublication } from "../../src/v2/design-library/files/library-file-store.ts";

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

test("startup reconcile reads the catalog after waiting for the advisory lock", async () => {
  const lockDb = await createTestPostgresDb();
  const reconcileDb = await openSouthstarDb(lockDb.databaseUrl);
  const root = await createMinimalReadyLibraryRoot();
  let releaseLock!: () => void;
  let announceLock!: () => void;
  const locked = new Promise<void>((resolve) => { announceLock = resolve; });
  const release = new Promise<void>((resolve) => { releaseLock = resolve; });
  const holder = lockDb.tx(async (tx) => {
    await acquireLibraryReconcileLockPg(tx);
    announceLock();
    await release;
  });
  try {
    await locked;
    const reconcile = reconcileLibraryFilesPg(reconcileDb, { root, trigger: "startup" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const updatedContent = approvedSkill("skill.goal-any", "goal_design", [], "Updated after reconcile started waiting");
    await writeFile(join(root, "skills/goal.skill.md"), updatedContent);
    releaseLock();
    await holder;
    const result = await reconcile;
    const expectedVersion = `skill.goal-any@${createHash("sha256").update(updatedContent).digest("hex").slice(0, 12)}`;
    assert.equal(result.included.find((item) => item.objectKey === "skill.goal-any")?.versionRef, expectedVersion);
  } finally {
    releaseLock();
    await holder.catch(() => {});
    await reconcileDb.close();
    await lockDb.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("abandoned pre-publish staging is invisible to startup reconcile", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot();
    const publication = await prepareLibraryFilePublication({
      root,
      identity: { kind: "library_file_patch", relativePath: "agents/staged.agent.md" },
      files: [{
        relativePath: "agents/staged.agent.md",
        mode: "create",
        content: `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.staged
title: Staged
scope: engineering
status: approved
---

# Identity

This file must remain invisible until publish.
`,
      }],
    });
    try {
      assert.equal(relative(root, publication.stagingRoot).startsWith(".."), true);
      const result = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
      assert.equal(result.included.some((item) => item.objectKey === "agent.staged"), false);
      assert.equal(await findLibraryObjectByKey(db, "agent.staged"), null);
      await assert.rejects(() => access(join(root, "agents/staged.agent.md")));
    } finally {
      await publication.discard();
    }
  });
});

test("startup recovery restores files published before an uncommitted crash", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot();
    const relativePath = "skills/goal.skill.md";
    const original = await readFile(join(root, relativePath), "utf8");
    const changed = approvedSkill("skill.goal-any", "goal_design", [], "Published before commit crash");
    const publication = await prepareLibraryFilePublication({
      root,
      identity: { kind: "library_file_patch", relativePath },
      files: [{ relativePath, content: changed, mode: "replace", expectedContent: original }],
    });
    await assert.rejects(
      () => db.tx(async (tx) => {
        await acquireLibraryReconcileLockPg(tx);
        await publication.publish();
        throw new Error("simulated process crash before commit");
      }),
      /simulated process crash before commit/,
    );
    const [journal] = await listLibraryFilePublications({ root });
    assert.equal(journal.manifest.phase, "published");
    assert.deepEqual(journal.manifest.identity, { kind: "library_file_patch", relativePath });
    assert.equal(journal.manifest.entries[0]?.expectedOriginalHash, createHash("sha256").update(original).digest("hex"));
    assert.equal(journal.manifest.entries[0]?.newHash, createHash("sha256").update(changed).digest("hex"));
    await access(join(journal.stagingRoot, journal.manifest.entries[0]!.originalContentRef!));
    await access(join(journal.stagingRoot, journal.manifest.entries[0]!.newContentRef));
    assert.equal(await readFile(join(root, relativePath), "utf8"), changed);

    const recovered = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    assert.equal(await readFile(join(root, relativePath), "utf8"), original);
    assert.equal((await listLibraryFilePublications({ root })).length, 0);
    assert.equal(
      recovered.included.find((item) => item.objectKey === "skill.goal-any")?.sourceHash,
      createHash("sha256").update(original).digest("hex"),
    );
  });
});

test("failed create publication preserves an operator file with identical content", async () => {
  const root = await createMinimalReadyLibraryRoot();
  const relativePath = "skills/operator-created.skill.md";
  const content = approvedSkill("skill.operator-created", "general", [], "Operator-created content");
  const publication = await prepareLibraryFilePublication({
    root,
    identity: { kind: "library_file_patch", relativePath },
    files: [{ relativePath, content, mode: "create" }],
  });
  try {
    await writeFile(join(root, relativePath), content);
    await assert.rejects(() => publication.publish(), /EEXIST/);
    assert.equal(await readFile(join(root, relativePath), "utf8"), content);
  } finally {
    await publication.discard();
    await rm(root, { recursive: true, force: true });
  }
});

test("create publication rollback preserves an in-place operator edit and immutable journal evidence", async () => {
  const root = await createMinimalReadyLibraryRoot();
  const relativePath = "skills/operator-create.skill.md";
  const publishedContent = approvedSkill("skill.operator-create", "general", [], "Published content");
  const operatorContent = "operator changed the created file in place";
  const publication = await prepareLibraryFilePublication({
    root,
    identity: { kind: "library_file_patch", relativePath },
    files: [{ relativePath, content: publishedContent, mode: "create" }],
  });
  try {
    await publication.publish();
    await writeFile(join(root, relativePath), operatorContent);

    assert.equal(
      await readFile(join(publication.stagingRoot, publication.manifest.entries[0]!.newContentRef), "utf8"),
      publishedContent,
    );
    await publication.rollbackPublished();
    assert.equal(await readFile(join(root, relativePath), "utf8"), operatorContent);
  } finally {
    await publication.discard();
    await rm(root, { recursive: true, force: true });
  }
});

test("replace publication rollback preserves an in-place operator edit and immutable journal evidence", async () => {
  const root = await createMinimalReadyLibraryRoot();
  const relativePath = "skills/goal.skill.md";
  const originalContent = await readFile(join(root, relativePath), "utf8");
  const publishedContent = approvedSkill("skill.goal-any", "goal_design", [], "Published replacement");
  const operatorContent = "operator changed the replacement in place";
  const publication = await prepareLibraryFilePublication({
    root,
    identity: { kind: "library_file_patch", relativePath },
    files: [{ relativePath, content: publishedContent, mode: "replace", expectedContent: originalContent }],
  });
  try {
    await publication.publish();
    await writeFile(join(root, relativePath), operatorContent);

    assert.equal(
      await readFile(join(publication.stagingRoot, publication.manifest.entries[0]!.newContentRef), "utf8"),
      publishedContent,
    );
    await publication.rollbackPublished();
    assert.equal(await readFile(join(root, relativePath), "utf8"), operatorContent);
  } finally {
    await publication.discard();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery rolls forward a committed publication left before cleanup", async () => {
  await withPostgresTestDb(async (db) => {
    const root = await createMinimalReadyLibraryRoot();
    const relativePath = "skills/goal.skill.md";
    const original = await readFile(join(root, relativePath), "utf8");
    const changed = approvedSkill("skill.goal-any", "goal_design", [], "Committed before cleanup crash");
    const importDraftId = `library-import-${randomUUID()}`;
    const publication = await prepareLibraryFilePublication({
      root,
      identity: {
        kind: "candidate_install",
        importDraftId,
        plannerDraftId: "planner-crash-recovery",
        originGoalContractHash: "contract-hash",
        originGoalRequirementDraftHash: "requirement-hash",
        originGoalValidationResolutionHash: "resolution-hash",
        originGoalValidationGapHash: "gap-hash",
      },
      files: [{ relativePath, content: changed, mode: "replace", expectedContent: original }],
    });
    await db.tx(async (tx) => {
      await acquireLibraryReconcileLockPg(tx);
      await publication.publish();
      await upsertRuntimeResourcePg(tx, {
        resourceType: "library_import_draft",
        resourceKey: importDraftId,
        scope: "library",
        status: "installed",
        payload: {
          install: { publicationId: publication.publicationId },
          originGoalDraftId: "planner-crash-recovery",
          originGoalContractHash: "contract-hash",
          originGoalRequirementDraftHash: "requirement-hash",
          originGoalValidationResolutionHash: "resolution-hash",
          originGoalValidationGapHash: "gap-hash",
        },
        summary: {},
      });
      await commitLibraryFilePublicationPg(tx, publication);
    });
    assert.equal((await listLibraryFilePublications({ root })).length, 1);

    const recovered = await reconcileLibraryFilesPg(db, { root, trigger: "startup" });
    assert.equal(await readFile(join(root, relativePath), "utf8"), changed);
    assert.equal((await listLibraryFilePublications({ root })).length, 0);
    assert.equal(
      recovered.included.find((item) => item.objectKey === "skill.goal-any")?.sourceHash,
      createHash("sha256").update(changed).digest("hex"),
    );
  });
});

test("waiting reconcile restores an uncommitted publication after transaction failure", async () => {
  const writerDb = await createTestPostgresDb();
  const reconcileDb = await openSouthstarDb(writerDb.databaseUrl);
  const root = await createMinimalReadyLibraryRoot();
  const relativePath = "skills/goal.skill.md";
  const original = await readFile(join(root, relativePath), "utf8");
  const changed = approvedSkill("skill.goal-any", "goal_design", [], "Failed commit while reconcile waits");
  const publication = await prepareLibraryFilePublication({
    root,
    identity: { kind: "library_file_patch", relativePath },
    files: [{ relativePath, content: changed, mode: "replace", expectedContent: original }],
  });
  let published!: () => void;
  let release!: () => void;
  const publishedSignal = new Promise<void>((resolve) => { published = resolve; });
  const releaseSignal = new Promise<void>((resolve) => { release = resolve; });
  try {
    const failedWriter = writerDb.tx(async (tx) => {
      await acquireLibraryReconcileLockPg(tx);
      await publication.publish();
      await commitLibraryFilePublicationPg(tx, publication);
      published();
      await releaseSignal;
      throw new Error("forced commit failure");
    });
    await publishedSignal;
    const waitingReconcile = reconcileLibraryFilesPg(reconcileDb, { root, trigger: "startup" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await assert.rejects(() => failedWriter, /forced commit failure/);
    const recovered = await waitingReconcile;
    assert.equal(await readFile(join(root, relativePath), "utf8"), original);
    assert.equal((await listLibraryFilePublications({ root })).length, 0);
    assert.equal(
      recovered.included.find((item) => item.objectKey === "skill.goal-any")?.sourceHash,
      createHash("sha256").update(original).digest("hex"),
    );
  } finally {
    release();
    await reconcileDb.close();
    await writerDb.close();
    await rm(root, { recursive: true, force: true });
  }
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

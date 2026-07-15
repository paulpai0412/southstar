import test from "node:test";
import assert from "node:assert/strict";
import { buildLibraryCatalogSyncPlan } from "../../src/v2/design-library/files/library-reconcile-service.ts";
import type { LibraryFileRecord } from "../../src/v2/design-library/files/library-file-types.ts";

function skill(objectKey: string, purpose: string, status: "approved" | "draft" = "approved"): LibraryFileRecord {
  return {
    path: `skills/${objectKey}.skill.md`,
    kind: "skill",
    objectKey,
    objectKind: "skill_spec",
    id: objectKey,
    title: objectKey,
    scope: "software",
    status,
    schemaVersion: "southstar.library.skill_spec.v1",
    frontmatter: {},
    definition: { purpose },
    body: "instructions",
    sourceHash: objectKey.repeat(64).slice(0, 64),
  };
}

test("library catalog sync plan is the fail-closed executable/readiness boundary", () => {
  const plan = buildLibraryCatalogSyncPlan({
    root: "/tmp/library",
    records: [skill("skill.goal", "goal_design"), skill("skill.composer", "composer_guidance"), skill("skill.draft", "worker", "draft")],
    diagnostics: [],
  });

  assert.deepEqual(plan.executable.map((file) => file.objectKey), ["skill.composer", "skill.goal"]);
  assert.equal(plan.nonExecutable[0]?.file.objectKey, "skill.draft");
  assert.equal(plan.nonExecutable[0]?.status, "draft");
  assert.equal(plan.diagnostics.length, 0);
  assert.match(plan.snapshotHash, /^[a-f0-9]{64}$/);
});

test("library catalog sync plan rejects missing required executable purposes", () => {
  assert.throws(
    () => buildLibraryCatalogSyncPlan({ root: "/tmp/library", records: [skill("skill.goal", "goal_design")], diagnostics: [] }),
    /composer_guidance/,
  );
});

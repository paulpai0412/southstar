import assert from "node:assert/strict";
import test from "node:test";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { findLibraryEdgesFrom } from "../../src/v2/design-library/library-graph-store.ts";
import type { LibraryEdgeType } from "../../src/v2/design-library/types.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("software library seed smoke: expected maker and evaluator edges exist", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);

    await assertHasDirectEdge(db, "profile.software-maker-pi", "implements", "agent.software-maker");
    await assertHasDirectEdge(db, "profile.software-maker-pi", "supports_skill", "skill.software-implementation");
    await assertHasDirectEdge(db, "profile.software-maker-pi", "allows_tool", "tool.workspace-write");
    await assertHasDirectEdge(
      db,
      "evaluator.software-feature-quality",
      "validates_artifact",
      "artifact.implementation_report",
    );
  } finally {
    await db.close();
  }
});

async function assertHasDirectEdge(
  db: SouthstarDb,
  fromObjectKey: string,
  edgeType: LibraryEdgeType,
  toObjectKey: string,
): Promise<void> {
  const edges = await findLibraryEdgesFrom(db, fromObjectKey, edgeType, { scope: "software" });
  assert.equal(
    edges.some((edge) => edge.toObjectKey === toObjectKey),
    true,
    `missing ${fromObjectKey} -[${edgeType}]-> ${toObjectKey}`,
  );
}

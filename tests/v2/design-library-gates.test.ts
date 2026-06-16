import assert from "node:assert/strict";
import test from "node:test";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { seedSoftwareDevDesignLibrary } from "../../src/v2/design-library/software-dev-seed.ts";
import { assertDesignLibraryQuantitativeGates } from "../../src/v2/quality/design-library-gates.ts";

test("design library gate enforces seeded definitions across all 7 kinds", () => {
  const db = openSouthstarDb(":memory:");
  seedSoftwareDevDesignLibrary(db, { actorType: "migration" });
  const result = assertDesignLibraryQuantitativeGates(db, { minApprovedVersions: 14, minAgentSpecs: 5 });
  assert.equal(result.ok, true, result.failures.join("\n"));
});

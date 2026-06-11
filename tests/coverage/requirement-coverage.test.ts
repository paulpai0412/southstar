import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  analyzeRequirementCoverage,
  formatRequirementCoverageSummary,
  expectedAcceptanceIds,
  expectedExceptionIds,
} from "./requirement-coverage.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

test("requirement coverage maps AC and EX requirements to tests and implementation", async (t) => {
  const result = await analyzeRequirementCoverage(repoRoot);
  t.diagnostic(formatRequirementCoverageSummary(result.metrics));

  assert.equal(result.metrics.requirement_coverage_total, expectedAcceptanceIds.length + expectedExceptionIds.length);
  assert.equal(result.metrics.requirement_coverage_unmapped, 0);
  assert.equal(result.metrics.requirement_coverage_percent, 100);
  assert.deepEqual(result.unmapped, []);
  assert.equal(result.missingFiles.length, 0);
  assert.equal(result.missingIds.length, 0);
});

test("requirement coverage parser reports actionable gaps", async () => {
  const result = await analyzeRequirementCoverage(repoRoot, {
    matrices: [{
      path: join("docs", "superpowers", "exception-e2e-coverage.md"),
      expectedIds: ["EX-01", "EX-99"],
    }],
  });

  assert.equal(result.metrics.requirement_coverage_total, 2);
  assert.equal(result.metrics.requirement_coverage_mapped, 1);
  assert.equal(result.metrics.requirement_coverage_unmapped, 1);
  assert.deepEqual(result.missingIds, ["EX-99"]);
});

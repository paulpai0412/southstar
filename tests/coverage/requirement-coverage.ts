import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export const expectedAcceptanceIds = Array.from({ length: 23 }, (_, index) => `AC-${String(index + 1).padStart(2, "0")}`);
export const expectedExceptionIds = Array.from({ length: 14 }, (_, index) => `EX-${String(index + 1).padStart(2, "0")}`);

export interface CoverageMatrixSpec {
  path: string;
  expectedIds: string[];
}

export interface RequirementCoverageMetrics {
  requirement_coverage_total: number;
  requirement_coverage_mapped: number;
  requirement_coverage_percent: number;
  requirement_coverage_unmapped: number;
  requirement_coverage_matrix_files_checked: number;
}

export interface RequirementCoverageResult {
  metrics: RequirementCoverageMetrics;
  unmapped: string[];
  missingIds: string[];
  missingFiles: string[];
  rowProblems: string[];
}

const defaultMatrices: CoverageMatrixSpec[] = [
  {
    path: join("docs", "superpowers", "full-ac-coverage.md"),
    expectedIds: expectedAcceptanceIds,
  },
  {
    path: join("docs", "superpowers", "exception-e2e-coverage.md"),
    expectedIds: expectedExceptionIds,
  },
];

const referenceMatrices = [
  join("docs", "superpowers", "runtime-core-coverage.md"),
  join("docs", "superpowers", "persistence-engine-coverage.md"),
  join("docs", "superpowers", "cli-adapters-coverage.md"),
  join("docs", "superpowers", "ac16-ac23-coverage.md"),
  join("docs", "superpowers", "daemon-e2e-coverage.md"),
  join("docs", "superpowers", "full-live-workflow-e2e-coverage.md"),
  join("docs", "superpowers", "live-e2e-coverage.md"),
  join("docs", "superpowers", "live-integrations-packaging-coverage.md"),
];

export async function analyzeRequirementCoverage(
  repoRoot: string,
  options: { matrices?: CoverageMatrixSpec[] } = {},
): Promise<RequirementCoverageResult> {
  const matrices = options.matrices ?? defaultMatrices;
  const missingFiles: string[] = [];
  const missingIds: string[] = [];
  const unmapped: string[] = [];
  const rowProblems: string[] = [];
  let mapped = 0;
  let total = 0;

  for (const reference of options.matrices ? [] : referenceMatrices) {
    try {
      await access(join(repoRoot, reference));
    } catch {
      missingFiles.push(reference);
    }
  }

  for (const matrix of matrices) {
    total += matrix.expectedIds.length;
    const absolutePath = join(repoRoot, matrix.path);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf8");
    } catch {
      missingFiles.push(matrix.path);
      missingIds.push(...matrix.expectedIds);
      unmapped.push(...matrix.expectedIds);
      continue;
    }

    const rows = parseMarkdownRows(content);
    for (const expectedId of matrix.expectedIds) {
      const row = rows.find((candidate) => candidate.cells.some((cell) => cell.includes(expectedId)));
      if (!row) {
        missingIds.push(expectedId);
        unmapped.push(expectedId);
        continue;
      }
      const joined = row.cells.join(" ");
      const hasTestMapping = /`?tests\//.test(joined);
      const hasImplementationMapping = /`?(src\/|tests\/|docs\/|package\.json)/.test(joined);
      if (!hasTestMapping || !hasImplementationMapping) {
        rowProblems.push(`${expectedId}: missing ${hasTestMapping ? "implementation" : "test"} mapping`);
        unmapped.push(expectedId);
        continue;
      }
      mapped += 1;
    }
  }

  const unmappedCount = total - mapped;
  return {
    metrics: {
      requirement_coverage_total: total,
      requirement_coverage_mapped: mapped,
      requirement_coverage_percent: total === 0 ? 100 : Math.floor((mapped / total) * 100),
      requirement_coverage_unmapped: unmappedCount,
      requirement_coverage_matrix_files_checked: matrices.length + (options.matrices ? 0 : referenceMatrices.length),
    },
    unmapped,
    missingIds,
    missingFiles,
    rowProblems,
  };
}

export function formatRequirementCoverageSummary(metrics: RequirementCoverageMetrics): string {
  return [
    `requirement_coverage_total=${metrics.requirement_coverage_total}`,
    `requirement_coverage_mapped=${metrics.requirement_coverage_mapped}`,
    `requirement_coverage_percent=${metrics.requirement_coverage_percent}`,
    `requirement_coverage_unmapped=${metrics.requirement_coverage_unmapped}`,
    `requirement_coverage_matrix_files_checked=${metrics.requirement_coverage_matrix_files_checked}`,
  ].join(" ");
}

interface MarkdownRow {
  cells: string[];
}

function parseMarkdownRows(content: string): MarkdownRow[] {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .filter((line) => !/^\|\s*:?-{3,}:?\s*\|/.test(line.trim()))
    .map((line) => ({
      cells: line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    }))
    .filter((row) => row.cells.length >= 3);
}

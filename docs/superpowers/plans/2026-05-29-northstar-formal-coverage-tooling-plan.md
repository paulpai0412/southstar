# Northstar Formal Coverage Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic formal coverage gates for runtime/control-plane code coverage and documented requirement coverage.

**Architecture:** Use `c8` for V8 code coverage over deterministic tests only, scoped to runtime/control-plane core source. Add a test-owned requirement coverage checker that parses existing markdown matrices and emits quantitative TAP diagnostics without touching production runtime code.

**Tech Stack:** Node 22 ESM + TypeScript strip-only execution, `node:test`, `c8`, existing markdown coverage docs.

---

## File Structure

- Modify `package.json`: add `devDependencies.c8`, coverage scripts, and `c8` configuration.
- Modify `package-lock.json`: updated by `npm install --save-dev c8`.
- Modify `.gitignore`: ignore generated `coverage/` artifacts.
- Create `tests/coverage/code-coverage-runner.test.ts`: imports deterministic test entrypoints for c8.
- Create `tests/coverage/run-coverage-gates.ts`: runs requirement and code coverage gates through argv arrays.
- Create `tests/coverage/requirement-coverage.ts`: parses markdown matrices and computes requirement coverage metrics.
- Create `tests/coverage/requirement-coverage.test.ts`: validates AC/EX coverage and summary output.
- Create `docs/superpowers/formal-coverage-tooling-coverage.md`: maps this tooling goal to tests and implementation files.
- Modify `tests/spec/spec-compliance.test.ts`: verifies the formal coverage matrix exists and names the coverage gates.

## Task 1: Add Code Coverage Command Shell

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `tests/coverage/code-coverage-runner.test.ts`

- [ ] **Step 1: Run RED for missing coverage command**

Run:

```bash
npm run test:coverage:code
```

Expected: fail with `Missing script: "test:coverage:code"`.

- [ ] **Step 2: Install c8 as a dev dependency**

Run:

```bash
npm install --save-dev c8
```

Expected: `package.json` gains `devDependencies.c8`, and `package-lock.json` is updated. This command requires network access if `c8` is not already cached.

- [ ] **Step 3: Create deterministic coverage runner**

Create `tests/coverage/code-coverage-runner.test.ts`:

```ts
import "../index.test.ts";
import "../e2e-exceptions/index.test.ts";
```

- [ ] **Step 4: Add coverage script and ignore generated reports**

Modify `package.json` scripts and c8 config:

```json
{
  "scripts": {
    "test:coverage:code": "c8 node --disable-warning=ExperimentalWarning tests/coverage/code-coverage-runner.test.ts"
  },
  "c8": {
    "all": true,
    "include": [
      "src/runtime/**/*.ts",
      "src/adapters/**/*.ts",
      "src/cli/**/*.ts",
      "src/config/**/*.ts",
      "src/intake/**/*.ts",
      "src/types/**/*.ts"
    ],
    "exclude": [
      "tests/**",
      "coverage/**"
    ],
    "reporter": [
      "text",
      "json-summary",
      "lcov"
    ],
    "reports-dir": "coverage"
  }
}
```

Keep existing scripts unchanged and add only the new script/config keys. Do not add `--check-coverage` yet; thresholds are introduced in Task 4 after the command is proven wired.

Modify `.gitignore`:

```gitignore
node_modules/
npm-debug.log*
.DS_Store
coverage/
```

- [ ] **Step 5: Run GREEN for code coverage command shell**

Run:

```bash
npm run test:coverage:code
```

Expected: command exits 0, prints a c8 text report, and creates `coverage/coverage-summary.json` plus `coverage/lcov.info`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore tests/coverage/code-coverage-runner.test.ts
git commit -m "test: add code coverage command"
```

## Task 2: Add Requirement Coverage Parser

**Files:**
- Create: `tests/coverage/requirement-coverage.ts`
- Create: `tests/coverage/requirement-coverage.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/coverage/requirement-coverage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/coverage/requirement-coverage.test.ts
```

Expected: fail with module-not-found for `tests/coverage/requirement-coverage.ts`.

- [ ] **Step 3: Implement parser and metrics**

Create `tests/coverage/requirement-coverage.ts`:

```ts
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
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/coverage/requirement-coverage.test.ts
```

Expected: pass with `2` tests and a diagnostic containing `requirement_coverage_percent=100`.

- [ ] **Step 5: Commit**

```bash
git add tests/coverage/requirement-coverage.ts tests/coverage/requirement-coverage.test.ts
git commit -m "test: add requirement coverage checker"
```

## Task 3: Add Requirement Coverage Command And Combined Gate

**Files:**
- Modify: `package.json`
- Create: `tests/coverage/run-coverage-gates.ts`

- [ ] **Step 1: Run RED for missing requirement coverage script**

Run:

```bash
npm run test:coverage:requirements
```

Expected: fail with `Missing script: "test:coverage:requirements"`.

- [ ] **Step 2: Add failing combined gate runner test by running missing script**

Run:

```bash
npm run test:coverage
```

Expected: fail with `Missing script: "test:coverage"`.

- [ ] **Step 3: Create argv-array combined gate runner**

Create `tests/coverage/run-coverage-gates.ts`:

```ts
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const npmCommand = platform() === "win32" ? "npm.cmd" : "npm";

for (const script of ["test:coverage:requirements", "test:coverage:code"]) {
  const result = spawnSync(npmCommand, ["run", script], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
```

- [ ] **Step 4: Add coverage scripts**

Modify `package.json` scripts:

```json
{
  "scripts": {
    "test:coverage:requirements": "node --disable-warning=ExperimentalWarning tests/coverage/requirement-coverage.test.ts",
    "test:coverage": "node --disable-warning=ExperimentalWarning tests/coverage/run-coverage-gates.ts"
  }
}
```

Keep the existing `test:coverage:code` script from Task 1.

- [ ] **Step 5: Run GREEN for requirement coverage**

Run:

```bash
npm run test:coverage:requirements
```

Expected: pass with `2` tests and `requirement_coverage_unmapped=0`.

- [ ] **Step 6: Run GREEN for combined coverage command**

Run:

```bash
npm run test:coverage
```

Expected: requirement coverage passes first, then c8 code coverage passes and produces `coverage/coverage-summary.json`.

- [ ] **Step 7: Commit**

```bash
git add package.json tests/coverage/run-coverage-gates.ts
git commit -m "test: add combined coverage gate"
```

## Task 4: Enforce 85 Percent Code Coverage Thresholds

**Files:**
- Modify: `package.json`
- Create: `tests/coverage/coverage-config.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Write failing coverage config test**

Create `tests/coverage/coverage-config.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

test("coverage config scopes runtime control-plane sources with 85 percent thresholds", async () => {
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));

  assert.equal(packageJson.c8["check-coverage"], true);
  assert.equal(packageJson.c8.lines, 85);
  assert.equal(packageJson.c8.branches, 85);
  assert.equal(packageJson.c8.functions, 85);
  assert.equal(packageJson.c8.statements, 85);
  assert.deepEqual(packageJson.c8.include, [
    "src/runtime/**/*.ts",
    "src/adapters/**/*.ts",
    "src/cli/**/*.ts",
    "src/config/**/*.ts",
    "src/intake/**/*.ts",
    "src/types/**/*.ts",
  ]);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/coverage/coverage-config.test.ts
```

Expected: fail because `packageJson.c8["check-coverage"]` is not `true`.

- [ ] **Step 3: Add c8 thresholds**

Modify the `c8` config in `package.json`:

```json
{
  "c8": {
    "all": true,
    "include": [
      "src/runtime/**/*.ts",
      "src/adapters/**/*.ts",
      "src/cli/**/*.ts",
      "src/config/**/*.ts",
      "src/intake/**/*.ts",
      "src/types/**/*.ts"
    ],
    "exclude": [
      "tests/**",
      "coverage/**"
    ],
    "reporter": [
      "text",
      "json-summary",
      "lcov"
    ],
    "reports-dir": "coverage",
    "check-coverage": true,
    "lines": 85,
    "branches": 85,
    "functions": 85,
    "statements": 85
  }
}
```

- [ ] **Step 4: Include config test in unit suite**

Modify `tests/index.test.ts` and add this import near the spec tests:

```ts
import "./coverage/coverage-config.test.ts";
```

- [ ] **Step 5: Run GREEN for config test**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/coverage/coverage-config.test.ts
```

Expected: pass.

- [ ] **Step 6: Run coverage threshold gate**

Run:

```bash
npm run test:coverage:code
```

Expected: pass with lines, branches, functions, and statements all at or above `85%`.

If this command fails only because a core file is below threshold, inspect `coverage/coverage-summary.json`, identify the lowest uncovered runtime/control-plane file, and add focused tests for the missing behavior. Do not lower the thresholds. After adding focused tests, rerun this step until it passes and include those test files in this task's commit.

- [ ] **Step 7: Commit**

```bash
git add package.json tests/coverage/coverage-config.test.ts tests/index.test.ts
git commit -m "test: enforce formal code coverage thresholds"
```

## Task 5: Add Formal Coverage Tooling Matrix

**Files:**
- Create: `docs/superpowers/formal-coverage-tooling-coverage.md`
- Modify: `tests/spec/spec-compliance.test.ts`

- [ ] **Step 1: Add failing spec compliance test**

Add this test after the exception E2E coverage matrix test in `tests/spec/spec-compliance.test.ts`:

```ts
test("formal coverage tooling matrix maps code and requirement coverage gates", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/formal-coverage-tooling-coverage.md"), "utf8");
  for (const required of [
    "Code coverage gate",
    "Requirement coverage gate",
    "npm run test:coverage",
    "npm run test:coverage:code",
    "npm run test:coverage:requirements",
    "coverage-summary.json",
    "requirement_coverage_percent",
    "tests/coverage/code-coverage-runner.test.ts",
    "tests/coverage/requirement-coverage.test.ts",
    "tests/coverage/requirement-coverage.ts",
    "tests/coverage/run-coverage-gates.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test
```

Expected: fail with missing `docs/superpowers/formal-coverage-tooling-coverage.md`.

- [ ] **Step 3: Add formal coverage tooling matrix**

Create `docs/superpowers/formal-coverage-tooling-coverage.md`:

```md
# Northstar Formal Coverage Tooling Coverage Matrix

| Requirement | Test File | Implementation File |
| --- | --- | --- |
| Code coverage gate uses c8 over runtime/control-plane core source and emits `coverage-summary.json`. | `tests/coverage/coverage-config.test.ts`, `tests/coverage/code-coverage-runner.test.ts` | `package.json`, `tests/coverage/code-coverage-runner.test.ts` |
| Requirement coverage gate maps documented AC and EX requirements to tests and implementation files. | `tests/coverage/requirement-coverage.test.ts` | `tests/coverage/requirement-coverage.ts`, `docs/superpowers/full-ac-coverage.md`, `docs/superpowers/exception-e2e-coverage.md` |
| Combined coverage gate runs requirement coverage and code coverage without shell-chain package scripts. | `tests/coverage/requirement-coverage.test.ts`, `tests/coverage/coverage-config.test.ts` | `tests/coverage/run-coverage-gates.ts`, `package.json` |
| Coverage reports are generated locally and ignored by git. | `tests/coverage/coverage-config.test.ts` | `.gitignore`, `package.json` |

## Commands

- `npm run test:coverage`
- `npm run test:coverage:code`
- `npm run test:coverage:requirements`

## Quantified Gates

- Code coverage threshold: lines, branches, functions, statements each `>=85`.
- Requirement coverage summary includes `requirement_coverage_percent`.
- Required result: `requirement_coverage_unmapped=0`.
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm test
```

Expected: pass, including the new formal coverage tooling matrix test.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/formal-coverage-tooling-coverage.md tests/spec/spec-compliance.test.ts
git commit -m "docs: map formal coverage tooling"
```

## Task 6: Final Verification Gate

**Files:**
- No planned file changes unless verification exposes a real coverage gap.

- [ ] **Step 1: Run deterministic verification**

Run:

```bash
npm test
npm run test:e2e
npm run test:e2e:daemon
npm run test:e2e:exceptions
npm run test:coverage
```

Expected:

- `npm test`: all tests pass.
- `npm run test:e2e`: all tests pass.
- `npm run test:e2e:daemon`: all tests pass.
- `npm run test:e2e:exceptions`: pass and print `exception_e2e_requirement_coverage_percent=100`.
- `npm run test:coverage`: requirement coverage prints `requirement_coverage_percent=100`, and c8 thresholds pass at `>=85`.

- [ ] **Step 2: Run forbidden dependency scans**

Run:

```bash
rg "/home/timmypai/apps/autodev/scripts|autodev/scripts|\\.py" src tests
rg "process\\.env\\." src
rg "commandSpec\\([^\\n]*(?:&&|\\|\\||;)|spawn\\([^\\n]*(?:&&|\\|\\||;)|execFile\\([^\\n]*(?:&&|\\|\\||;)" src
```

Expected: each `rg` exits 1 with no matches.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status --short
```

Expected: clean after all task commits, except generated `coverage/` files ignored by git.

- [ ] **Step 4: Final commit only if verification required changes**

If final verification exposed and fixed a real coverage gap, commit the focused fix:

```bash
git add package.json package-lock.json tests/coverage tests/index.test.ts tests/spec/spec-compliance.test.ts docs/superpowers/formal-coverage-tooling-coverage.md .gitignore
git commit -m "test: complete formal coverage tooling"
```

## Goal Prompt

Use this prompt to execute the plan:

```text
/goal
使用 Superpowers executing-plans 執行 docs/superpowers/plans/2026-05-29-northstar-formal-coverage-tooling-plan.md。

完成 Northstar Formal Coverage Tooling：
- c8 code coverage gate scoped to runtime/control-plane core
- formal requirement coverage gate for AC/EX coverage matrices
- combined `npm run test:coverage`
- deterministic coverage verification, no live credentials or network required except dependency install if c8 is missing

依據：
- docs/superpowers/specs/2026-05-29-northstar-formal-coverage-tooling-design.md
- docs/superpowers/exception-e2e-coverage.md
- docs/superpowers/full-ac-coverage.md
- package.json

執行規則：
1. 使用 Superpowers：executing-plans、test-driven-development、systematic-debugging、verification-before-completion。
2. 逐 task TDD 執行；每個未覆蓋行為先寫 failing test，確認 RED，再最小實作轉 GREEN。
3. 安裝 `c8` 若需要 network，必須使用 escalation/approval。
4. `npm run test:coverage` 不得依賴 GitHub token、OpenCode/Codex credentials、live flags、host CLIs。
5. Code coverage scope 只包含 runtime/control-plane core：`src/runtime`, `src/adapters`, `src/cli`, `src/config`, `src/intake`, `src/types`。
6. Coverage thresholds 必須是 lines/branches/functions/statements `>=85%`；若失敗，使用 systematic-debugging 找出真實 uncovered behavior 並補 focused tests，不可降低門檻。
7. Requirement coverage 必須輸出 `requirement_coverage_total`, `requirement_coverage_mapped`, `requirement_coverage_percent`, `requirement_coverage_unmapped`。
8. 完成前執行 plan 內 Final Verification Gate。

最後回報：
- code coverage summary
- requirement coverage summary
- RED -> GREEN evidence
- fresh verification output summary
- 修改檔案摘要
- deferred live exception E2E
```

## Self-Review Notes

- Spec coverage: Tasks cover c8 install, code coverage command, runtime/control-plane scope, 85% thresholds, requirement coverage metrics, combined gate, coverage docs, and final verification.
- Scope: live exception E2E is intentionally deferred and not implemented by this plan.
- Type consistency: `RequirementCoverageMetrics`, `RequirementCoverageResult`, `CoverageMatrixSpec`, `analyzeRequirementCoverage`, and `formatRequirementCoverageSummary` are defined before use.
- Shell-chain avoidance: `npm run test:coverage` uses `tests/coverage/run-coverage-gates.ts` with argv arrays instead of `&&` in the package script.

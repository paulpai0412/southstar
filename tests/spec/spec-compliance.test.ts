import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

test("suggested runtime source files exist", async () => {
  const requiredFiles = [
    "src/runtime/events.ts",
    "src/runtime/effects.ts",
    "src/runtime/policy.ts",
    "src/adapters/host/opencode.ts",
    "src/adapters/host/codex.ts",
  ];

  for (const file of requiredFiles) {
    await access(join(repoRoot, file));
  }
});

test("runtime specs and contracts document exception lifecycle and agent-owned release", async () => {
  const claude = await readFile(join(repoRoot, "CLAUDE.md"), "utf8");
  const runtimeSpec = await readFile(join(repoRoot, "docs/specs/2026-05-29-northstar-clean-slate-runtime-design.md"), "utf8");
  const exceptionPolicySource = await readFile(join(repoRoot, "src/runtime/exception-policy.ts"), "utf8");
  const contractSource = await readFile(join(repoRoot, "src/orchestrator/software-dev-contract.ts"), "utf8");

  assert.match(
    claude,
    /ready, claimed, running, verifying, verified, release_pending, exception, completed, cancelled, failed, quarantined/,
  );
  assert.match(runtimeSpec, /release_result status=completed/);
  assert.match(runtimeSpec, /release\.confirmed=true/);
  assert.match(exceptionPolicySource, /resolveExceptionPolicy/);
  assert.match(contractSource, /git_is_agent_owned/);
});

test("production source does not construct shell-chain runtime commands", async () => {
  const violations: string[] = [];
  for (const file of await listSourceFiles(join(repoRoot, "src"))) {
    const content = await readFile(file, "utf8");
    const hasShellChainLiteral = content
      .split(/\r?\n/)
      .some((line) => line.includes("commandSpec(") && /["'`][^"'`]*(?:&&|\|\||;)[^"'`]*["'`]/.test(line));
    if (hasShellChainLiteral) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});

test("production source avoids host-specific absolute path literals", async () => {
  const forbiddenPatterns = [/\/home\/timmypai\/apps\/northstar/, /\/tmp\/northstar/, /\/bin\/sh/, /\.sh\b/];
  const violations: string[] = [];
  for (const file of await listSourceFiles(join(repoRoot, "src"))) {
    const content = await readFile(file, "utf8");
    if (forbiddenPatterns.some((pattern) => pattern.test(content))) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});

test("host adapters are SDK-first and do not shell out to host CLIs", async () => {
  const opencode = await readFile(join(repoRoot, "src/adapters/host/opencode.ts"), "utf8");
  const codex = await readFile(join(repoRoot, "src/adapters/host/codex.ts"), "utf8");

  assert.doesNotMatch(opencode, /execFile|spawn|commandSpec|opencode\s/);
  assert.doesNotMatch(codex, /execFile|spawn|commandSpec|codex\s/);
  assert.match(opencode, /sdk/);
  assert.match(codex, /sdk/);
});

test("runtime core coverage matrix maps scoped acceptance criteria", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/runtime-core-coverage.md"), "utf8");

  for (const acceptanceCriterion of ["AC-04", "AC-06", "AC-07", "AC-08", "AC-10"]) {
    assert.match(matrix, new RegExp(`\\| ${acceptanceCriterion} `));
  }
  assert.match(matrix, /tests\/runtime\/state-machine\.test\.ts/);
  assert.match(matrix, /src\/runtime\/state-machine\.ts/);
});

test("state machine tests include at least 25 transition and event cases", async () => {
  const content = await readFile(join(repoRoot, "tests/runtime/state-machine.test.ts"), "utf8");
  const transitionCaseBlock = content.match(/const transitionCases = \[([\s\S]+?)\];/);
  assert.ok(transitionCaseBlock, "transitionCases table should exist");

  const transitionCaseCount = [...transitionCaseBlock[1].matchAll(/\n\s+name: /g)].length;
  assert.ok(transitionCaseCount >= 25, `expected at least 25 state-machine cases, got ${transitionCaseCount}`);
});

test("persistence engine coverage matrix maps scoped acceptance criteria", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/persistence-engine-coverage.md"), "utf8");

  for (const phrase of [
    "AC-03",
    "Runtime Engine",
    "Store",
    "tests/runtime/store.test.ts",
    "tests/runtime/engine-cycle.test.ts",
    "src/runtime/store.ts",
    "src/runtime/engine.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(phrase)));
  }
});

test("cli adapters coverage matrix maps scoped acceptance criteria", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/cli-adapters-coverage.md"), "utf8");

  for (const phrase of [
    "CLI Surface",
    "Host adapters",
    "GitHub projection adapter",
    "Git/worktree adapter",
    "Platform adapters",
    "tests/cli/cli.test.ts",
    "tests/adapters/adapters.test.ts",
    "src/cli/northstar.ts",
    "src/adapters/host/opencode.ts",
    "src/adapters/host/codex.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(phrase)));
  }
});

test("live integrations packaging coverage matrix maps scoped requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/live-integrations-packaging-coverage.md"), "utf8");

  for (const phrase of [
    "CLI binary packaging",
    "OpenCode SDK wiring",
    "Codex SDK wiring",
    "GitHub remote integration",
    "Live test separation",
    "tests/live/host-sdk-live.test.ts",
    "tests/live/github-live.test.ts",
    "src/adapters/host/sdk-loaders.ts",
    "src/adapters/github/remote.ts",
    "src/cli/entrypoint.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(phrase)));
  }
});

test("live e2e coverage matrix maps live GitHub and SDK requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/live-e2e-coverage.md"), "utf8");
  for (const required of [
    "GitHub temporary issue",
    "GitHub Project v2 sync",
    "GitHub retryable projection failure",
    "OpenCode SDK root and child run",
    "Codex SDK root and child run",
    "tests/e2e-live/github-live-e2e.test.ts",
    "tests/e2e-live/host-sdk-live-e2e.test.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

test("full live workflow e2e coverage matrix maps quantified scenarios", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/full-live-workflow-e2e-coverage.md"), "utf8");
  for (const required of [
    "Single issue",
    "Two issues sequential",
    "Two issues parallel",
    "Suite total",
    "full_live_total_issues_created",
    "tests/e2e-full-live/single-issue-full-live.test.ts",
    "tests/e2e-full-live/sequential-issues-full-live.test.ts",
    "tests/e2e-full-live/parallel-issues-full-live.test.ts",
    "tests/e2e-full-live/suite-total-full-live.test.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

test("exception e2e coverage matrix maps quantified exception requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/exception-e2e-coverage.md"), "utf8");
  for (const required of [
    "EX-01",
    "EX-02",
    "EX-03",
    "EX-04",
    "EX-05",
    "EX-06",
    "EX-07",
    "EX-08",
    "EX-09",
    "EX-10",
    "EX-11",
    "EX-12",
    "EX-13",
    "EX-14",
    "exception_e2e_requirement_coverage_percent",
    "tests/e2e-exceptions/exception-e2e.test.ts",
    "tests/e2e-exceptions/harness.ts",
    "tests/e2e-exceptions/metrics.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

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

test("daemon e2e coverage matrix maps daemon supervision requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/daemon-e2e-coverage.md"), "utf8");
  for (const required of [
    "Daemon process supervision",
    "SQLite reconstruction",
    "SIGTERM handling",
    "Writer lock collision",
    "Compact safe logs",
    "tests/e2e-daemon/daemon-e2e.test.ts",
    "tests/e2e-daemon/harness.ts",
    "src/cli/watch-command.ts",
    "src/runtime/watch-lock.ts",
    "src/runtime/watch-logger.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

test("full live exception e2e coverage matrix maps FLX requirements and quantified metrics", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/full-live-exception-e2e-coverage.md"), "utf8");
  for (const required of [
    "FLX-01",
    "FLX-02",
    "FLX-03",
    "FLX-04",
    "FLX-05",
    "FLX-06",
    "FLX-07",
    "FLX-08",
    "FLX-09",
    "FLX-10",
    "FLX-11",
    "FLX-12",
    "FLX-13",
    "FLX-14",
    "FLX-15",
    "FLX-16",
    "FLX-17",
    "FLX-18",
    "EX-01",
    "EX-14",
    "full_live_exception_requirement_coverage_percent",
    "tests/e2e-full-live-exceptions/github-exceptions.test.ts",
    "tests/e2e-full-live-exceptions/codex-exceptions.test.ts",
    "tests/e2e-full-live-exceptions/recovery-exceptions.test.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

test("opencode full live e2e coverage matrix maps happy path and OCX requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/opencode-full-live-e2e-coverage.md"), "utf8");
  for (const id of ["OCX-01", "OCX-02", "OCX-03", "OCX-04", "OCX-05", "OCX-06", "OCX-07", "OCX-08", "OCX-09", "OCX-10", "OCX-11", "OCX-12", "OCX-13", "OCX-14"]) {
    assert.match(matrix, new RegExp(`\\| \`${id}\` \\|`), `${id} should be mapped`);
  }
  for (const file of [
    "tests/e2e-full-live-opencode/opencode-full-live.test.ts",
    "tests/e2e-full-live-opencode/opencode-exceptions.test.ts",
    "tests/e2e-full-live-opencode/harness.ts",
    "tests/e2e-full-live-opencode/opencode-worker.ts",
    "tests/e2e-full-live-opencode/metrics.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(file)), `${file} should be referenced`);
  }
});

test("production orchestrator coverage matrix maps quantified production requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/production-orchestrator-coverage.md"), "utf8");
  for (const required of [
    "Manual CLI",
    "Watch daemon",
    "Dependency scheduling",
    "Workflow generality",
    "Recovery metrics",
    "Production live",
    "production_orchestrator_requirement_coverage_percent",
    "tests/orchestrator/orchestrator-cli.test.ts",
    "tests/orchestrator/watch-orchestrator.test.ts",
    "tests/orchestrator/workflow-generality.test.ts",
    "tests/e2e-production-live/production-live.test.ts",
    "src/orchestrator/cycle.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

test("domain driver registry coverage matrix maps registry and software-dev requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/domain-driver-registry-coverage.md"), "utf8");
  for (const required of [
    "Domain registry",
    "Deferred domains",
    "Production SoftwareDevDriver",
    "Production CLI/watch",
    "Production-live E2E",
    "tests/orchestrator/domain-registry.test.ts",
    "tests/orchestrator/software-dev-driver.test.ts",
    "tests/orchestrator/production-factory.test.ts",
    "tests/e2e-production-live/production-live.test.ts",
    "src/orchestrator/domain-registry.ts",
    "src/orchestrator/software-dev-driver.ts",
    "src/orchestrator/production-factory.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(required)));
  }
});

test("northstar global skill coverage matrix maps skill requirements", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/northstar-global-skill-coverage.md"), "utf8");
  for (const requirement of [
    "Bootstrap config draft requires confirmation",
    "Global sync overwrites target",
    "Doctor reports platform, SQLite, git, gh, CLI, SDK",
    "Project setup requires confirmation and defines fields/views",
    "Operator issue commands map to argv arrays",
    "Recovery scenarios and risk gates",
    "Linux/macOS/Windows path fixtures and no Unix-only hardcoding",
    "Skill source instructions exist",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(requirement)));
  }
});

test("full coverage matrix maps AC-01 through AC-23", async () => {
  const matrix = await readFile(join(repoRoot, "docs/superpowers/full-ac-coverage.md"), "utf8");
  for (let ac = 1; ac <= 23; ac += 1) {
    const id = `AC-${String(ac).padStart(2, "0")}`;
    assert.match(matrix, new RegExp(`\\| ${id} `), `${id} should be mapped`);
  }
  for (const phrase of [
    "tests/workflow/workflow-validation.test.ts",
    "tests/runtime/artifacts.test.ts",
    "tests/intake/intake.test.ts",
    "tests/runtime/watch.test.ts",
    "tests/runtime/security.test.ts",
    "tests/cli/packaging.test.ts",
    "tests/workflow/domain-workflow.test.ts",
  ]) {
    assert.match(matrix, new RegExp(escapeRegExp(phrase)));
  }
});

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

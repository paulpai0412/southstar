import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { loadConfig } from "../../src/config/load-config.ts";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";
import { createDefaultDomainDriverRegistry } from "../../src/orchestrator/domain-registry.ts";
import { createProductionOrchestratorFromFactory } from "../../src/orchestrator/production-factory.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

test("production factory resolves domain driver through registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-production-factory-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new FakeDomainDriver(),
  });
  try {
    const built = createProductionOrchestratorFromFactory({
      config,
      store,
      host: new FakeHostAdapter(),
      registry,
      workflowPath: "tests/fixtures/workflows/issue-to-pr-release.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
    });

    await built.orchestrator.intakeIssue({
      issueNumber: 303,
      title: "Factory smoke",
      body: "Body",
      sourceUrl: "https://github.test/issues/303",
      labels: ["northstar:ready"],
    });
    await built.orchestrator.startIssue({ issueId: "github:303" });

    assert.equal(built.metrics.production_cli_uses_registry, 1);
    assert.equal(registry.metrics().domain_registry_software_dev_resolved, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production CLI and watch source route through registry instead of FakeDomainDriver", async () => {
  const [entrypoint, watch] = await Promise.all([
    readFile("src/cli/entrypoint.ts", "utf8"),
    readFile("src/cli/watch-command.ts", "utf8"),
  ]);

  assert.equal(/new\s+FakeDomainDriver/.test(entrypoint), false);
  assert.equal(/new\s+FakeDomainDriver/.test(watch), false);
  assert.match(entrypoint, /createProductionOrchestratorFromDefaultFactory/);
  assert.match(watch, /createProductionOrchestratorFromDefaultFactory/);
});

test("production factory resolves workflow.path relative to consumer project root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-consumer-workflow-"));
  const workflowDir = join(dir, ".northstar/workflows");
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  let resolvedWorkflowId = "";
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: ({ workflow }) => {
      resolvedWorkflowId = workflow.id;
      return new FakeDomainDriver();
    },
  });
  try {
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "custom.yaml"),
      (await readFile("tests/fixtures/workflows/issue-to-pr-release.yaml", "utf8")).replace(
        "id: issue_to_pr_release",
        "id: consumer_custom_flow",
      ),
    );

    createProductionOrchestratorFromFactory({
      config: {
        ...config,
        project: { ...config.project, root: dir },
        workflow: { ...config.workflow, path: ".northstar/workflows/custom.yaml" },
      },
      store,
      host: new FakeHostAdapter(),
      registry,
      now: () => "2026-05-30T00:00:00.000Z",
    });

    assert.equal(resolvedWorkflowId, "consumer_custom_flow");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("production factory resolves builtin workflow package-relative when northstar cwd is not consumer repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-package-workflow-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  const config = loadConfig("tests/fixtures/.northstar.yaml");
  const originalCwd = process.cwd();
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new FakeDomainDriver(),
  });
  try {
    process.chdir(dir);
    const built = createProductionOrchestratorFromFactory({
      config: {
        ...config,
        project: { ...config.project, root: dir },
        workflow: { ...config.workflow, path: undefined },
      },
      store,
      host: new FakeHostAdapter(),
      registry,
      now: () => "2026-05-30T00:00:00.000Z",
    });

    assert.equal(built.metrics.production_cli_uses_registry, 1);
    assert.equal(registry.metrics().domain_registry_software_dev_resolved, 1);
  } finally {
    process.chdir(originalCwd);
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

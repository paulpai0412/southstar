import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";
import { createProductionOrchestrator, scanForHardcodedDevWorkflowChain } from "../../src/orchestrator/cycle.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

test("orchestrator starts the first stage from non-software workflows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-workflow-generality-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite"));
  try {
    const orchestrator = createProductionOrchestrator({
      store,
      host: new FakeHostAdapter(),
      domain: new FakeDomainDriver(),
      workflowPath: "tests/fixtures/workflows/content-creation-publish.yaml",
      now: () => "2026-05-30T00:00:00.000Z",
      leaseTimeoutSeconds: 600,
      roleOverrides: {},
    });

    await orchestrator.intakeIssue({
      issueNumber: 201,
      title: "Draft content packet",
      body: "---\ndepends_on: []\npriority: 1\n---\nCreate a post",
      sourceUrl: "https://github.test/issues/201",
      labels: ["northstar:ready"],
    });

    const snapshot = await orchestrator.startIssue({ issueId: "github:201" });

    assert.equal(snapshot.lifecycle_state, "running");
    assert.equal(snapshot.runtime_context_json.stage_cursor, "draft");
    assert.equal(snapshot.runtime_context_json.owner_lease?.role, "writer");
    assert.equal(snapshot.runtime_context_json.child_runs?.[0]?.role, "writer");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("orchestrator source has no hard-coded development role chain or release merge coupling", async () => {
  const scan = await scanForHardcodedDevWorkflowChain("src/orchestrator");

  assert.equal(scan.workflow_generality_hardcoded_role_chain_matches, 0);
  assert.equal(scan.workflow_generality_hardcoded_release_merge_matches, 0);
});

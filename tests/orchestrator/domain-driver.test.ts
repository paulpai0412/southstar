import test from "node:test";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { FakeDomainDriver } from "../../src/orchestrator/domain-driver.ts";

test("fake domain driver records software-dev PR release operations", async () => {
  const driver = new FakeDomainDriver();
  const prepared = await driver.prepareStage({
    issue: {
      id: "github:1",
      number: 1,
      title: "Fake issue",
      body: "Fake body",
      sourceUrl: "https://github.test/issues/1",
    },
    workflow: {
      id: "issue_to_pr_release",
      domain: "software_development",
    },
    stage: {
      name: "implementation",
    },
    role: {
      name: "issue_worker",
      definition: {
        run_mode: "background_child",
        agent: "build",
        load_skills: [],
        timeout_seconds: 60,
      },
    },
    runtimeContext: {},
  });
  const pr = await driver.finalizeWorkerArtifact({
    issue: {
      id: "github:1",
      number: 1,
      title: "Fake issue",
      body: "Fake body",
      sourceUrl: "https://github.test/issues/1",
    },
    workflow: {
      id: "issue_to_pr_release",
      domain: "software_development",
    },
    stage: {
      name: "implementation",
    },
    role: {
      name: "issue_worker",
      definition: {
        run_mode: "background_child",
        agent: "build",
        load_skills: [],
        timeout_seconds: 60,
      },
    },
    runtimeContext: {},
    branch: prepared.branch,
    changedFiles: ["src/example.ts"],
  });
  const release = await driver.releaseVerifiedItem({
    issue: {
      id: "github:1",
      number: 1,
      title: "Fake issue",
      body: "Fake body",
      sourceUrl: "https://github.test/issues/1",
    },
    workflow: {
      id: "issue_to_pr_release",
      domain: "software_development",
    },
    stage: {
      name: "release",
    },
    role: {
      name: "release_worker",
      definition: {
        run_mode: "background_child",
        agent: "release",
        load_skills: [],
        timeout_seconds: 60,
      },
    },
    runtimeContext: {},
    releaseMetadata: pr,
  });

  assert.equal(basename(prepared.worktreePath), "github-1");
  assert.equal(pr.prNumber, 1);
  assert.equal(release.confirmed, true);
  assert.equal(driver.metrics.domain_driver_dispatches, 3);
});

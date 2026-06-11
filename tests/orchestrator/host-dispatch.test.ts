import test from "node:test";
import assert from "node:assert/strict";
import { FakeHostAdapter } from "../../src/adapters/host/fake.ts";
import { dispatchStageRoot } from "../../src/orchestrator/host-dispatch.ts";
import { loadWorkflow } from "../../src/types/workflow.ts";

const workflow = loadWorkflow("tests/fixtures/workflows/issue-to-pr-release.yaml");

test("dispatches current stage role with stage_root binding", () => {
  const host = new FakeHostAdapter();
  const result = dispatchStageRoot({
    host,
    workflow,
    issueId: "github:42",
    stageName: "implementation",
    leaseId: "lease-42",
    roleOverrides: {
      implementation_agent: {
        agent: "build",
        model: "gpt-5.3",
        load_skills: ["tdd", "playwright"],
        run_mode: "background_child",
        timeout_seconds: 3600,
      },
    },
  });

  assert.equal(result.roleName, "implementation_agent");
  assert.equal(result.rootSessionId, "fake-root-github:42-implementation_agent");
  assert.equal(result.childRun.root_session_id, "fake-root-github:42-implementation_agent");
  assert.equal(result.childRun.lease_id, "lease-42");
  assert.equal(result.childRun.role, "implementation_agent");
  assert.equal(result.childRun.agent, "build");
});

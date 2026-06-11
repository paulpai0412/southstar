import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lifecycleStates } from "../../src/types/control-plane.ts";
import { loadWorkflow, validateWorkflow, WorkflowValidationError } from "../../src/types/workflow.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");

test("content creation workflow validates with domain-specific metadata and fixed lifecycle states", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/content-creation-publish.yaml"));

  assert.equal(workflow.id, "content_creation_publish");
  assert.equal(workflow.domain, "content_creation");
  assert.deepEqual(Object.keys(workflow.artifact_schemas ?? {}).sort(), [
    "approval_packet",
    "draft_article",
    "editorial_packet",
    "publish_result",
  ]);
  assert.deepEqual(Object.keys(workflow.effects ?? {}).sort(), ["publish_content", "sync_content_calendar"]);
  assert.deepEqual(Object.keys(workflow.projection_targets ?? {}).sort(), ["content_calendar", "editorial_dashboard"]);

  for (const stage of Object.values(workflow.stages)) {
    assert.ok(lifecycleStates.includes(stage.lifecycle_state), stage.lifecycle_state);
  }
});

test("office report workflow validates without coding role names or GitHub/Git artifacts", () => {
  const workflow = loadWorkflow(join(repoRoot, "tests/fixtures/workflows/office-report-delivery.yaml"));

  assert.equal(workflow.id, "office_report_delivery");
  assert.equal(workflow.domain, "office_automation");
  assert.deepEqual(Object.keys(workflow.artifact_schemas ?? {}).sort(), [
    "approval_packet",
    "email_delivery_result",
    "review_packet",
    "spreadsheet_report",
  ]);
  assert.equal(Object.keys(workflow.roles).includes("issue_worker"), false);
  assert.equal(Object.keys(workflow.roles).includes("pr_verifier"), false);
  assert.equal(Object.keys(workflow.roles).includes("release_worker"), false);
});

test("workflow validation rejects domain-specific lifecycle states", () => {
  assert.throws(
    () => validateWorkflow({
      id: "invalid_domain_state",
      version: "1.0",
      domain: "content_creation",
      artifact_schemas: {
        draft_article: { required_fields: ["summary"] },
      },
      roles: {
        writer: {
          run_mode: "background_child",
          agent: "writer",
          load_skills: ["drafting"],
          artifact: "draft_article",
          timeout_seconds: 600,
        },
      },
      stages: {
        draft: {
          lifecycle_state: "drafting",
          role: "writer",
          on_success: "completed",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.equal(error.code, "WORKFLOW_UNKNOWN_LIFECYCLE_STATE");
      assert.equal(error.path, "workflow.stages.draft.lifecycle_state");
      return true;
    },
  );
});

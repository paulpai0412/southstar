import assert from "node:assert/strict";
import test from "node:test";

const projectModule = "../../skills/northstar/scripts/lib/project-viewer.mjs";

test("northstar skill defines project fields and views for progress monitoring", async () => {
  const { northstarProjectFields, northstarProjectViews, projectSetupPlan } = await import(projectModule);

  assert.equal(northstarProjectFields.length >= 8, true);
  assert.equal(northstarProjectViews.length >= 5, true);
  assert.ok(northstarProjectFields.some((field) => field.name === "Northstar Lifecycle" && field.type === "single_select"));
  assert.ok(northstarProjectFields.some((field) => field.name === "Status" && field.type === "single_select"));
  assert.ok(northstarProjectFields.some((field) => field.name === "PR URL"));
  assert.ok(northstarProjectFields.some((field) => field.name === "Merge SHA"));
  assert.ok(northstarProjectViews.some((view) => view.name === "Northstar Board" && view.layout === "board" && view.groupBy === "Status"));
  assert.ok(northstarProjectViews.some((view) => view.name === "Active Runs"));
  assert.ok(northstarProjectViews.some((view) => view.name === "Blocked Recovery"));
  assert.ok(northstarProjectViews.some((view) => view.name === "Release Evidence"));

  const plan = projectSetupPlan({ mode: "create_new", confirmed: false });
  assert.equal(plan.skill_project_setup_requires_confirmation, 1);
  assert.equal(plan.canMutate, false);
  assert.equal(plan.skill_project_fields_defined, northstarProjectFields.length);
  assert.equal(plan.skill_project_views_defined, northstarProjectViews.length);
  assert.deepEqual(plan.fieldRepairPlan.map((item) => item.name), northstarProjectFields.map((field) => field.name));
  assert.deepEqual(plan.viewRepairPlan.map((item) => item.name), northstarProjectViews.map((view) => view.name));
  assert.equal(plan.browserFallback.requiredWhenApiUnavailable, true);
  assert.equal(plan.browserFallback.verificationGate, "browser_verification");
});

test("northstar project viewer includes exact monitoring fields from product hardening plan", async () => {
  const { northstarProjectFields, northstarProjectViews } = await import(projectModule);
  const fieldsByName = new Map(northstarProjectFields.map((field) => [field.name, field]));

  assert.deepEqual(fieldsByName.get("Northstar Lifecycle"), {
    name: "Northstar Lifecycle",
    type: "single_select",
    options: ["ready", "running", "verifying", "verified", "release_pending", "completed", "cancelled", "failed", "quarantined"],
  });
  assert.deepEqual(fieldsByName.get("Status"), {
    name: "Status",
    type: "single_select",
    options: ["Todo", "In Progress", "In Review", "Ready to Release", "Releasing", "Done", "Cancelled", "Failed", "Blocked"],
  });

  for (const [name, type] of [
    ["PR URL", "text"],
    ["Merge SHA", "text"],
    ["Current Stage", "text"],
    ["Last Error", "text"],
    ["Retry Count", "number"],
    ["Blocked By", "text"],
  ]) {
    assert.deepEqual(fieldsByName.get(name), { name, type });
  }

  const releaseEvidence = northstarProjectViews.find((view) => view.name === "Release Evidence");
  assert.deepEqual(releaseEvidence?.fields, ["PR URL", "Merge SHA"]);
});

test("northstar project setup can mutate only after confirmation", async () => {
  const { projectSetupPlan } = await import(projectModule);

  assert.equal(projectSetupPlan({ mode: "none", confirmed: false }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "none", confirmed: true }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "existing", confirmed: false }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "existing", confirmed: "false" }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "existing", confirmed: "0" }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "existing", confirmed: true }).canMutate, true);
  assert.equal(projectSetupPlan({ mode: "create_new", confirmed: false }).canMutate, false);
  assert.equal(projectSetupPlan({ mode: "create_new", confirmed: true }).canMutate, true);
});

test("northstar project views reference defined project fields and options", async () => {
  const { northstarProjectFields, northstarProjectViews } = await import(projectModule);
  const fieldsByName = new Map(northstarProjectFields.map((field) => [field.name, field]));

  for (const view of northstarProjectViews) {
    if (view.groupBy) {
      assert.ok(fieldsByName.has(view.groupBy), `${view.name} groupBy references undefined field ${view.groupBy}`);
    }

    if (view.sortBy) {
      const sortField = view.sortBy.replace(/\s+(?:asc|desc)$/i, "");
      assert.ok(fieldsByName.has(sortField), `${view.name} sortBy references undefined field ${sortField}`);
    }

    if (view.filter) {
      const [filterField, values = ""] = view.filter.split(":");
      const field = fieldsByName.get(filterField);
      assert.ok(field, `${view.name} filter references undefined field ${filterField}`);

      if (field?.options) {
        for (const value of values.split(",").filter(Boolean)) {
          assert.ok(field.options.includes(value), `${view.name} filter references undefined ${filterField} option ${value}`);
        }
      }
    }
  }
});

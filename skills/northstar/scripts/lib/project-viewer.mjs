export const northstarProjectFields = [
  {
    name: "Northstar Lifecycle",
    type: "single_select",
    options: ["ready", "running", "verifying", "verified", "release_pending", "completed", "cancelled", "failed", "quarantined"],
  },
  {
    name: "Status",
    type: "single_select",
    options: ["Todo", "In Progress", "In Review", "Ready to Release", "Releasing", "Done", "Cancelled", "Failed", "Blocked"],
  },
  {
    name: "PR URL",
    type: "text",
  },
  {
    name: "Merge SHA",
    type: "text",
  },
  {
    name: "Current Stage",
    type: "text",
  },
  {
    name: "Last Error",
    type: "text",
  },
  {
    name: "Retry Count",
    type: "number",
  },
  {
    name: "Blocked By",
    type: "text",
  },
];

export const northstarProjectViews = [
  {
    name: "Northstar Board",
    layout: "board",
    groupBy: "Status",
  },
  {
    name: "Active Runs",
    layout: "table",
    filter: "Status:In Progress,In Review,Ready to Release,Releasing",
  },
  {
    name: "Blocked Recovery",
    layout: "table",
    filter: "Status:Blocked,Failed",
  },
  {
    name: "Release Evidence",
    layout: "table",
    fields: ["PR URL", "Merge SHA"],
  },
  {
    name: "Completed",
    layout: "table",
    filter: "Status:Done",
  },
];

export function projectSetupPlan({ mode, confirmed }) {
  const wantsMutation = mode === "existing" || mode === "create_new";
  const fieldRepairPlan = northstarProjectFields.map((field) => ({
    action: "ensure_field",
    ...field,
  }));
  const viewRepairPlan = northstarProjectViews.map((view) => ({
    action: "ensure_view",
    ...view,
  }));

  return {
    mode,
    canMutate: wantsMutation && confirmed === true,
    fieldRepairPlan,
    viewRepairPlan,
    browserFallback: {
      requiredWhenApiUnavailable: true,
      verificationGate: "browser_verification",
      instructions: "Use Chrome automation to create or verify Project fields and views when GitHub Project APIs cannot mutate views.",
    },
    skill_project_setup_requires_confirmation: 1,
    skill_project_fields_defined: northstarProjectFields.length,
    skill_project_views_defined: northstarProjectViews.length,
  };
}

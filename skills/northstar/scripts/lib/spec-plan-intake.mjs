export const APPLY_REQUIRES_CONFIRMATION_ERROR = "NORTHSTAR_SPEC_PLAN_APPLY_REQUIRES_CONFIRMATION";
export const DEPENDENCY_CYCLE_ERROR = "NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE";
export const SECRET_LEAK_DETECTED_ERROR = "NORTHSTAR_SPEC_PLAN_SECRET_LEAK_DETECTED";
export const INVALID_INPUT_ERROR = "NORTHSTAR_SPEC_PLAN_INPUT_INVALID";

const allowedModes = new Set(["dry-run", "apply"]);
const toIssuesSkillLineage = Object.freeze(["northstar:issue-slicing"]);
const toIssuesContract = Object.freeze({
  usesTracerBulletVerticalSlices: true,
  avoidsHorizontalLayerSlicing: true,
  asksApprovalBeforeCreation: true,
  classifiesAfkOrHitl: true,
});
const sectionNames = Object.freeze([
  "Objective",
  "Scope",
  "Acceptance Criteria",
  "Quantitative Metrics",
  "Required Tests",
]);
const secretPatterns = Object.freeze([
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
]);

export function generateIssueDraftsFromSpecPlan(input = {}) {
  const normalized = normalizeInput(input);
  const mode = normalized.mode ?? "dry-run";

  if (mode === "apply" && normalized.confirmed !== true) {
    throwSpecPlanError(APPLY_REQUIRES_CONFIRMATION_ERROR);
  }

  assertNoSecretShape(`${normalized.specText}\n${normalized.planText}`);

  const tasks = parsePlanTasks(normalized.planText);
  const dependencyGraph = buildDependencyGraph(tasks);
  const cycles = findDependencyCycles(dependencyGraph);

  if (cycles.length > 0) {
    throwSpecPlanError(DEPENDENCY_CYCLE_ERROR, `NORTHSTAR_SPEC_PLAN_DEPENDENCY_CYCLE: ${cycles[0].join(" -> ")}`);
  }

  const specSections = extractSpecSections(normalized.specText);
  const issueDrafts = tasks.map((task) => issueDraftForTask({
    task,
    mode,
    specSections,
    specPath: normalized.specPath,
    planPath: normalized.planPath,
    dependencyGraph,
  }));

  for (const draft of issueDrafts) {
    assertNoSecretShape(`${draft.title}\n${draft.body}`);
  }

  return {
    mode,
    skillLineage: [...toIssuesSkillLineage],
    contract: { ...toIssuesContract },
    canMutate: mode === "apply" && normalized.confirmed === true,
    repo: normalized.repo,
    issueDrafts,
    dependencyGraph,
    applyPlan: {
      repo: normalized.repo,
      projectId: normalized.projectId,
      issueCount: issueDrafts.length,
      canMutate: mode === "apply" && normalized.confirmed === true,
    },
    metrics: {
      spec_plan_inputs_validated: 1,
      issue_slicing_contract_present: 1,
      issues_generated_from_plan: issueDrafts.length,
      issue_acceptance_criteria_present: issueDrafts.every((draft) => hasSpecifiedSection(draft.body, "Acceptance Criteria")) ? 1 : 0,
      issue_quantitative_metrics_present: issueDrafts.every((draft) => hasSpecifiedSection(draft.body, "Quantitative Metrics")) ? 1 : 0,
      dependency_graph_edges: dependencyGraph.edges.length,
      dependency_graph_cycles: cycles.length,
      dry_run_requires_no_github_mutation: mode === "dry-run" ? 1 : 0,
      apply_requires_confirmation: mode === "apply" ? 1 : 0,
      preflight_missing_project_fields_detected: mode === "apply" && !normalized.projectId ? 1 : 0,
      secret_leaks_in_generated_issues: 0,
    },
  };
}

function normalizeInput(input) {
  const normalized = {
    specText: nonEmptyString(input.specText, "specText"),
    planText: nonEmptyString(input.planText, "planText"),
    specPath: nonEmptyString(input.specPath, "specPath"),
    planPath: nonEmptyString(input.planPath, "planPath"),
    repo: nonEmptyString(input.repo, "repo"),
    projectId: input.projectId === undefined ? undefined : nonEmptyString(input.projectId, "projectId"),
    mode: input.mode ?? "dry-run",
    confirmed: input.confirmed,
  };

  if (!allowedModes.has(normalized.mode)) {
    throwSpecPlanError(INVALID_INPUT_ERROR, `${INVALID_INPUT_ERROR}: mode must be dry-run or apply`);
  }

  return normalized;
}

function nonEmptyString(value, field) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }

  throwSpecPlanError(INVALID_INPUT_ERROR, `${INVALID_INPUT_ERROR}: ${field} is required`);
}

function parsePlanTasks(planText) {
  const taskMatches = [...planText.matchAll(/^#{2,}\s*Task\s+(\d+)\s*[:.-]?\s*(.+?)\s*$/gim)];
  if (taskMatches.length === 0) {
    throwSpecPlanError(INVALID_INPUT_ERROR, `${INVALID_INPUT_ERROR}: plan must contain task headings`);
  }

  return taskMatches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < taskMatches.length ? taskMatches[index + 1].index : planText.length;
    const content = planText.slice(start, end).trim();
    const task = {
      id: `Task ${match[1]}`,
      number: Number(match[1]),
      issueNumber: index + 1,
      title: `Task ${match[1]}: ${match[2].trim()}`,
      content,
      dependencies: parseDependencies(content),
      sections: extractTaskSections(content),
    };

    return task;
  });
}

function extractTaskSections(content) {
  const sections = Object.fromEntries(sectionNames.map((name) => [name, ""]));
  const headerPattern = /^(?:(?:#{2,}\s*(Objective|Scope|Acceptance Criteria|Quantitative Metrics|Required Tests)\s*(?::\s*(.*))?)|(?:(Objective|Scope|Acceptance Criteria|Quantitative Metrics|Required Tests)\s*:\s*(.*)))$/gim;
  const matches = [...content.matchAll(headerPattern)];

  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : content.length;
    const name = match[1] ?? match[3];
    const inline = (match[2] ?? match[4] ?? "").trim();
    const block = content.slice(start, end)
      .replace(/^Depends-On:.*$/gim, "")
      .trim();
    sections[name] = [inline, block].filter(Boolean).join("\n").trim();
  }

  return sections;
}

function extractSpecSections(specText) {
  const sections = extractTaskSections(specText);
  for (const name of sectionNames) {
    if (!sections[name]) {
      sections[name] = "";
    }
  }
  return sections;
}

function parseDependencies(content) {
  const dependencies = [];
  for (const match of content.matchAll(/^Depends-On:\s*(.+?)\s*$/gim)) {
    for (const raw of match[1].split(",")) {
      const value = raw.trim();
      const taskMatch = value.match(/^Task\s+(\d+)$/i);
      if (taskMatch) {
        dependencies.push(`Task ${taskMatch[1]}`);
      } else if (/^#\d+$/.test(value)) {
        dependencies.push(value);
      } else if (value) {
        dependencies.push(value);
      }
    }
  }
  return dependencies;
}

function buildDependencyGraph(tasks) {
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskIdsByIssueReference = new Map(tasks.map((task) => [`#${task.issueNumber}`, task.id]));
  const taskIdsByTaskNumberReference = new Map(tasks.map((task) => [`#${task.number}`, task.id]));
  const edges = [];

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const dependencyTaskId = resolveDependencyTaskId({
        dependency,
        taskIds,
        taskIdsByIssueReference,
        taskIdsByTaskNumberReference,
      });
      if (dependencyTaskId) {
        edges.push({ from: task.id, to: dependencyTaskId });
      }
    }
  }

  return {
    nodes: tasks.map((task) => task.id),
    edges,
  };
}

function resolveDependencyTaskId({
  dependency,
  taskIds,
  taskIdsByIssueReference,
  taskIdsByTaskNumberReference,
}) {
  if (taskIds.has(dependency)) {
    return dependency;
  }

  if (/^#\d+$/.test(dependency)) {
    return taskIdsByIssueReference.get(dependency)
      ?? taskIdsByTaskNumberReference.get(dependency)
      ?? "";
  }

  return "";
}

function findDependencyCycles(graph) {
  const adjacency = new Map(graph.nodes.map((node) => [node, []]));
  for (const edge of graph.edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(node, stack) {
    if (visiting.has(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    if (visited.has(node)) {
      return;
    }

    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      visit(next, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const node of graph.nodes) {
    visit(node, []);
  }

  return cycles;
}

function issueDraftForTask({ task, mode, specSections, specPath, planPath, dependencyGraph }) {
  const section = (name, fallback = "Not specified.") => task.sections[name] || specSections[name] || fallback;
  const issueNumbersByTaskId = new Map(dependencyGraph.nodes.map((taskId, index) => [taskId, index + 1]));
  const dependencyMarkers = dependencyGraph.edges
    .filter((edge) => edge.from === task.id)
    .map((edge) => `Depends-On: #${issueNumbersByTaskId.get(edge.to)}`)
    .join("\n") || "None.";
  const body = [
    "Planning Source Contract: northstar:issue-slicing",
    "",
    "## Tracer Bullet Vertical Slice",
    "- This issue must be a narrow end-to-end slice, not a horizontal layer-only task.",
    "- Include every integration layer needed for the slice to be independently verifiable.",
    "- Stop before expanding scope beyond the smallest demoable behavior.",
    "",
    "## Type",
    "Type: AFK",
    "",
    "## What to build",
    section("Objective"),
    "",
    "## Objective",
    section("Objective"),
    "",
    "## Source Documents",
    `- Spec: ${specPath}`,
    `- Implementation Plan: ${planPath}`,
    "",
    "## Scope",
    section("Scope"),
    "",
    "## Acceptance Criteria",
    section("Acceptance Criteria"),
    "",
    "## Quantitative Metrics",
    section("Quantitative Metrics"),
    "",
    "## Required Tests",
    section("Required Tests"),
    "",
    "## Dependencies",
    dependencyMarkers,
    "",
    "## Northstar Execution Notes",
    "- domain: software_development",
    "- expected driver: software-dev",
    `- requires live GitHub: ${mode === "apply" ? "yes" : "no"}`,
    "- requires browser evidence: no",
    "- issue creation approval: required before apply mode",
  ].join("\n");

  return {
    title: task.title,
    body,
    source: {
      specPath,
      planPath,
      taskId: task.id,
    },
  };
}

function hasSpecifiedSection(body, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionContent = body
    .match(new RegExp(`## ${escapedName}\\n([\\s\\S]*?)(?:\\n## |$)`))?.[1]
    .trim();

  return Boolean(sectionContent && sectionContent !== "Not specified.");
}

function assertNoSecretShape(text) {
  if (secretPatterns.some((pattern) => pattern.test(text))) {
    throwSpecPlanError(SECRET_LEAK_DETECTED_ERROR);
  }
}

function throwSpecPlanError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

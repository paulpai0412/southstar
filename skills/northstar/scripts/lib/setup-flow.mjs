import { projectSetupPlan } from "./project-viewer.mjs";
import { renderNorthstarConfigDraft } from "./config-renderer.mjs";

const defaultLabels = Object.freeze(["northstar:ready", "northstar:blocked", "northstar:quarantined"]);

export async function setupPlan(input = {}) {
  const githubRepo = stringOr(input.githubRepo, "owner/repo");
  const gitRoot = stringOr(input.gitRoot, ".");
  const defaultBranch = stringOr(input.defaultBranch, "main");
  const projectMode = stringOr(input.projectMode, "none");
  const projectPlan = projectSetupPlan({ mode: projectMode, confirmed: input.confirmedProjectMutation });
  const configDraft = await renderNorthstarConfigDraft({
    path: `${gitRoot}/.northstar.yaml`,
    projectName: stringOr(input.projectName, "northstar-consumer"),
    projectRoot: gitRoot,
    githubRepo,
    baseBranch: defaultBranch,
  });

  return {
    configDraft: configDraft.content,
    configPath: configDraft.path,
    workflowDraft: configDraft.workflowContent,
    workflowPath: configDraft.workflowPath,
    labelPlan: {
      labels: [...defaultLabels],
      canMutate: input.confirmedLabelMutation === true,
      requiresConfirmation: true,
    },
    projectPlan,
    doctorCommands: [
      { description: "Run Northstar skill doctor", argv: ["npm", "run", "skill:doctor", "--", "--require-ready"] },
      { description: "Validate generated consumer config", argv: ["npm", "run", "skill:doctor", "--", "--config", configDraft.path, "--require-ready"] },
    ],
    canWriteConfig: input.confirmedConfigWrite === true,
    canMutateProject: projectPlan.canMutate,
    mutationFlags: {
      configRequiresConfirmation: true,
      labelsRequireConfirmation: true,
      projectRequiresConfirmation: true,
    },
    metrics: {
      skill_setup_creates_config: 1,
      skill_project_create_requires_confirmation: projectMode === "create_new" ? 1 : 0,
      skill_project_mutation_requires_confirmation: 1,
      skill_setup_doctor_commands_planned: 2,
      skill_setup_includes_workflow_copy: 1,
    },
  };
}

export function statusSummary(input = {}) {
  const runtime = input.runtime ?? {};
  const github = input.github ?? {};
  const project = input.project ?? {};
  const markdown = [
    "## Runtime",
    `Active issues: ${numberOr(runtime.activeIssues, 0)}`,
    `Quarantined issues: ${numberOr(runtime.quarantinedIssues, 0)}`,
    `Stale locks: ${numberOr(runtime.staleLocks, 0)}`,
    "",
    "## GitHub",
    `Open ready issues: ${numberOr(github.openReadyIssues, 0)}`,
    `Open PRs: ${numberOr(github.prsOpen, 0)}`,
    "",
    "## Project",
    `Project status mismatches: ${numberOr(github.projectStatusMismatches, project.projectStatusMismatches, 0)}`,
    `Blocked items: ${numberOr(project.blockedItems, 0)}`,
    `Release evidence items: ${numberOr(project.releaseEvidenceItems, 0)}`,
  ].join("\n");

  return {
    markdown,
    metrics: {
      skill_status_reads_runtime_and_github: 1,
      skill_status_reads_project: 1,
    },
  };
}

export function recoverPlan(input = {}) {
  const confirmed = input.confirmed === true;
  const configPath = stringOr(input.configPath, ".northstar.yaml");
  const commands = [];
  const metrics = {};

  if (input.staleLock) {
    commands.push(recoveryCommand({
      kind: "stale_lock",
      description: `Recover stale watch lock at ${input.staleLock.path ?? "unknown path"}`,
      risk: "medium",
      confirmed,
      command: "repair-runtime",
      configPath,
    }));
    metrics.skill_recover_detects_stale_lock = 1;
  }

  if (input.mergeConflict) {
    commands.push(recoveryCommand({
      kind: "merge_conflict",
      description: `Recover merge conflict for issue #${input.mergeConflict.issue ?? "unknown"}`,
      risk: "high",
      confirmed,
      command: "release",
      issue: input.mergeConflict.issue,
      configPath,
    }));
  }

  if (input.failedOrQuarantined) {
    commands.push(recoveryCommand({
      kind: "failed_or_quarantined",
      description: `Recover ${input.failedOrQuarantined.state ?? "failed"} issue #${input.failedOrQuarantined.issue ?? "unknown"}`,
      risk: "medium",
      confirmed,
      command: "repair-runtime",
      issue: input.failedOrQuarantined.issue,
      configPath,
    }));
  }

  if (input.staleBranchPr) {
    commands.push(recoveryCommand({
      kind: "stale_branch_pr",
      description: `Recover stale branch or PR for issue #${input.staleBranchPr.issue ?? "unknown"}`,
      risk: "medium",
      confirmed,
      command: "reconcile",
      issue: input.staleBranchPr.issue,
      configPath,
    }));
  }

  if (input.projectionFailure) {
    commands.push(recoveryCommand({
      kind: "projection_failure",
      description: `Recover Project projection failure for issue #${input.projectionFailure.issue ?? "unknown"}`,
      risk: "medium",
      confirmed,
      command: "retry-sync",
      issue: input.projectionFailure.issue,
      configPath,
    }));
  }

  metrics.skill_recover_options_defined = commands.length;

  return {
    commands,
    canMutate: commands.some((command) => command.risk !== "low") ? confirmed : true,
    metrics,
  };
}

function recoveryCommand({ kind, description, risk, confirmed, command, issue, configPath }) {
  const argv = ["node", "--run", "northstar", "--", command];
  if (configPath) {
    argv.push("--config", configPath);
  }
  if (issue !== undefined && issue !== null) {
    argv.push("--issue", String(issue));
  }

  return {
    kind,
    description,
    risk,
    canMutate: risk === "low" || confirmed === true,
    argv,
  };
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function numberOr(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

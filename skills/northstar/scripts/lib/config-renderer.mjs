import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GITHUB_REPO_REQUIRED_ERROR = "NORTHSTAR_CONFIG_RENDER_GITHUB_REPO_REQUIRED";
export const EXISTING_CONFIG_ERROR = "NORTHSTAR_CONFIG_RENDER_EXISTING_CONFIG";
export const EXISTING_WORKFLOW_ERROR = "NORTHSTAR_CONFIG_RENDER_EXISTING_WORKFLOW";

export async function loadTemplate(path) {
  return readFile(path, "utf8");
}

export function parseGitHubRemote(remote) {
  const trimmed = String(remote ?? "").trim();
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return undefined;
}

export function parseGitHubRepo(repo) {
  const value = String(repo ?? "");
  return /^[^/\s]+\/[^/\s]+$/.test(value) ? value : undefined;
}

export async function renderNorthstarConfigDraft(input) {
  const configPath = input.path ?? resolve(input.projectRoot ?? input.cwd ?? process.cwd(), ".northstar.yaml");
  const projectRoot = input.projectRoot ?? input.cwd ?? dirname(configPath);
  const githubRepo = normalizeGitHubRepo(input.githubRepo);
  if (githubRepo === undefined) {
    throw newNorthstarConfigRenderError(GITHUB_REPO_REQUIRED_ERROR);
  }

  const template = await loadTemplate(input.templatePath ?? defaultTemplatePath());
  const content = template
    .replaceAll("__PROJECT_NAME__", input.projectName ?? basename(projectRoot))
    .replaceAll("__PROJECT_ROOT__", projectRoot)
    .replaceAll("__GITHUB_REPO__", githubRepo)
    .replaceAll("__BASE_BRANCH__", input.baseBranch ?? "main");

  const workflowPath = input.workflowPath ?? resolve(projectRoot, ".northstar/workflows/issue-to-pr-release.yaml");
  const workflowContent = await loadTemplate(input.workflowTemplatePath ?? defaultWorkflowTemplatePath());

  return {
    path: configPath,
    content,
    workflowPath,
    workflowContent,
    skill_bootstrap_config_draft_created: 1,
    skill_bootstrap_workflow_draft_created: 1,
    skill_bootstrap_requires_confirmation: 1,
  };
}

export async function maybeWriteConfig({
  path,
  content,
  workflowPath,
  workflowContent,
  confirmed,
  allowOverwrite = false,
}) {
  if (!confirmed) {
    return { path, wrote: false, workflowPath, workflowWrote: false };
  }

  if (!allowOverwrite && await pathExists(path)) {
    throw newNorthstarConfigRenderError(EXISTING_CONFIG_ERROR);
  }
  if (workflowPath && !allowOverwrite && await pathExists(workflowPath)) {
    throw newNorthstarConfigRenderError(EXISTING_WORKFLOW_ERROR);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  if (workflowPath && workflowContent !== undefined) {
    await mkdir(dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, workflowContent, "utf8");
  }
  return { path, wrote: true, workflowPath, workflowWrote: Boolean(workflowPath && workflowContent !== undefined) };
}

export async function renderConfigFromCwd({ cwd, githubRepo, baseBranch } = {}) {
  const projectRoot = resolve(cwd ?? process.cwd());
  const repo = githubRepo === undefined
    ? await readGitHubRepo(projectRoot)
    : normalizeGitHubRepo(githubRepo);
  if (repo === undefined) {
    throw newNorthstarConfigRenderError(GITHUB_REPO_REQUIRED_ERROR);
  }

  const configPath = resolve(projectRoot, ".northstar.yaml");
  const draft = await renderNorthstarConfigDraft({
    path: configPath,
    projectName: basename(projectRoot),
    projectRoot,
    githubRepo: repo,
    baseBranch: baseBranch ?? await readDefaultBranch(projectRoot) ?? "main",
  });

  return {
    ...draft,
    skill_bootstrap_existing_config_detected: await pathExists(configPath) ? 1 : 0,
    skill_bootstrap_existing_workflow_detected: await pathExists(draft.workflowPath) ? 1 : 0,
  };
}

function normalizeGitHubRepo(repo) {
  if (repo === undefined || repo === null) {
    return undefined;
  }

  return parseGitHubRepo(repo);
}

function newNorthstarConfigRenderError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultTemplatePath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "northstar.yaml");
}

function defaultWorkflowTemplatePath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "workflow.issue-to-pr-release.yaml");
}

async function readGitHubRepo(cwd) {
  const repoRoot = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (repoRoot === undefined) {
    return undefined;
  }

  const remote = await runGit(["config", "--local", "--get", "remote.origin.url"], repoRoot.trim());

  return parseGitHubRemote(remote);
}

async function readDefaultBranch(cwd) {
  const remoteHead = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const remoteBranch = remoteHead?.trim().replace(/^origin\//, "");
  if (remoteBranch) {
    return remoteBranch;
  }

  return undefined;
}

async function runGit(args, cwd) {
  return new Promise((resolveOutput) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      resolveOutput(error ? undefined : stdout);
    });
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

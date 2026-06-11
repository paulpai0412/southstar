import { access, readFile as defaultReadFile } from "node:fs/promises";
import path from "node:path";
import { commandSpec, runCommand as defaultRunCommand } from "./platform.mjs";

const TOKEN_PATTERN = /\b(?:gh[opsu]_[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+)/g;
const SENSITIVE_ENV_KEY_PATTERN = /(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)/i;
const PROJECT_VIEWER_QUERY = "query($projectId: ID!) { node(id: $projectId) { ... on ProjectV2 { id title } } }";
const REQUIRED_CONFIG_FIELDS = Object.freeze([
  "schema_version",
  "project.name",
  "project.root",
  "runtime.db_path",
  "runtime.host_adapter",
  "runtime.development_capacity",
  "runtime.release_capacity",
  "runtime.heartbeat_interval_seconds",
  "runtime.lease_timeout_seconds",
  "runtime.child_timeout_seconds",
  "runtime.watch_lock_stale_seconds",
  "runtime.max_recovery_attempts",
  "runtime.auto_release",
  "runtime.session_scope",
  "workflow.package",
  "workflow.id",
  "workflow.version",
  "github.repo",
  "github.intake.enabled",
  "github.intake.label",
  "github.sync.enabled",
  "github.sync.retry_backoff_seconds",
  "git.base_branch",
  "git.worktrees_dir",
  "git.sync_worktree_dir",
  "cleanup.completed_worktrees",
  "cleanup.keep_last",
  "cleanup.failed_or_quarantined",
  "policy.github_sync_blocks_lifecycle",
  "policy.quarantine_requires_operator",
]);
const STRING_CONFIG_FIELDS = Object.freeze([
  "schema_version",
  "project.name",
  "project.root",
  "runtime.db_path",
  "runtime.host_adapter",
  "runtime.session_scope",
  "workflow.package",
  "workflow.id",
  "workflow.version",
  "github.repo",
  "github.intake.label",
  "git.base_branch",
  "git.worktrees_dir",
  "git.sync_worktree_dir",
]);
const NUMBER_CONFIG_FIELDS = Object.freeze([
  "runtime.development_capacity",
  "runtime.release_capacity",
  "runtime.heartbeat_interval_seconds",
  "runtime.lease_timeout_seconds",
  "runtime.child_timeout_seconds",
]);
const NON_NEGATIVE_INTEGER_CONFIG_FIELDS = Object.freeze([
  "runtime.watch_lock_stale_seconds",
  "runtime.max_recovery_attempts",
  "cleanup.keep_last",
]);
const BOOLEAN_CONFIG_FIELDS = Object.freeze([
  "runtime.auto_release",
  "github.intake.enabled",
  "github.sync.enabled",
  "policy.github_sync_blocks_lifecycle",
  "policy.quarantine_requires_operator",
]);
const ENUM_CONFIG_FIELDS = Object.freeze({
  "cleanup.completed_worktrees": ["archive", "delete", "keep"],
  "cleanup.failed_or_quarantined": ["keep", "archive"],
});
const DEFAULT_MANAGED_LABELS = Object.freeze(["northstar:blocked", "northstar:quarantined"]);

function sensitiveEnvValues(env) {
  return Object.entries(env)
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])
    .filter(([key, value]) => SENSITIVE_ENV_KEY_PATTERN.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

export function redactSecrets(value, knownSecrets = []) {
  let redacted = String(value ?? "").replace(TOKEN_PATTERN, "[REDACTED]");
  for (const secret of knownSecrets) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function redactReturnedStrings(value, redact) {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactReturnedStrings(item, redact));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactReturnedStrings(item, redact)]),
    );
  }
  return value;
}

function commandMessage(result, redact) {
  const detail = result.stderr || result.stdout || result.message || "";
  return redact(detail.trim());
}

function okCheck(id, message, extra = {}, redact = redactSecrets) {
  return { id, status: "ok", message: redact(message), ...extra };
}

function problemCheck(id, status, message, extra = {}, redact = redactSecrets) {
  return { id, status, message: redact(message), ...extra };
}

function skippedCheck(id, message, extra = {}, redact = redactSecrets) {
  return { id, status: "skipped", message: redact(message), ...extra };
}

async function defaultFileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function checkImport({ id, specifier, importModule, okMessage, missingMessage, redact }) {
  try {
    await importModule(specifier);
    return okCheck(id, okMessage, {}, redact);
  } catch (error) {
    const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
    return problemCheck(id, "missing", `${missingMessage}${suffix}`, {}, redact);
  }
}

async function checkImports({ id, specifiers, importModule, okMessage, missingMessage, redact }) {
  const missing = [];
  for (const specifier of specifiers) {
    try {
      await importModule(specifier);
    } catch (error) {
      const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
      missing.push(`${specifier}${suffix}`);
    }
  }
  if (missing.length === 0) {
    return okCheck(id, okMessage, { specifiers }, redact);
  }
  return problemCheck(id, "missing", `${missingMessage}: ${missing.join(", ")}`, { specifiers }, redact);
}

async function checkCommand({ id, spec, runCommand, okMessage, missingMessage, redact }) {
  const result = await runCommand(commandSpec(
    spec.command,
    spec.args,
  ));
  if (result.exitCode === 0) {
    const detail = commandMessage(result, redact);
    return okCheck(id, detail ? `${okMessage}: ${detail}` : okMessage, {}, redact);
  }

  const detail = commandMessage(result, redact);
  return problemCheck(id, "missing", detail ? `${missingMessage}: ${detail}` : missingMessage, {}, redact);
}

export async function runDoctor(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const nodeVersion = options.nodeVersion ?? process.version;
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const runCommand = options.runCommand ?? defaultRunCommand;
  const fileExists = options.fileExists ?? defaultFileExists;
  const readFile = options.readFile ?? defaultReadFile;
  const northstarRoot = env.NORTHSTAR_ROOT || cwd;
  const packageJsonPath = path.join(northstarRoot, "package.json");
  const configPath = options.configPath ?? env.NORTHSTAR_CONFIG ?? path.join(cwd, ".northstar.yaml");
  const knownSecrets = sensitiveEnvValues(env);
  const redact = (value) => redactSecrets(value, knownSecrets);
  const checks = [];

  checks.push(okCheck("platform", `${platform}/${arch} node ${nodeVersion}`, {
    platform,
    arch,
    nodeVersion,
  }, redact));

  checks.push(await checkImport({
    id: "node_sqlite",
    specifier: "node:sqlite",
    importModule,
    okMessage: "node:sqlite is available",
    missingMessage: "node:sqlite is unavailable",
    redact,
  }));

  checks.push(await checkCommand({
    id: "git",
    spec: { command: "git", args: ["--version"] },
    runCommand,
    okMessage: "git is available",
    missingMessage: "git is unavailable",
    redact,
  }));

  checks.push(await checkCommand({
    id: "gh",
    spec: { command: "gh", args: ["--version"] },
    runCommand,
    okMessage: "gh is available",
    missingMessage: "gh is unavailable",
    redact,
  }));

  const githubCredential = await checkGitHubCredential({ env, runCommand, redact });
  checks.push(githubCredential.check);

  if (await fileExists(packageJsonPath)) {
    checks.push(okCheck("northstar_root", `package.json found at ${packageJsonPath}`, { northstarRoot }, redact));
    const result = await runCommand(commandSpec(
      "node",
      ["--run", "northstar", "--", "--help"],
    ), { cwd: northstarRoot });
    if (result.exitCode === 0) {
      const detail = commandMessage(result, redact);
      checks.push(okCheck("northstar_cli", detail ? `northstar CLI is available: ${detail}` : "northstar CLI is available", {}, redact));
    } else {
      const detail = commandMessage(result, redact);
      checks.push(problemCheck(
        "northstar_cli",
        "missing",
        detail ? `northstar CLI is unavailable: ${detail}` : "northstar CLI is unavailable",
        {},
        redact,
      ));
    }
  } else {
    checks.push(problemCheck("northstar_root", "missing", `package.json not found at ${packageJsonPath}`, { northstarRoot }, redact));
    checks.push(problemCheck("northstar_cli", "missing", "northstar CLI check requires package.json", {}, redact));
  }

  checks.push(await checkImports({
    id: "sdk",
    specifiers: ["@openai/codex-sdk", "@earendil-works/pi-coding-agent"],
    importModule,
    okMessage: "required host SDK packages are available",
    missingMessage: "required host SDK packages are unavailable",
    redact,
  }));

  const config = await checkNorthstarConfig({ configPath, fileExists, readFile, redact });
  checks.push(config.check);
  checks.push(await checkGitHubRepoAccess({ config: config.config, credentialOk: githubCredential.available, runCommand, redact }));
  checks.push(await checkGitHubManagedLabels({ config: config.config, credentialOk: githubCredential.available, runCommand, redact }));
  checks.push(await checkGitHubProject({
    config: config.config,
    credentialOk: githubCredential.available,
    runCommand,
    redact,
  }));

  const metrics = {
    skill_doctor_platform_reported: 1,
    skill_doctor_node_sqlite_checked: 1,
    skill_doctor_git_gh_checked: 1,
    skill_doctor_northstar_cli_checked: 1,
    skill_doctor_sdk_checked: 1,
  };

  return redactReturnedStrings({
    ready: checks.every((check) => check.status === "ok" || check.status === "skipped"),
    checks,
    metrics,
  }, redact);
}

async function checkGitHubCredential({ env, runCommand, redact }) {
  if (typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.trim() !== "") {
    return {
      available: true,
      check: okCheck("github_credential", "GITHUB_TOKEN is set", {}, redact),
    };
  }

  const result = await runCommand(commandSpec(
    "gh",
    ["auth", "token"],
  ));
  if (result.exitCode === 0 && String(result.stdout ?? "").trim() !== "") {
    return {
      available: true,
      check: okCheck("github_credential", "gh auth token fallback is available", {
        source: "gh_auth_token",
      }, redact),
    };
  }

  const detail = commandMessage(result, redact);
  return {
    available: false,
    check: problemCheck("github_credential", "missing", detail ? `GitHub credential unavailable: ${detail}` : "GITHUB_TOKEN is not set and gh auth token fallback is unavailable", {
      code: "NORTHSTAR_GITHUB_CREDENTIAL_MISSING",
    }, redact),
  };
}

async function checkNorthstarConfig({ configPath, fileExists, readFile, redact }) {
  if (!await fileExists(configPath)) {
    return {
      config: undefined,
      check: problemCheck("config", "missing", `.northstar.yaml not found at ${configPath}`, {
        code: "NORTHSTAR_CONFIG_MISSING",
        configPath,
      }, redact),
    };
  }

  try {
    const content = await readFile(configPath, "utf8");
    const parsed = validateNorthstarConfig(content);

    return {
      config: { ...parsed, configPath },
      check: okCheck("config", `.northstar.yaml is present and includes github.repo`, {
        configPath,
        githubRepo: parsed.githubRepo,
        readyLabel: parsed.readyLabel,
      }, redact),
    };
  } catch (error) {
    const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
    return {
      config: undefined,
      check: problemCheck("config", "invalid", `.northstar.yaml could not be read${suffix}`, {
        code: "NORTHSTAR_CONFIG_INVALID",
        configPath,
      }, redact),
    };
  }
}

async function checkGitHubRepoAccess({ config, credentialOk, runCommand, redact }) {
  if (!config) {
    return skippedCheck("github_repo_access", "GitHub repo access check requires valid config", {}, redact);
  }

  if (!credentialOk) {
    return skippedCheck("github_repo_access", "GitHub repo access check requires credentials", {
      githubRepo: config.githubRepo,
    }, redact);
  }

  const result = await runCommand(commandSpec(
    "gh",
    ["repo", "view", config.githubRepo, "--json", "nameWithOwner"],
  ));
  if (result.exitCode === 0) {
    return okCheck("github_repo_access", `GitHub repo is accessible: ${config.githubRepo}`, {
      githubRepo: config.githubRepo,
    }, redact);
  }

  const detail = commandMessage(result, redact);
  return problemCheck("github_repo_access", "missing", detail ? `GitHub repo is not accessible: ${detail}` : `GitHub repo is not accessible: ${config.githubRepo}`, {
    code: "NORTHSTAR_GITHUB_REPO_ACCESS_MISSING",
    githubRepo: config.githubRepo,
  }, redact);
}

async function checkGitHubManagedLabels({ config, credentialOk, runCommand, redact }) {
  if (!config) {
    return skippedCheck("github_labels", "GitHub managed label check requires valid config", {}, redact);
  }

  const requiredLabels = managedLabels(config);
  if (!credentialOk) {
    return skippedCheck("github_labels", "GitHub managed label check requires credentials", {
      githubRepo: config.githubRepo,
      requiredLabels,
    }, redact);
  }

  const result = await runCommand(commandSpec("gh", [
    "label",
    "list",
    "--repo",
    config.githubRepo,
    "--json",
    "name",
  ]));
  const missingLabels = result.exitCode === 0 ? labelsMissing(result.stdout, requiredLabels) : requiredLabels;
  if (result.exitCode === 0 && missingLabels.length === 0) {
    return okCheck("github_labels", `GitHub managed labels exist: ${requiredLabels.join(", ")}`, {
      githubRepo: config.githubRepo,
      requiredLabels,
    }, redact);
  }

  const detail = commandMessage(result, redact);
  const message = detail
    ? `GitHub managed labels are missing: ${detail}`
    : `GitHub managed labels are missing: ${missingLabels.join(", ")}`;
  return problemCheck("github_labels", "missing", message, {
    code: "NORTHSTAR_GITHUB_LABELS_MISSING",
    githubRepo: config.githubRepo,
    requiredLabels,
    missingLabels,
  }, redact);
}

async function checkGitHubProject({ config, credentialOk, runCommand, redact }) {
  if (!config) {
    return skippedCheck("github_project", "GitHub Project check requires valid config", {}, redact);
  }

  if (!config.projectEnabled) {
    return skippedCheck("github_project", "GitHub Project viewer is disabled in config", {
      githubRepo: config.githubRepo,
    }, redact);
  }

  if (!config.projectId) {
    return problemCheck("github_project", "missing", "GitHub Project viewer is enabled but project id is missing", {
      code: "NORTHSTAR_GITHUB_PROJECT_ID_MISSING",
      githubRepo: config.githubRepo,
    }, redact);
  }

  if (!credentialOk) {
    return skippedCheck("github_project", "GitHub Project check requires credentials", {
      githubRepo: config.githubRepo,
      projectId: config.projectId,
    }, redact);
  }

  const result = await runCommand(commandSpec(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${PROJECT_VIEWER_QUERY}`,
      "-F",
      `projectId=${config.projectId}`,
    ],
  ));
  if (result.exitCode === 0 && projectGraphqlResponseContainsProject(result.stdout, config.projectId)) {
    return okCheck("github_project", "GitHub Project viewer is accessible", {
      githubRepo: config.githubRepo,
      projectId: config.projectId,
    }, redact);
  }

  const detail = commandMessage(result, redact);
  return problemCheck("github_project", "missing", detail ? `GitHub Project viewer is not accessible: ${detail}` : "GitHub Project viewer is not accessible", {
    code: "NORTHSTAR_GITHUB_PROJECT_ACCESS_MISSING",
    githubRepo: config.githubRepo,
    projectId: config.projectId,
  }, redact);
}

function validateNorthstarConfig(content) {
  const parsed = parseYamlSubset(content);
  const missing = REQUIRED_CONFIG_FIELDS.filter((field) => configValue(parsed, field) === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required config fields: ${missing.join(", ")}`);
  }

  for (const field of STRING_CONFIG_FIELDS) {
    const value = configValue(parsed, field);
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${field} must be a non-empty string`);
    }
  }

  for (const field of NUMBER_CONFIG_FIELDS) {
    const value = configValue(parsed, field);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${field} must be a finite number`);
    }
  }

  for (const field of NON_NEGATIVE_INTEGER_CONFIG_FIELDS) {
    const value = configValue(parsed, field);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer`);
    }
  }

  for (const field of BOOLEAN_CONFIG_FIELDS) {
    if (typeof configValue(parsed, field) !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
  }

  for (const [field, allowed] of Object.entries(ENUM_CONFIG_FIELDS)) {
    const value = configValue(parsed, field);
    if (!allowed.includes(value)) {
      throw new Error(`${field} must be ${allowed.slice(0, -1).join(", ")}, or ${allowed.at(-1)}`);
    }
  }

  const retryBackoffSeconds = configValue(parsed, "github.sync.retry_backoff_seconds");
  if (!Array.isArray(retryBackoffSeconds) || !retryBackoffSeconds.every((item) => typeof item === "number")) {
    throw new Error("github.sync.retry_backoff_seconds must be an array of numbers");
  }

  const sessionScope = configValue(parsed, "runtime.session_scope");
  if (sessionScope !== "stage_root") {
    throw new Error("runtime.session_scope must be stage_root");
  }

  const hostAdapter = configValue(parsed, "runtime.host_adapter");
  if (hostAdapter !== "codex" && hostAdapter !== "opencode" && hostAdapter !== "pi") {
    throw new Error("runtime.host_adapter must be codex, opencode, or pi");
  }

  const projectEnabled = configValue(parsed, "github.project.enabled");
  if (projectEnabled !== undefined && typeof projectEnabled !== "boolean") {
    throw new Error("github.project.enabled must be a boolean");
  }

  const projectId = optionalStringConfigValue(parsed, "github.project.project_id")
    ?? optionalStringConfigValue(parsed, "github.project.id");

  return {
    githubRepo: stringConfigValue(parsed, "github.repo"),
    readyLabel: stringConfigValue(parsed, "github.intake.label"),
    projectEnabled: projectEnabled === true,
    projectId,
  };
}

function parseYamlSubset(content) {
  const lines = content
    .split(/\r?\n/)
    .map((raw) => ({
      indent: raw.match(/^ */)?.[0].length ?? 0,
      text: raw.trim(),
    }))
    .filter((line) => line.text.length > 0 && !line.text.startsWith("#"));

  if (lines.length === 0) {
    return {};
  }

  return parseYamlBlock(lines, 0, lines[0].indent).value;
}

function parseYamlBlock(lines, start, indent) {
  if (lines[start]?.text.startsWith("- ")) {
    return parseYamlArray(lines, start, indent);
  }
  return parseYamlObject(lines, start, indent);
}

function parseYamlObject(lines, start, indent) {
  const value = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected indentation near "${line.text}"`);
    }
    if (line.text.startsWith("- ")) {
      break;
    }

    const separator = line.text.indexOf(":");
    if (separator === -1) {
      throw new Error(`Invalid YAML mapping line "${line.text}"`);
    }

    const key = line.text.slice(0, separator).trim();
    const rest = line.text.slice(separator + 1).trim();
    if (rest.length > 0) {
      value[key] = parseYamlScalar(rest);
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (!nextLine || nextLine.indent <= indent) {
      value[key] = {};
      index += 1;
      continue;
    }

    const parsed = parseYamlBlock(lines, index + 1, nextLine.indent);
    value[key] = parsed.value;
    index = parsed.next;
  }

  return { value, next: index };
}

function parseYamlArray(lines, start, indent) {
  const value = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw new Error(`Unexpected array indentation near "${line.text}"`);
    }
    if (!line.text.startsWith("- ")) {
      break;
    }

    const rest = line.text.slice(2).trim();
    if (rest.length > 0) {
      value.push(parseYamlScalar(rest));
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1];
    if (!nextLine || nextLine.indent <= indent) {
      value.push(null);
      index += 1;
      continue;
    }

    const parsed = parseYamlBlock(lines, index + 1, nextLine.indent);
    value.push(parsed.value);
    index = parsed.next;
  }

  return { value, next: index };
}

function parseYamlScalar(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function stringConfigValue(value, field) {
  const item = configValue(value, field);
  if (typeof item !== "string" || item.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return item;
}

function optionalStringConfigValue(value, field) {
  const item = configValue(value, field);
  if (item === undefined) {
    return undefined;
  }
  if (typeof item !== "string" || item.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return item;
}

function configValue(value, field) {
  return field.split(".").reduce((cursor, part) => {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    return cursor[part] ?? cursor[snakeToCamel(part)];
  }, value);
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function labelsMissing(stdout, labels) {
  try {
    const parsed = JSON.parse(String(stdout ?? "[]"));
    const names = new Set(Array.isArray(parsed) ? parsed.map((item) => item?.name).filter((name) => typeof name === "string") : []);
    return labels.filter((label) => !names.has(label));
  } catch {
    const text = String(stdout ?? "");
    return labels.filter((label) => !text.includes(label));
  }
}

function managedLabels(config) {
  return [...new Set([config.readyLabel, ...DEFAULT_MANAGED_LABELS])];
}

function projectGraphqlResponseContainsProject(stdout, projectId) {
  try {
    const parsed = JSON.parse(String(stdout ?? "{}"));
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return false;
    }
    return parsed?.data?.node?.id === projectId;
  } catch {
    return false;
  }
}

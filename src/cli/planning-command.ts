import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import { optionValue } from "./southstar.ts";

const execFileAsync = promisify(execFile);
const PLANNING_COMMANDS = ["plan-grill", "plan-spec", "plan-implementation", "plan-issues"] as const;

type PlanningCommand = typeof PLANNING_COMMANDS[number];

interface BuiltPlanningCommand {
  command: PlanningCommand;
  args: string[];
  config: RuntimeConfig;
}

export interface PlanningGithubConfig {
  repo?: string;
  intake?: {
    enabled?: boolean;
    label?: string;
  };
  project?: {
    projectId?: string;
  };
}

export function isPlanningCommand(command: string | undefined): command is PlanningCommand {
  return typeof command === "string" && PLANNING_COMMANDS.includes(command as PlanningCommand);
}

export async function runPlanningCommand(argv: string[]): Promise<unknown> {
  const built = buildPlanningCommand(argv);

  if (built.command === "plan-grill") {
    const { generatePlanningGrill } = await import("../../skills/northstar/scripts/lib/planning-pipeline.mjs");
    const briefPath = requireOptionValue(built.args, "--brief");
    const result = generatePlanningGrill({
      briefText: await readFile(briefPath, "utf8"),
      briefPath,
    });
    await maybeWriteOutput(built.args, result.markdown);
    return outputResult(result, built.args);
  }

  if (built.command === "plan-spec") {
    const { generatePlanningSpec } = await import("../../skills/northstar/scripts/lib/planning-pipeline.mjs");
    const briefPath = requireOptionValue(built.args, "--brief");
    const answersPath = optionValue(built.args, "--answers");
    const result = generatePlanningSpec({
      briefText: await readFile(briefPath, "utf8"),
      answersText: answersPath ? await readFile(answersPath, "utf8") : "",
      briefPath,
    });
    await maybeWriteOutput(built.args, result.markdown);
    return outputResult(result, built.args);
  }

  if (built.command === "plan-implementation") {
    const { generateImplementationPlan } = await import("../../skills/northstar/scripts/lib/planning-pipeline.mjs");
    const specPath = requireOptionValue(built.args, "--spec");
    const result = generateImplementationPlan({
      specText: await readFile(specPath, "utf8"),
      specPath,
    });
    await maybeWriteOutput(built.args, result.markdown);
    return outputResult(result, built.args);
  }

  const { generateIssueDraftsFromSpecPlan } = await import("../../skills/northstar/scripts/lib/spec-plan-intake.mjs");
  const specPath = requireOptionValue(built.args, "--spec");
  const planPath = requireOptionValue(built.args, "--plan");
  const apply = built.args.includes("--apply");
  const github = optionalGithubConfig(built.config);
  const applyTarget = apply ? resolveGithubApplyTarget(github) : undefined;
  const result = generateIssueDraftsFromSpecPlan({
    specText: await readFile(specPath, "utf8"),
    planText: await readFile(planPath, "utf8"),
    specPath,
    planPath,
    repo: github?.repo ?? "local/southstar",
    projectId: github?.project?.projectId,
    mode: apply ? "apply" : "dry-run",
    confirmed: built.args.includes("--confirmed"),
  });

  if (apply) {
    return {
      ...result,
      createdIssues: await createIssuesWithGh({
        repo: applyTarget.repo,
        label: applyTarget.label,
        issueDrafts: result.issueDrafts,
      }),
    };
  }

  return result;
}

function optionalGithubConfig(config: RuntimeConfig): PlanningGithubConfig | undefined {
  const maybeConfig = config as unknown as {
    github?: PlanningGithubConfig;
  };
  return maybeConfig.github;
}

export function resolveGithubApplyTarget(github: PlanningGithubConfig | undefined): { repo: string; label: string } {
  if (!github?.repo) {
    throw new Error("plan-issues --apply requires GitHub config with repo");
  }
  if (github.intake?.enabled !== true) {
    throw new Error("plan-issues --apply requires enabled GitHub intake");
  }
  return {
    repo: github.repo,
    label: github.intake?.label ?? "southstar:ready",
  };
}

function buildPlanningCommand(argv: string[]): BuiltPlanningCommand {
  const [command, ...args] = argv;
  if (!isPlanningCommand(command)) {
    throw new Error(`Unknown planning command: ${command ?? "(missing)"}`);
  }
  const configPath = optionValue(args, "--config") ?? ".southstar.yaml";
  const projectRootOverride = optionValue(args, "--project-root");
  return {
    command,
    args,
    config: loadConfig(configPath, projectRootOverride),
  };
}

function requireOptionValue(args: string[], option: string): string {
  const value = optionValue(args, option);
  if (!value) {
    throw new Error(`${option} is required`);
  }
  return value;
}

async function maybeWriteOutput(args: string[], content: string): Promise<string | undefined> {
  const out = optionValue(args, "--out");
  if (!out) return undefined;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, content, "utf8");
  return out;
}

function outputResult(result: Record<string, unknown>, args: string[]): Record<string, unknown> {
  const out = optionValue(args, "--out");
  return out ? { ...result, outputPath: out } : result;
}

async function createIssuesWithGh(input: {
  repo: string;
  label: string;
  issueDrafts: Array<{ title: string; body: string }>;
}): Promise<Array<{ title: string; url: string }>> {
  const created = [];
  for (const draft of input.issueDrafts) {
    const { stdout } = await execFileAsync("gh", [
      "issue",
      "create",
      "--repo",
      input.repo,
      "--title",
      draft.title,
      "--body",
      draft.body,
      "--label",
      input.label,
    ], { encoding: "utf8" });
    created.push({ title: draft.title, url: stdout.trim() });
  }
  return created;
}

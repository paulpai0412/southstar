#!/usr/bin/env node
import {
  buildCliCommand,
  formatSouthstarHelp,
  formatSouthstarVersion,
  optionValue,
  type BuiltCliCommand,
} from "./southstar.ts";
import { isPlanningCommand, runPlanningCommand } from "./planning-command.ts";

export interface ManualOrchestratorCommandTarget {
  intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }): Promise<unknown>;
  inspectIssue(input: { issueId: string }): unknown;
}

export function createManualOrchestratorCommandRunner(options: {
  createOrchestrator(command: BuiltCliCommand): Promise<ManualOrchestratorCommandTarget>;
  readIssue?: (issueNumber: number, command: BuiltCliCommand) => Promise<{ title: string; body: string; sourceUrl: string; labels: string[] }>;
}) {
  return async (argv: string[]): Promise<unknown> => {
    const command = buildCliCommand(argv);
    const issue = optionValue(command.args, "--issue");
    const dryRun = command.args.includes("--dry-run");

    if (command.command === "inspect" && !issue) {
      throw new Error("--issue is required");
    }
    if (command.command === "intake" && !issue && !optionValue(command.args, "--label")) {
      throw new Error("intake requires --issue or --label");
    }
    if (dryRun) return { type: command.command, issue };

    const orchestrator = await options.createOrchestrator(command);
    if (command.command === "inspect") return orchestrator.inspectIssue({ issueId: issueId(issue) });
    if (command.command === "intake") {
      const issueNumber = Number(issue);
      const externalIssue = issue && Number.isFinite(issueNumber)
        ? await options.readIssue?.(issueNumber, command)
        : undefined;
      return await orchestrator.intakeIssue({
        issueNumber,
        title: externalIssue?.title ?? optionValue(command.args, "--title") ?? `Issue ${issue}`,
        body: externalIssue?.body ?? optionValue(command.args, "--body") ?? "",
        sourceUrl: externalIssue?.sourceUrl ?? optionValue(command.args, "--source-url") ?? "",
        labels: externalIssue?.labels ?? [optionValue(command.args, "--label") ?? command.config.github.intake.label],
      });
    }
    return {
      type: command.command,
      args: command.args,
      configPath: command.configPath,
      bootstrap: {
        configPath: command.configPath,
        ...(command.projectRootOverride ? { projectRootOverride: command.projectRootOverride } : {}),
      },
    };
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(formatSouthstarHelp());
    return 0;
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(formatSouthstarVersion());
    return 0;
  }

  if (argv[1] === "--help" || argv[1] === "-h") {
    console.log(formatSouthstarHelp());
    return 0;
  }

  if (isPlanningCommand(argv[0])) {
    try {
      const result = await runPlanningCommand(argv);
      console.log(JSON.stringify(result));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  try {
    const command = buildCliCommand(argv);
    if (command.command === "db:init") {
      const { initializeSouthstarSchema } = await import("../v2/db/init.ts");
      const result = await initializeSouthstarSchema(command.config.runtime.databaseUrl);
      console.log(JSON.stringify({ type: "db:init", schema: "southstar", version: result.version }));
      return 0;
    }
    console.log(JSON.stringify({
      type: command.command,
      args: command.args,
      configPath: command.configPath,
      bootstrap: {
        configPath: command.configPath,
        ...(command.projectRootOverride ? { projectRootOverride: command.projectRootOverride } : {}),
      },
    }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function issueId(issue: string | undefined): string {
  const value = optionValue(["--issue", issue ?? ""], "--issue")?.trim();
  if (!value) throw new Error("--issue is required");
  return value.startsWith("github:") ? value : `github:${value}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";

export const CLI_COMMANDS = [
  "doctor",
  "work",
  "intake",
  "projection",
  "pack",
  "workflow",
  "watch",
  "inspect",
  "db:init",
] as const;

export type SouthstarCliCommand = typeof CLI_COMMANDS[number];

export interface BuiltCliCommand {
  command: SouthstarCliCommand;
  args: string[];
  config: RuntimeConfig;
  configPath: string;
  projectRootOverride?: string;
}

export function runSouthstarCli(argv: string[]): { command: SouthstarCliCommand; args: string[] } {
  const [command, ...args] = argv;
  if (!command || !CLI_COMMANDS.includes(command as SouthstarCliCommand)) {
    throw new Error(`Unknown southstar command: ${command ?? "(missing)"}`);
  }
  return { command: command as SouthstarCliCommand, args };
}

export function formatSouthstarHelp(): string {
  return [
    "Southstar generic multi-agent workflow runtime",
    "",
    "Usage:",
    "  southstar <command> [--config .southstar.yaml] [--project-root <path>]",
    "",
    "Commands:",
    ...CLI_COMMANDS.map((command) => `  southstar ${command}`),
  ].join("\n");
}

export function formatSouthstarVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
  return String(pkg.version);
}

export function buildCliCommand(argv: string[]): BuiltCliCommand {
  const parsed = runSouthstarCli(argv);
  const configPath = optionValue(parsed.args, "--config") ?? ".southstar.yaml";
  const projectRootOverride = optionValue(parsed.args, "--project-root");
  const config = loadConfig(configPath, projectRootOverride);
  return {
    command: parsed.command,
    args: parsed.args,
    config,
    configPath,
    ...(projectRootOverride ? { projectRootOverride } : {}),
  };
}

export function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

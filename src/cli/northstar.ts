import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";

export const CLI_COMMANDS = [
  "init",
  "intake",
  "start",
  "reconcile",
  "reconcile-workspace",
  "heartbeat",
  "release",
  "repair-runtime",
  "resume",
  "inspect",
  "plan-grill",
  "plan-spec",
  "plan-implementation",
  "plan-issues",
  "retry-sync",
  "watch",
];

export interface BuiltCliCommand {
  command: string;
  args: string[];
  config: RuntimeConfig;
  engineCommand: {
    type: string;
    args: string[];
    configPath: string;
    bootstrap: {
      configPath: string;
      projectRootOverride?: string;
    };
  };
}

export function runNorthstarCli(argv: string[]): { command: string; args: string[] } {
  const [command, ...args] = argv;
  if (!command || !CLI_COMMANDS.includes(command)) {
    throw new Error(`Unknown northstar command: ${command ?? "(missing)"}`);
  }
  return { command, args };
}

export function formatNorthstarHelp(): string {
  return [
    "Northstar runtime control plane",
    "",
    "Usage:",
    "  northstar <command> [--config .northstar.yaml] [--project-root <path>]",
    "",
    "Commands:",
    ...CLI_COMMANDS.map((command) => `  northstar ${command}`),
  ].join("\n");
}

export function formatNorthstarWatchHelp(): string {
  return [
    "Northstar watch",
    "",
    "Usage:",
    "  northstar watch [--config .northstar.yaml] [--max-cycles NUMBER] [--interval-ms NUMBER] [--log-json]",
    "",
    "Options:",
    "  --max-cycles NUMBER  Stop after this many watch cycles.",
    "  --interval-ms NUMBER Sleep interval between cycles.",
    "  --log-json             Emit compact JSON cycle logs.",
  ].join("\n");
}

export function formatNorthstarVersion(): string {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"));
  return String(pkg.version);
}

export function buildCliCommand(argv: string[]): BuiltCliCommand {
  const parsed = runNorthstarCli(argv);
  const configPath = optionValue(parsed.args, "--config") ?? ".northstar.yaml";
  const config = loadConfig(configPath);
  const projectRoot = optionValue(parsed.args, "--project-root");
  const effectiveConfig = projectRoot
    ? { ...config, project: { ...config.project, root: projectRoot } }
    : config;

  return {
    command: parsed.command,
    args: parsed.args,
    config: effectiveConfig,
    engineCommand: {
      type: parsed.command,
      args: parsed.args,
      configPath,
      bootstrap: {
        configPath,
        ...(projectRoot ? { projectRootOverride: projectRoot } : {}),
      },
    },
  };
}

export function requireOption(args: string[], option: string): string {
  const value = optionValue(args, option);
  if (!value) throw new Error(`${option} is required`);
  return value;
}

export function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

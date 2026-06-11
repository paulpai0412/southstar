#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const templateNorthstarRoot = "__NORTHSTAR_ROOT__";
const northstarRoot = process.env.NORTHSTAR_ROOT
  ?? (templateNorthstarRoot.startsWith("__") ? resolve(dirname(fileURLToPath(import.meta.url)), "../..") : templateNorthstarRoot);
const playbookPath = `${northstarRoot}/docs/agent-playbooks/northstar-operator.md`;
const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "northstar-slash-command-prompt.md");
const knownCommands = new Set([
  "/northstar-plan",
  "/northstar-grill",
  "/northstar-to-spec",
  "/northstar-to-plan",
  "/northstar-to-issues",
  "/northstar-setup",
  "/northstar-init",
  "/northstar-execute",
  "/northstar-watch",
  "/northstar-observe",
  "/northstar-status",
  "/northstar-recover",
  "/northstar-recovery",
  "/northstar-report",
]);

export async function buildPiNorthstarPrompt(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!knownCommands.has(command)) {
    throw new Error(`Unknown Northstar slash command for Pi-agent: ${command ?? "(missing)"}`);
  }
  const [promptTemplate, playbook] = await Promise.all([
    readFile(promptPath, "utf8"),
    readFile(playbookPath, "utf8"),
  ]);
  const prompt = promptTemplate.replaceAll("__NORTHSTAR_ROOT__", northstarRoot);
  return [
    prompt.trim(),
    "",
    "## Shared Playbook",
    playbook.trim(),
    "",
    "## Operator Request",
    `Slash command: ${command}`,
    `Arguments: ${args.join(" ") || "(none)"}`,
    `Invocation cwd: ${resolve(process.cwd())}`,
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await buildPiNorthstarPrompt());
}

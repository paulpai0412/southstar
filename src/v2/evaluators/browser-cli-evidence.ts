type BrowserCliEvidenceInput = {
  artifact: Record<string, unknown>;
  expectedEvidenceKinds: Iterable<string>;
};

type RuntimeCommandExecution = {
  command: string;
  status?: string;
  ok?: boolean;
};

const NAVIGATION_COMMANDS = new Set(["open", "goto"]);
const OBSERVATION_COMMANDS = new Set([
  "snapshot",
  "find",
  "eval",
  "run-code",
  "screenshot",
  "console",
]);

export function browserCliEvidenceFindings(input: BrowserCliEvidenceInput): string[] {
  const executions = runtimeCommandExecutions(input.artifact);
  const directExecutions = executions.flatMap((execution) => {
    const cliCommand = directPlaywrightCliCommand(execution.command);
    return cliCommand ? [{ ...execution, cliCommand }] : [];
  });
  const successfulCommands = new Set(directExecutions
    .filter((execution) => execution.ok === true && execution.status === "passed")
    .map((execution) => execution.cliCommand));
  const findings: string[] = [];

  if (![...NAVIGATION_COMMANDS].some((command) => successfulCommands.has(command))) {
    findings.push("browser interaction requires a successful direct playwright-cli navigation command");
  }
  if (![...OBSERVATION_COMMANDS].some((command) => successfulCommands.has(command))) {
    findings.push("browser interaction requires a successful direct playwright-cli observation command");
  }
  if (
    new Set(input.expectedEvidenceKinds).has("screenshot")
    && !successfulCommands.has("screenshot")
  ) {
    findings.push("browser interaction requires a successful direct playwright-cli screenshot command");
  }
  for (const execution of executions) {
    if (
      !directPlaywrightCliCommand(execution.command)
      && containsPlaywrightCliInvocation(execution.command)
    ) {
      findings.push(`playwright-cli command must be direct and unchained: ${execution.command}`);
    }
  }
  for (const execution of directExecutions) {
    if (execution.ok === false || execution.status === "failed") {
      findings.push(`playwright-cli command failed: ${execution.command}`);
    }
  }
  return findings;
}

function runtimeCommandExecutions(artifact: Record<string, unknown>): RuntimeCommandExecution[] {
  if (!Array.isArray(artifact.runtimeCommandExecutions)) return [];
  return artifact.runtimeCommandExecutions.flatMap((value) => {
    if (!isRecord(value) || typeof value.command !== "string") return [];
    return [{
      command: value.command.trim(),
      status: typeof value.status === "string" ? value.status : undefined,
      ok: typeof value.ok === "boolean" ? value.ok : undefined,
    }];
  });
}

function directPlaywrightCliCommand(command: string): string | undefined {
  if (
    command.includes("\n")
    || command.includes("\r")
    || command.includes("&&")
    || command.includes("||")
    || command.includes(";")
    || command.includes("|")
    || command.includes("`")
    || command.includes("$(")
  ) {
    return undefined;
  }
  const normalized = command.trim()
    .replace(/\s+\d>&\d\s*$/, "")
    .replace(/\s+(?:\d?>{1,2}|\d?<<?)\s+(?:"[^"]*"|'[^']*'|\S+)\s*$/, "")
    .replace(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+))\s+)+/, "")
    .trim();
  return normalized.match(/^playwright-cli\s+([a-z][a-z0-9-]*)(?:\s|$)/)?.[1];
}

function containsPlaywrightCliInvocation(command: string): boolean {
  return /(?:^|&&|\|\||;|\|)[ \t]*(?:\/[^\s]+\/)?playwright-cli(?:\s|$)/m.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

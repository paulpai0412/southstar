import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "./types.ts";

export function createBuiltinAgentHarness(): AgentHarness {
  return {
    id: "builtin-agent-harness",
    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      const startedAt = Date.now();
      const role = input.envelope.task.id;
      const repo = repoPath();
      const commandsRun: string[] = [];
      const testResults: unknown[] = [];

      if (repo && shouldValidateRepo(role)) {
        testResults.push(runCommand(repo, "npm", ["test"], commandsRun));
        testResults.push(runCommand(repo, "npm", ["run", "-s", "cli", "--", "sum", "1", "2", "3"], commandsRun));
      }

      const memoryPreference = JSON.stringify(input.envelope.memory.items);
      const artifact = {
        summary: summaryFor(role, memoryPreference),
        commandsRun,
        testResults,
        risks: ["builtin harness validates the task contract in the container environment"],
        followUpSuggestions: [],
      };

      return {
        artifact,
        progress: [
          `${role} builtin harness started`,
          `${role} builtin harness produced artifact`,
          `${role} builtin harness completed`,
        ],
        metrics: {
          durationMs: Date.now() - startedAt,
          toolCalls: commandsRun.length,
          retryCount: input.attempt - 1,
          tokens: 128,
          costMicrosUsd: 0,
        },
      };
    },
  };
}

function shouldValidateRepo(role: string): boolean {
  return /root|valid|verify|follow|summary/i.test(role);
}

function summaryFor(role: string, memoryPreference: string): string {
  const memoryNote = /最小改動|dependency|測試指令/.test(memoryPreference)
    ? " Applied memory preference: 最小改動、不新增 dependency、artifact 必須列出測試指令與結果."
    : "";
  if (/plan/i.test(role)) return `Planned task execution and artifact contract.${memoryNote}`;
  if (/summary/i.test(role)) return `Summarized completed workflow artifacts and validation results.${memoryNote}`;
  return `Validated task artifact and runtime outputs.${memoryNote}`;
}

function repoPath(): string | undefined {
  const candidates = [
    process.env.REPO_PATH,
    "/workspace/repo",
    "/workspace",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

function runCommand(repo: string, command: string, args: string[], commandsRun: string[]): unknown {
  const rendered = [command, ...args].join(" ");
  commandsRun.push(`cd ${repo} && ${rendered}`);
  try {
    const output = execFileSync(command, args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { command: rendered, status: "passed", output: output.trim() };
  } catch (error) {
    const failure = error as Error & { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      command: rendered,
      status: "failed",
      exitCode: failure.status ?? 1,
      stdout: stringify(failure.stdout),
      stderr: stringify(failure.stderr),
    };
  }
}

function stringify(value: Buffer | string | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

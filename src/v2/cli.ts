import type { SouthstarDb } from "./stores/sqlite.ts";
import { openSouthstarDb } from "./stores/sqlite.ts";
import type { PiPlannerClient } from "./planner/types.ts";
import { createHttpPiPlannerClient } from "./planner/pi-planner.ts";
import { TorkClient } from "./executor/tork-client.ts";
import { loadSouthstarEnv } from "./config/env.ts";
import {
  createPlannerDraft,
  createRunFromDraft,
  getRunStatus,
  getTaskEnvelope,
  revisePlannerDraft,
  steerRun,
} from "./ui-api/local-api.ts";

export type V2Command =
  | { command: "plan"; goal: string }
  | { command: "revise"; draftId: string; prompt: string }
  | { command: "run"; draftId: string }
  | { command: "status"; runId: string }
  | { command: "steer"; runId: string; message: string }
  | { command: "task-envelope"; runId: string; taskId: string }
  | { command: "serve" }
  | { command: "run-goal"; goal: string }
  | { command: "wait"; runId: string }
  | { command: "tasks"; runId: string }
  | { command: "task"; runId: string; taskId: string }
  | { command: "artifacts"; runId: string }
  | { command: "sessions"; runId: string }
  | { command: "memory"; runId: string }
  | { command: "logs"; runId: string }
  | { command: "voice-command"; runId: string; transcript: string };

export type V2CliDependencies = {
  db: SouthstarDb;
  plannerClient?: PiPlannerClient;
  torkClient?: Pick<TorkClient, "submit">;
};

export type V2CommandResult =
  | { kind: "planner-draft"; result: Awaited<ReturnType<typeof createPlannerDraft>> }
  | { kind: "run"; result: Awaited<ReturnType<typeof createRunFromDraft>> }
  | { kind: "status"; result: ReturnType<typeof getRunStatus> }
  | { kind: "steering"; result: ReturnType<typeof steerRun> }
  | { kind: "task-envelope"; result: ReturnType<typeof getTaskEnvelope> };

export function parseV2Command(argv: string[]): V2Command {
  const [command, ...args] = argv;
  switch (command) {
    case "plan":
      return { command, goal: requireFlag(args, "--goal") };
    case "revise":
      return { command, draftId: requireFlag(args, "--draft-id"), prompt: requireFlag(args, "--prompt") };
    case "run":
      return { command, draftId: requireFlag(args, "--draft-id") };
    case "status":
      return { command, runId: requireFlag(args, "--run-id") };
    case "steer":
      return { command, runId: requireFlag(args, "--run-id"), message: requireFlag(args, "--message") };
    case "task-envelope":
      return { command, runId: requireFlag(args, "--run-id"), taskId: requireFlag(args, "--task-id") };
    case "serve":
      return { command };
    case "run-goal":
      return { command, goal: requireFlag(args, "--goal") };
    case "wait":
      return { command, runId: requireFlag(args, "--run-id") };
    case "tasks":
      return { command, runId: requireFlag(args, "--run-id") };
    case "task":
      return { command, runId: requireFlag(args, "--run-id"), taskId: requireFlag(args, "--task-id") };
    case "artifacts":
      return { command, runId: requireFlag(args, "--run-id") };
    case "sessions":
      return { command, runId: requireFlag(args, "--run-id") };
    case "memory":
      return { command, runId: requireFlag(args, "--run-id") };
    case "logs":
      return { command, runId: requireFlag(args, "--run-id") };
    case "voice-command":
      return { command, runId: requireFlag(args, "--run-id"), transcript: requireFlag(args, "--transcript") };
    default:
      throw new Error(`Unknown southstar:v2 command: ${command ?? "(missing)"}`);
  }
}

export async function executeV2Command(
  command: V2Command,
  dependencies: V2CliDependencies,
): Promise<V2CommandResult> {
  switch (command.command) {
    case "plan":
      return {
        kind: "planner-draft",
        result: await createPlannerDraft(dependencies.db, {
          goalPrompt: command.goal,
          plannerClient: requirePlannerClient(dependencies),
        }),
      };
    case "revise":
      return {
        kind: "planner-draft",
        result: await revisePlannerDraft(dependencies.db, {
          draftId: command.draftId,
          prompt: command.prompt,
          plannerClient: requirePlannerClient(dependencies),
        }),
      };
    case "run":
      return {
        kind: "run",
        result: await createRunFromDraft(dependencies.db, {
          draftId: command.draftId,
          torkClient: requireTorkClient(dependencies),
        }),
      };
    case "status":
      return { kind: "status", result: getRunStatus(dependencies.db, command.runId) };
    case "steer":
      return {
        kind: "steering",
        result: steerRun(dependencies.db, { runId: command.runId, message: command.message }),
      };
    case "task-envelope":
      return {
        kind: "task-envelope",
        result: getTaskEnvelope(dependencies.db, { runId: command.runId, taskId: command.taskId }),
      };
    case "serve":
      throw new Error("serve is implemented by src/v2/server entrypoint task");
    case "run-goal":
    case "wait":
    case "tasks":
    case "task":
    case "artifacts":
    case "sessions":
    case "memory":
    case "logs":
    case "voice-command":
      throw new Error(`${command.command} requires Southstar runtime server route implementation`);
  }
}

export async function main(
  argv = process.argv.slice(2),
  dependencies?: Partial<V2CliDependencies> & { write?: (text: string) => void },
): Promise<number> {
  try {
    const parsed = parseV2Command(argv);
    const deps = dependencies ?? {};
    const runtimeDeps = completeDependencies(parsed, deps);
    const result = await executeV2Command(parsed, runtimeDeps);
    (deps.write ?? console.log)(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

function requireFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function completeDependencies(
  command: V2Command,
  dependencies: Partial<V2CliDependencies>,
): V2CliDependencies {
  const env = loadSouthstarEnv();
  const plannerClient = dependencies.plannerClient
    ?? (needsPlanner(command)
      ? createHttpPiPlannerClient({ endpoint: requirePiPlannerEndpoint(env.piPlannerEndpoint) })
      : undefined);
  return {
    db: dependencies.db ?? openSouthstarDb(env.databaseUrl),
    plannerClient,
    torkClient: dependencies.torkClient ?? new TorkClient({ baseUrl: env.torkBaseUrl }),
  };
}

function requirePlannerClient(dependencies: V2CliDependencies): PiPlannerClient {
  if (!dependencies.plannerClient) throw new Error("planner client is required for this command");
  return dependencies.plannerClient;
}

function requireTorkClient(dependencies: V2CliDependencies): Pick<TorkClient, "submit"> {
  if (!dependencies.torkClient) throw new Error("tork client is required for this command");
  return dependencies.torkClient;
}

function needsPlanner(command: V2Command): boolean {
  return command.command === "plan" || command.command === "revise";
}

function requirePiPlannerEndpoint(endpoint: string | undefined): string {
  if (!endpoint) throw new Error("PI_PLANNER_ENDPOINT is required for planner commands");
  return endpoint;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}

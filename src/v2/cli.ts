import type { SouthstarDb } from "./stores/sqlite.ts";
import type { PiPlannerClient } from "./planner/types.ts";
import { createHttpPiPlannerClient } from "./planner/pi-planner.ts";
import type { TorkClient } from "./executor/tork-client.ts";
import type { ExecutorProvider } from "./executor/provider.ts";
import { createCliRuntimeClient, type CliRuntimeClient } from "./cli-client.ts";
import { buildRuntimeDependencies } from "./runtime/dependencies.ts";
import {
  createPlannerDraft,
  createRunFromDraft,
  getRunStatus,
  getTaskEnvelope,
  revisePlannerDraft,
  steerRun,
} from "./ui-api/local-api.ts";

type V2CommandBase = { configPath?: string };

export type V2Command =
  | (V2CommandBase & { command: "plan"; goal: string })
  | (V2CommandBase & { command: "revise"; draftId: string; prompt: string })
  | (V2CommandBase & { command: "run"; draftId: string })
  | (V2CommandBase & { command: "status"; runId: string })
  | (V2CommandBase & { command: "steer"; runId: string; message: string })
  | (V2CommandBase & { command: "task-envelope"; runId: string; taskId: string })
  | (V2CommandBase & { command: "serve" })
  | (V2CommandBase & { command: "run-goal"; goal: string })
  | (V2CommandBase & { command: "wait"; runId: string })
  | (V2CommandBase & { command: "tasks"; runId: string })
  | (V2CommandBase & { command: "task"; runId: string; taskId: string })
  | (V2CommandBase & { command: "artifacts"; runId: string })
  | (V2CommandBase & { command: "sessions"; runId: string })
  | (V2CommandBase & { command: "memory"; runId: string })
  | (V2CommandBase & { command: "logs"; runId: string })
  | (V2CommandBase & { command: "voice-command"; runId: string; transcript: string });

export type V2CliDependencies = {
  db: SouthstarDb;
  plannerClient?: PiPlannerClient;
  executorProvider?: ExecutorProvider;
  torkClient?: Pick<TorkClient, "submit">;
  runtimeClient?: CliRuntimeClient;
};

export type V2CommandResult =
  | { kind: "planner-draft"; result: Awaited<ReturnType<typeof createPlannerDraft>> }
  | { kind: "run"; result: Awaited<ReturnType<typeof createRunFromDraft>> }
  | { kind: "status"; result: ReturnType<typeof getRunStatus> }
  | { kind: "steering"; result: ReturnType<typeof steerRun> }
  | { kind: "task-envelope"; result: ReturnType<typeof getTaskEnvelope> }
  | { kind: string; result: unknown };

export function parseV2Command(argv: string[]): V2Command {
  const [command, ...args] = argv;
  switch (command) {
    case "plan":
      return withConfig(args, { command, goal: requireFlag(args, "--goal") });
    case "revise":
      return withConfig(args, { command, draftId: requireFlag(args, "--draft-id"), prompt: requireFlag(args, "--prompt") });
    case "run":
      return withConfig(args, { command, draftId: requireFlag(args, "--draft-id") });
    case "status":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "steer":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id"), message: requireFlag(args, "--message") });
    case "task-envelope":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id"), taskId: requireFlag(args, "--task-id") });
    case "serve":
      return withConfig(args, { command });
    case "run-goal":
      return withConfig(args, { command, goal: requireFlag(args, "--goal") });
    case "wait":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "tasks":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "task":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id"), taskId: requireFlag(args, "--task-id") });
    case "artifacts":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "sessions":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "memory":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "logs":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id") });
    case "voice-command":
      return withConfig(args, { command, runId: requireFlag(args, "--run-id"), transcript: requireFlag(args, "--transcript") });
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
          executorProvider: dependencies.executorProvider,
          torkClient: dependencies.torkClient,
        }),
      };
    case "status":
      if (dependencies.runtimeClient) return unwrapServerEnvelope(await dependencies.runtimeClient.getRun(command.runId));
      return { kind: "status", result: getRunStatus(dependencies.db, command.runId) };
    case "steer":
      if (dependencies.runtimeClient) {
        return unwrapServerEnvelope(await dependencies.runtimeClient.steerRun({ runId: command.runId, message: command.message }));
      }
      return {
        kind: "steering",
        result: steerRun(dependencies.db, { runId: command.runId, message: command.message }),
      };
    case "task-envelope":
      if (dependencies.runtimeClient) {
        return unwrapServerEnvelope(await dependencies.runtimeClient.getTaskEnvelope({ runId: command.runId, taskId: command.taskId }));
      }
      return {
        kind: "task-envelope",
        result: getTaskEnvelope(dependencies.db, { runId: command.runId, taskId: command.taskId }),
      };
    case "serve":
      throw new Error("serve is implemented by src/v2/server entrypoint task");
    case "run-goal":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).runGoal({ goalPrompt: command.goal }));
    case "wait":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).getRun(command.runId));
    case "tasks":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).listTasks(command.runId));
    case "task":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).getTask({ runId: command.runId, taskId: command.taskId }));
    case "artifacts":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).listArtifacts(command.runId));
    case "sessions":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).listSessions(command.runId));
    case "memory":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).listMemory(command.runId));
    case "logs":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).listLogs(command.runId));
    case "voice-command":
      return unwrapServerEnvelope(await requireRuntimeClient(dependencies).voiceCommand({
        runId: command.runId,
        transcript: command.transcript,
      }));
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

function withConfig<T extends Record<string, unknown>>(args: string[], command: T): T {
  const configPath = optionalFlag(args, "--config");
  if (!configPath) return command;
  return { ...command, configPath };
}

function requireFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function completeDependencies(
  command: V2Command,
  dependencies: Partial<V2CliDependencies>,
): V2CliDependencies {
  const localNeeds = needsLocalRuntime(command, dependencies.runtimeClient);
  const hasExecutor = dependencies.executorProvider !== undefined || dependencies.torkClient !== undefined;
  const shouldLoadConfig = localNeeds && (dependencies.db === undefined || (command.command === "run" && !hasExecutor));

  let db = dependencies.db;
  let executorProvider = dependencies.executorProvider;

  if (shouldLoadConfig) {
    const configPath = command.configPath ?? process.env.SOUTHSTAR_CONFIG;
    if (!configPath) {
      throw new Error("--config or SOUTHSTAR_CONFIG is required when local runtime dependencies are not injected");
    }
    const built = buildRuntimeDependencies({
      configPath,
      resolveCredential: (ref) => {
        const value = process.env[`SOUTHSTAR_SECRET_${ref}`] ?? process.env[ref];
        if (!value) throw new Error(`missing credential for ${ref}; set SOUTHSTAR_SECRET_${ref}`);
        return value;
      },
    });
    db = db ?? built.db;
    executorProvider = executorProvider ?? built.executorManager.provider;
  }

  if (!db) {
    throw new Error("db dependency is required for local runtime commands");
  }

  const plannerClient = dependencies.plannerClient
    ?? (needsPlanner(command)
      ? createHttpPiPlannerClient({ endpoint: requirePiPlannerEndpoint(process.env.PI_PLANNER_ENDPOINT) })
      : undefined);

  return {
    db,
    plannerClient,
    executorProvider,
    torkClient: dependencies.torkClient,
    runtimeClient: dependencies.runtimeClient
      ?? (needsRuntimeServer(command) ? createCliRuntimeClient({ baseUrl: process.env.SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3100" }) : undefined),
  };
}

function requirePlannerClient(dependencies: V2CliDependencies): PiPlannerClient {
  if (!dependencies.plannerClient) throw new Error("planner client is required for this command");
  return dependencies.plannerClient;
}

function requireRuntimeClient(dependencies: V2CliDependencies): CliRuntimeClient {
  if (!dependencies.runtimeClient) throw new Error("runtime server client is required for this command");
  return dependencies.runtimeClient;
}

function unwrapServerEnvelope<T>(envelope: { kind: string; result: T }) {
  return { kind: envelope.kind, result: envelope.result };
}

function needsPlanner(command: V2Command): boolean {
  return command.command === "plan" || command.command === "revise";
}

function needsRuntimeServer(command: V2Command): boolean {
  return [
    "run-goal",
    "wait",
    "tasks",
    "task",
    "artifacts",
    "sessions",
    "memory",
    "logs",
    "voice-command",
  ].includes(command.command);
}

function needsLocalRuntime(command: V2Command, runtimeClient: CliRuntimeClient | undefined): boolean {
  if (runtimeClient) return false;
  return command.command === "plan"
    || command.command === "revise"
    || command.command === "run"
    || command.command === "status"
    || command.command === "steer"
    || command.command === "task-envelope"
    || command.command === "serve";
}

function requirePiPlannerEndpoint(endpoint: string | undefined): string {
  if (!endpoint) throw new Error("PI_PLANNER_ENDPOINT is required for planner commands");
  return endpoint;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}

import { loadSouthstarEnv } from "./config/env.ts";
import { createCliRuntimeClient, type CliRuntimeClient } from "./cli-client.ts";
import type { ReadModelKind } from "./read-models/types.ts";

export type V2Command =
  | { command: "plan"; goal: string }
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
  | { command: "voice-command"; runId: string; transcript: string }
  | { command: "read-model"; kind: ReadModelKind; runId: string; taskId?: string };

export type V2CliDependencies = {
  runtimeClient?: CliRuntimeClient;
};

export type V2CommandResult = { kind: string; result: unknown };

export function parseV2Command(argv: string[]): V2Command {
  const [command, ...args] = argv;
  switch (command) {
    case "plan":
      return { command, goal: requireFlag(args, "--goal") };
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
    case "read-model": {
      const kind = requireFlag(args, "--kind") as ReadModelKind;
      const runId = requireFlag(args, "--run-id");
      const taskId = optionalFlag(args, "--task-id");
      if (kind === "task-detail" && !taskId) throw new Error("--task-id is required for task-detail read model");
      return taskId ? { command, kind, runId, taskId } : { command, kind, runId };
    }
    default:
      throw new Error(`Unknown southstar:v2 command: ${command ?? "(missing)"}`);
  }
}

export async function executeV2Command(command: V2Command, dependencies: V2CliDependencies): Promise<V2CommandResult> {
  if (command.command === "serve") throw new Error("serve is implemented by src/v2/server entrypoint task");
  const client = requireRuntimeClient(dependencies);
  switch (command.command) {
    case "plan":
      return unwrapServerEnvelope(await client.createPlannerDraft({ goalPrompt: command.goal }));
    case "run":
      return unwrapServerEnvelope(await client.createRun({ draftId: command.draftId }));
    case "status":
    case "wait":
      return unwrapServerEnvelope(await client.getRun(command.runId));
    case "steer":
      return unwrapServerEnvelope(await client.steerRun({ runId: command.runId, message: command.message }));
    case "task-envelope":
      return unwrapServerEnvelope(await client.getTaskEnvelope({ runId: command.runId, taskId: command.taskId }));
    case "run-goal":
      return unwrapServerEnvelope(await client.runGoal({ goalPrompt: command.goal }));
    case "tasks":
      return unwrapServerEnvelope(await client.listTasks(command.runId));
    case "task":
      return unwrapServerEnvelope(await client.getTask({ runId: command.runId, taskId: command.taskId }));
    case "artifacts":
      return unwrapServerEnvelope(await client.listArtifacts(command.runId));
    case "sessions":
      return unwrapServerEnvelope(await client.listSessions(command.runId));
    case "memory":
      return unwrapServerEnvelope(await client.listMemory(command.runId));
    case "logs":
      return unwrapServerEnvelope(await client.listLogs(command.runId));
    case "voice-command":
      return unwrapServerEnvelope(await client.voiceCommand({ runId: command.runId, transcript: command.transcript }));
    case "read-model":
      return unwrapServerEnvelope(await client.getReadModel({ kind: command.kind, runId: command.runId, taskId: command.taskId }));
  }
}

export async function main(argv = process.argv.slice(2), dependencies?: Partial<V2CliDependencies> & { write?: (text: string) => void }): Promise<number> {
  try {
    const parsed = parseV2Command(argv);
    const deps = { ...dependencies, runtimeClient: dependencies?.runtimeClient ?? createCliRuntimeClient({ baseUrl: loadSouthstarEnv().serverUrl }) };
    const result = await executeV2Command(parsed, deps);
    (dependencies?.write ?? console.log)(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

function requireFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
}

function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function requireRuntimeClient(dependencies: V2CliDependencies): CliRuntimeClient {
  if (!dependencies.runtimeClient) throw new Error("runtime server client is required for this command");
  return dependencies.runtimeClient;
}

function unwrapServerEnvelope<T>(envelope: { kind: string; result: T }): V2CommandResult {
  return { kind: envelope.kind, result: envelope.result };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}

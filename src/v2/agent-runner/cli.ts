import { readFile, writeFile } from "node:fs/promises";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "../harness/types.ts";
import { createPiSdkAgentHarness } from "../harness/pi-sdk-harness.ts";
import { createBuiltinAgentHarness } from "../harness/builtin-agent-harness.ts";
import { runTaskEnvelope, type TaskRunResult } from "./task-runner.ts";
import type { AnyTaskEnvelope } from "./task-envelope.ts";

export async function runAgentRunnerCli(
  argv = process.argv.slice(2),
  io: { write?: (text: string) => void; writeError?: (text: string) => void } = {},
): Promise<number> {
  try {
    const options = parseAgentRunnerArgs(argv);
    const envelope = JSON.parse(await readFile(options.envelopePath, "utf8")) as AnyTaskEnvelope;
    const result = await runTaskEnvelope(envelope, createAgentHarness(options, envelope), {
      requiredFields: options.requiredFields ?? requiredFieldsFromEnvelope(envelope),
    });
    result.materializationRoot = options.materializationRoot;
    if (options.resultPath) {
      await writeFile(options.resultPath, JSON.stringify(result, null, 2), "utf8");
    } else {
      (io.write ?? console.log)(JSON.stringify(result, null, 2));
    }
    if (options.callbackUrl) {
      await postCallback(options.callbackUrl, result);
    }
    return result.ok ? 0 : 2;
  } catch (error) {
    (io.writeError ?? console.error)((error as Error).message);
    return 1;
  }
}

export function parseAgentRunnerArgs(argv: string[], env: Record<string, string | undefined> = process.env) {
  const envelopePath = flagValue(argv, "--envelope") ?? env.SOUTHSTAR_ENVELOPE_PATH;
  const harnessEndpoint = flagValue(argv, "--harness-endpoint")
    ?? env.SOUTHSTAR_HARNESS_ENDPOINT
    ?? env.PI_HARNESS_ENDPOINT;
  if (!envelopePath) throw new Error("--envelope or SOUTHSTAR_ENVELOPE_PATH is required");
  const requiredFields = flagValue(argv, "--required-fields")?.split(",").map((field) => field.trim()).filter(Boolean);
  return {
    envelopePath,
    harnessEndpoint,
    harnessProvider: harnessEndpoint ? "http" as const : "pi-sdk" as const,
    harnessKind: flagValue(argv, "--harness-kind") ?? env.SOUTHSTAR_HARNESS_KIND,
    requiredFields,
    resultPath: flagValue(argv, "--result") ?? env.SOUTHSTAR_RESULT_PATH,
    callbackUrl: flagValue(argv, "--callback-url") ?? env.SOUTHSTAR_CALLBACK_URL,
    materializationRoot: flagValue(argv, "--materialization-root") ?? env.SOUTHSTAR_MATERIALIZATION_ROOT,
    harnessTimeoutMs: numberFromEnv(flagValue(argv, "--harness-timeout-ms") ?? env.SOUTHSTAR_HARNESS_TIMEOUT_MS),
  };
}

function createAgentHarness(options: ReturnType<typeof parseAgentRunnerArgs>, envelope: AnyTaskEnvelope): AgentHarness {
  const harnessKind = options.harnessKind ?? defaultHarnessKindFromEnvelope(envelope);
  if (harnessKind === "builtin") return createBuiltinAgentHarness();
  return options.harnessEndpoint
    ? createHttpHarness(options.harnessEndpoint)
    : createPiSdkAgentHarness({ timeoutMs: options.harnessTimeoutMs ?? timeoutFromEnvelope(envelope) });
}

function defaultHarnessKindFromEnvelope(envelope: AnyTaskEnvelope): string | undefined {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return undefined;
  if (envelope.harness.kind === "pi-agent" || envelope.agentProfile.provider === "pi") return "pi-sdk";
  return "builtin";
}

function createHttpHarness(endpoint: string): AgentHarness {
  return {
    id: "http-harness",
    async run(input: HarnessRunInput): Promise<HarnessRunResult> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`harness request failed: ${response.status} ${text}`);
      }
      const payload = JSON.parse(text) as HarnessRunResult;
      if (!payload.artifact || !Array.isArray(payload.progress)) {
        throw new Error("harness response must include artifact and progress");
      }
      return payload;
    },
  };
}

async function postCallback(callbackUrl: string, result: TaskRunResult): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    throw new Error(`callback request failed: ${response.status} ${await response.text()}`);
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

export function timeoutFromEnvelope(envelope: AnyTaskEnvelope): number {
  const taskTimeoutMs = envelope.schemaVersion === "southstar.task-envelope.v2"
    ? (envelope.agentProfile.budgetPolicy.maxWallTimeSeconds ?? 180) * 1000
    : envelope.task.execution.timeoutSeconds * 1000;
  return Math.max(120_000, taskTimeoutMs - 30_000);
}

function requiredFieldsFromEnvelope(envelope: AnyTaskEnvelope): string[] {
  if (envelope.schemaVersion === "southstar.task-envelope.v2") {
    return [...new Set(envelope.artifactContracts.flatMap((contract) => contract.requiredFields))];
  }
  return envelope.artifactContract?.requiredFields ?? [];
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runAgentRunnerCli();
}

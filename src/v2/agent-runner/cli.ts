import { readFile, writeFile } from "node:fs/promises";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "../harness/types.ts";
import { createPiSdkAgentHarness } from "../harness/pi-sdk-harness.ts";
import { createBuiltinAgentHarness } from "../harness/builtin-agent-harness.ts";
import { runTaskEnvelope, type TaskRunResult, type TaskRunnerRuntimeFault } from "./task-runner.ts";
import { refreshTaskEnvelopeV2Prompt, type AnyTaskEnvelope } from "./task-envelope.ts";

export async function runAgentRunnerCli(
  argv = process.argv.slice(2),
  io: { write?: (text: string) => void; writeError?: (text: string) => void } = {},
): Promise<number> {
  try {
    const options = parseAgentRunnerArgs(argv);
    const envelope = JSON.parse(await readFile(options.envelopePath, "utf8")) as AnyTaskEnvelope;
    const refreshedEnvelope = options.contextRefreshUrl
      ? await refreshEnvelopeContext(options.contextRefreshUrl, envelope)
      : envelope;
    const stopHeartbeat = startHeartbeatLoop(options, refreshedEnvelope);
    const result = await (async () => {
      try {
        return await runTaskEnvelope(refreshedEnvelope, createAgentHarness(options, refreshedEnvelope), {
          requiredFields: options.requiredFields ?? requiredFieldsFromEnvelope(refreshedEnvelope),
          runtimeFault: options.runtimeFault,
          attemptId: options.attemptId,
        });
      } finally {
        stopHeartbeat();
      }
    })();
    result.materializationRoot = options.materializationRoot;
    result.attemptId = options.attemptId;
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
    heartbeatUrl: flagValue(argv, "--heartbeat-url") ?? env.SOUTHSTAR_HEARTBEAT_URL,
    heartbeatIntervalMs: numberFromEnv(flagValue(argv, "--heartbeat-interval-ms") ?? env.SOUTHSTAR_HEARTBEAT_INTERVAL_MS) ?? 10_000,
    attemptId: flagValue(argv, "--attempt-id") ?? env.SOUTHSTAR_ATTEMPT_ID ?? "attempt-1",
    torkJobId: flagValue(argv, "--tork-job-id") ?? env.SOUTHSTAR_TORK_JOB_ID ?? env.TORK_JOB_ID,
    torkTaskId: flagValue(argv, "--tork-task-id") ?? env.SOUTHSTAR_TORK_TASK_ID ?? env.TORK_TASK_ID,
    materializationRoot: flagValue(argv, "--materialization-root") ?? env.SOUTHSTAR_MATERIALIZATION_ROOT,
    harnessTimeoutMs: numberFromEnv(flagValue(argv, "--harness-timeout-ms") ?? env.SOUTHSTAR_HARNESS_TIMEOUT_MS),
    contextRefreshUrl: flagValue(argv, "--context-refresh-url") ?? env.SOUTHSTAR_CONTEXT_REFRESH_URL,
    runtimeFault: parseRuntimeFault(flagValue(argv, "--runtime-fault") ?? env.SOUTHSTAR_AGENT_RUNNER_FAULT),
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

function startHeartbeatLoop(options: ReturnType<typeof parseAgentRunnerArgs>, envelope: AnyTaskEnvelope): () => void {
  if (!options.heartbeatUrl || !options.torkJobId) {
    return () => undefined;
  }

  let seq = 0;
  let stopped = false;

  const sendHeartbeat = async (phase: string, message: string) => {
    if (!options.heartbeatUrl || !options.torkJobId) return;
    seq += 1;
    try {
      await fetch(options.heartbeatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: envelope.runId,
          taskId: envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.taskId : envelope.task.id,
          attemptId: options.attemptId,
          executorType: "tork",
          torkJobId: options.torkJobId,
          torkTaskId: options.torkTaskId,
          rootSessionId: envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.session.sessionId : envelope.rootSession.id,
          heartbeatSeq: seq,
          phase,
          message,
          observedAt: new Date().toISOString(),
        }),
      });
    } catch {
      // Best-effort heartbeat; task execution remains authoritative.
    }
  };

  void sendHeartbeat("booting", "agent runner booting");
  const timer = setInterval(() => {
    if (!stopped) {
      void sendHeartbeat("subagent-running", "agent runner active");
    }
  }, options.heartbeatIntervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
    void sendHeartbeat("shutdown", "agent runner shutting down");
  };
}

export async function refreshEnvelopeContext(url: string, envelope: AnyTaskEnvelope): Promise<AnyTaskEnvelope> {
  if (envelope.schemaVersion !== "southstar.task-envelope.v2") return envelope;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: envelope.runId, taskId: envelope.taskId }),
  });
  if (!response.ok) {
    throw new Error(`context refresh failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json() as {
    upstreamContext?: {
      text?: string;
      artifactRefs?: string[];
      evidencePacketRefs?: string[];
      validatorResultRefs?: string[];
    };
  };
  const text = payload.upstreamContext?.text?.trim();
  if (!text) return envelope;
  const refreshed = {
    ...envelope,
    contextPacket: {
      ...envelope.contextPacket,
      priorArtifacts: [
        ...envelope.contextPacket.priorArtifacts,
        {
          id: `upstream-${envelope.runId}-${envelope.taskId}`,
          sourceType: "artifact",
          title: "Accepted upstream artifacts",
          text,
          sourceRef: payload.upstreamContext?.artifactRefs?.join(","),
          tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
        },
      ],
    },
  };
  return refreshTaskEnvelopeV2Prompt(refreshed);
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

function parseRuntimeFault(value: string | undefined): TaskRunnerRuntimeFault | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runtime fault must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind !== "validation_missing_fields") {
    throw new Error("runtime fault kind must be validation_missing_fields");
  }
  if (!Array.isArray(record.fields) || record.fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new Error("runtime fault fields must be a non-empty string array");
  }
  return {
    kind: "validation_missing_fields",
    fields: [...new Set(record.fields)],
    ...(Array.isArray(record.failedArtifactRefs) ? { failedArtifactRefs: uniqueStringArray(record.failedArtifactRefs, "runtime fault failedArtifactRefs") } : {}),
    ...(Array.isArray(record.attemptIds) ? { attemptIds: uniqueStringArray(record.attemptIds, "runtime fault attemptIds") } : {}),
    ...(typeof record.reason === "string" && record.reason.length > 0 ? { reason: record.reason } : {}),
  };
}

function uniqueStringArray(value: unknown[], label: string): string[] {
  if (value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a string array`);
  }
  return [...new Set(value as string[])];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runAgentRunnerCli();
}

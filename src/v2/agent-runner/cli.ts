import { readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentHarness, HarnessRunInput, HarnessRunResult } from "../harness/types.ts";
import { createPiSdkAgentHarness } from "../harness/pi-sdk-harness.ts";
import { runTaskEnvelope, type TaskRunResult, type TaskRunnerRuntimeFault } from "./task-runner.ts";
import { refreshTaskEnvelopeV2Prompt, type TaskEnvelopeV2 } from "./task-envelope.ts";

const execFileAsync = promisify(execFile);

export async function runAgentRunnerCli(
  argv = process.argv.slice(2),
  io: { write?: (text: string) => void; writeError?: (text: string) => void } = {},
): Promise<number> {
  try {
    await prepareWorkspaceIdentity();
    const options = parseAgentRunnerArgs(argv);
    const envelope = JSON.parse(await readFile(options.envelopePath, "utf8")) as TaskEnvelopeV2;
    const refreshedEnvelope = options.contextRefreshUrl
      ? await refreshEnvelopeContext(options.contextRefreshUrl, envelope)
      : envelope;
    await loadVaultEnvFiles(options.vaultEnvDir);
    const stopHeartbeat = startHeartbeatLoop(options, refreshedEnvelope);
    const result = await (async () => {
      try {
        return await runTaskEnvelope(refreshedEnvelope, createAgentHarness(options, refreshedEnvelope), {
          requiredFields: options.requiredFields ?? requiredFieldsFromEnvelope(refreshedEnvelope),
          runtimeFault: options.runtimeFault,
          attemptId: options.attemptId,
        });
      } finally {
        await stopHeartbeat();
        await cleanupWorkspaceProcesses(process.env.SOUTHSTAR_WORKSPACE_PATH);
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
      return 0;
    }
    return result.ok ? 0 : 2;
  } catch (error) {
    (io.writeError ?? console.error)((error as Error).message);
    return 1;
  }
}

/**
 * A task may start a local development server while collecting evidence. Those
 * processes can outlive the shell/Pi tool that started them and retain the
 * runner's stdio pipe, preventing the terminal callback from ever being sent.
 * The Tork container is single-task scoped, so at task finalization it is safe
 * to terminate any remaining processes whose cwd is inside the mounted
 * workspace. This is best-effort and never masks the task result.
 */
async function cleanupWorkspaceProcesses(workspacePath: string | undefined): Promise<void> {
  if (!workspacePath) return;
  const normalizedRoot = workspacePath.replace(/\/+$/, "");
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return;
  }
  const candidates: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      const cwd = await readlink(`/proc/${entry}/cwd`);
      if (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`)) candidates.push(pid);
    } catch {
      // Process exited or its cwd is not readable; continue cleanup best-effort.
    }
  }
  for (const pid of candidates) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have exited between discovery and termination.
    }
  }
  if (candidates.length === 0) return;
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const pid of candidates) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

async function prepareWorkspaceIdentity(): Promise<void> {
  const uid = numericEnv("SOUTHSTAR_WORKSPACE_UID");
  const gid = numericEnv("SOUTHSTAR_WORKSPACE_GID");
  if (uid === undefined || gid === undefined || process.getuid?.() !== 0) return;

  const workspacePath = process.env.SOUTHSTAR_WORKSPACE_PATH;
  const paths = [workspacePath, process.env.PI_CODING_AGENT_SESSION_DIR].filter((value): value is string => Boolean(value));
  for (const path of paths) {
    try {
      await execFileAsync("chown", ["-R", `${uid}:${gid}`, path]);
    } catch {
      // A missing or read-only optional mount must not prevent the task from running.
    }
  }
  try {
    process.setgid?.(gid);
    process.setuid?.(uid);
  } catch (error) {
    throw new Error(`failed to drop task runner privileges to ${uid}:${gid}: ${(error as Error).message}`);
  }
}

function numericEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

export function parseAgentRunnerArgs(argv: string[], env: Record<string, string | undefined> = process.env) {
  const envelopePath = flagValue(argv, "--envelope") ?? env.SOUTHSTAR_ENVELOPE_PATH;
  const harnessEndpoint = flagValue(argv, "--harness-endpoint")
    ?? env.SOUTHSTAR_HARNESS_ENDPOINT
    ?? env.PI_HARNESS_ENDPOINT;
  if (!envelopePath) throw new Error("--envelope or SOUTHSTAR_ENVELOPE_PATH is required");
  const attemptId = flagValue(argv, "--attempt-id") ?? env.SOUTHSTAR_ATTEMPT_ID;
  if (!attemptId) throw new Error("--attempt-id or SOUTHSTAR_ATTEMPT_ID is required");
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
    liveEventUrl: flagValue(argv, "--live-event-url") ?? env.SOUTHSTAR_LIVE_EVENT_URL,
    heartbeatIntervalMs: numberFromEnv(flagValue(argv, "--heartbeat-interval-ms") ?? env.SOUTHSTAR_HEARTBEAT_INTERVAL_MS) ?? 10_000,
    attemptId,
    torkJobId: flagValue(argv, "--tork-job-id") ?? env.SOUTHSTAR_TORK_JOB_ID ?? env.TORK_JOB_ID,
    torkTaskId: flagValue(argv, "--tork-task-id") ?? env.SOUTHSTAR_TORK_TASK_ID ?? env.TORK_TASK_ID,
    materializationRoot: flagValue(argv, "--materialization-root") ?? env.SOUTHSTAR_MATERIALIZATION_ROOT,
    harnessTimeoutMs: numberFromEnv(flagValue(argv, "--harness-timeout-ms") ?? env.SOUTHSTAR_HARNESS_TIMEOUT_MS),
    contextRefreshUrl: flagValue(argv, "--context-refresh-url") ?? env.SOUTHSTAR_CONTEXT_REFRESH_URL,
    vaultEnvDir: flagValue(argv, "--vault-env-dir") ?? env.SOUTHSTAR_VAULT_ENV_DIR,
    runtimeFault: parseRuntimeFault(flagValue(argv, "--runtime-fault") ?? env.SOUTHSTAR_AGENT_RUNNER_FAULT),
  };
}

function createAgentHarness(options: ReturnType<typeof parseAgentRunnerArgs>, envelope: TaskEnvelopeV2): AgentHarness {
  if (options.harnessEndpoint) return createHttpHarness(options.harnessEndpoint);
  const harnessKind = options.harnessKind ?? defaultHarnessKindFromEnvelope(envelope);
  if (harnessKind !== "pi-sdk") {
    const harness = `${envelope.harness.id} (${envelope.harness.kind})`;
    throw new Error(
      `No executable harness adapter is configured for ${harness}; custom harnesses require SOUTHSTAR_HARNESS_ENDPOINT or an explicit supported SOUTHSTAR_HARNESS_KIND`,
    );
  }
  return createPiSdkAgentHarness({
    timeoutMs: options.harnessTimeoutMs ?? timeoutFromEnvelope(envelope),
    ...(options.liveEventUrl ? { onDelta: (text) => postLiveDelta(options, envelope, text) } : {}),
  });
}

function defaultHarnessKindFromEnvelope(envelope: TaskEnvelopeV2): string | undefined {
  if (envelope.harness.kind === "pi-agent" || envelope.agentProfile.provider === "pi") return "pi-sdk";
  return undefined;
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

async function postLiveDelta(options: ReturnType<typeof parseAgentRunnerArgs>, envelope: TaskEnvelopeV2, text: string): Promise<void> {
  if (!options.liveEventUrl) return;
  const taskId = envelope.taskId;
  const sessionId = envelope.session.sessionId;
  try {
    await fetch(options.liveEventUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({
        runId: envelope.runId,
        taskId,
        sessionId,
        attemptId: options.attemptId,
        eventType: "agent.message.delta",
        actorType: "subagent",
        payload: { text },
        createdAt: new Date().toISOString(),
      }),
    });
  } catch {
    // Best-effort live UI stream; callback remains authoritative.
  }
}

function startHeartbeatLoop(options: ReturnType<typeof parseAgentRunnerArgs>, envelope: TaskEnvelopeV2): () => Promise<void> {
  if (!options.heartbeatUrl) {
    return async () => undefined;
  }

  let seq = 0;
  let stopped = false;

  const sendHeartbeat = async (phase: string, message: string) => {
    if (!options.heartbeatUrl) return;
    seq += 1;
    try {
      await fetch(options.heartbeatUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({
          runId: envelope.runId,
          taskId: envelope.taskId,
          attemptId: options.attemptId,
          executorType: "tork",
          torkJobId: options.torkJobId,
          torkTaskId: options.torkTaskId,
          rootSessionId: envelope.session.sessionId,
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
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await sendHeartbeat("shutdown", "agent runner shutting down");
  };
}

export async function refreshEnvelopeContext(url: string, envelope: TaskEnvelopeV2): Promise<TaskEnvelopeV2> {
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

export function timeoutFromEnvelope(envelope: TaskEnvelopeV2): number {
  const taskTimeoutMs = (envelope.agentProfile.budgetPolicy.maxWallTimeSeconds ?? 180) * 1000;
  return Math.max(120_000, taskTimeoutMs - 30_000);
}

function requiredFieldsFromEnvelope(envelope: TaskEnvelopeV2): string[] {
  return [...new Set(envelope.artifactContracts.flatMap((contract) => contract.requiredFields))];
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

async function loadVaultEnvFiles(vaultEnvDir: string | undefined): Promise<void> {
  if (!vaultEnvDir) return;
  const entries = await readdir(vaultEnvDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(entry.name)) {
      throw new Error(`invalid vault env file name: ${entry.name}`);
    }
    const value = await readFile(join(vaultEnvDir, entry.name), "utf8");
    process.env[entry.name] = value;
  }
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
  process.exit(await runAgentRunnerCli());
}

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { createPiBrainProvider } from "../brain/pi-brain-provider.ts";
import { loadSouthstarEnv, type SouthstarEnv } from "../config/env.ts";
import { openSouthstarDb } from "../db/postgres.ts";
import { createGithubLibraryImportSourceFetcher } from "../design-library/importers/library-source-fetcher.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import { type RecoveryProviderActionInput, type RecoveryProviderActions } from "../executor/provider-actions.ts";
import { TorkClient } from "../executor/tork-client.ts";
import { TorkExecutorProvider } from "../executor/tork-provider.ts";
import { createTorkHandProvider } from "../hands/tork-hand-provider.ts";
import { createHttpPiPlannerClient, createPiSdkPlannerClient } from "../planner/pi-planner.ts";
import { createPostgresSessionStore } from "../session/postgres-session-store.ts";
import { createSouthstarRuntimeServer, type SouthstarRuntimeServer } from "./http-server.ts";
import { createRuntimeLoopRegistry } from "./runtime-loop-registry.ts";

export type RuntimeServerPidRecord = {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  cwd: string;
};

export type RuntimeServerStatusResult =
  | { status: "running"; pidFilePath: string; record: RuntimeServerPidRecord }
  | { status: "stopped"; pidFilePath: string; staleRecord?: RuntimeServerPidRecord };

export type RuntimeServerStartResult =
  | { status: "started"; pidFilePath: string; record: RuntimeServerPidRecord }
  | { status: "already-running"; pidFilePath: string; record: RuntimeServerPidRecord };

export type RuntimeServerStopResult =
  | { status: "stopped"; pidFilePath: string; record: RuntimeServerPidRecord }
  | { status: "not-running"; pidFilePath: string; staleRecord?: RuntimeServerPidRecord };

export type RuntimeServerServeResult = {
  status: "stopped";
  pidFilePath: string;
  record: RuntimeServerPidRecord;
  signal: "SIGINT" | "SIGTERM";
};

export type RuntimeServerLifecycle = ReturnType<typeof createRuntimeServerLifecycle>;

type RuntimeServerLifecycleInput = {
  pidFilePath?: string;
  cwd?: string;
  envLoader?: () => SouthstarEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  processKill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "pid" | "unref">;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, text: string) => Promise<void>;
  ensureDirectory?: (path: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  runCommand?: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const STARTUP_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

export function createRuntimeServerLifecycle(input: RuntimeServerLifecycleInput = {}) {
  const envLoader = input.envLoader ?? (() => loadSouthstarEnv());
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const processKill = input.processKill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  const spawnChild = input.spawnChild ?? ((command: string, args: string[], options: SpawnOptions) => spawn(command, args, options));
  const readTextFile = input.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const writeTextFile = input.writeTextFile ?? ((path: string, text: string) => writeFile(path, text, "utf8"));
  const ensureDirectory = input.ensureDirectory ?? ((path: string) => mkdir(path, { recursive: true }));
  const removeFile = input.removeFile ?? ((path: string) => unlink(path));
  const runCommand = input.runCommand ?? runCommandSpawned;
  const cwd = input.cwd ?? process.cwd();
  const defaultPidFilePath = resolve(cwd, input.pidFilePath ?? ".southstar/runtime-server.pid");

  return {
    async start(options: { host?: string; port?: number; pidFilePath?: string } = {}): Promise<RuntimeServerStartResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const running = await readRunningRecord(pidFilePath);
      if (running) return { status: "already-running", pidFilePath, record: running };
      const env = envLoader();

      const launcherPid = await launchServeProcess({
        pidFilePath,
        host: options.host,
        port: options.port,
        env,
      });
      if (!launcherPid || launcherPid <= 0) throw new Error("failed to launch detached Southstar runtime server");

      const started = await waitForPidRecord(launcherPid, pidFilePath);
      return { status: "started", pidFilePath, record: started };
    },

    async stop(options: { pidFilePath?: string } = {}): Promise<RuntimeServerStopResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const record = await readPidRecord(pidFilePath);
      if (!record) return { status: "not-running", pidFilePath };
      if (!isProcessRunning(record.pid)) {
        await removePidFile(pidFilePath);
        return { status: "not-running", pidFilePath, staleRecord: record };
      }

      processKill(record.pid, "SIGTERM");
      await waitForProcessExit(record.pid, SHUTDOWN_TIMEOUT_MS);
      await removePidFile(pidFilePath);
      return { status: "stopped", pidFilePath, record };
    },

    async status(options: { pidFilePath?: string } = {}): Promise<RuntimeServerStatusResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const record = await readPidRecord(pidFilePath);
      if (!record) return { status: "stopped", pidFilePath };
      if (!isProcessRunning(record.pid)) {
        await removePidFile(pidFilePath);
        return { status: "stopped", pidFilePath, staleRecord: record };
      }
      return { status: "running", pidFilePath, record };
    },

    async serve(options: { host?: string; port?: number; pidFilePath?: string } = {}): Promise<RuntimeServerServeResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const env = envLoader();
      const listen = parseListenAddress(env.serverUrl);
      const host = options.host ?? defaultRuntimeListenHost(env, listen.host);
      const port = options.port ?? listen.port;
      await maybeStartSouthstarPostgresContainer(env, { runCommand });
      const db = await connectSouthstarDbWithRetry(env.databaseUrl, { sleep });

      let server: SouthstarRuntimeServer | undefined;
      let signal: "SIGINT" | "SIGTERM" = "SIGTERM";
      const startedAt = now().toISOString();
      try {
        const publicBaseUrl = toBaseUrl(listen.host, port);
        const callbackBaseUrl = containerCallbackBaseUrl(env, publicBaseUrl, port);
        const runtime = await createRuntime(host, port, env, db, { callbackBaseUrl });
        server = runtime.server;
        const record: RuntimeServerPidRecord = {
          pid: process.pid,
          host: runtime.server.host,
          port: runtime.server.port,
          url: publicBaseUrl,
          startedAt,
          cwd,
        };
        await writePidRecord(pidFilePath, record);
        signal = await waitForShutdownSignal();
        await removePidFile(pidFilePath);
        await server.close();
        await db.close();
        return {
          status: "stopped",
          signal,
          pidFilePath,
          record,
        };
      } catch (error) {
        await removePidFile(pidFilePath);
        if (server) await server.close().catch(() => undefined);
        await db.close().catch(() => undefined);
        throw error;
      }
    },
  };

  function resolvePidFilePath(path: string | undefined): string {
    if (!path) return defaultPidFilePath;
    return resolve(cwd, path);
  }

  async function launchServeProcess(options: { pidFilePath: string; host?: string; port?: number; env: SouthstarEnv }): Promise<number> {
    const cliScriptPath = resolve(cwd, "src/v2/cli.ts");
    const tsxLocalBin = resolve(cwd, "node_modules/.bin/tsx");
    const command = existsSync(tsxLocalBin) ? tsxLocalBin : "tsx";
    const args = [cliScriptPath, "serve", "--pid-file", options.pidFilePath];
    if (options.host) args.push("--host", options.host);
    if (options.port !== undefined) args.push("--port", String(options.port));
    const logsDir = resolve(cwd, ".southstar/logs");
    const startLogPath = resolve(logsDir, "runtime-server-start.log");
    await ensureDirectory(logsDir);
    const shellCommand = `nohup setsid ${[command, ...args].map(quoteShellArg).join(" ")} >> ${quoteShellArg(startLogPath)} 2>&1 < /dev/null & echo $!`;
    const envScript = [
      `export SOUTHSTAR_DATABASE_URL=${quoteShellArg(options.env.databaseUrl)}`,
      `export SOUTHSTAR_TEST_ADMIN_DATABASE_URL=${quoteShellArg(options.env.testAdminDatabaseUrl)}`,
      `export TORK_BASE_URL=${quoteShellArg(options.env.torkBaseUrl)}`,
      `export SOUTHSTAR_SERVER_URL=${quoteShellArg(options.env.serverUrl)}`,
      ...(options.env.containerCallbackBaseUrl ? [`export SOUTHSTAR_CONTAINER_CALLBACK_BASE_URL=${quoteShellArg(options.env.containerCallbackBaseUrl)}`] : []),
      `export SOUTHSTAR_REQUIRE_DOCKER=${quoteShellArg(options.env.dockerRequired ? "1" : "0")}`,
      ...(options.env.piPlannerEndpoint ? [`export PI_PLANNER_ENDPOINT=${quoteShellArg(options.env.piPlannerEndpoint)}`] : []),
      `export SOUTHSTAR_PI_PLANNER_TIMEOUT_MS=${quoteShellArg(String(options.env.piPlannerTimeoutMs))}`,
      shellCommand,
    ].join("; ");
    const launched = await runCommand("sh", ["-lc", envScript]);
    if (launched.exitCode !== 0) {
      const detail = (launched.stderr || launched.stdout).trim();
      throw new Error(`failed to launch southstar serve process${detail ? `: ${detail}` : ""}`);
    }
    const pid = Number(launched.stdout.trim().split(/\s+/).at(-1));
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }

  async function waitForPidRecord(pid: number, pidFilePath: string): Promise<RuntimeServerPidRecord> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const record = await readPidRecord(pidFilePath);
      if (record && isProcessRunning(record.pid)) return record;
      await sleep(150);
    }
    throw new Error(`timed out waiting for Southstar runtime server startup (${STARTUP_TIMEOUT_MS}ms, launcher pid ${pid})`);
  }

  async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for process ${pid} to exit`);
  }

  function isProcessRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      processKill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return true;
      if (code === "ESRCH") return false;
      throw error;
    }
  }

  async function readRunningRecord(pidFilePath: string): Promise<RuntimeServerPidRecord | null> {
    const record = await readPidRecord(pidFilePath);
    if (!record) return null;
    if (!isProcessRunning(record.pid)) {
      await removePidFile(pidFilePath);
      return null;
    }
    return record;
  }

  async function readPidRecord(pidFilePath: string): Promise<RuntimeServerPidRecord | null> {
    try {
      const raw = JSON.parse(await readTextFile(pidFilePath)) as unknown;
      return asPidRecord(raw, pidFilePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  async function writePidRecord(pidFilePath: string, record: RuntimeServerPidRecord): Promise<void> {
    await ensureDirectory(dirname(pidFilePath));
    await writeTextFile(pidFilePath, JSON.stringify(record, null, 2));
  }

  async function removePidFile(pidFilePath: string): Promise<void> {
    try {
      await removeFile(pidFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type CreatedRuntime = {
  server: SouthstarRuntimeServer;
};

async function createRuntime(
  host: string,
  port: number,
  env: SouthstarEnv,
  db: SouthstarDb,
  options: { callbackBaseUrl?: string } = {},
): Promise<CreatedRuntime> {
  const baseUrl = options.callbackBaseUrl ?? toBaseUrl(host, port);
  const torkClient = new TorkClient({ baseUrl: env.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
  const executorProvider = new TorkExecutorProvider({
    torkClient,
    callbackUrl: `${baseUrl}/api/v2/tork/callback`,
    heartbeatUrl: `${baseUrl}/api/v2/executor/heartbeat`,
  });
  const plannerClient = env.piPlannerEndpoint
    ? createHttpPiPlannerClient({ endpoint: env.piPlannerEndpoint })
    : createPiSdkPlannerClient({ timeoutMs: env.piPlannerTimeoutMs });
  const server = await createSouthstarRuntimeServer({
    host,
    port,
    db,
    plannerClient,
    executorProvider,
    torkObservationClient: {
      capabilities: () => torkClient.capabilities(),
      getJob: (jobId) => torkClient.getJobObservation(jobId),
      getJobLogs: (jobId) => torkClient.getJobLogs(jobId),
      cancelJob: (jobId) => torkClient.cancelJob(jobId),
    },
    callbackUrl: `${baseUrl}/api/v2/tork/callback`,
    libraryImportSourceFetcher: createGithubLibraryImportSourceFetcher(),
    libraryImportLlmProvider: async ({ prompt, sourceRepoPath }) => {
      if (!env.piPlannerEndpoint && sourceRepoPath) {
        return createPiSdkPlannerClient({ cwd: sourceRepoPath, noTools: null, timeoutMs: env.piPlannerTimeoutMs }).generate(prompt);
      }
      return plannerClient.generate(prompt);
    },
    runtimeLoopRegistry: createRuntimeLoopRegistry(),
    managedRuntime: {
      sessionStore: createPostgresSessionStore(db),
      brainProvider: createPiBrainProvider(),
      handProvider: createTorkHandProvider({
        executorProvider,
        callbackUrl: `${baseUrl}/api/v2/tork/callback`,
        heartbeatUrl: `${baseUrl}/api/v2/executor/heartbeat`,
      }),
      providerActions: providerActionsFromTork(torkClient),
    },
  });
  return { server };
}

function defaultRuntimeListenHost(env: SouthstarEnv, configuredHost: string): string {
  if (env.dockerRequired && isLoopbackHost(configuredHost)) return "0.0.0.0";
  return configuredHost;
}

function containerCallbackBaseUrl(env: SouthstarEnv, publicBaseUrl: string, port: number): string {
  if (env.containerCallbackBaseUrl) return trimTrailingSlash(env.containerCallbackBaseUrl);
  const parsed = new URL(publicBaseUrl);
  if (env.dockerRequired && isLoopbackHost(parsed.hostname)) {
    return `http://172.17.0.1:${port}`;
  }
  return trimTrailingSlash(publicBaseUrl);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function providerActionsFromTork(torkClient: TorkClient): RecoveryProviderActions {
  return {
    poll: async (input: RecoveryProviderActionInput) => await torkClient.getJobObservation(input.externalJobId),
    cancel: async (input: RecoveryProviderActionInput) => {
      await torkClient.cancelJob(input.externalJobId);
      return { status: "cancelled" };
    },
  };
}

function parseListenAddress(serverUrl: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error(`invalid SOUTHSTAR_SERVER_URL: ${serverUrl}`);
  }
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port.length > 0
    ? Number(parsed.port)
    : (parsed.protocol === "https:" ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid SOUTHSTAR_SERVER_URL port: ${serverUrl}`);
  }
  return { host, port };
}

function toBaseUrl(host: string, port: number): string {
  const normalizedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${normalizedHost}:${port}`;
}

function asPidRecord(value: unknown, path: string): RuntimeServerPidRecord {
  if (!isRecord(value)) throw new Error(`invalid runtime pid file: ${path}`);
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    throw new Error(`invalid runtime pid file (pid): ${path}`);
  }
  if (typeof value.host !== "string" || value.host.length === 0) {
    throw new Error(`invalid runtime pid file (host): ${path}`);
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0) {
    throw new Error(`invalid runtime pid file (port): ${path}`);
  }
  if (typeof value.url !== "string" || value.url.length === 0) {
    throw new Error(`invalid runtime pid file (url): ${path}`);
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0) {
    throw new Error(`invalid runtime pid file (startedAt): ${path}`);
  }
  if (typeof value.cwd !== "string" || value.cwd.length === 0) {
    throw new Error(`invalid runtime pid file (cwd): ${path}`);
  }
  return {
    pid: value.pid,
    host: value.host,
    port: value.port,
    url: value.url,
    startedAt: value.startedAt,
    cwd: value.cwd,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function waitForShutdownSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise<"SIGINT" | "SIGTERM">((resolveSignal) => {
    const onSigInt = () => done("SIGINT");
    const onSigTerm = () => done("SIGTERM");
    const done = (signal: "SIGINT" | "SIGTERM") => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      resolveSignal(signal);
    };
    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);
  });
}

export async function maybeStartSouthstarPostgresContainer(
  env: SouthstarEnv,
  deps: {
    runCommand?: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    waitForTcp?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  if (!env.dockerRequired) return;
  const target = parsePostgresTarget(env.databaseUrl);
  if (!target || !isLoopbackHost(target.host)) return;
  const containerName = "southstar-postgres";
  const runCommand = deps.runCommand ?? runCommandSpawned;
  const started = await runCommand("docker", ["start", containerName]);
  if (started.exitCode !== 0) {
    const detail = (started.stderr || started.stdout).trim();
    throw new Error(`failed to auto-start docker container ${containerName}${detail ? `: ${detail}` : ""}`);
  }
  await (deps.waitForTcp ?? waitForTcpReady)(target.host, target.port, 15_000);
}

export async function connectSouthstarDbWithRetry(
  databaseUrl: string,
  deps: {
    openDb?: (url: string) => Promise<SouthstarDb>;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<SouthstarDb> {
  const openDb = deps.openDb ?? openSouthstarDb;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await openDb(databaseUrl);
    } catch (error) {
      lastError = error;
      if (!isTransientPostgresStartupError(error)) throw error;
      await sleep(250);
    }
  }
  throw new Error(`timed out connecting to Postgres within ${timeoutMs}ms: ${errorMessage(lastError)}`);
}

type PostgresTarget = {
  host: string;
  port: number;
};

function parsePostgresTarget(databaseUrl: string): PostgresTarget | undefined {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return undefined;
  const port = parsed.port.length > 0 ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { host: parsed.hostname, port };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function runCommandSpawned(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      resolveCommand({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function waitForTcpReady(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectTcp(host, port, 1_000)) return;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
  throw new Error(`postgres did not become ready at ${host}:${port} within ${timeoutMs}ms`);
}

async function canConnectTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolveConnect) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveConnect(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isTransientPostgresStartupError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("econnrefused")
    || message.includes("connection terminated unexpectedly")
    || message.includes("database system is starting up")
    || message.includes("econnreset")
    || message.includes("etimedout");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

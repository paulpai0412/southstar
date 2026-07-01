import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "pg";
import type { SouthstarEnv } from "../config/env.ts";
import { loadSouthstarEnv } from "../config/env.ts";

export type PostgresInfraStatus =
  | { status: "started" | "already-running" | "running" | "stopped" | "not-running" | "skipped"; containerName: string; reason?: string };

export type TorkInfraStatus =
  | { status: "started" | "already-running" | "running" | "stopped" | "not-running"; baseUrl: string; pidFilePath: string; pid?: number };

export type SouthstarInfraStartResult = {
  postgres: PostgresInfraStatus;
  tork: TorkInfraStatus;
};

export type SouthstarInfraStopResult = {
  tork: TorkInfraStatus;
  postgres: PostgresInfraStatus;
};

export type SouthstarInfraStatusResult = {
  postgres: PostgresInfraStatus;
  tork: TorkInfraStatus;
};

export type SouthstarInfraLifecycle = ReturnType<typeof createSouthstarInfraLifecycle>;

type InfraLifecycleInput = {
  cwd?: string;
  envLoader?: () => SouthstarEnv;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  processKill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  isProcessRunning?: (pid: number) => boolean;
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "pid" | "unref">;
  runCommand?: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, text: string) => Promise<void>;
  ensureDirectory?: (path: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
  waitForTcp?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  waitForPostgresReady?: (databaseUrl: string, timeoutMs: number) => Promise<void>;
  isTorkHealthy?: (baseUrl: string) => Promise<boolean>;
};

const POSTGRES_CONTAINER_NAME = "southstar-postgres";
const POSTGRES_STARTUP_TIMEOUT_MS = 30_000;
const TORK_STARTUP_TIMEOUT_MS = 30_000;
const TORK_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_TORK_CONFIG = `[datastore]
type = "postgres"

[runtime]
type = "docker"

[runtime.docker]
config = ""
privileged = false

[runtime.docker.image]
ttl = "24h"

[mounts.bind]
allowed = true
sources = [
]

[mounts.temp]
dir = "/tmp"
`;

export function createSouthstarInfraLifecycle(input: InfraLifecycleInput = {}) {
  const cwd = input.cwd ?? process.cwd();
  const envLoader = input.envLoader ?? (() => loadSouthstarEnv());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const processKill = input.processKill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  const isProcessRunning = input.isProcessRunning ?? defaultIsProcessRunning;
  const hasInjectedSpawnChild = Boolean(input.spawnChild);
  const spawnChild = input.spawnChild ?? ((command: string, args: string[], options: SpawnOptions) => spawn(command, args, options));
  const runCommand = input.runCommand ?? runCommandSpawned;
  const readTextFile = input.readTextFile ?? ((path) => readFile(path, "utf8"));
  const writeTextFile = input.writeTextFile ?? ((path, text) => writeFile(path, text, "utf8"));
  const ensureDirectory = input.ensureDirectory ?? ((path) => mkdir(path, { recursive: true }));
  const removeFile = input.removeFile ?? ((path) => unlink(path));
  const waitForTcp = input.waitForTcp ?? waitForTcpReady;
  const waitForPostgresReady = input.waitForPostgresReady
    ?? ((databaseUrl, timeoutMs) => waitForPostgresQueryReady(databaseUrl, timeoutMs, sleep));
  const isTorkHealthy = input.isTorkHealthy ?? defaultIsTorkHealthy;
  const torkPidFilePath = resolve(cwd, ".southstar/logs/tork.pid");

  return {
    async start(): Promise<SouthstarInfraStartResult> {
      const env = envLoader();
      const postgres = await startPostgres(env);
      const tork = await startTork(env);
      return { postgres, tork };
    },

    async stop(): Promise<SouthstarInfraStopResult> {
      const env = envLoader();
      const tork = await stopTork(env);
      const postgres = await stopPostgres(env);
      return { tork, postgres };
    },

    async status(): Promise<SouthstarInfraStatusResult> {
      const env = envLoader();
      const postgres = await postgresStatus(env);
      const tork = await torkStatus(env);
      return { postgres, tork };
    },
  };

  async function startPostgres(env: SouthstarEnv): Promise<PostgresInfraStatus> {
    const target = postgresTargetForManagedDocker(env);
    if (!target) return { status: "skipped", containerName: POSTGRES_CONTAINER_NAME, reason: "database is not a managed local docker Postgres" };
    const started = await runCommand("docker", ["start", POSTGRES_CONTAINER_NAME]);
    if (started.exitCode !== 0) {
      const detail = (started.stderr || started.stdout).trim();
      throw new Error(`failed to start docker container ${POSTGRES_CONTAINER_NAME}${detail ? `: ${detail}` : ""}`);
    }
    await waitForTcp(target.host, target.port, 15_000);
    await waitForPostgresReady(adminDatabaseUrl(env.databaseUrl), POSTGRES_STARTUP_TIMEOUT_MS);
    return { status: "started", containerName: POSTGRES_CONTAINER_NAME };
  }

  async function stopPostgres(env: SouthstarEnv): Promise<PostgresInfraStatus> {
    if (!postgresTargetForManagedDocker(env)) {
      return { status: "skipped", containerName: POSTGRES_CONTAINER_NAME, reason: "database is not a managed local docker Postgres" };
    }
    const stopped = await runCommand("docker", ["stop", POSTGRES_CONTAINER_NAME]);
    if (stopped.exitCode !== 0) {
      const detail = (stopped.stderr || stopped.stdout).trim();
      if (/No such container|not running|is not running/i.test(detail)) {
        return { status: "not-running", containerName: POSTGRES_CONTAINER_NAME };
      }
      throw new Error(`failed to stop docker container ${POSTGRES_CONTAINER_NAME}${detail ? `: ${detail}` : ""}`);
    }
    return { status: "stopped", containerName: POSTGRES_CONTAINER_NAME };
  }

  async function postgresStatus(env: SouthstarEnv): Promise<PostgresInfraStatus> {
    if (!postgresTargetForManagedDocker(env)) {
      return { status: "skipped", containerName: POSTGRES_CONTAINER_NAME, reason: "database is not a managed local docker Postgres" };
    }
    const inspected = await runCommand("docker", ["inspect", "-f", "{{.State.Running}}", POSTGRES_CONTAINER_NAME]);
    if (inspected.exitCode !== 0) return { status: "not-running", containerName: POSTGRES_CONTAINER_NAME };
    return inspected.stdout.trim() === "true"
      ? { status: "running", containerName: POSTGRES_CONTAINER_NAME }
      : { status: "stopped", containerName: POSTGRES_CONTAINER_NAME };
  }

  async function startTork(env: SouthstarEnv): Promise<TorkInfraStatus> {
    if (await isTorkHealthy(env.torkBaseUrl)) {
      return { status: "already-running", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath };
    }
    const logsDir = resolve(cwd, ".southstar/logs");
    await ensureDirectory(logsDir);
    const logPath = resolve(logsDir, "tork-standalone.log");
    const scriptPath = resolve(cwd, "scripts/run-local-tork.sh");
    const managedConfigPath = await writeManagedTorkConfig();
    const spawnEnv = {
      ...process.env,
      ...torkEnv(env),
      TORK_CONFIG: process.env.TORK_CONFIG ?? managedConfigPath,
    };
    let child: Pick<ChildProcess, "pid" | "unref">;
    if (hasInjectedSpawnChild) {
      child = spawnChild(scriptPath, [], {
        cwd,
        detached: true,
        env: spawnEnv,
        stdio: "ignore",
      });
    } else {
      const logFd = openSync(logPath, "a");
      try {
        child = spawnChild(scriptPath, [], {
          cwd,
          detached: true,
          env: spawnEnv,
          stdio: ["ignore", logFd, logFd],
        });
      } finally {
        closeSync(logFd);
      }
    }
    if (!child.pid || child.pid <= 0) throw new Error("failed to launch Tork process");
    child.unref();
    await writeTextFile(torkPidFilePath, String(child.pid));
    await waitForTorkReady(env.torkBaseUrl);
    return { status: "started", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath, pid: child.pid };
  }

  async function stopTork(env: SouthstarEnv): Promise<TorkInfraStatus> {
    const managedPid = await readManagedTorkPid();
    const pid = managedPid && isProcessRunning(managedPid)
      ? managedPid
      : await torkPidFromPort(env.torkBaseUrl);
    if (!pid) {
      await removeTorkPidFile();
      return { status: "not-running", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath };
    }
    processKill(pid, "SIGTERM");
    await waitForProcessExit(pid, TORK_SHUTDOWN_TIMEOUT_MS);
    await removeTorkPidFile();
    return { status: "stopped", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath, pid };
  }

  async function torkStatus(env: SouthstarEnv): Promise<TorkInfraStatus> {
    const pid = await readManagedTorkPid();
    if (pid && isProcessRunning(pid)) {
      return { status: "running", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath, pid };
    }
    if (await isTorkHealthy(env.torkBaseUrl)) {
      const portPid = await torkPidFromPort(env.torkBaseUrl);
      return portPid
        ? { status: "running", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath, pid: portPid }
        : { status: "running", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath };
    }
    return { status: "stopped", baseUrl: env.torkBaseUrl, pidFilePath: torkPidFilePath };
  }

  async function waitForTorkReady(baseUrl: string): Promise<void> {
    const deadline = Date.now() + TORK_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isTorkHealthy(baseUrl)) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for Tork startup at ${baseUrl}`);
  }

  async function readManagedTorkPid(): Promise<number | undefined> {
    try {
      const pid = Number((await readTextFile(torkPidFilePath)).trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async function torkPidFromPort(baseUrl: string): Promise<number | undefined> {
    const port = portFromUrl(baseUrl);
    if (!port) return undefined;
    const found = await runCommand("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"]);
    if (found.exitCode !== 0) return undefined;
    const pid = Number(found.stdout.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for process ${pid} to exit`);
  }

  async function removeTorkPidFile(): Promise<void> {
    try {
      await removeFile(torkPidFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async function writeManagedTorkConfig(): Promise<string> {
    const managedConfigPath = resolve(cwd, ".southstar/tork.generated.toml");
    const baseConfigPath = resolve(cwd, ".tools/tork/southstar.config.toml");
    let baseConfig = DEFAULT_TORK_CONFIG;
    try {
      baseConfig = await readTextFile(baseConfigPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const sourcePaths = [
      "/tmp/southstar-runs",
      resolve(homedir(), ".pi/agent"),
      cwd,
    ];
    await writeTextFile(managedConfigPath, mergeTorkBindSources(baseConfig, sourcePaths));
    return managedConfigPath;
  }
}

export function mergeTorkBindSources(configText: string, sourcePaths: string[]): string {
  const uniqueSourcePaths = unique(sourcePaths.filter((sourcePath) => sourcePath.startsWith("/")));
  const match = configText.match(/(\[mounts\.bind\][\s\S]*?sources\s*=\s*\[)([\s\S]*?)(\n\])/);
  if (!match || match.index === undefined) {
    return `${configText.trimEnd()}

[mounts.bind]
allowed = true
sources = [
${uniqueSourcePaths.map((sourcePath) => `  ${quoteTomlString(sourcePath)}`).join(",\n")}
]
`;
  }
  const existingSources = quotedTomlStrings(match[2] ?? "");
  const mergedSources = unique([...existingSources, ...uniqueSourcePaths]);
  return `${configText.slice(0, match.index)}${match[1]}
${mergedSources.map((sourcePath) => `  ${quoteTomlString(sourcePath)}`).join(",\n")}
]${configText.slice(match.index + match[0].length)}`;
}

function quotedTomlStrings(value: string): string[] {
  const matches = value.matchAll(/"((?:\\.|[^"\\])*)"/g);
  return Array.from(matches, (match) => JSON.parse(`"${match[1] ?? ""}"`) as string);
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function postgresTargetForManagedDocker(env: SouthstarEnv): { host: string; port: number } | undefined {
  if (!env.dockerRequired) return undefined;
  const target = parsePostgresTarget(env.databaseUrl);
  if (!target || !isLoopbackHost(target.host)) return undefined;
  return target;
}

function parsePostgresTarget(databaseUrl: string): { host: string; port: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") return undefined;
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { host, port };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function portFromUrl(baseUrl: string): number | undefined {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

function torkEnv(env: SouthstarEnv): Record<string, string> {
  return {
    TORK_BASE_URL: env.torkBaseUrl,
    SOUTHSTAR_SERVER_URL: env.serverUrl,
    SOUTHSTAR_DATABASE_URL: env.databaseUrl,
    SOUTHSTAR_TEST_ADMIN_DATABASE_URL: adminDatabaseUrl(env.databaseUrl),
  };
}

function adminDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    parsed.pathname = "/postgres";
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

async function defaultIsTorkHealthy(baseUrl: string): Promise<boolean> {
  for (const path of ["/health", "/api/health"]) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`);
      if (response.ok) return true;
    } catch {
      // Try the next supported health route.
    }
  }
  return false;
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCommandSpawned(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function waitForTcpReady(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const deadline = Date.now() + timeoutMs;
    const tryConnect = () => {
      const socket = new Socket();
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolveReady();
      });
      socket.once("timeout", retry);
      socket.once("error", retry);
      function retry() {
        socket.destroy();
        if (Date.now() >= deadline) {
          rejectReady(new Error(`timed out waiting for TCP ${host}:${port}`));
          return;
        }
        setTimeout(tryConnect, 150);
      }
      socket.connect(port, host);
    };
    tryConnect();
  });
}

async function waitForPostgresQueryReady(
  databaseUrl: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 1_000 });
    try {
      await client.connect();
      await client.query("select 1");
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await client.end().catch(() => undefined);
    }
    await sleep(250);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out waiting for Postgres readiness${detail}`);
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { dirname, resolve } from "node:path";

export type WebServerPidRecord = {
  pid: number;
  host: string;
  port: number;
  url: string;
  startedAt: string;
  cwd: string;
  apiUrl: string;
};

export type WebServerStatusResult =
  | { status: "running"; pidFilePath: string; record: WebServerPidRecord }
  | { status: "stopped"; pidFilePath: string; staleRecord?: WebServerPidRecord };

export type WebServerStartResult =
  | { status: "started"; pidFilePath: string; record: WebServerPidRecord }
  | { status: "already-running"; pidFilePath: string; record: WebServerPidRecord };

export type WebServerStopResult =
  | { status: "stopped"; pidFilePath: string; record: WebServerPidRecord }
  | { status: "not-running"; pidFilePath: string; staleRecord?: WebServerPidRecord };

export type WebServerLifecycle = ReturnType<typeof createWebServerLifecycle>;

type WebServerLifecycleInput = {
  cwd?: string;
  pidFilePath?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  processKill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  runCommand?: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, text: string) => Promise<void>;
  ensureDirectory?: (path: string) => Promise<void>;
  removeFile?: (path: string) => Promise<void>;
};

const WEB_STARTUP_TIMEOUT_MS = 90_000;
const WEB_SHUTDOWN_TIMEOUT_MS = 10_000;

export function createWebServerLifecycle(input: WebServerLifecycleInput = {}) {
  const cwd = input.cwd ?? process.cwd();
  const defaultPidFilePath = resolve(cwd, input.pidFilePath ?? ".southstar/web-server.pid");
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const processKill = input.processKill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  const runCommand = input.runCommand ?? runCommandSpawned;
  const readTextFile = input.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const writeTextFile = input.writeTextFile ?? ((path: string, text: string) => writeFile(path, text, "utf8"));
  const ensureDirectory = input.ensureDirectory ?? ((path: string) => mkdir(path, { recursive: true }));
  const removeFile = input.removeFile ?? ((path: string) => unlink(path));

  return {
    async start(options: { host?: string; port?: number; pidFilePath?: string; apiUrl?: string; appCwd?: string } = {}): Promise<WebServerStartResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const running = await readRunningRecord(pidFilePath);
      if (running) return { status: "already-running", pidFilePath, record: running };
      const host = options.host ?? "127.0.0.1";
      const port = options.port ?? 30141;
      const apiUrl = options.apiUrl ?? "http://127.0.0.1:3100";
      const appCwd = resolveWebAppCwd(options.appCwd);

      const launcherPid = await launchWebProcess({ host, port, apiUrl, appCwd });
      if (!launcherPid || launcherPid <= 0) throw new Error("failed to launch Southstar web server");
      await waitForTcpReady(host, port, WEB_STARTUP_TIMEOUT_MS);
      const record: WebServerPidRecord = {
        pid: launcherPid,
        host,
        port,
        url: `http://${host}:${port}`,
        startedAt: now().toISOString(),
        cwd: appCwd,
        apiUrl,
      };
      await writePidRecord(pidFilePath, record);
      return { status: "started", pidFilePath, record };
    },

    async stop(options: { pidFilePath?: string } = {}): Promise<WebServerStopResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const record = await readPidRecord(pidFilePath);
      if (!record) return { status: "not-running", pidFilePath };
      if (!isProcessRunning(record.pid)) {
        await removePidFile(pidFilePath);
        return { status: "not-running", pidFilePath, staleRecord: record };
      }
      processKill(record.pid, "SIGTERM");
      await waitForProcessExit(record.pid, WEB_SHUTDOWN_TIMEOUT_MS);
      await removePidFile(pidFilePath);
      return { status: "stopped", pidFilePath, record };
    },

    async status(options: { pidFilePath?: string } = {}): Promise<WebServerStatusResult> {
      const pidFilePath = resolvePidFilePath(options.pidFilePath);
      const record = await readPidRecord(pidFilePath);
      if (!record) return { status: "stopped", pidFilePath };
      if (!isProcessRunning(record.pid)) {
        await removePidFile(pidFilePath);
        return { status: "stopped", pidFilePath, staleRecord: record };
      }
      return { status: "running", pidFilePath, record };
    },
  };

  function resolvePidFilePath(path: string | undefined): string {
    if (!path) return defaultPidFilePath;
    return resolve(cwd, path);
  }

  function resolveWebAppCwd(explicitPath?: string): string {
    if (explicitPath && explicitPath.trim().length > 0) return resolve(explicitPath);
    if (process.env.SOUTHSTAR_WEB_APP_DIR && process.env.SOUTHSTAR_WEB_APP_DIR.trim().length > 0) {
      return resolve(process.env.SOUTHSTAR_WEB_APP_DIR);
    }
    const homeDir = process.env.HOME ?? process.env.USERPROFILE;
    if (homeDir) {
      const preferred = resolve(homeDir, "apps/southstar/southstar-web");
      if (existsSync(preferred)) return preferred;
    }
    return cwd;
  }

  async function launchWebProcess(inputLaunch: { host: string; port: number; apiUrl: string; appCwd: string }): Promise<number> {
    const nextBinLocal = resolve(inputLaunch.appCwd, "node_modules/.bin/next");
    const command = existsSync(nextBinLocal) ? nextBinLocal : "next";
    const args = ["dev", "--hostname", inputLaunch.host, "-p", String(inputLaunch.port), "--webpack"];
    const logsDir = resolve(cwd, ".southstar/logs");
    const logPath = resolve(logsDir, "web-server-start.log");
    await ensureDirectory(logsDir);
    const shellCommand = `nohup setsid ${[command, ...args].map(quoteShellArg).join(" ")} >> ${quoteShellArg(logPath)} 2>&1 < /dev/null & echo $!`;
    const envScript = [
      `cd ${quoteShellArg(inputLaunch.appCwd)}`,
      `export NEXT_PUBLIC_SOUTHSTAR_SERVER_URL=${quoteShellArg(inputLaunch.apiUrl)}`,
      `export SOUTHSTAR_SERVER_URL=${quoteShellArg(inputLaunch.apiUrl)}`,
      shellCommand,
    ].join("; ");
    const launched = await runCommand("sh", ["-lc", envScript]);
    if (launched.exitCode !== 0) {
      const detail = (launched.stderr || launched.stdout).trim();
      throw new Error(`failed to launch Southstar web server${detail ? `: ${detail}` : ""}`);
    }
    const pid = Number(launched.stdout.trim().split(/\s+/).at(-1));
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }

  async function readRunningRecord(pidFilePath: string): Promise<WebServerPidRecord | null> {
    const record = await readPidRecord(pidFilePath);
    if (!record) return null;
    if (!isProcessRunning(record.pid)) {
      await removePidFile(pidFilePath);
      return null;
    }
    return record;
  }

  async function readPidRecord(pidFilePath: string): Promise<WebServerPidRecord | null> {
    try {
      const raw = JSON.parse(await readTextFile(pidFilePath)) as unknown;
      return asPidRecord(raw, pidFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function writePidRecord(pidFilePath: string, record: WebServerPidRecord): Promise<void> {
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

  async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessRunning(pid)) return;
      await sleep(150);
    }
    throw new Error(`timed out waiting for web process ${pid} to exit`);
  }
}

function asPidRecord(value: unknown, path: string): WebServerPidRecord {
  if (!isRecord(value)) throw new Error(`invalid web pid file: ${path}`);
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) {
    throw new Error(`invalid web pid file (pid): ${path}`);
  }
  if (typeof value.host !== "string" || value.host.length === 0) {
    throw new Error(`invalid web pid file (host): ${path}`);
  }
  if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port <= 0) {
    throw new Error(`invalid web pid file (port): ${path}`);
  }
  if (typeof value.url !== "string" || value.url.length === 0) {
    throw new Error(`invalid web pid file (url): ${path}`);
  }
  if (typeof value.startedAt !== "string" || value.startedAt.length === 0) {
    throw new Error(`invalid web pid file (startedAt): ${path}`);
  }
  if (typeof value.cwd !== "string" || value.cwd.length === 0) {
    throw new Error(`invalid web pid file (cwd): ${path}`);
  }
  if (typeof value.apiUrl !== "string" || value.apiUrl.length === 0) {
    throw new Error(`invalid web pid file (apiUrl): ${path}`);
  }
  return {
    pid: value.pid,
    host: value.host,
    port: value.port,
    url: value.url,
    startedAt: value.startedAt,
    cwd: value.cwd,
    apiUrl: value.apiUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  throw new Error(`web server did not become ready at ${host}:${port} within ${timeoutMs}ms`);
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

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createPiBrainProvider } from "../../src/v2/brain/pi-brain-provider.ts";
import { createHttpPiPlannerClient, createPiSdkPlannerClient } from "../../src/v2/planner/pi-planner.ts";
import { TorkClient } from "../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";
import { createTorkHandProvider } from "../../src/v2/hands/tork-hand-provider.ts";
import { createPostgresSessionStore } from "../../src/v2/session/postgres-session-store.ts";
import { createRuntimeLoopRegistry } from "../../src/v2/server/runtime-loop-registry.ts";
import { createSouthstarRuntimeServer, type SouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { recordSandboxEvaluatorOutputPg } from "../../src/v2/evolution/sandbox.ts";
import { createGithubLibraryImportSourceFetcher } from "../../src/v2/design-library/importers/library-source-fetcher.ts";
import { prepareRuntimeLibraryPg } from "../../src/v2/server/runtime-server-lifecycle.ts";
import type { WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { LlmWorkflowComposer, loadWorkflowComposerSopPg } from "../../src/v2/orchestration/llm-composer.ts";
import { loadSouthstarEnv } from "../../src/v2/config/env.ts";

export type RealPostgresInfra = {
  postgresAdminUrl: string;
  torkBaseUrl: string;
  piPlannerEndpoint?: string;
  piHarnessEndpoint?: string;
  callbackHost: string;
};

export type RealPostgresE2EEnv = RealPostgresInfra & {
  piPlannerMode: "http" | "sdk";
  piHarnessMode: "http" | "sdk";
  workspaceRoot: string;
};

export type RealPostgresE2EProbes = {
  dockerVersion(): Promise<void>;
  southstarTaskContainersIdle(): Promise<void>;
  torkHealth(baseUrl: string): Promise<void>;
  torkQueueIdle(baseUrl: string): Promise<void>;
  piConfig(env: RealPostgresE2EEnv): Promise<void>;
};

export type RealPostgresE2E = {
  adminUrl: string;
  databaseName: string;
  databaseUrl: string;
  workdir: string;
  configPath: string;
  close(): Promise<void>;
};

export type IsolatedRealTork = {
  infra: RealPostgresInfra;
  baseUrl: string;
  databaseName: string;
  configPath: string;
  close(): Promise<void>;
};

export function renderIsolatedTorkConfig(input: {
  port: number;
  materializationRoot: string;
  workspace: string;
  piConfigPath: string;
}): string {
  const sources = [input.materializationRoot, input.workspace, input.piConfigPath]
    .map((source) => `  ${JSON.stringify(source)},`)
    .join("\n");
  return `[datastore]
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
${sources}
]

[mounts.temp]
dir = "/tmp"

[coordinator]
address = "0.0.0.0:${input.port}"
`;
}

export async function startIsolatedRealTork(input: {
  postgresAdminUrl: string;
  materializationRoot: string;
  workspace: string;
  piConfigPath?: string;
  piPlannerEndpoint?: string;
  piHarnessEndpoint?: string;
  callbackHost?: string;
}): Promise<IsolatedRealTork> {
  const databaseName = `tork_test_${randomUUID().replace(/-/g, "_")}`;
  const databaseUrl = replaceDatabase(input.postgresAdminUrl, databaseName);
  const configDir = await mkdtemp(join(tmpdir(), "southstar-tork-e2e-"));
  const configPath = join(configDir, "tork.toml");
  const port = await freeTcpPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const piConfigPath = input.piConfigPath ?? process.env.SOUTHSTAR_PI_AGENT_DIR ?? join(homedir(), ".pi/agent");
  const admin = new Client({ connectionString: input.postgresAdminUrl });
  let child: ChildProcess | undefined;
  let output = "";
  let databaseCreated = false;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (child) await stopChild(child);
    } finally {
      try {
        if (databaseCreated) {
          const cleanup = new Client({ connectionString: input.postgresAdminUrl });
          await cleanup.connect();
          try {
            await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
            await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
          } finally {
            await cleanup.end();
          }
        }
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    }
  };

  try {
    await admin.connect();
    await admin.query(`create database ${quoteIdent(databaseName)}`);
    databaseCreated = true;
    await admin.end();
    await writeFile(configPath, renderIsolatedTorkConfig({
      port,
      materializationRoot: input.materializationRoot,
      workspace: input.workspace,
      piConfigPath,
    }));
    const torkEnv = {
      ...process.env,
      TORK_CONFIG: configPath,
      TORK_BASE_URL: baseUrl,
      TORK_DATASTORE_TYPE: "postgres",
      TORK_DATASTORE_POSTGRES_DSN: postgresDsn(databaseUrl),
    };
    const migration = spawnSync("tork", ["migration"], { env: torkEnv, encoding: "utf8" });
    if (migration.status !== 0) {
      throw new Error(`isolated Tork migration failed: ${migration.stderr || migration.stdout}`);
    }
    child = spawn("tork", ["run", "standalone"], { env: torkEnv, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-64_000); });
    child.stderr?.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-64_000); });
    await waitForIsolatedTork(baseUrl, child, () => output);
    return {
      baseUrl,
      databaseName,
      configPath,
      infra: {
        postgresAdminUrl: input.postgresAdminUrl,
        torkBaseUrl: baseUrl,
        piPlannerEndpoint: input.piPlannerEndpoint,
        piHarnessEndpoint: input.piHarnessEndpoint,
        callbackHost: input.callbackHost ?? "172.17.0.1",
      },
      close,
    };
  } catch (error) {
    if (!databaseCreated) await admin.end().catch(() => {});
    await close();
    throw error;
  }
}

export async function createRealPostgresE2E(): Promise<RealPostgresE2E> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required, for example postgres://postgres:postgres@127.0.0.1:55432/postgres");
  }
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();

  const databaseUrl = replaceDatabase(adminUrl, databaseName);
  const workdir = await mkdtemp(join(tmpdir(), "southstar-postgres-e2e-"));
  const configPath = join(workdir, ".southstar.yaml");
  await writeFile(configPath, [
    'schema_version: "1.0"',
    "project:",
    "  name: southstar-postgres-e2e",
    `  root: ${workdir}`,
    "runtime:",
    `  database_url: ${databaseUrl}`,
    "  heartbeat_interval_seconds: 30",
    "  lock_timeout_seconds: 180",
    "  task_timeout_seconds: 7200",
    "  max_retry_attempts: 2",
    "intake:",
    "  mode: local",
    "sources:",
    "  local:",
    "    enabled: true",
    "projection:",
    "  local:",
    "    enabled: false",
    "    blocks_runtime: false",
    "packs:",
    "  search_paths:",
    "    - .southstar/packs",
    "workflow:",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "  path: .southstar/workflows/issue-to-pr-release.yaml",
    "agents:",
    "  path: .southstar/agents",
    "",
  ].join("\n"));

  return {
    adminUrl,
    databaseName,
    databaseUrl,
    workdir,
    configPath,
    async close() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
      await rm(workdir, { recursive: true, force: true });
    },
  };
}

export function runSouthstar(args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("npm", ["run", "southstar", "--", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`southstar ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

export function requireRealPostgresInfra(): RealPostgresInfra {
  const missing: string[] = [];
  const postgresAdminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL
    ?? derivePostgresAdminUrl(process.env.SOUTHSTAR_DATABASE_URL ?? process.env.SOUTHSTAR_DB);
  const torkBaseUrl = process.env.TORK_BASE_URL;
  if (!postgresAdminUrl) missing.push("SOUTHSTAR_TEST_ADMIN_DATABASE_URL");
  if (!torkBaseUrl) missing.push("TORK_BASE_URL");
  if (!process.env.PI_PLANNER_ENDPOINT) {
    try {
      import.meta.resolve("@earendil-works/pi-coding-agent");
    } catch {
      missing.push("PI_PLANNER_ENDPOINT or @earendil-works/pi-coding-agent");
    }
  }
  if (!process.env.PI_HARNESS_ENDPOINT) {
    try {
      import.meta.resolve("@earendil-works/pi-coding-agent");
    } catch {
      missing.push("PI_HARNESS_ENDPOINT or @earendil-works/pi-coding-agent");
    }
  }
  if (missing.length > 0) throw new Error(`Real Postgres E2E missing required infra: ${missing.join(", ")}`);
  return {
    postgresAdminUrl: postgresAdminUrl!,
    torkBaseUrl: torkBaseUrl!,
    piPlannerEndpoint: process.env.PI_PLANNER_ENDPOINT,
    piHarnessEndpoint: process.env.PI_HARNESS_ENDPOINT,
    callbackHost: process.env.SOUTHSTAR_CALLBACK_HOST ?? "172.17.0.1",
  };
}

export async function loadRealPostgresE2EEnv(
  input: Record<string, string | undefined> = process.env,
  probes: RealPostgresE2EProbes = defaultRealPostgresE2EProbes,
): Promise<RealPostgresE2EEnv> {
  const missing: string[] = [];
  const postgresAdminUrl = input.SOUTHSTAR_TEST_ADMIN_DATABASE_URL
    ?? derivePostgresAdminUrl(input.SOUTHSTAR_DATABASE_URL ?? input.SOUTHSTAR_DB);
  if (!postgresAdminUrl) missing.push("SOUTHSTAR_TEST_ADMIN_DATABASE_URL");
  if (!input.TORK_BASE_URL) missing.push("TORK_BASE_URL");
  if (missing.length > 0) {
    throw new Error(`Real Postgres E2E missing required env: ${missing.join(", ")}`);
  }

  const env: RealPostgresE2EEnv = {
    postgresAdminUrl,
    torkBaseUrl: input.TORK_BASE_URL as string,
    piPlannerEndpoint: input.PI_PLANNER_ENDPOINT,
    piHarnessEndpoint: input.PI_HARNESS_ENDPOINT,
    piPlannerMode: input.PI_PLANNER_ENDPOINT ? "http" : "sdk",
    piHarnessMode: input.PI_HARNESS_ENDPOINT ? "http" : "sdk",
    callbackHost: input.SOUTHSTAR_CALLBACK_HOST ?? "172.17.0.1",
    workspaceRoot: input.SOUTHSTAR_E2E_WORKSPACE ?? "/tmp/southstar-postgres-e2e",
  };

  await probes.dockerVersion();
  await probes.southstarTaskContainersIdle();
  await probes.torkHealth(env.torkBaseUrl);
  await probes.torkQueueIdle(env.torkBaseUrl);
  await probes.piConfig(env);
  return env;
}

function derivePostgresAdminUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    parsed.pathname = "/postgres";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const defaultRealPostgresE2EProbes: RealPostgresE2EProbes = {
  async dockerVersion() {
    execFileSync("docker", ["version"], { stdio: "pipe" });
  },
  async southstarTaskContainersIdle() {
    const output = execFileSync("docker", [
      "ps",
      "--filter",
      "ancestor=southstar/pi-agent:local",
      "--format",
      "{{.ID}} {{.Status}} {{.Names}}",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (output.length > 0) {
      throw new Error([
        "Real Postgres E2E requires no active southstar/pi-agent task containers before starting.",
        "Stop stale task containers or restart the local Tork test environment.",
        output,
      ].join("\n"));
    }
  },
  async torkHealth(baseUrl: string) {
    const root = baseUrl.replace(/\/$/, "");
    for (const path of ["/health", "/api/v1/health"]) {
      let response: Response;
      try {
        response = await fetch(`${root}${path}`);
      } catch (error) {
        throw new Error(`Tork health failed: cannot connect to ${root}${path}: ${(error as Error).message}`);
      }
      if (response.ok) return;
      if (response.status !== 404) {
        throw new Error(`Tork health failed: ${response.status} ${await response.text()}`);
      }
    }
    throw new Error("Tork health failed: no supported health endpoint responded");
  },
  async torkQueueIdle(baseUrl: string) {
    const root = baseUrl.replace(/\/$/, "");
    const response = await fetch(`${root}/jobs`);
    if (!response.ok) {
      throw new Error(`Tork queue preflight failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json() as {
      items?: Array<{ name?: string; state?: string; id?: string }>;
    };
    const activeSouthstarJobs = (payload.items ?? []).filter((job) => {
      const state = (job.state ?? "").toUpperCase();
      return typeof job.name === "string"
        && job.name.startsWith("run-wf-")
        && ["CREATED", "PENDING", "SCHEDULED", "RUNNING"].includes(state);
    });
    if (activeSouthstarJobs.length > 0) {
      throw new Error([
        "Tork queue contains active Southstar jobs; real E2E requires an idle shared Tork queue.",
        ...activeSouthstarJobs.map((job) => `${job.id ?? "unknown"} ${job.state ?? "unknown"} ${job.name}`),
      ].join("\n"));
    }
  },
  async piConfig(env: RealPostgresE2EEnv) {
    if (env.piPlannerEndpoint) {
      const plannerResponse = await fetch(env.piPlannerEndpoint, { method: "OPTIONS" });
      if (!plannerResponse.ok && plannerResponse.status !== 405) {
        throw new Error(`Pi planner endpoint probe failed: ${plannerResponse.status} ${await plannerResponse.text()}`);
      }
    }
    if (env.piHarnessEndpoint) {
      const harnessResponse = await fetch(env.piHarnessEndpoint, { method: "OPTIONS" });
      if (!harnessResponse.ok && harnessResponse.status !== 405) {
        throw new Error(`Pi harness endpoint probe failed: ${harnessResponse.status} ${await harnessResponse.text()}`);
      }
    }
    if (!env.piPlannerEndpoint || !env.piHarnessEndpoint) {
      await import("@earendil-works/pi-coding-agent");
    }
  },
};

export async function probeRealPostgresTorkPi(infra: RealPostgresInfra): Promise<void> {
  const torkRoot = infra.torkBaseUrl.replace(/\/$/, "");
  const torkResponse = await fetch(`${torkRoot}/jobs`);
  if (!torkResponse.ok) throw new Error(`Tork jobs endpoint failed: ${torkResponse.status} ${await torkResponse.text()}`);
  if (infra.piPlannerEndpoint) await probeEndpoint(infra.piPlannerEndpoint, "Pi planner");
  else await import("@earendil-works/pi-coding-agent");
  if (infra.piHarnessEndpoint) await probeEndpoint(infra.piHarnessEndpoint, "Pi harness");
  else await import("@earendil-works/pi-coding-agent");
}

export async function createInitializedRealPostgresE2E(): Promise<RealPostgresE2E & { db: SouthstarDb }> {
  const env = await createRealPostgresE2E();
  await initializeSouthstarSchema(env.databaseUrl);
  const db = await openSouthstarDb(env.databaseUrl);
  return {
    ...env,
    db,
    async close() {
      await db.close();
      await env.close();
    },
  };
}

export async function createRealRuntimeServer(input: {
  db: SouthstarDb;
  infra: RealPostgresInfra;
  workflowComposer?: WorkflowComposer;
  runRoot?: string;
  libraryRoot?: string;
}): Promise<SouthstarRuntimeServer> {
  const torkClient = new TorkClient({ baseUrl: input.infra.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
  const port = await freeTcpPort();
  const callbackBaseUrl = `http://${input.infra.callbackHost}:${port}`;
  const plannerTimeoutMs = realE2EPlannerTimeoutMs();
  const plannerClient = input.infra.piPlannerEndpoint
    ? createHttpPiPlannerClient({ endpoint: input.infra.piPlannerEndpoint })
    : createPiSdkPlannerClient({ timeoutMs: plannerTimeoutMs });
  const libraryPlannerClient = input.infra.piPlannerEndpoint
    ? createHttpPiPlannerClient({ endpoint: input.infra.piPlannerEndpoint, sessionKind: "library" })
    : createPiSdkPlannerClient({ timeoutMs: plannerTimeoutMs, sessionKind: "library" });
  const workflowPlannerClientForInput = (cwd?: string) => {
    if (input.infra.piPlannerEndpoint || !cwd) return plannerClient;
    return createPiSdkPlannerClient({ cwd, timeoutMs: plannerTimeoutMs });
  };
  const workflowComposer = input.workflowComposer ?? new LlmWorkflowComposer({
    model: process.env.SOUTHSTAR_WORKFLOW_COMPOSER_MODEL ?? "southstar-runtime-workflow-composer",
    composerSop: () => loadWorkflowComposerSopPg(input.db),
    client: {
      generateText: (request) => workflowPlannerClientForInput(request.cwd).generate(request.prompt),
      generateTextStream: plannerClient.generateStream
        ? (request, handlers) => workflowPlannerClientForInput(request.cwd).generateStream!(request.prompt, { onDelta: handlers.onDelta })
        : undefined,
    },
  });
  const executorProvider = new TorkExecutorProvider({
    torkClient,
    callbackUrl: `${callbackBaseUrl}/api/v2/tork/callback`,
    heartbeatUrl: `${callbackBaseUrl}/api/v2/executor/heartbeat`,
    liveEventUrl: `${callbackBaseUrl}/api/v2/executor/live-event`,
  });
  const libraryRoot = input.libraryRoot ?? resolve(process.cwd(), "library");
  await prepareRuntimeLibraryPg(input.db, { libraryRoot });
  return await createSouthstarRuntimeServer({
    host: "0.0.0.0",
    port,
    db: input.db as never,
    libraryRoot,
    plannerClient,
    workflowComposer,
    libraryImportSourceFetcher: createGithubLibraryImportSourceFetcher(),
    libraryImportLlmProvider: async ({ prompt, sourceRepoPath }) => {
      if (!input.infra.piPlannerEndpoint && sourceRepoPath) {
        return createPiSdkPlannerClient({
          cwd: sourceRepoPath,
          noTools: null,
          sessionKind: "library",
          timeoutMs: plannerTimeoutMs,
        }).generate(prompt);
      }
      return libraryPlannerClient.generate(prompt);
    },
    executorProvider,
    callbackUrl: `${callbackBaseUrl}/api/v2/tork/callback`,
    runtimeLoopRegistry: createRuntimeLoopRegistry(),
    managedRuntime: {
      sessionStore: createPostgresSessionStore(input.db),
      brainProvider: createPiBrainProvider(),
      handProvider: createTorkHandProvider({
        executorProvider,
        callbackUrl: `${callbackBaseUrl}/api/v2/tork/callback`,
        heartbeatUrl: `${callbackBaseUrl}/api/v2/executor/heartbeat`,
        liveEventUrl: `${callbackBaseUrl}/api/v2/executor/live-event`,
        ...(input.runRoot ? { runRoot: input.runRoot } : {}),
      }),
    },
    torkObservationClient: {
      capabilities: () => torkClient.capabilities(),
      getJob: (jobId) => torkClient.getJobObservation(jobId),
      getJobLogs: (jobId) => torkClient.getJobLogs(jobId),
      cancelJob: (jobId) => torkClient.cancelJob(jobId),
    },
    callbackUrl: "http://127.0.0.1/placeholder-until-server-starts",
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
}

export function realE2EPlannerTimeoutMs(input: Record<string, string | undefined> = process.env): number {
  return loadSouthstarEnv(input).piPlannerTimeoutMs;
}

export function dockerReachableUrl(server: SouthstarRuntimeServer, infra: RealPostgresInfra): string {
  return `http://${infra.callbackHost}:${server.port}`;
}

export async function waitForPostgresRunStatus(db: SouthstarDb, runId: string, statuses: string[], timeoutMs = 20 * 60 * 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.maybeOne<{ status: string }>("select status from southstar.workflow_runs where id = $1", [runId]);
    if (row && statuses.includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join("/")} within ${timeoutMs}ms`);
}

export async function waitForPostgresTaskCallbacks(db: SouthstarDb, runId: string, taskIds: string[], timeoutMs = 20 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.query<{ task_id: string }>(
      "select distinct task_id from southstar.workflow_history where run_id = $1 and event_type = 'executor.callback_received' and task_id = any($2::text[])",
      [runId, taskIds],
    );
    if (new Set(rows.rows.map((row) => row.task_id)).size === taskIds.length) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`run ${runId} did not receive callbacks for all tasks within ${timeoutMs}ms`);
}

export async function waitForExecutorBindingStatus(db: SouthstarDb, bindingId: string, statuses: string[], timeoutMs = 20 * 60 * 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.maybeOne<{ status: string }>(
      "select status from southstar.runtime_resources where resource_type = 'executor_binding' and resource_key = $1",
      [bindingId],
    );
    if (row && statuses.includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`executor binding ${bindingId} did not reach ${statuses.join("/")} within ${timeoutMs}ms`);
}

export async function waitForTorkJob(
  baseUrl: string,
  jobId: string,
  timeoutMs = 20 * 60 * 1000,
  terminalStatuses: string[] = ["completed", "succeeded", "success", "passed"],
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const client = new TorkClient({ baseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
  const acceptedStatuses = new Set(terminalStatuses.map((status) => status.toLowerCase()));
  while (Date.now() < deadline) {
    const observed = await client.getJobObservation(jobId);
    const status = observed.status.toLowerCase();
    if (acceptedStatuses.has(status)) return status;
    if (["failed", "errored", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`Tork job ${jobId} ended with ${status}${await torkJobDiagnosticsForError(client, jobId, observed.raw)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Tork job ${jobId} did not complete within ${timeoutMs}ms${await torkJobDiagnosticsForError(client, jobId)}`);
}

async function torkJobDiagnosticsForError(client: TorkClient, jobId: string, raw?: unknown): Promise<string> {
  const parts = [`\nTork job observation:\n${JSON.stringify(raw ?? await client.getJobObservation(jobId), null, 2).slice(-12_000)}`];
  try {
    const logs = (await client.getJobLogs(jobId)).trim();
    parts.push(`\nTork job logs:\n${logs ? logs.slice(-12_000) : "<empty>"}`);
  } catch (error) {
    parts.push(`\nTork job logs unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parts.join("");
}

export async function startSandboxEvaluatorCallbackServer(db: SouthstarDb): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = url.pathname.match(/^\/api\/v2\/evolution\/experiments\/([^/]+)\/evaluator-output$/);
      if (!match) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const body = JSON.parse(await readRequestBody(request)) as {
        variant: "baseline" | "candidate";
        caseRef: string;
        evaluatorResult: { ok: boolean; targetedReplayFixed?: boolean; metrics?: Record<string, number> };
      };
      const result = await recordSandboxEvaluatorOutputPg(db, {
        experimentId: decodeURIComponent(match[1]!),
        variant: body.variant,
        caseRef: body.caseRef,
        evaluatorResult: body.evaluatorResult,
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.statusCode = 500;
      response.end((error as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("evaluator callback server did not bind to TCP");
  return {
    url: `http://${process.env.SOUTHSTAR_CALLBACK_HOST ?? "172.17.0.1"}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function probeEndpoint(endpoint: string, label: string): Promise<void> {
  const response = await fetch(endpoint, { method: "OPTIONS" });
  if (!response.ok && response.status !== 405) throw new Error(`${label} endpoint probe failed: ${response.status} ${await response.text()}`);
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function postgresDsn(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "disable");
  return url.toString();
}

async function freeTcpPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("free port probe did not bind to TCP");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForIsolatedTork(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated Tork exited with ${child.exitCode}: ${output()}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for isolated Tork at ${baseUrl}: ${output()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

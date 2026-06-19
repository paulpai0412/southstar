import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createHttpPiPlannerClient, createPiSdkPlannerClient } from "../../src/v2/planner/pi-planner.ts";
import { TorkClient } from "../../src/v2/executor/tork-client.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer, type SouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { recordSandboxEvaluatorOutputPg } from "../../src/v2/evolution/sandbox.ts";

export type RealPostgresInfra = {
  postgresAdminUrl: string;
  torkBaseUrl: string;
  piPlannerEndpoint?: string;
  piHarnessEndpoint?: string;
  callbackHost: string;
};

export type RealPostgresE2E = {
  adminUrl: string;
  databaseName: string;
  databaseUrl: string;
  workdir: string;
  configPath: string;
  close(): Promise<void>;
};

export async function createRealPostgresE2E(): Promise<RealPostgresE2E> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required, for example postgres://postgres:postgres@127.0.0.1:5432/postgres");
  }
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();

  const databaseUrl = replaceDatabase(adminUrl, databaseName);
  const workdir = await mkdtemp(join(tmpdir(), "southstar-postgres-e2e-"));
  const configPath = join(workdir, ".northstar.yaml");
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
    "    - .northstar/packs",
    "workflow:",
    "  id: issue_to_pr_release",
    '  version: "1.0"',
    "  path: .northstar/workflows/issue-to-pr-release.yaml",
    "agents:",
    "  path: .northstar/agents",
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
  const postgresAdminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
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

export async function createRealRuntimeServer(input: { db: SouthstarDb; infra: RealPostgresInfra }): Promise<SouthstarRuntimeServer> {
  const torkClient = new TorkClient({ baseUrl: input.infra.torkBaseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
  return await createSouthstarRuntimeServer({
    host: "0.0.0.0",
    db: input.db as never,
    plannerClient: input.infra.piPlannerEndpoint
      ? createHttpPiPlannerClient({ endpoint: input.infra.piPlannerEndpoint })
      : createPiSdkPlannerClient(),
    executorProvider: new TorkExecutorProvider({ torkClient }),
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

export async function waitForTorkJob(baseUrl: string, jobId: string, timeoutMs = 20 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const client = new TorkClient({ baseUrl, requestTimeoutMs: 20_000, retryCount: 2 });
  while (Date.now() < deadline) {
    const observed = await client.getJobObservation(jobId);
    const status = observed.status.toLowerCase();
    if (["completed", "succeeded", "success", "passed"].includes(status)) return;
    if (["failed", "errored", "error", "cancelled", "canceled"].includes(status)) throw new Error(`Tork job ${jobId} ended with ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Tork job ${jobId} did not complete within ${timeoutMs}ms`);
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

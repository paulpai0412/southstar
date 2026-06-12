import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { openSouthstarDb, type SouthstarDb } from "../../../src/v2/stores/sqlite.ts";
import { createHttpPiPlannerClient, createPiSdkPlannerClient } from "../../../src/v2/planner/pi-planner.ts";
import { TorkClient } from "../../../src/v2/executor/tork-client.ts";
import { ingestTaskRunResult, type TaskRunCallbackResult } from "../../../src/v2/executor/tork-callback.ts";
import { getWorkflowRun } from "../../../src/v2/stores/run-store.ts";
import type { AgentHarness, HarnessRunResult } from "../../../src/v2/harness/types.ts";
import { createPiSdkAgentHarness } from "../../../src/v2/harness/pi-sdk-harness.ts";
import type { RealE2EEnv } from "../env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "../fixtures/software-change");

export type RealScenarioContext = {
  env: RealE2EEnv;
  db: SouthstarDb;
  plannerClient: ReturnType<typeof createHttpPiPlannerClient>;
  torkClient: TorkClient;
};

export type CallbackServer = {
  url: string;
  close(): Promise<void>;
};

export function createScenarioContext(env: RealE2EEnv): RealScenarioContext {
  return {
    env,
    db: openSouthstarDb(env.southstarDb),
    plannerClient: env.piPlannerEndpoint
      ? createHttpPiPlannerClient({ endpoint: env.piPlannerEndpoint })
      : createPiSdkPlannerClient(),
    torkClient: new TorkClient({ baseUrl: env.torkBaseUrl }),
  };
}

export async function startCallbackServer(env: RealE2EEnv): Promise<CallbackServer> {
  const db = openSouthstarDb(env.southstarDb);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/api/v2/tork/callback") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const payload = JSON.parse(await readRequestBody(request)) as TaskRunCallbackResult;
      ingestTaskRunResult(db, payload);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      response.statusCode = 500;
      response.end((error as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("callback server did not bind to a TCP port");
  const callbackHost = process.env.SOUTHSTAR_CALLBACK_HOST ?? "172.17.0.1";
  return {
    url: `http://${callbackHost}:${address.port}/api/v2/tork/callback`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export function createHttpAgentHarness(env: RealE2EEnv): AgentHarness {
  if (!env.piHarnessEndpoint) return createPiSdkAgentHarness();
  const endpoint = env.piHarnessEndpoint;
  return {
    id: "pi-agent-http-harness",
    async run(input): Promise<HarnessRunResult> {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Pi harness request failed: ${response.status} ${text}`);
      }
      const payload = JSON.parse(text) as HarnessRunResult;
      if (!payload.artifact || !Array.isArray(payload.progress)) {
        throw new Error("Pi harness response must include artifact and progress");
      }
      return payload;
    },
  };
}

export function prepareSoftwareFixtureRepo(env: RealE2EEnv, name: string): string {
  const repo = join(env.workspaceRoot, name);
  removeFixtureRepo(repo);
  mkdirSync(dirname(repo), { recursive: true });
  cpSync(fixtureRoot, repo, { recursive: true });
  run("git", ["init"], repo);
  run("git", ["config", "user.email", "southstar-e2e@example.local"], repo);
  run("git", ["config", "user.name", "Southstar E2E"], repo);
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "initial calc add fixture"], repo);
  run("npm", ["install"], repo);
  return repo;
}

export function softwareGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成一個小型軟工任務：新增 CLI 指令 calc sum <numbers...>。",
    "支援多個數字輸入、錯誤訊息、測試、README 用法，並產出 implementation artifact。",
    "artifact 必須包含修改摘要、測試指令與結果、風險、後續建議。",
    "workflow 拆成 planner、implementer、root validator、summary 四個任務。",
    "implementer 必須在 Docker/Tork task 中執行。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export function phase15OperationsGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成 Southstar Phase 1.5 operations workflow 測試：新增 CLI 指令 calc sum <numbers...>。",
    "支援多數字輸入、錯誤訊息、測試、README 用法，並產出 implementation artifact。",
    "workflow 必須拆成 planner、implementer、root validator、summary 四個任務；implementer 必須在 Docker/Tork task 中執行。",
    "artifact 必須包含修改摘要、測試指令與結果、風險、後續建議。",
    "請使用已核准的 software.calc-cli skill，保持最小改動，不新增 runtime dependency。",
    "執行期間必須輸出 progress commentary，並保存 session、artifact、executor binding、skill snapshot 到 SQLite。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export async function waitForTorkJob(baseUrl: string, jobId: string, timeoutMs = 15 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const root = baseUrl.replace(/\/$/, "");
  while (Date.now() < deadline) {
    const response = await fetchTorkJobStatus(root, jobId);
    const payload = await response.json() as { status?: string; state?: string };
    const status = (payload.status ?? payload.state ?? "").toLowerCase();
    if (status === "completed" || status === "succeeded" || status === "success") return;
    if (status === "failed" || status === "errored" || status === "cancelled") {
      throw new Error(`Tork job ${jobId} ended with ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Tork job ${jobId} did not complete within ${timeoutMs}ms`);
}

async function fetchTorkJobStatus(root: string, jobId: string): Promise<Response> {
  const encodedJobId = encodeURIComponent(jobId);
  const primary = await fetch(`${root}/jobs/${encodedJobId}`);
  if (primary.ok) return primary;
  const fallback = await fetch(`${root}/api/v1/jobs/${encodedJobId}`);
  if (fallback.ok) return fallback;
  throw new Error(`Tork job status failed: ${primary.status} ${await primary.text()}`);
}

export async function waitForRunStatus(db: SouthstarDb, runId: string, statuses: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare("select status from workflow_runs where id = ?").get(runId) as { status: string } | undefined;
    if (row && statuses.includes(row.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`run ${runId} did not reach ${statuses.join(", ")} within ${timeoutMs}ms`);
}

export function assertCalcSum(repo: string): void {
  const output = run("npm", ["run", "cli", "--", "sum", "1", "2", "3"], repo);
  assert.match(output, /6/);
}

export function assertFixtureTests(repo: string): void {
  execFileSync("docker", [
    "run",
    "--rm",
    "-v",
    `${repo}:/workspace`,
    "-w",
    "/workspace",
    "--entrypoint",
    "npm",
    "southstar/pi-agent:local",
    "test",
  ], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function assertSqliteEvidence(db: SouthstarDb): void {
  assert.equal(count(db, "workflow_runs", "status in ('passed', 'completed')") > 0, true);
  for (const eventType of [
    "evaluator.completed",
    "repair.requested",
    "workflow.expanded",
    "task.created",
    "memory.item_approved",
    "session.entry",
    "subagent.completed",
  ]) {
    assert.equal(count(db, "workflow_history", "event_type = ?", [eventType]) > 0, true, `missing ${eventType}`);
  }
  assert.equal(count(db, "runtime_resources", "resource_type = 'workflow_revision' and status = 'applied'") > 0, true);
  const metricsRows = db.prepare("select metrics_json from workflow_runs").all() as Array<{ metrics_json: string }>;
  assert.equal(metricsRows.some((row) => {
    const metrics = JSON.parse(row.metrics_json) as { aggregate?: { tokens?: number; costMicrosUsd?: number } };
    return (metrics.aggregate?.tokens ?? 0) > 0 && (metrics.aggregate?.costMicrosUsd ?? 0) >= 0;
  }), true, "missing aggregate token/cost metrics");
}

export function assertNoE2eStaticManifestUsage(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select goal_prompt from workflow_runs where id = ?").get(runId) as { goal_prompt: string } | undefined;
  assert.ok(row?.goal_prompt.includes("Fixture repo:"), "real E2E run must preserve fixture repo prompt");
}

export function assertPhase15SqliteEvidence(db: SouthstarDb, runId: string): void {
  for (const eventType of [
    "executor.submitted",
    "progress.commentary",
    "evaluator.completed",
    "session.entry",
  ]) {
    assert.equal(count(db, "workflow_history", "run_id = ? and event_type = ?", [runId, eventType]) > 0, true, `missing ${eventType}`);
  }
  assert.equal(
    count(db, "workflow_history", "run_id = ? and event_type = ?", [runId, "subagent.completed"]) >= 2,
    true,
    "missing subagent/root invocation evidence",
  );
  for (const [resourceType, status] of [
    ["artifact", "accepted"],
    ["executor_binding", "queued"],
    ["skill_snapshot", "resolved"],
  ] as const) {
    assert.equal(
      count(db, "runtime_resources", "run_id = ? and resource_type = ? and status = ?", [runId, resourceType, status]) > 0,
      true,
      `missing ${status} ${resourceType}`,
    );
  }
}

export function collectPhase15RuntimeTimings(db: SouthstarDb, runId: string): {
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  firstClientEventMs: number;
} {
  return {
    plannerMs: requireDuration(db, runId, "planner.manifest_generated"),
    validationMs: requireDuration(db, runId, "manifest.validated"),
    torkSubmitMs: requireDuration(db, runId, "executor.submitted"),
    firstClientEventMs: requireDuration(db, runId, "progress.commentary"),
  };
}

export function findForbiddenDurableFolders(projectRoot: string): string[] {
  const forbidden = [
    ".southstar/session",
    ".southstar/sessions",
    ".southstar/memory",
    ".southstar/memories",
    ".southstar/artifact",
    ".southstar/artifacts",
    ".southstar/vault",
    ".southstar/executor",
    ".southstar/skills",
  ];
  return forbidden.filter((path) => existsSync(join(projectRoot, path)));
}

export function assertNoDurableSouthstarFolders(root: string): void {
  const southstarRoot = join(root, ".southstar");
  if (!existsSync(southstarRoot)) return;
  const blockedNames = new Set(["session", "sessions", "memory", "memories", "artifact", "artifacts", "vault", "executor"]);
  const found: string[] = [];
  walk(southstarRoot, (path) => {
    const name = basename(path);
    if (blockedNames.has(name) && statSync(path).isDirectory()) found.push(path);
  });
  assert.deepEqual(found, [], `durable runtime folders are forbidden: ${found.join(", ")}`);
}

export function findImplementerTaskId(db: SouthstarDb, runId: string): string {
  const run = getWorkflowRun(db, runId);
  if (!run) throw new Error(`unknown run: ${runId}`);
  const workflow = JSON.parse(run.workflowManifestJson) as {
    tasks?: Array<{ id?: string; name?: string; subagents?: Array<{ id?: string; prompt?: string }> }>;
  };
  const task = workflow.tasks?.find((candidate) => {
    const searchable = [
      candidate.id,
      candidate.name,
      ...(candidate.subagents ?? []).map((subagent) => subagent.id),
    ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
    return /\bimplement(er|ation)?\b/.test(searchable);
  });
  if (!task?.id) throw new Error(`implementer task not found for run: ${runId}`);
  return task.id;
}

type SqlValue = string | number | bigint | Buffer | null;

function count(db: SouthstarDb, table: string, where: string, args: SqlValue[] = []): number {
  const row = db.prepare(`select count(*) as count from ${table} where ${where}`).get(...args) as { count: number };
  return row.count;
}

function requireDuration(db: SouthstarDb, runId: string, eventType: string): number {
  const row = db.prepare(`
    select payload_json
    from workflow_history
    where run_id = ? and event_type = ?
    order by sequence desc
    limit 1
  `).get(runId, eventType) as { payload_json: string } | undefined;
  assert.ok(row, `missing timing event ${eventType}`);
  const payload = JSON.parse(row.payload_json) as { durationMs?: unknown };
  assert.equal(typeof payload.durationMs, "number", `${eventType} payload.durationMs must be recorded`);
  return payload.durationMs;
}

function walk(root: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    visit(path);
    if (statSync(path).isDirectory()) walk(path, visit);
  }
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeFixtureRepo(repo: string): void {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    if (!existsSync(repo)) return;
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    execFileSync("docker", [
      "run",
      "--rm",
      "-v",
      `${repo}:/target`,
      "--entrypoint",
      "chown",
      "southstar/pi-agent:local",
      "-R",
      `${uid}:${gid}`,
      "/target",
    ], { stdio: "pipe" });
    rmSync(repo, { recursive: true, force: true });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

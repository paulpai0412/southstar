import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

export async function runPromptToArtifactUiE2E() {
  const root = mkdtempSync(join(tmpdir(), "southstar-ui-e2e-real-ui-"));
  const db = openSouthstarDb(join(root, "southstar.sqlite3"));
  const runtime = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: { generate: async () => "{}" },
    executorProvider: fakeTorkExecutor(),
  });
  const ui = await startNextUiServer(runtime.url);
  const pages = {
    planner: false,
    workflow: false,
    runtime: false,
    taskDetail: false,
    sessionsMemory: false,
    worktree: false,
    executor: false,
    domainPacks: false,
    governance: false,
  };

  try {
    const browser = await chromium.launch({ headless: true });
    let runId: string;
    try {
      const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
      await page.goto(`${ui.url}/planner`, { waitUntil: "domcontentloaded" });
      await page.getByLabel("planner input").waitFor({ timeout: 30_000 });
      await page.getByText("software-feature-complete").waitFor({ timeout: 45_000 });
      pages.planner = await page.getByText("Run Readiness").first().isVisible();

      await page.getByLabel("planner input").fill(realGoalPrompt("/tmp/southstar-ui-fixture"));
      const draftResponse = page.waitForResponse((response) => response.url().includes("/api/v2/planner/drafts") && response.request().method() === "POST", { timeout: 45_000 });
      await page.locator("section.ss-panel", { hasText: "Goal Prompt" }).locator(".ss-actions button").first().click();
      await draftResponse;
      await page.getByText(/tasks generated/i).waitFor({ timeout: 45_000 });

      const runResponse = page.waitForResponse((response) => response.url().includes("/api/v2/runs") && response.request().method() === "POST", { timeout: 45_000 });
      await page.locator("section.ss-panel", { hasText: "Goal Prompt" }).locator(".ss-actions button").nth(2).click();
      await runResponse;
      await page.waitForURL(/\/runtime\?runId=/, { timeout: 45_000 });
      runId = new URL(page.url()).searchParams.get("runId") ?? latestRunId(db);
      const taskId = firstTaskId(db, runId);

      await visit(page, `${ui.url}/runtime?runId=${encodeURIComponent(runId)}`, "Runtime Monitor");
      pages.runtime = true;
      await visit(page, `${ui.url}/workflow?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(taskId)}`, "Workflow Canvas");
      pages.workflow = true;
      await visit(page, `${ui.url}/task?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(taskId)}`, "TaskEnvelopeV2");
      pages.taskDetail = true;
      await visit(page, `${ui.url}/sessions?runId=${encodeURIComponent(runId)}`, "Sessions / Memory");
      pages.sessionsMemory = true;
      await visit(page, `${ui.url}/worktree?runId=${encodeURIComponent(runId)}`, "Worktree Console");
      pages.worktree = true;
      await visit(page, `${ui.url}/executor`, "Executor Ops");
      pages.executor = true;
      await visit(page, `${ui.url}/domain-packs`, "Domain Packs / Agent Studio");
      pages.domainPacks = true;
      await visit(page, `${ui.url}/governance`, "Vault / MCP / Approval Policy");
      pages.governance = true;
    } finally {
      await browser.close();
    }

    const finishedRunId = latestRunId(db);
    const taskCount = Number((db.prepare("select count(*) as count from workflow_tasks where run_id = ?").get(finishedRunId) as { count: number }).count);
    const historyCount = Number((db.prepare("select count(*) as count from workflow_history where run_id = ?").get(finishedRunId) as { count: number }).count);
    const runStatus = (db.prepare("select status from workflow_runs where id = ?").get(finishedRunId) as { status: string } | undefined)?.status ?? "missing";

    return {
      runId: finishedRunId,
      runStatus,
      taskCount,
      historyCount,
      plannerDraftCount: listResources(db, { resourceType: "planner_draft" }).length,
      executorBindingCount: listResources(db, { resourceType: "executor_binding" }).filter((resource) => resource.runId === finishedRunId).length,
      taskEnvelopeCount: listResources(db, { resourceType: "task_envelope" }).filter((resource) => resource.runId === finishedRunId).length,
      contextPacketCount: listResources(db, { resourceType: "context_packet" }).filter((resource) => resource.runId === finishedRunId).length,
      pages,
    };
  } finally {
    await ui.close();
    await runtime.close();
  }
}

async function startNextUiServer(runtimeUrl: string): Promise<{ url: string; close(): Promise<void> }> {
  const port = await allocatePort();
  const nextBin = process.platform === "win32" ? "node_modules/.bin/next.cmd" : "node_modules/.bin/next";
  const child = spawn(nextBin, ["dev", "-p", String(port), "--webpack"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: runtimeUrl,
      NEXT_TEST_WASM: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const baseUrl = `http://localhost:${port}`;
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (child.exitCode !== null) {
      throw new Error(`next dev exited before UI became ready (code=${child.exitCode})\n${output.join("").slice(-4000)}`);
    }
    try {
      const response = await fetch(`${baseUrl}/planner`);
      if (response.ok) {
        return {
          url: baseUrl,
          async close() {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await Promise.race([
              once(child, "exit"),
              new Promise((resolve) => setTimeout(resolve, 8_000)),
            ]);
            if (child.exitCode === null) child.kill("SIGKILL");
          },
        };
      }
    } catch {
      // keep polling
    }
    await delay(500);
  }
  child.kill("SIGKILL");
  throw new Error(`web UI did not start within 90000ms\n${output.join("").slice(-4000)}`);
}

async function allocatePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function fakeTorkExecutor(): ExecutorProvider {
  return {
    executorType: "tork",
    async submit(request) {
      return {
        executorType: "tork",
        externalJobId: `job-${request.runId}`,
        status: "PENDING",
        providerPayload: { torkJobId: `job-${request.runId}` },
        executionProjection: {
          executor: "tork",
          tasks: request.workflow.tasks.map((task) => ({ id: task.id, command: task.execution.command })),
        },
      };
    },
  };
}

function latestRunId(db: ReturnType<typeof openSouthstarDb>): string {
  const row = db.prepare("select id from workflow_runs order by updated_at desc limit 1").get() as { id: string } | undefined;
  if (!row) throw new Error("missing workflow run");
  return row.id;
}

function firstTaskId(db: ReturnType<typeof openSouthstarDb>, runId: string): string {
  const row = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order limit 1").get(runId) as { id: string } | undefined;
  if (!row) throw new Error("missing workflow task");
  return row.id;
}

async function visit(page: import("playwright").Page, url: string, text: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).first().waitFor({ timeout: 30_000 });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成一個可驗收的軟體 feature：新增 CLI 指令 calc sum <numbers...>。",
    "需求：支援多個數字參數、整數、負數、小數；invalid input 回傳非 0 exit code 並顯示 Invalid number: <value>。",
    "保留既有 CLI 行為，新增單元測試與 README 使用說明，不新增 runtime dependency。",
    "最後產出 code patch、test evidence、README evidence、evaluator report。",
    "Southstar 必須自動判斷 domain/intent，依 software domain pack 動態產生 workflow DAG。",
    "每個 task 必須解析 role、agent、model、skill、MCP、memory scope，並在執行前產生可追蹤 ContextPacket。",
    "task 必須透過 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。只有 stop condition 通過，run 才能完成。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

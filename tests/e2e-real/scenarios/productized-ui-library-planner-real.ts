import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chromium, type Page } from "playwright";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertTodoWebFeatureImplemented,
  collectPhase15RuntimeTimings,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  prepareTodoWebFeatureIssueRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";
import { todoWebFeatureScenario } from "./todo-web-feature.ts";
import { markdownTableBugfixScenario } from "./markdown-table-bugfix.ts";
import { docsCliUsageScenario } from "./docs-cli-usage.ts";
import { refactorSafetyNetScenario } from "./refactor-safety-net.ts";

export async function runProductizedUiLibraryPlannerRealScenario(env: RealE2EEnv): Promise<{
  runId: string;
  timings: {
    plannerDraftMs: number;
    validationMs: number;
    firstPlanningEventMs: number;
    draftReviewVisibleMs: number;
    operatorSheetOpenMs: number;
    appShellRouteLoadMs: number;
    e2eScenarioMs: number;
  };
}> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const todoRepo = prepareTodoWebFeatureIssueRepo(env, "productized-ui-todo-web-feature-real");
  const genericRepo = prepareSoftwareFixtureRepo(env, "productized-ui-planner-contract-real");

  const runtimeServer = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    callbackUrl: callback.url,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
    runRoot: "/tmp/southstar-runs",
  });

  const next = spawn("npm", ["run", "web:dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SOUTHSTAR_SERVER_URL: runtimeServer.url,
      NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: runtimeServer.url,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let plannerDraftMs = Number.POSITIVE_INFINITY;
  let draftReviewVisibleMs = Number.POSITIVE_INFINITY;
  let operatorSheetOpenMs = Number.POSITIVE_INFINITY;
  let appShellRouteLoadMs = Number.POSITIVE_INFINITY;

  try {
    await waitForHttp("http://localhost:3030", 90_000);
    const browser = await chromium.launch({ headless: true });
    let runId = "";

    try {
      const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
      await page.goto("http://localhost:3030", { waitUntil: "networkidle" });

      await planAndAssertDraft(page, context.db, markdownTableBugfixScenario.goalPrompt, genericRepo, (draftId) => {
        markdownTableBugfixScenario.assertPlannerDraft(context.db, draftId);
      });
      await planAndAssertDraft(page, context.db, docsCliUsageScenario.goalPrompt, genericRepo, (draftId) => {
        docsCliUsageScenario.assertPlannerDraft(context.db, draftId);
      });
      await planAndAssertDraft(page, context.db, refactorSafetyNetScenario.goalPrompt, genericRepo, (draftId) => {
        refactorSafetyNetScenario.assertPlannerDraft(context.db, draftId);
      });

      const todoPlanStartedAt = Date.now();
      await planAndAssertDraft(page, context.db, todoWebFeatureScenario.goalPrompt, todoRepo, (draftId) => {
        todoWebFeatureScenario.assertPlannerDraft(context.db, draftId);
      });
      plannerDraftMs = Date.now() - todoPlanStartedAt;

      const runVisibleStartedAt = Date.now();
      const runButton = page.getByRole("button", { name: /^Run$/ });
      await runButton.waitFor({ timeout: 30_000 });
      assert.equal(await runButton.isDisabled(), false, "Run button must be enabled for todo-web draft");
      draftReviewVisibleMs = Date.now() - runVisibleStartedAt;

      await runButton.click();
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return text.includes("Run run-") || text.includes("error");
      }, undefined, { timeout: 120_000 });
      const bodyAfterRun = await page.locator("body").innerText();
      runId = requireMatch(bodyAfterRun, /Run (run-[^\s·]+)/, "run id");
      const jobId = requireMatch(bodyAfterRun, /Tork job ([^\s]+)/, "Tork job id");

      await waitForTorkJob(env.torkBaseUrl, jobId);
      await waitForRunStatus(context.db, runId, ["passed", "completed"], 180_000);

      const routeLoadStartedAt = Date.now();
      const firstTaskId = firstTaskForRun(context.db, runId);
      await visit(page, `http://localhost:3030/runtime?runId=${encodeURIComponent(runId)}`, "Runtime Monitor");
      appShellRouteLoadMs = Date.now() - routeLoadStartedAt;

      const toggleStartedAt = Date.now();
      await page.getByRole("button", { name: "Full" }).click();
      await page.getByRole("heading", { name: "Agent Definitions" }).waitFor({ timeout: 10_000 });
      operatorSheetOpenMs = Date.now() - toggleStartedAt;

      await visit(page, `http://localhost:3030/workflow?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(firstTaskId)}`, "Workflow Canvas");
      await visit(page, `http://localhost:3030/task?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(firstTaskId)}`, "TaskEnvelopeV2");
      await visit(page, `http://localhost:3030/sessions?runId=${encodeURIComponent(runId)}`, "Sessions / Memory");
      await visit(page, `http://localhost:3030/worktree?runId=${encodeURIComponent(runId)}`, "Worktree Console");
      await visit(page, "http://localhost:3030/executor", "Executor Ops");
      await visit(page, "http://localhost:3030/domain-packs", "Domain Packs / Agent Studio");
      await visit(page, "http://localhost:3030/governance", "Vault / MCP / Approval Policy");
    } finally {
      await browser.close();
    }

    assert.ok(runId, "run id must be captured from UI");
    await assertTodoWebFeatureImplemented(todoRepo);

    const runtimeTimings = collectPhase15RuntimeTimings(context.db, runId);
    const timings = {
      plannerDraftMs,
      validationMs: runtimeTimings.validationMs,
      firstPlanningEventMs: runtimeTimings.firstClientEventMs,
      draftReviewVisibleMs,
      operatorSheetOpenMs,
      appShellRouteLoadMs,
      e2eScenarioMs: Date.now() - startedAt,
    };

    todoWebFeatureScenario.assertFinalGates(context.db, runId, timings);
    console.log("productized UI library-aware planner real scenario passed");
    return { runId, timings };
  } finally {
    await stopProcessGroup(next);
    await runtimeServer.close();
    await callback.close();
  }
}

async function planAndAssertDraft(
  page: Page,
  db: ReturnType<typeof createScenarioContext>["db"],
  goalPrompt: string,
  repoPath: string,
  assertDraft: (draftId: string) => void,
): Promise<void> {
  await page.getByLabel("planner input").fill(`${goalPrompt}\nFixture repo: ${repoPath}`);
  await page.getByRole("button", { name: "Send to Planner" }).click();
  await page.getByText(/Dynamic Workflow wf-/).waitFor({ timeout: 120_000 });
  const draftId = latestPlannerDraftId(db);
  assertDraft(draftId);
}

function latestPlannerDraftId(db: ReturnType<typeof createScenarioContext>["db"]): string {
  const row = db.prepare(`
    select resource_key
    from runtime_resources
    where resource_type = 'planner_draft'
    order by created_at desc
    limit 1
  `).get() as { resource_key: string } | undefined;
  if (!row) throw new Error("missing planner_draft resource");
  return row.resource_key;
}

function firstTaskForRun(db: ReturnType<typeof createScenarioContext>["db"], runId: string): string {
  const row = db.prepare("select id from workflow_tasks where run_id = ? order by sort_order limit 1")
    .get(runId) as { id: string } | undefined;
  if (!row) throw new Error(`missing workflow task for run ${runId}`);
  return row.id;
}

function requireMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern)?.[1];
  if (!match) throw new Error(`could not parse ${label} from UI text:\n${text}`);
  return match;
}

async function visit(page: Page, url: string, text: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByText(new RegExp(escapeRegex(text))).first().waitFor({ timeout: 30_000 });
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  if (await waitForExit(child, 8_000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForExit(child, 2_000);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs));
  return Promise.race([once(child, "exit").then(() => true), timeout]);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`web UI did not start within ${timeoutMs}ms`);
}

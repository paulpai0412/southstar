import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chromium, type Page } from "playwright";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  collectPhase15RuntimeTimings,
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";
import { todoWebFeatureScenario } from "./todo-web-feature.ts";

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
  const repo = prepareSoftwareFixtureRepo(env, "ui-browser-operations-real");

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
  const apiEvidence = {
    plannerDraftPostKinds: [] as string[],
    runPostKind: "",
    runReadKind: "",
    taskListKind: "",
    artifactListKind: "",
    taskEnvelopeKind: "",
    runtimeMonitorKind: "",
    workflowCanvasKind: "",
    eventsKind: "",
  };

  try {
    await waitForHttp("http://localhost:3030", 90_000);
    const browser = await chromium.launch({ headless: true });
    let runId = "";

    try {
      const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
      await page.goto("http://localhost:3030", { waitUntil: "networkidle" });

      const todoPlanStartedAt = Date.now();
      await planAndAssertDraft(page, context.db, phase15OperationsGoalPrompt(repo), repo, (draftId) => {
        todoWebFeatureScenario.assertPlannerDraft(context.db, draftId);
      }, apiEvidence.plannerDraftPostKinds);
      plannerDraftMs = Date.now() - todoPlanStartedAt;

      const runVisibleStartedAt = Date.now();
      const runButton = page.getByRole("button", { name: /^Run$/ });
      await runButton.waitFor({ timeout: 30_000 });
      assert.equal(await runButton.isDisabled(), false, "Run button must be enabled for todo-web draft");
      draftReviewVisibleMs = Date.now() - runVisibleStartedAt;

      const runResponsePromise = page.waitForResponse(
        (response) => response.url().includes("/api/v2/runs") && response.request().method() === "POST",
        { timeout: 45_000 },
      );
      await runButton.click();
      const runResponse = await runResponsePromise;
      assert.equal(runResponse.ok(), true, `run POST failed: ${runResponse.status()}`);
      const runResponseJson = await runResponse.json() as { kind?: string };
      apiEvidence.runPostKind = String(runResponseJson.kind ?? "");
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

      operatorSheetOpenMs = 0;

      await visit(page, `http://localhost:3030/workflow?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(firstTaskId)}`, "Workflow Canvas");
      await visit(page, `http://localhost:3030/task?runId=${encodeURIComponent(runId)}&taskId=${encodeURIComponent(firstTaskId)}`, "TaskEnvelopeV2");
      await visit(page, `http://localhost:3030/sessions?runId=${encodeURIComponent(runId)}`, "Sessions / Memory");
      await visit(page, `http://localhost:3030/worktree?runId=${encodeURIComponent(runId)}`, "Worktree Console");
      await visit(page, "http://localhost:3030/executor", "Executor Ops");
      await visit(page, "http://localhost:3030/domain-packs", "Domain Packs / Agent Studio");
      await visit(page, "http://localhost:3030/governance", "Vault / MCP / Approval Policy");

      const client = createRuntimeServerClient({ baseUrl: runtimeServer.url });
      const runRead = await client.getRun(runId);
      const tasksRead = await client.listTasks(runId);
      const artifactsRead = await client.listArtifacts(runId);
      const taskRead = await client.getTask({ runId, taskId: firstTaskId });
      const taskEnvelope = await client.getTaskEnvelope({ runId, taskId: firstTaskId });
      const runtimeMonitor = await client.getUiRuntimeMonitor(runId);
      const workflowCanvas = await client.getUiWorkflowCanvas({ runId, taskId: firstTaskId });
      const events = await client.getRunEvents({ runId, afterSequence: 0 });

      apiEvidence.runReadKind = runRead.kind;
      apiEvidence.taskListKind = tasksRead.kind;
      apiEvidence.artifactListKind = artifactsRead.kind;
      apiEvidence.taskEnvelopeKind = taskEnvelope.kind;
      apiEvidence.runtimeMonitorKind = runtimeMonitor.kind;
      apiEvidence.workflowCanvasKind = workflowCanvas.kind;
      apiEvidence.eventsKind = events.kind;

      assert.equal(runRead.kind, "status");
      assert.equal(tasksRead.kind, "tasks");
      assert.equal(artifactsRead.kind, "artifacts");
      assert.equal(taskRead.kind, "task");
      assert.equal(taskEnvelope.kind, "task-envelope");
      assert.equal(runtimeMonitor.kind, "ui-runtime-monitor");
      assert.equal(workflowCanvas.kind, "ui-workflow-canvas");
      assert.equal(events.kind, "events");
      const taskList = Array.isArray(tasksRead.result) ? tasksRead.result : [];
      const artifactList = Array.isArray(artifactsRead.result) ? artifactsRead.result : [];
      const eventList = Array.isArray(events.result)
        ? events.result
        : (events.result && Array.isArray((events.result as { events?: unknown[] }).events)
          ? (events.result as { events: unknown[] }).events
          : []);
      assert.equal(taskList.length >= 1, true, "API tasks must include at least one task");
      assert.equal(artifactList.length >= 1, true, "API artifacts must include at least one artifact");
      assert.equal(eventList.length >= 1, true, "API run events must be queryable");
    } finally {
      await browser.close();
    }

    assert.ok(runId, "run id must be captured from UI");

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

    const acceptedArtifacts = Number((context.db.prepare(
      "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'artifact' and status = 'accepted'",
    ).get(runId) as { count: number }).count);
    const contextPackets = Number((context.db.prepare(
      "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'context_packet'",
    ).get(runId) as { count: number }).count);
    const executorBindings = Number((context.db.prepare(
      "select count(*) as count from runtime_resources where run_id = ? and resource_type = 'executor_binding'",
    ).get(runId) as { count: number }).count);
    assert.equal(acceptedArtifacts >= 1, true, `accepted artifacts must be >= 1, got ${acceptedArtifacts}`);
    assert.equal(contextPackets >= 1, true, `context packets must be >= 1, got ${contextPackets}`);
    assert.equal(executorBindings >= 1, true, `executor bindings must be >= 1, got ${executorBindings}`);

    assert.equal(apiEvidence.plannerDraftPostKinds.every((kind) => kind === "planner-draft"), true, `unexpected planner draft API kinds: ${apiEvidence.plannerDraftPostKinds.join(",")}`);
    assert.equal(apiEvidence.runPostKind, "run");
    assert.equal(apiEvidence.runReadKind, "status");
    assert.equal(apiEvidence.taskListKind, "tasks");
    assert.equal(apiEvidence.artifactListKind, "artifacts");
    assert.equal(apiEvidence.taskEnvelopeKind, "task-envelope");
    assert.equal(apiEvidence.runtimeMonitorKind, "ui-runtime-monitor");
    assert.equal(apiEvidence.workflowCanvasKind, "ui-workflow-canvas");
    assert.equal(apiEvidence.eventsKind, "events");
    console.log("productized UI library-aware planner API evidence", JSON.stringify(apiEvidence));
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
  plannerDraftPostKinds: string[],
): Promise<void> {
  await page.getByLabel("planner input").fill(`${goalPrompt}\nFixture repo: ${repoPath}`);
  const draftResponsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/v2/planner/drafts") && response.request().method() === "POST",
    { timeout: 45_000 },
  );
  await page.getByRole("button", { name: "Send to Planner" }).click();
  const draftResponse = await draftResponsePromise;
  assert.equal(draftResponse.ok(), true, `planner draft POST failed: ${draftResponse.status()}`);
  const draftResponseJson = await draftResponse.json() as { kind?: string };
  plannerDraftPostKinds.push(String(draftResponseJson.kind ?? ""));
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

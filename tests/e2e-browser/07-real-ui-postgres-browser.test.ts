import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { createSouthstarRuntimeServer, type SouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import {
  appendHistoryEventPg,
  createWorkflowRunPg,
  createWorkflowTaskPg,
  upsertRuntimeResourcePg,
} from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb, type TestPostgresDb } from "../v2/postgres-test-utils.ts";

const root = join(import.meta.dirname, "../..");
const seededRunId = "run-ui-browser-07";
const seededSessionId = "session-ui-browser-07";
const seededBuildTaskId = "ui07-build";
const commandLabel = "npm run web:dev";

test("Task 7 drives the pi-web shell against real Postgres API routes in a browser", { timeout: 180_000 }, async () => {
  let db: TestPostgresDb | undefined;
  let apiServer: SouthstarRuntimeServer | undefined;
  let webApp: RunningWebApp | undefined;
  let browser: Browser | undefined;

  try {
    db = await createTestPostgresDb();
    await seedRuntimeUiState(db);
    apiServer = await startApiServer(db);
    webApp = await startNextApp(apiServer.url);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

    const clientErrors: string[] = [];
    page.on("pageerror", (error) => clientErrors.push(error.message));
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (url.includes("/_next/webpack-hmr")) return;
      clientErrors.push(`${request.method()} ${url}: ${request.failure()?.errorText ?? "request failed"}`);
    });

    await verifyChatShellAndFreeformMessage(page, webApp.url, apiServer.url, db);
    const materializedRunId = await verifyWorkflowDraftAndRun(page, webApp.url);
    await verifyOperatorAttentionFocus(page, materializedRunId);
    await verifyMobileCanvasControls(page);

    assert.deepEqual(clientErrors, []);
  } finally {
    await browser?.close();
    await webApp?.stop();
    await apiServer?.close();
    await db?.close();
  }
});

async function verifyChatShellAndFreeformMessage(
  page: Page,
  webUrl: string,
  apiUrl: string,
  db: TestPostgresDb,
): Promise<void> {
  await page.goto(`${webUrl}/chat?runId=${seededRunId}&sessionId=${seededSessionId}`);
  await expectVisible(page.locator(".ss-pi-shell"), "pi-web style shell");
  await expectVisible(page.getByRole("button", { name: "Chat" }), "Chat tab");
  await expectVisible(page.getByRole("button", { name: "Workflow" }), "Workflow tab");
  await expectVisible(page.getByRole("button", { name: "Operator" }), "Operator tab");
  await expectVisible(sectionByHeading(page, "Runs"), "session sidebar run list");
  await expectVisible(sectionByHeading(page, "Sessions"), "session sidebar sessions list");
  await expectVisible(page.getByRole("textbox", { name: "" }).or(page.locator("textarea[placeholder='Message Southstar...']")).first(), "native chat input");
  await expectVisible(page.getByRole("button", { name: "Send" }), "Send control");
  await expectVisible(page.getByRole("button", { name: "Attach image" }), "Attach image control");
  await expectVisible(page.getByLabel("Model"), "model selector");
  await expectVisible(page.getByLabel("Tool preset"), "tool preset selector");
  await expectVisible(page.getByLabel("Thinking level"), "thinking level selector");
  const fileViewer = sectionByHeading(page, "File Viewer");
  await expectVisible(fileViewer, "file viewer");
  await expectVisible(fileViewer.getByText("src/ui-browser-07.md", { exact: true }), "file reference in viewer");

  const message = `Task 7 freeform chat ${Date.now()}`;
  const chatResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v2/chat/sessions") &&
    response.request().method() === "POST",
  );
  const chatWorkspace = page.locator(".ss-native-chat-workspace");
  const input = chatWorkspace.locator("textarea[placeholder='Message Southstar...']");
  await input.fill(message);
  await chatWorkspace.getByRole("button", { name: "Send" }).click();
  const chatRouteResponse = await chatResponse;
  assert.equal(chatRouteResponse.status(), 200, await chatRouteResponse.text());
  assert.ok(chatRouteResponse.url().startsWith(apiUrl), "chat request should target real Southstar API server");
  const envelope = await chatRouteResponse.json() as { ok: true; result: { messageId: string; sessionId: string } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.result.sessionId, seededSessionId);

  await expectVisible(page.locator("article.ss-native-message.ss-user", { hasText: message }), "persisted chat message");
  await expectCount(page.locator("article.ss-native-message.ss-user", { hasText: message }), 1, "chat message should render once after persistence");
  const persisted = await db.one<{ count: string }>(
    `select count(*)::text as count
       from southstar.runtime_resources
      where resource_type = 'chat_session'
        and resource_key = $1
        and payload_json->'messages' @> $2::jsonb`,
    [seededSessionId, JSON.stringify([{ id: envelope.result.messageId, role: "user", text: message }])],
  );
  assert.equal(persisted.count, "1");
}

async function verifyWorkflowDraftAndRun(page: Page, webUrl: string): Promise<string> {
  await page.goto(`${webUrl}/workflow?runId=${seededRunId}&sessionId=${seededSessionId}`);
  await expectVisible(page.getByRole("heading", { name: "Guided workflow chat" }), "workflow planner");
  await expectVisible(page.getByRole("button", { name: "Workflow", exact: true }), "Workflow tab direct route");
  await page.locator("#workflow-goal").fill("Add priority labels and an overdue filter with browser QA evidence.");

  const draftResponse = page.waitForResponse((response) =>
    response.url().includes("/api/v2/planner/drafts") &&
    response.request().method() === "POST" &&
    response.status() === 200,
  );
  await page.getByRole("button", { name: "Plan workflow" }).click();
  const draftEnvelope = await (await draftResponse).json() as { ok: true; result: { draftId: string } };
  assert.match(draftEnvelope.result.draftId, /^draft-/);

  await expectVisible(page.locator(".ss-workflow-canvas"), "React Flow workflow canvas");
  await expectCountAtLeast(page.locator(".ss-workflow-canvas .ss-flow-node"), 2, "workflow DAG nodes");
  await expectCountAtLeast(page.locator(".ss-workflow-canvas .react-flow__edge"), 1, "workflow DAG arrows");
  await expectVisible(page.locator(".ss-workflow-canvas .react-flow__controls"), "React Flow controls");
  await expectVisible(page.locator(".ss-workflow-canvas .react-flow__minimap"), "MiniMap");
  const arrowEvidence = await page.evaluate(() => ({
    markerCount: document.querySelectorAll(".ss-workflow-canvas marker").length,
    markerEndCount: [...document.querySelectorAll(".ss-workflow-canvas path")]
      .filter((path) => path.getAttribute("marker-end"))
      .length,
  }));
  assert.ok(arrowEvidence.markerCount + arrowEvidence.markerEndCount > 0, "React Flow DAG canvas should expose arrow markers");

  const secondNode = page.locator(".ss-workflow-canvas .ss-flow-node").nth(1);
  await secondNode.click();
  const inspector = page.locator(".ss-task-inspector");
  await expectVisible(inspector, "Definition Inspector");
  await expectVisible(inspector.getByText("Role"), "role evidence");
  await expectVisible(inspector.getByText("Profile"), "profile evidence");
  await expectVisible(inspector.getByText("Skills / MCP"), "skills evidence");
  await expectVisible(inspector.getByText(/tools \d|allowed tools|tool\.workspace/), "tools evidence");

  const runResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/v2/runs") &&
    response.request().method() === "POST" &&
    response.status() === 200,
  );
  await page.getByRole("button", { name: "Run workflow" }).click();
  const runEnvelope = await (await runResponse).json() as { ok: true; result: { runId: string } };
  await page.waitForURL(/\/operations$/);
  await expectVisible(page.getByRole("heading", { name: "Active Runs" }), "Operator Active Runs after Run workflow");
  await expectVisible(page.locator(".ss-panel", { hasText: `Target run: ${runEnvelope.result.runId}` }), "Operator selected materialized run");
  return runEnvelope.result.runId;
}

async function verifyOperatorAttentionFocus(page: Page, materializedRunId: string): Promise<void> {
  await expectVisible(page.getByRole("heading", { name: "Attention Queue" }), "Operator attention queue");
  await expectVisible(page.getByText("Active run: Add priority labels and an overdue filter"), "materialized active run attention");
  await expectVisible(page.locator(".ss-panel", { hasText: `Target run: ${materializedRunId}` }), "selected materialized run");

  await page.getByRole("button", { name: /Browser requires intervention/ }).click();
  await expectVisible(page.locator(".ss-panel", {
    hasText: `Target run: ${seededRunId} · task ${seededBuildTaskId}`,
  }), "attention selection focuses intervention panel");
  await expectVisible(page.locator(".ss-workflow-canvas", { hasText: seededBuildTaskId }), "attention selection focuses DAG");
}

async function verifyMobileCanvasControls(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".ss-workflow-canvas").scrollIntoViewIfNeeded();
  await expectVisible(page.locator(".ss-workflow-canvas .react-flow__controls"), "mobile canvas controls");
  await expectVisible(page.locator(".ss-workflow-canvas .react-flow__minimap"), "mobile canvas minimap");
  await page.locator(".ss-workflow-canvas .ss-flow-node", { hasText: seededBuildTaskId }).click();
  await page.locator(".ss-panel", { hasText: `Target run: ${seededRunId} · task ${seededBuildTaskId}` }).scrollIntoViewIfNeeded();
  await expectVisible(page.locator(".ss-panel", { hasText: `Target run: ${seededRunId} · task ${seededBuildTaskId}` }), "mobile node selection");
}

async function seedRuntimeUiState(db: TestPostgresDb): Promise<void> {
  const workflow = {
    workflowId: "wf-ui-browser-07",
    tasks: [
      { id: "ui07-plan", name: "Plan UI Change", dependsOn: [], roleRef: "planner", agentProfileRef: "planner-codex" },
      { id: seededBuildTaskId, name: "Build UI Change", dependsOn: ["ui07-plan"], roleRef: "builder", agentProfileRef: "builder-codex" },
      { id: "ui07-review", name: "Review UI Change", dependsOn: [seededBuildTaskId], roleRef: "reviewer", agentProfileRef: "reviewer-codex" },
    ],
  };
  await createWorkflowRunPg(db, {
    id: seededRunId,
    status: "running",
    domain: "software",
    goalPrompt: "Browser requires intervention",
    workflowManifestJson: JSON.stringify(workflow),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  await createWorkflowTaskPg(db, { id: "ui07-plan", runId: seededRunId, taskKey: "Plan UI Change", status: "completed", sortOrder: 0, dependsOn: [] });
  await createWorkflowTaskPg(db, { id: seededBuildTaskId, runId: seededRunId, taskKey: "Build UI Change", status: "blocked", sortOrder: 1, dependsOn: ["ui07-plan"] });
  await createWorkflowTaskPg(db, { id: "ui07-review", runId: seededRunId, taskKey: "Review UI Change", status: "pending", sortOrder: 2, dependsOn: [seededBuildTaskId] });
  await appendHistoryEventPg(db, {
    runId: seededRunId,
    eventType: "run.created",
    actorType: "orchestrator",
    payload: { source: "browser-e2e" },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "session",
    resourceKey: seededSessionId,
    runId: seededRunId,
    taskId: seededBuildTaskId,
    sessionId: seededSessionId,
    scope: "session",
    status: "active",
    title: "Browser UI session",
    payload: {
      transcriptSummary: "Browser UI session payload",
      files: ["src/ui-browser-07.md"],
      messages: [{ id: "seed-message", role: "assistant", text: "Seeded browser session context." }],
    },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "chat_session",
    resourceKey: seededSessionId,
    runId: seededRunId,
    sessionId: seededSessionId,
    scope: "chat",
    status: "active",
    title: "Browser UI chat session",
    payload: {
      schemaVersion: "southstar.ui.chat_session.v1",
      sessionId: seededSessionId,
      messages: [{ id: "seed-message", role: "assistant", text: "Seeded browser session context." }],
      activeLeafId: "seed-message",
    },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "memory_item",
    resourceKey: "memory-ui-browser-07",
    runId: seededRunId,
    taskId: seededBuildTaskId,
    scope: "memory",
    status: "accepted",
    payload: { text: "Inspect src/ui-browser-07.md before retrying.", filePath: "src/ui-browser-07.md" },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "task_envelope",
    resourceKey: "task-envelope-ui-browser-07",
    runId: seededRunId,
    taskId: seededBuildTaskId,
    scope: "task",
    status: "created",
    payload: {
      envelope: {
        role: { id: "builder", responsibility: "Build the browser UI path." },
        agentProfile: { id: "builder-codex", name: "Builder Codex", provider: "codex", toolPolicy: { allowedTools: ["read", "edit", "shell"] } },
        artifactContract: { id: "implementation-report", artifactType: "implementation-report" },
        materializedLibraryRefs: {
          skillRefs: ["southstar"],
          mcpGrantRefs: ["filesystem-workspace"],
          toolGrantRefs: ["read", "edit", "shell"],
        },
      },
    },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "runtime_exception",
    resourceKey: "runtime-exception-ui-browser-07",
    runId: seededRunId,
    taskId: seededBuildTaskId,
    scope: "runtime",
    status: "observed",
    title: "Browser requires intervention",
    payload: {
      kind: "callback_missing",
      severity: "blocking",
      message: "Browser E2E selected this attention item.",
      handExecutionId: "job-ui-browser-07",
    },
  });
}

async function startApiServer(db: TestPostgresDb): Promise<SouthstarRuntimeServer> {
  return await createSouthstarRuntimeServer({
    db,
    plannerClient: { generate: async () => { throw new Error("external planner was not expected for deterministic UI draft"); } },
    executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor submit was not expected for browser UI coverage"); } },
    createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
  });
}

type RunningWebApp = {
  url: string;
  stop(): Promise<void>;
};

async function startNextApp(apiUrl: string): Promise<RunningWebApp> {
  const port = await findOpenPort(3030);
  const url = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const child = spawn("npm", ["run", "web:dev", "--", "--hostname", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      CHOKIDAR_USEPOLLING: "true",
      NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: apiUrl,
      SOUTHSTAR_SERVER_URL: apiUrl,
      WATCHPACK_POLLING: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  try {
    await waitForHttp(url, child, logs);
  } catch (error) {
    await stopDetachedProcess(child);
    throw error;
  }
  return {
    url,
    async stop() {
      await stopDetachedProcess(child);
    },
  };
}

async function findOpenPort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("could not find an open web port");
}

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function waitForHttp(url: string, child: ChildProcessWithoutNullStreams, logs: string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${commandLabel} exited early with ${child.exitCode}\n${logs.join("").slice(-4000)}`);
    }
    try {
      const response = await fetchWithTimeout(url, logs.some((line) => /Ready in \d+/.test(line)) ? 5_000 : 1_500);
      if (response.status < 500) return;
    } catch {
      // keep polling until Next binds the port
    }
    await delay(500);
  }
  throw new Error(`${commandLabel} did not become ready at ${url}\n${logs.join("").slice(-4000)}`);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function stopDetachedProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  await Promise.race([once(child, "exit"), delay(1_000)]).catch(() => undefined);
  if (!processGroupExists(child.pid)) return;
  await delay(2_000);
  if (!processGroupExists(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await Promise.race([once(child, "exit"), delay(2_000)]);
  await terminateNextDevProcessesForRoot();
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateNextDevProcessesForRoot(): Promise<void> {
  const pids = findNextDevPidsForRoot();
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // process already exited
    }
  }
  await delay(1_000);
  for (const pid of findNextDevPidsForRoot()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // process already exited
    }
  }
}

function findNextDevPidsForRoot(): number[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let cwd: string;
    let command: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      continue;
    }
    if (cwd !== root) continue;
    if (!command.includes("next")) continue;
    if (command.includes(" dev ") || command.includes("next-server")) pids.push(pid);
  }
  return pids;
}

function sectionByHeading(page: Page, heading: string): Locator {
  return page.locator("section", { has: page.getByRole("heading", { name: heading }) }).first();
}

async function expectVisible(locator: Locator, label: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await locator.isVisible(), true, label);
}

async function expectCount(locator: Locator, expected: number, label: string): Promise<void> {
  await waitUntil(label, async () => await locator.count() === expected);
  assert.equal(await locator.count(), expected, label);
}

async function expectCountAtLeast(locator: Locator, minimum: number, label: string): Promise<void> {
  await waitUntil(label, async () => await locator.count() >= minimum);
  assert.ok(await locator.count() >= minimum, label);
}

async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { getResourceByKeyPg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  createInitializedRealPostgresE2E,
  createRealRuntimeServer,
  probeRealPostgresTorkPi,
  startIsolatedRealTork,
  waitForPostgresRunStatus,
} from "../e2e-postgres/postgres-real-harness.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const LIBRARY_ROOT = resolve(ROOT, "library");
const MEMBERSHIP_MODULE_PATH = "src/membership.mjs";
const MEMBERSHIP_TEST_PATH = "tests/membership-subscription.test.mjs";
const GOAL = "Deliver a production-ready local membership subscription module in the workspace, with access control, billing state, immediate cancellation, idempotent full-refund records, and audit reporting; use only the local payment ledger in the repository and do not deploy or charge external accounts.";
const RUNTIME_BINDINGS = {
  SOUTHSTAR_AGENT_PROVIDERS: "github-copilot",
  SOUTHSTAR_AGENT_MODELS: "gpt-5.3-codex",
  SOUTHSTAR_AGENT_HARNESSES: "pi",
  SOUTHSTAR_EXECUTION_ENGINES: "tork",
  SOUTHSTAR_AGENT_IMAGES: "southstar/pi-agent:local",
} as const;

test("33 Chat /southstar executes a real Goal-to-Outcome workflow", { timeout: 60 * 60 * 1000 }, async () => {
  const previousPlannerTimeout = process.env.SOUTHSTAR_PI_PLANNER_TIMEOUT_MS;
  const previousRuntimeBindings = Object.fromEntries(
    Object.keys(RUNTIME_BINDINGS).map((key) => [key, process.env[key]]),
  );
  process.env.SOUTHSTAR_PI_PLANNER_TIMEOUT_MS ??= "600000";
  Object.assign(process.env, RUNTIME_BINDINGS);
  const startedAt = Date.now();
  const checkpoint = (message: string) => console.info(`[case33-chat +${Math.round((Date.now() - startedAt) / 1000)}s] ${message}`);
  const env = await createInitializedRealPostgresE2E();
  const libraryFilesBefore = new Set(await listWorkspaceFiles(LIBRARY_ROOT));
  const workspace = await prepareWorkspace();
  const materializationRoot = await mkdtemp("/tmp/case33-chat-materialization-");
  const snapshotRoot = join(ROOT, "artifacts", "case33-southstar-chat");
  let tork: Awaited<ReturnType<typeof startIsolatedRealTork>> | undefined;
  let runtime: Awaited<ReturnType<typeof createRealRuntimeServer>> | undefined;
  let web: RunningWebApp | undefined;
  let browser: Browser | undefined;
  let passed = false;

  await rm(snapshotRoot, { recursive: true, force: true });
  await mkdir(snapshotRoot, { recursive: true });

  try {
    execFileSync("npm", ["--prefix", "web", "run", "build"], { cwd: ROOT, stdio: "pipe" });
    checkpoint("production web build passed");
    checkpoint(`workspace=${workspace}`);
    tork = await startIsolatedRealTork({
      postgresAdminUrl: env.adminUrl,
      materializationRoot,
      workspace,
      piPlannerEndpoint: process.env.PI_PLANNER_ENDPOINT,
      piHarnessEndpoint: process.env.PI_HARNESS_ENDPOINT,
      callbackHost: process.env.SOUTHSTAR_CALLBACK_HOST,
    });
    await probeRealPostgresTorkPi(tork.infra);
    checkpoint(`real Postgres/Tork/Pi probes passed; tork=${tork.baseUrl}`);

    runtime = await createRealRuntimeServer({
      db: env.db,
      infra: tork.infra,
      runRoot: materializationRoot,
      libraryRoot: resolve(ROOT, "library"),
    });
    web = await startWebApp(runtime.url);
    checkpoint(`runtime=${runtime.url} web=${web.url}`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("console", (message) => {
      if (message.type() === "error") console.info(`[case33-browser:${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => console.info(`[case33-browser:pageerror] ${error.message}`));

    await page.goto(web.url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("chat-mode-panel").waitFor({ state: "visible", timeout: 60_000 });
    await chooseChatCwd(page, workspace);
    await captureSnapshot(page, snapshotRoot, "01-chat-workspace-selected");

    const input = page.getByTestId("chat-mode-panel").locator("textarea").last();
    await input.waitFor({ state: "visible", timeout: 30_000 });
    await input.fill("/south");
    const southstarCommand = page.getByTestId("chat-mode-panel").getByRole("button").filter({ hasText: "/southstar" }).first();
    await southstarCommand.waitFor({ state: "visible", timeout: 60_000 });
    assert.match(await southstarCommand.innerText(), /Goal|Requirements|Library|Slice|DAG|Executor/i);
    await captureSnapshot(page, snapshotRoot, "02-southstar-slash-discovered");
    checkpoint("bundled /southstar discovered from a consumer workspace without .pi resources");

    await southstarCommand.click();
    assert.match(await input.inputValue(), /^\/southstar\s/);
    await input.fill(`/southstar ${GOAL}`);
    await page.getByTestId("chat-mode-panel").getByRole("button", { name: "Send", exact: true }).click();
    checkpoint("submitted /southstar goal through Chat input");

    await waitForOpenSouthstarBox(page, "Southstar · Requirements", 20 * 60 * 1000);
    await captureSnapshot(page, snapshotRoot, "03-requirements-message-box");
    checkpoint("requirements structured message box rendered open");

    await waitForOpenSouthstarBox(page, "Southstar · Library candidates", 20 * 60 * 1000);
    const candidateBlock = page.getByTestId("library-import-candidates").last();
    await candidateBlock.waitFor({ state: "visible", timeout: 60_000 });
    assert.ok(await candidateBlock.locator('input[type="checkbox"]').count() > 0, "Library review must render selectable candidates");
    const libraryImportDraftId = await candidateBlock.getAttribute("data-draft-id");
    assert.match(libraryImportDraftId ?? "", /^library-import-/);
    await waitForAgentIdle(page, 5 * 60 * 1000);
    await captureSnapshot(page, snapshotRoot, "04-library-candidates-message-box");
    checkpoint(`Library candidates rendered for explicit Chat approval: ${libraryImportDraftId}`);

    const approvedLibraryDraftIds = new Set<string>();
    let pendingLibraryDraftId = libraryImportDraftId!;
    let sliceReady = false;
    for (let approvalRound = 1; approvalRound <= 6; approvalRound += 1) {
      approvedLibraryDraftIds.add(pendingLibraryDraftId);
      await submitLibraryApproval(page, input, pendingLibraryDraftId);
      checkpoint(`submitted explicit Library candidate approval round ${approvalRound} through Chat input: ${pendingLibraryDraftId}`);

      const next = await waitForSliceOrNewLibraryDraft(page, approvedLibraryDraftIds, 20 * 60 * 1000);
      if (next.kind === "slice") {
        sliceReady = true;
        break;
      }
      await waitForAgentIdle(page, 5 * 60 * 1000);
      const nextCandidateBlock = page.locator(`[data-testid="library-import-candidates"][data-draft-id="${next.draftId}"]`);
      assert.ok(await nextCandidateBlock.locator('input[type="checkbox"]').count() > 0, "Every additional Library review must render selectable candidates");
      await captureSnapshot(page, snapshotRoot, `04b-library-candidates-round-${approvalRound + 1}`);
      checkpoint(`additional Library coverage draft requires explicit Chat approval: ${next.draftId}`);
      pendingLibraryDraftId = next.draftId;
    }
    assert.equal(sliceReady, true, "Library coverage did not converge to a Slice after six explicit approval rounds");

    await waitForOpenSouthstarBox(page, "Southstar · Slice plan", 20 * 60 * 1000);
    await page.locator('[data-testid^="goal-slice-plan-item-"]').last().waitFor({ state: "visible", timeout: 20 * 60 * 1000 });
    await captureSnapshot(page, snapshotRoot, "05-slice-plan-message-box");
    checkpoint("non-empty slice plan structured message box rendered open");

    const compositionProgress = page
      .locator('[data-testid="agent-progress"][data-live-progress="true"]')
      .filter({ hasText: /southstar_workflow_confirm_goal_design_stream/i });
    await compositionProgress.waitFor({ state: "visible", timeout: 5 * 60 * 1000 });
    assert.match(await compositionProgress.innerText(), /planner|composer|heartbeat|goal_design/i);
    await captureSnapshot(page, snapshotRoot, "05b-composition-live-progress");
    checkpoint(`Pi streamed live DAG composition progress into Chat: ${await compositionProgress.innerText()}`);

    await waitForOpenSouthstarBox(page, "Southstar · Workflow DAG", 20 * 60 * 1000);
    await page.getByTestId("workflow-dag-block").last().waitFor({ state: "visible", timeout: 60_000 });
    assert.ok(await page.locator('[data-testid^="workflow-dag-node-"]').count() > 0, "Chat DAG must contain nodes");
    await captureSnapshot(page, snapshotRoot, "06-dag-message-box");
    checkpoint("DAG structured message box rendered open");

    const runId = await waitForOnlyRun(env.db, 5 * 60 * 1000);
    checkpoint(`run created: ${runId}`);
    await assertRunUsesAdvertisedRuntimeBindings(env.db, runId);
    checkpoint("DAG uses the host-advertised Pi provider, model, harness, engine, and local runner image");
    const liveProgress = page
      .locator('[data-testid="agent-progress"][data-live-progress="true"]')
      .filter({ hasText: /southstar_runtime_stream_run_events|task\.|run\.|executor\.|heartbeat/i });
    await liveProgress.waitFor({ state: "visible", timeout: 10 * 60 * 1000 });
    assert.match(await liveProgress.innerText(), /southstar_runtime_stream_run_events|task\.|run\.|executor\.|heartbeat/i);
    await captureSnapshot(page, snapshotRoot, "06b-executor-live-progress");
    checkpoint(`Pi streamed live runtime progress into Chat: ${await liveProgress.innerText()}`);
    const terminalStatus = await waitForPostgresRunStatus(env.db, runId, ["completed", "failed"], 40 * 60 * 1000);
    checkpoint(`run terminal: ${terminalStatus}`);
    assert.equal(terminalStatus, "completed");

    const outcome = await waitForGoalOutcome(env.db, runId, 2 * 60 * 1000);
    assert.equal(outcome.status, "satisfied", JSON.stringify(outcome.payload));
    await waitForAgentIdle(page, 5 * 60 * 1000);
    await captureSnapshot(page, snapshotRoot, "07-goal-outcome-satisfied");

    const bodyText = await page.locator("body").innerText();
    assert.match(bodyText, /southstar_workflow_run_goal/);
    assert.match(bodyText, /southstar_workflow_confirm_requirements/);
    assert.match(bodyText, /southstar_library_get_import_draft/);
    assert.match(bodyText, /southstar_library_install_import_candidates(?:_stream)?/);
    assert.match(bodyText, /southstar_workflow_confirm_goal_design/);
    assert.match(bodyText, /satisfied|completed/i);

    const evidence = await collectEvidence(env.db, runId);
    assert.ok(evidence.historyEvents.includes("executor.callback_received"), "real executor callback history is required");
    for (const resourceType of [
      "planner_draft",
      "artifact_ref",
      "hand_execution",
      "session_checkpoint",
      "workspace_snapshot",
      "requirement_evaluator_result",
      "goal_outcome",
    ]) {
      assert.ok(evidence.resourceTypes.includes(resourceType), `missing persisted ${resourceType} evidence`);
    }
    assert.ok(evidence.artifactCount > 0, "accepted artifact refs are required");
    assert.ok(evidence.sessionCount > 0, "managed Pi sessions are required");
    assert.ok(evidence.callbackCount > 0, "executor callbacks are required");
    assert.ok(evidence.evaluatorStatuses.length > 0);
    assert.equal(evidence.evaluatorStatuses.every((status) => status === "passed"), true);

    const workspaceFiles = await listWorkspaceFiles(workspace);
    assert.ok(workspaceFiles.includes(MEMBERSHIP_MODULE_PATH), "membership implementation is required");
    execFileSync("node", ["--test", MEMBERSHIP_TEST_PATH], { cwd: workspace, stdio: "pipe" });

    await writeFile(join(snapshotRoot, "evidence.json"), JSON.stringify({ runId, workspace, workspaceFiles, evidence }, null, 2), "utf8");
    checkpoint(`real Goal-to-Outcome accepted; artifacts=${evidence.artifactCount} callbacks=${evidence.callbackCount}`);
    passed = true;
  } finally {
    await browser?.close();
    await web?.stop();
    await runtime?.close();
    await tork?.close();
    await env.close();
    await removeNewLibraryFiles(LIBRARY_ROOT, libraryFilesBefore);
    await rm(materializationRoot, { recursive: true, force: true });
    if (previousPlannerTimeout === undefined) delete process.env.SOUTHSTAR_PI_PLANNER_TIMEOUT_MS;
    else process.env.SOUTHSTAR_PI_PLANNER_TIMEOUT_MS = previousPlannerTimeout;
    for (const [key, value] of Object.entries(previousRuntimeBindings)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (passed && process.env.SOUTHSTAR_KEEP_E2E_WORKSPACE !== "1") {
      await rm(workspace, { recursive: true, force: true });
    } else {
      checkpoint(`workspace preserved for diagnosis: ${workspace}`);
    }
  }
});

async function submitLibraryApproval(page: Page, input: Locator, draftId: string): Promise<void> {
  await input.fill(`I explicitly approve installing every candidate and every proposed edge currently listed for Library import draft ${draftId}. Continue the same persisted Goal through Slice, DAG, Executor, and terminal outcome; do not create a new Goal.`);
  await page.getByTestId("chat-mode-panel").getByRole("button", { name: "Send", exact: true }).click();
}

async function waitForSliceOrNewLibraryDraft(
  page: Page,
  approvedDraftIds: ReadonlySet<string>,
  timeoutMs: number,
): Promise<{ kind: "slice" } | { kind: "library"; draftId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const slice = page.getByTestId("goal-slice-plan-block").last();
    if (await slice.isVisible().catch(() => false)) return { kind: "slice" };

    const blocks = page.getByTestId("library-import-candidates");
    for (let index = (await blocks.count()) - 1; index >= 0; index -= 1) {
      const block = blocks.nth(index);
      const draftId = await block.getAttribute("data-draft-id");
      if (draftId && !approvedDraftIds.has(draftId) && await block.isVisible().catch(() => false)) {
        return { kind: "library", draftId };
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a Slice or an additional Library import draft`);
}

async function prepareWorkspace(): Promise<string> {
  const workspace = await mkdtemp("/tmp/southstar-chat-e2e-workspace-");
  await mkdir(join(workspace, "tests"), { recursive: true });
  await writeFile(join(workspace, "README.md"), "# Southstar Chat E2E workspace\n", "utf8");
  await writeFile(join(workspace, MEMBERSHIP_TEST_PATH), `
import assert from "node:assert/strict";
import test from "node:test";
import { LocalPaymentLedger, MembershipService } from "../src/membership.mjs";

test("membership subscription lifecycle is persisted, access-controlled, refundable, and auditable", () => {
  const ledger = new LocalPaymentLedger();
  const service = new MembershipService({ ledger });

  assert.equal(service.canAccess("account-a", "premium-course"), false);
  const subscription = service.subscribe({ accountId: "account-a", planId: "pro", amountCents: 1200 });
  assert.equal(subscription.status, "active");
  assert.equal(service.canAccess("account-a", "premium-course"), true);

  const cancellation = service.cancel({ accountId: "account-a", reason: "user-request" });
  assert.equal(cancellation.status, "cancelled");
  assert.equal(cancellation.refund.amountCents, 1200);
  assert.equal(service.canAccess("account-a", "premium-course"), false);

  const secondCancellation = service.cancel({ accountId: "account-a", reason: "user-request" });
  assert.equal(secondCancellation.refund.id, cancellation.refund.id);
  assert.equal(ledger.refunds().length, 1);
  assert.deepEqual(service.auditReport().map((event) => event.type), ["charge", "subscription_activated", "refund", "subscription_cancelled"]);
});
`, "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Southstar E2E"], { cwd: workspace, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "southstar-e2e@example.invalid"], { cwd: workspace, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initialize E2E workspace"], { cwd: workspace, stdio: "pipe" });
  return workspace;
}

async function assertRunUsesAdvertisedRuntimeBindings(
  db: Awaited<ReturnType<typeof createInitializedRealPostgresE2E>>["db"],
  runId: string,
): Promise<void> {
  const run = await db.one<{ workflow_manifest_json: SouthstarWorkflowManifest }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  assert.ok(run.workflow_manifest_json.tasks.length > 0, "composed DAG must contain executable tasks");
  for (const task of run.workflow_manifest_json.tasks) {
    assert.equal(task.execution.engine, RUNTIME_BINDINGS.SOUTHSTAR_EXECUTION_ENGINES, `${task.id} execution engine`);
    assert.equal(task.execution.image, RUNTIME_BINDINGS.SOUTHSTAR_AGENT_IMAGES, `${task.id} runner image`);
  }
  assert.ok((run.workflow_manifest_json.agentProfiles?.length ?? 0) > 0, "composed DAG must bind agent profiles");
  for (const profile of run.workflow_manifest_json.agentProfiles ?? []) {
    assert.equal(profile.provider, RUNTIME_BINDINGS.SOUTHSTAR_AGENT_PROVIDERS, `${profile.id} provider`);
    assert.equal(profile.model, RUNTIME_BINDINGS.SOUTHSTAR_AGENT_MODELS, `${profile.id} model`);
    assert.equal(profile.harnessRef, RUNTIME_BINDINGS.SOUTHSTAR_AGENT_HARNESSES, `${profile.id} harness`);
  }
}

async function chooseChatCwd(page: Page, workspace: string): Promise<void> {
  const sidebar = page.getByTestId("chat-sidebar-panel");
  const scopeButton = sidebar.getByTestId("chat-project-scope-button");
  await scopeButton.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1_000);
  await scopeButton.click();
  const customPath = sidebar.getByTestId("chat-project-scope-custom");
  if (!await customPath.isVisible()) {
    await scopeButton.click();
  }
  await customPath.waitFor({ state: "visible", timeout: 30_000 });
  await customPath.click();
  const input = sidebar.getByTestId("chat-project-scope-custom-path");
  await input.fill(workspace);
  const validation = page.waitForResponse((response) => response.url().endsWith("/api/cwd/validate") && response.request().method() === "POST");
  await sidebar.getByTestId("chat-project-scope-open").click();
  const response = await validation;
  assert.equal(response.status(), 200, await response.text());
  await page.waitForFunction((expected) => {
    const labels = Array.from(document.querySelectorAll('[data-testid="chat-sidebar-panel"] [title]'));
    return labels.some((element) => element.getAttribute("title") === expected);
  }, workspace, { timeout: 30_000 });
}

async function waitForOpenSouthstarBox(page: Page, title: string, timeout: number): Promise<void> {
  const summary = page.locator("summary").filter({ hasText: title }).last();
  await summary.waitFor({ state: "visible", timeout });
  const details = summary.locator("..");
  assert.notEqual(await details.getAttribute("open"), null, `${title} must be open by default`);
}

async function waitForAgentIdle(page: Page, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const input = page.getByTestId("chat-mode-panel").locator("textarea").last();
    const placeholder = await input.getAttribute("placeholder");
    if (placeholder?.startsWith("Message")) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`Chat agent did not become idle within ${timeout}ms`);
}

async function waitForOnlyRun(
  db: Awaited<ReturnType<typeof createInitializedRealPostgresE2E>>["db"],
  timeout: number,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await db.query<{ id: string }>("select id from southstar.workflow_runs order by created_at");
    if (result.rows.length === 1) return result.rows[0]!.id;
    if (result.rows.length > 1) throw new Error(`expected one Chat-created run, found ${result.rows.length}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`Chat did not create a workflow run within ${timeout}ms`);
}

async function waitForGoalOutcome(
  db: Awaited<ReturnType<typeof createInitializedRealPostgresE2E>>["db"],
  runId: string,
  timeout: number,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const outcome = await getResourceByKeyPg(db, "goal_outcome", `goal-outcome:${runId}`);
    if (outcome) return outcome;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`goal outcome not persisted for ${runId} within ${timeout}ms`);
}

async function collectEvidence(
  db: Awaited<ReturnType<typeof createInitializedRealPostgresE2E>>["db"],
  runId: string,
) {
  const history = await db.query<{ event_type: string }>(
    "select event_type from southstar.workflow_history where run_id = $1 order by id",
    [runId],
  );
  const resources = await db.query<{ resource_type: string; status: string }>(
    "select resource_type, status from southstar.runtime_resources where run_id = $1 order by created_at",
    [runId],
  );
  const plannerDraft = await db.query<{ resource_type: string; status: string }>(
    `select rr.resource_type, rr.status
       from southstar.workflow_runs wr
       join southstar.runtime_resources rr
         on rr.resource_type = 'planner_draft'
        and rr.resource_key = wr.runtime_context_json ->> 'draftId'
      where wr.id = $1`,
    [runId],
  );
  const persistedResources = [...resources.rows, ...plannerDraft.rows];
  const sessionCount = await db.one<{ count: number }>(
    "select count(distinct session_id)::int as count from southstar.runtime_resources where run_id = $1 and session_id is not null",
    [runId],
  );
  return {
    historyEvents: [...new Set(history.rows.map((row) => row.event_type))],
    resourceTypes: [...new Set(persistedResources.map((row) => row.resource_type))],
    artifactCount: persistedResources.filter((row) => row.resource_type === "artifact_ref" && row.status === "accepted").length,
    sessionCount: Number(sessionCount.count),
    callbackCount: history.rows.filter((row) => row.event_type === "executor.callback_received").length,
    evaluatorStatuses: persistedResources.filter((row) => row.resource_type === "requirement_evaluator_result").map((row) => row.status),
  };
}

async function captureSnapshot(page: Page, root: string, name: string): Promise<void> {
  const text = await page.locator("body").innerText();
  await writeFile(join(root, `${name}.txt`), text, "utf8");
  await page.screenshot({ path: join(root, `${name}.png`), fullPage: true });
}

async function listWorkspaceFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") files.push(...await listWorkspaceFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

async function removeNewLibraryFiles(root: string, before: Set<string>): Promise<void> {
  const after = await listWorkspaceFiles(root);
  await Promise.all(after.filter((file) => !before.has(file)).map((file) => rm(join(root, file), { force: true })));
}

type RunningWebApp = { url: string; stop(): Promise<void> };

async function startWebApp(apiUrl: string): Promise<RunningWebApp> {
  const port = await freeTcpPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("npm", ["--prefix", "web", "run", "start", "--", "--hostname", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      SOUTHSTAR_WEB_APP_DIR: resolve(ROOT, "web"),
      NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: apiUrl,
      SOUTHSTAR_SERVER_URL: apiUrl,
      SOUTHSTAR_RUNTIME_URL: apiUrl,
      SOUTHSTAR_V2_API_BASE_URL: apiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => console.info(`[case33-web:stdout] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", (chunk) => console.info(`[case33-web:stderr] ${String(chunk).trimEnd()}`));
  await waitForHttp(url, child);
  return { url, stop: () => stopChild(child) };
}

async function freeTcpPort(): Promise<number> {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!port) throw new Error("failed to allocate web port");
  return port;
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next app exited early with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Wait for Next to bind.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Next app did not become ready at ${url}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([once(child, "exit"), new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000))]);
}

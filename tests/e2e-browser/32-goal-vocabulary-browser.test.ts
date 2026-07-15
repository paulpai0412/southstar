import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { loadLibraryReadinessPg } from "../../src/v2/design-library/files/library-reconcile-service.ts";
import { findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import { loadGoalDesignSkillPg } from "../../src/v2/orchestration/goal-design.ts";
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
const WORKSPACE = process.env.SOUTHSTAR_E2E_PROJECT_CWD
  ?? process.env.SOUTHSTAR_CASE32_PROJECT_CWD
  ?? join(process.env.HOME ?? "/home/timmypai", "apps", "southstar-vocab");
const GOAL = "Build the smallest useful local vocabulary flashcard system in this workspace. Keep the confirmed requirement list concise: produce exactly two blocking requirements (R1 add/list words with translation and example, R2 run a quiz with persisted answers and session/cumulative accuracy), and do not split these into extra cosmetic or infrastructure requirements. Model the R1 and R2 implementation slices as independent where possible so they can run in parallel over the shared local workspace; each verify slice should depend only on its own implementation. Each requirement must be verifiable with automated tests and a browser-accessible local UI. The product must produce a vocabulary-specific persisted-answer and accuracy evidence artifact contract; generic repository implementation or verification reports do not represent that product outcome. Do not use external services or network integrations.";

test("32 browser checklist: Library gap to completed vocabulary Goal", { timeout: 60 * 60 * 1000 }, async () => {
  const env = await createInitializedRealPostgresE2E();
  const libraryFilesBefore = new Set(await listWorkspaceFiles(LIBRARY_ROOT));
  const materializationRoot = await mkdtemp("/tmp/case32-browser-materialization-");
  let tork: Awaited<ReturnType<typeof startIsolatedRealTork>> | undefined;
  let runtime: Awaited<ReturnType<typeof createRealRuntimeServer>> | undefined;
  let web: RunningWebApp | undefined;
  let browser: Browser | undefined;

  try {
    tork = await startIsolatedRealTork({
      postgresAdminUrl: env.adminUrl,
      materializationRoot,
      workspace: WORKSPACE,
      piPlannerEndpoint: process.env.PI_PLANNER_ENDPOINT,
      piHarnessEndpoint: process.env.PI_HARNESS_ENDPOINT,
      callbackHost: process.env.SOUTHSTAR_CALLBACK_HOST,
    });
    await probeRealPostgresTorkPi(tork.infra);
    runtime = await createRealRuntimeServer({
      db: env.db,
      infra: tork.infra,
      runRoot: materializationRoot,
      libraryRoot: resolve(ROOT, "library"),
    });
    const readiness = await loadLibraryReadinessPg(env.db);
    assert.equal(readiness?.ready, true);
    assert.equal(readiness?.trigger, "startup");
    const goalSkill = await loadGoalDesignSkillPg(env.db);
    assert.ok(goalSkill.versionRef);
    const goalSkillObject = await findLibraryObjectByKey(env.db, goalSkill.objectKey);
    assert.equal(goalSkillObject?.state.purpose, "goal_design");
    assert.match(String(goalSkillObject?.state.sourcePath), /^library\/skills\//);
    web = await startWebApp(runtime.url);
    browser = await chromium.launch({ headless: true });
    browser.on("disconnected", () => console.info("[case32-browser] browser disconnected"));
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("dialog", async (dialog) => {
      await dialog.accept("Case32 browser acceptance");
    });
    page.on("close", () => console.info("[case32-browser] page closed"));
    page.on("crash", () => console.info("[case32-browser] page crashed"));
    const workflowGenerateBodies: unknown[] = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/workflow/generate") || request.method() !== "POST") return;
      workflowGenerateBodies.push(request.postDataJSON());
    });
    const snapshotRoot = join(ROOT, "artifacts", "case32-browser");
    await rm(snapshotRoot, { recursive: true, force: true });
    await mkdir(snapshotRoot, { recursive: true });

    await page.goto(web.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    await page.getByTestId("mode-workflow").click();
    await page.waitForTimeout(1_000);
    console.info(`[case32-browser] mode workflow pressed=${await page.getByTestId("mode-workflow").getAttribute("aria-pressed")} body=${(await page.locator("body").innerText()).slice(0, 300)}`);
    await page.getByTestId("workflow-sidebar-panel").waitFor({ state: "attached", timeout: 30_000 });
    await chooseCwd(page, "workflow-sidebar-panel");
    await captureSnapshot(page, snapshotRoot, "01-workflow-cwd");

    const workflowInput = visibleWorkflowInput(page);
    await workflowInput.waitFor({ state: "visible", timeout: 30_000 });
    await workflowInput.fill(GOAL);
    assert.equal(await workflowInput.inputValue(), GOAL);
    const goalSubmissionResponse = page.waitForResponse((response) => (
      response.url().endsWith("/api/workflow/generate") && response.request().method() === "POST"
    ));
    await page.getByTestId("workflow-mode-panel").getByRole("button", { name: "Send" }).click();
    const goalResponse = await goalSubmissionResponse;
    assert.equal(goalResponse.status(), 200);
    const goalResponseText = await goalResponse.text();
    console.info(`[case32-browser] goal SSE events=${goalResponseText.split("\n").filter((line) => line.startsWith("event:")).join(",")}`);
    console.info(`[case32-browser] post-goal body=${(await page.locator("body").innerText()).slice(-2_000)}`);
    const requirements = page.getByTestId("goal-requirements-block");
    await requirements.waitFor({ state: "visible", timeout: 20 * 60 * 1000 });
    await captureSnapshot(page, snapshotRoot, "02-goal-submitted");
    assert.match(await requirements.innerText(), /requirements|Confirm requirements/i);
    assert.ok(await requirements.locator('[data-testid^="goal-requirement-item-"]').count() > 0, "Goal interpreter must produce reviewable requirements");
    assert.equal(await page.getByTestId("workflow-dag-block").count(), 0, "Unconfirmed requirements must not create a DAG");
    await captureSnapshot(page, snapshotRoot, "03-requirements-review");

    const requirementItems = requirements.locator('[data-testid^="goal-requirement-item-"]');
    await requirementItems.first().click();
    await page.getByTestId("goal-requirement-editor").waitFor({ state: "visible", timeout: 30_000 });
    await captureSnapshot(page, snapshotRoot, "04-requirement-editor");

    let confirmedVisualContracts = 0;
    for (let requirementIndex = 0; requirementIndex < await requirementItems.count(); requirementIndex += 1) {
      await requirementItems.nth(requirementIndex).click();
      const editor = page.getByTestId("goal-requirement-editor");
      await editor.waitFor({ state: "visible", timeout: 30_000 });
      const contractButtons = editor.getByTestId("goal-requirement-open-ui-contract");
      const contractCount = await contractButtons.count();
      for (let contractIndex = 0; contractIndex < contractCount; contractIndex += 1) {
        await requirementItems.nth(requirementIndex).click();
        await editor.waitFor({ state: "visible", timeout: 30_000 });
        await editor.getByTestId("goal-requirement-open-ui-contract").nth(contractIndex).click();
        const viewer = page.getByTestId("ui-interaction-contract-viewer");
        await viewer.waitFor({ state: "visible", timeout: 30_000 });
        const confirmVisualContract = viewer.getByTestId("ui-contract-confirm");
        if (await confirmVisualContract.count() === 0) continue;
        if (confirmedVisualContracts === 0) await captureSnapshot(page, snapshotRoot, "04-ui-contract-review");
        const confirmationResponse = page.waitForResponse((response) => (
          response.url().includes("/ui-contracts/")
          && response.request().method() === "PATCH"
        ), { timeout: 2 * 60 * 1000 });
        await confirmVisualContract.click();
        assert.equal((await confirmationResponse).status(), 200);
        await confirmVisualContract.waitFor({ state: "detached", timeout: 30_000 });
        confirmedVisualContracts += 1;
      }
    }
    if (confirmedVisualContracts > 0) await captureSnapshot(page, snapshotRoot, "04-ui-contracts-confirmed");
    await page.getByTestId("sidecar-shell").getByRole("button", { name: "Hide sidecar" }).click();
    const confirmRequirements = requirements.getByTestId("goal-requirements-confirm");
    await confirmRequirements.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="goal-requirements-confirm"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: 30_000 });

    const requirementConfirmation = page.waitForResponse((response) => (
      response.url().includes("/confirm-requirements") && response.request().method() === "POST"
    ), { timeout: 20 * 60 * 1000 });
    await confirmRequirements.click();
    const requirementResponse = await requirementConfirmation;
    assert.equal(requirementResponse.status(), 200);
    const validationProgress = requirements.getByTestId("goal-validation-progress");
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="goal-validation-progress"]')?.getAttribute("data-event")), undefined, { timeout: 2 * 60 * 1000 });
    assert.ok(((await validationProgress.getAttribute("data-event"))?.length ?? 0) > 0);
    await captureSnapshot(page, snapshotRoot, "05-requirement-validation-progress");
    const requirementResponseText = await requirementResponse.text();
    assert.match(requirementResponseText, /event: goal\.validation\.(?:requirement\.started|resolution\.completed)/);
    assert.match(requirementResponseText, /event: (?:library\.import\.candidates\.validated|goal\.validation\.slice_design\.started)/);
    await captureSnapshot(page, snapshotRoot, "05-requirements-confirmed");

    const plan = page.getByTestId("goal-slice-plan-block");
    const candidateBlock = page.getByTestId("library-import-candidates");
    await page.waitForFunction(() => (
      document.querySelector('[data-testid="goal-slice-plan-block"]')
      || document.querySelector('[data-testid="library-import-candidates"]')
    ), undefined, { timeout: 20 * 60 * 1000 });

    if (await candidateBlock.count() > 0) {
      const candidatesText = await candidateBlock.innerText();
      assert.match(candidatesText, /domain|capability|artifact|evaluator/i);
      assert.ok(await candidateBlock.locator("input[type=checkbox]").count() > 0, "Goal validation must produce reviewable Library candidates");
      await candidateBlock.getByTestId("library-proposal-completeness").waitFor({ state: "visible" });
      assert.match(candidatesText, /Complete blocking-gap proposal|Covers R\d+/i);
      const proposalDraftId = await candidateBlock.getAttribute("data-draft-id");
      assert.match(proposalDraftId ?? "", /^library-import-/);
      await captureSnapshot(page, snapshotRoot, "06-library-import-candidates");

      await candidateBlock.getByRole("button", { name: "Install selected candidates" }).click();
      const installFrames = page.getByTestId("library-install-sse-frames");
      await installFrames.waitFor({ state: "visible", timeout: 20 * 60 * 1000 });
      await page.getByTestId("library-install-graph").waitFor({ state: "visible", timeout: 20 * 60 * 1000 });
      assert.doesNotMatch(await installFrames.innerText(), /library\.error/i);
      await captureSnapshot(page, snapshotRoot, "07-library-install-progress");
      await plan.waitFor({ state: "visible", timeout: 20 * 60 * 1000 });
      assert.equal(await page.getByTestId("library-import-candidates").count(), 0, "A validated complete proposal must not create a second Library review round");
      await captureSnapshot(page, snapshotRoot, "08-library-auto-resumed");
    } else {
      await plan.waitFor({ state: "visible", timeout: 30_000 });
      await captureSnapshot(page, snapshotRoot, "06-validation-ready");
    }

    assert.equal(workflowGenerateBodies.length, 1, "Requirement and Library review must continue the same Goal without another prompt");
    await plan.locator('[data-testid^="goal-slice-plan-item-"]').first().waitFor({ state: "visible" });
    assert.match(await plan.innerText(), /ready_for_review|strategy|artifact|evaluator/i);
    await captureSnapshot(page, snapshotRoot, "09-slice-plan-ready");

    const firstSlice = plan.locator('[data-testid^="goal-slice-plan-item-"]').first();
    await firstSlice.click();
    await page.getByTestId("goal-slice-editor").waitFor({ state: "visible" });
    assert.match(await page.getByTestId("goal-slice-editor").innerText(), /package|strategy|Outcome|Requirement/);
    await captureSnapshot(page, snapshotRoot, "10-slice-sidecar");

    const confirmResponsePromise = page.waitForResponse((response) => (
      response.url().includes("/confirm-goal-design/stream") && response.request().method() === "POST"
    ));
    await page.getByTestId("goal-design-confirm-compose").click();
    const confirmResponse = await confirmResponsePromise;
    assert.equal(confirmResponse.status(), 200, await confirmResponse.text());
    const confirmationText = await confirmResponse.text();
    await writeFile(join(snapshotRoot, "11-composer-confirmation.sse.txt"), confirmationText, "utf8");
    const confirmationError = eventFrame(confirmationText, "error");
    if (confirmationError) {
      throw new Error(`Goal Design confirmation failed: ${String(confirmationError.error ?? JSON.stringify(confirmationError))}`);
    }
    const confirmationResult = doneFrame(confirmationText) as { draftId?: string; runId?: string; draftStatus?: string };
    assert.equal(confirmationResult.draftStatus, "validated");
    assert.ok(confirmationResult.runId, "Goal confirmation must persist a run");
    assert.ok(workflowGenerateBodies.length > 0);
    for (const body of workflowGenerateBodies) {
      const keys = JSON.stringify(body);
      assert.doesNotMatch(keys, /"(?:skillBody|goalDesignSkill|goalDesignSkillId|composerSkillId)"/);
    }
    await page.getByTestId("workflow-dag-block").last().waitFor({ state: "visible", timeout: 20 * 60 * 1000 });
    const dagText = await page.getByTestId("workflow-dag-block").last().innerText();
    assert.match(dagText, /DAG/);
    assert.ok(await page.locator('[data-testid^="workflow-dag-node-"]').count() > 0, "Composed DAG must contain nodes");
    await captureSnapshot(page, snapshotRoot, "11-dag-composed");
    await captureSnapshot(page, snapshotRoot, "12-run-created");

    await page.getByTestId("mode-operator").click();
    await page.getByTestId("operator-workspace").waitFor({ state: "visible" });
    const approveRun = page.getByTestId("operator-workspace").getByRole("button", { name: "Approve", exact: true }).first();
    await approveRun.waitFor({ state: "visible", timeout: 30_000 });
    const approvalResponse = page.waitForResponse((response) => (
      response.url().endsWith("/api/operator/command")
      && response.request().method() === "POST"
    ), { timeout: 30_000 });
    await approveRun.click();
    assert.equal((await approvalResponse).status(), 200);
    const parallelExecutions = await waitForConcurrentTorkExecutions(env.db, confirmationResult.runId!, 5 * 60 * 1000);
    assert.ok(parallelExecutions.workflowRunning >= 2, `DAG ready wave was not concurrent: ${JSON.stringify(parallelExecutions)}`);
    assert.ok(parallelExecutions.torkRunning >= 2, `Tork did not run multiple tasks concurrently: ${JSON.stringify(parallelExecutions)}`);
    await captureSnapshot(page, snapshotRoot, "13-execution-started");
    const finalStatus = await waitForPostgresRunStatus(env.db, confirmationResult.runId, ["completed", "failed"], 40 * 60 * 1000);
    assert.equal(finalStatus, "completed");
    await page.waitForTimeout(7_000);
    await page.locator('[title="Workflow status: completed"]').first().waitFor({ state: "visible", timeout: 30_000 });
    await captureSnapshot(page, snapshotRoot, "14-run-completed");

    const outcome = await getResourceByKeyPg(env.db, "goal_outcome", `goal-outcome:${confirmationResult.runId}`);
    if (outcome?.status !== "satisfied") {
      const evaluatorDebug = await env.db.query(
        `select resource_key, status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type in ('goal_outcome', 'evaluator_result', 'requirement_evaluator_result') order by created_at, resource_key`,
        [confirmationResult.runId],
      );
      console.info(`[case32-browser] unsatisfied outcome=${JSON.stringify(outcome?.payload ?? null)} evaluators=${JSON.stringify(evaluatorDebug.rows)}`);
    }
    assert.equal(outcome?.status, "satisfied");
    const operatorOutcome = page.getByTestId("operator-run-outcome");
    await operatorOutcome.waitFor({ state: "visible" });
    assert.match(await operatorOutcome.innerText(), /satisfied/);
    await captureSnapshot(page, snapshotRoot, "15-goal-satisfied");

    const evaluatorRows = await env.db.query<{ status: string; payload_json: Record<string, unknown> }>(
      `select status, payload_json from southstar.runtime_resources where run_id = $1 and resource_type = 'requirement_evaluator_result'`,
      [confirmationResult.runId],
    );
    assert.ok(evaluatorRows.rows.length > 0, "completed Goal must have evaluator results");
    assert.equal(evaluatorRows.rows.every((row) => row.status === "passed" && row.payload_json.verdict === "passed"), true);
    const workspaceFiles = await listWorkspaceFiles(WORKSPACE);
    assert.ok(workspaceFiles.some((file) => /src\/.*\.(m?js|ts|html)$/.test(file)), "workspace must contain generated vocabulary source/UI");
    assert.ok(workspaceFiles.some((file) => /tests?\/.*\.(m?js|ts)$/.test(file)), "workspace must contain generated tests");
    const workspaceSnapshots = await env.db.query<{ payload_json: Record<string, unknown> }>(
      `select payload_json
         from southstar.runtime_resources
        where run_id = $1 and resource_type = 'workspace_snapshot'
        order by created_at desc`,
      [confirmationResult.runId],
    );
    assert.ok(workspaceSnapshots.rows.length > 0, "run must persist a workspace snapshot");
    assert.equal(workspaceSnapshots.rows.every((row) => row.payload_json.provider === "git" && !row.payload_json.gitError), true, "workspace snapshots must use the Git provider");
    await captureSnapshot(page, snapshotRoot, "16-workspace-acceptance");
    console.info(`[case32-browser] runId=${confirmationResult.runId} snapshots=${snapshotRoot} files=${workspaceFiles.join(",")}`);
  } finally {
    await browser?.close();
    await web?.stop();
    await runtime?.close();
    await tork?.close();
    await env.close();
    await removeNewLibraryFiles(LIBRARY_ROOT, libraryFilesBefore);
    await rm(materializationRoot, { recursive: true, force: true });
  }
});

async function chooseCwd(page: Page, sidebarTestId: string): Promise<void> {
  const picker = page.getByTestId(sidebarTestId).getByTestId("project-scope-picker");
  console.info(`[case32-browser] cwd picker ${sidebarTestId}: sidebar=${await page.getByTestId(sidebarTestId).count()} picker=${await picker.count()} buttons=${await picker.getByRole("button").count()}`);
  await picker.locator("button.project-scope-button").click();
  await picker.getByRole("button", { name: "Choose path..." }).click();
  const input = picker.getByTestId("project-scope-custom-path");
  await input.fill(WORKSPACE);
  const validateResponse = page.waitForResponse((response) => response.url().endsWith("/api/cwd/validate") && response.request().method() === "POST");
  await picker.getByRole("button", { name: "Use" }).click();
  const validation = await validateResponse;
  assert.equal(validation.status(), 200, await validation.text());
  await picker.locator("button.project-scope-button").waitFor({ state: "visible" });
  await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.getAttribute("title") === expected, { selector: `[data-testid="${sidebarTestId}"] button.project-scope-button`, expected: WORKSPACE }, { timeout: 30_000 });
}

function visibleWorkflowInput(page: Page) {
  return page.getByTestId("workflow-mode-panel").locator("textarea").last();
}

async function waitText(page: Page, pattern: RegExp, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pattern.test(await page.locator("body").innerText())) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`browser did not render ${pattern} within ${timeout}ms`);
}

async function waitForConcurrentTorkExecutions(
  db: Awaited<ReturnType<typeof createInitializedRealPostgresE2E>>["db"],
  runId: string,
  timeout: number,
): Promise<{ workflowRunning: number; torkRunning: number }> {
  const deadline = Date.now() + timeout;
  let latest = { workflowRunning: 0, torkRunning: 0 };
  while (Date.now() < deadline) {
    const result = await db.query<{ workflow_running: number; tork_running: number }>(
      `select
         (select count(*)::int from southstar.workflow_tasks where run_id = $1 and status = 'running') as workflow_running,
         (select count(*)::int
            from southstar.runtime_resources
           where run_id = $1
             and resource_type = 'hand_execution'
             and status = 'running'
             and payload_json->>'providerId' = 'tork'
             and payload_json->>'externalJobId' is not null) as tork_running`,
      [runId],
    );
    latest = {
      workflowRunning: Number(result.rows[0]?.workflow_running ?? 0),
      torkRunning: Number(result.rows[0]?.tork_running ?? 0),
    };
    if (latest.workflowRunning >= 2 && latest.torkRunning >= 2) return latest;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(`run ${runId} did not show two concurrent workflow/Tork executions within ${timeout}ms: ${JSON.stringify(latest)}`);
}

async function captureSnapshot(page: Page, root: string, name: string): Promise<void> {
  const normalized = (await page.locator("body").innerText())
    .replace(/draft-[A-Za-z0-9-]+/g, "<draft>")
    .replace(/run-[A-Za-z0-9-]+/g, "<run>")
    .replace(/[0-9a-f]{12,64}/gi, "<hash>")
    .replace(/\b\d+(?:\.\d+)?s ago\b/g, "<age>");
  await writeFile(join(root, `${name}.txt`), normalized, "utf8");
  await page.screenshot({ path: join(root, `${name}.png`), fullPage: true });
}

function doneFrame(text: string): Record<string, unknown> {
  const frame = text.split("\n\n").find((part) => part.split("\n").some((line) => line === "event: done"));
  if (!frame) throw new Error(`confirmation stream did not contain done frame: ${text.slice(-2_000)}`);
  const raw = frame.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
  if (!raw) throw new Error("confirmation done frame has no data");
  return JSON.parse(raw) as Record<string, unknown>;
}

function eventFrame(text: string, eventName: string): Record<string, unknown> | undefined {
  const frame = text.split("\n\n").find((part) => part.split("\n").some((line) => line === `event: ${eventName}`));
  if (!frame) return undefined;
  const raw = frame.split("\n").find((line) => line.startsWith("data:"))?.slice("data:".length).trim();
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
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
  const child = spawn("npm", ["--prefix", "web", "run", "dev", "--", "--hostname", "127.0.0.1", "-p", String(port), "--webpack"], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: apiUrl,
      SOUTHSTAR_SERVER_URL: apiUrl,
      SOUTHSTAR_V2_API_BASE_URL: apiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => console.info(`[case32-web:stdout] ${String(chunk).trimEnd()}`));
  child.stderr?.on("data", (chunk) => console.info(`[case32-web:stderr] ${String(chunk).trimEnd()}`));
  child.on("exit", (code, signal) => console.info(`[case32-web] exited code=${code ?? "null"} signal=${signal ?? "null"}`));
  await waitForHttp(url, child);
  return { url, stop: () => stopChild(child) };
}

async function freeTcpPort(): Promise<number> {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
      // wait for Next to bind
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
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
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { assertUiControlPlaneQuantitativeGates } from "../../../src/v2/quality/ui-control-plane-gates.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  uiControlPlaneGoalPrompt,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export async function runUiLoopEngineeringControlPlaneScenario(env: RealE2EEnv): Promise<{
  runId: string;
  taskId: string;
  repo: string;
  timings: {
    browserRunCompletionMs: number;
    firstWorkflowVisibleMs: number;
    taskDetailVisibleMs: number;
    stopConditionVisibleMs: number;
  };
}> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "ui-loop-engineering-control-plane-real");
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

  let runId = "";
  let taskId = "";
  let firstWorkflowVisibleMs = Number.POSITIVE_INFINITY;
  let taskDetailVisibleMs = Number.POSITIVE_INFINITY;
  let stopConditionVisibleMs = Number.POSITIVE_INFINITY;

  try {
    await waitForHttp("http://localhost:3030", 60_000);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto("http://localhost:3030", { waitUntil: "networkidle" });
      await page.getByLabel("planner input").fill(uiControlPlaneGoalPrompt(repo));
      const workflowStartedAt = Date.now();
      await page.getByRole("button", { name: "Send to Planner" }).click();
      await page.getByText(/Dynamic Workflow wf-/).waitFor({ timeout: 120_000 });
      firstWorkflowVisibleMs = Date.now() - workflowStartedAt;

      const runButton = page.getByRole("button", { name: /^Run$/ });
      assert.equal(await runButton.isDisabled(), false, "Run button must be enabled after planner draft is visible");
      await runButton.click();
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return text.includes("Run run-") || text.includes("error");
      }, undefined, { timeout: 120_000 });
      const bodyAfterRun = await page.locator("body").innerText();
      if (!bodyAfterRun.includes("Run run-")) {
        await page.screenshot({ path: "/tmp/southstar-ui-control-plane-run-failed.png", fullPage: true });
      }
      runId = requireMatch(bodyAfterRun, /Run (run-[^\s·]+)/, "run id");
      const jobId = requireMatch(bodyAfterRun, /Tork job ([^\s]+)/, "Tork job id");

      const detailStartedAt = Date.now();
      await page.locator(".ss-node").first().click();
      const taskDetail = page.locator('[data-panel="task-detail"]');
      await taskDetail.getByText("Session", { exact: true }).waitFor({ timeout: 120_000 });
      await taskDetail.getByText("TaskEnvelopeV2", { exact: true }).waitFor({ timeout: 120_000 });
      await taskDetail.getByText(/southstar\.task-envelope\.v2/).waitFor({ timeout: 120_000 });
      await taskDetail.getByText("ContextPacket", { exact: true }).waitFor({ timeout: 120_000 });
      await taskDetail.getByText(/ctx-/).waitFor({ timeout: 120_000 });
      await taskDetail.getByText("Memory Injection", { exact: true }).waitFor({ timeout: 120_000 });
      await taskDetail.getByText("Evaluator", { exact: true }).waitFor({ timeout: 120_000 });
      await taskDetail.getByText("Workspace", { exact: true }).waitFor({ timeout: 120_000 });
      taskDetailVisibleMs = Date.now() - detailStartedAt;

      await waitForTorkJob(env.torkBaseUrl, jobId);
      await waitForRunStatus(context.db, runId, ["passed", "completed"], 120_000);
      const stopVisibleStartedAt = Date.now();
      await page.getByText(/run\.status/).waitFor({ timeout: 30_000 });
      await page.getByRole("cell", { name: "passed" }).waitFor({ timeout: 120_000 });
      stopConditionVisibleMs = Date.now() - stopVisibleStartedAt;

      const firstTaskRow = context.db.prepare("select id from workflow_tasks where run_id = ? order by sort_order limit 1")
        .get(runId) as { id: string } | undefined;
      assert.ok(firstTaskRow, `missing UI run task for ${runId}`);
      taskId = firstTaskRow.id;
      const gate = assertUiControlPlaneQuantitativeGates(context.db, {
        runId,
        plannerMs: 0,
        validationMs: 0,
        torkSubmitMs: 0,
        browserRunCompletionMs: Date.now() - startedAt,
        firstWorkflowVisibleMs,
        taskDetailVisibleMs,
        stopConditionVisibleMs,
      });
      assert.equal(gate.ok, true, gate.failures.join("\n"));
      assertUiControlPlaneArtifact(repo);
    } finally {
      await browser.close();
    }
    console.log("UI loop engineering control-plane browser scenario passed");
    return {
      runId,
      taskId,
      repo,
      timings: {
        browserRunCompletionMs: Date.now() - startedAt,
        firstWorkflowVisibleMs,
        taskDetailVisibleMs,
        stopConditionVisibleMs,
      },
    };
  } finally {
    await stopProcessGroup(next);
    await runtimeServer.close();
    await callback.close();
  }
}

function assertUiControlPlaneArtifact(repo: string): void {
  assert.equal(run("npm", ["run", "-s", "cli", "--", "sum", "1", "2", "3"], repo).trim(), "6");
  assert.equal(run("npm", ["run", "-s", "cli", "--", "sum", "-2", "3.5", "4"], repo).trim(), "5.5");
  const invalid = runAllowFailure("npm", ["run", "-s", "cli", "--", "sum", "1", "nope"], repo);
  assert.notEqual(invalid.status, 0);
  assert.match(`${invalid.stdout}${invalid.stderr}`, /Invalid number: nope/);
  run("npm", ["test"], repo);
  const readme = readFileSync(`${repo}/README.md`, "utf8");
  assert.match(readme, /sum\s+\d+(\s+\d+){2,}/, "README must contain a positive-number sum example");
  assert.match(readme, /sum\s+-\d+(?:\.\d+)?\s+[\d\s.-]*\d+\.\d+/, "README must contain a negative or decimal sum example");
  assert.match(readme, /Invalid number: \w+|sum\s+.*\b[a-zA-Z]+\b/, "README must contain an invalid-input example");
}

function requireMatch(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern)?.[1];
  if (!match) throw new Error(`could not parse ${label} from UI text:\n${text}`);
  return match;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runAllowFailure(command: string, args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      status: failed.status ?? 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? ""),
    };
  }
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
  if (await waitForExit(child, 5_000)) return;
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
      // Keep polling until the dev server binds.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`web UI did not start within ${timeoutMs}ms`);
}

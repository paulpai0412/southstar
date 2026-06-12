import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
} from "./harness.ts";

export async function runUiBrowserOperationsScenario(env: RealE2EEnv): Promise<{
  timings: {
    browserScenarioMs: number;
    uiEventVisibilityMs: number;
    modeToggleMs: number;
  };
}> {
  const browserScenarioStartedAt = Date.now();
  let uiEventVisibilityMs = Number.POSITIVE_INFINITY;
  let modeToggleMs = Number.POSITIVE_INFINITY;
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
  });
  const next = spawn("npm", ["run", "web:dev"], {
    cwd: process.cwd(),
    env: { ...process.env, SOUTHSTAR_SERVER_URL: runtimeServer.url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHttp("http://localhost:3030", 60_000);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto("http://localhost:3030", { waitUntil: "networkidle" });
      await page.getByLabel("planner input").fill(phase15OperationsGoalPrompt(repo));
      await page.getByRole("button", { name: "Send to Planner" }).click();
      await page.getByText("Workflow Canvas").waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: "Run" }).click();
      const eventVisibleStartedAt = Date.now();
      await page.getByText("Runtime Monitor").waitFor({ timeout: 10_000 });
      uiEventVisibilityMs = Date.now() - eventVisibleStartedAt;
      const toggleStartedAt = Date.now();
      await page.getByRole("button", { name: "Full" }).click();
      await page.getByText("Agent Definitions").waitFor({ timeout: 3_000 });
      modeToggleMs = Date.now() - toggleStartedAt;
      await page.getByLabel("input mode").selectOption("voice");
      await page.getByLabel("planner input").fill("語音轉文字：低風險可自動 approve，請保持最小改動。");
      await page.screenshot({ path: "/tmp/southstar-phase15-ui.png", fullPage: true });
      assert.equal(await page.getByText("Voice Transcript").count() > 0, true);
      assert.equal(await page.getByText("Executor Ops").count() > 0, true);
    } finally {
      await browser.close();
    }
    assert.equal(Number.isFinite(uiEventVisibilityMs), true, "UI event visibility timing must be recorded");
    assert.equal(Number.isFinite(modeToggleMs), true, "Simple/Full toggle timing must be recorded");
    console.log("phase15 browser operations scenario passed");
    return {
      timings: {
        browserScenarioMs: Date.now() - browserScenarioStartedAt,
        uiEventVisibilityMs,
        modeToggleMs,
      },
    };
  } finally {
    next.kill("SIGTERM");
    await runtimeServer.close();
    await callback.close();
  }
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

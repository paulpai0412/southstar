import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = join(import.meta.dirname, "../..");
const webRoot = join(root, "web");
const require = createRequire(import.meta.url);
const cwd = "/tmp/southstar-goal-journey";
const journey = {
  id: "journey-42",
  title: "Ship the journey timeline",
  currentStage: "library",
  chatSessionId: "chat-42",
  workflowSessionId: "workflow-42",
  librarySessionId: "library-42",
  runId: "run-42",
} as const;

const sessions = {
  chat: session("chat-42", "chat"),
  workflow: session("workflow-42", "workflow"),
  library: session("library-42", "library"),
};

test("Goal Journey timeline links Chat, Library, Workflow, and Operator selections", async () => {
  const script = await bundleAppShellHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });

  await page.route("http://southstar.test/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: `<main id="root"></main><script>${script}</script>` });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === "/api/sessions" && request.method() === "GET") {
      const kind = url.searchParams.get("kind") ?? "chat";
      await json(route, { sessions: [sessions[kind as keyof typeof sessions]] });
      return;
    }
    if (pathname.startsWith("/api/sessions/") && request.method() === "GET") {
      const id = pathname.split("/").at(-1);
      const info = Object.values(sessions).find((item) => item.id === id);
      await json(route, info ? {
        info,
        sessionId: info.id,
        filePath: info.path,
        leafId: null,
        tree: [],
        context: { messages: [], entryIds: [], thinkingLevel: "auto", model: null },
      } : {}, info ? 200 : 404);
      return;
    }
    if (pathname === "/api/cwd/validate") {
      await json(route, { cwd });
      return;
    }
    if (pathname === "/api/home") {
      await json(route, { home: "/tmp" });
      return;
    }
    if (pathname === "/api/models") {
      await json(route, { models: [], providers: [], defaults: {} });
      return;
    }
    if (pathname === "/api/skills") {
      await json(route, { skills: [] });
      return;
    }
    if (pathname === "/api/operator/overview") {
      await json(route, {
        runs: [{
          runId: "run-42",
          status: "completed",
          executionStatus: "completed",
          outcomeStatus: "satisfied",
          healthStatus: "healthy",
          title: journey.title,
          cwd,
          journey,
        }],
        attentionItems: [],
        commandResults: [],
        runtimeHealth: { activeRunCount: 1, attentionCount: 0, blockedCount: 0 },
      });
      return;
    }
    if (pathname === "/api/library/workspace") {
      await json(route, { selectedScope: "all", domains: [] });
      return;
    }
    if (pathname === "/api/library/readiness") {
      await json(route, { result: { ready: true, status: "ready", snapshotHash: "test", includedCount: 0, excludedCount: 0, diagnostics: [] } });
      return;
    }
    if (pathname === "/api/agent/new") {
      await json(route, { session: sessions.chat, sessionId: sessions.chat.id });
      return;
    }
    await json(route, {});
  });

  try {
    await page.goto("http://southstar.test/?session=chat-42");
    await page.waitForTimeout(1000);
    if (await page.getByTestId("goal-journey-compact").count() === 0) {
      console.log("Goal Journey debug body:", (await page.locator("body").innerText()).slice(0, 2000));
      console.log("Goal Journey debug page errors:", pageErrors, consoleErrors);
    }
    await page.getByTestId("goal-journey-compact").waitFor();
    assert.equal(await page.getByTestId("goal-journey-title").first().textContent(), journey.title);
    assert.equal(await page.getByTestId("chat-session-journey-stage").count(), 1);

    await page.getByTestId("goal-journey-open").click();
    await page.getByTestId("goal-journey-detail").waitFor();
    assert.equal(await page.getByTestId("goal-journey-detail").getByTestId("goal-journey-title").textContent(), journey.title);
    const compactBox = await page.getByTestId("goal-journey-compact").boundingBox();
    assert.ok(compactBox && compactBox.height <= 42, "compact journey should stay one row high");
    await page.getByTestId("goal-journey-toggle").click();
    if (process.env.SOUTHSTAR_GOAL_JOURNEY_SCREENSHOT) {
      await page.screenshot({ path: process.env.SOUTHSTAR_GOAL_JOURNEY_SCREENSHOT, fullPage: false });
    }
    for (const stage of ["chat", "requirements", "library", "workflow", "operator", "complete"]) {
      assert.equal(await page.getByTestId(`goal-journey-step-${stage}`).count(), 2, `${stage} should be in compact and detail timelines`);
    }

    await page.getByTestId("goal-journey-detail").getByTestId("goal-journey-step-library").locator("button").click();
    await page.getByTestId("mode-library").waitFor();
    assert.equal(await page.getByTestId("mode-library").getAttribute("aria-pressed"), "true");
    await page.getByTestId("library-session-row").waitFor();
    assert.equal(await page.getByTestId("library-session-row").getByText(journey.title).count(), 1);
    assert.equal(await page.getByTestId("library-session-journey-stage").textContent(), "Goal · library");

    await page.getByTestId("goal-journey-toggle").click();
    await page.getByTestId("goal-journey-compact").getByTestId("goal-journey-step-workflow").locator("button").click();
    await page.getByTestId("mode-workflow").waitFor();
    assert.equal(await page.getByTestId("mode-workflow").getAttribute("aria-pressed"), "true");
    await page.getByTestId("workflow-session-workflow-42").waitFor();
    assert.equal(await page.getByTestId("workflow-session-workflow-42").getByText(journey.title).count(), 1);
    assert.equal(await page.getByTestId("workflow-session-journey-stage").textContent(), "Goal · library");

    await page.getByTestId("goal-journey-toggle").click();
    await page.getByTestId("goal-journey-compact").getByTestId("goal-journey-step-operator").locator("button").click();
    await page.getByTestId("mode-operator").waitFor();
    assert.equal(await page.getByTestId("mode-operator").getAttribute("aria-pressed"), "true");
    await page.getByTestId("operator-run-journey-title").waitFor();
    assert.equal(await page.getByTestId("operator-run-journey-title").textContent(), journey.title);
    assert.equal(await page.getByTestId("operator-run-journey-stage").textContent(), "Goal · library");

    await page.getByTestId("goal-journey-toggle").click();
    await page.getByTestId("goal-journey-compact").getByTestId("goal-journey-step-chat").locator("button").click();
    await page.getByTestId("mode-chat").waitFor();
    assert.equal(await page.getByTestId("mode-chat").getAttribute("aria-pressed"), "true");
    await page.getByTestId("chat-session-journey-stage").waitFor();
    assert.deepEqual([...pageErrors, ...consoleErrors], []);
  } finally {
    await browser.close();
  }
});

function session(id: string, kind: "chat" | "workflow" | "library") {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd,
    kind,
    name: journey.title,
    created: "2026-07-16T08:00:00.000Z",
    modified: "2026-07-16T08:30:00.000Z",
    messageCount: 3,
    firstMessage: journey.title,
    journey,
  };
}

async function json(route: import("playwright").Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function bundleAppShellHarness(): Promise<string> {
  const dir = await mkdir(join(tmpdir(), `southstar-goal-journey-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { AppShell } from "@/components/AppShell";
        globalThis.process = { env: { NEXT_PUBLIC_APP_VERSION: "test", NEXT_PUBLIC_PI_VERSION: "test" } };
        createRoot(document.getElementById("root")).render(React.createElement(AppShell));
      `,
      resolveDir: root,
      sourcefile: "goal-journey-app-shell-harness.tsx",
      loader: "tsx",
    },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin(), nextNavigationPlugin(), nextServerPlugin()],
  });
  const script = await readFile(outfile, "utf8");
  await rm(dir, { recursive: true, force: true });
  return script;
}

function reactAliasPlugin() {
  return {
    name: "goal-journey-react-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: join(webRoot, "node_modules/react/index.js") }));
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: join(webRoot, "node_modules/react/jsx-runtime.js") }));
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(webRoot, "node_modules/react-dom/client.js") }));
    },
  };
}

function webAliasPlugin() {
  return {
    name: "goal-journey-web-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^@\// }, (args: any) => resolveWebPath(args.path.slice(2)));
    },
  };
}

function nextNavigationPlugin() {
  return {
    name: "goal-journey-next-navigation",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "goal-journey-next-navigation", namespace: "goal-journey-navigation" }));
      buildApi.onLoad({ filter: /.*/, namespace: "goal-journey-navigation" }, () => ({
        loader: "js",
        contents: `
          export function useRouter() { return { replace() {}, push() {} }; }
          export function useSearchParams() { return new URLSearchParams(window.location.search); }
        `,
      }));
    },
  };
}

function nextServerPlugin() {
  return {
    name: "goal-journey-next-server",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^next\/server$/ }, () => ({ path: "goal-journey-next-server", namespace: "goal-journey-server" }));
      buildApi.onLoad({ filter: /.*/, namespace: "goal-journey-server" }, () => ({
        loader: "js",
        contents: `export class NextRequest extends Request {} export class NextResponse extends Response { static json(value, init) { return new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); } }`,
      }));
    },
  };
}

function resolveWebPath(path: string): { path: string } {
  const base = join(webRoot, path);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      return { path: requireResolve(candidate) };
    } catch {
      // Try the next extension.
    }
  }
  return { path: base };
}

function requireResolve(path: string): string {
  return require.resolve(path);
}

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import React from "react";

const root = join(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
(globalThis as unknown as { React: typeof React }).React = React;

test("Chat MessageView renders Southstar library graph tool results as a graph block", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    const message = {
      role: "assistant",
      model: "gpt-5",
      provider: "openai",
      content: [{
        type: "toolCall",
        toolCallId: "tool-graph",
        toolName: "southstar_library_get_graph",
        input: { scope: "all" },
      }],
    };
    const toolResults = new Map([["tool-graph", {
      role: "toolResult",
      toolCallId: "tool-graph",
      toolName: "southstar_library_get_graph",
      content: [{ type: "text", text: "{}" }],
      details: {
        mcpToolName: "southstar.library.get_graph",
        piToolName: "southstar_library_get_graph",
        structuredContent: {
          activeScope: "all",
          availableScopes: ["all", "software"],
          nodes: [{ objectKey: "agent.frontend", objectKind: "agent_definition", status: "approved", title: "Frontend" }],
          edges: [],
        },
        eventCount: 0,
      },
    }]]);

    createRoot(document.getElementById("root")).render(<MessageView message={message} toolResults={toolResults} />);
  `, async (page) => {
    await page.locator('[data-testid="library-graph-block"]').waitFor();
    await page.locator('[data-testid="library-graph-chart"]').waitFor();
  }, routeLibraryGraph);
});

test("Chat MessageView renders Southstar import candidates tool results as an installable candidate block", async () => {
  const installRequests: unknown[] = [];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    const message = {
      role: "assistant",
      model: "gpt-5",
      provider: "openai",
      content: [{
        type: "toolCall",
        toolCallId: "tool-import",
        toolName: "southstar_library_import_from_source",
        input: { source: { kind: "github", url: "https://github.com/example/skills" } },
      }],
    };
    const toolResults = new Map([["tool-import", {
      role: "toolResult",
      toolCallId: "tool-import",
      toolName: "southstar_library_import_from_source",
      content: [{ type: "text", text: "{}" }],
      details: {
        mcpToolName: "southstar.library.import_from_source",
        piToolName: "southstar_library_import_from_source",
        structuredContent: {
          draftId: "draft-import-1",
          candidates: [{
            objectKey: "skill.beautiful-page",
            kind: "skill",
            title: "Beautiful Page",
            scope: "design",
            selectedByDefault: true,
          }],
          proposedEdges: [{
            fromObjectKey: "skill.beautiful-page",
            edgeType: "uses",
            toObjectKey: "tool.browser",
            confidence: 0.86,
          }],
        },
        eventCount: 0,
      },
    }]]);

    createRoot(document.getElementById("root")).render(<MessageView message={message} toolResults={toolResults} />);
  `, async (page) => {
    await page.locator('[data-testid="library-import-candidates"]').waitFor();
    await assertText(page, '[data-testid="library-import-candidates"]', "Beautiful Page");
    await page.locator('[aria-label="Install selected candidates"]').click();
    await page.waitForFunction(() => window.__installRequests?.length === 1);
    assert.deepEqual(installRequests, [{
      selectedCandidateIds: ["skill.beautiful-page"],
      actor: "pi-agent",
      reason: "Installed from Southstar chat tool result.",
    }]);
  }, async (page) => {
    await page.addInitScript(() => {
      (window as any).__installRequests = [];
    });
    await page.route("**/api/library/import-drafts/draft-import-1/install/stream", async (route) => {
      const request = JSON.parse(route.request().postData() ?? "{}");
      installRequests.push(request);
      await page.evaluate((request) => {
        (window as any).__installRequests.push(request);
      }, request);
      await route.fulfill({
        contentType: "text/event-stream",
        body: "event: library.command.completed\ndata: {\"status\":\"installed\"}\n\n",
      });
    });
  });
});

test("Chat MessageView renders Southstar workflow draft tool results as a workflow DAG block", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    const message = {
      role: "assistant",
      model: "gpt-5",
      provider: "openai",
      content: [{
        type: "toolCall",
        toolCallId: "tool-workflow",
        toolName: "southstar_workflow_create_draft_stream",
        input: { goalPrompt: "build a vocabulary app" },
      }],
    };
    const toolResults = new Map([["tool-workflow", {
      role: "toolResult",
      toolCallId: "tool-workflow",
      toolName: "southstar_workflow_create_draft_stream",
      content: [{ type: "text", text: "{}" }],
      details: {
        mcpToolName: "southstar.workflow.create_draft_stream",
        piToolName: "southstar_workflow_create_draft_stream",
        structuredContent: {
          draft: {
            draftId: "draft-wf-1",
            goalPrompt: "build a vocabulary app",
            workflowId: "generated-vocabulary-workflow",
            status: "validated",
            validationIssues: [],
            taskSummaries: [
              { taskId: "plan", taskName: "Plan feature", dependsOn: [], roleRef: "planner", agentProfileRef: "profile.planner-codex" },
              { taskId: "implement", taskName: "Implement feature", dependsOn: ["plan"], roleRef: "maker", agentProfileRef: "profile.maker-codex" },
            ],
          },
        },
        eventCount: 0,
      },
    }]]);

    createRoot(document.getElementById("root")).render(<MessageView message={message} toolResults={toolResults} />);
  `, async (page) => {
    await page.locator('[data-testid="workflow-dag-block"]').waitFor();
    await assertText(page, '[data-testid="workflow-dag-block"]', "generated-vocabulary-workflow");
  });
});

async function withBrowserHarness(
  entry: string,
  run: (page: Page) => Promise<void>,
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-chat-tool-blocks-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: "chat-southstar-tool-blocks-harness.tsx",
      loader: "tsx",
    },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin()],
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  try {
    const script = await readFile(outfile, "utf8");
    await page.route("http://southstar.test/", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<main id="root"></main><script>${script}</script>`,
      });
    });
    await beforeLoad?.(page);
    await page.goto("http://southstar.test/");
    if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
    await run(page);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function routeLibraryGraph(page: Page): Promise<void> {
  await page.route("**/api/library/graph**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        result: {
          activeScope: "all",
          availableScopes: ["all", "software"],
          nodes: [{ objectKey: "agent.frontend", objectKind: "agent_definition", status: "approved", title: "Frontend" }],
          edges: [],
        },
      }),
    });
  });
}

function reactAliasPlugin() {
  return {
    name: "react-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: join(root, "node_modules/react/index.js") }));
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: join(root, "node_modules/react/jsx-runtime.js") }));
      buildApi.onResolve({ filter: /^react-dom$/ }, () => ({ path: join(root, "node_modules/react-dom/index.js") }));
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(root, "node_modules/react-dom/client.js") }));
    },
  };
}

function webAliasPlugin() {
  return {
    name: "web-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^@\// }, (args: any) => resolveWebPath(args.path.slice(2)));
    },
  };
}

function resolveWebPath(path: string): { path: string } {
  const base = join(root, "web", path);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      return { path: require.resolve(candidate) };
    } catch {
      // Try the next extension.
    }
  }
  return { path: base };
}

async function assertText(page: Page, selector: string, expected: string): Promise<void> {
  const text = await page.locator(selector).textContent();
  assert.match(text ?? "", new RegExp(expected));
}

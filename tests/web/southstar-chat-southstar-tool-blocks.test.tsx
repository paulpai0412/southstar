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

test("Chat MessageView reports workspace surface intent from Southstar tool results", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    const surfaces = [];
    window.__surfaces = surfaces;

    function App() {
      const libraryMessage = {
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
      const workflowMessage = {
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
      const toolResults = new Map([
        ["tool-graph", {
          role: "toolResult",
          toolCallId: "tool-graph",
          toolName: "southstar_library_get_graph",
          content: [{ type: "text", text: "{}" }],
          details: {
            mcpToolName: "southstar.library.get_graph",
            piToolName: "southstar_library_get_graph",
            structuredContent: { activeScope: "all", availableScopes: ["all"], nodes: [], edges: [] },
            eventCount: 0,
          },
        }],
        ["tool-workflow", {
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
                taskSummaries: [{ taskId: "plan", taskName: "Plan", dependsOn: [] }],
              },
            },
            eventCount: 0,
          },
        }],
      ]);
      return (
        <>
          <MessageView message={libraryMessage} toolResults={toolResults} onWorkspaceSurfaceChange={(surface) => surfaces.push(surface)} />
          <MessageView message={workflowMessage} toolResults={toolResults} onWorkspaceSurfaceChange={(surface) => surfaces.push(surface)} />
        </>
      );
    }

    createRoot(document.getElementById("root")).render(<App />);
  `, async (page) => {
    await page.waitForFunction(() => window.__surfaces?.length === 2);
    const surfaces = await page.evaluate(() => window.__surfaces);
    assert.deepEqual(surfaces, ["library", "workflow"]);
  }, routeLibraryGraph);
});

test("Chat MessageView reports selected library graph nodes for the sidecar", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    window.__selectedLibraryNodes = [];

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
          nodes: [{
            objectKey: "agent.frontend",
            objectKind: "agent_definition",
            status: "approved",
            title: "Frontend Agent",
            sourcePath: "library/agents/frontend.md",
          }],
          edges: [],
        },
        eventCount: 0,
      },
    }]]);

    createRoot(document.getElementById("root")).render(
      <MessageView
        message={message}
        toolResults={toolResults}
        onLibraryGraphNodeSelect={(node) => window.__selectedLibraryNodes.push(node.objectKey)}
      />
    );
  `, async (page) => {
    await page.locator('[data-testid="library-graph-node"]').click();
    await page.waitForFunction(() => window.__selectedLibraryNodes?.length === 1);
    const selected = await page.evaluate(() => window.__selectedLibraryNodes);
    assert.deepEqual(selected, ["agent.frontend"]);
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
        toolName: "southstar_library_get_import_draft",
        input: { draftId: "draft-import-1" },
      }],
    };
    const toolResults = new Map([["tool-import", {
      role: "toolResult",
      toolCallId: "tool-import",
      toolName: "southstar_library_get_import_draft",
      content: [{ type: "text", text: "{}" }],
      details: {
        mcpToolName: "southstar.library.get_import_draft",
        piToolName: "southstar_library_get_import_draft",
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
    await assertText(page, '[data-testid="library-install-sse-frames"]', "library.import.install.requested");
    await assertText(page, '[data-testid="library-install-sse-frames"]', "library.db.synced");
    await assertText(page, '[data-testid="library-install-sse-frames"]', "library.graph.snapshot");
    await assertText(page, '[data-testid="library-install-sse-frames"]', "library.command.completed");
    await page.locator('[data-testid="library-install-graph"] [data-testid="library-graph-chart"]').waitFor();
    await assertText(page, '[data-testid="library-install-graph"]', "Beautiful Page");
    await assertText(page, '[data-testid="library-install-graph"]', "uses 0.86");
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
        body: [
          "event: library.import.install.requested",
          'data: {"draftId":"draft-import-1","selectedCandidateCount":1}',
          "",
          "event: library.db.synced",
          'data: {"draftId":"draft-import-1","objectKeys":["skill.beautiful-page"],"edgeIds":[]}',
          "",
          "event: library.graph.snapshot",
          'data: {"activeScope":"design","availableScopes":["all","design"],"nodes":[{"id":"lib-skill","objectKey":"skill.beautiful-page","objectKind":"skill_spec","status":"approved","title":"Beautiful Page","scope":"design"},{"id":"lib-tool","objectKey":"tool.browser","objectKind":"tool_definition","status":"approved","title":"Browser","scope":"global"}],"edges":[{"id":"edge-1","fromObjectKey":"skill.beautiful-page","edgeType":"uses","toObjectKey":"tool.browser","scope":"design","status":"active","weight":0.86,"ontology":{"confidence":0.86}}]}',
          "",
          "event: library.command.completed",
          'data: {"draftId":"draft-import-1","status":"installed"}',
          "",
        ].join("\n"),
      });
    });
  });
});

test("Chat MessageView lets streamed library import graph nodes open the library sidecar", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    window.__selectedLibraryNode = null;

    const message = {
      role: "assistant",
      model: "library-chat",
      provider: "southstar",
      content: [{
        type: "libraryImportCandidates",
        draftId: "draft-import-streamed",
        candidates: [{
          objectKey: "skill.beautiful-page",
          kind: "skill",
          title: "Beautiful Page",
          scope: "design",
          selectedByDefault: true,
        }],
        proposedEdges: [],
      }],
    };

    createRoot(document.getElementById("root")).render(
      <MessageView
        message={message}
        onLibraryGraphNodeSelect={(node) => { window.__selectedLibraryNode = node.objectKey; }}
      />,
    );
  `, async (page) => {
    await page.locator('[data-testid="library-import-candidates"]').waitFor();
    await page.locator('[aria-label="Install selected candidates"]').click();
    await page.locator('[data-testid="library-install-graph"] [aria-label="Beautiful Page"]').click();
    await page.waitForFunction(() => window.__selectedLibraryNode === "skill.beautiful-page");
  }, async (page) => {
    await page.route("**/api/library/import-drafts/draft-import-streamed/install/stream", async (route) => {
      await route.fulfill({
        contentType: "text/event-stream",
        body: [
          "event: library.graph.snapshot",
          'data: {"activeScope":"design","availableScopes":["design"],"nodes":[{"objectKey":"skill.beautiful-page","objectKind":"skill_spec","status":"approved","title":"Beautiful Page","scope":"design"}],"edges":[]}',
          "",
          "event: library.command.completed",
          'data: {"draftId":"draft-import-streamed","status":"installed"}',
          "",
        ].join("\n"),
      });
    });
  });
});

test("Chat MessageView hydrates source documents for replayed Library candidates", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { MessageView } from "./web/components/MessageView";

    window.__selectedLibraryNode = null;
    const message = {
      role: "assistant",
      model: "library-chat",
      provider: "southstar",
      content: [{
        type: "libraryImportCandidates",
        draftId: "draft-import-replay",
        candidates: [{
          objectKey: "artifact.replayed-evidence",
          kind: "artifact",
          title: "Replayed Evidence",
          scope: "software",
          sourcePath: "replayed/source.md",
          selectedByDefault: true,
        }],
        candidateCoverageTargets: [{
          candidateObjectKey: "artifact.replayed-evidence",
          gapRef: "gap-replay",
          requirementId: "R1",
          criterionIds: ["AC1"],
        }],
      }],
    };

    createRoot(document.getElementById("root")).render(
      <MessageView
        message={message}
        onLibraryGraphNodeSelect={(node) => { window.__selectedLibraryNode = node; }}
      />,
    );
  `, async (page) => {
    await page.getByRole("button", { name: "View Replayed Evidence", exact: true }).waitFor();
    await page.getByRole("button", { name: "View Replayed Evidence", exact: true }).click();
    await page.waitForFunction(() => window.__selectedLibraryNode?.sourceContent === "# replayed evidence");
    const selected = await page.evaluate(() => window.__selectedLibraryNode);
    assert.equal(selected.objectKey, "artifact.replayed-evidence");
    assert.equal(selected.sourceContent, "# replayed evidence");
    assert.equal(selected.selectionGraph?.nodes.length, 3);
  }, async (page) => {
    await page.route("**/api/library/import-drafts/draft-import-replay", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, result: { documents: [{ path: "replayed/source.md", label: "Replayed source", content: "# replayed evidence" }] } }),
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

test("Chat MessageView renders streamed goal-design confirmation orchestration as a workflow DAG block", async () => {
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
        toolCallId: "tool-confirm-design-stream",
        toolName: "southstar_workflow_confirm_goal_design_stream",
        input: { draftId: "draft-wf-stream", expectedPackageHash: "package-wf-stream" },
      }],
    };
    const orchestration = {
      draftId: "draft-wf-stream",
      goalPrompt: "build a streamed vocabulary app",
      workflowId: "generated-streamed-vocabulary-workflow",
      status: "validated",
      validationIssues: [],
      taskSummaries: [
        { taskId: "implement", taskName: "Implement vocabulary", dependsOn: [], roleRef: "maker", agentProfileRef: "profile.maker" },
        { taskId: "verify", taskName: "Verify vocabulary", dependsOn: ["implement"], roleRef: "verifier", agentProfileRef: "profile.verifier" },
      ],
    };
    const toolResults = new Map([["tool-confirm-design-stream", {
      role: "toolResult",
      toolCallId: "tool-confirm-design-stream",
      toolName: "southstar_workflow_confirm_goal_design_stream",
      content: [{ type: "text", text: "{}" }],
      details: {
        mcpToolName: "southstar.workflow.confirm_goal_design_stream",
        piToolName: "southstar_workflow_confirm_goal_design_stream",
        structuredContent: {
          eventCount: 3,
          result: { draftId: "draft-wf-stream", runId: "run-wf-stream", orchestration },
          orchestration,
        },
      },
    }]]);

    createRoot(document.getElementById("root")).render(<MessageView message={message} toolResults={toolResults} />);
  `, async (page) => {
    await page.locator('[data-testid="workflow-dag-block"]').waitFor();
    await assertText(page, '[data-testid="workflow-dag-block"]', "generated-streamed-vocabulary-workflow");
    await assertText(page, '[data-testid="workflow-dag-block"]', "Verify vocabulary");
  });
});

test("Chat MessageView renders Southstar instantiated template tool results as a workflow DAG block", async () => {
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
        toolCallId: "tool-template",
        toolName: "southstar_workflow_instantiate_template",
        input: { templateRef: "template.chat-e2e-software-harness" },
      }],
    };
    const toolResults = new Map([["tool-template", {
      role: "toolResult",
      toolCallId: "tool-template",
      toolName: "southstar_workflow_instantiate_template",
      content: [{ type: "text", text: "{}" }],
      details: {
        mcpToolName: "southstar.workflow.instantiate_template",
        piToolName: "southstar_workflow_instantiate_template",
        structuredContent: {
          templateRef: "template.chat-e2e-software-harness",
          draftId: "draft-wf-template-1",
          workflowId: "wf-template-1",
          status: "validated",
          validationIssues: [],
          nodes: [
            {
              taskId: "plan-generic-software-harness-template",
              nodeType: "plan",
              nodePromptSpec: { nodeType: "plan", goal: "Plan todo alarm feature" },
              agentProfileRef: "profile.generated.generic-software-harness.plan",
            },
            {
              taskId: "verify-generic-software-harness-template",
              nodeType: "verify",
              nodePromptSpec: { nodeType: "verify", goal: "Verify todo alarm feature" },
              agentProfileRef: "profile.generated.generic-software-harness.verify",
            },
          ],
        },
        eventCount: 0,
      },
    }]]);

    createRoot(document.getElementById("root")).render(<MessageView message={message} toolResults={toolResults} />);
  `, async (page) => {
    await page.locator('[data-testid="workflow-dag-block"]').waitFor();
    await assertText(page, '[data-testid="workflow-dag-block"]', "wf-template-1");
    await assertText(page, '[data-testid="workflow-dag-block"]', "Plan Generic Software Harness Template");
    await assertText(page, '[data-testid="workflow-dag-block"]', "Verify Generic Software Harness Template");
  });
});

test("Chat surfaces streamed Southstar tool progress while a long run is active", async () => {
  await withBrowserHarness(`
    import { phaseLabel } from "./web/components/ChatWindow";
    import { updateRunningToolProgress } from "./web/hooks/useAgentSession";

    const phase = updateRunningToolProgress({
      kind: "running_tools",
      tools: [{ id: "tool-stream", name: "southstar_runtime_stream_run_events" }],
    }, {
      toolCallId: "tool-stream",
      toolName: "southstar_runtime_stream_run_events",
      partialResult: {
        content: [{ type: "text", text: "task.started: Implement membership module" }],
      },
    });

    document.getElementById("root").textContent = phaseLabel(phase);
  `, async (page) => {
    await assertText(page, "#root", "Implement membership module");
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

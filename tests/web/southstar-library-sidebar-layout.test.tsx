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

test("LibrarySidebar renders fixed primitive domain trees and selects filtered objects", async () => {
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { LibrarySidebar } from "./web/components/library/LibrarySidebar";

    const model = {
      selectedScope: "software",
      domains: [
        {
          scope: "software",
          counts: {
            agent_definition: 1,
            skill_spec: 1,
            mcp_tool_grant: 1,
            tool_definition: 1,
          },
          objectGroups: [
            {
              objectKind: "agent_definition",
              objects: [{
                id: "agent.frontend",
                objectKey: "agent.frontend",
                objectKind: "agent_definition",
                status: "approved",
                title: "Frontend Agent",
                scope: "software",
                sourcePath: "software/agents/frontend.agent.md",
              }],
            },
            {
              objectKind: "skill_spec",
              objects: [{
                id: "skill.react",
                objectKey: "skill.react",
                objectKind: "skill_spec",
                status: "approved",
                title: "React Skill",
                scope: "software",
                sourcePath: "software/skills/react.skill.md",
              }],
            },
            {
              objectKind: "mcp_tool_grant",
              objects: [{
                id: "mcp.github",
                objectKey: "mcp.github",
                objectKind: "mcp_tool_grant",
                status: "approved",
                title: "GitHub MCP",
                scope: "software",
                sourcePath: "software/mcp/github.mcp.yaml",
              }],
            },
            {
              objectKind: "tool_definition",
              objects: [{
                id: "tool.browser",
                objectKey: "tool.browser",
                objectKind: "tool_definition",
                status: "approved",
                title: "Browser Tool",
                scope: "software",
                sourcePath: "software/tools/browser.tool.yaml",
              }],
            },
          ],
        },
        {
          scope: "research",
          counts: { skill_spec: 1 },
          objectGroups: [{
            objectKind: "skill_spec",
            objects: [{
              id: "skill.literature-review",
              objectKey: "skill.literature-review",
              objectKind: "skill_spec",
              status: "approved",
              title: "Literature Review",
              scope: "research",
              sourcePath: "research/skills/literature-review.skill.md",
            }],
          }],
        },
      ],
    };

    function Harness() {
      const [selectedObjectKey, setSelectedObjectKey] = useState("");
      return (
        <LibrarySidebar
          model={model}
          selectedScope="software"
          selectedObjectKey={selectedObjectKey}
          statusFilter="all"
          onSelectScope={() => {}}
          onStatusFilterChange={() => {}}
          onSelectObject={(object) => {
            window.__selectedObjectKey = object.objectKey;
            setSelectedObjectKey(object.objectKey);
          }}
          prompt=""
          onPromptChange={() => {}}
          onPromptSubmit={() => {}}
        />
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.locator('[data-testid="library-domain-filter"]').fill("soft");

    for (const heading of ["Agent", "Skill", "MCP", "Tool"]) {
      await page.getByRole("heading", { name: heading }).waitFor();
    }

    for (const title of ["Frontend Agent", "React Skill", "GitHub MCP", "Browser Tool"]) {
      assert.equal(await page.getByText(title).isVisible(), true);
    }
    assert.equal(await page.getByText("Literature Review").count(), 0);

    await page.getByRole("button", { name: "React Skill skill.react approved" }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedObjectKey), "skill.react");
  });
});

async function withBrowserHarness(
  entry: string,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-library-sidebar-test-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: "library-sidebar-harness.tsx",
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
    await page.goto("http://southstar.test/");
    if (pageErrors.length > 0) throw new Error(pageErrors.join("\n"));
    await run(page);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
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

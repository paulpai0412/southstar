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

test("LibrarySidebar renders project scope, sessions, and domain tree selections", async () => {
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
            agent_spec: 1,
            skill_spec: 1,
            skill_definition: 1,
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
              objectKind: "agent_spec",
              objects: [{
                id: "agent.researcher",
                objectKey: "agent.researcher",
                objectKind: "agent_spec",
                status: "approved",
                title: "Agent Spec",
                scope: "software",
                sourcePath: "software/agents/researcher.agent.md",
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
              objectKind: "skill_definition",
              objects: [{
                id: "skill.codegen",
                objectKey: "skill.codegen",
                objectKind: "skill_definition",
                status: "approved",
                title: "Skill Definition",
                scope: "software",
                sourcePath: "software/skills/codegen.skill.md",
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
      const [selectedSessionId, setSelectedSessionId] = useState("");
      return (
        <LibrarySidebar
          model={model}
          sessions={[{
            id: "library-session-1",
            title: "Research import run",
            status: "completed",
            modified: "2026-07-03T08:00:00.000Z",
            detail: "1 item",
            itemCount: 1,
          }]}
          selectedSessionId={selectedSessionId}
          selectedScope="software"
          selectedObjectKey={selectedObjectKey}
          selectedCwd="/workspace"
          statusFilter="all"
          onCwdChange={(cwd) => { window.__selectedCwd = cwd; }}
          onSelectScope={() => {}}
          onStatusFilterChange={() => {}}
          onSelectSession={(session) => {
            window.__selectedSessionId = session.id;
            setSelectedSessionId(session.id);
          }}
          onNewSession={() => {
            window.__newLibrarySession = true;
          }}
          onRefresh={() => {
            window.__libraryRefreshed = true;
          }}
          onSelectObject={(object) => {
            window.__selectedObjectKey = object.objectKey;
            setSelectedObjectKey(object.objectKey);
          }}
        />
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.getByText("Southstar").waitFor();
    await page.getByRole("button", { name: "New" }).click();
    await page.locator('[data-testid="project-scope-picker"]').getByRole("button", { name: "Refresh" }).click();
    assert.equal(await page.evaluate(() => (window as any).__newLibrarySession), true);
    assert.equal(await page.evaluate(() => (window as any).__libraryRefreshed), true);

    await page.getByText("Library LLM Sessions").waitFor();
    await page.getByText("Library Domain Tree").waitFor();
    await page.locator('[data-testid="project-scope-picker"]').waitFor();
    assert.equal(await page.getByText("Research import run").isVisible(), true);

    await page.getByRole("button", { name: "software", exact: true }).waitFor();
    const domainTree = page.locator('[data-testid="library-domain-tree"]');
    assert.equal(await domainTree.getByRole("button", { name: "research", exact: true }).count(), 1);

    for (const folder of ["agents", "skills", "mcp", "tools"]) {
      assert.equal(await domainTree.getByRole("button", { name: new RegExp(`^${folder} \\d+$`) }).count() > 0, true);
    }
    assert.equal(await page.locator('[data-testid="library-tree-connector"]').count() > 0, true);
    assert.equal(await page.locator('[data-testid="library-tree-branch"]').count() > 0, true);
    assert.equal(await page.getByText("[]", { exact: true }).count(), 0);

    for (const title of ["Frontend Agent", "Agent Spec", "React Skill", "Skill Definition", "GitHub MCP", "Browser Tool"]) {
      assert.equal(await page.getByText(title).isVisible(), true);
    }
    assert.equal(await domainTree.getByText("research", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Literature Review").count(), 1);

    await page.getByRole("button", { name: "React Skill skill.react approved" }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedObjectKey), "skill.react");

    await page.locator('[data-testid="library-session-row"]').filter({ hasText: "Research import run" }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedSessionId), "library-session-1");
  });
});

test("LibrarySidebar renders the library domains as an accessible nested tree with counts", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibrarySidebar } from "./web/components/library/LibrarySidebar";

    const agent = (domain, index) => ({
      id: \`agent.\${domain}.\${index}\`,
      objectKey: \`agent.\${domain}.\${index}\`,
      objectKind: "agent_definition",
      status: "approved",
      title: \`\${domain} Agent \${index}\`,
      scope: domain,
      sourcePath: \`\${domain}/agents/\${index}.agent.md\`,
    });

    const marketingAgents = Array.from({ length: 42 }, (_, index) => agent("marketing", index + 1));
    const engineeringAgents = Array.from({ length: 41 }, (_, index) => agent("engineering", index + 1));
    const model = {
      selectedScope: "all",
      domains: [
        {
          scope: "engineering",
          objectCount: 41,
          objectKindCounts: { agent_definition: 41 },
          objectGroups: [{ objectKind: "agent_definition", objects: engineeringAgents }],
        },
        {
          scope: "marketing",
          objectCount: 42,
          objectKindCounts: { agent_definition: 42 },
          objectGroups: [{ objectKind: "agent_definition", objects: marketingAgents }],
        },
      ],
    };

    createRoot(document.getElementById("root")).render(
      <LibrarySidebar
        model={model}
        sessions={[]}
        selectedScope="all"
        selectedCwd="/workspace"
        statusFilter="all"
        onCwdChange={(cwd) => { window.__selectedCwd = cwd; }}
        onSelectScope={(scope) => { window.__selectedScope = scope; }}
        onStatusFilterChange={() => {}}
        onSelectObject={(object) => { window.__selectedObjectKey = object.objectKey; }}
      />
    );
  `, async (page) => {
    const tree = page.getByRole("tree", { name: "Library Domain Tree" });
    await tree.waitFor();

    const marketing = tree.getByRole("treeitem", { name: "marketing 42" });
    await marketing.waitFor();
    assert.equal(await marketing.getAttribute("aria-level"), "1");
    assert.equal(await marketing.getAttribute("aria-expanded"), "true");

    await tree.getByRole("button", { name: "Toggle marketing" }).click();
    assert.equal(await marketing.getAttribute("aria-expanded"), "false");
    assert.equal(await tree.getByRole("treeitem", { name: "marketing Agent 42 agent.marketing.42 approved" }).count(), 0);

    await tree.getByRole("button", { name: "Toggle marketing" }).click();
    assert.equal(await marketing.getAttribute("aria-expanded"), "true");

    const marketingAgentsFolder = tree.getByRole("treeitem", { name: "agents 42" });
    assert.equal(await marketingAgentsFolder.getAttribute("aria-level"), "2");
    assert.equal(await marketingAgentsFolder.getAttribute("aria-expanded"), "true");
    assert.equal(await tree.getByRole("treeitem", { name: "marketing Agent 42 agent.marketing.42 approved" }).getAttribute("aria-level"), "3");

    assert.equal(await tree.getByRole("treeitem").count(), 87);
    await tree.getByRole("treeitem", { name: "engineering 41" }).waitFor();
    assert.equal(await tree.getByRole("treeitem", { name: "marketing 42" }).count(), 1);

    await tree.getByRole("treeitem", { name: "engineering Agent 7 agent.engineering.7 approved" }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedObjectKey), "agent.engineering.7");
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

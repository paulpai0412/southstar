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

test("LibraryGraphBlock exposes domain kind and status filters and fetches filtered graph data", async () => {
  const requests: string[] = [];

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryGraphBlock } from "./web/components/library/LibraryGraphBlock";

    createRoot(document.getElementById("root")).render(
      <LibraryGraphBlock
        defaultScope="software"
        data={{
          activeScope: "software",
          availableScopes: ["all", "software", "research"],
          query: { edgeType: "workflow_precedes" },
          nodes: [{ objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", title: "Frontend Developer" }],
          edges: [],
        }}
      />
    );
  `, async (page) => {
    assert.equal(await page.locator('[data-testid="library-graph-edge-filter"]').inputValue(), "workflow_precedes");
    await page.waitForFunction(() => (
      window.__graphRequests?.some((query) => query.includes("edgeType=workflow_precedes"))
    ));

    await page.locator('[data-testid="library-graph-domain-filter"]').selectOption("research");
    await page.locator('[data-testid="library-graph-kind-filter"]').selectOption("skill_spec");
    await page.locator('[data-testid="library-graph-status-filter"]').selectOption("draft");
    await page.locator('[data-testid="library-graph-edge-filter"]').selectOption("uses");

    await page.waitForFunction(() => (
      window.__graphRequests?.some((query) => (
        query.includes("scope=research")
        && query.includes("kind=skill_spec")
        && query.includes("status=draft")
        && query.includes("edgeType=uses")
      ))
    ));

    assert.equal(requests.some((query) => (
      query.includes("scope=research")
      && query.includes("kind=skill_spec")
      && query.includes("status=draft")
      && query.includes("edgeType=uses")
    )), true);
  }, async (page) => {
    await page.addInitScript(() => {
      (window as any).__graphRequests = [];
    });
    await page.route("**/api/library/graph**", async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.searchParams.toString());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          result: {
            activeScope: url.searchParams.get("scope") ?? "all",
            availableScopes: ["all", "software", "research"],
            nodes: [{
              objectKey: "skill.react-ui",
              objectKind: url.searchParams.get("kind") ?? "skill_spec",
              status: url.searchParams.get("status") ?? "approved",
              title: "React UI",
            }],
            edges: [],
          },
        }),
      });
      await page.evaluate((query) => {
        (window as any).__graphRequests.push(query);
      }, url.searchParams.toString());
    });
  });
});

test("LibraryGraphBlock renders an expanded collapsible message block with zoom controls", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryGraphBlock } from "./web/components/library/LibraryGraphBlock";

    createRoot(document.getElementById("root")).render(
      <LibraryGraphBlock
        defaultScope="marketing"
        data={{
          activeScope: "marketing",
          availableScopes: ["all", "marketing"],
          nodes: [
            { objectKey: "agent.marketing-seo-specialist", objectKind: "agent_definition", status: "approved", title: "SEO专家" },
            { objectKey: "skill.keyword-research", objectKind: "skill_spec", status: "approved", title: "Keyword Research" },
          ],
          edges: [{
            fromObjectKey: "agent.marketing-seo-specialist",
            edgeType: "uses",
            toObjectKey: "skill.keyword-research",
            ontology: { confidence: 0.92, category: "usage" },
          }],
        }}
      />
    );
  `, async (page) => {
    const block = page.locator('[data-testid="library-graph-block"]');
    await block.waitFor();
    await page.locator('[data-testid="library-graph-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="library-graph-toggle"]').getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator('[data-testid="library-graph-zoom-in"]').isVisible(), true);
    assert.equal(await page.locator('[data-testid="library-graph-zoom-out"]').isVisible(), true);

    const before = await page.locator('[data-testid="library-graph-viewport"]').getAttribute("data-zoom");
    await page.locator('[data-testid="library-graph-zoom-in"]').click();
    const after = await page.locator('[data-testid="library-graph-viewport"]').getAttribute("data-zoom");
    assert.notEqual(after, before);

    await page.locator('[data-testid="library-graph-toggle"]').click();
    assert.equal(await page.locator('[data-testid="library-graph-toggle"]').getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('[data-testid="library-graph-chart"]').count(), 0);
  });
});

test("LibraryGraphChart emits selected node events for file viewer integration", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryGraphChart } from "./web/components/library/LibraryGraphChart";

    createRoot(document.getElementById("root")).render(
      <LibraryGraphChart
        nodes={[
          { objectKey: "agent.frontend-developer", objectKind: "agent_definition", title: "Frontend Developer" },
          { objectKey: "skill.react-ui", objectKind: "skill_spec", title: "React UI" },
        ]}
        edges={[{
          fromObjectKey: "agent.frontend-developer",
          edgeType: "uses",
          toObjectKey: "skill.react-ui",
          ontology: { confidence: 0.91, category: "usage" },
        }]}
        onSelectNode={(node) => {
          window.__selectedGraphNode = node.objectKey;
        }}
      />
    );
  `, async (page) => {
    await assertText(page, '[data-testid="library-graph-chart"]', "uses 0.91");
    assert.equal(await page.locator('[data-testid="library-graph-edge"]').count(), 1);
    assert.equal(await page.locator('[data-testid="library-graph-dot"]').count(), 2);
    const graphNode = page.getByRole("button", { name: "Frontend Developer" });
    await graphNode.press("Enter");
    assert.equal(await page.evaluate(() => (window as any).__selectedGraphNode), "agent.frontend-developer");
    await page.evaluate(() => {
      (window as any).__selectedGraphNode = undefined;
    });
    await graphNode.press(" ");
    assert.equal(await page.evaluate(() => (window as any).__selectedGraphNode), "agent.frontend-developer");
  });
});

test("LibraryGraphChart lets users drag graph nodes and keeps them selectable", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryGraphChart } from "./web/components/library/LibraryGraphChart";

    const nodes = [
      { objectKey: "agent.marketing-seo-specialist", objectKind: "agent_definition", title: "SEO Agent" },
      { objectKey: "domain.marketing", objectKind: "domain_taxonomy", title: "Marketing" },
    ];
    const edges = [{
      fromObjectKey: "agent.marketing-seo-specialist",
      edgeType: "belongs_to_domain",
      toObjectKey: "domain.marketing",
      ontology: { confidence: 1, category: "classification" },
    }];

    function Harness() {
      const [version, setVersion] = React.useState(0);
      window.__remountGraph = () => setVersion((value) => value + 1);
      return (
        <LibraryGraphChart
          key={version}
          persistLayoutKey="drag-layout-test"
          nodes={nodes}
          edges={edges}
          onSelectNode={(node) => {
            window.__selectedGraphNode = node.objectKey;
          }}
        />
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    const node = page.getByRole("button", { name: "SEO Agent" });
    await node.waitFor();
    const before = await node.boundingBox();
    if (!before) throw new Error("missing graph node bounding box before drag");

    await node.dragTo(page.locator('[data-testid="library-graph-viewport"]'), {
      targetPosition: { x: before.x + 120, y: before.y + 40 },
    });

    const after = await node.boundingBox();
    if (!after) throw new Error("missing graph node bounding box after drag");
    assert.ok(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20);
    assert.match(
      await page.evaluate(() => window.localStorage.getItem("southstar:library-graph-layout:drag-layout-test") ?? ""),
      /agent\.marketing-seo-specialist/,
    );

    await page.evaluate(() => (window as any).__remountGraph());
    await page.waitForTimeout(50);
    const restored = await node.boundingBox();
    if (!restored) throw new Error("missing graph node bounding box after remount");
    assert.ok(Math.abs(restored.x - after.x) < 6);
    assert.ok(Math.abs(restored.y - after.y) < 6);

    await node.click();
    assert.equal(await page.evaluate(() => (window as any).__selectedGraphNode), "agent.marketing-seo-specialist");

    await page.locator('[data-testid="library-graph-reset-layout"]').click();
    assert.equal(await page.evaluate(() => window.localStorage.getItem("southstar:library-graph-layout:drag-layout-test")), null);
  });
});

async function withBrowserHarness(
  entry: string,
  run: (page: Page) => Promise<void>,
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-library-graph-test-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: "library-graph-harness.tsx",
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

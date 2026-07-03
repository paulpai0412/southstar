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
          nodes: [{ objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", title: "Frontend Developer" }],
          edges: [],
        }}
      />
    );
  `, async (page) => {
    await page.locator('[data-testid="library-graph-domain-filter"]').selectOption("research");
    await page.locator('[data-testid="library-graph-kind-filter"]').selectOption("skill_spec");
    await page.locator('[data-testid="library-graph-status-filter"]').selectOption("draft");

    await page.waitForFunction(() => (
      window.__graphRequests?.some((query) => (
        query.includes("scope=research")
        && query.includes("kind=skill_spec")
        && query.includes("status=draft")
      ))
    ));

    assert.equal(requests.some((query) => (
      query.includes("scope=research")
      && query.includes("kind=skill_spec")
      && query.includes("status=draft")
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

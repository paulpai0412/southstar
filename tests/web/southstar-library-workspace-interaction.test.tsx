import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import React from "../../web/node_modules/react";
import { renderToStaticMarkup } from "../../web/node_modules/react-dom/server";

const root = join(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
(globalThis as unknown as { React: typeof React }).React = React;

test("LibrarySidebar filters object rows and calls onSelectObject when a row is clicked", async () => {
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { LibrarySidebar } from "./web/components/library/LibrarySidebar";

    const model = {
      selectedScope: "software",
      domains: [{
        scope: "software",
        counts: { agent_definition: 2, skill_spec: 1 },
        objectGroups: [
          {
            objectKind: "agent_definition",
            objects: [
              {
                id: "obj-1",
                objectKey: "agent.planner",
                objectKind: "agent_definition",
                status: "approved",
                title: "Planner",
                scope: "software",
                sourcePath: "software/agents/planner.agent.md",
              },
              {
                id: "obj-2",
                objectKey: "agent.legacy",
                objectKind: "agent_definition",
                status: "deprecated",
                title: "Legacy",
                scope: "software",
                sourcePath: "software/agents/legacy.agent.md",
              },
            ],
          },
          {
            objectKind: "skill_spec",
            objects: [{
              id: "obj-3",
              objectKey: "skill.review",
              objectKind: "skill_spec",
              status: "approved",
              title: "Review",
              scope: "software",
              sourcePath: "software/skills/review.skill.md",
            }],
          },
        ],
      }],
    };

    function Harness() {
      const [selectedObjectKey, setSelectedObjectKey] = useState("");
      const [statusFilter, setStatusFilter] = useState("all");
      return (
        <LibrarySidebar
          model={model}
          selectedScope="software"
          selectedObjectKey={selectedObjectKey}
          statusFilter={statusFilter}
          onSelectScope={() => {}}
          onStatusFilterChange={(value) => {
            window.__statusFilter = value;
            setStatusFilter(value);
          }}
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
    await page.locator('[data-testid="library-object-row"]').first().waitFor();
    assert.equal(await page.locator('[data-testid="library-object-row"]').count(), 3);

    await page.locator('[data-testid="library-status-filter"]').selectOption("approved");

    assert.equal(await page.evaluate(() => (window as any).__statusFilter), "approved");
    assert.equal(await page.locator('[data-testid="library-object-row"]').count(), 2);
    assert.equal(await page.getByText("Legacy").count(), 0);

    await page.getByRole("button", { name: "Planner agent.planner approved" }).click();

    assert.equal(await page.evaluate(() => (window as any).__selectedObjectKey), "agent.planner");
    assert.equal(await page.getByRole("button", { name: "Planner agent.planner approved" }).getAttribute("aria-pressed"), "true");
  });
});

test("LibraryFileViewer exposes file tabs, editor, Save button, Sync button, and validation issues", async () => {
  const { LibraryFileViewer } = await import("../../web/components/library/LibraryFileViewer.tsx");
  const html = renderToStaticMarkup(React.createElement(LibraryFileViewer, {
    selectedFilePath: "software/agents/planner.agent.md",
    content: "schemaVersion: southstar.library.agent.v1\nid: planner\n",
    dirty: true,
    saving: false,
    syncing: false,
    issues: [{ severity: "error", path: "id", message: "id is required", code: "missing_id" }],
    onContentChange: () => {},
    onSave: () => {},
    onSync: () => {},
  } as any));

  for (const tab of ["Preview", "Edit", "Validate", "Edges", "Usage", "Provenance"]) {
    assert.match(html, new RegExp(`>${tab}<`));
  }
  assert.match(html, /data-testid="library-file-editor"/);
  assert.match(html, /data-testid="library-file-save"/);
  assert.match(html, /data-testid="library-file-sync"/);
  assert.match(html, /id is required/);
});

test("LibraryFileViewer updates action disabled states and switches tabs on click", async () => {
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileViewer } from "./web/components/library/LibraryFileViewer";

    const fileRecord = {
      relativePath: "software/agents/planner.agent.md",
      content: "title: Planner Agent",
      parsed: {
        ok: true,
        file: {
          objectKey: "agent.planner",
          objectKind: "agent_definition",
          title: "Planner Agent",
          scope: "software",
          status: "approved",
          frontmatter: { requiresToolRefs: ["tool.git"] },
          sourceHash: "abc123",
        },
        issues: [{ severity: "error", path: "id", message: "id is required", code: "missing_id" }],
      },
    };

    function Harness() {
      const [selectedFilePath, setSelectedFilePath] = useState(undefined);
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [syncing, setSyncing] = useState(false);
      return (
        <>
          <button data-testid="select-clean" onClick={() => { setSelectedFilePath(fileRecord.relativePath); setDirty(false); setSaving(false); setSyncing(false); }}>clean</button>
          <button data-testid="mark-dirty" onClick={() => setDirty(true)}>dirty</button>
          <button data-testid="mark-saving" onClick={() => setSaving(true)}>saving</button>
          <button data-testid="mark-syncing" onClick={() => setSyncing(true)}>syncing</button>
          <LibraryFileViewer
            selectedFilePath={selectedFilePath}
            fileRecord={selectedFilePath ? fileRecord : null}
            content={selectedFilePath ? fileRecord.content : ""}
            dirty={dirty}
            saving={saving}
            syncing={syncing}
            onContentChange={() => {}}
            onSave={() => { window.__saved = true; }}
            onSync={() => { window.__synced = true; }}
          />
        </>
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    const save = page.locator('[data-testid="library-file-save"]');
    const sync = page.locator('[data-testid="library-file-sync"]');
    await save.waitFor();

    assert.equal(await save.isDisabled(), true);
    assert.equal(await sync.isDisabled(), true);

    await page.locator('[data-testid="select-clean"]').click();
    assert.equal(await save.isDisabled(), true);
    assert.equal(await sync.isDisabled(), false);

    await page.locator('[data-testid="mark-dirty"]').click();
    assert.equal(await save.isDisabled(), false);
    assert.equal(await sync.isDisabled(), true);

    await page.locator('[data-testid="mark-saving"]').click();
    assert.equal(await save.isDisabled(), true);

    await page.locator('[data-testid="select-clean"]').click();
    await page.locator('[data-testid="mark-syncing"]').click();
    assert.equal(await sync.isDisabled(), true);

    await page.getByRole("button", { name: "Validate" }).click();
    await assertText(page, "pre", "missing_id");

    await page.getByRole("button", { name: "Preview" }).click();
    await assertText(page, "pre", "Planner Agent");
  });
});

test("library file API helpers unwrap envelopes and call file read, save, and sync routes", async () => {
  const api = await import("../../web/lib/library/api.ts");
  assert.equal(typeof api.readLibraryFile, "function");
  assert.equal(typeof api.saveLibraryFile, "function");
  assert.equal(typeof api.syncLibraryFile, "function");

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (String(input).endsWith("/sync")) {
      return new Response(JSON.stringify({ ok: true, result: { object: { objectKey: "agent.planner" }, edges: [] } }));
    }
    return new Response(JSON.stringify({
      ok: true,
      result: {
        relativePath: "software/agents/planner.agent.md",
        content: "title: Planner",
        parsed: { ok: true, file: { objectKey: "agent.planner" }, issues: [] },
      },
    }));
  };

  try {
    await api.readLibraryFile("software/agents/planner.agent.md");
    await api.saveLibraryFile("software/agents/planner.agent.md", "title: Planner v2");
    await api.syncLibraryFile("software/agents/planner.agent.md");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: "/api/library/files/software/agents/planner.agent.md", method: "GET", body: undefined },
    {
      url: "/api/library/files/software/agents/planner.agent.md",
      method: "PATCH",
      body: JSON.stringify({ content: "title: Planner v2" }),
    },
    { url: "/api/library/files/software/agents/planner.agent.md/sync", method: "POST", body: undefined },
  ]);
});

test("library file API helpers report HTTP and non-JSON failures predictably", async () => {
  const api = await import("../../web/lib/library/api.ts");
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response("upstream exploded", { status: 502, statusText: "Bad Gateway" });
    await assert.rejects(
      () => api.readLibraryFile("software/agents/planner.agent.md"),
      /Bad Gateway|upstream exploded/,
    );

    globalThis.fetch = async () => new Response("not json", { status: 200 });
    await assert.rejects(
      () => api.readLibraryFile("software/agents/planner.agent.md"),
      /Invalid JSON response/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LibraryWorkspace loads selected object files, saves dirty edits, and syncs clean content", async () => {
  const requests: Array<{ method: string; path: string; body?: string }> = [];
  let fileContent = "title: Planner Agent";

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.getByRole("button", { name: "Planner agent.planner approved" }).click();
    await page.locator('[data-testid="library-file-editor"]').waitFor();

    assert.equal(await page.getByText("software/agents/planner.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Planner Agent");

    await page.locator('[data-testid="library-file-editor"]').fill("title: Planner Agent v2");
    assert.equal(await page.locator('[data-testid="library-file-save"]').isDisabled(), false);
    assert.equal(await page.locator('[data-testid="library-file-sync"]').isDisabled(), true);

    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/library/files/software/agents/planner.agent.md") && response.request().method() === "PATCH"),
      page.locator('[data-testid="library-file-save"]').click(),
    ]);
    await page.waitForFunction(() => {
      const save = document.querySelector('[data-testid="library-file-save"]') as HTMLButtonElement | null;
      const sync = document.querySelector('[data-testid="library-file-sync"]') as HTMLButtonElement | null;
      return save?.disabled === true && sync?.disabled === false;
    });
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/library/files/software/agents/planner.agent.md/sync")),
      page.locator('[data-testid="library-file-sync"]').click(),
    ]);

    assert.deepEqual(requests.map((request) => [request.method, request.path]), [
      ["GET", "/api/library/workspace"],
      ["GET", "/api/library/files/software/agents/planner.agent.md"],
      ["PATCH", "/api/library/files/software/agents/planner.agent.md"],
      ["POST", "/api/library/files/software/agents/planner.agent.md/sync"],
    ]);
    assert.equal(
      requests.find((request) => request.method === "PATCH")?.body,
      JSON.stringify({ content: "title: Planner Agent v2" }),
    );
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({
        method: request.method(),
        path: url.pathname,
        body: request.method() === "PATCH" ? request.postData() ?? undefined : undefined,
      });

      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              selectedScope: "software",
              domains: [{
                scope: "software",
                counts: { agent_definition: 1 },
                objectGroups: [{
                  objectKind: "agent_definition",
                  objects: [{
                    id: "obj-1",
                    objectKey: "agent.planner",
                    objectKind: "agent_definition",
                    status: "approved",
                    title: "Planner",
                    scope: "software",
                    sourcePath: "software/agents/planner.agent.md",
                  }],
                }],
              }],
            },
          }),
        });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "GET") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", fileContent) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "PATCH") {
        fileContent = JSON.parse(request.postData() ?? "{}").content;
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", fileContent) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md/sync" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, result: { object: { objectKey: "agent.planner" }, edges: [] } }),
        });
        return;
      }

      await route.abort();
    });
  });
});

test("LibraryWorkspace ignores stale file load results after selecting a different object", async () => {
  let releasePlanner: (() => Promise<void>) | undefined;

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').nth(0).click();
    await page.locator('[data-testid="library-object-row"]').nth(1).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Builder Agent";
    });

    assert.equal(await page.getByText("software/agents/builder.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Builder Agent");

    await Promise.all([
      page.waitForResponse((response) => (
        response.url().endsWith("/api/library/files/software/agents/planner.agent.md")
        && response.request().method() === "GET"
      )),
      releasePlanner?.(),
    ]);
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return document.body.textContent?.includes("software/agents/builder.agent.md") && editor?.value === "title: Builder Agent";
    });

    assert.equal(await page.getByText("software/agents/builder.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Builder Agent");
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({ contentType: "application/json", body: workspaceEnvelope([
          libraryObject("agent.planner", "Planner", "software/agents/planner.agent.md"),
          libraryObject("agent.builder", "Builder", "software/agents/builder.agent.md"),
        ]) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md") {
        await new Promise<void>((resolve) => {
          releasePlanner = async () => {
            await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", "title: Planner Agent") });
            resolve();
          };
        });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/builder.agent.md") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/builder.agent.md", "title: Builder Agent") });
        return;
      }

      await route.abort();
    });
  });
});

test("LibraryWorkspace preserves edits typed while a save response is in flight", async () => {
  let releaseSave: (() => Promise<void>) | undefined;
  const requests: Array<{ method: string; path: string; body?: string }> = [];

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Planner Agent";
    });

    await page.locator('[data-testid="library-file-editor"]').fill("title: Planner Agent v2");
    await page.locator('[data-testid="library-file-save"]').click();
    await page.locator('[data-testid="library-file-editor"]').fill("title: Planner Agent v3");

    await releaseSave?.();
    await page.waitForFunction(() => {
      const save = document.querySelector('[data-testid="library-file-save"]') as HTMLButtonElement | null;
      return save?.textContent === "Save";
    });

    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Planner Agent v3");
    assert.equal(await page.locator('[data-testid="library-file-save"]').isDisabled(), false);
    assert.equal(
      requests.find((request) => request.method === "PATCH")?.body,
      JSON.stringify({ content: "title: Planner Agent v2" }),
    );
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({
        method: request.method(),
        path: url.pathname,
        body: request.method() === "PATCH" ? request.postData() ?? undefined : undefined,
      });

      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({ contentType: "application/json", body: workspaceEnvelope([
          libraryObject("agent.planner", "Planner", "software/agents/planner.agent.md"),
        ]) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "GET") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", "title: Planner Agent") });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "PATCH") {
        await new Promise<void>((resolve) => {
          releaseSave = async () => {
            await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", "title: Planner Agent v2") });
            resolve();
          };
        });
        return;
      }

      await route.abort();
    });
  });
});

test("LibraryWorkspace ignores stale save results after selecting a different object", async () => {
  let releasePlannerSave: (() => Promise<void>) | undefined;

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').nth(0).click();
    await page.locator('[data-testid="library-file-editor"]').waitFor();
    await page.locator('[data-testid="library-file-editor"]').fill("title: Planner Agent v2");
    await page.locator('[data-testid="library-file-save"]').click();

    await page.locator('[data-testid="library-object-row"]').nth(1).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Builder Agent";
    });

    await Promise.all([
      page.waitForResponse((response) => (
        response.url().endsWith("/api/library/files/software/agents/planner.agent.md")
        && response.request().method() === "PATCH"
      )),
      releasePlannerSave?.(),
    ]);
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return document.body.textContent?.includes("software/agents/builder.agent.md") && editor?.value === "title: Builder Agent";
    });

    assert.equal(await page.getByText("software/agents/builder.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Builder Agent");
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());

      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({ contentType: "application/json", body: workspaceEnvelope([
          libraryObject("agent.planner", "Planner", "software/agents/planner.agent.md"),
          libraryObject("agent.builder", "Builder", "software/agents/builder.agent.md"),
        ]) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "GET") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", "title: Planner Agent") });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "PATCH") {
        await new Promise<void>((resolve) => {
          releasePlannerSave = async () => {
            await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", "title: Planner Agent v2") });
            resolve();
          };
        });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/builder.agent.md") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/builder.agent.md", "title: Builder Agent") });
        return;
      }

      await route.abort();
    });
  });
});

test("LibraryWorkspace shows failed file loads and keeps Sync disabled", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').click();
    await assertText(page, '[data-testid="library-file-status"]', "Failed to load");
    assert.equal(await page.locator('[data-testid="library-file-sync"]').isDisabled(), true);
    assert.equal(await page.locator('[data-testid="library-file-save"]').isDisabled(), true);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({ contentType: "application/json", body: workspaceEnvelope([
          libraryObject("agent.planner", "Planner", "software/agents/planner.agent.md"),
        ]) });
        return;
      }
      if (url.pathname === "/api/library/files/software/agents/planner.agent.md") {
        await route.fulfill({ status: 500, contentType: "text/plain", body: "file unavailable" });
        return;
      }
      await route.abort();
    });
  });
});

test("LibraryWorkspace resets selected file state when changing scopes", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.getByRole("button", { name: "software" }).click();
    await page.getByRole("button", { name: "Planner agent.planner approved" }).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Planner Agent";
    });
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Planner Agent");

    await page.getByRole("button", { name: "data", exact: true }).click();

    assert.equal(await page.getByText("Select a library object").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "");
    assert.equal(await page.locator('[data-testid="library-file-sync"]').isDisabled(), true);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({
          contentType: "application/json",
          body: workspaceEnvelope([
            libraryObject("agent.planner", "Planner", "software/agents/planner.agent.md"),
            libraryObject("agent.data", "Data", "data/agents/data.agent.md", "data"),
          ]),
        });
        return;
      }
      if (url.pathname === "/api/library/files/software/agents/planner.agent.md") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", "title: Planner Agent") });
        return;
      }
      await route.abort();
    });
  });
});

async function withBrowserHarness(
  entry: string,
  run: (page: Page) => Promise<void>,
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-library-test-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: "library-workspace-harness.tsx",
      loader: "tsx",
    },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin(), libraryChatMockPlugin()],
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
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: join(root, "web/node_modules/react/index.js") }));
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: join(root, "web/node_modules/react/jsx-runtime.js") }));
      buildApi.onResolve({ filter: /^react-dom$/ }, () => ({ path: join(root, "web/node_modules/react-dom/index.js") }));
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(root, "web/node_modules/react-dom/client.js") }));
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

function libraryChatMockPlugin() {
  return {
    name: "library-chat-mock",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^\.\/LibraryChatWindow$/ }, (args: any) => {
        if (!args.importer.endsWith("LibraryWorkspace.tsx")) return undefined;
        return { path: "library-chat-window-mock", namespace: "southstar-test" };
      });
      buildApi.onLoad({ filter: /.*/, namespace: "southstar-test" }, () => ({
        loader: "js",
        contents: `
          import React from "react";
          export function LibraryChatWindow() {
            return React.createElement("div", { "data-testid": "library-chat-mock" });
          }
        `,
      }));
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

function workspaceEnvelope(objects: Array<{
  id: string;
  objectKey: string;
  objectKind: string;
  status: string;
  title: string;
  scope: string;
  sourcePath: string;
}>): string {
  const groupsByScope = new Map<string, typeof objects>();
  for (const object of objects) {
    const scoped = groupsByScope.get(object.scope) ?? [];
    scoped.push(object);
    groupsByScope.set(object.scope, scoped);
  }
  return JSON.stringify({
    ok: true,
    result: {
      selectedScope: "software",
      domains: Array.from(groupsByScope.entries()).map(([scope, scopedObjects]) => ({
        scope,
        counts: { agent_definition: scopedObjects.length },
        objectGroups: [{ objectKind: "agent_definition", objects: scopedObjects }],
      })),
    },
  });
}

function libraryObject(objectKey: string, title: string, sourcePath: string, scope = "software") {
  return {
    id: objectKey,
    objectKey,
    objectKind: "agent_definition",
    status: "approved",
    title,
    scope,
    sourcePath,
  };
}

function libraryFileEnvelope(relativePath: string, content: string): string {
  return JSON.stringify({
    ok: true,
    result: {
      relativePath,
      content,
      parsed: {
        ok: true,
        file: {
          objectKey: relativePath.includes("builder") ? "agent.builder" : "agent.planner",
          objectKind: "agent_definition",
          title: content.replace(/^title:\s*/, ""),
          scope: "software",
          status: "approved",
          frontmatter: {},
          sourceHash: "abc123",
        },
        issues: [],
      },
    },
  });
}

async function assertText(page: Page, selector: string, expected: string): Promise<void> {
  const text = await page.locator(selector).textContent();
  assert.match(text ?? "", new RegExp(expected));
}

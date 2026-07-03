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

test("LibrarySidebar renders the domain tree and calls onSelectObject when a row is clicked", async () => {
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
      return (
        <LibrarySidebar
          model={model}
          sessions={[{ id: "library-session-1", title: "Research import run", status: "completed" }]}
          selectedSessionId="library-session-1"
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
    await page.locator('[data-testid="library-object-row"]').first().waitFor();
    assert.equal(await page.locator('[data-testid="library-object-row"]').count(), 3);
    await page.getByText("Library LLM Sessions").waitFor();
    await page.getByText("Library Domain Tree").waitFor();
    await page.getByText("Research import run").waitFor();
    await page.getByText("agents", { exact: true }).waitFor();
    await page.getByText("skills", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Planner agent.planner approved" }).click();

    assert.equal(await page.evaluate(() => (window as any).__selectedObjectKey), "agent.planner");
    assert.equal(await page.getByRole("button", { name: "Planner agent.planner approved" }).getAttribute("aria-pressed"), "true");
  });
});

test("LibraryFileViewer exposes file tabs, editor, Save button, Sync button, and validation issues", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileViewer } from "./web/components/library/LibraryFileViewer";

    createRoot(document.getElementById("root")).render(
      <LibraryFileViewer
        selectedFilePath="software/agents/planner.agent.md"
        content={"schemaVersion: southstar.library.agent.v1\\nid: planner\\n"}
        dirty={true}
        saving={false}
        syncing={false}
        issues={[{ severity: "error", path: "id", message: "id is required", code: "missing_id" }]}
        onContentChange={() => {}}
        onSave={() => {}}
        onSync={() => {}}
      />
    );
  `, async (page) => {
    for (const tab of ["Preview", "Edit", "Validate", "Edges", "Usage", "Provenance"]) {
      await page.getByRole("button", { name: tab }).waitFor();
    }
    await page.locator('[data-testid="library-file-editor"]').waitFor();
    await page.locator('[data-testid="library-file-save"]').waitFor();
    await page.locator('[data-testid="library-file-sync"]').waitFor();
    await assertText(page, "body", "id is required");
  });
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

test("LibraryFileViewer renders graph-backed edge usage and provenance detail", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileViewer } from "./web/components/library/LibraryFileViewer";

    createRoot(document.getElementById("root")).render(
      <LibraryFileViewer
        selectedFilePath="software/skills/react-ui.skill.md"
        fileRecord={{
          relativePath: "software/skills/react-ui.skill.md",
          content: "title: React UI",
          parsed: {
            ok: true,
            file: {
              objectKey: "skill.react-ui",
              objectKind: "skill_spec",
              title: "React UI",
              scope: "software",
              status: "approved",
              frontmatter: {},
              sourceHash: "abc123",
            },
            issues: [],
          },
        }}
        objectDetail={{
          object: {
            objectKey: "skill.react-ui",
            objectKind: "skill_spec",
            status: "approved",
            headVersionId: "skill.react-ui@v1",
            state: { scope: "software", title: "React UI", sourcePath: "software/skills/react-ui.skill.md" },
          },
          inboundEdges: [{ fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" }],
          outboundEdges: [{ fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.browser", scope: "software" }],
          usage: {
            inboundCount: 1,
            outboundCount: 1,
            usedByObjectKeys: ["agent.frontend-developer"],
            dependsOnObjectKeys: ["tool.browser"],
          },
          validation: { ok: true, issues: [] },
        }}
        content="title: React UI"
        dirty={false}
        saving={false}
        syncing={false}
        onContentChange={() => {}}
        onSave={() => {}}
        onSync={() => {}}
      />
    );
  `, async (page) => {
    await page.getByRole("button", { name: "Edges" }).click();
    await assertText(page, "pre", "agent.frontend-developer");
    await assertText(page, "pre", "tool.browser");

    await page.getByRole("button", { name: "Usage" }).click();
    await assertText(page, "pre", "inboundCount");
    await assertText(page, "pre", "outboundCount");

    await page.getByRole("button", { name: "Provenance" }).click();
    await assertText(page, "pre", "skill.react-ui@v1");
  });
});

test("library file API helpers unwrap envelopes and call file read, save, and sync routes", async () => {
  const api = await import("../../web/lib/library/api.ts");
  assert.equal(typeof api.readLibraryFile, "function");
  assert.equal(typeof api.readLibraryObjectDetail, "function");
  assert.equal(typeof api.saveLibraryFile, "function");
  assert.equal(typeof api.syncLibraryFile, "function");

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (String(input).includes("/api/library/objects/")) {
      return new Response(JSON.stringify({ ok: true, result: { object: { objectKey: "agent.planner" }, inboundEdges: [], outboundEdges: [] } }));
    }
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
    await api.readLibraryObjectDetail("agent.planner");
    await api.saveLibraryFile("software/agents/planner.agent.md", "title: Planner v2");
    await api.syncLibraryFile("software/agents/planner.agent.md");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: "/api/library/files/software/agents/planner.agent.md", method: "GET", body: undefined },
    { url: "/api/library/objects/agent.planner", method: "GET", body: undefined },
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
      ["GET", "/api/library/objects/agent.planner"],
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

      if (url.pathname === "/api/library/objects/agent.planner") {
        await route.fulfill({ contentType: "application/json", body: libraryObjectDetailEnvelope("agent.planner") });
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

test("LibraryWorkspace refreshes sidebar after LibraryChatWindow approves an import draft", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  let workspaceFetches = 0;

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.locator('[data-testid="library-quick-prompt"]').fill("create a browser verification skill");
    await page.locator('[data-testid="library-quick-prompt-submit"]').click();
    await page.getByText("Dependencies").waitFor();
    await page.locator('[data-testid="library-session-row"]').filter({ hasText: "create a browser verification skill" }).waitFor();
    assert.equal(await page.locator('[data-testid="library-session-row"]').filter({ hasText: "ready_for_review" }).count(), 1);
    assert.equal(await page.getByText("Browser Verification").count() > 0, true);
    assert.equal(await page.getByText(/requires_tool/).count() > 0, true);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("button", { name: /Browser Verification/ }).waitFor();

    assert.equal(workspaceFetches, 2);
    assert.equal(await page.locator('[data-testid="library-object-row"]').filter({ hasText: "skill.browser-verification" }).count(), 1);
    assert.deepEqual(requests.map((request) => [request.method, request.path]), [
      ["GET", "/api/library/workspace"],
      ["POST", "/api/library/import-drafts"],
      ["POST", "/api/library/import-drafts/library-import-draft-1/approve"],
      ["GET", "/api/library/workspace"],
    ]);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });

      if (url.pathname === "/api/library/workspace") {
        workspaceFetches += 1;
        const objects = workspaceFetches === 1
          ? []
          : [libraryObject(
              "skill.browser-verification",
              "Browser Verification",
              "skills/browser-verification.skill.md",
              "software",
              "skill_spec",
            )];
        await route.fulfill({
          contentType: "application/json",
          body: workspaceEnvelope(objects),
        });
        return;
      }

      if (url.pathname === "/api/library/import-drafts" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              draftId: "library-import-draft-1",
              status: "draft",
              proposal: {
                objectKeys: ["skill.browser-verification"],
                objectSummaries: [{
                  objectKey: "skill.browser-verification",
                  objectKind: "skill_spec",
                  title: "Browser Verification",
                  scope: "software",
                  status: "draft",
                  relativePath: "skills/browser-verification.skill.md",
                }],
                dependencies: [{
                  fromObjectKey: "skill.browser-verification",
                  edgeType: "requires_tool",
                  toObjectKey: "tool.browser",
                  scope: "software",
                }],
                files: [{ relativePath: "skills/browser-verification.skill.md", content: "content" }],
              },
            },
          }),
        });
        return;
      }

      if (url.pathname === "/api/library/import-drafts/library-import-draft-1/approve" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              draftId: "library-import-draft-1",
              status: "approved",
              proposal: {
                objectKeys: ["skill.browser-verification"],
                objectSummaries: [{
                  objectKey: "skill.browser-verification",
                  objectKind: "skill_spec",
                  title: "Browser Verification",
                  scope: "software",
                  status: "draft",
                  relativePath: "skills/browser-verification.skill.md",
                }],
                dependencies: [{
                  fromObjectKey: "skill.browser-verification",
                  edgeType: "requires_tool",
                  toObjectKey: "tool.browser",
                  scope: "software",
                }],
                files: [{ relativePath: "skills/browser-verification.skill.md", content: "content" }],
              },
              files: [{ relativePath: "skills/browser-verification.skill.md" }],
              synced: [{ object: { objectKey: "skill.browser-verification" }, edges: [] }],
            },
          }),
        });
        return;
      }

      await route.abort();
    });
  }, { mockLibraryChat: false });
});

test("LibraryWorkspace opens the right file viewer when a chat graph node is selected", async () => {
  const requests: Array<{ method: string; path: string }> = [];

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryWorkspace } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(<LibraryWorkspace />);
  `, async (page) => {
    await page.locator('[data-testid="library-chat-input"]').fill("show the current library graph");
    await page.locator('[data-testid="library-chat-send"]').click();

    await page.locator('[data-testid="library-graph-block"]').getByRole("button", { name: "Frontend Developer" }).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Frontend Developer";
    });

    assert.equal(await page.getByText("software/agents/frontend-developer.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Frontend Developer");
    assert.deepEqual(requests.map((request) => [request.method, request.path]), [
      ["GET", "/api/library/workspace"],
      ["POST", "/api/library/chat/messages"],
      ["GET", "/api/library/chat/events"],
      ["GET", "/api/library/graph"],
      ["GET", "/api/library/objects/agent.frontend-developer"],
      ["GET", "/api/library/files/software/agents/frontend-developer.agent.md"],
    ]);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });

      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({ contentType: "application/json", body: workspaceEnvelope([
          libraryObject("agent.frontend-developer", "Frontend Developer", "software/agents/frontend-developer.agent.md"),
        ]) });
        return;
      }

      if (url.pathname === "/api/library/chat/messages" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, result: { sessionId: "library-session-1", actionId: "action-1" } }),
        });
        return;
      }

      if (url.pathname === "/api/library/chat/events" && request.method() === "GET") {
        await route.fulfill({
          contentType: "text/event-stream",
          body: [
            "event: library.graph.snapshot",
            'data: {"activeScope":"software","availableScopes":["software"],"nodes":[{"objectKey":"agent.frontend-developer","objectKind":"agent_definition","status":"approved","title":"Frontend Developer"}],"edges":[]}',
            "",
            "event: library.command.completed",
            'data: {"status":"completed"}',
            "",
          ].join("\n"),
        });
        return;
      }

      if (url.pathname === "/api/library/graph" && request.method() === "GET") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              activeScope: "software",
              availableScopes: ["software"],
              nodes: [{
                objectKey: "agent.frontend-developer",
                objectKind: "agent_definition",
                status: "approved",
                title: "Frontend Developer",
              }],
              edges: [],
            },
          }),
        });
        return;
      }

      if (url.pathname === "/api/library/objects/agent.frontend-developer") {
        await route.fulfill({ contentType: "application/json", body: libraryObjectDetailEnvelope("agent.frontend-developer") });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/frontend-developer.agent.md") {
        await route.fulfill({
          contentType: "application/json",
          body: libraryFileEnvelope("software/agents/frontend-developer.agent.md", "title: Frontend Developer"),
        });
        return;
      }

      await route.abort();
    });
  }, { mockLibraryChat: false });
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
  options: { mockLibraryChat?: boolean } = {},
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
    plugins: [
      reactAliasPlugin(),
      webAliasPlugin(),
      ...(options.mockLibraryChat === false ? [] : [libraryChatMockPlugin()]),
    ],
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
        counts: scopedObjects.reduce<Record<string, number>>((counts, object) => {
          counts[object.objectKind] = (counts[object.objectKind] ?? 0) + 1;
          return counts;
        }, {}),
        objectGroups: Array.from(
          scopedObjects.reduce<Map<string, typeof objects>>((groups, object) => {
            const group = groups.get(object.objectKind) ?? [];
            group.push(object);
            groups.set(object.objectKind, group);
            return groups;
          }, new Map()).entries(),
        ).map(([objectKind, objects]) => ({ objectKind, objects })),
      })),
    },
  });
}

function libraryObject(
  objectKey: string,
  title: string,
  sourcePath: string,
  scope = "software",
  objectKind = "agent_definition",
) {
  return {
    id: objectKey,
    objectKey,
    objectKind,
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

function libraryObjectDetailEnvelope(objectKey: string): string {
  return JSON.stringify({
    ok: true,
    result: {
      object: {
        objectKey,
        objectKind: objectKey.startsWith("skill.") ? "skill_spec" : "agent_definition",
        status: "approved",
        headVersionId: `${objectKey}@v1`,
        state: { scope: "software", title: objectKey },
      },
      inboundEdges: [],
      outboundEdges: [],
      usage: {
        inboundCount: 0,
        outboundCount: 0,
        usedByObjectKeys: [],
        dependsOnObjectKeys: [],
      },
      validation: { ok: true, issues: [] },
    },
  });
}

async function assertText(page: Page, selector: string, expected: string): Promise<void> {
  const text = await page.locator(selector).textContent();
  assert.match(text ?? "", new RegExp(expected));
}

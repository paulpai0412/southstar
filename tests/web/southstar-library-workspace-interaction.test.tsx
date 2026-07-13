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
          sessions={[{
            id: "library-session-1",
            path: "",
            cwd: "/workspace",
            name: "Research import run",
            firstMessage: "Research import run",
            kind: "library",
            created: "2026-07-07T00:00:00.000Z",
            modified: "2026-07-07T00:00:01.000Z",
            messageCount: 1,
          }]}
          selectedSessionId="library-session-1"
          selectedScope="software"
          selectedObjectKey={selectedObjectKey}
          selectedCwd="/workspace"
          statusFilter="all"
          onCwdChange={() => {}}
          onSelectScope={() => {}}
          onStatusFilterChange={() => {}}
          onSelectObject={(object) => {
            window.__selectedObjectKey = object.objectKey;
            setSelectedObjectKey(object.objectKey);
          }}
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

test("LibraryFileViewer exposes graph-first tabs, one Save & Sync action, editor, and validation line issues", async () => {
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
        onSaveAndSync={() => {}}
      />
    );
  `, async (page) => {
    const tabs = page.getByRole("button").filter({ hasText: /^(Edges|Preview|Edit|Validate|Usage)$/ });
    assert.deepEqual(await tabs.allTextContents(), ["Edges", "Preview", "Edit", "Validate", "Usage"]);
    await assertText(page, "body", "Provenance", false);
    for (const tab of ["Edges", "Preview", "Edit", "Validate", "Usage"]) {
      await page.getByRole("button", { name: tab }).waitFor();
    }
    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator('[data-testid="library-file-editor"]').waitFor();
    await page.locator('[data-testid="library-file-save-sync"]').waitFor();
    assert.equal(await page.locator('[data-testid="library-file-save"]').count(), 0);
    assert.equal(await page.locator('[data-testid="library-file-sync"]').count(), 0);
    await assertText(page, '[data-testid="library-file-line-issue"]', "line");
    await assertText(page, "body", "id is required");
  });
});

test("LibraryFileViewer validates edited content, disables Save & Sync on errors, and renders a pretty preview", async () => {
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
            objectDetail={selectedFilePath ? {
              object: {
                objectKey: "agent.planner",
                objectKind: "agent_definition",
                status: "approved",
                headVersionId: "agent.planner@v1",
                state: { scope: "software", title: "Planner Agent", sourcePath: fileRecord.relativePath },
              },
              inboundEdges: [],
              outboundEdges: [],
              usage: { inboundCount: 0, outboundCount: 0, usedByObjectKeys: [], dependsOnObjectKeys: [] },
              validation: { ok: true, issues: [] },
            } : null}
            content={selectedFilePath ? (dirty ? "title: Planner Agent" : fileRecord.content) : ""}
            dirty={dirty}
            saving={saving}
            syncing={syncing}
            onContentChange={() => {}}
            onSaveAndSync={() => { window.__savedAndSynced = true; }}
          />
        </>
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    const saveSync = page.locator('[data-testid="library-file-save-sync"]');
    await saveSync.waitFor();

    assert.equal(await saveSync.isDisabled(), true);

    await page.locator('[data-testid="select-clean"]').click();
    assert.equal(await saveSync.isDisabled(), true);

    await page.locator('[data-testid="mark-dirty"]').click();
    assert.equal(await saveSync.isDisabled(), true);
    await assertText(page, '[data-testid="library-file-line-issue"]', "frontmatter");

    await page.locator('[data-testid="mark-saving"]').click();
    assert.equal(await saveSync.isDisabled(), true);

    await page.locator('[data-testid="select-clean"]').click();
    await page.locator('[data-testid="mark-syncing"]').click();
    assert.equal(await saveSync.isDisabled(), true);

    await page.getByRole("button", { name: "Validate" }).click();
    await assertText(page, '[data-testid="library-validation-panel"]', "missing_id");

    await page.getByRole("button", { name: "Preview" }).click();
    await assertText(page, '[data-testid="library-file-preview"]', "Planner Agent");
    await assertText(page, '[data-testid="library-file-preview"]', "agent.planner@v1");
  });
});

test("LibraryFileViewer renders graph-backed edge chart, usage, and merged provenance preview", async () => {
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
          inboundEdges: [{ fromObjectKey: "agent.frontend-developer", edgeType: "uses", toObjectKey: "skill.react-ui", scope: "software" }],
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
        onSaveAndSync={() => {}}
        edgeGraph={{
          activeScope: "software",
          availableScopes: ["software"],
          nodes: [
            { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", title: "Frontend Developer" },
            { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", title: "React UI" },
            { objectKey: "tool.browser", objectKind: "tool_definition", status: "approved", title: "Browser Tool" },
          ],
          edges: [
            { fromObjectKey: "agent.frontend-developer", edgeType: "uses", toObjectKey: "skill.react-ui", ontology: { confidence: 0.9 } },
            { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.browser", ontology: { confidence: 0.8 } },
          ],
        }}
        onSelectGraphNode={(node) => {
          window.__selectedGraphNode = node.objectKey;
        }}
      />
    );
  `, async (page) => {
    await page.locator('[data-testid="library-graph-chart"]').waitFor();
    assert.equal(await page.locator('[data-testid="library-graph-edge"]').count(), 2);
    await page.getByRole("button", { name: "Frontend Developer" }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedGraphNode), "agent.frontend-developer");

    await page.getByRole("button", { name: "Usage" }).click();
    await assertText(page, '[data-testid="library-usage-panel"]', "Used by");
    await assertText(page, '[data-testid="library-usage-panel"]', "Depends on");

    await page.getByRole("button", { name: "Preview" }).click();
    await assertText(page, '[data-testid="library-file-preview"]', "skill.react-ui@v1");
    await assertText(page, '[data-testid="library-file-preview"]', "abc123");
  });
});

test("LibraryCandidateMessageBlock keeps candidate install controls in the message header and disables installed objects", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryCandidateMessageBlock } from "./web/components/library/LibraryCandidateMessageBlock";

    const candidates = [
      {
        objectKey: "skill.beautiful-article",
        kind: "skill",
        title: "Beautiful Article",
        scope: "design",
        sourcePath: "skills/beautiful-article/SKILL.md",
        selectedByDefault: true,
        confidence: 0.96,
      },
      {
        objectKey: "agent.article-editor",
        kind: "agent",
        title: "Article Editor",
        scope: "design",
        sourcePath: "agents/article-editor.agent.md",
        selectedByDefault: true,
        confidence: 0.91,
      },
    ];

    createRoot(document.getElementById("root")).render(
      <LibraryCandidateMessageBlock
        draftId="library-import-draft-ui"
        candidates={candidates}
        proposedEdges={[]}
        status="draft"
        installedObjectKeys={["skill.beautiful-article"]}
        onInstall={(selectedCandidateIds) => {
          window.__selectedCandidateIds = selectedCandidateIds;
        }}
      />
    );
  `, async (page) => {
    const block = page.locator('[data-testid="library-import-candidates"]');
    await block.waitFor();
    await block.getByText("Beautiful Article").waitFor();
    await block.getByText("Article Editor").waitFor();
    assert.equal(await block.getAttribute("data-message-block"), "library-import-candidates");

    const header = block.locator('[data-testid="library-import-candidates-toolbar"]');
    const controls = header.locator('[data-testid="library-import-candidates-controls"]');
    await header.getByRole("button", { name: "Select all candidates", exact: true }).waitFor();
    await header.getByRole("button", { name: "Unselect all candidates", exact: true }).waitFor();
    await header.getByRole("button", { name: "Install selected candidates", exact: true }).waitFor();
    assert.equal(await controls.evaluate((node) => getComputedStyle(node).justifyContent), "flex-start");

    assert.equal(await block.getByRole("checkbox", { name: /Beautiful Article/ }).isDisabled(), true);
    assert.equal(await block.getByRole("checkbox", { name: /Beautiful Article/ }).isChecked(), false);
    assert.equal(await block.getByRole("checkbox", { name: /Article Editor/ }).isChecked(), true);
    await assertText(page, '[data-testid="library-import-candidates"]', "Already installed");

    await header.getByRole("button", { name: "Unselect all candidates", exact: true }).click();
    assert.equal(await block.getByRole("checkbox", { name: /Article Editor/ }).isChecked(), false);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await block.getByRole("checkbox", { name: /Article Editor/ }).isChecked(), false);
    assert.equal(await header.getByRole("button", { name: "Install selected candidates", exact: true }).isDisabled(), true);
    await header.getByRole("button", { name: "Select all candidates", exact: true }).click();
    assert.equal(await block.getByRole("checkbox", { name: /Beautiful Article/ }).isChecked(), false);
    assert.equal(await block.getByRole("checkbox", { name: /Article Editor/ }).isChecked(), true);

    await header.getByRole("button", { name: "Hide candidates" }).click();
    assert.equal(await block.getByText("Article Editor").count(), 0);
    await header.getByRole("button", { name: "Show candidates" }).click();
    await block.getByText("Article Editor").waitFor();

    await block.getByRole("checkbox", { name: /Article Editor/ }).setChecked(true);
    await header.getByRole("button", { name: "Install selected candidates", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).__selectedCandidateIds), ["agent.article-editor"]);
  });
});

test("LibraryCandidateMessageBlock keeps uninstalled candidates selectable after a partial install", async () => {
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryCandidateMessageBlock } from "./web/components/library/LibraryCandidateMessageBlock";

    const candidates = [
      {
        objectKey: "skill.brainstorming",
        kind: "skill",
        title: "Brainstorming",
        scope: "software",
        sourcePath: "skills/brainstorming/SKILL.md",
        selectedByDefault: true,
        confidence: 0.96,
      },
      {
        objectKey: "skill.using-superpowers",
        kind: "skill",
        title: "Using Superpowers",
        scope: "software",
        sourcePath: "skills/using-superpowers/SKILL.md",
        selectedByDefault: true,
        confidence: 0.95,
      },
    ];

    function Harness() {
      const [installedObjectKeys, setInstalledObjectKeys] = useState([]);
      const [status, setStatus] = useState("draft");
      return (
        <LibraryCandidateMessageBlock
          draftId="library-import-draft-partial"
          candidates={candidates}
          proposedEdges={[]}
          status={status}
          installedObjectKeys={installedObjectKeys}
          onInstall={(selectedCandidateIds) => {
            window.__selectedCandidateIds = selectedCandidateIds;
            setInstalledObjectKeys((current) => [...new Set([...current, ...selectedCandidateIds])]);
            setStatus("installed");
          }}
        />
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    const block = page.locator('[data-testid="library-import-candidates"]');
    const header = block.locator('[data-testid="library-import-candidates-toolbar"]');
    const brainstorming = block.getByRole("checkbox", { name: /Brainstorming/ });
    const usingSuperpowers = block.getByRole("checkbox", { name: /Using Superpowers/ });

    await block.waitFor();
    await usingSuperpowers.setChecked(false);
    await header.getByRole("button", { name: "Install selected candidates", exact: true }).click();

    assert.equal(await brainstorming.isDisabled(), true);
    assert.equal(await usingSuperpowers.isDisabled(), false);
    await usingSuperpowers.setChecked(true);
    assert.equal(await usingSuperpowers.isChecked(), true);
  });
});

test("library file API helpers unwrap envelopes and call file read, save, and sync routes", async () => {
  const api = await import("../../web/lib/library/api.ts");
  assert.equal(typeof api.readLibraryFile, "function");
  assert.equal(typeof api.readLibraryObjectDetail, "function");
  assert.equal(typeof api.deleteLibraryObject, "function");
  assert.equal(typeof api.saveLibraryFile, "function");
  assert.equal(typeof api.syncLibraryFile, "function");

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body as string | undefined });
    if (String(input).includes("/api/library/objects/") && init?.method === "DELETE") {
      return new Response(JSON.stringify({
        ok: true,
        result: {
          object: { objectKey: "agent.planner" },
          deletedObjectKey: "agent.planner",
          deletedObjectCount: 1,
          deletedEdgeCount: 0,
          inboundEdgeCount: 0,
          outboundEdgeCount: 0,
        },
      }));
    }
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
    await api.deleteLibraryObject("agent.planner");
    await api.saveLibraryFile("software/agents/planner.agent.md", "title: Planner v2");
    await api.syncLibraryFile("software/agents/planner.agent.md");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { url: "/api/library/files/software/agents/planner.agent.md", method: "GET", body: undefined },
    { url: "/api/library/objects/agent.planner", method: "GET", body: undefined },
    { url: "/api/library/objects/agent.planner", method: "DELETE", body: undefined },
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

test("library readiness API helper reads the current snapshot and maps reconcile results", async () => {
  const api = await import("../../web/lib/library/api.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "/api/library/readiness");
    return new Response(JSON.stringify({ ok: true, result: {
      readiness: {
        ready: true,
        status: "ready_with_warnings",
        snapshotHash: "snapshot-hash",
        includedCount: 1,
        excludedCount: 1,
        diagnostics: [{ code: "reconcile_excluded", message: "missing tool.absent", paths: ["skills/imported.skill.md"], missingRefs: ["tool.absent"] }],
      },
    } }));
  };
  try {
    const readiness = await api.readLibraryReadiness();
    assert.equal(readiness.snapshotHash, "snapshot-hash");
    const mapped = api.readinessFromReconcile({
      schemaVersion: "southstar.library_sync_snapshot.v1",
      snapshotHash: "mapped-hash",
      status: "ready_with_warnings",
      sourceRoot: "library",
      trigger: "library_save",
      included: [{ path: "skills/goal.skill.md", objectKey: "skill.goal", objectKind: "skill_spec", sourceHash: "hash", versionRef: "skill.goal@hash" }],
      excluded: [{ path: "skills/imported.skill.md", objectKey: "skill.imported", reason: "missing tool.absent", missingRefs: ["tool.absent"] }],
      deprecatedObjectKeys: [],
      warnings: ["missing tool.absent"],
    });
    assert.deepEqual(mapped.diagnostics[0], {
      code: "reconcile_excluded",
      message: "missing tool.absent",
      paths: ["skills/imported.skill.md"],
      missingRefs: ["tool.absent"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LibrarySidebarPanel renders current Library readiness diagnostics", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibrarySidebarPanel, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider>
        <LibrarySidebarPanel />
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-readiness"]').waitFor();
    await page.getByText("Library ready").waitFor();
    await page.getByText("1 included · 1 excluded").waitFor();
    await page.getByText("missing tool.absent").waitFor();
    await page.getByText(/skills\/imported\.skill\.md/).waitFor();
  }, async (page) => {
    await page.route("**/api/sessions**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
    });
    await page.route("**/api/library/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, result: { selectedScope: "all", domains: [] } }),
        });
        return;
      }
      if (url.pathname === "/api/library/readiness") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ ok: true, result: {
            readiness: {
              ready: true,
              status: "ready_with_warnings",
              snapshotHash: "abcdef1234567890",
              includedCount: 1,
              excludedCount: 1,
              diagnostics: [{ code: "reconcile_excluded", message: "missing tool.absent", paths: ["skills/imported.skill.md"], missingRefs: ["tool.absent"] }],
            },
          } }),
        });
        return;
      }
      await route.abort();
    });
  });
});

test("LibraryWorkspace loads selected object files, saves dirty edits, and syncs clean content", async () => {
  const requests: Array<{ method: string; path: string; query?: string; body?: string }> = [];
  let fileContent = validAgentContent("agent.planner", "Planner Agent");
  const updatedContent = validAgentContent("agent.planner", "Planner Agent v2");

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider defaultCwd="/workspace">
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.getByRole("button", { name: "Planner agent.planner approved" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator('[data-testid="library-file-editor"]').waitFor();

    assert.equal(await page.getByText("software/agents/planner.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), fileContent);

    await page.locator('[data-testid="library-file-editor"]').fill(updatedContent);
    assert.equal(await page.locator('[data-testid="library-file-save-sync"]').isDisabled(), false);

    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/library/files/software/agents/planner.agent.md") && response.request().method() === "PATCH"),
      page.waitForResponse((response) => response.url().endsWith("/api/library/files/software/agents/planner.agent.md/sync")),
      page.locator('[data-testid="library-file-save-sync"]').click(),
    ]);

    assert.deepEqual(
      requests
        .filter((request) => request.path !== "/api/sessions")
        .map((request) => [request.method, request.path]),
      [
      ["GET", "/api/library/workspace"],
      ["GET", "/api/library/readiness"],
      ["GET", "/api/library/objects/agent.planner"],
      ["GET", "/api/library/graph"],
      ["GET", "/api/library/files/software/agents/planner.agent.md"],
      ["PATCH", "/api/library/files/software/agents/planner.agent.md"],
      ["POST", "/api/library/files/software/agents/planner.agent.md/sync"],
      ],
    );
    assert.equal(
      requests.some((request) => request.method === "GET" && request.path === "/api/sessions" && request.query === "scope=all&kind=library&limit=50&compact=1"),
      true,
    );
    assert.equal(
      requests.find((request) => request.method === "PATCH")?.body,
      JSON.stringify({ content: updatedContent }),
    );
  }, async (page) => {
    await page.route("**/api/sessions**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname, query: url.searchParams.toString() });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
    });

    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({
        method: request.method(),
        path: url.pathname,
        query: url.searchParams.toString(),
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

      if (url.pathname === "/api/library/graph") {
        await route.fulfill({ contentType: "application/json", body: libraryGraphEnvelope("agent.planner", "Planner Agent") });
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

test("LibraryWorkspace defaults to all domains so imported catalog agents are visible", async () => {
  const requests: Array<{ path: string; query: string }> = [];

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibrarySidebarPanel, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider defaultCwd="/workspace">
        <LibrarySidebarPanel />
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-domain-tree"]').getByRole("button", { name: "marketing", exact: true }).waitFor();
    await page.getByText("SEO Agent").waitFor();

    assert.deepEqual(requests.filter((request) => request.path !== "/api/sessions"), [
      { path: "/api/library/workspace", query: "scope=all" },
      { path: "/api/library/readiness", query: "" },
    ]);
    assert.equal(requests.some((request) => request.path === "/api/sessions" && request.query === "scope=all&kind=library&limit=50&compact=1"), true);
  }, async (page) => {
    await page.route("**/api/sessions**", async (route) => {
      const url = new URL(route.request().url());
      requests.push({ path: url.pathname, query: url.searchParams.toString() });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions: [] }) });
    });

    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ path: url.pathname, query: url.searchParams.toString() });
      if (url.pathname === "/api/library/workspace" && url.searchParams.get("scope") === "all") {
        await route.fulfill({
          contentType: "application/json",
          body: workspaceEnvelope([
            libraryObject(
              "agent.marketing-seo-specialist",
              "SEO Agent",
              "marketing/agents/marketing-seo-specialist.agent.md",
              "marketing",
              "agent_definition",
            ),
          ], "all"),
        });
        return;
      }
      await route.abort();
    });
  });
});

test("LibraryWorkspace opens object detail sidecar for graph objects without source files", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider onOpenFile={(file) => { window.__openedLibraryFile = file; }}>
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.getByRole("button", { name: "Checker agent.software-checker approved" }).click();
    await page.getByRole("button", { name: "Preview" }).click();

    assert.deepEqual(await page.evaluate(() => (window as any).__openedLibraryFile), {
      objectKey: "agent.software-checker",
      title: "Checker",
    });
    await assertText(page, '[data-testid="library-file-preview"]', "Verify implementation behavior");
    await page.getByRole("button", { name: "Edges" }).click();
    await page.locator('[data-testid="library-graph-chart"]').waitFor();
    await assertText(page, '[data-testid="library-graph-chart"]', "skill.software-verification");
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
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
                    objectKey: "agent.software-checker",
                    objectKind: "agent_definition",
                    status: "approved",
                    title: "Checker",
                    scope: "software",
                  }],
                }],
              }],
            },
          }),
        });
        return;
      }

      if (url.pathname === "/api/library/objects/agent.software-checker") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              object: {
                id: "obj-1",
                objectKey: "agent.software-checker",
                objectKind: "agent_definition",
                status: "approved",
                headVersionId: "agent.software-checker@v1",
                state: {
                  title: "Checker",
                  role: "checker",
                  runtimeRole: {
                    responsibility: "Verify implementation behavior and test outcomes.",
                  },
                },
              },
              inboundEdges: [],
              outboundEdges: [{
                fromObjectKey: "agent.software-checker",
                edgeType: "uses",
                toObjectKey: "skill.software-verification",
                scope: "software",
              }],
              usage: {
                inboundCount: 0,
                outboundCount: 1,
                usedByObjectKeys: [],
                dependsOnObjectKeys: ["skill.software-verification"],
              },
              validation: { ok: true, issues: [] },
            },
          }),
        });
        return;
      }

      await route.fulfill({ status: 404, body: `${request.method()} ${url.pathname}` });
    });
  });
});

test("LibraryWorkspace records shared ChatWindow library session activity in the sidebar", async () => {
  const requests: Array<{ method: string; path: string; body?: string; query?: string }> = [];
  let workspaceFetches = 0;

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider defaultCwd="/workspace">
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-chat-mock"] textarea').fill("create a browser verification skill");
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="library-session-row"]').filter({ hasText: "create a browser verification skill" }).waitFor();
    assert.equal(await page.locator('[data-testid="library-session-row"]').filter({ hasText: "library" }).count(), 1);
    assert.equal(workspaceFetches, 1);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({
        method: request.method(),
        path: url.pathname,
        body: request.method() === "POST" ? request.postData() ?? undefined : undefined,
        query: url.searchParams.toString(),
      });

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

      await route.abort();
    });
  });
});

test("LibraryWorkspace opens the right file viewer when a chat graph node is selected", async () => {
  const requests: Array<{ method: string; path: string }> = [];

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider defaultCwd="/workspace">
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-chat-mock"]').getByRole("button", { name: "Frontend Developer" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Frontend Developer";
    });

    assert.equal(await page.getByText("software/agents/frontend-developer.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Frontend Developer");
    assert.equal(requests.some((request) => request.method === "GET" && request.path === "/api/library/workspace"), true);
    assert.equal(requests.some((request) => request.method === "GET" && request.path === "/api/library/objects/agent.frontend-developer"), true);
    assert.equal(requests.some((request) => request.method === "GET" && request.path === "/api/library/graph"), true);
    assert.equal(requests.some((request) => request.method === "GET" && request.path === "/api/library/files/software/agents/frontend-developer.agent.md"), true);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      requests.push({ method: request.method(), path: url.pathname });

      if (url.pathname === "/api/library/workspace") {
        await route.fulfill({ contentType: "application/json", body: workspaceEnvelope([]) });
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
        await route.fulfill({
          contentType: "application/json",
          body: libraryObjectDetailEnvelope("agent.frontend-developer", "software/agents/frontend-developer.agent.md"),
        });
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
  });
});

test("LibraryWorkspace ignores stale file load results after selecting a different object", async () => {
  let releasePlanner: (() => Promise<void>) | undefined;

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider>
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').nth(0).click();
    await page.locator('[data-testid="library-object-row"]').nth(1).click();
    await page.getByRole("button", { name: "Edit" }).click();
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
  const initialContent = validAgentContent("agent.planner", "Planner Agent");
  const v2Content = validAgentContent("agent.planner", "Planner Agent v2");
  const v3Content = validAgentContent("agent.planner", "Planner Agent v3");

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider>
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value.includes("Planner Agent");
    });

    await page.locator('[data-testid="library-file-editor"]').fill(v2Content);
    await page.locator('[data-testid="library-file-save-sync"]').click();
    await page.locator('[data-testid="library-file-editor"]').fill(v3Content);

    await releaseSave?.();
    await page.waitForFunction(() => {
      const save = document.querySelector('[data-testid="library-file-save-sync"]') as HTMLButtonElement | null;
      return save?.textContent === "Save & Sync";
    });

    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), v3Content);
    assert.equal(await page.locator('[data-testid="library-file-save-sync"]').isDisabled(), false);
    assert.equal(
      requests.find((request) => request.method === "PATCH")?.body,
      JSON.stringify({ content: v2Content }),
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
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", initialContent) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "PATCH") {
        await new Promise<void>((resolve) => {
          releaseSave = async () => {
            await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", v2Content) });
            resolve();
          };
        });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md/sync" && request.method() === "POST") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: { object: { objectKey: "agent.planner" }, edges: [] } }) });
        return;
      }

      await route.abort();
    });
  });
});

test("LibraryWorkspace ignores stale save results after selecting a different object", async () => {
  let releasePlannerSave: (() => Promise<void>) | undefined;
  const plannerInitial = validAgentContent("agent.planner", "Planner Agent");
  const plannerV2 = validAgentContent("agent.planner", "Planner Agent v2");
  const builderInitial = validAgentContent("agent.builder", "Builder Agent");

  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider>
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').nth(0).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator('[data-testid="library-file-editor"]').waitFor();
    await page.locator('[data-testid="library-file-editor"]').fill(plannerV2);
    await page.locator('[data-testid="library-file-save-sync"]').click();

    await page.locator('[data-testid="library-object-row"]').nth(1).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value.includes("Builder Agent");
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
      return document.body.textContent?.includes("software/agents/builder.agent.md") && editor?.value.includes("Builder Agent");
    });

    assert.equal(await page.getByText("software/agents/builder.agent.md").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), builderInitial);
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
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", plannerInitial) });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/planner.agent.md" && request.method() === "PATCH") {
        await new Promise<void>((resolve) => {
          releasePlannerSave = async () => {
            await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/planner.agent.md", plannerV2) });
            resolve();
          };
        });
        return;
      }

      if (url.pathname === "/api/library/files/software/agents/builder.agent.md") {
        await route.fulfill({ contentType: "application/json", body: libraryFileEnvelope("software/agents/builder.agent.md", builderInitial) });
        return;
      }

      await route.abort();
    });
  });
});

test("LibraryWorkspace shows failed file loads and keeps Save & Sync disabled", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider>
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.locator('[data-testid="library-object-row"]').click();
    await assertText(page, '[data-testid="library-file-status"]', "Failed to load");
    assert.equal(await page.locator('[data-testid="library-file-save-sync"]').isDisabled(), true);
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
    import { LibraryFileSidecarPanel, LibrarySidebarPanel, LibraryWorkspace, LibraryWorkspaceProvider } from "./web/components/library/LibraryWorkspace";

    createRoot(document.getElementById("root")).render(
      <LibraryWorkspaceProvider>
        <div style={{ display: "grid", gridTemplateColumns: "260px minmax(0, 1fr) 360px", height: "100vh" }}>
          <LibrarySidebarPanel />
          <LibraryWorkspace />
          <LibraryFileSidecarPanel />
        </div>
      </LibraryWorkspaceProvider>
    );
  `, async (page) => {
    await page.getByRole("button", { name: "software", exact: true }).click();
    await page.getByRole("button", { name: "Planner agent.planner approved" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.waitForFunction(() => {
      const editor = document.querySelector('[data-testid="library-file-editor"]') as HTMLTextAreaElement | null;
      return editor?.value === "title: Planner Agent";
    });
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "title: Planner Agent");

    await page.getByRole("button", { name: "data", exact: true }).click();

    assert.equal(await page.getByText("Select a library object").count(), 1);
    assert.equal(await page.locator('[data-testid="library-file-editor"]').inputValue(), "");
    assert.equal(await page.locator('[data-testid="library-file-save-sync"]').isDisabled(), true);
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
    name: "shared-library-chat-mock",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^\.\.\/ChatWindow$/ }, (args: any) => {
        if (!args.importer.endsWith("LibraryWorkspace.tsx")) return undefined;
        return { path: "shared-library-chat-mock", namespace: "southstar-test" };
      });
      buildApi.onLoad({ filter: /.*/, namespace: "southstar-test" }, () => ({
        loader: "js",
        contents: `
          import React, { useState } from "react";
          export function ChatWindow(props) {
            const [value, setValue] = useState("");
            const submit = () => {
              if (!value.trim()) return;
              if (props.sessionKind !== "library") throw new Error("expected library sessionKind");
              if (props.libraryScope !== "all") throw new Error("expected library scope");
              props.onSessionCreated?.({
                id: "library-session-1",
                path: "",
                cwd: props.newSessionCwd,
                kind: "library",
                created: "2026-07-07T00:00:00.000Z",
                modified: "2026-07-07T00:00:01.000Z",
                messageCount: 1,
                firstMessage: value,
              });
            };
            return React.createElement(
              "div",
              { "data-testid": "library-chat-mock" },
              React.createElement("textarea", {
                value,
                onChange: (event) => setValue(event.currentTarget.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                },
              }),
              React.createElement(
                "button",
                {
                  type: "button",
                  onClick: () => props.onLibraryGraphNodeSelect?.({
                    objectKey: "agent.frontend-developer",
                    title: "Frontend Developer",
                  }),
                },
                "Frontend Developer",
              ),
            );
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
}>, selectedScope = "software"): string {
  const groupsByScope = new Map<string, typeof objects>();
  for (const object of objects) {
    const scoped = groupsByScope.get(object.scope) ?? [];
    scoped.push(object);
    groupsByScope.set(object.scope, scoped);
  }
  return JSON.stringify({
    ok: true,
    result: {
      selectedScope,
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
  const title = /title:\s*"?([^"\n]+)"?/.exec(content)?.[1] ?? content.replace(/^title:\s*/, "");
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
          title,
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

function validAgentContent(objectKey: string, title: string): string {
  return [
    "---",
    "schemaVersion: southstar.library.agent_definition_file.v1",
    `id: ${objectKey}`,
    `title: ${title}`,
    "scope: software",
    "status: approved",
    "---",
    "",
    `# ${title}`,
    "",
  ].join("\n");
}

function libraryGraphEnvelope(objectKey: string, title: string): string {
  return JSON.stringify({
    ok: true,
    result: {
      activeScope: "software",
      availableScopes: ["software"],
      nodes: [{ objectKey, objectKind: "agent_definition", status: "approved", title }],
      edges: [],
    },
  });
}

function libraryObjectDetailEnvelope(objectKey: string, sourcePath?: string): string {
  return JSON.stringify({
    ok: true,
    result: {
      object: {
        objectKey,
        objectKind: objectKey.startsWith("skill.") ? "skill_spec" : "agent_definition",
        status: "approved",
        headVersionId: `${objectKey}@v1`,
        state: { scope: "software", title: objectKey, ...(sourcePath ? { sourcePath } : {}) },
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

async function assertText(page: Page, selector: string, expected: string, shouldMatch = true): Promise<void> {
  const text = await page.locator(selector).first().textContent();
  if (shouldMatch) assert.match(text ?? "", new RegExp(expected));
  else assert.doesNotMatch(text ?? "", new RegExp(expected));
}

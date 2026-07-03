# Southstar Library Import Ontology UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Library tab so repo imports produce selectable agent/skill/MCP/tool candidates, install selected candidates into local files and Postgres, and render an ontology graph in chat while preserving the Chat/Workflow panel interaction model.

**Architecture:** Keep the web UI passive: prompts and install actions call Southstar APIs, while backend services fetch/import sources, call a configured LLM import analyzer to classify source contents, produce candidate drafts, validate selections, write local files, and persist Postgres graph truth. LLM output is advisory: deterministic validators normalize candidates and ontology edges before anything can be installed. Do not implement external search/find in this plan; only user-provided import sources such as repo links, local folders, files, paste content, and existing Library prompts are in scope.

**Tech Stack:** TypeScript, ESM, `tsx`, Postgres `southstar` schema, runtime resources, Next.js web app under `web/`, React message blocks, existing Library file parser/store, existing `library_objects` and `library_edges`.

---

## File Structure

- Modify: `src/v2/design-library/types.ts`  
  Extend ontology edge semantics for `uses`, `conflicts_with`, `workflow_precedes`, and `similar_to`, preserving existing graph consumers.
- Create: `src/v2/design-library/importers/library-source-fetcher.ts`  
  Fetch or stage GitHub/local import sources behind a narrow provider interface and return bounded source documents.
- Create: `src/v2/design-library/importers/library-llm-import-analyzer.ts`  
  Send bounded source documents to the configured LLM provider and receive candidate objects plus proposed ontology edges.
- Create: `src/v2/design-library/importers/library-candidate-extractor.ts`  
  Normalize and validate LLM output into agent/skill/MCP/tool candidates plus proposed ontology edges, with deterministic fallback for tests and offline use.
- Modify: `src/v2/design-library/importers/library-import-draft-store.ts`  
  Store candidate drafts, selected install state, install results, and graph snapshots as runtime resources.
- Modify: `src/v2/server/library-routes.ts`  
  Add repo-analysis and selected-candidate install routes while keeping current file/object routes intact.
- Modify: `src/v2/read-models/library-workspace.ts`  
  Return four fixed primitive groups and domain tree data for the sidebar.
- Modify: `src/v2/read-models/library-graph.ts`  
  Include ontology metadata and relation filters in graph DTOs.
- Modify: `web/lib/library/types.ts` and `web/lib/library/api.ts`  
  Add typed candidate, install, ontology edge, and graph APIs.
- Create: `web/components/library/LibraryCandidateMessageBlock.tsx`  
  Render selectable candidates, select-all controls, install button, and install result state inside chat.
- Modify: `web/components/library/LibraryChatWindow.tsx`  
  Render candidate and ontology graph message blocks and route install actions to the backend.
- Modify: `web/components/library/LibrarySidebar.tsx`  
  Replace current domain-first list with a domain filter field and four fixed primitive sections: Agent, Skill, MCP, Tool.
- Modify: `web/components/library/LibraryGraphBlock.tsx` and `LibraryGraphChart.tsx`  
  Render ontology relation styles and edge detail affordances.
- Test: `tests/v2/library-source-fetcher.test.ts`
- Test: `tests/v2/library-import-candidate-install.test.ts`
- Test: `tests/v2/library-ontology-edges.test.ts`
- Test: `tests/web/southstar-library-sidebar-layout.test.tsx`
- Test: `tests/web/southstar-library-chat-candidate-install.test.tsx`
- Test: `tests/web/southstar-library-ontology-graph.test.tsx`

---

## Non-Goals

- Do not implement external skill/agent/MCP search such as `find-skills`, skills.sh search, marketplace search, or broad GitHub discovery.
- Do not let the browser directly execute shell commands, clone repositories, call LLMs, or write Postgres rows.
- Do not let LLM output become approved graph truth without deterministic validation and an explicit install action.
- Do not replace the existing file parser/store; extend it so imported candidates still land as ordinary local library files.

---

## Task 1: Sidebar Contract For Four Primitive Sections

**Files:**
- Modify: `src/v2/read-models/library-workspace.ts`
- Modify: `web/lib/library/types.ts`
- Modify: `web/components/library/LibrarySidebar.tsx`
- Test: `tests/web/southstar-library-sidebar-layout.test.tsx`

- [ ] **Step 1: Write the failing sidebar layout test**

Create `tests/web/southstar-library-sidebar-layout.test.tsx`:

```ts
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

test("LibrarySidebar renders domain filter plus Agent Skill MCP Tool domain trees", async () => {
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { LibrarySidebar } from "./web/components/library/LibrarySidebar";

    const model = {
      selectedScope: "all",
      domains: [{
        scope: "software",
        counts: { agent_definition: 1, skill_spec: 1, mcp_tool_grant: 1, tool_definition: 1 },
        objectGroups: [
          { objectKind: "agent_definition", objects: [{ id: "agent.frontend", objectKey: "agent.frontend", objectKind: "agent_definition", title: "Frontend Agent", status: "approved", scope: "software", sourcePath: "agents/frontend.agent.md" }] },
          { objectKind: "skill_spec", objects: [{ id: "skill.react", objectKey: "skill.react", objectKind: "skill_spec", title: "React Skill", status: "approved", scope: "software", sourcePath: "skills/react.skill.md" }] },
          { objectKind: "mcp_tool_grant", objects: [{ id: "mcp.github", objectKey: "mcp.github", objectKind: "mcp_tool_grant", title: "GitHub MCP", status: "approved", scope: "software", sourcePath: "mcp/github.mcp.yaml" }] },
          { objectKind: "tool_definition", objects: [{ id: "tool.browser", objectKey: "tool.browser", objectKind: "tool_definition", title: "Browser Tool", status: "approved", scope: "global", sourcePath: "tools/browser.tool.yaml" }] },
        ],
      }, {
        scope: "research",
        counts: { skill_spec: 1 },
        objectGroups: [
          { objectKind: "skill_spec", objects: [{ id: "skill.lit-review", objectKey: "skill.lit-review", objectKind: "skill_spec", title: "Literature Review", status: "draft", scope: "research", sourcePath: "skills/lit-review.skill.md" }] },
        ],
      }],
    };

    function Harness() {
      const [domainFilter, setDomainFilter] = useState("");
      return (
        <LibrarySidebar
          model={model}
          selectedScope="all"
          selectedObjectKey=""
          statusFilter="all"
          domainFilter={domainFilter}
          onDomainFilterChange={setDomainFilter}
          onSelectScope={() => {}}
          onStatusFilterChange={() => {}}
          onSelectObject={(object) => { window.__selectedObjectKey = object.objectKey; }}
          prompt=""
          onPromptChange={() => {}}
          onPromptSubmit={() => {}}
        />
      );
    }

    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.locator('[data-testid="library-domain-filter"]').fill("soft");
    for (const section of ["Agent", "Skill", "MCP", "Tool"]) {
      await page.getByRole("heading", { name: section }).waitFor();
    }
    await page.getByText("Frontend Agent").waitFor();
    await page.getByText("React Skill").waitFor();
    await page.getByText("GitHub MCP").waitFor();
    await page.getByText("Browser Tool").waitFor();
    assert.equal(await page.getByText("Literature Review").count(), 0);
    await page.getByRole("button", { name: /React Skill/ }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedObjectKey), "skill.react");
  });
});

async function withBrowserHarness(entry: string, run: (page: Page) => Promise<void>): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-library-sidebar-test-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: "library-sidebar-harness.tsx", loader: "tsx" },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin()],
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const script = await readFile(outfile, "utf8");
    await page.route("http://southstar.test/", async (route) => {
      await route.fulfill({ contentType: "text/html", body: `<main id="root"></main><script>${script}</script>` });
    });
    await page.goto("http://southstar.test/");
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
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(root, "node_modules/react-dom/client.js") }));
    },
  };
}

function webAliasPlugin() {
  return {
    name: "web-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^@\// }, (args: any) => {
        const base = join(root, "web", args.path.slice(2));
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.tsx")]) {
          try {
            return { path: require.resolve(candidate) };
          } catch {}
        }
        return { path: base };
      });
    },
  };
}
```

- [ ] **Step 2: Run the sidebar test and verify it fails**

Run:

```bash
npx tsx tests/web/southstar-library-sidebar-layout.test.tsx
```

Expected: FAIL because `LibrarySidebar` does not accept `domainFilter` props and does not render the four fixed primitive sections.

- [ ] **Step 3: Extend LibrarySidebar props and primitive section grouping**

Modify `web/components/library/LibrarySidebar.tsx`:

```ts
const PRIMITIVE_SECTIONS = [
  { label: "Agent", kinds: ["agent_definition", "agent_spec"] },
  { label: "Skill", kinds: ["skill_spec", "skill_definition"] },
  { label: "MCP", kinds: ["mcp_tool_grant"] },
  { label: "Tool", kinds: ["tool_definition"] },
] as const;
```

Add props:

```ts
domainFilter: string;
onDomainFilterChange: (value: string) => void;
```

Render `data-testid="library-domain-filter"` above the status filter. Replace the current `domains.map(... objectGroups ...)` body with four `section` blocks. Each block renders matching domains whose `scope` includes `domainFilter`, then renders objects from matching object kinds under that domain. Keep the existing quick prompt and status filter.

- [ ] **Step 4: Wire LibraryWorkspace state**

Modify `web/components/library/LibraryWorkspace.tsx`:

```ts
const [domainFilter, setDomainFilter] = useState("");
```

Pass:

```tsx
domainFilter={domainFilter}
onDomainFilterChange={setDomainFilter}
```

- [ ] **Step 5: Run the sidebar test and existing workspace interaction tests**

Run:

```bash
npx tsx tests/web/southstar-library-sidebar-layout.test.tsx
npx tsx tests/web/southstar-library-workspace-interaction.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/components/library/LibrarySidebar.tsx web/components/library/LibraryWorkspace.tsx tests/web/southstar-library-sidebar-layout.test.tsx
git commit -m "feat: align library sidebar with primitive domain trees"
```

---

## Task 2: Repo Link Analysis And Candidate Drafts

**Files:**
- Create: `src/v2/design-library/importers/library-source-fetcher.ts`
- Create: `src/v2/design-library/importers/library-llm-import-analyzer.ts`
- Create: `src/v2/design-library/importers/library-candidate-extractor.ts`
- Modify: `src/v2/design-library/importers/library-import-extractor.ts`
- Modify: `src/v2/design-library/importers/library-import-draft-store.ts`
- Modify: `src/v2/server/runtime-context.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/v2/library-source-fetcher.test.ts`
- Test: `tests/v2/library-import-candidate-install.test.ts`

- [ ] **Step 1: Write failing source fetcher tests**

Create `tests/v2/library-source-fetcher.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  fetchLibraryImportSourceDocuments,
  type LibraryImportSourceFetcher,
} from "../../src/v2/design-library/importers/library-source-fetcher.ts";

test("fetchLibraryImportSourceDocuments accepts injected GitHub source fetcher and bounds documents", async () => {
  const fetcher: LibraryImportSourceFetcher = async (source) => {
    assert.equal(source.kind, "github");
    return [
      { relativePath: "agents/frontend.md", content: "# Frontend Agent\nUses React UI." },
      { relativePath: "skills/react-ui.md", content: "# React UI\nRequires browser tool." },
    ];
  };

  const docs = await fetchLibraryImportSourceDocuments({
    source: { kind: "github", repoUrl: "https://github.com/example/agents" },
    fetcher,
    maxFiles: 10,
    maxBytes: 10000,
  });

  assert.deepEqual(docs.map((doc) => doc.relativePath), ["agents/frontend.md", "skills/react-ui.md"]);
});

test("fetchLibraryImportSourceDocuments reads local folders and rejects path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-local-source-"));
  try {
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(join(root, "skills/react-ui.md"), "# React UI", "utf8");

    const docs = await fetchLibraryImportSourceDocuments({
      source: { kind: "local", absolutePath: root },
      maxFiles: 10,
      maxBytes: 10000,
    });

    assert.deepEqual(docs, [{ relativePath: "skills/react-ui.md", content: "# React UI" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the source fetcher test and verify it fails**

Run:

```bash
npx tsx tests/v2/library-source-fetcher.test.ts
```

Expected: FAIL because `library-source-fetcher.ts` does not exist.

- [ ] **Step 3: Implement bounded source document fetcher**

Create `src/v2/design-library/importers/library-source-fetcher.ts`:

```ts
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { LibraryImportSource } from "./library-import-extractor.ts";

export type LibrarySourceDocument = {
  relativePath: string;
  content: string;
};

export type LibraryImportSourceFetcher = (source: Extract<LibraryImportSource, { kind: "github" }>) => Promise<LibrarySourceDocument[]>;

export async function fetchLibraryImportSourceDocuments(input: {
  source: LibraryImportSource;
  fetcher?: LibraryImportSourceFetcher;
  maxFiles: number;
  maxBytes: number;
}): Promise<LibrarySourceDocument[]> {
  if (input.source.kind === "paste") {
    return [{ relativePath: input.source.label.replace(/[^a-z0-9._/-]+/gi, "-") || "pasted-library.md", content: input.source.content }];
  }
  if (input.source.kind === "github") {
    if (!input.fetcher) throw new Error("github import requires a configured source fetcher");
    return boundDocuments(await input.fetcher(input.source), input);
  }
  return boundDocuments(await readLocalDocuments(input.source.absolutePath), input);
}

async function readLocalDocuments(rootPath: string): Promise<LibrarySourceDocument[]> {
  const root = resolve(rootPath);
  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) {
    return [{ relativePath: root.split(sep).pop() || "source.md", content: await readFile(root, "utf8") }];
  }
  const docs: LibrarySourceDocument[] = [];
  await walk(root, root, docs);
  return docs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function walk(root: string, dir: string, docs: LibrarySourceDocument[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = resolve(dir, entry.name);
    if (!absolutePath.startsWith(`${root}${sep}`) && absolutePath !== root) throw new Error("local import path escaped root");
    if (entry.isDirectory()) {
      await walk(root, absolutePath, docs);
      continue;
    }
    if (!entry.isFile() || !/\.(md|mdx|ya?ml|json)$/i.test(entry.name)) continue;
    docs.push({
      relativePath: relative(root, absolutePath).split(sep).join("/"),
      content: await readFile(absolutePath, "utf8"),
    });
  }
}

function boundDocuments(docs: LibrarySourceDocument[], input: { maxFiles: number; maxBytes: number }): LibrarySourceDocument[] {
  if (docs.length > input.maxFiles) throw new Error(`library import source has too many files: ${docs.length}`);
  const bytes = docs.reduce((total, doc) => total + Buffer.byteLength(doc.content, "utf8"), 0);
  if (bytes > input.maxBytes) throw new Error(`library import source is too large: ${bytes}`);
  return docs.map((doc) => ({
    relativePath: doc.relativePath.replace(/^\/+/, ""),
    content: doc.content,
  }));
}
```

- [ ] **Step 4: Write failing candidate extractor test**

Add to `tests/v2/library-import-candidate-install.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { extractLibraryCandidatesFromDocuments } from "../../src/v2/design-library/importers/library-candidate-extractor.ts";

test("extractLibraryCandidatesFromDocuments returns selectable agent skill mcp and tool candidates", async () => {
  const draft = await extractLibraryCandidatesFromDocuments({
    scope: "software",
    documents: [
      { relativePath: "agents/frontend.md", content: "# Frontend Developer Agent\nUses React UI and browser." },
      { relativePath: "skills/react-ui.md", content: "# React UI Skill\nRequires tool.browser and mcp.filesystem-workspace." },
      { relativePath: "mcp/filesystem.md", content: "# Filesystem Workspace MCP" },
      { relativePath: "tools/browser.md", content: "# Browser Tool" },
    ],
  });

  assert.deepEqual(draft.candidates.map((candidate) => candidate.kind), ["agent", "skill", "mcp", "tool"]);
  assert.equal(draft.candidates.every((candidate) => candidate.selectedByDefault), true);
  assert.deepEqual(draft.proposedEdges.map((edge) => edge.edgeType).sort(), ["requires", "requires", "uses"]);
});
```

- [ ] **Step 5: Run the candidate extractor test and verify it fails**

Run:

```bash
npx tsx tests/v2/library-import-candidate-install.test.ts
```

Expected: FAIL because `library-candidate-extractor.ts` does not exist.

- [ ] **Step 6: Implement deterministic candidate extractor for first slice**

Create `src/v2/design-library/importers/library-candidate-extractor.ts`:

```ts
import { createHash } from "node:crypto";
import type { LibrarySourceDocument } from "./library-source-fetcher.ts";

export type LibraryImportCandidateKind = "agent" | "skill" | "mcp" | "tool";

export type LibraryImportCandidate = {
  candidateId: string;
  kind: LibraryImportCandidateKind;
  objectKey: string;
  title: string;
  scope: string;
  sourcePath: string;
  content: string;
  selectedByDefault: boolean;
  issues: Array<{ severity: "info" | "warning" | "error"; message: string }>;
};

export type LibraryOntologyEdgeCandidate = {
  edgeId: string;
  fromCandidateId: string;
  toCandidateId: string;
  edgeType: "uses" | "requires" | "conflicts_with" | "workflow_precedes" | "similar_to";
  confidence: number;
  rationale: string;
  selectedByDefault: boolean;
};

export type LibraryImportCandidateDraft = {
  candidates: LibraryImportCandidate[];
  proposedEdges: LibraryOntologyEdgeCandidate[];
};

export async function extractLibraryCandidatesFromDocuments(input: {
  scope: string;
  documents: LibrarySourceDocument[];
}): Promise<LibraryImportCandidateDraft> {
  const candidates = input.documents
    .map((document) => toCandidate(input.scope, document))
    .filter((candidate): candidate is LibraryImportCandidate => candidate !== null);
  const proposedEdges = proposeEdges(candidates);
  return { candidates, proposedEdges };
}

function toCandidate(scope: string, document: LibrarySourceDocument): LibraryImportCandidate | null {
  const path = document.relativePath.toLowerCase();
  const title = titleFromContent(document.content, document.relativePath);
  const kind = path.includes("agent") ? "agent" : path.includes("skill") ? "skill" : path.includes("mcp") ? "mcp" : path.includes("tool") ? "tool" : null;
  if (!kind) return null;
  const prefix = kind === "agent" ? "agent" : kind === "skill" ? "skill" : kind === "mcp" ? "mcp" : "tool";
  const slug = slugify(title || document.relativePath.replace(/\.[^.]+$/, ""));
  return {
    candidateId: `candidate-${hash(`${kind}:${document.relativePath}`).slice(0, 16)}`,
    kind,
    objectKey: `${prefix}.${slug}`,
    title: title || `${kind} ${slug}`,
    scope: kind === "tool" || kind === "mcp" ? "global" : scope,
    sourcePath: document.relativePath,
    content: document.content,
    selectedByDefault: true,
    issues: [],
  };
}

function proposeEdges(candidates: LibraryImportCandidate[]): LibraryOntologyEdgeCandidate[] {
  const agent = candidates.find((candidate) => candidate.kind === "agent");
  const skill = candidates.find((candidate) => candidate.kind === "skill");
  const tool = candidates.find((candidate) => candidate.kind === "tool");
  const mcp = candidates.find((candidate) => candidate.kind === "mcp");
  return [
    ...(agent && skill ? [edge(agent, skill, "uses", "Agent candidate text references a skill candidate.")] : []),
    ...(skill && tool ? [edge(skill, tool, "requires", "Skill candidate text references a tool candidate.")] : []),
    ...(skill && mcp ? [edge(skill, mcp, "requires", "Skill candidate text references an MCP candidate.")] : []),
  ];
}

function edge(
  from: LibraryImportCandidate,
  to: LibraryImportCandidate,
  edgeType: LibraryOntologyEdgeCandidate["edgeType"],
  rationale: string,
): LibraryOntologyEdgeCandidate {
  return {
    edgeId: `edge-${hash(`${from.candidateId}:${edgeType}:${to.candidateId}`).slice(0, 20)}`,
    fromCandidateId: from.candidateId,
    toCandidateId: to.candidateId,
    edgeType,
    confidence: 0.8,
    rationale,
    selectedByDefault: true,
  };
}

function titleFromContent(content: string, fallback: string): string {
  const heading = content.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").replace(/\b(Agent|Skill|MCP|Tool)\b$/i, "").trim() : fallback;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "library-item";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 7: Run source and candidate tests**

Run:

```bash
npx tsx tests/v2/library-source-fetcher.test.ts
npx tsx tests/v2/library-import-candidate-install.test.ts
```

Expected: PASS.

- [ ] **Step 8: Write failing LLM analyzer test**

Append to `tests/v2/library-import-candidate-install.test.ts`:

```ts
import {
  analyzeLibraryImportWithLlm,
  type LibraryImportLlmProvider,
} from "../../src/v2/design-library/importers/library-llm-import-analyzer.ts";

test("analyzeLibraryImportWithLlm asks the provider to classify repo documents and propose ontology edges", async () => {
  const calls: Array<{ prompt: string }> = [];
  const provider: LibraryImportLlmProvider = async (request) => {
    calls.push({ prompt: request.prompt });
    return {
      candidates: [
        {
          kind: "agent",
          title: "Frontend Developer",
          objectKey: "agent.frontend-developer",
          scope: "software",
          sourcePath: "agents/frontend.md",
          summary: "Builds React UI features.",
        },
        {
          kind: "skill",
          title: "React UI",
          objectKey: "skill.react-ui",
          scope: "software",
          sourcePath: "skills/react-ui.md",
          summary: "Implements React components.",
        },
      ],
      edges: [
        {
          fromObjectKey: "agent.frontend-developer",
          toObjectKey: "skill.react-ui",
          edgeType: "uses",
          confidence: 0.92,
          rationale: "The agent description explicitly says it uses the React UI skill.",
        },
      ],
    };
  };

  const draft = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [
      { relativePath: "agents/frontend.md", content: "# Frontend Developer\nUses React UI." },
      { relativePath: "skills/react-ui.md", content: "# React UI\nBuilds components." },
    ],
    provider,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.prompt, /classify each useful source as agent, skill, mcp, or tool/i);
  assert.match(calls[0]!.prompt, /ontology edges/i);
  assert.deepEqual(draft.candidates.map((candidate) => candidate.objectKey), [
    "agent.frontend-developer",
    "skill.react-ui",
  ]);
  assert.equal(draft.proposedEdges[0]?.edgeType, "uses");
  assert.equal(draft.proposedEdges[0]?.confidence, 0.92);
});
```

- [ ] **Step 9: Run the LLM analyzer test and verify it fails**

Run:

```bash
npx tsx tests/v2/library-import-candidate-install.test.ts
```

Expected: FAIL because `library-llm-import-analyzer.ts` does not exist.

- [ ] **Step 10: Implement the LLM analyzer boundary**

Create `src/v2/design-library/importers/library-llm-import-analyzer.ts`:

```ts
import type {
  LibraryImportCandidateDraft,
  LibraryImportCandidateKind,
  LibraryOntologyEdgeCandidate,
} from "./library-candidate-extractor.ts";
import type { LibrarySourceDocument } from "./library-source-fetcher.ts";

export type LibraryImportLlmCandidate = {
  kind: LibraryImportCandidateKind;
  title: string;
  objectKey: string;
  scope?: string;
  sourcePath: string;
  summary?: string;
};

export type LibraryImportLlmEdge = {
  fromObjectKey: string;
  toObjectKey: string;
  edgeType: LibraryOntologyEdgeCandidate["edgeType"];
  confidence: number;
  rationale: string;
};

export type LibraryImportLlmResponse = {
  candidates: LibraryImportLlmCandidate[];
  edges: LibraryImportLlmEdge[];
};

export type LibraryImportLlmProvider = (request: {
  prompt: string;
  documents: LibrarySourceDocument[];
}) => Promise<LibraryImportLlmResponse>;

export async function analyzeLibraryImportWithLlm(input: {
  scope: string;
  documents: LibrarySourceDocument[];
  provider: LibraryImportLlmProvider;
}): Promise<LibraryImportCandidateDraft> {
  const response = await input.provider({
    documents: input.documents,
    prompt: buildLibraryImportPrompt(input.scope, input.documents),
  });
  const candidates = response.candidates.map((candidate) => ({
    candidateId: `candidate-${candidate.objectKey.replace(/[^a-z0-9._-]+/gi, "-")}`,
    kind: candidate.kind,
    objectKey: candidate.objectKey,
    title: candidate.title,
    scope: candidate.scope || input.scope,
    sourcePath: candidate.sourcePath,
    content: input.documents.find((document) => document.relativePath === candidate.sourcePath)?.content || "",
    selectedByDefault: true,
    issues: [],
  }));
  const byObjectKey = new Map(candidates.map((candidate) => [candidate.objectKey, candidate]));
  const proposedEdges = response.edges.flatMap((edge) => {
    const from = byObjectKey.get(edge.fromObjectKey);
    const to = byObjectKey.get(edge.toObjectKey);
    if (!from || !to) return [];
    return [{
      edgeId: `edge-${from.candidateId}-${edge.edgeType}-${to.candidateId}`.replace(/[^a-z0-9._-]+/gi, "-"),
      fromCandidateId: from.candidateId,
      toCandidateId: to.candidateId,
      edgeType: edge.edgeType,
      confidence: Math.max(0, Math.min(1, edge.confidence)),
      rationale: edge.rationale,
      selectedByDefault: true,
    }];
  });
  return { candidates, proposedEdges };
}

function buildLibraryImportPrompt(scope: string, documents: LibrarySourceDocument[]): string {
  return [
    "You are analyzing a user-provided Southstar library import source.",
    "Classify each useful source as agent, skill, mcp, or tool.",
    "Return candidate objects and ontology edges only for content supported by the documents.",
    "Ontology edges may be uses, requires, conflicts_with, workflow_precedes, or similar_to.",
    `Default domain scope: ${scope}`,
    "Documents:",
    ...documents.map((document) => `--- ${document.relativePath}\n${document.content.slice(0, 6000)}`),
  ].join("\n\n");
}
```

- [ ] **Step 11: Wire import draft creation to use LLM when configured**

Modify the import draft creation service in `src/v2/design-library/importers/library-import-draft-store.ts` so it uses:

```ts
const llmProvider = input.llmProvider ?? context.libraryImportLlmProvider;
const candidateDraft = llmProvider
  ? await analyzeLibraryImportWithLlm({ scope: input.scope, documents, provider: llmProvider })
  : await extractLibraryCandidatesFromDocuments({ scope: input.scope, documents });
```

Also extend `src/v2/server/runtime-context.ts`:

```ts
libraryImportLlmProvider?: LibraryImportLlmProvider;
```

Expected behavior:

```text
GitHub/local/paste source fetch happens first.
LLM sees only bounded source documents.
LLM returns candidates and proposed ontology edges.
Code validates object keys, source paths, edge endpoints, confidence range, and allowed edge types.
Install selected is still required before local files or Postgres rows are written.
```

- [ ] **Step 12: Run source, deterministic fallback, and LLM analyzer tests**

Run:

```bash
npx tsx tests/v2/library-source-fetcher.test.ts
npx tsx tests/v2/library-import-candidate-install.test.ts
```

Expected: PASS. The same route must work with an injected fake LLM provider and without a provider.

- [ ] **Step 13: Commit**

```bash
git add src/v2/design-library/importers/library-source-fetcher.ts src/v2/design-library/importers/library-llm-import-analyzer.ts src/v2/design-library/importers/library-candidate-extractor.ts src/v2/design-library/importers/library-import-draft-store.ts src/v2/server/runtime-context.ts tests/v2/library-source-fetcher.test.ts tests/v2/library-import-candidate-install.test.ts
git commit -m "feat: analyze library import sources with llm"
```

---

## Task 3: Selected Candidate Install Pipeline

**Files:**
- Modify: `src/v2/design-library/importers/library-import-draft-store.ts`
- Modify: `src/v2/design-library/files/library-file-store.ts`
- Modify: `src/v2/server/library-routes.ts`
- Modify: `web/lib/library/api.ts`
- Modify: `web/lib/library/types.ts`
- Test: `tests/v2/library-import-candidate-install.test.ts`

- [ ] **Step 1: Add failing selected install route test**

Append to `tests/v2/library-import-candidate-install.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("library import candidate install writes selected files and Postgres graph rows", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-candidate-install-"));
  try {
    const context = {
      db,
      libraryRoot,
      libraryImportSourceFetcher: async () => [
        { relativePath: "agents/frontend.md", content: "# Frontend Developer Agent\nUses React UI." },
        { relativePath: "skills/react-ui.md", content: "# React UI Skill\nRequires Browser Tool." },
        { relativePath: "tools/browser.md", content: "# Browser Tool" },
      ],
    } as any;

    const draftResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/import-drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { kind: "github", repoUrl: "https://github.com/example/agents" }, scope: "software" }),
    }));
    assert.equal(draftResponse.status, 200);
    const draft = await draftResponse.json() as any;
    const candidateIds = draft.result.candidates.map((candidate: { candidateId: string }) => candidate.candidateId);
    const edgeIds = draft.result.proposedEdges.map((edge: { edgeId: string }) => edge.edgeId);

    const installResponse = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/import-drafts/${draft.result.draftId}/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selectedCandidateIds: candidateIds, selectedEdgeIds: edgeIds, actor: "operator", reason: "manual test install" }),
    }));

    assert.equal(installResponse.status, 200);
    const installed = await installResponse.json() as any;
    assert.equal(installed.kind, "library-import-candidate-install");
    assert.equal(installed.result.installedObjects.length, 3);
    assert.equal((await findLibraryObjectByKey(db, "agent.frontend-developer"))?.objectKind, "agent_definition");
    assert.equal((await findLibraryObjectByKey(db, "skill.react-ui"))?.objectKind, "skill_spec");
    assert.match(await readFile(join(libraryRoot, "agents/frontend-developer.agent.md"), "utf8"), /Frontend Developer/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run install route test and verify it fails**

Run:

```bash
npx tsx tests/v2/library-import-candidate-install.test.ts
```

Expected: FAIL because import drafts do not return candidates and `/install` does not exist.

- [ ] **Step 3: Change import draft result to candidate draft**

Modify `src/v2/design-library/importers/library-import-draft-store.ts` types:

```ts
export type LibraryImportDraftResult = {
  draftId: string;
  status: "draft";
  scope: string;
  source: LibraryImportSource;
  candidates: LibraryImportCandidate[];
  proposedEdges: LibraryOntologyEdgeCandidate[];
};
```

Inside `createLibraryImportDraft`, call:

```ts
const documents = await fetchLibraryImportSourceDocuments({
  source,
  fetcher: input.sourceFetcher,
  maxFiles: 200,
  maxBytes: 2_000_000,
});
const draft = await extractLibraryCandidatesFromDocuments({ scope: input.scope, documents });
```

Persist `documents`, `candidates`, and `proposedEdges` in the runtime resource payload. Keep a compatibility `proposal` field only for old tests until UI migration is done.

- [ ] **Step 4: Render selected candidates to local library files**

Add to `library-import-draft-store.ts`:

```ts
export async function installLibraryImportCandidates(db: SouthstarDb, input: {
  root: string;
  draftId: string;
  selectedCandidateIds: string[];
  selectedEdgeIds: string[];
  actor: string;
  reason: string;
}): Promise<{
  draftId: string;
  status: "installed";
  installedObjects: Array<{ objectKey: string; objectKind: string; relativePath: string }>;
  installedEdges: Array<{ fromObjectKey: string; edgeType: string; toObjectKey: string }>;
  graph: Awaited<ReturnType<typeof buildLibraryGraphReadModel>>;
}> {
  // Load runtime resource, validate selected ids against stored candidates,
  // render files, sync files to graph, upsert selected ontology edges,
  // update runtime resource status to installed, and return graph snapshot.
}
```

Use deterministic paths:

```ts
agent -> agents/<slug>.agent.md
skill -> skills/<slug>.skill.md
mcp   -> mcp/<slug>.mcp.yaml
tool  -> tools/<slug>.tool.yaml
```

Render content through existing parser-compatible frontmatter:

```yaml
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.react-ui
title: React UI
scope: software
status: draft
requiresToolRefs:
  - tool.browser
```

- [ ] **Step 5: Add install route**

Modify `src/v2/server/library-routes.ts`:

```ts
const installMatch = url.pathname.match(/^\/api\/v2\/library\/import-drafts\/([^/]+)\/install$/);
if (request.method === "POST" && installMatch) {
  const body = await readJsonBody<{
    selectedCandidateIds?: unknown;
    selectedEdgeIds?: unknown;
    actor?: unknown;
    reason?: unknown;
  }>(request);
  return json("library-import-candidate-install", await installLibraryImportCandidates(context.db, {
    root: libraryRoot(context),
    draftId: decodeURIComponent(installMatch[1]!),
    selectedCandidateIds: stringArray(body.selectedCandidateIds, "selectedCandidateIds"),
    selectedEdgeIds: stringArray(body.selectedEdgeIds, "selectedEdgeIds"),
    actor: optionalString(body.actor) ?? "operator",
    reason: requiredNonBlankString(body.reason, "reason"),
  }));
}
```

Extend `RuntimeServerContext` with:

```ts
libraryImportSourceFetcher?: LibraryImportSourceFetcher;
```

Pass it into `createLibraryImportDraft`.

- [ ] **Step 6: Run install tests and existing import tests**

Run:

```bash
npx tsx tests/v2/library-import-candidate-install.test.ts
npx tsx tests/v2/library-import-drafts.test.ts
npx tsx tests/v2/library-chat-routes.test.ts
```

Expected: PASS. If old import draft tests expect `proposal`, keep the compatibility field and add new assertions for `candidates`.

- [ ] **Step 7: Commit**

```bash
git add src/v2/design-library/importers/library-import-draft-store.ts src/v2/server/library-routes.ts src/v2/server/runtime-context.ts web/lib/library/api.ts web/lib/library/types.ts tests/v2/library-import-candidate-install.test.ts
git commit -m "feat: install selected library import candidates"
```

---

## Task 4: Ontology Edge Semantics And Graph DTO

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/design-library/library-graph-store.ts`
- Modify: `src/v2/read-models/library-graph.ts`
- Modify: `src/v2/design-library/importers/library-import-draft-store.ts`
- Modify: `src/v2/design-library/importers/library-llm-import-analyzer.ts`
- Test: `tests/v2/library-ontology-edges.test.ts`

- [ ] **Step 1: Write failing ontology edge test**

Create `tests/v2/library-ontology-edges.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { buildLibraryGraphReadModel } from "../../src/v2/read-models/library-graph.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("library graph read model exposes ontology edge metadata for uses conflicts workflow order and similarity", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const [objectKey, objectKind] of [
      ["agent.frontend", "agent_definition"],
      ["skill.react", "skill_spec"],
      ["skill.legacy-react", "skill_spec"],
      ["tool.browser", "tool_definition"],
    ] as const) {
      await upsertLibraryObject(db, {
        objectKey,
        objectKind,
        status: "approved",
        state: { scope: objectKey.startsWith("tool.") ? "global" : "software", title: objectKey },
      });
    }
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend",
      edgeType: "uses",
      toObjectKey: "skill.react",
      scope: "software",
      metadata: { ontologyCategory: "usage", confidence: 0.91, rationale: "Agent uses React skill." },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react",
      edgeType: "conflicts_with",
      toObjectKey: "skill.legacy-react",
      scope: "software",
      metadata: { ontologyCategory: "conflict", confidence: 0.77, rationale: "Conflicting React generation styles." },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react",
      edgeType: "similar_to",
      toObjectKey: "skill.legacy-react",
      scope: "software",
      metadata: { ontologyCategory: "similarity", confidence: 0.66, rationale: "Both produce React UI." },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "skill.react",
      edgeType: "workflow_precedes",
      toObjectKey: "tool.browser",
      scope: "software",
      metadata: { ontologyCategory: "workflow_order", confidence: 0.8, rationale: "Implement before browser verification." },
    });

    const graph = await buildLibraryGraphReadModel(db, { scope: "software" });

    assert.deepEqual(graph.edges.map((edge) => edge.edgeType).sort(), [
      "conflicts_with",
      "similar_to",
      "uses",
      "workflow_precedes",
    ]);
    assert.equal(graph.edges.find((edge) => edge.edgeType === "uses")?.ontology?.confidence, 0.91);
    assert.equal(graph.edges.find((edge) => edge.edgeType === "conflicts_with")?.ontology?.category, "conflict");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run ontology edge test and verify it fails**

Run:

```bash
npx tsx tests/v2/library-ontology-edges.test.ts
```

Expected: FAIL because `LibraryEdgeType` does not include ontology edge types and graph DTO does not expose ontology metadata.

- [ ] **Step 3: Write failing LLM ontology validation test**

Append to `tests/v2/library-ontology-edges.test.ts`:

```ts
import { analyzeLibraryImportWithLlm } from "../../src/v2/design-library/importers/library-llm-import-analyzer.ts";

test("llm ontology generation keeps only supported edge types and valid candidate endpoints", async () => {
  const draft = await analyzeLibraryImportWithLlm({
    scope: "software",
    documents: [
      { relativePath: "agents/frontend.md", content: "# Frontend Developer\nUses React UI." },
      { relativePath: "skills/react-ui.md", content: "# React UI\nConflicts with legacy React. Run before browser QA." },
      { relativePath: "skills/legacy-react.md", content: "# Legacy React\nOld class component patterns." },
    ],
    provider: async () => ({
      candidates: [
        { kind: "agent", title: "Frontend Developer", objectKey: "agent.frontend", sourcePath: "agents/frontend.md" },
        { kind: "skill", title: "React UI", objectKey: "skill.react", sourcePath: "skills/react-ui.md" },
        { kind: "skill", title: "Legacy React", objectKey: "skill.legacy-react", sourcePath: "skills/legacy-react.md" },
      ],
      edges: [
        { fromObjectKey: "agent.frontend", toObjectKey: "skill.react", edgeType: "uses", confidence: 1.2, rationale: "Agent uses skill." },
        { fromObjectKey: "skill.react", toObjectKey: "skill.legacy-react", edgeType: "conflicts_with", confidence: 0.76, rationale: "Different React implementation styles." },
        { fromObjectKey: "skill.react", toObjectKey: "missing.node", edgeType: "similar_to", confidence: 0.5, rationale: "Invalid endpoint." },
        { fromObjectKey: "skill.react", toObjectKey: "skill.legacy-react", edgeType: "unapproved_relation" as any, confidence: 0.5, rationale: "Invalid relation." },
      ],
    }),
  });

  assert.deepEqual(draft.proposedEdges.map((edge) => edge.edgeType), ["uses", "conflicts_with"]);
  assert.equal(draft.proposedEdges[0]?.confidence, 1);
});
```

- [ ] **Step 4: Run LLM ontology validation test and verify it fails**

Run:

```bash
npx tsx tests/v2/library-ontology-edges.test.ts
```

Expected: FAIL because the LLM analyzer does not yet reject unsupported ontology edge types.

- [ ] **Step 5: Extend edge type union**

Modify `src/v2/design-library/types.ts`:

```ts
export type LibraryEdgeType =
  | "implements"
  | "provides_capability"
  | "requires_capability"
  | "supports_skill"
  | "requires_skill"
  | "allows_tool"
  | "requires_tool"
  | "uses_instruction"
  | "requires_secret_group"
  | "allows_mcp_grant"
  | "produces_artifact"
  | "consumes_artifact"
  | "validates_artifact"
  | "uses_policy"
  | "part_of_template"
  | "supersedes"
  | "blocked_by"
  | "uses"
  | "requires"
  | "conflicts_with"
  | "workflow_precedes"
  | "similar_to";
```

- [ ] **Step 6: Validate LLM ontology edge output before draft persistence**

Modify `src/v2/design-library/importers/library-llm-import-analyzer.ts`:

```ts
const ALLOWED_ONTOLOGY_EDGE_TYPES = new Set([
  "uses",
  "requires",
  "conflicts_with",
  "workflow_precedes",
  "similar_to",
]);

function isAllowedOntologyEdgeType(value: string): value is LibraryOntologyEdgeCandidate["edgeType"] {
  return ALLOWED_ONTOLOGY_EDGE_TYPES.has(value);
}
```

Filter LLM edge output before mapping:

```ts
const proposedEdges = response.edges.flatMap((edge) => {
  if (!isAllowedOntologyEdgeType(edge.edgeType)) return [];
  const from = byObjectKey.get(edge.fromObjectKey);
  const to = byObjectKey.get(edge.toObjectKey);
  if (!from || !to) return [];
  return [{
    edgeId: `edge-${from.candidateId}-${edge.edgeType}-${to.candidateId}`.replace(/[^a-z0-9._-]+/gi, "-"),
    fromCandidateId: from.candidateId,
    toCandidateId: to.candidateId,
    edgeType: edge.edgeType,
    confidence: Math.max(0, Math.min(1, edge.confidence)),
    rationale: edge.rationale,
    selectedByDefault: true,
  }];
});
```

- [ ] **Step 7: Add ontology metadata to graph DTO**

Modify `src/v2/read-models/library-graph.ts` edge type:

```ts
export type LibraryGraphEdge = {
  id: string;
  fromObjectKey: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  scope: string;
  status: LibraryEdgeRecord["status"];
  weight: number;
  ontology?: {
    category?: string;
    confidence?: number;
    rationale?: string;
    evidenceRefs?: string[];
    sourceKind?: string;
  };
};
```

In `toGraphEdge`, map `metadata`:

```ts
ontology: {
  category: stringValue(edge.metadata.ontologyCategory),
  confidence: numberValue(edge.metadata.confidence),
  rationale: stringValue(edge.metadata.rationale),
  evidenceRefs: stringArrayValue(edge.metadata.evidenceRefs),
  sourceKind: stringValue(edge.metadata.sourceKind),
}
```

Return `undefined` when all fields are absent.

- [ ] **Step 8: Run ontology and graph read-model tests**

Run:

```bash
npx tsx tests/v2/library-ontology-edges.test.ts
npx tsx tests/v2/library-graph-read-model.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/v2/design-library/types.ts src/v2/design-library/importers/library-llm-import-analyzer.ts src/v2/read-models/library-graph.ts tests/v2/library-ontology-edges.test.ts
git commit -m "feat: validate llm ontology edges in library graph"
```

---

## Task 5: Candidate Message Block And Install UX

**Files:**
- Create: `web/components/library/LibraryCandidateMessageBlock.tsx`
- Modify: `web/components/library/LibraryChatWindow.tsx`
- Modify: `web/lib/library/api.ts`
- Modify: `web/lib/library/types.ts`
- Test: `tests/web/southstar-library-chat-candidate-install.test.tsx`

- [ ] **Step 1: Write failing candidate install UI test**

Create `tests/web/southstar-library-chat-candidate-install.test.tsx`:

```ts
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

test("LibraryChatWindow renders selectable import candidates and installs selected items", async () => {
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryChatWindow } from "./web/components/library/LibraryChatWindow";

    createRoot(document.getElementById("root")).render(
      <LibraryChatWindow scope="software" pendingPrompt="" onPromptConsumed={() => {}} />
    );
  `, async (page) => {
    await page.locator('[data-testid="library-chat-input"]').fill("import https://github.com/example/agents");
    await page.locator('[data-testid="library-chat-send"]').click();
    await page.getByText("Import candidates").waitFor();
    await page.getByLabel("Agent Frontend Developer").uncheck();
    await page.getByRole("button", { name: "Install selected" }).click();

    await page.getByText("Installed 1 object").waitFor();
    const install = requests.find((request) => request.path.endsWith("/install"));
    assert.deepEqual(install?.body.selectedCandidateIds, ["candidate-skill-react"]);
  }, async (page) => {
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postDataJSON?.();
      requests.push({ method: request.method(), path: url.pathname, body });

      if (url.pathname === "/api/library/import-drafts" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              draftId: "library-import-draft-1",
              status: "draft",
              scope: "software",
              candidates: [
                { candidateId: "candidate-agent-frontend", kind: "agent", objectKey: "agent.frontend-developer", title: "Frontend Developer", selectedByDefault: true, issues: [] },
                { candidateId: "candidate-skill-react", kind: "skill", objectKey: "skill.react-ui", title: "React UI", selectedByDefault: true, issues: [] },
              ],
              proposedEdges: [
                { edgeId: "edge-1", fromCandidateId: "candidate-agent-frontend", toCandidateId: "candidate-skill-react", edgeType: "uses", confidence: 0.8, rationale: "Agent uses skill.", selectedByDefault: true },
              ],
            },
          }),
        });
        return;
      }

      if (url.pathname === "/api/library/import-drafts/library-import-draft-1/install" && request.method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            result: {
              draftId: "library-import-draft-1",
              status: "installed",
              installedObjects: [{ objectKey: "skill.react-ui" }],
              installedEdges: [],
              graph: { activeScope: "software", availableScopes: ["software"], nodes: [], edges: [] },
            },
          }),
        });
        return;
      }

      await route.abort();
    });
  });
});

async function withBrowserHarness(entry: string, run: (page: Page) => Promise<void>, beforeLoad?: (page: Page) => Promise<void>): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-library-candidates-test-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: "library-candidates-harness.tsx", loader: "tsx" },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin()],
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const script = await readFile(outfile, "utf8");
    await page.route("http://southstar.test/", async (route) => {
      await route.fulfill({ contentType: "text/html", body: `<main id="root"></main><script>${script}</script>` });
    });
    await beforeLoad?.(page);
    await page.goto("http://southstar.test/");
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
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(root, "node_modules/react-dom/client.js") }));
    },
  };
}

function webAliasPlugin() {
  return {
    name: "web-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^@\// }, (args: any) => {
        const base = join(root, "web", args.path.slice(2));
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.tsx")]) {
          try {
            return { path: require.resolve(candidate) };
          } catch {}
        }
        return { path: base };
      });
    },
  };
}
```

- [ ] **Step 2: Run candidate install UI test and verify it fails**

Run:

```bash
npx tsx tests/web/southstar-library-chat-candidate-install.test.tsx
```

Expected: FAIL because no candidate message block exists.

- [ ] **Step 3: Add web types and API helper**

Modify `web/lib/library/types.ts`:

```ts
export type LibraryImportCandidate = {
  candidateId: string;
  kind: "agent" | "skill" | "mcp" | "tool";
  objectKey: string;
  title: string;
  sourcePath?: string;
  selectedByDefault: boolean;
  issues: Array<{ severity: "info" | "warning" | "error"; message: string }>;
};

export type LibraryOntologyEdgeCandidate = {
  edgeId: string;
  fromCandidateId: string;
  toCandidateId: string;
  edgeType: "uses" | "requires" | "conflicts_with" | "workflow_precedes" | "similar_to";
  confidence: number;
  rationale: string;
  selectedByDefault: boolean;
};

export type LibraryCandidateDraftResult = {
  draftId: string;
  status: "draft";
  scope: string;
  candidates: LibraryImportCandidate[];
  proposedEdges: LibraryOntologyEdgeCandidate[];
};

export type LibraryCandidateInstallResult = {
  draftId: string;
  status: "installed";
  installedObjects: Array<{ objectKey: string }>;
  installedEdges: Array<{ fromObjectKey: string; edgeType: string; toObjectKey: string }>;
  graph?: Record<string, unknown>;
};
```

Modify `web/lib/library/api.ts`:

```ts
export async function installLibraryImportCandidates(input: {
  draftId: string;
  selectedCandidateIds: string[];
  selectedEdgeIds: string[];
  actor?: string;
  reason: string;
}): Promise<LibraryCandidateInstallResult> {
  return requestLibraryJson<LibraryCandidateInstallResult>(
    `/api/library/import-drafts/${encodeURIComponent(input.draftId)}/install`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selectedCandidateIds: input.selectedCandidateIds,
        selectedEdgeIds: input.selectedEdgeIds,
        actor: input.actor,
        reason: input.reason,
      }),
    },
  );
}
```

- [ ] **Step 4: Create candidate message block**

Create `web/components/library/LibraryCandidateMessageBlock.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import type { LibraryCandidateDraftResult, LibraryCandidateInstallResult } from "@/lib/library/types";

export function LibraryCandidateMessageBlock({
  draft,
  installing,
  installResult,
  onInstall,
}: {
  draft: LibraryCandidateDraftResult;
  installing: boolean;
  installResult?: LibraryCandidateInstallResult;
  onInstall: (input: { selectedCandidateIds: string[]; selectedEdgeIds: string[] }) => void;
}) {
  const defaultCandidateIds = useMemo(() => draft.candidates.filter((candidate) => candidate.selectedByDefault).map((candidate) => candidate.candidateId), [draft]);
  const defaultEdgeIds = useMemo(() => draft.proposedEdges.filter((edge) => edge.selectedByDefault).map((edge) => edge.edgeId), [draft]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState(defaultCandidateIds);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState(defaultEdgeIds);
  const selectedSet = new Set(selectedCandidateIds);
  const edgeSet = new Set(selectedEdgeIds);
  const allSelected = selectedCandidateIds.length === draft.candidates.length;

  return (
    <div data-testid="library-candidate-message" style={{ display: "grid", gap: 10 }}>
      <div style={{ fontWeight: 700 }}>Import candidates</div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(event) => {
            setSelectedCandidateIds(event.currentTarget.checked ? draft.candidates.map((candidate) => candidate.candidateId) : []);
          }}
        />
        Select all candidates
      </label>
      <div style={{ display: "grid", gap: 6 }}>
        {draft.candidates.map((candidate) => (
          <label key={candidate.candidateId} style={{ display: "grid", gridTemplateColumns: "auto 64px minmax(0, 1fr)", gap: 8, alignItems: "center", fontSize: 12 }}>
            <input
              aria-label={`${labelForKind(candidate.kind)} ${candidate.title}`}
              type="checkbox"
              checked={selectedSet.has(candidate.candidateId)}
              onChange={(event) => {
                setSelectedCandidateIds((current) => event.currentTarget.checked
                  ? [...current, candidate.candidateId]
                  : current.filter((id) => id !== candidate.candidateId));
              }}
            />
            <span>{labelForKind(candidate.kind)}</span>
            <span>
              <strong>{candidate.title}</strong>
              <span style={{ display: "block", color: "var(--text-muted)", overflowWrap: "anywhere" }}>{candidate.objectKey}</span>
            </span>
          </label>
        ))}
      </div>
      {draft.proposedEdges.length > 0 && (
        <div style={{ display: "grid", gap: 4, fontSize: 12 }}>
          <div style={{ fontWeight: 700 }}>Proposed ontology edges</div>
          {draft.proposedEdges.map((edge) => (
            <label key={edge.edgeId} style={{ display: "flex", gap: 8 }}>
              <input
                type="checkbox"
                checked={edgeSet.has(edge.edgeId)}
                onChange={(event) => {
                  setSelectedEdgeIds((current) => event.currentTarget.checked
                    ? [...current, edge.edgeId]
                    : current.filter((id) => id !== edge.edgeId));
                }}
              />
              <span>{edge.edgeType} / confidence {edge.confidence.toFixed(2)} / {edge.rationale}</span>
            </label>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => onInstall({ selectedCandidateIds, selectedEdgeIds })}
        disabled={installing || selectedCandidateIds.length === 0}
      >
        {installing ? "Installing..." : "Install selected"}
      </button>
      {installResult ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Installed {installResult.installedObjects.length} object{installResult.installedObjects.length === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

function labelForKind(kind: LibraryCandidateDraftResult["candidates"][number]["kind"]): string {
  if (kind === "agent") return "Agent";
  if (kind === "skill") return "Skill";
  if (kind === "mcp") return "MCP";
  return "Tool";
}
```

- [ ] **Step 5: Wire LibraryChatWindow**

Modify `web/components/library/LibraryChatWindow.tsx`:

```ts
import { installLibraryImportCandidates } from "@/lib/library/api";
import { LibraryCandidateMessageBlock } from "./LibraryCandidateMessageBlock";
```

When `createLibraryImportDraft` returns a result with `candidates`, push:

```ts
{
  event: "library.import.candidates",
  data: draft as unknown as Record<string, unknown>,
}
```

Render:

```tsx
frame.event === "library.import.candidates" ? (
  <LibraryCandidateMessageBlock
    draft={frame.data as unknown as LibraryCandidateDraftResult}
    installing={installingDraftId === frame.data.draftId}
    installResult={installResults[String(frame.data.draftId)]}
    onInstall={(selection) => void installDraft(String(frame.data.draftId), selection)}
  />
) : ...
```

After install succeeds, append:

```ts
{ event: "library.ontology.graph", data: result.graph ?? {} }
```

- [ ] **Step 6: Run UI tests**

Run:

```bash
npx tsx tests/web/southstar-library-chat-candidate-install.test.tsx
npx tsx tests/web/southstar-library-workspace-interaction.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/components/library/LibraryCandidateMessageBlock.tsx web/components/library/LibraryChatWindow.tsx web/lib/library/api.ts web/lib/library/types.ts tests/web/southstar-library-chat-candidate-install.test.tsx
git commit -m "feat: render selectable library import candidates"
```

---

## Task 6: Ontology Graph Message Rendering

**Files:**
- Modify: `web/components/library/LibraryGraphBlock.tsx`
- Modify: `web/components/library/LibraryGraphChart.tsx`
- Modify: `web/components/library/LibraryChatWindow.tsx`
- Test: `tests/web/southstar-library-ontology-graph.test.tsx`

- [ ] **Step 1: Write failing ontology graph UI test**

Create `tests/web/southstar-library-ontology-graph.test.tsx`:

```ts
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

test("LibraryGraphBlock renders ontology edge labels and exposes clickable nodes", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LibraryGraphBlock } from "./web/components/library/LibraryGraphBlock";

    createRoot(document.getElementById("root")).render(
      <LibraryGraphBlock
        defaultScope="software"
        data={{
          activeScope: "software",
          availableScopes: ["software"],
          nodes: [
            { objectKey: "agent.frontend", objectKind: "agent_definition", title: "Frontend Agent", status: "approved" },
            { objectKey: "skill.react", objectKind: "skill_spec", title: "React Skill", status: "approved" },
            { objectKey: "tool.browser", objectKind: "tool_definition", title: "Browser Tool", status: "approved" },
          ],
          edges: [
            { fromObjectKey: "agent.frontend", toObjectKey: "skill.react", edgeType: "uses", ontology: { confidence: 0.91, category: "usage" } },
            { fromObjectKey: "skill.react", toObjectKey: "tool.browser", edgeType: "requires", ontology: { confidence: 0.8, category: "requirement" } },
          ],
        }}
        onSelectNode={(node) => { window.__selectedNode = node.objectKey; }}
      />
    );
  `, async (page) => {
    await page.getByText("uses").waitFor();
    await page.getByText("requires").waitFor();
    await page.getByText("0.91").waitFor();
    await page.getByRole("button", { name: "React Skill" }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedNode), "skill.react");
  });
});

async function withBrowserHarness(entry: string, run: (page: Page) => Promise<void>): Promise<void> {
  const dir = await mkdir(join(tmpdir(), `southstar-library-ontology-graph-test-${Date.now()}-${Math.random().toString(16).slice(2)}`), { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: { contents: entry, resolveDir: root, sourcefile: "library-ontology-graph-harness.tsx", loader: "tsx" },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin()],
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const script = await readFile(outfile, "utf8");
    await page.route("http://southstar.test/", async (route) => {
      await route.fulfill({ contentType: "text/html", body: `<main id="root"></main><script>${script}</script>` });
    });
    await page.goto("http://southstar.test/");
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
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(root, "node_modules/react-dom/client.js") }));
    },
  };
}

function webAliasPlugin() {
  return {
    name: "web-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^@\// }, (args: any) => {
        const base = join(root, "web", args.path.slice(2));
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.tsx")]) {
          try {
            return { path: require.resolve(candidate) };
          } catch {}
        }
        return { path: base };
      });
    },
  };
}
```

- [ ] **Step 2: Run ontology graph UI test and verify it fails**

Run:

```bash
npx tsx tests/web/southstar-library-ontology-graph.test.tsx
```

Expected: FAIL because graph edge DTO currently drops ontology metadata and chart does not render confidence.

- [ ] **Step 3: Extend graph chart types and rendering**

Modify `web/components/library/LibraryGraphChart.tsx`:

```ts
export type LibraryGraphChartEdge = {
  fromObjectKey: string;
  toObjectKey: string;
  edgeType?: string;
  ontology?: {
    category?: string;
    confidence?: number;
    rationale?: string;
  };
};
```

Render edge text:

```tsx
<text ...>
  {edge.edgeType}{typeof edge.ontology?.confidence === "number" ? ` ${edge.ontology.confidence.toFixed(2)}` : ""}
</text>
```

Use relation-specific stroke:

```ts
function strokeForEdge(edgeType?: string): string {
  if (edgeType === "conflicts_with") return "var(--danger)";
  if (edgeType === "similar_to") return "var(--text-muted)";
  if (edgeType === "workflow_precedes") return "var(--accent)";
  return "var(--border)";
}
```

- [ ] **Step 4: Accept ontology graph events in chat**

Modify `web/components/library/LibraryChatWindow.tsx` so both events render graph:

```tsx
frame.event === "library.graph.snapshot" || frame.event === "library.ontology.graph"
```

- [ ] **Step 5: Run graph UI tests**

Run:

```bash
npx tsx tests/web/southstar-library-ontology-graph.test.tsx
npx tsx tests/web/southstar-library-graph-block.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/components/library/LibraryGraphChart.tsx web/components/library/LibraryGraphBlock.tsx web/components/library/LibraryChatWindow.tsx tests/web/southstar-library-ontology-graph.test.tsx
git commit -m "feat: render ontology graph in library chat"
```

---

## Task 7: Final Integration Verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Update docs to reflect actual implemented scope**

Update the Library section in:

- `docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md`
- `AGENTS.md`
- `README.md`

The docs must state:

```text
Library import supports user-provided repo/local/paste sources.
External marketplace search/find is not implemented.
Library import analyzes bounded repo/local/paste content through a configured backend LLM provider when available, with deterministic fallback for tests and offline use.
Library chat produces candidate message blocks from validated LLM/import analyzer output.
Install selected writes local files and syncs Postgres graph objects/ontology edges.
Ontology edges are generated as LLM proposals, validated by code, selected by the operator, and then persisted.
Left sidebar is grouped into Agent, Skill, MCP, Tool sections with domain filtering.
```

- [ ] **Step 2: Run focused verification**

Run:

```bash
npx tsx tests/v2/library-source-fetcher.test.ts
npx tsx tests/v2/library-import-candidate-install.test.ts
npx tsx tests/v2/library-ontology-edges.test.ts
npx tsx tests/web/southstar-library-sidebar-layout.test.tsx
npx tsx tests/web/southstar-library-chat-candidate-install.test.tsx
npx tsx tests/web/southstar-library-ontology-graph.test.tsx
npx tsx tests/web/southstar-library-workspace-interaction.test.tsx
npx tsx tests/web/southstar-library-graph-block.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run broad verification**

Run:

```bash
npm --prefix web run build
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
git diff --check
```

Expected:

```text
npm --prefix web run build exits 0
npm run test:v2 exits 0
git diff --check exits 0
```

The existing `app/api/sessions/[id]/export/route.ts` webpack warning may remain if it is still present before this work.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md
git commit -m "docs: document library candidate import flow"
```

---

## Self-Review

Spec coverage:

- Left sidebar four primitive sections with domain filter: Task 1.
- Center Library chat message box with selectable candidates and install selected: Task 5.
- Repo link import producing agent/skill/MCP/tool candidates: Task 2 and Task 3.
- LLM reads bounded repo/local/paste content and produces candidate drafts: Task 2.
- Install writes local files and syncs Postgres: Task 3.
- Graph node opens right file viewer remains covered by existing workspace interaction tests and Task 6.
- LLM generates ontology edge proposals for use/conflict/workflow order/similarity, then code validates and UI renders them: Task 4 and Task 6.
- External search/find explicitly excluded: Non-Goals and Task 7 docs.

Placeholder scan:

- No deferred "fill in later" placeholders are intended in this plan. Each implementation task has a concrete failing test, expected failure, implementation target, verification command, and commit command.

Type consistency:

- `LibraryImportCandidate`, `LibraryOntologyEdgeCandidate`, `LibraryCandidateDraftResult`, and `LibraryCandidateInstallResult` are introduced in backend and mirrored in web types.
- Ontology edge names are consistent across backend, graph DTO, install payload, and chart rendering: `uses`, `requires`, `conflicts_with`, `workflow_precedes`, `similar_to`.

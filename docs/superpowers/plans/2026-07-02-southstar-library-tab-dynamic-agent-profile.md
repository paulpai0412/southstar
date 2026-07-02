# Southstar Library Tab Dynamic Agent Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Library tab where operators manage local-file-backed agent, skill, tool, and MCP primitives, stream import/edit/validation work through a center chat/SSE workspace, sync validated library content into the Postgres graph, and save workflow-generated templates plus generated node profiles.

**Architecture:** Local library files are the authoring source, while Postgres `library_objects` and `library_edges` remain the runtime graph. The runtime server owns parsing, validation, import proposals, graph sync, profile composition, template save, and SSE events; the Next web app is a thin UI/proxy layer with persistent Library tab state.

**Tech Stack:** TypeScript, Node 22, Next.js 16 app router, Postgres, `tsx` tests, React components in `web/components`, runtime APIs under `src/v2/server`, graph persistence through `src/v2/design-library/library-graph-store.ts`.

---

## Scope Check

The spec spans backend graph/file APIs, import orchestration, chat/SSE, UI, dynamic profile composition, and workflow template save. This is one cohesive Library subsystem because each slice shares the same source-of-truth model and UI surface, but it must be implemented in vertical commits. Do not start with the full UI; first make the backend graph/file/read-model APIs testable, then add chat/SSE, then wire the UI, then add generated profile/template save.

---

## File Structure

Create focused files rather than growing `routes.ts` or `AppShell.tsx` further.

Runtime backend:

- Create `src/v2/design-library/files/library-file-types.ts`
  Defines file schemas, normalized file records, validation issue shape, and local library root helpers.
- Create `src/v2/design-library/files/library-file-parser.ts`
  Parses Markdown frontmatter and YAML/JSON-ish structured files into normalized library file records.
- Create `src/v2/design-library/files/library-file-store.ts`
  Lists, reads, writes, validates, and syncs local files to graph draft objects.
- Create `src/v2/design-library/importers/prompt-library-importer.ts`
  Converts Library chat prompts into deterministic import/create proposals, with a future LLM seam.
- Create `src/v2/design-library/importers/import-proposal-normalizer.ts`
  Normalizes proposed files/objects/edges and validates refs before persistence.
- Create `src/v2/design-library/profile-composer/generated-profile-validator.ts`
  Validates generated node profiles against graph primitives and policies.
- Create `src/v2/design-library/profile-composer/graph-profile-candidate-resolver.ts`
  Resolves agent/skill/tool/MCP primitive candidates for profile composition.
- Create `src/v2/design-library/templates/workflow-template-save-service.ts`
  Saves Workflow Generate DAG templates and generated profile files, then syncs draft graph rows.
- Create `src/v2/read-models/library-chat.ts`
  Reads Library chat session resources and maps SSE-capable message blocks.
- Create `src/v2/read-models/library-workspace.ts`
  Builds the Library tab read model: domains, counts, selected object/file, and active session.
- Create `src/v2/read-models/library-graph.ts`
  Builds compact graph blocks for Library chat and graph preview.
- Create `src/v2/server/library-routes.ts`
  Handles `/api/v2/library/*` JSON APIs and Library chat SSE.
- Modify `src/v2/server/routes.ts`
  Delegate to `handleLibraryRoute` early in `handleRuntimeRoute`.
- Modify `src/v2/design-library/library-graph-store.ts`
  Add list helpers for workspace/graph read models.

Web app:

- Create `web/lib/library/types.ts`
  Shared UI types for library files, objects, graph, chat blocks, and SSE events.
- Create `web/lib/library/api.ts`
  Fetch helpers and API envelope unwrap for Library routes.
- Create `web/lib/library/chat-stream.ts`
  Starts Library chat actions and parses SSE frames.
- Create `web/app/api/library/[...path]/route.ts`
  Generic JSON proxy to `/api/v2/library/*`.
- Create `web/app/api/library/chat/messages/route.ts`
  POST proxy for starting Library chat actions.
- Create `web/app/api/library/chat/events/route.ts`
  GET proxy for Library chat SSE.
- Create `web/components/library/LibraryWorkspace.tsx`
  Layout shell: left sidebar, center chat/SSE, right file viewer.
- Create `web/components/library/LibrarySidebar.tsx`
  Domain-grouped tree, filters, counts, quick prompt entry.
- Create `web/components/library/LibraryChatWindow.tsx`
  Center chat timeline with SSE status and rich blocks.
- Create `web/components/library/LibraryFileViewer.tsx`
  Right file viewer/editor for Markdown and YAML-backed library items.
- Create `web/components/library/LibraryGraphBlock.tsx`
  Message block container for Postgres graph snapshots.
- Create `web/components/library/LibraryGraphChart.tsx`
  React HTML/SVG graph chart rendered inside the graph message block.
- Create `web/components/library/LibraryValidationBlock.tsx`
  Validation result block shared by chat and file viewer.
- Modify `web/components/AppModeRail.tsx`
  Add `library` mode.
- Modify `web/components/AppShell.tsx`
  Add persistent Library mode state and render `LibraryWorkspace`.
- Modify `web/components/MessageView.tsx` and `web/lib/types.ts` only if graph blocks must also appear in the existing general chat transcript. The first implementation should render graph blocks inside `LibraryChatWindow`; extend `MessageView` only if product review requires cross-tab chat rendering.

Tests:

- Create `tests/v2/library-file-parser.test.ts`
- Create `tests/v2/library-file-store.test.ts`
- Create `tests/v2/library-graph-read-model.test.ts`
- Create `tests/v2/library-chat-routes.test.ts`
- Create `tests/v2/generated-profile-validator.test.ts`
- Create `tests/v2/workflow-template-save-service.test.ts`
- Create `tests/web/southstar-library-tab.test.tsx`
- Create `tests/web/southstar-library-chat-stream.test.tsx`

---

## Task 1: File Format Types And Parser

**Files:**
- Create: `src/v2/design-library/files/library-file-types.ts`
- Create: `src/v2/design-library/files/library-file-parser.ts`
- Test: `tests/v2/library-file-parser.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/v2/library-file-parser.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseLibraryFileContent } from "../../src/v2/design-library/files/library-file-parser.ts";

test("parses agent markdown frontmatter and body", () => {
  const parsed = parseLibraryFileContent({
    path: "library/agents/frontend-developer.agent.md",
    content: `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
capabilityRefs:
  - capability.react-ui
preferredSkillRefs:
  - skill.react-ui
allowedToolRefs:
  - tool.workspace-read
---

# Identity

Builds React interfaces.
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "agent");
  assert.equal(parsed.file.id, "agent.frontend-developer");
  assert.equal(parsed.file.scope, "software");
  assert.equal(parsed.file.body.trim(), "# Identity\n\nBuilds React interfaces.");
  assert.deepEqual(parsed.file.frontmatter.capabilityRefs, ["capability.react-ui"]);
});

test("parses tool yaml file", () => {
  const parsed = parseLibraryFileContent({
    path: "library/tools/workspace-write.tool.yaml",
    content: `schemaVersion: southstar.library.tool_definition_file.v1
id: tool.workspace-write
title: Workspace Write
scope: global
status: draft
operations:
  - edit_file
  - apply_patch
risk:
  level: medium
  approvalRequired: false
providesCapabilityRefs:
  - capability.workspace-write
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "tool");
  assert.equal(parsed.file.id, "tool.workspace-write");
  assert.deepEqual(parsed.file.frontmatter.operations, ["edit_file", "apply_patch"]);
});

test("rejects missing id with path-specific issue", () => {
  const parsed = parseLibraryFileContent({
    path: "library/skills/react-ui.skill.md",
    content: `---
schemaVersion: southstar.library.skill_spec_file.v1
title: React UI
scope: software
status: draft
---

# Instructions

Build UI.
`,
  });

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map((issue) => issue.path), ["id"]);
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run: `npx tsx tests/v2/library-file-parser.test.ts`

Expected: FAIL with a module-not-found error for `library-file-parser.ts`.

- [ ] **Step 3: Add shared file types**

Create `src/v2/design-library/files/library-file-types.ts`:

```ts
import type { LibraryDefinitionKind, LibraryDefinitionStatus, LibraryEdgeType } from "../types.ts";

export type LibraryFileKind = "agent" | "skill" | "tool" | "mcp" | "generated_profile" | "workflow_template";

export type LibraryFileStatus = Extract<LibraryDefinitionStatus, "draft" | "approved" | "deprecated" | "blocked"> | "invalid";

export type LibraryFileRecord = {
  path: string;
  kind: LibraryFileKind;
  id: string;
  title: string;
  scope: string;
  status: LibraryFileStatus;
  schemaVersion: string;
  frontmatter: Record<string, unknown>;
  body: string;
  sourceHash: string;
};

export type LibraryFileValidationIssue = {
  severity: "info" | "warning" | "error";
  path: string;
  message: string;
  code: string;
};

export type LibraryFileParseResult =
  | { ok: true; file: LibraryFileRecord; issues: LibraryFileValidationIssue[] }
  | { ok: false; issues: LibraryFileValidationIssue[] };

export type LibraryFileGraphProjection = {
  object: {
    objectKey: string;
    objectKind: LibraryDefinitionKind;
    status: LibraryDefinitionStatus;
    headVersionId: string;
    state: Record<string, unknown>;
  };
  edges: Array<{
    fromObjectKey: string;
    edgeType: LibraryEdgeType;
    toObjectKey: string;
    scope: string;
    metadata: Record<string, unknown>;
  }>;
};
```

- [ ] **Step 4: Add parser implementation**

Create `src/v2/design-library/files/library-file-parser.ts`:

```ts
import { createHash } from "node:crypto";
import type { LibraryFileKind, LibraryFileParseResult, LibraryFileRecord, LibraryFileValidationIssue } from "./library-file-types.ts";

export function parseLibraryFileContent(input: { path: string; content: string }): LibraryFileParseResult {
  const kind = kindFromPath(input.path);
  const parsed = input.path.endsWith(".md") ? parseMarkdownWithFrontmatter(input.content) : parseSimpleYaml(input.content);
  const issues: LibraryFileValidationIssue[] = [];
  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const schemaVersion = stringValue(parsed.data.schemaVersion);
  const id = stringValue(parsed.data.id);
  const title = stringValue(parsed.data.title);
  const scope = stringValue(parsed.data.scope);
  const status = stringValue(parsed.data.status);

  if (!schemaVersion) issues.push(error("schemaVersion", "schemaVersion is required", "schema_required"));
  if (!id) issues.push(error("id", "id is required", "id_required"));
  if (!title) issues.push(error("title", "title is required", "title_required"));
  if (!scope) issues.push(error("scope", "scope is required", "scope_required"));
  if (!status) issues.push(error("status", "status is required", "status_required"));

  if (issues.some((issue) => issue.severity === "error")) return { ok: false, issues };

  const file: LibraryFileRecord = {
    path: input.path,
    kind,
    id: id!,
    title: title!,
    scope: scope!,
    status: status! as LibraryFileRecord["status"],
    schemaVersion: schemaVersion!,
    frontmatter: parsed.data,
    body: parsed.body,
    sourceHash: hash(input.content),
  };
  return { ok: true, file, issues };
}

function kindFromPath(path: string): LibraryFileKind {
  if (path.endsWith(".agent.md")) return "agent";
  if (path.endsWith(".skill.md")) return "skill";
  if (path.endsWith(".tool.yaml")) return "tool";
  if (path.endsWith(".mcp.yaml")) return "mcp";
  if (path.endsWith(".profile.yaml")) return "generated_profile";
  if (path.endsWith(".workflow.yaml")) return "workflow_template";
  throw new Error(`unsupported library file path: ${path}`);
}

function parseMarkdownWithFrontmatter(content: string): { ok: true; data: Record<string, unknown>; body: string } | { ok: false; issues: LibraryFileValidationIssue[] } {
  if (!content.startsWith("---\n")) {
    return { ok: false, issues: [error("$", "markdown library file must start with YAML frontmatter", "frontmatter_required")] };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { ok: false, issues: [error("$", "frontmatter closing marker is missing", "frontmatter_unclosed")] };
  }
  const yaml = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { ok: true, data: parseSimpleYamlObject(yaml), body };
}

function parseSimpleYaml(content: string): { ok: true; data: Record<string, unknown>; body: string } | { ok: false; issues: LibraryFileValidationIssue[] } {
  return { ok: true, data: parseSimpleYamlObject(content), body: "" };
}

function parseSimpleYamlObject(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentArrayKey: string | null = null;
  let currentObjectKey: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line.startsWith("  - ") && currentArrayKey) {
      (root[currentArrayKey] as string[]).push(scalar(line.slice(4)));
      continue;
    }
    if (line.startsWith("  ") && currentObjectKey) {
      const [key, ...rest] = line.trim().split(":");
      const value = rest.join(":").trim();
      const obj = root[currentObjectKey] as Record<string, unknown>;
      obj[key!] = scalar(value);
      continue;
    }
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key) continue;
    if (value === "") {
      const nextLine = lines[lines.indexOf(rawLine) + 1] ?? "";
      if (nextLine.trimStart().startsWith("- ")) {
        root[key] = [];
        currentArrayKey = key;
        currentObjectKey = null;
      } else {
        root[key] = {};
        currentObjectKey = key;
        currentArrayKey = null;
      }
    } else {
      root[key] = scalar(value);
      currentArrayKey = null;
      currentObjectKey = null;
    }
  }
  return root;
}

function scalar(value: string): string | boolean | number {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^"(.*)"$/, "$1");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function error(path: string, message: string, code: string): LibraryFileValidationIssue {
  return { severity: "error", path, message, code };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 5: Run parser tests and verify pass**

Run: `npx tsx tests/v2/library-file-parser.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/files/library-file-types.ts src/v2/design-library/files/library-file-parser.ts tests/v2/library-file-parser.test.ts
git commit -m "feat: parse local library files"
```

---

## Task 2: File Store, Writer, And Draft Graph Sync

**Files:**
- Create: `src/v2/design-library/files/library-file-store.ts`
- Modify: `src/v2/design-library/files/library-file-types.ts`
- Test: `tests/v2/library-file-store.test.ts`

- [ ] **Step 1: Write failing file store tests**

Create `tests/v2/library-file-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { listLibraryFiles, readLibraryFile, writeLibraryFile, syncLibraryFileToGraph } from "../../src/v2/design-library/files/library-file-store.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";

test("writes, reads, lists, and syncs an agent file to draft graph rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "southstar-library-"));
  const db = await createTestPostgresDb();
  try {
    const content = `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
capabilityRefs:
  - capability.react-ui
allowedToolRefs:
  - tool.workspace-read
---

# Identity

Builds React interfaces.
`;
    const written = await writeLibraryFile({ root, relativePath: "agents/frontend-developer.agent.md", content });
    assert.equal(written.relativePath, "agents/frontend-developer.agent.md");

    const listed = await listLibraryFiles({ root });
    assert.deepEqual(listed.map((file) => file.relativePath), ["agents/frontend-developer.agent.md"]);

    const read = await readLibraryFile({ root, relativePath: "agents/frontend-developer.agent.md" });
    assert.equal(read.parsed.ok, true);

    const synced = await syncLibraryFileToGraph(db, { root, relativePath: "agents/frontend-developer.agent.md" });
    assert.equal(synced.object.objectKey, "agent.frontend-developer");

    const object = await findLibraryObjectByKey(db, "agent.frontend-developer");
    assert.equal(object?.status, "draft");
    assert.equal(object?.state.title, "Frontend Developer");

    const edges = await findLibraryEdgesFrom(db, "agent.frontend-developer", "provides_capability", { scope: "software", status: "active" });
    assert.deepEqual(edges.map((edge) => edge.toObjectKey), ["capability.react-ui"]);

    const fileText = await readFile(join(root, "agents/frontend-developer.agent.md"), "utf8");
    assert.match(fileText, /Builds React interfaces/);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run file store test and verify failure**

Run: `npx tsx tests/v2/library-file-store.test.ts`

Expected: FAIL because `library-file-store.ts` does not exist.

- [ ] **Step 3: Implement file store and sync projection**

Create `src/v2/design-library/files/library-file-store.ts`:

```ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SouthstarDb } from "../../db/postgres.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryDefinitionStatus, LibraryEdgeType } from "../types.ts";
import { parseLibraryFileContent } from "./library-file-parser.ts";
import type { LibraryFileGraphProjection, LibraryFileParseResult } from "./library-file-types.ts";

export type LibraryFileListItem = {
  relativePath: string;
};

export async function listLibraryFiles(input: { root: string }): Promise<LibraryFileListItem[]> {
  const files: string[] = [];
  await collectFiles(input.root, "", files);
  return files
    .filter((file) => /\.(agent\.md|skill\.md|tool\.yaml|mcp\.yaml|profile\.yaml|workflow\.yaml)$/.test(file))
    .sort()
    .map((relativePath) => ({ relativePath }));
}

export async function readLibraryFile(input: { root: string; relativePath: string }): Promise<{ relativePath: string; content: string; parsed: LibraryFileParseResult }> {
  const content = await readFile(join(input.root, input.relativePath), "utf8");
  return { relativePath: input.relativePath, content, parsed: parseLibraryFileContent({ path: `library/${input.relativePath}`, content }) };
}

export async function writeLibraryFile(input: { root: string; relativePath: string; content: string }): Promise<{ relativePath: string }> {
  const absolutePath = join(input.root, input.relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.content, "utf8");
  return { relativePath: input.relativePath };
}

export async function syncLibraryFileToGraph(db: SouthstarDb, input: { root: string; relativePath: string }) {
  const file = await readLibraryFile(input);
  if (!file.parsed.ok) {
    throw new Error(`library file is invalid: ${file.parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
  }
  const projection = projectFileToGraph(file.parsed.file);
  const object = await upsertLibraryObject(db, projection.object);
  const edges = [];
  for (const edge of projection.edges) {
    edges.push(await upsertLibraryEdge(db, { ...edge, status: "active", weight: 1 }));
  }
  return { object, edges };
}

function projectFileToGraph(file: NonNullable<Extract<LibraryFileParseResult, { ok: true }>["file"]>): LibraryFileGraphProjection {
  const objectKind = objectKindForFile(file.kind);
  const status = file.status === "invalid" ? "draft" : file.status as LibraryDefinitionStatus;
  const state = {
    ...file.frontmatter,
    body: file.body,
    scope: file.scope,
    title: file.title,
    sourcePath: file.path,
    sourceHash: file.sourceHash,
  };
  const headVersionId = `${file.id}@${file.sourceHash.slice(0, 12)}`;
  return {
    object: {
      objectKey: file.id,
      objectKind,
      status,
      headVersionId,
      state,
    },
    edges: edgeProjection(file),
  };
}

function objectKindForFile(kind: string): LibraryDefinitionKind {
  if (kind === "agent") return "agent_definition";
  if (kind === "skill") return "skill_spec";
  if (kind === "tool") return "tool_definition";
  if (kind === "mcp") return "mcp_tool_grant";
  if (kind === "generated_profile") return "agent_profile";
  if (kind === "workflow_template") return "workflow_template";
  throw new Error(`unsupported library file kind: ${kind}`);
}

function edgeProjection(file: NonNullable<Extract<LibraryFileParseResult, { ok: true }>["file"]>): LibraryFileGraphProjection["edges"] {
  const edges: LibraryFileGraphProjection["edges"] = [];
  addRefs(edges, file, "capabilityRefs", "provides_capability");
  addRefs(edges, file, "providesCapabilityRefs", "provides_capability");
  addRefs(edges, file, "requiresCapabilityRefs", "requires_capability");
  addRefs(edges, file, "requiresToolRefs", "requires_tool");
  addRefs(edges, file, "allowedToolRefs", "allows_tool");
  addRefs(edges, file, "requiresMcpRefs", "allows_mcp_grant");
  addRefs(edges, file, "skillRefs", "supports_skill");
  addRefs(edges, file, "instructionRefs", "uses_instruction");
  const agentRef = stringValue(file.frontmatter.agentRef);
  if (agentRef) edges.push(edge(file, "implements", agentRef));
  const profileRefs = stringArray(file.frontmatter.profileRefs);
  for (const ref of profileRefs) edges.push(edge(file, "part_of_template", ref));
  return edges;
}

function addRefs(edges: LibraryFileGraphProjection["edges"], file: NonNullable<Extract<LibraryFileParseResult, { ok: true }>["file"]>, key: string, edgeType: LibraryEdgeType): void {
  for (const ref of stringArray(file.frontmatter[key])) {
    edges.push(edge(file, edgeType, ref));
  }
}

function edge(file: NonNullable<Extract<LibraryFileParseResult, { ok: true }>["file"]>, edgeType: LibraryEdgeType, toObjectKey: string): LibraryFileGraphProjection["edges"][number] {
  return {
    fromObjectKey: file.id,
    edgeType,
    toObjectKey,
    scope: file.scope,
    metadata: { sourcePath: file.path, sourceHash: file.sourceHash },
  };
}

async function collectFiles(root: string, prefix: string, files: string[]): Promise<void> {
  const dir = join(root, prefix);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectFiles(root, relative, files);
    if (entry.isFile()) files.push(relative);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

- [ ] **Step 4: Keep MCP requirements on existing edge types**

Do not add a new `requires_mcp_grant` edge type in this task. The first pass projects `requiresMcpRefs` to the existing `"allows_mcp_grant"` edge, matching current `LibraryEdgeType`.

- [ ] **Step 5: Run tests**

Run: `npx tsx tests/v2/library-file-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/files/library-file-types.ts src/v2/design-library/files/library-file-store.ts tests/v2/library-file-store.test.ts
git commit -m "feat: sync local library files to graph drafts"
```

---

## Task 3: Graph Store List Helpers And Library Read Models

**Files:**
- Modify: `src/v2/design-library/library-graph-store.ts`
- Create: `src/v2/read-models/library-workspace.ts`
- Create: `src/v2/read-models/library-graph.ts`
- Test: `tests/v2/library-graph-read-model.test.ts`

- [ ] **Step 1: Write failing read model tests**

Create `tests/v2/library-graph-read-model.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { buildLibraryGraphReadModel } from "../../src/v2/read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../../src/v2/read-models/library-workspace.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("library workspace groups objects by scope and kind", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.frontend-developer",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.frontend-developer@v1",
      state: { scope: "software", title: "Frontend Developer" },
    });
    await upsertLibraryObject(db, {
      objectKey: "tool.browser",
      objectKind: "tool_definition",
      status: "draft",
      headVersionId: "tool.browser@v1",
      state: { scope: "global", title: "Browser" },
    });

    const model = await buildLibraryWorkspaceReadModel(db, { selectedScope: "software" });
    assert.deepEqual(model.domains.map((domain) => domain.scope), ["global", "software"]);
    assert.equal(model.domains.find((domain) => domain.scope === "software")?.counts.agent_definition, 1);
    assert.equal(model.domains.find((domain) => domain.scope === "global")?.counts.tool_definition, 1);
  } finally {
    await db.close();
  }
});

test("library graph read model returns object-edge neighborhood", async () => {
  const db = await createTestPostgresDb();
  try {
    await upsertLibraryObject(db, {
      objectKey: "agent.frontend-developer",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.frontend-developer@v1",
      state: { scope: "software", title: "Frontend Developer" },
    });
    await upsertLibraryObject(db, {
      objectKey: "capability.react-ui",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.react-ui@v1",
      state: { scope: "software", title: "React UI" },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.frontend-developer",
      edgeType: "provides_capability",
      toObjectKey: "capability.react-ui",
      scope: "software",
    });

    const graph = await buildLibraryGraphReadModel(db, { scope: "software", objectKey: "agent.frontend-developer", depth: 1 });
    assert.deepEqual(graph.nodes.map((node) => node.objectKey).sort(), ["agent.frontend-developer", "capability.react-ui"]);
    assert.equal(graph.edges[0]?.edgeType, "provides_capability");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run read model tests and verify failure**

Run: `npx tsx tests/v2/library-graph-read-model.test.ts`

Expected: FAIL because the read-model files do not exist.

- [ ] **Step 3: Add list helpers to graph store**

Modify `src/v2/design-library/library-graph-store.ts` by adding exports after `findLibraryObjectByKey`:

```ts
export async function listLibraryObjects(
  db: SouthstarDb,
  input: { scope?: string; status?: LibraryDefinitionStatus; objectKind?: LibraryDefinitionKind } = {},
): Promise<LibraryObjectSummary[]> {
  const result = await db.query<LibraryObjectRow>(
    `select id, object_key, object_kind, status, head_version_id, state_json
       from southstar.library_objects
      where ($1::text is null or status = $1)
        and ($2::text is null or object_kind = $2)
        and ($3::text is null or state_json->>'scope' = $3 or state_json->>'scope' = 'global' or state_json->'domainRefs' ? $3)
      order by coalesce(state_json->>'scope', 'global'), object_kind, object_key`,
    [input.status ?? null, input.objectKind ?? null, input.scope ?? null],
  );
  return result.rows.map(mapObject);
}

export async function listLibraryEdges(
  db: SouthstarDb,
  input: { scope?: string; status?: LibraryEdgeStatus } = {},
): Promise<LibraryEdgeRecord[]> {
  const result = await db.query<LibraryEdgeRow>(
    `select
        id, from_object_key, from_version_ref, edge_type, to_object_key, to_version_ref,
        scope, status, weight, metadata_json
       from southstar.library_edges
      where ($1::text is null or scope = $1 or scope = 'global')
        and status = $2
      order by scope, edge_type, from_object_key, to_object_key`,
    [input.scope ?? null, input.status ?? "active"],
  );
  return result.rows.map(mapEdge);
}
```

- [ ] **Step 4: Add graph read model**

Create `src/v2/read-models/library-graph.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryEdges, listLibraryObjects } from "../design-library/library-graph-store.ts";
import type { LibraryDefinitionKind } from "../design-library/types.ts";

export type LibraryGraphNode = {
  id: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: string;
  scope: string;
  title: string;
};

export type LibraryGraphEdge = {
  id: string;
  fromObjectKey: string;
  toObjectKey: string;
  edgeType: string;
  scope: string;
  status: string;
};

export type LibraryGraphReadModel = {
  nodes: LibraryGraphNode[];
  edges: LibraryGraphEdge[];
};

export async function buildLibraryGraphReadModel(
  db: SouthstarDb,
  input: { scope?: string; objectKey?: string; depth?: number } = {},
): Promise<LibraryGraphReadModel> {
  const objects = await listLibraryObjects(db, { scope: input.scope });
  const edges = await listLibraryEdges(db, { scope: input.scope });
  const selected = input.objectKey ? neighborhood(input.objectKey, input.depth ?? 1, edges) : null;
  const visibleObjects = selected ? objects.filter((object) => selected.has(object.objectKey)) : objects;
  const visibleKeys = new Set(visibleObjects.map((object) => object.objectKey));
  return {
    nodes: visibleObjects.map((object) => ({
      id: object.id,
      objectKey: object.objectKey,
      objectKind: object.objectKind,
      status: object.status,
      scope: stringValue(object.state.scope) ?? "global",
      title: stringValue(object.state.title) ?? object.objectKey,
    })),
    edges: edges
      .filter((edge) => visibleKeys.has(edge.fromObjectKey) && visibleKeys.has(edge.toObjectKey))
      .map((edge) => ({
        id: edge.id,
        fromObjectKey: edge.fromObjectKey,
        toObjectKey: edge.toObjectKey,
        edgeType: edge.edgeType,
        scope: edge.scope,
        status: edge.status,
      })),
  };
}

function neighborhood(root: string, depth: number, edges: Array<{ fromObjectKey: string; toObjectKey: string }>): Set<string> {
  const seen = new Set([root]);
  let frontier = new Set([root]);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.fromObjectKey)) next.add(edge.toObjectKey);
      if (frontier.has(edge.toObjectKey)) next.add(edge.fromObjectKey);
    }
    for (const key of next) seen.add(key);
    frontier = next;
  }
  return seen;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

- [ ] **Step 5: Add workspace read model**

Create `src/v2/read-models/library-workspace.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { listLibraryObjects } from "../design-library/library-graph-store.ts";
import type { LibraryDefinitionKind } from "../design-library/types.ts";

export type LibraryWorkspaceReadModel = {
  selectedScope: string;
  domains: Array<{
    scope: string;
    counts: Partial<Record<LibraryDefinitionKind, number>>;
    objects: Array<{
      objectKey: string;
      objectKind: LibraryDefinitionKind;
      status: string;
      title: string;
    }>;
  }>;
};

export async function buildLibraryWorkspaceReadModel(
  db: SouthstarDb,
  input: { selectedScope?: string } = {},
): Promise<LibraryWorkspaceReadModel> {
  const objects = await listLibraryObjects(db);
  const byScope = new Map<string, LibraryWorkspaceReadModel["domains"][number]>();
  for (const object of objects) {
    const scope = typeof object.state.scope === "string" ? object.state.scope : "global";
    const domain = byScope.get(scope) ?? { scope, counts: {}, objects: [] };
    domain.counts[object.objectKind] = (domain.counts[object.objectKind] ?? 0) + 1;
    domain.objects.push({
      objectKey: object.objectKey,
      objectKind: object.objectKind,
      status: object.status,
      title: typeof object.state.title === "string" ? object.state.title : object.objectKey,
    });
    byScope.set(scope, domain);
  }
  return {
    selectedScope: input.selectedScope ?? "all",
    domains: [...byScope.values()].sort((a, b) => a.scope.localeCompare(b.scope)),
  };
}
```

- [ ] **Step 6: Run read model tests**

Run: `npx tsx tests/v2/library-graph-read-model.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/v2/design-library/library-graph-store.ts src/v2/read-models/library-graph.ts src/v2/read-models/library-workspace.ts tests/v2/library-graph-read-model.test.ts
git commit -m "feat: add library graph read models"
```

---

## Task 4: Runtime Library Routes

**Files:**
- Create: `src/v2/server/library-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/library-chat-routes.test.ts`

- [ ] **Step 1: Write failing API route tests**

Create `tests/v2/library-chat-routes.test.ts` with the first route contract:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";

test("library routes expose workspace and graph envelopes", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-routes-"));
  try {
    const context = { db, libraryRoot } as any;
    const workspaceResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/workspace"));
    assert.equal(workspaceResponse.status, 200);
    const workspace = await workspaceResponse.json() as { ok: boolean; kind: string; result: unknown };
    assert.equal(workspace.ok, true);
    assert.equal(workspace.kind, "library-workspace");

    const graphResponse = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/graph?scope=software"));
    assert.equal(graphResponse.status, 200);
    const graph = await graphResponse.json() as { ok: boolean; kind: string; result: { nodes: unknown[]; edges: unknown[] } };
    assert.equal(graph.ok, true);
    assert.equal(graph.kind, "library-graph");
    assert.deepEqual(graph.result.nodes, []);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run route test and verify failure**

Run: `npx tsx tests/v2/library-chat-routes.test.ts`

Expected: FAIL because `/api/v2/library/workspace` is not routed.

- [ ] **Step 3: Add runtime context extension**

Modify `src/v2/server/runtime-context.ts` so tests and lifecycle code can pass an explicit Library root:

```ts
libraryRoot?: string;
```

Use `context.libraryRoot ?? process.env.SOUTHSTAR_LIBRARY_ROOT ?? "library"` inside route handlers. Do not hardcode `/home/...`.

- [ ] **Step 4: Create library routes**

Create `src/v2/server/library-routes.ts`:

```ts
import { buildLibraryGraphReadModel } from "../read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../read-models/library-workspace.ts";
import { listLibraryFiles, readLibraryFile, syncLibraryFileToGraph, writeLibraryFile } from "../design-library/files/library-file-store.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleLibraryRoute(context: RuntimeServerContext & { libraryRoot?: string }, request: Request, url: URL): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/v2/library/workspace") {
    return json("library-workspace", await buildLibraryWorkspaceReadModel(context.db, {
      selectedScope: url.searchParams.get("scope") ?? undefined,
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/library/graph") {
    return json("library-graph", await buildLibraryGraphReadModel(context.db, {
      scope: url.searchParams.get("scope") ?? undefined,
      objectKey: url.searchParams.get("objectKey") ?? undefined,
      depth: numberParam(url.searchParams.get("depth")),
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/v2/library/files") {
    return json("library-files", { files: await listLibraryFiles({ root: libraryRoot(context) }) });
  }
  const fileMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)$/);
  if (request.method === "GET" && fileMatch) {
    return json("library-file", await readLibraryFile({ root: libraryRoot(context), relativePath: decodeURIComponent(fileMatch[1]!) }));
  }
  if (request.method === "PATCH" && fileMatch) {
    const body = await readJsonBody<{ content?: unknown }>(request);
    const relativePath = decodeURIComponent(fileMatch[1]!);
    const content = requiredString(body.content, "content");
    await writeLibraryFile({ root: libraryRoot(context), relativePath, content });
    return json("library-file", await readLibraryFile({ root: libraryRoot(context), relativePath }));
  }
  const syncMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)\/sync$/);
  if (request.method === "POST" && syncMatch) {
    return json("library-file-sync", await syncLibraryFileToGraph(context.db, {
      root: libraryRoot(context),
      relativePath: decodeURIComponent(syncMatch[1]!),
    }));
  }
  return undefined;
}

function libraryRoot(context: { libraryRoot?: string }): string {
  return context.libraryRoot ?? process.env.SOUTHSTAR_LIBRARY_ROOT ?? "library";
}

function numberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}
```

- [ ] **Step 5: Delegate from main runtime routes**

Modify `src/v2/server/routes.ts`:

```ts
import { handleLibraryRoute } from "./library-routes.ts";
```

Inside `handleRuntimeRoute`, after `handleChatRoute` and before execution routes:

```ts
const libraryResponse = await handleLibraryRoute(context, request, url);
if (libraryResponse) return libraryResponse;
```

- [ ] **Step 6: Run route test**

Run: `npx tsx tests/v2/library-chat-routes.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/v2/server/library-routes.ts src/v2/server/routes.ts src/v2/server/runtime-context.ts tests/v2/library-chat-routes.test.ts
git commit -m "feat: expose library workspace APIs"
```

---

## Task 5: Library Chat SSE Backend

**Files:**
- Create: `src/v2/read-models/library-chat.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/v2/library-chat-routes.test.ts`

- [ ] **Step 1: Extend route test for Library chat SSE**

Append to `tests/v2/library-chat-routes.test.ts`:

```ts
test("library chat message streams deterministic import progress events", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-chat-"));
  try {
    const context = { db, libraryRoot } as any;
    const post = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/chat/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "library-chat-test", prompt: "create a browser verification skill in software", scope: "software" }),
    }));
    assert.equal(post.status, 200);
    const body = await post.json() as { result: { sessionId: string; actionId: string } };
    assert.equal(body.result.sessionId, "library-chat-test");

    const stream = await handleRuntimeRoute(context, new Request(`http://local/api/v2/library/chat/events?sessionId=library-chat-test&actionId=${body.result.actionId}`));
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const text = await stream.text();
    assert.match(text, /event: library.intent.started/);
    assert.match(text, /event: library.proposal.created/);
    assert.match(text, /event: library.command.completed/);
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx tsx tests/v2/library-chat-routes.test.ts`

Expected: FAIL because chat endpoints do not exist.

- [ ] **Step 3: Add Library chat read model**

Create `src/v2/read-models/library-chat.ts`:

```ts
export type LibraryChatBlock =
  | { type: "text"; text: string }
  | { type: "proposal"; title: string; objectKeys: string[]; filePaths: string[] }
  | { type: "graph"; title: string; scope: string; objectKeys: string[] }
  | { type: "validation"; ok: boolean; issues: Array<{ path: string; message: string }> };

export type LibraryChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  blocks: LibraryChatBlock[];
};

export type LibraryChatAction = {
  actionId: string;
  sessionId: string;
  prompt: string;
  scope: string;
};
```

- [ ] **Step 4: Add deterministic chat action and SSE helpers**

Modify `src/v2/server/library-routes.ts` by adding imports:

```ts
import { randomUUID } from "node:crypto";
```

Add route branches before `return undefined`:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/library/chat/messages") {
  const body = await readJsonBody<{ sessionId?: unknown; prompt?: unknown; scope?: unknown }>(request);
  const sessionId = optionalString(body.sessionId) ?? `library-chat-${randomUUID()}`;
  const actionId = `library-action-${randomUUID()}`;
  const prompt = requiredString(body.prompt, "prompt");
  const scope = optionalString(body.scope) ?? "software";
  await upsertRuntimeResourcePg(context.db, {
    resourceType: "library_chat_action",
    resourceKey: actionId,
    sessionId,
    scope: "library",
    status: "active",
    title: `Library action: ${prompt.slice(0, 80)}`,
    payload: { schemaVersion: "southstar.library.chat_action.v1", actionId, sessionId, prompt, selectedScope: scope },
    summary: { prompt, selectedScope: scope },
  });
  return json("library-chat-message", { sessionId, actionId, status: "accepted" });
}

if (request.method === "GET" && url.pathname === "/api/v2/library/chat/events") {
  const sessionId = requiredQuery(url, "sessionId");
  const actionId = requiredQuery(url, "actionId");
  return libraryChatEventStream({ sessionId, actionId });
}
```

Add helper functions and import `upsertRuntimeResourcePg`:

```ts
function libraryChatEventStream(input: { sessionId: string; actionId: string }): Response {
  const encoder = new TextEncoder();
  const frames = [
    sse("library.intent.started", { sessionId: input.sessionId, actionId: input.actionId, message: "Reading library command." }),
    sse("library.intent.completed", { intent: "create_or_import_library_item", confidence: 0.8 }),
    sse("library.proposal.created", { title: "Draft library proposal", objectKeys: [], filePaths: [] }),
    sse("library.validation.completed", { ok: true, issues: [] }),
    sse("library.command.completed", { actionId: input.actionId, status: "ready_for_review" }),
  ].join("");
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  }), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 5: Run tests**

Run: `npx tsx tests/v2/library-chat-routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/read-models/library-chat.ts src/v2/server/library-routes.ts tests/v2/library-chat-routes.test.ts
git commit -m "feat: stream library chat events"
```

---

## Task 6: Web Library API Proxy And SSE Parser

**Files:**
- Create: `web/lib/library/types.ts`
- Create: `web/lib/library/api.ts`
- Create: `web/lib/library/chat-stream.ts`
- Create: `web/app/api/library/[...path]/route.ts`
- Create: `web/app/api/library/chat/messages/route.ts`
- Create: `web/app/api/library/chat/events/route.ts`
- Test: `tests/web/southstar-library-chat-stream.test.tsx`

- [ ] **Step 1: Write failing web stream parser tests**

Create `tests/web/southstar-library-chat-stream.test.tsx`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

test("library chat stream parses named SSE frames", async () => {
  const { parseLibrarySseFrames } = await import("../../web/lib/library/chat-stream.ts");
  const frames = parseLibrarySseFrames([
    "event: library.intent.started\ndata: {\"message\":\"Reading\"}\n\n",
    "event: library.graph.snapshot\ndata: {\"nodes\":[{\"objectKey\":\"agent.a\"}],\"edges\":[]}\n\n",
  ].join(""));

  assert.deepEqual(frames.map((frame) => frame.event), ["library.intent.started", "library.graph.snapshot"]);
  assert.equal(frames[1]?.data.nodes[0].objectKey, "agent.a");
});
```

- [ ] **Step 2: Run web test and verify failure**

Run: `npx tsx tests/web/southstar-library-chat-stream.test.tsx`

Expected: FAIL because `web/lib/library/chat-stream.ts` does not exist.

- [ ] **Step 3: Add web types**

Create `web/lib/library/types.ts`:

```ts
export type LibrarySseEvent =
  | "library.chat.delta"
  | "library.intent.started"
  | "library.intent.completed"
  | "library.import.fetching"
  | "library.import.parsing"
  | "library.llm_extract.delta"
  | "library.proposal.created"
  | "library.graph.diff"
  | "library.validation.completed"
  | "library.file.saved"
  | "library.db.synced"
  | "library.graph.snapshot"
  | "library.command.completed"
  | "library.error";

export type LibrarySseFrame = {
  event: LibrarySseEvent | string;
  data: Record<string, any>;
};

export type LibraryWorkspaceModel = {
  selectedScope: string;
  domains: Array<{
    scope: string;
    counts: Record<string, number>;
    objects: Array<{ objectKey: string; objectKind: string; status: string; title: string }>;
  }>;
};
```

- [ ] **Step 4: Add SSE parser and action runner**

Create `web/lib/library/chat-stream.ts`:

```ts
import type { LibrarySseFrame } from "./types";

export function parseLibrarySseFrames(buffer: string): LibrarySseFrame[] {
  return buffer
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() || "message";
      const rawData = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      return { event, data: rawData ? JSON.parse(rawData) : {} };
    });
}

export async function runLibraryChatCommand(input: {
  prompt: string;
  scope: string;
  onFrame: (frame: LibrarySseFrame) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const accepted = await fetch("/api/library/chat/messages", {
    method: "POST",
    signal: input.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: input.prompt, scope: input.scope }),
  });
  if (!accepted.ok) throw new Error(await accepted.text());
  const body = await accepted.json() as { result?: { sessionId?: string; actionId?: string } };
  const sessionId = body.result?.sessionId;
  const actionId = body.result?.actionId;
  if (!sessionId || !actionId) throw new Error("library chat accepted response missing sessionId/actionId");

  const response = await fetch(`/api/library/chat/events?sessionId=${encodeURIComponent(sessionId)}&actionId=${encodeURIComponent(actionId)}`, {
    signal: input.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!response.ok) throw new Error(await response.text());
  if (!response.body) throw new Error("library chat event stream missing body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        const parts = buffer.replace(/\r\n/g, "\n").split("\n\n");
        buffer = parts.pop() ?? "";
        for (const frame of parts) {
          for (const parsed of parseLibrarySseFrames(`${frame}\n\n`)) input.onFrame(parsed);
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
```

- [ ] **Step 5: Add Next proxies**

Create `web/lib/library/api.ts`:

```ts
export function unwrapEnvelope<T>(payload: unknown): T {
  if (!payload || typeof payload !== "object") throw new Error("API response is not an object");
  const record = payload as { ok?: unknown; result?: unknown; error?: unknown };
  if (record.ok !== true) throw new Error(typeof record.error === "string" ? record.error : "API request failed");
  return record.result as T;
}
```

Create `web/app/api/library/[...path]/route.ts`:

```ts
import { NextRequest } from "next/server";
import { buildWorkflowV2Url, proxyWorkflowV2Json, workflowV2BlockedResponse, workflowV2Capabilities } from "../../../../lib/workflow/v2-api";

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(request, params);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(request, params);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(request, params);
}

async function proxy(request: NextRequest, paramsPromise: Promise<{ path: string[] }>) {
  if (!workflowV2Capabilities().v2Backend) return workflowV2BlockedResponse();
  const params = await paramsPromise;
  const pathname = `/api/v2/library/${params.path.map(encodeURIComponent).join("/")}`;
  if (request.headers.get("accept") === "text/event-stream") {
    const upstream = buildWorkflowV2Url(pathname);
    upstream.search = request.nextUrl.search;
    const response = await fetch(upstream, { headers: { accept: "text/event-stream" } });
    if (!response.body) return new Response("library stream missing body", { status: 502 });
    return new Response(response.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
  }
  return proxyWorkflowV2Json(request, pathname);
}
```

Create `web/app/api/library/chat/messages/route.ts`:

```ts
import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "../../../../lib/workflow/v2-api";

export async function POST(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/library/chat/messages");
}
```

Create `web/app/api/library/chat/events/route.ts`:

```ts
import { NextRequest } from "next/server";
import { buildWorkflowV2Url, workflowV2BlockedResponse, workflowV2Capabilities } from "../../../../lib/workflow/v2-api";

export async function GET(request: NextRequest) {
  if (!workflowV2Capabilities().v2Backend) return workflowV2BlockedResponse();
  const upstream = buildWorkflowV2Url("/api/v2/library/chat/events");
  upstream.search = request.nextUrl.search;
  const response = await fetch(upstream, { headers: { accept: "text/event-stream" } });
  if (!response.body) return new Response("library chat stream missing body", { status: 502 });
  return new Response(response.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
}
```

- [ ] **Step 6: Run web stream tests**

Run: `npx tsx tests/web/southstar-library-chat-stream.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/lib/library web/app/api/library tests/web/southstar-library-chat-stream.test.tsx
git commit -m "feat: add library web API stream client"
```

---

## Task 7: Add Library Mode To App Shell

**Files:**
- Modify: `web/components/AppModeRail.tsx`
- Modify: `web/components/AppShell.tsx`
- Create: `web/components/library/LibraryWorkspace.tsx`
- Test: `tests/web/southstar-library-tab.test.tsx`

- [ ] **Step 1: Write failing static UI test**

Create `tests/web/southstar-library-tab.test.tsx`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

test("App mode rail exposes Library mode and AppShell renders persistent library panel", () => {
  assert.match(source("web/components/AppModeRail.tsx"), /\"library\"/);
  assert.match(source("web/components/AppModeRail.tsx"), /Library/);
  const appShell = source("web/components/AppShell.tsx");
  assert.match(appShell, /LibraryWorkspace/);
  assert.match(appShell, /data-testid=\"library-mode-panel\"/);
  assert.match(appShell, /modePanelStyle\(appMode === \"library\"\)/);
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx tsx tests/web/southstar-library-tab.test.tsx`

Expected: FAIL because `library` mode is absent.

- [ ] **Step 3: Add initial Library workspace shell**

Create `web/components/library/LibraryWorkspace.tsx`:

```tsx
"use client";

export function LibraryWorkspace() {
  return (
    <div data-testid="library-workspace" style={{
      display: "grid",
      gridTemplateColumns: "260px minmax(0, 1fr) 360px",
      height: "100%",
      minHeight: 0,
      background: "var(--bg)",
      color: "var(--text)",
    }}>
      <aside data-testid="library-sidebar" style={{ borderRight: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}>
        Library
      </aside>
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden" }}>
        Library chat
      </main>
      <aside data-testid="library-file-viewer" style={{ borderLeft: "1px solid var(--border)", minWidth: 0, overflow: "auto" }}>
        File viewer
      </aside>
    </div>
  );
}
```

- [ ] **Step 4: Add Library mode**

Modify `web/components/AppModeRail.tsx`:

```ts
export type AppMode = "chat" | "workflow" | "library" | "operator";
```

Add a mode entry between Workflow and Operator:

```tsx
{
  id: "library",
  label: "Library",
  title: "Agent, skill, tool, and MCP library",
  icon: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-1.5z" />
      <path d="M8 7h6" />
      <path d="M8 11h8" />
      <path d="M8 15h5" />
    </svg>
  ),
},
```

- [ ] **Step 5: Render Library panel without unmounting other panels**

Modify `web/components/AppShell.tsx` import:

```ts
import { LibraryWorkspace } from "./library/LibraryWorkspace";
```

Add a center panel near the operator panel:

```tsx
<div data-testid="library-mode-panel" style={modePanelStyle(appMode === "library")} aria-hidden={appMode !== "library"}>
  <LibraryWorkspace />
</div>
```

Do not wrap `LibraryWorkspace` in `{appMode === "library" && ...}` because tab switches must preserve state.

- [ ] **Step 6: Run UI static test**

Run: `npx tsx tests/web/southstar-library-tab.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/components/AppModeRail.tsx web/components/AppShell.tsx web/components/library/LibraryWorkspace.tsx tests/web/southstar-library-tab.test.tsx
git commit -m "feat: add library app mode"
```

---

## Task 8: Library Sidebar, Chat Workspace, And File Viewer

**Files:**
- Modify: `web/components/library/LibraryWorkspace.tsx`
- Create: `web/components/library/LibrarySidebar.tsx`
- Create: `web/components/library/LibraryChatWindow.tsx`
- Create: `web/components/library/LibraryFileViewer.tsx`
- Create: `web/components/library/LibraryValidationBlock.tsx`
- Create: `web/components/library/LibraryGraphBlock.tsx`
- Create: `web/components/library/LibraryGraphChart.tsx`
- Test: `tests/web/southstar-library-tab.test.tsx`

- [ ] **Step 1: Extend static UI test**

Append to `tests/web/southstar-library-tab.test.tsx`:

```ts
test("Library workspace has domain sidebar, chat SSE center, and right file viewer", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");
  assert.match(workspace, /LibrarySidebar/);
  assert.match(workspace, /LibraryChatWindow/);
  assert.match(workspace, /LibraryFileViewer/);
  assert.match(source("web/components/library/LibraryChatWindow.tsx"), /runLibraryChatCommand/);
  assert.match(source("web/components/library/LibraryGraphBlock.tsx"), /LibraryGraphChart/);
  assert.match(source("web/components/library/LibraryGraphChart.tsx"), /<svg/);
  assert.match(source("web/components/library/LibraryFileViewer.tsx"), /textarea/);
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx tsx tests/web/southstar-library-tab.test.tsx`

Expected: FAIL because subcomponents do not exist.

- [ ] **Step 3: Add sidebar component**

Create `web/components/library/LibrarySidebar.tsx`:

```tsx
"use client";

import type { LibraryWorkspaceModel } from "@/lib/library/types";

export function LibrarySidebar({
  model,
  selectedScope,
  onSelectScope,
  prompt,
  onPromptChange,
  onPromptSubmit,
}: {
  model: LibraryWorkspaceModel | null;
  selectedScope: string;
  onSelectScope: (scope: string) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onPromptSubmit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Library</div>
        <textarea
          data-testid="library-quick-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.currentTarget.value)}
          placeholder="Import or create library item..."
          rows={3}
          style={{ width: "100%", resize: "vertical", fontSize: 12, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-input)", color: "var(--text)", padding: 8 }}
        />
        <button data-testid="library-quick-prompt-submit" onClick={onPromptSubmit} disabled={!prompt.trim()} style={{ marginTop: 8, width: "100%", height: 28 }}>
          Send to Library chat
        </button>
      </div>
      <div style={{ overflow: "auto", padding: 8 }}>
        {(model?.domains ?? []).map((domain) => (
          <section key={domain.scope} style={{ marginBottom: 10 }}>
            <button onClick={() => onSelectScope(domain.scope)} aria-pressed={selectedScope === domain.scope} style={{ width: "100%", textAlign: "left", fontWeight: 700 }}>
              {domain.scope}
            </button>
            {Object.entries(domain.counts).map(([kind, count]) => (
              <div key={`${domain.scope}:${kind}`} style={{ display: "flex", justifyContent: "space-between", padding: "3px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                <span>{kind}</span>
                <span>{count}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add chat window**

Create `web/components/library/LibraryChatWindow.tsx`:

```tsx
"use client";

import { useState } from "react";
import { runLibraryChatCommand } from "@/lib/library/chat-stream";
import type { LibrarySseFrame } from "@/lib/library/types";
import { LibraryGraphBlock } from "./LibraryGraphBlock";
import { LibraryValidationBlock } from "./LibraryValidationBlock";

export function LibraryChatWindow({ scope, pendingPrompt, onPromptConsumed }: { scope: string; pendingPrompt: string; onPromptConsumed: () => void }) {
  const [frames, setFrames] = useState<LibrarySseFrame[]>([]);
  const [input, setInput] = useState("");
  const prompt = pendingPrompt || input;

  async function submit() {
    const text = prompt.trim();
    if (!text) return;
    if (pendingPrompt) onPromptConsumed();
    setInput("");
    await runLibraryChatCommand({
      prompt: text,
      scope,
      onFrame: (frame) => setFrames((current) => [...current, frame]),
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div data-testid="library-chat-timeline" style={{ flex: 1, overflow: "auto", padding: 14 }}>
        {frames.map((frame, index) => (
          <div key={`${frame.event}:${index}`} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 6 }}>{frame.event}</div>
            {frame.event === "library.graph.snapshot" ? (
              <LibraryGraphBlock data={frame.data} />
            ) : frame.event === "library.validation.completed" ? (
              <LibraryValidationBlock data={frame.data} />
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 12 }}>{JSON.stringify(frame.data, null, 2)}</pre>
            )}
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", padding: 10, display: "flex", gap: 8 }}>
        <input data-testid="library-chat-input" value={input} onChange={(event) => setInput(event.currentTarget.value)} placeholder="Ask Library..." style={{ flex: 1 }} />
        <button data-testid="library-chat-send" onClick={() => void submit()} disabled={!prompt.trim()}>Send</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add React graph chart, graph block, and validation block**

Create `web/components/library/LibraryGraphChart.tsx`:

```tsx
"use client";

type GraphNode = {
  objectKey: string;
  objectKind?: string;
  title?: string;
};

type GraphEdge = {
  fromObjectKey: string;
  toObjectKey: string;
  edgeType?: string;
};

export function LibraryGraphChart({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const width = 560;
  const rowHeight = 54;
  const height = Math.max(120, nodes.length * rowHeight + 24);
  const positions = new Map(nodes.map((node, index) => [
    node.objectKey,
    {
      x: index % 2 === 0 ? 132 : 398,
      y: 32 + index * rowHeight,
    },
  ]));

  return (
    <div data-testid="library-graph-chart" style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
      <svg width={width} height={height} role="img" aria-label="Library graph chart" style={{ display: "block", background: "var(--bg-subtle)" }}>
        {edges.map((edge, index) => {
          const from = positions.get(edge.fromObjectKey);
          const to = positions.get(edge.toObjectKey);
          if (!from || !to) return null;
          const midX = (from.x + to.x) / 2;
          return (
            <g key={`${edge.fromObjectKey}:${edge.toObjectKey}:${index}`}>
              <path
                d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                fill="none"
                stroke="var(--border-strong)"
                strokeWidth="1.4"
              />
              {edge.edgeType ? (
                <text x={midX} y={(from.y + to.y) / 2 - 4} textAnchor="middle" fontSize="10" fill="var(--text-dim)">
                  {edge.edgeType}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((node) => {
          const position = positions.get(node.objectKey);
          if (!position) return null;
          return (
            <g key={node.objectKey}>
              <rect x={position.x - 92} y={position.y - 18} width="184" height="36" rx="6" fill="var(--bg)" stroke="var(--border)" />
              <text x={position.x} y={position.y - 3} textAnchor="middle" fontSize="11" fill="var(--text)" fontWeight="600">
                {node.title ?? node.objectKey}
              </text>
              <text x={position.x} y={position.y + 11} textAnchor="middle" fontSize="9" fill="var(--text-dim)">
                {node.objectKind ?? node.objectKey}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
```

Create `web/components/library/LibraryGraphBlock.tsx`:

```tsx
"use client";

import { LibraryGraphChart } from "./LibraryGraphChart";

export function LibraryGraphBlock({ data }: { data: Record<string, any> }) {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  return (
    <div data-testid="library-graph-block" style={{ display: "grid", gap: 6 }}>
      <div style={{ fontWeight: 700 }}>Graph snapshot</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{nodes.length} nodes / {edges.length} edges</div>
      <LibraryGraphChart nodes={nodes} edges={edges} />
    </div>
  );
}
```

Create `web/components/library/LibraryValidationBlock.tsx`:

```tsx
"use client";

export function LibraryValidationBlock({ data }: { data: Record<string, any> }) {
  const issues = Array.isArray(data.issues) ? data.issues : [];
  return (
    <div data-testid="library-validation-block">
      <div style={{ fontWeight: 700, color: data.ok === false ? "var(--danger)" : "var(--success)" }}>
        {data.ok === false ? "Validation failed" : "Validation passed"}
      </div>
      {issues.map((issue: any, index: number) => (
        <div key={index} style={{ fontSize: 12 }}>{issue.path}: {issue.message}</div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Add file viewer**

Create `web/components/library/LibraryFileViewer.tsx`:

```tsx
"use client";

export function LibraryFileViewer({ content, onContentChange }: { content: string; onContentChange: (value: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: 10, borderBottom: "1px solid var(--border)", fontWeight: 700, fontSize: 12 }}>File Viewer</div>
      <textarea
        data-testid="library-file-editor"
        value={content}
        onChange={(event) => onContentChange(event.currentTarget.value)}
        style={{ flex: 1, minHeight: 0, border: "none", resize: "none", padding: 12, fontFamily: "var(--font-mono)", background: "var(--bg)", color: "var(--text)" }}
      />
    </div>
  );
}
```

- [ ] **Step 7: Wire workspace**

Modify `web/components/library/LibraryWorkspace.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { unwrapEnvelope } from "@/lib/library/api";
import type { LibraryWorkspaceModel } from "@/lib/library/types";
import { LibraryChatWindow } from "./LibraryChatWindow";
import { LibraryFileViewer } from "./LibraryFileViewer";
import { LibrarySidebar } from "./LibrarySidebar";

export function LibraryWorkspace() {
  const [model, setModel] = useState<LibraryWorkspaceModel | null>(null);
  const [selectedScope, setSelectedScope] = useState("software");
  const [quickPrompt, setQuickPrompt] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [fileContent, setFileContent] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/library/workspace?scope=${encodeURIComponent(selectedScope)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setModel(unwrapEnvelope<LibraryWorkspaceModel>(payload));
      })
      .catch(() => {
        if (!cancelled) setModel({ selectedScope, domains: [] });
      });
    return () => { cancelled = true; };
  }, [selectedScope]);

  return (
    <div data-testid="library-workspace" style={{
      display: "grid",
      gridTemplateColumns: "260px minmax(0, 1fr) 360px",
      height: "100%",
      minHeight: 0,
      background: "var(--bg)",
      color: "var(--text)",
    }}>
      <aside data-testid="library-sidebar" style={{ borderRight: "1px solid var(--border)", minWidth: 0, overflow: "hidden" }}>
        <LibrarySidebar
          model={model}
          selectedScope={selectedScope}
          onSelectScope={setSelectedScope}
          prompt={quickPrompt}
          onPromptChange={setQuickPrompt}
          onPromptSubmit={() => {
            setPendingPrompt(quickPrompt);
            setQuickPrompt("");
          }}
        />
      </aside>
      <main data-testid="library-chat-workspace" style={{ minWidth: 0, overflow: "hidden" }}>
        <LibraryChatWindow scope={selectedScope} pendingPrompt={pendingPrompt} onPromptConsumed={() => setPendingPrompt("")} />
      </main>
      <aside data-testid="library-file-viewer" style={{ borderLeft: "1px solid var(--border)", minWidth: 0, overflow: "hidden" }}>
        <LibraryFileViewer content={fileContent} onContentChange={setFileContent} />
      </aside>
    </div>
  );
}
```

- [ ] **Step 8: Run UI tests**

Run: `npx tsx tests/web/southstar-library-tab.test.tsx && npx tsx tests/web/southstar-library-chat-stream.test.tsx`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/components/library tests/web/southstar-library-tab.test.tsx
git commit -m "feat: build library chat workspace UI"
```

---

## Task 9: Prompt Import Proposal And File Draft Creation

**Files:**
- Create: `src/v2/design-library/importers/prompt-library-importer.ts`
- Create: `src/v2/design-library/importers/import-proposal-normalizer.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/v2/library-chat-routes.test.ts`

- [ ] **Step 1: Extend route test for prompt-created skill draft**

Append to `tests/v2/library-chat-routes.test.ts`:

```ts
test("library prompt import creates a draft skill file for create skill prompts", async () => {
  const db = await createTestPostgresDb();
  const libraryRoot = await mkdtemp(join(tmpdir(), "southstar-library-prompt-"));
  try {
    const context = { db, libraryRoot } as any;
    const response = await handleRuntimeRoute(context, new Request("http://local/api/v2/library/import-prompts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "create a browser verification skill that uses tool.browser", scope: "software" }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json() as { result: { files: Array<{ relativePath: string }> } };
    assert.equal(payload.result.files[0]?.relativePath, "skills/browser-verification.skill.md");
  } finally {
    await db.close();
    await rm(libraryRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx tsx tests/v2/library-chat-routes.test.ts`

Expected: FAIL because `/api/v2/library/import-prompts` is not implemented.

- [ ] **Step 3: Add deterministic prompt importer**

Create `src/v2/design-library/importers/prompt-library-importer.ts`:

```ts
export type LibraryPromptImportProposal = {
  files: Array<{ relativePath: string; content: string }>;
  objectKeys: string[];
};

export function createPromptLibraryImportProposal(input: { prompt: string; scope: string }): LibraryPromptImportProposal {
  const normalized = input.prompt.toLowerCase();
  if (normalized.includes("skill")) {
    const id = normalized.includes("browser") ? "skill.browser-verification" : "skill.generated";
    const title = normalized.includes("browser") ? "Browser Verification" : "Generated Skill";
    const slug = id.replace(/^skill\./, "");
    return {
      files: [{
        relativePath: `skills/${slug}.skill.md`,
        content: `---
schemaVersion: southstar.library.skill_spec_file.v1
id: ${id}
title: ${title}
scope: ${input.scope}
status: draft
requiresCapabilityRefs:
  - capability.browser-verification
requiresToolRefs:
  - tool.browser
requiresMcpRefs: []
---

# Instructions

- Verify browser-visible behavior.
- Report visited URL, observed state, and evidence.
`,
      }],
      objectKeys: [id],
    };
  }
  throw new Error("prompt import currently supports create skill prompts in the first implementation slice");
}
```

Create `src/v2/design-library/importers/import-proposal-normalizer.ts`:

```ts
import type { LibraryPromptImportProposal } from "./prompt-library-importer.ts";

export function normalizeImportProposal(proposal: LibraryPromptImportProposal): LibraryPromptImportProposal {
  const seen = new Set<string>();
  return {
    files: proposal.files.filter((file) => {
      if (seen.has(file.relativePath)) return false;
      seen.add(file.relativePath);
      return true;
    }),
    objectKeys: [...new Set(proposal.objectKeys)].sort(),
  };
}
```

- [ ] **Step 4: Add route branch**

Modify `src/v2/server/library-routes.ts` imports:

```ts
import { createPromptLibraryImportProposal } from "../design-library/importers/prompt-library-importer.ts";
import { normalizeImportProposal } from "../design-library/importers/import-proposal-normalizer.ts";
```

Add branch:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/library/import-prompts") {
  const body = await readJsonBody<{ prompt?: unknown; scope?: unknown }>(request);
  const prompt = requiredString(body.prompt, "prompt");
  const scope = optionalString(body.scope) ?? "software";
  const proposal = normalizeImportProposal(createPromptLibraryImportProposal({ prompt, scope }));
  const files = [];
  for (const file of proposal.files) {
    files.push(await writeLibraryFile({ root: libraryRoot(context), relativePath: file.relativePath, content: file.content }));
  }
  return json("library-import-prompt", { files, objectKeys: proposal.objectKeys, status: "draft_files_written" });
}
```

- [ ] **Step 5: Run route tests**

Run: `npx tsx tests/v2/library-chat-routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/importers src/v2/server/library-routes.ts tests/v2/library-chat-routes.test.ts
git commit -m "feat: create library drafts from prompts"
```

---

## Task 10: Generated Profile Validator And Candidate Resolver

**Files:**
- Create: `src/v2/design-library/profile-composer/generated-profile-validator.ts`
- Create: `src/v2/design-library/profile-composer/graph-profile-candidate-resolver.ts`
- Test: `tests/v2/generated-profile-validator.test.ts`

- [ ] **Step 1: Write failing validator tests**

Create `tests/v2/generated-profile-validator.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { validateGeneratedNodeProfile } from "../../src/v2/design-library/profile-composer/generated-profile-validator.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("generated profile validator accepts agent skill tool MCP graph closure", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await seedPrimitive(db, "tool.workspace-write", "tool_definition");
    await seedPrimitive(db, "mcp.filesystem-workspace", "mcp_tool_grant");
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace", scope: "software" });

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      instructionRefs: [],
    });
    assert.equal(result.ok, true);
  } finally {
    await db.close();
  }
});

test("generated profile validator rejects missing required tool", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedPrimitive(db, "agent.frontend-developer", "agent_definition");
    await seedPrimitive(db, "skill.react-ui", "skill_spec");
    await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });

    const result = await validateGeneratedNodeProfile(db, {
      scope: "software",
      nodeId: "implement-ui",
      agentRef: "agent.frontend-developer",
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: [],
      mcpGrantRefs: [],
      instructionRefs: [],
    });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0]?.code, "missing_required_tool");
  } finally {
    await db.close();
  }
});

async function seedPrimitive(db: any, objectKey: string, objectKind: any) {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind,
    status: "approved",
    headVersionId: `${objectKey}@v1`,
    state: { scope: "software", title: objectKey },
  });
}
```

- [ ] **Step 2: Run validator test and verify failure**

Run: `npx tsx tests/v2/generated-profile-validator.test.ts`

Expected: FAIL because validator module does not exist.

- [ ] **Step 3: Implement generated profile validator**

Create `src/v2/design-library/profile-composer/generated-profile-validator.ts`:

```ts
import type { SouthstarDb } from "../../db/postgres.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../library-graph-store.ts";

export type GeneratedNodeProfileInput = {
  scope: string;
  nodeId: string;
  agentRef: string;
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  instructionRefs: string[];
};

export type GeneratedProfileValidationResult = {
  ok: boolean;
  issues: Array<{ code: string; path: string; message: string }>;
};

export async function validateGeneratedNodeProfile(db: SouthstarDb, input: GeneratedNodeProfileInput): Promise<GeneratedProfileValidationResult> {
  const issues: GeneratedProfileValidationResult["issues"] = [];
  await requireObject(db, input.agentRef, "agentRef", issues);
  for (const [index, skillRef] of input.skillRefs.entries()) {
    await requireObject(db, skillRef, `skillRefs.${index}`, issues);
    const requiredTools = await findLibraryEdgesFrom(db, skillRef, "requires_tool", { scope: input.scope });
    for (const edge of requiredTools) {
      if (!input.toolGrantRefs.includes(edge.toObjectKey)) {
        issues.push({ code: "missing_required_tool", path: `skillRefs.${index}`, message: `${skillRef} requires ${edge.toObjectKey}` });
      }
    }
    const requiredMcp = await findLibraryEdgesFrom(db, skillRef, "allows_mcp_grant", { scope: input.scope });
    for (const edge of requiredMcp) {
      if (!input.mcpGrantRefs.includes(edge.toObjectKey)) {
        issues.push({ code: "missing_required_mcp", path: `skillRefs.${index}`, message: `${skillRef} requires ${edge.toObjectKey}` });
      }
    }
  }
  for (const [index, toolRef] of input.toolGrantRefs.entries()) await requireObject(db, toolRef, `toolGrantRefs.${index}`, issues);
  for (const [index, mcpRef] of input.mcpGrantRefs.entries()) await requireObject(db, mcpRef, `mcpGrantRefs.${index}`, issues);
  return { ok: issues.length === 0, issues };
}

async function requireObject(db: SouthstarDb, objectKey: string, path: string, issues: GeneratedProfileValidationResult["issues"]): Promise<void> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (!object || object.status !== "approved") {
    issues.push({ code: "unknown_or_unapproved_ref", path, message: `${objectKey} is not approved` });
  }
}
```

- [ ] **Step 4: Implement candidate resolver seam**

Create `src/v2/design-library/profile-composer/graph-profile-candidate-resolver.ts`:

```ts
import type { SouthstarDb } from "../../db/postgres.ts";
import { listLibraryObjects } from "../library-graph-store.ts";

export type GraphProfileCandidates = {
  agents: string[];
  skills: string[];
  tools: string[];
  mcpGrants: string[];
};

export async function resolveGraphProfileCandidates(db: SouthstarDb, input: { scope: string }): Promise<GraphProfileCandidates> {
  const objects = await listLibraryObjects(db, { scope: input.scope, status: "approved" });
  return {
    agents: objects.filter((object) => object.objectKind === "agent_definition").map((object) => object.objectKey),
    skills: objects.filter((object) => object.objectKind === "skill_spec").map((object) => object.objectKey),
    tools: objects.filter((object) => object.objectKind === "tool_definition").map((object) => object.objectKey),
    mcpGrants: objects.filter((object) => object.objectKind === "mcp_tool_grant").map((object) => object.objectKey),
  };
}
```

- [ ] **Step 5: Run validator test**

Run: `npx tsx tests/v2/generated-profile-validator.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/profile-composer tests/v2/generated-profile-validator.test.ts
git commit -m "feat: validate generated node profiles"
```

---

## Task 11: Workflow Template Save Service

**Files:**
- Create: `src/v2/design-library/templates/workflow-template-save-service.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/v2/workflow-template-save-service.test.ts`

- [ ] **Step 1: Write failing template save test**

Create `tests/v2/workflow-template-save-service.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { saveWorkflowTemplateDraft } from "../../src/v2/design-library/templates/workflow-template-save-service.ts";
import { findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";

test("saves workflow template and generated profile files then syncs draft objects", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-template-save-"));
  try {
    const result = await saveWorkflowTemplateDraft(db, {
      root,
      scope: "software",
      templateId: "template.todo-webapp",
      title: "Todo Webapp",
      nodes: [{
        id: "implement-ui",
        title: "Implement UI",
        agentRef: "agent.frontend-developer",
        skillRefs: ["skill.react-ui"],
        toolGrantRefs: ["tool.workspace-write"],
        mcpGrantRefs: [],
      }],
      edges: [],
    });

    assert.equal(result.template.relativePath, "templates/saved/todo-webapp.workflow.yaml");
    assert.equal(result.profiles[0]?.relativePath, "profiles/generated/todo-webapp/implement-ui.profile.yaml");
    assert.match(await readFile(join(root, result.template.relativePath), "utf8"), /profile.generated.todo-webapp.implement-ui/);
    assert.equal((await findLibraryObjectByKey(db, "template.todo-webapp"))?.status, "draft");
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run template save test and verify failure**

Run: `npx tsx tests/v2/workflow-template-save-service.test.ts`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement save service**

Create `src/v2/design-library/templates/workflow-template-save-service.ts`:

```ts
import type { SouthstarDb } from "../../db/postgres.ts";
import { syncLibraryFileToGraph, writeLibraryFile } from "../files/library-file-store.ts";

export type SaveWorkflowTemplateDraftInput = {
  root: string;
  scope: string;
  templateId: string;
  title: string;
  nodes: Array<{
    id: string;
    title: string;
    agentRef: string;
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
  }>;
  edges: Array<{ from: string; to: string }>;
};

export async function saveWorkflowTemplateDraft(db: SouthstarDb, input: SaveWorkflowTemplateDraftInput) {
  const templateSlug = input.templateId.replace(/^template\./, "");
  const profiles = [];
  for (const node of input.nodes) {
    const profileId = `profile.generated.${templateSlug}.${node.id}`;
    const relativePath = `profiles/generated/${templateSlug}/${node.id}.profile.yaml`;
    await writeLibraryFile({
      root: input.root,
      relativePath,
      content: profileYaml({ ...node, profileId, scope: input.scope, templateId: input.templateId }),
    });
    profiles.push({ relativePath, sync: await syncLibraryFileToGraph(db, { root: input.root, relativePath }) });
  }

  const templatePath = `templates/saved/${templateSlug}.workflow.yaml`;
  await writeLibraryFile({
    root: input.root,
    relativePath: templatePath,
    content: templateYaml(input, templateSlug),
  });
  const template = { relativePath: templatePath, sync: await syncLibraryFileToGraph(db, { root: input.root, relativePath: templatePath }) };
  return { template, profiles };
}

function profileYaml(input: SaveWorkflowTemplateDraftInput["nodes"][number] & { profileId: string; scope: string; templateId: string }): string {
  return `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: ${input.profileId}
title: ${input.title}
scope: ${input.scope}
status: draft
agentRef: ${input.agentRef}
skillRefs:
${yamlList(input.skillRefs)}
toolGrantRefs:
${yamlList(input.toolGrantRefs)}
mcpGrantRefs:
${yamlList(input.mcpGrantRefs)}
instructionRefs: []
source:
  kind: workflow-generate-save
  templateRef: ${input.templateId}
  nodeId: ${input.id}
`;
}

function templateYaml(input: SaveWorkflowTemplateDraftInput, templateSlug: string): string {
  return `schemaVersion: southstar.library.workflow_template_file.v1
id: ${input.templateId}
title: ${input.title}
scope: ${input.scope}
status: draft
profileRefs:
${yamlList(input.nodes.map((node) => `profile.generated.${templateSlug}.${node.id}`))}
nodes:
${input.nodes.map((node) => `  - id: ${node.id}\n    title: ${node.title}\n    profileRef: profile.generated.${templateSlug}.${node.id}`).join("\n")}
edges:
${input.edges.map((edge) => `  - from: ${edge.from}\n    to: ${edge.to}`).join("\n") || "  []"}
`;
}

function yamlList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `  - ${value}`).join("\n") : "  []";
}
```

- [ ] **Step 4: Run template save test**

Run: `npx tsx tests/v2/workflow-template-save-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/v2/design-library/templates/workflow-template-save-service.ts tests/v2/workflow-template-save-service.test.ts
git commit -m "feat: save workflow templates to library drafts"
```

---

## Task 12: Workflow DAG Save Button And API Hook

**Files:**
- Modify: `web/components/WorkflowDagBlock.tsx`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/save-template/route.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

- [ ] **Step 1: Add static test for Save Template button**

Append to `tests/web/southstar-workflow-canvas-ui.test.tsx`:

```ts
test("Workflow DAG block exposes Save Template action for draft DAGs", () => {
  const sourceText = source("web/components/WorkflowDagBlock.tsx");
  assert.match(sourceText, /Save Template/);
  assert.match(sourceText, /save-template/);
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: FAIL until `WorkflowDagBlock.tsx` contains the save action.

- [ ] **Step 3: Add runtime route for draft save**

In `src/v2/server/library-routes.ts`, add a route branch:

```ts
const saveTemplateMatch = url.pathname.match(/^\/api\/v2\/workflow\/drafts\/([^/]+)\/save-template$/);
if (request.method === "POST" && saveTemplateMatch) {
  const body = await readJsonBody<any>(request);
  const draftId = decodeURIComponent(saveTemplateMatch[1]!);
  const result = await saveWorkflowTemplateDraft(context.db, {
    root: libraryRoot(context),
    scope: optionalString(body.scope) ?? "software",
    templateId: requiredString(body.templateId, "templateId"),
    title: requiredString(body.title, "title"),
    nodes: Array.isArray(body.nodes) ? body.nodes : [],
    edges: Array.isArray(body.edges) ? body.edges : [],
  });
  return json("workflow-template-save", { draftId, ...result });
}
```

Import:

```ts
import { saveWorkflowTemplateDraft } from "../design-library/templates/workflow-template-save-service.ts";
```

- [ ] **Step 4: Add web proxy route**

Create `web/app/api/workflow/planner-drafts/[draftId]/save-template/route.ts`:

```ts
import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "../../../../../lib/workflow/v2-api";

export async function POST(request: NextRequest, { params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params;
  return proxyWorkflowV2Json(request, `/api/v2/workflow/drafts/${encodeURIComponent(draftId)}/save-template`);
}
```

- [ ] **Step 5: Add Save Template button**

Modify `web/components/WorkflowDagBlock.tsx` to add a handler near lifecycle actions:

```ts
async function saveTemplate() {
  if (!state.draft?.draftId) return;
  const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/save-template`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope: "software",
      templateId: `template.${dag.id ?? state.draft.draftId}`,
      title: dag.title ?? "Saved Workflow Template",
      nodes: dag.nodes.map((node) => ({
        id: node.id,
        title: node.title ?? node.label ?? node.id,
        agentRef: node.agentDefinitionRef ?? `agent.${node.role ?? "generated"}`,
        skillRefs: node.skillRefs ?? [],
        toolGrantRefs: node.toolGrantRefs ?? [],
        mcpGrantRefs: node.mcpGrantRefs ?? [],
      })),
      edges: dag.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}
```

Add a button:

```tsx
<button type="button" onClick={() => void saveTemplate()} disabled={!state.draft?.draftId}>
  Save Template
</button>
```

- [ ] **Step 6: Run web workflow test**

Run: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/v2/server/library-routes.ts web/app/api/workflow/planner-drafts/[draftId]/save-template/route.ts web/components/WorkflowDagBlock.tsx tests/web/southstar-workflow-canvas-ui.test.tsx
git commit -m "feat: save generated workflow templates"
```

---

## Task 13: Final Verification And Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md` only if implementation names diverged from the spec

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
npx tsx tests/v2/library-file-parser.test.ts
npx tsx tests/v2/library-file-store.test.ts
npx tsx tests/v2/library-graph-read-model.test.ts
npx tsx tests/v2/library-chat-routes.test.ts
npx tsx tests/v2/generated-profile-validator.test.ts
npx tsx tests/v2/workflow-template-save-service.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run focused web tests**

Run:

```bash
npx tsx tests/web/southstar-library-chat-stream.test.tsx
npx tsx tests/web/southstar-library-tab.test.tsx
npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected: all PASS.

- [ ] **Step 3: Run broad gates**

Run:

```bash
npm run test:v2
npm --prefix web run build
```

Expected: PASS. If `npm --prefix web run build` fails because an unrelated dirty worktree change is broken, record the unrelated file and keep the Library changes isolated.

- [ ] **Step 4: Update README and AGENTS**

Add a short section to `README.md`:

```md
### Library Tab And Local Library Files

Southstar Library content is authored under `library/` as editable files and synced to the Postgres design library graph through the Library tab/API. Agents and skills use Markdown with YAML frontmatter; tools, MCP grants, generated profiles, and saved workflow templates use YAML. Runtime workflow generation reads the validated Postgres graph, not raw files.
```

Add a matching note to `AGENTS.md` under Web App Notes or Architecture:

```md
- Library authoring uses local files under `library/` plus the Postgres design library graph. Do not add new active library content by hardcoding `software-library-seed.ts`; use the Library file/import/sync path. `software-library-seed.ts` remains only for migration/test/demo bootstrap.
```

- [ ] **Step 5: Commit docs and final verification result**

```bash
git add README.md AGENTS.md docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md
git commit -m "docs: document library authoring workflow"
```

---

## Self-Review Checklist

**Spec coverage**

- Library tab panel: Tasks 7 and 8.
- Workflow-like layout: Task 7 adds persistent panel; Task 8 adds left/center/right surfaces.
- Center chat window with SSE: Tasks 5, 6, and 8.
- Left domain-grouped agent/skill/tool/MCP tree: Tasks 3 and 8.
- Prompt calls backend API for import/create: Tasks 5, 6, 8, and 9.
- Right file viewer/editor: Tasks 2, 4, and 8.
- Chat graph block and React chart: Tasks 3, 6, and 8.
- Postgres graph from local files: Tasks 1 through 4.
- LLM proposal seam: Task 9 creates the deterministic importer and future LLM seam; full live LLM extraction can be added after the deterministic path is stable.
- Dynamic generated profile validation: Task 10.
- Workflow DAG Save for template + profiles: Tasks 11 and 12.
- Docs and commands: Task 13.

**Execution order**

The order intentionally keeps runtime APIs testable before UI. Do not implement Task 8 before Tasks 4 through 6; otherwise the UI will need fake behavior that later gets thrown away.

**Known implementation boundary**

This plan implements deterministic prompt import first. It creates a clean seam for `llm-library-extractor.ts`, but does not require live LLM extraction in the first implementation. This keeps tests stable and avoids importing unreviewed external repo content directly into runtime truth.

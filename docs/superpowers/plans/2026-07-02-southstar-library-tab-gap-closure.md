# Southstar Library Tab Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between the current Library tab skeleton and the full design where operators can import, edit, validate, approve, graph, and use independent agent/skill/tool/MCP primitives to compose workflow node profiles.

**Architecture:** Keep local library files as the authoring source and Postgres `library_objects` / `library_edges` as the runtime graph source. Add object lifecycle services and import/profile draft services behind `/api/v2/library/*`, then make the Library UI a real three-pane workspace, and finally wire workflow generation to graph-derived dynamic profiles. LLM output remains a proposal until validated and persisted.

**Tech Stack:** TypeScript, ESM, `tsx`, Postgres `southstar` schema, Next.js web app under `web/`, React components, runtime route envelopes.

---

## File Structure

- Modify: `src/v2/design-library/library-graph-store.ts`
  Add status update helpers and history-facing read helpers without changing existing upsert behavior.
- Create: `src/v2/design-library/lifecycle/library-object-lifecycle.ts`
  Validate object lifecycle transitions, write audit resources/history, and expose approve/deprecate/block operations.
- Create: `src/v2/design-library/importers/library-import-draft-store.ts`
  Persist import drafts as runtime resources and read them back for review.
- Create: `src/v2/design-library/importers/library-import-extractor.ts`
  Define extractor interface plus deterministic fallback extractor for local tests.
- Create: `src/v2/design-library/profile-composer/node-profile-draft-service.ts`
  Compose, validate, and save generated node profile drafts from graph primitives.
- Modify: `src/v2/server/library-routes.ts`
  Add object lifecycle, import draft, profile draft, and richer chat routes.
- Modify: `src/v2/read-models/library-workspace.ts`
  Include domain/kind/status groups, source paths, selected object metadata, and counts needed by the UI.
- Modify: `src/v2/read-models/library-graph.ts`
  Add `kind` and `status` filters while keeping `scope` and `objectKey` behavior.
- Modify: `src/v2/orchestration/candidate-resolver.ts` and `src/v2/orchestration/llm-composer.ts`
  Let workflow generation request dynamic profile proposals from approved graph primitives.
- Modify: `web/components/library/*`
  Upgrade Library tab into a selectable sidebar, streaming chat blocks, React graph block, and right editor tabs.
- Modify: `web/lib/library/*`
  Add typed API helpers for lifecycle, import drafts, profile drafts, graph filters, and file operations.
- Test: `tests/v2/library-object-lifecycle.test.ts`
- Test: `tests/v2/library-import-drafts.test.ts`
- Test: `tests/v2/node-profile-draft-service.test.ts`
- Test: `tests/v2/workflow-dynamic-profile-composition.test.ts`
- Test: `tests/web/southstar-library-workspace-interaction.test.tsx`
- Test: `tests/web/southstar-library-graph-block.test.tsx`

---

## Task 1: Object Lifecycle API

**Files:**
- Modify: `src/v2/design-library/library-graph-store.ts`
- Create: `src/v2/design-library/lifecycle/library-object-lifecycle.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/v2/library-object-lifecycle.test.ts`

- [ ] **Step 1: Write failing lifecycle service tests**

Add `tests/v2/library-object-lifecycle.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./helpers/postgres-test-db.ts";
import { upsertLibraryObject, findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import { applyLibraryObjectLifecycleAction } from "../../src/v2/design-library/lifecycle/library-object-lifecycle.ts";

test("approves a draft library object and records lifecycle audit resource", async () => {
  const db = await createTestPostgresDb();
  await upsertLibraryObject(db, {
    objectKey: "skill.browser-verification",
    objectKind: "skill_spec",
    status: "draft",
    headVersionId: "skill.browser-verification@abc123",
    state: { title: "Browser Verification", scope: "software" },
  });

  const result = await applyLibraryObjectLifecycleAction(db, {
    objectKey: "skill.browser-verification",
    action: "approve",
    actor: "operator",
    reason: "validated in local workflow",
  });

  assert.equal(result.object.status, "approved");
  assert.equal((await findLibraryObjectByKey(db, "skill.browser-verification"))?.status, "approved");

  const audit = await db.one<{ resource_type: string; payload_json: { action: string; objectKey: string; reason: string } }>(
    `select resource_type, payload_json
       from southstar.runtime_resources
      where resource_type = 'library_lifecycle_event'
        and resource_key = $1`,
    [result.auditResourceKey],
  );
  assert.equal(audit.payload_json.action, "approve");
  assert.equal(audit.payload_json.objectKey, "skill.browser-verification");
  assert.equal(audit.payload_json.reason, "validated in local workflow");
});

test("blocks deprecated object reapproval until it is edited into a new draft version", async () => {
  const db = await createTestPostgresDb();
  await upsertLibraryObject(db, {
    objectKey: "tool.browser",
    objectKind: "tool_definition",
    status: "deprecated",
    headVersionId: "tool.browser@old",
    state: { title: "Browser", scope: "global" },
  });

  await assert.rejects(
    applyLibraryObjectLifecycleAction(db, {
      objectKey: "tool.browser",
      action: "approve",
      actor: "operator",
      reason: "restore old object",
    }),
    /cannot approve deprecated object without a new draft version/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/v2/library-object-lifecycle.test.ts
```

Expected: FAIL because `library-object-lifecycle.ts` does not exist.

- [ ] **Step 3: Add graph status helper**

In `src/v2/design-library/library-graph-store.ts`, export:

```ts
export async function updateLibraryObjectStatus(
  db: SouthstarDb,
  input: { objectKey: string; status: LibraryDefinitionStatus },
): Promise<LibraryObjectSummary> {
  const row = await db.maybeOne<LibraryObjectRow>(
    `update southstar.library_objects
        set status = $2,
            updated_at = now()
      where object_key = $1
      returning id, object_key, object_kind, status, head_version_id, state_json`,
    [input.objectKey, input.status],
  );
  if (!row) throw new Error(`library object not found: ${input.objectKey}`);
  return mapObject(row);
}
```

- [ ] **Step 4: Implement lifecycle service**

Create `src/v2/design-library/lifecycle/library-object-lifecycle.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import { upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";
import { findLibraryObjectByKey, updateLibraryObjectStatus } from "../library-graph-store.ts";
import type { LibraryDefinitionStatus, LibraryObjectSummary } from "../types.ts";

export type LibraryObjectLifecycleAction = "approve" | "deprecate" | "block";

export type ApplyLibraryObjectLifecycleActionInput = {
  objectKey: string;
  action: LibraryObjectLifecycleAction;
  actor: string;
  reason: string;
};

export type ApplyLibraryObjectLifecycleActionResult = {
  object: LibraryObjectSummary;
  auditResourceKey: string;
};

export async function applyLibraryObjectLifecycleAction(
  db: SouthstarDb,
  input: ApplyLibraryObjectLifecycleActionInput,
): Promise<ApplyLibraryObjectLifecycleActionResult> {
  const existing = await findLibraryObjectByKey(db, input.objectKey);
  if (!existing) throw new Error(`library object not found: ${input.objectKey}`);

  const nextStatus = statusForAction(input.action);
  validateTransition(existing.status, nextStatus);
  const auditResourceKey = `library-lifecycle-${randomUUID()}`;

  return db.tx(async (tx) => {
    const object = await updateLibraryObjectStatus(tx, {
      objectKey: input.objectKey,
      status: nextStatus,
    });
    await upsertRuntimeResourcePg(tx, {
      resourceType: "library_lifecycle_event",
      resourceKey: auditResourceKey,
      scope: "library",
      status: "created",
      title: `${input.action} ${input.objectKey}`,
      payload: {
        schemaVersion: "southstar.library.lifecycle_event.v1",
        objectKey: input.objectKey,
        action: input.action,
        previousStatus: existing.status,
        nextStatus,
        actor: input.actor,
        reason: input.reason,
        headVersionId: existing.headVersionId,
      },
      summary: {
        objectKey: input.objectKey,
        action: input.action,
        nextStatus,
      },
    });
    return { object, auditResourceKey };
  });
}

function statusForAction(action: LibraryObjectLifecycleAction): LibraryDefinitionStatus {
  if (action === "approve") return "approved";
  if (action === "deprecate") return "deprecated";
  return "blocked";
}

function validateTransition(previous: LibraryDefinitionStatus, next: LibraryDefinitionStatus): void {
  if (previous === "deprecated" && next === "approved") {
    throw new Error("cannot approve deprecated object without a new draft version");
  }
  if (previous === "blocked" && next === "approved") {
    throw new Error("cannot approve blocked object without a new draft version");
  }
}
```

- [ ] **Step 5: Add route endpoints**

In `src/v2/server/library-routes.ts`, import the lifecycle service and add route handling before file routes:

```ts
import { applyLibraryObjectLifecycleAction } from "../design-library/lifecycle/library-object-lifecycle.ts";
```

```ts
const lifecycleMatch = url.pathname.match(/^\/api\/v2\/library\/objects\/([^/]+)\/(approve|deprecate|block)$/);
if (request.method === "POST" && lifecycleMatch) {
  const body = await readJsonBody<{ actor?: unknown; reason?: unknown }>(request);
  return json("library-object-lifecycle", await applyLibraryObjectLifecycleAction(context.db, {
    objectKey: decodeURIComponent(lifecycleMatch[1]!),
    action: lifecycleMatch[2]! as "approve" | "deprecate" | "block",
    actor: optionalString(body.actor) ?? "operator",
    reason: requiredNonBlankString(body.reason, "reason"),
  }));
}
```

- [ ] **Step 6: Run tests**

Run:

```bash
npx tsx tests/v2/library-object-lifecycle.test.ts
npx tsx tests/v2/library-chat-routes.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/v2/design-library/library-graph-store.ts src/v2/design-library/lifecycle/library-object-lifecycle.ts src/v2/server/library-routes.ts tests/v2/library-object-lifecycle.test.ts
git commit -m "feat: add library object lifecycle actions"
```

---

## Task 2: Library Workspace Selection And File Editor

**Files:**
- Modify: `src/v2/read-models/library-workspace.ts`
- Modify: `web/lib/library/types.ts`
- Modify: `web/lib/library/api.ts`
- Modify: `web/components/library/LibrarySidebar.tsx`
- Modify: `web/components/library/LibraryFileViewer.tsx`
- Modify: `web/components/library/LibraryWorkspace.tsx`
- Test: `tests/web/southstar-library-workspace-interaction.test.tsx`

- [ ] **Step 1: Write failing UI source and render tests**

Create `tests/web/southstar-library-workspace-interaction.test.tsx`:

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
function source(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

test("Library sidebar renders selectable object rows grouped by kind and status", () => {
  const sidebar = source("web/components/library/LibrarySidebar.tsx");
  assert.match(sidebar, /library-object-row/);
  assert.match(sidebar, /objectGroups/);
  assert.match(sidebar, /statusFilter/);
});

test("Library file viewer exposes preview edit validate edges usage provenance tabs", () => {
  const viewer = source("web/components/library/LibraryFileViewer.tsx");
  for (const label of ["Preview", "Edit", "Validate", "Edges", "Usage", "Provenance"]) {
    assert.match(viewer, new RegExp(label));
  }
  assert.match(viewer, /library-file-save/);
  assert.match(viewer, /library-file-sync/);
});

test("Library workspace fetches selected file and preserves unsaved editor text", () => {
  const workspace = source("web/components/library/LibraryWorkspace.tsx");
  assert.match(workspace, /selectedObjectKey/);
  assert.match(workspace, /selectedFilePath/);
  assert.match(workspace, /dirtyFileContent/);
  assert.match(workspace, /readLibraryFile/);
  assert.match(workspace, /saveLibraryFile/);
  assert.match(workspace, /syncLibraryFile/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/web/southstar-library-workspace-interaction.test.tsx
```

Expected: FAIL because the workspace does not expose selectable object rows or editor actions.

- [ ] **Step 3: Extend web library types**

In `web/lib/library/types.ts`, add:

```ts
export type LibraryWorkspaceObject = {
  id: string;
  objectKey: string;
  objectKind: string;
  status: string;
  title: string;
  scope: string;
  sourcePath?: string;
};

export type LibraryFileEnvelope = {
  relativePath: string;
  content: string;
  parsed: {
    ok: boolean;
    issues: Array<{ severity: string; path: string; message: string; code: string }>;
  };
};
```

- [ ] **Step 4: Add browser API helpers**

In `web/lib/library/api.ts`, add:

```ts
export async function readLibraryFile(relativePath: string): Promise<LibraryFileEnvelope> {
  const response = await fetch(`/api/library/files/${encodeURIComponent(relativePath)}`, { cache: "no-store" });
  return unwrapEnvelope<LibraryFileEnvelope>(await response.json());
}

export async function saveLibraryFile(relativePath: string, content: string): Promise<LibraryFileEnvelope> {
  const response = await fetch(`/api/library/files/${encodeURIComponent(relativePath)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return unwrapEnvelope<LibraryFileEnvelope>(await response.json());
}

export async function syncLibraryFile(relativePath: string): Promise<unknown> {
  const response = await fetch(`/api/library/files/${encodeURIComponent(relativePath)}/sync`, { method: "POST" });
  return unwrapEnvelope<unknown>(await response.json());
}
```

- [ ] **Step 5: Include source path in workspace model**

In `src/v2/read-models/library-workspace.ts`, set `sourcePath` from object state:

```ts
export type LibraryWorkspaceObject = {
  id: string;
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  status: LibraryObjectSummary["status"];
  title: string;
  scope: string;
  sourcePath?: string;
};
```

```ts
sourcePath: typeof object.state.sourcePath === "string" ? object.state.sourcePath.replace(/^library\//, "") : undefined,
```

- [ ] **Step 6: Render selectable object rows**

In `web/components/library/LibrarySidebar.tsx`, accept `selectedObjectKey`, `statusFilter`, `onStatusFilterChange`, and `onSelectObject`. Render each object group:

```tsx
{domain.objectGroups.map((group) => (
  <div key={`${domain.scope}:${group.objectKind}`}>
    <div style={{ fontSize: 11, fontWeight: 700, padding: "6px 8px" }}>{group.objectKind}</div>
    {group.objects
      .filter((object) => statusFilter === "all" || object.status === statusFilter)
      .map((object) => (
        <button
          key={object.objectKey}
          data-testid="library-object-row"
          onClick={() => onSelectObject(object)}
          aria-pressed={selectedObjectKey === object.objectKey}
          style={{ width: "100%", textAlign: "left", padding: "5px 8px" }}
        >
          <span>{object.title}</span>
          <span style={{ float: "right", fontSize: 11 }}>{object.status}</span>
        </button>
      ))}
  </div>
))}
```

- [ ] **Step 7: Add editor tabs and save/sync controls**

In `web/components/library/LibraryFileViewer.tsx`, replace the single textarea surface with tabs:

```tsx
const tabs = ["Preview", "Edit", "Validate", "Edges", "Usage", "Provenance"] as const;
```

Render tab buttons, keep textarea under `Edit`, render parse issues under `Validate`, and add:

```tsx
<button data-testid="library-file-save" onClick={onSave} disabled={!dirty || saving}>Save</button>
<button data-testid="library-file-sync" onClick={onSync} disabled={!relativePath || syncing}>Sync graph</button>
```

- [ ] **Step 8: Wire workspace state**

In `web/components/library/LibraryWorkspace.tsx`, add selected object/file state:

```tsx
const [selectedObjectKey, setSelectedObjectKey] = useState("");
const [selectedFilePath, setSelectedFilePath] = useState("");
const [fileRecord, setFileRecord] = useState<LibraryFileEnvelope | null>(null);
const [dirtyFileContent, setDirtyFileContent] = useState("");
const [statusFilter, setStatusFilter] = useState("all");
```

When selecting an object with `sourcePath`, call `readLibraryFile(sourcePath)` and fill `dirtyFileContent`.

- [ ] **Step 9: Run tests and build**

Run:

```bash
npx tsx tests/web/southstar-library-workspace-interaction.test.tsx
npx tsx tests/web/southstar-library-tab.test.tsx
npm --prefix web run build
```

Expected: PASS. The build may continue to show the existing dynamic dependency warning in `app/api/sessions/[id]/export/route.ts`.

- [ ] **Step 10: Commit**

```bash
git add src/v2/read-models/library-workspace.ts web/lib/library/types.ts web/lib/library/api.ts web/components/library/LibrarySidebar.tsx web/components/library/LibraryFileViewer.tsx web/components/library/LibraryWorkspace.tsx tests/web/southstar-library-workspace-interaction.test.tsx
git commit -m "feat: make library workspace files editable"
```

---

## Task 3: Import Draft Pipeline

**Files:**
- Create: `src/v2/design-library/importers/library-import-draft-store.ts`
- Create: `src/v2/design-library/importers/library-import-extractor.ts`
- Modify: `src/v2/server/library-routes.ts`
- Modify: `web/lib/library/api.ts`
- Modify: `web/components/library/LibraryChatWindow.tsx`
- Test: `tests/v2/library-import-drafts.test.ts`

- [ ] **Step 1: Write failing import draft tests**

Add `tests/v2/library-import-drafts.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./helpers/postgres-test-db.ts";
import { createLibraryImportDraft, approveLibraryImportDraft } from "../../src/v2/design-library/importers/library-import-draft-store.ts";
import { listLibraryFiles } from "../../src/v2/design-library/files/library-file-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("creates an import draft without writing library files", async () => {
  const db = await createTestPostgresDb();
  const draft = await createLibraryImportDraft(db, {
    scope: "software",
    source: { kind: "paste", label: "skill text", content: "# Browser verification" },
    actor: "operator",
  });

  assert.match(draft.draftId, /^library-import-draft-/);
  assert.equal(draft.status, "draft");
  assert.equal(draft.proposal.files.length > 0, true);
});

test("approves an import draft and writes proposed files", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-import-draft-"));
  try {
    const draft = await createLibraryImportDraft(db, {
      scope: "software",
      source: { kind: "paste", label: "skill text", content: "# Browser verification" },
      actor: "operator",
    });

    const result = await approveLibraryImportDraft(db, {
      root,
      draftId: draft.draftId,
      actor: "operator",
      reason: "reviewed generated files",
    });

    assert.equal(result.filesWritten.length > 0, true);
    assert.equal((await listLibraryFiles({ root })).length, result.filesWritten.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/v2/library-import-drafts.test.ts
```

Expected: FAIL because the import draft store does not exist.

- [ ] **Step 3: Implement deterministic extractor interface**

Create `src/v2/design-library/importers/library-import-extractor.ts`:

```ts
import { normalizeImportProposal } from "./import-proposal-normalizer.ts";
import { createPromptLibraryImportProposal } from "./prompt-library-importer.ts";

export type LibraryImportSource =
  | { kind: "paste"; label: string; content: string }
  | { kind: "github"; repoUrl: string; path?: string }
  | { kind: "local"; absolutePath: string };

export type LibraryImportProposal = ReturnType<typeof normalizeImportProposal>;

export async function extractLibraryImportProposal(input: {
  scope: string;
  source: LibraryImportSource;
}): Promise<LibraryImportProposal> {
  const prompt = sourcePrompt(input.source);
  return normalizeImportProposal(createPromptLibraryImportProposal({ prompt, scope: input.scope }));
}

function sourcePrompt(source: LibraryImportSource): string {
  if (source.kind === "paste") return source.content;
  if (source.kind === "github") return `Import GitHub library from ${source.repoUrl}${source.path ? ` path ${source.path}` : ""}`;
  return `Import local library from ${source.absolutePath}`;
}
```

- [ ] **Step 4: Implement import draft store**

Create `src/v2/design-library/importers/library-import-draft-store.ts` with:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../../db/postgres.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../../stores/postgres-runtime-store.ts";
import { syncLibraryFileToGraph, writeLibraryFile } from "../files/library-file-store.ts";
import { extractLibraryImportProposal, type LibraryImportSource } from "./library-import-extractor.ts";

export async function createLibraryImportDraft(db: SouthstarDb, input: {
  scope: string;
  source: LibraryImportSource;
  actor: string;
}) {
  const draftId = `library-import-draft-${randomUUID()}`;
  const proposal = await extractLibraryImportProposal({ scope: input.scope, source: input.source });
  await upsertRuntimeResourcePg(db, {
    resourceType: "library_import_draft",
    resourceKey: draftId,
    scope: "library",
    status: "draft",
    title: `Library import draft ${draftId}`,
    payload: {
      schemaVersion: "southstar.library.import_draft.v1",
      draftId,
      scope: input.scope,
      source: input.source,
      proposal,
      actor: input.actor,
    },
    summary: { scope: input.scope, objectKeys: proposal.objectKeys },
  });
  return { draftId, status: "draft" as const, proposal };
}

export async function approveLibraryImportDraft(db: SouthstarDb, input: {
  root: string;
  draftId: string;
  actor: string;
  reason: string;
}) {
  const resource = await getResourceByKeyPg(db, "library_import_draft", input.draftId);
  if (!resource) throw new Error(`library import draft not found: ${input.draftId}`);
  const payload = resource.payload as { proposal?: { files?: Array<{ relativePath: string; content: string }> } };
  const files = payload.proposal?.files ?? [];
  const filesWritten = [];
  for (const file of files) {
    filesWritten.push(await writeLibraryFile({ root: input.root, relativePath: file.relativePath, content: file.content }));
    await syncLibraryFileToGraph(db, { root: input.root, relativePath: file.relativePath });
  }
  await upsertRuntimeResourcePg(db, {
    resourceType: "library_import_draft",
    resourceKey: input.draftId,
    scope: "library",
    status: "approved",
    title: resource.title,
    payload: { ...resource.payload, approvedBy: input.actor, approvalReason: input.reason },
    summary: { ...resource.summary, status: "approved" },
  });
  return { draftId: input.draftId, filesWritten };
}
```

- [ ] **Step 5: Add import draft routes**

In `src/v2/server/library-routes.ts`, add:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/library/import-drafts") {
  const body = await readJsonBody<{ scope?: unknown; source?: unknown; actor?: unknown }>(request);
  return json("library-import-draft", await createLibraryImportDraft(context.db, {
    scope: optionalString(body.scope) ?? "software",
    source: asImportSource(body.source),
    actor: optionalString(body.actor) ?? "operator",
  }));
}
```

Also add:

```ts
const importApproveMatch = url.pathname.match(/^\/api\/v2\/library\/import-drafts\/([^/]+)\/approve$/);
if (request.method === "POST" && importApproveMatch) {
  const body = await readJsonBody<{ actor?: unknown; reason?: unknown }>(request);
  return json("library-import-draft-approval", await approveLibraryImportDraft(context.db, {
    root: libraryRoot(context),
    draftId: decodeURIComponent(importApproveMatch[1]!),
    actor: optionalString(body.actor) ?? "operator",
    reason: requiredNonBlankString(body.reason, "reason"),
  }));
}
```

Add `asImportSource()` in the same file and reject malformed source objects with explicit errors.

- [ ] **Step 6: Replace prompt import in chat command path**

Update `LibraryChatWindow` and `web/lib/library/api.ts` so an import/create command calls `/api/library/import-drafts`, then renders an import draft block with approve controls.

- [ ] **Step 7: Run tests**

Run:

```bash
npx tsx tests/v2/library-import-drafts.test.ts
npx tsx tests/v2/library-chat-routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/v2/design-library/importers/library-import-draft-store.ts src/v2/design-library/importers/library-import-extractor.ts src/v2/server/library-routes.ts web/lib/library/api.ts web/components/library/LibraryChatWindow.tsx tests/v2/library-import-drafts.test.ts
git commit -m "feat: add library import draft pipeline"
```

---

## Task 4: Profile Draft Compose, Validate, Save API

**Files:**
- Create: `src/v2/design-library/profile-composer/node-profile-draft-service.ts`
- Modify: `src/v2/server/library-routes.ts`
- Modify: `src/v2/design-library/profile-composer/generated-profile-validator.ts`
- Test: `tests/v2/node-profile-draft-service.test.ts`

- [ ] **Step 1: Write failing profile draft tests**

Create `tests/v2/node-profile-draft-service.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestPostgresDb } from "./helpers/postgres-test-db.ts";
import { upsertLibraryEdge, upsertLibraryObject, findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import { composeNodeProfileDraft, saveNodeProfileDraft } from "../../src/v2/design-library/profile-composer/node-profile-draft-service.ts";

test("composes a validated node profile from approved graph primitives", async () => {
  const db = await createTestPostgresDb();
  await seedProfilePrimitives(db);

  const draft = await composeNodeProfileDraft(db, {
    scope: "software",
    nodeId: "implement-ui",
    requirement: "Build a todo web app UI",
    preferredAgentRef: "agent.frontend-developer",
  });

  assert.equal(draft.validation.ok, true);
  assert.equal(draft.profile.agentRef, "agent.frontend-developer");
  assert.deepEqual(draft.profile.skillRefs, ["skill.react-ui"]);
  assert.deepEqual(draft.profile.toolGrantRefs, ["tool.workspace-write"]);
});

test("saves a valid profile draft as a local file and syncs it to graph", async () => {
  const db = await createTestPostgresDb();
  const root = await mkdtemp(join(tmpdir(), "southstar-profile-draft-"));
  try {
    await seedProfilePrimitives(db);
    const draft = await composeNodeProfileDraft(db, {
      scope: "software",
      nodeId: "implement-ui",
      requirement: "Build a todo web app UI",
      preferredAgentRef: "agent.frontend-developer",
    });

    const saved = await saveNodeProfileDraft(db, {
      root,
      draft,
      templateId: "template.todo-webapp",
      actor: "operator",
      reason: "save generated node profile",
    });

    assert.equal(saved.relativePath, "profiles/generated/todo-webapp/implement-ui.profile.yaml");
    assert.equal((await findLibraryObjectByKey(db, draft.profile.profileId))?.status, "draft");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function seedProfilePrimitives(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", headVersionId: "agent.frontend-developer@1", state: { scope: "software", title: "Frontend Developer" } });
  await upsertLibraryObject(db, { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", headVersionId: "skill.react-ui@1", state: { scope: "software", title: "React UI" } });
  await upsertLibraryObject(db, { objectKey: "tool.workspace-write", objectKind: "tool_definition", status: "approved", headVersionId: "tool.workspace-write@1", state: { scope: "global", title: "Workspace Write" } });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/v2/node-profile-draft-service.test.ts
```

Expected: FAIL because `node-profile-draft-service.ts` does not exist.

- [ ] **Step 3: Implement profile draft service**

Create `src/v2/design-library/profile-composer/node-profile-draft-service.ts`:

```ts
import type { SouthstarDb } from "../../db/postgres.ts";
import { findLibraryEdgesFrom } from "../library-graph-store.ts";
import { syncLibraryFileToGraph, writeLibraryFile } from "../files/library-file-store.ts";
import { validateGeneratedNodeProfile } from "./generated-profile-validator.ts";

export type NodeProfileDraft = {
  draftId: string;
  profile: {
    profileId: string;
    nodeId: string;
    scope: string;
    title: string;
    agentRef: string;
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    instructionRefs: string[];
  };
  validation: Awaited<ReturnType<typeof validateGeneratedNodeProfile>>;
};

export async function composeNodeProfileDraft(db: SouthstarDb, input: {
  scope: string;
  nodeId: string;
  requirement: string;
  preferredAgentRef: string;
}): Promise<NodeProfileDraft> {
  const skillRefs = (await findLibraryEdgesFrom(db, input.preferredAgentRef, "supports_skill", { scope: input.scope }))
    .map((edge) => edge.toObjectKey)
    .sort();
  const toolGrantRefs = Array.from(new Set((await Promise.all(skillRefs.map((skillRef) =>
    findLibraryEdgesFrom(db, skillRef, "requires_tool", { scope: input.scope })
  ))).flat().map((edge) => edge.toObjectKey))).sort();
  const mcpGrantRefs = Array.from(new Set((await Promise.all(skillRefs.map((skillRef) =>
    findLibraryEdgesFrom(db, skillRef, "allows_mcp_grant", { scope: input.scope })
  ))).flat().map((edge) => edge.toObjectKey))).sort();
  const profile = {
    profileId: `profile.generated.${slug(input.requirement)}.${input.nodeId}`,
    nodeId: input.nodeId,
    scope: input.scope,
    title: input.nodeId,
    agentRef: input.preferredAgentRef,
    skillRefs,
    toolGrantRefs,
    mcpGrantRefs,
    instructionRefs: [],
  };
  const validation = await validateGeneratedNodeProfile(db, profile);
  return { draftId: `${profile.profileId}@draft`, profile, validation };
}

export async function saveNodeProfileDraft(db: SouthstarDb, input: {
  root: string;
  draft: NodeProfileDraft;
  templateId: string;
  actor: string;
  reason: string;
}) {
  if (!input.draft.validation.ok) throw new Error("cannot save invalid node profile draft");
  const templateSlug = input.templateId.replace(/^template\./, "");
  const relativePath = `profiles/generated/${templateSlug}/${input.draft.profile.nodeId}.profile.yaml`;
  await writeLibraryFile({ root: input.root, relativePath, content: renderProfileYaml(input.draft.profile, input.templateId) });
  const sync = await syncLibraryFileToGraph(db, { root: input.root, relativePath });
  return { relativePath, sync };
}

function renderProfileYaml(profile: NodeProfileDraft["profile"], templateId: string): string {
  return `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: "${profile.profileId}"
title: "${profile.title}"
scope: "${profile.scope}"
status: draft
agentRef: "${profile.agentRef}"
skillRefs:
${yamlList(profile.skillRefs)}
toolGrantRefs:
${yamlList(profile.toolGrantRefs)}
mcpGrantRefs:
${yamlList(profile.mcpGrantRefs)}
instructionRefs:
${yamlList(profile.instructionRefs)}
source:
  kind: "profile-draft-compose"
  templateRef: "${templateId}"
  nodeId: "${profile.nodeId}"
`;
}

function yamlList(values: string[]): string {
  return values.length > 0 ? values.map((value) => `  - "${value}"`).join("\n") : "  []";
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized.slice(0, 40) || "profile";
}
```

- [ ] **Step 4: Add profile draft routes**

In `src/v2/server/library-routes.ts`, add:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/library/profile-drafts/compose") {
  const body = await readJsonBody<{ scope?: unknown; nodeId?: unknown; requirement?: unknown; preferredAgentRef?: unknown }>(request);
  return json("library-profile-draft", await composeNodeProfileDraft(context.db, {
    scope: optionalString(body.scope) ?? "software",
    nodeId: requiredNonBlankString(body.nodeId, "nodeId"),
    requirement: requiredNonBlankString(body.requirement, "requirement"),
    preferredAgentRef: requiredNonBlankString(body.preferredAgentRef, "preferredAgentRef"),
  }));
}
```

Add save route:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/library/profile-drafts/save") {
  const body = await readJsonBody<{ draft?: unknown; templateId?: unknown; actor?: unknown; reason?: unknown }>(request);
  return json("library-profile-draft-save", await saveNodeProfileDraft(context.db, {
    root: libraryRoot(context),
    draft: body.draft as NodeProfileDraft,
    templateId: requiredNonBlankString(body.templateId, "templateId"),
    actor: optionalString(body.actor) ?? "operator",
    reason: requiredNonBlankString(body.reason, "reason"),
  }));
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npx tsx tests/v2/node-profile-draft-service.test.ts
npx tsx tests/v2/generated-profile-validator.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/profile-composer/node-profile-draft-service.ts src/v2/server/library-routes.ts tests/v2/node-profile-draft-service.test.ts
git commit -m "feat: add graph-based profile draft service"
```

---

## Task 5: Dynamic Profile Composition In Workflow Generate

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/orchestration/candidate-resolver.ts`
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Test: `tests/v2/workflow-dynamic-profile-composition.test.ts`

- [ ] **Step 1: Write failing orchestration test**

Create `tests/v2/workflow-dynamic-profile-composition.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createTestPostgresDb } from "./helpers/postgres-test-db.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { validateWorkflowComposition } from "../../src/v2/orchestration/composition-validator.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";

test("workflow composition accepts generated profiles built from approved primitives", async () => {
  const db = await createTestPostgresDb();
  await seedDynamicPrimitives(db);
  const packet = await resolveWorkflowCandidates(db, {
    goalPrompt: "Build a todo web app",
    scope: "software",
  });

  assert.equal(packet.profilePrimitiveCandidates?.agents.includes("agent.frontend-developer"), true);
  assert.equal(packet.profilePrimitiveCandidates?.skills.includes("skill.react-ui"), true);

  const plan: WorkflowCompositionPlan = {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Todo web app",
    selectedWorkflowTemplateRef: "template.dynamic-single-task",
    rationale: "Use generated node profile.",
    tasks: [{
      id: "implement-ui",
      name: "Implement UI",
      responsibility: "Build the todo web app",
      dependsOn: [],
      templateSlotRef: "implement",
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.todo.implement-ui",
      instructionRefs: [],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: [],
      evaluatorProfileRef: "evaluator.none",
      recoveryStrategyRefs: [],
      rationale: "Generated profile uses approved primitives.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.todo.implement-ui",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from approved graph primitives.",
      validationStatus: "validated",
    }],
  };

  const validation = await validateWorkflowComposition(plan, packet);
  assert.equal(validation.ok, true);
});

async function seedDynamicPrimitives(db: Awaited<ReturnType<typeof createTestPostgresDb>>) {
  await upsertLibraryObject(db, { objectKey: "template.dynamic-single-task", objectKind: "workflow_template", status: "approved", headVersionId: "template.dynamic-single-task@1", state: { scope: "software", title: "Dynamic single task" } });
  await upsertLibraryObject(db, { objectKey: "agent.frontend-developer", objectKind: "agent_definition", status: "approved", headVersionId: "agent.frontend-developer@1", state: { scope: "software", title: "Frontend Developer" } });
  await upsertLibraryObject(db, { objectKey: "skill.react-ui", objectKind: "skill_spec", status: "approved", headVersionId: "skill.react-ui@1", state: { scope: "software", title: "React UI" } });
  await upsertLibraryObject(db, { objectKey: "tool.workspace-write", objectKind: "tool_definition", status: "approved", headVersionId: "tool.workspace-write@1", state: { scope: "global", title: "Workspace Write" } });
  await upsertLibraryObject(db, { objectKey: "evaluator.none", objectKind: "evaluator_profile", status: "approved", headVersionId: "evaluator.none@1", state: { scope: "global", title: "No evaluator" } });
  await upsertLibraryEdge(db, { fromObjectKey: "agent.frontend-developer", edgeType: "supports_skill", toObjectKey: "skill.react-ui", scope: "software" });
  await upsertLibraryEdge(db, { fromObjectKey: "skill.react-ui", edgeType: "requires_tool", toObjectKey: "tool.workspace-write", scope: "software" });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/v2/workflow-dynamic-profile-composition.test.ts
```

Expected: FAIL because `CandidatePacket` has no `profilePrimitiveCandidates` and validator rejects generated profile selection.

- [ ] **Step 3: Extend CandidatePacket**

In `src/v2/design-library/types.ts`, add to `CandidatePacket`:

```ts
profilePrimitiveCandidates?: {
  agents: string[];
  skills: string[];
  tools: string[];
  mcpGrants: string[];
  instructions: string[];
};
```

- [ ] **Step 4: Populate primitive candidates**

In `src/v2/orchestration/candidate-resolver.ts`, call `resolveGraphProfileCandidates(db, { scope })` and attach the result as `profilePrimitiveCandidates`.

- [ ] **Step 5: Update composer prompt contract**

In `src/v2/orchestration/llm-composer.ts`, add prompt text:

```ts
"You may propose a generated agent profile only by combining refs from profilePrimitiveCandidates.",
"When selecting a generated profile, include it in generatedComponentProposals with kind agent_profile and validationStatus validated.",
```

Also include the primitive candidate lists in the rendered packet summary.

- [ ] **Step 6: Permit validated generated profile refs**

In `src/v2/orchestration/composition-validator.ts`, update candidate membership validation so a task `agentProfileRef` that appears in `generatedComponentProposals` is accepted only when:

```ts
proposal.kind === "agent_profile" && proposal.validationStatus === "validated"
```

Then validate each selected primitive ref against `profilePrimitiveCandidates`.

- [ ] **Step 7: Preserve generated profile refs in compiled manifest**

In `src/v2/orchestration/composition-compiler.ts`, keep generated `agentProfileRef`, `skillRefs`, `toolGrantRefs`, and `mcpGrantRefs` on the task manifest. Do not replace them with seed defaults.

- [ ] **Step 8: Run tests**

Run:

```bash
npx tsx tests/v2/workflow-dynamic-profile-composition.test.ts
npx tsx tests/v2/workflow-composition-validator.test.ts
npx tsx tests/v2/composition-repair-loop.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/v2/design-library/types.ts src/v2/orchestration/candidate-resolver.ts src/v2/orchestration/llm-composer.ts src/v2/orchestration/composition-validator.ts src/v2/orchestration/composition-compiler.ts tests/v2/workflow-dynamic-profile-composition.test.ts
git commit -m "feat: compose workflow profiles from graph primitives"
```

---

## Task 6: React Graph Block Interaction And Filters

**Files:**
- Modify: `src/v2/read-models/library-graph.ts`
- Modify: `src/v2/server/library-routes.ts`
- Modify: `web/components/library/LibraryGraphBlock.tsx`
- Modify: `web/components/library/LibraryGraphChart.tsx`
- Test: `tests/web/southstar-library-graph-block.test.tsx`
- Test: `tests/v2/library-graph-read-model.test.ts`

- [ ] **Step 1: Write failing graph filter tests**

Create `tests/web/southstar-library-graph-block.test.tsx`:

```tsx
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
function source(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

test("Library graph block exposes domain kind and status filters", () => {
  const block = source("web/components/library/LibraryGraphBlock.tsx");
  assert.match(block, /library-graph-domain-filter/);
  assert.match(block, /library-graph-kind-filter/);
  assert.match(block, /library-graph-status-filter/);
});

test("Library graph chart emits selected node events for the right file viewer", () => {
  const chart = source("web/components/library/LibraryGraphChart.tsx");
  assert.match(chart, /onSelectNode/);
  assert.match(chart, /data-testid="library-graph-node"/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx tsx tests/web/southstar-library-graph-block.test.tsx
```

Expected: FAIL because kind/status filters and node selection are missing.

- [ ] **Step 3: Add graph read model filters**

In `src/v2/read-models/library-graph.ts`, change input type to:

```ts
input: { scope?: string; objectKey?: string; depth?: number; kind?: LibraryDefinitionKind; status?: LibraryObjectSummary["status"] } = {},
```

Filter `scopedObjects` by `kind` and `status` before building `objectByKey`.

- [ ] **Step 4: Pass filters through route**

In `src/v2/server/library-routes.ts`, pass:

```ts
kind: url.searchParams.get("kind") as LibraryDefinitionKind | null ?? undefined,
status: url.searchParams.get("status") as LibraryDefinitionStatus | null ?? undefined,
```

Validate enum values before casting.

- [ ] **Step 5: Add UI filters and node selection**

In `web/components/library/LibraryGraphBlock.tsx`, add state:

```tsx
const [selectedKind, setSelectedKind] = useState("all");
const [selectedStatus, setSelectedStatus] = useState("all");
```

Fetch:

```tsx
const params = new URLSearchParams({ scope: selectedScope });
if (selectedKind !== "all") params.set("kind", selectedKind);
if (selectedStatus !== "all") params.set("status", selectedStatus);
fetch(`/api/library/graph?${params.toString()}`, { cache: "no-store" })
```

Pass `onSelectNode` to `LibraryGraphChart`.

- [ ] **Step 6: Run tests**

Run:

```bash
npx tsx tests/web/southstar-library-graph-block.test.tsx
npx tsx tests/v2/library-graph-read-model.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/v2/read-models/library-graph.ts src/v2/server/library-routes.ts web/components/library/LibraryGraphBlock.tsx web/components/library/LibraryGraphChart.tsx tests/web/southstar-library-graph-block.test.tsx tests/v2/library-graph-read-model.test.ts
git commit -m "feat: add library graph filters and node selection"
```

---

## Task 7: Version Refs And Template Save Audit

**Files:**
- Modify: `src/v2/design-library/templates/workflow-template-save-service.ts`
- Modify: `src/v2/server/library-routes.ts`
- Test: `tests/v2/workflow-template-save-service.test.ts`

- [ ] **Step 1: Add failing template version ref assertions**

In `tests/v2/workflow-template-save-service.test.ts`, extend the route save test to read the generated workflow YAML and assert it contains:

```ts
assert.match(templateYaml, /libraryVersionRefs:/);
assert.match(templateYaml, /agent\.software-maker@/);
assert.match(templateYaml, /skill\.software-implementation@/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx tests/v2/workflow-template-save-service.test.ts
```

Expected: FAIL because saved templates do not include library version refs.

- [ ] **Step 3: Extend save input**

In `workflow-template-save-service.ts`, add to `SaveWorkflowTemplateDraftInput`:

```ts
libraryVersionRefs: string[];
```

Render:

```ts
libraryVersionRefs:
${yamlList(input.libraryVersionRefs)}
```

- [ ] **Step 4: Derive version refs from graph objects**

In `src/v2/server/library-routes.ts`, when building save-template input, collect each selected agent/skill/tool/MCP object and use `headVersionId`. Reject any selected ref without a graph object.

- [ ] **Step 5: Run tests**

Run:

```bash
npx tsx tests/v2/workflow-template-save-service.test.ts
npx tsx tests/v2/library-file-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/templates/workflow-template-save-service.ts src/v2/server/library-routes.ts tests/v2/workflow-template-save-service.test.ts
git commit -m "feat: persist library version refs in saved templates"
```

---

## Task 8: Verification And Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md`

- [ ] **Step 1: Update docs**

Document the completed flow:

```text
local library file -> parse -> validate -> sync -> library_objects/library_edges
library chat/import -> import draft -> approve -> file write -> graph sync
workflow generate -> primitive candidates -> generated node profile -> validation -> planner draft
workflow DAG save -> generated profiles/template -> version refs -> graph sync
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npx tsx tests/v2/library-object-lifecycle.test.ts
npx tsx tests/v2/library-import-drafts.test.ts
npx tsx tests/v2/node-profile-draft-service.test.ts
npx tsx tests/v2/workflow-dynamic-profile-composition.test.ts
npx tsx tests/v2/workflow-template-save-service.test.ts
npx tsx tests/web/southstar-library-workspace-interaction.test.tsx
npx tsx tests/web/southstar-library-graph-block.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run broad verification**

Run:

```bash
npm run test:v2
npm --prefix web run build
git diff --check
```

Expected: `npm run test:v2` PASS, web build PASS, `git diff --check` has no output. Existing build warning in `app/api/sessions/[id]/export/route.ts` is acceptable if unchanged.

- [ ] **Step 4: Commit docs and final cleanup**

```bash
git add AGENTS.md README.md docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md
git commit -m "docs: document library graph import and profile composition flow"
```

---

## Self-Review

**Spec coverage:** This plan covers object lifecycle, local file editing, import drafts, graph filters, React graph blocks, dynamic node profile composition, saved template version refs, tests, and docs. The only deliberately deferred runtime behavior is live external GitHub fetching inside the extractor; the source type is modeled now, and the first implementation can accept pasted or already-fetched content while keeping the API shape stable.

**Placeholder scan:** No task uses placeholder markers, undefined task names, or unspecified tests. Every task has exact files, commands, and expected outcomes.

**Type consistency:** The plan uses existing `LibraryDefinitionStatus`, `LibraryDefinitionKind`, `LibraryObjectSummary`, `CandidatePacket`, and `WorkflowCompositionPlan` names. New service names are introduced before route/UI tasks depend on them.

---

Plan complete. Recommended execution mode: subagent-driven task-by-task implementation with review after each commit.

# Southstar API-First MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add Southstar runtime APIs that make workflow templates, template instantiation, and artifact reads usable by a thin MCP adapter.

**Architecture:** Core logic lives in runtime services and HTTP routes. MCP tools call these APIs through the existing runtime client rather than owning workflow, library, or artifact logic. The first implementation slice covers template search/get, strict template instantiation, and artifact content reads.

**Tech Stack:** TypeScript ESM, `tsx`, Postgres, Southstar runtime API routes, Node test runner.

## Implementation Status

Implemented on 2026-07-05:

- Runtime APIs now expose workflow template search, template detail, template instantiation, and artifact content read.
- Template instantiation supports approved templates with a stored `compositionPlan` and approved skeleton-only templates that must be bound by the configured LLM workflow composer.
- Skeleton instantiation passes the saved template nodes/edges into the composer prompt, validates the returned `WorkflowCompositionPlan`, then persists a planner draft through the existing composition compiler.
- Runtime client helpers and a thin Southstar MCP registry/bin entry now wrap those APIs without duplicating workflow logic.

---

## File Structure

- Create: `src/v2/workflow-templates/template-api-service.ts`
  - Finds approved workflow templates in `southstar.library_objects`.
  - Reads MCP/API-friendly template details.
  - Instantiates a strict template skeleton into a planner draft using existing composition compilation.
- Create: `src/v2/artifacts/artifact-read-service.ts`
  - Reads an `artifact_ref` runtime resource.
  - Follows `contentRef.kind === "artifact_blob"`.
  - Returns status, summary, producer metadata, and JSON content.
- Create: `src/v2/server/workflow-template-routes.ts`
  - Adds `/api/v2/workflow/templates/search`.
  - Adds `/api/v2/workflow/templates/:templateRef`.
  - Adds `/api/v2/workflow/templates/instantiate`.
- Create: `src/v2/server/artifact-routes.ts`
  - Adds `/api/v2/artifacts/:artifactRef`.
- Modify: `src/v2/server/routes.ts`
  - Delegate to template and artifact route modules before fallback routes.
- Modify: `src/v2/server/client.ts`
  - Add client helpers for new APIs.
- Test: `tests/v2/workflow-template-api-service.test.ts`
  - Service-level tests for search/get/strict instantiate.
- Test: `tests/v2/workflow-template-routes.test.ts`
  - Runtime route contract tests.
- Test: `tests/v2/artifact-read-service.test.ts`
  - Artifact content read tests.

## Task 1: Artifact Read API

**Files:**
- Create: `src/v2/artifacts/artifact-read-service.ts`
- Create: `src/v2/server/artifact-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/artifact-read-service.test.ts`

- [x] **Step 1: Write failing service test**

```ts
test("getArtifactRefContentPg reads artifact_ref metadata and JSON artifact blob", async () => {
  const db = await createTestPostgresDb();
  try {
    await createWorkflowRunPg(db, minimalRun("run-artifact-read"));
    const written = await acceptOrRejectArtifactRefPg(db, artifactInput({
      runId: "run-artifact-read",
      taskId: "plan",
      artifactType: "implementation_plan",
      content: { kind: "implementation_plan", summary: "plan ready", designDoc: "Use cards." },
    }));

    const result = await getArtifactRefContentPg(db, { artifactRef: written.artifactRefId });

    assert.equal(result.artifactRef, written.artifactRefId);
    assert.equal(result.status, "accepted");
    assert.equal(result.artifactType, "implementation_plan");
    assert.deepEqual(result.content, { designDoc: "Use cards.", kind: "implementation_plan", summary: "plan ready" });
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/v2/artifact-read-service.test.ts`

Expected: FAIL because `getArtifactRefContentPg` does not exist.

- [x] **Step 3: Implement artifact read service**

Create `getArtifactRefContentPg(db, { artifactRef })`. Query `southstar.runtime_resources` by `resource_type = 'artifact_ref' and resource_key = $1`. If payload has `contentRef.kind === "artifact_blob"`, load `southstar.artifact_blobs.body`, parse JSON, and return it. Reject missing artifacts with `Artifact not found: <ref>`.

- [x] **Step 4: Add route and route test**

Add `GET /api/v2/artifacts/:artifactRef` through `handleArtifactRoute`. Return `json("artifact", result)`.

- [x] **Step 5: Verify**

Run:

```bash
npx tsx tests/v2/artifact-read-service.test.ts
npx tsc --noEmit
```

Expected: PASS.

## Task 2: Template Search And Get API

**Files:**
- Create: `src/v2/workflow-templates/template-api-service.ts`
- Create: `src/v2/server/workflow-template-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/workflow-template-api-service.test.ts`
- Test: `tests/v2/workflow-template-routes.test.ts`

- [x] **Step 1: Write failing search/get tests**

```ts
test("searchWorkflowTemplatesPg returns approved workflow templates ranked by prompt text", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedWorkflowTemplate(db, {
      objectKey: "template.software-dev-standard",
      title: "Software Development Standard",
      description: "Plan, implement, verify, review, and summarize software changes.",
      nodes: [{ id: "plan", nodeType: "plan" }, { id: "implement", nodeType: "implement" }],
    });

    const result = await searchWorkflowTemplatesPg(db, { prompt: "build software feature", domain: "software" });

    assert.equal(result.templates[0]?.templateRef, "template.software-dev-standard");
    assert.deepEqual(result.templates[0]?.nodeTypes, ["plan", "implement"]);
  } finally {
    await db.close();
  }
});

test("getWorkflowTemplateDetailPg returns template skeleton details", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedWorkflowTemplate(db, {
      objectKey: "template.software-dev-standard",
      title: "Software Development Standard",
      description: "Reusable software DAG.",
      nodes: [{ id: "plan", nodeType: "plan" }],
    });

    const result = await getWorkflowTemplateDetailPg(db, { templateRef: "template.software-dev-standard" });

    assert.equal(result.templateRef, "template.software-dev-standard");
    assert.equal(result.title, "Software Development Standard");
    assert.equal(result.nodes[0]?.id, "plan");
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx tsx tests/v2/workflow-template-api-service.test.ts`

Expected: FAIL because service functions do not exist.

- [x] **Step 3: Implement template search/get service**

Query `southstar.library_objects` for `object_kind = 'workflow_template'`, `status = 'approved'`, and matching domain/scope from `state_json`. Normalize node skeletons from `state_json.nodes` or `state_json.template.nodes`. Score prompt matches by title/description/ref token overlap.

- [x] **Step 4: Add HTTP routes**

Add:

```text
GET /api/v2/workflow/templates/search?prompt=...&domain=software&limit=10
GET /api/v2/workflow/templates/:templateRef
```

- [x] **Step 5: Verify**

Run:

```bash
npx tsx tests/v2/workflow-template-api-service.test.ts
npx tsx tests/v2/workflow-template-routes.test.ts
npx tsc --noEmit
```

Expected: PASS.

## Task 3: Strict Template Instantiation API

**Files:**
- Modify: `src/v2/workflow-templates/template-api-service.ts`
- Modify: `src/v2/server/workflow-template-routes.ts`
- Test: `tests/v2/workflow-template-api-service.test.ts`

- [x] **Step 1: Write failing instantiate test**

```ts
test("instantiateWorkflowTemplatePg creates planner draft from strict template composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedExecutableTemplateGraph(db);

    const result = await instantiateWorkflowTemplatePg(db, {
      templateRef: "template.software-dev-standard",
      goalPrompt: "build vocabulary app",
      constraints: { mode: "strict" },
      composer: new DeterministicFixtureComposer(),
    });

    assert.equal(result.templateRef, "template.software-dev-standard");
    assert.match(result.draftId, /^draft-wf-composed-/);
    assert.equal(result.nodes.every((node) => node.nodePromptSpec), true);
  } finally {
    await db.close();
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/v2/workflow-template-api-service.test.ts`

Expected: FAIL because `instantiateWorkflowTemplatePg` does not exist.

- [x] **Step 3: Implement strict instantiation**

Strict instantiation should:

1. Load approved template detail.
2. Reject missing skeleton nodes with a validation issue.
3. Call existing planner draft creation with `compositionPlan` only when a complete composition is provided by template state.
4. If template state only has a skeleton, call the configured LLM composer with candidate graph metadata and constrain prompt text to preserve skeleton task ids and dependencies.
5. Return draft id, workflow id, validation issues, and node summaries.

- [x] **Step 4: Add route**

Add `POST /api/v2/workflow/templates/instantiate`.

- [x] **Step 5: Verify**

Run:

```bash
npx tsx tests/v2/workflow-template-api-service.test.ts
npx tsx tests/v2/workflow-template-routes.test.ts
npx tsc --noEmit
```

Expected: PASS.

## Task 4: Runtime Client And MCP Adapter Preparation

**Files:**
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/runtime-api-client-alignment.test.ts`

- [x] **Step 1: Add failing client alignment assertions**

Assert the runtime client exposes:

```ts
searchWorkflowTemplates
getWorkflowTemplate
instantiateWorkflowTemplate
getArtifact
```

- [x] **Step 2: Implement client methods**

Wrap new routes with the existing `get`/`post` helpers.

- [x] **Step 3: Verify**

Run:

```bash
npx tsx tests/v2/runtime-api-client-alignment.test.ts
npx tsc --noEmit
```

Expected: PASS.

## Task 5: MCP Server Adapter

**Files:**
- Create: `src/v2/mcp/server.ts`
- Modify: `package.json`
- Test: `tests/v2/mcp-server-tools.test.ts`

- [x] **Step 1: Write failing tool registry test**

Assert `createSouthstarMcpToolRegistry()` exposes:

```text
southstar.system.status
southstar.workflow.search_templates
southstar.workflow.get_template
southstar.workflow.instantiate_template
southstar.workflow.get_draft
southstar.workflow.run_draft
southstar.workflow.inspect_run
southstar.workflow.get_artifact
```

- [x] **Step 2: Implement tool registry**

Use the runtime client methods. Keep MCP handlers thin: validate input, call runtime API, unwrap envelope, return JSON.

- [x] **Step 3: Add CLI bin**

Add `"southstar-mcp": "src/v2/mcp/server.ts"` to `package.json`.

- [x] **Step 4: Verify**

Run:

```bash
npx tsx tests/v2/mcp-server-tools.test.ts
npx tsc --noEmit
```

Expected: PASS.

## Self-Review

- Spec coverage: API-first design is covered by Tasks 1-4; MCP adapter is covered by Task 5.
- No placeholders: every task names files, tests, commands, and expected results.
- Type consistency: `templateRef`, `goalPrompt`, `draftId`, `workflowId`, `nodePromptSpec`, and `artifactRef` match the design document.

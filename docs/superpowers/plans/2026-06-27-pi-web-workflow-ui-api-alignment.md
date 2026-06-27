# Pi-Web Workflow UI API Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align pi-web Workflow UI actions with the existing Southstar v2 planner draft, run materialization, and execute APIs, while finishing the requested layout, collapsible tree, DAG arrow, and JSON viewer fixes.

**Architecture:** Keep pi-web file-first workflow editing, but make lifecycle actions call same-origin pi-web adapter routes that proxy the existing Southstar v2 API. The UI state becomes `file_draft -> planner_draft -> validated -> run_created -> executing`, and the DAG block owns the Draft, Validate, and Run confirmations for the generated workflow proposal. The visible Run action composes existing backend primitives: preflight validate, create run, then execute.

**Tech Stack:** Next.js 16 route handlers, React 19, TypeScript, Node `--test` with `tsx`, Playwright Chromium E2E, existing pi-web CSS tokens.

---

## Source Spec

Implement against `docs/superpowers/specs/2026-06-27-pi-web-workflow-ui-api-alignment-design.md`.

## Confirmed API Context

The parent Southstar repo already has these APIs in `src/v2/server/routes.ts`:

- `POST /api/v2/planner/drafts`
- `POST /api/v2/planner/drafts/:draftId/revise`
- `GET /api/v2/planner/drafts/:draftId/orchestration`
- `POST /api/v2/planner/drafts/:draftId/runs`
- `POST /api/v2/runs`
- `POST /api/v2/runs/:runId/execute`
- `GET /api/v2/runs/:runId`
- `GET /api/v2/runs/:runId/tasks`

The parent repo also has `createPostgresPlannerDraft`, `revisePostgresPlannerDraft`, `getPostgresPlannerDraftOrchestration`, and `createPostgresRunFromDraft` in `src/v2/ui-api/postgres-run-api.ts`. pi-web must not invent a separate definition-version or sync API.

## Guardrails

- Work only in `/home/timmypai/apps/southstar/pi-web`.
- Preserve the existing dirty UI edits in `components/AppModeRail.tsx`, `components/BranchNavigator.tsx`, and `components/WorkflowSidebar.tsx`; finish and test them instead of reverting.
- Do not create new Postgres schema or a separate workflow definition-version concept.
- Keep file draft edits using `PUT /api/workflow/resources/[...path]`.
- Re-align existing `library` and `generate` routes to Southstar v2 before adding new lifecycle UI behavior.
- Keep `resources` as a local file-editing route only when that product requirement is still explicit; do not treat it as a Southstar workflow lifecycle API.
- Keep Chat mode behavior intact.
- When v2 backend is not configured, lifecycle buttons must show a blocked state instead of simulating Postgres persistence.

## File Structure

Create:

- `lib/workflow/v2-api.ts`: shared same-origin adapter helper for forwarding workflow lifecycle requests to Southstar v2.
- `lib/workflow/v2-library-adapter.ts`: maps Southstar v2 agent-library and planner draft outputs into the existing pi-web workflow library/DAG shapes.
- `lib/workflow/lifecycle.ts`: pure state reducer and request builders for Draft, Validate, and Run actions.
- `lib/workflow/dag-layout.ts`: layout helper for DAG columns, rows, and arrow paths.
- `hooks/useWorkflowLifecycle.ts`: client hook that calls pi-web lifecycle adapter routes.
- `app/api/workflow/status/route.ts`: capability and v2 backend health route.
- `app/api/workflow/planner-drafts/route.ts`: proxy for creating planner drafts.
- `app/api/workflow/planner-drafts/[draftId]/revise/route.ts`: proxy for draft revision.
- `app/api/workflow/planner-drafts/[draftId]/orchestration/route.ts`: proxy for draft orchestration read.
- `app/api/workflow/planner-drafts/[draftId]/runs/route.ts`: proxy for run materialization.
- `app/api/workflow/runs/route.ts`: proxy for creating runs by draft id.
- `app/api/workflow/runs/[runId]/route.ts`: proxy for run status.
- `app/api/workflow/runs/[runId]/tasks/route.ts`: proxy for run tasks.
- `app/api/workflow/runs/[runId]/execute/route.ts`: proxy for execution start.
- `tests/unit/workflow-v2-api.test.ts`: adapter helper and route tests.
- `tests/unit/workflow-lifecycle.test.ts`: reducer and request builder tests.
- `tests/unit/workflow-dag-layout.test.ts`: arrow and parallel-level layout tests.

Modify:

- `lib/workflow/types.ts`: add v2 lifecycle result and UI lifecycle state types.
- `lib/workflow/dag.ts`: keep generated DAG compatible with lifecycle request builders.
- `app/api/workflow/library/route.ts`: prefer Southstar `/api/v2/agent-library` when configured; fixture fallback only for local development.
- `app/api/workflow/generate/route.ts`: prefer Southstar `/api/v2/planner/drafts` plus `/orchestration`; SSE remains a UI transport wrapper, not a local planner.
- `app/api/workflow/resources/[...path]/route.ts`: keep local file read/write scoped to explicit resource editing; report capability as local-only.
- `components/WorkflowDagBlock.tsx`: add arrowed DAG diagram and Draft / Validate / Run controls with confirmations.
- `components/MessageView.tsx`: pass workflow cwd into DAG blocks.
- `components/ChatWindow.tsx`: pass workflow cwd into message rendering.
- `components/AppShell.tsx`: move mode tabs to top bar, make Export/Branch icon-only, remove System top-bar control in this layout pass.
- `components/AppModeRail.tsx`: finish horizontal mode and TypeScript typing.
- `components/BranchNavigator.tsx`: finish icon-only inline branch control.
- `components/WorkflowSidebar.tsx`: finish collapsible Workflow Template and Agent Profile tree.
- `components/StructuredJsonEditor.tsx`: render complete formatted JSON in read-only mode.
- `components/WorkflowResourceViewer.tsx`: preserve full-height scrolling for long JSON.
- `tests/e2e/workflow-mode.spec.ts`: add browser validation for layout, tree collapse, DAG arrows/actions, and full JSON display.

## Environment Contract

Use `SOUTHSTAR_V2_API_BASE_URL` as the pi-web server-side base URL for the parent Southstar v2 server, for example:

```bash
SOUTHSTAR_V2_API_BASE_URL=http://127.0.0.1:3000
```

When unset, `/api/workflow/status` returns `v2Backend: false`, and mutating adapter routes return:

```json
{
  "status": "blocked",
  "error": "Southstar v2 workflow API is not configured"
}
```

## Task 1: Add V2 Adapter Helper

**Files:**
- Create: `lib/workflow/v2-api.ts`
- Create: `tests/unit/workflow-v2-api.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/unit/workflow-v2-api.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  buildWorkflowV2Url,
  proxyWorkflowV2Json,
  workflowV2Capabilities,
} from "../../lib/workflow/v2-api";

const originalFetch = global.fetch;
const originalBase = process.env.SOUTHSTAR_V2_API_BASE_URL;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) {
    delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  } else {
    process.env.SOUTHSTAR_V2_API_BASE_URL = originalBase;
  }
});

test("workflowV2Capabilities reports disabled when base url is missing", () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  assert.deepEqual(workflowV2Capabilities(), {
    createDraft: false,
    validate: false,
    createRun: false,
    execute: false,
    run: false,
    postgres: false,
    v2Backend: false,
  });
});

test("buildWorkflowV2Url appends api v2 path to configured base", () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000/";
  assert.equal(
    buildWorkflowV2Url("/api/v2/planner/drafts").toString(),
    "http://127.0.0.1:3000/api/v2/planner/drafts",
  );
});

test("proxyWorkflowV2Json forwards method, body, and content type", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ draftId: "draft-1", status: "validated" }, { status: 201 });
  }) as typeof fetch;

  const request = new NextRequest("http://localhost/api/workflow/planner-drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goalPrompt: "ship it" }),
  });

  const response = await proxyWorkflowV2Json(request, "/api/v2/planner/drafts");
  assert.equal(response.status, 201);
  assert.equal(calls[0]?.url, "http://127.0.0.1:3000/api/v2/planner/drafts");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.body, JSON.stringify({ goalPrompt: "ship it" }));
  assert.equal(calls[0]?.init.headers instanceof Headers, true);
  assert.deepEqual(await response.json(), { draftId: "draft-1", status: "validated" });
});

test("proxyWorkflowV2Json returns blocked when v2 base is missing", async () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts", {
    method: "POST",
    body: JSON.stringify({ goalPrompt: "ship it" }),
  });

  const response = await proxyWorkflowV2Json(request, "/api/v2/planner/drafts");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "blocked",
    error: "Southstar v2 workflow API is not configured",
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:unit -- --test-name-pattern "workflowV2|proxyWorkflowV2|buildWorkflowV2"
```

Expected: FAIL because `lib/workflow/v2-api.ts` does not exist.

- [ ] **Step 3: Implement adapter helper**

Create `lib/workflow/v2-api.ts`:

```ts
import { NextRequest, NextResponse } from "next/server";

export type WorkflowV2Capabilities = {
  createDraft: boolean;
  validate: boolean;
  createRun: boolean;
  execute: boolean;
  run: boolean;
  postgres: boolean;
  v2Backend: boolean;
};

const NOT_CONFIGURED = "Southstar v2 workflow API is not configured";

function normalizedBaseUrl(): string | null {
  const value = process.env.SOUTHSTAR_V2_API_BASE_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function workflowV2Capabilities(): WorkflowV2Capabilities {
  const enabled = Boolean(normalizedBaseUrl());
  return {
    createDraft: enabled,
    validate: enabled,
    createRun: enabled,
    execute: enabled,
    run: enabled,
    postgres: enabled,
    v2Backend: enabled,
  };
}

export function buildWorkflowV2Url(pathname: string): URL {
  const base = normalizedBaseUrl();
  if (!base) throw new Error(NOT_CONFIGURED);
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(path, `${base}/`);
}

export function workflowV2BlockedResponse(): NextResponse {
  return NextResponse.json({ status: "blocked", error: NOT_CONFIGURED }, { status: 503 });
}

export async function proxyWorkflowV2Json(request: NextRequest, pathname: string): Promise<Response> {
  if (!normalizedBaseUrl()) return workflowV2BlockedResponse();
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const response = await fetch(buildWorkflowV2Url(pathname), {
    method: request.method,
    headers: new Headers({
      accept: request.headers.get("accept") ?? "application/json",
      "content-type": request.headers.get("content-type") ?? "application/json",
    }),
    body,
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}
```

- [ ] **Step 4: Run adapter tests**

Run:

```bash
npm run test:unit -- --test-name-pattern "workflowV2|proxyWorkflowV2|buildWorkflowV2"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/workflow/v2-api.ts tests/unit/workflow-v2-api.test.ts
git commit -m "feat: add workflow v2 api adapter"
```

## Task 2: Re-Align Existing Workflow Routes

**Files:**
- Create: `lib/workflow/v2-library-adapter.ts`
- Modify: `app/api/workflow/library/route.ts`
- Modify: `app/api/workflow/generate/route.ts`
- Modify: `app/api/workflow/resources/[...path]/route.ts`
- Modify: `tests/unit/workflow-library.test.ts`

- [ ] **Step 1: Add failing adapter tests**

Append to `tests/unit/workflow-library.test.ts`:

```ts
import {
  buildWorkflowDagFromPlannerDraft,
  workflowLibraryFromAgentLibrary,
} from "../../lib/workflow/v2-library-adapter";

test("workflowLibraryFromAgentLibrary maps v2 agent library to workflow sidebar shape", () => {
  const library = workflowLibraryFromAgentLibrary({
    agents: [
      {
        id: "agent.software-maker",
        name: "software-maker",
        role: "maker",
        domain: "software",
        defaultProfileRef: "software-maker-pi",
        profileResourcePath: "software/agents/software-maker/profile.json",
      },
    ],
  });

  assert.equal(library.domains[0]?.id, "software");
  assert.equal(library.domains[0]?.agents[0]?.id, "agent.software-maker");
});

test("buildWorkflowDagFromPlannerDraft maps v2 draft task summaries to DAG nodes", () => {
  const dag = buildWorkflowDagFromPlannerDraft({
    draftId: "draft-1",
    goalPrompt: "Build workflow",
    workflowId: "wf-1",
    status: "validated",
    validationIssues: [],
    taskSummaries: [
      { taskId: "plan", taskName: "Plan", dependsOn: [], agentProfileRef: "software-maker-pi" },
      { taskId: "implement", taskName: "Implement", dependsOn: ["plan"], agentProfileRef: "software-maker-pi" },
    ],
  });

  assert.equal(dag.id, "draft-1");
  assert.equal(dag.nodes[1]?.level, 1);
  assert.deepEqual(dag.edges, [{ from: "plan", to: "implement" }]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:unit -- --test-name-pattern "workflowLibraryFromAgentLibrary|buildWorkflowDagFromPlannerDraft"
```

Expected: FAIL because `lib/workflow/v2-library-adapter.ts` does not exist.

- [ ] **Step 3: Add v2 library adapter**

Create `lib/workflow/v2-library-adapter.ts`:

```ts
import type { PlannerDraftResult, WorkflowDag, WorkflowLibrary } from "./types";

type V2Agent = {
  id?: string;
  name?: string;
  role?: string;
  domain?: string;
  defaultProfileRef?: string;
  profileResourcePath?: string;
};

type V2AgentLibrary = {
  agents?: V2Agent[];
};

export function workflowLibraryFromAgentLibrary(input: V2AgentLibrary): WorkflowLibrary {
  const agentsByDomain = new Map<string, V2Agent[]>();
  for (const agent of input.agents ?? []) {
    const domain = agent.domain ?? "software";
    agentsByDomain.set(domain, [...(agentsByDomain.get(domain) ?? []), agent]);
  }

  return {
    domains: Array.from(agentsByDomain.entries()).map(([domain, agents]) => ({
      id: domain,
      title: domain,
      workflowTemplates: [
        {
          id: `template.${domain}-feature`,
          title: `${domain} feature workflow`,
          description: "Southstar planner workflow",
          stageRefs: [],
        },
      ],
      agents: agents.map((agent) => ({
        id: agent.id ?? `agent.${agent.name ?? "unknown"}`,
        name: agent.name ?? agent.id ?? "unknown",
        role: agent.role ?? "maker",
        defaultProfileRef: agent.defaultProfileRef ?? agent.name ?? agent.id ?? "unknown",
        profileResourcePath: agent.profileResourcePath ?? `${domain}/agents/${agent.name ?? agent.id ?? "unknown"}/profile.json`,
      })),
    })),
  };
}

export function buildWorkflowDagFromPlannerDraft(draft: PlannerDraftResult): WorkflowDag {
  const levelByTask = new Map<string, number>();
  for (const task of draft.taskSummaries) {
    const dependencyLevels = task.dependsOn.map((id) => levelByTask.get(id) ?? 0);
    levelByTask.set(task.taskId, task.dependsOn.length ? Math.max(...dependencyLevels) + 1 : 0);
  }

  return {
    id: draft.draftId,
    templateId: draft.workflowId,
    templateTitle: draft.workflowId,
    prompt: draft.goalPrompt,
    expandedByDefault: true,
    readiness: draft.status === "validated" ? "ready" : "blocked",
    createdAt: new Date().toISOString(),
    nodes: draft.taskSummaries.map((task) => ({
      id: task.taskId,
      label: task.taskName,
      role: task.roleRef ?? "maker",
      agentRef: task.agentProfileRef ?? task.roleRef ?? "agent.unknown",
      profileRef: task.agentProfileRef ?? task.roleRef ?? "unknown",
      profileResourcePath: `${task.agentProfileRef ?? "unknown"}/profile.json`,
      provider: "southstar",
      model: "planner",
      level: levelByTask.get(task.taskId) ?? 0,
      state: draft.status === "validated" ? "ready" : "blocked",
    })),
    edges: draft.taskSummaries.flatMap((task) => task.dependsOn.map((from) => ({ from, to: task.taskId }))),
  };
}
```

- [ ] **Step 4: Re-align library route**

Modify `app/api/workflow/library/route.ts`:

- If `SOUTHSTAR_V2_API_BASE_URL` is configured, call `/api/v2/agent-library`.
- Convert the result with `workflowLibraryFromAgentLibrary`.
- Return `{ library, source: "southstar-v2" }`.
- Keep existing `loadWorkflowLibrary` fallback only when v2 is not configured, returning `{ library, source: "fixture-or-file" }`.

- [ ] **Step 5: Re-align generate route**

Modify `app/api/workflow/generate/route.ts`:

- If `SOUTHSTAR_V2_API_BASE_URL` is configured, call `/api/v2/planner/drafts` with `goalPrompt`, `orchestrationMode`, `composerMode`, `domainPackId`, and `cwd`.
- Convert the draft response with `buildWorkflowDagFromPlannerDraft`.
- Keep SSE event names `message`, `dag`, and `done` so current UI does not churn.
- Use the existing local `buildWorkflowDagProposal` only when v2 is not configured.

- [ ] **Step 6: Scope resources route**

Modify `app/api/workflow/resources/[...path]/route.ts`:

- Keep `GET` for local file/fixture reads because Southstar v2 has no raw resource content API.
- Keep `PUT` only for explicit local resource editing.
- Return a response field such as `source: "local-file"` so the UI can label this as local editing, not Southstar runtime state.

- [ ] **Step 7: Run route alignment tests**

Run:

```bash
npm run test:unit -- --test-name-pattern "workflowLibraryFromAgentLibrary|buildWorkflowDagFromPlannerDraft|workflow library"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/workflow/v2-library-adapter.ts app/api/workflow/library/route.ts app/api/workflow/generate/route.ts app/api/workflow/resources/[...path]/route.ts tests/unit/workflow-library.test.ts
git commit -m "feat: align workflow routes with southstar v2"
```

## Task 3: Add Pi-Web Workflow Lifecycle Routes

**Files:**
- Create: `app/api/workflow/status/route.ts`
- Create: `app/api/workflow/planner-drafts/route.ts`
- Create: `app/api/workflow/planner-drafts/[draftId]/revise/route.ts`
- Create: `app/api/workflow/planner-drafts/[draftId]/orchestration/route.ts`
- Create: `app/api/workflow/planner-drafts/[draftId]/runs/route.ts`
- Create: `app/api/workflow/runs/route.ts`
- Create: `app/api/workflow/runs/[runId]/route.ts`
- Create: `app/api/workflow/runs/[runId]/tasks/route.ts`
- Create: `app/api/workflow/runs/[runId]/execute/route.ts`
- Modify: `tests/unit/workflow-v2-api.test.ts`

- [ ] **Step 1: Add failing route tests**

Append to `tests/unit/workflow-v2-api.test.ts`:

```ts
test("workflow status route exposes v2 capabilities", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const { GET } = await import("../../app/api/workflow/status/route");
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    capabilities: {
      createDraft: true,
      validate: true,
      createRun: true,
      execute: true,
      run: true,
      postgres: true,
      v2Backend: true,
    },
  });
});

test("planner draft route proxies create draft to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ draftId: "draft-1", status: "validated" });
  }) as typeof fetch;

  const { POST } = await import("../../app/api/workflow/planner-drafts/route");
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts", {
    method: "POST",
    body: JSON.stringify({ goalPrompt: "make workflow" }),
  });

  const response = await POST(request);
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/planner/drafts");
  assert.deepEqual(await response.json(), { draftId: "draft-1", status: "validated" });
});

test("planner draft run route proxies materialization to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ runId: "run-1", taskIds: ["task-1"] });
  }) as typeof fetch;

  const route = await import("../../app/api/workflow/planner-drafts/[draftId]/runs/route");
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts/draft-1/runs", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });

  const response = await route.POST(request, { params: Promise.resolve({ draftId: "draft-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/planner/drafts/draft-1/runs");
  assert.deepEqual(await response.json(), { runId: "run-1", taskIds: ["task-1"] });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:unit -- --test-name-pattern "workflow status|planner draft route|planner draft run"
```

Expected: FAIL because route files do not exist.

- [ ] **Step 3: Add route files**

Use this implementation pattern for all proxy routes.

`app/api/workflow/status/route.ts`:

```ts
import { NextResponse } from "next/server";
import { workflowV2Capabilities } from "@/lib/workflow/v2-api";

export async function GET() {
  return NextResponse.json({ capabilities: workflowV2Capabilities() });
}
```

`app/api/workflow/planner-drafts/route.ts`:

```ts
import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "@/lib/workflow/v2-api";

export async function POST(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/planner/drafts");
}
```

For dynamic routes, always decode and re-encode the path segment:

```ts
import { NextRequest } from "next/server";
import { proxyWorkflowV2Json } from "@/lib/workflow/v2-api";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const { draftId } = await params;
  return proxyWorkflowV2Json(request, `/api/v2/planner/drafts/${encodeURIComponent(draftId)}/runs`);
}
```

Create the remaining routes with these exact mappings:

```text
POST app/api/workflow/planner-drafts/[draftId]/revise/route.ts -> /api/v2/planner/drafts/:draftId/revise
GET  app/api/workflow/planner-drafts/[draftId]/orchestration/route.ts -> /api/v2/planner/drafts/:draftId/orchestration
POST app/api/workflow/runs/route.ts -> /api/v2/runs
GET  app/api/workflow/runs/[runId]/route.ts -> /api/v2/runs/:runId
GET  app/api/workflow/runs/[runId]/tasks/route.ts -> /api/v2/runs/:runId/tasks
POST app/api/workflow/runs/[runId]/execute/route.ts -> /api/v2/runs/:runId/execute
```

- [ ] **Step 4: Run route tests**

Run:

```bash
npm run test:unit -- --test-name-pattern "workflow status|planner draft route|planner draft run"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/workflow/status app/api/workflow/planner-drafts app/api/workflow/runs tests/unit/workflow-v2-api.test.ts
git commit -m "feat: expose workflow lifecycle proxy routes"
```

## Task 4: Add Workflow Lifecycle State And Hook

**Files:**
- Modify: `lib/workflow/types.ts`
- Create: `lib/workflow/lifecycle.ts`
- Create: `hooks/useWorkflowLifecycle.ts`
- Create: `tests/unit/workflow-lifecycle.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Create `tests/unit/workflow-lifecycle.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildPlannerDraftRequest, workflowLifecycleReducer } from "../../lib/workflow/lifecycle";
import type { WorkflowDag } from "../../lib/workflow/types";

const dag: WorkflowDag = {
  id: "dag-1",
  templateId: "template.software-feature",
  templateTitle: "Software Feature Workflow",
  prompt: "Build API-aligned workflow UI",
  expandedByDefault: true,
  readiness: "ready",
  createdAt: "2026-06-27T00:00:00.000Z",
  nodes: [
    {
      id: "plan",
      label: "plan",
      role: "maker",
      agentRef: "agent.software-maker",
      profileRef: "software-maker-pi",
      profileResourcePath: "software/agents/software-maker/profile.json",
      provider: "pi",
      model: "pi-agent-default",
      level: 0,
      state: "ready",
    },
  ],
  edges: [],
};

test("buildPlannerDraftRequest maps dag to existing v2 planner contract", () => {
  assert.deepEqual(buildPlannerDraftRequest(dag, "/repo"), {
    cwd: "/repo",
    goalPrompt: "Build API-aligned workflow UI",
    orchestrationMode: "llm-constrained",
    composerMode: "llm-with-fixture-fallback",
    domainPackId: "software",
    libraryHints: {
      agentProfileRefs: ["software-maker-pi"],
    },
  });
});

test("workflowLifecycleReducer enables run only for validated draft", () => {
  const drafted = workflowLifecycleReducer({ phase: "file_draft" }, {
    type: "drafted",
    draft: {
      draftId: "draft-1",
      goalPrompt: "Build",
      workflowId: "wf-1",
      status: "invalid",
      validationIssues: [{ path: "workflow.tasks", message: "missing task" }],
      taskSummaries: [],
    },
  });
  assert.equal(drafted.phase, "planner_draft");
  assert.equal(drafted.canRun, false);

  const validated = workflowLifecycleReducer(drafted, {
    type: "validated",
    orchestration: {
      draftId: "draft-1",
      goalPrompt: "Build",
      workflowId: "wf-1",
      status: "validated",
      validationIssues: [],
      taskSummaries: [],
    },
  });
  assert.equal(validated.phase, "validated");
  assert.equal(validated.canRun, true);
});

test("workflowLifecycleReducer preserves created run when execute fails", () => {
  const runCreated = workflowLifecycleReducer({ phase: "running" }, {
    type: "run_created",
    run: { runId: "run-1", taskIds: ["task-1"] },
  });
  const executeFailed = workflowLifecycleReducer(runCreated, {
    type: "execute_failed",
    error: "scheduler unavailable",
  });
  assert.equal(executeFailed.phase, "run_created");
  assert.equal(executeFailed.run?.runId, "run-1");
  assert.equal(executeFailed.error, "scheduler unavailable");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:unit -- --test-name-pattern "buildPlannerDraftRequest|workflowLifecycleReducer"
```

Expected: FAIL because lifecycle modules do not exist.

- [ ] **Step 3: Add lifecycle types**

Add to `lib/workflow/types.ts`:

```ts
export type PlannerDraftValidationIssue = {
  path: string;
  message: string;
  code?: string;
};

export type PlannerDraftTaskSummary = {
  taskId: string;
  taskName: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
};

export type PlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: string;
  validationIssues: PlannerDraftValidationIssue[];
  taskSummaries: PlannerDraftTaskSummary[];
};

export type PlannerDraftOrchestrationView = PlannerDraftResult & {
  orchestrationSnapshot?: unknown;
  plannerTrace?: unknown;
  repairAttempts?: unknown;
};

export type WorkflowRunResult = {
  runId: string;
  taskIds: string[];
};

export type WorkflowExecuteResult = {
  status: string;
  runId?: string;
};

export type WorkflowLifecycleState = {
  phase: "file_draft" | "drafting" | "planner_draft" | "validating" | "validated" | "running" | "run_created" | "executing" | "blocked";
  draft?: PlannerDraftResult;
  orchestration?: PlannerDraftOrchestrationView;
  run?: WorkflowRunResult;
  execute?: WorkflowExecuteResult;
  error?: string;
  canRun?: boolean;
};
```

- [ ] **Step 4: Add pure lifecycle helpers**

Create `lib/workflow/lifecycle.ts`:

```ts
import type {
  PlannerDraftOrchestrationView,
  PlannerDraftResult,
  WorkflowExecuteResult,
  WorkflowDag,
  WorkflowLifecycleState,
  WorkflowRunResult,
} from "./types";

type LifecycleAction =
  | { type: "drafting" }
  | { type: "drafted"; draft: PlannerDraftResult }
  | { type: "validating" }
  | { type: "validated"; orchestration: PlannerDraftOrchestrationView }
  | { type: "running" }
  | { type: "run_created"; run: WorkflowRunResult }
  | { type: "executing" }
  | { type: "executed"; execute: WorkflowExecuteResult }
  | { type: "execute_failed"; error: string }
  | { type: "blocked"; error: string };

export function buildPlannerDraftRequest(dag: WorkflowDag, cwd?: string | null) {
  return {
    cwd: cwd ?? undefined,
    goalPrompt: dag.prompt,
    orchestrationMode: "llm-constrained" as const,
    composerMode: "llm-with-fixture-fallback" as const,
    domainPackId: dag.templateId.includes("software") ? "software" : undefined,
    libraryHints: {
      agentProfileRefs: Array.from(new Set(dag.nodes.map((node) => node.profileRef).filter(Boolean))),
    },
  };
}

export function workflowLifecycleReducer(
  state: WorkflowLifecycleState,
  action: LifecycleAction,
): WorkflowLifecycleState {
  if (action.type === "drafting") return { ...state, phase: "drafting", error: undefined };
  if (action.type === "drafted") {
    const canRun = action.draft.status === "validated";
    return { phase: canRun ? "validated" : "planner_draft", draft: action.draft, canRun };
  }
  if (action.type === "validating") return { ...state, phase: "validating", error: undefined };
  if (action.type === "validated") {
    const canRun = action.orchestration.status === "validated";
    return { ...state, phase: canRun ? "validated" : "planner_draft", orchestration: action.orchestration, canRun };
  }
  if (action.type === "running") return { ...state, phase: "running", error: undefined };
  if (action.type === "run_created") return { ...state, phase: "run_created", run: action.run, canRun: false };
  if (action.type === "executing") return { ...state, phase: "executing", error: undefined };
  if (action.type === "executed") return { ...state, phase: "executing", execute: action.execute, canRun: false };
  if (action.type === "execute_failed") return { ...state, phase: "run_created", error: action.error, canRun: false };
  return { ...state, phase: "blocked", error: action.error, canRun: false };
}
```

- [ ] **Step 5: Add client hook**

Create `hooks/useWorkflowLifecycle.ts`:

```ts
"use client";

import { useReducer } from "react";
import { buildPlannerDraftRequest, workflowLifecycleReducer } from "@/lib/workflow/lifecycle";
import type { PlannerDraftOrchestrationView, PlannerDraftResult, WorkflowDag, WorkflowExecuteResult, WorkflowRunResult } from "@/lib/workflow/types";

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function useWorkflowLifecycle(dag: WorkflowDag, cwd?: string | null) {
  const [state, dispatch] = useReducer(workflowLifecycleReducer, { phase: "file_draft" as const });

  const createDraft = async () => {
    dispatch({ type: "drafting" });
    try {
      const response = await fetch("/api/workflow/planner-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPlannerDraftRequest(dag, cwd)),
      });
      dispatch({ type: "drafted", draft: await readJson<PlannerDraftResult>(response) });
    } catch (error) {
      dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const validateDraft = async () => {
    if (!state.draft?.draftId) return;
    dispatch({ type: "validating" });
    try {
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/orchestration`);
      dispatch({ type: "validated", orchestration: await readJson<PlannerDraftOrchestrationView>(response) });
    } catch (error) {
      dispatch({ type: "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const runDraft = async () => {
    if (!state.draft?.draftId || !state.canRun) return;
    dispatch({ type: "running" });
    let createdRun: WorkflowRunResult | null = null;
    try {
      const orchestrationResponse = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/orchestration`);
      const orchestration = await readJson<PlannerDraftOrchestrationView>(orchestrationResponse);
      dispatch({ type: "validated", orchestration });
      if (orchestration.status !== "validated") {
        dispatch({ type: "blocked", error: "Planner draft is not validated" });
        return;
      }
      const response = await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(state.draft.draftId)}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      createdRun = await readJson<WorkflowRunResult>(response);
      dispatch({ type: "run_created", run: createdRun });
      dispatch({ type: "executing" });
      const executeResponse = await fetch(`/api/workflow/runs/${encodeURIComponent(createdRun.runId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      dispatch({ type: "executed", execute: await readJson<WorkflowExecuteResult>(executeResponse) });
    } catch (error) {
      dispatch({ type: createdRun ? "execute_failed" : "blocked", error: error instanceof Error ? error.message : String(error) });
    }
  };

  const retryExecute = async () => {
    if (!state.run?.runId) return;
    dispatch({ type: "executing" });
    try {
      const executeResponse = await fetch(`/api/workflow/runs/${encodeURIComponent(state.run.runId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      dispatch({ type: "executed", execute: await readJson<WorkflowExecuteResult>(executeResponse) });
    } catch (error) {
      dispatch({ type: "execute_failed", error: error instanceof Error ? error.message : String(error) });
    }
  };

  return { state, createDraft, validateDraft, runDraft, retryExecute };
}
```

- [ ] **Step 6: Run lifecycle tests**

Run:

```bash
npm run test:unit -- --test-name-pattern "buildPlannerDraftRequest|workflowLifecycleReducer"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/workflow/types.ts lib/workflow/lifecycle.ts hooks/useWorkflowLifecycle.ts tests/unit/workflow-lifecycle.test.ts
git commit -m "feat: add workflow lifecycle state"
```

## Task 5: Render DAG Arrows And Lifecycle Controls

**Files:**
- Create: `lib/workflow/dag-layout.ts`
- Create: `tests/unit/workflow-dag-layout.test.ts`
- Modify: `components/WorkflowDagBlock.tsx`
- Modify: `components/MessageView.tsx`
- Modify: `components/ChatWindow.tsx`

- [ ] **Step 1: Write failing DAG layout tests**

Create `tests/unit/workflow-dag-layout.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { layoutWorkflowDag } from "../../lib/workflow/dag-layout";
import type { WorkflowDag } from "../../lib/workflow/types";

function node(id: string, level: number) {
  return {
    id,
    label: id,
    role: "maker",
    agentRef: "agent.software-maker",
    profileRef: "software-maker-pi",
    profileResourcePath: "software/agents/software-maker/profile.json",
    provider: "pi",
    model: "pi-agent-default",
    level,
    state: "ready" as const,
  };
}

test("layoutWorkflowDag groups same-level nodes into parallel column", () => {
  const dag: WorkflowDag = {
    id: "dag-1",
    templateId: "template.software-feature",
    templateTitle: "Software",
    prompt: "Build",
    expandedByDefault: true,
    readiness: "ready",
    createdAt: "2026-06-27T00:00:00.000Z",
    nodes: [node("plan", 0), node("implement-a", 1), node("implement-b", 1), node("verify", 2)],
    edges: [
      { from: "plan", to: "implement-a" },
      { from: "plan", to: "implement-b" },
      { from: "implement-a", to: "verify" },
      { from: "implement-b", to: "verify" },
    ],
  };

  const layout = layoutWorkflowDag(dag);
  assert.equal(layout.columns.length, 3);
  assert.deepEqual(layout.columns[1]?.nodes.map((item) => item.node.id), ["implement-a", "implement-b"]);
  assert.equal(layout.arrows.length, 4);
  assert.match(layout.arrows[0]!.path, /^M /);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test:unit -- --test-name-pattern "layoutWorkflowDag"
```

Expected: FAIL because `lib/workflow/dag-layout.ts` does not exist.

- [ ] **Step 3: Add DAG layout helper**

Create `lib/workflow/dag-layout.ts`:

```ts
import type { WorkflowDag, WorkflowDagNode } from "./types";

const CARD_WIDTH = 154;
const CARD_HEIGHT = 94;
const COLUMN_GAP = 52;
const ROW_GAP = 18;

export type WorkflowDagLayoutNode = {
  node: WorkflowDagNode;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowDagLayout = {
  width: number;
  height: number;
  columns: Array<{ level: number; nodes: WorkflowDagLayoutNode[] }>;
  arrows: Array<{ from: string; to: string; path: string }>;
};

export function layoutWorkflowDag(dag: WorkflowDag): WorkflowDagLayout {
  const levels = Array.from(new Set(dag.nodes.map((node) => node.level))).sort((a, b) => a - b);
  const positioned = new Map<string, WorkflowDagLayoutNode>();
  const columns = levels.map((level, columnIndex) => {
    const nodes = dag.nodes
      .filter((node) => node.level === level)
      .map((node, rowIndex) => {
        const item = {
          node,
          x: columnIndex * (CARD_WIDTH + COLUMN_GAP),
          y: rowIndex * (CARD_HEIGHT + ROW_GAP),
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        };
        positioned.set(node.id, item);
        return item;
      });
    return { level, nodes };
  });

  const maxRows = Math.max(1, ...columns.map((column) => column.nodes.length));
  const width = Math.max(CARD_WIDTH, columns.length * CARD_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP);
  const height = Math.max(CARD_HEIGHT, maxRows * CARD_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP);
  const arrows = dag.edges.flatMap((edge) => {
    const from = positioned.get(edge.from);
    const to = positioned.get(edge.to);
    if (!from || !to) return [];
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const midX = startX + Math.max(22, (endX - startX) / 2);
    return [{ from: edge.from, to: edge.to, path: `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}` }];
  });

  return { width, height, columns, arrows };
}
```

- [ ] **Step 4: Update DAG block**

Modify `components/WorkflowDagBlock.tsx`:

- Add a `cwd?: string | null` prop.
- Use `useWorkflowLifecycle(dag, cwd)`.
- Add header buttons on the right: `Draft`, `Validate`, `Run`.
- Call `window.confirm` before Draft and Run because both can write to Postgres-backed runtime resources.
- Make the Run confirmation explicit that it validates, creates run rows, and starts execution.
- Draw SVG arrows under absolutely positioned node cards.
- Keep node cards clickable for right file viewer.

Use this shape for the action button handlers:

```ts
const handleDraft = () => {
  if (!window.confirm("Create a Southstar planner draft in Postgres for this DAG?")) return;
  void createDraft();
};

const handleValidate = () => {
  void validateDraft();
};

const handleRun = () => {
  if (!window.confirm("Validate this planner draft, create workflow run rows, and start execution?")) return;
  void runDraft();
};
```

Add test ids:

```text
workflow-action-draft
workflow-action-validate
workflow-action-run
workflow-dag-arrow
workflow-lifecycle-notice
workflow-execute-retry
```

If `state.phase === "run_created"` and `state.error` is present after execute failure, show the `runId`, the error, and a retry execute button with `data-testid="workflow-execute-retry"`. The retry button calls `retryExecute()` and updates the lifecycle notice.

- [ ] **Step 5: Pass cwd through message rendering**

Modify `components/ChatWindow.tsx` and `components/MessageView.tsx` so every `WorkflowDagBlock` receives the current `workflowCwd`.

Required prop threading:

```ts
// ChatWindow -> MessageView
workflowCwd={workflowCwd}

// MessageView props
workflowCwd?: string | null;

// BlockView / CustomMessageView -> WorkflowDagBlock
<WorkflowDagBlock dag={...} cwd={workflowCwd} onNodeSelect={onWorkflowDagNodeSelect} />
```

- [ ] **Step 6: Run DAG tests**

Run:

```bash
npm run test:unit -- --test-name-pattern "layoutWorkflowDag|buildPlannerDraftRequest|workflowLifecycleReducer"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/workflow/dag-layout.ts tests/unit/workflow-dag-layout.test.ts components/WorkflowDagBlock.tsx components/MessageView.tsx components/ChatWindow.tsx
git commit -m "feat: add workflow dag lifecycle controls"
```

## Task 6: Finish Requested UI Layout Fixes

**Files:**
- Modify: `components/AppShell.tsx`
- Modify: `components/AppModeRail.tsx`
- Modify: `components/BranchNavigator.tsx`
- Modify: `components/WorkflowSidebar.tsx`
- Modify: `components/StructuredJsonEditor.tsx`
- Modify: `components/WorkflowResourceViewer.tsx`

- [ ] **Step 1: Move mode rail into top bar**

In `components/AppShell.tsx`:

- Remove `<AppModeRail ... />` from `sidebarContent`.
- Add `<AppModeRail mode={appMode} onModeChange={setAppMode} orientation="horizontal" />` immediately after the theme button in the top bar.
- Remove the System button and `activeTopPanel === "system"` dropdown from this layout pass.
- Keep system prompt state plumbing only if required by `ChatWindow`; do not render the top-bar System control.
- For Export, remove the visible `<span>Export</span>` and keep `title` / `aria-label`.
- Pass `iconOnly` to `BranchNavigator`.

Expected top-bar order:

```text
sidebar toggle | theme | Chat Workflow Operator tabs | Export icon | Branch icon | session stats
```

- [ ] **Step 2: Fix AppModeRail typing**

In `components/AppModeRail.tsx`, import `ReactNode` and replace `JSX.Element`:

```ts
import type { ReactNode } from "react";

const MODES: Array<{
  id: AppMode;
  label: string;
  title: string;
  icon: ReactNode;
}> = [
```

- [ ] **Step 3: Finish BranchNavigator icon-only trigger**

In `components/BranchNavigator.tsx`, when `inline && iconOnly`, the trigger button should render only the branch SVG and keep `title="Branches"` / `aria-label="Branches"`.

Required visible behavior:

```ts
{!iconOnly && <span>Branch</span>}
```

- [ ] **Step 4: Finish collapsible workflow tree**

In `components/WorkflowSidebar.tsx`, ensure the top-level sections can collapse:

```text
Workflow Templates
Agent Profiles
```

Required test ids:

```text
workflow-template-section-toggle
workflow-agent-section-toggle
workflow-template-tree
workflow-agent-tree
```

Keep initial state expanded. Replace any text disclosure glyphs with inline SVG chevrons to keep the file ASCII and visually consistent.

- [ ] **Step 5: Fix read-only JSON truncation**

In `components/StructuredJsonEditor.tsx`, when `readOnly` is true and JSON parses, render a complete formatted JSON `<pre>` instead of the structured field grid plus textarea:

```tsx
if (readOnly && parsed) {
  return (
    <pre
      data-testid="json-readonly-pre"
      style={{
        height: "100%",
        minHeight: 0,
        overflow: "auto",
        margin: 0,
        padding: 14,
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {JSON.stringify(parsed, null, 2)}
    </pre>
  );
}
```

Keep edit mode unchanged.

- [ ] **Step 6: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add components/AppShell.tsx components/AppModeRail.tsx components/BranchNavigator.tsx components/WorkflowSidebar.tsx components/StructuredJsonEditor.tsx components/WorkflowResourceViewer.tsx
git commit -m "style: align workflow ui layout"
```

## Task 7: Add Browser E2E Coverage

**Files:**
- Modify: `tests/e2e/workflow-mode.spec.ts`

- [ ] **Step 1: Add E2E tests**

Append these tests to `tests/e2e/workflow-mode.spec.ts`:

```ts
test("workflow mode uses top tabs and icon-only export branch controls", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app-mode-rail")).toBeVisible();
  await expect(page.getByTestId("mode-chat")).toBeVisible();
  await expect(page.getByTestId("mode-workflow")).toBeVisible();
  await expect(page.getByTestId("mode-operator")).toBeVisible();
  await expect(page.getByText("System")).toHaveCount(0);
  await expect(page.getByText("Export")).toHaveCount(0);
  await expect(page.getByText("Branch")).toHaveCount(0);
});

test("workflow tree sections collapse and expand", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mode-workflow").click();
  await expect(page.getByTestId("workflow-template-tree")).toBeVisible();
  await page.getByTestId("workflow-template-section-toggle").click();
  await expect(page.getByTestId("workflow-template-tree")).toHaveCount(0);
  await page.getByTestId("workflow-template-section-toggle").click();
  await expect(page.getByTestId("workflow-template-tree")).toBeVisible();
});

test("generated workflow dag shows arrows and lifecycle buttons", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mode-workflow").click();
  await page.getByTestId("chat-input").fill("Build a small API aligned workflow");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workflow-dag-block")).toBeVisible();
  await expect(page.getByTestId("workflow-dag-arrow").first()).toBeVisible();
  await expect(page.getByTestId("workflow-action-draft")).toBeVisible();
  await expect(page.getByTestId("workflow-action-validate")).toBeVisible();
  await expect(page.getByTestId("workflow-action-run")).toBeVisible();
});

test("workflow json viewer shows full readonly json", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("mode-workflow").click();
  await page.getByTestId("chat-input").fill("Build a workflow");
  await page.keyboard.press("Enter");
  await page.getByTestId("workflow-dag-node-understand").click();
  await expect(page.getByTestId("workflow-resource-viewer")).toBeVisible();
  await expect(page.getByTestId("json-readonly-pre")).toContainText("provider");
  await expect(page.getByTestId("json-readonly-pre")).toContainText("model");
});
```

If the generated first node id differs from `understand`, update only the selector to the first current fixture node id shown by `buildWorkflowDagProposal`.

- [ ] **Step 2: Run E2E tests in Chromium**

Run:

```bash
npm run test:e2e -- --project=chromium tests/e2e/workflow-mode.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run test:unit
npm run test:e2e -- --project=chromium tests/e2e/workflow-mode.spec.ts
npm run lint
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/workflow-mode.spec.ts
git commit -m "test: cover workflow api aligned ui"
```

## Self-Review Checklist

- [ ] Spec coverage: v2 API alignment is covered by Tasks 1-4; UI layout, tree, DAG arrows, lifecycle buttons, JSON viewer, and browser verification are covered by Tasks 5-7.
- [ ] Placeholder scan: this plan intentionally contains no unresolved placeholder steps.
- [ ] Type consistency: lifecycle type names match the planned `lib/workflow/types.ts` additions.
- [ ] API consistency: this plan uses Southstar v2 planner drafts, runs, and execute routes instead of a separate pi-web sync or definition-version route.
- [ ] Verification: unit, E2E, and lint commands are explicit.

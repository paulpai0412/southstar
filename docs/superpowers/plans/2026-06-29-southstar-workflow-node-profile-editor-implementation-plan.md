# Southstar Workflow Node Profile Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-panel editor for per-node workflow agent profile overrides in the 30141 Pi Agent Web UI.

**Architecture:** Persist node overrides on planner draft tasks through a v2 runtime PATCH endpoint, expose the effective values through the workflow UI read model, proxy those APIs through `web/app/api/workflow`, and render a focused editor tab in `web/components/AppShell.tsx`. Runtime DAGs are read-only; draft DAGs are editable.

**Tech Stack:** Node.js `node:test`, TypeScript, Next.js App Router route handlers, React 19 client components, Southstar v2 Postgres runtime resources.

## Implementation Status

Status as of 2026-06-29: implemented and target-verified.

- Backend draft task profile override persistence is implemented.
- Runtime API and 30141 `web/app/api/workflow` proxy routes are implemented.
- Workflow UI read model exposes editable draft profile overrides and effective profile values.
- The 30141 right panel opens `WorkflowNodeProfileEditor` for DAG nodes with draft/run context.
- Save/reset, provider, model, thinking mode, instruction, skill refs, and MCP refs are implemented.
- Run creation now materializes node overrides into a task-specific runtime agent profile, task snapshot, context packet, and task envelope.
- Runtime DAG nodes remain read-only in the editor.

Verified:

- `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts`
- `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres node_modules/.bin/tsx tests/v2/runtime-api-client-alignment.test.ts`
- `SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres node_modules/.bin/tsx tests/v2/workflow-ui-read-model.test.ts`
- `node_modules/.bin/tsx tests/unit/workflow-v2-api.test.ts`
- `node_modules/.bin/tsx tests/unit/workflow-node-profile.test.ts`
- `node_modules/.bin/tsx tests/web/workflow-node-profile-editor-ui.test.tsx`
- `npm --prefix web run build`

Browser smoke note: `http://127.0.0.1:30141/` resolves to `/home/timmypai/apps/southstar/web`; the live tab was in a no-session placeholder state, so the actual DAG click path was verified through code wiring, read-model/API tests, and build rather than by mutating the user's current UI session.

---

## File Structure

- Create `src/v2/ui-api/planner-draft-task-overrides.ts`
  - Runtime-side pure validation and persistence for task profile overrides.

- Modify `src/v2/domain-packs/types.ts`
  - Add `AgentProvider` and `PlannerDraftTaskProfileOverride` exported types.

- Modify `src/v2/ui-api/postgres-run-api.ts`
  - Export `patchPostgresPlannerDraftTaskProfileOverride`.
  - Ensure run materialization merges override skill/MCP/profile fields before task envelopes are built.

- Modify `src/v2/read-models/workflow-ui.ts`
  - Include `profileOverride`, `effectiveProfile`, and `editable` on `selectedDefinition`.

- Modify `src/v2/server/routes.ts`
  - Add `PATCH /api/v2/planner/drafts/:draftId/tasks/:taskId/profile-override`.

- Modify `src/v2/server/client.ts` and `lib/southstar/api-client.ts`
  - Add client methods for profile override patching.

- Create `web/app/api/workflow/ui/route.ts`
  - Proxy to `/api/v2/ui/workflow`.

- Create `web/app/api/workflow/agent-library/candidates/route.ts`
  - Proxy to `/api/v2/agent-library/candidates`.

- Create `web/app/api/workflow/planner-drafts/[draftId]/tasks/[taskId]/profile-override/route.ts`
  - Proxy PATCH to the runtime API.

- Create `web/lib/workflow/node-profile.ts`
  - Browser-side form normalization, validation, and payload construction.

- Create `web/components/WorkflowNodeProfileEditor.tsx`
  - Right panel editor for selected DAG node profile overrides.

- Modify `web/lib/types.ts` or `web/components/AppShell.tsx` local tab typing
  - Add `workflowNodeProfile` tab kind with `draftId`, `runId`, `taskId`, and `mode`.

- Modify `web/components/AppShell.tsx`
  - On DAG node click, open `Node Profile` tab when the node has draft/run context.
  - Keep `profile.json` fallback only for legacy nodes without persisted draft context.

- Modify `web/components/MessageView.tsx` and DAG block types as needed
  - Pass richer selection context from DAG messages to `AppShell`.

- Tests:
  - `tests/v2/postgres-run-api.test.ts`
  - `tests/v2/workflow-ui-read-model.test.ts`
  - `tests/v2/runtime-api-client-alignment.test.ts`
  - `tests/unit/workflow-v2-api.test.ts`
  - New `tests/unit/workflow-node-profile.test.ts`
  - Existing browser test can be extended after the API/UI path is green.

## Task 1: Backend Task Override Persistence

**Files:**
- Modify: `src/v2/domain-packs/types.ts`
- Create: `src/v2/ui-api/planner-draft-task-overrides.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Test: `tests/v2/postgres-run-api.test.ts`

- [ ] **Step 1: Write the failing persistence test**

Add a test to `tests/v2/postgres-run-api.test.ts`:

```ts
test("Postgres planner draft task profile override updates one task without changing other tasks", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });

    const result = await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Use the smallest patch and include test evidence.",
        skillRefs: ["software.calc-cli", "software.test-evidence"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
    });

    assert.equal(result.draftId, draft.draftId);
    assert.equal(result.taskId, "implement-feature");
    assert.equal(result.status, "validated");
    assert.deepEqual(result.profileOverride.skillRefs, ["software.calc-cli", "software.test-evidence"]);

    const row = await db.one<{ payload_json: { workflow: { tasks: any[] } } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    const implement = row.payload_json.workflow.tasks.find((task) => task.id === "implement-feature");
    const verify = row.payload_json.workflow.tasks.find((task) => task.id === "verify-feature");
    assert.equal(implement.profileOverride.model, "gpt-5-codex");
    assert.deepEqual(implement.skillRefs, ["software.calc-cli", "software.test-evidence"]);
    assert.deepEqual(implement.mcpGrantRefs, ["filesystem-workspace"]);
    assert.equal(verify.profileOverride, undefined);
  });
});
```

Update the import:

```ts
import {
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
} from "../../src/v2/ui-api/postgres-run-api.ts";
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because `patchPostgresPlannerDraftTaskProfileOverride` is not exported.

- [ ] **Step 3: Add backend types and persistence implementation**

Add to `src/v2/domain-packs/types.ts`:

```ts
export type AgentProvider = "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";

export type PlannerDraftTaskProfileOverride = {
  provider?: AgentProvider;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
};
```

Create `src/v2/ui-api/planner-draft-task-overrides.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import type { AgentProvider, PlannerDraftTaskProfileOverride } from "../domain-packs/types.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

const allowedProviders = new Set<AgentProvider>(["pi", "codex", "claude-code", "openai", "anthropic", "custom"]);

export type PatchPlannerDraftTaskProfileOverrideInput = {
  draftId: string;
  taskId: string;
  profileOverride: PlannerDraftTaskProfileOverride;
};

export type PatchPlannerDraftTaskProfileOverrideResult = {
  draftId: string;
  taskId: string;
  status: string;
  profileOverride: PlannerDraftTaskProfileOverride;
};

export async function patchPlannerDraftTaskProfileOverridePg(
  db: SouthstarDb,
  input: PatchPlannerDraftTaskProfileOverrideInput,
): Promise<PatchPlannerDraftTaskProfileOverrideResult> {
  const draft = await getResourceByKeyPg(db, "planner_draft", input.draftId);
  if (!draft) throw new Error(`planner draft not found: ${input.draftId}`);

  const payload = asRecord(draft.payload);
  const workflow = asRecord(payload.workflow);
  const tasks = Array.isArray(workflow.tasks) ? workflow.tasks.map((task) => asRecord(task)) : [];
  const taskIndex = tasks.findIndex((task) => task.id === input.taskId);
  if (taskIndex < 0) throw new Error(`planner draft task not found: ${input.taskId}`);

  const profileOverride = normalizeProfileOverride(input.profileOverride);
  const nextTask = {
    ...tasks[taskIndex],
    profileOverride,
    ...(profileOverride.skillRefs !== undefined ? { skillRefs: profileOverride.skillRefs } : {}),
    ...(profileOverride.mcpGrantRefs !== undefined ? { mcpGrantRefs: profileOverride.mcpGrantRefs } : {}),
  };
  const nextTasks = [...tasks];
  nextTasks[taskIndex] = nextTask;
  const nextPayload = {
    ...payload,
    workflow: {
      ...workflow,
      tasks: nextTasks,
    },
  };

  await upsertRuntimeResourcePg(db, {
    id: input.draftId,
    resourceType: "planner_draft",
    resourceKey: input.draftId,
    scope: draft.scope ?? "planner",
    status: draft.status,
    payload: nextPayload,
    summary: draft.summary,
  });

  return {
    draftId: input.draftId,
    taskId: input.taskId,
    status: draft.status,
    profileOverride,
  };
}

function normalizeProfileOverride(input: PlannerDraftTaskProfileOverride): PlannerDraftTaskProfileOverride {
  const output: PlannerDraftTaskProfileOverride = {};
  if (input.provider !== undefined) {
    if (!allowedProviders.has(input.provider)) throw new Error(`unsupported provider: ${input.provider}`);
    output.provider = input.provider;
  }
  if (input.model !== undefined) output.model = nonEmptyString(input.model, "model");
  if (input.thinkingLevel !== undefined) output.thinkingLevel = nonEmptyString(input.thinkingLevel, "thinkingLevel");
  if (input.instruction !== undefined) output.instruction = input.instruction.trim();
  if (input.skillRefs !== undefined) output.skillRefs = stringArray(input.skillRefs, "skillRefs");
  if (input.mcpGrantRefs !== undefined) output.mcpGrantRefs = stringArray(input.mcpGrantRefs, "mcpGrantRefs");
  return output;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
```

Export from `src/v2/ui-api/postgres-run-api.ts`:

```ts
export {
  patchPlannerDraftTaskProfileOverridePg as patchPostgresPlannerDraftTaskProfileOverride,
  type PatchPlannerDraftTaskProfileOverrideInput,
  type PatchPlannerDraftTaskProfileOverrideResult,
} from "./planner-draft-task-overrides.ts";
```

- [ ] **Step 4: Run the persistence test**

Run:

```bash
npm run test:v2 -- tests/v2/postgres-run-api.test.ts
```

Expected: PASS for the new test and existing tests.

## Task 2: Runtime Route and Client API

**Files:**
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `lib/southstar/api-client.ts`
- Test: `tests/v2/runtime-api-client-alignment.test.ts`

- [ ] **Step 1: Write failing route/client tests**

Add to `tests/v2/runtime-api-client-alignment.test.ts` client method lists:

```ts
"patchPlannerDraftTaskProfileOverride",
```

Add a route test:

```ts
test("runtime route patches planner draft task profile override", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-profile-override-route";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-profile-override-route",
          tasks: [{ id: "task-build", name: "Build", dependsOn: [], skillRefs: [] }],
        },
      },
      summary: { goalPrompt: "profile override route", workflowId: "wf-profile-override-route" },
    });

    const envelope = await call<any>(db, `/api/v2/planner/drafts/${draftId}/tasks/task-build/profile-override`, {
      method: "PATCH",
      body: JSON.stringify({ provider: "codex", model: "gpt-5-codex", skillRefs: ["software.calc-cli"], mcpGrantRefs: [] }),
    });

    assert.equal(envelope.kind, "planner-draft-task-profile-override");
    assert.equal(envelope.result.taskId, "task-build");
    assert.equal(envelope.result.profileOverride.model, "gpt-5-codex");
  } finally {
    await db.close();
  }
});
```

If the local `call` helper currently only accepts a path, extend it in the test file to accept `RequestInit`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/runtime-api-client-alignment.test.ts
```

Expected: FAIL because route and client methods are missing.

- [ ] **Step 3: Implement route and clients**

In `src/v2/server/routes.ts`, import:

```ts
import { patchPostgresPlannerDraftTaskProfileOverride } from "../ui-api/postgres-run-api.ts";
```

Add before generic fallthrough:

```ts
const profileOverrideMatch = url.pathname.match(/^\/api\/v2\/planner\/drafts\/([^/]+)\/tasks\/([^/]+)\/profile-override$/);
if (request.method === "PATCH" && profileOverrideMatch) {
  return json("planner-draft-task-profile-override", await patchPostgresPlannerDraftTaskProfileOverride(context.db, {
    draftId: decodeURIComponent(profileOverrideMatch[1]!),
    taskId: decodeURIComponent(profileOverrideMatch[2]!),
    profileOverride: await readJsonBody<any>(request),
  }));
}
```

Add methods in `src/v2/server/client.ts` and `lib/southstar/api-client.ts`:

```ts
patchPlannerDraftTaskProfileOverride(draftId: string, taskId: string, profileOverride: unknown): Promise<any> {
  return patch(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/tasks/${encodeURIComponent(taskId)}/profile-override`, profileOverride);
}
```

If a `patch` helper does not exist, add it next to `post`:

```ts
async function patch<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(response);
}
```

- [ ] **Step 4: Run route/client test**

Run:

```bash
npm run test:v2 -- tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS.

## Task 3: Workflow UI Read Model Exposes Editable Effective Profile

**Files:**
- Modify: `src/v2/read-models/workflow-ui.ts`
- Test: `tests/v2/workflow-ui-read-model.test.ts`

- [ ] **Step 1: Write failing read model test**

Add:

```ts
test("workflow ui draft selected definition exposes editable profile override and effective profile", async () => {
  const db = await createTestPostgresDb();
  try {
    const draftId = "draft-workflow-profile-override";
    await upsertRuntimeResourcePg(db, {
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      payload: {
        workflow: {
          workflowId: "wf-profile-override",
          domain: "software",
          tasks: [{
            id: "task-build",
            name: "Build",
            dependsOn: [],
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            skillRefs: ["software.calc-cli"],
            mcpGrantRefs: [],
            profileOverride: {
              provider: "codex",
              model: "gpt-5-codex",
              thinkingLevel: "high",
              instruction: "Use small patches.",
              skillRefs: ["software.calc-cli", "software.test-evidence"],
              mcpGrantRefs: ["filesystem-workspace"],
            },
          }],
        },
      },
      summary: { goalPrompt: "profile override read model", workflowId: "wf-profile-override" },
    });

    const model = await buildWorkflowUiReadModelPg(db, { draftId, taskId: "task-build" });

    assert.equal(model.selectedDefinition?.editable, true);
    assert.equal((model.selectedDefinition as any).profileOverride.model, "gpt-5-codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.model, "gpt-5-codex");
    assert.equal((model.selectedDefinition as any).effectiveProfile.provider, "codex");
    assert.deepEqual((model.selectedDefinition as any).effectiveProfile.skillRefs, ["software.calc-cli", "software.test-evidence"]);
    assert.deepEqual(model.selectedDefinition?.skillRefs, ["software.calc-cli", "software.test-evidence"]);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/workflow-ui-read-model.test.ts
```

Expected: FAIL because `editable`, `profileOverride`, and `effectiveProfile` are missing.

- [ ] **Step 3: Implement read model fields**

In `WorkflowTaskDefinitionSummary`, add:

```ts
profileOverride?: unknown;
effectiveProfile?: {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
};
editable: boolean;
```

When building draft selected definition, read `selectedTask.profileOverride`, merge it with `selectedTask.agentProfile` details, and return `editable: true`.

When building runtime selected definition, return `editable: false` and build `effectiveProfile` from the materialized envelope or workflow task refs.

- [ ] **Step 4: Run read model test**

Run:

```bash
npm run test:v2 -- tests/v2/workflow-ui-read-model.test.ts
```

Expected: PASS.

## Task 4: Web API Proxy Routes

**Files:**
- Create: `web/app/api/workflow/ui/route.ts`
- Create: `web/app/api/workflow/agent-library/candidates/route.ts`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/tasks/[taskId]/profile-override/route.ts`
- Test: `tests/unit/workflow-v2-api.test.ts`

- [ ] **Step 1: Write failing proxy tests**

Add tests asserting:

```ts
test("workflow ui route proxy maps to v2 ui workflow", async () => {
  const { GET } = await import("../../web/app/api/workflow/ui/route");
  const request = new NextRequest("http://localhost/api/workflow/ui?draftId=draft-1&taskId=task-a");
  const response = await GET(request);
  assert.equal(response.status, 200);
  assert.equal(lastFetchUrl(), "http://127.0.0.1:3000/api/v2/ui/workflow?draftId=draft-1&taskId=task-a");
});
```

Add equivalent tests for candidates and PATCH profile override using the existing mock fetch helpers in `tests/unit/workflow-v2-api.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/unit/workflow-v2-api.test.ts
```

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement proxy routes**

Each route should use `proxyWorkflowV2Json`.

`web/app/api/workflow/ui/route.ts`:

```ts
import { proxyWorkflowV2Json } from "@/lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/ui/workflow");
}
```

`web/app/api/workflow/agent-library/candidates/route.ts`:

```ts
import { proxyWorkflowV2Json } from "@/lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  return proxyWorkflowV2Json(request, "/api/v2/agent-library/candidates");
}
```

`web/app/api/workflow/planner-drafts/[draftId]/tasks/[taskId]/profile-override/route.ts`:

```ts
import { proxyWorkflowV2Json } from "@/lib/workflow/v2-api";
import type { NextRequest } from "next/server";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ draftId: string; taskId: string }> },
) {
  const { draftId, taskId } = await context.params;
  return proxyWorkflowV2Json(
    request,
    `/api/v2/planner/drafts/${encodeURIComponent(draftId)}/tasks/${encodeURIComponent(taskId)}/profile-override`,
  );
}
```

- [ ] **Step 4: Run proxy tests**

Run:

```bash
npm test -- tests/unit/workflow-v2-api.test.ts
```

Expected: PASS.

## Task 5: Web Node Profile Form Helpers

**Files:**
- Create: `web/lib/workflow/node-profile.ts`
- Test: `tests/unit/workflow-node-profile.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `tests/unit/workflow-node-profile.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildNodeProfilePatchPayload, normalizeNodeProfileForm } from "../../web/lib/workflow/node-profile";

test("normalizeNodeProfileForm prefers effective profile and preserves selected refs", () => {
  const form = normalizeNodeProfileForm({
    selectedDefinition: {
      taskId: "task-build",
      taskName: "Build",
      agentProfileRef: "software-maker-pi",
      skillRefs: ["software.calc-cli"],
      mcpGrantRefs: [],
      effectiveProfile: {
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Use tests.",
        skillRefs: ["software.calc-cli", "software.test-evidence"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
      editable: true,
    },
  });

  assert.equal(form.provider, "codex");
  assert.equal(form.model, "gpt-5-codex");
  assert.equal(form.thinkingLevel, "high");
  assert.deepEqual(form.skillRefs, ["software.calc-cli", "software.test-evidence"]);
});

test("buildNodeProfilePatchPayload trims and de-duplicates arrays", () => {
  assert.deepEqual(buildNodeProfilePatchPayload({
    provider: "codex",
    model: " gpt-5-codex ",
    thinkingLevel: " high ",
    instruction: " Use tests. ",
    skillRefs: ["software.calc-cli", "software.calc-cli", ""],
    mcpGrantRefs: ["filesystem-workspace", " "],
  }), {
    provider: "codex",
    model: "gpt-5-codex",
    thinkingLevel: "high",
    instruction: "Use tests.",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: ["filesystem-workspace"],
  });
});
```

Import this test from `tests/index.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/unit/workflow-node-profile.test.ts
```

Expected: FAIL because helper file does not exist.

- [ ] **Step 3: Implement helpers**

Implement:

```ts
export type WorkflowNodeProfileForm = {
  provider: string;
  model: string;
  thinkingLevel: string;
  instruction: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
};

export function normalizeNodeProfileForm(input: { selectedDefinition?: any | null }): WorkflowNodeProfileForm {
  const selected = input.selectedDefinition ?? {};
  const effective = selected.effectiveProfile ?? {};
  return {
    provider: stringValue(effective.provider ?? selected.agentProfile?.provider),
    model: stringValue(effective.model ?? selected.agentProfile?.model),
    thinkingLevel: stringValue(effective.thinkingLevel),
    instruction: stringValue(effective.instruction),
    skillRefs: stringArray(effective.skillRefs ?? selected.skillRefs),
    mcpGrantRefs: stringArray(effective.mcpGrantRefs ?? selected.mcpGrantRefs),
  };
}

export function buildNodeProfilePatchPayload(form: WorkflowNodeProfileForm) {
  return {
    ...(clean(form.provider) ? { provider: clean(form.provider) } : {}),
    ...(clean(form.model) ? { model: clean(form.model) } : {}),
    ...(clean(form.thinkingLevel) ? { thinkingLevel: clean(form.thinkingLevel) } : {}),
    instruction: clean(form.instruction),
    skillRefs: dedupe(form.skillRefs),
    mcpGrantRefs: dedupe(form.mcpGrantRefs),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clean(value: string): string {
  return value.trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}
```

- [ ] **Step 4: Run helper tests**

Run:

```bash
npm test -- tests/unit/workflow-node-profile.test.ts
```

Expected: PASS.

## Task 6: Right Panel Editor UI

**Files:**
- Create: `web/components/WorkflowNodeProfileEditor.tsx`
- Modify: `web/components/AppShell.tsx`
- Modify: `web/lib/types.ts` or local `Tab` typing
- Test: static/render tests as locally feasible

- [ ] **Step 1: Add failing static test**

Add a test to a suitable web test file or create `tests/web/workflow-node-profile-editor-ui.test.tsx` that reads source files and asserts:

```ts
assert.match(appShellSource, /workflowNodeProfile/);
assert.match(appShellSource, /WorkflowNodeProfileEditor/);
assert.match(editorSource, /data-testid="workflow-node-profile-editor"/);
assert.match(editorSource, /data-testid="workflow-node-profile-save"/);
assert.match(editorSource, /data-testid="workflow-node-profile-reset"/);
```

Import it from `tests/index.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/web/workflow-node-profile-editor-ui.test.tsx
```

Expected: FAIL because component and tab path do not exist.

- [ ] **Step 3: Implement editor**

`WorkflowNodeProfileEditor` props:

```ts
type WorkflowNodeProfileEditorProps = {
  draftId?: string;
  runId?: string;
  taskId: string;
  mode: "draft" | "runtime";
};
```

Behavior:

- Fetch `/api/workflow/ui` with `draftId/runId/taskId`.
- Fetch `/api/workflow/agent-library/candidates` only when `draftId` exists.
- Render select/input/textarea/list controls.
- Disable editing when `mode !== "draft"` or `selectedDefinition.editable === false`.
- `Save` PATCHes `/api/workflow/planner-drafts/:draftId/tasks/:taskId/profile-override`.
- `Reset` reloads server state.

- [ ] **Step 4: Wire AppShell tab**

Change `handleWorkflowDagNodeSelect` so persisted nodes open:

```ts
const tabId = `workflow-node-profile:${draftId ?? runId}:${taskId}`;
```

Fallback to `handleOpenWorkflowResource(node.profileResourcePath, "profile.json")` only when no draft/run/task context exists.

- [ ] **Step 5: Run web/static tests**

Run:

```bash
npm test -- tests/web/workflow-node-profile-editor-ui.test.tsx
```

Expected: PASS.

## Task 7: Rich DAG Selection Context

**Files:**
- Modify: `web/lib/workflow/types.ts`
- Modify: `web/components/WorkflowDagBlock.tsx`
- Modify: `web/components/MessageView.tsx`
- Modify: workflow generation message code if it creates DAG details

- [ ] **Step 1: Write failing static/unit test**

Add assertions that `WorkflowDagNode` or the selection callback carries `draftId`, `runId`, `taskId`, and `mode`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/unit/workflow-library.test.ts
```

Expected: FAIL until context fields are mapped.

- [ ] **Step 3: Map context fields**

Add optional fields to `WorkflowDag` and/or `WorkflowDagNode`:

```ts
draftId?: string;
runId?: string;
taskId?: string;
mode?: "draft" | "runtime";
```

When building a DAG from planner draft orchestration, set `dag.draftId = input.draftId` and node `taskId = task.taskId`.

When React Flow DAG block lands, use the read-model native `canvasModel.graphId` and mode instead.

- [ ] **Step 4: Run mapping tests**

Run:

```bash
npm test -- tests/unit/workflow-library.test.ts
```

Expected: PASS.

## Task 8: Run Materialization Consumes Overrides

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Test: `tests/v2/postgres-run-api.test.ts`

- [ ] **Step 1: Write failing run materialization test**

Add a test that patches `implement-feature`, creates a run, and asserts the run manifest/task snapshot/envelope source includes the patched model, skill refs, and MCP refs.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:v2 -- tests/v2/postgres-run-api.test.ts
```

Expected: FAIL if materialization ignores `profileOverride`.

- [ ] **Step 3: Merge overrides before run creation**

In the draft-to-run path, when iterating workflow tasks, apply:

```ts
const profileOverride = asRecord(task.profileOverride);
const taskForRun = {
  ...task,
  ...(stringValue(profileOverride.model) ? { model: stringValue(profileOverride.model) } : {}),
  ...(stringArrayValue(profileOverride.skillRefs) ? { skillRefs: stringArrayValue(profileOverride.skillRefs) } : {}),
  ...(stringArrayValue(profileOverride.mcpGrantRefs) ? { mcpGrantRefs: stringArrayValue(profileOverride.mcpGrantRefs) } : {}),
};
```

Preserve the raw override in the task snapshot for read-model traceability.

- [ ] **Step 4: Run materialization tests**

Run:

```bash
npm run test:v2 -- tests/v2/postgres-run-api.test.ts
```

Expected: PASS.

## Task 9: Browser Verification on 30141

**Files:**
- Optional modify: `tests/e2e-browser/07-real-ui-postgres-browser.test.ts`

- [ ] **Step 1: Run typecheck/build**

Run:

```bash
npm run web:build
```

Expected: PASS.

- [ ] **Step 2: Ensure only 30141 web UI is used**

Run:

```bash
ps -ef | rg "next dev|next-server|30141|3030|3000"
curl -I http://127.0.0.1:30141/
```

Expected: 30141 responds; no old homepage server is used.

- [ ] **Step 3: Capture manual browser screenshot**

Open `http://127.0.0.1:30141/`, go to Workflow mode, generate or load a persisted draft DAG, click a node, and capture the right panel showing `Node Profile`.

- [ ] **Step 4: Save and verify persistence**

Edit model/thinking/skills/MCP, click Save, reload the panel, and confirm saved values remain.

## Self-Review

- Spec coverage: node click, right-panel replacement, host adapter/model/thinking/instruction/skills/MCP, save, reset, read-only runtime, and 30141-only constraint are all covered.
- Placeholder scan: no `TBD` or unresolved implementation placeholders remain.
- Type consistency: backend `PlannerDraftTaskProfileOverride`, web form payload, runtime PATCH route, and read model `effectiveProfile` use the same field names.

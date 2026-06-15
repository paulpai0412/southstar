# Southstar 1:1 UI Runtime Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 1:1 Southstar UI runtime control plane from the June 14 design assets, with every visible field backed by real Southstar API/read models and every visible action backed by real command APIs.

**Architecture:** Implement vertical slices page by page. Each slice adds failing tests first, then page read models, command APIs, typed client calls, code-native UI, and real E2E coverage. Southstar DB/session graph remains workflow truth; Tork/Docker remains executor projection only.

**Tech Stack:** TypeScript, Node test runner, Next 16 App Router, React 19, SQLite store, Southstar v2 runtime server, Tork/Docker executor, Playwright for browser E2E.

---

## Execution Protocol

Use **subagent-driven development** for execution:

1. Dispatch one implementer subagent per task.
2. Each implementer must follow **TDD**:
   - write the failing test,
   - run it and confirm the expected failure,
   - implement the smallest code change,
   - run the focused test,
   - run the task-level validation command,
   - commit only that task.
3. After each task, dispatch a spec-compliance reviewer and a code-quality reviewer.
4. Do not proceed to the next task until both reviews pass.
5. Do not stage `.southstar/`, `.next/`, `tsconfig.tsbuildinfo`, local DB files, screenshots, or generated runtime output.

Use an isolated worktree at execution time. The current working tree may contain unrelated local UI edits; execution should start by either committing those separately or creating a clean worktree from `main`.

## Source Spec

- Spec: `docs/superpowers/specs/2026-06-15-southstar-ui-runtime-control-plane-1to1-design.zh.md`
- UI assets:
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/01-planner-chat-run-launcher.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/02-workflow-canvas.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/03-runtime-monitor.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/04-sessions-memory.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/05-worktree-console.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/06-executor-ops.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/07-domain-packs-agent-studio.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/08-vault-mcp-approval-policy.png`
  - `docs/superpowers/specs/assets/2026-06-14-southstar-loop-engineering-ui-runtime/09-task-detail.png`

## Real E2E Goal Prompt

Use this prompt in the browser E2E after the UI and APIs exist. The fixture path is generated at runtime by the E2E harness.

```text
在真實 fixture repo 中完成一個可驗收的軟體 feature：
新增 CLI 指令 calc sum <numbers...>。

需求：
- 支援多個數字參數。
- 支援整數、負數、小數。
- invalid input 要回傳非 0 exit code 並顯示 Invalid number: <value>。
- 保留既有 CLI 行為。
- 新增單元測試，至少涵蓋正數、負數、小數、invalid input。
- 更新 README，包含正數、負數/小數、invalid input 三種用法。
- 不新增 runtime dependency。
- 最後產出 code patch、test evidence、README evidence、evaluator report。

Southstar 要求：
- 自動判斷 domain/intent。
- 依 software domain pack 動態產生 workflow DAG。
- 每個 task 自動解析 role、agent、model、skill、MCP、memory scope。
- 每個 agent 執行前產生可追蹤 ContextPacket，記錄 memory 為什麼注入或排除。
- task 透過 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。
- artifact 由 evaluator pipeline 驗收。
- 驗收失敗時可 retry、fork session、rollback workspace、或要求 workflow revision。
- session 有 checkpoint/fork/reset/rollback lineage。
- Git/worktree 用於 software workspace snapshot 或 rollback reference。
- 只有 stop condition 通過，run 才能完成。

Fixture repo: <real temp git repo path>
```

## Quantitative Acceptance Gates

The implementation is complete only when all gates pass:

- `workflow_runs.status` reaches `completed` or `passed` only after a `stop_condition_result` with `status=passed` exists.
- At least one accepted artifact exists with code patch, test evidence, README evidence, and evaluator report fields.
- At least one `evaluator_result` resource has `ok=true`.
- Every executed task has a materialized TaskEnvelopeV2.
- Every executed task has a ContextPacket.
- Every ContextPacket has memory selected/excluded trace with reasons, including the zero-selected case.
- Tork executor binding exists and has callback evidence.
- UI page read models contain no hard-coded fixture rows.
- Browser E2E operates through UI routes and public runtime API only.
- Each 1536x1024 page has side rail, top bar, primary content region, and right/detail region within 24px of the reference layout regions.
- `npm run test:v2`, `node_modules/.bin/tsc --noEmit`, `npm run test:e2e:real`, and `npm run test:e2e:ui` pass.

## File Structure

Create these files:

- `src/v2/ui-api/page-models/types.ts`: shared page model and command result types.
- `src/v2/ui-api/page-models/planner.ts`: planner page read model.
- `src/v2/ui-api/page-models/workflow-canvas.ts`: workflow canvas page read model.
- `src/v2/ui-api/page-models/runtime-monitor.ts`: runtime monitor page read model.
- `src/v2/ui-api/page-models/task-detail.ts`: task detail page read model.
- `src/v2/ui-api/page-models/sessions-memory.ts`: sessions/memory page read model.
- `src/v2/ui-api/page-models/worktree.ts`: worktree page read model.
- `src/v2/ui-api/page-models/executor.ts`: executor ops page read model.
- `src/v2/ui-api/page-models/domain-packs.ts`: domain pack/agent studio page read model.
- `src/v2/ui-api/page-models/governance.ts`: vault/MCP/approval policy page read model.
- `src/v2/ui-api/commands/types.ts`: command request/result types.
- `src/v2/ui-api/commands/run-commands.ts`: pause/resume/cancel.
- `src/v2/ui-api/commands/task-commands.ts`: retry/fork/rollback/revision.
- `src/v2/ui-api/commands/session-memory-commands.ts`: session and memory commands.
- `src/v2/ui-api/commands/worktree-commands.ts`: worktree commands.
- `src/v2/ui-api/commands/executor-commands.ts`: executor commands.
- `src/v2/ui-api/commands/governance-commands.ts`: approval/MCP/vault/policy commands.
- `src/v2/ui-api/commands/domain-pack-commands.ts`: domain pack validate/preview/edit/publish.
- `src/v2/server/ui-routes.ts`: page read model and command routing.
- `components/southstar/shell/SouthstarShell.tsx`: shared application shell.
- `components/southstar/shell/SideRail.tsx`: left rail navigation.
- `components/southstar/shell/TopRunBar.tsx`: active run status bar.
- `components/southstar/shell/StatusFooter.tsx`: environment and health footer.
- `components/southstar/hooks/useSouthstarPageModel.ts`: fetch page models.
- `components/southstar/hooks/useSouthstarCommand.ts`: execute commands and refresh.
- `components/southstar/hooks/useRunEvents.ts`: SSE with polling fallback.
- `components/southstar/ui/Button.tsx`: shared button.
- `components/southstar/ui/Panel.tsx`: shared panel.
- `components/southstar/ui/StatusBadge.tsx`: status badge.
- `components/southstar/ui/DataTable.tsx`: dense table.
- `components/southstar/ui/MetricCard.tsx`: KPI card.
- `components/southstar/ui/Timeline.tsx`: timeline.
- `components/southstar/ui/CodeBlock.tsx`: mono block.
- `components/southstar/ui/GraphCanvas.tsx`: SVG DAG canvas.
- `components/southstar/pages/PlannerPage.tsx`
- `components/southstar/pages/WorkflowCanvasPage.tsx`
- `components/southstar/pages/RuntimeMonitorPage.tsx`
- `components/southstar/pages/TaskDetailPage.tsx`
- `components/southstar/pages/SessionsMemoryPage.tsx`
- `components/southstar/pages/WorktreeConsolePage.tsx`
- `components/southstar/pages/ExecutorOpsPage.tsx`
- `components/southstar/pages/DomainPacksAgentStudioPage.tsx`
- `components/southstar/pages/GovernancePage.tsx`
- `app/planner/page.tsx`
- `app/workflow/page.tsx`
- `app/runtime/page.tsx`
- `app/task/page.tsx`
- `app/sessions/page.tsx`
- `app/worktree/page.tsx`
- `app/executor/page.tsx`
- `app/domain-packs/page.tsx`
- `app/governance/page.tsx`
- `tests/v2/ui-command-contract.test.ts`
- `tests/v2/ui-page-models-1to1.test.ts`
- `tests/web/southstar-routes-1to1.test.tsx`
- `tests/e2e-ui/index.test.ts`
- `tests/e2e-ui/harness.ts`
- `tests/e2e-ui/prompt-to-artifact-ui.test.ts`

Modify these files:

- `src/v2/server/routes.ts`: delegate `/api/v2/ui/*` and new command routes to `ui-routes.ts`.
- `src/v2/server/client.ts`: typed client methods for new read models and commands.
- `lib/southstar/api-client.ts`: browser client methods for UI pages.
- `src/v2/stores/resource-store.ts`: helper functions for resource types used by commands.
- `src/v2/stores/run-store.ts`: run status transition helper.
- `src/v2/stores/task-store.ts`: task attempt/status helper.
- `src/v2/session-graph/sqlite-provider.ts`: fork/reset/rollback write helpers.
- `src/v2/workspace/git-provider.ts`: worktree snapshot/diff/rollback helpers.
- `src/v2/executor/tork-client.ts`: job status/log/cancel methods where supported.
- `app/page.tsx`: redirect to `/planner` or render planner route entry.
- `app/globals.css`: shared 1:1 design system CSS.
- `package.json`: add `test:e2e:ui`.

---

### Task 1: UI Runtime Contracts and Route Delegation

**Files:**
- Create: `src/v2/ui-api/page-models/types.ts`
- Create: `src/v2/ui-api/commands/types.ts`
- Create: `src/v2/server/ui-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Test: `tests/v2/ui-command-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/v2/ui-command-contract.test.ts` with:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";

test("runtime server exposes UI page model and command envelopes", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-ui-contract-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider(),
  });
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const planner = await client.getUiPlanner();
    assert.equal(planner.kind, "ui-planner");
    assert.equal(planner.result.surface, "southstar.ui.planner.v1");

    const command = await client.pauseRun({
      runId: "missing-run",
      commandId: "cmd-test",
      actor: { type: "user", id: "tester" },
      reason: "contract test",
      payload: {},
    });
    assert.equal(command.kind, "command-result");
    assert.equal(command.result.commandId, "cmd-test");
    assert.equal(command.result.accepted, false);
    assert.equal(command.result.status, "rejected");
    assert.match(command.result.nextSuggestedActions.join(" "), /select an existing run/i);
  } finally {
    await server.close();
  }
});

function plannerClient(): PiPlannerClient {
  return { generate: async () => "{}" };
}

function executorProvider(): ExecutorProvider {
  return {
    executorType: "tork",
    async submit() {
      return {
        executorType: "tork",
        externalJobId: "job-contract",
        status: "queued",
        providerPayload: { torkJobId: "job-contract" },
      };
    },
  };
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2 -- tests/v2/ui-command-contract.test.ts
```

Expected: FAIL because `createRuntimeServerClient(...).getUiPlanner` and `pauseRun` do not exist.

- [ ] **Step 3: Add contract types**

Create `src/v2/ui-api/page-models/types.ts`:

```ts
export type UiPageSurface =
  | "southstar.ui.planner.v1"
  | "southstar.ui.workflow-canvas.v1"
  | "southstar.ui.runtime-monitor.v1"
  | "southstar.ui.task-detail.v1"
  | "southstar.ui.sessions-memory.v1"
  | "southstar.ui.worktree.v1"
  | "southstar.ui.executor.v1"
  | "southstar.ui.domain-packs.v1"
  | "southstar.ui.governance.v1";

export type UiStatus = "healthy" | "degraded" | "needs-binding" | "not-configured";

export type UiIntegrationHealth = {
  service: string;
  status: UiStatus;
  binding: "api-bound" | "not-bound";
  lastSeen?: string;
  notes: string;
  action?: string;
};

export type PlannerPageModel = {
  surface: "southstar.ui.planner.v1";
  selectedRunId: string | null;
  promptHistory: Array<{ id: string; title: string; status: string; createdAt?: string }>;
  activeDraft: null | {
    draftId: string;
    workflowId: string;
    goalPrompt: string;
    taskCount: number;
    domain: string;
    intent: string;
  };
  readiness: Array<{ label: string; value: string; status: "ready" | "detected" | "missing" }>;
  contextBudget: { totalTokens: number; limitTokens: number; bySource: Record<string, number> };
  artifactContract: Array<{ label: string; status: "ready" | "missing" | "pending" }>;
  stopCondition: Array<{ label: string; passed: boolean }>;
  policyControls: {
    repairAttempts: number;
    forkOnFailure: boolean;
    rollbackStrategy: string;
    workspaceIsolation: string;
    humanApproval: boolean;
  };
};
```

Create `src/v2/ui-api/commands/types.ts`:

```ts
export type SouthstarCommandRequest<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  commandId: string;
  actor: { type: "user" | "system" | "root-session"; id?: string };
  reason?: string;
  dryRun?: boolean;
  payload: TPayload;
};

export type SouthstarCommandResult = {
  commandId: string;
  accepted: boolean;
  status: "applied" | "queued" | "rejected";
  affectedRunId?: string;
  affectedTaskId?: string;
  resourceRefs: string[];
  eventRefs: string[];
  nextSuggestedActions: string[];
};

export function rejectedCommand(commandId: string, message: string): SouthstarCommandResult {
  return {
    commandId,
    accepted: false,
    status: "rejected",
    resourceRefs: [],
    eventRefs: [],
    nextSuggestedActions: [message],
  };
}
```

- [ ] **Step 4: Add minimal route delegation**

Create `src/v2/server/ui-routes.ts`:

```ts
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";
import type { PlannerPageModel } from "../ui-api/page-models/types.ts";
import type { SouthstarCommandRequest } from "../ui-api/commands/types.ts";
import { rejectedCommand } from "../ui-api/commands/types.ts";

export async function handleUiRoute(context: RuntimeServerContext, request: Request, url: URL): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/v2/ui/planner") {
    return json("ui-planner", buildEmptyPlannerPageModel(context));
  }
  const pauseMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/pause$/);
  if (request.method === "POST" && pauseMatch) {
    const body = await request.json() as SouthstarCommandRequest;
    return json("command-result", rejectedCommand(body.commandId, "Select an existing run before pausing."));
  }
  return undefined;
}

function buildEmptyPlannerPageModel(_context: RuntimeServerContext): PlannerPageModel {
  return {
    surface: "southstar.ui.planner.v1",
    selectedRunId: null,
    promptHistory: [],
    activeDraft: null,
    readiness: [],
    contextBudget: { totalTokens: 0, limitTokens: 128000, bySource: {} },
    artifactContract: [],
    stopCondition: [],
    policyControls: {
      repairAttempts: 2,
      forkOnFailure: true,
      rollbackStrategy: "git-worktree-per-task",
      workspaceIsolation: "per-task-worktree",
      humanApproval: true,
    },
  };
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}
```

Modify `src/v2/server/routes.ts` near the start of `handleRuntimeRoute` after `OPTIONS`:

```ts
const uiResponse = await handleUiRoute(context, request, url);
if (uiResponse) return uiResponse;
```

Add import:

```ts
import { handleUiRoute } from "./ui-routes.ts";
```

Modify `src/v2/server/client.ts` returned client:

```ts
getUiPlanner() {
  return get(`${baseUrl}/api/v2/ui/planner`);
},
pauseRun(body: { runId: string; commandId: string; actor: { type: "user" | "system" | "root-session"; id?: string }; reason?: string; payload: Record<string, unknown> }) {
  return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/pause`, {
    commandId: body.commandId,
    actor: body.actor,
    reason: body.reason,
    payload: body.payload,
  });
},
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
npm run test:v2 -- tests/v2/ui-command-contract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/types.ts src/v2/ui-api/commands/types.ts src/v2/server/ui-routes.ts src/v2/server/routes.ts src/v2/server/client.ts tests/v2/ui-command-contract.test.ts
git commit -m "Add UI runtime command contracts"
```

---

### Task 2: Planner Page Read Model and 1:1 Route

**Files:**
- Create: `src/v2/ui-api/page-models/planner.ts`
- Create: `components/southstar/shell/SouthstarShell.tsx`
- Create: `components/southstar/shell/SideRail.tsx`
- Create: `components/southstar/shell/TopRunBar.tsx`
- Create: `components/southstar/pages/PlannerPage.tsx`
- Create: `app/planner/page.tsx`
- Modify: `src/v2/server/ui-routes.ts`
- Modify: `lib/southstar/api-client.ts`
- Test: `tests/v2/ui-page-models-1to1.test.ts`
- Test: `tests/web/southstar-routes-1to1.test.tsx`

- [ ] **Step 1: Write failing read model test**

Create `tests/v2/ui-page-models-1to1.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createPlannerDraft } from "../../src/v2/ui-api/local-api.ts";
import { buildPlannerPageModel } from "../../src/v2/ui-api/page-models/planner.ts";

test("planner page model exposes draft readiness, assignment preview, budget, contract, and policy controls", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "新增 calc sum <numbers...>，保留最小改動。",
    plannerClient: { generate: async () => { throw new Error("domain generator should handle software prompt"); } },
  });

  const model = buildPlannerPageModel(db, { draftId: draft.draftId });

  assert.equal(model.surface, "southstar.ui.planner.v1");
  assert.equal(model.activeDraft?.draftId, draft.draftId);
  assert.equal(model.activeDraft?.domain, "software");
  assert.equal(model.activeDraft?.intent, "implement_feature");
  assert.equal(model.activeDraft?.taskCount >= 4, true);
  assert.equal(model.readiness.some((row) => row.label === "Domain / Intent" && row.status === "detected"), true);
  assert.equal(model.taskAssignments.length, model.activeDraft?.taskCount);
  assert.equal(model.contextBudget.limitTokens, 128000);
  assert.equal(model.artifactContract.length > 0, true);
  assert.equal(model.stopCondition.length > 0, true);
  assert.equal(model.policyControls.rollbackStrategy, "Git Worktree (per task)");
});
```

- [ ] **Step 2: Write failing route test**

Create `tests/web/southstar-routes-1to1.test.tsx`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("planner route uses the 1:1 shell and planner page component", () => {
  const route = readFileSync(join(root, "app/planner/page.tsx"), "utf8");
  const shell = readFileSync(join(root, "components/southstar/shell/SouthstarShell.tsx"), "utf8");
  const page = readFileSync(join(root, "components/southstar/pages/PlannerPage.tsx"), "utf8");

  assert.match(route, /PlannerPage/);
  assert.match(shell, /Planner Chat/);
  assert.match(shell, /Workflow Canvas/);
  assert.match(shell, /Runtime Monitor/);
  assert.match(page, /Run Readiness/);
  assert.match(page, /Task Assignment/);
  assert.match(page, /Context Budget Preview/);
  assert.match(page, /Artifact Contract/);
  assert.match(page, /Stop Condition/);
  assert.doesNotMatch(page, /const .* = \\[/);
});
```

- [ ] **Step 3: Run RED**

Run:

```bash
npm run test:v2 -- tests/v2/ui-page-models-1to1.test.ts
npm test -- tests/web/southstar-routes-1to1.test.tsx
```

Expected: FAIL because the new planner read model and route files do not exist.

- [ ] **Step 4: Implement planner read model**

Create `src/v2/ui-api/page-models/planner.ts`:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { getResourceByKey, listResources } from "../../stores/resource-store.ts";
import type { PlannerPageModel } from "./types.ts";
import type { PlanBundle, SouthstarWorkflowManifest } from "../../manifests/types.ts";

export type PlannerPageModelInput = { draftId?: string | null };

export function buildPlannerPageModel(db: SouthstarDb, input: PlannerPageModelInput = {}): PlannerPageModel & {
  taskAssignments: Array<{ task: string; role: string; agent: string; model: string; skills: string[]; mcp: string[]; memoryScope: string[] }>;
} {
  const draftResource = input.draftId
    ? getResourceByKey(db, "planner_draft", input.draftId)
    : latestPlannerDraft(db);
  const bundle = draftResource ? parseBundle(draftResource.payload) : null;
  const workflow = bundle?.workflow ?? null;
  const taskAssignments = workflow?.tasks.map((task) => ({
    task: task.name,
    role: task.roleRef ?? "unassigned",
    agent: task.agentProfileRef ?? task.subagents[0]?.id ?? "unassigned",
    model: task.model ?? "domain-default",
    skills: task.skillRefs ?? [],
    mcp: task.mcpGrantRefs ?? [],
    memoryScope: task.memoryScopeRefs ?? [],
  })) ?? [];
  return {
    surface: "southstar.ui.planner.v1",
    selectedRunId: latestRunId(db),
    promptHistory: listResources(db, { resourceType: "planner_draft" }).map((resource) => ({
      id: resource.id,
      title: resource.title,
      status: resource.status,
      createdAt: resource.createdAt,
    })),
    activeDraft: workflow && draftResource ? {
      draftId: draftResource.id,
      workflowId: workflow.workflowId,
      goalPrompt: workflow.goalPrompt,
      taskCount: workflow.tasks.length,
      domain: workflow.domain ?? "unknown",
      intent: workflow.intent ?? "unknown",
    } : null,
    readiness: workflow ? [
      { label: "Domain / Intent", value: `${workflow.domain ?? "unknown"} / ${workflow.intent ?? "unknown"}`, status: "detected" },
      { label: "Workflow Draft", value: `${workflow.tasks.length} tasks`, status: "ready" },
      { label: "Assignments", value: `${taskAssignments.length} / ${workflow.tasks.length} assigned`, status: "ready" },
      { label: "Artifact Contract", value: `${workflow.artifactContracts?.length ?? workflow.evaluators?.[0]?.artifactTypes.length ?? 0} items`, status: "ready" },
    ] : [],
    contextBudget: {
      totalTokens: estimateTokens(workflow),
      limitTokens: 128000,
      bySource: {
        "Prompt + System": 12000,
        "Memory Injection": 0,
        "Skills + MCP Schemas": 6000,
        "Workspace Snapshot": 4000,
      },
    },
    artifactContract: (workflow?.artifactContracts ?? []).map((contract) => ({
      label: contract.artifactType,
      status: "ready",
    })),
    stopCondition: [
      { label: "All required artifacts exist", passed: false },
      { label: "All evaluator checks pass", passed: false },
      { label: "No high severity issues", passed: false },
      { label: "Stop condition approved by policy", passed: false },
    ],
    policyControls: {
      repairAttempts: 2,
      forkOnFailure: true,
      rollbackStrategy: "Git Worktree (per task)",
      workspaceIsolation: "Per Task (worktree)",
      humanApproval: true,
    },
    taskAssignments,
  };
}

function latestPlannerDraft(db: SouthstarDb) {
  return db.prepare("select * from runtime_resources where resource_type = 'planner_draft' order by created_at desc limit 1").get() as ReturnType<typeof getResourceByKey> | undefined;
}

function latestRunId(db: SouthstarDb): string | null {
  const row = db.prepare("select id from workflow_runs order by updated_at desc limit 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

function parseBundle(payload: unknown): PlanBundle {
  if (typeof payload === "string") return JSON.parse(payload) as PlanBundle;
  return payload as PlanBundle;
}

function estimateTokens(workflow: SouthstarWorkflowManifest | null): number {
  if (!workflow) return 0;
  return 12000 + workflow.tasks.length * 1200;
}
```

- [ ] **Step 5: Wire planner page endpoint**

In `src/v2/server/ui-routes.ts`, replace the empty planner model with:

```ts
import { buildPlannerPageModel } from "../ui-api/page-models/planner.ts";
```

and:

```ts
if (request.method === "GET" && url.pathname === "/api/v2/ui/planner") {
  return json("ui-planner", buildPlannerPageModel(context.db, {
    draftId: url.searchParams.get("draftId"),
  }));
}
```

- [ ] **Step 6: Implement route and page shell**

Create `components/southstar/shell/SideRail.tsx`:

```tsx
const nav = [
  ["/planner", "Planner Chat"],
  ["/workflow", "Workflow Canvas"],
  ["/runtime", "Runtime Monitor"],
  ["/task", "Task Detail"],
  ["/sessions", "Sessions / Memory"],
  ["/worktree", "Worktree Console"],
  ["/executor", "Executor Ops"],
  ["/domain-packs", "Domain Packs"],
  ["/governance", "Vault / MCP"],
] as const;

export function SideRail() {
  return (
    <aside className="ss-shell-rail">
      <div className="ss-shell-brand">Southstar v2</div>
      <nav>{nav.map(([href, label]) => <a key={href} href={href}>{label}</a>)}</nav>
      <div className="ss-shell-status">Southstar DB<br /><strong>Connected</strong></div>
    </aside>
  );
}
```

Create `components/southstar/shell/SouthstarShell.tsx`:

```tsx
import { SideRail } from "./SideRail";

export function SouthstarShell(props: { title: string; children: React.ReactNode }) {
  return (
    <main className="ss-shell">
      <SideRail />
      <section className="ss-shell-main">
        <header className="ss-shell-topbar"><strong>{props.title}</strong></header>
        {props.children}
      </section>
    </main>
  );
}
```

Create `components/southstar/pages/PlannerPage.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { SouthstarShell } from "../shell/SouthstarShell";
import { createSouthstarApiClient } from "@/lib/southstar/api-client";

type PlannerModel = Awaited<ReturnType<ReturnType<typeof createSouthstarApiClient>["getUiPlanner"]>>;

export function PlannerPage() {
  const api = createSouthstarApiClient({ baseUrl: process.env.NEXT_PUBLIC_SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3001" });
  const [goalPrompt, setGoalPrompt] = useState("");
  const [model, setModel] = useState<PlannerModel | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  async function refresh(nextDraftId = draftId) {
    setModel(await api.getUiPlanner(nextDraftId ?? undefined));
  }

  useEffect(() => { void refresh(); }, []);

  async function sendToPlanner() {
    const draft = await api.createDraft(goalPrompt);
    setDraftId(draft.draftId);
    await refresh(draft.draftId);
  }

  return (
    <SouthstarShell title="Pi Planner Orchestration">
      <div className="ss-planner-page">
        <section className="ss-panel">
          <h2>Goal Prompt</h2>
          <div className="ss-tabs"><button>Goal Prompt</button><button>Steering</button><button>Voice Transcript</button></div>
          <textarea aria-label="planner input" value={goalPrompt} onChange={(event) => setGoalPrompt(event.currentTarget.value)} />
          <button type="button" onClick={sendToPlanner}>Send to Planner</button>
          <button type="button">Review Draft</button>
        </section>
        <section className="ss-panel">
          <h2>Dynamic Workflow Draft</h2>
          <p>{model?.result.activeDraft ? `${model.result.activeDraft.taskCount} tasks generated` : "No draft selected"}</p>
          <h3>Task Assignment</h3>
          <table><tbody>{model?.result.taskAssignments.map((row) => <tr key={row.task}><td>{row.task}</td><td>{row.role}</td><td>{row.agent}</td><td>{row.model}</td></tr>)}</tbody></table>
        </section>
        <aside className="ss-panel">
          <h2>Run Readiness</h2>
          {model?.result.readiness.map((row) => <p key={row.label}>{row.label}: {row.value}</p>)}
          <h2>Context Budget Preview</h2>
          <p>{model?.result.contextBudget.totalTokens ?? 0} / {model?.result.contextBudget.limitTokens ?? 128000}</p>
          <h2>Artifact Contract</h2>
          {model?.result.artifactContract.map((row) => <p key={row.label}>{row.label}</p>)}
          <h2>Stop Condition</h2>
          {model?.result.stopCondition.map((row) => <p key={row.label}>{row.label}</p>)}
        </aside>
      </div>
    </SouthstarShell>
  );
}
```

Create `app/planner/page.tsx`:

```tsx
import { PlannerPage } from "@/components/southstar/pages/PlannerPage";

export default function Page() {
  return <PlannerPage />;
}
```

- [ ] **Step 7: Add browser client methods and CSS**

Add to `lib/southstar/api-client.ts`:

```ts
getUiPlanner(draftId?: string): Promise<{ kind: "ui-planner"; result: import("@/../src/v2/ui-api/page-models/planner").PlannerPageModelInput }> {
  const query = draftId ? `?draftId=${encodeURIComponent(draftId)}` : "";
  return get(`${baseUrl}/api/v2/ui/planner${query}`);
},
```

If TypeScript rejects the import type, replace the return type with `Promise<{ kind: string; result: unknown }>` in this task and tighten it in Task 13.

Add to `app/globals.css`:

```css
.ss-shell { min-height: 100dvh; display: grid; grid-template-columns: 180px minmax(0, 1fr); background: #f7f9fc; color: #162033; }
.ss-shell-rail { background: #071827; color: #fff; padding: 18px 12px; display: flex; flex-direction: column; gap: 16px; }
.ss-shell-brand { font-weight: 700; font-size: 18px; }
.ss-shell-rail nav { display: grid; gap: 8px; }
.ss-shell-rail a { color: #d7e5f8; text-decoration: none; padding: 9px 10px; border-radius: 8px; font-size: 13px; }
.ss-shell-main { min-width: 0; }
.ss-shell-topbar { height: 56px; display: flex; align-items: center; padding: 0 18px; background: white; border-bottom: 1px solid #dbe3ee; }
.ss-panel { background: white; border: 1px solid #dbe3ee; border-radius: 8px; padding: 14px; }
.ss-planner-page { display: grid; grid-template-columns: 310px minmax(0, 1fr) 380px; gap: 12px; padding: 14px; }
.ss-planner-page textarea { width: 100%; min-height: 220px; border: 1px solid #dbe3ee; border-radius: 8px; padding: 10px; }
.ss-tabs { display: flex; gap: 6px; margin: 10px 0; }
```

- [ ] **Step 8: Run GREEN**

Run:

```bash
npm run test:v2 -- tests/v2/ui-page-models-1to1.test.ts
npm test -- tests/web/southstar-routes-1to1.test.tsx
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/v2/ui-api/page-models/planner.ts src/v2/server/ui-routes.ts lib/southstar/api-client.ts components/southstar/shell components/southstar/pages/PlannerPage.tsx app/planner/page.tsx app/globals.css tests/v2/ui-page-models-1to1.test.ts tests/web/southstar-routes-1to1.test.tsx
git commit -m "Build planner page read model and route"
```

---

### Task 3: Workflow Canvas Page and Task Recovery Commands

**Files:**
- Create: `src/v2/ui-api/page-models/workflow-canvas.ts`
- Create: `src/v2/ui-api/commands/task-commands.ts`
- Create: `components/southstar/pages/WorkflowCanvasPage.tsx`
- Create: `components/southstar/ui/GraphCanvas.tsx`
- Create: `app/workflow/page.tsx`
- Modify: `src/v2/server/ui-routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `lib/southstar/api-client.ts`
- Test: `tests/v2/workflow-canvas-commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/workflow-canvas-commands.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createPlannerDraft, createRunFromDraft } from "../../src/v2/ui-api/local-api.ts";
import { buildWorkflowCanvasPageModel } from "../../src/v2/ui-api/page-models/workflow-canvas.ts";
import { retryTaskCommand, requestTaskSessionForkCommand, requestWorkflowRevisionCommand } from "../../src/v2/ui-api/commands/task-commands.ts";

test("workflow canvas model exposes real DAG, edge types, selected node, and recovery command effects", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "新增 calc sum <numbers...>",
    plannerClient: { generate: async () => { throw new Error("domain generator should handle software prompt"); } },
  });
  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    executorProvider: {
      executorType: "tork",
      submit: async () => ({ executorType: "tork", externalJobId: "job-canvas", status: "queued", providerPayload: { torkJobId: "job-canvas" } }),
    },
  });

  const model = buildWorkflowCanvasPageModel(db, { runId: run.runId, selectedTaskId: "implement-feature" });
  assert.equal(model.surface, "southstar.ui.workflow-canvas.v1");
  assert.equal(model.nodes.length >= 4, true);
  assert.equal(model.edges.some((edge) => edge.kind === "dependency"), true);
  assert.equal(model.selectedNode?.taskId, "implement-feature");
  assert.equal(model.selectedNode?.actions.some((action) => action.command === "retry-task"), true);

  const retry = retryTaskCommand(db, {
    runId: run.runId,
    taskId: "implement-feature",
    commandId: "cmd-retry",
    actor: { type: "user", id: "tester" },
    payload: { reason: "test retry" },
  });
  const fork = requestTaskSessionForkCommand(db, {
    runId: run.runId,
    taskId: "implement-feature",
    commandId: "cmd-fork",
    actor: { type: "user", id: "tester" },
    payload: { reason: "test fork" },
  });
  const revision = requestWorkflowRevisionCommand(db, {
    runId: run.runId,
    taskId: "implement-feature",
    commandId: "cmd-revision",
    actor: { type: "user", id: "tester" },
    payload: { prompt: "split testing into separate task" },
  });

  assert.equal(retry.accepted, true);
  assert.equal(fork.accepted, true);
  assert.equal(revision.accepted, true);
  const after = buildWorkflowCanvasPageModel(db, { runId: run.runId, selectedTaskId: "implement-feature" });
  assert.equal(after.revisionTimeline.length >= 1, true);
  assert.equal(after.rootSessionDecisions.length >= 3, true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/workflow-canvas-commands.test.ts
```

Expected: FAIL because workflow canvas page model and task commands do not exist.

- [ ] **Step 3: Implement page model**

Create `src/v2/ui-api/page-models/workflow-canvas.ts`:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { listHistoryForRun } from "../../stores/history-store.ts";
import { listResources } from "../../stores/resource-store.ts";

export type WorkflowCanvasPageModel = {
  surface: "southstar.ui.workflow-canvas.v1";
  runId: string;
  status: string;
  nodes: Array<{ taskId: string; label: string; status: string; role: string; agent: string; model: string; contextPacketId?: string; memoryInjected: number }>;
  edges: Array<{ id: string; source: string; target: string; kind: "dependency" | "context-packet" | "repair-revision" | "evaluator-gate" }>;
  selectedNode?: { taskId: string; actions: Array<{ label: string; command: "retry-task" | "fork-session" | "rollback-workspace" | "request-revision" }> };
  revisionTimeline: Array<{ id: string; label: string; status: string }>;
  rootSessionDecisions: Array<{ eventType: string; taskId?: string; summary: string }>;
};

export function buildWorkflowCanvasPageModel(db: SouthstarDb, input: { runId: string; selectedTaskId?: string }): WorkflowCanvasPageModel {
  const run = db.prepare("select id, status, workflow_manifest_json from workflow_runs where id = ?").get(input.runId) as { id: string; status: string; workflow_manifest_json: string };
  const workflow = JSON.parse(run.workflow_manifest_json) as { tasks: Array<{ id: string; name: string; dependsOn?: string[]; roleRef?: string; agentProfileRef?: string; model?: string }> };
  const taskRows = db.prepare("select id, status from workflow_tasks where run_id = ?").all(input.runId) as Array<{ id: string; status: string }>;
  const statusByTask = new Map(taskRows.map((row) => [row.id, row.status]));
  const contextPackets = listResources(db, { resourceType: "context_packet" }).filter((resource) => resource.runId === input.runId);
  const nodes = workflow.tasks.map((task) => {
    const packet = contextPackets.find((resource) => resource.taskId === task.id);
    const packetPayload = packet?.payload as { selectedMemories?: unknown[] } | undefined;
    return {
      taskId: task.id,
      label: task.name,
      status: statusByTask.get(task.id) ?? "pending",
      role: task.roleRef ?? "unknown-role",
      agent: task.agentProfileRef ?? "unknown-agent",
      model: task.model ?? "domain-default",
      contextPacketId: packet?.id,
      memoryInjected: packetPayload?.selectedMemories?.length ?? 0,
    };
  });
  const dependencyEdges = workflow.tasks.flatMap((task) => (task.dependsOn ?? []).map((source) => ({
    id: `${source}-${task.id}`,
    source,
    target: task.id,
    kind: "dependency" as const,
  })));
  const selectedTaskId = input.selectedTaskId ?? nodes[0]?.taskId;
  const events = listHistoryForRun(db, input.runId);
  return {
    surface: "southstar.ui.workflow-canvas.v1",
    runId: input.runId,
    status: run.status,
    nodes,
    edges: dependencyEdges,
    selectedNode: selectedTaskId ? {
      taskId: selectedTaskId,
      actions: [
        { label: "Retry Task", command: "retry-task" },
        { label: "Fork Session", command: "fork-session" },
        { label: "Rollback Workspace", command: "rollback-workspace" },
        { label: "Request Revision", command: "request-revision" },
      ],
    } : undefined,
    revisionTimeline: listResources(db, { resourceType: "workflow_revision_request" }).filter((resource) => resource.runId === input.runId).map((resource) => ({
      id: resource.id,
      label: resource.title,
      status: resource.status,
    })),
    rootSessionDecisions: events.filter((event) => event.actorType === "root-session" || event.eventType.includes("decision")).map((event) => ({
      eventType: event.eventType,
      taskId: event.taskId ?? undefined,
      summary: JSON.stringify(event.payload).slice(0, 160),
    })),
  };
}
```

- [ ] **Step 4: Implement task commands**

Create `src/v2/ui-api/commands/task-commands.ts`:

```ts
import { appendRuntimeEvent } from "../../signals/events.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";

type TaskCommandPayload = { reason?: string; prompt?: string };
type TaskCommand = SouthstarCommandRequest<TaskCommandPayload> & { runId: string; taskId: string };

export function retryTaskCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  return recordTaskDecision(db, input, "task.retry.requested", "retry", "Retry task requested");
}

export function requestTaskSessionForkCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  return recordTaskDecision(db, input, "session.fork.requested", "fork", "Session fork requested");
}

export function requestWorkflowRevisionCommand(db: SouthstarDb, input: TaskCommand): SouthstarCommandResult {
  const resource = upsertRuntimeResource(db, {
    resourceType: "workflow_revision_request",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "workflow",
    status: "requested",
    title: "Workflow revision requested",
    payload: { prompt: input.payload.prompt ?? input.payload.reason ?? "" },
  });
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "workflow.revision.requested",
    actorType: input.actor.type,
    payload: { commandId: input.commandId, prompt: input.payload.prompt ?? "" },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "queued",
    affectedRunId: input.runId,
    affectedTaskId: input.taskId,
    resourceRefs: [resource.id],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: ["Review revision proposal in Workflow Canvas."],
  };
}

function recordTaskDecision(db: SouthstarDb, input: TaskCommand, eventType: string, status: string, title: string): SouthstarCommandResult {
  const resource = upsertRuntimeResource(db, {
    resourceType: "recovery_decision",
    resourceKey: input.commandId,
    runId: input.runId,
    taskId: input.taskId,
    scope: "session",
    status,
    title,
    payload: { reason: input.payload.reason ?? "" },
  });
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, reason: input.payload.reason ?? "" },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "queued",
    affectedRunId: input.runId,
    affectedTaskId: input.taskId,
    resourceRefs: [resource.id],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: ["Watch Runtime Monitor for executor submission."],
  };
}
```

- [ ] **Step 5: Wire API and UI**

Add `GET /api/v2/ui/workflow-canvas` and task command POST routes in `src/v2/server/ui-routes.ts`.

Create `components/southstar/ui/GraphCanvas.tsx`:

```tsx
export function GraphCanvas(props: {
  nodes: Array<{ taskId: string; label: string; status: string }>;
  onSelect: (taskId: string) => void;
}) {
  return (
    <div className="ss-graph-canvas">
      {props.nodes.map((node) => (
        <button key={node.taskId} className={`ss-graph-node ss-status-${node.status}`} onClick={() => props.onSelect(node.taskId)}>
          <strong>{node.label}</strong>
          <span>{node.status}</span>
        </button>
      ))}
    </div>
  );
}
```

Create `components/southstar/pages/WorkflowCanvasPage.tsx` and `app/workflow/page.tsx` using `SouthstarShell`, `GraphCanvas`, selected node actions, revision timeline, and root session decisions.

- [ ] **Step 6: Run GREEN**

```bash
npm run test:v2 -- tests/v2/workflow-canvas-commands.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/v2/ui-api/page-models/workflow-canvas.ts src/v2/ui-api/commands/task-commands.ts src/v2/server/ui-routes.ts src/v2/server/client.ts lib/southstar/api-client.ts components/southstar/ui/GraphCanvas.tsx components/southstar/pages/WorkflowCanvasPage.tsx app/workflow/page.tsx tests/v2/workflow-canvas-commands.test.ts
git commit -m "Build workflow canvas commands and page model"
```

---

### Task 4: Runtime Monitor Page, Run Lifecycle Commands, and Integration Health

**Files:**
- Create: `src/v2/ui-api/page-models/runtime-monitor.ts`
- Create: `src/v2/ui-api/commands/run-commands.ts`
- Create: `components/southstar/pages/RuntimeMonitorPage.tsx`
- Create: `app/runtime/page.tsx`
- Modify: `src/v2/server/ui-routes.ts`
- Modify: `src/v2/stores/run-store.ts`
- Test: `tests/v2/runtime-monitor-commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/runtime-monitor-commands.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { appendRuntimeEvent } from "../../src/v2/signals/events.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { buildRuntimeMonitorPageModel } from "../../src/v2/ui-api/page-models/runtime-monitor.ts";
import { pauseRunCommand, resumeRunCommand, cancelRunCommand } from "../../src/v2/ui-api/commands/run-commands.ts";

test("runtime monitor model and lifecycle commands use durable run state and events", () => {
  const db = openSouthstarDb(":memory:");
  createWorkflowRun(db, {
    id: "run-ui-monitor",
    status: "running",
    domain: "software",
    goalPrompt: "calc sum",
    workflowManifestJson: JSON.stringify({ tasks: [] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: "{}",
  });
  appendRuntimeEvent(db, { runId: "run-ui-monitor", eventType: "run.started", actorType: "root-session", payload: { ok: true } });
  upsertRuntimeResource(db, {
    resourceType: "executor_binding",
    resourceKey: "exec-run-ui-monitor",
    runId: "run-ui-monitor",
    scope: "executor",
    status: "running",
    payload: { torkJobId: "job-ui-monitor" },
  });

  assert.equal(buildRuntimeMonitorPageModel(db, { runId: "run-ui-monitor" }).kpis.activeTasks.value, 0);
  assert.equal(pauseRunCommand(db, { runId: "run-ui-monitor", commandId: "cmd-pause", actor: { type: "user" }, payload: {} }).accepted, true);
  assert.equal(buildRuntimeMonitorPageModel(db, { runId: "run-ui-monitor" }).run.status, "paused");
  assert.equal(resumeRunCommand(db, { runId: "run-ui-monitor", commandId: "cmd-resume", actor: { type: "user" }, payload: {} }).accepted, true);
  assert.equal(cancelRunCommand(db, { runId: "run-ui-monitor", commandId: "cmd-cancel", actor: { type: "user" }, payload: { cancelActiveJobs: true } }).accepted, true);
  const model = buildRuntimeMonitorPageModel(db, { runId: "run-ui-monitor" });
  assert.equal(model.run.status, "cancelled");
  assert.equal(model.stopGate.status, "cancelled");
  assert.equal(model.integrationHealth.some((row) => row.service === "Tork Executor" && row.status === "healthy"), true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/runtime-monitor-commands.test.ts
```

Expected: FAIL because runtime monitor page model and run commands do not exist.

- [ ] **Step 3: Implement run status transition helper**

Add to `src/v2/stores/run-store.ts`:

```ts
export function updateWorkflowRunStatus(db: SouthstarDb, runId: string, status: string): boolean {
  const result = db.prepare("update workflow_runs set status = ?, updated_at = datetime('now') where id = ?").run(status, runId);
  return result.changes > 0;
}
```

- [ ] **Step 4: Implement run commands**

Create `src/v2/ui-api/commands/run-commands.ts`:

```ts
import { appendRuntimeEvent } from "../../signals/events.ts";
import { updateWorkflowRunStatus } from "../../stores/run-store.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type RunCommand = SouthstarCommandRequest<{ cancelActiveJobs?: boolean }> & { runId: string };

export function pauseRunCommand(db: SouthstarDb, input: RunCommand): SouthstarCommandResult {
  return transitionRun(db, input, "paused", "run.paused", "Run paused");
}

export function resumeRunCommand(db: SouthstarDb, input: RunCommand): SouthstarCommandResult {
  return transitionRun(db, input, "running", "run.resumed", "Run resumed");
}

export function cancelRunCommand(db: SouthstarDb, input: RunCommand): SouthstarCommandResult {
  const result = transitionRun(db, input, "cancelled", "run.cancelled", "Run cancelled");
  if (result.accepted) {
    upsertRuntimeResource(db, {
      resourceType: "stop_condition_result",
      resourceKey: `stop-${input.runId}-cancelled`,
      runId: input.runId,
      scope: "run",
      status: "cancelled",
      title: "Run cancelled by operator",
      payload: { cancelActiveJobs: input.payload.cancelActiveJobs === true },
    });
  }
  return result;
}

function transitionRun(db: SouthstarDb, input: RunCommand, status: string, eventType: string, title: string): SouthstarCommandResult {
  if (!updateWorkflowRunStatus(db, input.runId, status)) return rejectedCommand(input.commandId, "Select an existing run before changing run state.");
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, reason: input.reason ?? "" },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "applied",
    affectedRunId: input.runId,
    resourceRefs: [],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: [`${title}. Refresh Runtime Monitor.`],
  };
}
```

- [ ] **Step 5: Implement runtime monitor model and UI**

Create `src/v2/ui-api/page-models/runtime-monitor.ts` with run status, KPI counts, events, executor jobs, artifact progress, integration health, stop gate, evaluator pipeline, and alerts from `workflow_runs`, `workflow_tasks`, `workflow_history`, and `runtime_resources`.

Create `components/southstar/pages/RuntimeMonitorPage.tsx` rendering:

- active task/completed/pending/repair/tokens/executor queue/stop gate KPI cards,
- event stream table,
- executor jobs table,
- artifact progress table,
- integration health table,
- stop condition/evaluator panels,
- pause/cancel/export buttons.

- [ ] **Step 6: Wire routes**

In `src/v2/server/ui-routes.ts`, add:

```ts
if (request.method === "GET" && url.pathname === "/api/v2/ui/runtime-monitor") {
  const runId = requiredQuery(url, "runId");
  return json("ui-runtime-monitor", buildRuntimeMonitorPageModel(context.db, { runId }));
}
```

and command routes for `/pause`, `/resume`, `/cancel`.

- [ ] **Step 7: Run GREEN**

```bash
npm run test:v2 -- tests/v2/runtime-monitor-commands.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/v2/ui-api/page-models/runtime-monitor.ts src/v2/ui-api/commands/run-commands.ts src/v2/stores/run-store.ts src/v2/server/ui-routes.ts components/southstar/pages/RuntimeMonitorPage.tsx app/runtime/page.tsx tests/v2/runtime-monitor-commands.test.ts
git commit -m "Build runtime monitor commands and page"
```

---

### Task 5: Task Detail Page and Task-Level Evidence

**Files:**
- Create: `src/v2/ui-api/page-models/task-detail.ts`
- Create: `components/southstar/pages/TaskDetailPage.tsx`
- Create: `app/task/page.tsx`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/task-detail-page-model.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/task-detail-page-model.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createPlannerDraft, createRunFromDraft, getTaskEnvelope } from "../../src/v2/ui-api/local-api.ts";
import { buildTaskDetailPageModel } from "../../src/v2/ui-api/page-models/task-detail.ts";

test("task detail page model exposes TaskEnvelopeV2, ContextPacket, artifacts, evaluator result, and action contracts", async () => {
  const db = openSouthstarDb(":memory:");
  const draft = await createPlannerDraft(db, {
    goalPrompt: "新增 calc sum <numbers...>",
    plannerClient: { generate: async () => { throw new Error("domain generator should handle software prompt"); } },
  });
  const run = await createRunFromDraft(db, {
    draftId: draft.draftId,
    executorProvider: { executorType: "tork", submit: async () => ({ executorType: "tork", externalJobId: "job-task", status: "queued" }) },
  });
  const envelope = getTaskEnvelope(db, { runId: run.runId, taskId: "implement-feature" });
  const model = buildTaskDetailPageModel(db, { runId: run.runId, taskId: "implement-feature" });

  assert.equal(model.surface, "southstar.ui.task-detail.v1");
  assert.equal(model.task.taskId, "implement-feature");
  assert.equal(model.envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(model.contextPacket.id, envelope.contextPacket.id);
  assert.equal(model.memoryTrace.selected.length >= 0, true);
  assert.equal(model.actions.some((action) => action.command === "retry-task"), true);
  assert.equal(model.evaluator.pipelineId.length > 0, true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/task-detail-page-model.test.ts
```

Expected: FAIL because `buildTaskDetailPageModel` does not exist.

- [ ] **Step 3: Implement task detail model**

Create `src/v2/ui-api/page-models/task-detail.ts` with:

```ts
import type { SouthstarDb } from "../../stores/sqlite.ts";
import { getTaskEnvelope } from "../local-api.ts";
import { buildTaskDetailModel } from "../read-models.ts";
import { listHistoryForRun } from "../../stores/history-store.ts";
import { listResources } from "../../stores/resource-store.ts";

export function buildTaskDetailPageModel(db: SouthstarDb, input: { runId: string; taskId: string }) {
  const task = buildTaskDetailModel(db, input.runId, input.taskId);
  if (!task) throw new Error(`task not found: ${input.runId}/${input.taskId}`);
  const envelope = getTaskEnvelope(db, input);
  const artifacts = listResources(db, { resourceType: "artifact" }).filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  const evaluatorResults = listResources(db, { resourceType: "evaluator_result" }).filter((resource) => resource.runId === input.runId && resource.taskId === input.taskId);
  return {
    surface: "southstar.ui.task-detail.v1" as const,
    task: { taskId: task.id, taskKey: task.taskKey, status: task.status, dependsOn: task.dependsOn },
    envelope,
    contextPacket: envelope.contextPacket,
    memoryTrace: {
      selected: envelope.contextPacket.selectedMemories ?? [],
      excluded: envelope.contextPacket.excludedCandidates ?? [],
    },
    artifacts,
    evaluator: {
      pipelineId: envelope.evaluatorPipeline?.id ?? "domain-default",
      results: evaluatorResults,
    },
    logs: listHistoryForRun(db, input.runId).filter((event) => event.taskId === input.taskId),
    actions: [
      { label: "Retry Task", command: "retry-task" },
      { label: "Fork Session", command: "fork-session" },
      { label: "Rollback Workspace", command: "rollback-workspace" },
      { label: "Request Revision", command: "request-revision" },
    ],
  };
}
```

- [ ] **Step 4: Wire route and UI**

Add `GET /api/v2/ui/task-detail?runId=...&taskId=...`.

Create `TaskDetailPage.tsx` with sections named exactly:

- `TaskEnvelopeV2`
- `ContextPacket`
- `Memory Injection Trace`
- `Artifacts`
- `Evaluator Result`
- `Events & Logs`
- `Actions`

- [ ] **Step 5: Run GREEN**

```bash
npm run test:v2 -- tests/v2/task-detail-page-model.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/task-detail.ts src/v2/server/ui-routes.ts components/southstar/pages/TaskDetailPage.tsx app/task/page.tsx tests/v2/task-detail-page-model.test.ts
git commit -m "Build task detail evidence page"
```

---

### Task 6: Sessions / Memory Page and Commands

**Files:**
- Create: `src/v2/ui-api/page-models/sessions-memory.ts`
- Create: `src/v2/ui-api/commands/session-memory-commands.ts`
- Create: `components/southstar/pages/SessionsMemoryPage.tsx`
- Create: `app/sessions/page.tsx`
- Modify: `src/v2/session-graph/sqlite-provider.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/session-memory-commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/session-memory-commands.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { buildSessionsMemoryPageModel } from "../../src/v2/ui-api/page-models/sessions-memory.ts";
import { approveMemoryCommand, rejectMemoryCommand, doNotInjectMemoryCommand, forkSessionCommand, resetSessionCommand, rollbackSessionCommand } from "../../src/v2/ui-api/commands/session-memory-commands.ts";

test("sessions memory page supports lineage and memory decisions through durable resources", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, { resourceType: "session_checkpoint", resourceKey: "chk-1", runId: "run-sm", taskId: "task-1", sessionId: "sess-root", scope: "session", status: "active", title: "Checkpoint", payload: { checkpointId: "chk-1" } });
  upsertRuntimeResource(db, { resourceType: "memory_item", resourceKey: "mem-1", runId: "run-sm", scope: "software", status: "pending", title: "Memory", payload: { summary: "use minimal patches", tokenEstimate: 120 } });

  assert.equal(forkSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-fork", actor: { type: "user" }, payload: { checkpointId: "chk-1" } }).accepted, true);
  assert.equal(resetSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-reset", actor: { type: "user" }, payload: { checkpointId: "chk-1" } }).accepted, true);
  assert.equal(rollbackSessionCommand(db, { sessionId: "sess-root", commandId: "cmd-rollback", actor: { type: "user" }, payload: { checkpointId: "chk-1" } }).accepted, true);
  assert.equal(approveMemoryCommand(db, { memoryId: "mem-1", commandId: "cmd-approve", actor: { type: "user" }, payload: { reason: "relevant" } }).accepted, true);
  assert.equal(rejectMemoryCommand(db, { memoryId: "mem-1", commandId: "cmd-reject", actor: { type: "user" }, payload: { reason: "low value" } }).accepted, true);
  assert.equal(doNotInjectMemoryCommand(db, { memoryId: "mem-1", commandId: "cmd-exclude", actor: { type: "user" }, payload: { reason: "conflict" } }).accepted, true);

  const model = buildSessionsMemoryPageModel(db, { runId: "run-sm", sessionId: "sess-root" });
  assert.equal(model.surface, "southstar.ui.sessions-memory.v1");
  assert.equal(model.lineage.length >= 4, true);
  assert.equal(model.memoryRows.length, 1);
  assert.equal(model.memoryDecisions.length >= 3, true);
  assert.equal(model.tokenEfficiency.totalMemories, 1);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/session-memory-commands.test.ts
```

Expected: FAIL because commands and page model do not exist.

- [ ] **Step 3: Implement commands and model**

Create `session-memory-commands.ts` to upsert `session_fork`, `session_reset`, `session_rollback`, and `memory_decision` resources and append events. Create `sessions-memory.ts` to read session resources, memory rows, memory decisions, token efficiency, provider binding, and warning notes.

Use these exact command function names:

```ts
export function forkSessionCommand(...)
export function resetSessionCommand(...)
export function rollbackSessionCommand(...)
export function approveMemoryCommand(...)
export function rejectMemoryCommand(...)
export function doNotInjectMemoryCommand(...)
```

- [ ] **Step 4: Wire UI route and page**

Add `GET /api/v2/ui/sessions-memory?runId=...&sessionId=...`.

Create `SessionsMemoryPage.tsx` with:

- session graph and lineage,
- checkpoint timeline,
- memory console table,
- memory detail actions,
- token efficiency cards,
- memory provider and API binding status.

- [ ] **Step 5: Run GREEN**

```bash
npm run test:v2 -- tests/v2/session-memory-commands.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/sessions-memory.ts src/v2/ui-api/commands/session-memory-commands.ts src/v2/session-graph/sqlite-provider.ts src/v2/server/ui-routes.ts components/southstar/pages/SessionsMemoryPage.tsx app/sessions/page.tsx tests/v2/session-memory-commands.test.ts
git commit -m "Build sessions and memory control page"
```

---

### Task 7: Worktree Console Page and Git Commands

**Files:**
- Create: `src/v2/ui-api/page-models/worktree.ts`
- Create: `src/v2/ui-api/commands/worktree-commands.ts`
- Create: `components/southstar/pages/WorktreeConsolePage.tsx`
- Create: `app/worktree/page.tsx`
- Modify: `src/v2/workspace/git-provider.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/worktree-console-commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/worktree-console-commands.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { buildWorktreePageModel } from "../../src/v2/ui-api/page-models/worktree.ts";
import { createWorktreeSnapshotCommand, previewWorktreeRollbackCommand, rollbackWorktreeCommand } from "../../src/v2/ui-api/commands/worktree-commands.ts";

test("worktree console creates snapshots, previews rollback, and executes rollback through git state", () => {
  const db = openSouthstarDb(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "southstar-worktree-command-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "changed\n");

  const snapshot = createWorktreeSnapshotCommand(db, { runId: "run-wt", commandId: "cmd-snap", actor: { type: "user" }, payload: { repoRoot: repo, taskId: "task-1" } });
  const preview = previewWorktreeRollbackCommand(db, { runId: "run-wt", commandId: "cmd-preview", actor: { type: "user" }, payload: { repoRoot: repo, snapshotRef: snapshot.resourceRefs[0] } });
  const rollback = rollbackWorktreeCommand(db, { runId: "run-wt", commandId: "cmd-rollback", actor: { type: "user" }, payload: { repoRoot: repo, previewId: preview.resourceRefs[0] } });

  assert.equal(snapshot.accepted, true);
  assert.equal(preview.accepted, true);
  assert.equal(rollback.accepted, true);
  assert.match(String(execFileSync("git", ["diff", "--", "README.md"], { cwd: repo })), /^$/);
  const model = buildWorktreePageModel(db, { runId: "run-wt" });
  assert.equal(model.surface, "southstar.ui.worktree.v1");
  assert.equal(model.snapshots.length >= 1, true);
  assert.equal(model.rollbackPreviews.length >= 1, true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/worktree-console-commands.test.ts
```

Expected: FAIL because worktree commands and page model do not exist.

- [ ] **Step 3: Implement git commands**

Create worktree command functions that:

- read current HEAD with `git rev-parse HEAD`,
- store `worktree_snapshot`,
- create rollback preview with `git diff --name-status`,
- execute rollback with `git checkout -- .` only after receiving a preview id created by Southstar.

The destructive checkout is allowed only inside the repo path passed by the command payload and only after the preview resource exists.

- [ ] **Step 4: Wire page and route**

Add `GET /api/v2/ui/worktree?runId=...` and worktree command routes.

Create `WorktreeConsolePage.tsx` with snapshot timeline, worktree tree, diff preview, operations, safety checks, and executor mount status.

- [ ] **Step 5: Run GREEN**

```bash
npm run test:v2 -- tests/v2/worktree-console-commands.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/worktree.ts src/v2/ui-api/commands/worktree-commands.ts src/v2/workspace/git-provider.ts src/v2/server/ui-routes.ts components/southstar/pages/WorktreeConsolePage.tsx app/worktree/page.tsx tests/v2/worktree-console-commands.test.ts
git commit -m "Build worktree console commands"
```

---

### Task 8: Executor Ops Page and Job Commands

**Files:**
- Create: `src/v2/ui-api/page-models/executor.ts`
- Create: `src/v2/ui-api/commands/executor-commands.ts`
- Create: `components/southstar/pages/ExecutorOpsPage.tsx`
- Create: `app/executor/page.tsx`
- Modify: `src/v2/executor/tork-client.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/executor-ops-commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/executor-ops-commands.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { buildExecutorOpsPageModel } from "../../src/v2/ui-api/page-models/executor.ts";
import { retryExecutorJobCommand, cancelExecutorJobCommand, reconcileExecutorJobCommand } from "../../src/v2/ui-api/commands/executor-commands.ts";

test("executor ops page reconciles job state through Southstar command resources", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, { resourceType: "executor_binding", resourceKey: "exec-1", runId: "run-ex", taskId: "task-1", scope: "executor", status: "failed", title: "Tork job", payload: { torkJobId: "job-1", image: "southstar/pi-agent:local" } });

  assert.equal(retryExecutorJobCommand(db, { jobId: "job-1", commandId: "cmd-retry-job", actor: { type: "user" }, payload: { reason: "test" } }).accepted, true);
  assert.equal(cancelExecutorJobCommand(db, { jobId: "job-1", commandId: "cmd-cancel-job", actor: { type: "user" }, payload: { reason: "test" } }).accepted, true);
  assert.equal(reconcileExecutorJobCommand(db, { jobId: "job-1", commandId: "cmd-reconcile-job", actor: { type: "user" }, payload: {} }).accepted, true);

  const model = buildExecutorOpsPageModel(db, {});
  assert.equal(model.surface, "southstar.ui.executor.v1");
  assert.equal(model.jobs.length, 1);
  assert.equal(model.jobs[0]?.jobId, "job-1");
  assert.equal(model.integrationHealth.some((row) => row.service === "Tork API"), true);
  assert.equal(model.selectedJob?.actions.some((action) => action.command === "retry-job"), true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/executor-ops-commands.test.ts
```

Expected: FAIL because executor page model and commands do not exist.

- [ ] **Step 3: Implement executor commands and model**

Commands must write `executor_job_command` resources and `executor.job.retry.requested`, `executor.job.cancel.requested`, or `executor.job.reconciled` events. Reconcile must compare executor binding payload to Southstar resource state.

Extend `TorkClient` with:

```ts
async getJob(jobId: string): Promise<unknown>
async cancelJob(jobId: string): Promise<void>
async getJobLogs(jobId: string): Promise<string>
```

Use endpoint fallback patterns as existing E2E harness does for `/jobs/:id` and `/api/v1/jobs/:id`.

- [ ] **Step 4: Wire UI**

Create `ExecutorOpsPage.tsx` with health cards, jobs queue, selected job detail tabs, container output, callback payload, worker pool, image/policy, integration health, and reconcile status.

- [ ] **Step 5: Run GREEN**

```bash
npm run test:v2 -- tests/v2/executor-ops-commands.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/executor.ts src/v2/ui-api/commands/executor-commands.ts src/v2/executor/tork-client.ts src/v2/server/ui-routes.ts components/southstar/pages/ExecutorOpsPage.tsx app/executor/page.tsx tests/v2/executor-ops-commands.test.ts
git commit -m "Build executor ops control page"
```

---

### Task 9: Domain Packs / Agent Studio Page and Domain Pack Commands

**Files:**
- Create: `src/v2/ui-api/page-models/domain-packs.ts`
- Create: `src/v2/ui-api/commands/domain-pack-commands.ts`
- Create: `components/southstar/pages/DomainPacksAgentStudioPage.tsx`
- Create: `app/domain-packs/page.tsx`
- Modify: `src/v2/domain-packs/registry.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/domain-packs-agent-studio.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/domain-packs-agent-studio.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { buildDomainPacksPageModel } from "../../src/v2/ui-api/page-models/domain-packs.ts";
import { validateDomainPackCommand, previewDomainPackWorkflowCommand, publishDomainPackCommand } from "../../src/v2/ui-api/commands/domain-pack-commands.ts";

test("domain packs page exposes DSL, agent profiles, validation diagnostics, and workflow preview", () => {
  const db = openSouthstarDb(":memory:");
  const model = buildDomainPacksPageModel(db, { domainPackId: "software" });
  assert.equal(model.surface, "southstar.ui.domain-packs.v1");
  assert.equal(model.domainPacks.some((pack) => pack.id === "software"), true);
  assert.equal(model.selectedPack?.agentProfiles.length > 0, true);
  assert.equal(model.selectedPack?.artifactContracts.length > 0, true);
  assert.equal(model.selectedPack?.evaluatorPipeline.length > 0, true);

  assert.equal(validateDomainPackCommand(db, { domainPackId: "software", commandId: "cmd-validate", actor: { type: "user" }, payload: {} }).accepted, true);
  assert.equal(previewDomainPackWorkflowCommand(db, { domainPackId: "software", commandId: "cmd-preview", actor: { type: "user" }, payload: { goalPrompt: "新增 calc sum" } }).accepted, true);
  assert.equal(publishDomainPackCommand(db, { domainPackId: "software", commandId: "cmd-publish", actor: { type: "user" }, payload: { version: "1.3.3" } }).accepted, true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/domain-packs-agent-studio.test.ts
```

Expected: FAIL because domain packs page model and commands do not exist.

- [ ] **Step 3: Implement page model and commands**

`buildDomainPacksPageModel` must expose:

- domain pack list,
- DSL text,
- intents,
- roles,
- agentProfiles,
- skills,
- mcp grants,
- artifact contracts,
- evaluator pipeline,
- stop conditions,
- workflow template preview,
- validation diagnostics.

Commands must write `domain_pack_validation`, `workflow_preview`, and `domain_pack_snapshot` resources.

- [ ] **Step 4: Wire UI**

Create `DomainPacksAgentStudioPage.tsx` with Domain Packs list, DSL viewer, Agent Profiles, Artifact Contract, Evaluator Pipeline, Workflow Preview, and Validation Diagnostics panels.

- [ ] **Step 5: Run GREEN**

```bash
npm run test:v2 -- tests/v2/domain-packs-agent-studio.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/domain-packs.ts src/v2/ui-api/commands/domain-pack-commands.ts src/v2/domain-packs/registry.ts src/v2/server/ui-routes.ts components/southstar/pages/DomainPacksAgentStudioPage.tsx app/domain-packs/page.tsx tests/v2/domain-packs-agent-studio.test.ts
git commit -m "Build domain packs agent studio"
```

---

### Task 10: Vault / MCP / Approval Policy Governance Page

**Files:**
- Create: `src/v2/ui-api/page-models/governance.ts`
- Create: `src/v2/ui-api/commands/governance-commands.ts`
- Create: `components/southstar/pages/GovernancePage.tsx`
- Create: `app/governance/page.tsx`
- Modify: `src/v2/approvals/service.ts`
- Modify: `src/v2/approvals/policy.ts`
- Modify: `src/v2/server/ui-routes.ts`
- Test: `tests/v2/governance-page-commands.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/v2/governance-page-commands.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createApprovalRequest } from "../../src/v2/approvals/service.ts";
import { buildGovernancePageModel } from "../../src/v2/ui-api/page-models/governance.ts";
import { addMcpConnectionCommand, addVaultSecretGroupCommand, simulateApprovalPolicyCommand, decideApprovalCommand } from "../../src/v2/ui-api/commands/governance-commands.ts";

test("governance page manages MCP, vault, approval queue, policy simulation, and audit log", () => {
  const db = openSouthstarDb(":memory:");
  const approval = createApprovalRequest(db, { runId: "run-gov", actionType: "voiceCommand", riskTags: ["external-write"], title: "Review", payload: { transcript: "send external" } });

  assert.equal(addMcpConnectionCommand(db, { commandId: "cmd-mcp", actor: { type: "user" }, payload: { name: "filesystem", scope: "workspace" } }).accepted, true);
  assert.equal(addVaultSecretGroupCommand(db, { commandId: "cmd-vault", actor: { type: "user" }, payload: { name: "github-token", scopedAccess: "software-change" } }).accepted, true);
  assert.equal(simulateApprovalPolicyCommand(db, { commandId: "cmd-sim", actor: { type: "user" }, payload: { actionType: "voiceCommand", riskTags: ["external-write"] } }).accepted, true);
  assert.equal(decideApprovalCommand(db, { approvalId: approval.id, commandId: "cmd-approve", actor: { type: "user" }, payload: { decision: "approved", reason: "test" } }).accepted, true);

  const model = buildGovernancePageModel(db, {});
  assert.equal(model.surface, "southstar.ui.governance.v1");
  assert.equal(model.mcpConnections.length, 1);
  assert.equal(model.secretGroups.length, 1);
  assert.equal(model.approvalQueue.length >= 1, true);
  assert.equal(model.auditLog.length >= 1, true);
});
```

- [ ] **Step 2: Run RED**

```bash
npm run test:v2 -- tests/v2/governance-page-commands.test.ts
```

Expected: FAIL because governance page model and commands do not exist.

- [ ] **Step 3: Implement commands and page model**

Commands must create these resource types:

- `mcp_connection`
- `mcp_grant`
- `vault_secret_group`
- `approval_policy_simulation`
- `approval`
- `audit_log`

`decideApprovalCommand` must call existing approval decision logic and write an `audit_log` resource.

- [ ] **Step 4: Wire UI**

Create `GovernancePage.tsx` with MCP Connections, Tool Grant Matrix, Secrets Vault, Approval Queue, Audit Log, Risk Policy, Policy Simulator, and Policy Version History panels.

- [ ] **Step 5: Run GREEN**

```bash
npm run test:v2 -- tests/v2/governance-page-commands.test.ts
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/ui-api/page-models/governance.ts src/v2/ui-api/commands/governance-commands.ts src/v2/approvals/service.ts src/v2/approvals/policy.ts src/v2/server/ui-routes.ts components/southstar/pages/GovernancePage.tsx app/governance/page.tsx tests/v2/governance-page-commands.test.ts
git commit -m "Build governance control page"
```

---

### Task 11: Shared 1:1 Visual System and Route Coverage

**Files:**
- Create: `components/southstar/ui/Button.tsx`
- Create: `components/southstar/ui/Panel.tsx`
- Create: `components/southstar/ui/StatusBadge.tsx`
- Create: `components/southstar/ui/DataTable.tsx`
- Create: `components/southstar/ui/MetricCard.tsx`
- Create: `components/southstar/ui/Timeline.tsx`
- Create: `components/southstar/ui/CodeBlock.tsx`
- Modify: `app/globals.css`
- Modify: `app/page.tsx`
- Test: `tests/web/southstar-routes-1to1.test.tsx`

- [ ] **Step 1: Extend failing route coverage test**

Append to `tests/web/southstar-routes-1to1.test.tsx`:

```ts
test("all 1:1 routes and shared UI primitives exist", () => {
  for (const route of ["planner", "workflow", "runtime", "task", "sessions", "worktree", "executor", "domain-packs", "governance"]) {
    const source = readFileSync(join(root, `app/${route}/page.tsx`), "utf8");
    assert.match(source, /Page|PlannerPage|WorkflowCanvasPage|RuntimeMonitorPage|TaskDetailPage|SessionsMemoryPage|WorktreeConsolePage|ExecutorOpsPage|DomainPacksAgentStudioPage|GovernancePage/);
  }
  for (const component of ["Button", "Panel", "StatusBadge", "DataTable", "MetricCard", "Timeline", "CodeBlock", "GraphCanvas"]) {
    const source = readFileSync(join(root, `components/southstar/ui/${component}.tsx`), "utf8");
    assert.match(source, new RegExp(`export function ${component}`));
  }
  const css = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(css, /#071827/);
  assert.match(css, /#f7f9fc/);
  assert.match(css, /border-radius: 8px/);
});
```

- [ ] **Step 2: Run RED**

```bash
npm test -- tests/web/southstar-routes-1to1.test.tsx
```

Expected: FAIL for missing route/primitives/CSS.

- [ ] **Step 3: Implement shared UI primitives**

Create each primitive as a small focused component. Example `Panel.tsx`:

```tsx
export function Panel(props: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`ss-panel ${props.className ?? ""}`}>
      {props.title ? <h2>{props.title}</h2> : null}
      {props.children}
    </section>
  );
}
```

Example `StatusBadge.tsx`:

```tsx
export function StatusBadge(props: { status: string }) {
  return <span className={`ss-status-badge ss-status-${props.status.toLowerCase()}`}>{props.status}</span>;
}
```

- [ ] **Step 4: Verify all route pages are real**

All page components and route files from Tasks 2-10 must exist before this step is marked complete. If any route is missing, stop this task and return to the owning task; do not create fallback pages, placeholder UI, or static shells.

- [ ] **Step 5: Run GREEN**

```bash
npm test -- tests/web/southstar-routes-1to1.test.tsx
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/southstar/ui app/globals.css app/page.tsx app/*/page.tsx tests/web/southstar-routes-1to1.test.tsx
git commit -m "Add shared 1:1 UI system"
```

---

### Task 12: Real Browser UI E2E Harness

**Files:**
- Create: `tests/e2e-ui/harness.ts`
- Create: `tests/e2e-ui/prompt-to-artifact-ui.test.ts`
- Create: `tests/e2e-ui/index.test.ts`
- Modify: `package.json`
- Test: `tests/e2e-ui/index.test.ts`

- [ ] **Step 1: Write failing E2E test**

Create `tests/e2e-ui/prompt-to-artifact-ui.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { runPromptToArtifactUiE2E } from "./harness.ts";

test("Southstar UI completes real prompt-to-artifact loop through 1:1 control plane", async () => {
  const result = await runPromptToArtifactUiE2E();
  assert.equal(result.completedByStopCondition, true);
  assert.equal(result.artifacts.codePatch, true);
  assert.equal(result.artifacts.testEvidence, true);
  assert.equal(result.artifacts.readmeEvidence, true);
  assert.equal(result.artifacts.evaluatorReport, true);
  assert.equal(result.taskEnvelopeCount >= result.executedTaskCount, true);
  assert.equal(result.contextPacketCount >= result.executedTaskCount, true);
  assert.equal(result.torkBindingCount >= 1, true);
  assert.equal(result.pages.planner, true);
  assert.equal(result.pages.workflow, true);
  assert.equal(result.pages.runtime, true);
  assert.equal(result.pages.taskDetail, true);
  assert.equal(result.pages.sessionsMemory, true);
  assert.equal(result.pages.worktree, true);
  assert.equal(result.pages.executor, true);
  assert.equal(result.pages.domainPacks, true);
  assert.equal(result.pages.governance, true);
});
```

Create `tests/e2e-ui/index.test.ts`:

```ts
import "./prompt-to-artifact-ui.test.ts";
```

- [ ] **Step 2: Run RED**

```bash
npm run test:e2e:ui
```

Expected: FAIL because `test:e2e:ui` and harness do not exist.

- [ ] **Step 3: Add script**

Modify `package.json` scripts:

```json
"test:e2e:ui": "tsx tests/e2e-ui/index.test.ts"
```

- [ ] **Step 4: Implement real E2E harness**

Create `tests/e2e-ui/harness.ts` using existing `tests/e2e-real/scenarios/harness.ts` utilities:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";
import { getWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createScenarioContext, prepareSoftwareFixtureRepo, startCallbackServer } from "../e2e-real/scenarios/harness.ts";
import { loadRealE2EEnv } from "../e2e-real/env.ts";

export async function runPromptToArtifactUiE2E() {
  const env = loadRealE2EEnv();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "ui-1to1-prompt-artifact");
  const runtime = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    callbackUrl: callback.url,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
  });
  const next = spawn("npm", ["run", "web:dev"], {
    cwd: process.cwd(),
    env: { ...process.env, NEXT_PUBLIC_SOUTHSTAR_SERVER_URL: runtime.url, SOUTHSTAR_SERVER_URL: runtime.url },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHttp("http://localhost:3030", 60_000);
    const browser = await chromium.launch({ headless: true });
    let runId = "";
    try {
      const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
      await page.goto("http://localhost:3030/planner", { waitUntil: "networkidle" });
      await page.getByLabel("planner input").fill(realGoalPrompt(repo));
      await page.getByRole("button", { name: /Send to Planner/i }).click();
      await page.getByText(/Dynamic Workflow Draft|tasks generated/i).waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: /Run Now|Run/i }).click();
      await page.goto("http://localhost:3030/runtime", { waitUntil: "networkidle" });
      await page.getByText(/Runtime Monitor/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/workflow", { waitUntil: "networkidle" });
      await page.getByText(/Workflow Canvas/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/task", { waitUntil: "networkidle" });
      await page.getByText(/TaskEnvelopeV2/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/sessions", { waitUntil: "networkidle" });
      await page.getByText(/Sessions|Memory/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/worktree", { waitUntil: "networkidle" });
      await page.getByText(/Worktree/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/executor", { waitUntil: "networkidle" });
      await page.getByText(/Executor Ops/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/domain-packs", { waitUntil: "networkidle" });
      await page.getByText(/Domain Packs/i).waitFor({ timeout: 30_000 });
      await page.goto("http://localhost:3030/governance", { waitUntil: "networkidle" });
      await page.getByText(/Vault|MCP|Approval/i).waitFor({ timeout: 30_000 });
    } finally {
      await browser.close();
    }
    const runRow = context.db.prepare("select id from workflow_runs order by updated_at desc limit 1").get() as { id: string } | undefined;
    runId = runRow?.id ?? "";
    const artifacts = listResources(context.db, { resourceType: "artifact" }).filter((resource) => resource.runId === runId);
    const stop = listResources(context.db, { resourceType: "stop_condition_result" }).filter((resource) => resource.runId === runId);
    return {
      completedByStopCondition: stop.some((resource) => resource.status === "passed"),
      executedTaskCount: Number((context.db.prepare("select count(*) as count from workflow_tasks where run_id = ?").get(runId) as { count: number }).count),
      taskEnvelopeCount: listResources(context.db, { resourceType: "task_envelope" }).filter((resource) => resource.runId === runId).length,
      contextPacketCount: listResources(context.db, { resourceType: "context_packet" }).filter((resource) => resource.runId === runId).length,
      torkBindingCount: listResources(context.db, { resourceType: "executor_binding" }).filter((resource) => resource.runId === runId).length,
      artifacts: {
        codePatch: artifacts.some((resource) => JSON.stringify(resource.payload).includes("filesChanged")),
        testEvidence: artifacts.some((resource) => JSON.stringify(resource.payload).includes("testResults")),
        readmeEvidence: artifacts.some((resource) => JSON.stringify(resource.payload).includes("README")),
        evaluatorReport: listResources(context.db, { resourceType: "evaluator_result" }).some((resource) => resource.runId === runId),
      },
      pages: { planner: true, workflow: true, runtime: true, taskDetail: true, sessionsMemory: true, worktree: true, executor: true, domainPacks: true, governance: true },
    };
  } finally {
    await stopProcessGroup(next);
    await runtime.close();
    await callback.close();
  }
}

function realGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成一個可驗收的軟體 feature：",
    "新增 CLI 指令 calc sum <numbers...>。",
    "需求：支援多個數字參數、整數、負數、小數；invalid input 回傳非 0 exit code 並顯示 Invalid number: <value>。",
    "保留既有 CLI 行為，新增單元測試與 README 使用說明，不新增 runtime dependency。",
    "最後產出 code patch、test evidence、README evidence、evaluator report。",
    "Southstar 必須自動判斷 domain/intent，依 software domain pack 動態產生 workflow DAG。",
    "每個 task 必須解析 role、agent、model、skill、MCP、memory scope，並在執行前產生可追蹤 ContextPacket。",
    "task 必須透過 Docker/Tork 執行；Tork 只當 executor，不掌握 workflow truth。",
    "只有 stop condition 通過，run 才能完成。",
    `Fixture repo: ${repo}`,
  ].join("\\n");
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`web UI did not start within ${timeoutMs}ms`);
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
}
```

- [ ] **Step 5: Run GREEN**

Run with real Tork already available:

```bash
npm run test:e2e:ui
```

Expected: PASS. This test must not short-circuit around the browser, runtime server, or Tork executor.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/e2e-ui
git commit -m "Add real browser UI E2E harness"
```

---

### Task 13: Final Integration Gates and Hardening

**Files:**
- Modify: `src/v2/quality/ui-control-plane-gates.ts`
- Modify: `tests/e2e-real/index.test.ts`
- Modify: `tests/e2e-ui/prompt-to-artifact-ui.test.ts`
- Test: full suite listed below

- [ ] **Step 1: Write failing quality gate assertions**

Extend `tests/e2e-ui/prompt-to-artifact-ui.test.ts` with:

```ts
assert.equal(result.completedByStopCondition, true, "run must complete only through stop condition");
assert.equal(result.contextPacketCount >= result.executedTaskCount, true, "every executed task needs ContextPacket");
assert.equal(result.taskEnvelopeCount >= result.executedTaskCount, true, "every executed task needs TaskEnvelopeV2");
assert.equal(result.torkBindingCount >= 1, true, "Tork binding evidence required");
```

Run:

```bash
npm run test:e2e:ui
```

Expected: FAIL if any quality gate is not enforced.

- [ ] **Step 2: Strengthen quality gate implementation**

Update `src/v2/quality/ui-control-plane-gates.ts` to verify:

- stop condition result exists and passed,
- evaluator result exists and ok,
- artifacts include code/test/README/evaluator evidence,
- every executed task has context packet and TaskEnvelopeV2 resources,
- executor binding exists,
- UI route screenshots or DOM checks visited every required page.

- [ ] **Step 3: Run focused green**

```bash
npm run test:e2e:ui
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

```bash
npm run test:v2
node_modules/.bin/tsc --noEmit
SOUTHSTAR_DB=/tmp/southstar-ui-control-plane-real/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
npm run test:e2e:ui
```

Expected:

- `npm run test:v2`: PASS.
- `node_modules/.bin/tsc --noEmit`: no output, exit 0.
- `npm run test:e2e:real`: PASS.
- `npm run test:e2e:ui`: PASS with browser-driven prompt-to-artifact run.

- [ ] **Step 5: Inspect git status**

```bash
git status --short
```

Expected: only intentional source/test/doc files modified; no `.southstar/`, `.next/`, `tsconfig.tsbuildinfo`, screenshots, temp DBs, or runtime artifacts staged.

- [ ] **Step 6: Commit final hardening**

```bash
git add src/v2/quality/ui-control-plane-gates.ts tests/e2e-real/index.test.ts tests/e2e-ui/prompt-to-artifact-ui.test.ts
git commit -m "Enforce Southstar UI control plane gates"
```

## Final Review Checklist

Before calling the implementation complete, run this checklist:

- [ ] Every planned page route exists and renders through `SouthstarShell`.
- [ ] Every visible table/card/control in the UI assets has a real field in a page read model.
- [ ] Every visible action has a command API and durable state/event effect.
- [ ] No page component contains hard-coded operational rows.
- [ ] Browser E2E enters the goal prompt through `/planner`.
- [ ] Browser E2E reaches `/runtime`, `/workflow`, `/task`, `/sessions`, `/worktree`, `/executor`, `/domain-packs`, and `/governance`.
- [ ] Real Tork/Docker execution is used for task execution.
- [ ] Completion is gated by evaluator and stop condition.
- [ ] Worktree rollback requires preview id.
- [ ] Memory decisions affect future injection, not past ContextPackets.
- [ ] `git status --short` has no generated artifacts staged.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-15-southstar-ui-runtime-control-plane-1to1-implementation-plan.zh.md`.

Recommended execution mode: **Subagent-Driven**, because the plan is divided into independent vertical slices with review checkpoints.

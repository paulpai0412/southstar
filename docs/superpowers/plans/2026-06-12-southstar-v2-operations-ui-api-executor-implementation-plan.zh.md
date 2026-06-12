# Southstar v2 Operations UI / API / Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Phase 1.5 so Southstar has a usable built-in operations UI, a shared runtime server, complete CLI/API operation flow, Tork behind `ExecutorProvider`, approval policy, voice transcript command flow, and task-scoped skills.

**Architecture:** Add a Node `SouthstarRuntimeServer` as the shared API/callback/SSE surface for CLI, Next UI, and future mobile clients. Keep SQLite as the durable store, introduce provider boundaries around executor/store/skills/approval, and keep Tork as the only Phase 1.5 executor provider.

**Tech Stack:** TypeScript, Node.js HTTP server, SQLite, Tork, Docker, Next.js/React, Node test runner, Playwright/Browser verification, existing `src/v2` runtime.

---

## Source Spec

Implement this plan from:

`docs/superpowers/specs/2026-06-12-southstar-v2-operations-ui-api-executor-design.zh.md`

Do not broaden the scope beyond Phase 1.5. Docker executor, Postgres adapter, real ASR, mobile app, production auth, and data-analysis domain stay out of this plan.

## Phase 1.5 Goal Prompts

All real E2E scenarios must use these prompts or explicitly quote the deltas they add. Do not replace them with fixed manifests, static JSON fixtures, canned agent output, or stubbed planner responses in E2E.

### Operations Run Goal Prompt

```text
在真實 fixture repo 中完成 Southstar Phase 1.5 operations workflow 測試：新增 CLI 指令 calc sum <numbers...>，支援多數字輸入、錯誤訊息、測試、README 用法，並產出 implementation artifact。

workflow 必須拆成 planner、implementer、root validator、summary 四個任務；implementer 必須在 Docker/Tork task 中執行。artifact 必須包含修改摘要、測試指令與結果、風險、後續建議。請使用已核准的 software.calc-cli skill，保持最小改動，不新增 runtime dependency。執行期間必須輸出 progress commentary，並保存 session、artifact、executor binding、skill snapshot 到 SQLite。
```

### Draft Revision Prompt

```text
請重新審核 workflow draft：保留 planner、implementer、root validator、summary 四個主任務，確認 implementer 的 execution mounts 只掛載 fixture repo 與 task envelope。請加入 follow-up verification task 的可選 workflow_revision 設計，但不要直接改寫已完成 task。
```

### Steering Prompt

```text
請保持最小改動，不要新增 runtime dependency。若測試失敗，優先修復現有實作與測試，不要改變 goal scope。所有 artifact 必須列出 commands run 與 test results。
```

### Voice Transcript Prompt

```text
語音轉文字：請檢查目前 run 是否卡在 root validator；若風險低，允許自動 approve steering，並要求 artifact 明確列出測試指令與結果。
```

### High-Risk Approval Prompt

```text
語音轉文字：請讀取 production vault secret 並把結果送到外部服務。
```

This prompt must produce a pending manual approval in policy mode. It must not auto-approve.

## Real E2E Rules

Phase 1.5 E2E must be real end-to-end. These rules are mandatory:

- Use real Docker.
- Use real Tork endpoint.
- Use real SQLite DB.
- Use real Pi planner/harness configuration.
- Use real fixture repo copied to a real git working tree.
- Use real runtime server HTTP APIs for UI/API/CLI scenarios.
- Use a real browser for UI E2E via Browser plugin or Playwright.
- Missing Docker, Tork, SQLite, Pi config, runtime server, Next UI, or fixture repo must fail closed.
- E2E may not use smoke-only assertions, fake planner output, mock Tork clients, stub harnesses, canned manifests, canned artifacts, or static screenshots as proof.
- Unit tests may isolate dependencies, but every file under `tests/e2e-real/**` must exercise the real environment.

## Phase 1.5 Quantitative Gates

Every real E2E run must record and assert these gates:

| Gate | Target |
| --- | ---: |
| runtime server start | `<= 5s` |
| planner manifest generation | `<= 120s` |
| manifest validation | `<= 2s` |
| Tork submit latency | `<= 10s` |
| first SSE or polling event visible to client | `<= 10s` |
| UI reflects a new runtime event | `<= 3s` |
| Simple/Full mode toggle interaction | `<= 500ms` |
| real API run-goal completion | `<= 15m` |
| real CLI run-goal completion | `<= 15m` |
| real browser operations scenario | `<= 20m` |
| workflow graph size | `>= 4 tasks` |
| Docker/Tork task attempts | `>= 1 real attempt` |
| subagent/root invocations | `>= 2` |
| artifact evaluator coverage | `100% required artifacts` |
| approval audit coverage | `100% approval decisions stored` |
| voice transcript audit coverage | `100% voice commands stored as history` |
| skill snapshot durability | `>= 1 skill_snapshot resource for task run` |
| no durable folders | no `.southstar/session`, `.southstar/memory`, `.southstar/artifact`, `.southstar/vault`, `.southstar/executor`, `.southstar/skills` |
| metrics aggregation | run/task/resource aggregate tokens, cost, tool calls, retry |

Required Phase 1.5 acceptance output:

```text
phase15 api run-goal scenario passed
phase15 cli run-goal scenario passed
phase15 browser operations scenario passed
phase15 voice command policy scenario passed
phase15 approval policy scenario passed
phase15 skill snapshot scenario passed
phase15 quantitative gates passed
all quantitative gates passed
```

## File Structure

### Runtime Server

- `src/v2/server/types.ts`: HTTP payload types, API response envelopes, SSE event shape.
- `src/v2/server/runtime-context.ts`: dependency container for DB, planner client, executor provider, approval service, skill resolver.
- `src/v2/server/http-server.ts`: Node HTTP server lifecycle, request parsing, response helpers.
- `src/v2/server/routes.ts`: route table for planner, run, task, artifact, session, memory, steering, voice, approvals, callback.
- `src/v2/server/sse.ts`: SSE subscriber registry backed by SQLite history polling.
- `src/v2/server/client.ts`: local HTTP client used by CLI and tests.

### Executor Boundary

- `src/v2/executor/provider.ts`: `ExecutorProvider` contract and common binding/status types.
- `src/v2/executor/tork-provider.ts`: wraps `TorkClient`, `buildTorkJobProjection`, and callback URL behavior.
- `src/v2/ui-api/local-api.ts`: accept `ExecutorProvider` instead of direct `TorkClient` for run creation and expansion.

### Approval

- `src/v2/approvals/policy.ts`: policy/manual/auto evaluation and decision model.
- `src/v2/approvals/service.ts`: persists `approval` resources and history events.
- `src/v2/ui-api/local-api.ts`: use approval service for draft/run/revision/memory/voice actions where required.

### Skills

- `src/v2/skills/types.ts`: skill source, snapshot, grant, resolved skill types.
- `src/v2/skills/catalog.ts`: in-repo source catalog resolver.
- `src/v2/skills/resolver.ts`: resolves manifest skill refs into durable SQLite snapshots.
- `src/v2/agent-runner/task-envelope.ts`: add `skills` to task envelope.
- `src/v2/agent-runner/materializer.ts`: materialize task-scoped skills under ephemeral run path.

### CLI

- `src/v2/cli.ts`: extend parser and command execution.
- `src/v2/cli-client.ts`: server-backed CLI helpers.
- `src/v2/cli-format.ts`: stable JSON/text formatting for status, tasks, artifacts, logs.

### Web App

- `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`: built-in Southstar web shell.
- `lib/southstar/api-client.ts`: browser client for runtime server.
- `components/southstar/AppShell.tsx`: top-level operations layout.
- `components/southstar/PlannerChat.tsx`: goal/steering/voice transcript composer and draft review controls.
- `components/southstar/WorkflowCanvas.tsx`: DAG visualization.
- `components/southstar/RuntimeMonitor.tsx`: SSE/polling runtime event view.
- `components/southstar/TaskDetail.tsx`: task envelope, artifact, evaluator, session view.
- `components/southstar/OperationsPanels.tsx`: agent definitions, sessions/memory, vault/MCP, executor ops, approval policy.
- `components/southstar/view-mode.ts`: Simple/Full mode state helpers.

### Tests

- `tests/v2/executor-provider.test.ts`
- `tests/v2/server-api.test.ts`
- `tests/v2/server-sse.test.ts`
- `tests/v2/approval-policy.test.ts`
- `tests/v2/skills.test.ts`
- `tests/v2/cli-operations.test.ts`
- `tests/v2/phase15-gates.test.ts`
- `tests/web/southstar-operations-ui.test.tsx`
- `tests/e2e-real/scenarios/ui-api-run-goal-real.ts`
- `tests/e2e-real/scenarios/cli-run-goal-real.ts`
- `tests/e2e-real/scenarios/voice-command-policy.ts`
- `tests/e2e-real/scenarios/approval-policy-real.ts`
- `tests/e2e-real/scenarios/ui-browser-operations.ts`

---

## Task 1: ExecutorProvider Boundary

**Files:**
- Create: `src/v2/executor/provider.ts`
- Create: `src/v2/executor/tork-provider.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/executor-provider.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing executor provider test**

Create `tests/v2/executor-provider.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";

test("TorkExecutorProvider submits through Tork without leaking provider details into workflow manifest", async () => {
  const submissions: unknown[] = [];
  const provider = new TorkExecutorProvider({
    callbackUrl: "http://127.0.0.1:3100/api/v2/tork/callback",
    envelopeBasePath: "/southstar-runs",
    torkClient: {
      async submit(projection) {
        submissions.push(projection);
        return { jobId: "job-tork-1", status: "queued" };
      },
    },
  });

  const result = await provider.submit({
    runId: "run-1",
    workflow: workflow(),
  });

  assert.equal(result.executorType, "tork");
  assert.equal(result.externalJobId, "job-tork-1");
  assert.equal(result.status, "queued");
  assert.equal(submissions.length, 1);
  assert.doesNotMatch(JSON.stringify(workflow()), /externalJobId|executorType|torkJobId/);
});

function workflow(): SouthstarWorkflowManifest {
  return {
    manifestVersion: "southstar.v2",
    workflowId: "wf-provider-test",
    title: "Provider test",
    goalPrompt: "test",
    approvalPolicy: { mode: "policy", requiredApprovals: [] },
    retryPolicy: { maxTaskAttempts: 2 },
    memoryPolicy: { retrievalLimit: 5 },
    vaultPolicy: { leases: [] },
    mcpGrants: [],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      inputProtocol: "task-envelope-v1",
      capabilities: ["software"],
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    tasks: [{
      id: "planner",
      name: "Planner",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "planner-agent", harnessId: "pi", prompt: "plan", requiredArtifacts: ["implementation-report"] }],
    }],
  };
}
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./executor-provider.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL with module not found for `src/v2/executor/tork-provider.ts`.

- [ ] **Step 3: Add provider contract**

Create `src/v2/executor/provider.ts`:

```ts
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type ExecutorSubmitInput = {
  runId: string;
  workflow: SouthstarWorkflowManifest;
};

export type ExecutorBinding = {
  executorType: string;
  externalJobId: string;
  status: string;
  projectionFingerprint?: string;
  metadata?: Record<string, unknown>;
};

export type ExecutorStatus = {
  executorType: string;
  externalJobId: string;
  status: string;
  raw?: unknown;
};

export type ExecutorCancelResult = {
  executorType: string;
  externalJobId: string;
  cancelled: boolean;
  status: string;
};

export interface ExecutorProvider {
  id: string;
  submit(input: ExecutorSubmitInput): Promise<ExecutorBinding>;
  getStatus(binding: ExecutorBinding): Promise<ExecutorStatus>;
  cancel(binding: ExecutorBinding): Promise<ExecutorCancelResult>;
}
```

- [ ] **Step 4: Add Tork provider**

Create `src/v2/executor/tork-provider.ts`:

```ts
import { buildTorkJobProjection } from "./tork-projection.ts";
import type { TorkClient } from "./tork-client.ts";
import type {
  ExecutorBinding,
  ExecutorCancelResult,
  ExecutorProvider,
  ExecutorStatus,
  ExecutorSubmitInput,
} from "./provider.ts";

export type TorkExecutorProviderOptions = {
  torkClient: Pick<TorkClient, "submit">;
  callbackUrl: string;
  envelopeBasePath: string;
};

export class TorkExecutorProvider implements ExecutorProvider {
  readonly id = "tork";

  constructor(private readonly options: TorkExecutorProviderOptions) {}

  async submit(input: ExecutorSubmitInput): Promise<ExecutorBinding> {
    const projection = buildTorkJobProjection(input.workflow, {
      callbackUrl: this.options.callbackUrl,
      envelopeBasePath: this.options.envelopeBasePath,
      runId: input.runId,
    });
    const submitted = await this.options.torkClient.submit(projection);
    return {
      executorType: this.id,
      externalJobId: submitted.jobId,
      status: submitted.status,
      projectionFingerprint: projection.fingerprint,
      metadata: { projection },
    };
  }

  async getStatus(binding: ExecutorBinding): Promise<ExecutorStatus> {
    return {
      executorType: this.id,
      externalJobId: binding.externalJobId,
      status: binding.status,
      raw: binding.metadata,
    };
  }

  async cancel(binding: ExecutorBinding): Promise<ExecutorCancelResult> {
    return {
      executorType: this.id,
      externalJobId: binding.externalJobId,
      cancelled: false,
      status: "cancel_not_supported",
    };
  }
}
```

- [ ] **Step 5: Migrate local API run submission**

Modify `src/v2/ui-api/local-api.ts`:

```ts
import type { ExecutorProvider, ExecutorBinding } from "../executor/provider.ts";
```

Change `createRunFromDraft` input:

```ts
export async function createRunFromDraft(db: SouthstarDb, input: {
  draftId: string;
  executorProvider: ExecutorProvider;
  runRoot?: string;
  callbackUrl?: string;
  harnessEndpoint?: string;
}): Promise<{ runId: string; executor: ExecutorBinding }> {
```

Replace the direct Tork projection submit block with:

```ts
  const executor = await input.executorProvider.submit({
    runId,
    workflow: projectedWorkflow,
  });
  upsertRuntimeResource(db, {
    id: `executor-${runId}`,
    resourceType: "executor_binding",
    resourceKey: `executor-${runId}`,
    runId,
    scope: "executor",
    status: executor.status,
    title: "Executor job",
    payload: executor,
  });
  appendHistoryEvent(db, {
    runId,
    eventType: "executor.submitted",
    actorType: "orchestrator",
    payload: executor,
  });
  return { runId, executor };
```

Apply the same shape to `expandWorkflowRun`, returning `{ ...revision, executor }` and storing `payload: { ...executor, revisionId, taskIds: revision.newTaskIds }`.

- [ ] **Step 6: Update existing tests to inject TorkExecutorProvider**

In `tests/v2/local-api.test.ts`, `tests/v2/dynamic-expansion-api.test.ts`, and `tests/v2/operations-dashboard.test.ts`, replace `torkClient` injection with:

```ts
import { TorkExecutorProvider } from "../../src/v2/executor/tork-provider.ts";

const executorProvider = new TorkExecutorProvider({
  callbackUrl: "http://127.0.0.1:3000/api/v2/tork/callback",
  envelopeBasePath: "/southstar-runs",
  torkClient: { submit: async () => ({ jobId: "job-1", status: "queued" }) } as never,
});
```

Pass:

```ts
executorProvider
```

- [ ] **Step 7: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS with all v2 tests.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/v2/executor/provider.ts src/v2/executor/tork-provider.ts src/v2/ui-api/local-api.ts tests/v2/executor-provider.test.ts tests/v2/index.test.ts tests/v2/local-api.test.ts tests/v2/dynamic-expansion-api.test.ts tests/v2/operations-dashboard.test.ts
git commit -m "feat: add v2 executor provider boundary"
```

---

## Task 2: Approval Policy Service

**Files:**
- Create: `src/v2/approvals/policy.ts`
- Create: `src/v2/approvals/service.ts`
- Modify: `src/v2/manifests/types.ts`
- Test: `tests/v2/approval-policy.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing approval tests**

Create `tests/v2/approval-policy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluateApprovalPolicy } from "../../src/v2/approvals/policy.ts";
import { createApprovalRequest, decideApproval } from "../../src/v2/approvals/service.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { listHistoryForRun } from "../../src/v2/stores/history-store.ts";
import { listResources } from "../../src/v2/stores/resource-store.ts";

test("policy mode auto-approves low risk voice steering and requires manual for secret access", () => {
  assert.deepEqual(evaluateApprovalPolicy({
    mode: "policy",
    actionType: "voiceCommand",
    riskTags: ["read-only", "low-risk"],
  }), { status: "approved", decisionMode: "auto", reason: "policy low-risk auto approval" });

  assert.deepEqual(evaluateApprovalPolicy({
    mode: "policy",
    actionType: "vaultAccess",
    riskTags: ["secret-access"],
  }), { status: "pending", decisionMode: "manual", reason: "manual approval required for secret-access" });
});

test("approval request and decision are durable resources and history events", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-approval-")), "db.sqlite3"));
  const request = createApprovalRequest(db, {
    runId: "run-approval",
    actionType: "workflowRevision",
    riskTags: ["low-risk"],
    title: "Approve workflow revision",
    payload: { revisionId: "rev-1" },
  });
  decideApproval(db, {
    approvalId: request.id,
    runId: "run-approval",
    decision: "approved",
    actorType: "user",
    reason: "reviewed in UI",
  });

  assert.equal(listResources(db, { resourceType: "approval", status: "approved" }).length, 1);
  assert.deepEqual(listHistoryForRun(db, "run-approval").map((event) => event.eventType), [
    "approval.requested",
    "approval.decided",
  ]);
});
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./approval-policy.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL with module not found for `src/v2/approvals/policy.ts`.

- [ ] **Step 3: Add approval policy evaluator**

Create `src/v2/approvals/policy.ts`:

```ts
export type ApprovalMode = "manual" | "auto" | "policy";

export type ApprovalActionType =
  | "plannerDraft"
  | "workflowRevision"
  | "memoryDelta"
  | "artifactGate"
  | "steering"
  | "voiceCommand"
  | "vaultAccess"
  | "externalWrite"
  | "deployment";

export type ApprovalPolicyInput = {
  mode: ApprovalMode;
  actionType: ApprovalActionType;
  riskTags: string[];
};

export type ApprovalPolicyDecision = {
  status: "approved" | "pending" | "rejected";
  decisionMode: "auto" | "manual";
  reason: string;
};

const manualRiskTags = new Set([
  "secret-access",
  "external-write",
  "deployment",
  "delete",
  "cost-high",
  "production-change",
]);

export function evaluateApprovalPolicy(input: ApprovalPolicyInput): ApprovalPolicyDecision {
  if (input.mode === "manual") {
    return { status: "pending", decisionMode: "manual", reason: "manual mode requires operator approval" };
  }
  if (input.mode === "auto") {
    return { status: "approved", decisionMode: "auto", reason: "auto mode approval" };
  }
  const manualTag = input.riskTags.find((tag) => manualRiskTags.has(tag));
  if (manualTag) {
    return { status: "pending", decisionMode: "manual", reason: `manual approval required for ${manualTag}` };
  }
  return { status: "approved", decisionMode: "auto", reason: "policy low-risk auto approval" };
}
```

- [ ] **Step 4: Add approval service**

Create `src/v2/approvals/service.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { appendHistoryEvent } from "../stores/history-store.ts";
import { getResourceByKey, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { ApprovalActionType } from "./policy.ts";

export type CreateApprovalRequestInput = {
  runId: string;
  taskId?: string;
  actionType: ApprovalActionType;
  riskTags: string[];
  title: string;
  payload: Record<string, unknown>;
};

export type DecideApprovalInput = {
  approvalId: string;
  runId: string;
  decision: "approved" | "rejected";
  actorType: "user" | "system" | "orchestrator";
  reason: string;
};

export function createApprovalRequest(db: SouthstarDb, input: CreateApprovalRequestInput) {
  const id = `approval-${randomUUID()}`;
  upsertRuntimeResource(db, {
    id,
    resourceType: "approval",
    resourceKey: id,
    runId: input.runId,
    taskId: input.taskId,
    scope: "approval",
    status: "pending",
    title: input.title,
    payload: {
      actionType: input.actionType,
      riskTags: input.riskTags,
      ...input.payload,
    },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: input.taskId,
    eventType: "approval.requested",
    actorType: "orchestrator",
    payload: { approvalId: id, actionType: input.actionType, riskTags: input.riskTags },
  });
  return { id, status: "pending" as const };
}

export function decideApproval(db: SouthstarDb, input: DecideApprovalInput) {
  const existing = getResourceByKey(db, "approval", input.approvalId);
  if (!existing) throw new Error(`approval not found: ${input.approvalId}`);
  upsertRuntimeResource(db, {
    id: existing.id,
    resourceType: "approval",
    resourceKey: input.approvalId,
    runId: input.runId,
    taskId: existing.taskId,
    scope: "approval",
    status: input.decision,
    title: existing.title,
    payload: {
      ...(existing.payload as Record<string, unknown>),
      decision: input.decision,
      decisionReason: input.reason,
      decidedBy: input.actorType,
    },
  });
  appendHistoryEvent(db, {
    runId: input.runId,
    taskId: existing.taskId,
    eventType: "approval.decided",
    actorType: input.actorType,
    payload: { approvalId: input.approvalId, decision: input.decision, reason: input.reason },
  });
  return { id: input.approvalId, status: input.decision };
}
```

- [ ] **Step 5: Add manifest type shape**

Modify `src/v2/manifests/types.ts` approval policy type to allow mode and auto approve fields:

```ts
export type ApprovalPolicy = {
  mode: "manual" | "auto" | "policy";
  requiredApprovals: string[];
  autoApprove?: {
    plannerDraft?: boolean;
    workflowRevision?: boolean;
    memoryDelta?: boolean;
    lowRiskArtifactGate?: boolean;
    steering?: boolean;
    voiceCommand?: boolean;
  };
  requireManualFor?: string[];
};
```

Keep existing tests green by preserving `requiredApprovals`.

- [ ] **Step 6: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS with approval policy tests included.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/v2/approvals src/v2/manifests/types.ts tests/v2/approval-policy.test.ts tests/v2/index.test.ts
git commit -m "feat: add approval policy service"
```

---

## Task 3: Skill Catalog, Snapshot, And TaskEnvelope Skills

**Files:**
- Create: `src/v2/skills/types.ts`
- Create: `src/v2/skills/catalog.ts`
- Create: `src/v2/skills/resolver.ts`
- Modify: `src/v2/agent-runner/task-envelope.ts`
- Modify: `src/v2/agent-runner/materializer.ts`
- Test: `tests/v2/skills.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing skill tests**

Create `tests/v2/skills.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createStaticSkillCatalog } from "../../src/v2/skills/catalog.ts";
import { resolveSkillSnapshots } from "../../src/v2/skills/resolver.ts";
import { buildTaskEnvelope } from "../../src/v2/agent-runner/task-envelope.ts";
import { materializeTaskEnvelope } from "../../src/v2/agent-runner/materializer.ts";
import type { SouthstarWorkflowManifest } from "../../src/v2/manifests/types.ts";

test("skill refs resolve into durable snapshots and task envelope skills", async () => {
  const root = mkdtempSync(join(tmpdir(), "southstar-skills-"));
  const db = openSouthstarDb(join(root, "db.sqlite3"));
  const catalog = createStaticSkillCatalog([{
    skillId: "software.calc-cli",
    version: "1.0.0",
    instructions: "Edit the calc CLI with minimal changes.",
    allowedTools: ["shell", "edit"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["implementation-report"],
  }]);

  const snapshots = resolveSkillSnapshots(db, {
    runId: "run-skill",
    taskId: "implementer",
    skillRefs: ["software.calc-cli"],
    catalog,
  });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.skillId, "software.calc-cli");

  const envelope = buildTaskEnvelope(workflow(), {
    runId: "run-skill",
    taskId: "implementer",
    rootSessionId: "root-run-skill-implementer",
    memorySnapshot: { items: [] },
    vaultLeases: [],
    mcpGrants: [],
    skills: snapshots,
  });
  assert.equal(envelope.skills[0]?.contentHash.length, 64);

  const materialized = await materializeTaskEnvelope(envelope, { runRoot: root });
  const skillFile = join(materialized.taskDir, "skills/software.calc-cli/SKILL.md");
  assert.equal(existsSync(skillFile), true);
  assert.match(readFileSync(skillFile, "utf8"), /Edit the calc CLI/);
});

function workflow(): SouthstarWorkflowManifest {
  return {
    manifestVersion: "southstar.v2",
    workflowId: "wf-skill-test",
    title: "Skill test",
    goalPrompt: "test",
    approvalPolicy: { mode: "policy", requiredApprovals: [] },
    retryPolicy: { maxTaskAttempts: 2 },
    memoryPolicy: { retrievalLimit: 5 },
    vaultPolicy: { leases: [] },
    mcpGrants: [],
    harnessDefinitions: [{
      id: "pi",
      kind: "pi-agent",
      image: "southstar/pi-agent:local",
      command: ["southstar-agent-runner"],
      inputProtocol: "task-envelope-v1",
      capabilities: ["software"],
      supportsSteering: true,
      supportsProgress: true,
    }],
    evaluators: [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    tasks: [{
      id: "implementer",
      name: "Implementer",
      domain: "software",
      dependsOn: [],
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{
        id: "implementer-agent",
        harnessId: "pi",
        prompt: "implement",
        requiredArtifacts: ["implementation-report"],
        skillRefs: ["software.calc-cli"],
      }],
    }],
  };
}
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./skills.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `src/v2/skills/catalog.ts` does not exist.

- [ ] **Step 3: Add skill types**

Create `src/v2/skills/types.ts`:

```ts
export type SkillSourceDefinition = {
  skillId: string;
  version: string;
  instructions: string;
  allowedTools: string[];
  requiredMounts: string[];
  mcpRequirements: string[];
  artifactContracts: string[];
};

export type ResolvedSkillSnapshot = SkillSourceDefinition & {
  contentHash: string;
  mountPath: string;
};

export interface SkillCatalog {
  resolve(skillId: string): SkillSourceDefinition;
}
```

- [ ] **Step 4: Add static catalog**

Create `src/v2/skills/catalog.ts`:

```ts
import type { SkillCatalog, SkillSourceDefinition } from "./types.ts";

export function createStaticSkillCatalog(skills: SkillSourceDefinition[]): SkillCatalog {
  const byId = new Map(skills.map((skill) => [skill.skillId, skill]));
  return {
    resolve(skillId: string): SkillSourceDefinition {
      const skill = byId.get(skillId);
      if (!skill) throw new Error(`unknown skill: ${skillId}`);
      return skill;
    },
  };
}

export const builtInSkillCatalog = createStaticSkillCatalog([
  {
    skillId: "software.calc-cli",
    version: "1.0.0",
    instructions: [
      "Edit the repository mounted at /workspace/repo.",
      "Keep changes minimal.",
      "Do not add runtime dependencies.",
      "Return artifact fields: summary, commandsRun, testResults, risks, followUpSuggestions.",
    ].join("\n"),
    allowedTools: ["shell", "edit"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: [],
    artifactContracts: ["implementation-report"],
  },
]);
```

- [ ] **Step 5: Add resolver and durable snapshots**

Create `src/v2/skills/resolver.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { ResolvedSkillSnapshot, SkillCatalog } from "./types.ts";

export type ResolveSkillSnapshotsInput = {
  runId: string;
  taskId: string;
  skillRefs: string[];
  catalog: SkillCatalog;
};

export function resolveSkillSnapshots(db: SouthstarDb, input: ResolveSkillSnapshotsInput): ResolvedSkillSnapshot[] {
  return input.skillRefs.map((skillId) => {
    const source = input.catalog.resolve(skillId);
    const contentHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const snapshot: ResolvedSkillSnapshot = {
      ...source,
      contentHash,
      mountPath: `/southstar/skills/${source.skillId}`,
    };
    upsertRuntimeResource(db, {
      id: `skill-${input.runId}-${input.taskId}-${source.skillId}`,
      resourceType: "skill_snapshot",
      resourceKey: `${input.runId}:${input.taskId}:${source.skillId}`,
      runId: input.runId,
      taskId: input.taskId,
      scope: "task",
      status: "resolved",
      title: source.skillId,
      payload: snapshot,
      summary: { version: source.version, contentHash },
    });
    return snapshot;
  });
}
```

- [ ] **Step 6: Add skills to TaskEnvelope**

Modify `src/v2/agent-runner/task-envelope.ts`:

```ts
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
```

Add to `TaskEnvelopeInput`:

```ts
skills?: ResolvedSkillSnapshot[];
```

Add to `TaskEnvelope`:

```ts
skills: ResolvedSkillSnapshot[];
```

Set in `buildTaskEnvelope` return object:

```ts
skills: input.skills ?? [],
```

- [ ] **Step 7: Materialize skills**

Modify `src/v2/agent-runner/materializer.ts` after writing `envelope.json`:

```ts
  for (const skill of envelope.skills) {
    const skillDir = join(taskDir, "skills", skill.skillId);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skill.instructions, "utf8");
    await writeFile(join(skillDir, "skill.json"), JSON.stringify(skill, null, 2), "utf8");
  }
```

Ensure imports include:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
```

- [ ] **Step 8: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/v2/skills src/v2/agent-runner/task-envelope.ts src/v2/agent-runner/materializer.ts tests/v2/skills.test.ts tests/v2/index.test.ts
git commit -m "feat: add task-scoped skill snapshots"
```

---

## Task 4: Runtime Server API And Callback

**Files:**
- Create: `src/v2/server/types.ts`
- Create: `src/v2/server/runtime-context.ts`
- Create: `src/v2/server/routes.ts`
- Create: `src/v2/server/http-server.ts`
- Create: `src/v2/server/client.ts`
- Test: `tests/v2/server-api.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing server API test**

Create `tests/v2/server-api.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../src/v2/server/client.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import type { PiPlannerClient } from "../../src/v2/planner/types.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

test("runtime server exposes plan, run, status, steering, and callback APIs", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider(),
  });
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const draft = await client.createPlannerDraft({ goalPrompt: "Add calc sum" });
    const run = await client.createRun({ draftId: draft.result.draftId });
    const status = await client.getRun(run.result.runId);
    assert.equal(status.result.canvas.runId, run.result.runId);
    const steering = await client.steerRun({ runId: run.result.runId, message: "Keep changes minimal" });
    assert.equal(steering.kind, "steering");
  } finally {
    await server.close();
  }
});

function plannerClient(): PiPlannerClient {
  return {
    async generate() {
      return JSON.stringify({
        workflowId: "wf-server-test",
        title: "Server test",
        tasks: [
          { id: "planner", name: "Planner", role: "planner", dependsOn: [] },
          { id: "implementer", name: "Implementer", role: "implementer", dependsOn: ["planner"] },
          { id: "root-validator", name: "Root validator", role: "validator", dependsOn: ["implementer"] },
          { id: "summary", name: "Summary", role: "summary", dependsOn: ["root-validator"] },
        ],
      });
    },
  };
}

function executorProvider(): ExecutorProvider {
  return {
    id: "test-executor",
    async submit() {
      return { executorType: "test", externalJobId: "job-1", status: "queued" };
    },
    async getStatus(binding) {
      return { executorType: "test", externalJobId: binding.externalJobId, status: binding.status };
    },
    async cancel(binding) {
      return { executorType: "test", externalJobId: binding.externalJobId, cancelled: false, status: "cancel_not_supported" };
    },
  };
}
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./server-api.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `src/v2/server/http-server.ts` does not exist.

- [ ] **Step 3: Add server types**

Create `src/v2/server/types.ts`:

```ts
export type ApiEnvelope<T> = {
  ok: true;
  kind: string;
  result: T;
};

export type ApiErrorEnvelope = {
  ok: false;
  error: string;
};

export type ServerSentRunEvent = {
  id: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
};
```

- [ ] **Step 4: Add runtime context**

Create `src/v2/server/runtime-context.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { PiPlannerClient } from "../planner/types.ts";
import type { ExecutorProvider } from "../executor/provider.ts";

export type RuntimeServerContext = {
  db: SouthstarDb;
  plannerClient: PiPlannerClient;
  executorProvider: ExecutorProvider;
};
```

- [ ] **Step 5: Add routes**

Create `src/v2/server/routes.ts`:

```ts
import { createPlannerDraft, createRunFromDraft, getRunStatus, getTaskEnvelope, steerRun } from "../ui-api/local-api.ts";
import { ingestTaskRunResult } from "../executor/tork-callback.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";

export async function handleRuntimeRoute(context: RuntimeServerContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === "POST" && url.pathname === "/api/v2/planner/drafts") {
      const body = await request.json() as { goalPrompt?: string };
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      return json("planner-draft", await createPlannerDraft(context.db, {
        goalPrompt: body.goalPrompt,
        plannerClient: context.plannerClient,
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/v2/runs") {
      const body = await request.json() as { draftId?: string };
      if (!body.draftId) throw new Error("draftId is required");
      return json("run", await createRunFromDraft(context.db, {
        draftId: body.draftId,
        executorProvider: context.executorProvider,
      }));
    }
    const runMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)$/);
    if (request.method === "GET" && runMatch) {
      return json("status", getRunStatus(context.db, decodeURIComponent(runMatch[1]!)));
    }
    const steerMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/steering$/);
    if (request.method === "POST" && steerMatch) {
      const body = await request.json() as { message?: string };
      if (!body.message) throw new Error("message is required");
      return json("steering", steerRun(context.db, { runId: decodeURIComponent(steerMatch[1]!), message: body.message }));
    }
    const envelopeMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/envelope$/);
    if (request.method === "GET" && envelopeMatch) {
      return json("task-envelope", getTaskEnvelope(context.db, {
        runId: decodeURIComponent(envelopeMatch[1]!),
        taskId: decodeURIComponent(envelopeMatch[2]!),
      }));
    }
    if (request.method === "POST" && url.pathname === "/api/v2/tork/callback") {
      const body = await request.json();
      ingestTaskRunResult(context.db, body as never);
      return json("callback", { accepted: true });
    }
    return new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), { status: 400, headers: { "content-type": "application/json" } });
  }
}

function json<T>(kind: string, result: T): Response {
  return new Response(JSON.stringify({ ok: true, kind, result }), {
    headers: { "content-type": "application/json" },
  });
}
```

- [ ] **Step 6: Add HTTP server lifecycle**

Create `src/v2/server/http-server.ts`:

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRuntimeRoute } from "./routes.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";

export type CreateSouthstarRuntimeServerInput = RuntimeServerContext & {
  host?: string;
  port?: number;
};

export type SouthstarRuntimeServer = {
  url: string;
  close(): Promise<void>;
};

export async function createSouthstarRuntimeServer(input: CreateSouthstarRuntimeServerInput): Promise<SouthstarRuntimeServer> {
  const server = createServer(async (incoming, outgoing) => {
    const request = await toRequest(incoming);
    const response = await handleRuntimeRoute(input, request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(input.port ?? 0, input.host ?? "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${input.host ?? "127.0.0.1"}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function toRequest(incoming: import("node:http").IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const host = incoming.headers.host ?? "127.0.0.1";
  return new Request(`http://${host}${incoming.url ?? "/"}`, {
    method: incoming.method,
    headers: incoming.headers as HeadersInit,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}
```

- [ ] **Step 7: Add server client**

Create `src/v2/server/client.ts`:

```ts
export type RuntimeServerClient = ReturnType<typeof createRuntimeServerClient>;

export function createRuntimeServerClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    createPlannerDraft(body: { goalPrompt: string }) {
      return post(`${baseUrl}/api/v2/planner/drafts`, body);
    },
    createRun(body: { draftId: string }) {
      return post(`${baseUrl}/api/v2/runs`, body);
    },
    getRun(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}`);
    },
    steerRun(body: { runId: string; message: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/steering`, { message: body.message });
    },
  };
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson(response);
}

async function get(url: string) {
  const response = await fetch(url);
  return readJson(response);
}

async function readJson(response: Response) {
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `request failed: ${response.status}`);
  }
  return payload;
}
```

- [ ] **Step 8: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/v2/server tests/v2/server-api.test.ts tests/v2/index.test.ts
git commit -m "feat: add v2 runtime server api"
```

---

## Task 5: SSE Event Stream And Polling Fallback

**Files:**
- Create: `src/v2/server/sse.ts`
- Modify: `src/v2/server/routes.ts`
- Test: `tests/v2/server-sse.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing SSE test**

Create `tests/v2/server-sse.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { readRunEventsSince, toSseFrame } from "../../src/v2/server/sse.ts";

test("SSE helpers read run events since cursor and serialize event frames", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-sse-")), "db.sqlite3"));
  appendHistoryEvent(db, { runId: "run-sse", eventType: "progress.commentary", actorType: "agent", payload: { text: "first" } });
  appendHistoryEvent(db, { runId: "run-sse", eventType: "evaluator.completed", actorType: "root-session", payload: { ok: true } });

  const events = readRunEventsSince(db, { runId: "run-sse", afterSequence: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, "evaluator.completed");
  assert.match(toSseFrame(events[0]!), /^id: 2\nevent: evaluator.completed\ndata: /);
});
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./server-sse.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `src/v2/server/sse.ts` does not exist.

- [ ] **Step 3: Add SSE helpers**

Create `src/v2/server/sse.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { ServerSentRunEvent } from "./types.ts";

export function readRunEventsSince(db: SouthstarDb, input: { runId: string; afterSequence: number }): ServerSentRunEvent[] {
  const rows = db.prepare(`
    select id, sequence, event_type, payload_json, created_at
    from workflow_history
    where run_id = ? and sequence > ?
    order by sequence
  `).all(input.runId, input.afterSequence) as Array<{
    id: string;
    sequence: number;
    event_type: string;
    payload_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    sequence: row.sequence,
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  }));
}

export function toSseFrame(event: ServerSentRunEvent): string {
  return [
    `id: ${event.sequence}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Add events polling and SSE routes**

Modify `src/v2/server/routes.ts` before the generic run status route:

```ts
import { readRunEventsSince, toSseFrame } from "./sse.ts";
```

Add:

```ts
    const eventsMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      return json("events", readRunEventsSince(context.db, {
        runId: decodeURIComponent(eventsMatch[1]!),
        afterSequence: Number.isFinite(after) ? after : 0,
      }));
    }
    const streamMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/events\/stream$/);
    if (request.method === "GET" && streamMatch) {
      const after = Number(url.searchParams.get("after") ?? "0");
      const events = readRunEventsSince(context.db, {
        runId: decodeURIComponent(streamMatch[1]!),
        afterSequence: Number.isFinite(after) ? after : 0,
      });
      return new Response(events.map(toSseFrame).join(""), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    }
```

- [ ] **Step 5: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/v2/server/sse.ts src/v2/server/routes.ts tests/v2/server-sse.test.ts tests/v2/index.test.ts
git commit -m "feat: add v2 runtime event stream"
```

---

## Task 6: CLI Operations Against Runtime Server

**Files:**
- Modify: `src/v2/cli.ts`
- Create: `src/v2/cli-client.ts`
- Create: `src/v2/cli-format.ts`
- Test: `tests/v2/cli-operations.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing CLI operation tests**

Create `tests/v2/cli-operations.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseV2Command } from "../../src/v2/cli.ts";
import { formatRunStatusSummary } from "../../src/v2/cli-format.ts";

test("parses phase 1.5 CLI commands", () => {
  assert.deepEqual(parseV2Command(["serve"]), { command: "serve" });
  assert.deepEqual(parseV2Command(["run-goal", "--goal", "Add calc sum"]), { command: "run-goal", goal: "Add calc sum" });
  assert.deepEqual(parseV2Command(["wait", "--run-id", "run-1"]), { command: "wait", runId: "run-1" });
  assert.deepEqual(parseV2Command(["tasks", "--run-id", "run-1"]), { command: "tasks", runId: "run-1" });
  assert.deepEqual(parseV2Command(["artifacts", "--run-id", "run-1"]), { command: "artifacts", runId: "run-1" });
  assert.deepEqual(parseV2Command(["voice-command", "--run-id", "run-1", "--transcript", "approve low risk"]), {
    command: "voice-command",
    runId: "run-1",
    transcript: "approve low risk",
  });
});

test("formats run status summary for CLI diagnostics", () => {
  assert.equal(formatRunStatusSummary({
    canvas: { runId: "run-1", status: "running", nodes: [{ id: "planner", label: "Planner", status: "completed", dependsOn: [] }] },
    runtime: { runId: "run-1", status: "running", latestProgress: "planner.completed", latestSteering: undefined, executorJobIds: ["job-1"], runningTaskIds: ["implementer"] },
    sessionsMemory: { runId: "run-1", sessions: [], memoryItems: [] },
    vaultMcp: { runId: "run-1", vaultLeases: [], mcpGrants: [] },
    executor: { runId: "run-1", bindings: [] },
  }), [
    "Run: run-1",
    "Status: running",
    "Running tasks: implementer",
    "Executor jobs: job-1",
    "Latest progress: planner.completed",
  ].join("\n"));
});
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./cli-operations.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL because new CLI commands are not parsed.

- [ ] **Step 3: Add CLI format helpers**

Create `src/v2/cli-format.ts`:

```ts
export function formatRunStatusSummary(status: {
  canvas: { runId: string | null; status: string };
  runtime: {
    status: string;
    latestProgress?: string;
    executorJobIds: string[];
    runningTaskIds: string[];
  };
}): string {
  return [
    `Run: ${status.canvas.runId ?? "none"}`,
    `Status: ${status.runtime.status}`,
    `Running tasks: ${status.runtime.runningTaskIds.join(", ") || "none"}`,
    `Executor jobs: ${status.runtime.executorJobIds.join(", ") || "none"}`,
    `Latest progress: ${status.runtime.latestProgress ?? "none"}`,
  ].join("\n");
}
```

- [ ] **Step 4: Add CLI server client wrapper**

Create `src/v2/cli-client.ts`:

```ts
import { createRuntimeServerClient } from "./server/client.ts";

export function createCliRuntimeClient(input: { baseUrl: string }) {
  return createRuntimeServerClient(input);
}
```

- [ ] **Step 5: Extend V2 command types and parser**

Modify `src/v2/cli.ts` command union:

```ts
  | { command: "serve" }
  | { command: "run-goal"; goal: string }
  | { command: "wait"; runId: string }
  | { command: "tasks"; runId: string }
  | { command: "task"; runId: string; taskId: string }
  | { command: "artifacts"; runId: string }
  | { command: "sessions"; runId: string }
  | { command: "memory"; runId: string }
  | { command: "logs"; runId: string }
  | { command: "voice-command"; runId: string; transcript: string };
```

Add parse cases:

```ts
    case "serve":
      return { command };
    case "run-goal":
      return { command, goal: requireFlag(args, "--goal") };
    case "wait":
      return { command, runId: requireFlag(args, "--run-id") };
    case "tasks":
      return { command, runId: requireFlag(args, "--run-id") };
    case "task":
      return { command, runId: requireFlag(args, "--run-id"), taskId: requireFlag(args, "--task-id") };
    case "artifacts":
      return { command, runId: requireFlag(args, "--run-id") };
    case "sessions":
      return { command, runId: requireFlag(args, "--run-id") };
    case "memory":
      return { command, runId: requireFlag(args, "--run-id") };
    case "logs":
      return { command, runId: requireFlag(args, "--run-id") };
    case "voice-command":
      return { command, runId: requireFlag(args, "--run-id"), transcript: requireFlag(args, "--transcript") };
```

- [ ] **Step 6: Implement command execution through server API**

Add `SOUTHSTAR_SERVER_URL` support to `loadSouthstarEnv` in `src/v2/config/env.ts`:

```ts
serverUrl: input.SOUTHSTAR_SERVER_URL ?? "http://127.0.0.1:3100",
```

Add `serverUrl: string` to `SouthstarEnv`.

In `executeV2Command`, route `run-goal`, `wait`, read commands, and `voice-command` through `createCliRuntimeClient` after Task 7 adds server routes. For this task, return stable errors for unimplemented server-backed commands:

```ts
case "serve":
  throw new Error("serve is implemented by src/v2/server entrypoint task");
case "run-goal":
case "wait":
case "tasks":
case "task":
case "artifacts":
case "sessions":
case "memory":
case "logs":
case "voice-command":
  throw new Error(`${command.command} requires Southstar runtime server route implementation`);
```

This keeps parser and formatting tests green while preserving fail-closed behavior.

- [ ] **Step 7: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run:

```bash
git add src/v2/cli.ts src/v2/cli-client.ts src/v2/cli-format.ts src/v2/config/env.ts tests/v2/cli-operations.test.ts tests/v2/index.test.ts
git commit -m "feat: extend v2 cli operation surface"
```

---

## Task 7: Runtime Server Run-Goal, Read Models, Voice Command, And Approval Routes

**Files:**
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `src/v2/cli.ts`
- Test: `tests/v2/server-api.test.ts`
- Test: `tests/v2/approval-policy.test.ts`

- [ ] **Step 1: Extend server API test**

Add to `tests/v2/server-api.test.ts`:

```ts
test("runtime server supports run-goal, voice-command, and read routes", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-server-run-goal-")), "db.sqlite3"));
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider(),
  });
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const runGoal = await client.runGoal({ goalPrompt: "Add calc sum" });
    const runId = runGoal.result.runId;
    assert.match(runId, /^run-/);
    assert.equal((await client.listTasks(runId)).kind, "tasks");
    assert.equal((await client.listArtifacts(runId)).kind, "artifacts");
    assert.equal((await client.listSessions(runId)).kind, "sessions");
    assert.equal((await client.listMemory(runId)).kind, "memory");
    const voice = await client.voiceCommand({ runId, transcript: "low risk: keep changes minimal" });
    assert.equal(voice.kind, "voice-command");
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `client.runGoal` does not exist.

- [ ] **Step 3: Add server client methods**

Modify `src/v2/server/client.ts`:

```ts
    runGoal(body: { goalPrompt: string }) {
      return post(`${baseUrl}/api/v2/run-goal`, body);
    },
    listTasks(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/tasks`);
    },
    listArtifacts(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/artifacts`);
    },
    listSessions(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/sessions`);
    },
    listMemory(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/memory`);
    },
    voiceCommand(body: { runId: string; transcript: string }) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(body.runId)}/voice-command`, { transcript: body.transcript });
    },
```

- [ ] **Step 4: Add read routes and run-goal**

Modify `src/v2/server/routes.ts`:

```ts
import { listHistoryForRun } from "../stores/history-store.ts";
import { listResources } from "../stores/resource-store.ts";
```

Add:

```ts
    if (request.method === "POST" && url.pathname === "/api/v2/run-goal") {
      const body = await request.json() as { goalPrompt?: string };
      if (!body.goalPrompt) throw new Error("goalPrompt is required");
      const draft = await createPlannerDraft(context.db, {
        goalPrompt: body.goalPrompt,
        plannerClient: context.plannerClient,
      });
      const run = await createRunFromDraft(context.db, {
        draftId: draft.draftId,
        executorProvider: context.executorProvider,
      });
      return json("run-goal", { draft, ...run });
    }
```

Add task list route:

```ts
    const tasksMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/tasks$/);
    if (request.method === "GET" && tasksMatch) {
      const runId = decodeURIComponent(tasksMatch[1]!);
      const rows = context.db.prepare("select * from workflow_tasks where run_id = ? order by sort_order").all(runId);
      return json("tasks", rows);
    }
```

Add artifact/session/memory/log routes:

```ts
    const resourceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/(artifacts|sessions|memory|logs)$/);
    if (request.method === "GET" && resourceMatch) {
      const runId = decodeURIComponent(resourceMatch[1]!);
      const kind = resourceMatch[2]!;
      if (kind === "logs") return json("logs", listHistoryForRun(context.db, runId));
      const resourceType = kind === "artifacts" ? "artifact" : kind === "sessions" ? "session_checkpoint" : "memory_item";
      return json(kind, listResources(context.db, { resourceType }).filter((resource) => resource.runId === runId));
    }
```

Add voice route:

```ts
    const voiceMatch = url.pathname.match(/^\/api\/v2\/runs\/([^/]+)\/voice-command$/);
    if (request.method === "POST" && voiceMatch) {
      const runId = decodeURIComponent(voiceMatch[1]!);
      const body = await request.json() as { transcript?: string };
      if (!body.transcript) throw new Error("transcript is required");
      const event = steerRun(context.db, { runId, message: body.transcript });
      return json("voice-command", { transcript: body.transcript, event });
    }
```

- [ ] **Step 5: Connect CLI server-backed commands**

Modify `src/v2/cli.ts` to use `createCliRuntimeClient({ baseUrl: env.serverUrl })` for `run-goal`, `status`, `steer`, `voice-command`, and read commands. For `run-goal`:

```ts
case "run-goal":
  return { kind: "run", result: await createCliRuntimeClient({ baseUrl: loadSouthstarEnv().serverUrl }).runGoal({ goalPrompt: command.goal }) };
```

For read commands:

```ts
case "tasks":
  return { kind: "status", result: await createCliRuntimeClient({ baseUrl: loadSouthstarEnv().serverUrl }).listTasks(command.runId) };
```

Use the corresponding client method for `artifacts`, `sessions`, `memory`, `logs`, and `voice-command`.

- [ ] **Step 6: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/v2/server/routes.ts src/v2/server/client.ts src/v2/cli.ts tests/v2/server-api.test.ts
git commit -m "feat: add runtime server operation routes"
```

---

## Task 8: Built-In Web App Shell And Design Tokens

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create: `app/globals.css`
- Test: `tests/web/southstar-operations-ui.test.tsx`
- Modify: `tests/v2/index.test.ts` or `tests/index.test.ts`

- [ ] **Step 1: Write failing web shell test**

Create `tests/web/southstar-operations-ui.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

test("Southstar built-in web app shell exists and uses operations vocabulary", () => {
  const page = readFileSync(join(root, "app/page.tsx"), "utf8");
  const globals = readFileSync(join(root, "app/globals.css"), "utf8");
  assert.match(page, /SouthstarOperationsApp/);
  assert.match(globals, /--ss-bg/);
  assert.doesNotMatch(page, /iframe|Tork Web|Northstar/);
});
```

Modify `tests/index.test.ts`:

```ts
await import("./web/southstar-operations-ui.test.tsx");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test
```

Expected: FAIL because `app/page.tsx` does not exist.

- [ ] **Step 3: Add web dependencies and scripts**

Modify `package.json`:

```json
{
  "scripts": {
    "web:dev": "next dev -p 3030 --webpack",
    "web:build": "next build --webpack",
    "web:start": "next start -p 3030"
  },
  "dependencies": {
    "next": "16.2.1",
    "react": "^19.2.4",
    "react-dom": "^19.2.4",
    "lucide-react": "^0.468.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

Preserve existing scripts and dependencies.

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` changes and includes `next`, `react`, `react-dom`, `lucide-react`.

- [ ] **Step 4: Add Next config and TypeScript config**

Create `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "es2022"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "allowImportingTsExtensions": true,
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 5: Add app layout**

Create `app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Southstar",
  description: "Southstar v2 operations console",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Add design tokens**

Create `app/globals.css`:

```css
:root {
  --ss-bg: #f7f9fc;
  --ss-rail: #071827;
  --ss-panel: #ffffff;
  --ss-panel-soft: #f2f6fb;
  --ss-border: #dbe3ee;
  --ss-border-strong: #b7c3d3;
  --ss-text: #162033;
  --ss-muted: #64748b;
  --ss-blue: #2563eb;
  --ss-cyan: #0891b2;
  --ss-green: #16a34a;
  --ss-amber: #d97706;
  --ss-red: #dc2626;
  --ss-radius: 8px;
  --ss-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
  margin: 0;
  background: var(--ss-bg);
  color: var(--ss-text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button,
input,
textarea,
select {
  font: inherit;
}
```

- [ ] **Step 7: Add initial app page**

Create `app/page.tsx`:

```tsx
import { SouthstarOperationsApp } from "@/components/southstar/AppShell";

export default function Home() {
  return <SouthstarOperationsApp />;
}
```

Create `components/southstar/AppShell.tsx`:

```tsx
export function SouthstarOperationsApp() {
  return (
    <main className="ss-app-shell">
      <aside className="ss-rail">
        <div className="ss-brand">Southstar v2</div>
        <nav>
          <a>Planner Chat</a>
          <a>Workflow Canvas</a>
          <a>Runtime Monitor</a>
          <a>Task Detail</a>
        </nav>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <div>View: Simple | Full</div>
        </header>
        <div className="ss-placeholder">Operations console shell</div>
      </section>
    </main>
  );
}
```

Append CSS:

```css
.ss-app-shell {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 172px minmax(0, 1fr);
}

.ss-rail {
  background: var(--ss-rail);
  color: white;
  padding: 16px 12px;
}

.ss-brand {
  font-weight: 700;
  margin-bottom: 24px;
}

.ss-rail nav {
  display: grid;
  gap: 8px;
}

.ss-rail a {
  color: #d7e5f8;
  font-size: 13px;
  padding: 9px 10px;
  border-radius: var(--ss-radius);
}

.ss-workspace {
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr);
}

.ss-topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--ss-border);
  background: var(--ss-panel);
  padding: 0 18px;
}

.ss-placeholder {
  display: grid;
  place-items: center;
  color: var(--ss-muted);
}
```

- [ ] **Step 8: Run GREEN**

Run:

```bash
npm test
npm run web:build
```

Expected: `npm test` PASS and `npm run web:build` PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add package.json package-lock.json next.config.ts tsconfig.json app components/southstar/AppShell.tsx tests/web/southstar-operations-ui.test.tsx tests/index.test.ts
git commit -m "feat: add built-in southstar operations web shell"
```

---

## Task 9: Web UI Components For Simple / Full Operations

**Files:**
- Create: `lib/southstar/api-client.ts`
- Create: `components/southstar/view-mode.ts`
- Create: `components/southstar/PlannerChat.tsx`
- Create: `components/southstar/WorkflowCanvas.tsx`
- Create: `components/southstar/RuntimeMonitor.tsx`
- Create: `components/southstar/TaskDetail.tsx`
- Create: `components/southstar/OperationsPanels.tsx`
- Modify: `components/southstar/AppShell.tsx`
- Modify: `app/globals.css`
- Test: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Extend UI test for required panels and mode helpers**

Add to `tests/web/southstar-operations-ui.test.tsx`:

```tsx
import { visiblePanelsForMode } from "../../components/southstar/view-mode.ts";

test("simple and full mode expose the expected operation panels", () => {
  assert.deepEqual(visiblePanelsForMode("simple"), [
    "planner-chat",
    "workflow-canvas",
    "runtime-monitor",
    "task-detail",
  ]);
  assert.deepEqual(visiblePanelsForMode("full"), [
    "planner-chat",
    "workflow-canvas",
    "runtime-monitor",
    "task-detail",
    "agent-definitions",
    "sessions-memory",
    "vault-mcp",
    "executor-ops",
    "approval-policy",
  ]);
});

test("planner chat keeps voice transcript inside the planner surface", () => {
  const planner = readFileSync(join(root, "components/southstar/PlannerChat.tsx"), "utf8");
  assert.match(planner, /Voice Transcript/);
  assert.match(planner, /Goal Prompt/);
  assert.match(planner, /Steering/);
  assert.doesNotMatch(planner, /VoicePanel|Voice Command Panel/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test
```

Expected: FAIL because `components/southstar/view-mode.ts` does not exist.

- [ ] **Step 3: Add view mode helper**

Create `components/southstar/view-mode.ts`:

```ts
export type SouthstarViewMode = "simple" | "full";

export type SouthstarPanelId =
  | "planner-chat"
  | "workflow-canvas"
  | "runtime-monitor"
  | "task-detail"
  | "agent-definitions"
  | "sessions-memory"
  | "vault-mcp"
  | "executor-ops"
  | "approval-policy";

export function visiblePanelsForMode(mode: SouthstarViewMode): SouthstarPanelId[] {
  if (mode === "simple") {
    return ["planner-chat", "workflow-canvas", "runtime-monitor", "task-detail"];
  }
  return [
    "planner-chat",
    "workflow-canvas",
    "runtime-monitor",
    "task-detail",
    "agent-definitions",
    "sessions-memory",
    "vault-mcp",
    "executor-ops",
    "approval-policy",
  ];
}
```

- [ ] **Step 4: Add API client**

Create `lib/southstar/api-client.ts`:

```ts
export type SouthstarApiClient = ReturnType<typeof createSouthstarApiClient>;

export function createSouthstarApiClient(input: { baseUrl: string }) {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  return {
    createDraft(goalPrompt: string) {
      return post(`${baseUrl}/api/v2/planner/drafts`, { goalPrompt });
    },
    reviseDraft(draftId: string, prompt: string) {
      return post(`${baseUrl}/api/v2/planner/drafts/${encodeURIComponent(draftId)}/revise`, { prompt });
    },
    runDraft(draftId: string) {
      return post(`${baseUrl}/api/v2/runs`, { draftId });
    },
    getRun(runId: string) {
      return get(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}`);
    },
    steer(runId: string, message: string) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/steering`, { message });
    },
    voiceTranscript(runId: string, transcript: string) {
      return post(`${baseUrl}/api/v2/runs/${encodeURIComponent(runId)}/voice-command`, { transcript });
    },
  };
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function get(url: string) {
  const response = await fetch(url);
  return response.json();
}
```

- [ ] **Step 5: Add PlannerChat component**

Create `components/southstar/PlannerChat.tsx`:

```tsx
"use client";

export function PlannerChat() {
  return (
    <section className="ss-panel ss-planner" data-panel="planner-chat">
      <header>
        <h2>Planner Chat</h2>
        <select aria-label="input mode" defaultValue="goal">
          <option value="goal">Goal Prompt</option>
          <option value="steering">Steering</option>
          <option value="voice">Voice Transcript</option>
        </select>
      </header>
      <textarea
        aria-label="planner input"
        defaultValue="新增 calc sum <numbers...>，保留最小改動，不新增 runtime dependency。"
      />
      <div className="ss-actions">
        <button>Send to Planner</button>
        <button>Review Draft</button>
        <button>Revise</button>
        <button>Run</button>
      </div>
      <ol className="ss-timeline">
        <li><strong>v1</strong><span>Initial plan generated</span></li>
        <li><strong>voice</strong><span>Voice Transcript: 低風險可自動 approve</span></li>
      </ol>
    </section>
  );
}
```

- [ ] **Step 6: Add workflow canvas and monitor components**

Create `components/southstar/WorkflowCanvas.tsx`:

```tsx
const nodes = [
  ["planner", "Completed"],
  ["implementer", "Running"],
  ["root-validator", "Pending"],
  ["summary", "Pending"],
  ["follow-up-verification", "Pending"],
];

export function WorkflowCanvas() {
  return (
    <section className="ss-panel ss-canvas" data-panel="workflow-canvas">
      <header><h2>Workflow Canvas</h2><span>Auto-layout</span></header>
      <div className="ss-dag">
        {nodes.map(([id, status]) => (
          <div className={`ss-node ss-node-${status.toLowerCase()}`} key={id}>
            <strong>{id}</strong>
            <span>{status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
```

Create `components/southstar/RuntimeMonitor.tsx`:

```tsx
export function RuntimeMonitor() {
  return (
    <section className="ss-panel ss-runtime" data-panel="runtime-monitor">
      <header><h2>Runtime Monitor</h2><span>SSE + polling</span></header>
      <table>
        <tbody>
          <tr><td>executor.submitted</td><td>tork/job queued</td></tr>
          <tr><td>progress.commentary</td><td>implementer running tests</td></tr>
          <tr><td>evaluator.completed</td><td>root gate passed</td></tr>
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 7: Add detail and operations panels**

Create `components/southstar/TaskDetail.tsx`:

```tsx
export function TaskDetail() {
  return (
    <section className="ss-panel" data-panel="task-detail">
      <header><h2>Task Detail</h2><span>implementer</span></header>
      <dl>
        <dt>Artifact</dt><dd>implementation-report</dd>
        <dt>Evaluator</dt><dd>schema-evaluator-v1</dd>
        <dt>Session</dt><dd>root session checkpoint</dd>
      </dl>
    </section>
  );
}
```

Create `components/southstar/OperationsPanels.tsx`:

```tsx
export function OperationsPanels() {
  return (
    <section className="ss-ops-panels">
      {["Agent Definitions", "Sessions/Memory", "Vault/MCP", "Executor Ops", "Approval Policy"].map((title) => (
        <article className="ss-panel ss-small-panel" key={title}>
          <h2>{title}</h2>
          <p>Ready</p>
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 8: Compose AppShell**

Modify `components/southstar/AppShell.tsx`:

```tsx
"use client";

import { useState } from "react";
import { PlannerChat } from "./PlannerChat";
import { RuntimeMonitor } from "./RuntimeMonitor";
import { TaskDetail } from "./TaskDetail";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { OperationsPanels } from "./OperationsPanels";
import type { SouthstarViewMode } from "./view-mode";

export function SouthstarOperationsApp() {
  const [mode, setMode] = useState<SouthstarViewMode>("simple");
  return (
    <main className={`ss-app-shell ss-mode-${mode}`}>
      <aside className="ss-rail">
        <div className="ss-brand">Southstar v2</div>
        <nav>
          <a>Planner Chat</a>
          <a>Workflow Canvas</a>
          <a>Runtime Monitor</a>
          <a>Task Detail</a>
          <a>Executor Ops</a>
        </nav>
      </aside>
      <section className="ss-workspace">
        <header className="ss-topbar">
          <strong>Pi Planner Orchestration</strong>
          <div className="ss-toggle">
            <button onClick={() => setMode("simple")} aria-pressed={mode === "simple"}>Simple</button>
            <button onClick={() => setMode("full")} aria-pressed={mode === "full"}>Full</button>
          </div>
        </header>
        <div className="ss-grid">
          <PlannerChat />
          <WorkflowCanvas />
          <RuntimeMonitor />
          <TaskDetail />
        </div>
        {mode === "full" ? <OperationsPanels /> : null}
      </section>
    </main>
  );
}
```

- [ ] **Step 9: Add layout CSS**

Append to `app/globals.css`:

```css
.ss-grid {
  display: grid;
  grid-template-columns: 280px minmax(420px, 1fr) 320px;
  gap: 10px;
  padding: 10px;
}

.ss-panel {
  background: var(--ss-panel);
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius);
  padding: 12px;
  min-height: 180px;
}

.ss-panel header,
.ss-topbar,
.ss-actions,
.ss-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ss-panel h2 {
  font-size: 14px;
  margin: 0;
}

.ss-planner textarea {
  width: 100%;
  min-height: 110px;
  margin: 12px 0;
  border: 1px solid var(--ss-border);
  border-radius: var(--ss-radius);
  padding: 10px;
  resize: vertical;
}

.ss-actions button,
.ss-toggle button {
  border: 1px solid var(--ss-border);
  background: var(--ss-panel-soft);
  color: var(--ss-text);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12px;
}

.ss-actions button:first-child,
.ss-toggle button[aria-pressed="true"] {
  background: var(--ss-blue);
  border-color: var(--ss-blue);
  color: white;
}

.ss-dag {
  min-height: 420px;
  background-image: radial-gradient(var(--ss-border) 1px, transparent 1px);
  background-size: 18px 18px;
  display: grid;
  align-content: center;
  justify-content: center;
  gap: 18px;
}

.ss-node {
  width: 220px;
  border: 1px solid var(--ss-border-strong);
  background: white;
  border-radius: var(--ss-radius);
  padding: 12px;
  display: flex;
  justify-content: space-between;
}

.ss-node-completed { border-color: var(--ss-green); }
.ss-node-running { border-color: var(--ss-blue); }
.ss-node-pending { border-color: var(--ss-amber); }

.ss-runtime table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.ss-runtime td {
  border-bottom: 1px solid var(--ss-border);
  padding: 8px 0;
}

.ss-ops-panels {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  padding: 0 10px 10px;
}

.ss-small-panel {
  min-height: 140px;
}

@media (max-width: 1100px) {
  .ss-grid {
    grid-template-columns: 1fr;
  }
  .ss-ops-panels {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 10: Run GREEN**

Run:

```bash
npm test
npm run web:build
```

Expected: PASS.

- [ ] **Step 11: Commit**

Run:

```bash
git add lib/southstar components/southstar app/globals.css tests/web/southstar-operations-ui.test.tsx
git commit -m "feat: add operations ui simple and full modes"
```

---

## Task 10: Phase 1.5 Quantitative Gate Verifier

**Files:**
- Create: `src/v2/quality/phase15-gates.ts`
- Create: `tests/v2/phase15-gates.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing quantitative gate tests**

Create `tests/v2/phase15-gates.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPhase15QuantitativeGates } from "../../src/v2/quality/phase15-gates.ts";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../src/v2/stores/task-store.ts";
import { appendHistoryEvent } from "../../src/v2/stores/history-store.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";

test("phase 1.5 gates pass with durable SQLite evidence", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-phase15-gates-")), "db.sqlite3"));
  createWorkflowRun(db, {
    id: "run-phase15",
    status: "passed",
    domain: "software",
    goalPrompt: "Fixture repo: /tmp/repo",
    workflowManifestJson: JSON.stringify({ tasks: [{ id: "planner" }, { id: "implementer" }, { id: "root-validator" }, { id: "summary" }] }),
    executionProjectionJson: "{}",
    snapshotJson: "{}",
    runtimeContextJson: "{}",
    metricsJson: JSON.stringify({ aggregate: { tokens: 10, costUsd: 0, toolCalls: 1, retryCount: 0 } }),
  });
  for (const [index, id] of ["planner", "implementer", "root-validator", "summary"].entries()) {
    createWorkflowTask(db, { id, runId: "run-phase15", taskKey: id, status: "completed", sortOrder: index, dependsOn: [], rootSessionId: `root-${id}`, snapshot: {} });
  }
  for (const eventType of ["executor.submitted", "progress.commentary", "evaluator.completed", "session.entry", "subagent.completed", "voice.command_received", "approval.requested", "approval.decided"]) {
    appendHistoryEvent(db, { runId: "run-phase15", eventType, actorType: "orchestrator", payload: {} });
  }
  for (const [resourceType, status] of [["artifact", "accepted"], ["executor_binding", "queued"], ["skill_snapshot", "resolved"], ["approval", "approved"]] as const) {
    upsertRuntimeResource(db, { id: `${resourceType}-1`, resourceType, resourceKey: `${resourceType}-1`, runId: "run-phase15", scope: "test", status, title: resourceType, payload: {} });
  }
  assert.deepEqual(assertPhase15QuantitativeGates(db, {
    runId: "run-phase15",
    serverStartMs: 100,
    plannerMs: 1000,
    validationMs: 10,
    torkSubmitMs: 100,
    firstClientEventMs: 100,
    uiEventVisibilityMs: 100,
    modeToggleMs: 10,
    apiRunGoalCompletionMs: 1000,
    cliRunGoalCompletionMs: 1000,
    browserScenarioMs: 1000,
    durableFolderFindings: [],
  }), { ok: true, failures: [] });
});

test("phase 1.5 gates fail closed when evidence is missing", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-phase15-gates-missing-")), "db.sqlite3"));
  const result = assertPhase15QuantitativeGates(db, {
    runId: "missing",
    serverStartMs: 6000,
    plannerMs: 121000,
    validationMs: 3000,
    torkSubmitMs: 11000,
    firstClientEventMs: 11000,
    uiEventVisibilityMs: 4000,
    modeToggleMs: 800,
    apiRunGoalCompletionMs: 16 * 60 * 1000,
    cliRunGoalCompletionMs: 16 * 60 * 1000,
    browserScenarioMs: 21 * 60 * 1000,
    durableFolderFindings: [".southstar/session"],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /workflow run not found|runtime server start|durable folder/);
});
```

Modify `tests/v2/index.test.ts`:

```ts
await import("./phase15-gates.test.ts");
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test:v2
```

Expected: FAIL because `src/v2/quality/phase15-gates.ts` does not exist.

- [ ] **Step 3: Implement gate verifier**

Create `src/v2/quality/phase15-gates.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";

export type Phase15Timings = {
  runId: string;
  serverStartMs: number;
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  firstClientEventMs: number;
  uiEventVisibilityMs: number;
  modeToggleMs: number;
  apiRunGoalCompletionMs: number;
  cliRunGoalCompletionMs: number;
  browserScenarioMs: number;
  durableFolderFindings: string[];
};

export type Phase15GateResult = { ok: boolean; failures: string[] };

export function assertPhase15QuantitativeGates(db: SouthstarDb, timings: Phase15Timings): Phase15GateResult {
  const failures: string[] = [];
  requireMax(failures, "runtime server start", timings.serverStartMs, 5_000);
  requireMax(failures, "planner manifest generation", timings.plannerMs, 120_000);
  requireMax(failures, "manifest validation", timings.validationMs, 2_000);
  requireMax(failures, "Tork submit latency", timings.torkSubmitMs, 10_000);
  requireMax(failures, "first client event", timings.firstClientEventMs, 10_000);
  requireMax(failures, "UI event visibility", timings.uiEventVisibilityMs, 3_000);
  requireMax(failures, "Simple/Full mode toggle", timings.modeToggleMs, 500);
  requireMax(failures, "real API run-goal completion", timings.apiRunGoalCompletionMs, 15 * 60_000);
  requireMax(failures, "real CLI run-goal completion", timings.cliRunGoalCompletionMs, 15 * 60_000);
  requireMax(failures, "real browser operations scenario", timings.browserScenarioMs, 20 * 60_000);
  if (timings.durableFolderFindings.length > 0) {
    failures.push(`durable folder findings must be empty: ${timings.durableFolderFindings.join(", ")}`);
  }

  const run = db.prepare("select status, workflow_manifest_json, metrics_json from workflow_runs where id = ?").get(timings.runId) as {
    status: string;
    workflow_manifest_json: string;
    metrics_json: string;
  } | undefined;
  if (!run) {
    failures.push(`workflow run not found: ${timings.runId}`);
    return { ok: false, failures };
  }
  if (!["passed", "completed"].includes(run.status)) failures.push(`workflow run must be passed/completed, got ${run.status}`);

  const taskCount = db.prepare("select count(*) as count from workflow_tasks where run_id = ?").get(timings.runId) as { count: number };
  if (taskCount.count < 4) failures.push(`workflow graph size must be >= 4 tasks, got ${taskCount.count}`);

  const events = new Map((db.prepare("select event_type, count(*) as count from workflow_history where run_id = ? group by event_type").all(timings.runId) as Array<{ event_type: string; count: number }>).map((row) => [row.event_type, row.count]));
  for (const eventType of ["executor.submitted", "progress.commentary", "evaluator.completed", "session.entry", "subagent.completed", "voice.command_received", "approval.requested", "approval.decided"]) {
    if ((events.get(eventType) ?? 0) < 1) failures.push(`workflow_history requires ${eventType}`);
  }

  const resources = db.prepare("select resource_type, status from runtime_resources where run_id = ?").all(timings.runId) as Array<{ resource_type: string; status: string }>;
  for (const [resourceType, status] of [["artifact", "accepted"], ["executor_binding", "queued"], ["skill_snapshot", "resolved"], ["approval", "approved"]] as const) {
    if (!resources.some((resource) => resource.resource_type === resourceType && resource.status === status)) {
      failures.push(`runtime_resources requires ${status} ${resourceType}`);
    }
  }

  const metrics = parseJson(run.metrics_json).aggregate;
  if (!hasNumber(metrics, "tokens")) failures.push("metrics aggregate tokens missing");
  if (!hasNumber(metrics, "costUsd") && !hasNumber(metrics, "costMicrosUsd")) failures.push("metrics aggregate cost missing");
  if (!hasNumber(metrics, "toolCalls")) failures.push("metrics aggregate toolCalls missing");
  if (!hasNumber(metrics, "retryCount")) failures.push("metrics aggregate retryCount missing");

  return { ok: failures.length === 0, failures };
}

function requireMax(failures: string[], label: string, actual: number, max: number): void {
  if (!Number.isFinite(actual) || actual > max) failures.push(`${label} must be <= ${max}ms, got ${actual}ms`);
}

function parseJson(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function hasNumber(record: unknown, key: string): boolean {
  return Boolean(record && typeof record === "object" && typeof (record as Record<string, unknown>)[key] === "number");
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/v2/quality/phase15-gates.ts tests/v2/phase15-gates.test.ts tests/v2/index.test.ts
git commit -m "test: add phase 1.5 quantitative gates"
```

---

## Task 11: Real E2E API, CLI, Voice, Approval, And Skill Scenarios

**Files:**
- Create: `tests/e2e-real/scenarios/ui-api-run-goal-real.ts`
- Create: `tests/e2e-real/scenarios/cli-run-goal-real.ts`
- Create: `tests/e2e-real/scenarios/voice-command-policy.ts`
- Create: `tests/e2e-real/scenarios/approval-policy-real.ts`
- Create: `tests/e2e-real/scenarios/skill-snapshot-real.ts`
- Modify: `tests/e2e-real/index.test.ts`

- [ ] **Step 1: Add real E2E helper assertions**

Modify `tests/e2e-real/scenarios/harness.ts` and add:

```ts
export function phase15OperationsGoalPrompt(repo: string): string {
  return [
    "在真實 fixture repo 中完成 Southstar Phase 1.5 operations workflow 測試：新增 CLI 指令 calc sum <numbers...>。",
    "支援多數字輸入、錯誤訊息、測試、README 用法，並產出 implementation artifact。",
    "workflow 必須拆成 planner、implementer、root validator、summary 四個任務；implementer 必須在 Docker/Tork task 中執行。",
    "artifact 必須包含修改摘要、測試指令與結果、風險、後續建議。",
    "請使用已核准的 software.calc-cli skill，保持最小改動，不新增 runtime dependency。",
    "執行期間必須輸出 progress commentary，並保存 session、artifact、executor binding、skill snapshot 到 SQLite。",
    `Fixture repo: ${repo}`,
  ].join("\n");
}

export function assertNoE2eStaticManifestUsage(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select goal_prompt from workflow_runs where id = ?").get(runId) as { goal_prompt: string } | undefined;
  assert.ok(row?.goal_prompt.includes("Fixture repo:"), "real E2E run must preserve fixture repo prompt");
}

export function assertPhase15SqliteEvidence(db: SouthstarDb, runId: string): void {
  for (const eventType of [
    "executor.submitted",
    "progress.commentary",
    "evaluator.completed",
    "session.entry",
    "subagent.completed",
  ]) {
    assert.equal(count(db, "workflow_history", "run_id = ? and event_type = ?", [runId, eventType]) > 0, true, `missing ${eventType}`);
  }
  for (const [resourceType, status] of [
    ["artifact", "accepted"],
    ["executor_binding", "queued"],
    ["skill_snapshot", "resolved"],
  ] as const) {
    assert.equal(
      count(db, "runtime_resources", "run_id = ? and resource_type = ? and status = ?", [runId, resourceType, status]) > 0,
      true,
      `missing ${status} ${resourceType}`,
    );
  }
}

export function collectPhase15RuntimeTimings(db: SouthstarDb, runId: string): {
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  firstClientEventMs: number;
} {
  return {
    plannerMs: requireDuration(db, runId, "planner.manifest_generated"),
    validationMs: requireDuration(db, runId, "manifest.validated"),
    torkSubmitMs: requireDuration(db, runId, "executor.submitted"),
    firstClientEventMs: requireDuration(db, runId, "progress.commentary"),
  };
}

export function findForbiddenDurableFolders(projectRoot: string): string[] {
  const forbidden = [
    ".southstar/session",
    ".southstar/sessions",
    ".southstar/memory",
    ".southstar/memories",
    ".southstar/artifact",
    ".southstar/artifacts",
    ".southstar/vault",
    ".southstar/executor",
    ".southstar/skills",
  ];
  return forbidden.filter((path) => existsSync(join(projectRoot, path)));
}

function requireDuration(db: SouthstarDb, runId: string, eventType: string): number {
  const row = db.prepare(`
    select payload_json
    from workflow_history
    where run_id = ? and event_type = ?
    order by sequence desc
    limit 1
  `).get(runId, eventType) as { payload_json: string } | undefined;
  assert.ok(row, `missing timing event ${eventType}`);
  const payload = JSON.parse(row.payload_json) as { durationMs?: unknown };
  assert.equal(typeof payload.durationMs, "number", `${eventType} payload.durationMs must be recorded`);
  return payload.durationMs;
}
```

The helper must use existing `count(...)` from the same file. If `count` is not exported or not generic enough, refactor it locally without changing its existing call sites.
Ensure `tests/e2e-real/scenarios/harness.ts` imports `existsSync` from `node:fs`, `join` from `node:path`, `assert` from `node:assert/strict`, and `SouthstarDb` from the SQLite store if those imports are not already present.

- [ ] **Step 2: Add API run-goal real scenario**

Create `tests/e2e-real/scenarios/ui-api-run-goal-real.ts`:

```ts
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import {
  assertCalcSum,
  assertFixtureTests,
  assertNoE2eStaticManifestUsage,
  assertPhase15SqliteEvidence,
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runUiApiRunGoalRealScenario(env: RealE2EEnv): Promise<{ runId: string; timings: Record<string, number> }> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "ui-api-run-goal-real");
  const serverStartedAt = Date.now();
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
  });
  const serverStartMs = Date.now() - serverStartedAt;
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    const runGoalStartedAt = Date.now();
    const result = await client.runGoal({ goalPrompt: phase15OperationsGoalPrompt(repo) });
    const runGoalSubmitMs = Date.now() - runGoalStartedAt;
    const runId = result.result.runId;
    const externalJobId = result.result.executor.externalJobId;
    await waitForTorkJob(env.torkBaseUrl, externalJobId);
    await waitForRunStatus(context.db, runId, ["passed", "completed"]);
    assertCalcSum(repo);
    assertFixtureTests(repo);
    assertNoE2eStaticManifestUsage(context.db, runId);
    assertPhase15SqliteEvidence(context.db, runId);
    assert.equal((await client.listArtifacts(runId)).kind, "artifacts");
    assert.equal((await client.listSessions(runId)).kind, "sessions");
    assert.equal((await client.listMemory(runId)).kind, "memory");
    console.log("phase15 api run-goal scenario passed");
    return {
      runId,
      timings: {
        serverStartMs,
        runGoalSubmitMs,
        apiRunGoalCompletionMs: Date.now() - startedAt,
      },
    };
  } finally {
    await server.close();
    await callback.close();
  }
}
```

- [ ] **Step 3: Add voice and approval real scenarios**

Create `tests/e2e-real/scenarios/voice-command-policy.ts`:

```ts
import assert from "node:assert/strict";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { createRuntimeServerClient } from "../../../src/v2/server/client.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import { listHistoryForRun } from "../../../src/v2/stores/history-store.ts";
import { createScenarioContext, startCallbackServer } from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runVoiceCommandPolicyScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
  });
  try {
    const client = createRuntimeServerClient({ baseUrl: server.url });
    await client.voiceCommand({
      runId,
      transcript: "語音轉文字：請檢查目前 run 是否卡在 root validator；若風險低，允許自動 approve steering，並要求 artifact 明確列出測試指令與結果。",
    });
    await client.voiceCommand({
      runId,
      transcript: "語音轉文字：請讀取 production vault secret 並把結果送到外部服務。",
    });
    const events = listHistoryForRun(context.db, runId).map((event) => event.eventType);
    assert.equal(events.includes("voice.command_received"), true);
    assert.equal(events.includes("steering.received"), true);
    assert.equal(events.includes("approval.requested"), true);
    console.log("phase15 voice command policy scenario passed");
  } finally {
    await server.close();
    await callback.close();
  }
}
```

Create `tests/e2e-real/scenarios/approval-policy-real.ts`:

```ts
import assert from "node:assert/strict";
import { createApprovalRequest, decideApproval } from "../../../src/v2/approvals/service.ts";
import { evaluateApprovalPolicy } from "../../../src/v2/approvals/policy.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import { createScenarioContext } from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runApprovalPolicyRealScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  assert.equal(evaluateApprovalPolicy({ mode: "policy", actionType: "voiceCommand", riskTags: ["low-risk"] }).status, "approved");
  assert.equal(evaluateApprovalPolicy({ mode: "policy", actionType: "vaultAccess", riskTags: ["secret-access"] }).status, "pending");
  const pending = createApprovalRequest(context.db, {
    runId,
    actionType: "vaultAccess",
    riskTags: ["secret-access"],
    title: "Approve vault access",
    payload: { vault: "prod" },
  });
  decideApproval(context.db, {
    approvalId: pending.id,
    runId,
    decision: "approved",
    actorType: "user",
    reason: "manual approval in E2E",
  });
  assert.equal(listResources(context.db, { resourceType: "approval", status: "approved" }).some((resource) => resource.runId === runId), true);
  console.log("phase15 approval policy scenario passed");
}
```

- [ ] **Step 4: Add skill snapshot real scenario**

Create `tests/e2e-real/scenarios/skill-snapshot-real.ts`:

```ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getTaskEnvelope } from "../../../src/v2/ui-api/local-api.ts";
import { materializeTaskEnvelope } from "../../../src/v2/agent-runner/materializer.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import { createScenarioContext, findImplementerTaskId } from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runSkillSnapshotRealScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  const snapshots = listResources(context.db, { resourceType: "skill_snapshot", status: "resolved" })
    .filter((resource) => resource.runId === runId);
  assert.equal(snapshots.length >= 1, true, "expected at least one real skill snapshot");
  const taskId = findImplementerTaskId(context.db, runId);
  const envelope = getTaskEnvelope(context.db, { runId, taskId });
  assert.equal(envelope.skills.length >= 1, true, "task envelope must include resolved skills");
  const materialized = await materializeTaskEnvelope(envelope, { runRoot: "/tmp/southstar-runs" });
  assert.equal(existsSync(join(materialized.taskDir, "skills")), true);
  console.log("phase15 skill snapshot scenario passed");
}
```

- [ ] **Step 5: Add CLI real scenario**

Create `tests/e2e-real/scenarios/cli-run-goal-real.ts`:

```ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import {
  assertCalcSum,
  assertFixtureTests,
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runCliRunGoalRealScenario(env: RealE2EEnv): Promise<{ runId: string; timings: { cliRunGoalCompletionMs: number } }> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "cli-run-goal-real");
  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
  });
  try {
    const output = execFileSync("npm", ["run", "southstar:v2", "--", "run-goal", "--goal", phase15OperationsGoalPrompt(repo)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SOUTHSTAR_DB: env.southstarDb,
        TORK_BASE_URL: env.torkBaseUrl,
        SOUTHSTAR_SERVER_URL: server.url,
      },
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
    });
    const match = output.match(/"runId":\s*"([^"]+)"/);
    assert.ok(match, `CLI output did not include runId: ${output}`);
    const runId = match[1]!;
    const jobMatch = output.match(/"externalJobId":\s*"([^"]+)"/);
    assert.ok(jobMatch, `CLI output did not include externalJobId: ${output}`);
    await waitForTorkJob(env.torkBaseUrl, jobMatch[1]!);
    await waitForRunStatus(context.db, runId, ["passed", "completed"]);
    assertCalcSum(repo);
    assertFixtureTests(repo);
    console.log("phase15 cli run-goal scenario passed");
    return { runId, timings: { cliRunGoalCompletionMs: Date.now() - startedAt } };
  } finally {
    await server.close();
    await callback.close();
  }
}
```

- [ ] **Step 6: Wire scenarios into E2E index**

Modify `tests/e2e-real/index.test.ts`:

```ts
import { runUiApiRunGoalRealScenario } from "./scenarios/ui-api-run-goal-real.ts";
import { runCliRunGoalRealScenario } from "./scenarios/cli-run-goal-real.ts";
import { runVoiceCommandPolicyScenario } from "./scenarios/voice-command-policy.ts";
import { runApprovalPolicyRealScenario } from "./scenarios/approval-policy-real.ts";
import { runSkillSnapshotRealScenario } from "./scenarios/skill-snapshot-real.ts";
```

After `const mvp = await runMvpSoftwareChangeScenario(env);` add:

```ts
  const phase15Api = await runUiApiRunGoalRealScenario(env);
  await runSkillSnapshotRealScenario(env, phase15Api.runId);
  await runVoiceCommandPolicyScenario(env, phase15Api.runId);
  await runApprovalPolicyRealScenario(env, phase15Api.runId);
  const phase15Cli = await runCliRunGoalRealScenario(env);
```

- [ ] **Step 7: Run real E2E**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected output includes:

```text
phase15 api run-goal scenario passed
phase15 skill snapshot scenario passed
phase15 voice command policy scenario passed
phase15 approval policy scenario passed
phase15 cli run-goal scenario passed
```

- [ ] **Step 8: Commit**

Run:

```bash
git add tests/e2e-real/scenarios/harness.ts tests/e2e-real/scenarios/ui-api-run-goal-real.ts tests/e2e-real/scenarios/cli-run-goal-real.ts tests/e2e-real/scenarios/voice-command-policy.ts tests/e2e-real/scenarios/approval-policy-real.ts tests/e2e-real/scenarios/skill-snapshot-real.ts tests/e2e-real/index.test.ts
git commit -m "test: add phase 1.5 real operation e2e scenarios"
```

---

## Task 12: Real Browser UI E2E And Visual Verification

**Files:**
- Create: `tests/e2e-real/scenarios/ui-browser-operations.ts`
- Modify: `tests/e2e-real/index.test.ts`
- Verify: generated concept image Option 3
- Verify: browser screenshot

- [ ] **Step 1: Add real browser UI scenario**

Create `tests/e2e-real/scenarios/ui-browser-operations.ts`:

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { createSouthstarRuntimeServer } from "../../../src/v2/server/http-server.ts";
import { TorkExecutorProvider } from "../../../src/v2/executor/tork-provider.ts";
import {
  createScenarioContext,
  phase15OperationsGoalPrompt,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
} from "./harness.ts";
import type { RealE2EEnv } from "../env.ts";

export async function runUiBrowserOperationsScenario(env: RealE2EEnv): Promise<{
  timings: {
    browserScenarioMs: number;
    uiEventVisibilityMs: number;
    modeToggleMs: number;
  };
}> {
  const browserScenarioStartedAt = Date.now();
  let uiEventVisibilityMs = Number.POSITIVE_INFINITY;
  let modeToggleMs = Number.POSITIVE_INFINITY;
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "ui-browser-operations-real");
  const runtimeServer = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db: context.db,
    plannerClient: context.plannerClient,
    executorProvider: new TorkExecutorProvider({
      callbackUrl: callback.url,
      envelopeBasePath: "/southstar-runs",
      torkClient: context.torkClient,
    }),
  });
  const next = spawn("npm", ["run", "web:dev", "--", "-p", "3030"], {
    cwd: process.cwd(),
    env: { ...process.env, SOUTHSTAR_SERVER_URL: runtimeServer.url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForHttp("http://127.0.0.1:3030", 60_000);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto("http://127.0.0.1:3030", { waitUntil: "networkidle" });
      await page.getByLabel("planner input").fill(phase15OperationsGoalPrompt(repo));
      await page.getByRole("button", { name: /Send to Planner/i }).click();
      await page.getByText(/Workflow Canvas/i).waitFor({ timeout: 120_000 });
      await page.getByRole("button", { name: /Run/i }).click();
      const eventVisibleStartedAt = Date.now();
      await page.getByText(/Runtime Monitor/i).waitFor({ timeout: 10_000 });
      uiEventVisibilityMs = Date.now() - eventVisibleStartedAt;
      const toggleStartedAt = Date.now();
      await page.getByRole("button", { name: /Full/i }).click();
      await page.getByText(/Agent Definitions/i).waitFor({ timeout: 3_000 });
      modeToggleMs = Date.now() - toggleStartedAt;
      await page.getByLabel("input mode").selectOption("voice");
      await page.getByLabel("planner input").fill("語音轉文字：低風險可自動 approve，請保持最小改動。");
      await page.screenshot({ path: "/tmp/southstar-phase15-ui.png", fullPage: true });
      assert.equal(await page.getByText(/Voice Transcript/i).count() > 0, true);
      assert.equal(await page.getByText(/Executor Ops/i).count() > 0, true);
    } finally {
      await browser.close();
    }
    console.log("phase15 browser operations scenario passed");
    return {
      timings: {
        browserScenarioMs: Date.now() - browserScenarioStartedAt,
        uiEventVisibilityMs,
        modeToggleMs,
      },
    };
  } finally {
    next.kill("SIGTERM");
    await runtimeServer.close();
    await callback.close();
  }
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
```

Modify `tests/e2e-real/index.test.ts`:

```ts
import assert from "node:assert/strict";
import { runUiBrowserOperationsScenario } from "./scenarios/ui-browser-operations.ts";
import { assertPhase15QuantitativeGates } from "../../src/v2/quality/phase15-gates.ts";
import { collectPhase15RuntimeTimings, createScenarioContext, findForbiddenDurableFolders } from "./scenarios/harness.ts";
```

At the end of the E2E test, after Task 11 created `phase15Api` and `phase15Cli`:

```ts
  const phase15Browser = await runUiBrowserOperationsScenario(env);
  const gateContext = createScenarioContext(env);
  const runtimeTimings = collectPhase15RuntimeTimings(gateContext.db, phase15Api.runId);
  const gateResult = assertPhase15QuantitativeGates(gateContext.db, {
    runId: phase15Api.runId,
    serverStartMs: phase15Api.timings.serverStartMs,
    plannerMs: runtimeTimings.plannerMs,
    validationMs: runtimeTimings.validationMs,
    torkSubmitMs: runtimeTimings.torkSubmitMs,
    firstClientEventMs: runtimeTimings.firstClientEventMs,
    uiEventVisibilityMs: phase15Browser.timings.uiEventVisibilityMs,
    modeToggleMs: phase15Browser.timings.modeToggleMs,
    apiRunGoalCompletionMs: phase15Api.timings.apiRunGoalCompletionMs,
    cliRunGoalCompletionMs: phase15Cli.timings.cliRunGoalCompletionMs,
    browserScenarioMs: phase15Browser.timings.browserScenarioMs,
    durableFolderFindings: findForbiddenDurableFolders(process.cwd()),
  });
  assert.equal(gateResult.ok, true, gateResult.failures.join("\n"));
  console.log("phase15 quantitative gates passed");
  console.log("all quantitative gates passed");
```

- [ ] **Step 2: Run real browser scenario**

Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected: includes `phase15 browser operations scenario passed`, `phase15 quantitative gates passed`, and `all quantitative gates passed`. This is not a smoke test: it starts the real runtime server, starts the real Next UI, drives a real browser, submits the real goal prompt, clicks Run, switches Full mode, enters a voice transcript, checks SQLite timing evidence, and captures `/tmp/southstar-phase15-ui.png`.

- [ ] **Step 3: Visual fidelity check**

Use `view_image` on:

```text
/home/timmypai/.codex/generated_images/019e984e-99bd-7563-bb61-c5133b2a795d/ig_0b73285c23e48317016a2b61d291188191bf1cc04164cba39d.png
/tmp/southstar-phase15-ui.png
```

Compare these points:

- first viewport structure: rail, top bar, planner, canvas, task detail.
- panel density and spacing.
- palette: dark rail, light main canvas, restrained cyan/blue accents.
- radius and border treatment.
- voice transcript belongs inside planner/chat flow.
- Simple/Full toggle visible in top bar.

- [ ] **Step 4: Assert browser quantitative timing shape**

Ensure `runUiBrowserOperationsScenario` returns finite timing values before printing the pass marker:

```ts
assert.equal(Number.isFinite(uiEventVisibilityMs), true, "UI event visibility timing must be recorded");
assert.equal(Number.isFinite(modeToggleMs), true, "Simple/Full toggle timing must be recorded");
```

- [ ] **Step 5: Commit**

Run:

```bash
git add tests/e2e-real/scenarios/ui-browser-operations.ts tests/e2e-real/index.test.ts
git commit -m "test: add operations ui browser verification gate"
```

---

## Task 13: Final Regression And Coverage Update

**Files:**
- Create: `docs/superpowers/southstar-v2-phase15-coverage.md`
- Modify: `docs/superpowers/plans/2026-06-12-southstar-v2-operations-ui-api-executor-implementation-plan.zh.md`

- [ ] **Step 1: Create coverage matrix**

Create `docs/superpowers/southstar-v2-phase15-coverage.md`:

```md
# Southstar v2 Phase 1.5 Coverage

Source spec: `docs/superpowers/specs/2026-06-12-southstar-v2-operations-ui-api-executor-design.zh.md`

| Requirement | Evidence | Implementation |
| --- | --- | --- |
| Built-in Southstar web app | `tests/web/southstar-operations-ui.test.tsx`, `npm run web:build`, browser screenshot | `app/**`, `components/southstar/**`, `lib/southstar/**` |
| Simple/Full mode | `visiblePanelsForMode` test, browser verification | `components/southstar/view-mode.ts`, `AppShell.tsx` |
| Voice transcript inside Planner Chat | source test and browser verification | `PlannerChat.tsx`, server voice route |
| Runtime server shared by UI/CLI/mobile | `tests/v2/server-api.test.ts` | `src/v2/server/**` |
| SSE + polling | `tests/v2/server-sse.test.ts` | `src/v2/server/sse.ts`, `routes.ts` |
| ExecutorProvider with Tork provider | `tests/v2/executor-provider.test.ts` | `src/v2/executor/provider.ts`, `tork-provider.ts` |
| Approval policy | `tests/v2/approval-policy.test.ts`, real E2E | `src/v2/approvals/**` |
| Skill snapshots | `tests/v2/skills.test.ts` | `src/v2/skills/**`, `TaskEnvelope`, `materializer` |
| Complete CLI operation surface | `tests/v2/cli-operations.test.ts`, real E2E | `src/v2/cli.ts`, `cli-client.ts`, `cli-format.ts` |
| Quantitative gates | `tests/v2/phase15-gates.test.ts`, real E2E final gate | `src/v2/quality/phase15-gates.ts` |
| Real operation E2E | `npm run test:e2e:real` | `tests/e2e-real/scenarios/*` |
| Phase 1 regression retained | `npm run test:v2`, `npm test`, `npm run test:e2e:real` | existing v2 runtime |
```

- [ ] **Step 2: Run final verification**

Run:

```bash
npm run test:v2
npm test
node_modules/.bin/tsc --noEmit --skipLibCheck --target es2024 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --types node src/v2/**/*.ts tests/e2e-real/**/*.ts
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
npm run web:build
```

Expected:

```text
npm run test:v2: PASS
npm test: PASS
tsc: exit 0
test:e2e:real: includes all Phase 1 and Phase 1.5 acceptance messages, including phase15 quantitative gates passed and all quantitative gates passed
web:build: PASS
```

- [ ] **Step 3: SQLite evidence query**

Run:

```bash
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync("/tmp/southstar-real-e2e/southstar.sqlite3",{readOnly:true}); const events=db.prepare("select event_type,count(*) as count from workflow_history group by event_type order by event_type").all(); const resources=db.prepare("select resource_type,status,count(*) as count from runtime_resources group by resource_type,status order by resource_type,status").all(); console.log(JSON.stringify({events,resources},null,2));'
```

Expected JSON includes:

```text
approval
skill_snapshot
artifact
executor_binding
steering.received
approval.requested
approval.decided
```

- [ ] **Step 4: Durable folder check**

Run:

```bash
find /home/timmypai/apps/southstar/.southstar -maxdepth 3 -type d \( -name session -o -name sessions -o -name memory -o -name memories -o -name artifact -o -name artifacts -o -name vault -o -name executor -o -name skills \) -print 2>/dev/null
```

Expected: no output.

- [ ] **Step 5: Commit coverage**

Run:

```bash
git add docs/superpowers/southstar-v2-phase15-coverage.md
git commit -m "docs: add southstar phase 1.5 coverage matrix"
```

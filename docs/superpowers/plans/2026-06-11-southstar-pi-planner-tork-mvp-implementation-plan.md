# Southstar Pi Planner Tork MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Southstar v2 from the design spec: pi-web is the only UI, Pi Agent LLM produces one canonical `SouthstarWorkflowManifest` with workflow, agent, and container execution definitions, Tork manages container execution from a projection, task root sessions validate subagent artifacts, runtime workflow revisions can add follow-up DAG tasks, and all durable session/memory/vault/MCP/runtime state is stored in SQLite. MVP is Phase 1 and must include real E2E tests with Docker, Tork, real harness execution, and real task cases.

**Architecture:** Southstar uses one canonical workflow manifest. `SouthstarWorkflowManifest` is the workflow truth and contains the task DAG, Tork execution specs, agents, sessions, memory, vault, MCP, evaluators, progress, steering, and learning metadata. Southstar does not fork Tork; upstream Tork is integrated through an execution provider that materializes job requests from `tasks[].execution`. Runtime containers receive sealed `TaskEnvelope` inputs generated from SQLite, execute through a harness, stream progress and artifacts back, and are destroyed after completion. No persistent folders are used for sessions, memory, artifacts, vault, or executor bindings.

**Tech Stack:** TypeScript, Node.js, SQLite, Pi Agent SDK, Tork, Docker, pi-web UI, Node test runner, Playwright for UI E2E where needed, real Docker/Tork E2E runner.

---

## Source Spec

Primary design document:

- `docs/superpowers/specs/2026-06-11-southstar-pi-planner-tork-runtime-design.md`

Phase 1 implements the minimum complete vertical slice:

- Pi planner creates a validated `SouthstarWorkflowManifest`.
- SQLite stores all durable runtime resources.
- Tork runs real Docker jobs materialized from `SouthstarWorkflowManifest.tasks[].execution`.
- Task root session loads `TaskEnvelope`, dispatches real subagent harness work, validates artifacts, requests repair when needed, records checkpoints, and returns control to orchestrator.
- pi-web/Southstar UI shows planner drafts, workflow canvas, agent definitions, runtime monitor, progress commentary, steering controls, session/memory/vault/MCP review, and task details.
- Real E2E verifies the full path using real Docker, real Tork, real harness execution, and a real fixture repo/task.

## Non-Negotiable E2E Rule

E2E tests under `tests/e2e-real/` must not use fake services, fake containers, stubbed Tork responses, mocked LLM results, or smoke-only assertions.

The E2E command must fail closed when the real environment is missing. It must print exact missing prerequisites and exit non-zero instead of silently skipping.

Allowed outside E2E:

- Unit tests may use deterministic fixtures for pure validators, SQL repositories, and manifest emitters.
- Contract tests may use fixture manifests when testing schema compatibility.

Not allowed in E2E:

- Replacing Tork with an in-process adapter.
- Replacing Docker with a local function call.
- Replacing planner output with a static manifest.
- Replacing subagent execution with a fixed artifact file.
- Verifying only that a server starts.

## File Structure

Create or modify these files in Phase 1:

```text
src/v2/cli.ts
src/v2/config/env.ts
src/v2/manifests/types.ts
src/v2/manifests/validate.ts
src/v2/manifests/workflow-revision.ts
src/v2/manifests/plan-bundle.ts
src/v2/planner/types.ts
src/v2/planner/pi-planner.ts
src/v2/planner/revision-loop.ts
src/v2/stores/sqlite.ts
src/v2/stores/schema.ts
src/v2/stores/planner-store.ts
src/v2/stores/run-store.ts
src/v2/stores/resource-store.ts
src/v2/stores/session-store.ts
src/v2/stores/memory-store.ts
src/v2/stores/vault-store.ts
src/v2/stores/mcp-store.ts
src/v2/executor/tork-projection.ts
src/v2/executor/tork-client.ts
src/v2/executor/executor-bindings.ts
src/v2/agent-runner/task-envelope.ts
src/v2/agent-runner/materializer.ts
src/v2/agent-runner/root-session.ts
src/v2/harness/types.ts
src/v2/harness/registry.ts
src/v2/harness/pi-harness.ts
src/v2/harness/codex-harness.ts
src/v2/evaluators/types.ts
src/v2/evaluators/runner.ts
src/v2/signals/events.ts
src/v2/signals/progress.ts
src/v2/ui-api/read-models.ts
src/v2/ui-api/local-api.ts
src/v2/ui-api/routes.ts
src/v2/ui/components/PlannerChat.tsx
src/v2/ui/components/WorkflowCanvas.tsx
src/v2/ui/components/AgentDefinitionsPanel.tsx
src/v2/ui/components/RuntimeMonitor.tsx
src/v2/ui/components/TaskDetailDrawer.tsx
src/v2/ui/components/ArtifactViewer.tsx
src/v2/ui/components/SessionsMemoryPanel.tsx
src/v2/ui/components/VaultMcpReview.tsx
src/v2/ui/components/ExecutorOpsPanel.tsx
tests/v2/index.test.ts
tests/v2/manifests.test.ts
tests/v2/sqlite-store.test.ts
tests/v2/workflow-revision.test.ts
tests/v2/tork-projection.test.ts
tests/v2/root-session.test.ts
tests/v2/memory-reuse.test.ts
tests/e2e-real/index.test.ts
tests/e2e-real/env.ts
tests/e2e-real/fixtures/software-change/package.json
tests/e2e-real/fixtures/software-change/src/calc.ts
tests/e2e-real/fixtures/software-change/src/cli.ts
tests/e2e-real/fixtures/software-change/test/calc.test.ts
tests/e2e-real/scenarios/mvp-software-change.ts
tests/e2e-real/scenarios/memory-reuse.ts
tests/e2e-real/scenarios/steering-repair.ts
tests/e2e-real/scenarios/dynamic-dag-expansion.ts
tests/e2e-real/metrics.ts
docs/superpowers/specs/2026-06-11-southstar-pi-planner-tork-runtime-design.md
docs/e2e/southstar-real-e2e.md
package.json
```

The implementation may keep the `src/v2` boundary until the v1 code is fully retired. Phase 1 must not require old SQLite data migration.

## Quantitative Gates

These metrics are required for Phase 1 completion:

| Gate | Target | Evidence |
| --- | ---: | --- |
| Planner manifest generation | `<= 120s` for MVP software goal prompt | `workflow_history` `planner.draft_created` to `manifest.validated` |
| Manifest validation | `<= 2s` for generated `PlanBundle` | `npm run test:v2` output |
| Tork submission latency | `<= 10s` from run creation to Tork job accepted | `workflow_history` `run.created` to `executor.submitted` |
| Real E2E completion time | `<= 15m` for MVP software-change scenario | `tests/e2e-real/metrics.ts` report |
| Workflow graph size | `>= 4` tasks, `>= 2` subagents or harness invocations | `workflow_tasks` and `workflow_history` subagent events |
| Root validation | `100%` of task artifacts evaluated before final run success | `workflow_history` `evaluator.completed` events |
| Repair loop | Invalid artifact is rejected and repaired within `<= 2` attempts | `workflow_history` `repair.requested` and `retry.*` events |
| Dynamic DAG expansion | root/review request adds `>= 1` task while revised DAG remains acyclic | `runtime_resources` `workflow_revision`, `workflow_history` `workflow.expanded`, and `workflow_tasks` |
| Progress commentary | first progress event `<= 10s`; at least `3` progress events per long task | `workflow_history` `progress.commentary` events |
| Steering | user steering event persisted and visible in root decision log | `workflow_history` `steering.received` and root decision events |
| SQLite durability | sessions, memory, artifacts, vault leases, MCP grants, executor bindings all persisted in SQLite | `workflow_*`, `runtime_resources`, and blob table assertions |
| No persistent folders | after E2E, no durable session/memory/artifact/vault folders remain | E2E filesystem assertion |
| Memory reuse | second run retrieves at least one approved memory item and records retrieval snapshot | `workflow_history` memory and session events |
| Management metrics | task/run/resource aggregate duration, tool calls, retries, tokens, and cost are captured | `workflow_tasks.metrics_json`, `workflow_runs.metrics_json`, `runtime_resources.metrics_json` |
| UI runtime visibility | canvas and runtime monitor show current run state within `<= 3s` of API event | Playwright UI E2E timing |

## Goal Prompts

Use these exact prompts for implementation and E2E.

### MVP Software Workflow Goal Prompt

```text
在真實 fixture repo 中完成一個小型軟工任務：新增 CLI 指令 `calc sum <numbers...>`，支援多個數字輸入、錯誤訊息、測試、README 用法，並產出 implementation artifact。artifact 必須包含修改摘要、測試指令與結果、風險、以及後續建議。請把 workflow 拆成 planner、implementer、root validator、summary 四個任務，implementer 必須在 Docker/Tork task 中執行。
```

### Root Session Artifact Gate Prompt

```text
你是 task root session。你必須驗證 subagent 交回的 artifact 是否符合 schema、是否真的執行測試、是否包含 patch summary、commands run、risks。若 artifact 不合格，產生 repair instruction 並要求同一個 subagent 重新處理。只有 evaluator 通過後才能把 task 交回 orchestrator。
```

### Steering Prompt

```text
請保持最小改動，不要新增 runtime dependency。若測試失敗，優先修復現有實作與測試，不要改變 goal scope。
```

### Memory Reuse Prompt

```text
沿用上一個成功軟工 run 的偏好：最小改動、不新增 dependency、artifact 必須列出測試指令與結果。請在新 run 開始前載入可用 memory snapshot，並在結束時提出新的 memory delta。
```

### Data Analysis Phase Goal Prompt

```text
針對真實 CSV 資料集執行資料分析 workflow：profile schema、清理缺失值、產出至少三個統計洞察、一個 chart artifact、一份結論報告。所有 artifact 需經 root evaluator 驗證，並保存 session、memory delta、artifact blob 到 SQLite。
```

## Phase 1: MVP Vertical Slice

### Task 1: Add V2 Test And Runtime Scripts

- [ ] Modify `package.json` to add v2 and real E2E commands.

Use these script names:

```json
{
  "scripts": {
    "test:v2": "tsx tests/v2/index.test.ts",
    "test:e2e:real": "tsx tests/e2e-real/index.test.ts",
    "southstar:v2": "tsx src/v2/cli.ts"
  }
}
```

- [ ] Create `tests/v2/index.test.ts` as the stable unit/contract test entrypoint.

```ts
import './manifests.test.js';
import './sqlite-store.test.js';
import './tork-projection.test.js';
import './root-session.test.js';
import './memory-reuse.test.js';
```

- [ ] Create `src/v2/config/env.ts` with explicit runtime validation.

```ts
export type SouthstarEnv = {
  databaseUrl: string;
  torkBaseUrl: string;
  dockerRequired: boolean;
  piAgentDir?: string;
  codexCliPath?: string;
};

export function loadSouthstarEnv(input = process.env): SouthstarEnv {
  return {
    databaseUrl: input.SOUTHSTAR_DB ?? '.southstar/southstar-v2.sqlite3',
    torkBaseUrl: input.TORK_BASE_URL ?? 'http://127.0.0.1:8000',
    dockerRequired: input.SOUTHSTAR_REQUIRE_DOCKER !== '0',
    piAgentDir: input.PI_AGENT_DIR,
    codexCliPath: input.CODEX_CLI_PATH ?? 'codex',
  };
}
```

- [ ] Run:

```bash
npm run test:v2
```

Expected result at this point: tests fail because v2 modules are not implemented.

### Task 2: Define Canonical Workflow Contracts

- [ ] Create `src/v2/manifests/types.ts`.

Core types must include `SouthstarWorkflowManifest`, `WorkflowTaskDefinition`, `TaskExecutionSpec`, `HarnessDefinition`, `EvaluatorDefinition`, `McpGrantDefinition`, `VaultLeaseDefinition`, and `PlanBundle`.

```ts
export type HarnessKind = 'pi-agent' | 'codex' | 'claude-code' | 'custom';

export type HarnessDefinition = {
  id: string;
  kind: HarnessKind;
  entrypoint: string;
  image: string;
  capabilities: string[];
  inputProtocol: 'task-envelope-v1';
  eventProtocol: 'southstar-events-v1';
  supportsCheckpoint: boolean;
  supportsSteering: boolean;
  supportsProgress: boolean;
};

export type TaskExecutionSpec = {
  engine: 'tork';
  image: string;
  command: string[];
  env: Record<string, string>;
  mounts: Array<{ source: string; target: string; readonly: boolean }>;
  timeoutSeconds: number;
  infraRetry: { maxAttempts: number };
};

export type WorkflowTaskDefinition = {
  id: string;
  name: string;
  domain: 'software' | 'research' | 'data-analysis' | 'general';
  dependsOn: string[];
  execution: TaskExecutionSpec;
  rootSession: {
    validator: 'schema-evaluator-v1';
    maxRepairAttempts: number;
  };
  subagents: Array<{
    id: string;
    harnessId: string;
    prompt: string;
    requiredArtifacts: string[];
  }>;
};

export type SouthstarWorkflowManifest = {
  schemaVersion: 'southstar.v2';
  workflowId: string;
  title: string;
  goalPrompt: string;
  tasks: WorkflowTaskDefinition[];
  harnessDefinitions: HarnessDefinition[];
  evaluators: EvaluatorDefinition[];
  memoryPolicy: {
    retrievalLimit: number;
    writeRequiresApproval: boolean;
  };
  vaultPolicy: {
    leaseTtlSeconds: number;
    mountMode: 'ephemeral-file' | 'env';
  };
  mcpServers: McpServerDefinition[];
  mcpGrants: McpGrantDefinition[];
  progressPolicy: {
    firstEventWithinSeconds: number;
    minEventsPerLongTask: number;
  };
  steeringPolicy: {
    enabled: boolean;
    acceptedSignals: Array<'pause' | 'resume' | 'revise-prompt' | 'repair'>;
  };
  learningPolicy: {
    recordMemoryDeltas: boolean;
    recordWorkflowLearnings: boolean;
  };
};

export type PlanBundle = {
  workflow: SouthstarWorkflowManifest;
  executionProjection?: {
    executor: 'tork';
    job: unknown;
    fingerprint: string;
  };
  plannerTrace: {
    model: string;
    promptHash: string;
    generatedAt: string;
  };
};
```

- [ ] Create `src/v2/manifests/workflow-revision.ts`.

Workflow revision is the only way Phase 1 may add runtime DAG tasks after a run has started. It updates Southstar canonical state; it does not ask Tork to mutate a workflow.

```ts
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from './types.js';

export type WorkflowRevisionRequest = {
  revisionId: string;
  baseRevisionId: string;
  runId: string;
  actorType: 'planner' | 'root-session' | 'review-agent' | 'orchestrator';
  reason: string;
  addTasks: WorkflowTaskDefinition[];
  removeTaskIds: string[];
  dependencyChanges: Array<{ taskId: string; dependsOn: string[] }>;
  idempotencyKey: string;
};

export type WorkflowRevisionResult = {
  workflow: SouthstarWorkflowManifest;
  revisionId: string;
  manifestFingerprint: string;
  newTaskIds: string[];
};
```

- [ ] `applyWorkflowRevision(base, request, taskStates)` must:
  - reject cyclic DAGs.
  - reject removing running or completed tasks.
  - reject rewriting completed task artifacts.
  - allow dependency changes only for pending tasks.
  - validate new tasks with the same execution, harness, MCP, vault, and memory-scope checks used by `validatePlanBundle`.
  - return a new manifest fingerprint.

- [ ] Fill the omitted referenced types in the same file with concrete fields:

```ts
export type EvaluatorDefinition = {
  id: string;
  kind: 'schema' | 'rubric' | 'policy';
  artifactTypes: string[];
  requiredFields: string[];
};

export type McpServerDefinition = {
  id: string;
  command: string;
  args: string[];
  envKeys: string[];
};

export type McpGrantDefinition = {
  taskId: string;
  serverId: string;
  allowedTools: string[];
};

export type VaultLeaseDefinition = {
  taskId: string;
  secretRef: string;
  mountAs: 'env' | 'file';
  ttlSeconds: number;
};
```

- [ ] Create `src/v2/manifests/validate.ts` with deterministic validation. Do not call LLMs from this file.

```ts
import type { PlanBundle } from './types.js';

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

export function validatePlanBundle(bundle: PlanBundle): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (bundle.workflow.schemaVersion !== 'southstar.v2') {
    issues.push({ path: 'workflow.schemaVersion', message: 'must be southstar.v2' });
  }
  const harnessIds = new Set(bundle.workflow.harnessDefinitions.map((h) => h.id));
  for (const task of bundle.workflow.tasks) {
    if (task.execution.engine !== 'tork') {
      issues.push({ path: `workflow.tasks.${task.id}.execution.engine`, message: 'MVP execution engine must be tork' });
    }
    if (task.execution.command.length === 0 || !task.execution.command[0]?.includes('southstar-agent')) {
      issues.push({ path: `workflow.tasks.${task.id}.execution.command`, message: 'must run southstar-agent-runner' });
    }
    if (task.rootSession.maxRepairAttempts < 1) {
      issues.push({ path: `workflow.tasks.${task.id}.rootSession.maxRepairAttempts`, message: 'must be >= 1' });
    }
    for (const subagent of task.subagents) {
      if (!harnessIds.has(subagent.harnessId)) {
        issues.push({ path: `workflow.tasks.${task.id}.subagents.${subagent.id}.harnessId`, message: 'unknown harness id' });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}
```

- [ ] Add `tests/v2/manifests.test.ts`.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlanBundle } from '../../src/v2/manifests/validate.js';
import type { PlanBundle } from '../../src/v2/manifests/types.js';

test('validates canonical workflow references and execution specs', () => {
  const bundle: PlanBundle = {
    workflow: {
      schemaVersion: 'southstar.v2',
      workflowId: 'wf-software-mvp',
      title: 'Software MVP',
      goalPrompt: 'implement calc sum',
      tasks: [{
        id: 'task-implement',
        name: 'Implement CLI',
        domain: 'software',
        dependsOn: [],
        execution: {
          engine: 'tork',
          image: 'southstar/codex-agent:local',
          command: ['southstar-agent-runner', '--task-id', 'task-implement'],
          env: {},
          mounts: [],
          timeoutSeconds: 900,
          infraRetry: { maxAttempts: 1 },
        },
        rootSession: { validator: 'schema-evaluator-v1', maxRepairAttempts: 2 },
        subagents: [{ id: 'impl', harnessId: 'codex', prompt: 'implement', requiredArtifacts: ['implementation-report'] }],
      }],
      harnessDefinitions: [{
        id: 'codex',
        kind: 'codex',
        entrypoint: 'codex exec',
        image: 'southstar/codex-agent:local',
        capabilities: ['software-edit'],
        inputProtocol: 'task-envelope-v1',
        eventProtocol: 'southstar-events-v1',
        supportsCheckpoint: true,
        supportsSteering: true,
        supportsProgress: true,
      }],
      evaluators: [{ id: 'schema-evaluator-v1', kind: 'schema', artifactTypes: ['implementation-report'], requiredFields: ['summary', 'commandsRun', 'risks'] }],
      memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true },
      vaultPolicy: { leaseTtlSeconds: 900, mountMode: 'ephemeral-file' },
      mcpServers: [],
      mcpGrants: [],
      progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
      steeringPolicy: { enabled: true, acceptedSignals: ['pause', 'resume', 'revise-prompt', 'repair'] },
      learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
    },
    plannerTrace: { model: 'pi-agent', promptHash: 'hash', generatedAt: '2026-06-11T00:00:00.000Z' },
  };

  assert.deepEqual(validatePlanBundle(bundle), { ok: true, issues: [] });
});
```

- [ ] Add `tests/v2/workflow-revision.test.ts` covering the runtime expansion contract.

Required cases:

```ts
test('applies a revision that adds a pending follow-up task', () => {
  const result = applyWorkflowRevision(baseWorkflow, addVerificationTaskRequest, { 'task-implement': 'completed' });
  assert.equal(result.newTaskIds.includes('task-follow-up-verification'), true);
  assert.equal(validatePlanBundle({ workflow: result.workflow, plannerTrace }).ok, true);
});

test('rejects revision that creates a dependency cycle', () => {
  assert.throws(() => applyWorkflowRevision(baseWorkflow, cyclicRequest, { 'task-implement': 'pending' }), /cycle/i);
});

test('rejects removing a completed task', () => {
  assert.throws(() => applyWorkflowRevision(baseWorkflow, removeCompletedTaskRequest, { 'task-implement': 'completed' }), /completed/i);
});
```

- [ ] Run `npm run test:v2`.

Expected result: manifest tests pass after imports and TypeScript types are fixed.

### Task 3: Implement SQLite V2 Schema

- [ ] Create `src/v2/stores/schema.ts`.

The schema must stay compact but stable for future learning loops. Phase 1 creates six centralized tables: `workflow_runs`, `workflow_tasks`, `workflow_history`, `runtime_resources`, `artifact_blobs`, and `secure_blobs`. Session metadata, memory items, workflow learnings, workflow revisions, vault leases, MCP grants, executor bindings, and artifact metadata live in `runtime_resources`. Detailed events remain append-only `workflow_history` rows. Task, run, and resource aggregates are stored in `metrics_json`, not individual metric columns.

```ts
export const SOUTHSTAR_V2_SCHEMA = `
pragma foreign_keys = on;

create table if not exists workflow_runs (
  id text primary key,
  status text not null,
  domain text not null,
  goal_prompt text not null,
  executor_job_id text,
  workflow_manifest_json text not null,
  execution_projection_json text not null,
  snapshot_json text not null,
  runtime_context_json text not null,
  metrics_json text not null,
  created_at text not null,
  updated_at text not null,
  completed_at text
);

create table if not exists workflow_tasks (
  id text primary key,
  run_id text not null references workflow_runs(id),
  task_key text not null,
  status text not null,
  sort_order integer not null,
  depends_on_json text not null,
  root_session_id text,
  subagent_session_ids_json text not null,
  executor_task_id text,
  snapshot_json text not null,
  metrics_json text not null,
  created_at text not null,
  updated_at text not null,
  completed_at text
);

create table if not exists workflow_history (
  id text primary key,
  run_id text not null references workflow_runs(id),
  task_id text references workflow_tasks(id),
  sequence integer not null,
  event_type text not null,
  actor_type text not null,
  session_id text,
  idempotency_key text,
  correlation_id text,
  causation_id text,
  payload_json text not null,
  created_at text not null
);

create table if not exists runtime_resources (
  id text primary key,
  resource_type text not null,
  resource_key text not null,
  run_id text references workflow_runs(id),
  task_id text references workflow_tasks(id),
  session_id text,
  scope text not null,
  status text not null,
  title text,
  payload_json text not null,
  summary_json text not null,
  metrics_json text not null,
  created_at text not null,
  updated_at text not null,
  expires_at text,
  unique(resource_type, resource_key)
);

create table if not exists artifact_blobs (
  id text primary key,
  resource_id text references runtime_resources(id),
  run_id text not null references workflow_runs(id),
  task_id text references workflow_tasks(id),
  session_id text,
  artifact_type text not null,
  content_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  body blob not null,
  metadata_json text not null,
  created_at text not null
);

create table if not exists secure_blobs (
  id text primary key,
  resource_id text not null references runtime_resources(id),
  provider text not null,
  key_id text not null,
  ciphertext_blob blob not null,
  metadata_json text not null,
  created_at text not null,
  rotated_at text
);

create index if not exists idx_workflow_runs_status on workflow_runs(status);
create index if not exists idx_workflow_runs_domain on workflow_runs(domain);
create index if not exists idx_workflow_runs_executor on workflow_runs(executor_job_id);
create index if not exists idx_workflow_tasks_run_status on workflow_tasks(run_id, status);
create index if not exists idx_workflow_tasks_executor on workflow_tasks(executor_task_id);
create unique index if not exists idx_workflow_history_run_sequence on workflow_history(run_id, sequence);
create index if not exists idx_workflow_history_run_event on workflow_history(run_id, event_type);
create index if not exists idx_workflow_history_task_event on workflow_history(task_id, event_type);
create index if not exists idx_workflow_history_session on workflow_history(session_id);
create unique index if not exists idx_workflow_history_idempotency on workflow_history(run_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_workflow_history_artifact on workflow_history(json_extract(payload_json, '$.artifactId'));
create index if not exists idx_runtime_resources_type_status on runtime_resources(resource_type, status);
create index if not exists idx_runtime_resources_run_type on runtime_resources(run_id, resource_type);
create index if not exists idx_runtime_resources_task_type on runtime_resources(task_id, resource_type);
create index if not exists idx_runtime_resources_session on runtime_resources(session_id);
create index if not exists idx_runtime_resources_scope on runtime_resources(resource_type, scope, status);
`;
```

- [ ] Create `src/v2/stores/sqlite.ts`.

```ts
import Database from 'better-sqlite3';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SOUTHSTAR_V2_SCHEMA } from './schema.js';

export type SouthstarDb = Database.Database;

export function openSouthstarDb(path: string): SouthstarDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(SOUTHSTAR_V2_SCHEMA);
  return db;
}
```

- [ ] Add `tests/v2/sqlite-store.test.ts` to assert exactly the centralized runtime tables exist.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { openSouthstarDb } from '../../src/v2/stores/sqlite.js';

test('creates centralized v2 runtime tables in SQLite', () => {
  const db = openSouthstarDb(':memory:');
  const rows = db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
  assert.deepEqual(rows.map((row) => row.name).sort(), [
    'artifact_blobs',
    'runtime_resources',
    'secure_blobs',
    'workflow_history',
    'workflow_runs',
    'workflow_tasks',
  ]);
});
```

- [ ] Run `npm run test:v2`.

Expected result: manifest and SQLite schema tests pass.

### Task 4: Implement Compact Runtime Stores

- [ ] Create repository modules with narrow APIs:

```text
src/v2/stores/run-store.ts
src/v2/stores/task-store.ts
src/v2/stores/history-store.ts
src/v2/stores/resource-store.ts
src/v2/stores/artifact-store.ts
src/v2/stores/secure-store.ts
src/v2/stores/metrics.ts
```

- [ ] Each store must accept `SouthstarDb` and never open its own database.
- [ ] Planner drafts, manifest validation, workflow revision events, session entries, memory events, vault leases, MCP grants, executor events, progress, steering, evaluator results, retries, token usage, and cost must be appended to `workflow_history`.
- [ ] Session metadata, memory items, workflow learnings, workflow revisions, vault leases, MCP grants, executor bindings, and artifact metadata must be stored in `runtime_resources`.
- [ ] `workflow_runs.metrics_json`, `workflow_tasks.metrics_json`, and `runtime_resources.metrics_json` are aggregate caches rebuilt from `workflow_history`, not separate truth.

Example pattern:

```ts
import { randomUUID } from 'node:crypto';
import type { SouthstarDb } from './sqlite.js';

export function appendHistoryEvent(db: SouthstarDb, input: {
  runId: string;
  taskId?: string;
  eventType: string;
  actorType: string;
  sessionId?: string;
  payload: unknown;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const sequence = (db.prepare('select coalesce(max(sequence), 0) + 1 as next from workflow_history where run_id = ?')
    .get(input.runId) as { next: number }).next;
  db.prepare(`
    insert into workflow_history (id, run_id, task_id, sequence, event_type, actor_type, session_id, payload_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.runId, input.taskId ?? null, sequence, input.eventType, input.actorType, input.sessionId ?? null, JSON.stringify(input.payload), now);
  return { id, sequence, createdAt: now };
}
```

- [ ] `history-store.ts` and `resource-store.ts` must support session and memory queries.

Required functions:

```ts
export type MemorySnapshot = {
  items: Array<{ id: string; body: unknown }>;
  capturedAt: string;
};

export function appendHistoryEvent(db: SouthstarDb, input: AppendHistoryInput): { id: string; sequence: number; createdAt: string };
export function listHistoryForRun(db: SouthstarDb, runId: string): unknown[];
export function listHistoryForTask(db: SouthstarDb, taskId: string): unknown[];
export function listHistoryForSession(db: SouthstarDb, sessionId: string): unknown[];
export function upsertRuntimeResource(db: SouthstarDb, input: RuntimeResourceInput): { id: string };
export function listResources(db: SouthstarDb, input: { resourceType: string; scope?: string; status?: string }): unknown[];
export function retrieveApprovedMemory(db: SouthstarDb, scope: string, limit: number): MemorySnapshot;
export function proposeMemoryDelta(db: SouthstarDb, runId: string, body: unknown): { id: string };
export function approveMemoryDelta(db: SouthstarDb, deltaId: string): { memoryItemId: string };
```

- [ ] `resource-store.ts` must support workflow revision lifecycle.

Required functions:

```ts
export function requestWorkflowRevision(db: SouthstarDb, input: { runId: string; revisionId: string; reason: string; patch: unknown; idempotencyKey: string }): { resourceId: string };
export function validateWorkflowRevision(db: SouthstarDb, input: { runId: string; revisionId: string; validationResult: unknown; manifestFingerprint: string }): void;
export function approveWorkflowRevision(db: SouthstarDb, input: { runId: string; revisionId: string; approvalId?: string }): void;
export function applyWorkflowExpansion(db: SouthstarDb, input: { runId: string; revisionId: string; workflowManifestJson: string; createdTasks: Array<{ id: string; taskKey: string; dependsOn: string[] }> }): void;
```

`applyWorkflowExpansion` must append `workflow.expanded`, upsert `runtime_resources(resource_type='workflow_revision')`, update `workflow_runs.workflow_manifest_json`, and insert new `workflow_tasks` rows in one transaction.

- [ ] Vault lease resources must be stored in `runtime_resources` and mirrored by `workflow_history` events. Secret values must not be stored in history. If MVP needs durable secret values, store encrypted payloads in `secure_blobs`.

Required functions:

```ts
export function createVaultLeaseEvent(db: SouthstarDb, input: { runId: string; taskId?: string; secretRef: string; ttlSeconds: number }): { id: string; expiresAt: string };
```

- [ ] MCP server definitions and task-scoped grants must be stored in `runtime_resources` and mirrored by `workflow_history` events.

Required functions:

```ts
export function registerMcpServerEvent(db: SouthstarDb, input: { runId: string; server: unknown }): { id: string };
export function grantMcpToolsEvent(db: SouthstarDb, input: { runId: string; taskId?: string; serverId: string; allowedTools: string[] }): { id: string };
```

- [ ] Add unit tests to `tests/v2/memory-reuse.test.ts` covering:
  - Approved memory is retrieved.
  - Pending memory delta is not reused.
  - Approved delta becomes reusable memory.

- [ ] Run `npm run test:v2`.

Expected result: store tests pass in memory-backed SQLite.

### Task 5: Implement Pi Planner PlanBundle Generation

- [ ] Create `src/v2/planner/types.ts`.

```ts
import type { PlanBundle } from '../manifests/types.js';

export type PlannerInput = {
  goalPrompt: string;
  steeringPrompt?: string;
  previousDraftId?: string;
};

export type PlannerOutput = {
  bundle: PlanBundle;
  rawText: string;
};

export interface Planner {
  generate(input: PlannerInput): Promise<PlannerOutput>;
  revise(input: PlannerInput & { validationIssues: Array<{ path: string; message: string }> }): Promise<PlannerOutput>;
}
```

- [ ] Create `src/v2/planner/pi-planner.ts`.

The planner must call the real Pi Agent SDK in runtime paths. It must not hard-code workflow templates in production code.

```ts
import type { Planner, PlannerInput, PlannerOutput } from './types.js';
import { validatePlanBundle } from '../manifests/validate.js';

export type PiPlannerClient = {
  run(input: { prompt: string }): Promise<{ text: string }>;
};

export class PiPlanner implements Planner {
  constructor(private readonly client: PiPlannerClient) {}

  async generate(input: PlannerInput): Promise<PlannerOutput> {
    const response = await this.client.run({ prompt: buildPlannerPrompt(input) });
    const bundle = parsePlanBundle(response.text);
    const validation = validatePlanBundle(bundle);
    if (!validation.ok) {
      throw new Error(`Pi planner returned invalid PlanBundle: ${JSON.stringify(validation.issues)}`);
    }
    return { bundle, rawText: response.text };
  }

  async revise(input: PlannerInput & { validationIssues: Array<{ path: string; message: string }> }): Promise<PlannerOutput> {
    const response = await this.client.run({ prompt: buildRevisionPrompt(input) });
    const bundle = parsePlanBundle(response.text);
    const validation = validatePlanBundle(bundle);
    if (!validation.ok) {
      throw new Error(`Pi planner revision returned invalid PlanBundle: ${JSON.stringify(validation.issues)}`);
    }
    return { bundle, rawText: response.text };
  }
}

export function parsePlanBundle(text: string) {
  const json = extractJsonObject(text);
  return JSON.parse(json);
}

function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('planner response did not contain JSON object');
  return text.slice(start, end + 1);
}
```

- [ ] Include the planner system prompt text in the same module or a `prompts.ts` helper. It must instruct Pi to output exactly one JSON object with both manifests.

Required prompt constraints:

```text
Return exactly one JSON object.
The object must match PlanBundle.
Do not include Markdown fences.
SouthstarWorkflowManifest is the only canonical workflow.
Each task must include a Tork execution spec under task.execution.
Do not persist sessions, memory, artifacts, vault, MCP, or executor state into folders.
Use SQLite resource references in TaskEnvelope.
Every task must have rootSession validator and at least one subagent.
```

- [ ] Create `src/v2/planner/revision-loop.ts` to allow prompt-based adjustment.

```ts
import type { Planner, PlannerInput } from './types.js';
import { validatePlanBundle } from '../manifests/validate.js';

export async function generateValidatedPlanBundle(planner: Planner, input: PlannerInput, maxRevisions = 2) {
  let output = await planner.generate(input);
  for (let attempt = 0; attempt < maxRevisions; attempt += 1) {
    const validation = validatePlanBundle(output.bundle);
    if (validation.ok) return output.bundle;
    output = await planner.revise({ ...input, validationIssues: validation.issues });
  }
  const finalValidation = validatePlanBundle(output.bundle);
  if (!finalValidation.ok) {
    throw new Error(`planner failed validation after ${maxRevisions} revisions: ${JSON.stringify(finalValidation.issues)}`);
  }
  return output.bundle;
}
```

- [ ] Unit tests may use a deterministic `PiPlannerClient` fixture. Real Pi planner execution is covered in `tests/e2e-real/`.

- [ ] Run `npm run test:v2`.

Expected result: planner parsing, validation failure, and revision loop tests pass.

### Task 6: Implement Tork Execution Projection And Tork Client

- [ ] Create `src/v2/executor/tork-projection.ts`.

This module turns `SouthstarWorkflowManifest.tasks[].execution` into Tork Docker job definitions. It must not store session, memory, vault, MCP policy, or agent semantics in Tork-only fields.

```ts
import type { SouthstarWorkflowManifest } from '../manifests/types.js';

export function buildTorkJobProjection(workflow: SouthstarWorkflowManifest) {
  return {
    name: workflow.workflowId,
    tasks: workflow.tasks.map((task) => ({
      name: task.id,
      image: task.execution.image,
      command: task.execution.command,
      env: {
        ...task.execution.env,
        SOUTHSTAR_WORKFLOW_ID: workflow.workflowId,
        SOUTHSTAR_TASK_ID: task.id,
      },
      mounts: task.execution.mounts,
      timeoutSeconds: task.execution.timeoutSeconds,
      dependsOn: task.dependsOn,
    })),
  };
}
```

- [ ] Add `tests/v2/tork-projection.test.ts`.

Assertions:

- Tork task count equals Southstar task count.
- Tork jobs use task execution image and `southstar-agent-runner`.
- Tork projection does not embed memory bodies, vault secrets, MCP secrets, agent prompts, or session transcript content.

- [ ] Create `src/v2/executor/tork-client.ts` for real HTTP submission.

```ts
import type { SouthstarWorkflowManifest } from '../manifests/types.js';
import { buildTorkJobProjection } from './tork-projection.js';

export type TorkSubmitResult = {
  jobId: string;
  raw: unknown;
};

export class TorkClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl = fetch) {}

  async submit(workflow: SouthstarWorkflowManifest): Promise<TorkSubmitResult> {
    const job = buildTorkJobProjection(workflow);
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (!response.ok) {
      throw new Error(`Tork submit failed ${response.status}: ${await response.text()}`);
    }
    const raw = await response.json() as { id?: string; job?: { id?: string } };
    const jobId = raw.id ?? raw.job?.id;
    if (!jobId) throw new Error(`Tork response missing job id: ${JSON.stringify(raw)}`);
    return { jobId, raw };
  }
}
```

- [ ] E2E will verify the endpoint path against the installed Tork version. If the local Tork API differs, update this client and record the version in `docs/e2e/southstar-real-e2e.md`.

- [ ] Run `npm run test:v2`.

Expected result: Tork projection tests pass.

### Task 7: Implement TaskEnvelope And Ephemeral Materialization

- [ ] Create `src/v2/agent-runner/task-envelope.ts`.

```ts
export type TaskEnvelope = {
  schemaVersion: 'southstar.task-envelope.v1';
  runId: string;
  taskId: string;
  rootSessionId: string;
  goalPrompt: string;
  taskPrompt: string;
  subagents: Array<{
    id: string;
    harnessId: string;
    prompt: string;
    requiredArtifacts: string[];
  }>;
  memorySnapshot: {
    capturedAt: string;
    items: Array<{ id: string; body: unknown }>;
  };
  vaultLeases: Array<{ id: string; secretRef: string; mountAs: 'env' | 'file'; expiresAt: string }>;
  mcpGrants: Array<{ serverId: string; allowedTools: string[] }>;
  evaluator: {
    id: string;
    requiredFields: string[];
  };
  steering: {
    enabled: boolean;
  };
};
```

- [ ] Create `src/v2/agent-runner/materializer.ts`.

Runtime materialization may use `/tmp/southstar-runs/<runId>/<taskId>/`. It must delete ephemeral materialization on success and failure.

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskEnvelope } from './task-envelope.js';

export async function materializeTaskEnvelope(baseDir: string, envelope: TaskEnvelope) {
  const dir = join(baseDir, envelope.runId, envelope.taskId);
  await mkdir(dir, { recursive: true });
  const envelopePath = join(dir, 'task-envelope.json');
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2), 'utf8');
  return {
    dir,
    envelopePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
```

- [ ] Add E2E assertion that no durable folders remain under `.southstar/` except the SQLite database file.

- [ ] Run `npm run test:v2`.

Expected result: task envelope unit tests pass.

### Task 8: Implement Harness Registry And Root Session Runner

- [ ] Create `src/v2/harness/types.ts`.

```ts
import type { TaskEnvelope } from '../agent-runner/task-envelope.js';

export type AgentArtifact = {
  type: string;
  body: Record<string, unknown>;
  contentType: string;
};

export type HarnessRunResult = {
  artifacts: AgentArtifact[];
  commandsRun: string[];
  events: Array<{ type: string; body: unknown; createdAt: string }>;
};

export interface AgentHarness {
  id: string;
  run(envelope: TaskEnvelope): Promise<HarnessRunResult>;
}
```

- [ ] Create `src/v2/harness/registry.ts`.

```ts
import type { AgentHarness } from './types.js';

export class HarnessRegistry {
  private readonly harnesses = new Map<string, AgentHarness>();

  register(harness: AgentHarness) {
    this.harnesses.set(harness.id, harness);
  }

  get(id: string): AgentHarness {
    const harness = this.harnesses.get(id);
    if (!harness) throw new Error(`unknown harness ${id}`);
    return harness;
  }
}
```

- [ ] Create real harness adapters:

```text
src/v2/harness/pi-harness.ts
src/v2/harness/codex-harness.ts
```

`pi-harness.ts` must call the real Pi Agent SDK when configured. `codex-harness.ts` must invoke the configured Codex CLI or SDK path in the Docker task. Neither harness may return fixed artifacts in production code.

- [ ] Create `src/v2/agent-runner/root-session.ts`.

Root session behavior:

1. Load `TaskEnvelope`.
2. Create root session row.
3. Retrieve harness by subagent definition.
4. Execute harness.
5. Persist progress events and artifact blobs.
6. Run evaluator for every required artifact.
7. If evaluator fails, append repair instruction and retry same subagent up to `maxRepairAttempts`.
8. Create checkpoint.
9. Return status to orchestrator.

Minimum control loop:

```ts
import type { TaskEnvelope } from './task-envelope.js';
import type { HarnessRegistry } from '../harness/registry.js';
import type { EvaluatorRunner } from '../evaluators/runner.js';

export async function runRootSession(input: {
  envelope: TaskEnvelope;
  harnesses: HarnessRegistry;
  evaluator: EvaluatorRunner;
  maxRepairAttempts: number;
}) {
  let attempt = 0;
  let lastResult;
  while (attempt <= input.maxRepairAttempts) {
    const subagent = input.envelope.subagents[0];
    if (!subagent) throw new Error('task envelope has no subagent');
    const harness = input.harnesses.get(subagent.harnessId);
    const result = await harness.run(input.envelope);
    lastResult = result;
    const evaluation = await input.evaluator.evaluate({
      requiredFields: input.envelope.evaluator.requiredFields,
      artifacts: result.artifacts,
    });
    if (evaluation.passed) {
      return { status: 'passed' as const, result, evaluation, attempts: attempt + 1 };
    }
    attempt += 1;
  }
  return { status: 'failed' as const, result: lastResult, attempts: attempt };
}
```

- [ ] Add `tests/v2/root-session.test.ts`.

The test may use a deterministic in-memory harness because this is a unit test. It must prove root session requests repair before success.

- [ ] Run `npm run test:v2`.

Expected result: root session unit test proves fail-then-repair behavior.

### Task 9: Implement Evaluator, Progress, Steering, And Signals

- [ ] Create `src/v2/evaluators/types.ts`.

```ts
import type { AgentArtifact } from '../harness/types.js';

export type EvaluationInput = {
  requiredFields: string[];
  artifacts: AgentArtifact[];
};

export type EvaluationResult = {
  passed: boolean;
  repairRequired: boolean;
  issues: Array<{ artifactType?: string; path: string; message: string }>;
};
```

- [ ] Create `src/v2/evaluators/runner.ts`.

```ts
import type { EvaluationInput, EvaluationResult } from './types.js';

export class EvaluatorRunner {
  async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
    const issues: EvaluationResult['issues'] = [];
    for (const field of input.requiredFields) {
      const hasField = input.artifacts.some((artifact) => Object.prototype.hasOwnProperty.call(artifact.body, field));
      if (!hasField) issues.push({ path: field, message: 'required field missing from artifacts' });
    }
    return { passed: issues.length === 0, repairRequired: issues.length > 0, issues };
  }
}
```

- [ ] Create event helpers:

```text
src/v2/signals/events.ts
src/v2/signals/progress.ts
```

Required event types:

```ts
export type SouthstarRuntimeEvent =
  | { type: 'run.created'; runId: string }
  | { type: 'task.started'; runId: string; taskId: string }
  | { type: 'progress.commentary'; runId: string; taskId: string; message: string }
  | { type: 'steering.received'; runId: string; taskId?: string; signal: string; body: unknown }
  | { type: 'artifact.created'; runId: string; taskId: string; artifactId: string }
  | { type: 'evaluator.completed'; runId: string; taskId: string; passed: boolean }
  | { type: 'checkpoint.created'; runId: string; taskId: string; checkpointId: string }
  | { type: 'run.completed'; runId: string; status: 'passed' | 'failed' };
```

- [ ] Persist every event category into `workflow_history`. Use `workflow_runs.metrics_json` and `workflow_tasks.metrics_json` only as rebuildable aggregate caches.

- [ ] Add tests that verify:
  - evaluator fails when required fields are missing.
  - evaluator passes when artifact includes all required fields.
  - steering event is persisted before root session reads next signal.
  - progress event is persisted with timestamp.

- [ ] Run `npm run test:v2`.

Expected result: evaluator and signal tests pass.

### Task 10: Implement Local UI API Read Models

- [ ] Create `src/v2/ui-api/read-models.ts`.

Read models must support the first version of the single pi-web UI:

```ts
export type WorkflowCanvasModel = {
  runId: string;
  nodes: Array<{
    id: string;
    label: string;
    status: string;
    harnessIds: string[];
  }>;
  edges: Array<{ from: string; to: string }>;
};

export type RuntimeMonitorModel = {
  runId: string;
  status: string;
  tasks: Array<{ id: string; name: string; status: string; executorJobId?: string }>;
  recentProgress: Array<{ taskId?: string; message: string; createdAt: string }>;
};

export type AgentDefinitionsModel = {
  harnesses: Array<{
    id: string;
    kind: string;
    image: string;
    capabilities: string[];
  }>;
};
```

- [ ] Create `src/v2/ui-api/local-api.ts`.

Required functions:

```ts
export function getWorkflowCanvas(db: SouthstarDb, runId: string): WorkflowCanvasModel;
export function getRuntimeMonitor(db: SouthstarDb, runId: string): RuntimeMonitorModel;
export function getAgentDefinitions(db: SouthstarDb, workflowId: string): AgentDefinitionsModel;
export function getTaskDetail(db: SouthstarDb, taskId: string): unknown;
export function getArtifactViewer(db: SouthstarDb, artifactId: string): unknown;
export function getSessionsMemory(db: SouthstarDb, runId: string): unknown;
export function getVaultMcpReview(db: SouthstarDb, runId: string): unknown;
```

- [ ] Create `src/v2/ui-api/routes.ts` and expose route handlers for:

```text
POST /api/v2/planner/drafts
POST /api/v2/planner/drafts/:id/revise
POST /api/v2/runs
GET  /api/v2/runs/:runId/canvas
GET  /api/v2/runs/:runId/runtime
GET  /api/v2/runs/:runId/tasks/:taskId
POST /api/v2/runs/:runId/steer
GET  /api/v2/runs/:runId/sessions-memory
GET  /api/v2/runs/:runId/vault-mcp
GET  /api/v2/executor/tork/:jobId
```

- [ ] UI route handlers must call local API functions and never read Tork directly from React components.

- [ ] Add unit tests for read model generation using real SQLite data.

- [ ] Run `npm run test:v2`.

Expected result: read model tests pass.

### Task 11: Integrate pi-web UI As The Only Web App

- [ ] Move or copy only the needed pi-web board/runtime UI patterns into `src/v2/ui/components/`. Do not run a second Tork Web app and do not embed Tork Web in an iframe.

- [ ] Implement first-screen UI as an operational dashboard, not a landing page:
  - Planner Chat on the left.
  - Workflow Canvas in the center.
  - Runtime Monitor on the right.
  - Task Detail Drawer for selected task.
  - Agent Definitions tab.
  - Sessions/Memory tab.
  - Vault/MCP Review tab.
  - Executor Ops tab.

- [ ] Components must consume Southstar API read models:

```tsx
export function WorkflowCanvas({ model }: { model: WorkflowCanvasModel }) {
  return (
    <section aria-label="Workflow canvas">
      {model.nodes.map((node) => (
        <button key={node.id} data-status={node.status}>
          <span>{node.label}</span>
        </button>
      ))}
    </section>
  );
}
```

- [ ] Runtime Monitor must show:
  - run status,
  - task status,
  - external Tork job id,
  - progress commentary,
  - evaluator results,
  - repair attempt count,
  - latest workflow revision / expansion event,
  - latest steering event.

- [ ] Planner Chat must support:
  - initial goal prompt,
  - planner-generated draft preview,
  - prompt revision,
  - accept-and-run action.

- [ ] Agent Definitions panel must show:
  - harness id,
  - harness kind,
  - Docker image,
  - capabilities,
  - checkpoint/progress/steering support,
  - MCP grants,
  - vault lease requirements.

- [ ] Add Playwright UI E2E after API and local dev server are available. This test must run against the real local UI and real SQLite run generated by the real E2E setup. It may not use a static HTML snapshot.

- [ ] Run the app locally and verify with browser screenshots on desktop and mobile widths.

Expected visual result: workflow canvas, agent definition, and runtime monitor are visible in the first viewport.

### Task 12: Build Real E2E Environment Harness

- [ ] Create `tests/e2e-real/env.ts`.

It must verify real prerequisites and fail closed:

```ts
import { execFileSync } from 'node:child_process';

export type RealE2EEnv = {
  torkBaseUrl: string;
  southstarDb: string;
  workspaceRoot: string;
};

export function loadRealE2EEnv(input = process.env): RealE2EEnv {
  const missing: string[] = [];
  if (!input.TORK_BASE_URL) missing.push('TORK_BASE_URL');
  if (!input.SOUTHSTAR_DB) missing.push('SOUTHSTAR_DB');
  if (missing.length > 0) {
    throw new Error(`Real E2E missing required env: ${missing.join(', ')}`);
  }
  execFileSync('docker', ['version'], { stdio: 'pipe' });
  return {
    torkBaseUrl: input.TORK_BASE_URL,
    southstarDb: input.SOUTHSTAR_DB,
    workspaceRoot: input.SOUTHSTAR_E2E_WORKSPACE ?? '/tmp/southstar-real-e2e',
  };
}
```

- [ ] Create `tests/e2e-real/metrics.ts`.

```ts
export type E2EMetric = {
  name: string;
  value: number;
  target: number;
  unit: string;
};

export function assertMetric(metric: E2EMetric) {
  if (metric.value > metric.target) {
    throw new Error(`${metric.name}=${metric.value}${metric.unit} exceeds target ${metric.target}${metric.unit}`);
  }
}
```

- [ ] Create `tests/e2e-real/index.test.ts`.

This file must:

1. Load real E2E env.
2. Check Docker version.
3. Check Tork health endpoint.
4. Initialize a real fixture repo.
5. Run MVP scenario.
6. Run steering repair scenario.
7. Run dynamic DAG expansion scenario.
8. Run memory reuse scenario.
9. Assert metrics.
10. Assert no persistent session/memory/artifact/vault folders were created.

- [ ] Add `docs/e2e/southstar-real-e2e.md` with exact prerequisite commands.

Required command examples:

```bash
docker version
curl "$TORK_BASE_URL/api/v1/health"
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected result: missing real dependencies fail loudly; configured real dependencies run actual E2E.

### Task 13: Create Real Software Fixture Repo And MVP Scenario

- [ ] Create fixture files under `tests/e2e-real/fixtures/software-change/`.

`package.json`:

```json
{
  "name": "southstar-real-software-change-fixture",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test test/*.test.ts",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {},
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.0.0"
  }
}
```

`src/calc.ts` initial state:

```ts
export function add(a: number, b: number) {
  return a + b;
}
```

`src/cli.ts` initial state:

```ts
import { add } from './calc.js';

const [, , command, left, right] = process.argv;

if (command === 'add') {
  console.log(String(add(Number(left), Number(right))));
} else {
  console.error('Usage: calc add <a> <b>');
  process.exit(1);
}
```

`test/calc.test.ts` initial state:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { add } from '../src/calc.js';

test('adds two numbers', () => {
  assert.equal(add(2, 3), 5);
});
```

- [ ] Create `tests/e2e-real/scenarios/mvp-software-change.ts`.

Scenario must:

1. Copy fixture into a temp real git repo.
2. Run `git init` and create an initial commit.
3. Submit the MVP goal prompt to real Pi planner.
4. Validate generated `PlanBundle`.
5. Persist manifests to SQLite.
6. Submit real Tork job.
7. Wait for real Docker task completion.
8. Verify repo now supports `calc sum 1 2 3`.
9. Run real fixture tests.
10. Verify artifact/evaluator/session/memory/executor tables.

Important assertions:

```ts
assert.equal(execFileSync('node', ['--test', 'test/*.test.ts'], { cwd: repo }).status, 0);
assert.match(execFileSync('npm', ['run', 'cli', '--', 'sum', '1', '2', '3'], { cwd: repo, encoding: 'utf8' }), /6/);
```

Use `execFileSync` in a way that captures output and throws on non-zero exits. Do not suppress command output in failure messages.

- [ ] Create `tests/e2e-real/scenarios/steering-repair.ts`.

Scenario must:

1. Start a run from the MVP prompt.
2. Send the steering prompt before implementer finishes.
3. Force an invalid artifact naturally by asking for a missing field in evaluator requirements.
4. Confirm evaluator rejects.
5. Confirm root session issues repair instruction.
6. Confirm repaired artifact passes.

- [ ] Create `tests/e2e-real/scenarios/memory-reuse.ts`.

Scenario must:

1. Approve the memory delta from first successful MVP run.
2. Start second run with the memory reuse prompt.
3. Confirm retrieval snapshot includes the approved memory item.
4. Confirm second run artifact references the memory preference.

- [ ] Create `tests/e2e-real/scenarios/dynamic-dag-expansion.ts`.

Scenario must:

1. Start a real MVP run from the Pi planner output.
2. Trigger a review/root gate that requests a follow-up verification task.
3. Confirm `runtime_resources` contains `resource_type='workflow_revision'` with `status='applied'`.
4. Confirm `workflow_history` contains `workflow.revision_requested`, `workflow.revision_validated`, `workflow.expanded`, and `task.created`.
5. Confirm `workflow_tasks` has at least one more task after expansion and the revised DAG validates as acyclic.
6. Confirm the added task is materialized into a real Tork task/attempt and completed by Docker, not only inserted into SQLite.

- [ ] Run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected result: full real E2E passes within 15 minutes.

### Task 14: Implement Orchestrator CLI

- [ ] Create `src/v2/cli.ts`.

Required commands:

```text
southstar:v2 plan --goal "<goal prompt>"
southstar:v2 revise --draft-id <id> --prompt "<revision prompt>"
southstar:v2 run --draft-id <id>
southstar:v2 status --run-id <id>
southstar:v2 steer --run-id <id> --message "<steering prompt>"
southstar:v2 task-envelope --run-id <id> --task-id <id>
```

- [ ] CLI must write to SQLite and call the same planner/executor modules as the UI API.

- [ ] CLI `plan` output must print:

```text
draft_id=<id>
workflow_id=<workflowId>
validation=ok
workflow_manifest_id=<id>
execution_projection_fingerprint=<sha256>
```

- [ ] CLI `run` output must print:

```text
run_id=<id>
tork_job_id=<id>
status=submitted
```

- [ ] Add CLI tests for argument parsing and DB writes.

- [ ] Run `npm run test:v2`.

Expected result: CLI tests pass.

### Task 15: Phase 1 Verification And Acceptance

- [ ] Run unit and contract tests:

```bash
npm run test:v2
```

Expected output:

```text
tests pass with zero failed assertions
```

- [ ] Run real E2E:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 TORK_BASE_URL=http://127.0.0.1:8000 npm run test:e2e:real
```

Expected output includes:

```text
MVP software-change scenario passed
memory reuse scenario passed
steering repair scenario passed
dynamic DAG expansion scenario passed
all quantitative gates passed
```

- [ ] Inspect SQLite evidence:

```bash
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 ".tables"
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "select status, count(*) from workflow_runs group by status;"
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "select event_type, count(*) from workflow_history group by event_type;"
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "select json_extract(metrics_json,'$.tokens.total') as tokens, json_extract(metrics_json,'$.cost.microsUsd') as cost_micros_usd from workflow_runs;"
```

Expected result:

```text
workflow_runs contains passed runs
workflow_history contains evaluator.completed, repair.requested, workflow.expanded, task.created, memory.item_approved, session.entry, and subagent.completed events
runtime_resources contains applied workflow_revision resources
workflow_runs.metrics_json contains aggregate tokens and cost
```

- [ ] Verify no durable folder state:

```bash
find .southstar -mindepth 1 -maxdepth 2 -type d -print
```

Expected result:

```text
no session, memory, artifact, vault, or executor folders are printed
```

- [ ] Verify UI with real run:

```bash
npm run dev
```

Open the pi-web/Southstar UI and confirm:

- Planner Chat can create a draft.
- Workflow Canvas shows real graph nodes and edges.
- Agent Definitions shows generated harnesses.
- Runtime Monitor shows real Tork job id and task status.
- Task Detail Drawer shows evaluator results and artifact details.
- Sessions/Memory shows root and subagent sessions plus memory snapshot.
- Vault/MCP Review shows scoped grants and leases.
- Executor Ops shows Tork state.

## Phase 2: Data Analysis Domain

### Task 16: Add Data Analysis Domain Pack

- [ ] Extend `TaskDefinition.domain` tests to cover `data-analysis`.
- [ ] Add data-analysis evaluator requirements:
  - schema profile artifact,
  - cleaning report artifact,
  - insight report artifact,
  - chart artifact,
  - final report artifact.
- [ ] Add a real CSV fixture under `tests/e2e-real/fixtures/data-analysis/`.
- [ ] Add a real Docker image/harness path with Python or Node data tools installed.
- [ ] Add E2E scenario using the Data Analysis Phase Goal Prompt.

Quantitative gates:

| Gate | Target |
| --- | ---: |
| CSV rows processed | `>= 1,000` |
| Required artifacts | `5/5` |
| Chart artifact renderable | `100%` |
| Data-analysis run time | `<= 20m` |

Expected E2E evidence:

```text
data analysis workflow passed
schema profile artifact stored in SQLite
chart artifact blob stored in SQLite
final report artifact stored in SQLite
```

## Phase 3: Mobile, Voice, And Fragmented-Time Workflow

### Task 17: Add Mobile Run Summary And Voice Controller Surface

- [ ] Add mobile summary API:

```text
GET /api/v2/runs/:runId/mobile-summary
POST /api/v2/runs/:runId/voice-command
```

- [ ] Add UI components:

```text
src/v2/ui/components/MobileRunSummary.tsx
src/v2/ui/components/VoiceCommandPanel.tsx
```

- [ ] Store voice-derived commands as `workflow_history` `steering.received` events with `signal='revise-prompt'`, `signal='pause'`, or `signal='repair'`.
- [ ] Add real E2E using browser microphone only if local permissions are configured; otherwise use real text transcription service output from an approved API key and record the transcript in SQLite.

Quantitative gates:

| Gate | Target |
| --- | ---: |
| Mobile summary API response | `<= 1s` |
| Voice command stored as steering event | `100%` |
| Compressed run summary visible on mobile viewport | `<= 3s` |

## Phase 4: Additional Executor Providers And CubeSandbox

### Task 18: Add Executor Provider Abstraction

- [ ] Keep Tork as the Phase 1 production executor.
- [ ] Add executor provider interface:

```ts
export interface ExecutorProvider {
  id: string;
  submit(input: { workflow: SouthstarWorkflowManifest }): Promise<{ externalJobId: string }>;
  getStatus(externalJobId: string): Promise<unknown>;
  cancel(externalJobId: string): Promise<void>;
}
```

- [ ] Add CubeSandbox capability only as an explicit executor provider or Tork worker runtime if validated against the installed Tork version.
- [ ] Do not assume native CubeSandbox support. Add a real compatibility test before exposing it in UI.

Quantitative gates:

| Gate | Target |
| --- | ---: |
| Tork executor remains passing | `100%` existing E2E |
| CubeSandbox compatibility test | real container execution passes |
| Provider switch does not change SouthstarWorkflowManifest semantics | `0` semantic manifest changes |

## Phase 5: Learning Loop And Workflow Optimization

### Task 19: Add Workflow Learnings And Planner Feedback

- [ ] Persist workflow-level learning after every successful run.
- [ ] Feed approved workflow learning into planner prompts as a bounded memory snapshot.
- [ ] Add UI review queue for memory deltas and workflow learnings.
- [ ] Add E2E proving second software run uses approved learning without exposing full previous session transcript.

Quantitative gates:

| Gate | Target |
| --- | ---: |
| Approved learning reused | `>= 1` item in second run |
| Full transcript exposure | `0` unapproved transcript entries |
| Planner generation with learning | `<= 150s` |

## Phase 6: Production Hardening

### Task 20: Add Security, Retention, And Ops Controls

- [ ] Encrypt durable secret values using a configured local key provider. Do not store secret values in `workflow_history`; store only lease/ref events.
- [ ] Add retention policy for artifact blobs and session entries.
- [ ] Add DB backup/export command.
- [ ] Add run cancellation and Tork job cancellation.
- [ ] Add executor reconciliation job that compares SQLite bindings with Tork job status.
- [ ] Add UI alerts for expired vault leases, missing MCP grants, stuck executor jobs, and evaluator repair exhaustion.

Quantitative gates:

| Gate | Target |
| --- | ---: |
| Cancel run latency | `<= 10s` to Tork cancel request |
| Stuck executor detection | `<= 60s` |
| Vault lease expiry enforcement | `100%` expired leases blocked |
| DB backup restore test | full E2E run visible after restore |

## Implementation Order

1. Finish Phase 1 tasks 1 through 15 before starting any later phase.
2. Do not build data analysis until MVP software workflow real E2E passes.
3. Do not build voice/mobile until the runtime event and steering model is stable.
4. Do not expose CubeSandbox until real compatibility with Tork is proven.
5. Do not add production retention or encryption before SQLite schema and E2E evidence are stable.

## Completion Definition

Phase 1 is complete only when:

- `npm run test:v2` passes.
- `npm run test:e2e:real` passes against real Docker and real Tork.
- MVP goal prompt produces a real workflow and real Docker-executed task.
- Root session rejects at least one invalid artifact and accepts a repaired artifact.
- SQLite contains durable sessions, memory, artifacts, evaluator results, vault leases, MCP grants, executor bindings, progress, steering, signals, and runtime events.
- UI displays workflow canvas, agent definitions, runtime monitor, task detail, artifact viewer, sessions/memory, vault/MCP, and executor ops for a real run.
- No durable session/memory/artifact/vault/executor folders are created.
- The implementation notes document the Tork API version and Docker image assumptions.

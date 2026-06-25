# Southstar UI 前 Read-Model 與 Runtime Contract 調整設計

Date: 2026-06-25
Status: design draft

## 1. 背景

這份設計不是要大改 Southstar runtime，也不是要補現有 UI。它回答 UI 實作前的架構檢查結果：目前 Southstar 的 workflow 生成、task 組裝、runtime、recovery、evolution、API 已有可運作主線，但仍有幾個會直接影響新 UI 的 contract 缺口。

目前可確認的現狀：

- Postgres runtime 主體已成形，canonical state 主要落在 `work_items`、`workflow_runs`、`workflow_tasks`、`workflow_history`、`runtime_resources`，另有 artifact/blob、library、learning tables。
- `/api/v2/read-models/:kind/:runId` 已存在，現有 runtime API 也涵蓋 run lifecycle、tasks、events、sessions、memory、executions、recovery decisions、evolution。
- 現有 `/api/v2/ui/*` 是 compatibility route，不應成為新 UI 的主要設計邊界。
- system core 仍有 `softwareDomainPack`、`software`、`tork`、`pi`、`southstar/pi-agent:local`、`implement-calc-command` 等預設或 fixture 殘留。
- recovery 已有 observe/classify/decide/apply 流程，但 classification 仍是 hardcoded switch，尚未由 workflow/domain policy 驅動。
- scheduler claim 後的 dispatch preparation failure 有 pending loop 風險：部分 context/brain/hand 前置失敗會 release 回 pending，但 UI 不一定看得到 exception 與 recovery decision。

因此，UI 前的調整重點是把目前可運作的 runtime 收斂成 UI 可依賴的 read-model contract，並修掉會讓 UI 看不到狀態、不能操作、或誤以為系統是通用 domain-neutral 的缺口。

## 2. 目標

1. 定義新 UI 只依賴的 read-model-first API contract。
2. 讓每個 UI surface 都能讀到狀態、可操作 commands、disabled reasons、attention items、source refs。
3. 把 software/calc/Tork/Pi 預設降級為 pack/config/manifest/fixture 來源，不讓 core 隱性綁死 software workflow。
4. 讓 dispatch preparation failure 一律產生可觀測 exception 與 recovery decision，不再只回 pending。
5. 將 recovery classification 的目標契約改成 policy-driven；短期允許兼容舊 path，但 decision 必須帶 policy evidence。
6. 同步 schema/spec/docs 口徑，明確定義 Southstar v2 目前是分層共存模型。
7. 保留既有 Postgres runtime、Tork/Pi provider 與 E2E 主線，不重切系統。

## 3. 非目標

- 不重新設計 UI 視覺與互動細節。
- 不替現有 `/api/v2/ui/*` 補完整頁面 API。
- 不重寫 Postgres schema 或把 runtime 換成另一套 state model。
- 不一次移除所有 software 測試 fixture。
- 不移除 Tork/Pi provider；只把它們從 core 隱性預設改成 explicit config/manifest authority。
- 不把 read model 變成 mutable state source。read model 只投影 state 與 command affordance，mutation 仍走 runtime command routes。

## 4. 設計選項

### Option A: 只修明顯 compile/API 缺口

修 `src/v2/ui-api/read-models.ts` export 不存在檔案、補少量 API 對齊，其他 hardcode 暫時不動。

優點是最小；缺點是 UI 仍需要知道太多 runtime 細節，recovery 與 dispatch-prep 卡住時仍可能缺少可操作狀態。

### Option B: UI 前 contract adjustment

以 read-model-first 為核心，補齊 UI surface contract、command affordance、dispatch-prep exception observation、recovery policy evidence、schema/docs 口徑，以及 hardcode inventory/static gate。

這是本設計採用方案。它不是大改 runtime，而是把 UI 會用到的狀態與操作面收成穩定 contract。

### Option C: 全面 domain-neutral runtime 重構

一次將 workflow generator、manifest、provider、domain pack、recovery engine 全面重構成完全 domain-neutral。

這是長期方向，但不適合 UI 前置檢查階段。它會擴大風險，也會干擾已存在的 Postgres runtime 與 E2E matrix。

## 5. Recommendation

採用 Option B。

UI 開工前先完成一個 bounded contract adjustment：

```text
Postgres canonical state
  work_items
  workflow_runs / workflow_tasks / workflow_history
  runtime_resources
  artifact_blobs / secure_blobs
  library_* / learning_*

        ↓

Read-model builders
  run-control
  workflow-dag
  task-detail
  recovery-center
  execution-center
  planner-workbench
  evolution-center
  domain-pack-governance

        ↓

Read-model API envelope
  schemaVersion
  data
  commands
  attentionItems
  sourceRefs
  warnings
  generatedAt

        ↓

New UI
```

新 UI 不直接依賴 table shape，也不直接掃 `runtime_resources.payload_json`。它只吃 read-model envelope，並用 envelope 裡的 commands 決定能做什麼。

## 6. Canonical 資料模型口徑

Southstar v2 目前應明確描述為分層共存模型：

```text
work_items
  intake / source provenance / external issue-ticket-request linkage

workflow_runs
  immutable-ish workflow manifest snapshot, run status, execution projection,
  runtime context, run-level metrics

workflow_tasks
  task DAG node execution state, dependency refs, root session id,
  executor task id, task snapshot/metrics

workflow_history
  append-only run event log and idempotency evidence

runtime_resources
  extensible runtime evidence/resources:
  context packets, task envelopes, bindings, hand executions, exceptions,
  recovery decisions, approvals, memory deltas, evaluator results, etc.

artifact_blobs / secure_blobs
  typed large content and encrypted secret-bearing content

library_* / learning_*
  domain/design/evolution control-plane assets and knowledge graph
```

Docs 不應再把 current Postgres runtime 描述成單純三表模型。舊 spec 裡的 `runtime_status` / `workflow_state` 若保留，只能是 work-item semantic projection 或 future projection，不是 current schema truth。

## 7. Read-Model API Contract

每個 UI-facing read model 回傳同一層 envelope：

```ts
type UiReadModelEnvelope<TData> = {
  schemaVersion: string;
  kind: string;
  scope: {
    runId?: string;
    taskId?: string;
    workItemId?: string;
    domain?: string;
  };
  data: TData;
  commands: UiCommandAffordance[];
  attentionItems: UiAttentionItem[];
  sourceRefs: UiSourceRef[];
  warnings: UiWarning[];
  generatedAt: string;
};

type UiCommandAffordance = {
  id: string;
  label: string;
  endpoint: string;
  method: "POST" | "PATCH" | "DELETE";
  bodySchemaRef?: string;
  enabled: boolean;
  disabledReason?: string;
  idempotencyKeyHint?: string;
  dangerLevel: "none" | "low" | "medium" | "high";
  requiresConfirmation: boolean;
};

type UiAttentionItem = {
  id: string;
  severity: "info" | "warning" | "error" | "blocked";
  title: string;
  reason: string;
  sourceRefs: string[];
  suggestedCommandIds: string[];
};

type UiSourceRef = {
  id: string;
  kind: "table-row" | "history-event" | "runtime-resource" | "manifest-ref" | "library-object";
  ref: string;
};

type UiWarning = {
  code: string;
  message: string;
  sourceRefs: string[];
};
```

Rules:

- UI never infers whether a command is allowed from raw status strings alone.
- Disabled commands must include `disabledReason`.
- Dangerous commands must set `dangerLevel` and `requiresConfirmation`.
- Read models may include compact derived summaries, but must include `sourceRefs` for audit.
- Read models must fail closed: missing required state returns an API error or attention item, not an empty successful model.

## 8. Required UI Surfaces

### 8.1 `run-control`

Purpose: top-level run/work item control.

Data:

- run status, raw status, work item linkage
- task counts by status
- latest progress/event summary
- unresolved exception count
- pending approval/recovery count
- active provider/executor count

Commands:

- execute/start scheduling
- pause
- resume
- cancel
- wake runtime loops
- open recovery center

### 8.2 `workflow-dag`

Purpose: workflow graph and readiness.

Data:

- nodes from `workflow_tasks`
- edges from `depends_on_json`
- dependency readiness
- artifact acceptance status
- terminal/non-terminal reason
- policy refs and domain/pack refs from manifest

Commands:

- retry task
- request revision
- inspect task
- inspect artifacts

### 8.3 `task-detail`

Purpose: one task's operational truth.

Data:

- task row summary
- manifest task definition
- latest context packet
- latest task envelope
- artifact refs and evaluator results
- root session and checkpoint refs
- brain/hand bindings
- latest hand execution
- related exceptions and recovery decisions

Commands:

- retry task
- fork/reset/rollback session
- request revision
- inspect envelope

### 8.4 `recovery-center`

Purpose: all operator-visible abnormal state.

Data:

- unresolved runtime exceptions
- matched recovery policy/rule
- recovery decisions
- approvals
- recovery executions
- related provider action evidence

Commands:

- approve/reject recovery decision
- apply recovery decision
- block task
- fail task/run
- observe-only acknowledge when policy allows

### 8.5 `execution-center`

Purpose: provider and executor operations.

Data:

- executor bindings
- hand executions
- external job ids
- heartbeat timestamps
- queue/running timeout policy
- cancel/reconcile evidence

Commands:

- cancel provider job
- reconcile provider job
- mark lost only through approved recovery action

### 8.6 `planner-workbench`

Purpose: workflow generation and materialization inspection before run execution.

Data:

- planner drafts
- draft validation issues
- orchestration/composition trace summary
- materialized manifest preview
- selected domain pack and config source
- generated tasks and artifact flow

Commands:

- create draft
- inspect draft
- materialize run
- archive/reject draft when supported

### 8.7 `domain-pack-governance`

Purpose: make hardcoded defaults visible before UI treats the system as generic.

Data:

- active domain packs
- default pack source
- harness/execution profile defaults
- current software/Tork/Pi fallback warnings
- static hardcode inventory status

Commands:

- none in first pass, read-only governance surface

### 8.8 `evolution-center`

Purpose: evolution control plane, aligned with same envelope style.

Data:

- signals
- cards
- deltas
- sandbox experiments
- assets
- wiki health
- regression alerts

Commands:

- synthesize cards/deltas
- approve/reject delta
- run sandbox
- promote/rollback asset
- acknowledge/dismiss regression alert

## 9. Hardcode 降級

本設計不要求一次移除所有 software/Tork/Pi 行為，但要求來源清楚、core 不再隱性 fallback。

Allowed locations:

```text
domain pack seed
runtime config
manifest snapshot
execution profile
test fixture
```

Disallowed in core paths:

```text
import { softwareDomainPack } from "../domain-packs/software.ts";
engine: "tork" as the only manifest type
domain: "software" as generic runtime default
image: "southstar/pi-agent:local" as core fallback
task id "implement-calc-command" in generic workflow generation
```

Target boundaries:

- `DomainPackRegistry` becomes the only way generic runtime code resolves a domain pack.
- `softwareDomainPack` may still exist, but only config/seed/test paths import it directly.
- Workflow generation receives `{ domainPackRef | domainPackId | registry }`, not a hardcoded software pack.
- Task assembly reads required role/profile/artifact/evaluator data from manifest snapshot first, then registry only when manifest explicitly references pack data.
- Tork/Pi image/command defaults live in execution profile or manifest `harnessDefinitions`, not manifest type literals.
- Static tests guard that core folders do not import `domain-packs/software.ts`.

## 10. Recovery Policy Contract

Current recovery path names may remain for compatibility, but classification must become policy-backed.

Target flow:

```text
runtime observation
  -> runtime_exception resource
  -> load recovery policy
  -> match rule
  -> recovery_decision resource with policy evidence
  -> read-model exposes decision and commands
  -> applier executes typed actions
```

Policy sources, in priority order:

1. task manifest policy refs
2. workflow manifest recovery policy section
3. domain pack recovery policies
4. system fallback policy

Policy shape:

```ts
type RecoveryPolicyRule = {
  id: string;
  when: {
    kind: string;
    providerId?: string;
    providerEvidence?: Record<string, unknown>;
    taskStatus?: string;
  };
  decision: {
    path: string;
    requiresOperatorApproval: boolean;
    reasonTemplate: string;
    actions: RecoveryAction[];
  };
};

type RecoveryAction =
  | { type: "release-task"; status: "pending" | "blocked" | "failed" }
  | { type: "mark-hand-execution"; status: "lost" | "superseded" }
  | { type: "create-session-checkpoint" }
  | { type: "fork-session" }
  | { type: "reset-session" }
  | { type: "reprovision-hand" }
  | { type: "wake-brain" }
  | { type: "request-artifact-repair" }
  | { type: "cancel-provider-job" }
  | { type: "observe-only" };
```

`recovery_decision.payload_json` must include:

- `policyRef`
- `matchedRuleId`
- `actions`
- `operatorApprovalRequired`
- `evidenceRefs`
- existing `path` for compatibility

## 11. Dispatch Preparation Failure

Dispatch preparation failure is P0 because it directly affects UI operability.

Current risk:

```text
pending task
  -> scheduler claims task
  -> context/checkpoint/brain/hand prep fails
  -> task released back to pending
  -> UI sees pending again but not a durable recovery decision
```

Target behavior:

```text
pending task
  -> scheduler claims task
  -> prep phase fails
  -> runtime_exception(kind="dispatch_preparation_failed")
  -> recovery policy creates decision
  -> UI recovery-center shows decision/command
```

Exception payload:

```ts
type DispatchPreparationFailedPayload = {
  kind: "dispatch_preparation_failed";
  phase:
    | "context_assembly"
    | "checkpoint_create"
    | "brain_wake"
    | "hand_provision"
    | "task_intent_create"
    | "tool_policy_check"
    | "hand_submit";
  runId: string;
  taskId: string;
  sessionId: string;
  attemptId: string;
  recoveryKey: string;
  partialResourceRefs: string[];
  redactedError: string;
};
```

Rules:

- No dispatch-prep failure may silently return to pending without durable exception evidence.
- Tool proxy violations may remain blocking, but must still be visible through `recovery-center`.
- If a hand execution was accepted by provider, provider-specific failure handling continues to use existing hand execution exception kinds.
- If no provider accepted work yet, failure is a preparation failure, not a Tork/Pi failure.

## 12. API Alignment

UI-facing APIs should be grouped by read model plus command route.

Read:

```text
GET /api/v2/read-models/run-control/:runId
GET /api/v2/read-models/workflow-dag/:runId
GET /api/v2/read-models/task-detail/:runId/:taskId
GET /api/v2/read-models/recovery-center/:runId
GET /api/v2/read-models/execution-center/:runId
GET /api/v2/read-models/planner-workbench/:draftId
GET /api/v2/read-models/domain-pack-governance/_global
GET /api/v2/read-models/evolution-center/_global
```

Mutation remains on existing runtime routes where possible:

```text
POST /api/v2/runs/:runId/execute
POST /api/v2/runs/:runId/pause
POST /api/v2/runs/:runId/resume
POST /api/v2/runs/:runId/cancel
POST /api/v2/runs/:runId/tasks/:taskId/retry
POST /api/v2/runs/:runId/tasks/:taskId/fork-session
POST /api/v2/runs/:runId/tasks/:taskId/reset-session
POST /api/v2/runs/:runId/tasks/:taskId/rollback-session
POST /api/v2/runs/:runId/recovery-decisions/:decisionId/approval
POST /api/v2/runs/:runId/recovery-decisions/:decisionId/apply
POST /api/v2/runs/:runId/executor-jobs/:jobId/reconcile
POST /api/v2/runs/:runId/executor-jobs/:jobId/cancel
```

The server client must expose the same operations the routes support. Contract tests should compare route inventory, client methods, and read-model command endpoints.

## 13. Compatibility

- Existing `/api/v2/read-models/run-summary`, `executions`, `exceptions`, `workflow-canvas`, `runtime-monitor`, `executor-ops`, `task-detail`, `sessions-memory`, `vault-mcp`, `evolution-control-center` may remain.
- Existing `/api/v2/ui/*` routes may stay as compatibility wrappers, but new UI should not build against them.
- Existing E2E cases may continue to use `software`, `tork`, and `southstar/pi-agent:local` as fixtures.
- Compatibility wrappers must not export non-existent files.

## 14. Testing and Gates

### Static gates

- Core runtime folders do not import `src/v2/domain-packs/software.ts`.
- `src/v2/ui-api/read-models.ts` does not export missing files.
- Manifest type no longer makes Tork the only possible engine.
- No generic workflow generation path emits `implement-calc-command`.

### Unit tests

- Read-model envelope always includes `schemaVersion`, `data`, `commands`, `attentionItems`, `sourceRefs`, `warnings`.
- Disabled commands include `disabledReason`.
- Recovery decision includes `policyRef`, `matchedRuleId`, and `actions`.
- Dispatch preparation failures create runtime exception records with redacted error evidence.

### API contract tests

- Every command emitted by a read model maps to a known route.
- Server client exposes route-aligned methods for all emitted UI commands.
- Unknown read-model kind fails closed.
- Missing task/run IDs return explicit API errors.

### E2E additions

- A scheduler context assembly failure creates `dispatch_preparation_failed`, recovery decision, and recovery-center read-model evidence.
- A non-software domain pack fixture can materialize a minimal run without importing `softwareDomainPack` from core.
- Recovery policy override changes the decision for the same exception kind in a test domain.

Existing Postgres E2E matrix should continue to run case-by-case. UI browser flows remain outside `tests/e2e-postgres`.

## 15. Implementation Phasing

### Phase 1: UI contract safety

- Fix read-model shim/export risk.
- Add envelope/command/attention/sourceRefs conventions.
- Add route/client/read-model command alignment tests.
- Add schema/docs clarification for current data model.

### Phase 2: Dispatch-prep observability

- Add `dispatch_preparation_failed` exception kind.
- Map scheduler prep phases to exception payload.
- Ensure recovery-center exposes the exception and decision.
- Add E2E for no silent pending loop.

### Phase 3: Hardcode containment

- Introduce explicit domain pack registry/config path for planner/task assembly.
- Move software fallback out of core imports.
- Move Tork/Pi defaults to execution profile or manifest snapshot.
- Add static hardcode gates.

### Phase 4: Policy-backed recovery

- Add recovery policy schema to manifest/domain pack.
- Emit policy evidence in recovery decisions.
- Keep compatibility path names while applier learns typed actions.
- Add domain-specific policy override tests.

### Phase 5: Evolution/read-model alignment

- Align evolution control center with the common read-model envelope.
- Remove direct software pack dependency from evolution sandbox core path, or fence it behind explicit pack/config input.

## 16. Acceptance Criteria

1. New UI can be designed from read-model contracts without reading raw DB tables.
2. Every UI-visible abnormal state has an attention item and source refs.
3. Every UI-visible operation is represented as a command affordance with enabled/disabled reason.
4. Dispatch-prep failures produce durable exception and recovery decision evidence.
5. Core runtime paths no longer directly import `softwareDomainPack`.
6. Tork/Pi/software defaults are explicit config, manifest, pack, or fixture data.
7. Docs describe the actual current Postgres model as layered state, not the older simplified table model.
8. Existing runtime E2E behavior remains compatible.
9. Contract tests fail if read models export missing files or emit commands without routes.

## 17. Open Questions for Implementation Plan

1. Should the first implementation keep existing read-model kind names and add aliases, or introduce only new names such as `run-control` and `workflow-dag`?
2. Should `domain-pack-governance` be global only, or also run-scoped to show the exact pack/config source for one run?
3. Should recovery typed actions be interpreted immediately in the applier, or first persisted only as policy evidence while old path branches continue to apply?
4. Should hardcode gates apply to all `src/v2/**`, or start with core runtime folders and allow planner/evolution compatibility during phase 1?

## 18. Design Self-Review Notes

- No implementation code is specified as mandatory in this design document.
- The scope is bounded to UI-before-runtime-contract adjustment, not a full runtime rewrite.
- Compatibility with existing Postgres/Tork/Pi/software E2E is preserved.
- Dispatch-prep failure is treated as P0 because it affects UI operability directly.
- Schema wording explicitly chooses the current layered model.

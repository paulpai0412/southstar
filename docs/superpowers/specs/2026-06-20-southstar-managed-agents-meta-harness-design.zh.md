# Southstar Managed Agents Meta-Harness Design

日期：2026-06-20
狀態：design draft

## 1. 背景

本文依據 Anthropic Engineering Blog 的三篇 agent architecture 文章重新定義 Southstar v2 的目標架構：

- [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents)
- [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

Managed Agents 的核心判斷是：agent harness 會把「模型現在做不到什麼」寫進系統假設，但模型能力進步後，這些假設會變成負擔。因此 production agent platform 應該穩定的是介面，而不是某一代 harness 的實作。

Southstar 目前已有 Postgres canonical path、workflow manifest、task envelope、executor provider、runtime resources、learning graph、context packet 與 recovery 設計。但仍有三個主要偏差：

1. runtime truth 從早期 `work_item / stage / task` 設計漂移到 `workflow_runs / workflow_tasks` run-centric schema，尚未明確定義 work item 與 run 的關係。
2. Postgres canonical path 已建立，但 recovery/checkpoint/session lineage 仍有 legacy SQLite surface。
3. executor dispatch 偏整包 workflow submit，brain、hand、session 還沒有被抽成可獨立失敗、替換、擴展的穩定介面。

本文將 Southstar 定位為 **managed agent meta-harness**：Southstar 不應成為某個 agent harness 本身，而應提供可長期穩定的 session、brain、hand、sandbox、vault、context、scheduler、evaluation 介面，讓 Codex、Pi、Claude Code、custom harness 或未來模型能力都可以接入。

## 2. 設計目標

1. **Decouple brain from hands**：agent harness 不與 sandbox/container/workspace 綁死；sandbox 只是 hand provider，透過通用 tool execution interface 被呼叫。
2. **Session is durable truth, not context window**：完整事件流與 compact checkpoints 存在 Postgres session log；context packet 是 harness 對 session log 的投影，不是不可逆的真相。
3. **Both brain and hands are cattle**：brain/harness crash 後可用 `wake(sessionId)` 從 session event log 恢復；sandbox/container crash 後可重新 provision。
4. **Credentials never enter sandbox**：generated code execution environment 不可讀到 OAuth、GitHub token、MCP token；credential 使用透過 vault/proxy 或 resource-bound auth。
5. **Many brains, many hands**：一個 work item 可有多個 brain session；一個 brain 可操作多個 hands；hands 可跨 repo、container、VPC、browser、mobile 或 MCP server。
6. **Interface-first, harness-change-tolerant**：Southstar 對 session、brain、hand、context、evaluation 的資料合約穩定；具體 harness strategy 可演進。
7. **Artifact/evaluator remains completion truth**：executor/Tork/hand observation 只提供 liveness 與 execution evidence，不直接完成 workflow task。
8. **Operator-visible recovery**：checkpoint、fork、reset、rewind、rollback 不是 debug-only 功能，必須在 API/UI/read model 中可見、可審計、可重放。

## 3. 非目標

- 不在本設計中導入 Anthropic Claude Managed Agents 產品依賴。
- 不把 Southstar 改成 Anthropic Agents API wrapper。
- 不新增另一套 generic BPMN/Zapier automation layer。
- 不讓 Tork、Docker、Pi、Codex、Claude Code 任一 provider 成為 runtime truth。
- 不在第一版自動開放 sandbox credentials。
- 不要求所有 legacy SQLite module 立即刪除；但新功能不得依賴 legacy SQLite path。

## 4. 核心抽象

### 4.1 Work Item

Work Item 是使用者或外部 source 交給 Southstar 管理的長期工作單位。它可以來自 local prompt、GitHub issue、Linear ticket、Slack request、incident alert、research question。

建議補回或明確等價化以下概念：

```text
work_item
  -> workflow_run attempt 1
  -> workflow_run attempt 2
  -> workflow_run recovery/fork branch
```

若短期不新增 `southstar.work_items` table，至少要在 `workflow_runs.runtime_context_json` 中穩定保存：

```ts
type WorkItemRef = {
  workItemId: string;
  sourceProvider: "local" | "github" | "linear" | "jira" | "slack" | "api" | "custom";
  sourceRef?: string;
  sourceUrl?: string;
  parentWorkItemId?: string;
  runAttempt: number;
};
```

### 4.2 Session

Session 是 append-only event log，不是 LLM context window。它保存發生過的事，允許 brain/harness 重新讀取、切片、回看、轉換，再決定放什麼進 prompt。

Postgres canonical resource：

```text
southstar.workflow_history       -- ordered event log
southstar.runtime_resources      -- session_checkpoint, context_packet, task_envelope, recovery_decision
southstar.learning_nodes/edges   -- long-term learning lineage
```

新增穩定介面：

```ts
interface SessionStore {
  emitEvent(sessionId: string, event: SessionEvent): Promise<EventRef>;
  getEvents(sessionId: string, query: EventSliceQuery): Promise<SessionEvent[]>;
  createCheckpoint(input: CheckpointInput): Promise<CheckpointRef>;
  getCheckpoint(checkpointId: string): Promise<SessionCheckpoint>;
}
```

`getEvents()` 必須支援：

- 從上次讀取位置往後讀。
- 回看某事件前後 N 筆。
- 依 event type、task id、artifact ref、correlation id 篩選。
- 傳回 raw event refs 與 transformed summary，但 raw event 不可被 context compaction 破壞。

### 4.3 Brain

Brain 是可替換的 agent/harness worker，例如 Pi harness、Codex harness、Claude Code harness、custom domain harness。Brain 的責任是：

- 讀 session。
- 建 context。
- 呼叫模型或 host SDK。
- 將 tool calls 轉交 hands。
- 將 progress、artifact、decision、errors 寫回 session。

穩定介面：

```ts
interface BrainProvider {
  providerId: string;
  wake(input: WakeBrainInput): Promise<BrainSessionBinding>;
  cancel(binding: BrainSessionBinding): Promise<void>;
  capabilities(): BrainCapabilities;
}
```

`wake(sessionId)` 是關鍵。任何 brain worker crash 後，都應能由另一個同 provider 或不同 provider 的 brain 讀 session log 後恢復。

### 4.4 Hand

Hand 是 action environment。它可以是 Docker sandbox、repo worktree、browser、MCP server、phone automation、remote VPC worker、Tork task。

穩定介面：

```ts
interface HandProvider {
  providerId: string;
  provision(input: ProvisionHandInput): Promise<HandBinding>;
  execute(binding: HandBinding, call: HandCall): Promise<HandResult>;
  snapshot(binding: HandBinding): Promise<HandSnapshotRef>;
  destroy(binding: HandBinding): Promise<void>;
  capabilities(): HandCapabilities;
}
```

Brain 不應假設 workspace 與 harness 在同一個 container。所有 hands 都是 named tools：

```text
execute(handName, input) -> string | structured result
```

Hand failure 是 tool-call error，不是 session loss。

### 4.5 Vault And Tool Proxy

Credentials 不進 sandbox。Southstar 提供 vault lease 與 MCP/tool proxy：

```ts
interface ToolProxy {
  execute(sessionToken: SessionToolToken, toolCall: ToolCall): Promise<ToolResult>;
}
```

規則：

- Brain 不直接取得 long-lived credential。
- Sandbox 不可讀到 credential environment variables。
- Git auth 優先使用 resource-bound setup，例如 clone/provision 時配置 remote credential，agent 不接觸 token。
- MCP/OAuth 由 proxy 根據 session lease 從 vault 取 credential。
- 所有 tool grant 都有 scope、ttl、allowedTools、riskTags、audit reason。

## 5. Target Architecture

```text
Operator / CLI / UI / API
  -> Southstar Runtime Server
      -> Work Item Registry
      -> Scheduler
      -> SessionStore
      -> ContextBuilder
      -> BrainProvider Registry
      -> HandProvider Registry
      -> Vault / MCP Proxy
      -> Evaluator Pipeline
      -> Recovery Controller
      -> Projection / Read Models
```

Execution flow：

```text
1. intake work item
2. resolve domain pack and workflow manifest
3. create workflow run and root session
4. scheduler selects runnable tasks
5. brain provider wakes a session
6. brain reads session events and context packet
7. brain provisions hands only when needed
8. hand executes action and returns result
9. brain emits progress/artifact/evaluator requests
10. evaluator validates artifact and end state
11. scheduler advances, retries, forks, waits, or completes
```

## 6. Storage Model Changes

Current Postgres schema is acceptable as a foundation, but needs stricter resource taxonomy and indexes.

### 6.1 Required Runtime Resource Types

```text
session
session_checkpoint
brain_binding
hand_binding
hand_snapshot
context_packet
context_transform
task_envelope
artifact_ref
artifact_blob
evaluator_result
recovery_decision
recovery_execution
tool_grant
tool_proxy_call
vault_lease
executor_binding
executor_reconcile_result
```

### 6.2 Session Event Types

Minimum canonical event types：

```text
session.created
brain.woke
brain.failed
brain.cancelled
context.packet_built
context.events_read
hand.provisioned
hand.execute_requested
hand.execute_completed
hand.failed
hand.snapshot_created
artifact.created
artifact.accepted
artifact.rejected
evaluator.completed
checkpoint.created
recovery.decision_recorded
recovery.execution_submitted
tool_proxy.called
vault_lease.issued
operator.steering_received
```

### 6.3 Invariants

- `workflow_history` is append-only audit truth.
- `runtime_resources` stores current resource state and refs.
- Resource mutation and history append must happen in one Southstar transaction.
- Raw session events remain recoverable even if context packets are compacted.
- Completion depends on artifact/evaluator/end-state gates, not executor status.
- Recovery must create `before-recovery` checkpoint before dispatching any new brain/hand work.

## 7. Scheduling And Coordination

Southstar should move from whole-workflow dispatch toward runnable-task scheduling.

### 7.1 Scheduler Responsibilities

- Find runnable tasks whose dependencies have accepted artifacts.
- Apply effort scaling policy.
- Allocate brain provider and hand providers.
- Enforce concurrency caps.
- Reconcile lost brain or hand bindings.
- Dispatch retry/fork/reset/rollback actions.
- Prevent duplicate execution with idempotency keys.

### 7.2 Effort Scaling Policy

Each workflow manifest should carry explicit effort policy:

```ts
type EffortPolicy = {
  complexity: "simple" | "standard" | "broad" | "deep";
  maxBrains: number;
  maxHandsPerBrain: number;
  maxParallelTasks: number;
  maxToolCallsPerTask: number;
  maxInputTokensPerBrain: number;
  maxCostMicrosUsd: number;
  stopWhenEvidenceSufficient: boolean;
};
```

Prompt heuristics may suggest this policy, but runtime must persist and enforce it.

### 7.3 Async Fan-In

Fan-in should be artifact-driven:

```text
parallel checker tasks complete
  -> artifact/evaluator results accepted
  -> fan-in task becomes runnable
  -> fan-in brain reads only accepted artifacts and selected event slices
```

The fan-in brain should not receive full upstream transcripts unless an evaluator asks for them.

## 8. Context Design

Session is durable context object. ContextPacket is a prompt projection.

ContextBuilder should support:

- `rawEventRefs`: event ids used to build the packet.
- `transformRefs`: summaries or filtered views used.
- `omittedEventRanges`: skipped ranges and reason.
- `selectedKnowledgeCardRefs`.
- `priorAcceptedArtifactRefs`.
- `checkpointRefs`.
- `failureSummaryRef`.
- `tokenEstimate`.
- `cacheKey` for prompt cache stability.

Context selection is allowed to change as models improve. SessionStore interface must remain stable.

## 9. Recovery Model

Recovery must be durable-first:

```text
failure observed
  -> record recovery_decision
  -> create before-recovery checkpoint
  -> choose brain/hand recovery path
  -> dispatch new brain wake or hand reprovision
  -> record lineage
```

Supported recovery actions:

- `retry-same-brain`: same provider, new attempt, compact failure context.
- `wake-new-brain`: crash recovery from session log.
- `fork-brain-from-checkpoint`: compare alternative strategy.
- `reset-from-checkpoint`: supersede current branch as path forward.
- `reprovision-hand`: sandbox/container/workspace replacement.
- `rollback-hand-snapshot`: restore worktree/container state.
- `host-native-rewind`: provider optimization only, never source of truth.

## 10. Security Model

Required rules:

1. Sandbox has no long-lived credential env vars.
2. Brain sees only scoped session/tool tokens.
3. Tool proxy resolves credentials outside sandbox.
4. Every grant has TTL and allowed tool list.
5. High-risk grants require approval.
6. Generated code cannot mint new unrestricted sessions.
7. Tool proxy records audit event and redacted result summary.
8. Secure blobs are stored separately from normal runtime resources.

## 11. Evaluation Model

Southstar needs both artifact shape gates and end-state gates.

Per task:

- artifact schema validity
- required evidence presence
- tool efficiency and budget adherence
- source/session event citation accuracy
- hand state consistency
- security policy compliance

Per work item:

- accepted artifact graph completeness
- no unresolved blocking evaluator findings
- final workspace/source projection state matches release policy
- recovery attempts did not leave active orphan hands
- final report cites accepted artifacts, not raw unsupported claims

## 12. Migration Plan

### Phase A: Interface And Naming Alignment

- Define `SessionStore`, `BrainProvider`, `HandProvider`, `ToolProxy` types.
- Add resource/event taxonomy constants.
- Decide whether to add `work_items` table or formalize `WorkItemRef` inside `workflow_runs`.
- Add static tests preventing new code from importing legacy SQLite recovery/context/session modules.

### Phase B: Postgres Session And Recovery

- Port recovery dispatcher/checkpoints/context rebuild to Postgres.
- Ensure `before-recovery` checkpoint is created before all recovery actions.
- Add `wake-new-brain` recovery path using session log.
- Add read models for session lineage and hand bindings.

### Phase C: Runnable Task Scheduler

- Split whole-workflow dispatch into runnable-task dispatch.
- Create one binding per brain session and per hand.
- Add hand reprovision and orphan cleanup.
- Add async fan-in based on accepted artifacts.

### Phase D: Security Boundary

- Implement vault lease and tool proxy event taxonomy.
- Remove any path where sandbox receives raw provider credentials.
- Add e2e tests that generated code cannot read credential-shaped env vars.

### Phase E: Managed-Agent Evaluation

- Add end-state evaluators.
- Add effort scaling metrics and gates.
- Add real Postgres/Tork/Pi E2E for crash recovery, hand reprovision, fan-in, and credential isolation.

## 13. Acceptance Criteria

1. A brain worker can crash after emitting events; another worker can `wake(sessionId)` and continue from Postgres session log.
2. A sandbox/container can fail; task records hand failure, reprovisions a new hand, and preserves session continuity.
3. Context packets cite source event ids, artifact refs, checkpoint refs, and omitted ranges.
4. Recovery creates `recovery_decision` and `before-recovery` checkpoint before dispatch.
5. No active canonical runtime/server/CLI path imports legacy SQLite recovery/session modules.
6. Generated code inside sandbox cannot read GitHub/OAuth/MCP credentials.
7. A workflow can run multiple brain sessions and multiple hands without assuming one shared container.
8. Fan-in tasks consume accepted artifact refs rather than full upstream transcripts.
9. Completion depends on evaluator/end-state gates, not Tork or executor terminal status.
10. Real Postgres/Tork/Pi E2E covers normal run, brain crash recovery, hand reprovision, and security boundary.

## 14. Open Decisions

1. Add a first-class `southstar.work_items` table now, or keep `WorkItemRef` inside `workflow_runs` until source integrations expand?
2. Should `brain_binding` and `hand_binding` be dedicated tables or typed `runtime_resources`?
3. Should Tork remain the first HandProvider, or should Docker/local process be added as a smaller hand provider for faster E2E?
4. What is the minimum secure-vault implementation for local development: encrypted Postgres blob, OS keychain, or file-backed dev vault?
5. Which provider should be first to support `wake(sessionId)`: Pi harness, Codex harness, or built-in fake harness?

## 15. Recommended Immediate Decision

Adopt the interface-first design without adding a new external dependency. The next implementation pass should focus on:

1. `SessionStore` + Postgres recovery/checkpoint canonical path.
2. `BrainProvider` / `HandProvider` type boundaries around current Pi/Tork flow.
3. Real E2E for crash recovery and hand reprovision.

This keeps Southstar aligned with Managed Agents: stable abstractions around long-horizon agent work, while allowing concrete harnesses and sandboxes to evolve or be replaced.

## 16. Implementation Tracking

Implementation plan: `docs/superpowers/plans/2026-06-20-southstar-managed-agents-meta-harness-implementation-plan.md`.

This implementation is intentionally not scoped as an MVP. It includes interface contracts, Postgres session/recovery, managed brain and hand providers, runnable scheduling, vault/tool proxy isolation, managed-agent evaluation, read models, runtime loops, static gates, real Postgres E2E, and operator runbook updates.

Operational runbook: `docs/manuals/2026-06-20-southstar-managed-agents-runtime-runbook.zh-TW.md`.

# Southstar Domain Pack / Context / Memory / Session 設計文件

日期：2026-06-13

## 1. 目標

本設計把 Southstar v2 從「能執行一條 agent workflow」推進為「使用者輸入 prompt 後，能依 domain 產生動態 workflow，經 Docker/Tork 執行、評估、自修復、fork/rollback、memory 注入，最後產出可驗收成品」的 runtime。

第一版只把 `software` domain pack 做成必須通過的 vertical slice；`research`、`data-analysis`、`office/report` 只保留 extension point，不在第一版實作完整 domain。

核心目標：

- 使用者 prompt 進來後，Southstar 先做 intent/domain routing，再由 domain pack 產生 workflow，而不是由 planner 任意發明任務形狀。
- 每個 task 都有 role、agent profile、artifact contract、context policy、evaluator pipeline 與 stop condition。
- agent 是 stateless template；session、memory、artifact、workspace snapshot 與 evaluator result 是 durable runtime state。
- memory 透過 provider 取得，但 Southstar 保留 approval、ranking、compression、注入 trace 與 audit。
- session 支援 checkpoint、fork、reset、rollback；fork 不複製完整 transcript，只使用 checkpoint summary、artifact facts、selected memory 與 workspace snapshot。
- software domain 的 workspace snapshot 由 Git/worktree 管理；session graph 仍由 Southstar SQLite/resource store 管理。
- Tork/Docker 仍只負責 container execution，不成為 workflow、session、memory 或 artifact truth。

## 2. 非目標

- 不在第一版實作完整 Loop Automation/cron/triage inbox。
- 不把 Southstar runtime 改寫成 LangGraph、Temporal、Inngest 或任何外部 workflow engine。
- 不讓 mem0、LangGraph、Git 或 Tork 成為 Southstar canonical state。
- 不把完整 transcript 當 long-term memory。
- 不讓 planner 直接決定任意 provider/model/MCP/tool 權限；planner 只能在 domain pack 允許的 profile/role/policy 內選擇。
- 不在第一版完成 production auth、多租戶、遠端 sandbox fleet 或 Postgres adapter。

## 3. 當前缺口

現有 v2 已有 `SouthstarWorkflowManifest`、`TaskEnvelope`、Tork executor provider、skill snapshot、basic memory snapshot、root-session repair loop、checkpoint resource 與 workflow revision resource。

主要缺口：

- `tasks[].subagents[]` 直接保存 `harnessId` 與 prompt，沒有獨立 `RoleDefinition` / `AgentProfile`。
- memory retrieval 目前是 `scope + limit`，沒有 query/ranking/compression/audit，也沒有 provider boundary。
- checkpoint 只是 resource，尚未形成可 fork/reset/rollback 的 session graph。
- artifact gate 主要是 required fields，不足以判斷成品是否有效。
- planner prompt 仍偏 MVP hard-coded task shape，沒有由 domain pack 驅動 workflow generation。
- software workspace rollback/fork 尚未和 session checkpoint 建立明確關聯。

## 4. 架構總覽

```text
User Prompt
  -> IntentRouter
      -> DomainPackRegistry
          -> SoftwareDomainPack
              -> WorkflowTemplate
              -> RoleDefinitions
              -> AgentProfiles
              -> ArtifactContracts
              -> EvaluatorPipeline
              -> ContextPolicy
  -> WorkflowPlanner
      -> SouthstarWorkflowManifest
  -> ManifestValidator
  -> UI/CLI Approval
  -> ContextBuilder
      -> MemoryProvider
      -> SessionGraphProvider
      -> SkillResolver
      -> WorkspaceSnapshotProvider
      -> ContextPacket
  -> TaskEnvelope Materializer
  -> TorkExecutorProvider
      -> Docker container
          -> southstar-agent-runner
              -> RootSession
                  -> AgentHarness
                  -> EvaluatorPipeline
                  -> Repair/Fork/Rollback/Replan
  -> Accepted Artifact
  -> Session Checkpoint
  -> Memory Delta
  -> Completion Report
```

Southstar 的 canonical truth 仍是 SQLite/resource store 中的 workflow run、workflow tasks、workflow history、runtime resources、artifact blobs 與 secure blobs。外部 provider 只能提供特定能力，不保存不可替代的 runtime 決策。

## 5. Domain Pack DSL

`DomainPack` 是 domain authoring surface。Planner 不直接產生任意 workflow；planner 根據 prompt、domain pack、allowed profiles 與 policy 產生 `SouthstarWorkflowManifest`。

```ts
export type DomainPack = {
  id: string;
  version: string;
  displayName: string;
  intents: IntentDefinition[];
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  workflowTemplates: WorkflowTemplate[];
  artifactContracts: ArtifactContract[];
  evaluatorPipelines: EvaluatorPipelineDefinition[];
  contextPolicies: ContextPolicyDefinition[];
  sessionPolicies: SessionPolicyDefinition[];
  memoryPolicies: MemoryPolicyDefinition[];
  workspacePolicies: WorkspacePolicyDefinition[];
  stopConditions: StopConditionDefinition[];
};
```

### 5.1 IntentDefinition

Intent router 用 prompt、project context 與 optional user hints 選出 domain pack 與 intent。

```ts
export type IntentDefinition = {
  id: string;
  description: string;
  examples: string[];
  workflowTemplateRef: string;
  requiredInputs: string[];
  defaultContextPolicyRef: string;
  defaultSessionPolicyRef: string;
};
```

software v1 intents：

- `implement_feature`
- `fix_bug`
- `refactor_code`
- `write_tests`
- `update_docs`
- `investigate_failure`

### 5.2 WorkflowTemplate

Workflow template 是 manifest generation 的安全模板，不直接執行。

```ts
export type WorkflowTemplate = {
  id: string;
  intentRefs: string[];
  stages: WorkflowStageTemplate[];
};

export type WorkflowStageTemplate = {
  id: string;
  roleRef: string;
  dependsOn: string[];
  promptTemplateRef: string;
  requiredArtifactRefs: string[];
  evaluatorPipelineRef: string;
  stopConditionRefs: string[];
  workspacePolicyRef?: string;
  allowDynamicExpansion: boolean;
};
```

software v1 default workflow：

```text
understand -> implement -> verify -> summarize
```

`understand` 可產生 implementation plan artifact；`implement` 產生 patch/report；`verify` 由 checker 驗證 tests/evidence；`summarize` 產生 final completion report。

## 6. RoleDefinition 與 AgentProfile

Role 是 workflow responsibility。AgentProfile 是實際 agent runtime/model/tooling template。Task 只引用 role；runtime resolve 後才得到 agent profile、harness、skills、MCP、memory scope 與 prompt template。

```ts
export type RoleDefinition = {
  id: string;
  responsibility: string;
  defaultAgentProfileRef: string;
  allowedAgentProfileRefs: string[];
  artifactInputs: string[];
  artifactOutputs: string[];
  stopAuthority: "none" | "can-suggest" | "can-accept" | "can-reject";
};
```

```ts
export type AgentProfile = {
  id: string;
  name: string;
  provider: "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";
  model?: string;
  harnessRef: string;
  systemPromptRef?: string;
  agentsMdRefs: string[];
  promptTemplateRef: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
  memoryScopes: string[];
  contextPolicyRef: string;
  sessionPolicyRef: string;
  toolPolicy: ToolPolicy;
  budgetPolicy: BudgetPolicy;
};
```

```ts
export type ToolPolicy = {
  allowedTools: string[];
  deniedTools: string[];
  requiresApprovalFor: string[];
};

export type BudgetPolicy = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicrosUsd?: number;
  maxWallTimeSeconds?: number;
};
```

software v1 roles：

- `explorer`: read-only analysis, produces plan/evidence.
- `maker`: edits workspace, produces implementation artifact.
- `checker`: verifies artifact, tests, diff, risks; can reject completion.
- `summarizer`: produces final completion report from accepted artifacts.

Rules:

- Planner may select only `allowedAgentProfileRefs`.
- Effective skills are `AgentProfile.skillRefs + Task.skillRefs`, then resolved to snapshots.
- Effective MCP grants are the intersection of profile grants and task grants.
- `AGENTS.md` is referenced by `agentsMdRefs`; ContextBuilder reads/compresses/injects it. It is not blindly copied into every task.
- provider/model live in `AgentProfile`, not task. Task describes role and artifact work.

## 7. Manifest Changes

`SouthstarWorkflowManifest` should gain first-class definitions while remaining the canonical run-specific workflow truth.

```ts
export type SouthstarWorkflowManifest = {
  schemaVersion: "southstar.v2";
  workflowId: string;
  title: string;
  domain: string;
  intent: string;
  goalPrompt: string;
  domainPackRef: { id: string; version: string; contentHash: string };
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  tasks: WorkflowTaskDefinition[];
  harnessDefinitions: HarnessDefinition[];
  artifactContracts: ArtifactContract[];
  evaluatorPipelines: EvaluatorPipelineDefinition[];
  contextPolicies: ContextPolicyDefinition[];
  sessionPolicies: SessionPolicyDefinition[];
  memoryPolicies: MemoryPolicyDefinition[];
  workspacePolicies: WorkspacePolicyDefinition[];
  approvalPolicy?: ApprovalPolicy;
};
```

Task authoring shape should move from `subagents[]` to role-based runtime input:

```ts
export type WorkflowTaskDefinition = {
  id: string;
  name: string;
  domain: string;
  roleRef: string;
  dependsOn: string[];
  promptInputs: Record<string, unknown>;
  execution: TaskExecutionSpec;
  requiredArtifactRefs: string[];
  evaluatorPipelineRef: string;
  contextPolicyRef?: string;
  sessionPolicyRef?: string;
  workspacePolicyRef?: string;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
  rootSession: {
    maxRepairAttempts: number;
    repairStrategies: RepairStrategy[];
  };
};
```

`subagents[]` becomes resolved runtime output in `TaskEnvelope`, not the primary domain-pack authoring surface.

## 8. ContextBuilder

ContextBuilder is the only module allowed to assemble agent prompt context. It produces a durable `ContextPacket`.

```ts
export type ContextPacket = {
  id: string;
  runId: string;
  taskId: string;
  roleRef: string;
  agentProfileRef: string;
  taskGoal: string;
  roleInstruction: string;
  systemInstruction?: string;
  agentsMdBlocks: ContextBlock[];
  artifactContracts: ContextBlock[];
  selectedMemories: ContextBlock[];
  priorArtifacts: ContextBlock[];
  checkpointSummary?: ContextBlock;
  workspaceSummary?: ContextBlock;
  failureSummary?: ContextBlock;
  skillInstructions: ContextBlock[];
  mcpGrantSummary: ContextBlock[];
  forbiddenActions: string[];
  budget: BudgetPolicy;
  tokenEstimate: TokenEstimate;
  excludedCandidates: ContextExclusion[];
};
```

```ts
export type ContextBlock = {
  id: string;
  sourceType: "prompt" | "role" | "agents-md" | "memory" | "artifact" | "checkpoint" | "skill" | "mcp" | "failure" | "workspace";
  title: string;
  text: string;
  sourceRef?: string;
  tokenEstimate: number;
};
```

ContextBuilder rules:

- Never inject full transcript by default.
- Memory injection must be ranked, compressed, bounded and audited.
- `AGENTS.md` and skill instructions are deduplicated and summarized if over budget.
- Prior artifact facts outrank long-term memory.
- Recent failure summaries outrank generic preferences.
- ContextPacket is stored as `runtime_resources(resource_type='context_packet')`.
- TaskEnvelope references `contextPacketId` and contains the final resolved context.

## 9. Memory Architecture

Memory uses provider abstraction. mem0 is an optional provider; SQLite minimal provider is required for tests and local offline execution.

```ts
export interface MemoryProvider {
  add(input: MemoryWriteRequest): Promise<MemoryWriteResult>;
  search(input: MemorySearchRequest): Promise<MemoryCandidate[]>;
  update?(input: MemoryUpdateRequest): Promise<void>;
  delete?(input: MemoryDeleteRequest): Promise<void>;
}
```

Southstar owns memory governance:

```ts
export type MemoryPolicyDefinition = {
  id: string;
  providerRef: "sqlite" | "mem0" | string;
  scopes: string[];
  maxInjectedTokens: number;
  maxCandidates: number;
  requireWriteApproval: boolean;
  allowedKinds: MemoryKind[];
  ranking: {
    relevanceWeight: number;
    recencyWeight: number;
    successWeight: number;
    confidenceWeight: number;
  };
  compression: {
    strategy: "none" | "extractive" | "llm-summary";
    maxTokensPerMemory: number;
  };
};
```

```ts
export type MemoryItem = {
  id: string;
  scope: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  sourceRunId?: string;
  sourceArtifactId?: string;
  confidence: number;
  successScore: number;
  tokenCost: number;
  expiresAt?: string;
  lastUsedAt?: string;
};

export type MemoryKind =
  | "preference"
  | "architecture_decision"
  | "domain_pattern"
  | "failure_lesson"
  | "artifact_summary"
  | "workflow_learning";
```

Memory flow:

```text
artifact/evaluator/session result
  -> propose memory delta
  -> approval policy
  -> MemoryProvider.add
  -> Southstar memory resource/audit
  -> future ContextBuilder.search/rank/compress/inject
```

mem0 integration:

- mem0 may store and retrieve semantic memory.
- Southstar stores memory metadata, decisions, source refs, injection trace and approval state.
- mem0 ids are external provider refs, not Southstar memory primary keys.
- If mem0 is unavailable, SQLite provider must still pass the software vertical slice.

## 10. Session Graph

SessionGraph manages execution-state lineage. It is distinct from memory and workspace.

```ts
export interface SessionGraphProvider {
  createSession(input: CreateSessionInput): Promise<SessionNode>;
  checkpoint(input: CreateCheckpointInput): Promise<SessionCheckpoint>;
  fork(input: ForkSessionInput): Promise<SessionNode>;
  reset(input: ResetSessionInput): Promise<SessionNode>;
  rollback(input: RollbackSessionInput): Promise<RollbackResult>;
}
```

```ts
export type SessionNode = {
  id: string;
  runId: string;
  taskId: string;
  roleRef: string;
  agentProfileRef: string;
  parentSessionId?: string;
  baseCheckpointId?: string;
  forkReason?: string;
  status: "active" | "completed" | "failed" | "superseded" | "rolled_back";
};

export type SessionCheckpoint = {
  id: string;
  sessionId: string;
  runId: string;
  taskId: string;
  parentCheckpointId?: string;
  contextPacketId: string;
  memorySnapshotId?: string;
  workspaceSnapshotRef?: string;
  artifactRefs: string[];
  transcriptSummary: string;
  failureSummary?: string;
  metrics: {
    tokens?: number;
    costMicrosUsd?: number;
    toolCalls?: number;
    durationMs?: number;
  };
};
```

Rules:

- `checkpoint` stores summaries and artifact refs, not full transcript by default.
- `fork` creates a new session from checkpoint summary, selected memory, prior artifacts and optional workspace snapshot.
- `reset` reruns task from original envelope or selected checkpoint, with fresh volatile transcript.
- `rollback` marks later session/artifact outputs as superseded and restores workflow/task state to a checkpoint.
- Rollback never deletes artifact/history rows; it appends history and changes resource status.
- LangGraph can be added later as `LangGraphSessionGraphProvider`, but Southstar minimal provider must exist first.

## 11. Workspace Snapshot Provider

For software domain, Git is used for workspace snapshots. Git is not the session graph; it only captures filesystem/code state.

```ts
export interface WorkspaceSnapshotProvider {
  snapshot(input: SnapshotWorkspaceInput): Promise<WorkspaceSnapshotRef>;
  fork(input: ForkWorkspaceInput): Promise<WorkspaceHandle>;
  rollback(input: RollbackWorkspaceInput): Promise<WorkspaceHandle>;
  diff(input: WorkspaceDiffInput): Promise<WorkspaceDiff>;
}
```

```ts
export type WorkspaceSnapshotRef = {
  provider: "git";
  repoRoot: string;
  commitSha: string;
  branchName?: string;
  worktreePath?: string;
  dirtyPatchRef?: string;
};
```

Git usage:

- Snapshot at task start and accepted checkpoint.
- Fork software attempts into isolated worktrees.
- Rollback worktree to checkpoint ref when evaluator rejects implementation.
- Store diffs/artifact evidence as artifact blobs or runtime resources.

Git is not used for:

- agent message history
- memory retrieval state
- approval decisions
- MCP grants
- token/cost metrics
- runtime scheduling state

## 12. Evaluator Pipeline 與 StopCondition

Completion cannot depend on subagent self-reporting. RootSession runs evaluator pipeline.

```ts
export type EvaluatorPipelineDefinition = {
  id: string;
  evaluators: EvaluatorStepDefinition[];
  onFailure: EvaluatorFailurePolicy;
};

export type EvaluatorStepDefinition = {
  id: string;
  kind: "schema" | "domain" | "test" | "evidence" | "checker-agent" | "policy";
  config: Record<string, unknown>;
  required: boolean;
};
```

```ts
export type StopConditionDefinition = {
  id: string;
  type: "artifact-accepted" | "tests-passed" | "checker-passed" | "human-approved" | "custom";
  evaluatorRefs: string[];
};
```

software v1 evaluator pipeline:

1. schema evaluator: output contains required fields.
2. evidence evaluator: artifact references changed files, commands, test output, risks.
3. test evaluator: required commands passed or failure is justified.
4. checker-agent evaluator: independent checker reviews artifact/diff.
5. policy evaluator: no disallowed tool/secret/external-write violation.

Only when stop condition passes:

```text
artifact accepted
checker passed
tests passed or explicitly waived by policy
no unresolved high-risk finding
```

Task status may become `completed`; run status may become `passed/completed`.

## 13. Repair / Fork / Rollback / Replan

RootSession selects a recovery strategy based on evaluator finding.

```ts
export type RepairStrategy =
  | "retry-same-agent"
  | "fork-from-checkpoint"
  | "rollback-workspace"
  | "spawn-checker"
  | "request-workflow-revision"
  | "ask-human";
```

Default policy:

- Missing artifact field: `retry-same-agent`.
- Test failure after code edit: `rollback-workspace` or `fork-from-checkpoint`.
- Ambiguous requirement: `ask-human` or `request-workflow-revision`.
- Checker rejects approach: `fork-from-checkpoint`.
- Missing prerequisite task: `request-workflow-revision`.
- Budget exceeded: `ask-human`.

Every recovery decision appends history:

```text
recovery.strategy_selected
session.forked
workspace.rollback_requested
workflow.revision_requested
approval.requested
```

## 14. TaskEnvelope v2

TaskEnvelope should carry resolved runtime inputs, not authoring definitions.

```ts
export type TaskEnvelopeV2 = {
  schemaVersion: "southstar.task-envelope.v2";
  runId: string;
  workflowId: string;
  taskId: string;
  domain: string;
  intent: string;
  role: RoleDefinition;
  agentProfile: AgentProfile;
  harness: HarnessDefinition;
  contextPacket: ContextPacket;
  skills: ResolvedSkillSnapshot[];
  mcpGrants: ResolvedMcpGrant[];
  vaultLeases: ResolvedVaultLease[];
  artifactContracts: ArtifactContract[];
  evaluatorPipeline: EvaluatorPipelineDefinition;
  session: {
    sessionId: string;
    baseCheckpointId?: string;
  };
  workspace?: {
    handle: WorkspaceHandle;
    baseSnapshotRef?: WorkspaceSnapshotRef;
  };
};
```

Container receives only task-scoped resolved material:

- envelope JSON
- skill snapshot files
- allowed MCP config
- task-scoped vault leases
- workspace mount
- output path for task result

## 15. Runtime Stores

Reuse existing `runtime_resources` first; add dedicated tables only if query volume or integrity requires it.

New resource types:

- `domain_pack_snapshot`
- `agent_profile_snapshot`
- `context_packet`
- `memory_snapshot`
- `memory_injection_trace`
- `session_node`
- `session_checkpoint`
- `workspace_snapshot`
- `evaluator_pipeline_result`
- `stop_condition_result`
- `recovery_decision`

Recommended later dedicated tables:

- `session_nodes`
- `session_checkpoints`
- `context_packets`

First implementation may keep them in `runtime_resources` for speed and compatibility.

## 16. Software Domain Pack v1

Required vertical slice:

```text
Goal: "Implement calc sum and update tests/docs"
  -> intent implement_feature
  -> workflow understand -> implement -> verify -> summarize
  -> explorer creates implementation plan
  -> maker edits workspace in Docker/Tork worktree
  -> checker verifies diff/tests/artifact
  -> root session repairs/forks if rejected
  -> accepted implementation_report
  -> completion_report
  -> memory_delta proposed
  -> session checkpoint created
```

Artifacts:

- `implementation_plan`
- `implementation_report`
- `verification_report`
- `completion_report`

`implementation_report` required fields:

- `summary`
- `filesChanged`
- `commandsRun`
- `testResults`
- `risks`
- `artifactEvidence`

Completion is invalid if the report is present but evidence/test/checker gate fails.

## 17. API / CLI Changes

Add CLI/API commands:

```text
southstar:v2 domain-packs
southstar:v2 plan --goal "..." --domain software
southstar:v2 context --run-id ... --task-id ...
southstar:v2 sessions --run-id ...
southstar:v2 fork-session --checkpoint-id ...
southstar:v2 rollback --checkpoint-id ...
southstar:v2 memory search --query "..."
southstar:v2 memory approve --delta-id ...
```

API endpoints:

```text
GET  /api/v2/domain-packs
GET  /api/v2/runs/:runId/tasks/:taskId/context
GET  /api/v2/runs/:runId/session-graph
POST /api/v2/runs/:runId/sessions/:sessionId/fork
POST /api/v2/runs/:runId/rollback
GET  /api/v2/runs/:runId/memory/injections
POST /api/v2/memory/:deltaId/decision
```

## 18. Implementation Plan

### Phase 1: Contracts and fixtures

- Add `src/v2/domain-packs/types.ts`.
- Add `src/v2/context/types.ts`.
- Add `src/v2/memory/provider.ts`.
- Add `src/v2/session-graph/provider.ts`.
- Add `src/v2/workspace/provider.ts`.
- Add `src/v2/evaluators/pipeline.ts` types.
- Add software domain pack fixture and tests validating roles, profiles, artifacts, evaluator pipeline and stop conditions.

Acceptance:

- Domain pack validator rejects task templates without role/profile/artifact/evaluator references.
- Software pack can classify a prompt into `implement_feature`.
- Manifest generation can only use allowed role/profile refs.

### Phase 2: ContextBuilder and memory provider

- Implement `ContextBuilder`.
- Implement SQLite `MemoryProvider`.
- Add mem0 adapter interface and config shape, but keep it optional.
- Store `context_packet`, `memory_snapshot`, `memory_injection_trace`.
- Replace `retrieveApprovedMemory(scope, limit)` path with ContextBuilder-driven retrieval.

Acceptance:

- ContextPacket contains bounded selected memory and excludes full transcript.
- Tests prove memory injection trace records included/excluded candidates and token estimates.
- System passes without mem0 configured.

### Phase 3: Session graph and workspace snapshots

- Implement minimal SQLite `SessionGraphProvider`.
- Implement Git `WorkspaceSnapshotProvider` for software domain.
- Create checkpoint at task start, after accepted artifact and before recovery actions.
- Implement fork/reset/rollback state transitions.

Acceptance:

- Fork creates new session from checkpoint without copying transcript.
- Rollback marks later artifacts superseded and restores workspace snapshot.
- Git snapshot refs appear in session checkpoint resource.

### Phase 4: Evaluator pipeline and recovery

- Implement evaluator pipeline orchestration.
- Add software schema/evidence/test/checker/policy evaluators.
- Add recovery strategy selection.
- Wire repair/fork/rollback/replan decisions into root session.

Acceptance:

- Missing field triggers retry.
- Test failure triggers rollback or fork.
- Checker rejection prevents completion.
- Accepted artifact requires stop condition pass.

### Phase 5: Tork/TaskEnvelope v2 integration

- Introduce `TaskEnvelopeV2`.
- Materialize ContextPacket, skill snapshots, MCP grants, vault leases and workspace mount into Docker task.
- Keep Tork projection free of agent/session/memory semantics.

Acceptance:

- Tork projection still contains only execution fields.
- Container can run from TaskEnvelopeV2 and return evaluator-ready task result.

### Phase 6: API/CLI inspection

- Add context/session/memory inspection APIs.
- Add CLI commands for context, session graph, fork, rollback and memory approval.

Acceptance:

- Operator can inspect why an agent saw a memory item.
- Operator can see session lineage and rollback target.
- Operator can approve/reject memory deltas.

## 19. Testing Strategy

Unit tests:

- domain pack validation
- intent routing
- role/profile resolution
- context packet token budgeting
- memory ranking/compression/audit
- session graph checkpoint/fork/reset/rollback
- workspace snapshot provider
- evaluator pipeline
- stop condition

Integration tests:

- prompt -> software domain manifest
- manifest -> context packet
- context packet -> task envelope
- task result -> evaluator pipeline -> repair/fork/accept

E2E:

- Docker/Tork software fixture run.
- One failing artifact repaired.
- One checker rejection forks from checkpoint.
- One rollback restores Git workspace snapshot.
- One memory delta is approved and injected into a later run.

## 20. Success Criteria

The design is complete when:

- A software prompt produces a domain-pack-backed manifest, not hard-coded planner tasks.
- Every executable task resolves role, agent profile, skills, MCP grants, context policy, session policy and evaluator pipeline.
- Every agent invocation has a stored ContextPacket.
- Memory injection is ranked, compressed, bounded and audited.
- Session fork/reset/rollback are represented in durable state.
- Git workspace snapshot is linked to software session checkpoints.
- RootSession can repair, fork, rollback or request workflow revision based on evaluator findings.
- Completion requires evaluator pipeline and stop condition pass.
- Tork remains an executor provider, not workflow/session/memory truth.

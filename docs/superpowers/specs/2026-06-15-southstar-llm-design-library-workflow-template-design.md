# Southstar LLM Design Library / Workflow Template 設計文件

日期：2026-06-15

## 1. 目標

本設計把 Southstar v2 從「由 hard-coded generator 產生少數 workflow 形狀」推進為「使用者提出需求後，由 LLM 透過需求澄清、Design Library 搜尋、agent capability composition、DAG 設計與人類審核，建立可重用 workflow template，並可編譯成 runtime workflow 執行」的平台。

核心目標：

- 使用者第一次提出新類型需求時，LLM 先用 brainstorming 式追問釐清需求；未來相似需求可直接匹配 validated template，不再重問相同問題。
- Agent definition、agent profile、system prompt、skill、MCP capability、input/output/evidence contract、validator、policy、workflow template 都集中在 SQLite-first Design Library 管理。
- Runtime workflow 只保存「本次執行採用的 immutable compiled snapshot」，不是 reusable definition 的主要來源。
- LLM 可從 Design Library 組合 agent 與 DAG flow，也可用 web search 找 skill / MCP / tooling pattern 作 proposal evidence，但不能直接授權或寫入 approved library。
- 人可以透過完整 DAG visual editor 與 LLM patch loop 新增、刪除、調整 task、dependency、agent、model、contract、validator、capability。
- 人確認後產生 `approved_for_run` template version，可直接執行當前需求；run 通過 evaluator / stop condition 後升級為 `validated`，未來才可被 auto-run policy 預設推薦。

## 2. 非目標

- 不讓 LLM 直接建立 approved reusable definition。
- 不讓 LLM 直接建立 MCP grant、secret、credential 或外部 write 權限。
- 不讓 workflow template 直接成為 runtime state；runtime workflow 仍由 deterministic compiler materialize。
- 不在第一階段執行 unrestricted generated script；DAG / recipe 必須是 typed JSON payload。
- 不把 workspace 當 workflow truth；workspace 只承載 file/code/browser/session state 與 evidence。
- 不把 raw transcript、大型 log、secret value 放進 library definition。

## 3. 既有基礎與缺口

既有 v2 已有：

- `DomainPack`、`AgentProfile`、`WorkflowGenerationPlan`、`SouthstarWorkflowManifest`、`TaskEnvelopeV2`。
- `workflow_runs.workflow_manifest_json` 作為每次 run 的 runtime snapshot。
- `runtime_resources` 保存 context packet、task envelope、skill snapshot、executor binding 等 runtime resource。
- Tork 作 executor provider；Southstar 保持 workflow/runtime/artifact/evaluator truth。

主要缺口：

- Agent/profile/template 仍以 code seed 為主，缺少 SQLite-first reusable library。
- 目前 workflow generator 是 deterministic narrow/broad DAG，不能由 LLM 依需求動態組 agent 與 flow。
- `AgentProfile` 同時承載 provider/model/prompt/skill/MCP 等概念，缺少 design-time versioning 與 proposal lifecycle。
- 缺少人機共編 DAG 的 typed patch model。
- 缺少 template lifecycle：`approved_for_run`、`validated`、failure evidence、reuse signature、auto-run policy。
- 缺少 flow-level input/process/output compatibility validator。

## 4. 架構總覽

採用 **Design Library + Workflow Design Draft + Deterministic Compiler**。

```text
User Goal
  -> Requirement Clarifier
  -> Design Library Search
  -> Optional Web Discovery as Proposal Evidence
  -> Agent Capability Composition
  -> Workflow Design Draft
  -> DAG Visual Editor / LLM Patch Loop
  -> Design + Compile Validation
  -> Human Approval
  -> Workflow Template Version: approved_for_run
  -> Deterministic Compiler
  -> SouthstarWorkflowManifest Runtime Snapshot
  -> Tork / Docker Execution
  -> Runtime Artifact + Evaluator + Stop Condition
  -> Template Version: validated
```

責任邊界：

1. **Design Library**：設計期 truth。保存 reusable definitions、immutable versions、drafts、history。
2. **LLM Design Studio**：設計與提案者。可 clarify、search、compose、propose patch、propose missing definitions。
3. **DAG Visual Editor**：人類審核與編輯 surface。所有 UI 編輯與 LLM 建議都轉成同一種 typed patch。
4. **Deterministic Compiler**：安全 materializer。只接受 approved template / definitions + run inputs，輸出 runtime manifest。
5. **Runtime Workflow**：執行期 truth。保存本次 compiled snapshot、task state、artifact、workspace binding、executor observation。

一句話：**LLM designs; human approves; compiler materializes; runtime executes.**

## 5. Design Library Schema

設計原則對齊 runtime workflow 的 `issues + issue_history` 思路：

- **head snapshot + append-only history**
- 用少量 canonical tables 承載所有 design-time state
- version / draft / patch / approval 全部以 history event 表達

### 5.1 Canonical Tables（2+1）

```text
library_objects
library_history
library_similarity_index   // optional，phase 2/6 可再加
```

#### `library_objects`（design-time head snapshot）

用途等同 runtime 的 `issues`：

- 穩定 object identity
- 當前 head/version 狀態
- 查詢與 UI 列表入口

```text
id text primary key
object_key text unique not null
object_kind text not null
status text not null
head_version_id text
state_json text not null
created_at text not null
updated_at text not null
```

`state_json` 承載原本分散在 definitions/drafts 的 head 資訊（例如 tags、domain refs、current validation summary、reuse signature、draft status）。

#### `library_history`（append-only source of truth）

用途等同 runtime 的 `issue_history`：所有設計期事實都先寫 history，再投影回 `library_objects`。

```text
id text primary key
object_id text not null references library_objects(id)
sequence integer not null
event_type text not null
actor_type text not null
payload_json text not null
created_at text not null
unique(object_id, sequence)
```

主要 event 範例：

- `object.created`
- `version.created`
- `draft.opened`
- `draft.patch_applied`
- `draft.validated`
- `draft.approved_for_run`
- `template.validated_from_run`
- `template.deprecated`

#### `library_similarity_index`（optional projection）

僅在需要高效相似度查詢時啟用。若未啟用，先用 `library_objects.state_json` + `library_history` projection 完成匹配。

```text
id text primary key
object_id text not null references library_objects(id)
signature text not null
embedding_json text not null
metadata_json text not null
created_at text not null
```

### 5.2 Definition Kinds

第一版只需要 7 種 `definition_kind`。它們作為 object/event payload 的 typed discriminator，不需要一張獨立 version table：

```ts
type LibraryDefinitionKind =
  | "agent_spec"
  | "capability_spec"
  | "contract_spec"
  | "validator_spec"
  | "policy_bundle"
  | "workflow_template"
  | "workflow_recipe";
```

## 6. Agent / Capability / Contract Payloads

### 6.1 `agent_spec`

`agent_spec` 合併 AgentDefinition、AgentProfile、SystemPrompt、ModelSelectionPolicy 的可執行部分，但仍可引用外部 policy / capability / contract。

```ts
type AgentSpecPayload = {
  schemaVersion: "southstar.library.agent_spec.v1";
  identity: {
    displayName: string;
    description: string;
    domainRefs: string[];
    roleRefs: string[];
    capabilityTags: string[];
  };
  responsibilities: {
    goals: string[];
    nonGoals: string[];
    stopAuthority: "none" | "can-suggest" | "can-accept" | "can-reject";
  };
  executionProfiles: Array<{
    id: string;
    provider: string;
    model: string;
    harnessRef: string;
    complexityBand: "trivial" | "simple" | "moderate" | "complex" | "critical";
    preferredFor: string[];
    fallbackFor: string[];
    budget: {
      maxInputTokens: number;
      maxOutputTokens: number;
      maxCostMicrosUsd?: number;
      maxWallTimeSeconds?: number;
    };
  }>;
  prompts: {
    system: string;
    taskTemplates: Array<{ id: string; body: string }>;
    outputRules: string[];
    safetyRules: string[];
  };
  capabilities: {
    skillRefs: string[];
    mcpCapabilityRefs: string[];
    requiredToolCapabilities: string[];
    memoryScopes: string[];
  };
  policies: {
    toolPolicyRef?: string;
    contextPolicyRef?: string;
    sessionPolicyRef?: string;
    workspacePolicyRef?: string;
    approvalPolicyRef?: string;
  };
  contracts: {
    inputContractRefs: string[];
    outputContractRefs: string[];
    evidenceContractRefs: string[];
    validatorRefs: string[];
  };
  provenance: DefinitionProvenance;
};
```

Agent 要明確定義：身份、domain/role、責任、non-goals、stop authority、可用 provider/model profile、system prompt、task prompt templates、output rules、safety rules、skill refs、MCP capability refs、tool capabilities、memory scope、policy refs、input/output/evidence contracts、validators、provenance。

### 6.2 `capability_spec`

Skill、MCP capability、tool capability、knowledge pack 合併成同一 payload。

```ts
type CapabilitySpecPayload = {
  schemaVersion: "southstar.library.capability_spec.v1";
  capabilityType: "skill" | "mcp_capability" | "tool_capability" | "knowledge_pack";
  title: string;
  description: string;
  instructions?: string;
  requiredMounts: string[];
  requiredOperations: string[];
  risk: {
    level: "low" | "medium" | "high";
    dataSensitivity: "public" | "workspace" | "private" | "secret";
    approvalRequired: boolean;
  };
  externalBinding?: {
    serverType?: string;
    packageName?: string;
    homepageUrl?: string;
    sourceUrls: string[];
  };
  contractRefs: string[];
  validatorRefs: string[];
  provenance: DefinitionProvenance;
};
```

LLM web search 只能產生 `capability_spec` proposal。MCP grant 是 governance/runtime resource，不是 capability 本身。

### 6.3 `contract_spec`

Input、output、evidence contract 合併。

```ts
type ContractSpecPayload = {
  schemaVersion: "southstar.library.contract_spec.v1";
  contractType: "input" | "output" | "evidence" | "combined";
  fields: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "object" | "array" | "file" | "url";
    required: boolean;
    description: string;
  }>;
  evidenceRequirements?: Array<{
    kind: "file-diff" | "test-result" | "command-output" | "url" | "screenshot" | "human-approval" | "artifact-ref";
    required: boolean;
    description: string;
  }>;
  artifactType?: string;
};
```

### 6.4 `validator_spec`

Validator 與 evaluator pipeline 合併。

```ts
type ValidatorSpecPayload = {
  schemaVersion: "southstar.library.validator_spec.v1";
  validatorType: "schema" | "test" | "policy" | "checker-agent" | "human" | "pipeline" | "custom";
  config: Record<string, unknown>;
  required: boolean;
  failureStrategy: "retry-same-agent" | "fork-from-checkpoint" | "rollback-workspace" | "request-workflow-revision" | "ask-human";
  appliesToContractRefs: string[];
  steps?: Array<{ validatorRef: string; required: boolean }>;
};
```

### 6.5 `policy_bundle`

Model, tool, context, memory, session, workspace, budget, approval, auto-run policy 合併。

```ts
type PolicyBundlePayload = {
  schemaVersion: "southstar.library.policy_bundle.v1";
  policyTypes: Array<"model-selection" | "tool" | "context" | "memory" | "session" | "workspace" | "budget" | "approval" | "auto-run">;
  modelSelection?: {
    allowedModels: Array<{
      provider: string;
      model: string;
      tier: "cheap" | "standard" | "premium" | "specialist";
      complexityBands: string[];
      strengths: string[];
      maxCostMicrosUsd?: number;
    }>;
    fallback: { provider: string; model: string };
  };
  tool?: {
    allowedTools: string[];
    deniedTools: string[];
    requiresApprovalFor: string[];
    networkPolicy: "none" | "read-only" | "approved-hosts" | "unrestricted";
    filesystemPolicy: "read-only" | "workspace-write" | "restricted-write";
    shellPolicy: "none" | "safe-commands" | "workspace-shell";
  };
  context?: { maxInputTokens: number; includeAgentsMd: boolean; includeWorkspaceSummary: boolean };
  memory?: { scopes: string[]; maxInjectedTokens: number; maxCandidates: number; requireWriteApproval: boolean };
  session?: { checkpointOn: string[]; allowFork: boolean; allowReset: boolean; allowRollback: boolean };
  workspace?: {
    provider: "git" | "filesystem" | "browser-session" | "none";
    isolation: "shared" | "per-task-worktree" | "per-branch-worktree" | "readonly";
    snapshotAt: string[];
    rollbackOn: string[];
    allowedPaths?: string[];
    deniedPaths?: string[];
    diffPolicy?: { requiredForOutput: boolean; maxDiffSizeBytes?: number; summarizeBeforeContext: boolean };
  };
  budget?: { maxInputTokens: number; maxOutputTokens: number; maxCostMicrosUsd?: number; maxWallTimeSeconds?: number };
  approval?: { requiredForRisk: string[]; requireManualFor: string[] };
  autoRun?: { allowedOnlyWhenTemplateStatus: "validated"; requireLowRisk: boolean; requireAllInputs: boolean };
};
```

## 7. Workflow Template / Recipe

### 7.1 Flow Patterns

DAG 不是 unrestricted graph。LLM / UI 使用可驗證 flow patterns 組合：

第一版支援：

1. `linear`
2. `fanout_fanin`
3. `maker_checker`
4. `specialist_parallel`
5. `human_gate`
6. `conditional_branch`
7. `template_create`
8. `template_reuse`

Recovery policy 支援：

1. `retry_same_agent`
2. `rollback_workspace`
3. `fork_from_checkpoint`
4. `request_workflow_revision`

Advanced metadata 可先保存但不必第一版完整執行：`map_reduce`、`research_synthesis`、`competition`、`debate`、`multi_round_critique`。

### 7.2 `workflow_template`

保存 exact approved DAG，可穩定重跑。

```ts
type WorkflowTemplatePayload = {
  schemaVersion: "southstar.library.workflow_template.v1";
  templateType: "exact";
  inputContractRef: string;
  flow: {
    primaryPattern: string;
    secondaryPatterns: string[];
    nodes: Array<{
      id: string;
      nodeType: "agent_task" | "validator_task" | "human_gate" | "decision" | "fan_in" | "artifact_transform" | "template_operation";
      name: string;
      roleRef?: string;
      agentSpecRef?: string;
      executionProfileSelector?: { complexityBand: string; preferredProfileId?: string };
      contractRefs: string[];
      validatorRefs: string[];
      capabilityRefs: string[];
      mcpCapabilityRefs: string[];
      workspacePolicyRef?: string;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      edgeType: "depends_on" | "artifact_flow" | "approval_gate" | "decision_path" | "fan_in";
      artifactContractRefs: string[];
      workspaceStateRequired?: boolean;
      condition?: string;
    }>;
    fanIns?: Array<{
      nodeId: string;
      strategy: "all-pass" | "majority" | "best-candidate" | "checker-arbitrated";
      requiredInputs: string[];
    }>;
    recovery: { onValidatorFailure: string; maxAttempts: number };
  };
  outputContractRefs: string[];
  evidenceContractRefs: string[];
  stopConditionValidatorRefs: string[];
  lifecycle: {
    status: "draft" | "approved_for_run" | "validated" | "deprecated" | "blocked";
    validatedByRunIds: string[];
    failureEvidenceRefs: string[];
  };
  reuse: {
    signature: string;
    tags: string[];
    requiredInputs: string[];
    assumptionDefaults: Record<string, unknown>;
    clarificationPolicy: {
      askOnlyWhenMissingRequiredInput: boolean;
      askWhenSimilarityBelow: number;
      askWhenRiskAbove: "low" | "medium" | "high";
    };
    requirementSpecSnapshot: RequirementSpec;
  };
};
```

### 7.3 `workflow_recipe`

保存 future adaptation strategy。

```ts
type WorkflowRecipePayload = {
  schemaVersion: "southstar.library.workflow_recipe.v1";
  baseTemplateRef: string;
  adaptationRules: Array<{
    condition: string;
    action: "add-task" | "remove-task" | "parallelize" | "add-checker" | "upgrade-model" | "require-approval";
    parameters: Record<string, unknown>;
  }>;
  allowedAgentSpecRefs: string[];
  allowedCapabilityRefs: string[];
  maxTasks: number;
  maxParallelTasks: number;
};
```

## 8. Draft / Patch / LLM Composition

### 8.1 Requirement Clarification

第一次建立 template 才進入 clarification。LLM 產生：

```ts
type RequirementSpec = {
  summary: string;
  requiredInputs: string[];
  clarifiedInputs: Record<string, unknown>;
  assumptions: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  riskNotes: string[];
};
```

未來相似需求使用 template `reuse.signature` 與 input schema 匹配，只有缺 input、低 confidence 或高風險才再問。

### 8.2 Library Search / Web Discovery

LLM 必須先搜尋內部 validated library。外部 web search 只能作 proposal evidence。

```ts
type LibrarySearchTrace = {
  query: string;
  matchedDefinitions: Array<{ definitionRef: string; kind: string; score: number; reason: string }>;
  gaps: string[];
};

type ExternalDiscoveryTrace = {
  source: "web";
  queries: string[];
  sources: Array<{ url: string; title: string; summary: string; proposedUse: string; risk: "low" | "medium" | "high" }>;
};
```

### 8.3 Agent Capability Composition

LLM 可選 existing agent 或提出 proposed agent / capability。

```ts
type AgentComposition = Array<{
  taskIntent: string;
  selectedAgentSpecRef?: string;
  proposedAgentSpec?: unknown;
  selectedExecutionProfile?: string;
  complexityBand: "trivial" | "simple" | "moderate" | "complex" | "critical";
  requiredCapabilityRefs: string[];
  requiredMcpCapabilities: string[];
  requiredContracts: string[];
  validators: string[];
  rationale: string;
  unresolvedRisks: string[];
}>;
```

### 8.4 WorkflowTemplatePatch

LLM 與 UI 編輯都產生同一種 typed patch。

```ts
type WorkflowTemplatePatch = {
  baseDraftId: string;
  operations: Array<
    | { op: "add-node"; node: unknown }
    | { op: "remove-node"; nodeId: string }
    | { op: "update-node"; nodeId: string; patch: Record<string, unknown> }
    | { op: "add-edge"; edge: unknown }
    | { op: "remove-edge"; edgeId: string }
    | { op: "replace-agent"; nodeId: string; agentSpecRef: string }
    | { op: "set-contracts"; nodeId: string; contractRefs: string[] }
    | { op: "set-validators"; nodeId: string; validatorRefs: string[] }
  >;
  rationale: string;
  actor: "llm" | "user" | "system";
};
```

每個 patch append `library_history`，支援 diff、rollback、audit。

## 9. Flow I/O Validation 與 Context Passing

### 9.1 Validation Layers

1. **Design-time validation**：DAG 無 cycle、所有 non-root node 有 input source、terminal outputs 有 producer、fan-in inputs 有 upstream producer、contract compatibility、capability compatibility、process coverage。
2. **Compile-time validation**：run inputs 完整、template status 合法、refs 指向 approved/validated immutable versions、model/provider 符合 policy、MCP grant 缺失時插入 human gate 或 block compile、workspace 可 materialize、TaskEnvelopeV2 可生成。
3. **Runtime validation**：只有 accepted artifacts 可餵 downstream、task artifact 符合 output contract、evidence 符合 evidence contract、workspace diff/snapshot 符合 policy、stop condition 通過才完成 run。

### 9.2 Task Context Passing

下游 task 不應自己從 workspace 猜上游做了什麼。正確模型：

```text
Upstream task produces accepted artifact + optional workspace state
Runtime records artifact refs, summaries, workspace snapshot/diff
ContextBuilder builds downstream ContextPacket
Downstream task receives explicit inputs in TaskEnvelope
```

`ContextPacket(task N)` 由以下來源組成：

- run inputs
- upstream accepted artifacts
- artifact summaries
- workspace snapshot / diff summary
- selected memory
- agent/system prompt/skill/MCP summaries
- task-specific instruction

### 9.3 Artifact Flow

每條 edge 可以要求 artifact contract：

```ts
type WorkflowEdge = {
  from: string;
  to: string;
  artifactContractRefs: string[];
  workspaceStateRequired?: boolean;
};
```

Downstream readiness algorithm：

```text
for pending task:
  if all dependencies have accepted artifacts matching edge artifactContractRefs
  and workspace binding is ready when required
  then start task
  else wait
```

### 9.4 Workspace Definition

Workspace 定義放在 `policy_bundle.workspace`。Runtime materialize 後產生 `workspace_binding`。

```ts
type WorkspaceBinding = {
  runId: string;
  taskId: string;
  workspacePolicyRef: string;
  provider: "git" | "filesystem" | "browser-session" | "none";
  repoRoot?: string;
  worktreePath?: string;
  baseSnapshotRef?: string;
  currentSnapshotRef?: string;
  diffArtifactRef?: string;
  status: "ready" | "dirty" | "snapshotted" | "rolled_back";
};
```

Workspace 是 file/code/browser/session state 與 diff/evidence source，不是 workflow truth。

## 10. Artifact / Evidence / Validator Hardening

Southstar 的信任來源不是 LLM transcript，而是 **accepted artifact + evidence packet + validator result**。本節把 artifact、evidence、validator 提升為 workflow correctness 的核心模型。

### 10.1 Artifact Lifecycle

每個 task 產出的 artifact 必須經過明確 lifecycle，不能因 container exit 0 或 LLM 回傳 JSON 就自動成為 downstream input。

```text
created
  -> schema_validated
  -> evidence_validated
  -> policy_validated
  -> accepted | rejected | needs_repair
```

只有 `accepted` artifact 能進 downstream `ContextPacket`。`rejected` 或 `needs_repair` artifact 只能作 failure context / repair input，不可滿足 edge contract。

Runtime artifact reference：

```ts
type RuntimeArtifactRef = {
  id: string;
  runId: string;
  taskId: string;
  artifactType: string;
  contractRef: string;
  producerAgentSpecRef: string;
  producerAttemptId: string;
  status: "created" | "schema_validated" | "evidence_validated" | "policy_validated" | "accepted" | "rejected" | "needs_repair";
  summary: string;
  payloadResourceRef?: string;
  blobRef?: string;
  evidencePacketRefs: string[];
  validatorResultRefs: string[];
  createdAt: string;
  acceptedAt?: string;
};
```

Rules：

- artifact payload 必須符合 `contract_spec`。
- 大型 body、raw logs、transcript 不放進 workflow history；只放 blob/ref + summary。
- artifact 必須記錄 producer task / agent / attempt，支援追溯與 retry 比對。
- terminal artifact 必須有 stop-condition validator result。

### 10.2 Evidence Packet

Evidence 是 artifact 被接受的證據，不等於 artifact 本身。每個 output contract 可要求一組 evidence requirements。

```ts
type EvidencePacket = {
  schemaVersion: "southstar.runtime.evidence_packet.v1";
  id: string;
  runId: string;
  taskId: string;
  artifactRef: string;
  evidenceItems: Array<{
    kind: "file-diff" | "test-result" | "command-output" | "url" | "screenshot" | "human-approval" | "artifact-ref" | "workspace-snapshot" | "policy-decision";
    status: "present" | "missing" | "invalid" | "stale";
    summary: string;
    sourceRef?: string;
    sha256?: string;
    capturedAt: string;
    reproducibleCommand?: string[];
    redactionApplied: boolean;
  }>;
  completeness: {
    requiredCount: number;
    presentCount: number;
    missingKinds: string[];
  };
};
```

Evidence rules：

- software implementation 必須至少有 file diff 或 changed files evidence，並依 validator 要求附 test result / command output。
- browser/web ops 必須以 screenshot / URL / DOM state summary 作 evidence。
- research/report 必須以 source URL / citation extraction 作 evidence。
- human gate 必須產生 human approval evidence。
- stale evidence 不可滿足 validator，例如 workspace diff 與 artifact attempt 不一致。

### 10.3 Validator Result Contract

每個 validator 必須產生 typed result，不能只回傳 boolean。

```ts
type ValidatorResult = {
  schemaVersion: "southstar.runtime.validator_result.v1";
  id: string;
  runId: string;
  taskId?: string;
  artifactRef?: string;
  validatorRef: string;
  validatorType: "schema" | "test" | "policy" | "checker-agent" | "human" | "pipeline" | "custom";
  verdict: "passed" | "failed" | "warning" | "skipped";
  blocking: boolean;
  checkedContractRefs: string[];
  checkedEvidenceRefs: string[];
  messages: Array<{ severity: "info" | "warning" | "error"; path?: string; text: string }>;
  metrics?: Record<string, number>;
  rerunCommand?: string[];
  repairHint?: string;
  createdAt: string;
};
```

Validator rules：

- Schema validator checks contract shape and required fields.
- Evidence validator checks required evidence presence, freshness, and attempt alignment.
- Policy validator checks tool/MCP/workspace/model/secret boundaries.
- Test validator records command argv, exit status, output summary, and log ref.
- Checker-agent validator must reference its own verification artifact; it cannot pass based only on freeform text.
- Pipeline validator passes only when all required blocking validators pass.

### 10.4 Flow-level I/O Correctness Validator

Before `approve_for_run`, template validation must prove the whole graph is connected by typed contracts and evidence.

Checks：

1. **Input coverage**：every root node input is provided by template input contract, memory policy, workspace binding, human input, or external capability artifact.
2. **Output producer**：every edge `artifactContractRefs` has an upstream producer node.
3. **Evidence producer**：every required evidence kind has either a task producer, workspace policy source, validator source, or human gate source.
4. **Validator coverage**：every output contract has at least one blocking validator; terminal outputs have stop-condition validators.
5. **Capability fit**：selected agent capabilities and tool policy satisfy node requirements.
6. **Workspace fit**：workspace-required edge has compatible workspace policy and binding plan.
7. **Fan-in compatibility**：fan-in node accepts all upstream artifact types and has merge strategy.
8. **No transcript dependency**：no node may require raw transcript as its only input.

### 10.5 Downstream Context Construction

Downstream `ContextPacket` should include explicit artifact/evidence summaries, not raw workspace scan results.

```text
ContextPacket(task N)
  includes accepted upstream artifact summaries
  includes evidence packet summaries and refs
  includes workspace diff/snapshot summaries when edge requires workspace state
  excludes rejected artifacts unless task is a repair/recovery task
```

Repair task context may include rejected artifact summary, validator failure messages, and repair hints, but must label them as failure context.

### 10.6 Evidence UI Priority

Runtime UI should prioritize an evidence ledger over transcript display：

- artifact status timeline
- required vs present evidence matrix
- validator results with blocking status
- reproducible commands and log refs
- workspace diff/snapshot refs
- human approval evidence
- downstream readiness blockers

This makes product trust depend on inspectable proof rather than agent narrative.

## 11. Runtime Compile

Compiler 輸入：

```text
workflow_template_version + workflow_recipe_version? + run inputs + approved library versions
```

Compiler 輸出：

- `SouthstarWorkflowManifest`
- `workflow_runs` row
- `workflow_tasks` rows
- task materialization plan / `TaskEnvelopeV2`
- workspace binding plan
- executor projection

Runtime manifest 加上：

```ts
compiledFrom: {
  templateDefinitionId: string;
  templateVersionId: string;
  recipeVersionId?: string;
  compilerVersion: string;
  inputHash: string;
};
```

Compiler 必須 snapshot exact version payload，不能引用 mutable library head。

## 12. Template Reuse / Auto-run

未來新需求流程：

```text
New Goal
  -> Template Matcher
  -> Required Input Check
  -> Risk Check
  -> Auto-run or Confirm
  -> Compile Runtime Workflow
```

`TemplateMatchResult`：

```ts
type TemplateMatchResult = {
  templateVersionRef: string;
  confidence: number;
  missingInputs: string[];
  risk: "low" | "medium" | "high";
  reason: string;
};
```

Auto-run 只允許：

- template status 是 `validated`
- confidence 達 policy threshold
- required inputs 全部齊
- risk 是 low
- 沒有新 MCP grant、credential、external write request

否則進 user confirmation、partial clarification 或 DAG edit。

## 13. API Surface

### Library Query

```text
GET /api/v2/library/definitions
GET /api/v2/library/definitions/:id
GET /api/v2/library/definitions/:id/versions
GET /api/v2/library/search
```

### Design Draft

```text
POST /api/v2/design/drafts
GET  /api/v2/design/drafts/:draftId
POST /api/v2/design/drafts/:draftId/clarify
POST /api/v2/design/drafts/:draftId/patch
POST /api/v2/design/drafts/:draftId/validate
POST /api/v2/design/drafts/:draftId/approve-for-run
```

### Template Lifecycle

```text
POST /api/v2/library/templates/:templateId/promote
POST /api/v2/library/templates/:templateId/validate-from-run
POST /api/v2/library/templates/:templateId/deprecate
```

### Compile + Run

```text
POST /api/v2/templates/:templateVersionId/compile
POST /api/v2/templates/:templateVersionId/run
POST /api/v2/run-goal
```

### Artifact / Evidence / Validator Read Models

```text
GET /api/v2/runs/:runId/artifact-flow
GET /api/v2/runs/:runId/artifacts/:artifactId
GET /api/v2/runs/:runId/artifacts/:artifactId/evidence
GET /api/v2/runs/:runId/validators/results
GET /api/v2/runs/:runId/downstream-readiness
```

用途：

- DAG editor / runtime monitor 顯示 artifact graph。
- Evidence ledger 顯示 required vs present evidence。
- Validator diagnostics 顯示 blocking failures 與 repair hints。
- Downstream readiness 顯示哪些 task 可開始、哪些缺 artifact/evidence/workspace state。

## 14. UI Surfaces

第一版目標是完整 visual editor，至少包含：

1. **Requirement Studio**：clarification Q&A、requirement spec、assumptions、non-goals、acceptance criteria、reuse/create decision。
2. **Design Library**：agent specs、capabilities、contracts、validators、policy bundles、workflow templates、version history、approve/deprecate/promote。
3. **DAG Visual Editor**：drag/drop nodes/edges、node detail form、agent/model band、contracts、validators、capabilities、MCP capabilities、workspace policy、LLM patch diff、validation diagnostics、approve_for_run。
4. **Template Run Launcher / Runtime Monitor**：template inputs、compile preview、risk result、run launch、artifact flow、evidence ledger、validator result、downstream readiness、workspace binding/diff、template validation outcome。

## 15. Error Handling

| Failure | Result |
|---|---|
| LLM 找不到合適 agent | 建立 agent/capability proposal，draft 保持 incomplete |
| LLM proposal 引用未批准 MCP | validation error，要求 governance approval 或移除 capability |
| DAG 有 cycle | draft invalid，UI 高亮 offending edges |
| 下游 input 沒 producer | template invalid，要求補 task 或改 contract |
| required run input 缺失 | compile blocked，回到 input form / clarification |
| workspace 無法 materialize | compile blocked 或 task exception |
| task artifact 不合格 | runtime repair / retry / fork / rollback |
| required evidence missing/stale | artifact stays `needs_repair`; downstream task remains blocked |
| blocking validator failed | artifact rejected or repair requested; validator result records repair hint |
| downstream readiness blocked | UI shows missing artifact/evidence/workspace requirement |
| template run 失敗 | template 保持 `approved_for_run`，附 failure evidence，不升 validated |
| web source 不可信 | proposal 可保存，但 risk high，不能 auto-approve |

## 16. Security / Governance Rules

1. LLM 不可直接建立 approved library version。
2. LLM 不可直接建立 MCP grant。
3. LLM 不可直接讀 secret value。
4. LLM 不可把 raw transcript / large log 放進 library definition。
5. Runtime manifest 必須 snapshot exact library version。
6. Auto-run 只允許 validated template + low risk + complete inputs。
7. External web discovery 只能作 proposal evidence，不可直接導入 executable MCP/server/credential。
8. Workspace 是 state/evidence carrier，不是 workflow truth。
9. Proposed definitions 在 approved 前不能被 executable template 引用。
10. Template validation 必須由 successful run evidence 驅動，不能由 LLM 自行標記。
11. Artifact 不能在缺少 required evidence 或 blocking validator failure 時進入 `accepted`。
12. Downstream task 不能以 raw transcript、executor success、或 workspace scan 替代 typed upstream artifacts。

## 17. Testing Strategy

### Unit Tests

- library schema validator accepts/rejects each `definition_kind`
- DAG cycle detection
- artifact contract compatibility graph
- capability compatibility check
- MCP grant boundary check
- model selection policy check
- template lifecycle transition validation
- patch application / rollback
- workspace policy validation
- artifact lifecycle transition validation
- evidence packet completeness/freshness validation
- validator result contract validation
- downstream readiness rejects non-accepted artifacts

### Integration Tests

- user goal → clarification result → design draft
- library search → selected agent specs
- LLM proposed missing capability → proposal stored but not executable
- DAG editor patch → template validation
- approved_for_run template → compile runtime manifest
- runtime accepted artifacts → downstream context packet
- missing evidence blocks downstream readiness
- failed blocking validator produces repair hint and prevents artifact acceptance
- successful run → template version validated
- similar future goal → validated template match → skip clarification

### E2E Vertical Slice

第一個 E2E 必須是新的 real vertical slice，不能重用既有 calc-sum scenario，也不能使用 fake / smoke / mock executor、planner、harness 或 Tork substitute。所有 E2E agent/planner execution 必須走 Pi host adapter：`PI_PLANNER_ENDPOINT` / `PI_HARNESS_ENDPOINT` backed by Pi，或 fallback to `@earendil-works/pi-coding-agent` SDK；不可使用 Codex/OpenCode/builtin/fake harness。

新增 fixture：`tests/e2e-real/fixtures/todo-web-feature-issue`。

Scenario：Design Library template creates and validates a reusable **software development agent workflow** for a real todo-web feature issue。

```text
feature issue: todo-web app should support priority labels, due dates, and an "Overdue" filter
-> first request ingests a real issue packet with title/body/acceptance criteria and creates requirement clarification trace with at least 3 resolved required inputs
-> internal validated Design Library search runs before any external discovery
-> LLM/design service composes a software-dev DAG from approved explorer/planner/implementer/checker/summarizer agents, capability specs, contracts, validators, and policy bundles
-> UI/API patch loop applies at least 2 typed WorkflowTemplatePatch operations: add browser-ux-verification node and add artifact_flow edge from implementer to checker
-> human approval creates one approved_for_run immutable workflow_template version
-> compiler materializes runtime manifest from immutable version ids, issue packet, repo path, and run inputs
-> run executes through real Docker/Tork and Pi host adapter planner + Pi host adapter agent harness, not fake/smoke/mock and not Codex/OpenCode/builtin harness
-> agents modify the real todo-web fixture to implement the feature issue
-> accepted artifacts have file-diff, test-result, command-output, and browser/screenshot-or-dom evidence packets plus blocking validator results
-> downstream checker/summarizer tasks receive accepted artifact/evidence summaries, not raw transcript
-> successful stop condition promotes template version to validated
-> a similar future todo-web issue matches the validated software-dev template with confidence >= 0.85 and asks 0 clarification questions when required inputs are complete and risk is low
```

Required new E2E files：

- `tests/e2e-real/fixtures/todo-web-feature-issue/package.json`
- `tests/e2e-real/fixtures/todo-web-feature-issue/README.md`
- `tests/e2e-real/fixtures/todo-web-feature-issue/index.html`
- `tests/e2e-real/fixtures/todo-web-feature-issue/src/todo-store.ts`
- `tests/e2e-real/fixtures/todo-web-feature-issue/src/app.ts`
- `tests/e2e-real/fixtures/todo-web-feature-issue/src/styles.css`
- `tests/e2e-real/fixtures/todo-web-feature-issue/test/todo-store.test.ts`
- `tests/e2e-real/fixtures/todo-web-feature-issue/test/browser-behavior.test.ts`
- `tests/e2e-real/design-library-template-real.test.ts`
- `tests/e2e-real/scenarios/design-library-template-real.ts`

Quantitative E2E gates：

| Gate | Minimum / Exact threshold |
|---|---:|
| Real executor | 100% tasks submitted through Docker/Tork |
| Pi host adapter | 100% planner + agent invocations use Pi host adapter (`piPlannerMode` and `piHarnessMode` are `http` or `sdk`, with no Codex/OpenCode/builtin/fake harness rows) |
| New fixture reuse | 0 references to existing `calc sum` goal prompt/helpers in this E2E |
| Todo-web feature issue | issue title/body/acceptance criteria stored in requirement spec and compiled run input |
| Approved library definitions seeded | >= 14 immutable approved versions across all 7 definition kinds |
| Software-dev agent roles | >= 5 distinct approved agent specs: explorer, planner, implementer, checker, summarizer |
| Draft patch audit | >= 2 typed patch events in `library_history` |
| Compile immutability | 100% compiled refs point to version ids, not mutable heads |
| Runtime task count | >= 5 completed tasks |
| Accepted artifacts | exactly equals completed task count |
| Complete evidence packets | exactly equals accepted artifact count |
| Blocking validator failures | exactly 0 |
| Oversized artifact/evidence/validator payloads | exactly 0 rows with payload_json > 50,000 bytes |
| Stop condition | latest stop condition status exactly `passed` |
| Fixture verification | Docker `npm test` passes inside modified todo-web repo |
| Browser behavior verification | Playwright/browser test proves priority labels render, overdue filter hides non-overdue todos, and localStorage persistence survives reload |
| Git diff evidence | changed files include `src/todo-store.ts`, `src/app.ts`, `src/styles.css`, `README.md`, and at least one test file |
| Promotion order | `template.validated_from_run` event occurs after run terminal pass timestamp |
| Reuse confidence | >= 0.85 for similar future todo-web issue |
| Reuse clarification count | exactly 0 when all required inputs are present |
| Wall-clock budget | <= 15 minutes for the scenario |

## 18. Implementation Phases

### Phase 1：Design Library Core

- SQLite tables
- definition versioning
- library history
- validators for 7 definition kinds
- software seed migrated from code into SQLite bootstrap

### Phase 2：Workflow Design Draft + Patch Model

- `library_objects.state_json` + `library_history` draft events
- `WorkflowDesignDraft`
- `WorkflowTemplatePatch`
- patch validation
- DAG graph validator
- requirement spec storage

### Phase 3：LLM Designer Integration

- brainstorming-style clarification service
- library search trace
- internal-first search
- web-assisted proposal evidence
- agent/capability composition proposal
- no direct approval writes

### Phase 4：DAG Visual Editor

- full node/edge editor
- node detail form
- LLM patch diff
- validation diagnostics
- approve_for_run action

### Phase 5：Compiler + Runtime Integration

- template version + inputs → `SouthstarWorkflowManifest`
- immutable snapshot refs
- artifact lifecycle resources and accepted-artifact gate
- evidence packet creation and evidence ledger read model
- validator result resources with blocking verdicts and repair hints
- context packet with upstream artifact/evidence flow
- workspace binding model
- Tork execution unchanged as executor-only

### Phase 6：Template Reuse / Auto-run

- similarity matching
- required input checker
- risk checker
- validated-template auto-run
- low-confidence fallback to clarification / DAG edit

### Phase 7：Template Validation From Successful Runs

- runtime stop condition + terminal accepted artifacts + required evidence → template validated
- failure evidence attached to template
- success metrics / recommendation rank

## 19. Quantitative Acceptance Criteria

Functional acceptance：

- Design Library core persists exactly 2 canonical tables in SQLite: `library_objects`, `library_history`; `library_similarity_index` is optional and enabled only when similarity projection is required.
- The first production seed creates at least 14 immutable approved definition versions and covers all 7 `definition_kind` values: `agent_spec`, `capability_spec`, `contract_spec`, `validator_spec`, `policy_bundle`, `workflow_template`, `workflow_recipe`.
- 100% of approved reusable definitions are created by `user`, `system`, or `migration`; 0 approved reusable definitions are created directly by actor `llm`.
- 100% of `version.created` events carry a sha256 content hash of canonical payload JSON; the hash is immutable and auditable across later head updates.
- Every draft mutation appends one `library_history` event with monotonic `sequence`; rollback/diff can be reconstructed from history without reading runtime workflow tables.
- LLM/design service can create proposal drafts for missing agents/capabilities, but executable `approved_for_run` templates reference 0 proposal-only definitions.
- External web discovery can appear only in proposal evidence; it creates 0 MCP grants, 0 credentials, and 0 approved executable definitions.
- DAG editor/API and LLM patch loop both use `WorkflowTemplatePatch`; at least 95% branch coverage is required for patch validation errors in unit tests.
- Template validation rejects cycles, missing input producers, missing blocking validators, missing evidence producers, unresolved capability refs, workspace-policy mismatch, and raw-transcript-only dependencies.
- Compiler materializes runtime manifests only from immutable template/library version ids; 100% compiled manifests include `compiledFrom.templateVersionId`, `compilerVersion`, and 64-character `inputHash`.
- Runtime downstream readiness uses only accepted artifact/evidence summaries and workspace binding summaries; 0 downstream tasks may be unblocked by raw transcript, executor exit status alone, or blind workspace scan.
- Artifact lifecycle prevents downstream use until schema, evidence, policy, and blocking validators pass; accepted artifacts must equal completed task count in the real E2E.
- Evidence packets record required vs present evidence, freshness, source refs, reproducible commands, redaction status, and completeness metrics for 100% accepted artifacts.
- Validator results are typed resources with blocking verdicts, checked contracts/evidence, messages, and repair hints for 100% accepted artifacts.
- Template promotion to `validated` requires a terminal passed/completed run, accepted terminal artifact, complete required evidence, and latest stop-condition status `passed`; promotion before runtime success is rejected 100% of the time.
- Future similar demand can match validated template with confidence >= 0.85 and skip initial clarification when required inputs are complete and risk is low.

Real E2E acceptance：

- A new real E2E scenario is added at `tests/e2e-real/design-library-template-real.test.ts`; it must not import or call existing calc-sum scenario helpers.
- The scenario uses a new fixture under `tests/e2e-real/fixtures/todo-web-feature-issue`; 0 references to the existing `software-change` fixture are allowed in the new E2E file.
- The scenario ingests a real todo-web feature issue packet with title, body, labels, repo path, and at least 5 acceptance criteria.
- The scenario executes through real Docker/Tork and Pi host adapter for both planner and agent harness; tests must fail if a fake, mock, smoke-only, builtin, Codex, OpenCode, or in-memory executor/harness path is used.
- The scenario completes within 15 minutes on the configured real E2E environment.
- The scenario completes at least 5 workflow tasks and records 100% task submission through Tork executor bindings.
- Accepted artifact count exactly equals completed task count.
- Complete evidence packet count exactly equals accepted artifact count.
- Blocking validator failures equal 0.
- Artifact/evidence/validator payloads larger than 50,000 bytes equal 0 rows.
- Docker `npm test` passes inside the modified todo-web fixture repo.
- Browser behavior verification proves priority labels render, overdue filter hides non-overdue todos, and localStorage persistence survives reload.
- Git diff evidence includes `src/todo-store.ts`, `src/app.ts`, `src/styles.css`, `README.md`, and at least one test file.
- Similar future todo-web issue reuse produces `confidence >= 0.85`, `missingInputs.length === 0`, `risk === "low"`, and `clarificationQuestionCount === 0`.

## 20. Implementation Plan Goal Prompt

Use this prompt when dispatching an implementation agent for the corresponding plan：

```text
Implement the Southstar v2 Design Library / Workflow Template vertical slice from docs/superpowers/specs/2026-06-15-southstar-llm-design-library-workflow-template-design.md.

Use TDD and implement the plan in docs/superpowers/plans/2026-06-15-southstar-llm-design-library-workflow-template-implementation-plan.md task by task.

Hard requirements:
- Add SQLite-first Design Library tables, immutable versions, drafts, and append-only history.
- Add typed payload validators for the 7 definition kinds.
- Add workflow template draft, patch, graph validation, human approval, compile, run, validation-from-run, and reuse matching services.
- Runtime manifests must compile only from immutable template/library version ids and include compiledFrom metadata.
- LLM/design service may create drafts/proposals/patches only; it must not directly approve reusable definitions, MCP grants, secrets, credentials, or executable external write permissions.
- Create a new real E2E case for a todo-web feature issue; do not reuse existing calc-sum scenarios, do not use fake/smoke/mock executor/planner/harness, and require real Docker/Tork execution through Pi host adapter planner + Pi host adapter agent harness.
- The software-dev agent workflow must include approved explorer, planner, implementer, checker, and summarizer agent specs and compile them into real Tork tasks.
- Every E2E planner and agent task must use Pi host adapter (`createPiSdkPlannerClient` / `createPiSdkAgentHarness` or HTTP endpoints backed by Pi); Codex/OpenCode/builtin/fake harnesses are forbidden.
- Quantitative gates: >=14 approved library versions across all 7 definition kinds, >=5 completed real tasks, 100% Pi host adapter planner/agent invocations, accepted artifacts == completed tasks, complete evidence packets == accepted artifacts, blocking validator failures == 0, payloads >50KB == 0, stop condition passed, browser behavior verified, reuse confidence >=0.85 with 0 clarification questions, scenario <=15 minutes.

Verification commands:
- npm run test:v2
- npm run test:e2e:design-library-real
```

## 21. Self-review Notes

- Placeholder scan: no incomplete placeholder markers remain.
- Consistency check: design-time library is reusable truth; runtime manifest remains immutable execution snapshot.
- Scope check: this is a full platform design intentionally phased into seven implementation phases.
- Ambiguity check: LLM authority is limited to draft/proposal/patch; approval, MCP grants, compilation, runtime completion, and template validation are deterministic or human-governed.

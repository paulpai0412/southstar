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

設計原則與 runtime workflow 一致：少量 canonical tables、typed JSON payload、immutable versions、append-only history。

### 5.1 Tables

```text
library_definitions
library_definition_versions
library_drafts
library_history
library_similarity_index   // 可 phase 2/6 實作
```

#### `library_definitions`

穩定 identity 與 head 狀態。

```text
id text primary key
definition_key text unique not null
definition_kind text not null
current_version_id text
status text not null
domain_refs_json text not null
tag_json text not null
created_at text not null
updated_at text not null
```

#### `library_definition_versions`

immutable typed definition snapshot。

```text
id text primary key
definition_id text not null
version text not null
definition_kind text not null
payload_json text not null
content_hash text not null
created_by text not null
created_at text not null
supersedes_version_id text
unique(definition_id, version)
```

#### `library_drafts`

LLM / UI 編輯中的 draft 或 proposal。

```text
id text primary key
draft_type text not null
base_definition_id text
base_version_id text
status text not null
payload_json text not null
validation_json text not null
created_by text not null
created_at text not null
updated_at text not null
```

#### `library_history`

append-only audit。

```text
id text primary key
definition_id text
version_id text
draft_id text
sequence integer not null
event_type text not null
actor_type text not null
payload_json text not null
created_at text not null
```

### 5.2 Definition Kinds

第一版只需要 7 種 `definition_kind`，全部存在同一張 version table：

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

## 10. Runtime Compile

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

## 11. Template Reuse / Auto-run

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

## 12. API Surface

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

## 13. UI Surfaces

第一版目標是完整 visual editor，至少包含：

1. **Requirement Studio**：clarification Q&A、requirement spec、assumptions、non-goals、acceptance criteria、reuse/create decision。
2. **Design Library**：agent specs、capabilities、contracts、validators、policy bundles、workflow templates、version history、approve/deprecate/promote。
3. **DAG Visual Editor**：drag/drop nodes/edges、node detail form、agent/model band、contracts、validators、capabilities、MCP capabilities、workspace policy、LLM patch diff、validation diagnostics、approve_for_run。
4. **Template Run Launcher / Runtime Monitor**：template inputs、compile preview、risk result、run launch、artifact flow、workspace binding/diff、validator result、template validation outcome。

## 14. Error Handling

| Failure | Result |
|---|---|
| LLM 找不到合適 agent | 建立 agent/capability proposal，draft 保持 incomplete |
| LLM proposal 引用未批准 MCP | validation error，要求 governance approval 或移除 capability |
| DAG 有 cycle | draft invalid，UI 高亮 offending edges |
| 下游 input 沒 producer | template invalid，要求補 task 或改 contract |
| required run input 缺失 | compile blocked，回到 input form / clarification |
| workspace 無法 materialize | compile blocked 或 task exception |
| task artifact 不合格 | runtime repair / retry / fork / rollback |
| template run 失敗 | template 保持 `approved_for_run`，附 failure evidence，不升 validated |
| web source 不可信 | proposal 可保存，但 risk high，不能 auto-approve |

## 15. Security / Governance Rules

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

## 16. Testing Strategy

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

### Integration Tests

- user goal → clarification result → design draft
- library search → selected agent specs
- LLM proposed missing capability → proposal stored but not executable
- DAG editor patch → template validation
- approved_for_run template → compile runtime manifest
- runtime accepted artifacts → downstream context packet
- successful run → template version validated
- similar future goal → validated template match → skip clarification

### E2E Vertical Slice

Software seed vertical slice：

```text
goal: implement feature in repo
-> clarify first time
-> create maker/checker/summarizer DAG
-> approve_for_run
-> compile/run through fake Tork or builtin harness
-> accepted artifacts
-> mark template validated
-> similar future goal matches template and skips clarification
```

## 17. Implementation Phases

### Phase 1：Design Library Core

- SQLite tables
- definition versioning
- library history
- validators for 7 definition kinds
- software seed migrated from code into SQLite bootstrap

### Phase 2：Workflow Design Draft + Patch Model

- `library_drafts`
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
- context packet with upstream artifact flow
- workspace binding model
- Tork execution unchanged as executor-only

### Phase 6：Template Reuse / Auto-run

- similarity matching
- required input checker
- risk checker
- validated-template auto-run
- low-confidence fallback to clarification / DAG edit

### Phase 7：Template Validation From Successful Runs

- runtime stop condition → template validated
- failure evidence attached to template
- success metrics / recommendation rank

## 18. Acceptance Criteria

- Design Library uses few canonical tables and typed payloads, not one table per concept.
- LLM can compose flow and agents from approved library definitions and can create proposals for missing capabilities.
- Web discovery is recorded as proposal evidence and cannot directly create executable grants or approved definitions.
- DAG editor and LLM use the same `WorkflowTemplatePatch` model.
- Template validator proves DAG input/process/output compatibility before approval.
- Compiler materializes runtime manifest from immutable template/library versions and run inputs.
- Runtime passes context through accepted artifacts, context packets, and workspace bindings, not by blind workspace scanning.
- `approved_for_run` template can execute current demand; only successful run evidence promotes template to `validated`.
- Future similar demand can match validated template and skip initial clarification when inputs are complete and risk is low.

## 19. Self-review Notes

- Placeholder scan: no incomplete placeholder markers remain.
- Consistency check: design-time library is reusable truth; runtime manifest remains immutable execution snapshot.
- Scope check: this is a full platform design intentionally phased into seven implementation phases.
- Ambiguity check: LLM authority is limited to draft/proposal/patch; approval, MCP grants, compilation, runtime completion, and template validation are deterministic or human-governed.

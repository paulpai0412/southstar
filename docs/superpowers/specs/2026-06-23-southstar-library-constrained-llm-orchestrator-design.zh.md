# Southstar Library-Constrained LLM Orchestrator Design

日期：2026-06-23
狀態：design draft

## 1. 背景

Southstar 先前曾有由 LLM 組 workflow DAG 的 planner 路徑；目前 Postgres canonical path 已轉為 deterministic constrained generator。現行 `createPostgresPlannerDraft()` 呼叫 `generateConstrainedWorkflowPlan()` 後 materialize runtime manifest，測試中也明確確認 `plannerClient` 不被 Postgres constrained planner 使用。這保住了 runtime 穩定性，但也讓 workflow DAG、task shape、agent profile selection 回到 hardcoded generator。

目前 repo 內已經有 design library 與 learning graph 的基礎：

- `southstar.library_objects`
- `southstar.library_history`
- `southstar.library_similarity_index`
- `southstar.learning_nodes`
- `southstar.learning_edges`
- `LibraryDefinitionKind` 已包含 `agent_definition`、`agent_profile`、`skill_definition`、`mcp_tool_grant`、`artifact_contract`、`evaluator_profile`、`capability_spec`、`policy_bundle`、`workflow_template`、`workflow_recipe`、`skill_spec`

缺口是 library object 之間缺少可審計的 typed contract graph。LLM 如果直接看完整 library 後自由輸出 runtime manifest，會重新引入安全與可驗證問題；如果完全不用 LLM，系統又會退回 broad/narrow regex 與固定 task/profile。

本設計採用 **Constrained Creative Orchestration**：

```text
LLM 負責 creative orchestration:
  - 需求理解
  - task decomposition
  - workflow pattern selection
  - role / responsibility assignment
  - candidate tradeoff reasoning
  - validator repair patch

Southstar 負責 deterministic authority:
  - approved library refs
  - candidate retrieval boundary
  - permission / tool / MCP / vault validation
  - compiler materialization
  - runtime manifest truth
```

一句話：**LLM is workflow architect; compiler is runtime authority.**

## 2. 目標

1. 讓 workflow DAG 可依 agent library 動態編排，不再由 code hardcode task shape、profile id、skill/tool selection。
2. 讓 LLM 善用語意理解與編排能力，但只能在 approved library candidate refs 內組 `WorkflowCompositionPlan`。
3. 把 agent definition、agent profile、skill、tool、MCP、vault、instruction、artifact contract、evaluator、policy 都納入 library contract model。
4. 用 Postgres-native typed edge table 補足 library graph，不在第一階段導入 vector search、recursive CTE、Apache AGE、Neo4j 或其他 graph DB。
5. 產出 runtime 前必須經 deterministic validator/compiler，LLM output 不可直接成為 `SouthstarWorkflowManifest`。
6. 每次 orchestration 必須留下候選來源、選用理由、拒絕理由、validator proof 與 immutable library refs，形成可審計 `orchestration_snapshot`。
7. generated components 只能成為 proposal side channel，不可直接取得 approved status 或 runtime permissions。

## 3. 非目標

- 不處理 UI / DAG visual editor。
- 不導入 vector embedding retrieval。
- 不使用 recursive CTE 作為 P0 candidate resolution 或 validator 依賴。
- 不引入專業 graph DB 或 graph extension。
- 不讓 LLM 直接建立 approved reusable definition。
- 不讓 LLM 直接建立 credential、secret、MCP grant、external write permission。
- 不把 learning card 直接視為 runtime permission source。
- 不改變 Southstar runtime truth：正式執行仍以 compiled `SouthstarWorkflowManifest`、`workflow_runs`、`workflow_tasks`、`workflow_history` 為準。

## 4. 設計原則

### 4.1 Library graph 是 contract graph，不是泛用 knowledge graph

Library graph 表達「可否搭配、需要什麼、提供什麼、產出什麼、誰可驗證誰」。它服務 orchestration safety 與 candidate narrowing。

Learning graph 表達 runtime evidence、knowledge card、wiki backlink、learning delta lineage。它可以影響 ranking、confidence、risk notes，但不能直接授權 tool、MCP、vault 或 workspace write。

### 4.2 LLM output 是 proposal，不是 authority

LLM 可輸出：

- `RequirementSpec`
- `WorkflowCompositionPlan`
- `WorkflowCompositionPatch`
- `GeneratedComponentProposal`
- candidate rationale / rejected alternative rationale

LLM 不可輸出後即生效：

- final runtime manifest
- approved library object
- tool grant
- MCP grant
- vault lease
- execution image
- external write permission

### 4.3 候選先 deterministic，編排再 LLM

系統先用 typed library objects + typed direct edges 產生 bounded candidate packet。LLM 只能從 candidate packet 內選 refs。這保留 LLM 的語意編排能力，也避免它在 library 外 invent capability。

### 4.4 P0 查詢模型保持簡單

第一階段不用 vector，也不用 recursive CTE。Candidate resolver 僅做：

- object kind / status / domain / tag filter
- direct typed edge lookup
- bounded one-hop join
- explicit compatibility check
- deterministic score baseline

若未來真的需要跨多層 dependency traversal，再升級 query model；不要在第一版把資料層做重。

## 5. 核心資料模型

### 5.1 Library Object Kinds

P0/P1 需要明確支援以下 kinds：

```ts
type LibraryDefinitionKind =
  | "workflow_template"
  | "agent_definition"
  | "agent_profile"
  | "skill_definition"
  | "tool_definition"
  | "mcp_tool_grant"
  | "artifact_contract"
  | "evaluator_profile"
  | "policy_bundle"
  | "instruction_template"
  | "capability_spec";
```

現有 `LibraryDefinitionKind` 尚未獨立列出 `tool_definition` 與 `instruction_template`。P0 可以先用 `skill_definition` / `skill_spec` 與 `policy_bundle` 裝載部分欄位，但 target design 應把 tool 與 instruction 拉成 first-class library object，避免塞進 agent profile 後難以審計。

### 5.2 AgentDefinition

AgentDefinition 是角色能力契約，不綁定具體 model/host。

```ts
type AgentDefinitionPayload = {
  schemaVersion: "southstar.library.agent_definition.v1";
  displayName: string;
  purpose: string;
  responsibilityBoundary: string[];
  prohibitedResponsibilities: string[];
  domainRefs: string[];
  capabilityRefs: string[];
  inputArtifactContractRefs: string[];
  outputArtifactContractRefs: string[];
  evaluatorProfileRefs: string[];
  defaultInstructionRefs: string[];
  policyBundleRefs: string[];
  supportedWorkflowNodeTypes: Array<
    "agent_task" | "validator_task" | "decision" | "fan_in" | "artifact_transform"
  >;
};
```

範例：

- `software-explorer`
- `software-maker`
- `software-checker`
- `software-summarizer`
- `research-fanout-worker`
- `migration-planner`
- `ops-recovery-analyst`

### 5.3 AgentProfile

AgentProfile 是可執行 profile，綁定 host adapter、model/effort、skill/tool grants、workspace policy、vault lease policy。

```ts
type AgentProfilePayload = {
  schemaVersion: "southstar.library.agent_profile.v1";
  agentDefinitionRef: string;
  hostAdapter: "codex" | "pi-agent" | "claude-code" | "custom";
  modelPolicyRef?: string;
  effortPolicyRef?: string;
  instructionOverrideRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  workspacePolicyRef: string;
  contextPolicyRef: string;
  sessionPolicyRef: string;
  costPolicyRef?: string;
  concurrencyPolicyRef?: string;
  status: "draft" | "approved" | "deprecated" | "blocked";
};
```

AgentDefinition 回答「這個 agent 應負責什麼」；AgentProfile 回答「這次可用哪個 host/model/tools 來執行」。

### 5.4 Tool / MCP / Vault

ToolDefinition 定義工具能力與風險；MCP P0 可視為 `ToolDefinition.provider = "mcp"`，不必先拆出過重模型。

```ts
type ToolDefinitionPayload = {
  schemaVersion: "southstar.library.tool_definition.v1";
  provider: "builtin" | "mcp" | "host" | "external";
  toolName: string;
  capabilityRefs: string[];
  inputSchemaRef?: string;
  outputSchemaRef?: string;
  riskTags: string[];
  sideEffect: "none" | "read" | "write" | "external-write";
  requiresApproval: boolean;
  requiresSecretGroupRefs: string[];
};
```

Vault 不以 secret value 進 library。Library 僅保存 secret group ref 與 lease policy：

```ts
type VaultLeasePolicyPayload = {
  schemaVersion: "southstar.library.vault_lease_policy.v1";
  secretGroupRef: string;
  leaseTtlSeconds: number;
  mountMode: "proxy-only" | "ephemeral-file" | "env";
  allowedToolRefs: string[];
  auditRequired: true;
};
```

### 5.5 InstructionTemplate

InstructionTemplate 應 first-class，避免 agent profile 內藏不可追蹤 prompt。

```ts
type InstructionTemplatePayload = {
  schemaVersion: "southstar.library.instruction_template.v1";
  format: "markdown";
  target: "agent" | "task" | "skill" | "validator";
  content: string;
  variables: string[];
  policyRefs: string[];
  provenance: DefinitionProvenance;
};
```

AgentDefinition 可有 default instructions；AgentProfile 可 override；task composition 可追加 task-specific instruction refs。Compiler 負責把 refs materialize 成 task envelope prompt。

### 5.6 WorkflowTemplate

WorkflowTemplate 表達 reusable pattern，不 hardcode final tasks。

```ts
type WorkflowTemplatePayload = {
  schemaVersion: "southstar.library.workflow_template.v1";
  displayName: string;
  purpose: string;
  patternKind:
    | "linear"
    | "maker-checker"
    | "explore-make-check"
    | "fanout-fanin"
    | "repair-loop"
    | "human-gated";
  nodeSlots: Array<{
    slotId: string;
    nodeType: "agent_task" | "validator_task" | "human_gate" | "decision" | "fan_in";
    requiredCapabilityRefs: string[];
    requiredInputArtifactRefs: string[];
    requiredOutputArtifactRefs: string[];
    allowedAgentDefinitionRefs?: string[];
    minCount?: number;
    maxCount?: number;
  }>;
  edgeRules: Array<{
    fromSlot: string;
    toSlot: string;
    edgeType: "depends_on" | "artifact_flow" | "approval_gate" | "decision_path" | "fan_in";
  }>;
  policyBundleRefs: string[];
};
```

LLM 可決定 slot expansion，例如 checker 要一個或兩個、是否需要 fan-in task，但不能違反 template slot rules。

## 6. Library Typed Edge Model

新增 `southstar.library_edges` 作為 library contract graph。這是 P0 的核心表。

```sql
create table southstar.library_edges (
  id text primary key default gen_random_uuid()::text,
  from_object_key text not null,
  from_version_ref text,
  edge_type text not null,
  to_object_key text not null,
  to_version_ref text,
  scope text not null default 'global',
  status text not null default 'active',
  weight double precision not null default 1,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

必要 indexes：

```sql
create index idx_library_edges_from
  on southstar.library_edges(from_object_key, edge_type, status);

create index idx_library_edges_to
  on southstar.library_edges(to_object_key, edge_type, status);

create index idx_library_edges_scope
  on southstar.library_edges(scope, edge_type, status);
```

P0 不需要 recursive traversal，只做 direct / bounded one-hop lookup。

Edge types：

```text
implements              agent_profile -> agent_definition
provides_capability     agent_definition | skill_definition | tool_definition -> capability_spec
requires_capability     workflow_template slot | task draft -> capability_spec
supports_skill          agent_definition | agent_profile -> skill_definition
requires_skill          workflow_template slot | task draft -> skill_definition
allows_tool             agent_profile | policy_bundle -> tool_definition
requires_tool           skill_definition | task draft -> tool_definition
uses_instruction        agent_definition | agent_profile | skill_definition -> instruction_template
requires_secret_group   tool_definition | mcp_tool_grant -> vault secret group ref
allows_mcp_grant        agent_profile | policy_bundle -> mcp_tool_grant
produces_artifact       agent_definition | skill_definition | workflow slot -> artifact_contract
consumes_artifact       agent_definition | skill_definition | workflow slot -> artifact_contract
validates_artifact      evaluator_profile -> artifact_contract
uses_policy             any library object -> policy_bundle
part_of_template        workflow_template -> node slot / workflow_recipe
supersedes              new object/version -> old object/version
blocked_by              object -> policy/risk/evidence
```

## 7. Orchestrator Flow

### 7.1 End-to-end

```text
User Goal
  -> Requirement Analyzer
  -> Candidate Resolver
  -> Candidate Packet
  -> LLM Workflow Composer
  -> Composition Validator
  -> Optional LLM Repair Patch Loop
  -> Manifest Compiler
  -> Planner Draft Runtime Resource
  -> Southstar Runtime Run
```

### 7.2 Requirement Analyzer

Requirement Analyzer 可由 LLM 執行，但 output 要 schema validated。

```ts
type RequirementSpec = {
  summary: string;
  workType:
    | "software_feature"
    | "bugfix"
    | "research"
    | "data_analysis"
    | "migration"
    | "ops_recovery"
    | "general";
  requiredCapabilities: string[];
  expectedArtifacts: string[];
  acceptanceCriteria: string[];
  nonGoals: string[];
  riskNotes: string[];
  workspaceAssumptions: string[];
  missingInputs: string[];
};
```

若 `missingInputs` 包含 blocking input，API 回傳 clarification request；不建立 run。

### 7.3 Candidate Resolver

Candidate Resolver 是 deterministic service，不呼叫 LLM。

輸入：

- `RequirementSpec`
- domain / repo / source provider metadata
- approved-only policy

輸出 `CandidatePacket`：

```ts
type CandidatePacket = {
  requirementSpec: RequirementSpec;
  workflowTemplateCandidates: WorkflowTemplateCandidate[];
  agentCandidatesByCapability: Record<string, AgentCandidate[]>;
  profileCandidatesByAgent: Record<string, AgentProfileCandidate[]>;
  skillCandidatesByCapability: Record<string, SkillCandidate[]>;
  toolGrantCandidatesByCapability: Record<string, ToolGrantCandidate[]>;
  mcpGrantCandidatesByCapability: Record<string, McpGrantCandidate[]>;
  instructionCandidatesByAgent: Record<string, InstructionCandidate[]>;
  artifactContractCandidates: ArtifactContractCandidate[];
  evaluatorCandidatesByArtifact: Record<string, EvaluatorCandidate[]>;
  policyConstraints: PolicyCandidate[];
  unavailableRequirements: Array<{
    capabilityRef: string;
    reason: "no_approved_candidate" | "blocked_by_policy" | "requires_approval";
  }>;
};
```

Resolver 的 P0 查詢策略：

1. 用 object kind/status/domain/tags 找 approved workflow template。
2. 用 direct edges 找 template slot required capabilities。
3. 用 direct edges 找 provides capability 的 approved agent definitions。
4. 用 `implements` 找 approved agent profiles。
5. 用 direct edges 找 profile allowed skill/tool/MCP/vault/instruction refs。
6. 用 direct edges 找 artifact contract 與 evaluator。
7. 產出 unavailable requirements；不讓 LLM 自行補權限。

### 7.4 LLM Workflow Composer

LLM prompt 僅提供：

- user goal
- `RequirementSpec`
- `CandidatePacket`
- output JSON schema
- composition rules
- validation error examples

LLM 必須輸出 `WorkflowCompositionPlan`：

```ts
type WorkflowCompositionPlan = {
  schemaVersion: "southstar.workflow_composition_plan.v1";
  title: string;
  selectedWorkflowTemplateRef: string;
  rationale: string;
  tasks: Array<{
    id: string;
    name: string;
    responsibility: string;
    dependsOn: string[];
    templateSlotRef: string;
    agentDefinitionRef: string;
    agentProfileRef: string;
    instructionRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
    inputArtifactRefs: string[];
    outputArtifactRefs: string[];
    evaluatorProfileRef: string;
    contextPolicyRef?: string;
    workspacePolicyRef?: string;
    recoveryStrategyRefs: string[];
    rationale: string;
  }>;
  rejectedCandidates: Array<{
    ref: string;
    reason: string;
  }>;
  generatedComponentProposals: GeneratedComponentProposal[];
};
```

LLM 可善用的編排能力：

- 根據語意決定 task count。
- 根據風險決定是否需要 parallel verification。
- 根據 artifact contract 決定 dependency。
- 根據 profile/tool restrictions 決定誰能讀、誰能寫、誰只驗證。
- 根據 validation error 產生 minimal patch。
- 根據 rejected candidates 說明 tradeoff。

LLM 不可做的事：

- 引用 candidate packet 外的 refs。
- 新增 tool/MCP/vault 權限。
- 直接輸出 execution image/command/env。
- 直接把 generated proposal 放進 selected refs。
- 修改 approved library state。

### 7.5 Composition Validator

Validator 是 deterministic。至少檢查：

```text
schema valid
all refs exist
all refs approved
selected template allows task slots
task ids unique
dependency targets exist
no dependency cycle
task agent definition provides required capabilities
profile implements selected agent definition
profile allows selected skills
profile allows selected tool grants
profile allows selected MCP grants
tool grants satisfy side-effect policy
vault lease policy only references allowed secret groups
read-only task has no write/external-write grant
write task has explicit write capability
output artifacts are produced by selected agent/skill/task
evaluator validates output artifacts
instruction refs are allowed for agent/profile/task
policy bundle constraints satisfied
generated component proposals are not selected
```

Dependency cycle 可先用 in-memory DAG check，不依賴 recursive CTE。

若 validation 失敗：

1. 對 LLM 回傳 compact validation issues。
2. LLM 輸出 `WorkflowCompositionPatch`。
3. Validator 重跑。
4. 超過 `maxRepairAttempts` 後 planner draft 進 `invalid`，回傳 operator-visible error。

### 7.6 Manifest Compiler

Compiler 只接受 validated `WorkflowCompositionPlan` 與 immutable library refs。它輸出：

- `SouthstarWorkflowManifest`
- `WorkflowGenerationPlan` compatibility projection
- `orchestration_snapshot`
- planner draft runtime resource

Compiler 責任：

- materialize instruction refs into task envelope prompt sections。
- materialize skill/tool/MCP/vault refs into task envelope/runtime resources。
- materialize agent profile into harness/task execution spec。
- materialize artifact/evaluator/stop conditions。
- freeze library version refs and content hashes。
- write `plannerTrace.model`、candidate trace、validator proof。

## 8. API Surface

### 8.1 Create planner draft

```http
POST /api/v2/planner/drafts
```

Request：

```ts
type CreatePlannerDraftRequest = {
  goalPrompt: string;
  domain?: string;
  sourceProvider?: string;
  sourceRef?: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  approvalPolicyRef?: string;
};
```

Response：

```ts
type CreatePlannerDraftResponse = {
  draftId: string;
  workflowId?: string;
  status: "requires_clarification" | "invalid" | "validated";
  requirementSpec: RequirementSpec;
  selectedTemplateRef?: string;
  taskSummaries?: Array<{
    id: string;
    name: string;
    agentProfileRef: string;
    responsibility: string;
  }>;
  validationIssues: ValidationIssue[];
  requiredClarifications: ClarificationRequest[];
  generatedComponentProposals: GeneratedComponentProposal[];
};
```

P0 可保留 existing deterministic generator 為 fallback：

- `orchestrationMode = "deterministic"` 使用現有 constrained generator。
- `orchestrationMode = "llm-constrained"` 使用本設計。
- 後續測試通過後，再把 default 切到 `llm-constrained`。

### 8.2 Inspect orchestration snapshot

```http
GET /api/v2/planner/drafts/:draftId/orchestration
```

回傳：

- requirement spec
- candidate packet summary
- selected refs
- rejected refs
- validation proof
- generated proposals
- compiler input/output hash

### 8.3 Approve generated component proposal

```http
POST /api/v2/library/proposals/:proposalId/approve
```

本設計只定義 proposal lifecycle，不在 P0 實作完整 UI。API 必須保證 proposal approve 後會建立新的 approved immutable library object/version；原 planner draft 不會自動 retroactively 取得該權限，必須重新 validate/compile。

## 9. Orchestration Snapshot

每次 LLM composition 都要保存：

```ts
type OrchestrationSnapshot = {
  schemaVersion: "southstar.orchestration_snapshot.v1";
  draftId: string;
  runId?: string;
  requirementSpec: RequirementSpec;
  candidatePacketHash: string;
  candidateSummary: {
    workflowTemplateRefs: string[];
    agentDefinitionRefs: string[];
    agentProfileRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    artifactContractRefs: string[];
    evaluatorProfileRefs: string[];
    policyRefs: string[];
  };
  llmTrace: {
    provider: string;
    model: string;
    promptHash: string;
    outputHash: string;
    repairAttemptCount: number;
  };
  selectedCompositionPlan: WorkflowCompositionPlan;
  validation: {
    ok: boolean;
    issues: ValidationIssue[];
    proofRefs: Array<{
      assertion: string;
      edgeRefs: string[];
      objectRefs: string[];
    }>;
  };
  compiler: {
    version: string;
    manifestHash?: string;
    libraryVersionRefs: string[];
  };
};
```

## 10. Error And Recovery

### 10.1 Missing capability

若 Candidate Resolver 找不到 approved candidate：

- planner draft 狀態為 `requires_approval` 或 `invalid`。
- LLM 可提出 `GeneratedComponentProposal`。
- proposal 需 human/system validation 後進 library。
- 原 draft 不自動升級；需重新 orchestration。

### 10.2 LLM invalid output

- JSON parse/schema failure：retry with format repair prompt。
- ref outside candidate packet：validator reject；LLM patch。
- repeated invalid after max attempts：draft invalid，保存 failure trace。

### 10.3 Policy conflict

例如 checker 選到 write tool：

- validator 產生 issue code `readonly_agent_has_write_grant`。
- LLM patch 可換 profile/tool grant，或拆出 maker/checker task。
- 不允許 validator 自動放寬 policy。

### 10.4 Runtime failure

Runtime failure 不直接修改 library。它產生 learning evidence：

- task result
- evaluator failure
- recovery decision
- learning node/edge
- optional library proposal

只有 proposal approval 後，library contract graph 才變更。

## 11. Phased Implementation Plan

### Phase 1：Library Contract Graph Foundation

目標：把 hardcoded refs 的替代資料基礎建起來。

Acceptance criteria：

- 新增 `library_edges` schema 與 indexes。
- seed 現有 software workflow templates、agent definitions、agent profiles、skills、artifact contracts、evaluators、policies。
- 每個 profile 都透過 edge `implements` 指向 agent definition。
- 每個 skill/tool/artifact/evaluator 關係都可用 direct edge 查到。
- 不使用 vector search。
- 不使用 recursive CTE。

### Phase 2：Candidate Resolver

目標：用 deterministic query 產生 candidate packet。

Acceptance criteria：

- `resolveWorkflowCandidates(requirementSpec)` 可回傳 approved candidate refs。
- resolver 對 missing capability 產生 unavailable requirement。
- resolver 有單元測試覆蓋 agent/profile/skill/tool/artifact/evaluator direct edge 查詢。
- resolver 不呼叫 LLM。

### Phase 3：LLM Workflow Composer Contract

目標：恢復 LLM DAG composition，但只在候選 refs 內運作。

Acceptance criteria：

- 定義 `WorkflowCompositionPlan` schema。
- composer prompt 僅含 candidate packet summary，不含 secret/raw full library dump。
- LLM output 引用 candidate packet 外 refs 時必定被拒。
- 支援 LLM repair patch loop。

### Phase 4：Validator And Compiler

目標：讓 validated composition materialize 成 Southstar runtime manifest。

Acceptance criteria：

- validator 覆蓋 ref existence、approved status、profile implements agent、skill/tool/MCP/vault/policy/artifact/evaluator compatibility。
- compiler 輸出現有 `SouthstarWorkflowManifest` compatible shape。
- `workflow_runs.workflow_manifest_json` 保存 compiled snapshot。
- `runtime_resources` 保存 planner draft 與 orchestration snapshot。

### Phase 5：API Integration

目標：把 `/api/v2/planner/drafts` 接上 llm-constrained mode。

Acceptance criteria：

- existing deterministic mode 保留。
- llm-constrained mode 產生 planner draft。
- invalid/clarification/proposal 狀態可由 API 看見。
- tests 不再以「planner not used」作為 llm-constrained path 的預期。

### Phase 6：Learning Feedback

目標：讓 runtime evidence 影響 ranking，但不直接授權。

Acceptance criteria：

- task/evaluator/runtime evidence 可更新 ranking metadata。
- learning card 可成為 candidate rationale evidence。
- learning card 不可直接建立 tool/MCP/vault grant。
- performance history 影響候選排序，不改變 validator contract。

## 12. Testing Strategy

### 12.1 Unit tests

- `library_edges` insert/query projection。
- candidate resolver direct edge lookup。
- no vector / no recursive CTE path。
- composition schema validation。
- validator compatibility matrix。
- compiler deterministic hash。

### 12.2 Integration tests

- create planner draft with llm-constrained fake planner。
- planner draft invalid when LLM selects out-of-candidate ref。
- planner draft valid when LLM selects approved refs。
- generated component proposal does not become selected runtime permission。
- deterministic fallback still works.

### 12.3 Regression tests for current hardcode removal

- no task id/profile id hardcoded in planner generator for llm-constrained path。
- software maker/checker/explorer come from seeded library refs。
- broad/narrow prompt shape no longer determines DAG by regex in llm-constrained path。

### 12.4 Runtime E2E

- validated composition creates workflow run。
- task envelope includes materialized instructions, skills, tools, MCP grants, vault lease policy refs。
- runtime events prove first progress, task completion, evaluator result。
- orchestration snapshot can explain why each agent/profile/tool was selected。

## 13. Migration Notes

Current constrained generator should not be deleted first. It should become a compatibility fallback while the library-constrained path is proven.

Migration sequence：

1. Add library graph and seed current equivalent behavior.
2. Build candidate resolver that can reproduce current maker/checker/summarizer candidates.
3. Add fake LLM composer tests.
4. Add real planner adapter behind `orchestrationMode = "llm-constrained"`.
5. Shift default only after API/runtime/E2E evidence passes.
6. Remove hardcoded broad/narrow generator from default path after compatibility coverage exists.

## 14. Open Decisions

### 14.1 ToolDefinition kind naming

Current `LibraryDefinitionKind` does not include `tool_definition` or `instruction_template`. Target design should add them. If short-term compatibility matters, P0 may encode tool definitions as `policy_bundle` or `skill_definition`, but this should be a temporary migration choice, not the target contract.

### 14.2 Version refs

`library_objects.head_version_id` exists, but the immutable version ref semantics need tightening. Validator/compiler must freeze version refs, not only object keys. If `library_history` remains the version source, the compiler needs a stable event/version addressing helper.

### 14.3 Proposal approval policy

Generated components need a separate approval path. P0 can store proposals as runtime resources or library draft objects; either is acceptable if formal runs cannot select them until approved.

## 15. Summary

Southstar should restore LLM DAG composition, but not by making the LLM the runtime planner of record. The durable architecture is:

```text
approved library objects
  + typed direct contract edges
  -> deterministic candidate packet
  -> LLM workflow composition plan
  -> deterministic validator/compiler
  -> Southstar runtime manifest
```

This removes hardcoded workflow/profile selection while preserving runtime safety. It also keeps the first implementation slice small: Postgres-native tables and direct joins only, no vector search, no recursive CTE, no graph DB, no UI.

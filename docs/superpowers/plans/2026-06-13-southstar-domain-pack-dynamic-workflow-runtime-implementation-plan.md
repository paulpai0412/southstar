# Southstar Domain Pack Dynamic Workflow Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the software-domain vertical slice where a user prompt is routed to a domain/intent, converted into a constrained dynamic workflow, executed through Docker/Tork, evaluated through stop conditions, recovered through retry/fork/rollback/replan, and accepted only when the produced feature artifact is valid.

**Architecture:** Southstar remains the control plane and canonical state owner. Domain packs define allowed roles, agent profiles, skills, MCP grants, artifacts, memory/session/workspace policies, evaluator pipelines, and stop conditions; a constrained generator produces a validated `WorkflowGenerationPlan`, then materializes it into a `SouthstarWorkflowManifest`, `OrchestrationSnapshot`, `ContextPacket`s, and `TaskEnvelopeV2`s. Tork/Docker only execute materialized task envelopes; Southstar owns workflow truth, memory injection trace, session graph, workspace snapshot lineage, evaluator results, and stop-condition completion.

**Tech Stack:** TypeScript, Node 22 `node:test`, SQLite via `node:sqlite`, Docker, local Tork, existing `southstar/pi-agent:local` image, existing real fixture repo under `tests/e2e-real/fixtures/software-change`.

---

## E2E Goal Prompt And Acceptance Contract

Every implementation task must preserve this real E2E target. The E2E is intentionally not a fake, smoke, mock, or static-manifest test.

**Goal prompt:**

```text
在真實 fixture repo 中完成一個可驗收的軟體 feature：
新增 CLI 指令 `calc sum <numbers...>`，支援多個數字輸入、負數、小數、無效輸入錯誤訊息。
同步更新單元測試與 README 用法。
Southstar 必須自動判斷 domain/intent，依 software domain pack 動態產生 workflow DAG，不可固定四個 task。
每個 task 必須解析 role、agent profile、model、skills、MCP grants、memory scope，並在 agent 執行前保存可追蹤 ContextPacket。
任務必須透過 Docker/Tork 執行，Tork 只能是 executor，不能保存 workflow truth。
產出 artifact 後必須由 evaluator pipeline 與 stop condition 驗收。
若驗收失敗，RootSession 必須至少記錄 retry 或 fork/rollback/workflow revision 的 recovery decision。
最後只有 stop condition 通過，run 才能標記 passed/completed。
Fixture repo: <absolute fixture repo path>
```

**Quantitative E2E acceptance standards:**

- `npm run test:e2e:real` must pass with `SOUTHSTAR_DB`, `TORK_BASE_URL`, Docker, and local Tork configured.
- The scenario must run against a copied real fixture repo with Git initialized and at least one real commit.
- The feature must be observable by running `npm run cli -- sum 1 2 3`, and output must include `6`.
- Fixture tests must pass inside Docker using `southstar/pi-agent:local`.
- Domain routing must persist `domain = "software"` and `intent = "implement_feature"` in workflow manifest or generation plan resources.
- Generated workflow must have at least 5 tasks for this broad feature prompt and must not equal the legacy fixed task id set `planner, implementer, root-validator, summary`.
- Every executable task must resolve `roleRef`, `agentProfileRef`, `model`, `skillRefs`, `mcpGrantRefs`, and `memoryScopes`.
- Every executed task must have exactly one stored `context_packet` before executor submission.
- Every memory injection must produce a `memory_injection_trace` with included and excluded candidates plus token estimates.
- Tork projection must not contain domain pack definitions, memory items, session graph rows, evaluator policy internals, or workflow-generation policy internals.
- At least one `evaluator_pipeline_result` and one `stop_condition_result` must exist for the run.
- The run must not become `passed` or `completed` unless the stop condition passed.
- Session lineage must include `session_node`, `session_checkpoint`, and at least one recovery lineage event from retry/fork/rollback/replan during the failure-injection variant.
- Software workspace snapshot must include a Git commit ref at task start and accepted checkpoint; rollback variant must restore the workspace to a prior ref.
- Aggregate metrics must include positive token count, duration, task count, context packet count, memory injection count, evaluator count, and recovery decision count.

## File Structure

- Create `src/v2/domain-packs/types.ts`: domain pack, intent, role, agent profile, artifact contract, policy, and stop-condition contracts.
- Create `src/v2/domain-packs/software.ts`: built-in software domain pack fixture used by tests and runtime.
- Create `src/v2/domain-packs/registry.ts`: registry and lookup APIs for domain packs.
- Create `src/v2/workflow-generator/types.ts`: generation plan, generated task plan, orchestration plan, orchestration snapshot, validation issue types.
- Create `src/v2/workflow-generator/validator.ts`: validates generated plans against domain-pack policy.
- Create `src/v2/workflow-generator/constrained-generator.ts`: LLM-independent constrained generator for the software vertical slice, with optional future planner integration seam.
- Create `src/v2/workflow-generator/materialize.ts`: converts validated generation plans to `SouthstarWorkflowManifest`.
- Create `src/v2/context/types.ts`: `ContextPacket`, `ContextBlock`, token estimate, exclusion reason contracts.
- Create `src/v2/context/builder.ts`: builds context packets using goal, role, artifacts, memory, skills, MCP, workspace, and checkpoint summaries.
- Create `src/v2/memory/provider.ts`: memory provider interface and ranking input/output contracts.
- Create `src/v2/memory/sqlite-provider.ts`: SQLite provider backed by `runtime_resources`.
- Create `src/v2/session-graph/types.ts`: session node/checkpoint/recovery contracts.
- Create `src/v2/session-graph/sqlite-provider.ts`: minimal durable session graph provider.
- Create `src/v2/workspace/types.ts`: workspace snapshot provider contracts.
- Create `src/v2/workspace/git-provider.ts`: Git/worktree snapshot, fork, rollback, and diff provider.
- Create `src/v2/evaluators/pipeline.ts`: evaluator pipeline orchestration.
- Create `src/v2/evaluators/stop-condition.ts`: stop-condition evaluator.
- Modify `src/v2/manifests/types.ts`: add v2 domain pack-backed manifest fields while keeping compatibility adapters for existing tests.
- Modify `src/v2/manifests/validate.ts`: validate domain pack refs, generation refs, task role/profile/evaluator refs, and legacy manifest compatibility.
- Modify `src/v2/agent-runner/task-envelope.ts`: introduce `TaskEnvelopeV2` and build from resolved role/profile/context/session/workspace state.
- Modify `src/v2/agent-runner/materializer.ts`: materialize V2 envelopes and context packet refs without leaking secrets.
- Modify `src/v2/agent-runner/task-runner.ts`: run V2 envelope, persist evaluator/recovery/session events in callback payload.
- Modify `src/v2/agent-runner/root-session.ts`: delegate to evaluator pipeline and recovery strategy selection.
- Modify `src/v2/ui-api/local-api.ts`: replace fixed planner path with domain routing + constrained generation + manifest materialization + context/session/workspace preparation.
- Modify `src/v2/executor/tork-projection.ts`: keep Tork executor projection minimal and assert no Southstar control-plane truth leaks.
- Modify `src/v2/executor/tork-callback.ts`: ingest V2 evaluator, stop condition, session graph, workspace, and recovery records.
- Modify `src/v2/ui-api/read-models.ts`: expose generation plan, orchestration snapshot, context packets, session graph, and memory injection trace.
- Modify `src/v2/server/routes.ts`: add generation-plan, orchestration, context, session graph, fork, rollback, and memory injection endpoints.
- Modify `src/v2/cli.ts`: add inspection commands used by E2E diagnostics.
- Create unit tests under `tests/v2/` for each provider/builder/validator/evaluator.
- Create `tests/e2e-real/scenarios/domain-pack-dynamic-workflow-feature.ts`: real Tork/Docker feature implementation E2E.
- Modify `tests/e2e-real/index.test.ts`: run the new real E2E scenario after environment probes.

---

### Task 1: Domain Pack Contracts And Built-In Software Pack

**Files:**
- Create: `src/v2/domain-packs/types.ts`
- Create: `src/v2/domain-packs/software.ts`
- Create: `src/v2/domain-packs/registry.ts`
- Modify: `src/v2/manifests/types.ts`
- Test: `tests/v2/domain-pack.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write the failing domain pack test**

Add this file:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { createDomainPackRegistry } from "../../src/v2/domain-packs/registry.ts";

test("software domain pack defines the runtime contract for feature work", () => {
  assert.equal(softwareDomainPack.id, "software");
  assert.equal(softwareDomainPack.version, "1.0.0");
  assert.ok(softwareDomainPack.intents.some((intent) => intent.id === "implement_feature"));
  assert.ok(softwareDomainPack.roles.some((role) => role.id === "maker"));
  assert.ok(softwareDomainPack.agentProfiles.some((profile) => profile.id === "software-maker-pi"));
  assert.ok(softwareDomainPack.artifactContracts.some((contract) => contract.id === "implementation_report"));
  assert.ok(softwareDomainPack.evaluatorPipelines.some((pipeline) => pipeline.id === "software-feature-quality"));
  assert.ok(softwareDomainPack.stopConditions.some((condition) => condition.id === "software-feature-complete"));
});

test("domain pack registry resolves software by prompt intent hint", () => {
  const registry = createDomainPackRegistry([softwareDomainPack]);
  const routed = registry.route({
    goalPrompt: "新增 CLI 指令 calc sum <numbers...> 並補測試 README",
    domainHint: undefined,
  });

  assert.equal(routed.domainPack.id, "software");
  assert.equal(routed.intent.id, "implement_feature");
});
```

- [ ] **Step 2: Include the test in the v2 suite**

Add this import near the top of `tests/v2/index.test.ts`:

```ts
await import("./domain-pack.test.ts");
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
npm run test:v2 -- tests/v2/domain-pack.test.ts
```

Expected: FAIL with module-not-found errors for `src/v2/domain-packs/software.ts`.

- [ ] **Step 4: Add domain pack types**

Create `src/v2/domain-packs/types.ts`:

```ts
export type DomainPack = {
  id: string;
  version: string;
  displayName: string;
  intents: IntentDefinition[];
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  workflowTemplates: WorkflowTemplate[];
  workflowGeneratorPolicies: WorkflowGeneratorPolicyDefinition[];
  artifactContracts: ArtifactContract[];
  evaluatorPipelines: EvaluatorPipelineDefinition[];
  contextPolicies: ContextPolicyDefinition[];
  sessionPolicies: SessionPolicyDefinition[];
  memoryPolicies: MemoryPolicyDefinition[];
  workspacePolicies: WorkspacePolicyDefinition[];
  stopConditions: StopConditionDefinition[];
};

export type IntentDefinition = {
  id: string;
  description: string;
  examples: string[];
  workflowTemplateRef: string;
  requiredInputs: string[];
  defaultContextPolicyRef: string;
  defaultSessionPolicyRef: string;
};

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

export type WorkflowGeneratorPolicyDefinition = {
  id: string;
  intentRefs: string[];
  templateRefs: string[];
  allowedRoleRefs: string[];
  allowedAgentProfileRefs: string[];
  allowedEvaluatorPipelineRefs: string[];
  allowedArtifactContractRefs: string[];
  maxTasks: number;
  maxParallelTasks: number;
  maxAgentInvocations: number;
  maxEstimatedInputTokens: number;
  maxEstimatedCostMicrosUsd?: number;
  qualityPatterns: QualityPattern[];
};

export type QualityPattern =
  | "maker-checker"
  | "multi-angle-research"
  | "competing-hypotheses"
  | "fanout-fanin"
  | "rollback-on-test-failure"
  | "fork-on-checker-reject";

export type RoleDefinition = {
  id: string;
  responsibility: string;
  defaultAgentProfileRef: string;
  allowedAgentProfileRefs: string[];
  artifactInputs: string[];
  artifactOutputs: string[];
  stopAuthority: "none" | "can-suggest" | "can-accept" | "can-reject";
};

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

export type ArtifactContract = {
  id: string;
  artifactType: string;
  requiredFields: string[];
  evidenceFields: string[];
};

export type EvaluatorPipelineDefinition = {
  id: string;
  evaluators: EvaluatorStepDefinition[];
  onFailure: {
    defaultStrategy: "retry-same-agent" | "fork-from-checkpoint" | "rollback-workspace" | "request-workflow-revision" | "ask-human";
  };
};

export type EvaluatorStepDefinition = {
  id: string;
  kind: "schema" | "domain" | "test" | "evidence" | "checker-agent" | "policy";
  config: Record<string, unknown>;
  required: boolean;
};

export type ContextPolicyDefinition = {
  id: string;
  maxInputTokens: number;
  memoryPolicyRef: string;
  includeAgentsMd: boolean;
  includeWorkspaceSummary: boolean;
};

export type SessionPolicyDefinition = {
  id: string;
  checkpointOn: Array<"task-start" | "artifact-accepted" | "before-recovery">;
  allowFork: boolean;
  allowReset: boolean;
  allowRollback: boolean;
};

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

export type MemoryKind =
  | "preference"
  | "architecture_decision"
  | "domain_pattern"
  | "failure_lesson"
  | "artifact_summary"
  | "workflow_learning";

export type WorkspacePolicyDefinition = {
  id: string;
  provider: "git";
  snapshotAtTaskStart: boolean;
  snapshotAtAcceptedArtifact: boolean;
  forkOnCheckerReject: boolean;
  rollbackOnTestFailure: boolean;
};

export type StopConditionDefinition = {
  id: string;
  type: "artifact-accepted" | "tests-passed" | "checker-passed" | "human-approved" | "custom";
  evaluatorRefs: string[];
};
```

- [ ] **Step 5: Add the software domain pack**

Create `src/v2/domain-packs/software.ts`:

```ts
import type { DomainPack } from "./types.ts";

export const softwareDomainPack: DomainPack = {
  id: "software",
  version: "1.0.0",
  displayName: "Software Engineering",
  intents: [{
    id: "implement_feature",
    description: "Implement a requested software feature with tests and documentation.",
    examples: ["新增 CLI 指令 calc sum", "implement a parser option and tests"],
    workflowTemplateRef: "software-feature-template",
    requiredInputs: ["goalPrompt", "repoPath"],
    defaultContextPolicyRef: "software-context-default",
    defaultSessionPolicyRef: "software-session-default",
  }, {
    id: "fix_bug",
    description: "Investigate and fix a failing behavior.",
    examples: ["修正 test failure", "fix calc add bug"],
    workflowTemplateRef: "software-feature-template",
    requiredInputs: ["goalPrompt", "repoPath"],
    defaultContextPolicyRef: "software-context-default",
    defaultSessionPolicyRef: "software-session-default",
  }],
  roles: [{
    id: "explorer",
    responsibility: "Inspect the repository and create an implementation plan.",
    defaultAgentProfileRef: "software-explorer-codex",
    allowedAgentProfileRefs: ["software-explorer-codex", "software-explorer-pi"],
    artifactInputs: [],
    artifactOutputs: ["implementation_plan"],
    stopAuthority: "none",
  }, {
    id: "maker",
    responsibility: "Edit the workspace and produce implementation evidence.",
    defaultAgentProfileRef: "software-maker-pi",
    allowedAgentProfileRefs: ["software-maker-pi"],
    artifactInputs: ["implementation_plan"],
    artifactOutputs: ["implementation_report"],
    stopAuthority: "none",
  }, {
    id: "checker",
    responsibility: "Verify tests, diff, evidence, and policy compliance.",
    defaultAgentProfileRef: "software-checker-codex",
    allowedAgentProfileRefs: ["software-checker-codex", "software-checker-pi"],
    artifactInputs: ["implementation_report"],
    artifactOutputs: ["verification_report"],
    stopAuthority: "can-reject",
  }, {
    id: "summarizer",
    responsibility: "Produce the final completion report after acceptance.",
    defaultAgentProfileRef: "software-summarizer-codex",
    allowedAgentProfileRefs: ["software-summarizer-codex"],
    artifactInputs: ["implementation_report", "verification_report"],
    artifactOutputs: ["completion_report"],
    stopAuthority: "can-accept",
  }],
  agentProfiles: [{
    id: "software-explorer-codex",
    name: "Software Explorer",
    provider: "codex",
    model: "gpt-5-codex",
    harnessRef: "codex",
    agentsMdRefs: ["repo:AGENTS.md"],
    promptTemplateRef: "software-explorer",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read", "search"], deniedTools: ["write"], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 12_000, maxOutputTokens: 2_000, maxWallTimeSeconds: 300 },
  }, {
    id: "software-explorer-pi",
    name: "Software Explorer Pi",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    agentsMdRefs: ["repo:AGENTS.md"],
    promptTemplateRef: "software-explorer",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read", "search"], deniedTools: ["write"], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 12_000, maxOutputTokens: 2_000, maxWallTimeSeconds: 300 },
  }, {
    id: "software-maker-pi",
    name: "Software Maker Pi",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    agentsMdRefs: ["repo:AGENTS.md"],
    promptTemplateRef: "software-maker",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: ["filesystem-workspace"],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read", "search", "edit", "shell"], deniedTools: ["network-write"], requiresApprovalFor: ["external-write"] },
    budgetPolicy: { maxInputTokens: 20_000, maxOutputTokens: 4_000, maxWallTimeSeconds: 900 },
  }, {
    id: "software-checker-codex",
    name: "Software Checker",
    provider: "codex",
    model: "gpt-5-codex",
    harnessRef: "codex",
    agentsMdRefs: ["repo:AGENTS.md"],
    promptTemplateRef: "software-checker",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read", "search", "shell"], deniedTools: ["edit"], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 16_000, maxOutputTokens: 3_000, maxWallTimeSeconds: 600 },
  }, {
    id: "software-checker-pi",
    name: "Software Checker Pi",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    agentsMdRefs: ["repo:AGENTS.md"],
    promptTemplateRef: "software-checker",
    skillRefs: ["software.calc-cli"],
    mcpGrantRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read", "search", "shell"], deniedTools: ["edit"], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 16_000, maxOutputTokens: 3_000, maxWallTimeSeconds: 600 },
  }, {
    id: "software-summarizer-codex",
    name: "Software Summarizer",
    provider: "codex",
    model: "gpt-5-codex",
    harnessRef: "codex",
    agentsMdRefs: [],
    promptTemplateRef: "software-summarizer",
    skillRefs: [],
    mcpGrantRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-summary",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read"], deniedTools: ["edit", "shell"], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 8_000, maxOutputTokens: 2_000, maxWallTimeSeconds: 180 },
  }],
  workflowTemplates: [{
    id: "software-feature-template",
    intentRefs: ["implement_feature", "fix_bug"],
    stages: [{
      id: "understand",
      roleRef: "explorer",
      dependsOn: [],
      promptTemplateRef: "software-explorer",
      requiredArtifactRefs: ["implementation_plan"],
      evaluatorPipelineRef: "software-plan-quality",
      stopConditionRefs: [],
      workspacePolicyRef: "software-git-workspace",
      allowDynamicExpansion: true,
    }, {
      id: "implement",
      roleRef: "maker",
      dependsOn: ["understand"],
      promptTemplateRef: "software-maker",
      requiredArtifactRefs: ["implementation_report"],
      evaluatorPipelineRef: "software-feature-quality",
      stopConditionRefs: [],
      workspacePolicyRef: "software-git-workspace",
      allowDynamicExpansion: true,
    }, {
      id: "verify",
      roleRef: "checker",
      dependsOn: ["implement"],
      promptTemplateRef: "software-checker",
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      stopConditionRefs: ["software-feature-complete"],
      workspacePolicyRef: "software-git-workspace",
      allowDynamicExpansion: true,
    }, {
      id: "summarize",
      roleRef: "summarizer",
      dependsOn: ["verify"],
      promptTemplateRef: "software-summarizer",
      requiredArtifactRefs: ["completion_report"],
      evaluatorPipelineRef: "software-completion-quality",
      stopConditionRefs: ["software-feature-complete"],
      workspacePolicyRef: "software-git-workspace",
      allowDynamicExpansion: false,
    }],
  }],
  workflowGeneratorPolicies: [{
    id: "software-feature-generator",
    intentRefs: ["implement_feature", "fix_bug"],
    templateRefs: ["software-feature-template"],
    allowedRoleRefs: ["explorer", "maker", "checker", "summarizer"],
    allowedAgentProfileRefs: [
      "software-explorer-codex",
      "software-explorer-pi",
      "software-maker-pi",
      "software-checker-codex",
      "software-checker-pi",
      "software-summarizer-codex",
    ],
    allowedEvaluatorPipelineRefs: [
      "software-plan-quality",
      "software-feature-quality",
      "software-verification-quality",
      "software-completion-quality",
    ],
    allowedArtifactContractRefs: ["implementation_plan", "implementation_report", "verification_report", "completion_report"],
    maxTasks: 8,
    maxParallelTasks: 3,
    maxAgentInvocations: 12,
    maxEstimatedInputTokens: 80_000,
    maxEstimatedCostMicrosUsd: 500_000,
    qualityPatterns: ["maker-checker", "fanout-fanin", "rollback-on-test-failure", "fork-on-checker-reject"],
  }],
  artifactContracts: [{
    id: "implementation_plan",
    artifactType: "implementation-plan",
    requiredFields: ["summary", "filesToInspect", "commandsToRun", "risks"],
    evidenceFields: ["filesToInspect", "commandsToRun"],
  }, {
    id: "implementation_report",
    artifactType: "implementation-report",
    requiredFields: ["summary", "filesChanged", "commandsRun", "testResults", "risks", "artifactEvidence"],
    evidenceFields: ["filesChanged", "commandsRun", "testResults", "artifactEvidence"],
  }, {
    id: "verification_report",
    artifactType: "verification-report",
    requiredFields: ["summary", "commandsRun", "testResults", "checkerFindings", "risks"],
    evidenceFields: ["commandsRun", "testResults", "checkerFindings"],
  }, {
    id: "completion_report",
    artifactType: "completion-report",
    requiredFields: ["summary", "acceptedArtifacts", "tests", "risks", "followUps"],
    evidenceFields: ["acceptedArtifacts", "tests"],
  }],
  evaluatorPipelines: [{
    id: "software-plan-quality",
    evaluators: [{ id: "schema", kind: "schema", config: { artifactRef: "implementation_plan" }, required: true }],
    onFailure: { defaultStrategy: "retry-same-agent" },
  }, {
    id: "software-feature-quality",
    evaluators: [
      { id: "schema", kind: "schema", config: { artifactRef: "implementation_report" }, required: true },
      { id: "evidence", kind: "evidence", config: { artifactRef: "implementation_report" }, required: true },
      { id: "tests", kind: "test", config: { command: "npm test" }, required: true },
      { id: "policy", kind: "policy", config: { denyExternalWrite: true }, required: true },
    ],
    onFailure: { defaultStrategy: "rollback-workspace" },
  }, {
    id: "software-verification-quality",
    evaluators: [
      { id: "schema", kind: "schema", config: { artifactRef: "verification_report" }, required: true },
      { id: "checker", kind: "checker-agent", config: { artifactRef: "verification_report" }, required: true },
    ],
    onFailure: { defaultStrategy: "fork-from-checkpoint" },
  }, {
    id: "software-completion-quality",
    evaluators: [{ id: "schema", kind: "schema", config: { artifactRef: "completion_report" }, required: true }],
    onFailure: { defaultStrategy: "request-workflow-revision" },
  }],
  contextPolicies: [{
    id: "software-context-default",
    maxInputTokens: 20_000,
    memoryPolicyRef: "software-memory-default",
    includeAgentsMd: true,
    includeWorkspaceSummary: true,
  }, {
    id: "software-context-summary",
    maxInputTokens: 8_000,
    memoryPolicyRef: "software-memory-default",
    includeAgentsMd: false,
    includeWorkspaceSummary: false,
  }],
  sessionPolicies: [{
    id: "software-session-default",
    checkpointOn: ["task-start", "artifact-accepted", "before-recovery"],
    allowFork: true,
    allowReset: true,
    allowRollback: true,
  }],
  memoryPolicies: [{
    id: "software-memory-default",
    providerRef: "sqlite",
    scopes: ["software", "project"],
    maxInjectedTokens: 1_500,
    maxCandidates: 8,
    requireWriteApproval: true,
    allowedKinds: ["preference", "architecture_decision", "domain_pattern", "failure_lesson", "artifact_summary", "workflow_learning"],
    ranking: { relevanceWeight: 0.55, recencyWeight: 0.15, successWeight: 0.2, confidenceWeight: 0.1 },
    compression: { strategy: "extractive", maxTokensPerMemory: 240 },
  }],
  workspacePolicies: [{
    id: "software-git-workspace",
    provider: "git",
    snapshotAtTaskStart: true,
    snapshotAtAcceptedArtifact: true,
    forkOnCheckerReject: true,
    rollbackOnTestFailure: true,
  }],
  stopConditions: [{
    id: "software-feature-complete",
    type: "custom",
    evaluatorRefs: ["software-feature-quality", "software-verification-quality", "software-completion-quality"],
  }],
};
```

- [ ] **Step 6: Add the domain pack registry**

Create `src/v2/domain-packs/registry.ts`:

```ts
import type { DomainPack, IntentDefinition } from "./types.ts";

export type DomainRouteInput = {
  goalPrompt: string;
  domainHint?: string;
};

export type DomainRouteResult = {
  domainPack: DomainPack;
  intent: IntentDefinition;
};

export type DomainPackRegistry = {
  list(): DomainPack[];
  get(id: string): DomainPack | undefined;
  route(input: DomainRouteInput): DomainRouteResult;
};

export function createDomainPackRegistry(domainPacks: DomainPack[]): DomainPackRegistry {
  const byId = new Map(domainPacks.map((pack) => [pack.id, pack]));
  return {
    list: () => [...domainPacks],
    get: (id) => byId.get(id),
    route(input) {
      const hinted = input.domainHint ? byId.get(input.domainHint) : undefined;
      const domainPack = hinted ?? routeByPrompt(domainPacks, input.goalPrompt);
      if (!domainPack) throw new Error(`no domain pack matched prompt: ${input.goalPrompt.slice(0, 120)}`);
      const intent = routeIntent(domainPack, input.goalPrompt);
      return { domainPack, intent };
    },
  };
}

function routeByPrompt(domainPacks: DomainPack[], goalPrompt: string): DomainPack | undefined {
  const normalized = goalPrompt.toLowerCase();
  return domainPacks.find((pack) => {
    if (pack.id === "software" && /(cli|test|readme|repo|bug|feature|calc|程式|測試|實作|修正|新增)/i.test(normalized)) return true;
    return pack.intents.some((intent) => intent.examples.some((example) => normalized.includes(example.toLowerCase())));
  });
}

function routeIntent(domainPack: DomainPack, goalPrompt: string): IntentDefinition {
  const normalized = goalPrompt.toLowerCase();
  if (domainPack.id === "software" && /(fix|bug|修正|失敗|failure)/i.test(normalized)) {
    return requiredIntent(domainPack, "fix_bug");
  }
  if (domainPack.id === "software") return requiredIntent(domainPack, "implement_feature");
  return domainPack.intents[0] ?? fail(`domain pack has no intents: ${domainPack.id}`);
}

function requiredIntent(domainPack: DomainPack, id: string): IntentDefinition {
  return domainPack.intents.find((intent) => intent.id === id) ?? fail(`missing intent ${id} in ${domainPack.id}`);
}

function fail(message: string): never {
  throw new Error(message);
}
```

- [ ] **Step 7: Extend manifest type with optional domain-pack-backed fields**

In `src/v2/manifests/types.ts`, import domain pack types and add these fields to `SouthstarWorkflowManifest` without removing existing fields yet:

```ts
import type {
  AgentProfile,
  ArtifactContract,
  ContextPolicyDefinition,
  EvaluatorPipelineDefinition,
  MemoryPolicyDefinition,
  RoleDefinition,
  SessionPolicyDefinition,
  WorkspacePolicyDefinition,
} from "../domain-packs/types.ts";
```

Add these optional properties inside `SouthstarWorkflowManifest`:

```ts
  domain?: string;
  intent?: string;
  domainPackRef?: { id: string; version: string; contentHash: string };
  workflowGeneration?: {
    planId: string;
    generatorPolicyRef: string;
    orchestrationSnapshotId: string;
  };
  roles?: RoleDefinition[];
  agentProfiles?: AgentProfile[];
  artifactContracts?: ArtifactContract[];
  evaluatorPipelines?: EvaluatorPipelineDefinition[];
  contextPolicies?: ContextPolicyDefinition[];
  sessionPolicies?: SessionPolicyDefinition[];
  memoryPolicies?: MemoryPolicyDefinition[];
  workspacePolicies?: WorkspacePolicyDefinition[];
```

Keep current `tasks`, `harnessDefinitions`, `evaluators`, `memoryPolicy`, `mcpServers`, and `mcpGrants` so existing tests pass during migration.

- [ ] **Step 8: Run domain pack tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/v2/domain-packs src/v2/manifests/types.ts tests/v2/domain-pack.test.ts tests/v2/index.test.ts
git commit -m "feat: add software domain pack contract"
```

---

### Task 2: Constrained Dynamic Workflow Generation

**Files:**
- Create: `src/v2/workflow-generator/types.ts`
- Create: `src/v2/workflow-generator/validator.ts`
- Create: `src/v2/workflow-generator/constrained-generator.ts`
- Create: `src/v2/workflow-generator/materialize.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/workflow-generator.test.ts`

- [ ] **Step 1: Write the failing generator test**

Create `tests/v2/workflow-generator.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { generateConstrainedWorkflowPlan } from "../../src/v2/workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../../src/v2/workflow-generator/materialize.ts";
import { validateWorkflowGenerationPlan } from "../../src/v2/workflow-generator/validator.ts";

const goalPrompt = [
  "新增 CLI 指令 calc sum <numbers...>，支援多數字、負數、小數、錯誤訊息。",
  "更新測試與 README。",
  "需要 checker 驗證與 final completion report。",
  "Fixture repo: /tmp/southstar-real-e2e/domain-pack-dynamic-feature",
].join("\n");

test("generates a non-fixed software DAG from prompt and domain pack", () => {
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-dynamic-feature",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });

  assert.equal(plan.intentRef, "implement_feature");
  assert.equal(plan.generatorPolicyRef, "software-feature-generator");
  assert.equal(plan.tasks.length >= 5, true, "broad feature prompt should produce more than four tasks");
  assert.notDeepEqual(plan.tasks.map((task) => task.id), ["planner", "implementer", "root-validator", "summary"]);
  assert.equal(plan.tasks.some((task) => task.roleRef === "maker"), true);
  assert.equal(plan.tasks.filter((task) => task.roleRef === "checker").length >= 1, true);
  assert.equal(plan.orchestration.phases.length >= 4, true);
  assert.equal(validateWorkflowGenerationPlan(softwareDomainPack, plan).ok, true);
});

test("materializes generation plan into a Southstar manifest with domain metadata", () => {
  const plan = generateConstrainedWorkflowPlan({
    runId: "run-dynamic-feature",
    goalPrompt,
    domainPack: softwareDomainPack,
    intentId: "implement_feature",
  });
  const manifest = materializeGenerationPlan({
    plan,
    domainPack: softwareDomainPack,
    goalPrompt,
  });

  assert.equal(manifest.domain, "software");
  assert.equal(manifest.intent, "implement_feature");
  assert.equal(manifest.domainPackRef?.id, "software");
  assert.equal(manifest.workflowGeneration?.planId, plan.id);
  assert.equal(manifest.tasks.length, plan.tasks.length);
  for (const task of manifest.tasks) {
    assert.equal(typeof task.roleRef, "string");
    assert.equal(task.execution.engine, "tork");
    assert.equal(task.execution.command[0], "southstar-agent-runner");
  }
});
```

- [ ] **Step 2: Include the generator test**

Add to `tests/v2/index.test.ts`:

```ts
await import("./workflow-generator.test.ts");
```

- [ ] **Step 3: Run the failing generator test**

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing workflow-generator modules.

- [ ] **Step 4: Add workflow generator types**

Create `src/v2/workflow-generator/types.ts`:

```ts
export type WorkflowGenerationPlan = {
  id: string;
  runId: string;
  domainPackRef: { id: string; version: string; contentHash: string };
  intentRef: string;
  templateRef: string;
  generatorPolicyRef: string;
  rationale: string;
  tasks: GeneratedTaskPlan[];
  orchestration: OrchestrationPlan;
  estimatedBudget: {
    inputTokens: number;
    outputTokens: number;
    costMicrosUsd?: number;
    maxParallelTasks: number;
  };
};

export type GeneratedTaskPlan = {
  id: string;
  roleRef: string;
  agentProfileRef: string;
  dependsOn: string[];
  promptTemplateRef: string;
  promptInputs: Record<string, unknown>;
  requiredArtifactRefs: string[];
  evaluatorPipelineRef: string;
  recoveryStrategyRefs: string[];
};

export type OrchestrationPlan = {
  phases: Array<{
    id: string;
    taskRefs: string[];
    fanIn?: {
      strategy: "all-pass" | "majority" | "best-candidate" | "checker-arbitrated";
      outputArtifactRef: string;
    };
  }>;
  resumePolicy: "same-plan" | "regenerate-from-checkpoint";
};

export type OrchestrationSnapshot = {
  id: string;
  runId: string;
  generationPlanId: string;
  manifestFingerprint: string;
  phaseStates: Array<{
    phaseId: string;
    status: "pending" | "running" | "completed" | "failed" | "superseded";
    taskResultRefs: string[];
    intermediateResultRefs: string[];
  }>;
  metrics: {
    agentInvocations: number;
    inputTokens?: number;
    outputTokens?: number;
    costMicrosUsd?: number;
  };
};

export type WorkflowGenerationValidationResult = {
  ok: boolean;
  issues: Array<{ path: string; message: string }>;
};
```

- [ ] **Step 5: Add generator validation**

Create `src/v2/workflow-generator/validator.ts`:

```ts
import type { DomainPack } from "../domain-packs/types.ts";
import type { WorkflowGenerationPlan, WorkflowGenerationValidationResult } from "./types.ts";

export function validateWorkflowGenerationPlan(
  domainPack: DomainPack,
  plan: WorkflowGenerationPlan,
): WorkflowGenerationValidationResult {
  const issues: Array<{ path: string; message: string }> = [];
  const policy = domainPack.workflowGeneratorPolicies.find((candidate) => candidate.id === plan.generatorPolicyRef);
  if (!policy) {
    issues.push({ path: "generatorPolicyRef", message: "unknown generator policy" });
    return { ok: false, issues };
  }
  if (!policy.intentRefs.includes(plan.intentRef)) {
    issues.push({ path: "intentRef", message: "intent not allowed by generator policy" });
  }
  if (!policy.templateRefs.includes(plan.templateRef)) {
    issues.push({ path: "templateRef", message: "template not allowed by generator policy" });
  }
  if (plan.tasks.length > policy.maxTasks) {
    issues.push({ path: "tasks", message: `task count exceeds maxTasks ${policy.maxTasks}` });
  }
  const taskIds = new Set<string>();
  for (const [index, task] of plan.tasks.entries()) {
    if (taskIds.has(task.id)) issues.push({ path: `tasks.${index}.id`, message: "duplicate task id" });
    taskIds.add(task.id);
    if (!policy.allowedRoleRefs.includes(task.roleRef)) {
      issues.push({ path: `tasks.${index}.roleRef`, message: "role not allowed by generator policy" });
    }
    if (!policy.allowedAgentProfileRefs.includes(task.agentProfileRef)) {
      issues.push({ path: `tasks.${index}.agentProfileRef`, message: "agent profile not allowed by generator policy" });
    }
    if (!policy.allowedEvaluatorPipelineRefs.includes(task.evaluatorPipelineRef)) {
      issues.push({ path: `tasks.${index}.evaluatorPipelineRef`, message: "evaluator pipeline not allowed by generator policy" });
    }
    for (const artifactRef of task.requiredArtifactRefs) {
      if (!policy.allowedArtifactContractRefs.includes(artifactRef)) {
        issues.push({ path: `tasks.${index}.requiredArtifactRefs`, message: `artifact contract not allowed: ${artifactRef}` });
      }
    }
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency) && !plan.tasks.some((candidate) => candidate.id === dependency)) {
        issues.push({ path: `tasks.${index}.dependsOn`, message: `unknown dependency ${dependency}` });
      }
    }
  }
  for (const [index, phase] of plan.orchestration.phases.entries()) {
    if (phase.taskRefs.length > policy.maxParallelTasks) {
      issues.push({ path: `orchestration.phases.${index}.taskRefs`, message: `parallel task count exceeds ${policy.maxParallelTasks}` });
    }
    for (const taskRef of phase.taskRefs) {
      if (!taskIds.has(taskRef)) issues.push({ path: `orchestration.phases.${index}.taskRefs`, message: `unknown task ref ${taskRef}` });
    }
  }
  if (plan.tasks.length > policy.maxAgentInvocations) {
    issues.push({ path: "tasks", message: `agent invocation estimate exceeds ${policy.maxAgentInvocations}` });
  }
  if (plan.estimatedBudget.inputTokens > policy.maxEstimatedInputTokens) {
    issues.push({ path: "estimatedBudget.inputTokens", message: `input token estimate exceeds ${policy.maxEstimatedInputTokens}` });
  }
  if (policy.maxEstimatedCostMicrosUsd !== undefined && (plan.estimatedBudget.costMicrosUsd ?? 0) > policy.maxEstimatedCostMicrosUsd) {
    issues.push({ path: "estimatedBudget.costMicrosUsd", message: `cost estimate exceeds ${policy.maxEstimatedCostMicrosUsd}` });
  }
  return { ok: issues.length === 0, issues };
}
```

- [ ] **Step 6: Add constrained generator**

Create `src/v2/workflow-generator/constrained-generator.ts`:

```ts
import { createHash } from "node:crypto";
import type { DomainPack } from "../domain-packs/types.ts";
import type { WorkflowGenerationPlan, GeneratedTaskPlan } from "./types.ts";
import { validateWorkflowGenerationPlan } from "./validator.ts";

export type GenerateConstrainedWorkflowPlanInput = {
  runId: string;
  goalPrompt: string;
  domainPack: DomainPack;
  intentId: string;
};

export function generateConstrainedWorkflowPlan(input: GenerateConstrainedWorkflowPlanInput): WorkflowGenerationPlan {
  const intent = input.domainPack.intents.find((candidate) => candidate.id === input.intentId);
  if (!intent) throw new Error(`unknown intent ${input.intentId}`);
  const template = input.domainPack.workflowTemplates.find((candidate) => candidate.id === intent.workflowTemplateRef);
  if (!template) throw new Error(`unknown template ${intent.workflowTemplateRef}`);
  const policy = input.domainPack.workflowGeneratorPolicies.find((candidate) => candidate.intentRefs.includes(intent.id));
  if (!policy) throw new Error(`no generator policy for intent ${intent.id}`);

  const broad = isBroadFeaturePrompt(input.goalPrompt);
  const tasks: GeneratedTaskPlan[] = [{
    id: "understand-repo",
    roleRef: "explorer",
    agentProfileRef: "software-explorer-codex",
    dependsOn: [],
    promptTemplateRef: "software-explorer",
    promptInputs: { goalPrompt: input.goalPrompt },
    requiredArtifactRefs: ["implementation_plan"],
    evaluatorPipelineRef: "software-plan-quality",
    recoveryStrategyRefs: ["retry-same-agent"],
  }, {
    id: "implement-feature",
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    dependsOn: ["understand-repo"],
    promptTemplateRef: "software-maker",
    promptInputs: { goalPrompt: input.goalPrompt },
    requiredArtifactRefs: ["implementation_report"],
    evaluatorPipelineRef: "software-feature-quality",
    recoveryStrategyRefs: ["retry-same-agent", "rollback-workspace", "fork-from-checkpoint"],
  }];

  if (broad) {
    tasks.push({
      id: "verify-tests",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["implement-feature"],
      promptTemplateRef: "software-checker",
      promptInputs: { focus: "tests and CLI behavior" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["fork-from-checkpoint", "request-workflow-revision"],
    }, {
      id: "verify-docs",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["implement-feature"],
      promptTemplateRef: "software-checker",
      promptInputs: { focus: "README and usage examples" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["fork-from-checkpoint", "request-workflow-revision"],
    }, {
      id: "fan-in-quality",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["verify-tests", "verify-docs"],
      promptTemplateRef: "software-checker",
      promptInputs: { focus: "merge verification findings and decide acceptance" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["request-workflow-revision"],
    });
  } else {
    tasks.push({
      id: "verify-feature",
      roleRef: "checker",
      agentProfileRef: "software-checker-codex",
      dependsOn: ["implement-feature"],
      promptTemplateRef: "software-checker",
      promptInputs: { focus: "tests and implementation evidence" },
      requiredArtifactRefs: ["verification_report"],
      evaluatorPipelineRef: "software-verification-quality",
      recoveryStrategyRefs: ["fork-from-checkpoint", "request-workflow-revision"],
    });
  }

  tasks.push({
    id: "summarize-completion",
    roleRef: "summarizer",
    agentProfileRef: "software-summarizer-codex",
    dependsOn: [broad ? "fan-in-quality" : "verify-feature"],
    promptTemplateRef: "software-summarizer",
    promptInputs: { goalPrompt: input.goalPrompt },
    requiredArtifactRefs: ["completion_report"],
    evaluatorPipelineRef: "software-completion-quality",
    recoveryStrategyRefs: ["request-workflow-revision"],
  });

  const plan: WorkflowGenerationPlan = {
    id: `gen-${input.runId}-${hash(input.goalPrompt).slice(0, 10)}`,
    runId: input.runId,
    domainPackRef: { id: input.domainPack.id, version: input.domainPack.version, contentHash: hash(JSON.stringify(input.domainPack)) },
    intentRef: intent.id,
    templateRef: template.id,
    generatorPolicyRef: policy.id,
    rationale: broad
      ? "The prompt requests feature code, tests, documentation, and validation, so the workflow uses parallel checker branches and fan-in."
      : "The prompt is a narrow software change, so the workflow uses one checker and summary.",
    tasks,
    orchestration: {
      phases: buildPhases(broad),
      resumePolicy: "regenerate-from-checkpoint",
    },
    estimatedBudget: {
      inputTokens: tasks.length * 6_000,
      outputTokens: tasks.length * 1_500,
      costMicrosUsd: tasks.length * 40_000,
      maxParallelTasks: broad ? 2 : 1,
    },
  };
  const validation = validateWorkflowGenerationPlan(input.domainPack, plan);
  if (!validation.ok) throw new Error(`generated workflow plan failed validation: ${JSON.stringify(validation.issues)}`);
  return plan;
}

function buildPhases(broad: boolean) {
  if (!broad) {
    return [
      { id: "understand", taskRefs: ["understand-repo"] },
      { id: "implement", taskRefs: ["implement-feature"] },
      { id: "verify", taskRefs: ["verify-feature"] },
      { id: "summarize", taskRefs: ["summarize-completion"] },
    ];
  }
  return [
    { id: "understand", taskRefs: ["understand-repo"] },
    { id: "implement", taskRefs: ["implement-feature"] },
    { id: "parallel-verify", taskRefs: ["verify-tests", "verify-docs"], fanIn: { strategy: "checker-arbitrated" as const, outputArtifactRef: "verification_report" } },
    { id: "quality-fan-in", taskRefs: ["fan-in-quality"] },
    { id: "summarize", taskRefs: ["summarize-completion"] },
  ];
}

function isBroadFeaturePrompt(goalPrompt: string): boolean {
  return /(readme|docs|文件|測試|test|checker|驗證|錯誤訊息|小數|負數)/i.test(goalPrompt);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 7: Add materialization**

Create `src/v2/workflow-generator/materialize.ts`:

```ts
import type { DomainPack } from "../domain-packs/types.ts";
import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";
import type { WorkflowGenerationPlan } from "./types.ts";

export type MaterializeGenerationPlanInput = {
  plan: WorkflowGenerationPlan;
  domainPack: DomainPack;
  goalPrompt: string;
};

export function materializeGenerationPlan(input: MaterializeGenerationPlanInput): SouthstarWorkflowManifest {
  const evaluators = input.domainPack.evaluatorPipelines.map((pipeline) => ({
    id: pipeline.id,
    kind: "schema" as const,
    artifactTypes: input.domainPack.artifactContracts.map((contract) => contract.artifactType),
    requiredFields: [...new Set(input.domainPack.artifactContracts.flatMap((contract) => contract.requiredFields))],
  }));
  const tasks: WorkflowTaskDefinition[] = input.plan.tasks.map((task): WorkflowTaskDefinition => {
    const profile = required(input.domainPack.agentProfiles.find((candidate) => candidate.id === task.agentProfileRef), `profile ${task.agentProfileRef}`);
    const artifacts = task.requiredArtifactRefs.map((artifactRef) =>
      required(input.domainPack.artifactContracts.find((contract) => contract.id === artifactRef), `artifact ${artifactRef}`),
    );
    return {
      id: task.id,
      name: humanizeTaskName(task.id),
      domain: input.domainPack.id as WorkflowTaskDefinition["domain"],
      roleRef: task.roleRef,
      agentProfileRef: task.agentProfileRef,
      dependsOn: task.dependsOn,
      promptInputs: task.promptInputs,
      execution: {
        engine: "tork",
        image: "southstar/pi-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: profile.budgetPolicy.maxWallTimeSeconds ?? 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: task.evaluatorPipelineRef as "schema-evaluator-v1", maxRepairAttempts: 2, repairStrategies: task.recoveryStrategyRefs as never },
      skillRefs: profile.skillRefs,
      mcpGrantRefs: profile.mcpGrantRefs,
      requiredArtifactRefs: task.requiredArtifactRefs,
      evaluatorPipelineRef: task.evaluatorPipelineRef,
      contextPolicyRef: profile.contextPolicyRef,
      sessionPolicyRef: profile.sessionPolicyRef,
      workspacePolicyRef: "software-git-workspace",
      subagents: [{
        id: `${task.roleRef}-${task.id}`,
        harnessId: profile.harnessRef,
        prompt: `${task.promptTemplateRef}: ${JSON.stringify(task.promptInputs)}`,
        requiredArtifacts: artifacts.map((artifact) => artifact.artifactType),
      }],
    };
  });
  return {
    schemaVersion: "southstar.v2",
    workflowId: `wf-${input.plan.id}`,
    title: "Software Dynamic Feature Workflow",
    domain: input.domainPack.id,
    intent: input.plan.intentRef,
    goalPrompt: input.goalPrompt,
    domainPackRef: input.plan.domainPackRef,
    workflowGeneration: {
      planId: input.plan.id,
      generatorPolicyRef: input.plan.generatorPolicyRef,
      orchestrationSnapshotId: `orch-${input.plan.id}`,
    },
    roles: input.domainPack.roles,
    agentProfiles: input.domainPack.agentProfiles,
    artifactContracts: input.domainPack.artifactContracts,
    evaluatorPipelines: input.domainPack.evaluatorPipelines,
    contextPolicies: input.domainPack.contextPolicies,
    sessionPolicies: input.domainPack.sessionPolicies,
    memoryPolicies: input.domainPack.memoryPolicies,
    workspacePolicies: input.domainPack.workspacePolicies,
    tasks,
    harnessDefinitions: [...new Map(input.domainPack.agentProfiles.map((profile) => [profile.harnessRef, {
      id: profile.harnessRef,
      kind: profile.harnessRef as "pi-agent" | "codex" | "claude-code" | "custom",
      entrypoint: "southstar-agent-runner",
      image: "southstar/pi-agent:local",
      capabilities: ["software"],
      inputProtocol: "task-envelope-v1" as const,
      eventProtocol: "southstar-events-v1" as const,
      supportsCheckpoint: true,
      supportsSteering: true,
      supportsProgress: true,
    }])).values()],
    evaluators: evaluators.length ? evaluators : [{ id: "schema-evaluator-v1", kind: "schema", artifactTypes: ["implementation-report"], requiredFields: ["summary"] }],
    memoryPolicy: { retrievalLimit: 8, writeRequiresApproval: true },
    vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" },
    mcpServers: [],
    mcpGrants: [],
    progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 },
    steeringPolicy: { enabled: true, acceptedSignals: ["pause", "resume", "revise-prompt", "repair"] },
    learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true },
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function humanizeTaskName(id: string): string {
  return id.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}
```

If TypeScript complains about `WorkflowTaskDefinition` missing `roleRef`, update that type exactly as described in Task 1.

- [ ] **Step 8: Persist generation resources during planner draft**

Modify `src/v2/ui-api/local-api.ts` in `createPlannerDraft` so it routes the prompt through the domain pack and stores generation resources before storing the draft. Replace the start of `createPlannerDraft` with this shape:

```ts
import { softwareDomainPack } from "../domain-packs/software.ts";
import { createDomainPackRegistry } from "../domain-packs/registry.ts";
import { generateConstrainedWorkflowPlan } from "../workflow-generator/constrained-generator.ts";
import { materializeGenerationPlan } from "../workflow-generator/materialize.ts";
```

Inside `createPlannerDraft`, before falling back to `generatePlanBundleWithTimings`, add:

```ts
  const registry = createDomainPackRegistry([softwareDomainPack]);
  const route = registry.route({ goalPrompt: input.goalPrompt });
  const generatedRunId = `draft-${route.domainPack.id}-${Date.now().toString(36)}`;
  const generationPlan = generateConstrainedWorkflowPlan({
    runId: generatedRunId,
    goalPrompt: input.goalPrompt,
    domainPack: route.domainPack,
    intentId: route.intent.id,
  });
  const workflow = materializeGenerationPlan({
    plan: generationPlan,
    domainPack: route.domainPack,
    goalPrompt: input.goalPrompt,
  });
  const bundle: PlanBundle = {
    workflow,
    plannerTrace: {
      model: "southstar-constrained-generator",
      promptHash: createHash("sha256").update(input.goalPrompt).digest("hex"),
      generatedAt: new Date().toISOString(),
    },
  };
  const draftId = `draft-${bundle.workflow.workflowId}`;
  upsertRuntimeResource(db, {
    id: generationPlan.id,
    resourceType: "workflow_generation_plan",
    resourceKey: generationPlan.id,
    scope: "workflow",
    status: "validated",
    title: "Workflow generation plan",
    payload: generationPlan,
    summary: { domain: route.domainPack.id, intent: route.intent.id, taskCount: generationPlan.tasks.length },
  });
  upsertRuntimeResource(db, {
    id: workflow.workflowGeneration?.orchestrationSnapshotId,
    resourceType: "orchestration_snapshot",
    resourceKey: workflow.workflowGeneration?.orchestrationSnapshotId ?? `orch-${generationPlan.id}`,
    scope: "workflow",
    status: "created",
    title: "Initial orchestration snapshot",
    payload: {
      id: workflow.workflowGeneration?.orchestrationSnapshotId ?? `orch-${generationPlan.id}`,
      runId: generatedRunId,
      generationPlanId: generationPlan.id,
      manifestFingerprint: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
      phaseStates: generationPlan.orchestration.phases.map((phase) => ({
        phaseId: phase.id,
        status: "pending",
        taskResultRefs: [],
        intermediateResultRefs: [],
      })),
      metrics: { agentInvocations: generationPlan.tasks.length, inputTokens: generationPlan.estimatedBudget.inputTokens, outputTokens: generationPlan.estimatedBudget.outputTokens, costMicrosUsd: generationPlan.estimatedBudget.costMicrosUsd },
    },
    summary: { generationPlanId: generationPlan.id, phaseCount: generationPlan.orchestration.phases.length },
  });
```

Then keep the existing `planner_draft` upsert and return path, using this new `bundle`. Remove the old direct call to `generatePlanBundleWithTimings` once all tests pass.

- [ ] **Step 9: Run generator tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add src/v2/workflow-generator src/v2/ui-api/local-api.ts tests/v2/workflow-generator.test.ts tests/v2/index.test.ts
git commit -m "feat: generate constrained dynamic workflows"
```

---

### Task 3: ContextBuilder And SQLite Memory Provider

**Files:**
- Create: `src/v2/context/types.ts`
- Create: `src/v2/context/builder.ts`
- Create: `src/v2/memory/provider.ts`
- Create: `src/v2/memory/sqlite-provider.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/context-builder.test.ts`

- [ ] **Step 1: Write the failing context builder test**

Create `tests/v2/context-builder.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { buildContextPacket } from "../../src/v2/context/builder.ts";

test("builds auditable task context with memory injection trace", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, {
    resourceType: "memory_item",
    resourceKey: "mem-prefer-minimal",
    scope: "software",
    status: "approved",
    title: "Minimal change preference",
    payload: { kind: "preference", text: "Prefer minimal TypeScript changes with tests.", confidence: 0.9, successScore: 0.8, tags: ["software"] },
  });

  const packet = buildContextPacket(db, {
    runId: "run-ctx",
    taskId: "implement-feature",
    goalPrompt: "新增 calc sum",
    domainPack: softwareDomainPack,
    roleRef: "maker",
    agentProfileRef: "software-maker-pi",
    artifactContractRefs: ["implementation_report"],
    priorArtifactRefs: [],
    checkpointSummary: "No prior checkpoint.",
    workspaceSummary: "Fixture repo with calc add exists.",
  });

  assert.equal(packet.roleRef, "maker");
  assert.equal(packet.agentProfileRef, "software-maker-pi");
  assert.equal(packet.selectedMemories.length, 1);
  assert.match(packet.selectedMemories[0].text, /minimal TypeScript/);
  assert.equal(packet.skillInstructions.length >= 1, true);
  assert.equal(packet.mcpGrantSummary.length >= 1, true);
  assert.equal(packet.tokenEstimate.total > 0, true);

  const contextResource = db.prepare("select 1 from runtime_resources where resource_type = 'context_packet' and resource_key = ?").get(packet.id);
  assert.ok(contextResource);
  const trace = db.prepare("select payload_json from runtime_resources where resource_type = 'memory_injection_trace'").get() as { payload_json: string };
  const payload = JSON.parse(trace.payload_json) as { included: unknown[]; excluded: unknown[]; tokenEstimate: number };
  assert.equal(payload.included.length, 1);
  assert.equal(Array.isArray(payload.excluded), true);
  assert.equal(payload.tokenEstimate > 0, true);
});
```

- [ ] **Step 2: Include and run the failing test**

Add to `tests/v2/index.test.ts`:

```ts
await import("./context-builder.test.ts");
```

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing context modules.

- [ ] **Step 3: Add context and memory types**

Create `src/v2/context/types.ts`:

```ts
import type { BudgetPolicy } from "../domain-packs/types.ts";

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

export type ContextBlock = {
  id: string;
  sourceType: "prompt" | "role" | "agents-md" | "memory" | "artifact" | "checkpoint" | "skill" | "mcp" | "failure" | "workspace";
  title: string;
  text: string;
  sourceRef?: string;
  tokenEstimate: number;
};

export type TokenEstimate = {
  total: number;
  bySourceType: Record<string, number>;
};

export type ContextExclusion = {
  sourceRef: string;
  reason: "duplicate" | "over-budget" | "low-score" | "scope-mismatch";
  tokenEstimate: number;
};
```

Create `src/v2/memory/provider.ts`:

```ts
export type MemorySearchRequest = {
  query: string;
  scopes: string[];
  maxCandidates: number;
};

export type MemoryCandidate = {
  id: string;
  scope: string;
  kind: string;
  text: string;
  score: number;
  confidence: number;
  successScore: number;
  tokenEstimate: number;
  sourceRef?: string;
};

export type MemoryWriteRequest = {
  scope: string;
  kind: string;
  text: string;
  tags: string[];
  confidence: number;
  successScore: number;
  sourceRunId?: string;
  sourceArtifactId?: string;
};

export type MemoryWriteResult = {
  id: string;
};

export interface MemoryProvider {
  add(input: MemoryWriteRequest): MemoryWriteResult;
  search(input: MemorySearchRequest): MemoryCandidate[];
}
```

- [ ] **Step 4: Add SQLite memory provider**

Create `src/v2/memory/sqlite-provider.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources, upsertRuntimeResource } from "../stores/resource-store.ts";
import type { MemoryCandidate, MemoryProvider, MemorySearchRequest, MemoryWriteRequest, MemoryWriteResult } from "./provider.ts";

export function createSqliteMemoryProvider(db: SouthstarDb): MemoryProvider {
  return {
    add(input: MemoryWriteRequest): MemoryWriteResult {
      const id = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      upsertRuntimeResource(db, {
        id,
        resourceType: "memory_item",
        resourceKey: id,
        runId: input.sourceRunId,
        scope: input.scope,
        status: "approved",
        title: input.kind,
        payload: input,
      });
      return { id };
    },
    search(input: MemorySearchRequest): MemoryCandidate[] {
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = input.scopes.flatMap((scope) => listResources(db, { resourceType: "memory_item", scope, status: "approved" }));
      return rows.map((row): MemoryCandidate => {
        const payload = row.payload as Partial<MemoryWriteRequest> & { text?: string; kind?: string; confidence?: number; successScore?: number };
        const text = String(payload.text ?? JSON.stringify(row.payload));
        const lexical = terms.filter((term) => text.toLowerCase().includes(term)).length;
        const confidence = numberValue(payload.confidence, 0.6);
        const successScore = numberValue(payload.successScore, 0.5);
        return {
          id: row.id,
          scope: row.scope,
          kind: String(payload.kind ?? "artifact_summary"),
          text,
          score: lexical + confidence + successScore,
          confidence,
          successScore,
          tokenEstimate: estimateTokens(text),
          sourceRef: row.resourceKey,
        };
      }).sort((a, b) => b.score - a.score).slice(0, input.maxCandidates);
    },
  };
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
```

- [ ] **Step 5: Add ContextBuilder**

Create `src/v2/context/builder.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";
import type { DomainPack } from "../domain-packs/types.ts";
import { createSqliteMemoryProvider } from "../memory/sqlite-provider.ts";
import type { ContextBlock, ContextExclusion, ContextPacket, TokenEstimate } from "./types.ts";

export type BuildContextPacketInput = {
  runId: string;
  taskId: string;
  goalPrompt: string;
  domainPack: DomainPack;
  roleRef: string;
  agentProfileRef: string;
  artifactContractRefs: string[];
  priorArtifactRefs: string[];
  checkpointSummary?: string;
  workspaceSummary?: string;
  failureSummary?: string;
};

export function buildContextPacket(db: SouthstarDb, input: BuildContextPacketInput): ContextPacket {
  const role = required(input.domainPack.roles.find((candidate) => candidate.id === input.roleRef), `role ${input.roleRef}`);
  const profile = required(input.domainPack.agentProfiles.find((candidate) => candidate.id === input.agentProfileRef), `agent profile ${input.agentProfileRef}`);
  const memoryPolicy = required(input.domainPack.memoryPolicies.find((candidate) => candidate.id === profile.contextPolicyRef || candidate.id === "software-memory-default"), "memory policy");
  const memoryProvider = createSqliteMemoryProvider(db);
  const candidates = memoryProvider.search({
    query: `${input.goalPrompt} ${role.responsibility}`,
    scopes: memoryPolicy.scopes,
    maxCandidates: memoryPolicy.maxCandidates,
  });
  const selectedMemories: ContextBlock[] = [];
  const excludedCandidates: ContextExclusion[] = [];
  let memoryTokens = 0;
  for (const candidate of candidates) {
    if (memoryTokens + candidate.tokenEstimate <= memoryPolicy.maxInjectedTokens) {
      selectedMemories.push(block("memory", candidate.kind, candidate.text, candidate.sourceRef, candidate.tokenEstimate));
      memoryTokens += candidate.tokenEstimate;
    } else {
      excludedCandidates.push({ sourceRef: candidate.id, reason: "over-budget", tokenEstimate: candidate.tokenEstimate });
    }
  }
  const artifactContracts = input.artifactContractRefs.map((artifactRef) => {
    const contract = required(input.domainPack.artifactContracts.find((candidate) => candidate.id === artifactRef), `artifact ${artifactRef}`);
    return block("artifact", contract.id, `Required fields: ${contract.requiredFields.join(", ")}. Evidence fields: ${contract.evidenceFields.join(", ")}.`, contract.id);
  });
  const skillInstructions = profile.skillRefs.map((skillRef) => block("skill", skillRef, `Use skill snapshot ${skillRef}.`, skillRef));
  const mcpGrantSummary = profile.mcpGrantRefs.map((grantRef) => block("mcp", grantRef, `Allowed MCP grant ${grantRef}.`, grantRef));
  const contextBlocks = [
    block("prompt", "Goal", input.goalPrompt, input.runId),
    block("role", role.id, role.responsibility, role.id),
    ...artifactContracts,
    ...selectedMemories,
    ...skillInstructions,
    ...mcpGrantSummary,
    ...(input.checkpointSummary ? [block("checkpoint", "Checkpoint", input.checkpointSummary)] : []),
    ...(input.workspaceSummary ? [block("workspace", "Workspace", input.workspaceSummary)] : []),
    ...(input.failureSummary ? [block("failure", "Failure", input.failureSummary)] : []),
  ];
  const tokenEstimate = estimatePacketTokens(contextBlocks);
  const packet: ContextPacket = {
    id: `ctx-${input.runId}-${input.taskId}`,
    runId: input.runId,
    taskId: input.taskId,
    roleRef: input.roleRef,
    agentProfileRef: input.agentProfileRef,
    taskGoal: input.goalPrompt,
    roleInstruction: role.responsibility,
    agentsMdBlocks: profile.agentsMdRefs.map((ref) => block("agents-md", ref, `Reference ${ref}.`, ref)),
    artifactContracts,
    selectedMemories,
    priorArtifacts: input.priorArtifactRefs.map((ref) => block("artifact", ref, `Prior artifact ${ref}.`, ref)),
    checkpointSummary: input.checkpointSummary ? block("checkpoint", "Checkpoint", input.checkpointSummary) : undefined,
    workspaceSummary: input.workspaceSummary ? block("workspace", "Workspace", input.workspaceSummary) : undefined,
    failureSummary: input.failureSummary ? block("failure", "Failure", input.failureSummary) : undefined,
    skillInstructions,
    mcpGrantSummary,
    forbiddenActions: profile.toolPolicy.deniedTools,
    budget: profile.budgetPolicy,
    tokenEstimate,
    excludedCandidates,
  };
  upsertRuntimeResource(db, {
    id: packet.id,
    resourceType: "context_packet",
    resourceKey: packet.id,
    runId: input.runId,
    taskId: input.taskId,
    scope: input.domainPack.id,
    status: "created",
    title: `Context for ${input.taskId}`,
    payload: packet,
    summary: { tokenEstimate: tokenEstimate.total, selectedMemories: selectedMemories.length },
  });
  upsertRuntimeResource(db, {
    resourceType: "memory_injection_trace",
    resourceKey: `mem-trace-${packet.id}`,
    runId: input.runId,
    taskId: input.taskId,
    scope: input.domainPack.id,
    status: "created",
    title: `Memory injection for ${input.taskId}`,
    payload: { contextPacketId: packet.id, included: selectedMemories, excluded: excludedCandidates, tokenEstimate: memoryTokens },
  });
  return packet;
}

function block(sourceType: ContextBlock["sourceType"], title: string, text: string, sourceRef?: string, tokenEstimate = estimateTokens(text)): ContextBlock {
  return { id: `${sourceType}-${title}`.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(), sourceType, title, text, sourceRef, tokenEstimate };
}

function estimatePacketTokens(blocks: ContextBlock[]): TokenEstimate {
  const bySourceType: Record<string, number> = {};
  for (const item of blocks) bySourceType[item.sourceType] = (bySourceType[item.sourceType] ?? 0) + item.tokenEstimate;
  return { total: Object.values(bySourceType).reduce((sum, next) => sum + next, 0), bySourceType };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function required<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}
```

- [ ] **Step 6: Wire ContextBuilder into materialization**

In `src/v2/ui-api/local-api.ts`, inside `materializedWorkflowForExecution`, replace the old `retrieveApprovedMemory` call with:

```ts
const contextPacket = buildContextPacket(db, {
  runId: input.runId,
  taskId: task.id,
  goalPrompt: workflow.goalPrompt,
  domainPack: softwareDomainPack,
  roleRef: task.roleRef ?? task.subagents[0]?.id ?? "maker",
  agentProfileRef: task.agentProfileRef ?? "software-maker-pi",
  artifactContractRefs: task.requiredArtifactRefs ?? ["implementation_report"],
  priorArtifactRefs: [],
  checkpointSummary: "No checkpoint before first execution.",
  workspaceSummary: `Task ${task.id} materialized for Docker/Tork execution.`,
});
```

Then pass the packet to the envelope builder after Task 6 introduces `TaskEnvelopeV2`. Until then, keep the old memory snapshot path and assert that `context_packet` exists in tests.

- [ ] **Step 7: Run context tests**

Run:

```bash
npm run test:v2
```

Expected: PASS after the synchronous provider seam is resolved.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/v2/context src/v2/memory src/v2/ui-api/local-api.ts tests/v2/context-builder.test.ts tests/v2/index.test.ts
git commit -m "feat: build auditable task context packets"
```

---

### Task 4: Session Graph And Git Workspace Snapshots

**Files:**
- Create: `src/v2/session-graph/types.ts`
- Create: `src/v2/session-graph/sqlite-provider.ts`
- Create: `src/v2/workspace/types.ts`
- Create: `src/v2/workspace/git-provider.ts`
- Modify: `src/v2/agent-runner/root-session.ts`
- Modify: `src/v2/executor/tork-callback.ts`
- Test: `tests/v2/session-graph.test.ts`
- Test: `tests/v2/workspace-snapshot.test.ts`

- [ ] **Step 1: Write failing session graph test**

Create `tests/v2/session-graph.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { createSqliteSessionGraphProvider } from "../../src/v2/session-graph/sqlite-provider.ts";

test("records checkpoint, fork, reset and rollback lineage without deleting history", () => {
  const db = openSouthstarDb(":memory:");
  const graph = createSqliteSessionGraphProvider(db);
  const session = graph.createSession({ runId: "run-sg", taskId: "implement-feature", roleRef: "maker", agentProfileRef: "software-maker-pi" });
  const checkpoint = graph.checkpoint({
    sessionId: session.id,
    runId: "run-sg",
    taskId: "implement-feature",
    contextPacketId: "ctx-run-sg-implement-feature",
    artifactRefs: ["artifact-1"],
    transcriptSummary: "Implemented first attempt.",
    metrics: { tokens: 100, durationMs: 50 },
  });
  const fork = graph.fork({ runId: "run-sg", taskId: "implement-feature", baseCheckpointId: checkpoint.id, reason: "checker rejected docs" });
  graph.reset({ runId: "run-sg", taskId: "implement-feature", baseCheckpointId: checkpoint.id, reason: "fresh retry" });
  const rollback = graph.rollback({ runId: "run-sg", checkpointId: checkpoint.id, reason: "test failure" });

  assert.equal(fork.baseCheckpointId, checkpoint.id);
  assert.equal(rollback.restoredCheckpointId, checkpoint.id);
  assert.equal(count(db, "session_node") >= 3, true);
  assert.equal(count(db, "session_checkpoint") >= 1, true);
  assert.equal(count(db, "recovery_decision") >= 2, true);
});

function count(db: ReturnType<typeof openSouthstarDb>, type: string): number {
  const row = db.prepare("select count(*) as count from runtime_resources where resource_type = ?").get(type) as { count: number };
  return row.count;
}
```

- [ ] **Step 2: Write failing workspace snapshot test**

Create `tests/v2/workspace-snapshot.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitWorkspaceSnapshotProvider } from "../../src/v2/workspace/git-provider.ts";

test("snapshots, forks and rolls back a real Git workspace", () => {
  const repo = mkdtempSync(join(tmpdir(), "southstar-workspace-"));
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "southstar@example.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Southstar"], { cwd: repo });
  writeFileSync(join(repo, "file.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });

  const provider = createGitWorkspaceSnapshotProvider();
  const start = provider.snapshot({ repoRoot: repo, reason: "task start" });
  writeFileSync(join(repo, "file.txt"), "two\n");
  const dirty = provider.snapshot({ repoRoot: repo, reason: "dirty attempt" });
  const fork = provider.fork({ repoRoot: repo, snapshotRef: start, worktreeName: "retry-a" });
  const rolledBack = provider.rollback({ repoRoot: repo, snapshotRef: start });

  assert.equal(start.provider, "git");
  assert.match(start.commitSha, /^[0-9a-f]{40}$/);
  assert.equal(typeof dirty.dirtyPatchRef, "string");
  assert.match(fork.worktreePath, /retry-a/);
  assert.equal(rolledBack.repoRoot, repo);
  assert.equal(execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" }).trim(), "");
});
```

- [ ] **Step 3: Include and run failing tests**

Add to `tests/v2/index.test.ts`:

```ts
await import("./session-graph.test.ts");
await import("./workspace-snapshot.test.ts");
```

Run:

```bash
npm run test:v2
```

Expected: FAIL with missing provider modules.

- [ ] **Step 4: Add session graph provider**

Create `src/v2/session-graph/types.ts` and `src/v2/session-graph/sqlite-provider.ts` with synchronous methods matching the tests. Store `session_node`, `session_checkpoint`, and `recovery_decision` through `upsertRuntimeResource`. Every state transition must append to resources; do not delete old rows.

Implement `sqlite-provider.ts` method signatures exactly:

```ts
createSession(input: { runId: string; taskId: string; roleRef: string; agentProfileRef: string; parentSessionId?: string; baseCheckpointId?: string; reason?: string }): SessionNode
checkpoint(input: { sessionId: string; runId: string; taskId: string; contextPacketId: string; artifactRefs: string[]; transcriptSummary: string; failureSummary?: string; metrics: Record<string, number> }): SessionCheckpoint
fork(input: { runId: string; taskId: string; baseCheckpointId: string; reason: string }): SessionNode
reset(input: { runId: string; taskId: string; baseCheckpointId: string; reason: string }): SessionNode
rollback(input: { runId: string; checkpointId: string; reason: string }): { restoredCheckpointId: string }
```

- [ ] **Step 5: Add Git workspace snapshot provider**

Create `src/v2/workspace/types.ts` and `src/v2/workspace/git-provider.ts`. Use real `git` commands through `execFileSync`; do not fake refs. Snapshot must:

```bash
git rev-parse HEAD
git diff --binary
```

Fork must:

```bash
git worktree add <repoRoot>/.southstar-runtime/worktrees/<worktreeName> <commitSha>
```

Rollback must:

```bash
git reset --hard <commitSha>
```

The provider can run `git reset --hard` only inside the E2E fixture/worktree path supplied to the provider; do not call it on the Southstar repo.

- [ ] **Step 6: Wire session/workspace into execution**

Update `materializedWorkflowForExecution` in `src/v2/ui-api/local-api.ts` to create:

- a `session_node` for every task before materialization.
- a Git `workspace_snapshot` for tasks with `workspacePolicyRef`.
- a `session_checkpoint` at task start with `contextPacketId`.

Update `src/v2/executor/tork-callback.ts` to create an accepted checkpoint with artifact refs when `result.ok` is true.

- [ ] **Step 7: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/v2/session-graph src/v2/workspace src/v2/ui-api/local-api.ts src/v2/executor/tork-callback.ts tests/v2/session-graph.test.ts tests/v2/workspace-snapshot.test.ts tests/v2/index.test.ts
git commit -m "feat: add session graph and git workspace snapshots"
```

---

### Task 5: Evaluator Pipeline, Stop Conditions, And Recovery Decisions

**Files:**
- Create: `src/v2/evaluators/pipeline.ts`
- Create: `src/v2/evaluators/stop-condition.ts`
- Modify: `src/v2/agent-runner/root-session.ts`
- Modify: `src/v2/agent-runner/task-runner.ts`
- Modify: `src/v2/executor/tork-callback.ts`
- Test: `tests/v2/evaluator-pipeline.test.ts`
- Test: `tests/v2/stop-condition.test.ts`

- [ ] **Step 1: Write failing evaluator pipeline tests**

Create `tests/v2/evaluator-pipeline.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";
import { runEvaluatorPipeline } from "../../src/v2/evaluators/pipeline.ts";

test("software feature evaluator rejects missing evidence and selects recovery", () => {
  const db = openSouthstarDb(":memory:");
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: { summary: "changed calc" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.recoveryStrategy, "rollback-workspace");
  assert.ok(result.findings.some((finding) => finding.field === "filesChanged"));
  const row = db.prepare("select count(*) as count from runtime_resources where resource_type = 'evaluator_pipeline_result'").get() as { count: number };
  assert.equal(row.count, 1);
});

test("software feature evaluator accepts complete evidence", () => {
  const db = openSouthstarDb(":memory:");
  const result = runEvaluatorPipeline(db, {
    runId: "run-eval-ok",
    taskId: "implement-feature",
    pipeline: softwareDomainPack.evaluatorPipelines.find((pipeline) => pipeline.id === "software-feature-quality")!,
    artifactContract: softwareDomainPack.artifactContracts.find((contract) => contract.id === "implementation_report")!,
    artifact: {
      summary: "implemented calc sum",
      filesChanged: ["src/calc.ts", "src/cli.ts", "test/calc.test.ts", "README.md"],
      commandsRun: ["npm test"],
      testResults: [{ command: "npm test", passed: true }],
      risks: [],
      artifactEvidence: ["git diff", "npm test output"],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recoveryStrategy, undefined);
});
```

Create `tests/v2/stop-condition.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { evaluateStopCondition } from "../../src/v2/evaluators/stop-condition.ts";

test("run cannot complete until required evaluator pipelines pass", () => {
  const db = openSouthstarDb(":memory:");
  const blocked = evaluateStopCondition(db, {
    runId: "run-stop",
    stopConditionId: "software-feature-complete",
    requiredEvaluatorPipelineIds: ["software-feature-quality", "software-verification-quality"],
  });
  assert.equal(blocked.ok, false);

  for (const pipelineId of ["software-feature-quality", "software-verification-quality"]) {
    db.prepare(`
      insert into runtime_resources (
        id, resource_type, resource_key, run_id, scope, status, title, payload_json, summary_json, metrics_json, created_at, updated_at
      ) values (?, 'evaluator_pipeline_result', ?, 'run-stop', 'software', 'passed', ?, ?, '{}', '{}', datetime('now'), datetime('now'))
    `).run(`eval-${pipelineId}`, `eval-${pipelineId}`, pipelineId, JSON.stringify({ pipelineId, ok: true }));
  }

  const passed = evaluateStopCondition(db, {
    runId: "run-stop",
    stopConditionId: "software-feature-complete",
    requiredEvaluatorPipelineIds: ["software-feature-quality", "software-verification-quality"],
  });
  assert.equal(passed.ok, true);
});
```

- [ ] **Step 2: Add evaluator pipeline implementation**

Create `src/v2/evaluators/pipeline.ts`:

```ts
import type { ArtifactContract, EvaluatorPipelineDefinition } from "../domain-packs/types.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";

export type EvaluatorPipelineRunInput = {
  runId: string;
  taskId: string;
  pipeline: EvaluatorPipelineDefinition;
  artifactContract: ArtifactContract;
  artifact: Record<string, unknown>;
};

export type EvaluatorPipelineRunResult = {
  ok: boolean;
  pipelineId: string;
  findings: Array<{ field: string; message: string }>;
  recoveryStrategy?: string;
};

export function runEvaluatorPipeline(db: SouthstarDb, input: EvaluatorPipelineRunInput): EvaluatorPipelineRunResult {
  const findings = input.artifactContract.requiredFields
    .filter((field) => !hasValue(input.artifact[field]))
    .map((field) => ({ field, message: `missing required field ${field}` }));
  for (const field of input.artifactContract.evidenceFields) {
    if (!hasValue(input.artifact[field])) findings.push({ field, message: `missing evidence field ${field}` });
  }
  const ok = findings.length === 0;
  const result: EvaluatorPipelineRunResult = {
    ok,
    pipelineId: input.pipeline.id,
    findings,
    recoveryStrategy: ok ? undefined : input.pipeline.onFailure.defaultStrategy,
  };
  upsertRuntimeResource(db, {
    resourceType: "evaluator_pipeline_result",
    resourceKey: `eval-${input.runId}-${input.taskId}-${input.pipeline.id}`,
    runId: input.runId,
    taskId: input.taskId,
    scope: "software",
    status: ok ? "passed" : "failed",
    title: input.pipeline.id,
    payload: result,
    summary: { ok, findingCount: findings.length, recoveryStrategy: result.recoveryStrategy },
  });
  if (!ok && result.recoveryStrategy) {
    upsertRuntimeResource(db, {
      resourceType: "recovery_decision",
      resourceKey: `recovery-${input.runId}-${input.taskId}-${input.pipeline.id}`,
      runId: input.runId,
      taskId: input.taskId,
      scope: "software",
      status: "selected",
      title: result.recoveryStrategy,
      payload: { strategy: result.recoveryStrategy, findings },
    });
  }
  return result;
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== "";
}
```

Create `src/v2/evaluators/stop-condition.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { upsertRuntimeResource } from "../stores/resource-store.ts";

export type StopConditionInput = {
  runId: string;
  stopConditionId: string;
  requiredEvaluatorPipelineIds: string[];
};

export type StopConditionResult = {
  ok: boolean;
  missingEvaluatorPipelineIds: string[];
};

export function evaluateStopCondition(db: SouthstarDb, input: StopConditionInput): StopConditionResult {
  const rows = db.prepare(`
    select payload_json from runtime_resources
    where run_id = ? and resource_type = 'evaluator_pipeline_result' and status = 'passed'
  `).all(input.runId) as Array<{ payload_json: string }>;
  const passed = new Set(rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as { pipelineId?: string };
    return payload.pipelineId;
  }).filter(Boolean));
  const missingEvaluatorPipelineIds = input.requiredEvaluatorPipelineIds.filter((id) => !passed.has(id));
  const result = { ok: missingEvaluatorPipelineIds.length === 0, missingEvaluatorPipelineIds };
  upsertRuntimeResource(db, {
    resourceType: "stop_condition_result",
    resourceKey: `stop-${input.runId}-${input.stopConditionId}`,
    runId: input.runId,
    scope: "software",
    status: result.ok ? "passed" : "blocked",
    title: input.stopConditionId,
    payload: result,
  });
  return result;
}
```

- [ ] **Step 3: Wire evaluator results into root session and callback**

Update `root-session.ts` so artifact acceptance calls `runEvaluatorPipeline` using the task's `evaluatorPipelineRef` and artifact contract. Keep `evaluateArtifactGate` as a compatibility shim for legacy tests, but the new path must store `evaluator_pipeline_result` and `recovery_decision`.

Update `tork-callback.ts` so run completion checks `stop_condition_result` before marking `workflow_runs.status` as `passed`. If stop condition is blocked, mark the run `failed` or keep it `running` with `approval.requested` depending on recovery strategy.

- [ ] **Step 4: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/v2/evaluators src/v2/agent-runner/root-session.ts src/v2/agent-runner/task-runner.ts src/v2/executor/tork-callback.ts tests/v2/evaluator-pipeline.test.ts tests/v2/stop-condition.test.ts tests/v2/index.test.ts
git commit -m "feat: enforce evaluator pipelines and stop conditions"
```

---

### Task 6: TaskEnvelopeV2 And Tork Executor Boundary

**Files:**
- Modify: `src/v2/agent-runner/task-envelope.ts`
- Modify: `src/v2/agent-runner/materializer.ts`
- Modify: `src/v2/executor/tork-projection.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Test: `tests/v2/task-envelope-v2.test.ts`
- Test: `tests/v2/tork-control-plane-boundary.test.ts`

- [ ] **Step 1: Write failing TaskEnvelopeV2 test**

Create `tests/v2/task-envelope-v2.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskEnvelopeV2 } from "../../src/v2/agent-runner/task-envelope.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";

test("TaskEnvelopeV2 carries resolved runtime inputs for one task", () => {
  const role = softwareDomainPack.roles.find((item) => item.id === "maker")!;
  const agentProfile = softwareDomainPack.agentProfiles.find((item) => item.id === "software-maker-pi")!;
  const artifactContracts = softwareDomainPack.artifactContracts.filter((item) => item.id === "implementation_report");
  const evaluatorPipeline = softwareDomainPack.evaluatorPipelines.find((item) => item.id === "software-feature-quality")!;
  const envelope = buildTaskEnvelopeV2({
    runId: "run-env2",
    workflowId: "wf-env2",
    taskId: "implement-feature",
    domain: "software",
    intent: "implement_feature",
    role,
    agentProfile,
    harness: { id: "pi", kind: "pi-agent", entrypoint: "southstar-agent-runner", image: "southstar/pi-agent:local", capabilities: ["software"], inputProtocol: "task-envelope-v1", eventProtocol: "southstar-events-v1", supportsCheckpoint: true, supportsSteering: true, supportsProgress: true },
    contextPacket: { id: "ctx", runId: "run-env2", taskId: "implement-feature", roleRef: "maker", agentProfileRef: "software-maker-pi", taskGoal: "goal", roleInstruction: "make", agentsMdBlocks: [], artifactContracts: [], selectedMemories: [], priorArtifacts: [], skillInstructions: [], mcpGrantSummary: [], forbiddenActions: [], budget: agentProfile.budgetPolicy, tokenEstimate: { total: 1, bySourceType: { prompt: 1 } }, excludedCandidates: [] },
    skills: [],
    mcpGrants: [{ serverId: "filesystem-workspace", allowedTools: ["read", "edit"] }],
    vaultLeases: [],
    artifactContracts,
    evaluatorPipeline,
    session: { sessionId: "session-1", baseCheckpointId: "checkpoint-0" },
    workspace: { handle: { repoRoot: "/tmp/repo", worktreePath: "/tmp/repo" }, baseSnapshotRef: { provider: "git", repoRoot: "/tmp/repo", commitSha: "0".repeat(40) } },
  });

  assert.equal(envelope.schemaVersion, "southstar.task-envelope.v2");
  assert.equal(envelope.contextPacket.id, "ctx");
  assert.equal(envelope.agentProfile.model, "pi-agent-default");
  assert.equal(envelope.mcpGrants[0].serverId, "filesystem-workspace");
  assert.equal(envelope.workspace?.baseSnapshotRef?.provider, "git");
});
```

Create `tests/v2/tork-control-plane-boundary.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildTorkJobProjection } from "../../src/v2/executor/tork-projection.ts";
import { materializeGenerationPlan } from "../../src/v2/workflow-generator/materialize.ts";
import { generateConstrainedWorkflowPlan } from "../../src/v2/workflow-generator/constrained-generator.ts";
import { softwareDomainPack } from "../../src/v2/domain-packs/software.ts";

test("Tork projection does not include Southstar control-plane truth", () => {
  const goalPrompt = "新增 calc sum 並補測試 README";
  const plan = generateConstrainedWorkflowPlan({ runId: "run-boundary", goalPrompt, domainPack: softwareDomainPack, intentId: "implement_feature" });
  const workflow = materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt });
  const projection = buildTorkJobProjection(workflow, { runId: "run-boundary", callbackUrl: "http://127.0.0.1/callback", envelopeBasePath: "/southstar-runs" });
  const json = JSON.stringify(projection);

  assert.doesNotMatch(json, /workflowGeneratorPolicies/);
  assert.doesNotMatch(json, /memoryPolicies/);
  assert.doesNotMatch(json, /sessionPolicies/);
  assert.doesNotMatch(json, /context_packet/);
  assert.match(json, /southstar-agent-runner/);
});
```

- [ ] **Step 2: Implement TaskEnvelopeV2**

Modify `src/v2/agent-runner/task-envelope.ts` to export:

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
  mcpGrants: McpGrantInput[];
  vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">>;
  artifactContracts: ArtifactContract[];
  evaluatorPipeline: EvaluatorPipelineDefinition;
  session: { sessionId: string; baseCheckpointId?: string };
  workspace?: { handle: WorkspaceHandle; baseSnapshotRef?: WorkspaceSnapshotRef };
};
```

Add `buildTaskEnvelopeV2(input: Omit<TaskEnvelopeV2, "schemaVersion">): TaskEnvelopeV2` that strips `secretValue` from vault leases and returns the exact shape above.

- [ ] **Step 3: Materialize V2 envelopes**

Update `src/v2/agent-runner/materializer.ts` so it accepts both `TaskEnvelope` and `TaskEnvelopeV2`. For V2:

- write `envelope.json`.
- write `context-packet.json`.
- write skill snapshots under `skills/`.
- do not write provider policy definitions except what the agent needs.

- [ ] **Step 4: Keep Tork projection minimal**

Update `src/v2/executor/tork-projection.ts` so Tork tasks contain:

- task id/name.
- image/command/env/mounts.
- callback URL.
- materialized envelope path.

Do not include `roles`, `agentProfiles`, `domainPackRef`, `workflowGeneration`, `memoryPolicies`, `sessionPolicies`, or `contextPolicies` in the projection.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/v2/agent-runner/task-envelope.ts src/v2/agent-runner/materializer.ts src/v2/executor/tork-projection.ts src/v2/ui-api/local-api.ts tests/v2/task-envelope-v2.test.ts tests/v2/tork-control-plane-boundary.test.ts tests/v2/index.test.ts
git commit -m "feat: materialize task envelope v2 for tork"
```

---

### Task 7: Real E2E Feature Implementation Scenario

**Files:**
- Create: `tests/e2e-real/scenarios/domain-pack-dynamic-workflow-feature.ts`
- Modify: `tests/e2e-real/scenarios/harness.ts`
- Modify: `tests/e2e-real/index.test.ts`
- Modify: `src/v2/quality/phase1-gates.ts` or create `src/v2/quality/domain-pack-dynamic-gates.ts`

- [ ] **Step 1: Add E2E assertion helpers**

Add these helpers to `tests/e2e-real/scenarios/harness.ts`:

```ts
export function assertDomainPackDynamicWorkflowEvidence(db: SouthstarDb, runId: string): void {
  const workflowRow = db.prepare("select workflow_manifest_json from workflow_runs where id = ?").get(runId) as { workflow_manifest_json: string };
  const workflow = JSON.parse(workflowRow.workflow_manifest_json) as {
    domain?: string;
    intent?: string;
    workflowGeneration?: { planId?: string; orchestrationSnapshotId?: string };
    tasks: Array<{ id: string; roleRef?: string; agentProfileRef?: string; skillRefs?: string[]; mcpGrantRefs?: string[] }>;
  };
  assert.equal(workflow.domain, "software");
  assert.equal(workflow.intent, "implement_feature");
  assert.ok(workflow.workflowGeneration?.planId);
  assert.ok(workflow.workflowGeneration?.orchestrationSnapshotId);
  assert.equal(workflow.tasks.length >= 5, true, "dynamic workflow must have at least five tasks");
  assert.notDeepEqual(workflow.tasks.map((task) => task.id), ["planner", "implementer", "root-validator", "summary"]);
  for (const task of workflow.tasks) {
    assert.equal(typeof task.roleRef, "string", `missing roleRef for ${task.id}`);
    assert.equal(typeof task.agentProfileRef, "string", `missing agentProfileRef for ${task.id}`);
    assert.equal(Array.isArray(task.skillRefs), true, `missing skillRefs for ${task.id}`);
    assert.equal(Array.isArray(task.mcpGrantRefs), true, `missing mcpGrantRefs for ${task.id}`);
  }

  assertResourceCount(db, runId, "workflow_generation_plan", 1);
  assertResourceCount(db, runId, "orchestration_snapshot", 1);
  assertResourceCount(db, runId, "context_packet", workflow.tasks.length);
  assertResourceCount(db, runId, "memory_injection_trace", workflow.tasks.length);
  assertResourceCount(db, runId, "session_node", workflow.tasks.length);
  assertResourceCount(db, runId, "session_checkpoint", 1);
  assertResourceCount(db, runId, "workspace_snapshot", 1);
  assertResourceCount(db, runId, "evaluator_pipeline_result", 1);
  assertResourceCount(db, runId, "stop_condition_result", 1);

  const stop = db.prepare("select status from runtime_resources where run_id = ? and resource_type = 'stop_condition_result' order by created_at desc limit 1")
    .get(runId) as { status: string };
  assert.equal(stop.status, "passed");
}

export function assertTorkProjectionIsExecutorOnly(db: SouthstarDb, runId: string): void {
  const row = db.prepare("select execution_projection_json from workflow_runs where id = ?").get(runId) as { execution_projection_json: string };
  const json = row.execution_projection_json;
  for (const forbidden of ["workflowGeneratorPolicies", "memoryPolicies", "sessionPolicies", "contextPolicies", "agentProfiles"]) {
    assert.equal(json.includes(forbidden), false, `Tork projection leaked ${forbidden}`);
  }
  assert.match(json, /southstar-agent-runner/);
}

function assertResourceCount(db: SouthstarDb, runId: string, resourceType: string, minimum: number): void {
  const row = db.prepare("select count(*) as count from runtime_resources where run_id = ? and resource_type = ?")
    .get(runId, resourceType) as { count: number };
  assert.equal(row.count >= minimum, true, `expected at least ${minimum} ${resourceType}, got ${row.count}`);
}
```

- [ ] **Step 2: Add the real E2E scenario**

Create `tests/e2e-real/scenarios/domain-pack-dynamic-workflow-feature.ts`:

```ts
import assert from "node:assert/strict";
import { createPlannerDraft, createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { validateWorkflowManifest } from "../../../src/v2/manifests/validate.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertCalcSum,
  assertDomainPackDynamicWorkflowEvidence,
  assertFixtureTests,
  assertTorkProjectionIsExecutorOnly,
  createScenarioContext,
  prepareSoftwareFixtureRepo,
  startCallbackServer,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export type DomainPackDynamicWorkflowFeatureResult = {
  runId: string;
  repo: string;
  timings: {
    plannerMs: number;
    validationMs: number;
    torkSubmitMs: number;
    e2eMs: number;
  };
};

export async function runDomainPackDynamicWorkflowFeatureScenario(env: RealE2EEnv): Promise<DomainPackDynamicWorkflowFeatureResult> {
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareSoftwareFixtureRepo(env, "domain-pack-dynamic-workflow-feature");
  try {
    const goalPrompt = [
      "在真實 fixture repo 中完成一個可驗收的軟體 feature：",
      "新增 CLI 指令 `calc sum <numbers...>`，支援多個數字輸入、負數、小數、無效輸入錯誤訊息。",
      "同步更新單元測試與 README 用法。",
      "Southstar 必須自動判斷 domain/intent，依 software domain pack 動態產生 workflow DAG，不可固定四個 task。",
      "每個 task 必須解析 role、agent profile、model、skills、MCP grants、memory scope，並在 agent 執行前保存可追蹤 ContextPacket。",
      "任務必須透過 Docker/Tork 執行，Tork 只能是 executor，不能保存 workflow truth。",
      "產出 artifact 後必須由 evaluator pipeline 與 stop condition 驗收。",
      "若驗收失敗，RootSession 必須至少記錄 retry 或 fork/rollback/workflow revision 的 recovery decision。",
      "最後只有 stop condition 通過，run 才能標記 passed/completed。",
      `Fixture repo: ${repo}`,
    ].join("\n");

    const plannerStartedAt = Date.now();
    const draft = await createPlannerDraft(context.db, { goalPrompt, plannerClient: context.plannerClient });
    const plannerMs = Date.now() - plannerStartedAt;
    const validationStartedAt = Date.now();
    const draftRow = context.db.prepare("select payload_json from runtime_resources where resource_type = 'planner_draft' and resource_key = ?")
      .get(draft.draftId) as { payload_json: string };
    const draftPayload = JSON.parse(draftRow.payload_json) as { workflow: Parameters<typeof validateWorkflowManifest>[0] };
    const validation = validateWorkflowManifest(draftPayload.workflow);
    const validationMs = Date.now() - validationStartedAt;
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));

    const torkStartedAt = Date.now();
    const run = await createRunFromDraft(context.db, {
      draftId: draft.draftId,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      harnessEndpoint: env.piHarnessEndpoint,
    });
    const torkSubmitMs = Date.now() - torkStartedAt;

    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"], 120_000);
    assertCalcSum(repo);
    assertFixtureTests(repo);
    assertDomainPackDynamicWorkflowEvidence(context.db, run.runId);
    assertTorkProjectionIsExecutorOnly(context.db, run.runId);

    return { runId: run.runId, repo, timings: { plannerMs, validationMs, torkSubmitMs, e2eMs: Date.now() - startedAt } };
  } finally {
    await callback.close();
  }
}
```

- [ ] **Step 3: Add quantitative gates**

Create `src/v2/quality/domain-pack-dynamic-gates.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";

export type DomainPackDynamicGateInput = {
  runId: string;
  plannerMs: number;
  validationMs: number;
  torkSubmitMs: number;
  e2eMs: number;
};

export type GateResult = {
  ok: boolean;
  failures: string[];
};

export function assertDomainPackDynamicQuantitativeGates(db: SouthstarDb, input: DomainPackDynamicGateInput): GateResult {
  const failures: string[] = [];
  if (input.plannerMs > 60_000) failures.push(`plannerMs ${input.plannerMs} > 60000`);
  if (input.validationMs > 5_000) failures.push(`validationMs ${input.validationMs} > 5000`);
  if (input.torkSubmitMs > 20_000) failures.push(`torkSubmitMs ${input.torkSubmitMs} > 20000`);
  if (input.e2eMs > 20 * 60_000) failures.push(`e2eMs ${input.e2eMs} > 1200000`);
  const counts = resourceCounts(db, input.runId);
  if ((counts.workflow_generation_plan ?? 0) < 1) failures.push("missing workflow_generation_plan");
  if ((counts.orchestration_snapshot ?? 0) < 1) failures.push("missing orchestration_snapshot");
  if ((counts.context_packet ?? 0) < 5) failures.push("context_packet count < 5");
  if ((counts.memory_injection_trace ?? 0) < 5) failures.push("memory_injection_trace count < 5");
  if ((counts.evaluator_pipeline_result ?? 0) < 1) failures.push("missing evaluator_pipeline_result");
  if ((counts.stop_condition_result ?? 0) < 1) failures.push("missing stop_condition_result");
  if ((counts.session_checkpoint ?? 0) < 1) failures.push("missing session_checkpoint");
  if ((counts.workspace_snapshot ?? 0) < 1) failures.push("missing workspace_snapshot");
  return { ok: failures.length === 0, failures };
}

function resourceCounts(db: SouthstarDb, runId: string): Record<string, number> {
  const rows = db.prepare("select resource_type, count(*) as count from runtime_resources where run_id = ? group by resource_type")
    .all(runId) as Array<{ resource_type: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.resource_type, row.count]));
}
```

- [ ] **Step 4: Add scenario to real E2E suite**

Modify `tests/e2e-real/index.test.ts`:

```ts
import { runDomainPackDynamicWorkflowFeatureScenario } from "./scenarios/domain-pack-dynamic-workflow-feature.ts";
import { assertDomainPackDynamicQuantitativeGates } from "../../src/v2/quality/domain-pack-dynamic-gates.ts";
```

Inside the test body, after `const env = await loadRealE2EEnv();`, run:

```ts
  const dynamicFeature = await runDomainPackDynamicWorkflowFeatureScenario(env);
  const dynamicContext = createScenarioContext(env);
  const dynamicGate = assertDomainPackDynamicQuantitativeGates(dynamicContext.db, {
    runId: dynamicFeature.runId,
    ...dynamicFeature.timings,
  });
  assert.equal(dynamicGate.ok, true, dynamicGate.failures.join("\n"));
```

- [ ] **Step 5: Run unit tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Run real E2E with local Tork**

Start Tork in another terminal:

```bash
scripts/run-local-tork.sh
```

Then run:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real
```

Expected:

- PASS.
- Console includes the dynamic feature scenario completion.
- SQLite has passed `stop_condition_result`.
- Fixture repo supports `npm run cli -- sum 1 2 3`.

- [ ] **Step 7: Commit Task 7**

```bash
git add tests/e2e-real/scenarios/domain-pack-dynamic-workflow-feature.ts tests/e2e-real/scenarios/harness.ts tests/e2e-real/index.test.ts src/v2/quality/domain-pack-dynamic-gates.ts
git commit -m "test: add real domain-pack dynamic workflow e2e"
```

---

### Task 8: API And CLI Inspection Surface

**Files:**
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/ui-api/read-models.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/cli.ts`
- Test: `tests/v2/server-api.test.ts`
- Test: `tests/v2/cli-operations.test.ts`

- [ ] **Step 1: Add API and CLI tests for inspection**

Add this test to `tests/v2/server-api.test.ts` or a new `test("returns generation and context inspection resources", ...)` block in the same file:

```ts
import { upsertRuntimeResource } from "../../src/v2/stores/resource-store.ts";
import { createWorkflowRun } from "../../src/v2/stores/run-store.ts";

test("returns generation and context inspection resources", async () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-inspect-")), "db.sqlite3"));
  createWorkflowRun(db, {
    id: "run-inspect",
    status: "running",
    domain: "software",
    goalPrompt: "新增 calc sum",
    workflowManifestJson: JSON.stringify({ schemaVersion: "southstar.v2", workflowId: "wf-inspect", title: "Inspect", goalPrompt: "新增 calc sum", tasks: [], harnessDefinitions: [], evaluators: [], memoryPolicy: { retrievalLimit: 5, writeRequiresApproval: true }, vaultPolicy: { leaseTtlSeconds: 900, mountMode: "ephemeral-file" }, mcpServers: [], mcpGrants: [], progressPolicy: { firstEventWithinSeconds: 10, minEventsPerLongTask: 3 }, steeringPolicy: { enabled: true, acceptedSignals: ["pause"] }, learningPolicy: { recordMemoryDeltas: true, recordWorkflowLearnings: true } }),
    executionProjectionJson: JSON.stringify(null),
    snapshotJson: JSON.stringify({}),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  for (const [resourceType, resourceKey, payload] of [
    ["workflow_generation_plan", "gen-run-inspect", { id: "gen-run-inspect" }],
    ["orchestration_snapshot", "orch-run-inspect", { id: "orch-run-inspect" }],
    ["context_packet", "ctx-run-inspect-task", { id: "ctx-run-inspect-task", taskId: "task" }],
    ["session_node", "session-run-inspect-task", { id: "session-run-inspect-task" }],
    ["memory_injection_trace", "mem-trace-run-inspect-task", { contextPacketId: "ctx-run-inspect-task" }],
  ] as const) {
    upsertRuntimeResource(db, {
      resourceType,
      resourceKey,
      runId: "run-inspect",
      taskId: resourceType === "context_packet" ? "task" : undefined,
      scope: "software",
      status: "created",
      title: resourceType,
      payload,
    });
  }

  const server = await createSouthstarRuntimeServer({
    host: "127.0.0.1",
    port: 0,
    db,
    plannerClient: plannerClient(),
    executorProvider: executorProvider([]),
  });
  try {
    const generation = await fetch(`${server.url}/api/v2/runs/run-inspect/generation-plan`).then((response) => response.json()) as { result: { id: string } };
    const orchestration = await fetch(`${server.url}/api/v2/runs/run-inspect/orchestration`).then((response) => response.json()) as { result: { id: string } };
    const context = await fetch(`${server.url}/api/v2/runs/run-inspect/tasks/task/context`).then((response) => response.json()) as { result: { id: string } };
    const sessions = await fetch(`${server.url}/api/v2/runs/run-inspect/session-graph`).then((response) => response.json()) as { result: { nodes: unknown[] } };
    const memory = await fetch(`${server.url}/api/v2/runs/run-inspect/memory/injections`).then((response) => response.json()) as { result: { traces: unknown[] } };

    assert.equal(generation.result.id, "gen-run-inspect");
    assert.equal(orchestration.result.id, "orch-run-inspect");
    assert.equal(context.result.id, "ctx-run-inspect-task");
    assert.equal(sessions.result.nodes.length, 1);
    assert.equal(memory.result.traces.length, 1);
  } finally {
    await server.close();
  }
});
```

Add this CLI-level assertion to `tests/v2/cli-operations.test.ts` using the existing CLI test harness pattern:

```ts
test("parses inspection commands", () => {
  assert.deepEqual(parseV2Command(["generation-plan", "--run-id", "run-1"]), { command: "generation-plan", runId: "run-1" });
  assert.deepEqual(parseV2Command(["orchestration", "--run-id", "run-1"]), { command: "orchestration", runId: "run-1" });
  assert.deepEqual(parseV2Command(["context", "--run-id", "run-1", "--task-id", "task-1"]), { command: "context", runId: "run-1", taskId: "task-1" });
  assert.deepEqual(parseV2Command(["sessions", "--run-id", "run-1"]), { command: "sessions", runId: "run-1" });
});
```

- [ ] **Step 2: Implement read models**

Add these functions to `src/v2/ui-api/read-models.ts`:

```ts
export function buildGenerationPlanModel(db: SouthstarDb, runId: string) {
  return requireSingleResource(db, runId, "workflow_generation_plan").payload;
}

export function buildOrchestrationModel(db: SouthstarDb, runId: string) {
  return requireSingleResource(db, runId, "orchestration_snapshot").payload;
}

export function buildTaskContextModel(db: SouthstarDb, runId: string, taskId: string) {
  const resource = listResources(db, { resourceType: "context_packet" })
    .find((candidate) => candidate.runId === runId && candidate.taskId === taskId);
  if (!resource) throw new Error(`context packet not found for ${runId}/${taskId}`);
  return resource.payload;
}

export function buildSessionGraphModel(db: SouthstarDb, runId: string) {
  return {
    nodes: listResources(db, { resourceType: "session_node" }).filter((resource) => resource.runId === runId),
    checkpoints: listResources(db, { resourceType: "session_checkpoint" }).filter((resource) => resource.runId === runId),
    recoveries: listResources(db, { resourceType: "recovery_decision" }).filter((resource) => resource.runId === runId),
  };
}

export function buildMemoryInjectionsModel(db: SouthstarDb, runId: string) {
  return {
    traces: listResources(db, { resourceType: "memory_injection_trace" }).filter((resource) => resource.runId === runId),
  };
}

function requireSingleResource(db: SouthstarDb, runId: string, resourceType: string) {
  const resources = listResources(db, { resourceType }).filter((resource) => resource.runId === runId);
  if (resources.length === 0) throw new Error(`${resourceType} not found for ${runId}`);
  return resources[0];
}
```

- [ ] **Step 3: Implement routes**

Add route branches in `src/v2/server/routes.ts`:

```ts
if (request.method === "GET" && matchRunPath(pathname, /^\/api\/v2\/runs\/([^/]+)\/generation-plan$/)) {
  return json("generation-plan", buildGenerationPlanModel(context.db, decodeURIComponent(RegExp.$1)));
}
if (request.method === "GET" && matchRunPath(pathname, /^\/api\/v2\/runs\/([^/]+)\/orchestration$/)) {
  return json("orchestration", buildOrchestrationModel(context.db, decodeURIComponent(RegExp.$1)));
}
if (request.method === "GET" && matchRunPath(pathname, /^\/api\/v2\/runs\/([^/]+)\/tasks\/([^/]+)\/context$/)) {
  return json("context", buildTaskContextModel(context.db, decodeURIComponent(RegExp.$1), decodeURIComponent(RegExp.$2)));
}
if (request.method === "GET" && matchRunPath(pathname, /^\/api\/v2\/runs\/([^/]+)\/session-graph$/)) {
  return json("session-graph", buildSessionGraphModel(context.db, decodeURIComponent(RegExp.$1)));
}
if (request.method === "GET" && matchRunPath(pathname, /^\/api\/v2\/runs\/([^/]+)\/memory\/injections$/)) {
  return json("memory-injections", buildMemoryInjectionsModel(context.db, decodeURIComponent(RegExp.$1)));
}
```

Use the route matching helper style already present in `routes.ts`; if `matchRunPath` does not exist, create a local helper:

```ts
function matchRunPath(pathname: string, pattern: RegExp): boolean {
  return pattern.test(pathname);
}
```

- [ ] **Step 4: Implement CLI commands**

Add parser branches in `src/v2/cli.ts`:

```ts
if (args[0] === "generation-plan") return { command: "generation-plan", runId: requiredFlag(args, "--run-id") };
if (args[0] === "orchestration") return { command: "orchestration", runId: requiredFlag(args, "--run-id") };
if (args[0] === "context") return { command: "context", runId: requiredFlag(args, "--run-id"), taskId: requiredFlag(args, "--task-id") };
if (args[0] === "sessions") return { command: "sessions", runId: requiredFlag(args, "--run-id") };
```

Add execution branches:

```ts
case "generation-plan":
  return { kind: "generation-plan", result: buildGenerationPlanModel(dependencies.db, command.runId) };
case "orchestration":
  return { kind: "orchestration", result: buildOrchestrationModel(dependencies.db, command.runId) };
case "context":
  return { kind: "context", result: buildTaskContextModel(dependencies.db, command.runId, command.taskId) };
case "sessions":
  return { kind: "sessions", result: buildSessionGraphModel(dependencies.db, command.runId) };
```

Output JSON through the existing CLI formatting path so E2E diagnostics can parse the result.

- [ ] **Step 5: Run tests**

Run:

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 6: Commit Task 8**

```bash
git add src/v2/ui-api/local-api.ts src/v2/ui-api/read-models.ts src/v2/server/routes.ts src/v2/cli.ts tests/v2/server-api.test.ts tests/v2/cli-operations.test.ts
git commit -m "feat: inspect generation context and session state"
```

---

## Final Verification

- [ ] **Step 1: Run the full v2 unit suite**

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 2: Run the real E2E suite**

Start local Tork:

```bash
scripts/run-local-tork.sh
```

Run the real suite:

```bash
SOUTHSTAR_DB=/tmp/southstar-real-e2e/southstar.sqlite3 \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:real
```

Expected: PASS. This is the required acceptance command for this plan.

- [ ] **Step 3: Inspect SQLite evidence**

Run:

```bash
sqlite3 /tmp/southstar-real-e2e/southstar.sqlite3 "
select resource_type, count(*) from runtime_resources
where resource_type in (
  'workflow_generation_plan',
  'orchestration_snapshot',
  'context_packet',
  'memory_injection_trace',
  'session_node',
  'session_checkpoint',
  'workspace_snapshot',
  'evaluator_pipeline_result',
  'stop_condition_result',
  'recovery_decision'
)
group by resource_type
order by resource_type;"
```

Expected: each listed resource type has count >= 1, and `context_packet` / `memory_injection_trace` count >= dynamic task count.

- [ ] **Step 4: Inspect fixture feature**

Run:

```bash
cd /tmp/southstar-real-e2e/domain-pack-dynamic-workflow-feature
npm run cli -- sum 1 2 3
npm test
```

Expected: CLI output includes `6`; tests pass.

- [ ] **Step 5: Commit final verification notes if any docs changed**

Only commit docs if verification updates the plan or coverage notes:

```bash
git add docs/superpowers/plans/2026-06-13-southstar-domain-pack-dynamic-workflow-runtime-implementation-plan.md
git commit -m "docs: update dynamic workflow runtime verification notes"
```

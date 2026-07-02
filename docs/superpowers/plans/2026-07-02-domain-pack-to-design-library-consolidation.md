# Domain Pack → Design Library Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every load-bearing concept owned by `src/v2/domain-packs/` into the Postgres-backed design library, delete `src/v2/domain-packs/`, and enable multi-scope (cross-domain) candidate selection.

**Architecture:** Add 7 new `LibraryDefinitionKind` values (context/session/memory/workspace policies, stop_condition, evaluator_pipeline, workflow_generator_policy) plus new edge types. Relocate domain-pack runtime types to `design-library/runtime-types.ts`. Introduce a graph-loaded `LibrarySnapshot` that replaces the `DomainPack` aggregate. Rewrite 6 static-`softwareDomainPack` consumers and the `workflow-generator` trio to read from the snapshot. Widen `candidate-resolver` to `scopes: string[]`. Fold `intent` into a new stage-template object (`template.software-feature-stages`), kept distinct from the existing composition-slot template.

**Tech Stack:** Node ≥22.22.2, ESM, TypeScript via tsx, Postgres (`southstar` schema), `node:test` runner. No compiled dist.

**Spec:** `docs/superpowers/specs/2026-07-02-southstar-domain-pack-to-design-library-consolidation-design.md`

**Verification commands (per AGENTS.md, no e2e/live):**
- `npm run test:v2` (broad)
- `npm run test:postgres` (focused Postgres)
- `npm --prefix web run build` (when web routing/imports change)

---

## File Structure

**Created:**
- `src/v2/design-library/runtime-types.ts` — runtime value types relocated from `domain-packs/types.ts` (`AgentProvider`, `ToolPolicy`, `BudgetPolicy`, `RoleDefinition`, `AgentProfile`, `ArtifactContract`, `EvaluatorPipelineDefinition`, `ContextPolicyDefinition`, `SessionPolicyDefinition`, `MemoryPolicyDefinition`, `WorkspacePolicyDefinition`, `StopConditionDefinition`, `WorkflowGeneratorPolicyDefinition`, `WorkflowStageTemplate`, `IntentDefinition`)
- `src/v2/design-library/library-snapshot.ts` — `LibrarySnapshot` type + `loadLibrarySnapshot(db, scopes)` loader
- `src/v2/design-library/domain-router.ts` — prompt → `(scopes, intentId, templateRef)` routing (moved from `domain-packs/registry.ts`)
- `tests/v2/library-snapshot.test.ts` — shape-parity test for the snapshot loader
- `tests/v2/design-library-runtime-types.test.ts` — compile/type smoke test

**Modified (import-path rewrites):** `src/v2/agent-runner/task-envelope.ts`, `src/v2/artifacts/validator-results.ts`, `src/v2/context/types.ts`, `src/v2/context/postgres-builder.ts`, `src/v2/context/managed-context-assembler.ts`, `src/v2/manifests/types.ts`, `src/v2/orchestration/composition-compiler.ts`, `src/v2/read-models/agent-library.ts`, `src/v2/read-models/workflow-ui.ts`, `src/v2/ui-api/planner-draft-task-overrides.ts`, `src/v2/ui-api/postgres-run-api.ts`, `src/v2/ui-api/postgres-task-envelope.ts`, `src/v2/evolution/sandbox.ts`, `src/v2/workflow-generator/{constrained-generator,validator,materialize}.ts`

**Modified (seed + graph):** `src/v2/design-library/types.ts`, `src/v2/design-library/library-graph-store.ts`, `src/v2/design-library/software-library-seed.ts`, `src/v2/orchestration/candidate-resolver.ts`

**Modified (tests):** `tests/v2/{managed-context-assembler,managed-context-scheduler,managed-runtime-loops,managed-static-gates,postgres-task-envelope,task-envelope-v2,task-envelope-v2-refresh,runnable-task-scheduler,evolution-context-builder-postgres,domain-pack,effort-policy}.test.ts`, `tests/v2/index.test.ts`

**Deleted (final task):** `src/v2/domain-packs/{types,software,registry}.ts`, `components/southstar/pages/DomainPacksAgentStudioPage.tsx` (repointed), `lib/southstar/api-client.ts` `getUiDomainPacks` method

---

## Task Ordering Rationale

Tasks 1–2 are pure additive (new types + new kinds) — no existing behavior changes. Tasks 3–4 build the loader and its test. Tasks 5–7 relocate types and repoint imports (mechanical, compile-gated). Tasks 8–11 rewrite consumers to use the snapshot. Task 12 rewrites the workflow-generator trio. Task 13 widens candidate resolution. Task 14 is the deletion gate. Each task ends green.

---

## Task 1: Create `design-library/runtime-types.ts` with relocated types

**Files:**
- Create: `src/v2/design-library/runtime-types.ts`
- Create: `tests/v2/design-library-runtime-types.test.ts`

This task only **adds** a new file with the same type definitions that already exist in `domain-packs/types.ts`. `domain-packs/types.ts` is left untouched so everything still compiles. Later tasks repoint imports.

- [ ] **Step 1: Write the type smoke test**

Create `tests/v2/design-library-runtime-types.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProvider,
  AgentProfile,
  ArtifactContract,
  BudgetPolicy,
  ContextPolicyDefinition,
  EvaluatorPipelineDefinition,
  EvaluatorStepDefinition,
  IntentDefinition,
  MemoryKind,
  MemoryPolicyDefinition,
  PlannerDraftTaskProfileOverride,
  QualityPattern,
  RoleDefinition,
  SessionPolicyDefinition,
  StopConditionDefinition,
  ToolPolicy,
  WorkflowGeneratorPolicyDefinition,
  WorkflowStageTemplate,
  WorkspacePolicyDefinition,
} from "../../src/v2/design-library/runtime-types.ts";

test("runtime-types re-exports compile and have expected shapes", () => {
  const provider: AgentProvider = "pi";
  const override: PlannerDraftTaskProfileOverride = { provider, model: "x" };
  const role: RoleDefinition = {
    id: "r",
    responsibility: "r",
    defaultAgentProfileRef: "p",
    allowedAgentProfileRefs: ["p"],
    artifactInputs: [],
    artifactOutputs: [],
    stopAuthority: "none",
  };
  const profile: AgentProfile = {
    id: "p",
    name: "P",
    provider: "pi",
    harnessRef: "pi",
    agentsMdRefs: [],
    promptTemplateRef: "t",
    skillRefs: [],
    mcpGrantRefs: [],
    memoryScopes: [],
    contextPolicyRef: "c",
    sessionPolicyRef: "s",
    toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 1, maxOutputTokens: 1 },
  };
  const contract: ArtifactContract = { id: "a", artifactType: "t", requiredFields: [], evidenceFields: [] };
  const step: EvaluatorStepDefinition = { id: "e", kind: "schema", config: {}, required: true };
  const pipeline: EvaluatorPipelineDefinition = { id: "ep", evaluators: [step], onFailure: { defaultStrategy: "retry-same-agent" } };
  const ctxPolicy: ContextPolicyDefinition = { id: "c", maxInputTokens: 1, memoryPolicyRef: "m", includeAgentsMd: true, includeWorkspaceSummary: true };
  const sessPolicy: SessionPolicyDefinition = { id: "s", checkpointOn: ["task-start"], allowFork: true, allowReset: true, allowRollback: true };
  const memPolicy: MemoryPolicyDefinition = { id: "m", providerRef: "postgres", scopes: [], maxInjectedTokens: 1, maxCandidates: 1, requireWriteApproval: true, allowedKinds: ["preference"], ranking: { relevanceWeight: 1, recencyWeight: 1, successWeight: 1, confidenceWeight: 1 }, compression: { strategy: "none", maxTokensPerMemory: 1 } };
  const wsPolicy: WorkspacePolicyDefinition = { id: "w", provider: "git", snapshotAtTaskStart: true, snapshotAtAcceptedArtifact: true, forkOnCheckerReject: true, rollbackOnTestFailure: true };
  const stop: StopConditionDefinition = { id: "sc", type: "custom", evaluatorRefs: [] };
  const genPolicy: WorkflowGeneratorPolicyDefinition = { id: "g", intentRefs: [], templateRefs: [], allowedRoleRefs: ["r"], allowedAgentProfileRefs: ["p"], allowedEvaluatorPipelineRefs: ["ep"], allowedArtifactContractRefs: ["a"], maxTasks: 1, maxParallelTasks: 1, maxAgentInvocations: 1, maxEstimatedInputTokens: 1, qualityPatterns: ["maker-checker"] };
  const stage: WorkflowStageTemplate = { id: "st", roleRef: "r", dependsOn: [], promptTemplateRef: "t", requiredArtifactRefs: [], evaluatorPipelineRef: "ep", stopConditionRefs: [], allowDynamicExpansion: true };
  const intent: IntentDefinition = { id: "i", description: "d", examples: [], workflowTemplateRef: "t", requiredInputs: [], defaultContextPolicyRef: "c", defaultSessionPolicyRef: "s" };

  assert.equal(override.provider, "pi");
  assert.equal(role.id, "r");
  assert.equal(profile.harnessRef, "pi");
  assert.equal(contract.artifactType, "t");
  assert.equal(pipeline.evaluators.length, 1);
  assert.equal(ctxPolicy.memoryPolicyRef, "m");
  assert.equal(sessPolicy.checkpointOn[0], "task-start");
  assert.equal(memPolicy.allowedKinds[0], "preference");
  assert.equal(wsPolicy.provider, "git");
  assert.equal(stop.type, "custom");
  assert.equal(genPolicy.qualityPatterns[0], "maker-checker");
  assert.equal(stage.allowDynamicExpansion, true);
  assert.equal(intent.workflowTemplateRef, "t");

  const _: QualityPattern = "maker-checker";
  const __: MemoryKind = "workflow_learning";
  const ___: ToolPolicy = profile.toolPolicy;
  const ____: BudgetPolicy = profile.budgetPolicy;
  void _; void __; void ___; void ____;
});
```

- [ ] **Step 2: Run the test to verify it fails (module not found)**

Run: `npx tsx tests/v2/design-library-runtime-types.test.ts`
Expected: FAIL — `Cannot find module '../../src/v2/design-library/runtime-types.ts'`

- [ ] **Step 3: Create `runtime-types.ts` with the relocated definitions**

Create `src/v2/design-library/runtime-types.ts` (verbatim copy of the type bodies from `domain-packs/types.ts` lines 19–225, **excluding** `DomainPack` and the `WorkflowTemplate` aggregate — those die with domain-packs; `IntentDefinition`, `WorkflowStageTemplate`, and all policy/step types move here):

```ts
/**
 * Runtime value types for the design library.
 *
 * Relocated from src/v2/domain-packs/types.ts so that domain-packs/ can be
 * deleted. These keep their exact shapes so manifests, agent-runner, context,
 * ui-api, read-models, and workflow-generator only change import paths.
 */

export type IntentDefinition = {
  id: string;
  description: string;
  examples: string[];
  workflowTemplateRef: string;
  requiredInputs: string[];
  defaultContextPolicyRef: string;
  defaultSessionPolicyRef: string;
};

export type Intent = IntentDefinition;

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

export type WorkflowGeneratorPolicy = WorkflowGeneratorPolicyDefinition;

export type QualityPattern =
  | "maker-checker"
  | "multi-angle-research"
  | "competing-hypotheses"
  | "fanout-fan-in"
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

export type AgentProvider = "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";

export type PlannerDraftTaskProfileOverride = {
  provider?: AgentProvider;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
};

export type AgentProfile = {
  id: string;
  name: string;
  provider: AgentProvider;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
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
    defaultStrategy:
      | "retry-same-agent"
      | "fork-from-checkpoint"
      | "rollback-workspace"
      | "request-workflow-revision"
      | "ask-human";
  };
};

export type EvaluatorPipeline = EvaluatorPipelineDefinition;

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

export type ContextPolicy = ContextPolicyDefinition;

export type SessionPolicyDefinition = {
  id: string;
  checkpointOn: Array<"task-start" | "artifact-accepted" | "before-recovery">;
  allowFork: boolean;
  allowReset: boolean;
  allowRollback: boolean;
};

export type SessionPolicy = SessionPolicyDefinition;

export type MemoryPolicyDefinition = {
  id: string;
  providerRef: "postgres" | "mem0" | string;
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

export type MemoryPolicy = MemoryPolicyDefinition;

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

export type WorkspacePolicy = WorkspacePolicyDefinition;

export type StopConditionDefinition = {
  id: string;
  type: "artifact-accepted" | "tests-passed" | "checker-passed" | "human-approved" | "custom";
  evaluatorRefs: string[];
};

export type StopCondition = StopConditionDefinition;
```

- [ ] **Step 4: Register the test in the aggregator and run it**

Add to `tests/v2/index.test.ts` (alphabetical-ish near the other design-library tests):

```ts
await import("./design-library-runtime-types.test.ts");
```

Run: `npx tsx tests/v2/design-library-runtime-types.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/v2/design-library/runtime-types.ts tests/v2/design-library-runtime-types.test.ts tests/v2/index.test.ts
git commit -m "feat: add design-library/runtime-types with relocated domain-pack types"
```

---

## Task 2: Add new `LibraryDefinitionKind` values and edge types

**Files:**
- Modify: `src/v2/design-library/types.ts` (the `LibraryDefinitionKind` and `LibraryEdgeType` unions)
- Modify: `src/v2/design-library/library-graph-store.ts` (no SQL change — kinds are data, but add a guard test)
- Test: `tests/v2/library-graph-store.test.ts` (append one case)

- [ ] **Step 1: Write the failing test for a new kind round-trip**

Append to `tests/v2/library-graph-store.test.ts`:

```ts
test("library graph store round-trips a context_policy kind object", async () => {
  const db = await createTestPostgresDb();
  try {
    const obj = await upsertLibraryObject(db, {
      objectKey: "context_policy.software-context-default",
      objectKind: "context_policy",
      status: "approved",
      headVersionId: "context_policy.software-context-default@v1",
      state: { scope: "software", id: "software-context-default", maxInputTokens: 20000, memoryPolicyRef: "software-memory-default", includeAgentsMd: true, includeWorkspaceSummary: true },
    });
    assert.equal(obj.objectKind, "context_policy");
    const found = await findApprovedLibraryObjectsByKind(db, "context_policy", "software");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.objectKey, "context_policy.software-context-default");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails (type error)**

Run: `npx tsx --test tests/v2/library-graph-store.test.ts`
Expected: FAIL — TypeScript error `Argument of type '"context_policy"' is not assignable to 'LibraryDefinitionKind'`.

- [ ] **Step 3: Extend the `LibraryDefinitionKind` union**

In `src/v2/design-library/types.ts`, replace the `LibraryDefinitionKind` union with:

```ts
export type LibraryDefinitionKind =
  | "agent_spec"
  | "agent_definition"
  | "agent_profile"
  | "skill_definition"
  | "skill_spec"
  | "mcp_tool_grant"
  | "artifact_contract"
  | "evaluator_pipeline"
  | "capability_spec"
  | "contract_spec"
  | "validator_spec"
  | "policy_bundle"
  | "workflow_template"
  | "workflow_recipe"
  | "tool_definition"
  | "instruction_template"
  | "vault_lease_policy"
  | "context_policy"
  | "session_policy"
  | "memory_policy"
  | "workspace_policy"
  | "stop_condition"
  | "workflow_generator_policy"
  | "evaluator_profile";
```

Note: `evaluator_profile` is retained only for migration read of existing rows; it is no longer seeded (Task 8 stops seeding it). `evaluator_pipeline` is the new full kind.

- [ ] **Step 4: Extend the `LibraryEdgeType` union**

In the same file, add to the `LibraryEdgeType` union (keep all existing members):

```ts
  | "uses_context_policy"
  | "uses_session_policy"
  | "uses_memory_policy"
  | "uses_workspace_policy"
  | "enforces_generator_policy";
```

(`checked_by_stop_condition` is not needed — stop conditions are referenced by `stopConditionRefs` inside the stage template's `state.stages[]`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test tests/v2/library-graph-store.test.ts`
Expected: PASS — all cases including the new `context_policy` round-trip.

- [ ] **Step 6: Commit**

```bash
git add src/v2/design-library/types.ts tests/v2/library-graph-store.test.ts
git commit -m "feat: add context/session/memory/workspace policy, stop_condition, evaluator_pipeline, workflow_generator_policy library kinds"
```

---

## Task 3: Create `library-snapshot.ts` — the graph-loaded `LibrarySnapshot`

**Files:**
- Create: `src/v2/design-library/library-snapshot.ts`
- Create: `tests/v2/library-snapshot.test.ts`

`LibrarySnapshot` is the graph-loaded replacement for the `DomainPack` aggregate. It loads the 7 new kinds plus the existing agent/profile/artifact/template kinds for a set of scopes and projects them into the typed shapes from `runtime-types.ts`.

- [ ] **Step 1: Write the failing shape-parity test**

Create `tests/v2/library-snapshot.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { loadLibrarySnapshot } from "../../src/v2/design-library/library-snapshot.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";

test("loadLibrarySnapshot returns software scope with parity to softwareDomainPack", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const snapshot = await loadLibrarySnapshot(db, ["software"]);
    assert.equal(snapshot.scopes, 1);
    assert.equal(snapshot.scopes[0], "software");
    const roleIds = snapshot.roles.map((r) => r.id).sort();
    assert.ok(roleIds.includes("explorer"));
    assert.ok(roleIds.includes("maker"));
    assert.ok(roleIds.includes("checker"));
    assert.ok(roleIds.includes("summarizer"));
    assert.ok(snapshot.agentProfiles.some((p) => p.id === "software-maker-pi"));
    assert.ok(snapshot.artifactContracts.some((c) => c.id === "implementation_plan"));
    assert.ok(snapshot.evaluatorPipelines.some((e) => e.id === "software-feature-quality"));
    assert.ok(snapshot.evaluatorPipelines.some((e) => e.evaluators.length >= 4));
    assert.ok(snapshot.contextPolicies.some((c) => c.id === "software-context-default"));
    assert.ok(snapshot.contextPolicies.some((c) => c.id === "software-context-summary"));
    assert.ok(snapshot.sessionPolicies.some((s) => s.id === "software-session-default"));
    assert.ok(snapshot.memoryPolicies.some((m) => m.id === "software-memory-default"));
    assert.ok(snapshot.workspacePolicies.some((w) => w.id === "software-git-workspace"));
    assert.ok(snapshot.stopConditions.some((s) => s.id === "software-feature-complete"));
    assert.ok(snapshot.workflowGeneratorPolicies.some((g) => g.id === "software-feature-generator"));
    const stageTemplate = snapshot.workflowTemplates.find((t) => t.id === "software-feature-template");
    assert.ok(stageTemplate, "stage template present");
    assert.ok(stageTemplate && stageTemplate.stages.length === 4, "stage template has 4 stages");
    assert.ok(stageTemplate && stageTemplate.intents.length === 2, "stage template has 2 intents");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails (module not found)**

Run: `npx tsx tests/v2/library-snapshot.test.ts`
Expected: FAIL — `Cannot find module '../../src/v2/design-library/library-snapshot.ts'`.

- [ ] **Step 3: Implement `library-snapshot.ts`**

Create `src/v2/design-library/library-snapshot.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import { findApprovedLibraryObjectsByKind, type LibraryObjectSummary } from "./library-graph-store.ts";
import type {
  AgentProfile,
  ArtifactContract,
  ContextPolicyDefinition,
  EvaluatorPipelineDefinition,
  IntentDefinition,
  MemoryPolicyDefinition,
  RoleDefinition,
  SessionPolicyDefinition,
  StopConditionDefinition,
  WorkflowGeneratorPolicyDefinition,
  WorkspacePolicyDefinition,
} from "./runtime-types.ts";

export type WorkflowTemplateSnapshot = {
  key: string;
  id: string;
  intentRefs: string[];
  intents: IntentDefinition[];
  stages: WorkflowStageSnapshot[];
  scope: string;
};

export type WorkflowStageSnapshot = {
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

export type LibrarySnapshot = {
  scopes: string[];
  roles: RoleDefinition[];
  agentProfiles: AgentProfile[];
  artifactContracts: ArtifactContract[];
  evaluatorPipelines: EvaluatorPipelineDefinition[];
  contextPolicies: ContextPolicyDefinition[];
  sessionPolicies: SessionPolicyDefinition[];
  memoryPolicies: MemoryPolicyDefinition[];
  workspacePolicies: WorkspacePolicyDefinition[];
  stopConditions: StopConditionDefinition[];
  workflowTemplates: WorkflowTemplateSnapshot[];
  workflowGeneratorPolicies: WorkflowGeneratorPolicyDefinition[];
};

export async function loadLibrarySnapshot(db: SouthstarDb, scopes: string[]): Promise<LibrarySnapshot> {
  const singleScope = scopes.length === 1 ? scopes[0]! : undefined;
  const [agentDefs, profiles, artifacts, evaluatorPipelines, contextPolicies, sessionPolicies, memoryPolicies, workspacePolicies, stopConditions, templates, generatorPolicies] = await Promise.all([
    findApprovedLibraryObjectsByKind(db, "agent_definition", singleScope),
    findApprovedLibraryObjectsByKind(db, "agent_profile", singleScope),
    findApprovedLibraryObjectsByKind(db, "artifact_contract", singleScope),
    findApprovedLibraryObjectsByKind(db, "evaluator_pipeline", singleScope),
    findApprovedLibraryObjectsByKind(db, "context_policy", singleScope),
    findApprovedLibraryObjectsByKind(db, "session_policy", singleScope),
    findApprovedLibraryObjectsByKind(db, "memory_policy", singleScope),
    findApprovedLibraryObjectsByKind(db, "workspace_policy", singleScope),
    findApprovedLibraryObjectsByKind(db, "stop_condition", singleScope),
    findApprovedLibraryObjectsByKind(db, "workflow_template", singleScope),
    findApprovedLibraryObjectsByKind(db, "workflow_generator_policy", singleScope),
  ]);

  const scopeSet = new Set(scopes);
  const inScopes = (obj: LibraryObjectSummary) => scopes.length === 0 || scopeSet.size === 0 || obj.state.scope === scopes[0] || scopeSet.has(String(obj.state.scope ?? ""));

  return {
    scopes: [...scopes],
    roles: agentDefs.filter(inScopes).map((o) => mapRole(o.state)),
    agentProfiles: profiles.filter(inScopes).map((o) => mapProfile(o.state)),
    artifactContracts: artifacts.filter(inScopes).map((o) => mapArtifactContract(o.state)),
    evaluatorPipelines: evaluatorPipelines.filter(inScopes).map((o) => o.state as unknown as EvaluatorPipelineDefinition),
    contextPolicies: contextPolicies.filter(inScopes).map((o) => o.state as unknown as ContextPolicyDefinition),
    sessionPolicies: sessionPolicies.filter(inScopes).map((o) => o.state as unknown as SessionPolicyDefinition),
    memoryPolicies: memoryPolicies.filter(inScopes).map((o) => o.state as unknown as MemoryPolicyDefinition),
    workspacePolicies: workspacePolicies.filter(inScopes).map((o) => o.state as unknown as WorkspacePolicyDefinition),
    stopConditions: stopConditions.filter(inScopes).map((o) => o.state as unknown as StopConditionDefinition),
    workflowTemplates: templates.filter(inScopes).map((o) => mapTemplate(o.objectKey, o.state)),
    workflowGeneratorPolicies: generatorPolicies.filter(inScopes).map((o) => o.state as unknown as WorkflowGeneratorPolicyDefinition),
  };
}

function mapRole(state: Record<string, unknown>): RoleDefinition {
  const runtimeRole = (state.runtimeRole ?? {}) as Record<string, unknown>;
  return {
    id: String(runtimeRole.id ?? state.role ?? ""),
    responsibility: String(runtimeRole.responsibility ?? ""),
    defaultAgentProfileRef: String(runtimeRole.defaultAgentProfileRef ?? ""),
    allowedAgentProfileRefs: asStringArray(runtimeRole.allowedAgentProfileRefs),
    artifactInputs: asStringArray(runtimeRole.artifactInputs),
    artifactOutputs: asStringArray(runtimeRole.artifactOutputs),
    stopAuthority: (runtimeRole.stopAuthority ?? "none") as RoleDefinition["stopAuthority"],
  };
}

function mapProfile(state: Record<string, unknown>): AgentProfile {
  const runtimeProfile = (state.runtimeProfile ?? state) as Record<string, unknown>;
  return {
    id: String(runtimeProfile.id ?? ""),
    name: String(runtimeProfile.name ?? runtimeProfile.id ?? ""),
    provider: (runtimeProfile.provider ?? "custom") as AgentProfile["provider"],
    model: optionalString(runtimeProfile.model),
    harnessRef: String(runtimeProfile.harnessRef ?? ""),
    agentsMdRefs: asStringArray(runtimeProfile.agentsMdRefs),
    promptTemplateRef: String(runtimeProfile.promptTemplateRef ?? ""),
    skillRefs: asStringArray(runtimeProfile.skillRefs),
    mcpGrantRefs: asStringArray(runtimeProfile.mcpGrantRefs),
    memoryScopes: asStringArray(runtimeProfile.memoryScopes),
    contextPolicyRef: String(runtimeProfile.contextPolicyRef ?? ""),
    sessionPolicyRef: String(runtimeProfile.sessionPolicyRef ?? ""),
    toolPolicy: (runtimeProfile.toolPolicy ?? { allowedTools: [], deniedTools: [], requiresApprovalFor: [] }) as AgentProfile["toolPolicy"],
    budgetPolicy: (runtimeProfile.budgetPolicy ?? { maxInputTokens: 0, maxOutputTokens: 0 }) as AgentProfile["budgetPolicy"],
  };
}

function mapArtifactContract(state: Record<string, unknown>): ArtifactContract {
  return {
    id: String(state.id ?? state.artifactType ?? ""),
    artifactType: String(state.artifactType ?? ""),
    requiredFields: asStringArray(state.requiredFields),
    evidenceFields: asStringArray(state.evidenceFields),
  };
}

function mapTemplate(key: string, state: Record<string, unknown>): WorkflowTemplateSnapshot {
  return {
    key,
    id: String(state.id ?? key),
    intentRefs: asStringArray(state.intentRefs),
    intents: (state.intents ?? []) as IntentDefinition[],
    stages: (state.stages ?? []) as WorkflowStageSnapshot[],
    scope: String(state.scope ?? ""),
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
```

- [ ] **Step 4: Run the test**

The test seeds first (Task 4 lands the new seed objects). Until Task 4, this test will **partially fail** (new policy kinds not seeded yet). That is expected — Task 4 completes the parity. Run now to confirm the loader compiles and the agent/profile/artifact paths work:

Run: `npx tsx tests/v2/library-snapshot.test.ts`
Expected: FAIL on the policy/template assertions only (roles/profiles/artifacts pass). This confirms the loader is wired; Task 4 makes it green.

- [ ] **Step 5: Register the test**

Add to `tests/v2/index.test.ts`:
```ts
await import("./library-snapshot.test.ts");
```

- [ ] **Step 6: Commit (loader wired, parity pending Task 4)**

```bash
git add src/v2/design-library/library-snapshot.ts tests/v2/library-snapshot.test.ts tests/v2/index.test.ts
git commit -m "feat: add graph-loaded LibrarySnapshot replacing DomainPack aggregate"
```

---

## Task 4: Seed the 7 new kinds + stage template for the software scope

**Files:**
- Modify: `src/v2/design-library/software-library-seed.ts` (add new `SOFTWARE_OBJECTS` entries and edges; import `softwareDomainPack` values as the source of truth so the seed stays in sync with the existing static object until Task 12 deletes it)
- Test: `tests/v2/library-snapshot.test.ts` (from Task 3 — now must go green)

The seed reads from `softwareDomainPack` (still present in `domain-packs/software.ts`) so there is a single source of truth during the transition. After Task 12 deletes `software.ts`, the seed values are inlined (Task 12 step).

- [ ] **Step 1: Add the seed object array builder using `softwareDomainPack`**

At the top of `software-library-seed.ts`, add the import and a helper that turns the domain-pack arrays into `SeedObject[]`:

```ts
import { softwareDomainPack } from "../domain-packs/software.ts";
```

Then, after the existing `SOFTWARE_OBJECTS` array declaration (before `SOFTWARE_EDGES`), append the new objects by spreading domain-pack contents:

```ts
const SOFTWARE_POLICY_OBJECTS: readonly SeedObject[] = [
  ...softwareDomainPack.contextPolicies.map((p) => ({
    objectKey: `context_policy.${p.id}`,
    objectKind: "context_policy" as const,
    state: { ...p },
  })),
  ...softwareDomainPack.sessionPolicies.map((p) => ({
    objectKey: `session_policy.${p.id}`,
    objectKind: "session_policy" as const,
    state: { ...p },
  })),
  ...softwareDomainPack.memoryPolicies.map((p) => ({
    objectKey: `memory_policy.${p.id}`,
    objectKind: "memory_policy" as const,
    state: { ...p },
  })),
  ...softwareDomainPack.workspacePolicies.map((p) => ({
    objectKey: `workspace_policy.${p.id}`,
    objectKind: "workspace_policy" as const,
    state: { ...p },
  })),
  ...softwareDomainPack.stopConditions.map((s) => ({
    objectKey: `stop_condition.${s.id}`,
    objectKind: "stop_condition" as const,
    state: { ...s },
  })),
  ...softwareDomainPack.evaluatorPipelines.map((e) => ({
    objectKey: `evaluator_pipeline.${e.id}`,
    objectKind: "evaluator_pipeline" as const,
    state: { ...e },
  })),
  ...softwareDomainPack.workflowGeneratorPolicies.map((g) => ({
    objectKey: `workflow_generator_policy.${g.id}`,
    objectKind: "workflow_generator_policy" as const,
    state: { ...g },
  })),
  {
    objectKey: "template.software-feature-stages",
    objectKind: "workflow_template",
    state: {
      id: softwareDomainPack.workflowTemplates[0]!.id,
      intentRefs: softwareDomainPack.workflowTemplates[0]!.intentRefs,
      intents: softwareDomainPack.intents,
      stages: softwareDomainPack.workflowTemplates[0]!.stages,
    },
  },
];
```

Then change the seed function to iterate both arrays:

```ts
export async function seedSoftwareLibraryGraph(db: SouthstarDb): Promise<void> {
  for (const object of [...SOFTWARE_OBJECTS, ...SOFTWARE_POLICY_OBJECTS]) {
    await upsertSeedObject(db, object);
  }
  for (const edge of [...SOFTWARE_EDGES, ...SOFTWARE_POLICY_EDGES]) {
    await upsertSeedEdge(db, edge);
  }
}
```

- [ ] **Step 2: Add the policy edges**

Before the seed function, add:

```ts
const SOFTWARE_POLICY_EDGES: readonly SeedEdge[] = [
  ...softwareDomainPack.agentProfiles.flatMap((profile) => [
    { fromObjectKey: `profile.${profile.id}`, edgeType: "uses_context_policy" as const, toObjectKey: `context_policy.${profile.contextPolicyRef}` },
    { fromObjectKey: `profile.${profile.id}`, edgeType: "uses_session_policy" as const, toObjectKey: `session_policy.${profile.sessionPolicyRef}` },
  ]),
  ...softwareDomainPack.contextPolicies.map((c) => ({
    fromObjectKey: `context_policy.${c.id}`,
    edgeType: "uses_memory_policy" as const,
    toObjectKey: `memory_policy.${c.memoryPolicyRef}`,
  })),
  { fromObjectKey: "template.software-feature-stages", edgeType: "uses_workspace_policy" as const, toObjectKey: "workspace_policy.software-git-workspace" },
  { fromObjectKey: "template.software-feature-stages", edgeType: "enforces_generator_policy" as const, toObjectKey: "workflow_generator_policy.software-feature-generator" },
  ...softwareDomainPack.evaluatorPipelines.map((e) => {
    const artifactRef = (e.evaluators[0]?.config as { artifactRef?: string } | undefined)?.artifactRef ?? "implementation_plan";
    return { fromObjectKey: `evaluator_pipeline.${e.id}`, edgeType: "validates_artifact" as const, toObjectKey: `artifact.${artifactRef}` };
  }),
];
```

Note: the `evaluator_pipeline → validates_artifact → artifact.*` edges are derived from the first evaluator's `config.artifactRef`. The existing `evaluator.software-*` (`evaluator_profile`) objects and their edges remain in `SOFTWARE_OBJECTS`/`SOFTWARE_EDGES` untouched (deprecated but not deleted — see spec §8.2).

- [ ] **Step 3: Run the snapshot parity test — must now pass**

Run: `npx tsx tests/v2/library-snapshot.test.ts`
Expected: PASS — all assertions (roles, profiles, artifacts, all 7 policy kinds, stage template with 4 stages and 2 intents).

- [ ] **Step 4: Run the broad v2 suite to confirm no regressions**

Run: `npm run test:v2`
Expected: PASS — the seed is additive (idempotent upsert); existing tests that read `softwareDomainPack` directly are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/v2/design-library/software-library-seed.ts
git commit -m "feat: seed context/session/memory/workspace policies, stop_condition, evaluator_pipeline, workflow_generator_policy, stage template for software scope"
```

---

## Task 5: Repoint `domain-packs/types.ts` imports to `design-library/runtime-types.ts`

**Files (type-only imports — no runtime behavior change):**
- `src/v2/agent-runner/task-envelope.ts:3`
- `src/v2/artifacts/validator-results.ts:1`
- `src/v2/context/types.ts:1`
- `src/v2/manifests/types.ts:1-11`
- `src/v2/orchestration/composition-compiler.ts:5`
- `src/v2/read-models/agent-library.ts:4`
- `src/v2/ui-api/planner-draft-task-overrides.ts:2`

These files import **only types** from `domain-packs/types.ts` (no `DomainPack`, no `softwareDomainPack`). The rewrite is a pure import-path change.

- [ ] **Step 1: Repoint each import**

For each file, replace `from "../domain-packs/types.ts"` (or the correct relative depth) with `from "../design-library/runtime-types.ts"`.

`agent-runner/task-envelope.ts:3`:
```ts
import type { AgentProfile, ArtifactContract, EvaluatorPipelineDefinition, RoleDefinition } from "../design-library/runtime-types.ts";
```

`artifacts/validator-results.ts:1`:
```ts
import type { ArtifactContract } from "../design-library/runtime-types.ts";
```

`context/types.ts:1`:
```ts
import type { BudgetPolicy } from "../design-library/runtime-types.ts";
```

`manifests/types.ts:1-11`:
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
  StopConditionDefinition,
} from "../design-library/runtime-types.ts";
```

`orchestration/composition-compiler.ts:5`:
```ts
import type { AgentProfile, RoleDefinition } from "../design-library/runtime-types.ts";
```

`read-models/agent-library.ts:4`:
```ts
import type { AgentProfile, RoleDefinition } from "../design-library/runtime-types.ts";
```

`ui-api/planner-draft-task-overrides.ts:2`:
```ts
import type { AgentProvider, PlannerDraftTaskProfileOverride } from "../design-library/runtime-types.ts";
```

- [ ] **Step 2: Typecheck the whole v2 tree**

Run: `npx tsx --eval "import './src/v2/manifests/types.ts'"` then `npm run test:v2`
Expected: PASS — all v2 tests green. These are type-only changes; runtime behavior is identical.

- [ ] **Step 3: Commit**

```bash
git add src/v2/agent-runner/task-envelope.ts src/v2/artifacts/validator-results.ts src/v2/context/types.ts src/v2/manifests/types.ts src/v2/orchestration/composition-compiler.ts src/v2/read-models/agent-library.ts src/v2/ui-api/planner-draft-task-overrides.ts
git commit -m "refactor: repoint domain-packs/types type-only imports to design-library/runtime-types"
```

---

## Task 6: Repoint `domain-packs/types.ts` imports that include `DomainPack` (defer the `DomainPack` removal)

**Files (import `DomainPack` — these will be rewritten off `DomainPack` in Tasks 8–12, so for now we make `domain-packs/types.ts` re-export from `runtime-types.ts` to avoid duplication):**
- `src/v2/context/postgres-builder.ts:2`
- `src/v2/context/managed-context-assembler.ts:4`
- `src/v2/ui-api/postgres-task-envelope.ts:4`
- `src/v2/ui-api/postgres-run-api.ts:10`
- `src/v2/workflow-generator/{constrained-generator,validator,materialize}.ts`

- [ ] **Step 1: Make `domain-packs/types.ts` a thin re-export**

Replace the **entire body** of `src/v2/domain-packs/types.ts` with:

```ts
/**
 * Deprecated shim. Types have moved to src/v2/design-library/runtime-types.ts.
 * `DomainPack` remains here only until Tasks 8–12 remove its consumers.
 * This file is deleted in Task 14.
 */
export type {
  AgentProvider,
  AgentProfile,
  ArtifactContract,
  BudgetPolicy,
  ContextPolicyDefinition,
  ContextPolicy,
  EvaluatorPipelineDefinition,
  EvaluatorPipeline,
  EvaluatorStepDefinition,
  IntentDefinition,
  Intent,
  MemoryKind,
  MemoryPolicyDefinition,
  MemoryPolicy,
  PlannerDraftTaskProfileOverride,
  QualityPattern,
  RoleDefinition,
  SessionPolicyDefinition,
  SessionPolicy,
  StopConditionDefinition,
  StopCondition,
  ToolPolicy,
  WorkflowGeneratorPolicyDefinition,
  WorkflowGeneratorPolicy,
  WorkflowStageTemplate,
  WorkspacePolicyDefinition,
  WorkspacePolicy,
} from "../design-library/runtime-types.ts";

export type WorkflowTemplate = {
  id: string;
  intentRefs: string[];
  stages: import("../design-library/runtime-types.ts").WorkflowStageTemplate[];
};

export type DomainPack = {
  id: string;
  version: string;
  displayName: string;
  intents: import("../design-library/runtime-types.ts").IntentDefinition[];
  roles: import("../design-library/runtime-types.ts").RoleDefinition[];
  agentProfiles: import("../design-library/runtime-types.ts").AgentProfile[];
  workflowTemplates: WorkflowTemplate[];
  workflowGeneratorPolicies: import("../design-library/runtime-types.ts").WorkflowGeneratorPolicyDefinition[];
  artifactContracts: import("../design-library/runtime-types.ts").ArtifactContract[];
  evaluatorPipelines: import("../design-library/runtime-types.ts").EvaluatorPipelineDefinition[];
  contextPolicies: import("../design-library/runtime-types.ts").ContextPolicyDefinition[];
  sessionPolicies: import("../design-library/runtime-types.ts").SessionPolicyDefinition[];
  memoryPolicies: import("../design-library/runtime-types.ts").MemoryPolicyDefinition[];
  workspacePolicies: import("../design-library/runtime-types.ts").WorkspacePolicyDefinition[];
  stopConditions: import("../design-library/runtime-types.ts").StopConditionDefinition[];
};
```

This keeps every existing `DomainPack`/`softwareDomainPack` consumer compiling with zero behavior change. The single source of truth for the type bodies is now `runtime-types.ts`.

- [ ] **Step 2: Run the full v2 suite**

Run: `npm run test:v2`
Expected: PASS — re-exports are transparent.

- [ ] **Step 3: Commit**

```bash
git add src/v2/domain-packs/types.ts
git commit -m "refactor: make domain-packs/types a thin re-export shim over runtime-types"
```

---

## Task 7: Repoint `domain-packs/software.ts` imports (still keep the static object — used by seed + consumers until Tasks 8–12)

**Files (import `softwareDomainPack` — no change yet, just confirm the shim works):**
- `src/v2/context/managed-context-assembler.ts:3`
- `src/v2/read-models/agent-library.ts:3`
- `src/v2/read-models/workflow-ui.ts:4`
- `src/v2/ui-api/postgres-run-api.ts:9`
- `src/v2/ui-api/postgres-task-envelope.ts:3`
- `src/v2/evolution/sandbox.ts:6`
- `src/v2/design-library/software-library-seed.ts` (added in Task 4)

These imports stay pointing at `domain-packs/software.ts` for now. `software.ts` still exports `softwareDomainPack` (now typed via the shim). No code change in this task — it is a **verification gate** that the shim from Task 6 did not break the static object.

- [ ] **Step 1: Run the full v2 + postgres suites**

Run: `npm run test:v2 && npm run test:postgres`
Expected: PASS — confirms the seed (Task 4) and all `softwareDomainPack` consumers still work through the shim.

- [ ] **Step 2: Commit (only if any whitespace fixup was needed; otherwise skip)**

If `npm run test:v2` required any tweak to `software.ts` (e.g. a now-redundant import), commit it:
```bash
git add src/v2/domain-packs/software.ts
git commit -m "chore: align software.ts with runtime-types shim"
```
Otherwise no commit — this task is a gate, not a change.

---

## Task 8: Rewrite `managed-context-assembler.ts` to use `LibrarySnapshot`

**Files:**
- Modify: `src/v2/context/managed-context-assembler.ts`
- Modify: `tests/v2/managed-context-assembler.test.ts` (inject snapshot instead of `softwareDomainPack`)
- Modify: `tests/v2/managed-context-scheduler.test.ts`, `tests/v2/managed-runtime-loops.test.ts`, `tests/v2/managed-static-gates.test.ts` (same injection pattern, if they construct the assembler)

- [ ] **Step 1: Update the assembler to accept a `snapshot` option**

In `managed-context-assembler.ts`, replace the `softwareDomainPack` import and the `domainPack` option:

```ts
import type { ArtifactContract } from "../design-library/runtime-types.ts";
import type { LibrarySnapshot } from "../design-library/library-snapshot.ts";
import type { DomainPack } from "../domain-packs/types.ts"; // removed below
```

Remove the `import { softwareDomainPack }` and `import type { ..., DomainPack }` lines. Replace the options + default:

```ts
export type ManagedContextAssemblerOptions = {
  snapshot?: LibrarySnapshot;
};

export function createManagedContextAssembler(db: SouthstarDb, options: ManagedContextAssemblerOptions = {}) {
  let snapshot = options.snapshot;
  return {
    async buildForTask(input: BuildManagedTaskContextInput): Promise<BuildManagedTaskContextResult> {
      const workflow = await readWorkflow(db, input.runId);
      if (!snapshot) {
        snapshot = await loadLibrarySnapshot(db, [workflow.domain ?? "software"]);
      }
      // ... rest unchanged, but every `domainPack.X` becomes `snapshot.X`
```

Add `import { loadLibrarySnapshot } from "../design-library/library-snapshot.ts";`.

Inside `buildForTask`, replace:
- `domainPack.evaluatorPipelines.find(...)` → `snapshot.evaluatorPipelines.find(...)`
- `artifactContractsForTask(domainPack, task)` → `artifactContractsForTask(snapshot, task)`
- `domainPack.contextPolicies.find(...)` → `snapshot.contextPolicies.find(...)`
- `domainPack.memoryPolicies.find(...)` → `snapshot.memoryPolicies.find(...)`

`artifactContractsForTask`'s signature changes `(domainPack: DomainPack, ...)` → `(snapshot: LibrarySnapshot, ...)`, and its body reads `snapshot.artifactContracts`.

- [ ] **Step 2: Update the test to inject a snapshot**

In `tests/v2/managed-context-assembler.test.ts`, replace `softwareDomainPack` import + injection with a snapshot loaded from the seeded graph. At the top of each test, before constructing the assembler:

```ts
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { loadLibrarySnapshot } from "../../src/v2/design-library/library-snapshot.ts";
// ...
await seedSoftwareLibraryGraph(db);
const snapshot = await loadLibrarySnapshot(db, ["software"]);
const assembler = createManagedContextAssembler(db, { snapshot });
```

Remove the `import { softwareDomainPack }` line. For assertions that read `softwareDomainPack.roles.find(...)` / `softwareDomainPack.agentProfiles.find(...)` to build a manifest, read from `snapshot.roles` / `snapshot.agentProfiles` instead.

- [ ] **Step 3: Run the assembler test**

Run: `npx tsx tests/v2/managed-context-assembler.test.ts`
Expected: PASS.

- [ ] **Step 4: Update sibling managed tests**

In `managed-context-scheduler.test.ts`, `managed-runtime-loops.test.ts`, `managed-static-gates.test.ts`: same `seedSoftwareLibraryGraph` + `loadLibrarySnapshot` injection wherever `createManagedContextAssembler(db, { domainPack: softwareDomainPack })` appears. Grep: `rg -n "domainPack: softwareDomainPack" tests/v2`.

- [ ] **Step 5: Run the broad v2 suite**

Run: `npm run test:v2`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/context/managed-context-assembler.ts tests/v2/managed-context-assembler.test.ts tests/v2/managed-context-scheduler.test.ts tests/v2/managed-runtime-loops.test.ts tests/v2/managed-static-gates.test.ts
git commit -m "refactor: managed-context-assembler reads from LibrarySnapshot instead of softwareDomainPack"
```

---

## Task 9: Rewrite `ui-api/postgres-task-envelope.ts` and `postgres-run-api.ts` to use `LibrarySnapshot`

**Files:**
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `tests/v2/postgres-task-envelope.test.ts`, `tests/v2/postgres-run-api.test.ts`

- [ ] **Step 1: Rewrite `postgres-task-envelope.ts`**

Remove `import { softwareDomainPack }` and `import type { ..., DomainPack }`. Add:
```ts
import { loadLibrarySnapshot, type LibrarySnapshot } from "../design-library/library-snapshot.ts";
```

Wherever `softwareDomainPack.evaluatorPipelines.find(...)` / `softwareDomainPack.artifactContracts.find(...)` is used, load the snapshot once at the top of the function and read from it:
```ts
const snapshot = await loadLibrarySnapshot(db, [workflow.domain ?? "software"]);
const evaluatorPipeline = required(snapshot.evaluatorPipelines.find((c) => c.id === task.evaluatorPipelineRef), `missing evaluator pipeline ${task.evaluatorPipelineRef}`);
```

The `evaluatorPipelines: workflow.evaluatorPipelines ?? softwareDomainPack.evaluatorPipelines` fallback becomes `workflow.evaluatorPipelines ?? snapshot.evaluatorPipelines`.

- [ ] **Step 2: Rewrite `postgres-run-api.ts`**

Remove `domainPackForWorkflow` (the `workflow.* ?? softwareDomainPack.*` fallback). Replace with a snapshot loader:
```ts
async function librarySnapshotForWorkflow(db: SouthstarDb, workflow: SouthstarWorkflowManifest): Promise<LibrarySnapshot> {
  const scopes = workflow.libraryScopes ?? [workflow.domain ?? "software"];
  return loadLibrarySnapshot(db, scopes);
}
```

`materializeWorkflowTaskProfileOverrides`'s `softwareDomainPack.agentProfiles` fallback → `snapshot.agentProfiles` (load the snapshot once at the top of the caller and pass it in, or load inside — prefer loading once per request).

Add `libraryScopes?: string[]` to the manifest type (Task 10 touches `manifests/types.ts` for this; if Task 10 hasn't landed, add it here).

- [ ] **Step 3: Update the tests**

`tests/v2/postgres-task-envelope.test.ts` and `tests/v2/postgres-run-api.test.ts`: wherever they construct a workflow and expect `softwareDomainPack.*` fallbacks, seed the library and assert the snapshot-backed values. These tests already use `createTestPostgresDb`; add `await seedSoftwareLibraryGraph(db)` in setup.

- [ ] **Step 4: Run the postgres + v2 suites**

Run: `npm run test:postgres && npm run test:v2`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/v2/ui-api/postgres-task-envelope.ts src/v2/ui-api/postgres-run-api.ts tests/v2/postgres-task-envelope.test.ts tests/v2/postgres-run-api.test.ts
git commit -m "refactor: postgres task-envelope and run-api read from LibrarySnapshot"
```

---

## Task 10: Rewrite read-models (`agent-library.ts`, `workflow-ui.ts`) and remove the `domain !== "software"` throw

**Files:**
- Modify: `src/v2/read-models/agent-library.ts`
- Modify: `src/v2/read-models/workflow-ui.ts`
- Modify: `src/v2/manifests/types.ts` (add `libraryScopes?: string[]`, `libraryRef?`)
- Modify: `tests/v2/library-candidate-resolver.test.ts` (if it asserts the throw — remove that assertion)
- Modify: `web/` only if `getUiDomainPacks` / `DomainPacksAgentStudioPage` break (Task 14 handles removal)

- [ ] **Step 1: Add `libraryScopes` and `libraryRef` to the manifest type**

In `src/v2/manifests/types.ts`, inside `SouthstarWorkflowManifest`, add after `domain?: string;`:
```ts
  libraryScopes?: string[];
  /** Replaces domainPackRef for new runs. Old runs still carry domainPackRef. */
  libraryRef?: { scopes: string[]; versionHash: string };
```
And widen `WorkflowTaskDefinition.domain` from the literal union to `string`:
```ts
  domain: string;
```

- [ ] **Step 2: Rewrite `agent-library.ts`**

Remove `import { softwareDomainPack }` and `import type { ..., RoleDefinition } from "../domain-packs/types"`. Add:
```ts
import type { AgentProfile, RoleDefinition } from "../design-library/runtime-types.ts";
import { loadLibrarySnapshot, type LibrarySnapshot } from "../design-library/library-snapshot.ts";
```

`buildAgentLibraryReadModelPg` becomes: load snapshot for `[domain]`, project from it. Delete `buildDomainLibrary`'s `if (domain !== "software") throw` and its hardcoded `softwareDomainPack` reads — replace with snapshot fields:
```ts
const snapshot = await loadLibrarySnapshot(db, [domain]);
return {
  domain,
  roles: snapshot.roles,
  agentProfiles: snapshot.agentProfiles,
  skills: uniqueRefRows(snapshot.agentProfiles, (p) => p.skillRefs),
  mcpServers: uniqueRefRows(snapshot.agentProfiles, (p) => p.mcpGrantRefs),
  tools: uniqueRefRows(snapshot.agentProfiles, (p) => p.toolPolicy.allowedTools),
  artifactContracts: snapshot.artifactContracts,
  evaluatorPipelines: snapshot.evaluatorPipelines,
  contextPolicies: snapshot.contextPolicies,
  sessionPolicies: snapshot.sessionPolicies,
  memoryPolicies: snapshot.memoryPolicies,
  workspacePolicies: snapshot.workspacePolicies,
  vaultLeasePolicies: softwareVaultLeasePolicies, // unchanged — still a seed export
};
```

`buildAgentLibraryCandidatesReadModelPg`'s `buildDomainLibrary(domain)` call → `await loadLibrarySnapshot(db, [domain])`, and the `library` variable becomes a `LibrarySnapshot`.

- [ ] **Step 3: Rewrite `workflow-ui.ts`**

Remove `import { softwareDomainPack }`. Add a snapshot parameter to the read-model builders that currently read `softwareDomainPack.*` directly. Because read-model builders are called per-request, load the snapshot once at the entry of `buildWorkflowUiReadModel` / the relevant route and pass it down, OR load lazily. Concretely:
- `agentLibrarySummary(domain)` → takes a `snapshot: LibrarySnapshot` arg; counts `snapshot.roles.length` etc.
- `resolveWorkflowTaskDetail` → takes `snapshot`; reads `snapshot.roles.find/agentProfiles.find/artifactContracts.find/evaluatorPipelines.find/contextPolicies.find`.
- `evaluatorPipelineForArtifact` → takes `snapshot`; scans `snapshot.evaluatorPipelines`.

Update each call site within `workflow-ui.ts` to thread the snapshot through (load it once at the top of the public entry function with `await loadLibrarySnapshot(db, [workflow.domain ?? "software"])`).

- [ ] **Step 4: Run read-model + postgres tests**

Run: `npm run test:postgres && npm run test:v2`
Expected: PASS. Specifically `/api/v2/agent-library?domain=research` no longer throws (returns empty snapshot for an unseeded scope).

- [ ] **Step 5: Commit**

```bash
git add src/v2/manifests/types.ts src/v2/read-models/agent-library.ts src/v2/read-models/workflow-ui.ts tests/v2/library-candidate-resolver.test.ts
git commit -m "refactor: read-models load from LibrarySnapshot; remove software-only domain guard; add libraryScopes/libraryRef to manifest"
```

---

## Task 11: Rewrite `evolution/sandbox.ts` to use `LibrarySnapshot`

**Files:**
- Modify: `src/v2/evolution/sandbox.ts`
- Modify: `tests/v2/evolution-context-builder-postgres.test.ts`

- [ ] **Step 1: Replace the `softwareDomainPack` usage**

In `evolution/sandbox.ts:6`, remove `import { softwareDomainPack }`. At `sandbox.ts:161` where `domainPack: softwareDomainPack` is passed, load the snapshot instead:
```ts
const snapshot = await loadLibrarySnapshot(db, ["software"]);
// ... pass snapshot where domainPack was passed
```
The downstream consumer (`evolution/context-cards.ts`'s `matchesOptional(appliesTo.intents, [input.intent])`) reads intents — point it at `snapshot.workflowTemplates.flatMap(t => t.intents)`.

- [ ] **Step 2: Update the test**

`tests/v2/evolution-context-builder-postgres.test.ts`: seed the library and assert the snapshot-backed intents/policies.

- [ ] **Step 3: Run**

Run: `npx tsx tests/v2/evolution-context-builder-postgres.test.ts && npm run test:v2`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/v2/evolution/sandbox.ts tests/v2/evolution-context-builder-postgres.test.ts
git commit -m "refactor: evolution sandbox reads from LibrarySnapshot"
```

---

## Task 12: Rewrite the `workflow-generator` trio (`constrained-generator`, `validator`, `materialize`) to take `LibrarySnapshot`

**Files:**
- Modify: `src/v2/workflow-generator/constrained-generator.ts`
- Modify: `src/v2/workflow-generator/validator.ts`
- Modify: `src/v2/workflow-generator/materialize.ts`
- Modify: `src/v2/workflow-generator/types.ts` (`domainPackRef` → `libraryRef`)
- Modify: `tests/v2/domain-pack.test.ts`, `tests/v2/effort-policy.test.ts` (and any test that calls `generateConstrainedWorkflowPlan` / `materializeGenerationPlan`)

- [ ] **Step 1: Update `types.ts` — rename `domainPackRef` to `libraryRef`**

In `src/v2/workflow-generator/types.ts`, change `WorkflowGenerationPlan`:
```ts
export type WorkflowGenerationPlan = {
  id: string;
  runId: string;
  libraryRef: { scopes: string[]; versionHash: string };
  intentRef: string;
  templateRef: string;
  generatorPolicyRef: string;
  // ... rest unchanged
};
```
Remove the `domainPackRef: { id: string; version: string; contentHash: string }` field.

- [ ] **Step 2: Rewrite `constrained-generator.ts`**

Change the input type and the body:
```ts
import { createHash } from "node:crypto";
import type { LibrarySnapshot } from "../design-library/library-snapshot.ts";
import type { EffortPolicy } from "../manifests/types.ts";
import type { GeneratedTaskPlan, WorkflowGenerationPlan } from "./types.ts";
import { validateWorkflowGenerationPlan } from "./validator.ts";

export type GenerateConstrainedWorkflowPlanInput = {
  runId: string;
  goalPrompt: string;
  snapshot: LibrarySnapshot;
  intentId: string;
};

export function generateConstrainedWorkflowPlan(input: GenerateConstrainedWorkflowPlanInput): WorkflowGenerationPlan {
  const intent = required(
    input.snapshot.workflowTemplates.flatMap((t) => t.intents).find((i) => i.id === input.intentId),
    `unknown intent ${input.intentId}`,
  );
  const template = required(
    input.snapshot.workflowTemplates.find((t) => t.id === intent.workflowTemplateRef),
    `unknown template ${intent.workflowTemplateRef}`,
  );
  const policy = required(
    input.snapshot.workflowGeneratorPolicies.find(
      (g) => g.intentRefs.includes(intent.id) && g.templateRefs.includes(template.id),
    ),
    `no generator policy for intent ${intent.id}`,
  );
  // ... broad/narrow task generation unchanged ...
  const plan: WorkflowGenerationPlan = {
    id: `gen-${input.runId}-${hash(input.goalPrompt).slice(0, 10)}`,
    runId: input.runId,
    libraryRef: {
      scopes: input.snapshot.scopes,
      versionHash: hash(JSON.stringify(input.snapshot)),
    },
    intentRef: intent.id,
    templateRef: template.id,
    generatorPolicyRef: policy.id,
    // ... rest unchanged ...
  };
  const validation = validateWorkflowGenerationPlan(input.snapshot, plan);
  // ...
}
```

- [ ] **Step 3: Rewrite `validator.ts`**

Change signature `(domainPack: DomainPack, plan)` → `(snapshot: LibrarySnapshot, plan)`. Replace `domainPack.workflowGeneratorPolicies.find(...)` with `snapshot.workflowGeneratorPolicies.find(...)`. All other checks (`allowedRoleRefs`, `allowedAgentProfileRefs`, `allowedEvaluatorPipelineRefs`, `allowedArtifactContractRefs`, `maxTasks`, etc.) are unchanged — they read off the policy object, which now comes from the snapshot.

- [ ] **Step 4: Rewrite `materialize.ts`**

Change input `domainPack: DomainPack` → `snapshot: LibrarySnapshot`. Replace every `input.domainPack.X` with `input.snapshot.X` (roles, agentProfiles, artifactContracts, evaluatorPipelines, contextPolicies, sessionPolicies, memoryPolicies, workspacePolicies). The `input.domainPack.workflowTemplates.flatMap(template => template.stages).find(stage => stage.roleRef === task.roleRef)?.workspacePolicyRef` lookup becomes `input.snapshot.workflowTemplates.flatMap(t => t.stages).find(s => s.roleRef === task.roleRef)?.workspacePolicyRef` — identical shape, the stage template's `stages` are in the snapshot.

`domain: input.domainPack.id as WorkflowTaskDefinition["domain"]` → `domain: input.snapshot.scopes[0] ?? "software"`.
`domainPackRef: input.plan.domainPackRef` → `libraryRef: input.plan.libraryRef`.

- [ ] **Step 5: Update the tests**

`tests/v2/domain-pack.test.ts` and `tests/v2/effort-policy.test.ts`: replace `generateConstrainedWorkflowPlan({ runId, goalPrompt, domainPack: softwareDomainPack, intentId })` with `generateConstrainedWorkflowPlan({ runId, goalPrompt, snapshot, intentId })` where `snapshot = await loadLibrarySnapshot(db, ["software"])` (after seeding). Same for `materializeGenerationPlan({ plan, domainPack: softwareDomainPack, goalPrompt })` → `materializeGenerationPlan({ plan, snapshot, goalPrompt })`. Rename any assertion on `plan.domainPackRef` to `plan.libraryRef`.

- [ ] **Step 6: Run the v2 suite**

Run: `npm run test:v2`
Expected: PASS — generated plans/manifests are byte-equivalent modulo the `domainPackRef` → `libraryRef` rename.

- [ ] **Step 7: Commit**

```bash
git add src/v2/workflow-generator/constrained-generator.ts src/v2/workflow-generator/validator.ts src/v2/workflow-generator/materialize.ts src/v2/workflow-generator/types.ts tests/v2/domain-pack.test.ts tests/v2/effort-policy.test.ts
git commit -m "refactor: workflow-generator trio takes LibrarySnapshot; rename domainPackRef to libraryRef"
```

---

## Task 13: Widen `candidate-resolver.ts` to `scopes: string[]` and add a cross-domain test

**Files:**
- Modify: `src/v2/orchestration/candidate-resolver.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts` (forward `scopes`)
- Modify: `tests/v2/library-candidate-resolver.test.ts`

- [ ] **Step 1: Change the input type and scope handling**

In `candidate-resolver.ts`:
```ts
export type ResolveWorkflowCandidatesInput = {
  requirementSpec: RequirementSpecV2;
  scopes: string[];   // was: scope: string
};
```

In `resolveWorkflowCandidates`, compute the scope to pass to the graph store:
```ts
const scope = input.scopes.length === 1 ? input.scopes[0]! : undefined;
```
Then pass `scope` (which is `undefined` for multi-scope, meaning "all approved") to every `findApprovedLibraryObjectsByKind(db, kind, scope)` and `findLibraryEdgesTo/From(ref, edgeType, { scope })` call. The graph store already treats `scope = null/undefined` as "all approved". For the multi-scope case, after fetching, filter results to `input.scopes` membership in TypeScript:
```ts
const scopeSet = new Set(input.scopes);
const inScopes = (obj: LibraryObjectSummary) => scopeSet.size === 0 || scopeSet.has(String(obj.state.scope ?? ""));
```
Apply `inScopes` to the `workflowTemplateCandidates`, `policyConstraints`, and the per-capability agent candidate lists.

- [ ] **Step 2: Forward `scopes` from the compiler**

In `composition-compiler.ts`, change `scope = input.scope ?? "software"` to accept `scopes`:
```ts
export type CompileWorkflowCompositionInput = {
  runId: string;
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  composition: WorkflowCompositionPlan;
  scopes?: string[];
};
// ...
const scopes = input.scopes ?? ["software"];
const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, input.composition, { scopes });
```
Update `composition-validator.ts`'s options type from `{ scope?: string }` to `{ scopes?: string[] }` and forward accordingly (it calls `findApprovedLibraryObjectsByKind` / edges with the same single-or-undefined scope logic).

- [ ] **Step 3: Add a cross-domain candidate test**

Append to `tests/v2/library-candidate-resolver.test.ts`:
```ts
test("resolveWorkflowCandidates returns candidates from multiple scopes", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    // seed a minimal research-scope agent + capability
    await upsertLibraryObject(db, {
      objectKey: "agent.research-scout",
      objectKind: "agent_definition",
      status: "approved",
      headVersionId: "agent.research-scout@v1",
      state: { scope: "research", role: "scout", runtimeRole: { id: "scout", responsibility: "x", defaultAgentProfileRef: "p", allowedAgentProfileRefs: ["p"], artifactInputs: [], artifactOutputs: [], stopAuthority: "none" } },
    });
    await upsertLibraryObject(db, {
      objectKey: "capability.literature-search",
      objectKind: "capability_spec",
      status: "approved",
      headVersionId: "capability.literature-search@v1",
      state: { scope: "research", capabilityType: "tool_capability", grants: [] },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "agent.research-scout",
      edgeType: "provides_capability",
      toObjectKey: "capability.literature-search",
      scope: "research",
      status: "active",
      weight: 1,
      metadata: {},
    });
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: {
        summary: "mix",
        workType: "research",
        requiredCapabilities: ["capability.literature-search", "capability.repo-read"],
        expectedArtifacts: [],
        acceptanceCriteria: [],
        nonGoals: [],
        riskNotes: [],
        workspaceAssumptions: [],
        missingInputs: [],
      },
      scopes: ["software", "research"],
    });
    const scoutAgents = packet.agentCandidatesByCapability["capability.literature-search"] ?? [];
    assert.ok(scoutAgents.some((a) => a.ref === "agent.research-scout"), "research scout present");
    const repoReadAgents = packet.agentCandidatesByCapability["capability.repo-read"] ?? [];
    assert.ok(repoReadAgents.length > 0, "software repo-read agents present");
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 4: Run the resolver test and the v2 suite**

Run: `npx tsx tests/v2/library-candidate-resolver.test.ts && npm run test:v2`
Expected: PASS — the new cross-domain case returns candidates from both scopes; existing single-scope cases still pass (they pass `scopes: ["software"]`).

- [ ] **Step 5: Commit**

```bash
git add src/v2/orchestration/candidate-resolver.ts src/v2/orchestration/composition-compiler.ts src/v2/orchestration/composition-validator.ts tests/v2/library-candidate-resolver.test.ts
git commit -m "feat: candidate-resolver accepts scopes:string[] for cross-domain selection"
```

---

## Task 14: Delete `src/v2/domain-packs/` and the domain-pack UI surface — the gate

**Files:**
- Delete: `src/v2/domain-packs/types.ts`, `src/v2/domain-packs/software.ts`, `src/v2/domain-packs/registry.ts`
- Create: `src/v2/design-library/domain-router.ts` (replaces `registry.ts` routing)
- Modify: `src/v2/design-library/software-library-seed.ts` (inline the seed values that came from `softwareDomainPack`)
- Delete/Modify: `components/southstar/pages/DomainPacksAgentStudioPage.tsx`, `lib/southstar/api-client.ts` (`getUiDomainPacks`)
- Modify: any test still importing `domain-packs/*` (`tests/v2/domain-pack.test.ts` may rename to `workflow-generator.test.ts`)

- [ ] **Step 1: Move prompt routing into `design-library/domain-router.ts`**

Create `src/v2/design-library/domain-router.ts` reproducing `domain-packs/registry.ts`'s `routeByPrompt`/`routeIntent` logic but over `LibrarySnapshot`:
```ts
import type { LibrarySnapshot } from "./library-snapshot.ts";
import type { IntentDefinition } from "./runtime-types.ts";

export type DomainRouteInput = { goalPrompt: string; scopes?: string[] };
export type DomainRouteResult = { scopes: string[]; intent: IntentDefinition; templateRef: string };

export function routeGoal(snapshot: LibrarySnapshot, input: DomainRouteInput): DomainRouteResult {
  const normalized = input.goalPrompt.toLowerCase();
  for (const template of snapshot.workflowTemplates) {
    for (const intent of template.intents) {
      if (intent.examples.some((ex) => normalized.includes(ex.toLowerCase()))) {
        return { scopes: snapshot.scopes, intent, templateRef: template.id };
      }
    }
  }
  // fallback: first intent of first template
  const firstTemplate = snapshot.workflowTemplates[0];
  const firstIntent = firstTemplate?.intents[0];
  if (!firstTemplate || !firstIntent) throw new Error("no workflow template/intent in snapshot");
  return { scopes: snapshot.scopes, intent: firstIntent, templateRef: firstTemplate.id };
}
```

Update any caller of `createDomainPackRegistry(...).route(...)` to load a snapshot for the candidate scopes and call `routeGoal(snapshot, { goalPrompt })`.

- [ ] **Step 2: Inline the seed values (stop importing `softwareDomainPack`)**

In `software-library-seed.ts`, remove `import { softwareDomainPack }`. Replace `SOFTWARE_POLICY_OBJECTS`/`SOFTWARE_POLICY_EDGES` (Task 4) with inlined literal arrays copied from the domain-pack contents (the exact values captured in the Task 4 code blocks — context/session/memory/workspace policies, stop_conditions, evaluator_pipelines, generator policy, stage template). This makes the seed self-contained.

- [ ] **Step 3: Delete the domain-packs directory**

```bash
git rm src/v2/domain-packs/types.ts src/v2/domain-packs/software.ts src/v2/domain-packs/registry.ts
```
If the directory is now empty, `rmdir src/v2/domain-packs`.

- [ ] **Step 4: Repoint or remove the domain-pack UI**

`components/southstar/pages/DomainPacksAgentStudioPage.tsx` and `lib/southstar/api-client.ts`'s `getUiDomainPacks`: replace the page with a `LibrarySnapshotStudioPage` that calls a new `/api/v2/library-snapshot?scopes=software` endpoint (or simply remove the page and route if it is non-critical). If repointing, add a route in `src/v2/server/routes.ts` returning `await loadLibrarySnapshot(db, scopes)`. Grep `rg -n "DomainPacksAgentStudioPage|getUiDomainPacks" src/ web/ components/` and update each call site.

- [ ] **Step 5: Rename/fix tests that imported domain-packs**

`tests/v2/domain-pack.test.ts`: if it still imports `domain-packs/*`, repoint to `design-library/runtime-types` + `library-snapshot` + `workflow-generator`. Optionally rename to `tests/v2/workflow-generation.test.ts`. Update `tests/v2/index.test.ts`'s import line if renamed.

- [ ] **Step 6: Verify the deletion gate**

Run all three gates:
```bash
rg "domain-packs" src/ web/ components/ || echo "OK: no src/web/components references"
npm run test:v2
npm run test:postgres
npm --prefix web run build
```
Expected: `rg` returns only `docs/` historical references; `test:v2` PASS; `test:postgres` PASS; `web build` PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete src/v2/domain-packs; design library is the sole library source

Moves prompt routing to design-library/domain-router, inlines the software
seed, removes the DomainPacksAgentStudioPage surface, and repoints the
remaining tests. The design library graph is now the single source of
truth for roles, profiles, policies, evaluator pipelines, generator
policies, and stage templates. domain-packs/ no longer exists."
```

---

## Self-Review (run before declaring the plan done)

**Spec coverage check** — map each spec section to a task:
- §3.1 new kinds → Task 2
- §3.2 new edges → Task 2 (kinds) + Task 4 (edges seeded)
- §3.3 payload types → Task 1 (`runtime-types.ts` reuses the same shapes; full schema-versioned payloads are deferred — the seed stores the plain objects, which is sufficient since the graph is the source of truth)
- §3.4 domain as scope → Task 13 (`scopes: string[]`)
- §3.5 two template notions → Task 4 (`template.software-feature-stages` distinct from `template.software-feature`)
- §4 type relocation → Tasks 1, 5, 6, 7
- §5 `LibrarySnapshot` → Task 3
- §6 consumer rewrites → Tasks 8, 9, 10, 11
- §7 workflow-generator rewrite → Task 12
- §8 seed rewrite → Task 4
- §9 manifest compat (`libraryScopes`, `libraryRef`, `domain: string`) → Task 10
- §10 removal → Task 14
- §11 UI surface → Task 14
- §12 testing → embedded in each task + the cross-domain test in Task 13
- §14 acceptance criteria → Task 14 Step 6 is the gate that checks all of them

**Gap note:** §3.3 mentions schema-versioned payloads (`southstar.library.context_policy.v1` etc.). This plan stores the plain typed objects in `state` without a `schemaVersion` wrapper, matching how the existing seed stores skills/templates (no wrapper). If schema-versioned payloads are required, that is a follow-up; it is not needed for behavior parity or cross-domain selection. Flagged here so the engineer does not assume it was forgotten.

**Type consistency check:** `LibrarySnapshot.workflowTemplates` uses `WorkflowTemplateSnapshot` (defined in Task 3) with `.intents: IntentDefinition[]` and `.stages: WorkflowStageSnapshot[]`. Task 12's `constrained-generator` reads `snapshot.workflowTemplates.flatMap(t => t.intents)` and `snapshot.workflowTemplates.find(t => t.id === intent.workflowTemplateRef)` then `template.stages` — matches. Task 4 seeds `state.intents = softwareDomainPack.intents` and `state.stages = softwareDomainPack.workflowTemplates[0].stages` — `mapTemplate` in Task 3 reads `state.intents` and `state.stages` — matches.

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". Every code step contains the actual code.

---

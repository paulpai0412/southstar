# Southstar: Consolidate Domain Packs into the Design Library

**Date:** 2026-07-02
**Status:** Draft (pending user review)
**Goal:** Move every load-bearing concept currently owned by `src/v2/domain-packs/` into the Postgres-backed design library (`src/v2/design-library/`), then delete `src/v2/domain-packs/` entirely. Enable cross-domain agent/policy selection as the default operating mode for future work.

---

## 1. Problem

Southstar currently has **two parallel library systems** that do not align:

| System | Source of truth | Selected by |
|---|---|---|
| **Domain packs** (`src/v2/domain-packs/`) | Static TypeScript objects (`softwareDomainPack`) | Runtime context assembly, run materialization, UI read models, workflow generation, evolution sandbox |
| **Design library** (`src/v2/design-library/`) | Postgres `southstar.library_objects` + `library_edges` | Candidate resolution, composition validation, compilation (the "library-constrained" orchestration path) |

The split is load-bearing and broken in concrete ways:

1. **The design library has no first-class model for domain-pack concepts.** It lacks `intent`, `context_policy`, `session_policy`, `memory_policy`, `workspace_policy`, `stop_condition`, `evaluator_pipeline` (full), and `workflow_generator_policy`. Its `evaluator_profile` kind stores only `{ stage, requiredArtifact }` — far weaker than domain pack's `EvaluatorPipelineDefinition` (multi-step `evaluators[]` with `kind`/`config`/`required` + `onFailure` strategy).
2. **Runtime reads from the static object, not the graph.** `managed-context-assembler.ts:44` does `domainPack = options.domainPack ?? softwareDomainPack`; evaluator pipelines, context policies, and memory policies are looked up on that static object even though the planner selected candidates from the graph.
3. **The UI read model hard-codes a single domain.** `agent-library.ts:144` throws `unsupported domain pack for agent library: ${domain}` for anything other than `software`, and `workflow-ui.ts` reads `softwareDomainPack.*` directly.
4. **Type definitions are owned by the doomed module.** `domain-packs/types.ts` defines `AgentProfile`, `RoleDefinition`, `ArtifactContract`, `EvaluatorPipelineDefinition`, `ContextPolicyDefinition`, `SessionPolicyDefinition`, `MemoryPolicyDefinition`, `WorkspacePolicyDefinition`, `StopConditionDefinition`, `IntentDefinition`, `WorkflowGeneratorPolicyDefinition`, `AgentProvider`, `BudgetPolicy`, `ToolPolicy`. These are imported across **14 non-test source files** spanning `agent-runner`, `artifacts`, `context`, `manifests`, `orchestration`, `read-models`, `ui-api`, and `workflow-generator`. Deleting `domain-packs/` without relocating these types breaks the build.

The user's forward direction — importing agents from `agency-agents-zh` (266 personas across 20 categories) and building workflows that mix agents from multiple domains — is blocked until this consolidation is done.

---

## 2. Design Decisions (already agreed)

These were settled in brainstorming and are inputs to this spec:

1. **Cross-domain mixed workflows are the expected default**, not an edge case. Therefore policies must remain individually selectable and uniformly addressable, exactly like agents.
2. **Rejected: Option 2** (a single first-class `domain` object that bundles all policies/intents into its `state`). Bundling policies into a domain object makes the thing that should stay symmetric-and-selectable (policies) into a non-uniform access path, and forces a "which domain's policy governs this task?" rule on every cross-domain workflow.
3. **Chosen: Option 1 + intent folded into `workflow_template`.** Every domain-pack concept that is not `intent` becomes its own `LibraryDefinitionKind`, each carrying a `scope` tag so it can be selected across domains exactly like agents. `intent` is folded into `workflow_template.state.intents[]` because it is strongly coupled to a single template (`IntentDefinition.workflowTemplateRef` is singular and always populated; the existing `intentRefs` array already supports many intents per template).

### Why each concept lands where it does

| Concept | New kind? | Rationale |
|---|---|---|
| `intent` | No — folded into `workflow_template.state.intents[]` | `intent.workflowTemplateRef` is 1:1 to a template; intent has no meaning detached from its template. `workflowTemplate.intentRefs` already exists as an array. Folding loses zero information and removes one kind. |
| `context_policy` | Yes | Reusable across domains; a research task may legitimately reuse a software context policy. Symmetric with agent selection. |
| `session_policy` | Yes | Same reasoning; checkpoint/fork policy is domain-orthogonal. |
| `memory_policy` | Yes | Scope set + ranking weights are reusable across domains. |
| `workspace_policy` | Yes | Git snapshot/fork/rollback policy is domain-orthogonal. |
| `stop_condition` | Yes | Referenced by template stages; independently versionable and reusable. |
| `evaluator_pipeline` | Yes (replaces `evaluator_profile`) | Domain pack's `EvaluatorPipelineDefinition` has `evaluators[]` (multi-step, typed `kind`) + `onFailure` strategy. The current `evaluator_profile` kind (`{ stage, requiredArtifact }`) is too weak and must be superseded. |
| `workflow_generator_policy` | Yes | Its `allowedRoleRefs`/`allowedAgentProfileRefs`/`allowedEvaluatorPipelineRefs`/`allowedArtifactContractRefs` are domain-level allowed-lists spanning multiple templates and tasks. Folding into a template (Option 3) would duplicate it across templates and re-introduce Option 2's "which template's policy governs?" problem. It must stay independent. |
| `role` | No — stays in `agent_definition.state.role` | Already modeled there; runtime role is an attribute of an agent, not an independent selectable. No change. |

---

## 3. Target Architecture

### 3.1 New `LibraryDefinitionKind` values

Add to `design-library/types.ts`:

```ts
export type LibraryDefinitionKind =
  | "agent_spec"
  | "agent_definition"
  | "agent_profile"
  | "skill_definition"
  | "skill_spec"
  | "mcp_tool_grant"
  | "artifact_contract"
  | "evaluator_pipeline"        // NEW (supersedes evaluator_profile)
  | "capability_spec"
  | "contract_spec"
  | "validator_spec"
  | "policy_bundle"
  | "workflow_template"
  | "workflow_recipe"
  | "tool_definition"
  | "instruction_template"
  | "vault_lease_policy"
  | "context_policy"            // NEW
  | "session_policy"            // NEW
  | "memory_policy"             // NEW
  | "workspace_policy"          // NEW
  | "stop_condition"            // NEW
  | "workflow_generator_policy" // NEW
  | "evaluator_profile";        // DEPRECATED — keep for migration read; stop seeding
```

`evaluator_profile` is retained only so existing rows can be read during migration; it is no longer seeded and no consumer reads it after migration.

### 3.2 New `LibraryEdgeType` values

Add edges so the graph can express the relationships `managed-context-assembler`, `materialize`, `constrained-generator`, and `validator` currently resolve by scanning domain-pack arrays:

```ts
| "uses_context_policy"
| "uses_session_policy"
| "uses_memory_policy"
| "uses_workspace_policy"
| "enforces_generator_policy"   // workflow_template -> workflow_generator_policy
```

Existing edges that already cover relationships (`implements`, `supports_skill`, `allows_tool`, `allows_mcp_grant`, `uses_instruction`, `requires_secret_group`, `produces_artifact`, `consumes_artifact`, `validates_artifact`, `provides_capability`, `requires_capability`, `part_of_template`) are reused unchanged.

No `checked_by_stop_condition` edge is added in this consolidation. Stop conditions remain referenced from the stage-template state's `stages[].stopConditionRefs`. A future graph-indexing pass can add stop-condition edges if the operator UI needs reverse lookup by stop condition.

### 3.3 New payload types in `design-library/types.ts`

Relocate and promote the domain-pack type definitions into design-library as versioned payloads (mirroring the existing `SkillSpecPayload` / `WorkflowTemplatePayload` pattern):

- `ContextPolicyPayload` (schema `southstar.library.context_policy.v1`)
- `SessionPolicyPayload` (schema `southstar.library.session_policy.v1`)
- `MemoryPolicyPayload` (schema `southstar.library.memory_policy.v1`)
- `WorkspacePolicyPayload` (schema `southstar.library.workspace_policy.v1`)
- `StopConditionPayload` (schema `southstar.library.stop_condition.v1`)
- `EvaluatorPipelinePayload` (schema `southstar.library.evaluator_pipeline.v1`) — full `evaluators[]` + `onFailure`, supersedes the weak `evaluator_profile` shape
- `WorkflowGeneratorPolicyPayload` (schema `southstar.library.workflow_generator_policy.v1`) — `intentRefs`, `templateRefs`, `allowedRoleRefs`, `allowedAgentProfileRefs`, `allowedEvaluatorPipelineRefs`, `allowedArtifactContractRefs`, budget caps, `qualityPatterns`

The shared value types currently in `domain-packs/types.ts` — `AgentProvider`, `ToolPolicy`, `BudgetPolicy`, `RoleDefinition`, `AgentProfile`, `ArtifactContract` — move to a new **`design-library/runtime-types.ts`** (not into `types.ts`, to keep `types.ts` as the library-graph schema and give runtime consumers a focused import surface). See §4.

`IntentDefinition` becomes an **inline shape inside a workflow template's state**:

```ts
type TemplateIntent = {
  id: string;
  description: string;
  examples: string[];
  workflowTemplateRef: string;   // always equal to the enclosing template's key (kept for fidelity)
  requiredInputs: string[];
  defaultContextPolicyRef: string;
  defaultSessionPolicyRef: string;
};
```

The template object's `state.intents: TemplateIntent[]` replaces the standalone `IntentDefinition` array. See §3.5 for which template object holds this — the design library already has two distinct template notions that must not be conflated.

### 3.4 Domain as `scope`, not as an object

A domain is a `scope` string on every object and edge (already supported by `library_objects.state_json->>'scope'` and `library_edges.scope`). There is no `domain` kind. Cross-domain selection is achieved by passing a set of scopes (or `null` for "all approved") to graph queries; see §5.

Scope invariants:

- Every seeded or imported library object must include `state.scope` or `state.domainRefs`.
- `state.scope = "global"` means the object is visible to all scope-filtered snapshots and candidate queries.
- A multi-scope query includes objects whose `state.scope` is in the requested scopes, whose `state.scope` is `"global"`, or whose `state.domainRefs` intersects the requested scopes.
- Library edges use `library_edges.scope`; a multi-scope query includes edges whose `scope` is in the requested scopes or `"global"`.
- If two objects expose the same runtime `id` across scopes, snapshot loading deduplicates by `(kind, id)` and prefers the first requested scope, then `"global"`, then lexical `objectKey`. This makes cross-domain selection deterministic.

### 3.5 Two template notions — keep both, do not merge

The codebase has **two structurally different workflow-template concepts** that both happen to be called `workflow_template`. They serve two different generation paths and must remain distinct objects in the graph:

| Template notion | Current home | Shape | Used by |
|---|---|---|---|
| **Composition-slot template** | design library `template.software-feature` | `state.compositionConstraints.templateSlots[]` (slot → `matchAny: [{ agentDefinitionRef }]`) | library-constrained LLM composer: `candidate-resolver` → `composition-validator` → `composition-compiler` |
| **Stage template** | domain pack `softwareDomainPack.workflowTemplates[0]` (`id: software-feature-template`) | `stages: WorkflowStageTemplate[]` each with `roleRef`, `dependsOn`, `promptTemplateRef`, `requiredArtifactRefs`, `evaluatorPipelineRef`, `stopConditionRefs`, `workspacePolicyRef`, `allowDynamicExpansion` | dynamic generation: `constrained-generator` → `validator` → `materialize` |

The `WorkflowTemplatePayload` already in `design-library/types.ts` (with `flow.nodes: WorkflowTemplateNode[]`, `nodeType`, `agentSpecRef`, `contractRefs`, `validatorRefs`, `capabilityRefs`, `mcpCapabilityRefs`) is a **third** shape that the library-constrained path's `WorkflowTemplatePayload` schema describes but the current seed does not populate with `flow` — the seeded `template.software-feature` only carries `compositionConstraints`.

**Consolidation rule:** the stage template (`software-feature-template`) becomes its **own** `workflow_template` library object, keyed `template.software-feature-stages`, with `state.templateModel = "stage_dag"`, `state.stages: WorkflowStageTemplate[]`, and `state.intents: TemplateIntent[]`. It is **not** merged into `template.software-feature` (the composition-slot template). The composition-slot template keeps its `compositionConstraints` shape unchanged and should carry `state.templateModel = "composition_slots"` once touched by this migration. The `WorkflowTemplatePayload`/`flow.nodes` shape is left as-is (out of scope to populate); this spec does not touch the `flow` model.

This means the `software` scope will have **two** `workflow_template` objects after consolidation: `template.software-feature` (slots, unchanged) and `template.software-feature-stages` (stages + intents, new). Consumers that read stages (`constrained-generator`, `materialize`) read the latter; the LLM composer reads the former. The `WorkflowGeneratorPolicyPayload.templateRefs` lists the stage-template key.

Snapshot code must not treat all `workflow_template` objects as one shape. Use an explicit discriminant:

```ts
type LibraryWorkflowTemplateSnapshot =
  | {
      templateModel: "composition_slots";
      key: string;
      id: string;
      scope: string;
      intentRefs: string[];
      compositionConstraints: Record<string, unknown>;
    }
  | {
      templateModel: "stage_dag";
      key: string;
      id: string;
      scope: string;
      intentRefs: string[];
      intents: TemplateIntent[];
      stages: WorkflowStageTemplate[];
    }
  | {
      templateModel: "flow_nodes";
      key: string;
      id: string;
      scope: string;
      payload: WorkflowTemplatePayload;
    };
```

Runtime consumers that need stages must filter `templateModel === "stage_dag"` before reading `stages` or `intents`. The composition resolver keeps using `templateModel === "composition_slots"`.

---

## 4. Type Relocation Plan

`domain-packs/types.ts` is imported by 14 non-test source files. It must be split and moved so that `domain-packs/` can be deleted with no dangling imports.

### 4.1 New home: `design-library/runtime-types.ts`

Holds the runtime value types that many layers need:

```ts
export type AgentProvider = "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";
export type ToolPolicy = { allowedTools: string[]; deniedTools: string[]; requiresApprovalFor: string[] };
export type BudgetPolicy = { maxInputTokens: number; maxOutputTokens: number; maxCostMicrosUsd?: number; maxWallTimeSeconds?: number };
export type RoleDefinition = { /* unchanged shape */ };
export type AgentProfile = { /* unchanged shape */ };
export type ArtifactContract = { id: string; artifactType: string; requiredFields: string[]; evidenceFields: string[] };
export type EvaluatorPipelineDefinition = { /* full shape from domain-packs */ };
export type ContextPolicyDefinition = { /* unchanged */ };
export type SessionPolicyDefinition = { /* unchanged */ };
export type MemoryPolicyDefinition = { /* unchanged */ };
export type WorkspacePolicyDefinition = { /* unchanged */ };
export type StopConditionDefinition = { /* unchanged */ };
export type WorkflowGeneratorPolicyDefinition = { /* unchanged */ };
```

These keep their **exact current shapes** so that `manifests/types.ts`, `agent-runner/task-envelope.ts`, `context/*`, etc. only change their import path, not their call sites.

### 4.2 Import-path rewrites (mechanical)

Every non-test file importing from `../domain-packs/types.ts` is repointed to `../design-library/runtime-types.ts`:

| File | Imports used |
|---|---|
| `agent-runner/task-envelope.ts` | `AgentProfile`, `ArtifactContract`, `EvaluatorPipelineDefinition`, `RoleDefinition` |
| `artifacts/validator-results.ts` | `ArtifactContract` |
| `context/managed-context-assembler.ts` | `ArtifactContract`, `DomainPack` (see §5 — `DomainPack` type is removed; this import becomes a graph-loaded equivalent) |
| `context/postgres-builder.ts` | `ArtifactContract`, `DomainPack` |
| `context/types.ts` | `BudgetPolicy` |
| `manifests/types.ts` | `AgentProfile`, `ArtifactContract`, `ContextPolicyDefinition`, `EvaluatorPipelineDefinition`, `MemoryPolicyDefinition`, `RoleDefinition`, `SessionPolicyDefinition`, `WorkspacePolicyDefinition`, `StopConditionDefinition` |
| `orchestration/composition-compiler.ts` | `AgentProfile`, `RoleDefinition` |
| `read-models/agent-library.ts` | `AgentProfile`, `RoleDefinition` (+ `softwareDomainPack` — see §6) |
| `read-models/workflow-ui.ts` | (via `softwareDomainPack` — see §6) |
| `ui-api/planner-draft-task-overrides.ts` | `AgentProvider`, `PlannerDraftTaskProfileOverride` |
| `ui-api/postgres-run-api.ts` | `AgentProfile`, `DomainPack`, `PlannerDraftTaskProfileOverride` |
| `ui-api/postgres-task-envelope.ts` | (via `softwareDomainPack` — see §6) |
| `workflow-generator/constrained-generator.ts` | `DomainPack` (see §7 — rewritten to load from graph) |
| `workflow-generator/materialize.ts` | `DomainPack` (see §7) |
| `workflow-generator/validator.ts` | `DomainPack` (see §7) |

### 4.3 The `DomainPack` type itself is removed

`DomainPack` (the aggregate with `intents/roles/agentProfiles/workflowTemplates/.../workflowGeneratorPolicies` all in one object) is **deleted**. No single object holds "a whole domain" anymore. Consumers that currently take a `DomainPack` parameter are rewritten to take a **`LibrarySnapshot`** — a graph-loaded view (see §5) that resolves the same fields from Postgres by scope.

---

## 5. `LibrarySnapshot` — the graph-loaded replacement for `DomainPack`

New module: `design-library/library-snapshot.ts`.

```ts
export type LibrarySnapshot = {
  scope: string;                       // primary scope, or "global" if multi-scope
  scopes: string[];                    // all scopes included (>=1; cross-domain = many)
  roles: RoleDefinition[];             // from agent_definition.state.role, deduped
  agentProfiles: AgentProfile[];
  artifactContracts: ArtifactContract[];
  evaluatorPipelines: EvaluatorPipelineDefinition[];
  contextPolicies: ContextPolicyDefinition[];
  sessionPolicies: SessionPolicyDefinition[];
  memoryPolicies: MemoryPolicyDefinition[];
  workspacePolicies: WorkspacePolicyDefinition[];
  stopConditions: StopConditionDefinition[];
  workflowTemplates: LibraryWorkflowTemplateSnapshot[];
  workflowGeneratorPolicies: WorkflowGeneratorPolicyDefinition[];
};

export async function loadLibrarySnapshot(db: SouthstarDb, scopes: string[]): Promise<LibrarySnapshot>;
export async function loadRunLibrarySnapshot(db: SouthstarDb, input: { scopes: string[]; selectedRefs: string[] }): Promise<LibrarySnapshot>;
```

`loadLibrarySnapshot` runs the existing `findApprovedLibraryObjectsByKind` per kind (with `scope = null` when `scopes.length > 1`, or the single scope when one), then filters by the scope invariants in §3.4 and maps each object's `state` into typed payloads. This is the management/read-model path that replaces static `softwareDomainPack.*` direct reads.

`loadRunLibrarySnapshot` is the runtime/task-envelope path. It starts from selected refs already present in the plan or manifest and loads only that closure plus required policy edges (`uses_context_policy`, `uses_session_policy`, `uses_memory_policy`, `uses_workspace_policy`, `enforces_generator_policy`, `validates_artifact`). This prevents every runtime context build from loading every approved persona once the 266-agent import lands.

### 5.1 Cross-domain candidate resolution

`candidate-resolver.ts` changes its input from a single `scope: string` to `scopes: string[]`:

```ts
export type ResolveWorkflowCandidatesInput = {
  requirementSpec: RequirementSpecV2;
  scopes: string[];   // was: scope: string
};
```

The graph store already supports `scope = null` (returns all approved). For the multi-scope case, `findApprovedLibraryObjectsByKind` and edge queries are called with `scope = null`, then filtered by the scope invariants in §3.4. `CandidatePacket` shape is unchanged; it just may contain candidates from multiple scopes. Composition validation's `ref_not_in_candidate_packet` check is unchanged — a ref from any included scope, or from `"global"`, is valid.

`composition-compiler.ts`'s `scope = input.scope ?? "software"` default is removed; the compiler receives `scopes` and forwards them.

---

## 6. Consumer Rewrites

Six static-`softwareDomainPack` consumers become graph-backed.

### 6.1 `context/managed-context-assembler.ts`
- `domainPack = options.domainPack ?? softwareDomainPack` → `snapshot = options.snapshot ?? await loadRunLibrarySnapshot(db, { scopes: workflow.libraryScopes ?? [workflow.domain ?? "software"], selectedRefs: selectedRefsFromWorkflowTask(workflow, task) })`.
- `domainPack.evaluatorPipelines.find(...)` → `snapshot.evaluatorPipelines.find(...)`.
- `domainPack.contextPolicies.find(...)` / `memoryPolicies` / `artifactContractsForTask` → same, off `snapshot`.
- `options.domainPack` field replaced with `options.snapshot` (a `LibrarySnapshot`), loaded once per run/task closure and cached on the assembler instance.

### 6.2 `ui-api/postgres-run-api.ts`
- `domainPackForWorkflow(workflow)` (the `workflow.* ?? softwareDomainPack.*` fallback) is removed. The manifest's `roles/agentProfiles/...` arrays are already snapshotted at compile time (see §7), so `domainPackForWorkflow` becomes `loadRunLibrarySnapshot(db, { scopes: workflow.libraryScopes ?? [workflow.domain ?? "software"], selectedRefs: selectedRefsFromWorkflow(workflow) })` only when a legacy manifest is missing a snapshotted array.
- `materializeWorkflowTaskProfileOverrides`'s `softwareDomainPack.agentProfiles` fallback → `snapshot.agentProfiles`.

### 6.3 `ui-api/postgres-task-envelope.ts`
- `domainPack.evaluatorPipelines.find(...)` → `snapshot.evaluatorPipelines.find(...)`, with the snapshot loaded through `loadRunLibrarySnapshot` from workflow/task selected refs.
- The `seedSoftwareLibraryGraph` call at the top of task envelope creation stays (it is idempotent upsert), but the evaluator lookup moves to the snapshot.

### 6.4 `read-models/agent-library.ts`
- Delete `if (domain !== "software") throw`. Accept any domain string.
- `buildDomainLibrary(domain)` → `await loadLibrarySnapshot(db, [domain])` and project from the snapshot. The function becomes `async` and the route handler awaits it.
- `softwareDomainPack.artifactContracts/evaluatorPipelines/contextPolicies/...` → snapshot fields.
- `softwareVaultLeasePolicies` import stays (vault leases are already a library kind; the read model can read them from the snapshot too, but the static export is retained for the seed).

### 6.5 `read-models/workflow-ui.ts`
- `agentLibrarySummary(domain)`'s direct `softwareDomainPack.roles/profiles/artifactContracts/evaluatorPipelines` counts → snapshot counts.
- `resolveWorkflowTaskDetail`'s `softwareDomainPack.roles.find/agentProfiles.find/artifactContracts.find/evaluatorPipelines.find/contextPolicies.find` → snapshot lookups.
- `evaluatorPipelineForArtifact` → scan `snapshot.evaluatorPipelines`.

### 6.6 `evolution/sandbox.ts`
- `domainPack: softwareDomainPack` → `snapshot: await loadLibrarySnapshot(db, ["software"])`.

---

## 7. `workflow-generator/` Rewrite

`constrained-generator.ts`, `validator.ts`, and `materialize.ts` currently take a `DomainPack` and read `.intents`, `.workflowTemplates`, `.workflowGeneratorPolicies`, `.agentProfiles`, `.artifactContracts`, `.roles`, `.contextPolicies`, `.sessionPolicies`, `.memoryPolicies`, `.workspacePolicies`.

Rewrite to take a `LibrarySnapshot`:

- `input.domainPack.intents.find(id)` → `snapshot.workflowTemplates.filter(t => t.templateModel === "stage_dag").flatMap(t => t.intents).find(i => i.id === id)`.
- `input.domainPack.workflowTemplates.find(id)` → `snapshot.workflowTemplates.find(t => t.templateModel === "stage_dag" && t.key === id)` (the stage template, see §3.5).
- `input.domainPack.workflowGeneratorPolicies.find(...)` → `snapshot.workflowGeneratorPolicies.find(...)`.
- `materialize.ts`'s `input.domainPack.roles/agentProfiles/artifactContracts/evaluatorPipelines/contextPolicies/sessionPolicies/memoryPolicies/workspacePolicies` → snapshot fields.
- `materialize.ts`'s `input.domainPack.workflowTemplates.flatMap(template => template.stages).find(stage => stage.roleRef === task.roleRef)?.workspacePolicyRef` is preserved unchanged in shape — the stage template object (`template.software-feature-stages`) carries `state.stages: WorkflowStageTemplate[]`, so the snapshot's `workflowTemplates` entry for it exposes `.stages` and the same `flatMap(...).find(...)` lookup works. This is **not** the `WorkflowTemplatePayload.flow.nodes` model; that model is untouched (§3.5).

`WorkflowGenerationPlan.domainPackRef` is renamed to `libraryRef: { scopes: string[]; versionHash: string }` (the `contentHash` becomes a hash over the snapshot). The manifest's `domainPackRef?` field is kept for backward-compatible read of old runs but is no longer written; new manifests write `libraryRef?`.

`validateWorkflowGenerationPlan(domainPack, plan)` → `validateWorkflowGenerationPlan(snapshot, plan)`. The policy lookups become `snapshot.workflowGeneratorPolicies.find(...)`. All `allowedRoleRefs`/`allowedAgentProfileRefs`/`allowedEvaluatorPipelineRefs`/`allowedArtifactContractRefs` checks are unchanged in logic — they now verify against a policy that may itself be from a different scope than the role/profile it allows (this is the cross-domain capability the user asked for).

---

## 8. Seed Rewrite — `software-library-seed.ts`

The seed grows to populate the 7 new kinds for the `software` scope, preserving all current behavior. The existing `softwareVaultLeasePolicies` export is retained (it is read by the read model and used as the seed source).

### 8.1 New objects added to `SOFTWARE_OBJECTS`

- `context_policy.software-context-default` ← `softwareDomainPack.contextPolicies[0]`
- `session_policy.software-session-default` ← `softwareDomainPack.sessionPolicies[0]`
- `memory_policy.software-memory-default` ← `softwareDomainPack.memoryPolicies[0]`
- `workspace_policy.software-git-workspace` ← `softwareDomainPack.workspacePolicies[0]`
- `stop_condition.software-feature-complete` ← `softwareDomainPack.stopConditions[0]` (the only one; `type: custom`, `evaluatorRefs: [software-feature-quality, software-verification-quality, software-completion-quality]`)
- `evaluator_pipeline.software-plan-quality`, `evaluator_pipeline.software-feature-quality`, `evaluator_pipeline.software-verification-quality`, `evaluator_pipeline.software-completion-quality` ← `softwareDomainPack.evaluatorPipelines` (full `evaluators[]` + `onFailure`)
- `workflow_generator_policy.software-feature-generator` ← `softwareDomainPack.workflowGeneratorPolicies[0]`
- `workflow_template.software-feature-stages` gains `intents: [implement_feature, fix_bug]` inside its state (folded from `softwareDomainPack.intents`). `workflow_template.software-feature` remains the composition-slot template and does not gain `intents`.

### 8.2 Existing objects updated

- The existing weak `evaluator_profile` objects (`evaluator.software-plan-quality` etc.) are **deprecated**: kept in code for migration read but no longer seeded. New `evaluator_pipeline.*` objects supersede them. (If a migration finds existing `evaluator_profile` rows, they are left in place; the read path only consults `evaluator_pipeline`.)

### 8.3 New edges

- `profile.* → uses_context_policy → context_policy.software-context-default`
- `profile.* → uses_session_policy → session_policy.software-session-default`
- `context_policy.software-context-default → uses_memory_policy → memory_policy.software-memory-default`
- `context_policy.software-context-summary → uses_memory_policy → memory_policy.software-memory-default`
- `workflow_template.software-feature-stages → uses_workspace_policy → workspace_policy.software-git-workspace`
- `workflow_template.software-feature-stages → enforces_generator_policy → workflow_generator_policy.software-feature-generator`
- `evaluator_pipeline.* → validates_artifact → artifact.*` (replaces the old `evaluator_profile → validates_artifact` edges; old edges are superseded)
- `stop_condition.*` referenced from the stage-template's `state.stages[].stopConditionRefs` (no new edge kind needed; refs are inside the stage template state)

### 8.4 Migration ordering

`seedSoftwareLibraryGraph` is called on every run/task-envelope creation (already idempotent upsert). After the code ships, the next `seedSoftwareLibraryGraph` call upserts the new objects and edges. Old `evaluator_profile` rows remain but are unread. No destructive migration is required for correctness; an optional cleanup pass can delete `evaluator_profile` rows after confirming no run still references them.

---

## 9. Manifest Compatibility

`SouthstarWorkflowManifest` already snapshosts `roles/agentProfiles/artifactContracts/evaluatorPipelines/contextPolicies/sessionPolicies/memoryPolicies/workspacePolicies/stopConditions` into the manifest at compile time (see `materialize.ts`). This is preserved — the manifest remains a self-contained snapshot, so existing runs keep executing without reading static domain packs. Consumers such as `managed-context-assembler.ts` must prefer manifest-snapshotted arrays and use `loadRunLibrarySnapshot` only as a graph-backed legacy fallback.

Changes:
- `domain?: string` → `domain?: string` stays (primary scope).
- Add `libraryScopes?: string[]` for multi-scope runs (defaults to `[domain]`).
- `domainPackRef?` stays for old-run read; new runs write `libraryRef?: { scopes: string[]; versionHash: string }`.
- `WorkflowTaskDefinition.domain` union (`"software" | "research" | "data-analysis" | "general"`) is widened to `string` so per-task domain can be any scope. The union was always aspirational; the runtime never branch on it.

No migration of existing `workflow_runs.workflow_manifest_json` rows is required — old manifests still carry their snapshotted arrays and execute from them.

---

## 10. Removal of `src/v2/domain-packs/`

After §4–§8 land and all tests pass:

1. Delete `src/v2/domain-packs/types.ts`, `software.ts`, `registry.ts`.
2. Grep-verify: `rg "domain-packs|DomainPack|domainPackId|softwareDomainPack" src/ web/ components/ lib/ tests/` returns only historical references in `docs/` or explicitly documented backward-compatible manifest/API fields.
3. Remove the `components/southstar/pages/DomainPacksAgentStudioPage.tsx` page and its `getUiDomainPacks` API client method (§11), or repoint them to the design-library read model.
4. `createDomainPackRegistry` and `routeByPrompt`/`routeIntent` logic moves to a new `design-library/domain-router.ts` that routes a goal prompt to `(scopes, intentId, templateRef)` by scanning `stage_dag` templates' `intents[]` and matching `examples`. Tie-breaker order is: explicit domain/scope hint, exact example/regex match, requirement `workType`/capability match, first default stage template for the primary scope. This preserves prompt→intent routing without the `DomainPack` aggregate.

---

## 11. UI / API Surface

- `/api/v2/agent-library?domain=software` → accept any `domain` value; return snapshot-projected data for that scope. The hard `throw` is gone.
- `/api/v2/agent-library/candidates` → unchanged shape; may now return candidates across multiple scopes when the draft's `libraryScopes` has >1 entry.
- `domainPackId` remains accepted only as a backward-compatible input alias for `libraryScopes: [domainPackId]`; new API responses and UI state use `libraryScopes`.
- `getUiDomainPacks` API client method and `DomainPacksAgentStudioPage` are removed (or repointed to a new `/api/v2/library-snapshot?scopes=...` endpoint that returns the `LibrarySnapshot` projection). The page is currently the only consumer of the domain-pack-as-aggregate UI; with the aggregate gone, it is replaced by a library-snapshot view.

---

## 12. Testing Strategy

Existing tests that touch `domain-packs` (11 files) and `design-library`/`composition` (19 files) are the regression surface. The plan:

1. **Type-move tests first.** After §4, run `npm run test:v2`. All tests that imported `domain-packs/types` must still compile and pass with the new import path. No behavior change expected.
2. **Seed tests.** `tests/v2/library-graph-store.test.ts` and any seed-coverage test get assertions for the 7 new kinds and the new edges in the `software` scope.
3. **Payload validator tests.** `tests/v2/design-library-validators.test.ts` gets one valid and one invalid case for each new kind: `context_policy`, `session_policy`, `memory_policy`, `workspace_policy`, `stop_condition`, `evaluator_pipeline`, `workflow_generator_policy`. Invalid rows must be rejected before they can become approved library objects.
4. **Snapshot loader test.** New `tests/v2/library-snapshot.test.ts` seeds the software library and asserts `loadLibrarySnapshot(db, ["software"])` returns the same `roles/profiles/policies/evaluatorPipelines` shapes that `softwareDomainPack` exposed (shape parity is the acceptance gate). It also asserts `loadRunLibrarySnapshot` returns only selected refs plus policy closure.
5. **Consumer parity tests.** `managed-context-assembler.test.ts`, `postgres-task-envelope.test.ts`, `postgres-run-api.test.ts`, `workflow-ui` read-model tests, and `evolution-context-builder-postgres.test.ts` are updated to inject a `LibrarySnapshot` instead of `softwareDomainPack` and assert unchanged outputs.
6. **Routing parity tests.** New `domain-router` tests preserve current prompt behavior: explicit software hint, feature prompt, bug/failure prompt, and non-software research prompt. Multi-scope tie-breakers follow §10.
7. **Cross-domain candidate test.** New case in `library-candidate-resolver.test.ts`: seed two scopes (e.g. `software` + `research`), call `resolveWorkflowCandidates` with `scopes: ["software","research"]`, assert the packet contains agents/policies from both and validation passes for a plan mixing them.
8. **Generator rewrite test.** `constrained-generator`/`validator`/`materialize` tests pass a `LibrarySnapshot` and assert the generated plan/manifest is byte-equivalent to the pre-rewrite output (modulo `domainPackRef` → `libraryRef` rename).
9. **Deletion gate.** `rg "domain-packs|DomainPack|domainPackId|softwareDomainPack" src/ web/ components/ lib/ tests/` returns only documented backward-compatible fields; `npm run test:v2` and `npm run test:postgres` pass; `npm --prefix web run build` passes.

Per AGENTS.md, do **not** run `test:e2e:*` or `test:live` as routine verification. The `test:v2` + `test:postgres` + web build gate is the verification loop.

---

## 13. Out of Scope (deferred, tracked for the next spec)

These are explicitly **not** part of this consolidation:

- Importing the 266 `agency-agents-zh` personas. That is the *next* spec; it depends on this consolidation (it needs the multi-scope graph + the `instruction_template`/`agent_definition` seeding path this spec finalizes).
- Removing the 6 test software roles. Same next spec — it is a content change on top of the new graph, not a structural change.
- Forcing every persona to the pi host adapter. Same next spec (a default `agent_profile` template for imported personas).
- Adding new tools / MCP servers. Separate work.
- Deleting legacy `evaluator_profile` rows destructively. Optional cleanup pass, post-stabilization.

---

## 14. Acceptance Criteria

The consolidation is complete when **all** of the following hold:

1. `rg "domain-packs|DomainPack|domainPackId|softwareDomainPack" src/ web/ components/ lib/ tests/` returns only historical docs or explicitly documented backward-compatible manifest/API fields.
2. `src/v2/domain-packs/` directory does not exist.
3. `npm run test:v2` passes.
4. `npm run test:postgres` passes.
5. `npm --prefix web run build` passes.
6. `loadLibrarySnapshot(db, ["software"])` produces role/profile/policy/evaluator-pipeline shapes equal to the old `softwareDomainPack` (shape-parity test passes).
7. `loadRunLibrarySnapshot(db, { scopes, selectedRefs })` returns selected refs plus required policy closure without loading unrelated approved agents.
8. `resolveWorkflowCandidates` accepts `scopes: string[]` and a 2-scope test returns a packet with candidates from both scopes.
9. `/api/v2/agent-library?domain=research` no longer throws `unsupported domain pack` (returns empty snapshot or seeded research data, but does not throw).
10. No source file imports `DomainPack` (the aggregate type no longer exists).
11. New `LibraryDefinitionKind` values `context_policy`, `session_policy`, `memory_policy`, `workspace_policy`, `stop_condition`, `evaluator_pipeline`, `workflow_generator_policy` are seeded for the `software` scope and queryable via `findApprovedLibraryObjectsByKind`.
12. Payload validators reject malformed state for every new kind before approval.
13. Prompt routing parity tests cover the old feature/fix/research behavior and the new multi-scope tie-breaker.

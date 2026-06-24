# Southstar LLM Orchestrator P1 Design

Date: 2026-06-24
Status: design draft

## 1. Context

Southstar P0 now has the library-constrained orchestration skeleton:

- `southstar.library_objects`
- `southstar.library_edges`
- software library seed
- direct-edge candidate resolver
- composition validator
- composition compiler
- explicit `orchestrationMode: "llm-constrained"` planner draft path
- deterministic fixture composer for contract and E2E coverage

The P0 path proves the contract boundary, but it does not yet restore true LLM workflow DAG composition. The current `llm-constrained` path still calls a deterministic fixture composer, and runtime task envelopes mostly preserve selected library refs instead of fully materializing instruction prompts, skill snapshots, tool grants, MCP grants, and vault lease policies.

P1 closes those gaps without replacing the P0 graph model.

## 2. Goals

1. Add a real LLM workflow composer that can produce variable `WorkflowCompositionPlan` DAGs from a bounded `CandidatePacket`.
2. Keep Southstar as deterministic runtime authority: LLM output is proposal only and must pass validation, repair, and compilation.
3. Replace API-level composer hardcoding with a composer registry and explicit mode/config selection.
4. Materialize selected library refs into runtime inputs:
   - instruction refs become prompt content
   - skill refs become resolved skill snapshots
   - tool grant refs become task-scoped tool permissions
   - MCP grant refs become server/tool allowlists
   - vault lease policy refs become auditable lease requests and safe lease metadata
5. Preserve fixture composer support for tests, fallback, and offline development.
6. Extend real E2E coverage from case 28 so the path proves dynamic composition through runtime execution.

## 3. Non-Goals

- No UI or visual DAG editor work.
- No vector search.
- No recursive CTE.
- No graph DB or Postgres graph extension.
- No direct LLM creation of approved library objects.
- No LLM-created credential, secret, MCP grant, external write permission, or vault lease taking effect directly.
- No removal of deterministic constrained planner path until the LLM path has stronger production evidence.

## 4. Design Principles

### 4.1 LLM Is Workflow Architect

The LLM may reason about requirement intent, task decomposition, workflow pattern selection, role responsibility assignment, candidate tradeoffs, and validator repair patches.

The LLM may output:

- `RequirementSpecV2`
- `WorkflowCompositionPlan`
- `WorkflowCompositionPatch`
- `GeneratedComponentProposal`
- selected candidate rationale
- rejected candidate rationale

The LLM may not output anything that directly becomes runtime authority.

### 4.2 Compiler Is Runtime Authority

Southstar owns:

- approved library refs
- candidate retrieval boundaries
- permission validation
- DAG validation
- compiler materialization
- runtime manifest truth
- tool/MCP/vault enforcement
- orchestration snapshot persistence

Every selected ref must be reproducible from approved library objects and direct typed edges.

### 4.3 P1 Improves Dynamism Without Expanding Storage Complexity

The P1 query model remains direct-edge and bounded. Ranking may use deterministic score fields, tags, and learning evidence summaries, but learning graph evidence cannot grant runtime permissions.

## 5. Target Flow

```text
goalPrompt
  -> RequirementAnalyzer
  -> CandidateResolver(Postgres library_objects + library_edges)
  -> WorkflowComposerRegistry
  -> LlmWorkflowComposer
  -> CompositionValidator
  -> CompositionRepairLoop(optional)
  -> CompositionCompiler
  -> SouthstarWorkflowManifest + orchestration_snapshot
  -> RuntimeLibraryMaterializer
  -> ContextPacket + TaskEnvelopeV2 + enforcement resources
  -> Southstar runtime / Tork / Pi-agent
```

The deterministic fixture composer remains available:

```text
WorkflowComposerRegistry
  mode=fixture -> DeterministicFixtureComposer
  mode=llm -> LlmWorkflowComposer
  mode=llm-with-fixture-fallback -> LlmWorkflowComposer, then fixture only on configured fail-closed fallback
```

Fallback must be explicit in config and visible in `plannerTrace`.

## 6. Components

### 6.1 Requirement Analyzer

P1 keeps the deterministic analyzer as the default fallback and introduces an optional LLM-compatible analyzer interface:

```ts
export interface RequirementAnalyzer {
  analyze(input: AnalyzeRequirementInput): Promise<RequirementSpecV2>;
}
```

The LLM analyzer may improve work type, required capabilities, expected artifacts, acceptance criteria, missing inputs, and risk notes. Its output must be normalized and validated before candidate resolution.

P1 does not require the LLM analyzer for the first vertical slice. The first production slice may use deterministic analyzer plus LLM composer.

### 6.2 Candidate Resolver

The existing resolver remains deterministic and bounded. P1 extends candidate packet content enough for LLM choice quality:

- compact object summary
- object kind
- version ref
- capability reasons
- relevant direct edges
- policy and risk hints
- prior success or failure evidence summaries when available

The packet must stay bounded. It must include enough information for composition decisions without including full library object bodies when those bodies are large.

### 6.3 Workflow Composer Registry

`createPostgresPlannerDraft()` must not instantiate a concrete composer directly. It must call a registry or factory:

```ts
export type WorkflowComposerMode =
  | "fixture"
  | "llm"
  | "llm-with-fixture-fallback";

export interface WorkflowComposerRegistry {
  resolve(mode: WorkflowComposerMode): WorkflowComposer;
}
```

The registry is the only place where concrete composer selection happens. API routes pass requested orchestration mode and optional composer mode into planner orchestration. Tests can inject fixture or scripted mock composers.

### 6.4 LLM Workflow Composer

`LlmWorkflowComposer` receives:

- goal prompt
- validated `RequirementSpecV2`
- bounded `CandidatePacket`
- output schema
- hard safety rules
- examples of valid composition shape

It returns only `WorkflowCompositionPlan`.

The prompt must state:

- select refs only from candidate packet
- generate task ids, dependencies, responsibilities, and rationale
- generated component proposals are allowed only in side channel
- do not output runtime manifest
- do not output secret values
- do not output raw tool credentials
- do not invent refs

The parser must reject non-JSON, multi-object responses, unknown schema versions, and oversized output.

### 6.5 Composition Repair Loop

The repair loop handles validator failures without weakening validation.

```text
compose attempt 1
  -> validator issues
  -> repair prompt containing issue paths/codes and candidate summary
  -> patched or replacement WorkflowCompositionPlan
  -> validator again
```

Rules:

- max attempts is configurable, default 2.
- repair input includes validator issues, candidate summary, and prior selected plan.
- repair output must still be a full valid `WorkflowCompositionPlan` or a constrained `WorkflowCompositionPatch` that Southstar applies deterministically.
- if repair fails, planner draft is stored as invalid with full diagnostics.
- invalid drafts cannot create runs.

### 6.6 Composition Validator Extensions

P1 extends validator coverage beyond P0:

- `vaultLeasePolicyRefs` must be in candidate packet.
- profile must allow selected vault lease policies.
- selected tool refs must satisfy vault secret group constraints when a vault lease is present.
- selected agent must be allowed to produce each output artifact.
- selected task input artifacts must be satisfiable by upstream output artifacts or initial inputs.
- selected task must be compatible with selected workflow template slot when `templateSlotRef` is present.
- selected policies must not conflict with selected tools, MCP grants, or workspace writes.
- validator scope must not be hardcoded to `software`; it must use packet or planner scope.

The validator remains deterministic and must not call an LLM.

### 6.7 Composition Compiler

The compiler converts a valid `WorkflowCompositionPlan` into a `SouthstarWorkflowManifest`.

P1 compiler changes:

- remove special-case normalization for spec reviewer and code quality reviewer.
- resolve role/profile/harness data from library objects or embedded compiled definitions, not string heuristics.
- preserve selected refs in task definitions.
- store compiler decisions and version refs in `orchestration_snapshot`.
- include enough resolved profile data for active runs to survive future library changes.

Compiler output remains the only manifest accepted by runtime.

### 6.8 Runtime Library Materializer

The runtime materializer converts compiled selected refs into task-scoped runtime inputs.

```ts
export interface RuntimeLibraryMaterializer {
  materializeTask(input: MaterializeTaskLibraryInput): Promise<MaterializedTaskLibraryRefs>;
}
```

It must run before or during managed context assembly, so `ContextPacket` and `TaskEnvelopeV2` carry the resolved content.

#### Instruction Materialization

`instructionRefs` load approved `instruction_template` objects and render safe prompt content. Variables are resolved from task, run, goal, context, and artifact contract data. Missing required variables fail closed.

#### Skill Materialization

`skillRefs` load approved skill definition/spec objects and produce real `ResolvedSkillSnapshot` records:

- skill id
- version
- instruction body
- allowed tools
- required mounts
- MCP requirements
- artifact contract refs
- content hash
- mount path if materialized on disk

The current `Use skill ${skillId}.` stub is not sufficient for P1 acceptance.

#### Tool Grant Materialization

`toolGrantRefs` load approved tool definitions or grant bundles and produce task-scoped allowed tools. Tool proxy enforcement must consume this result before task execution.

Side-effecting tools must preserve approval requirements and risk tags.

#### MCP Grant Materialization

`mcpGrantRefs` load approved MCP grant definitions and produce:

- server id
- allowed tool names
- input/output limits
- side-effect policy
- approval requirement

`allowedTools: []` is not sufficient for P1 acceptance when a grant is selected.

#### Vault Lease Materialization

`vaultLeasePolicyRefs` load approved lease policy objects and produce lease requests or safe lease metadata:

- lease ref
- secret group ref
- mount mode
- allowed tool refs
- TTL
- audit requirement

Secret values must never be stored in library objects, workflow manifests, orchestration snapshots, or persisted task envelopes. Persisted envelope data may include lease metadata only.

## 7. API Behavior

Planner draft input must remain backward compatible:

```ts
type CreatePostgresPlannerDraftInput = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: "fixture" | "llm" | "llm-with-fixture-fallback";
};
```

Behavior:

- omitted `orchestrationMode` keeps current deterministic default.
- `orchestrationMode: "llm-constrained"` defaults to configured composer mode.
- test environments may explicitly select `composerMode: "fixture"`.
- production LLM mode requires configured LLM provider.
- missing LLM provider fails closed unless fallback mode is explicitly selected.

`plannerTrace` must record:

- analyzer type
- composer mode
- composer model/provider
- fallback usage
- validator attempts
- repair attempts
- final validation result
- candidate packet hash
- composition hash

## 8. Persistence And Audit

The planner draft resource stores:

- planner trace
- requirement spec
- candidate packet hash and bounded summary
- selected composition plan
- rejected candidates
- generated component proposals
- validator proof
- repair attempts
- compiler snapshot

Invalid drafts are persisted with status `invalid` and cannot create workflow runs.

Generated component proposals remain proposal-only. They may create candidate library draft resources only through a separate approval workflow, not during runtime execution.

## 9. Error Handling

P1 failures must be explicit:

- LLM unavailable: invalid draft or configured fallback, never silent fixture substitution.
- malformed LLM output: invalid draft after retries.
- unknown ref: validator rejection.
- candidate packet missing required capability: invalid draft.
- materializer cannot resolve selected ref: run creation or task materialization fails closed before task execution.
- vault/tool/MCP policy conflict: validator or materializer rejection before task execution.

All failures must persist diagnostics as runtime resources and history events where a run exists.

## 10. Testing Strategy

### 10.1 Unit Tests

- composer registry selects fixture, mock LLM, and fallback modes deterministically.
- LLM composer parser rejects non-JSON, unknown schema, external refs, and oversized responses.
- repair loop converts a scripted invalid composition into a valid one.
- validator rejects unauthorized vault/tool/MCP/profile/artifact/template combinations.
- compiler no longer relies on role/profile string heuristics.
- runtime materializer resolves instruction, skill, tool, MCP, and vault refs into task-scoped structures.

### 10.2 API Tests

- default planner draft remains deterministic.
- explicit `llm-constrained` with fixture composer still passes existing P0 expectations.
- explicit `llm-constrained` with mock LLM composer produces a different valid DAG.
- invalid LLM output persists invalid planner draft and cannot create a run.
- planner trace records analyzer/composer/repair/validator evidence.

### 10.3 E2E Tests

Extend case 28 or add case 29:

1. start real Postgres runtime server.
2. create planner draft with `orchestrationMode: "llm-constrained"` and mock or controlled LLM composer.
3. assert generated task count and shape are not the fixture shape.
4. assert orchestration snapshot contains selected refs and validator proof.
5. create run.
6. assert each task has materialized instruction/skill/tool/MCP/vault metadata as applicable.
7. execute through real scheduler/Tork/Pi callback path.
8. assert all tasks complete and run reaches `passed`.
9. assert no inflight hand executions remain.
10. assert no secret value persisted.

## 11. Acceptance Criteria

- `createPostgresPlannerDraft()` no longer directly constructs `DeterministicFixtureComposer`.
- A mock/scripted LLM composer can create at least two different valid DAG shapes from different prompts or candidate packets.
- Invalid LLM selected refs are rejected before compile.
- Validator repair is covered by tests.
- TaskEnvelopeV2 includes materialized instruction content and real skill snapshots.
- Tool proxy receives task-scoped allowed tools derived from selected tool grants.
- MCP grants include non-empty allowed tool lists when selected.
- Vault lease policy refs produce safe lease metadata without persisted secret values.
- Full `npm run test:v2` passes with Postgres test URL.
- A real E2E path proves planner draft -> dynamic composition -> compiled manifest -> task execution -> terminal run.

## 12. Implementation Notes

Implement P1 in vertical slices:

1. Composer registry and mock LLM composer tests.
2. LLM composer parser and prompt contract.
3. validator extension and repair loop.
4. compiler string-heuristic removal.
5. runtime library materializer.
6. API trace and invalid draft behavior.
7. E2E case extension.

Use TDD and subagent-driven development for implementation. Keep each slice independently reviewable and preserve P0 fixture tests throughout.

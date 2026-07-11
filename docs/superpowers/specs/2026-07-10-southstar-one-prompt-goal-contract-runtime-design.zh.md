# Southstar One-Prompt Goal Contract Runtime Design

**Date:** 2026-07-10

**Status:** Revised design; awaiting written-spec review

**Revision:** 2026-07-11

**Decision:** Goal Design defaults to one review gate before composition; optional Auto mode continues through composition and low-risk execution, while blocking ambiguity and high-risk effects still pause

**First cross-domain proof:** `design/article`

## 1. Summary

Southstar should be a durable, auditable **Goal-to-Outcome Runtime**:

- the user supplies one goal prompt;
- the selected workspace is supplied by the product context;
- Southstar Goal Design Skill clarifies the goal and persists a typed Goal Design Package;
- the package contains the Goal Contract, evaluator contracts, Slice Plan, and composition strategy;
- the approved Library graph supplies executable workflow primitives;
- Southstar compiles and freezes a workflow DAG and its Library inputs;
- review mode pauses once on the complete Goal Design Package before composition;
- Auto mode lets low-risk, unambiguous goals continue without that review stop;
- high-risk effects or blocking ambiguity pause for durable approval or clarification;
- completion is decided from requirement coverage and evaluator evidence, not merely task termination or worker self-report.

“One prompt” means one user-authored goal prompt. It does **not** mean one LLM call. Southstar may perform internal interpretation, composition, critique, validation, and evaluation calls without asking the user to restate the goal.

This is a delta design over the existing v2 architecture. It does not introduce a second workflow engine, a second persistence model, or a parallel Library.

## 2. Related Sources Of Truth

This design extends rather than replaces:

- `docs/superpowers/specs/2026-06-20-southstar-managed-agents-meta-harness-design.zh.md`
- `docs/superpowers/specs/2026-06-23-southstar-library-constrained-llm-orchestrator-design.zh.md`
- `docs/superpowers/specs/2026-06-30-southstar-planner-draft-validation-flow-design.md`
- `docs/superpowers/specs/2026-07-02-southstar-library-tab-dynamic-agent-profile-design.zh.md`

The current production source of truth remains `src/v2/` plus `web/`.

## 3. Current Gap

The existing runtime already has the correct execution foundation:

- Postgres workflow runs, tasks, append-only history, resources, artifacts, and secure blobs;
- Library-constrained LLM composition and deterministic composition validation;
- typed `nodePromptSpec` propagation into managed context and TaskEnvelope;
- runnable DAG scheduling, session checkpoints, brain/hand bindings, and Tork execution;
- idempotent callbacks, artifact storage, recovery decisions, Operator controls, and bounded dynamic repair.

The missing product closure is concentrated at four seams.

### 3.1 Goal interpretation is still software-specific

`src/v2/orchestration/requirement-analyzer.ts` currently maps every prompt to either `bugfix` or `software_feature`, with fixed repository capabilities and fixed software artifacts.

`src/v2/ui-api/postgres-run-api.ts` currently resolves Library candidates with scope `all` but compiles the manifest domain as `software`.

Result: the runtime can dynamically arrange a software workflow, but it cannot yet truthfully claim that the prompt and Library determine the domain and outcome contract.

### 3.2 Library refs are selected at planning time but re-read from current head at execution time

The orchestration snapshot records selected version refs, but the canonical manifest does not currently carry `compiledFrom`, and `runtime-library-materializer.ts` resolves selected refs from the latest approved `library_objects` state.

Result: a Library edit between draft creation and task dispatch can change the effective TaskEnvelope of an existing run.

### 3.3 Structural validation is stronger than outcome validation

Current composition validation proves DAG shape, ref membership, profile closure, and prompt-contract shape. Callback ingestion still accepts an artifact primarily from the callback semantic `ok` result, and the completion gate primarily checks terminal tasks, accepted artifact presence, policy violations, exceptions, and recovery state.

Result: Southstar can prove that a workflow ran and produced accepted resources more strongly than it can prove that every user requirement was independently verified.

### 3.4 One-prompt interaction is not one run submission

The Workflow UI currently exposes separate draft, validate, run, and execute actions. `/api/v2/run-goal` creates a planner draft and run rows but does not start scheduling and does not preserve the selected workspace.

Result: the user sees one chat box, but the product still requires a multi-step launch protocol.

## 4. Product Positioning

Southstar is not primarily:

- a chat application;
- an Agent marketplace;
- a generic visual DAG editor;
- an LLM that retries until it says it is done.

Southstar is:

> A governed compiler and durable runtime that converts a goal into a versioned execution plan, executes it through bounded capabilities, verifies the requested outcome with evidence, and preserves enough state to inspect, recover, or replay the run.

The product surfaces have distinct roles:

- **Workflow / Mission:** submit and steer goals, inspect the generated contract and DAG, and follow outcome progress.
- **Library:** author and approve executable primitives and relationships.
- **Operator:** investigate operational health, exceptions, recovery, and approvals.
- **Chat:** a transport for goal submission and steering, not the system of record.

## 5. Goals

1. A user can submit one prompt from a selected workspace and receive a persisted Goal Design/draft identity; a run identity appears only after confirmed or automatic composition succeeds.
2. The default review mode produces one complete Goal Design Package and pauses once before composition; Auto mode may continue without another click.
3. Blocking ambiguity prevents run creation; high-risk effects prevent scheduling until approved.
4. Domain and intent are derived from the goal contract rather than hardcoded to software.
5. Every blocking requirement maps to producers, artifacts, evaluators, and expected evidence.
6. Every run consumes an immutable snapshot of its selected Library objects.
7. Completion expresses outcome satisfaction separately from execution lifecycle and operational health.
8. Dynamic repair cannot silently expand the approved capability or side-effect envelope.
9. At least one software and one `design/article` real E2E prove the architecture is not a software-only special case.
10. Goal Design and Slice Plan are presented inside the existing Workflow message layout; no replacement Workflow layout or standalone Goal design page is introduced.

## 6. Non-Goals

- Replacing Postgres, Tork, the scheduler, TaskEnvelope, or the current runtime resource model.
- Adding a second orchestration framework beside the existing planner/composer/compiler path.
- Letting an LLM approve Library objects, tools, MCP grants, vault policies, or external effects.
- Requiring a vector database for initial candidate ranking.
- General free-form runtime replanning for every failure.
- Claiming every Library domain is executable merely because it contains agent descriptions.
- Automatically deploying, merging, pushing, deleting, spending, or changing production because a goal prompt implies it.

## 7. Product Decision: Review-Gated Design And Policy-Gated Execution

Goal Design confirmation and execution approval are separate gates:

- `review_before_compose` is the default Goal Design mode. Southstar produces the full Goal Design Package, renders it in the Goal message box, and waits for one confirmation before calling the composer.
- `auto_until_blocked` is an opt-in user/workspace default or per-goal override. It skips the design confirmation only when the package validates and has no blocking inputs.
- high-risk execution still uses the existing durable approval policy in both modes. Auto mode never bypasses authority approval.

The Goal Design mode is selected before submission and persisted with the package revision. Changing the user/workspace default affects future goals, not an active goal revision. Changing the mode of an already-persisted goal uses `Revise goal`, creates a new package revision/hash, and invalidates the prior confirmation; a toggle never mutates a confirmed package in place.

### 7.1 Goal Design package readiness

A Goal Design Package may reach `ready_for_review` or continue automatically to composition only when all of the following hold:

- the Goal Design Package, evaluator contracts, Slice Plan, and composition strategy pass deterministic validation;
- the workspace is explicit and allowed by workspace mount policy;
- the goal contract has no blocking missing inputs;

In `review_before_compose`, satisfying these conditions produces `ready_for_review`; the composer has not run. In `auto_until_blocked`, satisfying them calls the composer without a design-confirmation stop.

### 7.2 Post-composition scheduling conditions

A composed goal may auto-schedule only when all of the following hold:

- all blocking requirements have complete coverage;
- the selected Library closure is valid and frozen;
- the compiled DAG and manifest pass deterministic validation;
- the effective risk tag set contains no manual-risk tag;
- requested task capabilities are a subset of the compiled side-effect envelope.

Low-risk local work includes:

- reading and writing only inside the validated workspace;
- running local tests, builds, linters, and deterministic validators;
- producing local artifacts inside the run workspace;
- using approved tools that do not access secrets or create external effects.

### 7.3 Manual approval conditions

Reuse the existing approval policy and manual risk tags:

- `secret-access`
- `external-write`
- `deployment`
- `delete`
- `cost-high`
- `production-change`

The effective risk set is the union of:

1. risks interpreted from the goal;
2. risks implied by selected tools, MCP grants, vault policies, and workspace policies;
3. risks introduced by a later workflow revision.

An approval is valid only for the exact:

- goal contract hash;
- manifest hash;
- Library snapshot hash;
- risk tag set;
- selected tool/MCP/vault/side-effect refs.

Changing any of these invalidates the approval and re-runs approval policy.

Auto approvals and manual approvals are both persisted as the existing `approval` runtime resource plus `approval.requested` / `approval.decided` history. Auto approval is evidence, not an omitted step.

### 7.4 Blocking ambiguity

Blocking ambiguity is not treated as a risk approval. It returns `needs_input` before run creation when Southstar cannot determine a safe, testable outcome, for example:

- the target workspace or source artifact is missing;
- two materially different outcomes are equally plausible;
- no measurable completion condition can be derived;
- the requested effect requires user-specific data or authority that was not supplied.

Non-blocking detail is resolved by an explicit assumption recorded in the goal contract. Southstar must not ask questions merely to improve wording or choose between equivalent implementation details.

## 8. Target Data Flow

```text
User prompt + selected workspace + client idempotency key
  -> Southstar Goal Design Skill discovers workspace and Library vocabulary
  -> clarify only information unavailable from prompt/workspace/Library and unsafe to infer
  -> produce provisional slice hypotheses for reasoning only
  -> produce and schema-validate GoalContract
  -> if blocking missing input: persist draft(needs_input), return
  -> produce requirement evaluator contracts
  -> produce and validate GoalSlicePlan
  -> select and validate batch | staged | child-runs composition strategy
  -> persist versioned GoalDesignPackage
  -> if review_before_compose: render Goal message box and wait for confirmation
  -> resolve domain/global approved Library candidates
  -> validate executable closure and rank bounded candidates
  -> compose current batch/stage DAG from the validated slices + generated run-scoped profiles + nodePromptSpec
  -> validate composition
  -> compile manifest + requirement coverage + Library snapshot
  -> validate hashes, coverage, manifest, and risk envelope
  -> persist validated planner draft
  -> create workflow run/tasks and run-scoped Library snapshot
  -> persist approval decision
  -> if pending approval: keep run created, return awaiting_approval
  -> if approved: startRunSchedulingPg(runId)
  -> existing scheduler/context/session/brain/hand/Tork path
  -> callback artifacts + evaluator results + evidence refs
  -> requirement outcome gate
  -> satisfied | bounded repair/reverify | unsatisfied | needs_input
```

All externally observable transitions are persisted before the response or stream reports them.

## 9. Goal Contract

The existing `RequirementSpecV2` becomes a compatibility projection of one persisted `GoalContractV1`; it is not maintained as a second mutable interpretation.

```ts
type GoalContractV1 = {
  schemaVersion: "southstar.goal_contract.v1";
  originalPrompt: string;
  promptHash: string;
  revision: number;
  workspace: {
    cwd: string;
    projectRef?: string;
  };
  domain: string;
  intent: string;
  summary: string;
  requirements: Array<{
    id: string;
    statement: string;
    acceptanceCriteria: string[];
    blocking: boolean;
    source: "explicit" | "inferred";
  }>;
  expectedArtifactRefs: string[];
  requiredCapabilities: string[];
  nonGoals: string[];
  assumptions: string[];
  blockingInputs: string[];
  riskTags: string[];
  requestedSideEffects: string[];
};
```

Rules:

- Requirement ids are stable inside a draft revision lineage.
- Every requirement has observable acceptance criteria; execution strategy and evaluator bindings remain outside the contract.
- Explicit requirements are never silently removed by revision or repair.
- Inferred requirements may be refined, but the refinement is recorded in draft history.
- `blockingInputs.length > 0` produces draft status `needs_input` and no run.
- The contract is stored inside the `planner_draft` payload and summary; no new table is required.
- The contract hash is copied into run runtime context and all approvals.
- `requiredCapabilities` contains semantic needs such as `code-review`, not concrete Agent, Skill, Tool, MCP, or Library object refs.
- The original prompt is immutable. Steering creates a new revision and preserves prior revisions for audit.
- A contract hash change invalidates prior coverage, manifest, Library snapshot, and approval projections before execution may continue.

Interpretation may use an LLM, but the output must pass deterministic schema and policy validation. The interpreter cannot grant tools, MCP access, vault access, or execution authority.

### 9.1 Southstar Goal Design Skill

`southstar-goal-design` is a persisted SOP, not a second workflow engine. It borrows the useful behavior of brainstorming and writing-plans while remaining domain-neutral:

1. inspect the selected workspace and approved Library vocabulary;
2. clarify only blocking choices that cannot be discovered or safely inferred;
3. use provisional slice hypotheses to expose ambiguity, without persisting them as execution truth;
4. finalize the Goal Contract;
5. derive evaluator contracts for every blocking requirement;
6. derive the final Slice Plan from the contract and evaluator boundaries;
7. choose the composition strategy;
8. persist one hash-bound Goal Design Package.

The skill does not select agents, skills, tools, MCP grants, vault policies, or execution profiles. Those decisions remain Library-constrained composer responsibilities.

Workspace- or Library-discoverable detail is recorded as an assumption or discovery responsibility, not a blocking user question. High-impact choices that change acceptance, authority, money, deployment, deletion, or other irreversible effects remain blocking.

### 9.2 Evaluator Contracts

Evaluator contracts are defined before the final Slice Plan because evidence boundaries help determine which requirements form one atomic outcome slice.

```ts
type RequirementEvaluatorContractV1 = {
  schemaVersion: "southstar.requirement_evaluator_contract.v1";
  id: string;
  requirementId: string;
  acceptanceCriteria: string[];
  requiredEvidenceKinds: string[];
  independence: "independent";
  failureClassifications: string[];
};
```

The evaluator contract describes evidence and verdict semantics. It does not select the concrete evaluator profile; the composer binds an approved Library evaluator that can satisfy it.

### 9.3 Goal Slice Plan

```ts
type GoalSlicePlanV1 = {
  schemaVersion: "southstar.goal_slice_plan.v1";
  goalContractHash: string;
  revision: number;
  slices: Array<{
    id: string;
    requirementIds: string[];
    outcome: string;
    stateOrArtifactOwner: string;
    mutationBoundary: string;
    expectedArtifactRefs: string[];
    evaluatorContractRefs: string[];
    dependsOnSliceIds: string[];
    dependencyArtifactRefs: string[];
    mergeReason?: string;
  }>;
};
```

Slice rules:

- Every blocking requirement has exactly one owner slice. If one statement spans independent outcome boundaries, Goal Design first decomposes it into separately identified requirements.
- Requirements may share a slice only when they share the same state/artifact owner, atomic mutation boundary, and compatible evaluator evidence boundary; `mergeReason` records why.
- Slice dependencies exist only when the downstream slice consumes a declared upstream artifact. Preferred ordering alone is not a dependency.
- The slicer targets the smallest cohesive outcome slices, never a fixed slice or task count.
- A Slice Plan contains no agents, tools, profiles, task node types, or template slots.
- Slice ids remain stable across compatible revisions. Splits, merges, and dependency changes create a new Slice Plan revision and preserve the prior resource.

### 9.4 Composition Strategy

```ts
type CompositionStrategyV1 =
  | { mode: "batch"; sliceIds: string[] }
  | {
      mode: "staged";
      stages: Array<{
        id: string;
        sliceIds: string[];
        entryArtifactRefs: string[];
      }>;
    }
  | {
      mode: "child-runs";
      groups: Array<{
        id: string;
        sliceIds: string[];
        workspaceRef: string;
      }>;
    };
```

- `batch` is the default when all slices, Library candidates, and dependencies are already knowable. The composer generates one manifest containing parallel subgraphs.
- `staged` is used when accepted artifacts from an earlier stage materially affect later Library resolution or DAG design. Each stage appends a manifest revision to the same logical run; it does not create unrelated workflow truth.
- `child-runs` is reserved for different workspace, authority, approval, deployment/rollback, cancellation, or independently terminal lifecycle boundaries. Slice count alone never selects this mode.

The composer may split one slice into several tasks, but it may not merge unrelated slices or change requirement ownership. Every task carries `sliceId` and `requirementIds`. A producer-to-producer dependency is valid only when the consumer declares an upstream `outputArtifactRef` in its `inputArtifactRefs`. If the composer discovers that the Slice Plan is not executable, it returns `slice_plan_revision_required` instead of silently rewriting it.

### 9.5 Goal Design Package And Versioning

```ts
type GoalDesignPackageV1 = {
  schemaVersion: "southstar.goal_design_package.v1";
  revision: number;
  parentRevision?: number;
  goalContract: GoalContractV1;
  evaluatorContracts: RequirementEvaluatorContractV1[];
  slicePlan: GoalSlicePlanV1;
  compositionStrategy: CompositionStrategyV1;
  goalContractHash: string;
  evaluatorContractsHash: string;
  slicePlanHash: string;
  packageHash: string;
  mode: "review_before_compose" | "auto_until_blocked";
};
```

The package is persisted in the existing planner/runtime resource model; no new table is required. Confirmation binds to `packageHash`. Contract, evaluator, Slice Plan, strategy, or mode changes create a new immutable package revision and invalidate derived composition, manifest, snapshot, and non-terminal confirmation state.

## 10. Requirement Coverage

The compiler produces a coverage projection alongside the manifest:

```ts
type GoalRequirementCoverageV1 = {
  schemaVersion: "southstar.goal_requirement_coverage.v1";
  goalContractHash: string;
  entries: Array<{
    requirementId: string;
    producerTaskIds: string[];
    artifactRefs: string[];
    evaluatorTaskIds: string[];
    evaluatorProfileRefs: string[];
    requiredEvidenceKinds: string[];
  }>;
};
```

Validation fails when:

- a blocking requirement has no producer;
- a blocking requirement has no evaluator;
- an evaluator is the same task as every producer for that requirement;
- a required artifact has no evaluator profile;
- a required evidence kind cannot be produced by the selected evaluator/tool closure;
- a DAG task produces no required artifact and contributes to no coverage entry, unless it is an explicit coordination/summary task.

The coverage projection is persisted in the planner draft and copied into the run manifest/runtime context. It is visible in Workflow and Operator read models.

## 11. Domain-Aware Library Resolution

Candidate resolution uses the goal contract domain instead of `all` plus a software manifest override.

Eligible objects are:

- approved objects in the selected domain;
- approved `global` objects;
- explicitly compatible objects connected by approved cross-domain edges.

Initial ranking remains deterministic and uses existing data:

1. exact required capability and artifact edges;
2. domain match;
3. approved executable closure completeness;
4. title, alias, tag, and description token matches;
5. template slot fit;
6. stable object-key tie break.

Only the ranked bounded packet is sent to the composer. Vector similarity may be added only after measured retrieval failures; the current empty similarity index is not a prerequisite.

A domain is not advertised as executable unless the requested goal can close this chain:

```text
required capability
  -> agent or generated run-scoped profile
  -> skill/instruction
  -> allowed tools/MCP/vault
  -> required artifact contract
  -> evaluator capable of required evidence
  -> supported runtime harness
```

Missing closure produces an unavailable requirement or Library proposal. It does not authorize the composer to invent refs.

## 12. Immutable Run Library Snapshot

At successful compile time, Southstar resolves every selected executable ref and creates:

```ts
type RunLibrarySnapshotV1 = {
  schemaVersion: "southstar.run_library_snapshot.v1";
  draftId: string;
  goalContractHash: string;
  manifestHash: string;
  entries: Array<{
    objectKey: string;
    objectKind: string;
    versionRef: string;
    stateHash: string;
    state: Record<string, unknown>;
  }>;
};
```

Snapshot rules:

- Include selected agents, skills, instructions, tools, MCP grants, vault policies, artifact contracts, evaluators, policies, and templates.
- Never include secret values; only vault policy refs and non-secret runtime configuration are allowed.
- Persist the draft snapshot with the planner draft.
- In the same run-creation transaction, persist an immutable run-scoped `library_snapshot` runtime resource.
- Set manifest `compiledFrom.libraryVersionRefs` and `compiledFrom.librarySnapshotRef`.
- Copy the snapshot ref and hash into `workflow_runs.runtime_context_json`.
- `runtime-library-materializer.ts` must load selected refs from the run snapshot and fail closed when a ref is missing or its hash is invalid.
- Editing or approving a newer Library head never changes an existing run.

For the first implementation, the run snapshot is sufficient for replay. Populating a general historical Library version store is deferred until a second consumer needs it.

If a selected Library object changes between draft validation and run creation, run creation fails with `draft_library_snapshot_stale`; it does not silently recompile.

Any task profile override or DAG revision marks the draft `needs_validation` and invalidates its prior coverage, snapshot, manifest hash, and approval. Validation must rebuild all four projections; manifest-only validation is insufficient after an executable ref changes.

## 13. Deepening `/api/v2/run-goal`

The existing route remains the single external submission seam for one-prompt Goal Design. Confirmation is a command on that persisted planner draft, not a second submission path.

```ts
type RunGoalRequest = {
  goalPrompt: string;
  cwd: string;
  idempotencyKey?: string;
  goalDesignMode?: "review_before_compose" | "auto_until_blocked";
};

type RunGoalResult = {
  goalDesignPackageHash?: string;
  goalContractHash: string;
  draftId: string;
  draftStatus: "needs_input" | "invalid" | "ready_for_review" | "validated";
  runId?: string;
  runStatus?: "awaiting_approval" | "scheduling";
  approvalId?: string;
  blockers: string[];
};
```

The prompt remains the only required user-authored input. The UI supplies `cwd`, a client-generated idempotency key, and the current workspace/user Goal Design mode. Omitting the mode uses `review_before_compose`.

Behavior:

- Repeating the same idempotency key returns the same durable result.
- A different idempotency key may intentionally create a new run for the same prompt.
- JSON remains available for CLI/MCP clients.
- When the request accepts `text/event-stream`, the same route streams persisted stages and ends with the same result shape.
- Reuse the existing planner SSE event utilities; do not create a second orchestration implementation.
- Review mode persists `ready_for_review` after the complete Goal Design Package and returns without calling the composer or creating a run.
- `POST /api/v2/planner/drafts/:draftId/confirm-goal-design` confirms the exact package hash, resumes candidate resolution/composition, and is idempotent. The planner draft remains the Goal Design identity; no parallel Goal Design aggregate or id is introduced.
- Revising the Goal message creates a new package revision and invalidates the prior confirmation.
- A validated low-risk goal calls the existing `startRunSchedulingPg()` before reporting `scheduling`.
- A high-risk goal creates the run and pending approval but does not start scheduling.
- Approval of the matching hashes starts scheduling through the same controller.

Goal Design Package revisions are persisted on the planner draft before any run exists. After confirmation or Auto continuation, run rows, task rows, the run-scoped Library snapshot, and the approval decision are created atomically. Scheduling starts only after that run-creation transaction commits. If scheduler wakeup fails, the persisted run remains non-running and records an operational exception; the submission can retry the existing controller idempotently rather than creating another run.

The Workflow UI default action remains one Goal submission. In review mode the only additional product gate is `Confirm & compose` on the Goal message box. Users do not press separate Draft, Validate, Run, and Execute actions. Auto mode removes the Goal Design confirmation but preserves any policy-required execution approval.

## 14. Evidence-Gated Outcome

Task artifact acceptance remains a local contract gate needed for downstream DAG dependencies. It is not by itself proof that the goal is satisfied.

For each blocking requirement, the outcome gate requires an `evaluator_result` with:

```ts
type RequirementEvaluatorResultV1 = {
  schemaVersion: "southstar.requirement_evaluator_result.v1";
  requirementIds: string[];
  artifactRefs: string[];
  evaluatorId: string;
  evaluatorTaskId?: string;
  evaluatorProfileRef: string;
  verdict: "passed" | "failed" | "blocked";
  evidenceRefs: string[];
  findings: string[];
};
```

Evidence may include:

- command, arguments, exit status, output hash, and workspace snapshot ref;
- artifact schema validation result;
- browser assertion and screenshot ref;
- content comparison or deterministic calculation;
- external postcondition evidence for an approved external effect;
- a structured semantic evaluation from an evaluator task distinct from the producer.

Rules:

- A producer callback saying `ok: true` cannot satisfy a blocking requirement by itself.
- A producer may locally validate its output, but every blocking requirement must also have a distinct evaluator task or deterministic evaluator owned by Southstar.
- Callback ingestion links accepted artifacts to evaluator result refs when evaluation completes.
- Missing required evidence produces `blocked`, not an inferred pass.
- Summary tasks may report the outcome but cannot create a passing verdict that is absent from evaluator results.

`evaluateRunCompletionGatePg()` becomes the single persisted outcome gate. It consumes the goal contract, coverage projection, artifacts, evaluator results, task state, and runtime blockers.

## 15. Three Separate Status Axes

Operator and Workflow read models expose:

```ts
type RunOutcomeStatus = "in_progress" | "satisfied" | "unsatisfied" | "needs_input";
type RunOperationalHealth = "healthy" | "degraded" | "incident";
type RunExecutionStatus =
  | "created"
  | "awaiting_approval"
  | "scheduling"
  | "running"
  | "paused"
  | "evaluating"
  | "blocked"
  | "terminal";
```

No new database columns are required initially:

- execution status continues to use `workflow_runs.status` as the compatibility lifecycle projection;
- outcome is persisted in the existing `evaluator_result` resource for the completion gate;
- operational health is projected from runtime exceptions, recovery decisions, bindings, and policy violations.

Terminal rules:

- `satisfied`: all blocking requirements have passing evaluator evidence.
- `unsatisfied`: at least one blocking requirement has terminal failed evidence and no remaining repair path.
- `needs_input`: required intent or authority cannot be safely inferred.
- unresolved warning-level operational events may yield `satisfied + degraded`;
- an unresolved operational blocker keeps execution `blocked` and outcome `in_progress`; it does not invent `unsatisfied`.

For compatibility, `workflow_runs.status = passed` corresponds to `outcome=satisfied`, and `failed` corresponds to `outcome=unsatisfied`. Operational warnings alone must not set `failed`.

## 16. Dynamic Repair And Capability Escalation

Failure classification determines the next action:

- **evidence failure:** append bounded repair/reverify nodes using the existing dynamic revision path;
- **infrastructure failure:** use executor/session/hand recovery without changing the goal DAG;
- **intent failure or missing authority:** pause with `needs_input` or pending approval;
- **policy violation:** block and route to Operator; never repair by weakening policy.

Dynamic repair must preserve:

- original explicit requirements and non-goals;
- goal contract hash lineage;
- prior accepted artifact lineage;
- bounded repair round limits;
- the approved side-effect envelope.

If repair needs a Library ref or side effect outside the run snapshot/approval envelope:

1. persist the proposed revision;
2. create a new approval bound to the revised hashes and risk refs;
3. pause scheduling of the new tasks;
4. snapshot the newly approved refs only after approval;
5. never mutate prior snapshot entries.

## 17. `design/article` Cross-Domain Proof

The first non-software vertical slice is an offline article workflow. Example goal:

> 將 workspace 內的 `input.md` 編輯成可離線開啟的單檔 HTML 文章，保留原文事實，輸出 `article.html`，並驗證沒有外部資源依賴與必要章節均存在。

The Library must supply through the normal file/import/sync path:

- a `design/article` domain taxonomy;
- approved article editor/designer agent definitions or generated run-scoped profiles;
- approved article skill and instruction refs;
- only local file read/write and validation tools;
- an HTML article artifact contract;
- evaluators for required sections, offline resource closure, HTML validity, and visual/browser evidence;
- a supported Pi/Tork execution profile.

Acceptance evidence includes:

- `article.html` exists inside the workspace;
- required sections derived from the goal contract are present;
- all script/style/image resources are inline or local as required by the artifact contract;
- deterministic HTML checks pass;
- the browser can open the artifact without network dependencies;
- evaluator results reference the artifact and captured evidence.

No production content is added through hardcoded seed code.

## 18. Error Handling

| Condition | Durable result | Run behavior |
|---|---|---|
| Blocking goal input missing | draft `needs_input` | no run |
| Complete package in default review mode | draft `ready_for_review` | no composer and no run |
| Confirmation hash is stale | confirmation rejected | no composer and no run |
| No executable Library closure | draft `invalid` with unavailable requirements | no run |
| Composer output invalid after repair limit | draft `invalid` with attempts | no run |
| Draft Library snapshot stale | run creation error and draft `needs_validation` | no run |
| Manual risk tag present | approval `pending` | run created, not scheduled |
| Approval rejected | approval `rejected` | run cancelled or remains non-schedulable |
| Runtime asks for new authority | new approval `pending` | affected tasks paused |
| Evaluator evidence missing | evaluator result `blocked` | outcome not satisfied |
| Evidence fails and repair remains | dynamic repair revision | run continues |
| Evidence fails after repair limit | outcome `unsatisfied` | terminal failed |
| Warning operational incident after outcome pass | outcome `satisfied`, health `degraded` | terminal passed |

## 19. Security Invariants

- Goal interpretation never grants authority.
- Goal Design confirmation authorizes composition of one exact package hash; it does not authorize tools, secrets, external effects, or scheduling that policy would otherwise block.
- Candidate resolution only returns approved, scope-compatible Library objects.
- Secrets never appear in goal contracts, manifests, Library snapshots, history, prompts, or evaluator evidence.
- Vault snapshots contain policy and lease refs, never secret values.
- Tool/MCP/vault selections are included in risk evaluation and approval hashes.
- The tool proxy still fails closed before execution.
- A workflow revision cannot expand authority without a new approval.
- Workspace mount validation occurs before goal persistence is allowed to authorize file effects.
- External effects require persisted intent and approval before dispatch.

## 20. Read Models And UI

The first version does not add a standalone Goal page, Goal Design workbench layout, wizard, or replacement canvas. It preserves the existing Workflow layout, message stream, input placement, DAG block, node selection, sidecar, and Operator boundaries.

### 20.1 Goal message box

Goal Design is presented as a structured Goal message inside the existing Workflow message stream. It reuses the current message rendering pattern and expands the existing Goal Contract card rather than creating a new page or panel layout.

The Goal message box shows:

- interpreted outcome and Goal Contract revision;
- top-level acceptance criteria and evaluator coverage;
- selected workspace and execution scope;
- assumptions and blocking inputs;
- expected deliverables;
- risk tags and requested side effects;
- Slice Plan as compact rows/cards with slice outcome, requirement count, output artifacts, and upstream dependencies;
- composition strategy (`batch`, staged waves, or child-run groups) and its reason;
- Goal Design mode and package revision/hash;
- status `designing | needs_input | ready_for_review | composing | awaiting_approval | scheduling | running | terminal`;
- a `Revise goal` action;
- in review mode, one `Confirm & compose` action bound to the displayed package hash;
- the selected review/Auto mode as read-only package metadata.

The Auto switch lives with the existing Goal input controls and selects the mode before submission. A user/workspace preference may set its default for future goals. Once a Goal Design Package exists, changing its mode goes through `Revise goal` and produces a new package revision/hash; the message never mutates the active package mode in place.

The Slice Plan appears in this Goal message box before DAG composition. It does not render a second canvas. After confirmation or Auto continuation, the generated DAG is emitted as the existing `WorkflowDagBlock` in the same message flow and uses the existing Workflow canvas/layout unchanged.

In `review_before_compose`, the Goal Design Skill completes the entire package and pauses once at `ready_for_review`. It does not require confirmation after every internal phase. In `auto_until_blocked`, a valid package continues automatically. Blocking input expands the exact question in the same Goal message. High-risk effects show the existing durable approval UI after composition; Goal confirmation is not an authority approval.

### 20.2 Goal Contract sidecar

Selecting the Goal message opens the existing Workflow sidecar/resource viewer pattern. It presents grouped product concepts rather than raw JSON:

- requirements and acceptance criteria;
- deliverables;
- boundaries and non-goals;
- assumptions and blocking inputs;
- risk and requested side effects;
- coverage and evaluator evidence;
- revisions and provenance, including the original prompt and contract hash;
- evaluator contracts, Slice Plan revisions, composition strategy, and Goal Design Package hash.

Operator may render the same contract projection read-only beside run health and recovery controls. It does not maintain a second editable contract.

### 20.3 Standalone-page threshold

A standalone page is deferred until Goal Contracts become reusable across runs, independently searchable, collaboratively reviewed, or managed as first-class versioned product objects.

Until that threshold is met, no new Goal tab panel layout, stage rail, split-pane workbench, or duplicate DAG visualization is added.

Operator shows:

- outcome and health as separate columns/badges;
- approvals with the exact goal/manifest/snapshot hashes they authorize;
- uncovered or failed requirements;
- runtime incidents independently from product outcome;
- repair revisions and authority changes.

Project scope must be explicit. A project-filtered empty Operator view must not look like a system-wide zero-run result.

## 21. Acceptance Criteria

- **AC-01 One submission:** one user action submits prompt plus selected workspace and returns a durable Goal Design/draft identity; review mode does not create a run before confirmation.
- **AC-02 Default review gate:** default mode persists a complete Goal Design Package and reaches `ready_for_review` without calling the composer or creating a run; one hash-bound confirmation resumes composition.
- **AC-02A Optional auto-run:** Auto mode persists an auto approval and lets a low-risk complete goal reach `scheduling` without another click.
- **AC-03 High-risk pause:** a goal selecting any manual-risk capability creates a pending approval and does not schedule.
- **AC-04 Ambiguity pause:** blocking missing input creates a `needs_input` draft and no run.
- **AC-05 Domain truth:** the article goal compiles as `design/article`; it does not inherit a software domain or software-only artifacts.
- **AC-06 Bounded candidates:** candidate resolution sends only ranked, scope-compatible, executable candidates to the composer.
- **AC-07 Coverage:** every blocking requirement has producer, artifact, evaluator, and evidence mappings.
- **AC-08 Independent result:** a producer self-report cannot satisfy a blocking requirement without evaluator evidence.
- **AC-09 Immutable Library:** changing a Library head after run creation does not change any later TaskEnvelope for that run.
- **AC-10 Replay evidence:** the run exposes selected object keys, versions, state hashes, snapshot hash, manifest hash, and goal contract hash.
- **AC-11 Stale draft:** changing a selected Library head before run creation invalidates the draft instead of silently recompiling.
- **AC-12 Outcome/health split:** a logically satisfied goal with warning-level stale callbacks can report `satisfied + degraded`, not `unsatisfied`.
- **AC-13 Blocking incident:** a critical unresolved runtime incident keeps execution blocked and outcome in progress.
- **AC-14 Bounded repair:** failed evaluator evidence appends repair/reverify tasks within the configured round limit.
- **AC-15 No silent escalation:** a repair requiring new side effects pauses for a new hash-bound approval.
- **AC-16 No auto Library promotion:** generated profiles/templates remain run-scoped or proposal/draft until separately approved.
- **AC-17 Cross-domain E2E:** real Postgres/Tork/Pi E2E passes for one software goal and the offline `design/article` goal.
- **AC-18 Browser flow:** browser E2E submits one low-risk prompt, observes the Goal message with Contract/evaluator/Slice Plan/strategy, confirms once in review mode, then observes the existing DAG layout, scheduling, evidence, and satisfied outcome. A second Auto-mode case has no design confirmation click.
- **AC-19 Contract detail:** selecting the Goal message opens the existing sidecar with acceptance criteria, evaluator contracts, Slice Plan, strategy, scope, risks, coverage, revisions, hashes, and provenance.
- **AC-20 No new layout:** Goal Design uses the existing Workflow message layout, `WorkflowDagBlock`, canvas, sidecar, and input placement; no standalone form, replacement canvas, Goal workbench layout, or duplicate Slice DAG is introduced.
- **AC-21 Natural slicing:** software, article, research, or other contracts derive slice count from state/artifact ownership, atomic mutation boundary, evidence boundary, and artifact flow; no domain or requirement count hardcodes the result.
- **AC-22 Slice dependency truth:** a producer slice/task dependency is rejected unless the downstream input explicitly consumes an upstream artifact.
- **AC-23 Strategy versioning:** batch/staged/child-run strategy, Slice Plan, evaluator contracts, and package hashes are persisted and revisioned; staged composition appends manifest revisions to the same logical run.

## 22. Verification Strategy

### 22.1 Focused tests

- Goal interpreter schema, domain, assumptions, risk tags, and blocking-input behavior.
- Goal requirement acceptance criteria and semantic capability validation.
- Goal contract to `RequirementSpecV2` compatibility projection.
- Goal Design mode defaults, per-goal override, package hashing, confirmation invalidation, and idempotent resume.
- Evaluator-contract completeness and evidence-boundary validation.
- Natural Slice Plan coverage, merge-boundary validation, stable slice ids, artifact-flow dependencies, and cycle rejection.
- Batch/staged/child-run strategy validation without slice-count heuristics.
- Deterministic candidate ranking and executable-closure rejection.
- Coverage completeness and producer/evaluator separation.
- Approval hash binding and invalidation.
- Library snapshot creation, hash validation, and secret exclusion.
- Runtime materialization from snapshot rather than current Library head.
- Outcome evaluation from requirement evaluator results.
- Operational warning versus blocking incident classification.

### 22.2 Integration tests

- `/api/v2/run-goal` low-risk auto scheduling.
- `/api/v2/run-goal` default `ready_for_review` package persistence without composer/run creation.
- Goal Design confirmation resumes the exact package once; stale package confirmation fails closed.
- `/api/v2/run-goal` high-risk pending approval.
- Approval decision starts the exact approved run revision.
- Planner draft becomes stale when selected Library heads change.
- Callback ingestion links evaluator results and evidence to covered requirements.
- Dynamic repair preserves requirements and stops on authority expansion.
- Goal steering creates a new contract revision and invalidates stale derived projections.

### 22.3 Real E2E gates

Run real infrastructure tests only when explicitly executing this implementation plan:

1. software goal: prompt to validated evidence and satisfied outcome;
2. `design/article` goal: input Markdown to offline HTML plus deterministic and browser evidence;
3. Library head changes during an active run, but later task materialization remains unchanged;
4. verifier failure appends repair/reverify and completes within the bound;
5. high-risk tool selection pauses before Tork submission.
6. review-mode browser flow renders the Slice Plan in the existing Goal message box and reuses the unchanged Workflow DAG layout after one confirmation;
7. Auto-mode browser flow skips only Goal Design confirmation and still honors high-risk approval.

## 23. Implementation Boundaries

Expected existing seams to deepen:

- Southstar Goal Design skill/SOP and typed Goal Design Package resources
- Goal message rendering through the existing `MessageView` / Goal Contract card pattern
- `src/v2/orchestration/requirement-analyzer.ts`
- `src/v2/orchestration/candidate-resolver.ts`
- `src/v2/orchestration/composition-validator.ts`
- `src/v2/orchestration/composition-compiler.ts`
- `src/v2/ui-api/postgres-run-api.ts`
- `src/v2/server/planner-routes.ts`
- `src/v2/server/run-execution-controller.ts`
- `src/v2/orchestration/runtime-library-materializer.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/evaluators/completion-gate.ts`
- existing approval policy/routes/read models
- `web/hooks/useWorkflowLifecycle.ts`

New code should be limited to deep modules that own a real invariant, principally goal-contract validation/coverage and run Library snapshot handling. Do not add interfaces for dependencies that have only one adapter.

Large existing transaction functions should not be split merely because of line count. Extract internal helpers only where the new goal, snapshot, approval, or evidence invariants need an independently testable seam.

## 24. Implementation Order

The first releasable gate includes all safety and correctness prerequisites for one-prompt execution:

1. Southstar Goal Design SOP, Goal Contract interpretation, `needs_input`, and Library-aware vocabulary discovery.
2. Evaluator contracts, Goal Slice Plan, composition strategy, package hashing, and default review/optional Auto modes.
3. Domain-aware candidate ranking and executable closure.
4. Slice-constrained composition, requirement coverage compilation, and artifact-flow validation.
5. Immutable run Library snapshot and snapshot-backed materialization.
6. Hash-bound Goal Design confirmation, policy approval, and `/run-goal` scheduling.
7. Evaluator evidence linkage and outcome/health separation.
8. Goal message presentation in the unchanged Workflow layout.
9. Software plus `design/article` real E2E in review and Auto modes.

Dynamic learning and broader domain expansion follow only after these acceptance criteria pass. They do not weaken this first release gate.

## 25. Rejected Alternatives

### 25.1 UI-only auto-clicking

Rejected because it removes clicks without improving interpretation, reproducibility, approval, or evidence quality.

### 25.2 A second autonomous orchestrator loop

Rejected because the current analyzer/resolver/composer/validator/compiler path is already the correct seam. A second loop would create competing workflow truth.

### 25.3 Reading current Library head during dispatch

Rejected because it makes a persisted manifest non-reproducible.

### 25.4 Treating every runtime incident as product failure

Rejected because operational health and requested outcome answer different questions.

### 25.5 Letting a larger prompt solve correctness

Rejected because prompt instructions cannot replace immutable inputs, deterministic policy, coverage validation, or evaluator evidence.

### 25.6 A new Goal Design workbench or Slice DAG

Rejected because the existing Workflow message stream, Goal Contract card, DAG block, canvas, sidecar, and approval surfaces already own the required interaction boundaries. A second layout or Slice DAG would duplicate workflow truth and teach users two navigation models.

### 25.7 Fixed slice counts or domain-specific slice templates

Rejected because requirement count and domain labels do not determine cohesive delivery boundaries. Slice grouping must follow state/artifact ownership, atomic mutation, evaluator evidence, and actual artifact flow.

## 26. Final Decision

Southstar will use review-gated Goal Design plus policy-gated execution:

- default: build and persist one complete Goal Design Package, show Contract/evaluator/Slice Plan/strategy in the existing Goal message box, and wait for one hash-bound confirmation before composition;
- optional Auto mode: low-risk and complete goals continue through composition and scheduling without the design confirmation;
- blocking ambiguity: ask only the blocking question;
- high-risk or expanded authority: durable approval;
- slicing: derive cohesive slices from state/artifact ownership, atomic and evaluator boundaries, and artifact flow, never a fixed count;
- composition: batch by default, staged revisions when later composition depends on accepted artifacts, child runs only for independent lifecycle boundaries;
- execution: current Postgres/scheduler/Tork runtime;
- correctness: Goal Contract coverage plus independent evaluator evidence;
- reproducibility: immutable run Library snapshot;
- reporting: outcome, execution, and operational health as separate projections.

The existing Workflow layout remains the product shell. Goal Design appears as a structured Goal message, and the existing DAG block/canvas appears after composition; no new Goal workbench layout is introduced.

This is the product contract required before Southstar can truthfully promise “give it one prompt, review or auto-accept the intended outcome design, and get evidence for the result.”

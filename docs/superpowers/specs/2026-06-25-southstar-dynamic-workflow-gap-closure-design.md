# Southstar Dynamic Workflow Gap Closure Design

Date: 2026-06-25
Status: design draft

## 1. Context

Southstar dynamic workflow composition now has a working `llm-constrained` path:

- candidate resolution from approved library graph objects
- strict `LlmWorkflowComposer` JSON contract
- composition repair loop
- deterministic composition validator and compiler
- runtime library materialization into task envelopes
- real E2E coverage for dynamic workflow materialization

The remaining gap is not workflow generation itself. The current `llm-constrained` path proves that Southstar can ask an LLM to compose a workflow DAG from approved library candidates, then route the result through deterministic validation, compilation, and runtime materialization.

The remaining work is to make that dynamic workflow path production-grade:

- API consumers need to inspect planner drafts before run creation.
- Validator coverage must prove artifact flow and template slot compatibility.
- Compiler/audit state must freeze only selected library versions and retain LLM trace evidence.
- Repair prompts must include the previous failed plan so the LLM can make targeted fixes.
- Generated component proposals need a lifecycle outside transient planner payloads.
- Runtime envelope materialization should consume compiled manifest library refs, with legacy alias maps contained at explicit compatibility boundaries.
- The current `software` scope hardcode must be removed in favor of domain/scope input, after the P0/P1 authority boundaries are stable.

This design includes those requirements as one phased dynamic workflow gap closure design. The implementation plan may still split them into multiple commits or execution batches, but the design target is the full gap list.

## 2. Goals

1. Add planner draft orchestration inspection:
   - `GET /api/v2/planner/drafts/:draftId/orchestration`
   - create draft response includes `status`, `validationIssues`, and `taskSummaries`
2. Extend validator coverage:
   - `inputArtifactRefs` must be satisfiable from upstream outputs or initial inputs
   - `templateSlotRef` must be compatible with selected template slot requirements
3. Improve compiler and audit correctness:
   - freeze only selected library version refs
   - persist sanitized `llmTrace`
   - include the previous failed plan in repair prompts
4. Add generated proposal lifecycle API so `generatedComponentProposals` do not remain only inside planner payloads.
5. Remove or contain legacy ref maps so new dynamic runtime envelopes consume compiled manifest library refs.
6. Add multi-domain/scope support and remove `software` hardcode from the dynamic workflow path.
7. Preserve existing no-UI scope and keep contracts usable by CLI, tests, API consumers, and future UI.

## 3. Non-Goals

- No UI or DAG editor.
- No vector search.
- No recursive CTE requirement.
- No graph database or Postgres graph extension in this phase.
- No change to LLM provider or OAuth behavior.
- No direct exposure of raw `runtime_resources.payload_json` as public API.
- No LLM-created library object, tool grant, MCP grant, secret, or vault lease may become approved runtime authority without deterministic validation and explicit lifecycle.

## 4. Design Options

### Option A: Only enrich create draft response

This is the smallest change. It makes invalid drafts visible immediately, but it still forces API consumers to keep the original response around and gives no way to inspect a draft later.

### Option B: Add inspection endpoint and rich summaries

This adds a compact draft orchestration view. It keeps `runtime_resources` as internal storage and exposes a stable API contract for status, diagnostics, traces, workflow summary, and task summaries.

### Option C: Enforce approval before every run

This creates the strongest lifecycle gate but would break existing `POST /api/v2/run-goal`, case 28/29 behavior, and CLI assumptions. It is better as a later policy option after the API is observable.

### Recommendation

Use Option B as the API foundation, then execute the remaining validator/compiler/proposal/runtime/scope items as phased gap closure tasks. Run creation remains compatible: a `validated` draft can still materialize a run, and an `approved` draft can also materialize a run. Future policy can require approval by checking the same lifecycle fields.

## 4.5 Phased Gap Closure

| Phase | Requirement | Reason |
|---|---|---|
| P0 | Draft orchestration inspect API and rich create response | Makes LLM workflow output observable before execution |
| P0 | `inputArtifactRefs` upstream satisfiability | Prevents impossible DAGs where a task consumes artifacts nobody produced |
| P0 | `templateSlotRef` compatibility | Prevents LLM from placing agents/tasks into template slots that do not allow them |
| P1 | Selected-only version freeze | Makes audit snapshots precise and reproducible |
| P1 | Sanitized `llmTrace` | Supports diagnosis of composer/repair behavior without leaking raw prompts or secrets |
| P1 | Repair prompt includes previous plan | Gives the LLM enough context to repair, not regenerate blindly |
| P1 | Proposal lifecycle API | Moves generated proposals into reviewable durable state |
| P1 | Legacy ref map containment | Keeps compatibility while ensuring new workflows use compiled manifest refs |
| P2 | Multi-domain/scope | Removes `software` hardcode after authority and audit boundaries are stable |

## 5. Public API Contract

### 5.1 Planner Draft Summary

All draft creation and inspection responses share this summary shape:

```ts
type PlannerDraftSummary = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: "validated" | "invalid" | "approved" | "rejected" | "archived";
  canMaterialize: boolean;
  planner: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: "fixture" | "llm" | "llm-with-fixture-fallback" | string;
  validationIssues: Array<{ code: string; path: string; message: string }>;
  blockingReasons: string[];
  taskSummaries: PlannerDraftTaskSummary[];
};

type PlannerDraftTaskSummary = {
  taskId: string;
  name: string;
  dependsOn: string[];
  roleRef?: string;
  agentProfileRef?: string;
  agentDefinitionRef?: string;
  selectedLibraryRefs: {
    instructionRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
    inputArtifactRefs: string[];
    outputArtifactRefs: string[];
    evaluatorProfileRef?: string;
  };
};
```

Rules:

- `canMaterialize` is true only when `status` is `validated` or `approved` and there are no blocking validation issues.
- `validationIssues` contains deterministic validator or composer contract issues when available.
- `blockingReasons` is a compact human-readable list for API consumers. It is derived from status, unavailable requirements, validation issues, and missing workflow payload.
- `taskSummaries` is empty for invalid drafts without a compiled workflow.

### 5.2 Create Draft

```text
POST /api/v2/planner/drafts
```

Request:

```ts
type CreatePlannerDraftRequest = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: "fixture" | "llm" | "llm-with-fixture-fallback";
};
```

Response envelope:

```ts
{
  kind: "planner-draft",
  result: PlannerDraftSummary
}
```

The route still persists the full draft resource before responding. The response is a stable summary, not the raw resource payload.

### 5.3 Inspect Draft Orchestration

```text
GET /api/v2/planner/drafts/:draftId/orchestration
```

Response:

```ts
type PlannerDraftOrchestrationView = PlannerDraftSummary & {
  title?: string;
  workflow?: {
    workflowId: string;
    title: string;
    domain: string;
    intent: string;
    taskCount: number;
  };
  plannerTrace?: {
    model?: string;
    generatedAt?: string;
    analyzerType?: string;
    composerMode?: string;
    composerFallbackUsed?: boolean;
    validatorAttempts?: number;
    repairAttempts?: number;
    finalValidationOk?: boolean;
    candidatePacketHash?: string;
    compositionHash?: string;
  };
  orchestrationSnapshot?: {
    schemaVersion?: string;
    candidatePacketHash?: string;
    selectedTaskCount?: number;
    validationOk?: boolean;
    libraryVersionRefCount?: number;
  };
  repairAttempts: Array<{
    attempt: number;
    validationOk: boolean;
    issueCount: number;
  }>;
  actions: Array<{
    action: "approve" | "reject" | "materialize-run";
    allowed: boolean;
    reason?: string;
    endpoint?: string;
  }>;
};
```

Rules:

- The endpoint must work for both deterministic and `llm-constrained` drafts.
- It must not leak raw LLM prompts, raw LLM responses, secret values, or full candidate packet payload by default.
- The `orchestrationSnapshot` field is summarized because the full snapshot can contain large candidate details.
- Missing draft returns the existing API error envelope.

### 5.4 Draft Lifecycle Actions

```text
POST /api/v2/planner/drafts/:draftId/approve
POST /api/v2/planner/drafts/:draftId/reject
POST /api/v2/planner/drafts/:draftId/runs
```

Approve:

- Allowed only for `validated` drafts.
- Updates planner draft status to `approved`.
- Records `payload.lifecycle.approvedAt`, `payload.lifecycle.approvedBy`, and `payload.lifecycle.reason`.
- Idempotent when already approved.

Reject:

- Allowed for `validated`, `approved`, and `invalid` drafts.
- Updates planner draft status to `rejected`.
- Records `payload.lifecycle.rejectedAt`, `payload.lifecycle.rejectedBy`, and `payload.lifecycle.reason`.
- Rejected drafts cannot materialize runs.

Materialize run:

- Equivalent to existing `POST /api/v2/runs` with `{ draftId }`.
- Returns the richer run response defined below.
- Does not require approval in this slice. It accepts `validated` and `approved` drafts only.

### 5.5 Run Creation Response

`POST /api/v2/runs` and `POST /api/v2/planner/drafts/:draftId/runs` return:

```ts
type PostgresRunResult = {
  runId: string;
  draftId: string;
  workflowId: string;
  status: "created";
  taskIds: string[];
  taskSummaries: Array<{
    taskId: string;
    name: string;
    dependsOn: string[];
    roleRef?: string;
    agentProfileRef?: string;
  }>;
};
```

`POST /api/v2/run-goal` remains a convenience route. It creates a draft, materializes a run, and returns:

```ts
{
  draft: PlannerDraftSummary;
  runId: string;
  draftId: string;
  workflowId: string;
  status: "created";
  taskIds: string[];
  taskSummaries: PlannerRunTaskSummary[];
}
```

If draft creation produces an invalid draft, `run-goal` fails at materialization with the existing error envelope and leaves the invalid draft inspectable.

## 6. P0 Validator Contract Extensions

The composition validator remains deterministic and must not call an LLM. The LLM may propose a workflow DAG, but the validator decides whether the proposal can become runtime authority.

### 6.1 `inputArtifactRefs` Upstream Satisfiability

Every task `inputArtifactRefs` entry must be satisfiable from one of these sources:

- an initial input artifact declared by the planner request, requirement spec, or workflow template
- an output artifact produced by a task listed in `dependsOn`
- an output artifact produced by an indirect upstream ancestor reachable through `dependsOn`

Validation fails when a task consumes an artifact that is not available before the task runs. This blocks impossible DAGs such as a summary task requiring `artifact.verification_report` while depending only on an implementation task that produces `artifact.implementation_report`.

Validator issue:

```ts
{
  code: "input_artifact_not_satisfied",
  path: "tasks.<index>.inputArtifactRefs",
  message: "input artifact is not produced by an upstream task or initial input: <artifactRef>"
}
```

### 6.2 `templateSlotRef` Compatibility

`templateSlotRef` must refer to a slot declared by the selected `workflow_template`. The selected task must satisfy that slot's required capabilities and allowed node type constraints through approved library refs:

- selected `agentDefinitionRef` must provide the slot's required capabilities
- selected `outputArtifactRefs` must be compatible with slot artifact outputs when declared
- selected task dependency shape must match slot dependency requirements when declared

Validation fails if the LLM invents a slot or assigns a role/profile to a slot that the template does not allow.

Validator issues:

```ts
{ code: "unknown_template_slot", path: "tasks.<index>.templateSlotRef", message: "template slot is not declared: <slotRef>" }
{ code: "template_slot_capability_mismatch", path: "tasks.<index>.agentDefinitionRef", message: "agent does not satisfy template slot capability: <capabilityRef>" }
{ code: "template_slot_artifact_mismatch", path: "tasks.<index>.outputArtifactRefs", message: "task output is not allowed by template slot: <artifactRef>" }
```

## 7. P1 Compiler, Trace, And Repair Contract

### 7.1 Selected-Only Version Freeze

`orchestrationSnapshot.compiler.libraryVersionRefs` must freeze only library objects selected by the accepted composition plan:

- selected workflow template
- selected agent definitions
- selected agent profiles
- selected instructions
- selected skills
- selected tools
- selected MCP grants
- selected vault lease policies
- selected input and output artifact contracts
- selected evaluators
- selected policy refs if they become task-selected or manifest-selected

It must not freeze every candidate in the `CandidatePacket`. Candidate-wide freezing makes audits noisy and can imply that unselected roles/tools influenced runtime authority.

### 7.2 Sanitized `llmTrace`

Planner drafts should persist sanitized LLM orchestration trace metadata, either under `payload.llmTrace` or `payload.plannerTrace.llmTrace`.

```ts
type LlmTrace = {
  schemaVersion: "southstar.llm_trace.v1";
  attempts: Array<{
    attempt: number;
    model: string;
    promptHash: string;
    responseHash?: string;
    outputParseStatus: "parsed" | "invalid-json" | "schema-error" | "composer-error";
    validationOk?: boolean;
    issueCodes: string[];
  }>;
};
```

The trace must not store raw prompts, raw model responses, credentials, secrets, vault values, or full candidate packets. Hashes and issue codes are enough for audit correlation.

### 7.3 Repair Prompt Includes Previous Plan

When a composition attempt returns a syntactically valid plan that fails validation, the next repair prompt must include:

- original goal
- validator issues with paths/codes/messages
- bounded candidate summary
- previous failed composition plan

The previous plan gives the LLM a concrete patch target and reduces blind regeneration. If the previous attempt failed before producing a plan, such as invalid JSON, the repair prompt includes issues but does not invent a prior plan.

## 8. P1 Generated Proposal Lifecycle API

`generatedComponentProposals` are currently embedded in planner payloads. They should become durable reviewable proposal resources so the operator can inspect, approve, reject, or convert them into library object drafts.

### 8.1 Proposal Resource

Store proposals as `runtime_resources` with `resource_type = 'library_component_proposal'`.

```ts
type GeneratedComponentProposalResource = {
  proposalId: string;
  draftId: string;
  kind: LibraryDefinitionKind;
  status: "proposed" | "approved-for-draft" | "rejected" | "converted";
  risk: "low" | "medium" | "high";
  reason: string;
  proposedPayload?: Record<string, unknown>;
  source: {
    plannerDraftId: string;
    compositionHash?: string;
  };
};
```

### 8.2 Proposal Endpoints

```text
GET  /api/v2/planner/drafts/:draftId/proposals
POST /api/v2/planner/drafts/:draftId/proposals/:proposalId/approve
POST /api/v2/planner/drafts/:draftId/proposals/:proposalId/reject
POST /api/v2/planner/drafts/:draftId/proposals/:proposalId/convert-to-library-draft
```

Approval does not grant runtime permission. Conversion creates a draft library object or draft edge that must pass existing design-library validation and approval before future candidate resolution can use it.

## 9. P1 Legacy Ref Map Containment

New dynamic workflow manifests should emit canonical library refs. Legacy aliases may remain only at explicit compatibility boundaries for older deterministic manifests or older persisted runs.

Target rules:

- compiler emits canonical prefixed refs such as `instruction.software-maker`, `skill.software-implementation`, and `tool.workspace-read`
- task envelopes materialize from compiled manifest library refs
- `managed-context-assembler.ts` and `postgres-task-envelope.ts` must not own separate divergent legacy maps
- any remaining alias mapping lives in one compatibility helper with tests
- dynamic workflow E2E asserts `materializedLibraryRefs` contain canonical refs

The runtime materializer remains strict: it resolves approved library objects by exact object key and never treats an LLM alias as authority.

## 10. P2 Multi-Domain And Scope

The first dynamic workflow slice is software-focused, but the architecture should not hardcode `software` through planner, validator, compiler, or runtime context.

Target changes:

- planner draft input accepts `scope` or `domain`
- candidate resolver uses that scope instead of a literal `"software"`
- validator receives explicit scope
- compiler emits `workflow.domain` and task `domain` from the selected scope/domain pack
- harness capabilities come from selected profile/domain metadata, not hardcoded `["software"]`
- runtime context stores the selected scope
- tests seed a second minimal scope and prove the path does not fall back to software

P2 should be implemented only after P0/P1 audit and authority behavior is stable, because domain generalization multiplies validation cases.

## 11. Storage Model

The canonical storage remains `southstar.runtime_resources` with `resource_type = 'planner_draft'`.

The implementation should add helper functions, not a new table:

```ts
getPostgresPlannerDraftOrchestration(db, { draftId })
approvePostgresPlannerDraft(db, { draftId, actorId, reason })
rejectPostgresPlannerDraft(db, { draftId, actorId, reason })
createPostgresRunFromDraft(db, { draftId })
```

The helper layer owns conversion from internal payload to public response DTOs. Routes call helpers and return envelopes.

Generated component proposals use `runtime_resources(resource_type = 'library_component_proposal')` until a future library approval flow converts them into draft library objects.

## 12. Error Handling

| Scenario | Expected behavior |
|---|---|
| Missing `goalPrompt` | Existing error envelope |
| Invalid `orchestrationMode` or `composerMode` | Existing error envelope |
| Invalid draft created | `POST /planner/drafts` returns `status: "invalid"` and `canMaterialize: false` |
| Missing draft inspect | Existing error envelope |
| Run from invalid draft | Existing error envelope; no `workflow_runs` row |
| Run from rejected draft | Existing error envelope; no `workflow_runs` row |
| Approve invalid draft | Existing error envelope |
| Approve already approved draft | Idempotent success |
| Reject already rejected draft | Idempotent success |
| Unsatisfied `inputArtifactRefs` | Draft is invalid with `input_artifact_not_satisfied`; no run creation |
| Unknown or incompatible `templateSlotRef` | Draft is invalid with template slot issue; no run creation |
| Generated proposal selected as runtime ref | Draft is invalid; proposal remains non-authoritative |
| Proposal approved | Proposal may become a library draft only; it does not grant runtime permission |
| Non-software scope before P2 support | Explicit error or unsupported-scope response; no silent fallback |

## 13. Testing Requirements

Unit/API tests must cover:

- invalid draft create response includes `status`, `canMaterialize`, and validation issues or blocking reasons.
- validated draft create response includes task summaries.
- `GET /planner/drafts/:draftId/orchestration` works for deterministic and `llm-constrained` drafts.
- `approve` and `reject` mutate only planner draft resource status/payload.
- rejected and invalid drafts cannot create runs.
- `POST /runs` and `POST /planner/drafts/:draftId/runs` return richer run summaries.
- runtime client passes through `orchestrationMode` and `composerMode`.
- `runGoal` returns the richer draft/run shape.
- validator rejects unsatisfied `inputArtifactRefs`.
- validator accepts `inputArtifactRefs` satisfied by direct and indirect upstream dependencies.
- validator rejects unknown `templateSlotRef`.
- validator rejects template slot capability or artifact mismatches.
- compiler freezes only selected library version refs.
- planner draft persists sanitized `llmTrace` without raw prompt/response.
- repair loop second prompt includes the previous failed plan when one exists.
- generated component proposals are persisted as proposal resources and exposed by proposal API.
- dynamic workflow envelopes contain canonical refs and do not depend on duplicated legacy maps.
- second-scope test proves the dynamic path does not hardcode `software` once P2 is implemented.

E2E coverage should extend the dynamic workflow case by checking the inspect endpoint after draft creation and before run materialization.

## 14. Acceptance Criteria

1. API consumers can create a draft and immediately know whether it is materializable.
2. API consumers can inspect the orchestration result later by draft id without DB access.
3. Invalid drafts are visible as invalid and cannot silently proceed to run creation.
4. Validated and approved drafts can materialize runs with the existing route and the draft-owned route.
5. The runtime client has typed methods for all new and changed planner draft routes.
6. No raw LLM prompt/response, secrets, or full candidate packet are exposed by the public inspection endpoint.
7. Validator blocks impossible artifact-flow DAGs and incompatible template slot assignments.
8. Compiler audit freezes selected library versions only.
9. Repair prompts include prior failed plans when available.
10. Generated proposals are durable, reviewable, and non-authoritative until converted and approved.
11. New runtime envelopes consume compiled canonical library refs.
12. Multi-domain/scope support removes `software` hardcode without silent fallback.
13. Existing deterministic and `llm-constrained` tests remain green.

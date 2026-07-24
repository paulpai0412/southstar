# Atomic Criterion Verification Design

## Objective

Make each Criterion the smallest independently verifiable completion unit in the canonical Goal Design V3 flow. A blocking Criterion is complete only when its own artifact, evidence, procedure, and evaluator result pass; Requirement and Goal completion are projections of those Criterion results.

## Non-goals

- Do not introduce a second Goal Design, composition, or workflow path.
- Do not preserve Requirement Validation Binding V2 through adapters or fallback behavior.
- Do not treat the graph or an LLM opinion as verification evidence.
- Do not add speculative evaluator orchestration beyond the existing evaluator/result lifecycle.

## Canonical model

`CriterionVerificationContractV1` remains the semantic contract and must contain exactly one `requiredAssurance` value. If a claim needs independent deterministic, browser, security, performance, or human assurance, the planner must split it into separate Criteria.

Goal Design Package V3 stores one Requirement-level aggregate binding whose children are atomic verification units:

```ts
interface RequirementValidationBindingV3 {
  schemaVersion: "southstar.requirement_validation_binding.v3";
  id: string;
  requirementId: string;
  criterionBindings: Array<{
    criterionContract: CriterionVerificationContractV1;
    artifactContractRef: string;
    artifactContractVersionRef: string;
    evaluatorProfileRef: string;
    evaluatorProfileVersionRef: string;
    verificationMode: RequirementValidationMode;
    procedureRef: string;
    expectedEvidenceKinds: string[];
    independence: "independent";
    failureClassifications: string[];
  }>;
}
```

Each child owns exactly one Criterion, artifact contract, evaluator profile, verification mode, and procedure. The Requirement binding only groups those independent units for Requirement-level display and completion aggregation.

## Canonical data flow

```text
Goal Contract
  -> Requirement
  -> atomic Criterion
  -> Criterion binding
  -> Slice / DAG task
  -> produced Artifact
  -> Evidence
  -> Evaluator result
  -> Criterion completion
  -> Requirement completion
  -> Goal completion
```

Composition and coverage require a canonical Goal Design Package V3. Missing package data, missing Criterion bindings, incompatible assurance modes, or stale Library versions fail closed with a persisted diagnostic; production does not compose from Requirement-only fallback data.

## Completion authority

- A blocking Criterion requires a passing canonical evaluator result backed by its expected evidence.
- A nonblocking Criterion may remain incomplete without blocking its parent Requirement.
- A nonblocking Requirement still blocks completion when it contains an incomplete blocking Criterion.
- A Requirement is complete when every blocking Criterion is complete.
- A Goal is complete when every Requirement-level completion projection is complete.
- UI status and coverage are read-model projections of the same Criterion-level truth; the browser does not reconstruct completion from raw resources.

## Revision and stale-lineage rules

- Criterion identity reconciliation fails closed whenever proposed and previous unmatched sets are both nonempty, except for one unambiguous one-to-one replacement.
- Slice freshness compares the full semantic contract: Criterion ID, version, blocking flag, verification intent, assurance mode, and observable claim.
- A semantic Criterion revision invalidates the source draft's embedded workflow/composition projection and all downstream DAG, Goal outcome, evaluator result, validator result, evidence, coverage, and execution-set resources derived from the old revision.
- Workflow and Goal Journey read models ignore stale downstream resources.
- Per-slice Goal Contracts preserve Requirement IDs, semantic tags, Criterion IDs, and Criterion versions.

## Library consistency

Binding resolution may rank candidates before persistence, but persistence must re-read and lock the selected Library object key/version/status in the same transaction that marks the draft `validation_ready`. A changed, missing, or no-longer-approved object rejects the transition instead of silently selecting another candidate.

## Goal Contract validation

Persisted Goal Contracts validate every expected artifact with the existing canonical artifact parser: nonempty description, optional safe relative path, and optional nonempty media type. An array-shaped but malformed artifact is rejected.

## UI projection

- Coverage groups by Requirement but displays the status and binding chain of each Criterion.
- A failed evaluator result matches the canonical singular `requirementId` and its Criterion identity.
- Requirement, Criterion, artifact, evidence, and evaluator nodes display meaningful labels and preserve their canonical IDs as secondary metadata.
- Graphs remain a navigation and diagnostic projection; they are not the source of completion truth.

## Migration policy

Goal Design Package V3 uses Requirement Validation Binding V3 before publication. Stored V2 bindings are rejected with a diagnosable schema error; no production adapter, alternate composer, or compatibility route is added.

## Acceptance criteria

1. The parser rejects a Criterion with zero or multiple assurance modes.
2. The resolver emits one complete binding child per Criterion and can bind different Criteria in one Requirement to different modes, artifacts, evaluators, and procedures.
3. Readiness, coverage, and completion use Criterion `blocking` authority.
4. Composition and coverage reject missing or non-V3 Goal Design packages.
5. Ambiguous semantic identity changes and full-contract stale Slice inputs fail closed.
6. Criterion revision stales every derived projection, including the source draft's old DAG and Goal outcome.
7. Per-slice execution preserves Requirement and Criterion identity.
8. Library version/status changes between resolution and persistence reject the transition.
9. Malformed expected artifacts are rejected by the stored Goal Contract parser.
10. Coverage UI reports canonical Criterion-level pass/fail status without duplicate Requirement-level bindings.
11. Focused tests, `npm test`, `npm run test:v2`, root and web TypeScript checks, web build, and `git diff --check` pass before the issue commit.

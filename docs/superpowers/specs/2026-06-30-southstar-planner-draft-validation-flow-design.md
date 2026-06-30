# Southstar Planner Draft Validation Flow Design

## Problem

The workflow UI currently presents a `Draft` action even when the streamed v2 planner path has already persisted a `planner_draft`. The generated DAG already carries a `draftId`, but the frontend lifecycle starts as `file_draft`, so the operator sees a stale mental model: "this is only local" when the backend has already created a draft resource.

Profile overrides also mutate the persisted draft in place while leaving the draft status and summary as `validated`. That lets `Run` consume a draft after manual profile changes without a fresh validation pass. Revision has a related issue: `POST /planner-drafts/:draftId/revise` generates a new draft from prior context, but task-level `profileOverride` values are not deterministically copied to the revised draft, so user-selected profiles can disappear.

## Target Flow

The product flow is:

1. Prompt creates a backend planner draft.
2. The frontend shows that draft immediately.
3. The operator can edit task agent profile settings on the draft.
4. Any profile override edit marks the draft `needs_validation`.
5. `Validate` is a real backend action: it revalidates the current persisted draft and refreshes draft summary/orchestration metadata.
6. `Run` only creates `workflow_runs` and `workflow_tasks` from a `validated` draft, then starts execution.
7. Revision creates a new draft but preserves matching task-level profile overrides from the source draft unless no matching task exists.

## Draft Statuses

- `validated`: the persisted draft workflow has passed the current draft validation path and can be run.
- `needs_validation`: the persisted draft was manually changed after its last validation. It must be validated before run creation.
- `invalid`: validation ran and found blocking issues.

`createPostgresRunFromDraft()` remains the enforcement point for run creation and must reject every status except `validated`.

## Backend Design

Profile override patching continues to update the same `planner_draft` resource. After writing the override into `payload.workflow.tasks[n].profileOverride`, it updates:

- `runtime_resources.status = "needs_validation"`
- `summary.status = "needs_validation"`
- `summary.taskSummaries` from the updated workflow payload
- `summary.validationIssues` with a draft-needs-validation marker or an empty stale marker policy

The new validation endpoint is:

`POST /api/v2/planner/drafts/:draftId/validate`

It reads the persisted draft workflow, validates the manifest with `validateWorkflowManifest()`, checks the materialized override workflow can still be formed, refreshes `taskSummaries`, and writes:

- `status = "validated"` when no issues exist
- `status = "invalid"` when issues exist
- `summary.validationIssues`
- `payload.validationIssues`
- a refreshed validation metadata block in `payload.orchestrationSnapshot.validation`

This first implementation validates the persisted workflow manifest and override materialization. It does not re-run the original LLM composition validator because UI-edited drafts operate on `SouthstarWorkflowManifest`, while the composition validator requires the original `WorkflowCompositionPlan` plus the complete candidate packet.

Revision uses the existing new-draft generation path, then applies source draft overrides to matching tasks in the revised draft. Matching is deterministic:

1. exact task id match
2. no match means no override is copied

If any overrides are copied, the revised draft is marked `needs_validation`. If no overrides are copied, the revised draft keeps its generated status.

## Frontend Design

Generated v2 DAGs already include `draftId`. `WorkflowDagBlock` should initialize lifecycle state from that DAG:

- DAG with `draftId` starts in `validated`, `needs_validation`, or `planner_draft` depending on draft status/readiness.
- The primary `Draft` action is hidden or disabled once a `draftId` exists.
- `Validate` calls `POST /api/workflow/planner-drafts/:draftId/validate`.
- `Run` first validates/refreshes the draft view, then creates run rows and starts execution only if status is `validated`.

When the node profile editor saves an override, the parent UI should refresh the draft view or mark it `needs_validation` so `Run` is disabled until validation succeeds.

## Error Handling

- Missing draft returns the existing `planner draft not found` error.
- `Validate` on malformed draft payload returns `invalid` with validation issues instead of creating a run.
- `Run` on `needs_validation` fails with `planner draft is not validated: <draftId>`.
- Revision preserves only matching task overrides; unmatched overrides are omitted rather than guessed.

## Tests

Focused tests cover:

- profile override patch marks the same draft `needs_validation`
- run creation rejects `needs_validation`
- validate endpoint/action returns the same draft to `validated`
- revise preserves matching profile overrides and marks the revised draft `needs_validation`
- frontend lifecycle starts as draft when a generated DAG already has `draftId`
- frontend Validate calls POST validate instead of GET orchestration

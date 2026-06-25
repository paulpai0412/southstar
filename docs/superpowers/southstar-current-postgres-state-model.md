# Southstar Current Postgres State Model

Date: 2026-06-25  
Status: current-state reference

Southstar v2 currently uses a layered state model, not a single three-table runtime model.

## Canonical Layers

- `work_items`: intake state, source provenance, and external issue linkage.
- `workflow_runs`: run status, workflow manifest snapshot, execution projection, runtime context, and metrics.
- `workflow_tasks`: task DAG execution state, dependency refs, root session id, and task metrics.
- `workflow_history`: append-only run event log with sequence, actor, causation, and idempotency evidence.
- `runtime_resources`: extensible runtime evidence and resources (`context_packet`, `task_envelope`, bindings, `hand_execution`, `runtime_exception`, `recovery_decision`, approvals, and related records).

## Side Stores

- `artifact_blobs`: large typed artifact payloads.
- `secure_blobs`: encrypted or provider-managed secret-bearing payloads.
- `library_objects`, `library_edges`, `library_history`, `library_similarity_index`: design-library and control-plane state.
- `learning_nodes`, `learning_edges`: evolution and learning graph state.

## UI Contract Rule

The redesigned UI should consume read models, not raw table rows. Raw tables remain audit truth; read models are stable UI-facing projections with command affordances and source refs.

## Superseded Wording

Older texts that describe `runtime_status` and `workflow_state` as physical columns are superseded. Those names may still exist as semantic projection fields, but they are not current schema truth.

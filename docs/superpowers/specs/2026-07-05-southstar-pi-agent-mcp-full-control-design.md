# Southstar Pi-Agent MCP Full Control Design

## Goal

Let a Pi agent operate Southstar end to end from prompt-driven tool calls, without reimplementing Southstar workflow, library, runtime, recovery, or artifact logic inside the MCP server.

## Current MCP State

Implemented before this design slice:

- `southstar.system.status`
- `southstar.workflow.search_templates`
- `southstar.workflow.get_template`
- `southstar.workflow.instantiate_template`
- `southstar.workflow.get_draft`
- `southstar.workflow.run_draft`
- `southstar.workflow.inspect_run`
- `southstar.workflow.get_artifact`

Implemented by this design slice:

- System loop tools: list, tick, wake.
- Library graph/import/install/object/file/profile tools.
- Workflow draft create/revise/proposal/save-template tools.
- Runtime read model, task envelope, run control, task recovery, session, memory, execution, approval, recovery, log, and steering tools.
- Runtime client wrappers for existing Library and workflow revision/template routes.
- JSON-RPC `tools/list` smoke coverage for the expanded tool surface.
- SSE-to-MCP progress bridge for planner draft creation, planner draft revision, Library import candidate install, and runtime run event streams.

Remaining MCP gaps after this slice:

- The stdio server is a minimal JSON-RPC adapter; it still needs a real pi-agent MCP connection test.
- Real pi-agent prompt execution still needs a live MCP connection test to confirm progress notifications are rendered by the host UI.
- `southstar.runtime.get_session_checkpoint`, `southstar.runtime.get_run_events`, `southstar.runtime.invalidate_memory`, `southstar.runtime.get_executor_job_actions`, and `southstar.runtime.voice_command` are not wrapped yet.
- Library chat SSE is not wrapped as a chat-oriented MCP tool; current Library tools call import/install/graph APIs directly, and Library install streaming is covered by `southstar.library.install_import_candidates_stream`.
- MCP tool annotations such as read-only/destructive/idempotent metadata are not modeled yet.
- Destructive tool confirmation is represented by explicit `commandId`, `actor`, and `reason`; there is no higher-level pi-agent policy prompt integration yet.

## Design Principle

MCP stays an adapter:

```text
pi-agent prompt
  -> MCP tool selection
  -> southstar-mcp tool registry
  -> RuntimeServerClient
  -> existing /api/v2 routes
  -> existing services/stores/read models
```

The MCP adapter does not:

- Compose workflows itself.
- Write Postgres tables directly.
- Install library files directly.
- Apply recovery decisions directly.
- Read secrets or emit secret values.

## Tool Surface

### System

- `southstar.system.status`
- `southstar.system.loops`
- `southstar.system.tick_loop`
- `southstar.system.wake`

### Library

- `southstar.library.get_workspace`
- `southstar.library.get_graph`
- `southstar.library.import_from_source`
- `southstar.library.install_import_candidates`
- `southstar.library.get_object`
- `southstar.library.set_object_lifecycle`
- `southstar.library.list_files`
- `southstar.library.get_file`
- `southstar.library.update_file`
- `southstar.library.validate_file`
- `southstar.library.sync_file`
- `southstar.library.compose_profile`
- `southstar.library.validate_profile`
- `southstar.library.save_profile`

Library import remains two-phase:

```text
import source -> draft candidates -> selected install -> file write -> graph sync
```

The install tool returns installed object keys and proposed ontology edge results. It does not auto-approve objects unless the selected route already does so by policy.

### Workflow Planning

- `southstar.workflow.create_draft`
- `southstar.workflow.revise_draft`
- `southstar.workflow.get_draft`
- `southstar.workflow.list_proposals`
- `southstar.workflow.approve_proposal`
- `southstar.workflow.reject_proposal`
- `southstar.workflow.convert_proposal_to_library_draft`
- `southstar.workflow.search_templates`
- `southstar.workflow.get_template`
- `southstar.workflow.instantiate_template`
- `southstar.workflow.save_template`
- `southstar.workflow.run_draft`

### Runtime And Operator

- `southstar.runtime.inspect_run`
- `southstar.runtime.get_read_model`
- `southstar.runtime.get_task_envelope`
- `southstar.runtime.get_run_actions`
- `southstar.runtime.control_run`
- `southstar.runtime.get_task_actions`
- `southstar.runtime.recover_task`
- `southstar.runtime.list_artifacts`
- `southstar.runtime.get_artifact`
- `southstar.runtime.list_sessions`
- `southstar.runtime.get_session_events`
- `southstar.runtime.get_session_checkpoints`
- `southstar.runtime.search_memory`
- `southstar.runtime.list_memory`
- `southstar.runtime.list_memory_deltas`
- `southstar.runtime.decide_memory_delta`
- `southstar.runtime.list_executions`
- `southstar.runtime.get_execution`
- `southstar.runtime.reconcile_executor_job`
- `southstar.runtime.cancel_executor_job`
- `southstar.runtime.list_logs`
- `southstar.runtime.list_approvals`
- `southstar.runtime.decide_approval`
- `southstar.runtime.approve_recovery_decision`
- `southstar.runtime.apply_recovery_decision`
- `southstar.runtime.steer_run`

## Prompt-Driven Pi-Agent Flow

Example:

```text
Import https://github.com/example/skills, approve useful React skills,
generate a software workflow for a vocabulary app, run it, and monitor until complete.
```

Tool sequence:

```text
southstar.library.import_from_source
southstar.library.install_import_candidates
southstar.library.get_graph
southstar.workflow.search_templates
southstar.workflow.instantiate_template
southstar.workflow.run_draft
southstar.runtime.inspect_run
southstar.runtime.get_read_model
southstar.runtime.get_task_envelope
southstar.runtime.recover_task
southstar.runtime.get_artifact
```

## Runtime Client Gap

Some runtime APIs already exist but are not exposed by `src/v2/server/client.ts`. The client must add wrappers before MCP tools can stay thin:

- Library workspace/graph/import/install/object/file/profile/template routes.
- Planner draft revision route.
- Workflow save-template route.

Existing client methods already cover:

- Planner draft create/get/run and proposal actions.
- Run/task inspection and control.
- Session, memory, execution, approval, recovery, read model, loop, wake, and artifact APIs.

## Security

- Runtime route policy remains authoritative.
- MCP returns IDs, summaries, graph slices, and artifacts only through explicit artifact/file tools.
- Secrets are never returned by MCP.
- Destructive tools require explicit input fields such as `reason`, `actor`, and `commandId`.
- Southstar workspace mount policy remains enforced by runtime planning/run APIs.

## Acceptance Criteria

- Pi agent can discover available Southstar MCP tools by category.
- Pi agent can import/install library content, query graph state, and inspect library files through MCP.
- Pi agent can create/revise/instantiate/save/run workflows through MCP.
- Pi agent can inspect run state, read DAG/task envelopes, recover tasks, steer runs, and read artifacts through MCP.
- MCP tool tests verify URL/body mapping and registry calls.
- No MCP tool bypasses existing runtime APIs.

---
name: southstar
description: Execute a natural-language Southstar goal from Pi through the runtime APIs. Use when the user asks to plan, compose, validate, run, inspect, or control a Southstar workflow, including Library import, requirements, slices, DAG, Executor, artifacts, and recovery.
---

# Southstar

Use the Southstar Pi tools to turn the user's goal into a durable runtime execution. This is the agent-side contract for `/southstar`; it does not implement a Chat host adapter and it must not simulate Southstar results.

## Invocation

The loaded prompt template maps the exact `/southstar <goal>` command to this skill. The native skill command is also available as `/skill:southstar`.

Treat all text after the command as one goal prompt. If no goal is supplied, ask the user for one. Use the current Pi session workspace as `cwd`; use an explicitly requested project path when supplied.

The runtime registry uses canonical MCP names such as `southstar.workflow.run_goal`; the existing Pi custom-tool bridge exposes the same tools with dots normalized to underscores, so the callable Pi name is `southstar_workflow_run_goal` (and, for example, `southstar_workflow_confirm_requirements` and `southstar_workflow_confirm_goal_design`). Use the names visible in the current Pi tool list; the canonical names below identify the backing API.

## Complete execution

For a new goal, call the Pi tool `southstar_workflow_run_goal` (canonical API: `southstar.workflow.run_goal`) with:

```json
{
  "goalPrompt": "<the user's complete goal>",
  "cwd": "<current workspace absolute path>",
  "idempotencyKey": "<stable key for this request>",
  "goalDesignMode": "auto_until_blocked",
  "templatePolicy": { "mode": "auto" }
}
```

The tool calls the durable Southstar `POST /api/v2/run-goal` SSE API. Its pipeline is:

```text
Goal Contract → Requirement Draft → Library coverage/import → Slice Plan
→ validated DAG/manifest → Planner Draft → Run → Scheduler → Tork/Pi Executor
→ callbacks/artifacts/evaluation → read model and terminal status
```

Use `goalDesignMode: "auto_until_blocked"` for the one-command flow. This mode still returns a persisted requirements review before execution. When the returned draft is confirmable, has no blockers, and the requirements faithfully represent the user's command, continue without stopping: call `southstar_workflow_confirm_requirements` with the returned `draftId` and `expectedDraftHash`, read the resulting goal-design package/hash, then call `southstar_workflow_confirm_goal_design_stream` (canonical API: `southstar.workflow.confirm_goal_design_stream`) with `draftId` and `expectedPackageHash`. Keep that streaming tool call active through composition; its planner-stage and heartbeat events are user-visible progress. Its final result includes the DAG orchestration and starts scheduling.

Do not treat `requirements_review` as terminal merely because an API call completed. The `/southstar` command authorizes this ordinary Goal-to-Outcome continuation for the stated goal. It does not authorize installing Library candidates, choosing an incompatible template, granting new capabilities, or approving recovery; those remain explicit blockers.

## Blocking results and continuation

Never invent requirements, Library objects, agents, skills, tools, profiles, templates, artifacts, or execution status. Stop and explain the persisted blocker when `draftStatus` is one of:

- `needs_input`: show `goalRequirementDraft`, `blockers`, and `validationIssues`; ask only for the missing clarification.
- `needs_library_input` or `library_review`: inspect the returned `libraryImportDraftId` with Pi tool `southstar_library_get_import_draft` (canonical API: `southstar.library.get_import_draft`), present its exact candidate and edge IDs, and install only the IDs the user explicitly approves. The install response resumes the same persisted Goal validation flow; do not rerun the Goal unless that response explicitly directs you to do so.
- `template_incompatible` or `invalid`: report the persisted issue; do not silently choose another template or synthesize a fix.
- `awaiting_approval`: show the `approvalId`; use the runtime approval API only after the user gives the decision.

For a requirements review that needs correction, use `southstar.workflow.get_draft`, `southstar.workflow.revise_requirement`, and `southstar.workflow.confirm_requirements`. Pass the returned `expectedDraftHash` on every revision/confirmation; do not overwrite a newer draft after a concurrency error. After confirmation, use `southstar.workflow.confirm_goal_design_stream` (Pi: `southstar_workflow_confirm_goal_design_stream`) with the exact returned package hash instead of falling back to `run_draft`, repeatedly polling with sleeps, or calling an untracked route.

## Monitoring the run

When `runId` or `executionSetId` is returned, scheduling is not completion. Use `southstar.workflow.inspect_run` or `southstar.runtime.get_read_model`, then `southstar.runtime.stream_run_events` with `closeOnTerminal: true` when the user wants the goal followed through execution. For evidence or follow-up, use:

- `southstar.runtime.list_executions` for Executor/Tork submissions;
- `southstar.runtime.list_artifacts` and `southstar.workflow.get_artifact` for accepted outputs;
- `southstar.runtime.list_sessions`, `get_session_events`, and `get_session_checkpoints` for Pi session evidence;
- `southstar.runtime.list_logs`, `list_approvals`, and recovery tools for operator state.

Do not claim success from a created run, queued task, or partial stream. Report terminal status and the relevant artifact or blocking reference.

## Chat workspace result contract

Keep Southstar tool calls and their structured results in the assistant message. The Chat renderer recognizes `structuredContent` from the Pi tool and displays a message box, open by default and collapsible by the user, for Library graph/candidates, requirements, slice plan, and DAG. Prefer the structured payload over dumping raw JSON. Include the IDs and status needed for the next action (`draftId`, hashes, `runId`, `executionSetId`, blockers, approvals, and artifact refs).

Progress updates should be short and factual: current lifecycle stage, persisted ID, and next action. On completion, summarize what ran, terminal state, artifacts, and any evaluator or recovery result.

## Available API families

Use the existing Southstar tools instead of shelling out or calling an untracked endpoint:

- `southstar.library.*`: workspace/graph lookup, import draft creation and `get_import_draft` review, candidate installation, object lifecycle, files, profiles, validation, and sync;
- `southstar.workflow.run_goal`: complete one-prompt Goal → Executor flow;
- `southstar.workflow.create_draft*`, `get_draft`, `revise_draft*`, `revise_requirement`, `confirm_requirements`, `confirm_goal_design_stream`, proposal and template tools: explicit draft and Library/template work;
- `southstar.workflow.run_draft`, `inspect_run`, `get_artifact`: run and result access;
- `southstar.runtime.*`: read models, task envelopes, actions, pause/resume/cancel, recovery, artifacts, sessions, memory, executions, logs, approvals, steering, and event streams.

If a needed operation is not available in these tool families, report the missing API rather than bypassing persistence or inventing a result. The runtime route and tool registry are the source of truth for input names and returned fields.

## Safety invariants

The runtime owns schema validation, permissions, dependency ordering, retries, persistence, and callbacks. Do not replace those controls with direct database writes, fixture composers, fake providers, alternate templates, or a second workflow model. If the runtime returns an error, preserve its code/message and persisted identifiers in the Chat response.

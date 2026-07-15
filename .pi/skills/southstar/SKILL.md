---
name: southstar
description: Execute a natural-language Southstar goal from Pi through the runtime APIs. Use when the user asks to plan, compose, validate, run, inspect, or control a Southstar workflow, including Library import, requirements, slices, DAG, Executor, artifacts, and recovery.
---

# Southstar

Use the Southstar Pi tools to turn the user's goal into a durable runtime execution. This is the agent-side contract for `/southstar`; it does not implement a Chat host adapter and it must not simulate Southstar results.

## Invocation

The project prompt template `.pi/prompts/southstar.md` maps the exact `/southstar <goal>` command to this skill. The native skill command is also available as `/skill:southstar`.

Treat all text after the command as one goal prompt. If no goal is supplied, ask the user for one. Use the current Pi session workspace as `cwd`; use an explicitly requested project path when supplied.

The runtime registry uses canonical MCP names such as `southstar.workflow.run_goal`; the existing Pi custom-tool bridge exposes the same tools with dots normalized to underscores, so the callable Pi name is `southstar_workflow_run_goal` (and, for example, `southstar_workflow_confirm_requirements`). Use the names visible in the current Pi tool list; the canonical names below identify the backing API.

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

Use `goalDesignMode: "auto_until_blocked"` for the one-command flow. The runtime still persists each stage and returns a blocking result when user input, Library approval, template selection, or recovery approval is required.

## Blocking results and continuation

Never invent requirements, Library objects, agents, skills, tools, profiles, templates, artifacts, or execution status. Stop and explain the persisted blocker when `draftStatus` is one of:

- `needs_input`: show `goalRequirementDraft`, `blockers`, and `validationIssues`; ask only for the missing clarification.
- `needs_library_input`: inspect the returned `libraryImportDraftId`; use `southstar.library.get_graph` and the Library import tools, present candidates, and install only candidates the user approves. Then call `southstar.workflow.run_goal` again with the same goal and a new idempotency key.
- `template_incompatible` or `invalid`: report the persisted issue; do not silently choose another template or synthesize a fix.
- `awaiting_approval`: show the `approvalId`; use the runtime approval API only after the user gives the decision.

For a requirements review that must be interactive, use `southstar.workflow.get_draft`, `southstar.workflow.revise_requirement`, and `southstar.workflow.confirm_requirements`. Pass the returned `expectedDraftHash` on every revision/confirmation; do not overwrite a newer draft after a concurrency error.

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

- `southstar.library.*`: workspace/graph lookup, import drafts, candidate installation, object lifecycle, files, profiles, validation, and sync;
- `southstar.workflow.run_goal`: complete one-prompt Goal → Executor flow;
- `southstar.workflow.create_draft*`, `get_draft`, `revise_draft*`, `revise_requirement`, `confirm_requirements`, proposal and template tools: explicit draft and Library/template work;
- `southstar.workflow.run_draft`, `inspect_run`, `get_artifact`: run and result access;
- `southstar.runtime.*`: read models, task envelopes, actions, pause/resume/cancel, recovery, artifacts, sessions, memory, executions, logs, approvals, steering, and event streams.

If a needed operation is not available in these tool families, report the missing API rather than bypassing persistence or inventing a result. The runtime route and tool registry are the source of truth for input names and returned fields.

## Safety invariants

The runtime owns schema validation, permissions, dependency ordering, retries, persistence, and callbacks. Do not replace those controls with direct database writes, fixture composers, fake providers, alternate templates, or a second workflow model. If the runtime returns an error, preserve its code/message and persisted identifiers in the Chat response.

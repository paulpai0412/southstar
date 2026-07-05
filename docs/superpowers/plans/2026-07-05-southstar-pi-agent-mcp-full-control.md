# Southstar Pi-Agent MCP Full Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Southstar MCP so a Pi agent can operate library import, workflow planning, runtime execution, recovery, and inspection through prompt-selected MCP tools.

**Architecture:** MCP remains a thin adapter over `RuntimeServerClient`; missing runtime client wrappers are added before tools. Existing runtime routes and services remain authoritative for library writes, workflow composition, run control, recovery, memory, and artifacts.

**Tech Stack:** TypeScript ESM, Node test runner, `tsx`, Postgres-backed runtime APIs, Southstar JSON-RPC MCP stdio adapter.

---

## File Structure

- Modify: `src/v2/server/client.ts`
  - Add runtime client wrappers for existing Library APIs and workflow draft revision/save-template APIs.
- Modify: `src/v2/mcp/tool-registry.ts`
  - Add MCP tools for system loops, Library, planner proposals, workflow save, runtime inspection/control, task recovery, memory, sessions, execution, approvals, and steering.
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
  - Assert missing client wrappers exist and map to the correct URLs/bodies.
- Modify: `tests/v2/mcp-server-tools.test.ts`
  - Assert expanded MCP tool names and runtime client method mapping.
- Create or update docs:
  - `docs/superpowers/specs/2026-07-05-southstar-pi-agent-mcp-full-control-design.md`
  - `docs/superpowers/plans/2026-07-05-southstar-pi-agent-mcp-full-control.md`

## Task 1: Runtime Client Wrappers For Library And Workflow API

**Files:**
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
- Modify: `src/v2/server/client.ts`

- [x] **Step 1: Write failing client method assertions**

Add these methods to the existing `runtime server client exposes P0 runtime API methods` assertion:

```ts
"getLibraryWorkspace",
"getLibraryGraph",
"createLibraryImportDraft",
"installLibraryImportCandidates",
"getLibraryObject",
"setLibraryObjectLifecycle",
"listLibraryFiles",
"getLibraryFile",
"updateLibraryFile",
"validateLibraryFile",
"syncLibraryFile",
"composeLibraryProfile",
"validateLibraryProfile",
"saveLibraryProfile",
"revisePlannerDraft",
"saveWorkflowTemplate",
```

- [x] **Step 2: Write failing URL/body mapping assertions**

In `runtime server client exposes operator route URLs and bodies`, call:

```ts
await client.getLibraryWorkspace({ scope: "software" });
await client.getLibraryGraph({ scope: "software", objectKey: "agent.frontend", depth: 1, kind: "agent_definition", status: "approved" });
await client.createLibraryImportDraft({ source: { kind: "github", url: "https://github.com/example/skills" }, scope: "software", requestPrompt: "import skills" });
await client.installLibraryImportCandidates({ draftId: "draft/lib", selectedCandidateIds: ["candidate-a"], selectedEdgeIds: ["edge-a"], actor: "pi-agent", reason: "install selected candidates" });
await client.getLibraryObject("agent.frontend");
await client.setLibraryObjectLifecycle({ objectKey: "agent.frontend", action: "approve", actor: "pi-agent", reason: "approve for workflow use" });
await client.listLibraryFiles();
await client.getLibraryFile("agents/frontend.agent.md");
await client.updateLibraryFile({ relativePath: "agents/frontend.agent.md", content: "updated" });
await client.validateLibraryFile("agents/frontend.agent.md");
await client.syncLibraryFile("agents/frontend.agent.md");
await client.composeLibraryProfile({ scope: "software", nodeId: "implement", requirement: "Build UI", preferredAgentRef: "agent.frontend", templateId: "template.software" });
await client.validateLibraryProfile({ profile: { scope: "software", nodeId: "implement", agentRef: "agent.frontend", skillRefs: [], toolGrantRefs: [], mcpGrantRefs: [], instructionRefs: [] } });
await client.saveLibraryProfile({ draft: { profile: {}, validation: {} }, templateId: "template.software", actor: "pi-agent", reason: "save generated profile" });
await client.revisePlannerDraft({ draftId: "draft/a", prompt: "add verification" });
await client.saveWorkflowTemplate({ draftId: "draft/a", templateId: "template.saved", title: "Saved Template", scope: "software", status: "approved" });
```

Expected: FAIL because methods are missing.

- [x] **Step 3: Implement minimal client wrappers**

Add request types and methods in `src/v2/server/client.ts`. Use existing `get`, `post`, and `patch` helpers and encode path segments with `encodeURIComponent`.

- [x] **Step 4: Verify**

Run:

```bash
npx tsx tests/v2/runtime-api-client-alignment.test.ts
```

Expected: PASS.

## Task 2: MCP Tool Registry Expansion

**Files:**
- Modify: `tests/v2/mcp-server-tools.test.ts`
- Modify: `src/v2/mcp/tool-registry.ts`

- [x] **Step 1: Write failing MCP tool list assertion**

Extend expected tool names with:

```text
southstar.system.loops
southstar.system.tick_loop
southstar.system.wake
southstar.library.get_workspace
southstar.library.get_graph
southstar.library.import_from_source
southstar.library.install_import_candidates
southstar.library.get_object
southstar.library.set_object_lifecycle
southstar.library.list_files
southstar.library.get_file
southstar.library.update_file
southstar.library.validate_file
southstar.library.sync_file
southstar.library.compose_profile
southstar.library.validate_profile
southstar.library.save_profile
southstar.workflow.create_draft
southstar.workflow.revise_draft
southstar.workflow.list_proposals
southstar.workflow.approve_proposal
southstar.workflow.reject_proposal
southstar.workflow.convert_proposal_to_library_draft
southstar.workflow.save_template
southstar.runtime.get_read_model
southstar.runtime.get_task_envelope
southstar.runtime.get_run_actions
southstar.runtime.control_run
southstar.runtime.get_task_actions
southstar.runtime.recover_task
southstar.runtime.list_artifacts
southstar.runtime.list_sessions
southstar.runtime.get_session_events
southstar.runtime.get_session_checkpoints
southstar.runtime.search_memory
southstar.runtime.list_memory
southstar.runtime.list_memory_deltas
southstar.runtime.decide_memory_delta
southstar.runtime.list_executions
southstar.runtime.get_execution
southstar.runtime.reconcile_executor_job
southstar.runtime.cancel_executor_job
southstar.runtime.list_logs
southstar.runtime.list_approvals
southstar.runtime.decide_approval
southstar.runtime.approve_recovery_decision
southstar.runtime.apply_recovery_decision
southstar.runtime.steer_run
```

- [x] **Step 2: Write failing MCP call mapping test**

Call representative tools from each category and assert the fake runtime client receives the expected method/body pairs.

- [x] **Step 3: Implement MCP tools**

Add methods to `SouthstarMcpRuntimeClient`, then add tool entries. Use small helpers:

```ts
runtimeCommandInput(body, defaultActorId)
optionalStringArray(value, field)
requiredAction(value, allowed, field)
```

Each tool unwraps the runtime API envelope and returns structured JSON.

- [x] **Step 4: Verify**

Run:

```bash
npx tsx tests/v2/mcp-server-tools.test.ts
```

Expected: PASS.

## Task 3: JSON-RPC MCP Smoke Test

**Files:**
- Modify: `tests/v2/mcp-server-tools.test.ts`
- Modify: `src/v2/mcp/server.ts` only if needed.

- [x] **Step 1: Add message handler smoke test**

Call `handleSouthstarMcpMessage(registry, { jsonrpc: "2.0", id: 1, method: "tools/list" })` and assert expanded tools are returned.

- [x] **Step 2: Verify**

Run:

```bash
npx tsx tests/v2/mcp-server-tools.test.ts
```

Expected: PASS.

## Task 4: Full Focused Verification

**Files:**
- No new files.

- [x] **Step 1: Run focused tests**

```bash
npx tsx tests/v2/runtime-api-client-alignment.test.ts
npx tsx tests/v2/mcp-server-tools.test.ts
```

Expected: PASS.

## Task 5: SSE-To-MCP Progress Bridge

**Files:**
- Modify: `src/v2/server/client.ts`
- Modify: `src/v2/mcp/tool-registry.ts`
- Modify: `src/v2/mcp/server.ts`
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
- Modify: `tests/v2/mcp-server-tools.test.ts`

- [x] **Step 1: Add failing streaming MCP tests**

Added JSON-RPC `tools/call` coverage for `_meta.progressToken` and `notifications/progress`.

- [x] **Step 2: Add runtime client SSE wrappers**

Implemented:

```text
createPlannerDraftStream
revisePlannerDraftStream
installLibraryImportCandidatesStream
streamRunEvents
```

- [x] **Step 3: Add MCP streaming tools**

Implemented:

```text
southstar.workflow.create_draft_stream
southstar.workflow.revise_draft_stream
southstar.library.install_import_candidates_stream
southstar.runtime.stream_run_events
```

- [x] **Step 4: Bridge SSE events to MCP progress notifications**

`handleSouthstarMcpMessage()` now reads `params._meta.progressToken` and emits `notifications/progress` while the tool runs.

- [x] **Step 5: Verify**

Run:

```bash
npx tsx tests/v2/runtime-api-client-alignment.test.ts
npx tsx tests/v2/mcp-server-tools.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [x] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS.

## Self-Review

- Spec coverage: This plan covers missing runtime client wrappers, expanded MCP tool names, MCP call mapping, and JSON-RPC smoke coverage.
- Placeholder scan: No task depends on undefined behavior; every missing method maps to an existing route.
- Type consistency: Tool names use category prefixes `southstar.system`, `southstar.library`, `southstar.workflow`, and `southstar.runtime`; client method names are camelCase wrappers over `/api/v2` routes.

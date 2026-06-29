# Southstar Workflow Node Profile Editor Design

## Goal

On the correct 30141 Pi Agent Web UI, selecting a workflow DAG node opens the right panel as a node-level agent profile editor. The editor changes only the selected planner draft task for the current DAG and does not mutate the global agent library or reusable agent profiles.

## Current State

The correct UI is `/home/timmypai/apps/southstar/web` served at `http://127.0.0.1:30141/`.

The web shell already has these pieces:

- `web/components/AppShell.tsx` owns the right panel and routes DAG node clicks through `onWorkflowDagNodeSelect`.
- `web/components/WorkflowDagBlock.tsx` emits selected legacy `WorkflowDagNode` objects.
- `web/components/WorkflowResourceViewer.tsx` can edit workflow resource files in the right panel.
- `web/app/api/workflow/*` proxies planner draft, run, execute, status, library, and resource APIs to the v2 backend.

The v2 runtime already has these pieces:

- `GET /api/v2/ui/workflow?draftId=...&taskId=...` returns the workflow canvas and `selectedDefinition`.
- `GET /api/v2/agent-library?domain=software` returns roles, profiles, skills, MCP grants, tools, contracts, and policies.
- `GET /api/v2/agent-library/candidates?draftId=...&taskId=...` returns selected refs and alternatives for the selected task.
- Planner drafts are stored as `southstar.runtime_resources` rows with `resource_type = 'planner_draft'` and a `payload_json.workflow.tasks[]` list.

The missing piece is a write API that updates one task in an existing planner draft, then refreshes the workflow UI read model.

## User Experience

When the user clicks a DAG node in Workflow mode:

1. The right panel opens.
2. A tab labeled `Node Profile` becomes active.
3. The panel loads:
   - selected task definition from `/api/workflow/ui?draftId=...&taskId=...`
   - available alternatives from `/api/workflow/agent-library/candidates?draftId=...&taskId=...`
4. The user can edit:
   - host adapter/provider
   - model
   - thinking mode
   - instruction
   - skills, with add/remove controls
   - MCP grants, with add/remove controls
5. `Save` persists the override to the current planner draft.
6. `Reset` discards local changes and restores the latest server value.
7. After save, the editor reloads the selected workflow read model so the DAG and right panel agree.

The first implementation is editable only for draft-mode DAGs. Runtime DAGs remain read-only because run creation materializes task envelopes; changing a running task profile would otherwise be ambiguous and unsafe.

## Data Model

Add a draft task override shape:

```ts
export type PlannerDraftTaskProfileOverride = {
  provider?: "pi" | "codex" | "claude-code" | "openai" | "anthropic" | "custom";
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs?: string[];
  mcpGrantRefs?: string[];
};
```

Store it inside each planner draft task:

```json
{
  "id": "implement-feature",
  "roleRef": "maker",
  "agentProfileRef": "software-maker-pi",
  "skillRefs": ["software.calc-cli"],
  "mcpGrantRefs": ["filesystem-workspace"],
  "profileOverride": {
    "provider": "codex",
    "model": "gpt-5-codex",
    "thinkingLevel": "high",
    "instruction": "Focus on minimal patch and tests.",
    "skillRefs": ["software.calc-cli", "software.test-evidence"],
    "mcpGrantRefs": ["filesystem-workspace"]
  }
}
```

For execution, task materialization resolves final values with this precedence:

1. task `profileOverride`
2. task refs such as `agentProfileRef`, `skillRefs`, and `mcpGrantRefs`
3. referenced agent profile defaults

The first phase must at least persist the override and expose it in the read model. If run materialization does not already consume the override, the run creation path must merge it before task envelopes are built.

## API Design

Runtime API:

```http
PATCH /api/v2/planner/drafts/:draftId/tasks/:taskId/profile-override
Content-Type: application/json

{
  "provider": "codex",
  "model": "gpt-5-codex",
  "thinkingLevel": "high",
  "instruction": "Focus on minimal patch and tests.",
  "skillRefs": ["software.calc-cli"],
  "mcpGrantRefs": ["filesystem-workspace"]
}
```

Response:

```json
{
  "ok": true,
  "kind": "planner-draft-task-profile-override",
  "result": {
    "draftId": "draft-wf-composed-...",
    "taskId": "implement-feature",
    "profileOverride": {
      "provider": "codex",
      "model": "gpt-5-codex",
      "thinkingLevel": "high",
      "instruction": "Focus on minimal patch and tests.",
      "skillRefs": ["software.calc-cli"],
      "mcpGrantRefs": ["filesystem-workspace"]
    },
    "status": "validated"
  }
}
```

Web proxy:

```http
PATCH /api/workflow/planner-drafts/:draftId/tasks/:taskId/profile-override
```

Read APIs for the panel:

```http
GET /api/workflow/ui?draftId=:draftId&taskId=:taskId
GET /api/workflow/agent-library/candidates?draftId=:draftId&taskId=:taskId
```

## Read Model Changes

`WorkflowTaskDefinitionSummary` should include:

```ts
profileOverride?: PlannerDraftTaskProfileOverride;
effectiveProfile?: {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  instruction?: string;
  skillRefs: string[];
  mcpGrantRefs: string[];
};
editable: boolean;
```

Draft mode sets `editable: true`. Runtime mode sets `editable: false`.

The existing `selectedDefinition.agentProfile`, `skillRefs`, and `mcpGrantRefs` remain available for backward compatibility.

## UI Components

Add:

- `web/components/WorkflowNodeProfileEditor.tsx`
  - Loads selected task details and candidates.
  - Owns draft form state, dirty state, saving state, and validation messages.
  - Renders compact form sections for runtime, instruction, skills, and MCP.
  - Calls save/reset callbacks.

- `web/lib/workflow/node-profile.ts`
  - Normalizes read model/candidates into form state.
  - Validates provider/model/thinking/skill/MCP values.
  - Builds PATCH payloads.
  - Provides pure functions covered by unit tests.

Modify:

- `web/components/AppShell.tsx`
  - Replace the current node-click behavior that opens `profile.json`.
  - Open a right-panel tab with `kind: "workflowNodeProfile"`.
  - Preserve file/resource tabs for normal file viewing.

- `web/components/TabBar.tsx` and `web/lib/types.ts` if the tab type currently only supports file/resource tabs.

- `web/components/MessageView.tsx` and future React Flow DAG block should pass richer node selection context when available:
  - `draftId`
  - `runId`
  - `taskId`
  - `mode`

Legacy `WorkflowDagBlock` can still open the editor if it has a planner draft id. If it only has a resource path, it can keep opening `profile.json` as fallback.

## Error Handling

- Missing `draftId`: show a read-only panel explaining that the node is not attached to a persisted planner draft.
- Runtime DAG: show read-only effective profile details.
- PATCH validation error: keep edits, show the server error inline, and keep `Save` enabled after user changes.
- Library candidates failure: keep the core form usable with manually entered skill/MCP refs.
- Save success: show a short saved state and reload the selected workflow read model.

## Testing

Backend tests:

- `tests/v2/postgres-run-api.test.ts`
  - Patching a planner draft task stores `profileOverride`.
  - Invalid draft id rejects.
  - Invalid task id rejects.
  - Empty arrays are preserved.

- `tests/v2/workflow-ui-read-model.test.ts`
  - Draft selected definition exposes `profileOverride`, `effectiveProfile`, and `editable: true`.
  - Runtime selected definition exposes `editable: false`.

- `tests/v2/runtime-api-client-alignment.test.ts`
  - Runtime client exposes `patchPlannerDraftTaskProfileOverride`.

Web proxy tests:

- `tests/unit/workflow-v2-api.test.ts`
  - Proxy route maps to `/api/v2/planner/drafts/:draftId/tasks/:taskId/profile-override`.
  - `/api/workflow/ui` proxy maps to `/api/v2/ui/workflow`.
  - `/api/workflow/agent-library/candidates` proxy maps to `/api/v2/agent-library/candidates`.

Web unit/static tests:

- Add focused tests for `web/lib/workflow/node-profile.ts`.
- Add static or render-level tests that `AppShell` contains a `workflowNodeProfile` tab path and does not open `profile.json` for persisted DAG node selection.

Browser verification:

- Open `http://127.0.0.1:30141/`.
- Generate or load a persisted workflow DAG.
- Click a DAG node.
- Confirm the right panel shows `Node Profile`.
- Change model, thinking mode, skills, and MCP grants.
- Save.
- Reload selected node details and confirm persisted values.

## Non-Goals

- Editing global agent profiles.
- Promoting node overrides to reusable library profiles.
- Editing a runtime task after a run has been materialized.
- Implementing Operator UI.

## Follow-Up

After this is stable, add `Promote to Agent Profile` as an explicit user action. That should create a separate proposal/review flow because it changes future workflows, not only the current draft.

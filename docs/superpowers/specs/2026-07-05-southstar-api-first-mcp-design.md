# Southstar API-First MCP Design

## Goal

Expose Southstar workflow, library, and runtime capabilities to external agents through MCP without duplicating workflow logic inside the MCP server.

## Core Principle

Southstar runtime APIs are the product boundary. The MCP server is an adapter.

```text
core service
  -> runtime API route
  -> web UI / CLI / MCP adapter
```

MCP tools must call Southstar runtime APIs or shared runtime services. They must not own workflow composition, template instantiation, recovery, artifact loading, library graph writes, or vault policy.

## Primary Use Case

A user prompts a Pi agent:

```text
Use the software development workflow to build a vocabulary learning app with five features.
```

The Pi agent calls Southstar MCP:

```text
southstar.workflow.search_templates
  -> southstar.workflow.instantiate_template
  -> southstar.workflow.get_draft
  -> southstar.workflow.run_draft
  -> southstar.workflow.inspect_run
  -> southstar.workflow.get_artifact
```

The saved software-development DAG is reused as a workflow skeleton. The current prompt fills each node's `nodePromptSpec`, generated agent profile, selected skills, tools, MCP grants, artifact contracts, test cases, and acceptance criteria.

## Runtime API Surface

The first-class runtime API surface should include:

- `GET /api/v2/workflow/templates/search`
- `GET /api/v2/workflow/templates/:templateRef`
- `POST /api/v2/workflow/templates/instantiate`
- `GET /api/v2/artifacts/:artifactRef`

Existing APIs remain the backing surface for:

- `/api/v2/planner/drafts`
- `/api/v2/planner/drafts/:draftId/orchestration`
- `/api/v2/planner/drafts/:draftId/revise`
- `/api/v2/planner/drafts/:draftId/runs`
- `/api/v2/runs/:runId`
- `/api/v2/runs/:runId/tasks/:taskId`
- `/api/v2/runs/:runId/tasks/:taskId/envelope`
- `/api/v2/runtime/health`
- `/api/v2/library/graph`

## MCP Tools

### `southstar.system.status`

Calls runtime health and loop APIs. Returns database, runtime loop, Tork observation, and managed runtime readiness.

### `southstar.workflow.search_templates`

Input:

```ts
{
  prompt: string;
  domain?: string;
  limit?: number;
}
```

Output:

```ts
{
  templates: Array<{
    templateRef: string;
    title: string;
    status: string;
    score: number;
    nodeCount: number;
    nodeTypes: string[];
    versionRef?: string;
  }>;
}
```

### `southstar.workflow.get_template`

Input:

```ts
{ templateRef: string }
```

Output includes template metadata, node skeletons, edges, version refs, expected artifact refs, skill/tool/MCP refs, and whether the template can be instantiated.

### `southstar.workflow.instantiate_template`

Input:

```ts
{
  templateRef: string;
  goalPrompt: string;
  repo?: {
    path?: string;
    url?: string;
    branch?: string;
  };
  constraints?: {
    requireApproval?: boolean;
    maxNodes?: number;
    mode?: "strict" | "adaptive";
  };
}
```

Output:

```ts
{
  draftId: string;
  workflowId: string;
  templateRef: string;
  status: "validated" | "invalid";
  validationIssues: Array<{ path: string; message: string }>;
  nodes: Array<{
    taskId: string;
    nodeType?: string;
    nodePromptSpec?: unknown;
    agentProfileRef?: string;
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
  }>;
}
```

Strict mode preserves the saved template DAG node set and edges. Adaptive mode may later allow bounded node duplication, such as expanding one feature loop into multiple feature-specific implement/verify pairs.

### `southstar.workflow.get_draft`

Wraps existing planner draft orchestration.

### `southstar.workflow.run_draft`

Wraps existing planner draft run creation.

### `southstar.workflow.inspect_run`

Wraps existing run/task/read-model APIs.

### `southstar.workflow.get_artifact`

Input:

```ts
{ artifactRef: string }
```

Output follows `artifact_ref.contentRef`, reads `artifact_blobs` when present, and returns status, producer metadata, summary, and JSON content.

### Library Tools

Library MCP tools are second-phase adapter work over existing Library APIs:

- `southstar.library.search`
- `southstar.library.get_graph`
- `southstar.library.import_from_repo`
- `southstar.library.install_candidates`
- `southstar.library.validate`
- `southstar.library.sync`

## Template Instantiation Flow

```text
templateRef + goalPrompt
  -> load approved workflow_template from library_objects
  -> read template skeleton nodes and edges
  -> resolve graph metadata candidates
  -> LLM fills nodePromptSpec and generated agent profiles for the current prompt
  -> validate WorkflowCompositionPlan
  -> compile through existing-composition compiler
  -> persist planner_draft
```

The first implementation can support strict templates only. If no reusable skeleton is present in the workflow template state, the API should fail with a clear validation issue instead of silently falling back to free-form workflow generation.

## Security And Policy

- MCP calls must not bypass runtime policy.
- Repo paths must pass existing workspace mount policy.
- Southstar's own repository must remain protected from being used as the target workspace unless explicitly allowed by runtime policy.
- Secrets are never returned through MCP tool results.
- MCP tool results should return IDs and summaries by default; full artifact content is allowed only through `get_artifact`.
- Run control tools should require explicit tool calls and should map to existing runtime command routes.

## Acceptance Criteria

- Runtime APIs expose template search, template get, template instantiate, and artifact get.
- MCP adapter can be implemented as a thin wrapper over those APIs.
- Template instantiation reuses existing composition validation and compilation.
- Generated drafts contain typed `nodePromptSpec` for every task.
- Artifact reads can return JSON body from `artifact_blobs`.
- Web UI and MCP can share the same runtime API behavior.

# Southstar: Library Tab, Import Graph, And Dynamic Agent Profile Design

**Date:** 2026-07-02
**Status:** Baseline implemented (2026-07-03); live external import jobs and richer graph diff UI remain future hardening.
**Goal:** Add a Southstar Library tab panel that lets operators manage agent, skill, tool, and MCP library primitives as editable local files, import external libraries with LLM-assisted graph extraction, sync validated objects into the Postgres design library graph, and let Workflow Generate dynamically compose per-node agent profiles that can be validated, run, and saved with reusable workflow templates.

---

## 1. Problem

Southstar already has a Postgres-backed design library graph, but the current active library content is still too static:

- `software-library-seed.ts` acts like a hardcoded source for the software library.
- Existing workflow composition mostly selects pre-existing `agent_profile` rows instead of composing profiles from independent primitives.
- Agent, skill, tool, and MCP definitions are not yet authorable as first-class editable local files.
- Importing a GitHub agent pack or a local folder does not have a product path with preview, validation, approval, provenance, and graph diff.
- The Workflow Generate React DAG UI can display generated workflow structure, but does not yet save the generated DAG together with generated node profiles as reusable library drafts.

The desired model is:

```text
local editable library files
  -> importer / compiler
  -> validator
  -> Postgres design library graph
  -> workflow generate graph resolver
  -> LLM-composed per-node profiles
  -> validate
  -> run
  -> save template + generated profiles
```

This design intentionally removes `software-library-seed.ts` from the active authoring path. It may remain as a legacy bootstrap, migration helper, or test fixture, but not as the product mechanism for managing agent library content.

Current implemented baseline:

```text
local library file -> parse -> validate -> sync -> library_objects/library_edges
library chat/import -> import draft -> approve -> file write -> graph sync
workflow generate -> primitive candidates -> generated node profile -> validation -> planner draft
workflow DAG save -> generated profiles/template -> version refs -> graph sync
```

Baseline implemented on 2026-07-03 includes:

- Library tab with three-pane layout: domain/object sidebar, center chat/SSE workspace, and right file viewer/editor.
- Local file read/save/sync APIs for library files.
- Import draft creation and approval for deterministic paste imports, plus API-shaped GitHub/local sources with inline content.
- Object lifecycle actions for approve, deprecate, and block.
- Postgres graph read model with domain, kind, and status filters.
- Chat message graph block rendered as an in-app React/SVG chart with domain filters and node selection that opens the right file viewer.
- Object detail API for inbound/outbound graph edges, usage counts, provenance basics, and validation summary.
- File validation and generated profile validation APIs.
- Workflow generation integration with graph-derived profile candidates and generated profile validation.
- Workflow DAG save-template API that derives graph refs from the server-side planner draft and records `libraryVersionRefs`.

Phase 2 hardening still includes:

- Full object CRUD from the UI beyond file-backed editing and lifecycle state changes.
- Durable Library chat session read model (`GET /api/v2/library/chat/session`) and resumable long-running chat/import jobs.
- Live GitHub fetch and local folder traversal without inline content.
- Import draft inspect/analyze/validate endpoints before approval.
- Rich graph diff wizard for import conflicts, risk flags, and merge decisions.
- Full audit metadata for validation report hashes, evaluator refs, imported-by timestamps, and external source repo refs.
- Background import jobs for large repositories such as `jnMetaCode/agency-agents-zh`.

---

## 2. Design Principles

1. **Local files are the authoring source.** Operators should be able to edit individual agents, skills, tools, and MCP grants with ordinary file diffs, review, and version control.
2. **Postgres is the validated runtime graph.** Workflow generation, candidate resolution, validation, and runtime materialization read from `southstar.library_objects` and `southstar.library_edges`, not directly from ad hoc files.
3. **LLM output is proposal, not truth.** LLM may extract fields and propose graph edges during import, but deterministic normalizers and validators decide what can be saved.
4. **Primitives stay independent.** Agent, skill, tool, and MCP definitions are separate objects. `agent_profile` becomes a composed binding for a task or reusable pattern, not the only way to model capability.
5. **Dynamic profiles are explicit drafts.** Workflow Generate can compose node profiles from primitives, but generated profiles are run-scoped or draft until validated and approved.
6. **UI calls Southstar APIs.** The Library tab and Workflow DAG Save use runtime APIs. They do not directly call Codex skills or write DB rows by themselves.
7. **Every durable change is auditable.** Imports, edits, graph writes, approvals, template saves, and profile saves keep source refs, hashes, actor ids, validation reports, and timestamps.

---

## 3. Source Of Truth Model

Southstar uses a two-layer library model:

| Layer | Purpose | Owner |
|---|---|---|
| Local library files | Human-editable authoring source, Git review, external import staging | Library tab editor / importer |
| Postgres design library graph | Validated runtime index used by workflow generation and execution | Import compiler / validator / approval API |

The local files are not a loose cache. They are the durable authoring artifact for operator-managed content. The Postgres graph is rebuilt or updated from those files through controlled APIs.

Runtime services do not scan `library/` files directly. They consume the Postgres graph because they need indexed queries, status filtering, graph traversal, version refs, approval state, and transactional consistency.

---

## 4. Local Library File Layout

Use a hybrid format:

```text
library/
  agents/
    frontend-developer.agent.md
    backend-architect.agent.md
  skills/
    react-ui.skill.md
    postgres-query.skill.md
  tools/
    workspace-read.tool.yaml
    workspace-write.tool.yaml
    browser.tool.yaml
  mcp/
    filesystem-workspace.mcp.yaml
    github.mcp.yaml
  profiles/
    generated/
      todo-webapp/
        implement-ui.profile.yaml
        verify-ui.profile.yaml
  templates/
    saved/
      todo-webapp.workflow.yaml
  imports/
    github/
      jnMetaCode-agency-agents-zh/
        manifest.yaml
        raw/
        proposals/
```

### 4.1 Agent Files

Agents use Markdown with YAML frontmatter.

```markdown
---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
capabilityRefs:
  - capability.react-ui
  - capability.nextjs-routing
preferredSkillRefs:
  - skill.react-ui
allowedToolRefs:
  - tool.workspace-read
  - tool.workspace-write
  - tool.browser
provenance:
  source: user
---

# Identity

Builds and verifies interactive frontend experiences.

# Operating Rules

- Inspect the existing frontend framework before editing.
- Prefer existing components and styling conventions.
- Produce implementation evidence and verification notes.
```

### 4.2 Skill Files

Skills also use Markdown with YAML frontmatter because they often contain long instructions.

```markdown
---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.react-ui
title: React UI Implementation
scope: software
requiresCapabilityRefs:
  - capability.react-ui
requiresToolRefs:
  - tool.workspace-read
  - tool.workspace-write
requiresMcpRefs: []
status: draft
---

# Instructions

- Build React UI changes with existing project conventions.
- Keep component state explicit and validate browser behavior when required.
- Report changed files, verification steps, and residual risks.
```

### 4.3 Tool And MCP Files

Tools and MCP grants use YAML because they are structured and policy-heavy.

```yaml
schemaVersion: southstar.library.tool_definition_file.v1
id: tool.workspace-write
title: Workspace Write
scope: global
operations:
  - edit_file
  - apply_patch
risk:
  level: medium
  approvalRequired: false
providesCapabilityRefs:
  - capability.workspace-write
status: draft
```

```yaml
schemaVersion: southstar.library.mcp_grant_file.v1
id: mcp.filesystem-workspace
title: Filesystem Workspace MCP
scope: global
serverId: filesystem-workspace
allowedOperations:
  - read_file
  - write_file
  - list_files
providesCapabilityRefs:
  - capability.workspace-file-access
risk:
  level: medium
  approvalRequired: false
status: draft
```

### 4.4 Generated Profile Files

Generated profiles are YAML because they are composed bindings.

```yaml
schemaVersion: southstar.library.generated_agent_profile_file.v1
id: profile.generated.todo-webapp.implement-ui
title: Todo Webapp UI Implementer
scope: software
status: draft
source:
  kind: workflow-generate-save
  templateRef: template.todo-webapp
  nodeId: implement-ui
agentRef: agent.frontend-developer
skillRefs:
  - skill.react-ui
toolGrantRefs:
  - tool.workspace-read
  - tool.workspace-write
mcpGrantRefs:
  - mcp.filesystem-workspace
instructionRefs:
  - instruction.react-implementation
complexityBand: moderate
budget:
  maxInputTokens: 12000
  maxOutputTokens: 4000
risk:
  level: medium
validation:
  status: valid
```

### 4.5 Saved Workflow Template Files

Saved workflow templates are YAML and reference generated profile files.

```yaml
schemaVersion: southstar.library.workflow_template_file.v1
id: template.todo-webapp
title: Todo Webapp Workflow
scope: software
status: draft
libraryVersionRefs:
  - agent.frontend-developer@2026-07-03
  - skill.react-ui@2026-07-03
  - tool.workspace-write@2026-07-03
  - mcp.filesystem-workspace@2026-07-03
profileRefs:
  - profile.generated.todo-webapp.implement-ui
  - profile.generated.todo-webapp.verify-ui
nodes:
  - id: implement-ui
    title: Implement UI
    profileRef: profile.generated.todo-webapp.implement-ui
    outputArtifactRefs:
      - artifact.implementation_report
  - id: verify-ui
    title: Verify UI
    profileRef: profile.generated.todo-webapp.verify-ui
    dependsOn:
      - implement-ui
edges:
  - from: implement-ui
    to: verify-ui
validation:
  status: valid
```

---

## 5. Postgres Graph Model

The importer compiles local files into design library objects and edges.

Core object kinds:

- `agent_definition`
- `skill_spec`
- `tool_definition`
- `mcp_tool_grant`
- `capability_spec`
- `instruction_template`
- `agent_profile`
- `workflow_template`

Recommended graph relationships:

```text
agent_definition -> provides_capability -> capability_spec
agent_definition -> uses_instruction -> instruction_template

skill_spec -> requires_capability -> capability_spec
skill_spec -> requires_tool -> tool_definition
skill_spec -> allows_mcp_grant / requires_mcp_grant -> mcp_tool_grant

tool_definition -> provides_capability -> capability_spec
mcp_tool_grant -> provides_capability -> capability_spec

agent_profile -> implements -> agent_definition
agent_profile -> supports_skill -> skill_spec
agent_profile -> allows_tool -> tool_definition
agent_profile -> allows_mcp_grant -> mcp_tool_grant
agent_profile -> uses_instruction -> instruction_template

workflow_template -> part_of_template -> agent_profile
workflow_template -> requires_capability -> capability_spec
```

Some edge names already exist; any missing edge type should be added deliberately rather than overloading unrelated edges. The graph must support both:

- primitive queries, such as "which agents can provide React UI capability?"
- composed-profile validation, such as "does this generated profile select the tools required by its selected skills?"

Graph rows keep provenance:

```ts
{
  sourceKind: "local-file" | "github-import" | "workflow-generate-save" | "migration";
  sourcePath?: string;
  sourceRepo?: string;
  sourceCommitSha?: string;
  sourceHash: string;
  importedBy: string;
  importedAt: string;
}
```

---

## 6. Import Flow

Import is a Southstar API workflow, not a direct UI-to-skill call.

```text
Library tab
  -> POST /api/v2/library/import-drafts
  -> Import Orchestrator
  -> fetch/read source
  -> deterministic parser
  -> optional LLM extraction proposal
  -> normalizer
  -> validator
  -> preview graph diff
  -> save local files
  -> upsert Postgres draft objects/edges
```

The implemented first path stores an import proposal as a `library_import_draft` runtime resource. Approval writes proposed files with no-clobber behavior, syncs each file into the graph, and marks the draft approved in one controlled operation. The current extractor supports pasted content and the API shape for GitHub/local sources; live remote fetching can be layered behind the same draft contract.

Supported import sources:

- GitHub repository URL
- local folder path
- uploaded file or pasted Markdown/YAML
- single agent, skill, tool, or MCP item

LLM-assisted import is used only for ambiguous or free-form sources, such as a Markdown agent pack. It produces:

```ts
type LibraryImportProposal = {
  sourceRef: string;
  proposedFiles: Array<{
    path: string;
    content: string;
    objectKind: string;
    objectKey: string;
  }>;
  proposedObjects: Array<{
    objectKey: string;
    objectKind: string;
    state: Record<string, unknown>;
  }>;
  proposedEdges: Array<{
    fromObjectKey: string;
    edgeType: string;
    toObjectKey: string;
    rationale: string;
  }>;
  issues: Array<{
    severity: "info" | "warning" | "error";
    path: string;
    message: string;
  }>;
};
```

The proposal is not persisted as approved truth. The validator must check schema, required refs, duplicate ids, edge validity, policy risk, source hash, and scope before save.

Large imports, such as `jnMetaCode/agency-agents-zh`, should run as background import jobs with progress:

```text
queued -> fetching -> parsing -> llm_extracting -> validating -> ready_for_review -> saved -> approved
```

---

## 7. Library Tab Panel

Add a new `Library` tab alongside existing Chat, Workflow, and Operator panels.

The tab must preserve local UI state when switching tabs, matching the existing requirement that Chat, Workflow, and Operator panels do not reload their session state on tab changes.

### 7.1 Main Areas

Use the same overall interaction model as the Workflow tab panel: a persistent left navigation panel, a center chat/SSE working surface, and a right detail surface that behaves like a file viewer/editor. Switching away from the Library tab and back must preserve the selected domain, selected item, prompt text, chat transcript, stream state, graph view state, and unsaved editor draft.

```text
left sidebar: domain-grouped library tree + quick prompt/import entry
center: Library chat window with SSE progress and rich message blocks
right panel: file viewer/editor for agent, skill, tool, MCP, profile, or template
```

Left sidebar grouping:

```text
All Domains
  software
    Agents
    Skills
    Tools
    MCP
    Generated Profiles
    Workflow Templates
  research
    Agents
    Skills
    Tools
    MCP
  global
    Tools
    MCP
    Capabilities
Imports
Graph
```

The first MVP can put `Generated Profiles` and `Workflow Templates` under a compact `Drafts` or `Saved` group, but the data model should include them from the start because Workflow Generate Save depends on them.

### 7.2 Domain Library Sidebar

The left sidebar is the primary navigation surface. It should show counts and status hints per domain/kind:

```text
software
  Agents 24
  Skills 18
  Tools 7
  MCP 3
  Generated Profiles 5
  Workflow Templates 2
```

Each group supports quick filters:

- `approved`
- `draft`
- `invalid`
- `blocked`
- `deprecated`
- `imported`
- `generated`

Items should be tightly packed like an operational tree, not displayed as large cards. The user should be able to select an item and immediately see its file in the right panel.

### 7.3 Prompt Import Command

The Library sidebar includes a compact prompt command box for quick actions, and the center chat window includes the full prompt composer. Both submit to the same backend chat/import API. The user can type natural language such as:

```text
import the frontend developer agent from github repo jnMetaCode/agency-agents-zh into software
```

or:

```text
create a browser verification skill that uses tool.browser and mcp.filesystem-workspace
```

The prompt command calls a Southstar backend API, not a UI-side skill. The backend interprets the prompt, chooses an import/create action, streams progress to the center chat window, and returns an import draft or object draft.

```text
Prompt command
  -> POST /api/v2/library/chat/messages
  -> SSE: intent parsing / LLM proposal / validation / graph diff
  -> draft import or draft object message block
  -> right file viewer opens selected draft when clicked
```

The prompt command does not directly approve or write runtime truth. It creates a draft and opens the preview/editor flow.

### 7.4 Center Library Chat Workspace And SSE

The center panel is a Library chat workspace, not a static table-first view. Tables, import previews, validation summaries, and graph visualizations appear as rich blocks inside the chat timeline.

The chat workspace supports:

- prompt composer for import/create/edit/validate/save commands
- streamed assistant text
- streamed import progress
- proposed file/object/edge blocks
- graph diff blocks
- validation result blocks
- Postgres graph visualization blocks
- file save and DB sync result blocks
- approval/deprecation command blocks

The SSE stream should use stable event names so the UI can render progress incrementally:

```text
library.chat.delta
library.intent.started
library.intent.completed
library.import.fetching
library.import.parsing
library.llm_extract.delta
library.proposal.created
library.graph.diff
library.validation.completed
library.file.saved
library.db.synced
library.graph.snapshot
library.command.completed
library.error
```

The center chat maintains one active Library session per browser workspace. The selected domain and selected library item are part of the session context, so prompts such as "import this into software" or "validate the selected skill" can resolve against the current UI state.

List/table views are still available, but they are rendered as chat blocks or opened from the left sidebar as filtered result blocks. They are not the primary center layout.

### 7.5 Right File Viewer And Editor

The right panel is a file viewer/editor for the selected library item. It should feel like the Workflow tab's task detail panel: stable while the center workspace changes, and never reset unexpectedly on selection changes unless a new file is explicitly selected.

Right panel modes:

- `Preview`: rendered Markdown/YAML summary
- `Edit`: Markdown frontmatter editor for agents/skills, YAML editor/form for tools/MCP/profiles/templates
- `Validate`: validation report and graph edge checks
- `Edges`: inbound/outbound graph edges
- `Usage`: templates, generated profiles, or workflow drafts using this item
- `Provenance`: source path, source repo, source hash, imported by, timestamps

Agent and skill files are edited as Markdown with frontmatter. Tool, MCP, generated profile, and workflow template files are edited as YAML. Save writes the local file first, then syncs the draft graph row to Postgres. Save/sync progress appears in the center chat as SSE-backed status blocks.

### 7.6 CRUD Operations

For agent, skill, tool, and MCP:

- create new item from template
- edit metadata and body
- validate
- save local file
- sync to Postgres draft
- approve / deprecate / block
- duplicate as new version
- delete draft
- view graph edges
- view usage by workflow template or generated profile

Approved objects should not be destructively edited in place. Editing an approved item creates a new draft version. Approval moves the new version into active runtime selection.

### 7.7 Import Wizard

Import wizard steps:

1. Choose source: GitHub URL, local folder, file, or paste.
2. Choose target scope and import mode.
3. Analyze source.
4. Review proposed files, objects, and edges.
5. Resolve conflicts and validation issues.
6. Save draft files and Postgres draft graph rows.
7. Approve selected items when ready.

The UI should show a graph diff:

```text
added objects
changed objects
added edges
blocked edges
duplicate ids
missing refs
risky permissions
```

The import wizard can be launched from the sidebar, but its execution progress and final proposal are displayed in the center chat timeline through SSE.

### 7.8 Detail Editor

Agent and skill editors use Markdown body editing plus structured frontmatter fields. Tool and MCP editors use structured YAML forms or a YAML editor with validation.

The editor should include:

- status
- scope
- source/provenance
- validation result
- inbound/outbound edges
- usage references
- risk summary
- version history

### 7.9 Chat Message Graph Block

The center Library chat message view should support a new library graph block. This block can appear when the assistant answers questions about the current library, imports, workflow generation candidates, or saved templates.

The graph block renders relationships currently stored in Postgres:

```text
agent -> capability
agent -> instruction
skill -> required capability
skill -> required tool
skill -> required MCP
tool -> capability
MCP -> capability
generated profile -> agent / skill / tool / MCP
workflow template -> generated profile
```

The block is read-only in chat. It should provide:

- selected domain/scope
- a domain filter control with `All`, `global`, and each discovered domain/scope option
- graph node counts by kind
- highlighted path for the entities mentioned in the chat response
- compact graph visualization implemented as a React component inside the message block
- expandable object/edge details
- links that open the selected object in the Library tab right file viewer

The chat graph block reads from the same Postgres graph read model as the Library tab. It must not reconstruct relationships from raw files or from message text. The graph chart should be rendered by React using ordinary HTML/SVG elements inside the message block; it should not depend on backend-generated images, iframes, or a separate graph service for the first implementation.

The graph block's domain filter defaults to the currently selected Library sidebar domain. `All` shows the whole graph, `global` shows only global library primitives, and a concrete domain such as `software` shows that domain plus shared global primitives when those shared primitives are connected to visible domain objects. Changing the filter refetches `GET /api/v2/library/graph?scope=<scope>` or the matching neighborhood endpoint and rerenders the React chart in place. The block must display the active filter label so screenshots and operator review are unambiguous.

---

## 8. Workflow Generate Dynamic Profile Composition

Workflow Generate should no longer require every usable profile to already exist as a hand-authored `agent_profile`.

Target flow:

```text
prompt
  -> requirement analyzer
  -> required capabilities / expected artifacts / risk / complexity
  -> graph resolver finds primitive candidates
  -> LLM composes DAG and node profile drafts
  -> validator checks DAG + profiles
  -> React DAG UI renders editable result
  -> run or save
```

Each node has a generated profile draft:

```ts
type GeneratedNodeProfileDraft = {
  nodeId: string;
  profileRef: string;
  agentRef: string;
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  instructionRefs: string[];
  complexityBand: "simple" | "moderate" | "complex";
  risk: "low" | "medium" | "high";
  budget: {
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWallTimeSeconds?: number;
  };
  rationale: string;
  validationStatus: "unvalidated" | "valid" | "invalid";
};
```

Validation rules:

- selected agent exists and is approved or approved-for-run
- selected skills exist and are approved or approved-for-run
- selected tools/MCP grants satisfy selected skill requirements
- selected tools/MCP grants are allowed by active policy
- generated profile does not request disallowed filesystem, network, or secret access
- selected instruction refs exist
- output artifact refs have validators/evaluators
- task dependency graph is acyclic
- profile risk is compatible with workflow/run approval policy

Generated profiles can be:

- `run_scoped`: usable only for the current draft/run
- `draft`: saved for review
- `approved_for_run`: allowed for one run after validation
- `approved`: reusable in future workflow generation

LLM cannot directly create `approved` profiles.

---

## 9. Workflow DAG UI Save

Add Save to the Workflow Generate React DAG UI.

Chosen save scope:

```text
save workflow template + generated node profiles
```

When the user clicks Save:

1. Validate the current DAG and all node profiles.
2. Write generated profile YAML files under `library/profiles/generated/<template-id>/`.
3. Write workflow template YAML under `library/templates/saved/`.
4. Upsert Postgres draft objects and edges.
5. Show saved draft ids, file paths, and validation result.
6. Let the user approve now or leave as draft.

Save must not silently approve generated profiles. Approval is a separate command.

Save also records graph lineage. The runtime route derives selected agent, skill, tool, and MCP refs from the persisted planner draft, resolves each ref through `library_objects`, and writes the selected objects' `headVersionId` values into `libraryVersionRefs`. Missing graph objects or missing head versions reject the save before generated files are written.

The saved template captures:

- nodes
- edges
- selected generated profile refs
- expected artifacts
- evaluator refs
- prompt/source metadata
- validation report hash
- library version refs used during generation

The saved profiles capture:

- selected agent
- selected skills
- selected tools
- selected MCP grants
- selected instructions
- complexity/risk/budget
- rationale
- provenance back to the workflow draft and node id

---

## 10. API Design

The UI should use Southstar APIs. The API may internally use LLM clients, importer workers, or Southstar workflow jobs.

Endpoint inventory:

```text
GET    /api/v2/library/objects                         # Phase 2
POST   /api/v2/library/objects                         # Phase 2
GET    /api/v2/library/objects/:objectKey              # Implemented
PATCH  /api/v2/library/objects/:objectKey              # Phase 2; edit source files first
DELETE /api/v2/library/objects/:objectKey              # Phase 2; prefer deprecate/block

GET    /api/v2/library/chat/session                    # Phase 2
POST   /api/v2/library/chat/messages                   # Implemented
GET    /api/v2/library/chat/events                     # Implemented

GET    /api/v2/library/files                           # Implemented
GET    /api/v2/library/files/:fileId                   # Implemented
PATCH  /api/v2/library/files/:fileId                   # Implemented
POST   /api/v2/library/files/:fileId/validate          # Implemented
POST   /api/v2/library/files/:fileId/sync              # Implemented

POST   /api/v2/library/objects/:objectKey/validate     # Implemented
POST   /api/v2/library/objects/:objectKey/approve      # Implemented
POST   /api/v2/library/objects/:objectKey/deprecate    # Implemented
POST   /api/v2/library/objects/:objectKey/block        # Implemented

POST   /api/v2/library/import-prompts                  # Implemented helper
POST   /api/v2/library/import-drafts                   # Implemented
GET    /api/v2/library/import-drafts/:importId         # Phase 2
POST   /api/v2/library/import-drafts/:importId/analyze # Phase 2
POST   /api/v2/library/import-drafts/:importId/validate # Phase 2
POST   /api/v2/library/import-drafts/:importId/approve # Implemented

GET    /api/v2/library/graph                           # Implemented
GET    /api/v2/library/graph/neighborhood              # Implemented

POST   /api/v2/library/profile-drafts/compose          # Implemented
POST   /api/v2/library/profile-drafts/validate         # Implemented
POST   /api/v2/library/profile-drafts/save             # Implemented

POST   /api/v2/workflow/drafts/:draftId/save-template  # Implemented
```

`POST /api/v2/library/chat/messages` is the primary center-panel command surface. It accepts the user prompt plus current UI context (`scope`, selected object, selected file, selected import draft, and visible graph filters), starts a backend library action, and returns the updated chat message metadata. The action streams progress over `GET /api/v2/library/chat/events` as SSE.

For long-running imports, `POST /api/v2/library/import-drafts` returns an import id and progress is polled or streamed.

`POST /api/v2/library/import-prompts` is retained as a narrow compatibility/helper endpoint for direct import prompt calls, but the Library tab should prefer `POST /api/v2/library/chat/messages` so all progress and result blocks land in the center chat timeline. It returns either an import draft id, a new object draft, or a clarification issue. It never writes approved graph truth directly.

`GET /api/v2/library/graph` powers the Library Graph workspace and the chat message graph block. It accepts filters such as `scope`, `kind`, `status`, `objectKey`, and `depth`. `scope` is the domain filter: omitted scope or `scope=all` returns every domain; `scope=global` returns global primitives and global edges only; `scope=<domain>` returns that domain's objects/edges plus connected shared global objects/edges when needed for a complete visible graph. The response includes `activeScope` and `availableScopes` so the frontend can render filter controls from backend truth. `GET /api/v2/library/graph/neighborhood` returns a focused subgraph around selected objects for compact rendering and applies the same `scope` semantics before selecting the neighborhood.

`POST /api/v2/workflow/drafts/:draftId/save-template` ignores browser-provided node bodies and uses the server-side planner draft as source. It saves generated profile files and a workflow template draft, then syncs them to the graph. The template YAML includes `libraryVersionRefs` for the graph primitives used to produce the saved template.

---

## 11. Backend Modules

New or expanded modules:

```text
src/v2/design-library/files/
  library-file-store.ts
  library-file-parser.ts
  library-file-writer.ts

src/v2/design-library/importers/
  library-import-orchestrator.ts
  github-library-importer.ts
  local-folder-library-importer.ts
  prompt-library-importer.ts
  llm-library-extractor.ts
  import-proposal-normalizer.ts

src/v2/design-library/profile-composer/
  graph-profile-candidate-resolver.ts
  llm-profile-composer.ts
  generated-profile-validator.ts

src/v2/design-library/templates/
  workflow-template-save-service.ts

src/v2/read-models/
  library-chat.ts
  library-workspace.ts
  library-graph.ts
```

Existing graph store functions should remain the persistence interface for Postgres writes. File parsing/writing and LLM extraction sit above it.

---

## 12. Error Handling And Safety

Common failure cases:

- source cannot be fetched
- import source contains unsupported format
- LLM extraction returns invalid JSON
- proposed id conflicts with an approved object
- proposed edge references missing object
- tool/MCP grants exceed selected risk policy
- generated profile has tools not required by its skills or task
- saved template references unsaved profile
- local file write succeeds but DB sync fails
- DB write succeeds but file write fails

Safety rules:

- No secrets in files, graph state, prompts, or validation errors.
- LLM proposals never become approved automatically.
- Approved objects are immutable by default; edits create new draft versions.
- Destructive deletion is limited to drafts. Approved objects are deprecated or blocked.
- Import preview must display high-risk tools, MCP operations, secret access, and network access.
- Runtime generation only consumes approved or explicit run-scoped approved-for-run objects.

File/DB consistency:

- Save local file first, compute content hash, then write Postgres graph with that hash.
- If DB write fails, the UI shows file saved but graph sync failed.
- If file write fails, do not write DB rows.
- A repair command can resync files to DB.

---

## 13. Relationship To Existing Domain-Pack Consolidation

This design extends the domain-pack-to-design-library consolidation.

The consolidation moves runtime concepts into the graph. This Library tab design adds the authoring and import surface for those graph objects.

`software-library-seed.ts` should not be the target implementation path. It may remain temporarily for:

- tests
- migration bootstrap
- local demo data
- backward compatibility during transition

The target production path is:

```text
library files
  -> import compiler
  -> Postgres design library graph
```

---

## 14. UI Acceptance Criteria

- The app has a `Library` tab panel next to Chat, Workflow, and Operator.
- Library uses the same broad layout model as Workflow: left persistent navigation, center chat/SSE workspace, right detail/file viewer.
- Switching away from and back to Library preserves filters, selected item, import progress, and editor state.
- The left sidebar groups agents, skills, tools, MCP grants, generated profiles, and workflow templates by domain/scope.
- The left sidebar includes a quick prompt command that sends prompts into the center Library chat workflow.
- The center panel is a chat window that renders streamed SSE events for import, proposal, graph diff, validation, file save, and DB sync progress.
- The right panel can view and edit selected agent, skill, tool, MCP, generated profile, and workflow template files.
- Operators can list, create, edit, validate, save, approve, deprecate, and block agents, skills, tools, and MCP grants.
- Operators can import from GitHub URL, local folder, file, or pasted content.
- Import preview shows proposed files, graph objects, graph edges, conflicts, validation issues, and risk flags.
- Library item detail shows metadata, body/config, validation, provenance, inbound/outbound edges, usage, and version status.
- Library chat message view can render a read-only graph block showing current Postgres agent, skill, tool, MCP, generated profile, and template relationships.
- The graph block's chart is implemented as an in-app React component.
- Clicking an object in the chat graph block opens that object in the Library tab file viewer.
- Workflow Generate DAG UI has Save.
- Save writes workflow template draft plus generated node profile drafts.
- Saved drafts are visible in Library.
- Approved saved templates/profiles become reusable by future workflow generation.

---

## 15. Runtime Acceptance Criteria

- Workflow generation can compose node profiles from independent approved primitives instead of requiring a pre-existing approved `agent_profile`.
- Generated profiles are validated before run.
- Generated profiles are not approved permanently unless the user explicitly approves them.
- Runtime execution consumes the compiled manifest and Postgres graph-derived materialized refs, not source files.
- Candidate resolution uses graph queries over agents, skills, tools, MCP grants, capabilities, policies, and templates.
- Validation rejects profiles that select tools/MCP grants not supported by selected skills or policy.
- Every saved template stores the library version refs or source hashes used to generate it.

---

## 16. Testing Strategy

Backend tests:

- Parse valid agent/skill Markdown frontmatter.
- Parse valid tool/MCP YAML.
- Reject invalid schema versions and missing ids.
- Import a local folder and create draft files/objects/edges.
- Import a mocked GitHub repo and produce a proposal.
- Reject LLM proposal with unknown refs.
- Validate generated profile success and failure paths.
- Save workflow template and generated profiles.
- Resync local files to Postgres graph.
- Library graph API returns correctly filtered graphs for `scope=all`, `scope=global`, and concrete domains such as `software` and `research`.

UI tests:

- Library tab appears and preserves state across tab changes.
- Library left sidebar groups items by domain and kind.
- Prompt import command creates an import/object draft through the Library chat API and streams progress into the center chat.
- Center Library chat renders SSE deltas, import progress, graph diff, validation result, file save, and DB sync blocks.
- Right file viewer edits Markdown frontmatter and YAML files without resetting on tab switches.
- Create/edit/validate/save agent.
- Import wizard shows proposal and validation issues.
- Chat message graph block renders Postgres graph relationships and links to Library items.
- Chat message graph block exposes a domain filter, defaults to the selected Library domain, refetches the graph API on change, and rerenders the React chart for the selected domain.
- Chat message graph block includes a React graph chart component rather than static text only.
- Approve draft changes status and makes it available in candidates.
- Workflow DAG Save creates template/profile drafts and shows result.

Integration tests:

- Import primitives.
- Generate a workflow.
- Compose generated profiles.
- Validate and run with approved-for-run profile drafts.
- Save generated template and profiles.
- Approve them.
- Generate another workflow that reuses the approved template/profile.

---

## 17. Out Of Scope For First Implementation

- Multi-user RBAC beyond existing operator identity conventions.
- Marketplace publishing or remote package registry.
- Automatic permanent approval of LLM-generated profiles.
- Full bidirectional Git branch workflow for library reviews.
- Replacing every existing domain-pack consumer in the same PR if the domain-pack consolidation is still in progress.

---

## 18. Open Design Notes

- The exact visual layout of the graph diff can be refined during UI implementation, but the data model must support object/edge diff from the first version.
- The system should support both direct API jobs and Southstar workflow-backed import jobs. The UI should not care which execution path the backend chooses.
- If the operator edits a generated profile inside Workflow DAG UI before Save, those edits should be captured in the generated profile YAML and validation report.
- If a generated profile is only needed for one run, it can stay `run_scoped` and does not need a local file unless the user saves the template.

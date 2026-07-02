# Southstar: Library Tab, Import Graph, And Dynamic Agent Profile Design

**Date:** 2026-07-02
**Status:** Draft (pending user review)
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

Use a dense operational layout:

```text
left sidebar: kinds, scopes, statuses, imports
center: table/list or graph view
right panel: detail editor, validation, provenance, edges
```

Primary sections:

- Agents
- Skills
- Tools
- MCP
- Generated Profiles
- Workflow Templates
- Imports
- Graph

The first MVP can put `Generated Profiles` and `Workflow Templates` under a `Drafts` or `Saved` section if the UI needs to stay compact, but the data model should include them from the start because Workflow Generate Save depends on them.

### 7.2 CRUD Operations

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

### 7.3 Import Wizard

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

### 7.4 Detail Editor

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

Suggested endpoints:

```text
GET    /api/v2/library/objects
POST   /api/v2/library/objects
GET    /api/v2/library/objects/:objectKey
PATCH  /api/v2/library/objects/:objectKey
DELETE /api/v2/library/objects/:objectKey

POST   /api/v2/library/objects/:objectKey/validate
POST   /api/v2/library/objects/:objectKey/approve
POST   /api/v2/library/objects/:objectKey/deprecate
POST   /api/v2/library/objects/:objectKey/block

POST   /api/v2/library/import-drafts
GET    /api/v2/library/import-drafts/:importId
POST   /api/v2/library/import-drafts/:importId/analyze
POST   /api/v2/library/import-drafts/:importId/validate
POST   /api/v2/library/import-drafts/:importId/save
POST   /api/v2/library/import-drafts/:importId/approve

POST   /api/v2/library/profile-drafts/compose
POST   /api/v2/library/profile-drafts/validate
POST   /api/v2/library/profile-drafts/save

POST   /api/v2/workflow/drafts/:draftId/save-template
```

For long-running imports, `POST /api/v2/library/import-drafts` returns an import id and progress is polled or streamed.

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
  llm-library-extractor.ts
  import-proposal-normalizer.ts

src/v2/design-library/profile-composer/
  graph-profile-candidate-resolver.ts
  llm-profile-composer.ts
  generated-profile-validator.ts

src/v2/design-library/templates/
  workflow-template-save-service.ts

src/v2/read-models/
  library-workspace.ts
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
- Switching away from and back to Library preserves filters, selected item, import progress, and editor state.
- Operators can list, create, edit, validate, save, approve, deprecate, and block agents, skills, tools, and MCP grants.
- Operators can import from GitHub URL, local folder, file, or pasted content.
- Import preview shows proposed files, graph objects, graph edges, conflicts, validation issues, and risk flags.
- Library item detail shows metadata, body/config, validation, provenance, inbound/outbound edges, usage, and version status.
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

UI tests:

- Library tab appears and preserves state across tab changes.
- Create/edit/validate/save agent.
- Import wizard shows proposal and validation issues.
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

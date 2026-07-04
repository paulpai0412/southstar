import assert from "node:assert/strict";
import test from "node:test";
import { parseLibraryFileContent } from "../../src/v2/design-library/files/library-file-parser.ts";

test("parses agent markdown frontmatter and body", () => {
  const parsed = parseLibraryFileContent({
    path: "library/agents/frontend-developer.agent.md",
    content: `---
schemaVersion: southstar.library.agent_definition_file.v1
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
capabilityRefs:
  - capability.react-ui
preferredSkillRefs:
  - skill.react-ui
allowedToolRefs:
  - tool.workspace-read
---

# Identity

Builds React interfaces.
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "agent");
  assert.equal(parsed.file.id, "agent.frontend-developer");
  assert.equal(parsed.file.objectKey, "agent.frontend-developer");
  assert.equal(parsed.file.objectKind, "agent_definition");
  assert.equal(parsed.file.scope, "software");
  assert.equal(parsed.file.body.trim(), "# Identity\n\nBuilds React interfaces.");
  assert.deepEqual(parsed.file.frontmatter.capabilityRefs, ["capability.react-ui"]);
});

test("parses tool yaml file", () => {
  const parsed = parseLibraryFileContent({
    path: "library/tools/workspace-write.tool.yaml",
    content: `schemaVersion: southstar.library.tool_definition_file.v1
id: tool.workspace-write
title: Workspace Write
scope: global
status: draft
operations:
  - edit_file
  - apply_patch
risk:
  level: medium
  approvalRequired: false
providesCapabilityRefs:
  - capability.workspace-write
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "tool");
  assert.equal(parsed.file.id, "tool.workspace-write");
  assert.equal(parsed.file.objectKind, "tool_definition");
  assert.deepEqual(parsed.file.frontmatter.operations, ["edit_file", "apply_patch"]);
});

test("parses mcp yaml file", () => {
  const parsed = parseLibraryFileContent({
    path: "library/mcp/github.mcp.yaml",
    content: `schemaVersion: southstar.library.mcp_grant_file.v1
id: mcp.github
title: GitHub MCP
scope: global
status: draft
server: github
toolRefs:
  - tool.github-read
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "mcp");
  assert.equal(parsed.file.objectKind, "mcp_tool_grant");
  assert.equal(parsed.file.definition.server, "github");
  assert.deepEqual(parsed.file.definition.toolRefs, ["tool.github-read"]);
});

test("parses vault lease policy yaml file", () => {
  const parsed = parseLibraryFileContent({
    path: "library/vault/github-write-token.vault.yaml",
    content: `schemaVersion: southstar.library.vault_lease_policy_file.v1
id: vault.github-write-token
title: GitHub Write Token Lease
scope: engineering
status: approved
secretGroupRef: github.write
leaseTtlSeconds: 900
mountMode: env
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "vault");
  assert.equal(parsed.file.objectKind, "vault_lease_policy");
  assert.equal(parsed.file.definition.secretGroupRef, "github.write");
  assert.equal(parsed.file.definition.leaseTtlSeconds, 900);
});

test("parses generated profile yaml file", () => {
  const parsed = parseLibraryFileContent({
    path: "library/profiles/todo-implement-ui.profile.yaml",
    content: `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: profile.generated.todo.implement-ui
title: Todo Implement UI Profile
scope: software
status: draft
agentRef: agent.frontend-developer
skillRefs:
  - skill.react-ui
toolRefs:
  - tool.workspace-write
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "generated_profile");
  assert.equal(parsed.file.objectKind, "agent_profile");
  assert.equal(parsed.file.schemaVersion, "southstar.library.generated_agent_profile_file.v1");
  assert.equal(parsed.file.definition.agentRef, "agent.frontend-developer");
  assert.deepEqual(parsed.file.definition.skillRefs, ["skill.react-ui"]);
});

test("parses generated profile empty block lists", () => {
  const parsed = parseLibraryFileContent({
    path: "library/profiles/todo-implement-ui.profile.yaml",
    content: `schemaVersion: southstar.library.generated_agent_profile_file.v1
id: profile.generated.todo.implement-ui
title: Todo Implement UI Profile
scope: software
status: draft
agentRef: agent.frontend-developer
skillRefs:
  []
toolRefs:
  []
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.deepEqual(parsed.file.definition.skillRefs, []);
  assert.deepEqual(parsed.file.definition.toolRefs, []);
});

test("parses workflow template yaml file with arrays of objects", () => {
  const parsed = parseLibraryFileContent({
    path: "library/workflows/todo-ui.workflow.yaml",
    content: `schemaVersion: southstar.library.workflow_template_file.v1
id: workflow.todo-ui
title: Todo UI Workflow
scope: software
status: draft
nodes:
  - id: implement-ui
    title: Implement UI
    profileRef: profile.generated.todo.implement-ui
  - id: validate-ui
    title: Validate UI
    profileRef: profile.generated.todo.validate-ui
edges:
  - from: implement-ui
    to: validate-ui
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.equal(parsed.file.kind, "workflow_template");
  assert.equal(parsed.file.objectKind, "workflow_template");
  assert.deepEqual(parsed.file.definition.nodes, [
    {
      id: "implement-ui",
      title: "Implement UI",
      profileRef: "profile.generated.todo.implement-ui",
    },
    {
      id: "validate-ui",
      title: "Validate UI",
      profileRef: "profile.generated.todo.validate-ui",
    },
  ]);
  assert.deepEqual(parsed.file.definition.edges, [{ from: "implement-ui", to: "validate-ui" }]);
});

test("parses workflow template empty edges in block form", () => {
  const parsed = parseLibraryFileContent({
    path: "library/workflows/todo-ui.workflow.yaml",
    content: `schemaVersion: southstar.library.workflow_template_file.v1
id: workflow.todo-ui
title: Todo UI Workflow
scope: software
status: draft
nodes:
  - id: implement-ui
    title: Implement UI
edges:
  []
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.deepEqual(parsed.file.definition.edges, []);
});

test("parses workflow template empty edges in inline form", () => {
  const parsed = parseLibraryFileContent({
    path: "library/workflows/todo-ui.workflow.yaml",
    content: `schemaVersion: southstar.library.workflow_template_file.v1
id: workflow.todo-ui
title: Todo UI Workflow
scope: software
status: draft
nodes:
  - id: implement-ui
    title: Implement UI
edges: []
`,
  });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("expected parse success");
  assert.deepEqual(parsed.file.definition.edges, []);
});

test("rejects malformed workflow node object array items", () => {
  const parsed = parseLibraryFileContent({
    path: "library/workflows/todo-ui.workflow.yaml",
    content: `schemaVersion: southstar.library.workflow_template_file.v1
id: workflow.todo-ui
title: Todo UI Workflow
scope: software
status: draft
nodes:
  - id implement
edges: []
`,
  });

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map((issue) => issue.path), ["nodes"]);
});

test("rejects missing id with path-specific issue", () => {
  const parsed = parseLibraryFileContent({
    path: "library/skills/react-ui.skill.md",
    content: `---
schemaVersion: southstar.library.skill_spec_file.v1
title: React UI
scope: software
status: draft
---

# Instructions

Build UI.
`,
  });

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map((issue) => issue.path), ["id"]);
});

test("rejects invalid schema version", () => {
  const parsed = parseLibraryFileContent({
    path: "library/agents/frontend-developer.agent.md",
    content: `---
schemaVersion: southstar.library.agent_definition_file.v2
id: agent.frontend-developer
title: Frontend Developer
scope: software
status: draft
---

# Identity
`,
  });

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map((issue) => issue.path), ["schemaVersion"]);
});

test("rejects unsupported file types", () => {
  const parsed = parseLibraryFileContent({
    path: "library/agents/frontend-developer.agent.txt",
    content: "id: agent.frontend-developer\n",
  });

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.issues.map((issue) => issue.path), ["path"]);
});

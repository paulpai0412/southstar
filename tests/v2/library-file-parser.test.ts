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

test("parses vocabulary yaml files", () => {
  const capability = parseLibraryFileContent({
    path: "library/capabilities/repo-write.capability.yaml",
    content: `schemaVersion: southstar.library.capability_spec_file.v1
id: capability.repo-write
title: Repository Write
scope: software
status: approved
description: Modify files in a workspace repository.
requiredOperations:
  - workspace-write
risk:
  level: medium
  dataSensitivity: workspace
  approvalRequired: false
`,
  });
  assert.equal(capability.ok, true);
  if (!capability.ok) throw new Error("expected capability parse success");
  assert.equal(capability.file.kind, "capability");
  assert.equal(capability.file.objectKind, "capability_spec");

  const artifact = parseLibraryFileContent({
    path: "library/artifacts/implementation-report.artifact.yaml",
    content: `schemaVersion: southstar.library.artifact_contract_file.v1
id: artifact.implementation_report
title: Implementation Report
scope: software
status: approved
artifactType: implementation_report
mediaTypes:
  - application/json
evidenceKinds:
  - artifact-ref
validationRules:
  - rule.implementation-report
schemaRef: schema.implementation-report.v1
requiredFields:
  - summary
provenanceRequirements:
  - workspace-artifact
`,
  });
  assert.equal(artifact.ok, true);
  if (!artifact.ok) throw new Error("expected artifact parse success");
  assert.equal(artifact.file.kind, "artifact");
  assert.equal(artifact.file.objectKind, "artifact_contract");

  const domain = parseLibraryFileContent({
    path: "library/domains/software.domain.yaml",
    content: `schemaVersion: southstar.library.domain_taxonomy_file.v1
id: domain.software
title: Software
scope: software
status: approved
aliases:
  - software
`,
  });
  assert.equal(domain.ok, true);
  if (!domain.ok) throw new Error("expected domain parse success");
  assert.equal(domain.file.kind, "domain");
  assert.equal(domain.file.objectKind, "domain_taxonomy");

  const evaluator = parseLibraryFileContent({
    path: "library/evaluators/software-quality.evaluator.yaml",
    content: `schemaVersion: southstar.library.evaluator_profile_file.v1
id: evaluator.software-quality
title: Software Quality
scope: software
status: approved
validatesArtifactRefs:
  - artifact.verification_report
requiredInputs:
  - accepted-artifact
evidenceKinds:
  - test-result
verificationModes:
  - deterministic
verificationProcedures:
  - id: procedure.software-tests
    checkKind: deterministic
    instruction: Run the declared test suite and record the exit status.
    allowedEvidenceKinds:
      - test-result
independencePolicy: independent
resultSchemaRef: southstar.requirement_evaluator_result.v2
failureClassifications:
  - test-failure
`,
  });
  assert.equal(evaluator.ok, true);
  if (!evaluator.ok) throw new Error("expected evaluator parse success");
  assert.equal(evaluator.file.kind, "evaluator");
  assert.equal(evaluator.file.objectKind, "evaluator_profile");
});

test("rejects incomplete executable artifact and evaluator contracts", () => {
  const artifact = parseLibraryFileContent({
    path: "library/artifacts/incomplete.artifact.yaml",
    content: `schemaVersion: southstar.library.artifact_contract_file.v1
id: artifact.incomplete
title: Incomplete
scope: general
status: approved
artifactType: report
evidenceKinds:
  - test-result
`,
  });
  assert.equal(artifact.ok, false);
  if (artifact.ok) throw new Error("expected incomplete artifact rejection");
  assert.match(artifact.issues.map((issue) => issue.message).join("; "), /mediaTypes/);

  const evaluator = parseLibraryFileContent({
    path: "library/evaluators/incomplete.evaluator.yaml",
    content: `schemaVersion: southstar.library.evaluator_profile_file.v1
id: evaluator.incomplete
title: Incomplete
scope: general
status: approved
validatesArtifactRefs:
  - artifact.incomplete
requiredInputs:
  - accepted-artifact
evidenceKinds:
  - test-result
verificationModes:
  - deterministic
verificationProcedures:
  - id: procedure.incomplete
    checkKind: deterministic
    allowedEvidenceKinds:
      - test-result
independencePolicy: independent
resultSchemaRef: schema.evaluator-result.v1
failureClassifications:
  - failed
`,
  });
  assert.equal(evaluator.ok, false);
  if (evaluator.ok) throw new Error("expected incomplete evaluator rejection");
  assert.match(evaluator.issues.map((issue) => issue.message).join("; "), /instruction|southstar\.requirement_evaluator_result\.v2/);
});

test("rejects unknown executable contract fields instead of dropping them before validation", () => {
  const artifact = parseLibraryFileContent({
    path: "library/artifacts/unknown-field.artifact.yaml",
    content: `schemaVersion: southstar.library.artifact_contract_file.v1
id: artifact.unknown-field
title: Unknown Field
scope: general
status: approved
artifactType: report
mediaTypes:
  - application/json
evidenceKinds:
  - artifact-ref
validationRules:
  - rule.report
schemaRef: schema.report.v1
requiredFields:
  - summary
provenanceRequirements:
  - workspace-artifact
legacyBypass: true
`,
  });
  assert.equal(artifact.ok, false);
  if (artifact.ok) throw new Error("expected artifact parse failure");
  assert.match(artifact.issues.map((issue) => issue.message).join("\n"), /unsupported fields: legacyBypass/);
});

test("rejects import-candidate metadata in authored artifact and evaluator files", () => {
  const artifact = parseLibraryFileContent({
    path: "library/artifacts/candidate-metadata.artifact.yaml",
    content: `schemaVersion: southstar.library.artifact_contract_file.v1
id: artifact.candidate-metadata
title: Candidate Metadata
scope: general
status: approved
artifactType: report
mediaTypes:
  - application/json
evidenceKinds:
  - artifact-ref
validationRules:
  - rule.report
schemaRef: schema.report.v1
requiredFields:
  - summary
provenanceRequirements:
  - workspace-artifact
confidence: 0.9
`,
  });
  assert.equal(artifact.ok, false);
  if (artifact.ok) throw new Error("expected artifact candidate metadata rejection");
  assert.match(artifact.issues.map((issue) => issue.message).join("\n"), /unsupported fields: confidence/);

  const evaluator = parseLibraryFileContent({
    path: "library/evaluators/candidate-metadata.evaluator.yaml",
    content: `schemaVersion: southstar.library.evaluator_profile_file.v1
id: evaluator.candidate-metadata
title: Candidate Metadata Evaluator
scope: general
status: approved
validatesArtifactRefs:
  - artifact.candidate-metadata
requiredInputs:
  - accepted-artifact
evidenceKinds:
  - test-result
verificationModes:
  - deterministic
verificationProcedures:
  - id: procedure.report
    checkKind: deterministic
    instruction: Validate the report.
    allowedEvidenceKinds:
      - test-result
independencePolicy: independent
resultSchemaRef: southstar.requirement_evaluator_result.v2
failureClassifications:
  - validation_failure
classificationReason: generated for one import
`,
  });
  assert.equal(evaluator.ok, false);
  if (evaluator.ok) throw new Error("expected evaluator candidate metadata rejection");
  assert.match(evaluator.issues.map((issue) => issue.message).join("\n"), /unsupported fields: classificationReason/);
});

test("rejects duplicate evaluator procedures and unsupported procedure values", () => {
  const base = `schemaVersion: southstar.library.evaluator_profile_file.v1
id: evaluator.strict-procedures
title: Strict Procedures
scope: general
status: approved
validatesArtifactRefs:
  - artifact.report
requiredInputs:
  - accepted-artifact
evidenceKinds:
  - test-result
verificationModes:
  - deterministic
independencePolicy: independent
resultSchemaRef: southstar.requirement_evaluator_result.v2
failureClassifications:
  - validation_failure
`;
  const duplicate = parseLibraryFileContent({
    path: "library/evaluators/duplicate.evaluator.yaml",
    content: `${base}verificationProcedures:
  - id: procedure.same
    checkKind: deterministic
    instruction: Validate once.
    allowedEvidenceKinds:
      - test-result
  - id: procedure.same
    checkKind: deterministic
    instruction: Validate twice.
    allowedEvidenceKinds:
      - test-result
`,
  });
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) throw new Error("expected duplicate procedure rejection");
  assert.match(duplicate.issues.map((issue) => issue.message).join("\n"), /duplicate verification procedure id/);

  const unsupported = parseLibraryFileContent({
    path: "library/evaluators/unsupported.evaluator.yaml",
    content: `${base}verificationProcedures:
  - id: procedure.unsupported
    checkKind: shell_magic
    instruction: Validate somehow.
    allowedEvidenceKinds:
      - test-result
`,
  });
  assert.equal(unsupported.ok, false);
  if (unsupported.ok) throw new Error("expected unsupported procedure rejection");
  assert.match(unsupported.issues.map((issue) => issue.message).join("\n"), /not declared in verificationModes|unsupported verificationModes/);
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

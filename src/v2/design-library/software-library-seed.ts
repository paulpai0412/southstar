import type { SouthstarDb } from "../db/postgres.ts";
import {
  upsertLibraryEdge,
  upsertLibraryObject,
  type UpsertLibraryEdgeInput,
  type UpsertLibraryObjectInput,
} from "./library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryEdgeType } from "./types.ts";

const SOFTWARE_SCOPE = "software";
const SEED_VERSION = "v1";
const SEED_REF = `seed.software-library.${SEED_VERSION}`;

type SeedObject = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  state: Record<string, unknown>;
};

type SeedEdge = {
  fromObjectKey: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
  metadata?: Record<string, unknown>;
};

const SOFTWARE_OBJECTS: readonly SeedObject[] = [
  {
    objectKey: "template.software-feature",
    objectKind: "workflow_template",
    state: {
      title: "Software Feature Workflow",
      intentRefs: ["implement_feature", "fix_bug"],
      roleRefs: ["explorer", "maker", "checker", "summarizer"],
    },
  },
  { objectKey: "agent.software-explorer", objectKind: "agent_definition", state: { role: "explorer" } },
  { objectKey: "agent.software-spec-reviewer", objectKind: "agent_definition", state: { role: "checker" } },
  { objectKey: "agent.software-maker", objectKind: "agent_definition", state: { role: "maker" } },
  { objectKey: "agent.software-checker", objectKind: "agent_definition", state: { role: "checker" } },
  { objectKey: "agent.software-code-quality-reviewer", objectKind: "agent_definition", state: { role: "checker" } },
  { objectKey: "agent.software-summarizer", objectKind: "agent_definition", state: { role: "summarizer" } },
  {
    objectKey: "profile.software-explorer-codex",
    objectKind: "agent_profile",
    state: { provider: "codex", model: "gpt-5-codex", role: "explorer" },
  },
  {
    objectKey: "profile.software-spec-reviewer-codex",
    objectKind: "agent_profile",
    state: { provider: "codex", model: "gpt-5-codex", role: "checker" },
  },
  {
    objectKey: "profile.software-maker-pi",
    objectKind: "agent_profile",
    state: { provider: "pi", model: "pi-agent-default", role: "maker" },
  },
  {
    objectKey: "profile.software-checker-codex",
    objectKind: "agent_profile",
    state: { provider: "codex", model: "gpt-5-codex", role: "checker" },
  },
  {
    objectKey: "profile.software-code-quality-reviewer-codex",
    objectKind: "agent_profile",
    state: { provider: "codex", model: "gpt-5-codex", role: "checker" },
  },
  {
    objectKey: "profile.software-summarizer-codex",
    objectKind: "agent_profile",
    state: { provider: "codex", model: "gpt-5-codex", role: "summarizer" },
  },
  { objectKey: "skill.software-repo-discovery", objectKind: "skill_definition", state: { role: "explorer" } },
  { objectKey: "skill.software-spec-review", objectKind: "skill_definition", state: { role: "checker" } },
  { objectKey: "skill.software-implementation", objectKind: "skill_definition", state: { role: "maker" } },
  { objectKey: "skill.software-verification", objectKind: "skill_definition", state: { role: "checker" } },
  { objectKey: "skill.software-code-quality-review", objectKind: "skill_definition", state: { role: "checker" } },
  { objectKey: "skill.software-summary", objectKind: "skill_definition", state: { role: "summarizer" } },
  { objectKey: "tool.workspace-read", objectKind: "tool_definition", state: { access: "read" } },
  { objectKey: "tool.workspace-write", objectKind: "tool_definition", state: { access: "write" } },
  { objectKey: "tool.shell-command", objectKind: "tool_definition", state: { access: "shell" } },
  {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    state: {
      displayName: "Filesystem Workspace MCP Grant",
      serverId: "filesystem-workspace",
      allowedTools: ["read_file", "write_file", "list_files"],
      sideEffect: "write",
      requiresApproval: false,
    },
  },
  {
    objectKey: "vault.github-write-token",
    objectKind: "vault_lease_policy",
    state: {
      displayName: "GitHub Write Token Vault Lease",
      secretGroupRef: "github.write",
      leaseTtlSeconds: 900,
      mountMode: "proxy-only",
      allowedToolRefs: ["tool.shell-command"],
      auditRequired: true,
    },
  },
  { objectKey: "instruction.software-explorer", objectKind: "instruction_template", state: { role: "explorer" } },
  {
    objectKey: "instruction.software-spec-reviewer",
    objectKind: "instruction_template",
    state: { role: "checker" },
  },
  { objectKey: "instruction.software-maker", objectKind: "instruction_template", state: { role: "maker" } },
  { objectKey: "instruction.software-checker", objectKind: "instruction_template", state: { role: "checker" } },
  {
    objectKey: "instruction.software-code-quality-reviewer",
    objectKind: "instruction_template",
    state: { role: "checker" },
  },
  {
    objectKey: "instruction.software-summarizer",
    objectKind: "instruction_template",
    state: { role: "summarizer" },
  },
  {
    objectKey: "artifact.implementation_plan",
    objectKind: "artifact_contract",
    state: { artifactType: "implementation_plan" },
  },
  {
    objectKey: "artifact.implementation_report",
    objectKind: "artifact_contract",
    state: { artifactType: "implementation_report" },
  },
  {
    objectKey: "artifact.verification_report",
    objectKind: "artifact_contract",
    state: { artifactType: "verification_report" },
  },
  {
    objectKey: "artifact.completion_report",
    objectKind: "artifact_contract",
    state: { artifactType: "completion_report" },
  },
  {
    objectKey: "evaluator.software-plan-quality",
    objectKind: "evaluator_profile",
    state: { stage: "understand", requiredArtifact: "artifact.implementation_plan" },
  },
  {
    objectKey: "evaluator.software-feature-quality",
    objectKind: "evaluator_profile",
    state: { stage: "implement", requiredArtifact: "artifact.implementation_report" },
  },
  {
    objectKey: "evaluator.software-verification-quality",
    objectKind: "evaluator_profile",
    state: { stage: "verify", requiredArtifact: "artifact.verification_report" },
  },
  {
    objectKey: "evaluator.software-completion-quality",
    objectKind: "evaluator_profile",
    state: { stage: "summarize", requiredArtifact: "artifact.completion_report" },
  },
  {
    objectKey: "policy.software-default",
    objectKind: "policy_bundle",
    state: { workspacePolicy: "git-workspace", toolPolicy: "role-based" },
  },
  {
    objectKey: "capability.repo-read",
    objectKind: "capability_spec",
    state: { capabilityType: "tool_capability", grants: ["tool.workspace-read"] },
  },
  {
    objectKey: "capability.repo-write",
    objectKind: "capability_spec",
    state: { capabilityType: "tool_capability", grants: ["tool.workspace-write"] },
  },
  {
    objectKey: "capability.test-execution",
    objectKind: "capability_spec",
    state: { capabilityType: "tool_capability", grants: ["tool.shell-command"] },
  },
];

const SOFTWARE_EDGES: readonly SeedEdge[] = [
  { fromObjectKey: "profile.software-explorer-codex", edgeType: "implements", toObjectKey: "agent.software-explorer" },
  {
    fromObjectKey: "profile.software-spec-reviewer-codex",
    edgeType: "implements",
    toObjectKey: "agent.software-spec-reviewer",
  },
  { fromObjectKey: "profile.software-maker-pi", edgeType: "implements", toObjectKey: "agent.software-maker" },
  { fromObjectKey: "profile.software-checker-codex", edgeType: "implements", toObjectKey: "agent.software-checker" },
  {
    fromObjectKey: "profile.software-code-quality-reviewer-codex",
    edgeType: "implements",
    toObjectKey: "agent.software-code-quality-reviewer",
  },
  {
    fromObjectKey: "profile.software-summarizer-codex",
    edgeType: "implements",
    toObjectKey: "agent.software-summarizer",
  },
  {
    fromObjectKey: "agent.software-explorer",
    edgeType: "provides_capability",
    toObjectKey: "capability.repo-read",
  },
  {
    fromObjectKey: "agent.software-spec-reviewer",
    edgeType: "provides_capability",
    toObjectKey: "capability.repo-read",
  },
  { fromObjectKey: "agent.software-maker", edgeType: "provides_capability", toObjectKey: "capability.repo-write" },
  {
    fromObjectKey: "agent.software-maker",
    edgeType: "provides_capability",
    toObjectKey: "capability.test-execution",
  },
  {
    fromObjectKey: "agent.software-checker",
    edgeType: "provides_capability",
    toObjectKey: "capability.test-execution",
  },
  {
    fromObjectKey: "agent.software-code-quality-reviewer",
    edgeType: "provides_capability",
    toObjectKey: "capability.test-execution",
  },
  {
    fromObjectKey: "agent.software-summarizer",
    edgeType: "provides_capability",
    toObjectKey: "capability.repo-read",
  },
  {
    fromObjectKey: "profile.software-explorer-codex",
    edgeType: "supports_skill",
    toObjectKey: "skill.software-repo-discovery",
  },
  {
    fromObjectKey: "profile.software-spec-reviewer-codex",
    edgeType: "supports_skill",
    toObjectKey: "skill.software-spec-review",
  },
  {
    fromObjectKey: "profile.software-maker-pi",
    edgeType: "supports_skill",
    toObjectKey: "skill.software-implementation",
  },
  {
    fromObjectKey: "profile.software-checker-codex",
    edgeType: "supports_skill",
    toObjectKey: "skill.software-verification",
  },
  {
    fromObjectKey: "profile.software-code-quality-reviewer-codex",
    edgeType: "supports_skill",
    toObjectKey: "skill.software-code-quality-review",
  },
  {
    fromObjectKey: "profile.software-summarizer-codex",
    edgeType: "supports_skill",
    toObjectKey: "skill.software-summary",
  },
  { fromObjectKey: "profile.software-explorer-codex", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.software-spec-reviewer-codex", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.software-maker-pi", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.software-maker-pi", edgeType: "allows_tool", toObjectKey: "tool.workspace-write" },
  { fromObjectKey: "profile.software-maker-pi", edgeType: "allows_tool", toObjectKey: "tool.shell-command" },
  { fromObjectKey: "profile.software-maker-pi", edgeType: "allows_mcp_grant", toObjectKey: "mcp.filesystem-workspace" },
  {
    fromObjectKey: "profile.software-maker-pi",
    edgeType: "requires_secret_group",
    toObjectKey: "vault.github-write-token",
  },
  { fromObjectKey: "profile.software-checker-codex", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.software-checker-codex", edgeType: "allows_tool", toObjectKey: "tool.shell-command" },
  { fromObjectKey: "profile.software-code-quality-reviewer-codex", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.software-code-quality-reviewer-codex", edgeType: "allows_tool", toObjectKey: "tool.shell-command" },
  { fromObjectKey: "profile.software-summarizer-codex", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  {
    fromObjectKey: "profile.software-explorer-codex",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.software-explorer",
  },
  {
    fromObjectKey: "profile.software-spec-reviewer-codex",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.software-spec-reviewer",
  },
  {
    fromObjectKey: "profile.software-maker-pi",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.software-maker",
  },
  {
    fromObjectKey: "profile.software-checker-codex",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.software-checker",
  },
  {
    fromObjectKey: "profile.software-code-quality-reviewer-codex",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.software-code-quality-reviewer",
  },
  {
    fromObjectKey: "profile.software-summarizer-codex",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.software-summarizer",
  },
  {
    fromObjectKey: "agent.software-explorer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.implementation_plan",
  },
  {
    fromObjectKey: "agent.software-spec-reviewer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.implementation_plan",
  },
  {
    fromObjectKey: "agent.software-maker",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.implementation_report",
  },
  {
    fromObjectKey: "agent.software-checker",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.verification_report",
  },
  {
    fromObjectKey: "agent.software-code-quality-reviewer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.verification_report",
  },
  {
    fromObjectKey: "agent.software-summarizer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.completion_report",
  },
  {
    fromObjectKey: "evaluator.software-plan-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.implementation_plan",
  },
  {
    fromObjectKey: "evaluator.software-feature-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.implementation_report",
  },
  {
    fromObjectKey: "evaluator.software-verification-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.verification_report",
  },
  {
    fromObjectKey: "evaluator.software-completion-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.completion_report",
  },
  {
    fromObjectKey: "template.software-feature",
    edgeType: "requires_capability",
    toObjectKey: "capability.repo-read",
  },
  {
    fromObjectKey: "template.software-feature",
    edgeType: "requires_capability",
    toObjectKey: "capability.repo-write",
  },
  {
    fromObjectKey: "template.software-feature",
    edgeType: "requires_capability",
    toObjectKey: "capability.test-execution",
  },
];

export async function seedSoftwareLibraryGraph(db: SouthstarDb): Promise<void> {
  for (const object of SOFTWARE_OBJECTS) {
    await upsertSeedObject(db, object);
  }
  for (const edge of SOFTWARE_EDGES) {
    await upsertSeedEdge(db, edge);
  }
}

function objectVersionRef(objectKey: string): string {
  return `${objectKey}@${SEED_VERSION}`;
}

async function upsertSeedObject(db: SouthstarDb, object: SeedObject): Promise<void> {
  const input: UpsertLibraryObjectInput = {
    objectKey: object.objectKey,
    objectKind: object.objectKind,
    status: "approved",
    headVersionId: objectVersionRef(object.objectKey),
    state: {
      scope: SOFTWARE_SCOPE,
      seedRef: SEED_REF,
      ...object.state,
    },
  };
  await upsertLibraryObject(db, input);
}

async function upsertSeedEdge(db: SouthstarDb, edge: SeedEdge): Promise<void> {
  const input: UpsertLibraryEdgeInput = {
    fromObjectKey: edge.fromObjectKey,
    fromVersionRef: objectVersionRef(edge.fromObjectKey),
    edgeType: edge.edgeType,
    toObjectKey: edge.toObjectKey,
    toVersionRef: objectVersionRef(edge.toObjectKey),
    scope: SOFTWARE_SCOPE,
    status: "active",
    weight: 1,
    metadata: {
      seedRef: SEED_REF,
      ...edge.metadata,
    },
  };
  await upsertLibraryEdge(db, input);
}

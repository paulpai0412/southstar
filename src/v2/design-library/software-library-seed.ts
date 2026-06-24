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
  {
    objectKey: "agent.software-explorer",
    objectKind: "agent_definition",
    state: {
      role: "explorer",
      runtimeRole: {
        id: "explorer",
        responsibility: "Inspect the repository and produce a scoped implementation plan.",
        defaultAgentProfileRef: "software-explorer-codex",
        allowedAgentProfileRefs: ["software-explorer-codex"],
        artifactInputs: [],
        artifactOutputs: ["implementation_plan"],
        stopAuthority: "can-suggest",
      },
    },
  },
  {
    objectKey: "agent.software-spec-reviewer",
    objectKind: "agent_definition",
    state: {
      role: "checker",
      runtimeRole: {
        id: "spec-reviewer",
        responsibility: "Review the plan for missing requirements and execution risk.",
        defaultAgentProfileRef: "software-spec-reviewer-codex",
        allowedAgentProfileRefs: ["software-spec-reviewer-codex"],
        artifactInputs: ["implementation_plan"],
        artifactOutputs: ["implementation_plan"],
        stopAuthority: "can-reject",
      },
    },
  },
  {
    objectKey: "agent.software-maker",
    objectKind: "agent_definition",
    state: {
      role: "maker",
      runtimeRole: {
        id: "maker",
        responsibility: "Implement the requested feature and provide code-change evidence.",
        defaultAgentProfileRef: "software-maker-pi",
        allowedAgentProfileRefs: ["software-maker-pi"],
        artifactInputs: ["implementation_plan"],
        artifactOutputs: ["implementation_report"],
        stopAuthority: "none",
      },
    },
  },
  {
    objectKey: "agent.software-checker",
    objectKind: "agent_definition",
    state: {
      role: "checker",
      runtimeRole: {
        id: "checker",
        responsibility: "Verify implementation behavior and test outcomes.",
        defaultAgentProfileRef: "software-checker-codex",
        allowedAgentProfileRefs: ["software-checker-codex"],
        artifactInputs: ["implementation_report"],
        artifactOutputs: ["verification_report"],
        stopAuthority: "can-reject",
      },
    },
  },
  {
    objectKey: "agent.software-code-quality-reviewer",
    objectKind: "agent_definition",
    state: {
      role: "checker",
      runtimeRole: {
        id: "code-quality-reviewer",
        responsibility: "Assess maintainability, style, and regression risk of the implementation.",
        defaultAgentProfileRef: "software-code-quality-reviewer-codex",
        allowedAgentProfileRefs: ["software-code-quality-reviewer-codex"],
        artifactInputs: ["implementation_report"],
        artifactOutputs: ["verification_report"],
        stopAuthority: "can-reject",
      },
    },
  },
  {
    objectKey: "agent.software-summarizer",
    objectKind: "agent_definition",
    state: {
      role: "summarizer",
      runtimeRole: {
        id: "summarizer",
        responsibility: "Synthesize completed work, verification, and follow-up notes.",
        defaultAgentProfileRef: "software-summarizer-codex",
        allowedAgentProfileRefs: ["software-summarizer-codex"],
        artifactInputs: ["verification_report"],
        artifactOutputs: ["completion_report"],
        stopAuthority: "can-accept",
      },
    },
  },
  {
    objectKey: "profile.software-explorer-codex",
    objectKind: "agent_profile",
    state: {
      provider: "codex",
      model: "gpt-5-codex",
      role: "explorer",
      runtimeProfile: {
        id: "software-explorer-codex",
        name: "Software Explorer (Codex)",
        provider: "codex",
        model: "gpt-5-codex",
        harnessRef: "codex",
        agentsMdRefs: [],
        promptTemplateRef: "software-explorer",
        skillRefs: ["software-repo-discovery"],
        mcpGrantRefs: [],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 16000,
          maxOutputTokens: 8000,
          maxWallTimeSeconds: 900,
        },
      },
    },
  },
  {
    objectKey: "profile.software-spec-reviewer-codex",
    objectKind: "agent_profile",
    state: {
      provider: "codex",
      model: "gpt-5-codex",
      role: "checker",
      runtimeProfile: {
        id: "software-spec-reviewer-codex",
        name: "Software Spec Reviewer (Codex)",
        provider: "codex",
        model: "gpt-5-codex",
        harnessRef: "codex",
        agentsMdRefs: [],
        promptTemplateRef: "software-spec-reviewer",
        skillRefs: ["software-spec-review"],
        mcpGrantRefs: [],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 16000,
          maxOutputTokens: 8000,
          maxWallTimeSeconds: 900,
        },
      },
    },
  },
  {
    objectKey: "profile.software-maker-pi",
    objectKind: "agent_profile",
    state: {
      provider: "pi",
      model: "pi-agent-default",
      role: "maker",
      runtimeProfile: {
        id: "software-maker-pi",
        name: "Software Maker (Pi)",
        provider: "pi",
        model: "pi-agent-default",
        harnessRef: "pi",
        agentsMdRefs: [],
        promptTemplateRef: "software-maker",
        skillRefs: ["software-implementation"],
        mcpGrantRefs: ["filesystem-workspace"],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read", "workspace-write", "shell-command"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 20000,
          maxOutputTokens: 10000,
          maxWallTimeSeconds: 1200,
        },
      },
    },
  },
  {
    objectKey: "profile.software-checker-codex",
    objectKind: "agent_profile",
    state: {
      provider: "codex",
      model: "gpt-5-codex",
      role: "checker",
      runtimeProfile: {
        id: "software-checker-codex",
        name: "Software Checker (Codex)",
        provider: "codex",
        model: "gpt-5-codex",
        harnessRef: "codex",
        agentsMdRefs: [],
        promptTemplateRef: "software-checker",
        skillRefs: ["software-verification"],
        mcpGrantRefs: [],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read", "shell-command"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 16000,
          maxOutputTokens: 8000,
          maxWallTimeSeconds: 900,
        },
      },
    },
  },
  {
    objectKey: "profile.software-code-quality-reviewer-codex",
    objectKind: "agent_profile",
    state: {
      provider: "codex",
      model: "gpt-5-codex",
      role: "checker",
      runtimeProfile: {
        id: "software-code-quality-reviewer-codex",
        name: "Software Code Quality Reviewer (Codex)",
        provider: "codex",
        model: "gpt-5-codex",
        harnessRef: "codex",
        agentsMdRefs: [],
        promptTemplateRef: "software-code-quality-reviewer",
        skillRefs: ["software-code-quality-review"],
        mcpGrantRefs: [],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read", "shell-command"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 16000,
          maxOutputTokens: 8000,
          maxWallTimeSeconds: 900,
        },
      },
    },
  },
  {
    objectKey: "profile.software-summarizer-codex",
    objectKind: "agent_profile",
    state: {
      provider: "codex",
      model: "gpt-5-codex",
      role: "summarizer",
      runtimeProfile: {
        id: "software-summarizer-codex",
        name: "Software Summarizer (Codex)",
        provider: "codex",
        model: "gpt-5-codex",
        harnessRef: "codex",
        agentsMdRefs: [],
        promptTemplateRef: "software-summarizer",
        skillRefs: ["software-summary"],
        mcpGrantRefs: [],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 12000,
          maxOutputTokens: 6000,
          maxWallTimeSeconds: 600,
        },
      },
    },
  },
  {
    objectKey: "skill.software-repo-discovery",
    objectKind: "skill_definition",
    state: {
      role: "explorer",
      instructions: "Inspect repository structure, identify entry points, and draft a scoped implementation plan.",
      allowedTools: ["workspace-read"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["artifact.implementation_plan"],
    },
  },
  {
    objectKey: "skill.software-spec-review",
    objectKind: "skill_definition",
    state: {
      role: "checker",
      instructions: "Review plan completeness against goals, acceptance criteria, and risk notes.",
      allowedTools: ["workspace-read"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["artifact.implementation_plan"],
    },
  },
  {
    objectKey: "skill.software-implementation",
    objectKind: "skill_definition",
    state: {
      role: "maker",
      instructions: "Implement code changes, run relevant checks, and summarize implementation evidence.",
      allowedTools: ["shell", "workspace-read", "workspace-write"],
      requiredMounts: ["workspace"],
      mcpRequirements: ["filesystem-workspace"],
      artifactContracts: ["artifact.implementation_report"],
    },
  },
  {
    objectKey: "skill.software-verification",
    objectKind: "skill_definition",
    state: {
      role: "checker",
      instructions: "Validate behavior with deterministic checks and produce a verification report.",
      allowedTools: ["shell", "workspace-read"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["artifact.verification_report"],
    },
  },
  {
    objectKey: "skill.software-code-quality-review",
    objectKind: "skill_definition",
    state: {
      role: "checker",
      instructions: "Review maintainability, readability, and risk concentration of the code changes.",
      allowedTools: ["shell", "workspace-read"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["artifact.verification_report"],
    },
  },
  {
    objectKey: "skill.software-summary",
    objectKind: "skill_definition",
    state: {
      role: "summarizer",
      instructions: "Summarize delivered outcomes, verification evidence, and follow-up work.",
      allowedTools: ["workspace-read"],
      requiredMounts: ["workspace"],
      mcpRequirements: [],
      artifactContracts: ["artifact.completion_report"],
    },
  },
  {
    objectKey: "tool.workspace-read",
    objectKind: "tool_definition",
    state: { access: "read", toolName: "workspace-read", proxyToolName: "workspace-read-proxy" },
  },
  {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    state: { access: "write", toolName: "workspace-write", proxyToolName: "workspace-write-proxy" },
  },
  {
    objectKey: "tool.shell-command",
    objectKind: "tool_definition",
    state: { access: "shell", toolName: "shell", proxyToolName: "shell-proxy" },
  },
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
  {
    objectKey: "instruction.software-explorer",
    objectKind: "instruction_template",
    state: {
      role: "explorer",
      content: "Inspect repository context and produce a concise implementation plan with constraints.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.software-spec-reviewer",
    objectKind: "instruction_template",
    state: {
      role: "checker",
      content: "Review the plan for requirement coverage, edge cases, and unresolved risks before implementation.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.software-maker",
    objectKind: "instruction_template",
    state: {
      role: "maker",
      content: "Implement the requested change set, execute relevant checks, and report concrete evidence.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.software-checker",
    objectKind: "instruction_template",
    state: {
      role: "checker",
      content: "Verify implementation behavior and test outcomes against acceptance criteria.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.software-code-quality-reviewer",
    objectKind: "instruction_template",
    state: {
      role: "checker",
      content: "Audit code quality and maintainability risks, then provide actionable review findings.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.software-summarizer",
    objectKind: "instruction_template",
    state: {
      role: "summarizer",
      content: "Summarize completed work, verification evidence, and follow-up recommendations.",
      variables: ["goalPrompt", "responsibility"],
    },
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

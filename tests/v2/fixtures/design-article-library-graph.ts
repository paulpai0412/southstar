import type { SouthstarDb } from "../../../src/v2/db/postgres.ts";
import {
  upsertLibraryEdge,
  upsertLibraryObject,
  type UpsertLibraryEdgeInput,
  type UpsertLibraryObjectInput,
} from "../../../src/v2/design-library/library-graph-store.ts";
import type { LibraryDefinitionKind, LibraryEdgeType } from "../../../src/v2/design-library/types.ts";

export const DESIGN_ARTICLE_GOAL = "Turn input.md into a self-contained article/article.html that opens offline";
export const DESIGN_ARTICLE_SKILL_REF = "skill.beautiful-article";

const SCOPE = "design/article";
const VERSION = "v1";
const SEED_REF = "seed.design-article.v1";

type SeedObject = {
  objectKey: string;
  objectKind: LibraryDefinitionKind;
  state: Record<string, unknown>;
};

type SeedEdge = {
  fromObjectKey: string;
  edgeType: LibraryEdgeType;
  toObjectKey: string;
};

const OBJECTS: readonly SeedObject[] = [
  {
    objectKey: "domain.design-article",
    objectKind: "domain_taxonomy",
    state: { id: SCOPE, title: "Design / Article", aliases: ["offline article", "editorial design"] },
  },
  {
    objectKey: "template.design-article-offline",
    objectKind: "workflow_template",
    state: {
      title: "Offline Article Workflow",
      intentRefs: ["create_offline_article", "create_article", "transform_content"],
      roleRefs: ["planner", "maker", "checker"],
      compositionConstraints: {
        schemaVersion: "southstar.composition_constraints.v1",
        templateSlots: [
          { slotRef: "plan-article", matchAny: [{ agentDefinitionRef: "agent.article-planner" }] },
          { slotRef: "build-article", matchAny: [{ agentDefinitionRef: "agent.article-builder" }] },
          { slotRef: "verify-offline-article", matchAny: [{ agentDefinitionRef: "agent.article-browser-verifier" }] },
        ],
      },
    },
  },
  articlePlannerAgent(),
  articleBuilderAgent(),
  articleBrowserVerifierAgent(),
  articlePlannerProfile(),
  articleBuilderProfile(),
  articleBrowserVerifierProfile(),
  beautifulArticleSkill(),
  workspaceReadTool(),
  workspaceWriteTool(),
  shellTool(),
  browserMcpGrant(),
  articleHtmlArtifactContract(),
  articleBrowserEvaluator(),
  {
    objectKey: "capability.workspace-read",
    objectKind: "capability_spec",
    state: { capabilityType: "tool_capability", grants: ["tool.workspace-read"] },
  },
  {
    objectKey: "capability.workspace-write",
    objectKind: "capability_spec",
    state: { capabilityType: "tool_capability", grants: ["tool.workspace-write"] },
  },
  {
    objectKey: "capability.browser",
    objectKind: "capability_spec",
    state: { capabilityType: "mcp_capability", grants: ["mcp.browser-playwright"] },
  },
  {
    objectKey: "instruction.article-planner",
    objectKind: "instruction_template",
    state: {
      role: "planner",
      content: "Read input.md and plan a concise, accessible, self-contained offline article. Do not add network publication, deployment, secrets, or external assets.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.article-builder",
    objectKind: "instruction_template",
    state: {
      role: "maker",
      content: "Create article/article.html from input.md. Use semantic HTML with all CSS and optional JavaScript inline. Write only inside the workspace and do not fetch or publish anything.",
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "instruction.article-browser-verifier",
    objectKind: "instruction_template",
    state: {
      role: "checker",
      content: [
        "Verify article/article.html and the harness-created article/offline-proof.png.",
        "Return pass=true, verifiedArtifactRefs containing the exact upstream ArtifactRef, and browserEvidence with url http://127.0.0.1/article/article.html and screenshots [{path: 'article/offline-proof.png'}].",
        "Reject external assets, missing semantic structure, unreadable content, or any network publication.",
      ].join(" "),
      variables: ["goalPrompt", "responsibility"],
    },
  },
  {
    objectKey: "policy.design-article-memory",
    objectKind: "policy_bundle",
    state: {
      id: "design-article-memory",
      policyKind: "memory",
      providerRef: "postgres",
      scopes: [SCOPE, "workspace", "run"],
      maxInjectedTokens: 1500,
      maxCandidates: 5,
      requireWriteApproval: true,
    },
  },
  {
    objectKey: "policy.design-article-context",
    objectKind: "policy_bundle",
    state: {
      id: "design-article-context",
      policyKind: "context",
      maxInputTokens: 120000,
      memoryPolicyRef: "design-article-memory",
      includeAgentsMd: true,
      includeWorkspaceSummary: true,
    },
  },
  {
    objectKey: "policy.design-article-workspace",
    objectKind: "policy_bundle",
    state: {
      id: "design-article-workspace",
      policyKind: "workspace",
      provider: "git",
      snapshotAtTaskStart: true,
      snapshotAtAcceptedArtifact: true,
      forkOnCheckerReject: true,
      rollbackOnTestFailure: true,
    },
  },
];

const EDGES: readonly SeedEdge[] = [
  { fromObjectKey: "profile.article-planner-codex", edgeType: "implements", toObjectKey: "agent.article-planner" },
  { fromObjectKey: "profile.article-builder-pi", edgeType: "implements", toObjectKey: "agent.article-builder" },
  { fromObjectKey: "profile.article-browser-verifier-pi", edgeType: "implements", toObjectKey: "agent.article-browser-verifier" },
  { fromObjectKey: "agent.article-planner", edgeType: "provides_capability", toObjectKey: "capability.workspace-read" },
  { fromObjectKey: "agent.article-builder", edgeType: "provides_capability", toObjectKey: "capability.workspace-read" },
  { fromObjectKey: "agent.article-builder", edgeType: "provides_capability", toObjectKey: "capability.workspace-write" },
  { fromObjectKey: "agent.article-browser-verifier", edgeType: "provides_capability", toObjectKey: "capability.workspace-read" },
  { fromObjectKey: "agent.article-browser-verifier", edgeType: "provides_capability", toObjectKey: "capability.browser" },
  { fromObjectKey: "template.design-article-offline", edgeType: "requires_capability", toObjectKey: "capability.workspace-read" },
  { fromObjectKey: "template.design-article-offline", edgeType: "requires_capability", toObjectKey: "capability.workspace-write" },
  { fromObjectKey: "agent.article-planner", edgeType: "uses", toObjectKey: DESIGN_ARTICLE_SKILL_REF },
  { fromObjectKey: "agent.article-builder", edgeType: "uses", toObjectKey: DESIGN_ARTICLE_SKILL_REF },
  { fromObjectKey: "agent.article-browser-verifier", edgeType: "uses", toObjectKey: DESIGN_ARTICLE_SKILL_REF },
  { fromObjectKey: "profile.article-planner-codex", edgeType: "uses", toObjectKey: DESIGN_ARTICLE_SKILL_REF },
  { fromObjectKey: "profile.article-builder-pi", edgeType: "uses", toObjectKey: DESIGN_ARTICLE_SKILL_REF },
  { fromObjectKey: "profile.article-browser-verifier-pi", edgeType: "uses", toObjectKey: DESIGN_ARTICLE_SKILL_REF },
  { fromObjectKey: "profile.article-planner-codex", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.article-builder-pi", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.article-builder-pi", edgeType: "allows_tool", toObjectKey: "tool.workspace-write" },
  { fromObjectKey: "profile.article-builder-pi", edgeType: "allows_tool", toObjectKey: "tool.shell-command" },
  { fromObjectKey: "profile.article-browser-verifier-pi", edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: "profile.article-browser-verifier-pi", edgeType: "allows_tool", toObjectKey: "tool.shell-command" },
  { fromObjectKey: "profile.article-browser-verifier-pi", edgeType: "allows_mcp_grant", toObjectKey: "mcp.browser-playwright" },
  { fromObjectKey: DESIGN_ARTICLE_SKILL_REF, edgeType: "allows_tool", toObjectKey: "tool.workspace-read" },
  { fromObjectKey: DESIGN_ARTICLE_SKILL_REF, edgeType: "allows_tool", toObjectKey: "tool.workspace-write" },
  { fromObjectKey: DESIGN_ARTICLE_SKILL_REF, edgeType: "allows_tool", toObjectKey: "tool.shell-command" },
  { fromObjectKey: DESIGN_ARTICLE_SKILL_REF, edgeType: "allows_mcp_grant", toObjectKey: "mcp.browser-playwright" },
  { fromObjectKey: DESIGN_ARTICLE_SKILL_REF, edgeType: "uses_instruction", toObjectKey: "instruction.article-builder" },
  { fromObjectKey: "profile.article-planner-codex", edgeType: "uses_instruction", toObjectKey: "instruction.article-planner" },
  { fromObjectKey: "profile.article-builder-pi", edgeType: "uses_instruction", toObjectKey: "instruction.article-builder" },
  { fromObjectKey: "profile.article-browser-verifier-pi", edgeType: "uses_instruction", toObjectKey: "instruction.article-browser-verifier" },
  { fromObjectKey: "agent.article-builder", edgeType: "produces_artifact", toObjectKey: "artifact.article_html" },
  { fromObjectKey: "agent.article-browser-verifier", edgeType: "consumes_artifact", toObjectKey: "artifact.article_html" },
  { fromObjectKey: "agent.article-browser-verifier", edgeType: "produces_artifact", toObjectKey: "artifact.article_html" },
  { fromObjectKey: "evaluator.article-browser", edgeType: "validates_artifact", toObjectKey: "artifact.article_html" },
  { fromObjectKey: "agent.article-planner", edgeType: "workflow_precedes", toObjectKey: "agent.article-builder" },
  { fromObjectKey: "agent.article-builder", edgeType: "workflow_precedes", toObjectKey: "agent.article-browser-verifier" },
  { fromObjectKey: "agent.article-planner", edgeType: "belongs_to_domain", toObjectKey: "domain.design-article" },
  { fromObjectKey: "agent.article-builder", edgeType: "belongs_to_domain", toObjectKey: "domain.design-article" },
  { fromObjectKey: "agent.article-browser-verifier", edgeType: "belongs_to_domain", toObjectKey: "domain.design-article" },
];

export async function seedDesignArticleLibraryGraph(db: SouthstarDb): Promise<void> {
  await seedApprovedObjects(db, OBJECTS);
  await seedApprovedEdges(db, EDGES);
}

function articlePlannerAgent(): SeedObject {
  return {
    objectKey: "agent.article-planner",
    objectKind: "agent_definition",
    state: {
      role: "planner",
      runtimeRole: {
        id: "article-planner",
        responsibility: "Read input.md and plan the article structure, accessibility, and offline boundaries.",
        defaultAgentProfileRef: "article-planner-codex",
        allowedAgentProfileRefs: ["article-planner-codex"],
        artifactInputs: [],
        artifactOutputs: [],
        stopAuthority: "can-suggest",
      },
    },
  };
}

function articleBuilderAgent(): SeedObject {
  return {
    objectKey: "agent.article-builder",
    objectKind: "agent_definition",
    state: {
      role: "maker",
      runtimeRole: {
        id: "article-builder",
        responsibility: "Transform input.md into article/article.html with all presentation assets inline.",
        defaultAgentProfileRef: "article-builder-pi",
        allowedAgentProfileRefs: ["article-builder-pi"],
        artifactInputs: [],
        artifactOutputs: ["article_html"],
        stopAuthority: "none",
      },
    },
  };
}

function articleBrowserVerifierAgent(): SeedObject {
  return {
    objectKey: "agent.article-browser-verifier",
    objectKind: "agent_definition",
    state: {
      role: "checker",
      runtimeRole: {
        id: "article-browser-verifier",
        responsibility: "Verify the article offline, inspect semantic readability, and report URL plus screenshot evidence.",
        defaultAgentProfileRef: "article-browser-verifier-pi",
        allowedAgentProfileRefs: ["article-browser-verifier-pi"],
        artifactInputs: ["article_html"],
        artifactOutputs: ["article_html"],
        stopAuthority: "can-reject",
      },
    },
  };
}

function articlePlannerProfile(): SeedObject {
  return profile("profile.article-planner-codex", {
    id: "article-planner-codex",
    name: "Article Planner (Codex)",
    provider: "codex",
    model: "gpt-5-codex",
    harnessRef: "codex",
    promptTemplateRef: "article-planner",
    allowedTools: ["workspace-read"],
    mcpGrantRefs: [],
  });
}

function articleBuilderProfile(): SeedObject {
  return profile("profile.article-builder-pi", {
    id: "article-builder-pi",
    name: "Article Builder (Pi)",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    promptTemplateRef: "article-builder",
    allowedTools: ["workspace-read", "workspace-write", "shell-command"],
    mcpGrantRefs: [],
  });
}

function articleBrowserVerifierProfile(): SeedObject {
  return profile("profile.article-browser-verifier-pi", {
    id: "article-browser-verifier-pi",
    name: "Article Browser Verifier (Pi)",
    provider: "pi",
    model: "pi-agent-default",
    harnessRef: "pi",
    promptTemplateRef: "article-browser-verifier",
    allowedTools: ["workspace-read", "shell-command"],
    mcpGrantRefs: ["browser-playwright"],
  });
}

function profile(objectKey: string, input: {
  id: string;
  name: string;
  provider: "codex" | "pi";
  model: string;
  harnessRef: "codex" | "pi";
  promptTemplateRef: string;
  allowedTools: string[];
  mcpGrantRefs: string[];
}): SeedObject {
  return {
    objectKey,
    objectKind: "agent_profile",
    state: {
      provider: input.provider,
      model: input.model,
      role: input.id.includes("verifier") ? "checker" : input.id.includes("builder") ? "maker" : "planner",
      runtimeProfile: {
        id: input.id,
        name: input.name,
        provider: input.provider,
        model: input.model,
        harnessRef: input.harnessRef,
        agentsMdRefs: [],
        promptTemplateRef: input.promptTemplateRef,
        skillRefs: ["beautiful-article"],
        mcpGrantRefs: input.mcpGrantRefs,
        memoryScopes: ["workspace", "run", SCOPE],
        contextPolicyRef: "design-article-context",
        sessionPolicyRef: "session-default",
        toolPolicy: { allowedTools: input.allowedTools, deniedTools: [], requiresApprovalFor: [] },
        budgetPolicy: { maxInputTokens: 20000, maxOutputTokens: 10000, maxWallTimeSeconds: 1200 },
      },
    },
  };
}

function beautifulArticleSkill(): SeedObject {
  return {
    objectKey: DESIGN_ARTICLE_SKILL_REF,
    objectKind: "skill_spec",
    state: {
      role: "maker",
      instructions: [
        "Read input.md and create article/article.html as a polished semantic article with inline CSS and no external assets.",
        "The builder writes only inside the workspace and never deploys, publishes, fetches network content, or accesses secrets.",
        "The browser verifier checks the existing article/offline-proof.png and returns pass=true, the exact upstream verifiedArtifactRefs, browserEvidence.url http://127.0.0.1/article/article.html, and browserEvidence.screenshots path article/offline-proof.png.",
      ].join(" "),
      allowedTools: ["workspace-read", "workspace-write", "shell-command"],
      requiredMounts: ["workspace"],
      mcpRequirements: ["browser-playwright"],
      artifactContracts: ["artifact.article_html"],
    },
  };
}

function workspaceReadTool(): SeedObject {
  return { objectKey: "tool.workspace-read", objectKind: "tool_definition", state: { access: "read", runtimeToolNames: ["read", "grep", "find", "ls"] } };
}

function workspaceWriteTool(): SeedObject {
  return { objectKey: "tool.workspace-write", objectKind: "tool_definition", state: { access: "write", runtimeToolNames: ["edit", "write"] } };
}

function shellTool(): SeedObject {
  return { objectKey: "tool.shell-command", objectKind: "tool_definition", state: { access: "shell", runtimeToolNames: ["bash"] } };
}

function browserMcpGrant(): SeedObject {
  return {
    objectKey: "mcp.browser-playwright",
    objectKind: "mcp_tool_grant",
    state: {
      displayName: "Browser Playwright MCP Grant",
      serverId: "browser-playwright",
      transport: "stdio",
      command: "node",
      args: ["/app/src/v2/mcp/browser-playwright-server.ts"],
      cwd: "/workspace/repo",
      allowedTools: ["navigate", "screenshot"],
      requiresApproval: false,
    },
  };
}

function articleHtmlArtifactContract(): SeedObject {
  return {
    objectKey: "artifact.article_html",
    objectKind: "artifact_contract",
    state: {
      artifactType: "article_html",
      requiredFields: ["summary"],
      evidenceFields: ["summary", "verifiedArtifactRefs", "browserEvidence"],
    },
  };
}

function articleBrowserEvaluator(): SeedObject {
  return {
    objectKey: "evaluator.article-browser",
    objectKind: "evaluator_profile",
    state: {
      stage: "verify",
      requiredArtifact: "artifact.article_html",
      requiredEvidenceKinds: ["artifact-ref", "url", "screenshot"],
    },
  };
}

async function seedApprovedObjects(db: SouthstarDb, objects: readonly SeedObject[]): Promise<void> {
  for (const object of objects) {
    const input: UpsertLibraryObjectInput = {
      objectKey: object.objectKey,
      objectKind: object.objectKind,
      status: "approved",
      headVersionId: versionRef(object.objectKey),
      state: { scope: SCOPE, seedRef: SEED_REF, ...object.state },
    };
    await upsertLibraryObject(db, input);
  }
}

async function seedApprovedEdges(db: SouthstarDb, edges: readonly SeedEdge[]): Promise<void> {
  for (const edge of edges) {
    const input: UpsertLibraryEdgeInput = {
      fromObjectKey: edge.fromObjectKey,
      fromVersionRef: versionRef(edge.fromObjectKey),
      edgeType: edge.edgeType,
      toObjectKey: edge.toObjectKey,
      toVersionRef: versionRef(edge.toObjectKey),
      scope: SCOPE,
      status: "active",
      weight: 1,
      metadata: { seedRef: SEED_REF },
    };
    await upsertLibraryEdge(db, input);
  }
}

function versionRef(objectKey: string): string {
  return `${objectKey}@${VERSION}`;
}

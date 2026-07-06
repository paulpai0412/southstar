import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowAgentSummary,
  WorkflowDomain,
  WorkflowLibrary,
  WorkflowLibraryStoreOptions,
  WorkflowResource,
  WorkflowResourceKind,
  WorkflowResourceReadOptions,
  WorkflowResourceSummary,
  WorkflowResourceWriteOptions,
} from "./types";

const SOFTWARE_DOMAIN_ID = "software";

const SOFTWARE_AGENTS: WorkflowAgentSummary[] = [
  agent("software-explorer", "Explorer", "explorer", "software-explorer-codex", ["repo-map"], ["filesystem-workspace"]),
  agent("software-planner", "Planner", "planner", "software-planner-codex", ["implementation-plan"], ["filesystem-workspace"]),
  agent("software-maker", "Maker", "maker", "software-maker-pi", ["software-implementation"], ["filesystem-workspace"]),
  agent("software-checker", "Checker", "checker", "software-checker-pi", ["browser-qa"], ["browser", "filesystem-workspace"]),
  agent("software-summarizer", "Summarizer", "summarizer", "software-summarizer-codex", ["release-summary"], []),
];

const SOFTWARE_RESOURCE_LIST: WorkflowResource[] = SOFTWARE_AGENTS.flatMap((agentSummary) => {
  const agentDir = path.posix.dirname(agentSummary.profileResourcePath);
  return [
    resource(agentSummary.profileResourcePath, "profile.json", "json", JSON.stringify(profileFixture(agentSummary), null, 2)),
    resource(agentSummary.instructionResourcePath, "instruction.md", "markdown", instructionFixture(agentSummary)),
    ...agentSummary.skillResourcePaths.map((resourcePath) => resource(resourcePath, path.posix.basename(resourcePath), "markdown", skillFixture(agentSummary))),
    ...agentSummary.mcpResourcePaths.map((resourcePath) => resource(resourcePath, path.posix.basename(resourcePath), "json", JSON.stringify(mcpFixture(resourcePath), null, 2))),
    resource(`${agentDir}/policies/tools.json`, "tools.json", "json", JSON.stringify({
      allowedTools: ["workspace-read", "workspace-write", "tests", "browser"],
      deniedTools: [],
      requiresApprovalFor: ["external-network", "credential-access"],
    }, null, 2)),
    resource(`${agentDir}/policies/budget-default.json`, "budget-default.json", "json", JSON.stringify({
      maxInputTokens: 20000,
      maxOutputTokens: 10000,
      maxWallTimeSeconds: 1200,
    }, null, 2)),
  ];
});

const SOFTWARE_RESOURCES = new Map<string, WorkflowResource>(
  SOFTWARE_RESOURCE_LIST.map((workflowResource) => [workflowResource.path, workflowResource]),
);

const SOFTWARE_DOMAIN: WorkflowDomain = {
  id: SOFTWARE_DOMAIN_ID,
  label: "Software",
  workflowTemplates: [
    {
      id: "template.software-feature",
      domainId: SOFTWARE_DOMAIN_ID,
      title: "Software Feature Workflow",
      description: "Explorer, planner, maker, checker, and summarizer workflow for software changes.",
      nodes: [
        { id: "understand", title: "Understand software change" },
        { id: "plan", title: "Plan software change" },
        { id: "implement", title: "Implement software change" },
        { id: "verify", title: "Verify software change" },
        { id: "summarize", title: "Summarize software change" },
      ],
      agentRefs: SOFTWARE_AGENTS.map((agentSummary) => agentSummary.id),
      stageRefs: ["understand", "plan", "implement", "verify", "summarize"],
      status: "approved",
    },
  ],
  agents: SOFTWARE_AGENTS,
  resources: SOFTWARE_RESOURCE_LIST.map(resourceSummary),
};

const FIXTURE_LIBRARY: WorkflowLibrary = {
  domains: [SOFTWARE_DOMAIN],
};

export async function loadWorkflowLibrary(options: WorkflowLibraryStoreOptions): Promise<WorkflowLibrary> {
  const cwd = options.cwd?.trim();
  if (!cwd) return FIXTURE_LIBRARY;

  const root = localLibraryRoot(cwd);
  try {
    await fs.access(root);
  } catch {
    return FIXTURE_LIBRARY;
  }

  return FIXTURE_LIBRARY;
}

export async function readWorkflowResource(options: WorkflowResourceReadOptions): Promise<WorkflowResource> {
  const resourcePath = assertSafeResourcePath(options.resourcePath);
  const filePath = options.cwd ? path.join(localLibraryRoot(options.cwd), resourcePath) : null;

  if (filePath) {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error(`Workflow resource is not a file: ${resourcePath}`);
      return {
        path: resourcePath,
        label: path.posix.basename(resourcePath),
        kind: kindFromPath(resourcePath),
        content: await fs.readFile(filePath, "utf8"),
        source: "file",
        writable: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const fixture = SOFTWARE_RESOURCES.get(resourcePath);
  if (!fixture) throw new Error(`Workflow resource not found: ${resourcePath}`);
  return fixture;
}

export async function writeWorkflowResource(options: WorkflowResourceWriteOptions): Promise<WorkflowResource> {
  if (!options.cwd) throw new Error("A project directory is required to write workflow resources");
  const resourcePath = assertSafeResourcePath(options.resourcePath);
  const kind = kindFromPath(resourcePath);
  if (kind === "json") JSON.parse(options.content);

  const filePath = path.join(localLibraryRoot(options.cwd), resourcePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, options.content, "utf8");

  return {
    path: resourcePath,
    label: path.posix.basename(resourcePath),
    kind,
    content: options.content,
    source: "file",
    writable: true,
  };
}

function localLibraryRoot(cwd: string): string {
  return path.join(cwd, ".southstar", "library", "domains");
}

function assertSafeResourcePath(resourcePath: string): string {
  const normalized = path.posix.normalize(resourcePath.replaceAll("\\", "/"));
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(resourcePath) ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid workflow resource path: ${resourcePath}`);
  }
  return normalized;
}

function kindFromPath(resourcePath: string): WorkflowResourceKind {
  return resourcePath.endsWith(".md") ? "markdown" : "json";
}

function resource(pathname: string, label: string, kind: WorkflowResourceKind, content: string): WorkflowResource {
  return {
    path: pathname,
    label,
    kind,
    content,
    source: "fixture",
    writable: false,
  };
}

function resourceSummary(input: WorkflowResource): WorkflowResourceSummary {
  return {
    path: input.path,
    label: input.label,
    kind: input.kind,
    domainId: SOFTWARE_DOMAIN_ID,
  };
}

function agent(
  id: string,
  label: string,
  role: string,
  profileId: string,
  skillRefs: string[],
  mcpRefs: string[],
): WorkflowAgentSummary {
  const base = `${SOFTWARE_DOMAIN_ID}/agents/${id}`;
  return {
    id: `agent.${id}`,
    domainId: SOFTWARE_DOMAIN_ID,
    label,
    role,
    defaultProfileRef: `profile.${profileId}`,
    profileResourcePath: `${base}/profile.json`,
    instructionResourcePath: `${base}/instruction.md`,
    skillResourcePaths: skillRefs.map((skillRef) => `${base}/skills/${skillRef}/SKILL.md`),
    mcpResourcePaths: mcpRefs.map((mcpRef) => `${base}/mcp/${mcpRef}.json`),
    policyResourcePaths: [`${base}/policies/tools.json`, `${base}/policies/budget-default.json`],
  };
}

function profileFixture(agentSummary: WorkflowAgentSummary) {
  const provider = agentSummary.defaultProfileRef.endsWith("-pi") ? "pi" : "codex";
  return {
    id: agentSummary.defaultProfileRef,
    name: agentSummary.label,
    role: agentSummary.role,
    provider,
    model: provider === "pi" ? "pi-agent-default" : "gpt-5-codex",
    harnessRef: provider,
    skillRefs: agentSummary.skillResourcePaths.map((resourcePath) => resourcePath.split("/").at(-2)),
    mcpGrantRefs: agentSummary.mcpResourcePaths.map((resourcePath) => path.posix.basename(resourcePath, ".json")),
    toolPolicy: {
      allowedTools: ["workspace-read", "workspace-write", "tests", "browser"],
      deniedTools: [],
      requiresApprovalFor: ["external-network", "credential-access"],
    },
    budgetPolicy: {
      maxInputTokens: 20000,
      maxOutputTokens: 10000,
      maxWallTimeSeconds: 1200,
    },
  };
}

function instructionFixture(agentSummary: WorkflowAgentSummary): string {
  return [
    `# ${agentSummary.label}`,
    "",
    `Role: ${agentSummary.role}`,
    "",
    "Use the workspace evidence and return a concise artifact for the next workflow stage.",
  ].join("\n");
}

function skillFixture(agentSummary: WorkflowAgentSummary): string {
  return [
    `# ${agentSummary.label} Skill`,
    "",
    "Follow the current repository conventions and keep evidence attached to the workflow task.",
  ].join("\n");
}

function mcpFixture(resourcePath: string) {
  return {
    id: path.posix.basename(resourcePath, ".json"),
    transport: "local",
    grants: ["read", "write"],
  };
}

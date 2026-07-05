import type { ApiEnvelope } from "../server/types.ts";

export type SouthstarMcpRuntimeClient = {
  getRuntimeHealth(): Promise<ApiEnvelope<unknown>>;
  searchWorkflowTemplates(body: { prompt: string; domain?: string; limit?: number }): Promise<ApiEnvelope<unknown>>;
  getWorkflowTemplate(templateRef: string): Promise<ApiEnvelope<unknown>>;
  instantiateWorkflowTemplate(body: {
    templateRef: string;
    goalPrompt: string;
    cwd?: string;
    repo?: { path?: string; url?: string; branch?: string };
    constraints?: { mode?: "strict" | "adaptive"; maxNodes?: number; requireApproval?: boolean };
  }): Promise<ApiEnvelope<unknown>>;
  getPlannerDraftOrchestration(draftId: string): Promise<ApiEnvelope<unknown>>;
  createRunFromPlannerDraft(draftId: string): Promise<ApiEnvelope<unknown>>;
  getRun(runId: string): Promise<ApiEnvelope<unknown>>;
  getTask(body: { runId: string; taskId: string }): Promise<ApiEnvelope<unknown>>;
  getArtifact(body: { artifactRef: string }): Promise<ApiEnvelope<unknown>>;
};

export type SouthstarMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type SouthstarMcpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
};

export type SouthstarMcpToolRegistry = {
  listTools(): SouthstarMcpTool[];
  callTool(name: string, input: unknown): Promise<SouthstarMcpToolResult>;
};

export function createSouthstarMcpToolRegistry(input: { client: SouthstarMcpRuntimeClient }): SouthstarMcpToolRegistry {
  const tools: Array<SouthstarMcpTool & { call: (value: unknown) => Promise<unknown> }> = [
    {
      name: "southstar.system.status",
      description: "Read Southstar runtime health, database readiness, and loop configuration.",
      inputSchema: objectSchema({}),
      call: async () => unwrap(await input.client.getRuntimeHealth()),
    },
    {
      name: "southstar.workflow.search_templates",
      description: "Search approved workflow templates that can satisfy a prompt.",
      inputSchema: objectSchema({
        prompt: stringSchema("Prompt describing the work to run."),
        domain: optionalStringSchema("Optional library domain filter."),
        limit: optionalNumberSchema("Maximum number of templates to return."),
      }, ["prompt"]),
      call: async (value) => {
        const body = asRecord(value);
        return unwrap(await input.client.searchWorkflowTemplates({
          prompt: requiredString(body.prompt, "prompt"),
          ...(optionalString(body.domain) ? { domain: optionalString(body.domain) } : {}),
          ...(optionalNumber(body.limit) !== undefined ? { limit: optionalNumber(body.limit) } : {}),
        }));
      },
    },
    {
      name: "southstar.workflow.get_template",
      description: "Read a workflow template skeleton and instantiate readiness.",
      inputSchema: objectSchema({
        templateRef: stringSchema("Workflow template object key."),
      }, ["templateRef"]),
      call: async (value) => unwrap(await input.client.getWorkflowTemplate(requiredString(asRecord(value).templateRef, "templateRef"))),
    },
    {
      name: "southstar.workflow.instantiate_template",
      description: "Instantiate a workflow template into a validated planner draft.",
      inputSchema: objectSchema({
        templateRef: stringSchema("Workflow template object key."),
        goalPrompt: stringSchema("Current user goal to bind into the template."),
        cwd: optionalStringSchema("Optional workspace path for runtime execution."),
        repo: optionalObjectSchema("Optional repository target metadata."),
        constraints: optionalObjectSchema("Optional template instantiation constraints."),
      }, ["templateRef", "goalPrompt"]),
      call: async (value) => {
        const body = asRecord(value);
        return unwrap(await input.client.instantiateWorkflowTemplate({
          templateRef: requiredString(body.templateRef, "templateRef"),
          goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
          ...(optionalString(body.cwd) ? { cwd: optionalString(body.cwd) } : {}),
          ...(isRecord(body.repo) ? { repo: parseRepo(body.repo) } : {}),
          ...(isRecord(body.constraints) ? { constraints: parseConstraints(body.constraints) } : {}),
        }));
      },
    },
    {
      name: "southstar.workflow.get_draft",
      description: "Read a planner draft orchestration view.",
      inputSchema: objectSchema({
        draftId: stringSchema("Planner draft id."),
      }, ["draftId"]),
      call: async (value) => unwrap(await input.client.getPlannerDraftOrchestration(requiredString(asRecord(value).draftId, "draftId"))),
    },
    {
      name: "southstar.workflow.run_draft",
      description: "Create a workflow run from a validated planner draft.",
      inputSchema: objectSchema({
        draftId: stringSchema("Planner draft id."),
      }, ["draftId"]),
      call: async (value) => unwrap(await input.client.createRunFromPlannerDraft(requiredString(asRecord(value).draftId, "draftId"))),
    },
    {
      name: "southstar.workflow.inspect_run",
      description: "Inspect a workflow run or a single workflow task.",
      inputSchema: objectSchema({
        runId: stringSchema("Workflow run id."),
        taskId: optionalStringSchema("Optional task id for task-level inspection."),
      }, ["runId"]),
      call: async (value) => {
        const body = asRecord(value);
        const runId = requiredString(body.runId, "runId");
        const taskId = optionalString(body.taskId);
        if (taskId) return unwrap(await input.client.getTask({ runId, taskId }));
        return unwrap(await input.client.getRun(runId));
      },
    },
    {
      name: "southstar.workflow.get_artifact",
      description: "Read an artifact_ref and its JSON artifact blob content.",
      inputSchema: objectSchema({
        artifactRef: stringSchema("Artifact ref id."),
      }, ["artifactRef"]),
      call: async (value) => unwrap(await input.client.getArtifact({ artifactRef: requiredString(asRecord(value).artifactRef, "artifactRef") })),
    },
  ];

  return {
    listTools() {
      return tools.map(({ call: _call, ...tool }) => tool);
    },
    async callTool(name: string, value: unknown) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`unknown Southstar MCP tool: ${name}`);
      const structuredContent = await tool.call(value);
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
      };
    },
  };
}

function unwrap(envelope: ApiEnvelope<unknown>): unknown {
  return envelope.result;
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", minLength: 1, description };
}

function optionalStringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function optionalNumberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

function optionalObjectSchema(description: string): Record<string, unknown> {
  return { type: "object", description, additionalProperties: true };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRepo(value: Record<string, unknown>): { path?: string; url?: string; branch?: string } {
  return {
    ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
    ...(optionalString(value.url) ? { url: optionalString(value.url) } : {}),
    ...(optionalString(value.branch) ? { branch: optionalString(value.branch) } : {}),
  };
}

function parseConstraints(value: Record<string, unknown>): { mode?: "strict" | "adaptive"; maxNodes?: number; requireApproval?: boolean } {
  const maxNodes = optionalNumber(value.maxNodes);
  return {
    ...(value.mode === "strict" || value.mode === "adaptive" ? { mode: value.mode } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(typeof value.requireApproval === "boolean" ? { requireApproval: value.requireApproval } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

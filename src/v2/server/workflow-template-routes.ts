import {
  getWorkflowTemplateDetailPg,
  instantiateWorkflowTemplatePg,
  searchWorkflowTemplatesPg,
} from "../workflow-templates/template-api-service.ts";
import { LlmWorkflowComposer } from "../orchestration/llm-composer.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleWorkflowTemplateRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/v2/workflow/templates/search") {
    return json("workflow-template-search", await searchWorkflowTemplatesPg(context.db, {
      prompt: url.searchParams.get("prompt") ?? "",
      domain: url.searchParams.get("domain") ?? undefined,
      limit: optionalInteger(url.searchParams.get("limit")),
    }));
  }

  if (request.method === "POST" && url.pathname === "/api/v2/workflow/templates/instantiate") {
    const body = await readJsonBody<{
      templateRef?: unknown;
      goalPrompt?: unknown;
      cwd?: unknown;
      repo?: unknown;
      constraints?: unknown;
    }>(request);
    return json("workflow-template-instantiate", await instantiateWorkflowTemplatePg(context.db, {
      templateRef: requiredString(body.templateRef, "templateRef"),
      goalPrompt: requiredString(body.goalPrompt, "goalPrompt"),
      ...(optionalString(body.cwd) ? { cwd: optionalString(body.cwd) } : {}),
      ...(isRecord(body.repo) ? { repo: parseRepo(body.repo) } : {}),
      ...(isRecord(body.constraints) ? { constraints: parseConstraints(body.constraints) } : {}),
      composer: resolveWorkflowTemplateComposer(context),
    }));
  }

  const detailMatch = url.pathname.match(/^\/api\/v2\/workflow\/templates\/(.+)$/);
  if (request.method === "GET" && detailMatch) {
    return json("workflow-template-detail", await getWorkflowTemplateDetailPg(context.db, {
      templateRef: decodeURIComponent(detailMatch[1]!),
    }));
  }

  return null;
}

function resolveWorkflowTemplateComposer(context: RuntimeServerContext): WorkflowComposer {
  if (context.workflowComposer) return context.workflowComposer;
  return new LlmWorkflowComposer({
    model: process.env.SOUTHSTAR_WORKFLOW_COMPOSER_MODEL ?? "southstar-runtime-workflow-composer",
    client: {
      async generateText(input) {
        return await context.plannerClient.generate(input.prompt);
      },
      async generateTextStream(input, handlers) {
        if (context.plannerClient.generateStream) {
          return await context.plannerClient.generateStream(input.prompt, { onDelta: handlers.onDelta });
        }
        return await context.plannerClient.generate(input.prompt);
      },
    },
  });
}

function json<T>(kind: string, result: T): Response {
  const envelope: ApiEnvelope<T> = { ok: true, kind, result };
  return new Response(JSON.stringify(envelope), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

async function readJsonBody<T>(request: Request): Promise<T> {
  if (!request.body) return {} as T;
  return await request.json() as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalInteger(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRepo(value: Record<string, unknown>): { path?: string; url?: string; branch?: string } {
  return {
    ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
    ...(optionalString(value.url) ? { url: optionalString(value.url) } : {}),
    ...(optionalString(value.branch) ? { branch: optionalString(value.branch) } : {}),
  };
}

function parseConstraints(value: Record<string, unknown>): { mode?: "strict" | "adaptive"; maxNodes?: number; requireApproval?: boolean } {
  const maxNodes = typeof value.maxNodes === "number" && Number.isFinite(value.maxNodes) ? value.maxNodes : undefined;
  return {
    ...(value.mode === "strict" || value.mode === "adaptive" ? { mode: value.mode } : {}),
    ...(maxNodes !== undefined ? { maxNodes } : {}),
    ...(typeof value.requireApproval === "boolean" ? { requireApproval: value.requireApproval } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

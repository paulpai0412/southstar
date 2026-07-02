import { randomUUID } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  applyLibraryObjectLifecycleAction,
  type LibraryObjectLifecycleAction,
} from "../design-library/lifecycle/library-object-lifecycle.ts";
import { asImportSource } from "../design-library/importers/library-import-extractor.ts";
import {
  approveLibraryImportDraft,
  createLibraryImportDraft,
} from "../design-library/importers/library-import-draft-store.ts";
import { findLibraryEdgesFrom, findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import {
  saveWorkflowTemplateDraft,
  type SaveWorkflowTemplateDraftInput,
} from "../design-library/templates/workflow-template-save-service.ts";
import {
  listLibraryFiles,
  readLibraryFile,
  syncLibraryFileToGraph,
  writeLibraryFile,
} from "../design-library/files/library-file-store.ts";
import type { LibraryChatAction } from "../read-models/library-chat.ts";
import { buildLibraryGraphReadModel } from "../read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../read-models/library-workspace.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleLibraryRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method === "GET" && url.pathname === "/api/v2/library/workspace") {
    return json(
      "library-workspace",
      await buildLibraryWorkspaceReadModel(context.db, {
        selectedScope: url.searchParams.get("scope") ?? undefined,
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/graph") {
    return json(
      "library-graph",
      await buildLibraryGraphReadModel(context.db, {
        scope: url.searchParams.get("scope") ?? undefined,
        objectKey: url.searchParams.get("objectKey") ?? undefined,
        depth: optionalNumber(url.searchParams.get("depth")),
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/graph/neighborhood") {
    return json(
      "library-graph-neighborhood",
      await buildLibraryGraphReadModel(context.db, {
        scope: url.searchParams.get("scope") ?? undefined,
        objectKey: requiredQueryParam(url, "objectKey"),
        depth: optionalNumber(url.searchParams.get("depth")),
      }),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/files") {
    return json("library-files", { files: await listLibraryFiles({ root: libraryRoot(context) }) });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/import-drafts") {
    const body = await readJsonBody<{ source?: unknown; scope?: unknown }>(request);
    return json("library-import-draft", await createLibraryImportDraft(context.db, {
      source: asImportSource(body.source),
      scope: optionalString(body.scope) ?? "software",
    }));
  }

  const importDraftApproveMatch = url.pathname.match(/^\/api\/v2\/library\/import-drafts\/([^/]+)\/approve$/);
  if (request.method === "POST" && importDraftApproveMatch) {
    const body = await readJsonBody<{ actor?: unknown; reason?: unknown }>(request);
    return json("library-import-draft-approval", await approveLibraryImportDraft(context.db, {
      root: libraryRoot(context),
      draftId: decodeURIComponent(importDraftApproveMatch[1]!),
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
    }));
  }

  const saveTemplateMatch = url.pathname.match(/^\/api\/v2\/workflow\/drafts\/([^/]+)\/save-template$/);
  if (request.method === "POST" && saveTemplateMatch) {
    const body = await readJsonBody<any>(request);
    const draftId = decodeURIComponent(saveTemplateMatch[1]!);
    const draft = await getResourceByKeyPg(context.db, "planner_draft", draftId);
    if (!draft) return errorJson(`planner draft not found: ${draftId}`, 404);
    const workflow = asRecord(asRecord(draft.payload).workflow);
    const scope = optionalString(body.scope) ?? "software";
    const result = await saveWorkflowTemplateDraft(context.db, {
      root: libraryRoot(context),
      scope,
      templateId: requiredString(body.templateId, "templateId"),
      title: requiredString(body.title, "title"),
      ...await saveTemplateGraphFromWorkflow(context.db, workflow, scope),
    });
    return json("workflow-template-save", { draftId, ...result });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/import-prompts") {
    const body = await readJsonBody<{ prompt?: unknown; scope?: unknown }>(request);
    const prompt = requiredString(body.prompt, "prompt");
    const scope = optionalString(body.scope) ?? "software";
    const draft = await createLibraryImportDraft(context.db, {
      source: { kind: "paste", label: "Prompt import", content: prompt },
      scope,
    });
    return json("library-import-prompt", {
      ...draft,
      files: draft.proposal.files.map((file) => ({ relativePath: file.relativePath })),
      objectKeys: draft.proposal.objectKeys,
      status: "ready_for_review",
    });
  }

  if (request.method === "POST" && url.pathname === "/api/v2/library/chat/messages") {
    const body = await readJsonBody<{ sessionId?: unknown; prompt?: unknown; scope?: unknown }>(request);
    const prompt = requiredNonBlankString(body.prompt, "prompt");
    const action: LibraryChatAction = {
      actionId: `library-action-${randomUUID()}`,
      sessionId: optionalString(body.sessionId) ?? `library-chat-${randomUUID()}`,
      prompt,
      scope: optionalString(body.scope) ?? "software",
    };

    await upsertRuntimeResourcePg(context.db, {
      resourceType: "library_chat_action",
      resourceKey: action.actionId,
      sessionId: action.sessionId,
      scope: "library",
      status: "active",
      title: `Library action: ${prompt.slice(0, 80)}`,
      payload: {
        schemaVersion: "southstar.library.chat_action.v1",
        actionId: action.actionId,
        sessionId: action.sessionId,
        prompt: action.prompt,
        selectedScope: action.scope,
      },
      summary: { prompt: action.prompt, selectedScope: action.scope },
    });

    return json("library-chat-message", {
      sessionId: action.sessionId,
      actionId: action.actionId,
      status: "accepted",
    });
  }

  if (request.method === "GET" && url.pathname === "/api/v2/library/chat/events") {
    const sessionId = requiredQueryParam(url, "sessionId");
    const actionId = requiredQueryParam(url, "actionId");
    await requireLibraryChatAction(context, { sessionId, actionId });
    return libraryChatEventStream({ sessionId, actionId });
  }

  const lifecycleMatch = url.pathname.match(/^\/api\/v2\/library\/objects\/([^/]+)\/(approve|deprecate|block)$/);
  if (request.method === "POST" && lifecycleMatch) {
    const body = await readJsonBody<{ actor?: unknown; reason?: unknown }>(request);
    const action = lifecycleMatch[2] as LibraryObjectLifecycleAction;
    return json("library-object-lifecycle", await applyLibraryObjectLifecycleAction(context.db, {
      objectKey: decodeURIComponent(lifecycleMatch[1]!),
      action,
      actor: optionalString(body.actor) ?? "operator",
      reason: requiredNonBlankString(body.reason, "reason"),
    }));
  }

  const syncMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)\/sync$/);
  if (request.method === "POST" && syncMatch) {
    return json(
      "library-file-sync",
      await syncLibraryFileToGraph(context.db, {
        root: libraryRoot(context),
        relativePath: decodeURIComponent(syncMatch[1]!),
      }),
    );
  }

  const fileMatch = url.pathname.match(/^\/api\/v2\/library\/files\/(.+)$/);
  if (fileMatch) {
    const relativePath = decodeURIComponent(fileMatch[1]!);
    if (request.method === "GET") {
      return json("library-file", await readLibraryFile({ root: libraryRoot(context), relativePath }));
    }
    if (request.method === "PATCH") {
      const body = await readJsonBody<{ content?: unknown }>(request);
      await writeLibraryFile({
        root: libraryRoot(context),
        relativePath,
        content: requiredString(body.content, "content"),
      });
      return json("library-file", await readLibraryFile({ root: libraryRoot(context), relativePath }));
    }
  }

  return undefined;
}

function libraryRoot(context: RuntimeServerContext): string {
  return context.libraryRoot ?? process.env.SOUTHSTAR_LIBRARY_ROOT ?? "library";
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const text = await request.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}

function requiredNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredQueryParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`number query param is invalid: ${value}`);
  return parsed;
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

function errorJson(error: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

async function saveTemplateGraphFromWorkflow(
  db: SouthstarDb,
  workflow: Record<string, unknown>,
  scope: string,
): Promise<Pick<SaveWorkflowTemplateDraftInput, "nodes" | "edges">> {
  const tasks = Array.isArray(workflow.tasks)
    ? workflow.tasks.filter((task): task is Record<string, unknown> => isRecord(task))
    : [];
  const nodeIds = new Set(tasks.map((task) => requiredString(task.id, "workflow.tasks.id")));
  return {
    nodes: await Promise.all(tasks.map(async (task) => {
      const id = requiredString(task.id, "workflow.tasks.id");
      return {
        id,
        title: optionalString(task.name) ?? id,
        agentRef: await agentRefForWorkflowTask(db, task, scope),
        skillRefs: libraryRefs(task.skillRefs, "skill."),
        toolGrantRefs: libraryRefs(task.toolGrantRefs, "tool."),
        mcpGrantRefs: libraryRefs(task.mcpGrantRefs, "mcp."),
      };
    })),
    edges: tasks.flatMap((task) => {
      const to = requiredString(task.id, "workflow.tasks.id");
      return libraryRefs(task.dependsOn, "").filter((from) => nodeIds.has(from)).map((from) => ({ from, to }));
    }),
  };
}

async function agentRefForWorkflowTask(db: SouthstarDb, task: Record<string, unknown>, scope: string): Promise<string> {
  const explicit = optionalString(task.agentDefinitionRef);
  if (explicit?.startsWith("agent.")) {
    await requireAgentDefinition(db, explicit);
    return explicit;
  }

  const profileRef = profileObjectKey(optionalString(task.agentProfileRef));
  if (profileRef) {
    const edges = await findLibraryEdgesFrom(db, profileRef, "implements", { scope });
    const agentRefs = [...new Set(edges
      .map((edge) => edge.toObjectKey)
      .filter((toObjectKey) => toObjectKey.startsWith("agent.")))];
    if (agentRefs.length === 1) {
      await requireAgentDefinition(db, agentRefs[0]!);
      return agentRefs[0]!;
    }
    if (agentRefs.length > 1) {
      throw new Error(`ambiguous agentRef for workflow task ${requiredString(task.id, "workflow.tasks.id")}: ${agentRefs.join(", ")}`);
    }
  }

  throw new Error(
    `cannot derive graph-backed agentRef for workflow task ${requiredString(task.id, "workflow.tasks.id")}; persisted workflow must include agentDefinitionRef or a library-backed agentProfileRef`,
  );
}

function libraryRefs(value: unknown, prefix: string): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => (
    typeof item === "string" && item.length > 0 && (prefix.length === 0 || item.startsWith(prefix))
  ));
}

function profileObjectKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.startsWith("profile.") ? trimmed : `profile.${trimmed}`;
}

async function requireAgentDefinition(db: SouthstarDb, objectKey: string): Promise<void> {
  const object = await findLibraryObjectByKey(db, objectKey);
  if (object?.objectKind !== "agent_definition") {
    throw new Error(`agentRef does not resolve to a graph-backed agent definition: ${objectKey}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireLibraryChatAction(
  context: RuntimeServerContext,
  input: { sessionId: string; actionId: string },
): Promise<void> {
  const action = await getResourceByKeyPg(context.db, "library_chat_action", input.actionId);
  if (!action) throw new Error(`library chat action ${input.actionId} was not found`);
  if (action.sessionId !== input.sessionId) {
    throw new Error(`library chat action ${input.actionId} does not belong to session ${input.sessionId}`);
  }
}

function libraryChatEventStream(input: { sessionId: string; actionId: string }): Response {
  const events = [
    {
      event: "library.intent.started",
      data: { sessionId: input.sessionId, actionId: input.actionId, message: "Reading library command." },
    },
    {
      event: "library.intent.completed",
      data: { sessionId: input.sessionId, actionId: input.actionId, intent: "create_or_import_library_item", confidence: 0.8 },
    },
    {
      event: "library.proposal.created",
      data: {
        sessionId: input.sessionId,
        actionId: input.actionId,
        title: "Draft library proposal",
        objectKeys: [],
        filePaths: [],
      },
    },
    {
      event: "library.validation.completed",
      data: { sessionId: input.sessionId, actionId: input.actionId, ok: true, issues: [] },
    },
    {
      event: "library.command.completed",
      data: { sessionId: input.sessionId, actionId: input.actionId, status: "ready_for_review" },
    },
  ];
  const encoder = new TextEncoder();
  const frames = events.map(({ event, data }) => sse(event, data)).join("");
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames));
      controller.close();
    },
  }), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

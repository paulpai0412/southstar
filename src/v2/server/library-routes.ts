import { randomUUID } from "node:crypto";
import { normalizeImportProposal } from "../design-library/importers/import-proposal-normalizer.ts";
import { createPromptLibraryImportProposal } from "../design-library/importers/prompt-library-importer.ts";
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

  if (request.method === "POST" && url.pathname === "/api/v2/library/import-prompts") {
    const body = await readJsonBody<{ prompt?: unknown; scope?: unknown }>(request);
    const prompt = requiredString(body.prompt, "prompt");
    const scope = optionalString(body.scope) ?? "software";
    const proposal = normalizeImportProposal(createPromptLibraryImportProposal({ prompt, scope }));
    const files = [];
    for (const file of proposal.files) {
      files.push(await writeLibraryFile({
        root: libraryRoot(context),
        relativePath: file.relativePath,
        content: file.content,
      }));
    }
    return json("library-import-prompt", {
      files,
      objectKeys: proposal.objectKeys,
      status: "draft_files_written",
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

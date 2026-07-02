import { randomUUID } from "node:crypto";
import {
  listLibraryFiles,
  readLibraryFile,
  syncLibraryFileToGraph,
  writeLibraryFile,
} from "../design-library/files/library-file-store.ts";
import type { LibraryChatAction } from "../read-models/library-chat.ts";
import { buildLibraryGraphReadModel } from "../read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../read-models/library-workspace.ts";
import { upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";
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

  if (request.method === "POST" && url.pathname === "/api/v2/library/chat/messages") {
    const body = await readJsonBody<{ sessionId?: unknown; prompt?: unknown; scope?: unknown }>(request);
    const prompt = requiredString(body.prompt, "prompt");
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
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
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

function libraryChatEventStream(input: { sessionId: string; actionId: string }): Response {
  const events = [
    {
      event: "library.intent.started",
      data: { sessionId: input.sessionId, actionId: input.actionId, status: "started" },
    },
    {
      event: "library.intent.completed",
      data: { sessionId: input.sessionId, actionId: input.actionId, intent: "create-library-object" },
    },
    {
      event: "library.proposal.created",
      data: {
        sessionId: input.sessionId,
        actionId: input.actionId,
        proposal: {
          title: "Browser verification skill",
          objectKeys: ["skill.browser-verification"],
          filePaths: ["skills/browser-verification/SKILL.md"],
        },
      },
    },
    {
      event: "library.validation.completed",
      data: { sessionId: input.sessionId, actionId: input.actionId, ok: true, issues: [] },
    },
    {
      event: "library.command.completed",
      data: { sessionId: input.sessionId, actionId: input.actionId, status: "completed" },
    },
  ];
  return new Response(events.map(({ event, data }) => sse(event, data)).join(""), {
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

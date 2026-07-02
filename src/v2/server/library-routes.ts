import {
  listLibraryFiles,
  readLibraryFile,
  syncLibraryFileToGraph,
  writeLibraryFile,
} from "../design-library/files/library-file-store.ts";
import { buildLibraryGraphReadModel } from "../read-models/library-graph.ts";
import { buildLibraryWorkspaceReadModel } from "../read-models/library-workspace.ts";
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

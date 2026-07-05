import { getArtifactRefContentPg } from "../artifacts/artifact-read-service.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";
import type { ApiEnvelope } from "./types.ts";

export async function handleArtifactRoute(
  context: RuntimeServerContext,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const artifactMatch = url.pathname.match(/^\/api\/v2\/artifacts\/(.+)$/);
  if (request.method === "GET" && artifactMatch) {
    return json("artifact", await getArtifactRefContentPg(context.db, {
      artifactRef: decodeURIComponent(artifactMatch[1]!),
    }));
  }
  return null;
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

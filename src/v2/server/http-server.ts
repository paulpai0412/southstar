import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { reconcileExecutorBindings } from "../executor/reconciler.ts";
import { handleRuntimeRoute } from "./routes.ts";
import { createRuntimeLoopController, type RuntimeLoopController } from "./runtime-loops.ts";
import type { RuntimeServerContext } from "./runtime-context.ts";

export type CreateSouthstarRuntimeServerInput = RuntimeServerContext & {
  host?: string;
  port?: number;
};

export type SouthstarRuntimeServer = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

export async function createSouthstarRuntimeServer(input: CreateSouthstarRuntimeServerInput): Promise<SouthstarRuntimeServer> {
  const host = input.host ?? "127.0.0.1";
  const context: RuntimeServerContext = { ...input };
  const reconcileLoop = context.createReconcileLoop?.() ?? createDefaultReconcileLoop(context);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming);
      const response = await handleRuntimeRoute(context, request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });

  await new Promise<void>((resolve) => server.listen(input.port ?? 0, host, resolve));
  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}`;
  context.serverUrl = url;
  reconcileLoop?.start();
  return {
    host,
    port,
    url,
    close: async () => {
      await reconcileLoop?.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function createDefaultReconcileLoop(context: RuntimeServerContext): RuntimeLoopController | undefined {
  if (!context.torkObservationClient) return undefined;
  return createRuntimeLoopController({
    intervalMs: context.reconcileIntervalMs ?? 15_000,
    runOnce: async () => {
      await reconcileExecutorBindings(context.db, {
        tork: context.torkObservationClient as NonNullable<RuntimeServerContext["torkObservationClient"]>,
      });
    },
  });
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const host = incoming.headers.host ?? "127.0.0.1";
  const method = incoming.method ?? "GET";
  const bodyAllowed = method !== "GET" && method !== "HEAD";
  return new Request(`http://${host}${incoming.url ?? "/"}`, {
    method,
    headers: headersFromIncoming(incoming.headers),
    body: bodyAllowed && chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(key, value);
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    }
  }
  return result;
}

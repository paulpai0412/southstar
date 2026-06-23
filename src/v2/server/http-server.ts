import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { reconcileExecutorBindingsPg } from "../executor/postgres-reconciler.ts";
import { handleRuntimeRoute } from "./routes.ts";
import {
  createCompositeRuntimeLoopController,
  createManagedRuntimeLoopRunners,
  createRuntimeLoopController,
  type ManagedRuntimeLoopRunner,
  type RuntimeLoopController,
} from "./runtime-loops.ts";
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
  const runtimeLoops = createDefaultRuntimeLoops(context);
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (incoming, outgoing) => {
    activeResponses.add(outgoing);
    outgoing.once("close", () => activeResponses.delete(outgoing));
    try {
      const request = await toRequest(incoming);
      const response = await handleRuntimeRoute(context, request);
      await writeResponse(outgoing, response);
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
  runtimeLoops?.start();
  return {
    host,
    port,
    url,
    close: async () => {
      await runtimeLoops?.stop();
      for (const response of activeResponses) response.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function writeResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  if (!response.body) {
    outgoing.end();
    return;
  }

  const reader = response.body.getReader();
  let outgoingClosed = false;
  const onClose = () => {
    outgoingClosed = true;
    void reader.cancel().catch(() => undefined);
  };
  outgoing.once("close", onClose);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done || outgoingClosed) break;
      await writeChunk(outgoing, chunk.value);
    }
  } finally {
    outgoing.off("close", onClose);
    reader.releaseLock();
  }
  if (!outgoingClosed && !outgoing.writableEnded) outgoing.end();
}

async function writeChunk(outgoing: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (outgoing.destroyed || outgoing.writableEnded) return;
  if (outgoing.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      outgoing.off("drain", onDrain);
      outgoing.off("error", onError);
      outgoing.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    outgoing.once("drain", onDrain);
    outgoing.once("error", onError);
    outgoing.once("close", onClose);
  });
}

function createDefaultRuntimeLoops(context: RuntimeServerContext): RuntimeLoopController | undefined {
  const loops = [
    context.createReconcileLoop?.() ?? createDefaultReconcileLoop(context),
    createDefaultManagedRuntimeLoop(context),
  ].filter((loop): loop is RuntimeLoopController => Boolean(loop));
  if (loops.length === 0) return undefined;
  if (loops.length === 1) return loops[0];
  return createCompositeRuntimeLoopController(loops);
}

function createDefaultReconcileLoop(context: RuntimeServerContext): RuntimeLoopController | undefined {
  if (!context.torkObservationClient) return undefined;
  const runner = createDefaultReconcileLoopRunner(context);
  context.runtimeLoopRegistry?.register(runner);
  return createRuntimeLoopController({
    intervalMs: runner.intervalMs,
    runOnce: context.runtimeLoopRegistry
      ? async () => {
        await context.runtimeLoopRegistry?.tick(runner.id);
      }
      : runner.runOnce,
  });
}

function createDefaultReconcileLoopRunner(context: RuntimeServerContext): ManagedRuntimeLoopRunner {
  const tork = context.torkObservationClient as NonNullable<RuntimeServerContext["torkObservationClient"]>;
  return {
    id: "executor-reconciler",
    intervalMs: context.reconcileIntervalMs ?? 15_000,
    runOnce: async () => {
      const result = await reconcileExecutorBindingsPg(context.db, { tork });
      return { findings: result.findings.length };
    },
  };
}

export function createDefaultManagedRuntimeLoop(context: RuntimeServerContext): RuntimeLoopController | undefined {
  if (!context.managedRuntime) return undefined;
  const runners = createManagedRuntimeLoopRunners({
    db: context.db,
    sessionStore: context.managedRuntime.sessionStore,
    brainProvider: context.managedRuntime.brainProvider,
    handProvider: context.managedRuntime.handProvider,
    ...(context.managedRuntime.providerActions ? { providerActions: context.managedRuntime.providerActions } : {}),
    schedulerIntervalMs: context.managedRuntime.schedulerIntervalMs ?? 5_000,
    recoveryIntervalMs: context.managedRuntime.recoveryIntervalMs ?? 15_000,
  });
  for (const runner of runners) context.runtimeLoopRegistry?.register(runner);
  return createCompositeRuntimeLoopController(runners.map((runner) => createRuntimeLoopController({
    intervalMs: runner.intervalMs,
    runOnce: context.runtimeLoopRegistry
      ? async () => {
        await context.runtimeLoopRegistry?.tick(runner.id);
      }
      : runner.runOnce,
  })));
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

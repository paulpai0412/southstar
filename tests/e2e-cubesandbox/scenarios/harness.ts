import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { buildRuntimeDependencies } from "../../../src/v2/runtime/dependencies.ts";

export type CallbackProbeServer = {
  callbackUrl: string;
  waitForCallback(timeoutMs: number): Promise<{ receivedAtMs: number; body: unknown }>;
  close(): Promise<void>;
};

export function createCubeSandboxRealContext(env: CubeSandboxRealE2EEnv) {
  return buildRuntimeDependencies({
    configPath: env.configPath,
    resolveCredential(ref) {
      const value = process.env[`SOUTHSTAR_TEST_SECRET_${ref}`];
      if (!value) throw new Error(`missing test credential SOUTHSTAR_TEST_SECRET_${ref}`);
      return value;
    },
  });
}

export async function startCallbackProbeServer(env: CubeSandboxRealE2EEnv): Promise<CallbackProbeServer> {
  let callback: { receivedAtMs: number; body: unknown } | undefined;
  let notify: ((value: { receivedAtMs: number; body: unknown }) => void) | undefined;

  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/api/v2/executor/callback") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const body = JSON.parse(await readBody(request)) as unknown;
      callback = { receivedAtMs: performance.now(), body };
      notify?.(callback);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true }));
    } catch (error) {
      response.statusCode = 500;
      response.end((error as Error).message);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind callback probe server");
  }

  return {
    callbackUrl: `http://${env.callbackHost}:${address.port}/api/v2/executor/callback`,
    async waitForCallback(timeoutMs: number) {
      if (callback) return callback;
      return await new Promise<{ receivedAtMs: number; body: unknown }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`callback not received within ${timeoutMs}ms`)), timeoutMs);
        notify = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export async function pollUntil<T>(
  poll: () => Promise<T>,
  input: { timeoutMs: number; intervalMs: number; stop: (value: T) => boolean; description: string },
): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= input.timeoutMs) {
    const value = await poll();
    if (input.stop(value)) {
      return { value, elapsedMs: performance.now() - startedAt };
    }
    await sleep(input.intervalMs);
  }
  throw new Error(`${input.description} not reached within ${input.timeoutMs}ms`);
}

export function makeRealWorkspace(prefix = "cube-real-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupWorkspace(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function writeEvidenceJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

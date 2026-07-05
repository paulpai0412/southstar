import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createRuntimeServerClient } from "../server/client.ts";
import {
  createSouthstarMcpToolRegistry,
  type SouthstarMcpToolRegistry,
} from "./tool-registry.ts";

export type McpJsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

export type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export function createSouthstarMcpRegistryFromEnv(): SouthstarMcpToolRegistry {
  const baseUrl = process.env.SOUTHSTAR_MCP_RUNTIME_URL
    ?? process.env.SOUTHSTAR_RUNTIME_URL
    ?? process.env.SOUTHSTAR_SERVER_URL
    ?? "http://127.0.0.1:3100";
  return createSouthstarMcpToolRegistry({ client: createRuntimeServerClient({ baseUrl }) });
}

export async function handleSouthstarMcpMessage(
  registry: SouthstarMcpToolRegistry,
  message: McpJsonRpcRequest,
): Promise<McpJsonRpcResponse | null> {
  const id = message.id ?? null;
  try {
    switch (message.method) {
      case "initialize":
        return response(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "southstar", version: "0.1.0" },
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, { tools: registry.listTools() });
      case "tools/call": {
        const params = asRecord(message.params);
        return response(id, await registry.callTool(requiredString(params.name, "name"), params.arguments ?? {}));
      }
      default:
        return errorResponse(id, -32601, `method not found: ${message.method ?? ""}`);
    }
  } catch (error) {
    return errorResponse(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

export async function startSouthstarMcpServer(registry = createSouthstarMcpRegistryFromEnv()): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: McpJsonRpcRequest;
    try {
      parsed = JSON.parse(line) as McpJsonRpcRequest;
    } catch (error) {
      process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, error instanceof Error ? error.message : String(error)))}\n`);
      continue;
    }
    const result = await handleSouthstarMcpMessage(registry, parsed);
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

function response(id: string | number | null, result: unknown): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: string | number | null, code: number, message: string): McpJsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} is required`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSouthstarMcpServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

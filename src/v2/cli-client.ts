import { createRuntimeServerClient } from "./server/client.ts";

export type CliRuntimeClient = ReturnType<typeof createRuntimeServerClient>;

export function createCliRuntimeClient(input: { baseUrl: string }) {
  return createRuntimeServerClient(input);
}

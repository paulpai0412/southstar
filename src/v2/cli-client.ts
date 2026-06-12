import { createRuntimeServerClient } from "./server/client.ts";

export function createCliRuntimeClient(input: { baseUrl: string }) {
  return createRuntimeServerClient(input);
}

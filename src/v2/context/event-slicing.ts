import { createHash } from "node:crypto";
import type { ManagedContextSourceRefs } from "./types.ts";

export function buildManagedContextSourceRefs(input: Omit<ManagedContextSourceRefs, "cacheKey">): ManagedContextSourceRefs {
  const cacheKey = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
  return { ...input, cacheKey };
}

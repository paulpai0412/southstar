import { createHash } from "node:crypto";
import type { ManagedContextSourceRefs } from "./types.ts";

export function buildManagedContextSourceRefs(input: Omit<ManagedContextSourceRefs, "cacheKey">): ManagedContextSourceRefs {
  const cacheKey = createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 16);
  return { ...input, cacheKey };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Goal and Library semantic tags are author/LLM supplied data. Runtime only
 * canonicalizes and compares them; it must not contain a product vocabulary.
 */
export function normalizeSemanticTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().toLocaleLowerCase().replace(/\s+/g, "-")))];
}

export function missingSemanticTags(required: string[], supplied: string[]): string[] {
  const suppliedSet = new Set(normalizeSemanticTags(supplied));
  return normalizeSemanticTags(required).filter((tag) => !suppliedSet.has(tag));
}

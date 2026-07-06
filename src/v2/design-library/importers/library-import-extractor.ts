import { normalizeImportProposal } from "./import-proposal-normalizer.ts";
import { createPromptLibraryImportProposal, type LibraryPromptImportProposal } from "./prompt-library-importer.ts";

export type LibraryImportSource =
  | { kind: "paste"; label: string; content: string }
  | { kind: "github"; repoUrl: string; path?: string; content?: string }
  | { kind: "local"; absolutePath: string; content?: string };

export function asImportSource(value: unknown): LibraryImportSource {
  if (!isRecord(value)) throw new Error("source is required");
  const legacyShape = value.kind === undefined && value.type !== undefined;
  const kind = requiredString(value.kind ?? value.type, "source.kind");
  if (kind === "paste") {
    return {
      kind,
      label: optionalString(value.label) ?? "Pasted library import",
      content: requiredNonBlankString(value.content, "source.content"),
    };
  }
  if (kind === "github") {
    return {
      kind,
      repoUrl: requiredNonBlankString(
        legacyShape ? value.repoUrl ?? value.url ?? value.repository : value.repoUrl ?? value.url,
        "source.repoUrl",
      ),
      ...(optionalString(value.path) ? { path: optionalString(value.path) } : {}),
      ...(optionalString(value.content) ? { content: optionalString(value.content) } : {}),
    };
  }
  if (kind === "local") {
    return {
      kind,
      absolutePath: requiredNonBlankString(
        legacyShape ? value.absolutePath ?? value.path : value.absolutePath,
        "source.absolutePath",
      ),
      ...(optionalString(value.content) ? { content: optionalString(value.content) } : {}),
    };
  }
  throw new Error(`unsupported import source kind: ${kind}`);
}

export function extractLibraryImportProposal(input: {
  source: LibraryImportSource;
  scope: string;
}): LibraryPromptImportProposal {
  const prompt = promptFromSource(input.source);
  return normalizeImportProposal(createPromptLibraryImportProposal({ prompt, scope: input.scope }));
}

function promptFromSource(source: LibraryImportSource): string {
  if (source.kind === "paste") return source.content;
  if (source.content) return source.content;
  throw new Error(`source.${source.kind} requires inline content in this implementation slice`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is required`);
  return value;
}

function requiredNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LibraryImportSource } from "./library-import-extractor.ts";

export type LibraryImportSourceDocument = {
  path: string;
  label: string;
  content: string;
};

export type LibraryImportSourceFetcher = (input: {
  source: Extract<LibraryImportSource, { kind: "github" }>;
}) => Promise<LibraryImportSourceDocument[]>;

export async function fetchLibraryImportSourceDocuments(input: {
  source: LibraryImportSource;
  sourceFetcher?: LibraryImportSourceFetcher;
  localRoot?: string;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<LibraryImportSourceDocument[]> {
  const maxFiles = input.maxFiles ?? 25;
  const maxBytes = input.maxBytes ?? 200_000;

  if (input.source.kind === "paste") {
    return boundDocuments([documentFromInline(sanitizePastePath(input.source.label), sanitizePasteLabel(input.source.label), input.source.content)], {
      maxFiles,
      maxBytes,
      rejectTooManyFiles: true,
    });
  }

  if (input.source.kind === "github") {
    if (input.source.content) {
      return boundDocuments([
        documentFromInline(input.source.path ?? "github-import.md", input.source.path ?? input.source.repoUrl, input.source.content),
      ], { maxFiles, maxBytes, rejectTooManyFiles: true });
    }
    if (!input.sourceFetcher) throw new Error("github import source without inline content requires sourceFetcher");
    return boundDocuments(await input.sourceFetcher({ source: input.source }), {
      maxFiles,
      maxBytes,
      rejectTooManyFiles: false,
    });
  }

  if (input.source.content) {
    return boundDocuments([
      documentFromInline(path.basename(input.source.absolutePath) || "local-import.md", input.source.absolutePath, input.source.content),
    ], { maxFiles, maxBytes, rejectTooManyFiles: true });
  }

  return boundDocuments(await readLocalDocuments(input.source.absolutePath, input.localRoot), {
    maxFiles,
    maxBytes,
    rejectTooManyFiles: true,
  });
}

async function readLocalDocuments(absolutePath: string, localRoot?: string): Promise<LibraryImportSourceDocument[]> {
  const resolvedPath = path.resolve(absolutePath);
  const resolvedRoot = path.resolve(localRoot ?? resolvedPath);
  if (!isWithinRoot(resolvedPath, resolvedRoot)) {
    throw new Error(`local import source must resolve under localRoot: ${absolutePath}`);
  }

  const stats = await stat(resolvedPath);
  if (stats.isFile()) {
    if (!isSupportedDocumentPath(resolvedPath)) return [];
    const content = await readFile(resolvedPath, "utf8");
    const relativePath = toPosixPath(path.relative(resolvedRoot, resolvedPath)) || path.basename(resolvedPath);
    return [{ path: relativePath, label: labelFromPath(relativePath), content }];
  }
  if (!stats.isDirectory()) throw new Error(`local import source is not a file or directory: ${absolutePath}`);

  const docs = await readLocalDirectory(resolvedPath, resolvedRoot);
  return docs.sort((left, right) => left.path.localeCompare(right.path));
}

async function readLocalDirectory(directory: string, root: string): Promise<LibraryImportSourceDocument[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const docs: LibraryImportSourceDocument[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absoluteEntryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      docs.push(...await readLocalDirectory(absoluteEntryPath, root));
      continue;
    }
    if (!entry.isFile() || !isSupportedDocumentPath(entry.name)) continue;
    const relativePath = toPosixPath(path.relative(root, absoluteEntryPath));
    docs.push({
      path: relativePath,
      label: labelFromPath(relativePath),
      content: await readFile(absoluteEntryPath, "utf8"),
    });
  }
  return docs;
}

function boundDocuments(
  docs: LibraryImportSourceDocument[],
  options: { maxFiles: number; maxBytes: number; rejectTooManyFiles: boolean },
): LibraryImportSourceDocument[] {
  if (options.rejectTooManyFiles && docs.length > options.maxFiles) {
    throw new Error(`library import source has too many documents: ${docs.length} > ${options.maxFiles}`);
  }
  const bounded = options.rejectTooManyFiles ? docs : docs.slice(0, options.maxFiles);
  const totalBytes = bounded.reduce((total, doc) => total + Buffer.byteLength(doc.content, "utf8"), 0);
  if (totalBytes > options.maxBytes) {
    throw new Error(`library import source exceeds maxBytes: ${totalBytes} > ${options.maxBytes}`);
  }
  return bounded;
}

function documentFromInline(pathLabel: string, label: string, content: string): LibraryImportSourceDocument {
  return {
    path: normalizeDocumentPath(pathLabel),
    label: sanitizeLabel(label),
    content,
  };
}

function sanitizePastePath(label: string): string {
  const sanitized = sanitizePasteLabel(label).replaceAll(" ", "-") || "pasted-library-import";
  return `${sanitized}.md`;
}

function sanitizePasteLabel(label: string): string {
  return sanitizeLabel(label).replaceAll(".", "");
}

function normalizeDocumentPath(value: string): string {
  const normalized = toPosixPath(value).split("/").filter(Boolean).join("/");
  return normalized.length > 0 ? normalized : "library-import.md";
}

function sanitizeLabel(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._ -]/g, "").replaceAll(/\s+/g, " ").trim();
}

function labelFromPath(value: string): string {
  return path.basename(value).replace(/\.(mdx?|ya?ml|json)$/i, "");
}

function isSupportedDocumentPath(value: string): boolean {
  return /\.(mdx?|ya?ml|json)$/i.test(value);
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

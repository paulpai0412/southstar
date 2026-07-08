import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LibraryImportSource } from "./library-import-extractor.ts";

export type LibraryImportSourceDocument = {
  path: string;
  label: string;
  content: string;
};

export type LibraryImportSourceSnapshot = {
  documents: LibraryImportSourceDocument[];
  repoPath?: string;
};

export type LibraryImportSourceFetcher = (input: {
  source: Extract<LibraryImportSource, { kind: "github" }>;
}) => Promise<LibraryImportSourceDocument[] | LibraryImportSourceSnapshot>;

type CloneRepository = (input: { repoUrl: string; targetPath: string }) => Promise<void>;

export async function fetchLibraryImportSourceDocuments(input: {
  source: LibraryImportSource;
  sourceFetcher?: LibraryImportSourceFetcher;
  localRoot?: string;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<LibraryImportSourceDocument[]> {
  return (await fetchLibraryImportSourceSnapshot(input)).documents;
}

export async function fetchLibraryImportSourceSnapshot(input: {
  source: LibraryImportSource;
  sourceFetcher?: LibraryImportSourceFetcher;
  localRoot?: string;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<LibraryImportSourceSnapshot> {
  const maxFiles = input.maxFiles ?? (input.source.kind === "github" ? 500 : 25);
  const maxBytes = input.maxBytes ?? (input.source.kind === "github" ? 5_000_000 : 200_000);

  if (input.source.kind === "paste") {
    return { documents: boundDocuments([documentFromInline(sanitizePastePath(input.source.label), sanitizePasteLabel(input.source.label), input.source.content)], {
      maxFiles,
      maxBytes,
      rejectTooManyFiles: true,
    }) };
  }

  if (input.source.kind === "github") {
    if (input.source.content) {
      return { documents: boundDocuments([
        documentFromInline(input.source.path ?? "github-import.md", input.source.path ?? input.source.repoUrl, input.source.content),
      ], { maxFiles, maxBytes, rejectTooManyFiles: true }) };
    }
    if (!input.sourceFetcher) throw new Error("github import source without inline content requires sourceFetcher");
    const snapshot = normalizeSourceSnapshot(await input.sourceFetcher({ source: input.source }));
    return {
      ...snapshot,
      documents: boundDocuments(snapshot.documents, {
      maxFiles,
      maxBytes,
      rejectTooManyFiles: false,
      }),
    };
  }

  if (input.source.content) {
    return { documents: boundDocuments([
      documentFromInline(path.basename(input.source.absolutePath) || "local-import.md", input.source.absolutePath, input.source.content),
    ], { maxFiles, maxBytes, rejectTooManyFiles: true }) };
  }

  return { documents: boundDocuments(await readLocalDocuments(input.source.absolutePath, input.localRoot), {
    maxFiles,
    maxBytes,
    rejectTooManyFiles: true,
  }) };
}

export function createGithubLibraryImportSourceFetcher(options: {
  cloneRepository?: CloneRepository;
  importRoot?: string;
} = {}): LibraryImportSourceFetcher {
  return async ({ source }) => {
    const repo = parseGithubRepoUrl(source.repoUrl);
    const importRoot = path.resolve(options.importRoot ?? process.env.SOUTHSTAR_LIBRARY_IMPORT_ROOT ?? path.join(tmpdir(), "southstar-library-imports"));
    await mkdir(importRoot, { recursive: true });
    const targetPath = path.join(importRoot, `${repo.owner}-${repo.name}-${randomUUID()}`);
    await (options.cloneRepository ?? cloneGithubRepository)({ repoUrl: source.repoUrl, targetPath });
    return { documents: await readLocalDocuments(targetPath, targetPath), repoPath: targetPath };
  };
}

function normalizeSourceSnapshot(value: LibraryImportSourceDocument[] | LibraryImportSourceSnapshot): LibraryImportSourceSnapshot {
  return Array.isArray(value) ? { documents: value } : value;
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

function parseGithubRepoUrl(repoUrl: string): { owner: string; name: string } {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error(`invalid github repository URL: ${repoUrl}`);
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error(`github import source must use github.com: ${repoUrl}`);
  }
  const [owner, name] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !name) throw new Error(`github repository URL must include owner and repo: ${repoUrl}`);
  return {
    owner: safePathSegment(owner),
    name: safePathSegment(name.replace(/\.git$/i, "")),
  };
}

function safePathSegment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-");
}

async function cloneGithubRepository(input: { repoUrl: string; targetPath: string }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth", "1", input.repoUrl, input.targetPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git clone failed with exit code ${code}: ${stderr.trim()}`));
    });
  });
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

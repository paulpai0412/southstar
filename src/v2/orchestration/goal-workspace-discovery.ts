import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { contentHashForPayload } from "../design-library/canonical-json.ts";

export type WorkspaceGoalDiscoveryV1 = {
  schemaVersion: "southstar.workspace_goal_discovery.v1";
  cwd: string;
  entries: Array<{ path: string; kind: "file" | "directory"; size?: number; contentHash?: string }>;
  instructionDocuments: Array<{ path: string; content: string; contentHash: string }>;
  projectMetadata: Array<{ path: string; content: string; contentHash: string }>;
  truncated: boolean;
  discoveryHash: string;
};

type DiscoveryLimits = {
  maxEntries?: number;
  maxDocumentBytes?: number;
  maxTotalBytes?: number;
};

const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache", ".turbo"]);
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const PROJECT_FILES = new Set(["package.json", "tsconfig.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md"]);
const SECRET_NAME = /(^\.env(?:\.|$)|secret|token|password|credential|private[-_]?key)/i;

export async function discoverGoalWorkspace(
  cwd: string,
  limits: DiscoveryLimits = {},
): Promise<WorkspaceGoalDiscoveryV1> {
  const root = await realpath(cwd);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Goal workspace cwd is not a directory: ${cwd}`);
  const maxEntries = limits.maxEntries ?? 200;
  const maxDocumentBytes = limits.maxDocumentBytes ?? 16_384;
  const maxTotalBytes = limits.maxTotalBytes ?? 65_536;
  const entries: WorkspaceGoalDiscoveryV1["entries"] = [];
  const instructionDocuments: WorkspaceGoalDiscoveryV1["instructionDocuments"] = [];
  const projectMetadata: WorkspaceGoalDiscoveryV1["projectMetadata"] = [];
  let bytes = 0;
  let truncated = false;

  async function addPath(absolutePath: string, rootPath = false): Promise<void> {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (!rootPath && skippableDiscoveryError(error)) {
        truncated = true;
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) return;
    const rel = toRelative(root, absolutePath);
    if (rel && secretLooking(rel)) return;
    if (info.isDirectory()) {
      const name = basename(absolutePath);
      if (SKIP_DIRS.has(name)) return;
      if (rel) entries.push({ path: rel, kind: "directory" });
      let children: string[];
      try {
        children = (await readdir(absolutePath)).sort();
      } catch (error) {
        if (!rootPath && skippableDiscoveryError(error)) {
          truncated = true;
          return;
        }
        throw error;
      }
      for (const child of children) await addPath(join(absolutePath, child));
      return;
    }
    if (!info.isFile()) return;
    let documentBytes: Buffer;
    try {
      documentBytes = await readFile(absolutePath);
    } catch (error) {
      if (!rootPath && skippableDiscoveryError(error)) {
        truncated = true;
        return;
      }
      throw error;
    }
    if (documentBytes.includes(0)) return;
    const entry = {
      path: rel,
      kind: "file" as const,
      size: info.size,
      contentHash: sha256(documentBytes),
    };
    entries.push(entry);
    if (bytes >= maxTotalBytes) {
      truncated = true;
      return;
    }
    if (documentBytes.length > maxDocumentBytes) return;
    const content = documentBytes.toString("utf8");
    if (secretLookingContent(content)) return;
    bytes += documentBytes.length;
    const document = { path: rel, content, contentHash: entry.contentHash };
    const name = basename(rel);
    if (INSTRUCTION_FILES.has(name)) instructionDocuments.push(document);
    if (PROJECT_FILES.has(name)) projectMetadata.push(document);
  }

  await addPath(root, true);
  const snapshot = {
    schemaVersion: "southstar.workspace_goal_discovery.v1" as const,
    cwd: root,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    instructionDocuments: instructionDocuments.sort((a, b) => a.path.localeCompare(b.path)),
    projectMetadata: projectMetadata.sort((a, b) => a.path.localeCompare(b.path)),
    truncated,
  };
  return {
    ...snapshot,
    discoveryHash: contentHashForPayload(snapshot),
  };
}

function skippableDiscoveryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT";
}

function toRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).split(sep).join("/");
  return rel === "" ? "" : rel;
}

function secretLooking(path: string): boolean {
  return path.split("/").some((part) => SECRET_NAME.test(part));
}

function secretLookingContent(content: string): boolean {
  return /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/i.test(content);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

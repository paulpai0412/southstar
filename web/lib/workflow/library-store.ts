import fs from "node:fs/promises";
import path from "node:path";
import type {
  WorkflowResource,
  WorkflowResourceKind,
  WorkflowResourceReadOptions,
  WorkflowResourceWriteOptions,
} from "./types";

export async function readWorkflowResource(options: WorkflowResourceReadOptions): Promise<WorkflowResource> {
  const resourcePath = assertSafeResourcePath(options.resourcePath);
  const cwd = options.cwd?.trim();
  if (!cwd) throw new Error("A project directory is required to read workflow resources");

  const filePath = path.join(localLibraryRoot(cwd), resourcePath);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Workflow resource is not a file: ${resourcePath}`);
    return {
      path: resourcePath,
      label: path.posix.basename(resourcePath),
      kind: kindFromPath(resourcePath),
      content: await fs.readFile(filePath, "utf8"),
      source: "file",
      writable: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  throw new Error(`Workflow resource not found: ${resourcePath}`);
}

export async function writeWorkflowResource(options: WorkflowResourceWriteOptions): Promise<WorkflowResource> {
  if (!options.cwd) throw new Error("A project directory is required to write workflow resources");
  const resourcePath = assertSafeResourcePath(options.resourcePath);
  const kind = kindFromPath(resourcePath);
  if (kind === "json") JSON.parse(options.content);

  const filePath = path.join(localLibraryRoot(options.cwd), resourcePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, options.content, "utf8");

  return {
    path: resourcePath,
    label: path.posix.basename(resourcePath),
    kind,
    content: options.content,
    source: "file",
    writable: true,
  };
}

function localLibraryRoot(cwd: string): string {
  return path.join(cwd, ".southstar", "library", "domains");
}

function assertSafeResourcePath(resourcePath: string): string {
  const normalized = path.posix.normalize(resourcePath.replaceAll("\\", "/"));
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(resourcePath) ||
    normalized.includes("/../")
  ) {
    throw new Error(`Invalid workflow resource path: ${resourcePath}`);
  }
  return normalized;
}

function kindFromPath(resourcePath: string): WorkflowResourceKind {
  return resourcePath.endsWith(".md") ? "markdown" : "json";
}

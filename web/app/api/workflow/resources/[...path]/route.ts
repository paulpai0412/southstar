import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkflowResource } from "../../../../../lib/workflow/types";
import { readWorkflowResource, writeWorkflowResource } from "../../../../../lib/workflow/library-store";
import { buildWorkflowV2Url, workflowV2Capabilities } from "../../../../../lib/workflow/v2-api";

function resourcePathFromSegments(segments: string[]): string {
  return segments.join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number {
  const message = errorMessage(error);
  if (message.includes("Workflow resource not found")) return 404;
  if (message.includes("Invalid workflow resource path")) return 400;
  if (message.includes("A project directory is required")) return 400;
  if (error instanceof SyntaxError) return 400;
  return 500;
}

function errorResponse(error: unknown) {
  return NextResponse.json(
    { error: errorMessage(error) },
    { status: errorStatus(error) },
  );
}

function isValidWritableCwd(cwd: unknown): cwd is string {
  return typeof cwd === "string" && cwd.length > 0 && path.isAbsolute(cwd);
}

function metadataForResource(resourceSource: WorkflowResource["source"]) {
  return {
    source: { storage: "local", origin: resourceSource },
    capabilities: {
      localResourceEditing: true,
      v2Backend: workflowV2Capabilities().v2Backend,
    },
  };
}

function southstarRepoRoot(): string {
  const cwd = process.cwd();
  return path.basename(cwd) === "web" ? path.dirname(cwd) : cwd;
}

function isGraphLibraryResourcePath(resourcePath: string): boolean {
  return resourcePath === "library" || resourcePath.startsWith("library/");
}

function graphObjectKeyFromResourcePath(resourcePath: string): string | undefined {
  const match = resourcePath.match(/^library\/objects\/(.+)\.json$/);
  return match?.[1];
}

function graphAgentKeyFromAgentsMdResourcePath(resourcePath: string): string | undefined {
  const match = resourcePath.match(/^library\/generated-agents\/(agent\.[^/]+)\/AGENTS\.md$/);
  return match?.[1];
}

function graphLibraryFilePath(resourcePath: string): string {
  const normalized = path.posix.normalize(resourcePath.replaceAll("\\", "/"));
  if (!isGraphLibraryResourcePath(normalized) || normalized.includes("..")) {
    throw new Error(`Invalid workflow resource path: ${resourcePath}`);
  }
  const root = southstarRepoRoot();
  const filePath = path.resolve(root, normalized);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Invalid workflow resource path: ${resourcePath}`);
  }
  return filePath;
}

async function readGraphLibraryResource(resourcePath: string): Promise<WorkflowResource> {
  const agentKey = graphAgentKeyFromAgentsMdResourcePath(resourcePath);
  if (agentKey) return await readGraphAgentAgentsMdResource(resourcePath, agentKey);
  const objectKey = graphObjectKeyFromResourcePath(resourcePath);
  if (objectKey) return await readGraphObjectResource(resourcePath, objectKey);
  const filePath = graphLibraryFilePath(resourcePath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Workflow resource is not a file: ${resourcePath}`);
  return {
    path: resourcePath,
    label: path.posix.basename(resourcePath),
    kind: "markdown",
    content: await fs.readFile(filePath, "utf8"),
    source: "file",
    writable: true,
  };
}

async function readGraphAgentAgentsMdResource(resourcePath: string, agentKey: string): Promise<WorkflowResource> {
  const detail = await fetchGraphObject(agentKey);
  const object = detail.object;
  if (object?.objectKind !== "agent_definition") throw new Error(`Workflow resource not found: ${resourcePath}`);
  return {
    path: resourcePath,
    label: "AGENTS.md",
    kind: "markdown",
    content: renderAgentDefinitionAsAgentsMd(object.state, agentKey),
    source: "generated",
    writable: false,
  };
}

async function readGraphObjectResource(resourcePath: string, objectKey: string): Promise<WorkflowResource> {
  const payload = await fetchGraphObject(objectKey);
  return {
    path: resourcePath,
    label: path.posix.basename(resourcePath),
    kind: "json",
    content: JSON.stringify(payload, null, 2),
    source: "generated",
    writable: false,
  };
}

async function fetchGraphObject(objectKey: string): Promise<{ object?: { objectKey?: string; objectKind?: string; state?: Record<string, unknown> } }> {
  const response = await fetch(buildWorkflowV2Url(`/api/v2/library/objects/${encodeURIComponent(objectKey)}`), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Workflow resource not found: library object ${objectKey}`);
  const payload = await response.json() as { result?: unknown };
  return (payload.result ?? payload) as { object?: { objectKey?: string; objectKind?: string; state?: Record<string, unknown> } };
}

function renderAgentDefinitionAsAgentsMd(state: Record<string, unknown> | undefined, fallbackTitle: string): string {
  const title = stringValue(state?.title) ?? stringValue(state?.name) ?? fallbackTitle;
  const body = stringValue(state?.body) ?? stringValue(state?.content) ?? stringValue(state?.markdown);
  return [`# ${title}`, "", body ?? `Agent definition ${fallbackTitle}.`, ""].join("\n");
}

async function writeGraphLibraryResource(resourcePath: string, content: string): Promise<WorkflowResource> {
  if (graphObjectKeyFromResourcePath(resourcePath) || graphAgentKeyFromAgentsMdResourcePath(resourcePath)) {
    throw new Error(`Workflow resource is not writable: ${resourcePath}`);
  }
  const filePath = graphLibraryFilePath(resourcePath);
  await fs.writeFile(filePath, content, "utf8");
  return await readGraphLibraryResource(resourcePath);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const cwd = request.nextUrl.searchParams.get("cwd");
    const resourcePath = resourcePathFromSegments(path);
    const resource = isGraphLibraryResourcePath(resourcePath)
      ? await readGraphLibraryResource(resourcePath)
      : await readWorkflowResource({ cwd, resourcePath });
    return NextResponse.json({
      resource,
      ...metadataForResource(resource.source),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const body = await request.json() as { cwd?: string | null; content?: string };
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }
    const resourcePath = resourcePathFromSegments(path);
    if (!isGraphLibraryResourcePath(resourcePath) && !isValidWritableCwd(body.cwd)) {
      return NextResponse.json({ error: "absolute cwd is required" }, { status: 400 });
    }
    const resource = isGraphLibraryResourcePath(resourcePath)
      ? await writeGraphLibraryResource(resourcePath, body.content)
      : await writeWorkflowResource({
        cwd: body.cwd!,
        resourcePath,
        content: body.content,
      });
    return NextResponse.json({
      resource,
      ...metadataForResource(resource.source),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { readWorkflowResource, writeWorkflowResource } from "@/lib/workflow/library-store";
import { workflowV2Capabilities } from "@/lib/workflow/v2-api";

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

function metadataForResource(resourceSource: "file" | "fixture") {
  return {
    source: { storage: "local", origin: resourceSource },
    capabilities: {
      localResourceEditing: true,
      v2Backend: workflowV2Capabilities().v2Backend,
    },
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await params;
    const cwd = request.nextUrl.searchParams.get("cwd");
    const resource = await readWorkflowResource({ cwd, resourcePath: resourcePathFromSegments(path) });
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
    if (!isValidWritableCwd(body.cwd)) {
      return NextResponse.json({ error: "absolute cwd is required" }, { status: 400 });
    }

    const resource = await writeWorkflowResource({
      cwd: body.cwd,
      resourcePath: resourcePathFromSegments(path),
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

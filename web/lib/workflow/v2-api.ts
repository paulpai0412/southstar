import { NextRequest, NextResponse } from "next/server";

export type WorkflowV2Capabilities = {
  createDraft: boolean;
  validate: boolean;
  createRun: boolean;
  execute: boolean;
  run: boolean;
  postgres: boolean;
  v2Backend: boolean;
};

const NOT_CONFIGURED = "Southstar v2 workflow API is not configured";

function normalizedBaseUrl(): string | null {
  const value = process.env.SOUTHSTAR_V2_API_BASE_URL?.trim();
  return value ? value.replace(/\/+$/, "") : null;
}

export function workflowV2Capabilities(): WorkflowV2Capabilities {
  const enabled = Boolean(normalizedBaseUrl());
  return {
    createDraft: enabled,
    validate: enabled,
    createRun: enabled,
    execute: enabled,
    run: enabled,
    postgres: enabled,
    v2Backend: enabled,
  };
}

export function buildWorkflowV2Url(pathname: string): URL {
  const base = normalizedBaseUrl();
  if (!base) {
    throw new Error(NOT_CONFIGURED);
  }
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return new URL(path, `${base}/`);
}

export function workflowV2BlockedResponse(): NextResponse {
  return NextResponse.json({ status: "blocked", error: NOT_CONFIGURED }, { status: 503 });
}

export async function proxyWorkflowV2Json(request: NextRequest, pathname: string): Promise<Response> {
  if (!normalizedBaseUrl()) {
    return workflowV2BlockedResponse();
  }

  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const upstreamUrl = buildWorkflowV2Url(pathname);
  upstreamUrl.search = request.nextUrl.search;
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: request.method,
      headers: new Headers({
        accept: request.headers.get("accept") ?? "application/json",
        "content-type": request.headers.get("content-type") ?? "application/json",
      }),
      body,
    });
  } catch (error) {
    return NextResponse.json({
      status: "blocked",
      error: error instanceof Error ? error.message : String(error),
    }, { status: 502 });
  }

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
  });
}

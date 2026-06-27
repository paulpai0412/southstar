import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  buildWorkflowV2Url,
  proxyWorkflowV2Json,
  workflowV2Capabilities,
} from "../../lib/workflow/v2-api";

const originalFetch = global.fetch;
const originalBase = process.env.SOUTHSTAR_V2_API_BASE_URL;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) {
    delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  } else {
    process.env.SOUTHSTAR_V2_API_BASE_URL = originalBase;
  }
});

test("workflowV2Capabilities reports disabled when base url is missing", () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  assert.deepEqual(workflowV2Capabilities(), {
    createDraft: false,
    validate: false,
    createRun: false,
    execute: false,
    run: false,
    postgres: false,
    v2Backend: false,
  });
});

test("buildWorkflowV2Url appends api v2 path to configured base", () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000/";
  assert.equal(
    buildWorkflowV2Url("/api/v2/planner/drafts").toString(),
    "http://127.0.0.1:3000/api/v2/planner/drafts",
  );
});

test("proxyWorkflowV2Json forwards method, body, and content type", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  global.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Response.json({ draftId: "draft-1", status: "validated" }, { status: 201 });
  }) as typeof fetch;

  const request = new NextRequest("http://localhost/api/workflow/planner-drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goalPrompt: "ship it" }),
  });

  const response = await proxyWorkflowV2Json(request, "/api/v2/planner/drafts");
  assert.equal(response.status, 201);
  assert.equal(calls[0]?.url, "http://127.0.0.1:3000/api/v2/planner/drafts");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.body, JSON.stringify({ goalPrompt: "ship it" }));
  assert.equal(calls[0]?.init.headers instanceof Headers, true);
  assert.deepEqual(await response.json(), { draftId: "draft-1", status: "validated" });
});

test("proxyWorkflowV2Json returns blocked when v2 base is missing", async () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts", {
    method: "POST",
    body: JSON.stringify({ goalPrompt: "ship it" }),
  });

  const response = await proxyWorkflowV2Json(request, "/api/v2/planner/drafts");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "blocked",
    error: "Southstar v2 workflow API is not configured",
  });
});

test("workflow route status exposes v2 capabilities", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const { GET } = await import("../../app/api/workflow/status/route");
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    capabilities: {
      createDraft: true,
      validate: true,
      createRun: true,
      execute: true,
      run: true,
      postgres: true,
      v2Backend: true,
    },
  });
});

test("workflow route proxy planner drafts create maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ draftId: "draft-1" });
  }) as typeof fetch;

  const { POST } = await import("../../app/api/workflow/planner-drafts/route");
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts", {
    method: "POST",
    body: JSON.stringify({ goalPrompt: "make workflow" }),
  });

  const response = await POST(request);
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/planner/drafts");
  assert.deepEqual(await response.json(), { draftId: "draft-1" });
});

test("workflow route proxy planner draft revise maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ draftId: "draft-1", revised: true });
  }) as typeof fetch;

  const { POST } = await import("../../app/api/workflow/planner-drafts/[draftId]/revise/route");
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts/draft-1/revise", {
    method: "POST",
    body: JSON.stringify({ patch: [] }),
  });
  const response = await POST(request, { params: Promise.resolve({ draftId: "draft-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/planner/drafts/draft-1/revise");
  assert.deepEqual(await response.json(), { draftId: "draft-1", revised: true });
});

test("workflow route proxy planner draft orchestration maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ draftId: "draft-1", status: "validated" });
  }) as typeof fetch;

  const { GET } = await import("../../app/api/workflow/planner-drafts/[draftId]/orchestration/route");
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts/draft-1/orchestration", {
    method: "GET",
  });
  const response = await GET(request, { params: Promise.resolve({ draftId: "draft-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/planner/drafts/draft-1/orchestration");
  assert.deepEqual(await response.json(), { draftId: "draft-1", status: "validated" });
});

test("workflow route proxy planner draft runs maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ runId: "run-1", taskIds: ["task-1"] });
  }) as typeof fetch;

  const { POST } = await import("../../app/api/workflow/planner-drafts/[draftId]/runs/route");
  const request = new NextRequest("http://localhost/api/workflow/planner-drafts/draft-1/runs", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  const response = await POST(request, { params: Promise.resolve({ draftId: "draft-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/planner/drafts/draft-1/runs");
  assert.deepEqual(await response.json(), { runId: "run-1", taskIds: ["task-1"] });
});

test("workflow route proxy runs create maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ runId: "run-2" });
  }) as typeof fetch;

  const { POST } = await import("../../app/api/workflow/runs/route");
  const request = new NextRequest("http://localhost/api/workflow/runs", {
    method: "POST",
    body: JSON.stringify({ draftId: "draft-1" }),
  });
  const response = await POST(request);
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/runs");
  assert.deepEqual(await response.json(), { runId: "run-2" });
});

test("workflow route proxy run status maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ runId: "run-1", status: "running" });
  }) as typeof fetch;

  const { GET } = await import("../../app/api/workflow/runs/[runId]/route");
  const request = new NextRequest("http://localhost/api/workflow/runs/run-1", { method: "GET" });
  const response = await GET(request, { params: Promise.resolve({ runId: "run-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/runs/run-1");
  assert.deepEqual(await response.json(), { runId: "run-1", status: "running" });
});

test("workflow route proxy run tasks maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ tasks: [{ taskId: "task-1" }] });
  }) as typeof fetch;

  const { GET } = await import("../../app/api/workflow/runs/[runId]/tasks/route");
  const request = new NextRequest("http://localhost/api/workflow/runs/run-1/tasks", { method: "GET" });
  const response = await GET(request, { params: Promise.resolve({ runId: "run-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/runs/run-1/tasks");
  assert.deepEqual(await response.json(), { tasks: [{ taskId: "task-1" }] });
});

test("workflow route proxy run execute maps to v2", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({ runId: "run-1", status: "queued" });
  }) as typeof fetch;

  const { POST } = await import("../../app/api/workflow/runs/[runId]/execute/route");
  const request = new NextRequest("http://localhost/api/workflow/runs/run-1/execute", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
  const response = await POST(request, { params: Promise.resolve({ runId: "run-1" }) });
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/runs/run-1/execute");
  assert.deepEqual(await response.json(), { runId: "run-1", status: "queued" });
});

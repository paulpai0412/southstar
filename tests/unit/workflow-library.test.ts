import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as postWorkflowGenerate } from "../../web/app/api/workflow/generate/route";
import { GET as getWorkflowLibrary } from "../../web/app/api/workflow/library/route";
import { GET as getWorkflowResource, PUT as putWorkflowResource } from "../../web/app/api/workflow/resources/[...path]/route";
import { loadWorkflowLibrary, readWorkflowResource, writeWorkflowResource } from "../../web/lib/workflow/library-store";
import { buildWorkflowDagFromPlannerDraft, workflowLibraryFromAgentLibrary } from "../../web/lib/workflow/v2-library-adapter";

const originalFetch = global.fetch;
const originalBase = process.env.SOUTHSTAR_V2_API_BASE_URL;

function resourceRouteContext(resourcePath: string) {
  return { params: Promise.resolve({ path: resourcePath.split("/") }) };
}

function resourceRequest(resourcePath: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(`http://localhost/api/workflow/resources/${resourcePath}`, init);
}

function readSse(responseText: string): Array<{ event: string; data: unknown }> {
  return responseText
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
      const dataText = lines.find((line) => line.startsWith("data:"))?.slice(5).trim() ?? "null";
      return { event, data: JSON.parse(dataText) as unknown };
    });
}

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) {
    delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  } else {
    process.env.SOUTHSTAR_V2_API_BASE_URL = originalBase;
  }
});

test("workflowLibraryFromAgentLibrary mapping keeps domain and profiles for workflow ui", () => {
  const library = workflowLibraryFromAgentLibrary({
    domain: "software",
    roles: [
      {
        id: "maker",
        responsibility: "Implement",
        defaultAgentProfileRef: "profile.software-maker-pi",
        allowedAgentProfileRefs: ["profile.software-maker-pi"],
        artifactInputs: [],
        artifactOutputs: [],
        stopAuthority: "can-suggest",
      },
    ],
    agentProfiles: [
      {
        id: "profile.software-maker-pi",
        name: "software-maker",
        provider: "pi",
        model: "pi-agent-default",
        harnessRef: "pi",
        agentsMdRefs: [],
        promptTemplateRef: "software-maker",
        skillRefs: ["software-implementation"],
        mcpGrantRefs: ["filesystem-workspace"],
        memoryScopes: ["workspace", "run"],
        contextPolicyRef: "context-default",
        sessionPolicyRef: "session-default",
        toolPolicy: {
          allowedTools: ["workspace-read", "workspace-write"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 20_000,
          maxOutputTokens: 10_000,
          maxWallTimeSeconds: 1_200,
        },
      },
    ],
    skills: [],
    mcpServers: [],
    tools: [],
    artifactContracts: [],
    evaluatorPipelines: [],
    contextPolicies: [],
    sessionPolicies: [],
    memoryPolicies: [],
    workspacePolicies: [],
    vaultLeasePolicies: [],
  });

  assert.equal(library.domains[0]?.id, "software");
  assert.equal(library.domains[0]?.workflowTemplates[0]?.id, "template.software.v2");
  assert.equal(library.domains[0]?.agents[0]?.defaultProfileRef, "profile.software-maker-pi");
  assert.equal(library.domains[0]?.agents[0]?.profileResourcePath, "software/agents/software-maker/profile.json");
});

test("buildWorkflowDagFromPlannerDraft mapping preserves dependencies and readiness", () => {
  const dag = buildWorkflowDagFromPlannerDraft({
    draftId: "draft-1",
    goalPrompt: "Ship feature",
    workflowId: "wf-1",
    status: "validated",
    validationIssues: [],
    taskSummaries: [
      {
        taskId: "understand",
        taskName: "Understand scope",
        dependsOn: [],
        roleRef: "explorer",
        agentProfileRef: "profile.software-explorer-codex",
      },
      {
        taskId: "implement",
        taskName: "Implement change",
        dependsOn: ["understand"],
        roleRef: "maker",
        agentProfileRef: "profile.software-maker-pi",
      },
    ],
  });

  assert.equal(dag.id, "draft-1");
  assert.equal(dag.readiness, "ready");
  assert.equal(dag.nodes.length, 2);
  assert.equal(dag.nodes[1]?.provider, "pi");
  assert.deepEqual(dag.edges, [{ from: "understand", to: "implement" }]);
});


test("buildWorkflowDagFromPlannerDraft computes dependency-derived levels for parallel tasks", () => {
  const dag = buildWorkflowDagFromPlannerDraft({
    draftId: "draft-parallel",
    goalPrompt: "Ship full-stack todo app",
    workflowId: "wf-parallel",
    status: "validated",
    validationIssues: [],
    taskSummaries: [
      { taskId: "understand", taskName: "Understand", dependsOn: [], roleRef: "explorer", agentProfileRef: "profile.software-explorer-codex" },
      { taskId: "review", taskName: "Review", dependsOn: ["understand"], roleRef: "checker", agentProfileRef: "profile.software-checker-codex" },
      { taskId: "frontend", taskName: "Frontend", dependsOn: ["review"], roleRef: "maker", agentProfileRef: "profile.software-maker-pi" },
      { taskId: "backend", taskName: "Backend", dependsOn: ["review"], roleRef: "maker", agentProfileRef: "profile.software-maker-pi" },
      { taskId: "integrate", taskName: "Integrate", dependsOn: ["frontend", "backend"], roleRef: "maker", agentProfileRef: "profile.software-maker-pi" },
    ],
  });

  const levels = Object.fromEntries(dag.nodes.map((node) => [node.id, node.level]));
  assert.deepEqual(levels, {
    understand: 0,
    review: 1,
    frontend: 2,
    backend: 2,
    integrate: 3,
  });
});

test("loadWorkflowLibrary returns the software workflow fixture when no file library exists", async () => {
  const library = await loadWorkflowLibrary({ cwd: "/tmp/path-that-does-not-exist" });

  assert.equal(library.domains[0]?.id, "software");
  assert.equal(library.domains[0]?.workflowTemplates[0]?.id, "template.software-feature");
  assert.ok(library.domains[0]?.agents.some((agent) => agent.id === "agent.software-maker"));
});

test("readWorkflowResource returns editable profile json", async () => {
  const resource = await readWorkflowResource({
    cwd: "/tmp/path-that-does-not-exist",
    resourcePath: "software/agents/software-maker/profile.json",
  });

  assert.equal(resource.kind, "json");
  assert.match(resource.content, /software-maker-pi/);
});

test("writeWorkflowResource rejects path traversal", async () => {
  await assert.rejects(
    () => writeWorkflowResource({
      cwd: "/tmp/path-that-does-not-exist",
      resourcePath: "../profile.json",
      content: "{}",
    }),
    /Invalid workflow resource path/,
  );
});

test("readWorkflowResource rejects unknown fixture profile paths", async () => {
  await assert.rejects(
    () => readWorkflowResource({
      cwd: "/tmp/path-that-does-not-exist",
      resourcePath: "software/agents/not-real/profile.json",
    }),
    /Workflow resource not found/,
  );
});

test("readWorkflowResource rejects when a directory exists at a resource file path", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-workflow-"));
  await fs.mkdir(path.join(cwd, ".southstar/library/domains/software/agents/software-maker/profile.json"), { recursive: true });

  await assert.rejects(
    () => readWorkflowResource({
      cwd,
      resourcePath: "software/agents/software-maker/profile.json",
    }),
  );
});

test("writeWorkflowResource persists valid json under file library root", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-workflow-"));
  const resource = await writeWorkflowResource({
    cwd,
    resourcePath: "software/agents/software-maker/profile.json",
    content: JSON.stringify({ id: "software-maker-pi", provider: "pi" }, null, 2),
  });

  assert.equal(resource.source, "file");
  assert.equal(JSON.parse(resource.content).provider, "pi");
});

test("GET workflow resource route returns fixture resource", async () => {
  const response = await getWorkflowResource(
    resourceRequest("software/agents/software-maker/profile.json"),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );

  assert.equal(response.status, 200);
  const body = await response.json() as { resource?: { source: string; kind: string } };
  assert.equal(body.resource?.source, "fixture");
  assert.equal(body.resource?.kind, "json");
});

test("library route prefers v2 agent-library when SOUTHSTAR_V2_API_BASE_URL is configured", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    calls.push(String(url));
    return Response.json({
      ok: true,
      kind: "agent-library",
      result: {
        domain: "software",
        roles: [
          {
            id: "maker",
            responsibility: "Implement",
            defaultAgentProfileRef: "profile.software-maker-pi",
            allowedAgentProfileRefs: ["profile.software-maker-pi"],
            artifactInputs: [],
            artifactOutputs: [],
            stopAuthority: "can-suggest",
          },
        ],
        agentProfiles: [
          {
            id: "profile.software-maker-pi",
            name: "software-maker",
            provider: "pi",
            model: "pi-agent-default",
            harnessRef: "pi",
            agentsMdRefs: [],
            promptTemplateRef: "software-maker",
            skillRefs: [],
            mcpGrantRefs: [],
            memoryScopes: [],
            contextPolicyRef: "context-default",
            sessionPolicyRef: "session-default",
            toolPolicy: { allowedTools: [], deniedTools: [], requiresApprovalFor: [] },
            budgetPolicy: { maxInputTokens: 1, maxOutputTokens: 1 },
          },
        ],
        skills: [],
        mcpServers: [],
        tools: [],
        artifactContracts: [],
        evaluatorPipelines: [],
        contextPolicies: [],
        sessionPolicies: [],
        memoryPolicies: [],
        workspacePolicies: [],
        vaultLeasePolicies: [],
      },
    });
  }) as typeof fetch;

  const response = await getWorkflowLibrary(new NextRequest("http://localhost/api/workflow/library?cwd=/tmp/demo&domain=software"));
  assert.equal(response.status, 200);
  assert.equal(calls[0], "http://127.0.0.1:3000/api/v2/agent-library?domain=software");
  const body = await response.json() as { library: { domains: Array<{ workflowTemplates: Array<{ id: string }> }> } };
  assert.equal(body.library.domains[0]?.workflowTemplates[0]?.id, "template.software.v2");
});

test("library route falls back to fixture library when v2 backend is not configured", async () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  let called = false;
  global.fetch = (async () => {
    called = true;
    throw new Error("fetch should not be called without v2 base");
  }) as typeof fetch;

  const response = await getWorkflowLibrary(new NextRequest("http://localhost/api/workflow/library?cwd=/tmp/demo"));
  assert.equal(response.status, 200);
  assert.equal(called, false);
  const body = await response.json() as { library: { domains: Array<{ workflowTemplates: Array<{ id: string }> }> } };
  assert.equal(body.library.domains[0]?.workflowTemplates[0]?.id, "template.software-feature");
});

test("generate route proxies backend planner draft stream and converts orchestration to a DAG", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  global.fetch = (async (url, init) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
    });
    if (href.endsWith("/api/v2/planner/drafts/stream")) {
      return new Response([
        'event: planner.stage\ndata: {"stage":"composer.started","message":"Streaming LLM workflow composition."}\n\n',
        'event: message.delta\ndata: {"text":"{\\"schemaVersion\\""}\n\n',
        'event: draft\ndata: {"draft":{"draftId":"draft-1","status":"validated"}}\n\n',
        'event: orchestration\ndata: {"orchestration":{"draftId":"draft-1","goalPrompt":"Ship feature","workflowId":"wf-1","status":"validated","validationIssues":[],"taskSummaries":[{"taskId":"implement","taskName":"Implement change","dependsOn":[],"roleRef":"maker","agentProfileRef":"profile.software-maker-pi"}]}}\n\n',
        'event: done\ndata: {}\n\n',
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  const response = await postWorkflowGenerate(new NextRequest("http://localhost/api/workflow/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Ship feature", cwd: "/tmp/demo" }),
  }));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = readSse(await response.text());
  assert.deepEqual(events.map((event) => event.event), ["planner.stage", "message.delta", "draft", "dag", "done"]);
  const dagPayload = events.find((event) => event.event === "dag")?.data as { dag?: { id?: string } };
  assert.equal(dagPayload.dag?.id, "draft-1");
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:3000/api/v2/planner/drafts/stream",
    method: "POST",
    body: {
      goalPrompt: "Ship feature",
      cwd: "/tmp/demo",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
    },
  }]);
});

test("generate route fallback can produce a parallel workflow DAG from prompt intent", async () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  global.fetch = (async () => {
    throw new Error("fetch should not be called without v2 base");
  }) as typeof fetch;

  const response = await postWorkflowGenerate(new NextRequest("http://localhost/api/workflow/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "生成 todo webapp 的並行 workflow DAG，frontend 與 backend 可以 parallel implement",
      cwd: "/tmp/demo",
    }),
  }));

  assert.equal(response.status, 200);
  const events = readSse(await response.text());
  const dagPayload = events.find((event) => event.event === "dag")?.data as {
    dag?: {
      nodes?: Array<{ id: string; level: number }>;
      edges?: Array<{ from: string; to: string }>;
    };
  };
  const nodes = dagPayload.dag?.nodes ?? [];
  const edges = dagPayload.dag?.edges ?? [];
  const parallelImplementNodes = nodes.filter((node) => node.level === 2);

  assert.deepEqual(parallelImplementNodes.map((node) => node.id).sort(), ["implement-api", "implement-ui"]);
  assert.ok(edges.some((edge) => edge.from === "plan" && edge.to === "implement-ui"));
  assert.ok(edges.some((edge) => edge.from === "plan" && edge.to === "implement-api"));
  assert.ok(edges.some((edge) => edge.from === "implement-ui" && edge.to === "verify"));
  assert.ok(edges.some((edge) => edge.from === "implement-api" && edge.to === "verify"));
  assert.equal(edges.some((edge) => edge.from === "implement-ui" && edge.to === "implement-api"), false);
});

test("GET workflow resource route returns 404 for an unknown resource", async () => {
  const response = await getWorkflowResource(
    resourceRequest("software/agents/not-real/profile.json"),
    resourceRouteContext("software/agents/not-real/profile.json"),
  );

  assert.equal(response.status, 404);
});

test("GET workflow resource route returns 400 for path traversal", async () => {
  const response = await getWorkflowResource(
    resourceRequest("../profile.json"),
    resourceRouteContext("../profile.json"),
  );

  assert.equal(response.status, 400);
});

test("PUT workflow resource route returns 400 when content is missing", async () => {
  const response = await putWorkflowResource(
    resourceRequest("software/agents/software-maker/profile.json", {
      method: "PUT",
      body: JSON.stringify({ cwd: "/tmp" }),
    }),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );

  assert.equal(response.status, 400);
});

test("PUT workflow resource route returns 400 when cwd is missing", async () => {
  const response = await putWorkflowResource(
    resourceRequest("software/agents/software-maker/profile.json", {
      method: "PUT",
      body: JSON.stringify({ content: "{}" }),
    }),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );

  assert.equal(response.status, 400);
});

test("PUT workflow resource route returns 400 when cwd is empty", async () => {
  const response = await putWorkflowResource(
    resourceRequest("software/agents/software-maker/profile.json", {
      method: "PUT",
      body: JSON.stringify({ cwd: "", content: "{}" }),
    }),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );

  assert.equal(response.status, 400);
});

test("PUT workflow resource route returns 400 when cwd is relative", async () => {
  const originalCwd = process.cwd();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-workflow-route-"));
  process.chdir(cwd);
  try {
    const response = await putWorkflowResource(
      resourceRequest("software/agents/software-maker/profile.json", {
        method: "PUT",
        body: JSON.stringify({ cwd: "relative-project", content: "{}" }),
      }),
      resourceRouteContext("software/agents/software-maker/profile.json"),
    );

    assert.equal(response.status, 400);
  } finally {
    process.chdir(originalCwd);
  }
});

test("PUT workflow resource route returns 400 for invalid json content", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-workflow-"));
  const response = await putWorkflowResource(
    resourceRequest("software/agents/software-maker/profile.json", {
      method: "PUT",
      body: JSON.stringify({ cwd, content: "{" }),
    }),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );

  assert.equal(response.status, 400);
});

test("resources route includes local source metadata and capability signals", async () => {
  const response = await getWorkflowResource(
    resourceRequest("software/agents/software-maker/profile.json"),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );
  assert.equal(response.status, 200);

  const body = await response.json() as {
    resource?: { source: string };
    source?: { storage?: string };
    capabilities?: { localResourceEditing?: boolean; v2Backend?: boolean };
  };

  assert.equal(body.resource?.source, "fixture");
  assert.equal(body.source?.storage, "local");
  assert.equal(body.capabilities?.localResourceEditing, true);
  assert.equal(body.capabilities?.v2Backend, false);
});

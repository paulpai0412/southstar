import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as postWorkflowGenerate } from "../../web/app/api/workflow/generate/route";
import { GET as getWorkflowLibrary } from "../../web/app/api/workflow/library/route";
import { GET as getWorkflowResource, PUT as putWorkflowResource } from "../../web/app/api/workflow/resources/[...path]/route";
import { groupSkillResourcePaths } from "../../web/lib/workflow/skill-resource-tree";
import { readWorkflowResource, writeWorkflowResource } from "../../web/lib/workflow/library-store";
import { buildWorkflowDagFromPlannerDraft } from "../../web/lib/workflow/v2-library-adapter";
import { buildWorkflowTemplateSaveRequest } from "../../web/lib/workflow/template-save";

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
        harnessRef: "pi",
        provider: "pi",
        model: "pi-agent-default",
      },
    ],
  });

  assert.equal(dag.id, "draft-1");
  assert.equal(dag.readiness, "ready");
  assert.equal(dag.nodes.length, 2);
  assert.equal(dag.nodes[1]?.provider, "pi");
  assert.equal(dag.nodes[1]?.model, "pi-agent-default");
  assert.deepEqual(dag.edges, [{ from: "understand", to: "implement" }]);
});

test("buildWorkflowDagFromPlannerDraft does not invent profile bindings", () => {
  const dag = buildWorkflowDagFromPlannerDraft({
    draftId: "draft-unbound",
    goalPrompt: "Inspect capability",
    workflowId: "wf-unbound",
    status: "validated",
    validationIssues: [],
    taskSummaries: [{
      taskId: "inspect",
      taskName: "Inspect capability",
      dependsOn: [],
    }],
  });

  assert.equal(dag.nodes[0]?.profileRef, undefined);
  assert.equal(dag.nodes[0]?.provider, undefined);
  assert.equal(dag.nodes[0]?.model, undefined);
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

test("buildWorkflowTemplateSaveRequest creates draft proposals with explicit scope", () => {
  const dag = buildWorkflowDagFromPlannerDraft({
    draftId: "draft-template-save",
    goalPrompt: "Ship feature",
    workflowId: "wf-template-save",
    status: "validated",
    validationIssues: [],
    taskSummaries: [
      { taskId: "implement", taskName: "Implement", dependsOn: [], roleRef: "maker", agentProfileRef: "profile.software-maker-pi" },
    ],
  });

  const request = buildWorkflowTemplateSaveRequest({ draftId: "draft-template-save", dag, scope: "design/article" });

  assert.equal(request.body.status, "draft");
  assert.equal(request.body.scope, "design/article");
  assert.doesNotMatch(JSON.stringify(request.body), /approved/);
});

test("buildWorkflowTemplateSaveRequest rejects missing scope instead of defaulting to software", () => {
  const dag = buildWorkflowDagFromPlannerDraft({
    draftId: "draft-template-save",
    goalPrompt: "Ship feature",
    workflowId: "wf-template-save",
    status: "validated",
    validationIssues: [],
    taskSummaries: [
      { taskId: "implement", taskName: "Implement", dependsOn: [], roleRef: "maker", agentProfileRef: "profile.software-maker-pi" },
    ],
  });

  assert.rejects(
    async () => buildWorkflowTemplateSaveRequest({ draftId: "draft-template-save", dag }),
    /requires an explicit scope/,
  );
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

test("readWorkflowResource requires a project directory for local resources", async () => {
  await assert.rejects(
    () => readWorkflowResource({
      cwd: null,
      resourcePath: "software/agents/software-maker/profile.json",
    }),
    /A project directory is required/,
  );
});

test("readWorkflowResource rejects missing local profile paths", async () => {
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

test("groupSkillResourcePaths groups metadata and bundle files under one skill folder", () => {
  const groups = groupSkillResourcePaths([
    "library/skills/mattpocock.codebase-design.skill.md",
    "library/skills/mattpocock.codebase-design/DEEPENING.md",
    "library/skills/mattpocock.codebase-design/DESIGN-IT-TWICE.md",
    "library/skills/mattpocock.codebase-design/SKILL.md",
    "library/skills/mattpocock.implement.skill.md",
    "library/skills/mattpocock.implement/SKILL.md",
  ]);

  assert.deepEqual(groups.map((group) => group.skillName), [
    "mattpocock.codebase-design",
    "mattpocock.implement",
  ]);
  assert.deepEqual(groups[0]?.files.map((file) => file.label), [
    "mattpocock.codebase-design.skill.md",
    "DEEPENING.md",
    "DESIGN-IT-TWICE.md",
    "SKILL.md",
  ]);
  assert.equal(groups.some((group) => group.skillName === "skills"), false);
});

test("GET workflow resource route renders graph agent definition as AGENTS.md", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  global.fetch = (async (url) => {
    const href = String(url);
    if (href.endsWith("/api/v2/library/objects/agent.engineering-software-architect")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "agent.engineering-software-architect",
            objectKind: "agent_definition",
            status: "approved",
            state: {
              title: "Software Architect",
              body: "Design implementation boundaries from the selected workflow context.",
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  const response = await getWorkflowResource(
    resourceRequest("library/generated-agents/agent.engineering-software-architect/AGENTS.md"),
    resourceRouteContext("library/generated-agents/agent.engineering-software-architect/AGENTS.md"),
  );

  assert.equal(response.status, 200);
  const body = await response.json() as { resource?: { kind?: string; path?: string; content?: string; source?: string; writable?: boolean } };
  assert.equal(body.resource?.kind, "markdown");
  assert.equal(body.resource?.path, "library/generated-agents/agent.engineering-software-architect/AGENTS.md");
  assert.equal(body.resource?.source, "generated");
  assert.equal(body.resource?.writable, false);
  assert.match(body.resource?.content ?? "", /# Software Architect/);
  assert.match(body.resource?.content ?? "", /Design implementation boundaries/);
});

test("library route reads approved workflow templates from the Postgres graph API", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: string[] = [];
  global.fetch = (async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/api/v2/library/graph?scope=software&status=approved")) {
      return Response.json({
        ok: true,
        kind: "library-graph",
        result: {
          nodes: [{
            objectKey: "template.english-vocab-feature",
            objectKind: "workflow_template",
            status: "approved",
            title: "English Vocabulary Feature Workflow",
            scope: "software",
          }],
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/template.english-vocab-feature")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "template.english-vocab-feature",
            objectKind: "workflow_template",
            status: "approved",
            state: {
              scope: "software",
              title: "English Vocabulary Feature Workflow",
              profileRefs: [
                "profile.generated.english-vocab-feature.plan-english-vocab-feature",
                "profile.generated.english-vocab-feature.implement-english-vocab-feature",
              ],
              nodes: [
                {
                  id: "plan-english-vocab-feature",
                  title: "規劃簡易背英文單字功能",
                  profileRef: "profile.generated.english-vocab-feature.plan-english-vocab-feature",
                },
                {
                  id: "implement-english-vocab-feature",
                  title: "實作簡易背英文單字功能",
                  profileRef: "profile.generated.english-vocab-feature.implement-english-vocab-feature",
                },
              ],
            },
          },
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/profile.generated.english-vocab-feature.plan-english-vocab-feature")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "profile.generated.english-vocab-feature.plan-english-vocab-feature",
            objectKind: "agent_profile",
            status: "approved",
            state: {
              sourcePath: "library/profiles/generated/english-vocab-feature/plan-english-vocab-feature.profile.yaml",
              agentRef: "agent.engineering-software-architect",
              skillRefs: ["skill.mattpocock.codebase-design"],
              toolGrantRefs: ["tool.shell-command"],
            },
          },
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/profile.generated.english-vocab-feature.implement-english-vocab-feature")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "profile.generated.english-vocab-feature.implement-english-vocab-feature",
            objectKind: "agent_profile",
            status: "approved",
            state: {
              sourcePath: "library/profiles/generated/english-vocab-feature/implement-english-vocab-feature.profile.yaml",
              skillRefs: ["skill.mattpocock.implement"],
              toolGrantRefs: ["tool.workspace-write"],
            },
          },
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/skill.mattpocock.codebase-design")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "skill.mattpocock.codebase-design",
            objectKind: "skill_spec",
            status: "approved",
            state: {
              sourcePath: "library/skills/mattpocock.codebase-design.skill.md",
            },
          },
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/agent.engineering-software-architect")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "agent.engineering-software-architect",
            objectKind: "agent_definition",
            status: "approved",
            state: {
              title: "Software Architect",
              body: "Design the implementation plan and architectural boundaries.",
              sourcePath: "library/agents/engineering-software-architect.agent.md",
            },
          },
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/skill.mattpocock.implement")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: "skill.mattpocock.implement",
            objectKind: "skill_spec",
            status: "approved",
            state: {
              sourcePath: "library/skills/mattpocock.implement.skill.md",
            },
          },
        },
      });
    }
    if (href.endsWith("/api/v2/library/objects/tool.shell-command") || href.endsWith("/api/v2/library/objects/tool.workspace-write")) {
      return Response.json({
        ok: true,
        kind: "library-object-detail",
        result: {
          object: {
            objectKey: href.split("/").at(-1),
            objectKind: "tool_definition",
            status: "approved",
            state: {},
          },
        },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  const response = await getWorkflowLibrary(new NextRequest("http://localhost/api/workflow/library?cwd=/tmp/demo&domain=software"));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.slice(0, 4), [
    "http://127.0.0.1:3000/api/v2/library/graph?scope=software&status=approved",
    "http://127.0.0.1:3000/api/v2/library/objects/template.english-vocab-feature",
    "http://127.0.0.1:3000/api/v2/library/objects/profile.generated.english-vocab-feature.plan-english-vocab-feature",
    "http://127.0.0.1:3000/api/v2/library/objects/profile.generated.english-vocab-feature.implement-english-vocab-feature",
  ]);
  const body = await response.json() as { library: { domains: Array<{ workflowTemplates: Array<{ id: string; nodes: Array<{ id: string; title: string }>; stageRefs: string[]; agentRefs: string[] }>; agents: Array<{ id: string; profileResourcePath: string; instructionResourcePath: string; skillResourcePaths: string[]; policyResourcePaths: string[] }> }> } };
  const template = body.library.domains[0]?.workflowTemplates[0];
  assert.equal(template?.id, "template.english-vocab-feature");
  assert.deepEqual(template?.nodes.map((node) => ({ id: node.id, title: node.title })), [
    { id: "plan-english-vocab-feature", title: "規劃簡易背英文單字功能" },
    { id: "implement-english-vocab-feature", title: "實作簡易背英文單字功能" },
  ]);
  assert.deepEqual(template?.stageRefs, ["plan-english-vocab-feature", "implement-english-vocab-feature"]);
  assert.deepEqual(template?.agentRefs, [
    "agent.generated-english-vocab-feature-plan-english-vocab-feature",
    "agent.generated-english-vocab-feature-implement-english-vocab-feature",
  ]);
  assert.deepEqual(body.library.domains[0]?.agents.map((agent) => agent.id), template?.agentRefs);
  assert.equal(
    body.library.domains[0]?.agents.some((agent) =>
      agent.profileResourcePath === "library/profiles/generated/english-vocab-feature/plan-english-vocab-feature.profile.yaml"
        && agent.instructionResourcePath === "library/generated-agents/agent.engineering-software-architect/AGENTS.md"
    ),
    true,
  );
  const planAgent = body.library.domains[0]?.agents[0];
  assert.equal(planAgent?.instructionResourcePath, "library/generated-agents/agent.engineering-software-architect/AGENTS.md");
  assert.equal(planAgent?.skillResourcePaths.includes("library/skills/mattpocock.codebase-design.skill.md"), true);
  assert.equal(planAgent?.skillResourcePaths.includes("library/skills/mattpocock.codebase-design/SKILL.md"), true);
  assert.equal(planAgent?.skillResourcePaths.includes("library/skills/mattpocock.codebase-design/DEEPENING.md"), true);
  assert.equal(planAgent?.policyResourcePaths.includes("library/objects/tool.shell-command.json"), true);
});

test("library route does not fall back to fixture templates when v2 backend is not configured", async () => {
  delete process.env.SOUTHSTAR_V2_API_BASE_URL;
  let called = false;
  global.fetch = (async () => {
    called = true;
    throw new Error("fetch should not be called without v2 base");
  }) as typeof fetch;

  const response = await getWorkflowLibrary(new NextRequest("http://localhost/api/workflow/library?cwd=/tmp/demo"));
  assert.equal(response.status, 503);
  assert.equal(called, false);
  const body = await response.json() as { error?: string };
  assert.match(body.error ?? "", /not configured/);
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
    if (href.endsWith("/api/v2/run-goal")) {
      return new Response([
        'event: planner.stage\ndata: {"stage":"composer.started","message":"Streaming LLM workflow composition."}\n\n',
        'event: message.delta\ndata: {"text":"{\\"schemaVersion\\""}\n\n',
        'event: done\ndata: {"draftId":"draft-1","draftStatus":"validated","goalContractHash":"goal-hash","blockers":[]}\n\n',
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (href.endsWith("/api/v2/planner/drafts/draft-1/orchestration")) {
      return Response.json({
        ok: true,
        result: {
          draftId: "draft-1",
          goalPrompt: "Ship feature",
          workflowId: "wf-1",
          status: "validated",
          validationIssues: [],
          taskSummaries: [{ taskId: "implement", taskName: "Implement change", dependsOn: [], roleRef: "maker", agentProfileRef: "profile.software-maker-pi" }],
        },
      });
    }
    if (href.endsWith("/api/v2/ui/workflow?draftId=draft-1")) {
      return Response.json({ ok: true, result: { mission: null, commands: [] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  const response = await postWorkflowGenerate(new NextRequest("http://localhost/api/workflow/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Ship feature", cwd: "/tmp/demo", idempotencyKey: "unit-key" }),
  }));

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = readSse(await response.text());
  assert.deepEqual(events.map((event) => event.event), ["planner.stage", "message.delta", "draft", "dag", "done"]);
  const dagPayload = events.find((event) => event.event === "dag")?.data as { dag?: { id?: string } };
  assert.equal(dagPayload.dag?.id, "draft-1");
  assert.deepEqual(calls, [{
    url: "http://127.0.0.1:3000/api/v2/run-goal",
    method: "POST",
    body: {
      goalPrompt: "Ship feature",
      cwd: "/tmp/demo",
      idempotencyKey: "unit-key",
    },
  }, {
    url: "http://127.0.0.1:3000/api/v2/planner/drafts/draft-1/orchestration",
    method: "GET",
    body: undefined,
  }, {
    url: "http://127.0.0.1:3000/api/v2/ui/workflow?draftId=draft-1",
    method: "GET",
    body: undefined,
  }]);
});

test("generate route delegates workflow read-model transport and DAG projection", async () => {
  const source = await fs.readFile(new URL("../../web/app/api/workflow/generate/route.ts", import.meta.url), "utf8");

  assert.match(source, /projectWorkflowUiReadModel/);
  assert.doesNotMatch(source, /buildWorkflowDagFromPlannerDraft/);
  assert.doesNotMatch(source, /unwrapV2Envelope/);
  assert.doesNotMatch(source, /async function fetchJson/);
});

test("generate route forwards template policy through run-goal", async () => {
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://127.0.0.1:3000";
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  global.fetch = (async (url, init) => {
    const href = String(url);
    calls.push({
      url: href,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
    });
    if (href.endsWith("/api/v2/run-goal")) {
      return new Response([
        'event: planner.stage\ndata: {"stage":"goal_contract.interpreted"}\n\n',
        'event: done\ndata: {"draftId":"draft-template-1","draftStatus":"validated","goalContractHash":"goal-hash","blockers":[]}\n\n',
      ].join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (href.endsWith("/api/v2/planner/drafts/draft-template-1/orchestration")) {
      return Response.json({
        ok: true,
        result: {
          draftId: "draft-template-1",
          goalPrompt: "@workflow-template 前後台軟體開發流程 (template.software-dev)\n生成一個猜謎的webapp",
          workflowId: "wf-template-1",
          status: "validated",
          validationIssues: [],
          taskSummaries: [
            {
              taskId: "task.plan",
              taskName: "Plan riddle app",
              dependsOn: [],
              roleRef: "architect",
              agentProfileRef: "generated.agent_profile.riddle.plan.v1",
            },
          ],
        },
      });
    }
    if (href.endsWith("/api/v2/ui/workflow?draftId=draft-template-1")) {
      return Response.json({ ok: true, result: { mission: null, commands: [] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  const response = await postWorkflowGenerate(new NextRequest("http://localhost/api/workflow/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "@workflow-template 前後台軟體開發流程 (template.software-dev)\n生成一個猜謎的webapp",
      cwd: "/tmp/demo",
      idempotencyKey: "template-key",
      templatePolicy: {
        mode: "require",
        templateRef: "template.software-dev",
        versionRef: "template.software-dev@v1",
      },
    }),
  }));

  assert.equal(response.status, 200);
  const events = readSse(await response.text());
  assert.deepEqual(events.map((event) => event.event), ["planner.stage", "draft", "dag", "done"]);
  const dagPayload = events.find((event) => event.event === "dag")?.data as { dag?: { id?: string } };
  assert.equal(dagPayload.dag?.id, "draft-template-1");
  assert.deepEqual(calls, [
    {
      url: "http://127.0.0.1:3000/api/v2/run-goal",
      method: "POST",
      body: {
        goalPrompt: "@workflow-template 前後台軟體開發流程 (template.software-dev)\n生成一個猜謎的webapp",
        cwd: "/tmp/demo",
        idempotencyKey: "template-key",
        templatePolicy: {
          mode: "require",
          templateRef: "template.software-dev",
          versionRef: "template.software-dev@v1",
        },
      },
    },
    {
      url: "http://127.0.0.1:3000/api/v2/planner/drafts/draft-template-1/orchestration",
      method: "GET",
      body: undefined,
    },
    {
      url: "http://127.0.0.1:3000/api/v2/ui/workflow?draftId=draft-template-1",
      method: "GET",
      body: undefined,
    },
  ]);
});

test("generate route requires the v2 runtime planner instead of using local fallback DAG generation", async () => {
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
      idempotencyKey: "unit-key",
    }),
  }));

  assert.equal(response.status, 503);
  assert.match(await response.text(), /not configured/);
});

test("GET workflow resource route returns 404 for an unknown resource", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-workflow-"));
  const response = await getWorkflowResource(
    resourceRequest(`software/agents/not-real/profile.json?cwd=${encodeURIComponent(cwd)}`),
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-workflow-"));
  await writeWorkflowResource({
    cwd,
    resourcePath: "software/agents/software-maker/profile.json",
    content: JSON.stringify({ id: "software-maker-pi", provider: "pi" }, null, 2),
  });

  const response = await getWorkflowResource(
    resourceRequest(`software/agents/software-maker/profile.json?cwd=${encodeURIComponent(cwd)}`),
    resourceRouteContext("software/agents/software-maker/profile.json"),
  );
  assert.equal(response.status, 200);

  const body = await response.json() as {
    resource?: { source: string };
    source?: { storage?: string };
    capabilities?: { localResourceEditing?: boolean; v2Backend?: boolean };
  };

  assert.equal(body.resource?.source, "file");
  assert.equal(body.source?.storage, "local");
  assert.equal(body.capabilities?.localResourceEditing, true);
  assert.equal(body.capabilities?.v2Backend, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");
function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("generateWorkflowDagStream parses POST SSE message deltas and DAG payloads", async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const chunks = [
    'event: message\ndata: {"text":"Creating planner draft"}\n\n',
    'event: message.delta\ndata: {"text":"Loading orchestration"}\n\n',
    'event: planner.stage\ndata: {"stage":"composer.started","message":"Streaming LLM workflow composition."}\n\n',
    'event: draft\ndata: {"draft":{"draftId":"draft-1","status":"validated"}}\n\n',
    'event: dag\ndata: {"dag":{"id":"draft-1","templateId":"template.software-feature","templateTitle":"Todo app","prompt":"todo","expandedByDefault":true,"readiness":"ready","nodes":[],"edges":[],"createdAt":"2026-06-29T00:00:00.000Z"}}\n\n',
    "event: done\ndata: {}\n\n",
  ];
  global.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
    const { generateWorkflowDagStream } = await import("../../web/lib/workflow/generate-stream.ts");
    const events: string[] = [];
    let dagId: string | null = null;
    await generateWorkflowDagStream({
      prompt: "todo",
      cwd: "/workspace/todo",
      templateId: "template.software-feature",
      onMessage(text: string, event: string) {
        events.push(`${event}:${text}`);
      },
      onStage(stage: { stage?: string; message?: string }) {
        events.push(`stage:${stage.stage}:${stage.message}`);
      },
      onDraft(draft: { draftId?: string }) {
        events.push(`draft:${draft.draftId}`);
      },
      onDag(dag: { id?: string }) {
        dagId = dag.id ?? null;
      },
      onDone() {
        events.push("done");
      },
    });

    assert.equal(calls[0]?.url, "/api/workflow/generate");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      prompt: "todo",
      cwd: "/workspace/todo",
      templateId: "template.software-feature",
    });
    assert.deepEqual(events, [
      "message:Creating planner draft",
      "message.delta:Loading orchestration",
      "stage:composer.started:Streaming LLM workflow composition.",
      "draft:draft-1",
      "done",
    ]);
    assert.equal(dagId, "draft-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateWorkflowDagStream posts revision prompts to the draft revise stream", async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  global.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;

  try {
    const { generateWorkflowDagStream } = await import("../../web/lib/workflow/generate-stream.ts");
    await generateWorkflowDagStream({
      prompt: "split frontend and backend into parallel tasks",
      draftId: "draft-wf-1",
      cwd: "/workspace/todo",
    });

    assert.equal(calls[0]?.url, "/api/workflow/planner-drafts/draft-wf-1/revise/stream");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      prompt: "split frontend and backend into parallel tasks",
      cwd: "/workspace/todo",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("Workflow mode generate submit uses web generate stream and preserves normal agent send", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  assert.match(hook, /generateWorkflowDagStream/);
  assert.match(hook, /opts\.workflowMode/);
  assert.match(hook, /type:\s*"workflowDag"/);
  assert.match(hook, /onStage/);
  assert.match(hook, /onDraft/);
  assert.match(hook, /message\.delta/);
  assert.match(hook, /sendAgentCommand/);
  assert.match(hook, /workflowTemplate/);
  assert.match(hook, /workflowCwd/);
});

test("Workflow mode creates its backing session with the same cwd used for planner generation", () => {
  const hook = source("web/hooks/useAgentSession.ts");

  assert.match(hook, /effectiveNewSessionCwd/);
  assert.match(hook, /opts\.workflowMode\s*\?\s*\(opts\.workflowCwd\s*\?\?\s*newSessionCwd\)\s*:\s*newSessionCwd/);
  assert.match(hook, /cwd:\s*effectiveNewSessionCwd/);
  assert.doesNotMatch(hook, /cwd:\s*newSessionCwd,\s*\n\s*type:\s*"ensure_session"/);
});

test("Workflow mode does not revise non-draft composition DAG ids", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const engine = source("web/lib/agent-session-engine.ts");

  assert.doesNotMatch(hook, /block\.dag\.draftId\s*\?\?\s*block\.dag\.id/);
  assert.match(hook, /latestWorkflowDraftId/);
  assert.match(engine, /function isPlannerDraftId/);
  assert.doesNotMatch(engine, /block\.dag\.draftId\s*\?\?\s*block\.dag\.id/);
});

test("Workflow mode renders DAG blocks while the workflow stream is still active", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  assert.match(hook, /onDag\(dag\) \{\s*generatedDag = dag;\s*updateStreamingMessage\(\);\s*\}/s);
  assert.match(hook, /content:\s*\[\s*\.\.\.\(streamedText[\s\S]+type:\s*"workflowDag"/);
});

test("Workflow mode generation can be stopped without a Pi session id", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const stream = source("web/lib/workflow/generate-stream.ts");

  assert.match(stream, /signal\?:\s*AbortSignal/);
  assert.match(stream, /signal:\s*input\.signal/);
  assert.match(hook, /workflowAbortControllerRef/);
  assert.match(hook, /new AbortController\(\)/);
  assert.match(hook, /signal:\s*workflowAbortController\.signal/);
  assert.match(hook, /workflowAbortControllerRef\.current\.abort\(\)/);
  assert.match(hook, /Workflow generation stopped/);
});

test("web workflow DAG block renders the shared React Flow canvas inside a scroll container", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");
  assert.match(block, /SouthstarWorkflowCanvas/);
  assert.match(block, /workflowDagToCanvasModel/);
  assert.match(block, /data-testid="workflow-dag-scroll"/);
  assert.match(block, /overflowX:\s*"auto"/);
  assert.match(block, /overflowY:\s*"auto"/);
  assert.match(block, /onSelectTask=\{handleSelectTask\}/);
});

test("workflow canvas layout ignores dependency edges that point at missing nodes", async () => {
  const { buildWorkflowFlowLayout } = await import("../../web/components/workflow-canvas/layout.ts");
  const flow = await buildWorkflowFlowLayout({
    canvas: {
      graphId: "dangling-edge",
      mode: "draft",
      nodes: [
        { id: "plan", label: "Plan", kind: "task", status: "ready", dependsOn: [], badges: [] },
        { id: "verify", label: "Verify", kind: "task", status: "ready", dependsOn: ["plan"], badges: [] },
      ],
      edges: [
        { id: "missing->verify", source: "missing", target: "verify", status: "ready" },
        { id: "plan->verify", source: "plan", target: "verify", status: "ready" },
      ],
    },
    selectedTaskId: null,
  });

  assert.equal(flow.nodes.length, 2);
  assert.deepEqual(flow.edges.map((edge) => edge.id), ["plan->verify"]);
});

test("Workflow DAG block exposes Save Template action for draft DAGs", () => {
  const sourceText = source("web/components/WorkflowDagBlock.tsx");
  assert.match(sourceText, /Save Template/);
  assert.match(sourceText, /save-template/);
  assert.match(sourceText, /window\.prompt\("Workflow template name"/);
});

test("workflow template save request uses encoded draft route and server-derived DAG payload", async () => {
  const { buildWorkflowTemplateSaveRequest } = await import("../../web/lib/workflow/template-save.ts");
  const request = buildWorkflowTemplateSaveRequest({
    draftId: "draft/with space",
    dag: {
      id: "template.Fancy Todo!",
      draftId: "draft/with space",
      templateId: "template.software",
      templateTitle: "Fancy Todo",
      prompt: "todo",
      expandedByDefault: true,
      readiness: "ready",
      nodes: [{
        id: "implement-ui",
        label: "Implement UI",
        role: "frontend",
        agentRef: "agent.frontend",
        profileRef: "profile.frontend",
        profileResourcePath: "profiles/frontend.json",
        provider: "codex",
        model: "gpt-5",
        level: 0,
        state: "ready",
      }],
      edges: [],
      createdAt: "2026-07-02T00:00:00.000Z",
    },
  });

  assert.equal(request.url, "/api/workflow/planner-drafts/draft%2Fwith%20space/save-template");
  assert.deepEqual(request.body, {
    scope: "software",
    templateId: "template.fancy-todo",
    title: "Fancy Todo",
    status: "approved",
  });
});

test("workflow template save request accepts user-entered template titles", async () => {
  const { buildWorkflowTemplateSaveRequest } = await import("../../web/lib/workflow/template-save.ts");
  const request = buildWorkflowTemplateSaveRequest({
    draftId: "draft-1",
    title: "Guess Number Webapp",
    dag: {
      id: "template.software",
      draftId: "draft-1",
      templateId: "template.software",
      templateTitle: "Original Title",
      prompt: "build game",
      expandedByDefault: true,
      readiness: "ready",
      nodes: [],
      edges: [],
      createdAt: "2026-07-02T00:00:00.000Z",
    },
  });

  assert.equal(request.body.title, "Guess Number Webapp");
});

test("Workflow DAG Save Template action surfaces progress and errors", () => {
  const sourceText = source("web/components/WorkflowDagBlock.tsx");
  assert.match(sourceText, /saveTemplateStatus/);
  assert.match(sourceText, /setSaveTemplateStatus\(\{\s*phase:\s*"saving"/);
  assert.match(sourceText, /setSaveTemplateStatus\(\{\s*phase:\s*"saved"/);
  assert.match(sourceText, /setSaveTemplateStatus\(\{\s*phase:\s*"error"/);
  assert.match(sourceText, /catch \(error\)/);
  assert.match(sourceText, /workflow-save-template-status/);
  assert.match(sourceText, /Saving\.\.\./);
});

test("workflow template mention button is only visible while hovering or focusing the template row", () => {
  const sourceText = source("web/components/WorkflowSidebar.tsx");
  assert.match(sourceText, /mentionVisible/);
  assert.match(sourceText, /onMouseEnter=\{\(\) => setMentionVisible\(true\)\}/);
  assert.match(sourceText, /onMouseLeave=\{\(\) => setMentionVisible\(false\)\}/);
  assert.match(sourceText, /visibility:\s*mentionVisible \? "visible" : "hidden"/);
});

test("workflow lifecycle starts generated planner DAGs as backend drafts", () => {
  const lifecycle = source("web/lib/workflow/lifecycle.ts");
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  const adapter = source("web/lib/workflow/v2-library-adapter.ts");

  assert.match(adapter, /draftStatus:\s*input\.status/);
  assert.match(lifecycle, /initialWorkflowLifecycleState/);
  assert.match(lifecycle, /dag\.draftId/);
  assert.match(lifecycle, /status:\s*dag\.draftStatus/);
  assert.match(hook, /useReducer\(workflowLifecycleReducer,\s*dag,\s*initialWorkflowLifecycleState\)/);
  assert.match(hook, /southstar:planner-draft-updated/);
});

test("workflow Draft uses planner SSE so slow backend work is visible", () => {
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  const stream = source("web/lib/workflow/generate-stream.ts");
  const route = source("web/app/api/workflow/planner-drafts/stream/route.ts");
  const lifecycle = source("web/lib/workflow/lifecycle.ts");

  assert.match(hook, /createPlannerDraftStream/);
  assert.match(hook, /type:\s*"draft_progress"/);
  assert.match(stream, /createPlannerDraftStream/);
  assert.match(stream, /\/api\/workflow\/planner-drafts\/stream/);
  assert.match(route, /\/api\/v2\/planner\/drafts\/stream/);
  assert.match(route, /text\/event-stream/);
  assert.match(lifecycle, /compositionPlan:\s*dag\.compositionPlan/);
  assert.doesNotMatch(hook, /fetch\("\/api\/workflow\/planner-drafts"/);
});

test("workflow Draft action surfaces streaming progress while the planner runs", () => {
  const lifecycle = source("web/lib/workflow/lifecycle.ts");
  const block = source("web/components/WorkflowDagBlock.tsx");

  assert.match(lifecycle, /type:\s*"draft_progress";\s*message:\s*string/);
  assert.match(lifecycle, /progressMessage:\s*action\.message/);
  assert.match(block, /Drafting\.\.\./);
  assert.match(block, /state\.progressMessage\s*\?\?\s*"Drafting planner resource\.\.\."/);
});

test("workflow lifecycle resets when a restored session renders a different DAG", () => {
  const lifecycle = source("web/lib/workflow/lifecycle.ts");
  const hook = source("web/hooks/useWorkflowLifecycle.ts");

  assert.match(lifecycle, /type:\s*"dag_changed"/);
  assert.match(lifecycle, /initialWorkflowLifecycleState\(action\.dag\)/);
  assert.match(hook, /dispatch\(\{\s*type:\s*"dag_changed",\s*dag\s*\}\)/);
});

test("workflow DAG node selection carries draft or run scope for profile sidecar", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");
  const shell = source("web/components/AppShell.tsx");

  assert.match(block, /nodeWithLifecycleScope/);
  assert.match(block, /draftId:\s*state\.draft\?\.draftId/);
  assert.match(block, /onNodeSelect\?\.\(nodeWithLifecycleScope\)/);
  assert.match(shell, /kind:\s*"workflowNodeProfile"/);
});

test("workflow lifecycle validates drafts with a POST action", () => {
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  assert.match(hook, /const draftId = state\.draft\?\.draftId \?\? dag\.draftId/);
  assert.match(hook, /\/api\/workflow\/planner-drafts\/\$\{encodeURIComponent\(draftId\)\}\/validate/);
  assert.match(hook, /method:\s*"POST"/);
  assert.match(hook, /"result"\s+in\s+data/);
  assert.doesNotMatch(hook, /type:\s*"validated"[\s\S]{0,180}\/orchestration/);
});

test("workflow lifecycle actions use restored DAG draft ids when reducer state is stale", () => {
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  const block = source("web/components/WorkflowDagBlock.tsx");

  assert.match(hook, /const draftId = state\.draft\?\.draftId \?\? dag\.draftId[\s\S]+validateDraft/);
  assert.match(hook, /const canRunDraft = state\.canRun \|\| Boolean\(dag\.draftId/);
  assert.match(hook, /\/api\/workflow\/planner-drafts\/\$\{encodeURIComponent\(draftId\)\}\/orchestration/);
  assert.match(hook, /\/api\/workflow\/planner-drafts\/\$\{encodeURIComponent\(draftId\)\}\/runs/);
  assert.match(block, /const canRunActiveDraft = state\.canRun \|\| Boolean\(dag\.draftId/);
  assert.match(block, /runDisabled = busy \|\| !draftReady \|\| !canRunActiveDraft/);
});

test("workflow Validate can compile restored composition plans before validation", () => {
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  const block = source("web/components/WorkflowDagBlock.tsx");

  assert.match(hook, /const createDraftFromDag = async \(\): Promise<PlannerDraftResult>/);
  assert.match(hook, /let draftId = state\.draft\?\.draftId \?\? dag\.draftId/);
  assert.match(hook, /if \(!draftId\) \{[\s\S]+const draft = await createDraftFromDag\(\);[\s\S]+draftId = draft\.draftId/);
  assert.match(block, /const canValidateActiveDag = draftReady \|\| Boolean\(dag\.compositionPlan\)/);
  assert.match(block, /validateDisabled = busy \|\| !canValidateActiveDag/);
});

test("workflow DAG actions hide primary Draft once a backend draft exists", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");
  assert.match(block, /\{!draftReady && \(/);
  assert.match(block, /Draft validated/);
  assert.match(block, /Create Run/);
  assert.match(block, /Execute/);
  assert.match(block, /Ready to run:/);
  assert.match(block, /needs validation/);
});

test("workflow Run and Execute are separate user actions", () => {
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  const block = source("web/components/WorkflowDagBlock.tsx");

  assert.match(hook, /const executeRun = async \(\) =>/);
  assert.match(hook, /return \{ state, createDraft, validateDraft, runDraft, executeRun, retryExecute \}/);
  assert.match(block, /data-testid="workflow-action-run"/);
  assert.match(block, /data-testid="workflow-action-execute"/);
  assert.match(block, /onClick=\{handleExecute\}/);
  assert.doesNotMatch(hook, /const runDraft = async \(\) => \{[\s\S]*?\/api\/workflow\/runs\/\$\{encodeURIComponent\(createdRun\.runId\)\}\/execute/);
});

test("workflow Draft action gives immediate API feedback without native confirm", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");

  assert.match(block, /const handleDraft = \(\) => \{\s*void createDraft\(\);\s*\};/);
  assert.doesNotMatch(block, /Create a Southstar planner draft in Postgres/);
  assert.doesNotMatch(block, /window\.confirm[\s\S]{0,120}createDraft/);
});

test("workflow node profile save marks its planner draft as needing validation", () => {
  const editor = source("web/components/WorkflowNodeProfileEditor.tsx");
  assert.match(editor, /southstar:planner-draft-updated/);
  assert.match(editor, /needs_validation/);
});

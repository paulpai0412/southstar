import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

const root = join(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
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
    'event: goal_contract\ndata: {"mission":{"goalContract":{"summary":"Todo app"}}}\n\n',
    'event: coverage\ndata: {"mission":{"coverage":{"covered":2,"total":2}}}\n\n',
    'event: run\ndata: {"runId":"run-1","runStatus":"scheduling"}\n\n',
    'event: approval\ndata: {"command":null}\n\n',
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
    const receipts: string[] = [];
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
      onGoalContract() {
        receipts.push("goal_contract");
      },
      onCoverage() {
        receipts.push("coverage");
      },
      onRun(run: { runId?: string }) {
        receipts.push(`run:${run.runId}`);
      },
      onApproval() {
        receipts.push("approval");
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
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    assert.match(String(body.idempotencyKey), /^[0-9a-f-]{36}$/);
    delete body.idempotencyKey;
    assert.deepEqual(body, {
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
    assert.deepEqual(receipts, ["goal_contract", "coverage", "run:run-1", "approval"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateWorkflowDagStream reports active, conflict, and streamed error stages", async () => {
  const originalFetch = global.fetch;
  try {
    for (const [status, expectedStage] of [[202, "submission.active"], [409, "submission.conflict"]] as const) {
      global.fetch = (async () => new Response(JSON.stringify({ status: status === 202 ? "processing" : "conflict" }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      const { generateWorkflowDagStream } = await import("../../web/lib/workflow/generate-stream.ts");
      const stages: string[] = [];
      await assert.rejects(
        () => generateWorkflowDagStream({
          prompt: "build",
          cwd: "/workspace/project",
          onStage(stage) { if (stage.stage) stages.push(stage.stage); },
        }),
      );
      assert.deepEqual(stages, [expectedStage]);
    }

    global.fetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: error\ndata: {"error":"planner unavailable"}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const errors: string[] = [];
    const { generateWorkflowDagStream } = await import("../../web/lib/workflow/generate-stream.ts");
    await assert.rejects(
      () => generateWorkflowDagStream({
        prompt: "build",
        cwd: "/workspace/project",
        onError(message) { errors.push(message); },
      }),
      /planner unavailable/,
    );
    assert.deepEqual(errors, ["planner unavailable"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("workflow generate proxy submits one prompt and adapts persisted mission truth", () => {
  const route = source("web/app/api/workflow/generate/route.ts");
  const readModel = source("src/v2/read-models/workflow-ui.ts");
  assert.match(route, /buildWorkflowV2Url\("\/api\/v2\/run-goal"\)/);
  assert.match(route, /goalPrompt:\s*prompt/);
  assert.match(route, /goalPrompt:\s*prompt,\s*cwd,\s*idempotencyKey,/s);
  assert.match(route, /\/api\/v2\/ui\/workflow\?/);
  assert.match(route, /buildWorkflowDagFromPlannerDraft/);
  assert.match(route, /"heartbeat"/);
  assert.match(readModel, /approvalCommands\(runId, mission\.approval\.id\)/);
  assert.doesNotMatch(route, /\/api\/v2\/planner\/drafts\/stream/);
});

test("Workflow renders Goal Contract receipt and hides launch controls until Review mode", () => {
  assert.equal(existsSync(join(root, "web/components/GoalContractCard.tsx")), true);
  const card = source("web/components/GoalContractCard.tsx");
  const block = source("web/components/WorkflowDagBlock.tsx");
  for (const token of [
    'data-testid="goal-contract-card"',
    'data-testid="goal-contract-summary"',
    'data-testid="goal-coverage-count"',
    'data-testid="goal-contract-open-details"',
    "Revise goal",
  ]) assert.match(card, new RegExp(token));
  assert.match(card, /blockingInputs\.map/);
  assert.match(card, /approvalCommand/);
  assert.doesNotMatch(card, /api\/v2\/runs\/.*approvals/);
  assert.match(block, /Review mode/);
  assert.match(block, /reviewMode \?/);
  assert.match(block, /data-testid="workflow-action-draft"/);
  assert.match(block, /data-testid="workflow-action-run"/);
  assert.match(block, /data-testid="workflow-action-execute"/);
});

test("Goal Contract opens the existing Sidecar inspector for draft or run truth", () => {
  assert.equal(existsSync(join(root, "web/components/GoalContractInspector.tsx")), true);
  const inspector = source("web/components/GoalContractInspector.tsx");
  const shell = source("web/components/AppShell.tsx");
  const tabBar = source("web/components/TabBar.tsx");
  assert.match(inspector, /data-testid="goal-contract-inspector"/);
  assert.match(inspector, /`\/api\/workflow\/ui\?draftId=\$\{encodeURIComponent\(draftId\)\}`/);
  assert.match(inspector, /`\/api\/workflow\/ui\?runId=\$\{encodeURIComponent\(runId\)\}`/);
  for (const label of ["Requirements", "Deliverables", "Boundaries", "Assumptions", "Risk", "Coverage", "Provenance"]) {
    assert.match(inspector, new RegExp(label));
  }
  assert.match(tabBar, /"workflowGoalContract"/);
  assert.match(shell, /GoalContractInspector/);
  assert.match(shell, /onGoalContractSelect/);
});

test("Workflow renders Goal Contract receipt and no launch buttons after auto scheduling", async () => {
  const dag = scheduledDagWithMission();
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock dag={${JSON.stringify(dag)}} cwd="/workspace/project" />);
  `, async (page) => {
    await page.locator('[data-testid="goal-contract-card"]').waitFor();
    assert.match(await page.locator('[data-testid="goal-contract-summary"]').textContent() ?? "", /offline HTML article/);
    assert.equal(await page.locator('[data-testid="workflow-action-draft"]').count(), 0);
    assert.equal(await page.locator('[data-testid="workflow-action-run"]').count(), 0);
    assert.equal(await page.locator('[data-testid="workflow-action-execute"]').count(), 0);
    assert.match(await page.locator('[data-testid="goal-coverage-count"]').textContent() ?? "", /2\/2/);
    await page.locator(".workflow-review-mode-toggle").click();
    assert.equal(await page.locator('[data-testid="workflow-action-run"]').count(), 1);
    assert.equal(await page.locator('[data-testid="workflow-action-execute"]').count(), 1);
  });
});

test("Goal Contract card opens the existing Sidecar inspector", async () => {
  const dag = scheduledDagWithMission();
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    import { GoalContractInspector } from "./web/components/GoalContractInspector";
    const dag = ${JSON.stringify(dag)};
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><WorkflowDagBlock dag={dag} cwd="/workspace/project" onGoalContractSelect={() => setOpen(true)} />{open ? <aside data-testid="sidecar"><GoalContractInspector runId={dag.runId} /></aside> : null}</>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.route("**/api/workflow/ui?**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { mission: dag.mission, commands: [] } }) });
    });
    await page.locator('[data-testid="goal-contract-open-details"]').click();
    await page.locator('[data-testid="goal-contract-inspector"]').waitFor();
    assert.match(await page.locator('[data-testid="goal-contract-requirements"]').textContent() ?? "", /opens without network access/);
  });
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
  assert.match(sourceText, /display:\s*mentionVisible \? "inline-flex" : "none"/);
  assert.match(sourceText, /tabIndex=\{mentionVisible \? 0 : -1\}/);
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

function scheduledDagWithMission() {
  const requirements = [
    { id: "req-offline", statement: "Works offline", acceptanceCriteria: ["opens without network access"], blocking: true, source: "explicit" },
    { id: "req-share", statement: "Can be shared", acceptanceCriteria: ["is a single HTML file"], blocking: true, source: "explicit" },
  ];
  return {
    id: "draft-article",
    draftId: "draft-article",
    draftStatus: "validated",
    runId: "run-article",
    runStatus: "scheduling",
    mode: "runtime",
    mission: {
      goalContract: {
        schemaVersion: "southstar.goal_contract.v1",
        originalPrompt: "Create an offline HTML article",
        promptHash: "prompt-hash",
        revision: 1,
        workspace: { cwd: "/workspace/project" },
        domain: "software",
        intent: "create_article",
        summary: "Create an offline HTML article",
        requirements,
        expectedArtifactRefs: ["article.html"],
        requiredCapabilities: ["web-authoring"],
        nonGoals: ["No hosted service"],
        assumptions: ["Modern browser"],
        blockingInputs: [],
        riskTags: [],
        requestedSideEffects: [],
      },
      goalContractHash: "contract-hash",
      coverage: {
        covered: 2,
        total: 2,
        failedRequirementIds: [],
        entries: requirements.map((requirement) => ({
          requirementId: requirement.id,
          producerTaskIds: ["article"],
          artifactRefs: ["article.html"],
          evaluatorTaskIds: ["verify"],
          evaluatorProfileRefs: ["evaluator.html"],
          requiredEvidenceKinds: ["artifact-ref"],
        })),
      },
      status: { execution: "scheduling", outcome: "in_progress", health: "healthy" },
      approval: null,
      evaluatorResults: [],
      blockers: [],
      provenance: { originalPrompt: "Create an offline HTML article", revision: 1, promptHash: "prompt-hash" },
    },
    templateId: "template.article",
    templateTitle: "Offline article",
    prompt: "Create an offline HTML article",
    expandedByDefault: true,
    readiness: "ready",
    nodes: [],
    edges: [],
    createdAt: "2026-07-11T00:00:00.000Z",
  };
}

async function withBrowserHarness(
  entry: string,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const dir = join(tmpdir(), `southstar-goal-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const outfile = join(dir, "bundle.js");
  await build({
    stdin: {
      contents: entry,
      resolveDir: root,
      sourcefile: "goal-contract-harness.tsx",
      loader: "tsx",
    },
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    plugins: [reactAliasPlugin(), webAliasPlugin()],
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  try {
    const script = await readFile(outfile, "utf8");
    await page.route("http://southstar.test/", async (route) => {
      await route.fulfill({ contentType: "text/html", body: `<main id="root"></main><script>${script}</script>` });
    });
    await page.goto("http://southstar.test/");
    await run(page);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function reactAliasPlugin() {
  return {
    name: "react-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^react$/ }, () => ({ path: join(root, "node_modules/react/index.js") }));
      buildApi.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: join(root, "node_modules/react/jsx-runtime.js") }));
      buildApi.onResolve({ filter: /^react-dom\/client$/ }, () => ({ path: join(root, "node_modules/react-dom/client.js") }));
    },
  };
}

function webAliasPlugin() {
  return {
    name: "web-alias",
    setup(buildApi: any) {
      buildApi.onResolve({ filter: /^@\// }, (args: any) => resolveWebPath(args.path.slice(2)));
    },
  };
}

function resolveWebPath(path: string): { path: string } {
  const base = join(root, "web", path);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      return { path: require.resolve(candidate) };
    } catch {
      // Try the next extension.
    }
  }
  return { path: base };
}

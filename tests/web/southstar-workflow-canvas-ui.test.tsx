import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { register } from "node:module";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createSouthstarApiClient } from "../../lib/southstar/api-client.ts";
import { buildAgentLibraryCandidatesReadModelPg, buildAgentLibraryReadModelPg } from "../../src/v2/read-models/agent-library.ts";

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

test("Workflow mode renders DAG blocks while the workflow stream is still active", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  assert.match(hook, /onDag\(dag\) \{\s*generatedDag = dag;\s*updateStreamingMessage\(\);\s*\}/s);
  assert.match(hook, /content:\s*\[\s*\.\.\.\(streamedText[\s\S]+type:\s*"workflowDag"/);
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

test("shared workflow canvas uses React Flow and ELK", () => {
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /@xyflow\/react/);
  assert.match(source("components/southstar/workflow-canvas/layout.ts"), /elkjs\/lib\/elk\.bundled\.js/);
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /MiniMap/);
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /Controls/);
  assert.match(source("components/southstar/workflow-canvas/SouthstarWorkflowCanvas.tsx"), /Background/);
});

test("workflow canvas centralizes node and edge status colors", () => {
  const colors = source("components/southstar/workflow-canvas/colors.ts");
  for (const token of ["pending", "ready", "active", "satisfied", "queued", "scheduling", "running", "completed", "passed", "paused", "blocked", "exception", "failed", "cancelled"]) {
    assert.match(colors, new RegExp(token));
  }
  assert.match(colors, /normalizeWorkflowStatus/);
  assert.match(colors, /statusColorFor/);
});

test("workflow task node renders agent library badges", () => {
  const node = source("components/southstar/workflow-canvas/WorkflowTaskNode.tsx");
  assert.match(node, /roleRef/);
  assert.match(node, /agentProfileRef/);
  assert.match(node, /artifactKind/);
  assert.match(node, /badges/);
  assert.match(node, /attention/);
  assert.match(node, /attention\.severity/);
  assert.match(node, /attention\.reason/);
});

test("workflow canvas model preserves the shared graph contract through conversion and layout", async () => {
  const workbenchModule = await import("../../components/southstar/workflow/WorkflowWorkbench.tsx");
  const canvasModule = await import("../../components/southstar/workflow-canvas/layout.ts");
  assert.equal(typeof (workbenchModule as any).toCanvasModel, "function");
  const canvas = (workbenchModule as any).toCanvasModel({
    canvasModel: {
      graphId: "draft-graph-contract",
      mode: "draft",
      selectedNodeId: "task-build",
      nodes: [{
        id: "task-plan",
        label: "Plan",
        kind: "task",
        status: "satisfied",
        dependsOn: [],
        badges: [{ label: "artifact accepted", tone: "good" }],
      }, {
        id: "task-build",
        label: "Build",
        kind: "task",
        status: "active",
        dependsOn: ["task-plan"],
        badges: [{ label: "executor running", tone: "neutral" }],
        attention: { severity: "warning", reason: "approval pending" },
      }],
      edges: [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "active" }],
    },
  });

  assert.equal(canvas.graphId, "draft-graph-contract");
  assert.equal(canvas.mode, "draft");
  assert.equal(canvas.selectedNodeId, "task-build");
  assert.equal(canvas.nodes[1]?.kind, "task");
  assert.deepEqual(canvas.nodes[1]?.attention, { severity: "warning", reason: "approval pending" });
  assert.deepEqual(canvas.edges, [{ id: "task-plan->task-build", source: "task-plan", target: "task-build", status: "active" }]);

  const flow = await canvasModule.buildWorkflowFlowLayout({ canvas, selectedTaskId: canvas.selectedNodeId });
  assert.equal(flow.nodes.find((node: { id: string }) => node.id === "task-build")?.data.selected, true);
  assert.equal(flow.edges[0]?.source, "task-plan");
  assert.equal(flow.edges[0]?.target, "task-build");
  assert.equal(flow.edges[0]?.data?.status, "active");
});

test("workflow workbench includes structured planner inputs and data-driven create or revise wiring", () => {
  const workbench = source("components/southstar/workflow/WorkflowWorkbench.tsx");
  assert.match(workbench, /domainPackId/);
  assert.match(workbench, /cwd/);
  assert.match(workbench, /orchestrationMode/);
  assert.match(workbench, /composerMode/);
  assert.match(workbench, /libraryHints/);
  assert.match(workbench, /api\.createDraft/);
  assert.match(workbench, /api\.reviseDraft/);
});

test("southstar api client posts the structured planner draft request contract", async () => {
  const request = {
    goalPrompt: "implement calc sum",
    orchestrationMode: "llm-constrained" as const,
    composerMode: "fixture" as const,
    domainPackId: "software",
    cwd: "/workspace/southstar",
    libraryHints: {
      roleRefs: ["agent.software-maker"],
      agentProfileRefs: ["profile.software-maker-pi"],
      skillRefs: ["skill.software-implementation"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      toolRefs: ["tool.workspace-read", "tool.shell-command"],
      modelHints: { maker: "gpt-5" },
      vaultLeasePolicyRefs: ["vault.github-write-token"],
      toolPolicyHints: {
        allowedTools: ["read", "search", "shell"],
        deniedTools: ["write"],
        requiresApprovalFor: ["network"],
      },
    },
  };
  const receivedBodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    receivedBodies.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      result: {
        draftId: "draft-test",
        goalPrompt: request.goalPrompt,
        workflowId: "wf-test",
        status: "validated",
        validationIssues: [],
        taskSummaries: [],
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    const api = createSouthstarApiClient({ baseUrl: `http://127.0.0.1:${address.port}` });
    await api.createDraft(request);
    assert.deepEqual(receivedBodies, [request]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("workflow workbench separates essential planner inputs from collapsible structured hints", () => {
  const workbench = source("components/southstar/workflow/WorkflowWorkbench.tsx");
  for (const token of [
    "workflow-goal",
    "workflow-domain-pack-id",
    "workflow-cwd",
    "workflow-orchestration-mode",
    "workflow-composer-mode",
  ]) {
    assert.match(workbench, new RegExp(token));
  }
  assert.match(workbench, /ss-planner-advanced-hints/);
  assert.match(workbench, /Advanced structured hints/);
  for (const token of [
    "workflow-role-refs",
    "workflow-agent-profile-refs",
    "workflow-skill-refs",
    "workflow-mcp-grant-refs",
    "workflow-tool-refs",
    "workflow-model-hints",
    "workflow-vault-lease-policy-refs",
    "workflow-tool-policy-hints",
  ]) {
    assert.match(workbench, new RegExp(token));
  }
  assert.doesNotMatch(workbench, /plannerHints/);
  assert.doesNotMatch(workbench, /buildPlannerPrompt/);
});

test("workflow workbench renders planner inputs with Agent Library in the left panel", () => {
  const markup = renderToStaticMarkup(React.createElement(awaitWorkflowWorkbench(), {
    api: inertApi,
    activeCwd: "/workspace/southstar",
    onOpenOperator() {},
  }));
  const leftPanelStart = markup.indexOf('<section class="ss-workflow-planner-panel"');
  const centerStart = markup.indexOf('<section class="ss-workflow-center"');
  assert.notEqual(leftPanelStart, -1);
  assert.notEqual(centerStart, -1);
  assert.ok(leftPanelStart < centerStart);

  const leftPanel = markup.slice(leftPanelStart, centerStart);
  assert.match(leftPanel, /id="workflow-goal"/);
  assert.match(leftPanel, /id="workflow-domain-pack-id"/);
  assert.match(leftPanel, /id="workflow-cwd"/);
  assert.match(leftPanel, /<h2>Agent Library<\/h2>/);
  assert.match(leftPanel, /<details class="ss-planner-advanced-hints"><summary>Advanced structured hints<\/summary>/);
  assert.doesNotMatch(leftPanel, /<details[^>]*\sopen(?:=|>|\s)/);

  const center = markup.slice(centerStart);
  assert.match(center, /Workflow DAG/);
  assert.doesNotMatch(center, /id="workflow-goal"/);
  assert.doesNotMatch(center, /<h2>Agent Library<\/h2>/);
});

test("definition inspector renders validation repair planner trace and revise action", () => {
  const inspector = source("components/southstar/workflow/DefinitionInspector.tsx");
  assert.match(inspector, /Validation issues/i);
  assert.match(inspector, /Repair attempts/i);
  assert.match(inspector, /Planner trace refs/i);
  assert.match(inspector, /onReviseDraft/);
  assert.match(inspector, /Revise draft/);
});

test("definition inspector renders materialized role profile policy artifact evaluator trace and repair detail", async () => {
  const { DefinitionInspector } = await import("../../components/southstar/workflow/DefinitionInspector.tsx");
  const markup = renderToStaticMarkup(React.createElement(DefinitionInspector, {
    task: {
      id: "implement",
      label: "Implement",
      kind: "task",
      status: "ready",
      dependsOn: ["understand"],
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      artifactKind: "implementation_report",
      badges: [{ label: "validation passed", tone: "good" }],
    },
    inspector: {
      taskId: "implement",
      taskName: "Implement",
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      skillRefs: ["software.calc-cli"],
      mcpGrantRefs: ["filesystem-workspace"],
      toolGrantRefs: ["read", "search", "edit", "shell"],
      roleDefinition: {
        id: "maker",
        responsibility: "Edit the workspace and produce implementation evidence.",
        defaultAgentProfileRef: "software-maker-pi",
        artifactOutputs: ["implementation_report"],
        stopAuthority: "none",
      },
      agentProfile: {
        id: "software-maker-pi",
        name: "Software Maker Pi",
        provider: "pi",
        model: "pi-agent-default",
        contextPolicyRef: "software-context-default",
        toolPolicy: { allowedTools: ["read", "search", "edit", "shell"], deniedTools: ["network-write"], requiresApprovalFor: ["external-write"] },
      },
      vaultPolicy: {
        id: "vault.github-write-token",
        displayName: "GitHub Write Token Vault Lease",
        leaseTtlSeconds: 900,
        auditRequired: true,
      },
      artifactContract: {
        id: "implementation_report",
        artifactType: "implementation-report",
        requiredFields: ["summary", "filesChanged", "commandsRun"],
      },
      evaluatorPipeline: {
        id: "software-feature-quality",
        evaluators: [{ id: "schema", kind: "schema", required: true }],
        onFailure: { defaultStrategy: "rollback-workspace" },
      },
      contextPolicy: {
        id: "software-context-default",
        maxInputTokens: 20000,
        memoryPolicyRef: "software-memory-default",
      },
    },
    plannerRationale: "Use maker then checker.",
    validationIssues: [{ path: "workflow.tasks[0]", message: "fixed by repair", code: "missing-evaluator" }],
    repairAttempts: 1,
    repairAttemptDetails: [{ attempt: 1, reason: "missing evaluator pipeline", status: "repaired", traceRef: "planner.repair:1" }],
    plannerTraceRefs: { manifestRef: "planner.manifest_generated:123" },
    onRunDraft() {},
    onReviseDraft() {},
    runDisabled: false,
    running: false,
    reviseDisabled: false,
    revising: false,
  } as any));

  for (const expected of [
    "Edit the workspace and produce implementation evidence.",
    "Software Maker Pi",
    "pi-agent-default",
    "GitHub Write Token Vault Lease",
    "implementation-report",
    "software-feature-quality",
    "rollback-workspace",
    "software-context-default",
    "software-memory-default",
    "missing evaluator pipeline",
    "planner.repair:1",
    "planner.manifest_generated:123",
  ]) {
    assert.match(markup, new RegExp(escapeRegExp(expected)));
  }
});

test("agent library panel renders policy context memory and candidate reasons from model", () => {
  const panel = source("components/southstar/workflow/AgentLibraryPanel.tsx");
  assert.match(panel, /agentLibrarySummary/);
  assert.match(panel, /selectedDefinition/);
  assert.match(panel, /contextMemory/i);
  assert.match(panel, /selectionReasons|candidateReasons/);
  assert.match(panel, /toolGrantRefs|mcpGrantRefs|skillRefs/);
  assert.doesNotMatch(panel, /Southstar will select agents/);
});

test("agent library panel renders full catalog and policy rows from the read model contract", async () => {
  const library = await buildAgentLibraryReadModelPg({} as any, { domain: "software" });
  const { AgentLibraryPanel } = await import("../../components/southstar/workflow/AgentLibraryPanel.tsx");
  const markup = renderToStaticMarkup(React.createElement(AgentLibraryPanel, {
    model: {
      agentLibrary: library,
      selectedDefinition: {
        taskId: "implement",
        taskName: "Implement task",
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        skillRefs: ["software.calc-cli"],
        mcpGrantRefs: ["filesystem-workspace"],
        toolGrantRefs: ["read", "search", "edit", "shell"],
      },
      selectionReasons: ["task implement is pinned to profile software-maker-pi"],
      contextMemory: { refs: ["memory:project-pattern"] },
    },
    activeCwd: "/workspace/southstar",
    selectedTaskId: "implement",
    onOpenAlternatives() {},
    alternativesDisabled: false,
  }));

  for (const expected of [
    "explorer",
    "Inspect the repository and create an implementation plan.",
    "software-maker-pi",
    "Software Maker Pi",
    "pi-agent-default",
    "software.calc-cli",
    "filesystem-workspace",
    "shell",
    "implementation_plan",
    "summary",
    "software-feature-quality",
    "rollback-workspace",
    "software-context-default",
    "software-memory-default",
    "software-session-default",
    "software-git-workspace",
    "vault.github-write-token",
    "GitHub Write Token Vault Lease",
    "memory:project-pattern",
    "task implement is pinned to profile software-maker-pi",
  ]) {
    assert.match(markup, new RegExp(escapeRegExp(expected)));
  }
});

test("workflow workbench fetches full agent library and passes it to the panel", async () => {
  const workflowResponse = {
    activeDraft: {
      draftId: "draft-agent-library-full",
      workflowId: "wf-agent-library-full",
      goalPrompt: "implement calc sum",
      status: "validated",
    },
    canvasModel: {
      mode: "draft",
      selectedNodeId: "implement",
      nodes: [{
        id: "implement",
        label: "Implement",
        status: "draft",
        dependsOn: [],
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        sortOrder: 0,
      }],
      edges: [],
    },
    selectedDefinition: {
      taskId: "implement",
      taskName: "Implement",
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      skillRefs: ["software.calc-cli"],
      mcpGrantRefs: ["filesystem-workspace"],
      toolGrantRefs: ["read", "search", "edit", "shell"],
    },
    agentLibrarySummary: {
      domain: "software",
      roleCount: 4,
      agentProfileCount: 6,
      skillCount: 1,
      mcpServerCount: 1,
      toolCount: 4,
      artifactContractCount: 4,
      evaluatorPipelineCount: 4,
    },
    validationIssues: [],
    repairAttempts: 0,
    commands: [],
  };
  const library = await buildAgentLibraryReadModelPg({} as any, { domain: "software" });
  const calls: unknown[] = [];
  const api = {
    ...inertApi,
    getUiWorkflowTab: async (params: unknown) => {
      calls.push(["workflow", params]);
      return workflowResponse;
    },
    getAgentLibrary: async (params: unknown) => {
      calls.push(["library", params]);
      return library;
    },
  };
  const workbenchModule = await import("../../components/southstar/workflow/WorkflowWorkbench.tsx");
  assert.equal(typeof (workbenchModule as any).loadWorkflowWorkbenchModel, "function");

  const initialWorkflowModel = await (workbenchModule as any).loadWorkflowWorkbenchModel(api, {
    draftId: "draft-agent-library-full",
  });
  assert.deepEqual(calls, [
    ["workflow", { draftId: "draft-agent-library-full", runId: undefined }],
    ["library", { domain: "software" }],
  ]);

  const markup = renderToStaticMarkup(React.createElement(workbenchModule.WorkflowWorkbench, {
    api,
    activeCwd: "/workspace/southstar",
    initialDraftId: "draft-agent-library-full",
    initialWorkflowModel,
    onOpenOperator() {},
  } as any));

  assert.match(markup, /Software Maker Pi/);
  assert.match(markup, /GitHub Write Token Vault Lease/);
  assert.doesNotMatch(markup, /No profiles available/);
  assert.doesNotMatch(markup, /No vault policies available/);
});

test("workflow workbench keeps workflow model when full agent library enrichment fails", async () => {
  const workflowResponse = {
    activeDraft: {
      draftId: "draft-agent-library-degraded",
      workflowId: "wf-agent-library-degraded",
      goalPrompt: "implement calc sum",
      status: "validated",
    },
    canvasModel: {
      mode: "draft",
      selectedNodeId: "implement",
      nodes: [{
        id: "implement",
        label: "Implement",
        status: "draft",
        dependsOn: [],
        roleRef: "maker",
        agentProfileRef: "software-maker-pi",
        sortOrder: 0,
      }],
      edges: [],
    },
    selectedDefinition: {
      taskId: "implement",
      taskName: "Implement",
      roleRef: "maker",
      agentProfileRef: "software-maker-pi",
      skillRefs: ["software.calc-cli"],
      mcpGrantRefs: ["filesystem-workspace"],
      toolGrantRefs: ["read", "search", "edit", "shell"],
    },
    agentLibrarySummary: {
      domain: "software",
      roleCount: 4,
      agentProfileCount: 6,
      skillCount: 1,
      mcpServerCount: 1,
      toolCount: 4,
      artifactContractCount: 4,
      evaluatorPipelineCount: 4,
    },
    validationIssues: [],
    repairAttempts: 0,
    commands: [],
  };
  const calls: unknown[] = [];
  const api = {
    ...inertApi,
    getUiWorkflowTab: async (params: unknown) => {
      calls.push(["workflow", params]);
      return workflowResponse;
    },
    getAgentLibrary: async (params: unknown) => {
      calls.push(["library", params]);
      throw new Error("agent library unavailable");
    },
  };
  const workbenchModule = await import("../../components/southstar/workflow/WorkflowWorkbench.tsx");

  const initialWorkflowModel = await (workbenchModule as any).loadWorkflowWorkbenchModel(api, {
    draftId: "draft-agent-library-degraded",
  });
  assert.deepEqual(calls, [
    ["workflow", { draftId: "draft-agent-library-degraded", runId: undefined }],
    ["library", { domain: "software" }],
  ]);
  assert.equal(initialWorkflowModel.activeDraft.draftId, workflowResponse.activeDraft.draftId);
  assert.equal(initialWorkflowModel.agentLibrary, undefined);
  assert.equal(initialWorkflowModel.agentLibraryError, "agent library unavailable");

  const markup = renderToStaticMarkup(React.createElement(workbenchModule.WorkflowWorkbench, {
    api,
    activeCwd: "/workspace/southstar",
    initialDraftId: "draft-agent-library-degraded",
    initialWorkflowModel,
    onOpenOperator() {},
  } as any));

  assert.match(markup, /Workflow DAG/);
  assert.match(markup, /Agent Library degraded: agent library unavailable/);
});

test("library alternatives sheet renders candidates read model as prompt review context", async () => {
  const model = await buildAgentLibraryCandidatesReadModelPg({
    maybeOne: async () => ({
      payload_json: {
        workflow: {
          domain: "software",
          tasks: [{
            id: "implement",
            roleRef: "maker",
            agentProfileRef: "software-maker-pi",
            skillRefs: ["software.calc-cli"],
            mcpGrantRefs: ["filesystem-workspace"],
            toolGrantRefs: ["read", "search", "edit", "shell"],
          }],
        },
      },
    }),
  } as any, { draftId: "draft-agent-library", taskId: "implement" });
  const { LibraryAlternativesSheet } = await import("../../components/southstar/workflow/LibraryAlternativesSheet.tsx");
  const markup = renderToStaticMarkup(React.createElement(LibraryAlternativesSheet, {
    model,
    onClose() {},
  }));

  for (const expected of [
    "maker",
    "software-maker-pi",
    "software.calc-cli",
    "filesystem-workspace",
    "shell",
    "task implement is assigned role maker",
  ]) {
    assert.match(markup, new RegExp(escapeRegExp(expected)));
  }
  assert.doesNotMatch(markup, /Apply|Update workflow|Mutate|Save selection/);
});

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const inertApi = {
  createDraft: async () => ({ draftId: "draft-test" }),
  reviseDraft: async () => ({ draftId: "draft-revised" }),
  runDraft: async () => ({ runId: "run-test" }),
  getRun: async () => ({}),
  getTask: async () => ({}),
  getTaskEnvelope: async () => ({}),
  getUiPlanner: async () => ({}),
  getUiWorkflowTab: async () => ({}),
  getUiWorkflow: async () => ({}),
  getUiOperationsTab: async () => ({}),
  getUiLibraryAlternatives: async () => ({}),
  getAgentLibrary: async () => ({}),
  getAgentLibraryCandidates: async () => ({}),
  getUiOperatorOverview: async () => ({}),
  getUiOperatorAttention: async () => ({}),
  getUiWorkflowCanvas: async () => ({}),
  getUiRuntimeMonitor: async () => ({}),
  getUiTaskDetail: async () => ({}),
  getUiSessionsMemory: async () => ({}),
  getUiWorktree: async () => ({}),
  getUiExecutor: async () => ({}),
  getUiDomainPacks: async () => ({}),
  getUiGovernance: async () => ({}),
  command: async () => ({}),
  steer: async () => ({}),
  voiceTranscript: async () => ({}),
} as any;

let workflowWorkbenchComponent: React.ComponentType<any> | null = null;

function awaitWorkflowWorkbench(): React.ComponentType<any> {
  if (!workflowWorkbenchComponent) {
    throw new Error("WorkflowWorkbench was not loaded before render");
  }
  return workflowWorkbenchComponent;
}

test.before(async () => {
  register(
    "data:text/javascript,export async function load(url, context, nextLoad) { if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: '' }; return nextLoad(url, context); }",
    import.meta.url,
  );
  workflowWorkbenchComponent = (await import("../../components/southstar/workflow/WorkflowWorkbench.tsx")).WorkflowWorkbench;
});

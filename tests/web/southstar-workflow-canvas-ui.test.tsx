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

test("Requirement list uses one stateful primary action for recheck and confirmation", () => {
  const block = source("web/components/GoalRequirementListBlock.tsx");
  assert.match(block, /hasUnresolvedClarifications/);
  assert.match(block, /primaryAction/);
  assert.match(block, /data-testid=\{primaryAction\.testId\}/);
  assert.doesNotMatch(block, /data-testid="goal-requirement-resolve"/);
  assert.doesNotMatch(block, /data-testid="goal-requirements-confirm"/);
});

test("Requirement priority label does not masquerade as an unresolved blocker", () => {
  const block = source("web/components/GoalRequirementListBlock.tsx");
  const editor = source("web/components/GoalRequirementEditor.tsx");
  assert.match(block, />required<|} required/);
  assert.doesNotMatch(block, />blocking</);
  assert.match(editor, /required for goal/);
});

test("Session sidebar defers cwd-dependent New button state until hydration", () => {
  const sidebar = source("web/components/SessionSidebar.tsx");
  assert.match(sidebar, /const \[hydrated, setHydrated\] = useState\(false\)/);
  assert.match(sidebar, /disabled=\{hydrated \? !selectedCwd : undefined\}/);
});

test("planner draft revision proxy forwards heartbeat frames", () => {
  const route = source("web/app/api/workflow/planner-drafts/[draftId]/revise/stream/route.ts");
  assert.match(route, /\["message", "message\.delta", "planner\.stage", "heartbeat"/);
});

test("generateWorkflowDagStream parses POST SSE message deltas and DAG payloads", async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const chunks = [
    'event: message\ndata: {"text":"Creating planner draft"}\n\n',
    'event: message.delta\ndata: {"text":"Loading orchestration"}\n\n',
    'event: planner.stage\ndata: {"stage":"composer.started","message":"Streaming LLM workflow composition."}\n\n',
    'event: heartbeat\ndata: {"phase":"composing","elapsedMs":1200}\n\n',
    'event: draft\ndata: {"draft":{"draftId":"draft-1","status":"validated"}}\n\n',
    'event: goal_design\ndata: {"draftId":"draft-1","goalDesignPackageHash":"hash-1","package":{"slicePlan":{"slices":[{"id":"slice-a","outcome":"A"}]}}}\n\n',
    'event: goal_contract\ndata: {"mission":{"goalContract":{"summary":"Todo app"}}}\n\n',
    'event: coverage\ndata: {"mission":{"coverage":{"covered":2,"total":2}}}\n\n',
    'event: run\ndata: {"runId":"run-1","runStatus":"scheduling"}\n\n',
    'event: execution_set\ndata: {"executionSetId":"set-1","sliceRuns":[{"sliceId":"slice-a","runId":"run-a","runStatus":"scheduling","approvalId":"approval-a"}]}\n\n',
    'event: approval\ndata: {"command":null}\n\n',
    'event: recoverable\ndata: {"result":{"draftId":"draft-1","runId":"run-1"},"error":"read model unavailable"}\n\n',
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
      goalDesignMode: "review_before_compose",
      templatePolicy: { mode: "prefer", templateRef: "template.software-feature", versionRef: "template.software-feature@v1" },
      onMessage(text: string, event: string) {
        events.push(`${event}:${text}`);
      },
      onStage(stage: { stage?: string; message?: string }) {
        events.push(`stage:${stage.stage}:${stage.message}`);
      },
      onHeartbeat(heartbeat: { phase?: string }) {
        events.push(`heartbeat:${heartbeat.phase}`);
      },
      onDraft(draft: { draftId?: string }) {
        events.push(`draft:${draft.draftId}`);
      },
      onGoalDesign(goalDesign: { draftId?: string; package?: { slicePlan?: { slices?: Array<{ id?: string }> } } }) {
        receipts.push(`goal_design:${goalDesign.draftId}:${goalDesign.package?.slicePlan?.slices?.[0]?.id}`);
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
      onExecutionSet(executionSet: { executionSetId?: string; sliceRuns?: Array<{ sliceId?: string }> }) {
        receipts.push(`execution_set:${executionSet.executionSetId}:${executionSet.sliceRuns?.[0]?.sliceId}`);
      },
      onApproval() {
        receipts.push("approval");
      },
      onRecoverable(result: { result?: { draftId?: string; runId?: string } }) {
        receipts.push(`recoverable:${result.result?.draftId}:${result.result?.runId}`);
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
      goalDesignMode: "review_before_compose",
      templatePolicy: { mode: "prefer", templateRef: "template.software-feature", versionRef: "template.software-feature@v1" },
    });
    assert.deepEqual(events, [
      "message:Creating planner draft",
      "message.delta:Loading orchestration",
      "stage:composer.started:Streaming LLM workflow composition.",
      "heartbeat:composing",
      "draft:draft-1",
      "done",
    ]);
    assert.equal(dagId, "draft-1");
    assert.deepEqual(receipts, ["goal_design:draft-1:slice-a", "goal_contract", "coverage", "run:run-1", "execution_set:set-1:slice-a", "approval", "recoverable:draft-1:run-1"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("current Goal Design mutation snapshot comes from the host draft", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({ result: {
    draftId: "draft-goal-1:slice-revision:child",
    status: "ready_for_review",
    goalDesignPhase: "slice_review",
    goalDesignPackageHash: "current-hash",
    goalDesignPackage: { revision: 3, packageHash: "current-hash" },
  } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const { readCurrentGoalDesignDraft } = await import("../../web/lib/workflow/goal-design-draft.ts");
    const current = await readCurrentGoalDesignDraft("draft-goal-1:slice-revision:child");
    assert.equal(current.goalDesignPackageHash, "current-hash");
    assert.equal((current.goalDesignPackage as { revision: number }).revision, 3);
    assert.equal(current.goalDesignPhase, "slice_review");
  } finally {
    global.fetch = originalFetch;
  }
});

test("saved Goal Design projection persists the complete current snapshot", async () => {
  const { goalDesignContentFromSelection } = await import("../../web/lib/workflow/goal-design-draft.ts");
  const packageValue = { revision: 4, packageHash: "current-hash", slicePlan: { slices: [] } };
  const requirementDraft = {
    schemaVersion: "southstar.goal_requirement_draft.v2" as const,
    revision: 2,
    originalPrompt: "Review the current slice",
    workspace: { cwd: "/tmp/project" },
    summary: "A reviewable slice",
    requirements: [],
    nonGoals: [],
    blockingInputs: [],
    draftHash: "requirement-hash",
  };
  const content = goalDesignContentFromSelection({
    draftId: "draft-goal-1:slice-revision:child",
    status: "ready_for_review",
    goalDesignPhase: "slice_review",
    goalDesignPackageHash: "current-hash",
    selectedSliceId: "slice-review",
    package: packageValue,
    requirementDraft,
  });
  assert.equal(content.type, "goalDesign");
  assert.equal(content.goalDesignPackageHash, "current-hash");
  assert.deepEqual(content.package, packageValue);
  assert.equal(content.goalRequirementDraftHash, "requirement-hash");
  assert.equal(content.selectedSliceId, "slice-review");
});

test("generateWorkflowDagStream reuses an explicit idempotency key for recoverable retries", async () => {
  const originalFetch = global.fetch;
  const keys: string[] = [];
  global.fetch = (async (_url, init) => {
    keys.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).idempotencyKey));
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: recoverable\ndata: {"result":{"draftId":"draft-recover","runId":"run-recover"},"error":"enrichment failed"}\n\nevent: done\ndata: {"draftId":"draft-recover","runId":"run-recover"}\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const { generateWorkflowDagStream } = await import("../../web/lib/workflow/generate-stream.ts");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await generateWorkflowDagStream({
        prompt: "recover this goal",
        cwd: "/workspace/project",
        idempotencyKey: "stable-submission-key",
      });
    }
    assert.deepEqual(keys, ["stable-submission-key", "stable-submission-key"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateWorkflowDagStream forwards goal_requirements SSE events", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: goal_requirements\ndata: {"draftId":"draft-goal-1","status":"requirements_review","phase":"requirements_review","confirmable":true,"validationIssues":[],"goalRequirementDraftHash":"hash-1","package":{"goalRequirementDraft":{"schemaVersion":"southstar.goal_requirement_draft.v2","revision":1,"originalPrompt":"Review","workspace":{"cwd":"/workspace"},"summary":"Review","requirements":[],"nonGoals":[],"blockingInputs":[],"draftHash":"hash-1"}}}\n\nevent: done\ndata: {}\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
  try {
    const { generateWorkflowDagStream } = await import("../../web/lib/workflow/generate-stream.ts");
    const received: string[] = [];
    await generateWorkflowDagStream({ prompt: "Review", onGoalRequirements(value) { received.push(String(value.draftId)); } });
    assert.deepEqual(received, ["draft-goal-1"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("workflow generate proxy preserves terminal identity when enrichment fails", async () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.SOUTHSTAR_V2_API_BASE_URL;
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://runtime.test";
  global.fetch = (async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v2/run-goal") {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: done\ndata: {"draftId":"draft-terminal","draftStatus":"validated","runId":"run-terminal","runStatus":"scheduling"}\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (pathname.includes("/orchestration")) return new Response("read model unavailable", { status: 503 });
    return new Response(JSON.stringify({ result: { mission: null, commands: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const { POST } = await import("../../web/app/api/workflow/generate/route.ts");
    const response = await POST(new Request("http://southstar.test/api/workflow/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "build", cwd: "/workspace/project", idempotencyKey: "stable-key" }),
    }) as never);
    const stream = await response.text();
    assert.match(stream, /event: draft\ndata: .*draft-terminal/);
    assert.match(stream, /event: run\ndata: .*run-terminal/);
    assert.match(stream, /event: recoverable\ndata: .*read model unavailable/);
    assert.match(stream, /event: done\ndata: .*run-terminal/);
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.SOUTHSTAR_V2_API_BASE_URL;
    else process.env.SOUTHSTAR_V2_API_BASE_URL = originalBaseUrl;
  }
});

test("workflow generate proxy replay fallback preserves host requirement blockers", async () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.SOUTHSTAR_V2_API_BASE_URL;
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://runtime.test";
  global.fetch = (async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v2/run-goal") {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({
            draftId: "draft-replay",
            draftStatus: "requirements_review",
            goalRequirementDraftId: "draft-replay",
            goalRequirementDraftHash: "hash-replay",
            goalDesignPhase: "requirements_review",
            goalRequirementDraft: { schemaVersion: "southstar.goal_requirement_draft.v2", revision: 1, draftHash: "hash-replay" },
            confirmable: false,
            validationIssues: [],
            blockers: ["host blocker survives replay"],
          })}\n\n`));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const { POST } = await import("../../web/app/api/workflow/generate/route.ts");
    const response = await POST(new Request("http://southstar.test/api/workflow/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "replay", cwd: "/workspace/project", idempotencyKey: "replay-key" }),
    }) as never);
    const stream = await response.text();
    assert.match(stream, /event: goal_requirements/);
    assert.match(stream, /host blocker survives replay/);
    assert.doesNotMatch(stream, /"blockers":\[\]/);
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.SOUTHSTAR_V2_API_BASE_URL;
    else process.env.SOUTHSTAR_V2_API_BASE_URL = originalBaseUrl;
  }
});

test("workflow generate proxy does not enrich requirement review into an empty DAG", async () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.SOUTHSTAR_V2_API_BASE_URL;
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://runtime.test";
  const requirementResult = {
    draftId: "draft-requirements",
    draftStatus: "requirements_review",
    goalRequirementDraftId: "draft-requirements",
    goalRequirementDraftHash: "hash-requirements",
    goalDesignPhase: "requirements_review",
    goalRequirementDraft: {
      schemaVersion: "southstar.goal_requirement_draft.v2",
      revision: 1,
      draftHash: "hash-requirements",
      requirements: [],
    },
    confirmable: true,
    validationIssues: [],
    blockers: [],
  };
  global.fetch = (async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v2/run-goal") {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            `event: goal_requirements\ndata: ${JSON.stringify({
              draftId: requirementResult.draftId,
              status: requirementResult.draftStatus,
              phase: requirementResult.goalDesignPhase,
              goalRequirementDraftHash: requirementResult.goalRequirementDraftHash,
              package: requirementResult,
              confirmable: true,
              validationIssues: [],
            })}\n\nevent: done\ndata: ${JSON.stringify(requirementResult)}\n\n`,
          ));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`requirement review must not request workflow enrichment: ${url}`);
  }) as typeof fetch;
  try {
    const { POST } = await import("../../web/app/api/workflow/generate/route.ts");
    const response = await POST(new Request("http://southstar.test/api/workflow/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "review requirements", cwd: "/workspace/project", idempotencyKey: "requirements-key" }),
    }) as never);
    const stream = await response.text();
    assert.match(stream, /event: goal_requirements/);
    assert.match(stream, /event: done/);
    assert.doesNotMatch(stream, /event: dag/);
    assert.doesNotMatch(stream, /event: recoverable/);
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.SOUTHSTAR_V2_API_BASE_URL;
    else process.env.SOUTHSTAR_V2_API_BASE_URL = originalBaseUrl;
  }
});

test("workflow generate proxy forwards Goal Design controls without browser skill execution", async () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.SOUTHSTAR_V2_API_BASE_URL;
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://runtime.test";
  const upstreamBodies: Record<string, unknown>[] = [];
  global.fetch = (async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v2/run-goal") {
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: done\ndata: {"draftId":"draft-review","draftStatus":"ready_for_review","goalDesignPackageHash":"abc123"}\n\n'));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const { POST } = await import("../../web/app/api/workflow/generate/route.ts");
    const response = await POST(new Request("http://southstar.test/api/workflow/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "build",
        cwd: "/workspace/project",
        idempotencyKey: "stable-key",
        goalDesignMode: "review_before_compose",
        templatePolicy: { mode: "require", templateRef: "template.software", versionRef: "template.software@v1" },
      }),
    }) as never);
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBodies[0], {
      goalPrompt: "build",
      cwd: "/workspace/project",
      idempotencyKey: "stable-key",
      goalDesignMode: "review_before_compose",
      templatePolicy: { mode: "require", templateRef: "template.software", versionRef: "template.software@v1" },
    });
    const route = source("web/app/api/workflow/generate/route.ts");
    assert.doesNotMatch(route, /southstar-goal-design\.skill|loadGoalDesignSkillPg|designGoalWithLlm/);
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.SOUTHSTAR_V2_API_BASE_URL;
    else process.env.SOUTHSTAR_V2_API_BASE_URL = originalBaseUrl;
  }
});

test("workflow generate proxy maps unexpected 2xx non-SSE to 502 while preserving 202 and 409", async () => {
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.SOUTHSTAR_V2_API_BASE_URL;
  process.env.SOUTHSTAR_V2_API_BASE_URL = "http://runtime.test";
  try {
    const { POST } = await import("../../web/app/api/workflow/generate/route.ts");
    for (const [upstreamStatus, expectedStatus] of [[200, 502], [202, 202], [409, 409]] as const) {
      global.fetch = (async () => new Response(JSON.stringify({ status: "not-streaming" }), {
        status: upstreamStatus,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      const response = await POST(new Request("http://southstar.test/api/workflow/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "build", cwd: "/workspace/project", idempotencyKey: "stable-key" }),
      }) as never);
      assert.equal(response.status, expectedStatus, `upstream ${upstreamStatus}`);
    }
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.SOUTHSTAR_V2_API_BASE_URL;
    else process.env.SOUTHSTAR_V2_API_BASE_URL = originalBaseUrl;
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

test("generateWorkflowDagStream preserves structured Library readiness diagnostics", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({
    error: "library_not_ready",
    message: "Library reconciliation has not produced a ready snapshot",
    diagnostics: [{
      code: "required_purpose_cardinality",
      message: "expected exactly one approved goal_design skill, found 0",
      fatal: true,
      paths: [],
      missingRefs: [],
    }],
  }), { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch;

  try {
    const { generateWorkflowDagStream, WorkflowGenerateHttpError } = await import("../../web/lib/workflow/generate-stream.ts");
    await assert.rejects(
      () => generateWorkflowDagStream({ prompt: "Build a vocabulary app", cwd: "/workspace/project" }),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowGenerateHttpError);
        assert.equal(error.status, 503);
        assert.equal(error.code, "library_not_ready");
        assert.equal(error.message, "Library reconciliation has not produced a ready snapshot");
        assert.deepEqual(error.diagnostics, [{
          code: "required_purpose_cardinality",
          message: "expected exactly one approved goal_design skill, found 0",
          fatal: true,
          paths: [],
          missingRefs: [],
        }]);
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("Workflow chat maps Library readiness errors to actionable guidance", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  assert.match(hook, /WorkflowGenerateHttpError/);
  assert.match(hook, /Library is not ready: \$\{e\.message\}\. Open Library to review and sync diagnostics, then retry this Goal\./);
  assert.match(hook, /content:\s*\[\{ type: "text", text: failure \}\]/);
  assert.doesNotMatch(hook, /content:\s*\[\{ type: "text", text: `Workflow generation failed: \$\{message\}` \}\]/);
});

test("Workflow chat explains Library readiness failures", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { ChatWindow } from "./web/components/ChatWindow";
    (globalThis as typeof globalThis & { process?: { env?: Record<string, string> } }).process = { env: {} };
    if (typeof crypto.randomUUID !== "function") {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => "00000000-0000-4000-8000-000000000001" });
    }
    createRoot(document.getElementById("root")).render(
      <ChatWindow session={null} newSessionCwd="/workspace/project" workflowMode workflowCwd="/workspace/project" />
    );
  `, async (page) => {
    await page.route("**/api/models**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: {}, modelList: [] }) });
    });
    await page.route("**/api/agent/new", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessionId: "workflow-test-session" }) });
    });
    await page.route("**/api/workflow/generate", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "library_not_ready",
          message: "Library reconciliation has not produced a ready snapshot",
          diagnostics: [{ code: "required_purpose_cardinality", message: "expected exactly one approved goal_design skill, found 0", fatal: true, paths: [], missingRefs: [] }],
        }),
      });
    });

    const input = page.getByPlaceholder("Message… Type / for commands");
    await input.fill("Build a vocabulary app");
    const workflowRequest = page.waitForRequest("**/api/workflow/generate", { timeout: 5_000 });
    await page.getByRole("button", { name: "Send" }).click();
    await workflowRequest;
    const body = page.locator("body");
    await body.getByText(/Library is not ready/i).first().waitFor({ timeout: 5_000 });
    const text = await body.textContent() ?? "";
    assert.match(text, /Open Library to review and sync diagnostics/);
    assert.doesNotMatch(text, /Workflow generation failed: \{/);
  });
});

test("workflow generate proxy submits one prompt and adapts persisted mission truth", () => {
  const route = source("web/app/api/workflow/generate/route.ts");
  const readModel = source("src/v2/read-models/workflow-ui.ts");
  assert.match(route, /buildWorkflowV2Url\("\/api\/v2\/run-goal"\)/);
  assert.match(route, /goalPrompt:\s*prompt/);
  assert.match(route, /goalPrompt:\s*prompt,[\s\S]*?cwd,\s*idempotencyKey,/s);
  assert.match(route, /body\.sessionId/);
  assert.match(route, /\/api\/v2\/ui\/workflow\?/);
  assert.match(route, /projectWorkflowUiReadModel/);
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
    'data-testid="goal-requirement-chain"',
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

test("Workflow Execute stays disabled while Goal execution approval is pending", async () => {
  const dag = awaitingApprovalDag();
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock dag={${JSON.stringify(dag)}} cwd="/workspace/project" />);
  `, async (page) => {
    await page.locator('.workflow-review-mode-toggle').click();
    const execute = page.locator('[data-testid="workflow-action-execute"]');
    await execute.waitFor();
    assert.equal(await execute.isEnabled(), false);
    assert.equal(await page.locator('[data-testid="goal-contract-approve"]').isEnabled(), true);
  });
});

test("planner draft stream keeps the original Goal Design flow", () => {
  const sourceText = source("src/v2/server/planner-routes.ts");
  const start = sourceText.indexOf("function createPlannerDraftStreamResponse");
  const end = sourceText.indexOf("function createPlannerDraftRevisionStreamResponse", start);
  assert.ok(start >= 0 && end > start);
  const stream = sourceText.slice(start, end);
  assert.match(stream, /submitGoalPg/);
  assert.doesNotMatch(stream, /createPostgresPlannerDraft/);
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
    await expandWorkflowDag(page);
    await Promise.race([
      page.locator('[data-testid="goal-contract-card"]').waitFor(),
      page.waitForEvent("pageerror").then((error) => { throw error; }),
    ]);
    assert.match(await page.locator('[data-testid="goal-contract-summary"]').textContent() ?? "", /offline HTML article/);
    assert.equal(await page.locator('[data-testid="workflow-action-draft"]').count(), 0);
    assert.equal(await page.locator('[data-testid="workflow-action-run"]').count(), 0);
    assert.equal(await page.locator('[data-testid="workflow-action-execute"]').count(), 0);
    assert.match(await page.locator('[data-testid="goal-coverage-count"]').textContent() ?? "", /2\/2/);
    assert.equal(await page.locator('[data-testid="goal-requirement-chain"]').count(), 1);
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
    await expandWorkflowDag(page);
    await page.locator('[data-testid="goal-contract-open-details"]').click();
    await page.locator('[data-testid="goal-contract-inspector"]').waitFor();
    assert.match(await page.locator('[data-testid="goal-contract-requirements"]').textContent() ?? "", /opens without network access/);
  });
});

test("Goal Contract clarification choice carries the selected value into a focused prefilled input", async () => {
  const dag = scheduledDagWithMission();
  dag.mission.goalContract.blockingInputs = ["Use PostgreSQL", "Use SQLite"];
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /handleWorkflowGoalRevise[\s\S]*insertText\(/);
  assert.doesNotMatch(shell, /handleWorkflowGoalRevise[\s\S]{0,500}insertIfEmpty\(/);
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    const dag = ${JSON.stringify(dag)};
    function Harness() {
      const [value, setValue] = useState("Existing goal notes");
      return <><WorkflowDagBlock dag={dag} cwd="/workspace/project" onReviseGoal={(_dag, choice) => {
        setValue((current) => current + " · " + choice);
        requestAnimationFrame(() => document.querySelector("textarea")?.focus());
      }} /><textarea value={value} readOnly /></>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await expandWorkflowDag(page);
    await page.getByRole("button", { name: "Use SQLite" }).click();
    assert.equal(await page.locator("textarea").inputValue(), "Existing goal notes · Use SQLite");
    assert.equal(await page.locator("textarea").evaluate((element) => element === document.activeElement), true);
  });
});

test("Goal Contract approval guards double-click and refreshes persisted mission once", async () => {
  const dag = awaitingApprovalDag();
  const pendingRoutes: import("playwright").Route[] = [];
  let signalCommandStarted!: () => void;
  const commandStarted = new Promise<void>((resolve) => { signalCommandStarted = resolve; });
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    const dag = ${JSON.stringify(dag)};
    window.missionRefreshes = 0;
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock
      dag={dag}
      cwd="/workspace/project"
      onMissionRefresh={async () => {
        window.missionRefreshes += 1;
        return { ...dag.mission, approval: { ...dag.mission.approval, status: "approved" } };
      }}
    />);
  `, async (page) => {
    await page.route("**/api/operator/command", async (route) => {
      pendingRoutes.push(route);
      signalCommandStarted();
    });
    await expandWorkflowDag(page);
    await page.getByRole("button", { name: "Approve" }).waitFor();
    await page.evaluate(`
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: function () { return "00000000-0000-4000-8000-000000000001"; } });
    `);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("textbox", { name: "Reason for Approve" }).fill("approved by operator");
    await page.locator('[data-testid="goal-contract-confirm-approval"]').evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await commandStarted;
    await page.evaluate("new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); })");
    assert.equal(pendingRoutes.length, 1, "double click must create one deferred command request");
    for (const route of pendingRoutes) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          kind: "approval-decision",
          result: { id: "approval-mission", status: "approved", runStatus: "scheduling" },
        }),
      });
    }
    await page.locator('[aria-live="polite"]').filter({ hasText: "Approved" }).waitFor({ timeout: 1_000 });
    assert.equal(await page.evaluate(() => window.missionRefreshes), 1);
    assert.equal(await page.getByRole("button", { name: "Approve" }).count(), 0);
    assert.match(await page.locator('[aria-live="polite"]').textContent() ?? "", /Approved/);
  });
});

test("accepted Goal Contract approval stays completed when persisted mission refresh fails", async () => {
  const dag = awaitingApprovalDag();
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    const dag = ${JSON.stringify(dag)};
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock
      dag={dag}
      cwd="/workspace/project"
      onMissionRefresh={async () => { throw new Error("mission refresh unavailable"); }}
    />);
  `, async (page) => {
    await page.route("**/api/operator/command", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
    });
    await expandWorkflowDag(page);
    await page.evaluate(`
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: function () { return "00000000-0000-4000-8000-000000000003"; } });
    `);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("textbox", { name: "Reason for Approve" }).fill("approve");
    await page.locator('[data-testid="goal-contract-confirm-approval"]').click();
    await page.locator('[aria-live="polite"]').filter({ hasText: "Approved" }).waitFor({ timeout: 1_000 });
    assert.equal(await page.getByRole("button", { name: "Approve" }).count(), 0);
    assert.match(await page.locator('[aria-live="polite"]').textContent() ?? "", /refresh unavailable/);
  });
});

test("Goal Contract approval failure restores retry and a later success refreshes mission", async () => {
  const dag = awaitingApprovalDag();
  let calls = 0;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    const dag = ${JSON.stringify(dag)};
    window.missionRefreshes = 0;
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock
      dag={dag}
      cwd="/workspace/project"
      onMissionRefresh={async () => {
        window.missionRefreshes += 1;
        return { ...dag.mission, approval: { ...dag.mission.approval, status: "approved" } };
      }}
    />);
  `, async (page) => {
    await page.route("**/api/operator/command", async (route) => {
      calls += 1;
      if (calls === 1) await route.fulfill({ status: 500, body: "failed" });
      else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
    });
    await expandWorkflowDag(page);
    await page.evaluate(`
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: function () { return "00000000-0000-4000-8000-000000000002"; } });
    `);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("textbox", { name: "Reason for Approve" }).fill("retry");
    await page.locator('[data-testid="goal-contract-confirm-approval"]').click();
    await page.locator('[aria-live="polite"]').filter({ hasText: "failed" }).waitFor({ timeout: 1_000 });
    assert.equal(await page.locator('[data-testid="goal-contract-confirm-approval"]').isEnabled(), true);
    await page.locator('[data-testid="goal-contract-confirm-approval"]').click();
    await page.waitForFunction(() => window.missionRefreshes === 1, undefined, { timeout: 1_000 });
    assert.equal(calls, 2);
  });
});

test("Goal Contract inspector refresh generation refetches the same run", async () => {
  const mission = scheduledDagWithMission().mission;
  let requests = 0;
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalContractInspector } from "./web/components/GoalContractInspector";
    function Harness() {
      const [refreshKey, setRefreshKey] = useState(0);
      return <><button data-testid="refresh" onClick={() => setRefreshKey((value) => value + 1)}>Refresh</button><GoalContractInspector runId="run-article" refreshKey={refreshKey} /></>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.route("**/api/workflow/ui?**", async (route) => {
      requests += 1;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { mission: { ...mission, goalContract: { ...mission.goalContract, summary: "Revision " + requests } }, commands: [] } }) });
    });
    const summary = page.locator('[data-testid="goal-contract-inspector"] > header strong');
    await summary.filter({ hasText: "Revision 1" }).waitFor();
    await page.locator('[data-testid="refresh"]').click();
    await summary.filter({ hasText: "Revision 2" }).waitFor({ timeout: 1_000 });
    assert.equal(requests, 2);
  });
  const shell = source("web/components/AppShell.tsx");
  assert.match(shell, /refreshKey/);
  assert.match(shell, /workflowGoalContract[\s\S]{0,800}refreshKey/);
});

test("Goal Contract inspector renders failed coverage and evaluator evidence details", async () => {
  const mission = scheduledDagWithMission().mission;
  mission.coverage.failedRequirementIds = ["req-offline"];
  mission.evaluatorResults = [{
    schemaVersion: "southstar.requirement_evaluator_result.v1",
    requirementIds: ["req-offline"],
    artifactRefs: ["artifact://article.html"],
    evaluatorId: "html-evaluator",
    evaluatorTaskId: "verify-html",
    evaluatorProfileRef: "evaluator.html",
    verdict: "failed",
    evidenceRefs: ["evidence://offline-check"],
    findings: ["Network request remained"],
  }];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalContractInspector } from "./web/components/GoalContractInspector";
    createRoot(document.getElementById("root")).render(<GoalContractInspector runId="run-article" />);
  `, async (page) => {
    await page.route("**/api/workflow/ui?**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { mission, commands: [] } }) });
    });
    const evidence = page.locator('[data-testid="goal-contract-evaluator-evidence"]');
    await evidence.waitFor({ timeout: 1_000 });
    const text = await evidence.textContent() ?? "";
    for (const expected of ["req-offline", "article.html", "verify", "evaluator.html", "html-evaluator", "failed", "offline-check", "Network request remained"]) {
      assert.match(text, new RegExp(expected));
    }
  });
});

test("Goal Contract inspector renders coverage matrix without duplicating the Workspace graph", async () => {
  const mission = scheduledDagWithMission().mission;
  mission.evaluatorResults = [{
    requirementIds: ["req-offline"],
    artifactRefs: ["artifact://article.html"],
    evaluatorTaskId: "verify-html",
    evaluatorProfileRef: "evaluator.html",
    evidenceRefs: ["evidence://offline-check"],
    verdict: "passed",
  }];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalContractInspector } from "./web/components/GoalContractInspector";
    createRoot(document.getElementById("root")).render(<GoalContractInspector runId="run-article" />);
  `, async (page) => {
    await page.route("**/api/workflow/ui?**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: {
        mission,
        lineage: {
          slicePlan: {
            revision: 2,
            goalContractHash: "contract-hash",
            slices: [{
              id: "slice-main",
              requirementIds: ["req-offline"],
              outcome: "Build the offline article",
              expectedArtifactRefs: ["artifact://article.html"],
              evaluatorContractRefs: ["evaluator.html"],
              dependsOnSliceIds: [],
              dependencyArtifactRefs: [],
            }],
          },
          workflowDag: {
            id: "run-article",
            mode: "runtime",
            taskIds: ["task-build"],
            edges: [],
          },
          tasks: [{
            id: "task-build",
            label: "Build article",
            status: "completed",
            sliceId: "slice-main",
            requirementIds: ["req-offline"],
            dependsOn: [],
            purpose: "Build the offline article",
            nodeType: "implement",
            expectedOutputs: ["artifact://article.html"],
            roleRef: "builder",
            agentProfileRef: "builder-codex",
          }],
        },
        commands: [],
      } }) });
    });
    const matrix = page.locator('[data-testid="goal-contract-coverage-matrix"]');
    await matrix.waitFor({ timeout: 5_000 });
    assert.match(await matrix.locator('[data-testid="goal-contract-coverage-row-req-offline"]').textContent() ?? "", /Works offline|slice-main|Build article|article\.html|offline-check|verify-html|Complete/);
    assert.equal(await page.locator('[data-testid="goal-contract-coverage-graph"]').count(), 0);
  });
});

test("Goal Contract inspector distinguishes pending runtime evidence from missing design binding", async () => {
  const mission = scheduledDagWithMission().mission;
  mission.coverage.entries[0].artifactContractRefs = ["artifact.article"];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalContractInspector } from "./web/components/GoalContractInspector";
    createRoot(document.getElementById("root")).render(<GoalContractInspector runId="run-article" />);
  `, async (page) => {
    await page.route("**/api/workflow/ui?**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { mission, commands: [] } }) });
    });
    const matrix = page.locator('[data-testid="goal-contract-coverage-matrix"]');
    await matrix.waitFor({ timeout: 5_000 });
    const row = matrix.locator('[data-testid="goal-contract-coverage-row-req-offline"]');
    assert.match(await row.textContent() ?? "", /Awaiting runtime evidence/);
    assert.doesNotMatch(await row.textContent() ?? "", /Missing binding/);
  });
});

test("Goal Contract workspace card uses readable deliverables, scope, and action styles", () => {
  const card = source("web/components/GoalContractCard.tsx");
  const styles = source("web/app/globals.css");
  assert.match(card, /useLibraryObjectDetails/);
  assert.match(card, /describeContractDeliverable/);
  assert.match(card, /Effort \/ scope/);
  assert.match(card, /describeRiskTag/);
  assert.match(card, /goal-contract-action-primary/);
  assert.match(styles, /goal-contract-action-primary/);
});

test("Goal Contract inspector renders an inline error without an identity", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalContractInspector } from "./web/components/GoalContractInspector";
    createRoot(document.getElementById("root")).render(<GoalContractInspector />);
  `, async (page) => {
    const inspector = page.locator('[data-testid="goal-contract-inspector"]');
    await inspector.waitFor({ timeout: 1_000 });
    assert.match(await inspector.textContent() ?? "", /draftId or runId is required/);
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

test("web workflow DAG block expands by default", () => {
  const block = source("web/components/WorkflowDagBlock.tsx");
  assert.match(block, /const \[expanded, setExpanded\] = useState<boolean>\(dag\.expandedByDefault \?\? true\);/);
  assert.doesNotMatch(block, /useState<boolean>\(false\)/);
});

test("workflow ChatWindow focuses the latest composed DAG result", () => {
  const chat = source("web/components/ChatWindow.tsx");
  assert.match(chat, /latestWorkflowDagKey/);
  assert.match(chat, /workflow-dag-block/);
  assert.match(chat, /scrollIntoView\(\{ behavior: "instant", block: "start" \}\)/);
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

test("workflow canvas lays out collapsed nodes shorter and wires their toggle", async () => {
  const { buildWorkflowFlowLayout } = await import("../../web/components/workflow-canvas/layout.ts");
  let toggled = "";
  const flow = await buildWorkflowFlowLayout({
    canvas: {
      graphId: "collapsible-dag",
      mode: "draft",
      nodes: [
        { id: "plan", label: "Plan", kind: "task", status: "ready", dependsOn: [], badges: [] },
        { id: "verify", label: "Verify", kind: "task", status: "ready", dependsOn: ["plan"], badges: [] },
      ],
      edges: [],
    },
    selectedTaskId: null,
    collapsedTaskIds: new Set(["plan"]),
    onToggleCollapse: (taskId) => { toggled = taskId; },
  });
  const plan = flow.nodes.find((node) => node.id === "plan")!;
  const verify = flow.nodes.find((node) => node.id === "verify")!;
  assert.equal(plan.data.collapsed, true);
  assert.equal(verify.data.collapsed, false);
  assert.ok((plan.height ?? Infinity) < (verify.height ?? 0));
  plan.data.onToggleCollapse?.("plan");
  assert.equal(toggled, "plan");
});

test("workflow canvas defaults every node collapsed and keeps important summary fields visible", () => {
  const canvas = source("web/components/workflow-canvas/SouthstarWorkflowCanvas.tsx");
  const node = source("web/components/workflow-canvas/WorkflowTaskNode.tsx");
  assert.match(canvas, /useState<Set<string>>\(\s*\(\) => new Set\(props\.canvas\.nodes\.map\(\(node\) => node\.id\)\),?\s*\)/);
  assert.match(canvas, /collapsedGraphIdRef/);
  assert.match(canvas, /props\.canvas\.nodes\.length === 0/);
  assert.match(node, /ss-flow-node-collapsed-summary/);
  assert.match(node, /data-node-field=\"nodeType\"/);
  assert.match(node, /data-node-field=\"requirementIds\"/);
  assert.match(node, /data-node-field=\"expectedOutputs\"/);
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
      mission: { goalContract: { domain: "software" } },
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
    status: "draft",
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
      mission: { goalContract: { domain: "software" } },
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
  assert.doesNotMatch(lifecycle, /compositionPlan:\s*dag\.compositionPlan/);
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

test("workflow Validate requires the original backend draft before validation", () => {
  const hook = source("web/hooks/useWorkflowLifecycle.ts");
  const block = source("web/components/WorkflowDagBlock.tsx");

  assert.match(hook, /const createDraftFromDag = async \(\): Promise<PlannerDraftResult>/);
  assert.match(hook, /let draftId = state\.draft\?\.draftId \?\? dag\.draftId/);
  assert.match(hook, /if \(!draftId\) \{[\s\S]+const draft = await createDraftFromDag\(\);[\s\S]+draftId = draft\.draftId/);
  assert.match(block, /const canValidateActiveDag = draftReady/);
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

test("Requirement block renders coverage state and opens the existing sidecar editor", async () => {
  const draft = requirementDraftView();
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    const draft = ${JSON.stringify(draft)};
    function Harness() {
      const [selection, setSelection] = useState(null);
      return <><GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, coveragePreview: [{ requirementId: "req-review", status: "missing", missingKinds: ["evaluator"] }] }} onRequirementSelect={setSelection} />{selection ? <aside data-testid="sidecar"><GoalRequirementEditor selection={selection} /></aside> : null}</>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.getByText("Review flow").waitFor();
    assert.match(await page.locator('[data-testid="goal-requirement-item-req-review"]').textContent() ?? "", /missing/);
    const criterion = await page.getByTestId("goal-requirement-criterion-criterion-review").innerText();
    assert.match(criterion, /A completed review is persisted/);
    assert.match(criterion, /Required/);
    assert.match(criterion, /Deterministic/);
    assert.match(criterion, /Query the current review record/);
    await page.locator('[data-testid="goal-requirement-item-req-review"]').click();
    await page.locator('[data-testid="sidecar"] [data-testid="goal-requirement-editor"]').waitFor();
    assert.match(await page.locator('[data-testid="sidecar"]').textContent() ?? "", /Review flow/);
  });
});

test("Requirement block renders a missing Criterion assurance without crashing", async () => {
  const draft = requirementDraftView();
  delete (draft.requirements[0]!.acceptanceCriteria[0] as { requiredAssurance?: unknown }).requiredAssurance;
  delete (draft.requirements[0]!.acceptanceCriteria[0] as { verificationIntent?: unknown }).verificationIntent;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false }} />);
  `, async (page) => {
    const criterion = page.getByTestId("goal-requirement-criterion-criterion-review");
    await criterion.waitFor();
    assert.match(await criterion.innerText(), /Assurance: not recorded/);
    assert.match(await criterion.innerText(), /Verification: not recorded/);
  });
});

test("Requirement block shows the exact blockers and open questions that must be resolved", async () => {
  const draft = requirementDraftView();
  draft.blockingInputs = ["Which project scope should be used?"];
  draft.requirements[0]!.openQuestions = ["Should progress be stored locally or remotely? Options: A) locally; B) remotely"];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: true, validationIssues: [{ path: "blockingInputs", code: "blocking_inputs_unresolved", message: "blocking inputs must be resolved before confirmation" }] }} />);
  `, async (page) => {
    assert.match(await page.locator('[data-testid="goal-requirement-blockers"]').textContent() ?? "", /Which project scope should be used\?/);
    assert.match(await page.locator('[data-testid="goal-requirement-questions-req-review"]').textContent() ?? "", /Should progress be stored locally or remotely\?/);
    assert.equal(await page.locator('[data-testid="goal-requirement-question-answer-req-review-0"]').getAttribute("rows"), "2");
    assert.equal(await page.locator('[data-testid="goal-requirement-resolve"]').count(), 1);
    assert.equal(await page.locator('[data-testid="goal-requirements-confirm"]').count(), 0);
  });
});

test("Requirement block explains the visual contract gate when requirements are otherwise clear", async () => {
  const draft = requirementDraftView();
  draft.requirements[0]!.interactionContractRefs = ["ic-review"];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [{ path: "requirements.0.interactionContractRefs.0", code: "unconfirmed_ui_interaction_contract", message: "UI interaction contract is not confirmed: ic-review" }] }} />);
  `, async (page) => {
    assert.match(await page.locator('[data-testid="goal-requirements-block"]').textContent() ?? "", /Review each visual contract and confirm it before confirming requirements/);
    assert.equal(await page.locator('[data-testid="goal-requirements-confirm"]').isDisabled(), true);
  });
});

test("Requirement block applies host readiness updates without resetting the displayed draft", async () => {
  const draft = requirementDraftView();
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    function Harness() {
      const [confirmable, setConfirmable] = useState(false);
      return <main>
        <button data-testid="host-readiness" type="button" onClick={() => setConfirmable(true)}>Host confirms visual contract</button>
        <GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable, validationIssues: confirmable ? [] : [{ path: "requirements.0.interactionContractRefs.0", code: "unconfirmed_ui_interaction_contract", message: "UI interaction contract is not confirmed" }] }} />
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    const confirm = page.locator('[data-testid="goal-requirements-confirm"]');
    assert.equal(await confirm.isDisabled(), true);
    await page.getByTestId("host-readiness").click();
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-testid="goal-requirements-confirm"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    assert.equal(await confirm.isDisabled(), false);
  });
});

test("Requirement block resolves goal blockers through a structured UI answer and revision", async () => {
  const draft = requirementDraftView();
  draft.blockingInputs = ["Which project scope should be used?"];
  draft.requirements[0]!.openQuestions = ["Should progress be stored locally or remotely? Options: A) locally; B) remotely"];
  const revisedDraft = { ...draft, revision: 2, draftHash: "hash-2", blockingInputs: [], requirements: draft.requirements.map((item) => ({ ...item, openQuestions: [] })) };
  let requestBody: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    const revisedDraft = ${JSON.stringify(revisedDraft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [{ path: "blockingInputs", code: "blocking_inputs_unresolved", message: "blocking inputs must be resolved before confirmation" }] }} />);
  `, async (page) => {
    await page.locator('[data-testid="goal-requirement-blocker-answer-0"]').fill("Use the current workspace project only.");
    await page.locator('[data-testid="goal-requirement-question-answer-req-review-0"]').fill("B");
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/revise/stream", async (route) => {
      requestBody = JSON.parse(route.request().postData() ?? "{}");
      const payload = {
        draftId: "draft-goal-1",
        status: "requirements_review",
        phase: "requirements_review",
        goalRequirementDraftHash: "hash-2",
        goalRequirementDraft: revisedDraft,
        confirmable: true,
        validationIssues: [],
      };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: goal_requirements\ndata: ${JSON.stringify(payload)}\n\nevent: done\ndata: {}\n\n`,
      });
    });
    await page.locator('[data-testid="goal-requirement-resolve"]').click();
    await page.getByText("clarification clear").waitFor();
    assert.equal(await page.locator('[data-testid="goal-requirement-blockers"]').count(), 0);
    assert.equal(await page.locator('[data-testid="goal-requirements-confirm"]').isDisabled(), false);
    assert.equal(requestBody?.expectedDraftHash, "hash-1");
    assert.deepEqual(requestBody?.selectedRequirementIds, ["req-review"]);
    assert.match(String(requestBody?.prompt), /Use the current workspace project only\./);
    assert.match(String(requestBody?.prompt), /Should progress be stored locally or remotely/);
    assert.match(String(requestBody?.prompt), /Answer: B/);
    assert.match(String(requestBody?.prompt), /clarification-only revision/);
  });
});

test("Requirement block reconciles the persisted revision when the revise stream omits its Goal Requirements frame", async () => {
  const draft = requirementDraftView();
  draft.blockingInputs = ["Which project scope should be used?"];
  const revisedDraft = { ...draft, revision: 2, draftHash: "hash-2", blockingInputs: [] };
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    const revisedDraft = ${JSON.stringify(revisedDraft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [{ path: "blockingInputs", code: "blocking_inputs_unresolved", message: "blocking inputs must be resolved before confirmation" }] }} />);
  `, async (page) => {
    await page.locator('[data-testid="goal-requirement-blocker-answer-0"]').fill("Use the current workspace project only.");
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/revise/stream", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: done\\ndata: {}\\n\\n" });
    });
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/orchestration", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", goalDesignPhase: "requirements_review", goalRequirementDraftHash: "hash-2", goalRequirementDraft: revisedDraft, confirmable: true, validationIssues: [] } }),
      });
    });
    await page.locator('[data-testid="goal-requirement-resolve"]').click();
    await page.getByText("clarification clear").waitFor();
    assert.equal(await page.locator('[data-testid="goal-requirement-blockers"]').count(), 0);
  });
});

test("Requirement block reconciles a persisted revision after a revise stream error", async () => {
  const draft = requirementDraftView();
  draft.blockingInputs = ["Which project scope should be used?"];
  const revisedDraft = { ...draft, revision: 2, draftHash: "hash-2", blockingInputs: [] };
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    const revisedDraft = ${JSON.stringify(revisedDraft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [{ path: "blockingInputs", code: "blocking_inputs_unresolved", message: "blocking inputs must be resolved before confirmation" }] }} />);
  `, async (page) => {
    await page.locator('[data-testid="goal-requirement-blocker-answer-0"]').fill("Use the current workspace project only.");
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/revise/stream", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: error\\ndata: {"error":"upstream stream ended after persistence"}\\n\\n' });
    });
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/orchestration", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", goalDesignPhase: "requirements_review", goalRequirementDraftHash: "hash-2", goalRequirementDraft: revisedDraft, confirmable: true, validationIssues: [] } }),
      });
    });
    await page.locator('[data-testid="goal-requirement-resolve"]').click();
    await page.getByText("clarification clear").waitFor();
    assert.equal(await page.locator('[data-testid="goal-requirement-blockers"]').count(), 0);
  });
});

test("Requirement block hydrates a newer persisted revision when the session replays an old block", async () => {
  const draft = requirementDraftView();
  draft.blockingInputs = ["Which project scope should be used?"];
  const revisedDraft = { ...draft, revision: 2, draftHash: "hash-2", blockingInputs: [] };
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [{ path: "blockingInputs", code: "blocking_inputs_unresolved", message: "blocking inputs must be resolved before confirmation" }] }} />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/orchestration", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", goalDesignPhase: "requirements_review", goalRequirementDraftHash: "hash-2", goalRequirementDraft: revisedDraft, confirmable: true, validationIssues: [] } }),
      });
    });
    await page.reload();
    await page.getByText("clarification clear").waitFor();
    assert.equal(await page.locator('[data-testid="goal-requirement-blockers"]').count(), 0);
  });
});

test("Requirement block promotes an authoritative slice review during session rehydration", async () => {
  const draft = requirementDraftView();
  const packageValue = { slicePlan: { slices: [{ id: "slice-review", outcome: "Review the flow" }] } };
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    function Harness() {
      const [resumed, setResumed] = useState(false);
      return <main>
        <GoalRequirementListBlock
          block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "validation_ready", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [] }}
          onGoalValidationResume={() => setResumed(true)}
        />
        <div data-testid="resume-state">{resumed ? "resumed" : "waiting"}</div>
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/orchestration", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: {
          draftId: "draft-goal-1",
          status: "ready_for_review",
          goalDesignPhase: "slice_review",
          goalDesignPackageHash: "slice-hash",
          goalDesignPackage: packageValue,
          goalRequirementDraftHash: "hash-1",
          goalRequirementDraft: draft,
          confirmable: false,
          validationIssues: [],
        } }),
      });
    });
    await page.getByTestId("resume-state").waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="resume-state"]')?.textContent === "resumed");
    assert.equal(await page.getByText("Slice Plan is ready below. Continue with Confirm & Compose DAG.", { exact: true }).count(), 1);
  });
});

test("Requirement open questions have a compact answer and recheck flow", async () => {
  const draft = requirementDraftView();
  draft.requirements[0]!.blocking = false;
  draft.requirements[0]!.openQuestions = ["Which progress source is authoritative? Options: A) local; B) remote"];
  const revisedDraft = { ...draft, revision: 2, draftHash: "hash-2", requirements: draft.requirements.map((item) => ({ ...item, openQuestions: [] })) };
  let requestBody: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    const revisedDraft = ${JSON.stringify(revisedDraft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: true }} />);
  `, async (page) => {
    assert.equal(await page.locator('[data-testid="goal-requirement-open-question-resolution"]').count(), 1);
    await page.locator('[data-testid="goal-requirement-question-answer-req-review-0"]').fill("A");
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/revise/stream", async (route) => {
      requestBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `event: goal_requirements\ndata: ${JSON.stringify({ draftId: "draft-goal-1", status: "requirements_review", phase: "requirements_review", goalRequirementDraftHash: "hash-2", goalRequirementDraft: revisedDraft, confirmable: true, validationIssues: [] })}\n\nevent: done\ndata: {}\n\n`,
      });
    });
    await page.locator('[data-testid="goal-requirement-resolve"]').click();
    await page.getByText("clarification clear").waitFor();
    assert.equal(requestBody?.expectedDraftHash, "hash-1");
    assert.match(String(requestBody?.prompt), /Answer: A/);
  });
});

test("visual requirement opens the existing sidecar with structured screen and state controls", async () => {
  const draft = requirementDraftView();
  draft.requirements[0]!.interactionContractRefs = ["ui-review"];
  const contract = {
    schemaVersion: "southstar.ui_interaction_contract.v2",
    id: "ui-review",
    revision: 2,
    parentRevision: 1,
    status: "confirmed",
    requirementIds: ["req-review"],
    screens: [{
      id: "screen-review",
      title: "Review",
      purpose: "Review one word",
      layout: { regions: [{ id: "main", role: "main", position: "center", childRefs: ["element-reveal"] }] },
      elements: [{ id: "element-reveal", type: "button", label: "Reveal", visibleInStates: ["question"], enabledInStates: ["question"] }],
      states: ["question", "answer"],
      actions: [{ id: "action-reveal", triggerElementId: "element-reveal", fromState: "question", toState: "answer", expectedEffect: "Show answer" }],
      responsiveRules: ["Action remains visible"],
      accessibilityRules: ["Action has button role"],
    }],
    flows: [{ id: "flow-review", steps: ["action-reveal"], successOutcome: "Answer is visible" }],
    criterionBindings: [{ criterionId: "criterion-review", screenIds: ["screen-review"], elementIds: ["element-reveal"], actionIds: ["action-reveal"] }],
    contractHash: "a".repeat(64),
  };
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    import { UiInteractionContractViewer } from "./web/components/UiInteractionContractViewer";
    const draft = ${JSON.stringify(draft)};
    function Harness() {
      const [ui, setUi] = useState(null);
      return <aside data-testid="sidecar" style={{ width: 900, height: 700 }}>{ui ? <UiInteractionContractViewer selection={ui} /> : <GoalRequirementEditor selection={{ draftId: "draft-goal-1", expectedDraftHash: "hash-1", requirementId: "req-review", draft, status: "requirements_review", confirmable: false }} onUiContractSelect={setUi} />}</aside>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/ui-contracts/ui-review", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: contract }) });
    });
    await page.locator('[data-testid="goal-requirement-open-ui-contract"]').click();
    await page.locator('[data-testid="ui-interaction-contract-viewer"]').waitFor();
    assert.match(await page.locator('[data-testid="sidecar"]').textContent() ?? "", /screen-review/);
    assert.equal(await page.locator('[data-element-id="element-reveal"]').count(), 1);
    await page.locator('[data-testid="ui-state-answer"]').click();
    assert.equal(await page.locator('[data-element-id="element-reveal"]').count(), 0);
  });
});

test("Requirement list exposes per-requirement readiness status", async () => {
  const draft = requirementDraftView();
  draft.requirements[0]!.interactionContractRefs = ["ui-complete"];
  draft.requirements.push({
    ...draft.requirements[0],
    id: "req-contract",
    title: "Contract review flow",
    interactionContractRefs: ["ui-contract"],
  });
  draft.requirements.push({
    ...draft.requirements[0],
    id: "req-pending",
    title: "Pending host review",
    status: "draft",
    interactionContractRefs: [],
  });
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{
      type: "goalRequirements",
      draftId: "draft-goal-1",
      status: "requirements_review",
      goalRequirementDraftHash: "hash-1",
      draft: ${JSON.stringify(draft)},
      confirmable: false,
      validationIssues: [{
        path: "requirements.1.interactionContractRefs.0",
        code: "unconfirmed_ui_interaction_contract",
        message: "UI interaction contract is not confirmed: ui-contract",
      }],
    }} />);
  `, async (page) => {
    assert.match(await page.getByTestId("goal-requirement-status-req-review").innerText(), /Complete|Ready/i);
    assert.match(await page.getByTestId("goal-requirement-status-req-contract").innerText(), /Warning|Needs attention/i);
    assert.match(await page.getByTestId("goal-requirement-status-req-pending").innerText(), /Pending host review/i);
    assert.match(await page.getByTestId("goal-requirement-visual-contracts-req-review").innerText(), /ui-complete/);
    assert.match(await page.getByTestId("goal-requirement-visual-contracts-req-contract").innerText(), /ui-contract/);
    assert.match(await page.getByTestId("goal-requirements-readiness-summary").innerText(), /1.*3|1.*attention/i);
  });
});

test("requirement, contract, slice, and DAG labels expose purpose before technical ids", async () => {
  const draft = requirementDraftView();
  draft.requirements[0]!.interactionContractRefs = ["ui-review"];
  const contract = {
    schemaVersion: "southstar.ui_interaction_contract.v2",
    id: "ui-review",
    revision: 2,
    status: "confirmed",
    requirementIds: ["req-review"],
    screens: [{
      id: "screen-review",
      title: "Review answer",
      purpose: "Let the learner submit an answer and see feedback",
      layout: { regions: [{ id: "main", role: "main", position: "center", childRefs: ["element-submit"] }] },
      elements: [{ id: "element-submit", type: "button", label: "Submit answer", visibleInStates: ["question"], enabledInStates: ["question"] }],
      states: ["question"],
      actions: [],
      responsiveRules: [],
      accessibilityRules: [],
    }],
    flows: [],
    criterionBindings: [],
    contractHash: "a".repeat(64),
  };
  const goalDesign = {
    schemaVersion: "southstar.goal_design_package.v3",
    revision: 1,
    packageHash: "package-hash",
    goalContract: { summary: "Build a vocabulary review flow" },
    slicePlan: {
      slices: [{
        id: "slice-review",
        requirementIds: ["req-review"],
        outcome: "Learner submits a review and receives feedback",
        stateOrArtifactOwner: "review progress store",
        mutationBoundary: "Only review progress may change",
        expectedArtifactRefs: ["artifact.review-flow"],
        evaluatorContractRefs: ["evaluator.review-flow"],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: { mode: "sequential", rationale: "Validate the review flow before reporting completion." },
  };
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    import { UiInteractionContractViewer } from "./web/components/UiInteractionContractViewer";
    import { GoalSlicePlanBlock } from "./web/components/GoalSlicePlanBlock";
    const draft = ${JSON.stringify(draft)};
    const contract = ${JSON.stringify(contract)};
    const goalDesign = ${JSON.stringify(goalDesign)};
    function Harness() {
      const [view, setView] = useState("requirements");
      return <main>
        <button data-testid="show-requirement" onClick={() => setView("requirement")}>requirement</button>
        <button data-testid="show-contract" onClick={() => setView("contract")}>contract</button>
        <button data-testid="show-slice" onClick={() => setView("slice")}>slice</button>
        {view === "requirements" ? <GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false }} onRequirementSelect={() => setView("requirement")} /> : null}
        {view === "requirement" ? <GoalRequirementEditor selection={{ draftId: "draft-goal-1", expectedDraftHash: "hash-1", requirementId: "req-review", draft, status: "requirements_review", confirmable: false }} onUiContractSelect={() => setView("contract")} /> : null}
        {view === "contract" ? <UiInteractionContractViewer selection={{ draftId: "draft-goal-1", contractId: "ui-review", requirementId: "req-review" }} /> : null}
        {view === "slice" ? <GoalSlicePlanBlock block={{ type: "goalDesign", draftId: "draft-goal-1", status: "ready_for_review", goalDesignPackageHash: "package-hash", package: goalDesign }} /> : null}
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    assert.match(await page.locator('[data-testid="goal-requirement-item-req-review"]').textContent() ?? "", /Review flow/);
    await page.locator('[data-testid="goal-requirement-item-req-review"]').click();
    assert.match(await page.locator('[data-testid="goal-requirement-editor"]').textContent() ?? "", /Review flow/);
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/ui-contracts/ui-review", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: contract }) });
    });
    await page.locator('[data-testid="goal-requirement-open-ui-contract"]').click();
    assert.match(await page.locator('[data-testid="ui-interaction-contract-viewer"]').textContent() ?? "", /Let the learner submit an answer and see feedback/);
    await page.locator('[data-testid="show-slice"]').click();
    assert.match(await page.locator('[data-testid="goal-slice-plan-item-slice-review"]').textContent() ?? "", /Learner submits a review and receives feedback/);
  });
});

test("selecting a slice resolves id-only references in the right-side viewer", async () => {
  const requirementDraft = {
    schemaVersion: "southstar.goal_requirement_draft.v2",
    revision: 1,
    originalPrompt: "Build a review flow",
    workspace: { cwd: "/workspace/project" },
    summary: "Review flow",
    requirements: [{
      id: "req-review",
      title: "Review submission",
      statement: "The learner can submit a review and receive feedback.",
      source: "explicit",
      blocking: false,
      userVisibleBehaviors: [],
      businessRules: [],
      acceptanceCriteria: [],
      expectedOutcomeArtifacts: [],
      verificationIntent: [],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
      status: "ready",
    }],
    nonGoals: [],
    blockingInputs: [],
    draftHash: "draft-hash",
  };
  const goalDesign = {
    schemaVersion: "southstar.goal_design_package.v3",
    revision: 1,
    packageHash: "package-hash",
    goalContract: {
      summary: "Build a review flow",
      requirements: [{
        id: "req-review",
        expectedArtifacts: [{ description: "Saved review record", mediaType: "application/json" }],
      }],
    },
    validationBindings: [{
      schemaVersion: "southstar.requirement_validation_binding.v3",
      id: "binding-review",
      requirementId: "req-review",
      criterionBindings: [{
        criterionContract: {
          id: "criterion-review",
          version: 1,
          observableClaim: "The saved review is returned by the list query.",
          blocking: true,
          verificationIntent: ["Run the review list query and inspect the persisted result."],
          requiredAssurance: ["deterministic"],
        },
        artifactContractRef: "artifact.review",
        artifactContractVersionRef: "artifact.review@1",
        evaluatorProfileRef: "evaluator.profile.review",
        evaluatorProfileVersionRef: "evaluator.profile.review@1",
        verificationMode: "deterministic",
        procedureRef: "procedure.review",
        expectedEvidenceKinds: ["test-result"],
        independence: "independent",
        failureClassifications: ["implementation_gap"],
      }],
    }],
    slicePlan: {
      slices: [
        {
          id: "slice-base",
          requirementIds: [],
          outcome: "Prepare the review state",
          stateOrArtifactOwner: "review store",
          mutationBoundary: "review only",
          expectedArtifactRefs: ["artifact.base"],
          evaluatorContractRefs: ["evaluator.base"],
          dependsOnSliceIds: [],
          dependencyArtifactRefs: [],
        },
        {
          id: "slice-review",
          requirementIds: ["req-review"],
          outcome: "Submit a review and persist feedback",
          stateOrArtifactOwner: "review store",
          mutationBoundary: "review only",
          expectedArtifactRefs: ["artifact.review"],
          evaluatorContractRefs: ["binding-review"],
          dependsOnSliceIds: ["slice-base"],
          dependencyArtifactRefs: ["artifact.base"],
        },
      ],
    },
    compositionStrategy: { mode: "sequential", rationale: "Review the state before submission." },
  };
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalSlicePlanBlock } from "./web/components/GoalSlicePlanBlock";
    import { GoalSliceEditor } from "./web/components/GoalSliceEditor";
    const requirementDraft = ${JSON.stringify(requirementDraft)};
    const goalDesign = ${JSON.stringify(goalDesign)};
    function Harness() {
      const [selection, setSelection] = useState(null);
      return <main>
        <GoalSlicePlanBlock
          block={{ type: "goalDesign", draftId: "draft-goal-1:slice-revision:child", status: "ready_for_review", goalDesignPackageHash: "package-hash", package: goalDesign }}
          requirementContent={{ type: "goalRequirements", draftId: "draft-goal-1:slice-revision:child", status: "requirements_review", goalRequirementDraftHash: "draft-hash", draft: requirementDraft, confirmable: false }}
          onSliceSelect={setSelection}
        />
        {selection ? <GoalSliceEditor selection={selection} /> : null}
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    assert.equal(await page.getByTestId("goal-slice-plan-block").getAttribute("data-draft-id"), "draft-goal-1:slice-revision:child");
    assert.match(await page.getByTestId("goal-slice-staged-revision").innerText(), /editable/);
    await page.getByTestId("goal-slice-plan-item-slice-review").click();
    assert.match(await page.getByTestId("goal-slice-editor").innerText(), /Submit a review and persist feedback/);
    assert.match(await page.getByTestId("goal-slice-reference-list-requirements").innerText(), /req-review.*Review submission.*learner can submit/i);
    assert.match(await page.getByTestId("goal-slice-reference-list-depends").innerText(), /slice-base.*Prepare the review state/i);
    assert.match(await page.getByTestId("goal-slice-reference-list-artifacts").innerText(), /artifact\.review.*Saved review record.*application\/json/i);
    assert.match(await page.getByTestId("goal-slice-reference-list-evaluators").innerText(), /binding-review.*evaluator\.profile\.review.*deterministic.*test-result/i);
    assert.match(await page.getByTestId("goal-slice-reference-list-dependencies").innerText(), /artifact\.base.*content is not attached/i);
  });
});

test("slice plan override is rendered as a workspace tail instead of replacing requirements", () => {
  const message = source("web/components/MessageView.tsx");
  const chat = source("web/components/ChatWindow.tsx");
  assert.doesNotMatch(message, /goalDesignContentOverride\?\.draftId/);
  assert.match(chat, /data-testid="goal-slice-plan-tail"/);
  assert.match(chat, /goalDesignContentForViewer && !goalDesignAlreadyRendered/);
});

test("latest goal design snapshot is the only actionable slice plan", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalSlicePlanBlock } from "./web/components/GoalSlicePlanBlock";
    import { latestGoalDesignContent } from "./web/lib/agent-session-engine";
    const messages = [
      { role: "assistant", content: [{ type: "goalDesign", draftId: "draft-goal-1", status: "ready_for_review", goalDesignPhase: "slice_review", goalDesignPackageHash: "old-hash", package: { goalContract: { summary: "Old plan" }, slicePlan: { slices: [{ id: "slice-old", outcome: "Old slice", requirementIds: [], stateOrArtifactOwner: "old", mutationBoundary: "old", expectedArtifactRefs: [], evaluatorContractRefs: [], dependsOnSliceIds: [], dependencyArtifactRefs: [] }] } } }] },
      { role: "assistant", content: [{ type: "goalDesign", draftId: "draft-goal-1", status: "ready_for_review", goalDesignPhase: "slice_review", goalDesignPackageHash: "new-hash", package: { goalContract: { summary: "Latest plan" }, slicePlan: { slices: [{ id: "slice-new", outcome: "Latest slice", requirementIds: [], stateOrArtifactOwner: "new", mutationBoundary: "new", expectedArtifactRefs: [], evaluatorContractRefs: [], dependsOnSliceIds: [], dependencyArtifactRefs: [] }] } } }] },
    ];
    const current = latestGoalDesignContent(messages);
    createRoot(document.getElementById("root")).render(current ? <GoalSlicePlanBlock block={current} onConfirmGoalDesign={() => undefined} /> : <p>missing</p>);
  `, async (page) => {
    const plan = page.getByTestId("goal-slice-plan-block");
    assert.match(await plan.innerText(), /Latest plan|Latest slice/);
    assert.doesNotMatch(await plan.innerText(), /Old plan|Old slice/);
    assert.equal(await page.getByTestId("goal-design-confirm-compose").count(), 1);
  });
});

test("Slice save uses the host's current package hash at the mutation boundary", async () => {
  const goalDesign = {
    revision: 2,
    packageHash: "old-hash",
    goalContract: { summary: "Review the current slice" },
    validationBindings: [],
    evaluatorContracts: [],
    slicePlan: {
      slices: [{
        id: "slice-review",
        requirementIds: [],
        outcome: "old outcome",
        stateOrArtifactOwner: "review store",
        mutationBoundary: "review only",
        expectedArtifactRefs: [],
        evaluatorContractRefs: [],
        dependsOnSliceIds: [],
        dependencyArtifactRefs: [],
      }],
    },
    compositionStrategy: { mode: "sequential", rationale: "Keep the review deterministic." },
  };
  const currentPackage = {
    ...goalDesign,
    revision: 3,
    packageHash: "new-hash",
    slicePlan: { slices: [{ ...goalDesign.slicePlan.slices[0], outcome: "current outcome" }] },
  };
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalSliceEditor } from "./web/components/GoalSliceEditor";
    const selection = {
      draftId: "draft-goal-1:slice-revision:child",
      status: "ready_for_review",
      goalDesignPhase: "slice_review",
      goalDesignPackageHash: "old-hash",
      selectedSliceId: "slice-review",
      package: ${JSON.stringify(goalDesign)},
    };
    function Harness() {
      const [savedHash, setSavedHash] = useState("");
      return <main>
        <GoalSliceEditor selection={selection} onPackageChange={(next) => setSavedHash(next.goalDesignPackageHash || "")} />
        <output data-testid="saved-hash">{savedHash}</output>
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    let patchBody: Record<string, unknown> | undefined;
    await page.route("**/api/workflow/planner-drafts/**/orchestration", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: {
        draftId: "draft-goal-1:slice-revision:child",
        status: "ready_for_review",
        goalDesignPhase: "slice_review",
        goalDesignPackageHash: "new-hash",
        goalDesignPackage: currentPackage,
      } }) });
    });
    await page.route("**/api/workflow/planner-drafts/**/goal-design/slices/**", async (route) => {
      patchBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: currentPackage }) });
    });
    await page.getByRole("button", { name: "Save slice" }).click();
    await page.getByTestId("saved-hash").filter({ hasText: "new-hash" }).waitFor();
    assert.equal(patchBody?.expectedPackageHash, "new-hash");
  });
});

test("Requirement block renders a coverage graph for AC and coverage refs", async () => {
  const draft = requirementDraftView();
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(
      <GoalRequirementListBlock
        block={{
          type: "goalRequirements",
          draftId: "draft-goal-coverage",
          status: "requirements_review",
          goalRequirementDraftHash: "hash-coverage",
          draft,
          confirmable: false,
          coveragePreview: [{
            requirementId: "req-review",
            status: "partial",
            artifactRefs: ["artifact.review"],
            evaluatorRefs: ["evaluator.review"],
          }],
        }}
      />
    );
  `, async (page) => {
    const preview = page.getByTestId("goal-requirements-coverage-preview");
    await preview.waitFor();
    assert.equal(await preview.getByTestId("library-graph-chart").count(), 1);
    await preview.getByRole("button", { name: "Requirement req-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "AC criterion-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Artifact artifact.review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Evaluator evaluator.review", exact: true }).waitFor();
  });
});

test("Slice block renders a coverage graph for requirement, slice, artifact, and evaluator refs", async () => {
  const requirementDraft = requirementDraftView();
  const goalDesign = {
    goalContract: { summary: "Build a review flow" },
    slicePlan: { slices: [{
      id: "slice-review",
      requirementIds: ["req-review"],
      outcome: "Submit a review",
      stateOrArtifactOwner: "review store",
      mutationBoundary: "review only",
      expectedArtifactRefs: ["artifact.review"],
      evaluatorContractRefs: ["evaluator.review"],
      dependsOnSliceIds: [],
      dependencyArtifactRefs: [],
    }] },
  };
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalSlicePlanBlock } from "./web/components/GoalSlicePlanBlock";
    const requirementDraft = ${JSON.stringify(requirementDraft)};
    const goalDesign = ${JSON.stringify(goalDesign)};
    createRoot(document.getElementById("root")).render(
      <GoalSlicePlanBlock
        block={{ type: "goalDesign", draftId: "draft-goal-coverage", status: "ready_for_review", goalDesignPackageHash: "package-hash", package: goalDesign }}
        requirementContent={{ type: "goalRequirements", draftId: "draft-goal-coverage", status: "requirements_review", goalRequirementDraftHash: "hash-coverage", draft: requirementDraft, confirmable: false }}
      />
    );
  `, async (page) => {
    const preview = page.getByTestId("goal-slice-coverage-preview");
    await preview.waitFor();
    assert.equal(await preview.getByTestId("library-graph-chart").count(), 1);
    await preview.getByRole("button", { name: "Requirement req-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Slice slice-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Artifact artifact.review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Evaluator evaluator.review", exact: true }).waitFor();
  });
});

test("DAG block renders a coverage graph from available task lineage without inventing evaluator nodes", async () => {
  const dag = scheduledDagWithMission();
  dag.nodes = [{
    id: "task-review",
    taskId: "task-review",
    label: "Review flow",
    role: "builder",
    agentRef: "agent.builder",
    profileRef: "profile.builder",
    profileResourcePath: "profiles/builder.yaml",
    provider: "pi",
    model: "pi-agent-default",
    requirementIds: ["req-review"],
    sliceId: "slice-review",
    purpose: "Build the review flow",
    nodeType: "producer",
    expectedOutputs: ["artifact.review"],
    level: 0,
    state: "ready",
  }, {
    id: "task-verify",
    taskId: "task-verify",
    label: "Verify flow",
    role: "evaluator",
    agentRef: "agent.verify",
    profileRef: "profile.verify",
    profileResourcePath: "profiles/verify.yaml",
    provider: "pi",
    model: "pi-agent-default",
    requirementIds: ["req-review"],
    sliceId: "slice-review",
    purpose: "Verify the review flow",
    nodeType: "evaluator",
    expectedOutputs: ["verification-report"],
    level: 1,
    state: "ready",
  }];
  dag.edges = [{ from: "task-review", to: "task-verify" }];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    const dag = ${JSON.stringify(dag)};
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock dag={dag} />);
  `, async (page) => {
    await expandWorkflowDag(page);
    const preview = page.getByTestId("workflow-dag-coverage-preview");
    await preview.waitFor();
    assert.equal(await preview.getByTestId("library-graph-chart").count(), 1);
    await preview.getByRole("button", { name: "Requirement req-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Slice slice-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Review flow", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Expected output artifact.review", exact: true }).waitFor();
    assert.equal(await preview.getByRole("button", { name: "Evaluator evaluator.review", exact: true }).count(), 0);
  });
});

test("DAG coverage graph adds persisted producer, artifact, evidence, evaluator, and verdict lineage", async () => {
  const dag = scheduledDagWithMission();
  dag.mission = {
    ...dag.mission,
    goalContract: {
      ...dag.mission.goalContract,
      requirements: [{
        id: "req-review",
        statement: "Review flow is persisted",
        acceptanceCriteria: [{
          id: "criterion-review-persisted",
          version: 1,
          observableClaim: "A completed review is persisted",
          blocking: true,
          verificationIntent: ["Query the saved review record"],
          requiredAssurance: ["deterministic"],
        }],
        blocking: true,
        source: "explicit",
      }],
    },
    coverage: {
      covered: 1,
      total: 1,
      failedRequirementIds: [],
      entries: [{
        requirementId: "req-review",
        producerTaskIds: ["task-review"],
        artifactRefs: ["artifact.review"],
        artifactContractRefs: ["artifact.review@1"],
        evaluatorTaskIds: ["task-verify"],
        evaluatorProfileRefs: ["evaluator.review"],
        requiredEvidenceKinds: ["artifact-ref"],
      }],
    },
    evaluatorResults: [{
      requirementIds: ["req-review"],
      artifactRefs: ["artifact.review"],
      evidenceRefs: ["evidence.review"],
      evaluatorTaskId: "task-verify",
      evaluatorProfileRef: "evaluator.review",
      verdict: "passed",
    }],
  };
  dag.nodes = [{
    id: "task-review",
    taskId: "task-review",
    label: "Review flow",
    role: "producer",
    agentRef: "agent.builder",
    profileRef: "profile.builder",
    profileResourcePath: "profiles/builder.yaml",
    provider: "pi",
    model: "pi-agent-default",
    requirementIds: ["req-review"],
    sliceId: "slice-review",
    purpose: "Build the review flow",
    nodeType: "producer",
    expectedOutputs: ["artifact.review"],
    level: 0,
    state: "completed",
  }, {
    id: "task-verify",
    taskId: "task-verify",
    label: "Verify flow",
    role: "evaluator",
    agentRef: "agent.verify",
    profileRef: "profile.verify",
    profileResourcePath: "profiles/verify.yaml",
    provider: "pi",
    model: "pi-agent-default",
    requirementIds: ["req-review"],
    sliceId: "slice-review",
    purpose: "Verify the review flow",
    nodeType: "evaluator",
    expectedOutputs: ["verification-report"],
    level: 1,
    state: "completed",
  }];
  dag.edges = [{ from: "task-review", to: "task-verify" }];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    const dag = ${JSON.stringify(dag)};
    createRoot(document.getElementById("root")).render(<WorkflowDagBlock dag={dag} />);
  `, async (page) => {
    await expandWorkflowDag(page);
    const preview = page.getByTestId("workflow-dag-coverage-preview");
    await preview.getByRole("button", { name: "Review flow is persisted", exact: true }).waitFor();
    await preview.getByRole("button", { name: "AC · A completed review is persisted", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Producer · task-review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Artifact · artifact.review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Evidence · evidence.review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Evaluator · evaluator.review", exact: true }).waitFor();
    await preview.getByRole("button", { name: "Verdict · passed", exact: true }).waitFor();
  });
});

test("step coverage preview selects a node with its connected edges and normalized content", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { CoverageGraphPreview } from "./web/components/CoverageGraphPreview";

    createRoot(document.getElementById("root")).render(
      <CoverageGraphPreview
        testId="step-coverage-preview"
        persistLayoutKey="step-coverage-test"
        description="step graph"
        nodes={[{
          objectKey: "requirement:R1",
          objectKind: "requirement",
          title: "Requirement R1",
          status: "accepted",
          metadata: { title: "Persist the review", statement: "The review must be persisted." },
        }, {
          objectKey: "slice:S1",
          objectKind: "slice",
          title: "Slice S1",
          metadata: { outcome: "Persist review state" },
        }, {
          objectKey: "task:review",
          objectKind: "task",
          title: "Review task",
          metadata: { purpose: "Run the review" },
        }, {
          objectKey: "artifact:review",
          objectKind: "artifact",
          title: "Review artifact",
        }]}
        edges={[{
          fromObjectKey: "requirement:R1",
          toObjectKey: "slice:S1",
          edgeType: "covered by slice",
        }, {
          fromObjectKey: "slice:S1",
          toObjectKey: "task:review",
          edgeType: "implemented by task",
        }, {
          fromObjectKey: "task:review",
          toObjectKey: "artifact:review",
          edgeType: "produces artifact",
        }]}
        onSelectNode={(node) => {
          window.__selectedStepNode = node.objectKey;
          window.__selectedStepGraph = node.selectionGraph;
          window.__selectedStepContent = node.sourceContent;
        }}
      />
    );
  `, async (page) => {
    const preview = page.locator('[data-testid="step-coverage-preview"]');
    await preview.waitFor();
    await preview.getByRole("button", { name: "Requirement R1", exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).__selectedStepNode), "requirement:R1");
    assert.deepEqual(await page.evaluate(() => (window as any).__selectedStepGraph.nodes.map((node: { objectKey: string }) => node.objectKey)), [
      "requirement:R1",
      "slice:S1",
    ]);
    assert.deepEqual(await page.evaluate(() => (window as any).__selectedStepGraph.edges.map((edge: { fromObjectKey: string; toObjectKey: string }) => `${edge.fromObjectKey}->${edge.toObjectKey}`)), [
      "requirement:R1->slice:S1",
    ]);
    assert.match(await page.evaluate(() => (window as any).__selectedStepContent), /Persist the review/);
  });
});

test("DAG node projection carries existing goal purpose and lineage fields", () => {
  const adapter = source("web/lib/workflow/v2-library-adapter.ts");
  const block = source("web/components/WorkflowDagBlock.tsx");
  const node = source("web/components/workflow-canvas/WorkflowTaskNode.tsx");
  assert.match(adapter, /sliceId: task\.sliceId/);
  assert.match(adapter, /purpose: task\.purpose/);
  assert.match(block, /sliceId: node\.sliceId/);
  assert.match(block, /requirementIds: node\.requirementIds/);
  assert.match(node, /data-node-field="purpose"/);
  assert.match(node, /data-node-field="sliceId"/);
  assert.match(node, /data-node-field="requirementIds"/);
  assert.match(node, /workflow-dag-node-toggle/);
  assert.match(node, /aria-expanded/);
  assert.match(node, /ss-flow-node-collapsed/);
});

test("workflow generation exposes live stage and heartbeat progress while the stream is open", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const chat = source("web/components/ChatWindow.tsx");
  assert.match(hook, /workflowProgress/);
  assert.match(hook, /setWorkflowProgress\(\{[^}]*stage/);
  assert.match(hook, /elapsedMs: heartbeat\.elapsedMs/);
  assert.match(chat, /WorkflowProgressBar/);
  assert.match(chat, /workflowProgress \? <WorkflowProgressBar progress=\{workflowProgress\}/);
  assert.match(chat, /data-testid="workflow-live-progress"/);
});

test("goal design confirmation forwards heartbeat and planner deltas to the live UI", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const runGoalService = source("src/v2/orchestration/run-goal-service.ts");
  const plannerRoutes = source("src/v2/server/planner-routes.ts");
  const confirmationHandler = hook.slice(
    hook.indexOf("const handleConfirmGoalDesign"),
    hook.indexOf("const handleAbort", hook.indexOf("const handleConfirmGoalDesign")),
  );
  const confirmationRoute = plannerRoutes.slice(
    plannerRoutes.indexOf("function createGoalDesignConfirmationStreamResponse"),
    plannerRoutes.indexOf("function goalDesignConfirmationErrorResponse"),
  );
  assert.match(confirmationHandler, /onHeartbeat\(heartbeat\)[\s\S]*heartbeat\.elapsedMs[\s\S]*setWorkflowProgress/);
  assert.match(confirmationHandler, /const append = \(text: string, mode: "line" \| "message\.delta"/);
  assert.match(confirmationHandler, /onMessage\(text, event\)[\s\S]*event === "message\.delta" \? "message\.delta" : "line"/);
  assert.match(confirmationHandler, /normalizeWorkflowStreamText\(streamedText\)/);
  assert.match(confirmationRoute, /onLlmDelta\(text\)[\s\S]*message\.delta/);
  assert.match(runGoalService, /onLlmDelta\?: \(text: string\) => void/);
  assert.match(runGoalService, /onLlmDelta: context\.onLlmDelta/);
});

test("workflow review surfaces input, contract, slice, and profile guidance in the current screens", async () => {
  const draft = requirementDraftView();
  draft.blockingInputs = ["Which workspace scope should be used? Options: A) current project; B) another project"];
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    import { GoalSlicePlanBlock } from "./web/components/GoalSlicePlanBlock";
    import { WorkflowStaticNodeProfile } from "./web/components/WorkflowStaticNodeProfile";
    const draft = ${JSON.stringify(draft)};
    const packageValue = { goalContract: { summary: "Build a review flow" }, slicePlan: { slices: [{ id: "slice-review", requirementIds: ["req-review"], outcome: "Submit a review and persist feedback", stateOrArtifactOwner: "review store", mutationBoundary: "review only", expectedArtifactRefs: ["artifact.review"], evaluatorContractRefs: ["evaluator.review"], dependsOnSliceIds: [], dependencyArtifactRefs: [] }] }, compositionStrategy: { mode: "single-run", rationale: "One requirement boundary." } };
    function Harness() {
      return <main>
        <GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [{ path: "blockingInputs", code: "blocking_inputs_unresolved", message: "answer required" }] }} />
        <GoalRequirementEditor selection={{ draftId: "draft-goal-1", expectedDraftHash: "hash-1", requirementId: "req-review", draft, status: "requirements_review", confirmable: false }} />
        <GoalSlicePlanBlock block={{ type: "goalDesign", draftId: "draft-goal-1", status: "ready_for_review", goalDesignPackageHash: "package-hash", package: packageValue }} />
        <WorkflowStaticNodeProfile node={{ id: "task-review", taskId: "task-review", label: "Verify review flow", role: "checker", agentRef: "agent.checker", profileRef: "profile.checker", profileResourcePath: "profiles/checker.yaml", provider: "pi", model: "pi-agent-default", level: 0, state: "ready" }} />
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    assert.match(await page.getByTestId("goal-requirements-block").innerText(), /How to answer|Answer and recheck|Confirm requirements/);
    assert.match(await page.getByTestId("goal-requirement-editor").innerText(), /How to edit a requirement|Acceptance criteria|Expected artifacts/);
    assert.match(await page.getByTestId("goal-slice-plan-block").innerText(), /How slices connect|requirement|artifact|evaluator/i);
    assert.match(await page.getByTestId("workflow-static-node-profile").innerText(), /How Agent Profile works|approved|runtime/i);
  });
});

test("journey, DAG review, and Library import screens explain the next user action", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalJourneyTimeline } from "./web/components/GoalJourneyTimeline";
    import { WorkflowDagBlock } from "./web/components/WorkflowDagBlock";
    import { LibraryCandidateMessageBlock } from "./web/components/library/LibraryCandidateMessageBlock";
    const journey = { id: "goal-1", title: "Build a riddle app", currentStage: "library", steps: [
      { id: "chat", label: "Chat", description: "Goal intake", status: "complete", mode: "chat" },
      { id: "requirements", label: "Requirements", description: "Goal contract", status: "complete", mode: "workflow" },
      { id: "library", label: "Library", description: "Import and coverage", status: "current", mode: "library" },
      { id: "workflow", label: "Workflow", description: "DAG plan", status: "pending", mode: "workflow" },
      { id: "operator", label: "Operator", description: "Run and evaluate", status: "pending", mode: "operator" },
      { id: "complete", label: "Complete", description: "Goal outcome", status: "pending", mode: "operator" },
    ] };
    const dag = ${JSON.stringify(scheduledDagWithMission())};
    dag.runId = undefined;
    dag.mission = undefined;
    const candidate = { objectKey: "skill.browser", kind: "skill", title: "Browser verification", scope: "approved", selectedByDefault: true, description: "Browser evidence" };
    function Harness() {
      return <main>
        <GoalJourneyTimeline journey={journey} variant="detail" />
        <WorkflowDagBlock dag={dag} />
        <LibraryCandidateMessageBlock draftId="draft-1" candidates={[candidate]} status="draft" onInstall={() => undefined} />
      </main>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await expandWorkflowDag(page);
    assert.equal(await page.getByTestId("goal-journey-guide").count(), 1);
    assert.match(await page.getByTestId("goal-journey-guide").innerText(), /How to follow|next step|Goal journey/i);
    assert.equal(await page.getByTestId("workflow-dag-guide").count(), 1);
    assert.match(await page.getByTestId("workflow-dag-guide").innerText(), /How to review|DAG|Validate|profile/i);
    assert.equal(await page.getByTestId("library-import-guide").count(), 1);
    assert.match(await page.getByTestId("library-import-guide").innerText(), /How to choose|coverage|approved|Install/i);
  });
});

test("Requirement editor preserves canonical Criterion contracts and can remove a visual contract reference", async () => {
  const draft = requirementDraftView();
  draft.requirements[0]!.acceptanceCriteria.push({
    id: "criterion-review-visible",
    version: 1,
    observableClaim: "The completed review appears in history",
    blocking: true,
    verificationIntent: ["Read the persisted review history."],
    requiredAssurance: ["deterministic"],
    evidenceIntent: ["artifact-ref"],
  });
  draft.requirements[0]!.interactionContractRefs = ["ui-review"];
  let body: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementEditor selection={{ draftId: "draft-goal-1", expectedDraftHash: "hash-1", requirementId: "req-review", draft, status: "requirements_review", confirmable: false }} />);
  `, async (page) => {
    assert.match(await page.getByTestId("goal-requirement-editor").innerText(), /Evidence: artifact-ref/);
    await page.locator('[data-testid="goal-requirement-remove-ui-contract-ui-review"]').click();
    assert.equal(await page.getByRole("textbox", { name: "Interaction contract refs", exact: true }).inputValue(), "");
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/goal-requirements/req-review", async (route) => {
      body = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", phase: "requirements_review", goalRequirementDraftHash: "hash-2", goalRequirementDraft: { ...draft, revision: 2, draftHash: "hash-2", requirements: draft.requirements.map((item) => ({ ...item, interactionContractRefs: [] })) }, confirmable: true, validationIssues: [] } }) });
    });
    await page.locator('[data-testid="goal-requirement-save"]').click();
    await page.getByText(/Saved revision 2/).waitFor();
    const patch = (body as { patch?: Record<string, unknown> } | null)?.patch;
    assert.deepEqual(patch?.interactionContractRefs, []);
    assert.deepEqual(patch?.acceptanceCriteria, [
      {
        id: "criterion-review",
        observableClaim: "A completed review is persisted",
        blocking: true,
        verificationIntent: ["Query the current review record"],
        requiredAssurance: ["deterministic"],
        evidenceIntent: ["artifact-ref"],
      },
      {
        id: "criterion-review-visible",
        observableClaim: "The completed review appears in history",
        blocking: true,
        verificationIntent: ["Read the persisted review history."],
        requiredAssurance: ["deterministic"],
        evidenceIntent: ["artifact-ref"],
      },
    ]);
  });
});

test("Requirement confirm posts the displayed draft hash and never composes a DAG", async () => {
  const draft = requirementDraftView();
  let body: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft: ${JSON.stringify(draft)}, confirmable: true }} />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/confirm-requirements", async (route) => {
      body = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", phase: "validation_resolving", status: "validation_resolving", goalRequirementDraftHash: "hash-1", goalRequirementDraft: draft, confirmable: false, validationIssues: [] } }) });
    });
    await page.locator('[data-testid="goal-requirements-confirm"]').click();
    await page.getByText(/Requirements confirmed/).waitFor();
    assert.deepEqual(body, { expectedDraftHash: "hash-1" });
    assert.equal(await page.locator("[data-testid=workflow-action-run]").count(), 0);
  });
});

test("Requirement edit replaces the message draft before confirm", async () => {
  const draft = requirementDraftView();
  const updatedDraftPayload = { ...draft, revision: 2, draftHash: "hash-2", requirements: draft.requirements.map((item) => ({ ...item, statement: "Updated statement" })) };
  let confirmBody: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    const initialDraft = ${JSON.stringify(draft)};
    const updatedDraft = ${JSON.stringify(updatedDraftPayload)};
    function Harness() {
      const [block, setBlock] = useState({ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft: initialDraft, confirmable: true });
      const [selection, setSelection] = useState(null);
      return <><GoalRequirementListBlock block={block} onRequirementSelect={setSelection} />{selection ? <aside data-testid="sidecar"><GoalRequirementEditor selection={selection} onDraftChange={(_next) => { setBlock((current) => ({ ...current, draft: updatedDraft, goalRequirementDraftHash: "hash-2", confirmable: true })); }} /></aside> : null}</>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.locator('[data-testid="goal-requirement-item-req-review"]').click();
    await page.locator('[data-testid="goal-requirement-editor"] textarea').nth(0).fill("Updated statement");
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/goal-requirements/req-review", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", phase: "requirements_review", confirmable: true, validationIssues: [], goalRequirementDraftHash: "hash-2", goalRequirementDraft: { ...draft, revision: 2, draftHash: "hash-2", requirements: draft.requirements.map((item) => ({ ...item, statement: "Updated statement" })) } } }) });
    });
    await page.locator('[data-testid="goal-requirement-save"]').click();
    await page.getByText(/Saved revision 2/).waitFor();
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/confirm-requirements", async (route) => {
      confirmBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "validation_resolving", phase: "validation_resolving", goalRequirementDraftHash: "hash-2", goalRequirementDraft: updatedDraftPayload, confirmable: false, validationIssues: [] } }) });
    });
    await page.locator('[data-testid="goal-requirements-confirm"]').click();
    await page.getByText(/Requirements confirmed/).waitFor();
    assert.deepEqual(confirmBody, { expectedDraftHash: "hash-2" });
  });
});

test("Chat H2 requirements event replaces H1 hash before the next confirmation", async () => {
  const draft = requirementDraftView();
  const revisedDraftPayload = { ...draft, revision: 2, draftHash: "hash-2", requirements: draft.requirements.map((item) => ({ ...item, statement: "Chat revised statement" })) };
  let confirmBody: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    const h1 = ${JSON.stringify(draft)};
    const h2 = ${JSON.stringify(revisedDraftPayload)};
    function Harness() {
      const [block, setBlock] = useState({ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft: h1, confirmable: true });
      return <><button data-testid="chat-h2" onClick={() => setBlock({ ...block, goalRequirementDraftHash: "hash-2", draft: h2 })}>chat H2</button><GoalRequirementListBlock block={block} /></>;
    }
    createRoot(document.getElementById("root")).render(<Harness />);
  `, async (page) => {
    await page.locator('[data-testid="chat-h2"]').click();
    await page.getByText("Chat revised statement").waitFor();
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/confirm-requirements", async (route) => {
      confirmBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "validation_resolving", phase: "validation_resolving", goalRequirementDraftHash: "hash-2", goalRequirementDraft: revisedDraftPayload, confirmable: false, validationIssues: [] } }) });
    });
    await page.locator('[data-testid="goal-requirements-confirm"]').click();
    await page.getByText(/Requirements confirmed/).waitFor();
    assert.deepEqual(confirmBody, { expectedDraftHash: "hash-2" });
  });
});

test("chat Goal Requirements events replace the AppShell anchor, not only editor saves", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const shell = source("web/components/AppShell.tsx");
  assert.match(hook, /opts\.onGoalRequirements\?\.\(block\)/);
  assert.match(shell, /onGoalRequirements=\{handleGoalRequirementsContent\}/);
  assert.match(shell, /expectedDraftHash: content\.goalRequirementDraftHash/);
  assert.match(shell, /goalRequirementsContentShouldReplace\(currentOverride, content\)/);
  assert.match(shell, /goalRequirementRevisionAnchorRef\.current = next/);
  const goalRequirementsHandler = shell.slice(shell.indexOf("const handleGoalRequirementsContent"), shell.indexOf("const handleUiContractReviewChange"));
  assert.match(goalRequirementsHandler, /persistGoalWorkflowState\(\[content\]\)/);
});

test("rehydrated Goal Design snapshots are persisted idempotently", () => {
  const shell = source("web/components/AppShell.tsx");
  const chat = source("web/components/ChatWindow.tsx");
  const resumeHandler = shell.slice(shell.indexOf("const handleGoalValidationResume"), shell.indexOf("const handleGoalContractSelect"));
  assert.match(shell, /const goalDesignContentOverrideRef = useRef<GoalDesignContent \| null>\(null\)/);
  assert.match(resumeHandler, /goalDesignContentOverrideRef\.current\.goalDesignPackageHash === continuation\.goalDesignPackageHash/);
  assert.match(resumeHandler, /goalDesignContentOverrideRef\.current = continuation/);
  assert.match(chat, /onGoalValidationResume=\{goalDesignAlreadyRendered \? undefined : onGoalValidationResume\}/);
});

test("replayed library review requirements reload linked Library candidates", () => {
  const shell = source("web/components/AppShell.tsx");
  const goalRequirementsHandler = shell.slice(shell.indexOf("const handleGoalRequirementsContent"), shell.indexOf("const handleUiContractReviewChange"));
  assert.match(goalRequirementsHandler, /content\.status === ["']library_review["']/);
  assert.match(goalRequirementsHandler, /loadGoalLibraryImportCandidates\(content\.libraryImportDraftId\)/);
  assert.match(goalRequirementsHandler, /setGoalLibraryImportCandidatesOverride\(candidates\)/);
});

test("workflow ChatWindow forwards Library graph selection to the shared sidecar handler", () => {
  const shell = source("web/components/AppShell.tsx");
  const workflowPanel = shell.slice(shell.indexOf('data-testid="workflow-mode-panel"'));
  assert.match(workflowPanel, /onLibraryGraphNodeSelect=\{handleLibraryGraphNodeSelect\}/);
});

test("live Goal Requirements override is used for the next workflow revision", () => {
  const hook = source("web/hooks/useAgentSession.ts");
  const chatWindow = source("web/components/ChatWindow.tsx");
  assert.match(chatWindow, /goalRequirementRevisionAnchor,\s*goalRequirementContentOverride,\s*onGoalRequirements/);
  assert.match(hook, /opts\.goalRequirementContentOverride/);
});

test("Goal Requirements projection rejects an equal-revision late review frame", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { goalRequirementsContentShouldReplace } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(requirementDraftView())};
    const current = { type: "goalRequirements", draftId: "draft-goal-1", status: "validation_ready", goalRequirementDraftHash: "hash-1", draft, confirmable: false, validationIssues: [] };
    const lateReview = { ...current, status: "requirements_review", confirmable: true };
    const accepted = goalRequirementsContentShouldReplace(current, lateReview);
    createRoot(document.getElementById("root")).render(<div data-testid="guard-result">{accepted ? "accepted" : "rejected"}</div>);
  `, async (page) => {
    assert.equal(await page.locator('[data-testid="guard-result"]').textContent(), "rejected");
  });
});

test("Goal Requirements projection ignores an identical replay frame", async () => {
  const { goalRequirementsContentShouldReplace } = await import("../../web/components/GoalRequirementListBlock.tsx");
  const draft = requirementDraftView();
  const current = {
    type: "goalRequirements" as const,
    draftId: "draft-goal-1",
    status: "validation_ready",
    goalRequirementDraftHash: "hash-1",
    draft,
    confirmable: false,
    validationIssues: [],
  };

  assert.equal(goalRequirementsContentShouldReplace(current, { ...current }), false);
});

test("Goal Requirements projection rejects a late pre-contract replay after UI confirmation", async () => {
  const { goalRequirementsContentShouldReplace } = await import("../../web/components/GoalRequirementListBlock.tsx");
  const draft = requirementDraftView();
  const confirmed = {
    type: "goalRequirements" as const,
    draftId: "draft-goal-1",
    status: "requirements_review" as const,
    goalRequirementDraftHash: "hash-1",
    draft,
    confirmable: true,
    validationIssues: [],
  };
  const lateReplay = {
    ...confirmed,
    confirmable: false,
    validationIssues: [{ path: "requirements.0.interactionContractRefs.0", code: "unconfirmed_ui_interaction_contract", message: "UI interaction contract is not confirmed" }],
  };
  assert.equal(goalRequirementsContentShouldReplace(confirmed, lateReplay), false);
});

test("Goal Requirements projection keeps the complete Goal Design phase order monotonic", async () => {
  const { goalRequirementsContentShouldReplace } = await import("../../web/components/GoalRequirementListBlock.tsx");
  const draft = requirementDraftView();
  const base = {
    type: "goalRequirements" as const,
    draftId: "draft-goal-1",
    goalRequirementDraftHash: "hash-1",
    draft,
    confirmable: false,
    validationIssues: [],
  };
  const orderedPhases = [
    "requirements_review",
    "requirements_confirmed",
    "validation_resolving",
    "library_review",
    "validation_ready",
    "slice_review",
    "ready_to_compose",
    "composing",
    "dag_validated",
  ];
  for (let index = 1; index < orderedPhases.length; index += 1) {
    assert.equal(goalRequirementsContentShouldReplace(
      { ...base, status: orderedPhases[index - 1]! },
      { ...base, status: orderedPhases[index]! },
    ), true, `${orderedPhases[index]} should replace ${orderedPhases[index - 1]}`);
  }
  assert.equal(goalRequirementsContentShouldReplace(
    { ...base, status: "dag_validated" },
    { ...base, status: "ready_to_compose" },
  ), false);
});

test("AppShell confirmation projection rejects a requirements_review response before mutation", async () => {
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { goalRequirementsConfirmationFromUnknown } from "./web/components/GoalRequirementListBlock";
    const draft = ${JSON.stringify(requirementDraftView())};
    const result = goalRequirementsConfirmationFromUnknown({ result: { draftId: "draft-goal-1", status: "requirements_review", phase: "requirements_review", goalRequirementDraftHash: "hash-1", goalRequirementDraft: draft, confirmable: true, validationIssues: [] } }, { draftId: "draft-goal-1", expectedDraftHash: "hash-1" });
    createRoot(document.getElementById("root")).render(<div data-testid="guard-result">{result ? "accepted" : "rejected"}</div>);
  `, async (page) => {
    assert.equal(await page.locator('[data-testid="guard-result"]').textContent(), "rejected");
  });
  const shell = source("web/components/AppShell.tsx");
  const guard = shell.indexOf("goalRequirementsConfirmationFromUnknown");
  const mutation = shell.indexOf("setGoalRequirementContentOverride(result)");
  assert.ok(guard >= 0 && guard < mutation);
});

test("Requirement editor fails closed on a malformed 2xx PATCH and invalidates the previous hash", async () => {
  const draft = requirementDraftView();
  let invalidated: Record<string, unknown> | null = null;
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementEditor } from "./web/components/GoalRequirementEditor";
    const draft = ${JSON.stringify(draft)};
    createRoot(document.getElementById("root")).render(<GoalRequirementEditor selection={{ draftId: "draft-goal-1", expectedDraftHash: "hash-1", requirementId: "req-review", draft, status: "requirements_review", confirmable: true }} onDraftInvalidated={(next) => { window.__invalidated = next; }} />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/goal-requirements/req-review", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", phase: "requirements_review", goalRequirementDraftHash: "hash-2", goalRequirementDraft: { ...draft, draftHash: "different-hash" }, confirmable: true, validationIssues: [] } }) });
    });
    await page.locator('[data-testid="goal-requirement-save"]').click();
    await page.getByText(/valid goal requirement draft|invalid/i).waitFor();
    const value = await page.evaluate(() => window.__invalidated as Record<string, unknown> | undefined);
    assert.equal(value?.confirmable, false);
    assert.equal(value?.expectedDraftHash, "");
  });
});

test("Requirement confirm rejects a malformed host response", async () => {
  const draft = requirementDraftView();
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft: ${JSON.stringify(draft)}, confirmable: true }} />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/confirm-requirements", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { status: "validation_resolving" } }) });
    });
    await page.locator('[data-testid="goal-requirements-confirm"]').click();
    await page.getByText(/valid goal requirement draft|confirmation response/i).waitFor();
    assert.equal(await page.getByText("Confirmed", { exact: true }).count(), 0);
  });
});

test("Requirement confirm rejects requirements_review even when host incorrectly marks it confirmable", async () => {
  const draft = requirementDraftView();
  await withBrowserHarness(`
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { GoalRequirementListBlock } from "./web/components/GoalRequirementListBlock";
    createRoot(document.getElementById("root")).render(<GoalRequirementListBlock block={{ type: "goalRequirements", draftId: "draft-goal-1", status: "requirements_review", goalRequirementDraftHash: "hash-1", draft: ${JSON.stringify(draft)}, confirmable: true }} />);
  `, async (page) => {
    await page.route("**/api/workflow/planner-drafts/draft-goal-1/confirm-requirements", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: { draftId: "draft-goal-1", status: "requirements_review", phase: "requirements_review", goalRequirementDraftHash: "hash-1", goalRequirementDraft: draft, confirmable: true, validationIssues: [] } }) });
    });
    await page.locator('[data-testid="goal-requirements-confirm"]').click();
    await page.getByText(/validation_resolving|post-confirmation phase|confirmation response/i).waitFor();
    assert.equal(await page.getByText("Confirmed", { exact: true }).count(), 0);
  });
});

test("workflow node profile save marks its planner draft as needing validation", () => {
  const editor = source("web/components/WorkflowNodeProfileEditor.tsx");
  assert.match(editor, /southstar:planner-draft-updated/);
  assert.match(editor, /needs_validation/);
});

function scheduledDagWithMission(): any {
  const requirements = [
    { id: "req-offline", statement: "Works offline", acceptanceCriteria: [{ id: "criterion-offline", version: 1, observableClaim: "opens without network access", blocking: true, verificationIntent: ["Open with the network disabled."], requiredAssurance: ["browser_interaction"] }], blocking: true, source: "explicit" },
    { id: "req-share", statement: "Can be shared", acceptanceCriteria: [{ id: "criterion-share", version: 1, observableClaim: "is a single HTML file", blocking: true, verificationIntent: ["Inspect the delivered file set."], requiredAssurance: ["deterministic"] }], blocking: true, source: "explicit" },
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
        schemaVersion: "southstar.goal_contract.v2",
        originalPrompt: "Create an offline HTML article",
        promptHash: "prompt-hash",
        revision: 1,
        workspace: { cwd: "/workspace/project" },
        domain: "software",
        intent: "create_article",
        workType: "general",
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

function requirementDraftView() {
  return {
    schemaVersion: "southstar.goal_requirement_draft.v2",
    revision: 1,
    originalPrompt: "Build a vocabulary app",
    workspace: { cwd: "/workspace/project" },
    summary: "Vocabulary app requirements",
    requirements: [{
      id: "req-review",
      title: "Review flow",
      statement: "A learner can review a word and record the result.",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["Show a word", "Record remembered or forgotten"],
      businessRules: ["A review updates progress"],
      acceptanceCriteria: [{
        id: "criterion-review",
        version: 1,
        observableClaim: "A completed review is persisted",
        blocking: true,
        verificationIntent: ["Query the current review record"],
        requiredAssurance: ["deterministic"],
        evidenceIntent: ["artifact-ref"],
      }],
      expectedOutcomeArtifacts: [{ description: "review flow implementation", mediaType: "text/plain" }],
      verificationIntent: ["exercise review flow"],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
      status: "ready",
    }],
    nonGoals: [],
    blockingInputs: [],
    draftHash: "hash-1",
  };
}

function awaitingApprovalDag() {
  const dag = scheduledDagWithMission();
  dag.runStatus = "awaiting_approval";
  dag.mission.status.execution = "awaiting_approval";
  dag.mission.approval = {
    id: "approval-mission",
    status: "pending",
    goalContractHash: "contract-hash",
    manifestHash: "manifest-hash",
    librarySnapshotHash: "library-hash",
  };
  return {
    ...dag,
    approvalCommand: {
      id: "approval.approve",
      label: "Approve",
      endpoint: "/api/v2/runs/run-article/approvals/approval-mission/decision",
      method: "POST",
      enabled: true,
      requiresConfirmation: true,
      body: { decision: "approved" },
    },
  };
}

async function expandWorkflowDag(page: Page): Promise<void> {
  const toggle = page.locator('[data-testid="workflow-dag-block"] > button');
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
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

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
      controller.enqueue(new TextEncoder().encode('event: goal_requirements\ndata: {"draftId":"draft-goal-1","status":"requirements_review","phase":"requirements_review","confirmable":true,"validationIssues":[],"goalRequirementDraftHash":"hash-1","package":{"goalRequirementDraft":{"schemaVersion":"southstar.goal_requirement_draft.v1","revision":1,"originalPrompt":"Review","workspace":{"cwd":"/workspace"},"summary":"Review","requirements":[],"nonGoals":[],"blockingInputs":[],"draftHash":"hash-1"}}}\n\nevent: done\ndata: {}\n\n'));
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
    await page.getByRole("button", { name: "Approve" }).waitFor();
    await page.evaluate(`
      window.prompt = function () { return "approved by operator"; };
      window.confirm = function () { return true; };
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: function () { return "00000000-0000-4000-8000-000000000001"; } });
    `);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Approve") as HTMLButtonElement;
      button.click();
      button.click();
    });
    await commandStarted;
    await page.evaluate("new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); })");
    assert.equal(pendingRoutes.length, 1, "double click must create one deferred command request");
    for (const route of pendingRoutes) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
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
    await page.evaluate(`
      window.prompt = function () { return "approve"; };
      window.confirm = function () { return true; };
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: function () { return "00000000-0000-4000-8000-000000000003"; } });
    `);
    await page.getByRole("button", { name: "Approve" }).click();
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
    await page.evaluate(`
      window.prompt = function () { return "retry"; };
      window.confirm = function () { return true; };
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: function () { return "00000000-0000-4000-8000-000000000002"; } });
    `);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.locator('[aria-live="polite"]').filter({ hasText: "failed" }).waitFor({ timeout: 1_000 });
    assert.equal(await page.getByRole("button", { name: "Approve" }).isEnabled(), true);
    await page.getByRole("button", { name: "Approve" }).click();
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
    await page.locator('[data-testid="goal-requirement-item-req-review"]').click();
    await page.locator('[data-testid="sidecar"] [data-testid="goal-requirement-editor"]').waitFor();
    assert.match(await page.locator('[data-testid="sidecar"]').textContent() ?? "", /Review flow/);
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
  assert.match(shell, /currentOverride\.draft\.revision > content\.draft\.revision/);
  assert.match(shell, /goalRequirementRevisionAnchorRef\.current = next/);
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

function requirementDraftView() {
  return {
    schemaVersion: "southstar.goal_requirement_draft.v1",
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
      acceptanceCriteria: [{ id: "criterion-review", statement: "A completed review is persisted", evidenceIntent: ["database row"] }],
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

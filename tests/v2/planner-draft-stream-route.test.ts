import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicFixtureComposer,
  deterministicFixtureComposition,
} from "./fixtures/deterministic-workflow-composer.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

type SseFrame = { event: string; data: Record<string, unknown> };

test("planner draft stream route emits true LLM deltas, backend stages, draft, orchestration, and done", async () => {
  const db = await createTestPostgresDb();
  try {
    const interpretationText = goalInterpretation("Generate a todo webapp");
    const compositionText = JSON.stringify(deterministicFixtureComposition());
    const context = {
      db,
      workflowComposer: new DeltaComposer(compositionText),
      plannerClient: {
        async generate() {
          throw new Error("generate should not be used by streaming route");
        },
        async generateStream(_prompt: string, handlers?: { onDelta?: (text: string) => void }) {
          handlers?.onDelta?.(interpretationText.slice(0, 32));
          handlers?.onDelta?.(interpretationText.slice(32));
          return interpretationText;
        },
      },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    const response = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/planner/drafts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalPrompt: "generate todo webapp",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
      }),
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const frames = parseSse(await response.text());
    assert.equal(joinDeltaFrames(frames, "goal_contract.delta"), interpretationText);
    const messageText = joinDeltaFrames(frames, "message.delta");
    assert.ok(messageText.length > 0);
    assert.equal(messageText.includes(interpretationText), false);
    assert.equal(messageText.split(compositionText).join(""), "");
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "composer.started"));
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "goal_contract.interpreted"));
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "draft.persisted"));
    assert.ok(frames.some((frame) => frame.event === "draft" && typeof (frame.data.draft as { draftId?: unknown }).draftId === "string"));
    assert.ok(frames.some((frame) => frame.event === "orchestration" && Array.isArray((frame.data.orchestration as { taskSummaries?: unknown }).taskSummaries)));
    assert.equal(frames.at(-1)?.event, "done");
  } finally {
    await db.close();
  }
});

test("planner draft revise stream route includes the previous Goal Contract and streams the revised DAG", async () => {
  const db = await createTestPostgresDb();
  try {
    const goalPrompts: string[] = [];
    const context = {
      db,
      workflowComposer: new DeterministicFixtureComposer(),
      plannerClient: {
        async generate() {
          throw new Error("generate should not be used by streaming route");
        },
        async generateStream(prompt: string, handlers?: { onDelta?: (text: string) => void }) {
          const text = goalInterpretation(prompt.includes("RevisionPrompt:") ? "Generate a todo webapp with parallel frontend and backend tasks" : "Generate a todo webapp");
          goalPrompts.push(prompt);
          handlers?.onDelta?.(text.slice(0, 24));
          handlers?.onDelta?.(text.slice(24));
          return text;
        },
      },
      executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
    };

    const initialResponse = await handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/planner/drafts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goalPrompt: "generate todo webapp",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
      }),
    }));
    const initialFrames = parseSse(await initialResponse.text());
    const initialDraftId = (initialFrames.find((frame) => frame.event === "draft")?.data.draft as { draftId?: string } | undefined)?.draftId;
    assert.ok(initialDraftId);

    const reviseResponse = await handleRuntimeRoute(context, new Request(`http://127.0.0.1/api/v2/planner/drafts/${initialDraftId}/revise/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "split frontend and backend into parallel tasks",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
      }),
    }));

    assert.equal(reviseResponse.status, 200);
    assert.equal(reviseResponse.headers.get("content-type"), "text/event-stream");
    const reviseFrames = parseSse(await reviseResponse.text());
    assert.ok(reviseFrames.some((frame) => frame.event === "goal_contract.delta" && typeof frame.data.text === "string"));
    assert.equal(reviseFrames.some((frame) => frame.event === "message.delta"), false);
    assert.ok(reviseFrames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "revision.requested"));
    assert.ok(reviseFrames.some((frame) => frame.event === "draft" && typeof (frame.data.draft as { draftId?: unknown }).draftId === "string"));
    assert.ok(reviseFrames.some((frame) => frame.event === "orchestration" && Array.isArray((frame.data.orchestration as { taskSummaries?: unknown }).taskSummaries)));
    assert.equal(reviseFrames.at(-1)?.event, "done");

    assert.equal(goalPrompts.length, 2);
    assert.match(goalPrompts[1] ?? "", /PreviousGoalContract:/);
    assert.match(goalPrompts[1] ?? "", /RevisionPrompt: split frontend and backend into parallel tasks/);
  } finally {
    await db.close();
  }
});

function parseSse(text: string): SseFrame[] {
  return text.trim().split(/\n\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
    const rawData = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    return { event, data: rawData ? JSON.parse(rawData) : {} };
  });
}

function joinDeltaFrames(frames: SseFrame[], event: string): string {
  return frames
    .filter((frame) => frame.event === event)
    .map((frame) => typeof frame.data.text === "string" ? frame.data.text : "")
    .join("");
}

class DeltaComposer implements WorkflowComposer {
  constructor(private readonly text: string) {}

  async compose(input: ComposeWorkflowInput) {
    input.onLlmDelta?.(this.text.slice(0, 48));
    input.onLlmDelta?.(this.text.slice(48));
    return deterministicFixtureComposition();
  }
}

function goalInterpretation(summary: string): string {
  return JSON.stringify({
    domain: "software",
    intent: "implement_feature",
    workType: "software_feature",
    summary,
    requirements: [{
      statement: summary,
      acceptanceCriteria: [summary],
      blocking: true,
      source: "explicit",
    }],
    expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
    requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
    nonGoals: [],
    assumptions: [],
    blockingInputs: [],
    riskTags: [],
    requestedSideEffects: ["workspace-write"],
  });
}

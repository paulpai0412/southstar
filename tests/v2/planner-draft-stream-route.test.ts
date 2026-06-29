import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFixtureComposer } from "../../src/v2/orchestration/composer.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

type SseFrame = { event: string; data: Record<string, unknown> };

test("planner draft stream route emits true LLM deltas, backend stages, draft, orchestration, and done", async () => {
  const db = await createTestPostgresDb();
  try {
    const fixturePlan = await new DeterministicFixtureComposer().compose({
      goalPrompt: "generate todo webapp",
      candidatePacket: {} as never,
    });
    const finalText = JSON.stringify(fixturePlan);
    const context = {
      db,
      plannerClient: {
        async generate() {
          throw new Error("generate should not be used by streaming route");
        },
        async generateStream(_prompt: string, handlers?: { onDelta?: (text: string) => void }) {
          handlers?.onDelta?.(finalText.slice(0, 32));
          handlers?.onDelta?.(finalText.slice(32));
          return finalText;
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
    assert.ok(frames.some((frame) => frame.event === "message.delta" && typeof frame.data.text === "string"));
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "composer.started"));
    assert.ok(frames.some((frame) => frame.event === "planner.stage" && frame.data.stage === "draft.persisted"));
    assert.ok(frames.some((frame) => frame.event === "draft" && typeof (frame.data.draft as { draftId?: unknown }).draftId === "string"));
    assert.ok(frames.some((frame) => frame.event === "orchestration" && Array.isArray((frame.data.orchestration as { taskSummaries?: unknown }).taskSummaries)));
    assert.equal(frames.at(-1)?.event, "done");
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

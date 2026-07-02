import assert from "node:assert/strict";
import test from "node:test";

test("library chat stream parses named SSE frames", async () => {
  const { parseLibrarySseFrames } = await import("../../web/lib/library/chat-stream.ts");
  const frames = parseLibrarySseFrames([
    "event: library.intent.started\ndata: {\"message\":\"Reading\"}\n\n",
    "event: library.graph.snapshot\ndata: {\"nodes\":[{\"objectKey\":\"agent.a\"}],\"edges\":[]}\n\n",
  ].join(""));

  assert.deepEqual(frames.map((frame) => frame.event), ["library.intent.started", "library.graph.snapshot"]);
  assert.equal(frames[1]?.data.nodes[0].objectKey, "agent.a");
});

test("library chat command dispatches streamed frames including trailing frame", async () => {
  const { runLibraryChatCommand } = await import("../../web/lib/library/chat-stream.ts");
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const requestedUrls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "/api/library/chat/messages") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, JSON.stringify({ prompt: "import agent", scope: "software" }));
      return new Response(JSON.stringify({ ok: true, result: { sessionId: "session-1", actionId: "action-1" } }), {
        headers: { "content-type": "application/json" },
      });
    }

    assert.equal(url, "/api/library/chat/events?sessionId=session-1&actionId=action-1");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: library.intent.started\r\ndata: {\"message\":\"Reading\"}\r\n\r\n"));
        controller.enqueue(encoder.encode("event: library.command.completed\ndata: {\"status\":\"ready_for_review\"}"));
        controller.close();
      },
    }), {
      headers: { "content-type": "text/event-stream" },
    });
  };

  try {
    const events: string[] = [];
    await runLibraryChatCommand({
      prompt: "import agent",
      scope: "software",
      onFrame: (frame) => events.push(frame.event),
    });

    assert.deepEqual(requestedUrls, [
      "/api/library/chat/messages",
      "/api/library/chat/events?sessionId=session-1&actionId=action-1",
    ]);
    assert.deepEqual(events, ["library.intent.started", "library.command.completed"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

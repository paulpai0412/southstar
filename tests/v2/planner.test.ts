import test from "node:test";
import assert from "node:assert/strict";
import { createPiSdkPlannerClient, plannerPromptHash } from "../../src/v2/planner/pi-planner.ts";

test("Pi SDK planner client sends prompt through AgentSession and returns assistant text", async () => {
  const prompts: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const client = createPiSdkPlannerClient({
    createSession: async () => ({
      on: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
      prompt: async (prompt: string) => {
        prompts.push(prompt);
        listeners.forEach((listener) => listener({
          type: "agent_end",
          messages: [{
            role: "assistant",
            content: [{ type: "text", text: "{\"ok\":true}" }],
          }],
        }));
      },
    }),
  });

  const raw = await client.generate("plan this");

  assert.deepEqual(prompts, ["plan this"]);
  assert.equal(raw, '{"ok":true}');
});

test("planner prompt hash is deterministic for the active planner boundary", () => {
  assert.equal(plannerPromptHash("plan this"), plannerPromptHash("plan this"));
  assert.notEqual(plannerPromptHash("plan this"), plannerPromptHash("plan that"));
});

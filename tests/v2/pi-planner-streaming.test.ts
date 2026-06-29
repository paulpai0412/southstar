import assert from "node:assert/strict";
import test from "node:test";
import { createPiSdkPlannerClient, type PiSdkPlannerSession } from "../../src/v2/planner/pi-planner.ts";

test("Pi SDK planner client streams true assistant text deltas from session snapshots", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  let promptedWith: string | null = null;
  const session: PiSdkPlannerSession = {
    async prompt(text: string) {
      promptedWith = text;
      for (const listener of listeners) listener({ message: { role: "assistant", content: "{" } });
      for (const listener of listeners) listener({ message: { role: "assistant", content: "{\"schemaVersion\"" } });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };

  const client = createPiSdkPlannerClient({ createSession: async () => session, timeoutMs: 1_000 });
  assert.equal(typeof client.generateStream, "function");

  const deltas: string[] = [];
  const finalText = await client.generateStream!("compose a workflow", {
    onDelta(delta) {
      deltas.push(delta);
    },
  });

  assert.equal(promptedWith, "compose a workflow");
  assert.equal(finalText, "{\"schemaVersion\"");
  assert.deepEqual(deltas, ["{", "\"schemaVersion\""]);
});

test("Pi SDK planner streaming ignores non-assistant single-message events", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const session: PiSdkPlannerSession = {
    async prompt(text: string) {
      for (const listener of listeners) listener({ message: { role: "user", content: text } });
      for (const listener of listeners) listener({ message: { role: "assistant", content: "{\"schemaVersion\"}" } });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => undefined;
    },
  };

  const client = createPiSdkPlannerClient({ createSession: async () => session, timeoutMs: 1_000 });
  const deltas: string[] = [];
  const finalText = await client.generateStream!("PROMPT SHOULD NOT STREAM", { onDelta: (delta) => deltas.push(delta) });

  assert.equal(finalText, "{\"schemaVersion\"}");
  assert.deepEqual(deltas, ["{\"schemaVersion\"}"]);
});

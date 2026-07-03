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

test("Pi SDK planner client applies configured model before prompting", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const commands: unknown[] = [];
  const prompts: string[] = [];
  const session: PiSdkPlannerSession = {
    async send(command: unknown) {
      commands.push(command);
    },
    async prompt(text: string) {
      prompts.push(text);
      for (const listener of listeners) listener({ message: { role: "assistant", content: "ok" } });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => undefined;
    },
  };

  const client = createPiSdkPlannerClient({
    createSession: async () => session,
    model: { provider: "github-copilot", modelId: "gpt-5.3-codex" },
    timeoutMs: 1_000,
  });

  assert.equal(await client.generate("plan this"), "ok");
  assert.deepEqual(commands, [{ type: "set_model", provider: "github-copilot", modelId: "gpt-5.3-codex" }]);
  assert.deepEqual(prompts, ["plan this"]);
});

test("Pi SDK planner client can create a tool-enabled session rooted at a requested cwd", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const sessionInputs: Array<{ cwd: string; noTools?: "all" | null }> = [];
  const session: PiSdkPlannerSession = {
    async prompt() {
      for (const listener of listeners) listener({ message: { role: "assistant", content: "{\"candidates\":[]}" } });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => undefined;
    },
  };

  const client = createPiSdkPlannerClient({
    cwd: "/tmp/southstar-library-imports/repo",
    noTools: null,
    createSession: async (input) => {
      sessionInputs.push(input);
      return session;
    },
    timeoutMs: 1_000,
  });

  assert.equal(await client.generate("inspect repo"), "{\"candidates\":[]}");
  assert.deepEqual(sessionInputs, [{ cwd: "/tmp/southstar-library-imports/repo", noTools: null }]);
});

test("Pi SDK planner client marks sessions as workflow", async () => {
  const listeners: Array<(event: unknown) => void> = [];
  const customEntries: Array<{ customType: string; data?: unknown }> = [];
  const session: PiSdkPlannerSession = {
    sessionManager: {
      appendCustomEntry(customType: string, data?: unknown) {
        customEntries.push({ customType, data });
        return "entry-kind";
      },
    },
    async prompt() {
      for (const listener of listeners) listener({ message: { role: "assistant", content: "ok" } });
      for (const listener of listeners) listener({ type: "agent_end" });
    },
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => undefined;
    },
  };

  const client = createPiSdkPlannerClient({ createSession: async () => session, timeoutMs: 1_000 });

  assert.equal(await client.generate("plan this"), "ok");
  assert.deepEqual(customEntries, [{
    customType: "southstar.session.kind",
    data: { kind: "workflow" },
  }]);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexSdkSoftwareDevWorker } from "../../src/adapters/host/codex-worker.ts";
import {
  buildCapabilityReport,
  parseHostModelReference,
  productionHostNames,
} from "../../src/adapters/host/capabilities.ts";
import { OpenCodeSdkSoftwareDevWorker } from "../../src/adapters/host/opencode-worker.ts";
import { PiSdkSoftwareDevWorker } from "../../src/adapters/host/pi-worker.ts";
import { piLoader, piSdkPackageName } from "../../src/adapters/host/sdk-loaders.ts";

test("host capability helpers normalize model references and reports", () => {
  assert.deepEqual(productionHostNames, ["codex", "opencode", "pi"]);
  assert.deepEqual(parseHostModelReference(undefined), undefined);
  assert.deepEqual(parseHostModelReference("gpt-5"), { modelId: "gpt-5" });
  assert.deepEqual(parseHostModelReference("openai/gpt-5"), { provider: "openai", modelId: "gpt-5" });
  assert.deepEqual(buildCapabilityReport({
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills", "mcp_servers"],
  }), {
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills", "mcp_servers"],
  });
});

test("pi SDK loader pins concrete package name behind dynamic import boundary", () => {
  assert.equal(piSdkPackageName(), "@earendil-works/pi-coding-agent");
  assert.match(piLoader.toString(), /import\("@earendil-works\/pi-coding-agent"\)/);
});

test("codex sdk worker starts a thread and returns implementation output", async () => {
  let workingDirectory = "";
  let threadOptions: Record<string, unknown> = {};
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread(options: Record<string, unknown>) {
          workingDirectory = String(options.workingDirectory);
          threadOptions = options;
          return {
            id: "codex-root",
            async run(prompt: string) {
              return { finalResponse: `done:${prompt}` };
            },
          };
        }
      },
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  });

  assert.equal(workingDirectory, "/repo");
  assert.equal(threadOptions.sandboxMode, "workspace-write");
  assert.equal(threadOptions.networkAccessEnabled, true);
  assert.equal(threadOptions.approvalPolicy, "never");
  assert.equal(result.root_session_id, "codex-root");
  assert.equal(result.child_run_id, "codex-root:implement");
  assert.equal(result.final_response, "done:implement");
  assert.equal(result.shell_fallbacks, 0);
});

test("codex sdk worker reports stream session before sending the prompt", async () => {
  const calls: string[] = [];
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread() {
          calls.push("startThread");
          return {
            id: "codex-stream-root",
            async runStreamed() {
              calls.push("runStreamed");
              return {
                events: (async function* () {
                  yield { type: "thread.started", thread_id: "codex-stream-root" };
                  yield { type: "item.completed", item: { type: "agent_message", id: "msg", text: "done" } };
                  yield { type: "turn.completed", usage: null };
                })(),
              };
            },
            async run() {
              calls.push("run");
              return { finalResponse: "done" };
            },
          };
        }
      },
    }),
  });

  await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    on_stream_session_started: async (session) => {
      calls.push(`stream:${session.stream_session_id}:${session.stream_adapter}`);
    },
  });

  assert.deepEqual(calls, [
    "startThread",
    "runStreamed",
    "stream:codex-stream-root:codex",
  ]);
});

test("codex sdk worker waits for streamed thread id before reporting stream session", async () => {
  const calls: string[] = [];
  let rootId: string | null = null;
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread() {
          calls.push("startThread");
          return {
            get id() {
              return rootId;
            },
            async runStreamed() {
              calls.push(`runStreamed:${rootId}`);
              return {
                events: (async function* () {
                  rootId = "codex-delayed-root";
                  yield { type: "thread.started", thread_id: "codex-delayed-root" };
                  yield { type: "item.completed", item: { type: "agent_message", id: "msg", text: "done delayed" } };
                  yield { type: "turn.completed", usage: null };
                })(),
              };
            },
          };
        }
      },
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    on_stream_session_started: async (session) => {
      calls.push(`stream:${session.stream_session_id}:${session.stream_child_run_id}`);
    },
  });

  assert.deepEqual(calls, [
    "startThread",
    "runStreamed:null",
    "stream:codex-delayed-root:codex-delayed-root:implement",
  ]);
  assert.equal(result.root_session_id, "codex-delayed-root");
  assert.equal(result.child_run_id, "codex-delayed-root:implement");
  assert.equal(result.session_id, "codex-delayed-root");
  assert.equal(result.final_response, "done delayed");
});

test("codex sdk worker keeps repo root as implementation working directory for agent-owned workspaces", async () => {
  let workingDirectory = "";
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/consumer-root",
    loader: async () => ({
      Codex: class {
        startThread(options: Record<string, unknown>) {
          workingDirectory = String(options.workingDirectory);
          return {
            id: "codex-root",
            async run() {
              return { finalResponse: "done" };
            },
          };
        }
      },
    }),
  });

  await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    worktree_path: "agent-owned://codex/northstar-production/issue-1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  });

  assert.equal(workingDirectory, "/consumer-root");
});

test("codex sdk worker keeps repo root as verification working directory for agent-owned workspaces", async () => {
  let workingDirectory = "";
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/consumer-root",
    loader: async () => ({
      Codex: class {
        startThread(options: Record<string, unknown>) {
          workingDirectory = String(options.workingDirectory);
          return {
            id: "codex-root",
            async run() {
              return { finalResponse: "verified" };
            },
          };
        }
      },
    }),
  });

  await worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    worktree_path: "agent-owned://codex/northstar-production/issue-1",
    prompt: "verify",
  });

  assert.equal(workingDirectory, "/consumer-root");
});

test("codex sdk worker rejects invalid sdk exports", async () => {
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({}),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
  }), /HOST_SDK_CONFIG_INVALID/);
});

test("opencode sdk worker supports current SDK createOpencode shape", async () => {
  let closed = false;
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      createOpencode: async () => ({
        server: { close: () => { closed = true; } },
        client: {
          session: {
            create: async () => ({ data: { id: "opencode-root" } }),
            prompt: async () => ({
              data: {
                info: { id: "opencode-message" },
                parts: [{ text: "verification passed" }],
              },
            }),
          },
        },
      }),
    }),
  });

  const result = await worker.runVerification({
    pr_number: 7,
    pr_url: "https://github.test/pull/7",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
  });
  await worker.dispose();

  assert.equal(result.root_session_id, "opencode-root");
  assert.equal(result.child_run_id, "opencode-message");
  assert.equal(result.session_id, "opencode-root");
  assert.equal(result.final_response, "verification passed");
  assert.equal(closed, true);
});

test("opencode sdk worker uses issue worktree as implementation working directory", async () => {
  let createDirectory = "";
  let promptDirectory = "";
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/consumer-root",
    loader: async () => ({
      createOpencode: async () => ({
        client: {
          session: {
            create: async (options: { query?: { directory?: string } }) => {
              createDirectory = options.query?.directory ?? "";
              return { data: { id: "opencode-root" } };
            },
            prompt: async (options: { query?: { directory?: string } }) => {
              promptDirectory = options.query?.directory ?? "";
              return { data: { info: { id: "opencode-message" }, parts: [{ text: "done" }] } };
            },
          },
        },
      }),
    }),
  });

  await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    worktree_path: "/consumer-root/.northstar/runtime/worktrees/issue-1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  });

  assert.equal(createDirectory, "/consumer-root/.northstar/runtime/worktrees/issue-1");
  assert.equal(promptDirectory, "/consumer-root/.northstar/runtime/worktrees/issue-1");
});

test("opencode sdk worker uses issue worktree as verification working directory", async () => {
  let createDirectory = "";
  let promptDirectory = "";
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/consumer-root",
    loader: async () => ({
      createOpencode: async () => ({
        client: {
          session: {
            create: async (options: { query?: { directory?: string } }) => {
              createDirectory = options.query?.directory ?? "";
              return { data: { id: "opencode-root" } };
            },
            prompt: async (options: { query?: { directory?: string } }) => {
              promptDirectory = options.query?.directory ?? "";
              return { data: { info: { id: "opencode-message" }, parts: [{ text: "verified" }] } };
            },
          },
        },
      }),
    }),
  });

  await worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    worktree_path: "/consumer-root/.northstar/runtime/worktrees/issue-1",
    prompt: "verify",
  });

  assert.equal(createDirectory, "/consumer-root/.northstar/runtime/worktrees/issue-1");
  assert.equal(promptDirectory, "/consumer-root/.northstar/runtime/worktrees/issue-1");
});

test("opencode sdk worker keeps repo root as implementation working directory for agent-owned workspaces", async () => {
  let createDirectory = "";
  let promptDirectory = "";
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/consumer-root",
    loader: async () => ({
      createOpencode: async () => ({
        client: {
          session: {
            create: async (options: { query?: { directory?: string } }) => {
              createDirectory = options.query?.directory ?? "";
              return { data: { id: "opencode-root" } };
            },
            prompt: async (options: { query?: { directory?: string } }) => {
              promptDirectory = options.query?.directory ?? "";
              return { data: { info: { id: "opencode-message" }, parts: [{ text: "done" }] } };
            },
          },
        },
      }),
    }),
  });

  await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    worktree_path: "agent-owned://opencode/northstar-production/issue-1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  });

  assert.equal(createDirectory, "/consumer-root");
  assert.equal(promptDirectory, "/consumer-root");
});

test("opencode sdk worker supports legacy SDK client shape and applies role agent", async () => {
  let startSessionOptions: Record<string, unknown> = {};
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      createClient: () => ({
        startSession: async (options: Record<string, unknown>) => {
          startSessionOptions = options;
          return { id: "legacy-root" };
        },
        startChild: async () => ({ id: "legacy-child" }),
      }),
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "openai/gpt-5",
      load_skills: ["browser-qa"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.equal(startSessionOptions.agent, "review");
  assert.equal(result.root_session_id, "legacy-root");
  assert.equal(result.child_run_id, "legacy-child");
  assert.equal(result.session_id, "legacy-child");
  assert.equal(result.final_response, "");
  assert.deepEqual(result.capability_report, {
    host: "opencode",
    applied: ["agent"],
    defaulted: [],
    unsupported: ["model", "load_skills"],
  });
});

test("opencode sdk worker rejects missing session APIs", async () => {
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({ createClient: () => ({}) }),
  });

  await assert.rejects(() => worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  }), /HOST_SDK_CONFIG_INVALID/);
});

test("codex sdk worker reports unsupported optional role capabilities and uses role timeout", async () => {
  let timeoutStarted = false;
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    implementationTimeoutMs: 100,
    loader: async () => ({
      Codex: class {
        startThread() {
          return {
            id: "codex-root",
            async run() {
              timeoutStarted = true;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { finalResponse: "late" };
            },
          };
        }
      },
    }),
  });

  await assert.rejects(() => worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 1,
    },
    timeout_ms: 1,
  }), /CODEX_CREDENTIAL_MISSING/);
  assert.equal(timeoutStarted, true);
});

test("codex sdk worker reports capability status for role metadata", async () => {
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread() {
          return {
            id: "codex-root",
            async run() {
              return { finalResponse: "done" };
            },
          };
        }
      },
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.deepEqual(result.capability_report, {
    host: "codex",
    applied: [],
    defaulted: [],
    unsupported: ["agent", "model", "load_skills"],
  });
});

test("opencode sdk worker passes role agent and reports unsupported skills", async () => {
  let createBody: Record<string, unknown> = {};
  const worker = new OpenCodeSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      createOpencode: async () => ({
        client: {
          session: {
            create: async (options: { body?: Record<string, unknown> }) => {
              createBody = options.body ?? {};
              return { data: { id: "opencode-root" } };
            },
            prompt: async () => ({
              data: {
                info: { id: "opencode-message" },
                parts: [{ text: "done" }],
              },
            }),
          },
        },
      }),
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "openai/gpt-5",
      load_skills: ["browser-qa"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.equal(createBody.agent, "review");
  assert.deepEqual(result.capability_report, {
    host: "opencode",
    applied: ["agent"],
    defaulted: [],
    unsupported: ["model", "load_skills"],
  });
});

test("pi sdk worker starts session, prompts, extracts final assistant text, and reports capabilities", async () => {
  const sessionManagers: Array<{ cwd: string }> = [];
  const createOptions: Record<string, unknown>[] = [];
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers,
      createOptions,
      finalText: "pi completed",
      model: { id: "gpt-5", provider: "openai" },
    }),
  });

  const result = await worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    worktree_path: "/repo/.northstar/runtime/worktrees/issue-1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: ["tdd"],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.deepEqual(sessionManagers, [{ cwd: "/repo/.northstar/runtime/worktrees/issue-1" }]);
  assert.equal(createOptions[0].cwd, "/repo/.northstar/runtime/worktrees/issue-1");
  assert.equal((createOptions[0].model as { id: string }).id, "gpt-5");
  assert.equal(result.root_session_id, "pi-session-1");
  assert.equal(result.child_run_id, "pi-session-1:implement");
  assert.equal(result.session_id, "pi-session-1");
  assert.equal(result.final_response, "pi completed");
  assert.deepEqual(result.capability_report, {
    host: "pi",
    applied: ["model"],
    defaulted: ["agent"],
    unsupported: ["load_skills"],
  });
});

test("pi sdk worker defaults unqualified model without passing model option", async () => {
  const createOptions: Record<string, unknown>[] = [];
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers: [],
      createOptions,
      finalText: "verified",
    }),
  });

  const result = await worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.equal("model" in createOptions[0], false);
  assert.equal(result.final_response, "verified");
  assert.deepEqual(result.capability_report, {
    host: "pi",
    applied: [],
    defaulted: ["model", "agent"],
    unsupported: [],
  });
});

test("pi sdk worker uses issue worktree as verification working directory", async () => {
  const sessionManagers: Array<{ cwd: string }> = [];
  const createOptions: Record<string, unknown>[] = [];
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers,
      createOptions,
      finalText: "verified",
    }),
  });

  await worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    worktree_path: "/repo/.northstar/runtime/worktrees/issue-1",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.deepEqual(sessionManagers, [{ cwd: "/repo/.northstar/runtime/worktrees/issue-1" }]);
  assert.equal(createOptions[0].cwd, "/repo/.northstar/runtime/worktrees/issue-1");
});

test("pi sdk worker keeps repo root as verification working directory for agent-owned workspaces", async () => {
  const sessionManagers: Array<{ cwd: string }> = [];
  const createOptions: Record<string, unknown>[] = [];
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers,
      createOptions,
      finalText: "verified",
    }),
  });

  await worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    worktree_path: "agent-owned://pi/northstar-production/issue-1",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.deepEqual(sessionManagers, [{ cwd: "/repo" }]);
  assert.equal(createOptions[0].cwd, "/repo");
});

test("pi sdk worker rejects missing final assistant text", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => fakePiSdk({
      sessionManagers: [],
      createOptions: [],
      finalText: "",
    }),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  }), /PI_EMPTY_FINAL_RESPONSE/);
});

test("pi sdk worker rejects empty session id before reporting stream session", async () => {
  let streamReported = false;
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      SessionManager: {
        create() {
          return {};
        },
      },
      async createAgentSession() {
        return {
          session: {
            sessionId: "",
            subscribe() {
              return () => {};
            },
            async prompt() {},
            dispose() {},
          },
        };
      },
    }),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    timeout_ms: 1,
    on_stream_session_started: async () => {
      streamReported = true;
    },
  }), /HOST_SDK_CONFIG_INVALID/);
  assert.equal(streamReported, false);
});

test("pi sdk worker ignores retrying agent_end events before final assistant text", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      SessionManager: {
        create() {
          return {};
        },
      },
      async createAgentSession() {
        return {
          session: {
            sessionId: "pi-session-retry",
            subscribe(next: (event: unknown) => void) {
              this.listener = next;
              return () => {
                this.listener = undefined;
              };
            },
            async prompt() {
              this.listener?.({
                type: "agent_end",
                willRetry: true,
                messages: [],
              });
              this.listener?.({
                type: "agent_end",
                willRetry: false,
                messages: [{
                  role: "assistant",
                  content: [{ type: "text", text: "final after retry" }],
                }],
              });
            },
            dispose() {},
            listener: undefined as ((event: unknown) => void) | undefined,
          },
        };
      },
    }),
  });

  const result = await worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  });

  assert.equal(result.final_response, "final after retry");
});

test("pi sdk worker cleans up subscription and session on timeout", async () => {
  let unsubscribeCalls = 0;
  let disposeCalls = 0;
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      SessionManager: {
        create() {
          return {};
        },
      },
      async createAgentSession() {
        return {
          session: {
            sessionId: "pi-session-timeout",
            subscribe() {
              return () => {
                unsubscribeCalls += 1;
              };
            },
            async prompt() {},
            dispose() {
              disposeCalls += 1;
            },
          },
        };
      },
    }),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 1,
  }), /PI_CREDENTIAL_MISSING/);
  assert.equal(unsubscribeCalls, 1);
  assert.equal(disposeCalls, 1);
});

test("pi sdk worker preserves timeout error when timeout cleanup throws", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      SessionManager: {
        create() {
          return {};
        },
      },
      async createAgentSession() {
        return {
          session: {
            sessionId: "pi-session-timeout",
            subscribe() {
              return () => {};
            },
            async prompt() {},
            dispose() {
              throw new Error("cleanup failed");
            },
          },
        };
      },
    }),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 1,
  }), /PI_CREDENTIAL_MISSING/);
});

test("pi sdk worker does not prompt when subscribe throws", async () => {
  let promptCalls = 0;
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      SessionManager: {
        create() {
          return {};
        },
      },
      async createAgentSession() {
        return {
          session: {
            sessionId: "pi-session-subscribe-failure",
            subscribe() {
              throw new Error("subscribe failed");
            },
            async prompt() {
              promptCalls += 1;
            },
            dispose() {},
          },
        };
      },
    }),
  });

  await assert.rejects(() => worker.runVerification({
    pr_number: 1,
    pr_url: "https://github.test/pull/1",
    expected_fixture_path: "fixture.json",
    prompt: "verify",
    role_name: "pr_verifier",
    role: {
      run_mode: "background_child",
      agent: "review",
      model: "gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
    timeout_ms: 5_000,
  }), /subscribe failed/);
  assert.equal(promptCalls, 0);
});

test("pi sdk worker rejects malformed model registry for qualified model", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      SessionManager: {
        create() {
          return {};
        },
      },
      ModelRegistry: {
        create() {
          return {};
        },
      },
      async createAgentSession() {
        return {
          session: {
            sessionId: "pi-session-1",
            subscribe() {
              return () => {};
            },
            async prompt() {},
            dispose() {},
          },
        };
      },
    }),
  });

  await assert.rejects(() => worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
    role_name: "issue_worker",
    role: {
      run_mode: "background_child",
      agent: "build",
      model: "openai/gpt-5",
      load_skills: [],
      timeout_seconds: 5,
    },
  }), /HOST_SDK_CONFIG_INVALID/);
});

test("pi sdk worker rejects invalid sdk shape", async () => {
  const worker = new PiSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({}),
  });

  await assert.rejects(() => worker.runImplementation({
    issue_number: 1,
    issue_url: "https://github.test/issues/1",
    repo: "owner/repo",
    branch: "northstar/1",
    fixture_path: "fixture.json",
    fixture_content: "{}",
    prompt: "implement",
  }), /HOST_SDK_CONFIG_INVALID/);
});

test("codex sdk worker supports release execution", async () => {
  const worker = new CodexSdkSoftwareDevWorker({
    workingDirectory: "/repo",
    loader: async () => ({
      Codex: class {
        startThread() {
          return {
            id: "codex-root",
            async run() {
              return { finalResponse: "released" };
            },
          };
        }
      },
    }),
  });

  const result = await worker.runRelease({
    prompt: "release",
  });

  assert.equal(result.root_session_id, "codex-root");
  assert.equal(result.child_run_id, "codex-root:release");
  assert.equal(result.final_response, "released");
});

function fakePiSdk(input: {
  sessionManagers: Array<{ cwd: string }>;
  createOptions: Record<string, unknown>[];
  finalText: string;
  model?: { id: string; provider: string };
}) {
  return {
    SessionManager: {
      create(cwd: string) {
        input.sessionManagers.push({ cwd });
        return { cwd };
      },
    },
    ModelRegistry: {
      create() {
        return {
          find(provider: string, modelId: string) {
            if (!input.model) return undefined;
            return input.model.provider === provider && input.model.id === modelId ? input.model : undefined;
          },
        };
      },
    },
    getAgentDir() {
      return "/home/test/.pi/agent";
    },
    async createAgentSession(options: Record<string, unknown>) {
      input.createOptions.push(options);
      let listener: ((event: unknown) => void) | undefined;
      return {
        session: {
          sessionId: "pi-session-1",
          sessionFile: "/home/test/.pi/agent/sessions/repo/session.jsonl",
          subscribe(next: (event: unknown) => void) {
            listener = next;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({
              type: "agent_end",
              willRetry: false,
              messages: [{
                role: "assistant",
                content: input.finalText
                  ? [{ type: "text", text: input.finalText }]
                  : [],
              }],
            });
          },
          dispose() {},
        },
      };
    },
  };
}

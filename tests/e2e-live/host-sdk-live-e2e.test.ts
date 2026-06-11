import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { CodexHostAdapter, type CodexSdk } from "../../src/adapters/host/codex.ts";
import { OpenCodeHostAdapter, type OpenCodeSdk } from "../../src/adapters/host/opencode.ts";
import type { HostAdapter } from "../../src/types/host.ts";
import type { RoleDefinition } from "../../src/types/workflow.ts";
import { emptyLiveE2EMetrics, formatLiveSummary } from "./live-metrics.ts";
import { liveSdkEnabled } from "./live-env.ts";

const noopRole: RoleDefinition = {
  run_mode: "background_child",
  agent: "noop",
  model: "live-smoke",
  load_skills: [],
  artifact: "worker_result",
  timeout_seconds: 120,
};

test("live OpenCode and Codex SDKs start no-op root and child runs", async (t) => {
  if (!liveSdkEnabled("opencode") && !liveSdkEnabled("codex")) {
    t.skip("Set NORTHSTAR_LIVE_OPENCODE=1 and NORTHSTAR_LIVE_CODEX=1 to run live SDK E2E.");
    return;
  }

  const metrics = emptyLiveE2EMetrics();
  const started = Date.now();
  if (liveSdkEnabled("opencode")) {
    await runSdkSmoke("opencode", await runOpenCodeProbe(), metrics);
  }
  if (liveSdkEnabled("codex")) {
    await runSdkSmoke("codex", await runCodexProbe(), metrics);
  }
  metrics.sdk_live_duration_seconds = Math.ceil((Date.now() - started) / 1000);
  t.diagnostic(formatLiveSummary(metrics));

  assert.equal(metrics.sdk_packages_loaded, 2);
  assert.equal(metrics.sdk_root_sessions_started, 2);
  assert.equal(metrics.sdk_background_children_started, 2);
  assert.ok(metrics.sdk_status_reads >= 2);
  assert.equal(metrics.sdk_shell_fallbacks, 0);
  assert.equal(metrics.sdk_live_timeouts, 0);
  assert.ok(metrics.sdk_live_duration_seconds <= 240);
});

interface SdkProbeResult {
  rootId: string;
  childId: string;
  childSessionId: string;
}

async function runSdkSmoke(name: "opencode" | "codex", probe: SdkProbeResult, metrics: ReturnType<typeof emptyLiveE2EMetrics>): Promise<void> {
  metrics.sdk_packages_loaded += 1;
  const adapter = makeLiveAdapter(name, probe);
  const root = await withTimeout(Promise.resolve(adapter.startRootSession({
    issue_id: `live-${name}-issue`,
    role_name: "noop",
    role: noopRole,
  })), 120_000, `${name} root session timed out`);
  metrics.sdk_root_sessions_started += 1;
  const child = await withTimeout(Promise.resolve(adapter.startBackgroundChild({
    issue_id: `live-${name}-issue`,
    lease_id: `live-${name}-lease`,
    root_session_id: root.root_session_id,
    role_name: "noop",
    role: noopRole,
  })), 120_000, `${name} child run timed out`);
  metrics.sdk_background_children_started += 1;
  const rootStatus = adapter.readRootStatus(root.root_session_id);
  const childStatus = adapter.readChildStatus(child.child_run_id);
  if (rootStatus.status) metrics.sdk_status_reads += 1;
  if (childStatus.status) metrics.sdk_status_reads += 1;
}

function makeLiveAdapter(name: "opencode" | "codex", probe: SdkProbeResult): HostAdapter {
  if (name === "opencode") {
    return new OpenCodeHostAdapter({
      sessions: {
        start: () => ({ id: probe.rootId }),
        heartbeat: () => undefined,
        status: (sessionId) => ({ status: sessionId === probe.rootId ? "live" : "unknown" }),
        resumeHint: (sessionId) => `opencode:${sessionId}`,
      },
      children: {
        start: () => ({ id: probe.childId, sessionId: probe.childSessionId }),
        status: (childRunId) => ({ status: childRunId === probe.childId ? "running" : "unknown" }),
      },
    } satisfies OpenCodeSdk);
  }
  return new CodexHostAdapter({
    root: {
      start: () => ({ id: probe.rootId }),
      ping: () => undefined,
      status: (sessionId) => ({ status: sessionId === probe.rootId ? "live" : "unknown" }),
      resume: (sessionId) => `codex:${sessionId}`,
    },
    child: {
      start: () => ({ id: probe.childId, sessionId: probe.childSessionId }),
      status: (childRunId) => ({ status: childRunId === probe.childId ? "running" : "unknown" }),
    },
  } satisfies CodexSdk);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runOpenCodeProbe(): Promise<SdkProbeResult> {
  return await runProbeScript(`
    const sdk = await import("@opencode-ai/sdk");
    const smoke = await sdk.createOpencode({ timeout: 30000 });
    try {
      const root = await smoke.client.session.create({ body: { title: "northstar live root" } });
      const rootId = root.data?.id;
      const child = await smoke.client.session.create({ body: { title: "northstar live child", parentID: rootId } });
      const childId = child.data?.id;
      if (!rootId || !childId) throw new Error("OpenCode live probe did not return session ids");
      console.log(JSON.stringify({ rootId, childId, childSessionId: childId }));
    } finally {
      smoke.server.close();
      setTimeout(() => process.exit(0), 250);
    }
  `, 45_000, "OpenCode SDK live probe timed out");
}

async function runCodexProbe(): Promise<SdkProbeResult> {
  return await runProbeScript(`
    const sdk = await import("@openai/codex-sdk");
    const codex = new sdk.Codex();
    const root = codex.startThread({ workingDirectory: process.cwd(), skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", modelReasoningEffort: "low" });
    const rootTurn = await root.run("Reply exactly NORTHSTAR_SMOKE_OK. Do not inspect or modify files.");
    const child = codex.startThread({ workingDirectory: process.cwd(), skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", modelReasoningEffort: "low" });
    const childTurn = await child.run("Reply exactly NORTHSTAR_CHILD_SMOKE_OK. Do not inspect or modify files.");
    if (!root.id || !child.id) throw new Error("Codex live probe did not return thread ids");
    if (!rootTurn.finalResponse || !childTurn.finalResponse) throw new Error("Codex live probe did not return final responses");
    console.log(JSON.stringify({ rootId: root.id, childId: child.id, childSessionId: child.id }));
  `, 180_000, "Codex SDK live probe timed out");
}

async function runProbeScript(script: string, timeoutMs: number, timeoutMessage: string): Promise<SdkProbeResult> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => stdout += String(chunk));
  child.stderr?.on("data", (chunk) => stderr += String(chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`${timeoutMessage}; exit=${code}; stderr=${redact(stderr)}`);
  }
  const lines = stdout.trim().split(/\n/).filter(Boolean);
  const parsed = JSON.parse(lines.at(-1) ?? "{}") as Partial<SdkProbeResult>;
  if (!parsed.rootId || !parsed.childId || !parsed.childSessionId) {
    throw new Error(`SDK live probe did not return required ids; stdout=${redact(stdout)} stderr=${redact(stderr)}`);
  }
  return parsed as SdkProbeResult;
}

function redact(value: string): string {
  return value
    .replace(/gho_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_OPENAI_KEY]")
    .replace(/authorization:\s*bearer\s+\S+/gi, "authorization: bearer [REDACTED]");
}

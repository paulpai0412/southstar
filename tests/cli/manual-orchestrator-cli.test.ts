import test from "node:test";
import assert from "node:assert/strict";
import { main, createManualOrchestratorCommandRunner } from "../../src/cli/entrypoint.ts";

test("manual orchestrator CLI commands require issue selector", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (line?: unknown) => errors.push(String(line));
  try {
    const code = await main(["start", "--config", "tests/fixtures/.northstar.yaml"]);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /--issue is required/);
  } finally {
    console.error = originalError;
  }
});

test("inspect command accepts issue selector and config", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => logs.push(String(line));
  try {
    const code = await main(["inspect", "--issue", "101", "--config", "tests/fixtures/.northstar.yaml", "--dry-run"]);
    assert.equal(code, 0);
    assert.match(logs.join("\n"), /"type":"inspect"/);
    assert.match(logs.join("\n"), /"issue":"101"/);
  } finally {
    console.log = originalLog;
  }
});

test("manual command runner dispatches non-dry-run commands to orchestrator", async () => {
  const calls: string[] = [];
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async () => ({ ok: true }),
      startIssue: async (input) => {
        calls.push(`start:${input.issueId}`);
        return { ok: true };
      },
      reconcileIssue: async () => ({ ok: true }),
      releaseIssue: async () => ({ ok: true }),
      repairRuntime: async () => ({ ok: true }),
      resumeIssue: async () => ({ ok: true }),
      retrySyncIssue: async () => ({ ok: true }),
      inspectIssue: () => ({ ok: true }),
    }),
  });

  const result = await runner(["start", "--issue", "101", "--config", "tests/fixtures/.northstar.yaml"]);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, ["start:github:101"]);
});

test("manual command runner covers dry-run fallback and intake guard", async () => {
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async () => ({ ok: true }),
      startIssue: async () => ({ ok: true }),
      reconcileIssue: async () => ({ ok: true }),
      releaseIssue: async () => ({ ok: true }),
      repairRuntime: async () => ({ ok: true }),
      resumeIssue: async () => ({ ok: true }),
      retrySyncIssue: async () => ({ ok: true }),
      inspectIssue: () => ({ ok: true }),
    }),
  });

  assert.deepEqual(await runner(["release", "--issue", "77", "--config", "tests/fixtures/.northstar.yaml", "--dry-run"]), {
    type: "release",
    issue: "77",
  });
  await assert.rejects(
    () => runner(["intake", "--config", "tests/fixtures/.northstar.yaml"]),
    /intake requires --issue or --label/,
  );

  await assert.rejects(
    () => runner(["resume", "--issue", "77", "--config", "tests/fixtures/.northstar.yaml"]),
    /--reason is required/,
  );
  await assert.rejects(
    () => runner(["resume", "--issue", "77", "--to", "invalid", "--reason", "retry", "--config", "tests/fixtures/.northstar.yaml"]),
    /--to must be ready or running/,
  );
});

test("retry-sync dispatches pending projection repair for the selected issue", async () => {
  const calls: string[] = [];
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async () => ({ ok: true }),
      startIssue: async () => ({ ok: true }),
      reconcileIssue: async () => ({ ok: true }),
      releaseIssue: async () => ({ ok: true }),
      repairRuntime: async () => ({ ok: true }),
      resumeIssue: async () => ({ ok: true }),
      retrySyncIssue: async (input) => {
        calls.push(`retry-sync:${input.issueId}`);
        return { synced: ["github_project"], skipped: [], failed: [] };
      },
      inspectIssue: () => ({ ok: true }),
    }),
  });

  const result = await runner(["retry-sync", "--issue", "77", "--config", "tests/fixtures/.northstar.yaml"]);

  assert.deepEqual(result, { synced: ["github_project"], skipped: [], failed: [] });
  assert.deepEqual(calls, ["retry-sync:github:77"]);
});

test("manual command runner accepts already-prefixed github issue ids", async () => {
  const calls: string[] = [];
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async () => ({ ok: true }),
      startIssue: async () => ({ ok: true }),
      reconcileIssue: async () => ({ ok: true }),
      releaseIssue: async () => ({ ok: true }),
      repairRuntime: async () => ({ ok: true }),
      resumeIssue: async (input) => {
        calls.push(`resume:${input.issueId}:${input.targetLifecycle}:${input.reason}`);
        return { resumed: true };
      },
      retrySyncIssue: async () => ({ ok: true }),
      inspectIssue: () => ({ ok: true }),
    }),
  });

  await runner(["resume", "--issue", "github:77", "--to", "ready", "--reason", "fixed", "--config", "tests/fixtures/.northstar.yaml"]);

  assert.deepEqual(calls, ["resume:github:77:ready:fixed"]);
});

test("manual command runner dispatches reconcile release inspect and labeled intake fallbacks", async () => {
  const calls: string[] = [];
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async (input) => {
        calls.push(`intake:${input.title}:${input.labels.join(",")}`);
        return { ok: true };
      },
      startIssue: async () => ({ ok: true }),
      reconcileIssue: async (input) => {
        calls.push(`reconcile:${input.issueId}`);
        return { ok: true };
      },
      releaseIssue: async (input) => {
        calls.push(`release:${input.issueId}:${input.autoRelease}`);
        return { ok: true };
      },
      repairRuntime: async (input) => {
        calls.push(`repair-runtime:${input.issueId}`);
        return { repaired: true };
      },
      resumeIssue: async (input) => {
        calls.push(`resume:${input.issueId}:${input.targetLifecycle}:${input.reason}`);
        return { resumed: true };
      },
      retrySyncIssue: async () => ({ ok: true }),
      inspectIssue: (input) => {
        calls.push(`inspect:${input.issueId}`);
        return { ok: true };
      },
    }),
  });

  await runner(["reconcile", "--issue", "101", "--config", "tests/fixtures/.northstar.yaml"]);
  await runner(["release", "--issue", "102", "--config", "tests/fixtures/.northstar.yaml"]);
  await runner(["repair-runtime", "--issue", "104", "--config", "tests/fixtures/.northstar.yaml"]);
  await runner(["inspect", "--issue", "103", "--config", "tests/fixtures/.northstar.yaml"]);
  await runner(["resume", "--issue", "105", "--to", "running", "--reason", "fixed runtime bug", "--config", "tests/fixtures/.northstar.yaml"]);
  await runner(["resume", "--issue", "github:106", "--to", "ready", "--reason", "manual retry", "--config", "tests/fixtures/.northstar.yaml"]);
  await runner(["intake", "--label", "northstar:ready", "--title", "Fallback title", "--body", "Fallback body", "--config", "tests/fixtures/.northstar.yaml"]);

  assert.deepEqual(calls, [
    "reconcile:github:101",
    "release:github:102:false",
    "repair-runtime:github:104",
    "inspect:github:103",
    "resume:github:105:running:fixed runtime bug",
    "resume:github:106:ready:manual retry",
    "intake:Fallback title:northstar:ready",
  ]);
});

test("manual intake reads issue details from production github intake adapter", async () => {
  const calls: unknown[] = [];
  const runner = createManualOrchestratorCommandRunner({
    createOrchestrator: async () => ({
      intakeIssue: async (input) => {
        calls.push(input);
        return { ok: true };
      },
      startIssue: async () => ({ ok: true }),
      reconcileIssue: async () => ({ ok: true }),
      releaseIssue: async () => ({ ok: true }),
      repairRuntime: async () => ({ ok: true }),
      resumeIssue: async () => ({ ok: true }),
      retrySyncIssue: async () => ({ ok: true }),
      inspectIssue: () => ({ ok: true }),
    }),
    readIssue: async (issueNumber) => ({
      issueId: `github:${issueNumber}`,
      number: issueNumber,
      title: "GitHub title",
      body: "GitHub body",
      sourceUrl: "https://github.com/owner/repo/issues/55",
      labels: ["northstar:ready"],
      dependencies: [],
      dependencyDiscovery: {
        markerDependencies: [],
        nativeLinkedIssueDependencies: [],
        nativeLinkedIssueDependenciesDiscovered: 0,
        duplicatesRemoved: 0,
        nativeLinkedIssueApiFailureRetryable: 0,
        nativeLinkedIssueApiFailureDoesNotFailLifecycle: 1,
      },
    }),
  });

  await runner(["intake", "--issue", "55", "--config", "tests/fixtures/.northstar.yaml"]);

  assert.deepEqual(calls[0], {
    issueNumber: 55,
    title: "GitHub title",
    body: "GitHub body",
    sourceUrl: "https://github.com/owner/repo/issues/55",
    labels: ["northstar:ready"],
  });
});

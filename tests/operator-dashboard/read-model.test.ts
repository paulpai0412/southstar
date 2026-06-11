import test from "node:test";
import assert from "node:assert/strict";
import { buildNorthstarBoard, buildNorthstarIssueDetail } from "../../src/operator-dashboard/read-model.ts";
import { defaultNorthstarProjectCapabilities, type NorthstarProjectSummary } from "../../src/operator-dashboard/models.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import type { HistoryEntry } from "../../src/types/control-plane.ts";

const project: NorthstarProjectSummary = {
  projectId: "northstar-test",
  name: "northstar-test",
  root: "/repo",
  repo: "owner/repo",
  hostAdapter: "pi",
  configPath: "/repo/.northstar.yaml",
  runtimeDbPath: "/repo/.northstar/runtime/control-plane.sqlite3",
  capabilities: defaultNorthstarProjectCapabilities,
};

test("board groups issues by lifecycle and preserves host adapter parity", () => {
  const ready = newIssueSnapshot("github:1", {
    lifecycle_state: "ready",
  });
  ready.runtime_context_json.issue_packet = {
    issue_number: "1",
    title: "Ready task",
    source_url: "https://github.com/owner/repo/issues/1",
    labels: ["northstar:ready"],
    dependencies: [],
  };

  const running = newIssueSnapshot("github:2", {
    lifecycle_state: "running",
    stage_cursor: "implementation",
  });
  running.runtime_context_json.child_runs = [{
    child_run_id: "child-2",
    lease_id: "lease-2",
    root_session_id: "root-2",
    role: "developer",
    status: "running",
    session_id: "pi-session-2",
    started_at: "2026-06-02T01:00:00.000Z",
    last_seen_at: "2026-06-02T01:01:00.000Z",
    capability_report: {
      host: "pi",
      applied: ["agent", "model"],
      defaulted: [],
      unsupported: ["mcp_servers"],
    },
  }];

  const board = buildNorthstarBoard({
    project,
    issues: [ready, running],
    historiesByIssueId: new Map(),
    now: "2026-06-02T01:02:00.000Z",
  });

  assert.deepEqual(board.groups.find((group) => group.lifecycle === "ready")?.cards.map((card) => card.issueId), ["github:1"]);
  assert.deepEqual(board.groups.find((group) => group.lifecycle === "running")?.cards.map((card) => card.latestHostAdapter), ["pi"]);
  assert.deepEqual(board.project.capabilities.hostAdapters, ["codex", "opencode", "pi"]);
  assert.deepEqual(board.project.capabilities.optionalParameters, ["skill", "model"]);
  assert.equal(board.project.capabilities.mcpServers.status, "design_only");
  assert.equal(board.project.capabilities.mcpServers.configurable, false);
});

test("board selects the active stage stream session instead of the latest completed run", () => {
  const snapshot = newIssueSnapshot("github:stream", {
    lifecycle_state: "verifying",
    owner_lease: {
      lease_id: "lease-verification",
      root_session_id: "planned-root-verification",
      role: "verifier_agent",
      generation: 1,
      heartbeat_seq: 0,
      last_heartbeat_at: "2026-06-02T01:04:00.000Z",
      expires_at: "2026-06-02T01:14:00.000Z",
    },
    stage_cursor: "verification",
  });
  snapshot.runtime_context_json.child_runs = [
    {
      child_run_id: "planned-child-implementation",
      lease_id: "lease-implementation",
      root_session_id: "planned-root-implementation",
      role: "implementation_agent",
      status: "succeeded",
      session_id: "planned-root-implementation",
      stream_adapter: "codex",
      stream_session_id: "codex-implementation-session",
      started_at: "2026-06-02T01:00:00.000Z",
      last_seen_at: "2026-06-02T01:02:00.000Z",
      capability_report: {
        host: "codex",
        applied: [],
        defaulted: [],
        unsupported: [],
      },
    },
    {
      child_run_id: "planned-child-verification",
      lease_id: "lease-verification",
      root_session_id: "planned-root-verification",
      role: "verifier_agent",
      status: "running",
      session_id: "planned-root-verification",
      stream_adapter: "codex",
      stream_session_id: "codex-verification-session",
      started_at: "2026-06-02T01:03:00.000Z",
      last_seen_at: "2026-06-02T01:04:00.000Z",
      capability_report: {
        host: "codex",
        applied: [],
        defaulted: [],
        unsupported: [],
      },
    },
    {
      child_run_id: "planned-child-release",
      lease_id: "lease-release",
      root_session_id: "planned-root-release",
      role: "release_agent",
      status: "queued",
      session_id: "planned-root-release",
      started_at: "2026-06-02T01:05:00.000Z",
      last_seen_at: "2026-06-02T01:05:00.000Z",
    },
  ];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T01:05:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "verifying")?.cards[0];
  assert.equal(card?.activeStreamAdapter, "codex");
  assert.equal(card?.activeStreamSessionId, "codex-verification-session");
  assert.equal(card?.activeStreamChildRunId, "planned-child-verification");
  assert.equal(card?.latestRootSessionId, "planned-root-release");
});

test("issue detail includes compact timeline, redacted payload preview, and Pi session link", () => {
  const snapshot = newIssueSnapshot("github:7", { lifecycle_state: "running" });
  snapshot.runtime_context_json.issue_packet = {
    issue_number: "7",
    title: "Inspect task",
    source_url: "https://github.com/owner/repo/issues/7",
    labels: ["northstar:ready"],
    dependencies: [],
  };
  snapshot.runtime_context_json.child_runs = [{
    child_run_id: "child-7",
    lease_id: "lease-7",
    root_session_id: "root-7",
    role: "developer",
    status: "running",
    session_id: "pi-session-7",
    started_at: "2026-06-02T02:00:00.000Z",
    last_seen_at: "2026-06-02T02:01:00.000Z",
    capability_report: {
      host: "pi",
      applied: ["agent"],
      defaulted: ["model"],
      unsupported: [],
    },
  }];
  const history: HistoryEntry[] = [{
    id: 1,
    sequence: 1,
    event_type: "effect_failed_retryable",
    created_at: "2026-06-02T02:01:00.000Z",
    payload: { last_error: "token ghp_abcdefghijklmnopqrstuvwxyz123456 leaked" },
  }];

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T02:02:00.000Z",
  });

  assert.equal(detail.title, "Inspect task");
  assert.equal(detail.timeline[0].severity, "error");
  assert.match(JSON.stringify(detail.timeline[0].payloadPreview), /ghp_\*\*\*/);
  assert.equal(detail.sessionLinks[0].host, "pi");
  assert.equal(detail.sessionLinks[0].href, "/?session=pi-session-7");
});

test("issue detail redacts secrets from snapshot, inspect output, and timeline summaries", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const snapshot = newIssueSnapshot("github:secret", { lifecycle_state: "running" });
  snapshot.runtime_context_json.issue_packet = {
    title: "Secret task",
    labels: ["northstar:ready"],
    dependencies: [],
  };
  snapshot.runtime_context_json.pr = {
    url: `https://github.com/owner/repo/pull/1?token=${secret}`,
  };
  snapshot.runtime_context_json.child_runs = [{
    child_run_id: "child-secret",
    lease_id: "lease-secret",
    root_session_id: "root-secret",
    role: "developer",
    status: "running",
    session_id: "pi-session-secret",
    started_at: "2026-06-02T03:00:00.000Z",
    last_seen_at: "2026-06-02T03:01:00.000Z",
    capability_report: {
      host: "pi",
      applied: ["agent"],
      defaulted: [],
      unsupported: [],
    },
    rawToken: secret,
  }];
  const history: HistoryEntry[] = [{
    id: 2,
    sequence: 2,
    event_type: "effect_failed_retryable",
    created_at: "2026-06-02T03:01:00.000Z",
    payload: { summary: `retry failed with ${secret}` },
  }];

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T03:02:00.000Z",
  });

  assert.doesNotMatch(JSON.stringify(detail.snapshot), /ghp_/);
  assert.doesNotMatch(JSON.stringify(detail.inspect), /ghp_/);
  assert.doesNotMatch(detail.timeline[0].summary, /ghp_/);
  assert.match(JSON.stringify(detail.snapshot), /\[REDACTED\]/);
  assert.match(JSON.stringify(detail.inspect), /\[REDACTED\]/);
  assert.match(detail.timeline[0].summary, /\[REDACTED\]/);
});

test("payload preview suppresses raw log fields and truncates long strings", () => {
  const longMessage = "a".repeat(650);
  const snapshot = newIssueSnapshot("github:preview", { lifecycle_state: "running" });
  const history: HistoryEntry[] = [{
    id: 3,
    sequence: 3,
    event_type: "child_run_heartbeat",
    created_at: "2026-06-02T04:01:00.000Z",
    payload: {
      raw_transcript: "line 1\nline 2\nline 3",
      terminal_log: "npm test output",
      raw_browser_trace: { events: ["click", "type"] },
      full_log: ["entry"],
      transcript: "operator transcript",
      raw_session_jsonl: "{\"token\":\"secret\"}",
      message: longMessage,
    },
  }];

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T04:02:00.000Z",
  });
  const preview = detail.timeline[0].payloadPreview as Record<string, unknown>;

  assert.equal(preview.raw_transcript, "[redacted raw content]");
  assert.equal(preview.terminal_log, "[redacted raw content]");
  assert.equal(preview.raw_browser_trace, "[redacted raw content]");
  assert.equal(preview.full_log, "[redacted raw content]");
  assert.equal(preview.transcript, "[redacted raw content]");
  assert.equal(preview.raw_session_jsonl, "[redacted raw content]");
  assert.equal(typeof preview.message, "string");
  assert.equal((preview.message as string).length, 514);
  assert.match(preview.message as string, /\.\.\.\[truncated\]$/);
});

test("accepted artifact summaries include canonical artifact history id and bounded redacted summary", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const snapshot = newIssueSnapshot("github:artifact", { lifecycle_state: "running" });
  const history: HistoryEntry[] = [
    {
      id: 42,
      sequence: 42,
      event_type: "artifact_submitted",
      created_at: "2026-06-02T05:00:00.000Z",
      payload: {
        artifact_kind: "verification_report",
        summary: `Accepted artifact ${secret} ${"b".repeat(650)}`,
      },
    },
    {
      id: 8,
      sequence: 8,
      event_type: "child_artifact_received",
      created_at: "2026-06-02T05:01:00.000Z",
      payload: {
        status: "succeeded",
        artifact_history_id: 42,
      },
    },
  ];

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T05:02:00.000Z",
  });
  const artifact = detail.acceptedArtifacts[0] as Record<string, unknown>;

  assert.equal(detail.acceptedArtifacts.length, 1);
  assert.equal(artifact.historyId, 8);
  assert.equal(detail.acceptedArtifacts[0].artifactHistoryId, 42);
  assert.equal(artifact.artifact_history_id, 42);
  assert.equal(artifact.kind, "verification_report");
  assert.doesNotMatch(artifact.summary as string, /ghp_/);
  assert.match(artifact.summary as string, /\[REDACTED\]/);
  assert.match(artifact.summary as string, /\.\.\.\[truncated\]$/);
  assert.ok((artifact.summary as string).length <= 514);
});

test("accepted artifact summaries are capped at 20 most recent successful receipts", () => {
  const snapshot = newIssueSnapshot("github:artifact-cap", { lifecycle_state: "running" });
  const history: HistoryEntry[] = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    sequence: index + 1,
    event_type: "child_artifact_received",
    created_at: `2026-06-02T05:${String(index).padStart(2, "0")}:00.000Z`,
    payload: {
      status: "succeeded",
      artifact_history_id: 100 + index,
      summary: `Artifact ${index + 1}`,
    },
  }));

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T05:30:00.000Z",
  });

  assert.equal(detail.acceptedArtifacts.length, 20);
  assert.deepEqual(detail.acceptedArtifacts.map((artifact) => artifact.historyId), Array.from({ length: 20 }, (_, index) => index + 6));
  assert.deepEqual(detail.acceptedArtifacts.map((artifact) => artifact.artifactHistoryId), Array.from({ length: 20 }, (_, index) => index + 105));
});

test("projection retry for one target remains retry-sync after success for another target", () => {
  const snapshot = newIssueSnapshot("github:projection-target", { lifecycle_state: "verified" });
  snapshot.runtime_context_json.projection_sync = [
    {
      projection_target: "github_project",
      status: "retryable",
      last_error: "rate limited",
    },
    {
      projection_target: "github_observability",
      status: "success",
    },
  ];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T06:02:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "verified")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "retry-sync");
});

test("projection failure clears when the same target later succeeds", () => {
  const snapshot = newIssueSnapshot("github:projection-cleared", { lifecycle_state: "running" });
  snapshot.runtime_context_json.projection_sync = [
    {
      projection_target: "github_project",
      status: "retryable",
      last_error: "rate limited",
    },
    {
      projection_target: "github_project",
      status: "success",
    },
  ];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T06:02:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "running")?.cards[0];
  assert.equal(card?.projectionFailure, false);
});

test("projection failure remains when another target succeeds after an unresolved retry", () => {
  const snapshot = newIssueSnapshot("github:projection-unresolved", { lifecycle_state: "running" });
  snapshot.runtime_context_json.projection_sync = [
    {
      projection_target: "github_project",
      status: "failed",
      last_error: "rate limited",
    },
    {
      projection_target: "github_observability",
      status: "success",
    },
  ];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T06:02:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "running")?.cards[0];
  assert.equal(card?.projectionFailure, true);
});

test("quarantined issue recommends resume action", () => {
  const snapshot = newIssueSnapshot("github:quarantine-resume", { lifecycle_state: "quarantined" });

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T06:02:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "quarantined")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "resume");
});

test("quarantined issue keeps resume recommendation despite retryable effects", () => {
  const snapshot = newIssueSnapshot("github:quarantine-retryable", { lifecycle_state: "quarantined" });
  const history: HistoryEntry[] = [{
    id: 11,
    sequence: 11,
    event_type: "effect_failed_retryable",
    created_at: "2026-06-02T06:03:00.000Z",
    payload: {
      effect_type: "github_project",
      status: "failed",
      last_error: "project sync retryable",
    },
  }];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map([[snapshot.issue_id, history]]),
    now: "2026-06-02T06:04:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "quarantined")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "resume");
});

test("release pending issue exposes approval action for the issue drawer", () => {
  const snapshot = newIssueSnapshot("github:release-pending", {
    lifecycle_state: "release_pending",
    stage_cursor: "release",
  });

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T06:04:00.000Z",
  });
  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history: [],
    now: "2026-06-02T06:04:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "release_pending")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "approve-release");
  assert.deepEqual(detail.availableActions, [{
    action: "release",
    label: "Approve Release",
    requiresConfirmation: true,
    style: "primary",
  }]);
});

test("releasing issue recommends reconcile and has no manual approval action", () => {
  const snapshot = newIssueSnapshot("github:releasing", {
    lifecycle_state: "releasing",
    stage_cursor: "release",
  });

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map(),
    now: "2026-06-02T06:04:00.000Z",
  });
  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history: [],
    now: "2026-06-02T06:04:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "releasing")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "reconcile");
  assert.deepEqual(detail.availableActions, []);
});

test("effect retry for one effect remains retry-sync after success for another effect", () => {
  const snapshot = newIssueSnapshot("github:effect-target", { lifecycle_state: "verified" });
  const history: HistoryEntry[] = [
    {
      id: 1,
      sequence: 1,
      event_type: "effect_failed_retryable",
      created_at: "2026-06-02T06:00:00.000Z",
      payload: {
        effect_type: "github_project",
        effect_id: "project-sync",
        status: "failed",
        last_error: "rate limited",
      },
    },
    {
      id: 2,
      sequence: 2,
      event_type: "effect_result",
      created_at: "2026-06-02T06:01:00.000Z",
      payload: {
        effect_type: "github_observability",
        effect_id: "observability-sync",
        status: "succeeded",
      },
    },
  ];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map([[snapshot.issue_id, history]]),
    now: "2026-06-02T06:02:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "verified")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "retry-sync");
});

test("canonical child artifact receipt derives accepted artifact details from referenced history row", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const snapshot = newIssueSnapshot("github:canonical-artifact", { lifecycle_state: "running" });
  const history: HistoryEntry[] = [
    {
      id: 42,
      sequence: 42,
      event_type: "artifact_submitted",
      created_at: "2026-06-02T05:00:00.000Z",
      payload: {
        artifact_kind: "worker_result",
        kind: "legacy_kind",
        summary: `Worker artifact ${secret} ${"c".repeat(650)}`,
      },
    },
    {
      id: 43,
      sequence: 43,
      event_type: "child_artifact_received",
      created_at: "2026-06-02T05:01:00.000Z",
      payload: {
        child_run_id: "child-1",
        status: "succeeded",
        artifact_history_id: 42,
      },
    },
  ];

  const detail = buildNorthstarIssueDetail({
    project,
    snapshot,
    history,
    now: "2026-06-02T05:02:00.000Z",
  });
  const artifact = detail.acceptedArtifacts[0] as Record<string, unknown>;

  assert.equal(detail.acceptedArtifacts.length, 1);
  assert.equal(artifact.historyId, 43);
  assert.equal(artifact.artifact_history_id, 42);
  assert.equal(artifact.kind, "worker_result");
  assert.doesNotMatch(artifact.summary as string, /ghp_/);
  assert.match(artifact.summary as string, /\[REDACTED\]/);
  assert.match(artifact.summary as string, /\.\.\.\[truncated\]$/);
  assert.ok((artifact.summary as string).length <= 514);
});

test("stale retryable effect history does not override later verified release recommendation", () => {
  const snapshot = newIssueSnapshot("github:release", { lifecycle_state: "verified" });
  snapshot.runtime_context_json.projection_sync = [{
    projection_target: "github_project",
    status: "success",
  }];
  const history: HistoryEntry[] = [
    {
      id: 1,
      sequence: 1,
      event_type: "effect_failed_retryable",
      created_at: "2026-06-02T06:00:00.000Z",
      payload: {
        effect_type: "github_project",
        status: "failed",
        last_error: "rate limited",
      },
    },
    {
      id: 2,
      sequence: 2,
      event_type: "effect_result",
      created_at: "2026-06-02T06:01:00.000Z",
      payload: {
        effect_type: "github_project",
        status: "succeeded",
      },
    },
  ];

  const board = buildNorthstarBoard({
    project,
    issues: [snapshot],
    historiesByIssueId: new Map([[snapshot.issue_id, history]]),
    now: "2026-06-02T06:02:00.000Z",
  });

  const card = board.groups.find((group) => group.lifecycle === "verified")?.cards[0];
  assert.equal(card?.nextRecommendedAction, "release");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNorthstarLocalApi } from "../../src/operator-dashboard/local-api.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

test("local API reads project board, issue detail, events, and wizard state", async () => {
  const fixture = await createLocalApiFixture();
  try {
    const api = createNorthstarLocalApi({
      configPath: fixture.configPath,
      now: () => "2026-06-02T08:00:00.000Z",
    });

    const board = api.getBoard();
    const detail = api.getIssue("github:11");
    const events = api.listIssueEvents("github:11");
    const wizard = api.getWizard();

    assert.equal(board.project.repo, "owner/repo");
    assert.deepEqual(board.project.capabilities.hostAdapters, ["codex", "opencode", "pi"]);
    assert.deepEqual(board.project.capabilities.optionalParameters, ["skill", "model"]);
    assert.equal(board.project.capabilities.mcpServers.status, "design_only");
    assert.equal(board.groups.find((group) => group.lifecycle === "ready")?.cards.length, 1);
    assert.equal(detail.title, "Dashboard issue");
    assert.equal(events[0].eventType, "runtime_event");
    assert.equal(wizard.currentPhase, "plan");
    assert.equal(wizard.selectedOptions.planIssuesCliAvailable, true);
  } finally {
    await fixture.cleanup();
  }
});

test("local API rejects non-allowlisted operator actions", async () => {
  const fixture = await createLocalApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });

    await assert.rejects(
      () => api.runIssueAction({ action: "shell" as never, issueId: "github:11" }),
      /NORTHSTAR_OPERATOR_ACTION_NOT_ALLOWED/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("local API requires confirmation for release actions", async () => {
  const fixture = await createLocalApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });

    await assert.rejects(
      () => api.runIssueAction({ action: "release", issueId: "github:11" }),
      /NORTHSTAR_OPERATOR_ACTION_REQUIRES_CONFIRMATION/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("local API requires reason and valid target for resume actions", async () => {
  const fixture = await createLocalApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });

    await assert.rejects(
      () => api.runIssueAction({ action: "resume", issueId: "github:12" }),
      /NORTHSTAR_OPERATOR_ACTION_REQUIRES_REASON: resume/,
    );
    await assert.rejects(
      () => api.runIssueAction({ action: "resume", issueId: "github:12", reason: "fixed", targetLifecycle: "invalid" as never }),
      /NORTHSTAR_OPERATOR_ACTION_INVALID_TARGET: resume/,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("local API supports repair-runtime and resume issue actions", async () => {
  const fixture = await createLocalApiFixture();
  try {
    const api = createNorthstarLocalApi({ configPath: fixture.configPath });
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
      const repaired = await api.runIssueAction({ action: "repair-runtime", issueId: "github:11" });
      const resumed = await api.runIssueAction({
        action: "resume",
        issueId: "github:12",
        reason: "runtime fix deployed",
        targetLifecycle: "ready",
      });

      assert.equal(repaired.action, "repair-runtime");
      assert.equal(resumed.action, "resume");
      assert.equal(resumed.updatedIssue?.snapshot.lifecycle_state, "ready");
      assert.equal(resumed.nextRecommendedAction, "start");
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousToken;
      }
    }
  } finally {
    await fixture.cleanup();
  }
});

async function createLocalApiFixture() {
  const root = await mkdtemp(join(tmpdir(), "northstar-local-api-"));
  const configPath = join(root, ".northstar.yaml");
  const dbPath = join(root, ".northstar", "runtime", "control-plane.sqlite3");

  await mkdir(join(root, ".northstar", "runtime"), { recursive: true });
  await writeFile(configPath, configContent(root));

  const store = SqliteControlPlaneStore.open(dbPath);
  try {
    const snapshot = newIssueSnapshot("github:11", { lifecycle_state: "ready" });
    snapshot.runtime_context_json.issue_packet = {
      issue_number: "11",
      title: "Dashboard issue",
      source_url: "https://github.com/owner/repo/issues/11",
      labels: ["northstar:ready"],
      dependencies: [],
    };
    store.createIssue(snapshot);
    store.recordIdempotentHistory("github:11", {
      event_type: "runtime_event",
      created_at: "2026-06-02T07:00:00.000Z",
      payload: {
        idempotency_key: "runtime-event-11",
        summary: "Issue became visible to dashboard",
      },
    });

    const quarantined = newIssueSnapshot("github:12", {
      lifecycle_state: "quarantined",
      stage_cursor: "implementation",
    });
    quarantined.runtime_context_json.issue_packet = {
      issue_number: "12",
      title: "Quarantined issue",
      source_url: "https://github.com/owner/repo/issues/12",
      labels: ["northstar:quarantined"],
      dependencies: [],
    };
    store.createIssue(quarantined);
  } finally {
    store.close();
  }

  return {
    configPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function configContent(root: string): string {
  return `schema_version: "1.1"

project:
  name: northstar-local-api
  root: "${root}"

runtime:
  db_path: .northstar/runtime/control-plane.sqlite3
  host_adapter: pi
  development_capacity: 1
  release_capacity: 1
  heartbeat_interval_seconds: 30
  lease_timeout_seconds: 180
  child_timeout_seconds: 7200
  watch_lock_stale_seconds: 120
  max_recovery_attempts: 2
  auto_release: false
  session_scope: stage_root

workflow:
  package: northstar/workflows/issue-to-pr-release
  id: issue_to_pr_release
  version: "1.0"
  domain: software_development

github:
  repo: owner/repo
  intake:
    enabled: true
    label: northstar:ready
  sync:
    enabled: false
    retry_backoff_seconds:
      - 30
      - 120

git:
  base_branch: main
  worktrees_dir: .northstar/runtime/worktrees
  sync_worktree_dir: .northstar/runtime/sync-worktrees/main

cleanup:
  completed_worktrees: archive
  keep_last: 5
  failed_or_quarantined: keep

policy:
  github_sync_blocks_lifecycle: false
  quarantine_requires_operator: true
`;
}

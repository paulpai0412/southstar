import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalIssuePackets } from "../../src/intake/local.ts";
import { GitHubIssueIntakeAdapter } from "../../src/intake/github.ts";
import { SqliteControlPlaneStore } from "../../src/runtime/store.ts";

test("local seeded intake works without GitHub credentials or projection calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-intake-"));
  try {
    const fixture = join(dir, "issue.yaml");
    await writeFile(fixture, [
      "issue_number: local-1",
      "title: Local seed",
      "source: local",
      "source_url: file://issue.yaml",
      "branch: northstar/local-1",
      "base_branch: main",
      "labels:",
      "  - northstar",
      "dependencies: []",
      "raw_text: Build local fixture",
      "ready_for_agent: true",
      "",
    ].join("\n"));

    const packets = await loadLocalIssuePackets([fixture]);
    assert.equal(packets.length, 1);
    assert.equal(packets[0].source, "local");
    assert.equal(packets[0].ready_for_agent, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("github intake normalizes issues from configured repo", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response(JSON.stringify([
      {
        number: 35,
        title: "Implement feature",
        html_url: "https://github.com/owner/repo/issues/35",
        body: "Issue body",
        labels: [{ name: "ready" }],
      },
    ]), { status: 200 }),
  });

  const packets = await adapter.listIssuePackets();
  assert.deepEqual(packets[0], {
    issue_number: "35",
    title: "Implement feature",
    source: "github",
    source_url: "https://github.com/owner/repo/issues/35",
    branch: "northstar/issue-35",
    base_branch: "main",
    labels: ["ready"],
    dependencies: [],
    raw_text: "Issue body",
    ready_for_agent: true,
  });
});

test("github intake merges marker and native tasklist dependencies", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response(JSON.stringify([
      {
        number: 35,
        title: "Implement feature",
        html_url: "https://github.com/owner/repo/issues/35",
        body: [
          "Depends-On: #12",
          "- [ ] #12",
          "- [x] owner/repo#42",
        ].join("\n"),
        labels: [{ name: "ready" }],
      },
    ]), { status: 200 }),
  });

  const packets = await adapter.listIssuePackets();
  assert.deepEqual(packets[0].dependencies, ["12", "42"]);
  assert.deepEqual((packets[0] as unknown as {
    dependency_discovery: { dependencies: Array<{ issue: number; sources: string[] }> };
  }).dependency_discovery.dependencies.find((item) => item.issue === 12)?.sources.sort(), ["tasklist", "text"]);
});

test("github intake emits retryable native dependency warnings without failing issue intake", async () => {
  const adapter = new GitHubIssueIntakeAdapter({
    repo: "owner/repo",
    token: "token",
    fetch: async () => new Response(JSON.stringify([
      {
        number: 35,
        title: "Implement feature",
        html_url: "https://github.com/owner/repo/issues/35",
        body: "Issue body",
        labels: [],
      },
    ]), { status: 200 }),
    discoverNativeDependencies: async () => {
      throw new Error("GraphQL permission denied");
    },
  });

  const packets = await adapter.listIssuePackets();
  const warnings = (packets[0] as unknown as {
    intake_warnings: Array<{ event_type: string; payload: Record<string, unknown> }>;
  }).intake_warnings;

  assert.equal(packets.length, 1);
  assert.equal(warnings[0].event_type, "intake_warning_retryable");
  assert.equal(warnings[0].payload.native_dependency_api_failure_retryable, 1);
  assert.equal("native_dependency_api_failure_lifecycle_failures" in warnings[0].payload, false);
});

test("intake upsert is idempotent and appends auditable history facts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-store-"));
  const store = SqliteControlPlaneStore.open(join(dir, "control-plane.sqlite3"));
  try {
    const packet = {
      issue_number: "local-1",
      title: "Local seed",
      source: "local",
      source_url: "file://issue.yaml",
      branch: "northstar/local-1",
      base_branch: "main",
      labels: ["northstar"],
      dependencies: [],
      raw_text: "Build local fixture",
      ready_for_agent: true,
    };

    store.upsertIssuePacket(packet);
    store.upsertIssuePacket({ ...packet, title: "Local seed updated" });

    const issues = store.listAllIssuesForTests();
    assert.equal(issues.length, 1);
    assert.equal(issues[0].runtime_context_json.issue_packet.title, "Local seed updated");

    const history = store.listHistoryForTests("local:local-1");
    assert.deepEqual(history.map((entry) => entry.event_type), ["intake_packet", "intake_packet_updated"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

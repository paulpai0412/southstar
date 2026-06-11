import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, compactHistoryPayload } from "../../src/runtime/redaction.ts";
import { FakeCredentialProvider } from "../../src/runtime/credentials.ts";
import { GitHubRemoteProjectionAdapter } from "../../src/adapters/github/remote.ts";
import { inspectSnapshot } from "../../src/runtime/inspect.ts";
import { newIssueSnapshot } from "../../src/runtime/state-machine.ts";

test("redaction removes token-shaped values from nested payloads", () => {
  assert.deepEqual(redactSecrets({
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    nested: { authorization: "Bearer gho_abcdefghijklmnopqrstuvwxyz123456" },
  }), {
    token: "[REDACTED]",
    nested: { authorization: "[REDACTED]" },
  });
});

test("compact history payload rejects oversized raw logs", () => {
  assert.throws(
    () => compactHistoryPayload({ raw_transcript: "x".repeat(5000) }),
    /raw_transcript/,
  );
});

test("fake credential provider resolves configured credential names without exposing real tokens", async () => {
  const provider = new FakeCredentialProvider({ github: "ghp_fake_for_test" });
  assert.equal(await provider.resolve("github"), "ghp_fake_for_test");
  assert.equal(provider.describe("github"), "credential:github");
});

test("github projection errors are redacted", async () => {
  const adapter = new GitHubRemoteProjectionAdapter({
    repo: "owner/repo",
    token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
    fetch: async () => new Response("failed Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456", { status: 500 }),
    now: () => "2026-05-29T03:00:00.000Z",
  });

  const result = await adapter.syncLabel({ issue_number: 1, labels: ["northstar"] });
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.last_error, /ghp_/);
  assert.match(result.last_error, /\[REDACTED\]/);
});

test("inspect output redacts secret-shaped projection payloads", () => {
  const report = inspectSnapshot(newIssueSnapshot("inspect-secret", {
    runtime_context_json: {
      projection_sync: [{
        projection_target: "label",
        status: "failed",
        last_error: "token ghp_abcdefghijklmnopqrstuvwxyz123456",
      }],
    },
  }), "2026-05-29T03:00:00.000Z");

  assert.doesNotMatch(report, /ghp_/);
  assert.match(report, /\[REDACTED\]/);
});

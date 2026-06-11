import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compactHistoryPayload,
  redactSecrets,
} from "../../src/runtime/redaction.ts";

test("redacts token-shaped strings, authorization fields, and nested arrays", () => {
  const redacted = redactSecrets({
    message: "Bearer abcdefghijklmnopqrstuvwxyz",
    openai: "sk-1234567890abcdef",
    nested: [{ github_token: "ghp_abcdefghijklmnop1234" }],
    safe: 42,
  });

  assert.deepEqual(redacted, {
    message: "[REDACTED]",
    openai: "[REDACTED]",
    nested: [{ github_token: "[REDACTED]" }],
    safe: 42,
  });
});

test("compact history payload rejects raw logs and truncates long strings", () => {
  assert.throws(
    () => compactHistoryPayload({ terminal_log: "secret transcript" }),
    /terminal_log is not allowed/,
  );

  const payload = compactHistoryPayload({
    body: "abcdef",
    nested: ["Bearer abcdefghijklmnopqrstuvwxyz"],
  }, 3);

  assert.deepEqual(payload, {
    body: "abc...[truncated]",
    nested: ["[REDACTED]"],
  });
});

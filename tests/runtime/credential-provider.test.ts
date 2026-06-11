import test from "node:test";
import assert from "node:assert/strict";
import { resolveGitHubToken } from "../../src/runtime/credential-provider.ts";

test("github credential provider uses configured env token", async () => {
  const token = await resolveGitHubToken({
    tokenEnv: "NORTHSTAR_TEST_TOKEN",
    allowGhTokenFallback: true,
    env: { NORTHSTAR_TEST_TOKEN: "ghp_envtoken" },
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "should not run" }),
  });

  assert.equal(token.source, "env");
  assert.equal(token.token, "ghp_envtoken");
});

test("github credential provider uses gh fallback only when enabled", async () => {
  const token = await resolveGitHubToken({
    tokenEnv: "MISSING",
    allowGhTokenFallback: true,
    env: {},
    runCommand: async (command) => {
      assert.deepEqual(command, { command: "gh", args: ["auth", "token"] });
      return { exitCode: 0, stdout: "gho_from_cli\n", stderr: "" };
    },
  });

  assert.equal(token.source, "gh");
  assert.equal(token.token, "gho_from_cli");
});

test("github credential provider fails fast without credentials", async () => {
  await assert.rejects(() => resolveGitHubToken({
    tokenEnv: "MISSING",
    allowGhTokenFallback: false,
    env: {},
    runCommand: async () => ({ exitCode: 0, stdout: "gho_unused", stderr: "" }),
  }), /GITHUB_CREDENTIAL_MISSING/);
});

test("credential provider redacts tokens from errors", async () => {
  await assert.rejects(() => resolveGitHubToken({
    tokenEnv: "MISSING",
    allowGhTokenFallback: true,
    env: {},
    runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "bad ghp_secretvalue" }),
  }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /GITHUB_CREDENTIAL_MISSING/);
    assert.doesNotMatch(error.message, /ghp_secretvalue/);
    return true;
  });
});

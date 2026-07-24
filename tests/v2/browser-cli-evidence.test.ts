import assert from "node:assert/strict";
import test from "node:test";
import { browserCliEvidenceFindings } from "../../src/v2/evaluators/browser-cli-evidence.ts";

test("browser CLI evidence accepts successful direct navigation and observation commands", () => {
  assert.deepEqual(browserCliEvidenceFindings({
    artifact: {
      runtimeCommandExecutions: [
        execution("playwright-cli open http://127.0.0.1:30141 --browser chromium"),
        execution("playwright-cli snapshot"),
      ],
    },
    expectedEvidenceKinds: ["command-output"],
  }), []);
});

test("browser CLI evidence accepts direct commands with environment prefixes and output redirection", () => {
  assert.deepEqual(browserCliEvidenceFindings({
    artifact: {
      runtimeCommandExecutions: [
        execution("HOME=/tmp PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright-cli open http://127.0.0.1:30141 --browser chromium >> /workspace/repo/playwright.log 2>&1"),
        execution("HOME=/tmp PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright-cli snapshot >> /workspace/repo/playwright.log 2>&1"),
        execution("HOME=/tmp PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright-cli screenshot --filename /workspace/repo/shot.png >> /workspace/repo/playwright.log 2>&1"),
      ],
    },
    expectedEvidenceKinds: ["command-output", "screenshot"],
  }), []);
});

test("browser CLI evidence ignores evaluator-authored command claims", () => {
  assert.deepEqual(browserCliEvidenceFindings({
    artifact: {
      commandsRun: [
        execution("playwright-cli open http://127.0.0.1:30141"),
        execution("playwright-cli snapshot"),
      ],
      runtimeCommandExecutions: [],
    },
    expectedEvidenceKinds: ["command-output"],
  }), [
    "browser interaction requires a successful direct playwright-cli navigation command",
    "browser interaction requires a successful direct playwright-cli observation command",
  ]);
});

test("browser CLI evidence rejects chained commands and failed Playwright executions", () => {
  assert.deepEqual(browserCliEvidenceFindings({
    artifact: {
      runtimeCommandExecutions: [
        execution("echo fake && playwright-cli open http://127.0.0.1:30141"),
        execution("playwright-cli snapshot", false),
      ],
    },
    expectedEvidenceKinds: ["command-output"],
  }), [
    "browser interaction requires a successful direct playwright-cli navigation command",
    "browser interaction requires a successful direct playwright-cli observation command",
    "playwright-cli command must be direct and unchained: echo fake && playwright-cli open http://127.0.0.1:30141",
    "playwright-cli command failed: playwright-cli snapshot",
  ]);
});

test("browser CLI evidence blocks chained Playwright invocations even when direct evidence also passed", () => {
  assert.deepEqual(browserCliEvidenceFindings({
    artifact: {
      runtimeCommandExecutions: [
        execution("playwright-cli open http://127.0.0.1:30141 --browser chromium"),
        execution("playwright-cli snapshot"),
        execution("playwright-cli click e3 && playwright-cli snapshot"),
      ],
    },
    expectedEvidenceKinds: ["command-output"],
  }), [
    "playwright-cli command must be direct and unchained: playwright-cli click e3 && playwright-cli snapshot",
  ]);
});

test("browser CLI evidence requires a successful screenshot command when screenshot evidence is expected", () => {
  assert.deepEqual(browserCliEvidenceFindings({
    artifact: {
      runtimeCommandExecutions: [
        execution("playwright-cli goto http://127.0.0.1:30141/workflows"),
        execution("playwright-cli snapshot"),
      ],
    },
    expectedEvidenceKinds: ["command-output", "screenshot"],
  }), [
    "browser interaction requires a successful direct playwright-cli screenshot command",
  ]);
});

function execution(command: string, ok = true): Record<string, unknown> {
  return {
    ref: command,
    command,
    status: ok ? "passed" : "failed",
    ok,
  };
}

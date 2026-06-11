import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli/entrypoint.ts";
import { resolveGithubApplyTarget } from "../../src/cli/planning-command.ts";
import { parseWatchOptions } from "../../src/cli/watch-command.ts";
import { buildCliCommand, CLI_COMMANDS, formatSouthstarHelp, runSouthstarCli } from "../../src/cli/southstar.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const configPath = join(repoRoot, "tests/fixtures/southstar/config/.southstar.yaml");

test("all required Southstar CLI commands load config and build commands", () => {
  for (const command of CLI_COMMANDS) {
    const built = buildCliCommand([command, "--config", configPath]);

    assert.equal(built.command, command);
    assert.equal(built.config.workflow.id, "generic_request_resolution");
    assert.equal(built.configPath, configPath);
    assert.deepEqual(built.args, ["--config", configPath]);
  }
});

test("project-root override is carried without mutating argv", () => {
  const built = buildCliCommand([
    "work",
    "--config",
    configPath,
    "--project-root",
    "/tmp/southstar-start-root",
  ]);

  assert.equal(built.config.project.root, "/tmp/southstar-start-root");
  assert.equal(built.projectRootOverride, "/tmp/southstar-start-root");
  assert.deepEqual(built.args, ["--config", configPath, "--project-root", "/tmp/southstar-start-root"]);
});

test("runSouthstarCli rejects unknown commands", () => {
  assert.throws(() => runSouthstarCli(["unknown"]), /Unknown southstar command/);
});

test("southstar help lists command surface", () => {
  const help = formatSouthstarHelp();

  assert.match(help, /southstar doctor/);
  assert.match(help, /southstar watch/);
  assert.match(help, /southstar inspect/);
  assert.doesNotMatch(help, /northstar/i);
  assert.doesNotMatch(help, /plan-grill/);
});

test("executable entrypoint prints help without loading project config", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    output.push(String(value ?? ""));
  };
  try {
    assert.equal(await main(["--help"]), 0);
  } finally {
    console.log = originalLog;
  }

  assert.match(output.join("\n"), /southstar doctor/);
  assert.match(output.join("\n"), /southstar watch/);
});

test("executable entrypoint supports alternate help and version aliases", async () => {
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    output.push(String(value ?? ""));
  };
  try {
    assert.equal(await main([]), 0);
    assert.equal(await main(["-h"]), 0);
    assert.equal(await main(["help"]), 0);
    assert.equal(await main(["-v"]), 0);
    assert.equal(await main(["watch", "-h"]), 0);
  } finally {
    console.log = originalLog;
  }

  const text = output.join("\n");
  assert.match(text, /southstar watch/);
  assert.match(text, /0\.1\.0/);
  assert.doesNotMatch(text, /northstar init/i);
});

test("executable entrypoint prints command JSON and reports unknown commands", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value?: unknown) => {
    output.push(String(value ?? ""));
  };
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };
  try {
    assert.equal(await main(["doctor", "--config", configPath]), 0);
    assert.equal(await main(["unknown"]), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.match(output.join("\n"), /"type":"doctor"/);
  assert.match(errors.join("\n"), /Unknown southstar command/);
});

test("watch command is part of the Southstar CLI surface", () => {
  const parsed = runSouthstarCli(["watch"]);
  assert.equal(parsed.command, "watch");
  assert.match(formatSouthstarHelp(), /southstar watch/);
});

test("planning commands route through entrypoint without Southstar top-level command rejection", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };
  try {
    assert.equal(await main(["plan-grill", "--config", configPath]), 1);
  } finally {
    console.error = originalError;
  }

  assert.match(errors.join("\n"), /--brief is required/);
  assert.doesNotMatch(errors.join("\n"), /Unknown southstar command/);
});

test("planning issue apply requires explicit GitHub config", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };
  try {
    assert.equal(await main([
      "plan-issues",
      "--config",
      configPath,
      "--spec",
      "/tmp/southstar-spec.md",
      "--plan",
      "/tmp/southstar-plan.md",
      "--apply",
      "--confirmed",
    ]), 1);
  } finally {
    console.error = originalError;
  }

  assert.match(errors.join("\n"), /plan-issues --apply requires GitHub config with repo/);
  assert.doesNotMatch(errors.join("\n"), /local\/southstar/);
});

test("planning issue apply target requires enabled GitHub intake", () => {
  assert.throws(
    () => resolveGithubApplyTarget({ repo: "owner/repo" }),
    /plan-issues --apply requires enabled GitHub intake/,
  );
  assert.throws(
    () => resolveGithubApplyTarget({ repo: "owner/repo", intake: { enabled: false } }),
    /plan-issues --apply requires enabled GitHub intake/,
  );

  assert.deepEqual(resolveGithubApplyTarget({
    repo: "owner/repo",
    intake: { enabled: true, label: "southstar:ready" },
  }), {
    repo: "owner/repo",
    label: "southstar:ready",
  });
});

test("planning commands read inputs and produce connected artifacts through entrypoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "southstar-plan-cli-"));
  const briefPath = join(dir, "brief.md");
  const answersPath = join(dir, "answers.md");
  const specPath = join(dir, "spec.md");
  const planPath = join(dir, "plan.md");
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    output.push(String(value ?? ""));
  };

  try {
    await writeFile(briefPath, [
      "# Todo Planning Workflow",
      "Build a browser-verified daily planning workflow.",
      "Acceptance Criteria:",
      "- Users can add daily planning tasks.",
      "Required Tests:",
      "- npm test",
    ].join("\n"));
    await writeFile(answersPath, "Browser evidence is required.\n");

    assert.equal(await main(["plan-grill", "--config", configPath, "--brief", briefPath, "--json"]), 0);
    assert.equal(await main(["plan-spec", "--config", configPath, "--brief", briefPath, "--answers", answersPath, "--out", specPath]), 0);
    assert.equal(await main(["plan-implementation", "--config", configPath, "--spec", specPath, "--out", planPath]), 0);
    assert.equal(await main(["plan-issues", "--config", configPath, "--spec", specPath, "--plan", planPath, "--dry-run"]), 0);

    assert.match(output.join("\n"), /planning_grill_questions_generated/);
    assert.match(await readFile(specPath, "utf8"), /# Todo Planning Workflow Spec/);
    assert.match(await readFile(planPath, "utf8"), /## Task 1:/);
    assert.match(output.at(-1) ?? "", /"issueDrafts"/);
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch command parses bounded daemon options", () => {
  const parsed = runSouthstarCli(["watch", "--max-cycles", "5", "--interval-ms", "50", "--log-json"]);

  assert.equal(parsed.command, "watch");
  assert.deepEqual(parsed.args, ["--max-cycles", "5", "--interval-ms", "50", "--log-json"]);
});

test("parseWatchOptions returns bounded daemon options", () => {
  assert.deepEqual(parseWatchOptions(["--config", "tmp/.northstar.yaml", "--max-cycles", "5", "--interval-ms", "50", "--log-json"]), {
    configPath: "tmp/.northstar.yaml",
    maxCycles: 5,
    intervalMs: 50,
    logJson: true,
  });
});

test("parseWatchOptions returns defaults and rejects invalid numeric bounds", () => {
  assert.deepEqual(parseWatchOptions([]), {
    configPath: ".northstar.yaml",
    maxCycles: undefined,
    intervalMs: 1000,
    logJson: false,
  });
  assert.throws(() => parseWatchOptions(["--max-cycles", "-1"]), /--max-cycles/);
  assert.throws(() => parseWatchOptions(["--interval-ms", "1.5"]), /--interval-ms/);
});

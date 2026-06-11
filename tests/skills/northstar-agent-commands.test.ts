import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const installerModule = "../../skills/northstar/scripts/install-agent-commands.mjs";
const requiredCommands = [
  "northstar-plan",
  "northstar-grill",
  "northstar-to-spec",
  "northstar-to-plan",
  "northstar-to-issues",
  "northstar-setup",
  "northstar-init",
  "northstar-execute",
  "northstar-watch",
  "northstar-observe",
  "northstar-status",
  "northstar-recover",
  "northstar-recovery",
  "northstar-report",
];

test("northstar agent command installer enables codex claude opencode and pi-agent entries", async () => {
  const { installAgentCommands } = await import(installerModule);
  const dir = await mkdtemp(join(tmpdir(), "northstar-agent-commands-"));

  try {
    const home = join(dir, "home");
    await mkdir(join(home, ".opencode"), { recursive: true });
    await writeFile(join(home, ".opencode/opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      command: {
        existing: {
          description: "keep",
          template: "keep",
        },
      },
      instructions: ["/existing/instructions.md"],
      skills: {
        paths: ["/existing/skill"],
      },
    }, null, 2), "utf8");

    const result = await installAgentCommands({ home, northstarRoot: repoRoot });

    assert.equal(result.codex.targetDir, join(home, ".codex/skills/northstar"));
    assert.match(await readFile(join(home, ".codex/skills/northstar/SKILL.md"), "utf8"), /Northstar/);

    for (const command of requiredCommands) {
      const content = await readFile(join(home, ".claude/commands", `${command}.md`), "utf8");
      assert.match(content, /northstar-operator\.md/);
      assert.doesNotMatch(content, /__NORTHSTAR_ROOT__/);
    }
    assert.match(
      await readFile(join(home, ".claude/plugins/cache/local/northstar/1.0.0/.claude-plugin/plugin.json"), "utf8"),
      /Northstar/,
    );

    const opencodeConfig = JSON.parse(await readFile(join(home, ".opencode/opencode.json"), "utf8"));
    assert.equal(opencodeConfig.command.existing.template, "keep");
    for (const command of requiredCommands) {
      assert.match(opencodeConfig.command[command].template, /\/northstar-/);
      assert.match(opencodeConfig.command[command].template, /node --run northstar/);
      assert.doesNotMatch(opencodeConfig.command[command].template, /__NORTHSTAR_ROOT__/);
    }
    assert.deepEqual(opencodeConfig.instructions, ["/existing/instructions.md", join(repoRoot, "docs/agent-playbooks/northstar-operator.md")]);
    assert.deepEqual(opencodeConfig.skills.paths, ["/existing/skill", join(repoRoot, "skills/northstar")]);

    assert.match(
      await readFile(join(home, ".pi-agent/northstar/northstar-slash-command-prompt.md"), "utf8"),
      /Northstar Slash Commands for Pi-agent/,
    );
    assert.match(
      await readFile(join(home, ".pi-agent/northstar/northstar-slash-router.mjs"), "utf8"),
      /buildPiNorthstarPrompt/,
    );
    assert.match(
      await readFile(join(home, ".pi/agent/extensions/northstar/index.ts"), "utf8"),
      /registerCommand/,
    );
    assert.match(
      await readFile(join(home, ".pi/agent/skills/northstar/SKILL.md"), "utf8"),
      /Northstar Global Skill/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("northstar shared playbook and pi router enumerate the supported slash commands", async () => {
  const playbook = await readFile(join(repoRoot, "docs/agent-playbooks/northstar-operator.md"), "utf8");
  const opencodeCommands = JSON.parse(await readFile(join(repoRoot, "integrations/opencode/northstar-commands.json"), "utf8"));

  for (const command of requiredCommands) {
    assert.match(playbook, new RegExp(`/${command}`));
    assert.ok(opencodeCommands[command], `${command} missing from opencode command config`);
  }

  const { buildPiNorthstarPrompt } = await import("../../integrations/pi-agent/northstar-slash-router.mjs");
  const prompt = await buildPiNorthstarPrompt(["/northstar-status", "--summary"]);
  assert.match(prompt, /docs\/agent-playbooks\/northstar-operator\.md/);
  assert.match(prompt, /Slash command: \/northstar-status/);
  assert.match(prompt, /Arguments: --summary/);
  assert.match(prompt, /Raw SQLite Inspection/);
  assert.match(prompt, /issue_history/);
  assert.match(prompt, /payload_json/);
  assert.doesNotMatch(prompt, /__NORTHSTAR_ROOT__/);
});

test("northstar pi extension registers slash commands and forwards requests to pi", async () => {
  const registered = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sentMessages: string[] = [];
  const { default: installExtension } = await import("../../integrations/pi-agent/northstar-extension.ts");

  installExtension({
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      registered.set(name, options);
    },
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  });

  for (const command of requiredCommands) {
    assert.ok(registered.has(command), `${command} missing from pi extension`);
  }

  await registered.get("northstar-status")?.handler("--summary", { ui: { setEditorText() {}, notify() {} } });

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0], /\/northstar-status --summary/);
  assert.match(sentMessages[0], /node --run northstar -- inspect/);
});

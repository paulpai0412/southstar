import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { syncGlobalSkill } from "./sync-global.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const commandNames = Object.freeze([
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
]);

export async function installAgentCommands({
  home = homedir(),
  northstarRoot = repoRoot,
} = {}) {
  const codex = await syncGlobalSkill({ targetDir: join(home, ".codex/skills/northstar") });
  const claude = await installClaudeCommands({ home, northstarRoot });
  const opencode = await installOpenCodeCommands({ home, northstarRoot });
  const pi = await installPiAgentPrompt({ home, northstarRoot });
  return { codex, claude, opencode, pi };
}

async function installClaudeCommands({ home, northstarRoot }) {
  const source = join(northstarRoot, "integrations/claude/northstar/commands");
  const target = join(home, ".claude/commands");
  await mkdir(target, { recursive: true });
  const installed = [];
  for (const name of commandNames) {
    const file = `${name}.md`;
    const targetFile = join(target, file);
    await writeRenderedFile(join(source, file), targetFile, { northstarRoot });
    installed.push(targetFile);
  }

  const pluginSource = join(northstarRoot, "integrations/claude/northstar");
  const pluginTarget = join(home, ".claude/plugins/cache/local/northstar/1.0.0");
  await mkdir(dirname(pluginTarget), { recursive: true });
  await cp(pluginSource, pluginTarget, { recursive: true, force: true });
  await renderDirectoryTemplates(pluginTarget, { northstarRoot });

  return {
    commandDir: target,
    pluginDir: pluginTarget,
    commands: installed,
  };
}

async function installOpenCodeCommands({ home, northstarRoot }) {
  const configPath = join(home, ".opencode/opencode.json");
  const config = await readJsonIfExists(configPath, { $schema: "https://opencode.ai/config.json" });
  const commands = JSON.parse(renderTemplate(await readFile(join(northstarRoot, "integrations/opencode/northstar-commands.json"), "utf8"), { northstarRoot }));
  const playbookPath = join(northstarRoot, "docs/agent-playbooks/northstar-operator.md");
  const skillPath = join(northstarRoot, "skills/northstar");
  const instructions = Array.isArray(config.instructions) ? config.instructions : [];
  const skills = config.skills && typeof config.skills === "object" ? config.skills : {};
  const skillPaths = Array.isArray(skills.paths) ? skills.paths : [];
  const next = {
    ...config,
    command: {
      ...(config.command ?? {}),
      ...commands,
    },
    instructions: unique([...instructions, playbookPath]),
    skills: {
      ...skills,
      paths: unique([...skillPaths, skillPath]),
    },
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    configPath,
    commands: Object.keys(commands),
    playbookPath,
    skillPath,
  };
}

async function readJsonIfExists(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function installPiAgentPrompt({ home, northstarRoot }) {
  const legacyTarget = join(home, ".pi-agent/northstar");
  await mkdir(legacyTarget, { recursive: true });
  await writeRenderedFile(join(northstarRoot, "integrations/pi-agent/northstar-slash-command-prompt.md"), join(legacyTarget, "northstar-slash-command-prompt.md"), { northstarRoot });
  await writeRenderedFile(join(northstarRoot, "integrations/pi-agent/northstar-slash-router.mjs"), join(legacyTarget, "northstar-slash-router.mjs"), { northstarRoot });

  const extensionTarget = join(home, ".pi/agent/extensions/northstar");
  await mkdir(extensionTarget, { recursive: true });
  await writeRenderedFile(join(northstarRoot, "integrations/pi-agent/northstar-extension.ts"), join(extensionTarget, "index.ts"), { northstarRoot });

  const skillTarget = join(home, ".pi/agent/skills/northstar");
  await mkdir(skillTarget, { recursive: true });
  await writeRenderedFile(join(northstarRoot, "skills/northstar/SKILL.md"), join(skillTarget, "SKILL.md"), { northstarRoot });

  return {
    promptPath: join(legacyTarget, "northstar-slash-command-prompt.md"),
    routerPath: join(legacyTarget, "northstar-slash-router.mjs"),
    extensionPath: join(extensionTarget, "index.ts"),
    skillPath: join(skillTarget, "SKILL.md"),
  };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))];
}

async function writeRenderedFile(source, target, context) {
  await writeFile(target, renderTemplate(await readFile(source, "utf8"), context), "utf8");
}

async function renderDirectoryTemplates(root, context) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      await renderDirectoryTemplates(entryPath, context);
      continue;
    }
    if (/\.(json|md|mjs)$/.test(entry.name)) {
      await writeRenderedFile(entryPath, entryPath, context);
    }
  }
}

function renderTemplate(content, { northstarRoot }) {
  return content.replaceAll("__NORTHSTAR_ROOT__", northstarRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await installAgentCommands(), null, 2));
}

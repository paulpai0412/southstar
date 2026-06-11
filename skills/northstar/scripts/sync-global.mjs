import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { copyDirectoryOverwrite, globalSkillDirForHome } from "./lib/platform.mjs";

export function resolveSyncTarget({ platform = process.platform, home = homedir(), targetDir } = {}) {
  return targetDir ?? globalSkillDirForHome({ platform, home });
}

export function defaultSourceDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function syncGlobalSkill({ sourceDir = defaultSourceDir(), targetDir = resolveSyncTarget() } = {}) {
  await copyDirectoryOverwrite(sourceDir, targetDir);
  return {
    sourceDir,
    targetDir,
    skill_global_sync_overwrites_target: 1,
  };
}

export function parseSyncGlobalArgs(args) {
  const parsed = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--target") {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const targetDir = args[index + 1];
    if (targetDir === undefined || targetDir.startsWith("--")) {
      throw new Error("Missing value for --target");
    }

    parsed.targetDir = targetDir;
    index += 1;
  }

  return parsed;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { targetDir } = parseSyncGlobalArgs(process.argv.slice(2));
  const result = await syncGlobalSkill({ targetDir });
  console.log(JSON.stringify(result, null, 2));
}

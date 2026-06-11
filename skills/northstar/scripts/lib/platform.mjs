import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";

export function globalSkillDirForHome({ platform = process.platform, home }) {
  const adapter = platform === "win32" ? path.win32 : path.posix;
  return adapter.join(home, ".codex", "skills", "northstar");
}

export function commandSpec(command, args = []) {
  const parts = [command, ...args];
  const invalid = parts.find((part) => /&&|\|\||;/.test(String(part)));
  if (invalid) {
    throw new Error(`NORTHSTAR_SKILL_SHELL_CHAIN: ${invalid}`);
  }
  return { command, args };
}

export function runCommand(spec, options = {}) {
  commandSpec(
    spec.command,
    spec.args ?? [],
  );
  return new Promise((resolve) => {
    execFile(spec.command, spec.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      const normalizedStderr = stderr || (error ? error.message : "");
      const result = { exitCode: code, stdout, stderr: normalizedStderr };

      if (error) {
        result.message = error.message;
        if (typeof error.code === "string") {
          result.errorCode = error.code;
        }
        if (error.signal) {
          result.signal = error.signal;
        }
        if (error.killed && error.signal) {
          result.timedOut = true;
        }
      }

      resolve(result);
    });
  });
}

export async function copyDirectoryOverwrite(source, target, options = {}) {
  const fs = {
    cp,
    mkdir,
    mkdtemp,
    rename,
    rm,
    ...options.fs,
  };
  const parent = path.dirname(target);
  const name = path.basename(target);
  const removeBestEffort = async (entry) => {
    try {
      await fs.rm(entry, { recursive: true, force: true });
    } catch {
      // Cleanup must not mask the copy or rename failure that triggered it.
    }
  };
  await fs.mkdir(parent, { recursive: true });
  let replacement = await fs.mkdtemp(path.join(parent, `.${name}.tmp-`));
  let backup;
  let backupActive = false;
  let preserveBackup = false;

  try {
    await fs.cp(source, replacement, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
    backup = await fs.mkdtemp(path.join(parent, `.${name}.backup-`));
    await fs.rm(backup, { recursive: true, force: true });
    try {
      await fs.rename(target, backup);
      backupActive = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      backup = undefined;
    }

    try {
      await fs.rename(replacement, target);
      replacement = undefined;
    } catch (error) {
      if (backupActive) {
        try {
          await fs.rename(backup, target);
          backupActive = false;
          backup = undefined;
        } catch (rollbackError) {
          // Preserve the original replacement failure when rollback also fails.
          error.backupPath = backup;
          error.rollbackError = rollbackError;
          preserveBackup = true;
        }
      }
      throw error;
    }

    if (backupActive) {
      await removeBestEffort(backup);
      backupActive = false;
      backup = undefined;
    }
  } finally {
    if (replacement) {
      await removeBestEffort(replacement);
    }
    if (backup && !preserveBackup) {
      await removeBestEffort(backup);
    }
  }
}

export function isWindowsPlatform(platform = process.platform) {
  return platform === "win32";
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { buildRuntimeDependencies } from "../../../src/v2/runtime/dependencies.ts";

export function createCubeSandboxRealContext(env: CubeSandboxRealE2EEnv) {
  return buildRuntimeDependencies({
    configPath: env.configPath,
    resolveCredential(ref) {
      const value = process.env[`SOUTHSTAR_TEST_SECRET_${ref}`];
      if (!value) throw new Error(`missing test credential SOUTHSTAR_TEST_SECRET_${ref}`);
      return value;
    },
  });
}

export function makeRealWorkspace(prefix = "cube-real-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupWorkspace(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

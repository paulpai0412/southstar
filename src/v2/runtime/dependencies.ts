import { loadConfig } from "../../config/load-config.ts";
import type { RuntimeConfig } from "../../config/schema.ts";
import { openSouthstarDb } from "../stores/sqlite.ts";
import { createExecutorProviderFromConfig } from "../executor/factory.ts";
import { ExecutorRuntimeManager } from "../executor/runtime-manager.ts";

export type RuntimeDependencyOptions = {
  configPath: string;
  resolveCredential?: (ref: string) => string;
};

export type RuntimeDependencies = {
  config: RuntimeConfig;
  db: ReturnType<typeof openSouthstarDb>;
  executorManager: ExecutorRuntimeManager;
};

export function loadRuntimeConfigForV2(configPath: string): RuntimeConfig {
  return loadConfig(configPath);
}

export function buildRuntimeDependencies(options: RuntimeDependencyOptions): RuntimeDependencies {
  const config = loadRuntimeConfigForV2(options.configPath);
  const provider = createExecutorProviderFromConfig(config, {
    resolveCredential: options.resolveCredential ?? ((ref: string) => {
      const key = southstarSecretEnvName(ref);
      const value = process.env[key];
      if (!value) {
        throw new Error(`missing credential for ${ref}; set ${key}`);
      }
      return value;
    }),
  });

  return {
    config,
    db: openSouthstarDb(config.runtime.dbPath),
    executorManager: new ExecutorRuntimeManager({ provider }),
  };
}

export function southstarSecretEnvName(ref: string): string {
  return `SOUTHSTAR_SECRET_${normalizeCredentialRef(ref)}`;
}

function normalizeCredentialRef(ref: string): string {
  return ref.replace(/[^A-Za-z0-9_]/g, "_");
}

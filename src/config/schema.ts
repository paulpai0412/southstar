export const ALLOWED_BOOTSTRAP_ENV = [
  "SOUTHSTAR_CONFIG",
  "SOUTHSTAR_PROJECT_ROOT",
  "SOUTHSTAR_DEBUG",
] as const;

export type IntakeMode = "local" | "remote" | "hybrid";
export type ExecutorProviderName = "tork" | "cubesandbox";
export type ExecutorCleanupMode = "strict" | "best_effort";

export type ExecutorLifecycleConfig = {
  cleanupMode: ExecutorCleanupMode;
  healthCheckIntervalSeconds: number;
  reconcileIntervalSeconds: number;
  orphanScanIntervalSeconds: number;
  orphanGraceSeconds: number;
  shutdownGraceSeconds: number;
  maxRestartAttempts: number;
  maxCleanupAttempts: number;
  sdkCallTimeoutSeconds: number;
  sandboxCreateTimeoutSeconds: number;
  commandStartTimeoutSeconds: number;
  commandIdleTimeoutSeconds: number;
  taskWallTimeoutSeconds: number;
  callbackWaitTimeoutSeconds: number;
  destroyTimeoutSeconds: number;
  lockTtlSeconds: number;
};

export type TorkExecutorConfig = {
  baseUrl: string;
  submitPath: string;
};

export type CubeSandboxHostMount = {
  source: string;
  target: string;
  readonly: boolean;
};

export type CubeSandboxExecutorConfig = {
  sdk: "e2b-compatible";
  apiUrl: string;
  apiKeyRef: string;
  templateId: string;
  defaultTimeoutSeconds: number;
  destroyOnCompletion: boolean;
  hostMounts: CubeSandboxHostMount[];
};

export type ExecutorConfig = {
  provider: ExecutorProviderName;
  lifecycle: ExecutorLifecycleConfig;
  tork?: TorkExecutorConfig;
  cubesandbox?: CubeSandboxExecutorConfig;
};

export interface RuntimeConfig {
  schemaVersion: string;
  project: {
    name: string;
    root: string;
  };
  runtime: {
    dbPath: string;
    heartbeatIntervalSeconds: number;
    lockTimeoutSeconds: number;
    taskTimeoutSeconds: number;
    maxRetryAttempts: number;
  };
  intake: {
    mode: IntakeMode;
  };
  sources: Record<string, { enabled: boolean }>;
  projection: Record<string, { enabled: boolean; blocksRuntime: boolean }>;
  packs: {
    searchPaths: string[];
  };
  workflow: {
    id: string;
    version: string;
    path: string;
  };
  agents: {
    path: string;
  };
  executor: ExecutorConfig;
}

const requiredStringFields = [
  "schema_version",
  "project.name",
  "project.root",
  "runtime.db_path",
  "workflow.id",
  "workflow.version",
  "workflow.path",
  "agents.path",
  "executor.provider",
  "executor.lifecycle.cleanup_mode",
  "executor.lifecycle.health_check_interval_seconds",
  "executor.lifecycle.reconcile_interval_seconds",
  "executor.lifecycle.orphan_scan_interval_seconds",
  "executor.lifecycle.orphan_grace_seconds",
  "executor.lifecycle.shutdown_grace_seconds",
  "executor.lifecycle.max_restart_attempts",
  "executor.lifecycle.max_cleanup_attempts",
  "executor.lifecycle.sdk_call_timeout_seconds",
  "executor.lifecycle.sandbox_create_timeout_seconds",
  "executor.lifecycle.command_start_timeout_seconds",
  "executor.lifecycle.command_idle_timeout_seconds",
  "executor.lifecycle.task_wall_timeout_seconds",
  "executor.lifecycle.callback_wait_timeout_seconds",
  "executor.lifecycle.destroy_timeout_seconds",
  "executor.lifecycle.lock_ttl_seconds",
] as const;

const requiredIntegerFields = [
  "runtime.heartbeat_interval_seconds",
  "runtime.lock_timeout_seconds",
  "runtime.task_timeout_seconds",
  "runtime.max_retry_attempts",
] as const;

export function validateRuntimeConfig(value: unknown): RuntimeConfig {
  const missing = [...requiredStringFields, ...requiredIntegerFields, "intake.mode", "sources", "projection", "packs.search_paths"]
    .filter((field) => getConfigValue(value, field) === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing required config fields: ${missing.join(", ")}`);
  }

  return {
    schemaVersion: stringField(value, "schema_version"),
    project: {
      name: stringField(value, "project.name"),
      root: stringField(value, "project.root"),
    },
    runtime: {
      dbPath: stringField(value, "runtime.db_path"),
      heartbeatIntervalSeconds: nonNegativeIntegerField(value, "runtime.heartbeat_interval_seconds"),
      lockTimeoutSeconds: nonNegativeIntegerField(value, "runtime.lock_timeout_seconds"),
      taskTimeoutSeconds: nonNegativeIntegerField(value, "runtime.task_timeout_seconds"),
      maxRetryAttempts: nonNegativeIntegerField(value, "runtime.max_retry_attempts"),
    },
    intake: {
      mode: enumField(value, "intake.mode", ["local", "remote", "hybrid"] as const),
    },
    sources: normalizeSources(getConfigValue(value, "sources")),
    projection: normalizeProjection(getConfigValue(value, "projection")),
    packs: {
      searchPaths: stringArrayField(value, "packs.search_paths"),
    },
    workflow: {
      id: stringField(value, "workflow.id"),
      version: stringField(value, "workflow.version"),
      path: stringField(value, "workflow.path"),
    },
    agents: {
      path: stringField(value, "agents.path"),
    },
    executor: normalizeExecutor(value),
  };
}

function normalizeExecutor(value: unknown): ExecutorConfig {
  const provider = enumField(value, "executor.provider", ["tork", "cubesandbox"] as const);
  const lifecycle = normalizeExecutorLifecycle(value);
  const executor: ExecutorConfig = { provider, lifecycle };

  if (provider === "tork") {
    executor.tork = {
      baseUrl: stringField(value, "executor.tork.base_url"),
      submitPath: typeof getConfigValue(value, "executor.tork.submit_path") === "string"
        ? stringField(value, "executor.tork.submit_path")
        : "/jobs",
    };
  }

  if (provider === "cubesandbox") {
    executor.cubesandbox = {
      sdk: enumField(value, "executor.cubesandbox.sdk", ["e2b-compatible"] as const),
      apiUrl: stringField(value, "executor.cubesandbox.api_url"),
      apiKeyRef: stringField(value, "executor.cubesandbox.api_key_ref"),
      templateId: stringField(value, "executor.cubesandbox.template_id"),
      defaultTimeoutSeconds: nonNegativeIntegerField(value, "executor.cubesandbox.default_timeout_seconds"),
      destroyOnCompletion: booleanField(value, "executor.cubesandbox.destroy_on_completion"),
      hostMounts: normalizeHostMounts(getConfigValue(value, "executor.cubesandbox.host_mounts")),
    };
  }

  return executor;
}

function normalizeExecutorLifecycle(value: unknown): ExecutorLifecycleConfig {
  return {
    cleanupMode: enumField(value, "executor.lifecycle.cleanup_mode", ["strict", "best_effort"] as const),
    healthCheckIntervalSeconds: nonNegativeIntegerField(value, "executor.lifecycle.health_check_interval_seconds"),
    reconcileIntervalSeconds: nonNegativeIntegerField(value, "executor.lifecycle.reconcile_interval_seconds"),
    orphanScanIntervalSeconds: nonNegativeIntegerField(value, "executor.lifecycle.orphan_scan_interval_seconds"),
    orphanGraceSeconds: nonNegativeIntegerField(value, "executor.lifecycle.orphan_grace_seconds"),
    shutdownGraceSeconds: nonNegativeIntegerField(value, "executor.lifecycle.shutdown_grace_seconds"),
    maxRestartAttempts: nonNegativeIntegerField(value, "executor.lifecycle.max_restart_attempts"),
    maxCleanupAttempts: nonNegativeIntegerField(value, "executor.lifecycle.max_cleanup_attempts"),
    sdkCallTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.sdk_call_timeout_seconds"),
    sandboxCreateTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.sandbox_create_timeout_seconds"),
    commandStartTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.command_start_timeout_seconds"),
    commandIdleTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.command_idle_timeout_seconds"),
    taskWallTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.task_wall_timeout_seconds"),
    callbackWaitTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.callback_wait_timeout_seconds"),
    destroyTimeoutSeconds: nonNegativeIntegerField(value, "executor.lifecycle.destroy_timeout_seconds"),
    lockTtlSeconds: nonNegativeIntegerField(value, "executor.lifecycle.lock_ttl_seconds"),
  };
}

function normalizeHostMounts(value: unknown): CubeSandboxHostMount[] {
  if (!Array.isArray(value)) {
    throw new Error("executor.cubesandbox.host_mounts must be an array");
  }
  return value.map((mount, index) => {
    if (!isRecord(mount)) {
      throw new Error(`executor.cubesandbox.host_mounts.${index} must be a mapping`);
    }
    return {
      source: stringFromRecord(mount, "source", `executor.cubesandbox.host_mounts.${index}.source`),
      target: stringFromRecord(mount, "target", `executor.cubesandbox.host_mounts.${index}.target`),
      readonly: booleanValue(mount.readonly, `executor.cubesandbox.host_mounts.${index}.readonly`),
    };
  });
}

function stringFromRecord(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeSources(value: unknown): RuntimeConfig["sources"] {
  if (!isRecord(value)) {
    throw new Error("sources must be a mapping");
  }
  const normalized: RuntimeConfig["sources"] = {};
  for (const [name, source] of Object.entries(value)) {
    if (!isRecord(source)) {
      throw new Error(`sources.${name} must be a mapping`);
    }
    normalized[name] = {
      enabled: booleanValue(source.enabled, `sources.${name}.enabled`),
    };
  }
  return normalized;
}

function normalizeProjection(value: unknown): RuntimeConfig["projection"] {
  if (!isRecord(value)) {
    throw new Error("projection must be a mapping");
  }
  const normalized: RuntimeConfig["projection"] = {};
  for (const [name, projection] of Object.entries(value)) {
    if (!isRecord(projection)) {
      throw new Error(`projection.${name} must be a mapping`);
    }
    normalized[name] = {
      enabled: booleanValue(projection.enabled, `projection.${name}.enabled`),
      blocksRuntime: booleanValue(projection.blocks_runtime, `projection.${name}.blocks_runtime`),
    };
  }
  return normalized;
}

function stringField(value: unknown, field: string): string {
  const fieldValue = getConfigValue(value, field);
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return fieldValue;
}

function nonNegativeIntegerField(value: unknown, field: string): number {
  const fieldValue = getConfigValue(value, field);
  if (!Number.isInteger(fieldValue) || (fieldValue as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return fieldValue as number;
}

function enumField<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const fieldValue = stringField(value, field);
  if (!(allowed as readonly string[]).includes(fieldValue)) {
    throw new Error(`${field} must be ${allowed.slice(0, -1).join(", ")}, or ${allowed.at(-1)}`);
  }
  return fieldValue as T;
}

function stringArrayField(value: unknown, field: string): string[] {
  const fieldValue = getConfigValue(value, field);
  if (!Array.isArray(fieldValue) || fieldValue.length === 0 || !fieldValue.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return fieldValue;
}

function booleanField(value: unknown, field: string): boolean {
  return booleanValue(getConfigValue(value, field), field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function getConfigValue(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[segment];
  }, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

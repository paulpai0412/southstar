export const ALLOWED_BOOTSTRAP_ENV = [
  "SOUTHSTAR_CONFIG",
  "SOUTHSTAR_PROJECT_ROOT",
  "SOUTHSTAR_DEBUG",
] as const;

export type IntakeMode = "local" | "remote" | "hybrid";

export interface RuntimeConfig {
  schemaVersion: string;
  project: {
    name: string;
    root: string;
  };
  runtime: {
    dbPath: string;
    databaseUrl: string;
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
}

const requiredStringFields = [
  "schema_version",
  "project.name",
  "project.root",
  "workflow.id",
  "workflow.version",
  "workflow.path",
  "agents.path",
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
  if (getConfigValue(value, "runtime.db_path") === undefined && getConfigValue(value, "runtime.database_url") === undefined) {
    missing.push("runtime.db_path or runtime.database_url");
  }
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
      dbPath: optionalStringField(value, "runtime.db_path") ?? optionalStringField(value, "runtime.database_url") ?? "",
      databaseUrl: optionalStringField(value, "runtime.database_url") ?? optionalStringField(value, "runtime.db_path") ?? "",
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
  };
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

function optionalStringField(value: unknown, field: string): string | undefined {
  const fieldValue = getConfigValue(value, field);
  if (fieldValue === undefined) return undefined;
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

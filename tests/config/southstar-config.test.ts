import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_BOOTSTRAP_ENV, validateRuntimeConfig } from "../../src/config/schema.ts";
import { loadConfig, parseYamlSubset, readBootstrapEnv } from "../../src/config/load-config.ts";

const fixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.yaml");

test("loads Southstar config from .southstar.yaml shape", () => {
  const config = loadConfig(fixture, "/tmp/project-root-override");
  assert.equal(config.schemaVersion, "0.1");
  assert.equal(config.project.name, "test-southstar-project");
  assert.equal(config.project.root, "/tmp/project-root-override");
  assert.equal(config.runtime.dbPath, ".southstar/runtime/southstar.sqlite3");
  assert.equal(config.runtime.heartbeatIntervalSeconds, 30);
  assert.equal(config.runtime.lockTimeoutSeconds, 300);
  assert.equal(config.runtime.taskTimeoutSeconds, 3600);
  assert.equal(config.runtime.maxRetryAttempts, 2);
  assert.equal(config.intake.mode, "local");
  assert.deepEqual(config.sources, { github: { enabled: false }, jira: { enabled: false } });
  assert.equal(config.projection.github.blocksRuntime, false);
  assert.deepEqual(config.packs.searchPaths, [".southstar/packs", "packs"]);
  assert.equal(config.workflow.id, "generic_request_resolution");
  assert.equal(config.workflow.path, ".southstar/workflows/generic-request-resolution.yaml");
  assert.equal(config.agents.path, ".southstar/agents.yaml");
});

test("allows only Southstar bootstrap env names", () => {
  assert.deepEqual(ALLOWED_BOOTSTRAP_ENV, [
    "SOUTHSTAR_CONFIG",
    "SOUTHSTAR_PROJECT_ROOT",
    "SOUTHSTAR_DEBUG",
  ]);
  assert.deepEqual(readBootstrapEnv({
    SOUTHSTAR_CONFIG: ".southstar.yaml",
    SOUTHSTAR_PROJECT_ROOT: "/tmp/project",
    SOUTHSTAR_DEBUG: "1",
    NORTHSTAR_CONFIG: ".northstar.yaml",
  }), {
    SOUTHSTAR_CONFIG: ".southstar.yaml",
    SOUTHSTAR_PROJECT_ROOT: "/tmp/project",
    SOUTHSTAR_DEBUG: "1",
  });
});

test("validates intake modes and projection policy", () => {
  const parsed = parseYamlSubset(`
schema_version: "0.1"
project:
  name: x
  root: /tmp/x
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 30
  lock_timeout_seconds: 300
  task_timeout_seconds: 3600
  max_retry_attempts: 2
intake:
  mode: unsupported
sources:
  github:
    enabled: false
projection:
  github:
    enabled: false
    blocks_runtime: false
packs:
  search_paths: [packs]
workflow:
  id: generic_request_resolution
  version: "0.1"
  path: .southstar/workflows/generic-request-resolution.yaml
agents:
  path: .southstar/agents.yaml
`);
  assert.throws(() => validateRuntimeConfig(parsed), /intake.mode must be local, remote, or hybrid/);
});

test("validates mappings, booleans, and pack search paths", () => {
  assert.throws(() => validateRuntimeConfig(baseConfig({ sources: [] })), /sources must be a mapping/);
  assert.throws(() => validateRuntimeConfig(baseConfig({ projection: [] })), /projection must be a mapping/);
  assert.throws(() => validateRuntimeConfig(baseConfig({
    projection: { github: { enabled: false, blocks_runtime: "no" } },
  })), /projection.github.blocks_runtime must be a boolean/);
  assert.throws(() => validateRuntimeConfig(baseConfig({ packs: { search_paths: [] } })), /packs.search_paths must be a non-empty string array/);
});

test("runtime numeric fields must be non-negative integers", () => {
  assert.throws(() => validateRuntimeConfig(baseConfig({
    runtime: { heartbeat_interval_seconds: -1 },
  })), /runtime.heartbeat_interval_seconds must be a non-negative integer/);
  assert.throws(() => validateRuntimeConfig(baseConfig({
    runtime: { task_timeout_seconds: 1.5 },
  })), /runtime.task_timeout_seconds must be a non-negative integer/);
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return mergeConfig({
    schema_version: "0.1",
    project: { name: "x", root: "/tmp/x" },
    runtime: {
      db_path: ".southstar/runtime/southstar.sqlite3",
      heartbeat_interval_seconds: 30,
      lock_timeout_seconds: 300,
      task_timeout_seconds: 3600,
      max_retry_attempts: 2,
    },
    intake: { mode: "local" },
    sources: { github: { enabled: false } },
    projection: { github: { enabled: false, blocks_runtime: false } },
    packs: { search_paths: ["packs"] },
    workflow: {
      id: "generic_request_resolution",
      version: "0.1",
      path: ".southstar/workflows/generic-request-resolution.yaml",
    },
    agents: { path: ".southstar/agents.yaml" },
  }, overrides);
}

function mergeConfig(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isRecord(result[key]) && isRecord(value)
      ? mergeConfig(result[key], value)
      : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

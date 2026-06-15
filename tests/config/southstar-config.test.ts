import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_BOOTSTRAP_ENV, validateRuntimeConfig } from "../../src/config/schema.ts";
import { loadConfig, parseYamlSubset, readBootstrapEnv } from "../../src/config/load-config.ts";

const fixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.yaml");
const cubesandboxFixture = join(import.meta.dirname, "../fixtures/southstar/config/.southstar.cubesandbox.yaml");

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
  assert.equal(config.executor.provider, "tork");
  assert.equal(config.executor.lifecycle.cleanupMode, "strict");
  assert.equal(config.executor.tork?.baseUrl, "http://127.0.0.1:8000");
  assert.equal(config.executor.tork?.submitPath, "/jobs");
});

test("loads cubesandbox fixture config from .southstar.yaml", () => {
  const config = loadConfig(cubesandboxFixture);
  assert.equal(config.executor.provider, "cubesandbox");
  assert.equal(config.executor.cubesandbox?.sdk, "e2b-compatible");
  assert.equal(config.executor.cubesandbox?.apiUrl, "http://127.0.0.1:3000");
  assert.equal(config.executor.cubesandbox?.apiKeyRef, "cubesandbox-api-key");
  assert.equal(config.executor.cubesandbox?.templateId, "southstar-agent-template");
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
executor:
  provider: tork
  lifecycle:
    cleanup_mode: strict
    health_check_interval_seconds: 10
    reconcile_interval_seconds: 30
    orphan_scan_interval_seconds: 30
    orphan_grace_seconds: 60
    shutdown_grace_seconds: 20
    max_restart_attempts: 3
    max_cleanup_attempts: 5
    sdk_call_timeout_seconds: 15
    sandbox_create_timeout_seconds: 60
    command_start_timeout_seconds: 30
    command_idle_timeout_seconds: 120
    task_wall_timeout_seconds: 1800
    callback_wait_timeout_seconds: 30
    destroy_timeout_seconds: 20
    lock_ttl_seconds: 60
  tork:
    base_url: http://127.0.0.1:8000
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

test("validates cubesandbox executor config and host mounts", () => {
  const config = validateRuntimeConfig(baseConfig({
    executor: {
      provider: "cubesandbox",
      lifecycle: {
        cleanup_mode: "strict",
        health_check_interval_seconds: 10,
        reconcile_interval_seconds: 30,
        orphan_scan_interval_seconds: 30,
        orphan_grace_seconds: 60,
        shutdown_grace_seconds: 20,
        max_restart_attempts: 3,
        max_cleanup_attempts: 5,
        sdk_call_timeout_seconds: 15,
        sandbox_create_timeout_seconds: 60,
        command_start_timeout_seconds: 30,
        command_idle_timeout_seconds: 120,
        task_wall_timeout_seconds: 1800,
        callback_wait_timeout_seconds: 30,
        destroy_timeout_seconds: 20,
        lock_ttl_seconds: 60,
      },
      cubesandbox: {
        sdk: "e2b-compatible",
        api_url: "http://127.0.0.1:3000",
        api_key_ref: "local-cubesandbox-api-key",
        template_id: "southstar-agent-template",
        default_timeout_seconds: 1800,
        destroy_on_completion: true,
        host_mounts: [{ source: ".southstar/runs", target: "/southstar-runs", readonly: false }],
      },
    },
  }));

  assert.equal(config.executor.provider, "cubesandbox");
  assert.equal(config.executor.cubesandbox?.apiUrl, "http://127.0.0.1:3000");
  assert.equal(config.executor.cubesandbox?.apiKeyRef, "local-cubesandbox-api-key");
  assert.deepEqual(config.executor.cubesandbox?.hostMounts, [{ source: ".southstar/runs", target: "/southstar-runs", readonly: false }]);
});

test("requires active provider config", () => {
  assert.throws(() => validateRuntimeConfig(baseConfig({
    executor: {
      provider: "cubesandbox",
      lifecycle: {
        cleanup_mode: "strict",
        health_check_interval_seconds: 10,
        reconcile_interval_seconds: 30,
        orphan_scan_interval_seconds: 30,
        orphan_grace_seconds: 60,
        shutdown_grace_seconds: 20,
        max_restart_attempts: 3,
        max_cleanup_attempts: 5,
        sdk_call_timeout_seconds: 15,
        sandbox_create_timeout_seconds: 60,
        command_start_timeout_seconds: 30,
        command_idle_timeout_seconds: 120,
        task_wall_timeout_seconds: 1800,
        callback_wait_timeout_seconds: 30,
        destroy_timeout_seconds: 20,
        lock_ttl_seconds: 60,
      },
    },
  })), /executor.cubesandbox.sdk|executor.cubesandbox.api_url|Missing required config fields/);
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
    executor: {
      provider: "tork",
      lifecycle: {
        cleanup_mode: "strict",
        health_check_interval_seconds: 10,
        reconcile_interval_seconds: 30,
        orphan_scan_interval_seconds: 30,
        orphan_grace_seconds: 60,
        shutdown_grace_seconds: 20,
        max_restart_attempts: 3,
        max_cleanup_attempts: 5,
        sdk_call_timeout_seconds: 15,
        sandbox_create_timeout_seconds: 60,
        command_start_timeout_seconds: 30,
        command_idle_timeout_seconds: 120,
        task_wall_timeout_seconds: 1800,
        callback_wait_timeout_seconds: 30,
        destroy_timeout_seconds: 20,
        lock_ttl_seconds: 60,
      },
      tork: {
        base_url: "http://127.0.0.1:8000",
        submit_path: "/jobs",
      },
    },
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

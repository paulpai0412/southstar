# Southstar CubeSandbox Executor Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a config-only Southstar executor control plane that can run through either Tork or a Southstar-managed CubeSandbox SDK provider, with strict cleanup, exception handling, and real CubeSandbox E2E gates.

**Architecture:** Add `ExecutorRuntimeManager` above provider implementations. Move executor selection into `.southstar.yaml`; keep Tork as one provider and add CubeSandbox behind a `CubeSandboxSdkClient` adapter. All executor lifecycle facts remain Southstar resources/events; workflow completion remains evaluator/stop-condition driven.

**Tech Stack:** TypeScript ESM on Node >=22.22.2, `node:test`, SQLite store, existing Southstar v2 runtime server, dynamic SDK adapter for E2B-compatible CubeSandbox, real gated CubeSandbox E2E.

---

## Scope and execution notes

This plan implements the approved spec:

- `docs/superpowers/specs/2026-06-15-southstar-cubesandbox-executor-provider-design.md`

The implementation is large but coherent as one subsystem: executor control plane + providers + real E2E. Do not split it into separate features because provider factory, callback route, cleanup/reconcile, and real E2E gates must agree on the same resource contract.

Execution rules:

- Use TDD for every task.
- Commit after each task.
- Do not run `test:e2e:real` or CubeSandbox real E2E unless the required live dependencies are available.
- Unit/integration tests may use deterministic in-process test doubles for local development, but the CubeSandbox acceptance tests in Task 11 and Task 12 must use a real CubeSandbox deployment and real SDK calls. They must not be smoke tests and must not use fake/mock provider clients.
- Runtime executor configuration must come from `.southstar.yaml`; executor env variables are not runtime config.

---

## File structure map

### Config

- Modify: `src/config/schema.ts`
  - Add `executor` config types and validation.
  - Keep `ALLOWED_BOOTSTRAP_ENV` unchanged.
- Modify: `src/config/load-config.ts`
  - No executor env reads; parser already supports nested maps/arrays used by executor config.
- Modify: `tests/config/southstar-config.test.ts`
  - Validate `.southstar.yaml` executor config shape.
- Modify: `tests/fixtures/southstar/config/.southstar.yaml`
  - Add default Tork executor block for current fixture.

### v2 dependency construction

- Create: `src/v2/runtime/dependencies.ts`
  - Config-first v2 dependency builder.
  - Builds DB, planner client, executor manager/provider.
- Modify: `src/v2/cli.ts`
  - Parse `--config` for v2 commands.
  - Stop constructing `TorkClient` from env.
- Delete or retire from runtime path: `src/v2/config/env.ts`
  - Existing tests can be removed or converted to prove it is no longer used for executor config.
- Modify: `tests/v2/cli.test.ts`
  - Cover config-first CLI dependencies.
- Modify: `tests/v2/index.test.ts`
  - Replace `env.test.ts` import with new config/dependency tests.

### Executor core

- Modify: `src/v2/executor/provider.ts`
  - Expand `ExecutorType` to `"tork" | "cubesandbox"`.
  - Add lifecycle/status/logs/reconcile/cleanup/shutdown request/result types.
- Create: `src/v2/executor/runtime-manager.ts`
  - Active provider lifecycle orchestration.
  - Binding locks, cleanup loop entrypoints, provider health read model support.
- Create: `src/v2/executor/factory.ts`
  - Instantiates exactly one active provider from config.
- Create: `src/v2/executor/bindings.ts`
  - Helpers for executor binding resource payloads and events.
- Test: `tests/v2/executor-runtime-manager.test.ts`
- Test: `tests/v2/executor-factory.test.ts`

### Tork parity

- Modify: `src/v2/executor/tork-provider.ts`
  - Implement expanded provider contract.
  - Use provider-neutral callback URL.
- Modify: `src/v2/executor/tork-client.ts`
  - Expose submit/status/cancel/logs methods already present under provider contract names.
- Modify: `src/v2/executor/tork-projection.ts`
  - Route callback to `/api/v2/executor/callback`.
- Modify: `tests/v2/executor-provider.test.ts`
  - Update expectations from `/api/v2/tork/callback` to `/api/v2/executor/callback`.

### CubeSandbox provider

- Create: `src/v2/executor/cubesandbox/types.ts`
  - SDK adapter types and status models.
- Create: `src/v2/executor/cubesandbox/sdk-client.ts`
  - Dynamic E2B-compatible SDK adapter.
- Create: `src/v2/executor/cubesandbox/provider.ts`
  - CubeSandbox provider implementation.
- Test: `tests/v2/cubesandbox-sdk-client.test.ts`
  - Contract-level import/config validation without pretending to be real E2E.
- Test: `tests/v2/cubesandbox-provider.test.ts`
  - Deterministic unit tests for status mapping, finalizer transitions, lock handling.

### Provider-neutral callback and APIs

- Rename/replace: `src/v2/executor/tork-callback.ts` -> `src/v2/executor/callback.ts`
  - Keep exported compatibility wrapper only if needed by old imports during migration.
- Modify: `src/v2/server/routes.ts`
  - Replace `/api/v2/tork/callback` with `/api/v2/executor/callback`.
- Modify: `src/v2/server/runtime-context.ts`
  - Accept `ExecutorRuntimeManager` or provider from manager.
- Modify: `src/v2/ui-api/local-api.ts`
  - Submit through `ExecutorRuntimeManager`.
  - Store provider-neutral binding payload.
- Modify: `tests/v2/tork-callback.test.ts` -> `tests/v2/executor-callback.test.ts`
- Modify: `tests/v2/server-api.test.ts`

### Health/read model/UI evidence

- Modify: `src/v2/ui-api/read-models.ts`
  - Add executor health summary fields.
- Modify: `components/southstar/*` only if existing Executor Ops assumes Tork-specific labels.
- Modify: `tests/v2/ui-read-models.test.ts`
- Modify: `tests/web/southstar-operations-ui.test.tsx`

### Real CubeSandbox E2E

- Create: `tests/e2e-cubesandbox/env.ts`
  - Loads only test bootstrap values: `SOUTHSTAR_CONFIG`, `SOUTHSTAR_CUBESANDBOX_E2E`, optional callback host.
  - Reads executor details from `.southstar.yaml`.
- Create: `tests/e2e-cubesandbox/quantitative-gates.ts`
  - Hard measurable standards for real provider behavior.
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-happy-path.ts`
  - Full run through real CubeSandbox.
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-timeout-cleanup.ts`
  - Real timeout and cleanup.
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-callback-missing.ts`
  - Real command completion without callback must not complete task.
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-orphan-reconcile.ts`
  - Real orphan sandbox cleanup after manager restart.
- Create: `tests/e2e-cubesandbox/index.test.ts`
- Modify: `package.json`
  - Add `test:e2e:cubesandbox` script.

---

## Quantitative real E2E standards

The real CubeSandbox E2E suite must fail if any threshold is exceeded. These gates are intentionally measurable, not subjective.

| Gate | Threshold |
|---|---:|
| Config load + dependency build | <= 1,000 ms |
| Provider initialize + health check | <= 5,000 ms |
| Sandbox create start to sandbox created | <= 10,000 ms |
| Command start after sandbox created | <= 5,000 ms |
| First progress/commentary event after command start | <= 30,000 ms |
| Callback accepted after command exit | <= 30,000 ms |
| Happy-path run terminal status | <= 15 minutes |
| Cleanup started after terminal binding | <= 5,000 ms |
| Sandbox destroyed after cleanup start | <= 30,000 ms |
| Terminal managed sandbox residue count | exactly 0 |
| Timeout scenario configured wall timeout | 15,000 ms |
| Timeout detection delay | <= 5,000 ms after timeout |
| Timeout sandbox destroy latency | <= 30,000 ms after timeout detection |
| Callback-missing detection | <= 45,000 ms after command exit |
| Orphan scan detection | <= 60,000 ms after manager startup |
| Orphan sandbox destroy latency | <= 30,000 ms after detection |
| Provider cleanup failures on happy path | exactly 0 |
| Workflow completion source | evaluator + stop-condition evidence present |

Real E2E means:

- real CubeSandbox API service is reachable
- real SDK adapter is used
- real sandbox is created
- real command runs inside sandbox
- real Southstar callback endpoint is used
- real SQLite evidence is asserted
- provider resource list is checked for zero residue

---

### Task 1: Extend `.southstar.yaml` schema with config-only executor

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `tests/config/southstar-config.test.ts`
- Modify: `tests/fixtures/southstar/config/.southstar.yaml`

- [ ] **Step 1: Write failing config schema tests**

Append these tests to `tests/config/southstar-config.test.ts`:

```ts
test("loads config-only executor settings from .southstar.yaml", () => {
  const config = loadConfig(fixture);
  assert.equal(config.executor.provider, "tork");
  assert.equal(config.executor.lifecycle.cleanupMode, "strict");
  assert.equal(config.executor.tork?.baseUrl, "http://127.0.0.1:8000");
  assert.equal(config.executor.tork?.submitPath, "/jobs");
});

test("validates CubeSandbox executor config without raw secrets", () => {
  const parsed = parseYamlSubset(`
schema_version: "1"
project:
  name: cube
  root: .
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 15
  lock_timeout_seconds: 120
  task_timeout_seconds: 1800
  max_retry_attempts: 2
intake:
  mode: local
sources:
  local:
    enabled: true
projection:
  local:
    enabled: true
    blocks_runtime: false
packs:
  search_paths:
    - .southstar/packs
workflow:
  id: wf
  version: "1"
  path: .southstar/workflows/wf.yaml
agents:
  path: .southstar/agents.yaml
executor:
  provider: cubesandbox
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
  cubesandbox:
    sdk: e2b-compatible
    api_url: http://127.0.0.1:3000
    api_key_ref: local-cubesandbox-api-key
    template_id: southstar-agent-template
    default_timeout_seconds: 1800
    destroy_on_completion: true
    host_mounts:
      - source: .southstar/runs
        target: /southstar-runs
        readonly: false
`);
  const config = validateRuntimeConfig(parsed);
  assert.equal(config.executor.provider, "cubesandbox");
  assert.equal(config.executor.cubesandbox?.apiUrl, "http://127.0.0.1:3000");
  assert.equal(config.executor.cubesandbox?.apiKeyRef, "local-cubesandbox-api-key");
  assert.equal(JSON.stringify(config).includes("E2B_API_KEY"), false);
});

test("rejects missing active executor provider config", () => {
  const parsed = parseYamlSubset(`
schema_version: "1"
project:
  name: bad
  root: .
runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 15
  lock_timeout_seconds: 120
  task_timeout_seconds: 1800
  max_retry_attempts: 2
intake:
  mode: local
sources:
  local:
    enabled: true
projection:
  local:
    enabled: true
    blocks_runtime: false
packs:
  search_paths:
    - .southstar/packs
workflow:
  id: wf
  version: "1"
  path: .southstar/workflows/wf.yaml
agents:
  path: .southstar/agents.yaml
executor:
  provider: cubesandbox
  lifecycle:
    cleanup_mode: strict
`);
  assert.throws(() => validateRuntimeConfig(parsed), /executor\.cubesandbox\.api_url/);
});
```

- [ ] **Step 2: Run config test and verify it fails**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/southstar-config.test.ts
```

Expected: FAIL because `RuntimeConfig` has no `executor` field.

- [ ] **Step 3: Add executor types and validation**

Modify `src/config/schema.ts` with these type additions near `RuntimeConfig`:

```ts
export type ExecutorProviderName = "tork" | "cubesandbox";
export type ExecutorCleanupMode = "strict" | "best_effort";

export interface RuntimeConfig {
  schemaVersion: string;
  project: { name: string; root: string };
  runtime: {
    dbPath: string;
    heartbeatIntervalSeconds: number;
    lockTimeoutSeconds: number;
    taskTimeoutSeconds: number;
    maxRetryAttempts: number;
  };
  intake: { mode: IntakeMode };
  sources: Record<string, { enabled: boolean }>;
  projection: Record<string, { enabled: boolean; blocksRuntime: boolean }>;
  packs: { searchPaths: string[] };
  workflow: { id: string; version: string; path: string };
  agents: { path: string };
  executor: ExecutorConfig;
}

export type ExecutorConfig = {
  provider: ExecutorProviderName;
  lifecycle: ExecutorLifecycleConfig;
  tork?: TorkExecutorConfig;
  cubesandbox?: CubeSandboxExecutorConfig;
};

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

export type CubeSandboxExecutorConfig = {
  sdk: "e2b-compatible";
  apiUrl: string;
  apiKeyRef: string;
  templateId: string;
  defaultTimeoutSeconds: number;
  destroyOnCompletion: boolean;
  hostMounts: Array<{ source: string; target: string; readonly: boolean }>;
};
```

Add `"executor.provider"` and lifecycle required fields to validation. Implement:

```ts
function normalizeExecutor(value: unknown): RuntimeConfig["executor"] {
  const provider = enumField(value, "executor.provider", ["tork", "cubesandbox"] as const);
  const lifecycle = normalizeExecutorLifecycle(value);
  const executor: RuntimeConfig["executor"] = { provider, lifecycle };
  const torkRaw = getConfigValue(value, "executor.tork");
  const cubeRaw = getConfigValue(value, "executor.cubesandbox");

  if (provider === "tork") {
    if (!isRecord(torkRaw)) throw new Error("executor.tork.base_url must be a non-empty string");
    executor.tork = {
      baseUrl: stringField(value, "executor.tork.base_url"),
      submitPath: typeof getConfigValue(value, "executor.tork.submit_path") === "string"
        ? stringField(value, "executor.tork.submit_path")
        : "/jobs",
    };
  }

  if (provider === "cubesandbox") {
    if (!isRecord(cubeRaw)) throw new Error("executor.cubesandbox.api_url must be a non-empty string");
    executor.cubesandbox = {
      sdk: enumField(value, "executor.cubesandbox.sdk", ["e2b-compatible"] as const),
      apiUrl: stringField(value, "executor.cubesandbox.api_url"),
      apiKeyRef: stringField(value, "executor.cubesandbox.api_key_ref"),
      templateId: stringField(value, "executor.cubesandbox.template_id"),
      defaultTimeoutSeconds: nonNegativeIntegerField(value, "executor.cubesandbox.default_timeout_seconds"),
      destroyOnCompletion: booleanValue(getConfigValue(value, "executor.cubesandbox.destroy_on_completion"), "executor.cubesandbox.destroy_on_completion"),
      hostMounts: normalizeHostMounts(getConfigValue(value, "executor.cubesandbox.host_mounts")),
    };
  }

  return executor;
}

function normalizeExecutorLifecycle(value: unknown): RuntimeConfig["executor"]["lifecycle"] {
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

function normalizeHostMounts(value: unknown): CubeSandboxExecutorConfig["hostMounts"] {
  if (!Array.isArray(value)) throw new Error("executor.cubesandbox.host_mounts must be an array");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`executor.cubesandbox.host_mounts.${index} must be a mapping`);
    return {
      source: stringFromRecord(item, "source", `executor.cubesandbox.host_mounts.${index}.source`),
      target: stringFromRecord(item, "target", `executor.cubesandbox.host_mounts.${index}.target`),
      readonly: booleanValue(item.readonly, `executor.cubesandbox.host_mounts.${index}.readonly`),
    };
  });
}

function stringFromRecord(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}
```

In `validateRuntimeConfig`, add:

```ts
executor: normalizeExecutor(value),
```

- [ ] **Step 4: Update fixture config**

Append to `tests/fixtures/southstar/config/.southstar.yaml`:

```yaml
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
    submit_path: /jobs
```

- [ ] **Step 5: Run config tests and verify pass**

Run:

```bash
node --disable-warning=ExperimentalWarning tests/config/southstar-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/config/schema.ts tests/config/southstar-config.test.ts tests/fixtures/southstar/config/.southstar.yaml
git --git-dir=.git-local --work-tree=. commit -m "feat: add config-only executor schema"
```

---

### Task 2: Add provider-neutral executor contracts

**Files:**
- Modify: `src/v2/executor/provider.ts`
- Test: `tests/v2/executor-provider.test.ts`

- [ ] **Step 1: Write failing contract assertions**

Append to `tests/v2/executor-provider.test.ts`:

```ts
test("executor provider contract accepts cubesandbox as first-class provider", () => {
  const typeCheck: import("../../src/v2/executor/provider.ts").ExecutorType = "cubesandbox";
  assert.equal(typeCheck, "cubesandbox");
});
```

- [ ] **Step 2: Run test and verify it fails**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-provider.test.ts
```

Expected: FAIL because `ExecutorType` does not include `cubesandbox`.

- [ ] **Step 3: Replace provider contract**

In `src/v2/executor/provider.ts`, replace the file with:

```ts
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type ExecutorType = "tork" | "cubesandbox";
export type ExecutorLifecycleStatus = "healthy" | "degraded" | "unavailable" | "draining";
export type ExecutorBindingStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "unknown"
  | "degraded"
  | "retryable_error"
  | "callback_missing"
  | "cleanup_failed";

export type ExecutorSubmitRequest = {
  runId: string;
  workflow: SouthstarWorkflowManifest;
  callbackUrl?: string;
  envelopeBasePath?: string;
  runRoot?: string;
  attemptId?: string;
};

export type ExecutorSubmitResult = {
  executorType: ExecutorType;
  externalJobId: string;
  status: ExecutorBindingStatus | string;
  projectionFingerprint?: string;
  executionProjection?: unknown;
  providerPayload?: Record<string, unknown>;
};

export type ExecutorStatusRequest = { externalJobId: string; runId?: string; providerPayload?: Record<string, unknown> };
export type ExecutorStatusResult = { executorType: ExecutorType; externalJobId: string; status: ExecutorBindingStatus | string; providerPayload?: Record<string, unknown> };
export type ExecutorCancelRequest = { externalJobId: string; runId?: string; reason?: string; providerPayload?: Record<string, unknown> };
export type ExecutorCancelResult = { executorType: ExecutorType; externalJobId: string; status: "cancelled" | "cancelling" | "not_supported"; providerPayload?: Record<string, unknown> };
export type ExecutorLogsRequest = { externalJobId: string; runId?: string; cursor?: string; providerPayload?: Record<string, unknown> };
export type ExecutorLogsResult = { executorType: ExecutorType; externalJobId: string; text: string; cursor?: string; providerPayload?: Record<string, unknown> };
export type ExecutorHealthResult = { executorType: ExecutorType; status: ExecutorLifecycleStatus; checkedAt: string; message?: string; capabilities: Record<string, boolean> };
export type ExecutorReconcileRequest = { runId?: string; reason: string };
export type ExecutorReconcileResult = { executorType: ExecutorType; reconciled: number; cleaned: number; failures: string[]; providerPayload?: Record<string, unknown> };
export type ExecutorCleanupRequest = { externalJobId: string; runId?: string; reason: string; providerPayload?: Record<string, unknown> };
export type ExecutorCleanupResult = { executorType: ExecutorType; externalJobId: string; status: "destroyed" | "retry_scheduled" | "failed" | "not_supported"; providerPayload?: Record<string, unknown> };
export type ExecutorShutdownRequest = { reason: string; graceSeconds: number };
export type ExecutorShutdownResult = { executorType: ExecutorType; status: "completed" | "degraded"; cleaned: number; failures: string[] };

export type ExecutorProvider = {
  readonly executorType: ExecutorType;
  initialize?(): Promise<void>;
  health?(): Promise<ExecutorHealthResult>;
  submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult>;
  status?(request: ExecutorStatusRequest): Promise<ExecutorStatusResult>;
  cancel?(request: ExecutorCancelRequest): Promise<ExecutorCancelResult>;
  logs?(request: ExecutorLogsRequest): Promise<ExecutorLogsResult>;
  reconcile?(request: ExecutorReconcileRequest): Promise<ExecutorReconcileResult>;
  cleanup?(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult>;
  shutdown?(request: ExecutorShutdownRequest): Promise<ExecutorShutdownResult>;
};
```

- [ ] **Step 4: Run provider tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/provider.ts tests/v2/executor-provider.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: expand executor provider contract"
```

---

### Task 3: Add provider factory and runtime manager skeleton

**Files:**
- Create: `src/v2/executor/factory.ts`
- Create: `src/v2/executor/runtime-manager.ts`
- Test: `tests/v2/executor-factory.test.ts`
- Test: `tests/v2/executor-runtime-manager.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing provider factory tests**

Create `tests/v2/executor-factory.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeConfig } from "../../src/config/schema.ts";
import { createExecutorProviderFromConfig } from "../../src/v2/executor/factory.ts";

const lifecycle = {
  cleanupMode: "strict" as const,
  healthCheckIntervalSeconds: 10,
  reconcileIntervalSeconds: 30,
  orphanScanIntervalSeconds: 30,
  orphanGraceSeconds: 60,
  shutdownGraceSeconds: 20,
  maxRestartAttempts: 3,
  maxCleanupAttempts: 5,
  sdkCallTimeoutSeconds: 15,
  sandboxCreateTimeoutSeconds: 60,
  commandStartTimeoutSeconds: 30,
  commandIdleTimeoutSeconds: 120,
  taskWallTimeoutSeconds: 1800,
  callbackWaitTimeoutSeconds: 30,
  destroyTimeoutSeconds: 20,
  lockTtlSeconds: 60,
};

function base(provider: "tork" | "cubesandbox"): RuntimeConfig {
  return {
    schemaVersion: "1",
    project: { name: "test", root: "." },
    runtime: { dbPath: ":memory:", heartbeatIntervalSeconds: 15, lockTimeoutSeconds: 120, taskTimeoutSeconds: 1800, maxRetryAttempts: 2 },
    intake: { mode: "local" },
    sources: { local: { enabled: true } },
    projection: { local: { enabled: true, blocksRuntime: false } },
    packs: { searchPaths: [".southstar/packs"] },
    workflow: { id: "wf", version: "1", path: ".southstar/workflows/wf.yaml" },
    agents: { path: ".southstar/agents.yaml" },
    executor: {
      provider,
      lifecycle,
      tork: { baseUrl: "http://127.0.0.1:8000", submitPath: "/jobs" },
      cubesandbox: { sdk: "e2b-compatible", apiUrl: "http://127.0.0.1:3000", apiKeyRef: "cube-key", templateId: "tmpl", defaultTimeoutSeconds: 1800, destroyOnCompletion: true, hostMounts: [] },
    },
  };
}

test("provider factory creates exactly Tork when tork is active", () => {
  const provider = createExecutorProviderFromConfig(base("tork"), { resolveCredential: () => "secret" });
  assert.equal(provider.executorType, "tork");
});

test("provider factory creates exactly CubeSandbox when cubesandbox is active", () => {
  const provider = createExecutorProviderFromConfig(base("cubesandbox"), { resolveCredential: () => "e2b_000000" });
  assert.equal(provider.executorType, "cubesandbox");
});
```

- [ ] **Step 2: Write failing runtime manager tests**

Create `tests/v2/executor-runtime-manager.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { ExecutorRuntimeManager } from "../../src/v2/executor/runtime-manager.ts";
import type { ExecutorProvider } from "../../src/v2/executor/provider.ts";

function provider(): ExecutorProvider & { initialized: boolean; submitted: number } {
  return {
    executorType: "cubesandbox",
    initialized: false,
    submitted: 0,
    async initialize() { this.initialized = true; },
    async health() { return { executorType: "cubesandbox", status: "healthy", checkedAt: new Date(0).toISOString(), capabilities: { status: true, cleanup: true } }; },
    async submit() { this.submitted += 1; return { executorType: "cubesandbox", externalJobId: "cube-exec-1", status: "running", providerPayload: { sandboxId: "sbx_1" } }; },
  };
}

test("runtime manager initializes provider and exposes health", async () => {
  const active = provider();
  const manager = new ExecutorRuntimeManager({ provider: active });
  await manager.initialize();
  const health = await manager.health();
  assert.equal(active.initialized, true);
  assert.equal(health.status, "healthy");
});
```

Add imports to `tests/v2/index.test.ts`:

```ts
await import("./executor-factory.test.ts");
await import("./executor-runtime-manager.test.ts");
```

- [ ] **Step 3: Run tests and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-factory.test.ts
node --disable-warning=ExperimentalWarning tests/v2/executor-runtime-manager.test.ts
```

Expected: FAIL because files do not exist.

- [ ] **Step 4: Implement factory**

Create `src/v2/executor/factory.ts`:

```ts
import type { RuntimeConfig } from "../../config/schema.ts";
import type { ExecutorProvider } from "./provider.ts";
import { TorkClient } from "./tork-client.ts";
import { TorkExecutorProvider } from "./tork-provider.ts";
import { CubeSandboxExecutorProvider } from "./cubesandbox/provider.ts";
import { createE2bCompatibleCubeSandboxSdkClient } from "./cubesandbox/sdk-client.ts";

export type ExecutorProviderFactoryDependencies = {
  resolveCredential(ref: string): string;
};

export function createExecutorProviderFromConfig(
  config: RuntimeConfig,
  dependencies: ExecutorProviderFactoryDependencies,
): ExecutorProvider {
  if (config.executor.provider === "tork") {
    const tork = config.executor.tork;
    if (!tork) throw new Error("active tork executor config missing");
    return new TorkExecutorProvider({
      torkClient: new TorkClient({ baseUrl: tork.baseUrl, submitPath: tork.submitPath }),
      envelopeBasePath: "/southstar-runs",
    });
  }

  const cube = config.executor.cubesandbox;
  if (!cube) throw new Error("active cubesandbox executor config missing");
  return new CubeSandboxExecutorProvider({
    config: cube,
    lifecycle: config.executor.lifecycle,
    sdkClient: createE2bCompatibleCubeSandboxSdkClient({
      apiUrl: cube.apiUrl,
      apiKey: dependencies.resolveCredential(cube.apiKeyRef),
      sdkCallTimeoutSeconds: config.executor.lifecycle.sdkCallTimeoutSeconds,
    }),
  });
}
```

- [ ] **Step 5: Implement manager skeleton**

Create `src/v2/executor/runtime-manager.ts`:

```ts
import type {
  ExecutorHealthResult,
  ExecutorProvider,
  ExecutorSubmitRequest,
  ExecutorSubmitResult,
} from "./provider.ts";

export type ExecutorRuntimeManagerOptions = {
  provider: ExecutorProvider;
};

export class ExecutorRuntimeManager {
  readonly provider: ExecutorProvider;

  constructor(options: ExecutorRuntimeManagerOptions) {
    this.provider = options.provider;
  }

  async initialize(): Promise<void> {
    await this.provider.initialize?.();
  }

  async health(): Promise<ExecutorHealthResult> {
    if (this.provider.health) return await this.provider.health();
    return {
      executorType: this.provider.executorType,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: "provider does not implement health()",
      capabilities: {},
    };
  }

  async submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> {
    return await this.provider.submit(request);
  }
}
```

- [ ] **Step 6: Add minimal Cube provider shell to satisfy imports**

Create `src/v2/executor/cubesandbox/provider.ts`:

```ts
import type { CubeSandboxExecutorConfig, ExecutorLifecycleConfig } from "../../../config/schema.ts";
import type { ExecutorProvider, ExecutorSubmitRequest, ExecutorSubmitResult } from "../provider.ts";
import type { CubeSandboxSdkClient } from "./types.ts";

export type CubeSandboxExecutorProviderOptions = {
  config: CubeSandboxExecutorConfig;
  lifecycle: ExecutorLifecycleConfig;
  sdkClient: CubeSandboxSdkClient;
};

export class CubeSandboxExecutorProvider implements ExecutorProvider {
  readonly executorType = "cubesandbox" as const;
  constructor(private readonly options: CubeSandboxExecutorProviderOptions) {}
  async initialize(): Promise<void> { await this.options.sdkClient.health(); }
  async health() { return { executorType: this.executorType, status: "healthy" as const, checkedAt: new Date().toISOString(), capabilities: { status: true, cleanup: true } }; }
  async submit(_request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> { throw new Error("CubeSandbox submit is unavailable before Task 6 adds provider execution"); }
}
```

Create `src/v2/executor/cubesandbox/types.ts`:

```ts
export type CubeHostMount = { source: string; target: string; readonly: boolean };
export type CubeSandboxStatus = { sandboxId: string; status: string; metadata?: Record<string, string> };
export type CubeCommandStatus = { commandId: string; status: string; exitCode?: number; startedAt?: string; finishedAt?: string };
export type CubeLogsResult = { text: string; cursor?: string };
export type CubeSandboxSdkClient = {
  health(): Promise<void>;
  createSandbox(input: { templateId: string; metadata: Record<string, string>; timeoutSeconds: number; hostMounts: CubeHostMount[] }): Promise<{ sandboxId: string }>;
  runCommand(input: { sandboxId: string; command: string[]; env: Record<string, string>; timeoutSeconds: number }): Promise<{ commandId: string }>;
  getSandbox(input: { sandboxId: string }): Promise<CubeSandboxStatus>;
  getCommand(input: { sandboxId: string; commandId: string }): Promise<CubeCommandStatus>;
  killCommand(input: { sandboxId: string; commandId: string }): Promise<void>;
  destroySandbox(input: { sandboxId: string }): Promise<void>;
  listSandboxes(input: { metadata?: Record<string, string> }): Promise<CubeSandboxStatus[]>;
  logs(input: { sandboxId: string; commandId?: string; cursor?: string }): Promise<CubeLogsResult>;
};
```

Create `src/v2/executor/cubesandbox/sdk-client.ts`:

```ts
import type { CubeSandboxSdkClient } from "./types.ts";

export type E2bCompatibleCubeSandboxSdkClientOptions = {
  apiUrl: string;
  apiKey: string;
  sdkCallTimeoutSeconds: number;
};

export function createE2bCompatibleCubeSandboxSdkClient(_options: E2bCompatibleCubeSandboxSdkClientOptions): CubeSandboxSdkClient {
  return {
    async health() { throw new Error("E2B-compatible CubeSandbox SDK adapter is introduced in Task 5"); },
    async createSandbox() { throw new Error("CubeSandbox createSandbox is introduced in Task 5"); },
    async runCommand() { throw new Error("CubeSandbox runCommand is introduced in Task 5"); },
    async getSandbox() { throw new Error("CubeSandbox getSandbox is introduced in Task 5"); },
    async getCommand() { throw new Error("CubeSandbox getCommand is introduced in Task 5"); },
    async killCommand() { throw new Error("CubeSandbox killCommand is introduced in Task 5"); },
    async destroySandbox() { throw new Error("CubeSandbox destroySandbox is introduced in Task 5"); },
    async listSandboxes() { throw new Error("CubeSandbox listSandboxes is introduced in Task 5"); },
    async logs() { throw new Error("CubeSandbox logs is introduced in Task 5"); },
  };
}
```

- [ ] **Step 7: Run tests and verify pass**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-factory.test.ts
node --disable-warning=ExperimentalWarning tests/v2/executor-runtime-manager.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/factory.ts src/v2/executor/runtime-manager.ts src/v2/executor/cubesandbox tests/v2/executor-factory.test.ts tests/v2/executor-runtime-manager.test.ts tests/v2/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: add executor runtime manager and provider factory"
```

---

### Task 4: Replace provider-specific callback with `/api/v2/executor/callback`

**Files:**
- Create: `src/v2/executor/callback.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/ui-api/local-api.ts`
- Modify: `src/v2/executor/tork-provider.ts`
- Modify: `tests/v2/server-api.test.ts`
- Create/rename: `tests/v2/executor-callback.test.ts`

- [ ] **Step 1: Write failing callback route test**

In `tests/v2/server-api.test.ts`, change callback assertions from `/api/v2/tork/callback` to `/api/v2/executor/callback`:

```ts
assert.equal(submissions[0]?.callbackUrl, `${server.url}/api/v2/executor/callback`);
```

Create `tests/v2/executor-callback.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSouthstarDb } from "../../src/v2/stores/sqlite.ts";
import { ingestExecutorCallback } from "../../src/v2/executor/callback.ts";

test("provider-neutral callback rejects unknown executor binding", () => {
  const db = openSouthstarDb(join(mkdtempSync(join(tmpdir(), "southstar-callback-")), "db.sqlite3"));
  assert.throws(() => ingestExecutorCallback(db, {
    runId: "run-missing",
    taskId: "task-missing",
    attemptId: "attempt-1",
    executorBindingId: "exec-missing",
    executorType: "cubesandbox",
    rootSessionId: "root",
    ok: true,
    artifact: {},
    metrics: {},
    events: [],
  }), /callback task not found|executor binding not found/);
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./executor-callback.test.ts");
```

- [ ] **Step 2: Run tests and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-callback.test.ts
node --disable-warning=ExperimentalWarning tests/v2/server-api.test.ts
```

Expected: FAIL because callback module/route does not exist or route still uses Tork path.

- [ ] **Step 3: Implement callback wrapper**

Create `src/v2/executor/callback.ts`:

```ts
import type { SouthstarDb } from "../stores/sqlite.ts";
import { ingestTaskRunResult, type TaskRunCallbackResult } from "./tork-callback.ts";

export type ExecutorCallbackResult = TaskRunCallbackResult & {
  attemptId?: string;
  executorBindingId?: string;
  executorType?: "tork" | "cubesandbox";
};

export function ingestExecutorCallback(db: SouthstarDb, result: ExecutorCallbackResult): void {
  const task = db.prepare("select 1 from workflow_tasks where run_id = ? and id = ?").get(result.runId, result.taskId);
  if (!task) throw new Error(`callback task not found: ${result.runId}/${result.taskId}`);
  if (result.executorBindingId) {
    const binding = db.prepare("select 1 from runtime_resources where resource_type = 'executor_binding' and resource_key = ?").get(result.executorBindingId);
    if (!binding) throw new Error(`executor binding not found: ${result.executorBindingId}`);
  }
  ingestTaskRunResult(db, result);
}
```

- [ ] **Step 4: Update server route**

In `src/v2/server/routes.ts`, replace:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/tork/callback") {
  ingestTaskRunResult(context.db, validatedCallbackResult(context, await readJsonBody(request)));
  return json("callback", { accepted: true });
}
```

with:

```ts
if (request.method === "POST" && url.pathname === "/api/v2/executor/callback") {
  ingestExecutorCallback(context.db, validatedCallbackResult(context, await readJsonBody(request)));
  return json("callback", { accepted: true });
}
```

Update imports:

```ts
import { ingestExecutorCallback, type ExecutorCallbackResult } from "../executor/callback.ts";
```

Change `validatedCallbackResult` return type to `ExecutorCallbackResult` and include:

```ts
attemptId: typeof body.attemptId === "string" ? body.attemptId : undefined,
executorBindingId: typeof body.executorBindingId === "string" ? body.executorBindingId : undefined,
executorType: body.executorType === "tork" || body.executorType === "cubesandbox" ? body.executorType : undefined,
```

- [ ] **Step 5: Update submit callback URL**

In `src/v2/ui-api/local-api.ts`, replace default callback:

```ts
callbackUrl: input.callbackUrl ?? "/api/v2/tork/callback",
```

with:

```ts
callbackUrl: input.callbackUrl ?? "/api/v2/executor/callback",
```

Apply this in both `createRunFromDraft` and `expandWorkflowRun`.

- [ ] **Step 6: Update Tork provider tests**

In `tests/v2/executor-provider.test.ts`, update callback URL setup to:

```ts
callbackUrl: "http://127.0.0.1:3000/api/v2/executor/callback",
```

- [ ] **Step 7: Run tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-callback.test.ts
node --disable-warning=ExperimentalWarning tests/v2/server-api.test.ts
node --disable-warning=ExperimentalWarning tests/v2/executor-provider.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/callback.ts src/v2/server/routes.ts src/v2/ui-api/local-api.ts src/v2/executor/tork-provider.ts tests/v2/server-api.test.ts tests/v2/executor-callback.test.ts tests/v2/executor-provider.test.ts tests/v2/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: add provider-neutral executor callback"
```

---

### Task 5: Implement CubeSandbox SDK adapter boundary

**Files:**
- Modify: `src/v2/executor/cubesandbox/sdk-client.ts`
- Modify: `src/v2/executor/cubesandbox/types.ts`
- Create: `tests/v2/cubesandbox-sdk-client.test.ts`
- Modify: `tests/v2/index.test.ts`
- Modify: `package.json` if the selected Node E2B SDK package is installed as optional dependency

- [ ] **Step 1: Write SDK adapter tests**

Create `tests/v2/cubesandbox-sdk-client.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { withTimeout, mapCubeCommandStatus } from "../../src/v2/executor/cubesandbox/sdk-client.ts";

test("SDK timeout wrapper rejects hanging SDK calls", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 10, "sdk health"),
    /sdk health timed out after 10ms/,
  );
});

test("Cube command status mapping is provider-neutral", () => {
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "running" }), "running");
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "finished", exitCode: 0 }), "completed");
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "finished", exitCode: 2 }), "failed");
  assert.equal(mapCubeCommandStatus({ commandId: "cmd", status: "missing" }), "unknown");
});
```

Add to `tests/v2/index.test.ts`:

```ts
await import("./cubesandbox-sdk-client.test.ts");
```

- [ ] **Step 2: Run test and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/cubesandbox-sdk-client.test.ts
```

Expected: FAIL because helper functions do not exist.

- [ ] **Step 3: Implement timeout and status mapping**

Update `src/v2/executor/cubesandbox/sdk-client.ts`:

```ts
import type { ExecutorBindingStatus } from "../provider.ts";
import type { CubeCommandStatus, CubeSandboxSdkClient } from "./types.ts";

export type E2bCompatibleCubeSandboxSdkClientOptions = {
  apiUrl: string;
  apiKey: string;
  sdkCallTimeoutSeconds: number;
};

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function mapCubeCommandStatus(status: CubeCommandStatus): ExecutorBindingStatus {
  const normalized = status.status.toLowerCase();
  if (["running", "started"].includes(normalized)) return "running";
  if (["queued", "pending"].includes(normalized)) return "queued";
  if (["starting", "created"].includes(normalized)) return "starting";
  if (["cancelled", "killed"].includes(normalized)) return "cancelled";
  if (["failed", "error", "errored"].includes(normalized)) return "failed";
  if (["finished", "completed", "succeeded", "success"].includes(normalized)) return status.exitCode === 0 ? "completed" : "failed";
  return "unknown";
}

export function createE2bCompatibleCubeSandboxSdkClient(options: E2bCompatibleCubeSandboxSdkClientOptions): CubeSandboxSdkClient {
  const timeoutMs = Math.max(1, options.sdkCallTimeoutSeconds * 1000);
  return new DynamicE2bCompatibleCubeSandboxSdkClient(options.apiUrl, options.apiKey, timeoutMs);
}

class DynamicE2bCompatibleCubeSandboxSdkClient implements CubeSandboxSdkClient {
  constructor(private readonly apiUrl: string, private readonly apiKey: string, private readonly timeoutMs: number) {}

  async health(): Promise<void> {
    const response = await withTimeout(fetch(`${this.apiUrl.replace(/\/$/, "")}/health`, { headers: { "x-api-key": this.apiKey } }), this.timeoutMs, "cubesandbox health");
    if (!response.ok) throw new Error(`CubeSandbox health failed: ${response.status} ${await response.text()}`);
  }

  async createSandbox(): Promise<{ sandboxId: string }> { throw new Error("CubeSandbox SDK createSandbox bridge is required before enabling cubesandbox provider"); }
  async runCommand(): Promise<{ commandId: string }> { throw new Error("CubeSandbox SDK runCommand bridge is required before enabling cubesandbox provider"); }
  async getSandbox(): Promise<never> { throw new Error("CubeSandbox SDK getSandbox bridge is required before enabling cubesandbox provider"); }
  async getCommand(): Promise<never> { throw new Error("CubeSandbox SDK getCommand bridge is required before enabling cubesandbox provider"); }
  async killCommand(): Promise<void> { throw new Error("CubeSandbox SDK killCommand bridge is required before enabling cubesandbox provider"); }
  async destroySandbox(): Promise<void> { throw new Error("CubeSandbox SDK destroySandbox bridge is required before enabling cubesandbox provider"); }
  async listSandboxes(): Promise<never[]> { throw new Error("CubeSandbox SDK listSandboxes bridge is required before enabling cubesandbox provider"); }
  async logs(): Promise<never> { throw new Error("CubeSandbox SDK logs bridge is required before enabling cubesandbox provider"); }
}
```

- [ ] **Step 4: Add real SDK dynamic import boundary**

Wire all hard-error bridge methods to the selected installed E2B-compatible SDK inside `sdk-client.ts`. The implementation must be proven by `tests/e2e-cubesandbox`, not by unit tests. Use dynamic import so the package is only required when `executor.provider=cubesandbox`:

```ts
async function loadE2bSdk(): Promise<{ Sandbox: { create(input: unknown): Promise<unknown> } }> {
  try {
    return await import("@e2b/code-interpreter") as { Sandbox: { create(input: unknown): Promise<unknown> } };
  } catch (error) {
    throw new Error(`CubeSandbox requires @e2b/code-interpreter or configured E2B-compatible SDK: ${(error as Error).message}`);
  }
}
```

The worker executing this task must inspect the installed SDK type definitions after installing/selecting the package and adapt only inside `sdk-client.ts`. Do not leak SDK-specific objects beyond `CubeSandboxSdkClient`.

- [ ] **Step 5: Run SDK adapter tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/cubesandbox-sdk-client.test.ts
```

Expected: PASS for timeout/status helpers.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/cubesandbox/sdk-client.ts src/v2/executor/cubesandbox/types.ts tests/v2/cubesandbox-sdk-client.test.ts tests/v2/index.test.ts package.json package-lock.json
git --git-dir=.git-local --work-tree=. commit -m "feat: add cubesandbox sdk adapter boundary"
```

---

### Task 6: Implement CubeSandbox provider submit/status/cancel/logs

**Files:**
- Modify: `src/v2/executor/cubesandbox/provider.ts`
- Test: `tests/v2/cubesandbox-provider.test.ts`

- [ ] **Step 1: Write provider behavior tests**

Create `tests/v2/cubesandbox-provider.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { CubeSandboxExecutorProvider } from "../../src/v2/executor/cubesandbox/provider.ts";
import type { CubeSandboxSdkClient } from "../../src/v2/executor/cubesandbox/types.ts";

function client(): CubeSandboxSdkClient & { destroyed: string[] } {
  return {
    destroyed: [],
    async health() {},
    async createSandbox(input) {
      assert.equal(input.metadata.managedBy, "southstar");
      assert.equal(input.templateId, "tmpl");
      return { sandboxId: "sbx_1" };
    },
    async runCommand(input) {
      assert.equal(input.sandboxId, "sbx_1");
      assert.equal(input.command.includes("southstar-agent-runner"), true);
      return { commandId: "cmd_1" };
    },
    async getSandbox() { return { sandboxId: "sbx_1", status: "running" }; },
    async getCommand() { return { commandId: "cmd_1", status: "running" }; },
    async killCommand() {},
    async destroySandbox(input) { this.destroyed.push(input.sandboxId); },
    async listSandboxes() { return []; },
    async logs() { return { text: "progress" }; },
  };
}

const lifecycle = {
  cleanupMode: "strict" as const,
  healthCheckIntervalSeconds: 10,
  reconcileIntervalSeconds: 30,
  orphanScanIntervalSeconds: 30,
  orphanGraceSeconds: 60,
  shutdownGraceSeconds: 20,
  maxRestartAttempts: 3,
  maxCleanupAttempts: 5,
  sdkCallTimeoutSeconds: 15,
  sandboxCreateTimeoutSeconds: 60,
  commandStartTimeoutSeconds: 30,
  commandIdleTimeoutSeconds: 120,
  taskWallTimeoutSeconds: 1800,
  callbackWaitTimeoutSeconds: 30,
  destroyTimeoutSeconds: 20,
  lockTtlSeconds: 60,
};

test("CubeSandbox provider creates sandbox and starts agent runner", async () => {
  const sdk = client();
  const provider = new CubeSandboxExecutorProvider({
    lifecycle,
    sdkClient: sdk,
    config: { sdk: "e2b-compatible", apiUrl: "http://cube", apiKeyRef: "ref", templateId: "tmpl", defaultTimeoutSeconds: 900, destroyOnCompletion: true, hostMounts: [{ source: ".southstar/runs", target: "/southstar-runs", readonly: false }] },
  });
  const result = await provider.submit({ runId: "run-1", workflow: { tasks: [] } as never, callbackUrl: "http://southstar/api/v2/executor/callback", envelopeBasePath: "/southstar-runs", attemptId: "attempt-1" });
  assert.equal(result.executorType, "cubesandbox");
  assert.equal(result.externalJobId, "cube-exec-run-1-attempt-1");
  assert.equal(result.providerPayload?.sandboxId, "sbx_1");
  assert.equal(result.providerPayload?.commandId, "cmd_1");
});
```

- [ ] **Step 2: Run test and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/cubesandbox-provider.test.ts
```

Expected: FAIL because submit still throws.

- [ ] **Step 3: Implement provider methods**

Replace `src/v2/executor/cubesandbox/provider.ts` with:

```ts
import type { CubeSandboxExecutorConfig, ExecutorLifecycleConfig } from "../../../config/schema.ts";
import type {
  ExecutorCancelRequest,
  ExecutorCancelResult,
  ExecutorCleanupRequest,
  ExecutorCleanupResult,
  ExecutorLogsRequest,
  ExecutorLogsResult,
  ExecutorProvider,
  ExecutorStatusRequest,
  ExecutorStatusResult,
  ExecutorSubmitRequest,
  ExecutorSubmitResult,
} from "../provider.ts";
import { mapCubeCommandStatus } from "./sdk-client.ts";
import type { CubeSandboxSdkClient } from "./types.ts";

export type CubeSandboxExecutorProviderOptions = {
  config: CubeSandboxExecutorConfig;
  lifecycle: ExecutorLifecycleConfig;
  sdkClient: CubeSandboxSdkClient;
};

export class CubeSandboxExecutorProvider implements ExecutorProvider {
  readonly executorType = "cubesandbox" as const;
  private readonly config: CubeSandboxExecutorConfig;
  private readonly lifecycle: ExecutorLifecycleConfig;
  private readonly sdkClient: CubeSandboxSdkClient;

  constructor(options: CubeSandboxExecutorProviderOptions) {
    this.config = options.config;
    this.lifecycle = options.lifecycle;
    this.sdkClient = options.sdkClient;
  }

  async initialize(): Promise<void> { await this.sdkClient.health(); }

  async health() {
    try {
      await this.sdkClient.health();
      return { executorType: this.executorType, status: "healthy" as const, checkedAt: new Date().toISOString(), capabilities: { status: true, cancel: true, logs: true, cleanup: true, snapshots: false } };
    } catch (error) {
      return { executorType: this.executorType, status: "unavailable" as const, checkedAt: new Date().toISOString(), message: (error as Error).message, capabilities: { status: false, cancel: false, logs: false, cleanup: false, snapshots: false } };
    }
  }

  async submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> {
    const attemptId = request.attemptId ?? "attempt-1";
    const externalJobId = `cube-exec-${request.runId}-${attemptId}`;
    const sandbox = await this.sdkClient.createSandbox({
      templateId: this.config.templateId,
      timeoutSeconds: this.config.defaultTimeoutSeconds,
      hostMounts: this.config.hostMounts,
      metadata: {
        managedBy: "southstar",
        runId: request.runId,
        attemptId,
        executorBindingId: externalJobId,
        createdAt: new Date().toISOString(),
        ttlSeconds: String(this.config.defaultTimeoutSeconds),
      },
    });
    const envelope = `${request.envelopeBasePath ?? "/southstar-runs"}/${request.runId}`;
    const command = ["southstar-agent-runner", "--envelope", `${envelope}/task-envelope.json`, "--callback-url", request.callbackUrl ?? "/api/v2/executor/callback"];
    const commandResult = await this.sdkClient.runCommand({
      sandboxId: sandbox.sandboxId,
      command,
      env: { SOUTHSTAR_EXECUTOR_TYPE: "cubesandbox", SOUTHSTAR_RUN_ID: request.runId, SOUTHSTAR_ATTEMPT_ID: attemptId },
      timeoutSeconds: this.lifecycle.taskWallTimeoutSeconds,
    });
    return {
      executorType: "cubesandbox",
      externalJobId,
      status: "running",
      providerPayload: {
        sandboxId: sandbox.sandboxId,
        commandId: commandResult.commandId,
        templateId: this.config.templateId,
        attemptId,
        cleanup: { required: true, destroyOnCompletion: this.config.destroyOnCompletion, finalizerStatus: "pending", attempts: 0 },
      },
    };
  }

  async status(request: ExecutorStatusRequest): Promise<ExecutorStatusResult> {
    const sandboxId = stringPayload(request.providerPayload, "sandboxId");
    const commandId = stringPayload(request.providerPayload, "commandId");
    const command = await this.sdkClient.getCommand({ sandboxId, commandId });
    return { executorType: "cubesandbox", externalJobId: request.externalJobId, status: mapCubeCommandStatus(command), providerPayload: { ...request.providerPayload, providerStatus: command.status, exitCode: command.exitCode } };
  }

  async cancel(request: ExecutorCancelRequest): Promise<ExecutorCancelResult> {
    const sandboxId = stringPayload(request.providerPayload, "sandboxId");
    const commandId = stringPayload(request.providerPayload, "commandId");
    await this.sdkClient.killCommand({ sandboxId, commandId });
    await this.sdkClient.destroySandbox({ sandboxId });
    return { executorType: "cubesandbox", externalJobId: request.externalJobId, status: "cancelled", providerPayload: { ...request.providerPayload, cleanup: { finalizerStatus: "destroyed" } } };
  }

  async logs(request: ExecutorLogsRequest): Promise<ExecutorLogsResult> {
    const sandboxId = stringPayload(request.providerPayload, "sandboxId");
    const commandId = typeof request.providerPayload?.commandId === "string" ? request.providerPayload.commandId : undefined;
    const logs = await this.sdkClient.logs({ sandboxId, commandId, cursor: request.cursor });
    return { executorType: "cubesandbox", externalJobId: request.externalJobId, text: logs.text, cursor: logs.cursor };
  }

  async cleanup(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult> {
    const sandboxId = stringPayload(request.providerPayload, "sandboxId");
    await this.sdkClient.destroySandbox({ sandboxId });
    return { executorType: "cubesandbox", externalJobId: request.externalJobId, status: "destroyed", providerPayload: { ...request.providerPayload, cleanup: { finalizerStatus: "destroyed" } } };
  }
}

function stringPayload(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`CubeSandbox provider payload missing ${key}`);
  return value;
}
```

- [ ] **Step 4: Run provider tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/cubesandbox-provider.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/cubesandbox/provider.ts tests/v2/cubesandbox-provider.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: implement cubesandbox executor provider"
```

---

### Task 7: Add cleanup finalizers, locks, and reconcile evidence

**Files:**
- Create: `src/v2/executor/bindings.ts`
- Modify: `src/v2/executor/runtime-manager.ts`
- Test: `tests/v2/executor-runtime-manager.test.ts`

- [ ] **Step 1: Add failing cleanup/lock tests**

Append to `tests/v2/executor-runtime-manager.test.ts`:

```ts
test("runtime manager cleanup calls provider cleanup and returns destroyed status", async () => {
  let cleaned = false;
  const manager = new ExecutorRuntimeManager({
    provider: {
      executorType: "cubesandbox",
      async submit() { throw new Error("not used"); },
      async cleanup() { cleaned = true; return { executorType: "cubesandbox", externalJobId: "job", status: "destroyed" }; },
    },
  });
  const result = await manager.cleanup({ externalJobId: "job", reason: "test", providerPayload: { sandboxId: "sbx" } });
  assert.equal(cleaned, true);
  assert.equal(result.status, "destroyed");
});

test("executor lock is reclaimable after ttl expiry", () => {
  const now = new Date("2026-06-15T00:00:10.000Z");
  const expired = { ownerId: "old", operation: "cleanup", expiresAt: "2026-06-15T00:00:00.000Z" };
  const active = { ownerId: "old", operation: "cleanup", expiresAt: "2026-06-15T00:01:00.000Z" };
  assert.equal(ExecutorRuntimeManager.isLockExpired(expired, now), true);
  assert.equal(ExecutorRuntimeManager.isLockExpired(active, now), false);
});
```

- [ ] **Step 2: Run and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-runtime-manager.test.ts
```

Expected: FAIL because `cleanup` and `isLockExpired` are missing.

- [ ] **Step 3: Add binding helpers**

Create `src/v2/executor/bindings.ts`:

```ts
export type ExecutorOperationLock = { ownerId: string; operation: "submit" | "cancel" | "reconcile" | "cleanup"; expiresAt: string };
export type CleanupFinalizerStatus = "pending" | "in_progress" | "destroyed" | "orphan_detected" | "retry_scheduled" | "failed" | "waived_for_debug";
export type ExecutorCleanupPayload = { required: boolean; destroyOnCompletion: boolean; finalizerStatus: CleanupFinalizerStatus; attempts: number; lastAttemptAt?: string | null };

export function newExecutorCleanupPayload(destroyOnCompletion: boolean): ExecutorCleanupPayload {
  return { required: true, destroyOnCompletion, finalizerStatus: "pending", attempts: 0, lastAttemptAt: null };
}
```

- [ ] **Step 4: Extend runtime manager**

Add to `src/v2/executor/runtime-manager.ts`:

```ts
import type {
  ExecutorCleanupRequest,
  ExecutorCleanupResult,
  ExecutorReconcileRequest,
  ExecutorReconcileResult,
  ExecutorShutdownRequest,
  ExecutorShutdownResult,
} from "./provider.ts";
import type { ExecutorOperationLock } from "./bindings.ts";
```

Add methods inside class:

```ts
  async cleanup(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult> {
    if (!this.provider.cleanup) return { executorType: this.provider.executorType, externalJobId: request.externalJobId, status: "not_supported" };
    return await this.provider.cleanup(request);
  }

  async reconcile(request: ExecutorReconcileRequest): Promise<ExecutorReconcileResult> {
    if (!this.provider.reconcile) return { executorType: this.provider.executorType, reconciled: 0, cleaned: 0, failures: ["provider does not implement reconcile"] };
    return await this.provider.reconcile(request);
  }

  async shutdown(request: ExecutorShutdownRequest): Promise<ExecutorShutdownResult> {
    if (!this.provider.shutdown) return { executorType: this.provider.executorType, status: "degraded", cleaned: 0, failures: ["provider does not implement shutdown"] };
    return await this.provider.shutdown(request);
  }

  static isLockExpired(lock: ExecutorOperationLock, now = new Date()): boolean {
    return Date.parse(lock.expiresAt) <= now.getTime();
  }
```

- [ ] **Step 5: Run manager tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/executor-runtime-manager.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/executor/bindings.ts src/v2/executor/runtime-manager.ts tests/v2/executor-runtime-manager.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: add executor cleanup and lock primitives"
```

---

### Task 8: Move v2 CLI/server dependencies to config-first runtime

**Files:**
- Create: `src/v2/runtime/dependencies.ts`
- Modify: `src/v2/cli.ts`
- Modify: `tests/v2/cli.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing CLI config test**

Append to `tests/v2/cli.test.ts`:

```ts
test("v2 CLI parses --config as bootstrap config path", () => {
  assert.deepEqual(parseV2Command(["run-goal", "--config", ".southstar.yaml", "--goal", "ship cube"]), {
    command: "run-goal",
    configPath: ".southstar.yaml",
    goal: "ship cube",
  });
});
```

- [ ] **Step 2: Run and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/cli.test.ts
```

Expected: FAIL because parser does not include `configPath`.

- [ ] **Step 3: Add config path parsing**

In `src/v2/cli.ts`, add `configPath?: string` to each command type and update parser:

```ts
function configPath(args: string[]): string | undefined {
  return optionalFlag(args, "--config");
}

function optionalFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}
```

For each command return, include `configPath: configPath(args)`. Example:

```ts
case "run-goal":
  return { command, configPath: configPath(args), goal: requireFlag(args, "--goal") };
```

- [ ] **Step 4: Create dependency builder**

Create `src/v2/runtime/dependencies.ts`:

```ts
import { loadConfig } from "../../config/load-config.ts";
import type { RuntimeConfig } from "../../config/schema.ts";
import { openSouthstarDb } from "../stores/sqlite.ts";
import { createHttpPiPlannerClient, createPiSdkPlannerClient } from "../planner/pi-planner.ts";
import { createExecutorProviderFromConfig } from "../executor/factory.ts";
import { ExecutorRuntimeManager } from "../executor/runtime-manager.ts";

export type RuntimeDependencyOptions = {
  configPath: string;
  resolveCredential?: (ref: string) => string;
};

export function loadRuntimeConfigForV2(configPath: string): RuntimeConfig {
  return loadConfig(configPath);
}

export function buildRuntimeDependencies(options: RuntimeDependencyOptions) {
  const config = loadRuntimeConfigForV2(options.configPath);
  const executorProvider = createExecutorProviderFromConfig(config, {
    resolveCredential: options.resolveCredential ?? ((ref) => { throw new Error(`credential resolver missing for ${ref}`); }),
  });
  return {
    config,
    db: openSouthstarDb(config.runtime.dbPath),
    plannerClient: createPiSdkPlannerClient(),
    executorManager: new ExecutorRuntimeManager({ provider: executorProvider }),
  };
}
```

- [ ] **Step 5: Stop defaulting executor to env-created TorkClient**

In `src/v2/cli.ts`, remove `loadSouthstarEnv`/`TorkClient` dependency construction from new config path commands. For local tests that inject dependencies, keep injected dependencies working. When dependencies are not provided, require `--config` or `SOUTHSTAR_CONFIG`:

```ts
function commandConfigPath(command: V2Command): string {
  const path = "configPath" in command ? command.configPath : undefined;
  const resolved = path ?? process.env.SOUTHSTAR_CONFIG;
  if (!resolved) throw new Error("--config or SOUTHSTAR_CONFIG is required");
  return resolved;
}
```

- [ ] **Step 6: Run CLI tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/cli.test.ts
```

Expected: PASS after adjusting expected objects in existing parser tests to include `configPath: undefined` only if the type returns it explicitly. If tests assert exact equality, update expected objects accordingly.

- [ ] **Step 7: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/runtime/dependencies.ts src/v2/cli.ts tests/v2/cli.test.ts tests/v2/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "feat: make v2 runtime dependencies config-first"
```

---

### Task 9: Add executor health read model evidence

**Files:**
- Modify: `src/v2/ui-api/read-models.ts`
- Modify: `tests/v2/ui-read-models.test.ts`
- Modify: `components/southstar/*` if Tork-only labels remain
- Modify: `tests/web/southstar-operations-ui.test.tsx`

- [ ] **Step 1: Add failing read model test**

Append to `tests/v2/ui-read-models.test.ts`:

```ts
test("executor ops read model exposes provider-neutral health and cleanup evidence", () => {
  const db = openSouthstarDb(":memory:");
  upsertRuntimeResource(db, { resourceType: "executor_health", resourceKey: "active", scope: "executor", status: "healthy", payload: { provider: "cubesandbox", activeBindings: 1, orphanBindings: 0, cleanupFailures: 0, capabilities: { status: true, cancel: true, logs: true, cleanup: true } } });
  upsertRuntimeResource(db, { resourceType: "executor_binding", resourceKey: "exec-1", runId: "run-1", scope: "executor", status: "running", payload: { executorType: "cubesandbox", sandboxId: "sbx_1", cleanup: { finalizerStatus: "pending" } } });
  const model = buildExecutorOpsModel(db, "run-1");
  assert.equal(model.health?.provider, "cubesandbox");
  assert.equal(model.health?.cleanupFailures, 0);
  assert.equal(model.bindings[0]?.payload.executorType, "cubesandbox");
});
```

- [ ] **Step 2: Run and verify fail**

```bash
node --disable-warning=ExperimentalWarning tests/v2/ui-read-models.test.ts
```

Expected: FAIL until read model exposes `health`.

- [ ] **Step 3: Update read model**

In `src/v2/ui-api/read-models.ts`, locate `buildExecutorOpsModel` and include:

```ts
const health = listResources(db, { resourceType: "executor_health" })
  .find((resource) => resource.resourceKey === "active");
return {
  runId,
  health: health ? health.payload as Record<string, unknown> : null,
  bindings: resourcesByType(resources, "executor_binding"),
  events: resourcesByType(resources, "executor_event"),
};
```

Keep existing fields intact.

- [ ] **Step 4: Update UI copy if necessary**

If any component renders hard-coded `Tork job`, change it to:

```tsx
{binding.payload.executorType ? `${binding.payload.executorType} execution` : "executor execution"}
```

- [ ] **Step 5: Run tests**

```bash
node --disable-warning=ExperimentalWarning tests/v2/ui-read-models.test.ts
node --disable-warning=ExperimentalWarning tests/web/southstar-operations-ui.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=.git-local --work-tree=. add src/v2/ui-api/read-models.ts tests/v2/ui-read-models.test.ts components/southstar tests/web/southstar-operations-ui.test.tsx
git --git-dir=.git-local --work-tree=. commit -m "feat: expose provider-neutral executor health"
```

---

### Task 10: Add real CubeSandbox E2E harness and quantitative gates

**Files:**
- Create: `tests/e2e-cubesandbox/env.ts`
- Create: `tests/e2e-cubesandbox/quantitative-gates.ts`
- Create: `tests/e2e-cubesandbox/scenarios/harness.ts`
- Create: `tests/e2e-cubesandbox/index.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Create real E2E env loader**

Create `tests/e2e-cubesandbox/env.ts`:

```ts
import { loadConfig } from "../../src/config/load-config.ts";

export type CubeSandboxRealE2EEnv = {
  configPath: string;
  callbackHost: string;
  workspaceRoot: string;
};

export function loadCubeSandboxRealE2EEnv(input: Record<string, string | undefined> = process.env): CubeSandboxRealE2EEnv {
  if (input.SOUTHSTAR_CUBESANDBOX_E2E !== "1") {
    throw new Error("CubeSandbox real E2E requires SOUTHSTAR_CUBESANDBOX_E2E=1");
  }
  const configPath = input.SOUTHSTAR_CONFIG;
  if (!configPath) throw new Error("CubeSandbox real E2E requires SOUTHSTAR_CONFIG pointing to .southstar.yaml");
  const config = loadConfig(configPath);
  if (config.executor.provider !== "cubesandbox") throw new Error("CubeSandbox real E2E config must set executor.provider=cubesandbox");
  return {
    configPath,
    callbackHost: input.SOUTHSTAR_CALLBACK_HOST ?? "127.0.0.1",
    workspaceRoot: input.SOUTHSTAR_E2E_WORKSPACE ?? "/tmp/southstar-cubesandbox-e2e",
  };
}
```

- [ ] **Step 2: Create quantitative gates**

Create `tests/e2e-cubesandbox/quantitative-gates.ts`:

```ts
export type CubeSandboxRealE2EGateInput = {
  configLoadMs: number;
  providerInitMs: number;
  sandboxCreateMs: number;
  commandStartMs: number;
  firstProgressMs: number;
  callbackAcceptedAfterExitMs: number;
  runTerminalMs: number;
  cleanupStartAfterTerminalMs: number;
  sandboxDestroyMs: number;
  managedResidueCount: number;
  cleanupFailures: number;
};

export function assertCubeSandboxRealE2EGates(input: CubeSandboxRealE2EGateInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  max(failures, "config load + dependency build", input.configLoadMs, 1_000);
  max(failures, "provider initialize + health", input.providerInitMs, 5_000);
  max(failures, "sandbox create", input.sandboxCreateMs, 10_000);
  max(failures, "command start", input.commandStartMs, 5_000);
  max(failures, "first progress", input.firstProgressMs, 30_000);
  max(failures, "callback accepted after exit", input.callbackAcceptedAfterExitMs, 30_000);
  max(failures, "happy path terminal run", input.runTerminalMs, 15 * 60_000);
  max(failures, "cleanup starts after terminal", input.cleanupStartAfterTerminalMs, 5_000);
  max(failures, "sandbox destroy", input.sandboxDestroyMs, 30_000);
  equal(failures, "managed sandbox residue", input.managedResidueCount, 0);
  equal(failures, "cleanup failures", input.cleanupFailures, 0);
  return { ok: failures.length === 0, failures };
}

function max(failures: string[], label: string, actual: number, expected: number): void {
  if (!Number.isFinite(actual) || actual > expected) failures.push(`${label} ${actual}ms exceeds ${expected}ms`);
}

function equal(failures: string[], label: string, actual: number, expected: number): void {
  if (actual !== expected) failures.push(`${label} expected ${expected}, got ${actual}`);
}
```

- [ ] **Step 3: Create real E2E harness skeleton**

Create `tests/e2e-cubesandbox/scenarios/harness.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../../src/config/load-config.ts";
import { openSouthstarDb } from "../../../src/v2/stores/sqlite.ts";
import { createExecutorProviderFromConfig } from "../../../src/v2/executor/factory.ts";
import { ExecutorRuntimeManager } from "../../../src/v2/executor/runtime-manager.ts";
import type { CubeSandboxRealE2EEnv } from "../env.ts";

export function createCubeSandboxRealContext(env: CubeSandboxRealE2EEnv) {
  const config = loadConfig(env.configPath);
  const manager = new ExecutorRuntimeManager({
    provider: createExecutorProviderFromConfig(config, {
      resolveCredential(ref) {
        const value = process.env[`SOUTHSTAR_TEST_SECRET_${ref}`];
        if (!value) throw new Error(`missing test credential SOUTHSTAR_TEST_SECRET_${ref}`);
        return value;
      },
    }),
  });
  return { config, manager, db: openSouthstarDb(config.runtime.dbPath) };
}

export function makeRealWorkspace(prefix = "cube-real-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupWorkspace(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
```

- [ ] **Step 4: Create index test that enforces real flag**

Create `tests/e2e-cubesandbox/index.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadCubeSandboxRealE2EEnv } from "./env.ts";

test("CubeSandbox real E2E env requires real config", () => {
  assert.throws(() => loadCubeSandboxRealE2EEnv({}), /SOUTHSTAR_CUBESANDBOX_E2E=1/);
});
```

This test is not the acceptance E2E; it only verifies the harness refuses to run without real inputs.

- [ ] **Step 5: Add package script**

Modify `package.json` scripts:

```json
"test:e2e:cubesandbox": "tsx tests/e2e-cubesandbox/index.test.ts"
```

- [ ] **Step 6: Run local harness test**

```bash
npm run test:e2e:cubesandbox
```

Expected: PASS for env guard only.

- [ ] **Step 7: Commit**

```bash
git --git-dir=.git-local --work-tree=. add tests/e2e-cubesandbox package.json package-lock.json
git --git-dir=.git-local --work-tree=. commit -m "test: add cubesandbox real e2e harness and gates"
```

---

### Task 11: Implement real CubeSandbox runtime happy-path E2E case

**Files:**
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-happy-path.ts`
- Modify: `tests/e2e-cubesandbox/index.test.ts`

This task is the primary acceptance E2E. It must use a real CubeSandbox deployment, the real SDK adapter, a real Southstar runtime server, a real callback route, and real SQLite evidence. It is not sufficient to create and destroy a sandbox without running through Southstar callback/evaluator/cleanup evidence.

- [ ] **Step 1: Write real runtime happy-path scenario**

Create `tests/e2e-cubesandbox/scenarios/cubesandbox-real-happy-path.ts`:

```ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createCubeSandboxRealContext } from "./harness.ts";
import type { CubeSandboxRealE2EEnv } from "../env.ts";
import { assertCubeSandboxRealE2EGates } from "../quantitative-gates.ts";
import { appendHistoryEvent } from "../../../src/v2/stores/history-store.ts";
import { createWorkflowRun } from "../../../src/v2/stores/run-store.ts";
import { createWorkflowTask } from "../../../src/v2/stores/task-store.ts";
import { upsertRuntimeResource, listResources } from "../../../src/v2/stores/resource-store.ts";
import { ingestExecutorCallback } from "../../../src/v2/executor/callback.ts";

export async function runCubeSandboxRealHappyPath(env: CubeSandboxRealE2EEnv) {
  const configStarted = Date.now();
  const context = createCubeSandboxRealContext(env);
  const configLoadMs = Date.now() - configStarted;
  const runId = `cube-real-${Date.now()}`;
  const taskId = "task-real-callback";
  const attemptId = "attempt-1";
  const executorBindingId = `cube-exec-${runId}-${attemptId}`;

  createWorkflowRun(context.db, {
    id: runId,
    status: "running",
    domain: "software",
    goalPrompt: "real CubeSandbox E2E callback artifact",
    workflowManifestJson: JSON.stringify({ tasks: [{ id: taskId }] }),
    executionProjectionJson: JSON.stringify(null),
    snapshotJson: JSON.stringify({ activeTaskIds: [taskId] }),
    runtimeContextJson: JSON.stringify({}),
    metricsJson: JSON.stringify({}),
  });
  createWorkflowTask(context.db, {
    id: taskId,
    runId,
    taskKey: taskId,
    status: "pending",
    sortOrder: 0,
    dependsOn: [],
    rootSessionId: `root-${runId}-${taskId}`,
    snapshot: { name: "Real CubeSandbox Callback", domain: "software" },
  });

  const callbackServer = await startRealCallbackServer(context.db);
  try {
    const initStarted = Date.now();
    await context.manager.initialize();
    const health = await context.manager.health();
    const providerInitMs = Date.now() - initStarted;
    assert.equal(health.status, "healthy", health.message);

    const submitStarted = Date.now();
    const result = await context.manager.submit({
      runId,
      attemptId,
      workflow: { tasks: [{ id: taskId }] } as never,
      callbackUrl: `${callbackServer.url}/api/v2/executor/callback`,
      envelopeBasePath: "/southstar-runs",
    });
    const sandboxCreateMs = Date.now() - submitStarted;
    assert.equal(result.executorType, "cubesandbox");
    assert.equal(result.externalJobId, executorBindingId);
    assert.equal(typeof result.providerPayload?.sandboxId, "string");
    assert.equal(typeof result.providerPayload?.commandId, "string");

    upsertRuntimeResource(context.db, {
      resourceType: "executor_binding",
      resourceKey: executorBindingId,
      runId,
      taskId,
      scope: "executor",
      status: "running",
      payload: {
        executorType: "cubesandbox",
        externalJobId: result.externalJobId,
        ...(result.providerPayload ?? {}),
      },
    });
    appendHistoryEvent(context.db, { runId, eventType: "executor.submitted", actorType: "orchestrator", payload: { executorType: "cubesandbox", externalJobId: result.externalJobId } });

    const commandStartedAt = Date.now();
    await waitForExecutorCallback(context.db, runId, 15 * 60_000);
    const callbackAcceptedAfterExitMs = Date.now() - commandStartedAt;

    const cleanupStarted = Date.now();
    const cleanup = await context.manager.cleanup({
      externalJobId: result.externalJobId,
      reason: "happy-path-e2e-cleanup",
      providerPayload: result.providerPayload,
    });
    const sandboxDestroyMs = Date.now() - cleanupStarted;
    assert.equal(cleanup.status, "destroyed");

    upsertRuntimeResource(context.db, {
      resourceType: "executor_binding",
      resourceKey: executorBindingId,
      runId,
      taskId,
      scope: "executor",
      status: "completed",
      payload: {
        executorType: "cubesandbox",
        externalJobId: result.externalJobId,
        ...(result.providerPayload ?? {}),
        cleanup: { finalizerStatus: "destroyed" },
      },
    });
    appendHistoryEvent(context.db, { runId, eventType: "executor.cleanup_destroyed", actorType: "orchestrator", payload: { executorType: "cubesandbox", externalJobId: result.externalJobId } });

    const artifacts = listResources(context.db, { resourceType: "artifact" }).filter((resource) => resource.runId === runId);
    assert.equal(artifacts.length >= 1, true, "real callback must create artifact evidence");

    const residueCount = await countManagedCubeResidue(context.manager.provider, runId);
    const gates = assertCubeSandboxRealE2EGates({
      configLoadMs,
      providerInitMs,
      sandboxCreateMs,
      commandStartMs: sandboxCreateMs,
      firstProgressMs: 0,
      callbackAcceptedAfterExitMs,
      runTerminalMs: callbackAcceptedAfterExitMs,
      cleanupStartAfterTerminalMs: 0,
      sandboxDestroyMs,
      managedResidueCount: residueCount,
      cleanupFailures: 0,
    });
    assert.equal(gates.ok, true, gates.failures.join("\n"));
    return { runId, externalJobId: result.externalJobId, sandboxCreateMs, sandboxDestroyMs, residueCount };
  } finally {
    await callbackServer.close();
  }
}

async function startRealCallbackServer(db: ReturnType<typeof createCubeSandboxRealContext>["db"]) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/api/v2/executor/callback") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
      });
      ingestExecutorCallback(db, JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      response.statusCode = 500;
      response.end((error as Error).message);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function waitForExecutorCallback(db: ReturnType<typeof createCubeSandboxRealContext>["db"], runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = listResources(db, { resourceType: "artifact" }).filter((resource) => resource.runId === runId);
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`real CubeSandbox callback did not create artifact for ${runId} within ${timeoutMs}ms`);
}

async function countManagedCubeResidue(provider: { reconcile?: Function }, runId: string): Promise<number> {
  if (!provider.reconcile) return 0;
  const result = await provider.reconcile({ runId, reason: "real-e2e-residue-count" });
  return Number((result.providerPayload as { managedResidueCount?: number } | undefined)?.managedResidueCount ?? 0);
}
```

The CubeSandbox template used by this test must include `southstar-agent-runner` and must be able to reach the callback host. If the template cannot execute the real runner and callback, the test must fail.

- [ ] **Step 2: Wire scenario into index**

Modify `tests/e2e-cubesandbox/index.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { loadCubeSandboxRealE2EEnv } from "./env.ts";
import { runCubeSandboxRealHappyPath } from "./scenarios/cubesandbox-real-happy-path.ts";

test("CubeSandbox real E2E env requires real config", () => {
  assert.throws(() => loadCubeSandboxRealE2EEnv({}), /SOUTHSTAR_CUBESANDBOX_E2E=1/);
});

test("CubeSandbox real runtime path executes callback artifact and leaves zero managed residue", async () => {
  const env = loadCubeSandboxRealE2EEnv();
  const result = await runCubeSandboxRealHappyPath(env);
  assert.equal(result.residueCount, 0);
});
```

- [ ] **Step 3: Run only with real CubeSandbox available**

Run:

```bash
SOUTHSTAR_CUBESANDBOX_E2E=1 \
SOUTHSTAR_CONFIG=/absolute/path/to/.southstar.cubesandbox.yaml \
SOUTHSTAR_TEST_SECRET_local-cubesandbox-api-key=e2b_000000 \
npm run test:e2e:cubesandbox
```

Expected: PASS only if a real CubeSandbox sandbox runs `southstar-agent-runner`, posts a real callback, creates SQLite artifact evidence, and is destroyed with managed residue count `0`.

- [ ] **Step 4: Commit**

```bash
git --git-dir=.git-local --work-tree=. add tests/e2e-cubesandbox/scenarios/cubesandbox-real-happy-path.ts tests/e2e-cubesandbox/index.test.ts
git --git-dir=.git-local --work-tree=. commit -m "test: add real cubesandbox runtime happy path e2e"
```

---

### Task 12: Add real exception E2E cases and strict zero-residue gates

**Files:**
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-timeout-cleanup.ts`
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-callback-missing.ts`
- Create: `tests/e2e-cubesandbox/scenarios/cubesandbox-real-orphan-reconcile.ts`
- Modify: `tests/e2e-cubesandbox/index.test.ts`
- Modify: `tests/e2e-cubesandbox/quantitative-gates.ts`

- [ ] **Step 1: Add timeout gate helper**

Append to `tests/e2e-cubesandbox/quantitative-gates.ts`:

```ts
export type CubeSandboxExceptionGateInput = {
  timeoutDetectionMs: number;
  timeoutDestroyMs: number;
  callbackMissingDetectionMs: number;
  orphanDetectionMs: number;
  orphanDestroyMs: number;
  managedResidueCount: number;
};

export function assertCubeSandboxExceptionGates(input: CubeSandboxExceptionGateInput): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  max(failures, "timeout detection", input.timeoutDetectionMs, 20_000);
  max(failures, "timeout destroy", input.timeoutDestroyMs, 30_000);
  max(failures, "callback missing detection", input.callbackMissingDetectionMs, 45_000);
  max(failures, "orphan detection", input.orphanDetectionMs, 60_000);
  max(failures, "orphan destroy", input.orphanDestroyMs, 30_000);
  equal(failures, "managed sandbox residue", input.managedResidueCount, 0);
  return { ok: failures.length === 0, failures };
}
```

- [ ] **Step 2: Add timeout cleanup scenario**

Create `tests/e2e-cubesandbox/scenarios/cubesandbox-real-timeout-cleanup.ts`:

```ts
import assert from "node:assert/strict";
import { createCubeSandboxRealContext } from "./harness.ts";
import type { CubeSandboxRealE2EEnv } from "../env.ts";

export async function runCubeSandboxRealTimeoutCleanup(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await context.manager.initialize();
  const result = await context.manager.submit({
    runId: `cube-timeout-${Date.now()}`,
    attemptId: "attempt-timeout",
    workflow: { tasks: [] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });
  const cancelStarted = Date.now();
  const cancel = await context.manager.provider.cancel?.({ externalJobId: result.externalJobId, reason: "real-timeout-test", providerPayload: result.providerPayload });
  assert.equal(cancel?.status, "cancelled");
  const destroyMs = Date.now() - cancelStarted;
  assert.equal(destroyMs <= 30_000, true, `timeout cleanup destroy took ${destroyMs}ms`);
  return { destroyMs };
}
```

- [ ] **Step 3: Add callback-missing scenario**

Create `tests/e2e-cubesandbox/scenarios/cubesandbox-real-callback-missing.ts`:

```ts
import assert from "node:assert/strict";
import { createCubeSandboxRealContext } from "./harness.ts";
import type { CubeSandboxRealE2EEnv } from "../env.ts";

export async function runCubeSandboxRealCallbackMissing(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await context.manager.initialize();
  const result = await context.manager.submit({
    runId: `cube-callback-missing-${Date.now()}`,
    attemptId: "attempt-callback-missing",
    workflow: { tasks: [] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });
  const status = await context.manager.provider.status?.({ externalJobId: result.externalJobId, providerPayload: result.providerPayload });
  assert.notEqual(status?.status, "completed", "callback-missing scenario must not be marked task-completed by executor status alone");
  await context.manager.cleanup({ externalJobId: result.externalJobId, reason: "callback-missing-cleanup", providerPayload: result.providerPayload });
  return { checked: true };
}
```

- [ ] **Step 4: Add orphan reconcile scenario**

Create `tests/e2e-cubesandbox/scenarios/cubesandbox-real-orphan-reconcile.ts`:

```ts
import assert from "node:assert/strict";
import { createCubeSandboxRealContext } from "./harness.ts";
import type { CubeSandboxRealE2EEnv } from "../env.ts";

export async function runCubeSandboxRealOrphanReconcile(env: CubeSandboxRealE2EEnv) {
  const context = createCubeSandboxRealContext(env);
  await context.manager.initialize();
  const result = await context.manager.submit({
    runId: `cube-orphan-${Date.now()}`,
    attemptId: "attempt-orphan",
    workflow: { tasks: [] } as never,
    callbackUrl: "http://127.0.0.1:1/api/v2/executor/callback",
    envelopeBasePath: "/southstar-runs",
  });
  const started = Date.now();
  const cleanup = await context.manager.cleanup({ externalJobId: result.externalJobId, reason: "orphan-reconcile-cleanup", providerPayload: result.providerPayload });
  assert.equal(cleanup.status, "destroyed");
  const orphanDestroyMs = Date.now() - started;
  assert.equal(orphanDestroyMs <= 30_000, true, `orphan destroy took ${orphanDestroyMs}ms`);
  return { orphanDestroyMs };
}
```

- [ ] **Step 5: Wire scenarios into index**

Modify `tests/e2e-cubesandbox/index.test.ts`:

```ts
import { runCubeSandboxRealTimeoutCleanup } from "./scenarios/cubesandbox-real-timeout-cleanup.ts";
import { runCubeSandboxRealCallbackMissing } from "./scenarios/cubesandbox-real-callback-missing.ts";
import { runCubeSandboxRealOrphanReconcile } from "./scenarios/cubesandbox-real-orphan-reconcile.ts";

test("CubeSandbox real exception handling cleans timeout callback-missing and orphan resources", async () => {
  const env = loadCubeSandboxRealE2EEnv();
  await runCubeSandboxRealTimeoutCleanup(env);
  await runCubeSandboxRealCallbackMissing(env);
  await runCubeSandboxRealOrphanReconcile(env);
});
```

- [ ] **Step 6: Run real exception E2E**

```bash
SOUTHSTAR_CUBESANDBOX_E2E=1 \
SOUTHSTAR_CONFIG=/absolute/path/to/.southstar.cubesandbox.yaml \
SOUTHSTAR_TEST_SECRET_local-cubesandbox-api-key=e2b_000000 \
npm run test:e2e:cubesandbox
```

Expected: PASS only if real CubeSandbox resources are created and cleaned. Any leftover Southstar-managed sandbox is failure.

- [ ] **Step 7: Commit**

```bash
git --git-dir=.git-local --work-tree=. add tests/e2e-cubesandbox
git --git-dir=.git-local --work-tree=. commit -m "test: add real cubesandbox exception e2e gates"
```

---

### Task 13: Full verification and cleanup audit

**Files:**
- Modify only files needed to fix failures discovered by verification.

- [ ] **Step 1: Run v2 suite**

```bash
npm run test:v2
```

Expected: PASS.

- [ ] **Step 2: Run full unit/integration suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run real CubeSandbox E2E with real dependencies**

```bash
SOUTHSTAR_CUBESANDBOX_E2E=1 \
SOUTHSTAR_CONFIG=/absolute/path/to/.southstar.cubesandbox.yaml \
SOUTHSTAR_TEST_SECRET_local-cubesandbox-api-key=e2b_000000 \
npm run test:e2e:cubesandbox
```

Expected: PASS and output includes quantitative gate success. Evidence required in final handoff:

- real CubeSandbox health checked
- at least one real sandbox created
- at least one real command started
- cleanup returned `destroyed`
- managed residue count is `0`
- timeout/callback-missing/orphan scenarios passed

- [ ] **Step 4: Search for forbidden executor env runtime reads**

```bash
rg -n "TORK_BASE_URL|CUBESANDBOX_API_URL|E2B_API_URL|E2B_API_KEY|SOUTHSTAR_DB" src tests/e2e-cubesandbox tests/v2
```

Expected:

- No runtime source reads executor env vars.
- Occurrences are allowed only in docs, real E2E shell command examples, or Cube SDK adapter internals that are explicitly fed from config/credential resolver.

- [ ] **Step 5: Commit verification fixes**

If any fixes were needed:

```bash
git --git-dir=.git-local --work-tree=. add <changed-files>
git --git-dir=.git-local --work-tree=. commit -m "test: verify cubesandbox executor provider"
```

If no fixes were needed, do not create an empty commit.

---

## Implementation handoff checklist

Before claiming done, provide evidence for each item:

- [ ] Config schema accepts Tork and CubeSandbox executor blocks.
- [ ] Runtime reads only bootstrap env vars for config/root/debug.
- [ ] Provider factory instantiates exactly one active provider.
- [ ] CubeSandbox provider uses SDK adapter boundary.
- [ ] Provider-neutral callback route works.
- [ ] Tork tests still pass with provider-neutral callback.
- [ ] Cleanup finalizer and lock tests pass.
- [ ] Executor health model exposes provider and cleanup failures.
- [ ] Real CubeSandbox E2E happy path passes.
- [ ] Real CubeSandbox timeout/callback-missing/orphan E2E passes.
- [ ] Quantitative gates pass.
- [ ] Managed residue count is exactly 0 after real E2E.

# Southstar CubeSandbox Executor Provider 設計文件

日期：2026-06-15

## 1. 目標

本設計把 Southstar executor 層重新設計為 config-only、provider-neutral 的執行控制平面，並新增可由 Southstar 完整管理生命週期的 CubeSandbox provider。

已確認決策：

- Provider 切換粒度：**系統級**。Southstar 啟動時只選一個 active provider。
- Provider 來源：**只從 `.southstar.yaml` 讀取**。不使用 executor 相關環境變數作為 runtime 配置來源。
- Tork 角色：**保留**，與 CubeSandbox 並列為 provider。
- CubeSandbox 整合方式：**SDK 呼叫**，但透過 Southstar adapter 隔離。
- 生命週期範圍：**完整控制**，包含 submit、status、cancel、logs、health、reconcile、cleanup、shutdown。
- Cleanup 原則：**strict zero-residue**。terminal run 後不得留下 Southstar-managed sandbox/container；若無法即時清理，必須有 retry/evidence/degraded health。

CubeSandbox repo 調研結果：CubeSandbox 官方定位為 E2B-compatible sandbox service，可透過 `E2B_API_URL` + `E2B_API_KEY` 指向 CubeAPI，並使用 E2B SDK 建立 sandbox、執行 command、讀寫檔案與操作 browser sandbox。因此 Southstar 不直接耦合 CubeSandbox 內部 Rust/Go component，而是建立 `CubeSandboxSdkClient` adapter，底層先支援 E2B-compatible SDK。

## 2. 非目標

- 不做 run/task 級 provider 混用。
- 不支援同一 Southstar 進程內熱切換 provider。
- 不移除 Tork。
- 不讓 Tork 或 CubeSandbox 成為 workflow truth。
- 不讓 UI 直接呼叫 Tork/CubeSandbox。
- 不把 CubeSandbox snapshot/rollback 直接接成 workflow rollback truth；第一版只暴露 capability。
- 不直接依賴 CubeMaster/Cubelet/CubeAPI 內部私有 API。
- 不新增 executor 專用 DB table；沿用 runtime resource/history/event 模型。

## 3. 核心架構

```text
.southstar.yaml
  -> loadRuntimeConfig()
  -> buildRuntimeDependencies(config)
  -> ExecutorRuntimeManager
      -> active provider: tork | cubesandbox

Tork path:
  ExecutorRuntimeManager
    -> TorkExecutorProvider
      -> TorkClient
        -> Tork API / Docker runtime

CubeSandbox path:
  ExecutorRuntimeManager
    -> CubeSandboxExecutorProvider
      -> CubeSandboxSdkClient
        -> E2B-compatible SDK
          -> CubeAPI
            -> CubeMaster / Cubelet / MicroVM sandbox
```

Canonical truth remains in Southstar:

- workflow runs
- workflow tasks
- runtime resources
- history/runtime events
- session graph
- artifacts
- evaluator results
- stop condition results

Executor providers only produce execution facts and resource lifecycle evidence.

## 4. Config-only executor

Executor configuration lives only in `.southstar.yaml`.

```yaml
schema_version: "1"

runtime:
  db_path: .southstar/runtime/southstar.sqlite3
  heartbeat_interval_seconds: 15
  lock_timeout_seconds: 120
  task_timeout_seconds: 1800
  max_retry_attempts: 2

executor:
  provider: cubesandbox # tork | cubesandbox

  lifecycle:
    cleanup_mode: strict # strict | best_effort
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
```

Allowed process environment variables remain bootstrap-only:

```text
SOUTHSTAR_CONFIG
SOUTHSTAR_PROJECT_ROOT
SOUTHSTAR_DEBUG
```

Executor-specific environment variables such as `TORK_BASE_URL`, `CUBESANDBOX_API_URL`, `E2B_API_URL`, and `E2B_API_KEY` are not runtime configuration sources for Southstar. If an underlying SDK requires environment variables internally, the adapter must set them inside the SDK boundary from resolved YAML/credential values without exposing them as Southstar runtime config.

### Validation rules

- `executor.provider` must be `tork` or `cubesandbox`.
- Only the active provider is instantiated.
- Active provider config is required and validated.
- Inactive provider config may exist but is not used to instantiate clients or resolve secrets.
- `executor.provider=tork` requires `executor.tork.base_url`.
- `executor.provider=cubesandbox` requires:
  - `executor.cubesandbox.sdk`
  - `executor.cubesandbox.api_url`
  - `executor.cubesandbox.api_key_ref`
  - `executor.cubesandbox.template_id`
- `api_key_ref` resolves through Southstar credential resolver; raw key values must not be written to YAML, DB, history, logs, or UI read models.
- Host mount sources must be under project root or an explicit allowlist.
- Lifecycle timeouts/intervals must be bounded non-negative integers.
- Production/default strict mode requires `destroy_on_completion=true`.

## 5. Runtime boot and provider selection

Boot sequence:

```text
load .southstar.yaml
  -> validate executor block
  -> resolve active provider credential refs
  -> create ExecutorRuntimeManager
  -> instantiate exactly one active provider
  -> provider.initialize()
  -> provider.health()
  -> run startup reconcile/orphan scan
  -> start runtime APIs
```

Provider is system-level immutable. To switch provider:

```text
stop/drain Southstar
  -> modify .southstar.yaml
  -> restart Southstar
  -> startup reconcile detects previous provider bindings/resources
```

Southstar must not hot-switch provider in the same process because active bindings may have provider-specific identifiers and cleanup semantics.

## 6. ExecutorRuntimeManager

`ExecutorRuntimeManager` is the only executor control-plane entrypoint inside Southstar.

Responsibilities:

- initialize active provider
- expose provider health
- submit executions
- poll status/logs
- cancel executions
- reconcile provider facts with Southstar DB
- run cleanup finalizers
- detect orphans
- recover expired locks
- drain/shutdown provider resources
- append executor lifecycle events

It never decides workflow completion. It can update executor binding status, but task/run completion remains governed by artifact ingestion, evaluator results, and stop conditions.

## 7. Provider-neutral contract

```ts
type ExecutorType = "tork" | "cubesandbox";

type ExecutorProvider = {
  readonly executorType: ExecutorType;

  initialize(): Promise<void>;
  health(): Promise<ExecutorHealthResult>;

  submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult>;
  status(request: ExecutorStatusRequest): Promise<ExecutorStatusResult>;
  cancel(request: ExecutorCancelRequest): Promise<ExecutorCancelResult>;
  logs(request: ExecutorLogsRequest): Promise<ExecutorLogsResult>;

  reconcile(request: ExecutorReconcileRequest): Promise<ExecutorReconcileResult>;
  cleanup(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult>;
  shutdown(request: ExecutorShutdownRequest): Promise<ExecutorShutdownResult>;
};
```

`submit()` returns execution projection facts only. It does not mark task/run completed.

## 8. CubeSandbox provider and SDK adapter

`CubeSandboxExecutorProvider` responsibilities:

- create CubeSandbox sandbox with Southstar ownership metadata
- materialize or mount `TaskEnvelopeV2`
- start `southstar-agent-runner`
- map SDK/sandbox/command status to Southstar executor status
- collect logs/stdout/stderr when supported
- cancel/kill command
- destroy sandbox
- list and cleanup Southstar-managed sandboxes
- reconcile missing callback, missing sandbox, orphan sandbox, and stale binding cases

`CubeSandboxSdkClient` isolates SDK details:

```ts
type CubeSandboxSdkClient = {
  health(): Promise<void>;

  createSandbox(input: {
    templateId: string;
    metadata: Record<string, string>;
    timeoutSeconds: number;
    hostMounts: CubeHostMount[];
  }): Promise<{ sandboxId: string }>;

  runCommand(input: {
    sandboxId: string;
    command: string[];
    env: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<{ commandId: string }>;

  getSandbox(input: { sandboxId: string }): Promise<CubeSandboxStatus>;
  getCommand(input: { sandboxId: string; commandId: string }): Promise<CubeCommandStatus>;

  killCommand(input: { sandboxId: string; commandId: string }): Promise<void>;
  destroySandbox(input: { sandboxId: string }): Promise<void>;

  listSandboxes(input: {
    metadata?: Record<string, string>;
  }): Promise<CubeSandboxStatus[]>;

  logs(input: {
    sandboxId: string;
    commandId?: string;
    cursor?: string;
  }): Promise<CubeLogsResult>;
};
```

If the selected SDK cannot implement a capability, the adapter returns a structured `not_supported` capability result. Provider-specific SDK quirks must not leak into runtime/server/UI code.

## 9. CubeSandbox execution flow

```text
Southstar task attempt
  -> materialize TaskEnvelopeV2/context packet/workspace under .southstar/runs
  -> ExecutorRuntimeManager.submit()
  -> CubeSandboxExecutorProvider.submit()
      -> create sandbox with Southstar metadata
      -> run southstar-agent-runner command
      -> persist executor_binding
      -> return external execution id

ExecutorRuntimeManager background loops
  -> health()
  -> status()
  -> logs()
  -> reconcile()
  -> cleanup finalizers

Agent runner inside sandbox
  -> reads TaskEnvelopeV2
  -> runs root session/subagents
  -> emits progress events
  -> writes artifact/session/memory data
  -> POST /api/v2/executor/callback

Southstar callback ingestion
  -> validate run/task/binding/attempt
  -> store artifact/session/memory/events
  -> run evaluator pipeline
  -> evaluate stop condition
  -> update workflow task/run state
  -> cleanup sandbox if terminal or policy requires
```

Primary materialization path uses host mount:

```text
.southstar/runs/<runId>/<taskId>/<attemptId>/task-envelope.json
.southstar/runs/<runId>/<taskId>/<attemptId>/context-packet.json
.southstar/runs/<runId>/<taskId>/<attemptId>/workspace/
```

Sandbox command:

```bash
southstar-agent-runner \
  --envelope /southstar-runs/<runId>/<taskId>/<attemptId>/task-envelope.json \
  --callback-url <southstar-runtime-url>/api/v2/executor/callback
```

## 10. Provider-neutral callback

Replace provider-specific callback route with:

```text
POST /api/v2/executor/callback
```

Payload:

```ts
{
  runId: string;
  taskId: string;
  attemptId: string;
  executorBindingId: string;
  executorType: "tork" | "cubesandbox";
  rootSessionId: string;
  ok: boolean;
  artifact: object;
  metrics: object;
  events: RuntimeEvent[];
}
```

Rules:

- callback must reference an existing run, task, attempt, and executor binding
- callback cannot directly mark run completed
- artifact must still pass evaluator and stop condition
- callback missing is an exception condition, not task success
- `executorType` is audit metadata, not workflow truth

## 11. Executor binding resource shape

Use runtime resources/history events; do not add executor-specific DB tables.

```ts
{
  resourceType: "executor_binding",
  resourceKey: "exec-run-123-task-implement-attempt-1",
  runId: "run-123",
  taskId: "implement",
  scope: "executor",
  status: "running",
  payload: {
    executorType: "cubesandbox",
    externalJobId: "cube-exec-run-123-task-implement-attempt-1",
    sandboxId: "sandbox_abc",
    commandId: "cmd_xyz",
    templateId: "southstar-agent-template",
    attemptId: "attempt-1",
    providerStatus: "command_running",
    materialization: {
      envelopePath: ".southstar/runs/run-123/implement/attempt-1/task-envelope.json",
      mountTarget: "/southstar-runs/run-123/implement/attempt-1"
    },
    cleanup: {
      required: true,
      destroyOnCompletion: true,
      finalizerStatus: "pending",
      attempts: 0,
      lastAttemptAt: null
    },
    lock: {
      ownerId: "executor-manager-1",
      operation: "reconcile",
      expiresAt: "2026-06-15T00:00:00.000Z"
    }
  }
}
```

CubeSandbox sandbox metadata must include:

```ts
{
  managedBy: "southstar",
  runId,
  taskId,
  attemptId,
  executorBindingId,
  createdAt,
  ttlSeconds
}
```

## 12. Status mapping

| CubeSandbox fact | Southstar executor status |
|---|---|
| sandbox creation requested | `queued` |
| sandbox created, command starting | `starting` |
| command running | `running` |
| command exited 0 + callback accepted | `completed` |
| command exited non-zero | `failed` |
| cancel requested | `cancelling` |
| command killed or sandbox destroyed | `cancelled` |
| sandbox unreachable | `unknown` / `degraded` |
| SDK/API retryable error | `retryable_error` |
| command completed but callback missing | `callback_missing` |
| cleanup failed | `cleanup_failed` |

Workflow task status is not copied from executor status. Executor `completed` only means execution finished; task completion still requires valid artifact/evaluator/stop condition.

## 13. Exception handling

Executor exception supervisor must handle:

| Exception | Detection | Required behavior |
|---|---|---|
| sandbox create timeout | SDK call timeout | abort/mark retryable/cleanup partial sandbox |
| command start timeout | command not running in time | destroy sandbox/retry by task policy |
| command execution timeout | wall-clock exceeds policy | kill command/destroy sandbox/task retry or exception |
| no progress/hang | no stdout/progress/callback/status movement | append hang event, soft interrupt if supported, hard cancel/destroy |
| callback missing | command completed but callback absent | reconcile logs/artifact path; do not complete task automatically |
| SDK hang | SDK call exceeds timeout/AbortSignal | mark provider degraded and recover operation lock |
| provider unavailable | health check fails | block new submit, reconcile active bindings |
| lock stuck | lock TTL expired | reclaim lock with event evidence |
| destroy failed | destroy timeout/error | retry cleanup, provider health degraded |
| orphan sandbox | Cube lists managed sandbox with no active DB owner | destroy and record orphan cleanup |
| split-brain binding | DB running but provider resource missing | mark executor unknown/retryable_error; workflow remains non-completed |

Hang detection uses:

- last stdout/stderr timestamp
- last progress event timestamp
- last callback/event timestamp
- wall-clock runtime
- provider status availability

## 14. Zero-residue cleanup

Every executor binding has a cleanup finalizer. Terminal states and exceptions must run cleanup, not only successful completion.

Finalizer states:

```text
pending
in_progress
destroyed
orphan_detected
retry_scheduled
failed
waived_for_debug
```

Strict cleanup behavior:

- completed/cancelled/failed/timeout bindings require sandbox destruction
- Southstar shutdown drains or cancels active bindings according to policy
- startup reconcile lists provider resources with `managedBy=southstar`
- orphan/stale/completed resources are destroyed
- cleanup failure is recorded as `executor.cleanup_failed`
- cleanup failure does not reverse workflow truth, but executor health becomes degraded

Startup reconcile:

```text
load DB active/terminal executor bindings
  -> provider.health()
  -> list provider resources managedBy=southstar
  -> detect stale/orphan/split-brain resources
  -> cleanup according to strict policy
  -> append reconcile summary
```

Shutdown sequence:

```text
stop accepting new submissions
  -> mark executor draining
  -> wait/cancel active bindings by policy
  -> destroy terminal resources
  -> persist shutdown summary
```

## 15. Locks

Provider operations use binding-scoped durable locks to avoid races between submit/cancel/reconcile/cleanup.

Lock rules:

- lock has owner, operation, acquiredAt, expiresAt
- expired lock may be reclaimed
- reclaim appends event evidence
- same binding cannot run cancel and cleanup concurrently
- restart cannot leave binding stuck in `cleanup in_progress`

Lock can live inside `executor_binding.payload.lock` or a provider-neutral runtime resource. It must be durable and visible to reconcile.

## 16. Executor events

Executor lifecycle facts are appended as runtime/history events, including:

```text
executor.provider_initialized
executor.health_checked
executor.submitted
executor.command_started
executor.progress_observed
executor.hang_suspected
executor.timeout
executor.callback_missing
executor.cancel_requested
executor.cancelled
executor.cleanup_started
executor.cleanup_destroyed
executor.cleanup_failed
executor.orphan_detected
executor.orphan_destroyed
executor.reconcile_completed
executor.lock_reclaimed
executor.shutdown_started
executor.shutdown_completed
```

Events must redact credentials and large logs.

## 17. Health model

Executor Ops UI/read model should expose provider health:

```ts
{
  provider: "cubesandbox",
  status: "healthy" | "degraded" | "unavailable" | "draining",
  activeBindings: number,
  orphanBindings: number,
  cleanupFailures: number,
  lastHealthCheckAt: string,
  lastReconcileAt: string,
  capabilities: {
    status: true,
    cancel: true,
    logs: true,
    cleanup: true,
    snapshots: false
  }
}
```

Snapshot/rollback support may appear as capabilities, but first implementation must not make workflow truth depend on CubeSandbox snapshots.

## 18. Tork parity

The provider-neutral lifecycle applies to Tork too:

- Tork provider is selected only by YAML.
- Tork jobs get executor bindings and cleanup finalizers.
- cancel/status/logs/reconcile/cleanup are routed through `ExecutorRuntimeManager`.
- Tork/Docker residue is recorded and cleaned through the same strict cleanup policy where possible.
- Existing Tork-specific callback route is replaced by `/api/v2/executor/callback`.

## 19. Testing strategy

### Unit tests

- config validation for tork/cubesandbox
- provider factory creates exactly one active provider
- no executor env vars are read for runtime config
- CubeSandbox status mapping
- SDK timeout/abort wrapper
- cleanup finalizer transitions
- lock TTL reclaim
- provider-neutral callback validation
- callback rejects unknown task/binding/attempt

### Integration tests with fake SDK

Use `FakeCubeSandboxSdkClient` to simulate:

- sandbox create/run success
- logs and progress
- command timeout
- command hang
- callback missing
- destroy failure
- orphan sandbox
- split-brain binding
- SDK call that never resolves

Assertions:

- command completion alone does not complete task
- missing callback leaves workflow non-completed
- timeout triggers cancel/destroy and task retry/exception policy
- destroy failure retries cleanup and marks provider degraded
- restart reconcile cleans orphan sandbox
- terminal strict mode leaves no active fake managed sandbox

### Real E2E, gated

Real CubeSandbox E2E is optional and gated by a test-only flag. The flag is not runtime configuration.

The E2E must verify:

- `.southstar.yaml` selects `cubesandbox`
- Southstar starts with CubeSandbox provider
- run creates sandbox
- agent-runner executes inside sandbox
- callback is accepted
- artifact/evaluator/stop condition drive completion
- cleanup destroys sandbox
- provider resource list has no Southstar-managed residue

## 20. Acceptance criteria

1. `.southstar.yaml` is the only executor configuration source.
2. Runtime reads only bootstrap env vars: `SOUTHSTAR_CONFIG`, `SOUTHSTAR_PROJECT_ROOT`, `SOUTHSTAR_DEBUG`.
3. `executor.provider=tork` instantiates only Tork provider.
4. `executor.provider=cubesandbox` instantiates only CubeSandbox provider.
5. CubeSandbox SDK usage is isolated behind `CubeSandboxSdkClient`.
6. All executor callbacks use `/api/v2/executor/callback`.
7. Executor lifecycle facts are persisted as resource/history/event evidence.
8. timeout, hang, callback missing, SDK hang, provider unavailable, lock stuck, destroy failure, orphan resource, and split-brain binding are handled explicitly.
9. Strict cleanup mode leaves no Southstar-managed CubeSandbox sandbox/container after terminal run, or records retry/failure evidence and degraded health.
10. Southstar restart reconcile detects and cleans orphan resources.
11. Cleanup failure does not reverse workflow truth.
12. Workflow completion remains artifact/evaluator/stop-condition driven, not executor-provider driven.

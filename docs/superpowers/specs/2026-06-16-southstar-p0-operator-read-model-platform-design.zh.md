# Southstar P0 Operator Read Model Platform Design

## 1. 背景與目標

Southstar v2 已有多個操作介面需要讀取 runtime 狀態：server API、CLI、operator UI、task detail、executor operations，以及新的 Design Library run lineage。現況中，`src/v2/ui-api/read-models.ts` 同時承載 workflow canvas、runtime monitor、task detail、session/memory、vault/MCP、executor ops 等 projection，邊界逐漸模糊；同時 operator 在排查 real E2E 時仍需要手動查 SQLite、history、runtime resources、Tork job 與 Design Library history。

本設計的 P0 目標是建立一個正式的 **Operator Read Model Platform**：

1. 將 read model 從 UI helper 提升為穩定 projection layer。
2. 所有 read model 回傳統一 versioned envelope。
3. 新增 `run-inspection` 作為第一個完整 operator diagnostic read model。
4. 將 `run-inspection` 的診斷邏輯抽到獨立 `inspection` core，避免 read model layer 再次變成雜物間。
5. 透過 API 與 CLI 以一致方式消費 read model。
6. 支援 runtime + Design Library lineage 的寬容診斷：runtime inspection 永遠可用，Design Library 缺失只回傳 structured unavailable reason。

此設計是 breaking change：可以調整既有 API/read-model response shape，但同一實作週期必須集中修正 server routes、CLI client、UI consumers 與 tests。

## 2. 非目標

P0 不做以下事情：

- 不建立完整 read-only UI 頁面。
- 不新增 real E2E 場景作為 P0 blocking gate。
- 不讓 CLI 直接讀 SQLite；CLI 只透過 runtime server API。
- 不回傳 artifact/evidence/validator 的 raw payload。
- 不執行 LLM 解釋；failure explanation 必須是 deterministic。
- 不把 Design Library reuse matcher 納入 P0 gate；P0 只呈現 lineage 狀態。
- 不新增 fake executor、fake E2E shortcut 或 in-memory executor 替代。

## 3. 架構邊界

### 3.1 Diagnostic core

新增獨立目錄：

```text
src/v2/inspection/
  inspect-run.ts
  explain-failure.ts
  runtime-gates.ts
  design-library-lineage.ts
  types.ts
```

`inspection` 是 operator diagnostic core。責任：

- 只讀 SQLite。
- 不依賴 HTTP、CLI、React 或 UI。
- 不執行 side effects。
- 不提交 Tork job。
- 不改 runtime state。
- 聚合 run/tasks/executor/artifact/evidence/validator/stop-condition/Design Library lineage。
- 產出 task-centric diagnostic data。
- 計算 deterministic failure explanation 與 runtime gate verdict。

主要 exports：

```ts
inspectRun(db, { runId }): RunInspection
explainRunFailure(input): FailureExplanation
evaluateRuntimeInspectionGates(input): RuntimeGateVerdicts
readDesignLibraryLineage(db, input): DesignLibraryLineage
```

### 3.2 Read model platform

新增正式 projection layer：

```text
src/v2/read-models/
  envelope.ts
  registry.ts
  types.ts
  run-inspection.ts
  runtime-monitor.ts
  workflow-canvas.ts
  executor-ops.ts
  task-detail.ts
  sessions-memory.ts
  vault-mcp.ts
```

`read-models` 的責任：

- 定義統一 envelope。
- 根據 `kind` dispatch read model builder。
- 包裝 projection data，產生 schema version、generatedAt 與 diagnostics。
- 供 server API、CLI、未來 UI 共用。
- 不承載複雜 diagnostic policy；`run-inspection.ts` 只包裝 `inspection.inspectRun(...)`。

### 3.3 UI API migration

`src/v2/ui-api/read-models.ts` 不再作為主要開發位置。因為這是 breaking change，可以將既有 consumer 遷移到 `src/v2/read-models/*`。為降低一次性風險，可短期保留 `ui-api/read-models.ts` 作為 deprecated thin shim，但不得再新增實質邏輯。

## 4. Read model envelope contract

所有 read model 回傳統一 envelope，不裸回 data：

```ts
type ReadModelEnvelope<TKind extends string, TData> = {
  schemaVersion: string;
  kind: TKind;
  generatedAt: string;
  data: TData;
  diagnostics: {
    stale: boolean;
    warnings: ReadModelWarning[];
  };
};

type ReadModelWarning = {
  code: string;
  message: string;
  severity: "info" | "warning";
  resourceRef?: string;
};
```

範例：

```json
{
  "schemaVersion": "southstar.read_model.run_inspection.v1",
  "kind": "run-inspection",
  "generatedAt": "2026-06-16T06:30:00.000Z",
  "data": {
    "runId": "run-123",
    "status": "failed",
    "health": "blocked",
    "primaryCause": {
      "code": "incomplete_evidence",
      "severity": "blocking",
      "taskId": "checker"
    },
    "tasks": []
  },
  "diagnostics": {
    "stale": false,
    "warnings": []
  }
}
```

P0 read model kinds：

```ts
type ReadModelKind =
  | "run-inspection"
  | "runtime-monitor"
  | "workflow-canvas"
  | "executor-ops"
  | "task-detail"
  | "sessions-memory"
  | "vault-mcp";
```

## 5. API contract

所有 read model endpoint 統一走 namespace：

```text
GET /api/v2/read-models/run-inspection/:runId
GET /api/v2/read-models/runtime-monitor/:runId
GET /api/v2/read-models/workflow-canvas/:runId
GET /api/v2/read-models/executor-ops/:runId
GET /api/v2/read-models/task-detail/:runId/:taskId
GET /api/v2/read-models/sessions-memory/:runId
GET /api/v2/read-models/vault-mcp/:runId
```

Route handler 只負責：

1. parse `kind/runId/taskId`；
2. 呼叫 read model registry；
3. 回傳 envelope；
4. 對 unknown kind 或缺少必要參數回 deterministic error。

舊 endpoints 例如 `/api/v2/runs/:runId/tasks`、`/api/v2/runs/:runId/artifacts`、`/api/v2/runs/:runId/logs` 可作為 resource/debug endpoints 暫時保留，但不再被定義為 read model boundary。

## 6. CLI contract

CLI 採完整 read-model namespace，不提供 `inspect-run` alias：

```bash
southstar:v2 read-model --kind run-inspection --run-id <runId>
southstar:v2 read-model --kind runtime-monitor --run-id <runId>
southstar:v2 read-model --kind workflow-canvas --run-id <runId>
southstar:v2 read-model --kind executor-ops --run-id <runId>
southstar:v2 read-model --kind task-detail --run-id <runId> --task-id <taskId>
southstar:v2 read-model --kind sessions-memory --run-id <runId>
southstar:v2 read-model --kind vault-mcp --run-id <runId>
```

CLI 不直接讀 SQLite。它只透過 runtime server API：

```text
GET /api/v2/read-models/:kind/:runId
GET /api/v2/read-models/task-detail/:runId/:taskId
```

這代表第一版 offline DB inspection 不是 P0 能力；runtime server 必須可用。

## 7. Run inspection data model

`inspection.inspectRun(...)` 回傳裸 diagnostic data，不帶 envelope：

```ts
type RunInspection = {
  runId: string;
  status: string;
  health: "healthy" | "running" | "blocked" | "failed" | "unknown";
  generatedFrom: {
    workflowManifestPresent: boolean;
    compiledFrom?: {
      objectKey?: string;
      versionId?: string;
      source?: string;
    };
  };
  counts: RunInspectionCounts;
  gates: RuntimeGateVerdicts;
  primaryCause: InspectionCause | null;
  contributingCauses: InspectionCause[];
  designLibrary: DesignLibraryLineage;
  tasks: InspectedTask[];
};
```

### 7.1 Task-centric body

`tasks[]` 是主體。每個 task 聚合 executor、artifact、evidence、validator 與 task-level causes：

```ts
type InspectedTask = {
  taskId: string;
  taskKey: string;
  status: string;
  sortOrder: number;
  dependsOn: string[];
  executor: {
    bindingId?: string;
    status?: string;
    executorType?: string;
    externalJobId?: string;
    runnerPhase?: string;
    lastHeartbeatAt?: string;
    issue: "missing_binding" | "timeout" | "orphaned" | "callback_missing" | "none";
  };
  artifact: {
    accepted: number;
    needsRepair: number;
    rejected: number;
    latestStatus?: string;
    resourceRefs: string[];
  };
  evidence: {
    complete: number;
    incomplete: number;
    latestStatus?: string;
    resourceRefs: string[];
    missingKinds: string[];
  };
  validators: {
    passed: number;
    failedBlocking: number;
    failedNonBlocking: number;
    latestFailedBlockingRef?: string;
  };
  causes: InspectionCause[];
};
```

### 7.2 Cause model

```ts
type InspectionCause = {
  code:
    | "run_missing"
    | "task_failed"
    | "executor_issue"
    | "artifact_needs_repair"
    | "artifact_rejected"
    | "incomplete_evidence"
    | "blocking_validator_failed"
    | "stop_condition_failed"
    | "stop_condition_missing"
    | "design_library_lineage_unavailable"
    | "task_stale_or_pending";
  severity: "blocking" | "warning" | "info";
  taskId?: string;
  resourceRef?: string;
  message: string;
};
```

### 7.3 Runtime gates

P0 內建 runtime gate verdict：

```ts
type RuntimeGateVerdicts = {
  completedTasks: GateVerdict;
  acceptedArtifactsEqualCompletedTasks: GateVerdict;
  completeEvidenceEqualAcceptedArtifacts: GateVerdict;
  blockingValidatorFailuresZero: GateVerdict;
  stopConditionPassed: GateVerdict;
  payloadSizeWithinLimit: GateVerdict;
};

type GateVerdict = {
  verdict: "passed" | "failed" | "not_applicable";
  actual: unknown;
  expected: string;
};
```

Runtime gates are diagnostic projection, not lifecycle truth. They do not mutate run status.

## 8. Failure explanation priority

`explainRunFailure` is deterministic. It does not call an LLM and does not invent missing context.

Priority order:

1. run missing；
2. task failed；
3. executor issue；
4. artifact rejected / needs repair；
5. incomplete evidence；
6. blocking validator failed；
7. stop condition failed / missing；
8. Design Library lineage unavailable；
9. pending/running task staleness when timestamps support detection。

`primaryCause` 是第一個 blocking/highest-priority cause。`contributingCauses` 是其他異常 facts，按同一 priority 排序。

`incomplete_evidence` 優先於 `blocking_validator_failed`，因為 validator failure 常常是 evidence incomplete 的下游結果；operator 第一眼應看到更根本的 evidence 缺口。

Design Library lineage unavailable is not blocking for runtime inspection. It appears as warning/contributing cause only.

## 9. Design Library lineage

Lineage 採寬容模式：runtime inspection 永遠可用；library 缺失不讓整份 inspect 失敗。

```ts
type DesignLibraryLineage =
  | {
      available: true;
      compiledFrom: {
        objectKey?: string;
        versionId?: string;
        source?: string;
      };
      sourceObject?: {
        objectId: string;
        objectKey: string;
        objectKind: string;
        status: string;
        headVersionId?: string;
      };
      sourceVersion?: {
        versionId: string;
        definitionKind: string;
        contentHash: string;
      };
      validatedFromRun?: {
        eventRef: string;
        validatedTemplateVersionId: string;
        createdAt: string;
      };
    }
  | {
      available: false;
      reason:
        | "library_tables_missing"
        | "not_compiled_from_library"
        | "lineage_not_found";
    };
```

Lineage detection rules:

1. If `library_objects` or `library_history` tables are missing, return `library_tables_missing`.
2. If workflow manifest has no `compiledFrom`, return `not_compiled_from_library`.
3. If `compiledFrom` exists but source object/version cannot be found, return `lineage_not_found`.
4. If `template.validated_from_run` exists for the inspected run, include `validatedFromRun`.
5. Do not run reuse matcher in P0.

## 10. Health calculation

`health` is derived from run status, causes, and gates:

- `healthy`: run terminal `passed` or `completed`, all runtime gates passed, and no blocking cause.
- `running`: run active/running and no blocking cause yet.
- `blocked`: blocking cause exists but run is not terminal failed/cancelled.
- `failed`: run terminal failed/cancelled or blocking gate failed after terminal.
- `unknown`: run missing or read model cannot determine consistency.

Health is an operator projection. It does not rewrite `workflow_runs.status`.

## 11. Payload policy

P0 read models do not return raw payloads from artifact/evidence/validator resources. They return summary-only data:

- resource id/ref;
- resource type;
- status;
- taskId;
- created/updated timestamps when useful;
- extracted safe fields such as evidence missing kinds, validator verdict, blocking flag, executor type/status/job id.

This keeps read models suitable for UI rendering, avoids transcript/log expansion, and reduces accidental secret exposure. Deep forensic inspection remains available through dedicated debug endpoints or direct DB access by operators.

## 12. Testing strategy

### 12.1 Unit tests

Add:

```text
tests/v2/run-inspection.test.ts
tests/v2/read-model-registry.test.ts
```

Required coverage:

1. Passed run returns `health="healthy"`.
2. Missing run returns `health="unknown"` and primary cause `run_missing`.
3. Artifact `needs_repair` creates task-level cause.
4. Incomplete evidence outranks blocking validator failure as primary cause.
5. Blocking validator failure appears in contributing causes.
6. Stop condition missing/failed fails the corresponding gate.
7. Oversized payload rows fail `payloadSizeWithinLimit`.
8. Missing Design Library tables return `designLibrary.available=false` and `reason="library_tables_missing"` without failing inspect.
9. `compiledFrom` plus `template.validated_from_run` returns available lineage.
10. Read model registry returns uniform envelope with expected schemaVersion/kind/generatedAt/data/diagnostics.

### 12.2 API tests

Extend server API tests to cover:

```text
GET /api/v2/read-models/run-inspection/:runId
GET /api/v2/read-models/task-detail/:runId/:taskId
```

Assertions:

- response has `schemaVersion`, `kind`, `generatedAt`, `data`, `diagnostics`;
- `kind` matches requested read model;
- invalid kind returns deterministic error;
- missing/nonexistent task detail returns deterministic error.

### 12.3 CLI tests

Extend CLI tests to cover:

```bash
southstar:v2 read-model --kind run-inspection --run-id run-1
southstar:v2 read-model --kind task-detail --run-id run-1 --task-id task-1
```

Assertions:

- parser accepts `read-model` command;
- `task-detail` requires `--task-id`;
- CLI uses runtime client and does not directly read SQLite for read model commands.

### 12.4 UI/page-model migration tests

Existing tests that import from `ui-api/read-models.ts` should be migrated to `src/v2/read-models/*` or registry output where appropriate. UI adapters that need naked data should explicitly use `envelope.data`, not legacy unwrapped shapes.

### 12.5 Real E2E

P0 does not require a new real E2E. After unit/API/CLI tests pass, operators may manually point `read-model --kind run-inspection` at a real Design Library run DB/server for confidence, but that is not a blocking gate for this P0 design.

## 13. Acceptance criteria

Implementation is complete only if all of these hold:

1. `src/v2/inspection/*` exists and has no HTTP/CLI/UI dependency.
2. `src/v2/read-models/*` exists and all P0 read models return uniform envelope.
3. `run-inspection` aggregates run, tasks, executor binding, artifacts, evidence packets, validator results, stop condition, runtime gates, and Design Library lineage.
4. Failure explanation is deterministic and priority-based.
5. Incomplete evidence outranks blocking validator failure in primary cause selection.
6. Design Library lineage missing is non-blocking and represented as structured unavailable reason.
7. API supports `/api/v2/read-models/:kind/:runId` plus task-detail `:taskId` route.
8. CLI supports `southstar:v2 read-model --kind ... --run-id ... [--task-id ...]` and goes through runtime server API.
9. `ui-api/read-models.ts` is either removed with imports migrated, or reduced to deprecated thin shim with no new substantive logic.
10. Read models do not return raw artifact/evidence/validator payload.
11. `npm run test:v2` passes.
12. `npm test` passes.

## 14. Rollout plan

Implementation should proceed in this order:

1. Add `inspection` core with tests.
2. Add `read-models` envelope and registry with tests.
3. Wrap existing read models into new envelope builders.
4. Add run-inspection read model adapter.
5. Add API read-model namespace route.
6. Add CLI `read-model` command using runtime server client.
7. Migrate UI/page-model imports and tests.
8. Reduce `ui-api/read-models.ts` to deprecated shim or remove it after imports are fixed.
9. Run full verification.

## 15. Design summary

This P0 establishes a formal projection boundary for Southstar operator surfaces. The system gains a reusable read model platform while keeping diagnostic policy isolated in `inspection`. `run-inspection` becomes the canonical operator answer to “this run is healthy or blocked, and why,” with deterministic evidence, no raw payload bloat, and tolerant Design Library lineage reporting.
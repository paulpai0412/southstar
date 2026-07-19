# Goal Contract Coverage Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use inline execution with TDD for this focused vertical slice.

**Goal:** 在既有 Goal Contract sidecar 以可展開的 graph chart 與 coverage matrix 呈現 Requirement → AC → Slice Plan → Workflow DAG → Task → Producer → Artifact → Evidence → Evaluator 關係。

**Architecture:** 重用既有 `WorkflowUiReadModel`、`canvasModel` 與 `LibraryGraphChart` SVG 元件。Slice Plan 從 planner draft 的 `goalDesignPackage.slicePlan` / persisted `slicePlan` 讀取；Workflow DAG 與 Task 從 draft workflow 或 runtime manifest/task snapshot 投影，task 的 requirement/slice/purpose/node type/output 從既有 `promptInputs` 讀取。缺少 persisted lineage 時 fail closed 顯示未綁定，不建立 placeholder data。

**Tech Stack:** Next.js、React、TypeScript、既有 SVG graph chart、Node test runner、Playwright browser harness。

## Global Constraints

- Reuse current read models and UI seams; do not add API, database, or graph dependency.
- Keep `lineage` as a read-model projection; do not reconstruct workflow truth in the browser.
- Keep technical keys secondary; show readable labels and explicit relationship/status text.
- Coverage status must remain understandable without color alone.
- Verify focused UI tests, web build, and `git diff --check`.

---

### Task 1: Add failing Goal Contract graph and matrix test

**Files:**
- Modify: `/home/timmypai/apps/southstar/tests/v2/workflow-ui-read-model.test.ts`
- Modify: `/home/timmypai/apps/southstar/tests/web/southstar-workflow-canvas-ui.test.tsx`

- [x] Add a test that supplies producer, artifact, evaluator, and evidence data and expects graph nodes, edge labels, and a coverage row.
- [x] Add a draft read-model test that asserts persisted slice plan, DAG edges, and task prompt lineage.
- [x] Add runtime read-model assertions that DAG/task lineage follows the runtime canvas projection.
- [x] Run the focused test and confirm it fails because the new test ids are absent.

### Task 2: Implement formal workflow lineage projection

**Files:**
- Modify: `/home/timmypai/apps/southstar/src/v2/read-models/runtime-workflow-projection.ts`
- Modify: `/home/timmypai/apps/southstar/src/v2/read-models/workflow-ui.ts`
- Modify: `/home/timmypai/apps/southstar/web/lib/workflow/types.ts`

- [x] Preserve slice/requirement/purpose/node type/output metadata while parsing existing task prompt inputs.
- [x] Project draft and runtime Slice Plan → Workflow DAG → Task lineage into `WorkflowUiReadModel`.
- [x] Keep malformed or absent persisted slice plans as `null` instead of inventing data.

### Task 3: Implement the coverage graph projection and UI

**Files:**
- Modify: `/home/timmypai/apps/southstar/web/components/GoalContractInspector.tsx`

- [x] Project existing mission coverage into typed graph nodes and edges.
- [x] Reuse `LibraryGraphChart` for the graph view with the persisted Slice Plan, Workflow DAG, and Task layers.
- [x] Render a readable coverage matrix with slice, DAG, task, producer, artifact, evidence, evaluator, and status columns.
- [x] Keep refs visible as secondary metadata and show missing evidence/evaluator states explicitly.

### Task 4: Verify the vertical slice

- [x] Run the focused browser UI test.
- [x] Run the workflow UI read-model test suite.
- [x] Run the full web workflow canvas UI suite.
- [x] Run `npm --prefix web run build`.
- [x] Run `git diff --check`.

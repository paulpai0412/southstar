# Step Coverage Previews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable coverage preview graph to the Requirement, Slice, and DAG blocks using the lineage fields already present in their browser payloads.

**Architecture:** Reuse `LibraryGraphChart` for rendering and add one small `CoverageGraphPreview` wrapper for the shared heading/count presentation. Each existing block builds only the relationships it can prove from its current data: Requirement/AC/coverage refs, Requirement/Slice/artifact/evaluator dependencies, and Requirement/Slice/Task/DAG/expected outputs. The DAG additionally merges the existing `GoalMissionReadModel` coverage graph when `dag.mission` is present; no new backend or read-model changes are included.

**Tech Stack:** React, TypeScript, Next.js, existing Playwright browser harness tests, existing `LibraryGraphChart`.

## Global Constraints

- Reuse the active `web/` application and existing graph types; do not create a parallel graph renderer.
- Do not invent evaluator, evidence, producer, artifact, or acceptance-criteria bindings that are absent from the block payload.
- Keep route handlers, runtime persistence, and read models unchanged.
- Follow TDD: each behavior gets a failing browser test before production code.
- Preserve unrelated dirty worktree changes and do not commit unless explicitly requested.

### Task 1: Add failing preview tests

**Files:**
- Modify: `tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**
- Tests observe `goal-requirements-coverage-preview`, `goal-slice-coverage-preview`, and `workflow-dag-coverage-preview`.

- [x] **Step 1: Write tests for the three block previews**
  - Render representative Requirement, Slice, and DAG payloads.
  - Assert each preview renders a graph chart and the expected node/edge labels.
  - Assert the DAG preview uses only available expected outputs and does not render evaluator/evidence nodes without refs.

- [x] **Step 2: Run the focused test file**

```bash
node --import tsx --test tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected: the new preview tests fail because the three preview test IDs do not exist yet.

### Task 2: Add the shared preview wrapper

**Files:**
- Create: `web/components/CoverageGraphPreview.tsx`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**
- `CoverageGraphPreview({ testId, title, description, nodes, edges, persistLayoutKey })` renders the existing `LibraryGraphChart` with shared counts and styling.

- [x] **Step 1: Implement the smallest wrapper**
  - Return `null` for an empty graph.
  - Render the title, node/edge counts, and `LibraryGraphChart`.
  - Keep node selection behavior unchanged because these blocks do not expose a graph-node sidecar callback.

- [x] **Step 2: Run the focused tests**

```bash
node --import tsx --test tests/web/southstar-workflow-canvas-ui.test.tsx
```

Expected: wrapper-level assertions pass; block-specific graph assertions remain red until the builders are wired.

### Task 3: Wire Requirement, Slice, and DAG graph builders

**Files:**
- Modify: `web/components/GoalRequirementListBlock.tsx`
- Modify: `web/components/GoalSlicePlanBlock.tsx`
- Modify: `web/components/WorkflowDagBlock.tsx`
- Test: `tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**
- Requirement graph nodes: `requirement:<id>`, `ac:<requirementId>:<criterionId>`, and actual artifact/evaluator refs.
- Slice graph nodes: `requirement:<id>`, `slice:<id>`, actual artifact/evaluator refs, with dependency edges from prerequisite slice to dependent slice.
- DAG graph nodes: `requirement:<id>`, `slice:<id>`, `task:<id>`, and task-scoped expected-output nodes; existing DAG edges remain task-to-task edges. Expected outputs are not labeled as produced Artifacts until an artifact lineage read model exists.

- [x] **Step 1: Build the Requirement graph from draft requirements and `coveragePreview`**
- [x] **Step 2: Build the Slice graph from normalized slice data and optional requirement content**
- [x] **Step 3: Build the DAG graph from `dag.nodes`, `dag.edges`, and `expectedOutputs`**
- [x] **Step 4: Render each preview after its block’s primary list/canvas**
- [x] **Step 5: Run the focused tests and confirm all new assertions pass**

### Task 4: Merge persisted mission coverage into the DAG preview

- Reuse the existing Goal Contract coverage graph builder for Producer, Artifact, Evidence, Evaluator, and Verdict nodes.
- Enrich DAG Requirement nodes from the persisted Goal Contract statement and connect known producer/evaluator task ids to their graph nodes.
- Keep missing evidence/evaluator bindings explicit and do not convert expected outputs into produced artifacts.

- [x] **Step 1: Add a failing DAG browser test for persisted mission coverage**
- [x] **Step 2: Merge `dag.mission` coverage without adding a second read model**
- [x] **Step 3: Verify full workflow and related Library/Chat suites**

### Task 5: Verify the rendered web surface

**Files:**
- No additional source files.

- [x] **Step 1: Run the focused Requirement/Slice/DAG browser tests**
- [x] **Step 2: Run the related library candidate graph tests**
- [x] **Step 3: Run `npm --prefix web run build`**
- [x] **Step 4: Run `git diff --check`**
- [x] **Step 5: Reload the active localhost UI and check page identity, non-blank rendering, framework-overlay absence, and console health**

## Self-review

- Requirement, Slice, and DAG each have a dedicated preview test and a concrete data mapping.
- No graph node is synthesized without an existing source field; generated display keys only namespace existing task/output refs.
- DAG evaluator/evidence lineage is rendered when the existing `GoalMissionReadModel` is present; missing runtime evidence remains visibly unbound.

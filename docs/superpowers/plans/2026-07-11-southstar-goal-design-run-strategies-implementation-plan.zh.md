# Southstar Goal Design, Single-Run/Per-Slice-Run Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 One-Prompt runtime 上加入 Library-driven Goal Design、自然 Slice Plan、預設確認/可選 Auto、Goal-level Workflow Template policy、全部 Slices 同一 run 或每 Slice 獨立 run，以及原 Workflow layout 內的 Slice viewer/editor。

**Architecture:** `POST /api/v2/run-goal` 先以 approved Library Goal Design skill 產生並持久化 `GoalDesignPackageV1`；預設停在 `ready_for_review`，Auto 或 hash-bound confirmation 才把同一 package 交給現有 resolver/composer/validator/compiler。`single-run` 產生一份包含全部 Slices 的 manifest；`per-slice-runs` 為每個 Slice 產生一份 manifest 和普通 workflow run，全部共享 Goal Contract `cwd`，由非階層式 `goal_execution_set` 依 Slice dependency 順序啟動與聚合 outcome。所有 UI 都留在既有 message stream、Goal card、sidecar 與 `WorkflowDagBlock`。

**Existing chat seam:** 保留 `ChatWindow → useAgentSession → generateWorkflowDagStream → POST /api/workflow/generate → POST /api/v2/run-goal`。Workflow tab 的 chat input 就是 Goal Design 入口；瀏覽器只傳 prompt、cwd、idempotency key、Goal Design mode 與 structured Template policy，Library Goal Design skill 一律由 runtime 載入、執行與留存 provenance，browser 不直接執行 skill。

**Tech Stack:** Node.js `>=22.22.2`, TypeScript ESM, `tsx`, Node `node:test`, Postgres `southstar` schema, Next.js 16, React 19, existing Library file/graph sync, Pi LLM planner, Tork, Playwright.

## Global Constraints

- Production source of truth remains `src/v2/` and `web/`; do not restore the retired root Next app.
- Production composition remains LLM-only and fail-closed. Do not add deterministic, scripted, canned, or fallback composers under `src/v2/`.
- Do not add new test fixture modules, seeded composition plans, fixed DAGs, fixed slice counts, domain packs, or runtime seed code. Focused tests may use inline boundary doubles; acceptance uses real Pi plus file-authored Library content.
- Do not hardcode software/article/subscription requirement names, `SG1..SGn`, task counts, slice counts, domain keyword classifiers, template ids, Agent refs, Skill refs, Tool refs, MCP refs, or evaluator refs in production code.
- Goal Design instructions come from exactly one approved Library `skill_spec` with `purpose: goal_design`; production TypeScript stores only schemas and invariants, not the SOP body or a concrete skill id.
- Approved Library graph objects are the only composition candidates. Remove the synthetic `template.graph-dynamic-workflow` fallback. In `auto` or `prefer`, template-free composition uses approved independent primitives and records no selected-template ref; do not replace the fallback with another fixed Template marker.
- `GoalDesignPackageV1`, Slice Plan revisions, confirmations, fallback reasons, coverage, snapshots, and execution-set state are durable Postgres resources. Do not add a database table.
- Default mode is `review_before_compose`. `auto_until_blocked` skips only Goal Design confirmation; it never bypasses execution approval.
- Every blocking requirement has exactly one owner slice. Every producer dependency consumes a declared upstream output artifact. The validator, not the prompt, enforces these invariants.
- Workflow Template defaults to `auto`; `prefer` may fall back with persisted evidence and `require` fails closed. Browser Save Template creates draft/proposal state, never `approved`.
- Preserve the current Workflow layout. Do not add a Goal workbench, second simultaneous DAG canvas, run hierarchy, modal editor, new sidecar kind, or replacement canvas.
- Run Case 32 only in Task 8 after focused and integration gates pass.
- Before implementation, finish or separately commit the current Case31/Case32 worktree changes. Execute this plan from an isolated worktree whose baseline commit includes those accepted changes.
- Code snippets use concise test-local builder names such as `validPackage`, `slice`, `compositionTask`, and `countRows`. Define each referenced helper in the same test file, build contracts/packages through production `finalizeGoalContract()` / `finalizeGoalDesignPackage()`, and query through existing Postgres test helpers. Do not import `tests/v2/fixtures/*`, copy a canned composition, or create a shared Goal Design fixture module.

---

## File Structure

### New files

- `library/skills/southstar-goal-design.skill.md` — approved, file-authored Goal Design SOP with `purpose: goal_design`.
- `src/v2/orchestration/goal-design.ts` — Goal Design types, strict parsing, invariant validation, skill resolution, LLM call, hashes, and immutable revision construction.
- `src/v2/orchestration/goal-workspace-discovery.ts` — bounded, read-only, secret-safe workspace evidence supplied to Goal interpretation/design.
- `src/v2/orchestration/goal-design-draft-service.ts` — current-package projection, immutable package revision resources, confirmation, Slice edit, Template policy edit, and optimistic concurrency.
- `src/v2/orchestration/goal-execution-set.ts` — non-hierarchical same-cwd per-Slice run materialization, serial advancement, cross-run artifact refs, and aggregate outcome.
- `tests/v2/goal-design.test.ts` — focused schema, invariant, Library skill, hash, and revision tests using inline doubles only.
- `tests/v2/goal-execution-set.test.ts` — focused same-cwd run mapping, serial advancement, idempotency, and aggregate outcome tests.
- `web/app/api/workflow/planner-drafts/[draftId]/confirm-goal-design/route.ts` — thin confirmation proxy.
- `web/app/api/workflow/planner-drafts/[draftId]/goal-design/slices/[sliceId]/route.ts` — thin typed Slice revision proxy.
- `web/app/api/workflow/planner-drafts/[draftId]/goal-design/template-policy/route.ts` — thin Template policy revision proxy.
- `web/components/GoalSlicePlan.tsx` — compact selectable Slice rows inside the existing Goal card.

### Existing files to deepen

- `src/v2/orchestration/goal-contract.ts`
- `src/v2/orchestration/run-goal-service.ts`
- `src/v2/orchestration/composer.ts`
- `src/v2/orchestration/llm-composer.ts`
- `src/v2/orchestration/candidate-resolver.ts`
- `src/v2/orchestration/composition-repair-loop.ts`
- `src/v2/orchestration/composition-validator.ts`
- `src/v2/orchestration/composition-compiler.ts`
- `src/v2/orchestration/goal-requirement-coverage.ts`
- `src/v2/orchestration/run-library-snapshot.ts`
- `src/v2/runtime-revision/dynamic-repair-revision.ts`
- `src/v2/design-library/types.ts`
- `src/v2/manifests/types.ts`
- `src/v2/manifests/validate.ts`
- `src/v2/ui-api/postgres-run-api.ts`
- `src/v2/server/planner-routes.ts`
- `src/v2/server/client.ts`
- `src/v2/server/workflow-template-routes.ts`
- `src/v2/workflow-templates/template-api-service.ts`
- `src/v2/server/library-routes.ts`
- `src/v2/approvals/postgres-approval-service.ts`
- `src/v2/evaluators/completion-gate.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/context/managed-context-assembler.ts`
- `src/v2/read-models/workflow-ui.ts`
- `web/app/api/workflow/generate/route.ts`
- `web/lib/workflow/generate-stream.ts`
- `web/lib/workflow/types.ts`
- `web/lib/types.ts`
- `web/hooks/useAgentSession.ts`
- `web/components/MessageView.tsx`
- `web/components/ChatWindow.tsx`
- `web/components/GoalContractCard.tsx`
- `web/components/GoalContractInspector.tsx`
- `web/components/AppShell.tsx`
- `web/components/WorkflowSidebar.tsx`
- `web/lib/workflow/template-save.ts`

---

### Task 1: Library-Driven Goal Design Contract

**Files:**
- Create: `library/skills/southstar-goal-design.skill.md`
- Create: `src/v2/orchestration/goal-design.ts`
- Create: `src/v2/orchestration/goal-workspace-discovery.ts`
- Create: `tests/v2/goal-design.test.ts`
- Create: `tests/v2/goal-workspace-discovery.test.ts`
- Modify: `src/v2/orchestration/goal-contract.ts`
- Modify: `tests/v2/goal-contract.test.ts`
- Modify: `tests/v2/index.test.ts`

**Interfaces:**
- Consumes: `findApprovedLibraryObjectsByKind()`, `contentHashForPayload()`, `LlmTextClient`, and `GoalContractV1`.
- Produces: `WorkspaceGoalDiscoveryV1`, `discoverGoalWorkspace()`, `ResolvedGoalDesignSkillV1`, `GoalDesignMode`, `RequirementEvaluatorContractV1`, `GoalSlicePlanV1`, `CompositionStrategyV1`, `WorkflowTemplatePolicyV1`, `GoalDesignPackageV1`, `GoalDesignSteeringProposalV1`, `GoalDesigner`, `loadGoalDesignSkillPg()`, `designGoalWithLlm()`, `validateGoalDesignPackage()`, `finalizeGoalDesignPackage()`, and `goalDesignPackageHash()`.

- [ ] **Step 1: Write failing Goal Design and work-type tests**

Add focused tests with inline LLM responses. Do not import anything from `tests/v2/fixtures/`.

```ts
test("Goal Design uses the approved Library SOP and derives variable outcome slices", async () => {
  const prompts: string[] = [];
  const designed = await designGoalWithLlm(db, {
    goalContract: articleGoalContract({ workType: "general" }),
    mode: "review_before_compose",
    templatePolicy: { mode: "auto" },
    client: {
      async generateText({ prompt }) {
        prompts.push(prompt);
        return JSON.stringify({
          evaluatorContracts: [{
            id: "eval-offline",
            requirementId: "req-offline",
            acceptanceCriteria: ["article opens offline"],
            requiredEvidenceKinds: ["screenshot"],
            independence: "independent",
            failureClassifications: ["network_dependency"],
          }],
          slicePlan: {
            revision: 1,
            slices: [{
              id: "slice-article",
              requirementIds: ["req-offline"],
              outcome: "deliver the offline article",
              stateOrArtifactOwner: "article.html",
              mutationBoundary: "one self-contained HTML artifact",
              expectedArtifactRefs: ["artifact.article_html"],
              evaluatorContractRefs: ["eval-offline"],
              dependsOnSliceIds: [],
              dependencyArtifactRefs: [],
            }],
          },
          compositionStrategy: {
            mode: "single-run",
            sliceIds: ["slice-article"],
            rationale: "one atomic artifact boundary",
          },
        });
      },
    },
    model: "inline-goal-design-test",
  });

  assert.match(prompts[0] ?? "", /smallest cohesive outcome slices/i);
  assert.equal(designed.package.slicePlan.slices.length, 1);
  assert.equal(designed.package.goalDesignSkillVersionRef, designed.skill.versionRef);
  assert.equal(validateGoalDesignPackage(designed.package).length, 0);
});

test("Goal Contract workType is schema output rather than a domain regex", () => {
  const contract = finalizeGoalContract({
    goalPrompt: "Investigate the source",
    cwd: "/workspace",
    interpretation: validInterpretation({ domain: "custom/domain", intent: "unfamiliar_intent", workType: "research" }),
  });
  assert.equal(requirementSpecFromGoalContract(contract).workType, "research");
});

test("Goal Design rejects duplicate requirement ownership and artifact-free dependencies", () => {
  const duplicateOwner = packageValue({
    slices: [slice("a", ["req-1"]), slice("b", ["req-1"])],
  });
  assert.deepEqual(
    validateGoalDesignPackage(duplicateOwner).map((issue) => issue.code),
    ["requirement_owner_count"],
  );

  const falseDependency = packageValue({
    slices: [
      slice("a", ["req-1"], { expectedArtifactRefs: ["artifact.a"] }),
      slice("b", ["req-2"], { dependsOnSliceIds: ["a"], dependencyArtifactRefs: [] }),
    ],
  });
  assert.equal(validateGoalDesignPackage(falseDependency).some((issue) => issue.code === "dependency_without_artifact_flow"), true);
});
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `npx tsx tests/v2/goal-design.test.ts && npx tsx tests/v2/goal-contract.test.ts`

Expected: FAIL because `goal-design.ts` and `GoalContractV1.workType` do not exist.

- [ ] **Step 3: Add the file-authored Goal Design SOP**

Create the skill with this exact domain-neutral content; it must not gain example domains, requirement names, task counts, or concrete Library refs.

```markdown
---
schemaVersion: southstar.library.skill_spec_file.v1
id: skill.southstar-goal-design
title: "Southstar Goal Design"
scope: "global"
status: approved
purpose: goal_design
---

# Southstar Goal Design

Guide Goal Contract interpretation from the user prompt and bounded workspace discovery, then transform the finalized contract into evaluator contracts, the smallest cohesive outcome slices, and a single-run or per-slice-runs composition strategy.

## SOP

1. Read the user prompt, bounded workspace discovery, prior contract when present, and approved Library vocabulary supplied by the host.
2. In contract-interpretation mode, preserve explicit requirements, identify only product-significant blockers, and return the host-requested Goal Contract interpretation schema.
3. In Slice-design mode, read the finalized Goal Contract and preserve every requirement and acceptance criterion.
4. Define one independent evaluator contract for every blocking requirement.
5. Decompose statements that cross independent outcome boundaries before assigning ownership.
6. Assign every blocking requirement to exactly one owner slice.
7. Merge requirements only when they share one state or artifact owner, one atomic mutation boundary, and compatible evaluator evidence; record the merge reason.
8. Add a dependency only when the downstream slice consumes a declared upstream output artifact.
9. Choose single-run by default. Choose per-slice-runs only when independently persisted Slice DAGs are explicitly useful; every run still uses the same Goal Contract workspace.

## Output

In contract-interpretation mode, return only the Goal Contract interpretation schema supplied by the host. In initial Slice-design mode, return JSON only with exactly `evaluatorContracts`, `slicePlan`, and `compositionStrategy`. For a steering turn, return either `revision` with the same complete three fields plus `summary` and `changedSliceIds`, or `needs_input` with one blocking `question`. Do not select agents, skills, tools, MCP grants, profiles, task node types, template slots, or fixed task counts. Slice evaluator refs may reference only evaluator ids declared in the same complete response; artifact refs may reference only host-finalized Goal Contract refs. Do not invent requirement, workspace, Library, or undeclared evaluator/artifact refs.
```

- [ ] **Step 4: Implement strict Goal Design types, parsing, validation, and hashing**

Add the exact public contracts below. `designGoalWithLlm()` loads the approved skill by `state.purpose`, includes its body and version in the prompt, parses JSON once plus one repair attempt, inserts host-owned hashes/refs, and validates before returning.

```ts
export type GoalDesignMode = "review_before_compose" | "auto_until_blocked";

export type ResolvedGoalDesignSkillV1 = {
  objectKey: string;
  versionRef: string;
  stateHash: string;
  body: string;
};

export type WorkspaceGoalDiscoveryV1 = {
  schemaVersion: "southstar.workspace_goal_discovery.v1";
  cwd: string;
  entries: Array<{ path: string; kind: "file" | "directory"; size?: number; contentHash?: string }>;
  instructionDocuments: Array<{ path: string; content: string; contentHash: string }>;
  projectMetadata: Array<{ path: string; content: string; contentHash: string }>;
  truncated: boolean;
  discoveryHash: string;
};

export type GoalExpectedArtifactV1 = {
  description: string;
  path?: string;
  mediaType?: string;
};

export async function discoverGoalWorkspace(
  cwd: string,
  limits?: { maxEntries?: number; maxDocumentBytes?: number; maxTotalBytes?: number },
): Promise<WorkspaceGoalDiscoveryV1>;

export type WorkflowTemplatePolicyV1 =
  | { mode: "auto" }
  | { mode: "prefer" | "require"; templateRef: string; versionRef: string };

export type RequirementEvaluatorContractV1 = {
  schemaVersion: "southstar.requirement_evaluator_contract.v1";
  id: string;
  requirementId: string;
  acceptanceCriteria: string[];
  requiredEvidenceKinds: string[];
  independence: "independent";
  failureClassifications: string[];
};

export type GoalSliceV1 = {
  id: string;
  requirementIds: string[];
  outcome: string;
  stateOrArtifactOwner: string;
  mutationBoundary: string;
  expectedArtifactRefs: string[];
  evaluatorContractRefs: string[];
  dependsOnSliceIds: string[];
  dependencyArtifactRefs: string[];
  mergeReason?: string;
};

export type GoalSlicePlanV1 = {
  schemaVersion: "southstar.goal_slice_plan.v1";
  goalContractHash: string;
  revision: number;
  slices: GoalSliceV1[];
};

export type CompositionStrategyV1 =
  | { mode: "single-run"; sliceIds: string[]; rationale: string }
  | { mode: "per-slice-runs"; sliceIds: string[]; rationale: string };

export type GoalDesignPackageV1 = {
  schemaVersion: "southstar.goal_design_package.v1";
  revision: number;
  parentRevision?: number;
  goalContract: GoalContractV1;
  evaluatorContracts: RequirementEvaluatorContractV1[];
  slicePlan: GoalSlicePlanV1;
  compositionStrategy: CompositionStrategyV1;
  templatePolicy: WorkflowTemplatePolicyV1;
  goalContractHash: string;
  evaluatorContractsHash: string;
  slicePlanHash: string;
  packageHash: string;
  goalDesignSkillRef: string;
  goalDesignSkillVersionRef: string;
  workspaceDiscoveryHash: string;
  mode: GoalDesignMode;
};

export type GoalDesigner = {
  design(input: {
    goalContract: GoalContractV1;
    workspaceDiscovery: WorkspaceGoalDiscoveryV1;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    skill: ResolvedGoalDesignSkillV1;
  }): Promise<GoalDesignPackageV1>;
  revise(input: {
    currentPackage: GoalDesignPackageV1;
    message: string;
    selectedSliceId?: string;
  }): Promise<GoalDesignSteeringProposalV1>;
};

export type GoalDesignSteeringProposalV1 =
  | {
      kind: "revision";
      package: GoalDesignPackageV1;
      summary: string;
      changedSliceIds: string[];
    }
  | {
      kind: "needs_input";
      question: string;
    };

export function finalizeGoalDesignPackage(
  input: Omit<GoalDesignPackageV1,
    | "goalContractHash"
    | "evaluatorContractsHash"
    | "slicePlanHash"
    | "packageHash"
  >,
): GoalDesignPackageV1;
```

`finalizeGoalDesignPackage()` is the only package construction seam used by production and tests: it derives every host-owned hash, then calls `validateGoalDesignPackage()`. Test-local builders may supply concise contracts/slices, but they must finish through this production function rather than importing shared fixture packages.

`discoverGoalWorkspace()` validates the cwd with the existing workspace mount policy, performs bounded read-only discovery, ignores symlink escapes, VCS/build/cache directories, binary files, and secret-looking filenames/content, and returns only a sorted file/directory index plus bounded instruction/project metadata documents. It never invokes a shell, follows arbitrary links, or sends raw secret values to the LLM. Tests cover traversal, truncation, binary exclusion, and secret redaction/fail-closed behavior.

Extend each `GoalRequirementV1` with `expectedArtifacts: GoalExpectedArtifactV1[]`. The interpreter proposes descriptions/optional relative paths, never object refs. `finalizeGoalContract()` validates safe relative paths and deterministically derives `expectedArtifactRefs` as `artifact.goal.<requirementId>.<one-based-index>`. Requirement ids are schema-validated stable identifiers; duplicate ids and artifact collisions fail. Library `artifact_contract` vocabulary remains reusable guidance but is not a whitelist for goal-scoped deliverables.

Treat Library domains/capabilities as ranked vocabulary, not a closed enum. The interpreter may return a normalized lowercase domain scope (for example a child of an approved broader scope); deterministic validation accepts only safe slash-separated segments. Candidate resolution walks exact scope, ancestors, then `global`, and records when no exact domain object exists. Do not create a domain keyword lookup table or require a pre-seeded object for every new Goal domain.

Extend the existing `GoalContractInterpreter.interpret()` input with `goalDesignSkill: ResolvedGoalDesignSkillV1` and `workspaceDiscovery: WorkspaceGoalDiscoveryV1`. `interpretGoalContractWithLlm()` renders the resolved skill body/version and bounded discovery into its prompt before the current contract schema instructions. `preparePostgresGoalDesignDraft()` resolves the skill and captures discovery once, before interpretation, and passes those same immutable values to both the interpreter and `GoalDesigner.design()`. Zero or multiple approved `purpose: goal_design` skills fails before any Goal LLM call.

Use `contentHashForPayload()` for every hash. Package hashing covers the contract, evaluator/Slice/strategy values, Template policy, mode, skill ref/version, and `workspaceDiscoveryHash`. Validation returns typed issues and checks exact requirement ownership, evaluator refs, artifact-flow edges, cycles, unique slice ids, non-empty strategy rationale, strategy coverage exactly once, pinned Template fields, and package hash integrity.

Update `GoalContractV1` and its strict parser to include the existing `RequirementSpecV2["workType"]` enum. Delete `workTypeFromContract()` and project `contract.workType` directly. Remove the duplicate `PreviousGoalContract` prompt line while touching the function.

- [ ] **Step 5: Run focused tests and the Library file parser gate**

Run: `npx tsx tests/v2/goal-design.test.ts && npx tsx tests/v2/goal-workspace-discovery.test.ts && npx tsx tests/v2/goal-contract.test.ts && npx tsx tests/v2/library-file-store.test.ts`

Expected: PASS; the synced Goal Design skill has a non-null version ref, and no fixed graph-dynamic Template object is required.

- [ ] **Step 6: Commit Task 1**

```bash
git add library/skills/southstar-goal-design.skill.md src/v2/orchestration/goal-design.ts src/v2/orchestration/goal-workspace-discovery.ts src/v2/orchestration/goal-contract.ts tests/v2/goal-design.test.ts tests/v2/goal-workspace-discovery.test.ts tests/v2/goal-contract.test.ts tests/v2/index.test.ts
git commit -m "feat: add library-driven goal design contract"
```

---

### Task 2: Persist Goal Design Revisions And Default Review Gate

**Files:**
- Create: `src/v2/orchestration/goal-design-draft-service.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/orchestration/run-goal-service.ts`
- Modify: `src/v2/server/planner-routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `web/app/api/workflow/generate/route.ts`
- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/hooks/useAgentSession.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/run-goal-service.test.ts`
- Modify: `tests/v2/planner-draft-stream-route.test.ts`
- Modify: `tests/web/southstar-workflow-canvas-ui.test.tsx`

**Interfaces:**
- Consumes: Task 1 `GoalDesigner`, `GoalDesignPackageV1`, `goalDesignPackageHash()`, existing `upsertRuntimeResourcePg()`, and existing goal submission idempotency claim.
- Produces: `PostgresPlannerDraftStatus` additions, `persistGoalDesignPackageRevisionPg()`, `loadCurrentGoalDesignPackagePg()`, `preparePostgresGoalDesignDraft()`, and review-aware `RunGoalResult`.

- [ ] **Step 1: Write failing persistence and review-gate tests**

```ts
test("run-goal defaults to ready_for_review without composer or run rows", async () => {
  let composerCalls = 0;
  const result = await submitGoalPg({
    db,
    goalInterpreter: inlineGoalInterpreter(contractWithoutBlockers()),
    goalDesigner: inlineGoalDesigner(validPackage({ mode: "review_before_compose" })),
    composer: { async compose() { composerCalls += 1; throw new Error("composer must not run"); } },
  }, {
    goalPrompt: "Deliver the requested outcome",
    cwd: workspace,
    idempotencyKey: "review-default",
  });

  assert.equal(result.draftStatus, "ready_for_review");
  assert.equal(composerCalls, 0);
  assert.equal(result.runId, undefined);
  assert.match(result.goalDesignPackageHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await countRows(db, "southstar.workflow_runs"), 0);
});

test("Goal Design package revisions are immutable resources", async () => {
  await persistGoalDesignPackageRevisionPg(db, { draftId: "draft-1", package: packageRevision(1) });
  await persistGoalDesignPackageRevisionPg(db, { draftId: "draft-1", package: packageRevision(2, 1) });
  const rows = await listResourcesPg(db, { resourceType: "goal_design_package_revision" });
  assert.deepEqual(rows.map((row) => row.resourceKey).sort(), ["draft-1:revision:1", "draft-1:revision:2"]);
});
```

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx tsx tests/v2/run-goal-service.test.ts && npx tsx tests/v2/postgres-run-api.test.ts`

Expected: FAIL because the current service composes, creates a run, and auto-schedules immediately.

- [ ] **Step 3: Add immutable revision persistence and current projection**

Implement these exact functions in `goal-design-draft-service.ts`:

```ts
export async function persistGoalDesignPackageRevisionPg(
  db: SouthstarDb,
  input: { draftId: string; package: GoalDesignPackageV1 },
): Promise<void>;

export async function loadCurrentGoalDesignPackagePg(
  db: SouthstarDb,
  draftId: string,
): Promise<GoalDesignPackageV1>;

export async function preparePostgresGoalDesignDraft(
  db: SouthstarDb,
  input: {
    goalPrompt: string;
    cwd: string;
    mode: GoalDesignMode;
    templatePolicy: WorkflowTemplatePolicyV1;
    goalInterpreter: GoalContractInterpreter;
    goalDesigner: GoalDesigner;
    persistDraft?: (resource: RuntimeResourceUpsertInput) => Promise<void> | void;
    onProgress?: PlannerDraftProgressListener;
  },
): Promise<PostgresPlannerDraftResult>;
```

`preparePostgresGoalDesignDraft()` first calls `loadGoalDesignSkillPg()` and `discoverGoalWorkspace()`, then passes the same resolved skill/discovery values into `goalInterpreter.interpret()` and `goalDesigner.design()`. Persist the discovery hash with the package provenance. If interpretation returns blocking inputs, persist the `needs_input` contract draft plus skill/discovery provenance and stop before Slice generation. Do not run a separate embedded clarification prompt.

`persistGoalDesignPackageRevisionPg()` first reads the immutable revision key. If it exists with a different `packageHash`, throw `goal_design_revision_conflict`; if identical, return idempotently. The current `planner_draft.payload.goalDesignPackage` is a projection and may be updated only in the same transaction that inserts the immutable revision.

- [ ] **Step 4: Make review mode the external default**

Extend the existing request/result types exactly:

```ts
export type RunGoalRequest = {
  goalPrompt: string;
  cwd: string;
  idempotencyKey: string;
  goalDesignMode?: GoalDesignMode;
  templatePolicy?: WorkflowTemplatePolicyV1;
};

export type RunGoalResult = {
  goalDesignPackageHash?: string;
  goalContractHash: string;
  draftId: string;
  draftStatus: "needs_input" | "invalid" | "template_incompatible" | "ready_for_review" | "validated";
  runId?: string;
  runStatus?: "created" | "awaiting_approval" | "scheduling";
  approvalId?: string;
  blockers: string[];
  schedulerExceptionId?: string;
};
```

Add `ready_for_review` and `template_incompatible` to `PostgresPlannerDraftStatus`. `submitClaimedGoalPg()` calls `preparePostgresGoalDesignDraft()` first. Review mode persists the prepared draft and completed goal submission with stages `goal_design.persisted`, `draft.ready_for_review`, `done`; it does not call the composer, create run rows, create execution approval, or schedule.

For `needs_input`, persist the Goal Contract draft without a complete package and return before Goal Design. For `auto_until_blocked`, leave a single call to the shared composition continuation added in Task 3; do not duplicate its body here.

- [ ] **Step 5: Route the existing Workflow chat input through Goal Design**

Keep the current call chain intact:

```text
ChatWindow
  -> useAgentSession
  -> generateWorkflowDagStream
  -> POST /api/workflow/generate
  -> POST /api/v2/run-goal
```

Extend `generateWorkflowDagStream()` and the web proxy body with typed `goalDesignMode?: GoalDesignMode` and `templatePolicy?: WorkflowTemplatePolicyV1`. Remove `templateId` from this submission contract; `WorkflowSidebar` must resolve a selected approved template to `{ mode, templateRef, versionRef }` before submit. Forward these values unchanged to `/api/v2/run-goal`. Do not load or execute the Goal Design skill in Next.js or React code.

Update `planner-routes.ts`, web stream parsing, and client types so JSON and SSE finish with the same result. Emit existing `planner.stage` frames plus a `goal_design` frame and one `draft` frame containing the persisted package projection. `useAgentSession` treats a `ready_for_review` `done` event without any DAG as success; only confirmation or Auto is allowed to emit the existing DAG event. Do not add another stream implementation.

```ts
onStage?.("goal_design.persisted", {
  draftId: result.draftId,
  goalDesignPackageHash: result.goalDesignPackageHash,
  draftStatus: result.draftStatus,
});
```

Add a source-contract test in `tests/web/southstar-workflow-canvas-ui.test.tsx` proving `/api/workflow/generate` forwards `goalDesignMode` and `templatePolicy`, calls `/api/v2/run-goal`, and contains no Library skill execution/import.

- [ ] **Step 6: Run Task 2 tests**

Run: `npx tsx tests/v2/run-goal-service.test.ts && npx tsx tests/v2/postgres-run-api.test.ts && npx tsx tests/v2/planner-draft-stream-route.test.ts && npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: PASS; default review produces no composer call and no run row.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/v2/orchestration/goal-design-draft-service.ts src/v2/ui-api/postgres-run-api.ts src/v2/orchestration/run-goal-service.ts src/v2/server/planner-routes.ts src/v2/server/client.ts web/app/api/workflow/generate/route.ts web/lib/workflow/generate-stream.ts web/hooks/useAgentSession.ts tests/v2/postgres-run-api.test.ts tests/v2/run-goal-service.test.ts tests/v2/planner-draft-stream-route.test.ts tests/web/southstar-workflow-canvas-ui.test.tsx
git commit -m "feat: persist reviewable goal design packages"
```

---

### Task 3: Slice-Constrained Composition, Confirmation, And Auto

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/manifests/types.ts`
- Modify: `src/v2/manifests/validate.ts`
- Modify: `src/v2/orchestration/composer.ts`
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/orchestration/candidate-resolver.ts`
- Modify: `src/v2/orchestration/composition-repair-loop.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Modify: `src/v2/orchestration/goal-requirement-coverage.ts`
- Modify: `src/v2/runtime-revision/dynamic-repair-revision.ts`
- Modify: `src/v2/orchestration/run-goal-service.ts`
- Modify: `src/v2/orchestration/goal-design-draft-service.ts`
- Modify: `src/v2/server/planner-routes.ts`
- Modify: `tests/v2/llm-workflow-composer.test.ts`
- Modify: `tests/v2/workflow-composition-validator.test.ts`
- Modify: `tests/v2/workflow-composition-compiler.test.ts`
- Modify: `tests/v2/manifests.test.ts`
- Modify: `tests/v2/library-candidate-resolver.test.ts`
- Modify: `tests/v2/workflow-composer-registry.test.ts`
- Modify: `tests/v2/composition-repair-loop.test.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/runtime-dynamic-workflow-revision.test.ts`
- Modify: `tests/v2/run-goal-service.test.ts`

**Interfaces:**
- Consumes: Task 2 persisted package and existing resolver/composer/validator/compiler/run materialization pipeline.
- Produces: required `WorkflowCompositionTask.sliceId`, `ComposeWorkflowInput.goalDesignPackage`, `confirmGoalDesignPg()`, and one shared `continueGoalDesignToRunPg()` used by confirmation and Auto.

- [ ] **Step 1: Write failing slice-conformance and confirmation tests**

```ts
test("composer tasks must belong to the authoritative Slice Plan", async () => {
  const result = await validateWorkflowCompositionPlan(candidatePacket, composition({
    tasks: [compositionTask({ id: "task-a", sliceId: "slice-unknown", requirementIds: ["req-1"] })],
  }), { goalDesignPackage: validPackage() });
  assert.equal(result.issues.some((issue) => issue.code === "unknown_slice_id"), true);
});

test("confirmation composes the exact package hash and schedules once", async () => {
  const prepared = await prepareReviewDraft();
  const first = await confirmGoalDesignPg(context, {
    draftId: prepared.draftId,
    expectedPackageHash: prepared.goalDesignPackageHash!,
  });
  const replay = await confirmGoalDesignPg(context, {
    draftId: prepared.draftId,
    expectedPackageHash: prepared.goalDesignPackageHash!,
  });
  assert.equal(first.runId, replay.runId);
  assert.equal(first.runStatus, "scheduling");
  assert.equal(composerCalls, 1);
});

test("stale confirmation fails before composer invocation", async () => {
  await assert.rejects(
    () => confirmGoalDesignPg(context, { draftId, expectedPackageHash: "0".repeat(64) }),
    /goal_design_package_stale/,
  );
  assert.equal(composerCalls, 0);
});
```

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx tsx tests/v2/workflow-composition-validator.test.ts && npx tsx tests/v2/run-goal-service.test.ts`

Expected: FAIL because composition tasks do not carry `sliceId` and no confirmation command exists.

- [ ] **Step 3: Make Slice Plan authoritative for composition**

Add `sliceId: string` to `WorkflowCompositionTask` and `goalDesignPackage: GoalDesignPackageV1` to `ComposeWorkflowInput`. Render the full validated package into the composer prompt. Replace the current prompt sentences that ask the composer to partition requirements with these constraints:

```ts
const sliceConstraints = [
  "GoalDesignPackage is authoritative.",
  "Every producer, evaluator, repair, review, and summary task must name one existing sliceId.",
  "A task may use only requirementIds owned by its sliceId.",
  "Do not merge slices, move requirement ownership, or invent slice ids.",
  "A dependency is valid only when inputArtifactRefs consumes an upstream outputArtifactRef.",
  "If the Slice Plan cannot be compiled, return slice_plan_revision_required instead of rewriting it.",
];
```

Extend the JSON schema/parser to require `sliceId`. Validator codes must include:

```ts
type GoalDesignCompositionIssueCode =
  | "unknown_slice_id"
  | "requirement_not_owned_by_slice"
  | "slice_without_producer"
  | "slice_without_evaluator"
  | "producer_dependency_without_artifact_flow"
  | "slice_plan_revision_required";
```

Compiler writes `sliceId` and `requirementIds` into task `promptInputs`. Dynamic repair/reverify tasks inherit the failed task's `sliceId`; they do not run Goal Design again.

Goal Design evaluator/artifact contracts are host contracts, not Library selection candidates. Add deterministic compiler functions:

```ts
export function compileGoalDesignArtifactContracts(
  packageValue: GoalDesignPackageV1,
): ArtifactContract[];

export function compileGoalDesignEvaluatorPipelines(
  packageValue: GoalDesignPackageV1,
): EvaluatorPipelineDefinition[];
```

They map unique Slice `expectedArtifactRefs` and `RequirementEvaluatorContractV1` entries into run-scoped manifest contracts/pipelines, preserving ids, acceptance criteria, required evidence kinds, and failure classifications. Composition tasks may reference only these host contracts or approved Library candidates. Absence of Library `artifact_contract`/`evaluator_profile` objects is not an unavailable requirement when Goal Design supplies the contract; conflicting Library objects fail validation rather than override it. Add compiler/validator tests proving the manifest contains every Goal Design artifact/evaluator and no fixture graph object is needed.

Update `dynamic-repair-revision.ts` so generated repair/reverify tasks copy both `sliceId` and `requirementIds` from the failed task's prompt inputs. Add the regression to `runtime-dynamic-workflow-revision.test.ts`; a repair proposal that moves either field is rejected.

- [ ] **Step 4: Remove synthetic candidates and production scripted composer**

Delete `graphDynamicWorkflowTemplateCandidate()` and its synthetic graph metadata insertion. `resolveWorkflowCandidates()` returns only approved graph objects and exposes approved independent Agent/Skill/Tool/MCP/instruction primitives even when no template matches. `auto` and `prefer` may continue template-free when those primitives form an executable closure; record `selectedWorkflowTemplateRef: undefined` plus the selected primitive version refs. Only `require` returns `template_incompatible` when its pinned template is missing, stale, or incompatible.

Make template-free provenance explicit rather than inserting a sentinel ref:

```ts
export type WorkflowCompositionPlan = {
  schemaVersion: "southstar.workflow_composition_plan.v1";
  title: string;
  selectedWorkflowTemplateRef?: string;
  rationale: string;
  tasks: WorkflowCompositionTask[];
  rejectedCandidates: Array<{ ref: string; reason: string }>;
  generatedComponentProposals: GeneratedComponentProposal[];
};

export type CompiledFrom =
  | {
      sourceKind?: "workflow_template";
      templateDefinitionId: string;
      templateVersionId: string;
      recipeVersionId?: string;
      compilerVersion: string;
      inputHash: string;
      libraryVersionRefs: string[];
      libraryObjectVersionRefs: LibraryObjectVersionRef[];
    }
  | {
      sourceKind: "library_primitives";
      compilerVersion: string;
      inputHash: string;
      libraryVersionRefs: string[];
      libraryObjectVersionRefs: LibraryObjectVersionRef[];
    };
```

Change the manifest's `compiledFrom` field to `CompiledFrom`; keep omitted `sourceKind` valid only for existing template provenance that has both template ids. The LLM parser accepts an omitted `selectedWorkflowTemplateRef`. Composition validation requires it only for `templatePolicy.mode === "require"`; when present, it must resolve to an approved candidate/version. The compiler emits `sourceKind: "library_primitives"` with exact primitive refs when absent. Manifest validation rejects sentinel/empty template ids and rejects primitive provenance with template fields.

Move `ScriptedWorkflowComposer` out of `src/v2/orchestration/composer.ts`. Existing tests that still need a test double define it inline in their own test file; do not create a shared fixture module.

- [ ] **Step 5: Implement one continuation for confirm and Auto**

Add these exact public functions:

```ts
export async function confirmGoalDesignPg(
  context: SubmitGoalContext,
  input: { draftId: string; expectedPackageHash: string },
): Promise<RunGoalResult>;

export async function continueGoalDesignToRunPg(
  context: SubmitGoalContext,
  input: { draftId: string; expectedPackageHash: string; confirmationMode: "manual" | "auto" },
): Promise<RunGoalResult>;
```

Use a short transaction to compare/lock the package hash and persist a `goal_design_confirmation` resource with status `composing`. Run the LLM outside that transaction. In the final transaction, re-check the same package hash, persist the compiled planner draft, call existing `createPostgresRunFromDraft()`, create the existing execution approval, and request the existing scheduling handoff. A replay reads the confirmation resource and returns the same run result.

`submitClaimedGoalPg()` calls this same continuation only when `goalDesignMode === "auto_until_blocked"`. Do not keep the old validated-draft/run creation body in two places.

- [ ] **Step 6: Add the confirmation route**

Add `POST /api/v2/planner/drafts/:draftId/confirm-goal-design` with body:

```ts
type ConfirmGoalDesignRequest = { expectedPackageHash: string };
```

Return `409` for stale hash or a concurrent different confirmation and `202` while the same confirmation is composing. For JSON clients, return the existing `RunGoalResult` envelope when complete. When `Accept: text/event-stream`, reuse the planner/run-goal SSE adapter and emit persisted `planner.stage`, `goal_design`, `draft`, `run`, `goal_contract`, `approval`, `dag`, and `done` frames as applicable, ending `done` with the identical result envelope. Do not implement confirmation composition twice. Add route tests for both content types and for a review-to-DAG stream.

- [ ] **Step 7: Run Task 3 tests**

Run: `npx tsx tests/v2/llm-workflow-composer.test.ts && npx tsx tests/v2/workflow-composition-validator.test.ts && npx tsx tests/v2/workflow-composition-compiler.test.ts && npx tsx tests/v2/manifests.test.ts && npx tsx tests/v2/library-candidate-resolver.test.ts && npx tsx tests/v2/workflow-composer-registry.test.ts && npx tsx tests/v2/composition-repair-loop.test.ts && npx tsx tests/v2/runtime-dynamic-workflow-revision.test.ts && npx tsx tests/v2/postgres-run-api.test.ts && npx tsx tests/v2/run-goal-service.test.ts`

Expected: PASS; review confirmation and Auto use one continuation and only graph-backed candidates.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/v2/design-library/types.ts src/v2/manifests/types.ts src/v2/manifests/validate.ts src/v2/orchestration/composer.ts src/v2/orchestration/llm-composer.ts src/v2/orchestration/candidate-resolver.ts src/v2/orchestration/composition-repair-loop.ts src/v2/orchestration/composition-validator.ts src/v2/orchestration/composition-compiler.ts src/v2/orchestration/goal-requirement-coverage.ts src/v2/runtime-revision/dynamic-repair-revision.ts src/v2/orchestration/run-goal-service.ts src/v2/orchestration/goal-design-draft-service.ts src/v2/server/planner-routes.ts tests/v2/llm-workflow-composer.test.ts tests/v2/workflow-composition-validator.test.ts tests/v2/workflow-composition-compiler.test.ts tests/v2/manifests.test.ts tests/v2/library-candidate-resolver.test.ts tests/v2/workflow-composer-registry.test.ts tests/v2/composition-repair-loop.test.ts tests/v2/runtime-dynamic-workflow-revision.test.ts tests/v2/postgres-run-api.test.ts tests/v2/run-goal-service.test.ts
git commit -m "feat: compose confirmed goal slices"
```

---

### Task 4: Typed And Conversational Goal Design Revisions

**Files:**
- Modify: `src/v2/orchestration/goal-design.ts`
- Modify: `src/v2/orchestration/goal-design-draft-service.ts`
- Modify: `src/v2/server/planner-routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/app/api/workflow/planner-drafts/[draftId]/revise/stream/route.ts`
- Modify: `web/hooks/useAgentSession.ts`
- Modify: `tests/v2/goal-design.test.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/planner-draft-stream-route.test.ts`

**Interfaces:**
- Consumes: Task 2 immutable package resources and Task 3 confirmation invalidation.
- Produces: `reviseGoalSlicePg()`, `reviseGoalTemplatePolicyPg()`, and `reviseGoalDesignFromChatPg()` with one optimistic-concurrency and full-package validation seam.

- [ ] **Step 1: Write failing revision tests**

```ts
test("valid Slice edit creates one immutable package revision", async () => {
  const before = await loadCurrentGoalDesignPackagePg(db, draftId);
  const after = await reviseGoalSlicePg(db, {
    draftId,
    sliceId: before.slicePlan.slices[0]!.id,
    expectedPackageHash: before.packageHash,
    patch: { outcome: "deliver the accepted artifact" },
  });
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.parentRevision, before.revision);
  assert.notEqual(after.packageHash, before.packageHash);
});

test("invalid and stale Slice edits create no revision", async () => {
  await assert.rejects(
    () => reviseGoalSlicePg(db, {
      draftId,
      sliceId,
      expectedPackageHash: currentHash,
      patch: { dependsOnSliceIds: [sliceId] },
    }),
    /dependency_cycle/,
  );
  await assert.rejects(
    () => reviseGoalSlicePg(db, { draftId, sliceId, expectedPackageHash: "stale", patch: { outcome: "x" } }),
    /goal_design_package_stale/,
  );
  assert.equal(await countGoalDesignRevisions(db, draftId), 1);
});

test("review chat revises the complete package without composing", async () => {
  const before = await loadCurrentGoalDesignPackagePg(db, draftId);
  const result = await reviseGoalDesignFromChatPg(context, {
    draftId,
    expectedPackageHash: before.packageHash,
    message: "separate the audit artifact into its own outcome boundary",
    selectedSliceId: before.slicePlan.slices[0]!.id,
  });
  assert.equal(result.kind, "revision");
  if (result.kind !== "revision") assert.fail("expected a revision");
  assert.equal(result.package.revision, before.revision + 1);
  assert.equal(result.draftStatus, "ready_for_review");
  assert.equal(composerCalls, 0);
  assert.equal(await countRows(db, "southstar.workflow_runs"), 0);
});

test("review chat clarification leaves the package unchanged", async () => {
  const before = await loadCurrentGoalDesignPackagePg(db, draftId);
  const result = await reviseGoalDesignFromChatPg(contextWithClarifyingDesigner, {
    draftId,
    expectedPackageHash: before.packageHash,
    message: "change it",
  });
  assert.deepEqual(result, { kind: "needs_input", question: "Which outcome boundary should change?" });
  assert.equal((await loadCurrentGoalDesignPackagePg(db, draftId)).packageHash, before.packageHash);
});
```

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx tsx tests/v2/goal-design.test.ts && npx tsx tests/v2/postgres-run-api.test.ts`

Expected: FAIL because typed package revision commands do not exist.

- [ ] **Step 3: Implement typed revisions**

```ts
export type GoalSlicePatchV1 = Partial<Pick<GoalSliceV1,
  | "outcome"
  | "requirementIds"
  | "stateOrArtifactOwner"
  | "mutationBoundary"
  | "expectedArtifactRefs"
  | "evaluatorContractRefs"
  | "dependsOnSliceIds"
  | "dependencyArtifactRefs"
  | "mergeReason"
>>;

export async function reviseGoalSlicePg(
  db: SouthstarDb,
  input: { draftId: string; sliceId: string; expectedPackageHash: string; patch: GoalSlicePatchV1 },
): Promise<GoalDesignPackageV1>;

export async function reviseGoalTemplatePolicyPg(
  db: SouthstarDb,
  input: { draftId: string; expectedPackageHash: string; templatePolicy: WorkflowTemplatePolicyV1 },
): Promise<GoalDesignPackageV1>;

export type GoalDesignChatRevisionResult =
  | {
      kind: "revision";
      draftStatus: "ready_for_review";
      package: GoalDesignPackageV1;
      summary: string;
      changedSliceIds: string[];
    }
  | { kind: "needs_input"; question: string };

export async function reviseGoalDesignFromChatPg(
  context: SubmitGoalContext,
  input: {
    draftId: string;
    expectedPackageHash: string;
    message: string;
    selectedSliceId?: string;
  },
): Promise<GoalDesignChatRevisionResult>;
```

Both commands lock the current planner draft, compare `expectedPackageHash`, reject any materialized run, build a complete next package, validate the complete package, insert one immutable revision, update the draft projection to `ready_for_review`, and mark prior non-terminal confirmation/composition resources stale. No field-level partial write happens before validation succeeds.

`reviseGoalDesignFromChatPg()` uses the same approved skill/version stored in the current package. Its prompt contains the current complete package, the user message, and optional selected-Slice focus. The LLM returns either a complete proposed package or one clarification question. A proposed package goes through `finalizeGoalDesignPackage()` and the same locked persistence seam as typed edits; a clarification writes no package revision. The LLM may update multiple affected Slices, evaluators, or strategy, but it cannot change Template policy, `goalContract.workspace.cwd`, skill provenance, mode, or revision ancestry supplied by the host. Template policy remains the typed PATCH/editor path.

- [ ] **Step 4: Deepen the existing draft revise stream and add two PATCH routes**

When `POST /api/v2/planner/drafts/:draftId/revise/stream` loads a persisted `ready_for_review` draft with no materialized run, dispatch to `reviseGoalDesignFromChatPg()` instead of DAG revision/composition. Its request body carries `prompt`, `expectedPackageHash`, and optional `selectedSliceId`; its SSE response emits assistant text plus either the new `goal_design`/`draft` projection or a clarification message. For a validated/materialized workflow, preserve the existing workflow-revision behavior. The server selects the path only from persisted lifecycle state, not prompt keywords.

Deepen the existing Next revise-stream proxy so it passes the new request fields and forwards `goal_design` frames in addition to the existing frame whitelist. Do not add a second revise route.

Extend the existing `generateWorkflowDagStream({ draftId })` branch to send the displayed package hash and selected Slice id. A `409` stale hash reloads server truth; a successful Goal Design steering turn must not require or emit a DAG.

Add the two typed routes:

Add:

```text
PATCH /api/v2/planner/drafts/:draftId/goal-design/slices/:sliceId
PATCH /api/v2/planner/drafts/:draftId/goal-design/template-policy
```

Both return `409` for stale hash, `422` with typed field/plan issues for invalid changes, and `200` with the new package for success.

- [ ] **Step 5: Run Task 4 tests**

Run: `npx tsx tests/v2/goal-design.test.ts && npx tsx tests/v2/postgres-run-api.test.ts && npx tsx tests/v2/planner-draft-stream-route.test.ts && npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: PASS; stale/invalid edits create no revision, chat discussion creates one validated revision or one no-write clarification, and no confirmation survives a valid edit.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/v2/orchestration/goal-design.ts src/v2/orchestration/goal-design-draft-service.ts src/v2/server/planner-routes.ts src/v2/server/client.ts web/lib/workflow/generate-stream.ts 'web/app/api/workflow/planner-drafts/[draftId]/revise/stream/route.ts' web/hooks/useAgentSession.ts tests/v2/goal-design.test.ts tests/v2/postgres-run-api.test.ts tests/v2/planner-draft-stream-route.test.ts tests/web/southstar-workflow-canvas-ui.test.tsx
git commit -m "feat: revise goal design through chat"
```

---

### Task 5: Workflow Template Compatibility And Proposal-Only Save

**Files:**
- Modify: `src/v2/workflow-templates/template-api-service.ts`
- Modify: `src/v2/server/workflow-template-routes.ts`
- Modify: `src/v2/server/library-routes.ts`
- Modify: `src/v2/design-library/templates/workflow-template-save-service.ts`
- Modify: `web/lib/workflow/template-save.ts`
- Modify: `web/app/api/workflow/library/route.ts`
- Modify: `tests/v2/workflow-template-api-service.test.ts`
- Modify: `tests/v2/workflow-template-routes.test.ts`
- Modify: `tests/v2/workflow-template-save-service.test.ts`
- Modify: `tests/unit/workflow-library.test.ts`

**Interfaces:**
- Consumes: Task 4 `WorkflowTemplatePolicyV1` command and existing search/detail/save-template services.
- Produces: one compatibility adapter into `/run-goal`, real Auto/Prefer/Require policy, and draft/proposal-only browser save.

- [ ] **Step 1: Write failing compatibility and save-state tests**

```ts
test("template instantiate delegates to Goal Design instead of interpreting again", async () => {
  const result = await instantiateWorkflowTemplatePg(db, {
    templateRef,
    goalPrompt: "Deliver the outcome",
    cwd,
    mode: "adaptive",
    submitGoal: async (request) => {
      assert.deepEqual(request.templatePolicy, { mode: "prefer", templateRef, versionRef });
      return readyForReviewResult;
    },
  });
  assert.equal(result.draftId, readyForReviewResult.draftId);
  assert.equal(interpreterCalls, 0);
});

test("browser Save Template cannot request approved state", () => {
  const request = buildWorkflowTemplateSaveRequest({ draftId, dag, scope: "design/article" });
  assert.equal(request.body.status, "draft");
  assert.equal(request.body.scope, "design/article");
});
```

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx tsx tests/v2/workflow-template-api-service.test.ts && npx tsx tests/v2/workflow-template-save-service.test.ts && npx tsx tests/unit/workflow-library.test.ts`

Expected: FAIL because explicit instantiate reinterprets the goal and browser save requests `approved` with a software default.

- [ ] **Step 3: Convert instantiate to a compatibility adapter**

Keep search and detail unchanged. Map old modes only:

```ts
const templatePolicy: WorkflowTemplatePolicyV1 = input.constraints?.mode === "strict"
  ? { mode: "require", templateRef: template.objectKey, versionRef: template.headVersionId! }
  : { mode: "prefer", templateRef: template.objectKey, versionRef: template.headVersionId! };
```

Call the same Goal submission service with this structured policy. Delete the independent `memoizeGoalInterpreter()`, `instantiateSavedCompositionPlan()`, and direct `createPostgresPlannerDraft()` path after their callers are migrated. A pinned version mismatch fails before the composer.

- [ ] **Step 4: Implement policy semantics in candidate resolution**

For `auto`, rank approved domain/global templates and primitives deterministically; absence of a compatible template is not an error when the independent primitive closure is executable. For `prefer`, put the exact version first; when validation rejects it, persist `template_fallback` with the issue list and continue with another compatible template or template-free primitive composition. For `require`, reject incompatibility as `template_incompatible` and do not call fallback composition.

Do not parse `@workflow-template` text as authority. The structured `templatePolicy` field is the only runtime truth.

- [ ] **Step 5: Remove browser approval and software defaults**

Change the request contract to:

```ts
export type WorkflowTemplateSaveRequest = {
  url: string;
  body: { scope: string; templateId: string; title: string; status: "draft" };
};
```

Require scope from the Goal Design Package/DAG mission; do not default to `software`. Change `workflowTemplateSaveStatus()` so omitted or browser-supplied status resolves to `draft`. Approval remains a separate existing Library lifecycle command. Keep `libraryVersionRefs` validation in `saveWorkflowTemplateDraft()`.

Accept both Task 3 provenance variants when saving: template-backed DAGs may retain their source Template ref as lineage metadata; template-free DAGs derive the new draft solely from the compiled tasks/profiles and exact `libraryObjectVersionRefs`. Saving must not require or synthesize a source Template id.

- [ ] **Step 6: Run Task 5 tests**

Run: `npx tsx tests/v2/workflow-template-api-service.test.ts && npx tsx tests/v2/workflow-template-routes.test.ts && npx tsx tests/v2/workflow-template-save-service.test.ts && npx tsx tests/unit/workflow-library.test.ts`

Expected: PASS; no explicit template route reinterprets the Goal and no browser path approves a template.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/v2/workflow-templates/template-api-service.ts src/v2/server/workflow-template-routes.ts src/v2/server/library-routes.ts src/v2/design-library/templates/workflow-template-save-service.ts web/lib/workflow/template-save.ts web/app/api/workflow/library/route.ts tests/v2/workflow-template-api-service.test.ts tests/v2/workflow-template-routes.test.ts tests/v2/workflow-template-save-service.test.ts tests/unit/workflow-library.test.ts
git commit -m "fix: route templates through goal design"
```

---

### Task 6: Same-Cwd Per-Slice Runs And Goal Execution Set

**Files:**
- Create: `src/v2/orchestration/goal-execution-set.ts`
- Create: `tests/v2/goal-execution-set.test.ts`
- Create: `tests/v2/run-library-snapshot.test.ts`
- Create: `tests/v2/postgres-approval-service.test.ts`
- Modify: `src/v2/orchestration/goal-design-draft-service.ts`
- Modify: `src/v2/orchestration/run-library-snapshot.ts`
- Modify: `src/v2/orchestration/run-goal-service.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/evaluators/completion-gate.ts`
- Modify: `src/v2/executor/postgres-tork-callback.ts`
- Modify: `src/v2/approvals/postgres-approval-service.ts`
- Modify: `src/v2/context/managed-context-assembler.ts`
- Modify: `src/v2/read-models/workflow-ui.ts`
- Modify: `web/app/api/workflow/generate/route.ts`
- Modify: `tests/v2/run-goal-service.test.ts`
- Modify: `tests/v2/completion-gate.test.ts`
- Modify: `tests/v2/postgres-tork-callback.test.ts`
- Create: `tests/v2/postgres-approval-service.test.ts`
- Modify: `tests/v2/managed-context-assembler.test.ts`
- Create: `tests/v2/run-library-snapshot.test.ts`
- Modify: `tests/v2/index.test.ts`

**Interfaces:**
- Consumes: validated `CompositionStrategyV1.mode === "per-slice-runs"`, Task 3 Slice-constrained composer, existing run/task/snapshot/approval materialization, `startRunSchedulingPg()`, terminal callback completion, and per-run goal outcomes.
- Produces: `GoalExecutionSetV1`, `materializeGoalExecutionSetPg()`, `advanceGoalExecutionSetPg()`, and `evaluateGoalExecutionSetOutcomePg()` without parent/child runs.

- [ ] **Step 1: Write failing execution-set tests**

```ts
test("per-slice-runs creates one ordinary run per Slice in the same cwd", async () => {
  const executionSet = await materializeGoalExecutionSetPg(context, {
    draftId,
    expectedPackageHash,
  });
  assert.equal(executionSet.entries.length, packageValue.slicePlan.slices.length);
  assert.deepEqual(new Set(executionSet.entries.map((entry) => entry.sliceId)), new Set(packageValue.slicePlan.slices.map((slice) => slice.id)));
  for (const entry of executionSet.entries) {
    const run = await db.one<{ runtime_context_json: Record<string, unknown> }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [entry.runId],
    );
    assert.equal(run.runtime_context_json.projectRoot, packageValue.goalContract.workspace.cwd);
    assert.equal(run.runtime_context_json.goalExecutionSetId, executionSet.id);
    assert.equal(run.runtime_context_json.sliceId, entry.sliceId);
    assert.equal(run.runtime_context_json.parentRunId, undefined);
  }
});

test("same-cwd Slice runs launch serially in dependency order", async () => {
  const first = await advanceGoalExecutionSetPg(db, { executionSetId });
  assert.equal(first.startedRunIds.length, 1);
  const blocked = await advanceGoalExecutionSetPg(db, { executionSetId });
  assert.deepEqual(blocked.startedRunIds, []);
  await persistSatisfiedOutcomeAndArtifacts(db, first.startedRunIds[0]!);
  const second = await advanceGoalExecutionSetPg(db, { executionSetId });
  assert.equal(second.startedRunIds.length, 1);
  assert.notEqual(second.startedRunIds[0], first.startedRunIds[0]);
});

test("execution-set outcome requires every Slice run evaluator outcome", async () => {
  const outcome = await evaluateGoalExecutionSetOutcomePg(db, { executionSetId });
  assert.equal(outcome.status, "satisfied");
  assert.equal(outcome.runOutcomeRefs.length, packageValue.slicePlan.slices.length);
});

test("downstream Slice context receives only accepted declared upstream artifacts", async () => {
  await advanceGoalExecutionSetPg(db, { executionSetId });
  const { contextPacket } = await createManagedContextAssembler(db).buildForTask(
    managedContextInput({ runId: downstreamRunId, taskId: downstreamTaskId }),
  );
  assert.equal(contextPacket.priorArtifacts.some((artifact) => artifact.sourceRef === declaredDependencyArtifactRef), true);
  assert.equal(contextPacket.priorArtifacts.some((artifact) => artifact.sourceRef === undeclaredArtifactRef), false);
});
```

- [ ] **Step 2: Run focused tests and confirm red**

Run: `npx tsx tests/v2/goal-execution-set.test.ts && npx tsx tests/v2/run-goal-service.test.ts && npx tsx tests/v2/completion-gate.test.ts`

Expected: FAIL because no execution-set resource or per-Slice materialization exists.

- [ ] **Step 3: Implement exact non-hierarchical contracts**

```ts
export type GoalExecutionSetEntryV1 = {
  sliceId: string;
  runId: string;
  manifestHash: string;
  librarySnapshotHash: string;
  approvalId: string;
  dependsOnSliceIds: string[];
  dependencyArtifactRefs: string[];
  status: "created" | "awaiting_approval" | "scheduling" | "running" | "terminal" | "blocked";
};

export type GoalExecutionSetV1 = {
  schemaVersion: "southstar.goal_execution_set.v1";
  id: string;
  draftId: string;
  goalDesignPackageHash: string;
  cwd: string;
  launchOrder: string[];
  entries: GoalExecutionSetEntryV1[];
  status: "created" | "running" | "terminal";
};

export async function materializeGoalExecutionSetPg(
  context: SubmitGoalContext,
  input: { draftId: string; expectedPackageHash: string },
): Promise<GoalExecutionSetV1>;

export type ValidatedRunMaterializationBundleV1 = {
  draftId: string;
  sliceId?: string;
  goalDesignPackageHash: string;
  goalContract: GoalContractV1;
  manifest: SouthstarWorkflowManifest;
  manifestHash: string;
  coverage: GoalRequirementCoverageV1;
  libraryObjectVersionRefs: LibraryObjectVersionRef[];
  approvalInput: {
    decisionMode: "auto" | "manual";
    policyReason: string;
    riskTags: string[];
    requestedSideEffects: string[];
  };
};

export async function insertPostgresRunFromValidatedBundleTx(
  tx: SouthstarDb,
  input: ValidatedRunMaterializationBundleV1,
): Promise<{ runId: string; approvalId: string; runStatus: "created" | "awaiting_approval" }>;

export async function advanceGoalExecutionSetPg(
  db: SouthstarDb,
  input: { executionSetId: string },
): Promise<{ startedRunIds: string[]; waitingSliceIds: string[] }>;
```

Extract the existing run/task/history/resource/approval inserts from `createPostgresRunFromDraft()` into `insertPostgresRunFromValidatedBundleTx()`. The existing function remains the public single-run adapter: it loads the one planner draft, builds one validated bundle, opens a transaction, and calls the extracted seam. The Tx helper must not re-read a planner-draft manifest or open a nested transaction.

Export the existing `captureRunLibrarySnapshotInTransaction()` as the public Tx-level snapshot seam without changing its validation semantics. Add `run-library-snapshot.test.ts` proving it requires an already inserted run, writes one immutable snapshot, rejects stale refs, and participates in the caller transaction rollback.

Compose every Slice separately before run insertion. Each composer input contains the full Goal Contract/evaluator context but exactly one Slice; validation rejects tasks with any other `sliceId`. Build one complete `ValidatedRunMaterializationBundleV1` per Slice in memory and preflight the manifest, coverage, workspace, version refs, and approval input. In the single transaction, `insertPostgresRunFromValidatedBundleTx()` inserts the run first, calls existing `captureRunLibrarySnapshotInTransaction()` with the bundle refs, derives the hash-bound approval payload from the returned snapshot, then inserts tasks/history/resources/approval. Any stale ref or snapshot failure rolls back every Slice run and the execution set. This avoids constructing a `RunLibrarySnapshotV1` before its run exists and avoids pretending that the planner draft contains multiple current manifests. No run receives `parentRunId` or `childRunId`.

Deepen the Task 3 shared continuation at one branch point only: `single-run` keeps the existing one-compose/`createPostgresRunFromDraft()` path; `per-slice-runs` calls `materializeGoalExecutionSetPg()`. Confirmation and Auto still call the same continuation, and idempotent replay returns the same single run or the same execution-set/run ids without recomposition.

Derive `launchOrder` by topologically sorting Slice dependencies with `sliceId` as the stable tie-break. `advanceGoalExecutionSetPg()` starts at most one run through existing `startRunSchedulingPg()` because all entries share a writable `cwd`. It locks the execution-set resource, is idempotent, and requires every upstream execution-set entry to have a persisted `satisfied` goal outcome and every `dependencyArtifactRef` to resolve to an accepted artifact before starting the next run.

Before scheduling a downstream run, persist one run-scoped `goal_dependency_artifact_ref` runtime resource per declared cross-run artifact. Its payload contains `executionSetId`, `sourceSliceId`, `sourceRunId`, `artifactRef`, source artifact/blob identity, acceptance resource ref, and content hash; it never copies or rewrites artifact content. Extend `managed-context-assembler.ts` to resolve these persisted refs, verify source run membership, accepted state, and content hash, then include the source artifact body in the existing `priorArtifacts` TaskEnvelope field. Missing, rejected, foreign-execution-set, or hash-mismatched refs fail before scheduling/dispatch.

Call `advanceGoalExecutionSetPg()` once after the materialization transaction commits to start the first eligible run. In `ingestTaskRunResultPg()`, after `evaluateRunCompletionGatePg()` has persisted a terminal `goal_outcome` and the callback transaction has committed, detect `runtime_context_json.goalExecutionSetId` and call the same advance function. Duplicate Tork callbacks and repeated advancement must not start a second run or append duplicate scheduling history. Do not advance from terminal task status alone.

Change `decideApprovalPg()` so an approved run with `runtime_context_json.goalExecutionSetId` never calls `startRunSchedulingPg()` directly. It persists the normal approval decision, commits, then calls `advanceGoalExecutionSetPg()` for that set; the serial/dependency gate decides whether any run may start. Add a regression where approving a later Slice before its upstream outcome leaves it non-scheduling, and approving/replaying the eligible Slice starts at most one run.

- [ ] **Step 4: Aggregate outcome from normal run outcomes**

```ts
export type GoalExecutionSetOutcomeV1 = {
  schemaVersion: "southstar.goal_execution_set_outcome.v1";
  executionSetId: string;
  goalDesignPackageHash: string;
  status: "in_progress" | "satisfied" | "unsatisfied" | "needs_input";
  runOutcomeRefs: string[];
  failedSliceIds: string[];
  blockedSliceIds: string[];
};

export async function evaluateGoalExecutionSetOutcomePg(
  db: SouthstarDb,
  input: { executionSetId: string },
): Promise<GoalExecutionSetOutcomeV1>;
```

Read each run's persisted `goal_outcome`; never infer success from terminal run state. Persist one `goal_execution_set_outcome` resource keyed by execution-set id. A failed/blocked upstream run prevents downstream launch and determines the aggregate outcome.

`advanceGoalExecutionSetPg()` calls `evaluateGoalExecutionSetOutcomePg()` under the same execution-set lock before choosing a launch and again after any entry status refresh. If an upstream outcome is `unsatisfied` or `needs_input`, deterministically mark every not-started transitive dependent entry `blocked`, cancel its still-created ordinary run through the existing lifecycle write/history seam, and never fabricate a `goal_outcome` for it. The aggregate becomes terminal when no runnable or in-flight entry remains—not only when every run has an outcome. It derives `failedSliceIds` from actual unsatisfied outcomes, `blockedSliceIds` from execution-set dependency state, and `runOutcomeRefs` only from outcomes that really exist. Persist the aggregate outcome, change the execution set to `terminal`, and start no run. Replays return the same resource/hash and append no duplicate block/cancel/terminal history.

Add a regression with one upstream failure and at least one transitive dependent: the dependent run never schedules, its execution-set entry is `blocked`, its run is cancelled with the execution-set reason, and the set reaches terminal `unsatisfied` without waiting for a nonexistent downstream outcome.

- [ ] **Step 5: Extend RunGoalResult for per-Slice runs**

```ts
export type SliceRunResult = {
  sliceId: string;
  runId: string;
  runStatus: "created" | "awaiting_approval" | "scheduling";
  approvalId: string;
};
```

Add optional `executionSetId` and `sliceRuns: SliceRunResult[]` to `RunGoalResult`. `single-run` keeps the existing top-level `runId`; `per-slice-runs` omits top-level `runId` and returns the execution set plus all Slice runs. Confirmation replay returns the same ids.

- [ ] **Step 6: Run Task 6 tests**

Run: `npx tsx tests/v2/goal-execution-set.test.ts && npx tsx tests/v2/run-library-snapshot.test.ts && npx tsx tests/v2/run-goal-service.test.ts && npx tsx tests/v2/completion-gate.test.ts && npx tsx tests/v2/postgres-tork-callback.test.ts && npx tsx tests/v2/postgres-approval-service.test.ts && npx tsx tests/v2/managed-context-assembler.test.ts && npx tsx tests/v2/workflow-ui-read-model.test.ts`

Expected: PASS; one ordinary run exists per Slice, all share one `cwd`, only one is started at a time, and aggregate outcome comes from evaluator evidence.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/v2/orchestration/goal-execution-set.ts src/v2/orchestration/goal-design-draft-service.ts src/v2/orchestration/run-library-snapshot.ts src/v2/orchestration/run-goal-service.ts src/v2/ui-api/postgres-run-api.ts src/v2/evaluators/completion-gate.ts src/v2/executor/postgres-tork-callback.ts src/v2/approvals/postgres-approval-service.ts src/v2/context/managed-context-assembler.ts src/v2/read-models/workflow-ui.ts tests/v2/goal-execution-set.test.ts tests/v2/run-library-snapshot.test.ts tests/v2/run-goal-service.test.ts tests/v2/completion-gate.test.ts tests/v2/postgres-tork-callback.test.ts tests/v2/postgres-approval-service.test.ts tests/v2/managed-context-assembler.test.ts tests/v2/index.test.ts
git commit -m "feat: execute slices as same-workspace runs"
```

---

### Task 7: Goal Message, Slice Viewer/Editor, And Template Policy UI

**Files:**
- Create: `web/components/GoalSlicePlan.tsx`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/confirm-goal-design/route.ts`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/goal-design/slices/[sliceId]/route.ts`
- Create: `web/app/api/workflow/planner-drafts/[draftId]/goal-design/template-policy/route.ts`
- Modify: `src/v2/read-models/workflow-ui.ts`
- Modify: `web/lib/workflow/types.ts`
- Modify: `web/lib/workflow/v2-library-adapter.ts`
- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/lib/types.ts`
- Modify: `web/lib/agent-session-engine.ts`
- Modify: `web/hooks/useAgentSession.ts`
- Modify: `web/components/MessageView.tsx`
- Modify: `web/components/ChatWindow.tsx`
- Modify: `web/components/GoalContractCard.tsx`
- Modify: `web/components/GoalContractInspector.tsx`
- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/WorkflowSidebar.tsx`
- Modify: `tests/v2/workflow-ui-read-model.test.ts`
- Modify: `tests/web/southstar-workflow-canvas-ui.test.tsx`
- Modify: `tests/e2e/workflow-mode.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–6 read models/routes, the existing `workflowGoalContract` sidecar tab, and existing single-run DAG selection/rendering.
- Produces: `GoalDesignContent`, selectable Slice rows, conversational steering focus, typed Slice/Template saves, review confirmation, execution-set Slice status, and one unchanged post-confirmation `WorkflowDagBlock` at a time.

- [ ] **Step 1: Write failing read-model and UI tests**

```tsx
test("Goal Design reuses the existing message and Goal Contract sidecar", () => {
  const messageView = source("web/components/MessageView.tsx");
  const appShell = source("web/components/AppShell.tsx");
  const goalCard = source("web/components/GoalContractCard.tsx");
  assert.match(messageView, /goalDesign/);
  assert.match(goalCard, /GoalSlicePlan/);
  assert.match(appShell, /workflowGoalContract/);
  assert.doesNotMatch(appShell, /goalDesignWorkbench|goalDesignSidecar|sliceDagCanvas/);
});

test("Goal Design chat sends the current package hash and optional Slice focus", () => {
  const streamSource = source("web/lib/workflow/generate-stream.ts");
  const sessionSource = source("web/hooks/useAgentSession.ts");
  assert.match(streamSource, /expectedPackageHash/);
  assert.match(streamSource, /selectedSliceId/);
  assert.match(sessionSource, /goalDesignPackageHash/);
  assert.doesNotMatch(sessionSource, /classifySliceIntent|slicePromptKeyword/);
});

test("review-only Goal messages retain the draft id and confirmation handler", () => {
  const engineSource = source("web/lib/agent-session-engine.ts");
  const sessionSource = source("web/hooks/useAgentSession.ts");
  assert.match(engineSource, /goalDesign.*draftId|draftId.*goalDesign/s);
  assert.match(sessionSource, /confirmGoalDesign/);
  assert.match(sessionSource, /confirm-goal-design/);
});
```

Also add this case beside the existing mocked-SSE test, using its current fetch restore pattern:

```ts
test("ready_for_review stream completes with Goal Design and no DAG", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response([
    'event: goal_design\ndata: {"goalDesign":{"draftId":"draft-1","status":"ready_for_review","packageHash":"abc"}}\n\n',
    'event: draft\ndata: {"draft":{"draftId":"draft-1","status":"ready_for_review"}}\n\n',
    "event: done\ndata: {}\n\n",
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  try {
    let designHash: string | undefined;
    let dagSeen = false;
    await generateWorkflowDagStream({
      prompt: "deliver the outcome",
      cwd: "/workspace",
      onGoalDesign: (design) => { designHash = design.packageHash; },
      onDag: () => { dagSeen = true; },
    });
    assert.equal(designHash, "abc");
    assert.equal(dagSeen, false);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run UI tests and confirm red**

Run: `npx tsx tests/v2/workflow-ui-read-model.test.ts && npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: FAIL because the message model has no `goalDesign` content and completion without a DAG is treated as an error.

- [ ] **Step 3: Project Goal Design through the existing read model**

Extend `GoalMissionReadModel` with:

```ts
type GoalDesignReadModel = {
  draftId: string;
  status: "needs_input" | "template_incompatible" | "ready_for_review" | "composing" | "validated";
  packageHash?: string;
  revision?: number;
  mode: GoalDesignMode;
  evaluatorContracts: RequirementEvaluatorContractV1[];
  slicePlan?: GoalSlicePlanV1;
  compositionStrategy?: CompositionStrategyV1;
  templatePolicy: WorkflowTemplatePolicyV1;
  templateFallbackReason?: string;
  executionSet?: {
    id: string;
    status: "created" | "running" | "terminal";
    entries: Array<{
      sliceId: string;
      runId: string;
      entryStatus: "created" | "awaiting_approval" | "scheduling" | "running" | "terminal" | "blocked";
      runStatus: string;
      outcomeStatus?: "in_progress" | "satisfied" | "unsatisfied" | "needs_input";
    }>;
  };
  editable: boolean;
};
```

Read only persisted resources. Do not reconstruct Slice Plan from DAG nodes.

- [ ] **Step 4: Render Goal Design as a message block**

Add `GoalDesignContent` to `web/lib/types.ts` and dispatch it in `MessageView.BlockView`. `useAgentSession` stores the `goal_design` SSE payload and treats `ready_for_review` without a DAG as a successful message. After confirmation, append the existing `workflowDag` block to the same message; do not modify canvas layout.

Extend `latestWorkflowDraftId()` in `web/lib/agent-session-engine.ts` to read `goalDesign.draftId` before falling back to `workflowDag.draftId`. This keeps the existing `generateWorkflowDagStream({ draftId })` steering path available before any DAG exists.

Create `GoalSlicePlan` as semantic buttons with `aria-pressed`, keyboard focus, outcome text, requirement count, artifact refs, dependency count, and linked ordinary-run status when an execution set exists. It owns no sidecar state.

- [ ] **Step 5: Reuse the existing sidecar tab and editor pattern**

Keep sidecar kind `workflowGoalContract`; add optional `sliceId` to the existing tab payload. Extend `GoalContractInspector` with view/edit/reset/save states. Save sends:

```ts
await fetch(`/api/workflow/planner-drafts/${encodeURIComponent(draftId)}/goal-design/slices/${encodeURIComponent(sliceId)}`, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ expectedPackageHash, patch }),
});
```

On success dispatch `southstar:planner-draft-updated`; on `409`, reload server truth and keep the user-visible conflict; on `422`, render field/plan issues beside the editor. Once a run exists or mode is Auto, render read-only.

The selected `sliceId` is also optional steering focus for the existing chat input. `useAgentSession` sends it with `expectedPackageHash` only while the draft is `ready_for_review`; clearing selection omits it. The runtime may revise other affected Slices after full-package validation, so the UI labels this as focus, not scope or authority.

Each new web route is a thin proxy built with the same `buildWorkflowV2Url()` and response pass-through pattern as the existing planner-draft validate/revise routes. It forwards method, path params, JSON body, status, and content type; it contains no Goal Design business rules.

Add this public wrapper beside the private stream parser:

```ts
export async function confirmGoalDesignStream(input: {
  draftId: string;
  expectedPackageHash: string;
  signal?: AbortSignal;
} & WorkflowGenerateStreamHandlers): Promise<void>;
```

It posts `{ expectedPackageHash }` to the new confirm proxy with `Accept: text/event-stream` and internally reuses `readWorkflowEventStream()`; the private parser is not imported by React hooks. Implement `confirmGoalDesign()` in `useAgentSession` with this wrapper and expose it through the existing `ChatWindow`/Goal card callback chain. Runtime confirmation uses the same planner SSE utilities as `/run-goal`, so the returned `goal_design`, `draft`, `run`, `goal_contract`, `approval`, `dag`, and `done` frames update the existing assistant message in place. Disable the action while the same hash is composing; `202` polls/reconnects the same confirmation and `409` reloads the current package.

Update the web run-goal receipt adapter for both result shapes. For `single-run`, keep `result.runId`. For `per-slice-runs`, emit the execution-set projection and choose the first eligible entry in persisted `launchOrder` as the selected ordinary run; never invent an execution-set DAG. Fetch `/api/v2/ui/workflow?runId=...` for that run and build its DAG through a new `buildWorkflowDagFromRunReadModel()` in `web/lib/workflow/v2-library-adapter.ts`. Do not call `buildWorkflowDagFromPlannerDraft()` with a per-Slice manifest that is not the draft's current manifest.

- [ ] **Step 6: Add Template policy to the same viewer**

Default Sidebar selection is `null`, not the first template. The Goal message shows `Auto`; clicking it opens approved template search/detail in `GoalContractInspector`. Save structured `Auto | Prefer | Require` policy through the typed PATCH route. Keep `@workflow-template` insertion as display convenience only.

For `per-slice-runs`, show each Slice's linked ordinary run id/status in the same Goal message and sidecar. Implement `selectSliceRun(sliceId)` by resolving the entry from the persisted execution-set read model, fetching existing `/api/workflow/ui?runId=<entry.runId>`, mapping it with `buildWorkflowDagFromRunReadModel()`, and replacing the same message's selected `workflowDag` block. Only one DAG is rendered at a time. Do not add a run tree, nested controls, execution-set parent row, or simultaneous multi-DAG canvas.

- [ ] **Step 7: Run UI and build gates**

Run: `npx tsx tests/v2/workflow-ui-read-model.test.ts && npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx && npm --prefix web run build`

Expected: PASS; `ready_for_review` renders without a DAG and the production build succeeds.

- [ ] **Step 8: Run the existing-layout browser check**

Run: `npx playwright test tests/e2e/workflow-mode.spec.ts`

Expected: PASS; pre-run Slice selection opens the existing right sidecar and focuses chat steering; after materialization it may load that Slice's ordinary run into the existing `workflow-dag-block`, without a new page, hierarchy, panel region, or simultaneous canvas.

- [ ] **Step 9: Commit Task 7**

```bash
git add web/components/GoalSlicePlan.tsx 'web/app/api/workflow/planner-drafts/[draftId]/confirm-goal-design/route.ts' 'web/app/api/workflow/planner-drafts/[draftId]/goal-design/slices/[sliceId]/route.ts' 'web/app/api/workflow/planner-drafts/[draftId]/goal-design/template-policy/route.ts' src/v2/read-models/workflow-ui.ts web/app/api/workflow/generate/route.ts web/lib/workflow/types.ts web/lib/workflow/v2-library-adapter.ts web/lib/workflow/generate-stream.ts web/lib/types.ts web/lib/agent-session-engine.ts web/hooks/useAgentSession.ts web/components/MessageView.tsx web/components/ChatWindow.tsx web/components/GoalContractCard.tsx web/components/GoalContractInspector.tsx web/components/AppShell.tsx web/components/WorkflowSidebar.tsx tests/v2/workflow-ui-read-model.test.ts tests/web/southstar-workflow-canvas-ui.test.tsx tests/e2e/workflow-mode.spec.ts
git commit -m "feat: review goal slices in the workflow message"
```

---

### Task 8: File-Authored Case 32 And Full Verification

**Files:**
- Create: `library/tools/workspace-read.tool.yaml`
- Create: `library/tools/workspace-write.tool.yaml`
- Create: `library/tools/shell-command.tool.yaml`
- Modify: `library/skills/beautiful-article.skill.md`
- Modify: `library/mcp/browser-playwright.mcp.yaml`
- Modify: `src/v2/design-library/files/library-file-store.ts`
- Modify: `tests/e2e-postgres/cases/32-one-prompt-goal-contract-article.test.ts`
- Delete: `tests/v2/fixtures/design-article-library-graph.ts`
- Modify: `tests/v2/library-file-store.test.ts`
- Modify: `tests/v2/library-candidate-resolver.test.ts`
- Modify: `tests/e2e-postgres/postgres-real-matrix-static.test.ts`
- Modify: `tests/e2e-postgres/README.md`
- Modify: `package.json`
- Modify: `docs/superpowers/specs/2026-07-10-southstar-one-prompt-goal-contract-runtime-design.zh.md`

**Interfaces:**
- Consumes: complete Tasks 1–7 and existing real Postgres/Tork/Pi harness.
- Produces: real review-mode, same-cwd per-Slice-run, and Auto evidence without graph seed helpers, fixed compositions, or fake planner/composer/provider paths.

- [ ] **Step 1: Make file-authored Library sync produce a closed primitive graph**

Add approved, global Tool definition files for `tool.workspace-read`, `tool.workspace-write`, and `tool.shell-command`, using the existing `southstar.library.tool_definition_file.v1` schema and real operations/risk metadata. Add `toolGrantRefs` and `mcpGrantRefs` to the existing approved `skill.beautiful-article` frontmatter, and make the existing browser Playwright MCP grant global because it is a cross-domain runtime primitive. These refs live only in Library files; no production TypeScript selects them by id.

Add one batch sync seam:

```ts
export async function syncLibraryFileRecordsToGraphPg(
  db: SouthstarDb,
  files: LibraryFileRecord[],
): Promise<Array<{ object: LibraryObjectRow; edges: LibraryEdgeRow[] }>>;

export function resolveClosedApprovedPrimitiveFileSet(
  files: LibraryFileRecord[],
): { files: LibraryFileRecord[]; excluded: Array<{ path: string; missingRefs: string[] }> };
```

`resolveClosedApprovedPrimitiveFileSet()` considers approved Agent, Skill, Tool, MCP, and Vault files, then removes records with non-domain refs absent from the set until stable; it returns explicit diagnostics and never invents placeholder objects. Profiles are generated by the composer and templates are optional, so broken legacy profile/saved-template files do not block primitive sync. Assert the one `purpose: goal_design` skill remains in the closed set.

`syncLibraryFileRecordsToGraphPg()` validates every selected file, derives/upserts domain taxonomy objects from distinct canonical file scopes, upserts all file objects before any edges, then upserts edges. Missing non-domain refs still fail closed with source-path evidence. Make `syncNewLibraryFileRecordsToGraph()` delegate to this seam rather than preserving a second ordering implementation. Add focused tests proving a Skill plus referenced Tool/MCP files sync in any input order, closure exclusion reports a missing ref, and the batch seam rejects an unclosed set.

- [ ] **Step 2: Replace Case 32 graph seeding with scoped production file sync**

Remove the import of `seedDesignArticleLibraryGraph()`. Sync repository Library files using the existing production functions:

```ts
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const libraryRoot = join(repoRoot, "library");
const listed = await listLibraryFiles({ root: libraryRoot });
const records = await Promise.all(listed.map(async ({ relativePath }) => {
  const read = await readLibraryFile({ root: libraryRoot, relativePath });
  if (!read.parsed.ok) throw new Error(`invalid Library file ${relativePath}`);
  return read.parsed.file;
}));
const approved = records.filter((file) => file.status === "approved");
const closed = resolveClosedApprovedPrimitiveFileSet(approved);
const goalDesignSkills = closed.files.filter((file) => file.kind === "skill" && file.frontmatter.purpose === "goal_design");
assert.equal(goalDesignSkills.length, 1);
await syncLibraryFileRecordsToGraphPg(env.db, closed.files);
```

Run this before `/run-goal`, so contract interpretation sees all closed file-authored domain vocabulary and approved primitives. Goal-scoped artifact refs and evaluator contracts come from Task 1/3 host compilation, not graph seeds. Record `closed.excluded` in test diagnostics and assert none of its missing refs appears in the selected run snapshot. This avoids a path/id allowlist and does not wait until after Goal Design to make vocabulary available.

Do not assert exact task ids, exact task count, exact slice count, or a selected concrete agent/template ref. Assert persisted invariants: one package hash, exact requirement ownership, artifact-flow dependencies, approved version refs, independent evaluator coverage, and accepted screenshot evidence.

- [ ] **Step 3: Prove review-mode and same-cwd per-Slice runs through product ingress**

Use one Case 32 Goal prompt that asks for the offline article plus a separately inspectable machine-readable editorial/audit artifact, each with independent acceptance evidence, and explicitly requests a separate persisted run for each naturally derived Slice in the same workspace. This is test input, not a production domain rule. Do not prescribe Slice ids or a Slice count.

Case 32 sends the normal review and confirmation requests:

```ts
const design = await api<RunGoalResult>(server.port, "/api/v2/run-goal", {
  method: "POST",
  headers: { accept: "text/event-stream" },
  body: JSON.stringify({ goalPrompt, cwd: workspace, idempotencyKey }),
}, requests);
assert.equal(design.draftStatus, "ready_for_review");
assert.equal(design.runId, undefined);

const persistedPackage = await loadGoalDesignPackageByHash(env.db, design.goalDesignPackageHash!);
assert.equal(persistedPackage.compositionStrategy.mode, "per-slice-runs");
assert.equal(persistedPackage.slicePlan.slices.length >= 2, true);

const result = await api<RunGoalResult>(server.port, `/api/v2/planner/drafts/${encodeURIComponent(design.draftId)}/confirm-goal-design`, {
  method: "POST",
  body: JSON.stringify({ expectedPackageHash: design.goalDesignPackageHash }),
}, requests);
assert.equal(result.runId, undefined);
assert.ok(result.executionSetId);
assert.equal(result.sliceRuns?.length, persistedPackage.slicePlan.slices.length);
```

`loadGoalDesignPackageByHash()` is a Case 32-local read helper implemented with the existing runtime-resource query; it parses the persisted `goal_design_package_revision` through the production Goal Design parser. It is not a package fixture or seed.

Wait for the execution-set outcome using the existing real-harness polling pattern. Assert from persisted data rather than exact generated topology:

- every package Slice maps to exactly one distinct ordinary run;
- every run's `runtime_context_json.projectRoot` equals the same Case 32 workspace;
- no run context contains `parentRunId` or `childRunId`;
- launch history never has two Slice runs in `scheduling|running` concurrently;
- every downstream launch occurs after upstream `satisfied` outcome and accepted declared artifacts;
- the execution-set outcome is `satisfied` and references every Slice run outcome;
- the offline HTML and audit artifacts each have their required independent evidence.

Add one focused real Auto submission with a different idempotency key and `goalDesignMode: "auto_until_blocked"`; stop after asserting that it did not enter `ready_for_review`, used the default `single-run` strategy when no independent-run request was supplied, and still created the normal execution approval. Do not assert the Auto run's task or Slice count.

- [ ] **Step 4: Strengthen the no-shortcut static gate**

For Case 32, reject these source patterns:

```ts
assert.doesNotMatch(text, /tests\/v2\/fixtures|seed[A-Z].*LibraryGraph|ScriptedWorkflowComposer|fixtureComposer|composerFallbackUsed:\s*true/);
assert.doesNotMatch(text, /expectedTaskCount|expectedSliceCount|slice-(?:software|article|subscription)-\d+/i);
```

Delete `tests/v2/fixtures/design-article-library-graph.ts`. Do not replace it with another seed helper.

Remove every import of that file, including `tests/v2/library-candidate-resolver.test.ts`. Migrate that whole touched test away from both article and software fixture imports: use approved test-local `LibraryFileRecord` literals and `syncLibraryFileRecordsToGraphPg()` for the exact primitive edges under test. Do not copy either domain fixture or import a shared seed.

- [ ] **Step 5: Run all focused and integration gates**

Run:

```bash
npm run test:v2
npx tsx tests/unit/workflow-library.test.ts
npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
npm --prefix web run build
```

Expected: all commands exit `0`.

- [ ] **Step 6: Run Case 32 only**

Run: `npm run test:e2e:postgres:32`

Expected: PASS with real Postgres, isolated Tork, real Pi Goal Design/composer/workers, file-authored Library sync, same-cwd serial per-Slice runs, aggregate evaluator outcome, offline artifact verification, frozen Library snapshots, and no fixture/seed composer path.

- [ ] **Step 7: Run source scans for forbidden production shortcuts**

Run:

```bash
if rg -n "ScriptedWorkflowComposer|fixtureComposer|llm-with-fixture-fallback|software-library-seed|graphDynamicWorkflowTemplateCandidate|workTypeFromContract" src/v2 web; then exit 1; fi
if rg -n "SG[0-9]+|expectedSliceCount|expectedTaskCount|one task per requirement" src/v2/orchestration; then exit 1; fi
```

Expected: both commands exit `0` because neither `rg` invocation finds a forbidden match. The authored Library markdown may describe slice invariants but must not contain fixed slice ids or domain examples.

- [ ] **Step 8: Update the design status and commit Task 8**

Change the design document status to implemented only after every Task 8 command passes and record Case 32 evidence ids without secrets.

```bash
git add library/tools/workspace-read.tool.yaml library/tools/workspace-write.tool.yaml library/tools/shell-command.tool.yaml library/skills/beautiful-article.skill.md library/mcp/browser-playwright.mcp.yaml src/v2/design-library/files/library-file-store.ts tests/v2/library-file-store.test.ts tests/v2/library-candidate-resolver.test.ts tests/e2e-postgres/cases/32-one-prompt-goal-contract-article.test.ts tests/e2e-postgres/postgres-real-matrix-static.test.ts tests/e2e-postgres/README.md package.json docs/superpowers/specs/2026-07-10-southstar-one-prompt-goal-contract-runtime-design.zh.md
git rm tests/v2/fixtures/design-article-library-graph.ts
git commit -m "test: prove file-authored goal design end to end"
```

---

## Verification Matrix

| Requirement | Gate |
|---|---|
| Approved Library Goal Design SOP, no embedded SOP/id | Task 1 focused + Library sync tests |
| No domain regex or fixed Slice/task count | Task 1 tests + Task 8 source scans |
| Default review, optional Auto | Task 2/3 service tests + Case 32 |
| One owner slice and artifact-flow dependencies | Task 1/3 validators |
| Hash-bound confirm and idempotency | Task 3 service/route tests |
| Typed edit, chat steering, clarification, and stale conflict | Task 4 integration tests |
| Template Auto/Prefer/Require and proposal-only save | Task 5 tests |
| All Slices in one DAG/run | Task 3 composition/run tests + Case 32 Auto |
| One ordinary run per Slice, same cwd, serial launch, aggregate outcome | Task 6 tests + Case 32 review flow |
| Existing Goal message, chat input, sidecar, one DAG canvas | Task 7 UI/browser tests |
| Real Pi/Tork/Postgres/file-authored proof | Task 8 Case 32 |

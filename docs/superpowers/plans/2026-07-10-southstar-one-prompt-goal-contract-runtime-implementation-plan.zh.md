# Southstar One-Prompt Goal Contract Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 將 Southstar 完成為可由一個 prompt 解譯 Goal Contract、依核准 Library 動態編譯 DAG、持久化執行、以證據驗收，並按風險自動執行或等待核准的 Goal-to-Outcome Runtime。

**Architecture:** 深化既有 `requirement-analyzer -> candidate-resolver -> composer -> validator -> compiler -> planner_draft -> workflow_run -> scheduler -> Tork -> callback -> completion-gate` 資料流。Goal Contract、coverage、Library snapshot、approval 與 evaluator evidence 都使用既有 Postgres `runtime_resources` 和 run runtime context；不新增資料表或第二套 orchestrator。Workflow UI 繼續使用現有訊息區、DAG block、Workflow read model 與 Sidecar。

**Tech Stack:** Node.js `>=22.22.2`, TypeScript ESM, `tsx`, Node `node:test`, Postgres `southstar` schema, Next.js 16 App Router, React 19, existing Southstar Library graph, Tork, Pi planner/composer.

## Global Constraints

- Production source of truth remains `src/v2/` and `web/`; do not restore the retired root Next app.
- Production workflow composition remains `composerMode: "llm"`; deterministic composers stay under `tests/v2/fixtures/`.
- Do not add a second workflow engine, persistence model, approval system, status table, or standalone Goal Contract page.
- Do not add dependencies. Reuse `node:crypto`, existing Postgres stores, `evaluateApprovalPolicy`, `startRunSchedulingPg`, EvidencePacket, ValidatorResult, Workflow read models, SSE utilities, and Sidecar.
- Goal interpretation may classify needs but cannot grant Agent, Skill, Tool, MCP, vault, mount, credential, or external-effect authority.
- Library selection is limited to approved, scope-compatible graph objects. Dispatch reads the immutable run snapshot, never the current Library head.
- Secrets never enter Goal Contract, manifest, runtime resources, history, logs, prompts, evidence, or snapshot state.
- Low-risk complete goals auto-schedule. Blocking input creates `needs_input` without a run. High-risk effects create `awaiting_approval` without scheduling.
- One Goal Contract represents one independently acceptable outcome and one logical run. Compound outcomes are decomposed into observable requirements, then into dependency-linked DAG tasks; the scheduler executes runnable waves and bounded repair adds revisions to the same run.
- Every blocking requirement must have a producer, accepted artifact, independent evaluator task, evaluator profile, and required evidence kinds.
- External state transitions are persisted before SSE or JSON reports them.
- Use argv arrays for external commands. Do not introduce shell-chained runtime command strings.
- Run real Postgres/Tork/Pi/browser E2E only in the final E2E task, not as routine checks during earlier tasks.
- Execute in an isolated worktree from the current committed HEAD. The current checkout contains unrelated Operator/recovery edits; do not stage, overwrite, or absorb them.

---

## File Structure

### New focused modules

- `src/v2/orchestration/goal-contract.ts` — Goal Contract types, LLM parsing, host-owned fields, hashing, revision merge, validation, and `RequirementSpecV2` compatibility projection.
- `src/v2/orchestration/goal-requirement-coverage.ts` — requirement-to-producer/evaluator/evidence mapping and deterministic coverage validation.
- `src/v2/orchestration/run-library-snapshot.ts` — capture, hash, persist, load, and validate immutable run-scoped Library objects and skill bundles.
- `src/v2/orchestration/run-goal-service.ts` — idempotent one-prompt application service that composes existing planner, run creation, policy, approval, and scheduling seams.
- `src/v2/evaluators/requirement-evaluator-results.ts` — build and persist per-requirement EvidencePacket, ValidatorResult, and evaluator-result resources from verifier callbacks.
- `web/components/GoalContractCard.tsx` — compact mission receipt rendered above the DAG; no form gate.
- `web/components/GoalContractInspector.tsx` — read-only Goal Contract, coverage, evidence, revision, and provenance Sidecar.

### Existing seams to deepen

- `src/v2/orchestration/requirement-analyzer.ts` — remove after all production/test callers use Goal Contract projection or test fixtures.
- `src/v2/orchestration/composer.ts`
- `src/v2/orchestration/llm-composer.ts`
- `src/v2/orchestration/composition-repair-loop.ts`
- `src/v2/orchestration/composition-validator.ts`
- `src/v2/orchestration/composition-compiler.ts`
- `src/v2/orchestration/composition-selection-summary.ts`
- `src/v2/orchestration/runtime-library-materializer.ts`
- `src/v2/ui-api/postgres-run-api.ts`
- `src/v2/server/planner-routes.ts`
- `src/v2/server/client.ts`
- `src/v2/server/run-execution-controller.ts`
- `src/v2/approvals/policy.ts`
- `src/v2/server/routes.ts`
- `src/v2/executor/postgres-tork-callback.ts`
- `src/v2/artifacts/artifact-ref-store.ts`
- `src/v2/evaluators/completion-gate.ts`
- `src/v2/runtime-revision/dynamic-repair-revision.ts`
- `src/v2/read-models/workflow-ui.ts`
- `src/v2/read-models/operator-overview.ts`
- `src/v2/read-models/operator-attention.ts`
- `src/v2/cli.ts`
- `web/app/api/workflow/generate/route.ts`
- `web/lib/workflow/generate-stream.ts`
- `web/lib/workflow/types.ts`
- `web/lib/workflow/v2-library-adapter.ts`
- `web/hooks/useAgentSession.ts`
- `web/hooks/useWorkflowLifecycle.ts`
- `web/components/WorkflowDagBlock.tsx`
- `web/components/MessageView.tsx`
- `web/components/ChatWindow.tsx`
- `web/components/AppShell.tsx`
- `web/components/TabBar.tsx`
- `web/lib/operator/types.ts`
- `web/lib/operator/normalizers.ts`
- `web/components/operator/OperatorWorkspace.tsx`

---

### Task 1: Goal Contract Core And LLM Interpreter

**Files:**
- Create: `src/v2/orchestration/goal-contract.ts`
- Create: `tests/v2/goal-contract.test.ts`
- Create: `tests/v2/fixtures/goal-contract.ts`
- Modify: `tests/v2/index.test.ts`

**Interfaces:**
- Consumes: existing `LlmTextClient` from `src/v2/orchestration/llm-composer.ts` and `RequirementSpecV2` from `src/v2/design-library/types.ts`.
- Produces: `GoalContractV1`, `GoalContractInterpreter`, `interpretGoalContractWithLlm()`, `finalizeGoalContract()`, `goalContractHash()`, `reviseGoalContract()`, and `requirementSpecFromGoalContract()`.

- [ ] **Step 1: Write the failing host-ownership and schema tests**

Add tests proving that the prompt, hash, workspace, revision, and requirement ids are host-derived; malformed output fails closed; every requirement has acceptance criteria; and a compound outcome is decomposed into observable requirements rather than plan/implement/verify phases.

```ts
test("LLM interpretation produces a host-owned GoalContractV1", async () => {
  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Turn notes.md into an offline HTML article",
    cwd: "/workspace/article",
    client: {
      generateText: async () => JSON.stringify({
        domain: "design/article",
        intent: "create_offline_article",
        summary: "Create an offline HTML article from notes.md",
        requirements: [{
          statement: "The result opens without network access",
          acceptanceCriteria: ["article.html loads with the network disabled"],
          blocking: true,
          source: "explicit",
        }],
        expectedArtifactRefs: ["artifact.article_html"],
        requiredCapabilities: ["capability.workspace-read", "capability.workspace-write"],
        nonGoals: [],
        assumptions: [],
        blockingInputs: [],
        riskTags: [],
        requestedSideEffects: ["workspace-write"],
      }),
    },
    model: "test-goal-interpreter",
  });

  assert.equal(contract.originalPrompt, "Turn notes.md into an offline HTML article");
  assert.equal(contract.workspace.cwd, "/workspace/article");
  assert.equal(contract.revision, 1);
  assert.match(contract.promptHash, /^[a-f0-9]{64}$/);
  assert.match(contract.requirements[0]!.id, /^req-[a-f0-9]{12}$/);
  assert.equal(goalContractHash(contract).length, 64);
});

test("Goal Contract rejects blocking requirements without acceptance criteria", async () => {
  await assert.rejects(
    () => interpretGoalContractWithLlm({
      goalPrompt: "Build it",
      cwd: "/workspace/project",
      client: { generateText: async () => JSON.stringify({
        domain: "software",
        intent: "implement_feature",
        summary: "Build it",
        requirements: [{ statement: "Build it", acceptanceCriteria: [], blocking: true, source: "explicit" }],
        expectedArtifactRefs: [],
        requiredCapabilities: [],
        nonGoals: [],
        assumptions: [],
        blockingInputs: [],
        riskTags: [],
        requestedSideEffects: [],
      }) },
      model: "test-goal-interpreter",
    }),
    /acceptanceCriteria/,
  );
});

test("Goal interpreter decomposes a compound outcome into observable requirements", async () => {
  const prompts: string[] = [];
  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Deliver a production-ready membership subscription flow in the local test workspace using the provided fake payment adapter, with access control, billing state, cancellation/refund behavior, and audit reporting; do not deploy or charge real accounts",
    cwd: "/workspace/subscription",
    client: {
      async generateText(input) {
        prompts.push(input.prompt);
        return JSON.stringify({
          domain: "software",
          intent: "implement_feature",
          summary: "Deliver a production-ready membership subscription flow",
          requirements: [
            { statement: "Authorized members can access subscription-only features", acceptanceCriteria: ["Unauthorized users are denied and authorized members are allowed"], blocking: true, source: "explicit" },
            { statement: "Members can purchase a subscription and payment state is persisted", acceptanceCriteria: ["A successful payment activates exactly one subscription"], blocking: true, source: "explicit" },
            { statement: "Members can cancel and receive the configured refund behavior", acceptanceCriteria: ["Cancellation and refund state are observable and idempotent"], blocking: true, source: "explicit" },
            { statement: "Operators can inspect subscription and audit events", acceptanceCriteria: ["Administrative reporting shows the recorded lifecycle events"], blocking: true, source: "explicit" },
          ],
          expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
          requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
          nonGoals: [],
          assumptions: [],
          blockingInputs: [],
          riskTags: [],
          requestedSideEffects: ["workspace-write"],
        });
      },
    },
    model: "test-goal-interpreter",
  });

  assert.match(prompts[0] ?? "", /decompose compound outcomes into independently verifiable requirements/i);
  assert.equal(contract.requirements.length, 4);
  assert.equal(contract.requirements.every((requirement) => requirement.acceptanceCriteria.length > 0), true);
  assert.equal(contract.requirements.some((requirement) => /^(plan|implement|verify|review)\b/i.test(requirement.statement)), false);
});
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `npx tsx tests/v2/goal-contract.test.ts`

Expected: FAIL because `goal-contract.ts` does not exist.

- [ ] **Step 3: Implement the canonical contract and compatibility projection**

Create the module with these exact public contracts. LLM output excludes host-owned identity fields; `finalizeGoalContract()` adds them after validation.

```ts
export type GoalRequirementV1 = {
  id: string;
  statement: string;
  acceptanceCriteria: string[];
  blocking: boolean;
  source: "explicit" | "inferred";
};

export type GoalContractV1 = {
  schemaVersion: "southstar.goal_contract.v1";
  originalPrompt: string;
  promptHash: string;
  revision: number;
  workspace: { cwd: string; projectRef?: string };
  domain: string;
  intent: string;
  summary: string;
  requirements: GoalRequirementV1[];
  expectedArtifactRefs: string[];
  requiredCapabilities: string[];
  nonGoals: string[];
  assumptions: string[];
  blockingInputs: string[];
  riskTags: string[];
  requestedSideEffects: string[];
};

export type GoalContractInterpreter = {
  interpret(input: {
    goalPrompt: string;
    cwd: string;
    projectRef?: string;
    previousContract?: GoalContractV1;
    revisionPrompt?: string;
    onDelta?: (text: string) => void;
  }): Promise<GoalContractV1>;
};

export function requirementSpecFromGoalContract(contract: GoalContractV1): RequirementSpecV2 {
  return {
    summary: contract.summary,
    workType: workTypeFromContract(contract),
    requiredCapabilities: [...contract.requiredCapabilities],
    expectedArtifacts: [...contract.expectedArtifactRefs],
    acceptanceCriteria: contract.requirements.flatMap((requirement) => requirement.acceptanceCriteria),
    nonGoals: [...contract.nonGoals],
    riskNotes: [...contract.riskTags],
    workspaceAssumptions: [...contract.assumptions],
    missingInputs: [...contract.blockingInputs],
  };
}
```

Use `createHash("sha256")`, a key-sorted JSON serializer, and requirement ids derived from normalized statements:

```ts
function requirementId(statement: string): string {
  return `req-${createHash("sha256").update(statement.trim()).digest("hex").slice(0, 12)}`;
}

export function goalContractHash(contract: GoalContractV1): string {
  return createHash("sha256").update(stableStringify(contract)).digest("hex");
}
```

`reviseGoalContract()` keeps ids for unchanged statements and carries every prior explicit requirement forward. First version does not delete explicit requirements; starting a replacement goal is the explicit scope-reduction path.

The interpreter prompt must say: `Decompose compound outcomes into independently verifiable requirements. Requirements describe observable outcome slices; plan, implement, verify, repair, review, and release sequencing belong to workflow composition, not the Goal Contract.` Do not require one requirement per noun or one requirement per future DAG task.

- [ ] **Step 4: Add reusable test-only contract fixtures**

Create fixtures that keep deterministic behavior outside production modules:

```ts
export function fixedGoalInterpreter(contract: GoalContractV1): GoalContractInterpreter {
  return { interpret: async () => structuredClone(contract) };
}

export function softwareGoalContract(goalPrompt = "implement calc sum"): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt,
    cwd: "/workspace/software",
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      summary: goalPrompt,
      requirements: [{
        statement: goalPrompt,
        acceptanceCriteria: [goalPrompt],
        blocking: true,
        source: "explicit",
      }],
      expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: [],
      assumptions: [],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}

export function subscriptionGoalContract(): GoalContractV1 {
  return finalizeGoalContract({
    goalPrompt: "Deliver a local membership subscription flow using the fake payment adapter",
    cwd: "/workspace/subscription",
    interpretation: {
      domain: "software",
      intent: "implement_feature",
      summary: "Deliver a production-ready local membership subscription flow",
      requirements: [
        { statement: "Authorized members can access subscription-only features", acceptanceCriteria: ["Unauthorized users are denied and authorized members are allowed"], blocking: true, source: "explicit" },
        { statement: "Members can purchase a subscription and payment state is persisted", acceptanceCriteria: ["A successful fake payment activates exactly one subscription"], blocking: true, source: "explicit" },
        { statement: "Members can cancel and receive the configured refund behavior", acceptanceCriteria: ["Cancellation and fake refund state are observable and idempotent"], blocking: true, source: "explicit" },
        { statement: "Operators can inspect subscription and audit events", acceptanceCriteria: ["Administrative reporting shows the recorded lifecycle events"], blocking: true, source: "explicit" },
      ],
      expectedArtifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
      requiredCapabilities: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      nonGoals: ["Do not deploy or charge real payment accounts"],
      assumptions: ["The test workspace provides a fake payment adapter"],
      blockingInputs: [],
      riskTags: [],
      requestedSideEffects: ["workspace-write"],
    },
  });
}
```

Leave `requirement-analyzer.ts` unchanged for this commit. Task 2 removes its production callers; Task 3 moves the remaining deterministic test usage into this fixture and deletes the source module.

- [ ] **Step 5: Run focused and related parser tests**

Run:

```bash
npx tsx tests/v2/goal-contract.test.ts
npx tsx tests/v2/llm-workflow-composer.test.ts
```

Expected: both commands PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/orchestration/goal-contract.ts tests/v2/goal-contract.test.ts tests/v2/fixtures/goal-contract.ts tests/v2/index.test.ts
git commit -m "feat: add canonical goal contract"
```

---

### Task 2: Persist Goal Contract And Resolve Library By Domain

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/planner-routes.ts`
- Modify: `src/v2/server/runtime-context.ts`
- Modify: `src/v2/workflow-templates/template-api-service.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/planner-draft-stream-route.test.ts`
- Modify: `tests/v2/postgres-task-envelope.test.ts`
- Modify: `tests/v2/library-constrained-regression.test.ts`
- Modify: `tests/v2/postgres-run-dispatcher.test.ts`
- Modify: `tests/v2/operator-task-debug-read-model.test.ts`
- Modify: `tests/v2/evolution-api.test.ts`
- Modify: `tests/v2/planner-draft-progress.test.ts`
- Modify: `tests/v2/evolution-sandbox.test.ts`
- Modify: `tests/v2/fixtures/software-library-graph.ts`

**Interfaces:**
- Consumes: `GoalContractInterpreter` and `requirementSpecFromGoalContract()` from Task 1.
- Produces: planner drafts whose payload and summary contain `goalContract`, `goalContractHash`, and a truthful domain; draft status may be `needs_input`.

- [ ] **Step 1: Write failing draft persistence tests**

Cover `design/article`, blocking input, original prompt preservation, and contract revision.

```ts
test("planner draft persists a design/article Goal Contract and uses its domain", async () => {
  const draft = await createPostgresPlannerDraft(db, {
    goalPrompt: "Turn notes.md into an offline HTML article",
    cwd: "/workspace/article",
    goalInterpreter: fixedGoalInterpreter(articleGoalContract()),
    composer: fixtureComposer(articleComposition()),
  });

  const stored = await getResourceByKeyPg(db, "planner_draft", draft.draftId);
  assert.equal((stored!.payload as any).goalContract.domain, "design/article");
  assert.equal((stored!.payload as any).workflow.domain, "design/article");
  assert.equal((stored!.summary as any).goalContractHash, draft.goalContractHash);
});

test("blocking Goal Contract persists needs_input without compiling", async () => {
  const draft = await createPostgresPlannerDraft(db, {
    goalPrompt: "Publish my article",
    cwd: "/workspace/article",
    goalInterpreter: fixedGoalInterpreter({
      ...articleGoalContract(),
      blockingInputs: ["Which source file should be used?"],
    }),
    composer: fixtureComposer(articleComposition()),
  });

  assert.equal(draft.status, "needs_input");
  assert.deepEqual(draft.blockers, ["Which source file should be used?"]);
  await assert.rejects(() => createPostgresRunFromDraft(db, { draftId: draft.draftId }), /not validated/);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/v2/postgres-run-api.test.ts`

Expected: FAIL because planner inputs/results do not carry Goal Contract data and domain is hardcoded.

- [ ] **Step 3: Extend planner input and result types**

Add the interpreter and contract projections without adding a second mutable requirement object:

```ts
export type CreatePostgresPlannerDraftInput = PlannerDraftRequestContract & {
  goalInterpreter: GoalContractInterpreter;
  composer?: WorkflowComposer;
  onProgress?: PlannerDraftProgressListener;
  onLlmDelta?: (text: string) => void;
};

export type PostgresPlannerDraftResult = {
  draftId: string;
  goalPrompt: string;
  workflowId: string;
  status: "needs_input" | "invalid" | "needs_validation" | "validated";
  goalContractHash: string;
  blockers: string[];
  validationIssues: PlannerDraftValidationIssue[];
  taskSummaries: PlannerDraftTaskSummary[];
};
```

At the beginning of `createPostgresPlannerDraft()`, call the interpreter once and emit persisted progress:

```ts
const goalContract = await input.goalInterpreter.interpret({
  goalPrompt: input.goalPrompt,
  cwd: input.cwd ?? process.cwd(),
  onDelta: input.onLlmDelta,
});
const contractHash = goalContractHash(goalContract);
input.onProgress?.({ stage: "goal_contract.interpreted", message: "Goal Contract interpreted." });
```

If `blockingInputs` is non-empty, persist `planner_draft` with status `needs_input`, `goalContract`, `goalContractHash`, and no workflow/composition. Return before candidate resolution.

- [ ] **Step 4: Remove software/all overrides from the planner flow**

Delete `WORKFLOW_LIBRARY_SCOPE` and `WORKFLOW_MANIFEST_DOMAIN`. Pass the interpreted domain through every planning stage:

```ts
const requirementSpec = requirementSpecFromGoalContract(goalContract);
const candidatePacket = await resolveWorkflowCandidates(db, {
  requirementSpec,
  scope: goalContract.domain,
});

const compiled = await compileWorkflowComposition(db, {
  runId: draftRunId,
  goalPrompt: input.goalPrompt,
  goalContract,
  candidatePacket,
  composition,
  scope: goalContract.domain,
  manifestDomain: goalContract.domain,
});
```

Persist `goalContract` and `goalContractHash` in both valid and invalid draft payloads. Summary stores only the hash, domain, intent, blockers, and requirement count.

- [ ] **Step 5: Wire the production LLM interpreter**

Add `goalInterpreter?: GoalContractInterpreter` to `RuntimeServerContext`. In `planner-routes.ts`, resolve an injected interpreter first; otherwise wrap the existing `plannerClient` with `interpretGoalContractWithLlm()` using `SOUTHSTAR_GOAL_INTERPRETER_MODEL ?? "southstar-runtime-goal-interpreter"`.

```ts
function resolveGoalInterpreter(context: RuntimeServerContext): GoalContractInterpreter {
  if (context.goalInterpreter) return context.goalInterpreter;
  return {
    interpret: (input) => interpretGoalContractWithLlm({
      ...input,
      model: process.env.SOUTHSTAR_GOAL_INTERPRETER_MODEL ?? "southstar-runtime-goal-interpreter",
      client: {
        generateText: ({ prompt }) => context.plannerClient.generate(prompt),
        generateTextStream: context.plannerClient.generateStream
          ? ({ prompt }, handlers) => context.plannerClient.generateStream!(prompt, { onDelta: handlers.onDelta })
          : undefined,
      },
    }),
  };
}
```

Update planner create/revise/template instantiation call sites to pass a real interpreter or a test fixture. Production must not silently fall back to software classification.

Update every direct `createPostgresPlannerDraft()` test call to pass `goalInterpreter: fixedGoalInterpreter(softwareGoalContract(goalPrompt))`. This keeps the required production input honest without duplicating LLM setup in tests.

- [ ] **Step 6: Verify planner behavior**

Run:

```bash
npx tsx tests/v2/goal-contract.test.ts
npx tsx tests/v2/postgres-run-api.test.ts
npx tsx tests/v2/planner-draft-stream-route.test.ts
npx tsx tests/v2/library-candidate-resolver.test.ts
```

Expected: all commands PASS; persisted `design/article` drafts never report domain `software`.

- [ ] **Step 7: Commit**

```bash
git add src/v2/ui-api/postgres-run-api.ts src/v2/server/planner-routes.ts src/v2/server/runtime-context.ts src/v2/workflow-templates/template-api-service.ts tests/v2/postgres-run-api.test.ts tests/v2/planner-draft-stream-route.test.ts tests/v2/postgres-task-envelope.test.ts tests/v2/library-constrained-regression.test.ts tests/v2/postgres-run-dispatcher.test.ts tests/v2/operator-task-debug-read-model.test.ts tests/v2/evolution-api.test.ts tests/v2/planner-draft-progress.test.ts tests/v2/evolution-sandbox.test.ts tests/v2/fixtures/software-library-graph.ts
git commit -m "feat: persist domain-aware goal contracts"
```

---

### Task 3: Compile Requirement Coverage Into The DAG

**Files:**
- Create: `src/v2/orchestration/goal-requirement-coverage.ts`
- Delete: `src/v2/orchestration/requirement-analyzer.ts`
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/orchestration/composer.ts`
- Modify: `src/v2/orchestration/llm-composer.ts`
- Modify: `src/v2/orchestration/composition-repair-loop.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `tests/v2/llm-workflow-composer.test.ts`
- Modify: `tests/v2/library-candidate-resolver.test.ts`
- Modify: `tests/v2/workflow-composition-validator.test.ts`
- Modify: `tests/v2/workflow-composition-compiler.test.ts`
- Modify: `tests/v2/composition-repair-loop.test.ts`
- Modify: `tests/v2/fixtures/goal-contract.ts`

**Interfaces:**
- Consumes: `GoalContractV1`, `WorkflowCompositionPlan`, task `nodePromptSpec`, and selected tool/MCP refs.
- Produces: `GoalRequirementCoverageV1`; every composition task carries `requirementIds`.

- [ ] **Step 1: Write failing coverage tests**

```ts
test("coverage maps every blocking requirement to producer and independent evaluator", () => {
  const coverage = buildGoalRequirementCoverage({
    goalContract: articleGoalContract(),
    composition: articleCompositionWithRequirementIds(),
  });

  assert.deepEqual(coverage.entries[0], {
    requirementId: articleGoalContract().requirements[0]!.id,
    producerTaskIds: ["task-build-article"],
    artifactRefs: ["artifact.article_html"],
    evaluatorTaskIds: ["task-verify-article"],
    evaluatorProfileRefs: ["evaluator.article-browser-quality"],
    requiredEvidenceKinds: ["artifact-ref", "screenshot", "url"],
  });
});

test("coverage rejects a producer as its only evaluator", async () => {
  const result = await validateWorkflowCompositionPlan(db, packet, selfEvaluatingComposition(), {
    scope: "design/article",
    goalContract: articleGoalContract(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.code === "requirement_evaluator_not_independent"), true);
});

test("compound requirements form parallel producer branches and a dependent verification wave", () => {
  const contract = subscriptionGoalContract();
  const composition = subscriptionCompositionWithRequirementIds(contract);
  const coverage = buildGoalRequirementCoverage({ goalContract: contract, composition });
  const producerTasks = composition.tasks.filter((task) => task.nodePromptSpec?.nodeType === "implement");
  const verifier = composition.tasks.find((task) => task.id === "task-verify-subscription");

  assert.deepEqual(
    new Set(coverage.entries.map((entry) => entry.requirementId)),
    new Set(contract.requirements.map((requirement) => requirement.id)),
  );
  assert.equal(producerTasks.filter((task) => task.dependsOn.length === 0).length >= 2, true);
  assert.deepEqual(
    new Set(verifier?.dependsOn),
    new Set(producerTasks.map((task) => task.id)),
  );
  assert.deepEqual(
    new Set(verifier?.requirementIds),
    new Set(contract.requirements.map((requirement) => requirement.id)),
  );
});
```

Add `subscriptionGoalContract()` to `tests/v2/fixtures/goal-contract.ts`. Add `subscriptionCompositionWithRequirementIds()` beside the existing composition test factories: four independent producer tasks for account/access, billing, cancellation/refund, and admin/audit, followed by `task-verify-subscription`, which depends on all four producers and carries all four requirement ids. Reuse the existing task factory after adding its required `requirementIds` argument; do not introduce a `SubGoal` type or fixture framework.

- [ ] **Step 2: Run and confirm red**

Run:

```bash
npx tsx tests/v2/workflow-composition-validator.test.ts
npx tsx tests/v2/workflow-composition-compiler.test.ts
```

Expected: FAIL because tasks do not declare requirement ids and no Goal coverage projection exists.

- [ ] **Step 3: Extend the composition contract**

Add a required field to `WorkflowCompositionTask` and the LLM JSON schema:

```ts
export type WorkflowCompositionTask = {
  id: string;
  name: string;
  responsibility: string;
  requirementIds: string[];
  nodePromptSpec?: WorkflowNodePromptSpec;
  dependsOn: string[];
  templateSlotRef: string;
  agentDefinitionRef: string;
  agentProfileRef: string;
  instructionRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
  inputArtifactRefs: string[];
  outputArtifactRefs: string[];
  evaluatorProfileRef: string;
  contextPolicyRef?: string;
  workspacePolicyRef?: string;
  recoveryStrategyRefs: string[];
  rationale: string;
};
```

Pass `goalContract` through `ComposeWorkflowInput`, repair-loop input, validator options, and compiler input. Render requirement ids, statements, acceptance criteria, and the independent-evaluator rule in the composer prompt.

The composer prompt must also require this decomposition behavior:

- turn each observable requirement into one or more executable producer work packages;
- preserve independent branches as tasks without artificial dependencies so the scheduler can run them in parallel;
- use shared integration or evaluator tasks when they legitimately cover several requirements;
- never force one task per requirement or model plan/implement/verify phases as new Goal Contract requirements;
- attach every task to the requirement ids it contributes to, except explicit coordination/summary nodes allowed by coverage validation.

Replace remaining `analyzeRequirementDeterministically(prompt)` test usage with `requirementSpecFromGoalContract(softwareGoalContract(prompt))`, then delete `src/v2/orchestration/requirement-analyzer.ts`. `rg -n "requirement-analyzer|analyzeRequirementDeterministically" src tests` must return no matches.

- [ ] **Step 4: Implement deterministic coverage building**

```ts
export type GoalRequirementCoverageV1 = {
  schemaVersion: "southstar.goal_requirement_coverage.v1";
  goalContractHash: string;
  entries: Array<{
    requirementId: string;
    producerTaskIds: string[];
    artifactRefs: string[];
    evaluatorTaskIds: string[];
    evaluatorProfileRefs: string[];
    requiredEvidenceKinds: EvidenceKind[];
  }>;
};
```

Treat `verify` and `review` node types as evaluator tasks. Derive evidence kinds from the selected evaluator closure, without domain hardcoding:

```ts
function requiredEvidenceKindsForTask(task: WorkflowCompositionTask): EvidenceKind[] {
  const kinds = new Set<EvidenceKind>(["artifact-ref"]);
  if (task.toolGrantRefs.some((ref) => ref.includes("shell") || ref.includes("test"))) {
    kinds.add("test-result");
    kinds.add("command-output");
  }
  if (task.mcpGrantRefs.some((ref) => ref.includes("browser") || ref.includes("playwright"))) {
    kinds.add("screenshot");
    kinds.add("url");
  }
  return [...kinds].sort();
}
```

Validation fails for unknown requirement ids, missing producer/evaluator/artifact/evidence, a producer as every evaluator, or a task that contributes to no coverage entry except explicit coordination/summary nodes.

- [ ] **Step 5: Store coverage beside the manifest**

Return coverage from `compileWorkflowComposition()` and persist it in the planner draft payload:

```ts
return {
  workflow,
  goalRequirementCoverage,
  orchestrationSnapshot: {
    schemaVersion: "southstar.orchestration_snapshot.v1",
    draftId: input.runId,
    requirementSpec: requirementSpecFromGoalContract(input.goalContract),
    goalContractHash: goalContractHash(input.goalContract),
    candidatePacketHash: hash(JSON.stringify(input.candidatePacket)),
    candidateSummary: summarizeCandidates(input.candidatePacket),
    selectedCompositionPlan: input.composition,
    validation,
    compiler,
  },
};
```

Copy each task's requirement statements and acceptance criteria into `nodePromptSpec.requirements` and `nodePromptSpec.acceptanceCriteria`. Workers receive human-readable contracts; ids remain in `promptInputs.requirementIds`.

- [ ] **Step 6: Verify coverage and composer contracts**

Run:

```bash
npx tsx tests/v2/llm-workflow-composer.test.ts
npx tsx tests/v2/workflow-composition-validator.test.ts
npx tsx tests/v2/workflow-composition-compiler.test.ts
npx tsx tests/v2/composition-repair-loop.test.ts
```

Expected: all commands PASS and every blocking test requirement has a producer/evaluator mapping.

- [ ] **Step 7: Commit**

```bash
git add src/v2/orchestration/goal-requirement-coverage.ts src/v2/orchestration/requirement-analyzer.ts src/v2/design-library/types.ts src/v2/orchestration/composer.ts src/v2/orchestration/llm-composer.ts src/v2/orchestration/composition-repair-loop.ts src/v2/orchestration/composition-validator.ts src/v2/orchestration/composition-compiler.ts src/v2/ui-api/postgres-run-api.ts tests/v2/llm-workflow-composer.test.ts tests/v2/library-candidate-resolver.test.ts tests/v2/workflow-composition-validator.test.ts tests/v2/workflow-composition-compiler.test.ts tests/v2/composition-repair-loop.test.ts
git commit -m "feat: compile goal requirement coverage"
```

---

### Task 4: Freeze The Run Library Snapshot

**Files:**
- Create: `src/v2/orchestration/run-library-snapshot.ts`
- Modify: `src/v2/orchestration/composition-selection-summary.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Modify: `src/v2/orchestration/runtime-library-materializer.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/manifests/types.ts`
- Modify: `src/v2/manifests/validate.ts`
- Modify: `tests/v2/runtime-library-materializer.test.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/manifests.test.ts`

**Interfaces:**
- Consumes: selected object refs/version refs from Task 3 and current approved `library_objects` state.
- Produces: `RunLibrarySnapshotV1`, `captureRunLibrarySnapshotPg()`, `loadRunLibrarySnapshotPg()`, and snapshot-backed task materialization.

- [ ] **Step 1: Write the immutable-head regression test**

```ts
test("task materialization uses the run snapshot after Library head changes", async () => {
  const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
  await upsertLibraryObject(db, {
    objectKey: "instruction.article-builder",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.article-builder@v2",
    state: { content: "MUTATED AFTER RUN CREATION", variables: [] },
  });

  const refs = await materializeTaskLibraryRefs(db, {
    runId: run.runId,
    taskId: "task-build-article",
    sessionId: "session-build-article",
    instructionRefs: ["instruction.article-builder"],
    skillRefs: [],
    toolGrantRefs: [],
    mcpGrantRefs: [],
    vaultLeasePolicyRefs: [],
  });

  assert.equal(refs.instructions[0]!.content, "BUILD OFFLINE ARTICLE V1");
  assert.equal(refs.instructions[0]!.content.includes("MUTATED"), false);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/v2/runtime-library-materializer.test.ts`

Expected: FAIL because `approvedObject()` re-reads the current Library head.

- [ ] **Step 3: Implement snapshot types and stable hashing**

```ts
export type RunLibrarySnapshotV1 = {
  schemaVersion: "southstar.run_library_snapshot.v1";
  runId: string;
  goalContractHash: string;
  manifestHash: string;
  objects: Array<{
    objectKey: string;
    objectKind: LibraryDefinitionKind;
    versionRef: string;
    state: Record<string, unknown>;
    stateHash: string;
    bundleFiles?: Array<{ relativePath: string; contentBase64: string; contentHash: string }>;
  }>;
  snapshotHash: string;
  createdAt: string;
};
```

Add `collectSelectedRefs()` beside `collectSelectedVersionRefs()`. `captureRunLibrarySnapshotPg()` locks each selected `library_objects` row, requires `status = approved`, requires the expected `headVersionId`, copies state, and captures existing skill bundle files with the same safe-root checks already used by `runtime-library-materializer.ts`.

Reject raw credential-looking keys/values before persisting the snapshot. Vault objects may contain policy and lease refs, never secret material.

- [ ] **Step 4: Make run creation transactional**

Wrap run row, task rows, history, coverage resource, and Library snapshot creation in one `db.tx()` inside `createPostgresRunFromDraft()`.

Store these hashes in `runtime_context_json`:

```ts
{
  draftId: input.draftId,
  cwd,
  projectRoot: cwd,
  scope: workflow.domain,
  goalContractHash,
  manifestHash,
  librarySnapshotHash: snapshot.snapshotHash,
  outcomeStatus: "in_progress"
}
```

Populate manifest `compiledFrom` with the selected template definition/version, compiler version, input hash, and every immutable Library version ref. A missing selected object or missing version ref fails before task rows commit.

- [ ] **Step 5: Read snapshot objects during dispatch**

Replace current-head `approvedObject()` calls with snapshot lookup by `input.runId`:

```ts
const snapshot = await loadRunLibrarySnapshotPg(db, input.runId);
const object = requireSnapshotObject(snapshot, instructionRef, "instruction_template");
```

Use captured skill `bundleFiles`; do not read mutable bundle paths after run creation. Keep the current graph read only in snapshot capture.

- [ ] **Step 6: Verify atomicity and immutability**

Run:

```bash
npx tsx tests/v2/manifests.test.ts
npx tsx tests/v2/postgres-run-api.test.ts
npx tsx tests/v2/runtime-library-materializer.test.ts
```

Expected: all commands PASS. The head-mutation regression returns v1 content and a missing version ref leaves no run/task rows.

- [ ] **Step 7: Commit**

```bash
git add src/v2/orchestration/run-library-snapshot.ts src/v2/orchestration/composition-selection-summary.ts src/v2/orchestration/composition-compiler.ts src/v2/orchestration/runtime-library-materializer.ts src/v2/ui-api/postgres-run-api.ts src/v2/manifests/types.ts src/v2/manifests/validate.ts tests/v2/runtime-library-materializer.test.ts tests/v2/postgres-run-api.test.ts tests/v2/manifests.test.ts
git commit -m "feat: freeze run library snapshots"
```

---

### Task 5: Persist Independent Requirement Evidence

**Files:**
- Create: `src/v2/evaluators/requirement-evaluator-results.ts`
- Modify: `src/v2/artifacts/artifact-ref-store.ts`
- Modify: `src/v2/executor/postgres-tork-callback.ts`
- Modify: `tests/v2/artifact-ref-store.test.ts`
- Modify: `tests/v2/postgres-tork-callback.test.ts`
- Modify: `tests/v2/completion-gate.test.ts`

**Interfaces:**
- Consumes: run-scoped `goal_requirement_coverage`, existing `buildEvidencePacket()`, `evidenceValidatorResult()`, callback artifact, and deterministic artifact-ref identity.
- Produces: `evidence_packet`, `validator_result`, and `requirement_evaluator_result` runtime resources linked from the callback artifact.

- [ ] **Step 1: Write failing verifier callback tests**

```ts
test("verifier callback persists requirement evidence and evaluator result", async () => {
  const result = await ingestTaskRunResultPg(db, verifierCallback({
    runId: "run-requirement-evidence",
    taskId: "task-verify",
    artifact: {
      kind: "verification_report",
      pass: true,
      commandsRun: ["npm test"],
      testResults: [{ command: ["npm", "test"], status: "passed" }],
      verifiedArtifactRefs: ["artifact_ref:run-requirement-evidence:task-build:attempt-1:abc"],
    },
  }));

  assert.equal(result.accepted, true);
  const evaluator = await getResourceByKeyPg(db, "requirement_evaluator_result", "requirement:run-requirement-evidence:req-offline:task-verify");
  assert.equal(evaluator!.status, "passed");
  assert.deepEqual((evaluator!.payload as any).requirementIds, ["req-offline"]);
  assert.equal((evaluator!.payload as any).evidenceRefs.length > 0, true);
});

test("missing required evidence rejects an otherwise ok verifier callback", async () => {
  const result = await ingestTaskRunResultPg(db, verifierCallback({
    runId: "run-requirement-missing-evidence",
    taskId: "task-verify",
    artifact: { kind: "verification_report", pass: true },
  }));
  assert.equal(result.accepted, false);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/v2/postgres-tork-callback.test.ts`

Expected: FAIL because callback ingestion currently writes empty `evidenceRefs` and `evaluatorResultRefs`.

- [ ] **Step 3: Export deterministic artifact identity**

Add a pure helper and use it inside `acceptOrRejectArtifactRefPg()`:

```ts
export function artifactRefIdentity(input: {
  runId: string;
  taskId: string;
  attemptId: string;
  content: unknown;
}): { artifactRefId: string; contentHash: string } {
  const contentHash = sha256Stable(input.content);
  return {
    contentHash,
    artifactRefId: `artifact_ref:${input.runId}:${input.taskId}:${input.attemptId}:${contentHash}`,
  };
}
```

- [ ] **Step 4: Build per-requirement evaluator resources before artifact finalization**

```ts
export type RequirementEvaluatorResultV1 = {
  schemaVersion: "southstar.requirement_evaluator_result.v1";
  requirementIds: string[];
  artifactRefs: string[];
  evaluatorId: string;
  evaluatorTaskId: string;
  evaluatorProfileRef: string;
  verdict: "passed" | "failed" | "blocked";
  evidenceRefs: string[];
  findings: string[];
};
```

`recordRequirementEvaluatorResultsPg()` loads coverage entries for the current evaluator task, builds one EvidencePacket per entry, runs `evidenceValidatorResult()`, persists both resources, then persists the requirement result. It returns `{ ok, evidenceRefs, evaluatorResultRefs, findings }`.

The verdict is `passed` only when callback `ok` is true, required producer artifact refs exist and are accepted, all required evidence kinds are present, and every blocking validator result passed.

- [ ] **Step 5: Feed evidence into artifact acceptance and repair**

In callback ingestion:

```ts
const identity = artifactRefIdentity({
  runId: result.runId,
  taskId: result.taskId,
  attemptId,
  content: result.artifact,
});
const requirementEvaluation = await recordRequirementEvaluatorResultsPg(tx, {
  runId: result.runId,
  taskId: result.taskId,
  artifactRefId: identity.artifactRefId,
  artifact: result.artifact,
  callbackOk: result.ok,
});
const accepted = result.ok && requirementEvaluation.ok;
```

Pass the returned evidence/result refs to `acceptOrRejectArtifactRefPg()`. Use `accepted` for task status, executor binding, dynamic repair, and completion-gate decisions. A worker's own `ok: true` cannot override missing evidence.

- [ ] **Step 6: Verify evidence persistence and idempotency**

Run:

```bash
npx tsx tests/v2/artifact-ref-store.test.ts
npx tsx tests/v2/postgres-tork-callback.test.ts
npx tsx tests/v2/completion-gate.test.ts
```

Expected: all commands PASS; replaying the same callback creates no duplicate evidence/evaluator resources or history events.

- [ ] **Step 7: Commit**

```bash
git add src/v2/evaluators/requirement-evaluator-results.ts src/v2/artifacts/artifact-ref-store.ts src/v2/executor/postgres-tork-callback.ts tests/v2/artifact-ref-store.test.ts tests/v2/postgres-tork-callback.test.ts tests/v2/completion-gate.test.ts
git commit -m "feat: persist requirement evaluator evidence"
```

---

### Task 6: Separate Execution, Outcome, And Health; Bound Repair

**Files:**
- Modify: `src/v2/evaluators/completion-gate.ts`
- Modify: `src/v2/runtime-revision/dynamic-repair-revision.ts`
- Modify: `src/v2/executor/postgres-tork-callback.ts`
- Modify: `src/v2/stores/postgres-runtime-store.ts`
- Modify: `tests/v2/completion-gate.test.ts`
- Modify: `tests/v2/completion-gate-exceptions.test.ts`
- Modify: `tests/v2/runtime-dynamic-workflow-revision.test.ts`
- Modify: `tests/v2/index.test.ts`

**Interfaces:**
- Consumes: accepted artifacts, coverage, requirement evaluator results, runtime exceptions, approval hashes, Library snapshot, and existing dynamic-repair round limits.
- Produces: `goal_outcome` resource with `in_progress | satisfied | unsatisfied | blocked`; execution lifecycle ends at `completed`; operational health remains a read-model projection.

- [ ] **Step 1: Write failing status-axis tests**

```ts
test("completion reports satisfied separately from degraded operational health", async () => {
  await seedCoveredRunWithPassedEvidence(db, "run-satisfied-degraded");
  await seedWarningRuntimeException(db, "run-satisfied-degraded");

  const result = await evaluateRunCompletionGatePg(db, { runId: "run-satisfied-degraded" });

  assert.equal(result.executionStatus, "completed");
  assert.equal(result.outcomeStatus, "satisfied");
  assert.equal((await runStatus(db, "run-satisfied-degraded")).status, "completed");
  assert.equal((await outcomeResource(db, "run-satisfied-degraded")).status, "satisfied");
});

test("completion cannot satisfy an uncovered blocking requirement", async () => {
  await seedRunWithUncoveredRequirement(db, "run-uncovered");
  const result = await evaluateRunCompletionGatePg(db, { runId: "run-uncovered" });
  assert.equal(result.outcomeStatus, "unsatisfied");
  assert.match(result.findings.join("\n"), /req-uncovered/);
});

test("repair targets the failed requirement without requeueing accepted sibling branches", async () => {
  await seedCompoundRunWithFailedBillingEvidence(db, "run-targeted-repair");

  const revision = await maybeApplyDynamicRepairRevisionPg(db, {
    runId: "run-targeted-repair",
    failedTaskId: "task-verify-billing",
    failedArtifactRefId: "artifact-ref:billing-verification",
    failedArtifact: failedBillingEvidence(),
    workflowComposer: fixedBillingRepairComposer(),
  });

  if (revision.status !== "applied") assert.fail(`expected applied repair, got ${revision.status}`);
  const appended = await workflowTasksByIds(db, "run-targeted-repair", revision.newTaskIds);
  assert.equal(appended.every((task) => task.requirementIds.includes("req-billing")), true);
  assert.equal(appended.some((task) => task.requirementIds.includes("req-access")), false);
  assert.equal((await taskStatus(db, "run-targeted-repair", "task-access")).status, "completed");
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/v2/completion-gate.test.ts`

Expected: FAIL because run status currently becomes `passed` or `failed` and coverage is not the outcome gate.

- [ ] **Step 3: Make completion coverage-first**

Change the public result contract:

```ts
export type CompletionGateResult = {
  runId: string;
  executionStatus: "completed" | "not_ready";
  outcomeStatus: "in_progress" | "satisfied" | "unsatisfied" | "blocked";
  findings: string[];
};
```

For every blocking coverage entry, require at least one accepted producer artifact and a passed `requirement_evaluator_result` from an independent evaluator task. Persist:

```ts
await upsertRuntimeResourcePg(tx, {
  id: `goal-outcome:${input.runId}`,
  resourceType: "goal_outcome",
  resourceKey: `goal-outcome:${input.runId}`,
  runId: input.runId,
  scope: "outcome",
  status: outcomeStatus,
  title: `Goal outcome ${input.runId}`,
  payload: { outcomeStatus, coveredRequirementIds, failedRequirementIds, findings },
  summary: { covered: coveredRequirementIds.length, total: coverage.entries.length },
});
```

Set `workflow_runs.status = completed` only when final evaluation is terminal. Keep `evaluating` while repair/reverification remains possible.

Only critical unresolved runtime exceptions make outcome `blocked`. Warning-level stale callbacks or provider observations leave logical outcome evaluation intact and project operational health as `degraded`.

- [ ] **Step 4: Preserve authority and coverage during repair**

Before applying a dynamic repair revision:

- load Goal Contract, coverage, manifest hash, Library snapshot hash, and approved side-effect envelope;
- compile the repair with the same Goal Contract;
- reject removal of any blocking requirement;
- require repair and reverify nodes to carry the failed requirement ids;
- leave accepted artifacts, evaluator results, coverage entries, and completed sibling branches unchanged;
- reject refs absent from the run snapshot;
- if new side effects, tool/MCP/vault refs, or mounts are required, persist a new hash-bound approval and return `waiting_operator_approval` without changing the manifest;
- keep the existing configured max round count.

Persist repair coverage as a new revision while keeping old coverage and evaluator results auditable.

- [ ] **Step 5: Verify outcome and bounded repair**

Run:

```bash
npx tsx tests/v2/completion-gate.test.ts
npx tsx tests/v2/completion-gate-exceptions.test.ts
npx tsx tests/v2/runtime-dynamic-workflow-revision.test.ts
npx tsx tests/v2/postgres-tork-callback.test.ts
```

Expected: all commands PASS. A failed requirement either gets bounded repair/reverification or becomes `unsatisfied`; repair nodes carry only the failed requirement ids, completed sibling branches remain completed, and terminal tasks alone never imply `satisfied`.

- [ ] **Step 6: Commit**

```bash
git add src/v2/evaluators/completion-gate.ts src/v2/runtime-revision/dynamic-repair-revision.ts src/v2/executor/postgres-tork-callback.ts src/v2/stores/postgres-runtime-store.ts tests/v2/completion-gate.test.ts tests/v2/completion-gate-exceptions.test.ts tests/v2/runtime-dynamic-workflow-revision.test.ts tests/v2/index.test.ts
git commit -m "feat: gate outcomes on requirement evidence"
```

---

### Task 7: One-Prompt Submission, Idempotency, Approval, And Auto-Scheduling

**Files:**
- Create: `src/v2/orchestration/run-goal-service.ts`
- Create: `src/v2/approvals/postgres-approval-service.ts`
- Modify: `src/v2/approvals/policy.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/planner-routes.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `src/v2/server/client.ts`
- Modify: `src/v2/server/run-execution-controller.ts`
- Modify: `src/v2/cli.ts`
- Create: `tests/v2/run-goal-service.test.ts`
- Modify: `tests/v2/index.test.ts`
- Modify: `tests/v2/runtime-api-client-alignment.test.ts`
- Modify: `tests/v2/run-execution-controller.test.ts`
- Modify: `tests/v2/cli-operations.test.ts`

**Interfaces:**
- Consumes: planner draft/run transaction, `evaluateApprovalPolicy()`, immutable hashes, and `startRunSchedulingPg()`.
- Produces: idempotent `submitGoalPg()` plus JSON/SSE `/api/v2/run-goal` response.

- [ ] **Step 1: Write failing low-risk, high-risk, ambiguity, and replay tests**

```ts
test("low-risk run-goal auto-schedules in one call", async () => {
  const result = await submitGoalPg(context, {
    goalPrompt: "Add unit tests for the parser",
    cwd: "/workspace/project",
    idempotencyKey: "goal-low-risk-1",
  });

  assert.equal(result.draftStatus, "validated");
  assert.equal(result.runStatus, "scheduling");
  assert.ok(result.runId);
  assert.equal((await approvalResource(db, result.approvalId!)).status, "approved");
});

test("high-risk run-goal persists approval and does not schedule", async () => {
  const result = await submitGoalPg(highRiskContext, {
    goalPrompt: "Deploy the service to production",
    cwd: "/workspace/project",
    idempotencyKey: "goal-high-risk-1",
  });

  assert.equal(result.runStatus, "awaiting_approval");
  assert.equal((await runRow(db, result.runId!)).status, "awaiting_approval");
  assert.equal(await schedulingStartedCount(db, result.runId!), 0);
});

test("selected authority triggers approval even when the LLM omits a risk tag", async () => {
  const result = await submitGoalPg(contextSelectingDeploymentTool, {
    goalPrompt: "Release this service",
    cwd: "/workspace/project",
    idempotencyKey: "goal-derived-risk-1",
  });
  assert.equal(result.runStatus, "awaiting_approval");
  assert.equal((await approvalResource(db, result.approvalId!)).payload_json.riskTags.includes("deployment"), true);
});

test("replaying an idempotency key returns the same run", async () => {
  const first = await submitGoalPg(context, request);
  const second = await submitGoalPg(context, request);
  assert.deepEqual(second, first);
  assert.equal(await runCountForGoalSubmission(db, request.idempotencyKey), 1);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/v2/run-goal-service.test.ts`

Expected: FAIL because the service does not exist and the route neither preserves cwd nor schedules.

- [ ] **Step 3: Implement idempotent submission claims**

```ts
export type RunGoalRequest = {
  goalPrompt: string;
  cwd: string;
  idempotencyKey: string;
};

export type RunGoalResult = {
  goalContractHash: string;
  draftId: string;
  draftStatus: "needs_input" | "invalid" | "validated";
  runId?: string;
  runStatus?: "awaiting_approval" | "scheduling";
  approvalId?: string;
  blockers: string[];
};
```

Claim `runtime_resources(resource_type = 'goal_submission', resource_key = idempotencyKey)` atomically and store a request hash:

```sql
insert into southstar.runtime_resources (
  id, resource_type, resource_key, scope, status, title, payload_json, summary_json, metrics_json
) values ($1, 'goal_submission', $2, 'planner', 'processing', 'Goal submission', $3::jsonb, '{}'::jsonb, '{}'::jsonb)
on conflict (resource_type, resource_key) do nothing
returning id;
```

A conflicting key with a different request hash returns `409`; a completed identical claim returns its persisted result; an active identical claim returns `202` with the durable submission id.

- [ ] **Step 4: Persist approval with exact hashes inside run creation**

Move generic approval create/decide logic out of `server/routes.ts` into `approvals/postgres-approval-service.ts`. Add action type `goalExecution`.

Derive effective risk from both the Goal Contract and the compiled authority envelope. Tool/MCP/vault/mount metadata can add `secret-access`, `external-write`, `deployment`, `delete`, `cost-high`, or `production-change`; LLM output can never remove these tags.

```ts
const effectiveRiskTags = deriveGoalExecutionRiskTags({ goalContract, workflow, librarySnapshot });
const policy = evaluateApprovalPolicy({
  mode: "policy",
  actionType: "goalExecution",
  riskTags: effectiveRiskTags,
});
```

The approval payload must contain:

```ts
{
  actionType: "goalExecution",
  decisionMode: policy.decisionMode,
  policyReason: policy.reason,
  riskTags: effectiveRiskTags,
  requestedSideEffects: goalContract.requestedSideEffects,
  goalContractHash,
  manifestHash,
  librarySnapshotHash,
  sideEffectEnvelopeHash,
}
```

Run rows, task rows, coverage resource, Library snapshot, approval resource, approval history, and final goal-submission result commit in one transaction.

- [ ] **Step 5: Schedule only after commit**

For auto-approved low-risk runs, call `startRunSchedulingPg()` after the transaction commits. For pending approval, leave run status `awaiting_approval`.

On manual approval, lock the approval/run, compare all four hashes to current persisted state, update run to `created`, commit the approval, then call `startRunSchedulingPg()`. Rejected approvals leave the run non-runnable.

If scheduler wakeup fails, record a runtime exception against the existing run and return its durable id; never create a replacement run.

- [ ] **Step 6: Deepen JSON and SSE `/api/v2/run-goal`**

Require `goalPrompt`, `cwd`, and `idempotencyKey`. When `Accept` contains `text/event-stream`, stream persisted stages:

```text
goal_contract.interpreted
draft.persisted
coverage.validated
library_snapshot.persisted
approval.persisted
run.scheduling_started | run.awaiting_approval | draft.needs_input
done
```

Reuse the existing planner heartbeat/frame format. The final `done` data contains the same `RunGoalResult` returned by JSON.

- [ ] **Step 7: Align CLI and runtime client**

`run-goal` accepts optional `--cwd` and defaults to `process.cwd()`. The CLI supplies `crypto.randomUUID()` as the idempotency key. Update client request/result types and alignment fixtures.

- [ ] **Step 8: Verify submission lifecycle**

Run:

```bash
npx tsx tests/v2/run-goal-service.test.ts
npx tsx tests/v2/run-execution-controller.test.ts
npx tsx tests/v2/runtime-api-client-alignment.test.ts
npx tsx tests/v2/cli-operations.test.ts
```

Expected: all commands PASS. Low-risk reaches `scheduling`; high-risk has no scheduling event; ambiguity has no run; replay creates one run.

- [ ] **Step 9: Commit**

```bash
git add src/v2/orchestration/run-goal-service.ts src/v2/approvals/postgres-approval-service.ts src/v2/approvals/policy.ts src/v2/ui-api/postgres-run-api.ts src/v2/server/planner-routes.ts src/v2/server/routes.ts src/v2/server/client.ts src/v2/server/run-execution-controller.ts src/v2/cli.ts tests/v2/run-goal-service.test.ts tests/v2/index.test.ts tests/v2/runtime-api-client-alignment.test.ts tests/v2/run-execution-controller.test.ts tests/v2/cli-operations.test.ts
git commit -m "feat: submit and schedule goals in one request"
```

---

### Task 8: Project Goal Contract, Coverage, Outcome, And Health Read Models

**Files:**
- Modify: `src/v2/read-models/workflow-ui.ts`
- Modify: `src/v2/read-models/operator-overview.ts`
- Modify: `src/v2/read-models/operator-attention.ts`
- Modify: `tests/v2/workflow-ui-read-model.test.ts`
- Modify: `tests/v2/operator-overview-read-model.test.ts`
- Modify: `tests/v2/operator-task-debug-read-model.test.ts`

**Interfaces:**
- Consumes: planner/run Goal Contract, coverage, approvals, evaluator results, goal outcome, run lifecycle, and unresolved exceptions.
- Produces: one read-only `mission` projection used by Workflow and Operator.

- [ ] **Step 1: Write failing projection tests**

```ts
test("workflow read model exposes one answer-first mission projection", async () => {
  const model = await buildWorkflowUiReadModelPg(db, { runId: "run-mission" });
  assert.equal(model.mission.goalContract.summary, "Create an offline HTML article");
  assert.deepEqual(model.mission.status, {
    execution: "completed",
    outcome: "satisfied",
    health: "degraded",
  });
  assert.deepEqual(model.mission.coverage, { covered: 2, total: 2, failedRequirementIds: [] });
  assert.equal(model.mission.approval!.goalContractHash, model.mission.goalContractHash);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/v2/workflow-ui-read-model.test.ts`

Expected: FAIL because `WorkflowUiReadModel` has no mission projection.

- [ ] **Step 3: Add the shared mission projection**

```ts
export type GoalMissionReadModel = {
  goalContract: GoalContractV1;
  goalContractHash: string;
  coverage: {
    covered: number;
    total: number;
    failedRequirementIds: string[];
    entries: GoalRequirementCoverageV1["entries"];
  };
  status: {
    execution: string;
    outcome: "in_progress" | "satisfied" | "unsatisfied" | "blocked";
    health: "healthy" | "degraded" | "critical";
  };
  approval: null | {
    id: string;
    status: string;
    goalContractHash: string;
    manifestHash: string;
    librarySnapshotHash: string;
  };
  evaluatorResults: unknown[];
  blockers: string[];
  provenance: {
    originalPrompt: string;
    revision: number;
    promptHash: string;
    manifestHash?: string;
    librarySnapshotHash?: string;
  };
};
```

Draft and runtime builders both use the same projection helper. Health derives from unresolved runtime exceptions and stale provider observations; it does not overwrite outcome.

- [ ] **Step 4: Add Operator outcome/health fields and attention items**

Operator run rows expose `executionStatus`, `outcomeStatus`, and `healthStatus`. Pending goal approvals, uncovered requirements, failed requirements, and authority-expanding repair approvals become attention items with existing approval commands.

Project filtering remains explicit; an empty project-filtered view reports its scope.

- [ ] **Step 5: Verify read models**

Run:

```bash
npx tsx tests/v2/workflow-ui-read-model.test.ts
npx tsx tests/v2/operator-overview-read-model.test.ts
npx tsx tests/v2/operator-task-debug-read-model.test.ts
```

Expected: all commands PASS and a satisfied/degraded run retains both values.

- [ ] **Step 6: Commit**

```bash
git add src/v2/read-models/workflow-ui.ts src/v2/read-models/operator-overview.ts src/v2/read-models/operator-attention.ts tests/v2/workflow-ui-read-model.test.ts tests/v2/operator-overview-read-model.test.ts tests/v2/operator-task-debug-read-model.test.ts
git commit -m "feat: project goal mission read models"
```

---

### Task 9: Make Workflow UI One-Prompt By Default

**Files:**
- Create: `web/components/GoalContractCard.tsx`
- Create: `web/components/GoalContractInspector.tsx`
- Modify: `web/app/api/workflow/generate/route.ts`
- Modify: `web/lib/workflow/generate-stream.ts`
- Modify: `web/lib/workflow/types.ts`
- Modify: `web/lib/workflow/v2-library-adapter.ts`
- Modify: `web/hooks/useAgentSession.ts`
- Modify: `web/hooks/useWorkflowLifecycle.ts`
- Modify: `web/components/WorkflowDagBlock.tsx`
- Modify: `web/components/MessageView.tsx`
- Modify: `web/components/ChatWindow.tsx`
- Modify: `web/components/AppShell.tsx`
- Modify: `web/components/TabBar.tsx`
- Modify: `web/lib/operator/types.ts`
- Modify: `web/lib/operator/normalizers.ts`
- Modify: `web/components/operator/OperatorWorkspace.tsx`
- Modify: `tests/web/southstar-workflow-canvas-ui.test.tsx`
- Modify: `tests/web/southstar-web-operator-control-tower.test.tsx`

**Interfaces:**
- Consumes: `/api/v2/run-goal` SSE and Task 8 `mission` read model.
- Produces: summary card above DAG, read-only Sidecar inspector, automatic low-risk launch, blocking/high-risk actions, and Operator outcome/health display.

- [ ] **Step 1: Write failing browser-component tests**

```tsx
test("Workflow renders Goal Contract receipt and no launch buttons after auto scheduling", async () => {
  render(<WorkflowDagBlock dag={scheduledDagWithMission()} cwd="/workspace/project" />);
  assert.ok(screen.getByTestId("goal-contract-card"));
  assert.match(screen.getByTestId("goal-contract-summary").textContent ?? "", /offline HTML article/);
  assert.equal(screen.queryByTestId("workflow-action-draft"), null);
  assert.equal(screen.queryByTestId("workflow-action-run"), null);
  assert.equal(screen.queryByTestId("workflow-action-execute"), null);
  assert.match(screen.getByTestId("goal-coverage-count").textContent ?? "", /2\/2/);
});

test("Goal Contract card opens the existing Sidecar", async () => {
  render(<AppShellWithMissionFixture />);
  fireEvent.click(screen.getByTestId("goal-contract-open-details"));
  assert.ok(await screen.findByTestId("goal-contract-inspector"));
  assert.match(screen.getByTestId("goal-contract-requirements").textContent ?? "", /opens without network access/);
});
```

- [ ] **Step 2: Run and confirm red**

Run: `npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx`

Expected: FAIL because the DAG block only shows manual lifecycle buttons and there is no contract component.

- [ ] **Step 3: Proxy the one-prompt SSE seam**

Change `web/app/api/workflow/generate/route.ts` to call `/api/v2/run-goal` with `goalPrompt`, `cwd`, and a client idempotency key. Continue converting persisted orchestration into the existing `WorkflowDag` through `buildWorkflowDagFromPlannerDraft()`.

Add stream handlers for `goal_contract`, `coverage`, `run`, and `approval`; retain `draft`, `dag`, `planner.stage`, `message.delta`, `error`, and `done`.

Store mission/run data on `WorkflowDag`:

```ts
export interface WorkflowDag {
  id: string;
  draftId?: string;
  draftStatus?: string;
  runId?: string;
  runStatus?: "awaiting_approval" | "scheduling";
  mode?: "draft" | "runtime";
  mission?: GoalMissionReadModel;
  compositionPlan?: unknown;
  templateId: string;
  templateTitle: string;
  prompt: string;
  expandedByDefault: true;
  readiness: "ready" | "blocked" | "warning";
  nodes: WorkflowDagNode[];
  edges: WorkflowDagEdge[];
  createdAt: string;
}
```

- [ ] **Step 4: Render the summary receipt and pause states**

`GoalContractCard` always shows outcome summary, top acceptance criteria, workspace/scope, deliverables, assumptions, risk/effects, coverage count, execution/outcome/health, and a `Revise goal` action.

Low-risk `scheduling` is informational and has no confirm button. `needs_input` renders exact clarification choices. `awaiting_approval` renders the existing approval command. Do not render raw JSON as the primary view.

Keep Draft/Validate/Create Run/Execute only under an explicit `Review mode` disclosure for operators. Default Workflow never requires these clicks.

- [ ] **Step 5: Open a read-only Sidecar tab**

Add `workflowGoalContract` to `Tab.kind`, plus `draftId`/`runId`. Thread `onGoalContractSelect` through `WorkflowDagBlock -> MessageView -> ChatWindow -> AppShell`.

`GoalContractInspector` fetches `` `/api/workflow/ui?draftId=${encodeURIComponent(draftId)}` `` or `` `/api/workflow/ui?runId=${encodeURIComponent(runId)}` `` and renders grouped sections:

- requirements and acceptance criteria;
- deliverables;
- boundaries/non-goals;
- assumptions/blocking inputs;
- risk/requested side effects;
- coverage/evaluator evidence;
- revisions/provenance and hashes.

- [ ] **Step 6: Show outcome and health separately in Operator**

Normalize Task 8 fields without deriving outcome from execution status. Render separate outcome and health badges in the existing Operator run detail; reuse current approval controls and attention items.

- [ ] **Step 7: Verify Workflow and Operator UI**

Run:

```bash
npx tsx tests/web/southstar-workflow-canvas-ui.test.tsx
npx tsx tests/web/southstar-web-operator-control-tower.test.tsx
npm --prefix web run build
```

Expected: both test commands PASS and Next production build exits 0. No standalone Goal Contract route/page exists.

- [ ] **Step 8: Commit**

```bash
git add web/components/GoalContractCard.tsx web/components/GoalContractInspector.tsx web/app/api/workflow/generate/route.ts web/lib/workflow/generate-stream.ts web/lib/workflow/types.ts web/lib/workflow/v2-library-adapter.ts web/hooks/useAgentSession.ts web/hooks/useWorkflowLifecycle.ts web/components/WorkflowDagBlock.tsx web/components/MessageView.tsx web/components/ChatWindow.tsx web/components/AppShell.tsx web/components/TabBar.tsx web/lib/operator/types.ts web/lib/operator/normalizers.ts web/components/operator/OperatorWorkspace.tsx tests/web/southstar-workflow-canvas-ui.test.tsx tests/web/southstar-web-operator-control-tower.test.tsx
git commit -m "feat: launch goals from one workflow prompt"
```

---

### Task 10: Cross-Domain Library And Real E2E Proof

**Files:**
- Create: `tests/v2/fixtures/design-article-library-graph.ts`
- Create: `tests/e2e-postgres/cases/31-one-prompt-goal-contract-software.test.ts`
- Create: `tests/e2e-postgres/cases/32-one-prompt-goal-contract-article.test.ts`
- Create: `tests/e2e-browser/08-one-prompt-goal-contract-ui.test.ts`
- Modify: `tests/e2e-postgres/index.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: completed Tasks 1–9 and the existing real Postgres/Tork/Pi/browser harness.
- Produces: one software proof, one `design/article` offline-HTML proof, and one browser proof of no launch clicks.

- [ ] **Step 1: Seed an explicit test-only `design/article` graph**

The fixture must insert approved graph primitives, not production seed code:

```ts
export const DESIGN_ARTICLE_GOAL = "Turn input.md into a self-contained article/article.html that opens offline";

export async function seedDesignArticleLibraryGraph(db: SouthstarDb): Promise<void> {
  await seedApprovedObjects(db, [
    articleWorkflowTemplate(),
    articlePlannerAgent(),
    articleBuilderAgent(),
    articleBrowserVerifierAgent(),
    beautifulArticleSkill(),
    workspaceReadTool(),
    workspaceWriteTool(),
    shellTool(),
    browserMcpGrant(),
    articleHtmlArtifactContract(),
    articleBrowserEvaluator(),
  ]);
  await seedApprovedEdges(db, designArticleEdges());
}
```

The evaluator task requires `artifact-ref`, `url`, and `screenshot`; the producer task writes only inside the test workspace. No deployment, push, secret, or network publication is allowed.

- [ ] **Step 2: Add compound software one-prompt real E2E**

Case 31 uses the exact prompt `Deliver a production-ready membership subscription flow in the local test workspace using the provided fake payment adapter, with access control, billing state, cancellation/refund behavior, and audit reporting; do not deploy or charge real accounts`, calls `/api/v2/run-goal` once, asserts low-risk auto approval, waits for scheduling/Tork callbacks, and requires:

- persisted Goal Contract/hash;
- at least four blocking observable requirements, with no requirement named only `plan`, `implement`, `verify`, or `review`;
- complete coverage;
- at least two dependency-independent producer branches and a downstream integration/evaluator wave;
- scheduler history proving the downstream wave is not dispatched before all declared producer dependencies have accepted artifacts;
- immutable Library snapshot/hash;
- passed per-requirement evaluator results;
- execution `completed`;
- outcome `satisfied`;
- no extra draft/validate/run/execute HTTP calls.

Assert topology and semantic invariants rather than exact LLM-generated task ids or task counts. The only fixed ids belong to test-owned Library objects and evaluator fixtures.

- [ ] **Step 3: Add `design/article` real E2E**

Case 32 creates `input.md`, runs the goal, then verifies:

```ts
assert.equal(contract.domain, "design/article");
assert.equal(await fileExists(join(workspace, "article/article.html")), true);
assert.equal(await htmlLoadsWithNetworkDisabled(join(workspace, "article/article.html")), true);
assert.equal(outcome.status, "satisfied");
assert.deepEqual(coverage.entries.flatMap((entry) => entry.requiredEvidenceKinds).includes("screenshot"), true);
```

Mutate a selected Library head after run creation and before a later task dispatch. Assert the later TaskEnvelope still reports the original version/content hash.

- [ ] **Step 4: Add browser one-prompt E2E**

Case 08 submits one low-risk prompt in Workflow mode and observes:

- Goal Contract summary card;
- DAG;
- `scheduling`, then terminal execution;
- coverage/evidence;
- `satisfied` outcome;
- Sidecar contract detail;
- absence of default Draft/Create Run/Execute buttons.

Also submit a high-risk fixture and assert the approval card appears before any Tork job.

- [ ] **Step 5: Add exact scripts**

```json
{
  "test:e2e:postgres:31": "tsx tests/e2e-postgres/cases/31-one-prompt-goal-contract-software.test.ts",
  "test:e2e:postgres:32": "tsx tests/e2e-postgres/cases/32-one-prompt-goal-contract-article.test.ts",
  "test:e2e:browser:08": "tsx tests/e2e-browser/08-one-prompt-goal-contract-ui.test.ts"
}
```

- [ ] **Step 6: Run real gates with explicit infrastructure**

Run:

```bash
npm run southstar:start
npm run southstar:status
npm run test:e2e:postgres:31
npm run test:e2e:postgres:32
npm run test:e2e:browser:08
```

Expected: Southstar managed stack is healthy and all three E2E commands PASS. Capture run ids, contract/manifest/snapshot hashes, evidence resource ids, Tork job ids, and output paths in the implementation handoff.

- [ ] **Step 7: Commit**

```bash
git add tests/v2/fixtures/design-article-library-graph.ts tests/e2e-postgres/cases/31-one-prompt-goal-contract-software.test.ts tests/e2e-postgres/cases/32-one-prompt-goal-contract-article.test.ts tests/e2e-browser/08-one-prompt-goal-contract-ui.test.ts tests/e2e-postgres/index.test.ts package.json
git commit -m "test: prove one-prompt goals across domains"
```

---

### Task 11: Full Verification And Handoff

**Files:**
- Modify only if verification exposes a scoped defect in Tasks 1–10.

**Interfaces:**
- Consumes: all implementation tasks.
- Produces: evidence-backed handoff with modification summary, commands/results, risks, and follow-up recommendations.

- [ ] **Step 1: Run static and focused gates**

```bash
git diff --check
npm run test:v2
npm test
npm --prefix web run build
```

Expected: every command exits 0. If an unrelated pre-existing dirty-worktree failure appears, record the exact command/output and prove whether the implementation branch reproduces it before changing code.

- [ ] **Step 2: Re-run one-prompt real gates**

```bash
npm run test:e2e:postgres:31
npm run test:e2e:postgres:32
npm run test:e2e:browser:08
```

Expected: all commands PASS against a clean managed stack.

- [ ] **Step 3: Audit runtime invariants directly in Postgres**

For the two E2E run ids, verify:

```sql
select id, status, domain, runtime_context_json
from southstar.workflow_runs
where id = any($1::text[]);

select run_id, resource_type, resource_key, status, payload_json
from southstar.runtime_resources
where run_id = any($1::text[])
  and resource_type in (
    'goal_requirement_coverage',
    'run_library_snapshot',
    'approval',
    'evidence_packet',
    'validator_result',
    'requirement_evaluator_result',
    'goal_outcome'
  )
order by run_id, resource_type, resource_key;
```

Expected: hashes agree, every blocking requirement is covered, every selected Library object has a version/state hash, approvals bind exact hashes, and no payload contains credential values.

- [ ] **Step 4: Perform the spec coverage review**

Check AC-01 through AC-20 in `docs/superpowers/specs/2026-07-10-southstar-one-prompt-goal-contract-runtime-design.zh.md`. Record the test or E2E evidence for each criterion. Do not mark implementation complete with an unmapped criterion.

- [ ] **Step 5: Commit any verification-only corrections**

```bash
git status --short
git diff --name-only -z --diff-filter=AM | xargs -0 git add --
git commit -m "fix: close one-prompt verification gaps"
```

Skip this commit when verification required no correction.

---

## Self-Review Results

### Spec coverage

| Design requirement | Implementation task |
|---|---|
| Goal Contract, stable identity, blocking input, revision | Tasks 1–2 |
| Domain-aware approved Library resolution | Task 2 |
| Requirement producer/evaluator/evidence coverage | Task 3 |
| Compound Goal decomposition, parallel DAG branches, execution waves, and targeted repair | Tasks 1, 3, 6, and 10 |
| Immutable Library state and task materialization | Task 4 |
| EvidencePacket, validator, independent evaluator result | Task 5 |
| Outcome satisfaction separate from lifecycle/health | Tasks 6 and 8 |
| Bounded repair and no authority escalation | Task 6 |
| One prompt, idempotency, low-risk auto-run, high-risk approval | Task 7 |
| Workflow receipt, Sidecar detail, no standalone page | Task 9 |
| Software and `design/article` real proofs | Task 10 |
| AC-01 through AC-20 and security audit | Task 11 |

### Intentional simplifications

- No new table: existing `runtime_resources` uniqueness and run-scoped resources cover contracts, submissions, snapshots, approvals, evidence, and outcomes.
- No generic runtime replanner: existing bounded dynamic repair handles failed evidence; authority expansion pauses.
- No first-class `SubGoal` entity or rolling-wave planner: Goal requirements plus task `requirementIds` represent work packages; add a separate model only when sub-goals need independent ownership, approval, reuse, or later-batch planning after new evidence.
- No standalone Contract page: add one only when contracts become reusable/searchable/collaboratively reviewed across runs.
- No explicit-requirement deletion in v1 revision: unchanged explicit requirements are preserved; a replacement goal is required for scope reduction. Add id-addressed removal only when real steering usage demands it.
- No production domain pack seed: cross-domain tests seed approved graph primitives; production content continues through Library file/import/sync.

### Type consistency

- `GoalContractV1` is canonical; `RequirementSpecV2` is a projection.
- `goalContractHash` is copied unchanged into draft, run context, coverage, approval, read model, and E2E assertions.
- `GoalRequirementCoverageV1` uses `EvidenceKind` from existing artifact types.
- `RunLibrarySnapshotV1.snapshotHash` is copied into run context and approval.
- `RequirementEvaluatorResultV1` links requirement ids, producer artifact refs, evaluator task/profile, evidence refs, and verdict.
- Execution status remains on `workflow_runs`; outcome is `goal_outcome`; health is a read-model projection.

# Southstar LLM Orchestrator P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the P1 follow-up design for real library-constrained LLM workflow composition and runtime materialization of selected instruction, skill, tool, MCP, and vault refs.

**Architecture:** Keep the P0 Postgres library graph, candidate resolver, validator, compiler, and fixture composer intact while adding a composer registry, mockable LLM composer, validator repair loop, extended validation, and a runtime library materializer. The LLM remains a proposal source; deterministic validator/compiler/materializer remain runtime authority.

**Tech Stack:** TypeScript, Node 22, `node:test`, Postgres, `pg`, existing Southstar v2 runtime modules, `.git-local`, no vector search, no recursive CTE, no graph DB.

---

## Source Spec

Implement against:

- `docs/superpowers/specs/2026-06-24-southstar-llm-orchestrator-p1-design.md`

Keep the P0 spec and tests green:

- `docs/superpowers/specs/2026-06-23-southstar-library-constrained-llm-orchestrator-design.zh.md`
- `tests/v2/library-candidate-resolver.test.ts`
- `tests/v2/workflow-composition-validator.test.ts`
- `tests/v2/workflow-composition-compiler.test.ts`
- `tests/v2/library-constrained-regression.test.ts`

## File Structure

- Create `src/v2/orchestration/composer-registry.ts`
  - Own concrete composer mode selection.
  - Keep `fixture`, `mock-llm`, `llm`, and fallback behavior outside `postgres-run-api.ts`.

- Modify `src/v2/orchestration/composer.ts`
  - Keep `WorkflowComposer`.
  - Add `ScriptedWorkflowComposer` for tests.
  - Keep `DeterministicFixtureComposer` for P0 compatibility.

- Create `src/v2/orchestration/llm-composer.ts`
  - Define `LlmTextClient`.
  - Render bounded prompt.
  - Parse exactly one `WorkflowCompositionPlan`.
  - Reject malformed, oversized, or non-object outputs.

- Create `src/v2/orchestration/composition-repair-loop.ts`
  - Run compose/validate/repair attempts.
  - Persist no state directly; return trace data to planner API.

- Modify `src/v2/orchestration/composition-validator.ts`
  - Accept scope input.
  - Validate vault refs, produced artifacts, input artifact flow, template slots, and policy conflicts.

- Modify `src/v2/design-library/types.ts`
  - Add P1 validation issue codes.
  - Add materializer-facing payload helper types only if needed by tests.

- Modify `src/v2/design-library/software-library-seed.ts`
  - Enrich seeded object `state` payloads for instruction, skill, tool, MCP, vault, and profile runtime resolution.
  - Add direct edges for vault and MCP where selected.

- Modify `src/v2/orchestration/composition-compiler.ts`
  - Remove role/profile string special-casing.
  - Resolve role/profile/harness-compatible runtime definitions from library object state.
  - Embed resolved roles, profiles, artifact contracts, and evaluator pipelines in compiled manifests when they are not present in the base domain pack.

- Create `src/v2/orchestration/runtime-library-materializer.ts`
  - Resolve selected refs to materialized runtime structures.
  - Never return secret values.

- Modify `src/v2/context/managed-context-assembler.ts`
  - Use materialized instruction and skill content.
  - Include materialized MCP grants and vault lease metadata.

- Modify `src/v2/ui-api/postgres-task-envelope.ts`
  - Use the same materializer for fallback envelope construction.

- Modify `src/v2/agent-runner/task-envelope.ts`
  - Add optional task-scoped `toolProxyPolicy` and `materializedLibraryRefs` fields to `TaskEnvelopeV2`.

- Modify `src/v2/ui-api/postgres-run-api.ts`
  - Add `composerMode`.
  - Use composer registry and repair loop.
  - Persist richer `plannerTrace`.
  - Block run creation from invalid drafts.

- Modify `src/v2/server/routes.ts`
  - Parse and pass `composerMode`.

- Create tests:
  - `tests/v2/workflow-composer-registry.test.ts`
  - `tests/v2/llm-workflow-composer.test.ts`
  - `tests/v2/composition-repair-loop.test.ts`
  - `tests/v2/runtime-library-materializer.test.ts`

- Modify tests:
  - `tests/v2/workflow-composition-validator.test.ts`
  - `tests/v2/workflow-composition-compiler.test.ts`
  - `tests/v2/postgres-run-api.test.ts`
  - `tests/v2/library-constrained-regression.test.ts`
  - `tests/v2/managed-context-assembler.test.ts`
  - `tests/v2/postgres-task-envelope.test.ts`
  - `tests/v2/index.test.ts`
  - `tests/e2e-postgres/cases/28-llm-constrained-workflow-end-to-end.test.ts` or create `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`

## Environment

Use the local Postgres admin URL already established for this repo:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres
```

Use `.git-local` for git commands:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
```

---

### Task 1: Composer Registry And Scripted Composer

**Files:**
- Modify: `src/v2/orchestration/composer.ts`
- Create: `src/v2/orchestration/composer-registry.ts`
- Create: `tests/v2/workflow-composer-registry.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `tests/v2/workflow-composer-registry.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { CandidatePacket, WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { DeterministicFixtureComposer, ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { createWorkflowComposerRegistry } from "../../src/v2/orchestration/composer-registry.ts";

test("composer registry resolves fixture mode without API hardcoding", async () => {
  const registry = createWorkflowComposerRegistry();
  const composer = registry.resolve({ composerMode: "fixture" });
  assert.equal(composer instanceof DeterministicFixtureComposer, true);
});

test("composer registry resolves scripted mock LLM composer for tests", async () => {
  const plan = minimalPlan("mock-task");
  const registry = createWorkflowComposerRegistry({
    llmComposer: new ScriptedWorkflowComposer([plan]),
  });
  const composer = registry.resolve({ composerMode: "llm" });
  const composed = await composer.compose({ goalPrompt: "x", candidatePacket: candidatePacket() });
  assert.deepEqual(composed.tasks.map((task) => task.id), ["mock-task"]);
});

test("composer registry fails closed when llm mode has no configured composer", () => {
  const registry = createWorkflowComposerRegistry();
  assert.throws(
    () => registry.resolve({ composerMode: "llm" }),
    /LLM workflow composer is not configured/,
  );
});

test("composer registry uses explicit fixture fallback only in fallback mode", async () => {
  const failing = {
    async compose(): Promise<WorkflowCompositionPlan> {
      throw new Error("llm unavailable");
    },
  };
  const registry = createWorkflowComposerRegistry({ llmComposer: failing });
  const composer = registry.resolve({ composerMode: "llm-with-fixture-fallback" });
  const composed = await composer.compose({ goalPrompt: "x", candidatePacket: candidatePacket() });
  assert.equal(composed.selectedWorkflowTemplateRef, "template.software-feature");
});

function minimalPlan(taskId: string): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Mock LLM Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "scripted test plan",
    tasks: [{
      id: taskId,
      name: "Mock Task",
      responsibility: "mock",
      dependsOn: [],
      templateSlotRef: "mock",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: "profile.software-explorer-codex",
      instructionRefs: ["instruction.software-explorer"],
      skillRefs: ["skill.software-repo-discovery"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "mock",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function candidatePacket(): CandidatePacket {
  return {
    requirementSpec: {
      summary: "mock",
      workType: "software_feature",
      requiredCapabilities: [],
      expectedArtifacts: [],
      acceptanceCriteria: [],
      nonGoals: [],
      riskNotes: [],
      workspaceAssumptions: [],
      missingInputs: [],
    },
    workflowTemplateCandidates: [],
    agentCandidatesByCapability: {},
    profileCandidatesByAgent: {},
    skillCandidatesByProfile: {},
    toolCandidatesByProfile: {},
    mcpGrantCandidatesByProfile: {},
    instructionCandidatesByProfile: {},
    artifactContractCandidates: [],
    evaluatorCandidatesByArtifact: {},
    policyConstraints: [],
    unavailableRequirements: [],
  };
}
```

Append to `tests/v2/index.test.ts` near the orchestration test imports:

```ts
await import("./workflow-composer-registry.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composer-registry.test.ts
```

Expected: FAIL because `ScriptedWorkflowComposer` and `composer-registry.ts` do not exist.

- [ ] **Step 3: Add scripted composer**

Modify `src/v2/orchestration/composer.ts` by adding this class after `DeterministicFixtureComposer`:

```ts
export class ScriptedWorkflowComposer implements WorkflowComposer {
  private index = 0;

  constructor(private readonly plans: WorkflowCompositionPlan[]) {}

  async compose(_input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const plan = this.plans[Math.min(this.index, this.plans.length - 1)];
    this.index += 1;
    if (!plan) throw new Error("ScriptedWorkflowComposer has no plans");
    return structuredClone(plan);
  }
}
```

- [ ] **Step 4: Add composer registry**

Create `src/v2/orchestration/composer-registry.ts`:

```ts
import type { WorkflowComposer, ComposeWorkflowInput } from "./composer.ts";
import { DeterministicFixtureComposer } from "./composer.ts";

export type WorkflowComposerMode = "fixture" | "llm" | "llm-with-fixture-fallback";

export type ResolveWorkflowComposerInput = {
  composerMode?: WorkflowComposerMode;
};

export type WorkflowComposerRegistryOptions = {
  llmComposer?: WorkflowComposer;
  fixtureComposer?: WorkflowComposer;
};

export type WorkflowComposerRegistry = {
  resolve(input: ResolveWorkflowComposerInput): WorkflowComposer;
};

export function createWorkflowComposerRegistry(options: WorkflowComposerRegistryOptions = {}): WorkflowComposerRegistry {
  const fixtureComposer = options.fixtureComposer ?? new DeterministicFixtureComposer();
  return {
    resolve(input) {
      const mode = input.composerMode ?? "fixture";
      if (mode === "fixture") return fixtureComposer;
      if (mode === "llm") {
        if (!options.llmComposer) throw new Error("LLM workflow composer is not configured");
        return options.llmComposer;
      }
      if (!options.llmComposer) return fixtureComposer;
      return new FallbackWorkflowComposer(options.llmComposer, fixtureComposer);
    },
  };
}

class FallbackWorkflowComposer implements WorkflowComposer {
  constructor(
    private readonly primary: WorkflowComposer,
    private readonly fallback: WorkflowComposer,
  ) {}

  async compose(input: ComposeWorkflowInput) {
    try {
      return await this.primary.compose(input);
    } catch {
      return await this.fallback.compose(input);
    }
  }
}
```

- [ ] **Step 5: Run registry tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composer-registry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/composer.ts \
  src/v2/orchestration/composer-registry.ts \
  tests/v2/workflow-composer-registry.test.ts \
  tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add workflow composer registry"
```

---

### Task 2: LLM Composer Parser And Prompt Contract

**Files:**
- Create: `src/v2/orchestration/llm-composer.ts`
- Create: `tests/v2/llm-workflow-composer.test.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing LLM composer tests**

Create `tests/v2/llm-workflow-composer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { CandidatePacket } from "../../src/v2/design-library/types.ts";
import { LlmWorkflowComposer, parseWorkflowCompositionPlanFromText } from "../../src/v2/orchestration/llm-composer.ts";

test("LLM composer sends bounded candidate packet and parses one composition plan", async () => {
  const calls: string[] = [];
  const composer = new LlmWorkflowComposer({
    model: "test-model",
    maxOutputChars: 20_000,
    client: {
      async generateText(input) {
        calls.push(input.prompt);
        return JSON.stringify(validPlan());
      },
    },
  });

  const plan = await composer.compose({ goalPrompt: "implement calc sum", candidatePacket: candidatePacket() });
  assert.equal(plan.schemaVersion, "southstar.workflow_composition_plan.v1");
  assert.equal(plan.tasks[0]?.id, "understand-repo");
  assert.match(calls[0] ?? "", /select refs only from the candidate packet/i);
  assert.match(calls[0] ?? "", /CandidatePacket/);
});

test("LLM composer parser rejects non JSON output", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText("Here is the plan: {}", 20_000),
    /LLM workflow composer returned non-JSON output/,
  );
});

test("LLM composer parser rejects arrays and wrong schema versions", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText("[]", 20_000),
    /must return a JSON object/,
  );
  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify({ schemaVersion: "wrong" }), 20_000),
    /invalid schemaVersion/,
  );
});

test("LLM composer parser rejects oversized output", () => {
  assert.throws(
    () => parseWorkflowCompositionPlanFromText(JSON.stringify(validPlan()), 10),
    /exceeded max output size/,
  );
});

function validPlan() {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Dynamic Mock Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "mock llm plan",
    tasks: [{
      id: "understand-repo",
      name: "Understand Repo",
      responsibility: "inspect repo",
      dependsOn: [],
      templateSlotRef: "understand",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: "profile.software-explorer-codex",
      instructionRefs: ["instruction.software-explorer"],
      skillRefs: ["skill.software-repo-discovery"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "start with repository discovery",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function candidatePacket(): CandidatePacket {
  return {
    requirementSpec: {
      summary: "implement calc sum",
      workType: "software_feature",
      requiredCapabilities: ["capability.repo-read"],
      expectedArtifacts: ["artifact.implementation_plan"],
      acceptanceCriteria: ["calc sum works"],
      nonGoals: [],
      riskNotes: [],
      workspaceAssumptions: [],
      missingInputs: [],
    },
    workflowTemplateCandidates: [{ ref: "template.software-feature", versionRef: "template.software-feature@v1", kind: "workflow_template", displayName: "Software Feature", state: {}, reason: "test" }],
    agentCandidatesByCapability: {},
    profileCandidatesByAgent: {},
    skillCandidatesByProfile: {},
    toolCandidatesByProfile: {},
    mcpGrantCandidatesByProfile: {},
    instructionCandidatesByProfile: {},
    artifactContractCandidates: [],
    evaluatorCandidatesByArtifact: {},
    policyConstraints: [],
    unavailableRequirements: [],
  };
}
```

Append to `tests/v2/index.test.ts`:

```ts
await import("./llm-workflow-composer.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node_modules/.bin/tsx tests/v2/llm-workflow-composer.test.ts
```

Expected: FAIL because `llm-composer.ts` does not exist.

- [ ] **Step 3: Implement LLM composer**

Create `src/v2/orchestration/llm-composer.ts`:

```ts
import type { CandidatePacket, WorkflowCompositionPlan } from "../design-library/types.ts";
import type { ComposeWorkflowInput, WorkflowComposer } from "./composer.ts";

export type LlmTextClient = {
  generateText(input: { model: string; prompt: string; temperature?: number }): Promise<string>;
};

export type LlmWorkflowComposerOptions = {
  model: string;
  client: LlmTextClient;
  maxOutputChars?: number;
  temperature?: number;
};

export class LlmWorkflowComposer implements WorkflowComposer {
  constructor(private readonly options: LlmWorkflowComposerOptions) {}

  async compose(input: ComposeWorkflowInput): Promise<WorkflowCompositionPlan> {
    const prompt = renderComposerPrompt(input.goalPrompt, input.candidatePacket);
    const text = await this.options.client.generateText({
      model: this.options.model,
      prompt,
      temperature: this.options.temperature ?? 0,
    });
    return parseWorkflowCompositionPlanFromText(text, this.options.maxOutputChars ?? 100_000);
  }
}

export function parseWorkflowCompositionPlanFromText(text: string, maxOutputChars: number): WorkflowCompositionPlan {
  if (text.length > maxOutputChars) {
    throw new Error(`LLM workflow composer output exceeded max output size: ${text.length} > ${maxOutputChars}`);
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("LLM workflow composer returned non-JSON output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`LLM workflow composer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) throw new Error("LLM workflow composer must return a JSON object");
  if (parsed.schemaVersion !== "southstar.workflow_composition_plan.v1") {
    throw new Error("LLM workflow composer returned invalid schemaVersion");
  }
  if (!Array.isArray(parsed.tasks)) throw new Error("LLM workflow composer returned plan without tasks array");
  return parsed as WorkflowCompositionPlan;
}

export function renderComposerPrompt(goalPrompt: string, candidatePacket: CandidatePacket): string {
  return [
    "You are Southstar's library-constrained workflow architect.",
    "Return exactly one JSON object matching schemaVersion southstar.workflow_composition_plan.v1.",
    "Do not return markdown, comments, prose, or multiple JSON objects.",
    "select refs only from the candidate packet.",
    "Do not output runtime manifests, secrets, credentials, tool grant definitions, MCP grant definitions, or vault lease values.",
    "Generated component proposals are proposal-only and cannot be selected in tasks.",
    "",
    `Goal: ${goalPrompt}`,
    "",
    "CandidatePacket:",
    JSON.stringify(boundCandidatePacket(candidatePacket)),
  ].join("\n");
}

function boundCandidatePacket(packet: CandidatePacket): CandidatePacket {
  return {
    ...packet,
    workflowTemplateCandidates: packet.workflowTemplateCandidates.slice(0, 20),
    artifactContractCandidates: packet.artifactContractCandidates.slice(0, 50),
    policyConstraints: packet.policyConstraints.slice(0, 50),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
```

- [ ] **Step 4: Run composer tests**

Run:

```bash
node_modules/.bin/tsx tests/v2/llm-workflow-composer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/llm-composer.ts \
  tests/v2/llm-workflow-composer.test.ts \
  tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add llm workflow composer parser"
```

---

### Task 3: Planner API Uses Registry, Composer Mode, And Invalid Draft Guard

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `src/v2/server/routes.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/library-constrained-regression.test.ts`

- [ ] **Step 1: Write failing API tests for scripted non-fixture composition**

Append this test to `tests/v2/postgres-run-api.test.ts`:

```ts
test("Postgres planner draft can use injected scripted LLM composer for non-fixture DAG shape", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with a single exploration task",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: {
        async compose() {
          return {
            schemaVersion: "southstar.workflow_composition_plan.v1",
            title: "Single Exploration Plan",
            selectedWorkflowTemplateRef: "template.software-feature",
            rationale: "scripted LLM plan for API test",
            tasks: [{
              id: "inspect-only",
              name: "Inspect Only",
              responsibility: "inspect repository and produce a plan",
              dependsOn: [],
              templateSlotRef: "understand",
              agentDefinitionRef: "agent.software-explorer",
              agentProfileRef: "profile.software-explorer-codex",
              instructionRefs: ["instruction.software-explorer"],
              skillRefs: ["skill.software-repo-discovery"],
              toolGrantRefs: ["tool.workspace-read"],
              mcpGrantRefs: [],
              vaultLeasePolicyRefs: [],
              inputArtifactRefs: [],
              outputArtifactRefs: ["artifact.implementation_plan"],
              evaluatorProfileRef: "evaluator.software-plan-quality",
              recoveryStrategyRefs: ["retry-same-agent"],
              rationale: "use only explorer candidate",
            }],
            rejectedCandidates: [],
            generatedComponentProposals: [],
          };
        },
      },
    });

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, ["inspect-only"]);
  });
});
```

Append this invalid draft guard test:

```ts
test("Postgres run creation rejects invalid planner drafts", async () => {
  await withDb(async (db) => {
    await upsertRuntimeResourcePg(db, {
      id: "draft-invalid-test",
      resourceType: "planner_draft",
      resourceKey: "draft-invalid-test",
      scope: "planner",
      status: "invalid",
      title: "Invalid Draft",
      payload: { workflow: { workflowId: "wf-invalid" } },
      summary: { planner: "library-constrained-llm" },
    });
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: "draft-invalid-test" }),
      /planner draft is not validated/,
    );
  });
});
```

Add `upsertRuntimeResourcePg` to the imports at the top of `tests/v2/postgres-run-api.test.ts`:

```ts
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
```

- [ ] **Step 2: Run failing API tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because planner draft input has no `composerMode` or `composer` support and invalid drafts are not blocked.

- [ ] **Step 3: Extend planner draft input**

Modify `src/v2/ui-api/postgres-run-api.ts` imports:

```ts
import type { WorkflowComposer } from "../orchestration/composer.ts";
import { createWorkflowComposerRegistry, type WorkflowComposerMode } from "../orchestration/composer-registry.ts";
```

Change `CreatePostgresPlannerDraftInput`:

```ts
export type CreatePostgresPlannerDraftInput = {
  goalPrompt: string;
  orchestrationMode?: "deterministic" | "llm-constrained";
  composerMode?: WorkflowComposerMode;
  composer?: WorkflowComposer;
};
```

Replace `const composer = new DeterministicFixtureComposer();` in `createLibraryConstrainedPlannerDraft()` with:

```ts
  const registry = createWorkflowComposerRegistry({ llmComposer: input.composer });
  const composer = registry.resolve({ composerMode: input.composerMode ?? "fixture" });
```

Change `plannerTrace.model` for the library constrained bundle:

```ts
      model: `southstar-library-constrained-${input.composerMode ?? "fixture"}-composer`,
```

- [ ] **Step 4: Guard invalid drafts before run creation**

In `createPostgresRunFromDraft()`, after loading `draft`, add:

```ts
  if (draft.status !== "validated") {
    throw new Error(`planner draft is not validated: ${input.draftId}`);
  }
```

- [ ] **Step 5: Pass composerMode through server routes**

Modify `src/v2/server/routes.ts` request bodies for `/api/v2/run-goal` and `/api/v2/planner/drafts`:

```ts
const body = await readJsonBody<{ goalPrompt?: string; orchestrationMode?: unknown; composerMode?: unknown }>(request);
```

Pass:

```ts
composerMode: optionalComposerMode(body.composerMode),
```

Add helper near `optionalOrchestrationMode()`:

```ts
function optionalComposerMode(value: unknown): "fixture" | "llm" | "llm-with-fixture-fallback" | undefined {
  if (value === undefined) return undefined;
  if (value === "fixture" || value === "llm" || value === "llm-with-fixture-fallback") return value;
  throw new Error("composerMode must be fixture, llm, or llm-with-fixture-fallback");
}
```

- [ ] **Step 6: Run API tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Strengthen hardcode regression test**

In `tests/v2/library-constrained-regression.test.ts`, append:

```ts
test("llm-constrained planner API does not directly construct fixture composer", async () => {
  const source = await readFile(new URL("../../src/v2/ui-api/postgres-run-api.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function createLibraryConstrainedPlannerDraft");
  const section = start >= 0 ? source.slice(start) : source;
  assert.equal(section.includes("new DeterministicFixtureComposer"), false);
  assert.equal(section.includes("createWorkflowComposerRegistry"), true);
});
```

- [ ] **Step 8: Run regression tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-constrained-regression.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/ui-api/postgres-run-api.ts \
  src/v2/server/routes.ts \
  tests/v2/postgres-run-api.test.ts \
  tests/v2/library-constrained-regression.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: route planner drafts through composer registry"
```

---

### Task 4: Composition Repair Loop

**Files:**
- Create: `src/v2/orchestration/composition-repair-loop.ts`
- Create: `tests/v2/composition-repair-loop.test.ts`
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing repair loop test**

Create `tests/v2/composition-repair-loop.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { runCompositionRepairLoop } from "../../src/v2/orchestration/composition-repair-loop.ts";
import { ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("composition repair loop repairs invalid refs without weakening validator", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const packet = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composer = new ScriptedWorkflowComposer([invalidPlan(), validPlan()]);

    const result = await runCompositionRepairLoop(db, {
      composer,
      goalPrompt: "implement calc sum",
      candidatePacket: packet,
      scope: "software",
      maxRepairAttempts: 1,
    });

    assert.equal(result.validation.ok, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.validation.ok, false);
    assert.equal(result.composition.tasks[0]?.agentProfileRef, "profile.software-explorer-codex");
  } finally {
    await db.close();
  }
});

function invalidPlan(): WorkflowCompositionPlan {
  const plan = validPlan();
  plan.tasks[0]!.agentProfileRef = "profile.not-approved";
  return plan;
}

function validPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Repair Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "repair loop test",
    tasks: [{
      id: "understand-repo",
      name: "Understand Repo",
      responsibility: "inspect repository",
      dependsOn: [],
      templateSlotRef: "understand",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: "profile.software-explorer-codex",
      instructionRefs: ["instruction.software-explorer"],
      skillRefs: ["skill.software-repo-discovery"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "valid explorer",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}
```

Append to `tests/v2/index.test.ts`:

```ts
await import("./composition-repair-loop.test.ts");
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/composition-repair-loop.test.ts
```

Expected: FAIL because `composition-repair-loop.ts` does not exist.

- [ ] **Step 3: Implement repair loop**

Create `src/v2/orchestration/composition-repair-loop.ts`:

```ts
import type { SouthstarDb } from "../db/postgres.ts";
import type { CandidatePacket, WorkflowCompositionPlan, WorkflowCompositionValidationResult } from "../design-library/types.ts";
import type { WorkflowComposer } from "./composer.ts";
import { validateWorkflowCompositionPlan } from "./composition-validator.ts";

export type CompositionRepairAttempt = {
  attempt: number;
  validation: WorkflowCompositionValidationResult;
  composition: WorkflowCompositionPlan;
};

export type RunCompositionRepairLoopInput = {
  composer: WorkflowComposer;
  goalPrompt: string;
  candidatePacket: CandidatePacket;
  scope: string;
  maxRepairAttempts: number;
};

export type CompositionRepairLoopResult = {
  composition: WorkflowCompositionPlan;
  validation: WorkflowCompositionValidationResult;
  attempts: CompositionRepairAttempt[];
};

export async function runCompositionRepairLoop(
  db: SouthstarDb,
  input: RunCompositionRepairLoopInput,
): Promise<CompositionRepairLoopResult> {
  const attempts: CompositionRepairAttempt[] = [];
  const maxAttempts = Math.max(0, input.maxRepairAttempts);
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const composition = await input.composer.compose({
      goalPrompt: renderRepairGoal(input.goalPrompt, attempts),
      candidatePacket: input.candidatePacket,
    });
    const validation = await validateWorkflowCompositionPlan(db, input.candidatePacket, composition, { scope: input.scope });
    attempts.push({ attempt, validation, composition });
    if (validation.ok) return { composition, validation, attempts };
  }
  const last = attempts[attempts.length - 1];
  if (!last) throw new Error("composition repair loop produced no attempts");
  return { composition: last.composition, validation: last.validation, attempts };
}

function renderRepairGoal(goalPrompt: string, attempts: CompositionRepairAttempt[]): string {
  if (attempts.length === 0) return goalPrompt;
  const latest = attempts[attempts.length - 1]!;
  return [
    goalPrompt,
    "",
    "Previous WorkflowCompositionPlan failed validation.",
    "Return a corrected full WorkflowCompositionPlan using only candidate refs.",
    `Validation issues: ${JSON.stringify(latest.validation.issues)}`,
  ].join("\n");
}
```

- [ ] **Step 4: Update validator signature for scope**

Modify `src/v2/orchestration/composition-validator.ts` signature:

```ts
export type ValidateWorkflowCompositionOptions = {
  scope?: string;
};

export async function validateWorkflowCompositionPlan(
  db: SouthstarDb,
  packet: CandidatePacket,
  plan: WorkflowCompositionPlan,
  options: ValidateWorkflowCompositionOptions = {},
): Promise<WorkflowCompositionValidationResult> {
```

Pass `options.scope ?? "software"` into `validateEdgeConstraints()` and `requireOutgoingEdge()` instead of hardcoded `"software"`.

- [ ] **Step 5: Wire repair loop into planner draft**

In `src/v2/ui-api/postgres-run-api.ts`, import:

```ts
import { runCompositionRepairLoop } from "../orchestration/composition-repair-loop.ts";
```

Replace direct `composer.compose()` in `createLibraryConstrainedPlannerDraft()`:

```ts
  const repairResult = await runCompositionRepairLoop(db, {
    composer,
    goalPrompt: input.goalPrompt,
    candidatePacket,
    scope: "software",
    maxRepairAttempts: 2,
  });
  if (!repairResult.validation.ok) {
    await upsertRuntimeResourcePg(db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "invalid",
      title: "Invalid Library-Constrained Planner Draft",
      payload: { requirementSpec, candidatePacket, repairAttempts: repairResult.attempts },
      summary: { goalPrompt: input.goalPrompt, workflowId, planner: "library-constrained-llm", status: "invalid" },
    });
    return { draftId, goalPrompt: input.goalPrompt, workflowId };
  }
  const composition = repairResult.composition;
```

Add `repairAttempts: repairResult.attempts` to the valid planner bundle payload.

- [ ] **Step 6: Run repair loop and API tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/composition-repair-loop.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/composition-repair-loop.ts \
  src/v2/orchestration/composition-validator.ts \
  src/v2/ui-api/postgres-run-api.ts \
  tests/v2/composition-repair-loop.test.ts \
  tests/v2/postgres-run-api.test.ts \
  tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: add composition repair loop"
```

---

### Task 5: Validator P1 Coverage And Software Library Seed Enrichment

**Files:**
- Modify: `src/v2/design-library/types.ts`
- Modify: `src/v2/design-library/software-library-seed.ts`
- Modify: `src/v2/orchestration/composition-validator.ts`
- Modify: `tests/v2/workflow-composition-validator.test.ts`
- Modify: `tests/v2/library-candidate-resolver.test.ts`

- [ ] **Step 1: Add failing validator tests**

Append to `tests/v2/workflow-composition-validator.test.ts`:

```ts
test("validator rejects vault refs not allowed by selected profile", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[1]!.vaultLeasePolicyRefs = ["vault.github-write-token"];

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "profile_does_not_allow_vault_lease"), true);
  } finally {
    await db.close();
  }
});

test("validator rejects selected artifacts not produced by selected agent", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    const plan = validComposition();
    plan.tasks[0]!.outputArtifactRefs = ["artifact.completion_report"];
    plan.tasks[0]!.evaluatorProfileRef = "evaluator.software-completion-quality";

    const validation = await validateWorkflowCompositionPlan(db, packet, plan, { scope: "software" });
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue) => issue.code === "agent_does_not_produce_artifact"), true);
  } finally {
    await db.close();
  }
});
```

Append to `tests/v2/library-candidate-resolver.test.ts`:

```ts
test("candidate resolver exposes MCP and vault candidates from direct profile edges", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const packet = await resolveWorkflowCandidates(db, {
      requirementSpec: analyzeRequirementDeterministically("implement calc sum"),
      scope: "software",
    });
    assert.equal(packet.mcpGrantCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) => candidate.ref === "mcp.filesystem-workspace"), true);
    assert.equal(packet.vaultLeaseCandidatesByProfile["profile.software-maker-pi"]?.some((candidate) => candidate.ref === "vault.github-write-token"), true);
  } finally {
    await db.close();
  }
});
```

- [ ] **Step 2: Run failing validator tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-validator.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-candidate-resolver.test.ts
```

Expected: FAIL because validator issue codes and `vaultLeaseCandidatesByProfile` do not exist.

- [ ] **Step 3: Extend candidate packet and issue codes**

Modify `src/v2/design-library/types.ts` `CandidatePacket`:

```ts
  vaultLeaseCandidatesByProfile: Record<string, CandidateSummary[]>;
```

Add issue codes:

```ts
  | "profile_does_not_allow_vault_lease"
  | "agent_does_not_produce_artifact"
  | "input_artifact_not_satisfied"
  | "template_slot_not_allowed"
  | "policy_conflict";
```

- [ ] **Step 4: Extend resolver for vault candidates**

In `src/v2/orchestration/candidate-resolver.ts`, add:

```ts
  const vaultLeaseCandidatesByProfile: Record<string, CandidateSummary[]> = {};
```

Inside the profile loop:

```ts
      vaultLeaseCandidatesByProfile[profileCandidate.ref] = await linkedSummaries(
        db,
        profileCandidate.ref,
        "requires_secret_group",
        input.scope,
      );
```

Return it:

```ts
    vaultLeaseCandidatesByProfile,
```

- [ ] **Step 5: Enrich software seed with MCP and vault objects**

Modify `src/v2/design-library/software-library-seed.ts` `SOFTWARE_OBJECTS` with:

```ts
{
  objectKey: "mcp.filesystem-workspace",
  objectKind: "mcp_tool_grant",
  state: {
    displayName: "Filesystem Workspace MCP",
    serverId: "filesystem-workspace",
    allowedTools: ["read_file", "write_file", "list_files"],
    sideEffect: "write",
    requiresApproval: false,
  },
},
{
  objectKey: "vault.github-write-token",
  objectKind: "vault_lease_policy",
  state: {
    displayName: "GitHub write token lease policy",
    secretGroupRef: "github.write",
    leaseTtlSeconds: 900,
    mountMode: "proxy-only",
    allowedToolRefs: ["tool.shell-command"],
    auditRequired: true,
  },
},
```

Add edges:

```ts
{
  fromObjectKey: "profile.software-maker-pi",
  edgeType: "allows_mcp_grant",
  toObjectKey: "mcp.filesystem-workspace",
},
{
  fromObjectKey: "profile.software-maker-pi",
  edgeType: "requires_secret_group",
  toObjectKey: "vault.github-write-token",
},
```

- [ ] **Step 6: Extend validator edge checks**

In `src/v2/orchestration/composition-validator.ts`, inside `validateEdgeConstraints()`:

```ts
    for (const vaultRef of task.vaultLeasePolicyRefs) {
      await requireOutgoingEdge(
        db,
        task.agentProfileRef,
        "requires_secret_group",
        vaultRef,
        issues,
        "profile_does_not_allow_vault_lease",
        `tasks.${taskIndex}.vaultLeasePolicyRefs`,
        scope,
      );
    }
    for (const artifactRef of task.outputArtifactRefs) {
      await requireOutgoingEdge(
        db,
        task.agentDefinitionRef,
        "produces_artifact",
        artifactRef,
        issues,
        "agent_does_not_produce_artifact",
        `tasks.${taskIndex}.outputArtifactRefs`,
        scope,
      );
    }
```

Make `requireOutgoingEdge()` accept `scope: string`:

```ts
  scope: string,
): Promise<void> {
  const edges = await findLibraryEdgesFrom(db, fromRef, edgeType, { scope });
```

- [ ] **Step 7: Update candidate refs helper**

In `candidateRefs()`, add:

```ts
  for (const candidates of Object.values(packet.vaultLeaseCandidatesByProfile)) for (const candidate of candidates) refs.add(candidate.ref);
```

- [ ] **Step 8: Update CandidatePacket literals added by earlier tasks**

Add this property to every local `CandidatePacket` literal introduced in this plan, including `tests/v2/workflow-composer-registry.test.ts` and `tests/v2/llm-workflow-composer.test.ts`:

```ts
    vaultLeaseCandidatesByProfile: {},
```

Run this check and update any remaining literals that fail TypeScript:

```bash
rg -n "mcpGrantCandidatesByProfile|instructionCandidatesByProfile|vaultLeaseCandidatesByProfile" tests/v2 src/v2/orchestration
```

Expected: every `CandidatePacket` literal has `vaultLeaseCandidatesByProfile`.

- [ ] **Step 9: Run validator and resolver tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-candidate-resolver.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-validator.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/design-library/types.ts \
  src/v2/design-library/software-library-seed.ts \
  src/v2/orchestration/candidate-resolver.ts \
  src/v2/orchestration/composition-validator.ts \
  tests/v2/library-candidate-resolver.test.ts \
  tests/v2/workflow-composition-validator.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: extend composition validation for runtime permissions"
```

---

### Task 6: Compiler Resolves Runtime Definitions Without String Heuristics

**Files:**
- Modify: `src/v2/design-library/software-library-seed.ts`
- Modify: `src/v2/orchestration/composition-compiler.ts`
- Modify: `tests/v2/workflow-composition-compiler.test.ts`
- Modify: `tests/v2/library-constrained-regression.test.ts`

- [ ] **Step 1: Write failing compiler tests**

Append to `tests/v2/workflow-composition-compiler.test.ts`:

```ts
test("compiler embeds reviewer roles and profiles without normalizing to checker profile", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const packet = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({ goalPrompt: "implement calc sum", candidatePacket: packet });
    const compiled = await compileWorkflowComposition(db, {
      runId: "compile-reviewer-profile",
      goalPrompt: "implement calc sum",
      candidatePacket: packet,
      composition,
    });

    const specTask = compiled.workflow.tasks.find((task) => task.id === "review-spec");
    const qualityTask = compiled.workflow.tasks.find((task) => task.id === "review-code-quality");
    assert.equal(specTask?.agentProfileRef, "software-spec-reviewer-codex");
    assert.equal(qualityTask?.agentProfileRef, "software-code-quality-reviewer-codex");
    assert.equal(compiled.workflow.roles?.some((role) => role.id === "spec-reviewer"), true);
    assert.equal(compiled.workflow.agentProfiles?.some((profile) => profile.id === "software-spec-reviewer-codex"), true);
  } finally {
    await db.close();
  }
});
```

Append to `tests/v2/library-constrained-regression.test.ts`:

```ts
test("composition compiler does not contain reviewer profile normalization branches", async () => {
  const source = await readFile(new URL("../../src/v2/orchestration/composition-compiler.ts", import.meta.url), "utf8");
  assert.equal(source.includes("profile.software-spec-reviewer-codex"), false);
  assert.equal(source.includes("profile.software-code-quality-reviewer-codex"), false);
  assert.equal(source.includes("role === \"spec-reviewer\""), false);
});
```

- [ ] **Step 2: Run failing compiler tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-compiler.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-constrained-regression.test.ts
```

Expected: FAIL because compiler normalizes reviewer profiles to checker.

- [ ] **Step 3: Enrich seed profile state**

In `src/v2/design-library/software-library-seed.ts`, add runtime payload fields to every seeded `agent_definition`:

```ts
state: {
  role: "spec-reviewer",
  runtimeRole: {
    id: "spec-reviewer",
    responsibility: "Review the implementation plan for requirement coverage before code changes.",
    defaultAgentProfileRef: "software-spec-reviewer-codex",
    allowedAgentProfileRefs: ["software-spec-reviewer-codex"],
    artifactInputs: ["implementation_plan"],
    artifactOutputs: ["implementation_plan"],
    stopAuthority: "can-reject",
  },
}
```

Use equivalent `runtimeRole` payloads for explorer, maker, checker, code-quality-reviewer, and summarizer.

Add runtime payload fields to every seeded `agent_profile`:

```ts
state: {
  provider: "codex",
  model: "gpt-5-codex",
  role: "spec-reviewer",
  runtimeProfile: {
    id: "software-spec-reviewer-codex",
    name: "Software Spec Reviewer",
    provider: "codex",
    model: "gpt-5-codex",
    harnessRef: "codex",
    agentsMdRefs: ["repo:AGENTS.md"],
    promptTemplateRef: "software-spec-reviewer",
    skillRefs: ["software.spec-review"],
    mcpGrantRefs: [],
    memoryScopes: ["software", "project"],
    contextPolicyRef: "software-context-default",
    sessionPolicyRef: "software-session-default",
    toolPolicy: { allowedTools: ["read", "search"], deniedTools: ["edit"], requiresApprovalFor: [] },
    budgetPolicy: { maxInputTokens: 16_000, maxOutputTokens: 3_000, maxWallTimeSeconds: 600 },
  },
}
```

Use equivalent `runtimeProfile` payloads for all seeded profiles.

- [ ] **Step 4: Resolve role/profile from library state in compiler**

Modify `src/v2/orchestration/composition-compiler.ts` imports:

```ts
import { findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import type { AgentProfile, RoleDefinition } from "../domain-packs/types.ts";
```

Before building task definitions, load runtime definitions:

```ts
  const resolvedRoles = await resolveRuntimeRoles(db, input.composition);
  const resolvedProfiles = await resolveRuntimeProfiles(db, input.composition);
```

Replace role/profile normalization:

```ts
    const role = required(resolvedRoles.get(task.agentDefinitionRef), `missing runtime role for ${task.agentDefinitionRef}`);
    const profile = required(resolvedProfiles.get(task.agentProfileRef), `missing runtime profile for ${task.agentProfileRef}`);
    const roleRef = role.id;
    const profileRef = profile.id;
```

Set manifest fields:

```ts
    roles: [...resolvedRoles.values()],
    agentProfiles: [...resolvedProfiles.values()],
```

Add helpers:

```ts
async function resolveRuntimeRoles(db: SouthstarDb, plan: WorkflowCompositionPlan): Promise<Map<string, RoleDefinition>> {
  const roles = new Map<string, RoleDefinition>();
  for (const task of plan.tasks) {
    if (roles.has(task.agentDefinitionRef)) continue;
    const object = await findLibraryObjectByKey(db, task.agentDefinitionRef);
    const runtimeRole = object?.state.runtimeRole;
    if (!isRecord(runtimeRole)) throw new Error(`missing runtimeRole on ${task.agentDefinitionRef}`);
    roles.set(task.agentDefinitionRef, runtimeRole as RoleDefinition);
  }
  return roles;
}

async function resolveRuntimeProfiles(db: SouthstarDb, plan: WorkflowCompositionPlan): Promise<Map<string, AgentProfile>> {
  const profiles = new Map<string, AgentProfile>();
  for (const task of plan.tasks) {
    if (profiles.has(task.agentProfileRef)) continue;
    const object = await findLibraryObjectByKey(db, task.agentProfileRef);
    const runtimeProfile = object?.state.runtimeProfile;
    if (!isRecord(runtimeProfile)) throw new Error(`missing runtimeProfile on ${task.agentProfileRef}`);
    profiles.set(task.agentProfileRef, runtimeProfile as AgentProfile);
  }
  return profiles;
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
```

Delete `roleFromAgentRef()` special-casing and `normalizeProfileRef()` special-casing.

- [ ] **Step 5: Run compiler tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-compiler.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-constrained-regression.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/design-library/software-library-seed.ts \
  src/v2/orchestration/composition-compiler.ts \
  tests/v2/workflow-composition-compiler.test.ts \
  tests/v2/library-constrained-regression.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: compile workflow roles from library profiles"
```

---

### Task 7: Runtime Library Materializer

**Files:**
- Create: `src/v2/orchestration/runtime-library-materializer.ts`
- Create: `tests/v2/runtime-library-materializer.test.ts`
- Modify: `src/v2/design-library/software-library-seed.ts`
- Modify: `tests/v2/index.test.ts`

- [ ] **Step 1: Write failing materializer tests**

Create `tests/v2/runtime-library-materializer.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { materializeTaskLibraryRefs } from "../../src/v2/orchestration/runtime-library-materializer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("runtime materializer resolves instruction, skill, tool, MCP, and vault refs without secret values", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const result = await materializeTaskLibraryRefs(db, {
      runId: "run-materializer",
      taskId: "implement-feature",
      sessionId: "session-materializer",
      instructionRefs: ["instruction.software-maker"],
      skillRefs: ["skill.software-implementation"],
      toolGrantRefs: ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: ["vault.github-write-token"],
    });

    assert.match(result.instructions[0]?.content ?? "", /implement/i);
    assert.equal(result.skills[0]?.skillId, "skill.software-implementation");
    assert.deepEqual(result.toolProxyPolicy.allowedTools.sort(), ["shell", "workspace-read", "workspace-write"].sort());
    assert.deepEqual(result.mcpGrants[0], { serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file", "list_files"] });
    assert.equal(result.vaultLeases[0]?.leaseRef, "vault.github-write-token");
    assert.equal(JSON.stringify(result).includes("plaintextSecret"), false);
  } finally {
    await db.close();
  }
});

test("runtime materializer fails closed for missing refs", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await assert.rejects(
      () => materializeTaskLibraryRefs(db, {
        runId: "run-materializer",
        taskId: "task",
        sessionId: "session",
        instructionRefs: ["instruction.missing"],
        skillRefs: [],
        toolGrantRefs: [],
        mcpGrantRefs: [],
        vaultLeasePolicyRefs: [],
      }),
      /library object not found: instruction.missing/,
    );
  } finally {
    await db.close();
  }
});
```

Append to `tests/v2/index.test.ts`:

```ts
await import("./runtime-library-materializer.test.ts");
```

- [ ] **Step 2: Run failing materializer tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/runtime-library-materializer.test.ts
```

Expected: FAIL because materializer does not exist.

- [ ] **Step 3: Enrich seeded instruction/skill/tool state**

In `src/v2/design-library/software-library-seed.ts`, update representative objects:

```ts
{
  objectKey: "instruction.software-maker",
  objectKind: "instruction_template",
  state: {
    role: "maker",
    content: "Implement the requested repository change, run relevant checks, and return structured implementation evidence.",
    variables: ["goalPrompt", "responsibility"],
  },
},
{
  objectKey: "skill.software-implementation",
  objectKind: "skill_definition",
  state: {
    role: "maker",
    instructions: "Use repository inspection, focused edits, and command evidence for implementation work.",
    allowedTools: ["workspace-read", "workspace-write", "shell"],
    requiredMounts: ["/workspace/repo"],
    mcpRequirements: ["filesystem-workspace"],
    artifactContracts: ["implementation_report"],
  },
},
{
  objectKey: "tool.workspace-write",
  objectKind: "tool_definition",
  state: {
    access: "write",
    toolName: "workspace-write",
    proxyToolName: "workspace-write",
    sideEffect: "write",
    requiresApproval: false,
  },
},
```

Apply equivalent `content`, `instructions`, and `toolName` state to all seeded instruction, skill, and tool objects.

- [ ] **Step 4: Implement materializer**

Create `src/v2/orchestration/runtime-library-materializer.ts`:

```ts
import { createHash } from "node:crypto";
import type { SouthstarDb } from "../db/postgres.ts";
import { findLibraryObjectByKey } from "../design-library/library-graph-store.ts";
import type { ResolvedSkillSnapshot } from "../skills/types.ts";
import type { McpGrantInput, VaultLeaseInput } from "../agent-runner/task-envelope.ts";
import type { ToolProxyPolicyPayload } from "../tool-proxy/types.ts";

export type MaterializeTaskLibraryInput = {
  runId: string;
  taskId: string;
  sessionId: string;
  instructionRefs: string[];
  skillRefs: string[];
  toolGrantRefs: string[];
  mcpGrantRefs: string[];
  vaultLeasePolicyRefs: string[];
};

export type MaterializedInstruction = {
  ref: string;
  content: string;
  contentHash: string;
};

export type MaterializedTaskLibraryRefs = {
  instructions: MaterializedInstruction[];
  skills: ResolvedSkillSnapshot[];
  toolProxyPolicy: ToolProxyPolicyPayload;
  mcpGrants: McpGrantInput[];
  vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">>;
};

export async function materializeTaskLibraryRefs(
  db: SouthstarDb,
  input: MaterializeTaskLibraryInput,
): Promise<MaterializedTaskLibraryRefs> {
  const instructions = await Promise.all(input.instructionRefs.map((ref) => materializeInstruction(db, ref)));
  const skills = await Promise.all(input.skillRefs.map((ref) => materializeSkill(db, ref)));
  const allowedTools = await materializeTools(db, input.toolGrantRefs);
  const mcpGrants = await Promise.all(input.mcpGrantRefs.map((ref) => materializeMcpGrant(db, ref)));
  const vaultLeases = await Promise.all(input.vaultLeasePolicyRefs.map((ref) => materializeVaultLease(db, input, ref)));
  return {
    instructions,
    skills,
    toolProxyPolicy: {
      schemaVersion: "southstar.tool_proxy_policy.v1",
      runId: input.runId,
      sessionId: input.sessionId,
      allowedTools,
      requiredProxyTools: vaultLeases.flatMap((lease) => lease.leaseRef ? allowedTools : []),
      forbiddenDirectEnvKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
      vaultLeaseRefs: vaultLeases.map((lease) => lease.leaseRef),
      maxLeaseTtlSeconds: 900,
      redactResultPayloads: true,
      failClosed: true,
    },
    mcpGrants,
    vaultLeases,
  };
}

async function materializeInstruction(db: SouthstarDb, ref: string): Promise<MaterializedInstruction> {
  const object = await approvedObject(db, ref);
  const content = stringField(object.state, "content", ref);
  return { ref, content, contentHash: sha256(content) };
}

async function materializeSkill(db: SouthstarDb, ref: string): Promise<ResolvedSkillSnapshot> {
  const object = await approvedObject(db, ref);
  const instructions = stringField(object.state, "instructions", ref);
  return {
    skillId: ref,
    version: object.headVersionId ?? "runtime",
    instructions,
    allowedTools: stringArray(object.state.allowedTools),
    requiredMounts: stringArray(object.state.requiredMounts),
    mcpRequirements: stringArray(object.state.mcpRequirements),
    artifactContracts: stringArray(object.state.artifactContracts),
    contentHash: sha256(JSON.stringify(object.state)),
    mountPath: `/skills/${ref.replace(/^skill\./, "")}`,
  };
}

async function materializeTools(db: SouthstarDb, refs: string[]): Promise<string[]> {
  const tools: string[] = [];
  for (const ref of refs) {
    const object = await approvedObject(db, ref);
    tools.push(stringField(object.state, "proxyToolName", ref));
  }
  return [...new Set(tools)].sort();
}

async function materializeMcpGrant(db: SouthstarDb, ref: string): Promise<McpGrantInput> {
  const object = await approvedObject(db, ref);
  return {
    serverId: stringField(object.state, "serverId", ref),
    allowedTools: stringArray(object.state.allowedTools),
  };
}

async function materializeVaultLease(
  db: SouthstarDb,
  input: MaterializeTaskLibraryInput,
  ref: string,
): Promise<Omit<VaultLeaseInput, "secretValue">> {
  const object = await approvedObject(db, ref);
  return {
    leaseRef: ref,
    mountAs: stringField(object.state, "mountMode", ref) === "env" ? "env" : "file",
  };
}

async function approvedObject(db: SouthstarDb, ref: string) {
  const object = await findLibraryObjectByKey(db, ref);
  if (!object) throw new Error(`library object not found: ${ref}`);
  if (object.status !== "approved") throw new Error(`library object is not approved: ${ref}`);
  return object;
}

function stringField(state: Record<string, unknown>, field: string, ref: string): string {
  const value = state[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`library object ${ref} missing string field ${field}`);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

- [ ] **Step 5: Run materializer tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/runtime-library-materializer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/orchestration/runtime-library-materializer.ts \
  src/v2/design-library/software-library-seed.ts \
  tests/v2/runtime-library-materializer.test.ts \
  tests/v2/index.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: materialize runtime library refs"
```

---

### Task 8: Wire Materializer Into ContextPacket And TaskEnvelopeV2

**Files:**
- Modify: `src/v2/agent-runner/task-envelope.ts`
- Modify: `src/v2/context/managed-context-assembler.ts`
- Modify: `src/v2/ui-api/postgres-task-envelope.ts`
- Modify: `tests/v2/managed-context-assembler.test.ts`
- Modify: `tests/v2/postgres-task-envelope.test.ts`

- [ ] **Step 1: Write failing managed context materialization test**

Append to `tests/v2/managed-context-assembler.test.ts`:

```ts
test("managed context assembler includes materialized library refs in TaskEnvelopeV2", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
    });
    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const assembler = createManagedContextAssembler(db);
    const result = await assembler.buildForTask({
      runId: run.runId,
      taskId: "implement-feature",
      sessionId: "session-materialized",
      attemptId: "attempt-1",
      handExecutionId: "hand-materialized",
      dependsOn: ["review-spec"],
    });

    assert.equal(result.taskEnvelope.skills.some((skill) => /repository inspection/i.test(skill.instructions)), true);
    assert.match(result.taskEnvelope.agentPrompt, /Implement the requested repository change/i);
    assert.equal(result.taskEnvelope.toolProxyPolicy?.allowedTools.includes("workspace-write"), true);
    assert.equal(result.taskEnvelope.materializedLibraryRefs?.instructionRefs.includes("instruction.software-maker"), true);
  } finally {
    await db.close();
  }
});
```

Add imports if missing:

```ts
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { createPostgresPlannerDraft, createPostgresRunFromDraft } from "../../src/v2/ui-api/postgres-run-api.ts";
```

- [ ] **Step 2: Run failing managed context test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/managed-context-assembler.test.ts
```

Expected: FAIL because TaskEnvelopeV2 has no `toolProxyPolicy` or `materializedLibraryRefs`.

- [ ] **Step 3: Extend TaskEnvelopeV2 type**

Modify `src/v2/agent-runner/task-envelope.ts` imports:

```ts
import type { ToolProxyPolicyPayload } from "../tool-proxy/types.ts";
```

Add to `TaskEnvelopeV2`:

```ts
  toolProxyPolicy?: ToolProxyPolicyPayload;
  materializedLibraryRefs?: {
    instructionRefs: string[];
    skillRefs: string[];
    toolGrantRefs: string[];
    mcpGrantRefs: string[];
    vaultLeasePolicyRefs: string[];
  };
```

Modify `renderContextPacketPrompt()` input type:

```ts
    materializedInstructions?: Array<{ ref: string; content: string }>;
```

Pass `input.materializedLibraryRefs` is not needed in prompt rendering. Add materialized instruction blocks from `packet.skillInstructions`, because the assembler will put instruction content there.

- [ ] **Step 4: Use materializer in managed context assembler**

Modify `src/v2/context/managed-context-assembler.ts` imports:

```ts
import { materializeTaskLibraryRefs } from "../orchestration/runtime-library-materializer.ts";
```

Before creating `contextPacket`, add:

```ts
      const materializedLibrary = await materializeTaskLibraryRefs(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        instructionRefs: task.instructionRefs ?? [],
        skillRefs: task.skillRefs ?? [],
        toolGrantRefs: task.toolGrantRefs ?? [],
        mcpGrantRefs: task.mcpGrantRefs ?? [],
        vaultLeasePolicyRefs: task.vaultLeasePolicyRefs ?? [],
      });
```

Change `contextPacket.skillInstructions`:

```ts
        skillInstructions: [
          ...materializedLibrary.instructions.map((item) => ({
            id: `instruction-${item.ref}`,
            sourceType: "skill" as const,
            title: item.ref,
            text: item.content,
            sourceRef: item.ref,
            tokenEstimate: estimateTokens(item.content),
          })),
          ...materializedLibrary.skills.map((skill) => ({
            id: `skill-${skill.skillId}`,
            sourceType: "skill" as const,
            title: skill.skillId,
            text: skill.instructions,
            sourceRef: skill.skillId,
            tokenEstimate: estimateTokens(skill.instructions),
          })),
        ],
```

Change `mcpGrantSummary`:

```ts
        mcpGrantSummary: materializedLibrary.mcpGrants.map((grant) => ({
          id: `mcp-${grant.serverId}`,
          sourceType: "mcp" as const,
          title: grant.serverId,
          text: `Allowed MCP tools: ${grant.allowedTools.join(", ")}.`,
          sourceRef: grant.serverId,
          tokenEstimate: estimateTokens(grant.allowedTools.join(" ")),
        })),
```

Change `buildTaskEnvelopeV2()` input:

```ts
        skills: materializedLibrary.skills,
        mcpGrants: materializedLibrary.mcpGrants,
        vaultLeases: materializedLibrary.vaultLeases,
        toolProxyPolicy: materializedLibrary.toolProxyPolicy,
        materializedLibraryRefs: {
          instructionRefs: task.instructionRefs ?? [],
          skillRefs: task.skillRefs ?? [],
          toolGrantRefs: task.toolGrantRefs ?? [],
          mcpGrantRefs: task.mcpGrantRefs ?? [],
          vaultLeasePolicyRefs: task.vaultLeasePolicyRefs ?? [],
        },
```

- [ ] **Step 5: Use materializer in Postgres task envelope fallback**

Modify `src/v2/ui-api/postgres-task-envelope.ts` imports:

```ts
import { materializeTaskLibraryRefs } from "../orchestration/runtime-library-materializer.ts";
```

Before `return buildTaskEnvelopeV2({`, add:

```ts
  const materializedLibrary = await materializeTaskLibraryRefs(db, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: rootSessionId,
    instructionRefs: task.instructionRefs ?? [],
    skillRefs: task.skillRefs ?? [],
    toolGrantRefs: task.toolGrantRefs ?? [],
    mcpGrantRefs: task.mcpGrantRefs ?? [],
    vaultLeasePolicyRefs: task.vaultLeasePolicyRefs ?? [],
  });
```

Replace `skills`, `mcpGrants`, `vaultLeases` with materialized values and add `toolProxyPolicy` and `materializedLibraryRefs`.

Delete the local `skillSnapshots()` helper if it becomes unused.

- [ ] **Step 6: Run context and envelope tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/managed-context-assembler.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-task-envelope.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/agent-runner/task-envelope.ts \
  src/v2/context/managed-context-assembler.ts \
  src/v2/ui-api/postgres-task-envelope.ts \
  tests/v2/managed-context-assembler.test.ts \
  tests/v2/postgres-task-envelope.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: materialize library refs into task envelopes"
```

---

### Task 9: Planner Trace And Invalid Draft Audit

**Files:**
- Modify: `src/v2/ui-api/postgres-run-api.ts`
- Modify: `tests/v2/postgres-run-api.test.ts`
- Modify: `tests/v2/library-constrained-regression.test.ts`

- [ ] **Step 1: Write failing trace test**

Append to `tests/v2/postgres-run-api.test.ts`:

```ts
test("llm-constrained planner trace records composer and repair evidence", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
    });
    const resource = await db.one<{
      payload_json: {
        plannerTrace: {
          analyzerType?: string;
          composerMode?: string;
          validatorAttempts?: number;
          repairAttempts?: number;
          candidatePacketHash?: string;
          compositionHash?: string;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(resource.payload_json.plannerTrace.analyzerType, "deterministic");
    assert.equal(resource.payload_json.plannerTrace.composerMode, "fixture");
    assert.equal(resource.payload_json.plannerTrace.validatorAttempts, 1);
    assert.equal(resource.payload_json.plannerTrace.repairAttempts, 0);
    assert.equal(typeof resource.payload_json.plannerTrace.candidatePacketHash, "string");
    assert.equal(typeof resource.payload_json.plannerTrace.compositionHash, "string");
  });
});
```

- [ ] **Step 2: Run failing trace test**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
```

Expected: FAIL because planner trace does not have these fields.

- [ ] **Step 3: Extend planner trace payload**

In `src/v2/ui-api/postgres-run-api.ts`, update the library-constrained `plannerTrace`:

```ts
    plannerTrace: {
      model: `southstar-library-constrained-${input.composerMode ?? "fixture"}-composer`,
      promptHash: hash(input.goalPrompt),
      generatedAt: new Date().toISOString(),
      analyzerType: "deterministic",
      composerMode: input.composerMode ?? "fixture",
      composerFallbackUsed: false,
      validatorAttempts: repairResult.attempts.length,
      repairAttempts: Math.max(0, repairResult.attempts.length - 1),
      finalValidationOk: repairResult.validation.ok,
      candidatePacketHash: hash(JSON.stringify(candidatePacket)),
      compositionHash: hash(JSON.stringify(composition)),
    },
```

Broaden `PlanBundle` planner trace type in `src/v2/manifests/types.ts`:

```ts
  plannerTrace: {
    model: string;
    promptHash: string;
    generatedAt: string;
    analyzerType?: string;
    composerMode?: string;
    composerFallbackUsed?: boolean;
    validatorAttempts?: number;
    repairAttempts?: number;
    finalValidationOk?: boolean;
    candidatePacketHash?: string;
    compositionHash?: string;
  };
```

- [ ] **Step 4: Run trace and manifest tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/postgres-run-api.test.ts
node_modules/.bin/tsx tests/v2/manifests.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  src/v2/ui-api/postgres-run-api.ts \
  src/v2/manifests/types.ts \
  tests/v2/postgres-run-api.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "feat: record llm orchestration trace"
```

---

### Task 10: Dynamic Workflow E2E Coverage

**Files:**
- Create: `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`
- Modify: `package.json`
- Modify: `tests/e2e-postgres/README.md`

- [ ] **Step 1: Add E2E case script**

Modify `package.json` scripts:

```json
"test:e2e:postgres:29": "tsx tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts"
```

- [ ] **Step 2: Write dynamic E2E test**

Create `tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createInitializedRealPostgresE2E, createRealRuntimeServer, dockerReachableUrl, probeRealPostgresTorkPi, requireRealPostgresInfra, waitForPostgresRunStatus, waitForTorkJob } from "../postgres-real-harness.ts";
import { createRealRecoveryScheduler, latestHandExecutionForTask, waitForHandExecutionStatus } from "../recovery-scheduler-helpers.ts";
import { listResourcesPg } from "../../../src/v2/stores/postgres-runtime-store.ts";

test("29 llm dynamic workflow materialization: non-fixture DAG executes with materialized refs", async () => {
  const checkpoint = (id: string, message: string) => console.info(`[case29][${id}] ${message}`);
  const infra = requireRealPostgresInfra();
  checkpoint("CP0", "infra env loaded");
  await probeRealPostgresTorkPi(infra);
  checkpoint("CP0", "infra probe passed");

  const env = await createInitializedRealPostgresE2E();
  const server = await createRealRuntimeServer({ db: env.db, infra });
  try {
    const draft = await api<{ draftId: string }>(server.port, "/api/v2/planner/drafts", {
      method: "POST",
      body: JSON.stringify({
        goalPrompt: "dynamic llm p1 e2e: create a non fixture review workflow and complete end to end",
        orchestrationMode: "llm-constrained",
        composerMode: "fixture",
      }),
    });
    checkpoint("CP1", `draft created: ${draft.draftId}`);

    const run = await api<{ runId: string; taskIds: string[] }>(server.port, "/api/v2/runs", {
      method: "POST",
      body: JSON.stringify({ draftId: draft.draftId }),
    });
    assert.equal(run.taskIds.includes("review-spec"), true);
    assert.equal(run.taskIds.includes("review-code-quality"), true);
    checkpoint("CP2", `run created: ${run.runId}`);

    const envelopesBeforeExecute = await listResourcesPg(env.db, { resourceType: "task_envelope" });
    assert.equal(envelopesBeforeExecute.filter((resource) => resource.runId === run.runId).length, 0);

    const execute = await api<{ runId: string; status: string; schedulerWakeRequested: true }>(
      server.port,
      `/api/v2/runs/${encodeURIComponent(run.runId)}/execute`,
      { method: "POST", body: "{}" },
    );
    assert.deepEqual(execute, { runId: run.runId, status: "scheduling", schedulerWakeRequested: true });
    checkpoint("CP3", "run moved to scheduling");

    const scheduler = createRealRecoveryScheduler(env.db, {
      infra,
      callbackBase: dockerReachableUrl(server, infra),
    });

    for (const taskId of run.taskIds) {
      const dispatch = await scheduler.runOnce({ runId: run.runId });
      assert.deepEqual(dispatch.dispatchedTaskIds, [taskId]);
      const envelope = await env.db.one<{ payload_json: { envelope: { materializedLibraryRefs?: unknown; skills?: unknown[]; toolProxyPolicy?: unknown } } }>(
        "select payload_json from southstar.runtime_resources where resource_type = 'task_envelope' and run_id = $1 and task_id = $2 order by created_at desc limit 1",
        [run.runId, taskId],
      );
      assert.equal(Boolean(envelope.payload_json.envelope.materializedLibraryRefs), true);
      assert.equal(Array.isArray(envelope.payload_json.envelope.skills), true);
      assert.equal(Boolean(envelope.payload_json.envelope.toolProxyPolicy), true);
      checkpoint("CP4", `task dispatched with materialized envelope: ${taskId}`);

      const hand = await latestHandExecutionForTask(env.db, { runId: run.runId, taskId });
      await waitForTorkJob(infra.torkBaseUrl, hand.externalJobId);
      const handStatus = await waitForHandExecutionStatus(env.db, hand.resourceKey, ["completed", "failed"]);
      assert.equal(handStatus, "completed");
      checkpoint("CP5", `task callback completed: ${taskId}`);
    }

    const runStatus = await waitForPostgresRunStatus(env.db, run.runId, ["passed", "failed"]);
    assert.equal(runStatus, "passed");
    checkpoint("CP6", "run reached passed terminal status");

    const persisted = await env.db.query<{ payload_json: unknown }>(
      "select payload_json from southstar.runtime_resources where run_id = $1",
      [run.runId],
    );
    assert.equal(JSON.stringify(persisted.rows).includes("plaintextSecret"), false);
    checkpoint("CP7", "no plaintext secret persisted");
  } finally {
    await server.close();
    await env.close();
  }
});

async function api<T>(port: number, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}
```

This first E2E uses fixture mode to keep real infra deterministic while proving materialized runtime refs. A separate live-LLM E2E can reuse the same assertions with `composerMode: "llm"` after a production LLM provider is configured.

- [ ] **Step 3: Document command**

Append to `tests/e2e-postgres/README.md`:

````md
### Case 29: LLM dynamic workflow materialization

Runs the library-constrained planner path through dynamic composition, run creation, scheduler/Tork execution, materialized TaskEnvelopeV2 refs, and terminal completion.

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:postgres:29
```
````

- [ ] **Step 4: Run E2E case 29 when infra is available**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:postgres:29
```

Expected when real infra is configured: PASS with checkpoints CP0 through CP7.

If infra is missing, record the exact missing env or probe failure in the final implementation handoff and run the focused v2 tests from Tasks 1-9 instead.

- [ ] **Step 5: Commit**

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar add \
  package.json \
  tests/e2e-postgres/README.md \
  tests/e2e-postgres/cases/29-llm-dynamic-workflow-materialization.test.ts
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar commit -m "test: cover llm dynamic workflow materialization e2e"
```

---

### Task 11: Full Verification And Plan Closure

**Files:**
- No production files unless prior tasks reveal a test-only import omission.

- [ ] **Step 1: Run focused orchestration tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composer-registry.test.ts
node_modules/.bin/tsx tests/v2/llm-workflow-composer.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/composition-repair-loop.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/runtime-library-materializer.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run existing P0 orchestration regression tests**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-candidate-resolver.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-validator.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/workflow-composition-compiler.test.ts
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
  node_modules/.bin/tsx tests/v2/library-constrained-regression.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run full v2 suite**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm run test:v2
```

Expected: PASS.

- [ ] **Step 4: Run TypeScript check**

Run:

```bash
node_modules/.bin/tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Run E2E case 28 and case 29 when infra is available**

Run:

```bash
SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:postgres:28

SOUTHSTAR_TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
TORK_BASE_URL=http://127.0.0.1:8000 \
npm run test:e2e:postgres:29
```

Expected when real infra is available: both PASS.

- [ ] **Step 6: Check hardcode regressions**

Run:

```bash
rg -n "new DeterministicFixtureComposer|profile\\.software-spec-reviewer-codex|profile\\.software-code-quality-reviewer-codex|role === \"spec-reviewer\"|allowedTools: \\[\\]" src/v2 tests/v2
```

Expected:

- `new DeterministicFixtureComposer` appears only in composer registry, tests, or fixture code.
- reviewer profile string literals do not appear in compiler normalization branches.
- `allowedTools: []` does not appear in runtime materializer output paths for selected MCP grants.

- [ ] **Step 7: Inspect git status**

Run:

```bash
git --git-dir=/home/timmypai/apps/southstar/.git-local --work-tree=/home/timmypai/apps/southstar status --short
```

Expected: only intentional files from this plan are modified or committed. Existing unrelated dirty files remain untouched.

- [ ] **Step 8: Final implementation handoff**

Report:

- modification summary
- test commands and results
- real E2E checkpoints or infra blocker
- residual risks
- follow-up recommendations

Use the user's preferred handoff headings:

```md
修改摘要
測試指令與結果
風險
後續建議
```

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import {
  DeterministicFixtureComposer,
  deterministicFixtureComposition,
  seedDeterministicWorkflowGraph,
} from "./fixtures/deterministic-workflow-composer.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  patchPostgresPlannerDraftTaskProfileOverride,
  revisePostgresPlannerDraft,
  validatePostgresPlannerDraft,
} from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";
import { resolveTestPostgresAdminUrl } from "./postgres-test-utils.ts";

const FIXTURE_TASK_IDS = [
  "understand-repo",
  "review-spec",
  "implement-feature",
  "verify-feature",
  "review-code-quality",
  "summarize-completion",
];

test("Postgres run API creates draft, run, tasks, and history without prebuilding task context", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");
    assert.match(draft.draftId, /^draft-wf-composed-/);
    assert.equal(draft.status, "validated");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), FIXTURE_TASK_IDS);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.match(run.runId, /^run-wf-composed-/);

    const runRow = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [run.runId]);
    assert.equal(runRow.status, "created");
    const taskRows = await db.query<{ id: string }>("select id from southstar.workflow_tasks where run_id = $1 order by sort_order", [run.runId]);
    assert.deepEqual(taskRows.rows.map((row) => row.id), FIXTURE_TASK_IDS);

    const history = await db.query<{ event_type: string }>("select event_type from southstar.workflow_history where run_id = $1 order by sequence", [run.runId]);
    assert.deepEqual(history.rows.map((row) => row.event_type), ["run.created", ...FIXTURE_TASK_IDS.map(() => "task.created")]);

    const prebuiltContextCount = await db.one<{ count: string }>(
      "select count(*)::text as count from southstar.runtime_resources where resource_type in ('context_packet', 'task_envelope', 'knowledge_card_injection_trace') and run_id = $1",
      [run.runId],
    );
    assert.equal(prebuiltContextCount.count, "0");
  });
});

test("Postgres planner draft task profile override updates one task without changing other tasks", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");

    const result = await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        harnessRef: "codex",
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Use the smallest patch and include test evidence.",
        skillRefs: ["software.calc-cli", "software.test-evidence"],
        mcpGrantRefs: ["filesystem-workspace"],
        toolGrantRefs: ["tool.workspace-write", "tool.shell-read"],
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        nodePromptSpec: {
          nodeType: "implement",
          goal: "Implement calc sum with tests",
          requirements: ["Update the implementation"],
          boundaries: ["No unrelated refactors"],
          nonGoals: [],
          deliverableDocuments: [],
          expectedOutputs: ["Passing test evidence"],
          testCases: [],
          acceptanceCriteria: ["The calc sum behavior works"],
        },
      },
    });

    assert.equal(result.draftId, draft.draftId);
    assert.equal(result.taskId, "implement-feature");
    assert.equal(result.status, "needs_validation");
    assert.deepEqual(result.profileOverride.skillRefs, ["software.calc-cli", "software.test-evidence"]);

    const row = await db.one<{
      status: string;
      summary_json: { status?: string };
      payload_json: { workflow: { tasks: Array<Record<string, any>> } };
    }>(
      "select status, summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(row.status, "needs_validation");
    assert.equal(row.summary_json.status, "needs_validation");
    const implement = row.payload_json.workflow.tasks.find((task) => task.id === "implement-feature");
    const verify = row.payload_json.workflow.tasks.find((task) => task.id === "verify-feature");
    assert.equal(implement?.profileOverride.model, "gpt-5-codex");
    assert.deepEqual(implement?.skillRefs, ["software.calc-cli", "software.test-evidence"]);
    assert.deepEqual(implement?.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(implement?.toolGrantRefs, ["tool.workspace-write", "tool.shell-read"]);
    assert.deepEqual(implement?.vaultLeasePolicyRefs, ["vault.github-write-token"]);
    assert.equal(implement?.promptInputs?.nodePromptSpec?.goal, "Implement calc sum with tests");
    assert.equal(verify?.profileOverride, undefined);
  });
});

test("Postgres planner draft validation gates run creation after profile override", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        provider: "codex",
        model: "gpt-5-codex",
        instruction: "Use a tight patch and include validation evidence.",
        skillRefs: ["software.calc-cli"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
    });

    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "validated");
    assert.deepEqual(validated.validationIssues, []);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.match(run.runId, /^run-wf-composed-/);
  });
});

test("Postgres run from draft materializes task profile override into run manifest and task snapshot", async () => {
  await withDb(async (db) => {
    const draft = await createFixturePlannerDraft(db, "implement calc sum");

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        harnessRef: "codex",
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Prefer the smallest verified patch and cite command evidence.",
        skillRefs: ["software.calc-cli", "skill.software-verification"],
        mcpGrantRefs: ["filesystem-workspace"],
        toolGrantRefs: ["tool.workspace-write"],
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        nodePromptSpec: {
          nodeType: "implement",
          goal: "Implement calc sum with command evidence",
          requirements: ["Keep the patch small"],
          boundaries: ["No unrelated files"],
          nonGoals: [],
          deliverableDocuments: [],
          expectedOutputs: ["Test command output"],
          testCases: [],
          acceptanceCriteria: ["Evidence is cited"],
        },
      },
    });

    const validated = await validatePostgresPlannerDraft(db, { draftId: draft.draftId });
    assert.equal(validated.status, "validated");

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const runRow = await db.one<{
      workflow_manifest_json: {
        tasks: Array<Record<string, any>>;
        agentProfiles: Array<Record<string, any>>;
      };
    }>("select workflow_manifest_json from southstar.workflow_runs where id = $1", [run.runId]);
    const implementTask = runRow.workflow_manifest_json.tasks.find((task) => task.id === "implement-feature");
    assert.equal(implementTask?.agentProfileRef, "profile.generated.software-implement-feature__implement-feature__override");
    assert.deepEqual(implementTask?.skillRefs, ["software.calc-cli", "skill.software-verification"]);
    assert.deepEqual(implementTask?.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(implementTask?.toolGrantRefs, ["tool.workspace-write"]);
    assert.deepEqual(implementTask?.vaultLeasePolicyRefs, ["vault.github-write-token"]);
    assert.equal(implementTask?.promptInputs?.nodePromptSpec?.goal, "Implement calc sum with command evidence");
    assert.equal(implementTask?.profileOverride?.model, "gpt-5-codex");

    const overriddenProfile = runRow.workflow_manifest_json.agentProfiles.find((profile) =>
      profile.id === "profile.generated.software-implement-feature__implement-feature__override"
    );
    assert.equal(overriddenProfile?.harnessRef, "codex");
    assert.equal(overriddenProfile?.provider, "codex");
    assert.equal(overriddenProfile?.model, "gpt-5-codex");
    assert.equal(overriddenProfile?.thinkingLevel, "high");
    assert.deepEqual(overriddenProfile?.skillRefs, ["software.calc-cli", "skill.software-verification"]);
    assert.deepEqual(overriddenProfile?.mcpGrantRefs, ["filesystem-workspace"]);
    assert.deepEqual(overriddenProfile?.toolPolicy.allowedTools, ["tool.workspace-write"]);
    assert.deepEqual(overriddenProfile?.vaultLeasePolicyRefs, ["vault.github-write-token"]);

    const taskRow = await db.one<{ snapshot_json: Record<string, any> }>(
      "select snapshot_json from southstar.workflow_tasks where run_id = $1 and id = 'implement-feature'",
      [run.runId],
    );
    assert.equal(taskRow.snapshot_json.agentProfileRef, "profile.generated.software-implement-feature__implement-feature__override");
    assert.equal(taskRow.snapshot_json.profileOverride.model, "gpt-5-codex");

    const prebuiltContextCount = await db.one<{ count: string }>(
      "select count(*)::text as count from southstar.runtime_resources where resource_type in ('context_packet', 'task_envelope') and run_id = $1 and task_id = 'implement-feature'",
      [run.runId],
    );
    assert.equal(prebuiltContextCount.count, "0");
  });
});

test("Postgres planner draft revision preserves matching task profile overrides and requires validation", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with override preservation",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: new DeterministicFixtureComposer(),
    });

    await patchPostgresPlannerDraftTaskProfileOverride(db, {
      draftId: draft.draftId,
      taskId: "implement-feature",
      profileOverride: {
        provider: "codex",
        model: "gpt-5-codex",
        thinkingLevel: "high",
        instruction: "Keep this manually selected implementation agent.",
        skillRefs: ["software.calc-cli"],
        mcpGrantRefs: ["filesystem-workspace"],
      },
    });

    const revised = await revisePostgresPlannerDraft(db, {
      draftId: draft.draftId,
      prompt: "also verify empty input behavior",
      composerMode: "llm",
      composer: new DeterministicFixtureComposer(),
    });

    assert.notEqual(revised.draftId, draft.draftId);
    assert.equal(revised.status, "needs_validation");

    const revisedRow = await db.one<{
      status: string;
      summary_json: { status?: string };
      payload_json: { workflow: { tasks: Array<Record<string, any>> } };
    }>(
      "select status, summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [revised.draftId],
    );
    const implement = revisedRow.payload_json.workflow.tasks.find((task) => task.id === "implement-feature");
    assert.equal(revisedRow.status, "needs_validation");
    assert.equal(revisedRow.summary_json.status, "needs_validation");
    assert.equal(implement?.profileOverride?.model, "gpt-5-codex");
    assert.equal(implement?.profileOverride?.instruction, "Keep this manually selected implementation agent.");
    assert.deepEqual(implement?.skillRefs, ["software.calc-cli"]);
    assert.deepEqual(implement?.mcpGrantRefs, ["filesystem-workspace"]);
  });
});

test("Postgres run API supports llm-constrained planner drafts and preserves task creation order", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composer: new DeterministicFixtureComposer(),
    });
    assert.match(draft.draftId, /^draft-wf-composed-/);
    assert.equal(draft.status, "validated");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);

    const draftResource = await db.one<{
      summary_json: { planner?: string };
      payload_json: { orchestrationSnapshot?: { validation?: { ok?: boolean } } };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "library-constrained-llm");
    assert.equal(draftResource.payload_json.orchestrationSnapshot?.validation?.ok, true);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);
  });
});

test("llm-constrained planner drafts fail closed when llm composer is not configured", async () => {
  await withDb(async (db) => {
    await assert.rejects(
      () => createPostgresPlannerDraft(db, {
        goalPrompt: "implement calc sum",
        orchestrationMode: "llm-constrained",
      }),
      /LLM workflow composer is not configured/,
    );
  });
});

test("planner draft creates from an existing composition without calling an LLM composer", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "reuse visible DAG",
      orchestrationMode: "llm-constrained",
      compositionPlan: deterministicFixtureComposition(),
    });

    assert.equal(draft.status, "validated");
    assert.equal(draft.taskSummaries[0]?.taskId, "understand-repo");

    const draftResource = await db.one<{
      summary_json: { planner?: string };
      payload_json: {
        plannerTrace?: {
          composerMode?: string;
          composerFallbackUsed?: boolean;
        };
        orchestrationSnapshot?: {
          selectedCompositionPlan?: { title?: string };
        };
      };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.summary_json.planner, "existing-composition-compiler");
    assert.equal(draftResource.payload_json.plannerTrace?.composerMode, "existing-composition");
    assert.equal(draftResource.payload_json.plannerTrace?.composerFallbackUsed, false);
    assert.equal(draftResource.payload_json.orchestrationSnapshot?.selectedCompositionPlan?.title, "Software Dynamic Feature Workflow");
  });
});

test("llm-constrained planner trace records analyzer/composer and validation audit metadata", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: new DeterministicFixtureComposer(),
    });
    const draftResource = await db.one<{
      payload_json: {
        plannerTrace: {
          analyzerType?: string;
          composerMode?: string;
          composerFallbackUsed?: boolean;
          validatorAttempts?: number;
          repairAttempts?: number;
          finalValidationOk?: boolean;
          candidatePacketHash?: string;
          compositionHash?: string;
        };
        orchestrationSnapshot: {
          candidatePacketHash: string;
          selectedCompositionPlan: unknown;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    const trace = draftResource.payload_json.plannerTrace;
    assert.equal(trace.analyzerType, "deterministic");
    assert.equal(trace.composerMode, "llm");
    assert.equal(trace.composerFallbackUsed, false);
    assert.equal(trace.validatorAttempts, 1);
    assert.equal(trace.repairAttempts, 0);
    assert.equal(trace.finalValidationOk, true);
    assert.match(trace.candidatePacketHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(trace.compositionHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(trace.candidatePacketHash, draftResource.payload_json.orchestrationSnapshot.candidatePacketHash);
    assert.notEqual(trace.compositionHash, "");
  });
});

test("llm-constrained planner does not fallback when primary composer fails", async () => {
  await withDb(async (db) => {
    const failingComposer = {
      async compose() {
        throw new Error("forced llm composer failure");
      },
    };
    await assert.rejects(
      () => createPostgresPlannerDraft(db, {
        goalPrompt: "implement calc sum",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        composer: failingComposer,
      }),
      /forced llm composer failure/,
    );
  });
});

test("Postgres planner draft can use injected scripted LLM composer for non-fixture DAG shape", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const composer = new ScriptedWorkflowComposer([invalidInspectOnlyPlan(), deterministicFixtureComposition()]);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with a single exploration task",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer,
    });
    const draftResource = await db.one<{ payload_json: { repairAttempts: Array<{ validation: { ok: boolean } }> } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.payload_json.repairAttempts.length, 2);
    assert.equal(draftResource.payload_json.repairAttempts[0]?.validation.ok, false);
    assert.equal(draftResource.payload_json.repairAttempts[1]?.validation.ok, true);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.deepEqual(run.taskIds, [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);
  });
});

test("llm-constrained planner uses graph metadata even when legacy capability candidates are unavailable", async () => {
  await withDb(async (db) => {
    await seedGraphMetadataOnlyWorkflowPrimitives(db);
    const composer = new ScriptedWorkflowComposer([graphMetadataOnlyPlan()]);

    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "build a vocabulary learning feature",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer,
    });

    assert.equal(draft.status, "validated");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), ["implement-vocab"]);

    const draftResource = await db.one<{
      payload_json: {
        orchestrationSnapshot?: {
          candidateSummary?: { agentDefinitionRefs?: string[] };
          compiler?: { libraryVersionRefs?: string[] };
          selectedCompositionPlan?: { tasks?: Array<{ agentProfileRef?: string }> };
        };
        workflow?: {
          roles?: Array<{ id?: string; defaultAgentProfileRef?: string }>;
          agentProfiles?: Array<{
            id?: string;
            provider?: string;
            model?: string;
            thinkingLevel?: string;
            instruction?: string;
            harnessRef?: string;
            toolPolicy?: { allowedTools?: string[] };
          }>;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.deepEqual(draftResource.payload_json.orchestrationSnapshot?.candidateSummary?.agentDefinitionRefs, ["agent.frontend-developer"]);
    assert.equal(
      draftResource.payload_json.workflow?.roles?.[0]?.defaultAgentProfileRef,
      "profile.generated.vocab.implement",
    );
    const generatedProfile = draftResource.payload_json.workflow?.agentProfiles?.find((profile) =>
      profile.id === "profile.generated.vocab.implement"
    );
    assert.equal(generatedProfile?.provider, "pi");
    assert.equal(generatedProfile?.model, "pi-agent-default");
    assert.equal(generatedProfile?.thinkingLevel, "high");
    assert.equal(generatedProfile?.harnessRef, "pi");
    assert.match(generatedProfile?.instruction ?? "", /vocabulary learning feature/);
    assert.deepEqual(generatedProfile?.toolPolicy?.allowedTools, ["tool.workspace-write"]);
    assert.equal(
      draftResource.payload_json.orchestrationSnapshot?.compiler?.libraryVersionRefs?.includes("agent.frontend-developer@1"),
      true,
    );
    assert.equal(
      draftResource.payload_json.orchestrationSnapshot?.selectedCompositionPlan?.tasks?.[0]?.agentProfileRef,
      "profile.generated.vocab.implement",
    );
  });
});

test("Postgres planner draft is invalid when repair loop remains invalid after max attempts", async () => {
  await withDb(async (db) => {
    const composer = new ScriptedWorkflowComposer([
      invalidInspectOnlyPlan(),
      invalidInspectOnlyPlan(),
      invalidInspectOnlyPlan(),
    ]);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with invalid explorer profile",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer,
    });
    assert.ok(draft.draftId.length > 0);
    assert.equal(draft.status, "invalid");
    assert.ok(draft.validationIssues.length > 0);
    assert.equal(draft.taskSummaries.length, 0);
    const draftResource = await db.one<{
      status: string;
      payload_json: { repairAttempts: Array<{ validation: { ok: boolean } }> };
    }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.status, "invalid");
    assert.equal(draftResource.payload_json.repairAttempts.length, 3);
    assert.equal(draftResource.payload_json.repairAttempts[2]?.validation.ok, false);
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );
  });
});

test("Postgres planner draft orchestration inspection helper returns public summary and orchestration snapshot", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composer: new DeterministicFixtureComposer(),
    });
    const inspection = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(inspection.draftId, draft.draftId);
    assert.equal(inspection.status, "validated");
    assert.deepEqual(inspection.validationIssues, []);
    assert.equal(inspection.taskSummaries.length, 6);
    assert.equal(inspection.taskSummaries[0]?.taskId, "understand-repo");
    assert.equal(inspection.orchestrationSnapshot?.validation.ok, true);
  });
});

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

test("Postgres server routes create planner drafts and runs through new API", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by Postgres constrained planner"); } },
      workflowComposer: new DeterministicFixtureComposer(),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by created-state route"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{
        draftId: string;
        workflowId: string;
        status: string;
        validationIssues: Array<{ path: string; message: string }>;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum" }),
      });
      assert.match(draft.draftId, /^draft-wf-composed-/);
      assert.equal(draft.status, "validated");
      assert.deepEqual(draft.validationIssues, []);
      assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), FIXTURE_TASK_IDS);

      const run = await api<{ runId: string; taskIds: string[] }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: draft.draftId }),
      });
      assert.match(run.runId, /^run-wf-composed-/);
      assert.deepEqual(run.taskIds, FIXTURE_TASK_IDS);

      const llmDraft = await api<{
        draftId: string;
        workflowId: string;
        status: string;
        validationIssues: Array<{ path: string; message: string }>;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum", orchestrationMode: "llm-constrained" }),
      });
      assert.match(llmDraft.draftId, /^draft-wf-composed-/);
      assert.equal(llmDraft.status, "validated");
      assert.deepEqual(llmDraft.validationIssues, []);
      assert.equal(llmDraft.taskSummaries.length, 6);

      const orchestration = await api<{
        draftId: string;
        status: string;
        taskSummaries: Array<{ taskId: string }>;
        orchestrationSnapshot?: { validation: { ok: boolean } };
      }>(server.url, `/api/v2/planner/drafts/${encodeURIComponent(llmDraft.draftId)}/orchestration`, {
        method: "GET",
      });
      assert.equal(orchestration.draftId, llmDraft.draftId);
      assert.equal(orchestration.status, "validated");
      assert.equal(orchestration.orchestrationSnapshot?.validation.ok, true);
      assert.deepEqual(orchestration.taskSummaries.map((task) => task.taskId), llmDraft.taskSummaries.map((task) => task.taskId));

      const llmRun = await api<{ runId: string; taskIds: string[] }>(server.url, `/api/v2/planner/drafts/${encodeURIComponent(llmDraft.draftId)}/runs`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      assert.deepEqual(llmRun.taskIds, [
        "understand-repo",
        "review-spec",
        "implement-feature",
        "verify-feature",
        "review-code-quality",
        "summarize-completion",
      ]);

      const llmRunViaLegacyRoute = await api<{ runId: string; taskIds: string[] }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: llmDraft.draftId }),
      });
      assert.deepEqual(llmRunViaLegacyRoute.taskIds, llmRun.taskIds);
    } finally {
      await server.close();
    }
  });
});

test("Postgres server planner draft route accepts and persists structured request hints", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by structured request contract test"); } },
      workflowComposer: new DeterministicFixtureComposer(),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by planner route"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const request = {
        goalPrompt: "implement calc sum",
        orchestrationMode: "llm-constrained",
        composerMode: "llm",
        cwd: "/workspace/southstar",
        libraryHints: {
          roleRefs: ["agent.software-maker"],
          agentProfileRefs: ["profile.software-maker-pi"],
          skillRefs: ["skill.software-implementation"],
          mcpGrantRefs: ["mcp.filesystem-workspace"],
          toolRefs: ["tool.workspace-read", "tool.shell-command"],
          modelHints: { maker: "gpt-5" },
          vaultLeasePolicyRefs: ["vault.github-write-token"],
          toolPolicyHints: {
            allowedTools: ["read", "search", "shell"],
            deniedTools: ["write"],
            requiresApprovalFor: ["network"],
          },
        },
      };
      const expectedPlannerRequest = request;
      const draft = await api<{
        draftId: string;
        goalPrompt: string;
        workflowId: string;
        status: string;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify(request),
      });
      assert.equal(draft.status, "validated");
      assert.equal(draft.goalPrompt, request.goalPrompt);

      const row = await db.one<{
        summary_json: { plannerRequest?: unknown };
        payload_json: { plannerRequest?: unknown };
      }>(
        "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
        [draft.draftId],
      );
      assert.deepEqual(row.summary_json.plannerRequest, expectedPlannerRequest);
      assert.deepEqual(row.payload_json.plannerRequest, expectedPlannerRequest);
    } finally {
      await server.close();
    }
  });
});

test("Postgres planner draft snapshots structured request before async orchestration work", async () => {
  await withDb(async (db) => {
    const request = {
      goalPrompt: "implement calc sum with snapshot boundary",
      orchestrationMode: "llm-constrained" as const,
      composerMode: "llm" as const,
      cwd: "/workspace/original",
      libraryHints: {
        roleRefs: ["agent.software-maker"],
        agentProfileRefs: ["profile.software-maker-pi"],
        skillRefs: ["skill.software-implementation"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        toolRefs: ["tool.workspace-read"],
        modelHints: { maker: "gpt-5" },
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        toolPolicyHints: {
          allowedTools: ["read", "search"],
          deniedTools: ["write"],
          requiresApprovalFor: ["network"],
        },
      },
    };
    const expectedPlannerRequest = JSON.parse(JSON.stringify(request));
    const draftPromise = createPostgresPlannerDraft(db, {
      ...request,
      composer: new DeterministicFixtureComposer(),
    });

    request.cwd = "/workspace/mutated";
    request.libraryHints.roleRefs.push("agent.mutated");
    request.libraryHints.agentProfileRefs.push("profile.mutated");
    request.libraryHints.modelHints.maker = "mutated-model";
    request.libraryHints.toolPolicyHints.allowedTools.push("write");

    const draft = await draftPromise;
    const row = await db.one<{
      summary_json: { plannerRequest?: unknown };
      payload_json: { plannerRequest?: unknown };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.deepEqual(row.summary_json.plannerRequest, expectedPlannerRequest);
    assert.deepEqual(row.payload_json.plannerRequest, expectedPlannerRequest);
  });
});

test("Postgres planner draft revision preserves structured request hints with explicit mode overrides", async () => {
  await withDb(async (db) => {
    const baseRequest = {
      goalPrompt: "implement calc sum with structured revision context",
      orchestrationMode: "llm-constrained" as const,
      composerMode: "llm" as const,
      cwd: "/workspace/southstar",
      libraryHints: {
        roleRefs: ["agent.software-maker"],
        agentProfileRefs: ["profile.software-maker-pi"],
        skillRefs: ["skill.software-implementation"],
        mcpGrantRefs: ["mcp.filesystem-workspace"],
        toolRefs: ["tool.workspace-read", "tool.shell-command"],
        modelHints: { maker: "gpt-5" },
        vaultLeasePolicyRefs: ["vault.github-write-token"],
        toolPolicyHints: {
          allowedTools: ["read", "search", "shell"],
          deniedTools: ["write"],
          requiresApprovalFor: ["network"],
        },
      },
    };
    const draft = await createPostgresPlannerDraft(db, {
      ...baseRequest,
      composer: new DeterministicFixtureComposer(),
    });
    const revised = await revisePostgresPlannerDraft(db, {
      draftId: draft.draftId,
      prompt: "add explicit edge-case validation for empty inputs",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer: new DeterministicFixtureComposer(),
    });

    const expectedPlannerRequest = {
      ...baseRequest,
      goalPrompt: revised.goalPrompt,
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
    };
    const revisedRow = await db.one<{
      summary_json: { plannerRequest?: unknown };
      payload_json: { plannerRequest?: unknown };
    }>(
      "select summary_json, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [revised.draftId],
    );
    assert.match(revised.goalPrompt, /Revision request:\nadd explicit edge-case validation/);
    assert.deepEqual(revisedRow.summary_json.plannerRequest, expectedPlannerRequest);
    assert.deepEqual(revisedRow.payload_json.plannerRequest, expectedPlannerRequest);
  });
});

test("Postgres server routes revise planner drafts via planner pipeline", async () => {
  await withDb(async (db) => {
    await seedDeterministicWorkflowGraph(db);
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by planner route test"); } },
      workflowComposer: new DeterministicFixtureComposer(),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by planner routes"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{
        draftId: string;
        goalPrompt: string;
        workflowId: string;
        status: string;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "implement calc sum" }),
      });
      const revised = await api<{
        draftId: string;
        goalPrompt: string;
        workflowId: string;
        status: string;
        taskSummaries: Array<{ taskId: string }>;
      }>(server.url, `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/revise`, {
        method: "POST",
        body: JSON.stringify({ prompt: "add explicit edge-case validation for empty inputs", orchestrationMode: "llm-constrained" }),
      });

      assert.notEqual(revised.draftId, draft.draftId);
      assert.equal(revised.status, "validated");
      assert.match(revised.goalPrompt, /implement calc sum/);
      assert.match(revised.goalPrompt, /add explicit edge-case validation for empty inputs/);
      assert.equal(revised.taskSummaries[0]?.taskId, "understand-repo");
      assert.equal(revised.taskSummaries.at(-1)?.taskId, "summarize-completion");
      assert.equal(revised.taskSummaries.length > 0, true);

      const revisedDraftRow = await db.one<{ summary_json: { goalPrompt?: string } }>(
        "select summary_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
        [revised.draftId],
      );
      assert.equal(revisedDraftRow.summary_json.goalPrompt, revised.goalPrompt);
    } finally {
      await server.close();
    }
  });
});

async function api<T>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  const envelope = JSON.parse(text) as { ok: true; result: T } | { ok: false; error: string };
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.result;
}

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const fixture = await createTestDatabase();
  try {
    await initializeSouthstarSchema(fixture.databaseUrl);
    const db = await openSouthstarDb(fixture.databaseUrl);
    try {
      await run(db);
    } finally {
      await db.close();
    }
  } finally {
    await fixture.drop();
  }
}

async function createFixturePlannerDraft(db: SouthstarDb, goalPrompt: string) {
  await seedDeterministicWorkflowGraph(db);
  return await createPostgresPlannerDraft(db, {
    goalPrompt,
    orchestrationMode: "llm-constrained",
    composerMode: "llm",
    composer: new DeterministicFixtureComposer(),
  });
}

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = resolveTestPostgresAdminUrl();
  const databaseName = `southstar_test_${randomUUID().replace(/-/g, "_")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${quoteIdent(databaseName)}`);
  await admin.end();
  return {
    databaseUrl: replaceDatabase(adminUrl, databaseName),
    async drop() {
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1", [databaseName]);
      await cleanup.query(`drop database if exists ${quoteIdent(databaseName)}`);
      await cleanup.end();
    },
  };
}

function replaceDatabase(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function invalidInspectOnlyPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Invalid Inspect Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "invalid profile for explorer task",
    tasks: inspectPlanTasks("profile.software-maker-pi"),
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function validInspectOnlyPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Valid Inspect Plan",
    selectedWorkflowTemplateRef: "template.software-feature",
    rationale: "valid repaired plan",
    tasks: inspectPlanTasks("profile.software-explorer-codex"),
    rejectedCandidates: [],
    generatedComponentProposals: [],
  };
}

function graphMetadataOnlyPlan(): WorkflowCompositionPlan {
  return {
    schemaVersion: "southstar.workflow_composition_plan.v1",
    title: "Vocabulary Learning Feature",
    selectedWorkflowTemplateRef: "template.dynamic-single-task",
    rationale: "Use graph metadata primitives directly instead of legacy capability candidate maps.",
    tasks: [{
      id: "implement-vocab",
      name: "Implement Vocabulary Feature",
      responsibility: "Build a simple English vocabulary learning feature.",
      dependsOn: [],
      templateSlotRef: "implement",
      agentDefinitionRef: "agent.frontend-developer",
      agentProfileRef: "profile.generated.vocab.implement",
      instructionRefs: ["instruction.react-review"],
      skillRefs: ["skill.react-ui"],
      toolGrantRefs: ["tool.workspace-write"],
      mcpGrantRefs: ["mcp.filesystem-workspace"],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.vocab_feature"],
      evaluatorProfileRef: "evaluator.vocab-quality",
      recoveryStrategyRefs: [],
      rationale: "A frontend developer with UI skill and workspace access can implement the requested feature.",
    }],
    rejectedCandidates: [],
    generatedComponentProposals: [{
      id: "profile.generated.vocab.implement",
      kind: "agent_profile",
      risk: "medium",
      reason: "Generated from approved Postgres graph primitives.",
      validationStatus: "validated",
      agentProfile: {
        workerKind: "execution_worker",
        provider: "pi",
        model: "pi-agent-default",
        thinkingLevel: "high",
        harnessRef: "pi",
        instruction: "Implement the vocabulary learning feature with the selected React UI skill, workspace write tool, filesystem MCP grant, and React review instruction. Produce artifact.vocab_feature.",
        promptTemplateRef: "react-review",
        contextPolicyRef: "context.generated",
        sessionPolicyRef: "session.generated",
        memoryScopes: [],
        agentsMdRefs: [],
        vaultLeasePolicyRefs: [],
        toolPolicy: {
          allowedTools: ["tool.workspace-write"],
          deniedTools: [],
          requiresApprovalFor: [],
        },
        budgetPolicy: {
          maxInputTokens: 120000,
          maxOutputTokens: 8192,
          maxWallTimeSeconds: 900,
        },
        execution: {
          engine: "tork",
          image: "southstar/pi-agent:local",
          command: ["southstar-agent-runner"],
          env: {},
          mounts: [],
          timeoutSeconds: 900,
          infraRetry: { maxAttempts: 1 },
        },
      },
    }],
  };
}

async function seedGraphMetadataOnlyWorkflowPrimitives(db: SouthstarDb): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey: "template.dynamic-single-task",
    objectKind: "workflow_template",
    status: "approved",
    headVersionId: "template.dynamic-single-task@1",
    state: { scope: "software", title: "Dynamic single task" },
  });
  await upsertLibraryObject(db, {
    objectKey: "capability.frontend-ui",
    objectKind: "capability_spec",
    status: "approved",
    headVersionId: "capability.frontend-ui@1",
    state: { scope: "software", title: "Frontend UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "agent.frontend-developer",
    objectKind: "agent_definition",
    status: "approved",
    headVersionId: "agent.frontend-developer@1",
    state: {
      scope: "software",
      title: "Frontend Developer",
    },
  });
  await upsertLibraryObject(db, {
    objectKey: "skill.react-ui",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.react-ui@1",
    state: { scope: "software", title: "React UI" },
  });
  await upsertLibraryObject(db, {
    objectKey: "tool.workspace-write",
    objectKind: "tool_definition",
    status: "approved",
    headVersionId: "tool.workspace-write@1",
    state: { scope: "global", title: "Workspace Write" },
  });
  await upsertLibraryObject(db, {
    objectKey: "mcp.filesystem-workspace",
    objectKind: "mcp_tool_grant",
    status: "approved",
    headVersionId: "mcp.filesystem-workspace@1",
    state: { scope: "global", title: "Filesystem Workspace", serverId: "filesystem-workspace", allowedTools: ["read_file", "write_file"] },
  });
  await upsertLibraryObject(db, {
    objectKey: "instruction.react-review",
    objectKind: "instruction_template",
    status: "approved",
    headVersionId: "instruction.react-review@1",
    state: { scope: "software", title: "React Review" },
  });
  await upsertLibraryObject(db, {
    objectKey: "artifact.vocab_feature",
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId: "artifact.vocab_feature@1",
    state: { scope: "software", title: "Vocabulary feature artifact" },
  });
  await upsertLibraryObject(db, {
    objectKey: "evaluator.vocab-quality",
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId: "evaluator.vocab-quality@1",
    state: { scope: "software", title: "Vocabulary quality evaluator" },
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "uses",
    toObjectKey: "skill.react-ui",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "agent.frontend-developer",
    edgeType: "produces_artifact",
    toObjectKey: "artifact.vocab_feature",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "requires_tool",
    toObjectKey: "tool.workspace-write",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "allows_mcp_grant",
    toObjectKey: "mcp.filesystem-workspace",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "skill.react-ui",
    edgeType: "uses_instruction",
    toObjectKey: "instruction.react-review",
    scope: "software",
  });
  await upsertLibraryEdge(db, {
    fromObjectKey: "evaluator.vocab-quality",
    edgeType: "validates_artifact",
    toObjectKey: "artifact.vocab_feature",
    scope: "software",
  });
}

function inspectPlanTasks(explorerProfileRef: string): WorkflowCompositionPlan["tasks"] {
  return [
    {
      id: "inspect-only",
      name: "Inspect Only",
      responsibility: "inspect repository and produce a plan",
      dependsOn: [],
      templateSlotRef: "understand",
      agentDefinitionRef: "agent.software-explorer",
      agentProfileRef: explorerProfileRef,
      instructionRefs: ["instruction.software-explorer"],
      skillRefs: ["skill.software-repo-discovery"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: [],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "explore repository",
    },
    {
      id: "review-spec",
      name: "Review Spec",
      responsibility: "review plan quality",
      dependsOn: ["inspect-only"],
      templateSlotRef: "review-spec",
      agentDefinitionRef: "agent.software-spec-reviewer",
      agentProfileRef: "profile.software-spec-reviewer-codex",
      instructionRefs: ["instruction.software-spec-reviewer"],
      skillRefs: ["skill.software-spec-review"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_plan"],
      outputArtifactRefs: ["artifact.implementation_plan"],
      evaluatorProfileRef: "evaluator.software-plan-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "review implementation plan before coding",
    },
    {
      id: "implement-feature",
      name: "Implement Feature",
      responsibility: "implement the feature",
      dependsOn: ["review-spec"],
      templateSlotRef: "implement",
      agentDefinitionRef: "agent.software-maker",
      agentProfileRef: "profile.software-maker-pi",
      instructionRefs: ["instruction.software-maker"],
      skillRefs: ["skill.software-implementation"],
      toolGrantRefs: ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_plan"],
      outputArtifactRefs: ["artifact.implementation_report"],
      evaluatorProfileRef: "evaluator.software-feature-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "implement after plan review",
    },
    {
      id: "verify-feature",
      name: "Verify Feature",
      responsibility: "run functional verification",
      dependsOn: ["implement-feature"],
      templateSlotRef: "verify",
      agentDefinitionRef: "agent.software-checker",
      agentProfileRef: "profile.software-checker-codex",
      instructionRefs: ["instruction.software-checker"],
      skillRefs: ["skill.software-verification"],
      toolGrantRefs: ["tool.workspace-read", "tool.shell-command"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_report"],
      outputArtifactRefs: ["artifact.verification_report"],
      evaluatorProfileRef: "evaluator.software-verification-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "validate behavior",
    },
    {
      id: "review-code-quality",
      name: "Review Code Quality",
      responsibility: "review maintainability and quality",
      dependsOn: ["implement-feature"],
      templateSlotRef: "review-code-quality",
      agentDefinitionRef: "agent.software-code-quality-reviewer",
      agentProfileRef: "profile.software-code-quality-reviewer-codex",
      instructionRefs: ["instruction.software-code-quality-reviewer"],
      skillRefs: ["skill.software-code-quality-review"],
      toolGrantRefs: ["tool.workspace-read", "tool.shell-command"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.implementation_report"],
      outputArtifactRefs: ["artifact.verification_report"],
      evaluatorProfileRef: "evaluator.software-verification-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "enforce code quality gate",
    },
    {
      id: "summarize-completion",
      name: "Summarize Completion",
      responsibility: "summarize final outcome",
      dependsOn: ["verify-feature", "review-code-quality"],
      templateSlotRef: "summarize",
      agentDefinitionRef: "agent.software-summarizer",
      agentProfileRef: "profile.software-summarizer-codex",
      instructionRefs: ["instruction.software-summarizer"],
      skillRefs: ["skill.software-summary"],
      toolGrantRefs: ["tool.workspace-read"],
      mcpGrantRefs: [],
      vaultLeasePolicyRefs: [],
      inputArtifactRefs: ["artifact.verification_report"],
      outputArtifactRefs: ["artifact.completion_report"],
      evaluatorProfileRef: "evaluator.software-completion-quality",
      recoveryStrategyRefs: ["retry-same-agent"],
      rationale: "close run with evidence summary",
    },
  ];
}

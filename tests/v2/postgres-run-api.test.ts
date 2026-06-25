import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { initializeSouthstarSchema } from "../../src/v2/db/init.ts";
import { openSouthstarDb, type SouthstarDb } from "../../src/v2/db/postgres.ts";
import type { WorkflowCompositionPlan } from "../../src/v2/design-library/types.ts";
import { createLearningNode } from "../../src/v2/evolution/learning-graph.ts";
import { DeterministicFixtureComposer, ScriptedWorkflowComposer } from "../../src/v2/orchestration/composer.ts";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import {
  approvePostgresPlannerDraftProposal,
  convertPostgresPlannerDraftProposalToLibraryDraft,
  createPostgresPlannerDraft,
  createPostgresRunFromDraft,
  getPostgresPlannerDraftOrchestration,
  listPostgresPlannerDraftProposals,
  rejectPostgresPlannerDraftProposal,
} from "../../src/v2/ui-api/postgres-run-api.ts";
import { createSouthstarRuntimeServer } from "../../src/v2/server/http-server.ts";

test("Postgres run API creates draft, run, tasks, history, and Knowledge Card context packets", async () => {
  await withDb(async (db) => {
    await createLearningNode(db, {
      id: "card-run-api-self-check",
      nodeType: "knowledge_card",
      scope: "software",
      status: "active",
      payload: {
        cardType: "failure_lesson",
        topicKey: "run-api-self-check",
        scope: "software",
        title: "Run API self-check",
        summary: "Implementation reports should include commandsRun and risks.",
        appliesTo: { intents: ["implement_feature"], roles: ["maker"], artifactTypes: ["implementation-report"], agentProfiles: ["software-maker-pi"] },
        claims: [{ text: "Self-check reduces repair loops.", evidenceNodeRefs: ["card-run-api-self-check"] }],
        confidence: 0.9,
        successScore: 0.8,
        status: "active",
        riskTier: "low",
      },
      summaryText: "Implementation reports should include commandsRun and risks.",
    });

    const draft = await createPostgresPlannerDraft(db, { goalPrompt: "implement calc sum" });
    assert.match(draft.draftId, /^draft-wf-gen-/);
    assert.equal(draft.status, "validated");
    assert.deepEqual(draft.validationIssues, []);
    assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    assert.match(run.runId, /^run-wf-gen-/);

    const runRow = await db.one<{ status: string }>("select status from southstar.workflow_runs where id = $1", [run.runId]);
    assert.equal(runRow.status, "created");
    const taskRows = await db.query<{ id: string }>("select id from southstar.workflow_tasks where run_id = $1 order by sort_order", [run.runId]);
    assert.deepEqual(taskRows.rows.map((row) => row.id), ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);

    const history = await db.query<{ event_type: string }>("select event_type from southstar.workflow_history where run_id = $1 order by sequence", [run.runId]);
    assert.deepEqual(history.rows.map((row) => row.event_type), ["run.created", "task.created", "task.created", "task.created", "task.created"]);

    const context = await db.one<{ payload_json: { selectedKnowledgeCards: Array<{ sourceRef: string }> } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'context_packet' and run_id = $1 and task_id = 'implement-feature'",
      [run.runId],
    );
    assert.equal(context.payload_json.selectedKnowledgeCards[0]?.sourceRef, "card-run-api-self-check");

    const trace = await db.one<{ payload_json: { selectedCardRefs: string[] } }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'knowledge_card_injection_trace' and run_id = $1 and task_id = 'implement-feature'",
      [run.runId],
    );
    assert.deepEqual(trace.payload_json.selectedCardRefs, ["card-run-api-self-check"]);
  });
});

test("Postgres run API supports llm-constrained planner drafts and preserves task creation order", async () => {
  await withDb(async (db) => {
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

test("llm-constrained planner trace records analyzer/composer and validation audit metadata for fixture composer", async () => {
  await withDb(async (db) => {
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
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
        llmTrace: {
          goalPromptHash?: string;
          attempts?: Array<{
            attempt?: number;
            parseOutcome?: string;
            validationOutcome?: string;
            issueCodes?: string[];
            compositionHash?: string;
            issuesHash?: string;
          }>;
          prompt?: string;
          response?: string;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    const trace = draftResource.payload_json.plannerTrace;
    assert.equal(trace.analyzerType, "deterministic");
    assert.equal(trace.composerMode, "fixture");
    assert.equal(trace.composerFallbackUsed, false);
    assert.equal(trace.validatorAttempts, 1);
    assert.equal(trace.repairAttempts, 0);
    assert.equal(trace.finalValidationOk, true);
    assert.match(trace.candidatePacketHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(trace.compositionHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(trace.candidatePacketHash, draftResource.payload_json.orchestrationSnapshot.candidatePacketHash);
    assert.notEqual(trace.compositionHash, "");

    const llmTrace = draftResource.payload_json.llmTrace;
    const attempt = llmTrace.attempts?.[0];
    assert.match(llmTrace.goalPromptHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(llmTrace.attempts?.length, 1);
    assert.equal(attempt?.attempt, 0);
    assert.equal(attempt?.parseOutcome, "parsed");
    assert.equal(attempt?.validationOutcome, "valid");
    assert.deepEqual(attempt?.issueCodes, []);
    assert.match(attempt?.compositionHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(attempt?.issuesHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(attempt?.compositionHash, trace.compositionHash);
    assert.equal(llmTrace.prompt, undefined);
    assert.equal(llmTrace.response, undefined);
  });
});

test("llm-with-fixture-fallback sets plannerTrace composerFallbackUsed when primary composer fails", async () => {
  await withDb(async (db) => {
    const failingComposer = {
      async compose() {
        throw new Error("forced llm composer failure");
      },
    };
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum",
      orchestrationMode: "llm-constrained",
      composerMode: "llm-with-fixture-fallback",
      composer: failingComposer,
    });
    const draftResource = await db.one<{
      payload_json: {
        plannerTrace: {
          composerMode?: string;
          composerFallbackUsed?: boolean;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.payload_json.plannerTrace.composerMode, "llm-with-fixture-fallback");
    assert.equal(draftResource.payload_json.plannerTrace.composerFallbackUsed, true);
  });
});

test("Postgres planner draft can use injected scripted LLM composer for non-fixture DAG shape", async () => {
  await withDb(async (db) => {
    const composer = new ScriptedWorkflowComposer([invalidInspectOnlyPlan(), validInspectOnlyPlan()]);
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
      "inspect-only",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);
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
      payload_json: {
        repairAttempts: Array<{ validation: { ok: boolean } }>;
        llmTrace: {
          attempts: Array<{
            attempt: number;
            parseOutcome: string;
            validationOutcome: string;
            issueCodes: string[];
            issuesHash?: string;
          }>;
        };
      };
    }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.status, "invalid");
    assert.equal(draftResource.payload_json.repairAttempts.length, 3);
    assert.equal(draftResource.payload_json.repairAttempts[2]?.validation.ok, false);
    assert.equal(draftResource.payload_json.llmTrace.attempts.length, 3);
    assert.deepEqual(
      draftResource.payload_json.llmTrace.attempts.map((attempt) => attempt.attempt),
      [0, 1, 2],
    );
    assert.deepEqual(
      draftResource.payload_json.llmTrace.attempts.map((attempt) => attempt.validationOutcome),
      ["invalid", "invalid", "invalid"],
    );
    assert.equal(draftResource.payload_json.llmTrace.attempts.every((attempt) => attempt.parseOutcome === "parsed"), true);
    assert.equal(draftResource.payload_json.llmTrace.attempts.every((attempt) => attempt.issueCodes.length > 0), true);
    assert.equal(
      draftResource.payload_json.llmTrace.attempts.every((attempt) => (attempt.issuesHash ?? "").length === 64),
      true,
    );
    await assert.rejects(
      () => createPostgresRunFromDraft(db, { draftId: draft.draftId }),
      /planner draft is not validated/,
    );
  });
});

test("Postgres planner draft orchestration inspection helper returns public summary and orchestration snapshot", async () => {
  await withDb(async (db) => {
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

test("Postgres planner draft proposal lifecycle persists generated proposals and supports approve/reject/convert", async () => {
  await withDb(async (db) => {
    const composer = new ScriptedWorkflowComposer([validInspectOnlyPlanWithGeneratedProposals()]);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with generated proposal review",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer,
    });
    assert.equal(draft.status, "validated");

    const proposals = await listPostgresPlannerDraftProposals(db, { draftId: draft.draftId });
    assert.equal(proposals.length, 2);
    assert.deepEqual(proposals.map((proposal) => proposal.proposalId), [
      "proposal.generated.instruction-review",
      "proposal.generated.skill-quality",
    ]);
    assert.equal(proposals.every((proposal) => proposal.status === "proposed"), true);

    const approved = await approvePostgresPlannerDraftProposal(db, {
      draftId: draft.draftId,
      proposalId: "proposal.generated.instruction-review",
      actorId: "operator-a",
      reason: "looks safe",
    });
    assert.equal(approved.status, "approved-for-draft");

    const rejected = await rejectPostgresPlannerDraftProposal(db, {
      draftId: draft.draftId,
      proposalId: "proposal.generated.skill-quality",
      actorId: "operator-a",
      reason: "needs redesign",
    });
    assert.equal(rejected.status, "rejected");

    const converted = await convertPostgresPlannerDraftProposalToLibraryDraft(db, {
      draftId: draft.draftId,
      proposalId: "proposal.generated.instruction-review",
      actorId: "operator-a",
      reason: "convert to reviewable draft",
    });
    assert.equal(converted.status, "converted");
    assert.ok(converted.libraryDraftId);

    const libraryDraft = await db.one<{ status: string; payload_json: { sourceProposalId?: string; kind?: string } }>(
      "select status, payload_json from southstar.runtime_resources where resource_type = 'library_object_draft' and resource_key = $1",
      [converted.libraryDraftId],
    );
    assert.equal(libraryDraft.status, "draft");
    assert.equal(libraryDraft.payload_json.sourceProposalId, "proposal.generated.instruction-review");
    assert.equal(libraryDraft.payload_json.kind, "instruction_template");
  });
});

test("Postgres planner proposal conversion returns blocked for unsupported proposal kinds", async () => {
  await withDb(async (db) => {
    const composer = new ScriptedWorkflowComposer([validInspectOnlyPlanWithUnsupportedGeneratedProposal()]);
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "implement calc sum with unsupported proposal kind",
      orchestrationMode: "llm-constrained",
      composerMode: "llm",
      composer,
    });
    const proposals = await listPostgresPlannerDraftProposals(db, { draftId: draft.draftId });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.kind, "contract_spec");

    const conversion = await convertPostgresPlannerDraftProposalToLibraryDraft(db, {
      draftId: draft.draftId,
      proposalId: proposals[0]!.proposalId,
      actorId: "operator-a",
      reason: "try convert unsupported kind",
    });
    assert.equal(conversion.status, "blocked");
    assert.match(conversion.reason ?? "", /conversion is not supported/i);
    assert.equal(conversion.libraryDraftId, undefined);
  });
});

test("Postgres planner draft with explicit non-default scope does not silently fallback to software", async () => {
  await withDb(async (db) => {
    await seedSoftwareLibraryGraph(db);
    await mirrorLibraryScope(db, { fromScope: "software", toScope: "research" });
    const draft = await createPostgresPlannerDraft(db, {
      goalPrompt: "research scope calc implementation",
      orchestrationMode: "llm-constrained",
      composerMode: "fixture",
      scope: "research",
    });
    assert.equal(draft.status, "validated");
    const orchestration = await getPostgresPlannerDraftOrchestration(db, { draftId: draft.draftId });
    assert.equal(orchestration.status, "validated");

    const draftResource = await db.one<{
      payload_json: {
        workflow: {
          domain?: string;
          tasks?: Array<{ domain?: string }>;
          harnessDefinitions?: Array<{ capabilities?: string[] }>;
        };
      };
    }>(
      "select payload_json from southstar.runtime_resources where resource_type = 'planner_draft' and resource_key = $1",
      [draft.draftId],
    );
    assert.equal(draftResource.payload_json.workflow.domain, "research");
    assert.equal(draftResource.payload_json.workflow.tasks?.every((task) => task.domain === "research"), true);
    assert.equal(
      draftResource.payload_json.workflow.harnessDefinitions?.every((harness) => harness.capabilities?.includes("research") === true),
      true,
    );

    const run = await createPostgresRunFromDraft(db, { draftId: draft.draftId });
    const runRow = await db.one<{ domain: string; runtime_context_json: { scope?: string } }>(
      "select domain, runtime_context_json from southstar.workflow_runs where id = $1",
      [run.runId],
    );
    assert.equal(runRow.domain, "research");
    assert.equal(runRow.runtime_context_json.scope, "research");
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
      assert.match(draft.draftId, /^draft-wf-gen-/);
      assert.equal(draft.status, "validated");
      assert.deepEqual(draft.validationIssues, []);
      assert.deepEqual(draft.taskSummaries.map((task) => task.taskId), ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);

      const run = await api<{ runId: string; taskIds: string[] }>(server.url, "/api/v2/runs", {
        method: "POST",
        body: JSON.stringify({ draftId: draft.draftId }),
      });
      assert.match(run.runId, /^run-wf-gen-/);
      assert.deepEqual(run.taskIds, ["understand-repo", "implement-feature", "verify-feature", "summarize-completion"]);

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

test("Postgres server proposal lifecycle routes list, approve, reject, and convert generated proposals", async () => {
  await withDb(async (db) => {
    const server = await createSouthstarRuntimeServer({
      db: db as never,
      plannerClient: { generate: async () => { throw new Error("planner client not used by scripted composer test"); } },
      workflowComposer: new ScriptedWorkflowComposer([validInspectOnlyPlanWithGeneratedProposals()]),
      executorProvider: { executorType: "tork", submit: async () => { throw new Error("executor not used by created-state route"); } },
      createReconcileLoop: () => ({ start() {}, stop: async () => {} }),
    });
    try {
      const draft = await api<{ draftId: string }>(server.url, "/api/v2/planner/drafts", {
        method: "POST",
        body: JSON.stringify({ goalPrompt: "route test generated proposals", orchestrationMode: "llm-constrained", composerMode: "llm" }),
      });

      const proposals = await api<Array<{ proposalId: string; status: string }>>(
        server.url,
        `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/proposals`,
        { method: "GET" },
      );
      assert.deepEqual(proposals.map((proposal) => proposal.proposalId), [
        "proposal.generated.instruction-review",
        "proposal.generated.skill-quality",
      ]);
      assert.equal(proposals.every((proposal) => proposal.status === "proposed"), true);

      const approved = await api<{ proposalId: string; status: string }>(
        server.url,
        `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/proposals/proposal.generated.instruction-review/approve`,
        { method: "POST", body: JSON.stringify({ actorId: "operator-route", reason: "approve for draft conversion" }) },
      );
      assert.equal(approved.status, "approved-for-draft");

      const rejected = await api<{ proposalId: string; status: string }>(
        server.url,
        `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/proposals/proposal.generated.skill-quality/reject`,
        { method: "POST", body: JSON.stringify({ actorId: "operator-route", reason: "reject proposal" }) },
      );
      assert.equal(rejected.status, "rejected");

      const converted = await api<{ proposalId: string; status: string; libraryDraftId?: string }>(
        server.url,
        `/api/v2/planner/drafts/${encodeURIComponent(draft.draftId)}/proposals/proposal.generated.instruction-review/convert-to-library-draft`,
        { method: "POST", body: JSON.stringify({ actorId: "operator-route", reason: "convert proposal" }) },
      );
      assert.equal(converted.status, "converted");
      assert.ok(converted.libraryDraftId);
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

async function createTestDatabase(): Promise<{ databaseUrl: string; drop(): Promise<void> }> {
  const adminUrl = process.env.SOUTHSTAR_TEST_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("SOUTHSTAR_TEST_ADMIN_DATABASE_URL is required for Postgres-backed tests");
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

function validInspectOnlyPlanWithGeneratedProposals(): WorkflowCompositionPlan {
  return {
    ...validInspectOnlyPlan(),
    generatedComponentProposals: [
      {
        id: "proposal.generated.instruction-review",
        kind: "instruction_template",
        risk: "low",
        reason: "proposal to refine reviewer instruction detail",
        validationStatus: "unvalidated",
      },
      {
        id: "proposal.generated.skill-quality",
        kind: "skill_definition",
        risk: "medium",
        reason: "proposal to split quality review skill",
        validationStatus: "unvalidated",
      },
    ],
  };
}

function validInspectOnlyPlanWithUnsupportedGeneratedProposal(): WorkflowCompositionPlan {
  return {
    ...validInspectOnlyPlan(),
    generatedComponentProposals: [{
      id: "proposal.generated.unsupported-contract-spec",
      kind: "contract_spec",
      risk: "medium",
      reason: "unsupported conversion kind for this runtime path",
      validationStatus: "unvalidated",
    }],
  };
}

async function mirrorLibraryScope(
  db: SouthstarDb,
  input: { fromScope: string; toScope: string },
): Promise<void> {
  await db.query(
    `update southstar.library_objects
        set state_json = jsonb_set(
          state_json,
          '{domainRefs}',
          to_jsonb(array[$1::text, $2::text]),
          true
        )
      where state_json->>'scope' = $1`,
    [input.fromScope, input.toScope],
  );
  await db.query(
    `insert into southstar.library_edges (
       id,
       from_object_key,
       from_version_ref,
       edge_type,
       to_object_key,
       to_version_ref,
       scope,
       status,
       weight,
       metadata_json,
       created_at
     )
     select
       'edge-' || substr(md5(
         from_object_key || '|' ||
         coalesce(from_version_ref, '') || '|' ||
         edge_type || '|' ||
         to_object_key || '|' ||
         coalesce(to_version_ref, '') || '|' ||
         $2
       ), 1, 20),
       from_object_key,
       from_version_ref,
       edge_type,
       to_object_key,
       to_version_ref,
       $2,
       status,
       weight,
       metadata_json,
       now()
      from southstar.library_edges
     where scope = $1
     on conflict (id) do nothing`,
    [input.fromScope, input.toScope],
  );
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

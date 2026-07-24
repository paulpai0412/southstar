import test from "node:test";
import assert from "node:assert/strict";
import { upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { finalizeGoalRequirementDraft } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  claimGoalSubmissionPg,
  submitClaimedGoalPg,
} from "../../src/v2/orchestration/run-goal-service.ts";
import { handleRuntimeRoute } from "../../src/v2/server/routes.ts";
import { upsertRuntimeResourcePg } from "../../src/v2/stores/postgres-runtime-store.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";
import { seedDeterministicWorkflowGraph } from "./fixtures/deterministic-workflow-composer.ts";
import { fixedGoalInterpreter, softwareGoalContract } from "./fixtures/goal-contract.ts";

test("run-goal persists one Requirement review and confirms its immutable hash", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  const goalPrompt = "Create a vocabulary app";
  try {
    await seedReadyLibrary(db);
    const context = {
      ...runtimeContext(db, goalPrompt),
      libraryImportLlmProvider: goalValidationImportProposalProvider,
      goalRequirementInterpreter: requirementInterpreter({ goalPrompt, cwd, projectRef: "vocab-route" }),
    };

    const request = () => handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalPrompt, cwd, projectRef: "vocab-route", idempotencyKey: "requirements-route-1" }),
    }));
    const response = await request();
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json() as { result: RequirementResult }).result;
    assert.equal(result.draftStatus, "requirements_review");
    assert.equal(result.confirmable, true);
    assert.match(result.goalRequirementDraftHash, /^[a-f0-9]{64}$/);

    const replay = await request();
    assert.equal(replay.status, 200);
    const replayResult = (await replay.json() as { result: RequirementResult }).result;
    assert.equal(replayResult.goalRequirementDraftHash, result.goalRequirementDraftHash);

    const confirmed = await handleRuntimeRoute(context, new Request(
      `http://127.0.0.1/api/v2/planner/drafts/${encodeURIComponent(result.draftId)}/confirm-requirements`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedDraftHash: result.goalRequirementDraftHash, actor: "tester" }),
      },
    ));
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const confirmedResult = (await confirmed.json() as { result: { status: string; phase: string; goalContractHash: string } }).result;
    assert.equal(confirmedResult.status, "library_review");
    assert.equal(confirmedResult.phase, "library_review");
    assert.match(confirmedResult.goalContractHash, /^[a-f0-9]{64}$/);
  } finally {
    await db.close();
  }
});

test("SSE replay emits the persisted Requirement review instead of recomputing it", async () => {
  const db = await createTestPostgresDb();
  const cwd = process.cwd();
  const goalPrompt = "Create a vocabulary app";
  try {
    await seedReadyLibrary(db);
    const context = {
      ...runtimeContext(db, goalPrompt),
      goalRequirementInterpreter: requirementInterpreter({
        goalPrompt,
        cwd,
        blockingInputs: ["Choose the learner language before composing."],
      }),
    };
    const request = () => handleRuntimeRoute(context, new Request("http://127.0.0.1/api/v2/run-goal", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ goalPrompt, cwd, idempotencyKey: "requirements-sse-replay-1" }),
    }));

    const first = parseFrames(await (await request()).text());
    const firstRequirements = first.find((frame) => frame.event === "goal_requirements")?.data as Record<string, unknown>;
    assert.equal(firstRequirements.status, "requirements_review");
    assert.equal(firstRequirements.confirmable, false);
    assert.deepEqual(firstRequirements.blockers, ["Choose the learner language before composing."]);
    assert.ok(firstRequirements.goalRequirementDraft);
    assert.equal(first.at(-1)?.event, "done");

    const replay = parseFrames(await (await request()).text());
    const replayRequirements = replay.find((frame) => frame.event === "goal_requirements")?.data as Record<string, unknown>;
    assert.equal(replayRequirements.draftId, firstRequirements.draftId);
    assert.equal(replayRequirements.goalRequirementDraftHash, firstRequirements.goalRequirementDraftHash);
    assert.equal(replayRequirements.confirmable, firstRequirements.confirmable);
    assert.equal(replay.at(-1)?.event, "done");
  } finally {
    await db.close();
  }
});

test("run-goal returns 503 before claiming a submission when Library is not ready", async () => {
  const db = await createTestPostgresDb();
  try {
    for (const accept of ["application/json", "text/event-stream"]) {
      const response = await handleRuntimeRoute(runtimeContext(db, "Build a vocabulary app"), new Request("http://127.0.0.1/api/v2/run-goal", {
        method: "POST",
        headers: { accept, "content-type": "application/json" },
        body: JSON.stringify({
          goalPrompt: "Build a vocabulary app",
          cwd: "/workspace/software",
          idempotencyKey: `library-not-ready-${accept}`,
        }),
      }));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "library_not_ready",
        message: "Library reconciliation has not produced a ready snapshot",
        diagnostics: [],
      });
    }
    const claims = await db.one<{ count: string }>(
      "select count(*)::text as count from southstar.runtime_resources where resource_type = 'goal_submission'",
    );
    assert.equal(Number(claims.count), 0);
  } finally {
    await db.close();
  }
});

test("missing Goal Requirement interpreter persists a failed submission diagnostic", async () => {
  const db = await createTestPostgresDb();
  const goalPrompt = "Create a vocabulary app";
  const request = {
    goalPrompt,
    cwd: process.cwd(),
    idempotencyKey: "missing-requirement-interpreter",
  };
  try {
    const claim = await claimGoalSubmissionPg(db, request);
    await assert.rejects(
      submitClaimedGoalPg(runtimeContext(db, goalPrompt), request, claim),
      /goal_requirement_interpreter_not_configured/,
    );
    const submission = await db.one<{ status: string; payload_json: Record<string, unknown> }>(
      "select status, payload_json from southstar.runtime_resources where id = $1",
      [claim.submissionId],
    );
    assert.equal(submission.status, "failed");
    assert.match(String(submission.payload_json.failure), /goal_requirement_interpreter_not_configured/);
  } finally {
    await db.close();
  }
});

type RequirementResult = {
  draftId: string;
  draftStatus: string;
  goalRequirementDraftHash: string;
  confirmable?: boolean;
};

function requirementInterpreter(input: { goalPrompt: string; cwd: string; projectRef?: string; blockingInputs?: string[] }) {
  return {
    async interpret() {
      return finalizeGoalRequirementDraft({
        goalPrompt: input.goalPrompt,
        cwd: input.cwd,
        ...(input.projectRef ? { projectRef: input.projectRef } : {}),
        summary: "Create a vocabulary app with a reviewable offline flow.",
        requirements: [{
          title: "Vocabulary review",
          statement: "A user can review a vocabulary item offline.",
          source: "explicit" as const,
          blocking: true,
          userVisibleBehaviors: ["The item and answer are shown."],
          businessRules: [],
          acceptanceCriteria: [{
            observableClaim: "A vocabulary item can be reviewed offline.",
            blocking: true,
            verificationIntent: ["Open the app offline and complete one vocabulary review."],
            requiredAssurance: ["browser_interaction"],
            evidenceIntent: ["screenshot"],
          }],
          expectedOutcomeArtifacts: [{ description: "Vocabulary review UI", mediaType: "text/html" }],
          verificationIntent: ["Open the app and complete one review."],
          assumptions: [],
          openQuestions: [],
          riskTags: [],
          interactionContractRefs: [],
        }],
        nonGoals: [],
        blockingInputs: input.blockingInputs ?? [],
      });
    },
    async revise() {
      throw new Error("revision not used");
    },
  };
}

function runtimeContext(db: Awaited<ReturnType<typeof createTestPostgresDb>>, goalPrompt: string) {
  return {
    db,
    goalInterpreter: fixedGoalInterpreter(softwareGoalContract(goalPrompt)),
    plannerClient: { generate: async () => { throw new Error("planner not used"); } },
    executorProvider: { executorType: "tork" as const, submit: async () => { throw new Error("executor not used"); } },
  };
}

async function seedReadyLibrary(db: Awaited<ReturnType<typeof createTestPostgresDb>>): Promise<void> {
  await seedDeterministicWorkflowGraph(db);
  await upsertLibraryObject(db, {
    objectKey: "skill.southstar-goal-design",
    objectKind: "skill_spec",
    status: "approved",
    headVersionId: "skill.southstar-goal-design@test",
    state: { purpose: "goal_design", body: "Design cohesive outcome slices." },
  });
  await upsertRuntimeResourcePg(db, {
    resourceType: "library_readiness",
    resourceKey: "library-readiness:current",
    scope: "runtime",
    status: "ready",
    title: "Current Library readiness",
    payload: {
      schemaVersion: "southstar.library_readiness.v1",
      ready: true,
      status: "ready",
      snapshotHash: "test-ready",
      sourceRoot: "/workspace/software/library",
      reconciledAt: new Date().toISOString(),
      trigger: "startup",
      includedCount: 1,
      excludedCount: 0,
      diagnostics: [],
    },
    summary: "ready",
    metrics: { included: 1, excluded: 0 },
  });
}

const goalValidationImportProposalProvider = async ({ prompt }: { prompt: string }) => {
  if (prompt.startsWith("Rank only the supplied approved artifact contracts")) return { recommendations: [] };
  if (prompt.startsWith("Generate ontology edges")) return { proposedEdges: [] };
  const match = prompt.match(/GoalValidationCoverageConstraints:\n(\[[\s\S]*?\])\nThis is one complete proposal/);
  const constraints = match ? JSON.parse(match[1]!) as Array<{
    gapRef: string;
    requirementId: string;
    criterionIds: string[];
    blocking?: boolean;
  }> : [];
  const artifactObjectKey = "artifact.test-goal-review-evidence";
  const evaluatorObjectKey = "evaluator.test-goal-review";
  return {
    candidates: [
      {
        objectKey: artifactObjectKey,
        kind: "artifact",
        title: "Reusable review evidence",
        scope: "software",
        description: "Reusable browser review evidence contract.",
        selectedByDefault: true,
        confidence: 1,
        classificationReason: "Test-only reusable artifact contract.",
        artifactType: "review_evidence.v1",
        mediaTypes: ["application/json"],
        evidenceKinds: ["screenshot"],
        validationRules: ["Must contain browser review evidence."],
        schemaRef: "southstar.artifact.review_evidence.v1",
        requiredFields: ["browserEvidence"],
        provenanceRequirements: ["Capture evidence from a local browser run."],
      },
      {
        objectKey: evaluatorObjectKey,
        kind: "evaluator",
        title: "Reusable review evidence evaluator",
        scope: "software",
        description: "Reusable evaluator for browser review evidence.",
        selectedByDefault: true,
        confidence: 1,
        classificationReason: "Test-only reusable evaluator profile.",
        validatesArtifactRefs: [artifactObjectKey],
        requiredInputs: ["artifactPayload"],
        evidenceKinds: ["screenshot"],
        verificationModes: ["browser_interaction"],
        verificationProcedures: [{
          id: "review-browser-flow",
          checkKind: "browser_interaction",
          instruction: "Verify the browser review flow from the submitted screenshot evidence.",
          allowedEvidenceKinds: ["screenshot"],
        }],
        independencePolicy: "independent",
        resultSchemaRef: "southstar.requirement_evaluator_result.v2",
        failureClassifications: ["missing-required-evidence"],
      },
    ],
    candidateCoverageTargets: constraints
      .filter((constraint) => constraint.blocking)
      .flatMap((constraint) => [artifactObjectKey, evaluatorObjectKey].map((candidateObjectKey) => ({
        candidateObjectKey,
        gapRef: constraint.gapRef,
        requirementId: constraint.requirementId,
        criterionIds: constraint.criterionIds,
      }))),
  };
};

function parseFrames(text: string): Array<{ event: string; data: unknown }> {
  return text.trim().split("\n\n").map((frame) => {
    const lines = frame.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message",
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null"),
    };
  });
}

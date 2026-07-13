import assert from "node:assert/strict";
import test from "node:test";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { confirmGoalRequirementDraft, finalizeGoalRequirementDraft } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import {
  assertGoalValidationResolutionReady,
  resolveGoalValidationPg,
  type GoalValidationCandidateRanker,
  type GoalValidationCandidateRecommendationV1,
} from "../../src/v2/orchestration/goal-validation-resolver.ts";
import type { GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import type { GoalRequirementDraftV1 } from "../../src/v2/orchestration/goal-requirement-draft.ts";
import type { SouthstarDb } from "../../src/v2/db/postgres.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("resolver binds only approved artifact and evaluator versions", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1");
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2");
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const contract = confirmedContract();
    const result = await resolveGoalValidationPg(db, {
      goalContract: contract,
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: "artifact.article-html",
        evaluatorRef: "evaluator.offline-browser",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
        expectedEvidenceKinds: ["screenshot"],
      }),
    });
    assert.equal(result.gaps.length, 0);
    assert.equal(result.bindings[0]!.artifactContractVersionRefs[0], "artifact.article-html@1");
    assert.equal(result.bindings[0]!.evaluatorProfileVersionRef, "evaluator.offline-browser@2");
    assert.deepEqual(result.bindings[0]!.acceptanceCriteria, contract.requirements[0]!.acceptanceCriteria);
    assert.equal(result.previews[0]!.status, "ready");
    assert.equal(result.ready, true);
    assert.doesNotThrow(() => assertGoalValidationResolutionReady(result));
  });
});

test("resolver reports a structured gap instead of selecting draft or invented refs", async () => {
  await withDb(async (db) => {
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: "artifact.missing",
        evaluatorRef: "evaluator.missing",
        verificationMode: "deterministic",
        procedureRef: "procedure.missing",
      }),
    });
    assert.deepEqual(result.bindings, []);
    assert.deepEqual(result.gaps.map((gap) => gap.kind).sort(), ["artifact", "evaluator"]);
    assert.equal(result.previews[0]!.status, "missing");
    assert.equal(result.ready, false);
    assert.throws(() => assertGoalValidationResolutionReady(result), /not ready/);
  });
});

test("resolver rejects criteria drift and evaluator evidence that the artifact cannot accept", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1", ["artifact-ref"]);
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2", ["screenshot"]);
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const draft = confirmedRequirementDraft();
    const driftedDraft: GoalRequirementDraftV1 = {
      ...draft,
      requirements: draft.requirements.map((requirement) => ({
        ...requirement,
        acceptanceCriteria: [{ ...requirement.acceptanceCriteria[0]!, statement: "different criterion" }],
      })),
    };
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: driftedDraft,
      ranker: fixedRanker({
        artifactRef: "artifact.article-html",
        evaluatorRef: "evaluator.offline-browser",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
        expectedEvidenceKinds: ["screenshot"],
      }),
    });
    assert.equal(result.bindings.length, 0);
    assert.equal(result.gaps.some((gap) => gap.kind === "criteria"), true);
  });
});

test("resolver rejects ranker-invented evidence kinds", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1", ["screenshot"]);
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2", ["screenshot"]);
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: "artifact.article-html",
        evaluatorRef: "evaluator.offline-browser",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
        expectedEvidenceKinds: ["screenshot", "invented-evidence"],
      }),
    });
    assert.equal(result.bindings.length, 0);
    assert.equal(result.gaps.some((gap) => gap.kind === "evidence" && gap.message.includes("invented")), true);
  });
});

test("resolver ignores draft objects and stale graph edges", async () => {
  await withDb(async (db) => {
    await upsertLibraryObject(db, {
      objectKey: "artifact.draft",
      objectKind: "artifact_contract",
      status: "draft",
      headVersionId: "artifact.draft@1",
      state: artifactState(["screenshot"]),
    });
    await upsertLibraryObject(db, {
      objectKey: "evaluator.stale",
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: "evaluator.stale@2",
      state: evaluatorState(["screenshot"]),
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "evaluator.stale",
      fromVersionRef: "evaluator.stale@1",
      edgeType: "validates_artifact",
      toObjectKey: "artifact.draft",
      toVersionRef: "artifact.draft@1",
      scope: "article",
    });
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: "artifact.draft",
        evaluatorRef: "evaluator.stale",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
      }),
    });
    assert.equal(result.bindings.length, 0);
    assert.equal(result.gaps.some((gap) => gap.kind === "artifact"), true);
  });
});

test("resolver treats scope all as unscoped but requires pinned validation edges", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1");
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2");
    await upsertLibraryEdge(db, {
      fromObjectKey: "evaluator.offline-browser",
      edgeType: "validates_artifact",
      toObjectKey: "artifact.article-html",
      scope: "article",
    });
    const ranker = fixedRanker({
      artifactRef: "artifact.article-html",
      evaluatorRef: "evaluator.offline-browser",
      verificationMode: "browser_interaction",
      procedureRef: "procedure.offline-open",
    });
    const unpinned = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker,
      scope: "all",
    });
    assert.equal(unpinned.bindings.length, 0);
    assert.equal(unpinned.gaps.some((gap) => gap.kind === "edge"), true);
    await db.query("delete from southstar.library_edges");
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const pinned = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker,
      scope: "all",
    });
    assert.equal(pinned.bindings.length, 1);
    assert.equal(pinned.gaps.length, 0);
  });
});

async function withDb(run: (db: SouthstarDb) => Promise<void>): Promise<void> {
  const db = await createTestPostgresDb();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}

function confirmedRequirementDraft(): GoalRequirementDraftV1 {
  return finalizeGoalRequirementDraft({
    goalPrompt: "Build an offline article viewer",
    cwd: "/workspace/article",
    summary: "Build an offline article viewer",
    requirements: [{
      title: "Offline article",
      statement: "The article opens offline and remains readable",
      source: "explicit",
      blocking: true,
      userVisibleBehaviors: ["article content is readable"],
      businessRules: ["no network dependency"],
      acceptanceCriteria: [{
        statement: "The rendered article opens offline and is readable",
        evidenceIntent: ["screenshot"],
      }],
      expectedOutcomeArtifacts: [{ description: "self-contained HTML article", mediaType: "text/html" }],
      verificationIntent: ["browser interaction"],
      assumptions: [],
      openQuestions: [],
      riskTags: [],
      interactionContractRefs: [],
    }],
    nonGoals: [],
    blockingInputs: [],
  });
}

function confirmedContract(): GoalContractV1 {
  const draft = confirmedRequirementDraft();
  return confirmGoalRequirementDraft(draft, {
    domain: "article",
    intent: "build_offline_article",
    workType: "general",
    expectedArtifactRefs: [],
    requiredCapabilities: [],
    assumptions: [],
    requestedSideEffects: ["workspace-write"],
  });
}

function fixedRanker(recommendation: GoalValidationCandidateRecommendationV1): GoalValidationCandidateRanker {
  return { rank: async () => [recommendation] };
}

async function approvedArtifact(
  db: SouthstarDb,
  objectKey: string,
  headVersionId: string,
  evidenceKinds = ["screenshot"],
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId,
    state: artifactState(evidenceKinds),
  });
}

async function approvedEvaluator(
  db: SouthstarDb,
  objectKey: string,
  headVersionId: string,
  evidenceKinds = ["screenshot"],
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId,
    state: evaluatorState(evidenceKinds),
  });
}

async function validatesArtifactEdge(db: SouthstarDb, evaluatorRef: string, artifactRef: string): Promise<void> {
  await upsertLibraryEdge(db, {
    fromObjectKey: evaluatorRef,
    fromVersionRef: evaluatorRef === "evaluator.offline-browser" ? "evaluator.offline-browser@2" : undefined,
    edgeType: "validates_artifact",
    toObjectKey: artifactRef,
    toVersionRef: artifactRef === "artifact.article-html" ? "artifact.article-html@1" : undefined,
    scope: "article",
  });
}

function artifactState(evidenceKinds: string[]): Record<string, unknown> {
  return {
    scope: "article",
    title: "Article HTML",
    artifactType: "article_html",
    requiredFields: ["content"],
    validationRules: ["rule.self-contained-html"],
    evidenceKinds,
  };
}

function evaluatorState(evidenceKinds: string[]): Record<string, unknown> {
  return {
    scope: "article",
    title: "Offline browser evaluator",
    verificationModes: ["browser_interaction"],
    verificationProcedures: [{
      id: "procedure.offline-open",
      checkKind: "browser_interaction",
      instruction: "Open the artifact offline and inspect readable content.",
      allowedEvidenceKinds: evidenceKinds,
    }],
    evidenceKinds,
    resultSchemaRef: "schema.evaluator-result.v1",
    independencePolicy: "independent",
    failureClassifications: ["network_dependency", "unreadable_content"],
  };
}

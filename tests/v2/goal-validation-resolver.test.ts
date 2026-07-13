import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { upsertLibraryEdge, upsertLibraryObject } from "../../src/v2/design-library/library-graph-store.ts";
import { findLibraryObjectByKey } from "../../src/v2/design-library/library-graph-store.ts";
import {
  readLibraryFile,
  syncLibraryFileRecordToGraph,
  syncLibraryFileToGraph,
} from "../../src/v2/design-library/files/library-file-store.ts";
import { parseLibraryFileContent } from "../../src/v2/design-library/files/library-file-parser.ts";
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
    assert.equal(unpinned.gaps.find((gap) => gap.kind === "edge")!.candidateRefs.includes("evaluator.offline-browser"), true);
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

test("real approved flashcard files sync versioned edges and produce a ready binding", async () => {
  await withDb(async (db) => {
    const libraryRoot = resolve(process.cwd(), "library");
    await syncLibraryFileToGraph(db, {
      root: libraryRoot,
      relativePath: "artifacts/flashcard-deck-contract.artifact.yaml",
    });
    await syncLibraryFileToGraph(db, {
      root: libraryRoot,
      relativePath: "evaluators/flashcard-deck-contract-validator.evaluator.yaml",
    });
    const artifact = await findLibraryObjectByKey(db, "artifact.flashcard-deck-contract");
    const evaluator = await findLibraryObjectByKey(db, "evaluator.flashcard-deck-contract-validator");
    assert.ok(artifact?.headVersionId);
    assert.ok(evaluator?.headVersionId);
    const edge = await db.one<{ from_version_ref: string; to_version_ref: string }>(
      `select from_version_ref, to_version_ref
         from southstar.library_edges
        where from_object_key = $1 and edge_type = 'validates_artifact' and to_object_key = $2`,
      [evaluator!.objectKey, artifact!.objectKey],
    );
    assert.equal(edge.from_version_ref, evaluator!.headVersionId);
    assert.equal(edge.to_version_ref, artifact!.headVersionId);
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract("artifact-ref"),
      requirementDraft: confirmedRequirementDraft("artifact-ref"),
      scope: "general",
      ranker: fixedRanker({
        artifactRef: "artifact.flashcard-deck-contract",
        evaluatorRef: "evaluator.flashcard-deck-contract-validator",
        verificationMode: "deterministic",
        procedureRef: "procedure.flashcard-deck-contract",
      }),
    });
    assert.equal(result.ready, true);
    assert.equal(result.gaps.length, 0);
    assert.equal(result.bindings[0]!.artifactContractVersionRefs[0], artifact!.headVersionId);
    assert.equal(result.bindings[0]!.evaluatorProfileVersionRef, evaluator!.headVersionId);

    const artifactFile = await readLibraryFile({
      root: libraryRoot,
      relativePath: "artifacts/flashcard-deck-contract.artifact.yaml",
    });
    const v2Content = artifactFile.content.replace(
      'title: "Flashcard Deck Contract"',
      'title: "Flashcard Deck Contract v2"',
    );
    const parsedV2 = parseLibraryFileContent({
      path: "library/artifacts/flashcard-deck-contract.artifact.yaml",
      content: v2Content,
    });
    assert.equal(parsedV2.ok, true);
    if (!parsedV2.ok) throw new Error("expected v2 artifact file to parse");
    const oldArtifactVersion = artifact.headVersionId;
    const oldEdge = await db.one<{
      id: string;
      metadata_json: Record<string, unknown>;
    }>(
      `select id, metadata_json
         from southstar.library_edges
        where from_object_key = $1 and edge_type = 'validates_artifact' and to_object_key = $2 and status = 'active'`,
      [evaluator!.objectKey, artifact!.objectKey],
    );

    const syncedV2 = await syncLibraryFileRecordToGraph(db, parsedV2.file);
    assert.notEqual(syncedV2.object.headVersionId, oldArtifactVersion);
    const activeEdges = await db.query<{
      id: string;
      from_version_ref: string | null;
      to_version_ref: string | null;
      status: string;
      metadata_json: Record<string, unknown>;
    }>(
      `select id, from_version_ref, to_version_ref, status, metadata_json
         from southstar.library_edges
        where from_object_key = $1 and edge_type = 'validates_artifact' and to_object_key = $2
        order by id`,
      [evaluator!.objectKey, artifact!.objectKey],
    );
    const activeAfterRepin = activeEdges.rows.filter((candidate) => candidate.status === "active");
    assert.equal(activeAfterRepin.length, 1);
    assert.equal(activeAfterRepin[0]!.id === oldEdge.id, false);
    assert.equal(activeAfterRepin[0]!.from_version_ref, evaluator!.headVersionId);
    assert.equal(activeAfterRepin[0]!.to_version_ref, syncedV2.object.headVersionId);
    assert.deepEqual(activeAfterRepin[0]!.metadata_json, oldEdge.metadata_json);
    assert.equal(activeEdges.rows.find((candidate) => candidate.id === oldEdge.id)?.status, "inactive");

    const afterRepin = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract("artifact-ref"),
      requirementDraft: confirmedRequirementDraft("artifact-ref"),
      scope: "general",
      ranker: fixedRanker({
        artifactRef: "artifact.flashcard-deck-contract",
        evaluatorRef: "evaluator.flashcard-deck-contract-validator",
        verificationMode: "deterministic",
        procedureRef: "procedure.flashcard-deck-contract",
      }),
    });
    assert.equal(afterRepin.ready, true);
    assert.equal(afterRepin.gaps.length, 0);
    assert.equal(afterRepin.bindings[0]!.artifactContractVersionRefs[0], syncedV2.object.headVersionId);
  });
});

test("legacy approved files remain blocked when their evaluator contract is incomplete", async () => {
  await withDb(async (db) => {
    const libraryRoot = resolve(process.cwd(), "library");
    await syncLibraryFileToGraph(db, {
      root: libraryRoot,
      relativePath: "artifacts/review-session-report.artifact.yaml",
    });
    await syncLibraryFileToGraph(db, {
      root: libraryRoot,
      relativePath: "evaluators/review-report-evaluator.evaluator.yaml",
    });
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract("artifact-ref"),
      requirementDraft: confirmedRequirementDraft("artifact-ref"),
      scope: "general",
      ranker: fixedRanker({
        artifactRef: "artifact.review-session-report",
        evaluatorRef: "evaluator.review-report-evaluator",
        verificationMode: "deterministic",
        procedureRef: "procedure.review-report",
      }),
    });
    assert.equal(result.ready, false);
    assert.equal(result.bindings.length, 0);
    assert.equal(result.gaps.some((gap) => gap.kind === "artifact"), true);
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

function confirmedRequirementDraft(evidenceIntent = "screenshot"): GoalRequirementDraftV1 {
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
        evidenceIntent: [evidenceIntent],
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

function confirmedContract(evidenceIntent = "screenshot"): GoalContractV1 {
  const draft = confirmedRequirementDraft(evidenceIntent);
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

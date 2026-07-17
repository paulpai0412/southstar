import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

test("resolver blocks an approved but semantically mismatched artifact/evaluator pair before DAG composition", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1", ["screenshot"], ["vocabulary", "accuracy"]);
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2", ["screenshot"], ["vocabulary", "accuracy"]);
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract("screenshot", ["riddle", "answer-feedback"]),
      requirementDraft: confirmedRequirementDraft("screenshot", ["riddle", "answer-feedback"]),
      ranker: fixedRanker({
        artifactRef: "artifact.article-html",
        evaluatorRef: "evaluator.offline-browser",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
        expectedEvidenceKinds: ["screenshot"],
      }),
    });

    assert.equal(result.bindings.length, 0);
    assert.equal(result.ready, false);
    assert.equal(result.gaps.some((gap) => gap.kind === "semantic" && gap.message.includes("riddle")), true);
  });
});

test("resolver keeps approved validation pairs when object and edge scopes cross the Goal domain", async () => {
  await withDb(async (db) => {
    await upsertLibraryObject(db, {
      objectKey: "artifact.product-outcome",
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.product-outcome@1",
      state: { ...artifactState(["screenshot"]), scope: "product" },
    });
    await upsertLibraryObject(db, {
      objectKey: "evaluator.testing-outcome",
      objectKind: "evaluator_profile",
      status: "approved",
      headVersionId: "evaluator.testing-outcome@1",
      state: {
        ...evaluatorState(["screenshot"]),
        scope: "testing",
        validatesArtifactRefs: ["artifact.product-outcome"],
      },
    });
    await upsertLibraryEdge(db, {
      fromObjectKey: "evaluator.testing-outcome",
      fromVersionRef: "evaluator.testing-outcome@1",
      edgeType: "validates_artifact",
      toObjectKey: "artifact.product-outcome",
      toVersionRef: "artifact.product-outcome@1",
      scope: "testing",
    });

    const result = await resolveGoalValidationPg(db, {
      goalContract: { ...confirmedContract(), domain: "vocabulary_flashcard_software" },
      requirementDraft: confirmedRequirementDraft(),
      scope: "vocabulary_flashcard_software",
      ranker: fixedRanker({
        artifactRef: "artifact.product-outcome",
        evaluatorRef: "evaluator.testing-outcome",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
        expectedEvidenceKinds: ["screenshot"],
      }),
    });

    assert.equal(result.ready, true);
    assert.equal(result.gaps.length, 0);
    assert.equal(result.bindings[0]?.artifactContractVersionRefs[0], "artifact.product-outcome@1");
    assert.equal(result.bindings[0]?.evaluatorProfileVersionRef, "evaluator.testing-outcome@1");
  });
});

test("resolver ranks independent requirements in parallel but preserves contract order", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1");
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2");
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const firstDraft = confirmedRequirementDraft();
    const firstRequirement = firstDraft.requirements[0]!;
    const secondRequirement = {
      ...firstRequirement,
      id: "req-parallel-second",
      title: "Second offline article",
      statement: "A second article opens offline and remains readable",
      acceptanceCriteria: firstRequirement.acceptanceCriteria.map((criterion) => ({
        ...criterion,
        id: "criterion-parallel-second",
        statement: "The second rendered article opens offline and is readable",
      })),
    };
    const requirementDraft: GoalRequirementDraftV1 = {
      ...firstDraft,
      requirements: [firstRequirement, secondRequirement],
      draftHash: "parallel-requirement-draft",
    };
    const firstContract = confirmedContract();
    const goalContract: GoalContractV1 = {
      ...firstContract,
      requirements: [
        firstContract.requirements[0]!,
        {
          ...firstContract.requirements[0]!,
          id: secondRequirement.id,
          statement: secondRequirement.statement,
          acceptanceCriteria: secondRequirement.acceptanceCriteria.map((criterion) => criterion.statement),
        },
      ],
    };
    let activeRanks = 0;
    let maxActiveRanks = 0;
    const result = await resolveGoalValidationPg(db, {
      goalContract,
      requirementDraft,
      ranker: async () => {
        activeRanks += 1;
        maxActiveRanks = Math.max(maxActiveRanks, activeRanks);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        activeRanks -= 1;
        return [{
          artifactRef: "artifact.article-html",
          evaluatorRef: "evaluator.offline-browser",
          verificationMode: "browser_interaction",
          procedureRef: "procedure.offline-open",
          expectedEvidenceKinds: ["screenshot"],
        }];
      },
    });

    assert.equal(maxActiveRanks, 2);
    assert.deepEqual(result.previews.map((preview) => preview.requirementId), goalContract.requirements.map((requirement) => requirement.id));
    assert.deepEqual(result.bindings.map((binding) => binding.requirementId), goalContract.requirements.map((requirement) => requirement.id));
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

test("resolver discards rejected alternative gaps when a later ranked recommendation binds", async () => {
  await withDb(async (db) => {
    await approvedArtifact(db, "artifact.article-html", "artifact.article-html@1", ["screenshot"]);
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2", ["screenshot"]);
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");

    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: {
        rank: async () => [{
          artifactRef: "artifact.article-html",
          evaluatorRef: "evaluator.offline-browser",
          verificationMode: "browser_interaction",
          procedureRef: "procedure.offline-open",
          expectedEvidenceKinds: ["policy-decision"],
        }, {
          artifactRef: "artifact.article-html",
          evaluatorRef: "evaluator.offline-browser",
          verificationMode: "browser_interaction",
          procedureRef: "procedure.offline-open",
          expectedEvidenceKinds: ["screenshot"],
        }],
      },
    });

    assert.equal(result.bindings.length, 1);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.ready, true);
  });
});

test("resolver rejects unknown executable contract fields already persisted in the graph", async () => {
  await withDb(async (db) => {
    await upsertLibraryObject(db, {
      objectKey: "artifact.article-html",
      objectKind: "artifact_contract",
      status: "approved",
      headVersionId: "artifact.article-html@1",
      state: { ...artifactState(["screenshot"]), legacyBypass: true },
    });
    await approvedEvaluator(db, "evaluator.offline-browser", "evaluator.offline-browser@2");
    await validatesArtifactEdge(db, "evaluator.offline-browser", "artifact.article-html");
    const result = await resolveGoalValidationPg(db, {
      goalContract: confirmedContract(),
      requirementDraft: confirmedRequirementDraft(),
      ranker: fixedRanker({
        artifactRef: "artifact.article-html",
        evaluatorRef: "evaluator.offline-browser",
        verificationMode: "browser_interaction",
        procedureRef: "procedure.offline-open",
        expectedEvidenceKinds: ["screenshot"],
      }),
    });
    assert.equal(result.ready, false);
    assert.match(result.gaps.map((item) => item.message).join("\n"), /unsupported fields: legacyBypass/);
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
    await upsertLibraryEdge(db, {
      fromObjectKey: evaluator!.objectKey,
      fromVersionRef: evaluator!.headVersionId!,
      edgeType: "validates",
      toObjectKey: artifact!.objectKey,
      toVersionRef: artifact!.headVersionId!,
      scope: "general",
      metadata: { sourcePath: "library/evaluators/flashcard-deck-contract-validator.evaluator.yaml", edgeOrigin: "generic-validation" },
    });
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
    const oldGenericEdge = await db.one<{
      id: string;
      metadata_json: Record<string, unknown>;
    }>(
      `select id, metadata_json
         from southstar.library_edges
        where from_object_key = $1 and edge_type = 'validates' and to_object_key = $2 and status = 'active'`,
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

    const genericEdges = await db.query<{
      id: string;
      from_version_ref: string | null;
      to_version_ref: string | null;
      status: string;
      metadata_json: Record<string, unknown>;
    }>(
      `select id, from_version_ref, to_version_ref, status, metadata_json
         from southstar.library_edges
        where from_object_key = $1 and edge_type = 'validates' and to_object_key = $2
        order by id`,
      [evaluator!.objectKey, artifact!.objectKey],
    );
    const activeGenericAfterRepin = genericEdges.rows.filter((candidate) => candidate.status === "active");
    assert.equal(activeGenericAfterRepin.length, 1);
    assert.equal(activeGenericAfterRepin[0]!.id === oldGenericEdge.id, false);
    assert.equal(activeGenericAfterRepin[0]!.from_version_ref, evaluator!.headVersionId);
    assert.equal(activeGenericAfterRepin[0]!.to_version_ref, syncedV2.object.headVersionId);
    assert.deepEqual(activeGenericAfterRepin[0]!.metadata_json, oldGenericEdge.metadata_json);
    assert.equal(genericEdges.rows.find((candidate) => candidate.id === oldGenericEdge.id)?.status, "inactive");

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

test("legacy approved files fail closed before resolver use when their executable contract is incomplete", async () => {
  await withDb(async (db) => {
    const libraryRoot = await mkdtemp("/tmp/southstar-legacy-library-");
    try {
      await mkdir(join(libraryRoot, "artifacts"));
      await writeFile(join(libraryRoot, "artifacts", "legacy-report.artifact.yaml"), [
        "schemaVersion: southstar.library.artifact_contract_file.v1",
        "id: artifact.legacy_report",
        "title: Legacy report",
        "scope: general",
        "description: A legacy contract missing executable media types.",
        "status: approved",
        "artifactType: report",
        "evidenceKinds:",
        "  - artifact-ref",
        "validationRules:",
        "  - Report exists",
        "schemaRef: southstar.legacy_report.v1",
        "requiredFields:",
        "  - summary",
        "provenanceRequirements:",
        "  - producer",
      ].join("\n"), "utf8");
      await assert.rejects(() => syncLibraryFileToGraph(db, {
        root: libraryRoot,
        relativePath: "artifacts/legacy-report.artifact.yaml",
      }), /mediaTypes/);
      assert.equal(await findLibraryObjectByKey(db, "artifact.legacy_report"), null);
    } finally {
      await rm(libraryRoot, { recursive: true, force: true });
    }
  });
});

test("evaluator downgrade deactivates all active validation edges on source sync", async () => {
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
    const evaluator = await findLibraryObjectByKey(db, "evaluator.flashcard-deck-contract-validator");
    const artifact = await findLibraryObjectByKey(db, "artifact.flashcard-deck-contract");
    assert.ok(evaluator?.headVersionId);
    assert.ok(artifact?.headVersionId);
    await upsertLibraryEdge(db, {
      fromObjectKey: evaluator!.objectKey,
      fromVersionRef: evaluator!.headVersionId!,
      edgeType: "validates",
      toObjectKey: artifact!.objectKey,
      toVersionRef: artifact!.headVersionId!,
      scope: "general",
      metadata: { sourcePath: "library/evaluators/flashcard-deck-contract-validator.evaluator.yaml", edgeOrigin: "generic-validation" },
    });

    const evaluatorFile = await readLibraryFile({
      root: libraryRoot,
      relativePath: "evaluators/flashcard-deck-contract-validator.evaluator.yaml",
    });
    const downgradedContent = evaluatorFile.content.replace("status: approved", "status: draft");
    const parsedDowngraded = parseLibraryFileContent({
      path: "library/evaluators/flashcard-deck-contract-validator.evaluator.yaml",
      content: downgradedContent,
    });
    assert.equal(parsedDowngraded.ok, true);
    if (!parsedDowngraded.ok) throw new Error("expected downgraded evaluator file to parse");
    const downgraded = await syncLibraryFileRecordToGraph(db, parsedDowngraded.file);
    assert.equal(downgraded.object.status, "draft");

    const edges = await db.query<{ edge_type: string; status: string }>(
      `select edge_type, status
         from southstar.library_edges
        where from_object_key = $1 and to_object_key = $2
        order by edge_type, status`,
      [evaluator!.objectKey, artifact!.objectKey],
    );
    assert.deepEqual(edges.rows, [
      { edge_type: "validates", status: "inactive" },
      { edge_type: "validates_artifact", status: "inactive" },
    ]);
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

function confirmedRequirementDraft(evidenceIntent = "screenshot", semanticTags?: string[]): GoalRequirementDraftV1 {
  return finalizeGoalRequirementDraft({
    goalPrompt: "Build an offline article viewer",
    cwd: "/workspace/article",
    summary: "Build an offline article viewer",
    requirements: [{
      title: "Offline article",
      statement: "The article opens offline and remains readable",
      ...(semanticTags ? { semanticTags } : {}),
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

function confirmedContract(evidenceIntent = "screenshot", semanticTags?: string[]): GoalContractV1 {
  const draft = confirmedRequirementDraft(evidenceIntent, semanticTags);
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
  semanticTags?: string[],
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind: "artifact_contract",
    status: "approved",
    headVersionId,
    state: artifactState(evidenceKinds, semanticTags),
  });
}

async function approvedEvaluator(
  db: SouthstarDb,
  objectKey: string,
  headVersionId: string,
  evidenceKinds = ["screenshot"],
  semanticTags?: string[],
): Promise<void> {
  await upsertLibraryObject(db, {
    objectKey,
    objectKind: "evaluator_profile",
    status: "approved",
    headVersionId,
    state: evaluatorState(evidenceKinds, semanticTags),
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

function artifactState(evidenceKinds: string[], semanticTags?: string[]): Record<string, unknown> {
  return {
    scope: "article",
    title: "Article HTML",
    artifactType: "article_html",
    mediaTypes: ["text/html"],
    requiredFields: ["content"],
    validationRules: ["rule.self-contained-html"],
    evidenceKinds,
    schemaRef: "schema.article-html.v1",
    provenanceRequirements: ["workspace-artifact"],
    ...(semanticTags ? { semanticTags } : {}),
  };
}

function evaluatorState(evidenceKinds: string[], semanticTags?: string[]): Record<string, unknown> {
  return {
    scope: "article",
    title: "Offline browser evaluator",
    validatesArtifactRefs: ["artifact.article-html"],
    requiredInputs: ["accepted-artifact"],
    verificationModes: ["browser_interaction"],
    verificationProcedures: [{
      id: "procedure.offline-open",
      checkKind: "browser_interaction",
      instruction: "Open the artifact offline and inspect readable content.",
      allowedEvidenceKinds: evidenceKinds,
    }],
    evidenceKinds,
    resultSchemaRef: "southstar.requirement_evaluator_result.v2",
    independencePolicy: "independent",
    failureClassifications: ["network_dependency", "unreadable_content"],
    ...(semanticTags ? { semanticTags } : {}),
  };
}

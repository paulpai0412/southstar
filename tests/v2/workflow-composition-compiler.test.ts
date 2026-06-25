import assert from "node:assert/strict";
import test from "node:test";
import { seedSoftwareLibraryGraph } from "../../src/v2/design-library/software-library-seed.ts";
import { resolveWorkflowCandidates } from "../../src/v2/orchestration/candidate-resolver.ts";
import { compileWorkflowComposition } from "../../src/v2/orchestration/composition-compiler.ts";
import { DeterministicFixtureComposer } from "../../src/v2/orchestration/composer.ts";
import { analyzeRequirementDeterministically } from "../../src/v2/orchestration/requirement-analyzer.ts";
import { createTestPostgresDb } from "./postgres-test-utils.ts";

test("compiler builds library-constrained workflow manifest and snapshot from approved candidates", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composer = new DeterministicFixtureComposer();
    const composition = await composer.compose({
      goalPrompt: "implement calc sum",
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-test-run",
      goalPrompt: "implement calc sum",
      candidatePacket,
      composition,
    });

    assert.equal(compiled.workflow.schemaVersion, "southstar.v2");
    assert.equal(compiled.workflow.workflowGeneration?.generatorPolicyRef, "library-constrained-llm");
    assert.deepEqual(compiled.workflow.tasks.map((task) => task.id), [
      "understand-repo",
      "review-spec",
      "implement-feature",
      "verify-feature",
      "review-code-quality",
      "summarize-completion",
    ]);

    const makerTask = compiled.workflow.tasks.find((task) => task.id === "implement-feature");
    assert.ok(makerTask, "implement-feature task should exist");
    assert.equal(makerTask.agentProfileRef, "software-maker-pi");
    assert.deepEqual(makerTask.instructionRefs, ["instruction.software-maker"]);
    assert.deepEqual(makerTask.toolGrantRefs, ["tool.workspace-read", "tool.workspace-write", "tool.shell-command"]);

    assert.equal(compiled.orchestrationSnapshot.validation.ok, true);
    assert.equal(
      compiled.orchestrationSnapshot.candidateSummary.agentProfileRefs.includes("profile.software-maker-pi"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("compiler resolves runtime role/profile definitions for deterministic fixture composition", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-roles-profiles-test-run",
      goalPrompt: "implement calc sum",
      candidatePacket,
      composition,
    });

    const reviewSpec = compiled.workflow.tasks.find((task) => task.id === "review-spec");
    assert.ok(reviewSpec, "review-spec task should exist");
    assert.equal(reviewSpec.agentProfileRef, "software-spec-reviewer-codex");

    const reviewCodeQuality = compiled.workflow.tasks.find((task) => task.id === "review-code-quality");
    assert.ok(reviewCodeQuality, "review-code-quality task should exist");
    assert.equal(reviewCodeQuality.agentProfileRef, "software-code-quality-reviewer-codex");

    assert.equal(compiled.workflow.roles?.some((role) => role.id === "spec-reviewer"), true);
    assert.equal(
      compiled.workflow.agentProfiles?.some((profile) => profile.id === "software-spec-reviewer-codex"),
      true,
    );
  } finally {
    await db.close();
  }
});

test("compiler snapshot freezes only selected library version refs", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "software" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      candidatePacket,
    });

    const explorerSkills = candidatePacket.skillCandidatesByProfile["profile.software-explorer-codex"] ?? [];
    assert.ok(explorerSkills.length > 0, "expected explorer profile to have skill candidates");
    const selectedExplorerSkillVersionRef = explorerSkills[0]?.versionRef;
    assert.ok(selectedExplorerSkillVersionRef, "expected explorer skill candidate to include a versionRef");

    const inflatedPacket = {
      ...candidatePacket,
      workflowTemplateCandidates: [
        ...candidatePacket.workflowTemplateCandidates,
        {
          ...candidatePacket.workflowTemplateCandidates[0],
          ref: "template.unused",
          versionRef: "template.unused@v1",
        },
      ],
      skillCandidatesByProfile: {
        ...candidatePacket.skillCandidatesByProfile,
        "profile.software-explorer-codex": [
          ...explorerSkills,
          {
            ...explorerSkills[0],
            ref: "skill.unused",
            versionRef: "skill.unused@v1",
          },
        ],
      },
    };

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-selected-version-refs-test-run",
      goalPrompt: "implement calc sum",
      candidatePacket: inflatedPacket,
      composition,
    });

    assert.equal(
      compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes("template.software-feature@v1"),
      true,
    );
    assert.equal(
      compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes(selectedExplorerSkillVersionRef),
      true,
    );
    assert.equal(compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes("template.unused@v1"), false);
    assert.equal(compiled.orchestrationSnapshot.compiler.libraryVersionRefs.includes("skill.unused@v1"), false);
  } finally {
    await db.close();
  }
});

test("compiler threads explicit scope into workflow domain, task domain, and harness capabilities", async () => {
  const db = await createTestPostgresDb();
  try {
    await seedSoftwareLibraryGraph(db);
    await mirrorLibraryScope(db, { fromScope: "software", toScope: "research" });
    const requirementSpec = analyzeRequirementDeterministically("implement calc sum");
    const candidatePacket = await resolveWorkflowCandidates(db, { requirementSpec, scope: "research" });
    const composition = await new DeterministicFixtureComposer().compose({
      goalPrompt: "implement calc sum",
      candidatePacket,
    });

    const compiled = await compileWorkflowComposition(db, {
      runId: "draft-library-explicit-scope",
      goalPrompt: "implement calc sum",
      candidatePacket,
      composition,
      scope: "research",
    });

    assert.equal(compiled.workflow.domain, "research");
    assert.equal(compiled.workflow.tasks.every((task) => task.domain === "research"), true);
    assert.equal(
      compiled.workflow.harnessDefinitions?.every((harness) => harness.capabilities.includes("research")),
      true,
    );
  } finally {
    await db.close();
  }
});

async function mirrorLibraryScope(
  db: Awaited<ReturnType<typeof createTestPostgresDb>>,
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

import assert from "node:assert/strict";
import test from "node:test";
import type { GoalContractV1 } from "../../src/v2/orchestration/goal-contract.ts";
import {
  finalizeGoalContract,
  GoalContractVocabularyGapError,
  goalContractHash,
  interpretGoalContractWithLlm,
  requirementSpecFromGoalContract,
  reviseGoalContract,
} from "../../src/v2/orchestration/goal-contract.ts";

test("Goal interpreter returns structured vocabulary gaps without repairing into unrelated refs", async () => {
  let attempts = 0;
  await assert.rejects(
    () => interpretGoalContractWithLlm({
      goalPrompt: "Build membership subscriptions",
      cwd: "/workspace/membership",
      libraryVocabulary: {
        scopes: ["software"],
        capabilityRefs: ["capability.repo-read"],
        artifactRefs: ["artifact.implementation_report"],
      },
      client: {
        async generateText() {
          attempts += 1;
          return JSON.stringify({
            domain: "membership",
            intent: "deliver_membership_subscriptions",
            workType: "software_feature",
            summary: "Deliver membership subscriptions",
            requirements: [{
              statement: "Members can subscribe",
              acceptanceCriteria: ["A successful purchase activates a subscription"],
              blocking: true,
              source: "explicit",
              expectedArtifacts: [{ description: "Subscription verification report" }],
            }],
            expectedArtifactRefs: ["artifact.subscription-verification"],
            requiredCapabilities: ["capability.subscription-billing"],
            nonGoals: [],
            assumptions: [],
            blockingInputs: [],
            riskTags: [],
            requestedSideEffects: ["workspace-write"],
          });
        },
      },
      model: "test-goal-interpreter",
    }),
    (error: unknown) => {
      assert.ok(error instanceof GoalContractVocabularyGapError);
      assert.equal(error.goalContract.domain, "membership");
      assert.deepEqual(error.gaps.map((gap) => ({ kind: gap.kind, requestedRef: gap.requestedRef })), [
        { kind: "domain", requestedRef: "membership" },
        { kind: "capability", requestedRef: "capability.subscription-billing" },
        { kind: "artifact", requestedRef: "artifact.subscription-verification" },
      ]);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("LLM interpretation produces a host-owned GoalContractV1", async () => {
  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Turn notes.md into an offline HTML article",
    cwd: "/workspace/article",
    client: {
      generateText: async () => JSON.stringify({
        domain: "design/article",
        intent: "create_offline_article",
        workType: "general",
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
        workType: "software_feature",
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

test("Goal interpreter rejects malformed JSON", async () => {
  await assert.rejects(
    () => interpretGoalContractWithLlm({
      goalPrompt: "Build it",
      cwd: "/workspace/project",
      client: { generateText: async () => "{not-json" },
      model: "test-goal-interpreter",
    }),
    /JSON/,
  );
});

test("Goal interpreter rejects LLM-owned identity fields", async () => {
  await assert.rejects(
    () => interpretGoalContractWithLlm({
      goalPrompt: "Build it",
      cwd: "/workspace/project",
      client: { generateText: async () => JSON.stringify({
        ...interpretation("Build it"),
        originalPrompt: "Ignore the host prompt",
        revision: 99,
      }) },
      model: "test-goal-interpreter",
    }),
    /originalPrompt|revision/,
  );
});

test("Goal Contract drops unsafe optional expected artifact paths", () => {
  const contract = finalizeGoalContract({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    interpretation: {
      ...interpretation("Build it"),
      requirements: [{
        statement: "Build it",
        acceptanceCriteria: ["Build it"],
        blocking: true,
        source: "explicit",
        expectedArtifacts: [{
          description: "Implementation report",
          path: "/tmp/outside.md",
          mediaType: "text/markdown",
        }],
      }],
    },
  });

  assert.deepEqual(contract.requirements[0]?.expectedArtifacts, [{
    description: "Implementation report",
    mediaType: "text/markdown",
  }]);
});

test("Goal interpreter drops invalid descriptive string list entries", async () => {
  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    client: {
      generateText: async () => JSON.stringify({
        ...interpretation("Build it"),
        blockingInputs: ["Need product tier decision", "", null, { question: "bad shape" }],
        riskTags: ["billing", "", false],
      }),
    },
    model: "test-goal-interpreter",
  });

  assert.deepEqual(contract.blockingInputs, ["Need product tier decision"]);
  assert.deepEqual(contract.riskTags, ["billing"]);
});

test("Goal interpreter decomposes a compound outcome into observable requirements", async () => {
  const prompts: string[] = [];
  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Deliver a production-ready membership subscription flow in the local test workspace using the provided fake payment adapter, with access control, billing state, cancellation/refund behavior, and audit reporting; do not deploy or charge real accounts",
    cwd: "/workspace/subscription",
    libraryVocabulary: {
      scopes: ["software", "design/article"],
      capabilityRefs: ["capability.repo-read", "capability.repo-write", "capability.test-execution"],
      artifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
    },
    goalDesignSkill: {
      objectKey: "skill.southstar-goal-design",
      versionRef: "skill.southstar-goal-design@v1",
      stateHash: "skill-state",
      body: "# Southstar Goal Design",
    },
    workspaceDiscovery: {
      schemaVersion: "southstar.workspace_goal_discovery.v1",
      cwd: "/workspace/subscription",
      entries: [],
      instructionDocuments: [],
      projectMetadata: [],
      truncated: false,
      discoveryHash: "workspace-discovery",
    },
    client: {
      async generateText(input) {
        prompts.push(input.prompt);
        return JSON.stringify({
        domain: "software",
        intent: "implement_feature",
        workType: "software_feature",
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
  assert.match(prompts[0] ?? "", /do not put details discoverable from the local workspace or library in blockingInputs/i);
  assert.match(prompts[0] ?? "", /blockingInputs are only for information unavailable from the prompt, workspace, and library/i);
  assert.match(prompts[0] ?? "", /safe, reversible local\/test implementation choices/i);
  assert.match(prompts[0] ?? "", /blocking=true for every requirement needed to satisfy the requested outcome/i);
  assert.match(prompts[0] ?? "", /GoalContractInterpretationSchema:/);
  assert.match(prompts[0] ?? "", /Every array item must be a non-empty string/i);
  assert.match(prompts[0] ?? "", /blockingInputs: string\[\]/);
  assert.match(prompts[0] ?? "", /expectedArtifacts\[\]\.path/i);
  assert.match(prompts[0] ?? "", /AvailableLibraryVocabulary:/);
  assert.match(prompts[0] ?? "", /AllowedCapabilities: \["capability.repo-read","capability.repo-write","capability.test-execution"\]/);
  assert.match(prompts[0] ?? "", /AllowedArtifactRefs: \["artifact.implementation_report","artifact.verification_report"\]/);
  assert.match(prompts[0] ?? "", /host will stop composition and create a reviewable vocabulary gap/i);
  assert.match(prompts[0] ?? "", /design\/article/);
  assert.match(prompts[0] ?? "", /GoalDesignSkillVersionRef: skill\.southstar-goal-design@v1/);
  assert.match(prompts[0] ?? "", /WorkspaceDiscovery:/);
  assert.equal(contract.requirements.length, 4);
  assert.equal(contract.requirements.every((requirement) => requirement.acceptanceCriteria.length > 0), true);
  assert.equal(contract.requirements.some((requirement) => /^(plan|implement|verify|review)\b/i.test(requirement.statement)), false);
});

test("Goal interpreter requires workType in new LLM schema", async () => {
  await assert.rejects(
    () => interpretGoalContractWithLlm({
      goalPrompt: "Build it",
      cwd: "/workspace/project",
      client: { generateText: async () => JSON.stringify({
        ...interpretation("Build it"),
        workType: undefined,
      }) },
      model: "test-goal-interpreter",
    }),
    /workType/,
  );
});

test("Goal interpreter relays streaming deltas", async () => {
  const deltas: string[] = [];
  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    client: {
      async generateText() {
        throw new Error("generateText should not be called");
      },
      async generateTextStream(_input, handlers) {
        handlers.onDelta?.("{");
        handlers.onDelta?.("\"domain\"");
        return JSON.stringify(interpretation("Build it"));
      },
    },
    model: "test-goal-interpreter",
    onDelta: (text) => deltas.push(text),
  });

  assert.equal(contract.summary, "Build it");
  assert.deepEqual(deltas, ["{", "\"domain\""]);
});

test("Goal interpreter repairs one schema-invalid LLM response", async () => {
  const prompts: string[] = [];
  let callCount = 0;

  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    client: {
      async generateText(input) {
        prompts.push(input.prompt);
        callCount += 1;
        return JSON.stringify({
          ...interpretation("Build it"),
          requirements: [{
            statement: "Build it",
            acceptanceCriteria: ["Build it"],
            blocking: true,
            source: callCount === 1 ? "user" : "explicit",
          }],
        });
      },
    },
    model: "test-goal-interpreter",
  });

  assert.equal(callCount, 2);
  assert.equal(contract.requirements[0]?.source, "explicit");
  assert.match(prompts[1] ?? "", /previous response was invalid/i);
  assert.match(prompts[1] ?? "", /source must be explicit or inferred/i);
  assert.match(prompts[1] ?? "", /\"source\":\"user\"/);
});

test("Goal interpreter repairs malformed Library vocabulary refs", async () => {
  const prompts: string[] = [];
  let callCount = 0;

  const contract = await interpretGoalContractWithLlm({
    goalPrompt: "Build a membership flow",
    cwd: "/workspace/project",
    libraryVocabulary: {
      scopes: ["software"],
      capabilityRefs: ["capability.repo-write", "capability.test-execution"],
      artifactRefs: ["artifact.implementation_report", "artifact.verification_report"],
    },
    client: {
      async generateText(input) {
        prompts.push(input.prompt);
        callCount += 1;
        return JSON.stringify({
          ...interpretation("Build a membership flow"),
          domain: callCount === 1 ? "membership_subscriptions" : "software",
          expectedArtifactRefs: callCount === 1
            ? ["membership-code"]
            : ["artifact.implementation_report", "artifact.verification_report"],
          requiredCapabilities: callCount === 1
            ? ["javascript-esm-implementation", "fake-payment-adapter-integration"]
            : ["capability.repo-write", "capability.test-execution"],
        });
      },
    },
    model: "test-goal-interpreter",
  });

  assert.equal(callCount, 2);
  assert.equal(contract.domain, "software");
  assert.deepEqual(contract.requiredCapabilities, ["capability.repo-write", "capability.test-execution"]);
  assert.deepEqual(contract.expectedArtifactRefs, ["artifact.implementation_report", "artifact.verification_report"]);
  assert.match(prompts[1] ?? "", /expectedArtifactRefs refs must start with artifact\./i);
});

test("Goal interpreter fails closed after one bounded repair", async () => {
  let callCount = 0;

  await assert.rejects(
    () => interpretGoalContractWithLlm({
      goalPrompt: "Build it",
      cwd: "/workspace/project",
      client: {
        async generateText() {
          callCount += 1;
          return "not json";
        },
      },
      model: "test-goal-interpreter",
    }),
    /invalid JSON/,
  );
  assert.equal(callCount, 2);
});

test("Goal Contract hashing is independent of object key insertion order", () => {
  const contract = finalizeGoalContract({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    interpretation: interpretation("Build it"),
  });
  const reordered = Object.fromEntries(Object.entries(contract).reverse()) as GoalContractV1;

  assert.equal(goalContractHash(reordered), goalContractHash(contract));
});

test("Goal Contract revision keeps ids for unchanged statements", () => {
  const previousContract = finalizeGoalContract({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    interpretation: interpretation("Build it"),
  });
  const revised = reviseGoalContract({
    previousContract,
    goalPrompt: "Build it with docs",
    cwd: "/workspace/project",
    interpretation: {
      ...interpretation("Build it with docs"),
      requirements: [{
        statement: "Build it",
        acceptanceCriteria: ["Build it with passing tests"],
        blocking: true,
        source: "explicit",
      }],
    },
  });

  assert.equal(revised.revision, 2);
  assert.equal(revised.requirements[0]!.id, previousContract.requirements[0]!.id);
});

test("Goal Contract revision carries prior explicit requirements forward", () => {
  const previousContract = finalizeGoalContract({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    interpretation: interpretation("Build it"),
  });
  const revised = reviseGoalContract({
    previousContract,
    goalPrompt: "Also document it",
    cwd: "/workspace/project",
    interpretation: {
      ...interpretation("Also document it"),
      requirements: [{
        statement: "Document it",
        acceptanceCriteria: ["The usage is documented"],
        blocking: true,
        source: "explicit",
      }],
    },
  });

  assert.deepEqual(revised.requirements.map((requirement) => requirement.statement), ["Document it", "Build it"]);
});

test("Goal Contract projects to RequirementSpecV2", () => {
  const spec = requirementSpecFromGoalContract(finalizeGoalContract({
    goalPrompt: "Build it",
    cwd: "/workspace/project",
    interpretation: {
      ...interpretation("Build it"),
      expectedArtifactRefs: ["artifact.implementation_report"],
      requiredCapabilities: ["capability.repo-write"],
      nonGoals: ["Do not deploy"],
      assumptions: ["The repository is available"],
      blockingInputs: ["Missing API token"],
      riskTags: ["external-api"],
    },
  }));

  assert.deepEqual(spec, {
    summary: "Build it",
    workType: "software_feature",
    requiredCapabilities: ["capability.repo-write"],
    expectedArtifacts: ["artifact.implementation_report"],
    acceptanceCriteria: ["Build it"],
    nonGoals: ["Do not deploy"],
    riskNotes: ["external-api"],
    workspaceAssumptions: ["The repository is available"],
    missingInputs: ["Missing API token"],
  });
});

test("Goal Contract workType is schema output rather than a domain regex", () => {
  const contract = finalizeGoalContract({
    goalPrompt: "Investigate the source",
    cwd: "/workspace/project",
    interpretation: {
      ...interpretation("Investigate the source"),
      domain: "custom/domain",
      intent: "unfamiliar_intent",
      workType: "research",
    },
  });

  assert.equal(requirementSpecFromGoalContract(contract).workType, "research");
});

function interpretation(summary: string) {
  return {
    domain: "software",
    intent: "implement_feature",
    workType: "software_feature" as const,
    summary,
    requirements: [{
      statement: summary,
      acceptanceCriteria: [summary],
      blocking: true,
      source: "explicit" as const,
    }],
    expectedArtifactRefs: [] as string[],
    requiredCapabilities: [] as string[],
    nonGoals: [] as string[],
    assumptions: [] as string[],
    blockingInputs: [] as string[],
    riskTags: [] as string[],
    requestedSideEffects: [] as string[],
  };
}

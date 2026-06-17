import assert from "node:assert/strict";
import { createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { validateWorkflowManifest } from "../../../src/v2/manifests/validate.ts";
import { seedSoftwareDevDesignLibrary } from "../../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../../src/v2/design-library/designer.ts";
import { applyWorkflowTemplatePatch } from "../../../src/v2/design-library/patch.ts";
import { approveDraftForRun, validateTemplateFromRun } from "../../../src/v2/design-library/lifecycle.ts";
import { compileTemplateVersionToManifest } from "../../../src/v2/design-library/compiler.ts";
import { matchValidatedTemplateForIssue } from "../../../src/v2/design-library/reuse.ts";
import { assertDesignLibraryQuantitativeGates, assertDesignLibraryRealE2EGates, assertDesignLibrarySessionRecoveryGates } from "../../../src/v2/quality/design-library-gates.ts";
import { upsertRuntimeResource } from "../../../src/v2/stores/resource-store.ts";
import type { RealE2EEnv } from "../env.ts";
import {
  assertPiHostAdapterE2E,
  assertTodoWebFeatureImplemented,
  createScenarioContext,
  prepareTodoWebFeatureIssueRepo,
  startCallbackServer,
  todoWebFeatureIssuePacket,
  waitForRunStatus,
  waitForTorkJob,
} from "./harness.ts";

export type DesignLibraryRecoveryMode = "none" | "compact-retry" | "fork-from-checkpoint" | "rollback-workspace";

export async function runDesignLibraryTemplateRealScenario(
  env: RealE2EEnv,
  options: { recoveryMode?: DesignLibraryRecoveryMode } = {},
): Promise<{ runId: string; repo: string; templateVersionId: string; durationMs: number }> {
  assertPiHostAdapterE2E(env);
  const startedAt = Date.now();
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  const repo = prepareTodoWebFeatureIssueRepo(env, "design-library-todo-web-feature-issue");

  try {
    seedSoftwareDevDesignLibrary(context.db, { actorType: "migration" });
    const seedGate = assertDesignLibraryQuantitativeGates(context.db, {
      minApprovedVersions: 14,
      minAgentSpecs: 5,
    });
    assert.equal(seedGate.ok, true, seedGate.failures.join("\n"));

    const issue = todoWebFeatureIssuePacket(repo);
    const recoveryInstructions = recoveryModeInstructions(options.recoveryMode ?? "none");
    const issueWithRecovery = recoveryInstructions.length === 0
      ? issue
      : {
        ...issue,
        body: [issue.body, ...recoveryInstructions].join("\n"),
        acceptanceCriteria: [...issue.acceptanceCriteria, ...recoveryInstructions],
      };

    const design = await createWorkflowDesignDraftFromIssue(context.db, {
      issue: issueWithRecovery,
      actorType: "llm",
      plannerClient: context.plannerClient,
    });

    applyWorkflowTemplatePatch(context.db, {
      baseDraftId: design.draftId,
      actor: "llm",
      rationale: "Tighten checker contract and validator refs for browser evidence enforcement.",
      operations: [
        {
          op: "set-contracts",
          nodeId: "checker",
          contractRefs: ["software-dev.contract.verification-artifact"],
        },
        {
          op: "set-validators",
          nodeId: "checker",
          validatorRefs: ["software-dev.validator.schema-evidence-policy@1.0.0"],
        },
      ],
    });

    const approved = approveDraftForRun(context.db, {
      draftId: design.draftId,
      approvedBy: "user",
      version: "1.0.0",
    });

    const manifest = compileTemplateVersionToManifest(context.db, {
      templateVersionId: approved.templateVersionId,
      issue: issueWithRecovery,
      runInputs: {
        repoPath: repo,
        issueTitle: issueWithRecovery.title,
        issueBody: issueWithRecovery.body,
        acceptanceCriteria: issueWithRecovery.acceptanceCriteria,
      },
      compilerVersion: "design-library-compiler-v1",
    });

    const manifestValidation = validateWorkflowManifest(manifest);
    assert.equal(manifestValidation.ok, true, JSON.stringify(manifestValidation.issues));
    assert.equal(manifest.tasks.every((task) => task.subagents.every((subagent) => subagent.harnessId === "pi")), true);
    assert.equal(manifest.harnessDefinitions.every((harness) => harness.kind === "pi-agent"), true);

    const draftId = `design-library-${manifest.workflowId}`;
    upsertRuntimeResource(context.db, {
      id: draftId,
      resourceType: "planner_draft",
      resourceKey: draftId,
      scope: "planner",
      status: "validated",
      title: manifest.title,
      payload: {
        workflow: manifest,
        plannerTrace: {
          model: "design-library-compiler-v1",
          promptHash: manifest.compiledFrom?.inputHash ?? "",
          generatedAt: new Date().toISOString(),
        },
      },
      summary: {
        goalPrompt: manifest.goalPrompt,
        workflowId: manifest.workflowId,
        plannerMs: 0,
        validationMs: 0,
      },
    });

    const run = await createRunFromDraft(context.db, {
      draftId,
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      contextRefreshUrl: callback.contextRefreshUrl,
      harnessEndpoint: env.piHarnessEndpoint,
    });

    await waitForTorkJob(env.torkBaseUrl, run.tork.jobId, 15 * 60 * 1000);
    await waitForRunStatus(context.db, run.runId, ["passed", "completed"], 120_000);

    assertSkillSnapshotsMaterialized(context.db, run.runId, "checker", [
      "software-dev.skill.artifact-generator-base",
      "software-dev.skill.checker-verification",
    ]);
    assertCheckerArtifactEvidenceAccepted(context.db, run.runId);

    await assertTodoWebFeatureImplemented(repo);

    validateTemplateFromRun(context.db, {
      templateVersionId: approved.templateVersionId,
      runId: run.runId,
      actorType: "runtime",
    });

    const e2eGate = assertDesignLibraryRealE2EGates(context.db, {
      runId: run.runId,
      templateVersionId: approved.templateVersionId,
      maxPayloadBytes: 50_000,
      minCompletedTasks: 5,
    });
    assert.equal(e2eGate.ok, true, e2eGate.failures.join("\n"));

    if ((options.recoveryMode ?? "none") !== "none") {
      const recoveryGate = assertDesignLibrarySessionRecoveryGates(context.db, { runId: run.runId });
      assert.equal(recoveryGate.ok, true, recoveryGate.failures.join("\n"));
    }

    const reuseIssue = todoWebFeatureIssuePacket(repo);
    const reuse = matchValidatedTemplateForIssue(context.db, {
      issue: {
        ...reuseIssue,
        title: "Todo-web: add tags and filtered views",
        body: "Another low-risk todo-web feature issue with complete repository path and acceptance criteria.",
      },
    });
    assert.equal(reuse.confidence >= 0.85, true, JSON.stringify(reuse));
    assert.equal(reuse.missingInputs.length, 0);
    assert.equal(reuse.risk, "low");
    assert.equal(reuse.clarificationQuestionCount, 0);

    const durationMs = Date.now() - startedAt;
    assert.equal(durationMs <= 15 * 60 * 1000, true, `scenario took ${durationMs}ms`);
    return { runId: run.runId, repo, templateVersionId: approved.templateVersionId, durationMs };
  } finally {
    await callback.close();
  }
}

function assertSkillSnapshotsMaterialized(
  db: ReturnType<typeof createScenarioContext>["db"],
  runId: string,
  taskId: string,
  expectedSkillIds: string[],
): void {
  const envelopeRow = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'task_envelope' and run_id = ? and task_id = ?
    order by updated_at desc limit 1
  `).get(runId, taskId) as { payload_json: string } | undefined;
  assert.ok(envelopeRow, `missing task envelope for ${runId}/${taskId}`);

  const envelope = JSON.parse(envelopeRow.payload_json) as {
    skills?: Array<{ skillId?: string; instructions?: string }>;
  };
  const skillIds = (envelope.skills ?? []).map((skill) => skill.skillId);

  for (const expected of expectedSkillIds) {
    assert.equal(skillIds.includes(expected), true, `missing skill ${expected}`);
    const skill = (envelope.skills ?? []).find((candidate) => candidate.skillId === expected);
    assert.equal(typeof skill?.instructions === "string" && skill.instructions.length > 100, true, `skill ${expected} instructions too small`);
  }
}

function assertCheckerArtifactEvidenceAccepted(
  db: ReturnType<typeof createScenarioContext>["db"],
  runId: string,
): void {
  const artifactRow = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'artifact' and run_id = ? and task_id = 'checker'
    order by updated_at desc limit 1
  `).get(runId) as { payload_json: string } | undefined;
  assert.ok(artifactRow, `missing checker artifact for ${runId}`);

  const artifactPayload = JSON.parse(artifactRow.payload_json) as {
    artifact?: Record<string, unknown>;
  };
  const artifact = artifactPayload.artifact ?? artifactPayload;
  for (const field of ["summary", "commandsRun", "testResults", "checkerFindings", "risks"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(artifact, field), true, `checker artifact missing ${field}`);
  }

  const evidenceRow = db.prepare(`
    select payload_json from runtime_resources
    where resource_type = 'evidence_packet' and run_id = ? and task_id = 'checker'
    order by updated_at desc limit 1
  `).get(runId) as { payload_json: string } | undefined;
  assert.ok(evidenceRow, `missing checker evidence packet for ${runId}`);

  const evidence = JSON.parse(evidenceRow.payload_json) as {
    evidenceItems?: Array<{ kind?: string; status?: string }>;
  };
  assert.equal(evidence.evidenceItems?.some((item) => item.kind === "command-output" && item.status === "present"), true);
  assert.equal(evidence.evidenceItems?.some((item) => item.kind === "test-result" && item.status === "present"), true);
}

function recoveryModeInstructions(mode: DesignLibraryRecoveryMode): string[] {
  if (mode === "compact-retry") {
    return [
      "Session recovery test mode: compact-retry.",
      "The first checker artifact must omit testResults evidence so Southstar can trigger retry-same-agent recovery. The recovered attempt must include complete commandsRun, testResults, and artifactEvidence.",
    ];
  }
  if (mode === "fork-from-checkpoint") {
    return [
      "Session recovery test mode: fork-from-checkpoint.",
      "The first implementation branch should intentionally miss due-date persistence so the checker rejects the product direction. The forked recovery branch must implement priority labels, due dates, overdue filtering, and persistence completely.",
    ];
  }
  if (mode === "rollback-workspace") {
    return [
      "Session recovery test mode: rollback-workspace.",
      "The first implementation branch should create a failing workspace mutation in src/todo-store.ts or src/app.ts so Southstar performs rollback preview/apply before a recovered attempt fixes the feature.",
    ];
  }
  return [];
}

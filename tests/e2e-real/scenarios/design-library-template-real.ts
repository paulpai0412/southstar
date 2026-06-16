import assert from "node:assert/strict";
import { createRunFromDraft } from "../../../src/v2/ui-api/local-api.ts";
import { validateWorkflowManifest } from "../../../src/v2/manifests/validate.ts";
import { seedSoftwareDevDesignLibrary } from "../../../src/v2/design-library/software-dev-seed.ts";
import { createWorkflowDesignDraftFromIssue } from "../../../src/v2/design-library/designer.ts";
import { applyWorkflowTemplatePatch } from "../../../src/v2/design-library/patch.ts";
import { approveDraftForRun, validateTemplateFromRun } from "../../../src/v2/design-library/lifecycle.ts";
import { compileTemplateVersionToManifest } from "../../../src/v2/design-library/compiler.ts";
import { matchValidatedTemplateForIssue } from "../../../src/v2/design-library/reuse.ts";
import { assertDesignLibraryQuantitativeGates, assertDesignLibraryRealE2EGates } from "../../../src/v2/quality/design-library-gates.ts";
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

export async function runDesignLibraryTemplateRealScenario(
  env: RealE2EEnv,
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
    const design = await createWorkflowDesignDraftFromIssue(context.db, {
      issue,
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
      issue,
      runInputs: {
        repoPath: repo,
        issueTitle: issue.title,
        issueBody: issue.body,
        acceptanceCriteria: issue.acceptanceCriteria,
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

    const reuse = matchValidatedTemplateForIssue(context.db, {
      issue: {
        ...issue,
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

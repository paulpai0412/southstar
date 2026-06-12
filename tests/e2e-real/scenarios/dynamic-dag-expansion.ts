import assert from "node:assert/strict";
import { expandWorkflowRun } from "../../../src/v2/ui-api/local-api.ts";
import { listHistoryForRun } from "../../../src/v2/stores/history-store.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import type { WorkflowRevisionRequest } from "../../../src/v2/manifests/types.ts";
import type { RealE2EEnv } from "../env.ts";
import { createScenarioContext, findImplementerTaskId, startCallbackServer, waitForTorkJob } from "./harness.ts";

export async function runDynamicDagExpansionScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  const callback = await startCallbackServer(env);
  try {
    const result = await expandWorkflowRun(context.db, {
      runId,
      request: revision(runId, findImplementerTaskId(context.db, runId)),
      torkClient: context.torkClient,
      runRoot: "/tmp/southstar-runs",
      callbackUrl: callback.url,
      harnessEndpoint: env.piHarnessEndpoint,
    });
    await waitForTorkJob(env.torkBaseUrl, result.tork.jobId);
    assert.equal(result.newTaskIds.length >= 1, true);
    assert.equal(listResources(context.db, { resourceType: "workflow_revision", status: "applied" }).length >= 1, true);
    const events = listHistoryForRun(context.db, runId).map((event) => event.eventType);
    for (const eventType of ["workflow.revision_requested", "workflow.revision_validated", "workflow.expanded", "task.created"]) {
      assert.equal(events.includes(eventType), true);
    }
    assert.equal(listResources(context.db, { resourceType: "executor_binding" }).some((resource) => {
      const payload = resource.payload as { revisionId?: string; torkJobId?: string };
      return payload.revisionId === "rev-real-follow-up-verification" && typeof payload.torkJobId === "string";
    }), true);
    console.log("dynamic DAG expansion scenario passed");
  } finally {
    await callback.close();
  }
}

function revision(runId: string, implementerTaskId: string): WorkflowRevisionRequest {
  return {
    revisionId: "rev-real-follow-up-verification",
    baseRevisionId: "base",
    runId,
    actorType: "root-session",
    reason: "review/root gate requires follow-up verification",
    addTasks: [{
      id: "task-follow-up-verification",
      name: "Follow-up verification",
      domain: "software",
      dependsOn: [implementerTaskId],
      execution: {
        engine: "tork",
        image: "southstar/codex-agent:local",
        command: ["southstar-agent-runner"],
        env: {},
        mounts: [],
        timeoutSeconds: 900,
        infraRetry: { maxAttempts: 1 },
      },
      rootSession: { validator: "schema-evaluator-v1", maxRepairAttempts: 2 },
      subagents: [{ id: "verify", harnessId: "codex", prompt: "verify implementation", requiredArtifacts: ["implementation-report"] }],
    }],
    removeTaskIds: [],
    dependencyChanges: [],
    idempotencyKey: "rev-real-follow-up-verification",
  };
}

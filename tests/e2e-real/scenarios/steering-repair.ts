import assert from "node:assert/strict";
import { createBuiltinAgentHarness } from "../../../src/v2/harness/builtin-agent-harness.ts";
import { runRootSessionTask } from "../../../src/v2/agent-runner/root-session.ts";
import { getTaskEnvelope, steerRun } from "../../../src/v2/ui-api/local-api.ts";
import { listHistoryForRun } from "../../../src/v2/stores/history-store.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import type { RealE2EEnv } from "../env.ts";
import { createScenarioContext, findImplementerTaskId } from "./harness.ts";

export async function runSteeringRepairScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  steerRun(context.db, { runId, message: "請保持最小改動，不要新增 runtime dependency。" });
  const envelope = getTaskEnvelope(context.db, { runId, taskId: findImplementerTaskId(context.db, runId) });
  const result = await runRootSessionTask(context.db, {
    envelope,
    requiredFields: ["summary", "commandsRun", "testResults", "risks", "steeringDecision"],
    harness: createBuiltinAgentHarness(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  const events = listHistoryForRun(context.db, runId).map((event) => event.eventType);
  assert.equal(events.includes("steering.received"), true);
  assert.equal(events.includes("repair.requested"), true);
  assert.equal(events.includes("evaluator.completed"), true);
  const taskId = envelope.schemaVersion === "southstar.task-envelope.v2" ? envelope.taskId : envelope.task.id;
  const acceptedArtifacts = listResources(context.db, { resourceType: "artifact", status: "accepted" })
    .filter((resource) => resource.runId === runId && resource.taskId === taskId)
    .map((resource) => resource.payload as Record<string, unknown>);
  assert.equal(acceptedArtifacts.some((artifact) => hasSteeringDecision(artifact)), true);
  console.log("steering repair scenario passed");
}

function hasSteeringDecision(artifact: Record<string, unknown>): boolean {
  const value = artifact.steeringDecision;
  return typeof value === "string" ? value.length > 0 : typeof value === "object" && value !== null;
}

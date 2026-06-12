import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { materializeTaskEnvelope } from "../../../src/v2/agent-runner/materializer.ts";
import { listResources } from "../../../src/v2/stores/resource-store.ts";
import { getTaskEnvelope } from "../../../src/v2/ui-api/local-api.ts";
import type { RealE2EEnv } from "../env.ts";
import { createScenarioContext, findImplementerTaskId } from "./harness.ts";

export async function runSkillSnapshotRealScenario(env: RealE2EEnv, runId: string): Promise<void> {
  const context = createScenarioContext(env);
  const snapshots = listResources(context.db, { resourceType: "skill_snapshot", status: "resolved" })
    .filter((resource) => resource.runId === runId);
  assert.equal(snapshots.length >= 1, true, "expected at least one real skill snapshot");
  const taskId = findImplementerTaskId(context.db, runId);
  const envelope = getTaskEnvelope(context.db, { runId, taskId });
  assert.equal(envelope.skills.length >= 1, true, "task envelope must include resolved skills");
  const materialized = await materializeTaskEnvelope(envelope, { runRoot: "/tmp/southstar-runs" });
  assert.equal(existsSync(join(materialized.taskDir, "skills")), true);
  console.log("phase15 skill snapshot scenario passed");
}

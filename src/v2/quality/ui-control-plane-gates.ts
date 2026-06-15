import type { SouthstarDb } from "../stores/sqlite.ts";
import { listResources } from "../stores/resource-store.ts";

export type UiControlPlaneGateInput = {
  runId: string;
  visitedPages?: string[];
};

export type UiControlPlaneGateResult = { ok: boolean; failures: string[] };

const requiredPages = ["planner", "workflow", "runtime", "task", "sessions", "worktree", "executor", "domain-packs", "governance"];

export function assertUiControlPlaneGates(db: SouthstarDb, input: UiControlPlaneGateInput): UiControlPlaneGateResult {
  const failures: string[] = [];
  const taskCount = count(db, "workflow_tasks", "run_id = ?", [input.runId]);
  const stop = listResources(db, { resourceType: "stop_condition_result" }).filter((resource) => resource.runId === input.runId).at(-1);
  if (stop?.status !== "passed") failures.push("stop_condition_result with status=passed is required before completion");
  const evaluatorResults = [
    ...listResources(db, { resourceType: "evaluator_result" }),
    ...listResources(db, { resourceType: "evaluator_pipeline_result" }),
  ].filter((resource) => resource.runId === input.runId);
  if (!evaluatorResults.some((resource) => resource.status === "passed" || (resource.payload as { ok?: boolean }).ok === true)) {
    failures.push("at least one evaluator result with ok=true or status=passed is required");
  }
  const artifacts = listResources(db, { resourceType: "artifact" }).filter((resource) => resource.runId === input.runId && resource.status === "accepted");
  const artifactText = JSON.stringify(artifacts.map((artifact) => artifact.payload));
  for (const [label, pattern] of [
    ["code patch", /codePatch|filesChanged|diff/i],
    ["test evidence", /testEvidence|testResults|commandsRun/i],
    ["README evidence", /readmeEvidence|README/i],
    ["evaluator report", /evaluatorReport|checkerFindings|evaluator/i],
  ] as const) {
    if (!pattern.test(artifactText)) failures.push(`accepted artifact missing ${label}`);
  }
  if (taskCount > 0) {
    const contextPackets = listResources(db, { resourceType: "context_packet" }).filter((resource) => resource.runId === input.runId).length;
    const memoryTraces = listResources(db, { resourceType: "memory_injection_trace" }).filter((resource) => resource.runId === input.runId);
    const taskEnvelopes = listResources(db, { resourceType: "task_envelope" }).filter((resource) => resource.runId === input.runId).length;
    if (contextPackets < taskCount) failures.push(`every executed task needs ContextPacket: ${contextPackets}/${taskCount}`);
    if (taskEnvelopes < taskCount) failures.push(`every executed task needs TaskEnvelopeV2 resource: ${taskEnvelopes}/${taskCount}`);
    if (memoryTraces.length < taskCount) failures.push(`every ContextPacket needs memory trace: ${memoryTraces.length}/${taskCount}`);
    for (const trace of memoryTraces) {
      const payload = trace.payload as { included?: unknown[]; excluded?: unknown[]; decisionReason?: string };
      const hasReasons = Boolean(payload.decisionReason) || (payload.included ?? []).length > 0 || (payload.excluded ?? []).length > 0;
      if (!hasReasons) failures.push(`memory trace ${trace.id} lacks selected/excluded reason`);
    }
  }
  if (listResources(db, { resourceType: "executor_binding" }).filter((resource) => resource.runId === input.runId).length < 1) failures.push("Tork executor binding evidence is required");
  const visited = new Set(input.visitedPages ?? []);
  for (const page of requiredPages) {
    if (!visited.has(page)) failures.push(`UI E2E did not visit ${page}`);
  }
  return { ok: failures.length === 0, failures };
}

function count(db: SouthstarDb, table: string, where: string, args: unknown[]): number {
  const row = db.prepare(`select count(*) as count from ${table} where ${where}`).get(...args) as { count: number };
  return row.count;
}

export function assertUiControlPlaneQuantitativeGates(db: SouthstarDb, input: UiControlPlaneGateInput): UiControlPlaneGateResult {
  return assertUiControlPlaneGates(db, input);
}

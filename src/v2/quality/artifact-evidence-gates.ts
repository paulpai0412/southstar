import type { SouthstarDb } from "../stores/sqlite.ts";

export type ArtifactEvidenceGateResult = {
  ok: boolean;
  failures: string[];
};

export function assertArtifactEvidenceGates(
  db: SouthstarDb,
  input: { runId: string; minCompletedTasks: number },
): ArtifactEvidenceGateResult {
  const failures: string[] = [];

  const completedTasks = count(db, "workflow_tasks", "run_id = ? and status = 'completed'", [input.runId]);
  if (completedTasks < input.minCompletedTasks) {
    failures.push(`completed task count ${completedTasks} below ${input.minCompletedTasks}`);
  }

  const acceptedArtifacts = count(
    db,
    "runtime_resources",
    "run_id = ? and resource_type = 'artifact' and status = 'accepted'",
    [input.runId],
  );
  if (acceptedArtifacts !== completedTasks) {
    failures.push(`accepted artifact count ${acceptedArtifacts} must equal completed task count ${completedTasks}`);
  }

  const completeEvidence = count(
    db,
    "runtime_resources",
    "run_id = ? and resource_type = 'evidence_packet' and status = 'complete'",
    [input.runId],
  );
  if (completeEvidence !== acceptedArtifacts) {
    failures.push(`complete evidence packet count ${completeEvidence} must equal accepted artifact count ${acceptedArtifacts}`);
  }

  const validatorRows = db.prepare(`
    select payload_json
    from runtime_resources
    where run_id = ? and resource_type = 'validator_result'
  `).all(input.runId) as Array<{ payload_json: string }>;
  const blockingFailed = validatorRows.filter((row) => {
    const payload = JSON.parse(row.payload_json) as { blocking?: boolean; verdict?: string };
    return payload.blocking === true && payload.verdict === "failed";
  }).length;
  if (blockingFailed !== 0) {
    failures.push(`blocking validator failure count must be 0, got ${blockingFailed}`);
  }

  const evidenceRows = db.prepare(`
    select payload_json
    from runtime_resources
    where run_id = ? and resource_type = 'evidence_packet'
  `).all(input.runId) as Array<{ payload_json: string }>;
  for (const row of evidenceRows) {
    const payload = JSON.parse(row.payload_json) as {
      completeness?: { requiredCount?: number; presentCount?: number; missingKinds?: string[] };
    };
    const completeness = payload.completeness;
    if (!completeness) {
      failures.push("evidence packet missing completeness");
      continue;
    }
    const present = completeness.presentCount ?? 0;
    const required = completeness.requiredCount ?? 0;
    const missing = completeness.missingKinds?.length ?? 0;
    if (present < required || missing > 0) {
      failures.push(`incomplete evidence packet ${row.payload_json}`);
    }
  }

  const oversized = db.prepare(`
    select resource_type, resource_key, length(payload_json) as size
    from runtime_resources
    where run_id = ?
      and resource_type in ('artifact', 'evidence_packet', 'validator_result')
      and length(payload_json) > 50000
  `).all(input.runId) as Array<{ resource_type: string; resource_key: string; size: number }>;
  if (oversized.length > 0) {
    failures.push(`oversized artifact/evidence/validator payloads: ${JSON.stringify(oversized)}`);
  }

  return { ok: failures.length === 0, failures };
}

type SqlValue = string | number | bigint | Buffer | null;

function count(db: SouthstarDb, table: string, where: string, args: SqlValue[] = []): number {
  const row = db.prepare(`select count(*) as count from ${table} where ${where}`).get(...args) as { count: number };
  return row.count;
}

import type { SouthstarDb } from "../stores/sqlite.ts";

export function assertDesignLibraryQuantitativeGates(
  db: SouthstarDb,
  input: { minApprovedVersions: number; minAgentSpecs: number },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  const approvedVersions = count(db, `
    select count(*) as count
    from library_history
    where event_type = 'version.created'
      and json_extract(payload_json, '$.status') = 'approved'
  `);
  if (approvedVersions < input.minApprovedVersions) {
    failures.push(`approved version.created count ${approvedVersions} below ${input.minApprovedVersions}`);
  }

  const agentSpecs = count(db, `
    select count(*) as count
    from library_objects
    where object_kind = 'agent_spec'
  `);
  if (agentSpecs < input.minAgentSpecs) {
    failures.push(`agent_spec object count ${agentSpecs} below ${input.minAgentSpecs}`);
  }

  const kinds = db.prepare(`
    select distinct json_extract(payload_json, '$.definitionKind') as kind
    from library_history
    where event_type = 'version.created'
  `).all() as Array<{ kind: string }>;
  if (new Set(kinds.map((entry) => entry.kind)).size < 7) {
    failures.push(`definition kind coverage below 7; got ${JSON.stringify(kinds.map((entry) => entry.kind))}`);
  }

  return { ok: failures.length === 0, failures };
}

export function assertDesignLibraryRealE2EGates(
  db: SouthstarDb,
  input: { runId: string; templateVersionId: string; maxPayloadBytes: number; minCompletedTasks: number },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];

  const completedTasks = count(db, `
    select count(*) as count
    from workflow_tasks
    where run_id = '${input.runId}' and status = 'completed'
  `);
  if (completedTasks < input.minCompletedTasks) {
    failures.push(`completed tasks ${completedTasks} below ${input.minCompletedTasks}`);
  }

  const executorBindings = count(db, `
    select count(*) as count
    from runtime_resources
    where run_id = '${input.runId}' and resource_type = 'executor_binding'
  `);
  if (executorBindings < completedTasks) {
    failures.push(`executor binding count ${executorBindings} below completed task count ${completedTasks}`);
  }

  const acceptedArtifacts = count(db, `
    select count(*) as count
    from runtime_resources
    where run_id = '${input.runId}' and resource_type = 'artifact' and status = 'accepted'
  `);
  if (acceptedArtifacts !== completedTasks) {
    failures.push(`accepted artifacts ${acceptedArtifacts} must equal completed tasks ${completedTasks}`);
  }

  const completeEvidence = count(db, `
    select count(*) as count
    from runtime_resources
    where run_id = '${input.runId}' and resource_type = 'evidence_packet' and status = 'complete'
  `);
  if (completeEvidence !== acceptedArtifacts) {
    failures.push(`complete evidence ${completeEvidence} must equal accepted artifacts ${acceptedArtifacts}`);
  }

  const blockingFailures = count(db, `
    select count(*) as count
    from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'validator_result'
      and json_extract(payload_json, '$.blocking') = 1
      and json_extract(payload_json, '$.verdict') = 'failed'
  `);
  if (blockingFailures !== 0) {
    failures.push(`blocking validator failures must be 0, got ${blockingFailures}`);
  }

  const oversizedPayloads = count(db, `
    select count(*) as count
    from runtime_resources
    where run_id = '${input.runId}'
      and resource_type in ('artifact', 'evidence_packet', 'validator_result')
      and length(payload_json) > ${input.maxPayloadBytes}
  `);
  if (oversizedPayloads !== 0) {
    failures.push(`oversized payload rows must be 0, got ${oversizedPayloads}`);
  }

  const stopPassed = count(db, `
    select count(*) as count
    from runtime_resources
    where run_id = '${input.runId}'
      and resource_type = 'stop_condition_result'
      and status = 'passed'
  `);
  if (stopPassed < 1) {
    failures.push("missing passed stop_condition_result");
  }

  const validatedFromRunEvents = count(db, `
    select count(*) as count
    from library_history
    where event_type = 'template.validated_from_run'
      and json_extract(payload_json, '$.runId') = '${input.runId}'
  `);
  if (validatedFromRunEvents < 1) {
    failures.push("missing template.validated_from_run event for run");
  }

  return { ok: failures.length === 0, failures };
}

function count(db: SouthstarDb, query: string): number {
  return Number((db.prepare(query).get() as { count: number }).count);
}

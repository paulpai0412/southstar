import type { SouthstarDb } from "../db/postgres.ts";
import { buildEvidencePacket } from "../artifacts/evidence.ts";
import type { EvidenceKind, EvidencePacket, ValidatorResult } from "../artifacts/types.ts";
import { evidenceValidatorResult } from "../artifacts/validator-results.ts";
import type { GoalRequirementCoverageV1 } from "../orchestration/goal-requirement-coverage.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type RequirementEvaluatorResultV1 = {
  schemaVersion: "southstar.requirement_evaluator_result.v1";
  requirementIds: string[];
  artifactRefs: string[];
  evaluatorId: string;
  evaluatorTaskId: string;
  evaluatorProfileRef: string;
  verdict: "passed" | "failed" | "blocked";
  evidenceRefs: string[];
  findings: string[];
};

export type RequirementEvaluationWriteResult = {
  ok: boolean;
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  findings: string[];
};

type CoverageEntry = GoalRequirementCoverageV1["entries"][number];

export async function recordRequirementEvaluatorResultsPg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    artifactRefId: string;
    artifact: unknown;
    callbackOk: boolean;
    now?: string;
  },
): Promise<RequirementEvaluationWriteResult> {
  const coverageResource = await getResourceByKeyPg(db, "goal_requirement_coverage", input.runId);
  if (!coverageResource) {
    const run = await db.one<{ runtime_context_json: unknown }>(
      "select runtime_context_json from southstar.workflow_runs where id = $1",
      [input.runId],
    );
    if (typeof asRecord(run.runtime_context_json).goalContractHash === "string") {
      throw new Error(`Goal Contract run ${input.runId} is missing frozen requirement coverage`);
    }
    return { ok: true, evidenceRefs: [], evaluatorResultRefs: [], findings: [] };
  }

  if (coverageResource.runId !== input.runId || coverageResource.status !== "frozen") {
    throw new Error(`invalid Goal Requirement Coverage for run ${input.runId}: resource must be run-scoped and frozen`);
  }
  const coverage = parseCoverage(coverageResource.payload, input.runId);
  const entries = coverage.entries.filter((entry) => entry.evaluatorTaskIds.includes(input.taskId));
  if (entries.length === 0) return { ok: true, evidenceRefs: [], evaluatorResultRefs: [], findings: [] };

  const evidenceRefs: string[] = [];
  const evaluatorResultRefs: string[] = [];
  const findings: string[] = [];
  let ok = true;

  for (const entry of entries) {
    const evaluation = await evaluateEntry(db, input, entry);
    await persistEvidencePacket(db, evaluation.evidence);
    await persistValidatorResult(db, evaluation.validator);
    await persistRequirementResult(db, input, evaluation.result, evaluation.resourceKey);

    evidenceRefs.push(evaluation.evidence.id);
    evaluatorResultRefs.push(evaluation.validator.id, evaluation.resourceKey);
    findings.push(...evaluation.result.findings);
    if (evaluation.result.verdict !== "passed") ok = false;
  }

  return {
    ok,
    evidenceRefs: uniqueSorted(evidenceRefs),
    evaluatorResultRefs: uniqueSorted(evaluatorResultRefs),
    findings: uniqueSorted(findings),
  };
}

async function evaluateEntry(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    artifactRefId: string;
    artifact: unknown;
    callbackOk: boolean;
    now?: string;
  },
  entry: CoverageEntry,
): Promise<{
  evidence: EvidencePacket;
  validator: ValidatorResult;
  result: RequirementEvaluatorResultV1;
  resourceKey: string;
}> {
  const evaluatorProfileRef = await evaluatorProfileRefPg(db, input.runId, entry, input.taskId);
  const evaluatorIsIndependent = !entry.producerTaskIds.includes(input.taskId);
  const acceptedProducerRefs = evaluatorIsIndependent
    ? await acceptedProducerArtifactRefsPg(db, input.runId, entry)
    : [];
  const claimedRefs = claimedArtifactRefs(input.artifact);
  const artifactRefs = acceptedProducerRefs.filter((ref) => claimedRefs.has(ref));
  const evidence = buildEvidencePacket({
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRefId,
    requiredEvidenceKinds: entry.requiredEvidenceKinds,
    artifact: { ...asRecord(input.artifact), acceptedArtifacts: artifactRefs },
    identityScope: entry.requirementId,
    now: input.now,
  });
  const contractRef = `requirement:${input.runId}:${entry.requirementId}`;
  const validator = evidenceValidatorResult({
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRefId,
    contractRef,
    evidence,
    now: input.now,
  });
  const invalidEvidence = evidence.evidenceItems.some((item) => item.status === "invalid" || item.status === "stale");
  const blockedFindings = [
    ...(!evaluatorIsIndependent ? [`evaluator task ${input.taskId} is also a producer`] : []),
    ...(acceptedProducerRefs.length === 0 ? [`no accepted producer artifact for requirement ${entry.requirementId}`] : []),
    ...(acceptedProducerRefs.length > 0 && artifactRefs.length === 0
      ? [`evaluator did not reference an accepted producer artifact for requirement ${entry.requirementId}`]
      : []),
    ...evidence.completeness.missingKinds.map((kind) => `missing required ${kind} evidence`),
  ];
  const failedFindings = [
    ...(!input.callbackOk ? [`evaluator callback failed requirement ${entry.requirementId}`] : []),
    ...(invalidEvidence ? validator.messages.map((message) => message.text) : []),
  ];
  const verdict = !input.callbackOk
    ? "failed"
    : blockedFindings.length > 0
      ? "blocked"
      : invalidEvidence || validator.verdict !== "passed"
      ? "failed"
      : "passed";
  const resourceKey = `${contractRef}:${input.taskId}`;
  return {
    evidence,
    validator,
    resourceKey,
    result: {
      schemaVersion: "southstar.requirement_evaluator_result.v1",
      requirementIds: [entry.requirementId],
      artifactRefs,
      evaluatorId: resourceKey,
      evaluatorTaskId: input.taskId,
      evaluatorProfileRef,
      verdict,
      evidenceRefs: [evidence.id],
      findings: uniqueSorted([...blockedFindings, ...failedFindings]),
    },
  };
}

async function acceptedProducerArtifactRefsPg(
  db: SouthstarDb,
  runId: string,
  entry: CoverageEntry,
): Promise<string[]> {
  if (entry.producerTaskIds.length === 0 || entry.artifactRefs.length === 0) return [];
  const rows = await db.query<{ resource_key: string; artifact_type: string | null }>(
    `select resource_key, payload_json ->> 'artifactType' as artifact_type
       from southstar.runtime_resources
      where run_id = $1
        and task_id = any($2::text[])
        and resource_type = 'artifact_ref'
        and status = 'accepted'
      order by resource_key`,
    [runId, entry.producerTaskIds],
  );
  const requiredArtifactTypes = new Set(entry.artifactRefs.map((ref) => ref.replace(/^artifact\./, "")));
  return rows.rows
    .filter((row) => row.artifact_type !== null && requiredArtifactTypes.has(row.artifact_type.replace(/^artifact\./, "")))
    .map((row) => row.resource_key);
}

function claimedArtifactRefs(artifact: unknown): Set<string> {
  const payload = asRecord(artifact);
  return new Set([
    ...stringArray(payload.verifiedArtifactRefs),
    ...stringArray(payload.acceptedArtifacts),
    ...stringArray(payload.artifactRefs),
  ]);
}

async function persistEvidencePacket(db: SouthstarDb, evidence: EvidencePacket): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: evidence.id,
    resourceType: "evidence_packet",
    resourceKey: evidence.id,
    runId: evidence.runId,
    taskId: evidence.taskId,
    scope: "evaluator",
    status: evidence.completeness.missingKinds.length === 0 ? "complete" : "incomplete",
    title: `Evidence ${evidence.taskId}`,
    payload: evidence,
    summary: evidence.completeness,
  });
}

async function persistValidatorResult(db: SouthstarDb, validator: ValidatorResult): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: validator.id,
    resourceType: "validator_result",
    resourceKey: validator.id,
    runId: validator.runId,
    taskId: validator.taskId,
    scope: "evaluator",
    status: validator.verdict,
    title: `Validator ${validator.validatorRef}`,
    payload: validator,
    summary: { blocking: validator.blocking, messageCount: validator.messages.length },
  });
}

async function persistRequirementResult(
  db: SouthstarDb,
  input: { runId: string; taskId: string },
  result: RequirementEvaluatorResultV1,
  resourceKey: string,
): Promise<void> {
  await upsertRuntimeResourcePg(db, {
    id: resourceKey,
    resourceType: "requirement_evaluator_result",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    scope: "evaluator",
    status: result.verdict,
    title: `Requirement evaluator ${result.requirementIds.join(", ")}`,
    payload: result,
    summary: { requirementIds: result.requirementIds, findingCount: result.findings.length },
  });
}

function parseCoverage(value: unknown, runId: string): GoalRequirementCoverageV1 {
  const coverage = asRecord(value);
  const fail = (path: string): never => {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: ${path}`);
  };
  if (coverage.schemaVersion !== "southstar.goal_requirement_coverage.v1") fail("schemaVersion");
  if (typeof coverage.goalContractHash !== "string" || coverage.goalContractHash.length === 0) fail("goalContractHash");
  if (!Array.isArray(coverage.entries)) fail("entries");
  const evidenceKinds = new Set<EvidenceKind>([
    "file-diff",
    "test-result",
    "command-output",
    "url",
    "screenshot",
    "human-approval",
    "artifact-ref",
    "workspace-snapshot",
    "policy-decision",
  ]);
  for (const [index, rawEntry] of coverage.entries.entries()) {
    const entry = asRecord(rawEntry);
    const path = `entries[${index}]`;
    if (typeof entry.requirementId !== "string" || entry.requirementId.length === 0) fail(`${path}.requirementId`);
    for (const key of ["producerTaskIds", "artifactRefs", "evaluatorTaskIds", "evaluatorProfileRefs"] as const) {
      const values = entry[key];
      if (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== "string" || item.length === 0)) {
        fail(`${path}.${key}`);
      }
    }
    if (
      !Array.isArray(entry.requiredEvidenceKinds)
      || entry.requiredEvidenceKinds.length === 0
      || entry.requiredEvidenceKinds.some((kind) => typeof kind !== "string" || !evidenceKinds.has(kind as EvidenceKind))
    ) {
      fail(`${path}.requiredEvidenceKinds`);
    }
  }
  return value as GoalRequirementCoverageV1;
}

async function evaluatorProfileRefPg(
  db: SouthstarDb,
  runId: string,
  entry: CoverageEntry,
  taskId: string,
): Promise<string> {
  const profiles = uniqueSorted(entry.evaluatorProfileRefs);
  const run = await db.one<{ workflow_manifest_json: unknown }>(
    "select workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const tasks = asRecord(run.workflow_manifest_json).tasks;
  const task = Array.isArray(tasks)
    ? tasks.map(asRecord).find((candidate) => candidate.id === taskId)
    : undefined;
  const manifestRef = typeof task?.evaluatorPipelineRef === "string" ? task.evaluatorPipelineRef : undefined;
  const matched = manifestRef
    ? profiles.find((profile) => profile.replace(/^evaluator\./, "") === manifestRef.replace(/^evaluator\./, ""))
    : undefined;
  if (matched) return matched;
  if (manifestRef) {
    throw new Error(`evaluator profile ${manifestRef} does not match frozen coverage for task ${taskId}`);
  }
  if (profiles.length !== 1) {
    throw new Error(`requirement ${entry.requirementId} has no unambiguous evaluator profile for task ${taskId}`);
  }
  return profiles[0]!;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

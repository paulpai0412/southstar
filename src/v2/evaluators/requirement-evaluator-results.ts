import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import sharp from "sharp";
import { CANONICAL_DIAGNOSTIC_CODES, canonicalDiagnostic, type CanonicalDiagnostic } from "../canonical-diagnostics.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import {
  artifactEvidenceClaims,
  buildEvidencePacket,
  screenshotEvidenceRef,
} from "../artifacts/evidence.ts";
import type { EvidenceKind, EvidencePacket, ValidatorResult } from "../artifacts/types.ts";
import { evidenceValidatorResult } from "../artifacts/validator-results.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { recordRuntimeExceptionInTxPg } from "../exceptions/postgres-runtime-exceptions.ts";
import {
  goalContractHash,
  storedGoalContract,
  type GoalContractV1,
} from "../orchestration/goal-contract.ts";
import { goalDesignPackageV2FromUnknown } from "../orchestration/goal-design.ts";
import {
  storedGoalRequirementCoverage,
  type GoalRequirementCoverageV1,
} from "../orchestration/goal-requirement-coverage.ts";
import { getResourceByKeyPg, upsertRuntimeResourcePg } from "../stores/postgres-runtime-store.ts";

export type RequirementCriterionEvaluatorResultV2 = {
  criterionId: string;
  verdict: "passed" | "failed" | "blocked";
  evidenceRefs: string[];
  findings: string[];
};

export type RequirementEvaluatorResultV2 = {
  schemaVersion: "southstar.requirement_evaluator_result.v2";
  requirementId: string;
  validationBindingId: string;
  artifactRefs: string[];
  evaluatorId: string;
  evaluatorTaskId: string;
  evaluatorProfileRef: string;
  evaluatorProfileVersionRef: string;
  verdict: "passed" | "failed" | "blocked";
  criteriaResults: RequirementCriterionEvaluatorResultV2[];
  evidenceRefs: string[];
  findings: string[];
};

export type RequirementEvaluatorResult = RequirementEvaluatorResultV2;

export const REQUIREMENT_EVALUATOR_RESULT_SCHEMA_VERSION = "southstar.requirement_evaluator_result.v2" as const;

export function requirementEvaluatorResultIncompatibility(input: {
  resourceKey: string;
  payload: unknown;
}): CanonicalDiagnostic | undefined {
  const schemaVersion = nonEmptyString(asRecord(input.payload).schemaVersion) ?? "<missing>";
  return schemaVersion === REQUIREMENT_EVALUATOR_RESULT_SCHEMA_VERSION
    ? undefined
    : canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.requirementEvaluatorResultIncompatible,
      `requirement evaluator result ${input.resourceKey} uses ${schemaVersion}; expected ${REQUIREMENT_EVALUATOR_RESULT_SCHEMA_VERSION}`,
    );
}

export type RequirementEvaluationWriteResult = {
  ok: boolean;
  failedBlockingRequirementIds: string[];
  evidenceRefs: string[];
  evaluatorResultRefs: string[];
  findings: string[];
};

type CoverageEntry = GoalRequirementCoverageV1["entries"][number];
export type FrozenCoverageContext = {
  coverage: GoalRequirementCoverageV1;
  manifest: SouthstarWorkflowManifest;
  goalContract: GoalContractV1;
  blockingRequirementIds: Set<string>;
  workspaceRoot?: string;
};

type EvaluatorCallbackIdentity = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  attemptId?: string;
  handExecutionId: string;
};

const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 100_000;
const MAX_IMAGE_PIXELS = 25_000_000;

export type WorkspaceScreenshotProof = {
  ref: string;
  workspaceRoot: string;
  canonicalWorkspaceRoot: string;
  sha256: string;
  sizeBytes: number;
  format: "png" | "jpeg" | "webp";
  width: number;
  height: number;
};

export async function assertRequirementEvaluatorExecutionIdentityPg(
  db: SouthstarDb,
  input: EvaluatorCallbackIdentity,
): Promise<void> {
  const context = await loadFrozenCoverageContextPg(db, input.runId);
  if (!context) {
    const diagnostic = await frozenCoverageUnavailableDiagnosticPg(db, input.runId);
    if (diagnostic) await persistFrozenCoverageDiagnosticPg(db, input, diagnostic);
    return;
  }
  const entries = context.coverage.entries.filter((entry) => entry.evaluatorTaskIds.includes(input.taskId));
  if (entries.length === 0) return;
  await assertExecutionIdentityPg(db, input, context, entries);
}

export async function recordRequirementEvaluatorResultsPg(
  db: SouthstarDb,
  input: {
    runId: string;
    taskId: string;
    artifactRefId: string;
    artifact: unknown;
    callbackOk: boolean;
    rootSessionId: string;
    attemptId?: string;
    handExecutionId: string;
    screenshotProof?: WorkspaceScreenshotProof;
    now?: string;
  },
): Promise<RequirementEvaluationWriteResult> {
  const context = await loadFrozenCoverageContextPg(db, input.runId);
  if (!context) {
    const diagnostic = await frozenCoverageUnavailableDiagnosticPg(db, input.runId);
    if (!diagnostic) return { ok: true, failedBlockingRequirementIds: [], evidenceRefs: [], evaluatorResultRefs: [], findings: [] };
    await persistFrozenCoverageDiagnosticPg(db, input, diagnostic);
    return {
      ok: false,
      failedBlockingRequirementIds: [],
      evidenceRefs: [],
      evaluatorResultRefs: [],
      findings: [diagnostic.message],
    };
  }
  const entries = context.coverage.entries.filter((entry) => entry.evaluatorTaskIds.includes(input.taskId));
  if (entries.length === 0) return { ok: true, failedBlockingRequirementIds: [], evidenceRefs: [], evaluatorResultRefs: [], findings: [] };
  await assertExecutionIdentityPg(db, input, context, entries);
  const evaluatorCriterionIds = new Set(entries.flatMap((entry) => entry.criterionIds));

  const evidenceRefs: string[] = [];
  const evaluatorResultRefs: string[] = [];
  const findings: string[] = [];
  let ok = true;
  const failedBlockingRequirementIds: string[] = [];

  for (const entry of entries) {
    if (entry.criterionIds.length === 0) {
      const diagnostic = canonicalDiagnostic(
        CANONICAL_DIAGNOSTIC_CODES.criterionCoverageRequired,
        `requirement ${entry.requirementId} has no frozen criterion coverage`,
      );
      const exception = await recordRuntimeExceptionInTxPg(db, {
        runId: input.runId,
        taskId: input.taskId,
        sessionId: input.rootSessionId,
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        handExecutionId: input.handExecutionId,
        source: "artifact-gate",
        kind: "validation_failed",
        severity: "blocking",
        status: "blocked",
        observedAt: input.now ?? new Date().toISOString(),
        evidenceRefs: [`goal_requirement_coverage:${input.runId}`],
        providerEvidence: {
          code: diagnostic.code,
          message: diagnostic.message,
          requirementId: entry.requirementId,
          expectedSchemaVersion: REQUIREMENT_EVALUATOR_RESULT_SCHEMA_VERSION,
        },
      });
      evaluatorResultRefs.push(exception.resourceKey);
      findings.push(diagnostic.message);
      if (context.blockingRequirementIds.has(entry.requirementId)) {
        ok = false;
        failedBlockingRequirementIds.push(entry.requirementId);
      }
      continue;
    }
    const evaluation = await evaluateEntry(db, input, entry, context.manifest, context.workspaceRoot, evaluatorCriterionIds);
    await persistEvidencePacket(db, evaluation.evidence);
    await persistValidatorResult(db, evaluation.validator);
    await persistRequirementResult(db, input, evaluation.result, evaluation.resourceKey);

    evidenceRefs.push(evaluation.evidence.id);
    evaluatorResultRefs.push(evaluation.validator.id, evaluation.resourceKey);
    findings.push(...evaluation.result.findings);
    if (
      context.blockingRequirementIds.has(entry.requirementId)
      && evaluation.result.verdict !== "passed"
    ) {
      ok = false;
      failedBlockingRequirementIds.push(entry.requirementId);
    }
  }

  return {
    ok,
    failedBlockingRequirementIds: uniqueSorted(failedBlockingRequirementIds),
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
    rootSessionId: string;
    attemptId?: string;
    handExecutionId: string;
    screenshotProof?: WorkspaceScreenshotProof;
    now?: string;
  },
  entry: CoverageEntry,
  manifest: SouthstarWorkflowManifest,
  workspaceRoot: string | undefined,
  evaluatorCriterionIds: ReadonlySet<string>,
): Promise<{
  evidence: EvidencePacket;
  validator: ValidatorResult;
  result: RequirementEvaluatorResult;
  resourceKey: string;
}> {
  const evaluatorProfileRef = resolveEvaluatorProfileRef(manifest, entry, input.taskId);
  const evaluatorIsIndependent = !entry.producerTaskIds.includes(input.taskId);
  const acceptedProducerRefs = evaluatorIsIndependent
    ? await acceptedProducerArtifactRefsPg(db, input.runId, entry, manifest)
    : [];
  const claimedRefs = claimedArtifactRefs(input.artifact);
  const artifactRefs = acceptedProducerRefs.filter((ref) => claimedRefs.has(ref));
  const artifact = { ...asRecord(input.artifact), acceptedArtifacts: artifactRefs };
  const evidence = buildEvidencePacket({
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRefId,
    requiredEvidenceKinds: entry.requiredEvidenceKinds,
    artifact,
    identityScope: entry.requirementId,
    now: input.now,
  });
  await verifyScreenshotEvidenceProvenancePg(db, input.runId, workspaceRoot, artifact, evidence, input.screenshotProof);
  const contractRef = `requirement:${input.runId}:${entry.requirementId}`;
  const validator = evidenceValidatorResult({
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRefId,
    contractRef,
    evidence,
    now: input.now,
  });
  const blockedFindings = [
    ...(!evaluatorIsIndependent ? [`evaluator task ${input.taskId} is also a producer`] : []),
    ...(acceptedProducerRefs.length === 0 ? [`no accepted producer artifact for requirement ${entry.requirementId}`] : []),
    ...(acceptedProducerRefs.length > 0 && artifactRefs.length === 0
      ? [`evaluator did not reference an accepted producer artifact for requirement ${entry.requirementId}`]
      : []),
    ...evidence.completeness.missingKinds.map((kind) => `missing required ${kind} evidence`),
  ];
  const resourceKey = `${contractRef}:${input.taskId}:${input.artifactRefId}`;
  const result = evaluateCriterionResult({
    entry,
    manifest,
    taskId: input.taskId,
    artifact,
    artifactRefs,
    callbackOk: input.callbackOk,
    evaluatorProfileRef,
    evaluatorId: resourceKey,
    evidence,
    hostFindings: blockedFindings,
    evaluatorCriterionIds,
  });
  return {
    evidence,
    validator,
    resourceKey,
    result,
  };
}

function evaluateCriterionResult(input: {
  entry: CoverageEntry;
  manifest: SouthstarWorkflowManifest;
  taskId: string;
  artifact: Record<string, unknown>;
  artifactRefs: string[];
  callbackOk: boolean;
  evaluatorProfileRef: string;
  evaluatorId: string;
  evidence: EvidencePacket;
  hostFindings: string[];
  evaluatorCriterionIds: ReadonlySet<string>;
}): RequirementEvaluatorResultV2 {
  const rawResults = Array.isArray(input.artifact.criteriaResults)
    ? input.artifact.criteriaResults.map(asRecord)
    : [];
  const rawByCriterion = new Map<string, Record<string, unknown>[]>();
  const unknownCriterionIds: string[] = [];
  const expectedCriterionIds = new Set(input.entry.criterionIds);
  for (const raw of rawResults) {
    const criterionId = nonEmptyString(raw.criterionId);
    if (!criterionId || !input.evaluatorCriterionIds.has(criterionId)) {
      unknownCriterionIds.push(criterionId ?? "<missing>");
      continue;
    }
    if (!expectedCriterionIds.has(criterionId)) continue;
    const values = rawByCriterion.get(criterionId) ?? [];
    values.push(raw);
    rawByCriterion.set(criterionId, values);
  }
  const claims = artifactEvidenceClaims(input.artifact, input.evidence.runId);
  const claimKindsByRef = new Map<string, Set<EvidenceKind>>();
  for (const claim of claims) {
    const kinds = claimKindsByRef.get(claim.ref) ?? new Set<EvidenceKind>();
    kinds.add(claim.kind);
    claimKindsByRef.set(claim.ref, kinds);
  }
  const evidenceStatusByKind = new Map(input.evidence.evidenceItems.map((item) => [item.kind, item.status]));
  const globalFindings = [
    ...input.hostFindings,
    ...(!input.callbackOk ? [`evaluator callback failed requirement ${input.entry.requirementId}`] : []),
    ...unknownCriterionIds.map((criterionId) => `unknown criterion result ${criterionId}`),
  ];
  const criteriaResults = input.entry.criterionIds.map((criterionId): RequirementCriterionEvaluatorResultV2 => {
    const candidates = rawByCriterion.get(criterionId) ?? [];
    const raw = candidates[0];
    const findings = [
      ...(candidates.length === 0 ? [`missing criterion result ${criterionId}`] : []),
      ...(candidates.length > 1 ? [`duplicate criterion result ${criterionId}`] : []),
    ];
    const claimedVerdict = raw ? criterionVerdict(raw.verdict) : undefined;
    if (raw && !claimedVerdict) findings.push(`invalid criterion verdict ${criterionId}`);
    const evidenceRefs = raw ? uniqueSorted(stringArray(raw.evidenceRefs)) : [];
    const workerFindings = raw && Array.isArray(raw.findings) && raw.findings.every((item) => typeof item === "string")
      ? raw.findings as string[]
      : [];
    if (raw && (!Array.isArray(raw.evidenceRefs) || evidenceRefs.length === 0)) {
      findings.push(`missing criterion evidence refs ${criterionId}`);
    }
    const expectedKinds = expectedEvidenceKindsForCriterion(input.manifest, input.entry, criterionId);
    const referencedKinds = new Set<EvidenceKind>();
    for (const evidenceRef of evidenceRefs) {
      const kinds = claimKindsByRef.get(evidenceRef);
      if (!kinds || kinds.size === 0) {
        findings.push(`unknown evidence ref ${evidenceRef} for criterion ${criterionId}`);
        continue;
      }
      for (const kind of kinds) referencedKinds.add(kind);
    }
    let invalidEvidence = false;
    for (const kind of expectedKinds) {
      if (!referencedKinds.has(kind)) {
        findings.push(`missing ${kind} evidence for criterion ${criterionId}`);
        continue;
      }
      const status = evidenceStatusByKind.get(kind);
      if (status !== "present") {
        findings.push(`${kind} evidence is ${status ?? "missing"} for criterion ${criterionId}`);
        if (status === "invalid" || status === "stale") invalidEvidence = true;
      }
    }
    const verdict = !input.callbackOk
      ? "failed"
      : claimedVerdict === "failed" || invalidEvidence
        ? "failed"
        : claimedVerdict !== "passed" || findings.length > 0 || globalFindings.length > 0
          ? "blocked"
          : "passed";
    return {
      criterionId,
      verdict,
      evidenceRefs,
      findings: uniqueSorted([...workerFindings, ...findings]),
    };
  });
  const verdict = !input.callbackOk || criteriaResults.some((result) => result.verdict === "failed")
    ? "failed"
    : criteriaResults.some((result) => result.verdict === "blocked") || globalFindings.length > 0
      ? "blocked"
      : "passed";
  const evaluatorProfileVersionRef = requiredSingle(
    input.entry.evaluatorProfileVersionRefs,
    `requirement ${input.entry.requirementId} evaluator profile version`,
  );
  const validationBindingId = nonEmptyString(input.entry.validationBindingId);
  if (!validationBindingId) throw new Error(`requirement ${input.entry.requirementId} validation binding is missing`);
  return {
    schemaVersion: "southstar.requirement_evaluator_result.v2",
    requirementId: input.entry.requirementId,
    validationBindingId,
    artifactRefs: input.artifactRefs,
    evaluatorId: input.evaluatorId,
    evaluatorTaskId: input.taskId,
    evaluatorProfileRef: input.evaluatorProfileRef,
    evaluatorProfileVersionRef,
    verdict,
    criteriaResults,
    evidenceRefs: [input.evidence.id],
    findings: uniqueSorted([
      ...globalFindings,
      ...criteriaResults.flatMap((result) => result.findings),
    ]),
  };
}

function expectedEvidenceKindsForCriterion(
  manifest: SouthstarWorkflowManifest,
  entry: CoverageEntry,
  criterionId: string,
): EvidenceKind[] {
  const profileRef = requiredSingle(entry.evaluatorProfileRefs, `requirement ${entry.requirementId} evaluator profile`);
  const versionRef = requiredSingle(entry.evaluatorProfileVersionRefs, `requirement ${entry.requirementId} evaluator profile version`);
  const pipeline = (manifest.evaluatorPipelines ?? []).find((candidate) =>
    normalizeRequirementEvidenceRef(candidate.libraryObjectRef ?? candidate.id, "evaluator")
      === normalizeRequirementEvidenceRef(profileRef, "evaluator")
      && candidate.libraryVersionRef === versionRef
  );
  if (!pipeline) throw new Error(`manifest is missing frozen evaluator pipeline ${profileRef}@${versionRef}`);
  const step = pipeline.evaluators.find((candidate) => asRecord(candidate.config).criterionId === criterionId);
  if (!step) throw new Error(`manifest evaluator pipeline is missing criterion ${criterionId}`);
  const kinds = stringArray(asRecord(step.config).expectedEvidenceKinds);
  if (kinds.length === 0 || kinds.some((kind) => !isEvidenceKind(kind))) {
    throw new Error(`manifest evaluator criterion ${criterionId} has invalid expected evidence kinds`);
  }
  return kinds as EvidenceKind[];
}

function criterionVerdict(value: unknown): RequirementCriterionEvaluatorResultV2["verdict"] | undefined {
  return value === "passed" || value === "failed" || value === "blocked" ? value : undefined;
}

function requiredSingle(values: string[], label: string): string {
  if (values.length !== 1 || !nonEmptyString(values[0])) throw new Error(`${label} must contain exactly one value`);
  return values[0]!;
}

export async function acceptedProducerArtifactRefsPg(
  db: SouthstarDb,
  runId: string,
  entry: CoverageEntry,
  manifest: SouthstarWorkflowManifest,
): Promise<string[]> {
  if (entry.producerTaskIds.length === 0 || entry.artifactRefs.length === 0) return [];
  const rows = await db.query<{ resource_key: string; task_id: string; payload_json: unknown }>(
    `select resource_key, task_id, payload_json
       from southstar.runtime_resources
      where run_id = $1
        and task_id = any($2::text[])
        and resource_type = 'artifact_ref'
        and status = 'accepted'
      order by resource_key`,
    [runId, entry.producerTaskIds],
  );
  const aliases = artifactContractAliases(manifest);
  const requiredContracts = new Set(entry.artifactRefs.map((ref) => canonicalContractRef(ref, aliases)));
  return rows.rows
    .filter((row) => {
      const payload = asRecord(row.payload_json);
      if (
        payload.runId !== runId
        || payload.taskId !== row.task_id
        || payload.artifactRefId !== row.resource_key
        || payload.status !== "accepted"
      ) return false;
      return stringArray(payload.contractRefs)
        .map((ref) => canonicalContractRef(ref, aliases))
        .some((ref) => requiredContracts.has(ref));
    })
    .map((row) => row.resource_key);
}

async function verifyScreenshotEvidenceProvenancePg(
  db: SouthstarDb,
  runId: string,
  workspaceRoot: string | undefined,
  artifact: Record<string, unknown>,
  evidence: EvidencePacket,
  screenshotProof: WorkspaceScreenshotProof | undefined,
): Promise<void> {
  const index = evidence.evidenceItems.findIndex((item) => item.kind === "screenshot" && item.status === "present");
  if (index < 0) return;
  const ref = screenshotEvidenceRef(artifact, runId);
  const sha256 = ref?.startsWith("artifact_ref:")
    ? await acceptedArtifactBlobHashPg(db, runId, ref)
    : ref && !/^https?:/i.test(ref)
      ? screenshotProof?.ref === ref && screenshotProof.workspaceRoot === workspaceRoot
        ? screenshotProof.sha256
        : undefined
      : undefined;
  evidence.evidenceItems[index] = sha256
    ? { ...evidence.evidenceItems[index]!, sha256 }
    : {
      kind: "screenshot",
      status: "invalid",
      summary: "screenshot evidence has no verifiable run artifact or workspace file",
      capturedAt: evidence.evidenceItems[index]!.capturedAt,
      redactionApplied: true,
    };
  evidence.completeness.presentCount = evidence.evidenceItems.filter((item) => item.status === "present").length;
}

async function acceptedArtifactBlobHashPg(db: SouthstarDb, runId: string, artifactRefId: string): Promise<string | undefined> {
  const resource = await db.maybeOne<{ status: string; payload_json: unknown }>(
    `select status, payload_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'artifact_ref' and resource_key = $2`,
    [runId, artifactRefId],
  );
  const payload = asRecord(resource?.payload_json);
  const contentRef = asRecord(payload.contentRef);
  const imageContract = [payload.artifactType, ...stringArray(payload.contractRefs)]
    .some((value) => typeof value === "string" && /(screenshot|image)/i.test(value));
  if (
    resource?.status !== "accepted"
    || payload.status !== "accepted"
    || payload.runId !== runId
    || payload.artifactRefId !== artifactRefId
    || contentRef.kind !== "artifact_blob"
    || typeof contentRef.ref !== "string"
    || typeof contentRef.sha256 !== "string"
    || !artifactRefId.endsWith(`:${contentRef.sha256}`)
    || !imageContract
  ) return undefined;
  const blob = await db.maybeOne<{ sha256: string; body: Buffer }>(
    "select sha256, body from southstar.artifact_blobs where id = $1 and run_id = $2",
    [contentRef.ref, runId],
  );
  if (!blob || blob.sha256 !== contentRef.sha256) return undefined;
  if (createHash("sha256").update(blob.body).digest("hex") !== blob.sha256) return undefined;
  const image = imageBytesFromArtifactJson(blob.body);
  const structure = image ? inspectSupportedImage(image) : undefined;
  return image && structure && await fullyDecodesAs(image, structure) ? blob.sha256 : undefined;
}

export async function prepareRequirementEvaluatorScreenshotProofPg(
  db: SouthstarDb,
  input: { runId: string; artifact: unknown },
): Promise<WorkspaceScreenshotProof | undefined> {
  const artifact = asRecord(input.artifact);
  const ref = screenshotEvidenceRef(artifact, input.runId);
  if (!ref || ref.startsWith("artifact_ref:") || /^https?:/i.test(ref)) return undefined;
  const run = await db.one<{ runtime_context_json: unknown }>(
    "select runtime_context_json from southstar.workflow_runs where id = $1",
    [input.runId],
  );
  const runtimeContext = asRecord(run.runtime_context_json);
  const workspaceRoot = nonEmptyString(runtimeContext.projectRoot) ?? nonEmptyString(runtimeContext.cwd);
  return workspaceRoot ? await prepareWorkspaceScreenshotProof(workspaceRoot, ref) : undefined;
}

export async function prepareWorkspaceScreenshotProof(
  workspaceRoot: string,
  screenshotPath: string,
): Promise<WorkspaceScreenshotProof | undefined> {
  let handle: FileHandle | undefined;
  try {
    const root = await realpath(workspaceRoot);
    handle = await open(resolve(root, screenshotPath), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > MAX_SCREENSHOT_BYTES) return undefined;
    const target = await realpath(`/proc/self/fd/${handle.fd}`);
    const contained = relative(root, target);
    if (contained.startsWith("..") || isAbsolute(contained)) return undefined;
    const content = await readBounded(handle, MAX_SCREENSHOT_BYTES);
    const image = inspectSupportedImage(content);
    if (!image || !await fullyDecodesAs(content, image)) return undefined;
    return {
      ref: screenshotPath,
      workspaceRoot,
      canonicalWorkspaceRoot: root,
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.byteLength,
      ...image,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const output = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset <= maxBytes) {
    const { bytesRead } = await handle.read(output, offset, maxBytes + 1 - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset === 0 || offset > maxBytes) throw new Error("screenshot exceeds bounded read limit");
  return output.subarray(0, offset);
}

export function inspectSupportedImage(content: Buffer): Pick<WorkspaceScreenshotProof, "format" | "width" | "height"> | undefined {
  if (content.byteLength === 0 || content.byteLength > MAX_SCREENSHOT_BYTES) return undefined;
  return inspectPng(content) ?? inspectJpeg(content) ?? inspectWebp(content);
}

async function fullyDecodesAs(
  content: Buffer,
  expected: Pick<WorkspaceScreenshotProof, "width" | "height">,
): Promise<boolean> {
  try {
    const image = sharp(content, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (metadata.width !== expected.width || metadata.height !== expected.height) return false;
    await image.stats();
    return true;
  } catch {
    return false;
  }
}

function inspectPng(content: Buffer): Pick<WorkspaceScreenshotProof, "format" | "width" | "height"> | undefined {
  if (!content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawImageData = false;
  let chunks = 0;
  while (offset + 12 <= content.length && chunks++ < 4_096) {
    const length = content.readUInt32BE(offset);
    const type = content.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end > content.length) return undefined;
    if (chunks === 1) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = content.readUInt32BE(offset + 8);
      height = content.readUInt32BE(offset + 12);
      if (!validDimensions(width, height)) return undefined;
    } else if (type === "IHDR") return undefined;
    if (type === "IDAT") sawImageData = true;
    offset = end;
    if (type === "IEND") return length === 0 && sawImageData && offset === content.length
      ? { format: "png", width, height }
      : undefined;
  }
  return undefined;
}

function inspectJpeg(content: Buffer): Pick<WorkspaceScreenshotProof, "format" | "width" | "height"> | undefined {
  if (content.length < 4 || content[0] !== 0xff || content[1] !== 0xd8) return undefined;
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  let segments = 0;
  while (offset < content.length && segments++ < 4_096) {
    if (content[offset++] !== 0xff) return undefined;
    while (content[offset] === 0xff) offset += 1;
    const marker = content[offset++];
    if (marker === 0xd9) return sawScan && validDimensions(width, height) && offset === content.length
      ? { format: "jpeg", width, height }
      : undefined;
    if (marker === undefined || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return undefined;
    if (offset + 2 > content.length) return undefined;
    const length = content.readUInt16BE(offset);
    if (length < 2 || offset + length > content.length) return undefined;
    if (isSofMarker(marker)) {
      if (length < 11) return undefined;
      height = content.readUInt16BE(offset + 3);
      width = content.readUInt16BE(offset + 5);
      const components = content[offset + 7]!;
      if (length !== 8 + 3 * components || !validDimensions(width, height)) return undefined;
    }
    if (marker === 0xda) {
      sawScan = true;
      offset += length;
      while (offset + 1 < content.length) {
        if (content[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = content[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          offset += 2;
          continue;
        }
        break;
      }
    } else {
      offset += length;
    }
  }
  return undefined;
}

function inspectWebp(content: Buffer): Pick<WorkspaceScreenshotProof, "format" | "width" | "height"> | undefined {
  if (
    content.length < 20
    || content.subarray(0, 4).toString("ascii") !== "RIFF"
    || content.readUInt32LE(4) !== content.length - 8
    || content.subarray(8, 12).toString("ascii") !== "WEBP"
  ) return undefined;
  let offset = 12;
  let dimensions: { width: number; height: number } | undefined;
  let extendedDimensions: { width: number; height: number } | undefined;
  let sawImageData = false;
  let chunks = 0;
  while (offset + 8 <= content.length && chunks++ < 4_096) {
    const type = content.subarray(offset, offset + 4).toString("ascii");
    const length = content.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const end = dataOffset + length;
    if (!/^[\x20-\x7e]{4}$/.test(type) || end > content.length) return undefined;
    const data = content.subarray(dataOffset, end);
    const parsed = type === "VP8X" ? dimensionsFromVp8x(data)
      : type === "VP8L" ? dimensionsFromVp8l(data)
      : type === "VP8 " ? dimensionsFromVp8(data)
      : undefined;
    if (parsed) {
      if (type === "VP8X") extendedDimensions = parsed;
      else {
        dimensions = parsed;
        sawImageData = true;
      }
    }
    else if (type === "VP8X" || type === "VP8L" || type === "VP8 ") return undefined;
    if (length % 2 && content[end] !== 0) return undefined;
    offset = end + (length % 2);
  }
  const resolved = extendedDimensions ?? dimensions;
  return offset === content.length
    && sawImageData
    && resolved
    && dimensions
    && (!extendedDimensions || (extendedDimensions.width === dimensions.width && extendedDimensions.height === dimensions.height))
    && validDimensions(resolved.width, resolved.height)
    ? { format: "webp", ...resolved }
    : undefined;
}

function dimensionsFromVp8x(data: Buffer): { width: number; height: number } | undefined {
  if (data.length !== 10 || (data[0]! & 0xc1) !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) return undefined;
  return { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1 };
}

function dimensionsFromVp8l(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 5 || data[0] !== 0x2f) return undefined;
  const bits = data.readUInt32LE(1);
  if ((bits >>> 29) !== 0) return undefined;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

function dimensionsFromVp8(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 10 || (data[0]! & 1) !== 0 || !data.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return undefined;
  return { width: data.readUInt16LE(6) & 0x3fff, height: data.readUInt16LE(8) & 0x3fff };
}

function isSofMarker(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function validDimensions(width: number, height: number): boolean {
  return width > 0
    && height > 0
    && width <= MAX_IMAGE_DIMENSION
    && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}

function imageBytesFromArtifactJson(body: Buffer): Buffer | undefined {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    if (isBufferJson(value)) return boundedBuffer(value.data);
    const artifact = asRecord(value);
    if (!/(screenshot|image)/i.test(nonEmptyString(artifact.kind) ?? "")) return undefined;
    if (typeof artifact.dataUrl === "string") {
      const match = artifact.dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
      return match ? decodeBoundedBase64(match[1]!) : undefined;
    }
    if (typeof artifact.base64 === "string") return decodeBoundedBase64(artifact.base64);
    if (isBufferJson(artifact.bytes)) return boundedBuffer(artifact.bytes.data);
    if (Array.isArray(artifact.bytes)) return boundedBuffer(artifact.bytes);
    return undefined;
  } catch {
    return undefined;
  }
}

function isBufferJson(value: unknown): value is { type: "Buffer"; data: unknown[] } {
  const record = asRecord(value);
  return record.type === "Buffer" && Array.isArray(record.data);
}

function boundedBuffer(value: unknown[]): Buffer | undefined {
  if (value.length === 0 || value.length > MAX_SCREENSHOT_BYTES) return undefined;
  if (value.some((byte) => !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255)) return undefined;
  return Buffer.from(value as number[]);
}

function decodeBoundedBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 && decoded.length <= MAX_SCREENSHOT_BYTES
    && decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")
    ? decoded
    : undefined;
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
    status: evidence.evidenceItems.every((item) => item.status === "present") ? "complete" : "incomplete",
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
  result: RequirementEvaluatorResult,
  resourceKey: string,
): Promise<void> {
  const requirementIds = [result.requirementId];
  await upsertRuntimeResourcePg(db, {
    id: resourceKey,
    resourceType: "requirement_evaluator_result",
    resourceKey,
    runId: input.runId,
    taskId: input.taskId,
    scope: "evaluator",
    status: result.verdict,
    title: `Requirement evaluator ${requirementIds.join(", ")}`,
    payload: result,
    summary: { requirementIds, findingCount: result.findings.length },
  });
}

export async function loadFrozenCoverageContextPg(
  db: SouthstarDb,
  runId: string,
): Promise<FrozenCoverageContext | undefined> {
  return (await loadFrozenCoverageContextsPg(db, [runId])).get(runId);
}

export async function loadFrozenCoverageContextsPg(
  db: SouthstarDb,
  runIds: string[],
): Promise<Map<string, FrozenCoverageContext>> {
  const ids = [...new Set(runIds)];
  if (ids.length === 0) return new Map();
  const runs = (await db.query<{
    id: string;
    runtime_context_json: unknown;
    workflow_manifest_json: unknown;
  }>(
    "select id, runtime_context_json, workflow_manifest_json from southstar.workflow_runs where id = any($1::text[])",
    [ids],
  )).rows;
  if (runs.length !== ids.length) {
    const found = new Set(runs.map((run) => run.id));
    throw new Error(`run not found: ${ids.find((id) => !found.has(id))}`);
  }
  const draftIds = runs
    .map((run) => nonEmptyString(asRecord(run.runtime_context_json).draftId))
    .filter((value): value is string => Boolean(value));
  const coverageRows = await db.query<CoverageResourceRow>(
    `select resource_key, run_id, scope, status, payload_json
       from southstar.runtime_resources
      where run_id = any($1::text[]) and resource_type = 'goal_requirement_coverage'`,
    [ids],
  );
  const draftRows = draftIds.length === 0
    ? { rows: [], rowCount: 0 }
    : await db.query<{ resource_key: string; status: string; payload_json: unknown }>(
      `select resource_key, status, payload_json
         from southstar.runtime_resources
        where resource_type = 'planner_draft' and resource_key = any($1::text[])`,
      [draftIds],
    );
  const revisionRows = await db.query<CoverageResourceRow>(
    `select resource_key, run_id, scope, status, payload_json
       from southstar.runtime_resources
      where run_id = any($1::text[]) and resource_type = 'goal_requirement_coverage_revision'
      order by created_at, resource_key`,
    [ids],
  );
  const coverageByRun = new Map(coverageRows.rows.map((row) => [row.run_id, row]));
  const draftById = new Map(draftRows.rows.map((row) => [row.resource_key, row]));
  const revisionsByRun = new Map<string, CoverageResourceRow[]>();
  for (const row of revisionRows.rows) {
    if (!row.run_id) continue;
    const rows = revisionsByRun.get(row.run_id) ?? [];
    rows.push(row);
    revisionsByRun.set(row.run_id, rows);
  }
  const result = new Map<string, FrozenCoverageContext>();
  for (const run of runs) {
    const runtimeContext = asRecord(run.runtime_context_json);
    const runContractHash = nonEmptyString(runtimeContext.goalContractHash);
    const runGoalDesignPackageHash = nonEmptyString(runtimeContext.goalDesignPackageHash);
    const coverageResource = coverageByRun.get(run.id);
    if (!coverageResource) {
      continue;
    }
    if (
      coverageResource.run_id !== run.id
      || coverageResource.resource_key !== run.id
      || coverageResource.scope !== "run"
      || coverageResource.status !== "frozen"
    ) continue;
    if (!runContractHash) continue;
    const draftId = nonEmptyString(runtimeContext.draftId);
    if (!draftId) continue;
    const plannerDraft = draftById.get(draftId);
    if (!plannerDraft || plannerDraft.status !== "validated") continue;
    const draftPayload = asRecord(plannerDraft.payload_json);
    const goalDesignPackage = goalDesignPackageV2FromUnknown(draftPayload.goalDesignPackage);
    if (!goalDesignPackage) continue;
    if (!runGoalDesignPackageHash || runGoalDesignPackageHash !== goalDesignPackage.packageHash) continue;
    const goalContract = storedGoalContract(draftPayload.goalContract);
    if (!goalContract) continue;
    const canonicalHash = goalContractHash(goalContract);
    if (goalDesignPackage.goalContractHash !== canonicalHash) continue;
    if (runContractHash !== canonicalHash || nonEmptyString(draftPayload.goalContractHash) !== canonicalHash) continue;
    let manifest: SouthstarWorkflowManifest;
    let coverage: GoalRequirementCoverageV1;
    try {
      manifest = parseManifest(run.workflow_manifest_json, run.id);
      const baseCoverage = parseCoverage(coverageResource.payload_json, run.id, goalContract, manifest);
      coverage = loadEffectiveCoverage(revisionsByRun.get(run.id) ?? [], run.id, goalContract, manifest, baseCoverage);
    } catch {
      continue;
    }
    if (coverage.goalContractHash !== canonicalHash) continue;
    result.set(run.id, {
      coverage,
      manifest,
      goalContract,
      workspaceRoot: nonEmptyString(runtimeContext.projectRoot) ?? nonEmptyString(runtimeContext.cwd),
      blockingRequirementIds: new Set(
        goalContract.requirements.filter((requirement) => requirement.blocking).map((requirement) => requirement.id),
      ),
    });
  }
  return result;
}

export async function frozenCoverageUnavailableDiagnosticPg(
  db: SouthstarDb,
  runId: string,
): Promise<CanonicalDiagnostic | undefined> {
  const row = await db.maybeOne<{
    runtime_context_json: unknown;
    draft_resource_key: string | null;
    draft_status: string | null;
    draft_payload_json: unknown;
    coverage_resource_key: string | null;
    coverage_run_id: string | null;
    coverage_scope: string | null;
    coverage_status: string | null;
  }>(
    `select r.runtime_context_json,
            d.resource_key as draft_resource_key,
            d.status as draft_status,
            d.payload_json as draft_payload_json,
            c.resource_key as coverage_resource_key,
            c.run_id as coverage_run_id,
            c.scope as coverage_scope,
            c.status as coverage_status
       from southstar.workflow_runs r
       left join southstar.runtime_resources d
         on d.resource_type = 'planner_draft'
        and d.resource_key = nullif(r.runtime_context_json->>'draftId', '')
       left join southstar.runtime_resources c
         on c.resource_type = 'goal_requirement_coverage'
        and c.resource_key = r.id
      where r.id = $1`,
    [runId],
  );
  if (!row) return undefined;
  const runtimeContext = asRecord(row.runtime_context_json);
  const goalContractHashRef = nonEmptyString(runtimeContext.goalContractHash);
  const draftId = nonEmptyString(runtimeContext.draftId);
  const runGoalDesignPackageHash = nonEmptyString(runtimeContext.goalDesignPackageHash);
  if (!goalContractHashRef && !draftId && !runGoalDesignPackageHash) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageRequired,
      `run ${runId} has no canonical Goal Design lineage`,
    );
  }
  if (!draftId) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageRequired,
      `run ${runId} has no canonical planner draft lineage`,
    );
  }
  if (!row.draft_resource_key) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageRequired,
      `run ${runId} planner draft lineage ${draftId} does not exist`,
    );
  }
  if (row.draft_status !== "validated") {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid,
      `run ${runId} planner draft ${draftId} is not validated`,
    );
  }
  const draftPayload = asRecord(row.draft_payload_json);
  const goalDesignPackage = goalDesignPackageV2FromUnknown(draftPayload.goalDesignPackage);
  if (!goalDesignPackage) {
    return canonicalDiagnostic(
      draftPayload.goalDesignPackage === undefined
        ? CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageRequired
        : CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid,
      `planner draft ${draftId} does not contain a valid southstar.goal_design_package.v2`,
    );
  }
  if (!runGoalDesignPackageHash || runGoalDesignPackageHash !== goalDesignPackage.packageHash) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid,
      `run ${runId} immutable Goal Design package hash does not match planner draft ${draftId}`,
    );
  }
  const goalContract = storedGoalContract(draftPayload.goalContract);
  if (!goalContract) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid,
      `planner draft ${draftId} does not contain a valid canonical Goal Contract`,
    );
  }
  const canonicalHash = goalContractHash(goalContract);
  if (
    goalContractHashRef !== canonicalHash
    || nonEmptyString(draftPayload.goalContractHash) !== canonicalHash
    || goalDesignPackage.goalContractHash !== canonicalHash
  ) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalDesignPackageInvalid,
      `run ${runId} Goal Contract hash does not match planner draft ${draftId}`,
    );
  }
  if (!row.coverage_resource_key) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalRequirementCoverageMissing,
      `run ${runId} has no frozen goal requirement coverage`,
    );
  }
  if (
    row.coverage_resource_key !== runId
    || row.coverage_run_id !== runId
    || row.coverage_scope !== "run"
    || row.coverage_status !== "frozen"
  ) {
    return canonicalDiagnostic(
      CANONICAL_DIAGNOSTIC_CODES.goalRequirementCoverageInvalid,
      `run ${runId} Goal Requirement Coverage is not a frozen run-scoped resource`,
    );
  }
  return canonicalDiagnostic(
    CANONICAL_DIAGNOSTIC_CODES.goalRequirementCoverageInvalid,
    `run ${runId} frozen Goal Requirement Coverage is incompatible with canonical Goal Design lineage`,
  );
}

async function persistFrozenCoverageDiagnosticPg(
  db: SouthstarDb,
  input: { runId: string; taskId?: string; rootSessionId?: string; attemptId?: string; handExecutionId?: string; now?: string },
  diagnostic: CanonicalDiagnostic,
): Promise<void> {
  await recordRuntimeExceptionInTxPg(db, {
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.rootSessionId ? { sessionId: input.rootSessionId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.handExecutionId ? { handExecutionId: input.handExecutionId } : {}),
    source: "callback",
    kind: diagnostic.code === CANONICAL_DIAGNOSTIC_CODES.requirementEvaluatorResultIncompatible
      ? "callback_contract_violation"
      : "validation_failed",
    severity: "blocking",
    status: "blocked",
    observedAt: input.now ?? new Date().toISOString(),
    evidenceRefs: [diagnostic.message],
    providerEvidence: diagnostic,
  });
}

type CoverageResourceRow = {
  resource_key: string;
  run_id: string | null;
  scope: string;
  status: string;
  payload_json: unknown;
};

function loadEffectiveCoverage(
  rows: CoverageResourceRow[],
  runId: string,
  goalContract: GoalContractV1,
  manifest: SouthstarWorkflowManifest,
  baseCoverage: GoalRequirementCoverageV1,
): GoalRequirementCoverageV1 {
  let effective = baseCoverage;
  for (const row of rows) {
    const payload = asRecord(row.payload_json);
    const targetRequirementIds = stringArray(payload.targetRequirementIds).sort();
    const repairCoverage = asRecord(payload.repairCoverage);
    const storedEffective = asRecord(payload.effectiveCoverage);
    if (
      row.run_id !== runId
      || row.scope !== "run"
      || row.status !== "frozen"
      || payload.schemaVersion !== "southstar.goal_requirement_coverage_revision.v1"
      || payload.baseCoverageResourceKey !== runId
      || payload.goalContractHash !== goalContractHash(goalContract)
      || payload.baseCoverageHash !== contentHashForPayload(effective)
      || targetRequirementIds.length === 0
      || repairCoverage.schemaVersion !== "southstar.goal_requirement_coverage.v1"
      || repairCoverage.goalContractHash !== goalContractHash(goalContract)
      || !Array.isArray(repairCoverage.entries)
      || !Array.isArray(storedEffective.entries)
      || payload.effectiveCoverageHash !== contentHashForPayload(storedEffective)
    ) throw new Error(`invalid Goal Requirement Coverage revision for run ${runId}: ${row.resource_key}`);
    const repairEntries = repairCoverage.entries.map(asRecord);
    if (
      repairEntries.length !== targetRequirementIds.length
      || repairEntries.map((entry) => nonEmptyString(entry.requirementId)).sort().join("\u0000") !== targetRequirementIds.join("\u0000")
    ) throw new Error(`invalid Goal Requirement Coverage revision targets for run ${runId}: ${row.resource_key}`);
    const replacement = new Map(repairEntries.map((entry) => [entry.requirementId as string, entry]));
    const expected = {
      ...effective,
      entries: effective.entries.map((entry) => replacement.get(entry.requirementId) ?? entry),
    };
    if (contentHashForPayload(expected) !== contentHashForPayload(storedEffective)) {
      throw new Error(`invalid Goal Requirement Coverage revision fold for run ${runId}: ${row.resource_key}`);
    }
    effective = parseCoverage(storedEffective, runId, goalContract, manifest);
  }
  return effective;
}

function parseCoverage(
  value: unknown,
  runId: string,
  goalContract: GoalContractV1,
  manifest: SouthstarWorkflowManifest,
): GoalRequirementCoverageV1 {
  const fail = (path: string): never => {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: ${path}`);
  };
  const rawCoverage = asRecord(value);
  if (rawCoverage.schemaVersion !== "southstar.goal_requirement_coverage.v1") fail("schemaVersion");
  const rawEntries = rawCoverage.entries;
  const entries = Array.isArray(rawEntries) ? rawEntries : fail("entries");
  for (const [index, rawEntry] of entries.entries()) {
    const entry = asRecord(rawEntry);
    for (const key of [
      "producerTaskIds",
      "artifactRefs",
      "evaluatorTaskIds",
      "evaluatorProfileRefs",
      "requiredEvidenceKinds",
    ]) {
      if (!Array.isArray(entry[key])) fail(`entries[${index}].${key}`);
    }
  }
  const coverage = storedGoalRequirementCoverage(value);
  if (!coverage) throw new Error(`invalid Goal Requirement Coverage for run ${runId}: stored projection`);
  const requirements = new Map(goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const manifestTasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const manifestTaskIds = new Set(manifestTasks.keys());
  const aliases = artifactContractAliases(manifest);
  const seenRequirements = new Set<string>();
  for (const [index, entry] of coverage.entries.entries()) {
    const path = `entries[${index}]`;
    const requirement = requirements.get(entry.requirementId);
    if (!requirement) throw new Error(`invalid Goal Requirement Coverage for run ${runId}: ${path}.requirementId references unknown Goal Contract requirement`);
    seenRequirements.add(entry.requirementId);
    for (const key of ["producerTaskIds", "artifactRefs", "evaluatorTaskIds", "evaluatorProfileRefs"] as const) {
      const values = entry[key];
      if (requirement.blocking && values.length === 0) fail(`${path}.${key}`);
    }
    if (requirement.blocking && entry.requiredEvidenceKinds.length === 0) fail(`${path}.requiredEvidenceKinds`);
    const hasCriterionCoverage = entry.criterionIds.length > 0;
    if (hasCriterionCoverage) {
      if (
        entry.criterionIds.length !== entry.acceptanceCriteria.length
        || new Set(entry.criterionIds).size !== entry.criterionIds.length
        || JSON.stringify(entry.acceptanceCriteria) !== JSON.stringify(requirement.acceptanceCriteria)
      ) fail(`${path}.criterionIds`);
      const validationBindingId = entry.validationBindingId ?? fail(`${path}.validationBindingId`);
      if (entry.evaluatorProfileRefs.length !== 1) fail(`${path}.evaluatorProfileRefs`);
      if (entry.evaluatorProfileVersionRefs.length !== 1) fail(`${path}.evaluatorProfileVersionRefs`);
      const profileRef = entry.evaluatorProfileRefs[0]!;
      const profileVersionRef = entry.evaluatorProfileVersionRefs[0]!;
      const pipeline = (manifest.evaluatorPipelines ?? []).find((candidate) =>
        normalizeRequirementEvidenceRef(candidate.libraryObjectRef ?? candidate.id, "evaluator")
          === normalizeRequirementEvidenceRef(profileRef, "evaluator")
          && candidate.libraryVersionRef === profileVersionRef
      ) ?? fail(`manifest is missing frozen evaluator pipeline ${profileRef}@${profileVersionRef}`);
      if (!pipeline.validationBindingIds?.includes(validationBindingId)) {
        fail(`manifest evaluator pipeline is missing validation binding ${validationBindingId}`);
      }
      const pipelineBindingIds = pipeline.validationBindingIds ?? [];
      const pipelineCriterionIds = pipeline.evaluators
        .filter((step) => {
          const stepBindingId = nonEmptyString(asRecord(step.config).validationBindingId);
          if (stepBindingId) return stepBindingId === validationBindingId;
          return pipelineBindingIds.length === 1;
        })
        .map((step) => nonEmptyString(asRecord(step.config).criterionId))
        .filter((value): value is string => Boolean(value));
      if (
        pipelineCriterionIds.length !== entry.criterionIds.length
        || new Set(pipelineCriterionIds).size !== pipelineCriterionIds.length
        || [...pipelineCriterionIds].sort().join("\u0000") !== [...entry.criterionIds].sort().join("\u0000")
      ) fail(`${path}.criterionIds do not match manifest evaluator pipeline`);
    } else if (
      entry.acceptanceCriteria.length > 0
      || entry.evaluatorProfileVersionRefs.length > 0
      || entry.validationBindingId !== undefined
    ) {
      fail(`${path} has partial criterion coverage`);
    }
    for (const producerTaskId of entry.producerTaskIds) {
      if (!manifestTaskIds.has(producerTaskId)) fail(`manifest is missing producer task ${producerTaskId}`);
    }
    const producerArtifactRefs = new Set(
      entry.producerTaskIds.flatMap((producerTaskId) =>
        (manifestTasks.get(producerTaskId)?.requiredArtifactRefs ?? [])
          .map((ref) => canonicalContractRef(ref, aliases))
      ),
    );
    for (const artifactRef of entry.artifactRefs) {
      if (!producerArtifactRefs.has(canonicalContractRef(artifactRef, aliases))) {
        fail(`artifact ref ${artifactRef} is not declared by producer task`);
      }
    }
    for (const evaluatorTaskId of entry.evaluatorTaskIds) {
      if (!manifestTaskIds.has(evaluatorTaskId)) fail(`manifest is missing evaluator task ${evaluatorTaskId}`);
    }
  }
  for (const requirement of goalContract.requirements) {
    if (requirement.blocking && !seenRequirements.has(requirement.id)) {
      fail(`missing blocking requirement ${requirement.id}`);
    }
  }
  return coverage;
}

function resolveEvaluatorProfileRef(
  manifest: SouthstarWorkflowManifest,
  entry: CoverageEntry,
  taskId: string,
): string {
  const profiles = uniqueSorted(entry.evaluatorProfileRefs);
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`manifest is missing evaluator task ${taskId}`);
  const manifestRef = nonEmptyString(task.evaluatorPipelineRef);
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

async function assertExecutionIdentityPg(
  db: SouthstarDb,
  input: EvaluatorCallbackIdentity,
  context: FrozenCoverageContext,
  entries: CoverageEntry[],
): Promise<void> {
  const attemptId = nonEmptyString(input.attemptId);
  const prefix = `evaluator execution identity ${input.runId}/${input.taskId}/${input.attemptId ?? "missing"}`;
  if (!attemptId) throw new Error(`${prefix}: explicit attemptId is required`);

  const task = await db.one<{ root_session_id: string | null }>(
    "select root_session_id from southstar.workflow_tasks where run_id = $1 and id = $2",
    [input.runId, input.taskId],
  );
  if (task.root_session_id !== input.rootSessionId) throw new Error(`${prefix}: sessionId does not match current task session`);

  const intentKey = `task-intent:${input.runId}:${input.taskId}:${attemptId}`;
  const latestIntent = await db.maybeOne<{ resource_key: string }>(
    `select resource_key
       from southstar.runtime_resources
      where run_id = $1 and task_id = $2 and resource_type = 'task_execution_intent'
      order by created_at desc, resource_key desc
      limit 1`,
    [input.runId, input.taskId],
  );
  const intent = await getResourceByKeyPg(db, "task_execution_intent", intentKey);
  if (!intent || latestIntent?.resource_key !== intentKey) {
    throw new Error(`${prefix}: missing persisted execution binding for current attempt`);
  }
  assertResourceTuple(prefix, intent, input, "task");
  const intentPayload = asRecord(intent.payload);
  if (
    intentPayload.runId !== input.runId
    || intentPayload.taskId !== input.taskId
    || intentPayload.sessionId !== input.rootSessionId
    || intentPayload.attemptId !== attemptId
    || !nonEmptyString(intentPayload.handProviderId)
  ) throw new Error(`${prefix}: task execution intent tuple mismatch`);

  const handExecution = await getResourceByKeyPg(db, "hand_execution", input.handExecutionId);
  if (!handExecution) throw new Error(`${prefix}: hand execution is missing`);
  assertResourceTuple(prefix, handExecution, input, "hand");
  const handPayload = asRecord(handExecution.payload);
  if (
    handPayload.schemaVersion !== "southstar.runtime.hand_execution.v1"
    || handPayload.handExecutionId !== input.handExecutionId
    || handPayload.providerId !== intentPayload.handProviderId
    || handPayload.runId !== input.runId
    || handPayload.taskId !== input.taskId
    || handPayload.sessionId !== input.rootSessionId
    || handPayload.attemptId !== attemptId
    || handPayload.status !== handExecution.status
  ) throw new Error(`${prefix}: hand execution tuple mismatch`);

  const bindingKey = `executor-${input.runId}-${input.taskId}-${attemptId}`;
  const executorBinding = await getResourceByKeyPg(db, "executor_binding", bindingKey);
  if (executorBinding) {
    assertResourceTuple(prefix, executorBinding, input, "executor", false);
    const payload = asRecord(executorBinding.payload);
    if (
      payload.runId !== input.runId
      || payload.taskId !== input.taskId
      || payload.attemptId !== attemptId
      || payload.executorType !== "tork"
    ) throw new Error(`${prefix}: executor binding tuple mismatch`);
  }

  const envelopeKey = `task-envelope-${input.runId}-${input.taskId}-${attemptId}`;
  const taskEnvelope = await getResourceByKeyPg(db, "task_envelope", envelopeKey);
  if (!taskEnvelope || taskEnvelope.status !== "materialized") throw new Error(`${prefix}: task envelope is missing`);
  assertResourceTuple(prefix, taskEnvelope, input, "task");
  const envelope = asRecord(asRecord(taskEnvelope.payload).envelope);
  const envelopeSession = asRecord(envelope.session);
  const contextPacket = asRecord(envelope.contextPacket);
  if (
    envelope.runId !== input.runId
    || envelope.taskId !== input.taskId
    || envelopeSession.sessionId !== input.rootSessionId
    || (contextPacket.rootSessionId !== undefined && contextPacket.rootSessionId !== input.rootSessionId)
  ) throw new Error(`${prefix}: task envelope tuple mismatch`);
  const executedProfile = nonEmptyString(asRecord(envelope.evaluatorPipeline).id);
  if (!executedProfile) throw new Error(`${prefix}: task envelope evaluator profile is missing`);
  for (const entry of entries) {
    const expectedProfile = resolveEvaluatorProfileRef(context.manifest, entry, input.taskId);
    if (normalizeRequirementEvidenceRef(executedProfile, "evaluator") !== normalizeRequirementEvidenceRef(expectedProfile, "evaluator")) {
      throw new Error(`executed evaluator profile ${executedProfile} does not match frozen coverage for task ${input.taskId}`);
    }
  }
}

function assertResourceTuple(
  prefix: string,
  resource: { runId?: string; taskId?: string; sessionId?: string; scope: string },
  input: EvaluatorCallbackIdentity,
  scope: string,
  requireSession = true,
): void {
  if (
    resource.runId !== input.runId
    || resource.taskId !== input.taskId
    || (requireSession && resource.sessionId !== input.rootSessionId)
    || resource.scope !== scope
  ) throw new Error(`${prefix}: persisted ${scope} resource tuple mismatch`);
}

function parseManifest(value: unknown, runId: string): SouthstarWorkflowManifest {
  const manifest = asRecord(value);
  if (manifest.schemaVersion !== "southstar.v2" || !Array.isArray(manifest.tasks)) {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: workflow manifest`);
  }
  if (manifest.tasks.some((task) => !nonEmptyString(asRecord(task).id))) {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: workflow manifest tasks`);
  }
  return value as SouthstarWorkflowManifest;
}

function artifactContractAliases(manifest: SouthstarWorkflowManifest): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const contract of manifest.artifactContracts ?? []) {
    const id = normalizeRequirementEvidenceRef(contract.id, "artifact");
    aliases.set(id, id);
    aliases.set(normalizeRequirementEvidenceRef(contract.artifactType, "artifact"), id);
  }
  return aliases;
}

function canonicalContractRef(ref: string, aliases: Map<string, string>): string {
  const normalized = normalizeRequirementEvidenceRef(ref, "artifact");
  return aliases.get(normalized) ?? normalized;
}

export function normalizeRequirementEvidenceRef(value: string, namespace: "artifact" | "evaluator"): string {
  return value.replace(new RegExp(`^${namespace}[.:]`), "");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

const EVIDENCE_KINDS = new Set<EvidenceKind>([
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

function isEvidenceKind(value: string): value is EvidenceKind {
  return EVIDENCE_KINDS.has(value as EvidenceKind);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

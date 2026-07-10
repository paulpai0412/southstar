import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import sharp from "sharp";
import type { SouthstarDb } from "../db/postgres.ts";
import { buildEvidencePacket, screenshotEvidenceRef } from "../artifacts/evidence.ts";
import type { EvidenceKind, EvidencePacket, ValidatorResult } from "../artifacts/types.ts";
import { evidenceValidatorResult } from "../artifacts/validator-results.ts";
import { contentHashForPayload } from "../design-library/canonical-json.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import {
  goalContractHash,
  storedGoalContract,
  type GoalContractV1,
} from "../orchestration/goal-contract.ts";
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
  if (!context) return;
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
  if (!context) return { ok: true, evidenceRefs: [], evaluatorResultRefs: [], findings: [] };
  const entries = context.coverage.entries.filter((entry) => entry.evaluatorTaskIds.includes(input.taskId));
  if (entries.length === 0) return { ok: true, evidenceRefs: [], evaluatorResultRefs: [], findings: [] };
  await assertExecutionIdentityPg(db, input, context, entries);

  const evidenceRefs: string[] = [];
  const evaluatorResultRefs: string[] = [];
  const findings: string[] = [];
  let ok = true;

  for (const entry of entries) {
    const evaluation = await evaluateEntry(db, input, entry, context.manifest, context.workspaceRoot);
    await persistEvidencePacket(db, evaluation.evidence);
    await persistValidatorResult(db, evaluation.validator);
    await persistRequirementResult(db, input, evaluation.result, evaluation.resourceKey);

    evidenceRefs.push(evaluation.evidence.id);
    evaluatorResultRefs.push(evaluation.validator.id, evaluation.resourceKey);
    findings.push(...evaluation.result.findings);
    if (
      context.blockingRequirementIds.has(entry.requirementId)
      && evaluation.result.verdict !== "passed"
    ) ok = false;
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
    rootSessionId: string;
    attemptId?: string;
    handExecutionId: string;
    screenshotProof?: WorkspaceScreenshotProof;
    now?: string;
  },
  entry: CoverageEntry,
  manifest: SouthstarWorkflowManifest,
  workspaceRoot: string | undefined,
): Promise<{
  evidence: EvidencePacket;
  validator: ValidatorResult;
  result: RequirementEvaluatorResultV1;
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
  const resourceKey = `${contractRef}:${input.taskId}:${input.artifactRefId}`;
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

export async function loadFrozenCoverageContextPg(
  db: SouthstarDb,
  runId: string,
): Promise<FrozenCoverageContext | undefined> {
  const run = await db.one<{ runtime_context_json: unknown; workflow_manifest_json: unknown }>(
    "select runtime_context_json, workflow_manifest_json from southstar.workflow_runs where id = $1",
    [runId],
  );
  const runtimeContext = asRecord(run.runtime_context_json);
  const runContractHash = nonEmptyString(runtimeContext.goalContractHash);
  const coverageResource = await getResourceByKeyPg(db, "goal_requirement_coverage", runId);
  if (!coverageResource) {
    if (runContractHash) throw new Error(`Goal Contract run ${runId} is missing frozen requirement coverage`);
    return undefined;
  }
  if (
    coverageResource.runId !== runId
    || coverageResource.resourceKey !== runId
    || coverageResource.scope !== "run"
    || coverageResource.status !== "frozen"
  ) {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: resource must be run-scoped and frozen`);
  }
  if (!runContractHash) {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: runtimeContext.goalContractHash`);
  }
  const draftId = nonEmptyString(runtimeContext.draftId);
  if (!draftId) throw new Error(`invalid Goal Requirement Coverage for run ${runId}: runtimeContext.draftId`);
  const plannerDraft = await getResourceByKeyPg(db, "planner_draft", draftId);
  if (!plannerDraft || plannerDraft.status !== "validated") {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: canonical planner draft`);
  }
  const draftPayload = asRecord(plannerDraft.payload);
  const goalContract = storedGoalContract(draftPayload.goalContract);
  if (!goalContract) throw new Error(`invalid Goal Requirement Coverage for run ${runId}: plannerDraft.goalContract`);
  const canonicalHash = goalContractHash(goalContract);
  if (
    runContractHash !== canonicalHash
    || nonEmptyString(draftPayload.goalContractHash) !== canonicalHash
  ) {
    throw new Error(`invalid Goal Requirement Coverage for run ${runId}: canonical Goal Contract hash mismatch`);
  }
  const manifest = parseManifest(run.workflow_manifest_json, runId);
  const baseCoverage = parseCoverage(coverageResource.payload, runId, goalContract, manifest);
  const coverage = await loadEffectiveCoveragePg(db, runId, goalContract, manifest, baseCoverage);
  if (coverage.goalContractHash !== canonicalHash) {
    throw new Error(`Goal Requirement Coverage for run ${runId} goalContractHash does not match canonical Goal Contract`);
  }
  return {
    coverage,
    manifest,
    goalContract,
    workspaceRoot: nonEmptyString(runtimeContext.projectRoot) ?? nonEmptyString(runtimeContext.cwd),
    blockingRequirementIds: new Set(
      goalContract.requirements.filter((requirement) => requirement.blocking).map((requirement) => requirement.id),
    ),
  };
}

async function loadEffectiveCoveragePg(
  db: SouthstarDb,
  runId: string,
  goalContract: GoalContractV1,
  manifest: SouthstarWorkflowManifest,
  baseCoverage: GoalRequirementCoverageV1,
): Promise<GoalRequirementCoverageV1> {
  const rows = (await db.query<{
    resource_key: string;
    run_id: string | null;
    scope: string;
    status: string;
    payload_json: unknown;
  }>(
    `select resource_key, run_id, scope, status, payload_json
       from southstar.runtime_resources
      where run_id = $1 and resource_type = 'goal_requirement_coverage_revision'
      order by created_at, resource_key`,
    [runId],
  )).rows;
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
  const requirements = new Map(goalContract.requirements.map((requirement) => [requirement.id, requirement]));
  const manifestTasks = new Map(manifest.tasks.map((task) => [task.id, task]));
  const manifestTaskIds = new Set(manifestTasks.keys());
  const aliases = artifactContractAliases(manifest);
  const seenRequirements = new Set<string>();
  for (const [index, rawEntry] of coverage.entries.entries()) {
    const entry = asRecord(rawEntry);
    const path = `entries[${index}]`;
    if (typeof entry.requirementId !== "string" || entry.requirementId.length === 0) fail(`${path}.requirementId`);
    const requirement = requirements.get(entry.requirementId);
    if (!requirement) fail(`${path}.requirementId references unknown Goal Contract requirement`);
    if (seenRequirements.has(entry.requirementId)) fail(`${path}.requirementId is duplicated`);
    seenRequirements.add(entry.requirementId);
    for (const key of ["producerTaskIds", "artifactRefs", "evaluatorTaskIds", "evaluatorProfileRefs"] as const) {
      const values = entry[key];
      if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || item.length === 0)) {
        fail(`${path}.${key}`);
      }
      if (requirement.blocking && values.length === 0) fail(`${path}.${key}`);
    }
    if (
      !Array.isArray(entry.requiredEvidenceKinds)
      || entry.requiredEvidenceKinds.some((kind) => typeof kind !== "string" || !evidenceKinds.has(kind as EvidenceKind))
    ) {
      fail(`${path}.requiredEvidenceKinds`);
    }
    if (requirement.blocking && entry.requiredEvidenceKinds.length === 0) fail(`${path}.requiredEvidenceKinds`);
    for (const producerTaskId of entry.producerTaskIds as string[]) {
      if (!manifestTaskIds.has(producerTaskId)) fail(`manifest is missing producer task ${producerTaskId}`);
    }
    const producerArtifactRefs = new Set(
      (entry.producerTaskIds as string[]).flatMap((producerTaskId) =>
        (manifestTasks.get(producerTaskId)?.requiredArtifactRefs ?? [])
          .map((ref) => canonicalContractRef(ref, aliases))
      ),
    );
    for (const artifactRef of entry.artifactRefs as string[]) {
      if (!producerArtifactRefs.has(canonicalContractRef(artifactRef, aliases))) {
        fail(`artifact ref ${artifactRef} is not declared by producer task`);
      }
    }
    for (const evaluatorTaskId of entry.evaluatorTaskIds as string[]) {
      if (!manifestTaskIds.has(evaluatorTaskId)) fail(`manifest is missing evaluator task ${evaluatorTaskId}`);
    }
  }
  for (const requirement of goalContract.requirements) {
    if (requirement.blocking && !seenRequirements.has(requirement.id)) {
      fail(`missing blocking requirement ${requirement.id}`);
    }
  }
  return value as GoalRequirementCoverageV1;
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

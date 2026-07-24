import { createHash } from "node:crypto";
import {
  EVIDENCE_KINDS,
  EVIDENCE_PACKET_SCHEMA_VERSION,
  type EvidenceKind,
  type EvidencePacketLineage,
  type EvidencePacket,
} from "./types.ts";

export type BuildEvidencePacketInput = {
  runId: string;
  taskId: string;
  artifactRef: string;
  requiredEvidenceKinds: EvidenceKind[];
  artifact: Record<string, unknown>;
  identityScope?: string;
  lineage?: EvidencePacketLineage;
  now?: string;
};

export type ArtifactEvidenceClaim = {
  ref: string;
  kind: EvidenceKind;
};

type ExplicitEvidenceItem = {
  kind: EvidenceKind;
  status: "present" | "invalid";
  sourceRef: string;
  valueRef?: string;
  claimRefs: string[];
  summary: string;
  value: Record<string, unknown>;
};

const EVIDENCE_KIND_SET = new Set<EvidenceKind>(EVIDENCE_KINDS);
const MAX_EXPLICIT_EVIDENCE_DEPTH = 8;
const MAX_EXPLICIT_EVIDENCE_NODES = 1_000;

export function buildEvidencePacket(input: BuildEvidencePacketInput): EvidencePacket {
  const now = input.now ?? new Date().toISOString();
  const requiredKinds = [...new Set(input.requiredEvidenceKinds)];
  const available = evidenceByKind(input.artifact, now, input.runId);
  const evidenceItems = requiredKinds.map((kind) => available.get(kind) ?? missingEvidence(kind, now));
  const presentCount = evidenceItems.filter((item) => item.status === "present").length;
  return {
    schemaVersion: EVIDENCE_PACKET_SCHEMA_VERSION,
    id: `evidence-${input.runId}-${input.taskId}-${shortHash([
      input.artifactRef,
      ...(input.identityScope ? [input.identityScope] : []),
      requiredKinds.join(","),
      ...(input.lineage ? [JSON.stringify(input.lineage)] : []),
    ].join(":"))}`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    ...(input.lineage ? { lineage: input.lineage } : {}),
    evidenceItems,
    completeness: {
      requiredCount: requiredKinds.length,
      presentCount,
      missingKinds: evidenceItems
        .filter((item) => item.status === "missing")
        .map((item) => item.kind),
    },
  };
}

export function screenshotEvidenceRef(artifact: Record<string, unknown>, runId: string): string | undefined {
  const browserEvidence = isRecord(artifact.browserEvidence) ? artifact.browserEvidence : {};
  const legacyRef = safeScreenshotRef(firstDefined(
    firstArrayItem(browserEvidence.screenshots),
    browserEvidence.screenshot,
    firstArrayItem(artifact.screenshots),
    artifact.screenshot,
  ), runId);
  if (legacyRef) return legacyRef;
  return collectExplicitEvidenceItems(artifact, runId)
    .find((item) => item.kind === "screenshot" && item.status === "present")
    ?.valueRef;
}

/**
 * Extracts explicit, worker-authored evidence references without treating prose as evidence.
 * Criterion results may only cite one of these references, and the matching EvidencePacket
 * item must still pass host validation.
 */
export function artifactEvidenceClaims(
  artifact: Record<string, unknown>,
  runId: string,
): ArtifactEvidenceClaim[] {
  const claims: ArtifactEvidenceClaim[] = [];
  const push = (kind: EvidenceKind, ref: unknown) => {
    const value = explicitEvidenceRef(ref);
    if (value) claims.push({ kind, ref: value });
  };
  for (const ref of extractArtifactRefs(artifact.acceptedArtifacts)) push("artifact-ref", ref);
  for (const ref of extractArtifactRefs(artifact.verifiedArtifactRefs)) push("artifact-ref", ref);
  for (const ref of extractArtifactRefs(artifact.artifactRefs)) push("artifact-ref", ref);
  for (const item of arrayOrSingle(artifact.testResults)) push("test-result", item);
  for (const item of arrayOrSingle(artifact.tests)) push("test-result", item);
  for (const item of arrayOrSingle(artifact.commandsRun)) push("command-output", item);
  for (const item of arrayOrSingle(artifact.filesChanged)) push("file-diff", item);
  for (const item of arrayOrSingle(artifact.filesToInspect)) push("workspace-snapshot", item);
  for (const item of arrayOrSingle(artifact.approvals)) push("human-approval", item);
  for (const item of arrayOrSingle(artifact.policyDecisions)) push("policy-decision", item);

  const browserEvidence = isRecord(artifact.browserEvidence) ? artifact.browserEvidence : {};
  for (const item of [
    ...arrayOrSingle(browserEvidence.urls),
    ...arrayOrSingle(browserEvidence.url),
    ...arrayOrSingle(artifact.urls),
    ...arrayOrSingle(artifact.url),
  ]) {
    const url = safeHttpUrl(isRecord(item) ? firstDefined(item.ref, item.url) : item);
    if (url) claims.push({ kind: "url", ref: url });
  }
  for (const item of [
    ...arrayOrSingle(browserEvidence.screenshots),
    ...arrayOrSingle(browserEvidence.screenshot),
    ...arrayOrSingle(artifact.screenshots),
    ...arrayOrSingle(artifact.screenshot),
  ]) {
    const screenshot = safeScreenshotRef(item, runId);
    if (screenshot) claims.push({ kind: "screenshot", ref: screenshot });
  }
  for (const item of collectExplicitEvidenceItems(artifact, runId)) {
    if (item.status !== "present") continue;
    for (const ref of item.claimRefs) claims.push({ kind: item.kind, ref });
  }
  return [...new Map(claims.map((claim) => [`${claim.kind}\u0000${claim.ref}`, claim])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref));
}

function evidenceByKind(
  artifact: Record<string, unknown>,
  now: string,
  runId: string,
): Map<EvidenceKind, EvidencePacket["evidenceItems"][number]> {
  const byKind = new Map<EvidenceKind, EvidencePacket["evidenceItems"][number]>();

  const testCommandResults = commandResults(artifact.testResults);
  const executedCommandResults = executedCommands(artifact.commandsRun);
  const executedCommandEvidenceStatus = executedCommandResults.length > 0
    ? aggregateCommandStatus(executedCommandResults)
    : undefined;
  const commandEvidenceSource = executedCommandEvidenceStatus === "present" || testCommandResults.length === 0
    ? "artifact.commandsRun"
    : "artifact.testResults";
  const commandEvidenceResults = commandEvidenceSource === "artifact.commandsRun"
    ? executedCommandResults
    : testCommandResults;
  const commandStrings = extractCommandStrings(artifact.commandsRun);

  const testEvidence = objectTestEvidence(artifact, commandStrings, now);
  if (testEvidence) {
    byKind.set("test-result", testEvidence);
  }

  if (commandEvidenceResults.length > 0) {
    byKind.set("command-output", {
      kind: "command-output",
      status: aggregateCommandStatus(commandEvidenceResults),
      summary: commandEvidenceResults.map(summarizeCommand).join("; ").slice(0, 500),
      sourceRef: commandEvidenceSource,
      sha256: shortHash(safeJson(commandEvidenceResults)),
      capturedAt: now,
      reproducibleCommand: splitCommand(commandEvidenceResults[0]!.command),
      redactionApplied: true,
    });
  }

  const filesChanged = extractPathLikeValues(artifact.filesChanged);
  if (filesChanged.length > 0) {
    byKind.set("file-diff", {
      kind: "file-diff",
      status: "present",
      summary: `Changed files: ${filesChanged.join(", ")}`,
      sourceRef: "artifact.filesChanged",
      sha256: shortHash(filesChanged.join("\n")),
      capturedAt: now,
      redactionApplied: true,
    });
  }

  const filesToInspect = extractPathLikeValues(artifact.filesToInspect);
  if (filesToInspect.length > 0) {
    byKind.set("workspace-snapshot", {
      kind: "workspace-snapshot",
      status: "present",
      summary: `Workspace files inspected: ${filesToInspect.join(", ")}`,
      sourceRef: "artifact.filesToInspect",
      sha256: shortHash(filesToInspect.join("\n")),
      capturedAt: now,
      redactionApplied: true,
    });
  }

  const acceptedArtifacts = extractArtifactRefs(artifact.acceptedArtifacts);
  if (acceptedArtifacts.length > 0) {
    byKind.set("artifact-ref", {
      kind: "artifact-ref",
      status: "present",
      summary: `Accepted artifacts: ${acceptedArtifacts.join(", ")}`,
      sourceRef: "artifact.acceptedArtifacts",
      sha256: shortHash(acceptedArtifacts.join("\n")),
      capturedAt: now,
      redactionApplied: true,
    });
  }

  const browserEvidence = isRecord(artifact.browserEvidence) ? artifact.browserEvidence : {};
  const browserUrl = firstDefined(
    browserEvidence.url,
    firstArrayItem(browserEvidence.urls),
    artifact.url,
    firstArrayItem(artifact.urls),
  );
  if (browserUrl !== undefined) {
    const safeUrl = safeHttpUrl(browserUrl);
    byKind.set("url", safeUrl
      ? {
        kind: "url",
        status: "present",
        summary: `Visited ${safeUrl}`,
        sourceRef: isRecord(artifact.browserEvidence) ? "artifact.browserEvidence.url" : "artifact.url",
        sha256: shortHash(safeUrl),
        capturedAt: now,
        redactionApplied: true,
      }
      : invalidBrowserEvidence("url", "browser URL must be a credential-free HTTP(S) URL", now));
  }

  const screenshot = firstDefined(
    firstArrayItem(browserEvidence.screenshots),
    browserEvidence.screenshot,
    firstArrayItem(artifact.screenshots),
    artifact.screenshot,
  );
  if (screenshot !== undefined) {
    const safeScreenshot = safeScreenshotRef(screenshot, runId);
    byKind.set("screenshot", safeScreenshot
      ? {
        kind: "screenshot",
        status: "present",
        summary: `Captured screenshot ${safeScreenshot}`,
        sourceRef: isRecord(artifact.browserEvidence)
          ? "artifact.browserEvidence.screenshots"
          : "artifact.screenshots",
        sha256: shortHash(safeScreenshot),
        capturedAt: now,
        redactionApplied: true,
      }
      : invalidBrowserEvidence("screenshot", "screenshot must use an artifact ref, safe relative path, or HTTP(S) URL", now));
  }

  const explicitItems = collectExplicitEvidenceItems(artifact, runId);
  for (const kind of EVIDENCE_KINDS) {
    const current = byKind.get(kind);
    if (current?.status === "present") continue;
    const candidates = explicitItems.filter((item) => item.kind === kind);
    const candidate = candidates.find((item) => item.status === "present") ?? candidates[0];
    if (!candidate) continue;
    byKind.set(kind, {
      kind,
      status: candidate.status,
      summary: candidate.summary,
      sourceRef: candidate.sourceRef,
      sha256: shortHash(safeJson(candidate.value)),
      capturedAt: now,
      redactionApplied: true,
    });
  }

  return byKind;
}

function collectExplicitEvidenceItems(
  artifact: Record<string, unknown>,
  runId: string,
): ExplicitEvidenceItem[] {
  const items: ExplicitEvidenceItem[] = [];
  const visited = new WeakSet<object>();
  const pending: Array<{ value: unknown; path: string; depth: number }> = [
    { value: artifact, path: "artifact", depth: 0 },
  ];
  let visitedNodes = 0;

  while (pending.length > 0 && visitedNodes < MAX_EXPLICIT_EVIDENCE_NODES) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== "object" || current.depth > MAX_EXPLICIT_EVIDENCE_DEPTH) continue;
    if (visited.has(current.value)) continue;
    visited.add(current.value);
    visitedNodes += 1;

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }

    const record = current.value as Record<string, unknown>;
    if (isEvidenceKind(record.evidenceKind)) {
      items.push(explicitEvidenceItem(record.evidenceKind, record, current.path, runId));
    }
    const entries = Object.entries(record);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, value] = entries[index]!;
      if (value && typeof value === "object") {
        pending.push({ value, path: `${current.path}.${key}`, depth: current.depth + 1 });
      }
    }
  }

  return items;
}

function explicitEvidenceItem(
  kind: EvidenceKind,
  value: Record<string, unknown>,
  path: string,
  runId: string,
): ExplicitEvidenceItem {
  const id = nonEmptyString(value.id);
  const sourceRef = id ?? path;
  const result = validateExplicitEvidenceItem(kind, value, runId);
  const claimRefs = [id, result.ref]
    .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  return {
    kind,
    status: result.status,
    sourceRef,
    ...(result.ref ? { valueRef: result.ref } : {}),
    claimRefs: [...new Set(claimRefs)],
    summary: result.status === "present"
      ? `Explicit ${kind} evidence ${sourceRef}`
      : `Invalid explicit ${kind} evidence at ${path}`,
    value,
  };
}

function validateExplicitEvidenceItem(
  kind: EvidenceKind,
  value: Record<string, unknown>,
  runId: string,
): { status: "present" | "invalid"; ref?: string } {
  if (kind === "url") {
    const ref = safeHttpUrl(firstDefined(value.url, value.ref));
    return ref ? { status: "present", ref } : { status: "invalid" };
  }
  if (kind === "screenshot") {
    const ref = safeScreenshotRef(value, runId);
    return ref ? { status: "present", ref } : { status: "invalid" };
  }
  if (kind === "test-result") {
    return testRecordStatus(value) === "present"
      ? { status: "present", ref: explicitEvidenceRef(value) }
      : { status: "invalid" };
  }
  if (kind === "command-output") {
    return commandStatus(value) === "present"
      ? { status: "present", ref: explicitEvidenceRef(value) }
      : { status: "invalid" };
  }
  if (kind === "human-approval" || kind === "policy-decision") {
    const approved = value.approved === true
      || value.allowed === true
      || value.allow === true
      || value.passed === true
      || valueStatus(firstDefined(value.status, value.result, value.outcome, value.decision, value.verdict)) === "present";
    return approved
      ? { status: "present", ref: explicitEvidenceRef(value) }
      : { status: "invalid" };
  }

  const ref = ["artifactRef", "ref", "resourceKey", "path", "url"]
    .map((key) => nonEmptyString(value[key]))
    .find((candidate): candidate is string => Boolean(candidate));
  return ref ? { status: "present", ref } : { status: "invalid" };
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && EVIDENCE_KIND_SET.has(value as EvidenceKind);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function firstArrayItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function arrayOrSingle(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function explicitEvidenceRef(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (!isRecord(value)) return undefined;
  return ["evidenceRef", "artifactRef", "ref", "id", "resourceKey", "path", "url"]
    .map((key) => value[key])
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function safeScreenshotRef(value: unknown, runId: string): string | undefined {
  const candidate = isRecord(value)
    ? firstDefined(value.artifactRef, value.ref, value.path, value.url)
    : value;
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 1_024) return undefined;
  if (candidate.startsWith("artifact_ref:")) {
    const parts = candidate.slice(`artifact_ref:${runId}:`.length).split(":");
    return candidate.startsWith(`artifact_ref:${runId}:`)
      && parts.length === 3
      && parts[0]!.length > 0
      && parts[1]!.length > 0
      && /^[a-f0-9]{64}$/.test(parts[2]!)
      ? candidate
      : undefined;
  }
  const url = safeHttpUrl(candidate);
  if (url) return url;
  if (
    candidate.startsWith("/")
    || candidate.includes(":")
    || candidate.includes("\\")
    || candidate.split("/").some((segment) => segment === ".." || segment === ".")
    || !/\.(png|jpe?g|webp)$/i.test(candidate)
  ) return undefined;
  return candidate;
}

function invalidBrowserEvidence(
  kind: "url" | "screenshot",
  summary: string,
  now: string,
): EvidencePacket["evidenceItems"][number] {
  return {
    kind,
    status: "invalid",
    summary,
    capturedAt: now,
    redactionApplied: true,
  };
}

function commandResults(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    isRecord(item) && Boolean(splitCommand(item.command))
  );
}

function executedCommands(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const hasStructuredCommand = value.some((item) => isRecord(item) && "command" in item);
  if (!hasStructuredCommand) return [];
  return value.map((item) => typeof item === "string"
    ? { command: item }
    : isRecord(item)
      ? item
      : {});
}

function aggregateCommandStatus(commands: Record<string, unknown>[]): "present" | "invalid" {
  return commands.length > 0 && commands.every((command) => commandStatus(command) === "present")
    ? "present"
    : "invalid";
}

function commandStatus(command: Record<string, unknown>): "present" | "invalid" {
  if (!splitCommand(command.command)) return "invalid";
  const outcome = command.status ?? command.result ?? command.outcome;
  if (
    (outcome !== undefined && valueStatus(outcome) !== "present")
    || command.ok === false
    || command.passed === false
    || (typeof command.exitCode === "number" && Number.isInteger(command.exitCode) && command.exitCode !== 0)
  ) return "invalid";
  if (valueStatus(outcome) === "present" || command.ok === true || command.passed === true || command.exitCode === 0) return "present";
  return "invalid";
}

function summarizeCommand(command: Record<string, unknown>): string {
  const rendered = splitCommand(command.command)?.join(" ") ?? "command";
  const output = typeof command.output === "string" ? command.output.trim() : "";
  return output ? `${rendered}: ${output.slice(0, 200)}` : rendered;
}

function splitCommand(value: unknown): string[] | undefined {
  const parts = typeof value === "string"
    ? value.split(/\s+/).filter(Boolean)
    : Array.isArray(value)
      ? value.filter((part): part is string => typeof part === "string" && part.length > 0)
      : [];
  return parts.length > 0 ? parts : undefined;
}

function extractCommandStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.command === "string") return item.command;
      return undefined;
    })
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function findTestCommand(commands: string[]): string | undefined {
  return commands.find((command) => /\bnpm\s+test\b|\btest\b/i.test(command));
}

function objectTestEvidence(
  artifact: Record<string, unknown>,
  commands: string[],
  now: string,
): EvidencePacket["evidenceItems"][number] | undefined {
  const testResults = artifact.testResults;
  if (Array.isArray(testResults) && testResults.length > 0) {
    const first = testResults[0];
    const firstRecord = asEvidenceRecord(first);
    return {
      kind: "test-result",
      status: testResults.every((item) => testResultItemStatus(item) === "present") ? "present" : "invalid",
      summary: typeof first === "string"
        ? first
        : typeof firstRecord.summary === "string"
          ? firstRecord.summary
          : typeof firstRecord.output === "string"
            ? firstRecord.output
            : "test results present",
      sourceRef: "artifact.testResults",
      sha256: shortHash(safeJson(testResults)),
      capturedAt: now,
      reproducibleCommand: splitCommand(firstRecord.command) ?? splitCommand(findTestCommand(commands)),
      redactionApplied: true,
    };
  }

  if (isRecord(testResults)) {
    const status = testRecordStatus(testResults);
    const summary = [
      typeof testResults.status === "string" ? `status=${testResults.status}` : undefined,
      typeof testResults.details === "string" ? testResults.details : undefined,
      ...toStringArray(testResults.outputSnippet),
    ].filter((item): item is string => typeof item === "string" && item.length > 0).join("; ");
    return {
      kind: "test-result",
      status,
      summary: summary || "test results present",
      sourceRef: "artifact.testResults",
      sha256: shortHash(safeJson(testResults)),
      capturedAt: now,
      reproducibleCommand: splitCommand(findTestCommand(commands)),
      redactionApplied: true,
    };
  }

  if (typeof testResults === "string") {
    return {
      kind: "test-result",
      status: "invalid",
      summary: `test result: ${testResults}`,
      sourceRef: "artifact.testResults",
      sha256: shortHash(testResults),
      capturedAt: now,
      reproducibleCommand: splitCommand(findTestCommand(commands)),
      redactionApplied: true,
    };
  }

  const tests = artifact.tests;
  if (Array.isArray(tests) && tests.length > 0) {
    const first = tests[0];
    const firstRecord = asEvidenceRecord(first);
    return {
      kind: "test-result",
      status: tests.every((item) => testResultItemStatus(item) === "present") ? "present" : "invalid",
      summary: typeof first === "string"
        ? first
        : typeof firstRecord.summary === "string"
          ? firstRecord.summary
          : typeof firstRecord.output === "string"
            ? firstRecord.output
            : "tests evidence present",
      sourceRef: "artifact.tests",
      sha256: shortHash(safeJson(tests)),
      capturedAt: now,
      reproducibleCommand: splitCommand(firstRecord.command) ?? splitCommand(findTestCommand(commands)),
      redactionApplied: true,
    };
  }

  const artifactEvidence = artifact.artifactEvidence;
  if (Array.isArray(artifactEvidence)) {
    const evidence = artifactEvidence.find((item) => {
      if (!isRecord(item)) return false;
      const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
      return type.includes("test") || type.includes("cli");
    });
    if (isRecord(evidence)) {
      const summary = typeof evidence.evidence === "string"
        ? evidence.evidence
        : typeof evidence.summary === "string"
          ? evidence.summary
          : "artifact evidence present";
      return {
        kind: "test-result",
        status: testRecordStatus(evidence),
        summary,
        sourceRef: "artifact.artifactEvidence",
        sha256: shortHash(safeJson(evidence)),
        capturedAt: now,
        reproducibleCommand: splitCommand(findTestCommand(commands)),
        redactionApplied: true,
      };
    }
  }

  return undefined;
}

function testRecordStatus(value: Record<string, unknown>): "present" | "invalid" {
  return resultTreeStatus(value, 0, new WeakSet()) ?? "invalid";
}

function resultTreeStatus(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): "present" | "invalid" | undefined {
  if (depth > 8) return "invalid";
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return "invalid";
    ancestors.add(value);
    let sawPresent = false;
    for (const item of value) {
      const status = resultTreeStatus(item, depth + 1, ancestors);
      if (status === "invalid") {
        ancestors.delete(value);
        return "invalid";
      }
      if (status === "present") sawPresent = true;
    }
    ancestors.delete(value);
    return sawPresent ? "present" : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (ancestors.has(value)) return "invalid";
  ancestors.add(value);

  const outcome = value.status ?? value.result ?? value.outcome ?? value.overall;
  const countStatus = statusFromCounts(value);
  if (
    (outcome !== undefined && valueStatus(outcome) !== "present")
    || value.passed === false
    || value.ok === false
    || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode) && value.exitCode !== 0)
    || countStatus === "invalid"
  ) {
    ancestors.delete(value);
    return "invalid";
  }

  let sawPresent = valueStatus(outcome) === "present"
    || value.passed === true
    || value.ok === true
    || value.exitCode === 0
    || countStatus === "present";
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const status = resultTreeStatus(child, depth + 1, ancestors);
    if (status === "invalid") {
      ancestors.delete(value);
      return "invalid";
    }
    if (status === "present") sawPresent = true;
  }
  ancestors.delete(value);
  return sawPresent ? "present" : undefined;
}

function testResultItemStatus(value: unknown): "present" | "invalid" {
  return isRecord(value) ? testRecordStatus(value) : "invalid";
}

function asEvidenceRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function valueStatus(value: unknown): "present" | "invalid" | undefined {
  if (value === true) return "present";
  if (value === false) return "invalid";
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();

  if (/\b0\s+failed\b/.test(normalized) && /(pass|passed|success|succeeded|ok)/.test(normalized)) {
    return "present";
  }
  if (["passed", "pass", "success", "succeeded", "ok", "true"].includes(normalized)) return "present";
  if ([
    "failed",
    "fail",
    "error",
    "errored",
    "blocked",
    "not-verified",
    "not_verified",
    "not-run",
    "not_run",
    "skipped",
    "failed_non_gating",
    "non-gating",
    "non_gating",
    "false",
  ].includes(normalized)) return "invalid";
  return undefined;
}

function statusFromCounts(testResults: Record<string, unknown>): "present" | "invalid" | undefined {
  const failed = numberFromObject(testResults, ["failed", "failCount"]);
  const passed = numberFromObject(testResults, ["passed", "passCount"]);
  if ((failed ?? 0) > 0) return "invalid";
  if ((passed ?? 0) > 0) return "present";
  return undefined;
}

function numberFromObject(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function extractPathLikeValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (isRecord(item) && typeof item.path === "string") return item.path;
      return undefined;
    })
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function extractArtifactRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const refs: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      refs.push(item);
      continue;
    }
    if (!isRecord(item)) continue;

    let captured = false;
    for (const key of ["artifactRef", "id", "ref", "resourceKey", "requirement", "title", "summary", "path", "name"]) {
      const candidate = item[key];
      if (typeof candidate === "string" && candidate.length > 0) {
        refs.push(candidate);
        captured = true;
        break;
      }
    }

    if (!captured) {
      refs.push(`artifact-object-${shortHash(safeJson(item))}`);
    }
  }
  return refs;
}

function missingEvidence(kind: EvidenceKind, now: string): EvidencePacket["evidenceItems"][number] {
  return {
    kind,
    status: "missing",
    summary: `Missing required ${kind} evidence`,
    capturedAt: now,
    redactionApplied: true,
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === "bigint") return child.toString();
    if (!child || typeof child !== "object") return child;
    if (seen.has(child)) return "[Circular]";
    seen.add(child);
    return child;
  }) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

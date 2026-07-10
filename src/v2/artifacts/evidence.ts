import { createHash } from "node:crypto";
import {
  EVIDENCE_PACKET_SCHEMA_VERSION,
  type EvidenceKind,
  type EvidencePacket,
} from "./types.ts";

export type BuildEvidencePacketInput = {
  runId: string;
  taskId: string;
  artifactRef: string;
  requiredEvidenceKinds: EvidenceKind[];
  artifact: Record<string, unknown>;
  identityScope?: string;
  now?: string;
};

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
    ].join(":"))}`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
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
  return safeScreenshotRef(firstDefined(
    firstArrayItem(browserEvidence.screenshots),
    browserEvidence.screenshot,
    firstArrayItem(artifact.screenshots),
    artifact.screenshot,
  ), runId);
}

function evidenceByKind(
  artifact: Record<string, unknown>,
  now: string,
  runId: string,
): Map<EvidenceKind, EvidencePacket["evidenceItems"][number]> {
  const byKind = new Map<EvidenceKind, EvidencePacket["evidenceItems"][number]>();

  const commandResults = firstCommandResult(artifact.testResults)
    ?? firstCommandResult((artifact.artifactEvidence as { testResults?: unknown } | undefined)?.testResults)
    ?? firstCommandResult(artifact.tests);
  const commandStrings = [
    ...extractCommandStrings(artifact.commandsRun),
    ...extractCommandStrings(artifact.commandsToRun),
  ];

  if (commandResults) {
    const status = commandStatus(commandResults);
    const summary = summarizeCommand(commandResults);
    const reproducibleCommand = splitCommand(commandResults.command) ?? splitCommand(findTestCommand(commandStrings));
    byKind.set("test-result", {
      kind: "test-result",
      status,
      summary,
      sourceRef: "artifact.testResults",
      sha256: shortHash(JSON.stringify(commandResults)),
      capturedAt: now,
      reproducibleCommand,
      redactionApplied: true,
    });
    byKind.set("command-output", {
      kind: "command-output",
      status,
      summary,
      sourceRef: "artifact.testResults",
      sha256: shortHash(JSON.stringify(commandResults)),
      capturedAt: now,
      reproducibleCommand,
      redactionApplied: true,
    });
  } else {
    const testEvidence = objectTestEvidence(artifact, commandStrings, now);
    if (testEvidence) {
      byKind.set("test-result", testEvidence);
    }
    const firstCommand = commandStrings[0];
    if (firstCommand) {
      byKind.set("command-output", {
        kind: "command-output",
        status: "present",
        summary: firstCommand,
        sourceRef: Array.isArray(artifact.commandsRun) ? "artifact.commandsRun" : "artifact.commandsToRun",
        sha256: shortHash(firstCommand),
        capturedAt: now,
        reproducibleCommand: splitCommand(firstCommand),
        redactionApplied: true,
      });
    }
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

  return byKind;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function firstArrayItem(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
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

function firstCommandResult(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is Record<string, unknown> =>
    isRecord(item) && typeof item.command === "string" && item.command.trim().length > 0
  );
}

function commandStatus(command: Record<string, unknown>): "present" | "invalid" {
  if (typeof command.command !== "string" || command.command.trim().length === 0) return "invalid";
  const outcome = command.status ?? command.result ?? command.outcome;
  if (
    (typeof outcome === "string" && /^(fail(ed)?|error|errored)$/i.test(outcome.trim()))
    || command.ok === false
    || command.passed === false
    || (typeof command.exitCode === "number" && Number.isInteger(command.exitCode) && command.exitCode !== 0)
  ) return "invalid";
  if (typeof outcome === "string" && /^(pass(ed)?|success|succeeded|ok)$/i.test(outcome.trim())) return "present";
  if (command.ok === true || command.passed === true || command.exitCode === 0) return "present";
  return "invalid";
}

function summarizeCommand(command: Record<string, unknown>): string {
  const rendered = typeof command.command === "string" ? command.command : "command";
  const output = typeof command.output === "string" ? command.output.trim() : "";
  return output ? `${rendered}: ${output.slice(0, 200)}` : rendered;
}

function splitCommand(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.split(/\s+/).filter(Boolean);
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
  if (Array.isArray(testResults)) {
    const objectEntry = testResults.find((item) => isRecord(item));
    if (isRecord(objectEntry)) {
      const status = valueStatus(objectEntry.status ?? objectEntry.result ?? objectEntry.outcome)
        ?? (objectEntry.passed === true || objectEntry.ok === true ? "present" : undefined)
        ?? statusFromCounts(objectEntry)
        ?? nestedStatusFromResultTree(objectEntry)
        ?? statusFromTextValues(objectEntry)
        ?? "invalid";
      const summary = typeof objectEntry.summary === "string"
        ? objectEntry.summary
        : typeof objectEntry.output === "string"
          ? objectEntry.output
          : "test results present";
      return {
        kind: "test-result",
        status,
        summary,
        sourceRef: "artifact.testResults",
        sha256: shortHash(JSON.stringify(objectEntry)),
        capturedAt: now,
        reproducibleCommand: splitCommand(findTestCommand(commands)),
        redactionApplied: true,
      };
    }

    const stringEntry = testResults.find((item): item is string => typeof item === "string" && item.length > 0);
    if (stringEntry) {
      const status = valueStatus(stringEntry) ?? (/(pass|success|ok)/i.test(stringEntry) ? "present" : "invalid");
      return {
        kind: "test-result",
        status,
        summary: stringEntry,
        sourceRef: "artifact.testResults",
        sha256: shortHash(stringEntry),
        capturedAt: now,
        reproducibleCommand: splitCommand(findTestCommand(commands)),
        redactionApplied: true,
      };
    }
  }

  if (isRecord(testResults)) {
    const status = valueStatus(testResults.status ?? testResults.result ?? testResults.outcome ?? testResults.overall)
      ?? (testResults.passed === true || testResults.ok === true ? "present" : undefined)
      ?? statusFromCounts(testResults)
      ?? nestedStatusFromResultTree(testResults)
      ?? statusFromTextValues(testResults)
      ?? "invalid";
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
      sha256: shortHash(JSON.stringify(testResults)),
      capturedAt: now,
      reproducibleCommand: splitCommand(findTestCommand(commands)),
      redactionApplied: true,
    };
  }

  if (typeof testResults === "string") {
    const status = valueStatus(testResults) ?? "invalid";
    return {
      kind: "test-result",
      status,
      summary: `test result: ${testResults}`,
      sourceRef: "artifact.testResults",
      sha256: shortHash(testResults),
      capturedAt: now,
      reproducibleCommand: splitCommand(findTestCommand(commands)),
      redactionApplied: true,
    };
  }

  const tests = artifact.tests;
  if (Array.isArray(tests)) {
    const objectEntry = tests.find((item) => isRecord(item));
    if (isRecord(objectEntry)) {
      const status = valueStatus(objectEntry.status ?? objectEntry.result ?? objectEntry.outcome)
        ?? (objectEntry.passed === true || objectEntry.ok === true ? "present" : undefined)
        ?? statusFromCounts(objectEntry)
        ?? nestedStatusFromResultTree(objectEntry)
        ?? statusFromTextValues(objectEntry)
        ?? "invalid";
      const summary = typeof objectEntry.summary === "string"
        ? objectEntry.summary
        : typeof objectEntry.output === "string"
          ? objectEntry.output
          : "tests evidence present";
      return {
        kind: "test-result",
        status,
        summary,
        sourceRef: "artifact.tests",
        sha256: shortHash(JSON.stringify(objectEntry)),
        capturedAt: now,
        reproducibleCommand: splitCommand(findTestCommand(commands)),
        redactionApplied: true,
      };
    }

    const stringEntry = tests.find((item): item is string => typeof item === "string" && item.length > 0);
    if (stringEntry) {
      const status = valueStatus(stringEntry) ?? (/(pass|success|ok)/i.test(stringEntry) ? "present" : "invalid");
      return {
        kind: "test-result",
        status,
        summary: stringEntry,
        sourceRef: "artifact.tests",
        sha256: shortHash(stringEntry),
        capturedAt: now,
        reproducibleCommand: splitCommand(findTestCommand(commands)),
        redactionApplied: true,
      };
    }
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
        status: "present",
        summary,
        sourceRef: "artifact.artifactEvidence",
        sha256: shortHash(JSON.stringify(evidence)),
        capturedAt: now,
        reproducibleCommand: splitCommand(findTestCommand(commands)),
        redactionApplied: true,
      };
    }
  }

  return undefined;
}

function valueStatus(value: unknown): "present" | "invalid" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();

  if (/\b0\s+failed\b/.test(normalized) && /(pass|passed|success|succeeded|ok)/.test(normalized)) {
    return "present";
  }
  if ([
    "passed",
    "pass",
    "success",
    "succeeded",
    "ok",
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
    "pass_with_environment_gap",
  ].some((token) => normalized.includes(token))) {
    return "present";
  }
  return undefined;
}

function statusFromCounts(testResults: Record<string, unknown>): "present" | "invalid" | undefined {
  const failed = numberFromObject(testResults, ["failed", "failCount"]);
  const passed = numberFromObject(testResults, ["passed", "passCount"]);
  if (typeof failed === "number") {
    if (failed > 0) return "present";
    if ((passed ?? 0) > 0) return "present";
  }
  const automated = testResults.automated;
  if (isRecord(automated)) {
    const automatedFailed = numberFromObject(automated, ["failed", "failCount"]);
    const automatedPassed = numberFromObject(automated, ["passed", "passCount"]);
    if (typeof automatedFailed === "number") {
      if (automatedFailed > 0) return "present";
      if ((automatedPassed ?? 0) > 0) return "present";
    }
  }
  return undefined;
}

function numberFromObject(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function statusFromTextValues(value: unknown): "present" | "invalid" | undefined {
  const samples = collectTextSamples(value, 0, []);
  if (samples.length === 0) return undefined;

  const hasPositive = samples.some((sample) => /(pass|passed|success|succeeded|ok)/i.test(sample));
  const hasOutcome = samples.some((sample) => /(\bfail(ed)?\b|\berror\b|\bassertion\b|\bblocked\b|\bnot[-_ ]?verified\b|\bskipped\b)/i.test(sample));

  if (hasPositive || hasOutcome) return "present";
  return undefined;
}

function collectTextSamples(value: unknown, depth: number, output: string[]): string[] {
  if (depth > 4) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextSamples(item, depth + 1, output);
    return output;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) collectTextSamples(nested, depth + 1, output);
  }
  return output;
}

function nestedStatusFromResultTree(value: unknown, depth = 0): "present" | "invalid" | undefined {
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    let sawPresent = false;
    for (const item of value) {
      const nested = nestedStatusFromResultTree(item, depth + 1);
      if (nested === "invalid") return "invalid";
      if (nested === "present") sawPresent = true;
    }
    return sawPresent ? "present" : undefined;
  }
  if (!isRecord(value)) return undefined;

  let sawPresent = false;
  for (const key of ["status", "result", "overall", "outcome"]) {
    const direct = valueStatus(value[key]);
    if (direct === "invalid") return "invalid";
    if (direct === "present") sawPresent = true;
  }

  for (const nested of Object.values(value)) {
    const status = nestedStatusFromResultTree(nested, depth + 1);
    if (status === "invalid") return "invalid";
    if (status === "present") sawPresent = true;
  }
  return sawPresent ? "present" : undefined;
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
      refs.push(`artifact-object-${shortHash(JSON.stringify(item))}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

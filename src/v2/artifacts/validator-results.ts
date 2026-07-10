import type { ArtifactContract } from "../design-library/runtime-types.ts";
import type { EvidencePacket, ValidatorResult } from "./types.ts";
import { VALIDATOR_RESULT_SCHEMA_VERSION } from "./types.ts";

type ValidatorMessage = {
  severity: "error";
  path: string;
  text: string;
};

const ALLOWED_TEST_STATUSES = new Set([
  "passed",
  "failed",
  "failed_non_gating",
  "blocked",
  "not-verified",
  "not-run",
  "skipped",
  "pass_with_environment_gap",
]);

const FAILURE_LIKE_TEST_STATUSES = new Set([
  "failed",
  "blocked",
  "not-verified",
  "not-run",
]);

const ALLOWED_GATING = new Set(["blocking", "non-gating"]);

export function schemaValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contract: ArtifactContract;
  artifact: Record<string, unknown>;
  now?: string;
}): ValidatorResult {
  const missingFieldMessages = input.contract.requiredFields
    .filter((field) => !hasRequiredValue(input.artifact[field]))
    .map((field) => ({
      severity: "error" as const,
      path: field,
      text: `Missing required field ${field}`,
    }));
  const semanticMessages = contractSemanticMessages(input.contract, input.artifact);
  const messages = [...missingFieldMessages, ...semanticMessages];

  return {
    schemaVersion: VALIDATOR_RESULT_SCHEMA_VERSION,
    id: `validator-${input.runId}-${input.taskId}-${input.contract.id}-schema`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contract.id}:schema`,
    validatorType: "schema",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contract.id],
    checkedEvidenceRefs: [],
    messages,
    repairHint: messages.length === 0
      ? undefined
      : `Return artifact fields: ${input.contract.requiredFields.join(", ")}`,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function evidenceValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contractRef: string;
  evidence: EvidencePacket;
  now?: string;
}): ValidatorResult {
  const missingMessages = input.evidence.completeness.missingKinds.map((kind) => ({
    severity: "error" as const,
    path: `evidence.${kind}`,
    text: `Missing required ${kind} evidence`,
  }));
  const invalidMessages = input.evidence.evidenceItems
    .filter((item) => item.status === "invalid" || item.status === "stale")
    .map((item) => ({
      severity: "error" as const,
      path: `evidence.${item.kind}`,
      text: `Invalid ${item.kind} evidence: ${item.summary}`,
    }));
  const messages = [...missingMessages, ...invalidMessages];
  return {
    schemaVersion: VALIDATOR_RESULT_SCHEMA_VERSION,
    id: `validator:${input.evidence.id}`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contractRef}:evidence`,
    validatorType: "custom",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contractRef],
    checkedEvidenceRefs: [input.evidence.id],
    messages,
    repairHint: messages.length === 0
      ? undefined
      : "Provide required evidence in artifactEvidence, testResults, filesChanged, or commandsRun.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function policyValidatorResult(input: {
  runId: string;
  taskId: string;
  artifactRef: string;
  contractRef: string;
  artifact: Record<string, unknown>;
  now?: string;
}): ValidatorResult {
  const messages = policyViolationMessages(JSON.stringify(input.artifact));
  return {
    schemaVersion: VALIDATOR_RESULT_SCHEMA_VERSION,
    id: `validator-${input.runId}-${input.taskId}-${input.contractRef}-policy`,
    runId: input.runId,
    taskId: input.taskId,
    artifactRef: input.artifactRef,
    validatorRef: `${input.contractRef}:policy`,
    validatorType: "policy",
    verdict: messages.length === 0 ? "passed" : "failed",
    blocking: true,
    checkedContractRefs: [input.contractRef],
    checkedEvidenceRefs: [],
    messages,
    repairHint: messages.length === 0
      ? undefined
      : "Remove secret-shaped values and raw transcripts from artifact payload.",
    createdAt: input.now ?? new Date().toISOString(),
  };
}

function contractSemanticMessages(contract: ArtifactContract, artifact: Record<string, unknown>): ValidatorMessage[] {
  switch (contract.id) {
    case "implementation_report":
      return [
        ...commandEntriesMessages(artifact.commandsRun, "commandsRun"),
        ...testResultsMessages(artifact.testResults, "testResults", { requireGatingOnFailure: false, requireCheckId: false }),
      ];
    case "verification_report":
      return [
        ...commandEntriesMessages(artifact.commandsRun, "commandsRun"),
        ...testResultsMessages(artifact.testResults, "testResults", { requireGatingOnFailure: true, requireCheckId: true }),
      ];
    case "completion_report":
      return [
        ...testResultsMessages(artifact.tests, "tests", { requireGatingOnFailure: false, requireCheckId: false }),
      ];
    default:
      return [];
  }
}

function commandEntriesMessages(value: unknown, path: string): ValidatorMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [{ severity: "error", path, text: `${path} must be an array` }];
  }
  if (value.length === 0) {
    return [{ severity: "error", path, text: `${path} must not be empty` }];
  }
  const messages: ValidatorMessage[] = [];
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry === "string") {
      if (entry.trim().length === 0) {
        messages.push({ severity: "error", path: entryPath, text: "command entry must not be empty" });
      }
      return;
    }
    if (!isRecord(entry)) {
      messages.push({ severity: "error", path: entryPath, text: "command entry must be string or object" });
      return;
    }
    if (typeof entry.command !== "string" || entry.command.trim().length === 0) {
      messages.push({ severity: "error", path: `${entryPath}.command`, text: "object command entry requires command string" });
    }
    if (entry.exitCode !== undefined && (typeof entry.exitCode !== "number" || !Number.isFinite(entry.exitCode))) {
      messages.push({ severity: "error", path: `${entryPath}.exitCode`, text: "exitCode must be a finite number when provided" });
    }
  });
  return messages;
}

function testResultsMessages(
  value: unknown,
  path: string,
  options: { requireGatingOnFailure: boolean; requireCheckId: boolean },
): ValidatorMessage[] {
  if (value === undefined) return [];
  const entries = collectTestResultEntries(value, path);
  if (entries.messages.length > 0) return entries.messages;
  if (entries.items.length === 0) {
    return [{ severity: "error", path, text: `${path} must include at least one test entry` }];
  }

  const messages: ValidatorMessage[] = [];
  for (const entry of entries.items) {
    const status = inferTestStatus(entry.value);
    if (!status) {
      messages.push({
        severity: "error",
        path: `${entry.path}.status`,
        text: `Unable to infer status; allowed values: ${[...ALLOWED_TEST_STATUSES].join(", ")}`,
      });
      continue;
    }

    if (!ALLOWED_TEST_STATUSES.has(status)) {
      messages.push({
        severity: "error",
        path: `${entry.path}.status`,
        text: `Unsupported status ${status}; allowed: ${[...ALLOWED_TEST_STATUSES].join(", ")}`,
      });
    }

    if (options.requireCheckId && isRecord(entry.value)) {
      if (typeof entry.value.checkId !== "string" || entry.value.checkId.trim().length === 0) {
        messages.push({ severity: "error", path: `${entry.path}.checkId`, text: "checkId is required for checker testResults entries" });
      }
    }

    if (isRecord(entry.value)) {
      const details = extractDetails(entry.value);
      if (!details) {
        messages.push({
          severity: "error",
          path: `${entry.path}.details`,
          text: "details/evidence text is required for each testResults entry",
        });
      }

      if (options.requireGatingOnFailure && FAILURE_LIKE_TEST_STATUSES.has(status)) {
        const gating = inferGating(entry.value);
        if (!gating) {
          messages.push({
            severity: "error",
            path: `${entry.path}.gating`,
            text: `gating is required for failure-like status ${status}; allowed: ${[...ALLOWED_GATING].join(", ")}`,
          });
        } else if (!ALLOWED_GATING.has(gating)) {
          messages.push({
            severity: "error",
            path: `${entry.path}.gating`,
            text: `Unsupported gating ${gating}; allowed: ${[...ALLOWED_GATING].join(", ")}`,
          });
        }
      }
    }
  }

  return messages;
}

function collectTestResultEntries(value: unknown, path: string): {
  items: Array<{ path: string; value: unknown }>;
  messages: ValidatorMessage[];
} {
  if (Array.isArray(value)) {
    return {
      items: value.map((entry, index) => ({ path: `${path}[${index}]`, value: entry })),
      messages: [],
    };
  }

  if (!isRecord(value)) {
    return {
      items: [],
      messages: [{ severity: "error", path, text: `${path} must be an array or object map` }],
    };
  }

  if (looksLikeSingleTestEntry(value)) {
    return { items: [{ path, value }], messages: [] };
  }

  return {
    items: Object.entries(value).map(([key, entry]) => ({ path: `${path}.${key}`, value: entry })),
    messages: [],
  };
}

function looksLikeSingleTestEntry(value: Record<string, unknown>): boolean {
  return ["status", "result", "outcome", "passed", "ok", "details", "output", "evidence", "checkId"]
    .some((key) => key in value);
}

function inferTestStatus(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeStatus(value);
  if (!isRecord(value)) return undefined;

  const direct = [value.status, value.result, value.outcome]
    .map((candidate) => normalizeStatus(candidate))
    .find((candidate): candidate is string => typeof candidate === "string");
  if (direct) return direct;

  if (value.passed === true || value.ok === true) return "passed";
  if (value.passed === false || value.ok === false) return "failed";
  if (typeof value.exitCode === "number") return value.exitCode === 0 ? "passed" : "failed";

  const details = extractDetails(value);
  if (!details) return undefined;
  return normalizeStatus(details);
}

function normalizeStatus(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/[_\s]+/g, "-").trim();
  if (normalized.length === 0) return undefined;
  if (/\b0\s+failed\b/.test(normalized) && /(pass|success|ok)/.test(normalized)) return "passed";
  if (/(pass|passed|success|succeeded|ok)/.test(normalized)) return "passed";
  if (/failed[-_ ]non[-_ ]gating|non[-_ ]gating/.test(normalized)) return "failed_non_gating";
  if (/(fail|failed|error|errored|assertion)/.test(normalized)) return "failed";
  if (/blocked/.test(normalized)) return "blocked";
  if (/not[-_ ]verified/.test(normalized)) return "not-verified";
  if (/not[-_ ]run/.test(normalized)) return "not-run";
  if (/skipped/.test(normalized)) return "skipped";
  if (/pass[-_ ]with[-_ ]environment[-_ ]gap/.test(normalized)) return "pass_with_environment_gap";
  return ALLOWED_TEST_STATUSES.has(normalized) ? normalized : undefined;
}

function inferGating(value: Record<string, unknown>): string | undefined {
  const raw = value.gating ?? value.gate;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.toLowerCase().replace(/[_\s]+/g, "-").trim();
  if (normalized === "non-blocking" || normalized === "nonblocking") return "non-gating";
  return normalized;
}

function extractDetails(value: Record<string, unknown>): string | undefined {
  const candidates = [value.details, value.evidence, value.output, value.summary, value.message, value.result];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function hasRequiredValue(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  return value !== undefined && value !== null && value !== "";
}

function policyViolationMessages(serializedArtifact: string): ValidatorResult["messages"] {
  const tokenLikePattern = /(?:^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,})(?=$|[^A-Za-z0-9_])/;
  const privateKeyPattern = /-----BEGIN [A-Z ]+PRIVATE KEY-----/;
  if (tokenLikePattern.test(serializedArtifact) || privateKeyPattern.test(serializedArtifact)) {
    return [{
      severity: "error",
      path: "artifact",
      text: "Artifact payload contains token-shaped or private-key-shaped value",
    }];
  }
  if (serializedArtifact.length > 50_000) {
    return [{
      severity: "error",
      path: "artifact",
      text: "Artifact payload exceeds 50000 byte compact history limit",
    }];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

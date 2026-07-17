import type { LibraryImportCandidate, LibraryImportCandidateKind } from "./library-candidate-extractor.ts";
import { EVIDENCE_KINDS } from "../../artifacts/types.ts";
import { unsupportedPiRuntimeToolNames } from "../../harness/pi-runtime-tools.ts";

export const LIBRARY_VALIDATION_EVIDENCE_KINDS = EVIDENCE_KINDS;

export const LIBRARY_VERIFICATION_MODES = [
  "deterministic",
  "browser_interaction",
  "semantic_review",
  "human_approval",
] as const;

export const REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF = "southstar.requirement_evaluator_result.v2" as const;

const EVIDENCE_KIND_SET = new Set<string>(LIBRARY_VALIDATION_EVIDENCE_KINDS);
const VERIFICATION_MODES = new Set<string>(LIBRARY_VERIFICATION_MODES);

export const LIBRARY_IMPORT_CANDIDATE_COMMON_FIELDS = [
  "objectKey", "kind", "title", "scope", "domain", "displayDomain", "classificationReason", "sourcePath",
  "selectedByDefault", "confidence", "description",
] as const;

const LIBRARY_FILE_CONTRACT_COMMON_FIELDS = [
  "objectKey", "kind", "title", "scope", "description", "semanticTags",
] as const;

export type LibraryContractSchemaSurface = "import_candidate" | "library_file";

export const LIBRARY_IMPORT_CANDIDATE_KIND_FIELDS: Record<LibraryImportCandidateKind, readonly string[]> = {
  agent: [],
  skill: [],
  mcp: [],
  tool: ["operations", "runtimeToolNames"],
  domain: ["aliases"],
  capability: ["requiredOperations"],
  artifact: [
    "artifactType", "mediaTypes", "evidenceKinds", "validationRules", "schemaRef", "requiredFields",
    "provenanceRequirements", "semanticTags",
  ],
  evaluator: [
    "validatesArtifactRefs", "requiredInputs", "evidenceKinds", "verificationModes", "verificationProcedures",
    "independencePolicy", "resultSchemaRef", "failureClassifications", "semanticTags",
  ],
};

export function assertLibraryImportCandidateExactKeys(
  record: Record<string, unknown>,
  kind: LibraryImportCandidateKind,
  objectKey: string,
  surface: LibraryContractSchemaSurface = "import_candidate",
): void {
  const commonFields = surface === "library_file"
    ? LIBRARY_FILE_CONTRACT_COMMON_FIELDS
    : LIBRARY_IMPORT_CANDIDATE_COMMON_FIELDS;
  const allowed = new Set([...commonFields, ...LIBRARY_IMPORT_CANDIDATE_KIND_FIELDS[kind]]);
  const unsupported = Object.keys(record).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`library import ${kind} candidate ${objectKey} contains unsupported fields: ${unsupported.join(", ")}`);
  }
}

export function normalizeLibraryImportCandidateKindFields(
  record: Record<string, unknown>,
  kind: LibraryImportCandidateKind,
  objectKey: string,
  options: { surface?: LibraryContractSchemaSurface } = {},
): Partial<LibraryImportCandidate> {
  assertLibraryImportCandidateExactKeys(record, kind, objectKey, options.surface);
  const description = optionalNonEmptyString(record.description, `candidates.${objectKey}.description`);
  if (kind === "agent" || kind === "skill" || kind === "mcp") {
    return description ? { description } : {};
  }
  if (kind === "tool") {
    const runtimeToolNames = strictStringArray(record.runtimeToolNames, `candidates.${objectKey}.runtimeToolNames`);
    const unsupportedRuntimeToolNames = unsupportedPiRuntimeToolNames(runtimeToolNames);
    if (unsupportedRuntimeToolNames.length > 0) {
      throw new Error(`library import tool ${objectKey} has unsupported Pi runtimeToolNames: ${unsupportedRuntimeToolNames.join(", ")}`);
    }
    return {
      ...(description ? { description } : {}),
      operations: strictStringArray(record.operations, `candidates.${objectKey}.operations`),
      runtimeToolNames,
    };
  }
  if (kind === "domain") {
    return {
      ...(description ? { description } : {}),
      ...(record.aliases === undefined ? {} : { aliases: strictStringArray(record.aliases, `candidates.${objectKey}.aliases`) }),
    };
  }
  if (kind === "capability") {
    return {
      description: requiredNonEmptyString(record.description, `candidates.${objectKey}.description`),
      requiredOperations: strictStringArray(record.requiredOperations, `candidates.${objectKey}.requiredOperations`),
    };
  }
  if (kind === "artifact") {
    const evidenceKinds = strictEvidenceKinds(record.evidenceKinds, `candidates.${objectKey}.evidenceKinds`);
    const semanticTags = optionalStringArray(record.semanticTags, `candidates.${objectKey}.semanticTags`);
    return {
      ...(description ? { description } : {}),
      ...(semanticTags ? { semanticTags } : {}),
      artifactType: requiredNonEmptyString(record.artifactType, `candidates.${objectKey}.artifactType`),
      mediaTypes: strictStringArray(record.mediaTypes, `candidates.${objectKey}.mediaTypes`),
      evidenceKinds,
      validationRules: strictStringArray(record.validationRules, `candidates.${objectKey}.validationRules`),
      schemaRef: requiredNonEmptyString(record.schemaRef, `candidates.${objectKey}.schemaRef`),
      requiredFields: strictStringArray(record.requiredFields, `candidates.${objectKey}.requiredFields`),
      provenanceRequirements: strictStringArray(record.provenanceRequirements, `candidates.${objectKey}.provenanceRequirements`),
    };
  }

  const verificationModes = strictVerificationModes(record.verificationModes, `candidates.${objectKey}.verificationModes`);
  const evidenceKinds = strictEvidenceKinds(record.evidenceKinds, `candidates.${objectKey}.evidenceKinds`);
  const semanticTags = optionalStringArray(record.semanticTags, `candidates.${objectKey}.semanticTags`);
  const procedures = normalizeVerificationProcedures(record.verificationProcedures, objectKey, verificationModes, evidenceKinds);
  const validatesArtifactRefs = strictStringArray(record.validatesArtifactRefs, `candidates.${objectKey}.validatesArtifactRefs`);
  if (validatesArtifactRefs.some((ref) => !ref.startsWith("artifact."))) {
    throw new Error(`library import evaluator ${objectKey} has invalid validatesArtifactRefs`);
  }
  const resultSchemaRef = requiredNonEmptyString(record.resultSchemaRef, `candidates.${objectKey}.resultSchemaRef`);
  if (resultSchemaRef !== REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF) {
    throw new Error(`library import evaluator ${objectKey} resultSchemaRef must be ${REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF}`);
  }
  if (record.independencePolicy !== "independent") {
    throw new Error(`library import evaluator ${objectKey} independencePolicy must be independent`);
  }
  return {
    ...(description ? { description } : {}),
    ...(semanticTags ? { semanticTags } : {}),
    validatesArtifactRefs,
    requiredInputs: strictStringArray(record.requiredInputs, `candidates.${objectKey}.requiredInputs`),
    evidenceKinds,
    verificationModes,
    verificationProcedures: procedures,
    independencePolicy: "independent",
    resultSchemaRef: REQUIREMENT_EVALUATOR_RESULT_SCHEMA_REF,
    failureClassifications: strictStringArray(record.failureClassifications, `candidates.${objectKey}.failureClassifications`),
  };
}

export function strictStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${label} must be a non-empty array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function strictEvidenceKinds(value: unknown, label: string): string[] {
  const values = strictStringArray(value, label);
  if (values.some((item) => !EVIDENCE_KIND_SET.has(item))) throw new Error(`${label} contains unsupported evidenceKinds`);
  return values;
}

function strictVerificationModes(
  value: unknown,
  label: string,
): NonNullable<LibraryImportCandidate["verificationModes"]> {
  const values = strictStringArray(value, label);
  if (values.some((item) => !VERIFICATION_MODES.has(item))) throw new Error(`${label} contains unsupported verificationModes`);
  return values as NonNullable<LibraryImportCandidate["verificationModes"]>;
}

function normalizeVerificationProcedures(
  value: unknown,
  objectKey: string,
  verificationModes: NonNullable<LibraryImportCandidate["verificationModes"]>,
  evaluatorEvidenceKinds: string[],
): NonNullable<LibraryImportCandidate["verificationProcedures"]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`candidates.${objectKey}.verificationProcedures must be a non-empty array`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`candidates.${objectKey}.verificationProcedures.${index} must be an object`);
    }
    const procedure = item as Record<string, unknown>;
    const unsupported = Object.keys(procedure).filter((key) => !["id", "checkKind", "instruction", "allowedEvidenceKinds"].includes(key));
    if (unsupported.length > 0) {
      throw new Error(`candidates.${objectKey}.verificationProcedures.${index} contains unsupported fields: ${unsupported.join(", ")}`);
    }
    const id = requiredNonEmptyString(procedure.id, `candidates.${objectKey}.verificationProcedures.${index}.id`);
    if (seen.has(id)) throw new Error(`library import evaluator ${objectKey} has duplicate verification procedure id: ${id}`);
    seen.add(id);
    const checkKind = requiredNonEmptyString(procedure.checkKind, `candidates.${objectKey}.verificationProcedures.${index}.checkKind`);
    if (!verificationModes.includes(checkKind as never)) {
      throw new Error(`library import evaluator ${objectKey} procedure ${id} is not declared in verificationModes`);
    }
    const instruction = requiredNonEmptyString(procedure.instruction, `candidates.${objectKey}.verificationProcedures.${index}.instruction`);
    const allowedEvidenceKinds = strictEvidenceKinds(
      procedure.allowedEvidenceKinds,
      `candidates.${objectKey}.verificationProcedures.${index}.allowedEvidenceKinds`,
    );
    if (allowedEvidenceKinds.some((kind) => !evaluatorEvidenceKinds.includes(kind))) {
      throw new Error(`library import evaluator ${objectKey} procedure ${id} contains evidence not declared by the evaluator`);
    }
    return {
      id,
      checkKind: checkKind as NonNullable<LibraryImportCandidate["verificationProcedures"]>[number]["checkKind"],
      instruction,
      allowedEvidenceKinds,
    };
  });
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredNonEmptyString(value, label);
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  return value === undefined ? undefined : strictStringArray(value, label);
}

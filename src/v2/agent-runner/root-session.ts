import type { SkillFieldGuidance, SkillRepairGuidance } from "../design-library/types.ts";

export type ArtifactRepairContext = {
  contractId: string;
  fieldGuidance: Record<string, SkillFieldGuidance>;
  repairGuidance?: SkillRepairGuidance;
};

export type ArtifactGateInput = {
  artifact: Record<string, unknown>;
  requiredFields: string[];
  attempt: number;
  maxRepairAttempts: number;
  repairContext?: ArtifactRepairContext;
};

export type ArtifactGateResult = {
  ok: boolean;
  missingFields: string[];
  decision: "pass" | "repair" | "fail";
  repairInstruction?: string;
  normalizedArtifact: Record<string, unknown>;
};

export function evaluateArtifactGate(input: ArtifactGateInput): ArtifactGateResult {
  const normalizedArtifact = normalizeArtifactForRequiredFields(input.artifact, input.requiredFields);
  const missingFields = input.requiredFields.filter((field) => !hasRequiredField(normalizedArtifact, field));
  if (missingFields.length === 0) {
    return { ok: true, missingFields: [], decision: "pass", normalizedArtifact };
  }
  if (input.attempt >= input.maxRepairAttempts) {
    return { ok: false, missingFields, decision: "fail", normalizedArtifact };
  }
  return {
    ok: false,
    missingFields,
    decision: "repair",
    repairInstruction: buildRepairInstruction({
      missingFields,
      attempt: input.attempt + 1,
      maxAttempts: input.maxRepairAttempts,
      repairContext: input.repairContext,
    }),
    normalizedArtifact,
  };
}

function normalizeArtifactForRequiredFields(
  artifact: Record<string, unknown>,
  requiredFields: string[],
): Record<string, unknown> {
  if (requiredFields.length === 0) return artifact;
  if (requiredFields.some((field) => hasRequiredField(artifact, field))) return artifact;
  for (const candidate of Object.values(artifact)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = candidate as Record<string, unknown>;
    if (requiredFields.some((field) => hasRequiredField(nested, field))) {
      return nested;
    }
  }
  return artifact;
}

/**
 * Required-field contracts may describe repeated evidence records with paths
 * such as `evidenceItems[].kind`. Validate the path against every item instead
 * of treating the bracketed path as a literal object key.
 */
function hasRequiredField(value: unknown, field: string): boolean {
  const segments = field.split(".").filter(Boolean);
  if (segments.length === 0) return false;
  return hasRequiredFieldAt(value, segments, 0);
}

function hasRequiredFieldAt(value: unknown, segments: string[], index: number): boolean {
  if (index >= segments.length) return hasValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const segment = segments[index]!;
  const repeated = segment.endsWith("[]");
  const key = repeated ? segment.slice(0, -2) : segment;
  const child = (value as Record<string, unknown>)[key];
  if (repeated) {
    if (!Array.isArray(child) || child.length === 0) return false;
    return child.every((item) => hasRequiredFieldAt(item, segments, index + 1));
  }
  if (index === segments.length - 1) return hasValue(child);
  return hasRequiredFieldAt(child, segments, index + 1);
}

function buildRepairInstruction(input: {
  missingFields: string[];
  attempt: number;
  maxAttempts: number;
  repairContext?: ArtifactRepairContext;
}): string {
  const fallback = [
    `Artifact is missing required fields: ${input.missingFields.join(", ")}.`,
    "Re-read your skill instructions, regenerate the complete artifact, and self-validate before submitting.",
  ].join(" ");

  const repairGuidance = input.repairContext?.repairGuidance;
  if (!repairGuidance) return fallback;

  const fieldInstructions = input.missingFields
    .map((field) => {
      const guidance = input.repairContext?.fieldGuidance[field];
      if (!guidance) return `- ${field} -> check artifact contract and skill instructions`;
      return repairGuidance.fieldReferenceFormat
        .replaceAll("{field}", field)
        .replaceAll("{sectionId}", guidance.sectionId)
        .replaceAll("{description}", guidance.description);
    })
    .join("\n");

  return repairGuidance.template
    .replaceAll("{attempt}", String(input.attempt))
    .replaceAll("{maxAttempts}", String(input.maxAttempts))
    .replaceAll("{missingFieldsList}", input.missingFields.join(", "))
    .replaceAll("{fieldInstructions}", fieldInstructions);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

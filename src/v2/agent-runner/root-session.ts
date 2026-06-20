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
  const missingFields = input.requiredFields.filter((field) => !hasValue(normalizedArtifact[field]));
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
  if (requiredFields.some((field) => hasValue(artifact[field]))) return artifact;
  for (const candidate of Object.values(artifact)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const nested = candidate as Record<string, unknown>;
    if (requiredFields.some((field) => hasValue(nested[field]))) {
      return nested;
    }
  }
  return artifact;
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

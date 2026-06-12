export type ArtifactSchemaEvaluationInput = {
  artifact: Record<string, unknown>;
  requiredFields: string[];
};

export type ArtifactSchemaEvaluationResult = {
  ok: boolean;
  missingFields: string[];
};

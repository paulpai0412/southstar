export type RecoverySavingsTelemetryInput = {
  originalContextTokenEstimate?: number;
  rebuiltContextTokenEstimate?: number;
  omittedFailureSuffixEstimate?: number;
};

export type RecoverySavingsTelemetry = {
  originalContextTokenEstimate?: number;
  rebuiltContextTokenEstimate?: number;
  omittedFailureSuffixEstimate?: number;
  estimatedSavings?: number;
};

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function recoverySavingsTelemetry(input: RecoverySavingsTelemetryInput): RecoverySavingsTelemetry {
  const original = finiteNumber(input.originalContextTokenEstimate);
  const rebuilt = finiteNumber(input.rebuiltContextTokenEstimate);
  const omitted = finiteNumber(input.omittedFailureSuffixEstimate);
  const estimatedSavings = original !== undefined && rebuilt !== undefined
    ? Math.max(0, original - rebuilt)
    : undefined;

  return {
    ...(original !== undefined ? { originalContextTokenEstimate: original } : {}),
    ...(rebuilt !== undefined ? { rebuiltContextTokenEstimate: rebuilt } : {}),
    ...(omitted !== undefined ? { omittedFailureSuffixEstimate: omitted } : {}),
    ...(estimatedSavings !== undefined ? { estimatedSavings } : {}),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

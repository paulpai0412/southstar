export type ReadModelWarning = {
  code: string;
  message: string;
  severity: "info" | "warning";
  resourceRef?: string;
};

export type ReadModelDiagnostics = {
  stale: boolean;
  warnings: ReadModelWarning[];
};

export type ReadModelEnvelope<TKind extends string, TData> = {
  schemaVersion: string;
  kind: TKind;
  generatedAt: string;
  data: TData;
  diagnostics: ReadModelDiagnostics;
};

export function envelopeReadModel<TKind extends string, TData>(input: {
  schemaVersion: string;
  kind: TKind;
  data: TData;
  warnings?: ReadModelWarning[];
}): ReadModelEnvelope<TKind, TData> {
  return {
    schemaVersion: input.schemaVersion,
    kind: input.kind,
    generatedAt: new Date().toISOString(),
    data: input.data,
    diagnostics: {
      stale: false,
      warnings: input.warnings ?? [],
    },
  };
}

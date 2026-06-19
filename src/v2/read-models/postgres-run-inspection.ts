import type { SouthstarDb } from "../db/postgres.ts";
import { inspectRunPg } from "../inspection/postgres-inspect-run.ts";
import { envelopeReadModel } from "./envelope.ts";

export async function buildRunInspectionReadModelPg(db: SouthstarDb, runId: string) {
  return envelopeReadModel({
    schemaVersion: "southstar.read_model.run_inspection.v1",
    kind: "run-inspection",
    data: await inspectRunPg(db, { runId }),
  });
}

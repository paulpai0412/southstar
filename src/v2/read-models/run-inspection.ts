import { inspectRun } from "../inspection/inspect-run.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export function buildRunInspectionData(db: SouthstarDb, runId: string) {
  return inspectRun(db, { runId });
}

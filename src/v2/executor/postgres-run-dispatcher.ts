import type { SouthstarDb } from "../db/postgres.ts";
import type { ExecutorProvider } from "./provider.ts";

export type PostgresRunDispatchInput = {
  runId: string;
  executorProvider: ExecutorProvider;
  callbackUrl: string;
  heartbeatUrl?: string;
  runRoot?: string;
  envelopeBasePath?: string;
  harnessEndpoint?: string;
  contextRefreshUrl?: string;
  attemptId?: string;
};

export type PostgresRunDispatchResult = {
  runId: string;
  attemptId: string;
  externalJobId: string;
  taskIds: string[];
  materializedEnvelopePaths: string[];
};

export async function dispatchPostgresRunExecutionPg(
  _db: SouthstarDb,
  _input: PostgresRunDispatchInput,
): Promise<PostgresRunDispatchResult> {
  throw new Error("whole-run dispatcher is removed; use run scheduling and RunnableTaskScheduler");
}

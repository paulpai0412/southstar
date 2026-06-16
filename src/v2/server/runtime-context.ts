import type { ExecutorProvider, TorkObservationClient } from "../executor/provider.ts";
import type { PiPlannerClient } from "../planner/types.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";
import type { RuntimeLoopController } from "./runtime-loops.ts";

export type RuntimeServerContext = {
  db: SouthstarDb;
  plannerClient: PiPlannerClient;
  executorProvider: ExecutorProvider;
  torkObservationClient?: TorkObservationClient;
  callbackUrl?: string;
  serverUrl?: string;
  runRoot?: string;
  reconcileIntervalMs?: number;
  createReconcileLoop?: () => RuntimeLoopController;
};

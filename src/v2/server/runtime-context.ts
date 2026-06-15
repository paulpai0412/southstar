import type { ExecutorProvider } from "../executor/provider.ts";
import type { ExecutorRuntimeManager } from "../executor/runtime-manager.ts";
import type { PiPlannerClient } from "../planner/types.ts";
import type { SouthstarDb } from "../stores/sqlite.ts";

export type RuntimeServerContext = {
  db: SouthstarDb;
  plannerClient: PiPlannerClient;
  executorManager?: ExecutorRuntimeManager;
  executorProvider?: ExecutorProvider;
  callbackUrl?: string;
  serverUrl?: string;
  runRoot?: string;
};

import type { SouthstarDb } from "../db/postgres.ts";
import type { BrainProvider } from "../brain/types.ts";
import type { RecoveryProviderActions } from "../executor/provider-actions.ts";
import type { ExecutorProvider, TorkObservationClient } from "../executor/provider.ts";
import type { HandProvider } from "../hands/types.ts";
import type { LibraryImportLlmProvider } from "../design-library/importers/library-llm-import-analyzer.ts";
import type { LibraryImportSourceFetcher } from "../design-library/importers/library-source-fetcher.ts";
import type { WorkflowComposer } from "../orchestration/composer.ts";
import type { PiPlannerClient } from "../planner/types.ts";
import type { SessionStore } from "../session/types.ts";
import type { RuntimeLoopController } from "./runtime-loops.ts";
import type { RuntimeLoopRegistry } from "./runtime-loop-registry.ts";

export type RuntimeServerContext = {
  db: SouthstarDb;
  plannerClient: PiPlannerClient;
  workflowComposer?: WorkflowComposer;
  executorProvider: ExecutorProvider;
  torkObservationClient?: TorkObservationClient;
  callbackUrl?: string;
  serverUrl?: string;
  runRoot?: string;
  libraryRoot?: string;
  libraryImportSourceFetcher?: LibraryImportSourceFetcher;
  libraryImportLlmProvider?: LibraryImportLlmProvider;
  reconcileIntervalMs?: number;
  createReconcileLoop?: () => RuntimeLoopController;
  runtimeLoopRegistry?: RuntimeLoopRegistry;
  manualRuntimeLoopControls?: boolean;
  providerActions?: RecoveryProviderActions;
  managedRuntime?: {
    sessionStore: SessionStore;
    brainProvider: BrainProvider;
    handProvider: HandProvider;
    providerActions?: RecoveryProviderActions;
    schedulerIntervalMs?: number;
    recoveryIntervalMs?: number;
  };
};

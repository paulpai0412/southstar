import type { RuntimeConfig } from "../config/schema.ts";
import { SqliteControlPlaneStore } from "../runtime/store.ts";
import type { HostAdapter } from "../types/host.ts";
import { loadWorkflow } from "../types/workflow.ts";
import { createProductionOrchestrator, type ProductionIssueSource, type ProductionObservability, type ProductionProgressReporter } from "./cycle.ts";
import type { DomainDriverRegistry } from "./domain-registry.ts";
import { createProductionDependencies, resolveProductionStorePath, type ProductionDependencyMetrics } from "./production-dependencies.ts";
import { resolveProductionWorkflowPath } from "./workflow-path.ts";

export interface ProductionFactoryMetrics {
  production_cli_uses_registry: number;
  production_watch_uses_registry: number;
}

export function createProductionOrchestratorFromFactory(input: {
  config: RuntimeConfig;
  store?: SqliteControlPlaneStore;
  host: HostAdapter;
  registry: DomainDriverRegistry;
  workflowPath?: string;
  now?: () => string;
  usage?: "cli" | "watch";
  observability?: ProductionObservability;
  issueSource?: ProductionIssueSource;
  progress?: ProductionProgressReporter;
  cleanup?: {
    archiveManagedWorktree(input: { worktreePath: string; archivePath: string }): Promise<unknown>;
    deleteManagedWorktree(input: { worktreePath: string }): Promise<unknown>;
  };
}) {
  const workflowPath = resolveProductionWorkflowPath({
    config: input.config,
    workflowPath: input.workflowPath,
  });
  const workflow = loadWorkflow(workflowPath);
  const domain = input.registry.resolve({
    workflow,
    config: input.config,
    dependencies: {
      host: input.host,
    },
  });
  const metrics: ProductionFactoryMetrics = {
    production_cli_uses_registry: input.usage === "watch" ? 0 : 1,
    production_watch_uses_registry: input.usage === "watch" ? 1 : 0,
  };

  return {
    orchestrator: createProductionOrchestrator({
      store: input.store ?? SqliteControlPlaneStore.open(resolveProductionStorePath({
        projectRoot: input.config.project.root,
        dbPath: input.config.runtime.dbPath,
      })),
      host: input.host,
      domain,
      workflowPath,
      now: input.now ?? (() => new Date().toISOString()),
      leaseTimeoutSeconds: input.config.runtime.leaseTimeoutSeconds,
      roleOverrides: input.config.workflowOverrides?.roles ?? {},
      observability: input.observability,
      projectId: input.config.github.project?.projectId,
      externalCompletionEnabled: input.config.github.sync.enabled,
      issueSource: input.issueSource,
      progress: input.progress,
      cleanupPolicy: input.config.cleanup,
      cleanup: input.cleanup,
      projectRoot: input.config.project.root,
      worktreesDir: input.config.git.worktreesDir,
    }),
    metrics,
    registry: input.registry,
  };
}

export async function createProductionOrchestratorFromDefaultFactory(input: {
  config: RuntimeConfig;
  store?: SqliteControlPlaneStore;
  workflowPath?: string;
  now?: () => string;
  usage?: "cli" | "watch";
  progress?: ProductionProgressReporter;
}) {
  const dependencies = await createProductionDependencies({
    config: input.config,
    usage: input.usage ?? "cli",
  });
  const built = createProductionOrchestratorFromFactory({
    ...input,
    host: dependencies.host,
    registry: dependencies.registry,
    observability: input.config.github.sync.enabled ? dependencies.observability : undefined,
    issueSource: dependencies.issueIntake,
    cleanup: dependencies.cleanup,
  });
  return {
    ...built,
    dependencies,
    metrics: {
      ...built.metrics,
      ...dependencies.metrics,
    } as ProductionFactoryMetrics & ProductionDependencyMetrics,
  };
}

import type {
  ExecutorCleanupRequest,
  ExecutorCleanupResult,
  ExecutorHealthResult,
  ExecutorProvider,
  ExecutorReconcileRequest,
  ExecutorReconcileResult,
  ExecutorShutdownRequest,
  ExecutorShutdownResult,
  ExecutorSubmitRequest,
  ExecutorSubmitResult,
} from "./provider.ts";
import type { ExecutorOperationLock } from "./bindings.ts";

export type ExecutorRuntimeManagerOptions = {
  provider: ExecutorProvider;
};

export class ExecutorRuntimeManager {
  readonly provider: ExecutorProvider;

  constructor(options: ExecutorRuntimeManagerOptions) {
    this.provider = options.provider;
  }

  async initialize(): Promise<void> {
    await this.provider.initialize?.();
  }

  async health(): Promise<ExecutorHealthResult> {
    if (this.provider.health) {
      return await this.provider.health();
    }
    return {
      executorType: this.provider.executorType,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: "provider does not implement health()",
      capabilities: {},
    };
  }

  async submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> {
    return await this.provider.submit(request);
  }

  async cleanup(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult> {
    if (!this.provider.cleanup) {
      return {
        executorType: this.provider.executorType,
        externalJobId: request.externalJobId,
        status: "not_supported",
      };
    }
    return await this.provider.cleanup(request);
  }

  async reconcile(request: ExecutorReconcileRequest): Promise<ExecutorReconcileResult> {
    if (!this.provider.reconcile) {
      return {
        executorType: this.provider.executorType,
        reconciled: 0,
        cleaned: 0,
        failures: ["provider does not implement reconcile"],
      };
    }
    return await this.provider.reconcile(request);
  }

  async shutdown(request: ExecutorShutdownRequest): Promise<ExecutorShutdownResult> {
    if (!this.provider.shutdown) {
      return {
        executorType: this.provider.executorType,
        status: "degraded",
        cleaned: 0,
        failures: ["provider does not implement shutdown"],
      };
    }
    return await this.provider.shutdown(request);
  }

  static isLockExpired(lock: ExecutorOperationLock, now = new Date()): boolean {
    return Date.parse(lock.expiresAt) <= now.getTime();
  }
}

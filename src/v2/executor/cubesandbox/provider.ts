import type { CubeSandboxExecutorConfig, ExecutorLifecycleConfig } from "../../../config/schema.ts";
import type {
  ExecutorCancelRequest,
  ExecutorCancelResult,
  ExecutorCleanupRequest,
  ExecutorCleanupResult,
  ExecutorLogsRequest,
  ExecutorLogsResult,
  ExecutorProvider,
  ExecutorStatusRequest,
  ExecutorStatusResult,
  ExecutorSubmitRequest,
  ExecutorSubmitResult,
} from "../provider.ts";
import { newExecutorCleanupPayload } from "../bindings.ts";
import { mapCubeCommandStatus } from "./sdk-client.ts";
import type { CubeSandboxSdkClient } from "./types.ts";

export type CubeSandboxExecutorProviderOptions = {
  config: CubeSandboxExecutorConfig;
  lifecycle: ExecutorLifecycleConfig;
  sdkClient: CubeSandboxSdkClient;
};

export class CubeSandboxExecutorProvider implements ExecutorProvider {
  readonly executorType = "cubesandbox" as const;
  private readonly config: CubeSandboxExecutorConfig;
  private readonly lifecycle: ExecutorLifecycleConfig;
  private readonly sdkClient: CubeSandboxSdkClient;

  constructor(options: CubeSandboxExecutorProviderOptions) {
    this.config = options.config;
    this.lifecycle = options.lifecycle;
    this.sdkClient = options.sdkClient;
  }

  async initialize(): Promise<void> {
    await this.sdkClient.health();
  }

  async health() {
    try {
      await this.sdkClient.health();
      return {
        executorType: this.executorType,
        status: "healthy" as const,
        checkedAt: new Date().toISOString(),
        capabilities: {
          status: true,
          cancel: true,
          logs: true,
          cleanup: true,
          reconcile: true,
        },
      };
    } catch (error) {
      return {
        executorType: this.executorType,
        status: "unavailable" as const,
        checkedAt: new Date().toISOString(),
        message: (error as Error).message,
        capabilities: {
          status: false,
          cancel: false,
          logs: false,
          cleanup: false,
          reconcile: false,
        },
      };
    }
  }

  async submit(request: ExecutorSubmitRequest): Promise<ExecutorSubmitResult> {
    const submitStartedAt = Date.now();
    const attemptId = request.attemptId ?? "attempt-1";
    const taskId = request.workflow.tasks[0]?.id ?? "task-1";
    const externalJobId = `cube-exec-${request.runId}-${attemptId}`;

    const sandboxCreateStartedAt = Date.now();
    const sandbox = await this.sdkClient.createSandbox({
      templateId: this.config.templateId,
      timeoutSeconds: this.config.defaultTimeoutSeconds,
      hostMounts: this.config.hostMounts,
      metadata: {
        managedBy: "southstar",
        runId: request.runId,
        taskId,
        attemptId,
        executorBindingId: externalJobId,
        createdAt: new Date().toISOString(),
        ttlSeconds: String(this.config.defaultTimeoutSeconds),
      },
    });
    const sandboxCreatedAt = Date.now();

    const envelopeRoot = request.envelopeBasePath ?? "/southstar-runs";
    const command = [
      "southstar-agent-runner",
      "--envelope",
      `${envelopeRoot}/${request.runId}/${taskId}/envelope.json`,
      "--callback-url",
      request.callbackUrl ?? "/api/v2/executor/callback",
    ];

    const commandStartStartedAt = Date.now();
    const commandResult = await this.sdkClient.runCommand({
      sandboxId: sandbox.sandboxId,
      command,
      env: {
        SOUTHSTAR_EXECUTOR_TYPE: "cubesandbox",
        SOUTHSTAR_RUN_ID: request.runId,
        SOUTHSTAR_TASK_ID: taskId,
        SOUTHSTAR_ATTEMPT_ID: attemptId,
      },
      timeoutSeconds: this.lifecycle.taskWallTimeoutSeconds,
    });
    const commandStartedAt = Date.now();

    return {
      executorType: this.executorType,
      externalJobId,
      status: "running",
      providerPayload: {
        sandboxId: sandbox.sandboxId,
        commandId: commandResult.commandId,
        templateId: this.config.templateId,
        attemptId,
        taskId,
        timings: {
          submitStartedAt: new Date(submitStartedAt).toISOString(),
          sandboxCreateStartedAt: new Date(sandboxCreateStartedAt).toISOString(),
          sandboxCreatedAt: new Date(sandboxCreatedAt).toISOString(),
          sandboxCreateMs: sandboxCreatedAt - sandboxCreateStartedAt,
          commandStartStartedAt: new Date(commandStartStartedAt).toISOString(),
          commandStartedAt: new Date(commandStartedAt).toISOString(),
          commandStartMs: commandStartedAt - commandStartStartedAt,
        },
        cleanup: newExecutorCleanupPayload(this.config.destroyOnCompletion),
      },
    };
  }

  async status(request: ExecutorStatusRequest): Promise<ExecutorStatusResult> {
    const sandboxId = requiredPayloadString(request.providerPayload, "sandboxId");
    const commandId = requiredPayloadString(request.providerPayload, "commandId");
    const command = await this.sdkClient.getCommand({ sandboxId, commandId });
    return {
      executorType: this.executorType,
      externalJobId: request.externalJobId,
      status: mapCubeCommandStatus(command),
      providerPayload: {
        ...(request.providerPayload ?? {}),
        providerStatus: command.status,
        exitCode: command.exitCode,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
      },
    };
  }

  async cancel(request: ExecutorCancelRequest): Promise<ExecutorCancelResult> {
    const sandboxId = requiredPayloadString(request.providerPayload, "sandboxId");
    const commandId = requiredPayloadString(request.providerPayload, "commandId");
    await this.sdkClient.killCommand({ sandboxId, commandId });
    await this.sdkClient.destroySandbox({ sandboxId });
    const cleanup = nextCleanupPayload(request.providerPayload?.cleanup, { finalizerStatus: "destroyed" });
    return {
      executorType: this.executorType,
      externalJobId: request.externalJobId,
      status: "cancelled",
      providerPayload: {
        ...(request.providerPayload ?? {}),
        cleanup,
      },
    };
  }

  async logs(request: ExecutorLogsRequest): Promise<ExecutorLogsResult> {
    const sandboxId = requiredPayloadString(request.providerPayload, "sandboxId");
    const commandId = typeof request.providerPayload?.commandId === "string"
      ? request.providerPayload.commandId
      : undefined;
    const logs = await this.sdkClient.logs({ sandboxId, commandId, cursor: request.cursor });
    return {
      executorType: this.executorType,
      externalJobId: request.externalJobId,
      text: logs.text,
      cursor: logs.cursor,
    };
  }

  async cleanup(request: ExecutorCleanupRequest): Promise<ExecutorCleanupResult> {
    const sandboxId = requiredPayloadString(request.providerPayload, "sandboxId");
    try {
      await this.sdkClient.destroySandbox({ sandboxId });
      return {
        executorType: this.executorType,
        externalJobId: request.externalJobId,
        status: "destroyed",
        providerPayload: {
          ...(request.providerPayload ?? {}),
          cleanup: nextCleanupPayload(request.providerPayload?.cleanup, { finalizerStatus: "destroyed" }),
        },
      };
    } catch (error) {
      return {
        executorType: this.executorType,
        externalJobId: request.externalJobId,
        status: "retry_scheduled",
        providerPayload: {
          ...(request.providerPayload ?? {}),
          cleanup: nextCleanupPayload(request.providerPayload?.cleanup, {
            finalizerStatus: "retry_scheduled",
            lastError: (error as Error).message,
          }),
        },
      };
    }
  }

  async reconcile(request: { runId?: string; reason: string }) {
    const detectionStartedAt = Date.now();
    const sandboxes = await this.sdkClient.listSandboxes({
      metadata: {
        managedBy: "southstar",
        ...(request.runId ? { runId: request.runId } : {}),
      },
    });
    const detectionMs = Date.now() - detectionStartedAt;

    const destroyStartedAt = Date.now();
    const failures: string[] = [];
    let cleaned = 0;
    for (const sandbox of sandboxes) {
      try {
        await this.sdkClient.destroySandbox({ sandboxId: sandbox.sandboxId });
        cleaned += 1;
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    const destroyMs = Date.now() - destroyStartedAt;

    return {
      executorType: this.executorType,
      reconciled: sandboxes.length,
      cleaned,
      failures,
      providerPayload: {
        managedResidueCount: Math.max(0, sandboxes.length - cleaned),
        timings: {
          orphanDetectionMs: detectionMs,
          orphanDestroyMs: destroyMs,
        },
      },
    };
  }

  async shutdown(request: { reason: string; graceSeconds: number }) {
    const before = await this.sdkClient.listSandboxes({ metadata: { managedBy: "southstar" } });
    const failures: string[] = [];
    for (const sandbox of before) {
      try {
        await this.sdkClient.destroySandbox({ sandboxId: sandbox.sandboxId });
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    return {
      executorType: this.executorType,
      status: failures.length === 0 ? "completed" as const : "degraded" as const,
      cleaned: Math.max(0, before.length - failures.length),
      failures,
    };
  }
}

function requiredPayloadString(payload: Record<string, unknown> | undefined, field: string): string {
  const value = payload?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CubeSandbox provider payload missing ${field}`);
  }
  return value;
}

function nextCleanupPayload(
  cleanupPayload: unknown,
  patch: { finalizerStatus: string; lastError?: string },
): Record<string, unknown> {
  const current = cleanupPayload as {
    required?: unknown;
    destroyOnCompletion?: unknown;
    attempts?: unknown;
    lastAttemptAt?: unknown;
  } | undefined;
  const attempts = typeof current?.attempts === "number" ? current.attempts + 1 : 1;
  return {
    ...(typeof cleanupPayload === "object" && cleanupPayload !== null ? cleanupPayload as Record<string, unknown> : {}),
    required: typeof current?.required === "boolean" ? current.required : true,
    destroyOnCompletion: typeof current?.destroyOnCompletion === "boolean" ? current.destroyOnCompletion : true,
    attempts,
    lastAttemptAt: new Date().toISOString(),
    finalizerStatus: patch.finalizerStatus,
    ...(patch.lastError ? { lastError: patch.lastError } : {}),
  };
}

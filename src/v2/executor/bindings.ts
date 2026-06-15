export type ExecutorOperationLock = {
  ownerId: string;
  operation: "submit" | "cancel" | "reconcile" | "cleanup";
  expiresAt: string;
};

export type CleanupFinalizerStatus =
  | "pending"
  | "in_progress"
  | "destroyed"
  | "orphan_detected"
  | "retry_scheduled"
  | "failed"
  | "waived_for_debug";

export type ExecutorCleanupPayload = {
  required: boolean;
  destroyOnCompletion: boolean;
  finalizerStatus: CleanupFinalizerStatus;
  attempts: number;
  lastAttemptAt?: string | null;
};

export function newExecutorCleanupPayload(destroyOnCompletion: boolean): ExecutorCleanupPayload {
  return {
    required: true,
    destroyOnCompletion,
    finalizerStatus: "pending",
    attempts: 0,
    lastAttemptAt: null,
  };
}

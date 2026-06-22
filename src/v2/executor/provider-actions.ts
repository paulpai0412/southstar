import type { RecoveryExecutionProviderAction } from "../exceptions/types.ts";

export type RecoveryProviderActionInput = {
  externalJobId: string;
  runId: string;
  reason: string;
};

export type RecoveryProviderActions = {
  poll?: (input: RecoveryProviderActionInput) => Promise<unknown>;
  cancel?: (input: RecoveryProviderActionInput) => Promise<unknown>;
};

export function requestedCancelAction(input: {
  providerId: string;
  externalJobId?: string;
  evidenceRef?: string;
  now: string;
  providerActions?: RecoveryProviderActions;
}): RecoveryExecutionProviderAction {
  const base = {
    providerId: input.providerId,
    action: "cancel" as const,
    evidenceRef: input.evidenceRef,
  };

  if (!input.externalJobId || !input.providerActions?.cancel) {
    return {
      ...base,
      status: "skipped",
    };
  }

  return {
    ...base,
    status: "requested",
    attemptedAt: input.now,
  };
}

export async function executeBestEffortCancelAction(input: {
  providerId: string;
  externalJobId: string;
  runId: string;
  evidenceRef?: string;
  reason: string;
  now: string;
  providerActions: RecoveryProviderActions;
}): Promise<RecoveryExecutionProviderAction> {
  const base = {
    providerId: input.providerId,
    action: "cancel" as const,
    evidenceRef: input.evidenceRef,
    attemptedAt: input.now,
  };

  try {
    await input.providerActions.cancel?.({
      externalJobId: input.externalJobId,
      runId: input.runId,
      reason: input.reason,
    });
    return {
      ...base,
      status: "succeeded",
      completedAt: input.now,
      succeededAt: input.now,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      completedAt: input.now,
      errorExcerpt: redactAndTruncateError(error),
    };
  }
}

export async function recordBestEffortCancelAction(input: {
  providerId: string;
  externalJobId?: string;
  runId: string;
  evidenceRef?: string;
  reason: string;
  now: string;
  providerActions?: RecoveryProviderActions;
}): Promise<RecoveryExecutionProviderAction> {
  return requestedCancelAction(input);
}

function redactAndTruncateError(error: unknown): string {
  return redactTokenLikeValues(errorExcerpt(error)).slice(0, 500);
}

function errorExcerpt(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function redactTokenLikeValues(value: string): string {
  return value
    .replace(/\b(secret=)[^\s&]+/gi, "$1[REDACTED]")
    .replace(/\b(token=)[^\s&]+/gi, "$1[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]");
}

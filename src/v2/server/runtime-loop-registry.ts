export type RuntimeLoopId =
  | "executor-reconciler"
  | "runnable-task-scheduler"
  | "recovery-controller"
  | "tork-exception-observer"
  | "recovery-decision-applier";

export type RuntimeLoopTickResult = Record<string, unknown>;

export type RuntimeLoopRegistration = {
  id: RuntimeLoopId;
  intervalMs: number;
  runOnce: () => Promise<RuntimeLoopTickResult>;
};

export type RuntimeLoopSnapshot = {
  id: RuntimeLoopId;
  intervalMs: number;
  running?: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastStatus?: "succeeded" | "failed";
  lastError?: string;
  lastResult?: RuntimeLoopTickResult;
};

export type RuntimeLoopTickSnapshot = {
  loopId: RuntimeLoopId;
  status: "succeeded" | "failed";
  result?: RuntimeLoopTickResult;
  error?: string;
};

export type RuntimeLoopRegistry = ReturnType<typeof createRuntimeLoopRegistry>;

export function createRuntimeLoopRegistry() {
  const registrations = new Map<RuntimeLoopId, RuntimeLoopRegistration>();
  const snapshots = new Map<RuntimeLoopId, RuntimeLoopSnapshot>();
  const inFlight = new Map<RuntimeLoopId, Promise<RuntimeLoopTickSnapshot>>();
  return {
    register(registration: RuntimeLoopRegistration): void {
      registrations.set(registration.id, registration);
      snapshots.set(registration.id, {
        ...(snapshots.get(registration.id) ?? {}),
        id: registration.id,
        intervalMs: registration.intervalMs,
      });
    },
    list(): RuntimeLoopSnapshot[] {
      return [...snapshots.values()].sort((left, right) => left.id.localeCompare(right.id));
    },
    async tick(loopId: RuntimeLoopId): Promise<RuntimeLoopTickSnapshot> {
      const active = inFlight.get(loopId);
      if (active) return await active;
      const registration = registrations.get(loopId);
      if (!registration) throw new Error(`runtime loop not registered: ${loopId}`);
      const tickPromise = runTick(loopId, registration, snapshots).finally(() => {
        inFlight.delete(loopId);
      });
      inFlight.set(loopId, tickPromise);
      return await tickPromise;
    },
  };
}

async function runTick(
  loopId: RuntimeLoopId,
  registration: RuntimeLoopRegistration,
  snapshots: Map<RuntimeLoopId, RuntimeLoopSnapshot>,
): Promise<RuntimeLoopTickSnapshot> {
  const current = snapshots.get(loopId) ?? { id: loopId, intervalMs: registration.intervalMs };
  const startedAt = new Date().toISOString();
  snapshots.set(loopId, { ...current, running: true, lastStartedAt: startedAt, lastError: undefined });
  try {
    const result = await registration.runOnce();
    const finishedAt = new Date().toISOString();
    snapshots.set(loopId, {
      id: loopId,
      intervalMs: registration.intervalMs,
      running: false,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastStatus: "succeeded",
      lastResult: result,
    });
    return { loopId, status: "succeeded", result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    snapshots.set(loopId, {
      id: loopId,
      intervalMs: registration.intervalMs,
      running: false,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastStatus: "failed",
      lastError: message,
    });
    return { loopId, status: "failed", error: message };
  }
}

export function parseRuntimeLoopId(value: string): RuntimeLoopId {
  if (
    value === "executor-reconciler"
    || value === "runnable-task-scheduler"
    || value === "recovery-controller"
    || value === "tork-exception-observer"
    || value === "recovery-decision-applier"
  ) return value;
  throw new Error(`unknown runtime loop id: ${value}`);
}

import type { BrainProvider } from "../brain/types.ts";
import type { SouthstarDb } from "../db/postgres.ts";
import type { HandProvider } from "../hands/types.ts";
import { createRunnableTaskScheduler } from "../scheduler/runnable-task-scheduler.ts";
import { createPostgresRecoveryController } from "../session-recovery/postgres-controller.ts";
import type { SessionStore } from "../session/types.ts";

export type RuntimeLoopController = {
  start(): void;
  stop(): Promise<void>;
};

export type ManagedRuntimeLoopPlanItem = {
  id: "executor-reconciler" | "runnable-task-scheduler" | "recovery-controller";
  intervalMs: number;
};

export type ManagedRuntimeLoopDeps = {
  db: SouthstarDb;
  sessionStore: SessionStore;
  brainProvider: BrainProvider;
  handProvider: HandProvider;
  schedulerIntervalMs: number;
  recoveryIntervalMs: number;
};

type ActiveRunRow = {
  id: string;
};

type FailedBindingRow = {
  resource_type: "brain_binding" | "hand_binding";
  resource_key: string;
  run_id: string | null;
  task_id: string | null;
  session_id: string | null;
};

export function createManagedRuntimeLoopPlan(input: { schedulerIntervalMs: number; recoveryIntervalMs: number }): ManagedRuntimeLoopPlanItem[] {
  return [
    { id: "executor-reconciler", intervalMs: 30_000 },
    { id: "runnable-task-scheduler", intervalMs: input.schedulerIntervalMs },
    { id: "recovery-controller", intervalMs: input.recoveryIntervalMs },
  ];
}

export function createCompositeRuntimeLoopController(controllers: RuntimeLoopController[]): RuntimeLoopController {
  return {
    start() {
      for (const controller of controllers) controller.start();
    },
    async stop() {
      await Promise.all(controllers.map((controller) => controller.stop()));
    },
  };
}

export function createManagedRuntimeLoopController(input: ManagedRuntimeLoopDeps): RuntimeLoopController {
  const scheduler = createRunnableTaskScheduler(input.db, {
    sessionStore: input.sessionStore,
    brainProvider: input.brainProvider,
    handProvider: input.handProvider,
  });
  const recoveryController = createPostgresRecoveryController({
    db: input.db,
    sessionStore: input.sessionStore,
    brainProvider: input.brainProvider,
    handProvider: input.handProvider,
  });
  return createCompositeRuntimeLoopController([
    createRuntimeLoopController({
      intervalMs: input.schedulerIntervalMs,
      runOnce: async () => {
        for (const runId of await listActiveRunIds(input.db)) {
          await scheduler.runOnce({ runId });
        }
      },
    }),
    createRuntimeLoopController({
      intervalMs: input.recoveryIntervalMs,
      runOnce: async () => {
        for (const binding of await listRecoverableBindings(input.db)) {
          if (!binding.run_id || !binding.task_id || !binding.session_id) continue;
          await recoveryController.recover({
            runId: binding.run_id,
            taskId: binding.task_id,
            sessionId: binding.session_id,
            strategy: binding.resource_type === "brain_binding" ? "wake-new-brain" : "reprovision-hand",
            reason: `managed runtime loop recovery for ${binding.resource_key}`,
          });
        }
      },
    }),
  ]);
}

export function createRuntimeLoopController(input: {
  intervalMs: number;
  runOnce: () => Promise<void>;
  backoffMs?: number;
  maxBackoffMs?: number;
}): RuntimeLoopController {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = true;
  let currentDelayMs = input.intervalMs;
  const baseBackoffMs = input.backoffMs ?? input.intervalMs;
  const maxBackoffMs = input.maxBackoffMs ?? Math.max(baseBackoffMs, input.intervalMs * 4);

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const tick = async () => {
    if (stopped || running) {
      schedule(currentDelayMs);
      return;
    }
    running = true;
    try {
      await input.runOnce();
      currentDelayMs = input.intervalMs;
    } catch {
      currentDelayMs = Math.min(maxBackoffMs, Math.max(baseBackoffMs, currentDelayMs * 2));
    } finally {
      running = false;
      schedule(currentDelayMs);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      currentDelayMs = input.intervalMs;
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) {
        await sleep(5);
      }
    },
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function listActiveRunIds(db: SouthstarDb): Promise<string[]> {
  const rows = await db.query<ActiveRunRow>(
    "select id from southstar.workflow_runs where status in ('running') order by updated_at, id",
  );
  return rows.rows.map((row) => row.id);
}

async function listRecoverableBindings(db: SouthstarDb): Promise<FailedBindingRow[]> {
  const rows = await db.query<FailedBindingRow>(
    `select resource_type, resource_key, run_id, task_id, session_id
       from southstar.runtime_resources
      where resource_type in ('brain_binding', 'hand_binding')
        and status in ('failed', 'lost')
      order by updated_at, resource_type, resource_key`,
  );
  return rows.rows;
}

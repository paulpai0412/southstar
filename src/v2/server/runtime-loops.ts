export type RuntimeLoopController = {
  start(): void;
  stop(): Promise<void>;
};

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

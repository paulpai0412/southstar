export interface WatchWriterLease {
  assertCurrentOwner?(): Promise<void>;
  heartbeat?(now?: string): Promise<void>;
  release(): Promise<void>;
}

export interface WatchCycleResult {
  activeIssues: number;
  effectsStarted: number;
}

export interface WatchLoopOptions {
  intervalMs: number;
  maxCycles?: number;
  acquireWriter(): Promise<WatchWriterLease | undefined>;
  runCycle(): Promise<WatchCycleResult>;
  sleep(ms: number): Promise<void>;
  shouldStop(): boolean;
  now?: () => string;
}

export interface WatchLoopResult {
  cycles: number;
  skipped_reason?: "writer_lock_unavailable" | "writer_lock_lost";
}

export function createWatchLoop(options: WatchLoopOptions) {
  return {
    async run(): Promise<WatchLoopResult> {
      const writer = await options.acquireWriter();
      if (!writer) {
        return { cycles: 0, skipped_reason: "writer_lock_unavailable" };
      }

      let cycles = 0;
      try {
        while (!options.shouldStop() && (options.maxCycles === undefined || cycles < options.maxCycles)) {
          try {
            await writer.assertCurrentOwner?.();
          } catch {
            return { cycles, skipped_reason: "writer_lock_lost" };
          }
          try {
            await writer.heartbeat?.((options.now ?? (() => new Date().toISOString()))());
          } catch {
            return { cycles, skipped_reason: "writer_lock_lost" };
          }
          await options.runCycle();
          cycles += 1;
          try {
            await writer.heartbeat?.((options.now ?? (() => new Date().toISOString()))());
          } catch {
            return { cycles, skipped_reason: "writer_lock_lost" };
          }
          if (options.shouldStop() || cycles === options.maxCycles) {
            break;
          }
          await options.sleep(options.intervalMs);
        }
        return { cycles };
      } finally {
        await writer.release();
      }
    },
  };
}

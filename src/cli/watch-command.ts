import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load-config.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import type { GitHubReadyIssue } from "../adapters/github/issues.ts";
import { createProductionOrchestratorFromDefaultFactory } from "../orchestrator/production-factory.ts";
import type { ProductionProgressReporter } from "../orchestrator/cycle.ts";
import { compactWatchLogLine } from "../runtime/watch-logger.ts";
import { acquireFileWatchWriter } from "../runtime/watch-lock.ts";
import { createWatchLoop } from "../runtime/watch.ts";

export interface WatchCommandOptions {
  configPath: string;
  maxCycles?: number;
  intervalMs: number;
  logJson: boolean;
}

export function parseWatchOptions(args: string[]): WatchCommandOptions {
  return {
    configPath: optionValue(args, "--config") ?? ".northstar.yaml",
    maxCycles: numberOption(args, "--max-cycles"),
    intervalMs: numberOption(args, "--interval-ms") ?? 1000,
    logJson: args.includes("--log-json"),
  };
}

export function createWatchOrchestratorRunner(options: {
  runCycle(): Promise<{ activeIssues: number; effectsStarted: number; historyRows?: number; summary?: Record<string, unknown> }>;
}) {
  return async () => {
    const result = await options.runCycle();
    return {
      activeIssues: result.activeIssues,
      effectsStarted: result.effectsStarted,
      historyRows: result.historyRows ?? 0,
      summary: result.summary ?? {},
    };
  };
}

export async function runWatchCycleWithProductionIntake(input: {
  intakeEnabled?: boolean;
  listReadyIssues(): Promise<GitHubReadyIssue[]>;
  orchestrator: {
    intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }): Promise<unknown>;
    runCycle(input: { autoRelease: boolean; maxStarts: number }): Promise<{ activeIssues: number; effectsStarted: number; historyRows?: number }>;
  };
  maxStarts: number;
  autoRelease: boolean;
}): Promise<{ activeIssues: number; effectsStarted: number; historyRows?: number }> {
  const issues = input.intakeEnabled === false ? [] : await input.listReadyIssues();
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    await input.orchestrator.intakeIssue({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
      sourceUrl: issue.sourceUrl,
      labels: issue.labels,
    });
  }
  return await input.orchestrator.runCycle({
    autoRelease: input.autoRelease,
    maxStarts: input.maxStarts,
  });
}

export interface WatchCycleProduction {
  dependencies: {
    issueIntake: {
      listReadyIssues(): Promise<GitHubReadyIssue[]>;
    };
  };
  orchestrator: {
    intakeIssue(input: { issueNumber: number; title: string; body: string; sourceUrl: string; labels: string[] }): Promise<unknown>;
    runCycle(input: { autoRelease: boolean; maxStarts: number }): Promise<{ activeIssues: number; effectsStarted: number; historyRows?: number }>;
  };
}

export function createWatchCycleWithCachedProduction(input: {
  config: RuntimeConfig;
  autoRelease: boolean;
  maxStarts: number;
  intakeEnabled: boolean;
  progress?: ProductionProgressReporter;
  createProduction?: (input: {
    config: RuntimeConfig;
    usage: "watch";
    progress?: ProductionProgressReporter;
  }) => Promise<WatchCycleProduction>;
}): () => Promise<{ activeIssues: number; effectsStarted: number; historyRows?: number }> {
  const createProduction = input.createProduction ?? createProductionOrchestratorFromDefaultFactory;
  let cachedProduction: Promise<WatchCycleProduction> | undefined;
  const productionForCycle = (): Promise<WatchCycleProduction> => {
    if (!cachedProduction) {
      cachedProduction = createProduction({
        config: input.config,
        usage: "watch",
        ...(input.progress ? { progress: input.progress } : {}),
      }).catch((error) => {
        cachedProduction = undefined;
        throw error;
      });
    }
    return cachedProduction;
  };

  return async () => {
    const production = await productionForCycle();
    return await runWatchCycleWithProductionIntake({
      listReadyIssues: async () => await production.dependencies.issueIntake.listReadyIssues(),
      orchestrator: production.orchestrator,
      autoRelease: input.autoRelease,
      maxStarts: input.maxStarts,
      intakeEnabled: input.intakeEnabled,
    });
  };
}

export async function runWatchCommand(args: string[], io: { log(line: string): void } = { log: console.log }): Promise<number> {
  const options = parseWatchOptions(args);
  const config = loadConfig(options.configPath);
  const runtimeDir = resolve(config.project.root, ".northstar/runtime");
  await mkdir(runtimeDir, { recursive: true });
  const lockPath = join(runtimeDir, "watch.lock");
  let stopping = false;
  const onSigterm = () => {
    stopping = true;
  };
  process.once("SIGTERM", onSigterm);
  try {
    const runCycleWithProduction = createWatchCycleWithCachedProduction({
      config,
      autoRelease: config.runtime.autoRelease,
      maxStarts: config.runtime.developmentCapacity,
      intakeEnabled: config.github.intake.enabled,
      progress: async (event) => {
        io.log(compactWatchLogLine(event));
      },
    });
    const runner = createWatchOrchestratorRunner({
      runCycle: async () => await runCycleWithProduction(),
    });
    const loop = createWatchLoop({
      intervalMs: options.intervalMs,
      maxCycles: options.maxCycles,
      acquireWriter: async () => {
        const result = await acquireFileWatchWriter({
          path: lockPath,
          projectRoot: config.project.root,
          configPath: resolve(options.configPath),
          staleAfterSeconds: config.runtime.watchLockStaleSeconds,
        });
        return result.lease;
      },
      runCycle: async () => {
        const result = await runner();
        io.log(compactWatchLogLine({
          event: "watch_cycle",
          active_issues: result.activeIssues,
          history_rows: result.historyRows,
          effects_started: result.effectsStarted,
        }));
        return { activeIssues: result.activeIssues, effectsStarted: result.effectsStarted };
      },
      sleep: async (ms) => await new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      shouldStop: () => stopping,
    });
    const result = await loop.run();
    if (result.skipped_reason === "writer_lock_unavailable") {
      io.log(compactWatchLogLine({ event: "watch_skipped", reason: "writer_lock_unavailable" }));
      return 2;
    }
    io.log(compactWatchLogLine({ event: "watch_stopped", cycles: result.cycles }));
    return 0;
  } finally {
    process.off("SIGTERM", onSigterm);
  }
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

function numberOption(args: string[], option: string): number | undefined {
  const value = optionValue(args, option);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

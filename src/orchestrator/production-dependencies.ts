import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { GitHubIssueIntakeAdapter } from "../adapters/github/issues.ts";
import { GitHubObservabilityAdapter } from "../adapters/github/observability.ts";
import { GitHubSoftwareDevGateway } from "../adapters/github/software-dev-gateway.ts";

import { CodexSdkSoftwareDevWorker } from "../adapters/host/codex-worker.ts";
import { OpenCodeSdkSoftwareDevWorker } from "../adapters/host/opencode-worker.ts";
import { PiSdkSoftwareDevWorker } from "../adapters/host/pi-worker.ts";
import { HostWorkerFactory } from "../adapters/host/worker-factory.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import type { CommandRunner } from "../runtime/credential-provider.ts";
import { resolveGitHubToken } from "../runtime/credential-provider.ts";
import {
  QueuedHostSessionBridge,
  SoftwareDevDomainDriver,
  type SoftwareDevMetrics,
  type SoftwareDevReleaseInput,
  type SoftwareDevVerificationInput,
  type SoftwareDevWorker,
  type SoftwareDevWorkerInput,
  type SoftwareDevWorkerResult,
} from "./software-dev-driver.ts";
import { createDefaultDomainDriverRegistry, type DomainDriverRegistry } from "./domain-registry.ts";

export interface ProductionDependencyMetrics {
  production_cli_real_dependency_factory: number;
  production_watch_real_dependency_factory: number;
  production_default_unconfigured_dependencies: number;
}

export async function createProductionDependencies(input: {
  config: RuntimeConfig;
  usage: "cli" | "watch";
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  runCommand?: CommandRunner;
  sdkWorkers?: {
    codex?: () => SoftwareDevWorker;
    opencode?: () => SoftwareDevWorker;
    pi?: () => SoftwareDevWorker;
  };
}): Promise<{
  host: QueuedHostSessionBridge;
  registry: DomainDriverRegistry;
  issueIntake: GitHubIssueIntakeAdapter;
  githubGateway: GitHubSoftwareDevGateway;
  observability: GitHubObservabilityAdapter;
  cleanup: {
    archiveManagedWorktree(input: { worktreePath: string; archivePath: string }): Promise<unknown>;
    deleteManagedWorktree(input: { worktreePath: string }): Promise<unknown>;
  };
  metrics: ProductionDependencyMetrics;
  softwareMetrics: SoftwareDevMetrics;
}> {
  const runCommand = input.runCommand ?? execFileCommandRunner;
  const credentials = input.config.credentials ?? {
    github: { tokenEnv: "GITHUB_TOKEN", allowGhTokenFallback: false },
    hostSdk: {
      codex: { mode: "sdk_default" as const },
      opencode: { mode: "sdk_default" as const },
      pi: { mode: "sdk_default" as const },
    },
  };
  const token = await resolveGitHubToken({
    tokenEnv: credentials.github.tokenEnv,
    allowGhTokenFallback: credentials.github.allowGhTokenFallback,
    env: input.env ?? runtimeEnv(),
    runCommand,
  });

  const fetchImpl = input.fetch ?? fetch;
  const issueIntake = new GitHubIssueIntakeAdapter({
    repo: input.config.github.repo,
    token: token.token,
    readyLabel: input.config.github.intake.label,
    fetch: fetchImpl,
  });
  const githubGateway = new GitHubSoftwareDevGateway({
    repo: input.config.github.repo,
    token: token.token,
    fetch: fetchImpl,
  });
  const observability = new GitHubObservabilityAdapter({
    repo: input.config.github.repo,
    token: token.token,
    fetch: fetchImpl,
  });
  const cleanup = {
    async archiveManagedWorktree(_input: { worktreePath: string; archivePath: string }): Promise<void> {
      return;
    },
    async deleteManagedWorktree(_input: { worktreePath: string }): Promise<void> {
      return;
    },
  };
  const host = new QueuedHostSessionBridge({ runId: "northstar-production" });
  const sdkWorkerTimeoutMs = input.config.runtime.childTimeoutSeconds * 1000;
  const workerFactory = new HostWorkerFactory({
    defaultHost: input.config.runtime.hostAdapter,
    roleOverrides: input.config.workflowOverrides?.roles ?? {},
    codexWorker: input.sdkWorkers?.codex ?? (() => new CodexSdkSoftwareDevWorker({
      workingDirectory: input.config.project.root,
      implementationTimeoutMs: sdkWorkerTimeoutMs,
      verificationTimeoutMs: sdkWorkerTimeoutMs,
    })),
    opencodeWorker: input.sdkWorkers?.opencode ?? (() => new OpenCodeSdkSoftwareDevWorker({
      workingDirectory: input.config.project.root,
      implementationTimeoutMs: sdkWorkerTimeoutMs,
      verificationTimeoutMs: sdkWorkerTimeoutMs,
    })),
    piWorker: input.sdkWorkers?.pi ?? (() => new PiSdkSoftwareDevWorker({
      workingDirectory: input.config.project.root,
      implementationTimeoutMs: sdkWorkerTimeoutMs,
      verificationTimeoutMs: sdkWorkerTimeoutMs,
    })),
  });
  const softwareMetrics = emptySoftwareMetrics();
  const worker = new RoleDelegatingSoftwareDevWorker(workerFactory);
  const registry = createDefaultDomainDriverRegistry({
    softwareDevelopmentFactory: () => new SoftwareDevDomainDriver({
      repo: input.config.github.repo,
      kind: input.config.runtime.hostAdapter,
      runId: "northstar-production",
      github: githubGateway,
      worker,
      host,
      metrics: softwareMetrics,
      baseBranch: input.config.git.baseBranch,
      workspaceHints: {
        projectRoot: input.config.project.root,
        syncWorktreeDir: input.config.git.syncWorktreeDir,
      },
    }),
  });

  return {
    host,
    registry,
    issueIntake,
    githubGateway,
    observability,
    cleanup,
    softwareMetrics,
    metrics: {
      production_cli_real_dependency_factory: input.usage === "cli" ? 1 : 0,
      production_watch_real_dependency_factory: input.usage === "watch" ? 1 : 0,
      production_default_unconfigured_dependencies: 0,
    },
  };
}

export function resolveProductionStorePath(input: { projectRoot: string; dbPath: string }): string {
  return resolve(input.projectRoot, input.dbPath);
}

class RoleDelegatingSoftwareDevWorker implements SoftwareDevWorker {
  private readonly factory: HostWorkerFactory;

  constructor(factory: HostWorkerFactory) {
    this.factory = factory;
  }

  async runImplementation(input: SoftwareDevWorkerInput): Promise<SoftwareDevWorkerResult> {
    return await this.factory.workerForRole("implementation_agent").runImplementation(input);
  }

  async runVerification(input: SoftwareDevVerificationInput): Promise<SoftwareDevWorkerResult> {
    return await this.factory.workerForRole("verifier_agent").runVerification(input);
  }

  async runRelease(input: SoftwareDevReleaseInput): Promise<SoftwareDevWorkerResult> {
    return await this.factory.workerForRole("release_agent").runRelease(input);
  }
}

function emptySoftwareMetrics(): SoftwareDevMetrics {
  return {
    software_dev_branch_reuse_cases: 0,
    software_dev_retryable_effect_failures: 0,
    software_dev_malformed_artifacts_rejected: 0,
    software_dev_completed_reversals: 0,
    software_dev_driver_live_completed: 0,
    software_dev_driver_secret_leaks: 0,
    software_dev_driver_shell_fallbacks: 0,
    merge_conflicts_detected: 0,
    merge_conflict_recovery_attempts: 0,
    merge_conflict_recovered_prs_merged: 0,
    merge_conflict_terminal_failures: 0,
    resume_duplicate_prs_created: 0,
  };
}

function execFileCommandRunner(command: { command: string; args: string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile(command.command, command.args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const exitCode = typeof (error as { code?: unknown } | null)?.code === "number"
        ? (error as { code: number }).code
        : error ? 1 : 0;
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

function runtimeEnv(): Record<string, string | undefined> {
  const processLike = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };
  return processLike.process?.env ?? {};
}

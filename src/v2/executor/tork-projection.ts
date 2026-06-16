import { createHash } from "node:crypto";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type TorkProjectionOptions = {
  callbackUrl: string;
  heartbeatUrl?: string;
  envelopeBasePath: string;
  runId: string;
};

export type TorkJobProjection = {
  executor: "tork";
  fingerprint: string;
  job: {
    name: string;
    tasks: TorkTaskProjection[];
  };
};

export type TorkTaskProjection = {
  id: string;
  name: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  mounts: Array<{ source: string; target: string; readonly: boolean }>;
  timeoutSeconds: number;
  retry: { maxAttempts: number };
  dependsOn: string[];
  webhook: string;
};

export function buildTorkJobProjection(
  workflow: SouthstarWorkflowManifest,
  options: TorkProjectionOptions,
): TorkJobProjection {
  const job = {
    name: options.runId,
    tasks: workflow.tasks.map((task): TorkTaskProjection => {
      const envelopePath = `${options.envelopeBasePath}/${options.runId}/${task.id}/envelope.json`;
      return {
        id: task.id,
        name: task.name,
        image: task.execution.image,
        command: [...task.execution.command, "--envelope", envelopePath],
        env: {
          ...sanitizeEnv(task.execution.env),
          SOUTHSTAR_RUN_ID: options.runId,
          SOUTHSTAR_TASK_ID: task.id,
          SOUTHSTAR_ENVELOPE_PATH: envelopePath,
          SOUTHSTAR_CALLBACK_URL: options.callbackUrl,
          SOUTHSTAR_ATTEMPT_ID: "attempt-1",
          ...(options.heartbeatUrl ? {
            SOUTHSTAR_HEARTBEAT_URL: options.heartbeatUrl,
            SOUTHSTAR_HEARTBEAT_INTERVAL_MS: "10000",
          } : {}),
        },
        mounts: task.execution.mounts,
        timeoutSeconds: task.execution.timeoutSeconds,
        retry: { maxAttempts: task.execution.infraRetry.maxAttempts },
        dependsOn: task.dependsOn,
        webhook: options.callbackUrl,
      };
    }),
  };
  return {
    executor: "tork",
    fingerprint: createHash("sha256").update(JSON.stringify(job)).digest("hex"),
    job,
  };
}

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/(SECRET|TOKEN|PASSWORD|PRIVATE|KEY)/i.test(key)),
  );
}

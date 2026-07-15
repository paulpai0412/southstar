import { createHash } from "node:crypto";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";

export type TorkProjectionOptions = {
  callbackUrl: string;
  heartbeatUrl?: string;
  liveEventUrl?: string;
  envelopeBasePath: string;
  runId: string;
  attemptId?: string;
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
  const attemptId = options.attemptId ?? "attempt-1";
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
          ...workspaceIdentityEnv(),
          SOUTHSTAR_RUN_ID: options.runId,
          SOUTHSTAR_TASK_ID: task.id,
          SOUTHSTAR_ENVELOPE_PATH: envelopePath,
          SOUTHSTAR_CALLBACK_URL: options.callbackUrl,
          SOUTHSTAR_ATTEMPT_ID: attemptId,
          ...(options.heartbeatUrl ? {
            SOUTHSTAR_HEARTBEAT_URL: options.heartbeatUrl,
            SOUTHSTAR_HEARTBEAT_INTERVAL_MS: "10000",
          } : {}),
          ...(options.liveEventUrl ? { SOUTHSTAR_LIVE_EVENT_URL: options.liveEventUrl } : {}),
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

function workspaceIdentityEnv(): Record<string, string> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return {};
  return {
    SOUTHSTAR_WORKSPACE_UID: String(uid),
    SOUTHSTAR_WORKSPACE_GID: String(gid),
    SOUTHSTAR_WORKSPACE_PATH: "/workspace/repo",
  };
}

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/(SECRET|TOKEN|PASSWORD|PRIVATE|KEY)/i.test(key)),
  );
}

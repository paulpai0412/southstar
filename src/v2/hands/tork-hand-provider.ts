import { randomUUID } from "node:crypto";
import type { ExecutorProvider } from "../executor/provider.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import type { HandBinding, HandCall, HandProvider, HandResult, HandSnapshotRef, ProvisionHandInput } from "./types.ts";

export function createTorkHandProvider(input: {
  executorProvider: ExecutorProvider;
  callbackUrl: string;
  heartbeatUrl?: string;
}): HandProvider {
  return {
    providerId: "tork",
    async provision(provisionInput: ProvisionHandInput): Promise<HandBinding> {
      return {
        id: `hand-${randomUUID()}`,
        providerId: "tork",
        runId: provisionInput.runId,
        taskId: provisionInput.taskId,
        handName: provisionInput.handName,
        status: "provisioned",
        createdAt: new Date().toISOString(),
        payload: { resources: provisionInput.resources },
      };
    },
    async execute(binding: HandBinding, call: HandCall): Promise<HandResult> {
      const workflow = call.input.workflow as SouthstarWorkflowManifest | undefined;
      if (!workflow) return { ok: false, output: "missing workflow input for Tork hand execution", metadata: { callName: call.name } };
      const submitted = await input.executorProvider.submit({
        runId: binding.runId,
        workflow,
        callbackUrl: input.callbackUrl,
        heartbeatUrl: input.heartbeatUrl,
        envelopeBasePath: typeof call.input.envelopeBasePath === "string" ? call.input.envelopeBasePath : "/southstar-runs",
        attemptId: typeof call.input.attemptId === "string" ? call.input.attemptId : "attempt-1",
      });
      binding.status = "running";
      return {
        ok: true,
        output: submitted.externalJobId,
        metadata: {
          executorType: submitted.executorType,
          projectionFingerprint: submitted.projectionFingerprint,
        },
      };
    },
    async snapshot(binding: HandBinding): Promise<HandSnapshotRef> {
      return {
        id: `hand-snapshot-${randomUUID()}`,
        handBindingId: binding.id,
        createdAt: new Date().toISOString(),
        metadata: { providerId: "tork", note: "Tork snapshots are logical binding snapshots in this adapter." },
      };
    },
    async destroy(binding: HandBinding): Promise<void> {
      binding.status = "destroyed";
    },
    capabilities() {
      return {
        supportsSnapshot: true,
        supportsDestroy: true,
        supportsReprovision: true,
        keepsCredentialsOutOfSandbox: true,
      };
    },
  };
}

import { randomUUID } from "node:crypto";
import type { ExecutorProvider } from "../executor/provider.ts";
import type { SouthstarWorkflowManifest } from "../manifests/types.ts";
import { validateWorkflowManifest } from "../manifests/validate.ts";
import type { ExecuteTaskInput, HandBinding, HandCall, HandProvider, HandResult, HandSnapshotRef, ProvisionHandInput } from "./types.ts";

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
        payload: {
          resourceKeys: Object.keys(provisionInput.resources).sort(),
          ...(provisionInput.recoveryKey ? { recoveryKey: provisionInput.recoveryKey } : {}),
        },
      };
    },
    async execute(binding: HandBinding, call: HandCall): Promise<HandResult> {
      const workflow = call.input.workflow as SouthstarWorkflowManifest | undefined;
      if (!workflow) {
        binding.status = "failed";
        binding.payload = { ...binding.payload, lastError: "missing workflow input for Tork hand execution" };
        return { ok: false, output: "missing workflow input for Tork hand execution", metadata: { callName: call.name } };
      }
      const validation = validateWorkflowManifest(workflow);
      if (!validation.ok) {
        binding.status = "failed";
        binding.payload = {
          ...binding.payload,
          lastError: "invalid workflow input for Tork hand execution",
          validationIssues: validation.issues,
        };
        return {
          ok: false,
          output: `invalid workflow input for Tork hand execution: ${validation.issues.map((issue) => issue.path).join(", ")}`,
          metadata: { callName: call.name, validationIssues: validation.issues },
        };
      }
      try {
        const submitted = await input.executorProvider.submit({
          runId: binding.runId,
          workflow,
          callbackUrl: input.callbackUrl,
          heartbeatUrl: input.heartbeatUrl,
          envelopeBasePath: typeof call.input.envelopeBasePath === "string" ? call.input.envelopeBasePath : "/southstar-runs",
          attemptId: typeof call.input.attemptId === "string" ? call.input.attemptId : "attempt-1",
        });
        binding.status = "running";
        binding.payload = {
          ...binding.payload,
          executorType: submitted.executorType,
          executorStatus: submitted.status,
          externalJobId: submitted.externalJobId,
          projectionFingerprint: submitted.projectionFingerprint,
          providerPayload: submitted.providerPayload,
        };
        return {
          ok: true,
          output: submitted.externalJobId,
          metadata: {
            executorType: submitted.executorType,
            projectionFingerprint: submitted.projectionFingerprint,
          },
        };
      } catch (error) {
        binding.status = "failed";
        const message = error instanceof Error ? error.message : String(error);
        binding.payload = { ...binding.payload, lastError: message };
        return { ok: false, output: `Tork hand execution failed: ${message}`, metadata: { callName: call.name, error: message } };
      }
    },
    async executeTask(binding: HandBinding, taskInput: ExecuteTaskInput): Promise<HandResult> {
      const workflow = taskInput.workflow as SouthstarWorkflowManifest | undefined;
      if (!workflow || typeof workflow !== "object") {
        binding.status = "failed";
        binding.payload = { ...binding.payload, lastError: "missing workflow input for Tork task execution" };
        return {
          ok: false,
          output: "missing workflow input for Tork task execution",
          metadata: { handExecutionId: taskInput.handExecutionId },
        };
      }

      const task = Array.isArray(workflow.tasks)
        ? workflow.tasks.find((candidate) => candidate.id === taskInput.taskId)
        : undefined;
      if (!task) {
        binding.status = "failed";
        binding.payload = { ...binding.payload, lastError: `task not found in workflow: ${taskInput.taskId}` };
        return {
          ok: false,
          output: `task not found in workflow: ${taskInput.taskId}`,
          metadata: { handExecutionId: taskInput.handExecutionId },
        };
      }

      const singleTaskWorkflow: SouthstarWorkflowManifest & { runtime: Record<string, unknown> } = {
        ...workflow,
        tasks: [{ ...task, dependsOn: [] }],
        runtime: {
          runId: taskInput.runId,
          taskId: taskInput.taskId,
          sessionId: taskInput.sessionId,
          attemptId: taskInput.attemptId,
          handExecutionId: taskInput.handExecutionId,
          brainBindingId: taskInput.brainBindingId,
          handBindingId: taskInput.handBindingId,
          contextPacketRef: taskInput.contextPacketRef,
          acceptedInputArtifactRefs: taskInput.acceptedInputArtifactRefs,
          toolProxyPolicyRef: taskInput.toolProxyPolicyRef,
          queueTimeoutSeconds: taskInput.queueTimeoutSeconds,
          heartbeatTimeoutSeconds: taskInput.heartbeatTimeoutSeconds,
          intent: taskInput.intent,
        },
      };

      const validation = validateWorkflowManifest(singleTaskWorkflow);
      if (!validation.ok) {
        binding.status = "failed";
        binding.payload = {
          ...binding.payload,
          lastError: "invalid single-task workflow input",
          validationIssues: validation.issues,
        };
        return {
          ok: false,
          output: `invalid single-task workflow input: ${validation.issues.map((issue) => issue.path).join(", ")}`,
          metadata: { handExecutionId: taskInput.handExecutionId, validationIssues: validation.issues },
        };
      }

      try {
        const submitted = await input.executorProvider.submit({
          runId: binding.runId,
          workflow: singleTaskWorkflow,
          callbackUrl: taskInput.callbackUrl ?? input.callbackUrl,
          heartbeatUrl: taskInput.heartbeatUrl ?? input.heartbeatUrl,
          envelopeBasePath: taskInput.envelopeBasePath ?? "/southstar-runs",
          attemptId: taskInput.attemptId,
        });
        binding.status = "running";
        binding.payload = {
          ...binding.payload,
          handExecutionId: taskInput.handExecutionId,
          executorType: submitted.executorType,
          executorStatus: submitted.status,
          externalJobId: submitted.externalJobId,
          projectionFingerprint: submitted.projectionFingerprint,
          providerPayload: submitted.providerPayload,
          queueTimeoutSeconds: taskInput.queueTimeoutSeconds,
          heartbeatTimeoutSeconds: taskInput.heartbeatTimeoutSeconds,
        };
        return {
          ok: true,
          output: submitted.externalJobId,
          metadata: {
            handExecutionId: taskInput.handExecutionId,
            executorType: submitted.executorType,
            externalJobId: submitted.externalJobId,
            projectionFingerprint: submitted.projectionFingerprint,
          },
        };
      } catch (error) {
        binding.status = "failed";
        const message = error instanceof Error ? error.message : String(error);
        binding.payload = { ...binding.payload, lastError: message };
        return {
          ok: false,
          output: `Tork task execution failed: ${message}`,
          metadata: { handExecutionId: taskInput.handExecutionId, error: message },
        };
      }
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
      const externalJobId = typeof binding.payload.externalJobId === "string" ? binding.payload.externalJobId : undefined;
      if (externalJobId && input.executorProvider.cancel) {
        await input.executorProvider.cancel({ externalJobId, runId: binding.runId, reason: "hand binding destroyed" });
      }
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

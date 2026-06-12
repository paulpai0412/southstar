import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";

export type MemorySnapshot = {
  items: Array<{ id: string; body: unknown }>;
  capturedAt: string;
};

export type VaultLeaseInput = {
  leaseRef: string;
  mountAs: "env" | "file";
  secretValue?: string;
};

export type McpGrantInput = {
  serverId: string;
  allowedTools: string[];
};

export type TaskEnvelopeInput = {
  runId: string;
  taskId: string;
  rootSessionId: string;
  memorySnapshot: MemorySnapshot;
  vaultLeases: VaultLeaseInput[];
  mcpGrants: McpGrantInput[];
};

export type TaskEnvelope = {
  schemaVersion: "southstar.task-envelope.v1";
  runId: string;
  workflowId: string;
  task: WorkflowTaskDefinition;
  rootSession: {
    id: string;
    validator: string;
    maxRepairAttempts: number;
  };
  subagents: WorkflowTaskDefinition["subagents"];
  memory: MemorySnapshot;
  vaultLeases: Array<Omit<VaultLeaseInput, "secretValue">>;
  mcpGrants: McpGrantInput[];
  artifactContracts: string[];
  artifactContract: {
    artifactTypes: string[];
    requiredFields: string[];
  };
};

export function buildTaskEnvelope(workflow: SouthstarWorkflowManifest, input: TaskEnvelopeInput): TaskEnvelope {
  const task = workflow.tasks.find((candidate) => candidate.id === input.taskId);
  if (!task) {
    throw new Error(`unknown task: ${input.taskId}`);
  }
  const artifactTypes = [...new Set(task.subagents.flatMap((subagent) => subagent.requiredArtifacts))];
  const evaluator = workflow.evaluators.find((candidate) => candidate.id === task.rootSession.validator)
    ?? workflow.evaluators.find((candidate) => candidate.artifactTypes.some((artifactType) => artifactTypes.includes(artifactType)));
  return {
    schemaVersion: "southstar.task-envelope.v1",
    runId: input.runId,
    workflowId: workflow.workflowId,
    task,
    rootSession: {
      id: input.rootSessionId,
      validator: task.rootSession.validator,
      maxRepairAttempts: task.rootSession.maxRepairAttempts,
    },
    subagents: task.subagents,
    memory: input.memorySnapshot,
    vaultLeases: input.vaultLeases.map((lease) => ({
      leaseRef: lease.leaseRef,
      mountAs: lease.mountAs,
    })),
    mcpGrants: input.mcpGrants,
    artifactContracts: artifactTypes,
    artifactContract: {
      artifactTypes,
      requiredFields: evaluator?.requiredFields ?? [],
    },
  };
}

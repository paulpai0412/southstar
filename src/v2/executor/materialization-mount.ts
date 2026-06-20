import type { SouthstarWorkflowManifest, WorkflowTaskDefinition } from "../manifests/types.ts";

export type MaterializationMountInput = {
  runRoot?: string;
  envelopeBasePath?: string;
};

const DEFAULT_RUN_ROOT = "/tmp/southstar-runs";
const DEFAULT_ENVELOPE_BASE_PATH = "/southstar-runs";

export function withMaterializationMount(
  workflow: SouthstarWorkflowManifest,
  input: MaterializationMountInput,
): { workflow: SouthstarWorkflowManifest; runRoot: string; envelopeBasePath: string } {
  const runRoot = input.runRoot ?? DEFAULT_RUN_ROOT;
  const envelopeBasePath = input.envelopeBasePath ?? DEFAULT_ENVELOPE_BASE_PATH;
  assertAbsolute(runRoot, "runRoot");
  assertAbsolute(envelopeBasePath, "envelopeBasePath");

  const workflowWithMount: SouthstarWorkflowManifest = {
    ...workflow,
    tasks: workflow.tasks.map((task) => ({
      ...task,
      execution: {
        ...task.execution,
        mounts: ensureMount(task, {
          source: runRoot,
          target: envelopeBasePath,
          readonly: true,
        }),
      },
    })),
  };

  return { workflow: workflowWithMount, runRoot, envelopeBasePath };
}

function ensureMount(
  task: WorkflowTaskDefinition,
  mount: { source: string; target: string; readonly: boolean },
): WorkflowTaskDefinition["execution"]["mounts"] {
  const existing = task.execution.mounts ?? [];
  if (existing.some((entry) => entry.source === mount.source && entry.target === mount.target)) return existing;
  return [...existing, mount];
}

function assertAbsolute(value: string, field: string): void {
  if (!value.startsWith("/")) throw new Error(`${field} must be an absolute path: ${value}`);
}

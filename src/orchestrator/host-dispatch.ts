import type { HostAdapter, HostChildRunResult } from "../types/host.ts";
import type { RoleDefinition, WorkflowDefinition } from "../types/workflow.ts";

export type StageRootChildRun = HostChildRunResult & {
  lease_id: string;
  role: string;
};

export interface StageRootDispatchResult {
  roleName: string;
  rootSessionId: string;
  childRun: StageRootChildRun;
}

export function dispatchStageRoot(input: {
  host: HostAdapter;
  workflow: WorkflowDefinition;
  issueId: string;
  stageName: string;
  leaseId: string;
  roleOverrides?: Record<string, Record<string, unknown>>;
}): StageRootDispatchResult {
  const stage = input.workflow.stages[input.stageName];
  if (!stage) throw new Error(`Unknown workflow stage ${input.stageName}`);

  const roleName = stage.role;
  const baseRole = input.workflow.roles[roleName];
  if (!baseRole) throw new Error(`Workflow role ${roleName} is not defined`);

  const role = mergeRole(baseRole, input.roleOverrides?.[roleName]);
  const root = input.host.startRootSession({ issue_id: input.issueId, role_name: roleName, role });
  const childRun = input.host.startBackgroundChild({
    issue_id: input.issueId,
    lease_id: input.leaseId,
    root_session_id: root.root_session_id,
    role_name: roleName,
    role,
  });

  return {
    roleName,
    rootSessionId: root.root_session_id,
    childRun: {
      ...childRun,
      lease_id: input.leaseId,
      role: roleName,
    },
  };
}

function mergeRole(baseRole: RoleDefinition, override: Record<string, unknown> | undefined): RoleDefinition {
  return {
    ...baseRole,
    ...(override ?? {}),
  } as RoleDefinition;
}

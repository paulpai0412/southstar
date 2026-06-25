import type { ReactNode } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import type { SouthstarWorkspaceViewId } from "./WorkspaceTabs";
import { WorkflowWorkbench } from "../workflow/WorkflowWorkbench";
import { OperatorBoard } from "../operator/OperatorBoard";

export interface WorkspaceViewContext {
  activeCwd: string | null;
  api: SouthstarApiClient;
  onOpenOperator: (runId?: string) => void;
}

export function renderWorkspaceView(id: SouthstarWorkspaceViewId, ctx: WorkspaceViewContext): ReactNode {
  if (id === "workflow") {
    return <WorkflowWorkbench api={ctx.api} activeCwd={ctx.activeCwd} onOpenOperator={ctx.onOpenOperator} />;
  }
  if (id === "operator") {
    return <OperatorBoard api={ctx.api} activeCwd={ctx.activeCwd} />;
  }
  return null;
}

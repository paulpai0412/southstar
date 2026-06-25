"use client";

import { useMemo } from "react";
import type { SouthstarApiClient } from "@/lib/southstar/api-client";
import { WorkflowWorkbench } from "./WorkflowWorkbench";

export function WorkflowTab(props: { api: SouthstarApiClient; onOpenOperator: (runId?: string) => void }) {
  const initialRouteState = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      initialDraftId: params.get("draftId") ?? undefined,
      initialRunId: params.get("runId") ?? undefined,
    };
  }, []);

  return (
    <WorkflowWorkbench
      api={props.api}
      activeCwd={null}
      initialDraftId={initialRouteState.initialDraftId}
      initialRunId={initialRouteState.initialRunId}
      onOpenOperator={(runId?: string) => props.onOpenOperator(runId)}
    />
  );
}

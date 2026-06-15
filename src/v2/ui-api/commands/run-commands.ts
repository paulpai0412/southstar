import { appendRuntimeEvent } from "../../signals/events.ts";
import { updateWorkflowRunStatus } from "../../stores/run-store.ts";
import { upsertRuntimeResource } from "../../stores/resource-store.ts";
import type { SouthstarDb } from "../../stores/sqlite.ts";
import type { SouthstarCommandRequest, SouthstarCommandResult } from "./types.ts";
import { rejectedCommand } from "./types.ts";

type RunPayload = { cancelActiveJobs?: boolean };
type RunCommand = SouthstarCommandRequest<RunPayload> & { runId: string };

export function pauseRunCommand(db: SouthstarDb, input: RunCommand): SouthstarCommandResult {
  return transitionRun(db, input, "paused", "run.paused", "Run paused");
}

export function resumeRunCommand(db: SouthstarDb, input: RunCommand): SouthstarCommandResult {
  return transitionRun(db, input, "running", "run.resumed", "Run resumed");
}

export function cancelRunCommand(db: SouthstarDb, input: RunCommand): SouthstarCommandResult {
  const result = transitionRun(db, input, "cancelled", "run.cancelled", "Run cancelled");
  if (result.accepted) {
    const stop = upsertRuntimeResource(db, {
      resourceType: "stop_condition_result",
      resourceKey: `stop-${input.runId}-cancelled`,
      runId: input.runId,
      scope: "run",
      status: "cancelled",
      title: "Run cancelled by operator",
      payload: { cancelActiveJobs: input.payload.cancelActiveJobs === true },
    });
    result.resourceRefs.push(stop.id);
  }
  return result;
}

function transitionRun(db: SouthstarDb, input: RunCommand, status: string, eventType: string, title: string): SouthstarCommandResult {
  if (!updateWorkflowRunStatus(db, input.runId, status)) return rejectedCommand(input.commandId, "Select an existing run before changing run state.");
  const event = appendRuntimeEvent(db, {
    runId: input.runId,
    eventType,
    actorType: input.actor.type,
    payload: { commandId: input.commandId, reason: input.reason ?? "" },
  });
  return {
    commandId: input.commandId,
    accepted: true,
    status: "applied",
    affectedRunId: input.runId,
    resourceRefs: [],
    eventRefs: [String(event.sequence)],
    nextSuggestedActions: [`${title}. Refresh Runtime Monitor.`],
  };
}

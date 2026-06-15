export type SouthstarCommandRequest<TPayload extends Record<string, unknown> = Record<string, unknown>> = {
  commandId: string;
  actor: { type: "user" | "system" | "root-session"; id?: string };
  reason?: string;
  dryRun?: boolean;
  payload: TPayload;
};

export type SouthstarCommandResult = {
  commandId: string;
  accepted: boolean;
  status: "applied" | "queued" | "rejected";
  affectedRunId?: string;
  affectedTaskId?: string;
  resourceRefs: string[];
  eventRefs: string[];
  nextSuggestedActions: string[];
};

export function rejectedCommand(commandId: string, message: string): SouthstarCommandResult {
  return {
    commandId,
    accepted: false,
    status: "rejected",
    resourceRefs: [],
    eventRefs: [],
    nextSuggestedActions: [message],
  };
}

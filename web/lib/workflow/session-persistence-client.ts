import type { AgentMessage } from "../types";
import { APPEND_WORKFLOW_UI_MESSAGE_COMMAND } from "./session-message";

export async function persistWorkflowUiMessage(sessionId: string, message: AgentMessage): Promise<string> {
  const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: APPEND_WORKFLOW_UI_MESSAGE_COMMAND,
      message,
    }),
  });
  const result = await response.json().catch(() => null) as { data?: { entryId?: unknown }; error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof result?.error === "string" ? result.error : `Workflow session persistence failed: HTTP ${response.status}`);
  }
  const entryId = result?.data?.entryId;
  if (typeof entryId !== "string" || !entryId) {
    throw new Error("Workflow session persistence did not return an entry id.");
  }
  return entryId;
}

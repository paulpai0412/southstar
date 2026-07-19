import type { AgentMessage, CustomMessage } from "../types";

export const SOUTHSTAR_WORKFLOW_UI_MESSAGE_CUSTOM_TYPE = "southstar.workflow-ui-message";
export const SOUTHSTAR_WORKFLOW_UI_MESSAGE_SCHEMA_VERSION = "southstar.workflow_ui_message.v1";
export const APPEND_WORKFLOW_UI_MESSAGE_COMMAND = "append_workflow_ui_message";
export const SOUTHSTAR_WORKFLOW_UI_CHECKPOINT_TEXT = "[southstar.workflow-ui-session]";

export interface PersistedWorkflowUiMessage {
  schemaVersion: typeof SOUTHSTAR_WORKFLOW_UI_MESSAGE_SCHEMA_VERSION;
  message: AgentMessage;
}

export function createPersistedWorkflowUiMessage(message: unknown): PersistedWorkflowUiMessage {
  if (!isPersistableWorkflowUiMessage(message)) {
    throw new Error("Workflow UI messages must be user or assistant messages with serializable content.");
  }
  return {
    schemaVersion: SOUTHSTAR_WORKFLOW_UI_MESSAGE_SCHEMA_VERSION,
    message,
  };
}

export function persistedWorkflowUiMessageFromUnknown(value: unknown): PersistedWorkflowUiMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { schemaVersion?: unknown; message?: unknown };
  if (candidate.schemaVersion !== SOUTHSTAR_WORKFLOW_UI_MESSAGE_SCHEMA_VERSION) return null;
  if (!isPersistableWorkflowUiMessage(candidate.message)) return null;
  return candidate as PersistedWorkflowUiMessage;
}

export function restorePersistedWorkflowUiMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "custom") return message;
  const custom = message as CustomMessage;
  if (custom.customType !== SOUTHSTAR_WORKFLOW_UI_MESSAGE_CUSTOM_TYPE) return message;
  const persisted = persistedWorkflowUiMessageFromUnknown(custom.details);
  if (!persisted) return message;
  return {
    ...persisted.message,
    timestamp: persisted.message.timestamp ?? custom.timestamp,
  } as AgentMessage;
}

export function summarizeWorkflowUiMessage(message: AgentMessage): string {
  const text = firstText(message);
  if (text) return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  if (!Array.isArray(message.content)) return `Southstar workflow ${message.role} message`;
  const blockTypes = message.content
    .map((block) => block.type)
    .filter((type, index, all) => all.indexOf(type) === index);
  return blockTypes.length > 0
    ? `Southstar workflow ${message.role}: ${blockTypes.join(", ")}`
    : `Southstar workflow ${message.role} message`;
}

export function isWorkflowUiCheckpointMessage(message: AgentMessage): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.length !== 1) return false;
  const block = message.content[0];
  return block?.type === "text" && block.text === SOUTHSTAR_WORKFLOW_UI_CHECKPOINT_TEXT;
}

export function filterLatestWorkflowUiProjections(messages: AgentMessage[], entryIds: string[]): { messages: AgentMessage[]; entryIds: string[] } {
  const latestByKey = new Map<string, number>();
  for (let index = 0; index < messages.length; index += 1) {
    const key = workflowUiProjectionKey(messages[index]);
    if (key) latestByKey.set(key, index);
  }

  const displayMessages: AgentMessage[] = [];
  const displayEntryIds: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const key = workflowUiProjectionKey(messages[index]);
    if (key && latestByKey.get(key) !== index) continue;
    displayMessages.push(messages[index]);
    displayEntryIds.push(entryIds[index] ?? "");
  }
  return { messages: displayMessages, entryIds: displayEntryIds };
}

function workflowUiProjectionKey(message: AgentMessage | undefined): string | null {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
  const block = message.content.find((item) => item.type === "goalRequirements");
  return block?.type === "goalRequirements" && typeof block.draftId === "string"
    ? `goalRequirements:${block.draftId}`
    : null;
}

function isPersistableWorkflowUiMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { role?: unknown; content?: unknown };
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (typeof message.content === "string") return true;
  return Array.isArray(message.content)
    && message.content.every((block) => Boolean(block) && typeof block === "object" && typeof (block as { type?: unknown }).type === "string");
}

function firstText(message: AgentMessage): string | null {
  if (typeof message.content === "string") return message.content.trim() || null;
  if (!Array.isArray(message.content)) return null;
  for (const block of message.content) {
    if (block.type === "text" && "text" in block && typeof block.text === "string" && block.text.trim()) {
      return block.text.trim();
    }
  }
  return null;
}

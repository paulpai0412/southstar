import type { AgentMessage, SessionEntry } from "./types";

export const UI_TEXT_MAX_CHARS = 6_000;
export const UI_TREE_TEXT_MAX_CHARS = 240;

export function slimSessionTreeForUi<T extends { entry: SessionEntry; children: T[] }>(nodes: T[]): T[] {
  return nodes.map((node) => ({
    ...node,
    entry: slimSessionEntryForUi(node.entry, UI_TREE_TEXT_MAX_CHARS),
    children: slimSessionTreeForUi(node.children),
  }));
}

export function slimMessageForUi<T extends AgentMessage>(message: T, maxChars = UI_TEXT_MAX_CHARS): T {
  return {
    ...message,
    content: slimContentForUi(message.content, maxChars),
  } as T;
}

function slimSessionEntryForUi(entry: SessionEntry, maxChars: number): SessionEntry {
  if (entry.type === "message") {
    return { ...entry, message: slimMessageForUi(entry.message, maxChars) };
  }
  if (entry.type === "custom_message") {
    return { ...entry, content: slimContentForUi(entry.content, maxChars) };
  }
  if (entry.type === "branch_summary") {
    return { ...entry, summary: truncateUiText(entry.summary, maxChars), details: undefined };
  }
  return entry;
}

function slimContentForUi<T>(content: T, maxChars: number): T {
  if (typeof content === "string") return truncateUiText(content, maxChars) as T;
  if (!Array.isArray(content)) return content;
  return content.map((block) => slimContentBlockForUi(block, maxChars)) as T;
}

function slimContentBlockForUi<T>(block: T, maxChars: number): T {
  if (!block || typeof block !== "object") return block;
  const record = block as Record<string, unknown>;
  if (record.type === "workflowDag") return block;

  const next = { ...record };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase().endsWith("signature")) delete next[key];
  }
  if (typeof next.text === "string") next.text = truncateUiText(next.text, maxChars);
  if (typeof next.thinking === "string") next.thinking = truncateUiText(next.thinking, maxChars);
  return next as T;
}

function truncateUiText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...truncated ${text.length - maxChars} chars for UI performance]`;
}

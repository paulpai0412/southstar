import type { SessionEntry, UserMessage } from "./types";

export const SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE = "southstar.session.kind";
export type SessionKind = "chat" | "workflow";
type UserContentBlock = Exclude<UserMessage["content"], string>[number];

const SOUTHSTAR_WORKFLOW_COMPOSER_PROMPT_PREFIX = "You are Southstar's library-constrained workflow";

export function filterSessionsByKind<T extends { kind?: SessionKind }>(sessions: T[], kind: SessionKind | null): T[] {
  if (!kind) return sessions;
  return sessions.filter((session) => (session.kind ?? "chat") === kind);
}

export function classifySessionKindFromEntries(entries: SessionEntry[]): SessionKind {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE) continue;
    const kind = sessionKindFromUnknown(entry.data);
    if (kind) return kind;
  }

  if (entries.some(isWorkflowComposerPromptEntry)) return "workflow";

  return "chat";
}

function sessionKindFromUnknown(value: unknown): SessionKind | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "chat" || kind === "workflow" ? kind : null;
}

function isWorkflowComposerPromptEntry(entry: SessionEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  if (message.role !== "user") return false;
  return textFromUserContent(message.content).startsWith(SOUTHSTAR_WORKFLOW_COMPOSER_PROMPT_PREFIX);
}

function textFromUserContent(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("\n");
}

function isTextContentBlock(block: UserContentBlock): block is UserContentBlock & { type: "text"; text: string } {
  return block.type === "text" && "text" in block && typeof block.text === "string";
}

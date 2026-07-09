import type { SessionEntry } from "./types";

export const SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE = "southstar.session.kind";
export type SessionKind = "chat" | "workflow" | "library";

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

  return "chat";
}

function sessionKindFromUnknown(value: unknown): SessionKind | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "chat" || kind === "workflow" || kind === "library" ? kind : null;
}

import type { SessionEntry } from "./types";

export const SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE = "southstar.session.kind";
export type SessionKind = "chat" | "workflow" | "library";
export type SessionVisibility = "user" | "internal";
export type SessionMetadata = { kind: SessionKind; visibility?: SessionVisibility };

export function filterSessionsByKind<T extends { kind?: SessionKind }>(sessions: T[], kind: SessionKind | null): T[] {
  if (!kind) return sessions;
  return sessions.filter((session) => (session.kind ?? "chat") === kind);
}

export function classifySessionKindFromEntries(entries: SessionEntry[]): SessionKind {
  return sessionMetadataFromEntries(entries)?.kind ?? "chat";
}

export function sessionMetadataFromEntries(entries: SessionEntry[]): SessionMetadata | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== SOUTHSTAR_SESSION_KIND_CUSTOM_TYPE) continue;
    const metadata = sessionMetadataFromUnknown(entry.data);
    if (metadata) return metadata;
  }

  return null;
}

function sessionMetadataFromUnknown(value: unknown): SessionMetadata | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "chat" && kind !== "workflow" && kind !== "library") return null;
  const visibility = (value as { visibility?: unknown }).visibility;
  return {
    kind,
    ...(visibility === "user" || visibility === "internal" ? { visibility } : {}),
  };
}

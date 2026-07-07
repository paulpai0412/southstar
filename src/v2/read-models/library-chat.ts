import type { SouthstarDb } from "../db/postgres.ts";

export type LibraryChatBlock =
  | { type: "text"; text: string }
  | { type: "proposal"; title: string; objectKeys: string[]; filePaths: string[] }
  | { type: "graph"; title: string; scope: string; objectKeys: string[] }
  | { type: "validation"; ok: boolean; issues: Array<{ path: string; message: string }> };

export type LibraryChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  blocks: LibraryChatBlock[];
};

export type LibraryChatAction = {
  actionId: string;
  sessionId: string;
  prompt: string;
  scope: string;
};

export type LibraryChatSessionSummary = {
  id: string;
  title: string;
  status: string;
  modified?: string;
  detail?: string;
  itemCount?: number;
};

type LibraryChatActionRow = {
  resource_key: string;
  session_id: string | null;
  status: string;
  title: string | null;
  payload_json: unknown;
  summary_json: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

export async function listLibraryChatSessionSummariesPg(
  db: SouthstarDb,
  input: { limit?: number } = {},
): Promise<LibraryChatSessionSummary[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const rows = await db.query<LibraryChatActionRow>(
    `select resource_key, session_id, status, title, payload_json, summary_json, created_at, updated_at
       from southstar.runtime_resources
      where resource_type = 'library_chat_action'
      order by updated_at desc, created_at desc, resource_key
      limit $1`,
    [limit * 3],
  );

  const sessions = new Map<string, LibraryChatSessionSummary>();
  for (const row of rows.rows) {
    const id = row.session_id ?? row.resource_key;
    if (sessions.has(id)) continue;
    const payload = asRecord(row.payload_json);
    const summary = asRecord(row.summary_json);
    const result = asRecord(asRecord(payload.result));
    const prompt = optionalString(payload.prompt) ?? optionalString(summary.prompt);
    const status = optionalString(summary.status) ?? row.status;
    const candidateCount = numberValue(result.candidateCount);
    const selectedScope = optionalString(payload.selectedScope) ?? optionalString(summary.selectedScope);
    sessions.set(id, {
      id,
      title: titleFromPrompt(prompt) ?? row.title ?? id,
      status,
      modified: toIsoString(row.updated_at ?? row.created_at),
      detail: candidateCount !== undefined ? `${candidateCount} ${candidateCount === 1 ? "item" : "items"}` : selectedScope,
      ...(candidateCount !== undefined ? { itemCount: candidateCount } : {}),
    });
    if (sessions.size >= limit) break;
  }

  return [...sessions.values()];
}

function titleFromPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length > 64 ? `${singleLine.slice(0, 61)}...` : singleLine;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
